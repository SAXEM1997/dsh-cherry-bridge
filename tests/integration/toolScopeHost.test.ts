/**
 * Task 4 — the host integration layer and the SINGLE assembly point.
 *
 * Two levels are driven here, and they are deliberately different things:
 *
 *  - the HOST-level fixtures below (`FakeToolHost` + `mount()`) pin the capability
 *    tri-state, the injection gate, the co-lifecycle of registration / hiding /
 *    guard and the teardown order;
 *  - the ASSEMBLY-level case (⑧) drives the real `apply()` through a minimal
 *    assembly ctx, which is the only thing that can prove the plugin actually
 *    MOUNTS the subsystem. Without it a host that is instantiated but never
 *    mounted would still turn every host-level test green while production
 *    registers zero tools.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CHERRY_TOOL_NAMES, registerCherryTools } from '../../src/tools.js'
import type { CherryToolsDeps } from '../../src/tools.js'
import { ToolScopeState } from '../../src/toolScope.js'
import { createToolScopeHost, registerAtomically } from '../../src/toolScopeHost.js'
import type { ScopeHostContext } from '../../src/toolScopeHost.js'
import { FakeToolHost } from '../helpers/fakeToolHost.js'
import type { FakeCapability, FakeRestrictCall } from '../helpers/fakeToolHost.js'

const dirs: string[] = []
let warn: ReturnType<typeof vi.fn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  // The assembly's HTTP half announces its mount; keep the run's output clean.
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Deps that must never be touched by registration alone (mirrors the contract rig). */
function inertToolDeps(): CherryToolsDeps {
  return {
    store: null as never,
    connect: () => {
      throw new Error('registration must not resolve a connection')
    },
    subs: () => {
      throw new Error('registration must not read subscriptions')
    },
    pair: async () => {
      throw new Error('registration must not pair')
    },
    evict: () => {
      throw new Error('registration must not evict')
    },
  }
}

interface RigOptions {
  deferInjection?: boolean
  injectThrows?: boolean
  without?: readonly FakeCapability[]
  /** Override the aggregate registration entry (⑦). */
  registerTools?: (host: FakeToolHost) => () => void
  /**
   * Runs against the fake host BEFORE `mount()` — the only window in which a
   * Task 5 fixture can add live agents, register extra tools or wrap the root
   * face / the injection callback (a throwing `guard` or `on`, R16).
   */
  patchRoot?: (host: FakeToolHost) => void
}

/** One host-level rig: a fake host plus a real scope state and a real mount. */
function rig(options: RigOptions = {}) {
  const host = new FakeToolHost({
    ...(options.deferInjection === undefined ? {} : { deferInjection: options.deferInjection }),
    ...(options.injectThrows === undefined ? {} : { injectThrows: options.injectThrows }),
    ...(options.without === undefined ? {} : { without: options.without }),
  })
  const dir = mkdtempSync(join(tmpdir(), 'cherry-scope-host-'))
  dirs.push(dir)
  const scope = new ToolScopeState({ file: join(dir, 'scope.json') })
  scope.load()

  const tools = createToolScopeHost({
    scope,
    names: CHERRY_TOOL_NAMES,
    // The production shape: ONE aggregate disposer, registering through the
    // plugin root ctx (the same call the assembly makes), through the same
    // atomic entry `apply()` uses. The factory runs when the effect actually
    // registers, never at rig-construction time.
    registerTools: () =>
      options.registerTools?.(host) ??
      registerAtomically(host.root, (toolsCtx) => registerCherryTools(toolsCtx, inertToolDeps())),
  })
  options.patchRoot?.(host)
  const dispose = tools.mount(host.root)
  return { host, scope, tools, dispose }
}

/** The teardown phases of §6.2's merged disposer, in the order they must occur. */
function teardownPhases(ops: ReadonlyArray<{ op: string }>): string[] {
  const wanted = new Set(['unsubscribe', 'unregister', 'release-layer', 'guard-release'])
  return ops.map((entry) => entry.op).filter((op) => wanted.has(op))
}

describe('T4 host integration: tri-state, injection gate and co-lifecycle', () => {
  it('① pending: a mount() whose injection callback has not arrived registers nothing', () => {
    const { host, tools } = rig({ deferInjection: true })
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })

    const state = tools.state()
    expect(state.state).toBe('pending')
    expect(state.capable).toBe(false)
    // 中性等待措辞: the pending state must never read as "the host refuses".
    expect(state.reason).not.toMatch(/不支持|unsupported/i)

    expect(host.registeredNames()).toEqual([])
    expect(host.layerTotal()).toBe(0)
    expect(host.guardLive()).toBe(0)
    expect(host.liveSubscriptions()).toBe(0)
    expect(host.injectedEffectRuns).toBe(0)

    // The callback's LATER arrival is the other half of the same gate: `pending`
    // is a wait, not a refusal.
    host.deliverInjection()
    expect(tools.state().state).toBe('ready')
    expect(tools.state().capable).toBe(true)
    expect(host.registeredNames()).toHaveLength(14)
    expect(host.layerCount('agent-a')).toBe(1)
  })

  it('② unsupported: register / restrict / schemas are each a hard gate (static failure wins)', () => {
    for (const missing of ['register', 'restrict', 'schemas'] as const) {
      // The capability is removed from the ROOT ctx's face before mount(), and
      // the injection callback never arrives: the static failure must decide.
      const { host, scope, tools } = rig({ deferInjection: true, without: [missing] })

      const state = tools.state()
      expect(state.state, missing).toBe('unsupported')
      expect(state.capable, missing).toBe(false)
      expect(state.reason, missing).toContain(`tools.${missing}`)
      expect(host.registeredNames(), missing).toEqual([])
      expect(host.injectedEffectRuns, missing).toBe(0)
      // B7①: an unsupported host is NOT the visibility-only degradation.
      expect(scope.degraded().map((note) => note.source), missing).not.toContain('visibility-only')

      // Arriving the injection afterwards must not turn it into `ready`.
      host.deliverInjection()
      expect(tools.state().state, missing).toBe('unsupported')
      expect(host.registeredNames(), missing).toEqual([])
    }

    // 既有 headless 语义不变: exactly one warning per mount, naming the real gap.
    expect(warn).toHaveBeenCalledTimes(3)
    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(messages.some((message) => message.includes('tools.register'))).toBe(true)
    expect(messages.some((message) => message.includes('tools.restrict'))).toBe(true)
    expect(messages.some((message) => message.includes('tools.schemas'))).toBe(true)
  })

  it('③ ready: registers exactly the 14 names and hides every live agent', () => {
    const { host, scope, tools } = rig()
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    host.addAgent({ id: 'agent-b' })

    const state = tools.state()
    expect(state.state).toBe('ready')
    expect(state.capable).toBe(true)
    // B7④: capable is ONLY the boolean projection of `state === 'ready'`.
    expect(state.capable).toBe(state.state === 'ready')

    expect(host.registeredNames()).toHaveLength(14)
    expect([...host.registeredNames()].sort()).toEqual([...CHERRY_TOOL_NAMES].sort())

    for (const agentId of host.liveAgentIds()) {
      expect(host.layerCount(agentId), agentId).toBe(1)
      expect(host.agentView(agentId).filter((name) => name.startsWith('cherry_')), agentId).toEqual([])
      expect(scope.layer(agentId), agentId).toBeDefined()
    }
    expect(host.guardLive()).toBe(1)
    expect(host.liveSubscriptions('agent/created')).toBe(1)
    expect(host.liveSubscriptions('agent/disposed')).toBe(1)
  })

  it('④ dependency unload releases registration, layers, guard and both subscriptions together', async () => {
    const { host, scope } = rig()
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    // Let the first judgement generation land, so "invalidated by the teardown"
    // is a real transition rather than an assertion about a state that never was.
    await vi.waitFor(() => {
      expect(scope.judgement('agent-a')).toBeDefined()
    })
    // Let the round's own re-application finish before the teardown is measured.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(host.registeredNames()).toHaveLength(14)
    const listCallsBefore = host.listCalls()
    const opsBefore = host.ops.length

    host.unloadDependencies()

    expect(host.registeredNames()).toEqual([])
    expect(host.layerTotal()).toBe(0)
    expect(host.guardLive()).toBe(0)
    expect(host.liveSubscriptions()).toBe(0)

    // The §6.1 derived state is invalidated with the same disposer.
    expect(scope.layer('agent-a')).toBeUndefined()
    expect(scope.judgement('agent-a')).toBeUndefined()
    expect(scope.pathUnmatched()).toEqual([])

    // The FIXED teardown order is what makes "registered but not hidden"
    // structurally impossible: every unsubscribe precedes every unregister,
    // every unregister precedes every layer release, and the guard goes last
    // (it notifies nobody, so it is the harmless last backstop).
    const phases = teardownPhases(host.ops.slice(opsBefore))
    expect(phases.filter((op) => op === 'unsubscribe')).toHaveLength(2)
    expect(phases.filter((op) => op === 'unregister')).toHaveLength(14)
    expect(phases.filter((op) => op === 'release-layer')).toHaveLength(1)
    expect(phases.filter((op) => op === 'guard-release')).toHaveLength(1)
    const firstUnregister = phases.indexOf('unregister')
    const firstRelease = phases.indexOf('release-layer')
    const guardRelease = phases.indexOf('guard-release')
    expect(phases.slice(0, firstUnregister).every((op) => op === 'unsubscribe')).toBe(true)
    expect(phases.slice(firstUnregister, firstRelease).every((op) => op === 'unregister')).toBe(true)
    expect(phases.slice(firstRelease, guardRelease).every((op) => op === 'release-layer')).toBe(true)
    expect(guardRelease).toBe(phases.length - 1)

    // 重算计数不发生: the torn-down subsystem schedules no further round.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(host.listCalls()).toBe(listCallsBefore)
  })

  it('⑤ dependency reload restores everything, without already-registered and with one layer each', () => {
    const { host, tools } = rig()
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    expect(host.registeredNames()).toHaveLength(14)

    host.unloadDependencies()
    expect(host.registeredNames()).toEqual([])
    expect(host.layerCount('agent-a')).toBe(0)

    expect(() => host.reloadDependencies()).not.toThrow()
    expect(host.registeredNames()).toHaveLength(14)
    expect(host.guardLive()).toBe(1)
    expect(host.layerCount('agent-a')).toBe(1)
    expect(host.liveSubscriptions('agent/created')).toBe(1)
    expect(host.liveSubscriptions('agent/disposed')).toBe(1)
    expect(tools.state().state).toBe('ready')

    // A brand new agent after the re-mount still gets exactly ONE layer.
    host.addAgent({ id: 'agent-b', cwd: '/w/oa' })
    expect(host.layerCount('agent-b')).toBe(1)
    expect(host.registeredNames()).toHaveLength(14)
  })

  it('⑥ a missing guard degrades to visibility-only without refusing registration', () => {
    const { host, scope, tools } = rig({ without: ['guard'] })
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })

    expect(tools.state().state).toBe('ready')
    expect(host.registeredNames()).toHaveLength(14)
    expect(host.layerCount('agent-a')).toBe(1)
    expect(host.guardLive()).toBe(0)

    const note = scope.degraded().find((entry) => entry.source === 'visibility-only')
    expect(note).toBeDefined()
    expect(note?.reason).toContain('guard')
  })

  it('⑦ registerTools returns ONE aggregate disposer, called exactly once', () => {
    const calls = { dispose: 0 }
    const releases: Array<() => void> = []
    const { host } = rig({
      registerTools: (fake) => {
        for (const name of ['cherry_devices', 'cherry_read', 'cherry_wait']) {
          releases.push(
            fake.root.tools!.register({ name, description: name, execute: async () => undefined }),
          )
        }
        return () => {
          calls.dispose += 1
          for (const release of releases.splice(0)) release()
        }
      },
    })

    expect(host.registeredNames()).toHaveLength(3)
    host.unloadDependencies()
    // The single aggregate entry point ran once — never "three disposers, three calls".
    expect(calls.dispose).toBe(1)
    expect(host.registeredNames()).toEqual([])
  })

  it('⑨ agent/disposed releases that agent layer, clears its record and restores its view', () => {
    const { host, scope } = rig()
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    host.addAgent({ id: 'agent-b', cwd: '/w/oa' })
    expect(host.agentView('agent-a')).toEqual([])
    const releasesBefore = host.ops.filter((entry) => entry.op === 'release-layer').length

    host.disposeAgent('agent-a')

    expect(host.ops.filter((entry) => entry.op === 'release-layer')).toHaveLength(releasesBefore + 1)
    expect(host.layerCount('agent-a')).toBe(0)
    expect(scope.layer('agent-a')).toBeUndefined()
    // …and the cherry_* names are back in that agent's tool table.
    expect(host.agentView('agent-a')).toEqual([...CHERRY_TOOL_NAMES])
    // The sibling is untouched.
    expect(host.layerCount('agent-b')).toBe(1)
    expect(host.liveAgentIds()).toEqual(['agent-b'])
  })

  it('⑩ repeated callbacks inside one effect run never re-register and never stack layers', () => {
    const { host, tools } = rig()
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    expect(host.registerCalls).toHaveLength(14)

    // Repeated deliveries of the same agent/created, plus an extra round trip
    // through the recompute entry point.
    for (let round = 0; round < 3; round += 1) host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    host.addAgent({ id: 'agent-b', cwd: '/w/oa' })
    const summary = tools.refresh()

    expect(summary?.agents).toBe(2)
    // Only ONE effect run happened, and registration does not follow the agent
    // count or the event count.
    expect(host.injectedEffectRuns).toBe(1)
    expect(host.registerCalls).toHaveLength(14)
    expect(host.registeredNames()).toHaveLength(14)
    expect(host.layerCount('agent-a')).toBe(1)
    expect(host.layerCount('agent-b')).toBe(1)
  })

  it('⑪(d) an inject() that throws leaves mount() alive, pending and empty — with a warning', () => {
    const { host, tools } = rig({ injectThrows: true })

    expect(tools.state().state).toBe('pending')
    expect(tools.state().capable).toBe(false)
    expect(host.registeredNames()).toEqual([])
    expect(host.layerTotal()).toBe(0)
    expect(host.liveEffects()).toBe(0)
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/agents|workspaceRegistry/)
  })

  it('⑫ a throwing registerTools leaves no half-built generation behind', () => {
    const { host, tools } = rig({
      registerTools: (fake) =>
        registerAtomically(fake.root, (toolsCtx) => {
          // The partial-registration case is REAL: two tools land in the host
          // registry before the third call is refused. (The ledger's face is the
          // minimal registration shape, so a definition carries no `execute`.)
          toolsCtx.tools!.register({ name: 'cherry_devices', description: 'devices' })
          toolsCtx.tools!.register({ name: 'cherry_read', description: 'read' })
          throw new Error('the host refused the third registration')
        }),
    })
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })

    // The effect body CONTAINED the failure: nothing escaped into the delivery
    // site (a real host may deliver the injection callback asynchronously, once
    // `mount()`'s `try` is long off the stack).
    expect(host.effectFailures).toEqual([])
    // The factory really did register two tools before throwing…
    expect(host.registerCalls).toEqual(['cherry_devices', 'cherry_read'])
    // …and not one of them survived: the atomic entry point released the partial
    // set, so the host registry is left exactly as it was.
    expect(host.registeredNames()).toEqual([])
    // Nothing was installed, and the tri-state says so — never `ready`.
    expect(host.layerTotal()).toBe(0)
    expect(host.guardLive()).toBe(0)
    expect(host.liveSubscriptions()).toBe(0)
    expect(tools.state().state).not.toBe('ready')
    expect(tools.state().capable).toBe(tools.state().state === 'ready')
    // Reported, never silent (B7③: the real cause is named).
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('cherry_*')
    expect(tools.state().reason).toContain('cherry_*')

    // THE HARM CHAIN: a later `refresh()` — wired to the `/scope` route by Task 7
    // — must be INERT. With a live half-built generation it would install a
    // restriction layer for `agent-a` while the tri-state claims that nothing is
    // registered, and would report a successful round.
    const listCallsBefore = host.listCalls()
    expect(tools.refresh()).toBeUndefined()
    expect(host.layerTotal()).toBe(0)
    expect(host.guardLive()).toBe(0)
    expect(host.registeredNames()).toEqual([])
    expect(host.listCalls()).toBe(listCallsBefore)

    // The assembly's release path stays safe to drive.
    expect(() => host.unloadDependencies()).not.toThrow()
    expect(host.layerTotal()).toBe(0)
  })

  it('⑬ a failed setup keeps refresh() inert even when the host still knows the names', () => {
    // The worst case a NON-atomic producer can leave behind: the host registry
    // still knows all 14 names, so an installation would SUCCEED if this layer
    // ever acted on the failed setup. `current` must therefore never become live
    // for a generation that did not finish — that is this layer's own guarantee,
    // independent of the producer-side atomicity ⑫ pins.
    const { host, tools } = rig({
      registerTools: (fake) => {
        for (const name of CHERRY_TOOL_NAMES) {
          fake.root.tools!.register({ name, description: name, execute: async () => undefined })
        }
        throw new Error('the host refused the last registration')
      },
    })
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })

    expect(host.effectFailures).toEqual([])
    expect(host.registeredNames()).toHaveLength(14)
    expect(host.layerTotal()).toBe(0)
    expect(host.guardLive()).toBe(0)
    expect(tools.state().state).not.toBe('ready')

    // The harm: a live half-built generation would install a deny layer here
    // (`selected` + an empty judgement cache is the fail-closed side) and report
    // a successful round while the tri-state says nothing is registered.
    expect(tools.refresh()).toBeUndefined()
    expect(host.layerTotal()).toBe(0)
    expect(host.guardLive()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ⑧ the ASSEMBLY point: the production `apply()` really mounts the host
// ---------------------------------------------------------------------------

interface AssemblyFixture {
  ctx: Record<string, unknown>
  effects: Array<() => void>
  /** A SEPARATE bucket: the subsystem's effect must not enter the root's. */
  injectedEffects: Array<() => void>
  definitions: Array<{ name: string; description: string }>
  routes: Map<string, unknown>
}

/**
 * The same dependency-key split the three existing assembly fixtures get: the
 * web keys answer with `webServer`/`webRuntime`, the two scope keys answer with
 * `agents`/`workspaceRegistry` plus the injected ctx's own `effect`/`on`.
 */
function assemblyCtx(options: { deferAgents?: boolean } = {}): AssemblyFixture {
  const routes = new Map<string, unknown>()
  const effects: Array<() => void> = []
  const injectedEffects: Array<() => void> = []
  const definitions: Array<{ name: string; description: string }> = []
  const subscriptions = new Map<string, Set<(payload: unknown) => void>>()

  const inside = {
    agents: { list: () => [] },
    workspaceRegistry: { list: () => [], resolveByPath: async () => undefined },
    effect(cb: () => () => void) {
      injectedEffects.push(cb())
    },
    on(event: string, cb: (payload: unknown) => void) {
      const listeners = subscriptions.get(event) ?? new Set()
      listeners.add(cb)
      subscriptions.set(event, listeners)
      return () => listeners.delete(cb)
    },
  }

  const ctx: Record<string, unknown> = {
    webServer: {
      routes,
      register(route: { path: string; handler: unknown }) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    webRuntime: { trustedHosts: [] },
    tools: {
      definitions,
      register(definition: { name: string; description: string }) {
        definitions.push(definition)
        return () => {
          const index = definitions.indexOf(definition)
          if (index >= 0) definitions.splice(index, 1)
        }
      },
      restrict() {
        throw new Error('tools.restrict() requires a scoped context (agent.ctx)')
      },
      guard() {
        return () => {}
      },
      schemas() {
        return definitions.map((definition) => ({ ...definition }))
      },
    },
    inject(deps: readonly string[], cb: (ctx: unknown) => unknown) {
      if (deps.includes('agents') || deps.includes('workspaceRegistry')) {
        if (options.deferAgents !== true) cb(inside)
        return
      }
      cb({ webServer: ctx['webServer'], webRuntime: ctx['webRuntime'] })
    },
    effect(cb: () => () => void) {
      effects.push(cb())
    },
  }

  return { ctx, effects, injectedEffects, definitions, routes }
}

describe('T4 ⑧ the assembly point: apply() mounts the host', () => {
  it('registers exactly the 14 cherry_* names on the real apply() path', async () => {
    const index = await import('../../src/index.js')
    const fixture = assemblyCtx()
    const dir = mkdtempSync(join(tmpdir(), 'cherry-scope-assembly-'))
    dirs.push(dir)

    try {
      expect(() => index.apply(fixture.ctx as never, { dataDir: dir })).not.toThrow()

      // The registration is the ONLY externally visible proof that the host was
      // instantiated AND mounted: nothing else reaches the tool registry.
      expect(fixture.definitions.map((definition) => definition.name).sort()).toEqual(
        [...CHERRY_TOOL_NAMES].sort(),
      )
      // The subsystem's lifecycle effect is the injected ctx's, never a second
      // root effect (the HTTP face's tests pin the root count at 1).
      expect(fixture.injectedEffects).toHaveLength(1)
      expect(fixture.effects).toHaveLength(1)
      // The web half still mounted, unchanged.
      expect(fixture.routes.size).toBe(1)
      await vi.waitFor(() => {
        expect(existsSync(join(dir, 'identity.key'))).toBe(true)
      })
    } finally {
      for (const dispose of fixture.effects.splice(0)) dispose()
    }
    // The root disposer took the registrations with it.
    expect(fixture.definitions).toEqual([])
  })

  it('registers nothing when the injection callback has not arrived', async () => {
    const index = await import('../../src/index.js')
    const fixture = assemblyCtx({ deferAgents: true })
    const dir = mkdtempSync(join(tmpdir(), 'cherry-scope-assembly-'))
    dirs.push(dir)

    try {
      expect(() => index.apply(fixture.ctx as never, { dataDir: dir })).not.toThrow()
      expect(fixture.definitions).toEqual([])
      expect(fixture.injectedEffects).toHaveLength(0)
      expect(fixture.effects).toHaveLength(1)
      expect(fixture.routes.size).toBe(1)
      await vi.waitFor(() => {
        expect(existsSync(join(dir, 'identity.key'))).toBe(true)
      })
    } finally {
      for (const dispose of fixture.effects.splice(0)) dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Task 5 (first half) — the install / release CRITERIA: the target set and its
// empty-set semantics, the install-failure path, the layer-mirroring guard and
// R16's "no host call escapes the effect body".
//
// The `tools/change` subscription and its coalescing gate are deliberately NOT
// exercised here (that is the second half of Task 5): every "completion" and
// every "retry" below is driven by the CONFIG-SAVE path the production caller
// uses after a successful PUT — `refresh()`.
// ---------------------------------------------------------------------------

/** One raw agent record, as the fake host hands it to `agent/created`. */
interface RawAgentRecord {
  id: string
  session: { header: { cwd?: string } }
  ctx: {
    tools: { restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void }
  }
}

/** Registers `names` on the host's GLOBAL face; returns their disposers. */
function registerOn(fake: FakeToolHost, names: readonly string[]): Array<() => void> {
  return names.map((name) =>
    fake.root.tools!.register({ name, description: name, execute: async () => undefined }),
  )
}

/** Captures the RAW agent records, so a fixture can stack its OWN layers. */
function captureAgents(host: FakeToolHost): Map<string, RawAgentRecord> {
  const captured = new Map<string, RawAgentRecord>()
  host.root.on?.<{ agent?: unknown }>('agent/created', (payload) => {
    const raw = payload?.agent as RawAgentRecord | undefined
    if (raw !== undefined && typeof raw.id === 'string') captured.set(raw.id, raw)
  })
  return captured
}

/** Wraps the injection callback so the ctx the plugin receives refuses ONE event. */
function refuseSubscription(fake: FakeToolHost, refused: string): void {
  const realInject = fake.root.inject as NonNullable<ScopeHostContext['inject']>
  fake.root.inject = ((keys: readonly string[], cb: (ctx: unknown) => void | (() => void)) =>
    realInject(keys, (ctx: unknown) => {
      const injected = ctx as {
        on?: (event: string, handler: (payload: unknown) => void) => () => void
      }
      const realOn = injected.on
      return cb({
        ...(ctx as Record<string, unknown>),
        on: (event: string, handler: (payload: unknown) => void) => {
          if (event === refused) throw new Error(`the host refused the "${event}" subscription`)
          return realOn!.call(injected, event, handler)
        },
      })
    })) as NonNullable<ScopeHostContext['inject']>
}

/** Lets one round's asynchronous judgement + re-application finish. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/** Writes the document through the PUBLIC save path (the production PUT). */
function saveScope(
  scope: ToolScopeState,
  mode: 'global' | 'selected',
  workspaceIds: readonly string[],
): void {
  const result = scope.save({ mode, workspaceIds }, scope.doc().revision)
  expect(result.ok, JSON.stringify(result)).toBe(true)
}

/** The deny names of one recorded `restrict()` call. */
function denyOf(call: FakeRestrictCall): string[] {
  return [...(call.filter.deny ?? [])]
}

/** Every `restrict` / `release-layer` action the host performed for one agent. */
function layerOps(host: FakeToolHost, agentId: string): Array<{ op: string; denyCount: number }> {
  const ops: ReadonlyArray<{ op: string; agentId?: string; filter?: { deny?: readonly string[] } }> =
    host.ops
  return ops
    .filter((entry) => entry.agentId === agentId && (entry.op === 'restrict' || entry.op === 'release-layer'))
    .map((entry) => ({ op: entry.op, denyCount: entry.filter?.deny?.length ?? 0 }))
}

describe('T5a install/release criteria: the target set, the empty set and the guard', () => {
  it('① the deny argument is the no-argument global view ∩ our names — never empty, never allow (B12①/B18③)', async () => {
    // A global view that holds MORE than our family: the intersection (not the
    // raw schemas() list, and not the static name list either) is what may be
    // submitted.
    const releases: Array<() => void> = []
    const { host, scope, tools } = rig({
      patchRoot: (fake) => registerOn(fake, ['bash', 'read']),
      registerTools: (fake) => {
        releases.push(...registerOn(fake, CHERRY_TOOL_NAMES))
        return () => {
          for (const release of releases.splice(0)) release()
        }
      },
    })
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await vi.waitFor(() => {
      expect(scope.judgement('agent-a')).toBeDefined()
    })
    await settle()

    /** The shape invariants that must hold for EVERY recorded argument. */
    const assertCallShape = (): void => {
      expect(host.restrictCalls.length).toBeGreaterThan(0)
      for (const call of host.restrictCalls) {
        expect(call.agentId).toBe('agent-a')
        // The filter carries `deny` and NOTHING else: a restriction the agent
        // INHERITS must never be narrowed by an `allow` allow-list (§4/D12).
        expect(Object.keys(call.filter)).toEqual(['deny'])
        expect(call.filter.allow).toBeUndefined()
        // …and it is never the empty set: `{ deny: [] }` installs a no-op layer
        // this plugin's own guard would misread as "already hidden".
        expect(denyOf(call).length).toBeGreaterThan(0)
        expect(denyOf(call)).not.toContain('bash')
      }
    }
    /** The arguments recorded from `from` onward are the CURRENT intersection. */
    const assertDenyEqualsIntersection = (from: number): void => {
      const observed = new Set(host.root.tools!.schemas!().map((definition) => definition.name))
      const intersection = [...CHERRY_TOOL_NAMES].filter((name) => observed.has(name)).sort()
      const calls = host.restrictCalls.slice(from)
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect([...denyOf(call)].sort()).toEqual(intersection)
      }
    }
    assertCallShape()
    assertDenyEqualsIntersection(0)
    // The visible effect of that one argument: our names are gone from the
    // agent's table while a foreign name stays.
    expect(host.agentView('agent-a').filter((name) => name.startsWith('cherry_'))).toEqual([])
    expect(host.agentView('agent-a')).toContain('bash')

    // One of our names leaves the global view ⇒ the NEXT argument must shrink to
    // the intersection as well: the static list alone is not a legal deny set.
    const recorded = host.restrictCalls.length
    releases.pop()!()
    expect(host.registeredNames()).toHaveLength(15)
    tools.refresh()
    assertCallShape()
    assertDenyEqualsIntersection(recorded)
    expect(scope.layer('agent-a')?.deny).toHaveLength(13)
    expect(host.layerCount('agent-a')).toBe(1)
  })

  it('② a zero-in-scene global view installs nothing — and never submits an empty deny (B18③)', async () => {
    // The registration has not happened yet, so the no-argument global view holds
    // none of our names: the intersection is empty, and an empty deny must NOT be
    // submitted (it would install a no-op layer the guard reads as "hidden").
    const staged: { register: () => void } = { register: () => {} }
    const releases: Array<() => void> = []
    const { host, scope, tools } = rig({
      registerTools: (fake) => {
        staged.register = () => {
          for (const release of registerOn(fake, CHERRY_TOOL_NAMES)) releases.push(release)
        }
        return () => {
          for (const release of releases.splice(0)) release()
        }
      },
    })
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await vi.waitFor(() => {
      expect(scope.judgement('agent-a')).toBeDefined()
    })
    await settle()

    expect(host.registeredNames()).toEqual([])
    expect(host.restrictCalls).toEqual([])
    expect(host.layerCount('agent-a')).toBe(0)
    expect(scope.layer('agent-a')).toBeUndefined()
    expect(host.effectFailures).toEqual([])
    expect(tools.state().state).toBe('ready')

    // The completion rides the config-save path: exactly ONE installation, and it
    // is the full 14-name intersection.
    staged.register()
    expect(host.registeredNames()).toHaveLength(14)
    tools.refresh()
    expect(host.restrictCalls).toHaveLength(1)
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')?.deny).toHaveLength(14)

    // An EXISTING layer is still maintained when the view empties: releasing it is
    // the "维持既有层" half of B18③, not a second failed installation.
    for (const release of releases.splice(0)) release()
    expect(host.registeredNames()).toEqual([])
    tools.refresh()
    expect(host.restrictCalls).toHaveLength(1)
    expect(host.layerCount('agent-a')).toBe(0)
    expect(scope.layer('agent-a')).toBeUndefined()
  })

  it('② a partial registration window installs what is in scene, then completes (B12③/B18④)', async () => {
    // HMR's mid-flight state: only 7 of the 14 are in the global view.
    const later: Array<() => void> = []
    const { host, scope, tools } = rig({
      registerTools: (fake) => {
        const first = registerOn(fake, CHERRY_TOOL_NAMES.slice(0, 7))
        later.push(() => {
          registerOn(fake, CHERRY_TOOL_NAMES.slice(7))
        })
        return () => {
          for (const release of first.splice(0)) release()
        }
      },
    })
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await settle()

    // Installed with the 7 names that exist — never with 14, and never refused.
    expect(host.restrictCalls).toHaveLength(1)
    expect(denyOf(host.restrictCalls[0]!)).toEqual([...CHERRY_TOOL_NAMES.slice(0, 7)])
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')?.deny).toHaveLength(7)
    expect(host.agentView('agent-a').filter((name) => name.startsWith('cherry_'))).toEqual([])

    // The rest arrive; the config save completes the layer — still ONE layer.
    later[0]!()
    expect(host.registeredNames()).toHaveLength(14)
    tools.refresh()

    expect(host.restrictCalls).toHaveLength(2)
    expect([...denyOf(host.restrictCalls[1]!)].sort()).toEqual([...CHERRY_TOOL_NAMES].sort())
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')?.deny).toHaveLength(14)
  })

  it('③ a target that becomes empty releases only — the tools return (B18①/B2)', async () => {
    const { host, scope, tools } = rig()
    host.setWorkspaces([{ id: 'w-oa', title: 'OA', path: '/w/oa', sessionIds: ['agent-a'] }])
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await vi.waitFor(() => {
      expect(scope.judgement('agent-a')).toBeDefined()
    })
    await settle()

    // `selected` with nobody enabled ⇒ hidden.
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')).toBeDefined()
    expect(host.agentView('agent-a').filter((name) => name.startsWith('cherry_'))).toEqual([])

    // The operator enables the agent's workspace and the config save runs.
    const installs = host.restrictCalls.length
    const releases = host.ops.filter((entry) => entry.op === 'release-layer').length
    saveScope(scope, 'selected', ['w-oa'])
    expect(tools.refresh()?.released).toBe(1)

    // RELEASE ONLY: no installation was submitted for a now-visible agent…
    expect(host.restrictCalls.length).toBe(installs)
    expect(host.ops.filter((entry) => entry.op === 'release-layer').length).toBe(releases + 1)
    // …its layer is gone, its record with it, and the family is back in its table.
    expect(host.layerCount('agent-a')).toBe(0)
    expect(scope.layer('agent-a')).toBeUndefined()
    expect(host.agentView('agent-a')).toEqual([...CHERRY_TOOL_NAMES])
    // No layer ⇒ the execution-side mirror allows (the guard is not a second
    // criterion: it only mirrors the record).
    expect(host.verdict('agent-a', 'cherry_devices')).toBeUndefined()

    // Hidden again, then switched to `global`: `global` counts as visible under
    // the SAME definition (B2) ⇒ release only.
    saveScope(scope, 'selected', [])
    tools.refresh()
    expect(host.layerCount('agent-a')).toBe(1)
    const installsBeforeGlobal = host.restrictCalls.length
    saveScope(scope, 'global', [])
    tools.refresh()
    expect(host.restrictCalls.length).toBe(installsBeforeGlobal)
    expect(host.layerCount('agent-a')).toBe(0)
    expect(scope.layer('agent-a')).toBeUndefined()
    expect(host.agentView('agent-a')).toEqual([...CHERRY_TOOL_NAMES])

    // …and under `global` a COLD judgement cache is the same empty target (the
    // pinned fallback: `isVisible(doc, undefined)` is true under `global`), so a
    // brand-new agent is never installed for and never rejected.
    const before = host.restrictCalls.length
    host.addAgent({ id: 'agent-c' })
    expect(host.layerCount('agent-c')).toBe(0)
    expect(scope.layer('agent-c')).toBeUndefined()
    await settle()
    expect(host.restrictCalls.length).toBe(before)
    expect(host.layerCount('agent-c')).toBe(0)
    expect(host.verdict('agent-c', 'cherry_devices')).toBeUndefined()
  })

  it('④ a swap installs the new layer strictly before releasing the old one (B18②/B10)', async () => {
    const later: Array<() => void> = []
    const { host, scope, tools } = rig({
      registerTools: (fake) => {
        const first = registerOn(fake, CHERRY_TOOL_NAMES.slice(0, 7))
        later.push(() => {
          registerOn(fake, CHERRY_TOOL_NAMES.slice(7))
        })
        return () => {
          for (const release of first.splice(0)) release()
        }
      },
    })
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await settle()
    expect(host.layerTotal()).toBe(1)

    later[0]!()
    tools.refresh()

    // The observable point never shows two layers for one agent…
    expect(host.layerTotal()).toBe(1)
    expect(host.layerCount('agent-a')).toBe(1)
    // …the action order is install(new) THEN release(old) — never the reverse
    // (a release-first swap opens an unhidden window that is unrecoverable)…
    const actions = layerOps(host, 'agent-a')
    const installIndex = actions.findIndex((entry) => entry.op === 'restrict' && entry.denyCount === 14)
    const releaseIndex = actions.findIndex((entry) => entry.op === 'release-layer')
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(releaseIndex).toBeGreaterThan(installIndex)
    // …and the record was replaced WHOLESALE by the new layer (not left undefined,
    // not left describing the released one).
    expect(scope.layer('agent-a')?.deny).toHaveLength(14)
    expect(host.agentView('agent-a').filter((name) => name.startsWith('cherry_'))).toEqual([])
  })

  it('⑤ an unchanged deny set short-circuits: the same layer is never reinstalled (§4②)', async () => {
    const { host, scope, tools } = rig()
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await settle()

    const installs = host.restrictCalls.length
    const releases = host.ops.filter((entry) => entry.op === 'release-layer').length
    expect(installs).toBe(1)
    expect(host.layerCount('agent-a')).toBe(1)

    for (let round = 0; round < 3; round += 1) tools.refresh()
    await settle()

    expect(host.restrictCalls.length).toBe(installs)
    expect(host.ops.filter((entry) => entry.op === 'release-layer').length).toBe(releases)
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')?.deny).toHaveLength(14)
  })

  it('⑥ a refused installation is recorded, never thrown, and the next save retries (B12②)', async () => {
    const { host, scope, tools } = rig()
    host.setWorkspaces([{ id: 'w-oa', title: 'OA', path: '/w/oa', sessionIds: ['agent-a'] }])
    const agents = captureAgents(host)
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await settle()
    expect(host.layerCount('agent-a')).toBe(1)

    // Visible ⇒ the layer is released (the quiet state a failed install must not
    // turn into "record present, layer absent").
    saveScope(scope, 'selected', ['w-oa'])
    tools.refresh()
    expect(host.layerCount('agent-a')).toBe(0)
    expect(scope.layer('agent-a')).toBeUndefined()

    // The host now REFUSES the installation — the fixture wraps the agent's own
    // `restrict` face, which is the very function `agents.list()` re-projects.
    const raw = agents.get('agent-a')!
    const refusing = raw.ctx.tools.restrict
    raw.ctx.tools.restrict = () => {
      throw new Error('the host refused this restriction')
    }

    saveScope(scope, 'selected', [])
    // Not thrown at the caller (the PUT path calls `refresh()` synchronously)…
    expect(() => tools.refresh()).not.toThrow()
    // …not silent: the degradation is recorded with a readable cause…
    const note = scope.degraded().find((entry) => entry.source === 'install')
    expect(note).toBeDefined()
    expect(note?.reason).toContain('agent-a')
    expect(note?.reason).toContain('the host refused this restriction')
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('agent-a')
    // …and nothing was half-written: no layer, no record — so the guard allows
    // rather than rejecting a tool that is still visible.
    expect(host.layerCount('agent-a')).toBe(0)
    expect(scope.layer('agent-a')).toBeUndefined()
    expect(host.verdict('agent-a', 'cherry_devices')).toBeUndefined()

    // The NEXT config save retries and succeeds.
    raw.ctx.tools.restrict = refusing
    tools.refresh()
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')?.deny).toHaveLength(14)
    expect(host.verdict('agent-a', 'cherry_devices')).toBeTypeOf('string')
  })

  it('⑥ the two-moment skew (the intersection still names an unregistered tool) takes the same path (B12④)', async () => {
    // One of the 14 never made it into the registry…
    const { host, scope, tools } = rig({
      registerTools: (fake) => {
        const releases = registerOn(fake, CHERRY_TOOL_NAMES.slice(0, 13))
        return () => {
          for (const release of releases.splice(0)) release()
        }
      },
    })
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await settle()
    expect(host.restrictCalls).toHaveLength(1)
    expect(denyOf(host.restrictCalls[0]!)).toHaveLength(13)

    // …while the OBSERVATION moment still reports it (D12's "两个时刻" — the view
    // and `restrict`'s acceptance set are two different observations).
    const realSchemas = host.root.tools!.schemas!
    host.root.tools!.schemas = () =>
      CHERRY_TOOL_NAMES.map((name) => ({ name, description: name }))

    host.addAgent({ id: 'agent-b', cwd: '/w/oa' })
    await settle()

    expect(host.effectFailures).toEqual([])
    const note = scope.degraded().find((entry) => entry.source === 'install')
    expect(note).toBeDefined()
    expect(note?.reason).toContain('cherry_unpair')
    // The agent that was never installed stays un-hidden, with no record…
    expect(host.layerCount('agent-b')).toBe(0)
    expect(scope.layer('agent-b')).toBeUndefined()
    // …and the agent that ALREADY had a layer keeps it: a failed install never
    // opens an unhidden window (先装新后释放旧).
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')?.deny).toHaveLength(13)

    // Both observations agree again ⇒ both layers complete on the next save.
    host.root.tools!.schemas = realSchemas
    registerOn(host, CHERRY_TOOL_NAMES.slice(13))
    tools.refresh()
    expect(host.layerCount('agent-a')).toBe(1)
    expect(host.layerCount('agent-b')).toBe(1)
    expect(scope.layer('agent-a')?.deny).toHaveLength(14)
    expect(scope.layer('agent-b')?.deny).toHaveLength(14)
  })

  it('⑦ the guard is the execution-side mirror of the installed-layer record (B6)', async () => {
    const { host, scope, tools } = rig()
    host.setWorkspaces([{ id: 'w-oa', title: 'OA', path: '/w/oa', sessionIds: ['agent-a'] }])
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await vi.waitFor(() => {
      expect(scope.judgement('agent-a')).toBeDefined()
    })
    await settle()

    // The layer is in ⇒ the call is rejected, with a reason naming the workspace.
    expect(scope.layer('agent-a')).toBeDefined()
    const denial = host.verdict('agent-a', 'cherry_devices')
    expect(typeof denial).toBe('string')
    expect(denial).toContain('w-oa')

    // The judgement cache is NOT a third input: cleared…
    scope.judgement = () => undefined
    expect(host.verdict('agent-a', 'cherry_devices')).toBe(denial)
    // …or contradicted, the verdict still follows the LAYER.
    scope.judgement = () => ({
      agentId: 'agent-a',
      status: 'resolved',
      workspaceId: 'w-oa',
      visible: true,
      reason: 'contradictory fixture value',
    })
    expect(host.verdict('agent-a', 'cherry_devices')).toBe(denial)

    // The mirror's other side: the workspace is enabled, so the layer is released
    // and the guard allows — even under a contradictory "invisible" judgement.
    saveScope(scope, 'selected', ['w-oa'])
    scope.judgement = () => ({
      agentId: 'agent-a',
      status: 'resolved',
      workspaceId: 'w-oa',
      visible: false,
      reason: 'contradictory fixture value',
    })
    tools.refresh()
    expect(scope.layer('agent-a')).toBeUndefined()
    expect(host.verdict('agent-a', 'cherry_devices')).toBeUndefined()
  })

  it('⑧ an upstream allow shadow is not our failure (B15)', async () => {
    const { host, scope, tools } = rig({
      patchRoot: (fake) => registerOn(fake, ['bash']),
    })
    host.setWorkspaces([{ id: 'w-oa', title: 'OA', path: '/w/oa', sessionIds: ['agent-a'] }])
    const agents = captureAgents(host)
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await vi.waitFor(() => {
      expect(scope.judgement('agent-a')).toBeDefined()
    })
    await settle()
    saveScope(scope, 'selected', ['w-oa'])
    tools.refresh()
    expect(host.layerCount('agent-a')).toBe(0)
    expect(scope.degraded()).toEqual([])

    // An upstream (delegation-chain) `allow` layer hides the whole family from
    // this agent's table — the shadow B15 declares acceptable.
    agents.get('agent-a')!.ctx.tools.restrict({ allow: ['bash'] })
    expect(host.agentView('agent-a').filter((name) => name.startsWith('cherry_'))).toEqual([])

    // It is NOT our failure: no denial, no degradation, no error log, and no
    // attempt to "fix" somebody else's layer.
    const installs = host.restrictCalls.length
    const warnings = warn.mock.calls.length
    tools.refresh()
    expect(host.verdict('agent-a', 'cherry_devices')).toBeUndefined()
    expect(scope.degraded()).toEqual([])
    expect(warn.mock.calls.length).toBe(warnings)
    expect(host.restrictCalls.length).toBe(installs)
  })

  it('⑨ the guard is scoped to our names and tolerates a missing execution.agent (§4)', async () => {
    const { host, scope } = rig()
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await vi.waitFor(() => {
      expect(scope.judgement('agent-a')).toBeDefined()
    })
    await settle()
    expect(scope.layer('agent-a')).toBeDefined()

    // Three SEPARATE arms: the guard runs on every dispatch, so an unscoped one
    // would reject every tool of a hidden workspace, not just our 14.
    expect(typeof host.verdict('agent-a', 'cherry_devices')).toBe('string')
    expect(host.verdict('agent-a', 'bash')).toBeUndefined()
    expect(host.verdict('agent-a', 'read')).toBeUndefined()
    expect(host.verdict(undefined, 'cherry_devices')).toBeUndefined()
  })

  it('⑩ restrictions intersect: one layer per agent is the only recoverable shape (B10/§4)', async () => {
    const { host, scope, tools } = rig()
    host.setWorkspaces([
      { id: 'w-oa', title: 'OA', path: '/w/oa', sessionIds: ['agent-a', 'agent-b'] },
    ])
    const agents = captureAgents(host)
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    host.addAgent({ id: 'agent-b', cwd: '/w/oa' })
    await vi.waitFor(() => {
      expect(scope.judgement('agent-a')).toBeDefined()
    })
    await settle()
    expect(host.layerCount('agent-a')).toBe(1)
    expect(host.layerCount('agent-b')).toBe(1)

    // The fixture stacks its OWN second deny layer on agent-a.
    agents.get('agent-a')!.ctx.tools.restrict({ deny: ['cherry_devices'] })
    expect(host.layerCount('agent-a')).toBe(2)
    expect(host.agentView('agent-a')).toEqual([])

    // Both agents become visible ⇒ the plugin releases ITS layer, and only its.
    saveScope(scope, 'selected', ['w-oa'])
    tools.refresh()

    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')).toBeUndefined()
    // The stacked layer still denies: releasing one of two intersected layers can
    // never restore the name — which is why ONE layer per agent is the invariant.
    expect(host.agentView('agent-a')).not.toContain('cherry_devices')
    expect(host.agentView('agent-a')).toContain('cherry_read')
    // The sibling, which only ever carried our layer, is left with none at all.
    expect(host.layerCount('agent-b')).toBe(0)
    expect(scope.layer('agent-b')).toBeUndefined()
    expect(host.agentView('agent-b')).toEqual([...CHERRY_TOOL_NAMES])
  })

  it('⑪ the guard only ever denies — there is no force-allow arm (§4)', async () => {
    const { host, scope } = rig()
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    host.addAgent({ id: 'agent-b', cwd: '/w/oa' })
    await vi.waitFor(() => {
      expect(scope.judgement('agent-a')).toBeDefined()
    })
    await settle()

    const denial = host.verdict('agent-a', 'cherry_devices')
    expect(typeof denial).toBe('string')
    expect(denial).not.toBe('')

    // No call order, and no interleaved allow-verdict probe, can turn the denial
    // back into an allowance: the verdict domain has no third value.
    for (let round = 0; round < 3; round += 1) {
      host.verdict('agent-a', 'bash')
      host.verdict(undefined, 'cherry_devices')
      host.verdict('agent-b', 'cherry_devices')
      expect(host.verdict('agent-a', 'cherry_devices')).toBe(denial)
    }
    // "层在 ⇒ 拒绝" is monotone; the mirror's other side (no layer ⇒ allow) is
    // asserted by ⑦/⑨, not derived from this one.
    expect(host.verdict('agent-a', 'cherry_devices')).toBeTypeOf('string')
  })

  it('R16 a throwing tools.guard degrades to visibility-only and the round continues (B17)', async () => {
    const { host, scope } = rig({
      patchRoot: (fake) => {
        fake.addAgent({ id: 'agent-a', cwd: '/w/oa' })
        fake.root.tools!.guard = () => {
          throw new Error('the host refused the guard')
        }
      },
    })
    await settle()

    // Nothing escaped the effect body — the injection callback may arrive
    // asynchronously, with the caller's `try` long off the stack.
    expect(host.effectFailures).toEqual([])
    // The round continued: registration and hiding are untouched (B17's "缺失不拒
    // 注册"), and the guard really is absent.
    expect(host.registeredNames()).toHaveLength(14)
    expect(host.layerCount('agent-a')).toBe(1)
    expect(host.guardLive()).toBe(0)
    // Reported, never silent: through the warn carrier and §6.1's degraded set.
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('guard')
    const note = scope.degraded().find((entry) => entry.source === 'visibility-only')
    expect(note).toBeDefined()
    expect(note?.reason).toContain('guard')

    // The round stays releasable.
    host.unloadDependencies()
    expect(host.registeredNames()).toEqual([])
    expect(host.layerTotal()).toBe(0)
    expect(scope.layer('agent-a')).toBeUndefined()
  })

  it('R16 a throwing on() is reported and the round continues with what succeeded', async () => {
    const { host, scope, tools } = rig({
      patchRoot: (fake) => {
        fake.addAgent({ id: 'agent-a', cwd: '/w/oa' })
        refuseSubscription(fake, 'agent/created')
      },
    })
    await settle()

    expect(host.effectFailures).toEqual([])
    // The refused subscription is reported through the warn carrier — the
    // degraded enum is a fixed five with no member for it.
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('agent/created')
    const degraded = scope.degraded()
    // The subscription that SUCCEEDED is live; the refused one is not.
    expect(host.liveSubscriptions('agent/created')).toBe(0)
    expect(host.liveSubscriptions('agent/disposed')).toBe(1)
    // The round still ran: the live agent was hidden by the first pass.
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')).toBeDefined()

    // …and the config-save path still converges the agents the missing
    // subscription would have handled synchronously.
    host.addAgent({ id: 'agent-b', cwd: '/w/oa' })
    expect(host.layerCount('agent-b')).toBe(0)
    tools.refresh()
    expect(host.layerCount('agent-b')).toBe(1)
    expect(scope.layer('agent-b')).toBeDefined()
    expect(scope.degraded()).toEqual(degraded)

    // The round stays releasable.
    host.unloadDependencies()
    expect(host.registeredNames()).toEqual([])
    expect(host.layerTotal()).toBe(0)
    expect(host.liveSubscriptions()).toBe(0)
  })
})
