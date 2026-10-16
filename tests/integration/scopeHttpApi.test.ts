/**
 * Task 7 integration suite: the HTTP face of the scope document
 * (`GET`/`PUT /cherry-remote/api/scope`, spec §6.3). Scenario numbering ①-⑬
 * mirrors the task brief's Step 1.
 *
 * The HTTP harness (prefix table, request/response stand-ins) MIRRORS
 * `tests/integration/httpApi.test.ts`'s rather than importing it: that harness
 * is private to that file, and this task owns exactly two files. The scope side
 * reuses the shared `tests/helpers/fakeToolHost.ts` unchanged, on top of a REAL
 * `ToolScopeState` + `ToolScopeHost` pair, so every body asserted here is the
 * one the assembled plugin produces — the route adds projection only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore } from '../../src/deviceStore.js'
import { registerHttpApi } from '../../src/httpApi.js'
import type { CherryHttpContext, CherryHttpDeps, HttpRequestLike, HttpResponseLike } from '../../src/httpApi.js'
import { ToolScopeState } from '../../src/toolScope.js'
import type { WorkspaceRegistryLike } from '../../src/toolScope.js'
import { createToolScopeHost } from '../../src/toolScopeHost.js'
import type { RefreshSummary, ScopeHostContext, ScopeInjectedContext, ToolScopeHost } from '../../src/toolScopeHost.js'
import { FakeToolHost } from '../helpers/fakeToolHost.js'
import type { FakeAgentSeed, FakeCapability, FakeWorkspace } from '../helpers/fakeToolHost.js'

// ---------------------------------------------------------------------------
// HTTP harness (mirrors tests/integration/httpApi.test.ts)
// ---------------------------------------------------------------------------

type PrefixHandler = (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>

/** Prefix table that reproduces the host's longest-prefix-wins dispatch. */
class FakeWebServer {
  readonly routes = new Map<string, PrefixHandler>()

  register(route: { kind: 'prefix' | 'exact'; path: string; handler: PrefixHandler }): () => void {
    if (this.routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`)
    this.routes.set(route.path, route.handler)
    return () => {
      this.routes.delete(route.path)
    }
  }

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

interface RequestInitLike {
  method?: string
  host?: string
  origin?: string
  headers?: Record<string, string>
  body?: string
  /** The body stream THROWS when read: proves a route refused before reading it. */
  unreadableBody?: boolean
}

class FakeRequest extends EventEmitter implements HttpRequestLike {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly #body: string
  readonly #unreadable: boolean

  constructor(url: string, init: RequestInitLike = {}) {
    super()
    this.url = url
    this.method = init.method ?? 'GET'
    this.#body = init.body ?? ''
    this.#unreadable = init.unreadableBody === true
    this.headers = { ...(init.headers ?? {}) }
    if (init.host !== undefined) this.headers['host'] = init.host
    if (init.origin !== undefined) this.headers['origin'] = init.origin
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    if (this.#unreadable) throw new Error('this route must not read the request body')
    if (this.#body !== '') yield Buffer.from(this.#body, 'utf8')
  }
}

class FakeResponse implements HttpResponseLike {
  status = 0
  headers: Record<string, string> = {}
  body = ''
  ended = false

  writeHead(status: number, headers: Record<string, string | number> = {}): void {
    this.status = status
    for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = String(value)
  }

  write(chunk: string): void {
    this.body += chunk
  }

  end(chunk?: string): void {
    if (chunk !== undefined) this.body += chunk
    this.ended = true
  }
}

/** The fake `ctx.webServer` / `ctx.webRuntime` pair, as the host injects it. */
interface FakeCtx {
  server: FakeWebServer
  trustedHosts: string[]
  inject(deps: string[], cb: (wctx: unknown) => void | (() => void)): void
}

function makeCtx(server: FakeWebServer, trustedHosts: string[] = []): FakeCtx {
  return {
    server,
    trustedHosts,
    inject(_deps, cb) {
      cb({ webServer: server, webRuntime: { trustedHosts } })
    },
  }
}

// ---------------------------------------------------------------------------
// Fixture: real scope state + real scope host + real routes
// ---------------------------------------------------------------------------

const PREFIX = '/cherry-remote/api'
const HOST = '127.0.0.1:23023'
/** A stand-in for the tool family: on this face only the SHAPE of the names matters. */
const FAMILY = ['cherry_status', 'cherry_devices', 'cherry_pair']

interface FixtureOptions {
  workspaces?: readonly FakeWorkspace[]
  agents?: readonly FakeAgentSeed[]
  /** Capabilities REMOVED from the plugin root's tools face (`guard` ⇒ 仅可见性). */
  without?: readonly FakeCapability[]
  /** The global names this fixture registers; `run_code` is the one name the fake host refuses in a deny set. */
  names?: readonly string[]
  /** Raw document text written to the scope file BEFORE the state reads it. */
  seed?: string
  /** Records the injection callback without arriving it: the host stays `pending` (D9). */
  deferInjection?: boolean
  /** Holds `resolveByPath` until `openGate()`: keeps one recompute round verifiably in flight. */
  gate?: boolean
  /** Makes the injected registry's `list()` THROW — B16's read failure. */
  listThrows?: boolean
}

interface ScopeHttpFixture {
  fake: FakeToolHost
  state: ToolScopeState
  host: ToolScopeHost
  server: FakeWebServer
  scopeFile: string
  /** One entry per `refreshScope()` call: the summary THAT CALL returned. */
  refreshCalls: Array<RefreshSummary | undefined>
  /** `save` / `refresh` / the microtask queued inside `save`, in execution order. */
  order: string[]
  /** One `rebuild()` per recompute pass. */
  rebuilds: number
  /** The highest number of judgement passes that ever ran at the same time. */
  roundsInFlight: number
  openGate(): void
  dispose(): void
}

let live: ScopeHttpFixture[] = []

afterEach(() => {
  for (const fixture of live.splice(0)) fixture.dispose()
  vi.restoreAllMocks()
})

function makeFixture(options: FixtureOptions = {}): ScopeHttpFixture {
  const dir = mkdtempSync(join(tmpdir(), 'scope-http-'))
  const scopeFile = join(dir, 'scope.json')
  if (options.seed !== undefined) writeFileSync(scopeFile, options.seed)

  const names = [...(options.names ?? FAMILY)]
  const fake = new FakeToolHost({ without: options.without, deferInjection: options.deferInjection })
  fake.setWorkspaces(options.workspaces ?? [])
  for (const agent of options.agents ?? []) fake.addAgent(agent)

  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  // The two seams `FakeToolHost` does not own, wrapped onto the very ctx the
  // scope host's injection callback receives: a `list()` that really throws
  // (B16's read failure) and a `resolveByPath` the test can park.
  const inject = fake.root.inject?.bind(fake.root)
  if (inject !== undefined && (options.gate === true || options.listThrows === true)) {
    fake.root.inject = ((keys: readonly string[], cb: (ctx: ScopeInjectedContext) => void | (() => void)) =>
      inject(keys, (wctx: ScopeInjectedContext) => {
        const registry = wctx.workspaceRegistry
        if (registry === undefined) return cb(wctx)
        const wrapped: WorkspaceRegistryLike = {
          ...registry,
          list: () => {
            if (options.listThrows === true) throw new Error('registry list() is unavailable')
            return registry.list()
          },
          resolveByPath: async (path: string) => {
            if (options.gate === true) await gate
            return registry.resolveByPath?.call(registry, path)
          },
        }
        return cb({ ...wctx, workspaceRegistry: wrapped })
      })) as ScopeHostContext['inject']
  }

  const logs: string[] = []
  const order: string[] = []
  const refreshCalls: Array<RefreshSummary | undefined> = []
  let rebuilds = 0
  let running = 0
  let roundsInFlight = 0

  const state = new ToolScopeState({ file: scopeFile, log: (message) => logs.push(message) })

  const host = createToolScopeHost({
    scope: state,
    names,
    registerTools: () => {
      const disposers = names.map((name) =>
        fake.root.tools!.register({ name, description: `fixture ${name}`, execute: async () => undefined }),
      )
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    // The bounded recheck is Task 6's own surface; its 250 ms timer here would
    // only add rounds nobody asked for.
    recheckDelaysMs: [],
    log: (message) => logs.push(message),
  })

  // Instrumentation, installed before anything can run: the real methods are
  // captured first so the spies cannot recurse into themselves.
  const realSave = state.save.bind(state)
  vi.spyOn(state, 'save').mockImplementation((body, expectedRevision) => {
    const result = realSave(body, expectedRevision)
    order.push('save')
    // A microtask queued INSIDE the save: if the route awaits anything before
    // calling `refreshScope()`, this runs first and `order` shows it.
    queueMicrotask(() => order.push('save-microtask'))
    return result
  })
  const realRebuild = state.rebuild.bind(state)
  vi.spyOn(state, 'rebuild').mockImplementation(async (registry, agents) => {
    rebuilds += 1
    running += 1
    roundsInFlight = Math.max(roundsInFlight, running)
    try {
      return await realRebuild(registry, agents)
    } finally {
      running -= 1
    }
  })

  const deps: CherryHttpDeps = {
    store: new DeviceStore(join(dir, 'devices.json')),
    scope: state,
    refreshScope: () => {
      order.push('refresh')
      const summary = host.refresh()
      refreshCalls.push(summary)
      return summary
    },
    pair: async () => {
      throw new Error('the scope suite never pairs')
    },
    identity: () => new Uint8Array([0]),
    connect: () => {
      throw new Error('the scope suite never dials')
    },
    onDeviceState: () => {},
    onPairingProgress: () => {},
  }

  const server = new FakeWebServer()
  const ctx = makeCtx(server)
  const disposeRoutes = registerHttpApi(ctx as unknown as CherryHttpContext, deps)
  const unmount = host.mount(fake.root)

  const fixture: ScopeHttpFixture = {
    fake,
    state,
    host,
    server,
    scopeFile,
    refreshCalls,
    order,
    get rebuilds() {
      return rebuilds
    },
    get roundsInFlight() {
      return roundsInFlight
    },
    openGate: () => release(),
    dispose: () => {
      unmount()
      disposeRoutes()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  live.push(fixture)
  return fixture
}

/** Lets every microtask of every pending recompute pass run to completion. */
async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** `json` is `any` for the same reason `httpApi.test.ts`'s is: one harness, many response shapes. */
async function call(
  fixture: ScopeHttpFixture,
  path: string,
  init: RequestInitLike = {},
): Promise<{ status: number; json: any; res: FakeResponse }> {
  const req = new FakeRequest(`${PREFIX}${path}`, { host: HOST, ...init })
  const res = new FakeResponse()
  const owned = await fixture.server.dispatch(req, res)
  expect(owned).toBe(true)
  return { status: res.status, json: res.body === '' ? undefined : JSON.parse(res.body), res }
}

const get = (fixture: ScopeHttpFixture, init: RequestInitLike = {}) => call(fixture, '/scope', init)
const put = (fixture: ScopeHttpFixture, body: unknown) =>
  call(fixture, '/scope', { method: 'PUT', body: JSON.stringify(body) })

/** The on-disk document, in the shape the plugin writes it. */
function seedDoc(value: {
  version?: number
  revision: number
  mode: 'global' | 'selected'
  workspaceIds: readonly string[]
}): string {
  return `${JSON.stringify({ version: 1, updatedAt: '2026-10-15T00:00:00.000Z', ...value }, null, 2)}\n`
}

function degradedSources(json: { host: { degraded: Array<{ source: string }> } }): string[] {
  return json.host.degraded.map((note) => note.source).sort()
}

const W1: FakeWorkspace = { id: 'w1', title: 'Workspace One', path: '/work/w1' }
const W2: FakeWorkspace = { id: 'w2', title: 'Workspace Two', path: '/work/w2' }

// ---------------------------------------------------------------------------
// ① GET shape
// ---------------------------------------------------------------------------

describe('GET /cherry-remote/api/scope', () => {
  it('① answers the whole shape, field by field', async () => {
    const fixture = makeFixture({
      workspaces: [W1, W2],
      agents: [{ id: 'agent-1', cwd: '/work/w1' }, { id: 'agent-stray', cwd: '/work/stray' }],
      seed: seedDoc({ revision: 2, mode: 'selected', workspaceIds: ['ghost', 'w1'] }),
    })
    await settle()

    const { status, json } = await get(fixture)
    expect(status).toBe(200)

    // One whole-object comparison pins every field AND the absence of extras:
    // `workspaces` carries no `sessionIds`, `scope` no `version`/`updatedAt`, and
    // `degraded` (an ARRAY, empty = no degradation) rides INSIDE `host` — which
    // spec §6.3 fixes at exactly these four fields. B7①'s `upgradeHint` is NOT
    // one of them: it belongs to the diagnostics report's own segment, so this
    // comparison must keep failing on any field the route does not serve.
    expect(json).toEqual({
      scope: { mode: 'selected', workspaceIds: ['ghost', 'w1'], revision: 2 },
      workspaces: [
        { id: 'w1', title: 'Workspace One', path: '/work/w1' },
        { id: 'w2', title: 'Workspace Two', path: '/work/w2' },
      ],
      staleWorkspaceIds: ['ghost'],
      pathUnmatched: [{ agentId: 'agent-stray', cwd: '/work/stray' }],
      host: { state: 'ready', capable: true, reason: expect.any(String), degraded: [] },
    })
    expect(Array.isArray(json.host.degraded)).toBe(true)
    expect(json.host.capable).toBe(json.host.state === 'ready')
  })

  it('② rides the existing same-origin fence, with no new exception', async () => {
    const fixture = makeFixture({ workspaces: [W1] })
    await settle()

    const crossOrigin = await get(fixture, { origin: 'http://evil.example' })
    expect(crossOrigin.status).toBe(403)
    expect(crossOrigin.json).toEqual({ error: 'forbidden', message: expect.any(String) })

    const crossSite = await get(fixture, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(crossSite.status).toBe(403)
    expect(crossSite.json.error).toBe('forbidden')

    const sameOrigin = await get(fixture, { origin: `http://${HOST}` })
    expect(sameOrigin.status).toBe(200)

    // The write side is behind the SAME fence, and a refused request writes nothing.
    const refused = await put(fixture, { mode: 'selected', workspaceIds: [], expectedRevision: 0 })
    expect(refused.status).toBe(200)
    const refusedPut = await call(fixture, '/scope', {
      method: 'PUT',
      origin: 'http://evil.example',
      body: JSON.stringify({ mode: 'global', workspaceIds: [], expectedRevision: 1 }),
    })
    expect(refusedPut.status).toBe(403)
    expect(fixture.state.doc().revision).toBe(1)
    expect(fixture.state.doc().mode).toBe('selected')
  })
})

// ---------------------------------------------------------------------------
// ③ PUT success, and the await-free save → refresh critical section
// ---------------------------------------------------------------------------

describe('PUT /cherry-remote/api/scope', () => {
  it('③ saves, bumps the revision, prunes, and refreshes in the same await-free block', async () => {
    const fixture = makeFixture({
      workspaces: [W1, W2],
      agents: [{ id: 'agent-1', cwd: '/work/w1' }, { id: 'agent-2', cwd: '/work/w2' }],
      gate: true,
    })
    await settle()

    // The fixture parked the very first judgement pass: no generation exists yet.
    expect(fixture.rebuilds).toBe(1)
    expect(fixture.state.judgement('agent-1')).toBeUndefined()

    const { status, json } = await put(fixture, {
      mode: 'selected',
      workspaceIds: ['ghost', 'w1'],
      expectedRevision: 0,
    })

    expect(status).toBe(200)
    // The response carries the normalized document and the trimmed ids — and
    // NOTHING else: `refreshScope()`'s summary is the round's own echo, never
    // published as converged state (R24).
    expect(json).toEqual({ scope: { mode: 'selected', workspaceIds: ['w1'], revision: 1 }, pruned: ['ghost'] })
    // `revision` is monotonic +1 and the stored authority is that same document.
    expect(fixture.state.doc().revision).toBe(1)
    expect(fixture.state.doc().mode).toBe('selected')
    expect(fixture.state.doc().workspaceIds).toEqual(['w1'])

    // The parked round did NOT delay the answer, and the save started no second
    // round in parallel (the gate coalesced the trigger instead).
    const afterPut = fixture.rebuilds
    expect(afterPut).toBe(1)
    expect(fixture.roundsInFlight).toBe(1)

    // §6.3's hard constraint: `save` completed, then `refreshScope()` was called
    // with NO await between them — the microtask queued inside `save` is still
    // BEHIND the refresh call.
    expect(fixture.order.indexOf('save')).toBeLessThan(fixture.order.indexOf('refresh'))
    expect(fixture.order.indexOf('save-microtask')).toBeGreaterThan(fixture.order.indexOf('refresh'))
    expect(fixture.refreshCalls).toHaveLength(1)
    // …and the recorded summary is the SYNCHRONOUS pass's echo only: the release
    // that convergence performs below is deliberately not in it (R24).
    expect(fixture.refreshCalls[0]).toEqual({ agents: 2, installed: 0, released: 0, skipped: 2 })

    // Release the in-flight round: at most the coalesced catch-up is owed, and it
    // is enough (B4) for EVERY live agent's layer to match the new document.
    fixture.openGate()
    await settle()

    expect(fixture.state.judgement('agent-1')).toMatchObject({ workspaceId: 'w1', visible: true })
    expect(fixture.state.judgement('agent-2')).toMatchObject({ workspaceId: 'w2', visible: false })
    expect(fixture.fake.layerCount('agent-1')).toBe(0)
    expect(fixture.fake.agentView('agent-1')).toEqual(FAMILY)
    expect(fixture.fake.layerCount('agent-2')).toBe(1)
    expect(fixture.fake.agentView('agent-2')).toEqual([])

    // The parked pass plus the catch-up it was owed, and its own no-op fixpoint
    // pass — bounded, never overlapping.
    expect(fixture.roundsInFlight).toBe(1)
    expect(fixture.rebuilds - afterPut).toBeLessThanOrEqual(2)
  })

  it('④ refuses an invalid scope with 400 invalid-scope, leaving the document alone', async () => {
    const fixture = makeFixture({
      workspaces: [W1],
      seed: seedDoc({ revision: 4, mode: 'global', workspaceIds: [] }),
    })
    await settle()
    const before = readFileSync(fixture.scopeFile, 'utf8')

    for (const body of [
      { mode: 'everyone', workspaceIds: [], expectedRevision: 4 },
      { mode: 'selected', workspaceIds: 'w1', expectedRevision: 4 },
      { mode: 'selected', workspaceIds: ['w1', 7], expectedRevision: 4 },
      { mode: 'selected', workspaceIds: {}, expectedRevision: 4 },
    ]) {
      const { status, json } = await put(fixture, body)
      expect(status).toBe(400)
      expect(json).toEqual({ error: 'invalid-scope', message: expect.any(String) })
    }

    expect(fixture.state.doc().revision).toBe(4)
    expect(fixture.state.doc().mode).toBe('global')
    expect(fixture.state.doc().workspaceIds).toEqual([])
    expect(readFileSync(fixture.scopeFile, 'utf8')).toBe(before)
  })

  it('⑤ refuses a body without a base revision: 400 missing-expected-revision', async () => {
    const fixture = makeFixture({ workspaces: [W1] })
    await settle()

    // A deliberate tightening over the connection-scopes precedent: `undefined`
    // is refused rather than treated as "no expectation".
    const { status, json } = await put(fixture, { mode: 'selected', workspaceIds: ['w1'] })
    expect(status).toBe(400)
    expect(json).toEqual({ error: 'missing-expected-revision', message: expect.any(String) })
    expect(fixture.state.doc().revision).toBe(0)
    // Nothing was written: no document existed before, and none does now.
    expect(existsSync(fixture.scopeFile)).toBe(false)
  })

  it('⑥ answers 409 with a string error constant naming the current revision, and writes nothing', async () => {
    const fixture = makeFixture({
      workspaces: [W1],
      seed: seedDoc({ revision: 3, mode: 'global', workspaceIds: [] }),
    })
    await settle()
    const before = readFileSync(fixture.scopeFile, 'utf8')

    const { status, json } = await put(fixture, { mode: 'selected', workspaceIds: ['w1'], expectedRevision: 2 })
    expect(status).toBe(409)
    expect(typeof json.error).toBe('string')
    expect(json.error).toBe('scope-revision-conflict')
    expect(json.message).toContain('revision=3')
    expect(fixture.state.doc().revision).toBe(3)
    expect(fixture.state.doc().mode).toBe('global')
    expect(readFileSync(fixture.scopeFile, 'utf8')).toBe(before)
  })

  it('⑦ lets exactly one of two concurrent same-base PUTs through', async () => {
    const fixture = makeFixture({ workspaces: [W1, W2] })
    await settle()

    const [first, second] = await Promise.all([
      put(fixture, { mode: 'selected', workspaceIds: ['w1'], expectedRevision: 0 }),
      put(fixture, { mode: 'selected', workspaceIds: ['w2'], expectedRevision: 0 }),
    ])

    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 409])
    const loser = first.status === 409 ? first : second
    const winner = first.status === 200 ? first : second
    expect(loser.json.error).toBe('scope-revision-conflict')
    expect(loser.json.message).toContain('revision=1')

    // Exactly one increment: the validation and the write are one critical
    // section, so the second save cannot have applied on top of the first.
    expect(fixture.state.doc().revision).toBe(1)
    expect(winner.json.scope.revision).toBe(1)
    expect(fixture.state.doc().workspaceIds).toEqual(winner.json.scope.workspaceIds)
    expect(fixture.state.doc().mode).toBe(winner.json.scope.mode)
  })

  it('⑧ refuses the write while the workspace list is unreadable (503 workspace-list-unavailable)', async () => {
    const fixture = makeFixture({
      listThrows: true,
      seed: seedDoc({ revision: 5, mode: 'global', workspaceIds: ['ghost'] }),
    })
    await settle()
    const before = readFileSync(fixture.scopeFile, 'utf8')

    const { status, json } = await put(fixture, { mode: 'selected', workspaceIds: ['w1'], expectedRevision: 5 })
    expect(status).toBe(503)
    expect(json).toEqual({ error: 'workspace-list-unavailable', message: expect.any(String) })

    // Neither pruned nor written: `mode` and `workspaceIds` are untouched, byte
    // for byte on disk as well.
    expect(fixture.state.doc().revision).toBe(5)
    expect(fixture.state.doc().mode).toBe('global')
    expect(fixture.state.doc().workspaceIds).toEqual(['ghost'])
    expect(readFileSync(fixture.scopeFile, 'utf8')).toBe(before)

    // "Cannot read the list" is never reported as "every id is stale".
    const read = await get(fixture)
    expect(read.json.staleWorkspaceIds).toEqual([])
    expect(degradedSources(read.json)).toEqual(['workspace-list'])
  })

  it('⑨ refuses to touch a version:2 document (503 scope-version-unsupported)', async () => {
    const fixture = makeFixture({
      workspaces: [W1],
      seed: seedDoc({ version: 2, revision: 7, mode: 'global', workspaceIds: ['ghost'] }),
    })
    await settle()
    const before = readFileSync(fixture.scopeFile, 'utf8')

    const read = await get(fixture)
    expect(read.status).toBe(200)
    expect(degradedSources(read.json)).toEqual(['scope-version'])

    const { status, json } = await put(fixture, { mode: 'selected', workspaceIds: ['w1'], expectedRevision: 0 })
    expect(status).toBe(503)
    expect(json).toEqual({ error: 'scope-version-unsupported', message: expect.any(String) })

    // Neither pruned nor written: the newer document is untouched, on disk and
    // in memory.
    expect(readFileSync(fixture.scopeFile, 'utf8')).toBe(before)
    expect(fixture.state.doc().mode).toBe('selected')
    expect(fixture.state.doc().workspaceIds).toEqual([])
    expect(fixture.state.doc().revision).toBe(0)
  })

  it('⑩ carries pathUnmatched on its own channel — never as a degradation', async () => {
    const fixture = makeFixture({
      workspaces: [W1],
      agents: [{ id: 'agent-1', cwd: '/work/w1' }, { id: 'agent-stray', cwd: '/work/elsewhere' }],
      seed: seedDoc({ revision: 1, mode: 'selected', workspaceIds: ['w1'] }),
    })
    await settle()

    const { json } = await get(fixture)
    expect(json.pathUnmatched).toEqual([{ agentId: 'agent-stray', cwd: '/work/elsewhere' }])
    // Diagnostics, NOT degradation: no note mentions the stray agent, and the
    // channel is not derived from (nor into) `staleWorkspaceIds`.
    expect(json.host.degraded).toEqual([])
    expect(json.staleWorkspaceIds).toEqual([])
    expect(fixture.fake.agentView('agent-stray')).toEqual([])
  })

  it('⑪ keeps serving and accepting a save while the host is pending (D9 self-rescue)', async () => {
    const fixture = makeFixture({
      deferInjection: true,
      seed: seedDoc({ revision: 0, mode: 'selected', workspaceIds: ['ghost'] }),
    })
    await settle()

    const read = await get(fixture)
    expect(read.status).toBe(200)
    expect(read.json.host.state).toBe('pending')
    expect(read.json.host.capable).toBe(false)
    expect(read.json.host.capable).toBe(read.json.host.state === 'ready')
    // "Never read" is not "could not be read": no `workspace-list` note.
    expect(read.json.host.degraded).toEqual([])
    expect(read.json.staleWorkspaceIds).toEqual([])
    expect(read.json.workspaces).toEqual([])

    // A scope write does not depend on host injection arriving — an excluded
    // workspace must be able to rescue itself.
    const { status, json } = await put(fixture, {
      mode: 'selected',
      workspaceIds: ['ghost', 'fresh'],
      expectedRevision: 0,
    })
    expect(status).toBe(200)
    expect(json.pruned).toEqual([])
    expect(json.scope.revision).toBe(1)
    expect(json.scope.workspaceIds).toEqual(['fresh', 'ghost'])
    // No authoritative list ⇒ no pruning: 'ghost' survives.
    expect(fixture.state.doc().workspaceIds).toContain('ghost')
    // No round to run: the round's own echo is `undefined` (Task 6's contract).
    expect(fixture.refreshCalls).toEqual([undefined])

    const after = await get(fixture)
    expect(after.json.host.degraded).toEqual([])
    expect(after.json.scope).toEqual({ mode: 'selected', workspaceIds: ['fresh', 'ghost'], revision: 1 })
  })

  it('⑫ answers 405 for every other method, without reading the body or writing', async () => {
    const fixture = makeFixture({
      workspaces: [W1],
      seed: seedDoc({ revision: 2, mode: 'global', workspaceIds: [] }),
    })
    await settle()
    const before = readFileSync(fixture.scopeFile, 'utf8')

    for (const method of ['POST', 'DELETE', 'PATCH', 'HEAD']) {
      const { status, json } = await call(fixture, '/scope', {
        method,
        body: JSON.stringify({ mode: 'selected', workspaceIds: ['w1'], expectedRevision: 2 }),
        // Would throw inside `readJsonBody` if the route read it at all.
        unreadableBody: true,
      })
      expect(status).toBe(405)
      expect(json).toEqual({ error: 'method-not-allowed', message: 'GET/PUT only' })
    }

    expect(fixture.state.doc().revision).toBe(2)
    expect(readFileSync(fixture.scopeFile, 'utf8')).toBe(before)
  })

  it('⑬ keeps three degradation sources visible at once, one entry per source', async () => {
    const fixture = makeFixture({
      // `guard` absent ⇒ visibility-only; `list()` throws ⇒ workspace-list;
      // `run_code` in the deny set is what the fake host refuses ⇒ install.
      without: ['guard'],
      listThrows: true,
      names: [...FAMILY, 'run_code'],
      agents: [{ id: 'agent-a', cwd: '/work/a' }, { id: 'agent-b', cwd: '/work/b' }],
    })
    await settle()

    const first = await get(fixture)
    expect(Array.isArray(first.json.host.degraded)).toBe(true)
    expect(degradedSources(first.json)).toEqual(['install', 'visibility-only', 'workspace-list'])
    for (const note of first.json.host.degraded) expect(note.reason.length).toBeGreaterThan(0)

    // Re-trigger ONE source: a third agent fails its install too. Same source ⇒
    // still exactly one entry, carrying the LATEST reason; the other two sources
    // are not overwritten by it.
    fixture.fake.addAgent({ id: 'agent-c' })
    await settle()

    const second = await get(fixture)
    expect(degradedSources(second.json)).toEqual(['install', 'visibility-only', 'workspace-list'])
    const installNotes = second.json.host.degraded.filter((note: { source: string }) => note.source === 'install')
    expect(installNotes).toHaveLength(1)
    expect(installNotes[0].reason).toContain('agent-c')
    expect(second.json.host.degraded).toHaveLength(3)
  })
})
