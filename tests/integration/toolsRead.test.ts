import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import {
  INTERACTIONS_LIST_PAGE_CLAMP,
  LIST_PAGE_CLAMP,
  PARTS_LIST_PAGE_CLAMP,
} from '../../src/defaults.js'
import { DeviceConnection, DeviceUnavailableError } from '../../src/connection.js'
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
  /** Local policy knobs (e.g. a low parts circuit-breaker) for the engine. */
  engine?: CherryToolEngineOptions
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
    evict: () => {
      throw new Error('the read-only suite never evicts')
    },
  }
  registerCherryTools(ctx, deps, rigOptions.engine ?? {})

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

  it('②a cherry_agents aggregates ten 16-item pages into the 150-item aggregate, clamping each page to the byte-safe page budget', async () => {
    // The peer holds 150 agents. A per-page limit of `pageItems` (100) would
    // ask for a page whose serialized record can exceed the transport's 64 KiB
    // record budget, so every page is ALSO clamped to LIST_PAGE_CLAMP (16) —
    // the aggregate is then built from ten real pages.
    const agents = Array.from({ length: 150 }, (_unused, index) => ({
      agentId: `agent-${String(index).padStart(3, '0')}`,
      name: `Agent ${index}`,
    }))
    const rig = await makeRig({ agent: { agents } })

    const result = (await rig.call('cherry_agents', { device: 'dev-A', limit: 150 })) as {
      items: Array<{ agentId: string }>
    }
    expect(result.items).toHaveLength(150)
    expect(result.items[0]!.agentId).toBe('agent-000')
    expect(result.items[149]!.agentId).toBe('agent-149')

    // Ten pages were requested, and EVERY per-page limit respects BOTH caps —
    // the negotiated pageItems AND the byte-safe clamp.
    const calls = rig.fake.readCallsFor('agent.agents.list')
    expect(calls).toHaveLength(10)
    for (const call of calls) {
      expect(call['limit'] as number).toBeLessThanOrEqual(PAGE_ITEMS)
      expect(call['limit'] as number).toBeLessThanOrEqual(LIST_PAGE_CLAMP)
    }
    // Page 1 carries no cursor; later pages carry the numeric offsets.
    expect(calls[0]!['cursor']).toBeUndefined()
    expect(calls[1]!['cursor']).toBe('16')
    expect(calls[2]!['cursor']).toBe('32')
  })

  it('②c a negotiated pageItems smaller than the byte-safe clamp still binds every page', async () => {
    // The effective page size is min(negotiated, clamp): a peer that already
    // pages smaller keeps ITS size — the byte-safe clamp never widens a page.
    const agents = Array.from({ length: 10 }, (_unused, index) => ({
      agentId: `agent-${index}`,
      name: `Agent ${index}`,
    }))
    const rig = await makeRig({ hello: { limits: { pageItems: 2 } }, agent: { agents } })

    const result = (await rig.call('cherry_agents', { device: 'dev-A', limit: 10 })) as {
      items: Array<{ agentId: string }>
    }
    expect(result.items).toHaveLength(10)
    const calls = rig.fake.readCallsFor('agent.agents.list')
    expect(calls).toHaveLength(5)
    for (const call of calls) expect(call['limit'] as number).toBeLessThanOrEqual(2)
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
    // The byte-safe page clamp (16) splits the 60-item aggregate into
    // 16+16+16+12; the LAST page asks only for what remains of the aggregate.
    expect(calls).toHaveLength(4)
    expect(calls[0]!['limit']).toBe(LIST_PAGE_CLAMP)
    expect(calls[3]!['limit']).toBe(12)
  })

  it('②b2 attributes a stop that lands on the safety bound to the BOUND, not to the caller limit', async () => {
    // `limit: 1000` is BOTH the caller's maximum and the internal safety bound,
    // so the two ceilings are EQUAL here. The old comparison (`aggregate <=
    // bound ? 'limit' : 'safety-bound'`) called that 'limit' — telling the caller
    // "you asked for 1000" about a walk that was actually stopped by the plugin's
    // own circuit-breaker. The same code path serves `limit: Infinity`, so a
    // wrong equal-case label is also a wrong unbounded-walk label.
    const agents = Array.from({ length: 1_500 }, (_unused, index) => ({
      agentId: `agent-${index}`,
      name: `Agent ${index}`,
    }))
    const rig = await makeRig({ agent: { agents } })

    const result = (await rig.call('cherry_agents', { device: 'dev-A', limit: 1000 })) as {
      items: Array<{ agentId: string }>
      truncated?: boolean
      truncationReason?: string
      nextCursor?: string
    }

    expect(result.items).toHaveLength(1000)
    expect(result.truncated).toBe(true)
    // THE ATTRIBUTION: the equality case belongs to the safety bound.
    expect(result.truncationReason).toBe('safety-bound')
    // The peer still had data, and the resume point is reported.
    expect(result.nextCursor).toBeDefined()
  })

  it('②b3 still attributes a stop STRICTLY below the safety bound to the caller limit', async () => {
    // The other half of the rule: a caller limit that really is the constraint
    // must still say so, or the fix above would have moved the mislabel.
    const agents = Array.from({ length: 150 }, (_unused, index) => ({
      agentId: `agent-${index}`,
      name: `Agent ${index}`,
    }))
    const rig = await makeRig({ agent: { agents } })

    const result = (await rig.call('cherry_agents', { device: 'dev-A', limit: 60 })) as {
      items: Array<{ agentId: string }>
      truncationReason?: string
    }
    expect(result.items).toHaveLength(60)
    expect(result.truncationReason).toBe('limit')
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

  it('④c cherry_read paginates a message\'s parts to COMPLETION across byte-safe pages', async () => {
    // 60 parts on one message, and the peer would happily page at 20. A
    // part walk bounded by the plugin's own tool-limit constant would drop a
    // third of the snapshot while claiming completion, so every part must
    // arrive and the result must NOT advertise truncation — while every page
    // request stays at or below PARTS_LIST_PAGE_CLAMP, the strict-worst-case
    // count of fat inline parts that fits one 64 KiB wire record.
    const parts = Array.from({ length: 60 }, (_unused, index) => ({
      kind: 'text' as const,
      text: `part-${index}`,
    }))
    const rig = await makeRig({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
        ],
        messages: [{ messageId: 'm-1', revision: '1001', role: 'user', status: 'success', parts }],
        maxPageSize: 20,
      },
    })

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{ parts: Array<{ content: string }>; partsTruncated?: string }>
    }
    // EVERY part arrives, in order, with no silent loss.
    expect(result.messages[0]!.parts).toHaveLength(60)
    expect(result.messages[0]!.parts.map((part) => part.content)).toEqual(
      parts.map((_part, index) => `part-${index}`),
    )
    // The message is complete, so nothing claims otherwise.
    expect(result.messages[0]!.partsTruncated).toBeUndefined()

    const calls = rig.fake.readCallsFor('agent.parts.list')
    expect(calls).toHaveLength(20)
    for (const call of calls) expect(call['limit'] as number).toBeLessThanOrEqual(PARTS_LIST_PAGE_CLAMP)
    expect(calls[0]!['cursor']).toBeUndefined()
    expect(calls[1]!['cursor']).toBe(String(PARTS_LIST_PAGE_CLAMP))
    expect(calls[2]!['cursor']).toBe(String(PARTS_LIST_PAGE_CLAMP * 2))
  })

  it('④d a tripped parts circuit-breaker is SURFACED with a resume cursor, never silently truncated', async () => {
    // The peer keeps serving pages; the plugin's safety bound is the only thing
    // that can stop the walk. Tripping it must be visible in the result — the
    // failure mode this replaces was a silent, wrongly-labelled truncation.
    const parts = Array.from({ length: 60 }, (_unused, index) => ({
      kind: 'text' as const,
      text: `part-${index}`,
    }))
    const rig = await makeRig(
      {
        agent: {
          sessions: [
            { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
          ],
          messages: [{ messageId: 'm-1', revision: '1001', role: 'user', status: 'success', parts }],
          maxPageSize: 20,
        },
      },
      // Drive the breaker low enough to trip on the second page.
      { engine: { partsSafetyBound: 25 } },
    )

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{ parts: Array<{ content: string }>; partsTruncated?: string; partsResumeCursor?: string }>
    }

    // The partial read is ADMITTED: the reason and the resume point are both
    // present, so content is never dropped without the caller knowing.
    expect(result.messages[0]!.parts).toHaveLength(25)
    expect(result.messages[0]!.partsTruncated).toBe('safety-bound')
    // The resume cursor is the peer's next-page offset, i.e. the 26th part —
    // exactly where the walk stopped, not where its last page began.
    expect(result.messages[0]!.partsResumeCursor).toBe('25')
    // It stopped at the breaker, not at the peer's end of data (which would
    // take ceil(60 / PARTS_LIST_PAGE_CLAMP) = 20 pages at the byte-safe size).
    expect(rig.fake.readCallsFor('agent.parts.list').length).toBe(9)
  })

  it('④m the byte-safe page clamps are derived from the 64 KiB record budget', async () => {
    // WIRE MATH (see src/defaults.ts): every JSON-RPC record is capped at
    // 65,536 bytes and the peer may inline up to 4,096 CHARACTERS of part
    // text (strict UTF-8 worst case 4 B/char — astral planes) plus envelope,
    // so at most floor((65,536 − 2,048 margin) / 16.9 KiB) = 3 parts fit one
    // record; an interaction record also carries a 2,048-character summary
    // (~25.1 KiB worst case), leaving room for 2. These are derived at the
    // strict per-character worst case, not tuned — pinning them here keeps a
    // silent re-tune from reintroducing the "JSON-RPC channel closed" class
    // of failure.
    expect(PARTS_LIST_PAGE_CLAMP).toBe(3)
    expect(INTERACTIONS_LIST_PAGE_CLAMP).toBe(2)
    expect(LIST_PAGE_CLAMP).toBe(16)

    // The messages walk rides the list clamp too: 40 messages paginate as
    // 16+16+8, and every parts page of every projected message stays at or
    // below the parts clamp.
    const messages = Array.from({ length: 40 }, (_unused, index) => ({
      messageId: `m-${index}`,
      revision: `100${index}`,
      role: 'user' as const,
      status: 'success' as const,
      parts: [{ kind: 'text' as const, text: `t-${index}` }],
    }))
    const rig = await makeRig({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
        ],
        messages,
      },
    })

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: unknown[]
    }
    expect(result.messages).toHaveLength(40)

    const messageCalls = rig.fake.readCallsFor('agent.messages.list')
    expect(messageCalls).toHaveLength(3)
    for (const call of messageCalls) expect(call['limit'] as number).toBeLessThanOrEqual(LIST_PAGE_CLAMP)
    expect(messageCalls[2]!['limit']).toBe(LIST_PAGE_CLAMP)
    for (const call of rig.fake.readCallsFor('agent.parts.list')) {
      expect(call['limit'] as number).toBeLessThanOrEqual(PARTS_LIST_PAGE_CLAMP)
    }
  })

  it('④e a {ref} whose content walk cannot reach eof fails rather than returning a partial value', async () => {
    // A ref that under-declares its byteLength derives too small a slice budget,
    // so the walk cannot reach `eof`. A partial (unverifiable) content must be a
    // hard failure, never a silently short aggregation.
    const rig = await makeRig({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
        ],
        messages: [
          {
            messageId: 'm-1',
            revision: '1001',
            role: 'user',
            status: 'success',
            parts: [{ kind: 'text', text: 'D'.repeat(30 * 1024), external: true }],
          },
        ],
      },
    })
    // Shrink the declared length so one slice can never cover the content.
    rig.fake.understateContentLength('m-1:0', '1001', 1)

    await expect(rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })).rejects.toThrow(
      /did not reach eof|partial content/i,
    )
  })

  it(
    '④f cherry_read reads MORE than a page-cap\'s worth of parts (>1000) without truncating',
    async () => {
      // DISCRIMINATOR for the parts bound: 1001 parts exceeds any plausible
      // single-page or tool-limit constant, so a walk still bounded by one stops
      // short and says so. Parts are tiny; the byte-safe page clamp (3/page)
      // makes this a 334-page walk, so the test takes a few seconds.
      const PARTS = 1001
      const parts = Array.from({ length: PARTS }, (_unused, index) => ({
        kind: 'text' as const,
        text: `p${index}`,
      }))
      const rig = await makeRig({
        agent: {
          sessions: [
            { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
          ],
          messages: [{ messageId: 'm-1', revision: '1001', role: 'user', status: 'success', parts }],
          maxPageSize: 100,
        },
      })

      const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
        messages: Array<{ parts: Array<{ content: string }>; partsTruncated?: string }>
      }

      // All 1001 arrive, the last one included, and nothing claims truncation.
      expect(result.messages[0]!.parts).toHaveLength(PARTS)
      expect(result.messages[0]!.parts[PARTS - 1]!.content).toBe(`p${PARTS - 1}`)
      expect(result.messages[0]!.partsTruncated).toBeUndefined()

      // 334 pages of 3 (the last holds the two leftover parts).
      const calls = rig.fake.readCallsFor('agent.parts.list')
      expect(calls).toHaveLength(334)
      expect(calls[333]!['cursor']).toBe('999')
      for (const call of calls) {
        expect(call['limit'] as number).toBeLessThanOrEqual(PARTS_LIST_PAGE_CLAMP)
      }
    },
    30_000,
  )

  it('④g an empty page with a dangling nextCursor is a peer fault, refused instead of spun on', async () => {
    // A walk bounded only by item count can never finish here: the item count
    // never grows. The read must FAIL rather than spin or return an empty
    // snapshot as though it were complete. The knob answers the SAME cursor
    // ('0') every time, so the refusal now comes from the cursor-advance guard:
    // the FIRST empty page is tolerated (issue #11 — the desktop's legal
    // pin→entity transition), and the empty-RUN bound is pinned separately in
    // `toolsListWalkCompat.test.ts`.
    const rig = await makeRig({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
        ],
        messages: [{ messageId: 'm-1', revision: '1001', role: 'user', status: 'success', parts: [] }],
        emptyPagesWithDanglingCursor: '0',
      },
    })

    await expect(rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })).rejects.toThrow(
      /empty page|no progress|did not advance/i,
    )
    // It gave up quickly instead of hammering the peer.
    expect(rig.fake.readCallsFor('agent.parts.list').length).toBeLessThan(5)
  })

  it('④h a cursor that never advances is a peer fault, refused instead of spun on', async () => {
    // The same no-progress class reached through NON-EMPTY pages: every page
    // carries real items but always advertises the same stuck cursor, so an
    // item ceiling is again never reached. This is the fault the empty-page
    // guard does NOT cover, so it pins the cursor-advance guard on its own.
    const parts = Array.from({ length: 10 }, (_unused, index) => ({
      kind: 'text' as const,
      text: `stuck-${index}`,
    }))
    const rig = await makeRig({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
        ],
        messages: [{ messageId: 'm-1', revision: '1001', role: 'user', status: 'success', parts }],
        maxPageSize: 5,
        stuckCursor: '5',
      },
    })

    await expect(rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })).rejects.toThrow(
      /did not advance its cursor/i,
    )
    // It stopped as soon as the cursor repeated rather than looping.
    expect(rig.fake.readCallsFor('agent.parts.list').length).toBeLessThan(5)
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

  it('④i ONE unreadable {ref} degrades to a marked part instead of failing the whole read', async () => {
    // A snapshot is a page of history, not a single object: one part the peer
    // refuses to serve (an expired content pin, a transient fault) must not
    // cost the caller every OTHER message in the same read. The part stays in
    // the result, marked unavailable, so the loss is visible rather than
    // silent — and the message it belongs to survives.
    const big = 'D'.repeat(30 * 1024)
    const rig = await makeRig({
      agent: {
        agents: [{ agentId: 'agent-1', name: 'Agent One' }],
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
        ],
        messages: [
          {
            messageId: 'm-1',
            revision: '1001',
            role: 'user',
            status: 'success',
            parts: [{ kind: 'text', text: 'inline before' }, { kind: 'text', text: big, external: true }],
          },
          {
            messageId: 'm-2',
            revision: '1002',
            role: 'assistant',
            status: 'success',
            parts: [{ kind: 'text', text: 'later message survives' }],
          },
        ],
      },
    })

    // The FIRST content.read is the only one that fails (one-shot injection):
    // exactly one part's walk breaks.
    rig.fake.setReadFailure('agent.content.read', { reason: 'NOT_FOUND', message: 'Content not found' })

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{
        messageId: string
        parts: Array<{ partId: string; content: string; unavailable?: string }>
      }>
    }

    // BOTH messages are present — the read did not fail wholesale.
    expect(result.messages.map((message) => message.messageId)).toEqual(['m-1', 'm-2'])
    // The healthy inline part and the OTHER message are untouched.
    expect(result.messages[0]!.parts[0]!.content).toBe('inline before')
    expect(result.messages[1]!.parts[0]!.content).toBe('later message survives')
    // The unreadable part is still listed, with its content withheld and the
    // reason surfaced.
    const broken = result.messages[0]!.parts[1]!
    expect(broken.partId).toBe('m-1:1')
    expect(broken.content).toBe('')
    expect(broken.unavailable).toMatch(/NOT_FOUND|Content not found/i)
    // ...and the message is COMPLETE as a part list: the failure was the
    // CONTENT, not a truncated walk, so it must not claim truncation.
    expect(result.messages[0]).not.toHaveProperty('partsTruncated')
  })

  it('④j an INTEGRITY failure still fails the whole read: unverifiable bytes are never handed back', async () => {
    // The boundary of ④i. A read the peer ANSWERED but whose digest does not
    // match is a different class: the bytes on hand are provably not the ones
    // the ref describes, so degrading would be reporting corrupt content as a
    // partial success. That case must keep failing loudly.
    const big = 'E'.repeat(30 * 1024)
    const rig = await makeRig({
      agent: {
        agents: [{ agentId: 'agent-1', name: 'Agent One' }],
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
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

    // The honest read FIRST, so the content pin exists to be tampered with (and
    // so the failure below is provably caused by the tampering).
    const honest = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{ parts: Array<{ content: string; unavailable?: string }> }>
    }
    expect(honest.messages[0]!.parts[0]!.content).toBe(big)
    expect(honest.messages[0]!.parts[0]!.unavailable).toBeUndefined()

    rig.fake.tamperContent('m-1:0', '1001')
    await expect(rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })).rejects.toThrow(
      /sha256|digest|integrity/i,
    )
  })

  it('④k a `file` part is reported as METADATA and never fetched (the 2.1.5+ attachment projection)', async () => {
    // Cherry 2.1.5 started projecting an uploaded attachment as
    // `{kind: 'file', name, ref}` — the ref at the TOP level, no `content` —
    // and made those bytes servable through `agent.content.read` (the file
    // module's revision-bound reference). They are FILE bytes: a read here is a
    // TEXT channel into a model's context, so the part must cost no content
    // round trip at all, not merely decode badly.
    const fileBytes = '\u0000\u0001binary-ish payload'
    const rig = await makeRig({
      agent: {
        agents: [{ agentId: 'agent-1', name: 'Agent One' }],
        sessions: [
          {
            sessionId: 's-1',
            agentId: 'agent-1',
            workspaceId: 'ws-1',
            title: 'Attachments',
            historyRevision: '1000',
          },
        ],
        messages: [
          {
            messageId: 'm-1',
            revision: '1001',
            role: 'user',
            status: 'success',
            parts: [
              { kind: 'text', text: 'look at this' },
              { kind: 'file', text: fileBytes, name: 'photo.png', mediaType: 'image/png' },
            ],
          },
        ],
      },
    })

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{
        parts: Array<{ kind: string; content: string; name?: string; mediaType?: string; byteLength?: string }>
      }>
    }
    const parts = result.messages[0]!.parts
    expect(parts[1]).toMatchObject({
      kind: 'file',
      content: '',
      name: 'photo.png',
      mediaType: 'image/png',
      byteLength: String(Buffer.byteLength(fileBytes)),
    })
    // No `unavailable`: nothing FAILED here — the bytes were deliberately not
    // requested, which is a different statement from "the peer would not serve
    // them", and conflating the two would send a caller hunting a fault.
    expect(parts[1]).not.toHaveProperty('unavailable')
    // THE DISCRIMINATOR. The peer really could serve these bytes (same
    // mechanism as any `{ref}`, verified below), so a regression that resolved
    // the file ref as text would succeed on the wire and fail only HERE.
    expect(rig.fake.methodCount('agent.content.read')).toBe(0)
    expect(parts[0]!.content).toBe('look at this')
  })

  it('④l the pre-2.1.5 `data`-kind file projection reports the same metadata, so an upgrade never anonymizes an attachment', async () => {
    // Cherry 2.1.4 (inside the verified range) projected the same file as a
    // `data` part carrying `{mediaType, filename}` INSIDE `content`. The two
    // generations must reach the caller in the same shape, or a desktop upgrade
    // would silently turn a named attachment back into an empty part.
    const rig = await makeRig({
      agent: {
        agents: [{ agentId: 'agent-1', name: 'Agent One' }],
        sessions: [
          {
            sessionId: 's-1',
            agentId: 'agent-1',
            workspaceId: 'ws-1',
            title: 'Attachments',
            historyRevision: '1000',
          },
        ],
        messages: [
          {
            messageId: 'm-1',
            revision: '1001',
            role: 'user',
            status: 'success',
            parts: [
              { kind: 'data', text: '', name: 'report.pdf', mediaType: 'application/pdf' },
              { kind: 'data', text: '', mediaType: 'image/jpeg' }, // filename: null — the peer's explicit "no name"
            ],
          },
        ],
      },
    })

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{ parts: Array<{ kind: string; content: string; name?: string; mediaType?: string }> }>
    }
    const parts = result.messages[0]!.parts
    expect(parts[0]).toMatchObject({ kind: 'data', content: '', name: 'report.pdf', mediaType: 'application/pdf' })
    // A null filename stays ABSENT rather than becoming the string "null", and
    // a media type the peer did not state stays absent too.
    expect(parts[1]!).toMatchObject({ kind: 'data', content: '', mediaType: 'image/jpeg' })
    expect(parts[1]!).not.toHaveProperty('name')
    expect(rig.fake.methodCount('agent.content.read')).toBe(0)
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

  it('⑤b cherry_events serves the BASELINE and still answers the structured verdict below it', async () => {
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

    // The window start is the checkpoint cursor (seq 0). Issue #2 reversed the
    // verdict AT it: nothing was dropped, and it is the cursor the other tools
    // hand out, so it is SERVABLE and delivers the event newer than it. Before
    // the fix this call answered `cursor-out-of-window`, which is what made a
    // caller unable to follow the cursor it had just been given.
    const atBaseline = (await rig.call('cherry_events', {
      device: 'dev-A',
      sessionId: 's-1',
      cursor: { sessionId: 's-1', streamEpoch: 'epoch-1', seq: '0' },
    })) as { events?: Array<{ kind: string }>; nextCursor?: { seq: string }; error?: string }
    expect(atBaseline.error).toBeUndefined()
    expect(atBaseline.events?.map((event) => event.kind)).toEqual(['execution.updated'])
    expect(atBaseline.nextCursor?.seq).toBe('1')

    // STRICTLY BELOW the window start the structured verdict still stands, and
    // it still reports the boundary as the earliest resumable position.
    const below = (await rig.call('cherry_events', {
      device: 'dev-A',
      sessionId: 's-1',
      cursor: { sessionId: 's-1', streamEpoch: 'epoch-1', seq: '-1' },
    })) as { error: string; windowStart?: { seq: string } }
    expect(below.error).toBe('cursor-out-of-window')
    expect(below.windowStart?.seq).toBe('0')
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
  it('registers exactly the six read-only tools this task owns, ahead of the rest of the family', async () => {
    const rig = await makeRig()
    // Task 9 appends six INTERACTIVE tools and Task 10 two MANAGEMENT tools to
    // the same registry, so this task's claim is about the read-only PREFIX it
    // owns — its order and its exact membership — not about being the whole
    // registry. The full 14-tool set assertion belongs to Task 10④.
    expect(rig.ctx.definitions.slice(0, READ_TOOL_NAMES.length).map((definition) => definition.name)).toEqual(
      READ_TOOL_NAMES,
    )
    const trailing = rig.ctx.definitions.slice(READ_TOOL_NAMES.length).map((definition) => definition.name)
    expect(trailing).toEqual([
      'cherry_create',
      'cherry_send',
      'cherry_wait',
      'cherry_interactions',
      'cherry_respond',
      'cherry_cancel',
      'cherry_pair',
      'cherry_unpair',
    ])
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
