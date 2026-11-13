/**
 * The host integration layer for tool scope: capability probe, the injection
 * gate, and the ONE registration that carries the family's step-time `when`.
 *
 * Two decisions carry this file:
 *
 *  1. **The host is mounted, not merely constructed.** {@link ToolScopeHost.mount}
 *     is the only entry point that installs anything, and it returns the only
 *     release path. `apply()` calls it after the assembly's root `ctx.effect`
 *     and pushes the returned disposer into `state.disposers`.
 *
 *  2. **`tools.resolve` is the contract.** A host that exposes it honours the
 *     `when` option per model step (dsh-tools 0.2.2-alpha.2+); one that does not
 *     is `unsupported` and registers NOTHING (fail-closed). The plugin's
 *     `engines.dsh` floor is `>=0.2.2-rc.1`, so the legacy per-agent
 *     `restrict`/`guard` path is gone (#345).
 *
 * State ownership stays with {@link ToolScopeState}: this module keeps no copy
 * of the document or the judgement generation; the shared condition reads them
 * through `visibleForAgent`.
 */
import type {
  ScopeAgentLike,
  ScopeHostState,
  ToolScopeState,
  WorkspaceRegistryLike,
} from './toolScope.js'

const EFFECT_LABEL = 'cherry-remote.tool-scope()'

/** The neutral waiting wording: `pending` must never read as "the host refuses". */
const PENDING_REASON = '等待宿主注入 agents / workspaceRegistry'

/** `ready` for the step-time path: `register` + `resolve` are the whole contract. */
const WHEN_READY_REASON = '宿主支持步骤级 when（tools.resolve）；按每个模型步骤判定可见性'
/** Reported after a released mount: neutral, never a stale `ready`. */
const RELEASED_REASON = '作用域挂载已释放'

/** The two dependency keys this subsystem gates on. They enter ONE `inject` call. */
const INJECT_KEYS: readonly string[] = ['agents', 'workspaceRegistry']

/**
 * The plugin root ctx, as this subsystem consumes it.
 *
 * Every member is optional — including `tools` as a whole — because `apply()`
 * holds a `CherryBridgeContext` whose `tools` face is optional and whose real
 * shape only promises `register`.
 */
export interface ScopeHostContext {
  tools?: {
    register(
      definition: {
        readonly name: string
        readonly description: string
        readonly parameters?: unknown
        execute(args: unknown, exec: unknown): Promise<unknown>
      },
      options?: {
        when?(context: { readonly agent: unknown; readonly signal?: AbortSignal }): boolean | Promise<boolean>
      },
    ): () => void
    /** The host's declaration that `when` is honoured (#343/#345). */
    resolve?(context: { readonly agent: unknown; readonly signal?: AbortSignal }): Promise<unknown>
  }
  /**
   * Dynamic injection — the host's fibre handle as the RETURN value, which this
   * plugin ignores: the fibre is the unit of unload/re-mount, and the only
   * release path this subsystem owns is the disposer `mount()` returns.
   */
  inject?<T>(keys: readonly string[], cb: (ctx: T) => void | (() => void)): unknown
  effect?(cb: () => () => void, label?: string): unknown
}

/** The ctx the injection callback receives: the two services plus this lifecycle. */
export interface ScopeInjectedContext {
  /** `list()` yields the live agents (projected through {@link projectAgent}). */
  agents?: { list(): unknown }
  workspaceRegistry?: WorkspaceRegistryLike
  effect?(cb: () => () => void, label?: string): unknown
}

/**
 * The registration face {@link registerAtomically} needs: a structural subset of
 * {@link ScopeHostContext.tools}, so both the assembly's own ctx and a fixture's
 * fake host satisfy it without a cast.
 */
export interface ScopeRegistrationContext {
  tools?: {
    register(
      definition: {
        readonly name: string
        readonly description: string
        readonly parameters?: unknown
        execute?(args: unknown, exec: unknown): Promise<unknown>
      },
      options?: {
        when?(context: { readonly agent: unknown; readonly signal?: AbortSignal }): boolean | Promise<boolean>
      },
    ): () => void
  }
}

/**
 * Runs ONE aggregate registration entry — `register(ledgerCtx)` — and guarantees
 * that a FAILED registration leaves nothing behind.
 *
 * The aggregate contract is `() => () => void`: the disposer is only ever handed
 * back on SUCCESS. A factory that registers three tools and then throws (a host
 * that refuses the fourth registration, or a name a previous assembly leaked)
 * therefore leaves those three with NO handle at all — its own local disposers
 * array never escapes, and no layer above it can release them. That is a leak
 * the caller cannot clean up, so it is closed here, at the single entry point
 * both the assembly and the fixtures go through: every `register()` disposer is
 * ledgered, and a throw releases the partial set before it travels on.
 *
 * On success the ledger stays out of the way: the returned aggregate disposer
 * owns every registration. The second `options` argument is FORWARDED: dropping
 * it here silently made every `when` registration unconditional (#343).
 */
export function registerAtomically(
  ctx: ScopeRegistrationContext,
  register: (ctx: ScopeRegistrationContext) => () => void,
): () => void {
  const releases: Array<() => void> = []
  const tools = ctx.tools
  const ledger: ScopeRegistrationContext =
    tools === undefined
      ? ctx
      : {
          tools: {
            register: (definition, options) => {
              // `tools.register(…)` keeps its receiver, so a host method that
              // relies on `this` behaves exactly as it does without the ledger.
              const release = tools.register(definition, options)
              releases.push(release)
              return release
            },
          },
        }

  try {
    return register(ledger)
  } catch (error) {
    for (const release of releases.splice(0)) {
      try {
        release()
      } catch {
        // The original failure is the one worth reporting; a second throw from a
        // partial release must not replace it.
      }
    }
    throw error
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface ScopeHostDeps {
  scope: ToolScopeState
  names: readonly string[]
  /**
   * The aggregate registration entry: ONE call registers the family and ONE
   * disposer releases it (the `registerCherryTools` shape). A "returns many
   * disposers" variant is deliberately not supported.
   *
   * PRODUCER CONTRACT: the entry must be atomic — a throw must not leave
   * registrations behind. `registerAtomically` is the one implementation of
   * that, and the assembly wires it.
   */
  registerTools: (visibleFor?: (agent: unknown) => boolean) => () => void
  /** The existing warn carrier; absent ⇒ `console.warn`. */
  log?: (message: string, error?: unknown) => void
}

export interface ToolScopeHost {
  /** Instantiates nothing on its own: this is the assembly point. */
  mount(ctx: ScopeHostContext): () => void
  /** Recomputes the derived view for the next step; inert while `pending` / torn down. */
  recompute(): void
  state(): ScopeHostState
}

/** One effect run's state: the two services it was injected with, its registration, its flag. */
interface EffectState {
  tornDown: boolean
  agents: { list(): unknown } | undefined
  registry: WorkspaceRegistryLike | undefined
  releaseRegistrations: (() => void) | undefined
  teardown: () => void
}

export function createToolScopeHost(deps: ScopeHostDeps): ToolScopeHost {
  const { scope } = deps
  const names: readonly string[] = deps.names
  const log = deps.log ?? ((message: string, error?: unknown) => console.warn(message, error))

  let staticCapable = false
  /** Increments per `mount()` and per call of its disposer: callbacks from an
   *  older mount (a late injection, a stale disposer) must be inert. */
  let mountGeneration = 0
  /** The effect run currently holding the registration, if any. */
  let current: EffectState | undefined

  // -------------------------------------------------------------------------
  // Capability probe (mount time, plugin ROOT ctx — never the injected ctx)
  // -------------------------------------------------------------------------

  function probe(tools: ScopeHostContext['tools']): { capable: boolean; reason: string } {
    if (tools === undefined) return { capable: false, reason: UNSUPPORTED_REASON('tools') }
    if (typeof tools.register !== 'function') {
      return { capable: false, reason: UNSUPPORTED_REASON('tools.register') }
    }
    // `resolve()` IS the host's declaration that `when` is honoured: older hosts
    // accept the option and silently ignore it (#343). The engine floor is
    // `>=0.2.2-rc.1`, so this is the ONLY supported mode (#345).
    if (typeof tools.resolve !== 'function') {
      return {
        capable: false,
        reason: UNSUPPORTED_REASON('tools.resolve（需要 dsh-tools ≥ 0.2.2-alpha.2 / 插件 engines.dsh ≥ 0.2.2-rc.1）'),
      }
    }
    return { capable: true, reason: WHEN_READY_REASON }
  }

  function UNSUPPORTED_REASON(missing: string): string {
    return `宿主缺 ${missing}，无法做到“注册即可隐藏” ⇒ scope 子系统不注册任何工具（fail-closed），这 ${names.length} 个受治理的名字装不上步骤级条件；实验性委托工具由子智能体子系统注册，其可见性由它自己的步骤级闸门决定`
  }

  // -------------------------------------------------------------------------
  // Agent projection
  // -------------------------------------------------------------------------

  function projectAgent(raw: unknown): ScopeAgentLike | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const value = raw as {
      id?: unknown
      session?: { header?: { cwd?: unknown } }
    }
    const id = value.id
    if (typeof id !== 'string' || id === '') return undefined

    // `Agent` itself has no `cwd`: the session header is where creation metadata
    // lives, and a minimal (store-less) header simply has none (D7/D14).
    const cwdValue = value.session?.header?.cwd
    const cwd = typeof cwdValue === 'string' && cwdValue !== '' ? cwdValue : undefined
    return { id, ...(cwd === undefined ? {} : { cwd }) }
  }

  function liveAgents(state: EffectState): ScopeAgentLike[] {
    const service = state.agents
    const list = service?.list
    if (typeof list !== 'function') return []
    let raw: unknown
    try {
      raw = list.call(service)
    } catch (error) {
      log('[cherry-remote] agents.list() 抛出；本轮按“没有 live agent”处理', error)
      return []
    }
    if (!Array.isArray(raw)) return []
    return raw.map((entry) => projectAgent(entry)).filter((agent): agent is ScopeAgentLike => agent !== undefined)
  }

  // -------------------------------------------------------------------------
  // The step-time path: ONE registration carrying one shared `when`
  // -------------------------------------------------------------------------

  /**
   * There is no layer to install, no agent lifecycle to follow and no recheck
   * timer: the host evaluates the condition at every step, so a config save or a
   * fresh agent is answered by the very next step. The async judgement
   * generation still runs (a `cwd` that only realpath can match), but only to
   * improve the answer — the gate itself reads `judgement ?? resolveNow(agent)`
   * synchronously and fails closed.
   */
  function setupWhen(agentCtx: ScopeInjectedContext, mountId: number): () => void {
    // A late arrival on an unsupported host must not promote it: the static
    // failure was decided at mount time and wins (B7①). A callback from an
    // older mount must not take `current` either.
    if (!staticCapable || mountId !== mountGeneration) return () => {}
    // Re-entry for the SAME mount is inert: the live registration set belongs to
    // the FIRST effect run, and handing its teardown to a later run would let a
    // dependency re-injection unload the family with nothing to re-register it.
    if (current !== undefined && !current.tornDown) return () => {}
    scope.setHost({ state: 'ready', capable: true, reason: WHEN_READY_REASON })
    const state: EffectState = {
      tornDown: false,
      agents: agentCtx.agents,
      registry: agentCtx.workspaceRegistry,
      releaseRegistrations: undefined,
      teardown: () => {},
    }
    state.teardown = () => teardownEffect(state)

    let release: (() => void) | undefined
    try {
      release = deps.registerTools((raw) => {
        const agent = projectAgent(raw)
        if (agent === undefined) return false
        try {
          return scope.visibleForAgent(agent)
        } catch (error) {
          // A throwing condition fails step PREPARATION (`TOOL_ACTIVATION_FAILED`),
          // so one bad judgement must never take a turn down (#343).
          log('[cherry-remote] 步骤级作用域判定抛错；本步按不可见处理', error)
          return false
        }
      })
    } catch (error) {
      state.tornDown = true
      scope.setHost({
        state: 'unsupported',
        capable: false,
        reason: `cherry_* 工具注册失败：${describeError(error)}`,
      })
      log('[cherry-remote] cherry_* 工具注册失败；作用域子系统未启用', error)
      return state.teardown
    }
    state.releaseRegistrations = release
    current = state
    // The first judgement generation: improves the synchronous answer for a
    // symlinked cwd, and populates `pathUnmatched` for the HTTP face.
    rebuildJudgements(state)
    return state.teardown
  }

  /** One async judgement generation, never awaited by a step (#343). */
  function rebuildJudgements(state: EffectState): void {
    const registry = state.registry
    if (registry === undefined) return
    void scope.rebuild(registry, liveAgents(state)).catch((error: unknown) => {
      log('[cherry-remote] 作用域判定重建失败（保留上一代判定）', error)
    })
  }

  function recompute(): void {
    const state = current
    if (state === undefined || state.tornDown || !staticCapable) return
    // Nothing to install: the next step's condition reads the saved document.
    // The async generation only refines realpath judgements and the report.
    rebuildJudgements(state)
  }

  function teardownEffect(state: EffectState): void {
    if (state.tornDown) return
    state.tornDown = true
    const releaseRegistrations = state.releaseRegistrations
    state.releaseRegistrations = undefined
    try {
      releaseRegistrations?.()
    } catch (error) {
      log('[cherry-remote] 释放 cherry_* 工具注册失败', error)
    }
    // The judgement generation belongs to the mount that built it: after a
    // release, `visibleForAgent` must not answer from the previous mount's
    // workspace list (the fail-closed direction). A STALE disposer must not
    // wipe the generation a newer mount is already serving.
    if (current === state) {
      current = undefined
      scope.invalidateDerived()
      // A released mount must not keep reporting the old `ready`: the next
      // reader sees the neutral, registration-free state.
      scope.setHost({ state: 'pending', capable: false, reason: RELEASED_REASON })
    }
  }

  return {
    mount(ctx: ScopeHostContext): () => void {
      const mountId = ++mountGeneration
      // A second mount replaces the first: its registrations and callbacks
      // belong to the old token and are released before the new probe.
      current?.teardown()
      const probed = probe(ctx.tools)
      staticCapable = probed.capable
      if (!staticCapable) {
        // The static failure is decided HERE, before/independently of the
        // injection arrival — which is why "missing capability" and "injection
        // not yet arrived" can hold at once and the first one wins.
        scope.setHost({ state: 'unsupported', capable: false, reason: probed.reason })
        log(`[cherry-remote] 作用域子系统未启用：${probed.reason}`)
      } else {
        scope.setHost({ state: 'pending', capable: false, reason: PENDING_REASON })
      }

      try {
        ctx.inject?.(INJECT_KEYS, (agentCtx: ScopeInjectedContext) => {
          if (mountId !== mountGeneration) return
          // The fibre handle is ignored on purpose; `mount()`'s disposer is the
          // only release path this subsystem owns.
          agentCtx.effect?.(() => {
            if (mountId !== mountGeneration) return () => {}
            return setupWhen(agentCtx, mountId)
          }, EFFECT_LABEL)
        })
      } catch (error) {
        // 宿主服务未就绪: `mount()` must stay alive (the HTTP half still has to
        // serve) and the tri-state honestly stays `pending`.
        log('[cherry-remote] agents / workspaceRegistry 注入不可用；作用域子系统保持 pending', error)
        scope.setHost({ state: 'pending', capable: false, reason: PENDING_REASON })
      }

      return () => {
        // Identity first: a disposer from an older mount must not tear down the
        // live one, and bumping the token makes any late callback inert.
        if (mountId !== mountGeneration) return
        mountGeneration += 1
        current?.teardown()
      }
    },

    recompute,

    state(): ScopeHostState {
      return scope.host()
    },
  }
}
