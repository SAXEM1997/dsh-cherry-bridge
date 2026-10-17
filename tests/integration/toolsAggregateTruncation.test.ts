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
 * `truncationReason` + the resume cursor). The three results that ride the SAME
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
 * `TERMINAL_AGGREGATE_MESSAGES = 20`, with a `TERMINAL_AGGREGATE_BYTES` budget on
 * top. The rule under test is unchanged (a walk that stopped early is SURFACED,
 * never silent); what changed is the number and, therefore, WHICH bound trips:
 * a caller-limit stop is `'limit'`, and here the caller is the tool itself. The
 * assertions below read `'limit'` rather than `'safety-bound'` for that reason,
 * and F2-1e was rewritten: the old fallback anchored the array's TAIL — the
 * OLDEST assistant message — and is now anchored at the NEWEST.
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
    // Where to resume: the peer's cursor, as a decimal string.
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

  it('F2-1e the no-anchor case flags a bounded walk, and the fallback reads the NEWEST end (issue #3)', async () => {
    // `omitSendExecutionId` makes the wait ADOPT the run, so no terminal
    // message id is carried and the text falls back to an assistant message
    // the walk happened to include.
    //
    // ISSUE #3 CHANGED WHICH ONE. The fallback used to anchor the array's TAIL
    // on the assumption that the history read oldest-first; it does not (the
    // peer walks newest-first), so the tail was the OLDEST assistant message in
    // the session. It is now anchored at the NEWEST, and the fixture's newest
    // message is the run's own reply. The flag still matters — the walk stopped
    // at the tool's ceiling, so the array is a WINDOW, not the history — but
    // the text it produces is the current run's, not a July message's.
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        // NEWEST-FIRST: at settlement the fake puts the run's message in front
        // of whatever the fixture declared, so the run's message becomes the
        // newest assistant message, with the 60 declared ones behind it — all
        // OUTSIDE the bounded newest window (issue #3: 20 messages).
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
      messagesTruncated?: boolean
      messagesTruncationReason?: string
    }

    // The bound is NEVER silent.
    expect(result.messagesTruncated).toBe(true)
    // The tool's message ceiling binds — see issue #3 and F2-1b above.
    expect(result.messagesTruncationReason).toBe('limit')
    // The fallback anchor is the NEWEST assistant message — here that is the
    // run's own (the newest USER turn in front of it has the other role) — so
    // the answer is the run's text, reached without the terminal naming it.
    // The OLD anchor, which read the array's tail, would have reported the
    // 60-messages-old `old-59` instead.
    expect(result.text).toBe('the run reply')
  })
})
