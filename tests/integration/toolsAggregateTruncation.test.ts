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
 * R3-F2 acceptance suite: the AGGREGATE SURFACING rule.
 *
 * `cherry_read` has always reported a walk that stopped early (`truncated` +
 * `truncationReason` + the stop-point cursor). The three results that ride the SAME
 * `#readTerminalMessages` walk — `cherry_send`'s terminal aggregate, the timeout
 * result, and `cherry_wait`'s idle snapshot — did not: on a session whose
 * history exceeds the tool-side 1000-message aggregate ceiling they silently
 * returned a partial (or empty) aggregate as though it were the run's whole
 * output. That is precisely the outcome the engine's own invariant forbids
 * (tools.ts: "a walk never stops early and reports success").
 *
 * These tests are the DISCRIMINATOR: the truncation is forced by making the
 * peer page smaller than the message count, so the aggregate ceiling is reached
 * with the peer still holding pages.
 *
 * ISSUE #3 LOWERED THAT CEILING — from the generic 1000-item aggregate bound to
 * `TERMINAL_AGGREGATE_MESSAGES = 20`, with an `AGGREGATE_BYTES` budget on
 * top. The rule under test is unchanged (a walk that stopped early is SURFACED,
 * never silent); what changed is the number and, therefore, WHICH bound trips:
 * a caller-limit stop is `'limit'`, and here the caller is the tool itself. The
 * assertions below read `'limit'` rather than `'safety-bound'` for that reason,
 * and F2-1e was rewritten: the old fallback anchored the array's TAIL — the
 * OLDEST assistant message — and is now anchored at the NEWEST. Review
 * follow-up: F2-1e now honestly describes what it pins (the by-id cut and the
 * truncation verdict its 25-message fixture really exercises), and F2-1f is
 * the test that drives the NO-ANCHOR path — `omitExecutionMessageId` makes the
 * peer's terminals omit `messageId`, so the fallback anchor itself is what
 * produces the text and a tail anchor turns that test red.
 */

/** One assistant message fixture, page-cheap (a single tiny text part). */
function assistantMessage(index: number, text = `a${index}`): FakeMessageRecord {
  return {
    messageId: `m-${index}`,
    revision: '1',
    role: 'assistant',
    status: 'success',
    parts: [{ kind: 'text', text }],
  }
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
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-tools-trunc-'))
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
      // The suite's fixtures are 1001 messages, which the production 32 req/s
      // business budget would pace out over ~30s of wall clock. The peer here is
      // loopback and has no rate cap of its own, so the budget is raised purely
      // to keep the suite fast; the truncation under test is a TOOL-side
      // ceiling and is indifferent to how quickly the pages arrive.
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
      throw new Error('pairing is not exercised by the truncation suite')
    },
    evict: () => {
      throw new Error('the truncation suite never evicts')
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

/** The message a settling run persists — the terminal names this id. */
const RUN_MESSAGE: FakeMessageRecord = {
  messageId: 'm-run',
  revision: '1',
  role: 'assistant',
  status: 'success',
  parts: [{ kind: 'text', text: 'the run reply' }],
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
 * MORE assistant messages than the tool-side aggregate ceiling (1000), with the
 * peer paging at 100 so the walk really pages rather than arriving in one go.
 *
 * The messages are tiny (a few bytes of text each), so 1001 of them cost
 * milliseconds — the ④f pattern's generator, applied to MESSAGES.
 */
const MESSAGE_COUNT = 1001
function longHistory(): FakeMessageRecord[] {
  return Array.from({ length: MESSAGE_COUNT }, (_unused, index) => assistantMessage(index))
}

/**
 * `count` filler messages under their own id space, NEWEST-FIRST.
 *
 * Distinct ids from `longHistory()` so a scenario can assert WHICH window it
 * got: `old-0` is the newest filler, `old-${count - 1}` the oldest.
 */
function fillerHistory(count: number): FakeMessageRecord[] {
  return Array.from({ length: count }, (_unused, index) => ({
    messageId: `old-${index}`,
    revision: '1',
    role: 'assistant' as const,
    status: 'success' as const,
    parts: [{ kind: 'text' as const, text: `old ${index}` }],
  }))
}

describe('R3-F2: terminal/timeout/idle aggregates surface a truncated message walk', () => {
  it('F2-1a a terminal message WITHIN reach still aggregates the run text correctly (no false truncation)', async () => {
    // The other half of the parity rule: the flag must appear ONLY when the walk
    // really stopped early. A short history is aggregated to completion, and an
    // idle snapshot that flags it would be a false alarm a caller cannot act on.
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        messages: [
          assistantMessage(0, 'first'),
          {
            messageId: 'm-run',
            revision: '1',
            role: 'assistant',
            status: 'success',
            parts: [{ kind: 'text', text: 'the run reply' }],
          },
        ],
        maxPageSize: 100,
      },
    })

    const idle = (await rig.call('cherry_wait', { device: 'dev-A', sessionId: 's-1' })) as {
      status: string
      messagesTruncated?: boolean
      messagesResumeCursor?: string
      messages?: Array<{ messageId: string }>
    }

    expect(idle.status).toBe('idle')
    // The walk reached the peer's end, so the WHOLE history is here and the
    // result says nothing about truncation.
    expect(idle.messages).toHaveLength(2)
    expect(idle.messages?.[1]?.messageId).toBe('m-run')
    expect(idle.messagesTruncated).toBeUndefined()
    expect(idle.messagesResumeCursor).toBeUndefined()
  })

  it('F2-1b an idle snapshot beyond the ceiling flags the truncation and offers a resume cursor', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        messages: longHistory(),
        maxPageSize: 100,
      },
    })

    const idle = (await rig.call('cherry_wait', { device: 'dev-A', sessionId: 's-1' })) as {
      status: string
      text?: string
      messages: unknown[]
      messagesTruncated?: boolean
      messagesTruncationReason?: string
      messagesResumeCursor?: string
    }

    expect(idle.status).toBe('idle')
    // The walk stopped at the ceiling: the flag is the honest face.
    expect(idle.messagesTruncated).toBe(true)
    // The TOOL's own message ceiling binds here (`limit`), not the internal
    // circuit-breaker: since issue #3 the caller-facing bound for these three
    // answers is `TERMINAL_AGGREGATE_MESSAGES` (20), which is set independently
    // of `MAX_AGGREGATE_LIMIT` and therefore reads as a caller limit.
    expect(idle.messagesTruncationReason).toBe('limit')
    // The stop point: the peer's cursor, as a decimal string. It marks where
    // the unread history begins; it is not an input to any tool.
    expect(typeof idle.messagesResumeCursor).toBe('string')
    expect(Number(idle.messagesResumeCursor)).toBeGreaterThan(0)
    // The aggregate really is bounded (issue #3), and the text is best-effort —
    // not silent.
    expect(idle.messages.length).toBeLessThanOrEqual(20)
    expect(idle.messages.length).toBeGreaterThan(0)
  })

  it('F2-1c a timeout result flags the truncation too, alongside its partial content', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        messages: longHistory(),
        maxPageSize: 100,
        // The run never settles inside the caller's window.
        runDelayMs: 30_000,
      },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'slow',
      timeoutMs: 1_000,
    })) as {
      status: string
      messagesTruncated?: boolean
      messagesTruncationReason?: string
      messagesResumeCursor?: string
      cursor?: unknown
    }

    expect(result.status).toBe('timeout')
    expect(result.messagesTruncated).toBe(true)
    // The tool's message ceiling binds — see issue #3 and F2-1b above.
    expect(result.messagesTruncationReason).toBe('limit')
    expect(typeof result.messagesResumeCursor).toBe('string')
    // The EVENT cursor is a different thing and must still be there.
    expect(result.cursor).toBeDefined()
  })

  it('F2-1d a terminal aggregate whose terminal message is OUT of reach flags instead of answering silently', async () => {
    // The terminal NAMES a message that the bounded walk cannot reach. Issue #3
    // bounds the walk to the NEWEST 20 messages (the peer walks newest-first),
    // so a run whose message was persisted behind 41 newer messages is outside
    // it — the exact shape a session with a deep history produces. The answer
    // must SAY the aggregate is partial rather than present it as the run's
    // output.
    //
    // `runMessageId` names the out-of-reach message for the terminal event
    // WITHOUT persisting a copy of it at the newest end, so nothing in the
    // window can accidentally satisfy the id.
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        // NEWEST-FIRST, and the run's message sits 41 back.
        messages: [...fillerHistory(41), RUN_MESSAGE],
        maxMessagePageSize: 100,
        runMessageId: 'm-run',
      },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'hello',
      timeoutMs: 10_000,
    })) as {
      status: string
      text?: string
      messages: Array<{ messageId: string }>
      messagesTruncated?: boolean
      messagesTruncationReason?: string
      messagesResumeCursor?: string
    }

    expect(result.status).toBe('completed')
    // The run's own text is NOT in the aggregate, and the result SAYS SO
    // rather than presenting the partial aggregate as the run's output.
    expect(result.messagesTruncated).toBe(true)
    // The tool's message ceiling binds — see issue #3 and F2-1b above.
    expect(result.messagesTruncationReason).toBe('limit')
    expect(typeof result.messagesResumeCursor).toBe('string')
    // The LIMIT IS ON THE WIRE: no page is asked for more than the tool-side
    // ceiling (issue #3), so the walk cannot quietly grow back to the history.
    for (const call of rig.fake.readCallsFor('agent.messages.list')) {
      expect(call['limit'] as number).toBeLessThanOrEqual(20)
    }
    // The walk starts at the NEWEST message (issue #3) and takes 20 of them, so
    // the run's message — 41 back — is outside the window it returns.
    expect(result.messages.length).toBeLessThanOrEqual(20)
    expect(result.messages.map((message) => message.messageId)).not.toContain('m-run')
    // The run's text is therefore NOT the answer, and the flags above are why
    // the caller knows that rather than reading an empty string as "no output".
    expect(result.text).toBe('')
  })

  it('F2-1e a terminal aggregate within reach is cut BY ID, and a bounded walk still flags its truncation (issue #3)', async () => {
    // WHAT THIS PINS. The terminal names the message the run persisted, and the
    // aggregate cuts the session history at THAT id — `messages.length`
    // therefore equals the number of messages carrying it, and the text is the
    // named message's own text, not an older run's. The history behind the run
    // exceeds the tool ceiling (`TERMINAL_AGGREGATE_MESSAGES = 20`), so the walk
    // stops at 20 and the verdict SAYS so: a WINDOW of the history was
    // aggregated, never the whole of it.
    //
    // WHAT THIS DOES NOT PIN: the no-anchor fallback. This fake's terminal
    // names a message, so the text goes through the id filter above and never
    // reaches the fallback branch; F2-1f is the test that drives the peer into
    // omitting the message id and so exercises the anchor itself.
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        // NEWEST-FIRST. At settlement the fake PREPENDS the run's message, so
        // it becomes the newest, with these 25 declared ones behind it — past
        // the bounded newest window (issue #3: 20 messages).
        messages: fillerHistory(25),
        maxPageSize: 100,
        terminalMessage: {
          messageId: 'm-run',
          revision: '1',
          role: 'assistant',
          status: 'success',
          parts: [{ kind: 'text', text: 'the run reply' }],
        },
      },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'hello',
      timeoutMs: 10_000,
    })) as {
      status: string
      text?: string
      messages: Array<{ messageId: string }>
      messagesTruncated?: boolean
      messagesTruncationReason?: string
    }

    expect(result.status).toBe('completed')
    // The bound is NEVER silent.
    expect(result.messagesTruncated).toBe(true)
    // The tool's message ceiling binds — see issue #3 and F2-1b above.
    expect(result.messagesTruncationReason).toBe('limit')
    // The id really is on the wire (this is the path F2-1e pins)...
    expect(rig.fake.executionUpdates.at(-1)?.messageId).toBe('m-run')
    // ...and the cut is BY ID: the named message is the one the text comes
    // from, even though 19 older assistant messages ride the same window and
    // say something else. (`messages` itself is the WINDOW, context only.)
    expect(result.messages.map((message) => message.messageId)).toContain('m-run')
    expect(result.messages.length).toBe(20)
    expect(result.text).toBe('the run reply')
  })

  it('F2-1f a terminal that does NOT name its message falls back to the NEWEST assistant message (issue #3)', async () => {
    // WHAT THIS PINS: the FALLBACK ANCHOR. `omitExecutionMessageId` makes every
    // `execution.updated` omit `messageId` — a legal wire shape (the field is
    // optional in `agentJournal.ts`'s payload and in `executionSchema`). With no
    // name to cut at, the text can only come from the anchor in
    // `aggregateAssistantText`, so this test is red exactly when that anchor
    // reads the wrong end of the array.
    //
    // The fixture is built so the two ends DISAGREE about which message is an
    // assistant's: the newest entry is a USER message with a stale-looking
    // line, and the OLDEST end carries a "july answer". Anchoring the NEWEST
    // assistant message (index 1) yields the run's reply; the old tail anchor
    // would have produced the july text, and a naive "index 0" anchor the user's
    // line. The intervening filler is noise neither answer may come from.
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        // NEWEST-FIRST. The run's message is PREPENDED at settlement, so the
        // final order is: m-run, user turn, 25 fillers, july answer — 28
        // messages against the 20-message ceiling, so the walk is a WINDOW.
        messages: [
          {
            messageId: 'm-user',
            revision: '1',
            role: 'user',
            status: 'success',
            parts: [{ kind: 'text', text: 'the user prompt' }],
          },
          ...fillerHistory(25),
          assistantMessage(900, 'july answer'),
        ],
        maxPageSize: 100,
        terminalMessage: {
          messageId: 'm-run',
          revision: '1',
          role: 'assistant',
          status: 'success',
          parts: [{ kind: 'text', text: 'the run reply' }],
        },
        // THE POINT OF THE TEST: no terminal event names a message.
        omitExecutionMessageId: true,
      },
    })

    const result = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'hello',
      timeoutMs: 10_000,
    })) as {
      status: string
      text?: string
      messages: Array<{ messageId: string; role: string }>
      messagesTruncated?: boolean
      messagesTruncationReason?: string
    }

    expect(result.status).toBe('completed')
    // The knob really took effect: the last terminal carries no message id, so
    // nothing below can have come from the id filter.
    expect(rig.fake.executionUpdates.at(-1)?.messageId).toBeUndefined()
    // The fallback found the NEWEST assistant message — the run's own reply.
    expect(result.text).toBe('the run reply')
    expect(result.text).not.toContain('july answer')
    expect(result.text).not.toContain('the user prompt')
    // The bounded window SURVIVED from the newest end: index 0 is the run's
    // assistant message, and the walk's cut is surfaced rather than silent.
    expect(result.messages[0]?.messageId).toBe('m-run')
    expect(result.messages[0]?.role).toBe('assistant')
    // The window really is bounded (the filler pushed the july answer and the
    // walk's own cut out of it), so the flag cannot be delivered vacuously.
    expect(result.messages.map((message) => message.messageId)).not.toContain('m-old-900')
    expect(result.messages.length).toBe(20)
    expect(result.messagesTruncated).toBe(true)
    expect(result.messagesTruncationReason).toBe('limit')
  })
})
