import { createCherryProvider } from './subagent.js'
import type { CherryProviderDeps, CherrySubagentProvider, SubagentConfigResolution } from './subagent.js'

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
  list?(): readonly { readonly name: string }[]
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
  log?: (...args: unknown[]) => void
}): SubagentHost {
  const log = parts.log ?? ((): void => {})
  const resolution = parts.resolution
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

      const register = (service: SubagentsService | undefined): void => {
        if (service === undefined) {
          status = { state: 'unsupported', reason: UNSUPPORTED_REASON }
          return
        }
        try {
          const dispose = service.registerProvider(
            createCherryProvider({ run: parts.run }, { name: resolution.config.providerName }),
          )
          release = dispose
          status = {
            state: 'ready',
            reason: `已注册 provider "${resolution.config.providerName}"`,
          }
        } catch (error) {
          // A duplicate name is the ordinary way this throws (`DUPLICATE_PROVIDER`),
          // and it must NOT take the assembly down: the rest of the plugin — the
          // fourteen tools, the settings page, the HTTP face — has nothing to do
          // with it.
          const message = error instanceof Error ? error.message : String(error)
          status = { state: 'failed', reason: `注册 provider 失败：${message}` }
          log('[cherry-remote] 子智能体 provider 注册失败', error)
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
