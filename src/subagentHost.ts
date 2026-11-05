import { createCherryProvider, resolveTargetDevice } from './subagent.js'
import type { CherryProviderDeps, CherrySubagentProvider, SubagentConfigResolution } from './subagent.js'
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
 * | `unsupported` | this host has no `ctx.subagents` at all | nobody: the host is too old |
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

/** What the settings page and the diagnostics report show for this subsystem. */
export interface SubagentSubsystemStatus {
  readonly state: 'pending' | 'unsupported' | 'failed' | 'ready'
  /** Human-readable, and the ONLY thing a panel has to render. */
  readonly reason: string
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
   * ctx, which for an already-loaded service is immediately — the reason the
   * probe below can treat "absent at mount" as `unsupported`.
   */
  inject?<T>(keys: readonly string[], cb: (ctx: T) => void | (() => void)): unknown
  /** Present on the plugin root ctx once a subagent registry is loaded. */
  subagents?: SubagentsService | undefined
  /**
   * The tool registry, probed at MOUNT time off the plugin root ctx — the same
   * static probe `toolScopeHost` makes, and for the same reason: a host without
   * it will never have it.
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

/** The injection key. ONE key, so the subsystem cannot be held pending by another. */
const INJECT_KEYS = ['subagents'] as const

/** What a mounted subsystem offers its assembly. */
export interface SubagentHost {
  /** Mount, and return the disposer that releases the registration. */
  mount(ctx: SubagentHostContext): () => void
  /** The current state, for the settings page and the diagnostics report. */
  status(): SubagentSubsystemStatus
}

/** The reason text for a host that has no registry at all (SUB-02). */
const UNSUPPORTED_REASON = '宿主没有 subagents 服务（DSH 版本过低）；子智能体子系统不可用，其余功能不受影响'

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
      ? { state: 'pending', reason: '实验性子智能体未启用（默认关闭）' }
      : resolution.kind === 'invalid'
        ? { state: 'failed', reason: resolution.problems.join('；') }
        : { state: 'pending', reason: '等待宿主注入 subagents' }
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

      // The STATIC probe, at mount time and off the plugin ROOT ctx — the same
      // shape `toolScopeHost` uses for `tools`, and for the same reason: a host
      // that will never have the service must say so, while "the injection has
      // not arrived yet" is a different state that resolves itself.
      if (ctx.subagents === undefined) {
        status = { state: 'unsupported', reason: UNSUPPORTED_REASON }
        log(`[cherry-remote] 子智能体子系统未启用：${UNSUPPORTED_REASON}`)
        return () => {}
      }

      // The SECOND static probe, and the same reasoning: `ctx.tools` either
      // exists on this host or never will. Captured here, at mount time, so the
      // injected callback reads a value that cannot change under it.
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
      ): { release: () => void } | { problem: string } => {
        if (tools === undefined) return { problem: '宿主没有 tools 服务' }
        const startActivation = service.startActivation
        // A service with no `startActivation` cannot honour the tool: registering
        // it would promise the model a delegation that throws on every call.
        if (typeof startActivation !== 'function') return { problem: '宿主没有 startActivation 接口' }
        // A host that predates the option ignores it rather than refusing it —
        // see {@link PredicateCapableTools}. Registering there would leave the
        // tool ON in every workspace with nothing saying so, which is the exact
        // failure the condition exists to close, one host generation earlier.
        if (allowedFor !== undefined && typeof tools.resolve !== 'function') {
          return {
            problem:
              '宿主没有 tools.resolve（步骤级激活条件不受支持），无法逐步骤约束可见性；工具不注册（fail-closed）',
          }
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
          status = { state: 'unsupported', reason: UNSUPPORTED_REASON }
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
          status = { state: 'failed', reason: `注册 provider 失败：${message}` }
          log('[cherry-remote] 子智能体 provider 注册失败', error)
          return
        }
        // The provider exists from here on, so every path below must keep a
        // disposer for it — including the one where the tool cannot be added.
        let releaseTool: (() => void) | undefined
        let toolProblem: string | undefined
        try {
          const added = registerTool(service)
          if ('problem' in added) toolProblem = added.problem
          else releaseTool = added.release
        } catch (error) {
          // A refused tool registration is the host's answer (a name already
          // taken), not a broken configuration: the PROVIDER still works — the
          // host's own `subagent` tool can drive it — so the subsystem stays
          // `ready` and only the model-facing tool is missing.
          toolProblem = `工具注册被宿主拒绝：${error instanceof Error ? error.message : String(error)}`
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
        status = {
          state: 'ready',
          reason:
            toolProblem === undefined
              ? `已注册 provider "${providerName}" 与工具 "${toolName}"`
              : `已注册 provider "${providerName}"；${toolProblem}，工具 "${toolName}" 未注册`,
        }
      }

      try {
        ctx.inject?.(INJECT_KEYS, (injected: SubagentInjectedContext) => {
          register(injected.subagents)
          // The callback's return value is the effect's disposer: the host tears
          // the registration down when the injected fibre goes away, which is
          // SUB-06's unload path.
          return () => {
            release?.()
            release = undefined
            status = { state: 'pending', reason: '等待宿主注入 subagents' }
          }
        })
      } catch (error) {
        // The host refused the injection. Stay `pending` rather than `failed`:
        // nothing about the operator's configuration is wrong.
        status = { state: 'pending', reason: '等待宿主注入 subagents' }
        log('[cherry-remote] subagents 注入不可用；子智能体子系统保持 pending', error)
      }

      return () => {
        release?.()
        release = undefined
      }
    },

    status(): SubagentSubsystemStatus {
      return status
    },
  }
}
