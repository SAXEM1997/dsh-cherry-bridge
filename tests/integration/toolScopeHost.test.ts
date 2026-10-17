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
import { asksForScopeKeys } from '../helpers/scopeInjectKeys.js'

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
   * D14's bounded recheck schedule (Task 6's `ScopeHostDeps.recheckDelaysMs`).
   * Small values, so a fixture can drive the chain under `vi.useFakeTimers()`;
   * omitted ⇒ the production default `[250, 2000]`.
   */
  recheckDelaysMs?: readonly number[]
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
    // Task 6's bounded recheck: injected as a SCHEDULE, never as a count — the
    // default is the production `[250, 2000]`.
    ...(options.recheckDelaysMs === undefined ? {} : { recheckDelaysMs: options.recheckDelaysMs }),
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

  it('①b asks the host for EXACTLY the two scope keys — one typo starves the fibre (B6)', () => {
    // The guard over the RUNTIME list, not the plugin's static `export const
    // inject`: `injectKeys()` records the keys the plugin actually handed to
    // `ctx.inject`, so a misspelling in `INJECT_KEYS` fails HERE even though the
    // static declaration is unchanged. The two names are a hard-coded LITERAL on
    // purpose — re-importing the plugin's own constant would only assert that it
    // equals itself.
    const { host } = rig()

    expect(host.injectKeys()).toEqual(['agents', 'workspaceRegistry'])
    // Exactly one request, so the recorded set cannot be someone else's call.
    expect(host.injectKeyCalls).toHaveLength(1)

    // And the fixtures' exact-set gate itself discriminates: a partial set (one
    // key misspelled) throws instead of classifying as either ctx. Pinned HERE
    // because the plugin's own `mount()` catches a throwing `inject` by design
    // (the tri-state goes `pending` and the HTTP/diagnostics faces keep serving),
    // so in the two fixtures whose suites only assert those faces a typo would
    // otherwise be swallowed — the recorded key set above is the loud half.
    expect(() => asksForScopeKeys(['agents', 'workspaceRegistr'])).toThrow(/PARTIAL match/)
    // R2-N15: a TWO-key typo is the other half of the same gate. Classifying it
    // by the ABSENCE of the scope keys alone would route it to the web-only ctx,
    // and the misrouted fixture would report the wrong diagnosis; the web-only
    // call is a positive match against its own literal instead.
    expect(() => asksForScopeKeys(['agent', 'workspaceRegistr'])).toThrow(/NEITHER tool-scope key/)
    expect(asksForScopeKeys(['webServer'])).toBe(false)
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

  it('④ dependency unload releases registration, layers, guard and all three subscriptions together', async () => {
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
    expect(phases.filter((op) => op === 'unsubscribe')).toHaveLength(3)
    // The three are the whole subscription set — agent/created, agent/disposed
    // and Task 5b's `tools/change`; none of them survives the merged disposer.
    expect(
      host.ops
        .slice(opsBefore)
        .flatMap((entry) => (entry.op === 'unsubscribe' ? [entry.event] : []))
        .sort(),
    ).toEqual(['agent/created', 'agent/disposed', 'tools/change'])
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
 * web key (`webServer` — issue #7) answers with the fake web server, the two scope
 * keys answer with
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
      // EXACT set, not `||`: a misspelled key in INJECT_KEYS must fail loudly
      // here instead of silently still delivering the scope-capable ctx (B6).
      if (asksForScopeKeys(deps)) {
        if (options.deferAgents !== true) cb(inside)
        return
      }
      // Issue #7: `webServer` alone; no `webRuntime` on the injected ctx.
      cb({ webServer: ctx['webServer'] })
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

  it('⑥ an UNREADABLE global view never releases a hiding layer (fail-closed, B9/B16/B18③)', async () => {
    const { host, scope, tools } = rig()
    host.setWorkspaces([{ id: 'w-oa', title: 'OA', path: '/w/oa', sessionIds: ['agent-a'] }])
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await vi.waitFor(() => {
      expect(scope.judgement('agent-a')).toBeDefined()
    })
    await settle()

    // The not-visible agent is hidden and the mirror rejects.
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')).toBeDefined()
    const denial = host.verdict('agent-a', 'cherry_devices')
    expect(typeof denial).toBe('string')

    // The host can no longer read its own global view: "failed to observe" is NOT
    // "observed empty". An unreadable input must never RELEASE a hiding layer —
    // that would be the fail-open direction (registered, visible, guard allows),
    // which B7 calls the worst state.
    const realSchemas = host.root.tools!.schemas!
    host.root.tools!.schemas = () => {
      throw new Error('the registry view is unreadable')
    }
    const installs = host.restrictCalls.length
    const releases = host.ops.filter((entry) => entry.op === 'release-layer').length
    const warnings = warn.mock.calls.length

    expect(() => tools.refresh()).not.toThrow()
    await settle()

    // (a) NO layer-changing host call at all: the installed layer survives, the
    //     agent stays hidden and the guard still rejects it.
    expect(host.restrictCalls.length).toBe(installs)
    expect(host.ops.filter((entry) => entry.op === 'release-layer').length).toBe(releases)
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')).toBeDefined()
    expect(host.agentView('agent-a').filter((name) => name.startsWith('cherry_'))).toEqual([])
    expect(host.verdict('agent-a', 'cherry_devices')).toBe(denial)
    // (b) …and never a no-op layer either.
    expect(host.restrictCalls.filter((call) => denyOf(call).length === 0)).toEqual([])
    // (c) reported through the warn carrier…
    expect(warn.mock.calls.length).toBeGreaterThan(warnings)
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('schemas')
    // (d) …and recorded with §6.1's EXISTING `install` source.
    const note = scope.degraded().find((entry) => entry.source === 'install')
    expect(note).toBeDefined()
    expect(note?.reason).toContain('schemas')

    // The view comes back: the layer was never touched, so the same deny set is
    // still in place and nothing is reinstalled.
    host.root.tools!.schemas = realSchemas
    tools.refresh()
    expect(host.restrictCalls.length).toBe(installs)
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')).toBeDefined()
    expect(host.verdict('agent-a', 'cherry_devices')).toBe(denial)
  })

  it('③ a VISIBLE agent never consults the global view at all', async () => {
    const { host, scope, tools } = rig()
    host.setWorkspaces([{ id: 'w-oa', title: 'OA', path: '/w/oa', sessionIds: ['agent-a'] }])
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await vi.waitFor(() => {
      expect(scope.judgement('agent-a')).toBeDefined()
    })
    await settle()
    saveScope(scope, 'selected', ['w-oa'])
    tools.refresh()
    expect(host.layerCount('agent-a')).toBe(0)

    // `visible ⇒ the empty set` needs no observation: an unreadable view must not
    // even be consulted, so it is neither reported nor degraded.
    host.root.tools!.schemas = () => {
      throw new Error('the registry view is unreadable')
    }
    const warnings = warn.mock.calls.length
    expect(() => tools.refresh()).not.toThrow()
    expect(warn.mock.calls.length).toBe(warnings)
    expect(scope.degraded().some((entry) => entry.source === 'install')).toBe(false)
    expect(host.layerCount('agent-a')).toBe(0)
    expect(scope.layer('agent-a')).toBeUndefined()
    expect(host.agentView('agent-a')).toEqual([...CHERRY_TOOL_NAMES])
    expect(host.verdict('agent-a', 'cherry_devices')).toBeUndefined()
  })
})

/**
 * Wraps the injected `workspaceRegistry.resolveByPath` so a fixture can see the one
 * thing a gate-less implementation cannot hide: how many judgement rebuilds are in
 * flight AT ONCE (each round awaits one resolution per workspace, plus one per
 * agent with a `cwd`, so a lone round peaks at 1 and an overlapping round at 2).
 *
 * The optional hook runs while that call is still in flight — i.e. for the round
 * that awaited it, INSIDE the asynchronous interval. Injecting an event there is
 * deterministic, which a microtask race in the test body would not be.
 */
function instrumentRegistry(fake: FakeToolHost, onResolve?: () => void): () => number {
  let active = 0
  let peak = 0
  const realInject = fake.root.inject as NonNullable<ScopeHostContext['inject']>
  fake.root.inject = ((keys: readonly string[], cb: (ctx: unknown) => void | (() => void)) =>
    realInject(keys, (ctx: unknown) => {
      const injected = ctx as {
        workspaceRegistry?: { list(): unknown; resolveByPath?(path: string): Promise<unknown> }
      }
      const registry = injected.workspaceRegistry
      const realResolve = registry?.resolveByPath
      if (registry === undefined || realResolve === undefined) return cb(ctx)
      return cb({
        ...(ctx as Record<string, unknown>),
        workspaceRegistry: {
          ...registry,
          resolveByPath: async (path: string) => {
            active += 1
            if (active > peak) peak = active
            try {
              const resolved = await realResolve.call(registry, path)
              onResolve?.()
              return resolved
            } finally {
              active -= 1
            }
          },
        },
      })
    })) as NonNullable<ScopeHostContext['inject']>
  return () => peak
}

/**
 * T5b — the `tools/change` subscription and the COALESCING GATE (spec §4's
 * re-entrancy and convergence rules).
 *
 * The fake host emits `tools/change` on BOTH sides of `restrict()` (§7), so the
 * plugin's own install and release work re-enters its own listener. That is why
 * the subscription and the gate land together: without the gate the subscription
 * self-triggers, and the coalescing rule is what makes the resulting rounds
 * terminate. The assertions below are the ones that separate a gated
 * implementation from an ungated (or absent) one.
 */
describe('T5b the tools/change subscription and the coalescing gate (§4)', () => {
  it('⑫ a tools/change during a round is COALESCED: one dirty catch-up, never a concurrent round', async () => {
    const releases: Array<() => void> = []
    let peak: () => number = () => 0
    let midRound: (() => void) | undefined
    const { host, scope, tools } = rig({
      patchRoot: (fake) => {
        peak = instrumentRegistry(fake, () => {
          // One shot: the catch-up round must see a quiet registry, or the fixture
          // itself would keep the round loop alive.
          const emit = midRound
          midRound = undefined
          emit?.()
        })
      },
      registerTools: (fake) => {
        releases.push(...registerOn(fake, CHERRY_TOOL_NAMES))
        return () => {
          for (const release of releases.splice(0)) release()
        }
      },
    })
    host.setWorkspaces([{ id: 'w-oa', title: 'OA', path: '/w/oa', sessionIds: ['agent-a'] }])
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await vi.waitFor(() => {
      expect(scope.judgement('agent-a')).toBeDefined()
    })
    await settle()

    // The subscription is live, the agent is hidden by exactly ONE layer, and the
    // plugin's own install already echoed `tools/change` back at it.
    expect(host.liveSubscriptions('tools/change')).toBe(1)
    expect(host.layerCount('agent-a')).toBe(1)
    expect(host.restrictCalls).toHaveLength(1)
    expect(peak()).toBe(1)

    const rounds = host.listCalls()
    const installs = host.restrictCalls.length

    // A REAL source change — one of our names leaves the global view — starts a
    // round, whose own install/release work then emits two more `tools/change`
    // from INSIDE that round (the fake host notifies on both sides of restrict)…
    releases.pop()!()
    // …and a third arrives in the round's asynchronous interval.
    midRound = () => host.emitToolsChange()
    await settle()

    // 合并 / 置脏补跑: round 1 + exactly ONE catch-up for ALL of them (an ungated
    // handler would run one round per emission).
    expect(host.listCalls() - rounds).toBe(2)
    // 不并发: no second round ever overlapped the first.
    expect(peak()).toBe(1)
    // 有界放大: the catch-up made no layer-changing call — one reinstall overall.
    expect(host.restrictCalls.length).toBe(installs + 1)
    expect(denyOf(host.restrictCalls.at(-1)!)).toHaveLength(13)
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')?.deny).toHaveLength(13)
    expect(host.effectFailures).toEqual([])
  })

  it('⑬ an agent created during a round is never dropped: the catch-up round adopts it', async () => {
    const releases: Array<() => void> = []
    let peak: () => number = () => 0
    const { host, scope, tools } = rig({
      patchRoot: (fake) => {
        peak = instrumentRegistry(fake)
      },
      registerTools: (fake) => {
        releases.push(...registerOn(fake, CHERRY_TOOL_NAMES))
        return () => {
          for (const release of releases.splice(0)) release()
        }
      },
    })
    host.setWorkspaces([{ id: 'w-oa', title: 'OA', path: '/w/oa', sessionIds: ['agent-a'] }])
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await vi.waitFor(() => {
      expect(scope.judgement('agent-a')).toBeDefined()
    })
    await settle()
    expect(host.layerCount('agent-a')).toBe(1)
    expect(peak()).toBe(1)

    const rounds = host.listCalls()

    // Round 1 starts on the config-save path…
    tools.refresh()
    // …and an agent is created while it is still in flight. Its FIRST install is
    // synchronous and fail-closed (D14: the cache is a miss, so it must not wait
    // for an asynchronous resolution before being hidden).
    host.addAgent({ id: 'agent-b' })
    expect(host.layerCount('agent-b')).toBe(1)
    expect(scope.layer('agent-b')?.reason).toContain('缓存未命中')
    // R2-N17: the miss stays — it is what explains installing without awaiting —
    // but the record also carries the conclusion this window could already state
    // (`no-cwd`), instead of leaving the operator with only the cache's story.
    expect(scope.layer('agent-b')?.reason).toContain('会话 header 无 cwd')

    await settle()

    // 不并发: the creation did not open a second concurrent round…
    expect(peak()).toBe(1)
    // …it set the dirty flag: round 1 + exactly ONE catch-up.
    expect(host.listCalls() - rounds).toBe(2)
    // 首次安装永不弃权: exactly one layer for the new agent, and the CATCH-UP round
    // is what adopts it — the judgement below is one only that round could have
    // produced, since round 1's agent snapshot predates the creation (the layer's
    // reason was still the cache-miss wording until the catch-up re-applied).
    expect(scope.judgement('agent-b')).toBeDefined()
    // agent-b was created with NO `cwd` (a minimal, store-less session header), so
    // the path rule cannot judge it: `no-cwd`, and under `selected` that is not
    // visible (D7) — a resolved judgement here would be a fact about the fixture,
    // not about the catch-up round.
    expect(scope.judgement('agent-b')?.status).toBe('no-cwd')
    expect(scope.judgement('agent-b')?.workspaceId).toBeUndefined()
    expect(scope.judgement('agent-b')?.visible).toBe(false)
    // …and the layer's record was refreshed IN PLACE (the reviewed write: same deny
    // set, no `restrict()` call, no layer churn).
    expect(host.restrictCalls.filter((call) => call.agentId === 'agent-b')).toHaveLength(1)
    expect(scope.layer('agent-b')?.reason).toBe(scope.judgement('agent-b')?.reason)
    expect(scope.layer('agent-b')?.reason).not.toContain('缓存未命中')
    expect(scope.layer('agent-b')?.deny).toHaveLength(14)
    expect(host.layerCount('agent-b')).toBe(1)
    expect(host.effectFailures).toEqual([])
  })

  it('⑭ teardown is the ONLY abstention point: an event already in flight lands on a dead subsystem', async () => {
    /**
     * A host that dispatches over a SNAPSHOT of its listeners: the fixture's own
     * listener (registered first) unloads the fibre from inside the dispatch, and
     * the already-snapshotted plugin listener still receives the event. That is
     * exactly the window §4 names as the abstention point — and the plugin's OWN
     * release work emits `tools/change` in the same window.
     */
    function rigTornDownMidDispatch(event: 'tools/change' | 'agent/created') {
      let armed = false
      let unload: () => void = () => {}
      const rigged = rig({
        patchRoot: (fake) => {
          fake.root.on?.(event, () => {
            if (armed) unload()
          })
        },
      })
      unload = rigged.dispose
      return {
        ...rigged,
        arm: () => {
          armed = true
        },
        /**
         * The PLUGIN's own live subscriptions, with this fixture's sabotage
         * listener counted out.
         *
         * `liveSubscriptions(event)` alone answers the wrong question: it counts 1
         * for the fixture's own listener (which outlives the teardown that listener
         * triggers) and 1 for the plugin's — so "0 after teardown" would be
         * satisfied by an implementation that never subscribed at all, and "1 while
         * mounted" would be satisfied by the fixture alone. Both counts below are
         * the plugin's.
         */
        pluginSubscriptions(of?: string): number {
          return rigged.host.liveSubscriptions(of) - (of === undefined || of === event ? 1 : 0)
        },
        /** The observable of "a recompute body was entered": a not-visible agent
         * makes `targetDeny` read the global view, and abstention means it is never
         * reached. */
        countSchemas(): () => number {
          const real = rigged.host.root.tools!.schemas!
          let calls = 0
          rigged.host.root.tools!.schemas = (scope?: unknown) => {
            calls += 1
            return real(scope)
          }
          return () => calls
        },
      }
    }

    async function hiddenAgent(fixture: ReturnType<typeof rigTornDownMidDispatch>): Promise<void> {
      const { host, scope } = fixture
      host.setWorkspaces([{ id: 'w-oa', title: 'OA', path: '/w/oa', sessionIds: ['agent-a'] }])
      host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
      await vi.waitFor(() => {
        expect(scope.judgement('agent-a')).toBeDefined()
      })
      await settle()
      expect(host.layerCount('agent-a')).toBe(1)
      // The subscription under test is LIVE, and this count is the PLUGIN's: the
      // whole set (agent/created + agent/disposed + tools/change) is counted, with
      // the fixture's own listener subtracted (see `pluginSubscriptions`).
      expect(fixture.pluginSubscriptions()).toBe(3)
      expect(fixture.pluginSubscriptions('tools/change')).toBe(1)
    }

    // ── (a) a `tools/change` delivered after the teardown it was dispatched with ──
    const first = rigTornDownMidDispatch('tools/change')
    await hiddenAgent(first)
    const schemasCalls = first.countSchemas()
    const rounds = first.host.listCalls()
    const installs = first.host.restrictCalls.length

    first.arm()
    first.host.emitToolsChange()

    // The teardown ran (registration, layer and subscriptions all gone)…
    expect(first.host.registeredNames()).toEqual([])
    expect(first.host.layerTotal()).toBe(0)
    expect(first.scope.layer('agent-a')).toBeUndefined()
    expect(first.pluginSubscriptions()).toBe(0)
    expect(first.pluginSubscriptions('tools/change')).toBe(0)
    // …and the event that was still in flight did NOT recompute, install or
    // resurrect the invalidated generation.
    expect(schemasCalls()).toBe(0)
    expect(first.host.listCalls()).toBe(rounds)
    expect(first.host.restrictCalls.length).toBe(installs)
    expect(first.scope.judgement('agent-a')).toBeUndefined()
    expect(first.scope.degraded()).toEqual([])
    expect(first.host.effectFailures).toEqual([])

    // ── (b) an `agent/created` delivered after the teardown it was dispatched with ──
    const second = rigTornDownMidDispatch('agent/created')
    await hiddenAgent(second)
    const schemasCallsB = second.countSchemas()
    const roundsB = second.host.listCalls()
    const installsB = second.host.restrictCalls.length

    second.arm()
    second.host.addAgent({ id: 'agent-b', cwd: '/w/oa' })

    expect(second.host.registeredNames()).toEqual([])
    expect(second.host.layerTotal()).toBe(0)
    expect(second.host.layerCount('agent-b')).toBe(0)
    expect(second.scope.layer('agent-b')).toBeUndefined()
    expect(second.scope.judgement('agent-b')).toBeUndefined()
    expect(schemasCallsB()).toBe(0)
    expect(second.host.listCalls()).toBe(roundsB)
    expect(second.host.restrictCalls.length).toBe(installsB)
    expect(second.scope.degraded()).toEqual([])
    expect(second.host.effectFailures).toEqual([])
    expect(second.pluginSubscriptions()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Task 6 — the BOUNDED RECHECK, the SYNCHRONOUS judgement and the remaining
// assertions (④–⑨).
//
// D14's recheck exists for exactly ONE state: `unresolved` (a session whose
// `cwd` resolution could not CONCLUDE — the registry was not ready, or the
// resolution call failed). It is bounded (`recheckDelaysMs`, `[250, 2000]` by
// default), it never runs inside the synchronous window (`agent/created` must
// return before the host awaits it — `@mode serial` — and a throw there fails
// session creation), and its recompute goes through the SAME coalescing gate as
// every other trigger: never `applyAll` directly, so it can never overlap a
// round that is already in flight.
// ---------------------------------------------------------------------------

/** One workspace entity, in the shape the registry hands back. */
function entity(id: string, path: string, sessionIds: readonly string[] = []) {
  return { id, title: id.toUpperCase(), path, sessionIds: [...sessionIds] }
}

/**
 * The registry shape `rebuild()` consumes, for a fixture that warms the
 * judgement cache ITSELF — the generation a completed round produces. ⑨ needs
 * exactly that: its layer decision must come from a same-round hit, never from a
 * recheck's later compensation.
 */
function entityRegistry(workspaces: ReadonlyArray<ReturnType<typeof entity>>) {
  return {
    list: () => workspaces,
    resolveByPath: async (path: string) => workspaces.find((workspace) => workspace.path === path),
  }
}

/**
 * Lets a round's asynchronous judgement + re-application finish.
 *
 * `setImmediate` is deliberately NOT faked by the tests below (only `setTimeout`
 * is), so this is a REAL macrotask — and therefore runs after every pending
 * microtask, which is all a round is made of.
 */
async function drain(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve()
  await new Promise<void>((resolve) => {
    setImmediate(() => resolve())
  })
}

/**
 * Wraps the injected ctx's `on` so a fixture can observe the two things the fake
 * host itself does not expose:
 *
 *  - the RETURN VALUE of the plugin's own listener — ⑥/⑨'s "`agent/created`
 *    returns synchronously" (a listener that returned a promise would be an
 *    `await` in the host's `@mode serial` dispatch);
 *  - the listener itself, deliverable after the host has unsubscribed it —
 *    ⑧(b)'s "an event already in flight lands on a dead subsystem".
 */
function observeListeners(fake: FakeToolHost, events: readonly string[]) {
  const returns = new Map<string, unknown>()
  const handlers = new Map<string, Array<(payload: unknown) => unknown>>()
  const realInject = fake.root.inject as NonNullable<ScopeHostContext['inject']>
  fake.root.inject = ((keys: readonly string[], cb: (ctx: unknown) => void | (() => void)) =>
    realInject(keys, (ctx: unknown) => {
      const injected = ctx as {
        on?: (event: string, handler: (payload: unknown) => unknown) => () => void
      }
      const realOn = injected.on
      if (realOn === undefined) return cb(ctx)
      return cb({
        ...(ctx as Record<string, unknown>),
        on: (event: string, handler: (payload: unknown) => unknown) => {
          const wrapped = (payload: unknown): unknown => {
            const outcome = handler(payload)
            if (events.includes(event)) returns.set(event, outcome)
            return outcome
          }
          const list = handlers.get(event) ?? []
          list.push(wrapped)
          handlers.set(event, list)
          return realOn.call(injected, event, wrapped)
        },
      })
    })) as NonNullable<ScopeHostContext['inject']>

  return {
    /** The last value the plugin's listener RETURNED for one event. */
    lastReturn: (event: string): unknown => returns.get(event),
    /** Delivers straight to the captured listener, unsubscribe or not. */
    deliver: (event: string, payload: unknown): void => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
  }
}

/**
 * Suspends `resolveByPath` behind a gate the fixture opens when it chooses, so a
 * round can be held INSIDE its asynchronous interval (⑥). `peak` is the
 * concurrency observable §4's "不并发" is stated in: a lone round peaks at 1, an
 * overlapping second round at 2.
 */
function holdResolveByPath(fake: FakeToolHost) {
  let holding = false
  let gate: Promise<void> = Promise.resolve()
  let open: () => void = () => {}
  let active = 0
  let peak = 0
  const realInject = fake.root.inject as NonNullable<ScopeHostContext['inject']>
  fake.root.inject = ((keys: readonly string[], cb: (ctx: unknown) => void | (() => void)) =>
    realInject(keys, (ctx: unknown) => {
      const injected = ctx as {
        workspaceRegistry?: { list(): unknown; resolveByPath?(path: string): Promise<unknown> }
      }
      const registry = injected.workspaceRegistry
      const realResolve = registry?.resolveByPath
      if (registry === undefined || realResolve === undefined) return cb(ctx)
      return cb({
        ...(ctx as Record<string, unknown>),
        workspaceRegistry: {
          ...registry,
          resolveByPath: async (path: string) => {
            active += 1
            if (active > peak) peak = active
            try {
              if (holding) await gate
              return await realResolve.call(registry, path)
            } finally {
              active -= 1
            }
          },
        },
      })
    })) as NonNullable<ScopeHostContext['inject']>

  return {
    peak: () => peak,
    /** Every later resolution waits — the round is now suspended. */
    hold(): void {
      holding = true
      gate = new Promise<void>((resolve) => {
        open = resolve
      })
    },
    release(): void {
      holding = false
      open()
    },
  }
}

/**
 * Makes ONE cwd reach a registry entity under a DIFFERENT canonical path — the
 * symlink / realpath case D14 names. `resolveByPath(alias)` resolves to the
 * entity (`{ id, path: <canonical> }`), which splits the two windows apart:
 *
 *  - the SYNCHRONOUS window reads a `#pathMap` keyed by the ENTITY path, so the
 *    alias misses there and the honest answer is "not concluded yet";
 *  - the ASYNCHRONOUS round awaits `resolveByPath` and does see the hit.
 *
 * That is the one branch where "fail-closed now, corrected by the round" is the
 * correct behaviour rather than a stale cache.
 */
function aliasPath(fake: FakeToolHost, alias: string, canonical: string): void {
  const realInject = fake.root.inject as NonNullable<ScopeHostContext['inject']>
  fake.root.inject = ((keys: readonly string[], cb: (ctx: unknown) => void | (() => void)) =>
    realInject(keys, (ctx: unknown) => {
      const injected = ctx as {
        workspaceRegistry?: { list(): unknown; resolveByPath?(path: string): Promise<unknown> }
      }
      const registry = injected.workspaceRegistry
      const realResolve = registry?.resolveByPath
      if (registry === undefined || realResolve === undefined) return cb(ctx)
      return cb({
        ...(ctx as Record<string, unknown>),
        workspaceRegistry: {
          ...registry,
          resolveByPath: async (path: string) =>
            await realResolve.call(registry, path === alias ? canonical : path),
        },
      })
    })) as NonNullable<ScopeHostContext['inject']>
}

/**
 * Rejects `resolveByPath` for exactly ONE path — the fake host's own
 * `resolveByPathThrows` flag is all-or-nothing, and ④(b) needs the one agent
 * whose resolution FAILS next to the three states that must never be rechecked.
 */
function refusePath(fake: FakeToolHost, refused: string): void {
  const realInject = fake.root.inject as NonNullable<ScopeHostContext['inject']>
  fake.root.inject = ((keys: readonly string[], cb: (ctx: unknown) => void | (() => void)) =>
    realInject(keys, (ctx: unknown) => {
      const injected = ctx as {
        workspaceRegistry?: { list(): unknown; resolveByPath?(path: string): Promise<unknown> }
      }
      const registry = injected.workspaceRegistry
      const realResolve = registry?.resolveByPath
      if (registry === undefined || realResolve === undefined) return cb(ctx)
      return cb({
        ...(ctx as Record<string, unknown>),
        workspaceRegistry: {
          ...registry,
          resolveByPath: async (path: string) => {
            if (path === refused) throw new Error(`resolveByPath failed for ${path}`)
            return await realResolve.call(registry, path)
          },
        },
      })
    })) as NonNullable<ScopeHostContext['inject']>
}

describe('T6 the bounded recheck, the synchronous judgement and the remaining assertions (D14/B13)', () => {
  // The recheck is a TIMER; every test here drives it on the fake clock. Only
  // `setTimeout`/`clearTimeout` are faked, so `drain()`'s `setImmediate` and the
  // promise machinery stay real.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('④(a) `unresolved` arms exactly the two bounded rechecks, then stops (no idle spin)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { host, scope } = rig({ recheckDelaysMs: [30, 60] })
    // An agent WITH a `cwd` whose resolution cannot conclude: the registry list
    // is unreadable (B16) ⇒ the ONE state D14 starts a recheck from.
    host.setWorkspaces([])
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })

    // The fail-closed first install is already in place, synchronously (D7) …
    expect(host.layerCount('agent-a')).toBe(1)
    await drain()
    expect(scope.judgement('agent-a')?.status).toBe('unresolved')
    const rounds = host.listCalls()

    // …and the FIRST bounded recheck is armed: one timer per `recheckDelaysMs`
    // entry, never a repeating interval.
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(30)
    expect(scope.judgement('agent-a')?.status).toBe('unresolved')
    // The second (and LAST) entry is now the pending one: 2 timers in total.
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(60)
    // Both rechecks ran; the state is STILL unresolved and the bound is reached,
    // so nothing more is scheduled — an idle spin would keep arming timers.
    expect(vi.getTimerCount()).toBe(0)
    expect(host.listCalls()).toBe(rounds + 2)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(host.listCalls()).toBe(rounds + 2)
    // The recheck only re-judges: the fail-closed layer is untouched throughout.
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')?.deny).toHaveLength(14)
    expect(host.effectFailures).toEqual([])
  })

  it('④(b) `no-cwd` / `no-match` / `resolved` arm NO timer — `unresolved` alone does (D14: no idle spin)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { host, scope, tools } = rig({
      recheckDelaysMs: [30, 60],
      patchRoot: (fake) => refusePath(fake, '/w/unready'),
    })
    host.setWorkspaces([entity('w-oa', '/w/oa', ['agent-member'])])
    tools.refresh()
    await drain()
    saveScope(scope, 'selected', ['w-oa'])

    // The four resolution states, ALL in one generation. `agent-member`'s `cwd`
    // is in no workspace: rule ONE (the `sessionIds` projection) is what resolves
    // it — the same judge, under the other rule.
    host.addAgent({ id: 'agent-member', cwd: '/w/unrelated' })
    host.addAgent({ id: 'agent-nomatch', cwd: '/w/nowhere' })
    host.addAgent({ id: 'agent-nocwd' })
    // The POSITIVE control: exactly one of the four may arm a recheck, or the
    // "zero timers" assertions below would hold for an implementation that never
    // schedules anything at all.
    host.addAgent({ id: 'agent-unresolved', cwd: '/w/unready' })
    await drain()

    expect(scope.judgement('agent-member')?.status).toBe('resolved')
    expect(scope.judgement('agent-nomatch')?.status).toBe('no-match')
    expect(scope.judgement('agent-nocwd')?.status).toBe('no-cwd')
    expect(scope.judgement('agent-unresolved')?.status).toBe('unresolved')
    // Only `unresolved` is recheckable: `no-cwd` (the `cwd` is deep-frozen
    // creation metadata — missing is missing forever) and `no-match` (resolved
    // and conclusively outside every workspace) cannot be reversed by waiting.
    expect(vi.getTimerCount()).toBe(1)

    const rounds = host.listCalls()
    await vi.advanceTimersByTimeAsync(30)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(60)
    // The one unresolved agent's chain is bounded and now exhausted: exactly two
    // recheck rounds, and the other three contributed no round at all.
    expect(vi.getTimerCount()).toBe(0)
    expect(host.listCalls() - rounds).toBe(2)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(host.listCalls() - rounds).toBe(2)
    // The fail-closed side stands where D7 puts it: the member's workspace is
    // enabled so the family returns; the other three stay hidden.
    expect(host.layerCount('agent-member')).toBe(0)
    expect(host.agentView('agent-member')).toEqual([...CHERRY_TOOL_NAMES])
    expect(host.layerCount('agent-nomatch')).toBe(1)
    expect(host.layerCount('agent-nocwd')).toBe(1)
    expect(host.layerCount('agent-unresolved')).toBe(1)
    expect(host.effectFailures).toEqual([])
  })

  it('④(c) a THROWING recheck recompute is logged, never thrown, and leaks no rejection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { host, scope } = rig({ recheckDelaysMs: [30, 60] })
    host.setWorkspaces([])
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await drain()
    expect(vi.getTimerCount()).toBe(1)

    // R11: Task 3 deliberately made `rebuild()` non-throwing for REGISTRY faults
    // (a throwing `list()` becomes `listAvailable:false`, a rejected per-item
    // resolution is skipped), so a faulting registry can no longer produce the
    // rejection this arm is about. The failure is therefore forced on the HOST's
    // call path — and the assertion below is non-vacuous only because the spy and
    // the log carrier both PROVE that rejection was observed.
    const injected = new Error('复检重算失败（夹具注入）')
    const rebuild = vi.spyOn(scope, 'rebuild').mockRejectedValueOnce(injected)
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      await vi.advanceTimersByTimeAsync(30)
      // A real macrotask: Node settles "was this rejection handled" before it.
      await drain()
    } finally {
      process.off('unhandledRejection', onRejection)
    }

    // The recheck really did run the recompute and really did reject…
    expect(rebuild).toHaveBeenCalledTimes(1)
    // …and D14's "失败只记录、不抛" is what happened: the default carrier is one
    // `console.warn`, with the readable cause.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('作用域重算失败'), injected)
    expect(rejections).toEqual([])
    expect(host.effectFailures).toEqual([])
    // The gate is not left stuck either: the bounded chain continues (the failed
    // attempt consumed one step, not the whole schedule) and still ends.
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(60)
    expect(vi.getTimerCount()).toBe(0)
    expect(host.layerCount('agent-a')).toBe(1)
  })

  it('⑤ the recheck compensates a lagging `sessionIds` projection — and never flips a `no-cwd` session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { host, scope, tools } = rig({ recheckDelaysMs: [30, 60] })
    host.setWorkspaces([entity('w-oa', '/w/oa')])
    tools.refresh()
    await drain()
    saveScope(scope, 'selected', ['w-oa'])

    // The registry goes unready again BEFORE the session arrives, so the session
    // is judged `unresolved` — "temporarily invisible", the only thing a recheck
    // is allowed to correct.
    host.setWorkspaces([])
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    // …and a session with NO `cwd` is D7's permanent invisibility: the recheck
    // must never be armed for it.
    host.addAgent({ id: 'agent-b' })
    await drain()

    expect(scope.judgement('agent-a')?.status).toBe('unresolved')
    expect(scope.judgement('agent-b')?.status).toBe('no-cwd')
    // Fail-closed in the first round for BOTH (selected + no workspace)…
    expect(host.layerCount('agent-a')).toBe(1)
    expect(host.layerCount('agent-b')).toBe(1)
    // …and exactly ONE recheck is armed: the `no-cwd` session starts none.
    expect(vi.getTimerCount()).toBe(1)

    const installs = host.restrictCalls.length
    // The lagging projection lands while the first recheck is still pending —
    // nothing else triggers a round (the registry has no membership events).
    host.setWorkspaces([entity('w-oa', '/w/oa', ['agent-a'])])

    await vi.advanceTimersByTimeAsync(30)

    // The recheck's round settles the layer for the temporarily invisible agent,
    // on the strength of the projection that has now caught up …
    const judgement = scope.judgement('agent-a')
    expect(judgement?.status).toBe('resolved')
    expect(judgement?.workspaceId).toBe('w-oa')
    expect(judgement?.visible).toBe(true)
    // …by RELEASING the fail-closed layer: an empty target never submits a deny
    // (B18①/③), so the family is back in that agent's view.
    expect(host.layerCount('agent-a')).toBe(0)
    expect(scope.layer('agent-a')).toBeUndefined()
    expect(host.agentView('agent-a')).toEqual([...CHERRY_TOOL_NAMES])
    expect(host.restrictCalls.length).toBe(installs)
    // A `resolved` generation owes no further recheck at all.
    expect(vi.getTimerCount()).toBe(0)

    // The `cwd`-less session is NOT flipped by any recheck: advancing every
    // remaining timer leaves it hidden, re-judged exactly as it was.
    const rounds = host.listCalls()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(host.listCalls()).toBe(rounds)
    expect(scope.judgement('agent-b')?.status).toBe('no-cwd')
    expect(scope.judgement('agent-b')?.visible).toBe(false)
    expect(host.layerCount('agent-b')).toBe(1)
    expect(host.agentView('agent-b').filter((name) => name.startsWith('cherry_'))).toEqual([])
    expect(host.effectFailures).toEqual([])
  })

  it('⑥ a SUSPENDED recompute never blocks session creation: D7 in the same round, corrected by the catch-up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    // ── (a) `selected`: the fail-closed side of D7 ────────────────────────────
    let observed: ReturnType<typeof observeListeners> | undefined
    let held: ReturnType<typeof holdResolveByPath> | undefined
    const selected = rig({
      recheckDelaysMs: [30, 60],
      patchRoot: (fake) => {
        observed = observeListeners(fake, ['agent/created'])
        held = holdResolveByPath(fake)
        // The agent's cwd is the ALIAS of the registered path: only the awaiting
        // `resolveByPath` can conclude it, so the synchronous window is the one
        // D14 describes — it may not block, and it is not wrong to abstain.
        aliasPath(fake, '/w/link', '/w/oa')
      },
    })
    selected.host.setWorkspaces([entity('w-oa', '/w/oa')])
    selected.tools.refresh()
    await drain()
    saveScope(selected.scope, 'selected', ['w-oa'])

    const beforeCreation = selected.host.listCalls()
    held!.hold()
    // The judgement cache is EMPTY and the recompute that would fill it never
    // settles: the listener must still return, synchronously, and install the
    // fail-closed layer in the SAME round. The cache cannot be warm for this cwd
    // either — the synchronous window has no realpath, and the canonical map it
    // reads is keyed by the ENTITY path (`/w/oa`), never by the alias.
    selected.host.addAgent({ id: 'agent-a', cwd: '/w/link' })
    expect(selected.host.layerCount('agent-a')).toBe(1)
    expect(selected.scope.layer('agent-a')?.reason).toContain('缓存未命中')
    expect(selected.scope.judgement('agent-a')).toBeUndefined()
    // The listener's own return value: `undefined`, not a promise (the host
    // awaits it under `@mode serial`). The round behind it has already read the
    // registry — synchronously, inside `addAgent` — and is parked on the held
    // `resolveByPath`, so that read is the only one so far.
    expect(observed!.lastReturn('agent/created')).toBeUndefined()
    expect(selected.host.listCalls()).toBe(beforeCreation + 1)

    await drain()
    // Still suspended — and the synchronous window did NOT wait for it.
    expect(selected.scope.judgement('agent-a')).toBeUndefined()
    expect(selected.host.layerCount('agent-a')).toBe(1)
    expect(selected.host.listCalls()).toBe(beforeCreation + 1)

    // A `tools/change` arriving inside that window only sets the dirty flag: it
    // must not open a second round (the gate is held).
    selected.host.emitToolsChange()
    expect(selected.host.listCalls()).toBe(beforeCreation + 1)
    expect(held!.peak()).toBe(1)

    held!.release()
    await drain()

    // Convergence is NOT lost: the caught-up projection judges the agent visible
    // and the layer is released — by the round + exactly ONE catch-up pass (the
    // `tools/change` above was absorbed, not dropped and not duplicated).
    const judgement = selected.scope.judgement('agent-a')
    expect(judgement?.status).toBe('resolved')
    expect(judgement?.visible).toBe(true)
    expect(selected.host.layerCount('agent-a')).toBe(0)
    expect(selected.scope.layer('agent-a')).toBeUndefined()
    expect(selected.host.agentView('agent-a')).toEqual([...CHERRY_TOOL_NAMES])
    expect(selected.host.restrictCalls.filter((call) => call.agentId === 'agent-a')).toHaveLength(1)
    expect(selected.host.listCalls() - beforeCreation).toBe(2)
    expect(held!.peak()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(selected.host.effectFailures).toEqual([])

    // ── (b) `global`: the same suspension, but the fallback is VISIBLE ───────
    let observedGlobal: ReturnType<typeof observeListeners> | undefined
    let heldGlobal: ReturnType<typeof holdResolveByPath> | undefined
    const global = rig({
      recheckDelaysMs: [30, 60],
      patchRoot: (fake) => {
        observedGlobal = observeListeners(fake, ['agent/created'])
        heldGlobal = holdResolveByPath(fake)
      },
    })
    global.host.setWorkspaces([entity('w-oa', '/w/oa')])
    global.tools.refresh()
    await drain()
    saveScope(global.scope, 'global', [])

    heldGlobal!.hold()
    // A cache miss under `global` is the EMPTY target (B2: `global` is visible
    // for any id, `undefined` included) ⇒ release-only, i.e. install nothing.
    global.host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    expect(observedGlobal!.lastReturn('agent/created')).toBeUndefined()
    expect(global.host.layerCount('agent-a')).toBe(0)
    expect(global.host.restrictCalls.filter((call) => call.agentId === 'agent-a')).toEqual([])
    expect(global.scope.judgement('agent-a')).toBeUndefined()

    heldGlobal!.release()
    await drain()
    expect(global.scope.judgement('agent-a')?.visible).toBe(true)
    // Not one `deny` was ever submitted — not even an empty one (B18③).
    expect(global.host.restrictCalls.filter((call) => call.agentId === 'agent-a')).toEqual([])
    expect(global.host.layerCount('agent-a')).toBe(0)
    expect(global.scope.layer('agent-a')).toBeUndefined()
    expect(global.host.agentView('agent-a')).toEqual([...CHERRY_TOOL_NAMES])
    expect(global.host.verdict('agent-a', CHERRY_TOOL_NAMES[0]!)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    expect(global.host.effectFailures).toEqual([])
  })

  it('⑦ teardown clears the pending recheck timers (no timer outlives its generation)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { host, scope, dispose } = rig({ recheckDelaysMs: [30, 60] })
    host.setWorkspaces([])
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await drain()

    expect(scope.judgement('agent-a')?.status).toBe('unresolved')
    expect(vi.getTimerCount()).toBe(1)

    // The smaller version of the same leak: the AGENT goes away (not the whole
    // generation). A session that no longer exists owes no later round, so its
    // pending recheck goes with it rather than fire one wasted recompute.
    host.addAgent({ id: 'agent-zombie', cwd: '/w/oa' })
    await drain()
    expect(scope.judgement('agent-zombie')?.status).toBe('unresolved')
    expect(vi.getTimerCount()).toBe(2)
    host.disposeAgent('agent-zombie')
    await drain()
    expect(vi.getTimerCount()).toBe(1)
    const settled = host.listCalls()

    dispose()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    // Nothing fires, nothing recomputes and nothing installs against the dead
    // generation (the whole derived state was invalidated with it).
    expect(vi.getTimerCount()).toBe(0)
    expect(host.listCalls()).toBe(settled)
    expect(host.layerTotal()).toBe(0)
    expect(scope.layer('agent-a')).toBeUndefined()
    expect(scope.judgement('agent-a')).toBeUndefined()
    expect(host.effectFailures).toEqual([])
  })

  it('⑧(a) a recheck round and a `tools/change` round share ONE coalescing gate', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let peak: () => number = () => 0
    let midRound: (() => void) | undefined
    const { host, scope } = rig({
      recheckDelaysMs: [30, 60],
      patchRoot: (fake) => {
        peak = instrumentRegistry(fake, () => {
          // One shot: the catch-up pass must see a quiet registry, or the fixture
          // itself would keep the round loop alive.
          const emit = midRound
          midRound = undefined
          emit?.()
        })
      },
    })
    host.setWorkspaces([])
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await drain()
    expect(scope.judgement('agent-a')?.status).toBe('unresolved')
    expect(vi.getTimerCount()).toBe(1)

    const installs = host.restrictCalls.length
    const rounds = host.listCalls()

    // The registry becomes readable, and a REAL source change arrives from INSIDE
    // the recheck round's asynchronous interval — i.e. while the gate is held.
    host.setWorkspaces([entity('w-oa', '/w/oa')])
    midRound = () => host.emitToolsChange()
    await vi.advanceTimersByTimeAsync(30)

    // 不并发: the `tools/change` never opened a second round…
    expect(peak()).toBe(1)
    // …it only set the dirty flag: the recheck round + exactly ONE catch-up pass.
    expect(host.listCalls() - rounds).toBe(2)
    // 每 agent 每轮至多重装一次: the agent stays hidden (`selected`, nobody
    // enabled) and the catch-up pass short-circuits on the same deny set — one
    // install overall, one layer, no churn.
    expect(host.restrictCalls.length).toBe(installs)
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.judgement('agent-a')?.status).toBe('resolved')
    // The recheck chain ended with the `unresolved` state that started it.
    expect(vi.getTimerCount()).toBe(0)
    expect(host.effectFailures).toEqual([])
  })

  it('⑧(b) teardown is the only abstention point: a late event arms no timer and installs nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let created: ReturnType<typeof captureAgents> | undefined
    let observed: ReturnType<typeof observeListeners> | undefined
    const { host, scope, dispose } = rig({
      recheckDelaysMs: [30, 60],
      patchRoot: (fake) => {
        created = captureAgents(fake)
        observed = observeListeners(fake, ['agent/created', 'tools/change'])
      },
    })
    host.setWorkspaces([])
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })
    await drain()
    expect(scope.judgement('agent-a')?.status).toBe('unresolved')
    // The unresolved agent owes a bounded recheck, and it is PENDING.
    expect(vi.getTimerCount()).toBe(1)

    // A second agent's raw payload is kept, so the fixture can deliver its
    // `agent/created` to the plugin's listener AFTER the teardown.
    host.addAgent({ id: 'agent-b', cwd: '/w/oa' })
    await drain()
    const payload = created!.get('agent-b')!
    const installs = host.restrictCalls.length
    const rounds = host.listCalls()

    dispose()

    // (i) the pending recheck died with the generation it belonged to …
    expect(vi.getTimerCount()).toBe(0)
    // (ii) …and an event ALREADY dispatched (the host dispatches over a listener
    //      snapshot) lands on a dead subsystem: no recompute, no layer, and no
    //      NEW timer armed against the dead generation.
    observed!.deliver('tools/change', undefined)
    observed!.deliver('agent/created', { agent: payload })
    expect(vi.getTimerCount()).toBe(0)
    expect(host.listCalls()).toBe(rounds)
    expect(host.restrictCalls.length).toBe(installs)
    expect(host.layerTotal()).toBe(0)
    expect(scope.layer('agent-b')).toBeUndefined()
    expect(host.registeredNames()).toEqual([])

    await vi.advanceTimersByTimeAsync(10_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(host.listCalls()).toBe(rounds)
    expect(host.layerTotal()).toBe(0)
    expect(host.effectFailures).toEqual([])
  })

  it('⑨ B13’s headline path: a same-round canonical hit installs nothing and arms no recheck', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    // ── (a) the judgement is warm BEFORE the session exists ──────────────────
    let observed: ReturnType<typeof observeListeners> | undefined
    const fresh = rig({
      recheckDelaysMs: [30, 60],
      patchRoot: (fake) => {
        observed = observeListeners(fake, ['agent/created'])
      },
    })
    fresh.host.setWorkspaces([entity('w-oa', '/w/oa')])
    fresh.tools.refresh()
    await drain()
    saveScope(fresh.scope, 'selected', ['w-oa'])

    // The canonical-path HIT is already in the cache — a generation a COMPLETED
    // ROUND produced, with the agent the host really knows: the warm-up is the
    // ordinary `agent/created` + round, never a hand-called `rebuild` holding an
    // agent id the host has never seen (a state production cannot produce).
    fresh.host.addAgent({ id: 'agent-b', cwd: '/w/oa' })
    await drain()
    expect(fresh.scope.judgement('agent-b')?.status).toBe('resolved')
    expect(fresh.scope.judgement('agent-b')?.workspaceId).toBe('w-oa')
    expect(fresh.scope.judgement('agent-b')?.visible).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    // The event under test is the RE-ANNOUNCE (the listener is per-event, not
    // per-identity): same agent, same canonical hit, SAME ROUND.
    fresh.host.addAgent({ id: 'agent-b', cwd: '/w/oa' })

    // SAME ROUND: the empty target submits NO deny at all — the family is visible
    // from the first round, which is B13's "第一轮就有工具"…
    expect(fresh.host.restrictCalls.filter((call) => call.agentId === 'agent-b')).toEqual([])
    expect(fresh.host.layerCount('agent-b')).toBe(0)
    expect(fresh.scope.layer('agent-b')).toBeUndefined()
    expect(fresh.host.agentView('agent-b')).toEqual([...CHERRY_TOOL_NAMES])
    expect(fresh.host.verdict('agent-b', CHERRY_TOOL_NAMES[0]!)).toBeUndefined()
    // …the listener returned synchronously, and a `resolved` generation arms NO
    // recheck timer (④'s zero-timer arm, from the other side).
    expect(observed!.lastReturn('agent/created')).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)

    await drain()
    expect(vi.getTimerCount()).toBe(0)
    expect(fresh.host.restrictCalls.filter((call) => call.agentId === 'agent-b')).toEqual([])
    expect(fresh.host.layerCount('agent-b')).toBe(0)

    // ── (b) …and the same hit RELEASES an already installed layer ─────────────
    // Identical fixture, one step further: the agent was hidden first (its
    // workspace was not enabled — the ordinary fail-closed state), then the
    // operator enables it and a completed generation judges the canonical path a
    // HIT. The next `agent/created` for that agent (a re-announce — the listener
    // is per-event, not per-identity) must then release ONLY.
    let observedSecond: ReturnType<typeof observeListeners> | undefined
    const second = rig({
      recheckDelaysMs: [30, 60],
      patchRoot: (fake) => {
        observedSecond = observeListeners(fake, ['agent/created'])
      },
    })
    second.host.setWorkspaces([entity('w-oa', '/w/oa')])
    second.tools.refresh()
    await drain()
    second.host.addAgent({ id: 'agent-b', cwd: '/w/oa' })
    await drain()
    expect(second.scope.judgement('agent-b')?.status).toBe('resolved')
    expect(second.scope.judgement('agent-b')?.visible).toBe(false)
    expect(second.host.layerCount('agent-b')).toBe(1)
    expect(second.scope.layer('agent-b')?.deny).toHaveLength(14)
    // A `resolved` generation armed no recheck here either.
    expect(vi.getTimerCount()).toBe(0)

    saveScope(second.scope, 'selected', ['w-oa'])
    await second.scope.rebuild(entityRegistry([entity('w-oa', '/w/oa')]), [
      { id: 'agent-b', cwd: '/w/oa' },
    ])
    expect(second.scope.judgement('agent-b')?.visible).toBe(true)

    const installs = second.host.restrictCalls.length
    const releases = second.host.ops.filter((entry) => entry.op === 'release-layer').length
    second.host.addAgent({ id: 'agent-b', cwd: '/w/oa' })

    // SAME ROUND, synchronously: release only — not a single deny submitted…
    expect(observedSecond!.lastReturn('agent/created')).toBeUndefined()
    expect(second.host.restrictCalls.length).toBe(installs)
    expect(second.host.ops.filter((entry) => entry.op === 'release-layer').length).toBe(releases + 1)
    expect(second.host.layerCount('agent-b')).toBe(0)
    expect(second.scope.layer('agent-b')).toBeUndefined()
    expect(second.host.agentView('agent-b')).toEqual([...CHERRY_TOOL_NAMES])
    // …and no recheck timer.
    expect(vi.getTimerCount()).toBe(0)

    await drain()
    expect(vi.getTimerCount()).toBe(0)
    expect(second.host.restrictCalls.length).toBe(installs)
    expect(second.host.layerCount('agent-b')).toBe(0)
    expect(second.host.effectFailures).toEqual([])
  })

  it('⑩ a brand-new agent resolves in the SAME round from the current generation (B13, no pre-warm)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    let observed: ReturnType<typeof observeListeners> | undefined
    const fresh = rig({
      recheckDelaysMs: [30, 60],
      patchRoot: (fake) => {
        observed = observeListeners(fake, ['agent/created'])
      },
    })
    fresh.host.setWorkspaces([entity('w-oa', '/w/oa')])
    fresh.tools.refresh()
    await drain()
    saveScope(fresh.scope, 'selected', ['w-oa'])

    // The generation in place is the one an ORDINARY round produced for the live
    // agents it had — which is none. Nothing pre-judged `agent-b`, and nothing
    // can: `rebuild()` is fed by the live agents alone, so a brand-new agent id
    // is never in the per-agent cache when the first install runs.
    expect(fresh.host.liveAgentIds()).toEqual([])
    expect(fresh.scope.judgement('agent-b')).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)

    fresh.host.addAgent({ id: 'agent-b', cwd: '/w/oa' })

    // SAME ROUND, synchronously: the EMPTY target submits no deny at all — the
    // family is visible from the FIRST round, B13's 「第一轮就有工具」.
    expect(fresh.host.restrictCalls.filter((call) => call.agentId === 'agent-b')).toEqual([])
    expect(fresh.host.layerCount('agent-b')).toBe(0)
    expect(fresh.scope.layer('agent-b')).toBeUndefined()
    expect(fresh.host.agentView('agent-b')).toEqual([...CHERRY_TOOL_NAMES])
    expect(fresh.host.verdict('agent-b', CHERRY_TOOL_NAMES[0]!)).toBeUndefined()
    expect(observed!.lastReturn('agent/created')).toBeUndefined()
    // …and no recheck timer: a resolved, visible agent is not an `unresolved` one.
    expect(vi.getTimerCount()).toBe(0)
    // THE PROOF that the synchronous accessor answered: the per-agent cache is
    // STILL cold at the instant the layer decision was made. A warm cache cannot
    // exist here — the round has not run yet, and the fixture never warmed one.
    expect(fresh.scope.judgement('agent-b')).toBeUndefined()

    // The round that follows lands the same conclusion in the cache; the layer
    // state it finds is already correct, so it submits no deny and arms no timer.
    await drain()
    expect(fresh.scope.judgement('agent-b')?.status).toBe('resolved')
    expect(fresh.scope.judgement('agent-b')?.workspaceId).toBe('w-oa')
    expect(fresh.scope.judgement('agent-b')?.visible).toBe(true)
    expect(fresh.host.restrictCalls.filter((call) => call.agentId === 'agent-b')).toEqual([])
    expect(fresh.host.layerCount('agent-b')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(fresh.host.effectFailures).toEqual([])
  })

  it('⑪ the fail-closed twin: a non-enabled cwd, a missing cwd and NO generation still deny in the SAME round', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const fresh = rig({ recheckDelaysMs: [30, 60] })
    fresh.host.setWorkspaces([entity('w-oa', '/w/oa'), entity('w-other', '/w/other')])
    fresh.tools.refresh()
    await drain()
    saveScope(fresh.scope, 'selected', ['w-oa'])

    // ── (a) the cwd RESOLVES — into a workspace this document does not enable ──
    fresh.host.addAgent({ id: 'agent-other', cwd: '/w/other' })
    expect(fresh.scope.judgement('agent-other')).toBeUndefined()
    expect(fresh.host.restrictCalls.filter((call) => call.agentId === 'agent-other')).toHaveLength(1)
    expect(denyOf(fresh.host.restrictCalls.find((call) => call.agentId === 'agent-other')!)).toEqual([
      ...CHERRY_TOOL_NAMES,
    ])
    expect(fresh.host.layerCount('agent-other')).toBe(1)
    expect(fresh.scope.layer('agent-other')?.deny).toHaveLength(14)
    expect(fresh.host.agentView('agent-other')).toEqual([])
    expect(fresh.host.verdict('agent-other', CHERRY_TOOL_NAMES[0]!)).toBeDefined()

    // ── (b) no cwd at all: `no-cwd` is invisible under `selected`, same round ──
    fresh.host.addAgent({ id: 'agent-nocwd' })
    expect(fresh.scope.judgement('agent-nocwd')).toBeUndefined()
    expect(fresh.host.layerCount('agent-nocwd')).toBe(1)
    expect(fresh.scope.layer('agent-nocwd')?.deny).toHaveLength(14)
    expect(fresh.host.verdict('agent-nocwd', CHERRY_TOOL_NAMES[0]!)).toBeDefined()

    // ── (c) NO usable generation: the document ENABLES the workspace (saved while
    // the list was still readable — the write side refuses once it is not), and
    // then the registry read FAILS (`unavailable`, never `read`). Only that can
    // explain the deny below: under ⑩'s generation this very cwd resolves visible. ──
    const blind = rig({ recheckDelaysMs: [30, 60] })
    blind.host.setWorkspaces([entity('w-oa', '/w/oa')])
    blind.tools.refresh()
    await drain()
    saveScope(blind.scope, 'selected', ['w-oa'])
    blind.host.setWorkspaces([])
    blind.tools.refresh()
    await drain()
    expect(blind.scope.degraded().map((note) => note.source)).toContain('workspace-list')
    blind.host.addAgent({ id: 'agent-blind', cwd: '/w/oa' })
    expect(blind.host.restrictCalls.filter((call) => call.agentId === 'agent-blind')).toHaveLength(1)
    expect(blind.host.layerCount('agent-blind')).toBe(1)
    expect(blind.scope.layer('agent-blind')?.deny).toHaveLength(14)
    expect(blind.host.agentView('agent-blind')).toEqual([])
    expect(blind.host.verdict('agent-blind', CHERRY_TOOL_NAMES[0]!)).toBeDefined()

    // ── (c2) the OTHER arm of "no usable generation": 未读. The same `!== 'read'`
    // predicate in `resolveNow`, reached the other way — the list was never read
    // at all (the injection arrives with the agent already live) rather than read
    // and failed. The document ENABLES the workspace and the registry holds it
    // with this agent as a MEMBER, so the synchronous deny below is explainable
    // ONLY by the absent generation: the round that lands right behind it
    // resolves the very same agent visible and releases the layer. ──
    const unread = rig({
      deferInjection: true,
      patchRoot: (fake) => {
        // Both the registry entry and the session membership are in place BEFORE
        // the injection callback is even delivered, so no pass can have read them.
        fake.setWorkspaces([entity('w-oa', '/w/oa', ['agent-unread'])])
        fake.addAgent({ id: 'agent-unread', cwd: '/w/oa' })
      },
    })
    // 未读 is not 读失败: the write side is open and prunes nothing (N1 keeps
    // this true after a teardown as well).
    saveScope(unread.scope, 'selected', ['w-oa'])
    unread.host.deliverInjection()

    // SYNCHRONOUSLY, with no await: with no list of its own yet, the first pass
    // denies instead of releasing — even though the agent is a member of an
    // ENABLED workspace.
    expect(unread.scope.judgement('agent-unread')).toBeUndefined()
    expect(unread.host.layerCount('agent-unread')).toBe(1)
    expect(unread.scope.layer('agent-unread')?.deny).toHaveLength(14)
    expect(unread.host.agentView('agent-unread')).toEqual([])
    expect(unread.host.verdict('agent-unread', CHERRY_TOOL_NAMES[0]!)).toBeDefined()
    // The record's REASON is already the member conclusion, and that is the real
    // ordering rather than a leak: installing a layer calls `restrict()`, the host
    // emits `tools/change` on that call, the plugin's own listener starts a round,
    // and that round's SYNCHRONOUS HEAD reads the list — all before `reasonFor`
    // runs at the end of this same pass. 未读 is therefore a property of the PASS
    // (what `resolveNow` could answer when the deny was DECIDED), not of the
    // record. The discriminating pin for it is the unit-level
    // `resolveNow(...) === undefined` in toolScopeJudge ⑦: an empty list makes
    // rule two conclude `no-match`, so this arm's deny would look identical if
    // the `!== 'read'` guard were widened (verified by mutation while writing it).
    expect(unread.scope.layer('agent-unread')?.reason).toContain('会话成员命中')

    // The round behind it reads both and releases the same agent: the deny was
    // the missing generation, never a fact about the registry.
    await drain()
    expect(unread.scope.judgement('agent-unread')?.status).toBe('resolved')
    expect(unread.scope.judgement('agent-unread')?.visible).toBe(true)
    expect(unread.scope.layer('agent-unread')).toBeUndefined()
    expect(unread.host.layerCount('agent-unread')).toBe(0)
    expect(unread.host.agentView('agent-unread')).toEqual([...CHERRY_TOOL_NAMES])
    expect(unread.host.verdict('agent-unread', CHERRY_TOOL_NAMES[0]!)).toBeUndefined()
  })
})

/**
 * Captures the teardown disposer of EVERY effect run (one per injection
 * delivery). It is the only handle that can tear ONE generation down while a
 * NEWER one is still live — and therefore the only way to reproduce the
 * late-teardown ordering the host can produce when a dependency fibre disposes
 * the previous run after the new body has already taken over. `refuseOnFirst`
 * names the events the FIRST delivery's `on()` refuses (R16's contained shape),
 * so the older generation owns no subscription and installs no layer of its own.
 */
function captureGenerations(
  fake: FakeToolHost,
  captured: Array<() => void>,
  refuseOnFirst: readonly string[] = [],
): void {
  let deliveries = 0
  const realInject = fake.root.inject as NonNullable<ScopeHostContext['inject']>
  fake.root.inject = ((keys: readonly string[], cb: (ctx: unknown) => void | (() => void)) =>
    realInject(keys, (ctx: unknown) => {
      deliveries += 1
      const refuse = deliveries === 1
      const injected = ctx as {
        effect?: (body: () => () => void, label?: string) => unknown
        on?: (event: string, handler: (payload: unknown) => void) => () => void
      }
      const realEffect = injected.effect
      const realOn = injected.on
      return cb({
        ...(ctx as Record<string, unknown>),
        ...(realEffect === undefined
          ? {}
          : {
              effect: (body: () => () => void, label?: string) => {
                const handle = realEffect.call(injected, body, label) as { dispose: () => void }
                captured.push(handle.dispose)
                return handle
              },
            }),
        ...(realOn === undefined
          ? {}
          : {
              on: (event: string, handler: (payload: unknown) => void) => {
                if (refuse && refuseOnFirst.includes(event)) {
                  throw new Error(`the host refused the "${event}" subscription`)
                }
                return realOn.call(injected, event, handler)
              },
            }),
      })
    })) as NonNullable<ScopeHostContext['inject']>
}

describe('Wave 1 review fixes: generation-scoped teardown, contained releases, recorded fail-opens', () => {
  it('① an OLDER generation’s teardown leaves the NEWER generation’s records, map and state alone', async () => {
    const generations: Array<() => void> = []
    const fresh = rig({
      // Both generations must complete registration to be LIVE at once; the host
      // would refuse a duplicate name, so this fixture owns the 14 names itself
      // and lets each generation succeed. What is under test is the shared
      // DERIVED generation, not who owns the registration.
      registerTools: () => () => {},
      patchRoot: (fake) => {
        registerOn(fake, CHERRY_TOOL_NAMES)
        captureGenerations(fake, generations, ['agent/created', 'tools/change'])
      },
    })
    // Let the older generation's own first round settle before anything else.
    await drain()
    expect(fresh.tools.state().state).toBe('ready')
    expect(generations).toHaveLength(1)

    fresh.host.setWorkspaces([entity('w-oa', '/w/oa')])
    // Both agents exist BEFORE the newer generation: the older one has no
    // `agent/created` listener (R16 refused it), so only the newer one ever
    // applies them, and every layer below belongs to the newer generation.
    fresh.host.addAgent({ id: 'agent-b', cwd: '/w/oa' })
    fresh.host.addAgent({ id: 'agent-x', cwd: '/nowhere' })

    // A second injection delivery: a NEW generation takes over as `current`.
    fresh.host.reloadDependencies()
    expect(generations).toHaveLength(2)
    expect(fresh.tools.state().state).toBe('ready')
    await drain()

    // The newer generation's records, judgement cache and path map are in place.
    expect(fresh.host.layerCount('agent-b')).toBe(1)
    expect(fresh.scope.layer('agent-b')).toBeDefined()
    expect(fresh.scope.judgement('agent-b')).toBeDefined()
    expect(fresh.scope.pathUnmatched()).toEqual([{ agentId: 'agent-x', cwd: '/nowhere' }])
    expect(fresh.scope.host().state).toBe('ready')

    // …and NOW the OLDER generation is torn down, late.
    generations[0]!()

    // The newer generation's installed layer, its record, its judgements and its
    // path map all survive: the guard's 「层在 ⇒ 拒绝」 mirror still has a record
    // to read, and the newer `ready` generation is not told it was unloaded.
    expect(fresh.host.layerCount('agent-b')).toBe(1)
    expect(fresh.scope.layer('agent-b')).toBeDefined()
    expect(fresh.scope.judgement('agent-b')).toBeDefined()
    expect(fresh.scope.pathUnmatched()).toEqual([{ agentId: 'agent-x', cwd: '/nowhere' }])
    expect(fresh.scope.host().state).toBe('ready')
    // Still the ready wording — not R14's `pending` / 「注入回调已卸载」 pair.
    expect(fresh.scope.host().reason).toContain('宿主能力齐备')
    // The older generation released only what it owned: its own guard.
    expect(fresh.host.guardLive()).toBe(1)
    expect(fresh.host.liveSubscriptions('agent/created')).toBe(1)
    expect(fresh.host.effectFailures).toEqual([])
  })

  it('② a THROWING layer disposer is contained AND recorded, never an orphaned layer without a record', async () => {
    let observed: ReturnType<typeof observeListeners> | undefined
    const fresh = rig({
      patchRoot: (fake) => {
        observed = observeListeners(fake, ['agent/created', 'agent/disposed'])
      },
    })
    fresh.host.setWorkspaces([entity('w-oa', '/w/oa')])
    fresh.tools.refresh()
    await drain()

    /** A real event payload whose restriction can never be released. */
    const throwingAgent = (id: string, cwd: string) => ({
      id,
      session: { header: { cwd } },
      ctx: {
        tools: {
          restrict: () => () => {
            throw new Error('the host refused the release')
          },
        },
      },
    })

    // ── (a) the release-only arm: invisible first, then the workspace enables ──
    // The empty selection is a legal document (the panel's SELECTED_EMPTY_HINT
    // case): `w-oa` is registered but NOT enabled yet, so this first delivery is
    // genuinely invisible and installs the deny layer.
    saveScope(fresh.scope, 'selected', [])
    expect(() =>
      observed!.deliver('agent/created', { agent: throwingAgent('agent-throw-a', '/w/oa') }),
    ).not.toThrow()
    expect(fresh.scope.layer('agent-throw-a')).toBeDefined()
    saveScope(fresh.scope, 'selected', ['w-oa'])
    // The re-announce resolves visible synchronously ⇒ release only ⇒ the
    // disposer throws.
    expect(() =>
      observed!.deliver('agent/created', { agent: throwingAgent('agent-throw-a', '/w/oa') }),
    ).not.toThrow()
    expect(fresh.scope.layer('agent-throw-a')).toBeUndefined()
    const released = fresh.scope.degraded().find((entry) => entry.source === 'install')
    expect(released?.reason).toContain('agent agent-throw-a 的 restriction 释放失败')
    expect(released?.reason).toContain('层可能仍在生效，仅重启 DSH 可清除')
    expect(released?.reason).toContain('the host refused the release')
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      '释放 agent agent-throw-a 的 restriction 失败',
    )

    // ── (b) the `agent/disposed` arm: `onDisposed`'s own release path ──────────
    // Delivered through the captured listener rather than `disposeAgent`: the
    // fake's disposal control only fires for its LIVE records, and a live record
    // cannot be given a throwing `restrict` (`FakeAgentSeed` has no such hook).
    // This is the same event, delivered straight into the plugin's listener — so
    // unlike `#emit`, a rethrow would reach this call.
    expect(() =>
      observed!.deliver('agent/created', { agent: throwingAgent('agent-throw-b', '/nowhere') }),
    ).not.toThrow()
    expect(fresh.scope.layer('agent-throw-b')).toBeDefined()
    expect(() =>
      observed!.deliver('agent/disposed', { agent: throwingAgent('agent-throw-b', '/nowhere') }),
    ).not.toThrow()
    expect(fresh.scope.layer('agent-throw-b')).toBeUndefined()
    const disposed = fresh.scope.degraded().find((entry) => entry.source === 'install')
    expect(disposed?.reason).toContain('agent agent-throw-b 的 restriction 释放失败')
    expect(disposed?.reason).toContain('层可能仍在生效，仅重启 DSH 可清除')
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      '释放 agent agent-throw-b 的 restriction 失败',
    )

    // ── (c) §6.2's teardown arm: the layer is still installed when the effect ──
    // is disposed, so the same containment must hold on the way out.
    expect(() =>
      observed!.deliver('agent/created', { agent: throwingAgent('agent-throw-c', '/nowhere') }),
    ).not.toThrow()
    expect(fresh.scope.layer('agent-throw-c')).toBeDefined()
    expect(() => fresh.dispose()).not.toThrow()
    expect(fresh.scope.layer('agent-throw-c')).toBeUndefined()
    const tornDown = fresh.scope.degraded().find((entry) => entry.source === 'install')
    expect(tornDown?.reason).toContain('agent agent-throw-c 的 restriction 释放失败')
    expect(tornDown?.reason).toContain('层可能仍在生效，仅重启 DSH 可清除')
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      '释放 agent agent-throw-c 的 restriction 失败',
    )
  })

  it('③ an agent without agent.ctx.tools.restrict is RECORDED, not a silent fail-open', async () => {
    let observed: ReturnType<typeof observeListeners> | undefined
    const fresh = rig({
      patchRoot: (fake) => {
        observed = observeListeners(fake, ['agent/created'])
      },
    })
    fresh.host.setWorkspaces([entity('w-oa', '/w/oa')])
    fresh.tools.refresh()
    await drain()
    saveScope(fresh.scope, 'selected', ['w-oa'])

    const installs = fresh.host.restrictCalls.length
    const opsBefore = fresh.host.ops.length
    // The host's own payload shape, minus `ctx.tools.restrict`: a cwd outside
    // every registered workspace, so the target set is the full deny.
    expect(() =>
      observed!.deliver('agent/created', {
        agent: { id: 'agent-no-restrict', session: { header: { cwd: '/w/other' } }, ctx: { tools: {} } },
      }),
    ).not.toThrow()

    // The log still fires…
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'agent-no-restrict 没有 agent.ctx.tools.restrict',
    )
    // …and it is no longer SILENT: `degraded` carries the same `install` source
    // the refused-install and failed-release arms use, with a reason that names
    // THIS condition and its consequence.
    const note = fresh.scope.degraded().find((entry) => entry.source === 'install')
    expect(note?.reason).toContain('agent-no-restrict')
    expect(note?.reason).toContain('缺少 agent.ctx.tools.restrict')
    expect(note?.reason).toContain('目标工具保持可见且 guard 放行')

    // Not one layer-changing host call was attempted for it…
    expect(fresh.host.restrictCalls.length).toBe(installs)
    expect(
      fresh.host.ops.slice(opsBefore).filter((entry) => entry.op === 'restrict' || entry.op === 'release-layer'),
    ).toEqual([])
    expect(fresh.host.layerCount('agent-no-restrict')).toBe(0)
    expect(fresh.scope.layer('agent-no-restrict')).toBeUndefined()
    // …and the fail-open the plugin cannot prevent is on the record rather than
    // hidden: with no layer there is nothing for the guard to reject.
    expect(fresh.host.verdict('agent-no-restrict', CHERRY_TOOL_NAMES[0]!)).toBeUndefined()
  })
})

describe('Gate 3 round 2 fixes: an empty generation on re-mount, a shared record that survives', () => {
  it('① a re-mount across a CHANGED registry DENIES in its first synchronous pass', async () => {
    const { host, scope, tools } = rig()
    // Mount 1's generation: `agent-a` is a MEMBER of `w-oa` (rule one) and the
    // document enables that workspace, so this mount answers "visible" for it
    // without consulting the path map at all.
    host.setWorkspaces([entity('w-oa', '/w/oa', ['agent-a'])])
    tools.refresh()
    await drain()
    saveScope(scope, 'selected', ['w-oa'])
    host.addAgent({ id: 'agent-a', cwd: '/w/oa' })

    // RELEASE, synchronously, from rule one of the list mount 1 read — and no
    // layer for the agent. That is the state the re-mounted generation must not
    // inherit as a fact about the new registry.
    expect(scope.judgement('agent-a')).toBeUndefined()
    expect(host.layerCount('agent-a')).toBe(0)
    await drain()
    expect(scope.judgement('agent-a')?.visible).toBe(true)

    // The window between the two mounts: the registry CHANGED — the membership
    // is gone and the old cwd is registered nowhere.
    host.unloadDependencies()
    host.setWorkspaces([entity('w-other', '/w/other')])
    host.reloadDependencies()

    // The FIRST synchronous pass of the new mount, with NO await in between:
    // with no generation of its own yet, the only safe answer is the deny.
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')?.deny).toHaveLength(14)
    expect(host.agentView('agent-a')).toEqual([])
    expect(host.verdict('agent-a', CHERRY_TOOL_NAMES[0]!)).toBeDefined()

    // The round that lands confirms it: the cwd now resolves outside every
    // registered workspace, so the layer stays.
    await drain()
    expect(scope.judgement('agent-a')?.status).toBe('no-match')
    expect(scope.judgement('agent-a')?.visible).toBe(false)
    expect(host.layerCount('agent-a')).toBe(1)
    expect(scope.layer('agent-a')?.deny).toHaveLength(14)
    expect(host.effectFailures).toEqual([])
  })

  it('② an OLDER generation’s teardown leaves the NEWER generation’s shared record in place', async () => {
    const generations: Array<() => void> = []
    const fresh = rig({
      registerTools: () => () => {},
      patchRoot: (fake) => {
        fake.setWorkspaces([entity('w-oa', '/w/oa')])
        // 13 of the 14 names are in the scene at the FIRST delivery, so the older
        // generation's layer carries a 13-name deny set…
        registerOn(fake, CHERRY_TOOL_NAMES.slice(0, 13))
        // …and the agent is live BEFORE that delivery, so the older generation's
        // own first pass installs a layer for it. That generation owns no
        // `agent/created` / `tools/change` subscription, so the 14th registration
        // below cannot make it re-apply.
        captureGenerations(fake, generations, ['agent/created', 'tools/change'])
        fake.addAgent({ id: 'agent-b', cwd: '/w/oa' })
      },
    })
    await drain()
    expect(fresh.tools.state().state).toBe('ready')
    expect(generations).toHaveLength(1)
    // The older generation owns the layer AND the shared record.
    expect(fresh.host.layerCount('agent-b')).toBe(1)
    expect(fresh.scope.layer('agent-b')?.deny).toHaveLength(13)

    // The scene gains the 14th name, so the newer generation's target DIFFERS
    // from the older record: its first pass installs its OWN layer and rewrites
    // the shared record — the double-install overlap.
    registerOn(fresh.host, CHERRY_TOOL_NAMES.slice(13))
    fresh.host.reloadDependencies()
    expect(generations).toHaveLength(2)
    await drain()
    expect(fresh.host.layerCount('agent-b')).toBe(2)
    expect(fresh.scope.layer('agent-b')?.deny).toHaveLength(14)

    // NOW the older generation is torn down, late.
    generations[0]!()

    // It releases the layer it owned…
    expect(fresh.host.layerCount('agent-b')).toBe(1)
    // …and must NOT delete the record of the layer the newer generation still
    // has installed: the guard's 「层在 ⇒ 拒绝」 mirror reads exactly that record,
    // so clearing it would leave the newer layer unrecorded — and therefore
    // allowed.
    expect(fresh.scope.layer('agent-b')?.deny).toHaveLength(14)
    expect(fresh.host.verdict('agent-b', CHERRY_TOOL_NAMES[0]!)).toBeDefined()
    // The newer generation itself is untouched: still current, still ready.
    expect(fresh.scope.judgement('agent-b')).toBeDefined()
    expect(fresh.tools.state().state).toBe('ready')
    expect(fresh.host.effectFailures).toEqual([])
  })
})
