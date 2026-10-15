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
import { FakeToolHost } from '../helpers/fakeToolHost.js'
import type { FakeCapability } from '../helpers/fakeToolHost.js'

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
