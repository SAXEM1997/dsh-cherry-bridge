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
import { LOG_TEXT_MAX } from '../../src/text.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions } from '../loopback/fakeCherry.js'

/**
 * Issue #2, end to end: the BASELINE cursor a tool hands out is one
 * `cherry_events` must accept.
 *
 * The buffering layer refuses a cursor it cannot PROVE continuity for, and that
 * refusal is right for a window it advanced by DISCARDING events. It is wrong
 * for the subscription's baseline — the position the layer itself issues as the
 * resume point while the buffer is empty. Refusing that too deadlocked the tool
 * pair: `cherry_send`/`cherry_wait` report `cursor` mid-run, and
 * `cherry_events(that cursor)` answered `cursor-out-of-window` whenever the
 * window was still at its baseline — the seq 0 of a freshly established session
 * in the field report — so a caller could never follow the cursor it had just
 * been given. Every cursor the peer itself resolves goes through the same
 * empty-buffer `read`, which is what made the deadlock reachable from the very
 * first call.
 *
 * Driven through the REAL registration seam against a real loopback fake
 * desktop, exactly as the host calls the tools.
 */

interface Rig {
  fake: FakeCherry
  /** The subscription layer behind the tools, for buffer-level waits. */
  subs(): SessionSubscriptions
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  /**
   * Test seam for the background re-ensure's ACCESSOR arm (issue #161): let the
   * next `accesses` calls through, then make the following one throw. The tool
   * face resolves its layer through this accessor, so the counting is the only
   * way to aim a fault at the re-ensure rather than at the tool call itself.
   */
  failSubsAfter(accesses: number, error: unknown): void
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

const AGENT = { agentId: 'agent-1', name: 'Agent One' }

function session(sessionId: string) {
  return {
    sessionId,
    agentId: 'agent-1',
    workspaceId: 'ws-1',
    title: `Session ${sessionId}`,
    historyRevision: '1000',
  }
}

const SESSION = session('s-1')

async function makeRig(options: FakeCherryOptions = {}): Promise<Rig> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-events-window-'))
  const store = new DeviceStore(join(tmp, 'devices.json'))
  store.upsert({
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
  })

  const connection = new DeviceConnection({
    identity,
    record: store.list()[0]!,
    // A loopback peer: the production 32 req/s business budget would pace the
    // tools' own paging against the clock under test.
    rateBudgetPerSecond: 10_000,
  })
  const subscriptions = new Map<string, SessionSubscriptions>()
  let subsFault: { remaining: number; error: unknown } | undefined
  const subs = (deviceId: string): SessionSubscriptions => {
    if (subsFault !== undefined) {
      if (subsFault.remaining > 0) {
        subsFault.remaining -= 1
      } else {
        const { error } = subsFault
        subsFault = undefined
        throw error
      }
    }
    const existing = subscriptions.get(deviceId)
    if (existing !== undefined) return existing
    const created = new SessionSubscriptions(connection.rpc, {
      subscriptionsLimit: options.agent?.subscriptionLimit ?? 8,
    })
    connection.rpc.onNotification((method, params) => created.handleNotification(method, params))
    subscriptions.set(deviceId, created)
    return created
  }

  const definitions: CherryToolDefinition[] = []
  const ctx: CherryToolsContext = {
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
  const deps: CherryToolsDeps = {
    store,
    connect: () => connection,
    subs,
    pair: async () => {
      throw new Error('pairing is not exercised by the events-window suite')
    },
    evict: () => {
      throw new Error('the events-window suite never evicts')
    },
  }
  registerCherryTools(ctx, deps, {})
  await connection.connect()

  const rig: Rig = {
    fake,
    subs: () => subs('dev-A'),
    call: (name, args = {}) => {
      const found = definitions.find((definition) => definition.name === name)
      if (found === undefined) throw new Error(`tool ${name} is not registered`)
      return found.execute(args)
    },
    failSubsAfter: (accesses, error) => {
      subsFault = { remaining: accesses, error }
    },
    stop: async () => {
      for (const created of subscriptions.values()) await created.dispose()
      await connection.close()
      await fake.stop()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
  rigs.push(rig)
  return rig
}

describe('issue #2: a baseline cursor handed out by the tools is servable by cherry_events', () => {
  it('N3 follows the cursor a mid-run tool call reported: the events newer than it are delivered', async () => {
    // A run whose terminal event lands far outside every window used here, so
    // the whole conversation is MID-RUN: when the cursor is captured the session
    // holds one `execution.updated(running)` — the window's own first event —
    // and nothing terminal.
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], runDelayMs: 30_000 },
    })

    // First use establishes the subscription; the peer answers a CHECKPOINT
    // descriptor, so the baseline is seq 0 — the field report's value.
    await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION.sessionId })
    await waitFor(
      () => rig.fake.subscriptions.some((entry) => entry.sessionId === SESSION.sessionId),
      3_000,
      'the session subscription',
    )

    // A send whose window elapses mid-run answers `timeout` WITH the event
    // cursor — the tool-level way a caller learns "events after here" (and
    // unlike the message walk's stop point, this one IS fed back to
    // `cherry_events`).
    const sent = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: SESSION.sessionId,
      text: 'hello',
      timeoutMs: 1_000,
    })) as { status: string; cursor?: { sessionId: string; streamEpoch: string; seq: string } }
    expect(sent.status).toBe('timeout')
    const cursor = sent.cursor
    if (cursor === undefined) throw new Error('a timeout answer must carry the resume cursor')
    expect(cursor.sessionId).toBe(SESSION.sessionId)
    // Seq 0: the session's buffer holds NOTHING at this point — the run's
    // events land after the send — so the reported cursor is the layer's own
    // `state.cursor`, i.e. the EMPTY-BUFFER baseline this issue is about.
    // `cherry_events` refused exactly this value.
    expect(cursor.seq).toBe('0')

    // Two more events arrive after it.
    rig.fake.pushEvent(SESSION.sessionId, {
      kind: 'execution.updated',
      payload: { executionId: 'exec-extra-1', status: 'running', messageId: 'm-extra-1' },
    })
    rig.fake.pushEvent(SESSION.sessionId, {
      kind: 'execution.updated',
      payload: { executionId: 'exec-extra-2', status: 'running', messageId: 'm-extra-2' },
    })
    // The peer's notifications are asynchronous: wait for BOTH to reach the
    // session buffer before reading, exactly as the other suites do.
    await waitFor(() => {
      const read = rig.subs().read(SESSION.sessionId)
      return 'events' in read && read.events.length === 2
    }, 3_000, 'both events cached')

    // THE ISSUE'S SCENARIO: with that boundary position refused, this call
    // answered `{error: 'cursor-out-of-window'}` and the caller had nowhere to
    // go — the cursor it was handed could never be used. It must now DELIVER
    // the two events newer than that cursor.
    const events = (await rig.call('cherry_events', {
      device: 'dev-A',
      sessionId: SESSION.sessionId,
      cursor,
    })) as { events?: Array<{ kind: string }>; nextCursor?: { seq: string }; error?: string }
    expect(events.error).toBeUndefined()
    expect(events.events?.map((event) => event.kind)).toEqual(['execution.updated', 'execution.updated'])
    expect(events.nextCursor?.seq).toBe('2')

    // ...and the delivery advanced the peer's own view, as any delivery does.
    await waitFor(() => rig.fake.ackCalls.length >= 1, 3_000, 'the delivery ack')
    expect(rig.fake.ackCalls.at(-1)!.cursor.seq).toBe('2')
  }, 20_000)

  it('N3b an EMPTY window answers the baseline itself as the resume cursor instead of a verdict', async () => {
    // The other half of the same contradiction: with nothing buffered at all,
    // `cherry_events` used to answer `cursor-out-of-window` whose OWN
    // `windowStart` was the position it had just refused — a verdict the caller
    // could not act on, because following its advice returned the same verdict.
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION.sessionId })
    await waitFor(
      () => rig.fake.subscriptions.some((entry) => entry.sessionId === SESSION.sessionId),
      3_000,
      'the session subscription',
    )

    const first = (await rig.call('cherry_events', {
      device: 'dev-A',
      sessionId: SESSION.sessionId,
    })) as { events?: unknown[]; nextCursor?: { seq: string }; error?: string }
    expect(first.error).toBeUndefined()
    expect(first.events).toEqual([])
    expect(first.nextCursor?.seq).toBe('0')

    // Following it back in is a no-op, not a refusal — the round trip a caller
    // actually makes while polling for the first event.
    const again = (await rig.call('cherry_events', {
      device: 'dev-A',
      sessionId: SESSION.sessionId,
      cursor: first.nextCursor,
    })) as { events?: unknown[]; error?: string }
    expect(again.error).toBeUndefined()
    expect(again.events).toEqual([])
  })

  it('N3c still answers the structured verdict for a cursor BELOW the window start', async () => {
    // The refusal is not gone — it moved to where it belongs. A position the
    // layer never issued and cannot vouch for (below the baseline) is still out
    // of window, and the verdict still carries the servable boundary.
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION.sessionId })
    await waitFor(
      () => rig.fake.subscriptions.some((entry) => entry.sessionId === SESSION.sessionId),
      3_000,
      'the session subscription',
    )

    const result = (await rig.call('cherry_events', {
      device: 'dev-A',
      sessionId: SESSION.sessionId,
      cursor: { sessionId: SESSION.sessionId, streamEpoch: 'epoch-1', seq: '-1' },
    })) as { error?: string; windowStart?: { seq: string } }
    expect(result.error).toBe('cursor-out-of-window')
    expect(result.windowStart?.seq).toBe('0')
  })
})

/**
 * The three failure warps of the ack/re-ensure path (issue #161), driven
 * through the REAL tool registration against a real loopback peer. Each used to
 * hand the error OBJECT to `console.warn`, so the console chose the rendering;
 * each must now be ONE bounded string, and the peer's own ledger must still show
 * the WORK (a logged line is not evidence that a recovery was attempted).
 */
describe('log text is bounded: ack and background re-ensure (issue #161)', () => {
  /** The shared shape every converted line must satisfy. */
  function oneBoundedLine(prefix: string, longText: string): string {
    const call = vi
      .mocked(console.warn)
      .mock.calls.find((entry) => String(entry[0]).startsWith(prefix))
    expect(call, `the warning "${prefix}" must be logged`).toBeDefined()
    // ONE STRING: a second argument is what let the console render the object.
    expect(call!).toHaveLength(1)
    const line = String(call![0])
    expect(line.length).toBeLessThanOrEqual(prefix.length + LOG_TEXT_MAX)
    expect(line).toMatch(/… \(\+\d+ chars\)$/)
    const detail = line.slice(prefix.length)
    const kept = detail.indexOf('…')
    expect(kept).toBeGreaterThan(0)
    expect(kept + detail.slice(kept).length).toBe(LOG_TEXT_MAX)
    expect(detail).toBe(longText.slice(0, kept) + `… (+${longText.length - kept} chars)`)
    expect(line).not.toContain(longText)
    return line
  }

  it('⑱a renders the failed ACK as ONE bounded string, then re-ensures in the background', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION.sessionId })
    const subscribesBefore = rig.fake.subscribeCalls.length
    const longMessage = 'a'.repeat(512)
    // The cursor the tool will ACK: no event arrives between this read and the
    // call, so this is also the `nextCursor` the tool reports and acks.
    const baseline = rig.subs().read(SESSION.sessionId)
    if (!('events' in baseline)) throw new Error('expected events')
    rig.fake.refuseAcks({ reason: 'CONFLICT', message: longMessage })
    vi.mocked(console.warn).mockClear()

    await rig.call('cherry_events', { device: 'dev-A', sessionId: SESSION.sessionId })

    // WORK PIN: the failed ack must actually drive a background re-ensure, or
    // the log line would be describing a recovery that never ran.
    await waitFor(
      () => rig.fake.subscribeCalls.length > subscribesBefore,
      3_000,
      'the background re-subscribe the failed ack triggers',
    )
    expect(rig.fake.subscribeCalls.at(-1)!.sessionId).toBe(SESSION.sessionId)
    oneBoundedLine(
      `[cherry-remote] acknowledging session ${SESSION.sessionId} at ${baseline.nextCursor.seq} failed: `,
      longMessage,
    )
  })

  it('⑱b renders the background RE-ENSURE failure as ONE bounded string', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION.sessionId })
    // The PEER refuses the replacement subscription. Its message is
    // `Subscribe refused (<reason>)`, so a 300-char reason puts the line far
    // above LOG_TEXT_MAX while the failure stays a peer JSON-RPC error.
    const longReason = 'e'.repeat(300)
    rig.fake.refuseAcks({ reason: 'CONFLICT', message: 'ack refused by the peer' })
    rig.fake.refuseSubscriptions(longReason)
    vi.mocked(console.warn).mockClear()

    await rig.call('cherry_events', { device: 'dev-A', sessionId: SESSION.sessionId })

    const prefix = `[cherry-remote] re-ensuring session ${SESSION.sessionId} of dev-A failed: `
    await vi.waitFor(
      () => {
        expect(
          vi.mocked(console.warn).mock.calls.some((entry) => String(entry[0]).startsWith(prefix)),
        ).toBe(true)
      },
      3_000,
    )
    // The peer's ledger shows the refused attempt: the recovery ran and its
    // failure was logged, not invented by the log line.
    expect(
      rig.fake.subscribeCalls.some(
        (call) => call.sessionId === SESSION.sessionId && call.mode === 'error',
      ),
    ).toBe(true)
    oneBoundedLine(prefix, `Subscribe refused (${longReason})`)
  })

  it('⑱c renders a throwing subs ACCESSOR in the re-ensure as ONE bounded string', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })
    await rig.call('cherry_read', { device: 'dev-A', sessionId: SESSION.sessionId })
    const subscribesBefore = rig.fake.subscribeCalls.length
    rig.fake.refuseAcks({ reason: 'CONFLICT', message: 'ack refused by the peer' })
    // `cherry_events` resolves the layer TWICE before the ack (the tool's own
    // read and `#ensureSubscription`); the THIRD access is the background
    // re-ensure. The accessor's throw is LOCAL (no device / unloaded identity),
    // and this is the only way to drive that defensive arm.
    const longMessage = 'z'.repeat(3_000)
    rig.failSubsAfter(2, new Error(longMessage))
    vi.mocked(console.warn).mockClear()

    await rig.call('cherry_events', { device: 'dev-A', sessionId: SESSION.sessionId })

    const prefix = `[cherry-remote] could not re-ensure session ${SESSION.sessionId} of dev-A: `
    oneBoundedLine(prefix, longMessage)
    // The accessor threw BEFORE `ensure` was reached, so the peer must NOT have
    // seen a re-subscribe attempt — that is what makes this arm its own branch
    // rather than a duplicate of ⑱b.
    expect(rig.fake.subscribeCalls.length).toBe(subscribesBefore)
  })
})
