import { randomUUID } from 'node:crypto'
import { QUARANTINE_RECOVERY, QuarantinedArchiveError } from './deviceStore.js'
import type { DeviceRecord } from './deviceStore.js'
import type { DeviceStore } from './deviceStore.js'
import type { DeviceState, EffectiveLimits } from './connection.js'
import { PairingError } from './pairing.js'
import type { PairWithPayloadOptions } from './pairing.js'
import { CONTRACT_DIFFERENCES, buildDiagnostics, readScopeSegment } from './diagnostics.js'
import type { DiagnosticsError, DiagnosticsStats, SubscriptionStat } from './diagnostics.js'
import type { ScopeDoc, ToolScopeState } from './toolScope.js'
import type { RefreshSummary } from './toolScopeHost.js'

/**
 * The plugin's same-origin HTTP face (spec §3.7): device management REST plus
 * an SSE stream, mounted on the HOST web server's `/cherry-remote/api` prefix.
 * There is no dedicated port, no bootstrap file and no credential channel — the
 * settings page and this surface are same-origin by construction.
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
 *    A QUARANTINED archive gets its own shape rather than the generic
 *    `invalid-device` 400 — see {@link writeQuarantineRefusal}.
 *
 * Registration is lazy and headless-safe: `registerHttpApi` dynamically
 * injects `webServer` alone and degrades to a warning when the deployment has
 * no web half. `trustedHosts` is resolved by optional lookup across host
 * generations — 0.2.0's `webRuntime` or 0.2.1's `webStartup` (issue #7).
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
// the bind-dependent `trustedHosts` values are not imported as types, so the
// plugin neither depends on a host package at build time nor breaks when the
// host's declarations move. @deepseek-ai/dsh-host-webserver's
// WebServer.register/WebRoute satisfies the first; the second is provided as
// DSH 0.2.0's `webRuntime` (WebRuntimeValues) and, since 0.2.1, on the
// `webStartup` service config (issue #7).

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
  /**
   * 0.2.1 only: the explicit `--host` listener bind, when one was given. A
   * bare hostname (never an authority with a port) — the fence's
   * `isTrustedAuthority` matches a bare entry on any port.
   */
  host?: string
}

/** The context carrying the host's web services. */
export interface CherryHttpContext {
  webServer?: WebServerLike
  /**
   * DSH 0.2.0 shape only. 0.2.1-rc.2 removed the service (issue #7), so this is
   * one OPTIONAL source for `trustedHosts` — never an injection key.
   */
  webRuntime?: WebRuntimeLike
  /** cordis' optional service lookup — no inject gate; absent ⇒ `undefined`. */
  get?(name: string): unknown
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
  /** The scheme each host is dialed with (issue #126); see `DeviceRecord`. */
  security: Record<string, 'ws' | 'wss'>
}

/** The `device-state` SSE payload. */
export interface DeviceStateEvent {
  deviceId: string
  state: DeviceState
}

/**
 * The `pairing-progress` SSE payload; `stage` is the pairing stage verbatim.
 *
 * `claimId` is the handle `POST /pair` already returned in its 202. It is on
 * EVERY frame — including the terminal verdicts — because the stream is SHARED
 * by every tab and every run: without it, a browser that has started its own
 * pairing cannot tell its stages (and above all its 6-digit code) from another
 * tab's, and would settle on a stranger's verdict. A client filters frames by
 * the id its own 202 returned.
 *
 * Optional because the assembly channel is also driven by callers that are not
 * a pairing run (a test rig, a future producer) — a frame with no id simply
 * matches no wizard.
 */
export interface PairingProgressEvent {
  stage: string
  detail?: string
  claimId?: string
}

/** The subset of {@link DeviceConnection} this face consumes. */
export interface ConnectionLike {
  readonly state: DeviceState
  /**
   * The peer-negotiated caps (hello values with the client's conservative
   * fallbacks applied). Optional for the same reason `detach`/`evict` are: the
   * HTTP face's own tests drive a state-only stand-in, and a missing limits
   * object must read as "not reported" rather than fail the diagnostics route.
   *
   * NOTE for the diagnostics route: a MISSING `limits` is the honest report
   * when there is no live connection. It is never a reason to build one.
   */
  readonly limits?: EffectiveLimits
  onState(cb: (state: DeviceState) => void): void
  /** Starts (or joins) the supervised lifecycle. */
  connect(): Promise<void> | unknown
  close(): Promise<void> | unknown
}

/** Everything the HTTP face needs from the assembly. */
export interface CherryHttpDeps {
  store: DeviceStore
  /**
   * The scope document's in-memory authority — the ONE owner of the document,
   * the `degraded` set, the judgement generation and the installed-layer
   * records (spec §6.1). REQUIRED, not optional: the `/scope` routes and the
   * diagnostics report dereference it field by field, so a deployment that
   * forgot to wire it must fail at the type level rather than answer 500 at
   * request time.
   */
  scope: ToolScopeState
  /**
   * The scope subsystem's recompute entry (spec §6.2): "save ⇒ immediate
   * effect" is an await-free `save → refreshScope()` call, and the returned
   * summary is the round's own echo. Absent capability (pending/unsupported) or
   * a torn-down mount has no round to run and answers `undefined`.
   */
  refreshScope: () => RefreshSummary | undefined
  /**
   * `pairWithPayload`, as the assembly exposes it. The HTTP face calls it for
   * `POST /pair`; the `cherry_pair` TOOL reaches the same implementation
   * through its own narrower seam, so the two faces cannot drift apart.
   */
  pair: (opts: PairWithPayloadOptions) => Promise<DeviceRecord>
  /**
   * The local Ed25519 identity. A lazy accessor rather than raw bytes: the
   * assembly loads the key asynchronously during `apply`, and pairing is the
   * only consumer, so reading it at request time keeps `apply` synchronous.
   */
  identity(): Uint8Array
  /**
   * Resolve (creating on first use) the pooled connection for a device.
   *
   * CREATE-ON-MISS, and that is load-bearing wherever it is used: the SSE
   * snapshot and the device list both report a device the caller can use, so
   * building the connection the assembly would build anyway is intentional
   * there. It is exactly why `GET /diagnostics` must NOT use it — see
   * {@link detach}.
   */
  connect(deviceId: string): ConnectionLike
  /**
   * Resolves an ALREADY-CREATED connection, or undefined when the device has
   * none. A PURE LOOKUP: it never constructs, never dials, never schedules.
   *
   * Two callers, both because a miss must be an honest answer rather than a
   * fabricated object:
   *  - DELETE, which must tear down a live socket without fabricating a
   *    connection for the record it is removing;
   *  - `GET /diagnostics`, which must report only what a live connection
   *    actually negotiated and must never auto-dial an offline device.
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
   *
   * The return value is AWAITED by its callers when one is given. The assembly's
   * eviction is asynchronous — it releases the peer subscriptions over the
   * still-live socket before closing the connection — and a caller that returned
   * early would let its own follow-up work (DELETE's `store.remove`) land in the
   * middle of that teardown. `void` is still accepted for a synchronous pool.
   */
  evict?(deviceId: string): void | Promise<void>
  /**
   * Assembly channel: one device's state changed. Returns an optional
   * DETACHER — `SseHub.dispose` must remove the callback it registered, because
   * the listener set belongs to the assembly (which outlives one hub) and a
   * hub that never detaches leaves its dead callbacks behind for every
   * subsequent event to fan out to. A channel that has no detach support
   * returns nothing, which is the pre-existing behaviour.
   */
  onDeviceState(cb: (event: DeviceStateEvent) => void): (() => void) | void
  /** Assembly channel: one pairing run advanced a stage. Optional detacher. */
  onPairingProgress(cb: (event: PairingProgressEvent) => void): (() => void) | void

  // --- M4 diagnostics (Task 13) -------------------------------------------
  //
  // All four are OPTIONAL and default to empty: the endpoint must work on a
  // deployment (or a test rig) that never wired a stats source, and an absent
  // source must read as "nothing reported" rather than as a failure. The
  // plugin assembly supplies them from the same pool the tool face uses.

  /** Pool counters: connections, sockets, connectionsBuilt, subscriptions. */
  diagnosticsStats?(): Partial<DiagnosticsStats>
  /** Local per-session subscription bookkeeping (sessionId is whitelisted). */
  diagnosticsSessions?(): readonly SubscriptionStat[]
  /** The ring of recent errors; the sanitizer keeps reason/message only. */
  diagnosticsErrors?(): readonly DiagnosticsError[]
  /** Plan §8 config values, surfaced so an operator can see the effective knobs. */
  diagnosticsConfig?(): { rateBudgetPerSecond: number; perSessionCacheBytes: number }
  /**
   * Assembly channel: a persisting route hit a QUARANTINED archive.
   *
   * The refusal is already structured for the browser; this is how the
   * diagnostics ring learns about it, so `GET /diagnostics` shows the operator
   * what happened instead of leaving the report claiming a healthy (empty)
   * deployment. Optional: a rig that does not wire it simply keeps the ring
   * unchanged, which is the pre-existing behaviour.
   */
  onArchiveQuarantined?(error: QuarantinedArchiveError): void
}

// ---------------------------------------------------------------------------
// Trust fence (ruling 1)
// ---------------------------------------------------------------------------

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Whether a `URL.hostname`-shaped authority names the local machine.
 *
 * The input is the WHATWG host SERIALIZATION, which KEEPS the brackets on an
 * IPv6 literal: `new URL('http://[::1]:23023').hostname` is `'[::1]'` in Node
 * and in the browser alike, so the bracketed spellings below are the real ones.
 * (Review E2-2 claimed the brackets are stripped and the `'[::1]'` literal was
 * therefore dead; that is measurably false — the fence already admitted
 * `[::1]:23023` before this change. Both spellings are accepted so a caller
 * passing a raw `Host` header value gets the same verdict either way.)
 *
 * The gap that WAS real is the IPv4-MAPPED loopback family: a dual-stack
 * listener reached over IPv6 is addressed as `::ffff:127.0.0.1`, and the
 * WHATWG serializer rewrites that to the hex form `[::ffff:7f00:1]`. Those are
 * loopback by any honest reading and now qualify. Only the mapped 127/8 range
 * does — `[::ffff:8.8.8.8]` is NOT loopback, so this is not a blanket "any v6
 * with a ffff: prefix" admission.
 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  // Unwrap the serialization once, then judge the bare address.
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (bare === '::1') return true
  // IPv4-mapped loopback. The dotted-quad spelling of the low 32 bits is the
  // readable one; the serializer emits the hex one, so both are decoded.
  if (bare.startsWith('::ffff:')) {
    const mapped = bare.slice('::ffff:'.length)
    // Hex form (`7f00:1`) — only the `7fxx:xxxx` range is 127/8.
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(mapped)
    if (hex !== null) return Number.parseInt(hex[1]!, 16) >>> 8 === 0x7f
    return isLoopbackHostname(mapped)
  }
  // Any IPv4 address in 127/8 is loopback: the whole range, not just 127.0.0.1,
  // because a host may bind 127.0.0.53 and a browser may name it.
  const parts = bare.split('.')
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

/**
 * The quarantine refusal, as the browser and the operator see it.
 *
 * A damaged `devices.json` is not the request's fault and it is not something
 * the browser can fix: the archive is READ-ONLY until a human moves the bad
 * file aside. So the answer is a 503 with the two paths an operator actually
 * needs — the archive, and the `<file>.corrupt` copy the plugin preserved —
 * plus the recovery step in words. That is the whole point of giving this its
 * own shape rather than letting it land in the generic `invalid-device` 400,
 * which reads as "you sent something wrong" and is the opposite of the truth.
 *
 * Returns true when the error was a quarantine (and a response was written).
 */
function writeQuarantineRefusal(res: HttpResponseLike, route: RouteContext, error: unknown): boolean {
  if (!(error instanceof QuarantinedArchiveError)) return false
  // The operator-facing refusal and the diagnostics ring are told the same
  // thing: the browser gets the structured body, the report gets the summary.
  try {
    route.deps.onArchiveQuarantined?.(error)
  } catch (reportError) {
    console.warn('[cherry-remote] reporting the quarantined archive failed', reportError)
  }
  writeJson(res, 503, {
    error: 'archive-quarantined',
    // The archive that could not be read, byte-for-byte still on disk.
    file: error.file,
    // The best-effort preservation copy; the SAME fallback the error's own
    // message uses, so an operator is never sent to a file that does not exist
    // merely because the copy could not be made.
    corrupt: error.corruptPath ?? `${error.file}.corrupt`,
    // The shared recovery instruction: identical to the one `cherry_pair`
    // returns in-band and the SSE stage publishes, so the three faces cannot
    // drift into three different instructions.
    recovery: QUARANTINE_RECOVERY,
    message: error.message,
  })
  return true
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
  readonly #detachers: Array<() => void> = []
  #timer: ReturnType<typeof setInterval> | undefined
  #disposed = false

  constructor(private readonly deps: CherryHttpDeps) {}

  /**
   * Starts observing the assembly channels. Called once, after registration.
   *
   * Registering is not enough: the listener sets live on the ASSEMBLY, which
   * outlives any one hub, so each detacher is kept and run in {@link dispose}.
   * Without that, a re-apply (a new hub over the same assembly) accumulates one
   * stale pair per cycle, and every later event fans out to hubs that are
   * already closed.
   */
  start(): void {
    const detachDevice = this.deps.onDeviceState((event) => this.publish('device-state', event))
    const detachPairing = this.deps.onPairingProgress((event) => this.publish('pairing-progress', event))
    if (typeof detachDevice === 'function') this.#detachers.push(detachDevice)
    if (typeof detachPairing === 'function') this.#detachers.push(detachPairing)
  }

  subscribe(req: HttpRequestLike, res: HttpResponseLike): void {
    // SNAPSHOT FIRST, headers second. `#snapshot()` reads the archive, which is
    // a legitimate thrower (a quarantined store refuses to be read). Taking it
    // after `writeHead(200, ...)` would mean the throw happens with the response
    // ALREADY COMMITTED: the client gets a 200 it can never use, the SSE client
    // is never registered, and no error status can be sent any more. Reading it
    // first keeps a failed snapshot an ordinary pre-commit failure the caller
    // can still turn into a structured error.
    const snapshot = this.#snapshot()

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
    for (const device of snapshot) {
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

  /** Ends every live stream, detaches the assembly listeners, stops the heartbeat. */
  dispose(): void {
    this.#disposed = true
    // Detach FIRST: a listener that outlives the hub would keep publishing into
    // a hub whose clients are already ended.
    for (const detach of this.#detachers.splice(0)) {
      try {
        detach()
      } catch (error) {
        console.warn('[cherry-remote] sse listener detach failed', error)
      }
    }
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
 * Resolves the deployment's `trustedHosts` across the host GENERATIONS this
 * plugin runs on, in preference order:
 *
 *  1. `ctx.get('webRuntime').trustedHosts` — DSH 0.2.0's bind-dependent values
 *     (the `webRuntime` service; removed again in 0.2.1, issue #7);
 *  2. `ctx.get('webStartup')` — DSH 0.2.1. Its `trustedHosts` are the
 *     `--trusted-host` CLI values, and its `host` is the explicit `--host`
 *     bind. The `host` is appended as a BARE hostname entry, mirroring the
 *     host's own `/api` fence, which admits its listener bind implicitly —
 *     otherwise a LAN-bound deployment that never passed `--trusted-host`
 *     would 403 its own origin. 0.2.0's list already carried the LAN bind
 *     literal (see the module header), so this keeps the generations aligned;
 *  3. `[]` — neither service: the fence stays loopback-only.
 *
 * **Why every step is `ctx.get` and NOT a property read on the injected ctx.**
 * cordis hands the inject callback a strict reflection proxy
 * (`ReflectService.handler.get`): reading a property that is not in the
 * callback's `inject` list THROWS synchronously — `cannot get property
 * "<name>" without inject` — and `?.` does not help, because the getter itself
 * throws. That is exactly how issue #7 shipped broken and then regressed
 * 0.2.0: the first cut read `wctx.webRuntime` from a `['webServer']` callback,
 * so on a real host it threw, `mountRoutes` never ran and NOTHING was mounted.
 * `ctx.get(name)` is the unGATED lookup: absent ⇒ `undefined`, never a throw.
 * The callback may therefore only read the keys it injected
 * ({@link registerHttpApi}); every other source is resolved here.
 *
 * `inject` is an AND gate over its list — the root cause of issue #7 — so no
 * source here may become another injection key. Each step is optional and
 * narrowed structurally ({@link asWebRuntime}), so an old host (no
 * `webStartup`), a new host (no `webRuntime`) and a bare fake all resolve to a
 * list rather than throwing.
 */
export function resolveTrustedHosts(ctx: CherryHttpContext): readonly string[] {
  const runtime = asWebRuntime(ctx.get?.('webRuntime'))
  if (runtime?.trustedHosts !== undefined) return runtime.trustedHosts
  const startup = asWebRuntime(ctx.get?.('webStartup'))
  if (startup?.trustedHosts !== undefined) {
    // The listener bind rides along as a bare hostname, converted to the
    // AUTHORITY shape the fence parses (see `asTrustedEntry`).
    return startup.host === undefined
      ? [...startup.trustedHosts]
      : [...startup.trustedHosts, asTrustedEntry(startup.host)]
  }
  return []
}

/**
 * The listener bind as a `trustedHosts` ENTRY, i.e. an authority the fence can
 * parse.
 *
 * `webStartup.host` is a BARE hostname (`--host fe80::1`), while every entry is
 * an authority: {@link parseAuthority} prefixes `http://` and hands it to WHATWG
 * URL. An IPv6 literal MUST be bracketed in an authority — `new URL('http://fe80::1')`
 * throws — so a folded bare literal was silently unusable, and an IPv6 LAN bind
 * kept only loopback (fail-closed: an availability gap, not a security hole;
 * issue #9). Bracketing is the whole normalization: IPv4 addresses and DNS
 * names already parse as-is, and a value that is already bracketed is left
 * alone, so a hand-written `[fe80::2]` cannot become `[[fe80::2]]` and parse to
 * nothing — re-creating the very gap this closes.
 *
 * A zone-scoped literal (`fe80::1%eth0`, or the `%25` spelling WHATWG URL uses
 * for `%`) still parses to nothing: this runtime's URL rejects zone ids in an
 * IPv6 literal outright, and a browser sends none at all, so it is left to the
 * parser rather than guessed at. A value carrying a PORT (`example.com:8080`)
 * is out of contract — `WebRuntimeLike.host` is a bare hostname — and is
 * bracketed like any other colon-bearing value, which parses to nothing: the
 * entry is dropped rather than trusted, which is the fail-closed direction for
 * a shape the host promises not to produce.
 */
function asTrustedEntry(host: string): string {
  if (host.startsWith('[') || !host.includes(':')) return host
  return `[${host}]`
}

/**
 * Narrows an untyped `ctx.get` answer; anything without a list yields
 * undefined. A 0.2.1 `webStartup` also carries the listener bind as `host`
 * (string, only when `--host` was given explicitly): it is kept for the
 * caller to fold in, and a non-string or empty value is simply dropped.
 */
function asWebRuntime(service: unknown): WebRuntimeLike | undefined {
  if (typeof service !== 'object' || service === null) return undefined
  const { trustedHosts, host } = service as { trustedHosts?: unknown; host?: unknown }
  if (!Array.isArray(trustedHosts)) return undefined
  if (!trustedHosts.every((entry): entry is string => typeof entry === 'string')) return undefined
  const bound = typeof host === 'string' && host.length > 0 ? host : undefined
  return bound === undefined ? { trustedHosts } : { trustedHosts, host: bound }
}

/**
 * Registers the plugin's same-origin HTTP face on the host's web server.
 *
 * The web service arrives by dynamic injection (the `dsh-mcp-connector`
 * pattern): a headless deployment simply has no `webServer`, so the call warns
 * and skips registration instead of failing the plugin — the tool face stays
 * usable. The returned disposer unregisters the route seat (the host throws on
 * a duplicate `(kind, path)`, so a second `apply` would otherwise fail).
 *
 * **Injection shape (issue #7).** The list is `['webServer']` ALONE. It used to
 * be `['webServer', 'webRuntime']`, which cordis reads as an AND: the callback
 * waited for BOTH services. DSH 0.2.1-rc.2 REMOVED `webRuntime` (`trustedHosts`
 * moved to the `webStartup` service config), so the callback never ran — the
 * route was never mounted and the three degradation warnings inside it never
 * printed, leaving a silent, zero-log outage. `webRuntime` is therefore read
 * through the optional {@link resolveTrustedHosts} chain instead of being
 * demanded.
 *
 * The remaining silent failure is `webServer` itself never arriving (a truly
 * headless host, or a future host that renames it). That is NOT distinguishable
 * here from a healthy apply — the callback may legitimately fire later than the
 * call returns — so no "callback did not run" probe is installed: a log that
 * needs a timer would race the host, and console output is suppressed by the
 * very failure modes it would report. The `webServer === undefined` warning
 * inside the callback stays as the one honest signal available.
 *
 * **The callback reads ONLY injected keys.** cordis' injected ctx is a strict
 * reflection proxy whose get trap throws `cannot get property "<name>" without
 * inject` for anything outside the list, so `wctx` here is typed with
 * `webServer` alone and every `trustedHosts` source goes through
 * {@link resolveTrustedHosts} (which uses the unGATED `ctx.get`).
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
    // The payload type is the injection list itself: `webServer` and nothing
    // else may be read off the strict proxy.
    ctx.inject<{ webServer?: WebServerLike }>(['webServer'], (wctx) => {
      const webServer = wctx.webServer
      if (webServer === undefined) {
        console.warn('[cherry-remote] webServer unavailable; http api not mounted')
        return
      }
      disposeRoutes = mountRoutes(webServer, resolveTrustedHosts(ctx), deps)
      console.info(`[cherry-remote] http api mounted at ${HTTP_API_PREFIX}`)
    })
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
      if (method === 'DELETE') return await deleteDevice(res, route, deviceId)
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

    // M4: the operations diagnostics report. It rides the SAME prefix seat and
    // therefore the SAME fence as every other route (ruling 3) — there is no
    // second registration and no second fence site to forget.
    if (first === 'diagnostics' && match.segments.length === 1) {
      if (method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', 'GET only')
        return
      }
      return writeJson(res, 200, diagnosticsReport(route))
    }

    // Task 7 (§6.3): the scope document's read/write face. It rides the SAME
    // prefix seat as every other route and therefore the SAME fence — there is
    // no second registration and no second fence site to forget.
    if (first === 'scope' && match.segments.length === 1) {
      if (method === 'GET') return scopeSnapshot(res, route)
      if (method === 'PUT') return await saveScopeDocument(req, res, route)
      // The method verdict comes FIRST: a refused method neither reads the body
      // nor touches the stored document.
      writeError(res, 405, 'method-not-allowed', 'GET/PUT only')
      return
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
    security: { ...device.security },
  }))
  writeJson(res, 200, devices)
}

/**
 * The `GET /diagnostics` body (spec §5).
 *
 * The aggregator in `src/diagnostics.ts` owns the redaction whitelist; this
 * function only supplies it with the live pool surfaces, as a state projection
 * (not the connection object) so nothing but a state string and four numbers
 * can escape into the report — a caller cannot accidentally serialize a
 * connection holding a live token.
 *
 * THE SEAM HANDED TO THE AGGREGATOR NEVER BUILDS A CONNECTION. The aggregator's
 * `connect` is named for the pool's resolver, but here it resolves an EXISTING
 * entry only (see {@link deviceProjection}): a GET must be a read, and a
 * report that dials is both a surprise socket and a fabricated `limits`.
 *
 * The six contract differences ride along so an operator reads the fake-vs-real
 * caveats in the same place they read the health of the deployment.
 */
function diagnosticsReport(route: RouteContext): unknown {
  const deps = route.deps
  const config = safely(() => deps.diagnosticsConfig?.(), undefined)
  return {
    ...buildDiagnostics({
      store: deps.store,
      // A state projection, never the connection object: only the state string
      // and the peer-negotiated numeric limits can reach the report, so a live
      // token held by the connection cannot be serialized by accident.
      connect: (deviceId) => deviceProjection(deps, deviceId),
      stats: () => safely(() => deps.diagnosticsStats?.(), {}),
      sessions: () => safely(() => deps.diagnosticsSessions?.(), []),
      recentErrors: () => safely(() => deps.diagnosticsErrors?.(), []),
      // THE SAME READ as `GET /scope` below: one function, one `deps.scope`
      // object. The report's `scope.host` is therefore not a second copy that a
      // later `setHost` could leave behind — it is that read (Task 9 ②), and a
      // read that throws costs its own segment only (`buildDiagnostics` guards
      // every source, this one included).
      scope: () => readScopeSegment(deps.scope),
    }),
    // Effective config is appended AFTER the aggregator's own projection: both
    // keys are numbers the plugin already logs, never a credential.
    ...(config === undefined ? {} : { config }),
    contractDifferences: CONTRACT_DIFFERENCES.map((entry) => ({ id: entry.id, title: entry.title })),
  }
}

// ---------------------------------------------------------------------------
// The scope document face (Task 7 / spec §6.3)
// ---------------------------------------------------------------------------

/**
 * `GET /cherry-remote/api/scope`: the whole scope state in ONE body.
 *
 * The workspace list is read from the registry by the PLUGIN and projected DOWN
 * (id/title/path only) because the browser cannot reach the registry at all;
 * `sessionIds` is judgement input, not page state, and stays behind.
 *
 * `staleWorkspaceIds` and `pathUnmatched` are two SEPARATE channels beside
 * `host`, on purpose (§6.1): "an id the registry no longer has" and "this
 * session's cwd belongs to no registered workspace" are different answers, and
 * neither may be derived from the other. `degraded` is an ARRAY inside `host` —
 * same source deduplicated (latest reason), different sources coexisting — and
 * an empty array is the honest "no degradation".
 *
 * `host` and `pathUnmatched` come out of {@link readScopeSegment} — the very
 * call the diagnostics report reads its `scope` segment through, so the two
 * faces serve ONE read of ONE scope state and cannot drift apart (Task 9 ②).
 */
function scopeSnapshot(res: HttpResponseLike, route: RouteContext): void {
  const scope = route.deps.scope
  const read = readScopeSegment(scope)
  writeJson(res, 200, {
    scope: scopeProjection(scope.doc()),
    workspaces: scope.workspaces().map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
    })),
    staleWorkspaceIds: [...scope.staleWorkspaceIds()],
    pathUnmatched: read.pathUnmatched,
    host: read.host,
  })
}

/**
 * The three fields the write side accepts back, as every response carries them.
 *
 * Projected field by field rather than spread: `version`/`updatedAt` are the
 * persistence layer's business, and the settings page's read-modify-write cycle
 * needs exactly the document it can PUT back beside a base `revision`.
 */
function scopeProjection(
  doc: Pick<ScopeDoc, 'mode' | 'workspaceIds' | 'revision'>,
): Pick<ScopeDoc, 'mode' | 'workspaceIds' | 'revision'> {
  return { mode: doc.mode, workspaceIds: [...doc.workspaceIds], revision: doc.revision }
}

/**
 * `PUT /cherry-remote/api/scope`: validate and commit, then refresh.
 *
 * The shape exists for the ONE await-free critical section at its end. `save()`
 * validates the base revision, prunes, bumps the revision by exactly one, writes
 * the file and swaps the in-memory authority — all synchronously — and
 * `refreshScope()` is called in the very next statement. An `await` anywhere
 * between the two would let two concurrent saves both pass the revision check,
 * after which the later write silently overwrites the earlier one.
 *
 * The refresh is NOT awaited and its summary is NOT published (R24): that
 * summary describes the synchronous pass the call itself ran, while convergence
 * — the recompute round it triggers plus the catch-up pass the coalescing gate
 * owes it — rides behind the response. What the caller gets back is the
 * authoritative new state: the normalized document (with the pruned ids gone)
 * and the new revision its next write must base itself on.
 */
async function saveScopeDocument(
  req: HttpRequestLike,
  res: HttpResponseLike,
  route: RouteContext,
): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(req)
  } catch (error) {
    // The module's existing body-level refusal, the same one `POST /pair` uses:
    // a body that cannot be read at all is not a scope-FIELD verdict, so it must
    // not be dressed up as `invalid-scope`.
    writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
    return
  }

  // `expectedRevision` travels beside the document, exactly as the read-modify-
  // write cycle carries it back. The refusal STATUS and the stable error code
  // are the scope state's verdict — this face only transports them verbatim
  // (400 invalid-scope / missing-expected-revision, 409 scope-revision-conflict,
  // 503 workspace-list-unavailable / scope-version-unsupported).
  const result = route.deps.scope.save(body, body.expectedRevision)
  if (!result.ok) {
    writeError(res, result.status, result.error, result.message)
    return
  }

  // NO `await` between the save above and this call (§6.3's hard constraint).
  route.deps.refreshScope()
  writeJson(res, 200, { scope: scopeProjection(result.doc), pruned: [...result.pruned] })
}

/**
 * One device's diagnostics projection: the live state plus, when a connection
 * actually EXISTS, the limits the peer's hello negotiated.
 *
 * A DIAGNOSTICS ENDPOINT MUST NOT HAVE SIDE EFFECTS, and `connect` is a
 * side-effecting seam: it RESOLVES *and* CREATES on miss, so probing it here
 * would auto-dial every offline device in the archive — an operator asking for a
 * health report would be the thing that opens sockets — and would then publish
 * the freshly built connection's conservative client FALLBACKS as if the peer
 * had negotiated them.
 *
 * So `limits` is read through `detach` (resolve-EXISTING-only) and only through
 * it. Consequences, both intended:
 *  - a device with no pooled connection reports its state from the store/enabled
 *    projection and carries NO `limits` field at all (absent means "not
 *    reported", which is the truth — nothing has been negotiated);
 *  - `detach` is optional on the deps contract, so a rig that supplies only
 *    `connect` gets the no-limits shape rather than a fabricated one. Falling
 *    back to `connect` would reinstate the dial.
 */
function deviceProjection(
  deps: CherryHttpDeps,
  deviceId: string,
): { state: DeviceState; limits?: EffectiveLimits } {
  const record = deviceById(deps, deviceId)
  const existing = safely(() => deps.detach?.(deviceId))
  // The state comes from the EXISTING connection when there is one, and from
  // the store/enabled projection otherwise — never from a connection built for
  // this request.
  const state = existing === undefined ? projectState(record, noDial) : safeState(existing, record)
  const limits = existing?.limits
  return limits === undefined ? { state } : { state, limits }
}

/** A resolver that never builds anything: the honest "no connection" report. */
function noDial(deviceId: string): ConnectionLike {
  throw new Error(`diagnostics does not build a connection for ${deviceId}`)
}

/** One already-existing connection's state, or the record's projection. */
function safeState(connection: ConnectionLike, record: DeviceRecord): DeviceState {
  if (!record.enabled) return 'disabled'
  try {
    return connection.state
  } catch {
    return 'offline'
  }
}

/** Resolves one record for the state projection, or a disabled stand-in. */
function deviceById(deps: CherryHttpDeps, deviceId: string): DeviceRecord {
  const found = deps.store.list().find((device) => device.deviceId === deviceId)
  if (found !== undefined) return found
  return {
    schemaVersion: 3,
    deviceId,
    displayName: '',
    hosts: [],
    port: 0,
    security: {},
    desktopIdentity: '',
    grants: [],
    enabled: false,
  }
}

/**
 * Runs one optional source, falling back when it is absent OR throws.
 *
 * An overload pair rather than one signature: with a fallback the result is
 * ALWAYS `T` (the whole point of passing one), while the no-fallback call site
 * gets `T | undefined` so "this source genuinely has nothing" stays expressible.
 */
function safely<T>(read: () => T | undefined, fallback: T): T
function safely<T>(read: () => T | undefined): T | undefined
function safely<T>(read: () => T | undefined, fallback?: T): T | undefined {
  try {
    return read() ?? fallback
  } catch {
    return fallback
  }
}

async function deleteDevice(res: HttpResponseLike, route: RouteContext, deviceId: string): Promise<void> {
  if (!route.deps.store.list().some((device) => device.deviceId === deviceId)) {
    writeError(res, 404, 'not-found', `no device ${deviceId}`)
    return
  }
  // ORDER MATTERS, and it is the SAME invariant `cherry_unpair` documents:
  // EVICT FIRST, then remove the record. `evict` resolves an EXISTING pooled
  // connection only (never `connect`, which creates on miss and would fabricate
  // one for a record being deleted), drops it from the pool AND closes its
  // socket. The other order leaves a window in which the archive entry — and
  // with it the accessToken — is gone while a socket still authenticated with
  // that token is up, which is exactly the leak this teardown exists to prevent.
  //
  // The eviction is AWAITED, which is the second half of that invariant and not
  // a formality. `evict` claims the device's pool entries synchronously and then
  // spends real time releasing them: the subscription layer goes first (it
  // closes the peer subscriptions over the still-live socket, so the desktop
  // frees their slots instead of reaping them on a timeout), and only then is
  // the connection closed. Returning early would let `store.remove` land in the
  // middle of that sequence — the record and its token discarded while the
  // socket is still up and the peer still holds subscriptions for a device this
  // harness no longer knows about. `cherry_unpair` awaits for the same reason;
  // this route is its other caller and must not be the weaker one.
  //
  // The record is still present throughout, which matters: the assembly's
  // eviction reads it to dispose the device's subscription layer before closing
  // the socket. Failures here are not the browser's problem; the archive edit
  // below is what the caller asked for, and it still happens.
  try {
    await route.deps.evict?.(deviceId)
  } catch (error) {
    console.warn(`[cherry-remote] device ${deviceId} teardown failed before removal`, error)
  }
  try {
    route.deps.store.remove(deviceId)
  } catch (error) {
    // The record survives in the archive (the write refused), so the caller is
    // told the truth: the removal did NOT happen. Same structured shape as
    // PATCH's, so one client branch covers both.
    if (writeQuarantineRefusal(res, route, error)) return
    // Anything else is genuinely unexpected; still never a bare throw.
    console.warn(`[cherry-remote] device ${deviceId} could not be removed`, error)
    writeError(res, 500, 'internal-error', error instanceof Error ? error.message : String(error))
    return
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
  const previousSecurity = existing.security
  const next: DeviceRecord = {
    ...existing,
    ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    // hosts is WHOLE-REPLACE: the patch wins outright, never merges. The
    // scheme map is keyed by host, so replacing the host list drops the
    // entries for hosts that are gone and defaults the new ones to `ws` —
    // keeping the OLD schemes indexed by the NEW list would be a stale
    // pairing of host to scheme (issue #126).
    ...(patch.hosts === undefined ? {} : { hosts: patch.hosts, security: securityFor(patch.hosts, previousSecurity) }),
    ...(patch.port === undefined ? {} : { port: patch.port }),
  }

  try {
    route.deps.store.upsert(next)
  } catch (error) {
    // A QUARANTINE is mapped first and distinctly: it is not a bad request body
    // (the 400 below), it is an archive a human has to repair, and the browser
    // is told which two files and what to do.
    if (writeQuarantineRefusal(res, route, error)) return
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
    (patch.port !== undefined && patch.port !== previousPort) ||
    !sameSecurity(next.security, previousSecurity)
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
    security: { ...next.security },
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

/**
 * The scheme map for a WHOLE-REPLACE host list (issue #126): each named host
 * keeps the scheme it was dialed with, a host the list just gained defaults to
 * `ws`, and hosts the list dropped leave no entry behind. An edit is an
 * address edit, not a scheme edit — re-typing the same host must not silently
 * demote a TLS-proxied desktop to a plain dial.
 */
function securityFor(
  hosts: readonly string[],
  previous: Record<string, 'ws' | 'wss'>,
): Record<string, 'ws' | 'wss'> {
  return Object.fromEntries(hosts.map((host) => [host, previous[host] ?? 'ws']))
}

/** Order-insensitive comparison for two scheme maps. */
function sameSecurity(
  a: Record<string, 'ws' | 'wss'>,
  b: Record<string, 'ws' | 'wss'>,
): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
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
 * concurrent pairing (a second tab) cannot INVOKE the first run's callbacks.
 * That alone is not enough for the browser side, though: the SSE stream is
 * shared, so every frame this run publishes also carries `claimId` — the same
 * handle the 202 returned — and the wizard filters by its own. Callback
 * scoping keeps the runs apart on the server; the id keeps them apart on the
 * client.
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
  // ONE publish site for this run: every frame it emits is stamped with its
  // claimId, so no future stage can be added without the handle.
  const publish = (stage: string, detail?: string): void => {
    route.hub.publish('pairing-progress', { stage, ...(detail === undefined ? {} : { detail }), claimId })
  }

  // Fire-and-forget: the claim id is returned before the first stage lands, so
  // the browser can subscribe to /events with a stable handle in hand.
  void (async () => {
    try {
      await route.deps.pair({
        // `identity` and `store` are part of the shared `pairWithPayload`
        // signature, so they are supplied for the SHAPE. The assembly's
        // implementation deliberately OVERRIDES both with its own state — the
        // key that signs the Noise handshake and the archive the record lands
        // in belong to the plugin, never to the caller. See `assemblyDeps` in
        // `src/index.ts`, which states that contract at the override site.
        identity: route.deps.identity(),
        payload,
        store: route.deps.store,
        ...(name === undefined ? {} : { name }),
        // The stage string is forwarded VERBATIM (contract note): no renaming,
        // no wrapping, no enumification between pairing and the wire.
        onStatus: (stage) => publish(stage),
        onVerificationCode: (code) => publish('verification-code', code),
      })
      publish('approved')
    } catch (error) {
      // A QUARANTINED archive is caught before the generic verdict: pairing
      // ends by PERSISTING a record, so a read-only archive fails the run at
      // its last step. `pairingVerdict` would report it as `pairing-failed`
      // with the raw error text, which tells the user nothing about the file an
      // operator has to move aside. Its own stage carries the same structured
      // detail the PATCH/DELETE routes return.
      if (error instanceof QuarantinedArchiveError) {
        console.warn(`[cherry-remote] pairing ${claimId} could not persist: the archive is quarantined`)
        try {
          route.deps.onArchiveQuarantined?.(error)
        } catch (reportError) {
          console.warn('[cherry-remote] reporting the quarantined archive failed', reportError)
        }
        // The shared instruction VERBATIM, with only the two contextual paths
        // appended. A hand-written sibling here would be a third independent
        // wording of "move the file aside", which is exactly the drift the
        // constant exists to prevent.
        publish(
          'archive-quarantined',
          `${QUARANTINE_RECOVERY} (archive: ${error.file}; preserved as ` +
            `${error.corruptPath ?? `${error.file}.corrupt`})`,
        )
        return
      }
      const verdict = pairingVerdict(error)
      console.warn(`[cherry-remote] pairing ${claimId} failed (${verdict.error}): ${verdict.message}`)
      publish(verdict.error, verdict.message)
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
