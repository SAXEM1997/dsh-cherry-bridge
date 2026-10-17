import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ComponentLogger, Logger } from '@libp2p/interface'
import { connectSecureChannel, createDeviceIdentity, RemoteSocketStream } from '@cherrystudio/remote-transport'
import type { AgentCursor } from '@cherrystudio/remote-protocol/agent'
import { JsonRpcClient } from '../../src/rpc/jsonRpcClient.js'
import { toRemoteSocket } from '../../src/rpc/wsAdapter.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions } from '../loopback/fakeCherry.js'

/**
 * Task 7 integration suite: `SessionSubscriptions` against a real loopback
 * Noise-XX fake desktop. Test numbering ①-⑪ mirrors the task brief's Step 1
 * scenarios; each title carries its number and every bolded sub-assertion of
 * the brief has its own explicit expectation.
 *
 * The harness (`tests/loopback/fakeCherry.ts`) models the peer's agent face on
 * the REAL implementation read from `_research/cherry-studio/src/main/services/
 * remoteAccess/agentSubscriptions.ts`: the same CONFLICT-on-duplicate-subscribe,
 * the same RESOURCE_EXHAUSTED cap, the same prepared-lease CHECKPOINT_EXPIRED
 * rule, and the same three-field `appliedCursor` equality check.
 */

interface Rig {
  fake: FakeCherry
  subs: SessionSubscriptions
  client: JsonRpcClient
  /** Ordered method names the peer actually received. */
  sequence: () => readonly string[]
}

const rigs: Array<{ stop: () => Promise<void> }> = []
let consoleWarn: ReturnType<typeof vi.fn>
let consoleInfo: ReturnType<typeof vi.fn>

beforeEach(() => {
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.stop()
  vi.restoreAllMocks()
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const noop = (): void => {}

/** A callable silent libp2p logger, the same shape the other suites use. */
function makeLogger(name: string): Logger {
  const log = (() => {}) as unknown as Logger
  log.error = noop
  log.trace = noop
  log.enabled = false
  log.newScope = (scope: string) => makeLogger(`${name}:${scope}`)
  return log
}

const componentLogger: ComponentLogger = { forComponent: (name: string) => makeLogger(name) }

async function waitFor(predicate: () => boolean, timeoutMs = 3_000, what = 'condition'): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`)
    await sleep(5)
  }
}

/**
 * A raw connected client driven straight through the loopback channel. The
 * subscriptions layer consumes a `JsonRpcClient` and receives notifications
 * from its own read loop (Task 10 routes `rpc.onNotification` into
 * `handleNotification`), so the rig wires exactly that route.
 */
async function makeRig(
  options: FakeCherryOptions = {},
  opts: { subscriptionsLimit?: number; perSessionCacheBytes?: number; checkpointMs?: number } = {},
): Promise<Rig> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId

  const { connectSecureChannel, RemoteSocketStream } = await import('@cherrystudio/remote-transport')
  const { WebSocket } = await import('ws')
  const socket = new WebSocket(`ws://${host}:${port}/remote`)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  const controller = new AbortController()
  const stream = new RemoteSocketStream(toRemoteSocket(socket), componentLogger.forComponent('client'), 'outbound')
  const channel = await connectSecureChannel(stream, {
    identity,
    remoteIdentity: desktopIdentity,
    logger: componentLogger,
    protocolVersions: [1],
    signal: controller.signal,
  })
  const client = new JsonRpcClient(channel)

  const subs = new SessionSubscriptions(client, {
    subscriptionsLimit: opts.subscriptionsLimit ?? (options.agent?.subscriptionLimit ?? 8),
    ...(opts.perSessionCacheBytes === undefined ? {} : { perSessionCacheBytes: opts.perSessionCacheBytes }),
    ...(opts.checkpointMs === undefined ? {} : { checkpointMs: opts.checkpointMs }),
  })
  client.onNotification((method, params) => subs.handleNotification(method, params))

  rigs.push({
    stop: async () => {
      await subs.dispose?.()
      client.dispose()
      void channel.close().catch(() => {})
      socket.close()
      await fake.stop()
    },
  })
  return {
    fake,
    subs,
    client,
    sequence: () => fake.agentCallSequence,
  }
}

function cursor(sessionId: string, seq: number, streamEpoch = 'epoch-1'): AgentCursor {
  return { sessionId, streamEpoch, seq: String(seq) }
}

describe('SessionSubscriptions over a real loopback channel', () => {
  it('① ensures a subscription, caches agent.events notifications, and reads incrementally from a cursor', async () => {
    const rig = await makeRig()
    await rig.subs.ensure('s1')

    // The peer actually received one subscribe with no cursor.
    expect(rig.fake.subscribeCalls).toHaveLength(1)
    expect(rig.fake.subscribeCalls[0]!.sessionId).toBe('s1')
    expect(rig.fake.subscribeCalls[0]!.cursor).toBeUndefined()

    // activeSessions() reports the live subscription (Task 10's reconnect seam).
    expect(rig.subs.activeSessions()).toEqual(['s1'])

    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e1' } })
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e2' } })
    // Wait for BOTH notifications to land in the session buffer. The window
    // start is seq 0 (the checkpoint descriptor's cursor), which is NOT
    // servable, so the window is probed from seq 1.
    await waitFor(() => {
      const read = rig.subs.read('s1', cursor('s1', 1))
      return 'events' in read && read.events.length === 1
    }, 3_000, 'both events cached')

    // A cursor strictly after the window start serves everything newer.
    const first = rig.subs.read('s1', cursor('s1', 1))
    expect('events' in first).toBe(true)
    if (!('events' in first)) throw new Error('expected events')
    expect(first.events.map((event) => event.kind)).toEqual(['execution.updated'])
    expect(first.nextCursor.seq).toBe('2')

    // A read with NO cursor returns the whole retained buffer.
    const all = rig.subs.read('s1')
    if (!('events' in all)) throw new Error('expected events')
    expect(all.events).toHaveLength(2)
    expect(all.nextCursor.seq).toBe('2')

    // The layer reports what it did at INFO (spec §5). This session came up
    // through the CHECKPOINT chain (the peer could not replay), so the recovery
    // line is what appears — ids and positions only, never the subscriptionId
    // or anything else the peer sent.
    const info = consoleInfo.mock.calls.flat().map(String).join('\n')
    expect(info).toContain('subscription recovered')
    expect(info).toContain('s1')
    expect(info).not.toContain(rig.fake.subscribeCalls[0]!.subscriptionId)
  })

  it('①c the windowStart/cursorOf accessors agree with what read() enforces', async () => {
    // The two accessors replaced outside-in reconstruction: `cursorOf` is the
    // resume point, `windowStart` is the retention boundary. They must agree
    // with the verdict `read` actually returns, or a caller that trusts them
    // would be sent to a cursor the layer then refuses.
    const rig = await makeRig()
    await rig.subs.ensure('s1')

    // Established at the checkpoint baseline (seq 0), before anything arrives.
    expect(rig.subs.windowStart('s1')).toEqual(cursor('s1', 0))
    expect(rig.subs.cursorOf('s1')).toEqual(cursor('s1', 0))
    // Nothing has been dropped, so the boundary IS a servable resume point (it
    // is the position this layer itself hands out while the buffer is empty).
    // Issue #2: refusing it here made `windowStart` name a cursor the layer then
    // rejected — the deadlock between `cherry_read`/`cherry_wait`'s cursor and
    // `cherry_events`.
    const empty = rig.subs.read('s1', rig.subs.windowStart('s1')!)
    if (!('events' in empty)) throw new Error('expected events: the baseline is servable')
    expect(empty.events).toEqual([])
    expect(empty.nextCursor).toEqual(cursor('s1', 0))

    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e1' } })
    await waitFor(() => {
      const read = rig.subs.read('s1')
      return 'events' in read && read.events.length === 1
    }, 3_000, 'the event cached')

    // The cursor advanced; the window start did NOT (nothing was evicted), and
    // it is still servable — it now yields the event that arrived above it.
    expect(rig.subs.cursorOf('s1')).toEqual(cursor('s1', 1))
    expect(rig.subs.windowStart('s1')).toEqual(cursor('s1', 0))
    const fromStart = rig.subs.read('s1', cursor('s1', 0))
    if (!('events' in fromStart)) throw new Error('expected events: the baseline is servable')
    expect(fromStart.events).toHaveLength(1)
    expect(fromStart.nextCursor.seq).toBe('1')
    expect('events' in rig.subs.read('s1', cursor('s1', 1))).toBe(true)

    // An untracked session reports NEITHER, rather than a fabricated seq 0.
    expect(rig.subs.cursorOf('never-subscribed')).toBeUndefined()
    expect(rig.subs.windowStart('never-subscribed')).toBeUndefined()
  })

  it('② reports cursor-out-of-window BEFORE the window, serves the BASELINE at its start, and serves cursors strictly after it', async () => {
    const rig = await makeRig()
    await rig.subs.ensure('s1')
    // The subscribe answer is a checkpoint descriptor at seq 0, so this
    // session's window start is 0 and nothing has been dropped from it.
    expect(rig.fake.subscribeCalls[0]!.mode).toBe('checkpoint')
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e1' } })
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e2' } })
    await waitFor(() => {
      const read = rig.subs.read('s1')
      return 'events' in read && read.events.length === 2
    }, 3_000, 'both events cached')

    // Face 1 — strictly BEFORE the window start: out of window.
    expect(rig.subs.read('s1', cursor('s1', -1))).toEqual({ error: 'cursor-out-of-window' })

    // Face 2 — AT the window start: SERVABLE, because that start is still the
    // subscription's BASELINE and nothing below it was ever discarded. Issue #2
    // reversed the brief's 「含窗口起点」 reading here: the boundary is the
    // position this layer itself issues as the resume point, so refusing it
    // deadlocked the tools that hand it out. It returns every retained event
    // newer than it, which is all of them.
    const atStart = rig.subs.read('s1', cursor('s1', 0))
    if (!('events' in atStart)) throw new Error('expected events: the baseline is servable')
    expect(atStart.events).toHaveLength(2)
    expect(atStart.events.map((event) => (event.payload as unknown as { executionId: string }).executionId)).toEqual([
      'e1',
      'e2',
    ])
    expect(atStart.nextCursor.seq).toBe('2')

    // Once an event DROP advances the boundary, the at-the-start reading flips
    // to refused — pinned by N2 below, since this window never drops anything.

    // Face 3 — strictly AFTER the window start: servable, and returns exactly
    // the events newer than the requested cursor.
    const afterStart = rig.subs.read('s1', cursor('s1', 1))
    if (!('events' in afterStart)) throw new Error('expected events')
    expect(afterStart.events).toHaveLength(1)
    expect((afterStart.events[0]!.payload as unknown as { executionId: string }).executionId).toBe('e2')
    expect(afterStart.nextCursor.seq).toBe('2')
  })

  it('②b re-baselines a re-subscribed session at the peer\'s position, so a pre-reset cursor is refused', async () => {
    const rig = await makeRig()
    await rig.subs.ensure('s1')
    const first = rig.subs.cursorOf('s1')!
    expect(first).toEqual(cursor('s1', 0))

    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e1' } })
    await waitFor(() => {
      const read = rig.subs.read('s1')
      return 'events' in read && read.events.length === 1
    }, 3_000, 'the event cached')

    // A peer reset drops the subscription locally; the re-subscribe then lands in
    // checkpoint mode at the NEW baseline the peer reports.
    rig.fake.pushResetRequired('s1')
    await waitFor(() => rig.fake.subscriptions.length === 0, 3_000, 'peer-side reset')
    await rig.subs.ensure('s1')
    await waitFor(() => rig.subs.activeSessions().includes('s1'), 3_000, 're-subscribed')

    // The peer's checkpoint cursor advances with the journal, so the recovered
    // window starts AT that event: the layer has NOTHING retained, and it never
    // saw whatever came before. The recovered baseline therefore refers to an
    // event this subscription never delivered — it is servable (issue #2: it is
    // still the position the layer hands out as the resume point, and serving it
    // loses nothing), but it proves continuity with nothing older.
    const recovered = rig.subs.cursorOf('s1')!
    expect(recovered.seq).toBe('1')
    expect(rig.subs.windowStart('s1')).toEqual(recovered)
    const baseline = rig.subs.read('s1', recovered)
    if (!('events' in baseline)) throw new Error('expected events: the recovered baseline is servable')
    expect(baseline.events).toEqual([])

    // A cursor from BEFORE the reset is strictly below the recovered baseline,
    // and the layer cannot certify it: it is refused, exactly as it was before
    // issue #2. This is the face the fix deliberately did NOT relax.
    expect(rig.subs.read('s1', cursor('s1', 0))).toEqual({ error: 'cursor-out-of-window' })

    // The same cursor against a DIFFERENT epoch is refused for its own reason
    // (mismatch), independently of the window rule.
    expect(rig.subs.read('s1', cursor('s1', 1, 'epoch-from-another-connection'))).toEqual({
      error: 'cursor-out-of-window',
    })
    expect(rig.subs.read('s1', first)).toEqual({ error: 'cursor-out-of-window' })
  })

  it('③ evicts the oldest session on the 9th subscription, closes it, and warns', async () => {
    const rig = await makeRig()
    const sessions = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']
    for (const sessionId of sessions) await rig.subs.ensure(sessionId)
    expect(rig.subs.activeSessions()).toHaveLength(8)
    expect(rig.fake.closeCalls).toHaveLength(0)

    // The 9th subscription exceeds the default cap of 8.
    await rig.subs.ensure('s9')

    // The OLDEST session (s1) was evicted, and its subscription closed.
    expect(rig.fake.closeCalls).toHaveLength(1)
    const closedId = rig.fake.closeCalls[0]!.subscriptionId
    expect(rig.fake.closeCalls[0]!.sessionId).toBe('s1')
    expect(closedId).toBeTruthy()
    expect(rig.subs.activeSessions()).toHaveLength(8)
    expect(rig.subs.activeSessions()).not.toContain('s1')
    expect(rig.subs.activeSessions()).toContain('s9')

    // 「丢最旧并记录」: the eviction is WARNED, not silent.
    const warnings = consoleWarn.mock.calls.flat().map(String)
    expect(warnings.some((message) => /evict/i.test(message))).toBe(true)
  })

  it('③b clamps the LRU cap down to the peer-negotiated subscriptionsLimit', async () => {
    // Local policy configured ABOVE the peer cap: the constructor clamps down
    // to the negotiated value, so the local eviction fires at the CLAMPED
    // boundary and the peer never has to refuse a subscribe.
    const rig = await makeRig({ agent: { subscriptionLimit: 2 } }, { subscriptionsLimit: 2 })
    await rig.subs.ensure('s1')
    await rig.subs.ensure('s2')
    // A 3rd ensure with an UNCLAMPED cap of 8 would hit the peer cap instead.
    await rig.subs.ensure('s3')

    expect(rig.fake.closeCalls).toHaveLength(1)
    expect(rig.fake.closeCalls[0]!.sessionId).toBe('s1')
    // The peer NEVER answered RESOURCE_EXHAUSTED: the local eviction beat it.
    expect(rig.fake.subscribeCalls.every((call) => call.mode !== 'error')).toBe(true)
    // And the eviction was logged (「丢最旧并记录」).
    const warnings = consoleWarn.mock.calls.flat().map(String)
    expect(warnings.some((message) => /evict/i.test(message))).toBe(true)
  })

  it('④ re-ensures the same session by closing the old subscription FIRST, then exactly one new subscribe', async () => {
    const rig = await makeRig()
    await rig.subs.ensure('s1')
    const firstId = rig.fake.subscriptions[0]!.subscriptionId

    await rig.subs.ensure('s1')

    // close was called with the OLD subscriptionId, and exactly one NEW
    // subscribe followed (the old subscription is never reused).
    expect(rig.fake.closeCalls).toHaveLength(1)
    expect(rig.fake.closeCalls[0]!.subscriptionId).toBe(firstId)
    expect(rig.fake.subscribeCalls).toHaveLength(2)

    // TIMING, not just counts: the close preceded the second subscribe.
    const sequence = rig.sequence()
    const closeAt = sequence.indexOf('agent.subscriptions.close')
    const secondSubscribeAt = sequence.lastIndexOf('agent.sessions.subscribe')
    expect(closeAt).toBeGreaterThanOrEqual(0)
    expect(secondSubscribeAt).toBeGreaterThan(closeAt)

    // The peer's own phase evidence: the first subscription went `reset`,
    // which is precisely what makes the re-subscribe legal rather than CONFLICT.
    expect(rig.fake.subscriptionPhases).toContain('reset')
    expect(rig.fake.subscribeCalls.every((call) => call.mode !== 'error')).toBe(true)
    // And exactly ONE live subscription remains.
    expect(rig.fake.subscriptions).toHaveLength(1)
  })

  it('⑤ re-subscribes successfully after the peer signals resetRequired', async () => {
    const rig = await makeRig()
    await rig.subs.ensure('s1')
    expect(rig.fake.subscriptions).toHaveLength(1)

    rig.fake.pushResetRequired('s1')
    // The peer closed it on its side, so a fresh subscribe is required.
    await waitFor(() => rig.fake.subscriptions.length === 0, 3_000, 'peer-side reset applied')

    await rig.subs.ensure('s1')
    expect(rig.fake.subscribeCalls).toHaveLength(2)
    // The reset session was dropped locally, so the re-subscribe carries NO
    // cursor: the peer therefore answers with a checkpoint descriptor (the
    // replayable suffix is gone) and the layer runs the recovery chain.
    expect(rig.fake.subscribeCalls[1]!.cursor).toBeUndefined()
    expect(rig.fake.subscribeCalls[1]!.mode).toBe('checkpoint')
    // The RE-subscription converged through a second activation.
    await waitFor(() => rig.fake.activateCalls.length === 2, 3_000, 'second recovery activate')
    expect(rig.fake.activateCalls[1]!.ok).toBe(true)
    expect(rig.fake.subscriptions).toHaveLength(1)
    expect(rig.subs.activeSessions()).toEqual(['s1'])
  })

  it('⑥ rebuilds projection state from a checkpoint and activates with a three-field-equal cursor', async () => {
    const rig = await makeRig({ agent: { forceCheckpointMode: true, checkpointMs: 300_000 } })
    await rig.subs.ensure('s1')

    // The peer answered the checkpoint branch of subscribe.
    expect(rig.fake.subscribeCalls[0]!.mode).toBe('checkpoint')

    // The recovery chain ran: paginated reads THEN activate.
    await waitFor(() => rig.fake.activateCalls.length === 1, 3_000, 'activate')
    const reads = rig.fake.checkpointReadCalls
    expect(reads.length).toBeGreaterThanOrEqual(2)
    // Pagination is driven by pageCursor and ADVANCES: page 0 has no cursor,
    // the second read carries the first page's nextCursor.
    expect(reads[0]!.pageCursor).toBeUndefined()
    expect(reads[1]!.pageCursor).toBe('1')
    // Every read targets the SAME checkpoint (pagination, not re-capture).
    expect(new Set(reads.map((read) => read.checkpointId)).size).toBe(1)

    // THREE-FIELD equality against the SUBSCRIBE descriptor's cursor, asserted
    // field by field (the peer compares exactly these three).
    const applied = rig.fake.activateCalls[0]!.appliedCursor
    const prepared = rig.fake.checkpointCursorOf(rig.fake.activateCalls[0]!.subscriptionId)
    expect(prepared).toBeDefined()
    expect(applied.sessionId).toBe(prepared!.sessionId)
    expect(applied.streamEpoch).toBe(prepared!.streamEpoch)
    expect(applied.seq).toBe(prepared!.seq)
    // And the same, spelled out relative to the requested session.
    expect(applied.sessionId).toBe('s1')
    expect(applied.streamEpoch).toBe('epoch-1')
    expect(rig.fake.activateCalls[0]!.ok).toBe(true)

    // The pagination cursor is a PAGE cursor, never a STREAM cursor: the
    // activated stream cursor is the descriptor's (seq 0), which differs from
    // the page cursor the second read advanced to ('1').
    expect(applied.seq).not.toBe(reads[1]!.pageCursor)
    expect(applied.seq).toBe('0')

    // The rebuilt projection state is what the checkpoint described: the
    // session snapshot from page 0 plus the projection items from page 1.
    const projection = rig.subs.projection('s1')
    expect(projection.map((item) => item.kind)).toEqual(['session', 'interaction'])
    expect((projection[0]!.value as { sessionId: string }).sessionId).toBe('s1')

    // Pagination read AND activate both landed inside the prepared lease
    // window, measured against the SUBSCRIBE reply (the lease start).
    const subscribeAt = rig.fake.agentCallTimes('agent.sessions.subscribe')[0]!
    const lastReadAt = rig.fake.agentCallTimes('agent.checkpoints.read').at(-1)!
    const activateAt = rig.fake.agentCallTimes('agent.subscriptions.activate')[0]!
    expect(activateAt - subscribeAt).toBeLessThan(300_000)
    expect(lastReadAt - subscribeAt).toBeLessThan(300_000)
    expect(activateAt).toBeGreaterThanOrEqual(lastReadAt)
  })

  it('⑥b surfaces a peer CONFLICT when the applied cursor disagrees with the descriptor (never swallows it)', async () => {
    const rig = await makeRig({ agent: { forceCheckpointMode: true } })
    await rig.subs.ensure('s1')
    const subscriptionId = rig.fake.subscriptions[0]!.subscriptionId

    // A forged cursor, one field off — the peer must refuse it.
    await expect(
      rig.client.request('agent.subscriptions.activate', {
        subscriptionId,
        appliedCursor: { sessionId: 's1', streamEpoch: 'epoch-1', seq: '999' },
      }),
    ).rejects.toMatchObject({ data: { reason: 'CONFLICT' } })
    // The refusal is recorded as a FAILED activation, not accepted.
    expect(rig.fake.activateCalls.at(-1)!.ok).toBe(false)
  })

  it('⑦ ignores and warns about a notification whose method is not registered', async () => {
    const rig = await makeRig()
    await rig.subs.ensure('s1')
    consoleWarn.mockClear()

    rig.fake.pushNotification('agent.totallyUnknown', { whatever: true })
    await waitFor(
      () => consoleWarn.mock.calls.flat().map(String).some((message) => message.includes('agent.totallyUnknown')),
      3_000,
      'the unknown-method warning',
    )
    // Ignored, not fatal: the subscription is untouched and still live.
    expect(rig.subs.activeSessions()).toEqual(['s1'])
    expect(rig.fake.subscriptions).toHaveLength(1)
  })

  it('⑧ re-runs the WHOLE recovery chain when the prepared lease expires', async () => {
    // checkpointMs 50 makes the peer's prepared lease 50ms; the peer delays
    // EVERY checkpoint read by 120ms, so the first chain's pagination cannot
    // finish inside the lease. The peer then answers CHECKPOINT_EXPIRED and the
    // layer must re-run the ENTIRE chain (fresh subscribe → fresh pagination →
    // fresh activate) — never reusing the expired lease or the stale pages.
    const rig = await makeRig(
      {
        agent: {
          forceCheckpointMode: true,
          checkpointMs: 50,
          // The FIRST checkpoint read is delayed past the 50ms lease; the
          // retry chain reads promptly so it can converge.
          checkpointReadDelayMs: 120,
          checkpointReadDelayCalls: 1,
        },
      },
      { checkpointMs: 50 },
    )

    await rig.subs.ensure('s1')
    await waitFor(() => rig.fake.activateCalls.some((call) => call.ok), 3_000, 'converged activation')

    // The lease really did expire on the first chain, and the recovery
    // re-subscribed from scratch (a FRESH descriptor with a fresh lease).
    expect(rig.fake.subscribeCalls.length).toBeGreaterThanOrEqual(2)
    const fresh = rig.fake.subscribeCalls.at(-1)!
    expect(fresh.mode).toBe('checkpoint')
    // The retry re-paginated from page 0 and re-activated rather than reusing
    // the stale pages of the expired chain.
    expect(rig.fake.checkpointReadCalls.length).toBeGreaterThanOrEqual(3)
    const afterExpiry = rig.fake.checkpointReadCalls.filter(
      (read) => read.subscriptionId === fresh.subscriptionId,
    )
    expect(afterExpiry[0]!.pageCursor).toBeUndefined()
    expect(rig.fake.activateCalls.filter((call) => call.ok)).toHaveLength(1)
    expect(rig.subs.activeSessions()).toEqual(['s1'])
  })

  it('⑨ catches RESOURCE_EXHAUSTED, evicts via LRU, and retries the subscribe successfully', async () => {
    // The peer cap is 1 but the LOCAL cap is configured at 2: the clamp only
    // lowers, so configure the layer with limit 2 and let the peer refuse the
    // 2nd subscription. This is the §6 RESOURCE_EXHAUSTED SUBSCRIPTION dimension.
    const rig = await makeRig({ agent: { subscriptionLimit: 1 } }, { subscriptionsLimit: 2 })
    await rig.subs.ensure('s1')
    expect(rig.fake.subscriptions).toHaveLength(1)

    await rig.subs.ensure('s2')

    // The peer refused with RESOURCE_EXHAUSTED, the layer evicted the oldest
    // (close) and retried — succeeding on the retry.
    expect(rig.fake.subscribeCalls.some((call) => call.mode === 'error' && call.reason === 'RESOURCE_EXHAUSTED')).toBe(
      true,
    )
    expect(rig.fake.closeCalls.length).toBeGreaterThanOrEqual(1)
    expect(rig.fake.closeCalls[0]!.sessionId).toBe('s1')
    expect(rig.subs.activeSessions()).toContain('s2')
    expect(rig.subs.activeSessions()).not.toContain('s1')
  })

  it('⑩ re-runs the recovery chain when activate answers CHECKPOINT_EXPIRED (explicit injection)', async () => {
    // The explicit injection anchor of the 对照表 CHECKPOINT_EXPIRED row: the
    // peer answers CHECKPOINT_EXPIRED once on a checkpoint face, INDEPENDENT of
    // any real lease expiry (the lease here is the full 300s).
    const rig = await makeRig({
      agent: {
        forceCheckpointMode: true,
        checkpointMs: 300_000,
        failNextCheckpointCall: { reason: 'CHECKPOINT_EXPIRED', message: 'Preparation lease expired' },
      },
    })
    await rig.subs.ensure('s1')

    // The chain re-ran and CONVERGED: exactly one successful activation, and
    // the expiry was never surfaced to the caller.
    await waitFor(() => rig.fake.activateCalls.some((call) => call.ok), 3_000, 'converged activation')
    expect(rig.fake.activateCalls.filter((call) => call.ok)).toHaveLength(1)
    // More than one subscribe proves the WHOLE chain was re-run from scratch
    // (fresh subscribe), not merely the activate retried.
    expect(rig.fake.subscribeCalls.length).toBeGreaterThanOrEqual(2)
    expect(rig.fake.subscribeCalls.at(-1)!.mode).toBe('checkpoint')
    expect(rig.fake.subscriptions).toHaveLength(1)
    expect(rig.subs.activeSessions()).toEqual(['s1'])
  })

  it('⑩b closes the dead prepared subscription before re-subscribing, even when the peer keeps its slot', async () => {
    // A peer that reports the expiry WITHOUT resetting its own bookkeeping:
    // re-subscribing without an explicit close would collide with CONFLICT.
    const rig = await makeRig({
      agent: {
        forceCheckpointMode: true,
        checkpointMs: 300_000,
        keepSubscriptionOnInjectedExpiry: true,
        failNextCheckpointCall: { reason: 'CHECKPOINT_EXPIRED', message: 'Preparation lease expired' },
      },
    })
    await rig.subs.ensure('s1')

    await waitFor(() => rig.fake.activateCalls.some((call) => call.ok), 3_000, 'converged activation')
    // The recovery succeeded rather than colliding: a close preceded the
    // re-subscribe, and no subscribe was ever refused.
    const dead = rig.fake.subscribeCalls[0]!.subscriptionId
    expect(rig.fake.closeCalls.some((call) => call.subscriptionId === dead)).toBe(true)
    expect(rig.fake.subscribeCalls.every((call) => call.mode !== 'error')).toBe(true)
    expect(rig.subs.activeSessions()).toEqual(['s1'])
  })

  it('⑪ falls back into the recovery chain when the replay request is rejected as too old', async () => {
    // The replay window has evicted everything before seq 50.
    const rig = await makeRig({ agent: { firstRetainedSeq: 50, watermark: 100 } })
    await rig.subs.ensure('s1', cursor('s1', 1))

    // The peer refused the replay and answered with a checkpoint descriptor.
    expect(rig.fake.subscribeCalls[0]!.mode).toBe('checkpoint')
    expect(rig.fake.subscribeCalls[0]!.reason).toBe('replay window evicted')

    // The layer entered the recovery chain rather than surfacing an error.
    await waitFor(() => rig.fake.activateCalls.length === 1, 3_000, 'activate')
    expect(rig.fake.activateCalls[0]!.ok).toBe(true)
    expect(rig.fake.activateCalls[0]!.appliedCursor.seq).toBe('100')
    expect(rig.subs.activeSessions()).toEqual(['s1'])
  })

  it('⑮ reports cursor-out-of-window for a cursor from a different stream epoch', async () => {
    const rig = await makeRig()
    await rig.subs.ensure('s1')
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e1' } })
    await waitFor(() => {
      const read = rig.subs.read('s1')
      return 'events' in read && read.events.length === 1
    }, 3_000, 'event cached')

    // A cursor from another stream epoch can never be served from this buffer.
    expect(rig.subs.read('s1', cursor('s1', 1, 'epoch-from-another-connection'))).toEqual({
      error: 'cursor-out-of-window',
    })
    // And neither can a cursor naming a different session.
    expect(rig.subs.read('s1', cursor('other-session', 1))).toEqual({ error: 'cursor-out-of-window' })
  })

  it('⑯ gives up after the shared retry budget when every checkpoint lease expires', async () => {
    // The submission NEVER converges: every checkpoint face answers
    // CHECKPOINT_EXPIRED forever. A layer whose retry budget is not really
    // shared (or is reset by each nested restart) loops here indefinitely.
    const rig = await makeRig({
      agent: { forceCheckpointMode: true, checkpointMs: 300_000, alwaysExpireCheckpoints: true },
    })

    // The ensure must TERMINATE with the peer's error surfaced, not hang.
    await expect(rig.subs.ensure('s1')).rejects.toMatchObject({ data: { reason: 'CHECKPOINT_EXPIRED' } })

    // The chain gave up after the shared budget: the call counts are BOUNDED
    // (one subscribe per attempt, no runaway), and nothing was installed.
    expect(rig.fake.subscribeCalls.length).toBeLessThanOrEqual(4)
    expect(rig.fake.activateCalls.filter((call) => call.ok)).toHaveLength(0)
    expect(rig.subs.activeSessions()).toEqual([])
    // Each restart released its dead prepared subscription before re-subscribing.
    expect(rig.fake.closeCalls.length).toBe(rig.fake.subscribeCalls.length - 1)
  })

  it('⑫ drops the OLDEST cached events when perSessionCacheBytes is exceeded, and warns', async () => {
    // A deliberately tiny LOCAL cache budget (2 KiB): whatever the real peer
    // streams, the third event must push the first one out.
    const rig = await makeRig({}, { perSessionCacheBytes: 2_048 })
    await rig.subs.ensure('s1')

    // Each event's JSON is ~1KB, so three exceed the 2KiB budget.
    const filler = 'x'.repeat(1_000)
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { tag: 'first', filler } })
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { tag: 'second', filler } })
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { tag: 'third', filler } })
    await waitFor(
      () => consoleWarn.mock.calls.flat().map(String).some((message) => /dropped .* oldest/i.test(message)),
      3_000,
      'the oldest-drop warning',
    )

    // The OLDEST event is gone from the window; the newest are retained.
    const read = rig.subs.read('s1')
    if (!('events' in read)) throw new Error('expected events')
    const tags = read.events.map((event) => (event.payload as unknown as { tag: string }).tag)
    expect(tags).not.toContain('first')
    expect(tags).toContain('third')
    // The drop is logged, never silent (「丢最旧并记录」).
    const warnings = consoleWarn.mock.calls.flat().map(String)
    expect(warnings.some((message) => /dropped .* oldest/i.test(message))).toBe(true)
    // And the dropped event's cursor is now out of window. KEPT AS IS after
    // issue #2: this window really did discard events, so its baseline is no
    // longer a position the layer may serve (the boundary, let alone below it).
    expect(rig.subs.read('s1', cursor('s1', 0))).toEqual({ error: 'cursor-out-of-window' })
    // The boundary the drop advanced to is refused too — the half of the rule
    // the fix left untouched (N2 pins the full shape).
    expect(rig.subs.read('s1', rig.subs.windowStart('s1')!)).toEqual({ error: 'cursor-out-of-window' })
  })

  it('⑬ acknowledges the delivered cursor to the peer', async () => {
    const rig = await makeRig()
    await rig.subs.ensure('s1')
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e1' } })
    await waitFor(() => {
      const read = rig.subs.read('s1')
      return 'events' in read && read.events.length === 1
    }, 3_000, 'event cached')

    await rig.subs.ack('s1', cursor('s1', 1))
    await waitFor(() => rig.fake.ackCalls.length === 1, 3_000, 'ack')
    // The peer accepted the ack and advanced its own lastAck.
    expect(rig.fake.ackCalls[0]!.cursor.seq).toBe('1')
    expect(rig.fake.subscriptions[0]!.lastAck).toBe(1)
  })

  it('⑭ wakes a parked waiter when events arrive (Tasks 8/9 ride this)', async () => {
    const rig = await makeRig()
    await rig.subs.ensure('s1')

    let woken = false
    const parked = rig.subs.waitFor('s1', cursor('s1', 0)).promise.then(() => {
      woken = true
    })
    // Not woken by the mere act of parking.
    await sleep(30)
    expect(woken).toBe(false)

    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e1' } })
    await parked
    expect(woken).toBe(true)
  })

  it('⑭b a disposed park leaves the waiter queue, so re-parking cannot accumulate resolvers', async () => {
    // The `cherry_wait` poll loop re-parks after every judgement pass. Without a
    // disposer each pass left a resolver behind forever: the queue grew once per
    // poll interval for the whole wait, and every buffer advance then settled all
    // of them. The disposer is what keeps the queue at the ONE live park.
    const rig = await makeRig()
    await rig.subs.ensure('s1')
    expect(rig.subs.waiterCount('s1')).toBe(0)

    const first = rig.subs.waitFor('s1', cursor('s1', 0))
    expect(rig.subs.waiterCount('s1')).toBe(1)

    // Re-parking (as the poll loop does) with the previous park disposed: the
    // queue holds exactly one resolver, not two.
    first.dispose()
    expect(rig.subs.waiterCount('s1')).toBe(0)
    const second = rig.subs.waitFor('s1', cursor('s1', 0))
    expect(rig.subs.waiterCount('s1')).toBe(1)

    // Disposing a park that already settled is a no-op — a caller may use it
    // unconditionally on every exit path.
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e1' } })
    await second.promise
    expect(rig.subs.waiterCount('s1')).toBe(0)
    expect(() => {
      first.dispose()
      second.dispose()
    }).not.toThrow()
    expect(rig.subs.waiterCount('s1')).toBe(0)
  })

  it('⑰ ignores a replayed LOWER seq per (sessionId, streamEpoch): the cursor never regresses and no waiter is woken', async () => {
    const rig = await makeRig()
    await rig.subs.ensure('s1')

    // Two in-order events establish the cursor at seq 2.
    const first = rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e1' } })
    const second = rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e2' } })
    expect(first.seq).toBe('1')
    expect(second.seq).toBe('2')
    await waitFor(() => {
      const read = rig.subs.read('s1')
      return 'events' in read && read.events.length === 2
    }, 3_000, 'both events cached')
    const before = rig.subs.read('s1')
    if (!('events' in before)) throw new Error('expected events')
    expect(before.nextCursor.seq).toBe('2')

    // Park a waiter at the CURRENT position: a lower seq is not progress, so it
    // must not settle — settling would tell the caller "something new arrived".
    let woken = false
    void rig.subs.waitFor('s1', cursor('s1', 2)).promise.then(() => {
      woken = true
    })
    await sleep(30)
    expect(woken).toBe(false)

    consoleWarn.mockClear()
    // The peer re-delivers seq 1 (duplicate / out-of-order on a healthy stream).
    rig.fake.replayEvent('s1', 1, { kind: 'execution.updated', payload: { executionId: 'e1-replayed' } })
    await waitFor(
      () => consoleWarn.mock.calls.flat().map(String).some((message) => /seq/i.test(message)),
      3_000,
      'the out-of-order warning',
    )

    // The replay is REFUSED, and it says so (never silently ignored).
    const warnings = consoleWarn.mock.calls.flat().map(String)
    expect(warnings.some((message) => /seq/i.test(message))).toBe(true)

    // The cursor did not regress, and the stale event did not enter the buffer.
    const after = rig.subs.read('s1')
    if (!('events' in after)) throw new Error('expected events')
    expect(after.nextCursor.seq).toBe('2')
    expect(after.events).toHaveLength(2)
    expect(
      after.events.some(
        (event) => (event.payload as unknown as { executionId?: string }).executionId === 'e1-replayed',
      ),
    ).toBe(false)

    // ...and the parked waiter was left parked: a stale seq is not a wake.
    await sleep(30)
    expect(woken).toBe(false)

    // A genuinely NEWER seq still wakes it, so the guard did not wedge the wait.
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e3' } })
    await waitFor(() => woken, 3_000, 'the real wake after the stale replay')
    const newest = rig.subs.read('s1')
    if (!('events' in newest)) throw new Error('expected events')
    expect(newest.nextCursor.seq).toBe('3')
  })

  it('N1 (issue #2) serves the BASELINE position itself while nothing has been dropped', async () => {
    // The regression issue #2 reports: a freshly established session has an
    // EMPTY buffer whose window start IS the position this layer itself hands
    // out as a resume point (`#nextCursor` returns `state.cursor` when nothing
    // is returned — and `cursorOf`/`windowStart` are both that same baseline).
    // Refusing it made the cursor `cherry_read`/`cherry_wait` issue unusable by
    // `cherry_events`, i.e. the layer contradicted itself from the first call.
    const rig = await makeRig()
    await rig.subs.ensure('s1')

    // Nothing has arrived yet: the baseline is the whole (empty) window, and it
    // must be SERVABLE rather than refused.
    const baseline = rig.subs.cursorOf('s1')!
    expect(rig.subs.windowStart('s1')).toEqual(baseline)
    const read = rig.subs.read('s1', baseline)
    if (!('events' in read)) throw new Error('expected events: the baseline is servable')
    expect(read.events).toEqual([])
    // The empty replay is not a dead end: its nextCursor is the baseline itself,
    // which the NEXT read accepts too — the round trip a caller actually makes.
    expect(read.nextCursor).toEqual(baseline)
    const again = rig.subs.read('s1', read.nextCursor)
    if (!('events' in again)) throw new Error('expected events: the baseline stays servable')
    expect(again.events).toEqual([])

    // The same verdict in the non-empty case: the baseline serves EVERYTHING
    // retained, because nothing in that range was ever dropped.
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e1' } })
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'e2' } })
    await waitFor(() => {
      const current = rig.subs.read('s1')
      return 'events' in current && current.events.length === 2
    }, 3_000, 'both events cached')
    const whole = rig.subs.read('s1', baseline)
    if (!('events' in whole)) throw new Error('expected events: the baseline is still servable')
    expect(whole.events.map((event) => event.kind)).toEqual(['execution.updated', 'execution.updated'])
    expect(whole.nextCursor.seq).toBe('2')

    // Strictly BELOW the baseline has no provable continuity and stays refused.
    expect(rig.subs.read('s1', cursor('s1', -1))).toEqual({ error: 'cursor-out-of-window' })
  })

  it('N2 (issue #2) refuses AT the window start once a byte-budget drop has advanced it, and still serves strictly after', async () => {
    // The OTHER state the boundary can be in, and the reason the rule cannot be
    // "always servable": `#trimToBudget` really did discard events, so the layer
    // can no longer prove a caller resuming from the boundary has seen them.
    // A tiny 2 KiB budget — the shape ⑫ uses — forces the drop deterministically
    // (each event's JSON is just over 1 KiB, so three of them cannot all fit).
    const rig = await makeRig({}, { perSessionCacheBytes: 2_048 })
    await rig.subs.ensure('s1')
    expect(rig.subs.windowStart('s1')).toEqual(cursor('s1', 0))

    const filler = 'x'.repeat(1_000)
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { tag: 'first', filler } })
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { tag: 'second', filler } })
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { tag: 'third', filler } })
    await waitFor(
      () => {
        const dropped = consoleWarn.mock.calls.flat().map(String).some((message) => /dropped .* oldest/i.test(message))
        return dropped && rig.subs.cursorOf('s1')?.seq === '3'
      },
      3_000,
      'the oldest-drop warning',
    )

    // The drop ADVANCED the boundary past the discarded position.
    const start = rig.subs.windowStart('s1')!
    expect(Number(start.seq)).toBeGreaterThan(0)

    // AT the boundary: REFUSED — this is the rule that must survive the fix,
    // because the event that occupied that position is gone.
    expect(rig.subs.read('s1', start)).toEqual({ error: 'cursor-out-of-window' })
    // And so is the position the window STARTED from, now strictly below it.
    expect(rig.subs.read('s1', cursor('s1', 0))).toEqual({ error: 'cursor-out-of-window' })

    // The un-cursored read still shows what the budget retained, and every
    // retained event is STRICTLY newer than the boundary — which is what makes
    // it servable through a cursor placed below it.
    const retained = rig.subs.read('s1')
    if (!('events' in retained)) throw new Error('expected events: the un-cursored read')
    expect(retained.events.length).toBeGreaterThan(0)
    const retainedSeqs = retained.events.map((event) => Number((event as unknown as { seq: string }).seq))
    expect(Math.min(...retainedSeqs)).toBeGreaterThan(Number(start.seq))
    const retainedTags = retained.events.map((event) => (event.payload as unknown as { tag: string }).tag)
    expect(retainedTags).not.toContain('first')
    expect(retainedTags).toContain('third')

    // STRICTLY AFTER the boundary stays servable, and every retained event is
    // in that range — so a caller resuming just past the boundary (or at it,
    // once the boundary IS servable again) reaches exactly the retained events.
    expect(rig.subs.read('s1', start)).toEqual({ error: 'cursor-out-of-window' })
    const afterBoundary = { sessionId: 's1', streamEpoch: 'epoch-1', seq: String(Number(start.seq) - 1) }
    // (Below the boundary is refused too; the assertions above pin that.)
    expect(rig.subs.read('s1', afterBoundary)).toEqual({ error: 'cursor-out-of-window' })
  })

  it('F2-6d a non-string streamEpoch is refused with a warning, never treated as the current epoch', async () => {
    const rig = await makeRig()
    await rig.subs.ensure('s1')
    const subscriptionId = rig.fake.subscriptions.find((entry) => entry.sessionId === 's1')!.subscriptionId

    consoleWarn.mockClear()
    // A malformed epoch: the peer DID send the field, so it is making a claim
    // about which stream this batch belongs to — one this layer cannot check.
    // The dangerous reading is "not a string, so skip the comparison", which
    // silently accepts the batch as belonging to the CURRENT stream.
    rig.fake.pushNotification('agent.events', {
      subscriptionId,
      sessionId: 's1',
      streamEpoch: 42,
      events: [{ kind: 'execution.updated', seq: '1', payload: { executionId: 'malformed' } }],
    })

    await waitFor(
      () => consoleWarn.mock.calls.flat().map(String).some((message) => /stream epoch/i.test(message)),
      3_000,
      'the malformed-epoch warning',
    )

    // Nothing was folded: the batch is dropped, so no event and no cursor move.
    const read = rig.subs.read('s1')
    if (!('events' in read)) throw new Error('expected events')
    expect(read.events).toHaveLength(0)
    expect(read.nextCursor.seq).toBe('0')

    // A well-formed batch on the SAME subscription still lands, so the guard
    // refuses the malformed frame rather than the stream.
    rig.fake.pushEvent('s1', { kind: 'execution.updated', payload: { executionId: 'ok' } })
    await waitFor(() => {
      const next = rig.subs.read('s1')
      return 'events' in next && next.events.length === 1
    }, 3_000, 'the well-formed event')
  })
})
