import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore'
import { pairWithPayload } from '../../src/pairing'
import type { PairingError } from '../../src/pairing'
import { FakeCherry } from '../loopback/fakeCherry'
import type { FakeCherryOptions } from '../loopback/fakeCherry'

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
      schemaVersion: 2,
      // deviceId/grants/token exist ONLY on the approved branch: the claim
      // receipt carried claimId/verificationCode/expiresAt and nothing else.
      deviceId: fakeInfo.fake.approvedDeviceId,
      displayName: hostname().slice(0, 64),
      hosts: [fakeInfo.host],
      port: fakeInfo.port,
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

  it('⑤ ignores payload fields outside the consumed manifest (e.g. name) and warns about them', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeApprovingFake()
    const store = await makeStore()

    const record = await pair({
      identity,
      store,
      payload: payloadFor(fakeInfo, { name: 'some-other-host', futureField: { nested: true } }),
    })

    // The ignored payload `name` (the desktop's own hostname) never becomes
    // the record's display name — that is THIS machine's claimed device name.
    // `name` is not on the consumed manifest (spec §3.3 step 1).
    expect(record.displayName).toBe(hostname().slice(0, 64))
    expect(record.displayName).not.toBe('some-other-host')
    expect(record).not.toHaveProperty('futureField')
    const warned = consoleWarn.mock.calls.flat().map(String).join('\n')
    expect(warned).toContain('name')
    expect(warned).toContain('futureField')
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
})
