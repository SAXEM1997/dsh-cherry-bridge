import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { QUARANTINE_RECOVERY } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import { CherryToolEngine } from '../../src/tools.js'
import type { CherryToolEngineOptions, CherryToolsDeps, SubagentTargetAgent } from '../../src/tools.js'
import { JsonRpcRequestError, RequestTimeoutError } from '../../src/rpc/jsonRpcClient.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeAgentRecord, FakeCherryOptions, FakeWorkspaceRecord } from '../loopback/fakeCherry.js'

/**
 * The candidate seam behind `GET /cherry-remote/api/subagent/targets` (#260):
 * `CherryToolEngine.listTargets(device, agentId?)`.
 *
 * WHY THIS IS NOT A TOOL TEST. The endpoint exists so the settings page can
 * offer the device's agents and workspaces as DROPDOWNS instead of asking an
 * operator to copy ids out of the model tool's output. It therefore needs the
 * same two capabilities the read tools have — the shared device resolution and
 * the page-aggregating walk — WITHOUT registering a fifteenth tool, so it is a
 * public method on the engine and is driven here directly.
 *
 * WHAT THE RIG IS. A real `DeviceConnection` (real Noise XX, real hello, real
 * pagination) against the loopback fake desktop, and a real `DeviceStore`. The
 * engine is the production one. Nothing about the resolution, the wait or the
 * aggregation is doubled: the cases below pin the four device verdicts, the
 * `connecting` wait, the multi-page aggregation and the safety-bound
 * truncation through the code every tool already uses.
 */

const PAGE_ITEMS = 100

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

interface Rig {
  fake: FakeCherry
  engine: CherryToolEngine
  store: DeviceStore
  tmp: string
  /** Dial a seeded device explicitly (the rig only dials dev-A by default). */
  dial(deviceId: string): Promise<void>
  stop(): Promise<void>
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
  /** Extra paired devices to seed (so a prefix can be ambiguous). */
  extraDevices?: Array<{ deviceId: string; displayName: string }>
  /** Connection options forwarded to `DeviceConnection`. */
  connection?: { rateBudgetPerSecond?: number; rpcTimeoutMs?: number }
  /** Skip `connect()` so the device stays offline (the §6 offline face). */
  skipConnect?: boolean
  /** How long the seam waits for an IN-FLIGHT dial before judging it. */
  deviceSettleWaitMs?: number
  engine?: CherryToolEngineOptions
}

async function makeRig(options: FakeCherryOptions = {}, rigOptions: RigOptions = {}): Promise<Rig> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-targets-'))
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
  for (const extra of rigOptions.extraDevices ?? []) {
    store.upsert({ ...record, deviceId: extra.deviceId, displayName: extra.displayName, enabled: false })
  }

  const connections = new Map<string, DeviceConnection>()
  const connect = (deviceId: string): DeviceConnection => {
    const existing = connections.get(deviceId)
    if (existing !== undefined) return existing
    const stored = store.list().find((entry) => entry.deviceId === deviceId)
    if (stored === undefined) throw new Error(`no device ${deviceId}`)
    const connection = new DeviceConnection({ identity, record: stored, ...(rigOptions.connection ?? {}) })
    connections.set(deviceId, connection)
    return connection
  }

  const deps: CherryToolsDeps = {
    store,
    connect,
    // The candidate seam never touches subscriptions: it walks two LIST methods
    // and needs no event stream. A throwing stub says so instead of quietly
    // building an LRU pool the seam would never use.
    subs: () => {
      throw new Error('the candidate seam never subscribes')
    },
    pair: async () => {
      throw new Error('pairing is covered by its own suite')
    },
    evict: () => {
      throw new Error('the candidate seam never evicts')
    },
    ...(rigOptions.deviceSettleWaitMs === undefined ? {} : { deviceSettleWaitMs: rigOptions.deviceSettleWaitMs }),
  }

  const engine = new CherryToolEngine(deps, rigOptions.engine ?? {})
  if (rigOptions.skipConnect !== true) await connect('dev-A').connect()

  const rig: Rig = {
    fake,
    engine,
    store,
    tmp,
    dial: async (deviceId) => {
      await connect(deviceId).connect()
    },
    stop: async () => {
      for (const connection of connections.values()) await connection.close()
      await fake.stop()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
  rigs.push(rig)
  return rig
}

/** The agents fixture: `count` agents, each with a human-readable name. */
function agentsFixture(count: number): FakeAgentRecord[] {
  return Array.from({ length: count }, (_unused, index) => ({
    agentId: `agent-${String(index).padStart(3, '0')}`,
    name: `Agent ${index}`,
  }))
}

describe('listTargets: the settings page’s candidate source (#260)', () => {
  it('① lists the device’s agents WITH their names, aggregated across more than one page', async () => {
    // 20 agents against a 16-item byte-safe per-page clamp is TWO real pages, so
    // this asserts the aggregation as well as the projection: a seam that read
    // only the first page would answer 16 rows and silently drop four.
    const rig = await makeRig({ agent: { agents: agentsFixture(20) } })

    const outcome = await rig.engine.listTargets('dev-A')

    expect('error' in outcome).toBe(false)
    const agents = (outcome as { agents: Array<{ agentId: string; name?: string }> }).agents
    expect(agents).toHaveLength(20)
    // Both ends, so the walk's ORDER and its reach past the first page are
    // asserted at once — a first-page-only seam answers 16 rows ending at 015.
    expect(agents[0]).toEqual({ agentId: 'agent-000', name: 'Agent 0' })
    expect(agents[19]).toEqual({ agentId: 'agent-019', name: 'Agent 19' })
    expect(rig.fake.readCallsFor('agent.agents.list')).toHaveLength(2)
  })

  it('② reports a truncated walk instead of pretending the list is complete', async () => {
    // The endpoint has NO `limit` parameter: the walk runs to the same internal
    // safety bound `cherry_agents` defaults to, so a caller cannot widen it and
    // the stop reason must be `safety-bound` rather than `limit`.
    const rig = await makeRig({ agent: { agents: agentsFixture(1001) } })

    const outcome = (await rig.engine.listTargets('dev-A')) as {
      agents: unknown[]
      truncated?: { lists: string[]; reason: string }
    }

    expect(outcome.agents).toHaveLength(1000)
    // `lists` is what says WHICH walk was cut: an agent list of 1,001 beside no
    // workspace request truncates exactly one of them.
    expect(outcome.truncated).toEqual({ lists: ['agents'], reason: 'safety-bound' })
  })

  it('②b a truncated WORKSPACE walk is named as such, not lumped in with the agents', async () => {
    // The two walks share one bound and one reason, so `lists` is the only field
    // that can say WHICH one was cut. Two agents beside 1,001 workspaces must
    // report the workspaces alone — an implementation that pushed a constant, or
    // that shared one flag, answers the wrong list here.
    const workspaces: FakeWorkspaceRecord[] = Array.from({ length: 1001 }, (_unused, index) => ({
      workspaceId: `ws-${String(index).padStart(4, '0')}`,
      name: `Repo ${index}`,
    }))
    const rig = await makeRig({ agent: { agents: agentsFixture(2), workspaces } })

    const outcome = (await rig.engine.listTargets('dev-A', 'agent-000')) as {
      agents: unknown[]
      workspaces: unknown[]
      truncated?: { lists: string[]; reason: string }
    }

    expect(outcome.agents).toHaveLength(2)
    expect(outcome.workspaces).toHaveLength(1000)
    expect(outcome.truncated).toEqual({ lists: ['workspaces'], reason: 'safety-bound' })
  })

  it('③ with an agentId it ALSO answers that agent’s workspaces and the system-workspace flag', async () => {
    const workspaces: FakeWorkspaceRecord[] = [
      { workspaceId: 'ws-1', name: 'Repo One' },
      { workspaceId: 'ws-2', name: 'Repo Two' },
    ]
    const rig = await makeRig({ agent: { agents: agentsFixture(2), workspaces } })

    const outcome = (await rig.engine.listTargets('dev-A', 'agent-001')) as {
      agents: unknown[]
      workspaces?: Array<{ workspaceId: string; name?: string }>
      systemWorkspace?: boolean
    }

    // The agents come back too: the page renders one form, and asking twice for
    // two halves of it would let the two halves disagree.
    expect(outcome.agents).toHaveLength(2)
    expect(outcome.workspaces).toEqual([
      { workspaceId: 'ws-1', name: 'Repo One' },
      { workspaceId: 'ws-2', name: 'Repo Two' },
    ])
    // The peer's flag is passed through verbatim. The loopback fake hardcodes
    // `true` today (a knob for the `false` case is #263's job), so this asserts
    // the passthrough, not a fixture choice.
    expect(outcome.systemWorkspace).toBe(true)
    // The walk is scoped to the agent the caller named.
    expect(rig.fake.readCallsFor('agent.workspaces.list')[0]).toMatchObject({ agentId: 'agent-001' })
  })

  it('④ a selector that matches nothing answers not-found with the ids it could have meant', async () => {
    const rig = await makeRig()

    const outcome = await rig.engine.listTargets('no-such-device')

    expect(outcome).toEqual({ error: 'not-found', device: 'no-such-device', known: ['dev-A'] })
  })

  it('⑤ a selector matching several devices answers ambiguous-device with the candidates', async () => {
    const rig = await makeRig(
      {},
      {
        extraDevices: [{ deviceId: 'dev-B', displayName: 'Desk Beta' }],
        skipConnect: true,
      },
    )

    const outcome = await rig.engine.listTargets('Desk')

    expect(outcome).toMatchObject({ error: 'ambiguous-device', device: 'Desk' })
    expect((outcome as { candidates: string[] }).candidates).toHaveLength(2)
  })

  it('⑥ an OFFLINE device answers device-unavailable, and the seam never dials on its own', async () => {
    // The state a route copying `#linkOr` would turn into a 500: the tool face
    // THROWS `DeviceUnavailableError` there, so the candidate seam has to answer
    // the same verdict in band. Driven through the real resolution, with no
    // verdict handed in.
    const rig = await makeRig({}, { skipConnect: true })

    const outcome = await rig.engine.listTargets('dev-A')

    expect(outcome).toEqual({ error: 'device-unavailable', device: 'dev-A', state: 'offline' })
    // A candidate list is a READ: it must not open a socket the operator did not
    // ask for.
    expect(rig.fake.socketCount).toBe(0)
  })

  it('⑦ a device caught MID-DIAL is waited for, not refused', async () => {
    // `connecting` is an attempt in flight, not a verdict (issue #99). The peer
    // delays every reply, so the window is wide enough to hit deterministically.
    const rig = await makeRig({ requestDelayMs: 100 }, { skipConnect: true, deviceSettleWaitMs: 2_000 })
    void rig.dial('dev-A').catch(() => {})

    const outcome = await rig.engine.listTargets('dev-A')

    expect(outcome).toHaveProperty('agents')
    expect('error' in outcome).toBe(false)
  })

  it('⑧ the wait is BOUNDED: an attempt that outlives it reports connecting', async () => {
    // A handshake the peer never finishes: the seam must not turn the wait into
    // an unbounded park, and must report the state it settled on.
    const rig = await makeRig({ handshakeDelayMs: 5_000 }, { skipConnect: true, deviceSettleWaitMs: 100 })
    void rig.dial('dev-A').catch(() => {})

    const started = Date.now()
    const outcome = await rig.engine.listTargets('dev-A')

    expect(outcome).toEqual({ error: 'device-unavailable', device: 'dev-A', state: 'connecting' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('⑨ a peer refusal propagates as the rpc error, so the HTTP face can classify it', async () => {
    // The seam deliberately does NOT translate peer errors: `peer-refused` /
    // `peer-timeout` / `transport` are the HTTP face's codes, and inventing a
    // second classification here would let the two drift.
    const rig = await makeRig({
      agent: {
        agents: agentsFixture(1),
        failAlways: { 'agent.agents.list': { reason: 'INTERNAL', message: 'peer exploded' } },
      },
    })

    const error = await rig.engine.listTargets('dev-A').then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect(error).toMatchObject({ message: 'peer exploded' })
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'INTERNAL' })
  })

  it('⑩ a peer that never answers propagates the request timeout, likewise unclassified', async () => {
    // The connection's per-request timeout is what the transport reports, and it
    // applies to the HANDSHAKE too — so it is set generously (a loopback
    // handshake is a few ms) and only the list method is delayed past it.
    const rig = await makeRig({}, { connection: { rpcTimeoutMs: 1_000 } })
    rig.fake.setMethodDelay('agent.agents.list', 2_500)

    const error = await rig.engine.listTargets('dev-A').then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(RequestTimeoutError)
  })

  it('⑪ a QUARANTINED archive outranks every selector question', async () => {
    // A quarantined store serves an EMPTY read-only view, so every selector
    // misses; answering `not-found` would call a store that still holds a valid
    // token "no such device". The quarantine verdict has precedence.
    const file = join(mkdtempSync(join(tmpdir(), 'cherry-targets-q-')), 'devices.json')
    writeFileSync(file, '{ this is not json', 'utf8')
    const store = new DeviceStore(file)
    expect(store.list()).toEqual([])
    const deps: CherryToolsDeps = {
      store,
      connect: () => {
        throw new Error('a quarantined archive has no connections to resolve')
      },
      subs: () => {
        throw new Error('a quarantined archive has no subscriptions')
      },
      pair: async () => {
        throw new Error('a quarantined archive cannot pair')
      },
      evict: () => {
        throw new Error('a quarantined archive has nothing pooled')
      },
    }
    const engine = new CherryToolEngine(deps)

    const outcome = await engine.listTargets('no-such-device')

    expect(outcome).toMatchObject({ error: 'archive-quarantined', archive: file })
    expect(String((outcome as { guidance: string }).guidance)).toContain(QUARANTINE_RECOVERY)
    rmSync(join(file, '..'), { recursive: true, force: true })
  })

  it('⑫ a row with no id is dropped, and a row with no name is kept nameless', async () => {
    // Both halves are deliberate. An id-less row can be neither selected nor
    // saved, so it is not a target — and inventing an id would put one on the
    // page that no save could honour. A NAMELESS row IS a target (its id is
    // usable), so it is kept and the page falls back to the id rather than the
    // seam fabricating a label.
    const rig = await makeRig({
      agent: {
        // The peer's workspaces face refuses an agent it does not know, so the
        // fixture carries one; the AGENTS WALK still reads the scripted page
        // below, which is what supplies the malformed rows.
        agents: [{ agentId: 'agent-9', name: 'Nine' }],
        scriptedPages: {
          // A scripted entry is the WHOLE page, envelope included.
          'agent.agents.list': [
            {
              items: [{ name: 'No Id At All' }, { agentId: 'agent-9' }, { agentId: '', name: 'Blank' }],
            },
          ],
          // The workspace projection applies the same rule, so it is asserted
          // through the same seam rather than left to a reader's trust.
          'agent.workspaces.list': [{ items: [{ name: 'No Id Either' }, { workspaceId: 'ws-9' }] }],
        },
      },
    })

    const outcome = (await rig.engine.listTargets('dev-A', 'agent-9')) as {
      agents: SubagentTargetAgent[]
      workspaces: Array<{ workspaceId: string }>
    }

    expect(outcome.agents).toEqual([{ agentId: 'agent-9' }])
    expect(outcome.workspaces).toEqual([{ workspaceId: 'ws-9' }])
  })

  it('⑬ the projection carries no credential and no page-sized payload', async () => {
    // The row shape is the DROPDOWN's, not the peer's: an id and a label. Every
    // extra field is a field the settings page would have to ignore, and the
    // access token is the one thing that must never ride out of this seam.
    const rig = await makeRig({
      agent: {
        agents: [
          { agentId: 'agent-1', name: 'Agent One', emoji: '🤖', model: { modelId: 'm', providerId: 'p', name: 'M' } },
        ],
      },
    })

    const outcome = (await rig.engine.listTargets('dev-A')) as { agents: SubagentTargetAgent[] }

    expect(outcome.agents).toEqual([{ agentId: 'agent-1', name: 'Agent One', emoji: '🤖' }])
    expect(JSON.stringify(outcome)).not.toContain('accessToken')
    // The page requests are the walk's own business; the answer is one row set.
    expect(rig.fake.readCallsFor('agent.agents.list').every((call) => (call['limit'] as number) <= PAGE_ITEMS)).toBe(
      true,
    )
  })
})
