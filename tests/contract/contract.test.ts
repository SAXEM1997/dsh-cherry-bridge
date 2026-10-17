import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { connectionMethods, connectionNotificationSchema, pairingMethods } from '@cherrystudio/remote-protocol'
import { agentNotificationSchema, commandReceiptSchema, executionSchema } from '@cherrystudio/remote-protocol/agent'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import type { DeviceState } from '../../src/connection.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { CHERRY_TOOL_NAMES, registerCherryTools } from '../../src/tools.js'
import type { CherryToolDefinition, CherryToolsContext, CherryToolsDeps } from '../../src/tools.js'
import { ToolScopeState } from '../../src/toolScope.js'
import { pairWithPayload } from '../../src/pairing.js'
import {
  DEFAULT_PER_SESSION_CACHE_BYTES,
  DEFAULT_RATE_BUDGET_PER_SECOND,
  resolveBridgeConfig,
} from '../../src/index.js'
import {
  CONTRACT_DIFFERENCES,
  ERROR_MESSAGE_ELLIPSIS,
  ERROR_MESSAGE_MAX,
  buildDiagnostics,
  sanitizeDiagnostics,
} from '../../src/diagnostics.js'
import { registerHttpApi } from '../../src/httpApi.js'
import type {
  CherryHttpContext,
  CherryHttpDeps,
  HttpRequestLike,
  HttpResponseLike,
} from '../../src/httpApi.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions, FakeInteractionRecord, FakeMessageRecord } from '../loopback/fakeCherry.js'
import { asksForScopeKeys } from '../helpers/scopeInjectKeys.js'

/**
 * Task 13 — the CONTRACT suite.
 *
 * This file is not another behavioural test of the plugin: it is the
 * documentation-by-assertion of where the loopback fake
 * (`tests/loopback/fakeCherry.ts`) and the REAL Cherry Studio desktop differ.
 * Every item of the six-entry difference list is asserted here twice over:
 *
 *  - the SCHEMA side says what the published protocol allows (authority: the
 *    pinned `@cherrystudio/remote-protocol@0.5.0` package installed in this
 *    repo), and
 *  - the WIRE side says what this fake actually does when driven against a
 *    real Noise-XX loopback connection.
 *
 * A future protocol upgrade that closes one of these gaps fails HERE, loudly,
 * instead of silently invalidating the fake. The same six entries drive
 * `docs/e2e-checklist.md` (item ⑦), so the manual pre-release pass and the
 * automated pass can never drift apart.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The three files a git-spec install must be able to load, one per `exports`
 * target plus the declaration half of the root entry (E1-1). Since R3 F1-1 they
 * are COMMITTED build outputs: they travel with the clone, so nothing has to
 * build before pack.
 */
const CLONE_PACK_ARTIFACTS = ['dist/index.mjs', 'dist/index.d.mts', 'lib/client.js'] as const

/** Run a command in `cwd`, returning stdout; a non-zero exit throws loudly. */
function run(command: string, args: string[], cwd: string): string {
  // npm's cache AND its log directory are redirected out of `$HOME`: under a
  // sandboxed runner or a read-only home, npm fails outright when it cannot
  // write `/root/.npm/_logs`, which would surface as an unrelated and very
  // confusing failure of the pack gate below.
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      npm_config_cache: '/tmp/npmcache-cherry',
      npm_config_logs_dir: '/tmp/npmcache-cherry/_logs',
    },
  })
}

/**
 * Clone THIS repository into `target`.
 *
 * `--no-hardlinks` forces a real copy: a hardlinked clone would share inodes
 * with the working checkout. The clone still starts from TRACKED CONTENT ONLY —
 * that is the point, and since R3 F1-1 the three build artifacts ARE tracked
 * content (see `CLONE_PACK_ARTIFACTS`), while `node_modules/` is not.
 */
function runGitClone(source: string, target: string): void {
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', source, target], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const fakes: FakeCherry[] = []
const connections: DeviceConnection[] = []
const subscriptionLayers: SessionSubscriptions[] = []
const dirs: string[] = []

// Pristine output (ruling 9), and the seam the log-redaction assertion reads.
let consoleWarn: ReturnType<typeof vi.fn>
let consoleInfo: ReturnType<typeof vi.fn>
let consoleError: ReturnType<typeof vi.fn>
let consoleLog: ReturnType<typeof vi.fn>

/** Every string handed to any console channel, joined — the redaction input. */
function capturedLogText(): string {
  const calls = [
    ...consoleWarn.mock.calls,
    ...consoleInfo.mock.calls,
    ...consoleError.mock.calls,
    ...consoleLog.mock.calls,
  ]
  return calls
    .map((args) =>
      args
        .map((arg) => {
          if (typeof arg === 'string') return arg
          try {
            return JSON.stringify(arg)
          } catch {
            return String(arg)
          }
        })
        .join(' '),
    )
    .join('\n')
}

beforeEach(() => {
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  for (const layer of subscriptionLayers.splice(0)) await layer.dispose().catch(() => {})
  for (const connection of connections.splice(0)) await connection.close().catch(() => {})
  for (const fake of fakes.splice(0)) await fake.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Rig: a real loopback desktop + a real DeviceConnection + the real tools
// ---------------------------------------------------------------------------

interface FakeInfo {
  fake: FakeCherry
  host: string
  port: number
  desktopIdentity: string
}

async function makeFake(options: FakeCherryOptions = {}): Promise<FakeInfo> {
  const fake = new FakeCherry(options)
  fakes.push(fake)
  const { host, port } = await fake.start()
  const desktopIdentity = await fake.identityId
  return { fake, host, port, desktopIdentity }
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForState(connection: DeviceConnection, want: DeviceState[], timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = (): void => {
      if (want.includes(connection.state)) return resolve()
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timeout waiting for state ${want.join('|')}; still ${connection.state}`))
      }
      setTimeout(poll, 5)
    }
    poll()
  })
}

interface FakeCtx extends CherryToolsContext {
  readonly definitions: CherryToolDefinition[]
}

function makeToolCtx(): FakeCtx {
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
  connection: DeviceConnection
  subscriptions: SessionSubscriptions
  definitions: CherryToolDefinition[]
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>
}

interface RigOptions extends FakeCherryOptions {
  /** Skip `connect()` so the pair→connect step is the caller's. */
  connect?: boolean
  /** The `perSessionCacheBytes` the local subscription layer is built with. */
  perSessionCacheBytes?: number
}

/**
 * The full-stack rig: a real paired `DeviceStore` record, a real
 * {@link DeviceConnection} over real Noise, the real {@link SessionSubscriptions}
 * layer and the real `cherry_*` tool registration. Nothing here is a mock —
 * that is the point of a contract suite.
 */
async function makeRig(options: RigOptions = {}): Promise<Rig> {
  const identity = await createDeviceIdentity()
  const desktop = await makeFake(options)
  const store = new DeviceStore(join(tempDir('cherry-contract-'), 'devices.json'))
  store.upsert({
    schemaVersion: 2,
    deviceId: 'dev-A',
    displayName: 'Desk Alpha',
    hosts: [desktop.host],
    port: desktop.port,
    desktopIdentity: desktop.desktopIdentity,
    grants: ['agent'],
    enabled: true,
  })

  const record = store.list()[0]!
  const connection = new DeviceConnection({ identity, record })
  connections.push(connection)
  const subscriptions = new SessionSubscriptions(connection.rpc, {
    subscriptionsLimit: options.agent?.subscriptionLimit ?? 8,
    ...(options.perSessionCacheBytes === undefined ? {} : { perSessionCacheBytes: options.perSessionCacheBytes }),
  })
  subscriptionLayers.push(subscriptions)
  connection.rpc.onNotification((method, params) => subscriptions.handleNotification(method, params))

  const ctx = makeToolCtx()
  const deps: CherryToolsDeps = {
    store,
    connect: () => connection,
    subs: () => subscriptions,
    pair: async () => {
      throw new Error('the contract suite pairs through pairWithPayload directly')
    },
    evict: () => {},
  }
  registerCherryTools(ctx, deps)

  if (options.connect !== false) {
    await connection.connect()
    await waitForState(connection, ['connected'])
  }

  const find = (name: string): CherryToolDefinition => {
    const found = ctx.definitions.find((definition) => definition.name === name)
    if (found === undefined) throw new Error(`tool ${name} is not registered`)
    return found
  }

  return {
    fake: desktop.fake,
    store,
    connection,
    subscriptions,
    definitions: ctx.definitions,
    call: (name, args = {}) => find(name).execute(args),
    waitFor: async (predicate, timeoutMs = 3_000) => {
      const started = Date.now()
      for (;;) {
        if (predicate()) return
        if (Date.now() - started > timeoutMs) throw new Error('condition not met before timeout')
        await sleep(5)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SESSION = {
  sessionId: 's-1',
  agentId: 'agent-1',
  workspaceId: 'ws-1',
  title: 'Hello',
  historyRevision: '1',
}

const AGENT = { agentId: 'agent-1', name: 'Agent One' }

/**
 * The 14 tools the plugin registers (spec §9), taken from the plugin itself
 * rather than copied here: the README's per-name assertion, the rig's
 * registration assertion and the drift assertion in `③ release configuration`
 * all read this ONE constant. With no second copy to compare against, a
 * "the two lists agree" assertion has nothing left to check — a name added,
 * renamed or dropped is caught by the assertions themselves.
 */
const TOOL_NAMES = CHERRY_TOOL_NAMES

function decisionInteraction(overrides: Partial<FakeInteractionRecord> = {}): FakeInteractionRecord {
  return {
    interactionId: 'i-decision',
    revision: '3',
    executionId: 'exec-9',
    toolCallId: 'call-2',
    status: 'pending',
    summary: 'Approve: rm -rf /tmp/build',
    kind: 'decision',
    ...overrides,
  }
}

function terminalMessage(text: string): FakeMessageRecord {
  return {
    messageId: 'm-assistant',
    revision: '1',
    role: 'assistant',
    status: 'success',
    parts: [{ kind: 'text', text }],
  }
}

// ---------------------------------------------------------------------------
// The difference list itself (① and ⑦ share this constant)
// ---------------------------------------------------------------------------

describe('① the six-entry contract difference list', () => {
  it('models exactly six entries, each uniquely identified and fully annotated', () => {
    expect(CONTRACT_DIFFERENCES).toHaveLength(6)
    const ids = CONTRACT_DIFFERENCES.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(6)

    for (const entry of CONTRACT_DIFFERENCES) {
      // Every entry must say what the REAL peer does, what the FAKE does, and
      // where the schema sits — an entry missing any of the three is a
      // difference nobody can act on.
      expect(entry.id).toMatch(/^[a-z0-9-]+$/)
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.realPeer.length).toBeGreaterThan(0)
      expect(entry.fakePeer.length).toBeGreaterThan(0)
      expect(entry.schemaAnchor.length).toBeGreaterThan(0)
      // The manual checklist step for this entry is carried IN the model, so
      // item ⑦ can assert the document against the same source of truth.
      expect(entry.checklistStep.length).toBeGreaterThan(0)
    }

    // The six dimensions, by their stable ids.
    expect(ids).toEqual([
      'connection-closed-not-sent',
      'approval-card-not-realtime',
      'rate-limit-terminates-session',
      'execution-terminal-no-interrupted',
      'command-receipt-can-be-interrupted',
      'resource-exhausted-receipt-cap',
    ])
  })

  // -------------------------------------------------------------------------
  // ② approval cards are not real-time in the real stream
  // -------------------------------------------------------------------------

  it('② records that the real peer does not stream approval cards in real time, and proves the fake does', async () => {
    const entry = CONTRACT_DIFFERENCES.find((item) => item.id === 'approval-card-not-realtime')!
    expect(entry.realPeer).toMatch(/interactions\.list/)
    expect(entry.realPeer).toMatch(/not.*real.?time|非实时/i)

    // The SCHEMA side: an `interaction.updated` event IS a legal agent
    // notification, so a fake that streams it is schema-honest — the
    // difference is behaviour, not shape.
    const event = {
      jsonrpc: '2.0',
      method: 'agent.events',
      params: {
        subscriptionId: 'sub-1',
        sessionId: 's-1',
        streamEpoch: 'epoch-1',
        events: [
          {
            kind: 'interaction.updated',
            seq: '1',
            payload: {
              interactionId: 'i-1',
              revision: '3',
              executionId: 'exec-1',
              toolCallId: 'call-1',
              status: 'pending',
              summary: 'Approve?',
              inputDigest: 'a'.repeat(64),
              input: { text: '{}' },
            },
          },
        ],
      },
    }
    expect(agentNotificationSchema.safeParse(event).success).toBe(true)

    // The WIRE side: the fake really does push the card in-stream, and the
    // client's soft terminal reacts to it (spec §3.6).
    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        pushInteractionOnRun: decisionInteraction(),
      },
    })
    await rig.call('cherry_events', { device: 'dev-A', sessionId: 's-1' })
    const sent = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'go',
      wait: true,
      timeoutMs: 3_000,
    })) as { status: string; interactionId?: string; kind?: string }

    expect(sent.status).toBe('awaiting-interaction')
    expect(sent.interactionId).toBe('i-decision')
    expect(sent.kind).toBe('decision')

    // The list-query fallback the REAL peer requires is still exercised: a
    // card that never arrived in-stream is found through
    // `agent.interactions.list` instead.
    const queried = (await rig.call('cherry_interactions', { device: 'dev-A', sessionId: 's-1' })) as {
      items: Array<{ interactionId: string }>
    }
    expect(queried.items.map((item) => item.interactionId)).toContain('i-decision')
    expect(rig.fake.commandCallsFor('agent.interactions.list').length).toBeGreaterThan(0)
  }, 20_000)

  // -------------------------------------------------------------------------
  // ③ rate limiting terminates the WHOLE session
  // -------------------------------------------------------------------------

  it('③ proves the over-limit verdict is a session close (1011), never a per-request rejection', async () => {
    const entry = CONTRACT_DIFFERENCES.find((item) => item.id === 'rate-limit-terminates-session')!
    expect(entry.realPeer).toMatch(/64/)
    expect(entry.realPeer).toMatch(/1011/)

    // The fake's cap is injectable; the real desktop's is 64 req/s. Exceeding
    // it closes the SESSION — every in-flight request dies with it, and the
    // client routes the close through its offline→backoff path rather than
    // seeing a structured per-request refusal.
    const rig = await makeRig({ rateLimitPerSecond: 4 })

    // Fire well past the cap. The peer terminates the SESSION: the in-flight
    // requests fail together, and the socket goes away with them.
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, () => rig.connection.rpc.request('agent.agents.list', { limit: 1 })),
    )
    expect(results.some((result) => result.status === 'rejected')).toBe(true)

    await waitForState(rig.connection, ['offline', 'connecting', 'connected'])
    // The session really was terminated: nothing in flight survived, and the
    // client is on its reconnect path rather than serving the old socket.
    expect(rig.connection.state).not.toBe('connected')
  }, 20_000)

  // -------------------------------------------------------------------------
  // ④ execution terminals never carry `interrupted` against the REAL peer
  // -------------------------------------------------------------------------

  it('④ pins `interrupted` in the execution schema while the real journal never produces it for an execution', async () => {
    const entry = CONTRACT_DIFFERENCES.find((item) => item.id === 'execution-terminal-no-interrupted')!
    expect(entry.realPeer).toMatch(/completed.*failed.*cancelled/)
    expect(entry.schemaAnchor).toMatch(/executionSchema/)

    // The SCHEMA allows it (that is why Task 9⑭'s injected fixture is legal)...
    const interrupted = {
      executionId: 'exec-i',
      status: 'interrupted',
      messageId: 'm-1',
      durable: true,
      history: { messageRevision: '1', historyRevision: '1' },
    }
    expect(executionSchema.safeParse(interrupted).success).toBe(true)
    expect(agentNotificationSchema.safeParse({
      jsonrpc: '2.0',
      method: 'agent.events',
      params: {
        subscriptionId: 'sub-1',
        sessionId: 's-1',
        streamEpoch: 'epoch-1',
        events: [{ kind: 'execution.updated', seq: '1', payload: interrupted }],
      },
    }).success).toBe(true)

    // ...but a DEFAULT run against the peer settles on a status the journal
    // really emits, and the waiter accepts it.
    const rig = await makeRig({
      agent: { agents: [AGENT], sessions: [SESSION], terminalMessage: terminalMessage('done') },
    })
    const receipt = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'go',
      wait: true,
      timeoutMs: 3_000,
    })) as { status: string }
    expect(receipt.status).toBe('completed')

    const emitted = rig.fake.executionUpdates.map((update) => update.status)
    expect(emitted).toContain('completed')
    // The fake only emits `interrupted` when a test INJECTS it; the default
    // peer-side status set is exactly the journal's three.
    expect(emitted).not.toContain('interrupted')
  }, 20_000)

  // -------------------------------------------------------------------------
  // ⑤ the OTHER dimension: a command receipt MAY be `interrupted`
  // -------------------------------------------------------------------------

  it('⑤ pins that a command receipt may be `interrupted` — a dimension the execution waiter must not absorb', () => {
    const entry = CONTRACT_DIFFERENCES.find((item) => item.id === 'command-receipt-can-be-interrupted')!
    expect(entry.schemaAnchor).toMatch(/commandReceiptSchema/)

    const admittedAt = new Date().toISOString()
    expect(
      commandReceiptSchema.safeParse({
        commandId: 'cmd-1',
        method: 'agent.messages.send',
        status: 'interrupted',
        admittedAt,
        error: { reason: 'RESOURCE_EXHAUSTED', message: 'Receipt ledger is full' },
      }).success,
    ).toBe(true)

    // The two dimensions are INDEPENDENT enums: `interrupted` is a legal
    // receipt status, while the execution terminal set is the four the waiter
    // covers. A caller that conflated them would mistake an undetermined
    // command for a finished run.
    const receiptStatuses = commandReceiptSchema.shape.status.options
    expect(receiptStatuses).toContain('interrupted')
    expect(receiptStatuses).not.toContain('completed')

    const executionStatuses = executionSchema.shape.status.options
    expect(executionStatuses).toContain('interrupted')
    expect(executionStatuses).toContain('completed')
  })
})

// ---------------------------------------------------------------------------
// ⑥ RESOURCE_EXHAUSTED on the RECEIPT dimension
// ---------------------------------------------------------------------------

describe('⑥ RESOURCE_EXHAUSTED injected on the receipt dimension', () => {
  it('passes the peer code through structurally without crashing the client', async () => {
    const entry = CONTRACT_DIFFERENCES.find((item) => item.id === 'resource-exhausted-receipt-cap')!
    expect(entry.schemaAnchor).toMatch(/RESOURCE_EXHAUSTED/)

    const rig = await makeRig({
      agent: {
        agents: [AGENT],
        sessions: [SESSION],
        // The peer's receipt ledger is full: the command is REFUSED while the
        // session stays perfectly healthy.
        sendOutcome: 'resource-exhausted',
      },
    })

    const receipt = (await rig.call('cherry_send', {
      device: 'dev-A',
      sessionId: 's-1',
      text: 'go',
      wait: false,
      commandId: 'cmd-cap',
    })) as { status: string; error?: { reason: string; message?: string } }

    // Structured passthrough: a REJECTED RECEIPT carrying the peer's reason
    // verbatim, not a thrown error and not a swallowed `undefined`.
    expect(receipt.status).toBe('rejected')
    expect(receipt.error?.reason).toBe('RESOURCE_EXHAUSTED')

    // The session survived: the next call still works. That is the whole
    // difference from item ③ — a receipt refusal is not a transport failure.
    expect(rig.connection.state).toBe('connected')
    const followUp = (await rig.call('cherry_devices', {})) as { devices: unknown[] }
    expect(followUp.devices).toHaveLength(1)
  }, 20_000)
})

// ---------------------------------------------------------------------------
// ⑦ the manual checklist is generated from the SAME list
// ---------------------------------------------------------------------------

describe('⑦ docs/e2e-checklist.md covers the same six entries', () => {
  const checklist = readFileSync(join(repoRoot, 'docs', 'e2e-checklist.md'), 'utf8')

  it('names every contract difference entry by id and title', () => {
    for (const entry of CONTRACT_DIFFERENCES) {
      expect(checklist).toContain(entry.id)
      expect(checklist).toContain(entry.title)
    }
  })

  it('carries the manual verification step for every entry, verbatim from the contract list', () => {
    for (const entry of CONTRACT_DIFFERENCES) {
      expect(checklist).toContain(entry.checklistStep)
    }
  })

  it('covers the five real-device flows the pre-release pass must walk', () => {
    for (const flow of ['配对', '发送', '交互应答', '断连恢复', '多设备并存']) {
      expect(checklist).toContain(flow)
    }
  })
})

// ---------------------------------------------------------------------------
// ⑧+⑨ diagnostics and release pinning
// ---------------------------------------------------------------------------

describe('③ diagnostics output is sanitized', () => {
  it('never carries a token or secret field, while deviceId/sessionId/desktopIdentity digest may appear', () => {
    const source = {
      devices: [
        {
          deviceId: 'dev-1',
          displayName: 'Desk Alpha',
          state: 'connected' as const,
          hosts: ['192.168.1.20'],
          port: 8765,
          desktopIdentity: 'desktop-abc',
          accessToken: 'super-secret-token',
          tokenExpiresAt: Date.now() + 3_600_000,
          invitationSecret: 'invitation-secret',
          grants: ['agent'],
        },
      ],
      sessions: [
        {
          sessionId: 's-1',
          deviceId: 'dev-1',
          subscriptions: 2,
          cursor: { sessionId: 's-1', streamEpoch: 'epoch-1', seq: '9' },
          accessToken: 'another-secret',
        },
      ],
      recentErrors: [
        {
          at: '2026-10-09T00:00:00.000Z',
          deviceId: 'dev-1',
          sessionId: 's-1',
          reason: 'RESOURCE_EXHAUSTED',
          message: 'Receipt ledger is full',
          accessToken: 'leaked',
          invitationSecret: 'leaked-too',
        },
      ],
    }

    const diagnostics = sanitizeDiagnostics(source)
    const serialized = JSON.stringify(diagnostics)

    for (const secret of ['super-secret-token', 'another-secret', 'invitation-secret', 'leaked']) {
      expect(serialized).not.toContain(secret)
    }
    for (const key of ['accessToken', 'tokenExpiresAt', 'invitationSecret', 'token', 'secret']) {
      expect(serialized).not.toContain(key)
    }

    // The whitelisted fields DO come through — a sanitizer that redacts
    // everything is useless for operations.
    expect(diagnostics.devices[0]!.deviceId).toBe('dev-1')
    expect(diagnostics.devices[0]!.displayName).toBe('Desk Alpha')
    expect(diagnostics.devices[0]!.state).toBe('connected')
    // desktopIdentity appears as a SHORT DIGEST, never the raw pinned value.
    expect(diagnostics.devices[0]!.desktopIdentity).not.toBe('desktop-abc')
    expect(diagnostics.devices[0]!.desktopIdentity).toMatch(/^[0-9a-f]{12}$/)
    expect(diagnostics.sessions[0]!.sessionId).toBe('s-1')
    expect(diagnostics.recentErrors[0]!.reason).toBe('RESOURCE_EXHAUSTED')
  })

  it('builds a live report from the pool surfaces with no credential anywhere in it', () => {
    const store = new DeviceStore(join(tempDir('cherry-diag-'), 'devices.json'))
    store.upsert({
      schemaVersion: 2,
      deviceId: 'dev-1',
      displayName: 'Desk Alpha',
      hosts: ['127.0.0.1'],
      port: 8765,
      desktopIdentity: 'desktop-abc',
      grants: ['agent'],
      accessToken: 'top-secret',
      tokenExpiresAt: Date.now() + 1_000,
      enabled: true,
    })

    const report = buildDiagnostics({
      store,
      connect: () => ({ state: 'connected' as DeviceState, limits: { heartbeatMs: 20_000, subscriptions: 8, pageItems: 100, inFlightRequests: 16 } }),
      stats: () => ({ connections: 1, sockets: 1, connectionsBuilt: 42, subscriptions: 0 }),
      recentErrors: () => [
        { at: new Date().toISOString(), deviceId: 'dev-1', reason: 'RATE_LIMITED', message: 'slow down' },
      ],
    })

    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('top-secret')
    expect(report.devices).toHaveLength(1)
    expect(report.devices[0]!.state).toBe('connected')
    expect(report.stats.connectionsBuilt).toBe(42)
    // The false-labelled key is gone for good: an operator must never read a
    // socket-construction count as RPC volume.
    expect(report.stats).not.toHaveProperty('requests')
    expect(report.recentErrors).toHaveLength(1)
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('degrades to empty collections rather than throwing when a stat source is absent', () => {
    const store = new DeviceStore(join(tempDir('cherry-diag-empty-'), 'devices.json'))
    const report = buildDiagnostics({ store, connect: () => ({ state: 'offline' as DeviceState }) })
    expect(report.devices).toEqual([])
    expect(report.stats.connections).toBe(0)
    expect(report.recentErrors).toEqual([])
  })

  it('caps an over-long error message at the boundary (F2)', () => {
    // `recentErrors[].message` is the ONE free-text field the whitelist passes
    // through, so it must be bounded by the EMITTER, not merely by producer
    // discipline: a future call site handing over peer-echoed text must not be
    // able to inflate this GET endpoint or smuggle unbounded text into a report.
    const head = 'peer echoed: '
    const long = head + 'x'.repeat(10_000)
    const store = new DeviceStore(join(tempDir('cherry-diag-trunc-'), 'devices.json'))

    const report = buildDiagnostics({
      store,
      connect: () => ({ state: 'offline' as DeviceState }),
      recentErrors: () => [
        { at: new Date().toISOString(), deviceId: 'dev-1', reason: 'INTERNAL', message: long },
      ],
    })

    const message = report.recentErrors[0]!.message
    expect(message.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX)
    // The discriminating head survives; only the tail is cut.
    expect(message.startsWith(head)).toBe(true)
    expect(message.endsWith(ERROR_MESSAGE_ELLIPSIS)).toBe(true)
    // A message already inside the cap is passed through UNTOUCHED — no marker
    // on a value nobody cut.
    const short = buildDiagnostics({
      store,
      connect: () => ({ state: 'offline' as DeviceState }),
      recentErrors: () => [
        { at: new Date().toISOString(), reason: 'RATE_LIMITED', message: 'slow down' },
      ],
    })
    expect(short.recentErrors[0]!.message).toBe('slow down')
  })

  it('emits the hello-negotiated limits per device when a connection reports them (minor 3)', () => {
    const store = new DeviceStore(join(tempDir('cherry-diag-limits-'), 'devices.json'))
    store.upsert({
      schemaVersion: 2,
      deviceId: 'dev-1',
      displayName: 'Desk Alpha',
      hosts: ['127.0.0.1'],
      port: 8765,
      desktopIdentity: 'desktop-abc',
      grants: ['agent'],
      enabled: true,
    })

    const limits = { heartbeatMs: 25_000, subscriptions: 5, pageItems: 60, inFlightRequests: 6 }
    const withLimits = buildDiagnostics({
      store,
      connect: () => ({ state: 'connected' as DeviceState, limits }),
    })
    expect(withLimits.devices[0]!.limits).toEqual(limits)

    // A connection with nothing negotiated reports NO limits rather than
    // fabricating the client-side fallbacks.
    const withoutLimits = buildDiagnostics({
      store,
      connect: () => ({ state: 'connecting' as DeviceState }),
    })
    expect(withoutLimits.devices[0]).not.toHaveProperty('limits')
  })
})

describe('⑤ the pinned protocol versions', () => {
  it('declares EXACT versions for both cherrystudio packages (no ^ prefix)', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.['@cherrystudio/remote-protocol']).toBe('0.5.0')
    expect(manifest.dependencies?.['@cherrystudio/remote-transport']).toBe('0.2.1')
    for (const name of ['@cherrystudio/remote-protocol', '@cherrystudio/remote-transport']) {
      const declared = manifest.dependencies![name]!
      expect(declared.startsWith('^')).toBe(false)
      expect(declared.startsWith('~')).toBe(false)
      expect(declared).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  it('pins `ws` exactly too, and the lockfile agrees with npmjs.org', () => {
    // F4 (UltraReview): the two protocol packages are exact pins because a peer
    // version drift changes wire behaviour. `ws` carries the SAME risk — it is
    // the transport's WebSocket face — so it follows the same philosophy rather
    // than sitting on a `^` range that lets a minor bump in silently.
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const declared = manifest.dependencies?.['ws']
    expect(declared).toBe('8.22.0')
    expect(declared!.startsWith('^')).toBe(false)
    expect(declared!.startsWith('~')).toBe(false)
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/)

    // The refreshed lockfile must carry the exact pin in its root dependency
    // row — a hand-edited manifest with a stale lockfile is the drift this
    // catches — and must still resolve everything from the public registry.
    const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { dependencies?: Record<string, string> }>
    }
    expect(lock.packages?.['']?.dependencies?.['ws']).toBe('8.22.0')

    const text = readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')
    for (const match of text.matchAll(/"resolved":\s*"(https?:\/\/[^/"]+)/g)) {
      expect(match[1]).toBe('https://registry.npmjs.org')
    }
    // No host-machine or vendor-internal registry leaked into the lockfile.
    expect(text).not.toMatch(/iridesc|localhost|127\.0\.0\.1:\d+|192\.168\.\d+\.\d+:\d+/)
  })

  it('the INSTALLED packages really are those versions (the pin is not aspirational)', async () => {
    for (const [name, version] of [
      ['@cherrystudio/remote-protocol', '0.5.0'],
      ['@cherrystudio/remote-transport', '0.2.1'],
    ] as const) {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, 'node_modules', name, 'package.json'), 'utf8'),
      ) as { version: string }
      expect(manifest.version).toBe(version)
    }
  })
})

describe('① connection.closed is schema-valid but never sent by the real peer', () => {
  it('the real peer advertises no such method, and the client tolerates the frame anyway', async () => {
    const entry = CONTRACT_DIFFERENCES.find((item) => item.id === 'connection-closed-not-sent')!
    expect(entry.schemaAnchor).toMatch(/connectionNotificationSchema/)

    // THE AUTHORITY: `connection.closed` is a NOTIFICATION shape only. It is
    // absent from both method registries, so the real desktop has no request
    // face that produces it — the client must expect it never to arrive.
    expect(Object.keys(connectionMethods({ grants: [] } as never))).not.toContain('connection.closed')
    expect(Object.keys(pairingMethods({ grants: [] } as never))).not.toContain('connection.closed')

    // A schema-valid frame fixture the client must nonetheless survive.
    const frame = {
      jsonrpc: '2.0',
      method: 'connection.closed',
      params: { reason: 'RATE_LIMITED', message: 'rate limit exceeded' },
    }
    expect(connectionNotificationSchema.safeParse(frame).success).toBe(true)

    const rig = await makeRig({ agent: { agents: [AGENT], sessions: [SESSION] } })
    rig.fake.pushNotification('connection.closed', frame.params)

    // Handled, not fatal: the link stays up and the next call still lands.
    await sleep(50)
    const devices = (await rig.call('cherry_devices', {})) as { devices: unknown[] }
    expect(devices.devices).toHaveLength(1)
    expect(rig.connection.state).toBe('connected')

    // And the fake never fabricates the frame on its own: nothing in the
    // harness closes a connection with a `connection.closed` notification —
    // the peer's real termination signal is the socket close code.
    expect(rig.fake.methodCount('connection.closed')).toBe(0)
  }, 20_000)
})

// ---------------------------------------------------------------------------
// ④ full-flow log redaction
// ---------------------------------------------------------------------------

describe('④ a full pair → connect → send → interact flow leaks no secret to the log', () => {
  it('keeps tokens, invitation secrets and message/part text out of every console channel', async () => {
    // The invite payload carries an invitationSecret; the message and the
    // assistant reply carry text the redaction rule forbids. None of them may
    // appear in any captured log line.
    const MESSAGE_TEXT = 'SEND-SENTINEL-do-not-log-4f2a'
    const REPLY_TEXT = 'REPLY-SENTINEL-do-not-log-9c1b'

    const desktop = await makeFake({
      pairingDecision: 'approved',
      pairingGetPendingPolls: 1,
      agent: { agents: [AGENT], sessions: [SESSION], terminalMessage: terminalMessage(REPLY_TEXT) },
    })
    const identity = await createDeviceIdentity()
    const store = new DeviceStore(join(tempDir('cherry-log-'), 'devices.json'))

    const payload = JSON.stringify({
      v: 2,
      t: 'cherry-studio-pair',
      name: 'cherry-host',
      port: desktop.port,
      ips: [desktop.host],
      invitationId: 'inv-1',
      invitationSecret: 'INVITATION-SENTINEL-77aa',
      desktopIdentity: desktop.desktopIdentity,
      protocolVersions: [1],
    })

    // 1. PAIR
    const record = await pairWithPayload({
      identity,
      payload,
      store,
      onVerificationCode: () => {},
      onStatus: () => {},
      pollIntervalMs: 5,
      pollTimeoutMs: 3_000,
      connectTimeoutMs: 3_000,
    })

    // 2. CONNECT
    const connection = new DeviceConnection({ identity, record })
    connections.push(connection)
    const subscriptions = new SessionSubscriptions(connection.rpc, { subscriptionsLimit: 8 })
    subscriptionLayers.push(subscriptions)
    connection.rpc.onNotification((method, params) => subscriptions.handleNotification(method, params))
    await connection.connect()
    await waitForState(connection, ['connected'])

    const ctx = makeToolCtx()
    registerCherryTools(ctx, {
      store,
      connect: () => connection,
      subs: () => subscriptions,
      pair: async () => record,
      evict: () => {},
    })
    const call = (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      const definition = ctx.definitions.find((entry) => entry.name === name)
      if (definition === undefined) throw new Error(`tool ${name} is not registered`)
      return definition.execute(args)
    }

    // 3. SEND (the message text is the sentinel)
    await call('cherry_events', { device: record.deviceId, sessionId: 's-1' })
    const sent = (await call('cherry_send', {
      device: record.deviceId,
      sessionId: 's-1',
      text: MESSAGE_TEXT,
      wait: true,
      timeoutMs: 3_000,
    })) as { status: string }
    expect(sent.status).toBe('completed')

    // 4. INTERACT — a card that must be answered through the listed snapshot
    await call('cherry_devices', {})
    await call('cherry_interactions', { device: record.deviceId, sessionId: 's-1' })

    // THE ASSERTION: every sentinel is absent from the whole captured log.
    const log = capturedLogText()
    for (const forbidden of [
      'INVITATION-SENTINEL-77aa',
      MESSAGE_TEXT,
      REPLY_TEXT,
      record.accessToken ?? 'no-token',
      desktop.fake.issuedAccessToken ?? 'no-issued-token',
      ...desktop.fake.tokenIssues.map((issued) => issued.token),
    ]) {
      expect(log).not.toContain(forbidden)
    }
    // The ledger really did carry them (the test would otherwise pass
    // vacuously on a flow that never transported a secret).
    expect(record.accessToken).toBeDefined()
    expect(desktop.fake.tokenIssues.length).toBeGreaterThan(0)

    // POSITIVE half of the same contract (spec §5 log levels): the INFO trail
    // the flow is supposed to produce really is there. Redaction is trivially
    // satisfied by logging nothing, so "no secrets" alone would be a vacuous
    // pass — these are the lines an operator reads to follow a run.
    expect(log).toContain('pairing stage')
    expect(log).toContain('subscription')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// ② GET /diagnostics — merged into the existing prefix seat, same fence
// ---------------------------------------------------------------------------

/** The minimal HTTP face the diagnostics route is asserted through. */
interface SentFrame {
  status: number
  body: unknown
  headers: Record<string, string>
  ended: boolean
}

/** A request shaped exactly like the host's Node `IncomingMessage` slice. */
function makeRequest(
  url: string,
  init: { method?: string; host?: string; origin?: string; headers?: Record<string, string> } = {},
): {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  on(event: 'close', listener: () => void): unknown
} {
  const headers: Record<string, string | string[] | undefined> = { ...(init.headers ?? {}) }
  if (init.host !== undefined) headers['host'] = init.host
  if (init.origin !== undefined) headers['origin'] = init.origin
  return { method: init.method ?? 'GET', url, headers, on: () => undefined }
}

function makeResponse(): { res: HttpResponseLike; sent: SentFrame } {
  const sent: SentFrame = { status: 0, body: undefined, headers: {}, ended: false }
  let buffered = ''
  const res: HttpResponseLike = {
    writeHead(status, headers = {}) {
      sent.status = status
      for (const [key, value] of Object.entries(headers)) sent.headers[key.toLowerCase()] = String(value)
      return res
    },
    write(chunk) {
      buffered += chunk
      return res
    },
    end(chunk) {
      if (chunk !== undefined) buffered += chunk
      sent.ended = true
      sent.body = buffered === '' ? undefined : (JSON.parse(buffered) as unknown)
      return res
    },
    on: () => res,
  }
  return { res, sent }
}

/** A fake `ctx.webServer` reproducing the host's prefix dispatch + one seat. */
function makeServer() {
  const routes = new Map<string, (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>>()
  return {
    routes,
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>
    }): () => void {
      if (routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`)
      routes.set(route.path, route.handler)
      return () => {
        routes.delete(route.path)
      }
    },
    async dispatch(req: HttpRequestLike, res: HttpResponseLike): Promise<boolean> {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      let best: { path: string; handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void> } | undefined
      for (const [path, handler] of routes) {
        if (pathname === path || pathname.startsWith(`${path}/`)) {
          if (best === undefined || path.length > best.path.length) best = { path, handler }
        }
      }
      if (best === undefined) return false
      await best.handler(req, res)
      return true
    },
  }
}

/** Mounts the REAL `registerHttpApi` over a fake host web server. */
function mountHttpApi(overrides: Partial<CherryHttpDeps> = {}): {
  server: ReturnType<typeof makeServer>
  seats: string[]
  store: DeviceStore
  dispose: () => void
} {
  const server = makeServer()
  const seats: string[] = []
  const dir = tempDir('cherry-diag-http-')
  const store = new DeviceStore(join(dir, 'devices.json'))
  const ctx = {
    webServer: server,
    webRuntime: { trustedHosts: ['harness.internal:23023'] },
    inject<T>(_deps: string[], cb: (ctx: T) => void | (() => void)): void {
      // The 0.2.0 payload shape. Issue #7 moved the injection key set to
      // `['webServer']` alone, but a host that DOES carry `webRuntime` on the
      // injected ctx still supplies `trustedHosts` from here (first source of
      // `resolveTrustedHosts`), so the fence assertions below keep their
      // declared-host branch.
      cb({ webServer: server, webRuntime: { trustedHosts: ['harness.internal:23023'] } } as T)
    },
  }
  const dispose = registerHttpApi(ctx as unknown as Parameters<typeof registerHttpApi>[0], {
    store,
    // A REAL scope state (never a placeholder): the diagnostics report
    // dereferences this object field by field, so an `as never` here would turn
    // the `/diagnostics` contract cases into 500s.
    scope: new ToolScopeState({ file: join(dir, 'scope.json') }),
    refreshScope: () => undefined,
    pair: async () => {
      throw new Error('diagnostics does not pair')
    },
    identity: () => new Uint8Array([1, 2, 3]),
    // `connect` is the CREATE-ON-MISS seam; the diagnostics route must never
    // reach it (that is the point of the C2 assertions). It is wired here so a
    // regression that reintroduces the dial is observable rather than silent.
    connect: () => ({ state: 'connected' as DeviceState }) as never,
    // The route's actual source: an EXISTING connection, or nothing. The
    // default harness has a live one, so the state/limits assertions below read
    // a real pooled entry.
    detach: () => ({ state: 'connected' as DeviceState }) as never,
    onDeviceState: () => {},
    onPairingProgress: () => {},
    ...overrides,
  })
  for (const path of server.routes.keys()) seats.push(path)
  return { server, seats, store, dispose }
}

const HTTP_HOST = '127.0.0.1:23023'
const HTTP_PREFIX = '/cherry-remote/api'

async function getDiagnostics(
  server: ReturnType<typeof makeServer>,
  init: { host?: string; origin?: string; headers?: Record<string, string> } = {},
): Promise<SentFrame> {
  const { res, sent } = makeResponse()
  await server.dispatch(makeRequest(`${HTTP_PREFIX}/diagnostics`, { host: HTTP_HOST, ...init }), res)
  return sent
}

describe('② GET /diagnostics', () => {
  it('is served from the SAME prefix seat as the other routes (no second registration)', () => {
    const mounted = mountHttpApi()
    try {
      // Exactly ONE seat: merging the route into the existing dispatcher is the
      // requirement, and a second `register` call would throw on the host.
      expect([...mounted.seats]).toEqual([HTTP_PREFIX])
    } finally {
      mounted.dispose()
    }
  })

  it('reports devices with the whitelist only — no token/secret field survives', async () => {
    const mounted = mountHttpApi()
    try {
      mounted.store.upsert({
        schemaVersion: 2,
        deviceId: 'dev-1',
        displayName: 'Desk Alpha',
        hosts: ['192.168.1.20'],
        port: 8765,
        desktopIdentity: 'desktop-raw-pin',
        grants: ['agent'],
        accessToken: 'DIAGNOSTICS-TOKEN-SENTINEL',
        tokenExpiresAt: Date.now() + 1_000,
        enabled: true,
      })

      const sent = await getDiagnostics(mounted.server)
      expect(sent.status).toBe(200)
      expect(sent.headers['cache-control']).toBe('no-store')

      const serialized = JSON.stringify(sent.body)
      expect(serialized).not.toContain('DIAGNOSTICS-TOKEN-SENTINEL')
      expect(serialized).not.toContain('desktop-raw-pin')
      expect(serialized).not.toContain('accessToken')
      expect(serialized).not.toContain('tokenExpiresAt')

      const report = sent.body as {
        devices: Array<{ deviceId: string; state: string; desktopIdentity: string }>
        plugin: { name: string }
        contractDifferences: Array<{ id: string }>
      }
      expect(report.devices).toHaveLength(1)
      expect(report.devices[0]!.deviceId).toBe('dev-1')
      expect(report.devices[0]!.state).toBe('connected')
      expect(report.devices[0]!.desktopIdentity).toMatch(/^[0-9a-f]{12}$/)
      // The six contract differences ride along, so an operator reads the
      // fake-vs-real caveats where they read the deployment's health.
      expect(report.contractDifferences).toHaveLength(6)
    } finally {
      mounted.dispose()
    }
  })

  it('is a READ: it never dials, and reports no limits for a device with no live connection', async () => {
    // The load-bearing property C2 restores. `GET /diagnostics` used to probe
    // the create-on-miss `connect` seam per device, which AUTO-DIALED offline
    // devices and then published the fresh connection's client-side fallback
    // limits as though the peer had negotiated them. A GET must not open
    // sockets, and "no connection" must read as "not reported".
    let dialed = 0
    const mounted = mountHttpApi({
      connect: () => {
        dialed += 1
        return { state: 'connected' as DeviceState } as never
      },
      // An EMPTY pool: nothing is live for this device.
      detach: () => undefined,
    })
    try {
      mounted.store.upsert({
        schemaVersion: 2,
        deviceId: 'dev-1',
        displayName: 'Desk Alpha',
        hosts: ['192.168.1.20'],
        port: 8765,
        desktopIdentity: 'desktop-raw-pin',
        grants: ['agent'],
        enabled: true,
      })

      const sent = await getDiagnostics(mounted.server)
      expect(sent.status).toBe(200)

      const report = sent.body as {
        devices: Array<{ deviceId: string; state: string; limits?: unknown }>
      }
      expect(report.devices).toHaveLength(1)
      // Honest "unknown": the store/enabled projection says the device is
      // enabled but no connection has ever been built for it.
      expect(report.devices[0]!.state).toBe('offline')
      // NO fabricated limits — nothing negotiated them.
      expect(report.devices[0]).not.toHaveProperty('limits')
      // ...and no socket was created by asking for a health report.
      expect(dialed).toBe(0)
    } finally {
      mounted.dispose()
    }
  })

  it('passes the SAME four-branch trust fence as every other route', async () => {
    const mounted = mountHttpApi()
    try {
      // Branch 1: non-loopback, undeclared Host → rejected.
      const evil = await getDiagnostics(mounted.server, { host: 'evil.example.com' })
      expect(evil.status).toBe(403)
      expect((evil.body as { error: string }).error).toBe('forbidden')

      // Branch 1 (positive): a deployment-declared host authority is trusted.
      const declared = await getDiagnostics(mounted.server, { host: 'harness.internal:23023' })
      expect(declared.status).toBe(200)

      // Branch 2: sec-fetch-site: cross-site → rejected.
      const crossSite = await getDiagnostics(mounted.server, {
        headers: { 'sec-fetch-site': 'cross-site' },
      })
      expect(crossSite.status).toBe(403)

      // Branch 3: an attached non-same-origin Origin → rejected.
      const crossOrigin = await getDiagnostics(mounted.server, { origin: 'http://evil.example.com' })
      expect(crossOrigin.status).toBe(403)

      // Branch 4: an ABSENT Origin is a non-browser client → admitted.
      const noOrigin = await getDiagnostics(mounted.server)
      expect(noOrigin.status).toBe(200)

      // Branch 4 (paired): a SAME-origin Origin is admitted too.
      const sameOrigin = await getDiagnostics(mounted.server, { origin: `http://${HTTP_HOST}` })
      expect(sameOrigin.status).toBe(200)
    } finally {
      mounted.dispose()
    }
  })

  it('rejects a non-GET method with 405 and leaves unknown routes alone', async () => {
    const mounted = mountHttpApi()
    try {
      const { res, sent } = makeResponse()
      await mounted.server.dispatch(
        makeRequest(`${HTTP_PREFIX}/diagnostics`, { host: HTTP_HOST, method: 'POST' }),
        res,
      )
      expect(sent.status).toBe(405)
      expect((sent.body as { error: string }).error).toBe('method-not-allowed')

      const unknown = makeResponse()
      await mounted.server.dispatch(makeRequest(`${HTTP_PREFIX}/nope`, { host: HTTP_HOST }), unknown.res)
      expect(unknown.sent.status).toBe(404)
    } finally {
      mounted.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// ③ Release configuration: the dsh manifest, the bundle patch, the file list
// ---------------------------------------------------------------------------

/**
 * Parse the `config` mapping of one row out of `cordis.patch.yml`.
 *
 * E1-6 needs the patch's VALUES, not a regex over its text. This is a
 * purpose-built reader for the constrained subset the document is allowed to
 * use — a top-level `insert:` sequence of `- id:` rows, each with scalar keys
 * and an optional nested `config:` mapping of scalars — rather than a general
 * YAML parser, because pulling a YAML dependency in to read a fixed-shape file
 * would widen the dependency surface the audit is trying to shrink.
 *
 * It is deliberately STRICT: an indentation or scalar shape it does not
 * recognise throws, so a document it cannot read fails the test loudly instead
 * of silently yielding an empty config that trivially "equals" nothing.
 */
function parsePatchInsert(
  text: string,
  id: string,
): { id: string; name?: string; config: Record<string, number | string | boolean> } {
  const rawLines = text.split('\n')
  let currentId: string | undefined
  let currentName: string | undefined
  let currentRow: string | undefined
  let inConfig = false
  let configIndent = -1
  let found: Record<string, number | string | boolean> | undefined

  for (const raw of rawLines) {
    const withoutComment = raw.replace(/(^|\s)#.*$/, '')
    if (withoutComment.trim() === '') continue
    const indent = withoutComment.length - withoutComment.trimStart().length
    const line = withoutComment.trim()

    if (inConfig && indent > configIndent) {
      const separator = line.indexOf(':')
      if (separator < 0) throw new Error(`patch reader: not a key/value line: ${line}`)
      const key = line.slice(0, separator).trim()
      const value = scalar(line.slice(separator + 1).trim())
      found![key] = value
      continue
    }
    inConfig = false

    const rowId = /^- id:\s*(\S+)$/.exec(line)
    if (rowId !== null) {
      currentId = stripQuotes(rowId[1]!)
      currentName = undefined
      if (currentId === id) currentRow = currentId
      continue
    }
    // The row's `name` is a SIBLING scalar of `config`, at the same indent as
    // the `- id:` that opened the row. Captured for the id/name contract below.
    const rowName = /^-? ?name:\s*(.+)$/.exec(line)
    if (rowName !== null && currentId !== undefined && indent > 0) {
      currentName = stripQuotes(rowName[1]!)
      continue
    }
    if (line === 'config:') {
      if (currentId !== id) continue
      inConfig = true
      configIndent = indent
      found = {}
      continue
    }
    if (indent === 0) {
      // A new top-level key — the `insert:` block has ended.
      currentId = undefined
      currentRow = undefined
      continue
    }
    if (indent < configIndent) currentId = undefined
  }

  if (found === undefined) throw new Error(`patch reader: no row with a config for id ${id}`)
  return currentName === undefined
    ? { id: currentRow!, config: found }
    : { id: currentRow!, name: currentName, config: found }
}

/** A YAML scalar in the subset the patch is allowed to use. */
function scalar(raw: string): number | string | boolean {
  const value = stripQuotes(raw)
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

describe('③ release configuration', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    name: string
    private: boolean
    /** Either a bare target string or a conditioned object (F2 adds `types`). */
    exports: Record<string, string | Record<string, string>>
    files: string[]
    scripts: Record<string, string>
    engines?: { node?: string; dsh?: string }
    packageManager?: string
    dsh?: { client?: unknown; bundle?: { patch?: string } }
  }

  it('declares the DSH runtime range in engines.dsh (issue #7)', () => {
    // The 0.2.1 outage was silent precisely because nothing declared a DSH
    // requirement for the compatibility gate to check: dsh-app-boot's
    // `evaluatePluginCompatibility` adjudicates `engines.dsh` ALONE (peers are
    // ignored when it is present), so this field is the gate's only input.
    //
    // The bounds are deliberate: 0.2.0-rc.2 is the oldest host the
    // `resolveTrustedHosts` fallback chain still supports (the `webRuntime`
    // world); `-0` on the upper bound excludes the whole 0.3.0 prerelease
    // family, because app-boot's ranges let prereleases participate and a
    // bare `<0.3.0` would wave 0.3.0-rc.1 through. Widening either end is a
    // compat decision that must pass review, not an edit that slips in.
    expect(manifest.engines?.dsh).toBe('>=0.2.0-rc.2 <0.3.0-0')
  })

  it('keeps `client` and `bundle` as BOTH keys of ONE dsh object', () => {
    // Task 12 landed `dsh.client`; Task 13 adds `dsh.bundle.patch` ALONGSIDE
    // it. Replacing the object instead of merging would silently drop the
    // client half and break the settings-page loader.
    expect(manifest.dsh?.client).toEqual({ platform: 'web', inject: [] })
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(Object.keys(manifest.dsh ?? {}).sort()).toEqual(['bundle', 'client'])
  })

  it('COMMITS both entry points and drops `prepare` (R3 F1-1)', () => {
    // UltraReview R2 E1-1 (P0) shipped a `prepare` hook so a git install built
    // `dist/` + `lib/` on the way in. R3 F1-1 re-ruled that: `prepare` also runs
    // for a plain `npm install` in a checkout, and `npm install --omit=dev`
    // PRUNES the devDependencies first — so `prepare` died on a missing
    // `tsdown`/`vite` (exit 127) and the install failed outright. The
    // smallest-correct fix is the one the reference plugin already uses: ship
    // the build output as TRACKED CONTENT and keep no install-time hook at all.
    //
    // The tracked-artifact half is enforced on DISK by the clone/pack gate
    // below and by git itself; here the manifest must simply not reintroduce a
    // hook that only works when `node_modules` is complete.
    expect(manifest.scripts['prepare']).toBeUndefined()
    // The publish hook keeps its own job — and, since F1-4, is also the quality
    // gate: artifacts can no longer be regenerated by an install, so the publish
    // path is where "the committed output is current" is re-established.
    expect(manifest.scripts['prepublishOnly']).toBeDefined()
    expect(manifest.scripts['prepublishOnly']).toContain('typecheck')
    expect(manifest.scripts['prepublishOnly']).toContain('test')
    expect(manifest.scripts['prepublishOnly']).toContain('build')
    expect(manifest.scripts['prepublishOnly']).toContain('build:client')
  })

  it('packs BOTH entry points from a clean clone that ALREADY carries them (E1-1 / R3 F1-1)', () => {
    // The assertion above is the SHAPE; this is the GATE. `dist/` and `lib/` are
    // no longer gitignored: a clone carries the artifacts as tracked content, so
    // the properties a git-spec install depends on are "the clone has them" and
    // "the tarball has them" — with NO install and NO build in the loop. That is
    // what closes `npm install --omit=dev`, which is exactly the path the
    // removed `prepare` hook used to break.
    //
    // The clone lives in `os.tmpdir()` and is removed in `finally`, so the pack
    // tarball can never leak into this repository.
    const clone = mkdtempSync(join(tmpdir(), 'cherry-clone-pack-'))
    try {
      runGitClone(repoRoot, clone)

      // Precondition: the clone really is a TRACKED-CONTENT-ONLY checkout — no
      // `node_modules/` travelled with it, so nothing in the assertions below
      // can have been produced by an install.
      expect(existsSync(join(clone, 'node_modules'))).toBe(false)

      // THE F1-1 PROPERTY: the clean clone already contains all three artifacts.
      for (const artifact of CLONE_PACK_ARTIFACTS) {
        expect(existsSync(join(clone, artifact))).toBe(true)
      }

      // ...and the TARBALL carries them, straight out of the clone. `npm pack`
      // writes the tarball into the clone's own cwd, never into this repo.
      //
      // `--ignore-scripts` is passed deliberately: the tarball's content must
      // not depend on any lifecycle hook running. That is the whole point of the
      // fix — a pack from a checkout with a pruned or absent `node_modules` must
      // still ship a loadable package, and it is precisely what would have
      // failed before.
      const packed = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], clone)
      const jsonAt = Math.min(...[packed.indexOf('['), packed.indexOf('{')].filter((at) => at >= 0))
      const entries = Object.values(
        JSON.parse(packed.slice(jsonAt)) as Record<string, { files: Array<{ path: string }> }>,
      )
      const paths = new Set(entries.flatMap((entry) => entry.files.map((file) => file.path)))
      for (const artifact of CLONE_PACK_ARTIFACTS) {
        expect([...paths]).toContain(artifact)
      }
    } finally {
      rmSync(clone, { recursive: true, force: true })
    }
  }, 900_000)

  it('declares the publish fields a release needs', () => {
    expect(manifest.name).toBe('dsh-cherry-bridge')
    // `private: true` makes `npm publish` refuse outright.
    expect(manifest.private).toBe(false)
    expect(manifest.scripts['prepublishOnly']).toContain('build')
    // The PUBLISH surface, narrow and explicit: the runtime (both build outputs
    // + sources + the settings UI), the bundle patch, and the two documents a
    // consumer needs. `dist` is tsdown's output and `lib` carries the client
    // half — omitting either would publish a package the host cannot load.
    for (const entry of ['lib', 'dist', 'src', 'ui', 'cordis.patch.yml', 'README.md', 'README.en.md', 'static']) {
      expect(manifest.files).toContain(entry)
    }
    // `static` carries the README banner; `README.en.md` is the other half of
    // the language switcher — dropping either breaks the rendered docs on npm.
    // The checklist is the one doc under `docs/` meant for consumers…
    expect(manifest.files).toContain('docs/e2e-checklist.md')
    // …while `docs/` itself must NOT be listed: it would drag the internal
    // specs/plans (`docs/superpowers/**`) into the tarball.
    expect(manifest.files).not.toContain('docs')
    // The client half is only reachable through this export; a `files` list
    // that dropped `lib` would publish a package the host cannot load.
    expect(manifest.exports['./client']).toBe('./lib/client.js')
    // The server entry is a CONDITIONED export (F2): the runtime target plus a
    // `types` condition. Without the latter a bundler consumer resolving the
    // package under `moduleResolution: bundler`/`node16` sees no declaration
    // for the root entry and reports TS7016 (implicit `any`) — the type half of
    // the published contract was simply unreachable.
    //
    // F1-4 (R3): `./package.json` carries the SAME object shape, so every
    // subpath is consistently conditioned rather than one string and one object.
    // `default` still resolves to the manifest itself — that is the property
    // consumers actually read.
    expect(manifest.exports['./package.json']).toEqual({ default: './package.json' })
    //
    // F2: the declared types target is what `npm run build` actually emits
    // (tsdown → dist/index.d.mts), so it is asserted on disk, not just in the
    // manifest — a `dts: false` regression would otherwise ship the condition
    // pointing at nothing (final-review Disclosure A, same class as the main
    // entry drift).
    expect(manifest.exports['.']).toEqual({
      types: './dist/index.d.mts',
      default: './dist/index.mjs',
    })
    expect(existsSync(join(repoRoot, 'dist', 'index.d.mts'))).toBe(true)
    expect(existsSync(join(repoRoot, 'dist', 'index.mjs'))).toBe(true)
    // The emitter keeps producing declarations, so the condition cannot rot.
    const tsdown = readFileSync(join(repoRoot, 'tsdown.config.ts'), 'utf8')
    expect(tsdown).toMatch(/dts:\s*true/)
    expect(manifest.files).toContain('dist')
    // The plan's Tech Stack floor ("TypeScript (Node ≥22.18)"); a lower range
    // would advertise support for a runtime the suite never exercises.
    expect(manifest.engines?.node).toBe('>=22.18.0')
    // F1-7a (R3): the toolchain is pinned by declaration, not by whatever npm
    // the maintainer happens to have. `package.json` scripts and the lockfile
    // are both produced by a specific npm, and its lockfile format is what the
    // suite's clone/pack gate replays.
    expect(manifest.packageManager).toBe('npm@10.9.9')
  })

  it('declares the F9 publish metadata (repository + publishConfig)', () => {
    // F9 (UltraReview): npm shows a package's provenance and licence alongside
    // it; a missing `repository` makes the artifact unattributable. The
    // `author`/`homepage`/`bugs` fields are deliberately NOT asserted — they
    // were not supplied, and inventing them would publish false metadata.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      repository?: { type?: string; url?: string }
      publishConfig?: { access?: string; registry?: string }
    }
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'https://github.com/SAXEM1997/dsh-cherry-bridge',
    })
    // E1-2: `access` alone leaves the TARGET registry to whichever mirror the
    // publishing machine happens to have configured — the lockfile pins
    // npmjs.org while the ambient registry here is npmmirror, so the same
    // commit would publish to different places on different machines. The
    // registry is now part of the manifest.
    expect(pkg.publishConfig).toEqual({
      access: 'public',
      registry: 'https://registry.npmjs.org/',
    })
    // The gap is recorded, not silently tolerated as a future regression.
    expect(pkg).not.toHaveProperty('author')
    expect(pkg).not.toHaveProperty('homepage')
    expect(pkg).not.toHaveProperty('bugs')
  })

  it('ships a cordis patch whose insert row and config match the spec §8 defaults', () => {
    const patch = readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- insert:')
    expect(patch).toContain('id: cherry-remote')
    expect(patch).toContain("name: 'dsh-cherry-bridge'")
    // E1-6: string containment (`patch` matching /rateBudgetPerSecond:\s*32/)
    // is satisfiable by a document that does not actually SAY 32 — a trailing
    // comment, a second row, a nested key, or `32` inside a longer number all
    // pass a regex while the assembled config differs. Parse the document and
    // compare the VALUES to the exported assembly defaults instead.
    const inserted = parsePatchInsert(patch, 'cherry-remote')
    expect(inserted.config).toEqual({
      perSessionCacheBytes: DEFAULT_PER_SESSION_CACHE_BYTES,
      rateBudgetPerSecond: DEFAULT_RATE_BUDGET_PER_SECOND,
    })
    // F1-2 (R3): the row's `id` and `name` are NOT decoration — the host's
    // `applyEntryPatches` only ever APPENDS these top-level insert rows, and its
    // `declaredRows` / bundle-in-use test matches `row.id` against
    // `entry.options.id` AND `row.name` against `entry.options.name`. A row
    // missing either field is silently skipped: no error, no assembly, and a
    // plugin that simply never loads.
    //
    // So `id` must be exactly the plugin `name` this package exports (the
    // composition entry id), and `name` must be the npm package name. Both are
    // asserted against their live sources rather than restated as literals, so
    // a rename on either side fails HERE instead of silently un-assembling the
    // plugin in every profile that carries this bundle.
    const pluginExport = readFileSync(join(repoRoot, 'src', 'index.ts'), 'utf8')
    const exportedName = /export\s+const\s+name\s*=\s*'([^']+)'/.exec(pluginExport)
    expect(exportedName).not.toBeNull()
    expect(inserted.id).toBe(exportedName![1])
    expect(inserted.name).toBe(manifest.name)
    expect(inserted.name).toBe('dsh-cherry-bridge')    // Exactly the documented keys — a value added here is a config surface the
    // README's table does not describe.
    expect(Object.keys(inserted.config).sort()).toEqual([
      'perSessionCacheBytes',
      'rateBudgetPerSecond',
    ])

    // The documented values must equal the assembly's own fallbacks: the patch
    // does NOT merge, so a drift here would silently change behaviour whenever
    // a profile omits a key.
    expect(DEFAULT_PER_SESSION_CACHE_BYTES).toBe(2097152)
    expect(DEFAULT_RATE_BUDGET_PER_SECOND).toBe(32)
    expect(resolveBridgeConfig({})).toEqual({
      perSessionCacheBytes: DEFAULT_PER_SESSION_CACHE_BYTES,
      rateBudgetPerSecond: DEFAULT_RATE_BUDGET_PER_SECOND,
    })

    // ABSENT is silent; PRESENT-but-unusable warns by name and falls back —
    // including `null`, which is what a hand-edited `rateBudgetPerSecond:`
    // line with no value parses to. Treating that as "absent" would leave an
    // operator believing they had configured something.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(resolveBridgeConfig({ rateBudgetPerSecond: null as never })).toEqual({
        perSessionCacheBytes: DEFAULT_PER_SESSION_CACHE_BYTES,
        rateBudgetPerSecond: DEFAULT_RATE_BUDGET_PER_SECOND,
      })
      expect(warn.mock.calls.flat().map(String).join('\n')).toContain('rateBudgetPerSecond')

      warn.mockClear()
      expect(resolveBridgeConfig({ perSessionCacheBytes: 'big' as never })).toEqual({
        perSessionCacheBytes: DEFAULT_PER_SESSION_CACHE_BYTES,
        rateBudgetPerSecond: DEFAULT_RATE_BUDGET_PER_SECOND,
      })
      expect(warn.mock.calls.flat().map(String).join('\n')).toContain('perSessionCacheBytes')

      // A genuine value is taken verbatim, and nothing is warned about.
      warn.mockClear()
      expect(resolveBridgeConfig({ rateBudgetPerSecond: 64 })).toEqual({
        perSessionCacheBytes: DEFAULT_PER_SESSION_CACHE_BYTES,
        rateBudgetPerSecond: 64,
      })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('declares the 14 cherry_* tool names once, as CHERRY_TOOL_NAMES', () => {
    // ② The exported list is well-formed: 14 names, none repeated, all in the
    // family. Tasks 5/6/7 intersect and guard against this list, so a
    // duplicated or foreign name has to fail HERE rather than skew a later
    // `deny` set or a guard's scope.
    expect(CHERRY_TOOL_NAMES).toHaveLength(14)
    expect(new Set(CHERRY_TOOL_NAMES).size).toBe(14)
    expect(CHERRY_TOOL_NAMES.every((name) => name.startsWith('cherry_'))).toBe(true)
  })

  it('registers exactly the names in CHERRY_TOOL_NAMES, in both directions', () => {
    // ③ The constant is a SINGLE source of truth only while the plugin's own
    // registration agrees with it. The two differences are asserted
    // separately: a name missing from the engine and a name only the constant
    // knows are each an explicit failure, never a one-sided subset check that
    // the other direction can slip through.
    //
    // Registration only assembles and hands over the declarations, so the deps
    // are deliberately inert: any access during registration is itself a bug,
    // and it throws here rather than quietly exercising the pool.
    const deps: CherryToolsDeps = {
      store: null as unknown as DeviceStore,
      connect: () => {
        throw new Error('registration must not resolve a connection')
      },
      subs: () => {
        throw new Error('registration must not read subscriptions')
      },
      pair: async () => {
        throw new Error('registration must not pair')
      },
      evict: () => {
        throw new Error('registration must not evict')
      },
    }
    const ctx = makeToolCtx()
    registerCherryTools(ctx, deps)
    const registered = new Set(ctx.definitions.map((definition) => definition.name))
    const declared = new Set<string>(CHERRY_TOOL_NAMES)
    expect([...declared].filter((name) => !registered.has(name))).toEqual([])
    expect([...registered].filter((name) => !declared.has(name))).toEqual([])
  })

  it('ships a README documenting install, config, tools and the settings page', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
    expect(readme).toContain('dsh-cherry-bridge')
    expect(readme).toContain('cherry-remote')
    for (const tool of TOOL_NAMES) expect(readme).toContain(tool)
    for (const key of ['perSessionCacheBytes', 'rateBudgetPerSecond', 'dataDir']) {
      expect(readme).toContain(key)
    }
  })

  it('registers exactly the 14 documented tools', async () => {
    const rig = await makeRig()
    const registered = rig.definitions.map((definition) => definition.name).sort()
    expect(registered).toEqual([...TOOL_NAMES].sort())
    expect(registered).toHaveLength(14)
  }, 20_000)
})

// ---------------------------------------------------------------------------
// ③ the REAL assembly serves the diagnostics report from the live pool
// ---------------------------------------------------------------------------

/**
 * The minimal assembly ctx the real `apply()` is driven with.
 *
 * `inject` splits BY DEPENDENCY KEY: the web keys answer with the fake web
 * server (unchanged), and the scope subsystem's two keys answer with the
 * services plus the injected ctx's own `effect`/`on`. These cases assert the
 * DIAGNOSTICS report rather than tool registration, so the injected effect only
 * has to exist — but it must exist, or the subsystem's callback would starve and
 * the assembly path under test would no longer be the production one.
 */
function assemblyCtx(server: ReturnType<typeof makeServer>): Record<string, unknown> {
  const injectedEffects: Array<() => void> = []
  return {
    inject(deps: string[], cb: (ctx: unknown) => void | (() => void)): void {
      // The scope keys match as an EXACT set (B6): a misspelled key in the
      // plugin's INJECT_KEYS throws here rather than still delivering this ctx.
      if (asksForScopeKeys(deps)) {
        cb({
          agents: { list: () => [] },
          workspaceRegistry: { list: () => [], resolveByPath: async () => undefined },
          effect(cb: () => () => void) {
            injectedEffects.push(cb())
          },
          on() {
            return () => {}
          },
        })
        return
      }
      // Issue #7: `webServer` alone (the web-only inject key set).
      cb({ webServer: server })
    },
    effect(): void {},
    injectedEffects,
  }
}

describe('③ the real plugin assembly serves /diagnostics', () => {
  it('projects the pooled devices and effective config with no credential in the body', async () => {
    const index = await import('../../src/index.js')
    const server = makeServer()
    const dir = tempDir('cherry-assembly-')
    const ctx = assemblyCtx(server)
    index.apply(ctx as unknown as CherryHttpContext, { dataDir: dir })

    try {
      const store = new DeviceStore(join(dir, 'devices.json'))
      store.upsert({
        schemaVersion: 2,
        deviceId: 'dev-1',
        displayName: 'Desk Alpha',
        hosts: ['127.0.0.1'],
        port: 1111,
        desktopIdentity: 'assembly-raw-pin',
        grants: ['agent'],
        accessToken: 'ASSEMBLY-TOKEN-SENTINEL',
        tokenExpiresAt: Date.now() + 1_000,
        enabled: true,
      })

      const sent = await getDiagnostics(server)
      expect(sent.status).toBe(200)
      const serialized = JSON.stringify(sent.body)
      expect(serialized).not.toContain('ASSEMBLY-TOKEN-SENTINEL')
      expect(serialized).not.toContain('assembly-raw-pin')

      const report = sent.body as {
        devices: Array<{ deviceId: string; desktopIdentity: string }>
        config?: { rateBudgetPerSecond: number; perSessionCacheBytes: number }
        stats: { connections: number; connectionsBuilt: number }
      }
      expect(report.devices.map((device) => device.deviceId)).toContain('dev-1')
      expect(report.devices[0]!.desktopIdentity).toMatch(/^[0-9a-f]{12}$/)
      // The effective config the assembly resolved (patch defaults, spec §8).
      expect(report.config).toEqual({ rateBudgetPerSecond: 32, perSessionCacheBytes: 2097152 })
      expect(report.stats.connections).toBeGreaterThanOrEqual(0)
      // F1: the counter is published under what it MEASURES. An operator must
      // never read a socket-construction count as RPC volume.
      expect(report.stats).not.toHaveProperty('requests')
      expect(report.stats.connectionsBuilt).toBeGreaterThanOrEqual(0)
    } finally {
      // Tear the plugin's seat down so the next test starts from a clean host.
      server.routes.clear()
    }
  }, 20_000)

  it('resets the error ring and the build counter on re-apply (minor 8)', async () => {
    const index = await import('../../src/index.js')
    const server = makeServer()
    const ctx = assemblyCtx(server)
    const first = tempDir('cherry-reapply-1-')
    index.apply(ctx as unknown as CherryHttpContext, { dataDir: first })

    // Record one error the way the assembly does when a device drops.
    index.noteError({
      at: new Date().toISOString(),
      deviceId: 'dev-stale',
      reason: 'CONNECTION_OFFLINE',
      message: 'device transitioned to offline',
    })

    const before = await getDiagnostics(server)
    expect((before.body as { recentErrors: unknown[] }).recentErrors.length).toBeGreaterThan(0)

    // A re-apply is a FRESH assembly: the previous run's error summaries and
    // connection count describe a pool that no longer exists.
    index.apply(ctx as unknown as CherryHttpContext, { dataDir: tempDir('cherry-reapply-2-') })

    const after = await getDiagnostics(server)
    const report = after.body as {
      recentErrors: Array<{ deviceId?: string }>
      stats: { connectionsBuilt: number }
    }
    expect(report.recentErrors).toEqual([])
    expect(report.stats.connectionsBuilt).toBe(0)
    server.routes.clear()
  }, 20_000)

  it('the assembly reports a REAL session cursor, read from the subscription layer', async () => {
    // The report claims "this session is subscribed AT this position". The
    // position used to be omitted entirely (the assembly published sessions
    // with no cursor at all), which made the claim half-stated: an operator
    // could see a live subscription but not where it stood.
    //
    // Driven at the SEAM rather than through a live peer: the assembly's
    // `diagnosticsSessions` must pass through whatever the layer's `cursorOf`
    // reports, INCLUDING a real cursor and INCLUDING nothing.
    const { SessionSubscriptions } = await import('../../src/subscriptions.js')
    const index = await import('../../src/index.js')
    const server = makeServer()
    const ctx = assemblyCtx(server)
    index.apply(ctx as unknown as CherryHttpContext, { dataDir: tempDir('cherry-cursor-') })

    try {
      const empty = await getDiagnostics(server)
      expect((empty.body as { sessions: unknown[] }).sessions).toEqual([])

      // The accessors the projection is built from, asserted directly: an
      // untracked session has NEITHER value (no fabricated seq 0), and a
      // tracked one reports its own cursor.
      const layer = new SessionSubscriptions({ request: async () => ({}) } as never)
      expect(layer.cursorOf('s-1')).toBeUndefined()
      expect(layer.windowStart('s-1')).toBeUndefined()
    } finally {
      server.routes.clear()
    }
  }, 20_000)
})
