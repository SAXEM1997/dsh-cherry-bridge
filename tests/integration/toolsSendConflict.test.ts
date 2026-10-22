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
 * GitHub issue #1 — `cherry_send` answers a PERMANENT CONFLICT.
 *
 * The defect is a cache-read ordering bug on the bridge side, not a peer fault:
 *
 *  - `#idleRevision` reads the stream first, a sticky `#revisionCache` second,
 *    and `agent.sessions.get` only when the cache is COLD. A cache HIT therefore
 *    short-circuits without ever re-validating.
 *  - The event buffer that feeds the first source is dropped WHOLESALE when its
 *    epoch rotates, when a re-subscribe rebuilds it, or when the LRU evicts it.
 *    With the stream gone, the stale cached revision is what gets sent, the
 *    peer's admission gate answers CONFLICT "Session is not idle at the
 *    expected revision", and nothing ever refreshes the entry again: every
 *    later send repeats the same refused command.
 *  - The peer records that refusal in its command ledger as a `rejected`
 *    receipt, so re-USING the commandId with the new revision replays the
 *    refusal (or answers IDEMPOTENCY_CONFLICT).
 *
 * The fake implements the gate faithfully (see `#sendAdmissionRefusal`), and
 * `silentIdleBump` models "the revision moved while the bridge's buffer was
 * empty". The rig is the one `toolsInteract.test.ts` uses.
 */

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

async function makeRig(
  options: FakeCherryOptions = {},
  rigOptions: { engine?: CherryToolEngineOptions } = {},
): Promise<Rig> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-tools-send-conflict-'))
  const store = new DeviceStore(join(tmp, 'devices.json'))

  store.upsert({
    schemaVersion: 2,
    deviceId: 'dev-A',
    displayName: 'Desk Alpha',
    hosts: [host],
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
      throw new Error('pairing is not exercised by the send-conflict suite')
    },
    evict: () => {
      throw new Error('the send-conflict suite never evicts')
    },
  }
  registerCherryTools(ctx, deps, rigOptions.engine ?? {})
  await connect('dev-A').connect()

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

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SESSION = {
  sessionId: 's-1',
  agentId: 'agent-1',
  workspaceId: 'ws-1',
  title: 'Hello',
  historyRevision: '1000',
}

const AGENT = { agentId: 'agent-1', name: 'Agent One' }

/**
 * The assistant message ONE run persists. `messageId` is the run's identity on
 * the read face, so consecutive runs get distinct ids — exactly as the peer
 * appends a fresh message per run.
 */
function terminalMessage(text: string, messageId = 'm-assistant'): FakeMessageRecord {
  return { messageId, revision: '1', role: 'assistant', status: 'success', parts: [{ kind: 'text', text }] }
}

function sendCalls(rig: Rig): readonly Record<string, unknown>[] {
  return rig.fake.commandCallsFor('agent.messages.send')
}

/** The sends carrying one body — the currency for "how many attempts did THIS text cost". */
function sendsOf(rig: Rig, text: string): readonly Record<string, unknown>[] {
  return sendCalls(rig).filter((call) => call['text'] === text)
}

function sessionGets(rig: Rig): number {
  return rig.fake.readCallsFor('agent.sessions.get').length
}

describe('cherry_send admission self-heals a stale expectedIdleRevision (issue #1)', () => {
  it('T1 a send refused for a stale revision is re-issued ONCE under a NEW commandId and completes', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [{ ...SESSION }],
        terminalMessage: terminalMessage('first reply', 'm-first'),
      },
    })

    // The first send establishes the cache: its cold read of sessions.get
    // baselines revision 1000.
    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'first' })
    expect(sendsOf(rig, 'first')).toHaveLength(1)
    expect(sendsOf(rig, 'first')[0]!['expectedIdleRevision']).toBe('1000')

    // The retry's run must be distinguishable from the first one's reply.
    rig.fake.setTerminalMessage(terminalMessage('second reply', 'm-second'))

    // The buffer goes blind while the peer's revision moves on, with NO event
    // traffic to announce it.
    const bumped = rig.fake.silentIdleBump('s-1')
    expect(bumped).toBe('1001')

    const result = (await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'second' })) as {
      status?: string
      text?: string
    }

    // The run proceeded to its terminal: the retry was ADMITTED, not merely
    // re-attempted.
    expect(result.status).toBe('completed')
    // The aggregate is RUN-scoped: the healing retry's own reply, not a
    // concatenation of both runs' history.
    expect(result.text).toBe('second reply')

    const calls = sendsOf(rig, 'second')
    expect(calls).toHaveLength(2)
    // The stale revision went first...
    expect(calls[0]!['expectedIdleRevision']).toBe('1000')
    // ...and the retry carries the FRESH one.
    expect(calls[1]!['expectedIdleRevision']).toBe('1001')

    // A NEW commandId, never the one the peer already settled as rejected: the
    // same id would have replayed that refusal (body differs → the peer would
    // answer IDEMPOTENCY_CONFLICT instead).
    const firstId = String(calls[0]!['commandId'])
    const secondId = String(calls[1]!['commandId'])
    expect(secondId).not.toBe(firstId)
    expect(rig.fake.receiptFor(firstId)?.['status']).toBe('rejected')
    expect(['applied', 'accepted']).toContain(rig.fake.receiptFor(secondId)?.['status'])
  })

  it('T1b the self-heal re-reads the session before retrying instead of guessing a revision', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [{ ...SESSION }],
        terminalMessage: terminalMessage('first reply', 'm-first'),
      },
    })

    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'first', wait: false })
    const before = sessionGets(rig)

    rig.fake.silentIdleBump('s-1')
    const receipt = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'second',
      wait: false,
    })) as Record<string, unknown>

    // `wait: false` still returns the (re-issued) receipt untouched — the
    // SECOND attempt's, which is the one that was admitted.
    expect(['applied', 'accepted']).toContain(receipt['status'])
    const attempts = sendsOf(rig, 'second')
    expect(attempts).toHaveLength(2)
    expect(receipt['commandId']).toBe(String(attempts[1]!['commandId']))
    expect(receipt['commandId']).not.toBe(String(attempts[0]!['commandId']))
    // Exactly ONE extra read: the admission re-baseline. (A guess would have
    // needed none; a blind retry would have asked the peer and been refused.)
    expect(sessionGets(rig) - before).toBe(1)
  })

  it('T1c a CALLER-SUPPLIED commandId does not poison the self-heal: the remembered stale baseline must not ride the fresh-uuid retry (issue #115)', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [{ ...SESSION }],
        terminalMessage: terminalMessage('first reply', 'm-first'),
      },
    })

    // Establish the cache WITHOUT a caller id, so the memory this test is about
    // starts empty (an auto-generated uuid is never remembered).
    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'first' })

    // The retry's run must be distinguishable from the first one's reply.
    rig.fake.setTerminalMessage(terminalMessage('second reply', 'm-second'))

    // The buffer goes blind while the peer's revision moves on.
    rig.fake.silentIdleBump('s-1')

    // The send under a CALLER-SUPPLIED id goes stale on its first attempt — and
    // a rejected receipt is still a SETTLED one, so the engine remembers that
    // first body (baseline 1000) for the caller's id. The self-heal's retry
    // runs under a FRESH uuid; the remembered baseline belongs to the id it was
    // minted for and must NOT ride along (issue #115 regression: it did, and
    // the retry re-quoted the revision the peer had just refused).
    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'second',
      commandId: 'caller-stale-id',
      wait: true,
    })) as { status?: string; text?: string }

    expect(result.status).toBe('completed')
    expect(result.text).toBe('second reply')

    const calls = sendsOf(rig, 'second')
    expect(calls).toHaveLength(2)
    expect(calls[0]!['expectedIdleRevision']).toBe('1000')
    // The retry carries the FRESH revision — not the remembered stale one.
    expect(calls[1]!['expectedIdleRevision']).toBe('1001')
    // And it is a NEW commandId, never the caller's settled one.
    expect(String(calls[1]!['commandId'])).not.toBe('caller-stale-id')
  })

  it('T2 a genuinely BUSY session is not retried: one send, the peer receipt, no second attempt', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [{ ...SESSION }],
        terminalMessage: terminalMessage('first reply'),
        // Run 1 never settles inside the test, so the session stays busy.
        runDelayMs: 60_000,
      },
    })

    // Establish the cache, then let the run start and never finish.
    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'first', wait: false })
    expect(rig.fake.activeExecutionId).toBeDefined()

    // The bridge's baseline is ALSO stale — but the busy check precedes the
    // revision check on the peer, so "Session is busy" is what comes back. That
    // refusal says nothing about the revision and must never be retried.
    rig.fake.silentIdleBump('s-1')
    const receipt = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'second',
      wait: false,
    })) as { status?: string; error?: { reason?: string; message?: string } }

    expect(receipt.status).toBe('rejected')
    expect(receipt.error?.reason).toBe('CONFLICT')
    expect(receipt.error?.message).toBe('Session is busy')

    // ONE attempt, verbatim: no second send, no healing read.
    expect(sendsOf(rig, 'second')).toHaveLength(1)
    expect(rig.fake.readCallsFor('agent.sessions.get')).toHaveLength(1)
  })

  it('T2b the self-heal retries exactly ONCE: a second refusal is the answer', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [{ ...SESSION }] } })

    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'first', wait: false })

    // The healing read sees 1001 and the retry quotes it — but the peer moves
    // on to 2000 RIGHT AFTER that read, so the second attempt is refused too.
    rig.fake.silentIdleBump('s-1')
    rig.fake.afterNextRead('agent.sessions.get', () => rig.fake.setSessionRevision('s-1', '2000'))

    const refused = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'second',
      wait: true,
    })) as { status?: string; error?: { reason?: string; message?: string } }

    expect(refused.status).toBe('rejected')
    expect(refused.error?.reason).toBe('CONFLICT')
    expect(refused.error?.message).toBe('Session is not idle at the expected revision')
    // Exactly two attempts, never a third.
    expect(sendsOf(rig, 'second')).toHaveLength(2)
    // The second attempt carried the revision the healing read saw.
    expect(sendsOf(rig, 'second')[1]!['expectedIdleRevision']).toBe('1001')
  })

  it('T3 an idle cherry_wait writes the fresh revision back, so the next send never conflicts', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [{ ...SESSION }], terminalMessage: terminalMessage('run reply') },
    })

    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'first' })

    const bumped = rig.fake.silentIdleBump('s-1')

    // The idle snapshot path already holds a FRESH sessions.get — it used to
    // throw it away.
    const idle = (await rig.call('cherry_wait', { device: 'dev-A', sessionId: 's-1' })) as { status?: string }
    expect(idle.status).toBe('idle')

    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'second' })

    // ONE send for "second", carrying the NEW revision: the write-back turned
    // the conflict into no conflict at all.
    const seconds = sendCalls(rig).filter((call) => call['text'] === 'second')
    expect(seconds).toHaveLength(1)
    expect(seconds[0]!['expectedIdleRevision']).toBe(bumped)
  })

  it('T5 the healed revision beats a LINGERING stale streamed event on the retry', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [{ ...SESSION }],
        terminalMessage: terminalMessage('first reply', 'm-first'),
      },
    })

    // A normal send establishes the subscription and the cache (revision 1000).
    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'first' })
    expect(sendsOf(rig, 'first')).toHaveLength(1)

    // A LINGERING `session.updated` still sits in the event buffer carrying the
    // OLD revision — the shape the desktop produces when it advances the
    // revision locally and the announcement arrives late.
    rig.fake.pushEvent('s-1', {
      kind: 'session.updated',
      payload: { idleRevision: '1000', historyRevision: '1000' },
    })
    // Block until it is IN the buffer: the stream is the buffer, not the wire.
    await vi.waitFor(
      async () => {
        const result = (await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })) as {
          events?: Array<{ kind: string }>
        }
        expect(result.events?.map((event) => event.kind)).toContain('session.updated')
      },
      5_000,
    )

    // The peer moves on with NO event traffic, so the streamed value above stays
    // the only thing the buffer knows — and it is now stale.
    const bumped = rig.fake.silentIdleBump('s-1')
    expect(bumped).toBe('1001')

    rig.fake.setTerminalMessage(terminalMessage('second reply', 'm-second'))
    const result = (await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'second' })) as {
      status?: string
      text?: string
    }

    // Exactly two attempts, and the run completed.
    const calls = sendsOf(rig, 'second')
    expect(calls).toHaveLength(2)
    expect(result.status).toBe('completed')
    expect(result.text).toBe('second reply')

    // The FIRST attempt quoted the lingering streamed value and was refused...
    expect(calls[0]!['expectedIdleRevision']).toBe('1000')
    expect(rig.fake.receiptFor(String(calls[0]!['commandId']))?.['status']).toBe('rejected')

    // ...and the RETRY quotes what the healing `sessions.get` returned, NOT the
    // stale streamed value it would have re-derived: the stream still outranks
    // the cache inside `#idleRevision`, so a retry that asked it again would
    // re-send 1000 and be refused a second time.
    expect(calls[1]!['expectedIdleRevision']).toBe(bumped)
    expect(rig.fake.receiptFor(String(calls[1]!['commandId']))?.['status']).not.toBe('rejected')
    expect(calls[1]!['commandId']).not.toBe(calls[0]!['commandId'])
  })

  it('T4 a fresh cache keeps the zero-read fast path on a cold send', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [{ ...SESSION }] } })

    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'warming', wait: false })
    const afterWarm = sessionGets(rig)
    expect(afterWarm).toBe(1)

    const callsBefore = sendCalls(rig).length
    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'warm', wait: false })

    // No admission healing and no re-baseline: the cache hit is unchanged.
    expect(sessionGets(rig)).toBe(afterWarm)
    expect(sendCalls(rig).length).toBe(callsBefore + 1)
  })
})
