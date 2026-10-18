import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { connectSecureChannel, RemoteSocketStream } from '@cherrystudio/remote-transport'
import type { ChannelOptions, SecureChannel } from '@cherrystudio/remote-transport'
import { remoteConnectPath } from '@cherrystudio/remote-protocol'
import { isChannelClosedError, JsonRpcClient, JsonRpcRequestError } from './rpc/jsonRpcClient.js'
import { toRemoteSocket } from './rpc/wsAdapter.js'
import { digestIdentity } from './diagnostics.js'
import { DEFAULT_RATE_BUDGET_PER_SECOND, DEFAULT_TRANSPORT_RETRY_WAIT_MS } from './defaults.js'
import { urlHost } from './urlHost.js'
import type { DeviceRecord } from './deviceStore.js'

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
}

export interface DeviceConnectionOptions {
  /** Local Ed25519 device identity (raw protobuf private key bytes). */
  identity: Uint8Array
  /** The paired device record; `hosts`/`port` are re-read on every attempt. */
  record: DeviceRecord
  /**
   * Second-level smoothed request budget for business RPCs. Default 32,
   * injected by the assembly from plugin config (Task 10 wires the cordis
   * default key). Per-connection only: the peer's rate window is per-socket,
   * so a per-device budget satisfies it with no cross-device scheduling.
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
  /** Per-RPC timeout handed to JsonRpcClient (default: the client's 30s). */
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
 * The read methods whose transport loss may be replayed automatically (two
 * entries are not called today — kept so a future call site is covered the day
 * it appears rather than silently un-retried).
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
 */
class SecondWindowRateLimiter {
  readonly #admitted: number[] = []
  readonly #minGapMs: number

  constructor(readonly budgetPerSecond: number) {
    this.#minGapMs = Math.ceil((RATE_WINDOW_MS + RATE_WINDOW_MARGIN_MS) / Math.max(budgetPerSecond, 1))
  }

  async acquire(): Promise<void> {
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
  readonly #limiter: SecondWindowRateLimiter
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
   * Waits parked inside `#awaitReconnect`. close() drains them: a shutdown has
   * no reconnect to wait for, and — the case that matters — a close() followed
   * by a fresh connect() must not let an OLD lifecycle's replay ride the new
   * one. close() may fire NO state transition at all (setting 'offline' when
   * the state is already 'offline' is a no-op), so the listeners alone cannot
   * be relied on to notice.
   */
  readonly #replayWaiters = new Set<(value?: undefined) => void>()
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

  constructor(opts: DeviceConnectionOptions) {
    this.record = opts.record
    this.#identity = opts.identity
    this.#limiter = new SecondWindowRateLimiter(opts.rateBudgetPerSecond ?? DEFAULT_RATE_BUDGET_PER_SECOND)
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
        return (method: string, params: unknown, opts?: { timeoutMs?: number }) =>
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
    for (const abort of [...this.#replayWaiters]) abort(undefined)
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
      console.error(
        `[cherry-remote] device ${this.record.deviceId}: protocol version incompatible ` +
          `(${error.message}); upgrade Cherry Studio / the plugin`,
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
    console.warn(
      `[cherry-remote] device ${this.record.deviceId} offline ` +
        `(${error instanceof Error ? error.message : String(error)}); reconnecting in ${delay}ms${hint}`,
    )
    this.#setTimer('backoff', setTimeout(() => this.#tryEstablish(), delay))
  }

  #backoffDelay(): number {
    const exponent = Math.min(Math.max(this.#attempt - 1, 0), 30)
    return Math.min(this.#backoffInitialMs * 2 ** exponent, this.#backoffMaxMs)
  }

  /**
   * One establishment pass: try each candidate host in order. Per-host
   * network failures fall through to the next candidate — the §6
   * 「候选地址全部不可达」 verdict only holds when EVERY host failed.
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
        link = await this.#dial(host, this.record.port, epoch)
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
    // Bare IPv6 hosts (the archive's normalized form) must be bracketed into
    // a URL authority or `new WebSocket` throws Invalid URL.
    const url = `ws://${urlHost(host)}:${port}${remoteConnectPath}`
    const ws = new WebSocket(url)
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
    // 1011 (server error / rate termination) and 1013 (try again later, e.g.
    // connection-count over limit) are the peer's AUTHORITATIVE session-level
    // faces — it ends the whole session, never a single request — so every code
    // takes the same offline → backoff → reconnect path. Differentiating them
    // (e.g. a longer, Retry-After-aware backoff for 1013) is deliberately
    // DEFERRED: it would need a per-code policy the protocol does not yet
    // guarantee, and a uniform honest retry is strictly safer than guessing a
    // longer one. The rate limiter still bounds the retry storm in the
    // meantime, and the contract suite's `rate-limit-terminates-session` item
    // proves the uniform transition shape: the 1011 close routes through
    // offline → reconnect rather than surfacing a per-request refusal.
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

    this.#limits = {
      heartbeatMs: positive(hello.heartbeatMs) ?? FALLBACK_LIMITS.heartbeatMs,
      subscriptions: positive(hello.limits?.['subscriptions']) ?? FALLBACK_LIMITS.subscriptions,
      pageItems: positive(hello.limits?.['pageItems']) ?? FALLBACK_LIMITS.pageItems,
      inFlightRequests: positive(hello.limits?.['inFlightRequests']) ?? FALLBACK_LIMITS.inFlightRequests,
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

  /** Business request: offline fail-fast, then rate smoothing, then the rpc window. */
  async #businessRequest<T>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    if (this.#state !== 'connected') {
      console.warn(`[cherry-remote] request "${method}" rejected: device ${this.record.deviceId} is ${this.#state}`)
      throw new DeviceUnavailableError(this.record.deviceId, this.#state)
    }
    // The pacing wait can outlast the link: `acquire` may block for a whole
    // rate window, and a socket lost (or replaced by a reconnect mid-handshake)
    // during it leaves `#link` pointing at a client that is not authenticated.
    // `#establish` commits `#link` BEFORE `#handshake` completes, so the
    // `#link === undefined` guard alone does NOT cover the `connecting` case —
    // a request released into that window rides an unauthenticated client and
    // surfaces a raw `JSON-RPC client disposed` instead of the §6
    // `{device, state}` face this method promises. Re-judge the state AFTER the
    // wait; the checks below are ordered so the structured error always wins.
    await this.#limiter.acquire()
    const link = this.#link
    if (this.#state !== 'connected' || link === undefined) {
      console.warn(`[cherry-remote] request "${method}" rejected: device ${this.record.deviceId} is ${this.#state}`)
      throw new DeviceUnavailableError(this.record.deviceId, this.#state)
    }
    try {
      return await link.client.request<T>(method, params, opts)
    } catch (error) {
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
      console.warn(
        `[cherry-remote] request "${method}" lost its link in flight (device ${this.record.deviceId}); ` +
          `waiting up to ${this.#transportRetryWaitMs}ms for a reconnect to replay it`,
      )
      const reconnected = await this.#awaitReconnect(this.#transportRetryWaitMs, link.client)
      if (reconnected === undefined) throw lost
      // The replay is a NEW ARRIVAL at the peer, so it takes a fresh pacing
      // admission: a reconnect releases every parked replay at once, and an
      // un-paced burst is exactly the spike the peer answers with a session
      // close (the rate-limit terminator) — the same kill that took the
      // original link. The admission this call paid above bought the attempt
      // that died; arrivals, not logical calls, are what the peer paces.
      await this.#limiter.acquire()
      // The pacing wait can outlast the link it resolved on (the primary path
      // re-judges after its own acquire for the same reason): a teardown during
      // it disposes the target client, and firing into a disposed client would
      // surface raw disposal text — a verdict the caller cannot act on.
      if (!this.#running || this.#state !== 'connected') throw lost
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
   * Resolves with the next AUTHENTICATED link (+epoch) within `waitMs`, or
   * undefined once the bound, a shutdown, or a cycle the supervisor abandoned
   * makes a replay pointless.
   *
   * `connected` is the right condition rather than "a link exists": `#establish`
   * commits `#link` before its hello/authenticate pair completes, and a replay
   * into that window would ride an unauthenticated client.
   */
  #awaitReconnect(
    waitMs: number,
    deadClient: JsonRpcClient,
  ): Promise<{ client: JsonRpcClient; epoch: number } | undefined> {
    if (!this.#running) return Promise.resolve(undefined)
    // The link whose channel just died must not be handed back: the supervisor
    // may not have observed the loss yet, and replaying into the SAME dead
    // client burns the one retry on an immediate rejection.
    const established = (): { client: JsonRpcClient; epoch: number } | undefined => {
      const link = this.#link
      if (this.#state !== 'connected' || link === undefined) return undefined
      if (link.client === deadClient) return undefined
      return { client: link.client, epoch: link.epoch }
    }
    const ready = established()
    if (ready !== undefined) return Promise.resolve(ready)
    // Rides the state listeners rather than a polling loop, so every wait costs
    // one timer (its own bound) that is cleared whichever way it settles.
    return new Promise((resolve) => {
      const finish = (value: { client: JsonRpcClient; epoch: number } | undefined): void => {
        clearTimeout(timer)
        this.#stateListeners.delete(listener)
        this.#replayWaiters.delete(finish)
        resolve(value)
      }
      const listener = (state: DeviceState): void => {
        if (!this.#running || state === 'disabled' || state === 'identity-mismatch') {
          finish(undefined)
          return
        }
        if (state !== 'connected') return
        const link = this.#link
        if (link === undefined || link.client === deadClient) return
        finish({ client: link.client, epoch: link.epoch })
      }
      const timer = setTimeout(() => finish(undefined), waitMs)
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
  }
}
