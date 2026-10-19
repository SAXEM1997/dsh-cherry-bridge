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
import type { FakeCherryOptions, FakeMessageRecord, FakeSessionRecord } from '../loopback/fakeCherry.js'

/**
 * Issue #39: the engine's process-wide gate over `{ref}` assembly.
 *
 * The memory contract is "one ref's assembly peaks at ~3× its size". That is a
 * PER-REF product; before this gate, independent tool calls multiplied it by
 * their number in flight, with nothing anywhere bounding that number. The gate
 * makes the process peak `limit × 3 × 32 MiB`.
 *
 * What an integration test can show is exactly what the unit suite cannot: that
 * the ENGINE holds a slot for the whole assembly. Two concurrent `cherry_read`s
 * over sessions with one externalized part each must not have two
 * `agent.content.read` walks in flight when the limit is one — and must, when
 * the limit allows it (the second case proves the instrument can see two, so
 * the first is not a test that passes because nothing ran concurrently).
 *
 * The peak is measured AT THE PEER: `onArrival` is a PASSIVE observer that runs
 * as a frame arrives (the consuming hooks answer nothing, and using one here
 * would stall every content read), and `afterNextRead` — re-armed from inside
 * its own hook — decrements once the handler has served it. With the peer's own
 * `requestDelayMs` holding each content read open, overlapping walks are
 * visible as a peak of 2.
 */

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

async function makeRig(
  options: FakeCherryOptions = {},
  rigOptions: CherryToolEngineOptions = {},
): Promise<Rig> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-content-gate-'))
  const store = new DeviceStore(join(tmp, 'devices.json'))

  store.upsert({
    schemaVersion: 2,
    deviceId: 'dev-A',
    displayName: 'Desk Alpha',
    hosts: [host],
    port,
    desktopIdentity,
    grants: ['agent'] as 'agent'[],
    enabled: true,
  })

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
      // The gate, not pacing, is what these cases measure.
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
      throw new Error('pairing is not exercised by the content-gate suite')
    },
    evict: () => {
      throw new Error('the content-gate suite never evicts')
    },
  }
  registerCherryTools(ctx, deps, rigOptions)
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

const AGENT = { agentId: 'agent-1', name: 'Agent One' }

/** One session whose single assistant message carries ONE externalized part. */
function sessionWithRef(sessionId: string): { session: FakeSessionRecord; messages: FakeMessageRecord[] } {
  return {
    session: {
      sessionId,
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      title: sessionId,
      historyRevision: '1',
    },
    messages: [
      {
        messageId: `${sessionId}-m1`,
        revision: '1',
        role: 'assistant',
        status: 'success',
        // `external: true` forces the `{ref}` form: this part is served only
        // through `agent.content.read`, which is the walk the gate covers.
        parts: [{ kind: 'text', text: 'R'.repeat(256), external: true }],
      },
    ],
  }
}

/**
 * Arms the peak detector: count `agent.content.read` frames the peer is holding
 * open, and remember the maximum.
 */
function watchContentPeak(fake: FakeCherry): { peak: () => number } {
  let active = 0
  let peak = 0
  // PASSIVE arrival observation (`onArrival`) — the consuming hooks
  // (`alwaysBeforeCall`) answer nothing, which would stall every content read.
  fake.onArrival('agent.content.read', () => {
    active += 1
    if (active > peak) peak = active
  })
  const rearm = (): void => {
    fake.afterNextRead('agent.content.read', () => {
      active -= 1
      rearm()
    })
  }
  rearm()
  return { peak: () => peak }
}

type ReadResult = { messages: Array<{ parts: Array<{ content: string; unavailable?: string }> }> }

describe('issue #39: the content-read gate caps concurrent {ref} assembly', () => {
  it('T1 with limit 1, two concurrent reads never have two content walks in flight', async () => {
    const a = sessionWithRef('s-a')
    const b = sessionWithRef('s-b')
    const rig = await makeRig(
      {
        requestDelayMs: 120,
        agent: { agents: [AGENT], sessions: [a.session, b.session], messages: [...a.messages, ...b.messages] },
      },
      { contentReadConcurrency: 1 },
    )
    const peak = watchContentPeak(rig.fake)

    const [readA, readB] = (await Promise.all([
      rig.call('cherry_read', { device: 'dev-A', sessionId: 's-a' }),
      rig.call('cherry_read', { device: 'dev-A', sessionId: 's-b' }),
    ])) as [ReadResult, ReadResult]

    // Both reads succeeded (the gate serializes, it does not starve), and the
    // peer never held two content reads at once.
    expect(readA.messages[0]?.parts[0]?.content).toHaveLength(256)
    expect(readB.messages[0]?.parts[0]?.content).toHaveLength(256)
    expect(readA.messages[0]?.parts[0]?.unavailable).toBeUndefined()
    expect(readB.messages[0]?.parts[0]?.unavailable).toBeUndefined()
    // FOUR, not two: the fake serves its whole `messages` fixture for ANY
    // session id (a loopback simplification), so each read projects both
    // messages' refs. The peak is what this test is about.
    expect(rig.fake.methodCount('agent.content.read')).toBe(4)
    expect(peak.peak()).toBe(1)
  }, 20_000)

  it('T2 with the default limit the SAME fixture runs two walks at once (the detector can see it)', async () => {
    // The control for T1: without the gate's limit the two reads do overlap, so
    // T1 is measuring serialization and not the absence of concurrency.
    const a = sessionWithRef('s-a')
    const b = sessionWithRef('s-b')
    const rig = await makeRig({
      requestDelayMs: 120,
      agent: { agents: [AGENT], sessions: [a.session, b.session], messages: [...a.messages, ...b.messages] },
    })
    const peak = watchContentPeak(rig.fake)

    await Promise.all([
      rig.call('cherry_read', { device: 'dev-A', sessionId: 's-a' }),
      rig.call('cherry_read', { device: 'dev-A', sessionId: 's-b' }),
    ])

    expect(rig.fake.methodCount('agent.content.read')).toBe(4)
    expect(peak.peak()).toBe(2)
  }, 20_000)

  it('T3 a failing content read RELEASES its slot, so the next read is not blocked', async () => {
    const a = sessionWithRef('s-a')
    const b = sessionWithRef('s-b')
    const rig = await makeRig(
      {
        agent: { agents: [AGENT], sessions: [a.session, b.session], messages: [...a.messages, ...b.messages] },
      },
      { contentReadConcurrency: 1 },
    )
    const failed = await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-a' }) as ReadResult
    rig.fake.setReadFailure('agent.content.read', { reason: 'NOT_FOUND', message: 'content pin expired' })

    // Re-run the first read with the fault in place: the part degrades (the
    // degradable class) and the slot must be released by `finally`.
    const degraded = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-a' })) as ReadResult
    // `unavailable` carries the peer's REASON (not its message): the projection
    // reports the machine-readable code so a caller can branch on it.
    expect(degraded.messages[0]?.parts[0]?.unavailable).toBe('NOT_FOUND')
    expect(failed.messages[0]?.parts[0]?.unavailable).toBeUndefined()

    // A different read still gets a slot: if the failure had leaked it, with a
    // limit of one this call would queue forever (and the test would time out).
    const after = (await rig.call('cherry_read', { device: 'dev-A', sessionId: 's-b' })) as ReadResult
    expect(after.messages[0]?.parts[0]?.content).toHaveLength(256)
    expect(after.messages[0]?.parts[0]?.unavailable).toBeUndefined()
  }, 20_000)
})
