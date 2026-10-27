import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import type { DeviceState } from '../../src/connection.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { registerCherryToolsWithEngine } from '../../src/tools.js'
import type { CherryToolDefinition, CherryToolsContext, CherryToolsDeps } from '../../src/tools.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions } from '../loopback/fakeCherry.js'

/**
 * The engine's SESSION CACHES over their whole life cycle — not just their
 * keying (that is `toolsCacheScope`): how they are BOUNDED, when they are
 * INVALIDATED, and what a failed delivery ack does to the subscription it rode.
 *
 * Three properties, one theme: a cache is memory the plugin keeps on the
 * peer's behalf. It must not grow without limit (v0.1.3 UltraReview P3-1), and
 * it must not outlive the evidence it was built from — a pairing the peer
 * refused, a device that was unpaired (P3-2). The residual window is real and
 * documented in `src/tools.ts`; these tests pin the parts that are decided.
 *
 * ITEM 3 lives here too, because it is the same channel: a failed delivery ack
 * is the peer telling us the subscription we rode is no longer usable, so the
 * session is re-ensured rather than left silently dead.
 */

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

const SESSION = {
  sessionId: 's-1',
  agentId: 'agent-1',
  workspaceId: 'ws-1',
  title: 'Hello',
  historyRevision: '1',
}

/** One session (`s-1`) at `revision`, plus the empty sessions a wait needs. */
function agentOptions(revision: string, extra: FakeCherryOptions['agent'] = {}): FakeCherryOptions {
  return {
    agent: {
      agents: [{ agentId: 'agent-1', name: 'Agent One' }],
      sessions: [
        { ...SESSION, historyRevision: revision },
        { ...SESSION, sessionId: 's-2', title: 'Second' },
        { ...SESSION, sessionId: 's-3', title: 'Third' },
        { ...SESSION, sessionId: 's-4', title: 'Fourth' },
      ],
      messages: [
        {
          messageId: `${revision}-assistant`,
          revision: '1',
          role: 'assistant',
          status: 'success',
          parts: [{ kind: 'text', text: `reply at ${revision}` }],
        },
      ],
      terminalMessage: {
        messageId: `${revision}-assistant`,
        revision: '1',
        role: 'assistant',
        status: 'success',
        parts: [],
      },
      interactions: [
        {
          interactionId: 'i-1',
          revision: '5',
          executionId: `exec-${revision}`,
          toolCallId: 'call-1',
          status: 'pending',
          summary: 'answer me',
          kind: 'decision',
          inputDigest: 'a'.repeat(64),
        },
      ],
      ...extra,
    },
  }
}

/**
 * A cache bound small enough to observe.
 *
 * The engine is the ONLY holder of the caches, and the production value
 * ({@link CACHE_ENTRIES_PER_DEVICE} = 256) needs 257 live sessions before it
 * evicts one — a loopback test would spend minutes proving what a bound of two
 * proves in four calls. Injected, exactly the way the other policy knobs are.
 */
const TINY_BOUND = 2

interface Rig {
  fake: FakeCherry
  store: DeviceStore
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  /** `agent.sessions.get` arrivals at the peer: a cache MISS costs one. */
  baselineReads(): number
  /** State transitions the client published, in order. */
  states(): DeviceState[]
  /** Lets the connection's backoff loop run one more attempt. */
  reconnect(): Promise<void>
  /** The assembly's `evict`: drop the pooled entry and close the connection. */
  evict(): Promise<void>
  /**
   * Drops the SOCKET but keeps the pooled `DeviceConnection`, so its own
   * supervisor re-establishes — the path that actually runs `authenticate`
   * again on the same instance.
   */
  dropLink(): Promise<void>
  /** How many `connection.authenticate` calls the peer has answered. */
  authenticateCount(): number
  /** The engine's remembered send bodies for one device, as commandIds. */
  rememberedCommandIds(deviceId: string): string[]
  /** Fill the body memory the way a long-lived process would (no wire call). */
  rememberCommandBody(deviceId: string, commandId: string): void
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

async function makeRig(
  options: FakeCherryOptions = {},
  engineOptions: { cacheEntriesPerDevice?: number; commandBodyEntriesPerDevice?: number } = {},
): Promise<Rig> {
  const fake = new FakeCherry({ rateLimitPerSecond: 100_000, ...options })
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-cache-lifecycle-'))
  const store = new DeviceStore(join(tmp, 'devices.json'))
  store.upsert({
    schemaVersion: 3,
    deviceId: 'dev-A',
    displayName: 'Desk Alpha',
    hosts: [host],
    security: { [host]: 'ws' as const },
    port,
    desktopIdentity,
    grants: ['agent'],
    enabled: true,
  })

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
      rateBudgetPerSecond: 100_000,
      // A loopback peer is back immediately; the production backoff would make
      // every offline assertion wait a second per attempt.
      backoffInitialMs: 20,
    })
    // The observation half only: the ENGINE's own invalidation rides the
    // `watchDeviceState` dep below, exactly as the assembly wires it.
    connection.onState((deviceState) => {
      seenStates.push(deviceState)
    })
    connections.set(deviceId, connection)
    return connection
  }

  const subsFn = (deviceId: string): SessionSubscriptions => {
    const existing = subscriptions.get(deviceId)
    if (existing !== undefined) return existing
    const connection = connect(deviceId)
    const created = new SessionSubscriptions(connection.rpc, { subscriptionsLimit: 8 })
    connection.rpc.onNotification((method, params) => created.handleNotification(method, params))
    subscriptions.set(deviceId, created)
    return created
  }

  const ctx = makeCtx()
  const deps: CherryToolsDeps = {
    store,
    connect,
    subs: subsFn,
    // THE SAME WIRING THE ASSEMBLY USES (`src/index.ts`): the engine subscribes
    // to THIS device's transitions through the connection's existing fan-out.
    watchDeviceState: (target, cb) => connections.get(target)?.onState(cb),
    pair: async () => {
      throw new Error('pairing is not exercised here')
    },
    evict: async (deviceId) => {
      const connection = connections.get(deviceId)
      connections.delete(deviceId)
      const layer = subscriptions.get(deviceId)
      subscriptions.delete(deviceId)
      await layer?.dispose()
      await connection?.close()
    },
  }
  const { engine } = registerCherryToolsWithEngine(ctx, deps, engineOptions)
  if (engine === undefined) throw new Error('the engine was not built')
  await connect('dev-A').connect()

  const tool = (name: string): CherryToolDefinition => {
    const found = ctx.definitions.find((definition) => definition.name === name)
    if (found === undefined) throw new Error(`tool ${name} is not registered`)
    return found
  }

  const rig: Rig = {
    fake,
    store,
    call: (name, args = {}) => tool(name).execute(args),
    baselineReads: () => fake.readCallsFor('agent.sessions.get').length,
    states: () => [...seenStates],
    reconnect: async () => {
      await connect('dev-A').connect()
    },
    evict: async () => {
      await deps.evict('dev-A')
    },
    dropLink: async () => {
      // The PEER drops the socket (a reset, not a graceful close): the client
      // classifies the loss, tears the link down, goes `offline` and — because
      // the connection is still the pooled one — backs off into a fresh
      // establishment on the SAME instance, which is what runs `authenticate`
      // again. This is the only path that reaches that call without a rebuild.
      if (fake.dropConnections() === 0) throw new Error('no live socket to drop')
    },
    authenticateCount: () => fake.authenticateCount,
    rememberedCommandIds: (deviceId) => engine.rememberedCommandIds(deviceId),
    rememberCommandBody: (deviceId, commandId) => engine.rememberCommandBodyForTest(deviceId, commandId),
    stop: async () => {
      for (const layer of subscriptions.values()) await layer.dispose()
      for (const connection of connections.values()) await connection.close()
      await fake.stop()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
  rigs.push(rig)
  return rig
}

/**
 * How many times the PEER was asked for a session baseline.
 *
 * The engine caches `idleRevision`, so a "warm" call costs zero of these and a
 * MISS costs exactly one. `agent.sessions.get` is also what `cherry_read` and
 * the terminal paths use, which is why this suite drives `cherry_send` only —
 * one caller, one question: did the cache answer, or did the peer?
 */
function idleRevisionReads(fake: FakeCherry): number {
  return fake.readCallsFor('agent.sessions.get').length
}

/** The `expectedIdleRevision` the peer actually received on its last send. */
function sentIdleRevision(fake: FakeCherry): string | undefined {
  return fake.commandCallsFor('agent.messages.send').at(-1)?.['expectedIdleRevision'] as string | undefined
}

/** One `cherry_send` that must be applied, so the cache path is what is exercised. */
async function send(rig: Rig, text: string): Promise<Record<string, unknown>> {
  return (await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text, wait: false })) as Record<
    string,
    unknown
  >
}

describe('v0.1.3 P3-1: the engine session caches are BOUNDED', () => {
  it('C1a a warm cache answers without a baseline read', async () => {
    const rig = await makeRig(agentOptions('100'))
    expect((await send(rig, 'one'))['status']).toBe('applied')
    expect(sentIdleRevision(rig.fake)).toBe('100')
    const warm = rig.baselineReads()
    expect((await send(rig, 'two'))['status']).toBe('applied')
    expect(rig.baselineReads()).toBe(warm)
  })

  it('C1b a cache at its bound evicts the OLDEST entry; the next call re-reads and stays correct', async () => {
    // The production bound (256 per device per cache) exists so a long-lived
    // process cannot accumulate one entry per session it has ever touched. The
    // observable consequence at a bound of TWO is that the FIRST session's
    // entry is gone once a second session was cached for the same device: the
    // next send for it is a MISS — one `sessions.get`, then the peer's current
    // value — instead of the stale `100` the cache used to hold.
    //
    // ONE send per session, because every send writes exactly one entry and
    // nothing else here touches the cache. With the bound at two, the entry is
    // KEPT (s-2 fills the second slot; the bound is reached, not exceeded).
    // With a bound of ONE the second session evicts the first — so the pair of
    // assertions below is what pins the bound's arithmetic rather than its
    // mere existence.
    const rig = await makeRig(agentOptions('100'), { cacheEntriesPerDevice: TINY_BOUND })
    expect((await send(rig, 'prime s-1'))['status']).toBe('applied')
    expect(sentIdleRevision(rig.fake)).toBe('100')
    // s-2 takes the second slot: s-1 must SURVIVE at a bound of two.
    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-2', text: 'hello s-2', wait: false })
    const warm = idleRevisionReads(rig.fake)
    expect((await send(rig, 'warm'))['status']).toBe('applied')
    expect(idleRevisionReads(rig.fake)).toBe(warm)
    expect(sentIdleRevision(rig.fake)).toBe('100')

    // A THIRD session cannot fit: the OLDEST (s-1) goes, and the peer's newer
    // revision is what the next send quotes.
    rig.fake.setSessionRevision('s-1', '200')
    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-3', text: 'hello s-3', wait: false })
    const before = idleRevisionReads(rig.fake)
    expect((await send(rig, 'after eviction'))['status']).toBe('applied')
    // EVERY attempt of the last send, selected by its text: with the entry
    // evicted there is exactly ONE, quoting the peer's current revision. A
    // surviving stale entry would show a refused `100` first and a healed
    // `200` after it — the self-heal would otherwise hide the miss.
    const lastSend = rig.fake
      .commandCallsFor('agent.messages.send')
      .filter((call) => call['text'] === 'after eviction')
      .map((call) => call['expectedIdleRevision'])
    expect(lastSend).toEqual(['200'])
    expect(idleRevisionReads(rig.fake)).toBe(before + 1)
  })
})

describe('v0.1.3 P3-2: a pairing that the peer refused invalidates the caches', () => {
  it('C1c the remembered send bodies are BOUNDED per device (FIFO), and only a PAIRING teardown drops them', async () => {
    // Issue #115's memory, through the SAME two assertions every other engine
    // cache gets — bounded, and dropped at the invalidation seam — with one
    // crucial difference. The read caches go on ANY `offline`; the send bodies
    // go only when the PAIRING is invalidated (unpair, identity-mismatch),
    // because what they replay against — the peer's command ledger — survives a
    // reconnect, and the body is the only local copy of the bytes that ledger
    // will accept.
    //
    // The entries are filled through the engine's own store path (a retry
    // window after a burst of lost replies would), and the bound is driven to
    // TINY_BOUND so the arithmetic is observable.
    const rig = await makeRig(agentOptions('100'), {
      cacheEntriesPerDevice: TINY_BOUND,
      commandBodyEntriesPerDevice: 2,
    })

    rig.rememberCommandBody('dev-A', 'cmd-1')
    rig.rememberCommandBody('dev-A', 'cmd-2')
    // At the bound, nothing has been evicted yet: the bound is reached, not
    // exceeded.
    expect(rig.rememberedCommandIds('dev-A')).toEqual(['cmd-1', 'cmd-2'])

    // The THIRD id evicts the OLDEST (cmd-1), not some other one: FIFO over the
    // insert order.
    rig.rememberCommandBody('dev-A', 'cmd-3')
    expect(rig.rememberedCommandIds('dev-A')).toEqual(['cmd-2', 'cmd-3'])

    // A REFRESH keeps its insertion position — it is a rewrite, not a use — so
    // the policy stays insert-order rather than silently becoming LRU.
    rig.rememberCommandBody('dev-A', 'cmd-2')
    expect(rig.rememberedCommandIds('dev-A')).toEqual(['cmd-2', 'cmd-3'])

    // THE WIRING: a real `cherry_send` under a CALLER-SUPPLIED commandId is what
    // fills this memory — not only the test seam above.
    const receipt = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'wiring',
      commandId: 'cmd-wiring',
      wait: false,
    })) as { status?: string }
    expect(receipt.status).toBe('applied')
    expect(rig.rememberedCommandIds('dev-A')).toContain('cmd-wiring')

    // AN ORDINARY `offline` (the peer drops the link; the connection goes down
    // and comes back) drops the OTHER caches — and KEEPS these.
    await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })
    await rig.dropLink()
    await vi.waitFor(() => expect(rig.states()).toContain('offline'), { timeout: 5_000 })
    expect(rig.rememberedCommandIds('dev-A')).toEqual(['cmd-3', 'cmd-wiring'])

    // The bound is still in force (cmd-wiring's insert EVICTED cmd-2; cmd-3 is
    // now the oldest of two).
    // ...and a PAIRING teardown (`cherry_unpair`, which resolves the record
    // before the store entry is gone) drops them.
    const unpaired = (await rig.call('cherry_unpair', { device: 'dev-A' })) as { removed?: boolean }
    expect(unpaired.removed).toBe(true)
    expect(rig.rememberedCommandIds('dev-A')).toEqual([])
  }, 30_000)

  it('C2a a rejected authenticate (GRANT_REVOKED) clears them: the next send re-reads the desktop', async () => {
    // The window this closes: the caches survive ordinary reconnects by design,
    // so a device whose grant was revoked — and then re-paired, possibly against
    // a different desktop behind the same id — would keep quoting snapshots
    // taken under the old pairing. `authenticate` refused with GRANT_REVOKED is
    // the peer's own verdict that the pairing is void, and the connection turns
    // it into `offline`; that transition is the invalidation trigger.
    //
    // THE REFUSAL HAS TO BE THE ONE THAT FIRED, so this test drops the SOCKET
    // and leaves the pooled connection in charge: its supervisor re-establishes
    // on the same instance and that establishment is what calls `authenticate`.
    // (Closing the connection instead would go `offline` on its own, and the
    // armed failure would never be reached — an `offline` from the wrong cause.)
    const rig = await makeRig(agentOptions('100'))
    expect((await send(rig, 'prime'))['status']).toBe('applied')
    expect(sentIdleRevision(rig.fake)).toBe('100')

    // WARM: the cached `100` is quoted without asking the peer.
    const warm = idleRevisionReads(rig.fake)
    expect((await send(rig, 'warm'))['status']).toBe('applied')
    expect(idleRevisionReads(rig.fake)).toBe(warm)

    // The desktop revokes the grant; the peer moves to a DIFFERENT revision at
    // the same moment, so a stale entry would be directly observable in what
    // the next send quotes.
    rig.fake.setSessionRevision('s-1', '200')
    rig.fake.setAuthenticateFailure({ reason: 'GRANT_REVOKED', message: 'grant revoked' })
    const authenticatedBefore = rig.authenticateCount()
    await rig.dropLink()

    // The refusal really happened, and the state it produced is the trigger.
    await vi.waitFor(() => expect(rig.authenticateCount()).toBeGreaterThan(authenticatedBefore), {
      timeout: 3_000,
    })
    await vi.waitFor(() => expect(rig.states().at(-1)).toBe('offline'), { timeout: 3_000 })

    // A REJECTED authenticate is terminal for the lifecycle (no backoff retry:
    // only a fresh pairing makes it good again), so this rig plays the operator
    // re-granting the device and starting it once more. The caches are what is
    // under test: after this, the next send must go to the desktop rather than
    // to a snapshot taken before the refusal.
    rig.fake.setAuthenticateFailure(undefined)
    await rig.reconnect()
    await vi.waitFor(() => expect(rig.states().at(-1)).toBe('connected'), { timeout: 5_000 })
    const afterRecovery = idleRevisionReads(rig.fake)
    expect((await send(rig, 'after the refusal'))['status']).toBe('applied')
    // THE FIRST ATTEMPT of THAT send — selected by its text, not by position,
    // because the self-heal appends a SECOND attempt under a fresh commandId.
    // A surviving stale `100` would appear as this attempt; a cleared cache
    // makes it `200` straight away.
    const afterRefusal = rig.fake
      .commandCallsFor('agent.messages.send')
      .filter((call) => call['text'] === 'after the refusal')
      .map((call) => call['expectedIdleRevision'])
    expect(afterRefusal).toEqual(['200'])
    // ...and the cache MISS that produced it: exactly one peer round trip.
    expect(idleRevisionReads(rig.fake)).toBe(afterRecovery + 1)
  }, 30_000)
})

describe('v0.1.3 P3-2: the watch is bound to the CONNECTION, not the device', () => {
  it('C2b a re-built connection is watched afresh: its own offline clears the caches', async () => {
    // THE INVARIANT the WeakSet exists for. `evict` drops the pooled connection
    // and the next `connect()` builds a NEW `DeviceConnection`; a guard keyed
    // on the DEVICE id would see "dev-A already watched" and never join the new
    // instance's state channel. Everything the engine does would look correct
    // until the FIRST transition that matters lands on the live connection.
    //
    // The sequence is the production one: evict (pool entry gone) → the next
    // tool call re-resolves and rebuilds → the rebuilt connection itself goes
    // `offline` (here: its authenticate is refused) → the caches must be gone.
    const rig = await makeRig(agentOptions('100'))
    expect((await send(rig, 'prime'))['status']).toBe('applied')
    expect(sentIdleRevision(rig.fake)).toBe('100')

    // EVICT: the pooled instance is closed and dropped.
    await rig.evict()
    await vi.waitFor(() => expect(rig.states()).toContain('offline'), { timeout: 3_000 })

    // The peer moves on while the device is away, and the pool rebuilds the
    // connection from the CURRENT record — a NEW `DeviceConnection` instance,
    // which is exactly where the engine must join the state channel afresh.
    rig.fake.setSessionRevision('s-1', '200')
    await rig.reconnect()
    await vi.waitFor(() => expect(rig.states().at(-1)).toBe('connected'), { timeout: 5_000 })

    // The cache was cleared by the OLD instance's offline already; what this
    // test needs is a live entry on the NEW one, primed through the same tool
    // path the operator uses.
    const primed = idleRevisionReads(rig.fake)
    expect((await send(rig, 'on the rebuilt connection'))['status']).toBe('applied')
    expect(idleRevisionReads(rig.fake)).toBe(primed + 1)
    // WARM on the NEW connection: the entry is served from memory.
    const warm = idleRevisionReads(rig.fake)
    expect((await send(rig, 'warm on the rebuilt connection'))['status']).toBe('applied')
    expect(idleRevisionReads(rig.fake)).toBe(warm)

    // NOW the rebuilt connection goes offline ITSELF. If the watch stayed on
    // the evicted instance this transition is never seen and the entry below
    // survives.
    rig.fake.setSessionRevision('s-1', '300')
    rig.fake.setAuthenticateFailure({ reason: 'GRANT_REVOKED', message: 'grant revoked' })
    const authenticatedBefore = rig.authenticateCount()
    await rig.dropLink()
    await vi.waitFor(() => expect(rig.authenticateCount()).toBeGreaterThan(authenticatedBefore), {
      timeout: 3_000,
    })
    await vi.waitFor(() => expect(rig.states().at(-1)).toBe('offline'), { timeout: 3_000 })

    rig.fake.setAuthenticateFailure(undefined)
    await rig.reconnect()
    await vi.waitFor(() => expect(rig.states().at(-1)).toBe('connected'), { timeout: 5_000 })
    const afterRecovery = idleRevisionReads(rig.fake)
    expect((await send(rig, 'after the rebuilt connection died'))['status']).toBe('applied')
    const after = rig.fake
      .commandCallsFor('agent.messages.send')
      .filter((call) => call['text'] === 'after the rebuilt connection died')
      .map((call) => call['expectedIdleRevision'])
    expect(after).toEqual(['300'])
    expect(idleRevisionReads(rig.fake)).toBe(afterRecovery + 1)
  }, 30_000)
})

describe('v0.1.3 P3-3: a failed delivery ack re-ensures the session', () => {
  it('C3 the session is rebuilt when the ack is refused, and the events are still delivered', async () => {
    // ACK AFTER DELIVERY stays the rule: the caller already holds the events, so
    // a failing ack must never swallow them. What changed is that the failure is
    // no longer only a log line — the peer refusing the ack says the
    // subscription it names is not usable, so the session is rebuilt in the
    // background instead of being left to fail on the NEXT call.
    const rig = await makeRig(agentOptions('100'))
    // One delivery first: the session is subscribed and its baseline acked.
    await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })
    await vi.waitFor(() => expect(rig.fake.ackCalls.length).toBeGreaterThan(0), { timeout: 3_000 })
    const subscribesBefore = rig.fake.subscribeCalls.length

    // Every ack from now on is the peer's CONFLICT.
    rig.fake.refuseAcks({ reason: 'CONFLICT', message: 'Cursor is outside the delivered window' })

    const delivered = (await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })) as {
      events?: unknown[]
      nextCursor?: unknown
    }
    // The delivery is NOT swallowed by the failed ack.
    expect(Array.isArray(delivered.events)).toBe(true)
    expect(delivered.nextCursor).toBeDefined()
    expect(rig.fake.ackCalls.length).toBeGreaterThan(1)

    // ...and the subscription is rebuilt: the re-ensure is a real subscribe.
    await vi.waitFor(() => expect(rig.fake.subscribeCalls.length).toBeGreaterThan(subscribesBefore), {
      timeout: 3_000,
    })
  }, 30_000)
})
