/**
 * The host integration layer: capability tri-state, the injection gate, and the
 * ONE assembly point where registration, hiding and the dispatch guard are born
 * and die together (spec §6.2 + B7/B10/B17).
 *
 * Four decisions carry this file:
 *
 *  1. **The host is mounted, not merely constructed.** {@link ToolScopeHost.mount}
 *     is the only entry point that installs anything, and it returns the only
 *     release path. `apply()` calls it AFTER the assembly's root `ctx.effect`
 *     and pushes the returned disposer into `state.disposers`, so the plugin's
 *     existing teardown drains it — there is deliberately no second root effect.
 *
 *  2. **The capability probe runs at `mount()` time, off the plugin ROOT ctx's
 *     `tools` face** — never inside the injected effect. `register`, `restrict`
 *     and `schemas` are hard gates (missing any one ⇒ `unsupported`); `guard` is
 *     NOT a gate (missing ⇒ the `visibility-only` degradation). Because the probe
 *     does not depend on the injection arrival, "static capability missing" and
 *     "injection not yet arrived" can hold at once — and the static failure wins.
 *
 *  3. **The injected effect owns the lifecycle of all four faces**: the tool
 *     registrations, every agent's restriction layer, the single global guard,
 *     and the two subscriptions. Its merged disposer unsubscribes FIRST (the
 *     release side of `register`/`restrict` also emits `tools/change`, and a
 *     recompute running in that window would re-install a layer whose disposer
 *     the map no longer holds — an ownerless layer, unrecoverable under
 *     intersection semantics), then releases registrations, then restrictions,
 *     and finally the guard (which notifies nobody).
 *
 *  4. **State ownership stays with {@link ToolScopeState}.** This module keeps
 *     no copy of the document, the degradation set, the judgement generation or
 *     the installed-layer records; it reads and writes them through the scope
 *     state's own surface (`judgement` / `layer` / `setLayer` / `clearLayer` /
 *     `invalidateDerived`), which is what makes `guard`'s "层在 ⇒ 拒绝" mirror
 *     true by construction.
 *
 * Deliberately NOT here (later tasks in the same file): the empty-deny /
 * install-failure criteria and the `tools/change` subscription with its
 * coalescing gate (Task 5), and the bounded recheck (Task 6).
 */
import { isVisible } from './toolScope.js'
import type { ScopeHostState, ToolScopeState, WorkspaceRegistryLike } from './toolScope.js'

/**
 * The label of this subsystem's mount lifecycle — §6.2 spells it, and this is
 * the ONLY place the string is written. The assembly point references the
 * constant through `mount()`; no caller re-spells it.
 */
const EFFECT_LABEL = 'cherry-remote.tool-scope()'

/** The neutral waiting wording: `pending` must never read as "the host refuses". */
const PENDING_REASON = '等待宿主注入 agents / workspaceRegistry'

/** `ready` means: the three static capabilities AND both injected services. */
const READY_REASON = '宿主能力齐备（tools.register / tools.restrict / tools.schemas）且 agents / workspaceRegistry 注入已到达'

/** The two dependency keys this subsystem gates on. They enter ONE `inject` call. */
const INJECT_KEYS: readonly string[] = ['agents', 'workspaceRegistry']

/**
 * The plugin root ctx, as this subsystem consumes it.
 *
 * Every member is optional — INCLUDING `tools` as a whole and each of its four
 * methods — because `apply()` holds a `CherryBridgeContext` whose `tools` face is
 * optional and whose real shape only carries `register`. `mount(ctx)` therefore
 * accepts it as a structural superset with NO cast or conversion at the call
 * site; a required member here would push a cast back into `src/index.ts` and
 * the type would have drifted away from the host it describes.
 */
export interface ScopeHostContext {
  tools?: {
    register(definition: {
      readonly name: string
      readonly description: string
      readonly parameters?: unknown
      execute(args: unknown, exec: unknown): Promise<unknown>
    }): () => void
    restrict?(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): () => void
    guard?(
      guard: (execution: { readonly name: string; readonly agent?: { readonly id: string } }) => string | undefined,
    ): () => void
    schemas?(scope?: unknown): ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly parameters?: unknown
    }>
  }
  /**
   * Dynamic injection — the host's fibre handle as the RETURN value, which this
   * plugin ignores: the fibre is the unit of unload/re-mount, and the only
   * release path this subsystem owns is the disposer `mount()` returns.
   */
  inject?<T>(keys: readonly string[], cb: (ctx: T) => void | (() => void)): unknown
  on?<T>(event: string, cb: (payload: T) => void): () => void
  effect?(cb: () => () => void, label?: string): unknown
}

/**
 * The ctx the injection callback receives: the two services plus THIS
 * subsystem's lifecycle (`effect`) and event surface (`on`).
 *
 * It is never a scoped agent ctx: restrictions go on `agent.ctx` only, and
 * calling `restrict()` here throws on a real host.
 */
export interface ScopeInjectedContext {
  /** `list()` yields the live agents (projected through {@link projectAgent}). */
  agents?: { list(): unknown }
  workspaceRegistry?: WorkspaceRegistryLike
  effect?(cb: () => () => void, label?: string): unknown
  on?<T>(event: string, cb: (payload: T) => void): () => void
}

/**
 * The registration face {@link registerAtomically} needs: a structural subset of
 * {@link ScopeHostContext.tools}, so both the assembly's own ctx and a fixture's
 * fake host satisfy it without a cast.
 */
export interface ScopeRegistrationContext {
  tools?: {
    register(definition: {
      readonly name: string
      readonly description: string
      readonly parameters?: unknown
    }): () => void
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
 * owns every registration.
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
            register: (definition) => {
              // `tools.register(…)` keeps its receiver, so a host method that
              // relies on `this` behaves exactly as it does without the ledger.
              const release = tools.register(definition)
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
        // A partial release must never mask the registration failure itself.
      }
    }
    throw error
  }
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
  registerTools: () => () => void
  /** Consumed by Task 6's bounded recheck; declared here as part of the contract. */
  recheckDelaysMs?: readonly number[]
  /** The existing warn carrier; absent ⇒ `console.warn`. */
  log?: (message: string, error?: unknown) => void
}

/** What one recompute round did, for the HTTP face's echo (spec §6.2/§6.3). */
export interface RefreshSummary {
  agents: number
  installed: number
  released: number
  skipped: number
}

export interface ToolScopeHost {
  /** Instantiates nothing on its own: this is the assembly point. */
  mount(ctx: ScopeHostContext): () => void
  /** One recompute round; `undefined` while `pending` / `unsupported` / torn down. */
  refresh(): RefreshSummary | undefined
  state(): ScopeHostState
}

/** One live agent, as this layer needs it. */
interface HostAgent {
  id: string
  cwd?: string
  /** `agent.ctx.tools.restrict` — present only on a scoped agent ctx. */
  restrict?: (filter: { readonly deny: readonly string[] }) => () => void
}

/** One effect run's state: the four faces it owns, and its own torn-down flag. */
interface EffectState {
  tornDown: boolean
  layers: Map<string, () => void>
  agents: { list(): unknown } | undefined
  registry: WorkspaceRegistryLike | undefined
  releaseRegistrations: (() => void) | undefined
  releaseGuard: (() => void) | undefined
  offs: Array<() => void>
  teardown: () => void
}

export function createToolScopeHost(deps: ScopeHostDeps): ToolScopeHost {
  const { scope } = deps
  const names: readonly string[] = deps.names
  const log = deps.log ?? ((message: string, error?: unknown) => console.warn(message, error))

  let root: ScopeHostContext | undefined
  let staticCapable = false
  let mountTornDown = false
  /** The effect run currently holding the four faces, if any. */
  let current: EffectState | undefined

  // -------------------------------------------------------------------------
  // Capability probe (mount time, plugin ROOT ctx — never the injected ctx)
  // -------------------------------------------------------------------------

  function probe(tools: ScopeHostContext['tools']): { capable: boolean; reason: string } {
    const missing: string[] = []
    if (tools === undefined) {
      missing.push('tools')
    } else {
      // `guard` is deliberately NOT in this list: its absence is the
      // visibility-only degradation (B17), not a registration gate (B7/D13).
      if (typeof tools.register !== 'function') missing.push('tools.register')
      if (typeof tools.restrict !== 'function') missing.push('tools.restrict')
      if (typeof tools.schemas !== 'function') missing.push('tools.schemas')
    }
    if (missing.length === 0) return { capable: true, reason: READY_REASON }
    return {
      capable: false,
      // B7③: the reason names the REAL gap — never a hardcoded "agents
      // service unavailable", and never a `pending` phrased as "unsupported".
      reason: `宿主缺 ${missing.join(' / ')}，无法做到“注册即可隐藏” ⇒ 这 ${names.length} 个工具一个都不注册（fail-closed）`,
    }
  }

  // -------------------------------------------------------------------------
  // Agent projection (the SAME projection for `list()` and for event payloads)
  // -------------------------------------------------------------------------

  function projectAgent(raw: unknown): HostAgent | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const value = raw as {
      id?: unknown
      session?: { header?: { cwd?: unknown } }
      ctx?: { tools?: { restrict?: unknown } }
    }
    const id = value.id
    if (typeof id !== 'string' || id === '') return undefined

    // `Agent` itself has no `cwd`: the session header is where creation metadata
    // lives, and a minimal (store-less) header simply has none (D7/D14).
    const cwdValue = value.session?.header?.cwd
    const cwd = typeof cwdValue === 'string' && cwdValue !== '' ? cwdValue : undefined

    const scopedTools = value.ctx?.tools
    const restrict = scopedTools?.restrict
    return {
      id,
      ...(cwd === undefined ? {} : { cwd }),
      ...(typeof restrict !== 'function'
        ? {}
        : {
            // `call(scopedTools, …)` so a class method keeps its `this`.
            restrict: (filter: { readonly deny: readonly string[] }) =>
              (restrict as (f: unknown) => () => void).call(scopedTools, filter),
          }),
    }
  }

  function liveAgents(state: EffectState): HostAgent[] {
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
    return raw.map((entry) => projectAgent(entry)).filter((agent): agent is HostAgent => agent !== undefined)
  }

  // -------------------------------------------------------------------------
  // The install / release decision
  // -------------------------------------------------------------------------

  /**
   * The pinned target set: visible under the CURRENT document and judgement ⇒
   * empty (release only), otherwise the family's names.
   *
   * `judgement()?.workspaceId` folds a cache miss into the same expression: under
   * `global` `isVisible(doc, undefined)` is true (so a miss releases only), and
   * under `selected` it is false — the D7 fail-closed side.
   */
  function targetDeny(agentId: string): readonly string[] {
    return isVisible(scope.doc(), scope.judgement(agentId)?.workspaceId) ? [] : names
  }

  function reasonFor(agentId: string): string {
    return (
      scope.judgement(agentId)?.reason ??
      '判定缓存未命中（按 D7 fail-closed 隐藏；重算完成后按新判定补齐）'
    )
  }

  function applyForAgent(state: EffectState, agent: HostAgent): 'installed' | 'released' | 'skipped' {
    const target = targetDeny(agent.id)
    const existing = state.layers.get(agent.id)

    if (target.length === 0) {
      if (existing === undefined) return 'skipped'
      // Release-only (B18①). Record first, disposer second: within this
      // synchronous block the guard must never read a record whose layer is gone.
      scope.clearLayer(agent.id)
      state.layers.delete(agent.id)
      existing()
      return 'released'
    }

    if (agent.restrict === undefined) {
      log(`[cherry-remote] agent ${agent.id} 没有 agent.ctx.tools.restrict，无法安装 restriction；跳过该 agent`)
      return 'skipped'
    }

    let dispose: () => void
    try {
      // 先装新（返回即表示层已装入）…
      dispose = agent.restrict({ deny: [...target] })
    } catch (error) {
      log(`[cherry-remote] agent ${agent.id} 的 restriction 安装被宿主拒绝；本轮跳过该 agent`, error)
      return 'skipped'
    }
    // …and the record is written in the SAME synchronous block, then the old
    // layer is released: no observable point ever shows a record pointing at a
    // released layer, nor two live layers under one agent.
    state.layers.set(agent.id, dispose)
    scope.setLayer(agent.id, { deny: [...target], reason: reasonFor(agent.id) })
    existing?.()
    return 'installed'
  }

  function applyAll(state: EffectState): RefreshSummary {
    const summary: RefreshSummary = { agents: 0, installed: 0, released: 0, skipped: 0 }
    const agents = liveAgents(state)
    summary.agents = agents.length
    for (const agent of agents) {
      const outcome = applyForAgent(state, agent)
      if (outcome === 'installed') summary.installed += 1
      else if (outcome === 'released') summary.released += 1
      else summary.skipped += 1
    }
    return summary
  }

  /**
   * The asynchronous half of one round: one judgement generation, then the same
   * (synchronous) install/release pass on top of it. Never rejects — a failed
   * round is recorded, never thrown into a `@mode serial` event dispatch.
   */
  async function converge(state: EffectState): Promise<void> {
    try {
      if (state.tornDown || mountTornDown) return
      const registry = state.registry
      if (registry === undefined) return
      const agents = liveAgents(state).map((agent) => ({
        id: agent.id,
        ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
      }))
      await scope.rebuild(registry, agents)
      if (state.tornDown || mountTornDown) return
      applyAll(state)
    } catch (error) {
      log('[cherry-remote] 作用域重算失败（只记录，不抛；判定保持上一代）', error)
    }
  }

  // -------------------------------------------------------------------------
  // The guard: the execution-side MIRROR of the installed-layer records
  // -------------------------------------------------------------------------

  function guardVerdict(execution: {
    readonly name: string
    readonly agent?: { readonly id: string }
  }): string | undefined {
    // Scoped to OUR names: the guard runs on EVERY dispatch, so a name outside
    // the family must pass through untouched (B6/§4).
    if (!names.includes(execution.name)) return undefined
    const agentId = execution.agent?.id
    if (agentId === undefined) return undefined
    // Reads the installed-layer RECORD and nothing else — no recompute, no
    // second criterion for a cache miss: layer present ⇒ deny (B6/G4).
    const layer = scope.layer(agentId)
    return layer === undefined ? undefined : `cherry-remote 作用域限制：${layer.reason}`
  }

  // -------------------------------------------------------------------------
  // The injected effect: the one place the four faces are born and die
  // -------------------------------------------------------------------------

  function refresh(): RefreshSummary | undefined {
    const state = current
    if (state === undefined || state.tornDown || mountTornDown || !staticCapable) return undefined
    // The synchronous window: install/release decisions read the CACHE only, so
    // `save → refresh` is await-free (the convergence rides behind it).
    const summary = applyAll(state)
    void converge(state)
    return summary
  }

  function teardownEffect(state: EffectState): void {
    if (state.tornDown) return
    state.tornDown = true

    // ① Unsubscribe FIRST: releasing a registration or a restriction also emits
    //    `tools/change`, and a recompute running inside that window would
    //    re-install a layer this teardown is about to drop (ownerless layer).
    for (const off of state.offs.splice(0)) {
      try {
        off()
      } catch (error) {
        log('[cherry-remote] 作用域子系统退订失败', error)
      }
    }
    // ② Then the registrations.
    const releaseRegistrations = state.releaseRegistrations
    state.releaseRegistrations = undefined
    try {
      releaseRegistrations?.()
    } catch (error) {
      log('[cherry-remote] 释放 cherry_* 工具注册失败', error)
    }
    // ③ Then every restriction (record cleared before its layer's disposer).
    for (const [agentId, dispose] of [...state.layers]) {
      scope.clearLayer(agentId)
      try {
        dispose()
      } catch (error) {
        log(`[cherry-remote] 释放 agent ${agentId} 的 restriction 失败`, error)
      }
    }
    state.layers.clear()
    // ④ The guard LAST: it notifies nobody, so it triggers no recompute, and it
    //    is the last execution-side backstop while the release is in flight.
    const releaseGuard = state.releaseGuard
    state.releaseGuard = undefined
    try {
      releaseGuard?.()
    } catch (error) {
      log('[cherry-remote] 释放 tools.guard 失败', error)
    }

    // The same teardown invalidates §6.1's derived generation: judgements, the
    // canonical path map, the resolution states, `pathUnmatched` and the
    // installed-layer records — a re-mount starts from a FRESH generation.
    scope.invalidateDerived()
    if (current === state) current = undefined
    if (scope.host().state === 'ready') {
      // Nothing is mounted any more: `ready` would be a lie (D13's enum has no
      // "unloaded" member, and `pending` is the neutral waiting side of it).
      scope.setHost({ state: 'pending', capable: false, reason: `${PENDING_REASON}（注入回调已卸载）` })
    }
  }

  function setup(agentCtx: ScopeInjectedContext): () => void {
    // A late arrival after the assembly released the host must install nothing.
    if (mountTornDown) return () => {}
    if (!staticCapable) {
      // `mount()` already recorded `unsupported` and warned once; a late
      // injection must not be able to promote it.
      return () => {}
    }

    scope.setHost({ state: 'ready', capable: true, reason: READY_REASON })

    const state: EffectState = {
      tornDown: false,
      layers: new Map(),
      agents: agentCtx.agents,
      registry: agentCtx.workspaceRegistry,
      releaseRegistrations: undefined,
      releaseGuard: undefined,
      offs: [],
      teardown: () => {},
    }
    state.teardown = () => teardownEffect(state)

    // ① Register first (B18③: registration precedes the first installation).
    //
    // The failure is contained HERE, never left to `mount()`'s `inject` try: the
    // real host may deliver the injection callback asynchronously, once the
    // services arrive, with `mount()` long off the stack. `registerAtomically`
    // guarantees the entry itself is atomic (no partial registration survives);
    // what is left for this layer is to make sure that a state which never
    // became `ready` is never LIVE either — see the invariant below.
    let releaseRegistrations: (() => void) | undefined
    try {
      releaseRegistrations = deps.registerTools()
    } catch (error) {
      state.tornDown = true
      scope.setHost({
        state: 'unsupported',
        capable: false,
        // B7③: the real cause, never a hardcoded one. `unsupported` (rather than
        // `pending`) because the injection DID arrive — the host refused our
        // registrations, so "waiting" would be the dishonest arm.
        reason: `cherry_* 工具注册失败：${error instanceof Error ? error.message : String(error)}`,
      })
      log('[cherry-remote] cherry_* 工具注册失败；作用域子系统未启用，未安装任何 restriction', error)
      // The effect's own disposer is returned anyway, so the host can still
      // dispose the effect; it is a no-op because nothing was installed.
      return state.teardown
    }
    state.releaseRegistrations = releaseRegistrations

    // INVARIANT (no half-built generation is ever observable): `current` becomes
    // the live generation only HERE, once registration has SUCCEEDED. A failed
    // setup leaves `current` untouched, so `refresh()` (wired to the `/scope`
    // route by Task 7) is structurally inert — it cannot install a restriction
    // layer for a state that never became ready, and it cannot report a round.
    current = state

    // ② Then the guard — ONE layer on the plugin ROOT ctx, or the visibility-only
    //    degradation (never a reason to refuse registration, B17).
    const rootTools = root?.tools
    if (typeof rootTools?.guard === 'function') {
      state.releaseGuard = rootTools.guard((execution) => guardVerdict(execution))
    } else {
      scope.noteDegraded({
        source: 'visibility-only',
        reason:
          '宿主缺 tools.guard：执行层兜底不可用，降级为“仅可见性”（restrict 仍在装配层移除这 14 个工具，不是渲染层假过滤）',
      })
    }

    // ③ The subscriptions (this task: agent lifecycle only — `tools/change`
    //    belongs with Task 5's install/release criteria).
    const on = agentCtx.on
    if (typeof on === 'function') {
      state.offs.push(
        on<{ agent?: unknown }>('agent/created', (payload) => {
          onCreated(state, payload)
        }),
      )
      state.offs.push(
        on<{ agent?: unknown }>('agent/disposed', (payload) => {
          onDisposed(state, payload)
        }),
      )
    }

    // ④ The first round: the synchronous, fail-closed pass now, the judgement
    //    generation right behind it.
    refresh()
    return state.teardown
  }

  /** `agent/created`: synchronous, cache-only, never throws (host `@mode serial`). */
  function onCreated(state: EffectState, payload: { agent?: unknown } | undefined): void {
    if (state.tornDown || mountTornDown) return
    const agent = projectAgent(payload?.agent)
    if (agent === undefined) return
    try {
      // Only the CACHE is read here: awaiting `resolveByPath` would block the
      // session's creation, so a cache miss is the D7 fail-closed side.
      applyForAgent(state, agent)
    } catch (error) {
      log(`[cherry-remote] agent ${agent.id} 的首次装配失败（不阻塞建会话）`, error)
    }
    void converge(state)
  }

  /** `agent/disposed`: releases exactly that agent's layer and its record. */
  function onDisposed(state: EffectState, payload: { agent?: unknown } | undefined): void {
    if (state.tornDown || mountTornDown) return
    const agent = projectAgent(payload?.agent)
    if (agent === undefined) return
    try {
      const dispose = state.layers.get(agent.id)
      scope.clearLayer(agent.id)
      state.layers.delete(agent.id)
      dispose?.()
    } catch (error) {
      log(`[cherry-remote] 释放 agent ${agent.id} 的 restriction 失败（不阻塞处置）`, error)
    }
  }

  return {
    mount(ctx: ScopeHostContext): () => void {
      root = ctx
      mountTornDown = false

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
          // The fibre handle is ignored on purpose; `mount()`'s disposer is the
          // only release path this subsystem owns.
          agentCtx.effect?.(() => setup(agentCtx), EFFECT_LABEL)
        })
      } catch (error) {
        // 宿主服务未就绪: `mount()` must stay alive (the HTTP half still has to
        // serve, D9) and the tri-state honestly stays `pending`.
        log('[cherry-remote] agents / workspaceRegistry 注入不可用；作用域子系统保持 pending', error)
        scope.setHost({ state: 'pending', capable: false, reason: PENDING_REASON })
      }

      return () => {
        mountTornDown = true
        const teardown = current?.teardown
        teardown?.()
      }
    },

    refresh,

    state(): ScopeHostState {
      return scope.host()
    },
  }
}
