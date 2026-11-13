import { failureReason, JsonRpcRequestError } from './rpc/jsonRpcClient.js'
import type { JsonRpcClient } from './rpc/jsonRpcClient.js'
import { DEFAULT_PER_SESSION_CACHE_BYTES } from './defaults.js'
import { failureText } from './text.js'
import { remoteLimits } from '@cherrystudio/remote-protocol'
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
/** The peer's prepared-lease window, used to bound recovery-chain retries. */
const DEFAULT_CHECKPOINT_MS = 300_000
/**
 * LOCAL POLICY CONSTANT (the protocol specifies no such bound; accepted by the
 * controller as a defensive limit). The SHARED retry budget for one `ensure`:
 * it covers BOTH recoverable paths — the `RESOURCE_EXHAUSTED` evict-and-retry
 * and the checkpoint-lease-expiry chain restart — and is threaded down through
 * the recovery recursion rather than counted per call, so a nested restart
 * cannot reset it. Each retry is a FRESH subscribe + pagination + activate (a
 * stale lease or stale pages are never reused), so this only bounds
 * pathological peer churn: a peer that expires every lease surfaces its last
 * error rather than looping forever. Not injectable — it is a safety bound,
 * not a tuning knob.
 */
const MAX_RECOVERY_ATTEMPTS = 4

/**
 * ACK WATERMARK (issue #212). The peer delivers `agent.events` only while the
 * bytes it has sent since our last `agent.subscriptions.ack` stay inside
 * `remoteLimits.unackedBytes`; past that it HOLDS the stream — silently, with
 * the subscription still live — and a held batch can be a run's terminal.
 *
 * This layer used to ack ONLY from `cherry_events`, so a waiter (which by
 * design consumes without acking) parked on a buffer that stopped advancing
 * just under one window: a real 240 s wait answered `timeout` with the finished
 * text, its cursor frozen at 666 events ≈ 262144 bytes.
 *
 * The layer therefore acks what it has ALREADY BUFFERED (the bytes are in
 * memory; acking does not lose them) once a quarter of the peer's window has
 * accumulated. A retry cooldown keeps a refusing peer from turning every batch
 * into a round trip.
 */
/** First retry delay after a refused auto-ack; doubles per attempt. */
const AUTO_ACK_RETRY_MS = 3_000
/** Ceiling for the doubling retry, so a permanently refusing peer is quiet. */
const AUTO_ACK_RETRY_MAX_MS = 30_000

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
  /**
   * The peer's hello-advertised un-acked delivery window in bytes (protocol
   * `remoteLimits.unackedBytes`, 262144 in the pinned package). Past that much
   * delivered-but-unacknowledged traffic the desktop HOLDS its event stream
   * (issue #212), so the layer acks its buffer at a quarter of this value.
   *
   * Omitted falls back to the pinned protocol constant. A peer that does not
   * advertise the key is treated as the pinned generation — the same
   * conservative rule the other negotiated limits follow.
   *
   * A FUNCTION is read at every watermark check, so a layer that outlives a
   * reconnect picks up the new hello's value instead of pinning the first one.
   */
  unackedBytes?: number | (() => number | undefined)
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
   * Bytes appended since the last ack we sent (issue #212). Drives
   * {@link SessionSubscriptions.#maybeAutoAck}; kept separate from `bytes`,
   * which measures what the CACHE holds rather than what the peer may still
   * consider un-acknowledged.
   */
  bytesSinceAck: number
  /**
   * Event payload bytes received since this subscription was INSTALLED
   * (issue #217). Monotone for the life of one subscription — unlike `bytes`
   * (what the cache still holds) and `bytesSinceAck` (what the peer may still
   * count) — so 「the stream exceeded the window」 becomes a measurement in
   * diagnostics instead of an extrapolation from a frozen cursor.
   */
  deliveredBytes: number
  /**
   * Successful `agent.subscriptions.ack` calls for this subscription (issue
   * #217). NOT a progress metric: every accepted call counts, including a
   * repeated explicit ack at the cursor the peer already holds.
   */
  acks: number
  /** One auto-ack in flight at a time; a second would only duplicate a cursor. */
  ackInFlight: boolean
  /** Cooldown after a refused auto-ack (`AUTO_ACK_RETRY_MS`, doubling). */
  ackRetryAt: number
  /**
   * Current retry delay: `AUTO_ACK_RETRY_MS` after the first refusal, doubled
   * on every further one up to `AUTO_ACK_RETRY_MAX_MS`. Reset on a success, so
   * a peer that recovers is back to prompt retries.
   */
  ackRetryDelay: number
  /**
   * The ARMED retry behind `ackRetryAt`. An ack failure is the one case where
   * no further event will arrive to re-trigger the watermark check — the peer
   * is holding at its window — so the retry cannot wait for traffic (issue
   * #212's own failure mode, one ack later). Cleared by {@link #installReplay},
   * {@link #installCheckpoint} and {@link SessionSubscriptions.dispose}.
   */
  ackRetryTimer?: ReturnType<typeof setTimeout>
  /**
   * The oldest stream position this session still TRACKS: the baseline the
   * subscription started from, advanced whenever old events are dropped. It is
   * a rejection boundary, not a resume point — whether it can itself be served
   * depends on {@link evicted}.
   */
  windowStart: number
  /**
   * Whether {@link windowStart} has been advanced by an EVENT DROP rather than
   * standing at the subscription's baseline (`#trimToBudget` sets this).
   *
   * The two states are not equivalent, and `read` treats them differently: a
   * baseline IS a position this layer itself issued as a resume point and never
   * discarded anything at, so serving it loses nothing; a boundary reached by
   * dropping events cannot be served, because the events that occupied it are
   * gone (see {@link SessionSubscriptions.read} for the full rule). A boolean
   * rather than a separate "baseline" field because the baseline is simply
   * `windowStart` while this is false — one value, two meanings, one flag.
   *
   * Reset to false by every install, since a re-subscribe or a checkpoint
   * recovery starts a FRESH window with nothing dropped from it (issue #2).
   */
  evicted: boolean
  /**
   * The resolver queue behind {@link SessionSubscriptions.waitFor}: one entry
   * per caller currently parked on this session, all settled together (and
   * exactly once) by the next buffer advance, re-subscribe or disposal.
   *
   * This is NOT a cursor-retention list: nothing here records what a caller has
   * consumed. Retention is {@link windowStart}'s job alone — the boundary
   * advances when the byte budget drops old events, and `waitFor` compares the
   * caller's threshold against the BUFFER, not against this queue.
   */
  waiters: Waiter[]
  /**
   * Projection state rebuilt from a checkpoint, if this session was recovered
   * that way. STATE, never stream events — it carries no stream cursor.
   */
  projection: Array<{ kind: string; value: unknown }>
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
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
  /** Where the peer's window comes from; see {@link SessionSubscriptionsOptions.unackedBytes}. */
  readonly #unackedSource: number | (() => number | undefined) | undefined
  readonly #sessions = new Map<string, SessionState>()
  /**
   * Subscribes IN FLIGHT, one per session (#365).
   *
   * The peer refuses a second subscription for one session on one connection
   * (CONFLICT), so two callers that reach `ensure` in the same step — two tool
   * calls, or a first-use ensure racing a re-ensure — used to make the second
   * one fail for a reason the caller never caused. A caller that arrives while
   * a subscribe is running now waits for THAT one: one peer subscription, and
   * every caller sees the same verdict, including a rejection.
   *
   * Joining is by sessionId AND by cursor COMPATIBILITY, because the cursor is
   * not free: it asks the peer to REPLAY from that position, and a subscribe
   * opened without one answers a checkpoint. A caller that needs a replay —
   * `#awaitRun`'s recovery, which re-ensures from the cursor it already holds —
   * therefore cannot ride a subscribe another caller started cursorless: it
   * would open a checkpoint, the replay would never arrive, and the wait would
   * end in `timeout` for a run that had already settled. So a joiner rides the
   * attempt in flight only when it wants no replay, or the same one.
   *
   * The entry is dropped the moment the subscribe settles, so a LATER `ensure`
   * still takes the re-subscribe path (close the live subscription, then
   * subscribe) exactly as before.
   */
  readonly #ensuring = new Map<string, { cursor: AgentCursor | undefined; promise: Promise<void> }>()
  /**
   * Insertion order IS the eviction order, and it is SUBSCRIPTION recency, not
   * USE recency. Read that literally: only `ensure` (a re-subscribe re-inserts
   * the session at the MRU end) moves an entry. `read`, `ack`, `waitFor` and
   * every notification leave the order untouched — a session that is read
   * constantly but never re-subscribed is still the first eviction victim.
   *
   * That is a deliberate fit, not an oversight: the cap this LRU enforces is
   * the PEER's subscription cap, and the resource being rationed is the live
   * peer-side subscription. Sessions are long-lived and few (the cap defaults
   * to 8), so "least recently established" tracks the least valuable slot
   * closely enough; a true use-recency LRU would need a touch on every event
   * and would evict a session the caller is actively reading from.
   */
  #closed = false

  constructor(rpc: JsonRpcClient, opts: SessionSubscriptionsOptions = {}) {
    this.#rpc = rpc
    this.#limit = Math.max(1, Math.floor(positive(opts.subscriptionsLimit, DEFAULT_SUBSCRIPTIONS_LIMIT)))
    this.#perSessionCacheBytes = positive(opts.perSessionCacheBytes, DEFAULT_PER_SESSION_CACHE_BYTES)
    this.#checkpointMs = positive(opts.checkpointMs, DEFAULT_CHECKPOINT_MS)
    this.#unackedSource = opts.unackedBytes
  }

  /**
   * Session ids with a live subscription, LRU-first. Task 10's reconnect
   * re-ensure iterates exactly this list.
   */
  activeSessions(): string[] {
    return [...this.#sessions.keys()]
  }

  /**
   * How many resolvers are currently parked on `sessionId`.
   *
   * A read-only view of state this layer owns, exposed because ABANDONED PARKS
   * are invisible otherwise: a caller that re-parks without disposing (the
   * `cherry_wait` poll loop) leaves one resolver per pass in the queue, and the
   * only symptom is a queue that grows silently. Zero for an untracked session.
   */
  waiterCount(sessionId: string): number {
    return this.#sessions.get(sessionId)?.waiters.length ?? 0
  }

  /**
   * The session's CURRENT stream cursor — the newest position this layer knows
   * is durable for it — or undefined when the session is untracked.
   *
   * A READ-ONLY VIEW OF STATE THE LAYER ALREADY OWNS, and the reason it is a
   * public accessor rather than something each caller re-derives: two consumers
   * were reconstructing it from the outside, and both got it subtly wrong.
   *
   *  - `GET /diagnostics` used to report sessions with NO cursor at all, so the
   *    report claimed a subscription was live while omitting where it stood.
   *  - `cherry_events`' out-of-window verdict used to PROBE for the boundary by
   *    re-running `read` with candidate seqs. That probe could not even reach
   *    the answer in general (it scanned upward one seq at a time) and it made
   *    a read-only tool look like it was walking state.
   *
   * The window start is a DIFFERENT value and is exposed separately by
   * {@link windowStart} — this one is where the session's cursor stands, which
   * is what "resume from here" means.
   */
  cursorOf(sessionId: string): AgentCursor | undefined {
    return this.#sessions.get(sessionId)?.cursor
  }

  /**
   * The DELIVERY LEDGER of one subscription (issue #217): the payload bytes it
   * has received since it was installed, how much of that the peer may still
   * count as un-acknowledged, and how many acks it has taken. Undefined for a
   * session this layer does not hold — never a fabricated zero.
   *
   * Diagnostics is the caller: these three numbers are what turns 「the stream
   * exceeded the peer's window」 from an extrapolation into a measurement.
   *
   * A CLIENT-SIDE ledger, never the peer's: `unackedBytes` is this layer's
   * model of what the peer may still count (bytes since its last accepted
   * ack), not a reading of the peer's own window or ack position.
   */
  deliveryOf(
    sessionId: string,
  ): { deliveredBytes: number; unackedBytes: number; acks: number } | undefined {
    const state = this.#sessions.get(sessionId)
    if (state === undefined) return undefined
    return {
      deliveredBytes: state.deliveredBytes,
      unackedBytes: state.bytesSinceAck,
      acks: state.acks,
    }
  }

  /**
   * The session's cache WINDOW START — the retention BOUNDARY of this layer's
   * cache: the oldest position it still tracks — or undefined when the session
   * is untracked.
   *
   * The boundary means two DIFFERENT things depending on whether the window has
   * dropped events (issue #2; see {@link SessionState.evicted}), which is why it
   * must not be described as "the earliest position you could resume from" in
   * one breath:
   *
   *  - NOTHING DROPPED — the boundary is the subscription's baseline, a position
   *    this layer itself issues as a resume point, and it IS the earliest
   *    resumable position: {@link read} serves it (the replay is the boundary
   *    INCLUSIVE here).
   *  - EVENTS DROPPED — the boundary is where the discarded run ended, and the
   *    event that occupied it is gone. The earliest resumable position is then
   *    the first retained event STRICTLY after it; the boundary itself is
   *    refused, and its value is what the refusal is judged against and what
   *    points a caller at the rebuild (`cherry_read`).
   *
   * So the reported value is exact as a rejection threshold and as a rebuild
   * anchor, and it must NOT be fed back to `read` in the dropped state — there
   * the verdict refuses it.
   *
   * Exposed because the layer is the only thing that knows it. Callers were
   * previously expected to rediscover it by binary-searching `read`'s verdict
   * from the outside, which is both wasteful and fragile: `read` also refuses
   * for a mismatched session/epoch, so a probe cannot distinguish "below the
   * window" from "wrong epoch" without more outside knowledge than a caller
   * should need.
   */
  windowStart(sessionId: string): AgentCursor | undefined {
    const state = this.#sessions.get(sessionId)
    if (state === undefined) return undefined
    return { sessionId, streamEpoch: state.cursor.streamEpoch, seq: String(state.windowStart) }
  }

  /**
   * Guarantees a live subscription for `sessionId`.
   *
   * The resume cursor comes from the CALLER or not at all — there is no
   * implicit reuse. Task 10's reconnect re-ensure passes the last cursor
   * explicitly; Tasks 8/9's first-use ensure is cursorless by design and may
   * therefore land in checkpoint mode.
   *
   * A same-session re-ensure is a SINGLE path: close the old peer subscription
   * FIRST (the peer flips it to `phase: 'reset'`, which is what makes the
   * re-subscribe legal rather than CONFLICT), then subscribe exactly once.
   */
  async ensure(sessionId: string, cursor?: AgentCursor): Promise<void> {
    if (this.#closed) throw new Error('SessionSubscriptions disposed')

    // ONE subscribe per session at a time (#365). Without this, two callers in
    // the same step both find no subscription and both ask the peer, which
    // refuses the second one.
    const inFlight = this.#ensuring.get(sessionId)
    if (inFlight !== undefined) {
      if (this.#joinable(inFlight.cursor, cursor)) return inFlight.promise
      // Wait for the attempt in flight, then take this caller's OWN path: its
      // replay cannot be served by a subscribe already on the wire.
      await inFlight.promise.catch(() => undefined)
      return this.ensure(sessionId, cursor)
    }
    const run = this.#ensureOnce(sessionId, cursor)
    const entry = { cursor, promise: run }
    this.#ensuring.set(sessionId, entry)
    // Both arms, so a rejected subscribe is observed by this bookkeeping too
    // and cannot become an unhandled rejection while the callers are attaching.
    const forget = (): void => {
      if (this.#ensuring.get(sessionId) === entry) this.#ensuring.delete(sessionId)
    }
    run.then(forget, forget)
    return run
  }

  /**
   * Can a caller asking for `wanted` ride a subscribe started from `started`?
   *
   * Only when it needs no replay (a checkpoint answers it), or when it needs
   * exactly the one already on the wire. Anything else has to wait and ask
   * again — see {@link SessionSubscriptions.#ensuring}.
   */
  #joinable(started: AgentCursor | undefined, wanted: AgentCursor | undefined): boolean {
    if (wanted === undefined) return true
    if (started === undefined) return false
    return (
      started.sessionId === wanted.sessionId &&
      started.streamEpoch === wanted.streamEpoch &&
      started.seq === wanted.seq
    )
  }

  /** {@link SessionSubscriptions.ensure} without the in-flight bookkeeping. */
  async #ensureOnce(sessionId: string, cursor?: AgentCursor): Promise<void> {
    // Re-subscribe path: release the old subscription before asking again.
    const existing = this.#sessions.get(sessionId)
    if (existing !== undefined) {
      // INFO (spec §5): a re-ensure is a RECOVERY, and it is the interesting
      // half of the trail — an operator seeing this repeatedly is watching a
      // session that will not stay subscribed.
      console.info(`[cherry-remote] re-subscribing session ${sessionId} (replacing its live subscription)`)
      await this.#closeSubscription(existing.subscriptionId)
      this.#cancelAckRetry(existing)
      this.#rejectWaiters(existing, new Error(`session ${sessionId} re-subscribed`))
      this.#sessions.delete(sessionId)
    }

    await this.#subscribeChain(sessionId, cursor)
  }

  /**
   * Reads buffered events newer than `fromCursor`.
   *
   * Returns `{ error: 'cursor-out-of-window' }` when the requested cursor is
   * strictly before the session's retention window start, or exactly AT it once
   * that boundary was advanced by dropping events (see {@link SessionState.evicted}).
   * Two positions reach the boundary, and they are NOT interchangeable:
   *
   *  - the subscription's BASELINE — where the window starts before anything was
   *    dropped. It is not an unretained event: it is the position this very
   *    layer hands out as the resume point (`#nextCursor` returns `state.cursor`
   *    when the buffer is empty, which on a fresh window IS the baseline), so
   *    serving it re-delivers exactly what the caller has not seen. Refusing it
   *    made the layer contradict itself: the cursor `cherry_send`/`cherry_wait`
   *    report and `cherry_events` must accept would have been rejected by this
   *    very method, and on a fresh session the two tools deadlocked (issue #2).
   *  - a boundary ADVANCED BY A DROP ({@link #trimToBudget}): the events that
   *    occupied that position are gone, so continuity cannot be proven. Serving
   *    it would return a correct-looking but possibly EMPTY replay whose
   *    `nextCursor` is that same unservable boundary, handing the caller a
   *    stale, empty read forever. Refusing routes them to `cherry_read`'s
   *    baseline rebuild instead, which is the only honest recovery.
   *
   * Anything strictly BEFORE the boundary is refused in both states (spec §3.6):
   * the layer never issued that position on this window, so it cannot vouch for
   * what happened at it.
   */
  read(sessionId: string, fromCursor?: AgentCursor): ReadResult {
    const state = this.#sessions.get(sessionId)
    if (state === undefined) return { error: 'cursor-out-of-window' }

    if (fromCursor !== undefined) {
      if (fromCursor.sessionId !== sessionId || fromCursor.streamEpoch !== state.cursor.streamEpoch) {
        return { error: 'cursor-out-of-window' }
      }
      const requested = Number(fromCursor.seq)
      // THE TWO-STATE RULE (issue #2), and the reason it is a flag rather than a
      // comparison against the buffer:
      //
      //  - `requested === windowStart` is SERVABLE while the boundary is still
      //    the subscription's baseline. Nothing was discarded below it, and it
      //    is the position this layer itself issues as the resume point (see
      //    `#nextCursor`), so the replay cannot lose anything.
      //  - once `#trimToBudget` has dropped events, the boundary marks a
      //    position whose event is GONE. The layer knows the position and
      //    nothing about the event that occupied it, so it cannot certify what
      //    the caller has seen. Accepting it would answer a possibly EMPTY
      //    replay whose nextCursor is the unservable boundary itself — a stale
      //    read that repeats forever, having lost whatever was dropped. That
      //    refusal stands: it routes the caller to `cherry_read`'s baseline
      //    rebuild, the only honest recovery.
      //
      // DIVERGENCE FROM THE SPEC WORDING, deliberately: the spec says 「早于」 the
      // window start is out of window. Below the boundary is refused in both
      // states, as written; AT the boundary the verdict depends on whether
      // anything was actually dropped, which the spec wording does not
      // distinguish. The earliest RESUMABLE position therefore has TWO forms,
      // and `windowStart()` reports one boundary that they share: in the
      // nothing-dropped state the boundary itself is resumable, and in the
      // dropped state it is NOT — the first retained event strictly after it
      // is. The boundary is what the refusal is judged against and what the
      // caller rebuilds from; it is not, in the dropped state, itself a cursor
      // to resume on.
      const belowWindow = !Number.isFinite(requested) || requested < state.windowStart
      const atDroppedBoundary = requested === state.windowStart && state.evicted
      if (belowWindow || atDroppedBoundary) {
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
   * actually delivered (an out-of-window ack is its CONFLICT).
   *
   * Two callers, one contract — "this position is accounted for, keep sending":
   * `cherry_events` passes the cursor a CONSUMER has processed, and
   * {@link #maybeAutoAck} passes the BUFFER frontier because the events are
   * retained here (see that method for why an ack cannot lose replay).
   */
  async ack(sessionId: string, cursor?: AgentCursor): Promise<void> {
    const state = this.#sessions.get(sessionId)
    if (state === undefined) return
    // COALESCED TO THE FRONTIER. The peer keeps ONE `lastAck` per subscription
    // and refuses a lower position, so an explicit ack carrying what a consumer
    // has processed would lose a race against the layer's own ack and be
    // answered CONFLICT — which the caller treats as a broken subscription.
    // The buffer already holds everything up to `state.cursor`, so acking the
    // frontier is both safe (an ack only frees flow control) and monotone.
    const requested = cursor === undefined ? state.cursor : cursor
    const applied = Number(requested.seq) > Number(state.cursor.seq) ? requested : state.cursor
    // What THIS ack covers: everything received up to the moment it is sent.
    // Events arriving while it is in flight sit past the applied cursor, so
    // they stay counted.
    const covered = state.bytesSinceAck
    await this.#rpc.request('agent.subscriptions.ack', {
      subscriptionId: state.subscriptionId,
      cursor: applied,
    })
    // COUNTED ONLY AFTER the peer accepted it: a refused ack frees no window,
    // so a ledger that moved optimistically would claim progress the peer never
    // granted. The SAME rule governs the byte side, which is why BOTH live here
    // rather than in the auto-ack caller: an explicit ack frees the window just
    // as well, and the ledger must not disagree with it.
    state.bytesSinceAck = Math.max(0, state.bytesSinceAck - covered)
    state.acks += 1
  }

  /**
   * Parks a resolver that settles when the session buffer advances past
   * `cursor`. Tasks 8/9's waiters ride this; the wake is coalesced so a batch
   * of notifications wakes each waiter exactly once.
   *
   * Returns a DISPOSER alongside the promise. Without one, a caller that parks
   * repeatedly (the `cherry_wait` poll loop re-parks after every judgement pass)
   * leaves the previous park's resolver in the session's waiter queue forever:
   * the queue grows once per poll interval for the life of the wait, and every
   * buffer advance settles all of them. The disposer removes the park if it is
   * still queued; calling it after the park settled is a harmless no-op, so a
   * caller may use it unconditionally.
   */
  waitFor(sessionId: string, cursor?: AgentCursor): { promise: Promise<void>; dispose: () => void } {
    let dispose = (): void => {}
    const promise = new Promise<void>((resolve, reject) => {
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
      const waiter: Waiter = { resolve, reject }
      state.waiters.push(waiter)
      // Idempotent: a second call (or a call after the park settled and the
      // waiter was spliced out) must not disturb the queue.
      dispose = (): void => {
        const index = state.waiters.indexOf(waiter)
        if (index >= 0) state.waiters.splice(index, 1)
      }
    })
    // Background/rejected paths are already handled by callers; keep the
    // promise's rejection observable exactly as before (no extra catch here).
    return { promise, dispose }
  }

  /** Releases every live peer subscription (assembly teardown). */
  async dispose(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const ids = [...this.#sessions.values()].map((state) => state.subscriptionId)
    for (const state of this.#sessions.values()) {
      this.#cancelAckRetry(state)
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
   * the full checkpoint recovery chain.
   *
   * A SINGLE shared budget governs every recoverable retry here — the
   * `RESOURCE_EXHAUSTED` evict-and-retry AND the checkpoint-lease-expiry chain
   * restart. `attemptsLeft` is threaded through the recursion (rather than
   * counted per call) precisely so a nested restart cannot reset the counter
   * and loop forever: a peer that expires every lease is eventually given up
   * on and its last `CHECKPOINT_EXPIRED` is surfaced.
   */
  async #subscribeChain(
    sessionId: string,
    fromCursor: AgentCursor | undefined,
    attemptsLeft: number = MAX_RECOVERY_ATTEMPTS,
  ): Promise<void> {
    for (;;) {
      try {
        // Make room BEFORE asking (controller ruling 1): at the local cap, the
        // LRU victim is closed and the close is AWAITED, so the peer has
        // already freed its slot when the subscribe below arrives. This is what
        // makes local eviction happen strictly before the peer cap is touched.
        await this.#enforceLimitFor(sessionId)
        const descriptor = await this.#subscribe(sessionId, fromCursor)
        if (descriptor.mode === 'replay') {
          await this.#activateReplay(sessionId, descriptor, attemptsLeft)
          return
        }
        await this.#runCheckpointChain(sessionId, descriptor, attemptsLeft)
        return
      } catch (error) {
        const reason = failureReason(error)
        if (reason === 'RESOURCE_EXHAUSTED' && attemptsLeft > 1) {
          // The peer's REAL cap sits below the advertised one (§6's
          // subscription dimension): free a slot unconditionally and retry,
          // spending one attempt from the shared budget.
          if (!(await this.#evictLru(sessionId))) throw error
          attemptsLeft -= 1
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
   * Commits a replay subscription, then installs it (#369).
   *
   * `agent.sessions.subscribe` answers `prepared` in BOTH modes: until
   * `agent.subscriptions.activate` commits a cursor, the peer's pump sends
   * nothing at all. And `activate` accepts only the cursor that was REQUESTED
   * (`appliedCursor.seq === subscription.cursorSeq`), which is where the caller
   * is — not the descriptor's `highWatermark`, which is where the PEER is.
   *
   * So the subscription resumes at `fromCursor`, and the suffix the peer then
   * pumps (`eventsAfter(fromCursor)`) passes the seq gate. Installing the high
   * watermark instead — which this did until #369 — both left the subscription
   * unactivated and put the gate above the whole suffix, so a replay delivered
   * nothing and a wait's recovery timed out for a run that had settled.
   *
   * A suffix the peer no longer retains (`RESET_REQUIRED`) or a lapsed lease
   * (`CHECKPOINT_EXPIRED`) means no replay is possible: the prepared
   * subscription is closed and the chain re-runs CURSORLESS, which is the
   * checkpoint path that rebuilds the view from a projection. Every other
   * refusal is surfaced.
   */
  async #activateReplay(
    sessionId: string,
    descriptor: Extract<SubscribeDescriptor, { mode: 'replay' }>,
    attemptsLeft: number,
  ): Promise<void> {
    try {
      await this.#rpc.request('agent.subscriptions.activate', {
        subscriptionId: descriptor.subscriptionId,
        // The cursor the CALLER holds — the one the subscribe request carried.
        appliedCursor: descriptor.fromCursor,
      })
    } catch (error) {
      // The peer keeps a prepared subscription on its books until the lease
      // lapses, and it refuses a second one for the same session, so the dead
      // attempt is released before anything else is tried.
      await this.#closeSubscription(descriptor.subscriptionId)
      const reason = failureReason(error)
      const unreplayable = reason === 'RESET_REQUIRED' || reason === 'CHECKPOINT_EXPIRED'
      if (!unreplayable || attemptsLeft <= 1) throw error
      // The suffix is gone: only a fresh projection can still answer. Re-enter
      // the TOP-level chain so the retry pays the same cap/resource handling as
      // a first subscription, spending one shared attempt.
      await this.#subscribeChain(sessionId, undefined, attemptsLeft - 1)
      return
    }
    this.#installReplay(sessionId, descriptor)
  }

  /**
   * Installs an ACTIVATED replay subscription: the peer pumps events after the
   * cursor the caller applied, so the buffer starts empty and the session's
   * cursor is that applied position.
   */
  #installReplay(sessionId: string, descriptor: Extract<SubscribeDescriptor, { mode: 'replay' }>): void {
    const previous = this.#sessions.get(sessionId)
    if (previous !== undefined) {
      this.#cancelAckRetry(previous)
      this.#rejectWaiters(previous, new Error(`session ${sessionId} re-subscribed`))
    }
    this.#sessions.delete(sessionId)
    // Re-inserting moves the session to the MRU end of the Map's order.
    this.#sessions.set(sessionId, {
      subscriptionId: descriptor.subscriptionId,
      cursor: descriptor.fromCursor,
      buffer: [],
      bytes: 0,
      bytesSinceAck: 0,
      // A fresh subscription owns a fresh ledger (issue #217): the counters
      // describe THIS install, never a previous one.
      deliveredBytes: 0,
      acks: 0,
      ackInFlight: false,
      ackRetryAt: 0,
      ackRetryDelay: AUTO_ACK_RETRY_MS,
      ackRetryTimer: undefined,
      windowStart: Number(descriptor.fromCursor.seq),
      // A fresh window: nothing has been dropped from it, so the baseline is a
      // position this layer may serve (issue #2).
      evicted: false,
      waiters: [],
      projection: [],
    })
    // INFO (spec §5 「订阅建立」): established, in replay mode, at the baseline
    // the peer confirmed. Ids/positions only — the descriptor's lease is not a
    // secret, but nothing here needs to be more verbose than this.
    console.info(
      `[cherry-remote] subscription established for session ${sessionId} (replay from seq ` +
        `${descriptor.fromCursor.seq}, applied and active)`,
    )
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
   *
   * `attemptsLeft` is the SHARED budget handed down from {@link #subscribeChain}
   * and decremented on each lease-expiry restart, so a peer that expires every
   * lease terminates with its last error instead of restarting forever.
   */
  async #runCheckpointChain(
    sessionId: string,
    descriptor: Extract<SubscribeDescriptor, { mode: 'checkpoint' }>,
    attemptsLeft: number,
  ): Promise<void> {
    // The lease is peer-authoritative, so this is a LOCAL budget guard only:
    // the window the descriptor opened. It bounds how long one chain may spend
    // before the layer admits the lease is gone and forces a fresh subscribe,
    // rather than issuing reads the peer will only reject.
    const leaseDeadline = Date.now() + this.#checkpointMs
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
      // from a mismatched cursor — is surfaced, never swallowed. Exhausting
      // the shared budget also surfaces (this error), which is what stops a
      // peer that expires every lease from looping forever.
      const leaseGone = reason === 'CHECKPOINT_EXPIRED' || Date.now() > leaseDeadline
      if (!leaseGone || attemptsLeft <= 1) throw error
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
      // eviction or the RESOURCE_EXHAUSTED retry), spending one shared attempt.
      await this.#subscribeChain(sessionId, undefined, attemptsLeft - 1)
      return
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
    if (previous !== undefined) {
      this.#cancelAckRetry(previous)
      this.#rejectWaiters(previous, new Error(`session ${sessionId} recovered`))
    }
    this.#sessions.delete(sessionId)
    this.#sessions.set(sessionId, {
      subscriptionId: descriptor.subscriptionId,
      cursor: descriptor.checkpoint.cursor,
      buffer: [],
      bytes: 0,
      bytesSinceAck: 0,
      // A fresh subscription owns a fresh ledger (issue #217): the counters
      // describe THIS install, never a previous one.
      deliveredBytes: 0,
      acks: 0,
      ackInFlight: false,
      ackRetryAt: 0,
      ackRetryDelay: AUTO_ACK_RETRY_MS,
      ackRetryTimer: undefined,
      windowStart: Number(descriptor.checkpoint.cursor.seq),
      // A fresh window: nothing has been dropped from it, so the baseline is a
      // position this layer may serve (issue #2).
      evicted: false,
      waiters: [],
      projection: [...items],
    })
    // INFO (spec §5 「订阅恢复」): recovered via the checkpoint chain — the path
    // that only runs when the peer could NOT replay, so it is worth seeing.
    console.info(
      `[cherry-remote] subscription recovered for session ${sessionId} from checkpoint ` +
        `${descriptor.checkpoint.checkpointId} (baseline seq ${descriptor.checkpoint.cursor.seq}, ` +
        `${items.length} projection item(s))`,
    )
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
      // caller is about to establish a replacement either way. ONE bounded
      // STRING (issue #161): the refusal is the PEER's JSON-RPC
      // `error.message` verbatim, so the old object print let the console
      // render peer text with no local bound. Ceiling:
      // `[cherry-remote] closing subscription ` (37) + subscriptionId +
      // ` failed: ` (9) + LOG_TEXT_MAX (240).
      console.warn(
        `[cherry-remote] closing subscription ${subscriptionId} failed: ${failureText(error)}`,
      )
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
      if (sessionId === protectedSessionId) continue
      // 「丢最旧并记录」: the eviction is logged, never silent.
      console.warn(
        `[cherry-remote] subscription limit (${this.#limit}) reached; evicting least-recently-used session ` +
          `${sessionId}`,
      )
      // The entry is removed outright, so no `live` flag needs clearing.
      this.#cancelAckRetry(state)
      this.#rejectWaiters(state, new Error(`session ${sessionId} evicted by LRU`))
      this.#sessions.delete(sessionId)
      // AWAITED: the peer must observe the close before the next subscribe.
      await this.#closeSubscription(state.subscriptionId)
      return true
    }
    return false
  }

  /** Live (peer-backed) subscription count — every entry is live. */
  #liveCount(): number {
    return this.#sessions.size
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /**
   * `agent.events`: append to the session buffer, enforce the byte budget by
   * dropping the OLDEST events (logged, and never the last remaining one — see
   * `#trimToBudget`'s floor, issue #221), advance the cursor, then wake
   * waiters.
   *
   * SEQ MONOTONICITY IS ENFORCED HERE, per (sessionId, streamEpoch). The peer is
   * supposed to deliver each stream position exactly once and in order, and the
   * layer's whole contract — `nextCursor`, `windowStart`, the waiter predicate —
   * is expressed in terms of a cursor that only ever moves FORWARD. A duplicate
   * or out-of-order batch (a replay race across a reconnect, a peer retry)
   * would otherwise:
   *
   *  - move `state.cursor` BACKWARDS, so `read()`'s `nextCursor` regresses and a
   *    caller resuming from it re-consumes events it already acked;
   *  - append an event the caller has already seen, duplicating history;
   *  - `#wakeWaiters` for a "new" event that is not new, so a parked waiter
   *    re-judges state the caller has already processed.
   *
   * A NON-INCREASING seq is therefore refused with a warning (never silently),
   * and — importantly — a batch that is wholly stale does not wake anyone. A
   * batch that arrives with a mix is filtered event by event, so genuine
   * progress inside the same notification is never lost. `windowStart` is not
   * touched either: the position an event occupied is not being un-retained.
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
    // A MISSING epoch is the peer's older shape and is tolerated (the check
    // below simply has nothing to compare against). A PRESENT but non-string
    // epoch is a different thing entirely: it is a value this layer cannot
    // compare, and letting it through would silently treat the batch as
    // belonging to the CURRENT stream — which is exactly the assumption the
    // epoch exists to prevent. The peer is saying "this came from an epoch",
    // and this layer cannot tell WHICH, so the batch is refused with a warning
    // rather than folded into a stream it may not belong to.
    if (streamEpoch !== undefined && typeof streamEpoch !== 'string') {
      console.warn(
        `[cherry-remote] ignoring agent.events for session ${sessionId}: stream epoch is ` +
          `${JSON.stringify(streamEpoch)} (${typeof streamEpoch}), not a string; refusing to treat a ` +
          'malformed epoch as the current one',
      )
      return
    }
    if (typeof streamEpoch === 'string' && streamEpoch !== state.cursor.streamEpoch) {
      console.warn(
        `[cherry-remote] ignoring agent.events for session ${sessionId}: stream epoch ${streamEpoch} ` +
          `does not match ${state.cursor.streamEpoch}`,
      )
      return
    }

    let appended = 0
    for (const raw of events) {
      if (!isRecord(raw)) continue
      const seq = String(raw['seq'] ?? '')
      if (seq === '') continue
      // The monotonicity gate: strictly greater than the cursor, or refused.
      // The comparison is NUMERIC — the protocol carries `seq` as a decimal
      // string, and a lexicographic compare would call '9' > '10'.
      const arrived = Number(seq)
      const current = Number(state.cursor.seq)
      if (!Number.isFinite(arrived) || (Number.isFinite(current) && arrived <= current)) {
        console.warn(
          `[cherry-remote] ignoring out-of-order agent.events for session ${sessionId}: seq ${seq} is ` +
            `not newer than the stream cursor ${state.cursor.seq}; the session cursor never regresses`,
        )
        continue
      }
      const cursor: AgentCursor = { sessionId, streamEpoch: state.cursor.streamEpoch, seq }
      const event = raw as unknown as AgentEvent
      const bytes = eventBytes(event)
      state.buffer.push({ cursor, event, bytes })
      state.bytes += bytes
      state.bytesSinceAck += bytes
      state.deliveredBytes += bytes
      state.cursor = cursor
      appended += 1
    }

    this.#trimToBudget(sessionId, state)
    // Waking on a wholly stale batch would make a parked waiter re-judge state
    // that has not moved; only real progress is a wake.
    if (appended > 0) this.#wakeWaiters(state)
    // The wake comes FIRST: a waiter that can settle from what just arrived
    // must not wait behind an ack round trip.
    if (appended > 0) this.#maybeAutoAck(sessionId, state)
  }

  /**
   * Sends `agent.subscriptions.ack` once the un-acked bytes approach the peer's
   * window, so the peer keeps delivering (issue #212).
   *
   * WHAT IS BEING ACKED is "everything in this layer's buffer", not "everything
   * a caller has consumed". That is safe against the pinned peer because an ack
   * does exactly one thing: it frees FLOW CONTROL — the desktop decrements its
   * un-acked budget and advances `lastAck` (`agentSubscriptions.ts`). Replay
   * retention lives on the journal (`replayBytes`/`replayMs`) and is not
   * touched by an ack, so a `read`/`cherry_events`/re-subscribe from a cursor
   * below the acked position is still served — by the local buffer here and by
   * the journal there. The ack's own doc comment states the same contract.
   *
   * The ack is fire-and-forget with its failure SURFACED (a refused ack must be
   * visible, not swallowed). A refusal also ARMS A TIMER: once the peer is
   * holding at its window no further event arrives, so a retry that waited for
   * traffic would never fire and the wait would time out exactly as in issue
   * #212.
   */
  #maybeAutoAck(sessionId: string, state: SessionState): void {
    if (state.bytesSinceAck < this.#ackWatermark()) return
    if (state.ackInFlight) return
    if (Date.now() < state.ackRetryAt) return
    state.ackInFlight = true
    void this.ack(sessionId)
      .then(() => {
        // The BYTE ledger moved inside `ack()` itself — one place for remarks
        // and explicit acks alike — so only the retry state is the auto-ack's.
        // A peer that answers ack again gets prompt retries next time.
        state.ackRetryDelay = AUTO_ACK_RETRY_MS
      })
      .catch((error: unknown) => {
        // THIS attempt's delay, then the next one doubles: a peer that refuses
        // every ack (a wedged controller, a link about to drop) must not log a
        // line every few seconds for the life of the layer.
        const delay = state.ackRetryDelay
        state.ackRetryAt = Date.now() + delay
        state.ackRetryDelay = Math.min(delay * 2, AUTO_ACK_RETRY_MAX_MS)
        console.warn(`[cherry-remote] auto-ack for session ${sessionId} failed: ${failureText(error)}`)
        // ARMED HERE, not on the next batch: a peer holding at its window sends
        // nothing more, so traffic-driven retry is no retry at all.
        this.#armAckRetry(sessionId, state, delay)
      })
      .finally(() => {
        state.ackInFlight = false
        // RE-JUDGE: batches can arrive WHILE the ack was in flight (the peer
        // flushes on the ack, so this is the common case), and those batches
        // were refused a trigger by `ackInFlight`. Without this second look the
        // layer could sit with bytes over the watermark and no event left to
        // trigger it — the peer holding, exactly as in issue #212.
        if (this.#closed || this.#sessions.get(sessionId) !== state) return
        this.#maybeAutoAck(sessionId, state)
      })
  }

  /**
   * Quarter of the peer's window, read from the CURRENT source so a layer that
   * outlives a reconnect follows the new hello instead of its first answer.
   * Falls back to the pinned protocol constant when nothing is advertised.
   */
  #ackWatermark(): number {
    const source = this.#unackedSource
    const advertised = typeof source === 'function' ? source() : source
    return Math.max(1, Math.floor(positive(advertised, remoteLimits.unackedBytes) / 4))
  }

  /** Disarms the retry, if any (idempotent; safe on a state being replaced). */
  #cancelAckRetry(state: SessionState): void {
    if (state.ackRetryTimer === undefined) return
    clearTimeout(state.ackRetryTimer)
    state.ackRetryTimer = undefined
  }

  /**
   * One timer-driven retry after a refused ack. At most one is armed per
   * session; it no-ops when the state it was armed for is no longer current
   * (a re-subscribe, a checkpoint recovery or `dispose`).
   */
  #armAckRetry(sessionId: string, state: SessionState, delayMs: number): void {
    if (this.#closed) return
    if (state.ackRetryTimer !== undefined) return
    const timer = setTimeout(() => {
      state.ackRetryTimer = undefined
      if (this.#closed || this.#sessions.get(sessionId) !== state) return
      // CLEARED HERE, not left to the wall clock: a clock stepped backwards
      // would otherwise make `#maybeAutoAck` return early and arm nothing — a
      // retry silently lost while the peer holds, which is #212 again.
      state.ackRetryAt = 0
      this.#maybeAutoAck(sessionId, state)
    }, delayMs)
    // Never hold the process open on a retry that is only about flow control.
    timer.unref?.()
    state.ackRetryTimer = timer
  }

  /**
   * `agent.subscriptions.resetRequired`: the peer tore the subscription down
   * (replay suffix lost, checkpoint lease lapsed, ...). The session is dropped
   * entirely — there is nothing to reuse, so the caller's next `ensure` must
   * rebuild it from a FRESH subscribe (and, cursorless, will land in checkpoint
   * mode). ⑤ pins this behaviour as intended.
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
      this.#cancelAckRetry(state)
      this.#rejectWaiters(state, new Error(`session ${sessionId} reset by the peer`))
      this.#sessions.delete(sessionId)
      return
    }
  }

  /**
   * Drops the OLDEST buffered events until the session fits its byte budget.
   *
   * The loop stops at ONE remaining event (issue #221): the budget governs the
   * window's TAIL, never its head. A single event above the budget — only
   * reachable when `perSessionCacheBytes` is set below one record's size, since
   * the transport caps a record at 65,536 bytes — used to be evicted too,
   * leaving an EMPTY window whose `windowStart` had advanced past it: the event
   * that just happened, the one thing a reader wants, became unreachable and
   * every read from the baseline answered `cursor-out-of-window` about content
   * this layer had held a moment earlier. Keeping it is also the honest
   * reading of `evicted`: nothing was discarded, so the baseline stays a
   * servable resume point.
   */
  #trimToBudget(sessionId: string, state: SessionState): void {
    if (state.bytes <= this.#perSessionCacheBytes) return
    let dropped = 0
    while (state.bytes > this.#perSessionCacheBytes && state.buffer.length > 1) {
      const removed = state.buffer.shift()!
      state.bytes -= removed.bytes
      dropped += 1
      // The window start advances past every dropped event: a caller parked at
      // or before it can no longer be served and must rebuild a baseline. The
      // flag is what distinguishes this boundary from the subscription's
      // baseline, which stays servable (see `read`).
      state.windowStart = Math.max(state.windowStart, Number(removed.cursor.seq))
      state.evicted = true
    }
    if (dropped === 0) return
    // Only a REAL drop is logged: an over-budget window holding one event has
    // discarded nothing, and "dropped 0 oldest event(s)" would send an operator
    // looking for a gap that does not exist.
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
