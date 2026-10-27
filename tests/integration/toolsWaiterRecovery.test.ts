import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { registerCherryTools } from '../../src/tools.js'
import type {
  CherryToolDefinition,
  CherryToolEngineOptions,
  CherryToolsContext,
  CherryToolsDeps,
} from '../../src/tools.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions, FakeMessageRecord } from '../loopback/fakeCherry.js'

/**
 * R3-F2 acceptance suite: the WAITER's subscription-loss recovery.
 *
 * `#awaitRun` parks on the subscription layer's buffer on every pass. That
 * buffer can disappear MID-WAIT through two different routes, both of them
 * normal operation rather than faults:
 *
 *  - the peer pushes `agent.subscriptions.resetRequired` (replay suffix lost,
 *    checkpoint lease lapsed), which makes the layer DROP the session, and
 *  - the local LRU evicts the session when a 9th session is subscribed under an
 *    advertised cap of 8.
 *
 * Either way `read` starts answering `cursor-out-of-window`, so every following
 * judgement pass sees no events at all, and the wait spins out its WHOLE window
 * and then reports `timeout` — a wrong verdict for a run that completed long
 * before, and one the caller cannot tell from a genuinely slow run.
 *
 * The recovery is one `ensure` from the cursor the wait already holds. The
 * tests below pin the two routes, the ONE re-ensure budget, and the structured
 * verdict when the re-ensure itself cannot be completed.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeCtx(): CherryToolsContext & { readonly definitions: CherryToolDefinition[] } {
  const definitions: CherryToolDefinition[] = []
  return {
    definitions,
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {
          const index = definitions.indexOf(definition)
          if (index >= 0) definitions.splice(index, 1)
        }
      },
    },
  }
}

interface Rig {
  fake: FakeCherry
  store: DeviceStore
  tmp: string
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  stop(): Promise<void>
}

const rigs: Rig[] = []

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.stop()
  vi.restoreAllMocks()
})

interface RigOptions {
  engine?: CherryToolEngineOptions
}

async function makeRig(options: FakeCherryOptions = {}, rigOptions: RigOptions = {}): Promise<Rig> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-tools-waiter-'))
  const store = new DeviceStore(join(tmp, 'devices.json'))

  const record = {
    schemaVersion: 4,
    deviceId: 'dev-A',
    displayName: 'Desk Alpha',
    hosts: [host],
    security: { [host]: 'ws' as const },
    ports: { [host]: port },
    port,
    desktopIdentity,
    grants: ['agent'] as 'agent'[],
    enabled: true,
  }
  store.upsert(record)

  const connections = new Map<string, DeviceConnection>()
  const subscriptions = new Map<string, SessionSubscriptions>()

  const connect = (deviceId: string): DeviceConnection => {
    const existing = connections.get(deviceId)
    if (existing !== undefined) return existing
    const stored = store.list().find((entry) => entry.deviceId === deviceId)
    if (stored === undefined) throw new Error(`no device ${deviceId}`)
    const connection = new DeviceConnection({
      identity,
      record: stored,
      // A loopback peer with its own generous allowance: the production 32 req/s
      // business budget would pace a wait's polling passes against the clock
      // under test, which is the one thing these scenarios must control.
      rateBudgetPerSecond: 10_000,
    })
    connections.set(deviceId, connection)
    return connection
  }

  const subs = (deviceId: string): SessionSubscriptions => {
    const existing = subscriptions.get(deviceId)
    if (existing !== undefined) return existing
    const connection = connect(deviceId)
    const created = new SessionSubscriptions(connection.rpc, {
      subscriptionsLimit: options.agent?.subscriptionLimit ?? 8,
    })
    connection.rpc.onNotification((method, params) => created.handleNotification(method, params))
    subscriptions.set(deviceId, created)
    return created
  }

  const ctx = makeCtx()
  const deps: CherryToolsDeps = {
    store,
    connect,
    subs,
    pair: async () => {
      throw new Error('pairing is not exercised by the waiter suite')
    },
    evict: () => {
      throw new Error('the waiter suite never evicts a device')
    },
  }
  registerCherryTools(ctx, deps, rigOptions.engine ?? {})
  await connect('dev-A').connect()

  const rig: Rig = {
    fake,
    store,
    tmp,
    call: (name, args = {}) => {
      const found = ctx.definitions.find((definition) => definition.name === name)
      if (found === undefined) throw new Error(`tool ${name} is not registered`)
      return found.execute(args)
    },
    stop: async () => {
      for (const created of subscriptions.values()) await created.dispose()
      for (const connection of connections.values()) await connection.close()
      await fake.stop()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
  rigs.push(rig)
  return rig
}

const AGENT = { agentId: 'agent-1', name: 'Agent One' }

function session(sessionId: string) {
  return {
    sessionId,
    agentId: 'agent-1',
    workspaceId: 'ws-1',
    title: `Session ${sessionId}`,
    historyRevision: '1',
  }
}

const SESSION = session('s-1')

const TERMINAL_MESSAGE: FakeMessageRecord = {
  messageId: 'm-assistant',
  revision: '1',
  role: 'assistant',
  status: 'success',
  parts: [{ kind: 'text', text: 'the run reply' }],
}

describe('R3-F2: a waiter recovers when its subscription disappears mid-wait', () => {
  it('F2-2a resetRequired mid-wait re-ensures and converges on the run\'s REAL terminal instead of timing out', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        terminalMessage: TERMINAL_MESSAGE,
        // The run settles well after the injected reset, so the wait's only
        // route to the terminal is through a working subscription.
        runDelayMs: 900,
      },
    })

    const pending = rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'hello',
      timeoutMs: 20_000,
    }) as Promise<{ status: string; text?: string }>

    // Mid-wait, the peer tears the subscription down — the session is dropped
    // from the layer entirely, so the waiter's buffer is gone.
    await sleep(250)
    rig.fake.pushResetRequired('s-1')

    const result = await pending
    // The run DID complete, and the waiter found it.
    expect(result.status).toBe('completed')
    expect(result.text).toContain('the run reply')
  })

  it('F2-2b a 9th session evicting this one by LRU mid-wait recovers the same way', async () => {
    const sessions = [SESSION, ...Array.from({ length: 8 }, (_unused, index) => session(`s-extra-${index}`))]
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions,
        terminalMessage: TERMINAL_MESSAGE,
        runDelayMs: 900,
        // The peer advertises (and enforces) the same cap the local LRU tracks,
        // so the 9th subscribe really does have to evict a live one.
        subscriptionLimit: 8,
      },
    })

    const pending = rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'hello',
      timeoutMs: 20_000,
    }) as Promise<{ status: string; text?: string }>

    // The send subscribed s-1. Now subscribe eight MORE sessions on the same
    // device: the local cap is 8, so s-1 is the LRU victim.
    await sleep(200)
    for (const extra of sessions.slice(1)) {
      await rig.call('cherry_read', { device: 'dev-A', sessionId: extra.sessionId })
    }

    const result = await pending
    expect(result.status).toBe('completed')
    expect(result.text).toContain('the run reply')
  })

  it('F2-2c a re-ensure the peer REFUSES ends the wait with a structured loss verdict, not a timeout', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        terminalMessage: TERMINAL_MESSAGE,
        runDelayMs: 30_000,
      },
    })

    const pending = rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'hello',
      timeoutMs: 20_000,
    }) as Promise<Record<string, unknown>>

    await sleep(200)
    // The peer drops the subscription AND refuses every re-subscribe.
    rig.fake.pushResetRequired('s-1')
    rig.fake.refuseSubscriptions('RESOURCE_EXHAUSTED')

    const result = await pending
    // NOT `timeout`: the run's outcome is unknowable, and the caller is told
    // exactly that rather than being parked out for the whole window.
    expect(result['status']).toBe('subscription-lost')
    expect(String(result['guidance'] ?? '')).toMatch(/re-?subscribe|subscription/i)
    // The run's own id is still reported, so the caller can re-wait on it.
    expect(result['executionId']).toBeDefined()
  })
})
