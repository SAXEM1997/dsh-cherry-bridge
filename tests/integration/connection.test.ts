import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ComponentLogger, Logger } from '@libp2p/interface'
import {
  connectSecureChannel,
  createDeviceIdentity,
  deviceIdentityId,
  RemoteSocketStream,
} from '@cherrystudio/remote-transport'
import { JsonRpcClient } from '../../src/rpc/jsonRpcClient'
import { toRemoteSocket } from '../../src/rpc/wsAdapter'
import type { DeviceRecord } from '../../src/deviceStore'
import { DeviceConnection } from '../../src/connection'
import type { DeviceState, EffectiveLimits } from '../../src/connection'
import { FakeCherry, maxRequestsInAnyOneSecondWindow } from '../loopback/fakeCherry'
import type { FakeCherryOptions } from '../loopback/fakeCherry'

/**
 * Task 5 integration suite: DeviceConnection (the per-device persistent
 * channel) against a real loopback Noise-XX fake desktop
 * (`tests/loopback/fakeCherry.ts`). Test numbering ①-⑬ mirrors the task
 * brief's Step 1 scenarios; each test's title carries its number.
 */

const connections: DeviceConnection[] = []
const fakes: FakeCherry[] = []

/** Silences DeviceConnection's own logging (asserted explicitly where relevant). */
let consoleError: ReturnType<typeof vi.fn>
let consoleWarn: ReturnType<typeof vi.fn>
let consoleInfo: ReturnType<typeof vi.fn>

const noop = (): void => {}

/** A callable silent libp2p logger, the same shape the unit tests use. */
function makeLogger(name: string): Logger {
  const log = (() => {}) as unknown as Logger
  log.error = noop
  log.trace = noop
  log.enabled = false
  log.newScope = (scope: string) => makeLogger(`${name}:${scope}`)
  return log
}

const componentLogger: ComponentLogger = { forComponent: (name: string) => makeLogger(name) }

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close()
  for (const fake of fakes.splice(0)) await fake.stop()
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

function recordFor(fakeInfo: FakeInfo, overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    schemaVersion: 2,
    deviceId: 'dev-test',
    displayName: 'Cherry Desktop',
    hosts: [fakeInfo.host],
    port: fakeInfo.port,
    desktopIdentity: fakeInfo.desktopIdentity,
    grants: ['agent'],
    enabled: true,
    ...overrides,
  }
}

interface ConnectionOptions {
  identity: Uint8Array
  record: DeviceRecord
  backoffInitialMs?: number
  refreshGraceMs?: number
  helloProtocolVersions?: number[]
  rateBudgetPerSecond?: number
}

function makeConnection(opts: ConnectionOptions): DeviceConnection {
  const connection = new DeviceConnection(opts)
  connections.push(connection)
  return connection
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForState(connection: DeviceConnection, want: DeviceState | DeviceState[], timeoutMs = 3_000): Promise<void> {
  const wanted = Array.isArray(want) ? want : [want]
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = (): void => {
      if (wanted.includes(connection.state)) {
        resolve()
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timeout waiting for state ${wanted.join('|')}; still ${connection.state}`))
        return
      }
      setTimeout(poll, 5)
    }
    poll()
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('condition not met before timeout')
    await sleep(5)
  }
}

/**
 * The assembly-layer tool-call wrapper, mocked here exactly as Task 10 will
 * wire it: forward to `connection.rpc` and let the connection's own offline
 * gate produce the §6 structured error. Nothing here silently reconnects.
 */
function assemblyToolCall(connection: DeviceConnection, method: string, params: unknown): Promise<unknown> {
  return connection.rpc.request(method, params)
}

describe('DeviceConnection over a real loopback channel', () => {
  it('① confirms hello with an element-wise same-order echo, obtains a token, and surfaces effective limits; an injected echo mismatch is reported as version incompatibility and goes offline', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      hello: { heartbeatMs: 25_000, limits: { subscriptions: 5, pageItems: 60, inFlightRequests: 6 } },
    })
    const record = recordFor(fakeInfo)
    const connection = makeConnection({ identity, record })

    // Happy path: hello echoes the handshake offer element-wise, authenticate
    // returns a token, and the EFFECTIVE limits are the hello-reported values.
    await connection.connect()
    expect(connection.state).toBe('connected')
    expect(fakeInfo.fake.helloCount).toBe(1)
    expect(fakeInfo.fake.helloEchoMatchesOffer).toBe(true)
    expect([...(fakeInfo.fake.lastHelloProtocolVersions ?? [])]).toEqual([1])
    expect(fakeInfo.fake.authenticateCount).toBe(1)
    expect(record.accessToken).toBe(fakeInfo.fake.tokenIssues[0]!.token)
    expect(connection.limits).toEqual({
      heartbeatMs: 25_000,
      subscriptions: 5,
      pageItems: 60,
      inFlightRequests: 6,
    } satisfies EffectiveLimits)
    await connection.close()

    // Mismatch face: the hello echo differs from the prelude offer. NOTE —
    // this simulates RECEIPT inconsistency (a client bug signal): the peer
    // validates the echo index-by-index and answers INVALID_CONNECTION_STATE.
    // The OTHER failure face — real protocol-version negotiation failure —
    // happens earlier, inside the Noise prologue (`connectSecureChannel`
    // version selection), and belongs to Task 6⑥'s territory.
    const mismatchInfo = await makeFake()
    const mismatchConnection = makeConnection({
      identity,
      record: recordFor(mismatchInfo),
      helloProtocolVersions: [1, 2], // differs from the [1] prelude offer
    })
    await expect(mismatchConnection.connect()).rejects.toThrow()
    expect(mismatchConnection.state).toBe('offline')
    const messages = consoleError.mock.calls.flat().map(String)
    expect(messages.some((m) => m.includes('protocol version'))).toBe(true)
    // Terminal: no re-attempt of a guaranteed-incompatible combination.
    const attempts = mismatchInfo.fake.socketCount
    await sleep(250)
    expect(mismatchInfo.fake.socketCount).toBe(attempts)
  }, 10_000)

  it('①b falls back to conservative defaults when the hello reply omits limit keys', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ hello: { omitLimits: true, omitHeartbeatMs: true } })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    await connection.connect()
    // Fallbacks per spec §3.4: 20s heartbeat (40s silence window), 8
    // subscriptions, 100 page items, inFlightRequests 8 (half principle).
    expect(connection.limits).toEqual({
      heartbeatMs: 20_000,
      subscriptions: 8,
      pageItems: 100,
      inFlightRequests: 8,
    } satisfies EffectiveLimits)
  })

  it('② refreshes the token automatically before expiresAt', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ tokenTtlMs: 1_200 })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    await connection.connect()
    expect(fakeInfo.fake.refreshCount).toBe(0)
    await waitFor(() => fakeInfo.fake.refreshCount >= 1)
    // Server-side truth: the refresh call arrived strictly before the first
    // token's expiry, and a replacement token was issued.
    const first = fakeInfo.fake.tokenIssues[0]!
    expect(fakeInfo.fake.refreshCalls[0]!).toBeLessThan(first.expiresAt)
    expect(fakeInfo.fake.tokenIssues.length).toBeGreaterThanOrEqual(2)
    expect(connection.state).toBe('connected')
  })

  it('③ marks the device identity-mismatch and disconnects when the peer static key does not match the pinned record', async () => {
    const identity = await createDeviceIdentity()
    const otherKey = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo, { desktopIdentity: deviceIdentityId(otherKey) }),
    })

    await expect(connection.connect()).rejects.toThrow()
    expect(connection.state).toBe('identity-mismatch')
    // Noise never completed a handshake, and the socket was torn down.
    expect(fakeInfo.fake.connectionCount).toBe(0)
    await waitFor(() => fakeInfo.fake.connectedClients === 0)
    // No reconnect storm against a wrong pin.
    const sockets = fakeInfo.fake.socketCount
    await sleep(250)
    expect(fakeInfo.fake.socketCount).toBe(sockets)
  })

  it('④ goes offline on peer-initiated close, then reconnects with backoff and re-authenticates', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const connection = makeConnection({ identity, record: recordFor(fakeInfo), backoffInitialMs: 30 })

    await connection.connect()
    expect(connection.state).toBe('connected')
    fakeInfo.fake.injectClose(1000)

    await waitForState(connection, 'offline')
    expect(connection.state).toBe('offline')

    await waitForState(connection, 'connected')
    expect(connection.state).toBe('connected')
    // Reconnect re-ran the full handshake: a second socket, a second Noise
    // channel, and a second authenticate.
    expect(fakeInfo.fake.connectionCount).toBe(2)
    expect(fakeInfo.fake.authenticateCount).toBe(2)
    expect(fakeInfo.fake.helloCount).toBe(2)
  })

  it('⑤ judges the line dead after 2×heartbeatMs of ping silence while the socket stays open', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ hello: { heartbeatMs: 80 }, dropPings: true })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo), backoffInitialMs: 30 })

    let offlineAt: number | undefined
    connection.onState((state) => {
      if (state === 'offline' && offlineAt === undefined) offlineAt = performance.now()
    })

    await connection.connect()
    expect(connection.state).toBe('connected')

    await waitForState(connection, 'offline')
    // Pings were actually sent and actually dropped — and the offline verdict
    // was NOT caused by a socket death: no peer-observed close arrived before
    // the verdict (the client's own teardown close lands afterwards).
    expect(fakeInfo.fake.pingCount).toBeGreaterThanOrEqual(2)
    expect(fakeInfo.fake.socketCloseTimes.every((t) => t >= (offlineAt ?? Number.POSITIVE_INFINITY))).toBe(true)
  })

  it('⑥ keeps peer-observed in-flight ≤ 8 for 10 concurrent business requests through DeviceConnection', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ requestDelayMs: 50 })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    await connection.connect()
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        connection.rpc.request<{ nonce: string }>('connection.ping', { nonce: `n${i}` }),
      ),
    )
    expect(results).toHaveLength(10)
    for (const result of results) expect(typeof result.nonce).toBe('string')
    // Concurrency really happened (peak > 1) but never exceeded the rpc
    // layer's 8-slot business window.
    expect(fakeInfo.fake.maxInFlight).toBeGreaterThan(1)
    expect(fakeInfo.fake.maxInFlight).toBeLessThanOrEqual(8)
  })

  it('⑥b proves the in-flight cap belongs to the rpc layer: a hand-built JsonRpcClient with maxInFlight 3 keeps the peer at ≤ 3', async () => {
    const fakeInfo = await makeFake({ requestDelayMs: 50 })
    const identity = await createDeviceIdentity()
    const controller = new AbortController()

    // A raw client on its own channel — no DeviceConnection involved. If the
    // peer still observes ≤ 3 in flight, the cap is owned by JsonRpcClient
    // and the assembly layer must not (and does not) add a second semaphore.
    // The fake's accept half starts on 'connection'; both handshake halves
    // therefore run concurrently, as the transport requires.
    const ws = new WebSocket(`ws://${fakeInfo.host}:${fakeInfo.port}`)
    const channelPromise = (async () => {
      await new Promise<void>((resolve) => ws.once('open', resolve))
      return connectSecureChannel(new RemoteSocketStream(toRemoteSocket(ws), componentLogger.forComponent('raw'), 'outbound'), {
        identity,
        logger: componentLogger,
        protocolVersions: [1],
        signal: controller.signal,
        remoteIdentity: fakeInfo.desktopIdentity,
      })
    })()
    const channel = await channelPromise
    const client = new JsonRpcClient(channel, { maxInFlight: 3 })

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => client.request<{ nonce: string }>('connection.ping', { nonce: `raw${i}` })),
    )
    expect(results).toHaveLength(10)
    expect(fakeInfo.fake.maxInFlight).toBeGreaterThan(1)
    expect(fakeInfo.fake.maxInFlight).toBeLessThanOrEqual(3)
    client.dispose()
    controller.abort()
    ws.close()
  })

  it.each([1011, 1013] as const)('⑦ routes peer close %i through the same offline→backoff→reconnect path', async (code) => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const connection = makeConnection({ identity, record: recordFor(fakeInfo), backoffInitialMs: 30 })
    const observed: DeviceState[] = []
    connection.onState((state) => observed.push(state))

    await connection.connect()
    fakeInfo.fake.injectClose(code)

    await waitForState(connection, 'offline')
    await waitForState(connection, 'connected')
    // Identical transition shape for both codes: connecting → connected →
    // offline → connecting → connected.
    expect(observed).toEqual(['connecting', 'connected', 'offline', 'connecting', 'connected'])
    expect(fakeInfo.fake.connectionCount).toBe(2)
    // 1011 (rate termination) and 1013 (connection-count over limit) are the
    // AUTHORITATIVE rate faces: the peer ends the WHOLE session, never a
    // single request — cross-referenced with Task 13's rate-termination
    // contract item.
  })

  it('⑧ smooths 100 concurrent requests so the peer never sees more than the per-second budget in any 1s window', async () => {
    const identity = await createDeviceIdentity()
    // Heartbeat pushed out so housekeeping pings stay out of the measured
    // window; the burst is what the budget must shape.
    const fakeInfo = await makeFake({ requestDelayMs: 5, hello: { heartbeatMs: 60_000 } })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    await connection.connect()
    // Let hello/authenticate fall out of every 1s window that overlaps the
    // burst, so the observation covers exactly the injected requests.
    await sleep(1_050)

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        connection.rpc.request<{ nonce: string }>('connection.ping', { nonce: `r${i}` }),
      ),
    )
    expect(results).toHaveLength(100)

    const peak = maxRequestsInAnyOneSecondWindow(fakeInfo.fake.requestTimestamps)
    expect(peak).toBeLessThanOrEqual(32)
    // All completed with no disconnect: the session survived the whole burst.
    expect(fakeInfo.fake.connectionCount).toBe(1)
    expect(connection.state).toBe('connected')
  }, 15_000)

  it('⑨ retries a failing refresh inside the grace window, then goes offline and hints the peer may have removed the device', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      tokenTtlMs: 400,
      refreshFailure: { reason: 'UNAUTHENTICATED', message: 'device no longer known' },
    })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo), refreshGraceMs: 250, backoffInitialMs: 40 })

    await connection.connect()
    expect(connection.state).toBe('connected')

    await waitForState(connection, 'offline')
    // Retried within the grace window before giving up.
    expect(fakeInfo.fake.refreshCount).toBeGreaterThanOrEqual(2)
    const messages = consoleError.mock.calls.flat().map(String)
    expect(messages.some((m) => m.includes('removed'))).toBe(true)
  })

  it('⑩ transitions to offline with a re-pair hint when authenticate answers GRANT_REVOKED', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      authenticateFailure: { reason: 'GRANT_REVOKED', message: 'grant revoked on desktop' },
    })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    await expect(connection.connect()).rejects.toThrow()
    expect(connection.state).toBe('offline')
    const messages = consoleError.mock.calls.flat().map(String)
    expect(messages.some((m) => m.includes('re-pair'))).toBe(true)
    // Terminal: retrying a revoked grant would only hammer the peer.
    await sleep(250)
    expect(fakeInfo.fake.authenticateCount).toBe(1)
  })

  it('⑪ invalidates every stored pairing after the local identity key is regenerated: all old records fail authentication and go offline', async () => {
    const regenerated = await createDeviceIdentity() // the NEW local identity
    const fakeInfo = await makeFake({
      // The desktop still holds the OLD agent identity: every authenticate
      // from the regenerated key is rejected.
      authenticateFailure: { reason: 'UNAUTHENTICATED', message: 'unknown device identity' },
    })

    // Two archived pairings against the same desktop — the whole archive
    // must fall over, not just one record.
    const first = makeConnection({
      identity: regenerated,
      record: recordFor(fakeInfo, { deviceId: 'dev-a', displayName: 'Desk A' }),
    })
    const second = makeConnection({
      identity: regenerated,
      record: recordFor(fakeInfo, { deviceId: 'dev-b', displayName: 'Desk B' }),
    })

    await expect(first.connect()).rejects.toThrow()
    await expect(second.connect()).rejects.toThrow()
    expect(first.state).toBe('offline')
    expect(second.state).toBe('offline')
    const messages = consoleError.mock.calls.flat().map(String)
    expect(messages.some((m) => m.includes('re-pair'))).toBe(true)
  })

  it('⑫ reports offline when every candidate host is unreachable, then auto-reconnects after the record is patched', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    // §6 anchor: 「候选地址全部不可达」 — an EXISTING device whose hosts all
    // refuse connections goes offline (distinct from Task 6's pairing-time
    // `unreachable` verdict on a candidate address).
    const record = recordFor(fakeInfo, { hosts: ['127.0.0.1'], port: 1 })
    const connection = makeConnection({ identity, record, backoffInitialMs: 40 })

    await expect(connection.connect()).rejects.toThrow()
    expect(connection.state).toBe('offline')

    // Simulated address maintenance (PATCH /devices/:id): the live record's
    // port is corrected in place; the next backoff attempt picks it up.
    record.port = fakeInfo.port
    await waitForState(connection, 'connected')
    expect(connection.state).toBe('connected')
    expect(fakeInfo.fake.connectionCount).toBeGreaterThanOrEqual(1)
  }, 10_000)

  it('⑬ fails an offline device tool call with a structured {device, state} error and never triggers connect()', async () => {
    const identity = await createDeviceIdentity()
    // Stable offline face: authentication was revoked, so no background
    // reconnect can race the assertion.
    const fakeInfo = await makeFake({
      authenticateFailure: { reason: 'GRANT_REVOKED', message: 'grant revoked on desktop' },
    })
    const record = recordFor(fakeInfo)
    const connection = makeConnection({ identity, record })
    const connectSpy = vi.spyOn(connection, 'connect')

    await expect(connection.connect()).rejects.toThrow()
    expect(connection.state).toBe('offline')

    const attemptsBefore = fakeInfo.fake.socketCount
    const connectCallsBefore = connectSpy.mock.calls.length
    // §6 anchor: 「设备离线」 — the tool face returns {device, state} and does
    // not auto-retry-bomb the peer.
    await expect(assemblyToolCall(connection, 'connection.ping', { nonce: 'nope' })).rejects.toMatchObject({
      device: record.deviceId,
      state: 'offline',
    })
    // No implicit connect() and no new connection attempt during the call.
    expect(connectSpy.mock.calls.length).toBe(connectCallsBefore)
    expect(fakeInfo.fake.socketCount).toBe(attemptsBefore)
  })
})
