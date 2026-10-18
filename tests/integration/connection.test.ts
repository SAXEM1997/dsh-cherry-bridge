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
import { CHANNEL_SEAM, DeviceConnection, TransportLostError } from '../../src/connection.js'
import type { DeviceState, EffectiveLimits } from '../../src/connection.js'
import { FakeCherry, maxRequestsInAnyOneSecondWindow } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions } from '../loopback/fakeCherry.js'

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
  transportRetryWaitMs?: number
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

  // -------------------------------------------------------------------------
  // PR-F: TIERED rate budget (issue #30)
  //
  // The desktop paces `agent.content.read` against its own 512/s allowance and
  // every other business RPC against 64/s, but this client paced them together
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
    // "agent.*" or on "agent.content.*" would put methods with the 64/s
    // allowance on the fast tier, which is how a client gets its session closed
    // (1011).
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
  // R3-F2: close() cancels the CANDIDATE ITERATION
  // -------------------------------------------------------------------------

  it('F2-5a close() during candidate 1\'s handshake stops the pass: no further candidate is dialed', async () => {
    const identity = await createDeviceIdentity()
    // One peer that accepts the socket and STALLS the handshake — the window
    // close() has to land in.
    const fakeInfo = await makeFake({ requestDelayMs: 5_000 })
    // The SAME address listed twice. A record's candidates share one port, so
    // this is the honest way to observe a second candidate attempt: without the
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
    // exactly the failure this case exists to catch.
    await sleep(400)
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
    // Park the wait: the kill fires as the frame arrives, well inside this beat.
    await sleep(150)
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
    await sleep(150)
    await connection.close()
    await connection.connect()
    expect(connection.state).toBe('connected')
    // Give a wrongly-surviving replay every chance to land on the new link.
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
