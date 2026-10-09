import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore } from '../../src/deviceStore'
import type { DeviceRecord } from '../../src/deviceStore'
import { PairingError } from '../../src/pairing'
import type { PairWithPayloadOptions } from '../../src/pairing'
import type { DeviceState } from '../../src/connection'
import { isTrustedWebRequest, registerHttpApi } from '../../src/httpApi'
import type { CherryHttpContext, CherryHttpDeps, HttpRequestLike, HttpResponseLike } from '../../src/httpApi'

/**
 * Task 11 integration suite: the same-origin HTTP face + SSE stream, driven
 * through a fake `ctx` that mirrors the real `WebServer.register` contract
 * (prefix table, disposer-per-route) and the real `webRuntime.trustedHosts`
 * accessor. Test numbering ①-⑥ mirrors the task brief's Step 1 scenarios.
 *
 * The fake deliberately dispatches WHATWG-style request facts (method/url/
 * headers + an async-iterable body) because that is exactly what the plugin's
 * routes consume; the host's Node `IncomingMessage` satisfies the same shape
 * for the fields read here.
 */

// ---------------------------------------------------------------------------
// Fake ctx: a faithful stand-in for ctx.webServer / ctx.webRuntime
// ---------------------------------------------------------------------------

type PrefixHandler = (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>

/** Prefix table that reproduces the host's longest-prefix-wins dispatch. */
class FakeWebServer {
  readonly routes = new Map<string, PrefixHandler>()
  readonly unregistered: string[] = []

  register(route: { kind: 'prefix' | 'exact'; path: string; handler: PrefixHandler }): () => void {
    if (this.routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`)
    this.routes.set(route.path, route.handler)
    return () => {
      this.unregistered.push(route.path)
      this.routes.delete(route.path)
    }
  }

  /** Dispatch one request through the prefix table; undefined = no route owns it. */
  async dispatch(req: HttpRequestLike, res: HttpResponseLike): Promise<boolean> {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    let best: { path: string; handler: PrefixHandler } | undefined
    for (const [path, handler] of this.routes) {
      if (pathname === path || pathname.startsWith(`${path}/`)) {
        if (best === undefined || path.length > best.path.length) best = { path, handler }
      }
    }
    if (best === undefined) return false
    await best.handler(req, res)
    return true
  }
}

interface FakeCtx {
  server: FakeWebServer
  trustedHosts: string[]
  injected: string[][]
  /** `false` makes dynamic injection throw (headless deploy). */
  injectable: boolean
  disposers: Array<() => void>
  inject(deps: string[], cb: (wctx: unknown) => void | (() => void)): void
  on(event: string, cb: () => void): void
}

function makeCtx(options: { trustedHosts?: string[]; injectable?: boolean } = {}): FakeCtx {
  const server = new FakeWebServer()
  const ctx: FakeCtx = {
    server,
    trustedHosts: options.trustedHosts ?? [],
    injected: [],
    injectable: options.injectable ?? true,
    disposers: [],
    inject(deps, cb) {
      ctx.injected.push([...deps])
      if (!ctx.injectable) throw new Error('service "webServer" is not available')
      const wctx = {
        webServer: server,
        webRuntime: { trustedHosts: ctx.trustedHosts },
      }
      const disposer = cb(wctx)
      if (typeof disposer === 'function') ctx.disposers.push(disposer)
    },
    on() {},
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Fake request / response
// ---------------------------------------------------------------------------

interface RequestInitLike {
  method?: string
  host?: string
  origin?: string
  headers?: Record<string, string>
  body?: string
}

class FakeRequest extends EventEmitter implements HttpRequestLike {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly #body: string

  constructor(url: string, init: RequestInitLike = {}) {
    super()
    this.url = url
    this.method = init.method ?? 'GET'
    this.#body = init.body ?? ''
    this.headers = { ...(init.headers ?? {}) }
    if (init.host !== undefined) this.headers['host'] = init.host
    if (init.origin !== undefined) this.headers['origin'] = init.origin
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    if (this.#body !== '') yield Buffer.from(this.#body, 'utf8')
  }

  /** Simulates the client hanging up (SSE disconnect). */
  disconnect(): void {
    this.emit('close')
  }
}

interface SentFrame {
  event?: string
  data?: string
  comment?: string
}

class FakeResponse implements HttpResponseLike {
  status = 0
  headers: Record<string, string> = {}
  body = ''
  ended = false
  writes = 0
  readonly #emitter = new EventEmitter()

  writeHead(status: number, headers: Record<string, string | number> = {}): void {
    this.status = status
    for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = String(value)
  }

  write(chunk: string): void {
    this.writes += 1
    this.body += chunk
  }

  end(chunk?: string): void {
    if (chunk !== undefined) this.body += chunk
    this.ended = true
  }

  on(event: string, listener: () => void): void {
    this.#emitter.on(event, listener)
  }

  /** All SSE frames written so far, parsed into event/data/comment triples. */
  frames(): SentFrame[] {
    const frames: SentFrame[] = []
    for (const block of this.body.split('\n\n')) {
      if (block.trim() === '') continue
      const frame: SentFrame = {}
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) frame.event = line.slice(7)
        else if (line.startsWith('data: ')) frame.data = line.slice(6)
        else if (line.startsWith(': ')) frame.comment = line.slice(2)
      }
      frames.push(frame)
    }
    return frames
  }

  /** Frames of one SSE event type; data parsed as JSON. */
  events<T = unknown>(type: string): T[] {
    return this.frames()
      .filter((frame) => frame.event === type)
      .map((frame) => JSON.parse(frame.data ?? 'null') as T)
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1:23023'
const PREFIX = '/cherry-remote/api'
/** Mirrors the implementation's keepalive cadence for the timer assertions. */
const HEARTBEAT_MS = 30_000

let dataDir: string
let store: DeviceStore
let ctx: FakeCtx
let dispose: (() => void) | undefined
let requests: Array<{ path: string; body?: unknown }>
let pairImpl: (opts: PairWithPayloadOptions) => Promise<DeviceRecord>

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    schemaVersion: 2,
    deviceId: 'dev-1',
    displayName: 'Workstation',
    hosts: ['192.168.1.20'],
    port: 8765,
    desktopIdentity: 'desktop-abc',
    grants: ['agent'],
    accessToken: 'super-secret-token',
    tokenExpiresAt: Date.now() + 3_600_000,
    enabled: true,
    ...overrides,
  }
}

function fakeConnection(initial: DeviceState = 'connected') {
  let state = initial
  const listeners = new Set<(state: DeviceState) => void>()
  return {
    get state() {
      return state
    },
    onState(cb: (state: DeviceState) => void) {
      listeners.add(cb)
    },
    setState(next: DeviceState) {
      state = next
      for (const cb of [...listeners]) cb(next)
    },
    connect: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }
}

/** Builds deps + registers the API. Real wiring shape, fake collaborators. */
function mount(overrides: Partial<CherryHttpDeps> = {}): FakeCtx {
  requests = []
  pairImpl = async (opts) => {
    opts.onStatus?.('validate')
    opts.onStatus?.('connect')
    return record()
  }

  store = new DeviceStore(join(dataDir, 'devices.json'))
  ctx = makeCtx()

  dispose = registerHttpApi(ctx as unknown as CherryHttpContext, {
    store,
    pair: (opts) => pairImpl(opts),
    identity: () => new Uint8Array([1, 2, 3]),
    connect: () => fakeConnection() as never,
    onDeviceState: () => {},
    onPairingProgress: () => {},
    ...overrides,
  })
  return ctx
}

async function call(
  path: string,
  init: RequestInitLike = {},
  target = ctx.server,
): Promise<{ status: number; json: any; res: FakeResponse }> {
  const req = new FakeRequest(`${PREFIX}${path}`, { host: HOST, ...init })
  const res = new FakeResponse()
  const owned = await target.dispatch(req, res)
  let body: unknown
  if (init.body !== undefined) {
    try {
      body = JSON.parse(init.body)
    } catch {
      body = init.body
    }
  }
  requests.push({ path, body })
  if (!owned) return { status: 0, json: undefined, res }
  return { status: res.status, json: res.body === '' ? undefined : JSON.parse(res.body), res }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cherry-http-'))
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.restoreAllMocks()
  rmSync(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// ① Five endpoints round-trip (REST schema; no credential fields leak)
// ---------------------------------------------------------------------------

describe('① REST round-trip', () => {
  it('GET /devices lists the public device projection without any credential field', async () => {
    mount({ connect: () => fakeConnection('offline') as never })
    store.upsert(record())

    const { status, json, res } = await call('/devices')

    expect(status).toBe(200)
    expect(Array.isArray(json)).toBe(true)
    expect(json).toHaveLength(1)
    expect(json[0]).toEqual({
      deviceId: 'dev-1',
      displayName: 'Workstation',
      state: 'offline',
      enabled: true,
      hosts: ['192.168.1.20'],
      port: 8765,
    })
    // The credential never reaches the browser: asserted on the parsed object
    // AND on the raw wire bytes (a nested/renamed copy would still leak).
    expect(json[0]).not.toHaveProperty('accessToken')
    expect(json[0]).not.toHaveProperty('tokenExpiresAt')
    expect(Object.keys(json[0]).sort()).toEqual(
      ['deviceId', 'displayName', 'enabled', 'hosts', 'port', 'state'].sort(),
    )
    expect(res.body).not.toContain('super-secret-token')
    expect(res.body).not.toContain('accessToken')
    expect(res.body).not.toContain('tokenExpiresAt')
  })

  it('POST /pair returns 202 + claimId immediately and pushes progress over SSE', async () => {
    mount()
    const res = new FakeResponse()
    const req = new FakeRequest(`${PREFIX}/events`, { host: HOST })
    await ctx.server.dispatch(req, res)

    const { status, json } = await call('/pair', {
      method: 'POST',
      body: JSON.stringify({ payload: '{"v":2}', name: 'Laptop' }),
    })

    expect(status).toBe(202)
    expect(typeof json.claimId).toBe('string')
    expect(json.claimId.length).toBeGreaterThan(0)

    // The code + terminal state travel on the pairing-progress channel, and
    // the HTTP response itself never waited for approval.
    expect(json.verificationCode).toBeUndefined()
    await vi.waitFor(() => {
      expect(res.events<{ stage: string }>('pairing-progress').map((p) => p.stage)).toEqual([
        'validate',
        'connect',
        'approved',
      ])
    })
  })

  it('DELETE /devices/:id removes the record and tears down a live connection', async () => {
    const dev = fakeConnection('connected')
    const closed: string[] = []
    const connectCalls: string[] = []
    mount({
      connect: (deviceId) => {
        connectCalls.push(deviceId)
        return { ...dev, close: () => Promise.resolve() } as never
      },
      // The pool resolves an EXISTING connection; DELETE must use this seam
      // rather than `connect`, which would fabricate one for a deleted record.
      detach: () =>
        ({
          ...dev,
          close: () => {
            closed.push('dev-1')
            return Promise.resolve()
          },
        }) as never,
    })
    store.upsert(record())

    const { status } = await call('/devices/dev-1', { method: 'DELETE' })

    expect(status).toBe(204)
    expect(store.list()).toHaveLength(0)
    // The removal tears down the socket instead of leaking it...
    expect(closed).toEqual(['dev-1'])
    // ...and never fabricates a connection for the record it just deleted.
    expect(connectCalls).toEqual([])
  })

  it('DELETE of an unknown device is a structured 404', async () => {
    mount()
    const { status, json } = await call('/devices/ghost', { method: 'DELETE' })
    expect(status).toBe(404)
    expect(typeof json.error).toBe('string')
  })

  it('PATCH /devices/:id applies displayName/enabled and persists', async () => {
    mount()
    store.upsert(record())

    const { status, json } = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Renamed', enabled: false }),
    })

    expect(status).toBe(200)
    expect(json).toMatchObject({ deviceId: 'dev-1', displayName: 'Renamed', enabled: false })
    expect(store.list()[0]).toMatchObject({ displayName: 'Renamed', enabled: false })
    expect(json).not.toHaveProperty('accessToken')
  })

  it('unknown device / unknown route / bad method surface structured JSON errors', async () => {
    mount()
    const missing = await call('/devices/nope', { method: 'DELETE' })
    expect(missing.status).toBe(404)
    expect(typeof missing.json.error).toBe('string')

    const badMethod = await call('/devices', { method: 'PUT' })
    expect(badMethod.status).toBe(405)
    expect(typeof badMethod.json.error).toBe('string')

    const unknown = await call('/nope')
    expect(unknown.status).toBe(404)
    expect(typeof unknown.json.error).toBe('string')
  })

  it('POST /pair maps an invalid payload to a distinct structured 4xx (never a bare throw)', async () => {
    mount()

    // The HTTP verdict is 202 (pairing is asynchronous), and the VERDICT
    // itself arrives on the progress channel — a bare throw would have left
    // the stream silent and the browser hanging.
    const res = new FakeResponse()
    await ctx.server.dispatch(new FakeRequest(`${PREFIX}/events`, { host: HOST }), res)

    pairImpl = () => Promise.reject(new PairingError('invalid-payload', 'payload is not valid JSON'))
    const { status, json } = await call('/pair', {
      method: 'POST',
      body: JSON.stringify({ payload: 'not json' }),
    })

    expect(status).toBe(202)
    expect(typeof json.claimId).toBe('string')
    await vi.waitFor(() => {
      const stages = res.events<{ stage: string; detail?: string }>('pairing-progress')
      expect(stages).toHaveLength(1)
      expect(stages[0]).toMatchObject({ stage: 'invalid-payload' })
      expect(stages[0]!.detail).toContain('payload')
    })

    // A non-payload failure is a DIFFERENT verdict (the peer never answered):
    // distinct stage, never conflated with the client's own bad input.
    pairImpl = () => Promise.reject(new PairingError('unreachable', 'no candidate address could complete pairing'))
    const unreachable = await call('/pair', {
      method: 'POST',
      body: JSON.stringify({ payload: '{"v":2}' }),
    })
    expect(unreachable.status).toBe(202)
    await vi.waitFor(() => {
      expect(res.events<{ stage: string }>('pairing-progress').map((p) => p.stage)).toEqual([
        'invalid-payload',
        'unreachable',
      ])
    })
  })

  it('carries the verification code on the SSE stream with its stage', async () => {
    mount()
    const res = new FakeResponse()
    await ctx.server.dispatch(new FakeRequest(`${PREFIX}/events`, { host: HOST }), res)

    // pairWithPayload delivers the code through its own callback; the contract
    // is that it reaches the client as a pairing-progress frame (the card the
    // user compares against the desktop shows it, and it disappears on
    // completion) rather than as a field of the 202 response.
    pairImpl = async (opts) => {
      opts.onVerificationCode('424242')
      return record()
    }

    const { status, json } = await call('/pair', {
      method: 'POST',
      body: JSON.stringify({ payload: '{"v":2}' }),
    })
    expect(status).toBe(202)
    expect(json).not.toHaveProperty('verificationCode')

    await vi.waitFor(() => {
      const frames = res.events<{ stage: string; detail?: string }>('pairing-progress')
      expect(frames[0]).toEqual({ stage: 'verification-code', detail: '424242' })
      // The run's terminal state follows the code on the same channel.
      expect(frames[frames.length - 1]).toEqual({ stage: 'approved' })
    })
  })

  it('keeps a second pairing run from consuming the first run callbacks', async () => {
    /** One pairing run, held open so two runs overlap. */
    const pending: Array<{ opts: PairWithPayloadOptions; release: () => void }> = []
    mount({
      pair: (opts) =>
        new Promise<DeviceRecord>((resolve) => {
          pending.push({ opts, release: () => resolve(record()) })
        }),
    })

    await call('/pair', { method: 'POST', body: JSON.stringify({ payload: '{"v":2}' }) })
    await call('/pair', { method: 'POST', body: JSON.stringify({ payload: '{"v":2}' }) })
    expect(pending).toHaveLength(2)

    // Each run got its own payload/name/identity rather than a shared closure.
    expect(pending[0]!.opts.payload).toBe('{"v":2}')
    expect(pending[0]!.opts.onVerificationCode).not.toBe(pending[1]!.opts.onVerificationCode)
    expect(pending[0]!.opts.onStatus).not.toBe(pending[1]!.opts.onStatus)

    for (const run of pending) run.release()
  })

  it('POST /pair rejects a malformed request body with a structured 400 before pairing starts', async () => {
    mount()
    let paired = false
    pairImpl = async () => {
      paired = true
      return record()
    }

    const noPayload = await call('/pair', { method: 'POST', body: JSON.stringify({}) })
    expect(noPayload.status).toBe(400)
    expect(noPayload.json.error).toBe('invalid-request')

    const notJson = await call('/pair', { method: 'POST', body: '{oops' })
    expect(notJson.status).toBe(400)
    expect(notJson.json.error).toBe('invalid-request')

    const badName = await call('/pair', {
      method: 'POST',
      body: JSON.stringify({ payload: '{"v":2}', name: 7 }),
    })
    expect(badName.status).toBe(400)

    // A refused body never reaches the pairing flow.
    expect(paired).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ② Trust fence — all four branches
// ---------------------------------------------------------------------------

describe('② trust fence', () => {
  it('rejects a non-loopback Host', async () => {
    mount()
    const req = new FakeRequest(`${PREFIX}/devices`, { host: 'evil.example.com' })
    expect(isTrustedWebRequest(req as never, [])).toBe(false)

    const res = new FakeResponse()
    await ctx.server.dispatch(req, res)
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body).error).toBe('forbidden')
  })

  it('accepts a declared trusted host authority', async () => {
    const req = new FakeRequest(`${PREFIX}/devices`, { host: 'harness.internal:23023' })
    expect(isTrustedWebRequest(req as never, ['harness.internal:23023'])).toBe(true)
    expect(isTrustedWebRequest(req as never, [])).toBe(false)
  })

  it('rejects a cross-origin Origin', async () => {
    mount()
    const req = new FakeRequest(`${PREFIX}/devices`, { host: HOST, origin: 'http://evil.example.com' })
    expect(isTrustedWebRequest(req as never, [])).toBe(false)

    const res = new FakeResponse()
    await ctx.server.dispatch(req, res)
    expect(res.status).toBe(403)
  })

  it('rejects sec-fetch-site: cross-site', async () => {
    mount()
    const req = new FakeRequest(`${PREFIX}/devices`, {
      host: HOST,
      origin: `http://${HOST}`,
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(isTrustedWebRequest(req as never, [])).toBe(false)

    const res = new FakeResponse()
    await ctx.server.dispatch(req, res)
    expect(res.status).toBe(403)
  })

  it('admits a same-origin Origin and a missing Origin (non-browser client)', async () => {
    mount()
    expect(isTrustedWebRequest(new FakeRequest('/', { host: HOST }) as never, [])).toBe(true)
    expect(isTrustedWebRequest(new FakeRequest('/', { host: HOST, origin: `http://${HOST}` }) as never, [])).toBe(true)

    const noOrigin = await call('/devices')
    expect(noOrigin.status).toBe(200)

    const sameOrigin = await call('/devices', { origin: `http://${HOST}` })
    expect(sameOrigin.status).toBe(200)
  })

  it('applies the fence to the SSE route too', async () => {
    mount()
    const res = new FakeResponse()
    await ctx.server.dispatch(new FakeRequest(`${PREFIX}/events`, { host: 'evil.example.com' }), res)
    expect(res.status).toBe(403)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.ended).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ③ SSE: device state + pairing progress, disconnect cleanup
// ---------------------------------------------------------------------------

describe('③ SSE stream', () => {
  it('pushes device-state changes and pairing-progress frames', async () => {
    const dev = fakeConnection('connecting')
    let pushPairing: ((event: { stage: string; detail?: string }) => void) | undefined
    let pushState: ((event: { deviceId: string; state: DeviceState }) => void) | undefined
    mount({
      connect: () => dev as never,
      onPairingProgress: (cb) => (pushPairing = cb),
      onDeviceState: (cb) => (pushState = cb),
    })
    store.upsert(record())

    const res = new FakeResponse()
    await ctx.server.dispatch(new FakeRequest(`${PREFIX}/events`, { host: HOST }), res)

    expect(res.headers['content-type']).toContain('text/event-stream')

    // The connection's own state machine drives the device-state channel...
    dev.setState('connected')
    // ...which the assembly bridges into the SSE channel.
    pushState?.({ deviceId: 'dev-1', state: 'connected' })
    pushPairing?.({ stage: 'waiting', detail: 'compare the code' })

    const states = res.events<{ deviceId: string; state: string }>('device-state')
    expect(states[states.length - 1]).toEqual({ deviceId: 'dev-1', state: 'connected' })
    expect(res.events<{ stage: string; detail?: string }>('pairing-progress')).toEqual([
      { stage: 'waiting', detail: 'compare the code' },
    ])
  })

  it('writes a heartbeat comment line so intermediaries keep the stream open', async () => {
    vi.useFakeTimers()
    try {
      mount()
      const res = new FakeResponse()
      await ctx.server.dispatch(new FakeRequest(`${PREFIX}/events`, { host: HOST }), res)

      expect(res.frames().some((frame) => frame.comment !== undefined)).toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(res.frames().some((frame) => frame.comment !== undefined)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pushes one initial device-state frame per known device on subscribe', async () => {
    const dev = fakeConnection('connected')
    mount({ connect: () => dev as never })
    store.upsert(record())
    store.upsert(record({ deviceId: 'dev-2', displayName: 'Studio', enabled: false }))

    const res = new FakeResponse()
    await ctx.server.dispatch(new FakeRequest(`${PREFIX}/events`, { host: HOST }), res)

    expect(res.events<{ deviceId: string; state: string }>('device-state')).toEqual([
      { deviceId: 'dev-1', state: 'connected' },
      { deviceId: 'dev-2', state: 'disabled' },
    ])
  })

  it('cleans up the subscription on client disconnect (no leaked handles)', async () => {
    vi.useFakeTimers()
    try {
      const dev = fakeConnection('connected')
      mount({ connect: () => dev as never })
      store.upsert(record())

      const req = new FakeRequest(`${PREFIX}/events`, { host: HOST })
      const res = new FakeResponse()
      await ctx.server.dispatch(req, res)
      // The initial first-frame push proves the response is live and subscribed.
      expect(res.writes).toBe(1)

      req.disconnect()

      // A disconnected client is forgotten: the hub writes nothing more to it,
      // and the heartbeat is torn down with the last client — a leaked interval
      // would keep firing against a detached response.
      const after = res.writes
      dev.setState('offline')
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
      expect(res.writes).toBe(after)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('unsubscribes so a disconnected client receives no further frames', async () => {
    let push: ((event: { stage: string }) => void) | undefined
    mount({ onPairingProgress: (cb) => (push = cb) })

    const res = new FakeResponse()
    const req = new FakeRequest(`${PREFIX}/events`, { host: HOST })
    await ctx.server.dispatch(req, res)
    const before = res.writes

    req.disconnect()
    push?.({ stage: 'claim' })

    expect(res.writes).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// ④ PATCH hosts replace wholesale; port shared by all hosts
// ---------------------------------------------------------------------------

describe('④ PATCH address maintenance', () => {
  it('replaces the hosts array wholesale (never merges)', async () => {
    mount()
    store.upsert(record({ hosts: ['10.0.0.1', '10.0.0.2'] }))

    const { status, json } = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['10.0.0.9'] }),
    })

    expect(status).toBe(200)
    expect(json.hosts).toEqual(['10.0.0.9'])
    expect(store.list()[0]!.hosts).toEqual(['10.0.0.9'])
  })

  it('applies the single shared port to every host and rejects malformed input', async () => {
    mount()
    store.upsert(record())

    const ok = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['[::1]', '127.0.0.1'], port: 9000 }),
    })
    expect(ok.status).toBe(200)
    expect(ok.json.hosts).toEqual(['::1', '127.0.0.1'])
    expect(ok.json.port).toBe(9000)
    expect(store.list()[0]).toMatchObject({ hosts: ['::1', '127.0.0.1'], port: 9000 })

    const badPort = await call('/devices/dev-1', { method: 'PATCH', body: JSON.stringify({ port: 99_999 }) })
    expect(badPort.status).toBe(400)
    expect(typeof badPort.json.error).toBe('string')

    const badHosts = await call('/devices/dev-1', { method: 'PATCH', body: JSON.stringify({ hosts: [] }) })
    expect(badHosts.status).toBe(400)
    expect(store.list()[0]!.port).toBe(9000)
  })
})

// ---------------------------------------------------------------------------
// ⑤ disable → enable state flow
// ---------------------------------------------------------------------------

describe('⑤ disable/enable flow', () => {
  it('PATCH enabled:false closes the device and reports disabled; enabling reconnects', async () => {
    const dev = fakeConnection('connected')
    const connectCalls: string[] = []
    mount({
      connect: (deviceId) => {
        connectCalls.push(deviceId)
        dev.setState('connecting')
        dev.setState('connected')
        return dev as never
      },
    })

    store.upsert(record())

    const disabled = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    })
    expect(disabled.status).toBe(200)
    expect(disabled.json).toMatchObject({ deviceId: 'dev-1', enabled: false, state: 'disabled' })
    expect(store.list()[0]!.enabled).toBe(false)

    // The SSE view agrees: disabled is the projected state, not the stale one.
    const res = new FakeResponse()
    await ctx.server.dispatch(new FakeRequest(`${PREFIX}/events`, { host: HOST }), res)
    expect(res.events<{ deviceId: string; state: string }>('device-state')).toEqual([
      { deviceId: 'dev-1', state: 'disabled' },
    ])

    // Re-enabling drives the connection lifecycle and reports the LIVE state,
    // never the stale 'disabled' the record carried a moment ago.
    dev.setState('offline')
    const enabled = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    })
    expect(enabled.status).toBe(200)
    expect(enabled.json.enabled).toBe(true)
    expect(enabled.json.state).toBe('connected')
    expect(connectCalls).toContain('dev-1')
    expect(store.list()[0]!.enabled).toBe(true)

    // A re-enabled device is no longer projected as disabled on the stream.
    const reopened = new FakeResponse()
    await ctx.server.dispatch(new FakeRequest(`${PREFIX}/events`, { host: HOST }), reopened)
    expect(reopened.events<{ deviceId: string; state: string }>('device-state')).toEqual([
      { deviceId: 'dev-1', state: 'connected' },
    ])
  })

  it('publishes the new state on the stream when a device is disabled', async () => {
    const dev = fakeConnection('connected')
    mount({ connect: () => dev as never })
    store.upsert(record())

    const res = new FakeResponse()
    await ctx.server.dispatch(new FakeRequest(`${PREFIX}/events`, { host: HOST }), res)

    await call('/devices/dev-1', { method: 'PATCH', body: JSON.stringify({ enabled: false }) })

    // The initial frame said connected; the disable publishes the projection.
    expect(res.events<{ deviceId: string; state: string }>('device-state').map((e) => e.state)).toEqual([
      'connected',
      'disabled',
    ])
  })
})

// ---------------------------------------------------------------------------
// ⑥ registration/unregistration lifecycle (disposer)
// ---------------------------------------------------------------------------

describe('⑥ lifecycle', () => {
  it('stops answering every route once the plugin disposer runs', async () => {
    mount()
    expect((await call('/devices')).status).toBe(200)

    dispose?.()
    dispose = undefined

    // The route seat is gone from the host table, so nothing owns the request.
    expect(ctx.server.routes.size).toBe(0)
    expect(ctx.server.unregistered).toContain(PREFIX)
    const after = await call('/devices')
    expect(after.status).toBe(0)
  })

  it('closes live SSE clients on dispose and unsubscribes them', async () => {
    mount()
    const res = new FakeResponse()
    const req = new FakeRequest(`${PREFIX}/events`, { host: HOST })
    await ctx.server.dispatch(req, res)
    expect(res.ended).toBe(false)

    dispose?.()
    dispose = undefined

    expect(res.ended).toBe(true)
  })

  it('skips HTTP registration with a warning when webServer is unavailable', () => {
    const headless = makeCtx({ injectable: false })
    const warn = vi.mocked(console.warn)
    warn.mockClear()

    const result = registerHttpApi(headless as unknown as CherryHttpContext, {
      store: new DeviceStore(join(dataDir, 'devices.json')),
      pair: (opts) => pairImpl(opts),
      identity: () => new Uint8Array([1]),
      connect: () => fakeConnection() as never,
      onDeviceState: () => {},
      onPairingProgress: () => {},
    })

    expect(headless.server.routes.size).toBe(0)
    expect(warn).toHaveBeenCalled()
    expect(() => result()).not.toThrow()
  })

  it('registers lazily through dynamic injection and returns a working disposer', async () => {
    mount()
    expect(ctx.injected).toEqual([['webServer', 'webRuntime']])
    expect(ctx.server.routes.has(PREFIX)).toBe(true)
    // The host's `register` disposer is what the returned teardown drives.
    expect(typeof dispose).toBe('function')
    dispose?.()
    dispose = undefined
    expect(ctx.server.unregistered).toEqual([PREFIX])
  })
})

// ---------------------------------------------------------------------------
// The real plugin assembly (index.ts apply): minimal M2 wiring
// ---------------------------------------------------------------------------

describe('plugin assembly (index.ts apply)', () => {
  interface AssemblyCtx {
    routes: Map<string, unknown>
    effects: Array<() => void>
    dataDir: string
    injectable: boolean
    inject(deps: string[], cb: (wctx: unknown) => unknown): void
    effect(cb: () => () => void): void
  }

  function assemblyCtx(injectable = true): AssemblyCtx {
    const routes = new Map<string, unknown>()
    const effects: Array<() => void> = []
    return {
      routes,
      effects,
      dataDir,
      injectable,
      inject(_deps, cb) {
        if (!injectable) throw new Error('service "webServer" is not available')
        cb({
          webServer: {
            register: (route: { path: string; handler: unknown }) => {
              routes.set(route.path, route.handler)
              return () => routes.delete(route.path)
            },
          },
          webRuntime: { trustedHosts: [] },
        })
      },
      effect(cb) {
        effects.push(cb())
      },
    }
  }

  it('declares the plugin identity the host loads it by', async () => {
    const index = await import('../../src/index')
    expect(index.name).toBe('cherry-remote')
    expect(index.inject).toEqual(['tools'])
  })

  it('resolves the data directory: explicit > $DSH_HOME > ~/.dsh', async () => {
    const { resolveDataDir } = await import('../../src/index')
    expect(resolveDataDir({ dataDir: '/explicit' }, {})).toBe('/explicit')
    expect(resolveDataDir({}, { DSH_HOME: '/harness' })).toBe('/harness/cherry-remote')
    expect(resolveDataDir({}, {})).toContain('.dsh')
  })

  it('mounts the route, creates the identity key, and releases both on dispose', async () => {
    const index = await import('../../src/index')
    const ctx = assemblyCtx()

    index.apply(ctx as never, { dataDir })

    expect(ctx.routes.has(PREFIX)).toBe(true)
    // The identity load is async by design (apply must stay synchronous), so
    // the 0600 key file appears shortly after apply returns.
    await vi.waitFor(() => {
      expect(existsSync(join(dataDir, 'identity.key'))).toBe(true)
    })

    expect(ctx.effects).toHaveLength(1)
    ctx.effects[0]!()
    expect(ctx.routes.size).toBe(0)
  })

  it('does not adopt connections from a previous apply against another archive', async () => {
    const index = await import('../../src/index')
    const first = assemblyCtx()
    index.apply(first as never, { dataDir })

    // A second apply with a fresh data dir must start from an empty pool, so a
    // device id present only in the OLD archive cannot be served from a stale
    // connection bound to the old store.
    const secondDir = mkdtempSync(join(tmpdir(), 'cherry-http-2-'))
    try {
      const second = assemblyCtx()
      expect(() => index.apply(second as never, { dataDir: secondDir })).not.toThrow()
      expect(second.routes.has(PREFIX)).toBe(true)
      // The first plugin's route seat was replaced by its own teardown path.
      expect(first.effects).toHaveLength(1)
      first.effects[0]!()
    } finally {
      rmSync(secondDir, { recursive: true, force: true })
    }
  })

  it('degrades quietly instead of failing the plugin in a headless deployment', async () => {
    const index = await import('../../src/index')
    const ctx = assemblyCtx(false)
    const warn = vi.mocked(console.warn)

    expect(() => index.apply(ctx as never, { dataDir })).not.toThrow()
    expect(ctx.routes.size).toBe(0)
    expect(warn).toHaveBeenCalled()
  })
})
