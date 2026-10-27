import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { pairingQrSchema } from '@cherrystudio/remote-protocol'
import { DeviceStore } from '../../src/deviceStore.js'
import type { WsDialOptions } from '../../src/connection.js'
import { pairWithPayload } from '../../src/pairing.js'
import type { PairingError } from '../../src/pairing.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions } from '../loopback/fakeCherry.js'
import { makeDualPeer, insecureTlsOptions, type DualPeer } from '../helpers/tls/dualPeer.js'

/**
 * Task 6 integration suite: the pairing flow (`src/pairing.ts`) against the
 * real loopback Noise-XX fake desktop. Test numbering ①-⑥ mirrors the task
 * brief's Step 1 scenarios.
 *
 * Unlike Task 5's `DeviceConnection`, pairing never consumes the persistent
 * connection: it opens a TEMPORARY one-shot channel, claims an invitation,
 * polls until the peer's terminal state, then destroys the channel and hands
 * the persisted record to Task 5.
 */

const fakes: FakeCherry[] = []
const dirs: string[] = []
const peers: DualPeer[] = []

// Pristine output (ruling 9): every console channel is spied so a noisy
// implementation cannot pollute the run, and the warn assertions can read it.
let consoleWarn: ReturnType<typeof vi.fn>
let consoleInfo: ReturnType<typeof vi.fn>
let consoleError: ReturnType<typeof vi.fn>
let consoleLog: ReturnType<typeof vi.fn>

beforeEach(() => {
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop()
  for (const peer of peers.splice(0)) await peer.stop()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

interface FakeInfo {
  fake: FakeCherry
  host: string
  port: number
  desktopIdentity: string
}

async function makeFake(options: FakeCherryOptions = {}): Promise<FakeInfo> {
  const fake = new FakeCherry(options)
  fakes.push(fake)
  const { host, port } = await fake.start()
  const desktopIdentity = await fake.identityId
  return { fake, host, port, desktopIdentity }
}

/** Approval delay used by most tests: a few pending polls, then approved. */
const APPROVE_AFTER_POLLS = 2

/** A desktop that approves the claim after `APPROVE_AFTER_POLLS` pending polls. */
async function makeApprovingFake(): Promise<FakeInfo> {
  return makeFake({ pairingDecision: 'approved', pairingGetPendingPolls: APPROVE_AFTER_POLLS })
}

async function makeStore(): Promise<DeviceStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pairing-'))
  dirs.push(dir)
  return new DeviceStore(join(dir, 'devices.json'))
}

/** The exact payload shape the Cherry desktop renders into its QR code. */
function payloadFor(fakeInfo: FakeInfo, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 2,
    t: 'cherry-studio-pair',
    name: 'cherry-host',
    port: fakeInfo.port,
    ips: [fakeInfo.host],
    invitationId: 'inv-1',
    invitationSecret: 'secret-1',
    desktopIdentity: fakeInfo.desktopIdentity,
    protocolVersions: [1],
    ...overrides,
  })
}

/**
 * The 2.1.8 custom-address invitation (upstream `bc570d2b9`, PR #21387): v3
 * replaces `ips`+`port` with a complete `endpoints` list (host, port,
 * security). The generation side emits exactly ONE endpoint when the user
 * configures an advertised address (2.1.8 `ApiGatewayService.getRemoteEndpoint`
 * — `advertisedEndpoint ? [advertisedEndpoint] : …`), so these payloads carry
 * one endpoint too.
 */
function v3PayloadFor(fakeInfo: FakeInfo, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 3,
    t: 'cherry-studio-pair',
    name: 'cherry-host',
    desktopIdentity: fakeInfo.desktopIdentity,
    invitationId: 'inv-1',
    invitationSecret: 'secret-1',
    protocolVersions: [1],
    endpoints: [{ host: fakeInfo.host, port: fakeInfo.port, security: 'ws' }],
    ...overrides,
  })
}

interface PairOptions {
  identity: Uint8Array
  store: DeviceStore
  payload: string
  name?: string
  onVerificationCode?: (code: string) => void
  onStatus?: (stage: string) => void
  pollIntervalMs?: number
  pollTimeoutMs?: number
  connectTimeoutMs?: number
  supportedProtocolVersions?: readonly number[]
  wsOptions?: WsDialOptions
}

/** `pairWithPayload` with the store bound (the store is not in the brief's opts). */
function pair(opts: PairOptions): ReturnType<typeof pairWithPayload> {
  return pairWithPayload({
    identity: opts.identity,
    payload: opts.payload,
    store: opts.store,
    name: opts.name,
    onVerificationCode: opts.onVerificationCode ?? ((): void => {}),
    onStatus: opts.onStatus,
    // Test-only timing knobs: no real 120s wait, no real 10s connect timeout.
    pollIntervalMs: opts.pollIntervalMs ?? 5,
    pollTimeoutMs: opts.pollTimeoutMs ?? 3_000,
    connectTimeoutMs: opts.connectTimeoutMs ?? 3_000,
    supportedProtocolVersions: opts.supportedProtocolVersions,
    wsOptions: opts.wsOptions,
  })
}

/** Captures the PairingError a rejected pairing produced. */
async function pairingError(promise: Promise<unknown>): Promise<PairingError> {
  try {
    await promise
  } catch (error) {
    return error as PairingError
  }
  throw new Error('expected the pairing to fail')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('condition not met before timeout')
    await sleep(5)
  }
}

describe('pairWithPayload over a real loopback channel', () => {
  it('① pairs end to end: claim → 6-digit code callback → poll to approved → grants/token persisted', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeApprovingFake()
    const store = await makeStore()

    const codes: string[] = []
    const stages: string[] = []

    const record = await pair({
      identity,
      store,
      payload: payloadFor(fakeInfo),
      onVerificationCode: (code) => codes.push(code),
      onStatus: (stage) => stages.push(stage),
    })

    // The 6-digit code from the claim reached the callback verbatim, before
    // the terminal state.
    expect(codes).toEqual([fakeInfo.fake.verificationCode])
    expect(codes[0]).toMatch(/^[0-9]{6}$/)

    // The persisted record is what the call returned, and it came from the
    // pairing.get approved branch — never from the claim receipt.
    expect(store.list()).toEqual([record])
    expect(record).toMatchObject({
      schemaVersion: 4,
      // deviceId/grants/token exist ONLY on the approved branch: the claim
      // receipt carried claimId/verificationCode/expiresAt and nothing else.
      deviceId: fakeInfo.fake.approvedDeviceId,
      displayName: hostname().slice(0, 64),
      hosts: [fakeInfo.host],
      port: fakeInfo.port,
      ports: { [fakeInfo.host]: fakeInfo.port },
      desktopIdentity: fakeInfo.desktopIdentity,
      grants: ['agent'],
      enabled: true,
    })
    expect(record.accessToken).toBe(fakeInfo.fake.issuedAccessToken)
    expect(record.tokenExpiresAt).toBe(Date.parse(fakeInfo.fake.approvedTokenExpiresAt!))

    // The temporary connection obeyed the real pairing face order and is gone.
    expect(fakeInfo.fake.methodCount('pairing.claim')).toBe(1)
    expect(fakeInfo.fake.methodCount('connection.hello')).toBe(1)
    expect(fakeInfo.fake.methodCount('connection.authenticate')).toBe(0)
    expect(fakeInfo.fake.methodCount('pairing.get')).toBeGreaterThanOrEqual(1)
    expect(fakeInfo.fake.lastClaimDeviceName).toBe(hostname().slice(0, 64))
    expect(fakeInfo.fake.lastClaimPlatform).toBe('desktop')
    expect(fakeInfo.fake.lastClaimCapabilities).toEqual(['agent'])
    await waitFor(() => fakeInfo.fake.connectedClients === 0)
    expect(stages).toContain('claim')
  }, 15_000)

  it('①b caps the claimed device name at the protocol limit and honours the name override', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeApprovingFake()
    const store = await makeStore()

    const longName = 'x'.repeat(300)
    await pair({ identity, store, payload: payloadFor(fakeInfo), name: longName })

    // The desktop's schema caps deviceName at 64; a hostname may reach 253, so
    // the plugin truncates instead of having the claim rejected.
    expect(fakeInfo.fake.lastClaimDeviceName).toBe('x'.repeat(64))
  }, 15_000)

  it.each([
    ['not JSON at all', 'this is not json {{{'],
    ['the wrong payload type tag', JSON.stringify({ v: 2, t: 'cherry-studio-pair-x' })],
    ['a missing invitationId', JSON.stringify({ v: 2, t: 'cherry-studio-pair', port: 1 })],
  ])('② rejects malformed payload shape (%s) as invalid-payload', async (_label, payload) => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()
    const onVerificationCode = vi.fn()

    const error = await pairingError(pair({ identity, store, payload, onVerificationCode }))

    expect(error.name).toBe('PairingError')
    expect(error.kind).toBe('invalid-payload')
    // No traffic, no archive write, no code surfaced.
    expect(fakeInfo.fake.socketCount).toBe(0)
    expect(store.list()).toEqual([])
    expect(onVerificationCode).not.toHaveBeenCalled()
  })

  it('② rejects an over-long invitationId (300 > the 256 opaqueId cap) as invalid-payload', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    const error = await pairingError(
      pair({ identity, store, payload: payloadFor(fakeInfo, { invitationId: 'a'.repeat(300) }) }),
    )

    expect(error.kind).toBe('invalid-payload')
    expect(fakeInfo.fake.socketCount).toBe(0)
    expect(store.list()).toEqual([])
  })

  it('② rejects a payload over the 10KB overall cap as invalid-payload', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    // 11KB of unknown fields: the total size cap is judged first.
    const payload = payloadFor(fakeInfo, { filler: 'z'.repeat(11_000) })
    expect(payload.length).toBeGreaterThan(10_240)

    const error = await pairingError(pair({ identity, store, payload }))

    expect(error.kind).toBe('invalid-payload')
    expect(fakeInfo.fake.socketCount).toBe(0)
    expect(store.list()).toEqual([])
  })

  it('③ surfaces the peer terminal rejected state as rejected', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ pairingDecision: 'rejected' })
    const store = await makeStore()

    const error = await pairingError(pair({ identity, store, payload: payloadFor(fakeInfo) }))

    expect(error.kind).toBe('rejected')
    expect(store.list()).toEqual([])
    // The temporary connection is destroyed on the failure path too.
    await waitFor(() => fakeInfo.fake.connectedClients === 0)
  }, 15_000)

  it('③ surfaces the peer terminal expired state as expired WITHOUT any local timeout', async () => {
    const identity = await createDeviceIdentity()
    // The peer flips to its terminal expired state only after 3 pending polls.
    const fakeInfo = await makeFake({ pairingGetPendingPolls: 3, pairingDecision: 'expired' })
    const store = await makeStore()
    // Local poll timeout far beyond the run: whatever kind comes out can only
    // have come from the PEER's terminal state, never from the 120s race guard.
    const localCap = 60_000

    const error = await pairingError(
      pair({ identity, store, payload: payloadFor(fakeInfo), pollTimeoutMs: localCap }),
    )

    expect(error.kind).toBe('expired')
    // The local cap was never reached, and polling demonstrably continued past
    // the first `pending` reply until the peer's terminal state arrived.
    expect(fakeInfo.fake.methodCount('pairing.get')).toBeGreaterThanOrEqual(4)
    expect(fakeInfo.fake.getStates).toContain('pending')
    expect(fakeInfo.fake.getStates[fakeInfo.fake.getStates.length - 1]).toBe('expired')
  }, 15_000)

  it('③b falls back to expired only as race protection when the invitation outlives the local poll cap', async () => {
    const identity = await createDeviceIdentity()
    // The peer keeps answering `pending` forever: only the local cap can end it.
    const fakeInfo = await makeFake()
    const store = await makeStore()

    const error = await pairingError(
      pair({ identity, store, payload: payloadFor(fakeInfo), pollIntervalMs: 5, pollTimeoutMs: 120 }),
    )

    expect(error.kind).toBe('expired')
    expect(fakeInfo.fake.getStates.every((state) => state === 'pending')).toBe(true)
    expect(fakeInfo.fake.methodCount('pairing.get')).toBeGreaterThanOrEqual(1)
  }, 15_000)

  it('④ normalizes bracketed IPv6 host entries to bare hosts AND dials them', async () => {
    const identity = await createDeviceIdentity()
    // A desktop actually listening on IPv6 loopback: the bracketed candidate
    // is the REACHABLE one, so the pairing proves the normalization end to end
    // (a bare `::1` rebuilt into a URL needs its brackets back).
    const fakeInfo = await makeFake({
      bindHost: '::1',
      pairingDecision: 'approved',
      pairingGetPendingPolls: APPROVE_AFTER_POLLS,
    })
    const store = await makeStore()

    const record = await pair({
      identity,
      store,
      payload: payloadFor(fakeInfo, { ips: ['[::1]', '127.0.0.1'] }),
    })

    // Brackets are gone from the archive; the reachable IPv6 candidate is what
    // the pairing actually used.
    expect(record.hosts).toEqual(['::1', '127.0.0.1'])
    expect(record.port).toBe(fakeInfo.port)
    expect(fakeInfo.fake.connectionCount).toBe(1)
    expect(fakeInfo.fake.methodCount('pairing.claim')).toBe(1)
  }, 15_000)

  it('④b falls through to a reachable candidate when an earlier address is dead', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeApprovingFake()
    const store = await makeStore()

    // 127.0.0.2 is reserved/unroutable on the loopback interface; the real
    // candidate follows it. The record proves the per-candidate fallthrough,
    // and the run proves a dead candidate does not hang the pairing.
    const record = await pair({
      identity,
      store,
      payload: payloadFor(fakeInfo, { ips: ['127.0.0.2', fakeInfo.host] }),
      connectTimeoutMs: 500,
    })

    expect(record.hosts).toEqual(['127.0.0.2', fakeInfo.host])
    expect(record.deviceId).toBe(fakeInfo.fake.approvedDeviceId)
    expect(fakeInfo.fake.methodCount('pairing.claim')).toBe(1)
  }, 15_000)

  it('④c refuses an approval that carries no agent grant, rather than archiving an unusable record', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      pairingDecision: 'approved',
      pairingGetPendingPolls: APPROVE_AFTER_POLLS,
      approvedGrants: [],
    })
    const store = await makeStore()

    // MVP requests `agent` only, so an approval without it is a peer
    // contradiction: persisting it would yield a device no tool can use.
    const error = await pairingError(pair({ identity, store, payload: payloadFor(fakeInfo) }))

    expect(error.kind).toBe('rejected')
    expect(store.list()).toEqual([])
  }, 15_000)

  it('④d refuses an approval whose expiresAt is unparsable, never archiving a NaN expiry', async () => {
    // `Date.parse` yields NaN for anything it cannot read, and a NaN
    // `tokenExpiresAt` is the worst kind of value to persist: every freshness
    // comparison against it is FALSE, so the record reads as permanently expired
    // (or permanently fresh) depending on the comparison, and the device is
    // silently unusable with no explanation. A malformed expiry is a broken
    // receipt, so the pairing FAILS with a structured error instead.
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      pairingDecision: 'approved',
      pairingGetPendingPolls: APPROVE_AFTER_POLLS,
      pairingApprovedExpiresAt: 'not-a-timestamp',
    })
    const store = await makeStore()

    const error = await pairingError(pair({ identity, store, payload: payloadFor(fakeInfo) }))

    expect(error.kind).toBe('rejected')
    // NOTHING was archived: no record with a NaN expiry exists on disk.
    expect(store.list()).toEqual([])
  }, 15_000)

  it('⑤ ignores payload fields outside the schema (e.g. futureField) and warns about them', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeApprovingFake()
    const store = await makeStore()

    const record = await pair({
      identity,
      store,
      payload: payloadFor(fakeInfo, { name: 'some-other-host', futureField: { nested: true } }),
    })

    // The payload `name` is a SCHEMA field since 0.7.0's `pairingQrSchema`
    // (required, the desktop's own hostname) — no longer an unknown field, and
    // still never THIS record's display name: that is the name we claimed with
    // (spec §3.3 step 1). Only genuinely unknown keys are warned about.
    expect(record.displayName).toBe(hostname().slice(0, 64))
    expect(record.displayName).not.toBe('some-other-host')
    expect(record).not.toHaveProperty('futureField')
    const warned = consoleWarn.mock.calls.flat().map(String).join('\n')
    expect(warned).toContain('futureField')
    expect(warned).not.toContain('name')
  }, 15_000)

  it('⑤b warns about a field from the OTHER arm (v2 payload carrying a spurious endpoints key)', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeApprovingFake()
    const store = await makeStore()

    // The ignored-key judgement is ARM-AWARE (V2_KEYS/V3_KEYS, matched by the
    // parsed `v`): one union set would swallow a v2 payload carrying a v3
    // field without a word — the pre-schema behavior warned, and this keeps
    // that promise. The schema itself is loose, so the pair still succeeds;
    // the warning is the whole claim. Deleting the arm split (judging against
    // the union) turns exactly this test green-silent.
    const record = await pair({
      identity,
      store,
      payload: payloadFor(fakeInfo, { endpoints: [{ host: '10.9.9.9', port: 23_456, security: 'ws' }] }),
    })

    expect(record).toBeTruthy()
    const warned = consoleWarn.mock.calls.flat().map(String).join('\n')
    expect(warned).toContain('endpoints')
  }, 15_000)

  it('⑥ fails as unreachable when the payload version set and the local support set do not intersect', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ protocolVersions: [1] })
    const store = await makeStore()

    // NOTE — this is the REAL negotiation-failure face: version selection
    // happens inside the Noise prelude (`connectSecureChannel` sends the offer
    // and the peer answers `Unsupported remote protocol` when the sets do not
    // intersect). Contrast with Task 5①, which injects a RECEIPT inconsistency
    // (a hello echo differing from the offer) and is not a negotiation failure.
    const error = await pairingError(
      pair({
        identity,
        store,
        payload: payloadFor(fakeInfo, { protocolVersions: [7, 8] }),
        supportedProtocolVersions: [1],
      }),
    )

    expect(error.kind).toBe('unreachable')
    expect(store.list()).toEqual([])
    // The offer really was dialed — the failure is the peer's prelude verdict,
    // not a local pre-check. No Noise channel completed and no pairing RPC ran.
    expect(fakeInfo.fake.socketCount).toBe(1)
    expect(fakeInfo.fake.connectionCount).toBe(0)
    expect(fakeInfo.fake.methodCount('pairing.claim')).toBe(0)
    expect(fakeInfo.fake.methodCount('connection.hello')).toBe(0)
    // The diagnosis names the mismatch so the user knows to upgrade a side.
    expect(error.message).toContain('7')
  }, 15_000)

  it('⑥c offers the INTERSECTION, not the raw payload set', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      protocolVersions: [1],
      pairingDecision: 'approved',
      pairingGetPendingPolls: APPROVE_AFTER_POLLS,
    })
    const store = await makeStore()

    // The payload advertises a version this build cannot speak (7) alongside
    // one it can (1). Offering the raw set would advertise 7 across the wire
    // and invite the peer to select a version this client cannot honour; the
    // offer must be the intersection, and the pairing must still succeed.
    const record = await pair({
      identity,
      store,
      payload: payloadFor(fakeInfo, { protocolVersions: [1, 7] }),
      supportedProtocolVersions: [1],
    })

    expect(record.deviceId).toBe(fakeInfo.fake.approvedDeviceId)
    expect(fakeInfo.fake.connectionCount).toBe(1)
    // The peer saw exactly the intersection as the prelude offer.
    expect([...fakeInfo.fake.offeredVersionsAtHello]).toEqual([1])
  }, 15_000)

  it('⑥b reports unreachable when every candidate address is unreachable', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    const error = await pairingError(
      pair({
        identity,
        store,
        payload: payloadFor(fakeInfo, { ips: ['127.0.0.1'], port: 1 }),
      }),
    )

    expect(error.kind).toBe('unreachable')
    expect(store.list()).toEqual([])
  }, 15_000)

  // -------------------------------------------------------------------------
  // INFO-level pairing progress (spec §5) — spy-tested for presence AND for the
  // absence of the two secrets a pairing run carries.
  // -------------------------------------------------------------------------

  it('⑧ logs every pairing stage at INFO level without leaking the invitation secret or the code', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeApprovingFake()
    const store = await makeStore()
    const payload = payloadFor(fakeInfo)
    const invitationSecret = (JSON.parse(payload) as { invitationSecret: string }).invitationSecret

    const record = await pair({ identity, store, payload })

    const logged = consoleInfo.mock.calls.flat().map(String).join('\n')
    // Every stage transition the run goes through is present, tagged as ours.
    for (const stage of ['validate', 'connect', 'claim', 'waiting']) {
      expect(logged, `stage ${stage} must be logged`).toContain(stage)
    }
    expect(logged).toContain('cherry-remote')

    // The two secrets a pairing carries never reach the log: the invitation
    // secret (from the payload) and the 6-digit verification code.
    expect(invitationSecret.length).toBeGreaterThan(0)
    expect(logged).not.toContain(invitationSecret)
    const code = fakeInfo.fake.verificationCode
    expect(code).toMatch(/^[0-9]{6}$/)
    expect(logged).not.toContain(code)
    // ...and the access token the approval returned is not there either.
    expect(logged).not.toContain(record.accessToken!)
  }, 15_000)

  it('⑨ the expired verdict tells the user to regenerate the pairing code', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ pairingGetPendingPolls: 3, pairingDecision: 'expired' })
    const store = await makeStore()

    const error = await pairingError(pair({ identity, store, payload: payloadFor(fakeInfo) }))

    expect(error.kind).toBe('expired')
    expect(error.message.toLowerCase()).toContain('regenerate')
  }, 15_000)

  it('⑩ the rejected verdict tells the user to verify the 6-digit code on the desktop side', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ pairingDecision: 'rejected' })
    const store = await makeStore()

    const error = await pairingError(pair({ identity, store, payload: payloadFor(fakeInfo) }))

    expect(error.kind).toBe('rejected')
    const message = error.message.toLowerCase()
    expect(message).toContain('6-digit')
    expect(message).toContain('code')
  }, 15_000)

  // -------------------------------------------------------------------------
  // v3 pairing QR (issue #124): a 2.1.8 custom-address invitation carries
  // `endpoints` (host, port, security) instead of `ips` + `port`. The hand-
  // rolled v2-only field check refused it `invalid-payload` before the bump.
  // -------------------------------------------------------------------------

  it('⑪ accepts a v3 endpoint payload and pairs end to end against the loopback peer', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeApprovingFake()
    const store = await makeStore()

    const record = await pair({ identity, store, payload: v3PayloadFor(fakeInfo) })

    expect(record.deviceId).toBe(fakeInfo.fake.approvedDeviceId)
    // The endpoint's host/port are what the walk dialed and what the record
    // carries: v3 has no ips array, the endpoints ARE the candidates.
    expect(record.hosts).toEqual([fakeInfo.host])
    expect(record.port).toBe(fakeInfo.port)
    expect(record.ports).toEqual({ [fakeInfo.host]: fakeInfo.port })
    expect(fakeInfo.fake.methodCount('pairing.claim')).toBe(1)
  }, 15_000)

  it('⑪j a mixed-port v3 payload persists each endpoint’s OWN port (issue #135)', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeApprovingFake()
    const store = await makeStore()
    const otherHost = '127.0.0.2'
    // Never dialed — the live endpoint is first, so the walk stops there. It
    // only has to be a DIFFERENT port from the winner's for the v3 payload to
    // be one the old record projection could not describe.
    const otherPort = fakeInfo.port + 1

    const record = await pair({
      identity,
      store,
      payload: v3PayloadFor(fakeInfo, {
        endpoints: [
          { host: fakeInfo.host, port: fakeInfo.port, security: 'ws' },
          { host: otherHost, port: otherPort, security: 'ws' },
        ],
      }),
    })

    // The winner is the candidate the walk completed on: the record-level
    // `port` is ITS port and stays the fallback.
    expect(record.hosts).toEqual([fakeInfo.host, otherHost])
    expect(record.port).toBe(fakeInfo.port)
    // ...while every host keeps its own port, so a steady-state reconnect to
    // the non-winner host does not dial the winner's port (issue #135).
    expect(record.ports).toEqual({
      [fakeInfo.host]: fakeInfo.port,
      [otherHost]: otherPort,
    })
    expect(store.list()[0]!.ports).toEqual(record.ports)
  }, 15_000)

  it('⑪k rejects a v3 endpoint port outside the dial range BEFORE any device work', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    // The live endpoint is FIRST: the only reason it is never dialed is that
    // the whole address list is judged before the walk starts. (With the
    // PINNED schema the verdict is the schema's — its endpoint port is already
    // int 1..65535 — and the local rule below is the pin-independent backstop;
    // ⑪k2 drives that rule directly.)
    for (const port of [0, 70_000, 80.5]) {
      const error = await pairingError(
        pair({
          identity,
          store,
          payload: v3PayloadFor(fakeInfo, {
            endpoints: [
              { host: fakeInfo.host, port: fakeInfo.port, security: 'ws' },
              { host: '127.0.0.2', port, security: 'ws' },
            ],
          }),
        }),
      )

      expect(error.kind, `port ${port}`).toBe('invalid-payload')
      expect(fakeInfo.fake.connectionCount, `port ${port}`).toBe(0)
      expect(fakeInfo.fake.methodCount('pairing.claim'), `port ${port}`).toBe(0)
      expect(store.list(), `port ${port}`).toEqual([])
    }
  })

  it('⑪k2 the local address rule refuses a junk endpoint port even when the schema admits it', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    // Simulate the FUTURE pin the header warns about: a schema that accepts the
    // port (the pin-independent rule must still refuse it before any device
    // work). Without this, the guard is invisible behind the pinned schema and
    // a schema widening would silently reintroduce the post-approval failure.
    const admitted = (port: number): never =>
      ({
        success: true,
        data: {
          v: 3,
          t: 'cherry-studio-pair',
          name: 'cherry-host',
          desktopIdentity: fakeInfo.desktopIdentity,
          invitationId: 'inv-1',
          invitationSecret: 'secret-1',
          protocolVersions: [1],
          endpoints: [
            { host: fakeInfo.host, port: fakeInfo.port, security: 'ws' },
            { host: '127.0.0.2', port, security: 'ws' },
          ],
        },
      }) as never

    for (const port of [0, 70_000, 80.5]) {
      vi.spyOn(pairingQrSchema, 'safeParse').mockReturnValueOnce(admitted(port))
      const error = await pairingError(pair({ identity, store, payload: v3PayloadFor(fakeInfo) }))

      expect(error.kind, `port ${port}`).toBe('invalid-payload')
      expect(error.message, `port ${port}`).toContain('port must be an integer in 1..65535')
      expect(fakeInfo.fake.connectionCount, `port ${port}`).toBe(0)
      expect(fakeInfo.fake.methodCount('pairing.claim'), `port ${port}`).toBe(0)
      expect(store.list(), `port ${port}`).toEqual([])
    }
  })

  it('⑪l rejects duplicate v3 endpoints BEFORE any device work', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    // The maps are keyed by host, so one host cannot carry two ports. (The two
    // entries differ by port, which is what makes this a HOST duplicate rather
    // than a repeated endpoint.)
    const error = await pairingError(
      pair({
        identity,
        store,
        payload: v3PayloadFor(fakeInfo, {
          endpoints: [
            { host: fakeInfo.host, port: fakeInfo.port, security: 'ws' },
            { host: fakeInfo.host, port: fakeInfo.port + 1, security: 'ws' },
          ],
        }),
      }),
    )

    expect(error.kind).toBe('invalid-payload')
    expect(error.message).toContain(`must not repeat host "${fakeInfo.host}"`)
    expect(fakeInfo.fake.connectionCount).toBe(0)
    expect(fakeInfo.fake.methodCount('pairing.claim')).toBe(0)
    expect(store.list()).toEqual([])
  })

  it('⑪m rejects duplicate v2 hosts AFTER IPv6 normalization BEFORE any device work', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    // `[::1]` is normalized to the bare `::1` before the schema sees it, so
    // these are the same host twice — the collapsed form is what would reach
    // the record and its host-keyed maps.
    const error = await pairingError(
      pair({
        identity,
        store,
        payload: payloadFor(fakeInfo, { ips: ['[::1]', '::1'], port: 65_001 }),
      }),
    )

    expect(error.kind).toBe('invalid-payload')
    expect(error.message).toContain('must not repeat host "::1"')
    expect(fakeInfo.fake.connectionCount).toBe(0)
    expect(fakeInfo.fake.methodCount('pairing.claim')).toBe(0)
    expect(store.list()).toEqual([])
  })

  it('⑪n a store failure after approval surfaces as itself, never as `unreachable`', async () => {
    const identity = await createDeviceIdentity()
    // The desktop APPROVES (the invitation is consumed); the archive write is
    // what fails. That is a fact about the archive, not about any address, so
    // classifying it as `unreachable` would send the operator to re-pair a
    // device the desktop has already approved.
    const fakeInfo = await makeApprovingFake()
    const sentinel = new Error('STORE-SENTINEL')
    const store = {
      upsert: () => {
        throw sentinel
      },
    } as unknown as DeviceStore

    const error = await pair({ identity, store, payload: payloadFor(fakeInfo) }).then(
      () => undefined,
      (reason: unknown) => reason,
    )

    // The very thrown object, not a PairingError wrapping it.
    expect(error).toBe(sentinel)
    expect((error as { kind?: string }).kind).toBeUndefined()
    // ...and the run really did reach approval first.
    expect(fakeInfo.fake.methodCount('pairing.claim')).toBe(1)
    expect(fakeInfo.fake.methodCount('pairing.get')).toBeGreaterThanOrEqual(1)
  }, 15_000)

  it('⑪b dials a bare IPv6 v3 endpoint (bracketed on the URL, bare in the archive)', async () => {
    const identity = await createDeviceIdentity()
    // The fake listens on IPv6 loopback; `host` is the BARE `::1` the v3
    // schema admits (hostSchema rejects brackets — the dial side re-brackets).
    const fakeInfo = await makeFake({
      bindHost: '::1',
      pairingDecision: 'approved',
      pairingGetPendingPolls: APPROVE_AFTER_POLLS,
    })
    const store = await makeStore()

    const record = await pair({ identity, store, payload: v3PayloadFor(fakeInfo) })

    expect(record.hosts).toEqual(['::1'])
    expect(fakeInfo.fake.connectionCount).toBe(1)
    expect(fakeInfo.fake.methodCount('pairing.claim')).toBe(1)
  }, 15_000)

  it('⑪c a wss v3 endpoint is ACCEPTED (validation) — the fault is the dial, not the payload', async () => {
    const identity = await createDeviceIdentity()
    // A plain-ws fake behind the address: the TLS dial cannot complete, but
    // the payload itself is schema-valid, so the run must reach the dial and
    // fail `unreachable` — never refuse the invitation as `invalid-payload`.
    const fakeInfo = await makeFake()
    const store = await makeStore()

    const error = await pairingError(
      pair({
        identity,
        store,
        connectTimeoutMs: 1_500,
        payload: v3PayloadFor(fakeInfo, {
          endpoints: [{ host: fakeInfo.host, port: fakeInfo.port, security: 'wss' }],
        }),
      }),
    )

    expect(error.kind).toBe('unreachable')
    expect(store.list()).toEqual([])
    // No Noise channel ever completed and no pairing RPC ran.
    expect(fakeInfo.fake.connectionCount).toBe(0)
    expect(fakeInfo.fake.methodCount('pairing.claim')).toBe(0)
  }, 15_000)

  it('⑪h a wss v3 endpoint is persisted with its per-host security (issue #126)', async () => {
    const identity = await createDeviceIdentity()
    // The TLS front reaches the SAME fake desktop a plain dial would (see
    // tests/helpers/tls/dualPeer.ts): the pairing walks the endpoint, the peer
    // approves, and the record must remember the scheme the walk actually used.
    const peer = await makeDualPeer({
      desktop: { pairingDecision: 'approved', pairingGetPendingPolls: APPROVE_AFTER_POLLS },
    })
    peers.push(peer)
    const fakeInfo = {
      fake: peer.desktop,
      host: '127.0.0.1',
      port: peer.tlsPort,
      desktopIdentity: peer.desktopIdentity,
    }
    const store = await makeStore()

    const record = await pair({
      identity,
      store,
      // The self-signed fixture the TLS front presents: trusting it is the
      // client-side half a private-CA deployment configures.
      wsOptions: insecureTlsOptions,
      payload: v3PayloadFor(fakeInfo, {
        endpoints: [{ host: '127.0.0.1', port: peer.tlsPort, security: 'wss' }],
      }),
    })

    // The record's scheme map is the DIAL's own candidate list, so the
    // steady-state reconnect (src/connection.ts) rebuilds the same URL.
    expect(record.hosts).toEqual(['127.0.0.1'])
    expect(record.security).toEqual({ '127.0.0.1': 'wss' })
    expect(store.list()[0]!.security).toEqual({ '127.0.0.1': 'wss' })
    expect(peer.desktopConnections()).toBe(1)
  }, 15_000)

  it('⑪i a v2 payload pairs with security ws for every ip (the pre-#124 shape is unchanged)', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeApprovingFake()
    const store = await makeStore()

    const record = await pair({ identity, store, payload: payloadFor(fakeInfo) })

    // v2 has no endpoint scheme: `ips` are plain hosts, and the persisted map
    // says so explicitly rather than relying on a read-time default.
    expect(record.hosts).toEqual([fakeInfo.host])
    expect(record.security).toEqual({ [fakeInfo.host]: 'ws' })
  }, 15_000)

  it('⑪d rejects a v3 payload whose endpoints list is empty as invalid-payload', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    const error = await pairingError(
      pair({ identity, store, payload: v3PayloadFor(fakeInfo, { endpoints: [] }) }),
    )

    expect(error.kind).toBe('invalid-payload')
    expect(fakeInfo.fake.socketCount).toBe(0)
    expect(store.list()).toEqual([])
  })

  it('⑪e rejects a v3 endpoint host that is not a clean IP/hostname (credentials) as invalid-payload', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    // The published `pairingQrSchema` v3 arm (the `user@host/path` fixture in
    // the package's own fixtures/pairing-qr.json) — consuming it, not
    // hand-rolling the field check, is what makes this verdict the schema's.
    const error = await pairingError(
      pair({
        identity,
        store,
        payload: v3PayloadFor(fakeInfo, {
          endpoints: [{ host: 'user@evil.example/path', port: 443, security: 'wss' }],
        }),
      }),
    )

    expect(error.kind).toBe('invalid-payload')
    expect(fakeInfo.fake.socketCount).toBe(0)
    expect(store.list()).toEqual([])
  })

  it('⑪f an invalid v3 payload refuses without echoing the invitation secret into the message', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    // The rejection must name the failing SHAPE, never the values: the schema
    // error surface carries `input` echoings, and a naive error builder that
    // dumps issue inputs puts the secret into a user-visible error message.
    const SECRET = 'INVITATION-SENTINEL-3f9c'
    const error = await pairingError(
      pair({
        identity,
        store,
        payload: v3PayloadFor(fakeInfo, { invitationSecret: SECRET, endpoints: [] }),
      }),
    )

    expect(error.kind).toBe('invalid-payload')
    // Two discriminating claims: the secret never appears, AND the message
    // still names a failing FIELD PATH — a rejection builder that went silent
    // (no paths at all) would fail the second, not silently pass the first.
    expect(error.message).not.toContain(SECRET)
    expect(error.message).toContain('endpoints')
  })

  it('⑪g a v2 payload with a DOMAIN in ips is now refused by the schema arm (IPs only in v2)', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    // PRE-BUMP BEHAVIOR ACCEPTED ANY STRING: the hand-rolled check only tested
    // character caps. The published schema's v2 arm is `z.ipv4()|z.ipv6()`
    // (the fixtures name this "DNS must not masquerade as IP") — a 2.1.8
    // custom HOSTNAME invitation is therefore v3, and a v2 that carries one
    // is a malformed payload, refused before any dial.
    const error = await pairingError(
      pair({ identity, store, payload: payloadFor(fakeInfo, { ips: ['desktop.example.com'] }) }),
    )

    expect(error.kind).toBe('invalid-payload')
    expect(fakeInfo.fake.socketCount).toBe(0)
  })

  it('⑫ refuses a lone surrogate in an id field (the unicodeText rule survives the schema switch)', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    // The published `pairingQrSchema` bounds these fields by LENGTH only;
    // the lone-surrogate refusal is OUR rule (the peer enforces it on the
    // claim params face). After the pre-bump checks were replaced by schema
    // consumption, nothing but this loop kept the rule — this test is what
    // makes deleting it a red build rather than a wire-side surprise.
    const error = await pairingError(
      pair({ identity, store, payload: payloadFor(fakeInfo, { invitationId: '\ud800x' }) }),
    )

    expect(error.kind).toBe('invalid-payload')
    expect(fakeInfo.fake.socketCount).toBe(0)
  })

  it('⑫b refuses a lone surrogate in desktopIdentity too (the loop pins its whole field list)', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    // ⑫ drives invitationId only; this is the OTHER end of the loop's field
    // list. desktopIdentity reaches the wire as the claim's remoteIdentity
    // face (an opaqueId, which enforces unicodeText) — deleting the local
    // loop would push this refusal one round trip later, onto the claim RPC,
    // and ⑫ alone would never show it.
    const error = await pairingError(
      pair({ identity, store, payload: payloadFor(fakeInfo, { desktopIdentity: 'x\ud800' }) }),
    )

    expect(error.kind).toBe('invalid-payload')
    expect(fakeInfo.fake.socketCount).toBe(0)
  })
})
