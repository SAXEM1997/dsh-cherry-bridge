import { randomUUID } from 'node:crypto'
import type { DeviceRecord } from './deviceStore'
import type { DeviceStore } from './deviceStore'
import type { DeviceState } from './connection'
import { PairingError } from './pairing'
import type { PairWithPayloadOptions } from './pairing'

/**
 * The plugin's same-origin HTTP face (spec §3.7, M2): device management REST
 * plus an SSE stream, mounted on the HOST web server's `/cherry-remote/api`
 * prefix. There is no dedicated port, no bootstrap file and no credential
 * channel — the settings page and this surface are same-origin by construction.
 *
 * Two disciplines run through every route:
 *
 *  - **The trust fence is per-route and unconditional** (ruling 1): the host
 *    owns the listen address, but DNS rebinding and cross-site requests are
 *    the plugin's problem, so `isTrustedWebRequest` guards each handler before
 *    any work happens.
 *  - **No route throws.** Every failure leaves as a structured JSON body, and
 *    the pairing verdicts stay distinguishable (`invalid-payload` is the
 *    client's 400; `unreachable`/`rejected`/`expired` are the peer's 502).
 *
 * Registration is lazy and headless-safe: `registerHttpApi` dynamically
 * injects `webServer`/`webRuntime` and degrades to a warning when the
 * deployment has no web half.
 */

/** The plugin's route prefix: an absolute pathname with no trailing slash. */
export const HTTP_API_PREFIX = '/cherry-remote/api'

/** SSE heartbeat cadence; keeps proxies from reaping an idle stream. */
const HEARTBEAT_MS = 30_000

// ---------------------------------------------------------------------------
// Host service seams
// ---------------------------------------------------------------------------
//
// Structural types, deliberately narrow: the host's `WebServer.register` and
// `webRuntime` are not imported as types, so the plugin neither depends on a
// host package at build time nor breaks when the host's declarations move.
// @deepseek-ai/dsh-host-webserver's WebServer.register/WebRoute and
// @deepseek-ai/dsh-web-app's WebRuntimeValues satisfy these shapes exactly.

/** One HTTP request, as the routes read it (Node's IncomingMessage fits). */
export interface HttpRequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on?(event: 'close', listener: () => void): unknown
  [Symbol.asyncIterator]?(): AsyncIterator<Uint8Array>
}

/** One HTTP response, as the routes write it (Node's ServerResponse fits). */
export interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string | number>): unknown
  write(chunk: string): unknown
  end(chunk?: string): unknown
  on?(event: 'close', listener: () => void): unknown
}

/** The host's named-route registration contract. */
export interface WebServerLike {
  /** Register one named route; returns the disposer removing it. */
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: WebRouteHandler }): () => void
}

export type WebRouteHandler = (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>

/** The bind-dependent Web values the fence needs. */
export interface WebRuntimeLike {
  /** LAN literals followed by explicit invocation authorities. */
  trustedHosts: readonly string[]
}

/** The context carrying the host's web services. */
export interface CherryHttpContext {
  webServer?: WebServerLike
  webRuntime?: WebRuntimeLike
  inject?<T>(deps: string[], callback: (ctx: T) => void | (() => void)): unknown
}

// ---------------------------------------------------------------------------
// Wire shapes (the shared Task 11/12 minimum contract)
// ---------------------------------------------------------------------------

/** One device as the settings page sees it. Never carries a credential. */
export interface DeviceSummary {
  deviceId: string
  displayName: string
  state: DeviceState
  enabled: boolean
  hosts: string[]
  port: number
}

/** The `device-state` SSE payload. */
export interface DeviceStateEvent {
  deviceId: string
  state: DeviceState
}

/** The `pairing-progress` SSE payload; `stage` is the pairing stage verbatim. */
export interface PairingProgressEvent {
  stage: string
  detail?: string
}

/** The subset of {@link DeviceConnection} this face consumes. */
export interface ConnectionLike {
  readonly state: DeviceState
  onState(cb: (state: DeviceState) => void): void
  /** Starts (or joins) the supervised lifecycle. */
  connect(): Promise<void> | unknown
  close(): Promise<void> | unknown
}

/** Everything the HTTP face needs from the assembly. */
export interface CherryHttpDeps {
  store: DeviceStore
  /** `pairWithPayload` (Task 6). The `cherry_pair` tool does not exist in M2. */
  pair: (opts: PairWithPayloadOptions) => Promise<DeviceRecord>
  /**
   * The local Ed25519 identity. A lazy accessor rather than raw bytes: the
   * assembly loads the key asynchronously during `apply`, and pairing is the
   * only consumer, so reading it at request time keeps `apply` synchronous.
   */
  identity(): Uint8Array
  connect(deviceId: string): ConnectionLike
  /**
   * Resolves an ALREADY-CREATED connection, or undefined when the device has
   * none. Used by DELETE, which must tear down a live socket without
   * fabricating a connection for the record it is removing.
   */
  detach?(deviceId: string): ConnectionLike | undefined
  /**
   * Drops the pooled connection for one device (closing it), so the next
   * `connect()` reconstructs from the CURRENT store record.
   *
   * This is required, not an optimization: a `DeviceConnection` captures its
   * `DeviceRecord` at construction and never re-reads it, so a pooled
   * instance cannot observe an edited address or a flipped `enabled` flag.
   * Without eviction, PATCH address maintenance silently keeps dialing the
   * old address, and disable→enable reuses an instance still holding
   * `enabled:false` (whose `connect()` short-circuits to `disabled` forever).
   */
  evict?(deviceId: string): void
  /** Assembly channel: one device's state changed. */
  onDeviceState(cb: (event: DeviceStateEvent) => void): void
  /** Assembly channel: one pairing run advanced a stage. */
  onPairingProgress(cb: (event: PairingProgressEvent) => void): void
}

// ---------------------------------------------------------------------------
// Trust fence (ruling 1)
// ---------------------------------------------------------------------------

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  // Any IPv4 address in 127/8 is loopback: the whole range, not just 127.0.0.1,
  // because a host may bind 127.0.0.53 and a browser may name it.
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

interface Authority {
  hostname: string
  host: string
  /** True when the entry wrote no port at all (the port-less LAN shape). */
  bare: boolean
}

/** Canonical authority of a `trustedHosts` entry or a `Host` header. */
function parseAuthority(authority: string): Authority | undefined {
  if (typeof authority !== 'string' || authority.length === 0) return undefined
  try {
    const url = new URL(`http://${authority}`)
    return url.hostname === '' ? undefined : { hostname: url.hostname, host: url.host, bare: url.port === '' }
  } catch {
    return undefined
  }
}

/**
 * Whether the request authority is a deployment-declared trusted host.
 *
 * A port-less entry matches the hostname on any port (the shape the CLI derives
 * for IP-literal LAN serving, where the bound port may be OS-assigned); an
 * entry with an explicit port matches that exact authority.
 */
function isTrustedAuthority(hostUrl: Authority, trustedHosts: readonly string[]): boolean {
  for (const entry of trustedHosts) {
    const parsed = parseAuthority(entry)
    if (parsed === undefined) continue
    if (parsed.bare ? parsed.hostname === hostUrl.hostname : parsed.host === hostUrl.host) return true
  }
  return false
}

/**
 * The browser-trust fence, applied on EVERY route before any work.
 *
 * Two confused-deputy paths are closed: DNS rebinding (a name the attacker
 * controls resolving to this server) and cross-site requests fired from a
 * malicious page. `Host` is judged first and unconditionally — over plain HTTP
 * a browser attaches neither `Origin` nor Fetch Metadata to reads, so an
 * unmarked request may still be a rebound browser read, and Host is the one
 * header rebinding cannot forge.
 *
 * The four branches, in order:
 *  1. non-loopback / undeclared Host → reject;
 *  2. `sec-fetch-site: cross-site` → reject;
 *  3. attached `Origin` not same-origin with Host → reject;
 *  4. **absent `Origin` → admit** — that is a non-browser client (curl, a
 *     same-host script), not a browser doing a cross-site request.
 */
export function isTrustedWebRequest(
  request: Pick<HttpRequestLike, 'headers'>,
  trustedHosts: readonly string[] = [],
): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

function writeJson(res: HttpResponseLike, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Structured rejection: 403 for the fence, `{error}` for everything else. */
function writeError(res: HttpResponseLike, status: number, error: string, message?: string): void {
  writeJson(res, status, message === undefined ? { error } : { error, message })
}

const MAX_BODY_BYTES = 1024 * 1024

/** Reads and parses a JSON request body; throws a body-level error on refusal. */
async function readJsonBody(req: HttpRequestLike): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let length = 0
  if (req[Symbol.asyncIterator] !== undefined) {
    for await (const chunk of req as AsyncIterable<Uint8Array>) {
      length += chunk.length
      if (length > MAX_BODY_BYTES) throw new Error('request body exceeds 1 MiB')
      chunks.push(Buffer.from(chunk))
    }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

interface RouteMatch {
  segments: string[]
}

/** Splits the pathname under the API prefix; undefined = not this route's. */
function matchPath(req: HttpRequestLike): RouteMatch | undefined {
  let pathname: string
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    return undefined
  }
  if (pathname === HTTP_API_PREFIX) return { segments: [] }
  if (!pathname.startsWith(`${HTTP_API_PREFIX}/`)) return undefined
  const rest = pathname.slice(HTTP_API_PREFIX.length + 1)
  return { segments: rest.split('/').filter((segment) => segment !== '') }
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// PATCH body validation
// ---------------------------------------------------------------------------

/** Field caps mirroring pairing's payload rules (spec §3.3 step 1). */
const HOST_MAX = 256
const DISPLAY_NAME_MAX = 64
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** A validation refusal, mapped to 400 by the route. */
class PatchError extends Error {}

/**
 * Normalizes one candidate host the same way pairing does: the archive stores
 * bare hosts, and a bracketed IPv6 literal is unwrapped (a bracketed non-literal
 * is refused rather than silently rewritten).
 */
function normalizeHost(raw: string): string {
  if (raw.length === 0) throw new PatchError('hosts must not contain an empty entry')
  if (raw.length > HOST_MAX) throw new PatchError(`hosts entry exceeds ${HOST_MAX} characters`)
  const bracketed = raw.startsWith('[') && raw.endsWith(']')
  if (!bracketed) return raw
  try {
    new URL(`http://${raw}/`)
  } catch {
    throw new PatchError(`hosts entry "${raw}" is not a valid IPv6 literal`)
  }
  return raw.slice(1, -1)
}

/** The validated PATCH body: every field optional, every present field judged. */
interface DevicePatch {
  displayName?: string
  enabled?: boolean
  hosts?: string[]
  port?: number
}

/**
 * Validates a PATCH body. `hosts` is WHOLE-REPLACE by contract, and `port` is
 * shared by every host (spec §3.2) — there is no per-host port and no merge
 * semantics to get wrong.
 */
function parsePatch(body: Record<string, unknown>): DevicePatch {
  const patch: DevicePatch = {}

  const displayName = body['displayName']
  if (displayName !== undefined) {
    if (typeof displayName !== 'string') throw new PatchError('displayName must be a string')
    if (displayName.length === 0) throw new PatchError('displayName must not be empty')
    if (displayName.length > DISPLAY_NAME_MAX) {
      throw new PatchError(`displayName exceeds ${DISPLAY_NAME_MAX} characters`)
    }
    if (LONE_SURROGATE_RE.test(displayName)) throw new PatchError('displayName is not valid unicode text')
    patch.displayName = displayName
  }

  const enabled = body['enabled']
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') throw new PatchError('enabled must be a boolean')
    patch.enabled = enabled
  }

  const hosts = body['hosts']
  if (hosts !== undefined) {
    // Whole-replace needs a whole list: an empty array would leave a device
    // with no candidate address at all, which is a broken record, not an edit.
    if (!Array.isArray(hosts) || hosts.length === 0) {
      throw new PatchError('hosts must be a non-empty array')
    }
    patch.hosts = hosts.map((entry) => {
      if (typeof entry !== 'string') throw new PatchError('hosts entries must be strings')
      return normalizeHost(entry)
    })
  }

  const port = body['port']
  if (port !== undefined) {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new PatchError('port must be an integer in 1..65535')
    }
    patch.port = port
  }

  return patch
}

// ---------------------------------------------------------------------------
// SSE hub
// ---------------------------------------------------------------------------

interface SseClient {
  res: HttpResponseLike
  req: HttpRequestLike
}

/**
 * The same-origin event stream: device states plus pairing progress.
 *
 * Per the shared contract, a NEW subscriber is pushed one `device-state` frame
 * per known device before anything else, so the client's first render already
 * has initial state instead of waiting for a change. Disconnects remove the
 * client and stop the heartbeat once the last one leaves (a leaked interval
 * would keep the process alive; Review Focus #5 covers the dispose path too).
 */
class SseHub {
  readonly #clients = new Set<SseClient>()
  #timer: ReturnType<typeof setInterval> | undefined
  #disposed = false

  constructor(private readonly deps: CherryHttpDeps) {}

  /** Starts observing the assembly channels. Called once, after registration. */
  start(): void {
    this.deps.onDeviceState((event) => this.publish('device-state', event))
    this.deps.onPairingProgress((event) => this.publish('pairing-progress', event))
  }

  subscribe(req: HttpRequestLike, res: HttpResponseLike): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const client: SseClient = { req, res }
    this.#clients.add(client)
    const close = (): void => this.#remove(client)
    req.on?.('close', close)
    res.on?.('close', close)

    // First frame: the current full state, one frame per known device.
    for (const device of this.#snapshot()) {
      this.#write(client, 'device-state', { deviceId: device.deviceId, state: device.state })
    }

    this.#ensureHeartbeat()
  }

  publish(event: 'device-state' | 'pairing-progress', payload: unknown): void {
    for (const client of [...this.#clients]) this.#write(client, event, payload)
  }

  /** Live device projections, sourced from the record + its connection state. */
  #snapshot(): Array<{ deviceId: string; state: DeviceState }> {
    return this.deps.store.list().map((device) => ({
      deviceId: device.deviceId,
      state: projectState(device, this.deps.connect),
    }))
  }

  #write(client: SseClient, event: string, payload: unknown): void {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch {
      this.#remove(client)
    }
  }

  #ensureHeartbeat(): void {
    if (this.#timer !== undefined || this.#clients.size === 0) return
    this.#timer = setInterval(() => {
      for (const client of [...this.#clients]) {
        try {
          client.res.write(`: ping ${Date.now()}\n\n`)
        } catch {
          this.#remove(client)
        }
      }
    }, HEARTBEAT_MS)
    this.#timer.unref?.()
  }

  #remove(client: SseClient): void {
    if (!this.#clients.delete(client)) return
    if (this.#clients.size === 0 && this.#timer !== undefined) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
  }

  /** Ends every live stream and stops the heartbeat. */
  dispose(): void {
    this.#disposed = true
    if (this.#timer !== undefined) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
    for (const client of [...this.#clients]) {
      try {
        client.res.end()
      } catch {
        // The client is already gone; nothing to close.
      }
    }
    this.#clients.clear()
  }

  get disposed(): boolean {
    return this.#disposed
  }
}

/**
 * The projected state of one device (ruling 7): a device the user disabled is
 * `disabled` regardless of what its connection last reported, and a device
 * whose connection has not been built yet is `offline` — the same honest
 * "unknown" the connection starts from.
 */
function projectState(device: DeviceRecord, connect: (deviceId: string) => ConnectionLike): DeviceState {
  if (!device.enabled) return 'disabled'
  try {
    return connect(device.deviceId).state
  } catch {
    return 'offline'
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Maps a pairing failure to the HTTP verdict; invalid payload ≠ peer failure. */
function pairingVerdict(error: unknown): { status: number; error: string; message: string } {
  if (error instanceof PairingError) {
    if (error.kind === 'invalid-payload') return { status: 400, error: error.kind, message: error.message }
    return { status: 502, error: error.kind, message: error.message }
  }
  return {
    status: 502,
    error: 'pairing-failed',
    message: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Registers the plugin's same-origin HTTP face on the host's web server.
 *
 * The web services arrive by dynamic injection (the `dsh-mcp-connector`
 * pattern): a headless deployment simply has no `webServer`, so the call warns
 * and skips registration instead of failing the plugin — the tool face stays
 * usable. The returned disposer unregisters the route seat (the host throws on
 * a duplicate `(kind, path)`, so a second `apply` would otherwise fail).
 *
 * The route handler is a SINGLE prefix registration that dispatches the five
 * endpoints internally: one disposer, one fence site, no route-table churn.
 */
export function registerHttpApi(ctx: CherryHttpContext, deps: CherryHttpDeps): () => void {
  if (typeof ctx.inject !== 'function') {
    console.warn('[cherry-remote] webServer unavailable (no dynamic injection); http api not mounted')
    return () => {}
  }

  let disposeRoutes: (() => void) | undefined
  try {
    ctx.inject<{ webServer?: WebServerLike; webRuntime?: WebRuntimeLike }>(
      ['webServer', 'webRuntime'],
      (wctx) => {
        const webServer = wctx.webServer
        if (webServer === undefined) {
          console.warn('[cherry-remote] webServer unavailable; http api not mounted')
          return
        }
        disposeRoutes = mountRoutes(webServer, wctx.webRuntime?.trustedHosts ?? [], deps)
        console.info(`[cherry-remote] http api mounted at ${HTTP_API_PREFIX}`)
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[cherry-remote] http api not mounted (webServer unavailable): ${message}`)
  }

  return () => {
    disposeRoutes?.()
    disposeRoutes = undefined
  }
}

/** Owns one route seat and its SSE hub; returns the teardown for both. */
function mountRoutes(
  webServer: WebServerLike,
  trustedHosts: readonly string[],
  deps: CherryHttpDeps,
): () => void {
  const hub = new SseHub(deps)
  const fence = (req: HttpRequestLike): boolean => isTrustedWebRequest(req, trustedHosts)

  const unregister = webServer.register({
    kind: 'prefix',
    path: HTTP_API_PREFIX,
    handler: (req, res) => handleRequest(req, res, { deps, hub, fence }),
  })

  hub.start()

  return () => {
    unregister?.()
    hub.dispose()
  }
}

interface RouteContext {
  deps: CherryHttpDeps
  hub: SseHub
  fence(req: HttpRequestLike): boolean
}

/**
 * The single dispatcher behind the prefix. It owns the full response lifecycle
 * for every outcome, including the fence verdict and every error path — a
 * handler that throws here would leave the browser waiting on a socket nobody
 * will ever answer.
 */
async function handleRequest(req: HttpRequestLike, res: HttpResponseLike, route: RouteContext): Promise<void> {
  try {
    if (!route.fence(req)) {
      writeError(res, 403, 'forbidden', 'request is not from a trusted same-origin browser')
      return
    }

    const match = matchPath(req)
    if (match === undefined) {
      writeError(res, 404, 'not-found', 'unknown route')
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    const [first, second] = match.segments

    if (match.segments.length === 0) {
      writeError(res, 404, 'not-found', `unknown route (try ${HTTP_API_PREFIX}/devices)`)
      return
    }

    if (first === 'devices' && second === undefined) {
      if (method === 'GET') return listDevices(res, route)
      writeError(res, 405, 'method-not-allowed', 'GET only')
      return
    }

    if (first === 'devices' && match.segments.length === 2 && second !== undefined) {
      const deviceId = decodeSegment(second)
      if (deviceId === undefined) {
        writeError(res, 400, 'invalid-request', 'device id is not valid URL encoding')
        return
      }
      if (method === 'DELETE') return deleteDevice(res, route, deviceId)
      if (method === 'PATCH') return patchDevice(req, res, route, deviceId)
      writeError(res, 405, 'method-not-allowed', 'DELETE or PATCH only')
      return
    }

    if (first === 'pair' && match.segments.length === 1) {
      if (method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'POST only')
        return
      }
      return startPairing(req, res, route)
    }

    if (first === 'events' && match.segments.length === 1) {
      if (method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', 'GET only')
        return
      }
      return openEvents(req, res, route)
    }

    writeError(res, 404, 'not-found', 'unknown route')
  } catch (error) {
    // Defense in depth: the routes below handle their own failures, so reaching
    // here means something unexpected — still never a bare throw.
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[cherry-remote] http api request failed: ${message}`)
    try {
      writeError(res, 500, 'internal-error', message)
    } catch {
      // The response is already committed (an SSE stream, say): nothing to write.
    }
  }
}

function listDevices(res: HttpResponseLike, route: RouteContext): void {
  const devices: DeviceSummary[] = route.deps.store.list().map((device) => ({
    deviceId: device.deviceId,
    displayName: device.displayName,
    state: projectState(device, route.deps.connect),
    enabled: device.enabled,
    hosts: [...device.hosts],
    port: device.port,
  }))
  writeJson(res, 200, devices)
}

function deleteDevice(res: HttpResponseLike, route: RouteContext, deviceId: string): void {
  if (!route.deps.store.list().some((device) => device.deviceId === deviceId)) {
    writeError(res, 404, 'not-found', `no device ${deviceId}`)
    return
  }
  route.deps.store.remove(deviceId)
  // The record is gone, but the connection is not ours to leak: tear down any
  // live one so a removed device stops holding a socket. `detach` (not
  // `connect`) is the right seam — the pool resolves an EXISTING connection
  // and reports `undefined` when there is none, whereas `connect` would
  // fabricate one for a record we just deleted. Failures here are not the
  // browser's problem; the archive is already correct.
  try {
    track(route.deps.detach?.(deviceId)?.close(), (error: unknown) => {
      console.warn(`[cherry-remote] device ${deviceId} disconnect failed after removal`, error)
    })
  } catch (error) {
    console.warn(`[cherry-remote] device ${deviceId} teardown failed after removal`, error)
  }
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}

async function patchDevice(
  req: HttpRequestLike,
  res: HttpResponseLike,
  route: RouteContext,
  deviceId: string,
): Promise<void> {
  const existing = route.deps.store.list().find((device) => device.deviceId === deviceId)
  if (existing === undefined) {
    writeError(res, 404, 'not-found', `no device ${deviceId}`)
    return
  }

  let patch: DevicePatch
  try {
    patch = parsePatch(await readJsonBody(req))
  } catch (error) {
    writeError(
      res,
      400,
      'invalid-request',
      error instanceof Error ? error.message : String(error),
    )
    return
  }

  const previousEnabled = existing.enabled
  const previousHosts = existing.hosts
  const previousPort = existing.port
  const next: DeviceRecord = {
    ...existing,
    ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    // hosts is WHOLE-REPLACE: the patch wins outright, never merges.
    ...(patch.hosts === undefined ? {} : { hosts: patch.hosts }),
    ...(patch.port === undefined ? {} : { port: patch.port }),
  }

  try {
    route.deps.store.upsert(next)
  } catch (error) {
    writeError(res, 400, 'invalid-device', error instanceof Error ? error.message : String(error))
    return
  }

  // Address maintenance must reach the LIVE connection, and a disabled device
  // must not keep one. Both need the pooled instance EVICTED: a
  // `DeviceConnection` captures its record at construction, so a pooled
  // instance would otherwise keep dialing the old address and keep seeing
  // `enabled:false` after a re-enable (its `connect()` would short-circuit to
  // `disabled` forever). Evicting drops the socket and forces the next
  // `connect()` to rebuild from the record we just wrote.
  const addressChanged =
    (patch.hosts !== undefined && !sameHosts(patch.hosts, previousHosts)) ||
    (patch.port !== undefined && patch.port !== previousPort)
  const enabledChanged = patch.enabled !== undefined && patch.enabled !== previousEnabled

  if (addressChanged) {
    evict(route, deviceId)
  }

  if (enabledChanged) {
    // Disable must NOT go through `connect`: that seam creates on miss, and
    // building a connection for a device the user just disabled would bury an
    // `enabled:false` capture in the pool — its `connect()` then short-circuits
    // to `disabled` forever, wedging the device across a later re-enable.
    hibernate(route, deviceId)
  }

  if (enabledChanged && patch.enabled) {
    // Rebuild from the store record, which now carries `enabled:true`.
    try {
      track(route.deps.connect(deviceId).connect(), warnConnect(deviceId))
    } catch (error) {
      console.warn(`[cherry-remote] device ${deviceId} reconnect failed`, error)
    }
  }

  // The response and the SSE frame always report the projection of the record
  // we just wrote: a disabled device is `disabled` regardless of what its
  // connection last said, and an enabled one reports its live state.
  const state = projectState(next, route.deps.connect)
  if (patch.enabled !== undefined && patch.enabled !== previousEnabled) {
    route.hub.publish('device-state', { deviceId, state })
  }

  writeJson(res, 200, {
    deviceId: next.deviceId,
    displayName: next.displayName,
    state,
    enabled: next.enabled,
    hosts: [...next.hosts],
    port: next.port,
  })
}

function warnConnect(deviceId: string): (error: unknown) => void {
  return (error: unknown) => {
    console.warn(`[cherry-remote] device ${deviceId} lifecycle change failed`, error)
  }
}

/** Order-sensitive host comparison: `hosts` is an ordered candidate list. */
function sameHosts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((host, index) => host === b[index])
}

/** Drops the pooled connection, closing any live socket first. */
function evict(route: RouteContext, deviceId: string): void {
  try {
    route.deps.evict?.(deviceId)
  } catch (error) {
    console.warn(`[cherry-remote] device ${deviceId} eviction failed`, error)
  }
}

/**
 * Puts one device to sleep: drop its pooled connection and close the live
 * socket, resolving an EXISTING instance only.
 *
 * The `detach` seam (never `connect`) is what makes this safe — `connect`
 * creates on miss, so a disable would otherwise leave a fresh connection
 * holding `enabled:false` in the pool.
 */
function hibernate(route: RouteContext, deviceId: string): void {
  evict(route, deviceId)
  try {
    track(route.deps.detach?.(deviceId)?.close(), warnConnect(deviceId))
  } catch (error) {
    console.warn(`[cherry-remote] device ${deviceId} disconnect failed`, error)
  }
}

/** Attaches a rejection handler to a lifecycle promise, when one was returned. */
function track(result: unknown, onRejected: (error: unknown) => void): void {
  if (result !== null && typeof (result as PromiseLike<unknown>)?.then === 'function') {
    void (result as PromiseLike<unknown>).then(undefined, onRejected)
  }
}

/**
 * Starts a pairing run and returns IMMEDIATELY (ruling 2).
 *
 * The wire contract is 202 + `{claimId}`, with the 6-digit verification code
 * and the terminal state delivered as `pairing-progress` frames — a browser
 * fetch must not sit open for the whole 120s invitation window, and the card
 * the user is comparing the code against is already rendered.
 *
 * The pairing session is scoped to THIS request's callbacks, so a second
 * concurrent pairing (a second tab) cannot have its code shown in the first
 * tab's stream.
 */
async function startPairing(req: HttpRequestLike, res: HttpResponseLike, route: RouteContext): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(req)
  } catch (error) {
    writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
    return
  }

  const payload = body['payload']
  if (typeof payload !== 'string' || payload.length === 0) {
    writeError(res, 400, 'invalid-request', 'payload must be a non-empty string')
    return
  }
  const name = body['name']
  if (name !== undefined && typeof name !== 'string') {
    writeError(res, 400, 'invalid-request', 'name must be a string')
    return
  }
  if (route.hub.disposed) {
    writeError(res, 503, 'unavailable', 'the plugin http api is shutting down')
    return
  }

  const claimId = randomUUID()

  // Fire-and-forget: the claim id is returned before the first stage lands, so
  // the browser can subscribe to /events with a stable handle in hand.
  void (async () => {
    try {
      await route.deps.pair({
        identity: route.deps.identity(),
        payload,
        store: route.deps.store,
        ...(name === undefined ? {} : { name }),
        // The stage string is forwarded VERBATIM (contract note): no renaming,
        // no wrapping, no enumification between pairing and the wire.
        onStatus: (stage) => route.hub.publish('pairing-progress', { stage }),
        onVerificationCode: (code) => route.hub.publish('pairing-progress', { stage: 'verification-code', detail: code }),
      })
      route.hub.publish('pairing-progress', { stage: 'approved' })
    } catch (error) {
      const verdict = pairingVerdict(error)
      console.warn(`[cherry-remote] pairing ${claimId} failed (${verdict.error}): ${verdict.message}`)
      route.hub.publish('pairing-progress', { stage: verdict.error, detail: verdict.message })
    }
  })()

  writeJson(res, 202, { claimId })
}

function openEvents(req: HttpRequestLike, res: HttpResponseLike, route: RouteContext): void {
  if (route.hub.disposed) {
    writeError(res, 503, 'unavailable', 'the plugin http api is shutting down')
    return
  }
  route.hub.subscribe(req, res)
}
