import { JsonRpcRequestError } from './rpc/jsonRpcClient'
import type { JsonRpcClient } from './rpc/jsonRpcClient'
import type { AgentCursor, AgentEvent } from '@cherrystudio/remote-protocol/agent'

/**
 * Per-session event subscriptions over one connected device.
 *
 * Responsibilities (spec §3.5):
 *   - lazily `agent.sessions.subscribe` a session on first use, with the last
 *     known cursor so the peer can replay;
 *   - buffer `agent.events` notifications per session and wake waiters
 *     (Tasks 8/9 hang their `cherry_send(wait)` / `cherry_wait` resolvers here);
 *   - advance the peer's view with `agent.subscriptions.ack`;
 *   - keep the number of live subscriptions inside BOTH the peer-negotiated cap
 *     and the local per-session byte budget, evicting LRU / dropping oldest;
 *   - drive the checkpoint recovery chain when the peer cannot replay.
 *
 * The layer never reads the channel itself: `JsonRpcClient` owns the single
 * read loop, and the assembly (Task 10) routes `rpc.onNotification` into
 * {@link SessionSubscriptions.handleNotification}.
 */

/** The default peer subscription cap when the caller does not supply one. */
const DEFAULT_SUBSCRIPTIONS_LIMIT = 8
/** The default local per-session cache budget: 2 MiB of event text (spec §3.5). */
const DEFAULT_PER_SESSION_CACHE_BYTES = 2 * 1024 * 1024
/** The peer's prepared-lease window, used to bound recovery-chain retries. */
const DEFAULT_CHECKPOINT_MS = 300_000
/**
 * LOCAL POLICY CONSTANT (the protocol specifies no such bound; accepted by the
 * controller as a defensive limit). How many full recovery chains one `ensure`
 * may run. Each retry is a FRESH subscribe + pagination + activate (a stale
 * lease or stale pages are never reused), so this only bounds pathological peer
 * churn — a peer that expires every lease surfaces its last error rather than
 * looping forever. Not injectable: it is a safety bound, not a tuning knob.
 */
const MAX_RECOVERY_ATTEMPTS = 4

export type ReadResult = { events: AgentEvent[]; nextCursor: AgentCursor } | { error: 'cursor-out-of-window' }

export interface SessionSubscriptionsOptions {
  /**
   * The peer-negotiated cap from `connection.hello`'s `limits.subscriptions`.
   * The local LRU cap is CLAMPED to this value: local eviction must happen
   * before the peer can answer `RESOURCE_EXHAUSTED`.
   */
  subscriptionsLimit?: number
  /**
   * LOCAL policy (not protocol-negotiated): the per-session event-cache byte
   * budget. Over budget, the OLDEST cached events are dropped and the drop is
   * logged. Injected by the assembly (default 2 MiB).
   */
  perSessionCacheBytes?: number
  /**
   * The peer's prepared-checkpoint lease window in ms (protocol `checkpointMs`,
   * default 300_000). Only bounds recovery retries; the peer is authoritative.
   */
  checkpointMs?: number
}

/** Peer-side subscription phases (mirrors the real peer's internal state). */
type SubscribeDescriptor =
  | {
      mode: 'replay'
      subscriptionId: string
      fromCursor: AgentCursor
      highWatermark: AgentCursor
      leaseExpiresAt: string
    }
  | {
      mode: 'checkpoint'
      subscriptionId: string
      reason: string
      checkpoint: {
        checkpointId: string
        cursor: AgentCursor
        historyRevision: string
        pageCount: number
        byteLength: string
        sha256: string
        expiresAt: string
      }
    }

/** One buffered event plus its stream cursor and cached byte cost. */
interface CachedEvent {
  cursor: AgentCursor
  event: AgentEvent
  bytes: number
}

/**
 * A resolver waiting for the session buffer to reach a cursor. Tasks 8/9 park
 * their semantic waiters here; this layer only owns the wake (coalesced).
 */
interface Waiter {
  resolve: () => void
  reject: (error: Error) => void
}

interface SessionState {
  subscriptionId: string
  /** The newest cursor this layer knows is durable for the session. */
  cursor: AgentCursor
  buffer: CachedEvent[]
  bytes: number
  /**
   * The oldest stream position this session can still serve: the baseline the
   * subscription started from, advanced whenever old events are dropped.
   */
  windowStart: number
  /** Cursors a caller has already consumed; the oldest retained is the window start. */
  waiters: Waiter[]
  /** True while a live peer subscription backs this entry. */
  live: boolean
  /**
   * Projection state rebuilt from a checkpoint, if this session was recovered
   * that way. STATE, never stream events — it carries no stream cursor.
   */
  projection: Array<{ kind: string; value: unknown }>
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** The peer's failure discriminator, or undefined for a non-protocol error. */
function failureReason(error: unknown): string | undefined {
  if (!(error instanceof JsonRpcRequestError)) return undefined
  const data = error.data as { reason?: unknown } | undefined
  return data !== null && typeof data === 'object' && typeof data.reason === 'string' ? data.reason : undefined
}

/** UTF-8 byte length of one buffered event, as JSON (what the peer actually sends). */
function eventBytes(event: AgentEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), 'utf8')
  } catch {
    // A non-serialisable payload cannot be measured; charge a floor so the
    // budget still moves and the oldest-drop policy stays live.
    return 64
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validates the three cursor fields the protocol declares (all strings). */
function readCursor(value: unknown): AgentCursor | undefined {
  if (!isRecord(value)) return undefined
  const { sessionId, streamEpoch, seq } = value
  if (typeof sessionId !== 'string' || typeof streamEpoch !== 'string' || typeof seq !== 'string') return undefined
  return { sessionId, streamEpoch, seq }
}

export class SessionSubscriptions {
  readonly #rpc: JsonRpcClient
  /** Clamped to the peer-negotiated cap (see the class doc). */
  readonly #limit: number
  readonly #perSessionCacheBytes: number
  readonly #checkpointMs: number
  readonly #sessions = new Map<string, SessionState>()
  /** Insertion order == LRU order (Map preserves it; re-insert to touch). */
  #closed = false

  constructor(rpc: JsonRpcClient, opts: SessionSubscriptionsOptions = {}) {
    this.#rpc = rpc
    this.#limit = Math.max(1, Math.floor(positive(opts.subscriptionsLimit, DEFAULT_SUBSCRIPTIONS_LIMIT)))
    this.#perSessionCacheBytes = positive(opts.perSessionCacheBytes, DEFAULT_PER_SESSION_CACHE_BYTES)
    this.#checkpointMs = positive(opts.checkpointMs, DEFAULT_CHECKPOINT_MS)
  }

  /**
   * Session ids with a live subscription, LRU-first. Task 10's reconnect
   * re-ensure iterates exactly this list.
   */
  activeSessions(): string[] {
    const active: string[] = []
    for (const [sessionId, state] of this.#sessions) {
      if (state.live) active.push(sessionId)
    }
    return active
  }

  /**
   * Guarantees a live subscription for `sessionId`, reusing the last cursor
   * when the caller does not supply one so the peer can replay the gap.
   *
   * A same-session re-ensure is a SINGLE path: close the old peer subscription
   * FIRST (the peer flips it to `phase: 'reset'`, which is what makes the
   * re-subscribe legal rather than CONFLICT), then subscribe exactly once.
   */
  async ensure(sessionId: string, cursor?: AgentCursor): Promise<void> {
    if (this.#closed) throw new Error('SessionSubscriptions disposed')

    // Re-subscribe path: release the old subscription before asking again.
    const existing = this.#sessions.get(sessionId)
    if (existing !== undefined && existing.live) {
      await this.#closeSubscription(existing.subscriptionId)
      existing.live = false
      this.#sessions.delete(sessionId)
    }

    const resumeFrom = cursor ?? this.#sessions.get(sessionId)?.cursor
    await this.#subscribeChain(sessionId, resumeFrom)
  }

  /**
   * Reads buffered events newer than `fromCursor`.
   *
   * Returns `{ error: 'cursor-out-of-window' }` when the requested cursor is at
   * or before the session's retention window start. The servable replay range
   * is **strictly after** the window start (controller ruling; brief ②'s
   * 「含窗口起点」): a caller parked exactly ON the window start is refused,
   * because the window cannot prove what happened at that position — the layer
   * only knows the position itself, not the event that produced it. Anything
   * before the window start is refused for the same reason (spec §3.6), so the
   * caller is told to rebuild a baseline rather than trust a partial window.
   */
  read(sessionId: string, fromCursor?: AgentCursor): ReadResult {
    const state = this.#sessions.get(sessionId)
    if (state === undefined) return { error: 'cursor-out-of-window' }

    if (fromCursor !== undefined) {
      if (fromCursor.sessionId !== sessionId || fromCursor.streamEpoch !== state.cursor.streamEpoch) {
        return { error: 'cursor-out-of-window' }
      }
      const requested = Number(fromCursor.seq)
      // The window start is the oldest provable position: the subscription's
      // baseline while nothing has been dropped, advanced only when the cache
      // evicts old events. It is NOT servable — the range is strictly after it.
      if (!Number.isFinite(requested) || requested <= state.windowStart) {
        return { error: 'cursor-out-of-window' }
      }
      const threshold = requested
      const events = state.buffer
        .filter((entry) => Number(entry.cursor.seq) > threshold)
        .map((entry) => entry.event)
      return { events, nextCursor: this.#nextCursor(state, events.length) }
    }

    const events = state.buffer.map((entry) => entry.event)
    return { events, nextCursor: this.#nextCursor(state, events.length) }
  }

  /**
   * Routes one peer notification. `agent.events` fills the session buffer and
   * wakes waiters; `agent.subscriptions.resetRequired` marks the session for
   * re-subscription. Any other method is ignored with a warning — the client
   * layer deliberately delivers EVERY valid notification, so the consumer side
   * must tolerate methods it does not know.
   */
  handleNotification(method: string, params: unknown): void {
    if (method === 'agent.events') {
      this.#onEvents(params)
      return
    }
    if (method === 'agent.subscriptions.resetRequired') {
      this.#onResetRequired(params)
      return
    }
    console.warn(`[cherry-remote] ignoring unregistered notification "${method}"`)
  }

  /**
   * Advances the peer's view of this session: `agent.subscriptions.ack` with
   * the delivered cursor. The peer only accepts a cursor inside the window it
   * actually delivered (an out-of-window ack is its CONFLICT), so this is
   * called with the cursor a consumer has durably processed.
   */
  async ack(sessionId: string, cursor?: AgentCursor): Promise<void> {
    const state = this.#sessions.get(sessionId)
    if (state === undefined || !state.live) return
    const applied = cursor ?? state.cursor
    await this.#rpc.request('agent.subscriptions.ack', {
      subscriptionId: state.subscriptionId,
      cursor: applied,
    })
  }

  /**
   * Parks a resolver that settles when the session buffer advances past
   * `cursor`. Tasks 8/9's waiters ride this; the wake is coalesced so a batch
   * of notifications wakes each waiter exactly once.
   */
  waitFor(sessionId: string, cursor?: AgentCursor): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const state = this.#sessions.get(sessionId)
      if (state === undefined) {
        reject(new Error(`no subscription for session ${sessionId}`))
        return
      }
      const threshold = cursor === undefined ? -Infinity : Number(cursor.seq)
      const newest = state.buffer.length === 0 ? -Infinity : Number(state.buffer[state.buffer.length - 1]!.cursor.seq)
      if (newest > threshold) {
        resolve()
        return
      }
      state.waiters.push({ resolve, reject })
    })
  }

  /** Releases every live peer subscription (assembly teardown). */
  async dispose(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const ids = [...this.#sessions.values()].filter((state) => state.live).map((state) => state.subscriptionId)
    for (const state of this.#sessions.values()) {
      state.live = false
      const error = new Error('SessionSubscriptions disposed')
      for (const waiter of state.waiters.splice(0)) waiter.reject(error)
    }
    this.#sessions.clear()
    await Promise.all(ids.map((subscriptionId) => this.#closeSubscription(subscriptionId)))
  }

  // -------------------------------------------------------------------------
  // Subscribe + recovery chain
  // -------------------------------------------------------------------------

  /**
   * The ONE entry point that reaches the peer for a subscription, including
   * the full checkpoint recovery chain. `RESOURCE_EXHAUSTED` is handled by
   * evicting the LRU victim and retrying — the peer's cap is authoritative,
   * so the local cache must make room rather than surfacing the error.
   */
  async #subscribeChain(sessionId: string, fromCursor: AgentCursor | undefined): Promise<void> {
    let attempt = 0
    for (;;) {
      attempt += 1
      try {
        // Make room BEFORE asking (controller ruling 1): at the local cap, the
        // LRU victim is closed and the close is AWAITED, so the peer has
        // already freed its slot when the subscribe below arrives. This is what
        // makes local eviction happen strictly before the peer cap is touched.
        await this.#enforceLimitFor(sessionId)
        const descriptor = await this.#subscribe(sessionId, fromCursor)
        if (descriptor.mode === 'replay') {
          this.#installReplay(sessionId, descriptor)
          return
        }
        await this.#runCheckpointChain(sessionId, descriptor)
        return
      } catch (error) {
        const reason = failureReason(error)
        if (reason === 'RESOURCE_EXHAUSTED' && attempt <= MAX_RECOVERY_ATTEMPTS) {
          // The peer's REAL cap sits below the advertised one (§6's
          // subscription dimension): free a slot unconditionally and retry.
          if (!(await this.#evictLru(sessionId))) throw error
          continue
        }
        throw error
      }
    }
  }

  /** One `agent.sessions.subscribe`, classified into replay vs checkpoint. */
  async #subscribe(sessionId: string, fromCursor: AgentCursor | undefined): Promise<SubscribeDescriptor> {
    const params = fromCursor === undefined ? { sessionId } : { sessionId, cursor: fromCursor }
    const result = (await this.#rpc.request('agent.sessions.subscribe', params)) as Record<string, unknown>
    const subscriptionId = result['subscriptionId']
    if (typeof subscriptionId !== 'string') {
      throw new Error(`agent.sessions.subscribe returned no subscriptionId for ${sessionId}`)
    }
    if (result['mode'] === 'checkpoint') {
      const checkpoint = result['checkpoint']
      const cursor = isRecord(checkpoint) ? readCursor(checkpoint['cursor']) : undefined
      if (!isRecord(checkpoint) || typeof checkpoint['checkpointId'] !== 'string' || cursor === undefined) {
        throw new Error(`agent.sessions.subscribe returned a malformed checkpoint descriptor for ${sessionId}`)
      }
      return {
        mode: 'checkpoint',
        subscriptionId,
        reason: typeof result['reason'] === 'string' ? result['reason'] : 'unspecified',
        checkpoint: {
          checkpointId: checkpoint['checkpointId'],
          cursor,
          historyRevision: String(checkpoint['historyRevision'] ?? ''),
          pageCount: typeof checkpoint['pageCount'] === 'number' ? checkpoint['pageCount'] : 0,
          byteLength: String(checkpoint['byteLength'] ?? '0'),
          sha256: String(checkpoint['sha256'] ?? ''),
          expiresAt: String(checkpoint['expiresAt'] ?? ''),
        },
      }
    }
    const cursor = readCursor(result['fromCursor'])
    const highWatermark = readCursor(result['highWatermark'])
    if (cursor === undefined || highWatermark === undefined) {
      throw new Error(`agent.sessions.subscribe returned a malformed replay descriptor for ${sessionId}`)
    }
    return {
      mode: 'replay',
      subscriptionId,
      fromCursor: cursor,
      highWatermark,
      leaseExpiresAt: String(result['leaseExpiresAt'] ?? ''),
    }
  }

  /**
   * Installs a replay subscription: the peer will push events after the
   * requested cursor, so the buffer starts empty and the cursor is the
   * high-watermark the peer confirmed.
   */
  #installReplay(sessionId: string, descriptor: Extract<SubscribeDescriptor, { mode: 'replay' }>): void {
    const previous = this.#sessions.get(sessionId)
    if (previous !== undefined) this.#rejectWaiters(previous, new Error(`session ${sessionId} re-subscribed`))
    this.#sessions.delete(sessionId)
    // Re-inserting moves the session to the MRU end of the Map's order.
    this.#sessions.set(sessionId, {
      subscriptionId: descriptor.subscriptionId,
      cursor: descriptor.highWatermark,
      buffer: [],
      bytes: 0,
      windowStart: Number(descriptor.highWatermark.seq),
      waiters: [],
      live: true,
      projection: [],
    })
  }

  /**
   * The complete checkpoint recovery chain, run INSIDE the prepared lease the
   * subscribe descriptor opened:
   *
   *   1. `agent.checkpoints.read` paginates the projection rebuild — its
   *      `nextCursor` is a PAGINATION cursor and is used for nothing else;
   *   2. `agent.subscriptions.activate` commits `appliedCursor` taken from the
   *      subscribe DESCRIPTOR's cursor (all three fields).
   *
   * An expired lease (`CHECKPOINT_EXPIRED`) means the WHOLE chain is re-run:
   * a fresh subscribe, fresh pagination, fresh activate. A stale lease or
   * stale pages are never reused. A cursor mismatch is the peer's CONFLICT and
   * is surfaced, never swallowed.
   */
  async #runCheckpointChain(
    sessionId: string,
    descriptor: Extract<SubscribeDescriptor, { mode: 'checkpoint' }>,
  ): Promise<void> {
    // The lease is peer-authoritative, so this is a LOCAL budget guard only:
    // the window the descriptor opened. It bounds how long one chain may spend
    // before the layer admits the lease is gone and forces a fresh subscribe,
    // rather than issuing reads the peer will only reject.
    const leaseDeadline = Date.now() + this.#checkpointMs
    for (let attempt = 1; ; attempt += 1) {
      try {
        const items = await this.#readCheckpointPages(sessionId, descriptor)
        await this.#rpc.request('agent.subscriptions.activate', {
          subscriptionId: descriptor.subscriptionId,
          // The DESCRIPTOR's cursor — never the pagination nextCursor.
          appliedCursor: descriptor.checkpoint.cursor,
        })
        this.#installCheckpoint(sessionId, descriptor, items)
        return
      } catch (error) {
        const reason = failureReason(error)
        // Recover ONLY on an expired lease: either the peer said so, or this
        // chain has provably outlived the descriptor's window (the local guard
        // for a peer that stays silent). Anything else — notably a CONFLICT
        // from a mismatched cursor — is surfaced, never swallowed.
        const leaseGone = reason === 'CHECKPOINT_EXPIRED' || Date.now() > leaseDeadline
        if (!leaseGone || attempt >= MAX_RECOVERY_ATTEMPTS) throw error
        // The lease lapsed mid-chain. Release the dead prepared subscription
        // FIRST: the peer refuses a second subscription for a session whose
        // previous one is still on its books, so re-subscribing without this
        // close would collide with CONFLICT instead of recovering. The whole
        // chain then re-runs from a FRESH subscribe (fresh descriptor, fresh
        // lease, fresh pages) — the expired lease and stale pages are never
        // reused.
        await this.#closeSubscription(descriptor.subscriptionId)
        // Re-enter the TOP-level chain so the retry goes through the same
        // cap/resource handling as a first subscription (it cannot bypass
        // eviction or the RESOURCE_EXHAUSTED retry).
        await this.#subscribeChain(sessionId, undefined)
        return
      }
    }
  }

  /**
   * Paginates `agent.checkpoints.read` to completion, returning every item.
   * Only the pagination cursor advances here.
   */
  async #readCheckpointPages(
    sessionId: string,
    descriptor: Extract<SubscribeDescriptor, { mode: 'checkpoint' }>,
  ): Promise<Array<{ kind: string; value: unknown }>> {
    const items: Array<{ kind: string; value: unknown }> = []
    let pageCursor: string | undefined
    for (let page = 0; ; page += 1) {
      const params: Record<string, unknown> = {
        subscriptionId: descriptor.subscriptionId,
        checkpointId: descriptor.checkpoint.checkpointId,
      }
      if (pageCursor !== undefined) params['pageCursor'] = pageCursor
      const result = (await this.#rpc.request('agent.checkpoints.read', params)) as Record<string, unknown>
      const pageItems = result['items']
      if (Array.isArray(pageItems)) {
        for (const item of pageItems) {
          if (isRecord(item) && typeof item['kind'] === 'string') {
            items.push({ kind: item['kind'], value: item['value'] })
          }
        }
      }
      const next = result['nextCursor']
      if (next === null || next === undefined) return items
      pageCursor = String(next)
      if (page >= 10_000) throw new Error(`checkpoint pagination for ${sessionId} did not terminate`)
    }
  }

  /**
   * Installs the recovered subscription. The checkpoint's cursor becomes the
   * session baseline and the recovered projection items are retained as
   * {@link SessionState.projection} — they are STATE, not stream events, so
   * they never enter the event buffer and never carry a stream cursor. The
   * buffer starts empty because activation releases the replay suffix; only
   * events arriving after this baseline are streamed.
   */
  #installCheckpoint(
    sessionId: string,
    descriptor: Extract<SubscribeDescriptor, { mode: 'checkpoint' }>,
    items: Array<{ kind: string; value: unknown }>,
  ): void {
    const previous = this.#sessions.get(sessionId)
    if (previous !== undefined) this.#rejectWaiters(previous, new Error(`session ${sessionId} recovered`))
    this.#sessions.delete(sessionId)
    this.#sessions.set(sessionId, {
      subscriptionId: descriptor.subscriptionId,
      cursor: descriptor.checkpoint.cursor,
      buffer: [],
      bytes: 0,
      windowStart: Number(descriptor.checkpoint.cursor.seq),
      waiters: [],
      live: true,
      projection: [...items],
    })
  }

  /**
   * The projection state rebuilt from a checkpoint for `sessionId`, in the
   * order the pages delivered it, or an empty array when the session holds no
   * recovered baseline. Consumers (Task 9's `cherry_read`, Task 8's baseline)
   * read the rebuilt state through this rather than through the event buffer.
   */
  projection(sessionId: string): ReadonlyArray<{ kind: string; value: unknown }> {
    return this.#sessions.get(sessionId)?.projection ?? []
  }

  async #closeSubscription(subscriptionId: string): Promise<void> {
    try {
      await this.#rpc.request('agent.subscriptions.close', { subscriptionId })
    } catch (error) {
      // Closing is best-effort: the peer may already have reset it, and the
      // caller is about to establish a replacement either way.
      console.warn(`[cherry-remote] closing subscription ${subscriptionId} failed`, error)
    }
  }

  /**
   * Makes room for one more peer subscription when the live count has reached
   * the CLAMPED cap, by evicting the least-recently-used session other than
   * `protectedSessionId`. The close is AWAITED (controller ruling 1): the peer
   * frees its slot only once it has processed `agent.subscriptions.close`, so a
   * fire-and-forget eviction would race the next subscribe straight into
   * RESOURCE_EXHAUSTED. Returns false when there was nothing to evict.
   */
  async #enforceLimitFor(protectedSessionId: string): Promise<void> {
    if (this.#liveCount() < this.#limit) return
    await this.#evictLru(protectedSessionId)
  }

  /**
   * Evicts the least-recently-used live session other than `protectedSessionId`,
   * unconditionally (no local-cap precondition). This is the RESOURCE_EXHAUSTED
   * reaction: the peer's REAL cap turned out to be below the advertised one, so
   * a slot must be freed regardless of what the local cap believed.
   */
  async #evictLru(protectedSessionId: string): Promise<boolean> {
    for (const [sessionId, state] of this.#sessions) {
      if (sessionId === protectedSessionId || !state.live) continue
      // 「丢最旧并记录」: the eviction is logged, never silent.
      console.warn(
        `[cherry-remote] subscription limit (${this.#limit}) reached; evicting least-recently-used session ` +
          `${sessionId}`,
      )
      state.live = false
      this.#rejectWaiters(state, new Error(`session ${sessionId} evicted by LRU`))
      this.#sessions.delete(sessionId)
      // AWAITED: the peer must observe the close before the next subscribe.
      await this.#closeSubscription(state.subscriptionId)
      return true
    }
    return false
  }

  /** Live (peer-backed) subscription count. */
  #liveCount(): number {
    let count = 0
    for (const state of this.#sessions.values()) if (state.live) count += 1
    return count
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /**
   * `agent.events`: append to the session buffer, enforce the byte budget by
   * dropping the OLDEST events (logged), advance the cursor, then wake waiters.
   */
  #onEvents(params: unknown): void {
    if (!isRecord(params)) {
      console.warn('[cherry-remote] ignoring malformed agent.events notification')
      return
    }
    const subscriptionId = params['subscriptionId']
    const sessionId = params['sessionId']
    const streamEpoch = params['streamEpoch']
    const events = params['events']
    if (typeof subscriptionId !== 'string' || typeof sessionId !== 'string' || !Array.isArray(events)) {
      console.warn('[cherry-remote] ignoring malformed agent.events notification')
      return
    }
    const state = this.#sessions.get(sessionId)
    if (state === undefined || state.subscriptionId !== subscriptionId) {
      // A notification for a subscription we no longer hold (closed/evicted):
      // expected during eviction races, so this is not a warning.
      return
    }
    if (typeof streamEpoch === 'string' && streamEpoch !== state.cursor.streamEpoch) {
      console.warn(
        `[cherry-remote] ignoring agent.events for session ${sessionId}: stream epoch ${streamEpoch} ` +
          `does not match ${state.cursor.streamEpoch}`,
      )
      return
    }

    for (const raw of events) {
      if (!isRecord(raw)) continue
      const seq = String(raw['seq'] ?? '')
      if (seq === '') continue
      const cursor: AgentCursor = { sessionId, streamEpoch: state.cursor.streamEpoch, seq }
      const event = raw as unknown as AgentEvent
      const bytes = eventBytes(event)
      state.buffer.push({ cursor, event, bytes })
      state.bytes += bytes
      state.cursor = cursor
    }

    this.#trimToBudget(sessionId, state)
    this.#wakeWaiters(state)
  }

  /**
   * `agent.subscriptions.resetRequired`: the peer tore the subscription down
   * (replay suffix lost, checkpoint lease lapsed, ...). The entry stays so the
   * caller's next `ensure` can rebuild it — with a fresh subscribe, never by
   * reusing the dead subscription.
   */
  #onResetRequired(params: unknown): void {
    if (!isRecord(params)) {
      console.warn('[cherry-remote] ignoring malformed agent.subscriptions.resetRequired notification')
      return
    }
    const subscriptionId = params['subscriptionId']
    if (typeof subscriptionId !== 'string') return
    for (const [sessionId, state] of this.#sessions) {
      if (state.subscriptionId !== subscriptionId) continue
      console.warn(
        `[cherry-remote] subscription for session ${sessionId} reset by the peer ` +
          `(${String(params['reason'] ?? 'unspecified')}); re-subscribe required`,
      )
      state.live = false
      this.#sessions.delete(sessionId)
      return
    }
  }

  /** Drops the OLDEST buffered events until the session fits its byte budget. */
  #trimToBudget(sessionId: string, state: SessionState): void {
    if (state.bytes <= this.#perSessionCacheBytes) return
    let dropped = 0
    while (state.bytes > this.#perSessionCacheBytes && state.buffer.length > 0) {
      const removed = state.buffer.shift()!
      state.bytes -= removed.bytes
      dropped += 1
      // The window start advances past every dropped event: a caller parked at
      // or before it can no longer be served and must rebuild a baseline.
      state.windowStart = Math.max(state.windowStart, Number(removed.cursor.seq))
    }
    console.warn(
      `[cherry-remote] session ${sessionId} cache exceeded ${this.#perSessionCacheBytes} bytes; ` +
        `dropped ${dropped} oldest event(s)`,
    )
  }

  /** Coalesced wake: each parked waiter settles exactly once. */
  #wakeWaiters(state: SessionState): void {
    for (const waiter of state.waiters.splice(0)) waiter.resolve()
  }

  #rejectWaiters(state: SessionState, error: Error): void {
    for (const waiter of state.waiters.splice(0)) waiter.reject(error)
  }

  /** The cursor a read advances to: the newest event returned, else the cursor. */
  #nextCursor(state: SessionState, returnedCount: number): AgentCursor {
    if (returnedCount === 0) return state.cursor
    const entry = state.buffer[state.buffer.length - 1]!
    return entry.cursor
  }
}

export type { AgentCursor, AgentEvent }
