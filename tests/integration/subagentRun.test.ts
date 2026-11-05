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
import type { FakeCherryOptions } from '../loopback/fakeCherry.js'

/**
 * Issue #231 — what a delegation's run seam can report, and what it must not.
 *
 * The delegation path is `cherry_send`'s path: it runs through the same
 * `#runOnce` (issue #230 extracted it for exactly this reason), so the two
 * answers must agree about what a run's terminal means. This file pins the two
 * channels the delegation needs and the tool face gets for free.
 *
 *  - **`executionError`** — the peer's own failure classification. The fold used
 *    to keep `executionId` / `status` / `messageId` and DROP `payload.error`,
 *    which left `status: 'failed'` as the whole story. A delegation has to tell
 *    its parent something more useful than "it failed", and re-reading the event
 *    buffer a second time in the delegation runner would be a second
 *    implementation of the same fold — the drift #230's extraction exists to
 *    prevent. So the reason rides the ONE fold and both faces see it.
 *
 * WHAT THIS FILE DOES NOT COVER: the delegation itself (the runner, the
 * interaction policy, the timeout and the abort channel) lives in
 * `tests/integration/subagentDelegation.test.ts`.
 */

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

async function makeRig(options: FakeCherryOptions = {}, engine: CherryToolEngineOptions = {}): Promise<Rig> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-subagent-run-'))
  const store = new DeviceStore(join(tmp, 'devices.json'))
  store.upsert({
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
  })

  const connections = new Map<string, DeviceConnection>()
  const subscriptions = new Map<string, SessionSubscriptions>()

  const connect = (deviceId: string): DeviceConnection => {
    const existing = connections.get(deviceId)
    if (existing !== undefined) return existing
    const stored = store.list().find((entry) => entry.deviceId === deviceId)
    if (stored === undefined) throw new Error(`no device ${deviceId}`)
    const connection = new DeviceConnection({ identity, record: stored, rateBudgetPerSecond: 100_000 })
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
      throw new Error('the subagent-run suite never pairs')
    },
    evict: () => {
      throw new Error('the subagent-run suite never evicts')
    },
  }
  registerCherryTools(ctx, deps, engine)
  await connect('dev-A').connect()

  const rig: Rig = {
    fake,
    store,
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

/** The one session every scenario drives. */
const SESSION = {
  sessionId: 's-1',
  agentId: 'agent-1',
  workspaceId: 'ws-1',
  title: 'Hello',
  historyRevision: '1',
}

const AGENT = { agentId: 'agent-1', name: 'Agent One' }

/** A run that reaches the peer's `failed` terminal, with the peer's own reason. */
const FAILING_RUN: FakeCherryOptions = {
  agent: {
    agents: [AGENT],
    sessions: [SESSION],
    runTerminalStatus: 'failed',
    // `details` is the schema's unconstrained blob (`z.record(z.string(),
    // z.json())`) and is exactly where a peer could put a credential or a raw
    // payload. Carrying one in the fixture is what makes "projected" and "passed
    // through" DIFFERENT observations — without it the two implementations
    // produce the same object and the assertion cannot tell them apart.
    executionError: {
      reason: 'RESOURCE_EXHAUSTED',
      message: 'model quota exhausted',
      details: { token: 'sk-live-should-never-surface' },
    },
  },
}

describe('a failed run reports the peer’s own classification (#231)', () => {
  it('①a carries `executionError` with the reason the peer sent, not the raw payload', async () => {
    const rig = await makeRig(FAILING_RUN)
    const answer = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'do the thing',
      timeoutMs: 5_000,
    })) as Record<string, unknown>

    expect(answer['status']).toBe('failed')
    expect(answer['executionError']).toEqual({
      reason: 'RESOURCE_EXHAUSTED',
      message: 'model quota exhausted',
    })
    // The unconstrained half of the payload never rides along (SUB-53).
    expect(JSON.stringify(answer)).not.toContain('sk-live-should-never-surface')
  })

  it('①b a COMPLETED run carries no `executionError` at all', async () => {
    // Absence, not a placeholder: a `{reason: undefined}` or an empty object
    // would make "the peer said why" indistinguishable from "the peer did not",
    // which is the whole difference a caller branches on.
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], runTerminalStatus: 'completed' },
    })
    const answer = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'do the thing',
      timeoutMs: 5_000,
    })) as Record<string, unknown>

    expect(answer['status']).toBe('completed')
    expect('executionError' in answer).toBe(false)
  })
})
