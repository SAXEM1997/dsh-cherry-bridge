/**
 * A fake `@deepseek-ai/dsh-tools` HOST for the step-time scope path (#343/#345).
 *
 * It models exactly the two facts the scope subsystem now relies on: a `tools`
 * face with `register` + `resolve`, and a dynamic `inject(['agents',
 * 'workspaceRegistry'], …)` whose callback hands back the live agents and the
 * registry. There is deliberately no `restrict`/`guard`/`schemas`/event surface:
 * the plugin's `engines.dsh` floor is `>=0.2.2-rc.1`, so the legacy path is gone.
 */
import type { ScopeHostContext } from '../../src/toolScopeHost.js'

/** One capability of the plugin root's `tools` face, removable by a fixture. */
export type FakeCapability = 'register' | 'resolve'

export interface FakeHostOptions {
  /** Register the injection callback WITHOUT calling it — the "依赖尚未到达" state. */
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

interface FakeAgentRecord {
  id: string
  session: { header: { cwd?: string } }
}

export class FakeToolHost {
  /** Every `inject` key set the plugin has handed over, in call order. */
  readonly injectKeyCalls: Array<readonly string[]> = []
  /** The plugin root ctx, handed to `mount()`. */
  readonly root: ScopeHostContext

  readonly #options: FakeHostOptions
  #names = new Map<string, { name: string; description: string; parameters?: unknown }>()
  #conditions = new Map<string, (context: { readonly agent: unknown }) => boolean | Promise<boolean>>()
  #live = new Map<string, FakeAgentRecord>()
  #effectDisposers: Array<() => void> = []
  #injectionCallbacks: Array<(ctx: unknown) => void | (() => void)> = []
  #lastInjectionCallback: ((ctx: unknown) => void | (() => void)) | undefined
  #registrationCalls = 0
  #duplicateRegistrations = 0
  #workspaces: FakeWorkspace[] = []

  injectedEffectRuns = 0
  /** Anything that ESCAPED an injected `effect` body. */
  readonly effectFailures: unknown[] = []

  constructor(options: FakeHostOptions = {}) {
    this.#options = options

    const tools: NonNullable<ScopeHostContext['tools']> = {
      register: (definition, options) => this.#register(definition, options),
      resolve: async (context) => context.agent,
    }
    for (const capability of options.without ?? []) {
      delete (tools as Record<string, unknown>)[capability]
    }

    this.root = {
      tools,
      inject: (keys, cb) => this.#inject(keys, cb),
      effect: (cb: () => () => void) => {
        this.injectedEffectRuns += 1
        try {
          this.#effectDisposers.push(cb())
        } catch (error) {
          this.effectFailures.push(error)
        }
        return () => {}
      },
    }
  }

  /** The names currently in the global registry. */
  registeredNames(): string[] {
    return [...this.#names.keys()]
  }

  /** How many registered definitions carry a step-time condition. */
  whenConditions(): number {
    return this.#conditions.size
  }

  /** The key set the LAST `inject` asked for — the plugin's own runtime list. */
  injectKeys(): readonly string[] {
    return this.injectKeyCalls[this.injectKeyCalls.length - 1] ?? []
  }

  /** The step-time view: every registered name whose `when` answers true for this agent. */
  async resolvedView(agentId: string): Promise<string[]> {
    const record = this.#live.get(agentId)
    const agent = record ?? { id: agentId, session: { header: {} } }
    const admitted: string[] = []
    for (const name of this.#names.keys()) {
      const when = this.#conditions.get(name)
      if (when === undefined || (await when({ agent }))) admitted.push(name)
    }
    return admitted
  }

  setWorkspaces(workspaces: readonly FakeWorkspace[]): void {
    this.#workspaces = [...workspaces]
  }

  addAgent(seed: FakeAgentSeed): void {
    this.#live.set(seed.id, {
      id: seed.id,
      session: { header: { ...(seed.cwd === undefined ? {} : { cwd: seed.cwd }) } },
    })
  }

  /** Total `register()` calls, including ones a later mount replaced. */
  registrationCalls(): number {
    return this.#registrationCalls
  }

  /** Registrations that landed while a name was ALREADY live (a leaked mount). */
  duplicateRegistrations(): number {
    return this.#duplicateRegistrations
  }

  /** Re-runs the LAST injection callback: a dependency re-injection. */
  redeliverInjection(): void {
    this.#lastInjectionCallback?.(this.#injectedContext())
  }

  /** Releases one recorded effect disposer (the last by default). */
  releaseEffect(index = this.#effectDisposers.length - 1): void {
    const [dispose] = this.#effectDisposers.splice(index, 1)
    dispose?.()
  }

  /** How many deferred injection callbacks are still pending. */
  injectionCount(): number {
    return this.#injectionCallbacks.length
  }

  /**
   * Delivers one deferred injection callback (the last by default). A stale
   * mount's callback is addressed by its index.
   */
  deliverInjection(index = this.#injectionCallbacks.length - 1): void {
    const callback = this.#injectionCallbacks[index]
    this.#injectionCallbacks.splice(index, 1)
    callback?.(this.#injectedContext())
  }

  /** Releases every effect registered so far (the host unloading the plugin). */
  dispose(): void {
    for (const dispose of this.#effectDisposers.splice(0)) dispose()
  }

  #injectedContext(): {
    agents: { list(): unknown }
    workspaceRegistry: { list(): unknown; resolveByPath(path: string): Promise<unknown | undefined> }
    effect(cb: () => () => void): unknown
  } {
    return {
      agents: { list: () => [...this.#live.values()] },
      workspaceRegistry: {
        list: () => this.#workspaces.map(({ id, title, path }) => ({ id, title, path })),
        resolveByPath: async (path: string) =>
          this.#workspaces.find((workspace) => workspace.path === path),
      },
      effect: this.root.effect!,
    }
  }

  #inject<T>(keys: readonly string[], cb: (ctx: T) => void | (() => void)): unknown {
    this.injectKeyCalls.push(keys)
    if (this.#options.injectThrows === true) throw new Error('injection unavailable')
    if (this.#options.deferInjection === true) {
      this.#lastInjectionCallback = cb as (ctx: unknown) => void | (() => void)
      this.#injectionCallbacks.push(this.#lastInjectionCallback)
      return () => {}
    }
    cb(this.#injectedContext() as T)
    return () => {}
  }

  #register(
    definition: { readonly name: string; readonly description: string; readonly parameters?: unknown },
    options?: {
      when?(context: { readonly agent: unknown; readonly signal?: AbortSignal }): boolean | Promise<boolean>
    },
  ): () => void {
    this.#registrationCalls += 1
    if (this.#names.has(definition.name)) this.#duplicateRegistrations += 1
    const when = options?.when
    if (when === undefined) this.#conditions.delete(definition.name)
    else this.#conditions.set(definition.name, when)
    this.#names.set(definition.name, definition)
    return () => {
      this.#names.delete(definition.name)
      this.#conditions.delete(definition.name)
    }
  }
}
