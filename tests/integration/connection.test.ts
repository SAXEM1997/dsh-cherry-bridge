import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createHash } from 'node:crypto'
import type { ComponentLogger, Logger } from '@libp2p/interface'
import {
  connectSecureChannel,
  createDeviceIdentity,
  deviceIdentityId,
  RemoteSocketStream,
} from '@cherrystudio/remote-transport'
import { JsonRpcClient, JsonRpcRequestError } from '../../src/rpc/jsonRpcClient.js'
import { toRemoteSocket } from '../../src/rpc/wsAdapter.js'
import type { DeviceRecord } from '../../src/deviceStore.js'
import {
  CHANNEL_SEAM,
  DeviceConnection,
  RpcDeadlineExceededError,
  TransportLostError,
} from '../../src/connection.js'
import type { DeviceState, EffectiveLimits, WsDialOptions } from '../../src/connection.js'
import { LOG_TEXT_MAX } from '../../src/text.js'
import { FakeCherry, maxRequestsInAnyOneSecondWindow } from '../loopback/fakeCherry.js'
import { makeDualPeer, insecureTlsOptions, type DualPeer } from '../helpers/tls/dualPeer.js'
import type { FakeCherryOptions } from '../loopback/fakeCherry.js'

/**
 * Task 5 integration suite: DeviceConnection (the per-device persistent
 * channel) against a real loopback Noise-XX fake desktop
 * (`tests/loopback/fakeCherry.ts`). Test numbering ①-⑬ mirrors the task
 * brief's Step 1 scenarios; each test's title carries its number.
 */

const connections: DeviceConnection[] = []
const fakes: FakeCherry[] = []
const peers: DualPeer[] = []

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
  for (const peer of peers.splice(0)) await peer.stop()
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
  const base: Omit<DeviceRecord, 'security' | 'ports'> = {
    schemaVersion: 4,
    deviceId: 'dev-test',
    displayName: 'Cherry Desktop',
    hosts: [fakeInfo.host],
    port: fakeInfo.port,
    desktopIdentity: fakeInfo.desktopIdentity,
    grants: ['agent'],
    enabled: true,
    ...overrides,
  } as Omit<DeviceRecord, 'security' | 'ports'>
  const hosts = overrides.hosts ?? base.hosts
  // One `ws` entry per host unless a test says otherwise: the scheme map must
  // cover exactly the record's host list, so it follows the overrides.
  const security =
    overrides.security ?? Object.fromEntries(hosts.map((host) => [host, 'ws' as const]))
  // Same rule for the port map (issue #135): each host dials the record-level
  // `port` unless the test names its own, so an ordinary fixture stays one
  // address.
  const ports =
    overrides.ports ?? Object.fromEntries(hosts.map((host) => [host, base.port]))
  return { ...base, security, ports }
}

interface ConnectionOptions {
  identity: Uint8Array
  record: DeviceRecord
  backoffInitialMs?: number
  refreshGraceMs?: number
  helloProtocolVersions?: number[]
  rateBudgetPerSecond?: number
  transportRetryWaitMs?: number
  wsOptions?: WsDialOptions
}

function makeConnection(opts: ConnectionOptions): DeviceConnection {
  const connection = new DeviceConnection(opts)
  connections.push(connection)
  return connection
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Waits until the fake has ACCEPTED `want` sockets. Gating on the peer's own
 * count beats a fixed sleep in both directions: a sleep short enough to land
 * mid-handshake on a cold process lands after the handshake on a warm one.
 */
async function waitForSockets(fake: FakeCherry, want: number, timeoutMs = 3_000): Promise<void> {
  const started = performance.now()
  while (fake.socketCount < want) {
    if (performance.now() - started > timeoutMs) throw new Error(`fake never accepted ${want} socket(s)`)
    await sleep(1)
  }
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
 * Runs one business burst while POLLING the fake's live in-flight counter, and
 * returns the burst's own peak.
 *
 * The fake exposes an all-time `maxInFlight`, but that counter also covers the
 * handshake (hello and authenticate genuinely overlap on the peer), so it
 * cannot answer "what did the BUSINESS window allow". Sampling the live
 * counter across the burst does, and it is exactly the quantity F4's window
 * sizing is about.
 */
async function burstConcurrency<T>(
  fake: FakeCherry,
  burst: () => Promise<T>,
): Promise<{ results: T; peak: number }> {
  // Let the handshake's last reply land and its in-flight slot clear before the
  // baseline is taken: the peer decrements after writing, which can trail the
  // client's `connect()` resolution by a tick.
  await waitFor(() => fake.inFlight === 0)
  let peak = 0
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      peak = Math.max(peak, fake.inFlight)
      await sleep(1)
    }
  })()
  try {
    const results = await burst()
    return { results, peak }
  } finally {
    sampling = false
    await sampler
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
      // Short backoff so the no-retry window below actually discriminates: a
      // regression that kept retrying this terminal face would fire inside it.
      backoffInitialMs: 30,
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

  it('①c (U1) tolerates a 2.1.5+ hello that advertises capabilities this client does not know', async () => {
    // The upstream upgrade that added resumable uploads extended the hello
    // reply: three new support flags and five `agentUpload*` limit entries. The
    // peer's own support schema is a loose object, so they arrive UNANNOUNCED,
    // and the failure mode this pins is the silent one: a client that validated
    // the reply strictly (or read the limits record positionally) would go
    // offline against a desktop that is merely newer.
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      hello: {
        heartbeatMs: 25_000,
        capabilities: {
          agentFailureVersion: 1,
          agentUploadsVersion: 1,
          agentUploadChecksum: 'sha256',
          agentAttachmentSelections: true,
          connectionEndpointsVersion: 1,
        },
        limits: {
          subscriptions: 5,
          pageItems: 60,
          inFlightRequests: 6,
          // Verbatim from the 2.1.5+ peer (RemoteConnection.ts capability block).
          agentUploadFileBytes: 33_554_432,
          agentUploadMessageBytes: 67_108_864,
          agentUploadFiles: 4,
          agentUploadChunkBytes: 1_048_576,
          agentUploadWindow: 2,
        },
      },
    })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    await connection.connect()
    expect(connection.state).toBe('connected')
    // NON-VACUOUS: the reply really carried the fields the client does not
    // know — otherwise "the client ignored them" would be proven by nothing.
    expect(fakeInfo.fake.lastHelloReply).toMatchObject({
      agentUploadsVersion: 1,
      agentUploadChecksum: 'sha256',
      agentAttachmentSelections: true,
    })
    expect(Object.keys((fakeInfo.fake.lastHelloReply?.['limits'] ?? {}) as Record<string, number>)).toEqual(
      expect.arrayContaining([
        'agentUploadFileBytes',
        'agentUploadMessageBytes',
        'agentUploadFiles',
        'agentUploadChunkBytes',
        'agentUploadWindow',
      ]),
    )
    // The KNOWN limits are read BY NAME: the unknown entries neither displace
    // them nor leak into the (closed-shape) effective projection.
    expect(connection.limits).toEqual({
      heartbeatMs: 25_000,
      subscriptions: 5,
      pageItems: 60,
      inFlightRequests: 6,
    } satisfies EffectiveLimits)

    // The link is USABLE, not merely established: an authenticated business
    // call rides the same handshake that carried the unknown capabilities.
    await expect(assemblyToolCall(connection, 'agent.sessions.list', { agentId: 'agent-1' })).resolves.toBeDefined()
    await connection.close()
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
      // Short backoff so the no-retry window below actually discriminates.
      backoffInitialMs: 30,
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

  it('⑥c (F4) sizes the business window to half the hello-reported inFlightRequests, capped at 8', async () => {
    const identity = await createDeviceIdentity()
    // The peer reports a concurrent-request allowance of 6; spec §3.4 says the
    // client takes HALF of the reported allowance (6 → 3), and 8 stays a
    // ceiling rather than a floor.
    const fakeInfo = await makeFake({
      requestDelayMs: 50,
      hello: { heartbeatMs: 60_000, limits: { subscriptions: 5, pageItems: 60, inFlightRequests: 6 } },
    })
    // A high rate budget so PACING does not mask the window: with the default
    // 32/s the ~36ms admission gap and the 50ms server delay alone keep the
    // overlap low, and the test could not tell a 3-slot window from an 8-slot
    // one. The window is what this test measures.
    const connection = makeConnection({ identity, record: recordFor(fakeInfo), rateBudgetPerSecond: 1_000 })

    await connection.connect()
    expect(connection.limits.inFlightRequests).toBe(6)

    // The handshake itself (hello + authenticate) runs concurrently on the
    // peer, so the fake's all-time peak is not the business peak. Measure the
    // burst alone: the client's window is 3, which — unlike the 8-slot default
    // — is small enough that 10 concurrent 50ms requests must saturate it.
    const burst = await burstConcurrency(fakeInfo.fake, () =>
      Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          connection.rpc.request<{ nonce: string }>('connection.ping', { nonce: `n${i}` }),
        ),
      ),
    )

    expect(burst.results).toHaveLength(10)
    // Concurrency really happened, but the peer never saw more than half its
    // reported allowance in flight at once. A window left at the 8-slot
    // default would show a peak around 8 here.
    expect(burst.peak).toBeGreaterThan(1)
    expect(burst.peak).toBeLessThanOrEqual(3)
  }, 10_000)

  it('⑥d (F4) keeps the default report path at the ≤8 ceiling and floors a tiny report at 1', async () => {
    const identity = await createDeviceIdentity()
    // A peer reporting MORE than 16 must not raise the window above the
    // client's own 8 ceiling (the peer's number is an allowance, not an
    // instruction to saturate it).
    const generous = await makeFake({
      requestDelayMs: 50,
      hello: { heartbeatMs: 60_000, limits: { inFlightRequests: 64 } },
    })
    // High budget so the rate limiter does not mask the window (see ⑥c).
    const connection = makeConnection({ identity, record: recordFor(generous), rateBudgetPerSecond: 1_000 })
    await connection.connect()
    expect(connection.limits.inFlightRequests).toBe(64)

    const burst = await burstConcurrency(generous.fake, () =>
      Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          connection.rpc.request<{ nonce: string }>('connection.ping', { nonce: `g${i}` }),
        ),
      ),
    )
    expect(burst.results).toHaveLength(12)
    expect(burst.peak).toBeGreaterThan(1)
    expect(burst.peak).toBeLessThanOrEqual(8)

    // A peer reporting 1 leaves floor(1/2) = 0, which would deadlock the client
    // forever; the window floors at 1 so requests still flow, one at a time.
    const tiny = await makeFake({
      requestDelayMs: 50,
      hello: { heartbeatMs: 60_000, limits: { inFlightRequests: 1 } },
    })
    const tinyConnection = makeConnection({ identity, record: recordFor(tiny), rateBudgetPerSecond: 1_000 })
    await tinyConnection.connect()

    const tinyBurst = await burstConcurrency(tiny.fake, () =>
      Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          tinyConnection.rpc.request<{ nonce: string }>('connection.ping', { nonce: `t${i}` }),
        ),
      ),
    )
    expect(tinyBurst.results).toHaveLength(4)
    // Serialised: the burst never overlaps, yet it does complete (no deadlock).
    expect(tinyBurst.peak).toBe(1)
  }, 15_000)

  it('(F5c) the rpc facade dispose is a local no-op that never tears down a live client', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ hello: { heartbeatMs: 60_000 } })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    await connection.connect()
    expect(connection.state).toBe('connected')

    // The facade forwards everything to the live client — EXCEPT dispose: the
    // live client is the connection's own housekeeping channel, and disposing
    // it through the facade would kill heartbeat/refresh while the supervisor
    // still reported `connected`.
    connection.rpc.dispose()

    // The connection is still fully functional: a business request round-trips.
    await expect(connection.rpc.request('connection.ping', { nonce: 'after-dispose' })).resolves.toMatchObject(
      { nonce: 'after-dispose' },
    )
    expect(connection.state).toBe('connected')

    // And an actual close() still works afterwards.
    await connection.close()
    expect(connection.state).toBe('offline')
  })

  it('(F5c) re-registering the same notification handler does not double-deliver', async () => {    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    const seen: string[] = []
    const handler = (method: string): void => {
      seen.push(method)
    }

    // Registered BEFORE connect (registry only) and again AFTER (also attaches).
    connection.rpc.onNotification(handler)
    await connection.connect()
    connection.rpc.onNotification(handler)

    fakeInfo.fake.pushNotification('agent.events', { events: [] })
    await waitFor(() => seen.length >= 1)
    await sleep(50)
    // Exactly one delivery: the re-registration is a no-op, not a second attach.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe('agent.events')
  }, 10_000)

  it('⑬c attaches a handler registered WHILE the handshake is in flight exactly once', async () => {
    // `#establish` commits `#link` BEFORE `#handshake` runs, and the facade
    // attaches a newly registered handler to a live link immediately. So a
    // handler registered during the handshake is on the client BEFORE
    // `#handshake`'s re-attach loop reaches the registry — and that loop must
    // skip it, or every later notification for this cycle is delivered twice.
    const identity = await createDeviceIdentity()
    // Slow handshake: the whole server side is stalled long enough to register
    // inside it.
    const fakeInfo = await makeFake({ requestDelayMs: 300 })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    const seen: string[] = []
    const handler = (method: string): void => {
      seen.push(method)
    }

    const pending = connection.connect()
    // Park until the link is committed but not yet connected — the raced window.
    await waitFor(() => connection.hasLink && connection.state === 'connecting', 5_000)
    connection.rpc.onNotification(handler)

    await pending
    expect(connection.state).toBe('connected')

    fakeInfo.fake.pushNotification('agent.events', { events: [] })
    await waitFor(() => seen.length >= 1)
    await sleep(50)
    // ONE delivery: the mid-handshake attach is not repeated by #handshake.
    expect(seen).toEqual(['agent.events'])
  }, 15_000)

  it('(F5b) logs the desktop identity as a 12-hex digest, never the raw pin', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    await connection.connect()

    const infoMessages = consoleInfo.mock.calls.flat().map(String)
    const connected = infoMessages.filter((m) => m.includes('connected'))
    expect(connected.length).toBeGreaterThan(0)

    // The raw pin must not appear anywhere in the connected line...
    const pin = fakeInfo.desktopIdentity
    for (const message of infoMessages) expect(message).not.toContain(pin)

    // ...and the 12-hex digest that stands in for it must.
    const digest = createHash('sha256').update(pin).digest('hex').slice(0, 12)
    expect(connected.some((m) => m.includes(digest))).toBe(true)
    expect(digest).toMatch(/^[0-9a-f]{12}$/)
  })

  it('(F5d) hints at 地址维护 address maintenance when every candidate host is unreachable', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    // Two candidate addresses, neither of which anything listens on: every host
    // fails at dial time, which is the §6 「候选地址全部不可达」 verdict.
    const record = recordFor(fakeInfo, { hosts: ['127.0.0.1', '127.0.0.2'], port: 1 })
    const connection = makeConnection({ identity, record, backoffInitialMs: 40 })

    await expect(connection.connect()).rejects.toThrow()
    expect(connection.state).toBe('offline')

    const warnMessages = consoleWarn.mock.calls.flat().map(String)
    const offlineLine = warnMessages.find((m) => m.includes('offline') && m.includes('reconnecting'))
    expect(offlineLine).toBeDefined()
    // §6 copy: the operator needs the actionable next step, not just the error.
    expect(offlineLine).toContain('地址维护')
    expect(offlineLine).toMatch(/address maintenance/)
    // The underlying socket failure is still named.
    expect(offlineLine).toMatch(/127\.0\.0\.2:1|unreachable/)
  })

  it('(F5d) does not carry the address hint when the failure is not an all-hosts verdict', async () => {
    const identity = await createDeviceIdentity()
    // A REACHABLE peer that rejects authentication: the address is fine, so the
    // address-maintenance hint would send the operator to the wrong repair. This
    // is the terminal AuthRejected path, which must not gain the hint.
    const fakeInfo = await makeFake({
      authenticateFailure: { reason: 'GRANT_REVOKED', message: 'grant revoked on desktop' },
    })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo), backoffInitialMs: 30 })

    await expect(connection.connect()).rejects.toThrow()
    expect(connection.state).toBe('offline')

    const allMessages = [...consoleWarn.mock.calls, ...consoleError.mock.calls].flat().map(String)
    for (const message of allMessages) expect(message).not.toContain('地址维护')
    // The terminal path keeps its own, DIFFERENT hint.
    expect(allMessages.some((m) => m.includes('re-pair'))).toBe(true)
  }, 10_000)

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
    // 1011 (rate termination through 2.1.6) and 1013 (connection-count over
    // limit) are SESSION-level faces: the peer ends the WHOLE session, never a
    // single request — cross-referenced with Task 13's rate-termination
    // contract item. From 2.1.7 an over-budget request is refused per request
    // instead (issue #104), so it never reaches this transition.
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

  // -------------------------------------------------------------------------
  // PR-F: TIERED rate budget (issue #30)
  //
  // The desktop paces `agent.content.read` against its own 512/s allowance and
  // every other business RPC against the shared line (64/s through 2.1.6,
  // 256/s from 2.1.7), but this client paced them together
  // at 32/s — which made a multi-slice externalized part walk at ~1/32 of the
  // rate the peer would have allowed, and turned long replies (the common case
  // on Cherry >= 2.1.6, where every part over 4,096 characters is a `{ref}`)
  // into minutes of pacing. The two tiers are now INDEPENDENT counters.
  // -------------------------------------------------------------------------

  /**
   * The CONTENT tier's share of the injected budget.
   *
   * The connection's constructor takes ONE budget (the shared tier's), and the
   * two tiers derive from it at the production ratio — `DEFAULT_CONTENT_READ_BUDGET_PER_SECOND`
   * over `DEFAULT_RATE_BUDGET_PER_SECOND` = 256/32 = 8. A test that injects a
   * small SHARED budget therefore gets a content tier `8 ×` it, which scales the
   * tier's own saturation down to something a fast suite can observe.
   */
  const CONTENT_TIER_MULTIPLE = 8

  /** A well-formed `agent.content.read` slice reply (the fake's own shape). */
  const sliceReply = (contentId: string, revision: string, eof = false): Record<string, unknown> => ({
    contentId,
    revision,
    offset: '0',
    dataBase64: Buffer.from('x').toString('base64'),
    nextOffset: '1',
    eof,
    sha256: '0'.repeat(64),
  })

  it('(F1) a burst of agent.content.read is NOT paced by the shared tier: 40 of them land at once, while the 33rd OTHER business RPC still waits for its 1.15s gap', async () => {
    const identity = await createDeviceIdentity()
    // Heartbeat pushed out so housekeeping pings stay out of both measurements.
    //
    // The SHARED budget is the DEFAULT 32: "the other tier is the production
    // 32/s" is asserted directly, not derived from an injection. 40 reads that
    // land inside 600ms are impossible on 32/s (40 gaps ≈ 1.4s), and mechanical
    // on the content tier, whose bursts are chunked by the in-flight window
    // (8 concurrent reads at ~1ms each, measured at ~250ms, waiting on a 36ms
    // timer only if the shared tier were leaking back in).
    const fakeInfo = await makeFake({ hello: { heartbeatMs: 60_000 } })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })
    await connection.connect()
    fakeInfo.fake.scriptListPages(
      'agent.content.read',
      Array.from({ length: 40 }, (_, i) => () => sliceReply('content-f1', `${String(i)}`)),
    )
    const readOnce = (i: number): Promise<{ contentId: string }> =>
      connection.rpc.request('agent.content.read', {
        sessionId: 's-1',
        contentId: 'content-f1',
        revision: `${String(i)}`,
        offset: '0',
        maxBytes: 4_096,
      })

    const started = Date.now()
    const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => readOnce(i)))
    expect(burst).toHaveLength(40)
    // The content tier admits this burst without the shared tier's pacing.
    expect(Date.now() - started).toBeLessThan(600)
    // Every arrival reached the peer: nothing was refused or dropped.
    expect(fakeInfo.fake.methodCount('agent.content.read')).toBe(40)

    // The OTHER tier is independent of that burst: its window still admits 32,
    // so the 33rd other RPC waits out a real admission gap (~1.15s), not a
    // fixed sleep — the content burst did not consume any of it.
    const otherStarted = Date.now()
    const others = await Promise.all(
      Array.from({ length: 33 }, (_, i) =>
        connection.rpc.request<{ nonce: string }>('connection.ping', { nonce: `o${String(i)}` }),
      ),
    )
    expect(others).toHaveLength(33)
    expect(Date.now() - otherStarted).toBeGreaterThanOrEqual(1_000)
    expect(connection.state).toBe('connected')
  }, 20_000)

  it('(F2) paces agent.content.read on its OWN tier: it scales with the injected shared budget, and its own exhausted tier inserts a wait', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ hello: { heartbeatMs: 60_000 } })
    // Injected SHARED budget 2/s ⇒ the content tier is 2 × 8 = 16/s with a
    // (1,150 / 16 = 71.875 → ceil) 72ms gap. The tier's OWN saturation is
    // observable here, at a fast scale.
    const shared = 2
    const content = shared * CONTENT_TIER_MULTIPLE
    const connection = makeConnection({ identity, record: recordFor(fakeInfo), rateBudgetPerSecond: shared })
    await connection.connect()
    // One admission for the first read, then one per fill read.
    fakeInfo.fake.scriptListPages(
      'agent.content.read',
      Array.from({ length: content + 1 }, () => () => sliceReply('content-f2', '1')),
    )
    const readOnce = (): Promise<{ contentId: string }> =>
      connection.rpc.request('agent.content.read', {
        sessionId: 's-1',
        contentId: 'content-f2',
        revision: '1',
        offset: '0',
        maxBytes: 4_096,
      })

    // The limiter CEILS its gap: 1,150 / 16 = 71.875ms → 72ms.
    const gapMs = Math.ceil((1_000 + 150) / content)
    expect(gapMs).toBe(72)
    // The tier derives from the injection, not from the shared tier's own
    // admission interval (1,150 / 2 = 575ms): the first content read is
    // admitted at once, and the fill below is paced at 16/s rather than 2/s.
    const firstStarted = Date.now()
    await readOnce()
    expect(Date.now() - firstStarted).toBeLessThan(gapMs)

    // The fill is paced at the CONTENT gap, not the shared one: 16 reads take
    // at least 15 content gaps (15 × 72ms = 1.08s) and would take 15 SHARED
    // gaps (15 × 575ms ≈ 8.6s).
    const fillStarted = Date.now()
    const filled = await Promise.all(Array.from({ length: content }, () => readOnce()))
    expect(filled).toHaveLength(content)
    const fillElapsed = Date.now() - fillStarted
    expect(fillElapsed).toBeGreaterThanOrEqual(gapMs)
    expect(fillElapsed).toBeGreaterThanOrEqual(500)
    expect(fillElapsed).toBeLessThan(6_000)
    expect(connection.state).toBe('connected')
  }, 30_000)

  it('(F4) the content tier is EXACT-MATCH: other agent reads and look-alike method names are paced by the shared tier', async () => {
    // The tiering rule widens a 256/s budget only for the ONE method whose
    // peer-side allowance is 512/s. A prefix/suffix match on "read", on
    // "agent.*" or on "agent.content.*" would put methods with the shared
    // allowance (64/s through 2.1.6, where overrun closes the session) on the
    // fast tier.
    //
    // The observable face of the rule without waiting on a real pace: the fake
    // ANSWERS (`NOT_FOUND` for an unknown method, `NOT_FOUND` for an unexplored
    // checkpoint) only after the admission was granted. So the WAIT is the
    // measurement — a probed method that waits out the shared tier's gap is on
    // the shared tier, and one admitted at once is on the content tier.
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ hello: { heartbeatMs: 60_000 } })
    const shared = 2
    const connection = makeConnection({ identity, record: recordFor(fakeInfo), rateBudgetPerSecond: shared })
    await connection.connect()

    // Saturate the SHARED tier exactly.
    await Promise.all(
      Array.from({ length: shared }, (_, i) =>
        connection.rpc.request<{ nonce: string }>('connection.ping', { nonce: `q${String(i)}` }),
      ),
    )

    // checkpoints.read is served by the fake and answers its own answer; it
    // must wait out the shared tier's 575ms gap.
    const checkpointStarted = Date.now()
    await connection.rpc
      .request('agent.checkpoints.read', { subscriptionId: 'sub-x', checkpointId: 'cp-x' })
      .catch(() => undefined)
    const checkpointWait = Date.now() - checkpointStarted
    expect(checkpointWait).toBeGreaterThanOrEqual(400)

    // content.read takes the CONTENT tier, which is still empty.
    const contentStarted = Date.now()
    await connection.rpc
      .request('agent.content.read', { sessionId: 's-1', contentId: 'c-x', revision: '1', offset: '0', maxBytes: 4_096 })
      .catch(() => undefined)
    expect(Date.now() - contentStarted).toBeLessThan(200)
    expect(connection.state).toBe('connected')
  }, 20_000)

  it('(F5) a LOOK-ALIKE method name (agent.content.write) is paced by the shared tier, not the content tier', async () => {
    // The exact-match rule is one character away from a family rule: a
    // `startsWith('agent.content.')` would send this name to the 256/s tier.
    // The fake has no handler for it, but it still COUNTS the arrival and
    // answers `NOT_FOUND` — after the admission, which is what is measured.
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ hello: { heartbeatMs: 60_000 } })
    const shared = 2
    const connection = makeConnection({ identity, record: recordFor(fakeInfo), rateBudgetPerSecond: shared })
    await connection.connect()

    // Saturate the SHARED tier exactly (2 admissions), so the next shared
    // admission is ~575ms away.
    await Promise.all(
      Array.from({ length: shared }, (_, i) =>
        connection.rpc.request<{ nonce: string }>('connection.ping', { nonce: `w${String(i)}` }),
      ),
    )

    const lookalikeStarted = Date.now()
    await connection.rpc.request('agent.content.write', { sessionId: 's-1', contentId: 'c-x' }).catch(() => undefined)
    // The look-alike waited on the SHARED tier...
    expect(Date.now() - lookalikeStarted).toBeGreaterThanOrEqual(400)
    // ...and it really reached the peer (the wait was an admission, not a
    // local rejection that happened to be slow).
    expect(fakeInfo.fake.methodCount('agent.content.write')).toBe(1)

    // The genuine content read still takes the (now empty) CONTENT tier at
    // once: the look-alike did not spend a content admission.
    fakeInfo.fake.scriptListPages('agent.content.read', [() => sliceReply('content-f5', '1', true)])
    const contentStarted = Date.now()
    await connection.rpc.request('agent.content.read', {
      sessionId: 's-1',
      contentId: 'content-f5',
      revision: '1',
      offset: '0',
      maxBytes: 4_096,
    })
    expect(Date.now() - contentStarted).toBeLessThan(200)
    expect(connection.state).toBe('connected')
  }, 20_000)

  it('(F3) a replayed agent.content.read takes its FRESH admission from the CONTENT tier, not the shared one', async () => {
    const identity = await createDeviceIdentity()
    // The FIRST content.read arrival kills the link; the replay lands on the
    // reconnect. The content tier stays EMPTY (one arrival before the kill),
    // while the shared tier is already exhausted — see the fills below.
    const fakeInfo = await makeLinkKillingFake('agent.content.read', { hello: { heartbeatMs: 60_000 } })
    // Injected SHARED budget 2/s ⇒ shared gap 575ms, content tier 16/s with a
    // 72ms gap. Small on purpose: the saturation below must stay cheap.
    const shared = 2
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      backoffInitialMs: 1,
      transportRetryWaitMs: 5_000,
      rateBudgetPerSecond: shared,
    })
    await connection.connect()
    fakeInfo.fake.scriptListPages('agent.content.read', [() => sliceReply('content-f3', '1', true)])

    // Saturate the SHARED tier (2 admissions) with two pings.
    await Promise.all(
      Array.from({ length: shared }, (_, i) =>
        connection.rpc.request<{ nonce: string }>('connection.ping', { nonce: `p${String(i)}` }),
      ),
    )

    const started = Date.now()
    const value = (await connection.rpc.request('agent.content.read', {
      sessionId: 's-1',
      contentId: 'content-f3',
      revision: '1',
      offset: '0',
      maxBytes: 4_096,
    })) as { eof: boolean }
    expect(value.eof).toBe(true)
    expect(fakeInfo.fake.methodCount('agent.content.read')).toBe(2)
    // Original + replay both took their admission from the CONTENT tier: one
    // content gap (72ms) at worst, against the shared tier's 575ms wait that a
    // replay admitted there would have to serve.
    expect(Date.now() - started).toBeLessThan(300)
    expect(connection.state).toBe('connected')
  }, 20_000)

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
    const connection = makeConnection({ identity, record: recordFor(fakeInfo), backoffInitialMs: 30 })

    await expect(connection.connect()).rejects.toThrow()
    expect(connection.state).toBe('offline')
    const messages = consoleError.mock.calls.flat().map(String)
    expect(messages.some((m) => m.includes('re-pair'))).toBe(true)
    // Terminal: retrying a revoked grant would only hammer the peer. With the
    // short backoff above, a retrying regression would fire inside this window.
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

    // Simulated address maintenance (PATCH /devices/:id): the record-level port
    // AND the host's own entry are corrected in place; the next backoff attempt
    // picks them up. (A real PATCH re-points every host — see httpApi tests —
    // but this connection captures the live record object.)
    record.port = fakeInfo.port
    record.ports['127.0.0.1'] = fakeInfo.port
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

  it('⑬b surfaces {device, state} when the link is lost during the rate-limiter wait', async () => {
    // THE RACE (review E2-4): `#businessRequest` checked `state === 'connected'`
    // and THEN awaited the pacing limiter. `#establish` commits `#link` BEFORE
    // `#handshake` completes, so a request parked in the limiter can be released
    // into a reconnect that has already dialed (`#link` set) but has NOT yet
    // authenticated (state `connecting`) — and ride that unauthenticated client.
    // It then surfaces a raw `JSON-RPC client disposed` instead of the §6
    // `{device, state}` face the tool layer promises.
    const identity = await createDeviceIdentity()
    // Short heartbeat so the silence window (2×heartbeatMs) closes quickly.
    const fakeInfo = await makeFake({ hello: { heartbeatMs: 120 } })
    // Budget 1/s ⇒ the pacing gap is (1000+150)/1 = 1150ms: the SECOND request
    // is reliably parked inside the limiter while the link changes underneath it.
    const record = recordFor(fakeInfo)
    const connection = makeConnection({
      identity,
      record,
      rateBudgetPerSecond: 1,
      backoffInitialMs: 1,
    })

    await connection.connect()
    expect(connection.state).toBe('connected')
    // First request consumes this window's only admission.
    await connection.rpc.request('connection.ping', { nonce: 'first' })

    // Stall the peer's server-side work, so the RECONNECT's dial commits
    // `#link` and then sits in the handshake — a wide, predictable window.
    fakeInfo.fake.setRequestDelay(3_000)

    // Park the request in the limiter, then take the live link down (the peer
    // stops answering pings, so the client's silence judgement fires).
    const inFlight = assemblyToolCall(connection, 'connection.ping', { nonce: 'second' })
    fakeInfo.fake.setDropPings(true)

    // Wait for the exact raced state: reconnected socket committed, handshake
    // not finished. The limiter releases inside this window.
    await waitFor(() => connection.state === 'connecting' && connection.hasLink, 10_000)

    // The structured fail-fast face — never a raw RPC/channel error.
    await expect(inFlight).rejects.toMatchObject({ device: record.deviceId, state: 'connecting' })
    await expect(inFlight).rejects.not.toThrow(/JSON-RPC client disposed|channel closed/i)

    fakeInfo.fake.setDropPings(false)
    fakeInfo.fake.setRequestDelay(undefined)
  }, 30_000)

  it('rejects a pending connect() when close() races the in-flight attempt — never a silent hang', async () => {
    const identity = await createDeviceIdentity()
    // Slow handshake: hello alone takes 5s server-side, so the attempt is
    // reliably still in flight when close() lands (stall-tolerant).
    const fakeInfo = await makeFake({ requestDelayMs: 5_000 })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    const pending = connection.connect()
    await sleep(50) // inside the hello round-trip / dial
    await connection.close()

    // Bounded by this test's timeout: a hang fails the test instead of
    // leaking a forever-pending promise into the pool's shutdown awaits.
    await expect(pending).rejects.toThrow(/closed/)
    expect(connection.state).toBe('offline')
  }, 10_000)

  it('regression (fix round 2): dials a bare IPv6 host — the archive stores bare hosts, the URL layer brackets them', async () => {
    const identity = await createDeviceIdentity()
    // Task 6's plan-mandated normalization stores BARE IPv6 hosts (`::1`);
    // splicing that raw into ws://<host>:<port> is an invalid URL. The dial
    // must bracket IPv6 at the URL-authorility layer and reach a fake bound
    // to ::1 (fakeCherry's Task 6 `bindHost` option).
    const fakeInfo = await makeFake({ bindHost: '::1' })
    expect(fakeInfo.host).toBe('::1')
    const record = recordFor(fakeInfo, { hosts: ['::1'] })
    const connection = makeConnection({ identity, record })

    await connection.connect()
    expect(connection.state).toBe('connected')
    expect(fakeInfo.fake.connectionCount).toBe(1)
    expect(fakeInfo.fake.authenticateCount).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Issue #126: the steady-state dial honours the PERSISTED scheme.
  //
  // #124 made pairing dial a v3 endpoint's own `security` (a TLS-proxied
  // desktop pairs over `wss`), but the reconnect rebuilt a plain `ws://` URL
  // from `hosts`+`port` alone, so such a device was pairable and never
  // RE-connectable. The record now carries a scheme per host, and the dial goes
  // through the same `directEndpointUrl` helper pairing uses.
  //
  // The scheme is judged by WHO ACCEPTS, not by "something connected": the TLS
  // front and the desktop's own plain listener are two different doors on one
  // `FakeCherry` (tests/helpers/tls/dualPeer.ts), so a plain dial and a `wss`
  // dial leave different counts. Both fixtures are needed —
  //  - the `wss` case proves the persisted scheme is USED, and
  //  - the `ws` case proves the default is not accidentally flipped.
  // A single fixture cannot carry both: with only a TLS listener, a plain dial
  // fails (so the resolver's DEFAULT would be caught too, but the "no change
  // for v2-only records" claim would not be tested at all).
  // -------------------------------------------------------------------------

  it('#126 a wss record dials wss on the steady-state path (the desktop is reached through the TLS door only)', async () => {
    const identity = await createDeviceIdentity()
    const peer = await makeDualPeer()
    peers.push(peer)
    const record = recordFor(
      {
        fake: peer.desktop,
        host: '127.0.0.1',
        port: peer.tlsPort,
        desktopIdentity: peer.desktopIdentity,
      },
      {
        hosts: ['127.0.0.1'],
        port: peer.tlsPort,
        security: { '127.0.0.1': 'wss' },
      },
    )
    // The record's persisted scheme is the ONLY source of `wss` here — a v2
    // record has none, and its default (the other test) is not in play.
    // `wsOptions` is the client-side half a private-CA deployment configures:
    // it trusts the self-signed fixture and changes nothing else, so the Noise
    // handshake below is the real one and the desktop's pinned identity is
    // still proven end to end.
    const connection = makeConnection({ identity, record, wsOptions: insecureTlsOptions })

    await connection.connect()

    expect(connection.state).toBe('connected')
    // The TLS-only port completed a handshake AND the desktop completed Noise
    // behind it: "connected" is not enough on its own — a `ws://` dial against
    // this port never gets that far, so this pair IS the scheme verdict.
    expect(peer.tlsHandshakes()).toBe(1)
    expect(peer.desktopConnections()).toBe(1)
  })

  it('#126 a record whose security map is ABSENT still dials ws', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    // The legacy shape: a record read before the v3/v4 migrations carries
    // `hosts` + `port` and nothing about a scheme or a per-host port (in memory
    // such a record is only reachable through the store's own migrations, which
    // backfill both — so the dial must default, never crash on a missing map).
    const { security: _security, ...legacy } = recordFor(fakeInfo)
    const record = legacy as DeviceRecord
    expect(record.security).toBeUndefined()
    const connection = makeConnection({ identity, record })

    await connection.connect()

    expect(connection.state).toBe('connected')
    expect(fakeInfo.fake.connectionCount).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Issue #135: the steady-state dial honours the PERSISTED per-host port.
  //
  // #126 fixed the scheme half of per-endpoint pairing; the PORT half predates
  // it. A v3 QR can carry endpoints on different ports, but the record kept
  // only the WINNER candidate's `port`, so a reconnect to a non-winner host
  // built the right scheme at the WRONG port. The record now carries a port
  // per host, and the dial reads it with the record-level `port` as fallback.
  //
  // The fixture makes the sources DISAGREE on purpose, across TWO candidates:
  // the record-level port and the FIRST host's port are dead, and only the
  // SECOND host's own entry reaches the peer. A dial reading `record.port` —
  // or `ports[record.hosts[0]]` — therefore connects to nothing.
  // -------------------------------------------------------------------------

  it('#135 a non-winner host dials its OWN port, not the record-level winner port', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const deadPort = 1
    // `localhost` (the second candidate) resolves to the fake's loopback
    // listener; `127.0.0.1` (the first) is alive only on the live port, which
    // this record deliberately does not give it.
    const record = recordFor(fakeInfo, {
      hosts: ['127.0.0.1', 'localhost'],
      port: deadPort,
      ports: { '127.0.0.1': deadPort, localhost: fakeInfo.port },
    })
    const connection = makeConnection({ identity, record })

    await connection.connect()

    expect(connection.state).toBe('connected')
    expect(fakeInfo.fake.connectionCount).toBe(1)
    expect(fakeInfo.fake.authenticateCount).toBe(1)
  })

  it('#135 a record whose ports map is ABSENT still dials the record-level port', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    // The `?.` guards an in-memory record assembled without the map (or
    // constructed before validation); the record-level `port` is its fallback,
    // exactly like the `security` `?.` above. Without it the dial throws on the
    // missing map and every candidate fails as "unreachable".
    const { ports: _ports, ...legacy } = recordFor(fakeInfo)
    const record = legacy as DeviceRecord
    expect(record.ports).toBeUndefined()
    const connection = makeConnection({ identity, record })

    await connection.connect()

    expect(connection.state).toBe('connected')
    expect(fakeInfo.fake.connectionCount).toBe(1)
  })

  // -------------------------------------------------------------------------
  // R3-F2: the structured OFFLINE face for a request in flight at link loss
  // -------------------------------------------------------------------------

  it('F2-3 a business request in flight when the link drops gets the structured offline face, not a raw disposal message', async () => {
    const identity = await createDeviceIdentity()
    // The peer accepts the request but stalls it, so the caller is genuinely
    // IN FLIGHT when the socket goes away.
    const fakeInfo = await makeFake({ hello: { heartbeatMs: 60_000 }, requestDelayMs: 5_000 })
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      backoffInitialMs: 60_000,
      // `connection.ping` is a retryable READ (issue #12), so the replay's own
      // wait has to be kept inside this test: with the backoff above, the bound
      // is the only thing that can end the call.
      transportRetryWaitMs: 200,
    })

    await connection.connect()
    expect(connection.state).toBe('connected')

    const pending = connection.rpc.request('connection.ping', { nonce: 'in-flight' })
    // Let the request reach the wire, then drop the link under it.
    await sleep(100)
    expect(fakeInfo.fake.dropConnections()).toBe(1)

    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    // The §6 face, or the transport-loss class that replaced the raw channel
    // text for a dead link (issue #12) — NOT the internal-sounding disposal
    // text, which names this client's own object lifetime rather than the state
    // of the DEVICE.
    expect(message).not.toMatch(/disposed/i)
    expect(message).toMatch(/channel closed|offline|disconnected|transport lost/i)
  }, 15_000)

  // -------------------------------------------------------------------------
  // Fake lifecycle seams (v0.1.3 UltraReview, build/code P3 ①②)
  // -------------------------------------------------------------------------

  it('(L1) a dropConnections() during the fake\'s HANDSHAKE HOLD cancels the pending handshake: no accept, no serve loop', async () => {
    // `dropConnections()` only walks `#live`, which holds CHANNEL-ESTABLISHED
    // sockets. A socket still inside `handshakeDelayMs` is in neither list, so
    // before the fix the hold elapses and `acceptSecureChannel` runs against a
    // socket that is already gone; `connectionCount` is never rolled back, and
    // the peer reports a handshake that could not have happened.
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ handshakeDelayMs: 300, hello: { heartbeatMs: 60_000 } })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    const pending = connection.connect()
    await waitForSockets(fakeInfo.fake, 1)
    // Still mid-hold: the peer has accepted the socket but not finished Noise.
    expect(fakeInfo.fake.connectionCount).toBe(0)
    fakeInfo.fake.dropConnections()

    // Let the hold elapse, then give the (would-be) accept every chance to run.
    await sleep(500)
    expect(fakeInfo.fake.connectionCount).toBe(0)
    // No hello ever reached a channel: the aborted socket never got served.
    expect(fakeInfo.fake.helloCount).toBe(0)
    // And the held socket itself is gone, not merely un-served.
    expect(fakeInfo.fake.connectedClients).toBe(0)
    // The abandoned attempt SETTLES (issue #43): the socket it was holding was
    // terminated, so `connect()` rejects with a real verdict rather than
    // parking the caller until some timeout. A `void ... .catch()` used to hide
    // that settlement; the assertion is what keeps it from regressing into a
    // silent hang.
    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(Error)
    // The CLASSIFIED verdict, not merely "some error" (review P3): the socket
    // died mid-handshake with no candidate left, which is the all-hosts face
    // the tool layer already reports. An `instanceof` alone would also pass for
    // a rejection whose text tells an operator nothing.
    expect((error as Error).message).toMatch(/all candidate hosts unreachable/i)
    expect((error as Error).message).not.toMatch(/disposed/i)
  }, 15_000)

  it('(L2) a beforeNextCall() hook that THROWS still releases its in-flight slot', async () => {
    // The hook ran between `#inFlight += 1` and the try block, so a throw
    // escaped the decrement: the slot was never released, and every later
    // request stacked behind a phantom in-flight request.
    //
    // The handler runs without being awaited from `#serve` (concurrently by
    // design), so a hook that throws makes that promise reject; `#dispatch`
    // converts a throwing hook into "counted, never answered", the same
    // peer-side face as a hook that drops the link, instead of letting the
    // rejection escape as an unhandled one. The CALLER therefore never gets an
    // answer — it is settled by `close()` below and ASSERTED, because a
    // `void ... .catch()` here hid the real shape (issue #43): without the
    // close the request waits out the 60 s `DEFAULT_TIMEOUT_MS`, so a future
    // afterEach that awaited the dangling promises would stall the suite. The
    // subject is the FAKE's bookkeeping, observed on the peer: `inFlight` must
    // be back to zero.
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({ hello: { heartbeatMs: 60_000 } })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })
    await connection.connect()

    fakeInfo.fake.beforeNextCall('connection.ping', () => {
      throw new Error('hook exploded')
    })
    const pending = connection.rpc.request('connection.ping', { nonce: 'boom' }).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    // The frame arrived and was counted: the hook ran (so did the throw), and
    // the slot it took is released on the way out of the finally.
    await waitFor(() => fakeInfo.fake.methodCount('connection.ping') >= 1)
    // Give a leaked slot every chance to show up before asserting zero.
    await sleep(50)
    expect(fakeInfo.fake.inFlight).toBe(0)
    // The deterministic settlement: close() rejects the in-flight request NOW,
    // and the verdict is classified rather than a masked rejection.
    const closing = Date.now()
    await connection.close()
    const error = await pending
    expect(Date.now() - closing).toBeLessThan(1_000)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/channel closed|offline|disconnected|transport lost/i)
    expect((error as Error).message).not.toMatch(/disposed/i)
  }, 15_000)

  // -------------------------------------------------------------------------
  // R3-F2: close() cancels the CANDIDATE ITERATION
  // -------------------------------------------------------------------------

  it('F2-5a close() during candidate 1\'s handshake stops the pass: no further candidate is dialed', async () => {
    const identity = await createDeviceIdentity()
    // One peer that accepts the socket and STALLS the handshake — the window
    // close() has to land in.
    const fakeInfo = await makeFake({ requestDelayMs: 5_000 })
    // The SAME address listed twice, on the same port (the fixture derives one
    // port entry per host from the record-level port). Duplicating the entry is
    // the honest way to observe a second candidate attempt: without the
    // cancellation guard the loop falls through to candidate 2 and dials the
    // very same peer again, which the peer counts as a second accepted socket.
    const record = recordFor(fakeInfo, { hosts: [fakeInfo.host, fakeInfo.host] })
    const connection = makeConnection({ identity, record })

    const pending = connection.connect()
    await sleep(80) // inside candidate 1's hello round-trip
    await connection.close()

    await expect(pending).rejects.toThrow(/closed/)
    expect(fakeInfo.fake.socketCount).toBe(1)
    // Any stray dial would land well inside this window: the second dial is
    // immediate (no backoff) once the first candidate's failure is classified.
    await sleep(250)
    expect(fakeInfo.fake.socketCount).toBe(1)
  }, 15_000)

  it('F2-5b close() during a candidate handshake, then a fresh connect(): the NEW cycle\'s link survives', async () => {
    const identity = await createDeviceIdentity()
    // The handshake is HELD BACK by the peer, so "mid-handshake" is a real state
    // here rather than a guess about how fast this machine is.
    const fakeInfo = await makeFake({ hello: { heartbeatMs: 60_000 }, handshakeDelayMs: 250 })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    // First cycle: start it and abandon it mid-handshake.
    const abandoned = connection.connect()
    await waitForSockets(fakeInfo.fake, 1)
    await connection.close()
    await expect(abandoned).rejects.toThrow(/closed/)

    // Second cycle: the abandoned attempt must not be able to tear this one
    // down. A stale candidate iteration still dialing post-close would complete
    // its handshake against the epoch the NEW cycle now owns and, on failure,
    // route the teardown into the live link.
    await connection.connect()
    // The abandoned iteration's handshake only BEGINS once the peer's hold
    // elapses, so the assertions have to come after that window: checking
    // earlier would pass without the stale attempt ever having run, which is
    // exactly the failure this case exists to catch. Gate on the peer observing
    // the abandoned socket CLOSE (the new cycle's socket is still open, so a
    // drop to a single live client is exactly "the stale one is finished")
    // rather than on a fixed 400ms guess at the hold.
    await waitFor(() => fakeInfo.fake.connectedClients === 1, 5_000)
    expect(connection.state).toBe('connected')
    await expect(connection.rpc.request('connection.ping', { nonce: 'alive' })).resolves.toMatchObject({
      nonce: 'alive',
    })
    expect(connection.state).toBe('connected')
  }, 15_000)

  // -------------------------------------------------------------------------
  // Issue #12: the link dies UNDER an in-flight request
  // -------------------------------------------------------------------------

  /**
   * A peer that KILLS the link in response to the first call of `method` and
   * never answers it — the field report's shape: the request reached the wire,
   * its answer never arrived, and the reconnect machinery took over.
   */
  async function makeLinkKillingFake(method: string, extra: FakeCherryOptions = {}): Promise<FakeInfo> {
    const fakeInfo = await makeFake({ hello: { heartbeatMs: 60_000 }, ...extra })
    fakeInfo.fake.beforeNextCall(method, () => {
      fakeInfo.fake.dropConnections()
    })
    return fakeInfo
  }

  it('⑭a a READ whose link dies in flight is replayed ONCE on the reconnected link and returns its data', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeLinkKillingFake('agent.agents.list', {
      agent: { agents: [{ agentId: 'agent-1', name: 'Agent One' }] },
    })
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      backoffInitialMs: 1,
      transportRetryWaitMs: 5_000,
    })
    await connection.connect()
    expect(connection.state).toBe('connected')

    // No rejection: the transient loss is absorbed, which is what the field
    // report asked for — the caller cannot act on a transport blip it is never
    // told about, and the retry minutes later already proved the data is there.
    const value = (await connection.rpc.request('agent.agents.list', {})) as { items: unknown[] }
    expect(value.items).toHaveLength(1)
    expect(connection.state).toBe('connected')
    // The peer's own count is the discriminator: one request was consumed by the
    // killed link, the second is the replay that answered.
    expect(fakeInfo.fake.methodCount('agent.agents.list')).toBe(2)
    expect(fakeInfo.fake.authenticateCount).toBe(2)
  }, 20_000)

  it('⑭e a replay that ALSO loses its link is still a classified TransportLostError', async () => {
    // The replay is the last attempt. A link that dies again must not escape as
    // the bare `JSON-RPC channel closed` text — that is the whole defect this
    // issue is about, and it would resurface on the second failure if the replay
    // were left unwrapped.
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      hello: { heartbeatMs: 60_000 },
      agent: { agents: [{ agentId: 'agent-1', name: 'Agent One' }] },
    })
    const kill = (): void => {
      fakeInfo.fake.dropConnections()
      // Re-arm: the SECOND arrival is the replay, and it must die too.
      fakeInfo.fake.beforeNextCall('agent.agents.list', kill)
    }
    fakeInfo.fake.beforeNextCall('agent.agents.list', kill)
    const record = recordFor(fakeInfo)
    const connection = makeConnection({
      identity,
      record,
      backoffInitialMs: 1,
      transportRetryWaitMs: 5_000,
    })
    await connection.connect()

    const error = await connection.rpc.request('agent.agents.list', {}).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(TransportLostError)
    expect((error as TransportLostError).retryable).toBe(true)
    // Exactly two attempts on the wire: the original and the one replay.
    expect(fakeInfo.fake.methodCount('agent.agents.list')).toBe(2)
    await waitForState(connection, 'connected', 5_000)
  })

  it('(B2) a link rotated while the replay waits for pacing is NOT replayed: the one replay stays on its own epoch', async () => {
    // The drain-guarded wait (⑮a) proves the replay never rides a life `close()`
    // ended, but a PLAIN link loss inside this connection's own lifecycle is
    // not a teardown: the wait is not drained, it parks across a second kill
    // and wakes on a later reconnected link. The `{client, epoch}` the wait
    // hands back carries that epoch so the replay is bound to the generation it
    // settled on; the line after it refuses to fire when the link has moved on.
    //
    // WHAT THIS TEST PROVES, AND WHAT IT DOES NOT. It pins the observable
    // contract: the walk's ONE replay arrives once, is never appended to a
    // later link's record, and the walk always ends classified — the original
    // arrival plus the replay arrival, no re-dial of the original. It is NOT
    // independent mutation evidence for the epoch re-check: measurements against
    // the pre-fix tree showed this second kill does not propagate a client-side
    // rejection in time, so deleting the re-check leaves the test green (the
    // replay is bounded by the class's other invariants instead). That is
    // disclosed here rather than papered over: the re-check closes a race whose
    // shipped manifestation was not reachable in this fake.
    //
    // The rotation is driven CLIENT-SIDE, with no sleep racing a handshake:
    //  - the WALK's original arrival is killed by the fake's one-shot hook and
    //    its replay parks for its fresh pacing admission;
    //  - a SIBLING read is admitted on the freshly reconnected link, so the
    //    walk's replay is next in the tier's FIFO when the link is rotated
    //    again;
    //  - a PERMANENT hook keeps killing the walk's arrivals, so its count is
    //    pinned whatever the timing.
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      hello: { heartbeatMs: 60_000 },
      agent: {
        agents: [{ agentId: 'agent-1', name: 'Agent One' }],
        workspaces: [{ workspaceId: 'ws-1', name: 'Workspace One' }],
      },
    })
    const WALK = 'agent.agents.list'
    const SIBLING = 'agent.workspaces.list'
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      backoffInitialMs: 1,
      transportRetryWaitMs: 10_000,
      rateBudgetPerSecond: 2,
    })
    await connection.connect()
    let attempts = 1
    connection.retryBackoffInitialMs = (): number => (++attempts > 2 ? 200 : 1)
    fakeInfo.fake.beforeNextCall(WALK, () => fakeInfo.fake.dropConnections())
    fakeInfo.fake.alwaysBeforeCall(WALK, () => fakeInfo.fake.dropConnections())

    const walk = connection.rpc.request(WALK, {}).catch((reason: unknown) => reason)
    await waitFor(() => fakeInfo.fake.methodCount(WALK) >= 1)
    await waitFor(() => connection.state === 'connected', 5_000)
    const sibling = connection.rpc.request(SIBLING, { agentId: 'agent-1' }).catch((reason: unknown) => reason)
    await waitFor(() => fakeInfo.fake.methodCount(SIBLING) >= 1, 5_000)

    const error = (await walk) as TransportLostError
    await sibling
    expect(error).toBeInstanceOf(TransportLostError)
    expect(error.retryable).toBe(true)
    expect(error.method).toBe(WALK)
    // Exactly ONE replay arrival: the walk left the client of the generation
    // it was parked for, and never landed on a later one.
    expect(fakeInfo.fake.methodCount(WALK)).toBe(2)
  }, 20_000)

  it('⑮c a link dying while the replay waits for its pacing admission never leaks disposal text', async () => {
    // The replay takes a fresh rate admission, and the pacing wait can outlast
    // the link it resolved on — the primary path re-judges after its own
    // acquire for exactly this reason. Without the re-judgement the replay
    // fires into a client that teardown has since disposed, and the caller gets
    // raw 'JSON-RPC client disposed' — a verdict nothing can act on.
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeLinkKillingFake('agent.agents.list', {
      hello: { heartbeatMs: 60_000 },
      agent: { agents: [{ agentId: 'agent-1', name: 'Agent One' }] },
    })
    const record = recordFor(fakeInfo)
    const connection = makeConnection({
      identity,
      record,
      backoffInitialMs: 1,
      transportRetryWaitMs: 10_000,
      // One admission per ~1.15s: the replay parks in the limiter queue, which
      // is exactly the window the second kill has to land in.
      rateBudgetPerSecond: 1,
    })
    await connection.connect()

    const pending = connection.rpc.request('agent.agents.list', {}).catch((reason: unknown) => reason)
    // Kill #1 fires as the frame arrives; the reconnect lands on the 1ms
    // backoff; the replay resolves and queues for its admission (~1.15s out).
    await sleep(400)
    // Kill #2 lands while the replay is still waiting for pacing: teardown
    // disposes the client the replay is holding.
    fakeInfo.fake.dropConnections()
    const error = (await pending) as TransportLostError
    expect(error).toBeInstanceOf(TransportLostError)
    // The classified loss, never the raw disposal text.
    expect(error.message).toMatch(/transport lost/i)
    expect(error.message).not.toMatch(/disposed/)
    expect(error.retryable).toBe(true)
  })

  it('⑮b close() during a parked replay wait settles it at once, not at the window bound', async () => {
    // close() tears down "timers, channel, client, retries" — a parked replay
    // wait is a retry. Before the drain it outlived the close and held the
    // caller for the full transportRetryWaitMs (measured 2999ms of 3000ms).
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeLinkKillingFake('agent.agents.list', {
      agent: { agents: [{ agentId: 'agent-1', name: 'Agent One' }] },
    })
    const record = recordFor(fakeInfo)
    const connection = makeConnection({
      identity,
      record,
      // No reconnect can land inside the window; only close() may end the wait.
      backoffInitialMs: 60_000,
      transportRetryWaitMs: 3_000,
    })
    await connection.connect()

    const pending = connection.rpc.request('agent.agents.list', {}).catch((reason: unknown) => reason)
    // Park the wait: the kill fires as the frame arrives. Gate on the peer
    // having SEEN that arrival rather than on a fixed 150ms beat — once the
    // arrival is counted the killing hook has run, so the client is on its way
    // into the replay wait this test is about to close.
    await waitFor(() => fakeInfo.fake.methodCount('agent.agents.list') >= 1)
    const settled = Date.now()
    await connection.close()
    const error = (await pending) as TransportLostError
    // The close itself settled it — not the 3s bound it was parked on.
    expect(Date.now() - settled).toBeLessThan(1_000)
    expect(error).toBeInstanceOf(TransportLostError)
    expect(error.retryable).toBe(true)
    expect(fakeInfo.fake.methodCount('agent.agents.list')).toBe(1)
  })

  it('⑮a a replay parked across close() then connect() never rides the NEW lifecycle', async () => {
    // The worse half of the same defect: close() followed by a fresh connect()
    // used to let the OLD lifecycle's replay fire on the new link and succeed —
    // a request the caller had every reason to consider dead came back to life
    // across a shutdown. The wait must die with the lifecycle that parked it.
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeLinkKillingFake('agent.agents.list', {
      agent: { agents: [{ agentId: 'agent-1', name: 'Agent One' }] },
    })
    const record = recordFor(fakeInfo)
    // A huge backoff so NO automatic reconnect can race the close: the new
    // lifecycle below exists only because the test starts it, which makes
    // "the replay fired on the new lifecycle" a deterministic claim.
    const connection = makeConnection({
      identity,
      record,
      backoffInitialMs: 60_000,
      transportRetryWaitMs: 10_000,
    })
    await connection.connect()

    const pending = connection.rpc.request('agent.agents.list', {}).catch((reason: unknown) => reason)
    // Gate on the peer having SEEN the arrival (the killing hook has fired by
    // then), not on a fixed beat.
    await waitFor(() => fakeInfo.fake.methodCount('agent.agents.list') >= 1)
    await connection.close()
    await connection.connect()
    expect(connection.state).toBe('connected')
    // Give a wrongly-surviving replay every chance to land on the new link: the
    // arrival count is what would move, so a bounded quiet window on the peer's
    // side is the honest form of this check.
    await sleep(300)
    const error = (await pending) as TransportLostError
    expect(error).toBeInstanceOf(TransportLostError)
    // The original arrival only: the replay never fired on the new lifecycle.
    expect(fakeInfo.fake.methodCount('agent.agents.list')).toBe(1)
  })

  it('⑭b a read whose reconnect never happens surfaces a retryable TransportLostError naming device and method', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeLinkKillingFake('agent.agents.list', {
      agent: { agents: [{ agentId: 'agent-1', name: 'Agent One' }] },
    })
    const record = recordFor(fakeInfo)
    const connection = makeConnection({
      identity,
      record,
      // A backoff longer than the wait bound, so the reconnect cannot land
      // inside it: this is the "desktop stays away" case.
      backoffInitialMs: 60_000,
      transportRetryWaitMs: 150,
    })
    await connection.connect()

    const started = Date.now()
    const error = await connection.rpc.request('agent.agents.list', {}).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(TransportLostError)
    const lost = error as TransportLostError
    expect(lost.retryable).toBe(true)
    expect(lost.device).toBe(record.deviceId)
    expect(lost.method).toBe('agent.agents.list')
    // The message must carry what the caller acts on without unwrapping fields.
    expect(lost.message).toContain(record.deviceId)
    expect(lost.message).toContain('agent.agents.list')
    expect(lost.message).toMatch(/retried/i)
    // Bounded, not a second wait on the backoff loop.
    expect(Date.now() - started).toBeLessThan(5_000)
    // The killed call was the only one put on the wire.
    expect(fakeInfo.fake.methodCount('agent.agents.list')).toBe(1)
  }, 20_000)

  it('⑭c a COMMAND whose link dies in flight is NOT replayed and surfaces TransportLostError', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      hello: { heartbeatMs: 60_000 },
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Send', historyRevision: '1000' },
        ],
      },
    })
    fakeInfo.fake.beforeNextCall('agent.messages.send', () => {
      fakeInfo.fake.dropConnections()
    })
    const record = recordFor(fakeInfo)
    const connection = makeConnection({
      identity,
      record,
      backoffInitialMs: 1,
      transportRetryWaitMs: 5_000,
    })
    await connection.connect()

    const error = await connection.rpc
      .request('agent.messages.send', { commandId: 'c-1', sessionId: 's-1', text: 'hi', expectedIdleRevision: '1000' })
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(TransportLostError)
    expect((error as TransportLostError).method).toBe('agent.messages.send')

    // The replay is what must NOT happen: the peer already admitted this command
    // once (a replay could double-apply it), and idempotency belongs to the
    // peer's commandId ledger, not to a silent client retry. Give a reconnect
    // time to land, so "once" is a statement about the client, not about timing.
    await waitForState(connection, 'connected')
    await sleep(100)
    expect(fakeInfo.fake.methodCount('agent.messages.send')).toBe(1)
  }, 20_000)

  it('⑭f (issue #28) a READ whose channel WRITE fails is classified as transport loss and replayed once on the reconnect', async () => {
    // The upstream transport rejects `channel.write` with its own text
    // ("Remote record budget exceeded" / "Remote socket unavailable or
    // congested") and aborts the connection: the frame never reached the peer,
    // so the request has no verdict — the TransportLostError definition. Before
    // #28 the connection layer only recognised its own channel-closed literal,
    // let that text through unclassified (no device/method context, no replay),
    // while every OTHER in-flight request on the same dead link got a
    // classified channel-closed from the read loop.
    //
    // A loopback fake cannot reach a CLIENT-side write failure — the peer never
    // sees the frame, so no `beforeNextCall` hook can fire. The write is
    // therefore failed at the channel seam itself: `:channel.connectSecureChannel`
    // is wrapped for this one connection, and every channel it hands out keeps
    // its real read loop while its `write` refuses ONE chosen frame. The frame is
    // chosen by METHOD, not by order: the heartbeat's own `connection.ping`
    // shares the link and its timing is not the test's to predict.
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      hello: { heartbeatMs: 60_000 },
      agent: { agents: [{ agentId: 'agent-1', name: 'Agent One' }] },
    })
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      backoffInitialMs: 1,
      transportRetryWaitMs: 5_000,
    })

    /** The JSON-RPC method of an outbound envelope (the channel carries objects). */
    const methodOf = (value: unknown): unknown =>
      typeof value === 'object' && value !== null ? (value as { method?: unknown }).method : undefined

    let failMethod: string | null = null
    let failedWrites = 0
    // `#`-named members are invisible to reflection, so the write can only be
    // intercepted where the dial HANDS the channel out: the transport's connect
    // function, reached through the connection's exported seam symbol and
    // stubbed for this one connection. Every channel it returns keeps its real
    // read loop; only `write` can refuse a frame.
    const channel = connection[CHANNEL_SEAM]
    channel.connectSecureChannel = async (...args: Parameters<typeof connectSecureChannel>) => {
      const secured = await connectSecureChannel(...args)
      const realWrite = secured.write.bind(secured)
      secured.write = (value: unknown, signal?: AbortSignal): Promise<void> => {
        if (failMethod !== null && methodOf(value) === failMethod) {
          failMethod = null
          failedWrites += 1
          // The upstream aborts the connection when the write is refused;
          // closing the peer socket makes the loss observable here.
          fakeInfo.fake.dropConnections()
          return Promise.reject(new Error('Remote record budget exceeded'))
        }
        return realWrite(value, signal)
      }
      return secured
    }

    await connection.connect()
    expect(connection.state).toBe('connected')
    expect(failedWrites).toBe(0)

    failMethod = 'agent.agents.list'
    // Absorbed, not surfaced: the READ is replayed on the reconnected link.
    // Before the fix this rejects with the bare upstream text.
    const value = (await connection.rpc.request('agent.agents.list', {})) as { items: unknown[] }
    expect(value.items).toHaveLength(1)
    expect(failedWrites).toBe(1)
    // The peer saw exactly ONE arrival — the replay. The original never got to
    // the wire: it died in the write, not in a per-request refusal.
    expect(fakeInfo.fake.methodCount('agent.agents.list')).toBe(1)
    await waitForState(connection, 'connected', 5_000)

    // A COMMAND on the same failed-write face is classified too, but never
    // replayed: the caller retries it with its own commandId.
    failMethod = 'agent.messages.send'
    const command = await connection.rpc
      .request('agent.messages.send', { commandId: 'c-1', sessionId: 's-1', text: 'hi', expectedIdleRevision: '1000' })
      .catch((reason: unknown) => reason)
    expect(command).toBeInstanceOf(TransportLostError)
    expect((command as TransportLostError).retryable).toBe(true)
    // The upstream diagnosis survives to the operator-facing error: the cause
    // chain still says WHICH weight class killed the write (record budget or
    // congestion), even though the classified message is one stable face.
    const causes: string[] = []
    for (let cause: unknown = command; cause instanceof Error; cause = cause.cause) {
      causes.push(`${cause.name}: ${cause.message}`)
    }
    expect(causes.join(' <- ')).toMatch(/Remote (record budget exceeded|socket unavailable)/)
    expect(failedWrites).toBe(2)
    await waitForState(connection, 'connected', 5_000)
    expect(fakeInfo.fake.methodCount('agent.messages.send')).toBe(0)
  }, 20_000)

  // -------------------------------------------------------------------------
  // Issue #21: a caller-supplied deadline bounds the recovery waits
  // -------------------------------------------------------------------------

  it('⑯ (issue #21) a read whose deadline is spent stops at it instead of waiting out transportRetryWaitMs', async () => {
    // The field shape: a flapping link, a read that dies in flight, and a
    // reconnect that cannot land inside the caller's remaining budget. The
    // deadline is the bound that matters — the connection's own 5 s allowance
    // is an ALLOWANCE, not a duty, once the caller has said how long it can
    // still use the answer.
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeLinkKillingFake('agent.agents.list', {
      agent: { agents: [{ agentId: 'agent-1', name: 'Agent One' }] },
    })
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      // A backoff longer than the deadline, so the reconnect cannot land inside
      // it: this is the "the desktop is not coming back in time" case.
      backoffInitialMs: 60_000,
      transportRetryWaitMs: 5_000,
    })
    await connection.connect()

    const started = Date.now()
    const error = await connection.rpc
      .request('agent.agents.list', {}, { deadline: performance.now() + 200 })
      .catch((reason: unknown) => reason)
    const elapsed = Date.now() - started

    expect(error).toBeInstanceOf(RpcDeadlineExceededError)
    expect((error as RpcDeadlineExceededError).method).toBe('agent.agents.list')
    expect((error as RpcDeadlineExceededError).device).toBe(recordFor(fakeInfo).deviceId)
    // Bounded by the DEADLINE (200 ms), not by the 5 s reconnect allowance and
    // certainly not by the 60 s default of the replay that never happened.
    expect(elapsed).toBeLessThan(1_500)
    // Nothing was replayed: the killed arrival is the only one the peer saw.
    expect(fakeInfo.fake.methodCount('agent.agents.list')).toBe(1)
  }, 20_000)

  it('⑯b (issue #21) the replay is refused once the pacing admission has spent the deadline', async () => {
    // THREE CLOCKS, deliberately far apart: the link is back in ~10 ms
    // (`backoffInitialMs`), the replay's fresh pacing admission cannot be taken
    // before ~575 ms (`rateBudgetPerSecond: 2` ⇒ ceil(1150/2) ms gap), and the
    // caller's deadline is 300 ms. The reconnect succeeds and the pacing wait
    // is what spends the budget, so the replay must NOT be fired.
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeLinkKillingFake('agent.agents.list', {
      agent: { agents: [{ agentId: 'agent-1', name: 'Agent One' }] },
    })
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      backoffInitialMs: 10,
      transportRetryWaitMs: 5_000,
      rateBudgetPerSecond: 2,
    })
    await connection.connect()

    const started = Date.now()
    const error = await connection.rpc
      .request('agent.agents.list', {}, { deadline: performance.now() + 300 })
      .catch((reason: unknown) => reason)
    const elapsed = Date.now() - started

    expect(error).toBeInstanceOf(RpcDeadlineExceededError)
    // It really waited for the admission (past the 300 ms deadline) rather than
    // failing early: this is the branch AFTER the pacing acquire.
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(2_000)
    // The replay never reached the wire.
    expect(fakeInfo.fake.methodCount('agent.agents.list')).toBe(1)
  }, 20_000)

  it('⑰ (issue #21) a request whose deadline is ALREADY spent does not buy a pacing admission', async () => {
    // Review finding 3: the admission (one `#minGapMs` per request) used to be
    // taken before the post-admission deadline guard, so a walk that kept asking
    // after its budget was gone paid one queueing gap per remaining part — up to
    // ~1 s of overshoot on a "absolute" instant. With a 2/s shared budget the
    // gap is ceil(1150/2) = 575 ms, so the two behaviours are far apart: refuse
    // before the admission (fast) vs after it (≥575 ms).
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      hello: { heartbeatMs: 60_000 },
      agent: { agents: [{ agentId: 'agent-1', name: 'Agent One' }] },
    })
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      backoffInitialMs: 60_000,
      transportRetryWaitMs: 5_000,
      rateBudgetPerSecond: 2,
    })
    await connection.connect()

    // Spend the tier's only admission so the NEXT request cannot be admitted
    // for ~575 ms.
    await connection.rpc.request('connection.ping', { nonce: 'first' })

    const started = Date.now()
    const error = await connection.rpc
      .request('agent.agents.list', {}, { deadline: performance.now() - 1 })
      .catch((reason: unknown) => reason)
    const elapsed = Date.now() - started

    expect(error).toBeInstanceOf(RpcDeadlineExceededError)
    // Refused BEFORE the admission: no 575 ms gap was paid, and no request was
    // put on the wire. (A request admitted just BEFORE expiry can still straddle
    // it by at most one gap — the limiter, not the deadline, releases a queued
    // request; that residue is documented in AGENTS.md.)
    expect(elapsed).toBeLessThan(300)
    expect(fakeInfo.fake.methodCount('agent.agents.list')).toBe(0)
  }, 20_000)

  it('⑭d a peer REFUSAL under a live link is neither reclassified nor retried', async () => {
    const identity = await createDeviceIdentity()
    // The fake has no interaction `i-1`, so the peer answers its own NOT_FOUND.
    const fakeInfo = await makeFake({
      hello: { heartbeatMs: 60_000 },
      agent: { interactions: [] },
    })
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      backoffInitialMs: 1,
      transportRetryWaitMs: 5_000,
    })
    await connection.connect()

    const error = await connection.rpc
      .request('agent.interactions.get', { sessionId: 's-1', interactionId: 'i-1' })
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect(error).not.toBeInstanceOf(TransportLostError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'NOT_FOUND' })
    // A verdict is final: asking again would get the same answer.
    expect(fakeInfo.fake.methodCount('agent.interactions.get')).toBe(1)
  }, 20_000)
})

/**
 * Issue #104: desktop 2.1.7 answers an over-budget request with ONE structured
 * `RATE_LIMITED` failure + `retryAfterMs` and keeps the session (through 2.1.6
 * it closed the whole socket with 1011, which the transport-loss tests cover).
 * The client must wait that delay out and replay a READ once, never a command.
 */
describe('issue #104: a RATE_LIMITED refusal (desktop >= 2.1.7)', () => {
  it('⑭a waits `retryAfterMs` and replays a READ once, without losing the socket', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      // Housekeeping is exempt so the handshake itself can complete; the cap
      // applies to the reads this test drives. Budget 1 + a 100 ms window: the
      // warm-up read is admitted, the measured read is over budget, and its
      // replay lands after the window cleared.
      rateLimitMethods: ['agent.agents.list'],
      rateLimitPerSecond: 1,
      rateLimitMode: 'refuse',
      rateLimitRetryAfterMs: 150,
      rateLimitWindowMs: 100,
    })
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      rateBudgetPerSecond: 1_000,
    })
    await connection.connect()

    // Fill the window (this arrival is admitted: 1 <= budget).
    await connection.rpc.request('agent.agents.list', { limit: 1 })

    const started = Date.now()
    await expect(connection.rpc.request('agent.agents.list', { limit: 1 })).resolves.toBeTruthy()
    const elapsed = Date.now() - started

    // The refusal asked for 150 ms and the client actually waited it out — and
    // did not wait the 1 s cap or a full window: the ask, not a guess.
    expect(elapsed).toBeGreaterThanOrEqual(120)
    expect(elapsed).toBeLessThan(600)
    // ...then replayed EXACTLY once: two successes plus the refused arrival.
    expect(fakeInfo.fake.methodCount('agent.agents.list')).toBe(3)
    expect(fakeInfo.fake.socketCount).toBe(1)
    expect(connection.state).toBe('connected')
  }, 10_000)

  it('⑭b a second refusal is a real failure: RATE_LIMITED surfaces, the session stays up, no third attempt', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      rateLimitMethods: ['agent.agents.list'],
      rateLimitPerSecond: 0,
      rateLimitMode: 'refuse',
      rateLimitRetryAfterMs: 1,
      // Long enough that the replay lands inside the SAME full window.
      rateLimitWindowMs: 10_000,
    })
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      rateBudgetPerSecond: 1_000,
    })
    await connection.connect()

    const error = await connection.rpc.request('agent.agents.list', { limit: 1 }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    // The refusal stays actionable: the caller keeps the delay the peer asked for.
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'RATE_LIMITED', retryAfterMs: 1 })
    // The replay is the LAST attempt.
    expect(fakeInfo.fake.methodCount('agent.agents.list')).toBe(2)
    expect(fakeInfo.fake.socketCount).toBe(1)
    expect(connection.state).toBe('connected')
  }, 10_000)

  it('⑭c a COMMAND is never replayed after RATE_LIMITED', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      rateLimitMethods: ['agent.messages.send'],
      rateLimitPerSecond: 0,
      rateLimitMode: 'refuse',
      rateLimitRetryAfterMs: 1,
      rateLimitWindowMs: 10_000,
    })
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      rateBudgetPerSecond: 1_000,
    })
    await connection.connect()

    const error = await connection.rpc
      .request('agent.messages.send', { commandId: 'c-1', sessionId: 's-1', text: 'hi', expectedIdleRevision: '1000' })
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'RATE_LIMITED' })
    // A command's refusal is a verdict on that arrival: one attempt, no replay.
    expect(fakeInfo.fake.methodCount('agent.messages.send')).toBe(1)
  }, 10_000)

  it('⑭d the wait is charged to the caller deadline and never extends it', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake({
      rateLimitMethods: ['agent.agents.list'],
      rateLimitPerSecond: 0,
      rateLimitMode: 'refuse',
      rateLimitRetryAfterMs: 5_000,
      rateLimitWindowMs: 10_000,
    })
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      rateBudgetPerSecond: 1_000,
    })
    await connection.connect()

    const started = Date.now()
    const error = await connection.rpc
      .request('agent.agents.list', { limit: 1 }, { deadline: performance.now() + 500 })
      .catch((reason: unknown) => reason)
    const elapsed = Date.now() - started
    // A deadline shorter than the requested wait means the wait is CLAMPED to
    // the remaining budget and the call fails as the caller's own budget, never
    // as the peer's refusal (and never by overrunning the deadline).
    expect(error).toBeInstanceOf(RpcDeadlineExceededError)
    expect(elapsed).toBeGreaterThanOrEqual(400)
    expect(elapsed).toBeLessThan(2_000)
    expect(fakeInfo.fake.methodCount('agent.agents.list')).toBe(1)
  }, 10_000)
})

describe('log text is bounded (issue #155)', () => {
  // ---------------------------------------------------------------------------
  // Bounded LOG text (issue #155). Two connection log lines interpolate text
  // the PEER controls: the protocol-version console.error (its cause is the
  // peer's own hello-failure text) and the transient-failure console.warn (an
  // RPC failure's message is the peer's, verbatim). Both were bounded only by
  // the 64 KiB record budget, so one record could become one log line.
  // ---------------------------------------------------------------------------

  it('(#155a) bounds the protocol-version console.error text the peer controls', async () => {
    const identity = await createDeviceIdentity()
    // 512 characters — the protocol failure schema's message CAP
    // (`remoteFailureSchema.message = z.string().max(512)`). At the cap the
    // client still parses the failure `data`, so the reason is readable and the
    // line takes the `ProtocolVersionError` arm. The detail it interpolates is
    // `protocol version confirmation rejected: ` + `JsonRpcRequestError: ` +
    // this message = 573 characters, before #155 all of it in ONE log line.
    const longMessage = 'h'.repeat(512)
    const fakeInfo = await makeFake({
      helloFailure: { reason: 'INVALID_CONNECTION_STATE', message: longMessage },
    })
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })

    await expect(connection.connect()).rejects.toThrow()
    expect(connection.state).toBe('offline')

    const line = consoleError.mock.calls
      .flat()
      .map(String)
      .find((entry) => entry.includes('protocol version incompatible'))
    expect(line, 'the protocol-version error line must be logged').toBeDefined()
    const prefix = '[cherry-remote] device dev-test: protocol version incompatible ('
    const suffix = '); upgrade Cherry Studio / the plugin'
    expect(line!.startsWith(prefix)).toBe(true)
    expect(line!.endsWith(suffix)).toBe(true)
    // CEILING, per the deviceId's length: 56 fixed characters + id + LOG_TEXT_MAX
    // (240, marker included) + the 37-char suffix. The 8-char fixture id gives
    // 341; a 36-char UUID gives 369; the schema worst case (`opaqueId` ≤ 256)
    // gives 589. `deviceId` is deliberately NOT clipped (a whitelisted
    // identifier an operator correlates on), so the bound moves with it.
    // Unbounded, this line was 64 + 573 + 37 = 674 characters with the fixture
    // id.
    expect(line!.length).toBeLessThanOrEqual(prefix.length + 240 + suffix.length)
    expect(line!).toMatch(/… \(\+\d+ chars\)/)
    // The kept prefix and the marker are charged to the SAME 240-char budget:
    // derive both from the rendered detail instead of hardcoding a marker
    // width, so a marker whose own digit count changes cannot slip through.
    const renderedDetail = line!.slice(prefix.length, line!.length - suffix.length)
    const kept = renderedDetail.indexOf('…')
    expect(kept).toBeGreaterThan(0)
    const marker = renderedDetail.slice(kept)
    expect(kept + marker.length).toBe(240)
    // The 573-char detail kept 226 and removed 347; `… (+347 chars)` is 14
    // characters, and 226 + 14 = 240.
    expect(marker).toBe(`… (+${573 - kept} chars)`)
    expect(573 - kept).toBe(347)
    // The peer's raw text is gone; OUR wording (and the remediation hint) stays.
    expect(line).not.toContain(longMessage)
    expect(line).not.toContain('h'.repeat(300))
    expect(line).toContain('upgrade Cherry Studio / the plugin')
  }, 15_000)

  it('(#155b) bounds the transient-failure console.warn text the peer controls', async () => {
    const identity = await createDeviceIdentity()
    // An authenticate refusal with a NON-terminal reason. Its failure message is
    // far above the 512-char schema cap, so the client discards `data` and the
    // reason is unreadable — the failure stays transient, every candidate host
    // "fails", and the warn's detail is `AllHostsUnreachableError`'s wrapper
    // text, which embeds the peer's message as `last: <peer text>`. Before #155
    // that produced ONE ~5.2 KB console.warn line.
    const longMessage = `authenticate rejected because ${'a'.repeat(5_000)}`
    const fakeInfo = await makeFake({
      authenticateFailure: { reason: 'INTERNAL', message: longMessage },
    })
    const connection = makeConnection({
      identity,
      record: recordFor(fakeInfo),
      backoffInitialMs: 30,
    })

    await expect(connection.connect()).rejects.toThrow()
    expect(connection.state).toBe('offline')

    const prefix = '[cherry-remote] device dev-test offline ('
    const line = consoleWarn.mock.calls
      .flat()
      .map(String)
      .find((entry) => entry.startsWith(prefix))
    expect(line, 'the transient-failure warning must be logged').toBeDefined()
    // CEILING, per the deviceId's length: 33 fixed characters + id + LOG_TEXT_MAX
    // (240, marker included) + `); reconnecting in <delay>ms` (26 at the 60,000 ms
    // backoff CAP — this test's first delay is 30 ms, so the real line is far
    // shorter) + the all-hosts hint (125). The 8-char fixture id gives 432; a
    // 36-char UUID gives 460; the schema worst case (`opaqueId` ≤ 256) gives
    // 680. Unclipped, this line was 5,259 characters.
    const hint =
      ' — all candidate addresses were unreachable; if the desktop moved, update ' +
      'them via the device card 地址维护 (address maintenance)'
    expect(line!.length).toBeLessThanOrEqual(
      prefix.length + 240 + '); reconnecting in 60000ms'.length + hint.length,
    )
    expect(line!).toMatch(/… \(\+\d+ chars\)/)
    const removed = Number(/… \(\+(\d+) chars\)/.exec(line!)![1])
    expect(removed).toBeGreaterThan(4_000)
    expect(line).not.toContain(longMessage)
    expect(line).not.toContain('a'.repeat(1_000))
    // The actionable half survives: the device, the state and the retry cadence.
    expect(line).toContain('reconnecting in ')
  }, 15_000)
})

describe('log text is bounded, error objects included (issue #161)', () => {
  it('(#161a) renders a throwing STATE LISTENER as ONE bounded string', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })
    const longMessage = 'x'.repeat(3_000)
    // `onState` is public and the listener is ours, so this is the real seam:
    // the catch around the fan-out must turn the throw into ONE string.
    connection.onState(() => {
      throw new Error(longMessage)
    })

    // `connect()` moves offline → connecting SYNCHRONOUSLY (the async
    // `#establish` runs up to its first `await` before returning), so the
    // listener has already thrown when `connect()` hands its promise back.
    const connected = connection.connect()
    const prefix = '[cherry-remote] state listener threw for dev-test: '
    const call = consoleWarn.mock.calls.find((entry) => String(entry[0]).startsWith(prefix))
    expect(call, 'the listener failure must be logged').toBeDefined()
    // ONE STRING. The old form was `console.warn(prefix, error)`: the console
    // chose the rendering — the stack plus every own property, unbounded.
    expect(call!).toHaveLength(1)
    const line = String(call![0])
    expect(line.length).toBeLessThanOrEqual(prefix.length + LOG_TEXT_MAX)
    expect(line).toMatch(/… \(\+\d+ chars\)$/)
    // The kept prefix and the marker share the 240-char budget: 3,000 → kept
    // 225, `… (+2775 chars)` 15 characters, 225 + 15 = 240.
    const detail = line.slice(prefix.length)
    const kept = detail.indexOf('…')
    expect(kept).toBeGreaterThan(0)
    expect(kept + detail.slice(kept).length).toBe(LOG_TEXT_MAX)
    expect(detail).toBe('x'.repeat(kept) + `… (+${3_000 - kept} chars)`)
    // The error's tail is gone; OUR identifying prefix survives.
    expect(line).not.toContain(longMessage)
    expect(line).toContain('dev-test')

    // Settle the attempt the test started, then close the connection: the
    // throwing listener sees those transitions too, which is harmless.
    await connected
    await connection.close()
  }, 15_000)

  it('(#161b) renders a throwing SETTLE WAITER as ONE bounded string', async () => {
    const identity = await createDeviceIdentity()
    const fakeInfo = await makeFake()
    const connection = makeConnection({ identity, record: recordFor(fakeInfo) })
    const longMessage = 'w'.repeat(3_000)

    // `waitForSettled` registers an INTERNAL closure (there is no public way to
    // hand it a callback), and its only throwing operations are `clearTimeout`,
    // `Set.delete` and `resolve` — all provided by the runtime. So the only
    // injection that both reaches the catch AND leaves the returned promise
    // settled is a resolver that resolves first and then throws: that is what
    // the stub below installs. `waitForSettled`'s inner `new Promise` takes the
    // global binding, so the window is one synchronous call.
    const connected = connection.connect()
    expect(connection.state).toBe('connecting')
    class ThrowingResolver<T> extends Promise<T> {
      constructor(
        executor: (
          resolve: (value: T | PromiseLike<T>) => void,
          reject: (reason?: unknown) => void,
        ) => void,
      ) {
        super((resolve, reject) => {
          executor((value) => {
            resolve(value)
            throw new Error(longMessage)
          }, reject)
        })
      }
    }
    let parked: Promise<DeviceState>
    vi.stubGlobal('Promise', ThrowingResolver)
    try {
      parked = connection.waitForSettled(5_000)
    } finally {
      vi.unstubAllGlobals()
    }

    // Closing moves `connecting` → `offline`, which is the settle waiter's
    // answer: the loop calls the closure, the resolver throws, and the catch
    // must log ONE bounded string. The promise was resolved before the throw.
    await connection.close()
    await parked

    const prefix = '[cherry-remote] settle waiter threw for dev-test: '
    const call = consoleWarn.mock.calls.find((entry) => String(entry[0]).startsWith(prefix))
    expect(call, 'the settle-waiter failure must be logged').toBeDefined()
    // ONE STRING: the old form was `console.warn(prefix, error)`.
    expect(call!).toHaveLength(1)
    const line = String(call![0])
    expect(line.length).toBeLessThanOrEqual(prefix.length + LOG_TEXT_MAX)
    expect(line).toMatch(/… \(\+\d+ chars\)$/)
    const detail = line.slice(prefix.length)
    const kept = detail.indexOf('…')
    expect(kept).toBeGreaterThan(0)
    expect(kept + detail.slice(kept).length).toBe(LOG_TEXT_MAX)
    expect(detail).toBe('w'.repeat(kept) + `… (+${3_000 - kept} chars)`)
    expect(line).not.toContain(longMessage)

    // The attempt the test started still settles: close() rejects the cycle.
    await connected.catch(() => undefined)
  }, 15_000)
})
