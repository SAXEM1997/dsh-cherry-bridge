import { describe, expect, it, vi } from 'vitest'
import { resolveSubagentConfig } from '../../src/subagent.js'
import { createSubagentHost } from '../../src/subagentHost.js'
import type { SubagentHostContext, SubagentsService } from '../../src/subagentHost.js'
import type { CherryProviderDeps, CherrySubagentProvider } from '../../src/subagent.js'
import type { CherryActivationSpec } from '../../src/subagentTool.js'
import type { CherryToolDefinition } from '../../src/tools.js'

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
function fakeService(options: { refuse?: Error; noActivation?: boolean } = {}): SubagentsService & {
  readonly registered: CherrySubagentProvider[]
  readonly released: number
  readonly listed: string[]
  readonly activations: CherryActivationSpec[]
  readonly activationReceivers: unknown[]
} {
  const registered: CherrySubagentProvider[] = []
  const activations: CherryActivationSpec[] = []
  /** The `this` each activation ran with — the receiver-binding guard's probe. */
  const activationReceivers: unknown[] = []
  let released = 0
  const service = {
    registered,
    activations,
    activationReceivers,
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
    // The tool's one seam call. Recorded, never performed: what this file pins
    // is that the TOOL the host registered is wired to THIS service.
    ...(options.noActivation === true
      ? {}
      : {
          async startActivation(this: unknown, spec: CherryActivationSpec): Promise<{
            readonly childId: string
          }> {
            activationReceivers.push(this)
            activations.push(spec)
            return { childId: 'child-from-service' }
          },
        }),
  }
  return service
}

/** The step-time context `ctx.tools.register`'s `when` receives (host shape). */
type ActivationContext = { agent: { id: string } }

/** A stand-in `ctx.tools`: registration, its activation condition, and release. */
function fakeTools(options: { refuse?: Error; noResolve?: boolean } = {}): {
  readonly definitions: CherryToolDefinition[]
  /**
   * The SECOND argument each registration carried, positionally. `undefined` at
   * an index means that call was made with one argument — the distinction a
   * `{ when: undefined }` literal would erase.
   */
  readonly registrations: Array<{ when?: (context: ActivationContext) => boolean } | undefined>
  /**
   * The host's step-time resolver — the CAPABILITY PROBE. `when` support is
   * detected through it, so a fake without it models a host that predates
   * `ToolRegistrationOptions` (our `0.2.0-rc.2` snapshot). It is present by
   * default because every case below except ⑥f describes a host that HAS the
   * option; leaving it out by default would have quietly tested the refusal path
   * in all of them.
   */
  resolve?: (context: ActivationContext) => Promise<unknown>
  register(
    definition: CherryToolDefinition,
    registrationOptions?: { when?: (context: ActivationContext) => boolean },
  ): () => void
} {
  const definitions: CherryToolDefinition[] = []
  const registrations: Array<{ when?: (context: ActivationContext) => boolean } | undefined> = []
  return {
    definitions,
    registrations,
    ...(options.noResolve === true ? {} : { resolve: async () => undefined }),
    register(definition, registrationOptions) {
      if (options.refuse !== undefined) throw options.refuse
      definitions.push(definition)
      registrations.push(registrationOptions)
      return () => {
        const index = definitions.indexOf(definition)
        if (index >= 0) definitions.splice(index, 1)
      }
    },
  }
}

/**
 * A host ctx that delivers the injection SYNCHRONOUSLY, the way cordis does for
 * a service that is already loaded.
 *
 * `tools` is optional so the two faces can be told apart: a host that has
 * `subagents` but no `tools` registry must still register the PROVIDER (the
 * host's own `subagent` tool can drive it) and must not pretend the tool exists.
 */
function fakeContext(
  service: SubagentsService | undefined,
  // `null`, not `undefined`: a default parameter fires on `undefined`, so the
  // "no registry" case would have silently received a fresh fake — the exact
  // false green ⑤e's tightened assertion caught.
  tools: ReturnType<typeof fakeTools> | null = fakeTools(),
): SubagentHostContext & {
  readonly injectedKeys: string[][]
  readonly injected: boolean
  /** The injection callback's RETURN, i.e. the injected fibre's own disposer. */
  readonly injectedEffects: Array<() => void>
} {
  const injectedKeys: string[][] = []
  const injectedEffects: Array<() => void> = []
  return {
    injectedKeys,
    injectedEffects,
    get injected(): boolean {
      return injectedKeys.length > 0
    },
    ...(tools === null ? {} : { tools }),
    // The unGATED lookup, which is the ONLY way this file lets a ctx expose the
    // service: `SubagentHostContext` has no `subagents` property at all, because
    // reading one on a real cordis ctx throws (②d).
    get(name: string): unknown {
      return name === 'subagents' ? service : undefined
    },
    inject<T>(keys: readonly string[], cb: (ctx: T) => void | (() => void)): unknown {
      injectedKeys.push([...keys])
      const effect = cb({ subagents: service } as T)
      if (typeof effect === 'function') injectedEffects.push(effect)
      return undefined
    },
  }
}

/**
 * A host ctx shaped like cordis' STRICT REFLECTION PROXY: reading a property the
 * plugin root fibre did not declare THROWS, whether or not the service exists.
 *
 * This is the one fake an ordinary object cannot stand in for, and the reason
 * the `ctx.subagents` probe survived a whole review round. cordis hands the
 * plugin root a proxy whose `get` trap raises `cannot get property "<name>"
 * without inject` for anything outside the root `inject` list — here `['tools']`,
 * exactly as `src/index.ts` declares it — and `?.` does not help, because the
 * getter itself throws. Issue #7 shipped broken this way and regressed 0.2.0
 * (see `resolveTrustedHosts` in `src/httpApi.ts`); this file pins the third
 * occurrence, so only `tools` and the two cordis methods are readable.
 */
function strictContext(options: {
  service?: SubagentsService
  tools?: ReturnType<typeof fakeTools>
  /** Omit to model a host with no dynamic injection at all. */
  noInject?: boolean
  /** Model a host that refuses the injection outright (it throws). */
  refuseInject?: boolean
  /** Model a host that delivers the callback and THEN throws (a pathological order). */
  refuseAfterDelivering?: boolean
}): { ctx: SubagentHostContext; injectedKeys: string[][] } {
  const injectedKeys: string[][] = []
  const tools = options.tools ?? fakeTools()
  const target: Record<string, unknown> = {
    tools,
    get(name: string): unknown {
      return name === 'subagents' ? options.service : undefined
    },
  }
  if (options.noInject !== true) {
    target['inject'] = <T>(keys: readonly string[], cb: (ctx: T) => void | (() => void)): unknown => {
      if (options.refuseInject === true) throw new Error('cannot inject "subagents" on this ctx')
      injectedKeys.push([...keys])
      cb({ subagents: options.service } as T)
      if (options.refuseAfterDelivering === true) throw new Error('injection torn down mid-call')
      return undefined
    }
  }
  const readable = new Set(['tools', 'get', 'inject'])
  return {
    injectedKeys,
    ctx: new Proxy(target, {
      get(object, property, receiver) {
        // Symbols are let through: nothing in `mount` reads one, and answering
        // `undefined` keeps a debugging `console.log` of the ctx from throwing
        // over the very thing this fake exists to model.
        if (typeof property === 'symbol') return undefined
        if (readable.has(property)) return Reflect.get(object, property, receiver)
        throw new Error(`cannot get property "${property}" without inject`)
      },
    }) as unknown as SubagentHostContext,
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
    expect(host.status()).toEqual({ state: 'pending', reason: { code: 'disabled' } })
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
    expect(host.status()).toEqual({ state: 'unsupported', reason: { code: 'unsupported' } })
  })

  it('②b it still ASKS for the injection: "never" is not knowable at mount', () => {
    // The verdict is provisional, not a latch. cordis' `inject` exists for the
    // service that arrives LATER, and a host that applies the seam after this
    // plugin would otherwise keep a working feature disabled forever. ②a still
    // pins the immediate verdict; this pins that the gate stays open.
    const ctx = fakeContext(undefined)
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    host.mount(ctx)
    expect(ctx.injected).toBe(true)
    expect(ctx.injectedKeys).toEqual([['subagents']])
    expect(host.status()).toEqual({ state: 'unsupported', reason: { code: 'unsupported' } })
  })

  it('②c a service that arrives AFTER mount flips `unsupported` to `ready`', () => {
    // The fake's `inject` fires synchronously; this is the late arrival it
    // cannot model, driven by hand through the same callback `mount` installed.
    const service = fakeService()
    const callbacks: Array<(ctx: unknown) => void | (() => void)> = []
    const ctx = {
      tools: fakeTools(),
      get: (name: string) => (name === 'subagents' ? undefined : undefined),
      inject<T>(keys: readonly string[], cb: (ctx: T) => void | (() => void)): unknown {
        expect([...keys]).toEqual(['subagents'])
        callbacks.push(cb as (ctx: unknown) => void | (() => void))
        return undefined
      },
    }
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    host.mount(ctx)
    expect(host.status()).toEqual({ state: 'unsupported', reason: { code: 'unsupported' } })
    expect(service.registered).toEqual([])
    for (const cb of callbacks) cb({ subagents: service })
    expect(service.registered).toHaveLength(1)
    expect(host.status()).toEqual({
      state: 'ready',
      reason: { code: 'ready', providerName: 'cherry', toolName: 'cherry_subagent' },
    })
  })

  it('②d a THROWING proxy ctx mounts without a throw (the cordis get-trap hazard)', () => {
    // The regression this pins: `ctx.subagents` as a PROPERTY READ throws on a
    // real host, so `apply` died and took the fourteen tools and the settings
    // page with it. A plain object fake passes against both implementations —
    // only a proxy whose get trap refuses undeclared keys can tell them apart.
    const service = fakeService()
    const probe = strictContext({ service })
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    expect(() => host.mount(probe.ctx)).not.toThrow()
    expect(service.registered).toHaveLength(1)
    expect(host.status()).toEqual({
      state: 'ready',
      reason: { code: 'ready', providerName: 'cherry', toolName: 'cherry_subagent' },
    })
  })

  it('②e the same proxy with NO service is `unsupported`, not a throw', () => {
    const probe = strictContext({})
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    expect(() => host.mount(probe.ctx)).not.toThrow()
    expect(host.status()).toEqual({ state: 'unsupported', reason: { code: 'unsupported' } })
  })

  it('②f no dynamic injection: the service found by `ctx.get` is registered directly', () => {
    // A host with `ctx.get` but no `ctx.inject` can never deliver a LATE
    // service, so the unGATED lookup is the only source there will ever be —
    // and skipping it would lose a provider this host is perfectly able to run.
    // This is also the one mount path that returns its OWN disposer instead of
    // handing one to the injected fibre, so the release is asserted here.
    const service = fakeService()
    const probe = strictContext({ service, noInject: true })
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    const dispose = host.mount(probe.ctx)
    expect(service.registered).toHaveLength(1)
    expect(host.status()).toEqual({
      state: 'ready',
      reason: { code: 'ready', providerName: 'cherry', toolName: 'cherry_subagent' },
    })
    dispose()
    expect(service.registered).toEqual([])
  })

  it('②g a REFUSED injection falls back to the lookup instead of going `pending`', () => {
    // A host that throws from `ctx.inject` is not waiting for anything: no
    // injection is coming. Reporting `pending` there left the panel saying
    // "waiting for the host" forever over a service the host already has.
    const service = fakeService()
    const probe = strictContext({ service, refuseInject: true })
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    expect(() => host.mount(probe.ctx)).not.toThrow()
    expect(probe.injectedKeys).toEqual([])
    expect(service.registered).toHaveLength(1)
    expect(host.status()).toEqual({
      state: 'ready',
      reason: { code: 'ready', providerName: 'cherry', toolName: 'cherry_subagent' },
    })
  })

  it('②h a refused injection with NO service is `unsupported`, not `pending`', () => {
    const probe = strictContext({ refuseInject: true })
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    expect(() => host.mount(probe.ctx)).not.toThrow()
    expect(host.status()).toEqual({ state: 'unsupported', reason: { code: 'unsupported' } })
  })

  it('②i an injection that delivers and THEN throws does not register twice', () => {
    // The fallback must not add a second provider over one the callback already
    // registered: the service answers a duplicate name with a refusal, which
    // would report `failed` over a seam that is working.
    const service = fakeService()
    const probe = strictContext({ service, refuseAfterDelivering: true })
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    expect(() => host.mount(probe.ctx)).not.toThrow()
    expect(service.registered).toHaveLength(1)
    expect(host.status()).toEqual({
      state: 'ready',
      reason: { code: 'ready', providerName: 'cherry', toolName: 'cherry_subagent' },
    })
  })
})

describe('a broken configuration is the operator’s to fix (SUB-03)', () => {
  it('③a `failed` names every missing field, and registers nothing', () => {
    const service = fakeService()
    const ctx = fakeContext(service)
    const host = createSubagentHost({ resolution: resolveSubagentConfig({ enabled: true }), run: RUN })
    host.mount(ctx)
    // The status carries the SAME structured problems the resolver produced, not
    // a rendered sentence: the page translates them, and a string here would be
    // the Chinese-to-English leak #233 exists to close.
    expect(host.status()).toEqual({
      state: 'failed',
      reason: {
        code: 'invalid',
        problems: [
          { code: 'missing', field: 'device' },
          { code: 'missing', field: 'agentId' },
          { code: 'missing', field: 'workspaceId' },
        ],
      },
    })
    expect(service.registered).toEqual([])
  })

  it('③b an illegal `timeoutMs` fails the subsystem instead of being silently defaulted (SUB-43)', () => {
    const host = createSubagentHost({
      resolution: resolveSubagentConfig({ ...READY_CONFIG, timeoutMs: -1 }),
      run: RUN,
    })
    host.mount(fakeContext(fakeService()))
    expect(host.status()).toEqual({
      state: 'failed',
      reason: {
        code: 'invalid',
        problems: [
          { code: 'out-of-range', field: 'timeoutMs', min: 0, max: 2_147_483_647, received: 'number' },
        ],
      },
    })
  })
})

describe('a complete configuration registers exactly one provider (SUB-04/06)', () => {
  it('④a registers under the configured name and reports ready', () => {
    const service = fakeService()
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    host.mount(fakeContext(service))
    expect(service.listed).toEqual(['cherry'])
    expect(host.status()).toEqual({
      state: 'ready',
      reason: { code: 'ready', providerName: 'cherry', toolName: 'cherry_subagent' },
    })
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
    expect(host.status()).toEqual({
      state: 'failed',
      // The host's own message travels verbatim: it is a proper noun, not a
      // sentence this plugin can translate, and inventing a translation for it
      // would be guessing at the host's vocabulary.
      reason: { code: 'provider-refused', message: 'DUPLICATE_PROVIDER: cherry' },
    })
  })
})

describe('the model-facing tool is registered beside the provider (SUB-04/06)', () => {
  it('⑤a registers `cherry_subagent` on the host’s tool registry', () => {
    const service = fakeService()
    const tools = fakeTools()
    createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN }).mount(
      fakeContext(service, tools),
    )
    expect(tools.definitions.map((definition) => definition.name)).toEqual(['cherry_subagent'])
  })

  it('⑤b the tool calls THIS service, under the CONFIGURED provider name', async () => {
    // The wiring, not the definition: `subagentTool.test.ts` pins the spec the
    // tool builds, and this case pins that the spec reaches the injected
    // `ctx.subagents` — and that the provider name comes from the CONFIG, so
    // renaming the provider cannot leave the tool addressing a name that is no
    // longer registered.
    const service = fakeService()
    const tools = fakeTools()
    createSubagentHost({
      resolution: resolveSubagentConfig({ ...READY_CONFIG, providerName: 'my-cherry' }),
      run: RUN,
    }).mount(fakeContext(service, tools))
    const tool = tools.definitions[0]!
    const answer = await tool.execute(
      { description: 'audit', prompt: 'list the gaps' },
      { agent: { session: { id: 'parent' } }, signal: new AbortController().signal },
    )
    expect(service.activations).toHaveLength(1)
    expect(service.activations[0]?.provider).toBe('my-cherry')
    expect(answer).toEqual({ kind: 'activation', subagentId: 'child-from-service' })
  })

  it('⑤c unmounting releases the tool with the provider (SUB-06)', () => {
    const service = fakeService()
    const tools = fakeTools()
    const dispose = createSubagentHost({
      resolution: resolveSubagentConfig(READY_CONFIG),
      run: RUN,
    }).mount(fakeContext(service, tools))
    expect(tools.definitions).toHaveLength(1)
    dispose()
    expect(tools.definitions).toEqual([])
  })

  it('⑤d the injected fibre’s teardown releases the tool too (SUB-06)', () => {
    const service = fakeService()
    const tools = fakeTools()
    const ctx = fakeContext(service, tools)
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    host.mount(ctx)
    expect(tools.definitions).toHaveLength(1)
    // The host tears the subsystem down when the injected service goes away,
    // independently of the plugin's root effect — the same second path the
    // provider's own release has.
    for (const effect of ctx.injectedEffects.splice(0)) effect()
    expect(tools.definitions).toEqual([])
    expect(service.registered).toEqual([])
    // Back to WAITING, not to off: the switch is still on, and a panel that read
    // this as `disabled` would tell the operator to turn on something already on.
    expect(host.status()).toEqual({ state: 'pending', reason: { code: 'awaiting-injection' } })
  })

  it('⑤e a host with no tool registry still gets the provider, and says why the tool is absent', () => {
    const service = fakeService()
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    host.mount(fakeContext(service, null))
    // The provider is the half that does not need `ctx.tools`: the host's own
    // `subagent` tool can drive it. Losing the whole subsystem over a missing
    // tool registry would be the wrong trade.
    expect(service.listed).toEqual(['cherry'])
    // The ABSENCE is what this case pins, so the reason has to be the
    // missing-registry one. Both arms report `ready-without-tool` and name the
    // tool, and only the nested problem says which of the two hosts this is.
    expect(host.status()).toEqual({
      state: 'ready',
      reason: {
        code: 'ready-without-tool',
        providerName: 'cherry',
        toolName: 'cherry_subagent',
        problem: { code: 'no-tools-service' },
      },
    })
  })

  it('⑤h a seam with no `startActivation` gets the provider but not the tool', () => {
    // Two different hosts, two different reasons. Collapsing them into one
    // "the tool is missing" is how a reason string starts lying: a registry that
    // is absent sends the operator to a host upgrade, while a seam without
    // `startActivation` is a host-version mismatch on the subagent service.
    const service = fakeService({ noActivation: true })
    const tools = fakeTools()
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    host.mount(fakeContext(service, tools))
    expect(service.listed).toEqual(['cherry'])
    expect(tools.definitions).toEqual([])
    expect(host.status()).toEqual({
      state: 'ready',
      reason: {
        code: 'ready-without-tool',
        providerName: 'cherry',
        toolName: 'cherry_subagent',
        problem: { code: 'no-start-activation' },
      },
    })
  })

  it('⑤i the tool is registered under the CONFIGURED `toolName` (SUB-04)', () => {
    // `SubagentConfig.toolName` is validated, defaulted and pinned by its own
    // tests, so a hardcoded name here would be a config field that does nothing:
    // an operator renaming the tool would see the settings page accept the value
    // and the registry ignore it.
    const service = fakeService()
    const tools = fakeTools()
    const host = createSubagentHost({
      resolution: resolveSubagentConfig({ ...READY_CONFIG, toolName: 'custom_delegate' }),
      run: RUN,
    })
    host.mount(fakeContext(service, tools))
    expect(tools.definitions.map((definition) => definition.name)).toEqual(['custom_delegate'])
    // The status quotes the CONFIGURED name too: a line that says
    // `cherry_subagent` while the registry holds `custom_delegate` sends the
    // operator looking for a tool that is not there. Exact equality, so no
    // rendition of the status can name the default as well.
    expect(host.status()).toEqual({
      state: 'ready',
      reason: { code: 'ready', providerName: 'cherry', toolName: 'custom_delegate' },
    })
  })

  it('⑤j a `startActivation` that uses its RECEIVER keeps working', async () => {
    // The host's `startActivation` is a method on the manager (`this` is the
    // service). Losing the receiver through the closure is silent in a fixture
    // whose fake never touches `this`, and total in production.
    const service = fakeService()
    const tools = fakeTools()
    createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN }).mount(
      fakeContext(service, tools),
    )
    const tool = tools.definitions[0]!
    await tool.execute(
      { description: 'audit', prompt: 'list the gaps' },
      { agent: { session: { id: 'parent' } }, signal: new AbortController().signal },
    )
    expect(service.activationReceivers).toEqual([service])
  })

  it('⑤k a REFUSED tool registration keeps the provider and says so', () => {
    // The host can refuse a name another plugin already took. The provider is
    // independent of it (the host's own `subagent` tool can still drive it), so
    // losing the subsystem over the tool would be the wrong trade — and the
    // reason has to say which half is missing.
    const service = fakeService()
    const tools = fakeTools({ refuse: new Error('duplicate tool name: cherry_subagent') })
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    expect(() => host.mount(fakeContext(service, tools))).not.toThrow()
    expect(service.listed).toEqual(['cherry'])
    expect(host.status()).toEqual({
      state: 'ready',
      reason: {
        code: 'ready-without-tool',
        providerName: 'cherry',
        toolName: 'cherry_subagent',
        // The host's own refusal text, carried verbatim — it names the tool the
        // host thinks collided, which no code of ours could know.
        problem: { code: 'host-refused', message: 'duplicate tool name: cherry_subagent' },
      },
    })
  })

  it('⑤l a refused tool registration still releases the provider', () => {
    const service = fakeService()
    const tools = fakeTools({ refuse: new Error('duplicate tool name') })
    const dispose = createSubagentHost({
      resolution: resolveSubagentConfig(READY_CONFIG),
      run: RUN,
    }).mount(fakeContext(service, tools))
    dispose()
    // The disposer is assembled from BOTH releases; a throw in the tool half
    // must not leave the provider half unreachable.
    expect(service.released).toBe(1)
  })

  it('⑤f a refused provider registration does not leave a tool behind', () => {
    const service = fakeService({ refuse: new Error('DUPLICATE_PROVIDER: cherry') })
    const tools = fakeTools()
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    host.mount(fakeContext(service, tools))
    // A tool addressing a provider that is not registered is a trap for the
    // model: the call would fail with "unknown provider" at delegation time,
    // long after the settings page said the subsystem was on.
    expect(host.status().state).toBe('failed')
    expect(tools.definitions).toEqual([])
  })
})

/**
 * ⑥ — the STEP-TIME activation condition (`ctx.tools.register(definition, { when })`).
 *
 * Why the tool needs one at all: the scope subsystem hides tools with
 * `tools.restrict`, but on a host that lacks `restrict` it registers NOTHING
 * (fail-closed) and therefore never installs a deny layer — so the delegation
 * tool stayed visible in every workspace, including the ones the operator
 * excluded. `when` is the one gate that does not depend on that capability: the
 * host consults it per step and drops the tool from both the declaration list
 * and dispatch.
 *
 * Three things about the host contract shape the code below, and each has its
 * own case because each is a way to get it wrong silently:
 *
 *  1. `when` is called with a CONTEXT OBJECT, not an agent id — reading
 *     `context.agent.id` is the whole body, and a test that passes an id would
 *     pin the wrong shape;
 *  2. a REJECTION is not "unavailable": `ToolsService.resolve` wraps it in a
 *     `ToolActivationError`, which FAILS THE WHOLE STEP PREPARATION — so a
 *     throwing predicate must be caught here, not propagated;
 *  3. the verdict is read at STEP time. Capturing it at registration would pin
 *     the answer for the life of the process, and a config save that grants a
 *     workspace would never take effect.
 */
describe('the tool is gated per step by the scope judgement (SUB-04)', () => {
  /** A `when` extracted from the one registration, or a failure naming why not. */
  function whenOf(tools: ReturnType<typeof fakeTools>): (context: ActivationContext) => boolean {
    const registration = tools.registrations[0]
    if (registration?.when === undefined) throw new Error('the tool was registered without a `when`')
    return registration.when
  }

  it('⑥a the condition asks `allowedFor` about the STEP’s agent', () => {
    const service = fakeService()
    const tools = fakeTools()
    const asked: string[] = []
    createSubagentHost({
      resolution: resolveSubagentConfig(READY_CONFIG),
      run: RUN,
      allowedFor: (agentId) => {
        asked.push(agentId)
        return agentId === 'allowed'
      },
    }).mount(fakeContext(service, tools))
    const when = whenOf(tools)
    expect(when({ agent: { id: 'allowed' } })).toBe(true)
    expect(when({ agent: { id: 'blocked' } })).toBe(false)
    // Per CALL, not once at registration: two contexts, two answers, two asks.
    expect(asked).toEqual(['allowed', 'blocked'])
  })

  it('⑥b without `allowedFor` the registration is made with ONE argument', () => {
    // Not `{ when: undefined }`: an unconditional registration is the shape every
    // host already understands, and a literal option object would be a change to
    // hosts that never asked for the experiment's scope gate.
    const service = fakeService()
    const tools = fakeTools()
    createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN }).mount(
      fakeContext(service, tools),
    )
    expect(tools.registrations).toHaveLength(1)
    expect(tools.registrations[0]).toBeUndefined()
  })

  it('⑥c it is LATE-BOUND: a predicate taken before the answer changes still sees the change', () => {
    // The production shape: `apply` builds the closure once, long before any
    // agent exists or any judgement is cached, and the host calls it per step.
    const service = fakeService()
    const tools = fakeTools()
    let visible = false
    createSubagentHost({
      resolution: resolveSubagentConfig(READY_CONFIG),
      run: RUN,
      allowedFor: () => visible,
    }).mount(fakeContext(service, tools))
    const when = whenOf(tools)
    expect(when({ agent: { id: 'a1' } })).toBe(false)
    visible = true
    expect(when({ agent: { id: 'a1' } })).toBe(true)
  })

  it('⑥d a throwing predicate answers `false` and logs — it must not fail the step', () => {
    // `ToolsService.resolve` turns a `when` rejection into a `ToolActivationError`
    // that fails STEP PREPARATION: propagating would take the whole turn down,
    // every turn, over one tool. Fail-closed + a log is the only safe answer.
    const service = fakeService()
    const tools = fakeTools()
    const log = vi.fn()
    createSubagentHost({
      resolution: resolveSubagentConfig(READY_CONFIG),
      run: RUN,
      allowedFor: () => {
        throw new Error('scope blew up')
      },
      log,
    }).mount(fakeContext(service, tools))
    const when = whenOf(tools)
    expect(when({ agent: { id: 'a1' } })).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]?.[0])).toContain('作用域')
  })

  it('⑥e a context with no agent object answers `false` rather than throwing', () => {
    // Structural, not hypothetical: this file's `ToolsRegistry` types the context
    // as `{ agent: { id } }`, but the condition is the ONE thing a host calls
    // into our code from a shape we do not control.
    const service = fakeService()
    const tools = fakeTools()
    createSubagentHost({
      resolution: resolveSubagentConfig(READY_CONFIG),
      run: RUN,
      allowedFor: () => true,
    }).mount(fakeContext(service, tools))
    const when = whenOf(tools) as unknown as (context: unknown) => boolean
    expect(when({})).toBe(false)
    expect(when(undefined)).toBe(false)
  })
})

/**
 * ⑦ — the CAPABILITY PROBE: a host that predates `ToolRegistrationOptions`.
 *
 * The condition is only a leak fix on a host that HONOURS it. `ctx.tools.resolve`
 * is the resolver that evaluates the conditions, so it ships with the option and
 * not before — our own host snapshot for `0.2.0-rc.2` (the LOW end of the
 * advertised `dsh` range) records `register(definition): () => void` with no
 * options object at all.
 *
 * What makes this worth its own cases rather than a comment: such a host IGNORES
 * a second argument. `register(definition, { when })` succeeds, the tool lands
 * unconditionally, the status says `ready`, and the leak is back — silently, on
 * the hosts the fix was written for. Nothing upstream errors, so the refusal has
 * to come from here.
 */
describe('a host without the activation resolver gets no ungated tool (SUB-04)', () => {
  it('⑦a no `tools.resolve` means the tool is NOT registered, and the reason says why', () => {
    const service = fakeService()
    const tools = fakeTools({ noResolve: true })
    const host = createSubagentHost({
      resolution: resolveSubagentConfig(READY_CONFIG),
      run: RUN,
      allowedFor: () => true,
    })
    host.mount(fakeContext(service, tools))
    expect(tools.definitions).toEqual([])
    expect(tools.registrations).toEqual([])
    // The PROVIDER is still registered: the host's own `subagent` tool can drive
    // it, and a missing gate must not cost the operator the whole experiment.
    expect(service.listed).toEqual(['cherry'])
    expect(host.status()).toEqual({
      state: 'ready',
      reason: {
        code: 'ready-without-tool',
        providerName: 'cherry',
        toolName: 'cherry_subagent',
        problem: { code: 'no-step-condition' },
      },
    })
  })

  it('⑦b the probe only guards the GATED registration: no `allowedFor` ⇒ no probe', () => {
    // Without a condition there is nothing to honour, so an unconditional
    // registration is exactly right even on the oldest host — and gating it on
    // `resolve` would break the one path that never needed the option.
    const service = fakeService()
    const tools = fakeTools({ noResolve: true })
    const host = createSubagentHost({ resolution: resolveSubagentConfig(READY_CONFIG), run: RUN })
    host.mount(fakeContext(service, tools))
    expect(tools.definitions).toHaveLength(1)
    expect(tools.registrations[0]).toBeUndefined()
    expect(host.status()).toEqual({
      state: 'ready',
      reason: { code: 'ready', providerName: 'cherry', toolName: 'cherry_subagent' },
    })
  })
})
