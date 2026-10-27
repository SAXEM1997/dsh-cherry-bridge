import { hostname } from 'node:os'
import { WebSocket } from 'ws'
import { connectSecureChannel, RemoteSocketStream } from '@cherrystudio/remote-transport'
import type { ChannelOptions, SecureChannel } from '@cherrystudio/remote-transport'
import type { z } from 'zod'
import { directEndpointUrl, pairingQrSchema } from '@cherrystudio/remote-protocol'
import type { WsDialOptions } from './connection.js'
import type { DeviceRecord } from './deviceStore.js'
import type { DeviceStore } from './deviceStore.js'
import { JsonRpcClient, JsonRpcRequestError } from './rpc/jsonRpcClient.js'
import { toRemoteSocket } from './rpc/wsAdapter.js'

/**
 * The pairing half of the bridge (spec §3.3): turn the desktop's pairing
 * payload into a persisted `DeviceRecord`.
 *
 * Pairing runs on a TEMPORARY one-shot channel with its own handshake — it
 * never consumes `DeviceConnection`, and it carries none of the steady-state
 * housekeeping (hello/limits/refresh). Once the record is in the store, Task 5
 * owns the persistent link.
 */

export type PairingErrorKind = 'invalid-payload' | 'rejected' | 'expired' | 'unreachable'

/** The structured §6 pairing failure currency. */
export class PairingError extends Error {
  readonly kind: PairingErrorKind

  constructor(kind: PairingErrorKind, message: string) {
    super(message)
    this.name = 'PairingError'
    this.kind = kind
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export interface PairWithPayloadOptions {
  /** The local Ed25519 device identity; the same one the connection reuses. */
  identity: Uint8Array
  /** The desktop's pairing payload (QR content / exported string). */
  payload: string
  /** Archive the paired record lands in. */
  store: DeviceStore
  /** Overrides the claimed device name (default: this machine's hostname). */
  name?: string
  /** Receives the 6-digit code the user compares on the desktop. */
  onVerificationCode: (code: string) => void
  /** Coarse progress stages ('validate' | 'connect' | 'claim' | 'waiting'). */
  onStatus?: (stage: string) => void
  /** Poll cadence for `pairing.get` (default 1s). */
  pollIntervalMs?: number
  /** Race protection only (default 120s, the protocol invitationMs). */
  pollTimeoutMs?: number
  /** Per-candidate dial+handshake timeout (default 10s). */
  connectTimeoutMs?: number
  /** Locally supported protocol versions (default [1]). */
  supportedProtocolVersions?: readonly number[]
  /**
   * The websocket options every dial uses — only TLS trust (`rejectUnauthorized`
   * / `ca`) matters (issue #126: a TLS-proxied endpoint presents a certificate
   * the client must be able to trust, e.g. a private CA; the nested
   * `{ tls: {…} }` shape `https` accepts is NOT read by `ws`). Absent means
   * Node's default trust store.
   */
  wsOptions?: WsDialOptions
}

// ---------------------------------------------------------------------------
// Payload validation (spec §3.3 step 1, ruling 1; widened to the v3 custom-
// address QR by issue #124 — upstream `bc570d2b9`, desktop 2.1.8).
//
// The FIELD CHECKS are the pinned protocol package's own `pairingQrSchema`: a
// v2|v3 discriminated union whose v2 arm is `ips` (IP LITERALS only — the
// package's fixture calls a hostname there "DNS masquerading as IP") + `port`,
// and whose v3 arm is complete `endpoints` (`host`, `port`, `security`).
// Hand-rolling the checks is what made a 2.1.8 invitation refuse
// `invalid-payload` for the whole life of the 0.5.0 pin; consuming the schema
// means the next widening ships with the pin, not with a parser edit. Three
// local rules stay, and none of them is a field check:
//   - the raw size cap (an oversized blob must not be parsed at all),
//   - v2's bracketed-IPv6 NORMALIZATION (ruling 2) — the published v2 arm
//     validates BARE literals, so brackets are stripped before the parse and
//     the archive keeps the bare form the connection layer re-brackets, and
//   - the `unicodeText` (lone-surrogate) rule on `invitationId` /
//     `invitationSecret` / `desktopIdentity`: the protocol values face
//     enforces it, the pairing QR arm does not, and refusing here keeps the
//     v2 error face identical one round trip earlier.
// The error face is `invalid-payload` naming the failing FIELD PATHS only:
// zod issues carry the `input`, so values never enter the message — an
// `invitationSecret` must not surface in a user-visible error.
// ---------------------------------------------------------------------------

/** Overall payload ceiling: a QR code never approaches this. */
const MAX_PAYLOAD_BYTES = 10 * 1024
/** The claim's deviceName cap; a hostname may reach 253, so it is truncated. */
const DEVICE_NAME_MAX = 64
/** Bounds a single candidate host string (IPv6 literals are ~45). */
const HOST_MAX = 256
/** Matches the protocol's unicodeText: no lone UTF-16 surrogates. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * The keys each QR ARM consumes (selected by `v`). A payload field outside
 * the MATCHED arm's set is ignored with a warning — the desktop names hosts
 * the design does not use. One union set would silently swallow a v2 payload
 * carrying a spurious `endpoints` (or v3 carrying `ips`/`port`); the arm
 * split keeps the pre-schema warning behavior.
 */
const V2_KEYS = new Set([
  'v',
  't',
  'name',
  'ips',
  'port',
  'invitationId',
  'invitationSecret',
  'desktopIdentity',
  'protocolVersions',
])
const V3_KEYS = new Set([
  'v',
  't',
  'name',
  'endpoints',
  'invitationId',
  'invitationSecret',
  'desktopIdentity',
  'protocolVersions',
])

/** One dial candidate; a v3 endpoint carries its OWN port and scheme. */
interface PairCandidate {
  host: string
  port: number
  security: 'ws' | 'wss'
}

interface PairingPayload {
  /** Ordered dial candidates — every entry is attempted before `unreachable`. */
  candidates: PairCandidate[]
  invitationId: string
  invitationSecret: string
  desktopIdentity: string
  protocolVersions: number[]
}

/**
 * A payload-validation failure. It IS a {@link PairingError} so callers see one
 * error currency, and it is raised before any socket is opened.
 */
class PayloadError extends PairingError {
  constructor(message: string) {
    super('invalid-payload', `invalid pairing payload: ${message}`)
  }
}

function invalid(message: string): never {
  throw new PayloadError(message)
}

/** Protocol `unicodeText`: a string carrying no lone UTF-16 surrogate. */
function isUnicodeText(value: string): boolean {
  return !LONE_SURROGATE_RE.test(value)
}

/** Rejections quote issue PATHS (deduplicated, sorted). The "never inputs"
 * promise is the CALL SITE's property — only `issue.path` is read here; an
 * editor reaching for `issue.message` or `String(error)` must re-check what
 * zod embeds there before keeping that promise. */
function schemaIssuePaths(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => issue.path.join('.') || 'payload'))]
    .sort()
    .join(', ')
}

/**
 * Normalizes one candidate host (ruling 2). The QR may carry IPv6 literals in
 * bracketed form; the archive stores bare hosts and the connection layer adds
 * brackets back when it builds the URL.
 *
 * WHATWG URL bracketing strips exactly the surrounding pair, so it is used
 * only when the entry really is a bracketed literal — it would MISREAD a
 * domain such as `[login.example.com]` as an IPv6 literal. A bracketed
 * non-literal is therefore rejected rather than silently rewritten.
 */
function normalizeHost(raw: string): string {
  if (raw.length > HOST_MAX) invalid(`payload host entry exceeds ${HOST_MAX} characters`)
  const bracketed = raw.startsWith('[') && raw.endsWith(']')
  if (!bracketed) return raw
  const inner = raw.slice(1, -1)
  try {
    // Throws unless the content is a valid IPv6 literal.
    new URL(`http://${raw}/`)
  } catch {
    invalid(`payload host entry "${raw}" is not a valid IPv6 literal`)
  }
  return inner
}

/**
 * Parses and validates the pairing payload against the published
 * `pairingQrSchema` (v2 or v3). Unknown fields are ignored (with a warning);
 * every field judgement is the schema's, capped by the local size rule.
 */
function parsePayload(payload: string): PairingPayload {
  // Size is judged on the raw string first: an oversized blob must not be
  // parsed at all.
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    invalid(`payload exceeds the ${MAX_PAYLOAD_BYTES}-byte limit`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    invalid('payload is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    invalid('payload must be a JSON object')
  }

  const raw = parsed as Record<string, unknown>

  // Normalize v2 bracketed IPv6 entries BEFORE the schema sees them;
  // non-string entries pass through for the schema to judge (the published
  // arm rejects them with the same `invalid-payload` verdict).
  const ips = raw['ips']
  const input = Array.isArray(ips)
    ? {
        ...raw,
        ips: ips.map((entry) => (typeof entry === 'string' ? normalizeHost(entry) : entry)),
      }
    : raw

  const result = pairingQrSchema.safeParse(input)
  if (!result.success) {
    invalid(`payload rejected by the pairing QR schema (v2 or v3): ${schemaIssuePaths(result.error)}`)
  }
  const qr = result.data

  // Unknown-key warning, judged against the MATCHED arm's keys (see the
  // V2_KEYS/V3_KEYS docblock): after the parse, so a payload that fails the
  // schema is never warned-and-then-rejected — its verdict is the rejection.
  const ignored = Object.keys(raw).filter((key) => !(qr.v === 2 ? V2_KEYS : V3_KEYS).has(key))
  if (ignored.length > 0) {
    console.warn(`[cherry-remote] pairing payload ignored unknown field(s): ${ignored.join(', ')}`)
  }

  const candidates: PairCandidate[] =
    qr.v === 2
      ? qr.ips.map((host) => ({ host, port: qr.port, security: 'ws' as const }))
      : qr.endpoints.map((endpoint) => ({
          host: endpoint.host,
          port: endpoint.port,
          security: endpoint.security,
        }))

  // ADDRESS rules the schema cannot express (issue #135 review). The pinned
  // schema already constrains a v3 endpoint port, but that is the PIN's
  // property, not ours — a widening must not reopen the hole — and it has no
  // uniqueness rule at all. Judged HERE — for BOTH arms, after normalization,
  // before any socket — because an invalid address must never consume the
  // invitation, and must never reach `store.upsert` after an approval (where a
  // validation failure would surface as `unreachable` about an invitation
  // already spent).
  const seenHosts = new Set<string>()
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65_535) {
      invalid(`payload endpoint "${candidate.host}": port must be an integer in 1..65535`)
    }
    if (seenHosts.has(candidate.host)) {
      invalid(`payload endpoints must not repeat host "${candidate.host}"`)
    }
    seenHosts.add(candidate.host)
  }

  // The lone-surrogate rule is ours (see the header): the claim RPC would
  // carry such a value to the peer's unicodeText params face and be refused
  // there; naming the field now is the same verdict one round trip earlier.
  for (const field of ['invitationId', 'invitationSecret', 'desktopIdentity'] as const) {
    if (!isUnicodeText(qr[field])) invalid(`payload field "${field}" is not valid unicode text`)
  }

  return {
    candidates,
    invitationId: qr.invitationId,
    invitationSecret: qr.invitationSecret,
    desktopIdentity: qr.desktopIdentity,
    protocolVersions: qr.protocolVersions,
  }
}

// ---------------------------------------------------------------------------
// Temporary channel (ruling 5: protocolVersions = payload ∩ local support)
// ---------------------------------------------------------------------------

const DEFAULT_SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1]
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
/** The protocol invitationMs: 120s of invitation, and our poll race guard. */
const DEFAULT_POLL_TIMEOUT_MS = 120_000
const VERIFICATION_CODE_RE = /^[0-9]{6}$/

const noop = (): void => {}

type TransportLogger = ConstructorParameters<typeof RemoteSocketStream>[1]
type TransportComponentLogger = ChannelOptions['logger']

/** A callable silent libp2p logger (same shape as the connection layer's). */
function makeSilentLogger(): TransportLogger {
  const log = ((): void => {}) as unknown as TransportLogger
  log.error = noop
  log.trace = noop
  log.enabled = false
  log.newScope = () => log
  return log
}

const silentComponentLogger: TransportComponentLogger = { forComponent: () => makeSilentLogger() }

/** One live temporary pairing channel. Never outlives a single pairing call. */
interface TempChannel {
  client: JsonRpcClient
  channel: SecureChannel
  controller: AbortController
  ws: WebSocket
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Dials one candidate address and completes the Noise handshake.
 *
 * The URL is the published `directEndpointUrl` — it brackets IPv6 literals,
 * appends the fixed `/v1/remote/connect` path, and selects `ws:` or `wss:`
 * from the candidate's own `security` (v3 TLS-proxy endpoints dial TLS).
 *
 * Both halves start concurrently (`Promise.all`): the peer's accept half is
 * already running on its side, so a sequential dial would deadlock the
 * prelude.
 *
 * `remoteIdentity` is REQUIRED by `connectSecureChannel` — it is what selects
 * the outbound dialer half (without it the handshake waits for an inbound peer
 * that will never come). It also makes the pairing's trust decision real
 * rather than assumed: the payload's `desktopIdentity` is the peer the Noise
 * XX handshake must prove, so a swapped-in impostor fails the handshake
 * instead of being pinned as the desktop.
 */
async function dial(
  candidate: PairCandidate,
  identity: Uint8Array,
  desktopIdentity: string,
  protocolVersions: readonly number[],
  timeoutMs: number,
  wsOptions: PairWithPayloadOptions['wsOptions'],
): Promise<TempChannel> {
  const { host, port } = candidate
  const ws = new WebSocket(directEndpointUrl(candidate), wsOptions)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`connect to ${host}:${port} timed out`)), timeoutMs)
  })

  try {
    const connecting = (async (): Promise<SecureChannel> => {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', (error: Error) => reject(error))
      })
      const stream = new RemoteSocketStream(
        toRemoteSocket(ws),
        silentComponentLogger.forComponent('pairing'),
        'outbound',
      )
      return connectSecureChannel(stream, {
        identity,
        logger: silentComponentLogger,
        protocolVersions: [...protocolVersions],
        signal: controller.signal,
        remoteIdentity: desktopIdentity,
      })
    })()

    // Aborting on timeout is what unsticks the channel half: the ws 'error'
    // event alone never fires while the handshake is waiting on the peer.
    const channel = await Promise.race([
      connecting,
      timedOut.finally(() => controller.abort(new Error('pairing connect timed out'))),
    ])
    return { client: new JsonRpcClient(channel), channel, controller, ws }
  } catch (error) {
    controller.abort(error instanceof Error ? error : new Error(String(error)))
    ws.terminate()
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timer)
  }
}

/** Destroys a temporary channel: client, Noise channel, socket, abort signal. */
function destroy(temp: TempChannel): void {
  temp.client.dispose()
  void temp.channel.close().catch(noop)
  try {
    temp.ws.close()
  } catch {
    // Already closed.
  }
  temp.controller.abort()
}

function rpcReason(error: unknown): string | undefined {
  if (error instanceof JsonRpcRequestError) {
    const data = error.data as { reason?: unknown } | undefined
    if (data !== null && typeof data === 'object' && typeof data.reason === 'string') return data.reason
  }
  return undefined
}

interface ClaimResult {
  claimId: string
  verificationCode: string
  expiresAt: string
}

type GetResult =
  | { status: 'pending' | 'rejected' | 'expired' }
  | {
      status: 'approved'
      deviceId: string
      authorization: { grants: Array<{ domain: string; grantId: string }> }
      accessToken: string
      expiresAt: string
    }

/**
 * Pairs this DSH profile with a Cherry Studio desktop from its pairing payload,
 * returning the PERSISTED record (ruling 6).
 *
 * Flow (spec §3.3): validate → try each candidate address on a fresh temporary
 * channel → `pairing.claim` → surface the 6-digit code → poll `pairing.get`
 * until the peer's terminal state → persist → destroy the channel.
 *
 * Claims are scoped to the claiming peer, so the whole lifecycle stays on ONE
 * channel: a retry against a second candidate would be rejected as an
 * already-claimed invitation, and it must not discard the code the user is
 * already comparing on the desktop.
 *
 * Every failure throws {@link PairingError}: `invalid-payload` (payload),
 * `rejected` / `expired` (the peer's terminal state), or `unreachable` (no
 * candidate address produced a usable channel).
 */
export async function pairWithPayload(opts: PairWithPayloadOptions): Promise<DeviceRecord> {
  const payload = parsePayload(opts.payload)
  const onStatus = opts.onStatus ?? noop
  // INFO-LEVEL PROGRESS (spec §5): every stage transition is logged, so an
  // operator watching a run that can take a minute can see where it is WITHOUT
  // the tool result. Only the stage NAME and the payload's host list are
  // recorded — never `invitationSecret`, the claim's verification code, or any
  // token (those are exactly what the sanitization contract forbids).
  const report = (stage: string): void => {
    console.info(
      `[cherry-remote] pairing stage ${stage} (hosts: ${payload.candidates.map((candidate) => candidate.host).join(', ')})`,
    )
    onStatus(stage)
  }
  report('validate')

  const supported = opts.supportedProtocolVersions ?? DEFAULT_SUPPORTED_PROTOCOL_VERSIONS
  // The real negotiation face: the offer is the intersection, and an empty
  // intersection means no version both sides can speak. The channel's own
  // prelude makes the peer reject it; this is not a receipt check.
  const offered = payload.protocolVersions.filter((version) => supported.includes(version))

  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  report('connect')

  const failures: string[] = []
  // The approved record, set by the winner and written ONCE after the loop.
  let approved: DeviceRecord | undefined
  for (const candidate of payload.candidates) {
    const label = `${candidate.host}:${candidate.port}`
    let temp: TempChannel
    try {
      temp = await dial(
        candidate,
        opts.identity,
        payload.desktopIdentity,
        offered,
        connectTimeoutMs,
        opts.wsOptions,
      )
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    try {
      approved = await claimAndAwait(temp.client, payload, offered, opts, report, candidate)
      destroy(temp)
      // Settled: stop walking. The ARCHIVE WRITE is deliberately outside this
      // per-candidate catch (below) — see the fall-through comment.
      break
    } catch (error) {
      destroy(temp)
      if (error instanceof PairingError) throw error
      // MID-FLOW FALL-THROUGH (documented boundary): a NON-`PairingError` DIAL
      // or CLAIM fault here is an unexpected fault on THIS candidate — not a
      // verdict about the invitation. The walk therefore CONTINUES to the next
      // candidate address, and if a later candidate reaches a real terminal
      // state that verdict wins. Only if EVERY candidate fails does the walk end
      // as `unreachable`; conversely an unexpected fault on the FIRST candidate
      // followed by a peer `rejected` on the SECOND surfaces as `rejected`, not
      // `unreachable`. That is deliberate: the peer's answer about the invitation
      // outranks our own transport trouble, and it is the one the user can act
      // on. The archive write is NOT in this arm: it happens once, after a
      // winner, and is TERMINAL — a store failure is a fact about the archive,
      // never an address failure.
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (approved === undefined) {
    throw new PairingError(
      'unreachable',
      `no candidate address could complete pairing (${failures.join('; ')})`,
    )
  }

  // ONE write, after a winner and outside every per-candidate catch. A failure
  // here surfaces as itself (`QuarantinedArchiveError`, a validation error, …):
  // the desktop already approved, so blaming an address would be a lie and the
  // invitation is already spent. `upsert` returns nothing, so the return value
  // is the record handed to it — the persisted archive entry, not a pre-write
  // copy.
  opts.store.upsert(approved)
  return approved
}

/**
 * The RPC half of one candidate: confirm the protocol, claim, present the code,
 * poll to the terminal state. The approved branch is the ONLY source of
 * deviceId, grants and token (ruling 3) — the claim receipt carries the code
 * and nothing else.
 */
async function claimAndAwait(
  client: JsonRpcClient,
  payload: PairingPayload,
  protocolVersions: readonly number[],
  opts: PairWithPayloadOptions,
  onStatus: (stage: string) => void,
  candidate: PairCandidate,
): Promise<DeviceRecord> {
  const deviceName = (opts.name ?? hostname()).slice(0, DEVICE_NAME_MAX)

  // hello is not optional during pairing: the peer answers
  // INVALID_CONNECTION_STATE to claim/get until the prelude offer has been
  // confirmed. It echoes the OFFER (`protocolVersions`), element-wise — the
  // negotiation itself already happened in the Noise prelude.
  try {
    await client.request('connection.hello', { protocolVersions: [...protocolVersions] })
  } catch (error) {
    throw asPairingError(error, 'hello')
  }

  let claim: ClaimResult
  try {
    claim = await client.request<ClaimResult>('pairing.claim', {
      invitationId: payload.invitationId,
      invitationSecret: payload.invitationSecret,
      deviceName,
      platform: 'desktop',
      capabilities: ['agent'],
    })
  } catch (error) {
    throw asPairingError(error, 'claim')
  }

  if (typeof claim?.claimId !== 'string' || !VERIFICATION_CODE_RE.test(claim.verificationCode ?? '')) {
    throw new PairingError('unreachable', 'peer returned a malformed pairing claim receipt')
  }
  onStatus('claim')
  // The CODE is handed to the callback (which renders it for the human) and is
  // deliberately NOT logged: it is the one secret a pairing run carries.
  opts.onVerificationCode(claim.verificationCode)

  onStatus('waiting')
  const deadline = Date.now() + (opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS)
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  for (;;) {
    let result: GetResult
    try {
      result = await client.request<GetResult>('pairing.get', { claimId: claim.claimId })
    } catch (error) {
      throw asPairingError(error, 'poll')
    }

    if (result.status === 'rejected') {
      // GUIDANCE, not just a verdict (see the `expired` branch for the same
      // rule): the refusal is most often a MISMATCH between the 6-digit code
      // shown here and the one the user confirmed on the desktop, so the
      // message says which two things to compare.
      throw new PairingError(
        'rejected',
        'the desktop rejected this pairing request — verify that the 6-digit code shown on the ' +
          'desktop side matches the code this harness displayed, then generate a fresh pairing ' +
          'payload and try again',
      )
    }
    if (result.status === 'expired') {
      throw new PairingError(
        'expired',
        'the pairing invitation has expired — regenerate the pairing code in Cherry Studio (the ' +
          'remote-access QR/payload) and retry',
      )
    }
    if (result.status === 'approved') {
      return recordFrom(payload, result, deviceName, candidate)
    }
    // `pending`: the user has not acted yet. The local deadline is race
    // protection for a peer that never reaches a terminal state; the normal
    // expiry verdict is the PEER's own `expired` reply, carried above.
    if (Date.now() >= deadline) {
      throw new PairingError(
        'expired',
        'the pairing invitation expired while waiting for approval — regenerate the pairing code ' +
          'in Cherry Studio and retry',
      )
    }
    await sleep(interval)
  }
}

/**
 * Builds the archived record from the approved branch (spec §3.2 field set).
 *
 * `displayName` is the name the claim actually carried — the record must not
 * disagree with what the desktop shows for this device, and re-deriving it
 * here would lose the 64-char truncation.
 *
 * The address projection: every candidate host is kept (the v2 record always
 * did, and reconnect re-walks them), and `port` is the one the pairing actually
 * completed on — the WINNER's port, and the record-level fallback. A mixed-port
 * v3 payload is now persisted FAITHFULLY, per host, through `ports` (issue
 * #135): the 2.1.8 generation side emits one endpoint per custom-address
 * invitation (`ApiGatewayService.getRemoteEndpoint`:
 * `advertisedEndpoint ? [advertisedEndpoint] : …`), but a QR that does carry a
 * mixed list must still reconnect each host on its own port. `security` IS
 * persisted (issue #126), one entry per host, taken from the very candidates the
 * walk dialed — so a schemaVersion-4 record remembers the scheme the pairing
 * actually used, and the steady-state dial (src/connection.ts) rebuilds the
 * same URL instead of a plain `ws://`. Before that, #124 paired a TLS endpoint
 * and made it unreachable on every reconnect.
 */
function recordFrom(
  payload: PairingPayload,
  approved: Extract<GetResult, { status: 'approved' }>,
  deviceName: string,
  winner: PairCandidate,
): DeviceRecord {
  const grants = (approved.authorization?.grants ?? [])
    .map((grant) => grant.domain)
    .filter((domain): domain is 'agent' => domain === 'agent')

  // MVP requests the `agent` capability only (spec §2), so an approval without
  // it yields a record no tool could ever use. That is a peer contradiction,
  // not a usable pairing.
  if (grants.length === 0) {
    throw new PairingError('rejected', 'the desktop approved no agent capability for this device')
  }

  // The expiry MUST parse. `Date.parse` returns NaN for anything it cannot read,
  // and a persisted NaN `tokenExpiresAt` is worse than a missing one: every
  // freshness comparison against it is false, so the device is silently treated
  // as permanently expired (or never) with nothing to explain why. A receipt
  // whose expiry cannot be read is malformed, so the run fails here rather than
  // archiving it.
  const tokenExpiresAt = Date.parse(approved.expiresAt)
  if (!Number.isFinite(tokenExpiresAt)) {
    throw new PairingError(
      'rejected',
      `the desktop approved the pairing with an unreadable token expiry ` +
        `(${JSON.stringify(approved.expiresAt)}); re-pair the device`,
    )
  }

  return {
    schemaVersion: 4,
    deviceId: approved.deviceId,
    displayName: deviceName,
    hosts: payload.candidates.map((candidate) => candidate.host),
    // The winner's port, and the record-level fallback (issue #135).
    port: winner.port,
    // One scheme and one port per host, from the very candidates the walk
    // dialed: both maps and `hosts` come from the same list, so they cannot
    // disagree.
    security: Object.fromEntries(
      payload.candidates.map((candidate) => [candidate.host, candidate.security]),
    ),
    ports: Object.fromEntries(
      payload.candidates.map((candidate) => [candidate.host, candidate.port]),
    ),
    desktopIdentity: payload.desktopIdentity,
    grants,
    accessToken: approved.accessToken,
    tokenExpiresAt,
    enabled: true,
  }
}

/**
 * Maps a transport-level failure to the pairing error currency. A peer that
 * answers a structured failure is reachable but unwilling: anything the claim
 * or the poll can legitimately report (a stale invitation, a revoked claim)
 * reads as `rejected`, while a dead channel means this address is unusable.
 */
function asPairingError(error: unknown, stage: 'hello' | 'claim' | 'poll'): PairingError {
  if (error instanceof PairingError) return error
  const reason = rpcReason(error)
  if (reason !== undefined) {
    return new PairingError('rejected', `the desktop refused the pairing ${stage} (${reason})`)
  }
  return new PairingError(
    'unreachable',
    `pairing ${stage} failed: ${error instanceof Error ? error.message : String(error)}`,
  )
}
