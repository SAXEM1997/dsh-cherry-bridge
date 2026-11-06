import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { registerCherryToolsWithEngine } from '../../src/tools.js'
import type {
  CherryToolDefinition,
  CherryToolEngine,
  CherryToolEngineOptions,
  CherryToolsContext,
  CherryToolsDeps,
} from '../../src/tools.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions } from '../loopback/fakeCherry.js'

/**
 * Issue #231 — what a delegation's run seam can report, and what it must not.
 *
 * The delegation path is `cherry_send`'s path: it runs through the same
 * `#runOnce` (issue #230 extracted it for exactly this reason), so the two
 * answers must agree about what a run's terminal means. This file pins the two
 * channels the delegation needs and the tool face gets for free.
 *
 *  - **`executionError`** — the peer's own failure classification. The fold used
 *    to keep `executionId` / `status` / `messageId` and DROP `payload.error`,
 *    which left `status: 'failed'` as the whole story. A delegation has to tell
 *    its parent something more useful than "it failed", and re-reading the event
 *    buffer a second time in the delegation runner would be a second
 *    implementation of the same fold — the drift #230's extraction exists to
 *    prevent. So the reason rides the ONE fold and both faces see it.
 *
 * WHAT THIS FILE DOES NOT COVER: the provider's own mapping onto the seam (that
 * is `tests/unit/subagentSeam.test.ts`) and the subsystem's switch
 * (`tests/unit/subagentHost.test.ts`). The delegation's policy cases — the
 * interaction loop, the timeout, the abort channel — are below.
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
  engine: CherryToolEngine
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

async function makeRig(options: FakeCherryOptions = {}, engine: CherryToolEngineOptions = {}): Promise<Rig> {
  const fake = new FakeCherry(options)
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-subagent-run-'))
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

  const connections = new Map<string, DeviceConnection>()
  const subscriptions = new Map<string, SessionSubscriptions>()

  const connect = (deviceId: string): DeviceConnection => {
    const existing = connections.get(deviceId)
    if (existing !== undefined) return existing
    const stored = store.list().find((entry) => entry.deviceId === deviceId)
    if (stored === undefined) throw new Error(`no device ${deviceId}`)
    const connection = new DeviceConnection({ identity, record: stored, rateBudgetPerSecond: 100_000 })
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
      throw new Error('the subagent-run suite never pairs')
    },
    evict: () => {
      throw new Error('the subagent-run suite never evicts')
    },
  }
  const registered = registerCherryToolsWithEngine(ctx, deps, engine)
  if (registered.engine === undefined) throw new Error('the engine was not built')
  await connect('dev-A').connect()

  const rig: Rig = {
    fake,
    store,
    engine: registered.engine,
    call: (name, args = {}) => {
      const found = ctx.definitions.find((definition) => definition.name === name)
      if (found === undefined) throw new Error(`tool ${name} is not registered`)
      return found.execute(args)
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

/** The one session every scenario drives. */
const SESSION = {
  sessionId: 's-1',
  agentId: 'agent-1',
  workspaceId: 'ws-1',
  title: 'Hello',
  historyRevision: '1',
}

const AGENT = { agentId: 'agent-1', name: 'Agent One' }

/** A run that reaches the peer's `failed` terminal, with the peer's own reason. */
const FAILING_RUN: FakeCherryOptions = {
  agent: {
    agents: [AGENT],
    sessions: [SESSION],
    runTerminalStatus: 'failed',
    // `details` is the schema's unconstrained blob (`z.record(z.string(),
    // z.json())`) and is exactly where a peer could put a credential or a raw
    // payload. Carrying one in the fixture is what makes "projected" and "passed
    // through" DIFFERENT observations — without it the two implementations
    // produce the same object and the assertion cannot tell them apart.
    executionError: {
      reason: 'RESOURCE_EXHAUSTED',
      message: 'model quota exhausted',
      details: { token: 'sk-live-should-never-surface' },
    },
  },
}

describe('a failed run reports the peer’s own classification (#231)', () => {
  it('①a carries `executionError` with the reason the peer sent, not the raw payload', async () => {
    const rig = await makeRig(FAILING_RUN)
    const answer = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'do the thing',
      timeoutMs: 5_000,
    })) as Record<string, unknown>

    expect(answer['status']).toBe('failed')
    expect(answer['executionError']).toEqual({
      reason: 'RESOURCE_EXHAUSTED',
      message: 'model quota exhausted',
    })
    // The unconstrained half of the payload never rides along (SUB-53).
    expect(JSON.stringify(answer)).not.toContain('sk-live-should-never-surface')
  })

  it('①b a COMPLETED run carries no `executionError` at all', async () => {
    // Absence, not a placeholder: a `{reason: undefined}` or an empty object
    // would make "the peer said why" indistinguishable from "the peer did not",
    // which is the whole difference a caller branches on.
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], runTerminalStatus: 'completed' },
    })
    const answer = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'do the thing',
      timeoutMs: 5_000,
    })) as Record<string, unknown>

    expect(answer['status']).toBe('completed')
    expect('executionError' in answer).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The delegation runner (#231)
// ---------------------------------------------------------------------------

/** The target every delegation case uses unless it overrides one field. */
const TARGET = { device: 'dev-A', agentId: 'agent-1', workspace: { workspaceId: 'ws-1' } } as const

/** One delegation, with the bounds the config resolver would have applied. */
function delegate(
  rig: Rig,
  overrides: {
    text?: string
    label?: string
    cwd?: string
    routes?: readonly { cwdPrefix: string; device?: string; workspaceId?: string }[]
    timeoutMs?: number
    maxInteractionAbandons?: number
    signal?: AbortSignal
    target?: typeof TARGET
    /**
     * The session the delegation created. A delegation makes its OWN session, so
     * a case that has to reach into that session's peer-side state (a
     * subscription reset) has no other way to name it.
     */
    onSessionCreated?: (sessionId: string) => void
  } = {},
): Promise<{ status: string; text: string; diagnostic?: string }> {
  return rig.engine.runSubagentDelegation({
    target: overrides.target ?? TARGET,
    routes: overrides.routes ?? [],
    cwd: overrides.cwd ?? '/w/dsh',
    label: overrides.label,
    text: overrides.text ?? 'summarise the repo',
    timeoutMs: overrides.timeoutMs ?? 5_000,
    maxInteractionAbandons: overrides.maxInteractionAbandons ?? 8,
    signal: overrides.signal ?? new AbortController().signal,
    onSessionCreated: overrides.onSessionCreated,
  })
}

/** A session whose runs settle `completed` with this reply. */
function completing(reply: string, extra: Record<string, unknown> = {}): FakeCherryOptions {
  return {
    agent: {
      agents: [AGENT],
      sessions: [SESSION],
      workspaces: [{ workspaceId: 'ws-1', name: 'WS One' }],
      // A whole `FakeMessageRecord`, not `{messageId, text}`: the parts walk
      // reads `parts`, and a fixture without it fails the assembly rather than
      // answering.
      terminalMessage: {
        messageId: 'm-1',
        revision: '1',
        role: 'assistant',
        status: 'success',
        parts: [{ kind: 'text', text: reply }],
      },
      ...extra,
    },
  }
}

const INTERACTION = {
  interactionId: 'i-1',
  revision: '1',
  executionId: 'e-1',
  toolCallId: 'c-1',
  status: 'pending' as const,
  kind: 'decision' as const,
  summary: 'May I delete the file?',
}

describe('a delegation reports what the run amounted to (SUB-22/50..54)', () => {
  it('②a the normal path folds this run’s assistant text', async () => {
    const rig = await makeRig(completing('the answer'))
    const outcome = await delegate(rig)
    expect(outcome).toEqual({ status: 'completed', text: 'the answer' })
  })

  it('②b the session title comes from the seam’s `label` (SUB-23)', async () => {
    const rig = await makeRig(completing('ok'))
    await delegate(rig, { label: 'review the diff' })
    const created = rig.fake.commandCalls.filter((entry) => entry.method === 'agent.sessions.create')
    expect(created.at(-1)?.params['title']).toBe('review the diff')
  })

  it('②c a child that DECLINES is still `completed` — its refusal text is the output (SUB-54)', async () => {
    // A Cherry persona may refuse on role grounds. Reporting that as a failure
    // would teach the parent to retry a decision that will not change.
    const rig = await makeRig(completing('I cannot help with that request.'))
    const outcome = await delegate(rig)
    expect(outcome.status).toBe('completed')
    expect(outcome.text).toContain('cannot help')
    expect(outcome.diagnostic).toBeUndefined()
  })

  it('②d `completed` with no text is an ERROR, not an empty answer (SUB-51)', async () => {
    const rig = await makeRig(completing('   '))
    const outcome = await delegate(rig)
    expect(outcome.status).toBe('error')
    expect(outcome.diagnostic).toContain('produced no text')
  })

  it('②e a peer `failed` becomes `error` carrying the peer’s own reason (SUB-52)', async () => {
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        runTerminalStatus: 'failed',
        executionError: { reason: 'RESOURCE_EXHAUSTED', message: 'model quota exhausted' },
      },
    })
    const outcome = await delegate(rig)
    expect(outcome.status).toBe('error')
    expect(outcome.diagnostic).toContain('RESOURCE_EXHAUSTED')
    // Bounded and free of the raw payload: only the two projected fields ride.
    expect(outcome.diagnostic).not.toContain('{')
    expect(new TextEncoder().encode(outcome.diagnostic ?? '').byteLength).toBeLessThanOrEqual(4_096)
  })
})

describe('the route table decides where a delegation lands (SUB-10..14)', () => {
  it('②f a matching route overrides the workspace, and the override reaches the wire', async () => {
    const rig = await makeRig(completing('routed'))
    await delegate(rig, {
      cwd: '/w/dsh/src',
      routes: [{ cwdPrefix: '/w/dsh', workspaceId: 'ws-2' }],
    })
    const created = rig.fake.commandCalls.filter((entry) => entry.method === 'agent.sessions.create')
    expect(created.at(-1)?.params['workspaceId']).toBe('ws-2')
  })

  it('②f2 a route’s DEVICE override is used, and an unknown one fails loudly', async () => {
    // The other half of SUB-11: a route may name a device. Pointing it at one
    // this plugin does not have must surface the verdict naming it, which is
    // only possible if the route's device was consulted at all.
    const rig = await makeRig(completing('routed'))
    await expect(
      delegate(rig, { cwd: '/w/dsh', routes: [{ cwdPrefix: '/w/dsh', device: 'desk-missing' }] }),
    ).rejects.toThrow('desk-missing')
  })

  it('②g no route matches, so the configured target stands (SUB-12)', async () => {
    const rig = await makeRig(completing('default target'))
    await delegate(rig, {
      cwd: '/somewhere/else',
      routes: [{ cwdPrefix: '/w/dsh', workspaceId: 'ws-2' }],
    })
    const created = rig.fake.commandCalls.filter((entry) => entry.method === 'agent.sessions.create')
    expect(created.at(-1)?.params['workspaceId']).toBe('ws-1')
  })
})

describe('the session’s title and the window’s start are the seam’s facts (SUB-23/40)', () => {
  it('②h with no label, the title is the head of the task', async () => {
    const rig = await makeRig(completing('ok'))
    const text = 'x'.repeat(200)
    await delegate(rig, { text })
    const created = rig.fake.commandCalls.filter((entry) => entry.method === 'agent.sessions.create')
    expect(created.at(-1)?.params['title']).toBe('x'.repeat(60))
  })

  it('②i creating the session does NOT spend the run’s window (SUB-40)', async () => {
    // The window starts at the SEND's own success. A peer that takes 400 ms to
    // create a session, with a 300 ms window, must still let the run finish —
    // otherwise a slow creation would be reported as a slow CHILD.
    const rig = await makeRig(completing('made it'))
    rig.fake.setMethodDelay('agent.sessions.create', 400)
    const outcome = await delegate(rig, { timeoutMs: 300 })
    expect(outcome.status).toBe('completed')
    expect(outcome.text).toBe('made it')
  })
})

describe('a settled run whose history could not be read is not a silent child (SUB-50)', () => {
  it('②j an assembly failure is reported as itself, never as empty text (SUB-51)', async () => {
    // The run really did settle; only the read behind its text failed. Folding
    // that into "the child produced no text" would report a content failure as a
    // silent child — the distinction the ticket's review demanded.
    const rig = await makeRig(completing('unreadable'))
    // A peer that answers the message walk with a page whose `items` is not an
    // array is a protocol violation the walk refuses, which is the assembly
    // failure this case needs.
    rig.fake.setReadFailure('agent.messages.list', { reason: 'INTERNAL', message: 'history unavailable' })
    const outcome = await delegate(rig)
    expect(outcome.status).toBe('error')
    expect(outcome.diagnostic).toContain('history could not be read')
    expect(outcome.diagnostic).not.toContain('produced no text')
  })
})

describe('a delegation has no human to ask (SUB-30..32)', () => {
  it('③a every card is DENIED and the run carries on to its terminal', async () => {
    const rig = await makeRig(completing('finished anyway', { pushInteractionOnRun: INTERACTION, denyKeepsRunAlive: true }))
    const outcome = await delegate(rig)
    expect(outcome.status).toBe('completed')
    expect(outcome.text).toBe('finished anyway')
    // The DENIAL, not an approval: the peer records which one it received.
    const answered = rig.fake.commandCalls.filter((entry) => entry.method === 'agent.interactions.respond')
    expect(answered.map((entry) => entry.params['decision'])).toEqual(['deny'])
    // SUB-32: nothing was surfaced to the DSH user. This plugin has no channel
    // that could produce an `ask_user_question` — the observable claim is that
    // the outcome never hands a question back and the card was never approved.
    expect(outcome).not.toHaveProperty('questions')
    expect(outcome).not.toHaveProperty('interactionId')
    expect(outcome.status).not.toBe('awaiting-interaction')
    expect(rig.fake.commandCalls.filter((entry) => entry.method === 'agent.interactions.respond')).toHaveLength(1)
  })

  it('③b a child that keeps asking is cancelled at the ceiling and reported (SUB-31)', async () => {
    const rig = await makeRig(
      completing('never gets here', {
        pushInteractionOnRun: INTERACTION,
        denyKeepsRunAlive: true,
        interactionSpamOnRun: { count: 20, record: INTERACTION },
      }),
    )
    const outcome = await delegate(rig, { maxInteractionAbandons: 3 })
    expect(outcome.status).toBe('error')
    expect(outcome.diagnostic).toContain('3')
    expect(outcome.diagnostic).toContain('human input')
    // The BOUNDARY, not just the fact: with a ceiling of 3 it denies exactly
    // two cards and cancels on the third. A case that only checked the word
    // stayed green with `>=` relaxed to `>`.
    const answered = rig.fake.commandCalls.filter((entry) => entry.method === 'agent.interactions.respond')
    expect(answered).toHaveLength(2)
    // It gave up by CANCELLING the run, not by walking away from it.
    expect(rig.fake.commandCalls.some((entry) => entry.method === 'agent.executions.cancel')).toBe(true)
  })
})

describe('the deadline is the delegation’s own (SUB-40..42)', () => {
  it('④a the timeout cancels the run and reports an ERROR — never `cancelled`', async () => {
    // The race this pins: cancelling makes the peer push a `cancelled` terminal,
    // and a waiter that re-entered the loop after cancelling would report the
    // peer's cancellation as the answer. The decision is taken ONCE, from the
    // timeout, and the cancel happens on the way out.
    const rig = await makeRig(completing('too late', { runDelayMs: 30_000 }))
    const outcome = await delegate(rig, { timeoutMs: 150 })
    expect(outcome.status).toBe('error')
    // The CONFIGURED value, not just the word: the generic "the run ended
    // timeout" fallback also contains it, so a case that only looked for the
    // word would stay green with the whole dedicated branch deleted.
    expect(outcome.diagnostic).toContain('150 ms')
    expect(rig.fake.commandCalls.some((entry) => entry.method === 'agent.executions.cancel')).toBe(true)
  })

  it('④b `timeoutMs: 0` is no bound at all, not an instant expiry (SUB-42)', async () => {
    const rig = await makeRig(completing('took its time', { runDelayMs: 300 }))
    const outcome = await delegate(rig, { timeoutMs: 0 })
    expect(outcome.status).toBe('completed')
    expect(outcome.text).toBe('took its time')
  })
})

describe('our own cancellation is not the child’s (SUB-25)', () => {
  it('⑤a a parent abort cancels the run and reports `aborted`', async () => {
    const rig = await makeRig(completing('never read', { runDelayMs: 30_000 }))
    const controller = new AbortController()
    const pending = delegate(rig, { signal: controller.signal })
    // Abort while the wait is parked, so the abort channel is what ends it —
    // not a timeout, which would have to be shorter than this delay.
    // Wait for the SEND, not for an execution event: a peer that is still
    // thinking has emitted nothing, and the abort must land on a run that is
    // genuinely in flight.
    await vi.waitFor(() => {
      expect(rig.fake.commandCalls.some((entry) => entry.method === 'agent.messages.send')).toBe(true)
    })
    controller.abort()
    const outcome = await pending
    expect(outcome.status).toBe('aborted')
    expect(rig.fake.commandCalls.some((entry) => entry.method === 'agent.executions.cancel')).toBe(true)
  })
})

describe('a receipt is not a run, and a lost subscription is not an ending (#248)', () => {
  it('⑥a a REJECTED send never started a run, so nothing is "the run ended"', async () => {
    // `#runOnce` hands a rejected receipt back untouched — there is no run to
    // wait for. Folding it through the terminal branch invented one and dropped
    // the peer's own reason, which is the only thing that tells an operator
    // whether to retry, fix the target, or free the ledger.
    const rig = await makeRig(completing('never ran', { sendOutcome: 'busy' }))
    const outcome = await delegate(rig)
    expect(outcome.status).toBe('error')
    // The peer's words, both halves: the machine-readable reason and its message.
    expect(outcome.diagnostic).toContain('CONFLICT')
    expect(outcome.diagnostic).toContain('Session is busy')
    // NOT the fabricated run terminal. That phrasing is the whole bug: it reads
    // as "a child ran and ended this way", which never happened.
    expect(outcome.diagnostic).not.toContain('the run ended')
    // Nothing to cancel: the peer refused the command, so no child exists.
    expect(rig.fake.commandCalls.some((entry) => entry.method === 'agent.executions.cancel')).toBe(false)
  })

  it('⑥b a lost subscription says the outcome is UNKNOWABLE, and cancels the child', async () => {
    // Two failures in one answer. The FOLD reported "the run ended
    // subscription-lost" — a run terminal it never observed — and dropped both
    // the reason and the recovery routes the result carries. The RUNNER left the
    // child alive: the parent has stopped observing it, which is exactly the
    // abandoned work the timeout branch's own comment forbids.
    const rig = await makeRig(completing('never read', { runDelayMs: 30_000 }))
    let created: string | undefined
    const pending = delegate(rig, {
      timeoutMs: 20_000,
      onSessionCreated: (id) => {
        created = id
      },
    })
    await vi.waitFor(() => {
      expect(rig.fake.commandCalls.some((entry) => entry.method === 'agent.messages.send')).toBe(true)
    })
    if (created === undefined) throw new Error('the delegation reported no session')
    // The peer drops the subscription AND refuses every re-subscribe.
    rig.fake.pushResetRequired(created)
    rig.fake.refuseSubscriptions('RESOURCE_EXHAUSTED')
    const outcome = await pending
    expect(outcome.status).toBe('error')
    // The verdict is UNOBSERVED, not failed — a different sentence, and the one
    // that stops a parent from reporting a healthy child as broken.
    expect(outcome.diagnostic).toMatch(/unknown|unknowable/i)
    // The recovery route rides along; without it the parent has a dead end.
    expect(outcome.diagnostic).toContain('cherry_read')
    // And the child was stopped rather than abandoned.
    expect(rig.fake.commandCalls.some((entry) => entry.method === 'agent.executions.cancel')).toBe(true)
  })
})
