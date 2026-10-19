import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import type { DeviceState } from '../../src/connection.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { registerCherryTools } from '../../src/tools.js'
import type {
  CherryToolDefinition,
  CherryToolEngineOptions,
  CherryToolsContext,
  CherryToolsDeps,
} from '../../src/tools.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions, FakeMessageRecord, FakeSessionRecord } from '../loopback/fakeCherry.js'

/**
 * Issue #15: the `agent.parts.list` RESULT cache.
 *
 * Every face that shows messages — `cherry_read` and the terminal/timeout/idle
 * aggregates — projects each message through ONE method (`#projectMessage`):
 * one `agent.parts.list` per message, plus one `agent.content.read` walk per
 * externalized `{ref}`. An agent that does send → wait → read in a loop paid
 * every one of those parts walks AGAIN on every call, for history that had not
 * moved.
 *
 * WHAT THE CACHE HOLDS — and the contract this suite pins — is the parts LIST
 * (the raw part records plus the walk's verdict), never the projection:
 *
 *  - an unchanged message reuses its cached list, so a repeated read costs NO
 *    `agent.parts.list` RPC (T1) — and the terminal face shares that cache (T2);
 *  - its CONTENT is still fetched and sha256-verified on every read (T1b). The
 *    revision fence covers a message's parts RECORDS, not the content store
 *    behind a `{ref}`, so caching the projection would serve bytes the peer has
 *    since corrupted. Re-projecting on every hit is what keeps a tamper loud;
 *  - the fence is the peer's own revision rule: a moved revision is a miss,
 *    whether the peer really moved (T3) or the row merely names another
 *    revision than the held entry (T8);
 *  - a TRUNCATED parts list is never held — a short walk must be retried, not
 *    remembered (T4);
 *  - both bounds hold: one entry above `messageCacheEntryBytes` is walked fresh
 *    every time (T5), the per-device byte budget evicts in INSERTION order (T6),
 *    and a REFRESH of an edited message corrects the total instead of inflating
 *    it (T5b);
 *  - invalidation rides the existing seam: a device that goes offline drops its
 *    entries with its session caches (T7).
 *
 * The rig is the `toolsRead.test.ts` one, duplicated per the house style (it
 * raises `rateBudgetPerSecond`, because a loopback peer should never pace a
 * fixture out over seconds). It additionally wires `watchDeviceState`, the way
 * `toolsCacheLifecycle.test.ts` does, because T7 needs the real transition.
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
// Rig
// ---------------------------------------------------------------------------

interface Rig {
  fake: FakeCherry
  ctx: FakeCtx
  store: DeviceStore
  tmp: string
  tool(name: string): CherryToolDefinition
  /** Invoke one registered tool by name, exactly as the host would. */
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  /** State transitions the client published, in order. */
  states(): DeviceState[]
  /** How many `connection.authenticate` calls the peer has answered. */
  authenticateCount(): number
  /** Brings a device's connection up, as the host would on first use. */
  connect(deviceId: string): Promise<void>
  /** Lets the connection's backoff loop run one more attempt. */
  reconnect(): Promise<void>
  stop(): Promise<void>
}

/** Every console.warn line that reports a cache eviction. */
function evictionWarnings(): string[] {
  return consoleWarn.mock.calls
    .map((call) => call.map(String).join(' '))
    .filter((line) => /message cache .* evicted/i.test(line))
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
  /** Local policy knobs (the cache bounds) for the engine. */
  engine?: CherryToolEngineOptions
}

async function makeRig(
  options: FakeCherryOptions = {},
  rigOptions: RigOptions = {},
  extraSessions: FakeSessionRecord[] = [],
): Promise<Rig> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-tools-read-cache-'))
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
  // Extra sessions for fixtures that need a second conversation on the same
  // peer (T6b's second device). Appended to whatever the options already carry.
  if (extraSessions.length > 0) {
    options.agent = { ...options.agent, sessions: [...(options.agent?.sessions ?? []), ...extraSessions] }
  }

  const connections = new Map<string, DeviceConnection>()
  const subscriptions = new Map<string, SessionSubscriptions>()
  const seenStates: DeviceState[] = []

  const connect = (deviceId: string): DeviceConnection => {
    const existing = connections.get(deviceId)
    if (existing !== undefined) return existing
    const stored = store.list().find((entry) => entry.deviceId === deviceId)
    if (stored === undefined) throw new Error(`no device ${deviceId}`)
    const connection = new DeviceConnection({
      identity,
      record: stored,
      // The peer is loopback and enforces no cap of its own; the production
      // business budget would pace a multi-page fixture out over seconds.
      rateBudgetPerSecond: 100_000,
      // A loopback peer is back immediately; the production backoff would make
      // T7 wait a second per attempt.
      backoffInitialMs: 20,
    })
    connection.onState((deviceState) => {
      seenStates.push(deviceState)
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
    // THE SAME WIRING THE ASSEMBLY USES (`src/index.ts`): the engine joins the
    // device's transitions through the connection's existing fan-out.
    watchDeviceState: (target, cb) => connections.get(target)?.onState(cb),
    pair: async () => {
      throw new Error('pairing is not exercised by the read-cache suite')
    },
    evict: () => {
      throw new Error('the read-cache suite never evicts')
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
    connect: async (deviceId) => {
      await connect(deviceId).connect()
    },
    states: () => [...seenStates],
    authenticateCount: () => fake.authenticateCount,
    reconnect: async () => {
      await connect('dev-A').connect()
    },
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
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = {
  sessionId: 's-1',
  agentId: 'agent-1',
  workspaceId: 'ws-1',
  title: 'Hello',
  historyRevision: '1000',
}

/**
 * A 30 KiB externalized part: above the peer's inline limit, so it travels as
 * a `{ref}` whose bytes only exist behind `agent.content.read`. A message with
 * one of these is the case the corrected design exists for: its LIST is cached,
 * its CONTENT is re-read and re-verified every time.
 */
const BIG_TEXT = 'R'.repeat(30 * 1024)

function message(messageId: string, revision: string, parts: FakeMessageRecord['parts']): FakeMessageRecord {
  return { messageId, revision, role: 'assistant', status: 'success', parts }
}

/** Three INLINE-ONLY messages — the simplest all-hits history. */
function healthyHistory(): FakeMessageRecord[] {
  return [
    message('m-1', '1001', [{ kind: 'text', text: 'first' }, { kind: 'text', text: 'second part' }]),
    message('m-2', '1002', [{ kind: 'text', text: 'second' }]),
    message('m-3', '1003', [{ kind: 'text', text: 'third' }]),
  ]
}

/** The same history, but m-1's second part is a 30 KiB `{ref}`. */
function refHistory(): FakeMessageRecord[] {
  return [
    message('m-1', '1001', [{ kind: 'text', text: 'first' }, { kind: 'text', text: BIG_TEXT, external: true }]),
    message('m-2', '1002', [{ kind: 'text', text: 'second' }]),
    message('m-3', '1003', [{ kind: 'text', text: 'third' }]),
  ]
}

function options(messages: FakeMessageRecord[], extra: Partial<FakeCherryOptions['agent']> = {}): FakeCherryOptions {
  return {
    agent: {
      agents: [{ agentId: 'agent-1', name: 'Agent One' }],
      sessions: [SESSION],
      messages,
      ...extra,
    },
  }
}

interface ReadResult {
  messages: Array<{ messageId: string; revision: string; parts: Array<{ content: string; unavailable?: string }> }>
}

/** The wire calls a projection makes: one parts page per message, plus refs. */
function partsCalls(rig: Rig): number {
  return rig.fake.methodCount('agent.parts.list')
}
function contentCalls(rig: Rig): number {
  return rig.fake.methodCount('agent.content.read')
}
/** The message ids of every `agent.parts.list` request, in order. */
function walkedIds(rig: Rig): unknown[] {
  return rig.fake.readCallsFor('agent.parts.list').map((call) => call['messageId'])
}

/**
 * The bytes one cached entry costs, under the corrected entry shape
 * (`JSON.stringify(page.items).length`): the parts RECORDS as the peer served
 * them, not the projection. `revision` is the message revision the parts were
 * listed under, which is what the `{ref}` inside each record carries.
 */
function partsPageBytes(messageId: string, revision: string, partCount: number, text = 'x'): number {
  return JSON.stringify(
    Array.from({ length: partCount }, (_unused, index) => ({
      partId: `${messageId}:${index}`,
      revision,
      kind: 'text',
      content: { text },
      // The peer's text records carry `state` too (see `FakeCherry#part`); a
      // model that omitted it would under-count every entry by a constant, and
      // a budget derived from the model would then not mean what the test says.
      state: 'completed',
    })),
  ).length
}

/**
 * The bytes an entry costs for a whole FIXTURE message — the model above driven
 * by the record the peer will actually serve, so a fixture's text cannot drift
 * away from the size its budget was derived from. (It did exactly that once:
 * the helper hard-coded `'x'` while a fixture served `'body 0'`, and the budget
 * silently held one entry fewer than the test claimed.)
 */
function entryBytesOf(record: FakeMessageRecord): number {
  return JSON.stringify(
    record.parts.map((part, index) => ({
      partId: `${record.messageId}:${index}`,
      revision: record.revision,
      kind: part.kind,
      content: { text: part.text },
      state: 'completed',
    })),
  ).length
}

describe('issue #15: the parts-list read cache', () => {
  it('T1 a second read of an unchanged session issues ZERO parts RPCs', async () => {
    // THE FEATURE. Before the cache, `cherry_read` re-walked every message's
    // parts on EVERY call — an agent that does send → wait → read paid for the
    // same immutable history each round.
    const rig = await makeRig(options(healthyHistory()))

    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    // The first read really walked: one parts page per message.
    expect(partsCalls(rig)).toBe(3)
    expect(first.messages.map((entry) => entry.messageId)).toEqual(['m-1', 'm-2', 'm-3'])

    const second = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult

    // NOT ONE parts page on the second read...
    expect(partsCalls(rig)).toBe(3)
    // ...and (this history has no refs) not one content read either.
    expect(contentCalls(rig)).toBe(0)
    // Deeper than a count: the ids walked are still exactly the first read's.
    expect(walkedIds(rig)).toEqual(['m-1', 'm-2', 'm-3'])
    // The answer is IDENTICAL, so the saving did not change the data.
    expect(second).toEqual(first)
  })

  it('T1b a ref-bearing message caches its LIST but re-reads and re-verifies its CONTENT every time', async () => {
    // THE POINT OF THE CORRECTED DESIGN. A message revision fences the parts
    // RECORDS; it says nothing about the content store behind a `{ref}`. Caching
    // the list and re-projecting on every hit keeps BOTH wins: the list walk is
    // skipped, and the content walk — with its sha256 verification — still runs,
    // so a tamper is never served from memory.
    const rig = await makeRig(options(refHistory()))

    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    expect(first.messages[0]!.parts[1]!.content).toBe(BIG_TEXT)
    const partsAfterFirst = partsCalls(rig)
    const contentsAfterFirst = contentCalls(rig)
    expect(partsAfterFirst).toBe(3)
    expect(contentsAfterFirst).toBeGreaterThan(0)

    const second = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    expect(second).toEqual(first)
    // The LIST came from memory: zero new parts RPCs...
    expect(partsCalls(rig)).toBe(partsAfterFirst)
    // ...while the CONTENT was fetched again, exactly as often as the first read
    // fetched it. Not "at least once": the same count, so nothing was skipped.
    expect(contentCalls(rig) - contentsAfterFirst).toBe(contentsAfterFirst)

    // The guarantee this protects, pinned NEXT TO the cache: corrupted bytes
    // behind an unchanged revision still fail the read loudly, even though the
    // parts list for that message came straight from the cache.
    rig.fake.tamperContent('m-1:1', '1001')
    const partsBeforeTamper = partsCalls(rig)
    await expect(rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })).rejects.toThrow(
      /sha256|digest|integrity/i,
    )
    // The tampered read was a cache HIT and still refused — an uncached walk
    // would not have proved anything about the cache.
    expect(partsCalls(rig)).toBe(partsBeforeTamper)
  })

  it('T2 the terminal face shares the cache: a wait after a read walks no cached parts', async () => {
    // ONE cache behind ONE projection (`#projectMessage`) — not one per face.
    const rig = await makeRig(options(healthyHistory()))

    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    const afterRead = partsCalls(rig)
    expect(afterRead).toBe(3)

    // The idle aggregate projects the SAME messages, newest-first.
    const waited = (await rig.call('cherry_wait', { device: 'dev-A', sessionId: 's-1' })) as {
      status: string
      messages: Array<{ messageId: string; parts: Array<{ content: string }> }>
    }
    expect(waited.status).toBe('idle')
    expect(waited.messages.map((message) => message.messageId)).toEqual(['m-1', 'm-2', 'm-3'])
    // Content still arrives — re-projected from the cached list, not re-walked.
    expect(waited.messages[0]!.parts[1]!.content).toBe('second part')
    expect(partsCalls(rig)).toBe(afterRead)
  })

  it('T3 the revision fence is real: a moved revision re-fetches and the new list is projected', async () => {
    // The peer refuses a stale `messageRevision` with REVISION_EXPIRED, so an
    // entry is only valid for the revision the message row CURRENTLY carries.
    // A stale serve here would be a correctness hole, not a lost optimisation.
    const history = healthyHistory()
    const rig = await makeRig(options(history))

    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(partsCalls(rig)).toBe(3)

    // The desktop EDITS m-2 on the same message id: new revision, new text.
    // (`FakeMessageRecord` is a mutable fixture record.)
    history[1]!.revision = '2002'
    history[1]!.parts = [{ kind: 'text', text: 'second, edited' }]

    const second = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    // m-2 alone was re-fetched; m-1 and m-3 stayed hits.
    expect(partsCalls(rig)).toBe(4)
    expect(walkedIds(rig)).toEqual(['m-1', 'm-2', 'm-3', 'm-2'])
    // ...and the re-fetch was asked for under the NEW revision, the one the row
    // named — the fence comparison, visible on the wire.
    expect(rig.fake.readCallsFor('agent.parts.list').at(-1)!['messageRevision']).toBe('2002')
    const edited = second.messages.find((entry) => entry.messageId === 'm-2')!
    expect(edited.revision).toBe('2002')
    expect(edited.parts[0]!.content).toBe('second, edited')
  })

  it('T4 a TRUNCATED parts list is never cached: the next read walks it again', async () => {
    // A circuit-broken parts walk is SHORT. Remembering it would turn one
    // transient trip into a permanently truncated list for as long as the
    // revision stood, so the store refuses it and the next read retries.
    //
    // Mechanics: m-1 has 10 parts, the peer pages by 4, and the engine's safety
    // bound is 6 — so the first read stops at 6 parts and surfaces
    // `partsTruncated`. m-2 and m-3 are single-page and are held normally, so
    // the test can tell "refused because truncated" from "nothing was cached".
    const parts = Array.from({ length: 10 }, (_unused, index) => ({
      kind: 'text' as const,
      text: `p-${index}`,
    }))
    const rig = await makeRig(
      options(healthyHistory(), { maxPageSize: 4 }),
      { engine: { partsSafetyBound: 6 } },
    )
    rig.fake.setAgentMessages([
      message('m-1', '1001', parts),
      message('m-2', '1002', [{ kind: 'text', text: 'second' }]),
      message('m-3', '1003', [{ kind: 'text', text: 'third' }]),
    ])

    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult & {
      messages: Array<{ messageId: string; incomplete?: true; partsTruncated?: string; parts: unknown[] }>
    }
    expect(first.messages[0]!.messageId).toBe('m-1')
    expect(first.messages[0]!.partsTruncated).toBe('safety-bound')
    expect(first.messages[0]!.parts).toHaveLength(6)
    const afterFirst = partsCalls(rig)
    expect(afterFirst).toBeGreaterThan(1)

    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    // m-1 is walked AGAIN (its list was truncated and never held); m-2 and m-3
    // are hits. m-1's re-walk re-reads its two pages, so the count grows by 2.
    expect(walkedIds(rig).slice(afterFirst)).toEqual(['m-1', 'm-1'])
    expect(partsCalls(rig)).toBe(afterFirst + 2)
  })

  it('T5 the per-entry cap: a list above messageCacheEntryBytes is walked fresh every time', async () => {
    // WHAT IS SIZED CHANGED with the entry shape: the cost is now
    // `JSON.stringify(page.items).length` — the part RECORDS — not the
    // projection. `partsPageBytes` recomputes exactly that for each fixture,
    // and the cap below is set BETWEEN the two sizes, so the cap selects rather
    // than blankets:
    //
    //   m-1 whose id is 200 characters   → ~2.3 KB     (over the cap)
    //   m-2 / m-3, short ids             →  ~100 bytes  (under it)
    //
    // The ID dominates, and that is what makes the cap select — but the entry
    // is NOT text-free: inline part text IS in `page.items` and IS counted
    // (2 KiB here), which is why the numbers above are kilobytes rather than
    // the "~275 bytes" an earlier version of this comment claimed. What the
    // cache does NOT hold is the resolved `{ref}` text. (The ids are made
    // deliberately different in LENGTH for the same reason: two ids of equal
    // length would produce two equal-sized entries and the cap could not
    // select.)
    const big = 'I'.repeat(2048)
    const longId = `m-${'1'.repeat(200)}`
    const cap = partsPageBytes(longId, '1001', 1)
    const small = partsPageBytes('m-2', '1002', 1)
    expect(cap).toBeGreaterThan(small)
    const rig = await makeRig(
      options([
        message(longId, '1001', [{ kind: 'text', text: big }]),
        message('m-2', '1002', [{ kind: 'text', text: 'second' }]),
        message('m-3', '1003', [{ kind: 'text', text: 'third' }]),
      ]),
      { engine: { messageCacheEntryBytes: cap, messageCacheBytesPerDevice: 8 * 1024 * 1024 } },
    )

    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    expect(partsCalls(rig)).toBe(3)
    expect(first.messages[0]!.parts[0]!.content).toHaveLength(2048)

    // Only the over-cap message is walked again; its siblings are hits.
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(partsCalls(rig)).toBe(4)
    expect(walkedIds(rig).slice(3)).toEqual([longId])
    // It is never held, so a THIRD read walks it again — exactly once.
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(partsCalls(rig)).toBe(5)
    expect(walkedIds(rig).slice(4)).toEqual([longId])
  })

  it('T5b a REFRESH replaces the entry in place: the device total is corrected, not doubled', async () => {
    // The accounting hazard: a revision change re-walks the SAME key. If the
    // refresh ADDED the new size without subtracting the old one, the device
    // total would drift upward, and the NEXT insert would evict a survivor that
    // plainly fits.
    //
    // The sizes are the RECORD sizes, recomputed rather than assumed. An edit
    // that changes a part's text DOES change the record's size (the text is in
    // the record), but only slightly and non-monotonically, so the
    // discriminator here is an edit that changes the record SHAPE — m-2 gains a
    // part — which reliably grows the entry.
    const onePart = (id: string, revision: string, text: string): FakeMessageRecord =>
      message(id, revision, [{ kind: 'text', text }])
    const m1 = onePart('m-1', '1001', 'first')
    const m2Before = onePart('m-2', '1002', 'second')
    const m2After = message('m-2', '2002', [
      { kind: 'text', text: 'second, edited' },
      { kind: 'text', text: 'and a second part' },
    ])
    const m3 = onePart('m-3', '1003', 'third')

    const sizeM1 = partsPageBytes('m-1', '1001', 1)
    const sizeM2Before = partsPageBytes('m-2', '1002', 1)
    const sizeM2After = partsPageBytes('m-2', '2002', 2)
    const sizeM3 = partsPageBytes('m-3', '1003', 1)
    // The edit really does grow the ENTRY (a second record) — otherwise this
    // fixture would not discriminate at all.
    expect(sizeM2After).toBeGreaterThan(sizeM2Before)

    // Budget, with the room-making rule in mind (an INSERT makes room BEFORE it
    // writes, against the total as it stands):
    //   correct   after the refresh the total is m1 + m2after; the m-3 insert
    //             makes room for m3 against that total and fits;
    //   drifted   the refresh ADDED instead of correcting, so the total is
    //             m1 + m2before + m2after; m-3's insert sees that plus itself
    //             exceed the budget and evicts a survivor that fits.
    // Both totals are built from the SAME recomputed record sizes, so the only
    // difference between them is what the refresh left behind. The budget is
    // placed strictly between the two DECISIONS m-3's insert has to make — the
    // total it sees plus its own growth:
    //
    //   honest   (m1 + m2after) + m3   must FIT      → budget ≥ this
    //   drifted  (m1 + m2before + m2after) + m3  must NOT fit → budget < this
    //
    // Note both quantities ALREADY include m3 — they are decisions at the
    // insert, not totals at rest. An earlier version of this fixture added m3 a
    // second time and put the budget ABOVE the drifted decision, which made the
    // whole test vacuous: the drift mutant passed it. Sizes are strictly
    // positive, so `drifted - 1 ≥ honest` holds and the window is non-empty.
    const honest = sizeM1 + sizeM2After + sizeM3
    const drifted = sizeM1 + sizeM2Before + sizeM2After + sizeM3
    expect(drifted).toBeGreaterThan(honest)
    const budget = Math.max(drifted - 1, honest)
    expect(budget).toBeGreaterThanOrEqual(honest)
    expect(budget).toBeLessThan(drifted)
    const rig = await makeRig(options([structuredClone(m1), structuredClone(m2Before)]), {
      engine: { messageCacheBytesPerDevice: budget },
    })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(partsCalls(rig)).toBe(2)
    expect(evictionWarnings()).toHaveLength(0)

    // The desktop EDITS m-2: same id, new revision, a part added.
    rig.fake.setAgentMessages([structuredClone(m1), structuredClone(m2After)])
    const edited = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    expect(edited.messages[1]!.revision).toBe('2002')
    expect(edited.messages[1]!.parts).toHaveLength(2)
    expect(partsCalls(rig)).toBe(3)
    expect(evictionWarnings()).toHaveLength(0)

    // A THIRD message arrives: it fits beside the two held entries only if the
    // refresh kept the total honest.
    rig.fake.setAgentMessages([structuredClone(m1), structuredClone(m2After), structuredClone(m3)])
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(evictionWarnings()).toEqual([])
    // Only m-3's list was walked: m-1 and the refreshed m-2 are hits.
    expect(partsCalls(rig)).toBe(4)
    expect(walkedIds(rig).slice(3)).toEqual(['m-3'])

    // All three are held: a fourth read walks nothing.
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(partsCalls(rig)).toBe(4)
  })

  it('T5e a REFRESH never evicts the key it is writing, even when that key is the oldest', async () => {
    // The eviction loop walks `Map` insertion order and must SKIP the key being
    // written: replacing it IS this call, and its previous bytes are already
    // excluded from the growth being made room for. Refreshing the OLDEST entry
    // under pressure is where that skip matters — without it the loop evicts
    // the entry it is about to write, and re-inserting it moves it to the BACK
    // of the order, silently breaking the insert-order policy pinned by T6c.
    //
    // Observable in the SAME read: with the guard, the refresh evicts the OTHER
    // entry, and because that entry is projected later in the same walk it is a
    // MISS and is re-walked. Without the guard, the refreshed key removes and
    // re-adds ITSELF, the other entry survives as a HIT, and the read issues one
    // fewer parts call. (A later probe read cannot show this: the eviction
    // cascade that follows leaves either final cache one entry deep, so the two
    // paths are indistinguishable there — the call count during the refresh is
    // the difference.)
    const onePart = (id: string, revision: string, text: string): FakeMessageRecord =>
      message(id, revision, [{ kind: 'text' as const, text }])
    const history = [onePart('m-1', '1001', 'first'), onePart('m-2', '1002', 'second')]
    const one = entryBytesOf(history[0]!)
    const grown = entryBytesOf(
      message('m-1', '2001', [
        { kind: 'text' as const, text: 'first' },
        { kind: 'text' as const, text: 'and a second part' },
      ]),
    )
    // Room for the honest refresh's growth only after evicting the OTHER entry;
    // the grown entry itself must still fit on its own.
    const budget = grown + 1
    expect(budget).toBeGreaterThanOrEqual(one + one)
    expect(grown).toBeGreaterThan(one)

    const rig = await makeRig(options(history), {
      engine: { messageCacheEntryBytes: 100_000, messageCacheBytesPerDevice: budget },
    })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(walkedIds(rig)).toEqual(['m-1', 'm-2'])

    // m-1 — the FIRST entry in device order — is edited and grows.
    history[0]!.revision = '2001'
    history[0]!.parts = [
      { kind: 'text', text: 'first' },
      { kind: 'text', text: 'and a second part' },
    ]
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })

    // With the skip: m-2 was evicted to make room for m-1's growth, so m-2 is a
    // MISS when the walk reaches it and is re-walked. Without it: m-1 evicted
    // itself, m-2 is still held, and only m-1 is walked.
    expect(walkedIds(rig)).toEqual(['m-1', 'm-2', 'm-1', 'm-2'])
  })

  it('T5d an entry that cannot fit the DEVICE budget is refused, whatever the entry cap says', async () => {
    // The two ceilings judge independently, and the entry cap alone is not
    // enough: an injection that puts `messageCacheEntryBytes` ABOVE
    // `messageCacheBytesPerDevice` would let one oversized entry evict the
    // whole device's cache and then be stored anyway — the thrash the cap
    // exists to prevent, arriving through the knob that is supposed to be the
    // guard. An entry larger than the device budget can never fit, so it is
    // refused before the eviction loop is even reached.
    //
    // Observable: with the guard, the entry is never held and the second read
    // walks again. Without it, the entry occupies the cache and the second read
    // is a pure hit.
    const history = [message('m-1', '1001', [{ kind: 'text' as const, text: 'first' }])]
    const entry = entryBytesOf(history[0]!)
    const rig = await makeRig(options(history), {
      // The cap is raised far ABOVE the device budget — the pathological
      // injection this guard exists for.
      engine: { messageCacheEntryBytes: 100_000, messageCacheBytesPerDevice: entry - 1 },
    })

    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(walkedIds(rig)).toEqual(['m-1'])

    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    // Refused: the entry is one byte too large for the device, so it is walked
    // fresh. (Under the broken guard this list is empty — the entry was held.)
    expect(walkedIds(rig)).toEqual(['m-1', 'm-1'])
  })

  it('T5c a REFRESH that GROWS makes room for its growth — the budget holds on the refresh path too', async () => {
    // The refresh path is the one that is easy to get wrong, and it was: with
    // room-making guarded by "is this a NEW key", a refresh skipped it entirely
    // and raised the device total straight through the budget. The reachable
    // shape is ordinary — a message is EDITED, so its revision moves and its
    // parts list grows — which is exactly the case here: m-2 gains a part.
    //
    // Budget: two one-part entries. m-1 and m-2 fill it; m-2 is then re-listed
    // at a new revision with an extra part, so replacing it needs room for the
    // DIFFERENCE, and the only way to find that room is to evict m-1.
    const onePart = (id: string, revision: string, text: string): FakeMessageRecord =>
      message(id, revision, [{ kind: 'text' as const, text }])
    const history = [onePart('m-1', '1001', 'first'), onePart('m-2', '1002', 'second')]
    const sizeOfOne = entryBytesOf(history[0]!)
    // The budget must (a) hold BOTH one-part entries — otherwise neither is
    // ever cached and the refresh path is never reached — and (b) still hold
    // the GROWN entry on its own, or the store would simply refuse it and the
    // test would prove nothing about room-making. The grown size is computed
    // from a throwaway copy of the edited record, so the two bounds stay in the
    // right relation whatever the JSON overhead turns out to be.
    const grown = entryBytesOf(
      message('m-2', '2002', [
        { kind: 'text' as const, text: 'second' },
        { kind: 'text' as const, text: 'and a second part' },
      ]),
    )
    expect(grown).toBeGreaterThan(sizeOfOne * 2)
    expect(grown + 1).toBeGreaterThan(sizeOfOne * 2)
    const budget = grown + 1

    // NO deep copy: the fixture array is handed to the fake BY REFERENCE, and
    // mutating a record is how the peer's "the message was edited" is modelled
    // (T3 does the same).
    const rig = await makeRig(options(history), {
      engine: { messageCacheEntryBytes: 100_000, messageCacheBytesPerDevice: budget },
    })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    const afterFirst = walkedIds(rig).length
    expect(afterFirst).toBe(2)

    // EDIT m-2: new revision, and a second part — the list grows.
    history[1]!.revision = '2002'
    history[1]!.parts = [
      { kind: 'text', text: 'second' },
      { kind: 'text', text: 'and a second part' },
    ]

    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    // The re-listed message is projected at its NEW revision.
    expect(walkedIds(rig).slice(afterFirst)).toEqual(['m-2'])

    // THE ASSERTION: m-1 was evicted to make room for m-2's growth. If the
    // refresh skipped room-making, m-1 is still held and the next read issues
    // no parts RPC at all — a silent budget breach (2 entries' worth of bytes
    // for one entry that no longer fits beside its neighbour).
    const beforeProbe = walkedIds(rig).length
    const probe = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    // The FIRST re-walked entry is the policy claim: m-1 was evicted for m-2's
    // growth. (The probe then cascades — re-inserting m-1 makes room against
    // the grown m-2 — which is a size consequence, not a second claim.)
    expect(walkedIds(rig).slice(beforeProbe)[0]).toBe('m-1')
    expect(probe.messages.map((entry) => entry.messageId)).toEqual(['m-1', 'm-2'])
  })

  it('T6c a REFRESH keeps the key\'s INSERTION position — eviction order is insert-order, not write-order', async () => {
    // FIFO, not LRU, and the difference only shows after a refresh. A refresh
    // is not a new use of the entry — the same key is rewritten in place — so
    // it must NOT move to the back. (A `delete`-then-`set` refresh would make it
    // do exactly that, turning the policy into LRU-on-write.)
    //
    //   read 1 (limit 2): m-1, m-2 enter        → order m-1, m-2
    //   edit m-1 (same size): read 2 refreshes it → order must STAY m-1, m-2
    //   read 3 (limit 3): m-3 needs room         → evict the oldest = m-1
    //
    // A delete-then-set refresh would have left the order m-2, m-1 and evicted
    // m-2 instead, which the probe read below reads off the wire.
    const onePart = (id: string, revision: string, text: string): FakeMessageRecord =>
      message(id, revision, [{ kind: 'text' as const, text }])
    const history = [
      onePart('m-1', '1001', 'first'),
      onePart('m-2', '1002', 'second'),
      onePart('m-3', '1003', 'third'),
    ]
    const sizeOfOne = entryBytesOf(history[0]!)
    const budget = sizeOfOne * 2 + 1

    // By reference, as in T5c: mutating the record is the peer's "edited".
    const rig = await makeRig(options(history), {
      engine: { messageCacheEntryBytes: 100_000, messageCacheBytesPerDevice: budget },
    })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 2 })
    const afterFirst = walkedIds(rig).length
    expect(afterFirst).toBe(2)

    // Same size, new revision: the refresh replaces the entry in place.
    history[0]!.revision = '2001'
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 2 })
    expect(walkedIds(rig).slice(afterFirst)).toEqual(['m-1'])

    // m-3 arrives and needs room. FIFO drops m-1 (still the oldest INSERTION);
    // a write-order policy would drop m-2.
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 3 })
    const beforeProbe = walkedIds(rig).length
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 3 })
    expect(walkedIds(rig).slice(beforeProbe)[0]).toBe('m-1')
  })

  it('T6 the per-device byte budget evicts the OLDEST entry first, and warns once without a message id', async () => {
    // THREE messages (sizes recomputed by `partsPageBytes`, never assumed) and a
    // budget one byte under their total, so the third insert cannot simply
    // append. The insertion order is (`m-1`, `m-2`, `m-3`), and every insert
    // makes room BEFORE it writes, so the device never passes its budget — not
    // even by the entry being written:
    //
    //   insert m-1 (s1)    before 0              → s1          (fits)
    //   insert m-2 (s2)    s1 + s2 ≤ budget      → s1 + s2     (fits)
    //   insert m-3 (s3)    s1 + s2 + s3 > budget → EVICT the OLDEST (m-1), then
    //                                              re-check and insert
    //
    // The re-read proves WHICH entry went, on the wire: the first message walked
    // again is m-1, the OLDEST.
    //
    // THIS DOES NOT BY ITSELF DISTINGUISH FIFO FROM LRU, and saying otherwise
    // would be the kind of claim this suite exists to refuse. Nothing here was
    // ever HIT — three inserts, then a re-read — so no entry carries any recency
    // and the two policies order the entries identically. T6b is the case that
    // separates them (a hit before the pressure), and the cross-device half of
    // T6b is what pins the device filter the eviction loop needs.
    //
    // The CONTROL below runs the identical fixtures under a budget that holds
    // every entry, so "the wrong entry was walked" cannot hide behind a cache
    // that simply never caches anything.
    //
    // The ids are DIFFERENT LENGTHS on purpose: the entry is the parts RECORD,
    // whose size is dominated by the id, and equal-length ids would give three
    // equal entries — a budget that fits two would then fit any two, including
    // itself, and "oldest first" could not be read off the wire unambiguously.
    // m-1 is made the widest (a long id: the id IS most of a record), so the
    // first two inserts genuinely fit and the third genuinely does not.
    const longId = `m-${'1'.repeat(200)}`
    // EACH RIG BELOW GETS ITS OWN COPY of the fixtures. `FakeCherry` keeps the
    // options object by reference, so two rigs built from one `history` array
    // would share message records — and (in a test that mutates them) would
    // make the wire disagree with the entry sizes the cache accounted for.
    const history = [
      message(longId, '1001', [{ kind: 'text' as const, text: 'first part, deliberately wide' }]),
      message('m-2', '1002', [{ kind: 'text' as const, text: 'second' }]),
      message('m-3', '1003', [{ kind: 'text' as const, text: 'third' }]),
    ]
    const sizes = [
      partsPageBytes(longId, '1001', 1),
      partsPageBytes('m-2', '1002', 1),
      partsPageBytes('m-3', '1003', 1),
    ]
    // The budget must let the FIRST TWO inserts fit (the FIFO claim below
    // depends on m-3 being the entry that makes the room), and must not let the
    // third: it is placed one byte under the total of all three, which is
    // necessarily at least the first two.
    const all = sizes[0]! + sizes[1]! + sizes[2]!
    const two = all - 1
    expect(two).toBeGreaterThanOrEqual(sizes[0]! + sizes[1]!)
    // After the eviction the two survivors must fit, or every later insert
    // would evict again and the single-warning assertion below would be wrong.
    expect(two).toBeGreaterThanOrEqual(sizes[1]! + sizes[2]!)

    // CONTROL: the same entries under a budget that holds all three — the second
    // read is all hits and nothing was evicted. (Both bounds are raised with the
    // fixture's own sizes, so neither silently overrides the other.)
    const control = await makeRig(options(JSON.parse(JSON.stringify(history))), {
      engine: { messageCacheEntryBytes: 100_000, messageCacheBytesPerDevice: 100_000 },
    })
    await control.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    await control.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(partsCalls(control)).toBe(3)
    expect(evictionWarnings()).toHaveLength(0)

    // THE BUDGET: one byte short of all three — and, unlike the control above,
    // one the per-entry cap cannot silently override: above the widest entry so
    // that EVERY message really is a candidate and the eviction is what decides.
    expect(two).toBeGreaterThan(sizes[0]!)
    const rig = await makeRig(options(JSON.parse(JSON.stringify(history))), {
      engine: { messageCacheEntryBytes: two, messageCacheBytesPerDevice: two },
    })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(partsCalls(rig)).toBe(3)

    // ONE warning for the ONE insert that evicted anything — naming the device
    // and the COUNT, never a message id (logging contract).
    const warnings = evictionWarnings()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('dev-A')
    expect(warnings[0]).toMatch(/evicted 1 oldest entry/)
    for (const line of warnings) {
      for (const id of [longId, 'm-2', 'm-3']) expect(line).not.toContain(id)
      expect(line).not.toMatch(/first|second|third/)
    }

    // WHICH entry went, read off the WIRE rather than inferred: the re-read's
    // FIRST re-walked message is m-1, the OLDEST. Nothing beyond that first step
    // is pinned: at this budget m-1 is the WIDEST entry, so its re-entry cannot
    // fit beside the two survivors and FIFO evicts more of them. That cascade is
    // a consequence of the sizes, not a policy claim.
    const reread = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    expect(reread.messages.map((entry) => entry.messageId)).toEqual([longId, 'm-2', 'm-3'])
    const rewaked = walkedIds(rig).slice(3)
    expect(rewaked[0]).toBe(longId)
    // EVERY eviction was FIFO and named once per insert — device and count only.
    expect(evictionWarnings().length).toBeGreaterThanOrEqual(1)
    expect(evictionWarnings()).toHaveLength(4)
    for (const line of evictionWarnings()) expect(line).toMatch(/evicted 1 oldest entry/)
  })

  it('T6b a HIT before the pressure is what separates FIFO from LRU — and eviction never crosses devices', async () => {
    // T6 cannot tell the two policies apart: nothing there is ever HIT, so no
    // entry carries a recency and FIFO order ≡ LRU order.
    //
    // IT TAKES MORE THAN A HIT TO SEPARATE THEM, and the first version of this
    // fixture got that wrong. A FULL read touches the cached entries in
    // newest-first order, which is the order they were INSERTED in, so any
    // LRU-on-hit leaves exactly the FIFO victim — the two policies are
    // observationally identical under that access pattern, and a hit alone
    // discriminates nothing.
    //
    // What separates them is a partial touch followed by an insert that does
    // NOT touch the cached entries on its way in:
    //
    //   read 1 (limit 2): insert A=m-1, B=m-2          → order A, B
    //   read 2 (limit 1): hit A ONLY                   → LRU order becomes B, A
    //                                                     FIFO order stays A, B
    //   read 3 (RESUME past B): insert C=m-3           → touches neither A nor B
    //                                                     FIFO evicts A (oldest inserted)
    //                                                     LRU evicts B (least recently used)
    //
    // The resume cursor is what makes read 3 skip the cached messages: a plain
    // `limit: 3` read would hit A and B first (restoring their relative
    // recency) and hand both policies the same victim. The probe's FIRST
    // re-walked id is therefore the whole policy claim: 'm-1' under FIFO,
    // 'm-2' under LRU.
    //
    // The second device is the other point: the same fixture runs beside a
    // TWO-device store, so an eviction loop that forgot its device-prefix check
    // would free dev-A's room out of dev-B's entries.
    const ids = ['m-1', 'm-2', 'm-3']
    const history = ids.map((id, index) =>
      message(id, `100${index + 1}`, [{ kind: 'text' as const, text: `body ${index}` }]),
    )
    const sizes = history.map(entryBytesOf)
    const twoOfThree = sizes[0]! + sizes[1]! + 1
    // The budget fits two entries and refuses three, so the third insert must
    // evict exactly one.
    expect(twoOfThree).toBeGreaterThanOrEqual(sizes[0]! + sizes[1]!)
    expect(twoOfThree).toBeLessThan(sizes[0]! + sizes[1]! + sizes[2]!)

    // A SECOND session for the second device: the loopback peer keys
    // subscriptions by session per connection, so two devices sharing one
    // session on one fake peer would collide before the cache is reached.
    const rig = await makeRig(
      options(JSON.parse(JSON.stringify(history))),
      { engine: { messageCacheEntryBytes: 100_000, messageCacheBytesPerDevice: twoOfThree } },
      [{ sessionId: 's-2', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Other', historyRevision: '1' }],
    )
    rig.store.upsert({ ...rig.store.list()[0]!, deviceId: 'dev-B', displayName: 'Desk Beta' })
    await rig.connect('dev-B')
    await rig.call('cherry_read', { device: 'dev-B', sessionId: 's-2', limit: 2 })
    await rig.call('cherry_read', { device: 'dev-B', sessionId: 's-2', limit: 2 })
    const devBWarm = walkedIds(rig).length
    expect(devBWarm).toBe(2)

    // Read 1: A and B enter, newest-first, and both fit.
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 2 })
    expect(walkedIds(rig).slice(devBWarm)).toEqual(['m-1', 'm-2'])

    // Read 2: ONE message — a hit on A alone, which is the recency asymmetry
    // the policies disagree about.
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 1 })
    expect(walkedIds(rig).slice(devBWarm + 2)).toEqual([])

    // Read 3: resume PAST B, so the walk starts at C and never touches A or B.
    // C is new and does not fit beside them: exactly one is evicted.
    await rig.call('cherry_read', {
      device: 'dev-A',
      sessionId: 's-1',
      limit: 1,
      messagesResumeCursor: 'cursor:2',
    })
    expect(walkedIds(rig).slice(devBWarm + 2)).toEqual(['m-3'])

    // THE PROBE: whichever entry was evicted is walked again. FIFO dropped A
    // (oldest inserted; read 2's hit must not have re-ordered it), LRU dropped
    // B (least recently used after read 2 touched A). Only the FIRST re-walked
    // id is asserted — the probe then cascades, which is a size consequence.
    const beforeProbe = walkedIds(rig).length
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1', limit: 3 })
    const probe = walkedIds(rig).slice(beforeProbe)
    expect(probe[0]).toBe('m-1')

    // CROSS-DEVICE ISOLATION: dev-A's eviction never reached into dev-B's
    // entries. Without the device-prefix filter, dev-A's pressure would have
    // freed its room out of the other device.
    const beforeB = walkedIds(rig).length
    await rig.call('cherry_read', { device: 'dev-B', sessionId: 's-2', limit: 2 })
    expect(walkedIds(rig).slice(beforeB)).toEqual([])
  })

  it('T7 reaching `offline` drops the device\'s message entries with its session caches', async () => {
    // `#watchConnection` routes `offline` / `identity-mismatch` into
    // `#forgetDevice`; the cache must ride the same seam, or a re-paired device
    // could inherit lists read under the previous pairing.
    //
    // WHAT THAT SEAM ACTUALLY FIRES ON, stated here because it is broader than
    // "revoked grant": an ordinary LINK LOSS also goes `offline` (the
    // connection's `#loseLink` calls `#setState('offline')` before backing off
    // and re-establishing), so a plain network blip drops the entries too. That
    // is the documented cost of the seam — one re-walk per session on reuse —
    // and not something this cache is entitled to narrow.
    const rig = await makeRig(options(healthyHistory()))

    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    const afterFirst = partsCalls(rig)
    expect(afterFirst).toBe(3)

    // The desktop revokes the grant: the establishment's `authenticate` is
    // refused and the connection turns that into `offline`.
    rig.fake.setAuthenticateFailure({ reason: 'GRANT_REVOKED', message: 'grant revoked' })
    rig.fake.dropConnections()
    await vi.waitFor(() => expect(rig.states().at(-1)).toBe('offline'), { timeout: 5_000 })

    // The operator re-grants the device. The engine's watch already forgot the
    // device, so the next read walks every message again.
    rig.fake.setAuthenticateFailure(undefined)
    await rig.reconnect()
    await vi.waitFor(() => expect(rig.states().at(-1)).toBe('connected'), { timeout: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))

    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(partsCalls(rig)).toBe(afterFirst + 3)
  }, 30_000)

  it('T8 an entry held under revision A is never served for a row at revision B', async () => {
    // The EMPTY revision itself cannot reach the store through the public face:
    // `messageRevision` is a strict `decimal`, so a `''` walk is refused by the
    // protocol before the peer answers, and no list is ever stored for it. What
    // the face CAN show is the fence's boundary, which is the same rule the
    // empty case needs: an entry under revision A must never be served for a row
    // at revision B.
    //
    // T3 already pins that against the PEER moving (a new revision with a new
    // list). This one pins it where the peer does NOT cooperate: the row names a
    // revision the message does not have, and the answer must be the peer's
    // refusal — never the list held for the old revision.
    const rig = await makeRig(options([message('m-1', '1001', [{ kind: 'text', text: 'x' }])]))
    const primed = rig.fake.readCallsFor('agent.parts.list').length

    // Prime with the REAL revision, so a fence-less lookup has something stale
    // to serve.
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(rig.fake.readCallsFor('agent.parts.list')).toHaveLength(primed + 1)
    expect(rig.fake.readCallsFor('agent.parts.list').at(-1)!['messageRevision']).toBe('1001')

    // Now the row names revision `0`, for BOTH messages-list requests the
    // read's own REVISION_EXPIRED retry will make.
    const zeroRow = {
      items: [{ messageId: 'm-1', revision: '0', role: 'assistant', partIds: ['m-1:0'], status: 'success' }],
      nextCursor: null,
    }
    rig.fake.scriptListPages('agent.messages.list', [zeroRow, zeroRow])

    const second = (await rig
      .call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
      .catch((error: unknown) => ({ error: String(error) }))) as { error?: string; messages?: unknown[] }
    // No stale list was served...
    expect(second.messages).toBeUndefined()
    expect(second.error).toMatch(/REVISION_EXPIRED|expired/i)
    // ...because the fence missed and a parts walk went out under `0`: the
    // entry held for `1001` was never reused for a row at another revision.
    const walked = rig.fake.readCallsFor('agent.parts.list')
    expect(walked.length).toBeGreaterThan(primed + 1)
    expect(walked.at(-1)!['messageRevision']).toBe('0')
  })

})
