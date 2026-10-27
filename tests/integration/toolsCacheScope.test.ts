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
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions } from '../loopback/fakeCherry.js'

/**
 * The engine's SESSION-SCOPED CACHES across TWO live devices.
 *
 * `#revisionCache`/`#executionCache`/`#interactionCache` are engine-global (one
 * engine serves every device), so their key must carry the DEVICE as well as
 * the session. Keying on a bare `sessionId` is silently wrong in the ordinary
 * multi-device deployment: session ids are the peer's, not this plugin's, so
 * two desktops can and do hand out the same one — and the second device would
 * then be sent the FIRST device's `expectedIdleRevision` (a revision its peer
 * has never issued) or be told to cancel the first device's execution.
 *
 * The same keying is what makes eviction possible: unpairing a device must drop
 * everything the engine cached about it, or a re-paired device inherits the old
 * device's snapshots, and a long-lived process accumulates entries for devices
 * that no longer exist.
 */

// ---------------------------------------------------------------------------
// Fake ctx.tools
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
// Rig: TWO real loopback fake desktops, both live
// ---------------------------------------------------------------------------

const SESSION = {
  sessionId: 's-shared',
  agentId: 'agent-1',
  workspaceId: 'ws-1',
  title: 'Hello',
  historyRevision: '1',
}

interface Rig {
  /** The two peers, in device order: A then B. */
  fakes: [FakeCherry, FakeCherry]
  store: DeviceStore
  /** Every `evict` the tool performed, in order. */
  evictions: string[]
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  /** Dials (or joins) one device's connection again after an eviction. */
  reconnect(deviceId: string): Promise<void>
  /** The live peer address one device's record points at. */
  addressOf(deviceId: string): { host: string; port: number; desktopIdentity: string }
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

/**
 * A per-device `agent` fixture with the SAME session id on both peers and
 * DIFFERENT idle revisions, so a leaked cache entry is directly observable in
 * what the second send puts on the wire.
 */
function agentOptions(revision: string, terminalText: string, digest: string): FakeCherryOptions {
  return {
    agent: {
      agents: [{ agentId: 'agent-1', name: 'Agent One' }],
      // The fake derives `idleRevision` from `historyRevision` (the real peer's
      // summary does the same when a session is idle), so the per-device
      // revision IS this field.
      sessions: [{ ...SESSION, historyRevision: revision }],
      messages: [
        {
          messageId: `${revision}-assistant`,
          revision: '1',
          role: 'assistant',
          status: 'success',
          parts: [{ kind: 'text', text: terminalText }],
        },
      ],
      terminalMessage: {
        messageId: `${revision}-assistant`,
        revision: '1',
        role: 'assistant',
        status: 'success',
        parts: [{ kind: 'text', text: terminalText }],
      },
      // ONE interaction, under the SAME id on both peers but with a DIFFERENT
      // input digest each — the snapshot `cherry_respond` sends is taken from
      // this, so a shared cache key shows up directly on the wire.
      interactions: [
        {
          interactionId: 'i-1',
          revision: '5',
          executionId: `exec-${revision}`,
          toolCallId: 'call-1',
          status: 'pending',
          summary: 'answer me',
          kind: 'decision',
          inputDigest: digest,
        },
      ],
    },
  }
}

async function makeRig(): Promise<Rig> {
  const identity = await createDeviceIdentity()
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-cache-scope-'))
  const store = new DeviceStore(join(tmp, 'devices.json'))

  const fakeA = new FakeCherry(agentOptions('771', 'reply from A', 'a'.repeat(64)))
  const fakeB = new FakeCherry(agentOptions('772', 'reply from B', 'b'.repeat(64)))
  const infoA = await fakeA.start()
  const infoB = await fakeB.start()
  const desktopA = await fakeA.identityId
  const desktopB = await fakeB.identityId

  const addresses = new Map<string, { host: string; port: number; desktopIdentity: string }>()
  for (const [deviceId, displayName, info, desktopIdentity] of [
    ['dev-A', 'Desk Alpha', infoA, desktopA],
    ['dev-B', 'Desk Beta', infoB, desktopB],
  ] as const) {
    addresses.set(deviceId, { host: info.host, port: info.port, desktopIdentity })
    store.upsert({
      schemaVersion: 3,
      deviceId,
      displayName,
      hosts: [info.host],
      security: { [info.host]: 'ws' },
      port: info.port,
      desktopIdentity,
      grants: ['agent'],
      enabled: true,
    })
  }

  const connections = new Map<string, DeviceConnection>()
  const subscriptions = new Map<string, SessionSubscriptions>()
  const evictions: string[] = []

  const connect = (deviceId: string): DeviceConnection => {
    const existing = connections.get(deviceId)
    if (existing !== undefined) return existing
    const stored = store.list().find((entry) => entry.deviceId === deviceId)
    if (stored === undefined) throw new Error(`no device ${deviceId}`)
    const connection = new DeviceConnection({ identity, record: stored })
    connections.set(deviceId, connection)
    return connection
  }

  const subs = (deviceId: string): SessionSubscriptions => {
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
    subs,
    pair: async () => {
      throw new Error('pairing is not exercised here')
    },
    evict: async (deviceId) => {
      evictions.push(deviceId)
      const connection = connections.get(deviceId)
      connections.delete(deviceId)
      const layer = subscriptions.get(deviceId)
      subscriptions.delete(deviceId)
      // AWAITED, in the assembly's own order (subscription layer first, then
      // the socket): a fire-and-forget disposal would leave the peer holding a
      // subscription for a connection we have already thrown away, and the
      // re-pair's fresh subscribe would collide with it.
      await layer?.dispose()
      await connection?.close()
    },
  }
  registerCherryTools(ctx, deps)

  await connect('dev-A').connect()
  await connect('dev-B').connect()

  const tool = (name: string): CherryToolDefinition => {
    const found = ctx.definitions.find((definition) => definition.name === name)
    if (found === undefined) throw new Error(`tool ${name} is not registered`)
    return found
  }

  const rig: Rig = {
    fakes: [fakeA, fakeB],
    store,
    evictions,
    call: (name, args = {}) => tool(name).execute(args),
    reconnect: async (deviceId) => {
      await connect(deviceId).connect()
    },
    addressOf: (deviceId) => {
      const found = addresses.get(deviceId)
      if (found === undefined) throw new Error(`no address for ${deviceId}`)
      return found
    },
    stop: async () => {
      for (const layer of subscriptions.values()) await layer.dispose()
      for (const connection of connections.values()) await connection.close()
      await fakeA.stop()
      await fakeB.stop()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
  rigs.push(rig)
  return rig
}

/** The `expectedIdleRevision` a peer actually received on its last send. */
function sentIdleRevision(fake: FakeCherry): string | undefined {
  const calls = fake.commandCallsFor('agent.messages.send')
  const last = calls[calls.length - 1]
  return last === undefined ? undefined : (last['expectedIdleRevision'] as string | undefined)
}

describe('engine session caches are scoped by DEVICE as well as session', () => {
  it('⑯ two devices serving the SAME sessionId never cross-contaminate the idle revision', async () => {
    const rig = await makeRig()

    // A is used first: its baseline `sessions.get` reports rev-A, and that is
    // what the engine caches for "s-shared".
    const fromA = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-shared',
      text: 'hello A',
      wait: false,
    })) as Record<string, unknown>
    expect(fromA['status']).toBe('applied')
    expect(sentIdleRevision(rig.fakes[0])).toBe('771')

    // B serves a session with the SAME id but its OWN revision. A cache keyed
    // on the bare sessionId would replay rev-A here, and B's peer — which has
    // never issued it — would refuse the send as a stale revision.
    const fromB = (await rig.call('cherry_send', {
      device: 'dev-B',
      sessionId: 's-shared',
      text: 'hello B',
      wait: false,
    })) as Record<string, unknown>
    expect(fromB['status']).toBe('applied')
    expect(sentIdleRevision(rig.fakes[1])).toBe('772')

    // ...and A's entry is untouched by B's traffic.
    const againA = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-shared',
      text: 'hello A again',
      wait: false,
    })) as Record<string, unknown>
    expect(againA['status']).toBe('applied')
    expect(sentIdleRevision(rig.fakes[0])).toBe('771')
  })

  it('⑯b two devices serving the same sessionId keep separate interaction snapshots', async () => {
    const rig = await makeRig()

    // Prime each device's interaction cache from its OWN peer, then answer.
    // A shared key would send the FIRST peer's revision/executionId/digest
    // triple to the second peer, whose staleness gate would refuse it.
    for (const device of ['dev-A', 'dev-B']) {
      await rig.call('cherry_interactions', { device, sessionId: 's-shared' })
    }

    await rig.call('cherry_respond', {
      device: 'dev-A',
      sessionId: 's-shared',
      interactionId: 'i-1',
      decision: 'approve',
    })
    await rig.call('cherry_respond', {
      device: 'dev-B',
      sessionId: 's-shared',
      interactionId: 'i-1',
      decision: 'approve',
    })

    const sentA = rig.fakes[0].commandCallsFor('agent.interactions.respond').at(-1)!
    const sentB = rig.fakes[1].commandCallsFor('agent.interactions.respond').at(-1)!
    expect(sentA['inputDigest']).toBe('a'.repeat(64))
    expect(sentA['expectedExecutionId']).toBe('exec-771')
    expect(sentB['inputDigest']).toBe('b'.repeat(64))
    expect(sentB['expectedExecutionId']).toBe('exec-772')
  })

  it('⑯c unpairing a device clears everything the engine cached for it', async () => {
    const rig = await makeRig()

    // Prime A's caches, then RE-PAIR the same device id against a peer serving
    // a DIFFERENT revision. If the unpair left A's entries behind, the fresh
    // device would be sent the OLD revision — one its new peer never issued.
    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-shared', text: 'prime A', wait: false })
    expect(sentIdleRevision(rig.fakes[0])).toBe('771')

    await rig.call('cherry_unpair', { device: 'dev-A' })
    expect(rig.evictions).toEqual(['dev-A'])
    expect(rig.store.list().map((entry) => entry.deviceId)).toEqual(['dev-B'])

    // Same deviceId again, same live peer (which now reports revision 773).
    // The rig's `evict` closed the connection, so the re-paired device is
    // dialed afresh — exactly what a real re-pair does.
    rig.fakes[0].setSessionRevision('s-shared', '773')
    const where = rig.addressOf('dev-A')
    rig.store.upsert({
      schemaVersion: 3,
      deviceId: 'dev-A',
      displayName: 'Desk Alpha',
      hosts: [where.host],
      security: { [where.host]: 'ws' },
      port: where.port,
      desktopIdentity: where.desktopIdentity,
      grants: ['agent'],
      enabled: true,
    })
    await rig.reconnect('dev-A')

    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-shared', text: 'after re-pair', wait: false })
    // A stale cached entry would have been reused WITHOUT asking the peer, so
    // this is the assertion that distinguishes "cleared" from "cleared the
    // record only".
    expect(sentIdleRevision(rig.fakes[0])).toBe('773')
  })
})
