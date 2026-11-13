import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore, QuarantinedArchiveError } from '../../src/deviceStore.js'
import type { DeviceRecord } from '../../src/deviceStore.js'
import { PairingError } from '../../src/pairing.js'
import type { PairWithPayloadOptions } from '../../src/pairing.js'
import type { DeviceState } from '../../src/connection.js'
import { isTrustedWebRequest, registerHttpApi, resolveTrustedHosts } from '../../src/httpApi.js'
import type { CherryHttpContext, CherryHttpDeps, HttpRequestLike, HttpResponseLike } from '../../src/httpApi.js'
import { FakeRequest, FakeResponse, type FakeRequestInit as RequestInitLike } from '../helpers/fakeHttp.js'
import { ToolScopeState } from '../../src/toolScope.js'
import { resolveSubagentConfig } from '../../src/subagent.js'
import type { SubagentConfigResolution } from '../../src/subagent.js'
import { createSubagentConfigDocument } from '../../src/subagentConfigStore.js'
import type { SubagentSubsystemStatus } from '../../src/subagentHost.js'
import { JsonRpcRequestError, RequestTimeoutError } from '../../src/rpc/jsonRpcClient.js'
import { DeviceUnavailableError, TransportLostError } from '../../src/connection.js'
import type { SubagentTargetsOutcome } from '../../src/tools.js'
import { LOG_TEXT_MAX } from '../../src/text.js'
import { asksForScopeKeys } from '../helpers/scopeInjectKeys.js'
import { applyAssembly, settleIdentity } from '../helpers/applyAssembly.js'

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

/**
 * Which host generation the fake serves (issue #7):
 *  - `hybrid`: DSH 0.2.0 — `webRuntime` arrives via `ctx.get`, and `webStartup`
 *    does not exist yet.
 *  - `webserver-only`: DSH 0.2.1-rc.2 — `webRuntime` is GONE (the service was
 *    removed) and `trustedHosts` (plus the explicit listener bind as `host`)
 *    moved to the `webStartup` service config. The injected ctx never carries
 *    either one: real cordis would throw on the read (see {@link strictWctx}).
 *  - `bare`: neither generation — only `webServer`, so the fence falls back to
 *    loopback-only.
 */
type HostShape = 'hybrid' | 'webserver-only' | 'bare'

interface FakeCtx {
  server: FakeWebServer
  trustedHosts: string[]
  /** The 0.2.1 `webStartup.host` (the explicit `--host` bind), when any. */
  host?: string
  injected: string[][]
  /** `false` makes dynamic injection throw (headless deploy). */
  injectable: boolean
  /** The host generation the fake answers with. */
  shape: HostShape
  disposers: Array<() => void>
  inject(deps: string[], cb: (wctx: unknown) => void | (() => void)): void
  /** cordis' optional lookup — NOT gated by `inject`; absent ⇒ `undefined`. */
  get(name: string): unknown
  on(event: string, cb: () => void): void
}

/**
 * Wraps the callback's ctx in the STRICT reflection proxy real cordis installs
 * (`ReflectService.handler.get`, cordis 4.0.5): EVERY property read is checked
 * against the injection list, and a name that is not injected THROWS
 * synchronously — `cannot get property "<prop>" without inject`. `?.` does not
 * save a caller, because the get trap itself throws.
 *
 * This is the DEFAULT here, not an opt-in: it is the precise mechanism that let
 * issue #7's first fix pass review while being broken (reading `wctx.webRuntime`
 * threw inside the callback, so `mountRoutes` never ran) and then broke 0.2.0
 * again. Any regression back to reading a non-injected key turns these cases
 * RED instead of silently mounting nothing.
 *
 * Keys carried on the wctx are exactly what the service provides (here only
 * `webServer`, matching the injection list); symbols and other non-service
 * intrinsics pass through untouched, as cordis' `isSpecialProperty` does.
 */
function strictWctx<T extends object>(services: T, deps: readonly string[]): T {
  const injected = new Set(deps)
  return new Proxy(services, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (!injected.has(prop)) throw new Error(`cannot get property "${prop}" without inject`)
      return Reflect.get(target, prop, receiver)
    },
  })
}

function makeCtx(
  options: { trustedHosts?: string[]; host?: string; injectable?: boolean; shape?: HostShape } = {},
): FakeCtx {
  const server = new FakeWebServer()
  const ctx: FakeCtx = {
    server,
    trustedHosts: options.trustedHosts ?? [],
    host: options.host,
    injected: [],
    injectable: options.injectable ?? true,
    shape: options.shape ?? 'hybrid',
    disposers: [],
    inject(deps, cb) {
      ctx.injected.push([...deps])
      if (!ctx.injectable) throw new Error('service "webServer" is not available')
      // The REAL injected ctx: `webServer` alone, behind the strict proxy. No
      // generation carries `webRuntime`/`webStartup` here — a real cordis proxy
      // would throw on that read.
      const disposer = cb(strictWctx({ webServer: server }, deps))
      if (typeof disposer === 'function') ctx.disposers.push(disposer)
    },
    get(name) {
      // 0.2.0 exposes `webRuntime`; 0.2.1 exposes `webStartup` (`trustedHosts`
      // plus, only with an explicit `--host`, the listener bind as `host`).
      if (name === 'webRuntime') {
        return ctx.shape === 'hybrid' ? { trustedHosts: ctx.trustedHosts } : undefined
      }
      if (name === 'webStartup') {
        if (ctx.shape === 'hybrid') return undefined
        return ctx.host === undefined
          ? { trustedHosts: ctx.trustedHosts }
          : { trustedHosts: ctx.trustedHosts, host: ctx.host }
      }
      return undefined
    },
    on() {},
  }
  return ctx
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

/** One `ws` entry per host: the plain dial every test fixture stands for. */
function wsSecurity(hosts: readonly string[]): Record<string, 'ws' | 'wss'> {
  return Object.fromEntries(hosts.map((host) => [host, 'ws' as const]))
}

/** One record-level port per host: the pre-#135 shape every fixture starts at. */
function sharedPorts(hosts: readonly string[], port: number): Record<string, number> {
  return Object.fromEntries(hosts.map((host) => [host, port]))
}

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  const base: Omit<DeviceRecord, 'security' | 'ports'> = {
    schemaVersion: 4,
    deviceId: 'dev-1',
    displayName: 'Workstation',
    hosts: ['192.168.1.20'],
    port: 8765,
    desktopIdentity: 'desktop-abc',
    grants: ['agent'],
    accessToken: 'super-secret-token',
    tokenExpiresAt: Date.now() + 3_600_000,
    enabled: true,
  }
  const merged = { ...base, ...overrides }
  // `security` and `ports` are keyed by host and must cover exactly the FINAL
  // host list (the store rejects anything else), so they are derived after the
  // overrides.
  const hosts = overrides.hosts ?? base.hosts
  return {
    ...merged,
    security: overrides.security ?? wsSecurity(hosts),
    ports: overrides.ports ?? sharedPorts(hosts, overrides.port ?? base.port),
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
    // A REAL scope state (never a placeholder): Task 9's `diagnosticsReport`
    // dereferences this object field by field, so an `as never` here would turn
    // the existing `/diagnostics` cases into 500s.
    scope: new ToolScopeState({ file: join(dataDir, 'scope.json') }),
    refreshScope: () => undefined,
    pair: (opts) => pairImpl(opts),
    identity: () => new Uint8Array([1, 2, 3]),
    connect: () => fakeConnection() as never,
    onDeviceState: () => {},
    onPairingProgress: () => {},
    ...overrides,
  })
  return ctx
}

/**
 * `json` is deliberately `any` and is the ONE such escape in this file.
 *
 * It is the parsed body of a response under test, and this harness drives every
 * route, so its shape differs per call and the ASSERTIONS are what pin it down
 * (`expect(x.json.claimId).not.toBe(...)`, `expect(typeof x.json.error)`). The
 * honest type would be a per-route union, or `Record<string, unknown>` plus 46
 * narrowing rewrites at every call site. Both are behaviour-adjacent churn
 * outside a module-resolution migration, so it is left as it was. It is
 * PRE-EXISTING (bundler resolution never flagged it — `any` is explicit, not an
 * error hole) and it is NOT part of the nodenext error set.
 *
 * TODO(types): replace with `Record<string, unknown>` and narrow per assertion.
 */
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
  // `mount` resets this too; assembly tests drive the same dispatcher without
  // mounting, so it must never be left undefined.
  requests = []
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
      // The scheme and port maps are part of the address, not a credential:
      // the settings page shows which door each host dials and on which port
      // (issues #126/#135).
      security: { '192.168.1.20': 'ws' },
      ports: { '192.168.1.20': 8765 },
      // The forgotten addresses are part of the archive's public projection
      // (issue #185); an empty list is the honest "none", not an absent key.
      forgottenHosts: [],
    })
    // The credential never reaches the browser: asserted on the parsed object
    // AND on the raw wire bytes (a nested/renamed copy would still leak).
    expect(json[0]).not.toHaveProperty('accessToken')
    expect(json[0]).not.toHaveProperty('tokenExpiresAt')
    expect(Object.keys(json[0]).sort()).toEqual(
      [
        'deviceId',
        'displayName',
        'enabled',
        'forgottenHosts',
        'hosts',
        'port',
        'ports',
        'security',
        'state',
      ].sort(),
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
      // The pool exposes TWO seams: `detach` only RESOLVES a live entry, while
      // `evict` is the one that removes it AND closes its socket (see
      // `index.ts`). DELETE must use the evicting one — `detach().close()`
      // would close the socket but leave the dead connection pooled, and
      // `connect` would fabricate one for a record it just deleted.
      detach: () => ({ ...dev, close: () => Promise.resolve() }) as never,
      evict: () => {
        closed.push('dev-1')
      },
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
      const frames = res.events<{ stage: string; detail?: string; claimId?: string }>('pairing-progress')
      // Every frame carries the run's own handle, the same one the 202 returned.
      expect(frames[0]).toEqual({ stage: 'verification-code', detail: '424242', claimId: json.claimId })
      // The run's terminal state follows the code on the same channel.
      expect(frames[frames.length - 1]).toEqual({ stage: 'approved', claimId: json.claimId })
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

  it('tags every pairing-progress frame with its own claimId, so two concurrent runs cannot cross-talk', async () => {
    // The 202 already hands the browser a `claimId`; the frames must carry the
    // SAME handle, or a tab that started run #2 cannot tell run #1's stages —
    // and, worse, run #1's 6-digit CODE — from its own. Two tabs pairing two
    // different desktops at once is the ordinary case this protects.
    const pending: Array<{ opts: PairWithPayloadOptions; release: () => void }> = []
    mount({
      pair: (opts) =>
        new Promise<DeviceRecord>((resolve) => {
          pending.push({ opts, release: () => resolve(record()) })
        }),
    })

    const res = new FakeResponse()
    await ctx.server.dispatch(new FakeRequest(`${PREFIX}/events`, { host: HOST }), res)

    const first = await call('/pair', { method: 'POST', body: JSON.stringify({ payload: '{"v":2}' }) })
    const second = await call('/pair', { method: 'POST', body: JSON.stringify({ payload: '{"v":2}' }) })
    expect(first.json.claimId).not.toBe(second.json.claimId)
    expect(pending).toHaveLength(2)

    // Each run advances its own stages and shows its own code.
    pending[0]!.opts.onStatus?.('validate')
    pending[1]!.opts.onStatus?.('validate')
    pending[0]!.opts.onStatus?.('waiting')
    pending[0]!.opts.onVerificationCode('111111')
    pending[1]!.opts.onVerificationCode('222222')
    pending[0]!.release()
    pending[1]!.release()

    await vi.waitFor(() => {
      expect(res.events<{ stage: string }>('pairing-progress').length).toBeGreaterThanOrEqual(6)
    })

    const frames = res.events<{ stage: string; detail?: string; claimId?: string }>('pairing-progress')
    // EVERY frame is attributable, and only to one of the two runs.
    for (const frame of frames) {
      expect([first.json.claimId, second.json.claimId]).toContain(frame.claimId)
    }

    // Filtering by the first run's handle yields exactly the FIRST run's story:
    // its stages, its code, its terminal — and nothing from run #2.
    const mine = frames.filter((frame) => frame.claimId === first.json.claimId)
    expect(mine.map((frame) => frame.stage)).toEqual(['validate', 'waiting', 'verification-code', 'approved'])
    expect(mine.find((frame) => frame.stage === 'verification-code')!.detail).toBe('111111')

    const theirs = frames.filter((frame) => frame.claimId === second.json.claimId)
    expect(theirs.map((frame) => frame.stage)).toEqual(['validate', 'verification-code', 'approved'])
    expect(theirs.find((frame) => frame.stage === 'verification-code')!.detail).toBe('222222')
  })

  it('tags a FAILED pairing run with the same claimId its 202 returned', async () => {
    mount({
      pair: () => Promise.reject(new PairingError('unreachable', 'no candidate address could complete pairing')),
    })

    const res = new FakeResponse()
    await ctx.server.dispatch(new FakeRequest(`${PREFIX}/events`, { host: HOST }), res)

    const { json } = await call('/pair', { method: 'POST', body: JSON.stringify({ payload: '{"v":2}' }) })

    await vi.waitFor(() => {
      expect(res.events<{ stage: string }>('pairing-progress')).toHaveLength(1)
    })
    // The failure verdict is scoped to the run that produced it too — otherwise
    // a second tab's wizard would settle on the first tab's failure.
    const [frame] = res.events<{ stage: string; claimId?: string }>('pairing-progress')
    expect(frame!.stage).toBe('unreachable')
    expect(frame!.claimId).toBe(json.claimId)
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

  it('admits IPv6 loopback hosts, including the IPv4-mapped forms', async () => {
    // The host arrives as the WHATWG serialization, which KEEPS the brackets:
    // `new URL('http://[::1]:23023').hostname` is `'[::1]'`. So a browser on
    // `http://[::1]:23023` sends a bracketed authority, and it must be admitted.
    expect(isTrustedWebRequest(new FakeRequest('/', { host: '[::1]:23023' }) as never, [])).toBe(true)

    // THE REAL GAP: the IPv4-MAPPED loopback family. A dual-stack listener
    // reached over IPv6 is addressed as `::ffff:127.0.0.1`, which the serializer
    // rewrites to the HEX form `[::ffff:7f00:1]` — so that is the spelling the
    // fence actually sees, and the dotted spelling must work too for a caller
    // passing a raw header.
    expect(isTrustedWebRequest(new FakeRequest('/', { host: '[::ffff:7f00:1]:23023' }) as never, [])).toBe(true)
    expect(isTrustedWebRequest(new FakeRequest('/', { host: '[::ffff:127.0.0.1]:23023' }) as never, [])).toBe(true)

    // Still refused: this widens the loopback set by the mapped 127/8 range, not
    // by "anything with a v6 shape". A mapped NON-loopback address is not local.
    expect(isTrustedWebRequest(new FakeRequest('/', { host: '[::2]:23023' }) as never, [])).toBe(false)
    expect(isTrustedWebRequest(new FakeRequest('/', { host: '[2001:db8::1]:23023' }) as never, [])).toBe(false)
    expect(isTrustedWebRequest(new FakeRequest('/', { host: '[::ffff:8.8.8.8]:23023' }) as never, [])).toBe(false)
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
      onPairingProgress: (cb) => {
        pushPairing = cb
      },
      onDeviceState: (cb) => {
        pushState = cb
      },
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
    mount({
      onPairingProgress: (cb) => {
        push = cb
      },
    })

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
// ④ PATCH hosts replace wholesale; a port edit re-points every host
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
    // The new host has no remembered port, so it falls back to the record-level
    // `port`; the dropped host leaves no entry behind (the store rejects a map
    // naming a host it does not list).
    expect(json.ports).toEqual({ '10.0.0.9': 8765 })
    expect(store.list()[0]!.hosts).toEqual(['10.0.0.9'])
    expect(store.list()[0]!.ports).toEqual({ '10.0.0.9': 8765 })
  })

  it('keeps the port of a host that stays in the list and defaults a new one to the record port', async () => {
    mount()
    // A mixed-port record: the two hosts were paired on DIFFERENT ports.
    store.upsert(
      record({
        hosts: ['10.0.0.1', '10.0.0.2'],
        port: 8765,
        ports: { '10.0.0.1': 1111, '10.0.0.2': 2222 },
      }),
    )

    // A replacement list is an address edit: the host that STAYS keeps its own
    // port, the new host falls back to the record-level `port`, and the host
    // that left leaves no entry behind.
    const { status, json } = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['10.0.0.1', '10.0.0.9'] }),
    })

    expect(status).toBe(200)
    expect(json.port).toBe(8765)
    expect(json.ports).toEqual({ '10.0.0.1': 1111, '10.0.0.9': 8765 })
    expect(store.list()[0]!.ports).toEqual({ '10.0.0.1': 1111, '10.0.0.9': 8765 })
  })

  it('does not flatten a mixed-port map when the PATCH repeats the current record port', async () => {
    mount()
    store.upsert(
      record({
        hosts: ['10.0.0.1', '10.0.0.2'],
        port: 8765,
        ports: { '10.0.0.1': 1111, '10.0.0.2': 2222 },
      }),
    )

    // The settings page sends `hosts` AND `port` on every address save. When
    // the port VALUE is unchanged, the edit is a no-op for the map: the staying
    // host keeps its own port and the new host gets the record port — the same
    // rule a hosts-only PATCH follows (asymmetric with #126 would silently
    // flatten a mixed-port record on its first save).
    const { status, json } = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['10.0.0.1', '10.0.0.9'], port: 8765 }),
    })

    expect(status).toBe(200)
    expect(json.port).toBe(8765)
    expect(json.ports).toEqual({ '10.0.0.1': 1111, '10.0.0.9': 8765 })
    expect(store.list()[0]!.ports).toEqual({ '10.0.0.1': 1111, '10.0.0.9': 8765 })
  })

  it('defaults a new host named `constructor` from the record maps, never from Object.prototype', async () => {
    mount()
    // A host called `constructor`/`__proto__` is a legal operator-chosen
    // address; the maps must default it from the record, not inline the Object
    // prototype's own properties. (`??` alone would carry an inherited
    // FUNCTION into the map and the store would reject the edit.)
    store.upsert(
      record({
        hosts: ['10.0.0.1'],
        port: 8765,
        ports: { '10.0.0.1': 1111 },
        security: { '10.0.0.1': 'wss' },
      }),
    )

    const { status, json } = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['constructor'] }),
    })

    expect(status).toBe(200)
    expect(json.hosts).toEqual(['constructor'])
    expect(json.security).toEqual({ constructor: 'ws' })
    expect(json.ports).toEqual({ constructor: 8765 })
    expect(store.list()[0]!.security).toEqual({ constructor: 'ws' })
    expect(store.list()[0]!.ports).toEqual({ constructor: 8765 })
  })

  it('rejects duplicate hosts AFTER IPv6 normalization', async () => {
    mount()
    store.upsert(record())

    // `[::1]` normalizes to the bare `::1`, so this list names ONE host twice.
    // The maps are keyed by host, so a duplicate has no single scheme/port and
    // last-wins is not a contract.
    const { status, json } = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['[::1]', '::1'] }),
    })

    expect(status).toBe(400)
    expect(json.message).toMatch(/hosts must not contain duplicates/)
    expect(store.list()[0]!.hosts).toEqual(['192.168.1.20'])
  })

  it('keeps the scheme of a host that stays in the list, defaults a new one to ws, and drops a removed one', async () => {
    mount()
    // A TLS-proxied desktop: its host dials `wss`.
    store.upsert(
      record({ hosts: ['10.0.0.1', '10.0.0.2'], security: { '10.0.0.1': 'wss', '10.0.0.2': 'wss' } }),
    )

    // Re-typing the SAME host is an address edit, not a scheme edit: a
    // replacement list without it would demote the device to a plain dial it
    // can never complete. The new host defaults to `ws`; the dropped one
    // leaves no entry (the store rejects a map naming a host it does not list).
    const { status, json } = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['10.0.0.1', '10.0.0.9'] }),
    })

    expect(status).toBe(200)
    expect(json.security).toEqual({ '10.0.0.1': 'wss', '10.0.0.9': 'ws' })
    expect(store.list()[0]!.security).toEqual({ '10.0.0.1': 'wss', '10.0.0.9': 'ws' })
  })

  it('keeps a staying host\'s scheme and its OWN port when the PATCH re-types its case', async () => {
    mount()
    // One host is a TLS proxy with its own port. The PATCH face compares hosts
    // case-insensitively everywhere else (the learn merge, forget/remember, the
    // mark clearing), so a NEW SPELLING of a host already in the list is the
    // same address: dropping its scheme turns the next reconnect into a
    // plaintext dial the desktop refuses (issue #189).
    store.upsert(
      record({
        hosts: ['NAS.example', 'nas2.example'],
        security: { 'NAS.example': 'wss', 'nas2.example': 'ws' },
        ports: { 'NAS.example': 4443, 'nas2.example': 8443 },
      }),
    )

    const { status, json } = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['nas.example', 'nas2.example'] }),
    })

    expect(status).toBe(200)
    // The map keys follow the NEW spelling; the VALUES are the remembered ones.
    expect(json.security).toEqual({ 'nas.example': 'wss', 'nas2.example': 'ws' })
    expect(json.ports).toEqual({ 'nas.example': 4443, 'nas2.example': 8443 })
    expect(store.list()[0]!.security).toEqual({ 'nas.example': 'wss', 'nas2.example': 'ws' })
    expect(store.list()[0]!.ports).toEqual({ 'nas.example': 4443, 'nas2.example': 8443 })
  })

  it('an exact spelling wins over a case-insensitive one when a hand-edited archive holds both', async () => {
    mount()
    // The store does not reject two spellings of one host (a hand edit can),
    // so the lookup must prefer the surviving spelling's OWN entry rather than
    // whatever a case-insensitive index happens to hold.
    store.upsert(
      record({
        hosts: ['NAS.example', 'nas.example'],
        security: { 'NAS.example': 'wss', 'nas.example': 'ws' },
        ports: { 'NAS.example': 4443, 'nas.example': 4444 },
      }),
    )

    const { status, json } = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['nas.example'] }),
    })

    expect(status).toBe(200)
    expect(json.security).toEqual({ 'nas.example': 'ws' })
    expect(json.ports).toEqual({ 'nas.example': 4444 })
    // The PERSISTED record, not just the reply: the response is projected from
    // the same `next` object the store just accepted, so only a re-read proves
    // the map that survives is the one the next handshake will dial with.
    expect(store.list()[0]!.security).toEqual({ 'nas.example': 'ws' })
    expect(store.list()[0]!.ports).toEqual({ 'nas.example': 4444 })
  })

  it('a THIRD spelling inherits the FIRST listed spelling when the archive holds two', async () => {
    mount()
    // The collision rule has to be a CONTRACT, not an implementation accident:
    // the exact lookup misses (a third spelling), so the fallback decides, and
    // it takes the first-listed entry — deterministic for a given archive.
    store.upsert(
      record({
        hosts: ['NAS.example', 'nas.example'],
        security: { 'NAS.example': 'wss', 'nas.example': 'ws' },
        ports: { 'NAS.example': 4443, 'nas.example': 4444 },
      }),
    )

    const { status, json } = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['Nas.example'] }),
    })

    expect(status).toBe(200)
    expect(json.security).toEqual({ 'Nas.example': 'wss' })
    expect(json.ports).toEqual({ 'Nas.example': 4443 })
    expect(store.list()[0]!.security).toEqual({ 'Nas.example': 'wss' })
    expect(store.list()[0]!.ports).toEqual({ 'Nas.example': 4443 })
  })

  it('refuses a hosts replacement holding two spellings of one host', async () => {
    mount()
    store.upsert(record())

    // The scheme/port maps are keyed by host, so two spellings of one address
    // have no single entry and last-wins is not a contract — the same rule the
    // IPv6 normalization case applies, now case-insensitively.
    const { status, json } = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['NAS.example', 'nas.example'] }),
    })

    expect(status).toBe(400)
    expect(json.message).toMatch(/hosts must not contain duplicates/)
    expect(store.list()[0]!.hosts).toEqual(['192.168.1.20'])
  })

  it('re-points EVERY final host when port is patched, with or without a hosts replacement', async () => {
    mount()
    store.upsert(
      record({
        hosts: ['10.0.0.1', '10.0.0.2'],
        ports: { '10.0.0.1': 1111, '10.0.0.2': 2222 },
      }),
    )

    // `port` alone: every host moves to it. The PATCH face has ONE port field,
    // so leaving a remembered per-host entry would make the edit inert for
    // every listed host that already had one.
    const portOnly = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ port: 9000 }),
    })
    expect(portOnly.status).toBe(200)
    expect(portOnly.json.port).toBe(9000)
    expect(portOnly.json.ports).toEqual({ '10.0.0.1': 9000, '10.0.0.2': 9000 })
    expect(store.list()[0]!.ports).toEqual({ '10.0.0.1': 9000, '10.0.0.2': 9000 })

    // ...and with a hosts replacement, the FINAL list is what is re-pointed.
    const both = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['10.0.0.1', '10.0.0.9'], port: 9100 }),
    })
    expect(both.status).toBe(200)
    expect(both.json.ports).toEqual({ '10.0.0.1': 9100, '10.0.0.9': 9100 })
    expect(store.list()[0]!.ports).toEqual({ '10.0.0.1': 9100, '10.0.0.9': 9100 })
  })

  it('re-points every host on a combined hosts+port PATCH and rejects malformed input', async () => {
    mount()
    store.upsert(record())

    const ok = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['[::1]', '127.0.0.1'], port: 9000 }),
    })
    expect(ok.status).toBe(200)
    expect(ok.json.hosts).toEqual(['::1', '127.0.0.1'])
    expect(ok.json.port).toBe(9000)
    expect(ok.json.ports).toEqual({ '::1': 9000, '127.0.0.1': 9000 })
    expect(store.list()[0]).toMatchObject({
      hosts: ['::1', '127.0.0.1'],
      port: 9000,
      ports: { '::1': 9000, '127.0.0.1': 9000 },
    })

    const badPort = await call('/devices/dev-1', { method: 'PATCH', body: JSON.stringify({ port: 99_999 }) })
    expect(badPort.status).toBe(400)
    expect(typeof badPort.json.error).toBe('string')

    const badHosts = await call('/devices/dev-1', { method: 'PATCH', body: JSON.stringify({ hosts: [] }) })
    expect(badHosts.status).toBe(400)
    expect(store.list()[0]!.port).toBe(9000)
  })

  it('clears a forget mark only when the PATCH dials that host again', async () => {
    mount()
    store.upsert(record({ forgottenHosts: ['MyNAS.example', '10.0.0.8'] }))

    // A PATCH that does not touch `hosts` keeps every mark: a display name or
    // an enable flag is not an address decision.
    const renamed = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Renamed' }),
    })
    expect(renamed.status).toBe(200)
    expect(renamed.json.forgottenHosts).toEqual(['MyNAS.example', '10.0.0.8'])
    expect(store.list()[0]!.forgottenHosts).toEqual(['MyNAS.example', '10.0.0.8'])

    // Putting an address back into `hosts` is intent to DIAL it, so its mark
    // goes — case-insensitively, because the operator's spelling and the one
    // the archive kept can differ. The mark for a host NOT re-added stays.
    const readded = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ hosts: ['192.168.1.20', 'mynas.example'] }),
    })
    expect(readded.status).toBe(200)
    expect(readded.json.hosts).toEqual(['192.168.1.20', 'mynas.example'])
    expect(readded.json.forgottenHosts).toEqual(['10.0.0.8'])
    expect(store.list()[0]!.forgottenHosts).toEqual(['10.0.0.8'])
  })

  it('evicts the pooled connection on an address change, but not on an unrelated edit', async () => {
    const evicted: string[] = []
    mount({
      evict: (deviceId) => {
        evicted.push(deviceId)
      },
    })
    // A mixed-port fixture: the record-level port and this host's dial port
    // DIFFER, so a rewrite of the map is observable (an equal-value fixture
    // would pass whether or not the map was rewritten).
    store.upsert(record({ hosts: ['10.0.0.1'], port: 1234, ports: { '10.0.0.1': 4321 } }))

    // A rename touches no address: the live connection stays as it is, and the
    // per-host port map is not rewritten either (neither `hosts` nor `port`
    // patched → the maps are unchanged).
    const renamed = await call('/devices/dev-1', { method: 'PATCH', body: JSON.stringify({ displayName: 'Renamed' }) })
    expect(evicted).toEqual([])
    expect(renamed.json.ports).toEqual({ '10.0.0.1': 4321 })
    expect(store.list()[0]!.ports).toEqual({ '10.0.0.1': 4321 })

    await call('/devices/dev-1', { method: 'PATCH', body: JSON.stringify({ hosts: ['10.0.0.1'] }) })
    expect(evicted).toEqual([])

    // A real address change drops the pooled instance so the next dial uses it.
    await call('/devices/dev-1', { method: 'PATCH', body: JSON.stringify({ hosts: ['10.0.0.9'] }) })
    expect(evicted).toEqual(['dev-1'])

    evicted.length = 0
    await call('/devices/dev-1', { method: 'PATCH', body: JSON.stringify({ port: 4321 }) })
    expect(evicted).toEqual(['dev-1'])
  })
})

// ---------------------------------------------------------------------------
// ⑨ forget / remember (issue #204): #185's endpoint maintenance, from the page
// ---------------------------------------------------------------------------

/**
 * #185 made an address able to STAY gone: dropping it from `hosts` is undone by
 * the next handshake (the desktop keeps advertising it and the learn merge
 * re-adds it), so the explicit decision has to be recorded — in
 * `forgottenHosts`, which the merge skips in every case.
 *
 * Until issue #204 that decision was reachable only through the
 * `cherry_devices` tool. The settings page had to open the same door, and the
 * cases below pin the two properties that matter for a SECOND door onto one
 * write: it answers the same projection the PATCH does (so the page's record
 * state is one shape, not two), and it inherits the store's refusals unchanged
 * (last candidate, quarantine) instead of re-implementing them.
 */
describe('⑨ forget / remember addresses', () => {
  it('#204a forget drops one address, records the mark, and evicts the pooled connection', async () => {
    const evicted: string[] = []
    mount({
      evict: (deviceId) => {
        evicted.push(deviceId)
      },
    })
    store.upsert(record({ hosts: ['10.0.0.1', '10.0.0.2'], port: 4343 }))

    const { status, json } = await call('/devices/dev-1/forget', {
      method: 'POST',
      body: JSON.stringify({ hosts: ['10.0.0.2'] }),
    })
    expect(status).toBe(200)
    // The SAME flat projection `PATCH /devices/:id` answers — not a `{device}`
    // envelope: the page hands the body straight to its own record state, and a
    // second shape would be a second thing to keep in step.
    expect(Object.keys(json).sort()).toEqual(
      [
        'deviceId',
        'displayName',
        'enabled',
        'forgottenHosts',
        'hosts',
        'port',
        'ports',
        'security',
        'state',
      ].sort(),
    )
    expect(json.hosts).toEqual(['10.0.0.1'])
    expect(json.forgottenHosts).toEqual(['10.0.0.2'])
    // The host-keyed maps are rewritten as one unit with `hosts` (the store's
    // own contract); leaving the forgotten entry behind would make the record
    // undialable AND unreachable by any later PATCH.
    expect(json.ports).toEqual({ '10.0.0.1': 4343 })
    expect(json.security).toEqual({ '10.0.0.1': 'ws' })
    expect(json).not.toHaveProperty('accessToken')

    // The store, not just the echo of the request.
    const listed = await call('/devices')
    expect(listed.json[0].hosts).toEqual(['10.0.0.1'])
    expect(listed.json[0].forgottenHosts).toEqual(['10.0.0.2'])

    // ADDRESS MAINTENANCE reaches the live connection, exactly like a PATCH's:
    // a pooled `DeviceConnection` captured the record it was built from.
    expect(evicted).toEqual(['dev-1'])

    // A call that changes no byte neither rewrites nor drops the socket: the
    // host is already forgotten, so `forgetEndpoints` returns two empty lists.
    const again = await call('/devices/dev-1/forget', {
      method: 'POST',
      body: JSON.stringify({ hosts: ['10.0.0.2'] }),
    })
    expect(again.status).toBe(200)
    expect(again.json.forgottenHosts).toEqual(['10.0.0.2'])
    expect(evicted).toEqual(['dev-1'])
  })

  it("#204b forgetting the LAST candidate answers the tool's own last-address refusal and writes nothing", async () => {
    const evicted: string[] = []
    mount({
      evict: (deviceId) => {
        evicted.push(deviceId)
      },
    })
    store.upsert(record({ hosts: ['10.0.0.1'], port: 4343, forgottenHosts: ['10.9.9.9'] }))

    const refused = await call('/devices/dev-1/forget', {
      method: 'POST',
      body: JSON.stringify({ hosts: ['10.0.0.1'] }),
    })
    expect(refused.status).toBe(400)
    // The SAME code the tool answers (`{error: 'last-address'}`): one refusal
    // vocabulary across the two doors, so the page can translate it by code.
    expect(refused.json.error).toBe('last-address')
    expect(refused.json.message).toMatch(/last dial candidate/i)
    // POSITION: the throw happens before any write, so neither half moved.
    expect(store.list()[0]!.hosts).toEqual(['10.0.0.1'])
    expect(store.list()[0]!.forgottenHosts).toEqual(['10.9.9.9'])
    expect(evicted).toEqual([])
    expect(refused.res.body).not.toContain('super-secret-token')
  })

  it('#204c remember lifts the mark WITHOUT touching hosts, and a mark-less call is a no-op', async () => {
    const evicted: string[] = []
    mount({
      evict: (deviceId) => {
        evicted.push(deviceId)
      },
    })
    store.upsert(record({ hosts: ['10.0.0.1'], port: 4343, forgottenHosts: ['10.0.0.2', '10.9.9.9'] }))

    const restored = await call('/devices/dev-1/remember', {
      method: 'POST',
      body: JSON.stringify({ hosts: ['10.0.0.2'] }),
    })
    expect(restored.status).toBe(200)
    expect(restored.json.forgottenHosts).toEqual(['10.9.9.9'])
    // Remembering is NOT dialing: the host list is untouched, and the address
    // returns only when the desktop next advertises it (through the ordinary
    // learn merge). A PATCH that names it is the way to dial it immediately.
    expect(restored.json.hosts).toEqual(['10.0.0.1'])
    expect(evicted).toEqual(['dev-1'])

    // Nothing left to lift: no write, no eviction — but still a 200 with the
    // current record, because "already true" is an answer, not a failure.
    const noop = await call('/devices/dev-1/remember', {
      method: 'POST',
      body: JSON.stringify({ hosts: ['10.0.0.2'] }),
    })
    expect(noop.status).toBe(200)
    expect(noop.json.forgottenHosts).toEqual(['10.9.9.9'])
    expect(evicted).toEqual(['dev-1'])
  })

  it('#204d an IPv6 literal arrives bracketed and every malformed door answers a structured verdict', async () => {
    mount()
    store.upsert(record({ hosts: ['::1', '10.0.0.1'], port: 4343 }))

    // A browser copy-pastes an IPv6 literal WITH brackets; the archive stores
    // it bare. Reusing the PATCH's `normalizeHost` is what makes the two doors
    // agree on the same spelling — the store matches case-insensitively but
    // would treat `[::1]` as a host it never dialed.
    const bracketed = await call('/devices/dev-1/forget', {
      method: 'POST',
      body: JSON.stringify({ hosts: ['[::1]'] }),
    })
    expect(bracketed.status).toBe(200)
    expect(bracketed.json.hosts).toEqual(['10.0.0.1'])
    expect(bracketed.json.forgottenHosts).toEqual(['::1'])

    for (const body of ['{}', '{"hosts":[]}', '{"hosts":"10.0.0.1"}', '{"hosts":[42]}', 'not json']) {
      const bad = await call('/devices/dev-1/forget', { method: 'POST', body })
      expect(bad.status).toBe(400)
      expect(bad.json.error).toBe('invalid-request')
    }
    // None of those touched the archive.
    expect(store.list()[0]!.hosts).toEqual(['10.0.0.1'])
    expect(store.list()[0]!.forgottenHosts).toEqual(['::1'])

    const unknown = await call('/devices/nope/remember', {
      method: 'POST',
      body: JSON.stringify({ hosts: ['10.0.0.2'] }),
    })
    expect(unknown.status).toBe(404)
    expect(unknown.json.error).toBe('not-found')

    // The method verdict, and the one that must NOT become one: a third
    // segment that names no action is an unknown route.
    expect((await call('/devices/dev-1/forget')).json.error).toBe('method-not-allowed')
    expect((await call('/devices/dev-1/forget')).status).toBe(405)
    const other = await call('/devices/dev-1/explode', { method: 'POST', body: '{}' })
    expect(other.status).toBe(404)
    expect(other.json.error).toBe('not-found')
  })

  /**
   * A STUB store, and the case is named for what that can actually show.
   *
   * A genuinely quarantined archive serves an EMPTY view (`DeviceStore.#load`),
   * so the `list()` at the top of the route answers 404 `not-found` and neither
   * write — nor this mapping — is ever reached. The route therefore keeps the
   * arm as the same defence PATCH and DELETE carry (a store that begins
   * refusing after that read must not be reported as a bad request), and this
   * case pins the MAPPING with a collaborator that can throw — once per action,
   * because the two arms are different calls into the store (`#204n` below
   * pins the precedence a REAL damaged archive actually produces).
   */
  it('#204e both actions map a write refusal onto the PATCH 503 shape (stub store: a real quarantine answers 404 first)', async () => {
    const refusal = (): never => {
      throw new QuarantinedArchiveError('/data/devices.json', new Error('bad json'), '/data/devices.json.corrupt')
    }
    mount({
      store: {
        list: () => [record()],
        resolve: () => record(),
        forgetEndpoints: refusal,
        rememberEndpoints: refusal,
      } as never,
    })

    for (const action of ['forget', 'remember']) {
      const { status, json } = await call(`/devices/dev-1/${action}`, {
        method: 'POST',
        body: JSON.stringify({ hosts: ['10.0.0.2'] }),
      })
      expect(status).toBe(503)
      expect(json.error).toBe('archive-quarantined')
      expect(json.corrupt).toBe('/data/devices.json.corrupt')
      expect(json.recovery).toMatch(/move it aside|restart/i)
    }
  })

  /**
   * The PRECEDENCE a real damaged archive produces, with the real store.
   *
   * `#204e` can only pin the mapping (its collaborator throws on call); the
   * shipped store never gets that far — `#load` turns a quarantined archive
   * into an EMPTY view, so the route's first `list()` misses and the answer is
   * 404 `not-found`. That is the same precedence PATCH and DELETE have, and it
   * is why the page cannot offer the action on a damaged archive at all (the
   * card list is empty). Named so nobody reads the 503 arm as the observable.
   */
  it('#204n a REAL quarantined archive answers 404 before any write', async () => {
    const file = join(dataDir, 'devices.json')
    writeFileSync(file, '{ this is not json', 'utf8')
    const poisoned = new DeviceStore(file)
    // Prime the quarantine exactly as the FIRST read does on a live host.
    expect(poisoned.list()).toEqual([])
    mount({ store: poisoned })

    for (const action of ['forget', 'remember']) {
      const { status, json } = await call(`/devices/dev-1/${action}`, {
        method: 'POST',
        body: JSON.stringify({ hosts: ['10.0.0.2'] }),
      })
      expect(status).toBe(404)
      expect(json.error).toBe('not-found')
    }
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

  /**
   * Bounded log text for the re-enable lifecycle rejection (issue #161). The
   * old form passed the error OBJECT as `console.warn`'s second argument, so
   * the console chose the rendering: the name, message and stack, unbounded.
   */
  function boundedWarnCall(prefix: string, longMessage: string) {
    const warn = vi.mocked(console.warn)
    const call = warn.mock.calls.find((entry) => String(entry[0]).startsWith(prefix))
    expect(call, `the warning "${prefix}" must be logged`).toBeDefined()
    // ONE STRING: the second argument is what let the console render an object.
    expect(call!).toHaveLength(1)
    const line = String(call![0])
    expect(line.length).toBeLessThanOrEqual(prefix.length + LOG_TEXT_MAX)
    expect(line).toMatch(/… \(\+\d+ chars\)$/)
    const detail = line.slice(prefix.length)
    const kept = detail.indexOf('…')
    expect(kept).toBeGreaterThan(0)
    expect(kept + detail.slice(kept).length).toBe(LOG_TEXT_MAX)
    expect(detail).toBe('r'.repeat(kept) + `… (+${longMessage.length - kept} chars)`)
    expect(line).not.toContain(longMessage)
    return line
  }

  it('⑤a renders the REJECTED reconnect as ONE bounded string (#161)', async () => {
    const longMessage = 'r'.repeat(3_000)
    // This is the arm that carries peer text: `connect()` rejects with the
    // establishment failure, whose message embeds the last per-host error
    // (`AllHostsUnreachableError` wraps `last: <message>`).
    const dev = fakeConnection('offline')
    const rejecting = { ...dev, connect: () => Promise.reject(new Error(longMessage)) }
    mount({ connect: () => rejecting as never })
    store.upsert(record({ enabled: false }))

    const res = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(200)
    const prefix = '[cherry-remote] device dev-1 lifecycle change failed: '
    await vi.waitFor(
      () => {
        expect(
          vi.mocked(console.warn).mock.calls.some((entry) => String(entry[0]).startsWith(prefix)),
        ).toBe(true)
      },
      2_000,
    )
    boundedWarnCall(prefix, longMessage)
  })
})

// ---------------------------------------------------------------------------
// ⑦ GET /diagnostics: NEVER dials, reports only what a live connection knows
// ---------------------------------------------------------------------------

describe('⑦ diagnostics is a read, not a dial', () => {
  /** A pool with the two seams the assembly exposes: `detach` looks up ONLY. */
  function pool() {
    const connections = new Map<
      string,
      ReturnType<typeof fakeConnection> & { limits?: { heartbeatMs: number; subscriptions: number; pageItems: number; inFlightRequests: number } }
    >()
    const dialed: string[] = []
    const lookedUp: string[] = []
    return {
      connections,
      dialed,
      lookedUp,
      deps: {
        // The create-on-miss seam. Diagnostics must NEVER reach it.
        connect: (deviceId: string) => {
          dialed.push(deviceId)
          const existing = connections.get(deviceId)
          if (existing !== undefined) return existing as never
          const created = fakeConnection('offline')
          connections.set(deviceId, created)
          return created as never
        },
        // The resolve-existing seam: a pure lookup, no construction.
        detach: (deviceId: string) => {
          lookedUp.push(deviceId)
          return connections.get(deviceId) as never
        },
      },
    }
  }

  it('reports NO limits for a device with no live connection and creates zero sockets', async () => {
    const rig = pool()
    // The record exists in the archive, but the pool is EMPTY: this device has
    // never been reached by any other route.
    mount(rig.deps)

    const { status, json } = await call('/diagnostics')

    expect(status).toBe(200)
    expect(json.devices).toHaveLength(0)

    store.upsert(record())
    const second = await call('/diagnostics')
    expect(second.status).toBe(200)
    expect(second.json.devices).toHaveLength(1)
    // The state comes from the store/enabled projection — honest "offline".
    expect(second.json.devices[0]).toMatchObject({ deviceId: 'dev-1', state: 'offline', enabled: true })
    // NO limits: there is no hello to have negotiated them, and fabricating the
    // client's conservative fallbacks would report them as if they were agreed.
    expect(second.json.devices[0]).not.toHaveProperty('limits')

    // THE LOAD-BEARING ASSERTION: diagnostics never dialed. A create-on-miss
    // seam here would have opened a socket to an offline device just because an
    // operator asked for a health report.
    expect(rig.dialed).toEqual([])
    expect(rig.lookedUp).toEqual(['dev-1'])
  })

  it('reports the negotiated limits when a live connection exists, still without dialing', async () => {
    const rig = pool()
    const live = {
      ...fakeConnection('connected'),
      limits: { heartbeatMs: 15_000, subscriptions: 4, pageItems: 50, inFlightRequests: 3 },
    }
    rig.connections.set('dev-1', live)
    mount(rig.deps)
    store.upsert(record())

    const { status, json } = await call('/diagnostics')

    expect(status).toBe(200)
    expect(json.devices[0]).toMatchObject({
      deviceId: 'dev-1',
      state: 'connected',
      limits: { heartbeatMs: 15_000, subscriptions: 4, pageItems: 50, inFlightRequests: 3 },
    })
    // Still no dial: the live entry was RESOLVED, never built.
    expect(rig.dialed).toEqual([])
  })

  it('a device that cannot be resolved at all is still reported as offline, never as a failure', async () => {
    mount({
      connect: () => {
        throw new Error('the pool refuses to build this one')
      },
      detach: () => undefined,
    })
    store.upsert(record())

    const { status, json } = await call('/diagnostics')
    expect(status).toBe(200)
    expect(json.devices[0]).toMatchObject({ deviceId: 'dev-1', state: 'offline' })
    expect(json.devices[0]).not.toHaveProperty('limits')
  })

  it('reports a REAL cursor for a subscribed session, and none when the layer has not moved', async () => {
    mount({
      diagnosticsSessions: () => [
        // The assembly's projection: the subscription layer's own state.
        {
          deviceId: 'dev-1',
          sessionId: 's-cursor',
          subscriptions: 1,
          cursor: { sessionId: 's-cursor', streamEpoch: 'epoch-1', seq: '7' },
        },
        { deviceId: 'dev-1', sessionId: 's-fresh', subscriptions: 1 },
      ],
    })

    const { status, json } = await call('/diagnostics')
    expect(status).toBe(200)
    const sessions = json.sessions as Array<{ sessionId: string; cursor?: { seq: string } }>
    expect(sessions.find((entry) => entry.sessionId === 's-cursor')!.cursor).toEqual({
      sessionId: 's-cursor',
      streamEpoch: 'epoch-1',
      seq: '7',
    })
    // A session with no reported cursor simply has no `cursor` field — the
    // field is emitted when the layer HAS one, never invented as seq 0.
    expect(sessions.find((entry) => entry.sessionId === 's-fresh')!).not.toHaveProperty('cursor')
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
      scope: new ToolScopeState({ file: join(dataDir, 'scope.json') }),
      refreshScope: () => undefined,
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
    // Issue #7: `webServer` ALONE. Asking for `webRuntime` as well was an AND
    // gate — 0.2.1 removed that service, so the callback never ran, nothing was
    // mounted and not even the degradation warnings below could print.
    expect(ctx.injected).toEqual([['webServer']])
    expect(ctx.server.routes.has(PREFIX)).toBe(true)
    // The host's `register` disposer is what the returned teardown drives.
    expect(typeof dispose).toBe('function')
    dispose?.()
    dispose = undefined
    expect(ctx.server.unregistered).toEqual([PREFIX])
  })

  // -------------------------------------------------------------------------
  // Issue #7: the host-generation matrix for `trustedHosts`. 0.2.1-rc.2
  // removed the `webRuntime` service (its `trustedHosts` moved to the
  // `webStartup` service config), so the fence's source list is an optional
  // `ctx.get` chain and every step must be exercised against the REAL fence.
  //
  // Every case runs over the STRICT injected ctx (`strictWctx`): reading a key
  // the callback did not inject throws exactly as real cordis does. These cases
  // going green is therefore also the strictness assertion — a callback that
  // went back to reading `wctx.webRuntime` would throw here, the mount would be
  // skipped, and the fence assertions below would fail (403/404 instead of 200).
  // -------------------------------------------------------------------------

  /** The deps `mount()` builds, for the host-shape cases that own their ctx. */
  function shapeDeps(): CherryHttpDeps {
    return {
      store: new DeviceStore(join(dataDir, 'devices.json')),
      scope: new ToolScopeState({ file: join(dataDir, 'scope.json') }),
      refreshScope: () => undefined,
      pair: (opts) => pairImpl(opts),
      identity: () => new Uint8Array([1]),
      connect: () => fakeConnection() as never,
      onDeviceState: () => {},
      onPairingProgress: () => {},
    }
  }

  /** Registers over an EXPLICIT fake ctx (the `mount()` fixture owns a hybrid one). */
  function mountOn(options: { shape: HostShape; trustedHosts?: string[]; host?: string }): FakeCtx {
    const fake = makeCtx(options)
    dispose = registerHttpApi(fake as unknown as CherryHttpContext, shapeDeps())
    return fake
  }

  /** Dispatches one REST read through the fake host's prefix table. */
  async function statusFor(fake: FakeCtx, host: string): Promise<number> {
    const res = new FakeResponse()
    await fake.server.dispatch(new FakeRequest(`${PREFIX}/devices`, { host }), res)
    return res.status
  }

  it('#7 0.2.1 shape: webServer alone is injected; webStartup trustedHosts AND its LAN bind are admitted', async () => {
    // A LAN-bound deployment (`--host 10.6.0.4`) that never passed
    // `--trusted-host`: `webStartup.host` is the listener bind the host's own
    // /api fence admits implicitly, so the plugin's fence must admit the very
    // same self-origin — otherwise the settings page 403s against itself.
    const fake = mountOn({
      shape: 'webserver-only',
      trustedHosts: ['harness.internal:23023'],
      host: '10.6.0.4',
    })

    // Strictness: the injected ctx carried a real strict proxy; the mount ran,
    // so the callback read NOTHING outside its `['webServer']` list (a
    // `wctx.webRuntime` regression would have thrown here, not mounted, and
    // every fence assertion below would read 404).
    expect(fake.injected).toEqual([['webServer']])
    expect(fake.server.routes.has(PREFIX)).toBe(true)
    // The declared authority is admitted…
    expect(await statusFor(fake, 'harness.internal:23023')).toBe(200)
    // …the LAN bind is admitted as a BARE entry: any port on that hostname.
    expect(await statusFor(fake, '10.6.0.4:23023')).toBe(200)
    expect(await statusFor(fake, '10.6.0.4:8080')).toBe(200)
    // An unrelated LAN host stays refused.
    expect(await statusFor(fake, '10.6.0.5:23023')).toBe(403)
    expect(await statusFor(fake, 'evil.example.com')).toBe(403)
    // Loopback is inherent, not configuration.
    expect(await statusFor(fake, HOST)).toBe(200)
  })

  it('#9 an IPv6 listener bind is folded in as a PARSEABLE (bracketed) authority', async () => {
    // `--host fe80::1` arrives as a BARE hostname in `webStartup.host`, while
    // the fence's entries are AUTHORITIES: `parseAuthority` runs
    // `new URL('http://' + entry)`, and an IPv6 literal must be bracketed there
    // (`new URL('http://fe80::1')` throws). Before this, an IPv6 LAN bind folded
    // in an entry the fence could never parse, so it contributed NOTHING and the
    // deployment kept only loopback — fail-closed (no security hole), but a real
    // availability gap for a browser on the LAN.
    const fake = mountOn({ shape: 'webserver-only', host: 'fe80::1' })
    // What the browser actually sends: the WHATWG serialization KEEPS the
    // brackets, and `isLoopbackHostname` documents the same fact.
    expect(await statusFor(fake, '[fe80::1]:23023')).toBe(200)
    // The BARE spelling is not an authority: it stays refused, so this is a
    // normalization of OUR entry, not a relaxation of the fence.
    expect(await statusFor(fake, 'fe80::1:23023')).toBe(403)
    // One entry, bracketed ONCE, and nothing else was added.
    expect(resolveTrustedHosts(fake as unknown as CherryHttpContext)).toEqual(['[fe80::1]'])

    // An already-bracketed bind is not double-bracketed (a hand-written
    // `--host [fe80::2]` would otherwise become `[[fe80::2]]` and parse to
    // nothing, re-creating the gap it was meant to close).
    const bracketed = mountOn({ shape: 'webserver-only', host: '[fe80::2]' })
    expect(resolveTrustedHosts(bracketed as unknown as CherryHttpContext)).toEqual(['[fe80::2]'])
    expect(await statusFor(bracketed, '[fe80::2]:23023')).toBe(200)
  })

  it('#7 0.2.0 wins: get("webRuntime") answers before get("webStartup") is ever consulted', async () => {
    // Both generations offered at once behind `ctx.get`: the 0.2.0 service is
    // the host's own bind-dependent value, so it must win — and the newer
    // service must not even be consulted.
    const fake = makeCtx()
    const seenGets: string[] = []
    const shadowed = {
      ...fake,
      get(name: string): unknown {
        seenGets.push(name)
        if (name === 'webRuntime') return fake.get('webRuntime')
        return { trustedHosts: ['shadowed.example.com:1'], host: 'shadowed-lan.example.com' }
      },
    }
    dispose = registerHttpApi(shadowed as unknown as CherryHttpContext, shapeDeps())

    expect(await statusFor(fake, HOST)).toBe(200)
    expect(await statusFor(fake, 'shadowed.example.com:1')).toBe(403)
    expect(await statusFor(fake, 'shadowed-lan.example.com:23023')).toBe(403)
    // The `webRuntime` source answered, so `webStartup` was never asked for.
    expect(seenGets).toEqual(['webRuntime'])
  })

  it('#7 neither service: mounts anyway and the fence stays loopback-only', async () => {
    const fake = mountOn({ shape: 'bare' })

    expect(fake.injected).toEqual([['webServer']])
    expect(fake.server.routes.has(PREFIX)).toBe(true)
    expect(await statusFor(fake, HOST)).toBe(200)
    expect(await statusFor(fake, 'harness.internal:23023')).toBe(403)
    expect(await statusFor(fake, '10.6.0.4:23023')).toBe(403)
  })

  it('R9: dispose detaches the assembly listeners it registered', async () => {
    // The assembly channels are sets that OUTLIVE one hub: they live on the
    // module-level state, so a hub that registers without ever detaching leaves
    // its callbacks — closing over the DEAD hub — in the set forever. Every
    // re-apply then adds two more, and a later event fans out to all of them.
    // The fake honours the channel's detacher exactly as `index.ts` does.
    const deviceListeners = new Set<(event: unknown) => void>()
    const pairingListeners = new Set<(event: unknown) => void>()
    const channel = (set: Set<(event: unknown) => void>) => (cb: unknown) => {
      const listener = cb as (event: unknown) => void
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    }
    mount({
      onDeviceState: channel(deviceListeners) as never,
      onPairingProgress: channel(pairingListeners) as never,
    })
    expect(deviceListeners.size).toBe(1)
    expect(pairingListeners.size).toBe(1)

    dispose?.()
    dispose = undefined

    expect(deviceListeners.size).toBe(0)
    expect(pairingListeners.size).toBe(0)
  })

  it('R5: DELETE drops the pool entry instead of leaving a closed connection behind', async () => {
    // A REAL pool map, exactly like the assembly's `state.connections`: the two
    // seams resolve it the way `index.ts` does — `detach` only LOOKS UP,
    // `evict` REMOVES (and closes) — so leaving the eviction out leaves a closed
    // DeviceConnection (still holding the record's accessToken) in the map.
    const pool = new Map<string, ReturnType<typeof fakeConnection>>([['dev-1', fakeConnection('connected')]])
    mount({
      detach: (deviceId) => pool.get(deviceId) as never,
      evict: (deviceId) => {
        pool.delete(deviceId)
      },
    })
    store.upsert(record())

    const { status } = await call('/devices/dev-1', { method: 'DELETE' })

    expect(status).toBe(204)
    // The record is gone AND nothing is left pooling it.
    expect(store.list()).toHaveLength(0)
    expect([...pool.keys()]).toEqual([])
  })

  it('R5b: DELETE evicts the connection BEFORE removing the archive entry', async () => {
    // ORDER, not just occurrence. `cherry_unpair` documents this invariant and
    // this route must match it: the other order leaves a window in which the
    // record is gone but a socket still authenticated with the token it held is
    // not. The window is invisible in the final state, so it is asserted by
    // observing the archive AT THE MOMENT of eviction.
    const observed: Array<{ when: string; devices: string[] }> = []
    mount({
      evict: () => {
        observed.push({ when: 'evict', devices: store.list().map((entry) => entry.deviceId) })
      },
      detach: () => undefined,
    })
    store.upsert(record())

    const { status } = await call('/devices/dev-1', { method: 'DELETE' })

    expect(status).toBe(204)
    // At eviction time the record was STILL in the archive: the socket is torn
    // down first, and only then is the record (and its token) discarded.
    expect(observed).toEqual([{ when: 'evict', devices: ['dev-1'] }])
    expect(store.list()).toHaveLength(0)
  })

  it('F2-6a DELETE AWAITS an asynchronous eviction before removing the record', async () => {
    // R5b pins the ORDER of the two steps. This pins the other half of the same
    // invariant: that the first step has genuinely FINISHED. The assembly's
    // eviction is asynchronous — it releases the peer subscriptions over the
    // still-live socket, then closes the connection — so a route that fires it
    // and moves on leaves `store.remove` landing mid-teardown, with the record
    // (and its token) gone while the socket is still up.
    const observed: string[] = []
    mount({
      evict: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
        observed.push('evict-complete')
      },
      detach: () => undefined,
    })
    store.upsert(record())

    const { status } = await call('/devices/dev-1', { method: 'DELETE' })

    expect(status).toBe(204)
    // The eviction had completed BY THE TIME THE RESPONSE WENT OUT, and the
    // record is gone after it — never the other way round.
    expect(observed).toEqual(['evict-complete'])
    expect(store.list()).toHaveLength(0)
  })

})

// ---------------------------------------------------------------------------
// ⑧ a QUARANTINED archive: every persisting route answers structurally
// ---------------------------------------------------------------------------

describe('⑧ quarantined archive', () => {
  /**
   * Builds a store over a deliberately unparsable archive, exactly as an
   * operator's damaged `devices.json` would look. The FIRST read quarantines it
   * (copying the bytes to `<file>.corrupt`) and poisons every later write.
   */
  function quarantinedStore(): { store: DeviceStore; file: string } {
    const file = join(dataDir, 'devices.json')
    writeFileSync(file, '{ this is not json', 'utf8')
    const store = new DeviceStore(file)
    // Prime the quarantine: `list` reads the archive and degrades to empty.
    expect(store.list()).toEqual([])
    return { store, file }
  }

  it('the REAL store really does quarantine and refuse to write (the premise)', () => {
    // The premise the route mapping exists for, asserted on the real store: a
    // damaged archive is preserved, served empty, and every write refuses —
    // rather than being silently overwritten and losing every pairing.
    const { store: poisoned, file } = quarantinedStore()

    expect(existsSync(`${file}.corrupt`)).toBe(true)
    expect(() => poisoned.upsert(record())).toThrow(QuarantinedArchiveError)
  })

  it('maps QuarantinedArchiveError to a structured 5xx naming the recovery, never a bare throw', async () => {
    mount({
      store: {
        list: () => [record()],
        resolve: () => record(),
        remove: () => {
          throw new QuarantinedArchiveError('/data/devices.json', new Error('bad json'), '/data/devices.json.corrupt')
        },
        upsert: () => {
          throw new QuarantinedArchiveError('/data/devices.json', new Error('bad json'), '/data/devices.json.corrupt')
        },
      } as never,
    })

    // PATCH persists through `upsert`.
    const patched = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Renamed' }),
    })
    expect(patched.status).toBe(503)
    expect(patched.json.error).toBe('archive-quarantined')
    expect(patched.json.file).toBe('/data/devices.json')
    expect(patched.json.corrupt).toBe('/data/devices.json.corrupt')
    expect(patched.json.recovery).toMatch(/move it aside|restart/i)
    expect(patched.json.message).toMatch(/READ-ONLY|unreadable/i)

    // DELETE persists through `remove`.
    const deleted = await call('/devices/dev-1', { method: 'DELETE' })
    expect(deleted.status).toBe(503)
    expect(deleted.json.error).toBe('archive-quarantined')
  })

  it('never leaks the raw error or a credential through the refusal', async () => {
    mount({
      store: {
        list: () => [record()],
        resolve: () => record(),
        remove: () => {
          throw new QuarantinedArchiveError('/data/devices.json', new Error('bad json'))
        },
        upsert: () => {
          throw new QuarantinedArchiveError('/data/devices.json', new Error('bad json'))
        },
      } as never,
    })

    const { json, res } = await call('/devices/dev-1', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Renamed' }),
    })
    expect(json.error).toBe('archive-quarantined')
    // The corrupt path falls back to `<file>.corrupt` when the copy failed, so
    // the operator is never sent to a file that does not exist.
    expect(json.corrupt).toBe('/data/devices.json.corrupt')
    expect(res.body).not.toContain('super-secret-token')
    expect(res.body).not.toContain('accessToken')
  })

  it('a pairing that cannot PERSIST its record ends on its own structured stage', async () => {
    // Pairing's last step is the write. With a READ-ONLY archive the run fails
    // there, after the peer has already approved — so the verdict has to reach
    // the browser on the progress stream, and it must say what to do.
    mount({
      pair: async () => {
        throw new QuarantinedArchiveError(
          '/data/devices.json',
          new Error('bad json'),
          '/data/devices.json.corrupt',
        )
      },
    })

    const res = new FakeResponse()
    await ctx.server.dispatch(new FakeRequest(`${PREFIX}/events`, { host: HOST }), res)

    const { status, json } = await call('/pair', {
      method: 'POST',
      body: JSON.stringify({ payload: '{"v":2}' }),
    })
    expect(status).toBe(202)
    expect(json.claimId).toBeDefined()

    await vi.waitFor(() => {
      expect(res.events<{ stage: string }>('pairing-progress')).toHaveLength(1)
    })
    const [frame] = res.events<{ stage: string; detail?: string; claimId?: string }>('pairing-progress')
    expect(frame!.stage).toBe('archive-quarantined')
    expect(frame!.claimId).toBe(json.claimId)
    // Not the generic `pairing-failed`: the detail names the file to move.
    expect(frame!.detail).toContain('/data/devices.json')
    expect(frame!.detail).toContain('.corrupt')
    expect(frame!.detail).toMatch(/move|aside/i)
  })
})

// ---------------------------------------------------------------------------
// The real plugin assembly (index.ts apply): minimal M2 wiring
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ⑩ the experiment's document (#233)
// ---------------------------------------------------------------------------

/**
 * The switch is only a switch if it PERSISTS and its effect is stated honestly.
 * The subsystem mounts once per apply (`#231`), so a save cannot re-register the
 * provider; the route says whether a restart is still owed instead of pretending
 * `status` changed. These cases pin the transport, the lock and that one word.
 */
describe('⑩ the experiment’s document (#233)', () => {
  const ENABLED = { enabled: true, device: 'desk-1', agentId: 'agent-7', workspaceId: 'ws-1' }

  /** The deps slice the two routes need, over a REAL document in the test's dataDir. */
  function experiment(options: { seed?: unknown; running?: SubagentConfigResolution } = {}): NonNullable<
    CherryHttpDeps['subagent']
  > {
    return {
      document: createSubagentConfigDocument({ file: join(dataDir, 'subagent.json'), seed: options.seed }),
      running: () => options.running,
      status: (): SubagentSubsystemStatus => ({ state: 'pending', reason: { code: 'disabled' } }),
      // The document routes never read the candidate seam; ⑪ supplies its own.
      targets: () => Promise.reject(new Error('the document routes do not list targets')),
    }
  }

  it('⑩a GET answers the document, its source and the running verdict', async () => {
    mount({ subagent: experiment() })
    const { status, json } = await call('/subagent')
    expect(status).toBe(200)
    // One whole-object comparison: the page has ONE shape to render, and an
    // extra field here is an extra field the page would silently ignore.
    expect(json).toEqual({
      subagent: { revision: 0 },
      source: 'config',
      status: { state: 'pending', reason: { code: 'disabled' } },
      pendingRestart: false,
    })
  })

  it('⑩b PUT stores the document, bumps the revision, and the GET reads it back', async () => {
    mount({ subagent: experiment() })
    const saved = await call('/subagent', {
      method: 'PUT',
      body: JSON.stringify({ ...ENABLED, expectedRevision: 0 }),
    })
    expect(saved.status).toBe(200)
    // `expectedRevision` is the LOCK and must not land in the document: it is
    // not a config field, and a page that read it back would echo it forever.
    expect(saved.json.subagent).toEqual({ ...ENABLED, revision: 1 })
    expect(saved.json.source).toBe('file')

    const reread = await call('/subagent')
    expect(reread.json.subagent).toEqual({ ...ENABLED, revision: 1 })
    expect(JSON.parse(readFileSync(join(dataDir, 'subagent.json'), 'utf8'))).toEqual({
      ...ENABLED,
      revision: 1,
    })

    // A SECOND save quoting the revision the first one returned must succeed. A
    // route that dropped the caller's baseline (or pinned it to 0) would refuse
    // every save after the first — the switch would be stuck at whatever the
    // first save wrote, and no assertion above would notice.
    const second = await call('/subagent', {
      method: 'PUT',
      body: JSON.stringify({ enabled: false, expectedRevision: reread.json.subagent.revision }),
    })
    expect(second.status).toBe(200)
    expect(second.json.subagent).toEqual({ enabled: false, revision: 2 })
  })

  it('⑩c a stale baseline is a 409 and the document does not move', async () => {
    mount({ subagent: experiment() })
    await call('/subagent', { method: 'PUT', body: JSON.stringify({ ...ENABLED, expectedRevision: 0 }) })
    const stale = await call('/subagent', {
      method: 'PUT',
      body: JSON.stringify({ enabled: false, expectedRevision: 0 }),
    })
    expect(stale.status).toBe(409)
    expect(stale.json.error).toBe('subagent-revision-conflict')
    expect(stale.json.message).toContain('revision=1')
    const reread = await call('/subagent')
    expect(reread.json.subagent).toEqual({ ...ENABLED, revision: 1 })
  })

  it('⑩d `pendingRestart` follows the DIFFERENCE between saved and running', async () => {
    // Saved `enabled: true`, running `disabled`: the save has not taken effect.
    mount({ subagent: experiment({ running: { kind: 'disabled' } }) })
    const saved = await call('/subagent', {
      method: 'PUT',
      body: JSON.stringify({ ...ENABLED, expectedRevision: 0 }),
    })
    expect(saved.json.pendingRestart).toBe(true)
    // The running VERDICT is unchanged by a save — that is the honesty the flag
    // exists for: it must not look applied.
    expect(saved.json.status).toEqual({ state: 'pending', reason: { code: 'disabled' } })

    // The same document, already resolved by the assembly: nothing is owed. A
    // page that always said "restart to apply" would be wrong exactly here.
    mount({ subagent: experiment({ running: resolveSubagentConfig({ ...ENABLED, revision: 1 }) }) })
    const applied = await call('/subagent')
    expect(applied.json.pendingRestart).toBe(false)
  })

  it('⑩e an assembly with no experiment 404s, and a refused method never touches the document', async () => {
    mount()
    expect((await call('/subagent')).status).toBe(404)

    mount({ subagent: experiment() })
    expect((await call('/subagent', { method: 'DELETE' })).status).toBe(405)
    // A body that is not a JSON object is the body-level refusal, not a config
    // verdict: it must not wear a field's code.
    const bad = await call('/subagent', { method: 'PUT', body: JSON.stringify([ENABLED]) })
    expect(bad.status).toBe(400)
    expect(bad.json.error).toBe('invalid-request')
    expect(existsSync(join(dataDir, 'subagent.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ⑪ the settings page's candidate source (#260)
// ---------------------------------------------------------------------------

/**
 * `GET /subagent/targets` is the dropdown's data source: the agents on a
 * device, plus an agent's workspaces. Its whole point is that a device which
 * cannot answer is NOT a broken page — every failure is `200` with a `problem`
 * the form renders as "candidates unavailable, type the id".
 *
 * The seam is stubbed here on purpose: `CherryToolEngine.listTargets` is driven
 * end-to-end against the loopback peer in `subagentTargets.test.ts`, so these
 * cases own the OTHER half — the HTTP status, the body's whitelist and the
 * fence.
 */
describe('⑪ the settings page’s candidate source (#260)', () => {
  type Seam = NonNullable<CherryHttpDeps['subagent']>

  const LISTING = {
    agents: [
      { agentId: 'agent-1', name: 'Agent One' },
      { agentId: 'agent-2', name: 'Agent Two', emoji: '🤖' },
    ],
    workspaces: [{ workspaceId: 'ws-1', name: 'Repo One' }],
    systemWorkspace: true,
  }

  /**
   * The deps slice, with the candidate seam answering `answer` (or throwing it).
   *
   * `calls` records the arguments the route forwarded, which is the only way to
   * tell "the route passed `agentId`" from "the route dropped it" — the body
   * would look the same against a stub that ignores its arguments.
   */
  function candidate(answer: unknown | (() => Promise<unknown>)): {
    deps: Seam
    calls: Array<{ device: string; agentId?: string }>
  } {
    const calls: Array<{ device: string; agentId?: string }> = []
    return {
      calls,
      deps: {
        document: createSubagentConfigDocument({ file: join(dataDir, 'subagent.json'), seed: undefined }),
        running: () => undefined,
        status: (): SubagentSubsystemStatus => ({ state: 'pending', reason: { code: 'disabled' } }),
        targets: (device, agentId) => {
          calls.push(agentId === undefined ? { device } : { device, agentId })
          // The fixtures below are deliberately NOT all listings (some are bare
          // verdicts, one carries extra keys to prove the whitelist), so the
          // answer is handed through as the seam's own union.
          return (typeof answer === 'function' ? (answer as () => Promise<unknown>)() : Promise.resolve(answer)) as Promise<
            SubagentTargetsOutcome
          >
        },
      },
    }
  }

  it('⑪a answers the listing and carries no `problem`', async () => {
    const { deps, calls } = candidate(LISTING)
    mount({ subagent: deps })

    const { status, json } = await call('/subagent/targets?device=dev-1')

    expect(status).toBe(200)
    expect(json).toEqual(LISTING)
    expect(json.problem).toBeUndefined()
    expect(calls).toEqual([{ device: 'dev-1' }])
  })

  it('⑪b forwards `agentId` when the page asks about one agent', async () => {
    const { deps, calls } = candidate(LISTING)
    mount({ subagent: deps })

    expect((await call('/subagent/targets?device=dev-1&agentId=agent-1')).status).toBe(200)
    expect(calls).toEqual([{ device: 'dev-1', agentId: 'agent-1' }])

    // An EMPTY `agentId` is "not chosen yet", not an agent whose id is empty:
    // the page sends the key as soon as the field exists, and forwarding `''`
    // would ask the peer about an agent that cannot exist.
    expect((await call('/subagent/targets?device=dev-1&agentId=')).status).toBe(200)
    expect(calls).toEqual([{ device: 'dev-1', agentId: 'agent-1' }, { device: 'dev-1' }])
  })

  it('⑪c every DEVICE verdict is a 200 with a problem the form can render', async () => {
    // The four verdicts the engine answers in band. Each one means the same
    // thing to the page ("no candidates right now"), so none of them may be a
    // 4xx/5xx: a 500 here is the settings page telling the operator the plugin
    // is broken when the device is merely offline.
    const CASES = [
      {
        verdict: { error: 'not-found', device: 'dev-9', known: ['dev-1'] },
        problem: { code: 'not-found', device: 'dev-9', known: ['dev-1'] },
      },
      {
        verdict: { error: 'ambiguous-device', device: 'desk', candidates: ['Desk A', 'Desk B'] },
        problem: { code: 'ambiguous-device', device: 'desk', candidates: ['Desk A', 'Desk B'] },
      },
      {
        verdict: { error: 'archive-quarantined', guidance: 'move it aside', archive: '/data/devices.json' },
        // The message is the STORE's own recovery instruction, not a sentence
        // this route invents: the page and the tools must send the operator to
        // the same place.
        problem: { code: 'archive-quarantined', message: 'move it aside', archive: '/data/devices.json' },
      },
      {
        // The same verdict WITH the preservation copy: `preservedAs` is the one
        // optional member a store may or may not have produced, and the operator
        // needs it to find the copy. Both arms are in this table so neither the
        // field nor its absence can be hard-coded.
        verdict: {
          error: 'archive-quarantined',
          guidance: 'move it aside',
          archive: '/data/devices.json',
          preservedAs: '/data/devices.json.corrupt',
        },
        problem: {
          code: 'archive-quarantined',
          message: 'move it aside',
          archive: '/data/devices.json',
          preservedAs: '/data/devices.json.corrupt',
        },
      },
      {
        verdict: { error: 'device-unavailable', device: 'dev-1', state: 'offline' },
        problem: { code: 'device-unavailable', device: 'dev-1', state: 'offline' },
      },
    ] as const

    for (const { verdict, problem } of CASES) {
      const { deps } = candidate(verdict)
      mount({ subagent: deps })

      const { status, json } = await call('/subagent/targets?device=dev-1')

      expect(status).toBe(200)
      expect(json.problem).toMatchObject(problem)
      expect(typeof json.problem.message).toBe('string')
      expect(json.problem.message.length).toBeGreaterThan(0)
      // The EXACT key set, not just the expected ones: an extra field is a field
      // the page would have to ignore, and `toMatchObject` cannot see one. This
      // is what makes the optional members (`known`, `candidates`,
      // `preservedAs`, `state`) load-bearing rather than decorative.
      const expectedKeys = [...new Set(['code', 'message', ...Object.keys(problem)])].sort()
      expect(Object.keys(json.problem).sort()).toEqual(expectedKeys)
      // Success and failure are mutually exclusive: a problem body names no list,
      // so a page that renders both cannot show stale rows beside an error.
      expect(json.agents).toBeUndefined()
      expect(json.workspaces).toBeUndefined()
    }
  })

  it('⑪d a peer refusal becomes `peer-refused`, carrying the peer’s own reason and text', async () => {
    // The seam deliberately does NOT translate peer errors (see its docblock):
    // these three codes are the HTTP face's, so the classification is asserted
    // here, on the real error classes the rpc layer throws.
    const { deps } = candidate(() =>
      Promise.reject(new JsonRpcRequestError(1000, 'Agent not found', { reason: 'NOT_FOUND' })),
    )
    mount({ subagent: deps })

    const { status, json } = await call('/subagent/targets?device=dev-1&agentId=nope')

    expect(status).toBe(200)
    expect(json.problem).toMatchObject({ code: 'peer-refused', reason: 'NOT_FOUND', message: 'Agent not found' })
    expect(json.agents).toBeUndefined()
  })

  it('⑪d2 a refusal with no `data.reason` still classifies, and names no reason', async () => {
    // Not every peer error carries the discriminator — `JsonRpcRequestError.data`
    // is `unknown`, and a malformed one is `undefined`. The code still says
    // `peer-refused`; what must NOT happen is an invented reason or a literal
    // `"reason": null` the page would have to special-case.
    const { deps } = candidate(() => Promise.reject(new JsonRpcRequestError(1000, 'peer said no', undefined)))
    mount({ subagent: deps })

    const { status, json } = await call('/subagent/targets?device=dev-1')

    expect(status).toBe(200)
    expect(json.problem).toEqual({ code: 'peer-refused', message: 'peer said no' })
  })

  it('⑪e a request that times out becomes `peer-timeout` with the bound that ran out', async () => {
    const { deps } = candidate(() => Promise.reject(new RequestTimeoutError('agent.agents.list', 1_500)))
    mount({ subagent: deps })

    const { status, json } = await call('/subagent/targets?device=dev-1')

    expect(status).toBe(200)
    expect(json.problem).toMatchObject({ code: 'peer-timeout', timeoutMs: 1_500 })
    // The mutual-exclusion rule holds on EVERY failure arm, not just the device
    // ones: a page that renders both cannot show stale rows beside an error.
    expect(json.agents).toBeUndefined()
    expect(json.workspaces).toBeUndefined()
  })

  it('⑪f a link that died mid-read becomes `transport`', async () => {
    // `TransportLostError` is what `Connection.#businessRequest` raises after a
    // read has already been replayed once and the link died again, so it is the
    // one class that really means "reconnect".
    const { deps } = candidate(() =>
      Promise.reject(new TransportLostError('dev-1', 'offline', 'agent.agents.list')),
    )
    mount({ subagent: deps })

    const { status, json } = await call('/subagent/targets?device=dev-1')

    expect(status).toBe(200)
    expect(json.problem).toMatchObject({ code: 'transport', device: 'dev-1' })
  })

  it('⑪f2 a device that drops MID-READ becomes `device-unavailable`, not `transport`', async () => {
    // `listTargets` answers `device-unavailable` in band when the device is
    // already down, but a link that drops BETWEEN the resolution and a page
    // arrives here as a THROW from `Connection.#businessRequest`. Classifying it
    // as `transport` (the first draft did) told the operator to check their
    // network about a device that had simply gone away.
    const { deps } = candidate(() => Promise.reject(new DeviceUnavailableError('dev-1', 'offline')))
    mount({ subagent: deps })

    const { status, json } = await call('/subagent/targets?device=dev-1')

    expect(status).toBe(200)
    expect(json.problem).toMatchObject({ code: 'device-unavailable', device: 'dev-1', state: 'offline' })
    expect(json.agents).toBeUndefined()
  })

  it('⑪f3 a peer that breaks the protocol becomes `peer-protocol`, never `transport`', async () => {
    // The aggregate REFUSES a page whose `items` is not an array, a cursor that
    // never advances and a run of empty pages — all as plain `Error`s. None of
    // them is a transport failure, and telling the operator to check the network
    // about a broken peer sends them to the wrong place.
    const { deps } = candidate(() =>
      Promise.reject(new Error('agent.agents.list: peer answered a page whose `items` is not an array')),
    )
    mount({ subagent: deps })

    const { status, json } = await call('/subagent/targets?device=dev-1')

    expect(status).toBe(200)
    expect(json.problem.code).toBe('peer-protocol')
    expect(json.problem.message).toContain('items')
  })

  it('⑪g the body is a WHITELIST: nothing the seam did not name rides out', async () => {
    // Same rule as `/diagnostics`: a field the route does not name cannot leak,
    // so a credential reaching this seam by a future change is still not served.
    const { deps } = candidate({
      ...LISTING,
      accessToken: 'super-secret-token',
      messages: [{ text: 'LEAK-PROBE-message' }],
      parts: [{ text: 'LEAK-PROBE-part' }],
    })
    mount({ subagent: deps })

    const { status, res } = await call('/subagent/targets?device=dev-1')

    expect(status).toBe(200)
    expect(res.body).not.toContain('super-secret-token')
    expect(res.body).not.toContain('LEAK-PROBE')
    expect(res.body).not.toContain('accessToken')
  })

  it('⑪h a request with no `device` is the one 400 — a malformed request, not a missing candidate', async () => {
    const { deps, calls } = candidate(LISTING)
    mount({ subagent: deps })

    const { status, json } = await call('/subagent/targets')

    expect(status).toBe(400)
    expect(json.error).toBe('invalid-request')
    // Refused before any device work: an empty selector would otherwise resolve
    // to a miss and answer `not-found` about a selector nobody sent.
    expect(calls).toEqual([])
  })

  it('⑪i a non-GET stays the unmatched-route 404 — no new 405 for this path', async () => {
    const { deps } = candidate(LISTING)
    mount({ subagent: deps })

    const { status, json } = await call('/subagent/targets?device=dev-1', { method: 'POST', body: '{}' })

    expect(status).toBe(404)
    expect(json.error).toBe('not-found')
  })

  it('⑪j an assembly that wires no experiment answers 404, like the rest of the family', async () => {
    mount()
    expect((await call('/subagent/targets?device=dev-1')).status).toBe(404)
    // The router drops EMPTY path segments, so a trailing slash reaches the same
    // branch. It must reach the same VERDICT too — a review asked whether the
    // slash form could slip past the missing-slice guard and answer 200.
    const slashed = await call('/subagent/targets/?device=dev-1')
    expect(slashed.status).toBe(404)
    expect(slashed.json.error).toBe('not-found')
  })

  it('⑪k the fence covers this route too: cross-site, rebound and unmarked-host requests are refused', async () => {
    const { deps } = candidate(LISTING)
    mount({ subagent: deps })

    const crossed = await call('/subagent/targets?device=dev-1', {
      origin: 'http://evil.example.com',
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(crossed.status).toBe(403)

    const rebound = await call('/subagent/targets?device=dev-1', { host: 'evil.example.com' })
    expect(rebound.status).toBe(403)

    const crossSite = await call('/subagent/targets?device=dev-1', {
      origin: `http://${HOST}`,
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(crossSite.status).toBe(403)

    // …and the same-origin browser read is admitted, so the fence is a filter
    // rather than a wall.
    expect((await call('/subagent/targets?device=dev-1', { origin: `http://${HOST}` })).status).toBe(200)
  })
})

describe('plugin assembly (index.ts apply)', () => {
  interface AssemblyCtx {
    /** The same FakeWebServer the unit-level tests drive, so `call` works. */
    server: FakeWebServer
    effects: Array<() => void>
    /**
     * The scope subsystem's mount lifecycle, in its OWN bucket. `effects` holds
     * the ROOT ctx's effects only — the cases below assert its length is exactly
     * 1, and the assembly must not add a second root `ctx.effect`.
     */
    injectedEffects: Array<() => void>
    /**
     * The host's tool registry face: `register` alone. This fixture has no
     * `resolve`, so the scope subsystem stays `unsupported` — the cases that
     * need a READY host build their own.
     */
    tools: {
      definitions: Array<{ name: string; description: string }>
      register(definition: { name: string; description: string }): () => void
    }
    dataDir: string
    injectable: boolean
    inject(deps: string[], cb: (wctx: unknown) => unknown): void
    effect(cb: () => () => void): void
  }

  function assemblyCtx(injectable = true): AssemblyCtx {
    // The REAL index.apply registers through ctx.webServer, so the fake here
    // is the same prefix table the rest of the suite dispatches through —
    // otherwise the assembly path would only be reachable by bypassing it.
    const server = new FakeWebServer()
    const effects: Array<() => void> = []
    const injectedEffects: Array<() => void> = []
    const definitions: Array<{ name: string; description: string }> = []
    const injected = {
      agents: { list: () => [] },
      workspaceRegistry: { list: () => [], resolveByPath: async () => undefined },
      effect(cb: () => () => void) {
        injectedEffects.push(cb())
      },
      on() {
        return () => {}
      },
    }
    return {
      server,
      effects,
      injectedEffects,
      tools: {
        definitions,
        register(definition) {
          definitions.push(definition)
          return () => {
            const index = definitions.indexOf(definition)
            if (index >= 0) definitions.splice(index, 1)
          }
        },
      },
      dataDir,
      injectable,
      inject(deps, cb) {
        if (!injectable) throw new Error('service "webServer" is not available')
        // Split BY DEPENDENCY KEY: the scope subsystem's two keys get the
        // services plus the injected ctx's own effect/on; the web keys keep the
        // pre-existing response. The scope match is an EXACT set, so a
        // misspelled key throws here instead of still matching (B6).
        if (asksForScopeKeys(deps)) {
          cb(injected)
          return
        }
        cb({ webServer: server, webRuntime: { trustedHosts: [] } })
      },
      effect(cb) {
        effects.push(cb())
      },
    }
  }

  it('declares the plugin identity the host loads it by', async () => {
    const index = await import('../../src/index.js')
    expect(index.name).toBe('cherry-remote')
    expect(index.inject).toEqual(['tools'])
  })

  it('resolves the data directory: explicit > $DSH_HOME > ~/.dsh', async () => {
    const { resolveDataDir } = await import('../../src/index.js')
    expect(resolveDataDir({ dataDir: '/explicit' }, {})).toBe('/explicit')
    expect(resolveDataDir({}, { DSH_HOME: '/harness' })).toBe('/harness/cherry-remote')
    expect(resolveDataDir({}, {})).toContain('.dsh')
  })

  it('mounts the route, creates the identity key, and releases both on dispose', async () => {
    const index = await import('../../src/index.js')
    const ctx = assemblyCtx()

    await applyAssembly(ctx as never, { dataDir })

    expect(ctx.server.routes.has(PREFIX)).toBe(true)
    // The identity load is async by design (apply must stay synchronous), so
    // the 0600 key file appears shortly after apply returns.
    await vi.waitFor(() => {
      expect(existsSync(join(dataDir, 'identity.key'))).toBe(true)
    })

    expect(ctx.effects).toHaveLength(1)
    ctx.effects[0]!()
    expect(ctx.server.routes.size).toBe(0)
  })

  it('serves the experiment’s document from the REAL assembly, and notices a save that has not applied (#233)', async () => {
    // The route's unit cases above supply their own deps, so they cannot tell
    // `running: () => state.subagentResolution` from `running: () => undefined`.
    // This case drives the real `apply`, and the ONLY observation that
    // distinguishes the two is the flip to `pendingRestart: true` after a save
    // that differs from what the assembly resolved.
    const index = await import('../../src/index.js')
    const ctx = assemblyCtx()
    await applyAssembly(ctx as never, {
      dataDir,
      subagent: { enabled: true, device: 'desk-1', agentId: 'agent-7', workspaceId: 'ws-1' },
    })

    const first = await call('/subagent', {}, ctx.server)
    expect(first.status).toBe(200)
    // The profile's key is the SEED until the page saves, and this host has no
    // `subagents` service, so the verdict is the honest "host too old".
    expect(first.json.source).toBe('config')
    expect(first.json.subagent).toEqual({
      enabled: true,
      device: 'desk-1',
      agentId: 'agent-7',
      workspaceId: 'ws-1',
      revision: 0,
    })
    expect(first.json.status).toEqual({ state: 'unsupported', reason: { code: 'unsupported' } })
    expect(first.json.pendingRestart).toBe(false)

    const saved = await call(
      '/subagent',
      { method: 'PUT', body: JSON.stringify({ enabled: false, expectedRevision: 0 }) },
      ctx.server,
    )
    expect(saved.status).toBe(200)
    expect(saved.json.pendingRestart).toBe(true)
    expect(saved.json.source).toBe('file')
    // And the RUNNING verdict is untouched by the save: a route that reported
    // the saved document's decision here would be claiming a hot reload.
    expect(saved.json.status).toEqual({ state: 'unsupported', reason: { code: 'unsupported' } })
    ctx.effects[0]?.()
  })

  it('wires the candidate seam to the REAL engine, so the route reads this apply’s own archive (#260)', async () => {
    // The ⑪ cases above supply their own seam, so they cannot tell "the route
    // calls the engine" from "the route calls a stub". This case drives the real
    // `apply`, and the one observation that distinguishes them is `known`: only
    // the engine reads the assembly's own store, and only that store knows
    // `dev-1` exists.
    const index = await import('../../src/index.js')
    // The assembly opens `<dataDir>/devices.json`; seeding it BEFORE apply is the
    // only way the store the engine reads holds a device.
    new DeviceStore(join(dataDir, 'devices.json')).upsert(record())
    const ctx = assemblyCtx()
    await applyAssembly(ctx as never, { dataDir })

    const answered = await call('/subagent/targets?device=no-such-device', {}, ctx.server)

    expect(answered.status).toBe(200)
    expect(answered.json.problem).toMatchObject({ code: 'not-found', known: ['dev-1'] })
    ctx.effects[0]?.()
  })

  it('does not adopt connections from a previous apply against another archive', async () => {
    const index = await import('../../src/index.js')
    const first = assemblyCtx()
    await applyAssembly(first as never, { dataDir })

    // A second apply with a fresh data dir must start from an empty pool, so a
    // device id present only in the OLD archive cannot be served from a stale
    // connection bound to the old store.
    const secondDir = mkdtempSync(join(tmpdir(), 'cherry-http-2-'))
    try {
      const second = assemblyCtx()
      expect(() => index.apply(second as never, { dataDir: secondDir })).not.toThrow()
      await settleIdentity()
      expect(second.server.routes.has(PREFIX)).toBe(true)
      // The first plugin's route seat was replaced by its own teardown path.
      expect(first.effects).toHaveLength(1)
      first.effects[0]!()
    } finally {
      rmSync(secondDir, { recursive: true, force: true })
    }
  })

  /** `call` defaults to the module-level ctx; point it at an assembly ctx. */
  function callOn(assembly: AssemblyCtx) {
    return (path: string, init: RequestInitLike = {}) => call(path, init, assembly.server)
  }

  it('rebuilds the connection so PATCH address maintenance reaches the dialer (F1a)', async () => {
    const index = await import('../../src/index.js')
    const { DeviceConnection } = await import('../../src/connection.js')
    const ctx = assemblyCtx()
    await applyAssembly(ctx as never, { dataDir })

    const store = new DeviceStore(join(dataDir, 'devices.json'))
    store.upsert(record({ hosts: ['127.0.0.1'], port: 1111 }))
    await vi.waitFor(async () => {
      expect(existsSync(join(dataDir, 'identity.key'))).toBe(true)
    })

    /** Every record a DeviceConnection was constructed with. */
    const captured: Array<{ hosts: string[]; port: number; enabled: boolean }> = []
    const spy = vi
      .spyOn(DeviceConnection.prototype as unknown as { connect(): Promise<void> }, 'connect')
      .mockImplementation(function (this: { record: DeviceRecord }) {
        captured.push({ hosts: [...this.record.hosts], port: this.record.port, enabled: this.record.enabled })
        return Promise.reject(new Error('no dial in this test'))
      })

    try {
      const api = callOn(ctx)
      // A read builds the pooled connection, capturing the ORIGINAL address.
      await api('/devices')
      expect(captured).toEqual([{ hosts: ['127.0.0.1'], port: 1111, enabled: true }])

      // Address maintenance updates the record...
      const patched = await api('/devices/dev-1', {
        method: 'PATCH',
        body: JSON.stringify({ hosts: ['10.9.9.9'], port: 7777 }),
      })
      expect(patched.status).toBe(200)
      expect(patched.json).toMatchObject({ hosts: ['10.9.9.9'], port: 7777 })

      // ...and the pooled instance is DROPPED, so the next read rebuilds from
      // the new record. Without eviction the dialer keeps the old address.
      await api('/devices')
      expect(captured).toHaveLength(2)
      expect(captured[1]).toEqual({ hosts: ['10.9.9.9'], port: 7777, enabled: true })
    } finally {
      spy.mockRestore()
    }
  })

  it('does not wedge a device at disabled across disable → enable (F1b)', async () => {
    const index = await import('../../src/index.js')
    const { DeviceConnection } = await import('../../src/connection.js')
    const ctx = assemblyCtx()
    await applyAssembly(ctx as never, { dataDir })

    const store = new DeviceStore(join(dataDir, 'devices.json'))
    store.upsert(record())
    await vi.waitFor(async () => {
      expect(existsSync(join(dataDir, 'identity.key'))).toBe(true)
    })

    /**
     * Records that connections were built with. A connection built while the
     * record said `enabled:false` would be permanently stuck: its `connect()`
     * short-circuits on the captured flag.
     */
    const captured: Array<{ enabled: boolean }> = []
    const spy = vi
      .spyOn(DeviceConnection.prototype as unknown as { connect(): Promise<void> }, 'connect')
      .mockImplementation(function (this: { record: DeviceRecord }) {
        captured.push({ enabled: this.record.enabled })
        // Model the real guard: a connection holding `enabled:false` reports
        // `disabled` and rejects, exactly as DeviceConnection.connect does.
        if (!this.record.enabled) return Promise.reject(new Error('device is disabled'))
        return Promise.reject(new Error('no dial in this test'))
      })

    const api = callOn(ctx)
    try {
      await api('/devices')

      const disabled = await api('/devices/dev-1', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      })
      expect(disabled.json).toMatchObject({ enabled: false, state: 'disabled' })

      // No connection may have been BUILT for a disabled record: the disable
      // branch resolves an existing instance rather than creating one.
      expect(captured.every((entry) => entry.enabled)).toBe(true)

      const enabled = await api('/devices/dev-1', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true }),
      })
      expect(enabled.json.enabled).toBe(true)
      // The wedge: a pooled `enabled:false` instance would answer `disabled`
      // forever. The rebuilt connection must leave that state.
      expect(enabled.json.state).not.toBe('disabled')

      const reopened = new FakeResponse()
      await ctx.server.dispatch(new FakeRequest(`${PREFIX}/events`, { host: HOST }), reopened)
      expect(reopened.events<{ state: string }>('device-state')[0]!.state).not.toBe('disabled')
    } finally {
      spy.mockRestore()
    }
  })

  it('does not build a connection for a device disabled before any read (F1b, empty pool)', async () => {
    const index = await import('../../src/index.js')
    const { DeviceConnection } = await import('../../src/connection.js')
    const ctx = assemblyCtx()
    await applyAssembly(ctx as never, { dataDir })

    const store = new DeviceStore(join(dataDir, 'devices.json'))
    store.upsert(record())
    await vi.waitFor(async () => {
      expect(existsSync(join(dataDir, 'identity.key'))).toBe(true)
    })

    const captured: Array<{ enabled: boolean }> = []
    const spy = vi
      .spyOn(DeviceConnection.prototype as unknown as { connect(): Promise<void> }, 'connect')
      .mockImplementation(function (this: { record: DeviceRecord }) {
        captured.push({ enabled: this.record.enabled })
        if (!this.record.enabled) return Promise.reject(new Error('device is disabled'))
        return Promise.reject(new Error('no dial in this test'))
      })

    const api = callOn(ctx)
    try {
      // NO read first: the pool is EMPTY, which is the decisive condition.
      // A create-on-miss disable branch would build a connection here and bury
      // an `enabled:false` capture in the pool forever.
      const disabled = await api('/devices/dev-1', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      })
      expect(disabled.json).toMatchObject({ enabled: false, state: 'disabled' })
      expect(captured).toEqual([])

      // The re-enable must dial from a record that says `enabled:true`. Under
      // the wedge it would reuse the pooled disabled instance and answer
      // `disabled` forever, with the connection never dialing again.
      const enabled = await api('/devices/dev-1', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true }),
      })
      expect(enabled.json.enabled).toBe(true)
      expect(enabled.json.state).not.toBe('disabled')
      // The re-enable dials from a record that says `enabled:true` (the pool is
      // rebuilt, so a fresh instance is constructed) — never from the disabled
      // capture that caused the wedge.
      expect(captured).toContainEqual({ enabled: true })
      expect(captured[captured.length - 1]).toEqual({ enabled: true })
    } finally {
      spy.mockRestore()
    }
  })

  it('degrades quietly instead of failing the plugin in a headless deployment', async () => {
    const index = await import('../../src/index.js')
    const ctx = assemblyCtx(false)
    const warn = vi.mocked(console.warn)

    expect(() => index.apply(ctx as never, { dataDir })).not.toThrow()
    expect(ctx.server.routes.size).toBe(0)
    expect(warn).toHaveBeenCalled()
  })
})
