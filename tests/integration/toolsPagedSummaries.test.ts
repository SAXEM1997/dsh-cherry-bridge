import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import { LIST_PAGE_CLAMP, PARTS_LIST_PAGE_CLAMP } from '../../src/defaults.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { buildDiagnostics } from '../../src/diagnostics.js'
import { registerCherryTools } from '../../src/tools.js'
import type { CherryToolDefinition, CherryToolsContext, CherryToolsDeps } from '../../src/tools.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions, FakeMessageRecord, FakePartRecord } from '../loopback/fakeCherry.js'

/**
 * Issue #105: consume `agent.messages.list`'s paged-message-summary arm when —
 * and ONLY when — the peer's hello advertised `agentMessageSummariesVersion: 1`.
 *
 * The acceptance invariant this suite exists for: a peer that did NOT advertise
 * the capability sees message-list traffic that carries NO `partsMode` key and
 * the SAME clamp as before #105, while an advertising peer is asked for the
 * summary arm and a page size the metadata-blind clamp would have refused.
 *
 * Test numbering is ⑮ (⑭ is the read-resume series); it is local to this file.
 */

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

interface Rig {
  fake: FakeCherry
  connection: DeviceConnection
  store: DeviceStore
  tmp: string
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  /** Drop the link and dial again on the SAME `DeviceConnection`. */
  reconnect(): Promise<void>
  stop(): Promise<void>
}

const rigs: Rig[] = []
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

const SESSION_ID = 'session-1'
const AGENT_ID = 'agent-1'
const WORKSPACE_ID = 'workspace-1'

function part(text: string): FakePartRecord {
  return { kind: 'text', text }
}

/** Three messages, NEWEST-FIRST, one part each — two non-empty walks' worth. */
function messages(count = 3): FakeMessageRecord[] {
  return Array.from({ length: count }, (_unused, index) => ({
    messageId: `m-${index}`,
    revision: String(1_700_000_000_000 + index),
    role: index % 2 === 0 ? 'assistant' : 'user',
    status: 'success',
    parts: [part(`text of message ${index}`)],
  }))
}

async function makeRig(options: FakeCherryOptions = {}): Promise<Rig> {
  const fake = new FakeCherry({
    ...options,
    agent: {
      sessions: [
        {
          sessionId: SESSION_ID,
          agentId: AGENT_ID,
          workspaceId: WORKSPACE_ID,
          title: 'paged summaries',
          historyRevision: '1700000000000',
        },
      ],
      messages: messages(),
      ...(options.agent ?? {}),
    },
  })
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-paged-'))
  const store = new DeviceStore(join(tmp, 'devices.json'))
  store.upsert({
    schemaVersion: 4,
    deviceId: 'dev-A',
    displayName: 'Dev A',
    hosts: [host],
    security: { [host]: 'ws' as const },
    ports: { [host]: port },
    port,
    desktopIdentity,
    grants: ['agent'],
    enabled: true,
  })

  const connections = new Map<string, DeviceConnection>()
  const subscriptions = new Map<string, SessionSubscriptions>()
  const connect = (deviceId: string): DeviceConnection => {
    const existing = connections.get(deviceId)
    if (existing !== undefined) return existing
    const stored = store.list().find((entry) => entry.deviceId === deviceId)
    if (stored === undefined) throw new Error(`no device ${deviceId}`)
    const connection = new DeviceConnection({ identity, record: stored })
    connections.set(deviceId, connection)
    return connection
  }
  const subs = (deviceId: string): SessionSubscriptions => {
    const existing = subscriptions.get(deviceId)
    if (existing !== undefined) return existing
    const connection = connect(deviceId)
    const created = new SessionSubscriptions(connection.rpc, { subscriptionsLimit: 8 })
    connection.rpc.onNotification((method, params) => created.handleNotification(method, params))
    subscriptions.set(deviceId, created)
    return created
  }
  const ctx = makeCtx()
  const deps = {
    store,
    connect,
    subs,
    pair: async () => {
      throw new Error('pairing is not exercised by the paged-summaries suite')
    },
    evict: () => {
      throw new Error('the paged-summaries suite never evicts')
    },
  } as unknown as CherryToolsDeps
  registerCherryTools(ctx, deps, {})

  const connection = connect('dev-A')
  await connection.connect()

  const tool = (name: string): CherryToolDefinition => {
    const found = ctx.definitions.find((definition) => definition.name === name)
    if (found === undefined) throw new Error(`tool ${name} is not registered`)
    return found
  }

  const rig: Rig = {
    fake,
    connection,
    store,
    tmp,
    call: (name, args = {}) => tool(name).execute(args),
    reconnect: async () => {
      // A real link loss; the connection layer re-dials on its OWN schedule, and
      // the assertions need the SECOND hello to have landed (a `connect()` call
      // while `connected` is a no-op, so the event is what must be awaited).
      // A second hello is not proof that the SECOND link finished: `helloCount`
      // is bumped as the frame arrives, before authenticate and before the
      // client adopts the handshake's limits. The test subscribes, so the state
      // transition is the completion signal.
      const reached = new Promise<void>((resolve) => connection.onState((state) => {
        if (state === 'connected') resolve()
      }))
      fake.injectClose(1000, 'flip the capability')
      const deadline = Date.now() + 10_000
      while (fake.helloCount < 2) {
        if (Date.now() > deadline) throw new Error('the connection did not re-handshake')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await reached
    },
    stop: async () => {
      for (const created of subscriptions.values()) await created.dispose()
      for (const created of connections.values()) await created.close()
      await fake.stop()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
  rigs.push(rig)
  return rig
}

/** Every `agent.messages.list` request's params, in arrival order. */
function messageListRequests(rig: Rig): Record<string, unknown>[] {
  return rig.fake.readCallsFor('agent.messages.list') as Record<string, unknown>[]
}

describe('issue #105 ⑮: partsMode is gated on the hello capability', () => {
  it('⑮a a peer WITHOUT the capability is never asked for partsMode', async () => {
    const rig = await makeRig()
    expect(rig.fake.lastHelloReply).not.toHaveProperty('agentMessageSummariesVersion')
    expect(rig.connection.limits.messageSummaries).toBeUndefined()

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION_ID })) as {
      messages: Array<{ messageId: string; parts: Array<{ content: string }> }>
    }
    expect(result.messages.map((message) => message.messageId)).toEqual(['m-0', 'm-1', 'm-2'])
    expect(result.messages[0]!.parts[0]!.content).toBe('text of message 0')

    const requests = messageListRequests(rig)
    expect(requests.length).toBeGreaterThan(0)
    for (const params of requests) {
      expect(params).not.toHaveProperty('partsMode')
      // The pre-#105 request, key for key and value for value.
      expect(Object.keys(params).sort()).toEqual(['historyRevision', 'limit', 'sessionId'])
      // The byte-safe clamp still bounds the page against a count-paged peer.
      expect(params['limit']).toBe(LIST_PAGE_CLAMP)
    }
  })

  it('⑮b a peer advertising the capability IS asked for partsMode, above the old clamp', async () => {
    const rig = await makeRig({ hello: { capabilities: { agentMessageSummariesVersion: 1 } } })
    expect(rig.fake.lastHelloReply).toMatchObject({ agentMessageSummariesVersion: 1 })
    expect(rig.connection.limits.messageSummaries).toBe(1)

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION_ID })) as {
      messages: Array<{ messageId: string; parts: Array<{ content: string }> }>
    }
    expect(result.messages.map((message) => message.messageId)).toEqual(['m-0', 'm-1', 'm-2'])
    expect(result.messages[0]!.parts[0]!.content).toBe('text of message 0')

    const requests = messageListRequests(rig)
    expect(requests.length).toBeGreaterThan(0)
    for (const params of requests) expect(params['partsMode']).toBe('paged')
    // THE PAGE SIZE: the negotiated `pageItems` (100), which the metadata-blind
    // clamp used to cut to 16 — a summary row is metadata, not a part list.
    expect(requests[0]!['limit']).toBe(100)
    // NON-VACUOUS: the peer really served SUMMARY rows (no `partIds`), so the
    // parts came from the `agent.parts.list` walk alone.
    const served = rig.fake.servedMessageRows()
    expect(served.length).toBeGreaterThan(0)
    expect(served.every((row) => !Object.hasOwn(row, 'partIds'))).toBe(true)
  })

  it('⑮c the PARTS walk keeps its byte-safe clamp under a paged-summaries peer', async () => {
    const rig = await makeRig({ hello: { capabilities: { agentMessageSummariesVersion: 1 } } })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION_ID })
    const partsRequests = rig.fake.readCallsFor('agent.parts.list')
    expect(partsRequests.length).toBeGreaterThan(0)
    // Nothing in the 0.7.0 contract proves the PARTS list is byte-aware.
    for (const params of partsRequests) expect(params['limit']).toBe(PARTS_LIST_PAGE_CLAMP)
    expect(PARTS_LIST_PAGE_CLAMP).toBeLessThan(rig.connection.limits.pageItems)
  })

  it('⑮d a RECONNECT that flips the capability re-reads it: the next read sends partsMode', async () => {
    const rig = await makeRig()
    await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION_ID })
    expect(messageListRequests(rig).some((params) => 'partsMode' in params)).toBe(false)
    expect(rig.fake.helloCount).toBe(1)

    // The knob is read at HELLO time, so flipping it is only observable on the
    // next handshake — exactly like the real desktop upgrading.
    rig.fake.advertiseMessageSummaries(1)
    await rig.reconnect()
    // NON-VACUOUS: the SECOND handshake really happened — the capability under
    // test was read from a fresh hello, not from the one that opened the first link.
    expect(rig.fake.helloCount).toBe(2)
    expect(rig.connection.limits.messageSummaries).toBe(1)

    await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION_ID })
    const requests = messageListRequests(rig)
    const afterReconnect = requests[requests.length - 1]!
    expect(afterReconnect['partsMode']).toBe('paged')
  })

  it('⑮d′ an EXPLICIT reconnect() re-handshakes and re-reads the capability', async () => {
    // The OTHER reconnect path: an operator/assembly calling `connect()` on a
    // live connection (the `close()`-then-`connect()` cycle included). It must
    // re-handshake rather than reuse the previous link's limits.
    const rig = await makeRig()
    expect(rig.connection.limits.messageSummaries).toBeUndefined()

    rig.fake.advertiseMessageSummaries(1)
    await rig.connection.close()
    await rig.connection.connect()
    expect(rig.connection.state).toBe('connected')
    expect(rig.connection.limits.messageSummaries).toBe(1)
    // NON-VACUOUS: the pool re-handshook (one more dial, one more hello), so
    // the capability below was read from the NEW link's limits.
    expect(rig.fake.socketCount).toBe(2)
    expect(rig.fake.helloCount).toBe(2)
    await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION_ID })
    const requests = messageListRequests(rig)
    expect(requests[requests.length - 1]!['partsMode']).toBe('paged')
  })

  it('⑮d″ a reconnect that DROPS the capability stops sending partsMode', async () => {
    const rig = await makeRig({ hello: { capabilities: { agentMessageSummariesVersion: 1 } } })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION_ID })
    expect(rig.connection.limits.messageSummaries).toBe(1)

    // The downgrade direction: a peer that stops advertising it must not keep
    // receiving a field its params schema no longer accepts.
    rig.fake.advertiseMessageSummaries(undefined)
    // The capability is re-read at HELLO time, so the reconnect below is what
    // makes the change observable on the wire.
    await rig.reconnect()
    // The client really DROPPED the capability (it is ABSENT, not `undefined`
    // and not inherited from the link that advertised it).
    expect(rig.connection.limits).not.toHaveProperty('messageSummaries')
    expect(rig.connection.state).toBe('connected')
    await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION_ID })
    const requests = messageListRequests(rig)
    // The read really served the new link (a cached list would prove nothing).
    expect(rig.fake.servedMessageRows().some((row) => Object.hasOwn(row, 'partIds'))).toBe(true)
    const afterReconnect = requests[requests.length - 1]!
    expect(afterReconnect).not.toHaveProperty('partsMode')
  })

  it('⑮e a peer that advertises but REFUSES partsMode fails loudly; no silent second dialect', async () => {
    const rig = await makeRig({
      hello: { capabilities: { agentMessageSummariesVersion: 1 } },
      agent: { refusePartsMode: true },
    })
    await expect(rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION_ID })).rejects.toThrow(/partsMode/i)
    // ONE request: a silent downgrade would hide a broken capability bit forever.
    expect(messageListRequests(rig)).toHaveLength(1)
  })

  it('⑮e′ an ITEM_TOO_LARGE refusal surfaces through cherry_read with the no-retry wording', async () => {
    const rig = await makeRig({ agent: { itemBudgetBytes: 60 } })
    const error = (await rig
      .call('cherry_read', { device: 'dev-A', sessionId: SESSION_ID })
      .catch((thrown: unknown) => thrown)) as Error
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/RESOURCE_EXHAUSTED|byte budget/)
    expect(error.message).toMatch(/retrying the same request cannot help/i)
    // The ITEM_TOO_LARGE shape gets the item-level advice (review P3-3 on
    // PR #129): one item over the per-item budget fits no page size, so the
    // message must not recommend a smaller limit.
    expect(error.message).toMatch(/no page size or request shape can fetch it/)
    // A permanent refusal is not retried by the walk: one page, one verdict.
    expect(messageListRequests(rig)).toHaveLength(1)
  })

  it('⑮f the IDLE wait face sends the same paged request as cherry_read', async () => {
    const rig = await makeRig({ hello: { capabilities: { agentMessageSummariesVersion: 1 } } })
    await rig.call('cherry_wait', { device: 'dev-A', sessionId: SESSION_ID, windowMs: 200 })
    const requests = messageListRequests(rig)
    expect(requests.length).toBeGreaterThan(0)
    for (const params of requests) expect(params['partsMode']).toBe('paged')
  })

  it('⑮g a capability version OTHER than 1 does not open the summary arm', async () => {
    // The capability is a NUMBER, read by value: version 2 is not version 1, and
    // a non-numeric value is not evidence of anything.
    const rig = await makeRig({ hello: { capabilities: { agentMessageSummariesVersion: 2 } } })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION_ID })
    // NON-VACUOUS: the value is STORED (verbatim), it is just not version 1 —
    // a client that compared loosely or coerced would send `partsMode` here.
    expect(rig.connection.limits.messageSummaries).toBe(2)
    expect(messageListRequests(rig).length).toBeGreaterThan(0)
    for (const params of messageListRequests(rig)) expect(params).not.toHaveProperty('partsMode')
  })
})

describe('issue #105 ⑯: the diagnostics report exposes the hello capability', () => {
  it('⑯a reports messageSummaries for an advertising device and omits it otherwise', async () => {
    const rig = await makeRig({ hello: { capabilities: { agentMessageSummariesVersion: 1 } } })
    const report = buildDiagnostics({
      store: rig.store,
      connect: (deviceId) => {
        const connection = rig.connection
        return { state: connection.state, limits: connection.limits }
      },
    })
    expect(report.devices[0]!.limits).not.toHaveProperty('messageSummaries')
    // The capability is its own field, a WHITELISTED projection, never the raw
    // hello: nothing else from the reply may appear beside it.
    expect(report.devices[0]!.messageSummaries).toBe(1)
    expect(Object.keys(report.devices[0]!).sort()).toEqual([
      'desktopIdentity',
      'deviceId',
      'displayName',
      'enabled',
      'hosts',
      'limits',
      'messageSummaries',
      'port',
      'state',
    ])

    // The whitelist is by CONSTRUCTION: unknown fields next to the capability
    // (the raw hello's shape) never reach the report.
    const stuffed = buildDiagnostics({
      store: rig.store,
      connect: () => ({
        state: 'connected',
        limits: { ...rig.connection.limits, agentUploadsVersion: 1, accessToken: 'nope' } as never,
        agentMessageSummariesVersion: 1,
        invitationSecret: 'nope',
      } as never),
    })
    expect(stuffed.devices[0]!.messageSummaries).toBe(1)
    expect(Object.keys(stuffed.devices[0]!).sort()).toEqual([
      'desktopIdentity',
      'deviceId',
      'displayName',
      'enabled',
      'hosts',
      'limits',
      'messageSummaries',
      'port',
      'state',
    ])
    expect(JSON.stringify(stuffed)).not.toMatch(/nope|agentUploadsVersion/)

    await rig.connection.close()
    const offline = buildDiagnostics({
      store: rig.store,
      connect: () => ({ state: rig.connection.state }),
    })
    expect(offline.devices[0]).not.toHaveProperty('messageSummaries')
  })
})
