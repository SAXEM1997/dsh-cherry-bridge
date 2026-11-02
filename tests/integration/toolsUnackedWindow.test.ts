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
 * Issue #212: the peer's UN-ACKED DELIVERY WINDOW.
 *
 * The real desktop delivers `agent.events` per subscription until the bytes it
 * has sent since the last `agent.subscriptions.ack` reach
 * `remoteLimits.unackedBytes` (262144), then it HOLDS — silently, with the
 * subscription still live — until an ack frees budget. A held batch can be the
 * run's terminal `execution.updated`.
 *
 * `cherry_send(wait: true)` parks on the subscription's buffer and folds every
 * arrival, but it never acked ("waiters consume, they do not acknowledge"), so
 * a run whose live stream exceeds one window filled the budget and the waiter
 * parked out its WHOLE window on a buffer that could never advance. The 2026-11-02
 * device evidence: a run committed on the desktop 22 s in, the tool answered
 * `timeout` 240 s in with the finished text, and the stream cursor sat frozen at
 * `seq 666` (262144 / 666 ≈ 394 bytes/event — the window, to the byte).
 *
 * The fix acks what the layer has already buffered. The cases below pin the
 * OUTCOME (the terminal arrives) and the WORK (the peer's own ack ledger), not
 * the client's opinion of either.
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
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  /** The live subscription layer, for the "the waiter is parked" precondition. */
  subscriptions(): SessionSubscriptions
  stop(): Promise<void>
}

interface RigOptions {
  engine?: CherryToolEngineOptions
}

interface RigDeps {
  fake: FakeCherry
  store: DeviceStore
  tmp: string
  subsFor(deviceId: string): SessionSubscriptions
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

async function makeRig(options: FakeCherryOptions = {}, rigOptions: RigOptions = {}): Promise<Rig & RigDeps> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-tools-unacked-'))
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

  const connect = (deviceId: string): DeviceConnection => {
    const existing = connections.get(deviceId)
    if (existing !== undefined) return existing
    const stored = store.list().find((entry) => entry.deviceId === deviceId)
    if (stored === undefined) throw new Error(`no device ${deviceId}`)
    const connection = new DeviceConnection({
      identity,
      record: stored,
      // The production 32 req/s budget would pace the wait's polling AND the
      // auto-acks against the clock under test.
      rateBudgetPerSecond: 10_000,
    })
    connections.set(deviceId, connection)
    return connection
  }

  const subsFor = (deviceId: string): SessionSubscriptions => {
    const existing = subscriptions.get(deviceId)
    if (existing !== undefined) return existing
    const connection = connect(deviceId)
    const created = new SessionSubscriptions(connection.rpc, {
      subscriptionsLimit: options.agent?.subscriptionLimit ?? 8,
      // Mirrors `src/index.ts`'s factory: a PROVIDER over the peer's own
      // hello-advertised window, absent falling back to the pinned constant.
      unackedBytes: () => connection.limits.unackedBytes,
    })
    connection.rpc.onNotification((method, params) => created.handleNotification(method, params))
    subscriptions.set(deviceId, created)
    return created
  }

  const ctx = makeCtx()
  const deps: CherryToolsDeps = {
    store,
    connect,
    subs: subsFor,
    pair: async () => {
      throw new Error('pairing is not exercised by the un-acked-window suite')
    },
    evict: () => {
      throw new Error('the un-acked-window suite never evicts a device')
    },
  }
  registerCherryTools(ctx, deps, rigOptions.engine ?? {})
  const connection = connect('dev-A')
  await connection.connect()

  const rig: Rig & RigDeps = {
    fake,
    store,
    tmp,
    subsFor,
    subscriptions: () => subsFor('dev-A'),
    call: (name, args = {}) => {
      const found = ctx.definitions.find((definition) => definition.name === name)
      if (found === undefined) throw new Error(`tool ${name} is not registered`)
      return found.execute(args)
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

const AGENT = { agentId: 'agent-1', name: 'Agent One' }

const SESSION = {
  sessionId: 's-1',
  agentId: 'agent-1',
  workspaceId: 'ws-1',
  title: 'Session s-1',
  historyRevision: '1',
}

const TERMINAL_MESSAGE: FakeMessageRecord = {
  messageId: 'm-assistant',
  revision: '1',
  role: 'assistant',
  status: 'success',
  parts: [{ kind: 'text', text: 'the run reply' }],
}

/** One streamed chunk, sized so ~240 of them fill the 256 KiB window. */
const CHUNK = 'x'.repeat(900)
const CHUNKS = 300

describe('#212: the peer’s un-acked delivery window cannot stall a wait', () => {
  it('①a a run whose stream exceeds one window still delivers its terminal (not `timeout`)', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        terminalMessage: TERMINAL_MESSAGE,
        // The terminal lands well after the stream, so the wait has to survive
        // the window rather than race it. 2 s clears `vi.waitFor`'s 1 s default
        // budget with margin, so the parking assertion below cannot outrun the
        // run (and slip the events in after the terminal).
        runDelayMs: 2000,
      },
    })

    const pending = rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'hello',
      // Short enough that a stalled wait answers `timeout` INSIDE the test,
      // long enough that a healthy one settles at runDelayMs (2 s).
      timeoutMs: 4000,
    }) as Promise<{ status: string; text?: string }>

    // The precondition the bug turns on: a waiter PARKED on the buffer while
    // more than one window worth of events arrives behind it.
    await vi.waitFor(() => expect(rig.subscriptions().waiterCount('s-1')).toBe(1), 3_000)
    // The run has NOT settled yet: only then does the stream below force the
    // peer to hold the terminal. Without this the test could pass because the
    // terminal beat the chunks, which is the same verdict for the wrong reason.
    expect(rig.fake.executionUpdates.filter((update) => update.status !== 'running')).toHaveLength(0)
    for (let index = 0; index < CHUNKS; index += 1) {
      rig.fake.pushEvent('s-1', {
        kind: 'part.append',
        payload: {
          messageId: 'm-assistant',
          partId: 'p-1',
          revision: String(index + 1),
          offsetUtf8: String(index * 900),
          text: CHUNK,
        },
      })
    }

    // The peer's window really did HOLD the tail (the pushes are synchronous,
    // so no ack could have fired yet): this is the state that stalls the wait.
    expect(rig.fake.heldEventCount).toBeGreaterThan(0)

    const result = await pending
    expect(result.status).toBe('completed')
    expect(result.text).toContain('the run reply')
    // The WORK, on the peer's own ledger: the wait acked while it was parked,
    // which is the only thing that frees a held terminal — and nothing is left
    // in the queue afterwards.
    expect(rig.fake.ackCalls.length).toBeGreaterThan(0)
    expect(rig.fake.heldEventCount).toBe(0)
  })

  it('①c a refused auto-ack retries on its own timer, with NO new traffic', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })
    await rig.subscriptions().ensure('s-1')
    rig.fake.refuseAcks({ reason: 'INTERNAL', message: 'ack refused on purpose' })
    for (let index = 0; index < CHUNKS; index += 1) {
      rig.fake.pushEvent('s-1', {
        kind: 'part.append',
        payload: {
          messageId: 'm-assistant',
          partId: 'p-1',
          revision: String(index + 1),
          offsetUtf8: String(index * 900),
          text: CHUNK,
        },
      })
    }
    await vi.waitFor(() => expect(rig.fake.ackCalls.length).toBe(1), 3_000)

    // The peer recovers, and NOTHING more is pushed: once the window is full the
    // desktop sends nothing, so only the armed timer can recover this — the
    // shape that made an ack failure re-create issue #212.
    rig.fake.refuseAcks(undefined)
    await vi.waitFor(() => expect(rig.fake.ackCalls.length).toBe(2), 8_000)
    await vi.waitFor(() => expect(rig.fake.heldEventCount).toBe(0), 3_000)
  }, 20_000)

  it('①d the ack watermark follows the peer’s hello-advertised window', async () => {
    // A peer whose window is 32 KiB — an eighth of the pinned constant. A
    // hardcoded 64 KiB watermark would never fire before this peer held, so the
    // terminal would be stuck behind the hold (the negotiation is the point).
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        terminalMessage: TERMINAL_MESSAGE,
        runDelayMs: 2000,
        unackedBytes: 32_768,
      },
    })

    const pending = rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'hello',
      timeoutMs: 4000,
    }) as Promise<{ status: string; text?: string }>

    await vi.waitFor(() => expect(rig.subscriptions().waiterCount('s-1')).toBe(1), 3_000)
    for (let index = 0; index < CHUNKS; index += 1) {
      rig.fake.pushEvent('s-1', {
        kind: 'part.append',
        payload: {
          messageId: 'm-assistant',
          partId: 'p-1',
          revision: String(index + 1),
          offsetUtf8: String(index * 900),
          text: CHUNK,
        },
      })
    }

    // Same precondition as ①a: the peer must actually be HOLDING (the pushes
    // are synchronous, so no ack has fired yet) or this proves nothing.
    expect(rig.fake.heldEventCount).toBeGreaterThan(0)

    const result = await pending
    expect(result.status).toBe('completed')
    expect(result.text).toContain('the run reply')
    expect(rig.fake.ackCalls.length).toBeGreaterThan(0)
    expect(rig.fake.heldEventCount).toBe(0)
  })

  it('①e an explicit ack below the frontier is coalesced, not refused', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })
    await rig.subscriptions().ensure('s-1')
    // JUST over one watermark (~82 KiB): one auto-ack, nothing held, and no
    // second ack left in flight — so the explicit ack below is deterministic.
    for (let index = 0; index < 80; index += 1) {
      rig.fake.pushEvent('s-1', {
        kind: 'part.append',
        payload: {
          messageId: 'm-assistant',
          partId: 'p-1',
          revision: String(index + 1),
          offsetUtf8: String(index * 900),
          text: CHUNK,
        },
      })
    }
    // An auto-ack has advanced the peer's single `lastAck`.
    await vi.waitFor(() => expect(rig.fake.ackCalls.length).toBeGreaterThan(0), 3_000)
    const layer = rig.subscriptions()
    const frontier = layer.cursorOf('s-1')!
    expect(Number(frontier.seq)).toBeGreaterThan(1)

    // A LOWER position — what a read taken before the auto-ack would carry. The
    // peer refuses a lower `lastAck` with CONFLICT, so the layer must coalesce
    // to the frontier instead of racing itself into a re-subscribe.
    await expect(
      layer.ack('s-1', { sessionId: 's-1', streamEpoch: frontier.streamEpoch, seq: '1' }),
    ).resolves.toBeUndefined()
    expect(rig.fake.ackCalls.at(-1)?.cursor.seq).toBe(frontier.seq)
  })

  it('①b a refused auto-ack is surfaced once and does not storm the peer', async () => {
    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })
    // The subscription has to exist before anything can be held for it; a bare
    // `ensure` is the layer's own entry point, no tool call needed.
    await rig.subscriptions().ensure('s-1')
    rig.fake.refuseAcks({ reason: 'INTERNAL', message: 'ack refused on purpose' })

    for (let index = 0; index < CHUNKS; index += 1) {
      rig.fake.pushEvent('s-1', {
        kind: 'part.append',
        payload: {
          messageId: 'm-assistant',
          partId: 'p-1',
          revision: String(index + 1),
          offsetUtf8: String(index * 900),
          text: CHUNK,
        },
      })
    }

    // ONE attempt inside the burst: the failure arms the cooldown + its timer,
    // so the next 40 held batches cannot each become a round trip.
    await vi.waitFor(() => expect(rig.fake.ackCalls.length).toBe(1), 3_000)
    await vi.waitFor(
      () =>
        expect(console.warn).toHaveBeenCalledWith(
          expect.stringContaining('auto-ack for session s-1 failed'),
        ),
      3_000,
    )
    // Still one: the retry timer (3 s) is longer than this test.
    expect(rig.fake.ackCalls.length).toBe(1)
    // BOUNDED, not merely present: the refusal text is clipped before it is
    // rendered (`failureText`, LOG_TEXT_MAX), so one long peer message cannot
    // flood a log line.
    const warnLine = vi.mocked(console.warn).mock.calls.at(-1)?.[0]
    expect(typeof warnLine).toBe('string')
    expect(String(warnLine).length).toBeLessThan(320)
    // The refusal does not break delivery — the window holds it, honestly.
    expect(rig.fake.heldEventCount).toBeGreaterThan(0)
  })
})
