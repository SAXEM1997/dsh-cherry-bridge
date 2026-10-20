import { createHash } from 'node:crypto'
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
  /** Dial a seeded device explicitly (makeRig only dials dev-A by default). */
  connectDevice(deviceId: string): Promise<void>
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
    connectDevice: async (deviceId) => {
      await connect(deviceId).connect()
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
      resumeCursor?: string
      nextCursor?: string
    }

    expect(result.items).toHaveLength(1000)
    expect(result.truncated).toBe(true)
    // THE ATTRIBUTION: the equality case belongs to the safety bound.
    expect(result.truncationReason).toBe('safety-bound')
    // The peer still had data, and the resume TOKEN is reported (issue #65:
    // the raw peer position never leaves the tool).
    expect(result.resumeCursor).toMatch(/^list:/)
    expect(result.nextCursor).toBeUndefined()
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
    expect(result.messages[0]).not.toHaveProperty('incomplete')

    const calls = rig.fake.readCallsFor('agent.parts.list')
    expect(calls).toHaveLength(20)
    for (const call of calls) expect(call['limit'] as number).toBeLessThanOrEqual(PARTS_LIST_PAGE_CLAMP)
    expect(calls[0]!['cursor']).toBeUndefined()
    expect(calls[1]!['cursor']).toBe(String(PARTS_LIST_PAGE_CLAMP))
    expect(calls[2]!['cursor']).toBe(String(PARTS_LIST_PAGE_CLAMP * 2))
  })

  it('④d a tripped parts circuit-breaker is SURFACED with a stop-point cursor, never silently truncated', async () => {
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
      messages: Array<{
        parts: Array<{ content: string }>
        partsTruncated?: string
        partsResumeCursor?: string
        incomplete?: true
        unavailableParts?: number
      }>
    }

    // The partial read is ADMITTED: the reason and the resume point are both
    // present, so content is never dropped without the caller knowing.
    expect(result.messages[0]!.parts).toHaveLength(25)
    expect(result.messages[0]!.partsTruncated).toBe('safety-bound')
    // A short part list is content-incomplete too, and `incomplete` is the
    // message-level answer to that question — but NO part failed here, so the
    // count must be ABSENT rather than a misleading zero (issue #14: the two
    // triggers are distinct, and only one of them is countable).
    expect(result.messages[0]!.incomplete).toBe(true)
    expect(result.messages[0]).not.toHaveProperty('unavailableParts')
    // The stop-point cursor is the peer's next-page offset, i.e. the 26th part —
    // exactly where the walk stopped, not where its last page began. It is a
    // marker, not an input — no caller argument raises the parts breaker.
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

  it('④s cherry_read pins the message STOP POINT: a truncated walk carries messagesResumeCursor, a complete one does not', async () => {
    // ISSUE #36: `messagesResumeCursor` is a STOP-POINT MARKER, and nothing
    // pinned that this face emits it at all. (ISSUE #26 made it an INPUT too —
    // `cherry_read` now also takes `messagesResumeCursor`, and the value is the
    // prefixed token form asserted below — but this test's subject is the two
    // EDGES: a truncated walk carries one, a complete walk carries none. Both
    // are asserted here so neither can move silently: DROPPING the projection
    // (`#readOnce`, the `messagesResumeCursor` spread) goes red on (a); a walk
    // that stopped complete must carry no field at all — (b) is red on any
    // projection that leaks the stop point into a complete result, and it is
    // the pin that would catch a wider `truncated` verdict on the read face.
    //
    // PEER SHAPE MATTERS. Two things were verified empirically before settling
    // on this fixture: (1) with the default 100-item peer cap the walk always
    // ends on the peer's LAST page, so `truncated` is false whatever the item
    // count; (2) `#aggregate` combines its ceiling with the negotiated page cap,
    // so the series a walk actually requests is not a simple page count. The
    // peer here reports `hello.limits.pageItems = 16` and holds 47 messages, so
    // every request is 16 wide except a truncated walk's last one:
    //   (a) `limit: 20` → requests 16 + 4, both served whole, ceiling reached
    //       on the next pass → `truncated`, holding the peer's `nextCursor: 20`
    //   (b) `limit: 47` → requests 16 + 16 + 15, the last page is the peer's
    //       end (`nextCursor: null`) → complete, nothing to mark
    // The exact sequences are asserted on the recorded requests below.
    const messages = Array.from({ length: 47 }, (_unused, index) => ({
      messageId: `m-${index}`,
      revision: `100${index}`,
      role: 'user' as const,
      status: 'success' as const,
      parts: [{ kind: 'text' as const, text: `t-${index}` }],
    }))
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
        ],
        messages,
      },
    })

    // (a) TRUNCATED: `limit: 20` cuts after 16 + 4, and the cursor the walk
    // holds is the peer's offset for that second page — 16 + 4 = 20 (`pageOf`
    // returns `start + limit`, and the walk asks for the remaining 4). It is
    // reported, so both dropping the projection and projecting a different
    // value are red.
    const truncated = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 20 })) as {
      messages: Array<{ messageId: string }>
      truncated: boolean
      truncationReason?: string
      messagesResumeCursor?: string
    }
    expect(truncated.truncated).toBe(true)
    expect(truncated.truncationReason).toBe('limit')
    expect(truncated.messages).toHaveLength(20)
    // The walk really paged: 16 then the remaining 4.
    const messageCalls = rig.fake.readCallsFor('agent.messages.list')
    expect(messageCalls).toHaveLength(2)
    expect(messageCalls[0]!['limit']).toBe(LIST_PAGE_CLAMP)
    expect(messageCalls[0]!['cursor']).toBeUndefined()
    expect(messageCalls[1]!['cursor']).toBe(String(LIST_PAGE_CLAMP))
    expect(messageCalls[1]!['limit']).toBe(4)
    // ISSUE #26 changed the SHAPE of the stop point: it is a resume INPUT now,
    // so it is self-describing — `cursor:<peer position>`, never the peer's raw
    // position (which no tool accepts, and which the desktop would silently
    // treat as "the newest page" if forwarded).
    expect(truncated.messagesResumeCursor).toBe('cursor:20')
    // The 20 returned are m-0..m-19: it is a stop point, and everything older
    // is simply not here — which is what "raise `limit`" answers.
    expect(truncated.messages[19]!.messageId).toBe('m-19')
    expect(truncated.messages.map((message) => message.messageId)).not.toContain('m-20')

    // (b) COMPLETE: `limit: 47` is exactly the peer's data, so the walk ends on
    // a page whose `nextCursor` is null — pages 16 + 16 + 15 — and the aggregate
    // answers complete. Nothing is unread, so there is no stop point to mark and
    // the field must be ABSENT (not an `undefined`-valued key).
    const complete = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 47 })) as {
      messages: Array<{ messageId: string }>
      truncated: boolean
    }
    expect(complete.truncated).toBe(false)
    expect(complete.messages).toHaveLength(47)
    expect(complete.messages[46]!.messageId).toBe('m-46')
    const completeCalls = rig.fake.readCallsFor('agent.messages.list').slice(2)
    expect(completeCalls.map((call) => call['limit'])).toEqual([LIST_PAGE_CLAMP, LIST_PAGE_CLAMP, 15])
    expect(completeCalls[2]!['cursor']).toBe(String(LIST_PAGE_CLAMP * 2))
    // Both forms: `toHaveProperty` also fails for an explicitly-`undefined`
    // value, and the explicit key check names the field if either ever leaks.
    expect(complete).not.toHaveProperty('messagesResumeCursor')
    expect(Object.hasOwn(complete, 'messagesResumeCursor')).toBe(false)

  })

  it('④d3 BOTH triggers on one message: the circuit-broken walk and an unreadable part coexist', async () => {
    // The two incompleteness triggers are independent, and one message can
    // carry both: its parts walk circuit-breaks (short list) AND one of the
    // retained parts failed its content read. An implementation that suppresses
    // `unavailableParts` (or `incomplete`) when `partsTruncated` is present
    // would leave every existing case green — this is the combination that
    // distinguishes it.
    const big = 'G'.repeat(30 * 1024)
    const parts = Array.from({ length: 30 }, (_unused, index) =>
      index === 3 ? { kind: 'text' as const, text: big, external: true } : { kind: 'text' as const, text: `part-${index}` },
    )
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
      { engine: { partsSafetyBound: 25 } },
    )
    // The ref part (index 3, inside the retained 25) fails its content read.
    rig.fake.setReadFailure('agent.content.read', { reason: 'NOT_FOUND', message: 'Content not found' })

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{
        parts: Array<{ content: string; unavailable?: string }>
        partsTruncated?: string
        incomplete?: true
        unavailableParts?: number
      }>
    }

    const message = result.messages[0]!
    expect(message.partsTruncated).toBe('safety-bound')
    expect(message.parts).toHaveLength(25)
    expect(message.parts[3]!.unavailable).toBe('NOT_FOUND')
    // BOTH verdicts stand together: the walk's short list and the content's
    // unreadable part are different losses, and neither absorbs the other.
    expect(message.incomplete).toBe(true)
    expect(message.unavailableParts).toBe(1)
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
        incomplete?: true
        unavailableParts?: number
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
    // But its CONTENT is incomplete, and the message has to say so: the failed
    // part alone is not enough, because a caller reading the message (or a
    // terminal aggregate's top-level verdict) sees a message that otherwise
    // looks whole, with an empty `content` it could read as "there was no
    // text". Issue #14: a field caller concluded a run was interrupted because
    // of exactly that shape.
    expect(result.messages[0]!.incomplete).toBe(true)
    expect(result.messages[0]!.unavailableParts).toBe(1)
    // The OTHER message lost nothing, so it must carry NEITHER field — the
    // flag is per message, not a page-level weather report.
    expect(result.messages[1]).not.toHaveProperty('incomplete')
    expect(result.messages[1]).not.toHaveProperty('unavailableParts')
  })

  it('④i-2 the SAME message-level flag rides the terminal aggregate: `cherry_send` marks the unreadable-ref message', async () => {
    // The terminal/timeout/idle aggregates share `#projectMessage` with
    // `cherry_read`, so a message that is content-incomplete must be flagged on
    // THAT face too — the field report that produced issue #14 came from a
    // `cherry_send` answer, where the only content signal was an empty part.
    const big = 'G'.repeat(30 * 1024)
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
            role: 'assistant',
            status: 'success',
            parts: [{ kind: 'text', text: 'the conclusion is in the ref' }, { kind: 'text', text: big, external: true }],
          },
          {
            messageId: 'm-2',
            revision: '1002',
            role: 'user',
            status: 'success',
            parts: [{ kind: 'text', text: 'a healthy older message' }],
          },
        ],
      },
    })

    // One-shot: the FIRST content.read fails, which is `m-1`'s ref part.
    rig.fake.setReadFailure('agent.content.read', { reason: 'NOT_FOUND', message: 'Content not found' })

    const idle = (await rig.call('cherry_wait', { device: 'dev-A', sessionId: 's-1' })) as {
      status: string
      messages: Array<{
        messageId: string
        parts: Array<{ content: string; unavailable?: string }>
        incomplete?: true
        unavailableParts?: number
      }>
      messagesTruncated?: boolean
    }

    expect(idle.status).toBe('idle')
    expect(idle.messages.map((message) => message.messageId)).toEqual(['m-1', 'm-2'])
    // The damaged message names its damage at the MESSAGE level...
    expect(idle.messages[0]!.incomplete).toBe(true)
    expect(idle.messages[0]!.unavailableParts).toBe(1)
    // ...while the part-level reason is still where it always was.
    expect(idle.messages[0]!.parts[1]!.unavailable).toMatch(/NOT_FOUND|Content not found/i)
    // The walk itself was complete: this is a CONTENT verdict, not a walk one.
    expect(idle.messagesTruncated).toBeUndefined()
    // The healthy message carries neither field.
    expect(idle.messages[1]).not.toHaveProperty('incomplete')
    expect(idle.messages[1]).not.toHaveProperty('unavailableParts')
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

  it('⑥c device resolution: a deviceId prefix resolves on every face, read tools included (issue #13)', async () => {
    const rig = await makeRig({
      agent: {
        agents: [{ agentId: 'agent-1', name: 'Agent One' }],
        sessions: [
          {
            sessionId: 's-1',
            agentId: 'agent-1',
            workspaceId: 'ws-1',
            title: 'Session One',
            historyRevision: '1',
          },
        ],
        messages: [],
      },
    })
    // The field report: a caller abbreviated the id instead of the name.
    const prefix = rig.store.list()[0]!.deviceId.slice(0, 3)
    expect(prefix).toBe('dev')

    const result = (await rig.call('cherry_devices', { device: prefix })) as {
      devices?: Array<{ deviceId: string }>
    }
    expect(result.devices?.map((entry) => entry.deviceId)).toEqual(['dev-A'])

    // The read face accepts the same abbreviation: it resolves to the live
    // connection instead of failing to find a device.
    const read = (await rig.call('cherry_read', { device: prefix, sessionId: 's-1' })) as Record<string, unknown>
    expect(read['error']).toBeUndefined()
    expect(read['messages']).toEqual([])
  })

  it('⑥f device resolution: two devices sharing a prefix still answer ambiguous-device', async () => {
    const rig = await makeRig(
      {},
      { extraDevices: [{ deviceId: 'dev-A2', displayName: 'Desk Alpha Two' }] },
    )

    // An id prefix counting twice must not COLLAPSE into one candidate: two
    // paired devices still match, so the answer keeps both names.
    const result = (await rig.call('cherry_devices', { device: 'dev-' })) as {
      error?: string
      candidates?: string[]
    }
    expect(result.error).toBe('ambiguous-device')
    expect(result.candidates).toEqual(['Desk Alpha', 'Desk Alpha Two'])
  })

  it('⑥d device resolution: a selector matching nothing answers not-found with the known ids', async () => {
    const rig = await makeRig(
      {},
      { extraDevices: [{ deviceId: 'dev-B2', displayName: 'Desk Beta' }] },
    )

    const result = (await rig.call('cherry_devices', { device: 'no-such-device' })) as Record<string, unknown>
    expect(result).toEqual({
      error: 'not-found',
      device: 'no-such-device',
      known: ['dev-A', 'dev-B2'],
    })
    // NOT the pre-#13 shape: ambiguity with an empty candidate list.
    expect(result['candidates']).toBeUndefined()
    expect(rig.fake.readCalls).toHaveLength(0)
  })

  it('⑥e device resolution: a non-cherry_devices tool given an unmatched selector throws', async () => {
    const rig = await makeRig()

    // A tool that cannot proceed without a device does not answer with a
    // verdict OBJECT — its result is consumed as data, and a not-found object
    // would be mistaken for one. It throws, naming the selector and the ids.
    const thrown = await rig
      .call('cherry_agents', { device: 'no-such-device' })
      .then(() => undefined, (error: unknown) => error)
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('no-such-device')
    expect((thrown as Error).message).toContain('dev-A')
    expect(rig.fake.readCalls).toHaveLength(0)
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

  it('④n a cursor CYCLE (A → B → A) is refused on the second visit, not after the page backstop', async () => {
    // The advance guard only sees a cursor that repeats IMMEDIATELY. A TWO-step
    // cycle advances on every step, so without cycle detection this walk spins
    // to MAX_AGGREGATE_PAGES — ~10,000 RPCs against a peer that will never
    // terminate. A ↔ B is also the case the one-item-per-page shape is for: the
    // item ceiling never engages (well, not before the backstop would).
    const rig = await makeRig({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
        ],
        messages: [{ messageId: 'm-1', revision: '1001', role: 'user', status: 'success', parts: [] }],
        maxPageSize: 1,
      },
    })
    rig.fake.scriptListPages('agent.parts.list', [
      { items: [{ partId: 'p-0', revision: 'r', kind: 'text', content: { text: 'a' } }], nextCursor: 'A' },
      { items: [{ partId: 'p-1', revision: 'r', kind: 'text', content: { text: 'b' } }], nextCursor: 'B' },
      { items: [{ partId: 'p-2', revision: 'r', kind: 'text', content: { text: 'c' } }], nextCursor: 'A' },
    ])

    await expect(rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })).rejects.toThrow(
      /cycled back to cursor A/i,
    )
    // Three requests: first page, A, B, and the repeat of A is refused off the
    // page that advertised it. A walk without the set runs to the backstop.
    expect(rig.fake.readCallsFor('agent.parts.list')).toHaveLength(3)
  }, 30_000)

  it('④o a {ref} declaring more than 32 MiB is unavailable on THAT part while the rest of the read succeeds', async () => {
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
            parts: [
              { kind: 'text', text: 'inline survives' },
              { kind: 'text', text: 'Z'.repeat(30 * 1024), external: true },
            ],
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
    // The peer's ref claims 4 GiB. Deriving the slice budget from it would mean
    // ~170,000 content round trips for a part this client will never hold.
    rig.fake.understateContentLength('m-1:1', '1001', 4 * 1024 ** 3)

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{
        messageId: string
        parts: Array<{ partId: string; content: string; unavailable?: string; byteLength?: string }>
      }>
    }

    expect(result.messages.map((message) => message.messageId)).toEqual(['m-1', 'm-2'])
    expect(result.messages[0]!.parts[0]!.content).toBe('inline survives')
    expect(result.messages[1]!.parts[0]!.content).toBe('later message survives')
    const oversized = result.messages[0]!.parts[1]!
    expect(oversized.partId).toBe('m-1:1')
    expect(oversized.content).toBe('')
    expect(oversized.unavailable).toMatch(/33554432|32 ?MiB/i)
    // Not one byte was fetched for it: the cap is a refusal to start, not a
    // budget that runs out mid-walk.
    expect(rig.fake.methodCount('agent.content.read')).toBe(0)
  }, 30_000)

  it('④p a {ref} declaring MORE than the 32 MiB ceiling is refused before its walk even starts', async () => {
    // The first of the ceiling's two arms, isolated from the second: with a
    // HEAP of parts the slice budget is what ends every walk just shy of 32 MiB,
    // and without the declaration check a part declaring 4 GiB would mean ~170,000
    // content round trips before anything could stop it. Nothing is read here at
    // all — the refusal is a decision, not a budget that runs out.
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
            parts: [
              { kind: 'text', text: 'inline survives' },
              { kind: 'text', text: 'Y'.repeat(30 * 1024), external: true },
            ],
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
    rig.fake.understateContentLength('m-1:1', '1001', 4 * 1024 ** 3)
    // A walk that ignored the declaration would be served real slices, which
    // would fail on their own terms rather than on the ceiling's.
    const sliceBytes = Buffer.alloc(4 * 1024, 0x61).toString('base64')
    rig.fake.scriptContentPieces('m-1:1', '1001', 1, () => sliceBytes, '0'.repeat(64))

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{ messageId: string; parts: Array<{ partId: string; content: string; unavailable?: string }> }>
    }

    expect(result.messages[1]!.parts[0]!.content).toBe('later message survives')
    expect(result.messages[0]!.parts[0]!.content).toBe('inline survives')
    const oversized = result.messages[0]!.parts[1]!
    expect(oversized.partId).toBe('m-1:1')
    expect(oversized.content).toBe('')
    expect(oversized.unavailable).toMatch(/33554432|32 ?MiB/i)
    // The refusal cost ZERO round trips: the declaration was enough.
    expect(rig.fake.methodCount('agent.content.read')).toBe(0)
  }, 30_000)
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

describe('issue #17: a slice boundary inside a multi-byte character', () => {
  it('④q decodes the reassembled BYTES, so a split character survives intact', async () => {
    // `agent.content.read` slices at 24 KiB, which lands inside a multi-byte
    // character whenever the content is not pure ASCII. Decoding each slice on
    // its own yields U+FFFD in both halves — and the sha256, computed over the
    // RAW BYTES, still matches, so the integrity check cannot catch it. The
    // text below puts a CJK character exactly across the first boundary.
    const boundary = 24_576
    const text = `${'a'.repeat(boundary - 1)}中文内容测试${'b'.repeat(64)}`
    const rig = await makeRig({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
        ],
        messages: [
          {
            messageId: 'm-1',
            revision: '1001',
            role: 'assistant',
            status: 'success',
            parts: [{ kind: 'text', text }],
          },
        ],
      },
    })

    const snapshot = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{ parts: Array<{ content: string; unavailable?: string }> }>
    }

    const part = snapshot.messages[0]!.parts[0]!
    expect(part.unavailable).toBeUndefined()
    expect(part.content).toBe(text)
    expect(part.content).not.toContain('\uFFFD')
  })
})

describe('issue #17: the CUMULATIVE arm of the externalized-content ceiling', () => {
  it('④r a peer serving MORE than it declared is stopped by bytes read, not slices', async () => {
    // The declared arm refuses up front; the cumulative arm is what bounds a
    // peer that UNDER-declares (declared <= cap) and then serves more. With the
    // real 32 MiB cap every honest walk exhausts the slice budget first, so the
    // cap is injected small here to make the byte check the arm that stops the
    // walk — the configuration where removing it demonstrably returns more than
    // the ceiling in one verified piece.
    const text = 'Z'.repeat(2_048)
    const rig = await makeRig(
      {
        agent: {
          sessions: [
            { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1000' },
          ],
          messages: [
            {
              messageId: 'm-1',
              revision: '1001',
              role: 'assistant',
              status: 'success',
              parts: [
                { kind: 'text', text: 'inline survives' },
                { kind: 'text', text, external: true },
              ],
            },
          ],
        },
      },
      { engine: { externalizedByteCap: 1_024 } },
    )
    // Declared == cap, so the declared arm's strict `>` does not fire; the real
    // bytes are 2x the cap and the slice budget (ceil(1024/24576) = 1) still
    // holds one whole slice. Only bytes-read can stop this walk.
    rig.fake.understateContentLength('m-1:1', '1001', 1_024)

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{ parts: Array<{ content: string; unavailable?: string }> }>
    }

    expect(result.messages[0]!.parts[0]!.content).toBe('inline survives')
    const overServed = result.messages[0]!.parts[1]!
    expect(overServed.unavailable).toMatch(/exceeded the 1024-byte limit/)
    expect(overServed.content).toBe('')
  })
})

describe('issue #27: the externalized-content digest has TWO sources and both must agree', () => {
  it('④u a slice digest that DISAGREES with the ref declaration degrades the part, never certifies it', async () => {
    // The ref advertises a digest; so does every slice's `sha256`. The official
    // client checks the SLICE's digest against the ref's on every page, so a
    // peer whose two sources disagree is self-inconsistent and cannot be said
    // to have served the content the ref describes — even when the bytes match
    // the slice's own (lying) digest. Preferring the slice (the old
    // `sha ?? declaredSha`) certified such a peer.
    //
    // This fake serves exactly that peer: the bytes are real and hash to the
    // digest the SLICE reports, while the ref (and the pin) advertise a
    // different digest.
    const text = 'Q'.repeat(2_000)
    const bytes = new TextEncoder().encode(text)
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
            parts: [
              { kind: 'text', text: 'inline survives' },
              { kind: 'text', text, external: true },
            ],
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

    // The slice-level digest is the TRUE digest of the bytes served (so the
    // digest-of-bytes check passes); the ref keeps the pin's own digest, which
    // differs because it is the digest of DIFFERENT bytes.
    const sliceDigest = createHash('sha256').update(bytes).digest('hex')
    const refDigest = createHash('sha256').update('a different content entirely').digest('hex')
    expect(sliceDigest).not.toBe(refDigest)
    rig.fake.scriptContentSlice({
      contentId: 'm-1:1',
      revision: '1001',
      offset: '0',
      dataBase64: Buffer.from(bytes).toString('base64'),
      nextOffset: String(bytes.length),
      eof: true,
      sha256: sliceDigest,
    })
    // The bytes hash to `sliceDigest`, so the ONLY way to reject this peer is
    // to compare the two digest sources — the mutation this test pins.
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sliceDigest)
    // Keep the pin's advertised digest at what the ref already says: the fake's
    // wire digest for slices is the pin's, so let the pin BE `refDigest`.
    rig.fake.setContentDigest('m-1:1', '1001', refDigest)

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{
        messageId: string
        parts: Array<{ partId: string; content: string; unavailable?: string }>
        incomplete?: true
        unavailableParts?: number
      }>
    }

    // The rest of the page is untouched: this is a per-part content failure.
    expect(result.messages.map((message) => message.messageId)).toEqual(['m-1', 'm-2'])
    expect(result.messages[0]!.parts[0]!.content).toBe('inline survives')
    expect(result.messages[1]!.parts[0]!.content).toBe('later message survives')
    // The self-inconsistent part is marked unavailable with its content
    // withheld — and the message advertises its lost content.
    const inconsistent = result.messages[0]!.parts[1]!
    expect(inconsistent.partId).toBe('m-1:1')
    expect(inconsistent.content).toBe('')
    expect(inconsistent.unavailable).toMatch(/sha256|digest|integrity/i)
    expect(result.messages[0]!.incomplete).toBe(true)
    expect(result.messages[0]!.unavailableParts).toBe(1)
    // The message's walk was complete: this is a CONTENT verdict.
    expect(result.messages[0]).not.toHaveProperty('partsTruncated')
    // The healthy message carries neither flag.
    expect(result.messages[1]).not.toHaveProperty('incomplete')
    expect(result.messages[1]).not.toHaveProperty('unavailableParts')
  })

  it('④v bytes that match the digest but are NOT legal UTF-8 degrade the part — no U+FFFD is ever returned', async () => {
    // A digest certifies the BYTES, not their legality: a peer can serve bytes
    // whose sha256 is exactly what it promised and which still are not UTF-8.
    // `Buffer.toString('utf8')` silently rewrites those to U+FFFD, so the
    // certified-but-corrupt text would reach the model as substitution
    // characters. The decode is FATAL: an illegal sequence is an integrity
    // failure of this part (degradable, like any other unreadable content).
    const raw = Buffer.concat([
      Buffer.from('valid prefix '),
      Buffer.from([0xff]), // a lone continuation byte: never legal UTF-8
      Buffer.from(' valid suffix'),
    ])
    const trueDigest = createHash('sha256').update(raw).digest('hex')
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
            parts: [
              { kind: 'text', text: 'inline survives' },
              { kind: 'text', text: 'placeholder', external: true },
            ],
          },
        ],
      },
    })

    // The raw bytes AND the ref's digest both describe the same (illegal)
    // content, so this peer is fully self-consistent: only the DECODE can tell
    // that there is no text here.
    rig.fake.setContentBytes('m-1:1', '1001', raw)
    expect(rig.fake.contentDigestFor('m-1:1', '1001')).toBe(trueDigest)

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{
        parts: Array<{ partId: string; content: string; unavailable?: string }>
        incomplete?: true
        unavailableParts?: number
      }>
    }

    expect(result.messages[0]!.parts[0]!.content).toBe('inline survives')
    const undecodable = result.messages[0]!.parts[1]!
    expect(undecodable.partId).toBe('m-1:1')
    // The one thing that must NEVER happen: a certified digest must not buy a
    // part its U+FFFD-filled text.
    expect(undecodable.content).toBe('')
    expect(undecodable.unavailable).toMatch(/utf-?8|decode/i)
    expect(JSON.stringify(result)).not.toContain('\uFFFD')
    expect(result.messages[0]!.incomplete).toBe(true)
    expect(result.messages[0]!.unavailableParts).toBe(1)
  })
})

describe('issue #27 follow-up: the agreement check is PER SLICE, not just on the last one', () => {
  it('④w an EARLY slice that echoes a different digest is caught even when the last slice agrees with the ref', async () => {
    // `sha` holds only the LAST slice's report, so checking agreement once at
    // the end lets a peer disagree on every earlier slice and still be
    // certified by its final one. The official client compares
    // `page.sha256 === ref.sha256` on EVERY slice; so does this walk now.
    //
    // The bytes here are honest end to end — their whole-content digest IS the
    // ref's — so the ONLY defect is the first slice's echoed digest.
    const first = 'A'.repeat(24 * 1024)
    const second = 'B'.repeat(512)
    const text = first + second
    const bytes = Buffer.from(text)
    const trueDigest = createHash('sha256').update(bytes).digest('hex')
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
            parts: [
              { kind: 'text', text: 'inline survives' },
              { kind: 'text', text, external: true },
            ],
          },
        ],
      },
    })
    rig.fake.scriptContentSlice({
      contentId: 'm-1:1',
      revision: '1001',
      offset: '0',
      dataBase64: bytes.subarray(0, 24 * 1024).toString('base64'),
      nextOffset: String(24 * 1024),
      eof: false,
      // The lie: the first slice echoes a digest that is not the ref's.
      sha256: createHash('sha256').update('some other content').digest('hex'),
    })
    rig.fake.scriptContentSlice({
      contentId: 'm-1:1',
      revision: '1001',
      offset: String(24 * 1024),
      dataBase64: bytes.subarray(24 * 1024).toString('base64'),
      nextOffset: String(bytes.length),
      eof: true,
      sha256: trueDigest,
    })
    // ...then fall through to the pin, whose slices echo the TRUE digest (this
    // is asserted after the first read below, once the pin exists).

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{
        parts: Array<{ partId: string; content: string; unavailable?: string }>
        incomplete?: true
        unavailableParts?: number
      }>
    }

    expect(result.messages[0]!.parts[0]!.content).toBe('inline survives')
    const inconsistent = result.messages[0]!.parts[1]!
    expect(inconsistent.partId).toBe('m-1:1')
    // The honest bytes and the honest final digest must NOT buy this part its
    // text: one dishonest slice is enough to make the walk uncertifiable.
    expect(inconsistent.content).toBe('')
    expect(inconsistent.unavailable).toMatch(/sha256|digest|integrity|disagree/i)
    // The diagnosis names WHERE: slice index and offset.
    expect(inconsistent.unavailable).toMatch(/slice 1\b|offset 0\b/i)
    expect(result.messages[0]!.incomplete).toBe(true)
    expect(result.messages[0]!.unavailableParts).toBe(1)
    // It stopped at the FIRST offending slice: the second was never requested.
    expect(rig.fake.readCallsFor('agent.content.read')).toHaveLength(1)
    // Precondition, checked once the pin has been created by that first
    // listing: the ref (and every honest slice after the scripted pair) carries
    // the TRUE whole-content digest, so the end-of-walk check alone would have
    // passed and only the per-slice check can reject this walk.
    expect(rig.fake.contentDigestFor('m-1:1', '1001')).toBe(trueDigest)
  })

  it('④x a leading BOM is STRIPPED, not returned, and the part stays usable', async () => {
    // A digest certifies bytes; the DECODER decides the text. `TextDecoder`
    // drops a leading U+FEFF by design (the WHATWG encoding rule, and what the
    // official reducer's decode does), where the old `toString('utf8')` kept
    // it. That is an alignment, and this pins it: the BOM must not survive
    // into the model's context as an invisible zero-width character, and it
    // must not be mistaken for content that fails to decode.
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello, world')])
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
            parts: [{ kind: 'text', text: 'placeholder', external: true }],
          },
        ],
      },
    })
    // The fixture `text` is only long enough to reach the peer's inline limit
    // (forcing the `{ref}` form); the bytes that get SERVED are the BOM ones,
    // pinned after the fixture's own pin so they replace it outright — bytes
    // and digest together, so this peer is self-consistent and only the decode
    // decides the outcome.
    rig.fake.setContentBytes('m-1:0', '1001', raw)
    expect(rig.fake.contentDigestFor('m-1:0', '1001')).toBe(createHash('sha256').update(raw).digest('hex'))

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as {
      messages: Array<{
        parts: Array<{ partId: string; content: string; unavailable?: string }>
        incomplete?: true
        unavailableParts?: number
      }>
    }

    const part = result.messages[0]!.parts[0]!
    expect(part.unavailable).toBeUndefined()
    expect(part.content).toBe('hello, world')
    expect(part.content).not.toContain('\uFEFF')
    expect(result.messages[0]).not.toHaveProperty('incomplete')
    expect(result.messages[0]).not.toHaveProperty('unavailableParts')
  })
})

// ---------------------------------------------------------------------------
// issue #65: the LIST face's stop point is a resume INPUT
// ---------------------------------------------------------------------------

/**
 * A truncated list walk answers a self-describing `resumeCursor`
 * (`list:<opaque>`), and the same tool accepts it back as `cursor` with the
 * SAME filters: the round trip the message face already has. The token is bound
 * to (tool, device, filters), so reuse against a different query is refused
 * LOCALLY — a peer position from another query would silently read the wrong
 * slice, which is the failure mode this binding exists to prevent.
 */
describe('issue #65: list walks are resumable', () => {
  interface ListPage {
    items: Array<Record<string, unknown>>
    truncated?: boolean
    truncationReason?: string
    resumeCursor?: string
    nextCursor?: string
  }

  const sessionsFixture = (count: number): Array<Record<string, unknown>> =>
    Array.from({ length: count }, (_unused, index) => ({
      sessionId: `s-${String(index).padStart(3, '0')}`,
      agentId: 'a1',
      workspaceId: 'w1',
      title: `Session ${index}`,
      historyRevision: '1',
    }))

  const agentsFixture = (count: number): Array<Record<string, unknown>> =>
    Array.from({ length: count }, (_unused, index) => ({ agentId: `a-${index}`, name: `Agent ${index}` }))

  const ids = (page: ListPage, key: string): string[] => page.items.map((item) => String(item[key]))

  it('⑰a cherry_sessions walks a 40-session list to the end in three exact answers', async () => {
    const rig = await makeRig({ agent: { agents: [{ agentId: 'a1', name: 'A' }], sessions: sessionsFixture(40) as never } })

    const first = (await rig.call('cherry_sessions', { device: 'dev-A', agentId: 'a1', limit: LIST_PAGE_CLAMP })) as ListPage
    expect(first.items).toHaveLength(LIST_PAGE_CLAMP)
    expect(first.truncated).toBe(true)
    expect(first.truncationReason).toBe('limit')
    expect(first.resumeCursor).toMatch(/^list:/)
    expect(first.nextCursor).toBeUndefined()

    const second = (await rig.call('cherry_sessions', {
      device: 'dev-A',
      agentId: 'a1',
      limit: LIST_PAGE_CLAMP,
      cursor: first.resumeCursor,
    })) as ListPage
    expect(second.items).toHaveLength(LIST_PAGE_CLAMP)
    expect(second.truncated).toBe(true)

    const third = (await rig.call('cherry_sessions', {
      device: 'dev-A',
      agentId: 'a1',
      limit: LIST_PAGE_CLAMP,
      cursor: second.resumeCursor,
    })) as ListPage
    expect(third.items).toHaveLength(40 - 2 * LIST_PAGE_CLAMP)
    expect(third.truncated).toBe(false)
    expect(third.resumeCursor).toBeUndefined()

    expect([...ids(first, 'sessionId'), ...ids(second, 'sessionId'), ...ids(third, 'sessionId')]).toEqual(
      sessionsFixture(40).map((session) => session['sessionId']),
    )
  })

  it('⑰b each list tool accepts the token it emitted (agents / workspaces / interactions)', async () => {
    const rig = await makeRig({
      agent: {
        agents: agentsFixture(20) as never,
        workspaces: Array.from({ length: 20 }, (_unused, index) => ({ workspaceId: `w-${index}`, name: `W${index}` })) as never,
        sessions: sessionsFixture(1) as never,
        interactions: Array.from({ length: 5 }, (_unused, index) => ({
          interactionId: `i-${index}`,
          revision: '1',
          executionId: 'e-1',
          toolCallId: `t-${index}`,
          status: 'pending',
          summary: `Summary ${index}`,
        })) as never,
      },
    })

    const roundTrip = async (
      tool: string,
      args: Record<string, unknown>,
      key: string,
    ): Promise<string[]> => {
      const first = (await rig.call(tool, { ...args, limit: 2 })) as ListPage
      expect(first.truncated).toBe(true)
      expect(first.resumeCursor).toMatch(/^list:/)
      const second = (await rig.call(tool, { ...args, limit: 2, cursor: first.resumeCursor })) as ListPage
      expect(second.nextCursor).toBeUndefined()
      return [...ids(first, key), ...ids(second, key)]
    }

    // agents: 20 items, 2 per answer → the first two answers are contiguous
    expect(await roundTrip('cherry_agents', { device: 'dev-A' }, 'agentId')).toEqual(['a-0', 'a-1', 'a-2', 'a-3'])
    // workspaces: the same walk shape, plus the systemWorkspace flag
    const wsFirst = (await rig.call('cherry_workspaces', { device: 'dev-A', agentId: 'a-0', limit: 2 })) as ListPage & {
      systemWorkspace?: boolean
    }
    expect(wsFirst.resumeCursor).toMatch(/^list:/)
    const wsSecond = (await rig.call('cherry_workspaces', {
      device: 'dev-A',
      agentId: 'a-0',
      limit: 2,
      cursor: wsFirst.resumeCursor,
    })) as ListPage & { systemWorkspace?: boolean }
    expect(wsSecond.systemWorkspace).toBe(true)
    expect([...ids(wsFirst, 'workspaceId'), ...ids(wsSecond, 'workspaceId')]).toEqual(['w-0', 'w-1', 'w-2', 'w-3'])
    // interactions: page clamp 2, five pending cards → resume continues them
    expect(await roundTrip('cherry_interactions', { device: 'dev-A', sessionId: 's-000' }, 'interactionId')).toEqual([
      'i-0',
      'i-1',
      'i-2',
      'i-3',
    ])
  })

  it('⑰c a token reused with different filters is refused LOCALLY, before any RPC', async () => {
    const rig = await makeRig({
      agent: {
        agents: [{ agentId: 'a1', name: 'A' }, { agentId: 'a2', name: 'B' }] as never,
        sessions: sessionsFixture(40) as never,
      },
    })
    const first = (await rig.call('cherry_sessions', { device: 'dev-A', agentId: 'a1', limit: LIST_PAGE_CLAMP })) as ListPage
    const before = rig.fake.readCallsFor('agent.sessions.list').length

    await expect(
      rig.call('cherry_sessions', { device: 'dev-A', agentId: 'a2', limit: 16, cursor: first.resumeCursor }),
    ).rejects.toThrow(/different filter set/i)
    expect(rig.fake.readCallsFor('agent.sessions.list')).toHaveLength(before)
  })

  it('⑰d a token from another tool, a raw peer position, and an `after:` token are all refused', async () => {
    const rig = await makeRig({ agent: { agents: agentsFixture(20) as never, sessions: sessionsFixture(40) as never } })
    const first = (await rig.call('cherry_sessions', { device: 'dev-A', agentId: 'a1', limit: LIST_PAGE_CLAMP })) as ListPage

    await expect(
      rig.call('cherry_agents', { device: 'dev-A', limit: 2, cursor: first.resumeCursor }),
    ).rejects.toThrow(/different tool/i)
    // A bare peer position and the message face's anchor form are both refused
    // by the PREFIX: neither can be a token this tool emitted (issue #70 kept
    // the two faces on one prefix so this stays true).
    await expect(rig.call('cherry_sessions', { device: 'dev-A', agentId: 'a1', limit: 2, cursor: '16' })).rejects.toThrow(
      /must be a `list:` token/i,
    )
    await expect(
      rig.call('cherry_sessions', { device: 'dev-A', agentId: 'a1', limit: 2, cursor: 'after:msg-1' }),
    ).rejects.toThrow(/must be a `list:` token/i)
  })

  it('⑰e a token issued by one device is refused on another', async () => {
    const rig = await makeRig(
      { agent: { agents: [{ agentId: 'a1', name: 'A' }] as never, sessions: sessionsFixture(40) as never } },
      { extraDevices: [{ deviceId: 'dev-B', displayName: 'Desk Beta' }] },
    )
    const first = (await rig.call('cherry_sessions', { device: 'dev-A', agentId: 'a1', limit: LIST_PAGE_CLAMP })) as ListPage
    rig.store.upsert({ ...rig.store.list().find((entry) => entry.deviceId === 'dev-A')!, deviceId: 'dev-B', displayName: 'Desk Beta', enabled: true })
    await rig.connectDevice('dev-B')

    await expect(
      rig.call('cherry_sessions', { device: 'dev-B', agentId: 'a1', limit: 2, cursor: first.resumeCursor }),
    ).rejects.toThrow(/different device/i)
  })

  it('⑰f interactions keep the pending filter across answers, and the token covers the raw stream', async () => {
    const interactions = [
      ...Array.from({ length: 4 }, (_unused, index) => ({
        interactionId: `p-${index}`,
        revision: '1',
        executionId: 'e-1',
        toolCallId: `t-${index}`,
        status: 'pending' as const,
        summary: `Pending ${index}`,
      })),
      {
        interactionId: 'done-0',
        revision: '1',
        executionId: 'e-1',
        toolCallId: 't-done',
        status: 'approved' as const,
        summary: 'Approved',
      },
      ...Array.from({ length: 2 }, (_unused, index) => ({
        interactionId: `p-${index + 4}`,
        revision: '1',
        executionId: 'e-1',
        toolCallId: `t-${index + 4}`,
        status: 'pending' as const,
        summary: `Pending ${index + 4}`,
      })),
    ]
    const rig = await makeRig({ agent: { agents: [{ agentId: 'a1', name: 'A' }] as never, sessions: sessionsFixture(1) as never, interactions: interactions as never } })

    const seen: string[] = []
    let cursor: string | undefined
    for (let step = 0; step < 6; step += 1) {
      const page = (await rig.call('cherry_interactions', {
        device: 'dev-A',
        sessionId: 's-000',
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      })) as ListPage
      for (const item of page.items) seen.push(String(item['interactionId']))
      if (page.truncated !== true) break
      expect(page.resumeCursor).toMatch(/^list:/)
      cursor = page.resumeCursor
    }
    expect(seen).toEqual(['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5'])
  })

  it('⑰h an overshooting page resumes from the position the walk SENT, not the one it advertised', async () => {
    const agents = agentsFixture(12)
    const rig = await makeRig({ agent: { agents: agents as never } })
    rig.fake.scriptListPages('agent.agents.list', [
      // page 1: exactly what was asked for (limit 4), position 4
      { items: agents.slice(0, 4), nextCursor: '4' },
      // page 2: the peer OVERSHOOTS — five items for a limit of four, and it
      // advertises a position (9) past the item (a-8) the walk never collected.
      { items: agents.slice(4, 9), nextCursor: '9' },
      // the replay of page 2 (the same sent position, the same page)
      { items: agents.slice(4, 9), nextCursor: '9' },
      // the continuation past the page, for the answer that takes all five
      { items: agents.slice(9, 12), nextCursor: null },
    ])

    const first = (await rig.call('cherry_agents', { device: 'dev-A', limit: 4 })) as ListPage
    expect(ids(first, 'agentId')).toEqual(['a-0', 'a-1', 'a-2', 'a-3'])
    expect(first.resumeCursor).toMatch(/^list:/)

    // The token names the position the walk SENT for the overshooting page (4),
    // never the advertised 9: a resume from 9 would skip a-8 entirely.
    const second = (await rig.call('cherry_agents', {
      device: 'dev-A',
      limit: 4,
      cursor: first.resumeCursor,
    })) as ListPage
    expect(ids(second, 'agentId')).toEqual(['a-4', 'a-5', 'a-6', 'a-7'])

    // A wider limit consumes the whole overshooting page, so the token advances
    // to the position that page advertised and the rest is reachable.
    const third = (await rig.call('cherry_agents', { device: 'dev-A', limit: 5, cursor: second.resumeCursor })) as ListPage
    expect(ids(third, 'agentId')).toEqual(['a-4', 'a-5', 'a-6', 'a-7', 'a-8'])
    expect(third.truncated).toBe(true)

    const fourth = (await rig.call('cherry_agents', { device: 'dev-A', limit: 4, cursor: third.resumeCursor })) as ListPage
    expect(ids(fourth, 'agentId')).toEqual(['a-9', 'a-10', 'a-11'])
    expect(fourth.truncated).toBe(false)
  })

  it('⑰i a malformed payload is refused, and a first-page overshoot has no token to name', async () => {
    const agents = agentsFixture(12)
    const rig = await makeRig({ agent: { agents: agents as never } })
    await expect(
      rig.call('cherry_agents', { device: 'dev-A', limit: 4, cursor: 'cursor:not-a-payload' }),
    ).rejects.toThrow(/cursor/i)

    // The overshoot lands on the FIRST page, for which no position was ever
    // sent: nothing can be named honestly, so no token is invented and the
    // remedy is a wider `limit` (documented in the description).
    rig.fake.scriptListPages('agent.agents.list', [{ items: agents.slice(0, 5), nextCursor: '5' }])
    const page = (await rig.call('cherry_agents', { device: 'dev-A', limit: 4 })) as ListPage
    expect(page.truncated).toBe(true)
    expect(page.resumeCursor).toBeUndefined()
    expect(page.nextCursor).toBeUndefined()
  })

  it('⑰g the four list tools declare the `cursor` input and no result carries a raw `nextCursor`', async () => {
    const rig = await makeRig({ agent: { agents: agentsFixture(3) as never, sessions: sessionsFixture(3) as never } })
    for (const tool of ['cherry_agents', 'cherry_sessions', 'cherry_workspaces', 'cherry_interactions']) {
      const parameters = rig.tool(tool).parameters as { properties?: Record<string, unknown> }
      expect(Object.keys(parameters.properties ?? {})).toContain('cursor')
    }
    const page = (await rig.call('cherry_sessions', { device: 'dev-A', limit: 100 })) as ListPage
    expect(page.nextCursor).toBeUndefined()
    expect(Object.keys(page)).not.toContain('nextCursor')
  })
})

/**
 * Issue #70: the LIST token is a compact delimiter form, not a base64 JSON blob,
 * and it carries a checksum over its whole body — INCLUDING the peer position,
 * the one field a structural check cannot validate. The property is closed:
 * EVERY single-character corruption of a token this tool emitted is refused
 * locally, without a dial.
 *
 * Shape: `list:v2:<tool>:<device12>:<filters8>:<checksum8>:<position>` — a
 * one-char tool code, a digest instead of the 36-char deviceId, an 8-hex filter
 * fingerprint, an 8-hex checksum, and the peer position VERBATIM and last. It
 * has to be last: the real desktop's session cursor is
 * `entity:<orderKey>:<uuid>`, i.e. it contains the token's own delimiter, so
 * the split stops at a fixed field count rather than consuming the rest.
 */
describe('issue #70: list resume tokens are compact and integrity-checked', () => {
  interface ListPage {
    items: Array<Record<string, unknown>>
    truncated?: boolean
    truncationReason?: string
    resumeCursor?: string
    nextCursor?: string
  }

  /** The real desktop's session cursor: a section tag, an order key, an id. */
  const KEYSET = 'entity:1757923200000:9c1f0a2e-6b3d-4a71-8f55-2d6e0b1c7a44'

  const sessions = (count: number): Array<Record<string, unknown>> =>
    Array.from({ length: count }, (_unused, index) => ({
      sessionId: `s-${String(index).padStart(3, '0')}`,
      agentId: 'a1',
      workspaceId: 'w1',
      title: `Session ${index}`,
      historyRevision: '1',
    }))

  /**
   * A `cherry_sessions` answer truncated at a KEYSET position — the desktop's
   * own shape, i.e. one that contains the token's delimiter. The second
   * scripted page records the cursor it was handed, so the round trip can be
   * asserted on the WIRE (verbatim) rather than through the token's own words.
   */
  const keysetRig = async (): Promise<{ rig: Rig; wire: string[] }> => {
    const wire: string[] = []
    const rig = await makeRig({
      agent: { agents: [{ agentId: 'a1', name: 'A' }] as never, sessions: sessions(3) as never },
    })
    rig.fake.scriptListPages('agent.sessions.list', [
      { items: sessions(2), nextCursor: KEYSET },
      (params) => {
        wire.push(String(params['cursor']))
        return { items: sessions(3).slice(2), nextCursor: null }
      },
    ])
    return { rig, wire }
  }

  it('⑦a the token is the compact form and the peer position rides back VERBATIM', async () => {
    const { rig, wire } = await keysetRig()
    const first = (await rig.call('cherry_sessions', { device: 'dev-A', agentId: 'a1', limit: 2 })) as ListPage
    expect(first.truncated).toBe(true)
    expect(first.truncationReason).toBe('limit')
    // tool code `s`, 12-hex device digest, 8-hex filter hash, 8-hex checksum,
    // then the position with its own colons.
    expect(first.resumeCursor).toMatch(/^list:v2:s:[0-9a-f]{12}:[0-9a-f]{8}:[0-9a-f]{8}:entity:1757923200000:/)
    expect(first.resumeCursor).toMatch(new RegExp(`:${KEYSET}$`))
    expect((first.resumeCursor as string).length).toBeLessThan(120)

    const second = (await rig.call('cherry_sessions', {
      device: 'dev-A',
      agentId: 'a1',
      limit: 2,
      cursor: first.resumeCursor,
    })) as ListPage
    expect(wire).toEqual([KEYSET])
    expect(second.items.map((item) => item['sessionId'])).toEqual(['s-002'])
    expect(second.truncated).toBe(false)
    expect(second.resumeCursor).toBeUndefined()
  })

  it('⑦b every single-character corruption is refused LOCALLY — the checksum covers the position', async () => {
    const { rig } = await keysetRig()
    const token = ((await rig.call('cherry_sessions', { device: 'dev-A', agentId: 'a1', limit: 2 })) as ListPage)
      .resumeCursor as string
    const before = rig.fake.readCallsFor('agent.sessions.list').length
    let tried = 0
    for (let at = 0; at < token.length; at += 1) {
      for (const ch of ['0', 'a', ':']) {
        if (ch === token[at]) continue
        const mutated = token.slice(0, at) + ch + token.slice(at + 1)
        await expect(
          rig.call('cherry_sessions', { device: 'dev-A', agentId: 'a1', limit: 2, cursor: mutated }),
        ).rejects.toThrow(/cursor/i)
        tried += 1
      }
    }
    // A "single-character corruption" includes LOSING one and GAINING one: a
    // model can truncate the string or paste a character twice. Both move the
    // response the peer is asked for, so both are the checksum's job.
    for (let at = 0; at < token.length; at += 1) {
      const deleted = token.slice(0, at) + token.slice(at + 1)
      await expect(
        rig.call('cherry_sessions', { device: 'dev-A', agentId: 'a1', limit: 2, cursor: deleted }),
      ).rejects.toThrow(/cursor/i)
      const inserted = token.slice(0, at) + 'a' + token.slice(at)
      await expect(
        rig.call('cherry_sessions', { device: 'dev-A', agentId: 'a1', limit: 2, cursor: inserted }),
      ).rejects.toThrow(/cursor/i)
      tried += 2
    }
    // ~281 substitutions + one deletion and one insertion per position.
    expect(tried).toBeGreaterThan(450)
    // Not one dial: a corrupted token never reaches the peer.
    expect(rig.fake.readCallsFor('agent.sessions.list')).toHaveLength(before)
  })

  it('⑦c a v1 token is refused as an older format, before any RPC', async () => {
    const { rig } = await keysetRig()
    const v1 =
      'cursor:' +
      Buffer.from(
        JSON.stringify({ v: 1, m: 'agent.sessions.list', d: 'dev-A', h: '0'.repeat(16), p: '2' }),
        'utf8',
      ).toString('base64url')
    const before = rig.fake.readCallsFor('agent.sessions.list').length
    const refusal = await rig
      .call('cherry_sessions', { device: 'dev-A', agentId: 'a1', limit: 2, cursor: v1 })
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      )
    expect(refusal).toBeInstanceOf(Error)
    expect(refusal?.message).toMatch(/older plugin version/i)
    // The remedy has to be the one that CAN work: a v1 token cannot be replayed
    // at all, so the generic "replay the token with the same …" tail would send
    // the caller to do something that fails every time.
    expect(refusal?.message).toMatch(/start this walk over/i)
    expect(refusal?.message).not.toMatch(/replay the token/i)
    expect(rig.fake.readCallsFor('agent.sessions.list')).toHaveLength(before)
  })

  it('⑦d an over-long cursor is refused by its LENGTH, not by a decode failure', async () => {
    const { rig } = await keysetRig()
    const before = rig.fake.readCallsFor('agent.sessions.list').length
    const huge = `list:v2:s:${'0'.repeat(12)}:${'0'.repeat(8)}:${'0'.repeat(8)}:${'9'.repeat(5000)}`
    await expect(rig.call('cherry_sessions', { device: 'dev-A', agentId: 'a1', limit: 2, cursor: huge })).rejects.toThrow(
      /4096/,
    )
    expect(rig.fake.readCallsFor('agent.sessions.list')).toHaveLength(before)
  })

  it('⑦f a position this face would REFUSE is never emitted (round-trip symmetry)', async () => {
    const agents = Array.from({ length: 12 }, (_unused, index) => ({ agentId: `a-${index}`, name: `A${index}` }))
    const rig = await makeRig({ agent: { agents: agents as never } })
    // A peer that claims more on an EMPTY position, and one whose position
    // carries whitespace. `parseListResumeCursor` rejects both, so emitting a
    // token would break "a token this tool emits is a token it accepts" — and
    // the caller would hold a token that can never be replayed. No token, and
    // `truncated` still says the walk was cut.
    rig.fake.scriptListPages('agent.agents.list', [
      { items: agents.slice(0, 2), nextCursor: '' },
      { items: agents.slice(0, 2), nextCursor: ' 4 ' },
    ])
    for (let call = 0; call < 2; call += 1) {
      const page = (await rig.call('cherry_agents', { device: 'dev-A', limit: 2 })) as ListPage
      expect(page.truncated).toBe(true)
      expect(page.resumeCursor).toBeUndefined()
    }
  })

  it('⑦h a position this face would REFUSE BY LENGTH is not emitted, while the boundary is (issue #76)', async () => {
    const agents = Array.from({ length: 12 }, (_unused, index) => ({ agentId: `a-${index}`, name: `A${index}` }))
    const rig = await makeRig({ agent: { agents: agents as never } })
    const overLong = '9'.repeat(5000)
    rig.fake.scriptListPages('agent.agents.list', [{ items: agents.slice(0, 2), nextCursor: overLong }])
    // `parseListResumeCursor` refuses this token by its length, so naming it would
    // hand the caller a stop point no replay can use. No token; `truncated` still
    // says the walk was cut, and — this being a `'limit'` stop on a list tool —
    // a wider `limit` is the remedy.
    const cut = (await rig.call('cherry_agents', { device: 'dev-A', limit: 2 })) as ListPage
    expect(cut.truncated).toBe(true)
    expect(cut.resumeCursor).toBeUndefined()

    // Learn the token's fixed HEAD length from a one-character position instead
    // of hard-coding the format, so a format change cannot leave this test green
    // against a boundary that no longer exists.
    rig.fake.scriptListPages('agent.agents.list', [{ items: agents.slice(0, 2), nextCursor: '2' }])
    const probe = (await rig.call('cherry_agents', { device: 'dev-A', limit: 2 })) as ListPage
    const probeToken = probe.resumeCursor as string
    const boundary = '9'.repeat(4096 - (probeToken.length - 1))
    rig.fake.scriptListPages('agent.agents.list', [{ items: agents.slice(0, 2), nextCursor: boundary }])
    // Arrivals, not `readCallsFor`: the fake records the call BEFORE it judges
    // the params, which is exactly what a peer-schema refusal must leave behind.
    const arrivalsBefore = rig.fake.methodCount('agent.agents.list')
    const atCeiling = (await rig.call('cherry_agents', { device: 'dev-A', limit: 2 })) as ListPage
    expect(atCeiling.truncated).toBe(true)
    expect(atCeiling.resumeCursor).toBeDefined()
    // Exactly at the ceiling is still a token this face accepts back, so it is
    // emitted: `<=` in the guard, never `<`.
    expect(atCeiling.resumeCursor).toHaveLength(4096)

    // The replay is judged at THIS face's boundary: the minted token must pass
    // `parseListResumeCursor` (no length refusal, no "not a token this tool
    // emitted") and leave with the position on it. Where it then stops is the
    // PEER's own schema — `pageParams.cursor` is an `opaqueId` of at most 256
    // characters — so the expected verdict is the peer rejecting the params,
    // which is only reachable if this face let the token through.
    const replay = await rig
      .call('cherry_agents', { device: 'dev-A', limit: 2, cursor: atCeiling.resumeCursor })
      .then(
        (page) => page as ListPage,
        (error: unknown) => error as Error,
      )
    expect(replay).toBeInstanceOf(Error)
    expect((replay as Error).message).toMatch(/malformed params for agent\.agents\.list/)
    expect(rig.fake.methodCount('agent.agents.list')).toBeGreaterThan(arrivalsBefore)
  })

  it('⑦i a v1-shaped peer position is not named on the list face either (issue #85)', async () => {
    const agents = Array.from({ length: 12 }, (_unused, index) => ({ agentId: `a-${index}`, name: `A${index}` }))
    const rig = await makeRig({ agent: { agents: agents as never } })
    // The v1 payload shape: 102 characters, colon-free base64url of `{v:1,…}`.
    // `parseListResumeCursor` names and refuses it BEFORE the binding checks, so
    // wrapping it would hand the caller a token refused as "an older plugin
    // version" — a diagnosis about our own retired format, produced by us.
    const v1Shaped = Buffer.from(
      JSON.stringify({ v: 1, m: 'agent.sessions.list', d: 'dev-A', h: '0'.repeat(16), p: '2' }),
      'utf8',
    ).toString('base64url')
    rig.fake.scriptListPages('agent.agents.list', [{ items: agents.slice(0, 2), nextCursor: v1Shaped }])

    const page = (await rig.call('cherry_agents', { device: 'dev-A', limit: 2 })) as ListPage
    expect(page.truncated).toBe(true)
    expect(page.resumeCursor).toBeUndefined()
  })

  it('⑦g a MESSAGE-face token is refused by a list tool, naming the face that owns it (issue #72)', async () => {
    const rig = await makeRig({
      agent: { agents: [{ agentId: 'a1', name: 'A' }] as never, sessions: sessions(40) as never },
    })
    const before = rig.fake.readCallsFor('agent.sessions.list').length
    // `cursor:<peer position>` is `cherry_read`'s own token shape. A list walk
    // cannot use it, and forwarding it would ask the peer for a slice of the
    // SESSION list at an offset taken from a MESSAGE history.
    await expect(
      rig.call('cherry_sessions', {
        device: 'dev-A',
        agentId: 'a1',
        limit: 2,
        cursor: 'cursor:1757923200000:9c1f0a2e-6b3d-4a71-8f55-2d6e0b1c7a44',
      }),
    ).rejects.toThrow(/a list token starts with `list:`/i)
    expect(rig.fake.readCallsFor('agent.sessions.list')).toHaveLength(before)
  })

  it('⑦e each list tool stamps its own one-character code, and a numeric position stays short', async () => {
    const rig = await makeRig({
      agent: {
        agents: Array.from({ length: 20 }, (_unused, index) => ({ agentId: `a-${index}`, name: `A${index}` })) as never,
        workspaces: Array.from({ length: 20 }, (_unused, index) => ({
          workspaceId: `w-${index}`,
          name: `W${index}`,
        })) as never,
        sessions: sessions(20) as never,
        interactions: Array.from({ length: 6 }, (_unused, index) => ({
          interactionId: `i-${index}`,
          revision: '1',
          executionId: 'e-1',
          toolCallId: `t-${index}`,
          status: 'pending' as const,
          summary: `S${index}`,
        })) as never,
      },
    })
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['cherry_agents', { device: 'dev-A' }, 'a'],
      ['cherry_workspaces', { device: 'dev-A', agentId: 'a-0' }, 'w'],
      ['cherry_sessions', { device: 'dev-A', agentId: 'a1' }, 's'],
      ['cherry_interactions', { device: 'dev-A', sessionId: 's-000' }, 'i'],
    ]
    for (const [tool, args, code] of cases) {
      const page = (await rig.call(tool, { ...args, limit: 2 })) as ListPage
      expect(page.truncated).toBe(true)
      expect(page.resumeCursor).toMatch(new RegExp(`^list:v2:${code}:[0-9a-f]{12}:[0-9a-f]{8}:[0-9a-f]{8}:`))
      // A numeric peer position is a handful of digits: the whole token stays
      // under 60 characters where the old base64 form needed ~150.
      expect((page.resumeCursor as string).length).toBeLessThan(60)
    }
  })
})
