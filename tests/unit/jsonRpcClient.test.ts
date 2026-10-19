import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { ComponentLogger, Logger } from '@libp2p/interface'
import {
  acceptSecureChannel,
  connectSecureChannel,
  createDeviceIdentity,
  deviceIdentityId,
  RemoteSocketStream,
  type SecureChannel,
} from '@cherrystudio/remote-transport'
import { toRemoteSocket } from '../../src/rpc/wsAdapter.js'
import {
  isChannelClosedError,
  JsonRpcClient,
  JsonRpcRequestError,
  RequestTimeoutError,
} from '../../src/rpc/jsonRpcClient.js'

const PROTOCOL_VERSION = 1

const noop = (): void => {}

/** A callable libp2p logger: noise/inbound streams invoke it as `log('msg')`. */
function makeLogger(name: string): Logger {
  const log = (() => {}) as unknown as Logger
  log.error = noop
  log.trace = noop
  log.enabled = false
  log.newScope = (scope: string) => makeLogger(`${name}:${scope}`)
  return log
}

const logger: ComponentLogger = { forComponent: (name: string) => makeLogger(name) }

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!()
  vi.restoreAllMocks()
})

/**
 * Silences the client's drop-and-warn output. The drop paths are asserted
 * explicitly in tests ④/④b/⑤; everywhere else the warnings are noise that
 * would otherwise leak into the test output.
 */
function silenceWarnings(): void {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
}

/**
 * Loopback: an in-memory `ws` pair upgraded to a real Noise-XX SecureChannel on
 * both ends. The client half is returned as a `JsonRpcClient`; the server half
 * is the raw `SecureChannel` the test drives by hand.
 */
async function openLoopback(opts?: {
  maxInFlight?: number
  timeoutMs?: number
}): Promise<{ client: JsonRpcClient; peer: SecureChannel }> {
  silenceWarnings()
  const wss = new WebSocketServer({ port: 0 })
  disposers.push(async () => {
    for (const client of wss.clients) client.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })

  const accepted = new Promise<WebSocket>((resolve) => {
    wss.once('connection', (socket) => resolve(socket))
  })
  const { port } = wss.address() as AddressInfo

  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  disposers.push(
    () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        ws.once('close', () => resolve())
        ws.close()
      }),
  )

  const peerSocket = await accepted
  await new Promise<void>((resolve) => ws.once('open', () => resolve()))

  const serverIdentity = await createDeviceIdentity()
  const clientIdentity = await createDeviceIdentity()
  const abort = new AbortController()
  disposers.push(async () => abort.abort())

  // Both halves must be started before either is awaited: each handshake blocks
  // reading the other's prelude, so awaiting one to completion deadlocks.
  const [peerChannel, clientChannel] = await Promise.all([
    acceptSecureChannel(
      new RemoteSocketStream(toRemoteSocket(peerSocket), logger.forComponent('peer'), 'inbound'),
      {
        identity: serverIdentity,
        logger,
        protocolVersions: [PROTOCOL_VERSION],
        signal: abort.signal,
      },
    ),
    connectSecureChannel(
      new RemoteSocketStream(toRemoteSocket(ws), logger.forComponent('client'), 'outbound'),
      {
        identity: clientIdentity,
        logger,
        protocolVersions: [PROTOCOL_VERSION],
        signal: abort.signal,
        remoteIdentity: deviceIdentityId(serverIdentity),
      },
    ),
  ])

  const client = new JsonRpcClient(clientChannel, opts)
  disposers.push(async () => client.dispose())

  return { client, peer: peerChannel }
}

/**
 * An inbound peer frame as this harness consumes it. The client does not export
 * its wire type, so the harness declares the precise shape it actually reads:
 * the request envelope. `params` stays `unknown` because the assertions compare
 * it structurally (`toEqual`) rather than reaching into it.
 */
interface PeerRequestFrame {
  readonly jsonrpc: string
  readonly id: number
  readonly method: string
  readonly params?: unknown
}

const isRequest = (value: unknown): value is PeerRequestFrame =>
  typeof value === 'object' &&
  value !== null &&
  'method' in value &&
  'id' in value &&
  typeof (value as { method: unknown }).method === 'string' &&
  typeof (value as { id: unknown }).id === 'number'

/**
 * The single owner of the peer-side read loop. A channel delivers each frame to
 * exactly one reader, so every helper must go through this one loop; concurrent
 * `peer.read()` calls would steal frames from each other.
 */
class PeerHarness {
  readonly requests: PeerRequestFrame[] = []
  readonly inFlight: string[] = []
  peakInFlight = 0
  /** When false, inbound requests are recorded but never answered. */
  autoReply = true
  onRequest: ((frame: PeerRequestFrame) => void) | undefined

  constructor(private readonly peer: SecureChannel) {
    void this.loop()
  }

  private async loop(): Promise<void> {
    for (;;) {
      let frame: unknown
      try {
        frame = await this.peer.read()
      } catch {
        return
      }
      if (!isRequest(frame)) continue
      this.requests.push(frame)
      this.inFlight.push(frame.method)
      this.peakInFlight = Math.max(this.peakInFlight, this.inFlight.length)
      this.onRequest?.(frame)
      if (this.autoReply) this.reply(frame, { result: frame.params ?? null })
    }
  }

  reply(frame: PeerRequestFrame, body: { result?: unknown; error?: unknown }): void {
    const index = this.inFlight.indexOf(frame.method)
    if (index !== -1) this.inFlight.splice(index, 1)
    void this.peer.write({ jsonrpc: '2.0', id: frame.id, ...body })
  }

  /** Waits until the peer has observed `count` requests. */
  async waitForRequests(count: number, timeoutMs = 2000): Promise<void> {
    await vi.waitFor(() => {
      expect(this.requests.length).toBeGreaterThanOrEqual(count)
    }, { timeout: timeoutMs })
  }

  requestFor(method: string): PeerRequestFrame {
    const found = this.requests.find((frame) => frame.method === method)
    if (found === undefined) throw new Error(`no request observed for "${method}"`)
    return found
  }
}

describe('JsonRpcClient', () => {
  it('① correlates a request with its response by id', async () => {
    const { client, peer } = await openLoopback()
    const harness = new PeerHarness(peer)

    const first = client.request('echo.one', { n: 1 })
    await harness.waitForRequests(1)

    const inbound = harness.requestFor('echo.one')
    expect(inbound.jsonrpc).toBe('2.0')
    expect(inbound.params).toEqual({ n: 1 })
    expect(typeof inbound.id).toBe('number')

    await expect(first).resolves.toEqual({ n: 1 })

    // Two concurrent requests must not cross wires.
    const second = client.request('echo.two', { n: 2 })
    const third = client.request('echo.three', { n: 3 })
    await expect(Promise.all([second, third])).resolves.toEqual([{ n: 2 }, { n: 3 }])
  })

  it('② queues requests beyond the in-flight limit of 8', async () => {
    const { client, peer } = await openLoopback()
    const harness = new PeerHarness(peer)
    // Stall every request until the test explicitly releases it.
    harness.autoReply = false

    const requests = Array.from({ length: 10 }, (_, i) => client.request(`echo.${i}`, { i }))

    // The peer is deliberately stalled, so only the first 8 may ever be sent.
    await harness.waitForRequests(8)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(harness.requests).toHaveLength(8)
    expect(harness.peakInFlight).toBe(8)

    // Releasing one slot admits exactly one queued request.
    harness.reply(harness.requests[0], { result: { first: true } })
    await harness.waitForRequests(9)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(harness.requests).toHaveLength(9)

    await expect(requests[0]).resolves.toEqual({ first: true })

    // Drain the rest as they arrive, until all ten have been answered.
    const settled = Promise.allSettled(requests)
    for (let i = 1; i < 10; i += 1) {
      await harness.waitForRequests(i + 1)
      harness.reply(harness.requests[i], { result: { i } })
    }
    await settled
    expect(harness.requests).toHaveLength(10)

    expect(harness.peakInFlight).toBeLessThanOrEqual(8)
  })

  it('③ delivers an unknown-method notification to the handler without throwing', async () => {
    const { client, peer } = await openLoopback()

    const first = vi.fn()
    const second = vi.fn()
    client.onNotification(first)
    // Repeated registration appends rather than overwrites.
    client.onNotification(second)

    // `method` is a free string in the notification schema, so this frame is
    // schema-valid; method filtering is the consumer's job (Task 7), not ours.
    await peer.write({ jsonrpc: '2.0', method: 'future.thing', params: { hello: 'world' } })
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledTimes(1)
    })

    expect(first).toHaveBeenCalledWith('future.thing', { hello: 'world' })
    expect(second).toHaveBeenCalledWith('future.thing', { hello: 'world' })

    // `agent.events` must take the notification branch, not be mistaken for a
    // response (a response parse would reject it for lacking result/error).
    await peer.write({ jsonrpc: '2.0', method: 'agent.events', params: { events: [] } })
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledTimes(2)
    })
    expect(first).toHaveBeenLastCalledWith('agent.events', { events: [] })
  })

  it('③b (U2) carries the 2.1.5+ `agent.uploads.ack` notification through the same branch', async () => {
    // The upstream upload feature added a SERVER-INITIATED notification this
    // client never asks for: it answers a binary upload chunk, and this plugin
    // sends none. It is asserted here because "a method we do not know" and "a
    // method that does not exist yet" are different risks: this one is a REAL
    // frame a newer desktop can put on the wire, and it must reach the consumer
    // (whose method filter ignores it) rather than being dropped as malformed.
    const { client, peer } = await openLoopback()

    const handler = vi.fn()
    client.onNotification(handler)

    await peer.write({
      jsonrpc: '2.0',
      method: 'agent.uploads.ack',
      params: { ok: true, requestId: 'req-1', uploadId: 'up-1', writerEpoch: '1', committedOffset: '1024' },
    })
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1)
    })
    expect(handler).toHaveBeenCalledWith('agent.uploads.ack', {
      ok: true,
      requestId: 'req-1',
      uploadId: 'up-1',
      writerEpoch: '1',
      committedOffset: '1024',
    })

    // The FAILURE face travels the same way (the peer reports a rejected chunk
    // as a structured protocol failure inside the notification).
    await peer.write({
      jsonrpc: '2.0',
      method: 'agent.uploads.ack',
      params: { ok: false, requestId: 'req-2', error: { reason: 'RESOURCE_EXHAUSTED', message: 'Upload window exceeded' } },
    })
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2)
    })
    expect(handler).toHaveBeenLastCalledWith('agent.uploads.ack', {
      ok: false,
      requestId: 'req-2',
      error: { reason: 'RESOURCE_EXHAUSTED', message: 'Upload window exceeded' },
    })
  })

  it('④ drops a malformed response that matches no branch (drop + warn)', async () => {
    const { client, peer } = await openLoopback()

    const handler = vi.fn()
    client.onNotification(handler)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Step 3's third case: a frame with a valid `id` carrying neither `result`
    // nor `error` matches none of the three branches, so it is dropped with a
    // warning and never surfaced as a notification. The warning carries the
    // CLASSIFICATION (branch + id + schema path), never the payload (F2).
    await peer.write({ jsonrpc: '2.0', id: 999 })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/dropped invalid JSON-RPC response \(id=999\)/),
      )
    })
    expect(handler).not.toHaveBeenCalled()

    // The dropped frame leaves the request unanswered, so it settles by timeout
    // instead of resolving or hanging forever.
    await expect(client.request('echo.never', {}, { timeoutMs: 100 })).rejects.toThrow()
  })

  it('④d (issue #21) a request deadline CLAMPS the per-request timeout and its timeout is a typed error', async () => {
    // The deadline is a clamp on the SHORTER side: a 60 s per-request timeout
    // must not outlive a 100 ms budget, and a budget farther away than the
    // ordinary timeout must not lengthen one. The rejection is typed because
    // the caller that set the deadline has to tell "my budget ran out" (stop the
    // walk) apart from "the peer is silent" — and it cannot do that by reading
    // the message text.
    const { client } = await openLoopback({ timeoutMs: undefined })

    const started = Date.now()
    const error = (await client
      .request('echo.never', {}, { timeoutMs: 60_000, deadline: performance.now() + 100 })
      .catch((reason: unknown) => reason)) as Error
    const elapsed = Date.now() - started

    expect(error).toBeInstanceOf(RequestTimeoutError)
    expect((error as RequestTimeoutError).method).toBe('echo.never')
    // Derived from the budget, never the requested 60 s: the exact value is
    // `ceil(remaining)`, so it can only be at or just below the 100 ms budget.
    expect((error as RequestTimeoutError).timeoutMs).toBeGreaterThan(0)
    expect((error as RequestTimeoutError).timeoutMs).toBeLessThanOrEqual(100)
    // The flag the deadline-bounded walk switches on: the timeout was SHORTENED
    // by the budget, so a caller may read the timeout as "my budget ran out".
    expect((error as RequestTimeoutError).clampedByDeadline).toBe(true)
    // The message is unchanged: operators and existing reports quote it.
    expect(error.message).toContain('timed out after')
    expect(elapsed).toBeLessThan(2_000)
  }, 20_000)

  it('④e (issue #21) a QUEUED request derives its deadline-clamped timeout at ADMISSION, not at enqueue', async () => {
    // Review finding 4: the timeout used to be computed in `request()` and only
    // START when a queued send was admitted, so a request that waited D ms in
    // the in-flight queue outlived its deadline by D. The clamp is now derived
    // inside `send()`, the single admission point.
    //
    // Two clocks, far apart on purpose: A holds the only slot for 200 ms, and
    // B's deadline is 400 ms from enqueue. Re-clamped, B's timer is 200 ms and
    // it rejects at ~400 ms; computed at enqueue it would be 400 ms and reject
    // at ~600 ms.
    // No harness: the peer half is never read, so neither request is answered
    // and both settle by their own timeouts — which is the clock under test.
    const { client } = await openLoopback({ maxInFlight: 1 })

    const held = client.request('echo.pending', {}, { timeoutMs: 200 }).catch((reason: unknown) => reason)
    const started = Date.now()
    const queued = client
      .request('echo.pending', {}, { deadline: performance.now() + 400 })
      .catch((reason: unknown) => reason)

    const error = (await queued) as Error
    const elapsed = Date.now() - started
    await held

    expect(error).toBeInstanceOf(RequestTimeoutError)
    // The timeout itself was derived from what was LEFT of the budget when the
    // request was admitted, and it is reported as deadline-clipped.
    expect((error as RequestTimeoutError).clampedByDeadline).toBe(true)
    expect((error as RequestTimeoutError).timeoutMs).toBeLessThanOrEqual(400)
    // 400 ms (admission-time clamp) vs 600 ms (enqueue-time clamp): the bound
    // sits between them with >100 ms of slack on both sides.
    expect(elapsed).toBeLessThan(520)
  }, 20_000)

  it('④c (v0.1.3 P3-B4) an un-parameterised client waits 60s — the protocol idleMs — for an answer', async () => {
    // The default is a PROTOCOL decision, not a taste one: a client timeout
    // below `remoteLimits.idleMs` (60,000ms) calls a request dead while the
    // peer still considers the session live. Fake timers make the 60s assertion
    // exact instead of a CI-timing guess, and they are installed BEFORE the
    // request is admitted, so the only timer in play is the request's own
    // timeout (the loopback write and the peer's enqueue are promise work, not
    // timers).
    vi.useFakeTimers()
    try {
      const { client, peer } = await openLoopback({ timeoutMs: undefined })
      const harness = new PeerHarness(peer)
      harness.autoReply = false

      const request = client.request('echo.pending', {})
      await harness.waitForRequests(1)
      let outcome: unknown = 'pending'
      void request.then(
        (value) => (outcome = value),
        (reason: unknown) => (outcome = reason),
      )
      // One millisecond short of the protocol's idle term: still pending.
      await vi.advanceTimersByTimeAsync(10)
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(48_989)
      await vi.advanceTimersByTimeAsync(1)
      // The idle term itself: settled by the timeout, naming the exact window.
      await vi.runAllTimersAsync()
      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toContain('timed out after 60000ms')
    } finally {
      vi.useRealTimers()
    }
  }, 20_000)

  it('④b drops an id-less response frame for an outstanding request', async () => {
    const { client, peer } = await openLoopback()
    const harness = new PeerHarness(peer)
    harness.autoReply = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The brief's case: a malformed response *missing its id*, while a request
    // is genuinely outstanding.
    const request = client.request('echo.malformed', {}, { timeoutMs: 30_000 })
    await harness.waitForRequests(1)

    const notification = vi.fn()
    client.onNotification(notification)

    // A response-shaped frame with no `id` is valid as neither a notification
    // nor a response (both schemas reject it), so it is dropped with a warning
    // and the outstanding request stays pending rather than resolving. The
    // warning names the branch and the failing schema path, not the payload.
    await peer.write({ jsonrpc: '2.0', result: { ok: true } })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[cherry-remote] dropped invalid JSON-RPC notification'),
      )
    })
    // It was NOT mistaken for a notification either.
    expect(notification).not.toHaveBeenCalled()

    // Still unanswered: closing the channel is what settles it (see test ⑧).
    const settled = await Promise.race([
      request.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 150)),
    ])
    expect(settled).toBe('pending')
  })

  it('⑤ rejects non-2.0 frames in both directions', async () => {
    const { client, peer } = await openLoopback()
    const harness = new PeerHarness(peer)

    const handler = vi.fn()
    client.onNotification(handler)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Inbound: a notification-shaped frame missing `jsonrpc: '2.0'` is invalid
    // and must be dropped (with a warning) without reaching handlers. The
    // method name is classification and IS logged; the params are not.
    await peer.write({ method: 'future.thing', params: {} })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[cherry-remote] dropped invalid JSON-RPC notification'),
      )
    })
    const dropMessages = warn.mock.calls.map((call) => call.map(String).join(' '))
    expect(dropMessages.some((m) => m.includes('method="future.thing"'))).toBe(true)
    expect(handler).not.toHaveBeenCalled()

    // Outbound: an invalid envelope is refused before it reaches the wire and
    // consumes no in-flight slot. A non-string `method` fails the request
    // schema, so `request` must reject rather than write the frame.
    await expect(client.request(42 as unknown as string, {})).rejects.toThrow(/invalid/i)

    // A valid request still goes out, proving the refusal left the client usable.
    await expect(client.request('echo.ok', { ok: true })).resolves.toEqual({ ok: true })

    const written = harness.requests.map((frame) => frame.method)
    expect(written).toEqual(['echo.ok'])
  })

  it('⑥ passes a known enum reason through verbatim but degrades an unknown one', async () => {
    const { client, peer } = await openLoopback()
    const harness = new PeerHarness(peer)
    harness.autoReply = false
    harness.onRequest = (frame) => {
      const reason = frame.method === 'known' ? 'REVISION_EXPIRED' : 'FUTURE_REASON'
      harness.reply(frame, {
        error: { code: 1000, message: 'boom', data: { reason, message: 'boom' } },
      })
    }

    // Known closed-enum reason: `code` is the literal 1000 and `reason` is the
    // discriminator, so it must arrive at the caller verbatim (Task 8/9 anchor
    // REVISION_EXPIRED / CONFLICT / TARGET_UNAVAILABLE on this pass-through).
    const error = await client.request('known', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    const known = error as JsonRpcRequestError
    expect(known.code).toBe(1000)
    expect(known.message).toBe('boom')
    expect((known.data as { reason?: string }).reason).toBe('REVISION_EXPIRED')

    // Unknown reason: `reason` is a closed 16-value enum, so a future value is
    // rejected by the typed-error layer. The client must not crash; the request
    // rejects with a structured generic error preserving code/message. This is
    // the rejection-degradation path, NOT pass-through of unknown reasons.
    const degraded = await client.request('unknown', {}).catch((e: unknown) => e)
    expect(degraded).toBeInstanceOf(JsonRpcRequestError)
    const generic = degraded as JsonRpcRequestError
    expect(generic.code).toBe(1000)
    expect(generic.message).toBe('boom')
    expect(generic.data).toBeUndefined()

    // The client survives both paths and still serves further requests.
    await expect(client.request('known', {})).rejects.toBeInstanceOf(JsonRpcRequestError)
    expect(harness.requests).toHaveLength(3)
  })

  it('⑦ rejects both in-flight and queued requests on dispose', async () => {
    const { client, peer } = await openLoopback({ maxInFlight: 2 })
    const harness = new PeerHarness(peer)
    // Stall every request so nothing settles on its own before dispose().
    harness.autoReply = false

    // Two fill the in-flight window; the rest can only be queued.
    const inFlight = [client.request('echo.a', {}), client.request('echo.b', {})]
    await harness.waitForRequests(2)

    const queued = [
      client.request('echo.c', {}),
      client.request('echo.d', {}),
      client.request('echo.e', {}),
    ]

    // Give the queue a chance to exist; none of these may reach the wire.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.requests).toHaveLength(2)

    client.dispose()

    // Both cohorts reject — no request may hang forever until its 30s timeout.
    const settled = await Promise.allSettled([...inFlight, ...queued])
    expect(settled.map((entry) => entry.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ])
    for (const entry of settled) {
      expect((entry as PromiseRejectedResult).reason).toBeInstanceOf(Error)
    }

    // The queued requests were never written to the channel.
    expect(harness.requests).toHaveLength(2)
  })

  it('⑨ (F2) never logs frame payloads on the drop paths, only classification', async () => {
    const { client, peer } = await openLoopback()
    const harness = new PeerHarness(peer)

    const handler = vi.fn()
    client.onNotification(handler)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // A sentinel that must never reach the log: peer frame payloads carry user
    // content (chat text, tool arguments, file paths), and the drop paths fire
    // precisely on frames we did NOT validate — so logging the value logs
    // arbitrary attacker-shaped input at warn level.
    const SENTINEL = 'SENTINEL-USER-CONTENT-2f4c1b'
    const ID_SENTINEL = 'SENTINEL-ID-8a91de'

    // (a) method-bearing drop: an id+method frame that fails the request schema.
    // `method` is recorded (classification), `params` is not.
    await peer.write({ jsonrpc: '2.0', id: ID_SENTINEL, method: 'echo.methody', params: SENTINEL })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('dropped invalid JSON-RPC request'),
      )
    })

    // (b) id-less drop that is neither a valid notification nor a response.
    await peer.write({ jsonrpc: '2.0', result: SENTINEL })
    // (c) non-object frame — the transport rejects primitives at the channel
    // boundary, so this uses a JSON-encodable non-object instead.
    await peer.write([SENTINEL])
    // (d) notification that fails its schema (carrying the sentinel as text).
    await peer.write({ jsonrpc: '2.0', method: 'echo.badparams', params: 42, extra: SENTINEL })

    await vi.waitFor(() => {
      expect(warn.mock.calls.length).toBeGreaterThanOrEqual(4)
    })

    // The sentinel appears in NO argument of ANY warn call.
    const allArgs = warn.mock.calls.flat()
    const flattened = allArgs.map((arg) => JSON.stringify(arg) ?? String(arg))
    for (const entry of flattened) {
      expect(entry).not.toContain(SENTINEL)
    }

    // Classification survived: the method name IS present for the method-bearing
    // drop, because it is the one part of the frame the operator needs to route
    // the report — and it is a bounded identifier, not payload.
    const messages = warn.mock.calls.map((call) => call.map(String).join(' '))
    expect(messages.some((m) => m.includes('echo.methody'))).toBe(true)

    // The drop still happened: no notification reached a handler.
    expect(handler).not.toHaveBeenCalled()
    // ...and the client is unharmed.
    await expect(client.request('echo.ok', { ok: true })).resolves.toEqual({ ok: true })
  })

  it('⑨b (F2-6b) bounds the LENGTH of the classification fields a hostile peer can log', async () => {
    const { client, peer } = await openLoopback()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Excluding payload fields is not enough when the CLASSIFICATION fields are
    // themselves peer-supplied and unbounded. A 10k-character method name makes
    // the frame fail validation, and the drop warning then quotes the method —
    // so without a bound the peer chooses how many bytes land in the log.
    const HUGE_METHOD = `m${'x'.repeat(10_000)}`
    await peer.write({ jsonrpc: '2.0', id: 424242, method: HUGE_METHOD, params: {} })

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped invalid JSON-RPC request'))
    })

    const line = warn.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
    // The log line stays small — nowhere near the 10k the peer sent.
    expect(line.length).toBeLessThan(2_000)
    // The method is still CLASSIFIED (its head is intact, so an operator can
    // tell what the peer attempted)...
    expect(line).toContain('mxxxx')
    // ...and it is explicitly marked as clipped, so a truncated value is never
    // mistaken for the peer's real method name.
    expect(line).toContain('…')
    expect(line).not.toContain(HUGE_METHOD)
  })

  it('⑩ (F4) updateMaxInFlight resizes admissions without touching pending requests', async () => {
    const { client, peer } = await openLoopback({ maxInFlight: 4 })
    const harness = new PeerHarness(peer)
    harness.autoReply = false

    // Four in flight: the window is exactly full.
    const inFlight = Array.from({ length: 4 }, (_, i) => client.request(`echo.${i}`, { i }))
    await harness.waitForRequests(4)

    // Shrinking takes effect for NEW admissions only: the four already-sent
    // requests are untouched (no cancellation, no re-queue, no rejection), and
    // nothing further leaves until the window has room.
    client.updateMaxInFlight(2)
    const queued = Array.from({ length: 3 }, (_, i) => client.request(`echo.q${i}`, { i }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(harness.requests).toHaveLength(4)

    // Releasing one slot still cannot admit: 3 remain in flight, still above
    // the new cap of 2. A cap-unaware release would refill the window to 4.
    harness.reply(harness.requests[0], { result: { released: true } })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(harness.requests).toHaveLength(4)

    // A second release brings in-flight to 2 == cap: still no room, because
    // admitting here would put 3 on the wire.
    harness.reply(harness.requests[1], { result: { released: true } })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(harness.requests).toHaveLength(4)

    // The third release drops in-flight to 1 < 2, so exactly ONE queued request
    // enters and the window is full again.
    harness.reply(harness.requests[2], { result: { released: true } })
    await harness.waitForRequests(5)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(harness.requests).toHaveLength(5)

    await expect(inFlight[0]).resolves.toEqual({ released: true })

    // Growing the window admits the rest of the queue immediately.
    client.updateMaxInFlight(8)
    await harness.waitForRequests(7)
    // Answer everything still outstanding so the three queued requests settle.
    for (const frame of harness.requests.slice(3)) harness.reply(frame, { result: { i: frame.id } })
    await expect(Promise.all(queued)).resolves.toHaveLength(3)
  })

  it('⑪ (F4) updateMaxInFlight clamps a nonsensical cap to the admission floor of 1', async () => {
    const { client, peer } = await openLoopback({ maxInFlight: 4 })
    const harness = new PeerHarness(peer)
    harness.autoReply = false

    // Zero/negative/NaN must never wedge the client permanently (a cap of 0
    // would queue every request forever); the floor is one admissible request.
    client.updateMaxInFlight(0)

    const request = client.request('echo.floor', {})
    await harness.waitForRequests(1)
    harness.reply(harness.requests[0], { result: { ok: true } })
    await expect(request).resolves.toEqual({ ok: true })

    // A non-finite cap must be IGNORED, not stored: NaN would make every
    // `inFlight < maxInFlight` comparison false and wedge the queue forever.
    client.updateMaxInFlight(Number.NaN)
    const afterNaN = client.request('echo.after-nan', {})
    await harness.waitForRequests(2)
    harness.reply(harness.requests[1], { result: { ok: true } })
    await expect(afterNaN).resolves.toEqual({ ok: true })
  })

  it('⑧ rejects in-flight requests when the channel closes, then fails fast', async () => {
    const { client, peer } = await openLoopback()
    const harness = new PeerHarness(peer)
    harness.autoReply = false

    // A long timeout proves the rejection comes from the channel close and not
    // from a timeout expiring.
    const request = client.request('echo.pending', {}, { timeoutMs: 30_000 })
    await harness.waitForRequests(1)

    await peer.close()
    await expect(request).rejects.toThrow(/^JSON-RPC channel closed$/)

    // Once the channel is known dead, further calls fail fast with the same
    // structured reason instead of queueing onto a channel that can never
    // answer (which would surface as a confusing transport write error).
    await expect(client.request('echo.after', {})).rejects.toThrow(/^JSON-RPC channel closed$/)
  })

  /**
   * The two write failures the upstream transport actually raises (issue #28).
   * Both mean the frame never reached the peer AND the connection was aborted,
   * so the request has no peer verdict — the TransportLostError definition.
   * `label` says which upstream path raised it.
   */
  const WRITE_LOSS_MESSAGES = [
    { label: 'remote-transport record budget', message: 'Remote record budget exceeded' },
    { label: 'remote-transport socket congestion', message: 'Remote socket unavailable or congested' },
  ] as const

  for (const { label, message } of WRITE_LOSS_MESSAGES) {
    it(`⑨a (issue #28) classifies a write failure as transport loss, preserving "${label}" as the cause`, async () => {
      // A raw channel whose write always fails the way the upstream transport
      // does. `read` never settles: nothing can answer a request that was never
      // written, so the rejection under test can only come from the write.
      const doomed: SecureChannel = {
        remoteIdentity: 'peer',
        write: () => Promise.reject(new Error(message)),
        read: () => new Promise<unknown>(() => {}),
        close: () => Promise.resolve(),
      } as unknown as SecureChannel
      const client = new JsonRpcClient(doomed)

      const error = await client.request('agent.agents.list', {}).catch((reason: unknown) => reason)

      // The CORRECTED face: the same classified signal every in-flight request
      // on the dead link gets from the read loop, so the connection layer can
      // recognise it as a transport loss (and replay a read) instead of passing
      // the upstream text through unclassified.
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('JSON-RPC channel closed')
      // The upstream diagnosis is not lost: it rides along as the cause, so an
      // operator can still tell a record-budget kill from socket congestion.
      expect(((error as Error).cause as Error | undefined)?.message).toBe(message)
      // The raw upstream text is NOT the top-level message any more: consumers
      // key on the classified face.
      expect((error as Error).message).not.toBe(message)
      expect(isChannelClosedError(error)).toBe(true)
    })
  }

  it('⑨b (issue #28) a write failure with no Error value still carries a diagnosed cause and the classified face', async () => {
    // The transport contracts to reject with an Error, but a rejection value is
    // never trustworthy: a string or undefined must not turn the classified
    // message into "undefined", nor drop the fact that a write failed.
    const doomed: SecureChannel = {
      remoteIdentity: 'peer',
      write: () => Promise.reject(undefined),
      read: () => new Promise<unknown>(() => {}),
      close: () => Promise.resolve(),
    } as unknown as SecureChannel
    const client = new JsonRpcClient(doomed)

    const error = await client.request('connection.ping', {}).catch((reason: unknown) => reason)
    expect((error as Error).message).toBe('JSON-RPC channel closed')
    expect(String(((error as Error).cause as Error | undefined)?.message)).toMatch(/write failed/i)
    expect(isChannelClosedError(error)).toBe(true)
  })

  it('⑨c (issue #28) a write failure fails EVERY request fail fast — queued ones never reach the channel', async () => {
    // The record-budget path aborts the connection upstream. Once this client
    // has seen that, no further request may attempt a write on a socket that is
    // already gone — not the one made after the fact, and not the ones already
    // QUEUED behind the in-flight window: a queued send is admitted by
    // drainQueue the moment the window frees, which is exactly when a dead
    // client must refuse instead of writing again.
    //
    // maxInFlight 1 makes the window hold three requests in sequence: the first
    // is in flight, the other two are queued. The write always rejects (the
    // channel is dead for every frame), so exactly ONE write may ever happen.
    const write = vi.fn(() => Promise.reject(new Error('Remote record budget exceeded')))
    const doomed: SecureChannel = {
      remoteIdentity: 'peer',
      write,
      read: () => new Promise<unknown>(() => {}),
      close: () => Promise.resolve(),
    } as unknown as SecureChannel
    const client = new JsonRpcClient(doomed, { maxInFlight: 1 })

    const settled = await Promise.allSettled([
      client.request('agent.agents.list', {}),
      client.request('agent.agents.list', {}),
      client.request('agent.agents.list', {}),
    ])
    // Every one of the three carries the classified face — including the two
    // admitted after the loss, which fail fast rather than write.
    for (const outcome of settled) {
      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected') {
        expect((outcome.reason as Error).message).toBe('JSON-RPC channel closed')
        expect(isChannelClosedError(outcome.reason)).toBe(true)
      }
    }
    expect(write).toHaveBeenCalledTimes(1)

    // And a request made later still fails fast with the same face.
    await expect(client.request('agent.agents.list', {})).rejects.toThrow(/^JSON-RPC channel closed$/)
    expect(write).toHaveBeenCalledTimes(1)
  })
})
