import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
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

  it('㉛g a RECONNECT re-probes, so an upgraded desktop is discovered without a restart', async () => {
    const rig = await makeRig({ tasks: tasks(1), withoutTaskMethods: true })
    expect(((await rig.call()) as Record<string, unknown>)['error']).toBe('unsupported')

    // Same peer, task face turned on, NEW connection: the latch must not survive.
    rig.fake.setAgentOptions({ tasks: tasks(1), withoutTaskMethods: false })
    await rig.reconnect()
    const answer = (await rig.call()) as Record<string, unknown>
    expect(answer).toMatchObject({ action: 'list' })
    expect(answer['action']).toBe('list')
    expect((answer['items'] as Array<Record<string, unknown>>).length).toBe(1)
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
})
