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
        // the window rather than race it.
        runDelayMs: 1500,
      },
    })

    const pending = rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'hello',
      // Short enough that a stalled wait answers `timeout` INSIDE the test,
      // long enough that a healthy one settles at runDelayMs (1.5 s).
      timeoutMs: 3000,
    }) as Promise<{ status: string; text?: string }>

    // The precondition the bug turns on: a waiter PARKED on the buffer while
    // more than one window worth of events arrives behind it.
    await vi.waitFor(() => expect(rig.subscriptions().waiterCount('s-1')).toBe(1))
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

    const result = await pending
    expect(result.status).toBe('completed')
    expect(result.text).toContain('the run reply')
    // The WORK, on the peer's own ledger: the wait acked while it was parked,
    // which is the only thing that frees a held terminal.
    expect(rig.fake.ackCalls.length).toBeGreaterThan(0)
  })
})
