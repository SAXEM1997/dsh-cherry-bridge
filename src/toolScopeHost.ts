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
 *  5. **Every trigger of a recompute round goes through ONE coalescing gate**
 *     ({@link requestRound}, §4 ①'s 合并 / 置脏后补跑). The host emits
 *     `tools/change` on BOTH sides of `register`/`restrict`, so this module's own
 *     install and release work re-enters its own listener; the gate is what makes
 *     that terminating — an in-flight round is never overlapped, the trigger only
 *     marks it dirty, and the round runs one catch-up pass before it ends. The
 *     ONLY abstention point is teardown (§4), which every entry checks.
 *
 * Deliberately NOT here (Task 6): the bounded recheck. The install/release
 * criteria and the three subscriptions ARE here — every "completion" and
 * "retry" they describe is reachable through `refresh()` (the config-save path)
 * and through `tools/change`.
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
 * D14's bounded recheck schedule: two attempts, then the state is left as it is.
 *
 * A `cwd` whose resolution did not CONCLUDE may well resolve a moment later —
 * the registry was not ready, the directory was momentarily unreachable, or the
 * `sessionIds` projection had not caught up. Anything past two attempts is an
 * idle spin, which D14 forbids outright.
 */
const DEFAULT_RECHECK_DELAYS_MS: readonly number[] = [250, 2000]

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

/**
 * The readable cause of a caught throw, for a message or a `degraded` note. A
 * host that rejects with a plain value is reported verbatim rather than as
 * `[object Object]`.
 */
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
  registerTools: () => () => void
  /** Consumed by the bounded recheck: one timer per entry, per `unresolved` agent. */
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

/** One effect run's state: the four faces it owns, its own torn-down flag, and §4's gate. */
interface EffectState {
  tornDown: boolean
  /**
   * §4 ①'s coalescing gate: a round is in flight. A trigger arriving while this
   * is set must not start a second one — it sets {@link dirty} instead.
   */
  running: boolean
  /** A trigger arrived inside the current round: one catch-up pass is owed. */
  dirty: boolean
  layers: Map<string, () => void>
  /**
   * D14's bounded recheck, per agent: the next {@link recheckDelaysMs} index owed
   * to that agent, and its pending timer. At most ONE timer is live per agent and
   * at most one entry of the schedule is consumed per firing — the pairing is
   * what makes "exactly two timers, then silence" true rather than hoped for.
   */
  recheckSteps: Map<string, number>
  recheckTimers: Map<string, ReturnType<typeof setTimeout>>
  agents: { list(): unknown } | undefined
  registry: WorkspaceRegistryLike | undefined
  releaseRegistrations: (() => void) | undefined
  releaseGuard: (() => void) | undefined
  offs: Array<() => void>
  teardown: () => void
}

/** The injected ctx's `on`, as this module consumes it (R16 wraps each call). */
type OnFace = <T>(event: string, handler: (payload: T) => void) => () => void

export function createToolScopeHost(deps: ScopeHostDeps): ToolScopeHost {
  const { scope } = deps
  const names: readonly string[] = deps.names
  const log = deps.log ?? ((message: string, error?: unknown) => console.warn(message, error))
  const recheckDelaysMs: readonly number[] = deps.recheckDelaysMs ?? DEFAULT_RECHECK_DELAYS_MS

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
   * The ONE reporting site of an unreadable global view.
   *
   * The carrier is §6.1's EXISTING `install` source — an installation that could
   * not be completed is exactly that degradation, and the five-value enum has no
   * member for "unreadable view" (no sixth is added) — together with the warn
   * channel. Reported, never silent.
   */
  function noteUnobserved(cause: string, error?: unknown): void {
    scope.noteDegraded({
      source: 'install',
      reason:
        `无参 schemas() 不可读：${cause}（本轮既不安装也不释放任何层——既有层保持不动，` +
        '绝不因为读不到就放开隐藏；下一次重算 / 配置保存会重试）',
    })
    log('[cherry-remote] 无参 schemas() 不可读；本轮不做任何装层 / 释放动作（fail-closed）', error)
  }

  /**
   * The no-argument GLOBAL view of the tool registry — D12/B12①'s only
   * sanctioned observation source for a deny set.
   *
   * `schemas(agent)` is deliberately never used: that view is already filtered by
   * the agent's own layers, so deriving `deny` from it would re-admit the very
   * names this plugin hides.
   *
   * `undefined` means the view could NOT be read, and it is deliberately NOT the
   * same value as an empty `Set`:
   *
   *  - **observed empty** is B18③'s 观测集合为空 — nothing may be installed, while
   *    an existing layer is still maintained by the ordinary rules;
   *  - **failed to observe** must make NO layer-changing host call at all (see
   *    {@link targetDeny}): routing it through the empty-target branch would
   *    RELEASE the hiding layers of not-visible agents, i.e. fail open on an
   *    unreadable input — the opposite of the module's own `agents.list()`
   *    failure, which leaves layers installed (B7 calls "已注册未隐藏" the worst
   *    state; B9/B16 resolve unreadable inputs to the stricter side).
   *
   * Contained HERE because this runs inside the injected effect body, which a real
   * host may reach asynchronously (R16).
   */
  function observeGlobalNames(): Set<string> | undefined {
    const tools = root?.tools
    if (tools === undefined || typeof tools.schemas !== 'function') {
      noteUnobserved('宿主 tools.schemas 不可用')
      return undefined
    }
    try {
      const view = tools.schemas()
      return new Set(
        (Array.isArray(view) ? view : [])
          .map((definition) => definition?.name)
          .filter((name): name is string => typeof name === 'string'),
      )
    } catch (error) {
      noteUnobserved(describeError(error), error)
      return undefined
    }
  }

  /**
   * The pinned target set — the names this agent must HIDE — with one definition
   * and no second (B18):
   *
   *   visible under the CURRENT document and judgement ⇒ the EMPTY set
   *   not visible ⇒ CHERRY_TOOL_NAMES ∩ the no-argument `schemas()`
   *   not visible, view unreadable ⇒ `undefined` (no target could be computed)
   *
   * `judgement()` is the per-agent cache; a MISS falls back to
   * `scope.resolveNow(agent)` — the same §4 rules answered from the CURRENT
   * generation WITHOUT awaiting anything. `rebuild()` is fed by the currently
   * live agents alone, so a brand-new agent id can never be pre-judged; without
   * that fallback the first install would deny all 14 names and the tools would
   * appear only once the asynchronous round converged — B13's 「第一轮就有工具」
   * is exactly the other direction. Only when there is NO usable generation
   * either (a read never taken, failed, or empty) does the expression collapse
   * to `isVisible(doc, undefined)`: under `global` that is true (a miss releases
   * only), while under `selected` it is false — the D7 fail-closed side.
   * Visibility is derived from `isVisible`, never from `status === 'resolved'`,
   * and the `visible` arm needs no observation at all.
   *
   * An EMPTY set means RELEASE ONLY. `{ deny: [] }` is never submitted: the host
   * accepts it as a no-op layer admitting every name, which this plugin's guard
   * (layer present ⇒ reject) would misread as "already hidden" — tools visible
   * but rejected (B18③).
   *
   * `undefined` is NOT the empty set: the observation failed, so no target exists
   * and the caller must leave every installed layer exactly where it is.
   */
  function targetDeny(agent: HostAgent): readonly string[] | undefined {
    const resolved = scope.judgement(agent.id) ?? scope.resolveNow(agent)
    if (isVisible(scope.doc(), resolved?.workspaceId)) return []
    const observed = observeGlobalNames()
    return observed === undefined ? undefined : names.filter((name) => observed.has(name))
  }

  function reasonFor(agent: HostAgent): string {
    const cached = scope.judgement(agent.id)
    if (cached !== undefined) return cached.reason
    // The same synchronous fallback, for the arm that matters: a layer installed
    // on a cache miss while the CURRENT generation already NAMES the agent's
    // workspace must stop reporting a miss. A resolution that names NO workspace
    // (`no-cwd` / `no-match`) keeps the miss wording: that text describes the
    // cache rather than the conclusion, and the round that lands the judgement
    // rewrites this record in place (T5b ⑬ pins both halves of that).
    const sync = scope.resolveNow(agent)
    if (sync?.workspaceId !== undefined) return sync.reason
    return '判定缓存未命中（按 D7 fail-closed 隐藏；重算完成后按新判定补齐）'
  }

  /** §4 ②'s 同名短路: two deny sets holding exactly the same names. */
  function sameDenySet(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((name) => b.includes(name))
  }

  /**
   * Calls one layer's disposer. A release the host refuses is unrecoverable, but
   * it must not travel into the caller either (B12②'s "不抛到调用方" is the same
   * rule on both sides of the pair) — it is reported and the round continues.
   */
  function disposeQuietly(agentId: string, dispose: () => void): void {
    try {
      dispose()
    } catch (error) {
      log(`[cherry-remote] 释放 agent ${agentId} 的 restriction 失败`, error)
    }
  }

  function applyForAgent(state: EffectState, agent: HostAgent): 'installed' | 'released' | 'skipped' {
    const target = targetDeny(agent)
    const existing = state.layers.get(agent.id)

    // The observation FAILED (only reachable for a not-visible agent): there is no
    // target to act on, so this round makes NO layer-changing host call at all —
    // an unreadable input never releases a hiding layer and never installs a
    // guessed one (fail-closed; the failure itself is reported by
    // `noteUnobserved`). This is deliberately NOT the empty-target branch below.
    if (target === undefined) return 'skipped'

    if (target.length === 0) {
      if (existing === undefined) return 'skipped'
      // Release-only (B18①). Record first, disposer second: within this
      // synchronous block the guard must never read a record whose layer is gone.
      scope.clearLayer(agent.id)
      state.layers.delete(agent.id)
      disposeQuietly(agent.id, existing)
      return 'released'
    }

    // §4 ②'s idempotent short-circuit: this very deny set is already installed,
    // so no `restrict()` is submitted — reinstalling it would churn the host for
    // no visible difference. The RECORD identifies the installed layer; a disposer
    // without one is not a layer this plugin may claim to have installed.
    const record = scope.layer(agent.id)
    if (existing !== undefined && record !== undefined && sameDenySet(record.deny, target)) {
      // The echoed REASON is not part of the layer, and B6 requires it to name the
      // workspace: a layer installed on a cache miss (the fail-closed first pass)
      // must stop reporting "判定缓存未命中" once the judgement has landed. Only the
      // record's reason is rewritten here — the installed layer, its deny set and
      // the layer ⇔ record pairing are untouched, and no host call is made.
      const reason = reasonFor(agent)
      if (record.reason !== reason) scope.setLayer(agent.id, { deny: record.deny, reason })
      return 'skipped'
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
      // B12②/④: never thrown at the caller, never silent — recorded with the
      // readable cause, so the NEXT round (the config-save path here, the
      // `tools/change` subscription in Task 5's second half) retries. The old
      // layer, if any, stays installed: 先装新后释放旧 means a failed install
      // never opens an un-hidden window (B18②).
      scope.noteDegraded({
        source: 'install',
        reason: `agent ${agent.id} 的 restriction 安装被宿主拒绝：${describeError(error)}（该 agent 本轮未隐藏；下一次重算 / 配置保存会重试）`,
      })
      log(`[cherry-remote] agent ${agent.id} 的 restriction 安装被宿主拒绝；本轮跳过该 agent`, error)
      return 'skipped'
    }
    // …and the record is written in the SAME synchronous block, then the old
    // layer is released: no observable point ever shows a record pointing at a
    // released layer, nor two live layers under one agent. The replaced record is
    // NOT cleared here — it already describes the layer just installed.
    state.layers.set(agent.id, dispose)
    scope.setLayer(agent.id, { deny: [...target], reason: reasonFor(agent) })
    if (existing !== undefined) disposeQuietly(agent.id, existing)
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
    } finally {
      // D14's bounded recheck is armed only AFTER the generation is in place. A
      // FAILED round arms it too: "the resolution could not conclude" is exactly
      // the state a later attempt may find resolved, and the schedule is finite,
      // so that is a retry rather than an idle spin.
      scheduleRechecks(state)
    }
  }

  /**
   * §4 ①'s re-entrancy gate — the ONE entry of a recompute round.
   *
   * The host emits `tools/change` on BOTH sides of `register`/`restrict`, so the
   * plugin's own install and release work necessarily re-enters its own listener.
   * Coalescing is what makes that terminating:
   *
   *  - a round already in flight is never overlapped: the trigger only marks the
   *    round DIRTY, and that round runs one catch-up pass before it ends (§4 ①,
   *    "置脏后补跑，不丢弃") — an event arriving anywhere inside the round,
   *    including its asynchronous interval, is therefore never lost;
   *  - the loop stops at a FIXED POINT: a pass that changes no layer makes no
   *    host call, so it emits nothing and leaves `dirty` false. §4 ③'s bounded
   *    amplification (at most one reinstall per agent per round) rides on the
   *    idempotent short-circuit inside {@link applyForAgent}.
   *
   * This is also §4's ONLY abstention point, and the check is deliberately the
   * same one `refresh` / `onCreated` / `onDisposed` / {@link converge} carry: an
   * event that was already dispatched when the merged disposer ran must reach a
   * dead subsystem — never a recompute, never a layer.
   */
  function requestRound(state: EffectState): void {
    if (state.tornDown || mountTornDown || !staticCapable) return
    if (state.running) {
      state.dirty = true
      return
    }
    state.running = true
    void runRounds(state)
  }

  /** The gate's body: the round itself, then every catch-up it accumulated. */
  async function runRounds(state: EffectState): Promise<void> {
    try {
      do {
        state.dirty = false
        await converge(state)
      } while (state.dirty && !state.tornDown && !mountTornDown)
    } finally {
      // Even a round torn down mid-flight must not leave the gate stuck.
      state.running = false
    }
  }

  /**
   * D14's BOUNDED recheck — the other half of the synchronous judgement, and the
   * only trigger of a round that is not an event.
   *
   * The synchronous window ({@link onCreated}, a config save) reads the CACHE and
   * nothing else, so a judgement that is merely LATE — the registry was not
   * ready, a `realpath` call failed, `sessionIds` had not caught up — leaves the
   * agent fail-closed with no way to notice on its own. Every settled round
   * therefore arms at most ONE timer per agent whose judgement is `unresolved`,
   * at `recheckDelaysMs[attempt]`:
   *
   *  - `no-cwd` and `no-match` are terminally invisible (D14): the `cwd` is
   *    detached, deep-frozen creation metadata and a conclusive "no workspace"
   *    cannot become a hit by waiting, so arming a timer for either is exactly
   *    the idle spin this rule exists to forbid;
   *  - the schedule is FINITE — `recheckDelaysMs.length` attempts per agent, and
   *    an attempt is spent by its FIRING — so an unresolvable state costs a
   *    bounded number of rounds and then goes quiet;
   *  - the timer is only a TRIGGER: it calls {@link requestRound} like every
   *    other one, so a recheck landing inside an in-flight round is coalesced
   *    into that round's catch-up pass instead of overlapping it. A direct
   *    `applyAll` here would bypass the gate and could interleave with a round
   *    already in flight.
   *
   * `tornDown` short-circuits the arming AND the firing, so no timer can outlive
   * the generation that armed it (teardown clears the pending ones as well).
   */
  function scheduleRechecks(state: EffectState): void {
    if (state.tornDown || mountTornDown || !staticCapable) return
    const agents = liveAgents(state)
    const live = new Set(agents.map((agent) => agent.id))
    // A disposed agent owes nothing: drop its pending timer and its attempt count
    // rather than let them fire against a generation that no longer lists it.
    for (const [agentId, timer] of [...state.recheckTimers]) {
      if (live.has(agentId)) continue
      clearTimeout(timer)
      state.recheckTimers.delete(agentId)
    }
    for (const agentId of [...state.recheckSteps.keys()]) {
      if (!live.has(agentId)) state.recheckSteps.delete(agentId)
    }

    for (const agent of agents) {
      // The ONE state a recheck starts from (D14's 解析状态判据).
      if (scope.judgement(agent.id)?.status !== 'unresolved') continue
      // One timer at a time per agent: a pass that re-runs while it is pending
      // (a `tools/change` catch-up, say) must not arm a second one.
      if (state.recheckTimers.has(agent.id)) continue
      const attempt = state.recheckSteps.get(agent.id) ?? 0
      if (attempt >= recheckDelaysMs.length) continue
      const timer = setTimeout(() => {
        state.recheckTimers.delete(agent.id)
        state.recheckSteps.set(agent.id, attempt + 1)
        requestRound(state)
      }, recheckDelaysMs[attempt] ?? 0)
      state.recheckTimers.set(agent.id, timer)
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
    requestRound(state)
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
    // ② Then the pending recheck timers. They are the last thing outside a
    //    dispatch that could still reach into this generation, so they go before
    //    anything is released: `tornDown` is already set, so no round can arm a
    //    new one, and no timer may fire into a half-released state.
    for (const timer of state.recheckTimers.values()) clearTimeout(timer)
    state.recheckTimers.clear()
    state.recheckSteps.clear()
    // ③ Then the registrations.
    const releaseRegistrations = state.releaseRegistrations
    state.releaseRegistrations = undefined
    try {
      releaseRegistrations?.()
    } catch (error) {
      log('[cherry-remote] 释放 cherry_* 工具注册失败', error)
    }
    // ④ Then every restriction (record cleared before its layer's disposer).
    for (const [agentId, dispose] of [...state.layers]) {
      scope.clearLayer(agentId)
      try {
        dispose()
      } catch (error) {
        log(`[cherry-remote] 释放 agent ${agentId} 的 restriction 失败`, error)
      }
    }
    state.layers.clear()
    // ⑤ The guard LAST: it notifies nobody, so it triggers no recompute, and it
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
      running: false,
      dirty: false,
      layers: new Map(),
      recheckSteps: new Map(),
      recheckTimers: new Map(),
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
        reason: `cherry_* 工具注册失败：${describeError(error)}`,
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
    //
    //    R16: the installation itself is contained. The real host may deliver the
    //    injection callback asynchronously, with `mount()`'s `try` long off the
    //    stack, so a host that REFUSES the guard must degrade HERE — with the
    //    registrations already made and no disposer ever returned otherwise.
    const rootTools = root?.tools
    if (typeof rootTools?.guard === 'function') {
      try {
        state.releaseGuard = rootTools.guard((execution) => guardVerdict(execution))
      } catch (error) {
        degradeToVisibilityOnly(`宿主 tools.guard 安装被拒绝：${describeError(error)}`, error)
      }
    } else {
      degradeToVisibilityOnly(
        '宿主缺 tools.guard：执行层兜底不可用，降级为“仅可见性”（restrict 仍在装配层移除这 14 个工具，不是渲染层假过滤）',
      )
    }

    // ③ The subscriptions — all three ride the ONE contained helper (R16), so a
    //    host that refuses one `on(…)` cannot take the round down with it.
    const on = agentCtx.on
    if (typeof on === 'function') {
      subscribe<{ agent?: unknown }>(state, on, 'agent/created', (payload) => {
        onCreated(state, payload)
      })
      subscribe<{ agent?: unknown }>(state, on, 'agent/disposed', (payload) => {
        onDisposed(state, payload)
      })
      // ②'s retry path and §4 ①'s re-entrancy: the host emits this event on BOTH
      //    sides of `register`/`restrict`, so this listener hears the plugin's own
      //    install and release work. It goes through the gate — never straight
      //    into a round — or the subscription would self-trigger.
      subscribe<unknown>(state, on, 'tools/change', () => {
        requestRound(state)
      })
    }

    // ④ The first round: the synchronous, fail-closed pass now, the judgement
    //    generation right behind it.
    refresh()
    return state.teardown
  }

  /**
   * B17's single reporting site: the guard being ABSENT and the host REFUSING it
   * are the same degradation — "仅可见性". It is reported through the existing
   * warn carrier and recorded in §6.1's `degraded` set, never silent, and it is
   * never a reason to refuse registration.
   */
  function degradeToVisibilityOnly(reason: string, error?: unknown): void {
    scope.noteDegraded({ source: 'visibility-only', reason })
    log(`[cherry-remote] ${reason}`, error)
  }

  /**
   * One subscription, contained (R16): a host that refuses `on(…)` must not take
   * the round down with it — the failure is reported and the round continues with
   * whatever subscriptions succeeded. `DegradedSource` is a fixed five with no
   * member for a refused subscription, so the honest carrier is the existing warn
   * channel — the same way §6.1 handles a parse failure (B9).
   */
  function subscribe<T>(
    state: EffectState,
    on: OnFace,
    event: string,
    handle: (payload: T) => void,
  ): void {
    try {
      state.offs.push(on<T>(event, handle))
    } catch (error) {
      log(
        `[cherry-remote] 订阅 ${event} 失败；该事件的重算触发器缺失，本轮继续（其余订阅与已装层不受影响）`,
        error,
      )
    }
  }

  /** `agent/created`: synchronous, cache-only, never throws (host `@mode serial`). */
  function onCreated(state: EffectState, payload: { agent?: unknown } | undefined): void {
    if (state.tornDown || mountTornDown) return
    const agent = projectAgent(payload?.agent)
    if (agent === undefined) return
    try {
      // Only the CACHE is read here: awaiting `resolveByPath` would block the
      // session's creation, so a cache miss is the D7 fail-closed side.
      //
      // §4: this FIRST install never abstains — it happens here, synchronously,
      // even when a round is in flight (⑬). Only the convergence below is
      // coalesced, so the agent is adopted by the catch-up pass.
      applyForAgent(state, agent)
    } catch (error) {
      log(`[cherry-remote] agent ${agent.id} 的首次装配失败（不阻塞建会话）`, error)
    }
    requestRound(state)
  }

  /**
   * `agent/disposed`: releases exactly that agent's layer and its record.
   *
   * The agent's pending recheck goes with it: a session that no longer exists
   * owes no later round, so an armed timer here would be one wasted recompute at
   * best — the smaller version of the leak teardown closes for the whole
   * generation.
   */
  function onDisposed(state: EffectState, payload: { agent?: unknown } | undefined): void {
    if (state.tornDown || mountTornDown) return
    const agent = projectAgent(payload?.agent)
    if (agent === undefined) return
    try {
      const timer = state.recheckTimers.get(agent.id)
      if (timer !== undefined) {
        clearTimeout(timer)
        state.recheckTimers.delete(agent.id)
      }
      state.recheckSteps.delete(agent.id)
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
