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
import type { FakeCherryOptions, FakeMessageRecord } from '../loopback/fakeCherry.js'

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

async function makeRig(options: FakeCherryOptions = {}, rigOptions: RigOptions = {}): Promise<Rig> {
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
function partsPageBytes(messageId: string, revision: string, partCount: number): number {
  return JSON.stringify(
    Array.from({ length: partCount }, (_unused, index) => ({
      partId: `${messageId}:${index}`,
      kind: 'text',
      revision,
      content: { text: 'x' },
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
    //   m-1 whose id is 200 characters   → ~275 bytes  (over the cap)
    //   m-2 / m-3, short ids             →  ~75 bytes  (under it)
    //
    // m-1's raw TEXT is irrelevant to its entry size — 2 KiB of inline text is
    // ONE record exactly like a 6-byte one. That is the point of the new shape:
    // descriptors, not text. (The ids are made deliberately different in
    // LENGTH, because the record size is what the cap judges: two ids of equal
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
    // The sizes are the RECORD sizes, recomputed rather than assumed: an edit
    // that changes a part's TEXT does not change its record size at all (the
    // record is a descriptor), so the discriminator has to be an edit that
    // changes the record SHAPE — here m-2 gains a part.
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
    // placed strictly between the two PEAKS (each total plus the incoming
    // entry): enough room for an honest refresh, none for a drifted one.
    const steady = sizeM1 + sizeM2After + sizeM3
    const drifted = sizeM1 + sizeM2Before + sizeM2After + sizeM3
    const honestPeak = steady + sizeM3
    const driftedPeak = drifted + sizeM3
    expect(drifted).toBeGreaterThan(steady)
    const budget = Math.max(driftedPeak - 1, honestPeak)
    expect(budget).toBeGreaterThanOrEqual(honestPeak)
    expect(budget).toBeLessThan(driftedPeak)
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
    // again is m-1, the OLDEST. An LRU-shaped policy would have dropped the
    // NEWEST (m-3) instead and served m-1 from memory.
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
    // FIRST re-walked message is m-1, the OLDEST — never m-3, the newest, which
    // is what an LRU-shaped policy would have dropped. Nothing beyond that first
    // step is pinned: at this budget m-1 is the WIDEST entry, so its re-entry
    // cannot fit beside the two survivors and FIFO evicts more of them. That
    // cascade is a consequence of the sizes, not the policy claim.
    const reread = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    expect(reread.messages.map((entry) => entry.messageId)).toEqual([longId, 'm-2', 'm-3'])
    const rewaked = walkedIds(rig).slice(3)
    expect(rewaked[0]).toBe(longId)
    // EVERY eviction was FIFO and named once per insert — device and count only.
    expect(evictionWarnings().length).toBeGreaterThanOrEqual(1)
    expect(evictionWarnings()).toHaveLength(4)
    for (const line of evictionWarnings()) expect(line).toMatch(/evicted 1 oldest entry/)
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
