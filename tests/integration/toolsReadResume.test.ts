import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { LIST_PAGE_CLAMP } from '../../src/defaults.js'
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
 * Issue #26 acceptance suite: `messagesResumeCursor` is an INPUT.
 *
 * Before this issue the stop-point marker was a dead end. On an `aggregate-bytes`
 * stop the older messages were unreachable through ANY argument of ANY tool
 * (the walk always started at the newest message and took no cursor), and on a
 * `limit` stop the marker was the peer's raw page position, which no tool
 * accepted either. A caller could see the loss and could not act on it.
 *
 * The contract exercised here:
 *
 *  - ONE vocabulary, two self-describing token forms:
 *    `cursor:<peerPosition>` (the whole collected window was consumed) and
 *    `after:<messageId>` (the stop happened INSIDE the window, so the peer's
 *    page position would skip messages this walk trimmed).
 *  - ROUND-TRIP SYMMETRY: the token `cherry_read` emits is the token
 *    `cherry_read` accepts, on both faces (`cherry_read` itself, and the
 *    terminal/timeout/idle aggregate, whose `after:` token is feedable here).
 *  - The peer's cursor FORMAT is never parsed or validated — the real desktop's
 *    is an opaque keyset token, the fake's is a numeric offset — so every token
 *    we emit carries a prefix this bridge itself wrote, and a foreign string is
 *    refused HERE instead of being forwarded (the real desktop silently falls
 *    back to the newest page for a malformed cursor, which would present the
 *    newest page again as "continued history").
 *  - An anchor the walk cannot find is LOUD, never an empty result.
 *
 * The rig is the `toolsRead.test.ts` one, duplicated per the house style for
 * integration suites that need their own fixture story.
 */

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

async function makeRig(options: FakeCherryOptions = {}, dial = true): Promise<Rig> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-tools-resume-'))
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

  const connectDevice = (deviceId: string): DeviceConnection => {
    const existing = connections.get(deviceId)
    if (existing !== undefined) return existing
    const stored = store.list().find((entry) => entry.deviceId === deviceId)
    if (stored === undefined) throw new Error(`no device ${deviceId}`)
    const connection = new DeviceConnection({
      identity,
      record: stored,
      // The peer is loopback and enforces no rate cap of its own; the
      // production business budget would pace a multi-page fixture out over
      // seconds of wall clock. Every bound under test is TOOL-side.
      rateBudgetPerSecond: 100_000,
    })
    connections.set(deviceId, connection)
    return connection
  }

  const subs = (deviceId: string): SessionSubscriptions => {
    const existing = subscriptions.get(deviceId)
    if (existing !== undefined) return existing
    const connection = connectDevice(deviceId)
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
    connect: connectDevice,
    subs,
    pair: async () => {
      throw new Error('pairing is not exercised by the read-resume suite')
    },
    evict: () => {
      throw new Error('the read-resume suite never evicts')
    },
  }
  const engine: CherryToolEngineOptions = {}
  registerCherryTools(ctx, deps, engine)
  if (dial) await connectDevice('dev-A').connect()

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

/** Tiny user message `m-<index>`, part text `t-<index>`. */
function tiny(index: number): FakeMessageRecord {
  return {
    messageId: `m-${index}`,
    revision: `100${index}`,
    role: 'user',
    status: 'success',
    parts: [{ kind: 'text', text: `t-${index}` }],
  }
}

/** `count` tiny messages, newest first (fixture index 0 is the NEWEST). */
function history(count: number): FakeMessageRecord[] {
  return Array.from({ length: count }, (_unused, index) => tiny(index))
}

/** A 1-byte-per-KiB filler part message, for forcing a byte stop. */
function fat(messageId: string, kib: number): FakeMessageRecord {
  return {
    messageId,
    revision: '1',
    role: 'assistant',
    status: 'success',
    parts: [{ kind: 'text', text: 'F'.repeat(kib * 1024) }],
  }
}

interface ReadResult {
  messages: Array<{ messageId: string }>
  truncated: boolean
  truncationReason?: string
  messagesResumeCursor?: string
}

const ids = (result: { messages: Array<{ messageId: string }> }): string[] =>
  result.messages.map((message) => message.messageId)

describe('issue #26: the message stop point is a resume INPUT', () => {
  it('① a `limit` stop emits `cursor:<peerPosition>` and feeding it back returns the older messages', async () => {
    // 47 messages, peer paging at the byte-safe clamp (16): `limit: 20` asks
    // 16 + 4, both served whole, and the walk holds the peer's offsets for its
    // second page — 16 + 4 = 20.
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: history(47) },
    })

    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 20 })) as ReadResult
    expect(first.truncated).toBe(true)
    expect(first.truncationReason).toBe('limit')
    expect(ids(first)).toEqual(history(20).map((message) => message.messageId))
    // The token is SELF-DESCRIBING: the peer's format is never validated by
    // this bridge, so what it hands out says which form it is.
    expect(first.messagesResumeCursor).toBe('cursor:20')

    // FEED IT BACK. The walk resumes exactly where it stopped: the resume's
    // FIRST `agent.messages.list` request already carries the peer position,
    // so nothing between m-0 and m-19 is sent again.
    const before = rig.fake.readCallsFor('agent.messages.list').length
    const resumed = (await rig.call('cherry_read', {
      device: 'dev-A',
      sessionId: 's-1',
      limit: 20,
      messagesResumeCursor: first.messagesResumeCursor,
    })) as ReadResult
    const resumeCalls = rig.fake.readCallsFor('agent.messages.list').slice(before)
    expect(resumeCalls[0]?.['cursor']).toBe('20')
    expect(ids(resumed)).toEqual(history(47).slice(20, 40).map((message) => message.messageId))
    for (const returned of ids(first)) expect(ids(resumed)).not.toContain(returned)
    // 40 of 47 read: the walk stopped on the caller's ceiling again, and the
    // next token chains onward.
    expect(resumed.truncated).toBe(true)
    expect(resumed.truncationReason).toBe('limit')
    expect(resumed.messagesResumeCursor).toBe('cursor:40')

    const last = (await rig.call('cherry_read', {
      device: 'dev-A',
      sessionId: 's-1',
      limit: 20,
      messagesResumeCursor: resumed.messagesResumeCursor,
    })) as ReadResult
    expect(ids(last)).toEqual(history(47).slice(40).map((message) => message.messageId))
    // The peer's end was reached: nothing older is unread, so no token.
    expect(last.truncated).toBe(false)
    expect(Object.hasOwn(last, 'messagesResumeCursor')).toBe(false)
  })

  it('② a mid-window byte stop emits `after:<lastReturnedId>`, and the anchor scans from the newest end', async () => {
    // The ANCHOR IS NOT ON THE FIRST PAGE. The fixture is 7 fat messages and
    // the peer pages 3 at a time, so the anchor (`n-4`) sits in the SECOND
    // page (n-3..n-5): a scan that did not DISCARD a page whole would collect
    // n-0..n-2 — history NEWER than the anchor — and hand it back as "older".
    //
    // 60 KiB of text per message is also the size that matters. Above the
    // peer's 4,096-character INLINE_TEXT_LIMIT the text travels as a
    // `{ref}`, so what the 256 KiB budget actually counts is the RESULT's
    // JSON: roughly 4 KiB per externalized part. Six messages fit; seven do
    // not.
    const messages = Array.from({ length: 7 }, (_unused, index) => fat(`n-${index}`, 60))
    const rig = await makeRig({
      hello: { limits: { pageItems: 3 } },
      agent: { agents: [AGENT], sessions: [SESSION], messages },
    })

    // The first read collects all 7 (three pages), then the byte budget trips
    // on the SEVENTH: n-5 and n-6 were COLLECTED and are trimmed, so the stop
    // is INSIDE the window. The peer's page position would sit past all seven
    // and skip them, and `AgentMessage` carries no `createdAt`, so no peer
    // cursor can be synthesised for that boundary either — the only honest
    // stop point is the last message actually returned.
    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 1000 })) as ReadResult
    expect(first.truncated).toBe(true)
    expect(first.truncationReason).toBe('aggregate-bytes')
    expect(ids(first)).toEqual(['n-0', 'n-1', 'n-2', 'n-3', 'n-4'])
    expect(first.messagesResumeCursor).toBe('after:n-4')

    const before = rig.fake.readCallsFor('agent.messages.list').length
    const resumed = (await rig.call('cherry_read', {
      device: 'dev-A',
      sessionId: 's-1',
      limit: 1000,
      messagesResumeCursor: first.messagesResumeCursor,
    })) as ReadResult
    const resumeCalls = rig.fake.readCallsFor('agent.messages.list').slice(before)
    // An ANCHOR walk starts cursorless: the anchor id is ours, not the peer's,
    // and nothing in the protocol can ask the peer "start after message X". A
    // cursor here would mean the token's anchor form was collapsed into the
    // page-position form.
    expect(Object.hasOwn(resumeCalls[0] ?? {}, 'cursor')).toBe(false)
    // Exactly the messages AFTER the anchor, in order, the anchor not repeated
    // — and the page WITHOUT the anchor discarded whole. Two discarded
    // consecutive pages would have tripped the empty-page run if the raw page
    // had been judged by what the scan KEPT: a non-empty page nobody wanted is
    // still a non-empty page the peer served, and it must read as progress.
    expect(ids(resumed)).toEqual(['n-5', 'n-6'])
    expect(ids(resumed)).not.toContain('n-4')
    // The resume read the whole remaining history: nothing older is unread.
    expect(resumed.truncated).toBe(false)
    expect(Object.hasOwn(resumed, 'messagesResumeCursor')).toBe(false)
  })

  it('②b a scan that cannot meet its anchor within its page bound FAILS LOUDLY instead of hanging', async () => {
    // A peer whose first page offers no anchor and whose pagination is a long
    // chain of ids: every guard that matters (advance, cycle, empty-page run,
    // the 10,000-page backstop) is satisfied, so ONLY the scan's own bound can
    // end it — thousands of legal pages a caller should never be made to wait
    // through. 300 pages is what the bound's derivation calls slack; the bound
    // itself is what is pinned, so this fixture stays small.
    const rig = await makeRig({
      hello: { limits: { pageItems: 2 } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: [fat('s-0', 1)] },
    })
    rig.fake.scriptListPages(
      'agent.messages.list',
      Array.from({ length: 600 }, (_unused, index) => ({
        items: [
          { messageId: `x-${index}-0`, revision: '1', role: 'user', status: 'success', parts: [] },
          { messageId: `x-${index}-1`, revision: '1', role: 'user', status: 'success', parts: [] },
        ],
        nextCursor: `p${index + 1}`,
      })),
    )

    await expect(
      rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', messagesResumeCursor: 'after:never-there' }),
    ).rejects.toThrow(/never-there/)
    // Bounded, not spun: the scan stopped at its own page bound rather than
    // walking every page the peer was willing to serve.
    expect(rig.fake.readCallsFor('agent.messages.list').length).toBe(500)
  })

  it('③ an anchor the walk never finds fails LOUD rather than returning an empty page', async () => {
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: history(10) },
    })

    // The peer's LAST page is reached with the anchor still unfound. A silent
    // empty result here would read as "no older history" — the exact opposite
    // of what happened.
    await expect(
      rig.call('cherry_read', {
        device: 'dev-A',
        sessionId: 's-1',
        messagesResumeCursor: 'after:m-gone-forever',
      }),
    ).rejects.toThrow(/m-gone-forever/)
    // It walked and then refused; it did not answer with an empty snapshot.
    expect(rig.fake.readCallsFor('agent.messages.list').length).toBeGreaterThan(0)
  })

  it('④a the token is judged BEFORE any device work — an OFFLINE device with a bad token never dials', async () => {
    // The parse sits at the TOP of `cherry_read`'s body, ahead of the device
    // selector: a bad argument is refused for what it IS, not reported as a
    // device verdict, and a refusal never wakes a device. With the device not
    // connected, a walk that reached `#linkOr` would answer `offline` and never
    // dial (⑥b in `toolsRead.test.ts`) — and one that reached the RPCs would
    // have to dial. Neither may happen.
    const rig = await makeRig(
      { agent: { agents: [AGENT], sessions: [SESSION], messages: history(10) } },
      false,
    )

    await expect(
      rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', messagesResumeCursor: '20' }),
    ).rejects.toThrow(/messagesResumeCursor/)
    expect(rig.fake.socketCount).toBe(0)
    expect(rig.fake.readCallsFor('agent.messages.list')).toEqual([])
  })

  it('④ a foreign token is refused LOCALLY — no device is dialled and no history is listed', async () => {
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: history(10) },
    })

    // `'20'` is the RAW page position the old face emitted, `'garbage'` is what
    // a caller invents, and `'after:'` / `'cursor:'` are the prefixes with an
    // empty remainder. The real desktop SILENTLY falls back to the newest page
    // for a malformed cursor, so forwarding any of these would present the
    // newest page again as "continued history". Each must die HERE.
    for (const token of ['20', 'garbage', '', 'after:', 'cursor:']) {
      await expect(
        rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', messagesResumeCursor: token }),
      ).rejects.toThrow(/messagesResumeCursor/)
    }
    // The refusal is ACTIONABLE: it names both accepted forms.
    await expect(
      rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', messagesResumeCursor: '20' }),
    ).rejects.toThrow(/"cursor:<peer position>" or "after:<messageId>"/)
    // Not one history request reached the peer — the argument was judged
    // before any device work, so a bad token costs no dial and no page.
    expect(rig.fake.readCallsFor('agent.messages.list')).toEqual([])
  })

  it('⑤ `limit` still bounds a resumed read, and the returned token chains onward', async () => {
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: history(47) },
    })

    const resumed = (await rig.call('cherry_read', {
      device: 'dev-A',
      sessionId: 's-1',
      limit: 5,
      messagesResumeCursor: 'cursor:20',
    })) as ReadResult
    // FROM the resume point, not around it: `limit` is the ceiling on how many
    // messages ONE answer carries.
    expect(resumed.messages).toHaveLength(5)
    expect(ids(resumed)).toEqual(['m-20', 'm-21', 'm-22', 'm-23', 'm-24'])
    expect(resumed.truncated).toBe(true)
    expect(resumed.truncationReason).toBe('limit')
    // The peer's position for the second page of a 5-message walk from 20.
    expect(resumed.messagesResumeCursor).toBe('cursor:25')

    const next = (await rig.call('cherry_read', {
      device: 'dev-A',
      sessionId: 's-1',
      limit: 5,
      messagesResumeCursor: resumed.messagesResumeCursor,
    })) as ReadResult
    expect(ids(next)).toEqual(['m-25', 'm-26', 'm-27', 'm-28', 'm-29'])
  })

  it('⑥ the terminal face emits the SAME anchor form, and `cherry_read` accepts it', async () => {
    // `cherry_wait`'s idle snapshot rides `#readTerminalMessages`: the fat
    // message is first, 20 more sit behind it, and its window collects them
    // all before the byte budget trims the tail. Before this issue that stop
    // emitted NO stop point (the peer cursor would have skipped the trimmed
    // messages); now it emits the anchor, which `cherry_read` accepts.
    const messages = [fat('w-0', 260)].concat(
      Array.from({ length: 20 }, (_unused, index) => fat(`w-${index + 1}`, 1)),
    )
    const rig = await makeRig({
      hello: { limits: { pageItems: 100 } },
      agent: { agents: [AGENT], sessions: [SESSION], messages },
    })

    const idle = (await rig.call('cherry_wait', { device: 'dev-A', sessionId: 's-1' })) as {
      status: string
      messages: Array<{ messageId: string }>
      messagesTruncated?: boolean
      messagesTruncationReason?: string
      messagesResumeCursor?: string
    }
    expect(idle.status).toBe('idle')
    expect(idle.messagesTruncated).toBe(true)
    expect(idle.messagesTruncationReason).toBe('aggregate-bytes')
    expect(ids(idle)).toEqual(['w-0'])
    expect(idle.messagesResumeCursor).toBe('after:w-0')

    // THE ROUND TRIP ACROSS FACES: the terminal token is a `cherry_read` input.
    const resumed = (await rig.call('cherry_read', {
      device: 'dev-A',
      sessionId: 's-1',
      limit: 1000,
      messagesResumeCursor: idle.messagesResumeCursor,
    })) as ReadResult
    expect(ids(resumed)).toEqual(messages.slice(1).map((message) => message.messageId))
    expect(ids(resumed)).not.toContain('w-0')
  })

  it('⑦ a REVISION_EXPIRED retry keeps the resume point instead of silently re-reading the newest page', async () => {
    // The §6 rule retries a WHOLE round once when the baseline revision moved,
    // and it re-pulls `sessions.get` because the history changed UNDER the walk.
    // The caller asked for the history AFTER a position, not for one particular
    // attempt at it, so the resume has to travel with the retry.
    //
    // Dropping it here would not fail loudly: the retry would start at the
    // newest message and hand back m-0..m-19 as though they were the
    // continuation — the same silent-wrong-answer class the token prefixes
    // exist to prevent, arriving through the one path a caller cannot see.
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: history(47) },
    })

    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 20 })) as ReadResult
    expect(first.messagesResumeCursor).toBe('cursor:20')

    // The FIRST request of the resumed round expires. The retry must re-send
    // the same peer position, not fall back to the newest page.
    rig.fake.setReadFailure('agent.messages.list', {
      reason: 'REVISION_EXPIRED',
      message: 'History revision expired',
    })
    const before = rig.fake.readCallsFor('agent.messages.list').length
    const resumed = (await rig.call('cherry_read', {
      device: 'dev-A',
      sessionId: 's-1',
      limit: 20,
      messagesResumeCursor: first.messagesResumeCursor,
    })) as ReadResult

    // BOTH attempts of the resumed round carried the peer position: the one
    // that expired and the retry that replaced it. A dropped resume shows up
    // as `undefined` on the second entry. (The third call is the retried
    // round's SECOND page — `limit: 20` still spans two 16-wide pages.)
    const resumeCalls = rig.fake.readCallsFor('agent.messages.list').slice(before)
    expect(resumeCalls.slice(0, 2).map((call) => call['cursor'])).toEqual(['20', '20'])
    // And the answer is the continuation, not the newest page again.
    expect(ids(resumed)).toEqual(history(47).slice(20, 40).map((message) => message.messageId))
    expect(ids(resumed)).not.toContain('m-0')
  })
})
