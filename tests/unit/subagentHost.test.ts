import { describe, expect, it } from 'vitest'
import { resolveSubagentConfig } from '../../src/subagent.js'
import { createSubagentHost } from '../../src/subagentHost.js'
import type { SubagentHostContext, SubagentsService } from '../../src/subagentHost.js'
import type { CherryProviderDeps, CherrySubagentProvider } from '../../src/subagent.js'

/**
 * Issue #231 — the experiment's switch, its injection gate and its state.
 *
 * `createSubagentHost` is the only place that decides whether a provider is
 * registered, and the only place that says WHY not. The four states are load
 * bearing in one direction each:
 *
 *  - `pending` (off / not injected) is neutral and says nothing is wrong;
 *  - `unsupported` (no `ctx.subagents`) is the host's shortcoming — the operator
 *    cannot fix it and must not be sent looking for a config key;
 *  - `failed` (enabled but undialable, or the name is taken) is the operator's,
 *    and its reason names every field to fix;
 *  - `ready` means one provider is registered, and exactly one.
 *
 * WHAT THIS FILE DOES NOT COVER: the provider's behaviour (that is
 * `subagentSeam.test.ts`) and the delegation itself (`subagentRun.test.ts`).
 */

/** A `run` that no case here calls: this file is about registration only. */
const RUN: CherryProviderDeps['run'] = async () => ({ status: 'completed', text: 'unused' })

/** A stand-in `ctx.subagents`, recording what was registered and released. */
function fakeService(options: { refuse?: Error } = {}): SubagentsService & {
  readonly registered: CherrySubagentProvider[]
  readonly released: number
  readonly listed: string[]
} {
  const registered: CherrySubagentProvider[] = []
  let released = 0
  const service = {
    registered,
    get released(): number {
      return released
    },
    get listed(): string[] {
      return registered.map((provider) => provider.name)
    },
    registerProvider(provider: CherrySubagentProvider): () => void {
      if (options.refuse !== undefined) throw options.refuse
      registered.push(provider)
      return () => {
        released += 1
        const index = registered.indexOf(provider)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  }
  return service
}

/**
 * A host ctx that delivers the injection SYNCHRONOUSLY, the way cordis does for
 * a service that is already loaded — which is what makes the mount-time probe a
 * sound way to detect `unsupported`.
 */
function fakeContext(service: SubagentsService | undefined): SubagentHostContext & {
  readonly injectedKeys: string[][]
  readonly injected: boolean
} {
  const injectedKeys: string[][] = []
  return {
    injectedKeys,
    get injected(): boolean {
      return injectedKeys.length > 0
    },
    ...(service === undefined ? {} : { subagents: service }),
    inject<T>(keys: readonly string[], cb: (ctx: T) => void | (() => void)): unknown {
      injectedKeys.push([...keys])
      cb({ subagents: service } as T)
      return undefined
    },
  }
}

const READY_CONFIG = {
  enabled: true,
  device: 'desk-1',
  agentId: 'agent-7',
  workspaceId: 'ws-1',
} as const

describe('the switch decides before anything else (SUB-01)', () => {
  it('①a an absent config registers nothing and injects nothing', () => {
    const service = fakeService()
    const ctx = fakeContext(service)
    const host = createSubagentHost({ resolution: resolveSubagentConfig(undefined), run: RUN })
    host.mount(ctx)
    expect(service.registered).toEqual([])
    expect(ctx.injected).toBe(false)
    expect(host.status().state).toBe('pending')
  })

  it('①b `enabled: false` with a COMPLETE target is the same nothing', () => {
    const service = fakeService()
    const ctx = fakeContext(service)
    const host = createSubagentHost({ resolution: resolveSubagentConfig({ ...READY_CONFIG, enabled: false }), run: RUN })
    host.mount(ctx)
    expect(service.registered).toEqual([])
    expect(ctx.injected).toBe(false)
  })
})

describe('a host without the service says so, and the rest of the plugin lives (SUB-02)', () => {
  it('②a no `ctx.subagents` is `unsupported`, with a reason and no throw', () => {
    const ctx = fakeContext(undefined)
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    expect(() => host.mount(ctx)).not.toThrow()
    expect(host.status().state).toBe('unsupported')
    expect(host.status().reason).toContain('subagents')
  })

  it('②b it does not even ask for the injection it knows cannot arrive', () => {
    const ctx = fakeContext(undefined)
    createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN }).mount(ctx)
    expect(ctx.injected).toBe(false)
  })
})

describe('a broken configuration is the operator’s to fix (SUB-03)', () => {
  it('③a `failed` names every missing field, and registers nothing', () => {
    const service = fakeService()
    const ctx = fakeContext(service)
    const host = createSubagentHost({ resolution: resolveSubagentConfig({ enabled: true }), run: RUN })
    host.mount(ctx)
    expect(host.status().state).toBe('failed')
    expect(host.status().reason).toContain('device')
    expect(host.status().reason).toContain('agentId')
    expect(host.status().reason).toContain('workspaceId')
    expect(service.registered).toEqual([])
  })

  it('③b an illegal `timeoutMs` fails the subsystem instead of being silently defaulted (SUB-43)', () => {
    const host = createSubagentHost({
      resolution: resolveSubagentConfig({ ...READY_CONFIG, timeoutMs: -1 }),
      run: RUN,
    })
    host.mount(fakeContext(fakeService()))
    expect(host.status().state).toBe('failed')
    expect(host.status().reason).toContain('timeoutMs')
  })
})

describe('a complete configuration registers exactly one provider (SUB-04/06)', () => {
  it('④a registers under the configured name and reports ready', () => {
    const service = fakeService()
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    host.mount(fakeContext(service))
    expect(service.listed).toEqual(['cherry'])
    expect(host.status().state).toBe('ready')
    // SUB-05: the two declarations the seam reads.
    expect(service.registered[0]?.capabilities).toEqual({
      agentOptions: false,
      agentPreset: false,
      outputSchema: false,
      depthLimit: false,
    })
    expect(service.registered[0]?.inheritsParentContext).toBe(false)
  })

  it('④b a custom provider name is honoured', () => {
    const service = fakeService()
    createSubagentHost({
      resolution: resolveSubagentConfig({ ...READY_CONFIG, providerName: 'my-cherry' }),
      run: RUN,
    }).mount(fakeContext(service))
    expect(service.listed).toEqual(['my-cherry'])
  })

  it('④c unmounting releases the registration (SUB-06)', () => {
    const service = fakeService()
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    const dispose = host.mount(fakeContext(service))
    expect(service.registered).toHaveLength(1)
    dispose()
    expect(service.released).toBe(1)
    expect(service.registered).toEqual([])
  })

  it('④d unmounting twice releases once — the registration is not double-freed', () => {
    const service = fakeService()
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    const dispose = host.mount(fakeContext(service))
    dispose()
    dispose()
    expect(service.released).toBe(1)
  })

  it('④e a refused registration fails the SUBSYSTEM, never the assembly', () => {
    // A duplicate provider name throws `DUPLICATE_PROVIDER`. The fourteen tools,
    // the settings page and the HTTP face have nothing to do with it.
    const service = fakeService({ refuse: new Error('DUPLICATE_PROVIDER: cherry') })
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    expect(() => host.mount(fakeContext(service))).not.toThrow()
    expect(host.status().state).toBe('failed')
    expect(host.status().reason).toContain('DUPLICATE_PROVIDER')
  })
})
