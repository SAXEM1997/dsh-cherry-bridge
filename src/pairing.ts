import { hostname } from 'node:os'
import { WebSocket } from 'ws'
import { connectSecureChannel, RemoteSocketStream } from '@cherrystudio/remote-transport'
import type { ChannelOptions, SecureChannel } from '@cherrystudio/remote-transport'
import { remoteConnectPath } from '@cherrystudio/remote-protocol'
import type { DeviceRecord } from './deviceStore'
import type { DeviceStore } from './deviceStore'
import { JsonRpcClient, JsonRpcRequestError } from './rpc/jsonRpcClient'
import { toRemoteSocket } from './rpc/wsAdapter'
import { urlHost } from './urlHost'

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
}

// ---------------------------------------------------------------------------
// Payload validation (spec §3.3 step 1, ruling 1).
//
// Field caps mirror the protocol package's `values.ts`: `opaqueId` is a
// non-empty unicode string of at most 256 code units, and the claim's
// `deviceName` is capped at 64. A payload field over its cap would be rejected
// by the peer's strict schema anyway, so rejecting it here is the same verdict
// one round-trip earlier, with a message the user can act on.
// ---------------------------------------------------------------------------

const PAYLOAD_TYPE = 'cherry-studio-pair'
const PAYLOAD_VERSION = 2
/** Overall payload ceiling: a QR code never approaches this. */
const MAX_PAYLOAD_BYTES = 10 * 1024
/** `opaqueId` cap for invitationId/invitationSecret/desktopIdentity. */
const OPAQUE_ID_MAX = 256
/** The claim's deviceName cap; a hostname may reach 253, so it is truncated. */
const DEVICE_NAME_MAX = 64
/** Bounds a single candidate host string (IPv6 literals are ~45). */
const HOST_MAX = 256
/** Matches the protocol's unicodeText: no lone UTF-16 surrogates. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Fields the implementation consumes; everything else in the payload is ignored. */
const KNOWN_FIELDS = new Set([
  'v',
  't',
  'port',
  'ips',
  'invitationId',
  'invitationSecret',
  'desktopIdentity',
  'protocolVersions',
])

interface PairingPayload {
  hosts: string[]
  port: number
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

function checkString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') invalid(`payload field "${field}" must be a string`)
  if (value.length === 0) invalid(`payload field "${field}" must not be empty`)
  if (value.length > max) invalid(`payload field "${field}" exceeds ${max} characters`)
  if (!isUnicodeText(value)) invalid(`payload field "${field}" is not valid unicode text`)
  return value
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
 * Parses and validates the pairing payload. Unknown fields are ignored (with a
 * warning) — the payload carries host naming the design does not consume — but
 * the fields on the manifest are judged against their protocol caps.
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
  if (raw['v'] !== PAYLOAD_VERSION) {
    invalid(`payload version must be ${PAYLOAD_VERSION}`)
  }
  if (raw['t'] !== PAYLOAD_TYPE) {
    invalid(`payload type must be "${PAYLOAD_TYPE}"`)
  }

  const ignored = Object.keys(raw).filter((key) => !KNOWN_FIELDS.has(key))
  if (ignored.length > 0) {
    console.warn(`[cherry-remote] pairing payload ignored unknown field(s): ${ignored.join(', ')}`)
  }

  const port = raw['port']
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    invalid('payload field "port" must be an integer in 1..65535')
  }

  const ips = raw['ips']
  if (!Array.isArray(ips) || ips.length === 0) {
    invalid('payload field "ips" must be a non-empty array')
  }
  const hosts = ips.map((entry, index) =>
    normalizeHost(checkString(entry, `ips[${index}]`, HOST_MAX)),
  )

  const invitationId = checkString(raw['invitationId'], 'invitationId', OPAQUE_ID_MAX)
  const invitationSecret = checkString(raw['invitationSecret'], 'invitationSecret', OPAQUE_ID_MAX)
  const desktopIdentity = checkString(raw['desktopIdentity'], 'desktopIdentity', OPAQUE_ID_MAX)

  const versions = raw['protocolVersions']
  if (!Array.isArray(versions) || versions.length === 0) {
    invalid('payload field "protocolVersions" must be a non-empty array')
  }
  const protocolVersions = versions.map((version) => {
    if (typeof version !== 'number' || !Number.isInteger(version)) {
      invalid('payload field "protocolVersions" must contain integers')
    }
    return version
  })

  return { hosts, port, invitationId, invitationSecret, desktopIdentity, protocolVersions }
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

// urlHost() moved to its shared home (./urlHost): both dial sites — pairing's
// candidate dial and DeviceConnection's per-device dial — bracket IPv6 the
// same way. Re-exported here to keep this module's original public surface.
export { urlHost } from './urlHost'

/** Dials one candidate address and completes the Noise handshake.
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
  host: string,
  port: number,
  identity: Uint8Array,
  desktopIdentity: string,
  protocolVersions: readonly number[],
  timeoutMs: number,
): Promise<TempChannel> {
  const ws = new WebSocket(`ws://${urlHost(host)}:${port}${remoteConnectPath}`)
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
  onStatus('validate')

  const supported = opts.supportedProtocolVersions ?? DEFAULT_SUPPORTED_PROTOCOL_VERSIONS
  // The real negotiation face: the offer is the intersection, and an empty
  // intersection means no version both sides can speak. The channel's own
  // prelude makes the peer reject it; this is not a receipt check.
  const offered = payload.protocolVersions.filter((version) => supported.includes(version))

  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  onStatus('connect')

  const failures: string[] = []
  for (const host of payload.hosts) {
    let temp: TempChannel
    try {
      temp = await dial(
        host,
        payload.port,
        opts.identity,
        payload.desktopIdentity,
        offered,
        connectTimeoutMs,
      )
    } catch (error) {
      failures.push(`${host}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    try {
      const record = await claimAndAwait(temp.client, payload, offered, opts, onStatus)
      destroy(temp)
      // `DeviceStore.upsert` persists and returns nothing, so the call returns
      // the very record it handed over — the persisted archive entry, not a
      // pre-write copy.
      opts.store.upsert(record)
      return record
    } catch (error) {
      destroy(temp)
      if (error instanceof PairingError) throw error
      failures.push(`${host}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new PairingError(
    'unreachable',
    `no candidate address could complete pairing (${failures.join('; ')})`,
  )
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
      throw new PairingError('rejected', 'the desktop rejected this pairing request')
    }
    if (result.status === 'expired') {
      throw new PairingError('expired', 'the pairing invitation expired')
    }
    if (result.status === 'approved') {
      return recordFrom(payload, result, deviceName)
    }
    // `pending`: the user has not acted yet. The local deadline is race
    // protection for a peer that never reaches a terminal state; the normal
    // expiry verdict is the PEER's own `expired` reply, carried above.
    if (Date.now() >= deadline) {
      throw new PairingError('expired', 'the pairing invitation expired while waiting for approval')
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
 */
function recordFrom(
  payload: PairingPayload,
  approved: Extract<GetResult, { status: 'approved' }>,
  deviceName: string,
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

  return {
    schemaVersion: 2,
    deviceId: approved.deviceId,
    displayName: deviceName,
    hosts: [...payload.hosts],
    port: payload.port,
    desktopIdentity: payload.desktopIdentity,
    grants,
    accessToken: approved.accessToken,
    tokenExpiresAt: Date.parse(approved.expiresAt),
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
