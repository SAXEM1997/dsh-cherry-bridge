import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore'
import { DeviceConnection, DeviceUnavailableError } from '../../src/connection'
import { SessionSubscriptions } from '../../src/subscriptions'
import { registerCherryTools } from '../../src/tools'
import type { CherryToolDefinition, CherryToolsContext, CherryToolsDeps } from '../../src/tools'
import { FakeCherry } from '../loopback/fakeCherry'
import type { FakeCherryOptions } from '../loopback/fakeCherry'

/**
 * Task 8 integration suite: the six read-only `cherry_*` tools driven through
 * the REAL registration seam against a real loopback Noise-XX fake desktop.
 * Test numbering ①-⑦ mirrors the task brief's Step 1 scenarios (⑧ is the unit
 * schema suite in `tests/unit/toolSchemas.test.ts`).
 *
 * The rig deliberately uses a faithful fake `ctx.tools`: it collects the
 * `ToolDefinition` objects the plugin registers, so every assertion runs
 * through the same literal-JSON-Schema definitions the host registry receives
 * (the production path), not a bespoke test double of the tool bodies.
 */

const PAGE_ITEMS = 100
const CONTENT_READ_MAX_BYTES = 24 * 1024

// ---------------------------------------------------------------------------
// Fake ctx.tools: a faithful stand-in for the host registry's `register`
// ---------------------------------------------------------------------------

interface FakeCtx extends CherryToolsContext {
  readonly definitions: CherryToolDefinition[]
}

function makeCtx(): FakeCtx {
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

// ---------------------------------------------------------------------------
// Rig: a real DeviceConnection to a real loopback fake desktop
// ---------------------------------------------------------------------------

interface Rig {
  fake: FakeCherry
  ctx: FakeCtx
  store: DeviceStore
  tmp: string
  tool(name: string): CherryToolDefinition
  /** Invoke one registered tool by name, exactly as the host would. */
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  stop(): Promise<void>
}

const rigs: Rig[] = []
// Console is spied for the whole suite: the read tools warn on recoverable
// conditions (a retry, a failed ack, an unreadable connection row) and nothing
// they log may reach the test runner's output.
let consoleWarn: ReturnType<typeof vi.fn>

beforeEach(() => {
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.stop()
  vi.restoreAllMocks()
})

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

interface RigOptions {
  /** Extra paired devices to seed (so a prefix can be ambiguous). */
  extraDevices?: Array<{ deviceId: string; displayName: string }>
  /** Connection options forwarded to `DeviceConnection`. */
  connection?: { rateBudgetPerSecond?: number; rpcTimeoutMs?: number }
  /** Skip `connect()` so the device stays offline (the §6 offline face). */
  skipConnect?: boolean
}

async function makeRig(options: FakeCherryOptions = {}, rigOptions: RigOptions = {}): Promise<Rig> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-tools-'))
  const store = new DeviceStore(join(tmp, 'devices.json'))

  const record = {
    schemaVersion: 2,
    deviceId: 'dev-A',
    displayName: 'Desk Alpha',
    hosts: [host],
    port,
    desktopIdentity,
    grants: ['agent'] as 'agent'[],
    enabled: true,
  }
  store.upsert(record)
  for (const extra of rigOptions.extraDevices ?? []) {
    store.upsert({ ...record, deviceId: extra.deviceId, displayName: extra.displayName, enabled: false })
  }

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
      ...(rigOptions.connection ?? {}),
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
      throw new Error('pairing is not exercised by the read-only suite')
    },
    identity,
  }
  registerCherryTools(ctx, deps)

  if (rigOptions.skipConnect !== true) {
    await connect('dev-A').connect()
  }

  const tool = (name: string): CherryToolDefinition => {
    const found = ctx.definitions.find((definition) => definition.name === name)
    if (found === undefined) throw new Error(`tool ${name} is not registered`)
    return found
  }

  const rig: Rig = {
    fake,
    ctx,
    store,
    tmp,
    tool,
    call: (name, args = {}) => tool(name).execute(args),
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

/** The six read-only tools this task registers, in registration order. */
const READ_TOOL_NAMES = [
  'cherry_devices',
  'cherry_agents',
  'cherry_workspaces',
  'cherry_sessions',
  'cherry_read',
  'cherry_events',
]

describe('read-only cherry tools over a real loopback channel', () => {
  it('① cherry_devices returns the closed five-state enum from the pooled connections', async () => {
    const rig = await makeRig()
    // A second, disabled device: `disabled` is one of the five states and must
    // come from the store's `enabled` flag, not from a dial attempt.
    rig.store.upsert({
      ...rig.store.list()[0]!,
      deviceId: 'dev-B',
      displayName: 'Desk Beta',
      enabled: false,
    })

    const result = (await rig.call('cherry_devices')) as { devices: Array<{ deviceId: string; state: string }> }
    const states = result.devices.map((device) => device.state)

    // The five-state set is CLOSED: every value is one of these.
    const CLOSED = ['connected', 'connecting', 'offline', 'disabled', 'identity-mismatch']
    for (const state of states) expect(CLOSED).toContain(state)

    const alpha = result.devices.find((device) => device.deviceId === 'dev-A')
    const beta = result.devices.find((device) => device.deviceId === 'dev-B')
    expect(alpha?.state).toBe('connected')
    // dev-B has no live connection yet: the tool must NOT dial to answer, so an
    // enabled-but-unconnected device reads `offline` and a disabled one reads
    // `disabled` without ever touching the network.
    expect(beta?.state).toBe('disabled')
    expect(rig.fake.connectionCount).toBe(1)
  })

  it('②a cherry_agents aggregates three 50-item pages into the 150-item aggregate, clamping each page to limits.pageItems', async () => {
    // The peer holds 150 agents and pages at 50 items. A caller that let the
    // per-page limit exceed `pageItems` would still be capped by the wire, so
    // the aggregate must be built from three real pages.
    const agents = Array.from({ length: 150 }, (_unused, index) => ({
      agentId: `agent-${String(index).padStart(3, '0')}`,
      name: `Agent ${index}`,
    }))
    const rig = await makeRig({ agent: { agents, maxPageSize: 50 } })

    const result = (await rig.call('cherry_agents', { device: 'dev-A', limit: 150 })) as {
      items: Array<{ agentId: string }>
    }
    expect(result.items).toHaveLength(150)
    expect(result.items[0]!.agentId).toBe('agent-000')
    expect(result.items[149]!.agentId).toBe('agent-149')

    // Three pages were requested, and EVERY per-page limit is ≤ pageItems —
    // the aggregate total never lets a single page exceed the protocol cap.
    const calls = rig.fake.readCallsFor('agent.agents.list')
    expect(calls).toHaveLength(3)
    for (const call of calls) expect(call['limit'] as number).toBeLessThanOrEqual(PAGE_ITEMS)
    // Page 1 carries no cursor; pages 2/3 carry the numeric offsets.
    expect(calls[0]!['cursor']).toBeUndefined()
    expect(calls[1]!['cursor']).toBe('50')
    expect(calls[2]!['cursor']).toBe('100')
  })

  it('②b cherry_agents stops at the caller limit without over-fetching the last page', async () => {
    const agents = Array.from({ length: 150 }, (_unused, index) => ({
      agentId: `agent-${index}`,
      name: `Agent ${index}`,
    }))
    const rig = await makeRig({ agent: { agents } })

    const result = (await rig.call('cherry_agents', { device: 'dev-A', limit: 60 })) as {
      items: Array<{ agentId: string }>
    }
    expect(result.items).toHaveLength(60)
    const calls = rig.fake.readCallsFor('agent.agents.list')
    // Page 1 asks for 60 (its clamp is the remaining aggregate, 60 < 100);
    // there is nothing left to ask for, so no second page is issued.
    expect(calls).toHaveLength(1)
    expect(calls[0]!['limit']).toBe(60)
  })

  it('②c cherry_sessions aggregates across pages and passes workspaceId/agentId through to agent.sessions.list', async () => {
    const sessions = Array.from({ length: 150 }, (_unused, index) => ({
      sessionId: `s-${String(index).padStart(3, '0')}`,
      agentId: 'agent-1',
      workspaceId: index % 2 === 0 ? 'ws-keep' : 'ws-other',
      title: `Session ${index}`,
      historyRevision: '1000',
    }))
    const rig = await makeRig({ agent: { sessions } })

    // 75 sessions live in ws-keep: the peer filters, and the tool must forward
    // BOTH filters verbatim.
    const result = (await rig.call('cherry_sessions', {
      device: 'dev-A',
      workspaceId: 'ws-keep',
      agentId: 'agent-1',
      limit: 150,
    })) as { items: Array<{ sessionId: string; workspaceId: string }> }

    expect(result.items).toHaveLength(75)
    for (const session of result.items) expect(session.workspaceId).toBe('ws-keep')

    const calls = rig.fake.readCallsFor('agent.sessions.list')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    for (const call of calls) {
      expect(call['workspaceId']).toBe('ws-keep')
      expect(call['agentId']).toBe('agent-1')
      expect(call['limit'] as number).toBeLessThanOrEqual(PAGE_ITEMS)
    }
  })

  it('③ cherry_workspaces returns the registered list plus the systemWorkspace flag', async () => {
    const rig = await makeRig({
      agent: {
        agents: [{ agentId: 'agent-1', name: 'Agent One' }],
        workspaces: [
          { workspaceId: 'ws-1', name: 'Project One' },
          { workspaceId: 'ws-2', name: 'Project Two' },
        ],
      },
    })

    const result = (await rig.call('cherry_workspaces', { device: 'dev-A', agentId: 'agent-1' })) as {
      items: Array<{ workspaceId: string; name: string }>
      systemWorkspace: boolean
    }
    expect(result.items.map((workspace) => workspace.workspaceId)).toEqual(['ws-1', 'ws-2'])
    // The system workspace has NO enumerable id: only its existence is known.
    expect(result.systemWorkspace).toBe(true)
    expect(JSON.stringify(result.items)).not.toContain('system')
  })

  it('④ cherry_read walks sessions.get → messages.list → parts.list and aggregates {ref} parts through content.read', async () => {
    // A 30 KiB part: above the peer's inline limit, so it travels as a {ref}
    // and its bytes only exist behind agent.content.read.
    const big = 'B'.repeat(30 * 1024)
    const rig = await makeRig({
      agent: {
        agents: [{ agentId: 'agent-1', name: 'Agent One' }],
        sessions: [
          {
            sessionId: 's-1',
            agentId: 'agent-1',
            workspaceId: 'ws-1',
            title: 'Hello',
            historyRevision: '1000',
          },
        ],
        messages: [
          {
            messageId: 'm-1',
            revision: '1001',
            role: 'user',
            status: 'success',
            parts: [{ kind: 'text', text: 'inline hello' }, { kind: 'text', text: big, external: true }],
          },
          {
            messageId: 'm-2',
            revision: '1002',
            role: 'assistant',
            status: 'success',
            parts: [{ kind: 'text', text: 'assistant reply' }],
          },
        ],
      },
    })

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      session: { sessionId: string; historyRevision: string }
      messages: Array<{ messageId: string; parts: Array<{ content: string }> }>
    }

    // The baseline revision came from sessions.get, not from the caller.
    expect(result.session.sessionId).toBe('s-1')
    expect(result.session.historyRevision).toBe('1000')

    // The two-level flow landed on the wire with the exact revisions.
    const messageCalls = rig.fake.readCallsFor('agent.messages.list')
    expect(messageCalls[0]!['sessionId']).toBe('s-1')
    expect(messageCalls[0]!['historyRevision']).toBe('1000')

    const partsCalls = rig.fake.readCallsFor('agent.parts.list')
    expect(partsCalls.map((call) => call['messageId']).sort()).toEqual(['m-1', 'm-2'])
    const m1 = partsCalls.find((call) => call['messageId'] === 'm-1')!
    const m2 = partsCalls.find((call) => call['messageId'] === 'm-2')!
    // Each message threads its OWN messageRevision — never the history one.
    expect(m1['messageRevision']).toBe('1001')
    expect(m2['messageRevision']).toBe('1002')

    // The {ref} content was fetched through content.read and aggregated.
    const contentCalls = rig.fake.readCallsFor('agent.content.read')
    expect(contentCalls.length).toBeGreaterThan(1)
    for (const call of contentCalls) {
      expect(call['maxBytes'] as number).toBeLessThanOrEqual(CONTENT_READ_MAX_BYTES)
    }
    const texts = result.messages.flatMap((message) => message.parts.map((part) => part.content))
    expect(texts).toContain('inline hello')
    expect(texts).toContain('assistant reply')
    expect(texts).toContain(big)
  })

  it('④c cherry_read paginates a message\'s parts to completion under the per-page clamp', async () => {
    // 150 parts on one message: a single bounded page would silently drop a
    // third of the snapshot, so the part list must be walked to completion.
    const parts = Array.from({ length: 150 }, (_unused, index) => ({
      kind: 'text' as const,
      text: `part-${index}`,
    }))
    const rig = await makeRig({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
        ],
        messages: [{ messageId: 'm-1', revision: '1001', role: 'user', status: 'success', parts }],
        maxPageSize: 50,
      },
    })

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{ parts: Array<{ content: string }> }>
    }
    expect(result.messages[0]!.parts).toHaveLength(150)
    expect(result.messages[0]!.parts[0]!.content).toBe('part-0')
    expect(result.messages[0]!.parts[149]!.content).toBe('part-149')

    const calls = rig.fake.readCallsFor('agent.parts.list')
    expect(calls).toHaveLength(3)
    for (const call of calls) expect(call['limit'] as number).toBeLessThanOrEqual(PAGE_ITEMS)
    expect(calls[1]!['cursor']).toBe('50')
    expect(calls[2]!['cursor']).toBe('100')
  })

  it('④b cherry_read verifies the sha256 of an aggregated {ref} and refuses tampered bytes', async () => {
    const big = 'C'.repeat(30 * 1024)
    const rig = await makeRig({
      agent: {
        agents: [{ agentId: 'agent-1', name: 'Agent One' }],
        sessions: [
          {
            sessionId: 's-1',
            agentId: 'agent-1',
            workspaceId: 'ws-1',
            title: 'Hello',
            historyRevision: '1000',
          },
        ],
        messages: [
          {
            messageId: 'm-1',
            revision: '1001',
            role: 'user',
            status: 'success',
            parts: [{ kind: 'text', text: big, external: true }],
          },
        ],
      },
    })

    // The honest read returns the exact bytes the ref's digest covers.
    const honest = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{ parts: Array<{ content: string }> }>
    }
    expect(honest.messages[0]!.parts[0]!.content).toBe(big)

    // Tamper with the served bytes: the digest no longer matches, so the
    // aggregation must fail rather than hand back unverified text.
    rig.fake.tamperContent('m-1:0', '1001')
    await expect(rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })).rejects.toThrow(
      /sha256|digest|integrity/i,
    )
  })

  it('⑤ cherry_read and cherry_events ensure the session subscription on first use and ack after delivery', async () => {
    const rig = await makeRig({
      agent: {
        agents: [{ agentId: 'agent-1', name: 'Agent One' }],
        sessions: [
          {
            sessionId: 's-1',
            agentId: 'agent-1',
            workspaceId: 'ws-1',
            title: 'Hello',
            historyRevision: '1000',
          },
        ],
        messages: [],
      },
    })

    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    // First use of the session established a subscription (spec §3.5).
    expect(rig.fake.subscribeCalls.map((call) => call.sessionId)).toEqual(['s-1'])

    // A second call in the SAME session reuses the live subscription rather
    // than re-subscribing (same LRU pool).
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(rig.fake.subscribeCalls).toHaveLength(1)

    // Events: delivered from the cache, then acked with the ADVANCED cursor.
    // The subscription is active by now (`active` only after activate/install),
    // so the pushed event reaches the peer's pump.
    await waitFor(() => rig.fake.subscriptions.some((entry) => entry.sessionId === 's-1'))
    rig.fake.pushEvent('s-1', { kind: 'execution.updated', payload: { executionId: 'e1' } })
    await sleep(20)

    const events = (await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })) as {
      events: Array<{ kind: string }>
      nextCursor: { seq: string }
    }
    expect(events.events.map((event) => event.kind)).toEqual(['execution.updated'])
    expect(events.nextCursor.seq).toBe('1')

    await waitFor(() => rig.fake.ackCalls.length === 1, 3_000, 'the ack')
    expect(rig.fake.ackCalls[0]!.cursor.seq).toBe('1')
    expect(rig.fake.ackCalls[0]!.subscriptionId).toBe(rig.fake.subscribeCalls[0]!.subscriptionId)
  })

  it('⑤b cherry_events returns the structured cursor-out-of-window verdict with the window start', async () => {
    const rig = await makeRig({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
        ],
        messages: [],
      },
    })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    await waitFor(() => rig.fake.subscriptions.some((entry) => entry.sessionId === 's-1'))
    rig.fake.pushEvent('s-1', { kind: 'execution.updated', payload: { executionId: 'e1' } })
    await sleep(20)

    // The window start is the checkpoint cursor (seq 0); its own position is NOT
    // servable, so it is exactly the boundary the structured error reports.
    const result = (await rig.call('cherry_events', {
      device: 'dev-A',
      sessionId: 's-1',
      cursor: { sessionId: 's-1', streamEpoch: 'epoch-1', seq: '0' },
    })) as { error: string; windowStart?: { seq: string } }
    expect(result.error).toBe('cursor-out-of-window')
    expect(result.windowStart?.seq).toBe('0')
  })

  it('⑥ device resolution: an ambiguous display name returns structured candidates, not an error', async () => {
    const rig = await makeRig(
      {},
      { extraDevices: [{ deviceId: 'dev-A2', displayName: 'Desk Alpha Two' }] },
    )

    const result = (await rig.call('cherry_devices', { device: 'Desk' })) as {
      error?: string
      candidates?: string[]
    }
    expect(result.error).toBe('ambiguous-device')
    expect(result.candidates).toEqual(['Desk Alpha', 'Desk Alpha Two'])
    // No RPC was attempted for an unresolved device.
    expect(rig.fake.readCalls).toHaveLength(0)

    // The same verdict is IN BAND for every read tool (ruling ⑤): the caller
    // gets candidates rather than an opaque throw it cannot act on.
    for (const name of ['cherry_agents', 'cherry_sessions', 'cherry_workspaces', 'cherry_read', 'cherry_events']) {
      const args: Record<string, unknown> = { device: 'Desk' }
      if (name === 'cherry_workspaces') args['agentId'] = 'agent-1'
      if (name === 'cherry_read' || name === 'cherry_events') args['sessionId'] = 's-1'
      const verdict = (await rig.call(name, args)) as { error?: string; candidates?: string[] }
      expect(verdict.error, name).toBe('ambiguous-device')
      expect(verdict.candidates, name).toEqual(['Desk Alpha', 'Desk Alpha Two'])
    }
  })

  it('⑥b an offline device answers the structured {device, state} error and never dials', async () => {
    const rig = await makeRig({}, { skipConnect: true })
    expect(rig.tool('cherry_agents')).toBeDefined()

    // The §6 verdict rides out as the established structured error; the tool
    // never dials implicitly, so the peer saw no connection attempt.
    const error = await rig.call('cherry_agents', { device: 'dev-A' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(DeviceUnavailableError)
    expect(error).toMatchObject({ device: 'dev-A', state: 'offline' })
    expect(rig.fake.socketCount).toBe(0)
  })

  it('⑦a a REVISION_EXPIRED on the baseline re-pulls sessions.get → messages.list and retries the whole round once', async () => {
    const rig = await makeRig({
      agent: {
        agents: [{ agentId: 'agent-1', name: 'Agent One' }],
        sessions: [
          {
            sessionId: 's-1',
            agentId: 'agent-1',
            workspaceId: 'ws-1',
            title: 'Hello',
            historyRevision: '1000',
          },
        ],
        messages: [
          {
            messageId: 'm-1',
            revision: '1001',
            role: 'user',
            status: 'success',
            parts: [{ kind: 'text', text: 'first round' }],
          },
        ],
        // The FIRST messages.list fails with a stale revision; the retry's
        // fresh baseline succeeds.
        failNext: { 'agent.messages.list': { reason: 'REVISION_EXPIRED', message: 'History revision expired' } },
      },
    })

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{ parts: Array<{ content: string }> }>
    }
    expect(result.messages[0]!.parts[0]!.content).toBe('first round')

    // The whole round was retried: sessions.get ran again to re-pull the
    // baseline before the second messages.list.
    const sequence = rig.fake.agentCallSequence.filter(
      (method) => method === 'agent.sessions.get' || method === 'agent.messages.list',
    )
    expect(sequence).toEqual([
      'agent.sessions.get',
      'agent.messages.list',
      'agent.sessions.get',
      'agent.messages.list',
    ])

    // The recovery is observable, not silent.
    expect(consoleWarn.mock.calls.some((call) => String(call[0]).includes('revision expired'))).toBe(true)
  })

  it('⑦b two consecutive REVISION_EXPIRED failures pass the error through unchanged', async () => {
    const rig = await makeRig({
      agent: {
        agents: [{ agentId: 'agent-1', name: 'Agent One' }],
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
        ],
        messages: [],
        failAlways: { 'agent.messages.list': { reason: 'REVISION_EXPIRED', message: 'History revision expired' } },
      },
    })

    const error = await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as { data?: { reason?: string } }).data?.reason).toBe('REVISION_EXPIRED')

    // EXACTLY one retry — the second failure is surfaced, never retried again.
    const messageCalls = rig.fake.readCallsFor('agent.messages.list')
    expect(messageCalls).toHaveLength(2)
  })
})

describe('read-only cherry tools: registration framework', () => {
  it('registers exactly the six read-only tools this task owns', async () => {
    const rig = await makeRig()
    expect(rig.ctx.definitions.map((definition) => definition.name)).toEqual(READ_TOOL_NAMES)
  })

  it('every registered definition is a well-formed literal-JSON-Schema tool', async () => {
    const rig = await makeRig()
    for (const definition of rig.ctx.definitions) {
      expect(typeof definition.description).toBe('string')
      expect(definition.description.length).toBeGreaterThan(0)
      expect(definition.parameters.type).toBe('object')
      expect(definition.parameters.additionalProperties).toBe(false)
      expect(typeof definition.execute).toBe('function')
      expect(Array.isArray(definition.output.render({}, {}))).toBe(true)
    }
  })
})
