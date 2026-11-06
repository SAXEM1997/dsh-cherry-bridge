import { createCherryProvider, resolveTargetDevice } from './subagent.js'
import type {
  CherryProviderDeps,
  CherrySubagentProvider,
  SubagentConfigResolution,
  SubagentProblem,
} from './subagent.js'
import { createCherrySubagentTool } from './subagentTool.js'
import type { CherryActivation, CherryActivationSpec } from './subagentTool.js'
import type { CherryToolDefinition } from './tools.js'

/**
 * The subagent subsystem's mount: the switch, the injection gate and the
 * provider's registration.
 *
 * Deliberately a sibling of `toolScopeHost`, not a copy of it, because the two
 * subsystems answer different questions. `toolScopeHost` asks "can this host do
 * what the SCOPE needs"; this one asks "did the operator turn the EXPERIMENT on,
 * and did they configure a target". That difference is why the state set here has
 * one value `toolScopeHost` does not need — `failed`.
 *
 * ## Why four states and not three
 *
 * | state | means | who can fix it |
 * | --- | --- | --- |
 * | `pending` | the switch is off, or the injection has not arrived | the operator (turn it on) / the host |
 * | `unsupported` | the unGATED lookup found no `subagents` — a PROVISIONAL verdict, because the injection may still deliver one | nobody, once it settles; the host, if it was only late |
 * | `failed` | enabled, but the config cannot be dialled, or the name is taken | the operator (fix the config) |
 * | `ready` | the provider is registered | — |
 *
 * `unsupported` and `failed` are both "nothing is registered", and collapsing
 * them would be the expensive mistake: one is a host capability the operator
 * cannot change, the other is a typo they can fix in the same settings page that
 * shows the message. A panel that renders "this host does not support subagents"
 * over a missing `agentId` sends them looking for a new host version.
 *
 * ## The switch is checked BEFORE the injection
 *
 * A disabled subsystem never subscribes to anything: `ctx.inject` on a service
 * this plugin does not need is a pending fibre for a feature nobody asked for.
 */

/**
 * Why the model-facing tool is missing while the provider is registered.
 *
 * One code per CAUSE, because they send an operator to four different places:
 * two say the host is too old (a tool registry, a `startActivation`), one says
 * it is too old in a way that would make the tool UNGATED, and one is a name
 * collision only the host can describe.
 */
export type SubagentToolProblem =
  | { readonly code: 'no-tools-service' }
  | { readonly code: 'no-start-activation' }
  | { readonly code: 'no-step-condition' }
  | { readonly code: 'host-refused'; readonly message: string }

/**
 * Why the subsystem is in the state it is: a code, plus exactly the parameters
 * that code needs.
 *
 * NOT a sentence, and not a `Record<string, string>` bag either. The settings
 * page is bilingual (#233), so the words have to live in the page; and a bag
 * would let a code gain a parameter no page reads (or lose one a page needs)
 * with nothing failing. As exact arms, the page's switch over `code` can be
 * exhaustive and every parameter is typed at the site that builds it.
 *
 * Two arms carry the HOST's own text (`provider-refused`, `host-refused`'s
 * message): a proper noun from the host is not translatable, and inventing words
 * for it would be guessing at the host's vocabulary. Everything this plugin
 * says itself is a code.
 */
export type SubagentStatusReason =
  | { readonly code: 'disabled' }
  | { readonly code: 'awaiting-injection' }
  | { readonly code: 'unsupported' }
  | { readonly code: 'invalid'; readonly problems: readonly SubagentProblem[] }
  | { readonly code: 'provider-refused'; readonly message: string }
  | { readonly code: 'ready'; readonly providerName: string; readonly toolName: string }
  | {
      readonly code: 'ready-without-tool'
      readonly providerName: string
      readonly toolName: string
      readonly problem: SubagentToolProblem
    }

/** What the settings page and the diagnostics report show for this subsystem. */
export interface SubagentSubsystemStatus {
  readonly state: 'pending' | 'unsupported' | 'failed' | 'ready'
  /**
   * The machine-readable reason. The PANEL renders it (its dictionary owns the
   * wording); nothing here is meant to be shown as-is.
   */
  readonly reason: SubagentStatusReason
}

/** The `ctx.subagents` face this subsystem consumes, structurally. */
export interface SubagentsService {
  registerProvider(provider: CherrySubagentProvider): () => void
  /**
   * The one activation call the model-facing tool makes. Present on every host
   * that has this seam (`dsh-subagent`'s manager host), and structural here so
   * this file stays free of `@deepseek-ai/*` types.
   */
  startActivation?(spec: CherryActivationSpec): Promise<CherryActivation>
  list?(): readonly { readonly name: string }[]
}

/**
 * The step-time activation context `ctx.tools.register`'s `when` receives. Only
 * `agent` is named: the host also passes `modelSelection` and `signal`, and a
 * structural type that named them would have to track the host's own type for
 * fields this file never reads.
 */
export interface ActivationContextLike {
  readonly agent: { readonly id: string }
}

/**
 * The CAPABILITY PROBE for `when`, and the reason it is here.
 *
 * `ctx.tools.resolve` is the step-time resolver: it is what evaluates the
 * registered conditions, so a host that predates `ToolRegistrationOptions` has
 * no use for it and does not ship it. Our own host snapshot for `0.2.0-rc.2`
 * (the low end of the advertised `dsh` range) records exactly
 * `register(definition): () => void` — no options object at all.
 *
 * That matters because such a host IGNORES a second argument rather than
 * refusing it: `register(definition, { when })` succeeds, the tool is
 * registered unconditionally, the status is `ready`, and the leak the condition
 * exists to close persists with nothing anywhere saying so. Refusing to
 * register is the only honest answer.
 *
 * It is a proxy, and a narrow one: `resolve` is the resolver FOR conditions, so
 * absence is strong evidence the feature is absent, but this plugin has not run
 * against a host in that window. Stated as a proxy rather than as a version
 * test because there is no host-version handle at this seam.
 */
export interface PredicateCapableTools {
  resolve?(context: ActivationContextLike): Promise<unknown>
}

/** The `ctx.tools` face the tool registration needs, structurally. */
export interface ToolsRegistry extends PredicateCapableTools {
  /**
   * @param definition - the model-facing tool.
   * @param options - the host's `ToolRegistrationOptions`. `when` is consulted
   *   once per step; `false` drops the tool from BOTH the step's declarations
   *   and its dispatch, and a REJECTION fails step preparation (which is why
   *   {@link createSubagentHost}'s condition never throws).
   */
  register(
    definition: CherryToolDefinition,
    options?: { readonly when?: (context: ActivationContextLike) => boolean },
  ): () => void
}

/** The ctx this subsystem mounts on. Structural, like every host face here. */
export interface SubagentHostContext {
  /**
   * Dynamic injection. The callback runs when `subagents` is available on this
   * ctx — immediately for a service already loaded, or later for one whose
   * plugin is applied after this one, which is exactly what `inject` exists for.
   */
  inject?<T>(keys: readonly string[], cb: (ctx: T) => void | (() => void)): unknown
  /**
   * cordis' optional service lookup — the unGATED read. There is deliberately
   * NO `subagents?:` property here: the ctx is a strict reflection proxy
   * (`ReflectService.handler.get`) that resolves ONLY what the fibre's own chain
   * already holds — the property on the target, or a provision on this fibre or
   * an ancestor. `subagents` arrives from a SIBLING plugin, so it is in neither,
   * and a property read throws: `cannot get property "subagents" without inject`,
   * or `cannot get required service … in inactive context` once the name is in
   * our `inject` list. `?.` does not help — the getter itself throws. Issue #7
   * shipped broken this way and regressed 0.2.0; see `resolveTrustedHosts` in
   * `httpApi.ts`. `ctx.get(name)` is the unGATED lookup: absent ⇒ `undefined`,
   * never a throw.
   */
  get?(name: string): unknown
  /**
   * The tool registry, probed at MOUNT time off the plugin root ctx — a
   * property read, which is legal HERE and only here: `tools` is a REQUIRED
   * dependency of this plugin (the root `inject` list), so cordis has already
   * committed it to our own fibre and the proxy resolves it from there.
   *
   * It is deliberately NOT part of {@link INJECT_KEYS}: the provider does not
   * need `ctx.tools` (the host's own `subagent` tool can drive it), so gating the
   * whole subsystem on the tool registry would lose a working provider over a
   * missing unrelated service.
   */
  tools?: ToolsRegistry | undefined
}

/** The injected ctx's face. */
interface SubagentInjectedContext {
  subagents?: SubagentsService | undefined
}

/**
 * Narrows the untyped `ctx.get` answer.
 *
 * A service without `registerProvider` is not the seam we consume, and reading
 * its methods would crash on a shape we only guessed at; anything else reads as
 * "not here (yet)". The interface's one REQUIRED member is therefore the whole
 * test.
 */
function asSubagentsService(value: unknown): SubagentsService | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return typeof (value as { registerProvider?: unknown }).registerProvider === 'function'
    ? (value as SubagentsService)
    : undefined
}

/** The injection key. ONE key, so the subsystem cannot be held pending by another. */
const INJECT_KEYS = ['subagents'] as const

/** What a mounted subsystem offers its assembly. */
export interface SubagentHost {
  /** Mount, and return the disposer that releases the registration. */
  mount(ctx: SubagentHostContext): () => void
  /** The current state, for the settings page and the diagnostics report. */
  status(): SubagentSubsystemStatus
}

/**
 * Build the subsystem for ONE apply.
 *
 * @param parts - the resolved config and the run seam the provider is built on.
 * @returns the mount handle; `status()` reflects the state at any moment.
 */
export function createSubagentHost(parts: {
  resolution: SubagentConfigResolution
  /** The delegation runner, bound to this apply's engine. */
  run: CherryProviderDeps['run']
  /**
   * "May this agent's step be offered the tool?" — the scope judgement, read at
   * STEP time. Absent ⇒ the tool is registered unconditionally, which is what
   * every host got before the condition existed.
   *
   * It exists because `tools.restrict` is not always available: a host without
   * it makes the scope subsystem register nothing (fail-closed) and install no
   * deny layer, so before this the delegation tool was visible in EVERY
   * workspace, excluded ones included. `when` is the one gate that needs no
   * extra host capability — it is consulted per step and drops the tool from the
   * declarations and the dispatch alike.
   *
   * MUST NOT THROW: the host turns a rejection into a `ToolActivationError` that
   * fails the whole step preparation, so a broken predicate would take down
   * every turn over one tool. A throw is caught below and read as "not
   * available".
   */
  allowedFor?: (agentId: string) => boolean
  log?: (...args: unknown[]) => void
}): SubagentHost {
  const log = parts.log ?? ((): void => {})
  const resolution = parts.resolution
  const allowedFor = parts.allowedFor
  let status: SubagentSubsystemStatus =
    resolution.kind === 'disabled'
      ? { state: 'pending', reason: { code: 'disabled' } }
      : resolution.kind === 'invalid'
        ? { state: 'failed', reason: { code: 'invalid', problems: resolution.problems } }
        : { state: 'pending', reason: { code: 'awaiting-injection' } }
  // The registration's disposer, once it exists. Held so `mount`'s own disposer
  // and the injected effect cannot each release it twice.
  let release: (() => void) | undefined

  return {
    mount(ctx: SubagentHostContext): () => void {
      // SUB-01: the switch is the whole decision. A half-written target behind a
      // closed switch is a draft, and a disabled subsystem subscribes to nothing.
      if (resolution.kind === 'disabled') return () => {}
      // SUB-03: enabled but undialable. Nothing is registered, and the reason is
      // every problem the resolver found.
      if (resolution.kind === 'invalid') return () => {}

      // The static probe of `tools`, off the plugin ROOT ctx — a property read,
      // legal because `tools` IS in the root fibre's inject list (unlike
      // `subagents`; see {@link SubagentHostContext.get}). Captured here, at
      // mount time, so the injected callback reads a value that cannot change
      // under it.
      const tools = ctx.tools

      /**
       * Register the model-facing tool against the service we just registered a
       * provider on.
       *
       * Each refusal names its OWN cause: "the host has no tool registry" and
       * "the seam cannot start an activation" send an operator to different
       * places, and collapsing them into one `undefined` is how a reason string
       * starts lying.
       *
       * @returns the tool's disposer, or the reason there is none.
       */
      const registerTool = (
        service: SubagentsService,
      ): { release: () => void } | { problem: SubagentToolProblem } => {
        if (tools === undefined) return { problem: { code: 'no-tools-service' } }
        const startActivation = service.startActivation
        // A service with no `startActivation` cannot honour the tool: registering
        // it would promise the model a delegation that throws on every call.
        if (typeof startActivation !== 'function') return { problem: { code: 'no-start-activation' } }
        // A host that predates the option ignores it rather than refusing it —
        // see {@link PredicateCapableTools}. Registering there would leave the
        // tool ON in every workspace with nothing saying so, which is the exact
        // failure the condition exists to close, one host generation earlier.
        if (allowedFor !== undefined && typeof tools.resolve !== 'function') {
          return { problem: { code: 'no-step-condition' } }
        }
        const definition = createCherrySubagentTool({
          // SUB-04: the CONFIGURED names. A hardcoded literal here would make
          // `toolName` a config field that validates, defaults and does
          // nothing — the settings page would accept a rename the registry
          // never sees.
          toolName: resolution.config.toolName,
          providerName: resolution.config.providerName,
          // The SAME resolution the runner uses, so the tool cannot report a
          // desktop the run does not address.
          resolveDevice: (cwd: string) =>
            resolveTargetDevice(resolution.config.target, resolution.config.routes, cwd),
          // Bound to the service: `startActivation` is a host method and must
          // not lose its receiver on the way through this closure.
          startActivation: (spec: CherryActivationSpec) => startActivation.call(service, spec),
        })
        // No predicate ⇒ ONE argument: an unconditional registration, the shape
        // every host already understands.
        if (allowedFor === undefined) return { release: tools.register(definition) }
        return {
          release: tools.register(definition, {
            when: (context) => {
              try {
                return allowedFor(context.agent.id)
              } catch (error) {
                // Fail-closed AND swallowed: propagating would fail step
                // preparation (`ToolActivationError`), taking the whole turn
                // down over one tool's visibility.
                log('[cherry-remote] 子智能体工具的作用域判定抛错；本轮按不可见处理', error)
                return false
              }
            },
          }),
        }
      }

      const register = (service: SubagentsService | undefined): void => {
        if (service === undefined) {
          status = { state: 'unsupported', reason: { code: 'unsupported' } }
          return
        }
        let releaseProvider: () => void
        try {
          releaseProvider = service.registerProvider(
            createCherryProvider({ run: parts.run }, { name: resolution.config.providerName }),
          )
        } catch (error) {
          // A duplicate name is the ordinary way this throws (`DUPLICATE_PROVIDER`),
          // and it must NOT take the assembly down: the rest of the plugin — the
          // fourteen tools, the settings page, the HTTP face — has nothing to do
          // with it.
          const message = error instanceof Error ? error.message : String(error)
          status = { state: 'failed', reason: { code: 'provider-refused', message } }
          log('[cherry-remote] 子智能体 provider 注册失败', error)
          return
        }
        // The provider exists from here on, so every path below must keep a
        // disposer for it — including the one where the tool cannot be added.
        let releaseTool: (() => void) | undefined
        let toolProblem: SubagentToolProblem | undefined
        try {
          const added = registerTool(service)
          if ('problem' in added) toolProblem = added.problem
          else releaseTool = added.release
        } catch (error) {
          // A refused tool registration is the host's answer (a name already
          // taken), not a broken configuration: the PROVIDER still works — the
          // host's own `subagent` tool can drive it — so the subsystem stays
          // `ready` and only the model-facing tool is missing.
          toolProblem = {
            code: 'host-refused',
            message: error instanceof Error ? error.message : String(error),
          }
          log('[cherry-remote] cherry_subagent 工具注册失败', error)
        }
        release = () => {
          releaseTool?.()
          releaseProvider()
        }
        // Both CONFIGURED names: a status line that quotes the default while the
        // operator renamed the tool sends them looking for a tool that is not in
        // the registry.
        const providerName = resolution.config.providerName
        const toolName = resolution.config.toolName
        status =
          toolProblem === undefined
            ? { state: 'ready', reason: { code: 'ready', providerName, toolName } }
            : {
                state: 'ready',
                reason: { code: 'ready-without-tool', providerName, toolName, problem: toolProblem },
              }
      }

      // The service probe, and the ONLY legal way to make it: `ctx.get`, never a
      // property read (see {@link SubagentHostContext.get} — the property read
      // throws on a real cordis ctx, which is how issue #7 shipped broken).
      const present = asSubagentsService(ctx.get?.('subagents'))

      const teardown = (): void => {
        release?.()
        release = undefined
      }

      if (typeof ctx.inject === 'function') {
        // A PROVISIONAL verdict, never a latch. `ctx.inject` is what makes the
        // service reach us, and cordis fires it for a service whose plugin is
        // applied LATER — so an absent one here is "not yet" as much as "never",
        // and `register` overwrites this the moment the injection lands.
        if (present === undefined) status = { state: 'unsupported', reason: { code: 'unsupported' } }
        try {
          ctx.inject(INJECT_KEYS, (injected: SubagentInjectedContext) => {
            register(injected.subagents)
            // The callback's return value is the effect's disposer: the host
            // tears the registration down when the injected fibre goes away,
            // which is SUB-06's unload path.
            return () => {
              teardown()
              status = { state: 'pending', reason: { code: 'awaiting-injection' } }
            }
          })
          return teardown
        } catch (error) {
          // The host refused the injection. That is never `failed` — nothing
          // about the operator's configuration is wrong — and it is not
          // `pending` either: no injection is coming, so the unGATED lookup is
          // all there will ever be.
          log('[cherry-remote] subagents 注入被宿主拒绝；改用 ctx.get 的静态结果', error)
        }
      }

      // No dynamic injection at all, or the host refused it. Either way the
      // unGATED lookup is the only source there will ever be, so "absent" here
      // IS permanent — the one place `unsupported` is a verdict, not a guess.
      if (present === undefined) {
        status = { state: 'unsupported', reason: { code: 'unsupported' } }
        // The CODE, not a second copy of the sentence the page shows: a log line
        // that paraphrases the panel's wording is one more place for the two to
        // disagree, and an operator reading this log has the page open anyway.
        log('[cherry-remote] 子智能体子系统不可用', status.reason)
        return () => {}
      }
      // A host that fired the callback and THEN threw would otherwise register
      // twice, which the service answers with a duplicate-name refusal — a
      // `failed` status over a seam that works.
      if (release === undefined) register(present)
      return teardown
    },

    status(): SubagentSubsystemStatus {
      return status
    },
  }
}
