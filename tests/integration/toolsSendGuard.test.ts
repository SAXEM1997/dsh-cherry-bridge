import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { agentMethods } from '@cherrystudio/remote-protocol/agent'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { registerCherryTools } from '../../src/tools.js'
import type { CherryToolDefinition, CherryToolsContext, CherryToolsDeps } from '../../src/tools.js'
import { FakeCherry } from '../loopback/fakeCherry.js'

/**
 * The `cherry_send` ARGUMENT face — what this plugin answers locally instead of
 * putting on the wire.
 *
 * The suite exists because of a PEER CHANGE, not a local preference: Cherry
 * ≥ 2.1.5 validates `agent.messages.send` with a refine that requires text which
 * trims to something (attachments are the other legal carrier, and this client
 * sends none). A blank body is therefore refused by the peer's schema, and the
 * difference between "the plugin told you the body is blank" and "the peer
 * answered a validation error you have to decode" is the whole point of the
 * first test below: it asserts the PINNED schema really does refuse it, so this
 * guard can never rot into a rule the protocol no longer has.
 */


interface Rig {
  fake: FakeCherry
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  stop(): Promise<void>
}

const rigs: Rig[] = []
let consoleWarn: ReturnType<typeof vi.fn>
let consoleInfo: ReturnType<typeof vi.fn>

beforeEach(() => {
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  // The pooled connection announces every state transition at info level; the
  // suite asserts the CONNECTED outcome, not the commentary.
  consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.stop()
  consoleWarn.mockRestore()
  consoleInfo.mockRestore()
})

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

async function makeRig(): Promise<Rig> {
  const fake = new FakeCherry({
    // One idle session: the guard tests need a target that a REAL send would be
    // accepted on, so "nothing was sent" is a statement about the guard rather
    // than about a session that does not exist.
    agent: {
      agents: [{ agentId: 'agent-1', name: 'Agent One' }],
      sessions: [
        {
          sessionId: 's-1',
          agentId: 'agent-1',
          workspaceId: 'ws-1',
          title: 'Guards',
          historyRevision: '1000',
        },
      ],
    },
  })
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-send-guard-'))
  const store = new DeviceStore(join(tmp, 'devices.json'))
  store.upsert({
    schemaVersion: 3,
    deviceId: 'dev-A',
    displayName: 'Desk Alpha',
    hosts: [host],
    security: { [host]: 'ws' as const },
    port,
    desktopIdentity,
    grants: ['agent'] as 'agent'[],
    enabled: true,
  })

  const connection = new DeviceConnection({
    identity,
    record: store.list()[0]!,
    rateBudgetPerSecond: 32,
  })
  const subscriptions = new SessionSubscriptions(connection.rpc, { subscriptionsLimit: 8 })
  connection.rpc.onNotification((method, params) => subscriptions.handleNotification(method, params))

  const ctx = makeCtx()
  const deps: CherryToolsDeps = {
    store,
    connect: () => connection,
    subs: () => subscriptions,
    pair: async () => {
      throw new Error('pairing is not exercised by the send-guard suite')
    },
    evict: () => {
      throw new Error('the send-guard suite never evicts')
    },
  }
  registerCherryTools(ctx, deps, {})
  await connection.connect()

  const rig: Rig = {
    fake,
    call: async (name, args = {}) => {
      const definition = ctx.definitions.find((entry) => entry.name === name)
      if (definition === undefined) throw new Error(`tool ${name} is not registered`)
      return definition.execute(args)
    },
    stop: async () => {
      await subscriptions.dispose()
      await connection.close()
      await fake.stop()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
  rigs.push(rig)
  return rig
}

describe('the cherry_send argument face', () => {
  it('① the PINNED protocol schema refuses a blank body — the rule this guard mirrors', () => {
    const send = agentMethods['agent.messages.send']
    const base = { commandId: 'c-1', sessionId: 's-1', expectedIdleRevision: '1' }

    // The happy path, so the failures below are provably caused by the body.
    expect(send.params.safeParse({ ...base, text: 'go' }).success).toBe(true)
    // A missing body is no longer a params error BY ITSELF (the text key became
    // optional when attachments arrived) — the refine is what refuses it.
    expect(send.params.safeParse(base).success).toBe(false)
    expect(send.params.safeParse({ ...base, text: '' }).success).toBe(false)
    // The case a `min(1)` could never catch, and the one this plugin answers
    // for: a body that is present, within the length cap, and still empty.
    expect(send.params.safeParse({ ...base, text: '   ' }).success).toBe(false)
    expect(send.params.safeParse({ ...base, text: '\n\t ' }).success).toBe(false)
    // Attachments are the legal alternative carrier (this client sends none).
    // An upload reference is just the opaque id the peer handed out.
    expect(send.params.safeParse({ ...base, text: '', attachments: [{ uploadId: 'up-1' }] }).success).toBe(true)
  })

  it('② cherry_send answers `text-empty` locally: no send, no subscription, no wire call at all', async () => {
    const rig = await makeRig()

    // The MISSING/EMPTY string keeps the argument-error face every tool shares
    // (`requiredString`): an absent body is an argument-shape fault, not a rule
    // the peer taught us.
    await expect(rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: '' })).rejects.toThrow(
      /"text" is required/,
    )

    // Whitespace is the case `min(1)` never caught and the peer now refuses:
    // it reaches the plugin as a present, in-cap body, and gets the structured
    // verdict.
    for (const blank of ['   ', '\n\t ', ' \u00a0 ']) {
      const verdict = (await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: blank })) as {
        error?: string
        message?: string
      }
      expect(verdict.error).toBe('text-empty')
      expect(verdict.message).toMatch(/blank|empty/i)
    }

    // THE DISCRIMINATOR: a guard that ran after the wire would still return this
    // verdict while having spent a peer round trip (and, on a session that is
    // not idle, having raced a real send). Nothing was sent, and nothing was
    // even subscribed to — the check precedes every side effect.
    expect(rig.fake.methodCount('agent.messages.send')).toBe(0)
    expect(rig.fake.methodCount('agent.sessions.subscribe')).toBe(0)

    // And the same call with a real body still goes through, so the guard has
    // not simply broken the tool.
    await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: 'go', wait: false })
    expect(rig.fake.methodCount('agent.messages.send')).toBe(1)
  })

  it('③ the length cap still answers its own verdict (the two guards do not shadow each other)', async () => {
    const rig = await makeRig()
    const tooLong = 'x'.repeat(32_768 + 1)

    const verdict = (await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: tooLong })) as {
      error?: string
      limit?: number
    }
    expect(verdict.error).toBe('text-too-long')
    expect(verdict.limit).toBe(32_768)
    // A body of ONLY whitespace that is also over the cap is refused for length
    // first: both guards are pre-wire, so which one answers is decided by order,
    // and the order is asserted rather than assumed.
    const blankOverCap = ' '.repeat(32_768 + 1)
    const ordered = (await rig.call('cherry_send', { device: 'dev-A', sessionId: 's-1', text: blankOverCap })) as {
      error?: string
    }
    expect(ordered.error).toBe('text-too-long')
    expect(rig.fake.methodCount('agent.messages.send')).toBe(0)
  })
})
