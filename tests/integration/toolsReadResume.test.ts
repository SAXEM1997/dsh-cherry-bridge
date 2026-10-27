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
    schemaVersion: 4,
    deviceId: 'dev-A',
    displayName: 'Desk Alpha',
    hosts: [host],
    security: { [host]: 'ws' as const },
    ports: { [host]: port },
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

/** The wire shape `agent.messages.list` serves for `m-<index>`; scripted pages carry it verbatim. */
function wire(index: number): Record<string, unknown> {
  return {
    messageId: `m-${index}`,
    revision: `100${index}`,
    role: 'user',
    partIds: [`m-${index}:0`],
    status: 'success',
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
    // — and the page WITHOUT the anchor discarded whole. (One page is discarded
    // here; the raw-page-counting rule it exercises is pinned by ②b's 500
    // pages, where judging the page by what the scan KEPT would trip the
    // three-empty-page run almost immediately.)
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
    // a caller invents, `'after:'` / `'cursor:'` are the prefixes with an empty
    // remainder, and the last three are tokens that carry OUR prefix but a
    // remainder no emission can produce (a stray leading space, a trailing
    // space, and a newline). The real desktop SILENTLY falls back
    // to the newest page for a malformed cursor, so forwarding any of these
    // would present the newest page again as "continued history" — and the
    // `after:` variants would instead report a phantom message id as "probably
    // gone". Each must die HERE.
    //
    // NOT in this list: `'cursor:after:x'`, a token glued together by hand. Its
    // remainder is a syntactically plausible peer position, and refusing it would
    // mean PARSING the peer's cursor format — which this bridge deliberately does
    // not do (a desktop keyset token, a loopback offset and a future format are
    // all valid). A nested prefix is also something we could genuinely emit, so
    // refusing it would break the round trip it exists to guarantee.
    //
    // A token from the OTHER face is a different matter, and the difference is
    // exact: that is a check on the WHOLE token's prefix (`list:`, issue #72 in
    // `⑪` below), never an interpretation of what follows it. The two are
    // disjoint "cursor:"+"list:" — a peer position starting with `list:` still
    // travels, which `⑪` also pins.
    for (const token of ['20', 'garbage', '', 'after:', 'cursor:', 'cursor: 20', 'cursor:20 ', 'after:\n7']) {
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
  it('⑧ a peer that OVERSHOOTS the requested page cannot make the resume token skip the rest of it', async () => {
    // `limit` is a MAXIMUM on a list method, so a page carrying more items than
    // were asked for is a peer fault — and the loopback peer's scripted-pages
    // face serves one verbatim, which is how this shape is reachable at all.
    //
    // The dangerous half is the STOP POINT, not the extra items. The walk takes
    // what its ceiling allows and leaves the rest of that page uncollected, so
    // the page's own `nextCursor` sits PAST messages the result does not carry:
    // emitting it as `cursor:<pos>` would make the newly advertised resume skip
    // them, and a TERMINAL overshooting page would have been reported COMPLETE
    // while silently dropping its tail. The stop is therefore the anchor, and
    // the position the walk re-uses is the one it SENT (duplicates, never a gap).
    const rig = await makeRig({
      hello: { limits: { pageItems: 2 } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: [tiny(0), tiny(1), tiny(2)] },
    })
    rig.fake.scriptListPages('agent.messages.list', [
      { items: [wire(0), wire(1), wire(2)], nextCursor: 'over' },
    ])

    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 2 })) as ReadResult
    expect(ids(first)).toEqual(['m-0', 'm-1'])
    expect(first.truncated).toBe(true)
    expect(first.truncationReason).toBe('limit')
    // NOT `cursor:over` — that position is past `m-2`, which this result does
    // not carry.
    expect(first.messagesResumeCursor).toBe('after:m-1')

    // The resume proves nothing was skipped: `m-2` is the very next thing the
    // caller sees.
    const resumed = (await rig.call('cherry_read', {
      device: 'dev-A',
      sessionId: 's-1',
      limit: 10,
      messagesResumeCursor: first.messagesResumeCursor,
    })) as ReadResult
    expect(ids(resumed)).toEqual(['m-2'])
  })

  it('⑨ an anchor scan keeps the no-progress guards in force', async () => {
    // AGENTS.md: "Every existing guard stays in force during a scan". The
    // empty-page run and the scan's own page bound are pinned by ②b; these are
    // the two cursor guards, and without them a scan would spin on a peer whose
    // pagination is broken — spending the whole page budget to learn what one
    // Set lookup answers on the second visit.
    const stuck = await makeRig({
      hello: { limits: { pageItems: 2 } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: [tiny(0)] },
    })
    stuck.fake.scriptListPages('agent.messages.list', [
      { items: [wire(0)], nextCursor: 'p1' },
      { items: [wire(0)], nextCursor: 'p1' },
    ])
    await expect(
      stuck.call('cherry_read', { device: 'dev-A', sessionId: 's-1', messagesResumeCursor: 'after:never-there' }),
    ).rejects.toThrow(/did not advance/)

    const cycling = await makeRig({
      hello: { limits: { pageItems: 2 } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: [tiny(0)] },
    })
    cycling.fake.scriptListPages('agent.messages.list', [
      { items: [wire(0)], nextCursor: 'p1' },
      { items: [wire(0)], nextCursor: 'p2' },
      { items: [wire(0)], nextCursor: 'p1' },
    ])
    await expect(
      cycling.call('cherry_read', { device: 'dev-A', sessionId: 's-1', messagesResumeCursor: 'after:never-there' }),
    ).rejects.toThrow(/cycled back to cursor p1/)
  })

  it('⑩ an anchor scan pages at the PEER page size, not the caller\'s `limit`', async () => {
    // The documented "walk it in successive answers" pattern is a SMALL `limit`
    // per answer, and a scan that paged at the caller's limit would walk the
    // history one item at a time — spending MAX_ANCHOR_SCAN_PAGES on a history a
    // full page reaches in dozens, and failing with a diagnosis ("a session this
    // tool should not chase") that describes the wrong problem. The scan's items
    // are discarded either way, so the wider page costs nothing.
    const messages = Array.from({ length: 7 }, (_unused, index) => fat(`n-${index}`, 60))
    const rig = await makeRig({
      hello: { limits: { pageItems: 3 } },
      agent: { agents: [AGENT], sessions: [SESSION], messages },
    })

    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 1000 })) as ReadResult
    expect(first.messagesResumeCursor).toBe('after:n-4')

    const before = rig.fake.readCallsFor('agent.messages.list').length
    const resumed = (await rig.call('cherry_read', {
      device: 'dev-A',
      sessionId: 's-1',
      limit: 1,
      messagesResumeCursor: first.messagesResumeCursor,
    })) as ReadResult
    const resumeCalls = rig.fake.readCallsFor('agent.messages.list').slice(before)
    // The scan asks for a FULL page even though the answer may carry one item.
    expect(resumeCalls[0]?.['limit']).toBe(3)
    // Two calls: the discarded page, then the anchor page. Paging at `limit: 1`
    // would have needed five.
    expect(resumeCalls).toHaveLength(2)
    expect(ids(resumed)).toEqual(['n-5'])
  })
})

/**
 * Issue #72: the two resume-token faces are disjoint by PREFIX (`cursor:` /
 * `after:` here, `list:` on the four list tools). Before that split a list
 * token was a perfectly ordinary `cursor:` payload to this face, so it was
 * forwarded to the desktop verbatim — and the desktop answers an unparseable
 * position by falling back to its FIRST page, i.e. "continue from here" silently
 * re-read the newest page as older history.
 *
 * The second half of the test is the other half of the invariant: the refusal
 * is a check on the WHOLE token, never a scan for our marker inside the peer's
 * position. A position that happens to start with `list:` is still the peer's
 * business and must travel verbatim — this bridge does not parse peer cursors.
 */
describe('issue #72: a LIST resume token is not a message cursor', () => {
  it('⑪ a minted list token is refused, while a position that looks like one still travels', async () => {
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: {
        agents: [AGENT],
        sessions: [SESSION, { ...SESSION, sessionId: 's-2' }, { ...SESSION, sessionId: 's-3' }],
        messages: history(40),
      },
    })

    // Minted by the list face itself, so the two faces cannot drift apart.
    const listToken = (
      (await rig.call('cherry_sessions', { device: 'dev-A', agentId: 'agent-1', limit: 2 })) as {
        resumeCursor?: string
      }
    ).resumeCursor as string
    expect(listToken).toMatch(/^list:v2:s:/)

    const before = rig.fake.readCallsFor('agent.messages.list').length
    await expect(
      rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', messagesResumeCursor: listToken }),
    ).rejects.toThrow(/a LIST `resumeCursor`/i)
    // Refused before any history work: the argument never became a peer cursor.
    expect(rig.fake.readCallsFor('agent.messages.list')).toHaveLength(before)

    // The v1 LIST token — the format 0.1.6 actually SHIPPED — lives under
    // `cursor:` and its payload is colon-free base64url, so it arrives here as a
    // perfectly ordinary position. It must be named and refused, not forwarded:
    // the desktop answers an unparseable position by serving its FIRST page.
    const v1 = `cursor:${Buffer.from(
      JSON.stringify({ v: 1, m: 'agent.sessions.list', d: 'dev-A', h: '0'.repeat(16), p: '2' }),
      'utf8',
    ).toString('base64url')}`
    await expect(
      rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', messagesResumeCursor: v1 }),
    ).rejects.toThrow(/v1 LIST `resumeCursor`/)
    expect(rig.fake.readCallsFor('agent.messages.list')).toHaveLength(before)

    // The peer position is opaque. A token whose POSITION begins with `list:`
    // is still a message cursor, and the peer's own verdict is what surfaces —
    // the fake peer parses positions numerically and rejects this one.
    await expect(
      rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', messagesResumeCursor: 'cursor:list:20' }),
    ).rejects.toThrow(/Invalid page cursor/)
    expect(rig.fake.readCallsFor('agent.messages.list')).toHaveLength(before + 1)
  })
})

/**
 * Issue #74: the message-face token is CALLER INPUT, so it gets the same kind of
 * ceiling the list face has. Before this, a 5,000-character `cursor:…` was
 * accepted and forwarded to the desktop, which answers a position it cannot
 * parse by serving its FIRST page — the silent "newest page as older history"
 * class, reached this time by a garbled string rather than a foreign token.
 */
describe('issue #74: the message token has a length ceiling', () => {
  it('⑫ a token over the ceiling is refused locally in BOTH forms — no dial, no page', async () => {
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: history(10) },
    })
    const before = rig.fake.readCallsFor('agent.messages.list').length
    for (const token of [`cursor:${'9'.repeat(5000)}`, `after:${'9'.repeat(5000)}`]) {
      await expect(
        rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', messagesResumeCursor: token }),
      ).rejects.toThrow(/4096/)
    }
    expect(rig.fake.readCallsFor('agent.messages.list')).toHaveLength(before)
  })

  it('⑬ the ceiling is judged on the WHOLE token, before the form it looks like', async () => {
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: history(10) },
    })
    const messageOf = (token: string): Promise<string> =>
      rig
        .call('cherry_read', { device: 'dev-A', sessionId: 's-1', messagesResumeCursor: token })
        .then(
          () => '(resolved)',
          (error: unknown) => (error as Error).message,
        )

    // EXACTLY at the ceiling: accepted STRUCTURALLY — our refusal is absent, so
    // the position was forwarded and the PEER's verdict is what came back (the
    // fake peer's own schema rejects a 4 KiB cursor before it pages). This pins
    // the off-by-one: `>` must never become `>=`.
    const atCeiling = `cursor:${'9'.repeat(4096 - 'cursor:'.length)}`
    expect(atCeiling).toHaveLength(4096)
    const accepted = await messageOf(atCeiling)
    expect(accepted).not.toMatch(/4096|ceiling/)

    // OVER the ceiling with the OTHER face's prefix: the length verdict wins, so
    // the two mistakes are never reported as each other.
    const overLimit = await messageOf(`list:v2:s:${'9'.repeat(5000)}`)
    expect(overLimit).toMatch(/4096/)
    expect(overLimit).not.toMatch(/a LIST `resumeCursor`/)
  })
})

/**
 * Issue #76: the ceiling is enforced on the way OUT, not only on the way in.
 *
 * #74 bounded the token a message walk ACCEPTS; the emit side had no such guard.
 * A peer that answers a truncated page with a position longer than the head
 * allowance would make `messageResumeToken` mint a token of its own over the
 * ceiling — a token `parseMessageResume` refuses on replay, so the walk handed
 * the caller a stop point that can never be used. The remedy for the shape is
 * the existing one: no token at all, `truncated` still saying the walk was cut.
 */
describe('issue #76: the emit side never names a token the parser would refuse', () => {
  it('⑭a an over-long `cursor:` position is not named, and the content is still returned', async () => {
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: [tiny(0), tiny(1)] },
    })
    rig.fake.scriptListPages('agent.messages.list', [
      { items: [wire(0), wire(1)], nextCursor: '9'.repeat(5000) },
    ])

    const page = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 2 })) as ReadResult
    // The walk did not throw and did not drop what it read: a stop point that
    // cannot be named is not a reason to lose the content before it.
    expect(ids(page)).toEqual(['m-0', 'm-1'])
    expect(page.truncated).toBe(true)
    expect(page.truncationReason).toBe('limit')
    expect(page.messagesResumeCursor).toBeUndefined()
  })

  it('⑭b a position EXACTLY at the ceiling is still named, and the parser takes it back', async () => {
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: [tiny(0), tiny(1)] },
    })
    const atCeiling = '9'.repeat(4096 - 'cursor:'.length)
    rig.fake.scriptListPages('agent.messages.list', [
      { items: [wire(0), wire(1)], nextCursor: atCeiling },
    ])

    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 2 })) as ReadResult
    expect(first.truncated).toBe(true)
    expect(first.messagesResumeCursor).toBeDefined()
    // Arrivals, not `readCallsFor`: the fake records the call BEFORE it judges
    // the params, which is exactly what a peer-schema refusal must leave behind.
    const arrivalsBefore = rig.fake.methodCount('agent.messages.list')
    // The off-by-one: exactly 4,096 is a token the parser accepts, so it must be
    // emitted. `<=` in the guard, never `<`.
    expect(first.messagesResumeCursor).toHaveLength(4096)

    // The round trip is judged at THIS face's boundary: the minted token must
    // survive `parseMessageResume` (no length refusal, no "must be a token this
    // tool emitted") and leave with the position on it. Where it then stops is
    // the PEER's own schema — `pageParams.cursor` is an `opaqueId` of at most
    // 256 characters — so the expected verdict is the peer rejecting the params,
    // which is only reachable if this face let the token through.
    const replay = await rig
      .call('cherry_read', {
        device: 'dev-A',
        sessionId: 's-1',
        limit: 2,
        messagesResumeCursor: first.messagesResumeCursor,
      })
      .then(
        (page) => page as ReadResult,
        (error: unknown) => error as Error,
      )
    expect(replay).toBeInstanceOf(Error)
    expect((replay as Error).message).toMatch(/malformed params for agent\.messages\.list/)
    expect(rig.fake.methodCount('agent.messages.list')).toBeGreaterThan(arrivalsBefore)
  })

  // The `after:` arm of the same guard has no integration fixture, and cannot
  // have one: an anchor is a message ID, and projecting that message sends it to
  // `agent.parts.list`, whose `messageId` is an `opaqueId` (256 characters). A
  // peer item with an id above the token ceiling therefore fails its parts walk
  // and is never RETURNED — a peer would have to violate its own schema to
  // produce the state. That arm is pinned by `tests/unit/resumeTokenEmit.test.ts`
  // instead, which drives `messageResumeToken` directly.
})

/**
 * Issue #80: the CONTENT dimension of the same round-trip symmetry #76 bounded
 * by LENGTH.
 *
 * `messageResumeToken` used to filter a peer answer through `optionalString`,
 * which rejects `''` and nothing else, while the parsers that read a token back
 * reject any remainder `mangledRemainder` calls mangled — leading/trailing
 * whitespace, or a control character anywhere. A peer page whose `nextCursor`
 * was `' 4 '` therefore minted `cursor: 4 `, and the next `cherry_read` refused
 * the tool's own token. This is not a theoretical shape: `pageParams.cursor`
 * (and `agent.parts.list`'s `messageId`) is an `opaqueId` — `unicodeText`
 * bounded at 256 characters, and `unicodeText` only forbids lone surrogates —
 * so a padded position and a padded message id are both SCHEMA-VALID, and both
 * arms are reachable through a real tool.
 *
 * The fix is that the emitter runs the parser's own predicate, so the two sides
 * cannot disagree by construction. What must NOT change: the content already
 * read is returned, `truncated` still says the walk was cut, and a CLEAN
 * position/anchor on the same shapes is still named — this is a refusal of
 * mangled remainders, not a blanket refusal to emit.
 */
describe('issue #80: the emit side applies the parser’s content predicate to BOTH arms', () => {
  it('⑭d a padded `cursor:` position mints no token, and the content is still returned', async () => {
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: [tiny(0), tiny(1)] },
    })
    // The walk consumed its whole collected window, so the peer's position is
    // the stop point — and that position carries padding `nextCursor` is
    // schema-legal in (`opaqueId`).
    rig.fake.scriptListPages('agent.messages.list', [
      { items: [wire(0), wire(1)], nextCursor: ' 4 ' },
    ])

    const page = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 2 })) as ReadResult
    // The stop point is not a reason to lose what was read before it.
    expect(ids(page)).toEqual(['m-0', 'm-1'])
    expect(page.truncated).toBe(true)
    expect(page.truncationReason).toBe('limit')
    // The regression: this used to be `cursor: 4 `, which
    // `parseMessageResume` refuses on the way back.
    expect(page.messagesResumeCursor).toBeUndefined()
  })

  it('⑭e a padded `after:` anchor mints no token either', async () => {
    // The anchor arm is reachable through the protocol because the anchor is a
    // message ID, and `agent.parts.list`'s `messageId` is the same `opaqueId`
    // that accepts padding — so the parts walk for `' m-0 '` SUCCEEDS, the
    // message is returned, and it can become the anchor.
    const padded = (index: number): FakeMessageRecord => ({ ...tiny(index), messageId: ` m-${index} ` })
    const paddedWire = (index: number): Record<string, unknown> => ({ ...wire(index), messageId: ` m-${index} ` })
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: [padded(0), padded(1)] },
    })
    // A peer that OVERSHOTS the requested page: `limit: 1` asks for one item and
    // the page carries two, so the walk stops INSIDE its collected window and
    // would name `after: m-0 ` as the anchor.
    rig.fake.scriptListPages('agent.messages.list', [
      { items: [paddedWire(0), paddedWire(1)], nextCursor: null },
    ])

    const page = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 1 })) as ReadResult
    // The padded id really did survive projection — this is the reachable
    // shape, not a hypothetical one.
    expect(page.messages[0]?.messageId).toBe(' m-0 ')
    expect(page.truncated).toBe(true)
    expect(page.messagesResumeCursor).toBeUndefined()
  })

  it('⑭f a CLEAN cursor position is still named — the guard rejects padding, nothing else', async () => {
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: [tiny(0), tiny(1)] },
    })
    rig.fake.scriptListPages('agent.messages.list', [{ items: [wire(0)], nextCursor: '2' }])

    const page = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 1 })) as ReadResult
    expect(ids(page)).toEqual(['m-0'])
    expect(page.truncated).toBe(true)
    expect(page.truncationReason).toBe('limit')
    expect(page.messagesResumeCursor).toBe('cursor:2')
  })

  it('⑭f a CLEAN anchor on the same shape is still named — clean ids round-trip unchanged', async () => {
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: [tiny(0), tiny(1)] },
    })
    // The SAME overshooting page as ⑭e, with clean ids: the stop is still inside
    // the window, so the anchor must still be named. If this went undefined the
    // guard would be refusing the SHAPE rather than the padding.
    rig.fake.scriptListPages('agent.messages.list', [
      { items: [wire(0), wire(1)], nextCursor: null },
    ])

    const page = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 1 })) as ReadResult
    expect(ids(page)).toEqual(['m-0'])
    expect(page.truncated).toBe(true)
    expect(page.messagesResumeCursor).toBe('after:m-0')
  })
})

/**
 * Issue #85: the message face must not name a position that its own parser
 * refuses as a RETIRED v1 list token.
 *
 * `parseMessageResume`'s `cursor:` branch runs `mangledRemainder` and then
 * `looksLikeV1ListToken`, and only the first was mirrored. A peer answering with
 * the v1 payload shape therefore got a `messagesResumeCursor` back that the next
 * `cherry_read` refused — with the diagnosis "issued by an older plugin version",
 * about a token this tool had printed a moment earlier.
 *
 * The position here is schema-legal for the peer (`opaqueId` is 1–256 characters
 * of Unicode text): 102 characters, colon-free base64url.
 */
describe('issue #85: a v1-shaped peer position is not named', () => {
  const v1Shaped = Buffer.from(
    JSON.stringify({ v: 1, m: 'agent.sessions.list', d: 'dev-A', h: '0'.repeat(16), p: '2' }),
    'utf8',
  ).toString('base64url')

  it('⑭g a `cursor:` position in the retired format mints no token, and the content survives', async () => {
    const rig = await makeRig({
      hello: { limits: { pageItems: LIST_PAGE_CLAMP } },
      agent: { agents: [AGENT], sessions: [SESSION], messages: [tiny(0), tiny(1)] },
    })
    rig.fake.scriptListPages('agent.messages.list', [{ items: [wire(0), wire(1)], nextCursor: v1Shaped }])

    const page = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 2 })) as ReadResult
    expect(ids(page)).toEqual(['m-0', 'm-1'])
    expect(page.truncated).toBe(true)
    expect(page.truncationReason).toBe('limit')
    expect(page.messagesResumeCursor).toBeUndefined()
  })
})
