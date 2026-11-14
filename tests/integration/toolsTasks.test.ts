import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import type { DeviceState } from '../../src/connection.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { registerCherryTools } from '../../src/tools.js'
import type { CherryToolDefinition, CherryToolsContext, CherryToolsDeps } from '../../src/tools.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeAgentOptions, FakeTaskRecord, FakeTaskRunRecord } from '../loopback/fakeCherry.js'

/**
 * Issue #381: `cherry_tasks`, the read-only scheduled-task face.
 *
 * Two things are pinned here that no other suite can pin. First, the face is
 * OPTIONAL: the protocol declared `agent.tasks.*` in 0.8.0 and the desktop
 * registers the handlers from 2.2.1, but there is NO hello capability bit, so
 * support can only be discovered by asking (ADR-0001). Second, the discovery is
 * latched per CONNECTION: an old desktop must not be re-probed on every call,
 * and a reconnect must re-probe, because that is what an upgraded desktop looks
 * like from here.
 */

function tasks(count: number, prefix = 'task'): FakeTaskRecord[] {
  return Array.from({ length: count }, (_unused, index) => ({
    taskId: `${prefix}-${String(index).padStart(2, '0')}`,
    agentId: index % 2 === 0 ? 'agent-1' : 'agent-2',
    name: `Task ${index}`,
    status: index === 2 ? 'paused' : 'active',
    trigger: { kind: 'interval', ms: 60_000 },
    nextRunAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }))
}

function runs(taskId: string, count: number): FakeTaskRunRecord[] {
  return Array.from({ length: count }, (_unused, index) => ({
    runId: `run-${String(index).padStart(2, '0')}`,
    taskId,
    createdAt: new Date(0).toISOString(),
    scheduledAt: new Date(0).toISOString(),
    summary: `run ${index}`,
    resultLocation: { kind: 'none' },
    status: 'completed' as const,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    outcome: 'executed' as const,
  }))
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
  call(args?: Record<string, unknown>): Promise<unknown>
  /** Drop the pooled connection; the next call builds (and probes) a new one. */
  reconnect(): Promise<void>
  /**
   * Publish a device-state transition to the engine's watchers WITHOUT touching
   * the pooled connection (#381).
   *
   * This is the only way to prove the latch reset: a reconnect REUSES the same
   * `DeviceConnection` (`connectionFor` is a pool and `#tryEstablish` recurses on
   * the same instance), so `reconnect()` builds a new object that a real
   * reconnect never would — and a latch keyed by the instance would look correct
   * while never resetting in production.
   */
  setState(state: 'ready' | 'offline' | 'identity-mismatch'): void
  /** The connection the engine currently uses, so a test can prove it is the SAME one. */
  currentConnection(): DeviceConnection
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

async function makeRig(agent: FakeAgentOptions = {}): Promise<Rig> {
  const fake = new FakeCherry({ rateLimitPerSecond: 100_000, agent })
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-tools-tasks-'))
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

  let connection: DeviceConnection | undefined
  let subscriptions: SessionSubscriptions | undefined

  const connect = (): DeviceConnection => {
    if (connection !== undefined) return connection
    const stored = store.list()[0]!
    const created = new DeviceConnection({
      identity,
      record: stored,
      rateBudgetPerSecond: 100_000,
    })
    const subs = new SessionSubscriptions(created.rpc, { subscriptionsLimit: 8 })
    created.rpc.onNotification((method, params) => subs.handleNotification(method, params))
    connection = created
    subscriptions = subs
    return created
  }

  const ctx = makeCtx()
  const watchers: Array<(state: DeviceState) => void> = []
  const deps: CherryToolsDeps = {
    store,
    connect,
    subs: () => {
      connect()
      return subscriptions!
    },
    pair: async () => {
      throw new Error('pairing is not exercised by the tasks suite')
    },
    evict: () => {
      throw new Error('the tasks suite never evicts')
    },
    watchDeviceState: (deviceId, cb) => {
      if (deviceId === 'dev-A') watchers.push(cb)
    },
  }
  registerCherryTools(ctx, deps, {})
  await connect().connect()

  const tool = ctx.definitions.find((definition) => definition.name === 'cherry_tasks')
  if (tool === undefined) throw new Error('cherry_tasks is not registered')

  const rig: Rig = {
    fake,
    call: (args = {}) => tool.execute({ device: 'dev-A', ...args }),
    reconnect: async () => {
      await subscriptions?.dispose()
      await connection?.close()
      connection = undefined
      subscriptions = undefined
      await connect().connect()
    },
    setState: (next) => {
      // The rig speaks the TOOL's vocabulary ('ready'); the dep speaks
      // `DeviceState`, where a live connection is 'connected'.
      const state: DeviceState = next === 'ready' ? 'connected' : next
      for (const cb of watchers) cb(state)
    },
    currentConnection: () => connect(),
    stop: async () => {
      await subscriptions?.dispose()
      await connection?.close()
      await fake.stop()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
  rigs.push(rig)
  return rig
}

/** The `agent.tasks.*` requests the peer actually received. */
function taskCalls(fake: FakeCherry): Array<{ method: string; params: Record<string, unknown> }> {
  return fake.readCalls.filter((call) => call.method.startsWith('agent.tasks.'))
}

describe('issue #381 ㉛: cherry_tasks', () => {
  it('㉛a lists every task with the summary fields only', async () => {
    const rig = await makeRig({ tasks: tasks(2) })
    const answer = (await rig.call()) as Record<string, unknown>
    expect(answer['action']).toBe('list')
    expect(answer['truncated']).toBe(false)
    const items = answer['items'] as Array<Record<string, unknown>>
    expect(items.map((item) => item['taskId'])).toEqual(['task-00', 'task-01'])
    // The DETAIL fields belong to `get`; a list row carrying them would make the
    // two faces indistinguishable and ship a prompt on every page.
    expect(items[0]).not.toHaveProperty('prompt')
    expect(items[0]).not.toHaveProperty('timeoutMinutes')
    expect(taskCalls(rig.fake).map((call) => call.method)).toEqual(['agent.tasks.list'])
  })

  it('㉛b passes the agentId and statuses filters through to the peer', async () => {
    const rig = await makeRig({ tasks: tasks(4) })
    const answer = (await rig.call({ agentId: 'agent-2', statuses: ['active'] })) as Record<string, unknown>
    const items = answer['items'] as Array<Record<string, unknown>>
    expect(items.map((item) => item['taskId'])).toEqual(['task-01', 'task-03'])
    const [call] = taskCalls(rig.fake)
    expect(call?.params).toMatchObject({ agentId: 'agent-2', statuses: ['active'] })
  })

  it('㉛c truncates at `limit` and the token replays, but only under the same filters', async () => {
    const rig = await makeRig({ tasks: tasks(3) })
    const first = (await rig.call({ limit: 2 })) as Record<string, unknown>
    expect(first['truncated']).toBe(true)
    expect(first['truncationReason']).toBe('limit')
    const token = first['resumeCursor']
    expect(typeof token).toBe('string')

    const second = (await rig.call({ limit: 2, cursor: token })) as Record<string, unknown>
    expect((second['items'] as Array<Record<string, unknown>>).map((item) => item['taskId'])).toEqual(['task-02'])
    expect(second['truncated']).toBe(false)

    // A token is bound to the filters it was minted under: replaying it with a
    // different `agentId` would read another query's page position, so it is
    // refused LOCALLY, before any device work.
    const before = taskCalls(rig.fake).length
    await expect(rig.call({ limit: 2, cursor: token, agentId: 'agent-1' })).rejects.toThrow(
      /different filter set/,
    )
    expect(taskCalls(rig.fake).length).toBe(before)
  })

  it('㉛d get returns the detail fields, and an unknown task id surfaces the peer refusal', async () => {
    const rig = await makeRig({
      tasks: [{ ...tasks(1)[0]!, prompt: { text: 'say hi' }, timeoutMinutes: 15, workspace: { kind: 'system' } }],
    })
    const answer = (await rig.call({ action: 'get', taskId: 'task-00' })) as Record<string, unknown>
    const task = answer['task'] as Record<string, unknown>
    expect(task['prompt']).toEqual({ text: 'say hi' })
    expect(task['timeoutMinutes']).toBe(15)

    await expect(rig.call({ action: 'get', taskId: 'nope' })).rejects.toThrow(/Task not found/)
  })

  it('㉛e runs pages a task history and run reads one entry', async () => {
    const rig = await makeRig({ tasks: tasks(1), taskRuns: runs('task-00', 3) })
    const page = (await rig.call({ action: 'runs', taskId: 'task-00', limit: 2 })) as Record<string, unknown>
    expect(page['action']).toBe('runs')
    expect((page['items'] as Array<Record<string, unknown>>).length).toBe(2)
    expect(page['truncated']).toBe(true)

    const one = (await rig.call({ action: 'run', taskId: 'task-00', runId: 'run-01' })) as Record<string, unknown>
    expect((one['run'] as Record<string, unknown>)['summary']).toBe('run 1')
  })

  it('㉛f an old desktop is answered `unsupported`, and the answer is LATCHED per connection', async () => {
    const rig = await makeRig({ tasks: tasks(1), withoutTaskMethods: true })
    const first = (await rig.call()) as Record<string, unknown>
    expect(first['error']).toBe('unsupported')
    expect(taskCalls(rig.fake).length).toBe(1)

    // The latch is what makes the verdict cheap: no further probe for ANY action.
    expect(((await rig.call({ action: 'get', taskId: 'task-00' })) as Record<string, unknown>)['error']).toBe(
      'unsupported',
    )
    expect(taskCalls(rig.fake).length).toBe(1)
  })

  it('㉛g a dropped link clears the latch, so an upgraded desktop is discovered without a restart', async () => {
    const rig = await makeRig({ tasks: tasks(1), withoutTaskMethods: true })
    expect(((await rig.call()) as Record<string, unknown>)['error']).toBe('unsupported')
    const connection = rig.currentConnection()

    // Same peer, task face turned on, SAME connection: only a link drop
    // intervenes. `reconnect()` would build a new DeviceConnection, which a real
    // reconnect never does — `connectionFor` is a pool and `#tryEstablish`
    // recurses on the same instance — so it could not prove the reset at all.
    rig.fake.setAgentOptions({ withoutTaskMethods: false })
    rig.setState('offline')
    const answer = (await rig.call()) as Record<string, unknown>
    expect(answer['action']).toBe('list')
    expect((answer['items'] as Array<Record<string, unknown>>).length).toBe(1)
    expect(rig.currentConnection()).toBe(connection)
  })

  it('㉛j an action OTHER than `list` also discovers the missing face', async () => {
    const rig = await makeRig({ tasks: tasks(1), withoutTaskMethods: true })
    // No list has run, so nothing is latched yet: this is the first call, and it
    // must answer the capability verdict rather than the peer's method error.
    const answer = (await rig.call({ action: 'get', taskId: 'task-00' })) as Record<string, unknown>
    expect(answer['error']).toBe('unsupported')
    expect(taskCalls(rig.fake).length).toBe(1)
  })

  it('㉛k a cursor refused on page TWO is not a capability verdict', async () => {
    const rig = await makeRig({ tasks: tasks(45) })
    rig.fake.failTaskListAfter(1, { reason: 'NOT_FOUND', message: 'Invalid task page cursor' })
    await expect(rig.call()).rejects.toThrow(/Invalid task page cursor/)
    expect(taskCalls(rig.fake).length).toBe(2)

    // Nothing latched: the peer serves the face and only disliked a position, so
    // the next call probes (and pages) again.
    const answer = (await rig.call()) as Record<string, unknown>
    expect(answer['action']).toBe('list')
    expect(taskCalls(rig.fake).length).toBeGreaterThan(2)
  })

  it('㉛l an UPGRADE_REQUIRED on a cursorless list is a capability verdict, and latches', async () => {
    const rig = await makeRig({ tasks: tasks(1) })
    rig.fake.failTaskListAfter(0, { reason: 'UPGRADE_REQUIRED', message: 'Task methods need a newer desktop' })
    expect(((await rig.call()) as Record<string, unknown>)['error']).toBe('unsupported')
    expect(((await rig.call()) as Record<string, unknown>)['error']).toBe('unsupported')
    expect(taskCalls(rig.fake).length).toBe(1)
  })

  it('㉛m an empty `statuses` list is refused locally, because the schema forbids it', async () => {
    const rig = await makeRig({ tasks: tasks(4) })
    // The protocol requires at least one entry, so forwarding it would spend a
    // round trip on a request the peer refuses; collapsing it to "no filter"
    // would answer every task to a caller who named none.
    const refused = (await rig.call({ statuses: [] })) as Record<string, unknown>
    expect(refused['error']).toBe('invalid-statuses')
    expect(String(refused['message'])).toMatch(/non-empty/i)
    expect(taskCalls(rig.fake).length).toBe(0)
  })

  it('㉛h a NOT_FOUND on `get` is NOT a capability verdict', async () => {
    const rig = await makeRig({ tasks: tasks(1) })
    await expect(rig.call({ action: 'get', taskId: 'missing' })).rejects.toThrow(/Task not found/)
    // The face still works: a missing task is about the TASK, not the method.
    const answer = (await rig.call()) as Record<string, unknown>
    expect(answer['action']).toBe('list')
  })

  it('㉛i action-specific arguments are refused before any device work', async () => {
    const rig = await makeRig({ tasks: tasks(1) })
    expect(((await rig.call({ action: 'get' })) as Record<string, unknown>)['error']).toBe('task-required')
    expect(((await rig.call({ action: 'run', taskId: 'task-00' })) as Record<string, unknown>)['error']).toBe(
      'run-required',
    )
    expect(((await rig.call({ action: 'nope' })) as Record<string, unknown>)['error']).toBe('invalid-action')
    expect(taskCalls(rig.fake).length).toBe(0)
  })

  it('㉛n a NOT_FOUND on the CURSORLESS first page is a capability verdict too', async () => {
    // The `-32601` arm covers a peer that never registered the methods; this one
    // covers a peer that has the methods but no task store behind them. Both are
    // the same verdict, and BOTH arms need a case that fails without them: ㉛f
    // moved to `-32601`, so deleting `'NOT_FOUND'` from the guard would otherwise
    // leave the suite green (#383 review).
    const rig = await makeRig({ tasks: tasks(1) })
    rig.fake.failTaskListAfter(0, { reason: 'NOT_FOUND', message: 'Task store unavailable' })
    expect(((await rig.call()) as Record<string, unknown>)['error']).toBe('unsupported')
    // Latched: the one-shot failure is spent, so a second call that re-probed
    // would PAGE and answer a list instead.
    expect(((await rig.call()) as Record<string, unknown>)['error']).toBe('unsupported')
    expect(taskCalls(rig.fake).length).toBe(1)
  })

  it('㉛o an identity mismatch clears the latch as well as a dropped link', async () => {
    // `#watchConnection` resets on `offline` OR `identity-mismatch`; only the
    // first was exercised, so the second arm could rot unnoticed.
    const rig = await makeRig({ tasks: tasks(1), withoutTaskMethods: true })
    expect(((await rig.call()) as Record<string, unknown>)['error']).toBe('unsupported')
    rig.fake.setAgentOptions({ withoutTaskMethods: false })
    rig.setState('identity-mismatch')
    const answer = (await rig.call()) as Record<string, unknown>
    expect(answer['action']).toBe('list')
    expect((answer['items'] as Array<Record<string, unknown>>).length).toBe(1)
  })
})
