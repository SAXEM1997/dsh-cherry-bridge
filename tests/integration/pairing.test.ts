import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeviceIdentity, deviceIdentityId } from '@cherrystudio/remote-transport'
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
  /** Forwarded verbatim: the production default applies when unset. */
  dialBudgetMs?: number
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
    dialBudgetMs: opts.dialBudgetMs,
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

    // NOTE — the empty intersection is refused LOCALLY, inside the post-open
    // half: `connectSecureChannel` parses the offer before writing any prelude,
    // and `protocolSupportSchema` requires at least one version. So this is a
    // `channel:` failure (⑧e's kind), NOT a peer prelude verdict — no offer
    // ever reached the wire. Contrast with Task 5①, which injects a RECEIPT
    // inconsistency (a hello echo differing from the offer).
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
    // The socket was dialed, but no Noise channel completed and no pairing RPC
    // ran: the refusal happened before the prelude write.
    expect(fakeInfo.fake.socketCount).toBe(1)
    expect(fakeInfo.fake.connectionCount).toBe(0)
    expect(fakeInfo.fake.methodCount('pairing.claim')).toBe(0)
    expect(fakeInfo.fake.methodCount('connection.hello')).toBe(0)
    // The failure is the local post-open refusal, so it carries the kind. The
    // candidate label ALREADY contains digits, so `toContain('7')` here would
    // be satisfied by `127.0.0.1` — the kind is what makes this non-vacuous.
    expect(error.message).toContain(': channel:')
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
  // One aggregate DIAL budget (issue #141): a v3 QR admits up to 32
  // endpoints, so serial `connectTimeoutMs` dials could spend 320 s on an
  // invitation that only lives 120 s. The walk is bounded by ONE deadline;
  // the per-attempt timeout is untouched except for the clamp below.
  // -------------------------------------------------------------------------

  it('⑦a a spent dial budget dials NOTHING and names every candidate as not attempted', async () => {
    const identity = await createDeviceIdentity()
    // The fake listens on ALL loopback addresses, so BOTH endpoints below are
    // LIVE: under any non-zero budget a dial would connect and claim, which is
    // what makes `connectionCount: 0` proof the budget (not the address list)
    // stopped the walk.
    const fakeInfo = await makeFake({
      bindHost: '0.0.0.0',
      pairingDecision: 'approved',
      pairingGetPendingPolls: APPROVE_AFTER_POLLS,
    })
    const store = await makeStore()
    const endpoints = [
      { host: '127.0.0.1', port: fakeInfo.port, security: 'ws' },
      { host: '127.0.0.2', port: fakeInfo.port, security: 'ws' },
    ]

    const error = await pairingError(
      pair({
        identity,
        store,
        dialBudgetMs: 0,
        payload: v3PayloadFor(fakeInfo, { endpoints }),
      }),
    )

    expect(error.kind).toBe('unreachable')
    // EVERY candidate is named, and named as UNATTEMPTED — and each appears
    // EXACTLY ONCE. Dropping the branch's `continue` lets the fall-through dial
    // fail and push a SECOND segment naming the same address (the dial error
    // already carries the candidate's `host:port`), so this duplicate — not any
    // particular dial wording — is the wording-independent mutant detector.
    for (const endpoint of endpoints) {
      const label = `${endpoint.host}:${endpoint.port}`
      expect(error.message, `not attempted for ${label}`).toContain(`${label}: not attempted`)
      expect(error.message.split(label).length - 1, `occurrences of ${label}`).toBe(1)
    }
    expect(error.message.match(/not attempted/g) ?? []).toHaveLength(endpoints.length)
    // Budget 0 means not one dial was even started — against a live peer.
    expect(fakeInfo.fake.connectionCount).toBe(0)
    expect(fakeInfo.fake.socketCount).toBe(0)
    expect(store.list()).toEqual([])
  }, 15_000)

  it('⑦b clamps the dial timeout to the budget remainder, so the walk fails fast', async () => {
    const identity = await createDeviceIdentity()
    // The peer is LIVE (it listens and would approve a completed dial), but it
    // HOLDS its Noise handshake past the per-attempt bound: the clamp is what
    // ends this dial. Without the clamp the dial would sit the full
    // `connectTimeoutMs` (10 s) and the elapsed assertion — not the 15 s test
    // timeout — is what catches it. A plain live peer would instead complete
    // the handshake inside the clamp, making the test a race.
    const fakeInfo = await makeFake({
      pairingDecision: 'approved',
      pairingGetPendingPolls: APPROVE_AFTER_POLLS,
      handshakeDelayMs: 11_000,
    })
    const store = await makeStore()
    const startedAt = performance.now()

    const error = await pairingError(
      pair({
        identity,
        store,
        dialBudgetMs: 250,
        // A per-attempt bound 40x the budget: WITHOUT the clamp this would
        // sit here for ten seconds after the budget is gone.
        connectTimeoutMs: 10_000,
        payload: v3PayloadFor(fakeInfo),
      }),
    )

    const elapsed = performance.now() - startedAt
    expect(error.kind).toBe('unreachable')
    expect(error.message).toContain('timed out')
    // The assertion the un-clamped mutant fails. The 15 s test timeout above
    // is only the safety net, not the claim.
    expect(elapsed).toBeLessThan(2_000)
    expect(store.list()).toEqual([])
  }, 15_000)

  it('⑦c a budget wide enough for the walk leaves the happy path unchanged', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeApprovingFake()
    const store = await makeStore()

    const record = await pair({
      identity,
      store,
      dialBudgetMs: 5_000,
      payload: v3PayloadFor(fakeInfo),
    })

    expect(record.deviceId).toBe(fakeInfo.fake.approvedDeviceId)
    expect(fakeInfo.fake.connectionCount).toBe(1)
    expect(store.list()).toEqual([record])
  }, 15_000)

  it('⑦d a non-finite budget falls back to the default instead of disabling the bound', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeApprovingFake()
    const store = await makeStore()

    // `NaN` must not become the deadline: `performance.now() + NaN` makes every
    // `remaining` NaN, the `<= 0` early branch never fires and the per-dial
    // clamp yields a ~1 ms timeout — every live candidate would "fail". The
    // default (30 s) has to apply instead, so the happy path still completes.
    const record = await pair({
      identity,
      store,
      dialBudgetMs: Number.NaN,
      payload: v3PayloadFor(fakeInfo),
    })

    expect(record.deviceId).toBe(fakeInfo.fake.approvedDeviceId)
    expect(fakeInfo.fake.connectionCount).toBe(1)
    expect(store.list()).toEqual([record])
  }, 15_000)

  // -------------------------------------------------------------------------
  // Candidate failure KIND (issue #142): a failed PRE-OPEN dial is prefixed
  // `timeout:` or `websocket:` so the joined `unreachable` verdict names the
  // FIX — retry the network (a timeout) versus fix the address/TLS (a
  // refused/closed socket) — and the ws error's own code survives in the
  // message. A POST-OPEN (Noise/identity/protocol) failure is the third kind,
  // `channel:` (⑧e) — the socket worked, so the address is not the suspect.
  // -------------------------------------------------------------------------

  it('⑧a names a timed-out candidate dial timeout:, never websocket:', async () => {
    const identity = await createDeviceIdentity()
    // The peer is LIVE but HOLDS its Noise handshake past the per-dial bound,
    // so the elapsed timer is the only thing that can end this dial. The dial
    // budget is left at its default: the budget is not what this test moves.
    const fakeInfo = await makeFake({
      pairingDecision: 'approved',
      pairingGetPendingPolls: APPROVE_AFTER_POLLS,
      handshakeDelayMs: 2_000,
    })
    const store = await makeStore()
    const label = `${fakeInfo.host}:${fakeInfo.port}`

    const error = await pairingError(
      pair({ identity, store, connectTimeoutMs: 50, payload: v3PayloadFor(fakeInfo) }),
    )

    expect(error.kind).toBe('unreachable')
    // The KIND precedes the candidate's own description, so the joined verdict
    // says the network is the thing to retry. Without the prefix this reads as
    // `connect to host:port timed out`, indistinguishable from a socket fault.
    expect(error.message).toContain(`${label}: timeout:`)
    expect(error.message).not.toContain('websocket:')
    expect(store.list()).toEqual([])
  }, 15_000)

  it('⑧b names a refused candidate socket websocket: and keeps the OS code', async () => {
    const identity = await createDeviceIdentity()
    // The fake supplies a valid payload identity; its OWN port is not dialed.
    // Port 1 is a closed loopback port (the ⑥b fixture): the OS refuses the
    // TCP connect, which is exactly the address/TLS class of fault.
    const fakeInfo = await makeFake()
    const store = await makeStore()

    const error = await pairingError(
      pair({ identity, store, payload: payloadFor(fakeInfo, { ips: ['127.0.0.1'], port: 1 }) }),
    )

    expect(error.kind).toBe('unreachable')
    // The failed segment STARTS with the kind, after the candidate label.
    expect(error.message).toContain('127.0.0.1:1: websocket:')
    // The ws error's `code` is the discriminator a bare message drops. The
    // exact errno is PLATFORM-dependent (ECONNREFUSED on Linux, another name
    // elsewhere), so only the shape is pinned, never the literal.
    expect(error.message).toMatch(/127\.0\.0\.1:1: websocket: .*\(code [A-Z0-9_]+\)/)
    expect(error.message).not.toContain('timeout:')
    expect(store.list()).toEqual([])
  }, 15_000)

  it('⑧c a socket that closes before open is a websocket: verdict, not a timeout', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()
    // A bare TCP peer that accepts and destroys the socket: the WebSocket
    // upgrade never completes, so the dial must reject on the socket's own
    // failure instead of waiting out `connectTimeoutMs`. The ACCEPTED COUNTER
    // is what proves this fixture was hit: a connect that was never accepted
    // (an unused port) would fail as a refused connect — a different fixture
    // that the message assertions alone cannot tell apart from this one.
    let accepted = 0
    const server = createServer((socket) => {
      accepted += 1
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const startedAt = performance.now()
    try {
      const error = await pairingError(
        pair({
          identity,
          store,
          // Ten seconds of per-dial bound: only the socket's own failure can
          // end this run inside the elapsed assertion below.
          connectTimeoutMs: 10_000,
          payload: v3PayloadFor(fakeInfo, {
            endpoints: [{ host: '127.0.0.1', port, security: 'ws' }],
          }),
        }),
      )

      const elapsed = performance.now() - startedAt
      expect(error.kind).toBe('unreachable')
      // The fixture really was dialed...
      expect(accepted).toBe(1)
      // ...and the failure is THIS fixture's: a reset of an accepted socket
      // ("socket hang up"/ECONNRESET), not a refused connect.
      expect(error.message).toContain('socket hang up')
      expect(error.message).toContain('(code ECONNRESET)')
      expect(error.message).toContain(`127.0.0.1:${port}: websocket:`)
      expect(error.message).not.toContain('timeout:')
      // No multi-second wait: the close/error path woke the dial, not the timer.
      expect(elapsed).toBeLessThan(2_000)
      expect(store.list()).toEqual([])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 15_000)

  it('⑧d a ws error with no code keeps websocket: and fabricates no code', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()
    // A bare TCP peer that answers the upgrade with a plain 404: ws rejects the
    // handshake as "Unexpected server response: 404" — an Error with NO `code`.
    // That is the arm where the suffix must simply be ABSENT; appending
    // `(code undefined)` would invent a discriminator the operator cannot use.
    // `socket.end` leaves the peer's half of THIS fixture open on this runtime,
    // so the connections are tracked and destroyed before `close()` (which
    // otherwise never calls back).
    let accepted = 0
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      accepted += 1
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const error = await pairingError(
        pair({
          identity,
          store,
          payload: v3PayloadFor(fakeInfo, {
            endpoints: [{ host: '127.0.0.1', port, security: 'ws' }],
          }),
        }),
      )

      expect(error.kind).toBe('unreachable')
      expect(accepted).toBe(1)
      // The failed segment starts with the kind and carries the peer's answer.
      expect(error.message).toContain(`127.0.0.1:${port}: websocket: `)
      expect(error.message).toContain('404')
      expect(error.message).not.toContain('timeout:')
      // No `code` on this ws error, so no `(code …)` suffix.
      expect(error.message).not.toContain('(code')
      expect(store.list()).toEqual([])
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 15_000)

  it('⑧e names a post-open identity failure channel:, never websocket: or timeout:', async () => {
    const identity = await createDeviceIdentity()
    // A valid peer identity that is NOT this fake's: the TCP connect and the
    // WebSocket upgrade both succeed, and the Noise identity PROOF is what
    // refuses — exactly a QR generated for a different desktop (or one
    // re-scanned after the desktop's identity was reset). A malformed identity
    // string no longer reaches this arm at all: `parsePayload` decodes the pin
    // before any socket (issue #153), so the post-open pin DECODE this test
    // used to disqualify is UNREACHABLE THROUGH THE TOOL — that is why the
    // fixture must still be a valid OTHER key.
    const otherKey = await createDeviceIdentity()
    // NEGATIVE CONTROL: the passing path never claims, but if the identity
    // check were bypassed the approving peer would complete the handshake and
    // the test would fail fast instead of waiting out the 3 s poll cap.
    const fakeInfo = await makeApprovingFake()
    const store = await makeStore()
    const label = `${fakeInfo.host}:${fakeInfo.port}`

    const error = await pairingError(
      pair({
        identity,
        store,
        payload: v3PayloadFor(fakeInfo, { desktopIdentity: deviceIdentityId(otherKey) }),
      }),
    )

    expect(error.kind).toBe('unreachable')
    // REACH PROOF, wording-independent: the fixture accepted exactly one
    // socket and never counted a Noise channel as established. The failure text
    // asserted below is the discriminator for WHICH post-open arm this is, but
    // it comes from the pinned transport's Noise dependency and a bump could
    // reword it with no product change — so it is never the reach proof.
    expect(fakeInfo.fake.socketCount).toBe(1)
    expect(fakeInfo.fake.connectionCount).toBe(0)
    // The failed segment STARTS with the third kind: the socket reached the
    // peer and only the identity proof failed. An unprefixed rejection here
    // reads exactly like a pre-open one, which is the defect this pins.
    expect(error.message).toContain(`${label}: channel:`)
    expect(error.message).not.toContain('websocket:')
    expect(error.message).not.toContain('timeout:')
    // Our LOCAL Noise initiator compares the presented static key against the
    // pin; no peer-authored message travels. The prefix is ours and the local
    // diagnosis follows it, so the operator still learns which keys disagreed.
    expect(error.message).toContain('does not match expected remote identity key')
    expect(store.list()).toEqual([])
  }, 15_000)

  it('⑧f names a peer-side protocol refusal channel: and fails fast', async () => {
    const identity = await createDeviceIdentity()
    // The peer supports [7]; the payload and local support are [1]. The offer
    // is NON-EMPTY and reaches the wire: the client's prelude write succeeds
    // and the PEER refuses the selection. That is the one arm ⑥ does not
    // cover — ⑥ is a LOCAL empty-offer parse with no wire offer.
    const fakeInfo = await makeFake({ protocolVersions: [7] })
    const store = await makeStore()
    const label = `${fakeInfo.host}:${fakeInfo.port}`
    const startedAt = performance.now()

    const error = await pairingError(
      pair({ identity, store, payload: v3PayloadFor(fakeInfo, { protocolVersions: [1] }) }),
    )

    expect(error.kind).toBe('unreachable')
    expect(error.message).toContain(`${label}: channel:`)
    expect(error.message).not.toContain('websocket:')
    expect(error.message).not.toContain('timeout:')
    // The dial reached a live peer that then REFUSED: one accepted socket and
    // no channel. A dial refusal would be a different fixture.
    expect(fakeInfo.fake.socketCount).toBe(1)
    expect(fakeInfo.fake.connectionCount).toBe(0)
    expect(store.list()).toEqual([])
    // Determinism guard: the peer's refusal must settle the dial. If it went
    // silent instead, the per-dial timer (3 s in this suite) would win and the
    // verdict would be `timeout:` — caught above, and this bound keeps a slow
    // pass from ever masking it.
    expect(performance.now() - startedAt).toBeLessThan(2_000)
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

  // -------------------------------------------------------------------------
  // Bounded `unreachable` verdict (issue #148): the joined message used to be
  // unbounded — 32 v3 endpoints × a 253-char host, repeated again inside its
  // dial error, reached ~17-18 KB in ONE tool result. Each candidate still
  // contributes exactly one segment (#141: every candidate, attempted or not,
  // is NAMED); the SEGMENT is bounded, never the coverage.
  // -------------------------------------------------------------------------

  /**
   * A schema-valid hostname of exactly `length` characters, unique per `i`
   * (`hostnameSchema`: dot-separated labels of 1-63 chars, total <= 253),
   * ending in the reserved non-resolving `.invalid` TLD.
   */
  function longHost(i: number, length: number): string {
    const head = `h${String(i).padStart(2, '0')}`
    const tail = '.invalid'
    let host = head
    while (host.length + tail.length < length) {
      const labelLength = Math.min(63, length - tail.length - host.length - 1)
      if (labelLength < 1) break
      host += `.${'a'.repeat(labelLength)}`
    }
    return host + tail
  }

  it('⑬a bounds the joined verdict for 32 near-maximal candidates WITHOUT dialling', async () => {
    const identity = await createDeviceIdentity()
    // A live peer supplies only a valid `desktopIdentity`; the payload's 32
    // endpoints are the near-maximal names below, and budget 0 means not one
    // dial starts (so this test is deterministic and offline).
    const fakeInfo = await makeFake()
    const store = await makeStore()
    const endpoints = Array.from({ length: 32 }, (_, index) => ({
      host: longHost(index + 1, 253),
      port: 10_000 + index,
      security: 'ws' as const,
    }))
    const payload = v3PayloadFor(fakeInfo, { endpoints })
    // MAX_PAYLOAD_BYTES is 10 KiB; 32 × 253-char hosts still fit (~9.6 KB),
    // asserted rather than assumed — an oversized fixture would be refused as
    // `invalid-payload` before the walk ever runs.
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThanOrEqual(10 * 1024)

    const error = await pairingError(pair({ identity, store, payload, dialBudgetMs: 0 }))

    expect(error.kind).toBe('unreachable')
    // Budget 0 named every candidate WITHOUT opening a socket.
    expect(fakeInfo.fake.socketCount).toBe(0)

    const preamble = 'no candidate address could complete pairing ('
    expect(error.message.startsWith(preamble)).toBe(true)
    const segments = error.message.slice(preamble.length, -1).split('; ')
    // This '; ' split is sound only while no detail contains '; ': the
    // peer-controlled close reason (CLOSE_REASON_MAX = 200) is the only text
    // that could, and this fixture's details are fixed strings.
    // 32 segments, not fewer: the bound is per SEGMENT, never a "first N + and
    // M more" cut (issue #141's contract names every candidate).
    expect(segments).toHaveLength(32)
    // TWO different bounds, asserted separately. The JOINED LIST's documented
    // worst case is 32 segments × 240 + 31 separators × 2 = 7,742; the WHOLE
    // MESSAGE adds the preamble and the closing paren (7,788). This fixture
    // joins to 6,526 / renders 6,572, so both are BOUNDS on the documented
    // worst case, not measurements of this run.
    expect(segments.join('; ').length, 'joined list above its ceiling').toBeLessThanOrEqual(7_742)
    expect(error.message.length, 'joined verdict above its documented ceiling').toBeLessThanOrEqual(
      7_788,
    )
    // The label cap's marker is the one this arm carries. The DETAIL cap is
    // ⑬b's detector: with budget 0 the "not attempted" detail is 72 chars and
    // never reaches the 110-char room a 128-char label leaves, so ⑬a pins the
    // label cap and the total ceiling only.
    expect(error.message).toContain('…')

    endpoints.forEach((endpoint, index) => {
      const segment = segments[index]!
      // The CLIP POINT is what pins `FAILURE_LABEL_MAX`: the label is
      // `<host prefix>…:<port>` and occupies EXACTLY 128 chars, so the ellipsis
      // sits at 128 − `…:<port>`.length (121 for these 5-digit ports; the
      // ellipsis's own length is part of the cap). The prefix check below is
      // NOT load-bearing — it holds with no clipping at all; the marker index,
      // the exact `…:<port>` suffix and the 128-char label are.
      const portSuffix = `…:${endpoint.port}`
      const clip = segment.indexOf('…')
      expect(clip, `label clip point ${index}`).toBe(128 - portSuffix.length)
      expect(segment.slice(clip, clip + portSuffix.length), `label suffix ${index}`).toBe(portSuffix)
      expect(segment.slice(0, clip + portSuffix.length).length, `label length ${index}`).toBe(128)
      expect(segment.startsWith(endpoint.host.slice(0, 16)), `prefix ${index}`).toBe(true)
      expect(segment.length, `segment ${index}`).toBeLessThanOrEqual(240)
    })
    expect(store.list()).toEqual([])
  }, 15_000)

  it('⑬b bounds the DETAIL arm: a dial error repeating the long host is clipped, not dropped', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()
    // A near-maximal, non-resolving host: the dial's own 1 ms timer fires long
    // before DNS can answer, so the segment carries a LONG detail — and both
    // arms of that race (the timer's `timeout:` text and `getaddrinfo`'s
    // `websocket:` text) repeat the 253-char host, which is the point. Which
    // arm wins is deliberately not pinned.
    const host = longHost(99, 253)
    const port = 10_099

    const error = await pairingError(
      pair({
        identity,
        store,
        payload: v3PayloadFor(fakeInfo, { endpoints: [{ host, port, security: 'ws' }] }),
        connectTimeoutMs: 1,
        // Large: the per-dial bound ends this attempt, not the budget.
        dialBudgetMs: 5_000,
      }),
    )

    expect(error.kind).toBe('unreachable')
    const preamble = 'no candidate address could complete pairing ('
    const segment = error.message.slice(preamble.length, -1)
    // ONE candidate, ONE segment.
    expect(segment).not.toContain('; ')
    expect(segment.length).toBeLessThanOrEqual(240)
    // The label's identifying prefix AND its port survive the clip.
    expect(segment.startsWith(host.slice(0, 16))).toBe(true)
    const label = `…:${port}: `
    expect(segment).toContain(label)
    // The detail is clipped to the room the 128-char label leaves; the kind
    // prefix survives, and the marker's own length is charged to the bound.
    const detail = segment.slice(segment.indexOf(label) + label.length)
    expect(detail).toMatch(/^(?:timeout|websocket):/)
    expect(detail).toMatch(/… \(\+\d+ chars\)$/)
    // The marker names a real removal, not a 0-char no-op.
    expect(Number(/\(\+(\d+) chars\)$/.exec(detail)![1])).toBeGreaterThan(0)
    expect(store.list()).toEqual([])
  }, 15_000)

  it('⑬c leaves a short candidate failure byte-for-byte unchanged (no marker, no clip)', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()

    // ⑧b's fixture: a refused loopback port, short label and short detail. The
    // shaping helper must be a PURE IDENTITY here — no marker, no cut.
    const error = await pairingError(
      pair({ identity, store, payload: payloadFor(fakeInfo, { ips: ['127.0.0.1'], port: 1 }) }),
    )

    expect(error.kind).toBe('unreachable')
    expect(error.message).toMatch(
      /^no candidate address could complete pairing \(127\.0\.0\.1:1: websocket: .*\(code [A-Z0-9_]+\)\)$/,
    )
    // Identity is the assertion: neither truncation marker is present.
    expect(error.message).not.toContain('…')
    expect(error.message).not.toContain('(+')
    expect(store.list()).toEqual([])
  }, 15_000)

  it('⑬d bounds the CLAIM fall-through segment (a non-PairingError fault in the claim phase)', async () => {
    const identity = await createDeviceIdentity()
    // Bind ALL loopback addresses so the LIVE candidate can use a host string
    // distinct from the dead one: `payload endpoints must not repeat host`, and
    // 127.0.0.1 appears once already as the dead 127.0.0.1:1 (⑦a's fixture
    // shape, one candidate over).
    const fakeInfo = await makeFake({
      bindHost: '0.0.0.0',
      pairingDecision: 'approved',
      pairingGetPendingPolls: APPROVE_AFTER_POLLS,
    })
    const store = await makeStore()
    const liveHost = '127.0.0.2'
    const live = `${liveHost}:${fakeInfo.port}`

    // The claim arm needs its OWN fixture: `claimAndAwait` turns every
    // transport/peer fault into a PairingError (which the walk rethrows), so
    // the arm is reached by any NON-PairingError fault in the claim phase —
    // HERE, a throwing caller callback. Making `onVerificationCode` throw a
    // plain Error drives the walk's documented mid-flow fall-through, and the
    // 3,000-char text makes an UNSHAPED segment unmistakable. Candidate 2 is
    // dead, so the walk CONTINUES and then ends `unreachable` — the only path
    // by which this arm's segment is joined.
    const error = await pairingError(
      pair({
        identity,
        store,
        payload: v3PayloadFor(fakeInfo, {
          endpoints: [
            { host: liveHost, port: fakeInfo.port, security: 'ws' },
            { host: '127.0.0.1', port: 1, security: 'ws' },
          ],
        }),
        onVerificationCode: () => {
          throw new Error(`caller callback exploded ${'x'.repeat(3_000)}`)
        },
        // The suite's default per-dial bound (3 s) applies: this dial MUST
        // SUCCEED, so a small `connectTimeoutMs` would race a slow-but-correct
        // loopback handshake + claim and turn candidate 1 into a short
        // `timeout:` segment with no marker — red for the wrong reason. The
        // dead candidate refuses instantly, so nothing gets slower.
        dialBudgetMs: 10_000,
      }),
    )

    expect(error.kind).toBe('unreachable')
    const preamble = 'no candidate address could complete pairing ('
    const segments = error.message.slice(preamble.length, -1).split('; ')
    expect(segments).toHaveLength(2)

    // Candidate 1 went THROUGH the helper: the 3,000-char callback text is
    // clipped to the segment bound and carries the explicit detail marker.
    const claimSegment = segments.find((segment) => segment.startsWith(`${live}: `))
    expect(claimSegment, `claim segment for ${live}`).toBeDefined()
    expect(claimSegment!.length).toBeLessThanOrEqual(240)
    expect(claimSegment).toContain('… (+')

    // The walk really CONTINUED to the dead candidate after the claim fault.
    expect(segments.some((segment) => segment.startsWith('127.0.0.1:1: '))).toBe(true)
    expect(store.list()).toEqual([])
  }, 15_000)
  // -------------------------------------------------------------------------
  // Bounded progress line (issue #152). `report()` runs once per stage
  // transition and used to join EVERY candidate host into one `console.info`
  // line: a v3 QR admits 32 endpoints and a host name may be 253 characters,
  // ~8 KB per stage. ⑭a pins the bound; ⑭b is the other side of it — a short
  // list must still be named in full, with no `(+K more)` marker.
  // -------------------------------------------------------------------------

  it('⑭a bounds the progress line to the first host plus an explicit omitted count', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()
    // 32 UNIQUE, schema-valid hosts of the maximum 253 characters: four
    // labels of ≤63 chars over a lowercase `[a-z0-9-]` alphabet, summed with
    // the separators to exactly 253 (the published `hostnameSchema`'s cap),
    // with the `.invalid` TLD marking them as fictional. The fixture is
    // SCHEMA-validated by the run reaching the progress line; the payload
    // stays under the 10 KiB cap, and `dialBudgetMs: 0` makes every candidate
    // `not attempted`, so no dial happens (the fake still binds a real
    // loopback listener — this is "no dial", not "offline").
    const hosts = Array.from({ length: 32 }, (_, index) => {
      const label = `h${String(index).padStart(2, '0')}${'a'.repeat(60)}`
      return [label, 'b'.repeat(63), 'c'.repeat(58), 'd'.repeat(58), 'invalid'].join('.')
    })
    expect(new Set(hosts).size).toBe(32)
    expect(hosts.every((host) => host.length === 253)).toBe(true)

    const error = await pairingError(
      pair({
        identity,
        store,
        dialBudgetMs: 0,
        payload: v3PayloadFor(fakeInfo, {
          endpoints: hosts.map((host) => ({ host, port: fakeInfo.port, security: 'ws' })),
        }),
      }),
    )

    const progress = consoleInfo.mock.calls
      .flat()
      .map(String)
      .find((line) => line.includes('pairing stage validate'))
    expect(progress, 'the validate stage must be logged').toBeDefined()
    // CEILING: the two maxima are mutually exclusive — a first host above the
    // 160-char budget aborts the fill loop — so the worst case is the prefix
    // (47 for `validate`) + first host (253) + ` (+31 more)` (11) + closing
    // `)` (1) = 312 characters. 330 leaves slack for a longer stage name; an
    // unbounded join of these hosts is ~8 KB.
    expect(progress!.length).toBeLessThan(330)
    // The count of omitted candidates is explicit, and the FIRST host — the
    // run's identity — is still there in full.
    expect(progress).toContain('(+31 more)')
    expect(progress).toContain(hosts[0]!)
    // #141's contract is untouched: the verdict still names every candidate.
    // A spent budget makes all 32 `not attempted`, and #148 clips each
    // SEGMENT — it never drops a candidate.
    expect(error.kind).toBe('unreachable')
    expect(error.message.match(/not attempted/g) ?? []).toHaveLength(32)
  }, 15_000)

  it('⑭b names all three short hosts and adds no omitted marker', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()
    const hosts = ['127.0.0.1', '127.0.0.2', '127.0.0.3']

    const error = await pairingError(
      pair({
        identity,
        store,
        dialBudgetMs: 0,
        payload: v3PayloadFor(fakeInfo, {
          endpoints: hosts.map((host) => ({ host, port: fakeInfo.port, security: 'ws' })),
        }),
      }),
    )

    const progress = consoleInfo.mock.calls
      .flat()
      .map(String)
      .find((line) => line.includes('pairing stage validate'))
    expect(progress, 'the validate stage must be logged').toBeDefined()
    // Everything fits the budget, so every host is named and the truncation
    // marker is ABSENT — a bound that fires on three short hosts is a bug.
    for (const host of hosts) expect(progress).toContain(host)
    expect(progress).not.toContain('(+')
    expect(error.kind).toBe('unreachable')
  }, 15_000)

  it('⑭c pins the exact fill boundary: 150 + 8 + 2 = 160 fits, the next host is omitted', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const store = await makeStore()
    // THE boundary ⑭a/⑭b cannot see: ⑭a's 253-char first host aborts the fill
    // loop immediately and ⑭b's three hosts total 31 chars, so every budget in
    // roughly [31, 507] passes both. Here `used + host.length + 2` lands
    // EXACTLY on 160 with the separator charged (150 + 8 + 2), while the third
    // host would make it 163 — so the emitted host text is exactly 160 chars
    // and the third host is explicitly omitted.
    //
    // The 150-char host is THREE labels (63 + 1 + 63 + 1 + 22): a single
    // 150-char label is NOT schema-valid (the published `hostnameSchema` caps
    // a label at 63), so `'a'.repeat(150)` alone would be refused
    // `invalid-payload` before any progress line exists.
    const long = `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(22)}`
    expect(long.length).toBe(150)
    const hosts = [long, 'b'.repeat(8), 'c']

    const error = await pairingError(
      pair({
        identity,
        store,
        dialBudgetMs: 0,
        payload: v3PayloadFor(fakeInfo, {
          endpoints: hosts.map((host) => ({ host, port: fakeInfo.port, security: 'ws' })),
        }),
      }),
    )

    const progress = consoleInfo.mock.calls
      .flat()
      .map(String)
      .find((line) => line.includes('pairing stage validate'))
    expect(progress, 'the validate stage must be logged').toBeDefined()
    const prefix = '[cherry-remote] pairing stage validate (hosts: '
    // The whole line still carries OUR prefix and the stage name...
    expect(progress!.startsWith(prefix)).toBe(true)
    // ...and the rendered host list is exactly the string the budget allows.
    const rendered = progress!.slice(prefix.length, -1)
    expect(rendered).toBe(`${long}, ${'b'.repeat(8)} (+1 more)`)
    const named = rendered.slice(0, -' (+1 more)'.length)
    // The separator is CHARGED: 150 + 2 + 8 = 160, exactly the budget.
    expect(named.length).toBe(160)
    // The third host did not fit and is NOT named; the marker counts it.
    expect(named).not.toContain('c')
    expect(error.kind).toBe('unreachable')
  }, 15_000)

  it('⑭d pins the stage name in the one stage-failure text that is passed through whole', async () => {
    const identity = await createDeviceIdentity()
    // Hold every RPC reply so the FIRST pairing request (`connection.hello`)
    // is still in flight when the link dies: `asPairingError` then renders
    // `pairing hello failed: …` — the one `unreachable` text that never passes
    // through the segment shaping. No new fixture: the existing fake's reply
    // delay plus its `helloCount` counter are enough, and the transport's own
    // text after the colon is deliberately NOT asserted.
    const fakeInfo = await makeFake({ requestDelayMs: 5_000 })
    const store = await makeStore()

    const pending = pair({ identity, store, payload: v3PayloadFor(fakeInfo) })
    await waitFor(() => fakeInfo.fake.helloCount === 1)
    await fakeInfo.fake.stop()

    const error = await pairingError(pending)
    expect(error.kind).toBe('unreachable')
    expect(error.message).toMatch(/^pairing hello failed: /)
  }, 15_000)
  // -------------------------------------------------------------------------
  // The PIN is decoded at parse time (issue #153). `desktopIdentity` is an
  // opaque 1..256-char string to the published schema, so a junk pin used to
  // pass validation, dial EVERY candidate (opening real sockets) and fail
  // post-open as `channel: Please pass a multibase decoder …`. The transport
  // decodes the same string with the same helper, so the refusal belongs
  // before any socket and must name the FIELD, never the value.
  // -------------------------------------------------------------------------

  it('⑮a refuses a malformed desktopIdentity at parse time, before any socket', async () => {
    const identity = await createDeviceIdentity()
    // A LIVE peer: without the parse-time refusal this payload dials it and
    // fails post-open, so `socketCount: 0` is proof the refusal happened
    // BEFORE the walk rather than after it.
    const fakeInfo = await makeFake()
    const store = await makeStore()

    const error = await pairingError(
      pair({
        identity,
        store,
        payload: v3PayloadFor(fakeInfo, { desktopIdentity: 'not-a-peer-id' }),
      }),
    )

    expect(error.kind).toBe('invalid-payload')
    // The FIELD is named...
    expect(error.message).toContain('desktopIdentity')
    // ...and the VALUE never is (the payload error face echoes no values).
    expect(error.message).not.toContain('not-a-peer-id')
    expect(fakeInfo.fake.socketCount).toBe(0)
    expect(store.list()).toEqual([])
  }, 15_000)
})
