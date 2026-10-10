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
    expect(idle.messagesTruncationReason).toBe('safety-bound')
    // Where to resume: the peer's cursor, as a decimal string.
    expect(typeof idle.messagesResumeCursor).toBe('string')
    expect(Number(idle.messagesResumeCursor)).toBeGreaterThan(0)
    // The aggregate really is bounded, and the text is best-effort — not silent.
    expect(idle.messages.length).toBeLessThanOrEqual(1000)
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
    expect(result.messagesTruncationReason).toBe('safety-bound')
    expect(typeof result.messagesResumeCursor).toBe('string')
    // The EVENT cursor is a different thing and must still be there.
    expect(result.cursor).toBeDefined()
  })

  it('F2-1d a terminal aggregate whose terminal message is OUT of reach flags instead of answering silently', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        // 1001 messages, and the run appends its own 1002nd — beyond the
        // ceiling. A walk that stops at 1000 can therefore never see it.
        messages: longHistory(),
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
      messages: unknown[]
      messagesTruncated?: boolean
      messagesTruncationReason?: string
      messagesResumeCursor?: string
    }

    expect(result.status).toBe('completed')
    // The run's own text is NOT in the aggregate, and the result SAYS SO
    // rather than presenting the partial aggregate as the run's output.
    expect(result.messagesTruncated).toBe(true)
    expect(result.messagesTruncationReason).toBe('safety-bound')
    expect(typeof result.messagesResumeCursor).toBe('string')
  })

  it('F2-1e the no-anchor case (no terminalMessageId, last message out of reach) flags rather than passing stale text off as the run', async () => {
    // `omitSendExecutionId` makes the wait ADOPT the run, so no terminal
    // message id is carried; the text then falls back to the LAST assistant
    // message in the walk. When the walk stopped early that fallback is a
    // PREVIOUS run's message — staleness the flag must expose.
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        messages: longHistory(),
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

    // Best-effort stale text MAY remain — but never unflagged.
    expect(result.messagesTruncated).toBe(true)
    expect(result.messagesTruncationReason).toBe('safety-bound')
    // And the stale text is NOT the run's reply, which is exactly why the flag
    // has to be there.
    expect(result.text).not.toContain('the run reply')
  })
})
