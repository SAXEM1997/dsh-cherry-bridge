/**
 * A fake `@deepseek-ai/dsh-tools` HOST — not an assembly fixture.
 *
 * This helper models the host semantics the scope subsystem is written against
 * (spec §4/§7), so a test can drive `src/toolScopeHost.ts` through the same
 * seams the real host exposes: the plugin root ctx's `tools` face, the dynamic
 * `inject(['agents','workspaceRegistry'], …)` callback and its `effect`/`on`
 * lifecycle, per-`agent.ctx` restrictions, the event surface and the guard.
 *
 * The seven semantics §7 requires (drop one and the related assertion passes
 * vacuously):
 *
 *  ① `restrict({})` — both keys absent — MUST throw;
 *  ② `restrict({ deny: [] })` does NOT throw: it installs a no-op layer that
 *     admits every name, and every call's ARGUMENT is recorded, so "the plugin
 *     never submits an empty deny" is assertable;
 *  ③ `restrict` throws for an unknown global name and for the reserved
 *     transport name `run_code` (agent-local names cannot occur here: this fake
 *     has no agent-scoped registrations);
 *  ④ restrictions intersect ACROSS layers (`every(admits)`): stacking two deny
 *     layers cannot be undone by releasing one of them;
 *  ⑤ `schemas()` (no argument) is the GLOBAL view; `schemas(agent)` is that
 *     agent's view AFTER its restrictions;
 *  ⑥ `restrict()` on a non-scoped context (the plugin root ctx, or the ctx the
 *     injection callback receives) throws the host's own message — without this
 *     the "restrictions only ever go on `agent.ctx`" hard constraint is
 *     untestable;
 *  ⑦ `guard()` emits `tools/change` on NEITHER install nor release, while
 *     `register()` and `restrict()` emit on BOTH sides (the release side is the
 *     one that matters: it is what makes the teardown order load-bearing).
 *
 * Every host-side mutation is also appended to {@link FakeToolHost.ops}, the
 * operation log the teardown-order assertions read (unsubscribe ⇒ release
 * registrations ⇒ release restrictions ⇒ release guard).
 */
import type { ScopeHostContext } from '../../src/toolScopeHost.js'

/** One capability of the plugin root's `tools` face, removable by a fixture. */
export type FakeCapability = 'register' | 'restrict' | 'schemas' | 'guard'

export interface FakeHostOptions {
  /**
   * Register the injection callback WITHOUT calling it — the "依赖尚未到达"
   * state. {@link FakeToolHost.deliverInjection} then arrives it.
   */
  deferInjection?: boolean
  /** `inject` throws instead (宿主服务未就绪). */
  injectThrows?: boolean
  /** Capabilities to REMOVE from the plugin root's `tools` face. */
  without?: readonly FakeCapability[]
}

/** One workspace registry entry, in the shape `list()` returns. */
export interface FakeWorkspace {
  id: string
  title?: string
  path: string
  sessionIds?: readonly string[]
}

/** One live agent's seed, as a test states it. */
export interface FakeAgentSeed {
  id: string
  cwd?: string
}

/** A restriction filter exactly as the host declares it. */
export interface FakeRestrictFilter {
  allow?: readonly string[]
  deny?: readonly string[]
}

/** One recorded restrict() call: the agent it targeted and its verbatim argument. */
export interface FakeRestrictCall {
  agentId: string
  filter: FakeRestrictFilter
}

/** One host-side operation, in the order the host performed it. */
export type FakeOp =
  | { op: 'inject' }
  | { op: 'effect-run' }
  | { op: 'subscribe'; event: string }
  | { op: 'unsubscribe'; event: string }
  | { op: 'register'; name: string }
  | { op: 'unregister'; name: string }
  | { op: 'restrict'; agentId: string; filter: FakeRestrictFilter }
  | { op: 'release-layer'; agentId: string }
  | { op: 'guard-install' }
  | { op: 'guard-release' }
  | { op: 'tools-change' }

/** A guard, exactly as `tools.guard()` declares it. */
type FakeGuard = (execution: { readonly name: string; readonly agent?: { readonly id: string } }) => string | undefined

/** One installed layer. `deny`/`allow` are mutually exclusive in this fake. */
interface FakeLayer {
  deny?: readonly string[]
  allow?: readonly string[]
}

interface FakeAgentRecord {
  id: string
  cwd?: string
  raw: {
    id: string
    session: { header: { cwd?: string } }
    ctx: { tools: { restrict(filter: FakeRestrictFilter): () => void; schemas(scope?: unknown): unknown } }
  }
}

const SCOPED_ONLY =
  'tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent'

export class FakeToolHost {
  /** Every host-side operation, in order — the teardown-order instrument. */
  readonly ops: FakeOp[] = []
  /** Every global `register()` name ever accepted, in order. Never cleared. */
  readonly registerCalls: string[] = []
  /** Every `restrict()` ARGUMENT ever passed (including ones that threw). */
  readonly restrictCalls: FakeRestrictCall[] = []

  /** The plugin root ctx, handed to `mount()`. */
  readonly root: ScopeHostContext

  readonly #options: FakeHostOptions
  #names = new Map<string, { name: string; description: string; parameters?: unknown }>()
  #guards: FakeGuard[] = []
  #subscriptions = new Map<string, Set<(payload: unknown) => void>>()
  #live = new Map<string, FakeAgentRecord>()
  /** Layers per agent id, kept OUTSIDE liveness so an unreleased layer stays visible. */
  #layers = new Map<string, FakeLayer[]>()
  #effectDisposers: Array<() => void> = []
  #injectionCallback: ((ctx: unknown) => unknown) | undefined
  #workspaces: FakeWorkspace[] = []
  #listCalls = 0

  guardInstalls = 0
  guardReleases = 0
  injectedEffectRuns = 0
  /** When true, `resolveByPath` rejects (D14's "not ready / realpath failed"). */
  resolveByPathThrows = false

  constructor(options: FakeHostOptions = {}) {
    this.#options = options

    const tools: NonNullable<ScopeHostContext['tools']> = {
      register: (definition) => this.#register(definition),
      restrict: () => {
        throw new Error(SCOPED_ONLY)
      },
      guard: (guard) => this.#installGuard(guard),
      schemas: (scope) => this.#schemas(scope),
    }
    for (const capability of options.without ?? []) {
      delete (tools as Record<string, unknown>)[capability]
    }

    this.root = {
      tools,
      inject: (keys, cb) => this.#inject(keys, cb),
      on: <T>(event: string, cb: (payload: T) => void) => this.#on(event, cb as (payload: unknown) => void),
    }
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  /** The names currently in the global registry. */
  registeredNames(): string[] {
    return [...this.#names.keys()]
  }

  /** Layers currently installed for one agent, released or not. */
  layerCount(agentId: string): number {
    return this.#layers.get(agentId)?.length ?? 0
  }

  /** Layers installed across every agent. */
  layerTotal(): number {
    let total = 0
    for (const layers of this.#layers.values()) total += layers.length
    return total
  }

  /** Guards currently installed. */
  guardLive(): number {
    return this.guardInstalls - this.guardReleases
  }

  /** Live subscriptions, for one event or for all of them. */
  liveSubscriptions(event?: string): number {
    if (event !== undefined) return this.#subscriptions.get(event)?.size ?? 0
    let total = 0
    for (const listeners of this.#subscriptions.values()) total += listeners.size
    return total
  }

  /** Live effect disposers handed out by the injected ctx (fibre mounts). */
  liveEffects(): number {
    return this.#effectDisposers.length
  }

  /** How many times the workspace registry's `list()` was read. */
  listCalls(): number {
    return this.#listCalls
  }

  /** The live agents, as `agents.list()` returns them. */
  liveAgentIds(): string[] {
    return [...this.#live.keys()]
  }

  /**
   * The tool names one agent can see: the global view with every one of that
   * agent's layers applied (cross-layer intersection, semantic ④).
   */
  agentView(agentId: string): string[] {
    const layers = this.#layers.get(agentId) ?? []
    return [...this.#names.keys()].filter((name) => layers.every((layer) => admits(layer, name)))
  }

  /** The guard verdict for one dispatch: a string rejects, `undefined` allows. */
  verdict(agentId: string | undefined, name: string): string | undefined {
    for (const guard of this.#guards) {
      const outcome = guard({ name, ...(agentId === undefined ? {} : { agent: { id: agentId } }) })
      if (typeof outcome === 'string') return outcome
    }
    return undefined
  }

  // -------------------------------------------------------------------------
  // Agent / registry controls
  // -------------------------------------------------------------------------

  addAgent(seed: FakeAgentSeed): void {
    const record = this.#makeAgent(seed)
    this.#live.set(seed.id, record)
    // `@mode serial` on the host side: a listener that throws fails the session
    // creation, so the throw is NOT swallowed here.
    this.#emit('agent/created', { agent: record.raw, source: 'fake-host' })
  }

  /** Disposes the agent WITHOUT touching its layers: an unreleased layer stays observable. */
  disposeAgent(id: string): void {
    const record = this.#live.get(id)
    if (record === undefined) return
    this.#live.delete(id)
    this.#emit('agent/disposed', { agent: record.raw }, true)
  }

  setWorkspaces(list: readonly FakeWorkspace[]): void {
    this.#workspaces = list.map((workspace) => ({ ...workspace, sessionIds: [...(workspace.sessionIds ?? [])] }))
  }

  // -------------------------------------------------------------------------
  // Lifecycle controls (the fibre the plugin cannot hold)
  // -------------------------------------------------------------------------

  /** Arrives the recorded injection callback (the deferred case). */
  deliverInjection(): void {
    const callback = this.#injectionCallback
    if (callback === undefined) return
    callback(this.#injectedCtx())
  }

  /** Runs the disposers the injected ctx's `effect()` handed out (依赖卸载). */
  unloadDependencies(): void {
    for (const dispose of this.#effectDisposers.splice(0)) dispose()
  }

  /** Re-arrives the injection callback, as a dependency fibre re-mount does. */
  reloadDependencies(): void {
    this.deliverInjection()
  }

  /** Arrives one `tools/change` event (no payload, as the host emits it). */
  emitToolsChange(): void {
    this.#emitToolsChange()
  }

  // -------------------------------------------------------------------------
  // Host internals
  // -------------------------------------------------------------------------

  #inject(keys: readonly string[], cb: (ctx: never) => unknown): unknown {
    if (this.#options.injectThrows === true) {
      throw new Error(`service "${keys[0] ?? 'agents'}" is not available`)
    }
    this.#injectionCallback = cb as (ctx: unknown) => unknown
    this.ops.push({ op: 'inject' })
    if (this.#options.deferInjection !== true) this.deliverInjection()
    return undefined
  }

  #injectedCtx(): unknown {
    return {
      agents: { list: () => [...this.#live.values()].map((record) => record.raw) },
      workspaceRegistry: {
        list: () => {
          this.#listCalls += 1
          return this.#workspaces
        },
        resolveByPath: async (path: string) => {
          if (this.resolveByPathThrows) throw new Error(`resolveByPath failed for ${path}`)
          return this.#workspaces.find((workspace) => workspace.path === path)
        },
      },
      effect: (cb: () => () => void) => {
        this.injectedEffectRuns += 1
        this.ops.push({ op: 'effect-run' })
        const dispose = cb()
        this.#effectDisposers.push(dispose)
        return { dispose }
      },
      on: (event: string, cb: (payload: unknown) => void) => this.#on(event, cb),
      // Semantic ⑥, second half: this ctx is NOT a scoped agent ctx either.
      tools: {
        restrict: () => {
          throw new Error(SCOPED_ONLY)
        },
      },
    }
  }

  #makeAgent(seed: FakeAgentSeed): FakeAgentRecord {
    const raw: FakeAgentRecord['raw'] = {
      id: seed.id,
      session: { header: seed.cwd === undefined ? {} : { cwd: seed.cwd } },
      ctx: {
        tools: {
          restrict: (filter) => this.#restrict(seed.id, filter),
          schemas: (scope) => this.#schemas(scope ?? seed.id),
        },
      },
    }
    return { id: seed.id, ...(seed.cwd === undefined ? {} : { cwd: seed.cwd }), raw }
  }

  #on(event: string, cb: (payload: unknown) => void): () => void {
    const listeners = this.#subscriptions.get(event) ?? new Set()
    listeners.add(cb)
    this.#subscriptions.set(event, listeners)
    this.ops.push({ op: 'subscribe', event })
    return () => {
      listeners.delete(cb)
      this.ops.push({ op: 'unsubscribe', event })
    }
  }

  #emit(event: string, payload: unknown, swallow = false): void {
    for (const listener of [...(this.#subscriptions.get(event) ?? [])]) {
      try {
        listener(payload)
      } catch (error) {
        if (!swallow) throw error
      }
    }
  }

  #emitToolsChange(): void {
    this.ops.push({ op: 'tools-change' })
    this.#emit('tools/change', undefined, true)
  }

  #register(definition: { readonly name: string; readonly description: string; readonly parameters?: unknown }): () => void {
    if (this.#names.has(definition.name)) {
      throw new Error(`tool already registered: ${definition.name}`)
    }
    this.#names.set(definition.name, { ...definition })
    this.registerCalls.push(definition.name)
    this.ops.push({ op: 'register', name: definition.name })
    this.#emitToolsChange()
    return () => {
      if (!this.#names.delete(definition.name)) return
      this.ops.push({ op: 'unregister', name: definition.name })
      this.#emitToolsChange()
    }
  }

  #restrict(agentId: string, filter: FakeRestrictFilter): () => void {
    // Recorded BEFORE validation: the argument a caller passed is evidence even
    // when the host refused it (semantic ②).
    this.restrictCalls.push({ agentId, filter: { ...filter } })
    this.ops.push({ op: 'restrict', agentId, filter: { ...filter } })

    // Semantic ①.
    if (filter.allow === undefined && filter.deny === undefined) {
      throw new Error('tools.restrict() requires at least one of allow/deny')
    }
    // Semantic ③.
    for (const name of [...(filter.deny ?? []), ...(filter.allow ?? [])]) {
      if (name === 'run_code') throw new Error('tools.restrict() names the reserved transport tool: run_code')
      if (!this.#names.has(name)) throw new Error(`tools.restrict() names unknown global tool: ${name}`)
    }

    const layer: FakeLayer = {
      ...(filter.deny === undefined ? {} : { deny: [...filter.deny] }),
      ...(filter.allow === undefined ? {} : { allow: [...filter.allow] }),
    }
    const layers = this.#layers.get(agentId) ?? []
    layers.push(layer)
    this.#layers.set(agentId, layers)
    // Semantic ⑦: the install side notifies.
    this.#emitToolsChange()

    return () => {
      const index = layers.indexOf(layer)
      if (index < 0) return
      layers.splice(index, 1)
      if (layers.length === 0) this.#layers.delete(agentId)
      this.ops.push({ op: 'release-layer', agentId })
      // …and so does the RELEASE side.
      this.#emitToolsChange()
    }
  }

  #installGuard(guard: FakeGuard): () => void {
    this.#guards.push(guard)
    this.guardInstalls += 1
    this.ops.push({ op: 'guard-install' })
    return () => {
      const index = this.#guards.indexOf(guard)
      if (index < 0) return
      this.#guards.splice(index, 1)
      this.guardReleases += 1
      this.ops.push({ op: 'guard-release' })
      // Semantic ⑦: `guard()` carries `notify:false` — no `tools/change` here.
    }
  }

  #schemas(scope?: unknown): Array<{ name: string; description: string; parameters?: unknown }> {
    const agentId = agentIdOf(scope)
    const names = agentId === undefined ? [...this.#names.keys()] : this.agentView(agentId)
    return names.map((name) => ({ ...(this.#names.get(name) as { name: string; description: string }) }))
  }
}

/** One layer's verdict for one name (cross-layer intersection is `every`). */
function admits(layer: FakeLayer, name: string): boolean {
  if (layer.deny !== undefined) return !layer.deny.includes(name)
  return (layer.allow ?? []).includes(name)
}

/** `schemas(scope)`: a string id, an object with an id, or the global view. */
function agentIdOf(scope: unknown): string | undefined {
  if (typeof scope === 'string') return scope
  if (typeof scope === 'object' && scope !== null) {
    const id = (scope as { id?: unknown }).id
    if (typeof id === 'string') return id
  }
  return undefined
}
