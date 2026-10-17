import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import { JsonRpcRequestError } from '../../src/rpc/jsonRpcClient.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { registerCherryTools } from '../../src/tools.js'
import type {
  CherryToolDefinition,
  CherryToolEngineOptions,
  CherryToolsContext,
  CherryToolsDeps,
} from '../../src/tools.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions, FakeInteractionRecord, FakeMessageRecord } from '../loopback/fakeCherry.js'

/**
 * Task 9 integration suite: the six INTERACTIVE `cherry_*` tools driven through
 * the REAL registration seam against a real loopback Noise-XX fake desktop.
 * Test numbering ①-⑮ mirrors the task brief's Step 1 scenarios.
 *
 * The rig is Task 8's, extended with the command face: every assertion runs
 * through the same literal-JSON-Schema definitions the host registry receives,
 * so the schema `required` assertions (⑦) read the production declaration
 * rather than a test-local copy.
 */

/** The protocol's own `text` ceiling, which `cherry_send` pre-validates. */
const TEXT_LIMIT = 32_768

/** A plain timer, used only to sequence an injection against a live run. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
  /** Issue a raw RPC over the rig's own channel (wire-surface probes). */
  rawRequest(method: string, params: Record<string, unknown>): Promise<unknown>
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

interface RigOptions {
  /** Local policy knobs (e.g. a shortened waiter poll) for the engine. */
  engine?: CherryToolEngineOptions
  /** Skip `connect()` so the device stays offline. */
  skipConnect?: boolean
  /** Extra paired devices to seed, so a display-name prefix can be ambiguous. */
  extraDevices?: Array<{ deviceId: string; displayName: string }>
}

async function makeRig(options: FakeCherryOptions = {}, rigOptions: RigOptions = {}): Promise<Rig> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-tools-interact-'))
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
    const connection = new DeviceConnection({ identity, record: stored })
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
      throw new Error('pairing is not exercised by the interactive suite')
    },
    evict: () => {
      throw new Error('the interactive suite never evicts')
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
    rawRequest: (method, params) => connect('dev-A').rpc.request(method, params),
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

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** The one session every scenario drives. */
const SESSION = {
  sessionId: 's-1',
  agentId: 'agent-1',
  workspaceId: 'ws-1',
  title: 'Hello',
  historyRevision: '1',
}

const AGENT = { agentId: 'agent-1', name: 'Agent One' }

/** A question interaction with TWO questions — the multi-key answer contract. */
function questionInteraction(overrides: Partial<FakeInteractionRecord> = {}): FakeInteractionRecord {
  return {
    interactionId: 'i-question',
    revision: '7',
    executionId: 'exec-9',
    toolCallId: 'call-1',
    status: 'pending',
    summary: 'The agent needs two answers',
    kind: 'question',
    input: {
      questions: [
        { question: 'Which database?', options: [{ label: 'postgres' }, { label: 'sqlite' }] },
        { question: 'Which region?', options: [{ label: 'eu' }, { label: 'us' }] },
      ],
    },
    ...overrides,
  }
}

/** A decision (approval) interaction. */
function decisionInteraction(overrides: Partial<FakeInteractionRecord> = {}): FakeInteractionRecord {
  return {
    interactionId: 'i-decision',
    revision: '3',
    executionId: 'exec-9',
    toolCallId: 'call-2',
    status: 'pending',
    summary: 'Approve: rm -rf /tmp/build',
    kind: 'decision',
    ...overrides,
  }
}

/** The assistant message a completed run leaves behind. */
function terminalMessage(text: string, parts?: FakeMessageRecord['parts']): FakeMessageRecord {
  return {
    messageId: 'm-assistant',
    revision: '1',
    role: 'assistant',
    status: 'success',
    parts: parts ?? [{ kind: 'text', text }],
  }
}

/** The peer error a rejected tool call surfaces, or undefined when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<JsonRpcRequestError | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    if (error instanceof JsonRpcRequestError) return error
    throw error
  }
}

/**
 * The execution the run adopted. The peer stamps its OWN executionId onto a
 * pushed interaction, so the value the cache holds is the live one — asserted
 * by reading it back from the send's receipt rather than hardcoding the
 * fixture's.
 */
function softExecutionId(rig: Rig): string {
  const accepted = rig.fake.commandCallsFor('agent.messages.send')
  expect(accepted).toHaveLength(1)
  return String(rig.fake.receiptFor(String(accepted[0]!['commandId']))?.['executionId'])
}

describe('interactive cherry tools over a real loopback channel', () => {
  // -------------------------------------------------------------------------
  // ① cherry_create
  // -------------------------------------------------------------------------

  it('①a cherry_create refuses a call that specifies no workspace form at all', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })

    // The protocol declares TWO union branches, both requiring a workspace
    // selection, and there is no "unspecified" form: the tool must refuse in
    // band rather than pick an implicit default.
    const result = (await rig.call('cherry_create', {
      device: 'dev-A',
      agentId: 'agent-1',
    })) as { error?: string }

    expect(result.error).toBeDefined()
    // The refusal is a PRE-WIRE verdict: no command reached the peer.
    expect(rig.fake.commandCallsFor('agent.sessions.create')).toHaveLength(0)
  })

  it('①b cherry_create maps workspaceId to the registered branch and reads the identity back with sessions.get', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })

    const result = (await rig.call('cherry_create', {
      device: 'dev-A',
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      title: 'Fresh chat',
    })) as { sessionId: string; workspaceId?: string; workspaceKind?: string }

    // The receipt carries ONLY the sessionId (protocol `result:{sessionId}`):
    // any workspace identity must come from the second call.
    const calls = rig.fake.commandCallsFor('agent.sessions.create')
    expect(calls).toHaveLength(1)
    expect(calls[0]!['workspaceId']).toBe('ws-1')
    expect(calls[0]!['workspace']).toBeUndefined()
    expect(typeof calls[0]!['commandId']).toBe('string')
    expect(result.workspaceId).toBe('ws-1')
    expect(result.workspaceKind).toBe('registered')
    // The two-step read-back really happened.
    expect(rig.fake.readCallsFor('agent.sessions.get').length).toBeGreaterThanOrEqual(1)
  })

  it('①c cherry_create maps workspace:"system" to the system branch and reads its kind back', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })

    const result = (await rig.call('cherry_create', {
      device: 'dev-A',
      agentId: 'agent-1',
      workspace: 'system',
    })) as { sessionId: string; workspaceKind?: string }

    const calls = rig.fake.commandCallsFor('agent.sessions.create')
    expect(calls).toHaveLength(1)
    // The registered branch's `workspaceId` is ABSENT; the discriminant forms
    // are mutually exclusive.
    expect(calls[0]!['workspaceId']).toBeUndefined()
    expect(calls[0]!['workspace']).toEqual({ kind: 'system' })
    // The system workspace's identity is only observable through the read-back.
    expect(result.workspaceKind).toBe('system')
  })

  // -------------------------------------------------------------------------
  // ② cherry_send: terminal aggregation, including a {ref} part
  // -------------------------------------------------------------------------

  it('② cherry_send waits for the terminal execution and aggregates the assistant text, resolving {ref} parts', async () => {
    // 30 KiB is above the peer's inline limit, so the part travels as a {ref}
    // and its bytes exist only behind agent.content.read.
    const big = 'B'.repeat(30 * 1024)
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        terminalMessage: terminalMessage('', [
          { kind: 'text', text: 'done:' },
          { kind: 'text', text: big },
        ]),
      },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'hello',
      timeoutMs: 5_000,
    })) as { status: string; text: string; executionId?: string }

    expect(result.status).toBe('completed')
    // The aggregated text carries BOTH parts, and the 30 KiB one came back
    // through the externalized path — not as an empty placeholder.
    expect(result.text).toContain('done:')
    expect(result.text).toContain(big)

    // The externalized read really happened over the wire.
    expect(rig.fake.readCallsFor('agent.content.read').length).toBeGreaterThanOrEqual(1)
    for (const call of rig.fake.readCallsFor('agent.content.read')) {
      expect(call['maxBytes'] as number).toBeLessThanOrEqual(24 * 1024)
    }
  })

  it('②b cherry_send passes expectedIdleRevision from the subscription cache, not from the caller', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], terminalMessage: terminalMessage('ok') },
    })

    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'hi', timeoutMs: 5_000 })

    const calls = rig.fake.commandCallsFor('agent.messages.send')
    expect(calls).toHaveLength(1)
    // The revision is a numeric string drawn from the session snapshot; the
    // caller supplied no such parameter.
    expect(calls[0]!['expectedIdleRevision']).toBe('1')
    expect(typeof calls[0]!['commandId']).toBe('string')
    expect(calls[0]!['text']).toBe('hi')
  })

  // -------------------------------------------------------------------------
  // ③ soft terminal: send → interaction.updated → respond → cherry_wait
  // -------------------------------------------------------------------------

  it('③ a pending question turns the wait into a SOFT terminal, and cherry_wait resumes to the real one', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        pushInteractionOnRun: questionInteraction(),
      },
    })

    // The peer pushes the interaction instead of a terminal execution.
    const soft = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'ask me',
      timeoutMs: 5_000,
    })) as { status: string; kind?: string; interactionId?: string; summary?: string }

    expect(soft.status).toBe('awaiting-interaction')
    // The soft terminal is LABELLED with the interaction kind.
    expect(soft.kind).toBe('question')
    expect(soft.interactionId).toBe('i-question')
    expect(soft.summary).toBe('The agent needs two answers')

    // The three staleness parameters come from the CACHE, not the caller.
    const answer = (await rig.call('cherry_respond', {
      device: 'dev-A',
      sessionId: 's-1',
      interactionId: 'i-question',
      response: { kind: 'answer', answers: { 'Which database?': 'postgres', 'Which region?': 'eu' } },
    })) as { status: string }
    expect(answer.status).toBe('applied')

    const respondCalls = rig.fake.commandCallsFor('agent.interactions.respond')
    expect(respondCalls).toHaveLength(1)
    expect(respondCalls[0]!['expectedRevision']).toBe('7')
    // The execution is the LIVE run the interaction was pushed for (the peer
    // stamps its own executionId, overwriting the fixture's) — read from the
    // cache, never from the caller.
    expect(respondCalls[0]!['expectedExecutionId']).toBe(softExecutionId(rig))
    expect(typeof respondCalls[0]!['inputDigest']).toBe('string')
    expect(respondCalls[0]!['inputDigest']).toHaveLength(64)

    // The interaction is settled: a resumed wait must NOT re-report it as
    // pending, and an empty session returns the current snapshot at once.
    const resumed = (await rig.call('cherry_wait', {
      device: 'dev-A',
      sessionId: 's-1',
      timeoutMs: 1_000,
    })) as { status: string }
    expect(['completed', 'idle']).toContain(resumed.status)
  })

  // -------------------------------------------------------------------------
  // ④ approve-on-question: the COMMAND RECEIPT surface
  // -------------------------------------------------------------------------

  it('④ approving a question is refused by a COMMAND RECEIPT with the fixed message, while deny is accepted', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], interactions: [questionInteraction()] },
    })

    const approve = (await rig.call('cherry_respond', {
      device: 'dev-A',
      sessionId: 's-1',
      interactionId: 'i-question',
      decision: 'approve',
    })) as { status: string; error?: { reason: string; message: string } }

    // TWO SURFACES, asserted separately: this is a command RECEIPT, not an RPC
    // error — the call RESOLVED with a rejected receipt.
    expect(approve.status).toBe('rejected')
    expect(approve.error?.reason).toBe('CONFLICT')
    expect(approve.error?.message).toBe('Question requires answers')

    // deny is the sanctioned fallback for a question: the peer accepts it.
    const deny = (await rig.call('cherry_respond', {
      device: 'dev-A',
      sessionId: 's-1',
      interactionId: 'i-question',
      decision: 'deny',
    })) as { status: string }
    expect(deny.status).toBe('applied')
  })

  // -------------------------------------------------------------------------
  // ⑤ text length pre-validation
  // -------------------------------------------------------------------------

  it('⑤ cherry_send rejects a 40k text BEFORE any wire call', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], terminalMessage: terminalMessage('ok') },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'x'.repeat(40_000),
      timeoutMs: 5_000,
    })) as { error?: string; limit?: number }

    expect(result.error).toBeDefined()
    expect(result.limit).toBe(TEXT_LIMIT)
    // Pre-validation means NO command was ever issued.
    expect(rig.fake.commandCallsFor('agent.messages.send')).toHaveLength(0)
  })

  it('⑤b cherry_send accepts exactly the protocol ceiling', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], terminalMessage: terminalMessage('ok') },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'y'.repeat(TEXT_LIMIT),
      timeoutMs: 5_000,
    })) as { status: string }

    expect(result.status).toBe('completed')
    expect(rig.fake.commandCallsFor('agent.messages.send')).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // ⑥ timeout is NOT a failure
  // -------------------------------------------------------------------------

  it('⑥ a 1s timeout returns partial content plus a resume cursor instead of failing', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        // The run has ALREADY produced a partial assistant message when the
        // window elapses: a timeout must hand that back rather than discard it.
        messages: [
          {
            messageId: 'm-partial',
            revision: '1',
            role: 'assistant',
            status: 'pending',
            parts: [{ kind: 'text', text: 'here is the first half' }],
          },
        ],
        terminalMessage: terminalMessage('never arrives in time'),
        // The run's terminal event lands far beyond the caller's window.
        runDelayMs: 30_000,
      },
    })

    const started = Date.now()
    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'slow',
      timeoutMs: 1_000,
    })) as { status: string; cursor?: { seq?: string }; text?: string; messages?: unknown[] }
    const elapsed = Date.now() - started

    // NOT a failure: the call RESOLVED.
    expect(result.status).toBe('timeout')
    // The wait genuinely ran its window and then gave up — it did not hang.
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(elapsed).toBeLessThan(10_000)
    // The partial content produced so far is INCLUDED.
    expect(result.text).toContain('here is the first half')
    expect(result.messages?.length).toBeGreaterThanOrEqual(1)
    // The caller can continue from here.
    expect(result.cursor).toBeDefined()
    expect(typeof result.cursor?.seq).toBe('string')
  })

  // -------------------------------------------------------------------------
  // ⑦ cherry_cancel's REQUIRED parameter
  // -------------------------------------------------------------------------

  it('⑦ cherry_cancel declares expectedExecutionId as required in the REGISTERED schema', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })

    const definition = rig.tool('cherry_cancel')
    // The host's literal-schema validation layer is what intercepts a missing
    // parameter — so the assertion is on the DECLARATION, not on a runtime
    // error thrown inside the tool body.
    expect(definition.parameters.required).toContain('expectedExecutionId')
    expect(definition.parameters.required).toContain('device')
    expect(definition.parameters.required).toContain('sessionId')
    expect(Object.keys(definition.parameters.properties)).toContain('expectedExecutionId')
  })

  it('⑦b cherry_cancel takes the active execution from the subscription cache and cancels it', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [{ ...SESSION, activeExecutionId: 'exec-live' }] },
    })

    // Prime the subscription cache: the active execution arrives with the
    // session snapshot the cache is built from.
    await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })

    const result = (await rig.call('cherry_cancel', { device: 'dev-A', sessionId: 's-1' })) as {
      status: string
      executionId?: string
    }

    expect(result.status).toBe('applied')
    const calls = rig.fake.commandCallsFor('agent.executions.cancel')
    expect(calls).toHaveLength(1)
    // The id came from the cache, never from the caller.
    expect(calls[0]!['expectedExecutionId']).toBe('exec-live')
  })

  it('⑦c cherry_cancel refuses a caller-supplied execution the cache does not hold', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [{ ...SESSION, activeExecutionId: 'exec-live' }] },
    })
    await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })

    const result = (await rig.call('cherry_cancel', {
      device: 'dev-A',
      sessionId: 's-1',
      expectedExecutionId: 'exec-stale',
    })) as { error?: string; expectedExecutionId?: string }

    // A stale caller is told what the cache holds instead of cancelling
    // whatever happens to be running now.
    expect(result.error).toBe('execution-mismatch')
    expect(result.expectedExecutionId).toBe('exec-live')
    expect(rig.fake.commandCallsFor('agent.executions.cancel')).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // ⑧ cherry_interactions: the peer's full set, filtered CLIENT-side
  // -------------------------------------------------------------------------

  it('⑧ cherry_interactions filters the peer\'s FULL set down to pending, and an all-answered session yields an empty array', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        interactions: [
          questionInteraction({ interactionId: 'i-pending', status: 'pending', revision: '2' }),
          decisionInteraction({ interactionId: 'i-approved', status: 'approved', revision: '4' }),
          decisionInteraction({ interactionId: 'i-denied', status: 'denied', revision: '5' }),
          decisionInteraction({ interactionId: 'i-expired', status: 'expired', revision: '6' }),
        ],
      },
    })

    const result = (await rig.call('cherry_interactions', {
      device: 'dev-A',
      sessionId: 's-1',
    })) as { items: Array<{ interactionId: string; kind?: string; summary?: string }> }

    // The PEER returned all four (the real `interactionsOf` merges and never
    // filters); only the pending one survives the plugin-side filter.
    expect(result.items.map((item) => item.interactionId)).toEqual(['i-pending'])
    expect(result.items[0]!.kind).toBe('question')
    expect(result.items[0]!.summary).toBe('The agent needs two answers')

    // The peer was really asked for the whole set — at the byte-safe page
    // clamp (2/page) that is two pages, walked to completion.
    expect(rig.fake.commandCallsFor('agent.interactions.list')).toHaveLength(2)

    // Now every interaction is answered: the pending filter yields EMPTY.
    rig.fake.setInteractionStatus('i-pending', 'approved')
    const empty = (await rig.call('cherry_interactions', {
      device: 'dev-A',
      sessionId: 's-1',
    })) as { items: unknown[] }
    expect(empty.items).toEqual([])
  })

  // -------------------------------------------------------------------------
  // ⑨ cherry_wait on an idle session
  // -------------------------------------------------------------------------

  it('⑨ cherry_wait on a session with no in-flight execution returns the current snapshot AT ONCE', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })

    const started = Date.now()
    const result = (await rig.call('cherry_wait', {
      device: 'dev-A',
      sessionId: 's-1',
      timeoutMs: 30_000,
    })) as { status: string }
    const elapsed = Date.now() - started

    // `idle` — an ANSWER, not an error and not a 30s park.
    expect(result.status).toBe('idle')
    expect(elapsed).toBeLessThan(2_000)
    // And no waiter silently mutated the peer's view.
    expect(rig.fake.ackCalls).toHaveLength(0)
  })

  it('⑨b cherry_wait declares the 120000 default in its schema, and an omitted timeoutMs on an idle session still returns at once', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })
    const definition = rig.tool('cherry_wait')
    // The tool accepts timeoutMs and the brief pins the default at 120000.
    expect(Object.keys(definition.parameters.properties)).toContain('timeoutMs')
    expect(JSON.stringify(definition.parameters)).toContain('120000')

    // The default must NEVER be waited for on an idle session: the empty-session
    // answer is immediate, so the 120000 window is never entered at all.
    const started = Date.now()
    const result = (await rig.call('cherry_wait', { device: 'dev-A', sessionId: 's-1' })) as {
      status: string
    }
    expect(result.status).toBe('idle')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  // -------------------------------------------------------------------------
  // ⑩ the CONFLICT RPC surface (distinct from ④'s receipt surface)
  // -------------------------------------------------------------------------

  it('⑩ a duplicate subscription is an RPC ERROR, the other of the two CONFLICT surfaces', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })

    // Prime a live subscription for the session.
    const first = (await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })) as {
      events: unknown[]
    }
    expect(first.events).toEqual([])
    expect(rig.fake.subscriptions.filter((entry) => entry.phase === 'active')).toHaveLength(1)

    // The same session's subscribe, issued RAW at the peer while the first is
    // still active: the protocol's CONFLICT. Asserting it here pins the RPC
    // surface explicitly, so ④'s command-receipt surface cannot be confused
    // with it (spec §6: the two must be told apart).
    const before = rig.fake.subscribeCalls.length
    const error = await rejectionOf(rig.rawRequest('agent.sessions.subscribe', { sessionId: 's-1' }))
    expect(error).toBeDefined()
    expect((error!.data as { reason?: string }).reason).toBe('CONFLICT')
    // The peer RECORDED the refusal as an error-mode subscribe attempt.
    const attempts = rig.fake.subscribeCalls
    expect(attempts.length).toBe(before + 1)
    expect(attempts[attempts.length - 1]!.mode).toBe('error')
    expect(attempts[attempts.length - 1]!.reason).toBe('CONFLICT')

    // The TOOL path itself never provokes it: a second cherry_events leaves the
    // subscription count unchanged rather than re-subscribing into CONFLICT.
    const afterConflict = rig.fake.subscribeCalls.length
    await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })
    expect(rig.fake.subscribeCalls.length).toBe(afterConflict)
  })

  // -------------------------------------------------------------------------
  // ⑪ IDEMPOTENCY_CONFLICT passthrough
  // -------------------------------------------------------------------------

  it('⑪ reusing a commandId with a different body is refused with IDEMPOTENCY_CONFLICT', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], terminalMessage: terminalMessage('ok') },
    })

    // Two SENDS under one id, with different text: the peer's ledger accepts
    // the first and refuses the second. The tool must not retry its way around
    // it, and the failure must reach the caller unwrapped.
    const first = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'first body',
      commandId: 'cmd-shared',
      wait: false,
    })) as { commandId: string }
    expect(first.commandId).toBe('cmd-shared')

    const error = await rejectionOf(
      rig.call('cherry_send', {
        device: 'dev-A',
        sessionId: 's-1',
        text: 'a DIFFERENT body',
        commandId: 'cmd-shared',
        wait: false,
      }),
    )
    expect(error).toBeDefined()
    expect((error!.data as { reason?: string }).reason).toBe('IDEMPOTENCY_CONFLICT')
    // The §6 HINT rides along on the message, so the caller is told the one
    // thing that makes a retry work (a fresh id) instead of retrying the same
    // body under the same id forever. The REASON and the structured data are
    // untouched — only the prose grew.
    expect(error!.message.toLowerCase()).toContain('regenerate the commandid')
    expect(error!.message.toLowerCase()).toContain('never reuse')
  })

  it('⑪b the IDEMPOTENCY_CONFLICT hint never replaces the peer failure currency', async () => {
    // The hint must not become a translation: a caller branching on
    // `instanceof JsonRpcRequestError` and on `data.reason` must see exactly
    // what the peer sent, for the hinted failure as much as any other.
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], terminalMessage: terminalMessage('ok') },
    })

    await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'first body',
      commandId: 'cmd-currency',
      wait: false,
    })
    const error = await rejectionOf(
      rig.call('cherry_send', {
        device: 'dev-A',
        sessionId: 's-1',
        text: 'changed body',
        commandId: 'cmd-currency',
        wait: false,
      }),
    )

    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error!.data as { reason?: string }).reason).toBe('IDEMPOTENCY_CONFLICT')
    // The peer's own message survives as a PREFIX: the hint is appended, not
    // substituted.
    expect(error!.message).toMatch(/^Command body differs from the recorded command/)
  })

  // -------------------------------------------------------------------------
  // ⑫ wait=false
  // -------------------------------------------------------------------------

  it('⑫ wait=false returns the command receipt immediately and the terminal is still reachable afterwards', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        terminalMessage: terminalMessage('finished later'),
        runDelayMs: 4_000,
      },
    })

    const started = Date.now()
    const receipt = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'fire and forget',
      wait: false,
    })) as { status: string; commandId: string; executionId?: string }
    const elapsed = Date.now() - started

    // The receipt comes back WITHOUT waiting for the run — the run's terminal
    // event is 4s away, and the default window would have been 120s.
    expect(receipt.status).toBe('applied')
    expect(typeof receipt.commandId).toBe('string')
    expect(elapsed).toBeLessThan(1_000)
    expect(rig.fake.executionUpdates).toHaveLength(0)

    // The command really was admitted (the run is genuinely in flight).
    expect(rig.fake.commandCallsFor('agent.messages.send')).toHaveLength(1)

    // The terminal is still observable through the follow-up surfaces: a
    // cherry_wait parks until the run settles rather than reporting `idle`.
    const waited = (await rig.call('cherry_wait', {
      device: 'dev-A',
      sessionId: 's-1',
      timeoutMs: 10_000,
    })) as { status: string; text?: string }
    expect(waited.status).toBe('completed')
    expect(waited.text).toBe('finished later')

    const events = (await rig.call('cherry_events', {
      device: 'dev-A',
      sessionId: 's-1',
    })) as { events: Array<{ kind?: string }> }
    expect(events.events.some((event) => event.kind === 'execution.updated')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // ⑬ the missing-answer refusal, discriminated from ④ BY MESSAGE
  // -------------------------------------------------------------------------

  it('⑬ answers missing a question key are refused by receipt — same reason and status as ④, a different message', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], interactions: [questionInteraction()] },
    })

    const partial = (await rig.call('cherry_respond', {
      device: 'dev-A',
      sessionId: 's-1',
      interactionId: 'i-question',
      // Only ONE of the two required question keys.
      response: { kind: 'answer', answers: { 'Which database?': 'postgres' } },
    })) as { status: string; error?: { reason: string; message: string } }

    expect(partial.status).toBe('rejected')
    expect(partial.error?.reason).toBe('CONFLICT')
    expect(partial.error?.message).toBe('Every question requires an answer')
    // The message never names the missing key: the wire文案 is fixed.
    expect(partial.error?.message).not.toContain('Which region?')
    // NO PARTIAL COMMIT: the interaction is still pending.
    expect(rig.fake.interactions[0]!.status).toBe('pending')

    // ④'s refusal differs ONLY by message — same reason, same status. Asserting
    // both here keeps one from masking the other.
    const approve = (await rig.call('cherry_respond', {
      device: 'dev-A',
      sessionId: 's-1',
      interactionId: 'i-question',
      decision: 'approve',
    })) as { status: string; error?: { reason: string; message: string } }
    expect(approve.status).toBe(partial.status)
    expect(approve.error?.reason).toBe(partial.error?.reason)
    expect(approve.error?.message).not.toBe(partial.error?.message)

    // A BLANK answer is not an answer either.
    const blank = (await rig.call('cherry_respond', {
      device: 'dev-A',
      sessionId: 's-1',
      interactionId: 'i-question',
      response: { kind: 'answer', answers: { 'Which database?': 'postgres', 'Which region?': '  ' } },
    })) as { status: string; error?: { message: string } }
    expect(blank.status).toBe('rejected')
    expect(blank.error?.message).toBe('Every question requires an answer')

    // Finally the FULL answer set is accepted.
    const full = (await rig.call('cherry_respond', {
      device: 'dev-A',
      sessionId: 's-1',
      interactionId: 'i-question',
      response: { kind: 'answer', answers: { 'Which database?': 'postgres', 'Which region?': 'eu' } },
    })) as { status: string }
    expect(full.status).toBe('applied')
    expect(rig.fake.interactions[0]!.status).toBe('approved')
  })

  // -------------------------------------------------------------------------
  // ⑭ the injected `interrupted` terminal
  // -------------------------------------------------------------------------

  it('⑭ an injected terminal `interrupted` converges the waiter instead of hanging to the timeout', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        runTerminalStatus: 'interrupted',
        terminalMessage: terminalMessage('cut short'),
      },
    })

    // The fixture must SATISFY executionSchema's terminal superRefine
    // (messageId + a persistence outcome), or the schema layer would reject it
    // before the waiter could ever see it — proving nothing.
    const started = Date.now()
    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'interrupt me',
      // A LONG window: if the waiter were to ignore `interrupted`, this test
      // would park here instead of returning.
      timeoutMs: 30_000,
    })) as { status: string }
    const elapsed = Date.now() - started

    expect(result.status).toBe('interrupted')
    expect(elapsed).toBeLessThan(5_000)

    // The emitted event really was a terminal `interrupted` carrying the
    // persistence fields the schema demands.
    const terminal = rig.fake.executionUpdates.find((update) => update.status === 'interrupted')
    expect(terminal).toBeDefined()
    expect(terminal!.messageId).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // ⑯ a receipt with NO executionId: the waiter ADOPTS its run
  // -------------------------------------------------------------------------

  it('⑯ a send whose receipt carries no executionId still converges on ITS OWN terminal', async () => {
    // `executionId` is SCHEMA-OPTIONAL on the receipt, so a peer may admit a
    // command without naming the run. The waiter then has no id to attribute
    // `execution.updated` events to — and a waiter that simply requires one
    // parks until its timeout, reporting `timeout` for a run that finished.
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        omitSendExecutionId: true,
        // The terminal message MUST already be in the session history under the
        // SAME id the terminal names: the run-scoped aggregate cuts at that id,
        // so a mismatched fixture would report an empty text for reasons that
        // have nothing to do with adoption.
        terminalMessage: { ...terminalMessage('adopted run reply'), messageId: 'm-adopted' },
        runMessageId: 'm-adopted',
      },
    })

    const started = Date.now()
    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'adopt my run',
      // A long window: a waiter that never adopts parks here instead.
      timeoutMs: 30_000,
    })) as { status: string; executionId?: string; text?: string }
    const elapsed = Date.now() - started

    // The receipt really did omit the id, so the run had to be adopted.
    const sent = rig.fake.commandCallsFor('agent.messages.send').at(-1)!
    const receipt = rig.fake.receiptFor(String(sent['commandId']))!
    expect(receipt['executionId']).toBeUndefined()

    // The waiter converged on the ADOPTED run's terminal — not on a timeout and
    // not on some other run's status.
    expect(result.status).toBe('completed')
    expect(elapsed).toBeLessThan(5_000)
    const terminal = rig.fake.executionUpdates.at(-1)!
    expect(terminal.status).toBe('completed')
    expect(result.executionId).toBe(terminal.executionId)
    // ...and the aggregate is the run's OWN message, proving the adopted id
    // drove run-scoped text selection rather than a fallback.
    expect(result.text).toBe('adopted run reply')
  })

  it('⑯b adoption is ONE-TIME: a later unrelated terminal does not steal the wait', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        omitSendExecutionId: true,
        terminalMessage: terminalMessage('first run'),
        runDelayMs: 250,
      },
    })

    // Start the wait with no attributable id, then push an UNRELATED
    // execution's terminal while the adopted run is still in flight. A waiter
    // that re-adopts on every pass would report the intruder's status.
    const pending = rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'adopt once',
      timeoutMs: 30_000,
    }) as Promise<{ status: string; executionId?: string }>

    // Let the send's run start, then inject a competing terminal.
    await sleep(80)
    rig.fake.pushEvent('s-1', {
      kind: 'execution.updated',
      payload: {
        executionId: 'exec-intruder',
        status: 'failed',
        messageId: 'm-intruder',
        durable: true,
        history: { messageRevision: '1', historyRevision: '1' },
        error: { reason: 'INTERNAL', message: 'Intruder' },
      },
    })

    const result = await pending
    // The adopted run is the one this send started, and its terminal is the
    // outcome — never the intruder's `failed`.
    expect(result.status).toBe('completed')
    expect(result.executionId).not.toBe('exec-intruder')
  })

  // -------------------------------------------------------------------------
  // ⑮ TARGET_UNAVAILABLE passthrough + same-id replay
  // -------------------------------------------------------------------------

  it('⑮ a TARGET_UNAVAILABLE receipt passes through, and the same commandId replays the same refusal', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], sendOutcome: 'target-unavailable' },
    })

    const first = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'undeliverable',
      wait: false,
      commandId: 'cmd-target',
    })) as { status: string; error?: { reason: string } }

    expect(first.status).toBe('rejected')
    expect(first.error?.reason).toBe('TARGET_UNAVAILABLE')

    // The SAME id with the same body replays the recorded refusal: retrying
    // cannot turn it into success, so the caller must fix the target and use a
    // NEW commandId.
    const replay = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'undeliverable',
      wait: false,
      commandId: 'cmd-target',
    })) as { status: string; error?: { reason: string } }
    expect(replay.status).toBe('rejected')
    expect(replay.error?.reason).toBe('TARGET_UNAVAILABLE')

    // The peer really did see ONE admitted command, served twice.
    expect(rig.fake.commandCallsFor('agent.messages.send')).toHaveLength(2)
  })

  it('⑮b cancel passes a TARGET_UNAVAILABLE receipt through as well', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [{ ...SESSION, activeExecutionId: 'exec-live' }],
        cancelOutcome: 'target-unavailable',
      },
    })
    await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })

    const receipt = (await rig.call('cherry_cancel', {
      device: 'dev-A',
      sessionId: 's-1',
    })) as { status: string; error?: { reason: string } }

    expect(receipt.status).toBe('rejected')
    expect(receipt.error?.reason).toBe('TARGET_UNAVAILABLE')
  })

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  it('registers the interactive tools alongside the read-only set', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })
    const names = rig.ctx.definitions.map((definition) => definition.name)
    for (const name of [
      'cherry_create',
      'cherry_send',
      'cherry_wait',
      'cherry_interactions',
      'cherry_respond',
      'cherry_cancel',
    ]) {
      expect(names).toContain(name)
    }
    for (const definition of rig.ctx.definitions) {
      expect(definition.parameters.type).toBe('object')
      expect(definition.parameters.additionalProperties).toBe(false)
    }
  })

  it('every interactive tool refuses an ambiguous device selector with candidates, without dialing', async () => {
    const rig = await makeRig(
      { agent: { agents: [AGENT], sessions: [SESSION] } },
      { extraDevices: [{ deviceId: 'dev-B', displayName: 'Desk Alpha Two' }] },
    )
    const before = rig.fake.requestCount
    // The store warns once when its archive does not exist yet — that is the
    // store's own first-load path, not the tools'. Clear it so the assertion
    // below is about what the TOOLS logged.
    consoleWarn.mockClear()
    for (const [name, args] of [
      ['cherry_create', { device: 'Desk', agentId: 'agent-1', workspaceId: 'ws-1' }],
      ['cherry_send', { device: 'Desk', sessionId: 's-1', text: 'hi' }],
      ['cherry_wait', { device: 'Desk', sessionId: 's-1' }],
      ['cherry_interactions', { device: 'Desk', sessionId: 's-1' }],
      ['cherry_cancel', { device: 'Desk', sessionId: 's-1' }],
    ] as const) {
      const result = (await rig.call(name, args as Record<string, unknown>)) as {
        error?: string
        candidates?: string[]
      }
      expect(result.error).toBe('ambiguous-device')
      expect(result.candidates?.length).toBeGreaterThan(0)
    }
    // Not one of those refusals reached the peer.
    expect(rig.fake.requestCount).toBe(before)
    expect(consoleWarn).not.toHaveBeenCalled()
  })

  it('keeps the console pristine across the whole interactive face', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], terminalMessage: terminalMessage('quiet') },
    })
    consoleWarn.mockClear()
    await rig.call('cherry_create', { device: 'dev-A', agentId: 'agent-1', workspaceId: 'ws-1' })
    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'hi', timeoutMs: 5_000 })
    await rig.call('cherry_wait', { device: 'dev-A', sessionId: 's-1', timeoutMs: 500 })
    await rig.call('cherry_interactions', { device: 'dev-A', sessionId: 's-1' })
    expect(consoleWarn).not.toHaveBeenCalled()
  })
})

/**
 * Regression suite for the three defects the Task 9 review found. Each test
 * reproduces the reviewer's exact probe, so a re-introduction fails here rather
 * than silently returning a wrong answer.
 */
describe('interactive tools: review regressions', () => {
  it('C1: a SECOND send on one session waits for ITS OWN terminal, not the first run\'s', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        terminalMessage: terminalMessage('ok'),
        runDelayMs: 50,
      },
    })

    // Run 1 finishes quickly, leaving a `completed` terminal in the buffer.
    const first = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'one',
      timeoutMs: 5_000,
    })) as { status: string; executionId: string }
    expect(first.status).toBe('completed')

    // Run 2 is SLOW. A waiter reading the cumulative buffer's stale terminal
    // returned `completed` in ~140ms here while run 2 was still in flight,
    // reporting run 1's executionId.
    rig.fake.setRunDelay(600)
    const started = Date.now()
    const second = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'two',
      timeoutMs: 5_000,
    })) as { status: string; executionId: string }
    const elapsed = Date.now() - started

    expect(second.status).toBe('completed')
    // It waited for ITS OWN run…
    expect(elapsed).toBeGreaterThanOrEqual(500)
    // …and named its own execution, never the previous run's.
    expect(second.executionId).not.toBe(first.executionId)
    const runs = rig.fake.executionUpdates.filter((update) => update.status === 'completed')
    expect(runs.map((update) => update.executionId)).toEqual([first.executionId, second.executionId])
  })

  it('C1b: cherry_wait does not adopt an OLD terminal still sitting in the buffer', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        terminalMessage: terminalMessage('ok'),
        runDelayMs: 50,
      },
    })

    // Run 1 settles, leaving its terminal in the cumulative buffer.
    const first = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'one',
      timeoutMs: 5_000,
    })) as { executionId: string }

    // Run 2 is in flight; a wait must park for run 2, not answer with run 1.
    rig.fake.setRunDelay(600)
    const send = rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'two',
      timeoutMs: 5_000,
    })
    // Give the send time to be admitted, then wait on the session.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const started = Date.now()
    const waited = (await rig.call('cherry_wait', {
      device: 'dev-A',
      sessionId: 's-1',
      timeoutMs: 5_000,
    })) as { status: string; executionId?: string }

    expect(waited.status).toBe('completed')
    expect(waited.executionId).not.toBe(first.executionId)
    await send
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  })

  it('C1c: a FOREIGN execution\'s terminal arriving mid-wait does not settle it', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        // The session's own run is in flight and has NOT settled.
        sessions: [{ ...SESSION, activeExecutionId: 'exec-mine' }],
        terminalMessage: terminalMessage('ok'),
      },
    })
    await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })

    const waiting = rig.call('cherry_wait', { device: 'dev-A', sessionId: 's-1', timeoutMs: 3_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))

    // A DIFFERENT execution's terminal lands while the wait is parked. The
    // baseline alone cannot exclude it — it arrives AFTER the wait began — so
    // only attribution to the awaited execution keeps this wait honest.
    rig.fake.pushEvent('s-1', {
      kind: 'execution.updated',
      payload: {
        executionId: 'exec-foreign',
        status: 'completed',
        messageId: 'm-assistant',
        durable: true,
        history: { messageRevision: '1', historyRevision: '1' },
      },
    })

    const raced = await Promise.race([
      waiting.then((value) => value as { status: string; executionId?: string }),
      new Promise<{ status: string }>((resolve) => setTimeout(() => resolve({ status: 'STILL-WAITING' }), 800)),
    ])

    // The foreign terminal must NOT be adopted…
    expect(raced.status).toBe('STILL-WAITING')

    // …and the wait still resolves correctly once its OWN run settles.
    rig.fake.pushEvent('s-1', {
      kind: 'execution.updated',
      payload: {
        executionId: 'exec-mine',
        status: 'completed',
        messageId: 'm-assistant',
        durable: true,
        history: { messageRevision: '1', historyRevision: '1' },
      },
    })
    const settled = (await waiting) as { status: string; executionId?: string }
    expect(settled.status).toBe('completed')
    expect(settled.executionId).toBe('exec-mine')
  })

  it('I2: a SETTLED interaction never poisons the execution cache', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        // The session is IDLE; only an already-approved card is on record.
        interactions: [decisionInteraction({ interactionId: 'i-old', status: 'approved', executionId: 'exec-old' })],
      },
    })
    await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })

    // Listing (which records the card) must not make the idle session look busy.
    const listed = (await rig.call('cherry_interactions', {
      device: 'dev-A',
      sessionId: 's-1',
    })) as { items: unknown[] }
    expect(listed.items).toEqual([])

    const cancel = (await rig.call('cherry_cancel', { device: 'dev-A', sessionId: 's-1' })) as {
      error?: string
    }
    // The in-band verdict, NOT the peer's rejected CONFLICT for a dead run…
    expect(cancel.error).toBe('no-active-execution')
    // …and nothing was ever sent for it.
    expect(rig.fake.commandCallsFor('agent.executions.cancel')).toHaveLength(0)
  })

  it('I2b: the peer\'s LIVE execution outranks a stale cached one', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [{ ...SESSION, activeExecutionId: 'exec-live' }],
        // A stale card names a DIFFERENT execution than the live one.
        interactions: [questionInteraction({ interactionId: 'i-stale', executionId: 'exec-stale' })],
      },
    })
    await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })
    await rig.call('cherry_interactions', { device: 'dev-A', sessionId: 's-1' })

    // A caller holding the CORRECT live id must be accepted, not told it is wrong.
    const result = (await rig.call('cherry_cancel', {
      device: 'dev-A',
      sessionId: 's-1',
      expectedExecutionId: 'exec-live',
    })) as { status?: string; error?: string; expectedExecutionId?: string }

    expect(result.error).toBeUndefined()
    expect(result.status).toBe('applied')
    const calls = rig.fake.commandCallsFor('agent.executions.cancel')
    expect(calls).toHaveLength(1)
    expect(calls[0]!['expectedExecutionId']).toBe('exec-live')
  })

  it('I2c: a settled interaction itself never SEEDS the active-execution cache', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        // The peer is IDLE. A settled card on record must not make it look busy.
        sessions: [SESSION],
        interactions: [decisionInteraction({ interactionId: 'i-old', status: 'denied', executionId: 'exec-old' })],
      },
    })
    await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })
    await rig.call('cherry_interactions', { device: 'dev-A', sessionId: 's-1' })

    const refused = (await rig.call('cherry_cancel', { device: 'dev-A', sessionId: 's-1' })) as {
      error?: string
    }
    expect(refused.error).toBe('no-active-execution')
    // No wire call at all — the refusal is in band, not the peer's CONFLICT.
    expect(rig.fake.commandCallsFor('agent.executions.cancel')).toHaveLength(0)
  })

  it('I3: with two pendings, answering the SECOND still soft-terminals on the FIRST', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], activeExecutionId: 'exec-live' },
    })

    // Prime the subscription FIRST: the peer only delivers events to an ACTIVE
    // subscription, so a push before this would be dropped rather than tested.
    await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })

    // Both pendings arrive LIVE — the real-time stream the soft-terminal
    // predicate is defined over — before the wait starts.
    rig.fake.pushEvent('s-1', {
      kind: 'interaction.updated',
      payload: {
        interactionId: 'i-first',
        revision: '2',
        executionId: 'exec-live',
        toolCallId: 'call-first',
        status: 'pending',
        summary: 'First question',
        kind: 'question',
        inputDigest: 'a'.repeat(64),
        input: { text: JSON.stringify({ questions: [{ question: 'First question', options: [{ label: 'ok' }] }] }) },
      },
    })
    rig.fake.pushEvent('s-1', {
      kind: 'interaction.updated',
      payload: {
        interactionId: 'i-second',
        revision: '3',
        executionId: 'exec-live',
        toolCallId: 'call-second',
        status: 'pending',
        summary: 'Second question',
        kind: 'question',
        inputDigest: 'b'.repeat(64),
        input: { text: JSON.stringify({ questions: [{ question: 'Second question', options: [{ label: 'ok' }] }] }) },
      },
    })
    await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })

    // Settle the SECOND (the later-registered one); the FIRST stays pending.
    rig.fake.pushEvent('s-1', {
      kind: 'interaction.updated',
      payload: {
        interactionId: 'i-second',
        revision: '4',
        executionId: 'exec-live',
        toolCallId: 'call-second',
        status: 'approved',
        summary: 'Second question',
        kind: 'question',
        inputDigest: 'b'.repeat(64),
      },
    })

    const started = Date.now()
    const waited = (await rig.call('cherry_wait', {
      device: 'dev-A',
      sessionId: 's-1',
      timeoutMs: 2_000,
    })) as { status: string; interactionId?: string; pendingInteractions?: Array<{ interactionId: string }> }
    const elapsed = Date.now() - started

    // A single-slot record lost `i-first` here and parked to the full timeout.
    expect(waited.status).toBe('awaiting-interaction')
    expect(waited.interactionId).toBe('i-first')
    expect(waited.pendingInteractions?.map((entry) => entry.interactionId)).toEqual(['i-first'])
    expect(elapsed).toBeLessThan(1_000)
  })
})


describe('final review: run-scoped terminal aggregate', () => {
  it('R1: the SECOND send on a reused session reports ONLY its own run\'s reply', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        terminalMessage: terminalMessage('run-one-reply'),
        runDelayMs: 10,
      },
    })

    // Run 1 leaves its assistant message in the session history.
    const first = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'one',
      timeoutMs: 5_000,
    })) as { status: string; text: string; messages: Array<{ messageId: string }> }
    expect(first.status).toBe('completed')
    expect(first.text).toBe('run-one-reply')

    // The REAL peer appends a FRESH assistant message per run (a new
    // messageId), unlike a fixture that reuses one id and so hides the bug:
    // without a per-run cut, the second aggregate re-reads run 1's reply and
    // hands it back as run 2's output.
    rig.fake.setTerminalMessage({
      messageId: 'm-assistant-2',
      revision: '1',
      role: 'assistant',
      status: 'success',
      parts: [{ kind: 'text', text: 'run-two-reply' }],
    })

    const second = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'two',
      timeoutMs: 5_000,
    })) as { status: string; text: string; messages: Array<{ messageId: string }> }

    expect(second.status).toBe('completed')
    // The headline text is THIS run's reply ONLY.
    expect(second.text).toBe('run-two-reply')
    expect(second.text).not.toContain('run-one-reply')
    // The history stays available as context, both messages present — in the
    // peer's own order, which is NEWEST-FIRST (issue #3; the fake serves its
    // fixture order, and a settling run prepends its message exactly as the
    // real `listSessionMessages` returns the most recent page first).
    expect(second.messages.map((message) => message.messageId)).toEqual(['m-assistant-2', 'm-assistant'])
  })

  it('R1b: the two runs really do persist DISTINCT assistant messages', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        terminalMessage: terminalMessage('run-one-reply'),
        runDelayMs: 10,
      },
    })

    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'one', timeoutMs: 5_000 })
    rig.fake.setTerminalMessage({
      messageId: 'm-assistant-2',
      revision: '1',
      role: 'assistant',
      status: 'success',
      parts: [{ kind: 'text', text: 'run-two-reply' }],
    })
    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'two', timeoutMs: 5_000 })

    // The divergence the fake used to hide: the real peer persists a fresh
    // message per run, and serves the history NEWEST-FIRST (issue #3) — run
    // two's message comes back first.
    const page = (await rig.rawRequest('agent.messages.list', {
      sessionId: 's-1',
      historyRevision: '1',
    })) as { items: Array<{ messageId: string }> }
    expect(page.items.map((item) => item.messageId)).toEqual(['m-assistant-2', 'm-assistant'])
  })
})

describe('final review: the receipt status enum', () => {
  it('R4: a QUEUED `accepted` receipt still waits for the terminal instead of short-circuiting', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        terminalMessage: terminalMessage('accepted-run-reply'),
        sendOutcome: 'accepted',
        runDelayMs: 50,
      },
    })

    // `accepted` is schema-legal and means QUEUED, not refused: the peer has
    // admitted the command and the run's lifecycle follows on the event stream.
    // Returning the receipt under an implicit `wait: true` would hand back a
    // non-terminal answer — exactly what the caller asked NOT to get.
    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'queued',
      timeoutMs: 5_000,
    })) as { status: string; text?: string; executionId?: string }

    expect(result.status).toBe('completed')
    expect(result.text).toBe('accepted-run-reply')
    expect(result.executionId).toBeDefined()
  })

  it('R4b: a REJECTED receipt still short-circuits the wait', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], sendOutcome: 'busy' },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'nope',
      timeoutMs: 5_000,
    })) as { status: string; error?: { reason?: string } }

    // No run exists, so there is nothing to wait for: the receipt IS the answer.
    expect(result.status).toBe('rejected')
    expect(result.error?.reason).toBe('CONFLICT')
  })
})
