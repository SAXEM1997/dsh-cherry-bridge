import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { registerCherryTools } from '../../src/tools.js'
import type { CherryToolDefinition, CherryToolsContext, CherryToolsDeps } from '../../src/tools.js'
import { LIST_PAGE_CLAMP } from '../../src/defaults.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions, FakeMessageRecord, FakeSessionRecord } from '../loopback/fakeCherry.js'

/**
 * Issue #11 regression suite: a list walk must accept the upstream desktop's
 * LEGAL empty transition page.
 *
 * `agent.sessions.list` is not a count-only pager upstream: it walks a PINNED
 * section first and then the entity section. When a pin anchor is unpinned or
 * deleted between two page requests, the pin section answers with ZERO rows and
 * a section-start cursor — `{items: [], nextCursor: 'entity:'}`. The sessions
 * side is evidenced by the source itself (`AgentSessionService.listByCursor`,
 * v2.1.6 lines 739-744 in the vendored checkout under `_research/cherry-studio/`,
 * where `encodeEntitySectionStart()` returns the literal `'entity:'`); the same
 * transition is pinned by upstream's own test on the topic rail
 * (`TopicService.test.ts`, "Cursor points at a pin tuple for a row that no
 * longer exists"), and CherryHQ/cherry-studio#21854's suite exercises it for
 * sessions. `#aggregate` used to treat EVERY
 * empty page with a non-null cursor as a peer fault, so `cherry_sessions` failed
 * whenever a pinned session disappeared mid-walk.
 *
 * The walk here is always the real one (LIST_PAGE_CLAMP items per page against
 * a real loopback Noise-XX peer); only the page CONTENT is scripted, through
 * the fake's `scriptListPages` queue.
 */

/** `count` sessions, all in one agent/workspace, with stable ids. */
function sessions(count: number, prefix = 's'): FakeSessionRecord[] {
  return Array.from({ length: count }, (_unused, index) => ({
    sessionId: `${prefix}-${String(index).padStart(2, '0')}`,
    agentId: 'agent-1',
    workspaceId: 'ws-1',
    title: `Session ${index}`,
    historyRevision: '1',
  }))
}

/** The wire summary of one fixture session, as the peer's `#sessionSummary` serves it. */
function summaryOf(session: FakeSessionRecord): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    workspaceId: session.workspaceId,
    workspaceKind: 'registered',
    title: session.title,
    updatedAt: new Date(0).toISOString(),
    historyRevision: session.historyRevision,
    idleRevision: session.historyRevision,
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

async function makeRig(options: FakeCherryOptions = {}): Promise<Rig> {
  // A loopback walk issues three pages in a few milliseconds; the fake's own
  // per-second cap would otherwise close the session mid-walk. The pacing
  // under test is #aggregate's, not the transport's.
  const fake = new FakeCherry({ rateLimitPerSecond: 100_000, ...options })
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-tools-listwalk-'))
  const store = new DeviceStore(join(tmp, 'devices.json'))

  const record = {
    schemaVersion: 3,
    deviceId: 'dev-A',
    displayName: 'Desk Alpha',
    hosts: [host],
    security: { [host]: 'ws' as const },
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
      // Same reason as above on the client half: a many-page fixture should not
      // spend its run waiting out the production pacing window.
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
      throw new Error('pairing is not exercised by the list-walk suite')
    },
    evict: () => {
      throw new Error('the list-walk suite never evicts')
    },
  }
  registerCherryTools(ctx, deps, {})
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

/** The rejection of one tool call, or undefined when it resolved. */
async function rejectionOf(call: Promise<unknown>): Promise<Error | undefined> {
  return call.then(
    () => undefined,
    (thrown: unknown) => thrown as Error,
  )
}

/**
 * The wire summary of one fixture session, as the peer serves it.
 *
 * LIST_PAGE_CLAMP sessions per page, so a 20-session fixture is exactly the
 * multi-page walk that exposes a mid-walk page. Each scenario's plan is
 * POSITIONAL: call 1 is page 1, call 2 page 2, and so on — the same order a
 * count-only peer would answer in.
 */
function pageOf(sessions: FakeSessionRecord[], from: number, to: number, next: string | null): Record<string, unknown> {
  return { items: sessions.slice(from, to).map(summaryOf), nextCursor: next }
}

describe('issue #11 T1: the legal empty pin→entity transition page', () => {
  it('T1 walks through {items: [], nextCursor: "entity:"} to the remaining sessions', async () => {
    // The fixture is 20 sessions, so page 1 clamps to LIST_PAGE_CLAMP = 16
    // with a numeric cursor; the pin→entity transition is answered by call 2,
    // exactly where the desktop answers it when a pin anchor vanished between
    // requests. Call 3 is the entity section from its start.
    const fixture = sessions(20)
    const rig = await makeRig({ agent: { sessions: fixture } })
    rig.fake.scriptListPages('agent.sessions.list', [
      pageOf(fixture, 0, LIST_PAGE_CLAMP, String(LIST_PAGE_CLAMP)),
      { items: [], nextCursor: 'entity:' },
      pageOf(fixture, LIST_PAGE_CLAMP, fixture.length, null),
    ])

    const result = (await rig.call('cherry_sessions', { device: 'dev-A' })) as {
      items: Array<{ sessionId: string }>
      truncated?: boolean
    }

    // The transition page moved the cursor but lost nothing.
    expect(result.items.map((session) => session.sessionId)).toEqual(fixture.map((session) => session.sessionId))
    expect(result.items).toHaveLength(20)
    expect(result.truncated).toBe(false)
    // The walk really crossed the transition page (3 calls, not 2).
    expect(rig.fake.readCallsFor('agent.sessions.list')).toHaveLength(3)
  })
})

describe('issue #11 T2: a short mid-walk page (upstream byte budget)', () => {
  it('T2 completes the walk when a page returns fewer items than requested with a cursor', async () => {
    // #21854's byte budget replaces the count-only page on upstream main, so a
    // page may legally come back SHORT while promising more. The walk must
    // follow the cursor rather than infer "done" from a short page.
    const fixture = sessions(20)
    const rig = await makeRig({ agent: { sessions: fixture } })
    rig.fake.scriptListPages('agent.sessions.list', [
      pageOf(fixture, 0, LIST_PAGE_CLAMP, String(LIST_PAGE_CLAMP)),
      // Asked for with limit 16, answers with 3 and a cursor.
      pageOf(fixture, LIST_PAGE_CLAMP, LIST_PAGE_CLAMP + 3, String(LIST_PAGE_CLAMP + 3)),
      pageOf(fixture, LIST_PAGE_CLAMP + 3, fixture.length, null),
    ])

    const result = (await rig.call('cherry_sessions', { device: 'dev-A' })) as {
      items: Array<{ sessionId: string }>
      truncated?: boolean
    }

    expect(result.items.map((session) => session.sessionId)).toEqual(fixture.map((session) => session.sessionId))
    expect(result.items).toHaveLength(20)
    expect(result.truncated).toBe(false)
    expect(rig.fake.readCallsFor('agent.sessions.list')).toHaveLength(3)
  })
})

describe('issue #11 T3: RESOURCE_EXHAUSTED is an error, never a connection kill', () => {
  it('T3 rejects with the reason visible and the NEXT call on the same connection succeeds', async () => {
    // Upstream's byte-budgeted pager answers an un-pageable record with
    // RESOURCE_EXHAUSTED instead of letting the transport kill the session.
    // The client half of that contract: the failure surfaces to the caller and
    // leaves the device usable.
    const fixture = sessions(5)
    const rig = await makeRig({
      agent: {
        sessions: fixture,
        failNext: {
          'agent.sessions.list': { reason: 'RESOURCE_EXHAUSTED', message: 'Page item exceeds response byte budget' },
        },
      },
    })

    const error = await rejectionOf(rig.call('cherry_sessions', { device: 'dev-A' }))
    expect(error).toBeInstanceOf(Error)
    const shaped = error as Error & { data?: { reason?: string; message?: string } }
    const rendered = `${shaped.message} ${JSON.stringify(shaped.data ?? {})}`
    expect(rendered).toContain('RESOURCE_EXHAUSTED')
    expect(rendered).toContain('Page item exceeds response byte budget')

    // The connection survived: the same tool on the same device answers.
    const retried = (await rig.call('cherry_sessions', { device: 'dev-A' })) as {
      items: Array<{ sessionId: string }>
    }
    expect(retried.items).toHaveLength(5)
    // One socket only — nothing re-dialed behind the caller's back.
    expect(rig.fake.socketCount).toBe(1)
  })
})

describe('issue #11 T4: a stuck empty page is still a fault', () => {
  it('T4 rejects when the peer echoes the cursor it was sent with an empty page', async () => {
    // The tolerance for empty pages must not blunt the stuck-cursor guard: a
    // page that answers the SENT cursor with nothing is zero progress.
    const fixture = sessions(20)
    const rig = await makeRig({ agent: { sessions: fixture } })
    rig.fake.scriptListPages('agent.sessions.list', [
      pageOf(fixture, 0, LIST_PAGE_CLAMP, String(LIST_PAGE_CLAMP)),
      // Every later page echoes the cursor it was SENT, with no items.
      (params) => ({ items: [], nextCursor: String(params['cursor']) }),
    ])

    const error = await rejectionOf(rig.call('cherry_sessions', { device: 'dev-A' }))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('did not advance its cursor')
  })
})

describe('issue #11 T5: the consecutive-empty tolerance is finite', () => {
  it('T5 rejects after three consecutive empty pages, naming the count', async () => {
    // The pin→entity transition happens at most once per walk upstream; a peer
    // that keeps answering empty pages with an ADVANCING cursor, though, is
    // the no-progress fault the old check existed for. Three is the bound.
    const rig = await makeRig({ agent: { sessions: sessions(20) } })
    rig.fake.scriptListPages('agent.sessions.list', [
      pageOf(sessions(20), 0, LIST_PAGE_CLAMP, 'empty-1'),
      { items: [], nextCursor: 'empty-2' },
      { items: [], nextCursor: 'empty-3' },
      { items: [], nextCursor: 'empty-4' },
      // Never reached: the third consecutive empty page already trips the bound.
      { items: [], nextCursor: 'empty-5' },
    ])

    const error = await rejectionOf(rig.call('cherry_sessions', { device: 'dev-A' }))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('3 consecutive empty page(s)')
    expect((error as Error).message).toContain('agent.sessions.list')
    // Page 1 plus three empty pages: the fifth scripted page was never asked for.
    expect(rig.fake.readCallsFor('agent.sessions.list')).toHaveLength(4)
  })
})

describe('issue #11 T6: only CONSECUTIVE empty pages count', () => {
  it('T6 completes a walk whose empty pages are separated by real ones', async () => {
    // The rule is a RUN, not a total. A peer that interleaves empty pages with
    // real ones still makes progress and must finish: a counter that ACCUMULATED
    // instead of resetting would refuse this walk on its third empty page. The
    // upstream pin→entity transition never repeats, so this is the shape that
    // distinguishes "resets on any non-empty page" from "counts for ever".
    const fixture = sessions(16)
    const rig = await makeRig({ agent: { sessions: fixture } })
    rig.fake.scriptListPages('agent.sessions.list', [
      pageOf(fixture, 0, 4, 'c-1'),
      { items: [], nextCursor: 'c-2' },
      pageOf(fixture, 4, 8, 'c-3'),
      { items: [], nextCursor: 'c-4' },
      pageOf(fixture, 8, 12, 'c-5'),
      { items: [], nextCursor: 'c-6' },
      pageOf(fixture, 12, 16, null),
    ])

    const result = (await rig.call('cherry_sessions', { device: 'dev-A' })) as {
      items: Array<{ sessionId: string }>
      truncated?: boolean
    }

    // Three empty pages in total, none of them consecutive.
    expect(result.items.map((session) => session.sessionId)).toEqual(fixture.map((session) => session.sessionId))
    expect(result.truncated).toBe(false)
    expect(rig.fake.readCallsFor('agent.sessions.list')).toHaveLength(7)
  })
})

describe('issue #11 T7: the shared walk accepts it on the MESSAGES face too', () => {
  it('T7 cherry_read crosses an empty transition page in agent.messages.list', async () => {
    // #aggregate is shared by every list face; the fix was reasoned on the
    // sessions rail because that is where the desktop emits the transition, but
    // the guard it replaced lived in the shared loop. This pins the messages
    // face of cherry_read, which walks agent.messages.list through the same code.
    const messages: FakeMessageRecord[] = Array.from({ length: 20 }, (_unused, index) => ({
      messageId: `m-${String(index).padStart(2, '0')}`,
      revision: '1',
      role: index % 2 === 0 ? 'user' : 'assistant',
      status: 'success',
      parts: [{ kind: 'text', text: `message ${index}` }],
    }))
    const rig = await makeRig({
      agent: {
        sessions: [{ sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Hello', historyRevision: '1' }],
        messages,
      },
    })
    const wire = messages.map((message) => ({
      messageId: message.messageId,
      revision: message.revision,
      role: message.role,
      status: message.status,
      partIds: message.parts.map((_part, index) => `${message.messageId}:${index}`),
    }))
    rig.fake.scriptListPages('agent.messages.list', [
      { items: wire.slice(0, LIST_PAGE_CLAMP), nextCursor: 'm-16' },
      { items: [], nextCursor: 'entity:' },
      { items: wire.slice(LIST_PAGE_CLAMP), nextCursor: null },
    ])

    const result = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 20 })) as {
      messages: Array<{ messageId: string }>
    }

    expect(result.messages.map((message) => message.messageId)).toEqual(messages.map((message) => message.messageId))
    // The transition page was really crossed (3 message pages, not 2).
    expect(rig.fake.readCallsFor('agent.messages.list')).toHaveLength(3)
  })
})

describe('issue #11 T8: the run bound is exactly three', () => {
  it('T8 completes when two empty pages are followed by a real one', async () => {
    // The boundary BELOW the limit: two consecutive empty pages are tolerated,
    // the third is not (T5). Without this case the constant could drift to 2
    // and only T5 would notice, one test too late.
    const fixture = sessions(12)
    const rig = await makeRig({ agent: { sessions: fixture } })
    rig.fake.scriptListPages('agent.sessions.list', [
      pageOf(fixture, 0, 4, 'c-1'),
      { items: [], nextCursor: 'c-2' },
      { items: [], nextCursor: 'c-3' },
      pageOf(fixture, 4, 12, null),
    ])

    const result = (await rig.call('cherry_sessions', { device: 'dev-A' })) as {
      items: Array<{ sessionId: string }>
      truncated?: boolean
    }

    expect(result.items.map((session) => session.sessionId)).toEqual(fixture.map((session) => session.sessionId))
    expect(result.truncated).toBe(false)
    expect(rig.fake.readCallsFor('agent.sessions.list')).toHaveLength(4)
  })
})

describe('v0.1.3 P3 (group B): a page of malformed items is never absorbed silently', () => {
  it('B6a drops a NON-RECORD item mid-walk, names the count in one warning, and still completes', async () => {
    // Every list page is projected through `arrayOf`, which drops a non-object
    // item on the floor. Dropping is the only option for a mid-walk page (the
    // caller's limit may already be beyond it), but dropping SILENTLY made a
    // short answer indistinguishable from a complete one at the peer's own
    // fault. The tolerated case still completes and still says nothing false;
    // it only leaves ONE bounded warning naming the method and the count.
    const fixture = sessions(20)
    const rig = await makeRig({ agent: { sessions: fixture } })
    rig.fake.scriptListPages('agent.sessions.list', [
      // One record and three non-records (a string, a number, null).
      { items: [summaryOf(fixture[0]!), 'not-a-session', 42, null], nextCursor: 'c-1' },
      pageOf(fixture, 1, 3, null),
    ])

    const result = (await rig.call('cherry_sessions', { device: 'dev-A' })) as {
      items: Array<{ sessionId: string }>
      truncated?: boolean
    }

    // The well-formed items survived; the malformed ones are gone.
    expect(result.items.map((session) => session.sessionId)).toEqual(
      fixture.slice(0, 3).map((session) => session.sessionId),
    )
    expect(result.truncated).toBe(false)
    // ONE warning for the walk, naming the method and the count — never the
    // items' contents (they are peer-supplied payload).
    const droppedWarnings = vi
      .mocked(console.warn).mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('agent.sessions.list') && line.includes('dropped'))
    expect(droppedWarnings).toHaveLength(1)
    expect(droppedWarnings[0]).toContain('3')
    for (const line of droppedWarnings) expect(line).not.toContain('not-a-session')
  })

  it('B6b REFUSES a terminal page whose items were dropped wholesale, instead of answering truncated:false', async () => {
    // The fail-loud case: the peer's LAST page says `nextCursor: null` (nothing
    // more) and every item on it is malformed, so the walk would return a
    // SHORT result while claiming it is complete. An empty page is legitimate
    // (the pinned-list transition) and a page that keeps at least one real item
    // is only lossy; a terminal page with items that ALL vanished is a
    // contradiction, and it is thrown with the exact diagnosis — same family
    // as the stuck-cursor refusal.
    const fixture = sessions(20)
    const rig = await makeRig({ agent: { sessions: fixture } })
    rig.fake.scriptListPages('agent.sessions.list', [
      pageOf(fixture, 0, LIST_PAGE_CLAMP, String(LIST_PAGE_CLAMP)),
      { items: [3, 'garbage'], nextCursor: null },
    ])

    const error = await rejectionOf(rig.call('cherry_sessions', { device: 'dev-A' }))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('peer returned 2 non-record items that were dropped')
    expect((error as Error).message).toContain('refusing a silently short result')
    expect((error as Error).message).toContain('agent.sessions.list')
    // The walk stopped AT the terminal page rather than inventing another one.
    expect(rig.fake.readCallsFor('agent.sessions.list')).toHaveLength(2)
  })
})

describe('issue #46: a page whose `items` is not an array is a protocol violation', () => {
  it('#46a REFUSES a terminal page carrying `items: "garbage"` instead of answering truncated:false', async () => {
    // `arrayOf` used to answer `{items: [], dropped: 0}` for ANY non-array, so
    // a terminal page (`nextCursor: null`) whose `items` was a string read as
    // "the peer is done, and everything is here" — `truncated: false` on a
    // result that silently lost a whole page. That is the same failure B6b
    // refuses (a contradicting last page) reached through a different door:
    // there the items were non-records, here there is no item list AT ALL.
    // The protocol's `pageOf` schema requires `items: array`, so this is a
    // peer fault, not an empty page — thrown with the exact diagnosis.
    const fixture = sessions(20)
    const rig = await makeRig({ agent: { sessions: fixture } })
    rig.fake.scriptListPages('agent.sessions.list', [
      pageOf(fixture, 0, LIST_PAGE_CLAMP, String(LIST_PAGE_CLAMP)),
      { items: 'garbage', nextCursor: null },
    ])

    const error = await rejectionOf(rig.call('cherry_sessions', { device: 'dev-A' }))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('agent.sessions.list')
    expect((error as Error).message).toContain('`items` is not an array')
    expect((error as Error).message).toContain('string')
    expect((error as Error).message).toContain('refusing a silently short result')
    // The payload itself never reaches the message: it is peer-supplied data.
    expect((error as Error).message).not.toContain('garbage')
    expect(rig.fake.readCallsFor('agent.sessions.list')).toHaveLength(2)
  })

  it('#46b REFUSES a malformed MID-walk page instead of skipping it and completing short', async () => {
    // A mid-walk page is the quieter half of the same defect. The walk used to
    // read a non-array `items` as an empty page and go on: no throw, and not
    // even B6a's dropped-count warning (there was no array to count), so the
    // result came back COMPLETE with a page-shaped hole in it. A missing
    // `items` is the same violation as a wrong-typed one — the schema requires
    // the array, so an empty page must say `items: []`, never omit it.
    const fixture = sessions(20)
    const rig = await makeRig({ agent: { sessions: fixture } })
    rig.fake.scriptListPages('agent.sessions.list', [
      pageOf(fixture, 0, LIST_PAGE_CLAMP, String(LIST_PAGE_CLAMP)),
      { nextCursor: 'c-after-the-hole' },
      pageOf(fixture, 2, 4, null),
    ])

    const error = await rejectionOf(rig.call('cherry_sessions', { device: 'dev-A' }))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('agent.sessions.list')
    expect((error as Error).message).toContain('`items` is not an array')
    expect((error as Error).message).toContain('missing')
    // The walk stopped AT the malformed page: it never asked for the page that
    // would have papered over the hole.
    expect(rig.fake.readCallsFor('agent.sessions.list')).toHaveLength(2)
  })
})
