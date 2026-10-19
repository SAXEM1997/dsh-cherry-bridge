import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import {
  registerCherryTools,
  WAIT_ANSWER_TAIL_FLOOR_MS,
  WAIT_ANSWER_TAIL_MS,
} from '../../src/tools.js'
import type {
  CherryToolDefinition,
  CherryToolEngineOptions,
  CherryToolsContext,
  CherryToolsDeps,
} from '../../src/tools.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions, FakeMessageRecord } from '../loopback/fakeCherry.js'

/**
 * Issue #21 (item 1): a WAIT ANSWER's assembly has ONE absolute deadline.
 *
 * The defect: the terminal/timeout/idle aggregate that follows `cherry_send` /
 * `cherry_wait` issued every request with no deadline of any kind. Since #12 a
 * read whose link dies waits up to `transportRetryWaitMs` (5 s) for a
 * reconnect before replaying, so under a flapping link each of the walk's ~30
 * requests could absorb that wait — up to ~150 s AFTER the caller's deadline
 * had already elapsed, which is the exact shape #3 fixed (a 1 s timeout
 * answering two minutes late).
 *
 * The contract pinned here:
 *
 *  - the answer is assembled before `startedAt + timeoutMs + tail`, where the
 *    tail is `min(timeoutMs, WAIT_ANSWER_TAIL_MS)` — one more window, never more
 *    than 15 s;
 *  - a request that would outlive that instant is cut at it (the connection
 *    derives the per-request timeout from the deadline and caps the reconnect
 *    wait by it);
 *  - when the budget runs out MID-WALK the answer is the content already read
 *    with an honest verdict — `messagesTruncated` + `messagesTruncationReason:
 *    'deadline'` + a stop-point token — not a thrown error, and not a silent
 *    complete-looking result;
 *  - the session snapshot each answer needs is inside the same budget, and a
 *    snapshot failure DEGRADES to the stub receipt instead of rejecting
 *    `cherry_send`/`cherry_wait` (the #3 invariant: the run verdict stands even
 *    when the content behind it could not be read).
 *
 * TIMING is asserted only with generous bounds: the fake's `requestDelayMs` is
 * the clock, and every bound below is wide enough that a slow CI box cannot
 * make it flake while a walk that ignores its deadline still fails it.
 */

interface Rig {
  fake: FakeCherry
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

interface RigOptions {
  engine?: CherryToolEngineOptions
}

async function makeRig(options: FakeCherryOptions = {}, rigOptions: RigOptions = {}): Promise<Rig> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-tools-deadline-'))
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
    const connection = new DeviceConnection({
      identity,
      record: stored,
      // The peer here is loopback and enforces no rate cap of its own; the
      // production budget would pace a fixture out over wall clock the tests
      // below intentionally spend. The bound under test is TOOL-side and
      // indifferent to how fast the pages arrive.
      rateBudgetPerSecond: 100_000,
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
      throw new Error('pairing is not exercised by the aggregate-deadline suite')
    },
    evict: () => {
      throw new Error('the aggregate-deadline suite never evicts')
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

/** One assistant message fixture, newest-first order, single tiny text part. */
function assistantMessage(messageId: string, text: string): FakeMessageRecord {
  return { messageId, revision: '1', role: 'assistant', status: 'success', parts: [{ kind: 'text', text }] }
}

/** `count` messages, NEWEST FIRST (fixture index 0 is the newest). */
function history(count: number): FakeMessageRecord[] {
  return Array.from({ length: count }, (_unused, index) => assistantMessage(`m-${String(index)}`, `text ${String(index)}`))
}

const SESSION = {
  sessionId: 's-1',
  agentId: 'agent-1',
  workspaceId: 'ws-1',
  title: 'Hello',
  historyRevision: '1',
}

const AGENT = { agentId: 'agent-1', name: 'Agent One' }

/** A window whose tail (500 ms) is what the delayed aggregate is measured against. */
const WINDOW_MS = 500
/** Every RPC costs this long on the peer: the aggregate's pace, and the test's clock. */
const RPC_DELAY_MS = 120

type TimeoutAnswer = {
  status: string
  messages?: Array<{ messageId: string; incomplete?: boolean; partsTruncated?: string }>
  text?: string
  messagesTruncated?: boolean
  messagesTruncationReason?: string
  messagesResumeCursor?: string
  session?: Record<string, unknown>
  aggregateError?: string
  guidance?: string
  executionId?: string | null
  cursor?: unknown
  progress?: unknown
}

describe('issue #21 T1: a post-deadline aggregate stops at ITS deadline and keeps what it read', () => {
  it('T1 a 500 ms window over a 12-message history returns partial, newest-first content labelled deadline', async () => {
    const rig = await makeRig({
      requestDelayMs: RPC_DELAY_MS,
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        messages: history(20),
        // The run never settles inside the caller's window.
        runDelayMs: 30_000,
      },
    })

    const started = Date.now()
    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'slow',
      timeoutMs: WINDOW_MS,
    })) as TimeoutAnswer
    const elapsed = Date.now() - started

    expect(result.status).toBe('timeout')

    // THE BOUND: the walk stopped where its own budget ran out instead of paying
    // every remaining round trip after the deadline.
    expect(result.messages).toBeDefined()
    const returned = result.messages ?? []
    expect(returned.length).toBeGreaterThanOrEqual(1)
    expect(returned.length).toBeLessThan(20)
    // ...and it is the NEWEST end that survived: the walk is newest-first, and a
    // time stop must never cost the caller the run's own messages.
    expect(returned[0]?.messageId).toBe('m-0')
    // A SURFACED stop, not a silent short answer: the deadline is its own reason
    // (raising `limit` cannot help, and the peer did not misbehave).
    expect(result.messagesTruncated).toBe(true)
    expect(result.messagesTruncationReason).toBe('deadline')
    // The stop point is the SAME token `cherry_read` accepts (#26): the content
    // that was cut is reachable in the next call.
    expect(result.messagesResumeCursor).toMatch(/^(cursor|after):/)

    // The parts walks are what the budget actually stopped: fewer part pages
    // than messages prove the walk did not simply finish.
    expect(rig.fake.readCallsFor('agent.parts.list').length).toBeLessThan(20)

    // The caller's window (500 ms) + the tail floor (1 s) + the peer's own
    // delays, generously padded: an assembly that ignores its deadline spends
    // 20 × 3 × 120 ms here and lands well past this bound.
    expect(elapsed).toBeLessThan(WINDOW_MS + 500 + 1_500)
  }, 20_000)

  it('T2 an IDLE answer is bounded by the same rule (the wait never happened, the walk still must end)', async () => {
    const rig = await makeRig({
      requestDelayMs: RPC_DELAY_MS,
      agent: { agents: [AGENT], sessions: [SESSION], messages: history(20) },
    })

    const result = (await rig.call('cherry_wait', {
      device: 'dev-A',
      sessionId: 's-1',
      timeoutMs: WINDOW_MS,
    })) as TimeoutAnswer & { executionId?: null }

    expect(result.status).toBe('idle')
    expect(result.executionId).toBeNull()
    // The idle face snapshots FIRST (one delayed RPC) and only then walks, so
    // the budget it gets is the window plus the tail floor — enough for the
    // newest messages, never enough for all twenty.
    const returned = result.messages ?? []
    expect(returned.length).toBeGreaterThanOrEqual(1)
    expect(returned.length).toBeLessThan(20)
    expect(returned[0]?.messageId).toBe('m-0')
    expect(result.messagesTruncated).toBe(true)
    expect(result.messagesTruncationReason).toBe('deadline')
  }, 20_000)
})

describe('issue #21 T5: a request that hangs is cut at the deadline, not at the 60 s default', () => {
  it('T5 a part walk that never answers is stopped by the answer budget and the message is flagged', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        // FEWER THAN THE NEGOTIATED PAGE SIZE (16): one message page, so the
        // armed delay lands in the PARTS walk. A fixture that pages would spend
        // the delay on the second LIST page instead (T6 covers that one).
        messages: history(12),
        runDelayMs: 30_000,
      },
    })
    // The hang is armed AFTER the message page is served, so it lands inside the
    // PARTS walk — the aggregate's first request after the page. It is far
    // longer than the whole answer budget (the 1 s tail floor), which is the
    // point: the per-request timeout must be derived from the deadline, not from
    // the rpc layer's own 60 s default.
    rig.fake.afterNextRead('agent.messages.list', () => {
      rig.fake.setRequestDelay(2_500)
    })

    const started = Date.now()
    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'slow',
      timeoutMs: WINDOW_MS,
    })) as TimeoutAnswer
    const elapsed = Date.now() - started
    // Teardown should not pay the armed delay for its own control frames.
    rig.fake.setRequestDelay(undefined)

    expect(result.status).toBe('timeout')
    const returned = result.messages ?? []
    // The newest message survived — with an HONEST parts verdict: the walk was
    // cut, so the message is incomplete and says why.
    expect(returned.length).toBe(1)
    expect(returned[0]?.messageId).toBe('m-0')
    expect(returned[0]?.incomplete).toBe(true)
    expect(returned[0]?.partsTruncated).toBe('deadline')
    // ...and the message walk itself reports the deadline as its own stop.
    expect(result.messagesTruncated).toBe(true)
    expect(result.messagesTruncationReason).toBe('deadline')
    // THE BOUND: the answer came back on its budget. Without the derived
    // per-request timeout the hung part would ride the 60 s default.
    expect(elapsed).toBeLessThan(2_000)

    // AND ITS SHORT PART LIST IS NOT REMEMBERED (issue #21 review finding 6a).
    // The message's parts walk was cut, so the page is short — a transient
    // state that must be retried, never cached: the next read has to re-walk
    // it. The refusal itself is reason-blind (`page.truncated`), which is what
    // makes it cover a `'deadline'` page as well as a `'safety-bound'` one.
    const partsBefore = rig.fake.readCallsFor('agent.parts.list').length
    const reread = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 1 })) as {
      messages: Array<{ messageId: string; parts: unknown[]; partsTruncated?: string }>
    }
    expect(reread.messages[0]?.messageId).toBe('m-0')
    // The part is there this time: the re-walk was not served from a cache.
    expect(reread.messages[0]?.parts.length).toBe(1)
    expect(reread.messages[0]?.partsTruncated).toBeUndefined()
    expect(rig.fake.readCallsFor('agent.parts.list').length).toBeGreaterThan(partsBefore)
  }, 20_000)
})

describe('issue #21 T6: the MESSAGE LIST walk is inside the budget as well', () => {
  it('T6 a message page that never answers is cut at the deadline, not at the 60 s default', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [{ ...SESSION, activeExecutionId: 'ex-1' }],
        messages: history(20),
        runDelayMs: 30_000,
      },
    })
    // The hang must land on the MESSAGE LIST — the walk's first request — and
    // not on either session snapshot: the waiter takes one to learn the run is
    // in flight, the timeout answer takes another for the history revision. The
    // second hook is armed from inside the first, so ordering is exact.
    rig.fake.afterNextRead('agent.sessions.get', () => {
      rig.fake.afterNextRead('agent.sessions.get', () => {
        rig.fake.setRequestDelay(2_500)
      })
    })

    const started = Date.now()
    const result = (await rig.call('cherry_wait', {
      device: 'dev-A',
      sessionId: 's-1',
      timeoutMs: WINDOW_MS,
    })) as TimeoutAnswer
    const elapsed = Date.now() - started
    rig.fake.setRequestDelay(undefined)

    expect(result.status).toBe('timeout')
    // Nothing was collected, and that is reported rather than thrown: the
    // answer still carries the run verdict and the edge cursor.
    expect(result.messages).toEqual([])
    expect(result.messagesTruncated).toBe(true)
    expect(result.messagesTruncationReason).toBe('deadline')
    expect(elapsed).toBeLessThan(2_000)
  }, 20_000)
})

describe('issue #21 T7: an externalized {ref} read is inside the budget too', () => {
  it('T7 a content slice that never answers degrades ONE part instead of blowing the budget', async () => {
    // One message whose only part is externalized (the real peer's form for any
    // part over 4,096 characters). The slice walk is the deepest request the
    // aggregate makes, and it must be bounded like the rest: a `{ref}` that
    // cannot be read in time makes THIS part `unavailable` — the degradable
    // class, because the reassembled bytes could not be verified — while the
    // message and the run verdict both stand.
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [{ ...SESSION, activeExecutionId: 'ex-1' }],
        messages: [
          {
            messageId: 'm-ref',
            revision: '1',
            role: 'assistant',
            status: 'success',
            parts: [{ kind: 'text', text: 'x'.repeat(200), external: true }],
          },
        ],
        runDelayMs: 30_000,
      },
    })
    // Armed after the parts page: the content walk is the next request.
    rig.fake.afterNextRead('agent.parts.list', () => {
      rig.fake.setRequestDelay(2_500)
    })

    const started = Date.now()
    const result = (await rig.call('cherry_wait', {
      device: 'dev-A',
      sessionId: 's-1',
      timeoutMs: WINDOW_MS,
    })) as TimeoutAnswer
    const elapsed = Date.now() - started
    rig.fake.setRequestDelay(undefined)

    expect(result.status).toBe('timeout')
    const returned = result.messages ?? []
    expect(returned.length).toBe(1)
    const part = (returned[0] as unknown as { parts: Array<Record<string, unknown>> }).parts[0]
    // The part is PRESENT and says it could not be read: degradation, never a
    // silent empty string that would read as "the peer sent nothing".
    expect(typeof part?.['unavailable']).toBe('string')
    expect(String(part?.['unavailable']).length).toBeGreaterThan(0)
    expect(part?.['content']).toBe('')
    // The message knows it is incomplete; its part LIST was complete, so the
    // truncation belongs to the content walk, not to the parts walk.
    expect(returned[0]?.incomplete).toBe(true)
    expect(returned[0]?.partsTruncated).toBeUndefined()
    // The MESSAGE walk is complete, and must not claim otherwise: the peer's
    // only message came back whole, its one part is the thing that failed. A
    // `messagesTruncated` here would send the caller looking for history that
    // does not exist.
    expect(result.messagesTruncated).toBeUndefined()
    expect(elapsed).toBeLessThan(2_000)
  }, 20_000)
})

describe('issue #21 T3: the session snapshot is inside the budget, and its failure degrades', () => {
  it('T3 a failing agent.sessions.get leaves the timeout verdict, its identifiers and the guidance', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        // The peer considers this execution in flight, so `cherry_wait` parks
        // (its FIRST sessions.get answers normally) and then times out.
        sessions: [{ ...SESSION, activeExecutionId: 'ex-1' }],
        messages: history(3),
        runDelayMs: 30_000,
      },
    })
    // Armed AFTER the waiter's own snapshot: the failure lands on the answer's
    // snapshot, which is the one this contract is about.
    rig.fake.afterNextRead('agent.sessions.get', () => {
      rig.fake.setReadFailure('agent.sessions.get', {
        reason: 'RESOURCE_UNAVAILABLE',
        message: 'session snapshot unavailable',
      })
    })

    const result = (await rig.call('cherry_wait', {
      device: 'dev-A',
      sessionId: 's-1',
      timeoutMs: WINDOW_MS,
    })) as TimeoutAnswer

    // NOT a rejection: the run's outcome is still `timeout`, and the caller keeps
    // the identifiers it needs to act on it.
    expect(result.status).toBe('timeout')
    expect(result.executionId).toBe('ex-1')
    expect(result.cursor).toBeDefined()
    expect(result.session).toBeUndefined()
    expect(result.messages).toBeUndefined()
    expect(result.text).toBeUndefined()
    // The failure is reported beside the verdict, with the route that rebuilds
    // the content (the #3 stub receipt, now covering the snapshot too).
    expect(result.aggregateError).toContain('session snapshot unavailable')
    expect(typeof result.guidance).toBe('string')
    expect(result.guidance?.length ?? 0).toBeGreaterThan(0)
  }, 20_000)
})

describe('issue #21 T4: the deadline never cuts a healthy answer', () => {
  it('T4 a fast walk over the same history is COMPLETE — the budget is a backstop, not a ceiling', async () => {
    const rig = await makeRig({
      // No request delay: the whole walk fits inside the tail by orders of
      // magnitude. This is the regression guard for the OTHER failure mode —
      // a tail so tight (or a deadline check in the wrong place) that ordinary
      // answers start coming back truncated.
      agent: { agents: [AGENT], sessions: [SESSION], messages: history(20), runDelayMs: 30_000 },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'slow',
      timeoutMs: WINDOW_MS,
    })) as TimeoutAnswer

    expect(result.status).toBe('timeout')
    expect(result.messages?.length).toBe(20)
    expect(result.messagesTruncated).toBeUndefined()
    expect(result.messagesTruncationReason).toBeUndefined()
    expect(result.messagesResumeCursor).toBeUndefined()
  }, 20_000)

  it('T4b the tail FLOOR and CEILING are the constants the contract names', () => {
    // Pinned as VALUES because the ceiling cannot be reached without spending
    // it (a 20 s window would need a 20 s test) while the floor is measured by
    // T8. What T1 measures is the middle of the range — the tail is one more
    // window — so these two lines are what fail first if either end moves.
    expect(WAIT_ANSWER_TAIL_FLOOR_MS).toBe(1_000)
    expect(WAIT_ANSWER_TAIL_MS).toBe(15_000)
  })

  it('T8 a 1 ms window still gets a usable answer — the tail has a FLOOR', async () => {
    // `timeoutMs: 1` is schema-legal and means "snapshot now". A budget of one
    // window would be one millisecond, i.e. the stub receipt for a run whose
    // reply is a round trip away; the floor is what makes the degenerate window
    // usable. The peer is fast here, so the whole walk fits.
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], messages: history(3), runDelayMs: 30_000 },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'slow',
      timeoutMs: 1,
    })) as TimeoutAnswer

    expect(result.status).toBe('timeout')
    expect(result.messages?.length).toBe(3)
    expect(result.aggregateError).toBeUndefined()
  }, 20_000)
})
