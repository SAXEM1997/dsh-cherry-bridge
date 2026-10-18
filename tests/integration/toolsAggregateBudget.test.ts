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
 * Issue #3 acceptance suite: the terminal/timeout/idle aggregate is BOUNDED,
 * deadline-honest, and anchored at the NEW end of the history.
 *
 * Three defects, one field report (a `cherry_send` whose 1 s window returned
 * nothing for ~two minutes):
 *
 *  1. **The deadline was honest, the aggregate was not.** The waiter's own
 *     timeout check runs on schedule, but the answer it then assembles walked
 *     the session's WHOLE history (`MAX_AGGREGATE_LIMIT = 1000` messages, every
 *     part of every message, every externalized part resolved through
 *     `agent.content.read`). On a 459-message session that was 29+ message pages
 *     plus >100 content pages AFTER the deadline had already passed — so a 1 s
 *     timeout took ~two minutes to answer. Bounded here by
 *     `TERMINAL_AGGREGATE_MESSAGES` and `TERMINAL_AGGREGATE_BYTES`.
 *  2. **The text anchor pointed at the OLDEST assistant message.** The peer's
 *     `listSessionMessages` walks NEWEST-FIRST (an absent cursor returns the
 *     most recent page; `nextCursor` walks one page OLDER), so the aggregated
 *     array is new→old. The fallback anchored on the array's TAIL, i.e. the
 *     oldest assistant message in history — a July message surfaced in October.
 *  3. **A failed assembly was a thrown MCP error**, so the caller lost even the
 *     `commandId` of the run it had already admitted. The run verdict now
 *     stands on its own and the assembly failure rides beside it
 *     (`aggregateError` + `guidance`).
 *
 * A fourth field-report point is covered too: a timeout answer now carries a
 * zero-round-trip heartbeat (`progress`) derived from the subscription buffer
 * it already holds, so a caller can tell "the run is still moving" from "the
 * stream is silent" without another RPC.
 *
 * FIXTURE ORDER IS THE CONTRACT. The fake's `agent.messages` array is served in
 * its own order and paged by numeric offset, so — exactly like the real peer —
 * **index 0 is the NEWEST message**. Every fixture here is written newest-first
 * for that reason.
 */

/** One assistant message fixture, page-cheap (a single tiny text part). */
function assistantMessage(messageId: string, text: string, status: 'success' | 'pending' = 'success'): FakeMessageRecord {
  return { messageId, revision: '1', role: 'assistant', status, parts: [{ kind: 'text', text }] }
}

/** `count` filler messages, newest first, all BELOW `offset` ids (e.g. `old-12`). */
function fillerHistory(count: number, prefix = 'old'): FakeMessageRecord[] {
  return Array.from({ length: count }, (_unused, index) => assistantMessage(`${prefix}-${index}`, `${prefix} ${index}`))
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
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-tools-budget-'))
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
      // production business budget would pace a many-page fixture out over
      // tens of seconds of wall clock. The bounds under test are TOOL-side and
      // indifferent to how fast the pages arrive — and T1's own upper bound
      // (timeout + 30 s) still pins the BEHAVIOUR that matters.
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
      throw new Error('pairing is not exercised by the aggregate-budget suite')
    },
    evict: () => {
      throw new Error('the aggregate-budget suite never evicts')
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

/** The one session every scenario drives. */
const SESSION = {
  sessionId: 's-1',
  agentId: 'agent-1',
  workspaceId: 'ws-1',
  title: 'Hello',
  historyRevision: '1',
}

const AGENT = { agentId: 'agent-1', name: 'Agent One' }

/**
 * The production bounds this suite pins (issue #3's contract, restated here so
 * the suite fails loudly if either silently grows).
 *
 *  - 20 messages: one run persists a user + assistant pair, and the peer pages
 *    20 by default — so the ceiling covers a run's own messages (which the
 *    newest-first walk reaches FIRST) with an order of magnitude to spare.
 *  - 256 KiB of projected JSON: the 13 MB / 459-message aggregate that broke
 *    the MCP boundary was a single call's worth of content. `JSON.stringify`
 *    length is the cheap approximation of the wire cost.
 */
const TERMINAL_AGGREGATE_MESSAGES = 20
const TERMINAL_AGGREGATE_BYTES = 262_144

/** The message-walk verdict the three terminal faces must carry when bounded. */
const BOUNDED_REASONS = ['limit', 'safety-bound', 'aggregate-bytes']

/** A long history: 45 assistant messages, newest first. */
function longHistory(): FakeMessageRecord[] {
  return [
    ...Array.from({ length: 5 }, (_unused, index) => assistantMessage(`new-${index}`, `newest ${index}`)),
    ...fillerHistory(40),
  ]
}

describe('issue #3 T1: a timeout answer is bounded — its message walk is capped and times out honestly', () => {
  it('T1 a 800 ms send over a 45-message history pages ≤ ceil(20/page)+1 times, ≤20 messages, and answers on deadline', async () => {
    // The peer pages at 10 for the MESSAGE list — smaller than both the
    // negotiated 100 and the 20-message ceiling under test, so a walk that
    // really is bounded pages at most ceil(20/10) = 2 times, and the third page
    // is the room this suite grants for a provider that asks once more to learn
    // "there is no more". (The fake's `maxPageSize` narrows every read face,
    // which would also hide the block's own limit from the wire, hence
    // `maxMessagePageSize`.)
    const maxMessagePageSize = 10
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        messages: longHistory(),
        maxMessagePageSize,
        // The run never settles inside the caller's window.
        runDelayMs: 30_000,
      },
    })

    const started = Date.now()
    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'slow',
      timeoutMs: 800,
    })) as {
      status: string
      messages: Array<{ messageId: string }>
      text?: string
      messagesTruncated?: boolean
      messagesTruncationReason?: string
      messagesResumeCursor?: string
    }
    const elapsed = Date.now() - started

    expect(result.status).toBe('timeout')

    // THE BOUND: the walk stopped at the tool-side ceiling instead of walking
    // all 45 messages (and, on the real 459-message session, instead of 29+
    // pages of them after the deadline had already passed).
    const expectedPages = Math.ceil(TERMINAL_AGGREGATE_MESSAGES / maxMessagePageSize) + 1
    const pages = rig.fake.readCallsFor('agent.messages.list')
    expect(pages.length).toBeLessThanOrEqual(expectedPages)
    for (const call of pages) expect(call['limit'] as number).toBeLessThanOrEqual(TERMINAL_AGGREGATE_MESSAGES)

    expect(result.messages.length).toBeLessThanOrEqual(TERMINAL_AGGREGATE_MESSAGES)
    // ...and it is a SURFACED bound, not a silent one.
    expect(result.messagesTruncated).toBe(true)
    expect(BOUNDED_REASONS).toContain(result.messagesTruncationReason)
    // The newest message (fixture index 0 = the newest under the peer's
    // newest-first contract) is inside the walk: the bound must never cost the
    // caller the part of the history it is most likely to need.
    expect(result.messages[0]?.messageId).toBe('new-0')

    // The deadline is the bound the caller set — generously padded so a slow
    // CI box cannot make this flaky. Before the fix this call took the whole
    // 45-message aggregate walk AFTER its window elapsed.
    expect(elapsed).toBeGreaterThanOrEqual(500)
    expect(elapsed).toBeLessThan(800 + 30_000)
  })

  it('T5 an idle snapshot of the same long history is bounded the same way', async () => {
    // `cherry_wait` on an idle session answers with the current snapshot at
    // once; that snapshot rides the SAME walk, so the same ceilings apply.
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], messages: longHistory(), maxMessagePageSize: 10 },
    })

    const idle = (await rig.call('cherry_wait', { device: 'dev-A', sessionId: 's-1' })) as {
      status: string
      messages: Array<{ messageId: string }>
      messagesTruncated?: boolean
      messagesTruncationReason?: string
      messagesResumeCursor?: string
    }

    expect(idle.status).toBe('idle')
    expect(idle.messages.length).toBeLessThanOrEqual(TERMINAL_AGGREGATE_MESSAGES)
    expect(idle.messagesTruncated).toBe(true)
    expect(BOUNDED_REASONS).toContain(idle.messagesTruncationReason)
    expect(idle.messages[0]?.messageId).toBe('new-0')
    expect(rig.fake.readCallsFor('agent.messages.list').length).toBeLessThanOrEqual(
      Math.ceil(TERMINAL_AGGREGATE_MESSAGES / 10) + 1,
    )
  })

  it('T5b the BYTE budget stops a fat history even when the message count is small', async () => {
    // Three messages, each carrying 150 KiB of text: under the 20-message
    // ceiling, far over the 256 KiB byte budget once projected. The newest
    // message must ALWAYS be complete — it is the run's own reply — so the
    // projection spends the budget on message 0 first and stops at the first
    // message that no longer fits.
    const fat = (messageId: string): FakeMessageRecord => ({
      messageId,
      revision: '1',
      role: 'assistant',
      status: 'success',
      parts: [{ kind: 'text', text: 'F'.repeat(150 * 1024) }],
    })
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], messages: [fat('f-0'), fat('f-1'), fat('f-2')] },
    })

    const idle = (await rig.call('cherry_wait', { device: 'dev-A', sessionId: 's-1' })) as {
      status: string
      messages: Array<{ messageId: string; parts: Array<{ content: string }>; partsTruncated?: string }>
      messagesTruncated?: boolean
      messagesTruncationReason?: string
    }

    expect(idle.status).toBe('idle')
    expect(idle.messagesTruncated).toBe(true)
    expect(idle.messagesTruncationReason).toBe('aggregate-bytes')
    // The newest message is WHOLE — the budget never truncates it.
    expect(idle.messages[0]?.messageId).toBe('f-0')
    expect(idle.messages[0]?.parts[0]?.content).toHaveLength(150 * 1024)
    // And the walk really stopped: the third message was never projected.
    expect(idle.messages.map((message) => message.messageId)).not.toContain('f-2')
    expect(idle.messages.length).toBeLessThan(3)
  })

  it('T5c a byte stop offers a stop-point cursor ONLY when it did not stop mid-page', async () => {
    // The stop-point cursor is a PROMISE that it names where the unread history
    // begins. The peer's `nextCursor` points past the WHOLE aggregate page it
    // came with, and the byte budget runs over the aggregate's already-collected
    // window (`#aggregate` fills up to TERMINAL_AGGREGATE_MESSAGES items FIRST,
    // then the projection applies the budget), so the promise holds only when
    // the budget spent itself exactly on the window's LAST item. A stop earlier
    // than that leaves in-window messages — newer than the cursor, older than
    // the last one returned — that the cursor would silently jump over (no
    // tool takes a history-walk cursor, so they can only be re-read).
    //
    // (a) WHOLE-WINDOW STOP: 19 tiny messages then ONE fat message as the 20th
    //     (last) item of the aggregate window, with a 21st message behind the
    //     ceiling so the walk is truncated. The budget trips on the fat item,
    //     every collected item is returned, and nothing lies between the
    //     cursor and the result — the cursor is honest and must be present.
    // (b) MID-WINDOW STOP: the fat message is FIRST, so the budget trips on
    //     item 1 of a 3-item window. The cursor would point past `m-1`/`m-2`,
    //     silently skipping them, so it must be OMITTED — the walk is still
    //     flagged as truncated, just without a jump-over resume point.
    const fat = (messageId: string, kib: number): FakeMessageRecord => ({
      messageId,
      revision: '1',
      role: 'assistant',
      status: 'success',
      parts: [{ kind: 'text', text: 'F'.repeat(kib * 1024) }],
    })

    const wholeWindowStop = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        // NEWEST-FIRST: the fat message sits at index 19 — the LAST item the
        // 20-message window collects — and `t-0` sits just past the ceiling so
        // the aggregate answers truncated with a next page to continue at.
        messages: Array.from({ length: 19 }, (_unused, index) => fat(`w-${index}`, 1))
          .concat([fat('w-fat', 245), fat('t-0', 1)]),
      },
      hello: { limits: { pageItems: 100 } },
    })
    const whole = (await wholeWindowStop.call('cherry_wait', { device: 'dev-A', sessionId: 's-1' })) as {
      status: string
      messages: Array<{ messageId: string }>
      messagesTruncated?: boolean
      messagesTruncationReason?: string
      messagesResumeCursor?: string
    }

    expect(whole.status).toBe('idle')
    expect(whole.messagesTruncated).toBe(true)
    expect(whole.messagesTruncationReason).toBe('aggregate-bytes')
    // The budget spent itself on the window's LAST item: everything collected
    // is on the result, fat message and all.
    expect(whole.messages).toHaveLength(20)
    expect(whole.messages[19]!.messageId).toBe('w-fat')
    // Nothing lies between the cursor and what was returned: it honestly marks
    // where the unread history begins, at the first message this walk did NOT
    // take (`t-0`).
    expect(typeof whole.messagesResumeCursor).toBe('string')
    expect(Number(whole.messagesResumeCursor)).toBe(20)

    const midWindowStop = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        // The fat message is FIRST and the peer holds 20 more behind it: the
        // aggregate window FILLS (20 items, `nextCursor` past them), and the
        // budget trips on item 1 — leaving items 2..20 collected but
        // unreturned. This is the state where the parent commit still handed
        // out the cursor, silently promising a resume that jumps items 2..20.
        messages: [fat('m-0', 260)].concat(Array.from({ length: 20 }, (_unused, index) => fat(`m-${index + 1}`, 1))),
      },
      hello: { limits: { pageItems: 100 } },
    })
    const mid = (await midWindowStop.call('cherry_wait', { device: 'dev-A', sessionId: 's-1' })) as {
      status: string
      messages: Array<{ messageId: string }>
      messagesTruncated?: boolean
      messagesTruncationReason?: string
      messagesResumeCursor?: string
    }

    expect(mid.status).toBe('idle')
    expect(mid.messagesTruncated).toBe(true)
    expect(mid.messagesTruncationReason).toBe('aggregate-bytes')
    // The walk stopped BEFORE the end of its window: items 2..20 were
    // collected but are not on the result.
    expect(mid.messages.map((message) => message.messageId)).toEqual(['m-0'])
    // So no stop point is offered: the peer's `nextCursor` would be past item
    // 20, naming a position that skips items 2..20. (The parent commit
    // attached it here — this assertion is the red line for that behaviour.)
    expect(mid.messagesResumeCursor).toBeUndefined()
  })
})

describe('issue #14: a byte-budget cut drops WHOLE messages, and says which end', () => {
  it('T5d `aggregate-bytes` retains complete messages with no `incomplete` field — the budget cuts BETWEEN messages', async () => {
    // The acceptance the field misdiagnosis missed. A taker of this result read
    // `messagesTruncated: true, messagesTruncationReason: 'aggregate-bytes'` as
    // "content was cut mid-message, so the run was interrupted". The budget is
    // only ever checked AFTER a message is fully projected, so what a byte stop
    // removes is the OLDER messages, and every retained message arrives whole —
    // no `incomplete`, no `unavailableParts`, every part carrying its text.
    const fat = (messageId: string, kib: number): FakeMessageRecord => ({
      messageId,
      revision: '1',
      role: 'assistant',
      status: 'success',
      parts: [{ kind: 'text', text: 'F'.repeat(kib * 1024) }],
    })
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        // 260 KiB alone exceeds the 256 KiB budget: the walk takes the newest
        // message, trips, and stops — the two older ones are what gets dropped.
        messages: [fat('b-0', 260), fat('b-1', 1), fat('b-2', 1)],
      },
    })

    const idle = (await rig.call('cherry_wait', { device: 'dev-A', sessionId: 's-1' })) as {
      status: string
      messages: Array<{
        messageId: string
        parts: Array<{ content: string; unavailable?: string }>
        incomplete?: true
        unavailableParts?: number
      }>
      messagesTruncated?: boolean
      messagesTruncationReason?: string
      messagesResumeCursor?: string
    }

    expect(idle.status).toBe('idle')
    expect(idle.messagesTruncated).toBe(true)
    expect(idle.messagesTruncationReason).toBe('aggregate-bytes')
    // The budget cut between messages: the newest survived COMPLETE, and the
    // dropped ones are the OLDER ones.
    expect(idle.messages.map((message) => message.messageId)).toEqual(['b-0'])
    expect(idle.messages[0]!.parts[0]!.content).toHaveLength(260 * 1024)
    // NOTHING in the retained message claims damage: the truncation verdict is
    // the walk's, and the message itself is whole. This is the line the field
    // report crossed.
    expect(idle.messages[0]).not.toHaveProperty('incomplete')
    expect(idle.messages[0]).not.toHaveProperty('unavailableParts')
    expect(idle.messages[0]!.parts[0]!.unavailable).toBeUndefined()
  })
})

describe('issue #3 T2: the text anchor is the NEWEST assistant message, never the oldest', () => {
  it('T2a a timeout over a history whose newest assistant is an empty pending run reports text "" — not the July message', async () => {
    // The exact field shape: the run's assistant message is PENDING with an
    // EMPTY part list (the run has not committed anything to the history face
    // yet — its parts ride the event stream as `part.append`), while older
    // completed runs sit behind it, the OLDEST of them a stale "July answer".
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        messages: [
          assistantMessage('m-pending', '', 'pending'),
          assistantMessage('m-previous', 'the previous run'),
          assistantMessage('m-july', 'july answer'),
        ],
        runDelayMs: 30_000,
      },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'slow',
      timeoutMs: 800,
    })) as { status: string; text?: string; messages: Array<{ messageId: string }> }

    expect(result.status).toBe('timeout')
    // The answer is HONESTLY empty: the newest assistant message is the run's
    // own, and it has nothing in the history face yet. Anything non-empty here
    // would be an older run's text presented as this run's output.
    expect(result.text).toBe('')
    expect(result.text).not.toContain('july answer')
    expect(result.text).not.toContain('the previous run')
    // The messages array is still the newest-first history, for context.
    expect(result.messages.map((message) => message.messageId)).toEqual(['m-pending', 'm-previous', 'm-july'])
  })

  it('T2a2 the same anchoring holds when the newest assistant message DOES carry text', async () => {
    // The complement: with a streamed-in partial (the newest message has text),
    // the fallback must find THAT one rather than any older message.
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        messages: [
          assistantMessage('m-partial', 'here is the first half', 'pending'),
          assistantMessage('m-previous', 'the previous run'),
          assistantMessage('m-july', 'july answer'),
        ],
        runDelayMs: 30_000,
      },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'slow',
      timeoutMs: 800,
    })) as { status: string; text?: string }

    expect(result.status).toBe('timeout')
    expect(result.text).toBe('here is the first half')
  })

  it('T2b a terminal whose terminalMessageId is in the walk still reports that message — the anchor change does not disturb the named cut', async () => {
    // REGRESSION GUARD on the existing behaviour: when the peer names the
    // persisted message, the text is that message and nothing else, whatever
    // its position in the (newest-first) array. Here it is deliberately NOT
    // the newest assistant message, so a fix that merely "took index 0" would
    // fail this.
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        // Newest-first. The run persists `m-done` when it settles (the fake
        // appends it, as the real peer does), and `m-later` is already the
        // newest message in the fixture — so `m-done` arrives BEHIND it and a
        // "take index 0" shortcut would report 'a later message' instead.
        messages: [assistantMessage('m-later', 'a later message')],
        runMessageId: 'm-done',
        terminalMessage: assistantMessage('m-done', 'the run reply'),
      },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'hello',
      timeoutMs: 10_000,
    })) as { status: string; text?: string }

    expect(result.status).toBe('completed')
    expect(result.text).toBe('the run reply')
  })
})

describe('issue #3 T3: a failed content assembly degrades to a stub receipt instead of an MCP error', () => {
  it('T3 a tampered {ref} during the timeout aggregate yields aggregateError + commandId, not a thrown error', async () => {
    // A 30 KiB part travels as a {ref}; corrupting its stored bytes without
    // re-deriving the advertised digest is exactly the ContentIntegrityError
    // path (`cherry_read` still fails loudly on it — see toolsRead ④j).
    const external: FakeMessageRecord = {
      messageId: 'm-ext',
      revision: '1',
      role: 'assistant',
      status: 'pending',
      parts: [{ kind: 'text', text: 'X'.repeat(30 * 1024), external: true }],
    }
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        messages: [external, ...fillerHistory(3)],
        runDelayMs: 30_000,
      },
    })

    // Project the part once through the read face so the fake pins its bytes
    // and digest, then corrupt the bytes behind the pin.
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    rig.fake.tamperContent('m-ext:0', '1', 'tampered bytes')

    // The CALL RESOLVES: the run verdict (timeout) stands on its own.
    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'slow',
      timeoutMs: 800,
    })) as {
      status?: string
      sessionId?: string
      commandId?: string
      executionId?: string | null
      aggregateError?: string
      guidance?: string
      messages?: unknown
      text?: unknown
    }

    expect(result.status).toBe('timeout')
    expect(result.sessionId).toBe('s-1')
    // The identifier the field report could not obtain: the receipt's
    // commandId (the MCP-layer failure used to swallow it).
    expect(typeof result.commandId).toBe('string')
    expect(result.commandId!.length).toBeGreaterThan(0)
    // The assembly failure is reported, bounded, and explained.
    expect(typeof result.aggregateError).toBe('string')
    expect(result.aggregateError!.length).toBeGreaterThan(0)
    expect(result.aggregateError!.length).toBeLessThanOrEqual(200)
    expect(String(result.guidance)).toContain('cherry_read')
    // A stub carries NO content: half of a failed assembly must never be
    // presented as the run's output.
    expect(result.messages).toBeUndefined()
    expect(result.text).toBeUndefined()
  })

  it('T3b the same degradation holds for an idle snapshot (the walk is the same one)', async () => {
    const external: FakeMessageRecord = {
      messageId: 'm-ext',
      revision: '1',
      role: 'assistant',
      status: 'success',
      parts: [{ kind: 'text', text: 'Y'.repeat(30 * 1024), external: true }],
    }
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION], messages: [external] } })

    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    rig.fake.tamperContent('m-ext:0', '1', 'tampered bytes')

    const idle = (await rig.call('cherry_wait', { device: 'dev-A', sessionId: 's-1' })) as {
      status?: string
      sessionId?: string
      aggregateError?: string
      guidance?: string
      messages?: unknown
      text?: unknown
    }

    expect(idle.status).toBe('idle')
    expect(idle.sessionId).toBe('s-1')
    expect(typeof idle.aggregateError).toBe('string')
    expect(String(idle.guidance)).toContain('cherry_read')
    expect(idle.messages).toBeUndefined()
    expect(idle.text).toBeUndefined()
  })
})

describe('issue #3 T4: a timeout answer carries a zero-round-trip heartbeat', () => {
  it('T4 with buffered events the timeout reports the newest event seq and kind', async () => {
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], messages: [assistantMessage('m-1', 'x')], runDelayMs: 30_000 },
    })

    const pending = rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'slow',
      timeoutMs: 1_500,
    }) as Promise<{ status: string; progress?: { lastEventSeq?: number; lastEventKind?: string } }>

    // Stall long enough for the send to have admitted and subscribed, then push
    // a KNOWN event: the run has not settled, but the stream is demonstrably
    // alive — which is the whole distinction the heartbeat exists to make.
    await new Promise((resolve) => setTimeout(resolve, 300))
    rig.fake.pushEvent('s-1', { kind: 'message.updated', payload: { baseRevision: '2', message: { messageId: 'm-1', revision: '2', role: 'assistant', status: 'pending' } } })

    const result = await pending
    expect(result.status).toBe('timeout')
    // The progress block is derived from the buffer the waiter ALREADY holds —
    // no extra RPC — so its values are the buffered event's own.
    expect(result.progress).toBeDefined()
    expect(result.progress?.lastEventKind).toBe('message.updated')
    expect(Number(result.progress?.lastEventSeq)).toBeGreaterThan(0)
  })

  it('T4b with nothing in the buffer the progress block is omitted rather than invented', async () => {
    // A run that emits NOTHING: the buffer holds no event at all, so there is
    // no heartbeat to report and the field is absent (never a zero/empty
    // placeholder a caller could mistake for "the stream is at seq 0").
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], messages: [assistantMessage('m-1', 'x')], runDelayMs: 30_000 },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'slow',
      timeoutMs: 800,
    })) as { status: string; progress?: unknown }

    expect(result.status).toBe('timeout')
    expect(result.progress).toBeUndefined()
  })
})
