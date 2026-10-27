import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { connectSecureChannel, RemoteSocketStream } from '@cherrystudio/remote-transport'
import type { ChannelOptions, SecureChannel } from '@cherrystudio/remote-transport'
import { directEndpointUrl } from '@cherrystudio/remote-protocol'
import { isChannelClosedError, JsonRpcClient, JsonRpcRequestError } from './rpc/jsonRpcClient.js'
import type { JsonRpcRequestOptions } from './rpc/jsonRpcClient.js'
import { toRemoteSocket } from './rpc/wsAdapter.js'
import { digestIdentity } from './diagnostics.js'
import {
  DEFAULT_CONTENT_READ_BUDGET_PER_SECOND,
  DEFAULT_RATE_BUDGET_PER_SECOND,
  DEFAULT_TRANSPORT_RETRY_WAIT_MS,
  RATE_LIMIT_MAX_WAIT_MS,
} from './defaults.js'
import type { DeviceRecord } from './deviceStore.js'
import { clipText, LOG_TEXT_MAX } from './text.js'

/**
 * Per-device persistent connection: the M1 capstone that owns the WebSocket,
 * the Noise-XX SecureChannel, the handshake (hello → authenticate), the
 * heartbeat/refresh housekeeping, and the reconnect backoff. Business tools
 * (Tasks 8-10) call through {@link DeviceConnection.rpc}; the pool (Task 10)
 * assembles one instance per paired record.
 */

export type DeviceState = 'connected' | 'connecting' | 'offline' | 'disabled' | 'identity-mismatch'

/**
 * Effective (fallback-applied) limits: hello-reported values when the peer
 * supplies them, conservative defaults otherwise. Task 8 consumes `pageItems`,
 * Task 10 consumes `subscriptions`.
 */
export interface EffectiveLimits {
  heartbeatMs: number
  subscriptions: number
  pageItems: number
  inFlightRequests: number
  /**
   * The peer's hello-advertised `agentMessageSummariesVersion` (issue #105),
   * stored BESIDE the limits because it is re-read by that same handshake.
   *
   * ABSENT, never defaulted: through desktop 2.1.7 the field does not exist,
   * and 0.5.0's `agent.messages.list` params are a STRICT object with no
   * `partsMode` — sending it to such a peer is a protocol violation, so absence
   * has to be distinguishable from every number. `1` (2.1.8, where
   * `RemoteConnection.ts:69` sets it unconditionally) is the only version that
   * means "the summary arm is available"; any other number is stored verbatim
   * and read as not-yet-known, because a version this client cannot speak is
   * not evidence that it speaks 1.
   *
   * Re-read on EVERY hello, so a desktop upgraded between two handshakes is
   * picked up on the reconnect that follows.
   */
  messageSummaries?: number
}

/**
 * Options handed to every `WebSocket` dial (issue #126).
 *
 * FLAT `tls.connect` options — `ws` forwards its own option bag straight to
 * `tls.connect`, so `{ rejectUnauthorized: false }` or `{ ca: <pem> }` belong
 * at the top level rather than under a `tls:` key.
 */
export type WsDialOptions = { rejectUnauthorized?: boolean; ca?: string | Buffer | Array<string | Buffer> }

export interface DeviceConnectionOptions {
  /** Local Ed25519 device identity (raw protobuf private key bytes). */
  identity: Uint8Array
  /**
   * The paired device record; `hosts`/`security`/`ports`/`port` are re-read on
   * every attempt. `security` and `ports` are REQUIRED by schemaVersion 4 (the
   * v2→v3 and v3→v4 migrations backfill them), so the `?.` in the STEADY-STATE
   * dial guards an in-memory record assembled without the map (or constructed
   * before validation), not a migrated one. That dial — this class — consumes
   * both per-host maps; the pairing dial never reads the record (it dials the
   * QR candidate's own host/port/scheme, which is why the record can persist
   * them). Each host dials with its OWN port; the record-level `port` is the
   * winner's at pairing, the operator's after a PATCH, and always the fallback.
   */
  record: DeviceRecord
  /**
   * Options for every dial's `WebSocket` (issue #126) — in practice
   * `rejectUnauthorized`/`ca`, for a desktop behind a TLS proxy whose
   * certificate is not in Node's default trust store. The assembly injects it
   * from plugin config `wsTls` at BOTH dial sites (the pool and pairing); tests
   * may still pass it directly. Absent means Node's defaults. NEVER derived
   * from the record: trust is a grant the OPERATOR makes, not a fact the
   * desktop asserts about itself.
   */
  wsOptions?: WsDialOptions
  /**
   * Second-level smoothed request budget for business RPCs on the SHARED tier
   * — every business RPC except `agent.content.read`, which has its own tier
   * (`DEFAULT_CONTENT_READ_BUDGET_PER_SECOND`). Default 32, injected by the
   * assembly from plugin config (Task 10 wires the cordis default key).
   * Per-connection only: the peer's rate window is per-socket, so a per-device
   * budget satisfies it with no cross-device scheduling.
   *
   * The content tier DERIVES from this value at the production ratio
   * (DEFAULT_CONTENT_READ_BUDGET_PER_SECOND / DEFAULT_RATE_BUDGET_PER_SECOND,
   * i.e. 8 : 1), so LOWERING this lowers both tiers. That ratio matches the
   * <=2.1.6 allowances (512:64) and is where the 2.1.7 story used to be
   * conservative — but only the shared line moved (256 in 2.1.7), so the derived
   * tier is CLAMPED at the peer's 512/s content allowance
   * (`contentBudgetFor`, issue #111): above a shared budget of 64 the knob stops
   * scaling it instead of deriving 2,048/s from 2.1.7's shared figure and
   * spending the tier being refused.
   */
  rateBudgetPerSecond?: number
  /** First reconnect backoff (default 1s); doubles per attempt. */
  backoffInitialMs?: number
  /** Backoff ceiling (default 60s, per spec §3.4). */
  backoffMaxMs?: number
  /** Token-refresh grace window (default 30s, the protocol refreshGraceMs). */
  refreshGraceMs?: number
  /** Per-host TCP/WS connect timeout (default 10s). */
  connectTimeoutMs?: number
  /** Per-RPC timeout handed to JsonRpcClient (default: the client's 60s, the protocol's idleMs). */
  rpcTimeoutMs?: number
  /** Versions offered in the Noise prelude AND echoed in hello (default [1]). */
  protocolVersions?: readonly number[]
  /**
   * TEST INJECTION ONLY: makes the hello echo differ from the prelude offer,
   * simulating receipt inconsistency so the peer's INVALID_CONNECTION_STATE
   * face can be exercised. Never set in production wiring.
   */
  helloProtocolVersions?: readonly number[]
  /**
   * How long one READ may wait for the reconnected link before it gives up and
   * surfaces the transport loss (default 5s).
   *
   * The field report's reads (large `cherry_read`s) die because a page response
   * outgrew the wire and the peer terminated the session; the reconnect lands
   * seconds later and the retry succeeds. The wait is bounded because the
   * caller is holding a tool call: past this window the honest answer is "the
   * link was lost, retry" rather than a call that waits for the backoff loop
   * (up to 60s per attempt) to find the desktop again.
   */
  transportRetryWaitMs?: number
}

/**
 * The transport call the dial hands a socket to (see
 * {@link DeviceConnection}'s channel accessor). An exported SYMBOL rather than a
 * `#`-name: `#` members are invisible to reflection by design, and issue #28's
 * client-side write failure can be injected nowhere the dial can be observed —
 * the transport captures its own write sink at construction, so a test needs
 * this one seam, and a symbol is the narrowest one that can be found.
 */
export const CHANNEL_SEAM: unique symbol = Symbol('dsh-cherry-bridge.channel')

/**
 * The structured §6 "设备离线" error: tool calls against a non-connected
 * device fail fast with `{device, state}` and never implicitly reconnect.
 */
export class DeviceUnavailableError extends Error {
  readonly device: string
  readonly state: DeviceState

  constructor(device: string, state: DeviceState) {
    super(`device ${device} is ${state}`)
    this.name = 'DeviceUnavailableError'
    this.device = device
    this.state = state
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * The link died UNDER an in-flight request: the request reached the wire and
 * its answer was lost. Distinct from {@link DeviceUnavailableError}, which is a
 * fail-fast about a device that was already not connected — the difference a
 * caller acts on is that this one MAY be retried.
 */
export class TransportLostError extends Error {
  readonly device: string
  readonly state: DeviceState
  readonly method: string
  /** Always true: the peer never gave this request a verdict. */
  readonly retryable = true

  constructor(device: string, state: DeviceState, method: string, options?: ErrorOptions) {
    super(
      `device ${device}: transport lost while "${method}" was in flight (request may be retried)`,
      options,
    )
    this.name = 'TransportLostError'
    this.device = device
    this.state = state
    this.method = method
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * The caller's DEADLINE ran out while a read was being recovered (issue #21).
 *
 * Distinct from {@link TransportLostError}, which says "the link died and I ran
 * out of patience for a reconnect". This one says something the caller already
 * knows but must be able to act on: the answer's own time budget is spent, so
 * no further attempt is worth making. A deadline-bounded walk treats it as a
 * STOP (return what has been read), while a mere link loss is a failure — and
 * the two must not be confused, because only one of them has content behind it.
 *
 * It is NOT `DeviceUnavailableError` either: the device may be perfectly well
 * and the budget may have expired in pacing or in a slow peer.
 */
export class RpcDeadlineExceededError extends Error {
  readonly device: string
  readonly method: string

  constructor(device: string, method: string) {
    super(`device ${device}: the request deadline passed before "${method}" could be attempted again`)
    this.name = 'RpcDeadlineExceededError'
    this.device = device
    this.method = method
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * WHY a parked replay wait ended (issue #21).
 *
 * Its own type because the caller must not have to INFER the cause: before this
 * the wait resolved `undefined` for all three outcomes and `#businessRequest`
 * told "the caller's deadline" apart from "the reconnect allowance" by comparing
 * `performance.now()` with the deadline afterwards — a race, because a timer may
 * fire a millisecond EARLY, and a full-suite run duly produced a
 * `TransportLostError` where the deadline had actually ended the wait. The
 * discriminator is now a FACT the wait reports, on the same principle as
 * `RequestTimeoutError.clampedByDeadline`.
 */
type ReplayWait =
  | { kind: 'connected'; client: JsonRpcClient; epoch: number }
  /** The wait's own bound elapsed (the deadline-capped `waitMs`). */
  | { kind: 'expired' }
  /** The lifecycle moved on — a shutdown, a disabled or identity-mismatched device. */
  | { kind: 'abandoned' }

// ---------------------------------------------------------------------------
// Defaults (spec §3.4 and controller rulings; values are contractual).
// ---------------------------------------------------------------------------

/**
 * CEILING for the business-request window — not the window itself. The window
 * is owned by the rpc layer and is sized from the peer's hello-reported
 * `inFlightRequests` (spec §3.4「取回报一半」): see
 * {@link businessWindowFor}. The ceiling binds only when HALF the peer's report
 * exceeds it — a peer reporting 64 gets 8, not 32.
 *
 * The FALLBACK is a DIFFERENT path and does not land on this number. When the
 * peer's hello says nothing about `inFlightRequests`, {@link FALLBACK_LIMITS}
 * supplies 8, and `#handshake` then runs that through the same half-the-report
 * rule as any other report: `floor(8 / 2)` = 4. So a silent peer gets a
 * business window of 4 — deliberately the CONSERVATIVE reading, since the whole
 * point of the halving is to stay inside an allowance the peer never confirmed.
 * The client is constructed at 8 only for the window before hello answers.
 */
const BUSINESS_MAX_IN_FLIGHT = 8
const FALLBACK_LIMITS: EffectiveLimits = {
  heartbeatMs: 20_000,
  subscriptions: 8,
  pageItems: 100,
  inFlightRequests: 8,
}
const DEFAULT_BACKOFF_INITIAL_MS = 1_000
const DEFAULT_BACKOFF_MAX_MS = 60_000
const DEFAULT_REFRESH_GRACE_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_PROTOCOL_VERSIONS: readonly number[] = [1]
/** Ping-silence multiplier: 2×heartbeatMs without a pong judges the line dead. */
const SILENCE_FACTOR = 2
const RATE_WINDOW_MS = 1_000
/**
 * Safety margin added to the rate window. The client paces ADMISSIONS, but
 * the peer counts ARRIVALS; queue drain and event-loop stalls can compress
 * the two apart, so the pacing gap carries margin on top of window/budget.
 */
const RATE_WINDOW_MARGIN_MS = 150
/** The deliberate local-shutdown face of a disposed client (see the replay path). */
const DISPOSED_RE = /^JSON-RPC client disposed$/

/**
 * The peer's structured over-budget refusal (desktop >= 2.1.7), or undefined.
 *
 * 2.1.7 answers an over-budget request with ONE `RATE_LIMITED` failure carrying
 * `retryAfterMs` and keeps the session; <=2.1.6 instead closed the whole socket
 * with 1011, which is the transport-loss path and never reaches this check.
 */
function rateLimitRefusal(error: unknown): JsonRpcRequestError | undefined {
  if (!(error instanceof JsonRpcRequestError)) return undefined
  const data = error.data
  if (typeof data !== 'object' || data === null) return undefined
  return (data as Record<string, unknown>)['reason'] === 'RATE_LIMITED' ? error : undefined
}

/**
 * How long a refusal asks the caller to wait, bounded by
 * {@link RATE_LIMIT_MAX_WAIT_MS}. An absent or unusable value is 0: retry at
 * the next pacing slot rather than invent a delay the peer never asked for.
 */
function rateLimitWaitMs(refusal: JsonRpcRequestError): number {
  const raw = (refusal.data as Record<string, unknown>)['retryAfterMs']
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0
  return Math.min(raw, RATE_LIMIT_MAX_WAIT_MS)
}
/**
 * The read methods whose transport loss may be replayed automatically.
 *
 * Two entries are DEAD today and are kept deliberately, so a future call site
 * is covered the day it appears rather than silently un-retried:
 *
 *  - `connection.ping` — production housekeeping goes through `#houseCall`
 *    straight to the link's client and never passes through this facade, so
 *    no production ping can reach the replay path.
 *  - `agent.interactions.get` — this plugin has no call site for it.
 *
 * A third entry can look equally dead from here and is NOT:
 * `agent.checkpoints.read` is reached through the subscription layer
 * (`sessionSubscriptions.#walkCheckpoints`), so it is a live read and its
 * presence in this set is what makes a mid-flight loss on it recoverable.
 *
 * Reads are safe to replay by construction: the peer answers from stored
 * revisions and the call has no side effect, so a second copy costs one round
 * trip and nothing else. A COMMAND is the opposite — `agent.messages.send`,
 * `agent.interactions.respond`, `agent.executions.cancel` — and replaying one
 * after a lost answer could double-apply a write whose outcome the peer already
 * committed. Admissibility is NOT a property this layer can infer from a method
 * name, so it is stated here once and everything absent is treated as a command.
 *
 * NEW READS MUST BE ADDED HERE: a read left out is simply not retried, which is
 * the safe failure, but it gives up the recovery this list exists for.
 */
const RETRYABLE_READ_METHODS: ReadonlySet<string> = new Set([
  'connection.ping',
  'agent.agents.list',
  'agent.workspaces.list',
  'agent.sessions.list',
  'agent.sessions.get',
  'agent.messages.list',
  'agent.parts.list',
  'agent.interactions.list',
  'agent.interactions.get',
  'agent.content.read',
  'agent.checkpoints.read',
])

/**
 * Second-level rate smoothing for business requests: admissions are paced at
 * least `(window+margin)/budget` ms apart, so any 1-second window — measured
 * on the client's admission times OR the peer's (compressed) arrival times —
 * observes at most floor(window/minGap)+1 ≤ budget requests. This is rate
 * shaping ONLY — the in-flight concurrency cap belongs to JsonRpcClient.
 *
 * One instance is one TIER (see {@link RateTier}); a connection holds one per
 * tier, so a burst on one tier neither spends nor delays another's admissions.
 */
class SecondWindowRateLimiter {
  readonly #admitted: number[] = []
  readonly #minGapMs: number

  constructor(readonly budgetPerSecond: number) {
    // The quotient is CEILED, the conservative direction: the gap is at least
    // the exact window/budget spacing, so the window can never see MORE than
    // `budgetPerSecond` admissions. The cost is that the ACHIEVED rate sits
    // below the nominal one whenever the gap does not divide 1,150ms evenly —
    // which is both configured tiers: 32/s → 36ms → ≈27.8/s, and 256/s → 5ms
    // → exactly 200/s (the nominal 4.49ms would need a sub-millisecond timer).
    // So the content tier trades ~22% of its NOMINAL rate for a gap the timer
    // can honour; the direction is conservative and never exceeds the budget.
    this.#minGapMs = Math.ceil((RATE_WINDOW_MS + RATE_WINDOW_MARGIN_MS) / Math.max(budgetPerSecond, 1))
  }

  async acquire(): Promise<void> {
    // Paced through this tier's own FIFO, so two callers that wake together
    // cannot both claim the one admission that just became due: every waiter is
    // released strictly after the one before it reached the head.
    let release!: () => void
    const ahead = this.#queue
    this.#queue = ahead.then(() => new Promise<void>((resolve) => (release = resolve)))
    await ahead
    try {
      for (;;) {
        const now = Date.now()
        // Evict entries too old to matter for pacing state.
        while (
          this.#admitted.length > 0 &&
          now - this.#admitted[0]! >= RATE_WINDOW_MS + RATE_WINDOW_MARGIN_MS
        ) {
          this.#admitted.shift()
        }
        const last = this.#admitted[this.#admitted.length - 1]
        if (last === undefined || now - last >= this.#minGapMs) {
          this.#admitted.push(now)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, this.#minGapMs - (now - last) + 1))
      }
    } finally {
      release()
    }
  }

  /** This tier's wait queue (see `acquire`). */
  #queue: Promise<void> = Promise.resolve()
}

/**
 * The two independent admission tiers every business RPC is paced against.
 *
 *  - `shared` — every business RPC that is not a content read
 *    ({@link DEFAULT_RATE_BUDGET_PER_SECOND}, injected through plugin config).
 *  - `content` — `agent.content.read` alone
 *    ({@link DEFAULT_CONTENT_READ_BUDGET_PER_SECOND}).
 *
 * WHY TWO TIERS: the desktop paces the two against different allowances (512/s
 * for content reads; 64/s for everything else through 2.1.6 and 256/s from
 * 2.1.7) and the official client follows suit (480/s and 40/s). Sharing one
 * 32/s tier spent content-read throughput on
 * unrelated RPCs and vice versa: a multi-slice walk of an externalized part —
 * every part over 4,096 characters on Cherry >= 2.1.6 — queued behind list
 * calls at ~36ms per slice.
 */
type RateTier = 'shared' | 'content'

/**
 * Which tier paces `method`. The rule is EXACT-MATCH: `agent.content.read` is
 * the only method on the content tier, and every other method — a command, a
 * list read, a different `agent.*.read` — keeps the shared tier. A prefix or
 * suffix match would silently widen the content tier to methods whose peer-side
 * allowance is the shared one — 64/s through 2.1.6, where exceeding it closes
 * the SESSION (1011) — so a new content-plane method must be named deliberately.
 */
function classifyRateTier(method: string): RateTier {
  return method === 'agent.content.read' ? 'content' : 'shared'
}

/**
 * The reconnect wait one read is granted, and whether the CALLER's deadline is
 * what shortens it (issue #21).
 *
 * Returned together, from the RAW remaining time, because the two answers must
 * not be re-derived from the timer value: the wait is CEILED for `setTimeout`
 * (which truncates a fractional delay, and a budget-capped wait firing a
 * millisecond early would report the deadline as expired sub-ms before it is).
 * A raw remaining of 4,999.4 ms against a 5,000 ms allowance therefore yields a
 * 5,000 ms wait — EQUAL to the allowance, yet the deadline was the shorter
 * bound. Deciding `deadlineCapped` from the ceiled wait would report a spent
 * budget as a plain transport loss, and a wait answer converts only the
 * deadline class into the graceful stop that keeps its partial content.
 *
 * A wait is never zero: the caller refuses a spent deadline before this, and
 * `setTimeout` treats anything below 1 ms as "as soon as possible".
 */
export function reconnectWait(
  remainingMs: number | undefined,
  allowanceMs: number,
): { waitMs: number; deadlineCapped: boolean } {
  if (remainingMs === undefined || remainingMs >= allowanceMs) {
    return { waitMs: allowanceMs, deadlineCapped: false }
  }
  return { waitMs: Math.min(allowanceMs, Math.max(1, Math.ceil(remainingMs))), deadlineCapped: true }
}

/**
 * The connection's two pacing tiers: an admission is taken from the tier its
 * `method` classifies to (see {@link classifyRateTier}), never from a shared
 * pool, so neither tier's burst spends or delays the other's.
 */
class TieredRateLimiter {
  readonly #tiers: Readonly<Record<RateTier, SecondWindowRateLimiter>>

  constructor(sharedBudgetPerSecond: number, contentBudgetPerSecond: number) {
    this.#tiers = {
      shared: new SecondWindowRateLimiter(sharedBudgetPerSecond),
      content: new SecondWindowRateLimiter(contentBudgetPerSecond),
    }
  }

  /** Waits for one admission on the tier `method` classifies to. */
  acquire(method: string): Promise<void> {
    return this.#tiers[classifyRateTier(method)].acquire()
  }
}

// ---------------------------------------------------------------------------
// Silent libp2p logger plumbing (types derived from exported transport
// symbols; no direct @libp2p/* import in production code).
// ---------------------------------------------------------------------------

type TransportLogger = ConstructorParameters<typeof RemoteSocketStream>[1]
type TransportComponentLogger = ChannelOptions['logger']
const noop = (): void => {}

function makeSilentLogger(): TransportLogger {
  const log = (): void => {}
  log.error = noop
  log.trace = noop
  log.enabled = false
  log.newScope = () => log
  return log
}

const silentComponentLogger: TransportComponentLogger = { forComponent: () => makeSilentLogger() }

// ---------------------------------------------------------------------------
// Internal sentinel errors: classification currency between #establish and
// the attempt supervisor. Never exported.
// ---------------------------------------------------------------------------

/** Noise reported the peer's static key does not match the pinned identity. */
class IdentityMismatchError extends Error {
  constructor() {
    super('peer static key does not match the pinned desktopIdentity')
  }
}

/** The peer rejected the hello echo with INVALID_CONNECTION_STATE. */
class ProtocolVersionError extends Error {
  constructor(cause: string) {
    super(`protocol version confirmation rejected: ${cause}`)
  }
}

/** authenticate was rejected with GRANT_REVOKED / UNAUTHENTICATED. */
class AuthRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`authenticate rejected with ${reason}`)
  }
}

/** The attempt was cancelled (close() moved the epoch on). */
class CancelledError extends Error {
  constructor() {
    super('connection attempt cancelled')
  }
}

/**
 * Every candidate host failed to dial (distinct from a single host failing
 * while a later one succeeded). Carries the last per-host error as its message
 * so the log still names a concrete socket failure.
 */
class AllHostsUnreachableError extends Error {
  constructor(
    readonly deviceId: string,
    readonly hosts: readonly string[],
    readonly lastError: Error,
  ) {
    super(`all candidate hosts unreachable (last: ${lastError.message})`)
    this.name = 'AllHostsUnreachableError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** True when the attempt failed because NO candidate host could be dialed. */
function isAllHostsUnreachable(error: unknown): error is AllHostsUnreachableError {
  return error instanceof AllHostsUnreachableError
}

/**
 * Whether a failed establishment attempt blames THIS ADDRESS or the PAIRING.
 *
 * The per-host class is the default because the alternative is worse: a stale
 * first address on a multi-homed desktop would otherwise abort the whole pass
 * even though a later candidate would have connected. The terminal faces are
 * named explicitly:
 *
 *  - {@link IdentityMismatchError} — the peer's pinned static key is wrong. That
 *    is about the PAIRING, and the supervisor marks the device
 *    `identity-mismatch`; another address cannot fix it.
 *  - {@link ProtocolVersionError} — the peer refused the version echo. Also the
 *    pairing, not the address.
 *  - {@link AuthRejectedError} — authenticate was refused (GRANT_REVOKED /
 *    UNAUTHENTICATED). Same reasoning.
 *  - {@link CancelledError} — `close()` raced the attempt; the supervisor's epoch
 *    guard handles it, and falling through to another candidate would be wrong.
 */
function isPerHostFailure(error: unknown): boolean {
  return !(
    error instanceof IdentityMismatchError ||
    error instanceof ProtocolVersionError ||
    error instanceof AuthRejectedError ||
    error instanceof CancelledError
  )
}

interface HelloResult {
  protocolVersion?: number
  limits?: Record<string, number>
  heartbeatMs?: number
  /** The paged-message-summaries capability (issue #105), when advertised. */
  agentMessageSummariesVersion?: number
}

interface AuthResult {
  accessToken: string
  expiresAt: string
}

interface RefreshResult {
  accessToken: string
  expiresAt: string
}

function rpcReason(error: unknown): string | undefined {
  if (error instanceof JsonRpcRequestError) {
    const data = error.data as { reason?: unknown } | undefined
    if (data !== null && typeof data === 'object' && typeof data.reason === 'string') return data.reason
  }
  return undefined
}

function isPeerIdentityMismatch(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'UnexpectedPeerError') return true
  return /does not match expected remote identity key/i.test(error.message)
}

/** Parses a positive finite number, or returns undefined for the fallback. */
function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Sizes the business in-flight window from the peer's hello-reported
 * `inFlightRequests`, per spec §3.4「取回报一半」: take HALF the allowance, so
 * the client never saturates the peer's own concurrency budget and leaves room
 * for the peer's other sessions.
 *
 * `BUSINESS_MAX_IN_FLIGHT` is the CEILING on the result, not a floor: a peer
 * reporting 64 gets 8, not 32. The floor is 1, because a report of 1 would
 * otherwise yield `floor(1/2) = 0` — a window that admits nothing and can never
 * be released by anything, i.e. a permanent deadlock rather than a limit.
 */
function businessWindowFor(reportedInFlightRequests: number): number {
  return Math.max(1, Math.min(BUSINESS_MAX_IN_FLIGHT, Math.floor(reportedInFlightRequests / 2)))
}

/**
 * The desktop's content-read allowance: 512/s, and the SAME in both generations
 * (`RemoteAccessService.ts` counts `agent.content.read` on its own counter,
 * 512 in v2.1.6 and v2.1.7 alike; only the shared line moved, 64 ⇒ 256).
 *
 * A CEILING on the derived tier, not a third knob. The 8 : 1 ratio exists so an
 * operator who LOWERS the shared budget lowers both tiers; upward, the ratio
 * would spend headroom the peer does not have — `rateBudgetPerSecond: 256`
 * (2.1.7's SHARED figure, an easy number to copy) derives 2,048/s, which the
 * limiter's 1 ms gap compresses to ~1,000/s against this allowance, so roughly
 * every other content read is refused. On >=2.1.7 each refusal costs up to a
 * second plus one replay and a second refusal fails the whole read; on <=2.1.6
 * an overrun closes the SESSION (1011). Because this line is
 * generation-INDEPENDENT, bounding it needs no generation detection — the one
 * bound in this file that does not.
 *
 * 512 is the ceiling and 333/s is what the limiter then ACHIEVES from it
 * (`(1,000 + 150) / 512` ceils to a 3 ms gap), so the saturated tier still
 * keeps a 1.5x margin on arrival times.
 */
const CONTENT_BUDGET_CEILING_PER_SECOND = 512

/**
 * The content-read tier's budget for a given SHARED budget.
 *
 * ONE injected knob, two tiers: an operator who lowers `rateBudgetPerSecond`
 * lowers both, and the content tier keeps the production proportion between
 * them rather than staying pinned at 256 while the shared tier shrinks. An
 * absent injection is the production default (which yields exactly
 * `DEFAULT_CONTENT_READ_BUDGET_PER_SECOND`).
 *
 * Upward the ratio stops at {@link CONTENT_BUDGET_CEILING_PER_SECOND}: past a
 * shared budget of 64 the derived value would exceed an allowance that never
 * changed, so it is clamped instead of trying to pace past it.
 *
 * Exported for `tests/unit/contentBudgetCeiling.test.ts`, the same reason
 * `reconnectWait` is: the ceiling is a property of this mapping, and asserting
 * it through the limiter's timing would be a slower, flakier version of the
 * same claim.
 */
export function contentBudgetFor(sharedBudgetPerSecond: number | undefined): number {
  const ratio = DEFAULT_CONTENT_READ_BUDGET_PER_SECOND / DEFAULT_RATE_BUDGET_PER_SECOND
  const derived = Math.ceil((sharedBudgetPerSecond ?? DEFAULT_RATE_BUDGET_PER_SECOND) * ratio)
  return Math.min(CONTENT_BUDGET_CEILING_PER_SECOND, derived)
}

function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Background cycles can reject with no awaiting caller; swallow those so
  // they never surface as unhandled rejections.
  promise.catch(noop)
  return { promise, resolve, reject }
}

/**
 * Second-level sliding-window rate shaping reference: the pacing above keeps
 * any peer-observed 1s window at ≤ budget requests (see the limiter's doc);
 * the assertion currency lives in the integration suite, not duplicated here.
 */

interface LiveLink {
  ws: WebSocket
  channel: SecureChannel
  client: JsonRpcClient
  controller: AbortController
  epoch: number
}

type TimerName = 'backoff' | 'heartbeat' | 'refresh' | 'refreshRetry'
type Timer = ReturnType<typeof setTimeout>

/**
 * One supervised connection per paired device.
 *
 * Concurrency ownership: the JsonRpcClient is constructed with
 * maxInFlight 8 and is the ONLY in-flight limiter; this class adds rate
 * smoothing on top and deliberately no second semaphore. Housekeeping RPCs
 * (hello/authenticate/ping/refresh) call the raw client directly — they
 * bypass the rate smoothing but share the in-flight window, which is the
 * documented tradeoff of a single-channel client (see the task report):
 * under a fully saturated business window a ping may queue, bounded by the
 * 2×heartbeatMs silence window (40s default).
 */
export class DeviceConnection {
  readonly record: DeviceRecord
  readonly #identity: Uint8Array
  readonly #limiter: TieredRateLimiter
  readonly #backoffInitialMs: number
  readonly #backoffMaxMs: number
  readonly #refreshGraceMs: number
  readonly #connectTimeoutMs: number
  readonly #rpcTimeoutMs: number | undefined
  readonly #protocolVersions: readonly number[]
  readonly #helloProtocolVersions: readonly number[]
  readonly #transportRetryWaitMs: number
  readonly #stateListeners = new Set<(state: DeviceState) => void>()
  /**
   * Callers parked in {@link waitForSettled}. Separate from the state listeners
   * because their lifetime is ONE wait: a listener stays for the lifecycle, a
   * settle waiter removes itself the moment it is answered (or times out), and
   * mixing them would leave every answered wait in the multicast set.
   */
  readonly #settleWaiters = new Set<(state: DeviceState) => void>()
  /**
   * Waits parked inside `#awaitReconnect`. close() drains them: a shutdown has
   * no reconnect to wait for, and — the case that matters — a close() followed
   * by a fresh connect() must not let an OLD lifecycle's replay ride the new
   * one. close() may fire NO state transition at all (setting 'offline' when
   * the state is already 'offline' is a no-op), so the listeners alone cannot
   * be relied on to notice.
   */
  readonly #replayWaiters = new Set<(outcome: ReplayWait) => void>()
  /** Notification handlers, re-attached to every new client after a reconnect. */
  readonly #notificationHandlers = new Set<(method: string, params: unknown) => void>()
  /**
   * Subset of {@link #notificationHandlers} already attached to the CURRENT
   * live client's listener list. Cleared whenever the link is torn down, since
   * the next client starts with no listeners of its own.
   */
  readonly #attachedHandlers = new Set<(method: string, params: unknown) => void>()
  readonly #timers = new Map<TimerName, Timer>()
  /**
   * The transport call the dial hands a socket to.
   *
   * A named accessor, not a bare module import, for the same reason
   * `#houseCall` exists: the connect function is the ONE place the connection
   * decides how a link is turned into a channel, and naming it makes that
   * decision observable from a test (issue #28's client-side write failure can
   * be injected nowhere else, since the `#`-private dial is not addressable and
   * the transport captures its own write sink at construction).
   */
  readonly [CHANNEL_SEAM] = { connectSecureChannel }

  #state: DeviceState = 'offline'
  #limits: EffectiveLimits = { ...FALLBACK_LIMITS }
  #running = false
  #epoch = 0
  #attempt = 0
  #cycle = defer<void>()
  #link: LiveLink | undefined
  #refreshFirstFailureAt: number | undefined
  #pendingPings = new Set<{ nonce: string; sentAt: number }>()
  #token: string | undefined
  #tokenExpiresAt: number | undefined

  readonly #wsOptions: WsDialOptions | undefined

  constructor(opts: DeviceConnectionOptions) {
    this.record = opts.record
    this.#wsOptions = opts.wsOptions
    this.#identity = opts.identity
    this.#limiter = new TieredRateLimiter(
      opts.rateBudgetPerSecond ?? DEFAULT_RATE_BUDGET_PER_SECOND,
      contentBudgetFor(opts.rateBudgetPerSecond),
    )
    this.#backoffInitialMs = opts.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS
    this.#backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS
    this.#refreshGraceMs = opts.refreshGraceMs ?? DEFAULT_REFRESH_GRACE_MS
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.#rpcTimeoutMs = opts.rpcTimeoutMs
    this.#protocolVersions = opts.protocolVersions ?? DEFAULT_PROTOCOL_VERSIONS
    this.#helloProtocolVersions = opts.helloProtocolVersions ?? this.#protocolVersions
    this.#transportRetryWaitMs = opts.transportRetryWaitMs ?? DEFAULT_TRANSPORT_RETRY_WAIT_MS
  }

  /**
   * The business RPC surface: rate-smoothed and gated on `connected`. Typed
   * as JsonRpcClient (a delegating Proxy), so tools call exactly the landed
   * rpc API while the connection owns pacing and the offline fail-fast.
   */
  get rpc(): JsonRpcClient {
    return this.#facade
  }

  /** Effective limits: hello-reported values with conservative fallbacks applied. */
  get limits(): EffectiveLimits {
    return this.#limits
  }

  get state(): DeviceState {
    return this.#state
  }

  /**
   * TEST INJECTION ONLY: overrides the reconnect backoff computation for
   * EVERY attempt until the test clears it (see {@link #backoffDelay}) — a
   * test sequences a fast first reconnect with slow later ones by returning
   * a small value while `attempts` is low and a large one afterwards. Never
   * set in production wiring.
   */
  retryBackoffInitialMs?: () => number

  /**
   * Whether a dialed link is currently committed.
   *
   * Read-only view of state this class already owns, exposed because the
   * `connecting`-with-a-link window is a REAL state a test must be able to
   * target: `#establish` commits `#link` before `#handshake` completes, so
   * "state is connecting" and "no link exists" are different situations with
   * different correct behaviour for a business request.
   */
  get hasLink(): boolean {
    return this.#link !== undefined
  }

  /**
   * Business-facing rpc facade.
   *
   * `dispose` is ALWAYS a local no-op, even when a client is live. Tearing down
   * the live JsonRpcClient through this property would kill the connection's
   * own housekeeping channel (heartbeat/refresh) and leave the supervisor
   * believing it is `connected` with no way to notice — `close()` is the only
   * supported teardown. Everything else is forwarded to the live client.
   *
   * `onNotification` is registry-owned: handlers are remembered for the whole
   * lifecycle and re-attached on every reconnect, and an ALREADY-live client is
   * attached to exactly once per handler.
   */
  readonly #facade: JsonRpcClient = new Proxy({} as JsonRpcClient, {
    get: (_target, prop) => {
      if (prop === 'request') {
        return (method: string, params: unknown, opts?: JsonRpcRequestOptions) =>
          this.#businessRequest(method, params, opts)
      }
      if (prop === 'onNotification') {
        return (handler: (method: string, params: unknown) => void) => {
          this.#notificationHandlers.add(handler)
          // Attach to a live client so registration works immediately, but only
          // ONCE per handler: re-registering the same function must not
          // double-deliver every notification for the current cycle. The
          // registry is a Set, so a re-add is already a no-op there — the
          // listener attach needs its own guard to match.
          //
          // `#attachedHandlers` means "attached to the CURRENT live client", and
          // NOTHING is attached while there is no link — so a handler registered
          // while offline is deliberately NOT marked here. `#handshake` attaches
          // the whole registry to every new client and marks them then, which is
          // what covers the offline registration exactly once. Marking it here
          // instead would make `#handshake` skip it forever.
          const link = this.#link
          if (link === undefined) return
          if (this.#attachedHandlers.has(handler)) return
          link.client.onNotification(handler)
          this.#attachedHandlers.add(handler)
        }
      }
      if (prop === 'dispose') return noop
      const link = this.#link
      if (link === undefined) return undefined
      const value = Reflect.get(link.client, prop)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(link.client) : value
    },
  })

  /**
   * Subscribes to state transitions (fired on change only). The state set is
   * closed: connected | connecting | offline | disabled | identity-mismatch.
   */
  onState(cb: (state: DeviceState) => void): void {
    this.#stateListeners.add(cb)
  }

  /**
   * Waits for an attempt that is ALREADY IN FLIGHT to settle, bounded by
   * `timeoutMs`, and answers with the state it ends on.
   *
   * The only state this waits on is `connecting`: an attempt is running, and
   * its outcome is what the caller asked about. `connected` is answered at
   * once, and so are `offline` (parked in backoff), `disabled` and
   * `identity-mismatch` — no wait can change those, and waiting on them would
   * merely delay the caller's answer by the whole bound. `offline` is the
   * common case for a genuinely powered-off desktop, so it is the one that
   * matters: the tools stay fail-fast there.
   *
   * This NEVER starts an attempt — it observes one the pool already started.
   * That is the line the tool face has always drawn (a tool must not dial); the
   * wait only stops the tool from calling a live dial a failure.
   *
   * The bound expiring is not an error: the current state (`connecting`) is
   * returned, and the caller judges it exactly as it would have without the
   * wait.
   */
  async waitForSettled(timeoutMs: number): Promise<DeviceState> {
    if (this.#state !== 'connecting' || timeoutMs <= 0) return this.#state
    return new Promise<DeviceState>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (state: DeviceState): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        this.#settleWaiters.delete(onState)
        resolve(state)
      }
      // The waiter's own filter: a transition to `offline` IS the attempt
      // settling (failed); only a transition INTO `connecting` is not an
      // answer, and `#setState` never reports a state it is already in.
      const onState = (state: DeviceState): void => {
        if (state !== 'connecting') finish(state)
      }
      timer = setTimeout(() => finish(this.#state), timeoutMs)
      this.#settleWaiters.add(onState)
      // The attempt may have settled between the guard above and the
      // registration; that transition is already gone from the multicast, so
      // it has to be observed by hand.
      if (this.#state !== 'connecting') finish(this.#state)
    })
  }

  /**
   * Starts (or joins) the supervised lifecycle. Resolves once this cycle
   * reaches `connected`; rejects with the cycle's failure. Transient
   * failures keep being retried in the background by the backoff loop even
   * after this promise rejected.
   */
  connect(): Promise<void> {
    if (!this.record.enabled) {
      this.#setState('disabled')
      return Promise.reject(new Error(`device ${this.record.deviceId} is disabled`))
    }
    if (this.#state === 'connected') return Promise.resolve()
    if (!this.#running) {
      this.#running = true
      this.#cycle = defer<void>()
      this.#tryEstablish()
    }
    return this.#cycle.promise
  }

  /** Tears the supervised lifecycle down: timers, channel, client, retries. */
  async close(): Promise<void> {
    this.#running = false
    this.#epoch += 1
    // Abort every parked replay wait first: this is the only reliable signal
    // they get — see #replayWaiters.
    for (const abort of [...this.#replayWaiters]) abort({ kind: 'abandoned' })
    this.#clearAllTimers()
    this.#teardownLink()
    this.#setState('offline')
    // A caller awaiting connect() must never hang on shutdown: settle the
    // cycle explicitly (a no-op if it already settled). The epoch bump above
    // makes the in-flight attempt's handlers return early WITHOUT settling,
    // so this is the only place the pending promise learns about the close.
    this.#cycle.reject(new Error(`device ${this.record.deviceId}: connection closed`))
  }

  // -------------------------------------------------------------------------
  // Supervision
  // -------------------------------------------------------------------------

  #tryEstablish(): void {
    if (!this.#running) return
    const epoch = (this.#epoch += 1)
    this.#attempt += 1
    void this.#establish(epoch).then(
      () => {
        if (epoch !== this.#epoch) return
        this.#attempt = 0
        this.#cycle.resolve()
      },
      (error: unknown) => {
        if (epoch !== this.#epoch) return
        this.#onAttemptFailed(error)
      },
    )
  }

  #onAttemptFailed(error: unknown): void {
    this.#teardownLink()

    if (error instanceof CancelledError) return

    if (error instanceof IdentityMismatchError) {
      this.#running = false
      this.#setState('identity-mismatch')
      // DELIBERATELY not clipped: this message is a COMPILE-TIME LITERAL
      // ("peer static key does not match the pinned desktopIdentity") with no
      // peer bytes in it, so there is nothing here to bound. The other two
      // error lines below interpolate text the peer controls.
      console.error(
        `[cherry-remote] device ${this.record.deviceId}: ${error.message}; ` +
          'marked identity-mismatch and disconnected — re-pair the device',
      )
      this.#cycle.reject(new Error(`device ${this.record.deviceId}: identity mismatch`))
      return
    }

    if (error instanceof ProtocolVersionError) {
      this.#running = false
      this.#setState('offline')
      // BOUNDED (issue #155): the `cause` is the peer's OWN hello-echo text —
      // `ProtocolVersionError` is built from `String(<the peer's RPC failure>)`
      // — so the message can carry up to a whole 64 KiB record of peer text.
      // Ceiling: the fixed prefix (64) + LOG_TEXT_MAX (240, marker included) +
      // the upgrade suffix (37) = 341 characters.
      console.error(
        `[cherry-remote] device ${this.record.deviceId}: protocol version incompatible ` +
          `(${clipText(error.message, LOG_TEXT_MAX)}); upgrade Cherry Studio / the plugin`,
      )
      this.#cycle.reject(new Error(`device ${this.record.deviceId}: protocol version incompatible`))
      return
    }

    if (error instanceof AuthRejectedError) {
      this.#running = false
      this.#setState('offline')
      const hint =
        error.reason === 'GRANT_REVOKED'
          ? 'grant revoked by the desktop — re-pair the device'
          : 'pairing invalid (local identity regenerated or device removed on the peer) — re-pair the device'
      console.error(`[cherry-remote] device ${this.record.deviceId}: ${hint}`)
      this.#cycle.reject(new Error(`device ${this.record.deviceId}: authenticate rejected (${error.reason})`))
      return
    }

    // Transient failure: offline + exponential backoff, capped.
    this.#setState('offline')
    this.#cycle.reject(error instanceof Error ? error : new Error(String(error)))
    this.#cycle = defer<void>()
    if (!this.#running) return
    const delay = this.#backoffDelay()
    // §6 「候选地址全部不可达」: when EVERY candidate host failed, the cause is
    // usually a stale address (DHCP moved the desktop, or it switched network)
    // rather than a transient outage, so the warn carries the actionable hint
    // instead of just the last socket error. The backoff still retries — an
    // address that comes back needs no operator at all.
    const hint =
      isAllHostsUnreachable(error)
        ? ' — all candidate addresses were unreachable; if the desktop moved, update ' +
          'them via the device card 地址维护 (address maintenance)'
        : ''
    const detail = error instanceof Error ? error.message : String(error)
    console.warn(
      `[cherry-remote] device ${this.record.deviceId} offline ` +
        // BOUNDED (issue #155): this text is peer-influenced — an RPC failure
        // carries the peer's own `error.message` verbatim (an authenticate
        // refusal, a hello fault), and a transport error carries the system's.
        // Only the 64 KiB record budget bounded it before. Ceiling: the fixed
        // prefix (41) + LOG_TEXT_MAX (240, marker included) + `); reconnecting
        // in <delay>ms` (26 at the 60,000 ms backoff cap) + the all-hosts hint
        // (125) = 432 characters.
        `(${clipText(detail, LOG_TEXT_MAX)}); reconnecting in ${delay}ms${hint}`,
    )
    this.#setTimer('backoff', setTimeout(() => this.#tryEstablish(), delay))
  }

  #backoffDelay(): number {
    const exponent = Math.min(Math.max(this.#attempt - 1, 0), 30)
    // The nominal first delay, overridable per attempt for tests only.
    const initialMs = this.retryBackoffInitialMs?.() ?? this.#backoffInitialMs
    const capped = Math.min(initialMs * 2 ** exponent, this.#backoffMaxMs)
    // JITTER, 20% downward (aligned with the official desktop client's
    // DesktopConnectionManager). A deterministic doubling re-connects every
    // device of a fleet in the same instant after a shared outage, which is
    // the thundering herd the peer's own rate line answers by closing
    // sessions. Only the LOWER 20% is used, so the documented ceiling
    // `backoffMaxMs` is a real ceiling and the first attempt is never later
    // than its nominal delay by more than rounding.
    return Math.round(capped * (0.8 + Math.random() * 0.2))
  }

  /**
   * One establishment pass: try each candidate host in order. Per-host
   * network failures fall through to the next candidate — the §6
   * 「候选地址全部不可达」 verdict only holds when EVERY host failed.
   *
   * Each candidate dials with ITS OWN port from `record.ports`; the record-level
   * `port` (the winner's at pairing, the operator's after a PATCH) is the
   * fallback for an in-memory record assembled without the map (issue #135).
   * Before that, one port was shared by every host, so a reconnect to a
   * non-winner host dialed the right scheme at the wrong port.
   *
   * "Per-host" covers the CHANNEL-LEVEL handshake failures as well as the dial:
   * a socket that opens and then dies mid-handshake (the peer accepted the TCP
   * connection and went away, a proxy reset it, the Noise exchange was cut) is a
   * property of THAT ADDRESS, and a multi-homed desktop whose first address is
   * stale is exactly the case the candidate list exists for. The terminal faces
   * — identity mismatch, protocol-version confirmation, rejected authentication —
   * are properties of the PAIRING, so they still abort the whole pass instead of
   * being blamed on one address.
   */
  async #establish(epoch: number): Promise<void> {
    this.#setState('connecting')
    // No candidates at all is the same §6 verdict as every candidate failing:
    // the operator must maintain the addresses. Reported through the same error
    // type so the hint fires identically.
    if (this.record.hosts.length === 0) {
      throw new AllHostsUnreachableError(
        this.record.deviceId,
        this.record.hosts,
        new Error('the device record has no candidate hosts'),
      )
    }

    let lastError: Error = new Error(`device ${this.record.deviceId}: all candidate hosts unreachable`)
    for (const host of this.record.hosts) {
      // CANCELLATION GATE, at the top of every candidate. `close()` bumps the
      // epoch and clears `#running`, so either check is enough — both are here
      // because they answer different halves of the same question ("is this
      // pass still the live one?") and a future refactor of one must not
      // silently reopen the hole.
      //
      // Without it, a close() landing DURING a candidate's handshake is
      // classified as a per-host failure (the socket went away — which is true,
      // and is exactly why the dial loop wants to try the next address) and the
      // pass keeps dialing the REST of the candidate list, running a full
      // hello+authenticate against each. Those late attempts are not merely
      // wasted work: once a new cycle has started, a stale attempt's teardown
      // path can land on the NEW cycle's link and kill it.
      if (!this.#running || epoch !== this.#epoch) throw new CancelledError()
      let link: LiveLink
      try {
        // Per-host port, with the record-level (winner's) port as the fallback
        // for an in-memory record assembled without the map — the same `?.`
        // default the scheme gets in #dial (issue #135).
        const port = this.record.ports?.[host] ?? this.record.port
        link = await this.#dial(host, port, epoch)
      } catch (error) {
        if (error instanceof IdentityMismatchError) throw error
        lastError = error instanceof Error ? error : new Error(String(error))
        continue
      }
      // Commit the link before the RPC handshake so every failure path below
      // tears it down through #teardownLink (business traffic is still gated
      // by state !== 'connected').
      this.#link = link
      try {
        await this.#handshake(link, epoch)
        return
      } catch (error) {
        // A close() that landed mid-handshake surfaces here as the failure of
        // whatever call was in flight (`#teardownLink` rejected it), so the
        // epoch is re-checked before the error is classified: cancellation is
        // not this ADDRESS's fault, and falling through would dial the next
        // candidate for a pass that no longer exists.
        if (error instanceof CancelledError || !this.#running || epoch !== this.#epoch) throw new CancelledError()
        // The terminal faces end the pass: they describe the PAIRING, not this
        // address, so trying the next candidate would only repeat them.
        if (!isPerHostFailure(error)) throw error
        // A channel-level failure (socket dropped mid-handshake) is this
        // ADDRESS's problem: tear the link down here, since the loop's next
        // iteration would otherwise overwrite `#link` and leak this socket, and
        // fall through to the next candidate.
        this.#teardownLink()
        lastError = error instanceof Error ? error : new Error(String(error))
        continue
      }
    }
    throw new AllHostsUnreachableError(this.record.deviceId, this.record.hosts, lastError)
  }

  async #dial(host: string, port: number, epoch: number): Promise<LiveLink> {
    // (see {@link DeviceConnectionOptions.wsOptions} for TLS trust)
    // The URL comes from the SAME helper the pairing dial uses (issue #126):
    // it brackets bare IPv6 hosts (the archive's normalized form — splicing one
    // raw into a URL makes `new WebSocket` throw Invalid URL) and selects
    // `ws:`/`wss:` from the record's own scheme for this host. Persisting the
    // scheme is what makes a TLS-proxied desktop RE-connectable: #124 paired
    // over `wss` and this dial then rebuilt `ws://` for every later session.
    const ws = new WebSocket(
      directEndpointUrl({ host, port, security: this.record.security?.[host] ?? 'ws' }),
      this.#wsOptions,
    )
    const controller = new AbortController()

    const opened = new Promise<void>((resolve) => ws.once('open', () => resolve()))
    const failure = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`connect to ${host}:${port} timed out`)), this.#connectTimeoutMs)
      ws.once('open', () => clearTimeout(timer))
      ws.once('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`host ${host}:${port} unreachable: ${error.message}`))
      })
    })
    try {
      await Promise.race([opened, failure])
    } catch (error) {
      ws.terminate()
      throw error
    }

    // Link-loss listeners: the ws close/error events are the primary
    // disconnect signal (spec §3.4); they carry the epoch so stale sockets
    // cannot tear down a newer link.
    //
    // ADJUDICATED WEAKENING: the close CODE is deliberately ignored here.
    // 1011 (server error; rate termination through 2.1.6) and 1013 (try again
    // later, e.g. connection-count over limit) are session-level faces — the
    // peer ends the whole session, never a single request — so every code takes
    // the same offline → backoff → reconnect path. Differentiating them (e.g. a
    // longer, Retry-After-aware backoff for 1013) is deliberately DEFERRED: it
    // would need a per-code policy the protocol does not yet guarantee, and a
    // uniform honest retry is strictly safer than guessing a longer one. The
    // rate limiter still bounds the retry storm in the meantime, and the
    // contract suite's `rate-limit-terminates-session` item proves the uniform
    // transition shape: the 1011 close routes through offline → reconnect.
    // Since 2.1.7 an over-budget request is refused per request instead (a
    // structured `RATE_LIMITED`, not a close), so it never reaches this path.
    ws.on('close', () => this.#onLinkLost(epoch, 'socket closed'))
    ws.on('error', () => this.#onLinkLost(epoch, 'socket error'))

    const stream = new RemoteSocketStream(toRemoteSocket(ws), silentComponentLogger.forComponent('device'), 'outbound')
    let channel: SecureChannel
    try {
      channel = await this[CHANNEL_SEAM].connectSecureChannel(stream, {
        identity: this.#identity,
        logger: silentComponentLogger,
        protocolVersions: [...this.#protocolVersions],
        signal: controller.signal,
        remoteIdentity: this.record.desktopIdentity,
      })
    } catch (error) {
      ws.terminate()
      if (isPeerIdentityMismatch(error)) throw new IdentityMismatchError()
      throw error instanceof Error ? error : new Error(String(error))
    }

    // Pin check (defense in depth: Noise already verified the pinned static
    // key during the outbound handshake; spec §3.4 words it post-handshake).
    if (channel.remoteIdentity !== this.record.desktopIdentity) {
      void channel.close().catch(noop)
      ws.close()
      throw new IdentityMismatchError()
    }

    const client = new JsonRpcClient(channel, {
      maxInFlight: BUSINESS_MAX_IN_FLIGHT,
      ...(this.#rpcTimeoutMs === undefined ? {} : { timeoutMs: this.#rpcTimeoutMs }),
    })
    return { ws, channel, client, controller, epoch }
  }

  /** hello (protocol confirmation) then authenticate (token acquisition). */
  async #handshake(link: LiveLink, epoch: number): Promise<void> {
    const { client } = link

    // Hello must echo the prelude offer element-wise, same order: the peer
    // compares by index and answers INVALID_CONNECTION_STATE otherwise. Real
    // protocol-version negotiation happened earlier, in the Noise prologue.
    let hello: HelloResult
    try {
      hello = await this.#houseCall<HelloResult>(link, 'connection.hello', {
        protocolVersions: [...this.#helloProtocolVersions],
      })
    } catch (error) {
      if (rpcReason(error) === 'INVALID_CONNECTION_STATE') throw new ProtocolVersionError(String(error))
      throw error instanceof Error ? error : new Error(String(error))
    }

    // REBUILT, never patched: the object is replaced on every hello, so a
    // reconnect to a peer that no longer advertises the capability (or a
    // downgrade) cannot inherit a stale `messageSummaries` from the previous
    // link — the exact failure mode that would send `partsMode` to a 2.1.7 peer.
    this.#limits = {
      heartbeatMs: positive(hello.heartbeatMs) ?? FALLBACK_LIMITS.heartbeatMs,
      subscriptions: positive(hello.limits?.['subscriptions']) ?? FALLBACK_LIMITS.subscriptions,
      pageItems: positive(hello.limits?.['pageItems']) ?? FALLBACK_LIMITS.pageItems,
      inFlightRequests: positive(hello.limits?.['inFlightRequests']) ?? FALLBACK_LIMITS.inFlightRequests,
      ...(typeof hello.agentMessageSummariesVersion === 'number'
        ? { messageSummaries: hello.agentMessageSummariesVersion }
        : {}),
    }

    // Size the admission window from the peer's OWN concurrency budget now that
    // hello has reported it (spec §3.4「取回报一半」). The client was dialed with
    // the built-in ceiling before the report existed; this narrows it. Requests
    // already in flight are untouched — house calls share this window, and the
    // hello/authenticate pair is exactly what is in flight at this instant.
    link.client.updateMaxInFlight(businessWindowFor(this.#limits.inFlightRequests))

    let auth: AuthResult
    try {
      auth = await this.#authenticate(link)
    } catch (error) {
      const reason = rpcReason(error)
      if (reason === 'GRANT_REVOKED' || reason === 'UNAUTHENTICATED') throw new AuthRejectedError(reason)
      throw error instanceof Error ? error : new Error(String(error))
    }

    if (epoch !== this.#epoch) {
      // close() raced the handshake: drop the link quietly (close() already
      // tore down what it could see; this catches the just-dialed socket).
      client.dispose()
      void link.channel.close().catch(noop)
      link.ws.close()
      throw new CancelledError()
    }

    this.#token = auth.accessToken
    this.#tokenExpiresAt = Date.parse(auth.expiresAt)
    // Mirrored onto the live record so the in-memory view agrees with the token
    // actually in use — tools/diagnostics that read the record see the live one.
    //
    // It is NOT persisted: the assembly never writes the token back to the
    // device archive, so a RESTART loses it and re-authenticates from scratch.
    // That is deliberate (§3.4 treats the token as connection-scoped): a token
    // on disk outlives the pairing state it was minted for, and the archive is
    // the one file this plugin must be able to reason about across upgrades.
    // The cost is one extra authenticate per start, which the peer charges to
    // the same pairing it already approved.
    this.record.accessToken = auth.accessToken
    this.record.tokenExpiresAt = this.#tokenExpiresAt
    this.#refreshFirstFailureAt = undefined
    this.#pendingPings.clear()
    // Re-attach every notification subscriber to this cycle's client, so
    // subscriptions (Tasks 7/9) survive reconnects transparently. `#teardownLink`
    // cleared the attached-set when the previous client died, so this repopulates
    // it for the new one.
    //
    // Guarded on the set, the same way the facade's `onNotification` is: a
    // handler registered WHILE this handshake was in flight is already attached
    // to this very client (the facade attaches to a live `#link` immediately),
    // and attaching it again would double-deliver every notification for the
    // rest of the cycle. The registry being a Set makes a re-ADD harmless; this
    // is the listener attach, which has no such protection.
    for (const handler of this.#notificationHandlers) {
      if (this.#attachedHandlers.has(handler)) continue
      link.client.onNotification(handler)
      this.#attachedHandlers.add(handler)
    }
    this.#startHeartbeat(epoch)
    this.#scheduleRefresh(epoch)
    this.#setState('connected')
    // The raw pinned identity is a credential-shaped value; the info log
    // carries its 12-hex digest instead, matching the diagnostics policy
    // (`digestIdentity`) so a pasted log line never publishes the full pin.
    console.info(
      `[cherry-remote] device ${this.record.deviceId} connected (${digestIdentity(link.channel.remoteIdentity)})`,
    )
  }

  /**
   * authenticate with the stored token; a stale token (TOKEN_EXPIRED /
   * UNAUTHENTICATED) is retried exactly once without it before the pairing
   * is declared invalid.
   */
  async #authenticate(link: LiveLink): Promise<AuthResult> {
    const stored = this.#token ?? this.record.accessToken
    const params = (withToken: boolean): { deviceId: string; accessToken?: string } => ({
      deviceId: this.record.deviceId,
      ...(withToken && stored !== undefined ? { accessToken: stored } : {}),
    })
    try {
      return await this.#houseCall<AuthResult>(link, 'connection.authenticate', params(stored !== undefined))
    } catch (error) {
      const reason = rpcReason(error)
      if (
        stored !== undefined &&
        (reason === 'TOKEN_EXPIRED' || reason === 'UNAUTHENTICATED')
      ) {
        return await this.#houseCall<AuthResult>(link, 'connection.authenticate', params(false))
      }
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // Steady-state housekeeping (single channel; see class doc comment)
  // -------------------------------------------------------------------------

  #startHeartbeat(epoch: number): void {
    this.#setTimer('heartbeat', setInterval(() => this.#pingTick(epoch), this.#limits.heartbeatMs))
  }

  #pingTick(epoch: number): void {
    if (epoch !== this.#epoch || this.#link === undefined) return
    const windowMs = this.#limits.heartbeatMs * SILENCE_FACTOR
    const now = Date.now()
    // Silence judgement: any ping unanswered for the full 2×heartbeatMs
    // window proves the line dead while the socket may still be open.
    for (const ping of this.#pendingPings) {
      if (now - ping.sentAt >= windowMs) {
        this.#loseLink(epoch, `ping silence exceeded ${windowMs}ms`)
        return
      }
    }
    const ping = { nonce: randomUUID(), sentAt: now }
    this.#pendingPings.add(ping)
    void this.#houseCall<{ nonce: string }>(this.#link, 'connection.ping', { nonce: ping.nonce }, windowMs).then(
      () => this.#pendingPings.delete(ping),
      (error: unknown) => {
        // Only a pong (or a dead channel) clears a pending ping: a timed-out
        // ping is silence evidence and must stay for the window to judge.
        if (isChannelClosedError(error)) {
          this.#pendingPings.delete(ping)
          this.#onLinkLost(epoch, 'channel closed')
        }
      },
    )
  }

  /** Schedules the next refresh from the ACTUAL expiresAt (never hardcoded). */
  #scheduleRefresh(epoch: number): void {
    this.#clearTimer('refresh')
    if (this.#tokenExpiresAt === undefined) return
    const ttl = this.#tokenExpiresAt - Date.now()
    const lead = Math.min(Math.max(Math.floor(ttl / 2), 1), this.#refreshGraceMs)
    const delay = Math.max(ttl - lead, 1)
    this.#setTimer('refresh', setTimeout(() => void this.#refresh(epoch), delay))
  }

  async #refresh(epoch: number): Promise<void> {
    const link = this.#link
    if (epoch !== this.#epoch || link === undefined) return
    try {
      const result = await this.#houseCall<RefreshResult>(link, 'connection.refresh', {})
      this.#token = result.accessToken
      this.#tokenExpiresAt = Date.parse(result.expiresAt)
      // Live record only — refreshed tokens are NOT persisted either (see
      // #handshake): a restart re-authenticates rather than reusing them.
      this.record.accessToken = result.accessToken
      this.record.tokenExpiresAt = this.#tokenExpiresAt
      this.#refreshFirstFailureAt = undefined
      this.#scheduleRefresh(epoch)
    } catch (error) {
      if (isChannelClosedError(error)) return // link-lost path owns it
      const first = (this.#refreshFirstFailureAt ??= Date.now())
      if (Date.now() - first >= this.#refreshGraceMs) {
        console.error(
          `[cherry-remote] device ${this.record.deviceId}: token refresh kept failing beyond the ` +
            `${this.#refreshGraceMs}ms grace window; going offline — check whether the desktop removed this device`,
        )
        this.#loseLink(epoch, 'refresh grace expired')
        return
      }
      this.#setTimer(
        'refreshRetry',
        setTimeout(() => void this.#refresh(epoch), Math.max(1, Math.floor(this.#refreshGraceMs / 4))),
      )
    }
  }

  // -------------------------------------------------------------------------
  // Link lifecycle
  // -------------------------------------------------------------------------

  #onLinkLost(epoch: number, reason: string): void {
    if (epoch !== this.#epoch || this.#state !== 'connected') return
    this.#loseLink(epoch, reason)
  }

  #loseLink(epoch: number, reason: string): void {
    if (epoch !== this.#epoch) return
    this.#teardownLink()
    this.#setState('offline')
    this.#cycle = defer<void>()
    if (!this.#running) return
    const delay = this.#backoffDelay()
    console.warn(
      `[cherry-remote] device ${this.record.deviceId} link lost (${reason}); ` +
        `reconnecting in ${delay}ms with fresh authentication`,
    )
    this.#setTimer('backoff', setTimeout(() => this.#tryEstablish(), delay))
  }

  #teardownLink(): void {
    const link = this.#link
    this.#link = undefined
    this.#clearTimer('heartbeat')
    this.#clearTimer('refresh')
    this.#clearTimer('refreshRetry')
    this.#pendingPings.clear()
    this.#refreshFirstFailureAt = undefined
    // The client carrying these listeners is about to be disposed; the registry
    // keeps the handlers for the next cycle, but nothing is attached any more.
    this.#attachedHandlers.clear()
    if (link !== undefined) {
      // LINK-LOSS disposal, not plain `dispose()`: every request still in flight
      // on this socket must hear about the DEVICE (the spec §6 `{device, state}`
      // condition, reached through the channel-closed face the layers above
      // already classify), not about this client object's own lifetime. The
      // message is the only difference between the two paths, and it is the
      // whole difference a caller acts on: "the channel closed" is a statement
      // about the desktop, "the client was disposed" reads like a plugin bug.
      link.client.disposeForLinkLoss()
      void link.channel.close().catch(noop)
      try {
        link.ws.close()
      } catch {
        // Already closed.
      }
      link.controller.abort()
    }
  }

  #setTimer(name: TimerName, timer: Timer): void {
    this.#clearTimer(name)
    this.#timers.set(name, timer)
  }

  #clearTimer(name: TimerName): void {
    const timer = this.#timers.get(name)
    if (timer !== undefined) {
      clearTimeout(timer)
      clearInterval(timer)
      this.#timers.delete(name)
    }
  }

  #clearAllTimers(): void {
    for (const name of [...this.#timers.keys()]) this.#clearTimer(name)
  }

  // -------------------------------------------------------------------------
  // RPC faces
  // -------------------------------------------------------------------------

  /**
   * Housekeeping call on the raw client: bypasses rate smoothing (ping and
   * refresh are 1/heartbeatMs-scale and must not be delayed by business
   * pacing) while sharing the rpc layer's in-flight window.
   */
  #houseCall<T>(link: LiveLink, method: string, params: unknown, timeoutMs?: number): Promise<T> {
    return link.client.request<T>(method, params, timeoutMs === undefined ? undefined : { timeoutMs })
  }

  /**
   * The remaining time this request may still spend, or undefined when it has no
   * deadline (issue #21). Recomputed at each point that waits, so pacing and a
   * reconnect are both charged to the same budget.
   */
  #remainingMs(opts: JsonRpcRequestOptions | undefined): number | undefined {
    return opts?.deadline === undefined ? undefined : opts.deadline - performance.now()
  }

  /** Whether the caller's deadline has already passed (false without one). */
  #deadlinePassed(opts: JsonRpcRequestOptions | undefined): boolean {
    const remaining = this.#remainingMs(opts)
    return remaining !== undefined && remaining <= 0
  }

  /**
   * Business request: offline fail-fast, then rate smoothing, then the rpc window.
   *
   * A caller-supplied `deadline` ({@link JsonRpcRequestOptions}) bounds EVERY
   * wait this layer owns: the pacing admission, the reconnect wait before a
   * replay, and the replay itself — while the rpc layer bounds the request's own
   * timeout with it. That is the whole point of the option: without it, a
   * flapping link lets every read absorb another `transportRetryWaitMs`, so an
   * answer whose deadline already passed can still take minutes (issue #21).
   *
   * The pacing admission is judged BEFORE it is taken (so a spent budget never
   * spends a slot, which would otherwise make a walk over many `{ref}` parts
   * pay one queueing gap per part after the budget is gone) and AGAIN after it
   * (the admission itself can consume a whole gap). One gap of overshoot
   * remains, unavoidably: a request already queued for its slot is released by
   * the limiter, not by the deadline, so it may be refused one gap late — that
   * bound is the limiter's `#minGapMs`, and refusing it earlier would mean
   * deadline-aware pacing, which is a different piece of work.
   */
  async #businessRequest<T>(method: string, params: unknown, opts?: JsonRpcRequestOptions): Promise<T> {
    if (this.#state !== 'connected') {
      console.warn(`[cherry-remote] request "${method}" rejected: device ${this.record.deviceId} is ${this.#state}`)
      throw new DeviceUnavailableError(this.record.deviceId, this.#state)
    }
    // A SPENT BUDGET DOES NOT BUY A PACING SLOT (issue #21, review finding 3):
    // the admission is a real wait — one `#minGapMs` per request — so a walk
    // that keeps asking after its deadline would pay a gap per remaining part
    // before the post-admission guard refused it, overshooting the "absolute"
    // instant by the Σ of those gaps. Refusing here costs no admission and no
    // round trip; the check is repeated after the admission because TAKING one
    // can consume the last of the budget.
    if (this.#deadlinePassed(opts)) throw new RpcDeadlineExceededError(this.record.deviceId, method)
    // The pacing wait can outlast the link: `acquire` may block for a whole
    // rate window, and a socket lost (or replaced by a reconnect mid-handshake)
    // during it leaves `#link` pointing at a client that is not authenticated.
    // `#establish` commits `#link` BEFORE `#handshake` completes, so the
    // `#link === undefined` guard alone does NOT cover the `connecting` case —
    // a request released into that window rides an unauthenticated client and
    // surfaces a raw `JSON-RPC client disposed` instead of the §6
    // `{device, state}` face this method promises. Re-judge the state AFTER the
    // wait; the checks below are ordered so the structured error always wins.
    await this.#limiter.acquire(method)
    const link = this.#link
    if (this.#state !== 'connected' || link === undefined) {
      console.warn(`[cherry-remote] request "${method}" rejected: device ${this.record.deviceId} is ${this.#state}`)
      throw new DeviceUnavailableError(this.record.deviceId, this.#state)
    }
    // The admission itself costs time (up to a whole rate window), so the
    // deadline is re-judged after it, and only once the structured state error
    // above has had its chance to win: issuing here would spend a request whose
    // answer the caller has no budget left to use.
    if (this.#deadlinePassed(opts)) throw new RpcDeadlineExceededError(this.record.deviceId, method)
    try {
      return await link.client.request<T>(method, params, opts)
    } catch (error) {
      const refusal = rateLimitRefusal(error)
      if (refusal !== undefined) return await this.#replayAfterRateLimit(refusal, method, params, opts)
      if (!this.#isTransportLoss(error)) throw error
      // Reported with the state the request DIED in ('connected'): the
      // supervisor has not necessarily observed the loss yet, and naming the
      // stale state would send a caller looking for an offline device when the
      // device was up and the link was what went away.
      // The underlying rejection rides along as `cause`: the classified faces
      // are identical on purpose, but the operator still needs to tell a
      // record-budget kill from socket congestion when reading the final error.
      const lost = new TransportLostError(this.record.deviceId, 'connected', method, { cause: error })
      // Only a read is replayed (see RETRYABLE_READ_METHODS); only a live
      // lifecycle has a reconnect to wait for.
      if (!RETRYABLE_READ_METHODS.has(method) || !this.#running) throw lost
      // THE RECONNECT WAIT IS PART OF THE CALLER'S BUDGET, not a fixed tax on
      // top of it: capped by the remaining deadline, and skipped entirely when
      // nothing is left. `undefined` below then means either "the wait bound
      // expired" or "the lifecycle moved on"; the remaining budget tells the
      // two apart, and only the first is the caller's own deadline.
      const remaining = this.#remainingMs(opts)
      if (remaining !== undefined && remaining <= 0) throw new RpcDeadlineExceededError(this.record.deviceId, method)
      // WHICH BOUND IS THE SHORTER ONE comes from the RAW remaining time, in
      // `reconnectWait` itself — the wait it returns is ceiled, so it can equal
      // the allowance while the deadline was still the shorter bound. Deriving
      // the attribution from the timer value would report a spent budget as a
      // plain transport loss (see that helper).
      const { waitMs, deadlineCapped } = reconnectWait(remaining, this.#transportRetryWaitMs)
      // The bound LOGGED is the one actually waited for: reporting the configured
      // allowance while a caller's deadline shortened it would make the operator
      // read a 5 s wait where there was 200 ms.
      console.warn(
        `[cherry-remote] request "${method}" lost its link in flight (device ${this.record.deviceId}); ` +
          `waiting up to ${Math.round(waitMs)}ms for a reconnect to replay it`,
      )
      const waited = await this.#awaitReconnect(waitMs, link.client)
      if (waited.kind === 'abandoned') throw lost
      if (waited.kind === 'expired') {
        // NO CLOCK READ HERE, and no comparison of timer values either: a clock
        // read races a timer that fires a millisecond early, and the timer
        // value is ceiled, so it can equal the allowance even when the budget
        // was what capped it. `deadlineCapped` is the FACT of which bound was
        // shorter, captured from the raw remaining time before the ceiling.
        if (deadlineCapped) throw new RpcDeadlineExceededError(this.record.deviceId, method)
        throw lost
      }
      const reconnected = waited
      // The link GENERATION the wait resolved on, re-checked before the replay
      // is spent. This is why `#awaitReconnect` returns the epoch at all: a
      // link loss is not a teardown, so a wait parked across one is not
      // drained — it simply settles on whatever reconnected link comes next.
      // Without this check the ONE replay a read is granted could be spent on
      // a client from a generation the caller never saw (or one already being
      // torn down), and the stale-generation race would resurface with any
      // answer rather than the classified loss. A mismatch means the link
      // changed under the wait: report the loss the caller's own attempt
      // suffered, and let the caller re-ask on the current link.
      if (reconnected.epoch !== this.#epoch) throw lost
      // The replay is a NEW ARRIVAL at the peer, so it takes a fresh pacing
      // admission: a reconnect releases every parked replay at once, and an
      // un-paced burst is exactly the spike the peer answers with a session
      // close (the rate-limit terminator) — the same kill that took the
      // original link. The admission this call paid above bought the attempt
      // that died; arrivals, not logical calls, are what the peer paces.
      await this.#limiter.acquire(method)
      // The pacing wait can outlast the link it resolved on (the primary path
      // re-judges after its own acquire for the same reason): a teardown during
      // it disposes the target client, and firing into a disposed client would
      // surface raw disposal text — a verdict the caller cannot act on.
      if (!this.#running || this.#state !== 'connected') throw lost
      // The replay takes ANOTHER pacing admission, so the budget is judged once
      // more before it is spent: the reconnect wait may have used the last of
      // it, and replaying into a spent budget would only produce a timeout the
      // caller cannot use.
      if (this.#deadlinePassed(opts)) throw new RpcDeadlineExceededError(this.record.deviceId, method)
      try {
        return await reconnected.client.request<T>(method, params, opts)
      } catch (error) {
        // The replay is the LAST attempt: a link that dies again is reported as
        // the same classified loss, never as the bare channel-closed text the
        // caller cannot act on. A DISPOSED target is the same class here — the
        // replay's link was real a moment ago, so its disposal is the lifecycle
        // moving on under the request, not the caller's own close() (which the
        // re-check above already answered).
        if (this.#isTransportLoss(error) || DISPOSED_RE.test(String((error as Error)?.message ?? ''))) {
          throw lost
        }
        throw error
      }
    }
  }

  /**
   * ONE bounded replay for a READ the peer refused because the socket is over
   * its rate window.
   *
   * 2.1.7 answers that request with a structured `RATE_LIMITED` failure and a
   * `retryAfterMs` instead of closing the session (see `rateLimitRefusal`), so
   * the caller no longer learns it was throttled by losing its connection:
   * without this, a transient refusal became a failed tool call whose part text
   * the projection would even degrade.
   *
   * The shape mirrors the transport-loss replay, for the same reasons:
   *
   *  - only a READ is replayed (a command's refusal is a verdict on that
   *    arrival, and commands are never replayed — receipts recover them);
   *  - the wait is charged to the caller's deadline and never extends it, so a
   *    wait answer's budget turns a refusal near its bound into a `'deadline'`
   *    stop instead of an overrun;
   *  - the replay takes a FRESH pacing admission: it is a new arrival at the
   *    peer, and skipping the admission would replay into the same full window.
   *
   * A SECOND refusal is a real failure and propagates as itself (the fresh
   * `retryAfterMs` is the more useful one); a link lost under the replay is
   * reported as the classified `TransportLostError`, never as bare text.
   */
  async #replayAfterRateLimit<T>(
    refusal: JsonRpcRequestError,
    method: string,
    params: unknown,
    opts: JsonRpcRequestOptions | undefined,
  ): Promise<T> {
    if (!RETRYABLE_READ_METHODS.has(method) || !this.#running) throw refusal
    const remaining = this.#remainingMs(opts)
    if (remaining !== undefined && remaining <= 0) throw new RpcDeadlineExceededError(this.record.deviceId, method)
    const requested = rateLimitWaitMs(refusal)
    const waitMs = Math.min(requested, remaining ?? Number.POSITIVE_INFINITY)
    // WHICH BOUND WAS SPENT is captured BEFORE the timer, never re-derived from
    // a clock read after it: a timer may fire a millisecond EARLY (the same race
    // `reconnectWait`/`deadlineCapped` exists to avoid, and the reason
    // `RequestTimeoutError.clampedByDeadline` is a flag). When the requested
    // wait consumed the caller's whole budget, the outcome is the CALLER's
    // deadline — throwing it here also keeps the one replay from being sent
    // into a budget that was already spent.
    const deadlineSpent = remaining !== undefined && requested >= remaining
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
    // The wait is not cancellable by `close()`; the state is re-judged instead,
    // the same way every other parked wait in this class is.
    if (!this.#running || this.#state !== 'connected') throw refusal
    if (deadlineSpent || this.#deadlinePassed(opts)) {
      throw new RpcDeadlineExceededError(this.record.deviceId, method)
    }
    await this.#limiter.acquire(method)
    const link = this.#link
    if (!this.#running || this.#state !== 'connected' || link === undefined) throw refusal
    if (this.#deadlinePassed(opts)) throw new RpcDeadlineExceededError(this.record.deviceId, method)
    try {
      return await link.client.request<T>(method, params, opts)
    } catch (error) {
      if (this.#isTransportLoss(error)) {
        throw new TransportLostError(this.record.deviceId, 'connected', method, { cause: error })
      }
      throw error
    }
  }

  /** Whether a rejection is the dead channel, as opposed to a peer's own answer. */
  #isTransportLoss(error: unknown): boolean {
    // A peer refusal is a verdict (JsonRpcRequestError) and a deliberate local
    // shutdown reads `JSON-RPC client disposed`; only the channel-closed face
    // means "the request has no adjudicator". WHICH failures land on that face
    // is the rpc layer's decision, not this layer's: a failed WRITE (the
    // transport ran out of record budget or its socket queue) is reported there
    // as the same classified error, with the transport's own message as its
    // `cause`, precisely so this predicate needs no second literal to match.
    return error instanceof Error && !(error instanceof JsonRpcRequestError) && isChannelClosedError(error)
  }

  /**
   * Waits up to `waitMs` for the next AUTHENTICATED link, and says WHY the wait
   * ended ({@link ReplayWait}) instead of resolving `undefined` for all three
   * outcomes — the caller has to tell "my deadline ran out" from "the peer never
   * came back" and from "the lifecycle moved on", and only a reported cause can
   * be trusted (a clock comparison after the fact races an early timer).
   *
   * `connected` is the right condition rather than "a link exists": `#establish`
   * commits `#link` before its hello/authenticate pair completes, and a replay
   * into that window would ride an unauthenticated client.
   */
  #awaitReconnect(waitMs: number, deadClient: JsonRpcClient): Promise<ReplayWait> {
    if (!this.#running) return Promise.resolve({ kind: 'abandoned' })
    // The link whose channel just died must not be handed back: the supervisor
    // may not have observed the loss yet, and replaying into the SAME dead
    // client burns the one retry on an immediate rejection.
    const established = (): ReplayWait | undefined => {
      const link = this.#link
      if (this.#state !== 'connected' || link === undefined) return undefined
      if (link.client === deadClient) return undefined
      return { kind: 'connected', client: link.client, epoch: link.epoch }
    }
    const ready = established()
    if (ready !== undefined) return Promise.resolve(ready)
    // Rides the state listeners rather than a polling loop, so every wait costs
    // one timer (its own bound) that is cleared whichever way it settles.
    return new Promise((resolve) => {
      const finish = (outcome: ReplayWait): void => {
        clearTimeout(timer)
        this.#stateListeners.delete(listener)
        this.#replayWaiters.delete(finish)
        resolve(outcome)
      }
      const listener = (state: DeviceState): void => {
        if (!this.#running || state === 'disabled' || state === 'identity-mismatch') {
          finish({ kind: 'abandoned' })
          return
        }
        if (state !== 'connected') return
        const link = this.#link
        if (link === undefined || link.client === deadClient) return
        finish({ kind: 'connected', client: link.client, epoch: link.epoch })
      }
      // The ONLY thing this timer means is "the bound elapsed". Whether that
      // bound was the deadline or the reconnect allowance is decided by the
      // caller from `waitMs`, which it chose.
      const timer = setTimeout(() => finish({ kind: 'expired' }), waitMs)
      this.#replayWaiters.add(finish)
      this.#stateListeners.add(listener)
    })
  }

  #setState(next: DeviceState): void {
    if (this.#state === next) return
    this.#state = next
    console.info(`[cherry-remote] device ${this.record.deviceId} state: ${next}`)
    for (const cb of [...this.#stateListeners]) {
      try {
        cb(next)
      } catch (error) {
        console.warn(`[cherry-remote] state listener threw for ${this.record.deviceId}`, error)
      }
    }
    for (const cb of [...this.#settleWaiters]) {
      try {
        cb(next)
      } catch (error) {
        console.warn(`[cherry-remote] settle waiter threw for ${this.record.deviceId}`, error)
      }
    }
  }
}
