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
import { toRemoteSocket } from '../../src/rpc/wsAdapter'
import { JsonRpcClient, JsonRpcRequestError } from '../../src/rpc/jsonRpcClient'

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

const isRequest = (value: any): boolean =>
  typeof value === 'object' && value !== null && 'method' in value && 'id' in value

/**
 * The single owner of the peer-side read loop. A channel delivers each frame to
 * exactly one reader, so every helper must go through this one loop; concurrent
 * `peer.read()` calls would steal frames from each other.
 */
class PeerHarness {
  readonly requests: any[] = []
  readonly inFlight: string[] = []
  peakInFlight = 0
  /** When false, inbound requests are recorded but never answered. */
  autoReply = true
  onRequest: ((frame: any) => void) | undefined

  constructor(private readonly peer: SecureChannel) {
    void this.loop()
  }

  private async loop(): Promise<void> {
    for (;;) {
      let frame: any
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

  reply(frame: any, body: { result?: unknown; error?: unknown }): void {
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

  requestFor(method: string): any {
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

  it('④ drops a malformed response that matches no branch (drop + warn)', async () => {
    const { client, peer } = await openLoopback()

    const handler = vi.fn()
    client.onNotification(handler)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Step 3's third case: a frame with a valid `id` carrying neither `result`
    // nor `error` matches none of the three branches, so it is dropped with a
    // warning and never surfaced as a notification.
    await peer.write({ jsonrpc: '2.0', id: 999 })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        '[cherry-remote] dropped invalid JSON-RPC response',
        expect.objectContaining({ id: 999 }),
      )
    })
    expect(handler).not.toHaveBeenCalled()

    // The dropped frame leaves the request unanswered, so it settles by timeout
    // instead of resolving or hanging forever.
    await expect(client.request('echo.never', {}, { timeoutMs: 100 })).rejects.toThrow()
  })

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
    // and the outstanding request stays pending rather than resolving.
    await peer.write({ jsonrpc: '2.0', result: { ok: true } })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        '[cherry-remote] dropped invalid JSON-RPC notification',
        expect.objectContaining({ result: { ok: true } }),
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
    // and must be dropped (with a warning) without reaching handlers.
    await peer.write({ method: 'future.thing', params: {} })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        '[cherry-remote] dropped invalid JSON-RPC notification',
        expect.objectContaining({ method: 'future.thing' }),
      )
    })
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
})
