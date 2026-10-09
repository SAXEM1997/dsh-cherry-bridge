import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { connectSecureChannel, RemoteSocketStream } from '@cherrystudio/remote-transport'
import type { ChannelOptions, SecureChannel } from '@cherrystudio/remote-transport'
import { remoteConnectPath } from '@cherrystudio/remote-protocol'
import { JsonRpcClient, JsonRpcRequestError } from './rpc/jsonRpcClient'
import { toRemoteSocket } from './rpc/wsAdapter'
import type { DeviceRecord } from './deviceStore'

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
}

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

// ---------------------------------------------------------------------------
// Defaults (spec §3.4 and controller rulings; values are contractual).
// ---------------------------------------------------------------------------

const DEFAULT_RATE_BUDGET_PER_SECOND = 32
/** Business-request window: owned by the rpc layer, NOT re-limited here. */
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
/** Bare rejection the rpc layer uses once the channel can no longer answer. */
const CHANNEL_CLOSED_RE = /^JSON-RPC channel closed$/

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
  readonly #stateListeners = new Set<(state: DeviceState) => void>()
  /** Notification handlers, re-attached to every new client after a reconnect. */
  readonly #notificationHandlers = new Set<(method: string, params: unknown) => void>()
  readonly #timers = new Map<TimerName, Timer>()

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

  readonly #facade: JsonRpcClient = new Proxy({} as JsonRpcClient, {
    get: (_target, prop) => {
      if (prop === 'request') {
        return (method: string, params: unknown, opts?: { timeoutMs?: number }) =>
          this.#businessRequest(method, params, opts)
      }
      if (prop === 'onNotification') {
        return (handler: (method: string, params: unknown) => void) => {
          this.#notificationHandlers.add(handler)
          // Also attach to a live client so registration works immediately;
          // the registry keeps it across reconnects.
          this.#link?.client.onNotification(handler)
        }
      }
      const link = this.#link
      if (link === undefined) {
        if (prop === 'dispose') return noop
        return undefined
      }
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
    console.warn(
      `[cherry-remote] device ${this.record.deviceId} offline ` +
        `(${error instanceof Error ? error.message : String(error)}); reconnecting in ${delay}ms`,
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
   */
  async #establish(epoch: number): Promise<void> {
    this.#setState('connecting')
    if (this.record.hosts.length === 0) throw new Error(`device ${this.record.deviceId} has no candidate hosts`)

    let lastError: Error = new Error(`device ${this.record.deviceId}: all candidate hosts unreachable`)
    for (const host of this.record.hosts) {
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
      await this.#handshake(link, epoch)
      return
    }
    throw lastError
  }

  async #dial(host: string, port: number, epoch: number): Promise<LiveLink> {
    const url = `ws://${host}:${port}${remoteConnectPath}`
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
    ws.on('close', () => this.#onLinkLost(epoch, 'socket closed'))
    ws.on('error', () => this.#onLinkLost(epoch, 'socket error'))

    const stream = new RemoteSocketStream(toRemoteSocket(ws), silentComponentLogger.forComponent('device'), 'outbound')
    let channel: SecureChannel
    try {
      channel = await connectSecureChannel(stream, {
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
    // Keep the live record fresh so the assembly can persist refreshed tokens.
    this.record.accessToken = auth.accessToken
    this.record.tokenExpiresAt = this.#tokenExpiresAt
    this.#refreshFirstFailureAt = undefined
    this.#pendingPings.clear()
    // Re-attach every notification subscriber to this cycle's client, so
    // subscriptions (Tasks 7/9) survive reconnects transparently.
    for (const handler of this.#notificationHandlers) link.client.onNotification(handler)
    this.#startHeartbeat(epoch)
    this.#scheduleRefresh(epoch)
    this.#setState('connected')
    console.info(`[cherry-remote] device ${this.record.deviceId} connected (${link.channel.remoteIdentity})`)
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
        if (error instanceof Error && CHANNEL_CLOSED_RE.test(error.message)) {
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
      this.record.accessToken = result.accessToken
      this.record.tokenExpiresAt = this.#tokenExpiresAt
      this.#refreshFirstFailureAt = undefined
      this.#scheduleRefresh(epoch)
    } catch (error) {
      if (error instanceof Error && CHANNEL_CLOSED_RE.test(error.message)) return // link-lost path owns it
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
    if (link !== undefined) {
      link.client.dispose()
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
    await this.#limiter.acquire()
    const link = this.#link
    if (link === undefined) throw new DeviceUnavailableError(this.record.deviceId, this.#state)
    return link.client.request<T>(method, params, opts)
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
