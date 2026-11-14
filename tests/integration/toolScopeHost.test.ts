/**
 * The step-time scope host (#343/#345): capability probe, the injection gate and
 * ONE registration carrying one shared `when`.
 *
 * The legacy per-agent `restrict`/`guard` path is gone — the engine floor is
 * `>=0.2.2-rc.1`, and a host without `tools.resolve` is `unsupported`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerAtomically, createToolScopeHost } from '../../src/toolScopeHost.js'
import type { ScopeHostContext, ToolScopeHost } from '../../src/toolScopeHost.js'
import { ToolScopeState } from '../../src/toolScope.js'
import { CHERRY_TOOL_NAMES } from '../../src/tools.js'
import { FakeToolHost } from '../helpers/fakeToolHost.js'
import type { FakeHostOptions } from '../helpers/fakeToolHost.js'

const FAMILY = [...CHERRY_TOOL_NAMES]
const W1 = { id: 'w1', title: 'W1', path: '/work/w1' }

interface Fixture {
  fake: FakeToolHost
  state: ToolScopeState
  host: ToolScopeHost
  mount(): () => void
  dispose(): void
}

let live: Fixture[] = []

afterEach(() => {
  for (const fixture of live.splice(0)) fixture.dispose()
})

function makeFixture(options: FakeHostOptions = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'scope-host-'))
  const fake = new FakeToolHost(options)
  const state = new ToolScopeState({ file: join(dir, 'scope.json'), log: () => {} })
  const host = createToolScopeHost({
    scope: state,
    names: FAMILY,
    registerTools: (visibleFor) =>
      registerAtomically(fake.root, (ctx) => {
        const disposers = FAMILY.map((name) =>
          ctx.tools!.register(
            { name, description: name, execute: async () => undefined },
            visibleFor === undefined ? undefined : { when: (context) => visibleFor(context.agent) },
          ),
        )
        return () => {
          for (const dispose of disposers) dispose()
        }
      }),
    log: () => {},
  })
  const fixture: Fixture = {
    fake,
    state,
    host,
    mount: () => host.mount(fake.root as ScopeHostContext),
    dispose: () => {
      host.mount(fake.root as ScopeHostContext)()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  live.push(fixture)
  return fixture
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('mount: capability probe and the injection gate', () => {
  it('① pending: a mount() whose injection has not arrived registers nothing', () => {
    const fixture = makeFixture({ deferInjection: true })
    const unmount = fixture.mount()
    expect(fixture.state.host()).toMatchObject({ state: 'pending', capable: false })
    expect(fixture.fake.registeredNames()).toEqual([])
    expect(fixture.fake.injectKeys()).toEqual(['agents', 'workspaceRegistry'])
    unmount()
  })

  it('② unsupported: register and resolve are each a hard gate, and nothing is registered', () => {
    for (const capability of ['register', 'resolve'] as const) {
      const fixture = makeFixture({ without: [capability] })
      const unmount = fixture.mount()
      const host = fixture.state.host()
      expect(host.state).toBe('unsupported')
      expect(host.capable).toBe(false)
      expect(host.reason).toContain(capability)
      expect(fixture.fake.registeredNames()).toEqual([])
      unmount()
    }
  })

  it('③ ready: the 15 registrations share ONE condition and answer per step', async () => {
    const fixture = makeFixture()
    fixture.fake.setWorkspaces([W1])
    fixture.fake.addAgent({ id: 'agent-a', cwd: '/work/w1' })
    fixture.fake.addAgent({ id: 'agent-b', cwd: '/work/elsewhere' })
    const unmount = fixture.mount()
    expect(fixture.state.host()).toMatchObject({ state: 'ready', capable: true })
    expect(fixture.fake.registeredNames()).toHaveLength(15)
    expect(fixture.fake.whenConditions()).toBe(15)

    // Default document: selected + no workspace ⇒ nobody.
    expect(await fixture.fake.resolvedView('agent-a')).toEqual([])

    const saved = fixture.state.save({ mode: 'selected', workspaceIds: ['w1'] }, 0)
    expect(saved.ok).toBe(true)
    // The next evaluation follows the save: no reinstall round, no restart.
    expect(await fixture.fake.resolvedView('agent-a')).toEqual(FAMILY)
    expect(await fixture.fake.resolvedView('agent-b')).toEqual([])

    // A fresh agent is answered by the very next step as well.
    fixture.fake.addAgent({ id: 'agent-c', cwd: '/work/w1' })
    expect(await fixture.fake.resolvedView('agent-c')).toEqual(FAMILY)
    unmount()
  })

  it('④ unmount releases the registration, and a late injection installs nothing', () => {
    const fixture = makeFixture({ deferInjection: true })
    const unmount = fixture.mount()
    unmount()
    fixture.fake.deliverInjection()
    expect(fixture.fake.registeredNames()).toEqual([])
    expect(fixture.state.host().state).toBe('pending')
  })

  it('⑤ an inject() that throws leaves mount() alive, pending and empty', () => {
    const fixture = makeFixture({ injectThrows: true })
    const unmount = fixture.mount()
    expect(fixture.state.host()).toMatchObject({ state: 'pending', capable: false })
    expect(fixture.fake.registeredNames()).toEqual([])
    unmount()
  })

  it('⑥ a throwing registerTools leaves no half-built generation behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scope-host-'))
    const fake = new FakeToolHost()
    const state = new ToolScopeState({ file: join(dir, 'scope.json'), log: () => {} })
    const host = createToolScopeHost({
      scope: state,
      names: FAMILY,
      registerTools: () =>
        registerAtomically(fake.root, (ctx) => {
          ctx.tools!.register({ name: 'leaked', description: 'leaked', execute: async () => undefined })
          throw new Error('host refused the family')
        }),
      log: () => {},
    })
    const unmount = host.mount(fake.root as ScopeHostContext)
    expect(state.host().state).toBe('unsupported')
    expect(state.host().reason).toContain('host refused the family')
    expect(fake.registeredNames()).toEqual([])
    unmount()
    rmSync(dir, { recursive: true, force: true })
  })

  it('⑦ the condition follows the document both ways, and survives a save with no host round', async () => {
    const fixture = makeFixture()
    fixture.fake.setWorkspaces([W1])
    fixture.fake.addAgent({ id: 'agent-a', cwd: '/work/w1' })
    const unmount = fixture.mount()
    await settle()

    expect(fixture.state.save({ mode: 'global', workspaceIds: [] }, 0).ok).toBe(true)
    expect(await fixture.fake.resolvedView('agent-a')).toEqual(FAMILY)

    expect(fixture.state.save({ mode: 'selected', workspaceIds: [], }, 1).ok).toBe(true)
    expect(await fixture.fake.resolvedView('agent-a')).toEqual([])
    unmount()
  })

  it('⑧ unmount voids the judgement generation, so no stale answer survives it', async () => {
    const fixture = makeFixture()
    fixture.fake.setWorkspaces([W1])
    fixture.fake.addAgent({ id: 'agent-a', cwd: '/work/w1' })
    const unmount = fixture.mount()
    await vi.waitFor(() => expect(fixture.state.judgement('agent-a')).toBeDefined())

    // Make a stale generation OBSERVABLE: with W1 selected the old answer is
    // `visible: true`, so a surviving cache would hand the next mount a grant.
    expect(fixture.state.save({ mode: 'selected', workspaceIds: ['w1'] }, 0).ok).toBe(true)
    fixture.host.recompute()
    await vi.waitFor(() => expect(fixture.state.judgement('agent-a')?.visible).toBe(true))

    unmount()

    expect(fixture.state.judgement('agent-a')).toBeUndefined()
  })

  it('⑨ a second mount replaces the first, and the first disposer is inert', () => {
    const fixture = makeFixture()
    const unmountFirst = fixture.mount()
    const unmountSecond = fixture.mount()
    // A leaked first mount registers the same 14 names on top of live ones; the
    // NAME set alone cannot see it, the counters can.
    // Cumulative: both mounts registered once each; the leak discriminator is
    // the name-collision counter (0 here, 15 with the second-mount release deleted).
    expect(fixture.fake.registrationCalls()).toBe(30)
    expect(fixture.fake.duplicateRegistrations()).toBe(0)
    expect(fixture.fake.registeredNames()).toHaveLength(15)
    expect(fixture.state.host()).toMatchObject({ state: 'ready', capable: true })

    unmountFirst()
    // The stale disposer must not touch the generation mount #2 is serving.
    expect(fixture.fake.registeredNames()).toHaveLength(15)
    expect(fixture.state.host().state).toBe('ready')

    unmountSecond()
    expect(fixture.fake.registeredNames()).toEqual([])
    expect(fixture.state.host()).toMatchObject({ state: 'pending', capable: false })
  })

  it('⑩ a late callback from an unmounted mount cannot take the live one', () => {
    const fixture = makeFixture({ deferInjection: true })
    const unmountFirst = fixture.mount()
    unmountFirst()
    const unmountSecond = fixture.mount()
    expect(fixture.fake.injectionCount()).toBe(2)

    // The FIRST mount's callback arrives late: it must be inert.
    fixture.fake.deliverInjection(0)
    expect(fixture.fake.registeredNames()).toEqual([])
    expect(fixture.state.host().state).toBe('pending')

    fixture.fake.deliverInjection(0)
    expect(fixture.fake.registeredNames()).toHaveLength(15)
    expect(fixture.state.host().state).toBe('ready')
    unmountSecond()
  })

  it('⑪ a released ready mount reports pending, not a stale ready', () => {
    const fixture = makeFixture()
    const unmount = fixture.mount()
    expect(fixture.state.host().state).toBe('ready')
    unmount()
    expect(fixture.fake.registeredNames()).toEqual([])
    expect(fixture.state.host()).toMatchObject({ state: 'pending', capable: false })
  })

  it('⑫ a re-injected effect run cannot unload the live family', () => {
    const fixture = makeFixture({ deferInjection: true })
    fixture.mount()
    fixture.fake.deliverInjection(0)
    expect(fixture.fake.registeredNames()).toHaveLength(15)

    // The host re-runs the injection callback: a NEW effect run for the SAME
    // mount. Its disposer must be inert, not the live family's teardown.
    fixture.fake.redeliverInjection()
    // Re-entry registers NOTHING: the count stays at the first run's 14.
    expect(fixture.fake.registrationCalls()).toBe(15)
    fixture.fake.releaseEffect()

    expect(fixture.fake.registrationCalls()).toBe(15)
    expect(fixture.fake.registeredNames()).toHaveLength(15)
    expect(fixture.state.host().state).toBe('ready')
    fixture.fake.releaseEffect()
    expect(fixture.fake.registeredNames()).toEqual([])
  })

  it('⑬ a stale effect run cannot register after a newer mount came and went', () => {
    const fixture = makeFixture({ deferInjection: true })
    fixture.mount()
    const unmountSecond = fixture.mount()
    unmountSecond()
    expect(fixture.fake.injectionCount()).toBe(2)

    // Mount #1's callback (its disposer was never called) and mount #2's own
    // callback both arrive AFTER the second release: both mount tokens are
    // spent, so neither may register anything.
    fixture.fake.deliverInjection(0)
    expect(fixture.fake.registeredNames()).toEqual([])
    fixture.fake.deliverInjection(0)
    expect(fixture.fake.registeredNames()).toEqual([])
    expect(fixture.state.host()).toMatchObject({ state: 'pending', capable: false })
  })
})
