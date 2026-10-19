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
 * Issue #15: the PROJECTED-MESSAGE read cache.
 *
 * Every face that shows messages — `cherry_read` and the terminal/timeout/idle
 * aggregates — projects each message through ONE method (`#projectMessage`):
 * one `agent.parts.list` per message, plus one `agent.content.read` walk per
 * externalized `{ref}`. An agent that does send → wait → read in a loop paid
 * every one of those RPCs AGAIN on every call, for history that had not moved.
 *
 * The contract this suite pins:
 *
 *  - an unchanged INLINE message is served from the cache, so a repeated read
 *    costs NO `agent.parts.list` and NO `agent.content.read` RPCs (T1) — and
 *    the terminal face shares that cache (T2);
 *  - the cache is FENCED by the peer's own revision rule: a moved revision is a
 *    miss, whether the peer really moved (T3) or the row merely names another
 *    revision than the held entry (T8). The peer refuses a stale
 *    `messageRevision` with `REVISION_EXPIRED`, so a projection keyed by the
 *    same revision is exactly what a fresh parts walk would have returned;
 *    THAT is the staleness class the cache inherits. It inherits no others: see
 *    the next point, which is where the fence does NOT reach;
 *  - a message holding a `{ref}`-resolved part is NEVER held (T1b). The revision
 *    fence covers a message's parts RECORDS, not the content store behind a
 *    ref, and that content is digest-verified on every read — so the cache must
 *    not short-circuit the verification. The trade-off is stated rather than
 *    hidden: ref-bearing messages cost their round trips every time;
 *  - a message that is INCOMPLETE is never held, so a transient failure cannot
 *    become a permanent one (T4);
 *  - both bounds hold: one entry above `messageCacheEntryBytes` is served fresh
 *    (T5), the per-device byte budget evicts in INSERTION order (T6), and a
 *    REFRESH of an edited message corrects the total instead of inflating it
 *    (T5b);
 *  - invalidation rides the existing seam: a device that goes offline drops its
 *    message entries with its session caches (T7).
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
 * one of these proves BOTH walks (parts and content) were skipped on a hit.
 */
const BIG_TEXT = 'R'.repeat(30 * 1024)

function message(messageId: string, revision: string, parts: FakeMessageRecord['parts']): FakeMessageRecord {
  return { messageId, revision, role: 'assistant', status: 'success', parts }
}

/**
 * Three INLINE-ONLY messages. No part is externalized, because a `{ref}` part
 * makes its message uncacheable by design (see the ref test below) — the cache
 * behaviour these scenarios exercise needs messages the cache may hold.
 */
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

describe('issue #15: the projected-message read cache', () => {
  it('T1 a second read of an unchanged session costs ZERO parts and content RPCs', async () => {
    // THE FEATURE. Before the cache, `cherry_read` re-walked every message's
    // parts (and every `{ref}`'s content) on EVERY call — an agent that does
    // send → wait → read paid for the same immutable history each round.
    const rig = await makeRig(options(healthyHistory()))

    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    // The first read really walked: one parts page per message.
    expect(partsCalls(rig)).toBe(3)
    expect(first.messages.map((entry) => entry.messageId)).toEqual(['m-1', 'm-2', 'm-3'])

    const second = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult

    // NO projection RPCs on the second read: not one parts page, not one
    // content read.
    expect(partsCalls(rig)).toBe(3)
    expect(contentCalls(rig)).toBe(0)
    // ...and the answer is IDENTICAL, so the saving did not change the data.
    expect(second).toEqual(first)
    // The cache's internal part marker never reaches the caller.
    expect(JSON.stringify(second)).not.toContain('fromRef')
  })

  it('T1b a message holding a `{ref}` part is NOT cached: integrity outranks the round trips', async () => {
    // The peer's revision fence covers a message's PARTS RECORDS, not the
    // CONTENT STORE behind a `{ref}`. Content is verified (sha256) when it is
    // read, so serving a projection made earlier would skip that verification
    // for bytes that may have changed since. Such a message is therefore
    // walked again every time — and any tampering still fails the read.
    const rig = await makeRig(options(refHistory()))

    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    expect(first.messages[0]!.parts[1]!.content).toBe(BIG_TEXT)
    // The cache's internal ref marker is bookkeeping, not a fact about the
    // message: it must never reach the caller.
    expect(JSON.stringify(first)).not.toContain('fromRef')
    const partsAfterFirst = partsCalls(rig)
    const contentsAfterFirst = contentCalls(rig)
    expect(partsAfterFirst).toBe(3)
    expect(contentsAfterFirst).toBeGreaterThan(0)

    // The ref-bearing message is walked again; its inline-only siblings are not.
    const second = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    expect(second).toEqual(first)
    expect(partsCalls(rig)).toBe(partsAfterFirst + 1)
    expect(contentCalls(rig)).toBeGreaterThan(contentsAfterFirst)
    const walked = rig.fake.readCallsFor('agent.parts.list').map((call) => call['messageId'])
    expect(walked.slice(partsAfterFirst)).toEqual(['m-1'])

    // The guarantee this protects: corrupted bytes behind an unchanged
    // revision still fail the read loudly.
    rig.fake.tamperContent('m-1:1', '1001')
    await expect(rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })).rejects.toThrow(
      /sha256|digest|integrity/i,
    )
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
    // Content still arrives — from the cache, not the peer.
    expect(waited.messages[0]!.parts[1]!.content).toBe('second part')
    expect(partsCalls(rig)).toBe(afterRead)
  })

  it('T3 the revision fence is real: a moved revision re-fetches and the new projection is returned', async () => {
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
    const edited = second.messages.find((entry) => entry.messageId === 'm-2')!
    expect(edited.revision).toBe('2002')
    expect(edited.parts[0]!.content).toBe('second, edited')
  })

  it('T4 an incomplete message is never cached: the next read retries its parts walk', async () => {
    // A transient failure must not become a permanent one. Here the failure is
    // a parts walk the circuit-breaker stops: m-1 is `incomplete` (short part
    // list) and must NOT be held, while its complete siblings are. A REF-based
    // incompleteness would not test this — a ref-bearing message is never
    // cached for a different reason (T1b).
    const parts = Array.from({ length: 10 }, (_unused, index) => ({
      kind: 'text' as const,
      text: `p-${index}`,
    }))
    const rig = await makeRig(
      options(healthyHistory(), { maxPageSize: 4 }),
      // Drive the breaker low enough to trip on m-1's second page.
      { engine: { partsSafetyBound: 6 } },
    )
    // ...and make m-1 the multi-page message.
    rig.fake.setAgentMessages([
      message('m-1', '1001', parts),
      message('m-2', '1002', [{ kind: 'text', text: 'second' }]),
      message('m-3', '1003', [{ kind: 'text', text: 'third' }]),
    ])

    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult & {
      messages: Array<{ messageId: string; incomplete?: true; partsTruncated?: string; parts: unknown[] }>
    }
    expect(first.messages[0]!.messageId).toBe('m-1')
    expect(first.messages[0]!.incomplete).toBe(true)
    expect(first.messages[0]!.partsTruncated).toBe('safety-bound')
    const afterFirst = partsCalls(rig)

    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    // m-1 is walked again (it was incomplete and never held); m-2 and m-3 are
    // hits. One re-walk = its two pages, one parts page each for its siblings.
    const walked = rig.fake.readCallsFor('agent.parts.list').map((call) => call['messageId'])
    expect(walked.slice(afterFirst)).toEqual(['m-1', 'm-1'])
    expect(partsCalls(rig)).toBe(afterFirst + 2)
  })

  it('T5 the per-entry cap: a projection above messageCacheEntryBytes is served fresh every time', async () => {
    // A 2 KiB INLINE part needs no ref (so the message is cacheable at all),
    // and its projection (~2.2 KiB) is far above a 512-byte entry cap while its
    // siblings' ~175 bytes are below it — the cap selects, it does not blanket.
    const rig = await makeRig(
      options([
        message('m-1', '1001', [{ kind: 'text', text: 'I'.repeat(2048) }]),
        message('m-2', '1002', [{ kind: 'text', text: 'second' }]),
        message('m-3', '1003', [{ kind: 'text', text: 'third' }]),
      ]),
      { engine: { messageCacheEntryBytes: 512, messageCacheBytesPerDevice: 8 * 1024 * 1024 } },
    )

    const first = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    expect(partsCalls(rig)).toBe(3)
    expect(first.messages[0]!.parts[0]!.content).toHaveLength(2048)

    // Only the over-cap message is walked again; its siblings are hits.
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(partsCalls(rig)).toBe(4)
    const walked = rig.fake.readCallsFor('agent.parts.list').map((call) => call['messageId'])
    expect(walked.slice(3)).toEqual(['m-1'])
    // It is never held, so a THIRD read walks it again — exactly once.
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(partsCalls(rig)).toBe(5)
  })

  it('T5b a REFRESH replaces the entry in place: the device total is corrected, not doubled', async () => {
    // The accounting hazard: a revision change re-projects the SAME key. If the
    // refresh ADDED the new size without subtracting the old one, the device
    // total would drift upward, and the NEXT insert would evict a survivor that
    // plainly fits.
    //
    // Measured projections: m-1 174, m-2 175 → 194 after the edit, m-3 174.
    // Budget 549 — room for all three (368 + 174 = 542):
    //   correct  174 + 175 - 175 + 194 = 368, + 174 = 542 ≤ 549 → nothing evicted
    //   drifted  174 + 175 + 194 = 543 already, + 174 = 717 → the m-3 insert is
    //            forced to evict a survivor that fits.
    // So the discriminator is the INSERT AFTER the refresh, not a plain re-read
    // (a re-read of unchanged messages is all hits and never consults the total).
    const history = [
      message('m-1', '1001', [{ kind: 'text', text: 'first' }]),
      message('m-2', '1002', [{ kind: 'text', text: 'second' }]),
    ]
    const rig = await makeRig(options(structuredClone(history)), {
      engine: { messageCacheBytesPerDevice: 549 },
    })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(partsCalls(rig)).toBe(2)
    expect(evictionWarnings()).toHaveLength(0)

    // The desktop EDITS m-2: same id, new revision, longer text.
    rig.fake.setAgentMessages([
      message('m-1', '1001', [{ kind: 'text', text: 'first' }]),
      message('m-2', '2002', [{ kind: 'text', text: 'second, edited and longer' }]),
    ])
    const edited = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    expect(edited.messages[1]!.revision).toBe('2002')
    expect(partsCalls(rig)).toBe(3)
    expect(evictionWarnings()).toHaveLength(0)

    // A THIRD message arrives: it fits beside the two held entries only if the
    // refresh kept the total honest.
    rig.fake.setAgentMessages([
      message('m-1', '1001', [{ kind: 'text', text: 'first' }]),
      message('m-2', '2002', [{ kind: 'text', text: 'second, edited and longer' }]),
      message('m-3', '1003', [{ kind: 'text', text: 'third' }]),
    ])
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(evictionWarnings()).toEqual([])
    expect(partsCalls(rig)).toBe(4)

    // All three are held: a fourth read walks nothing.
    await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(partsCalls(rig)).toBe(4)
  })

  it('T6 the per-device byte budget evicts the OLDEST entry first, and warns once without a message id', async () => {
    // THREE ~174-byte messages (one part each) and a budget of 364: room for
    // exactly TWO. The insertion order is (`m-1`, `m-2`, `m-3`), and every
    // insert makes room BEFORE it writes, so the device never passes its
    // budget — not even by the entry being written:
    //
    //   insert m-1 (174)  before 0    → 174
    //   insert m-2 (175)  before 174  → 349        (two fit, nothing evicted)
    //   insert m-3 (174)  349 + 174 > 364 → evict the OLDEST (m-1) → 175 + 174 = 349
    //
    // The re-read then proves WHICH entry went: m-1 is a MISS (re-walked) while
    // m-2 and m-3 are HITS. An LRU-shaped policy would have evicted the NEWEST
    // (m-3) and served m-1 from memory, which this test would catch.
    const history = [
      message('m-1', '1001', [{ kind: 'text', text: 'first' }]),
      message('m-2', '1002', [{ kind: 'text', text: 'second' }]),
      message('m-3', '1003', [{ kind: 'text', text: 'third' }]),
    ]
    // CONTROL: 174 + 175 + 174 = 523 bytes all fit under 1 KiB, so the second
    // read is all hits and nothing was evicted.
    const control = await makeRig(options(structuredClone(history)), {
      engine: { messageCacheBytesPerDevice: 1024 },
    })
    await control.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    await control.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })
    expect(partsCalls(control)).toBe(3)
    expect(evictionWarnings()).toHaveLength(0)

    const rig = await makeRig(options(structuredClone(history)), {
      engine: { messageCacheBytesPerDevice: 364 },
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
      for (const id of ['m-1', 'm-2', 'm-3']) expect(line).not.toContain(id)
      expect(line).not.toMatch(/first|second|third/)
    }

    // WHICH entry went, read off the WIRE rather than inferred: the oldest
    // (m-1) is the one that must be re-walked. At this budget the re-walk then
    // cascades — m-1's re-entry evicts m-2 (now the oldest), whose re-entry
    // evicts m-3 — so all three are walked again, each eviction FIFO and each
    // named only by the device and the count.
    const reread = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-1' })) as ReadResult
    expect(reread.messages.map((entry) => entry.messageId)).toEqual(['m-1', 'm-2', 'm-3'])
    expect(partsCalls(rig)).toBe(6)
    const walked = rig.fake.readCallsFor('agent.parts.list').map((call) => call['messageId'])
    // The FIRST re-walked message is the one the budget evicted: m-1, the
    // oldest — never m-3, the newest.
    expect(walked.slice(3)).toEqual(['m-1', 'm-2', 'm-3'])
    expect(evictionWarnings()).toHaveLength(4)
    for (const line of evictionWarnings()) expect(line).toMatch(/evicted 1 oldest entry/)
  })

  it('T7 reaching `offline` drops the device\'s message entries with its session caches', async () => {
    // `#watchConnection` routes `offline` / `identity-mismatch` into
    // `#forgetDevice`; the new cache must ride the same seam, or a re-paired
    // device could inherit content read under the previous pairing.
    //
    // WHAT THAT SEAM ACTUALLY FIRES ON, stated here because it is broader than
    // "revoked grant": an ordinary LINK LOSS also goes `offline` (the
    // connection's `#loseLink` calls `#setState('offline')` before backing off
    // and re-establishing), so a plain network blip drops the message entries
    // too. That is the documented cost of the seam — one re-read per session on
    // reuse — and not something this cache is entitled to narrow.
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

  it('T8 a revision change is a MISS even when the stale projection is already held', async () => {
    // The EMPTY revision itself cannot reach a projection through the public
    // face: `messageRevision` is a strict `decimal`, so a `''` walk is refused
    // by the protocol before the peer answers, and the projection that failure
    // builds never exists to be stored. What the face CAN show is the fence's
    // boundary, which is the same rule the empty case needs: an entry under
    // revision A must never be served for a row at revision B.
    //
    // T3 already pins that against the PEER moving (new revision, new text).
    // This one pins it where the peer does NOT cooperate: the row names a
    // revision the message does not have, and the answer must be the peer's
    // refusal — never the projection held for the old revision.
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
    // No stale projection was served...
    expect(second.messages).toBeUndefined()
    expect(second.error).toMatch(/REVISION_EXPIRED|expired/i)
    // ...because the fence missed and a parts walk went out under `0`: the
    // entry held for `1001` was never reused for a row at another revision.
    const walked = rig.fake.readCallsFor('agent.parts.list')
    expect(walked.length).toBeGreaterThan(primed + 1)
    expect(walked.at(-1)!['messageRevision']).toBe('0')
  })

})
