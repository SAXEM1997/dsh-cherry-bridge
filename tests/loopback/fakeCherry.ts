import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import type { ComponentLogger, Logger } from '@libp2p/interface'
import {
  acceptSecureChannel,
  createDeviceIdentity,
  deviceIdentityId,
  RemoteSocketStream,
} from '@cherrystudio/remote-transport'
import type { SecureChannel } from '@cherrystudio/remote-transport'
import { connectionMethods } from '@cherrystudio/remote-protocol'
import { agentAuthorizationSchema } from '@cherrystudio/remote-protocol/agent'
import { toRemoteSocket } from '../../src/rpc/wsAdapter'

/**
 * A protocol-level failure injected by a test, shaped exactly like the
 * `remoteFailure` payload the real desktop returns inside JSON-RPC `error.data`.
 */
export interface FakeFailure {
  reason: string
  message: string
  retryAfterMs?: number
}

/** Configuration of the `connection.hello` reply (limits/heartbeat face). */
export interface FakeHelloOptions {
  /** Echoed heartbeatMs; the client pings on this cadence (default 20_000). */
  heartbeatMs?: number
  /** Omit the heartbeatMs key entirely to exercise the client's fallback. */
  omitHeartbeatMs?: boolean
  /** Echoed `limits` record (client reads pageItems/subscriptions/inFlightRequests). */
  limits?: Record<string, number>
  /** Omit the limits key entirely to exercise the client's fallback. */
  omitLimits?: boolean
}

/**
 * Config surface of the fake desktop. Deliberately wide: Tasks 6/7/8/9/13
 * extend this harness (pairing, subscriptions, agent methods, rate-limit
 * semantics) rather than rewrite it, so every injection knob is optional and
 * independently combinable.
 */
export interface FakeCherryOptions {
  /** Desktop static identity; a fresh key is generated when omitted. */
  identity?: Uint8Array
  /** Versions offered in the Noise-prelude negotiation (default [1]). */
  protocolVersions?: number[]
  hello?: FakeHelloOptions
  /** Token lifetime handed out by authenticate/refresh (default 600_000). */
  tokenTtlMs?: number
  /** Every `connection.authenticate` fails with this protocol failure. */
  authenticateFailure?: FakeFailure
  /** Every `connection.refresh` fails with this protocol failure. */
  refreshFailure?: FakeFailure
  /** Accept pings but never answer them (silence-timeout exercises). */
  dropPings?: boolean
  /** Artificial per-request delay; requests stay counted as in-flight while waiting. */
  requestDelayMs?: number
  /**
   * Server-side rate cap per second. Exceeding it closes the whole session
   * with 1011 (the authoritative rate-termination face — NOT a per-request
   * rejection), mirroring the real desktop's session-level enforcement.
   */
  rateLimitPerSecond?: number
}

interface IssuedToken {
  token: string
  at: number
  expiresAt: number
}

interface LiveConnection {
  socket: WebSocket
  channel: SecureChannel
  controller: AbortController
}

const noop = (): void => {}
const DEFAULT_PROTOCOL_VERSIONS = [1]
const JSON_RPC_ERROR_CODE = 1000

/** A callable libp2p logger: noise/inbound streams invoke it as `log('msg')`. */
function makeLogger(name: string): Logger {
  const log = (() => {}) as unknown as Logger
  log.error = noop
  log.trace = noop
  log.enabled = false
  log.newScope = (scope: string) => makeLogger(`${name}:${scope}`)
  return log
}

const componentLogger: ComponentLogger = { forComponent: (name: string) => makeLogger(name) }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Inbound params schemas come from the real protocol package so the fake
 * rejects malformed requests exactly like the real desktop face. Methods the
 * fake adds later (agent.*, pairing.*) are not in this table and pass through.
 */
const methodSchemas = connectionMethods(agentAuthorizationSchema) as unknown as Record<
  string,
  { params: { safeParse: (input: unknown) => { success: boolean } } }
>

function parseParams(method: string, params: unknown): Record<string, unknown> | undefined {
  const schema = methodSchemas[method]
  if (schema === undefined || schema.params.safeParse(params).success) {
    return params as Record<string, unknown>
  }
  return undefined
}

/** Internal control-flow channel: a handler-thrown protocol failure. */
class FakeRpcError extends Error {
  constructor(readonly failure: FakeFailure) {
    super(failure.message)
  }
}

/**
 * A loopback stand-in for the Cherry Studio desktop: a real `ws` server whose
 * connections are upgraded with `acceptSecureChannel` (real Noise XX, real
 * prelude negotiation) and then serve a minimal hello/authenticate/refresh/ping
 * JSON-RPC face.
 *
 * The read loop dispatches frames CONCURRENTLY: a slow handler must never
 * block the next frame, or the fake could not observe the client's true
 * in-flight concurrency.
 */
export class FakeCherry {
  readonly #options: FakeCherryOptions
  readonly #identity: Promise<Uint8Array>
  #server: WebSocketServer | undefined
  #live: LiveConnection[] = []

  // Runtime-mutable injection state (tests flip these mid-flight).
  #refreshFailure: FakeFailure | undefined
  #authenticateFailure: FakeFailure | undefined
  #dropPings: boolean

  // Observation surface.
  #socketCount = 0
  #connectionCount = 0
  #socketCloseTimes: number[] = []
  #requestCount = 0
  #requestTimestamps: number[] = []
  #methodCounts = new Map<string, number>()
  #inFlight = 0
  #maxInFlight = 0
  #lastHelloProtocolVersions: number[] | undefined
  #helloEchoMatchesOffer = false
  #tokenIssues: IssuedToken[] = []
  #refreshCalls: number[] = []

  constructor(options: FakeCherryOptions = {}) {
    this.#options = options
    this.#identity = options.identity !== undefined ? Promise.resolve(options.identity) : createDeviceIdentity()
    this.#refreshFailure = options.refreshFailure
    this.#authenticateFailure = options.authenticateFailure
    this.#dropPings = options.dropPings ?? false
  }

  /** The desktop's pinned peer id, for `DeviceRecord.desktopIdentity`. */
  get identityId(): Promise<string> {
    return this.#identity.then((key) => deviceIdentityId(key))
  }

  /** Sockets accepted (TCP/WS layer, before any handshake outcome). */
  get socketCount(): number {
    return this.#socketCount
  }

  /** Noise handshakes completed successfully. */
  get connectionCount(): number {
    return this.#connectionCount
  }

  /** Currently connected client sockets (live server.clients size). */
  get connectedClients(): number {
    return this.#server?.clients.size ?? 0
  }

  /**
   * Wall-clock times (performance.now) of peer-observed socket closes —
   * ordering evidence for "the socket was still open when X happened".
   */
  get socketCloseTimes(): readonly number[] {
    return this.#socketCloseTimes
  }

  get requestCount(): number {
    return this.#requestCount
  }

  /** Arrival time of every served request — the rate-window observation. */
  get requestTimestamps(): readonly number[] {
    return this.#requestTimestamps
  }

  get inFlight(): number {
    return this.#inFlight
  }

  /** Peak simultaneous unanswered requests observed since start. */
  get maxInFlight(): number {
    return this.#maxInFlight
  }

  get lastHelloProtocolVersions(): readonly number[] | undefined {
    return this.#lastHelloProtocolVersions
  }

  /** True iff the last hello echoed the prelude offer element-wise (index-by-index). */
  get helloEchoMatchesOffer(): boolean {
    return this.#helloEchoMatchesOffer
  }

  get helloCount(): number {
    return this.#methodCounts.get('connection.hello') ?? 0
  }

  get authenticateCount(): number {
    return this.#methodCounts.get('connection.authenticate') ?? 0
  }

  get refreshCount(): number {
    return this.#methodCounts.get('connection.refresh') ?? 0
  }

  get pingCount(): number {
    return this.#methodCounts.get('connection.ping') ?? 0
  }

  /** Server-side record of every token issued (authenticate and refresh alike). */
  get tokenIssues(): readonly IssuedToken[] {
    return this.#tokenIssues
  }

  /** Wall-clock times of refresh calls, for "refreshed before expiry" assertions. */
  get refreshCalls(): readonly number[] {
    return this.#refreshCalls
  }

  async start(): Promise<{ host: string; port: number }> {
    const identity = await this.#identity
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    this.#server = server
    server.on('connection', (socket) => {
      this.#socketCount += 1
      socket.on('close', () => this.#socketCloseTimes.push(performance.now()))
      this.#handleSocket(socket, identity)
    })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const { address: host, port } = server.address() as AddressInfo
    return { host, port }
  }

  /** Closes every live client socket with the given code (disconnect injection). */
  injectClose(code: 1000 | 1011 | 1013, reason = 'injected'): void {
    for (const { socket } of this.#live) socket.close(code, reason)
  }

  setRefreshFailure(failure: FakeFailure | undefined): void {
    this.#refreshFailure = failure
  }

  setAuthenticateFailure(failure: FakeFailure | undefined): void {
    this.#authenticateFailure = failure
  }

  setDropPings(drop: boolean): void {
    this.#dropPings = drop
  }

  async stop(): Promise<void> {
    for (const { socket, controller } of this.#live) {
      controller.abort()
      socket.terminate()
    }
    this.#live = []
    const server = this.#server
    this.#server = undefined
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  #handleSocket(socket: WebSocket, identity: Uint8Array): void {
    const controller = new AbortController()
    const stream = new RemoteSocketStream(toRemoteSocket(socket), componentLogger.forComponent('fake'), 'inbound')
    void acceptSecureChannel(stream, {
      identity,
      logger: componentLogger,
      protocolVersions: this.#options.protocolVersions ?? DEFAULT_PROTOCOL_VERSIONS,
      signal: controller.signal,
    })
      .then((channel) => {
        this.#connectionCount += 1
        const live: LiveConnection = { socket, channel, controller }
        this.#live.push(live)
        void this.#serve(live)
      })
      .catch(() => {
        // Handshake failed (pin mismatch, bad prelude, abort): the transport
        // already tore the socket down; nothing to record beyond socketCount.
      })
  }

  async #serve(live: LiveConnection): Promise<void> {
    try {
      for (;;) {
        const frame = await live.channel.read()
        if (typeof frame === 'object' && frame !== null) {
          // Dispatch without awaiting: a delayed handler must not stall the loop.
          void this.#dispatch(live, frame as Record<string, unknown>)
        }
      }
    } catch {
      // Channel closed; RemoteSocketStream already cleaned the socket up.
    } finally {
      this.#live = this.#live.filter((entry) => entry !== live)
    }
  }

  async #dispatch(live: LiveConnection, frame: Record<string, unknown>): Promise<void> {
    if (typeof frame.method !== 'string' || frame.id === undefined) return
    const method = frame.method
    const params = parseParams(method, frame.params)
    this.#countArrival(method)
    if (method === 'connection.hello' && Array.isArray(params?.['protocolVersions'])) {
      this.#lastHelloProtocolVersions = [...(params['protocolVersions'] as number[])]
    }

    this.#inFlight += 1
    if (this.#inFlight > this.#maxInFlight) this.#maxInFlight = this.#inFlight
    try {
      if (this.#rateLimited(live)) return // session terminated; nothing further to say

      if (method === 'connection.ping' && this.#dropPings) {
        // Accepted, counted, never answered: the client's silence window judges.
        return
      }

      if (params === undefined) {
        await this.#reply(live, frame.id, undefined, {
          reason: 'INVALID_CONNECTION_STATE',
          message: `malformed params for ${method}`,
        })
        return
      }

      try {
        const result = await this.#handleMethod(live, method, params)
        await this.#reply(live, frame.id, result)
      } catch (error) {
        const failure =
          error instanceof FakeRpcError ? error.failure : { reason: 'INTERNAL', message: String(error) }
        await this.#reply(live, frame.id, undefined, failure)
      }
    } finally {
      this.#inFlight -= 1
    }
  }

  async #handleMethod(
    live: LiveConnection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.#options.requestDelayMs !== undefined) await sleep(this.#options.requestDelayMs)
    switch (method) {
      case 'connection.hello':
        return this.#handleHello(live)
      case 'connection.authenticate':
        return this.#handleAuthenticate(params)
      case 'connection.refresh':
        return this.#handleRefresh()
      case 'connection.ping':
        return { nonce: params['nonce'], serverTime: new Date().toISOString() }
      default:
        throw new FakeRpcError({ reason: 'NOT_FOUND', message: `unknown method ${method}` })
    }
  }

  #handleHello(live: LiveConnection): Record<string, unknown> {
    const offered = [...live.channel.offeredVersions]
    const echoed = this.#lastHelloProtocolVersions
    // Ruling: the peer compares the hello echo against the prelude offer
    // INDEX BY INDEX (length and position). Set equality is not enough — a
    // permuted echo must fail even though it holds the same set.
    this.#helloEchoMatchesOffer =
      echoed !== undefined && echoed.length === offered.length && echoed.every((v, i) => v === offered[i])
    if (!this.#helloEchoMatchesOffer) {
      throw new FakeRpcError({
        reason: 'INVALID_CONNECTION_STATE',
        message: 'hello protocolVersions must equal the handshake offer element-wise',
      })
    }
    const hello = this.#options.hello ?? {}
    return {
      protocolVersion: live.channel.protocolVersion,
      ...(hello.omitLimits ? {} : { limits: hello.limits ?? {} }),
      ...(hello.omitHeartbeatMs ? {} : { heartbeatMs: hello.heartbeatMs ?? 20_000 }),
    }
  }

  #handleAuthenticate(params: Record<string, unknown>): Record<string, unknown> {
    if (this.#authenticateFailure !== undefined) throw new FakeRpcError(this.#authenticateFailure)
    const token = this.#issueToken()
    return {
      authorization: { grants: [{ domain: 'agent', grantId: 'grant-1' }] },
      accessToken: token.token,
      expiresAt: new Date(token.expiresAt).toISOString(),
      deviceId: params['deviceId'],
    }
  }

  #handleRefresh(): Record<string, unknown> {
    this.#refreshCalls.push(Date.now())
    if (this.#refreshFailure !== undefined) throw new FakeRpcError(this.#refreshFailure)
    const token = this.#issueToken()
    return {
      authorization: { grants: [{ domain: 'agent', grantId: 'grant-1' }] },
      accessToken: token.token,
      expiresAt: new Date(token.expiresAt).toISOString(),
    }
  }

  #issueToken(): IssuedToken {
    const at = Date.now()
    const issued: IssuedToken = {
      token: `tok-${randomUUID()}`,
      at,
      expiresAt: at + (this.#options.tokenTtlMs ?? 600_000),
    }
    this.#tokenIssues.push(issued)
    return issued
  }

  #countArrival(method: string): void {
    this.#requestCount += 1
    this.#requestTimestamps.push(Date.now())
    this.#methodCounts.set(method, (this.#methodCounts.get(method) ?? 0) + 1)
  }

  async #reply(
    live: LiveConnection,
    id: unknown,
    result: Record<string, unknown> | undefined,
    failure?: { reason: string; message: string },
  ): Promise<void> {
    const frame =
      failure === undefined
        ? { jsonrpc: '2.0', id, result: result ?? {} }
        : {
            jsonrpc: '2.0',
            id,
            error: { code: JSON_RPC_ERROR_CODE, message: failure.message, data: { ...failure } },
          }
    try {
      await live.channel.write(frame)
    } catch {
      // The client vanished mid-reply; nothing to do.
    }
  }

  /**
   * Whole-session rate termination: over-budget closes the socket with 1011
   * and returns true. Per-connection (per-socket) counting only — no global
   * scheduling, mirroring the real desktop's per-connection rate window.
   */
  #rateLimited(live: LiveConnection): boolean {
    const budget = this.#options.rateLimitPerSecond
    if (budget === undefined) return false
    const now = Date.now()
    const inWindow = this.#requestTimestamps.filter((t) => now - t < 1000).length
    if (inWindow <= budget) return false
    live.socket.close(1011, 'rate limit exceeded')
    return true
  }
}

/**
 * Max number of request timestamps falling inside any 1-second sliding
 * window — the assertion currency of the client rate-smoothing test.
 */
export function maxRequestsInAnyOneSecondWindow(timestamps: readonly number[]): number {
  let max = 0
  for (let i = 0; i < timestamps.length; i += 1) {
    const count = timestamps.filter((t) => timestamps[i]! <= t && t < timestamps[i]! + 1000).length
    if (count > max) max = count
  }
  return max
}
