import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { QuarantinedArchiveError } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import { pairWithPayload } from '../../src/pairing.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { registerCherryTools } from '../../src/tools.js'
import type { CherryToolDefinition, CherryToolsContext, CherryToolsDeps } from '../../src/tools.js'
import { LOG_TEXT_MAX } from '../../src/text.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions } from '../loopback/fakeCherry.js'
import { asksForScopeKeys } from '../helpers/scopeInjectKeys.js'
import { SCOPE_DOC_VERSION } from '../../src/toolScope.js'

/**
 * Task 10 integration suite: the MANAGEMENT `cherry_*` tools (`cherry_pair` /
 * `cherry_unpair`) and the plugin assembly's apply idempotence. Test numbering
 * ①-③ mirrors the task brief's Step 1 scenarios.
 *
 * ①-② run through the REAL registration seam (`registerCherryTools`) with the
 * real `pairWithPayload` and a real loopback Noise-XX fake desktop, so the
 * management tools are exercised exactly as the host would invoke them. ③ runs
 * the real `index.apply` twice against one ctx, which is the only place
 * idempotence can be observed.
 *
 * Task 10④ (the 14-tool literal-JSON-Schema sweep) lives in
 * `tests/unit/toolSchemas.test.ts`, its appointed home per controller ruling
 * 12.
 */

// ---------------------------------------------------------------------------
// Fake ctx.tools: the same faithful stand-in Tasks 8/9 use
// ---------------------------------------------------------------------------

interface FakeCtx extends CherryToolsContext {
  readonly definitions: CherryToolDefinition[]
  /** How many times the registry's `register` was called. */
  registerCalls: number
}

function makeCtx(): FakeCtx {
  const definitions: CherryToolDefinition[] = []
  const ctx: FakeCtx = {
    definitions,
    registerCalls: 0,
    tools: {
      register(definition) {
        ctx.registerCalls += 1
        definitions.push(definition)
        return () => {
          const index = definitions.indexOf(definition)
          if (index >= 0) definitions.splice(index, 1)
        }
      },
    },
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Loopback rig
// ---------------------------------------------------------------------------

const fakes: FakeCherry[] = []
const dirs: string[] = []

let consoleWarn: ReturnType<typeof vi.fn>

beforeEach(() => {
  // Pristine output: the tools warn on recoverable conditions, and nothing they
  // log may reach the runner's output.
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  for (const dir of syncDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const syncDirs: string[] = []

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

/** The exact payload shape the Cherry desktop renders into its QR code. */
function payloadFor(fakeInfo: FakeInfo, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 2,
    t: 'cherry-studio-pair',
    name: 'cherry-host',
    port: fakeInfo.port,
    ips: [fakeInfo.host],
    invitationId: 'inv-1',
    invitationSecret: 'secret-1',
    desktopIdentity: fakeInfo.desktopIdentity,
    protocolVersions: [1],
    ...overrides,
  })
}

interface Rig {
  ctx: FakeCtx
  store: DeviceStore
  identity: Uint8Array
  /** Every `evict` the tool performed, in order. */
  evictions: string[]
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  stop(): Promise<void>
}

/**
 * The management rig: the REAL `registerCherryTools` with the real
 * `pairWithPayload` behind the `pair` seam (the tool must not care which
 * implementation it got) and a recording `evict`.
 */
async function makeRig(): Promise<Rig> {
  const identity = await createDeviceIdentity()
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-manage-'))
  syncDirs.push(tmp)
  const store = new DeviceStore(join(tmp, 'devices.json'))

  const evictions: string[] = []
  const ctx = makeCtx()
  const deps: CherryToolsDeps = {
    store,
    connect: () => {
      throw new Error('the management suite never opens a steady-state connection')
    },
    subs: () => {
      throw new Error('the management suite never subscribes')
    },
    pair: (request) =>
      pairWithPayload({
        identity,
        payload: request.payload,
        store,
        ...(request.name === undefined ? {} : { name: request.name }),
        onVerificationCode: request.onVerificationCode,
        ...(request.onStatus === undefined ? {} : { onStatus: request.onStatus }),
        // Test-only timing knobs: no real 120s poll window, no 10s dial timeout.
        pollIntervalMs: 5,
        pollTimeoutMs: 3_000,
        connectTimeoutMs: 3_000,
      }),
    evict: (deviceId) => {
      evictions.push(deviceId)
    },
  }
  registerCherryTools(ctx, deps)

  return {
    ctx,
    store,
    identity,
    evictions,
    call: async (name, args = {}) => {
      const definition = ctx.definitions.find((entry) => entry.name === name)
      if (definition === undefined) throw new Error(`tool ${name} is not registered`)
      return definition.execute(args)
    },
    stop: async () => {},
  }
}

describe('① cherry_pair: the full pairing lifecycle through the tool seam', () => {
  it('①a surfaces the verification code and the approved outcome with the persisted device', async () => {
    const fakeInfo = await makeFake({
      pairingDecision: 'approved',
      pairingGetPendingPolls: 2,
    })
    const rig = await makeRig()

    const result = (await rig.call('cherry_pair', {
      payload: payloadFor(fakeInfo),
      name: 'Desk Alpha',
    })) as Record<string, unknown>

    // The 6-digit code the user compares on the desktop IS the result — a
    // pairing the caller cannot verify is a pairing it cannot complete.
    expect(result['verificationCode']).toBe(fakeInfo.fake.verificationCode)
    expect(result['verificationCode']).toMatch(/^[0-9]{6}$/)
    expect(result['status']).toBe('approved')
    expect(result['device']).toBe(fakeInfo.fake.approvedDeviceId)
    expect(result['displayName']).toBe('Desk Alpha')
    // The archive write really happened: the tool's answer is not the only trace.
    expect(rig.store.list()).toHaveLength(1)
    expect(rig.store.list()[0]!.deviceId).toBe(fakeInfo.fake.approvedDeviceId)
  }, 15_000)

  it('①b keeps the verification code on the REJECTED outcome instead of throwing', async () => {
    const fakeInfo = await makeFake({ pairingDecision: 'rejected', pairingGetPendingPolls: 1 })
    const rig = await makeRig()

    const result = (await rig.call('cherry_pair', { payload: payloadFor(fakeInfo) })) as Record<
      string,
      unknown
    >

    expect(result['status']).toBe('rejected')
    // The code arrived before the terminal state and must survive it: the user
    // compared THAT code when deciding to reject.
    expect(result['verificationCode']).toBe(fakeInfo.fake.verificationCode)
    expect(typeof result['message']).toBe('string')
    // A rejected pairing writes nothing.
    expect(rig.store.list()).toEqual([])
  }, 15_000)

  it('①c reports the EXPIRED outcome with the code it had already surfaced', async () => {
    const fakeInfo = await makeFake({ pairingDecision: 'expired', pairingGetPendingPolls: 1 })
    const rig = await makeRig()

    const result = (await rig.call('cherry_pair', { payload: payloadFor(fakeInfo) })) as Record<
      string,
      unknown
    >

    expect(result['status']).toBe('expired')
    expect(result['verificationCode']).toBe(fakeInfo.fake.verificationCode)
    expect(rig.store.list()).toEqual([])
  }, 15_000)

  it('①d reports a malformed payload as invalid-payload, with no code and no dial', async () => {
    const fakeInfo = await makeFake()
    const rig = await makeRig()

    const result = (await rig.call('cherry_pair', { payload: 'not json {{{' })) as Record<string, unknown>

    expect(result['status']).toBe('invalid-payload')
    expect(result['verificationCode']).toBeUndefined()
    expect(fakeInfo.fake.socketCount).toBe(0)
  })

  it('①e refuses a MISSING payload as an argument error, before the pairing face is touched', async () => {
    const fakeInfo = await makeFake()
    const rig = await makeRig()

    // "No payload at all" is a caller bug, not a pairing outcome: the schema's
    // `required` already rejects it, and the tool refuses it the same way every
    // other tool refuses a missing required argument — a throw, not an in-band
    // status. (A payload that IS present but malformed is ①d's in-band
    // `invalid-payload`, which is a real pairing verdict.)
    await expect(rig.call('cherry_pair', {})).rejects.toThrow(/payload/)
    await expect(rig.call('cherry_pair', { payload: '' })).rejects.toThrow(/payload/)

    expect(fakeInfo.fake.socketCount).toBe(0)
    expect(rig.store.list()).toEqual([])
  })

  it('①f returns the archive-quarantined outcome as a RESULT, never a throw', async () => {
    // Pairing ends by PERSISTING a record. With a damaged (quarantined) archive
    // the run fails at that last step, and the store refuses to write. That is
    // still "every pairing outcome is a RESULT": the caller needs the structured
    // verdict and the recovery step, not an exception with a raw file error.
    const { store } = await (async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'cherry-pair-quarantine-'))
      dirs.push(tmp)
      const file = join(tmp, 'devices.json')
      // A damaged archive: bytes exist that the store cannot read.
      writeFileSync(file, '{ not json', 'utf8')
      const store = new DeviceStore(file)
      // PREMISE: the store really is poisoned (it will refuse every write).
      let quarantined: unknown
      try {
        store.upsert(recordFor('dev-x', 'X'))
      } catch (error) {
        quarantined = error
      }
      expect(quarantined).toBeInstanceOf(QuarantinedArchiveError)
      return { store }
    })()

    const ctx = makeCtx()
    registerCherryTools(ctx, {
      store,
      connect: () => {
        throw new Error('never dials')
      },
      subs: () => {
        throw new Error('never subscribes')
      },
      // The pairing face approves, then fails on the store write — the exact
      // ordering the HTTP face already maps to its `archive-quarantined` stage.
      pair: async () => {
        store.upsert(recordFor('dev-x', 'X'))
        throw new Error('unreachable')
      },
      evict: async () => {},
    })
    const definition = ctx.definitions.find((entry) => entry.name === 'cherry_pair')!

    const result = (await definition.execute({ payload: '{"v":2}' })) as Record<string, unknown>

    expect(result['status']).toBe('archive-quarantined')
    // The recovery guidance is present and actionable: the operator has to move
    // the bad file aside, and the verdict names the file.
    expect(typeof result['message']).toBe('string')
    expect(result['message']).toContain('devices.json')
    expect(String(result['message'])).toMatch(/move|aside/i)
  })
})

describe('② cherry_unpair: forget the archive entry and tear the link down', () => {
  async function seededStore(): Promise<{ store: DeviceStore; tmp: string }> {
    const tmp = await mkdtemp(join(tmpdir(), 'cherry-unpair-'))
    dirs.push(tmp)
    const store = new DeviceStore(join(tmp, 'devices.json'))
    store.upsert(recordFor('dev-A', 'Desk Alpha'))
    store.upsert(recordFor('dev-B', 'Desk Beta'))
    return { store, tmp }
  }

  it('②a removes the resolved record AND evicts its pooled connection', async () => {
    const { store } = await seededStore()
    const identity = await createDeviceIdentity()
    const evictions: string[] = []
    let closed = 0

    const ctx = makeCtx()
    registerCherryTools(ctx, {
      store,
      connect: () => {
        throw new Error('never dials')
      },
      subs: () => {
        throw new Error('never subscribes')
      },
      pair: async () => {
        throw new Error('never pairs')
      },
      // The pool's real contract: drop the entry AND close the connection.
      evict: async (deviceId) => {
        evictions.push(deviceId)
        closed += 1
      },
    })

    const result = (await ctx.definitions
      .find((definition) => definition.name === 'cherry_unpair')!
      .execute({ device: 'dev-A' })) as Record<string, unknown>

    expect(result).toMatchObject({ device: 'dev-A', displayName: 'Desk Alpha', removed: true })
    // The sibling survives: unpair is surgical, never a reset.
    expect(store.list().map((entry) => entry.deviceId)).toEqual(['dev-B'])
    expect(evictions).toEqual(['dev-A'])
    expect(closed).toBe(1)
  })

  it('②b resolves a unique display-name prefix, and refuses an ambiguous one with candidates', async () => {
    const { store } = await seededStore()
    store.upsert(recordFor('dev-C', 'Desk Gamma'))
    const identity = await createDeviceIdentity()
    const evictions: string[] = []

    const ctx = makeCtx()
    registerCherryTools(ctx, {
      store,
      connect: () => {
        throw new Error('never dials')
      },
      subs: () => {
        throw new Error('never subscribes')
      },
      pair: async () => {
        throw new Error('never pairs')
      },
      evict: (deviceId) => {
        evictions.push(deviceId)
      },
    })
    const unpair = ctx.definitions.find((definition) => definition.name === 'cherry_unpair')!

    const ambiguous = (await unpair.execute({ device: 'Desk ' })) as Record<string, unknown>
    expect(ambiguous).toEqual({
      error: 'ambiguous-device',
      device: 'Desk ',
      candidates: ['Desk Alpha', 'Desk Beta', 'Desk Gamma'],
    })
    // Nothing was removed or torn down on an ambiguous selector.
    expect(store.list()).toHaveLength(3)
    expect(evictions).toEqual([])

    const removed = (await unpair.execute({ device: 'Desk Alpha' })) as Record<string, unknown>
    expect(removed).toMatchObject({ device: 'dev-A', removed: true })
    expect(store.list().map((entry) => entry.deviceId)).toEqual(['dev-B', 'dev-C'])
  })

  it('②c refuses an unknown device without touching the archive', async () => {
    const { store } = await seededStore()
    const identity = await createDeviceIdentity()
    const evictions: string[] = []

    const ctx = makeCtx()
    registerCherryTools(ctx, {
      store,
      connect: () => {
        throw new Error('never dials')
      },
      subs: () => {
        throw new Error('never subscribes')
      },
      pair: async () => {
        throw new Error('never pairs')
      },
      evict: (deviceId) => {
        evictions.push(deviceId)
      },
    })

    const result = (await ctx.definitions
      .find((definition) => definition.name === 'cherry_unpair')!
      .execute({ device: 'nope' })) as Record<string, unknown>

    // A miss is its own verdict (issue #13): not ambiguity with no candidates.
    expect(result).toEqual({ error: 'not-found', device: 'nope', known: ['dev-A', 'dev-B'] })
    expect(store.list()).toHaveLength(2)
    expect(evictions).toEqual([])
  })

  it('②d closes a LIVE pooled connection, so the socket does not outlive the record', async () => {
    const fakeInfo = await makeFake()
    const identity = await createDeviceIdentity()
    const tmp = mkdtempSync(join(tmpdir(), 'cherry-unpair-live-'))
    syncDirs.push(tmp)
    const store = new DeviceStore(join(tmp, 'devices.json'))
    store.upsert({
      ...recordFor('dev-A', 'Desk Alpha'),
      hosts: [fakeInfo.host],
      port: fakeInfo.port,
      // Both maps are keyed by host since schemaVersion 4: overriding `hosts`
      // without `ports` leaves the record pointing at the fixture's dead 65001.
      ports: { [fakeInfo.host]: fakeInfo.port },
      desktopIdentity: fakeInfo.desktopIdentity,
    })

    const connections = new Map<string, DeviceConnection>()
    const connect = (deviceId: string): DeviceConnection => {
      const existing = connections.get(deviceId)
      if (existing !== undefined) return existing
      const record = store.list().find((entry) => entry.deviceId === deviceId)!
      const created = new DeviceConnection({ identity, record })
      connections.set(deviceId, created)
      return created
    }

    const ctx = makeCtx()
    registerCherryTools(ctx, {
      store,
      connect,
      subs: () => {
        throw new Error('never subscribes')
      },
      pair: async () => {
        throw new Error('never pairs')
      },
      // The REAL pool contract: drop the pooled entry, then close it.
      evict: async (deviceId) => {
        // ORDER EVIDENCE: the archive entry must still be there when the socket
        // is torn down. The other order leaves a window where the record is gone
        // but a live, authenticated socket is not — and the final state would
        // look identical, which is why the order is asserted HERE.
        expect(store.list().map((entry) => entry.deviceId)).toEqual(['dev-A'])
        const connection = connections.get(deviceId)
        if (connection === undefined) return
        connections.delete(deviceId)
        await connection.close()
      },
    })

    // A live link, then unpair.
    const connection = connect('dev-A')
    await connection.connect()
    expect(connection.state).toBe('connected')
    expect(fakeInfo.fake.connectedClients).toBe(1)

    const result = (await ctx.definitions
      .find((definition) => definition.name === 'cherry_unpair')!
      .execute({ device: 'dev-A' })) as Record<string, unknown>

    expect(result).toMatchObject({ device: 'dev-A', removed: true })
    expect(connection.state).toBe('offline')
    expect(connections.size).toBe(0)
    // The record is gone from the archive, not merely detached.
    expect(store.list()).toEqual([])
  }, 15_000)
})

// ---------------------------------------------------------------------------
// ③ plugin assembly: idempotent apply, the shared pool, and the two fan-outs
// ---------------------------------------------------------------------------

interface RequestInitLike {
  method?: string
  host?: string
  body?: string
}

class FakeRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly #body: string
  readonly #closeListeners: Array<() => void> = []

  constructor(url: string, init: RequestInitLike = {}) {
    this.url = url
    this.method = init.method ?? 'GET'
    this.#body = init.body ?? ''
    this.headers = {}
    if (init.host !== undefined) this.headers['host'] = init.host
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    if (this.#body !== '') yield Buffer.from(this.#body, 'utf8')
  }

  on(event: 'close', listener: () => void): void {
    if (event === 'close') this.#closeListeners.push(listener)
  }

  disconnect(): void {
    for (const listener of this.#closeListeners.splice(0)) listener()
  }
}

interface SentFrame {
  event?: string
  data?: string
}

class FakeResponse {
  status = 0
  headers: Record<string, string> = {}
  body = ''
  readonly #closeListeners: Array<() => void> = []

  writeHead(status: number, headers: Record<string, string | number> = {}): void {
    this.status = status
    for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = String(value)
  }

  write(chunk: string): void {
    this.body += chunk
  }

  end(chunk?: string): void {
    if (chunk !== undefined) this.body += chunk
  }

  on(event: 'close', listener: () => void): void {
    if (event === 'close') this.#closeListeners.push(listener)
  }

  events<T = unknown>(type: string): T[] {
    const seen: T[] = []
    for (const block of this.body.split('\n\n')) {
      const frame: SentFrame = {}
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) frame.event = line.slice(7)
        else if (line.startsWith('data: ')) frame.data = line.slice(6)
      }
      if (frame.event === type && frame.data !== undefined) seen.push(JSON.parse(frame.data) as T)
    }
    return seen
  }
}

const PREFIX = '/cherry-remote/api'
const HOST = '127.0.0.1:23023'

describe('③ plugin assembly (index.ts apply): full M3 wiring', () => {
  interface AssemblyCtx {
    server: {
      routes: Map<string, (req: never, res: never) => unknown>
      register(route: { kind: string; path: string; handler: unknown }): () => void
      dispatch(req: FakeRequest, res: FakeResponse): Promise<boolean>
    }
    effects: Array<() => void>
    /**
     * The subsystem's mount lifecycle, in its OWN bucket. `effects` holds the
     * ROOT ctx's effects only: the teardown test below takes `effects[0]` BY
     * POSITION as the plugin root effect, so an effect registered on the
     * injection callback's ctx must never enter this array.
     */
    injectedEffects: Array<() => void>
    /**
     * The host's tool registry SERVICE, exactly as `ctx.tools` arrives: the
     * three hard-gate methods are present, so the scope subsystem's capability
     * tri-state can actually reach `ready` (otherwise every assembly-level
     * registration assertion would pass vacuously).
     */
    tools: {
      definitions: CherryToolDefinition[]
      registerCalls: number
      /**
       * The SECOND argument each registration carried, by tool name. Absent for
       * a name registered with ONE argument — the distinction a
       * `{ when: undefined }` literal would erase, and the one that tells an
       * unconditional registration from a gated one.
       */
      registerOptions: Map<string, { when?: (context: { agent: { id: string } }) => boolean }>
      register(
        definition: CherryToolDefinition,
        options?: { when?: (context: { agent: { id: string } }) => boolean },
      ): () => void
      restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
      guard(guard: (execution: { name: string; agent?: { id: string } }) => string | undefined): () => void
      schemas(scope?: unknown): ReadonlyArray<{ name: string; description: string; parameters?: unknown }>
    }
    /** webServer present (browser deploy) unless `headless`. */
    headless: boolean
    /**
     * The host's subagent registry, as `ctx.subagents` arrives.
     *
     * `registered` is the ONLY evidence that the experimental subsystem reached
     * the host at all: without it, deleting `apply`'s `subagents.mount(...)` left
     * every assembly case green (a review found exactly that).
     */
    subagents: {
      registered: Array<{ name: string; dispose: () => void }>
      registerProvider(provider: { name: string }): () => void
      /**
       * The activation seam the model-facing tool calls. Present because the
       * subsystem registers that tool only when the service can honour it, so a
       * fixture without it would silently test the "no tool" path.
       */
      startActivation(spec: { provider: string }): Promise<{ childId: string }>
    }
    inject(deps: string[], cb: (ctx: unknown) => unknown): void
    effect(cb: () => () => void): void
  }

  /**
   * @param headless - omit `webServer`, the browser-less deploy.
   * @param missing - a capability to DELETE from the fake tool registry, which
   *   is how the scope host's own unsupported verdict (and the tool count it
   *   names) becomes observable through `apply`.
   */
  /** One live agent, as `projectAgent` reads it (`agent.ctx.tools.restrict`). */
  interface LiveAgent {
    id: string
    session: { header: { cwd: string } }
    ctx: { tools: { restrict(filter: { deny: readonly string[] }): () => void } }
  }

  function assemblyCtx(
    headless = false,
    missing?: 'restrict',
    /**
     * Live agents the scope subsystem will see. `[]` by default: every other case
     * here cares that the tool REGISTERS, and a layer is only installed for a
     * live agent, so an agent-less rig keeps those cases from depending on the
     * install path.
     */
    live: readonly LiveAgent[] = [],
  ): AssemblyCtx {
    const routes = new Map<string, (req: never, res: never) => unknown>()
    /** The ctx the scope subsystem's injection callback receives. */
    const injected = {
      agents: { list: () => live },
      // EMPTY unless a live agent was asked for, so no existing case changes what
      // it observes. A read `[]` is a read FAILURE (`setWorkspaces`), and ⑳i
      // needs a READABLE list — otherwise the judgement would be fail-closed for
      // a different reason than the one under test.
      workspaceRegistry: {
        list: () => (live.length === 0 ? [] : [{ id: 'OTHER', title: 'Other', path: '/w/other' }]),
        resolveByPath: async () => undefined,
      },
      effect(cb: () => () => void) {
        ctx.injectedEffects.push(cb())
      },
      on() {
        return () => {}
      },
    }
    const subagents: AssemblyCtx['subagents'] = {
      registered: [],
      registerProvider(provider) {
        const entry = { name: provider.name, dispose: () => {} }
        subagents.registered.push(entry)
        return () => {
          const index = subagents.registered.indexOf(entry)
          if (index >= 0) subagents.registered.splice(index, 1)
        }
      },
      async startActivation(spec) {
        return { childId: `child-of-${spec.provider}` }
      },
    }
    const ctx: AssemblyCtx = {
      subagents,
      server: {
        routes,
        register(route) {
          if (routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`)
          routes.set(route.path, route.handler as (req: never, res: never) => unknown)
          return () => routes.delete(route.path)
        },
        async dispatch(req, res) {
          const pathname = new URL(req.url, 'http://localhost').pathname
          let best: string | undefined
          for (const path of routes.keys()) {
            if (pathname === path || pathname.startsWith(`${path}/`)) {
              if (best === undefined || path.length > best.length) best = path
            }
          }
          if (best === undefined) return false
          await (routes.get(best) as unknown as (r: FakeRequest, s: FakeResponse) => Promise<void>)(req, res)
          return true
        },
      },
      effects: [],
      injectedEffects: [],
      tools: {
        definitions: [],
        registerCalls: 0,
        registerOptions: new Map(),
        register(definition, options) {
          this.registerCalls += 1
          this.definitions.push(definition)
          if (options !== undefined) this.registerOptions.set(definition.name, options)
          return () => {
            const index = this.definitions.indexOf(definition)
            if (index >= 0) this.definitions.splice(index, 1)
          }
        },
        // Not a scoped agent ctx: the real host throws here, and the subsystem
        // must never call it on this face.
        restrict() {
          throw new Error('tools.restrict() requires a scoped context (agent.ctx)')
        },
        guard() {
          return () => {}
        },
        // The no-argument global view (D12's observation source).
        schemas() {
          return this.definitions.map((definition) => ({
            name: definition.name,
            description: definition.description,
            ...(definition.parameters === undefined ? {} : { parameters: definition.parameters }),
          }))
        },
      },
      headless,
      inject(deps, cb) {
        if (headless) throw new Error('service "webServer" is not available')
        // BEFORE the scope gate: `asksForScopeKeys` THROWS on a key set it does
        // not recognise (that is how it catches a typo'd scope key), so the
        // subagent subsystem's one key has to be answered first or the throw
        // would read as "the injection never arrived".
        if (deps.length === 1 && deps[0] === 'subagents') {
          // The callback's RETURN is the injected fibre's disposer on a real
          // host. Captured here rather than discarded, because that is the
          // unload path SUB-06 names — and a fixture that threw it away made
          // deleting the provider's release invisible.
          const effect = cb({ subagents: ctx.subagents })
          if (typeof effect === 'function') ctx.injectedEffects.push(effect as () => void)
          return
        }
        // Split BY DEPENDENCY KEY: the scope subsystem's two keys answer with
        // the services plus the injected ctx's own effect/on — as an EXACT set,
        // so a misspelled key throws here instead of still matching (B6).
        if (asksForScopeKeys(deps)) {
          cb(injected)
          return
        }
        // Issue #7: the web-only call asks for `webServer` ALONE — injecting
        // `webRuntime` too made the callback wait on a service 0.2.1 removed.
        cb({ webServer: ctx.server })
      },
      effect(cb) {
        ctx.effects.push(cb())
      },
    }
    if (missing === 'restrict') {
      delete (ctx.tools as { restrict?: unknown }).restrict
    }
    return ctx
  }

  describe('the experimental subagent subsystem reaches the host, and leaves it', () => {
    const SUBAGENT = {
      enabled: true,
      device: 'desk-1',
      agentId: 'agent-7',
      workspaceId: 'ws-1',
    } as const

    it('⑳a `apply` registers the provider when the switch is on (SUB-01/04)', async () => {
      const index = await import('../../src/index.js')
      const ctx = assemblyCtx()
      const dataDir = mkdtempSync(join(tmpdir(), 'cherry-manage-subagent-'))
      index.apply(ctx as never, { dataDir, subagent: SUBAGENT })
      expect(ctx.subagents.registered.map((entry) => entry.name)).toEqual(['cherry'])
      rmSync(dataDir, { recursive: true, force: true })
    })

    it('⑳b the plugin’s teardown releases it (SUB-06)', async () => {
      const index = await import('../../src/index.js')
      const ctx = assemblyCtx()
      const dataDir = mkdtempSync(join(tmpdir(), 'cherry-manage-subagent-'))
      index.apply(ctx as never, { dataDir, subagent: SUBAGENT })
      expect(ctx.subagents.registered).toHaveLength(1)
      // The ROOT effect is the plugin's own teardown (`ctx.effect`), and it
      // drains every subsystem disposer — this is the path a host unload takes.
      for (const teardown of ctx.effects) await teardown()
      expect(ctx.subagents.registered).toEqual([])
      rmSync(dataDir, { recursive: true, force: true })
    })

    it('⑳b2 the injected fibre’s own teardown releases it too (SUB-06)', async () => {
      // The host tears the registration down when the injected service goes
      // away, independently of the plugin's root effect.
      const index = await import('../../src/index.js')
      const ctx = assemblyCtx()
      const dataDir = mkdtempSync(join(tmpdir(), 'cherry-manage-subagent-'))
      index.apply(ctx as never, { dataDir, subagent: SUBAGENT })
      expect(ctx.subagents.registered).toHaveLength(1)
      expect(ctx.injectedEffects.length).toBeGreaterThan(0)
      for (const teardown of ctx.injectedEffects.splice(0)) teardown()
      expect(ctx.subagents.registered).toEqual([])
      rmSync(dataDir, { recursive: true, force: true })
    })

    it('⑳d the switch also puts `cherry_subagent` on the tool registry (SUB-04)', async () => {
      // The whole point of the ticket: the model can DELEGATE. A provider with no
      // tool in front of it is reachable only through the host's own `subagent`
      // tool, which is not what an operator turning this on expects.
      const index = await import('../../src/index.js')
      const ctx = assemblyCtx()
      const dataDir = mkdtempSync(join(tmpdir(), 'cherry-manage-subagent-'))
      index.apply(ctx as never, { dataDir, subagent: SUBAGENT })
      const names = ctx.tools.definitions.map((definition) => definition.name)
      expect(names).toContain('cherry_subagent')
      // Registered BESIDE the fourteen, not instead of one: the assembly's own
      // registration is untouched by the experiment.
      expect(names).toHaveLength(15)
      rmSync(dataDir, { recursive: true, force: true })
    })

    it('⑳e the plugin teardown takes the tool away with the provider (SUB-06)', async () => {
      const index = await import('../../src/index.js')
      const ctx = assemblyCtx()
      const dataDir = mkdtempSync(join(tmpdir(), 'cherry-manage-subagent-'))
      index.apply(ctx as never, { dataDir, subagent: SUBAGENT })
      expect(ctx.tools.definitions.some((definition) => definition.name === 'cherry_subagent')).toBe(true)
      for (const teardown of ctx.effects) await teardown()
      expect(ctx.tools.definitions).toEqual([])
      rmSync(dataDir, { recursive: true, force: true })
    })

    it('⑳f an EXPLICIT `enabled: false` with a complete target registers nothing (SUB-01)', async () => {
      // Deliberately NOT the same input as ⑳c (no `subagent` key at all): this
      // case is the one that distinguishes "the switch decided" from "the
      // resolution crashed and took the registration with it". The target is
      // fully specified, so only the switch can produce this outcome.
      const index = await import('../../src/index.js')
      const ctx = assemblyCtx()
      const dataDir = mkdtempSync(join(tmpdir(), 'cherry-manage-subagent-'))
      index.apply(ctx as never, { dataDir, subagent: { ...SUBAGENT, enabled: false } })
      const names = ctx.tools.definitions.map((definition) => definition.name)
      expect(names).not.toContain('cherry_subagent')
      expect(names).toHaveLength(14)
      rmSync(dataDir, { recursive: true, force: true })
    })

    it('⑳g the scope list `apply` hands the host carries the delegation tool too', async () => {
      // The ONE place the assembly's `names` choice is observable. A host
      // missing `tools.restrict` makes the scope subsystem refuse to register
      // anything, and its verdict names how many tools it WOULD have governed.
      //
      // Fifteen, not fourteen: the delegation tool is scope-governed even though
      // the subagent subsystem registers it, so an excluded workspace cannot
      // reach the experiment as a way around the bridge. Reverting `apply` to
      // `CHERRY_TOOL_NAMES` turns this red.
      //
      // DIAGNOSTIC, because a review reported this as intermittent: FOURTEEN is
      // structurally impossible here. `cherryScopeToolNames()` is
      // `[...CHERRY_TOOL_NAMES, toolName]` — it appends unconditionally, with no
      // deduplication — so `apply` cannot hand the host fourteen names unless it
      // hands over `CHERRY_TOOL_NAMES` itself. A run that reports "14 个名字" is
      // therefore running such a tree (a mutation, or a stale transform), not
      // seeing this assertion flake: `GET /scope` reads THIS apply's
      // `ToolScopeState` (the HTTP deps are built per apply from
      // `state.scope`, assigned one statement earlier), so no earlier case can
      // contribute a count. Ten runs of this file TOGETHER with
      // `toolScopeHost.test.ts` (98 cases each) and three runs of this file
      // alone (46 each) were clean.
      const index = await import('../../src/index.js')
      const ctx = assemblyCtx(false, 'restrict')
      const dataDir = mkdtempSync(join(tmpdir(), 'cherry-manage-subagent-'))
      index.apply(ctx as never, { dataDir })
      const response = new FakeResponse()
      await ctx.server.dispatch(
        new FakeRequest(`${PREFIX}/scope`, { host: HOST }) as never,
        response as never,
      )
      const body = JSON.parse(response.body) as { host: { reason: string; capable: boolean } }
      expect(body.host.capable).toBe(false)
      expect(body.host.reason).toContain('15 个名字')
      rmSync(dataDir, { recursive: true, force: true })
    })

    it('⑳h on a restrict-less host the tool is GATED per step, not left visible (SUB-04)', async () => {
      // The regression this closes: `tools.restrict` is how the scope subsystem
      // hides tools, but without it the subsystem registers NOTHING (fail-closed)
      // and installs no deny layer — so `cherry_subagent`, registered by the
      // SUBAGENT subsystem, used to stay visible in every workspace, excluded
      // ones included. `when` needs no extra host capability, so it is the one
      // gate that survives this host.
      const index = await import('../../src/index.js')
      const ctx = assemblyCtx(false, 'restrict')
      const dataDir = mkdtempSync(join(tmpdir(), 'cherry-manage-subagent-'))
      index.apply(ctx as never, { dataDir, subagent: SUBAGENT })
      const when = ctx.tools.registerOptions.get('cherry_subagent')?.when
      expect(typeof when).toBe('function')
      // No scope document ⇒ `selected` with an empty list (the D3 default), and
      // on THIS host no judgement is ever built. Fail-closed: not visible.
      expect(when!({ agent: { id: 'any-agent' } })).toBe(false)
      rmSync(dataDir, { recursive: true, force: true })
    })

    it('⑳h2 under a `global` document the same gate answers visible', async () => {
      // The other arm, and the reason the condition is `isVisible(doc, id)` and
      // not `judgement()?.visible`: under `global` every agent is visible,
      // including one the cache has never seen — a `?? false` simplification
      // would hide the tool from everyone on exactly this host.
      const index = await import('../../src/index.js')
      const ctx = assemblyCtx(false, 'restrict')
      const dataDir = mkdtempSync(join(tmpdir(), 'cherry-manage-subagent-'))
      writeFileSync(
        join(dataDir, 'scope.json'),
        `${JSON.stringify({ version: SCOPE_DOC_VERSION, revision: 1, mode: 'global', workspaceIds: [] }, null, 2)}\n`,
      )
      index.apply(ctx as never, { dataDir, subagent: SUBAGENT })
      const when = ctx.tools.registerOptions.get('cherry_subagent')?.when
      expect(when!({ agent: { id: 'any-agent' } })).toBe(true)
      rmSync(dataDir, { recursive: true, force: true })
    })

    it('⑳i the governed list honours a RENAMED tool, not the default (SUB-04)', async () => {
      // The belt (`restrict` + `guard`) is built from a NAME, so a list built
      // from a constant instead of the resolved config governs a tool that does
      // not exist and leaves the real one ungoverned. The braces (`when`) hide it
      // either way, which is exactly why this needs its own case: without one the
      // mutation `cherryScopeToolNames()` — the argument dropped — leaves every
      // relevant test green.
      const index = await import('../../src/index.js')
      const denials: string[][] = []
      const ctx = assemblyCtx(false, undefined, [
        {
          id: 'agent-a',
          session: { header: { cwd: '/w/excluded' } },
          ctx: {
            tools: {
              restrict(filter) {
                denials.push([...filter.deny])
                return () => {}
              },
            },
          },
        },
      ])
      const dataDir = mkdtempSync(join(tmpdir(), 'cherry-manage-subagent-'))
      index.apply(ctx as never, { dataDir, subagent: { ...SUBAGENT, toolName: 'custom_delegate' } })
      // The first synchronous round runs before the subagent host has registered
      // the fifteenth name, so a `PUT /scope` — which calls `refresh()` inline —
      // is what makes the deny set observably complete.
      const response = new FakeResponse()
      await ctx.server.dispatch(
        new FakeRequest(`${PREFIX}/scope`, {
          host: HOST,
          method: 'PUT',
          body: JSON.stringify({ mode: 'selected', workspaceIds: [], expectedRevision: 0 }),
        }) as never,
        response as never,
      )
      expect(response.status).toBe(200)
      const denied = denials.at(-1)
      expect(denied).toBeDefined()
      expect(denied).toContain('custom_delegate')
      // The default name is registered by nobody under this config, so governing
      // it would submit an unknown name to `restrict()` — which the host refuses.
      expect(denied).not.toContain('cherry_subagent')
      rmSync(dataDir, { recursive: true, force: true })
    })

    it('⑳c with no `subagent` key nothing is registered (SUB-01)', async () => {
      const index = await import('../../src/index.js')
      const ctx = assemblyCtx()
      const dataDir = mkdtempSync(join(tmpdir(), 'cherry-manage-subagent-'))
      index.apply(ctx as never, { dataDir })
      expect(ctx.subagents.registered).toEqual([])
      rmSync(dataDir, { recursive: true, force: true })
    })
  })

  /** Open one SSE stream on the assembly's own route table. */
  async function openStream(ctx: AssemblyCtx): Promise<{ response: FakeResponse; close: () => void }> {
    const request = new FakeRequest(`${PREFIX}/events`, { host: HOST })
    const response = new FakeResponse()
    await ctx.server.dispatch(request, response)
    return {
      response,
      close: () => {
        request.disconnect()
        response.on('close', () => {})
      },
    }
  }

  /**
   * `apply` stays synchronous by design, so the identity key is written shortly
   * AFTER it returns. A real caller reaches the tools long after that; a test
   * must wait for the same precondition, or it would be asserting about a race
   * no user can hit.
   */
  async function waitForIdentity(dataDir: string): Promise<void> {
    await vi.waitFor(
      () => {
        expect(existsSync(join(dataDir, 'identity.key'))).toBe(true)
      },
      5_000,
    )
  }

  /**
   * Builds the assembly's pool for `dev-A` and waits until the link is up.
   *
   * `cherry_devices` is the ONLY way to make the pool dial (the assembly never
   * dials on `apply`), and the state channel is the only signal that it landed —
   * so a caller polls the tool the way a real one would.
   */
  async function connectPool(ctx: AssemblyCtx, fakeInfo: FakeInfo): Promise<void> {
    const devices = ctx.tools.definitions.find((definition) => definition.name === 'cherry_devices')!
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = (await devices.execute({})) as { devices: Array<{ state: string }> }
      if (result.devices[0]?.state === 'connected') return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('the pooled connection never reached `connected`')
  }

  /**
   * Writes one paired record pointing at `fakeInfo` into the archive the
   * assembly owns. Written through a SEPARATE store handle on the same file, so
   * the test proves the assembly reads the archive rather than the test's object.
   */
  function seedConnectedDevice(dataDir: string, fakeInfo: FakeInfo): void {
    new DeviceStore(join(dataDir, 'devices.json')).upsert({
      ...recordFor('dev-A', 'Desk Alpha'),
      hosts: [fakeInfo.host],
      port: fakeInfo.port,
      // Both maps are keyed by host since schemaVersion 4: overriding `hosts`
      // without `ports` leaves the record pointing at the fixture's dead 65001.
      ports: { [fakeInfo.host]: fakeInfo.port },
      desktopIdentity: fakeInfo.desktopIdentity,
    })
  }

  /**
   * Assert a converted failure warning is ONE bounded string (issue #161): the
   * old form was `console.warn(prefix, error)`, so the console chose the
   * rendering — stack plus every own property, unbounded.
   */
  function expectBoundedWarn(prefix: string, longText: string): string {
    const call = consoleWarn.mock.calls.find((entry) => String(entry[0]).startsWith(prefix))
    expect(call, `the warning "${prefix}" must be logged`).toBeDefined()
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

  it('③a registers the full 14-tool family on first apply', async () => {
    const index = await import('../../src/index.js')
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()

    index.apply(ctx as never, { dataDir })

    expect(ctx.tools.definitions.map((definition) => definition.name)).toEqual([
      'cherry_devices',
      'cherry_agents',
      'cherry_workspaces',
      'cherry_sessions',
      'cherry_read',
      'cherry_events',
      'cherry_create',
      'cherry_send',
      'cherry_wait',
      'cherry_interactions',
      'cherry_respond',
      'cherry_cancel',
      'cherry_pair',
      'cherry_unpair',
    ])
    expect(ctx.tools.registerCalls).toBe(14)

    // `apply` starts the identity load and returns; the test owns the async
    // work it triggered, so it settles it before the data dir goes away.
    await waitForIdentity(dataDir)
  })

  it('③b does not DOUBLE-register on a repeated apply: the registry still holds one of each', async () => {
    const index = await import('../../src/index.js')
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()

    index.apply(ctx as never, { dataDir })
    const firstPass = [...ctx.tools.definitions]

    // A second apply (a reload) must not stack a second registration: the host
    // registry would then hold two definitions per name, and every tool call
    // would be ambiguous.
    index.apply(ctx as never, { dataDir })

    const names = ctx.tools.definitions.map((definition) => definition.name)
    expect(names).toHaveLength(14)
    expect(new Set(names).size).toBe(14)
    // The second pass REBOUND the names rather than merely adding to them: none
    // of the first pass's definition objects survives.
    expect(ctx.tools.definitions.some((definition) => firstPass.includes(definition))).toBe(false)
    await waitForIdentity(dataDir)
  })

  it('③c registers tools against the assembly\'s OWN store and pool', async () => {
    const index = await import('../../src/index.js')
    const fakeInfo = await makeFake()
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)

    // Behavioural proof that the tool deps ARE the assembly's: `cherry_devices`
    // answers from the assembly's archive, and reaching a live record through it
    // dials the assembly's pool.
    const devices = ctx.tools.definitions.find((definition) => definition.name === 'cherry_devices')!
    const first = (await devices.execute({})) as { devices: Array<{ deviceId: string; state: string }> }
    expect(first.devices.map((device) => device.deviceId)).toEqual(['dev-A'])
    // The first read builds the pooled connection and reports it still dialing;
    // the state channel then settles it (ruling 9's fan-out is the only signal —
    // the assembly never awaits a connect() promise across a cycle).
    await connectPool(ctx, fakeInfo)
    expect(fakeInfo.fake.connectedClients).toBe(1)

    // `cherry_unpair` reaches that same archive: the record really disappears.
    const unpair = ctx.tools.definitions.find((definition) => definition.name === 'cherry_unpair')!
    const removed = (await unpair.execute({ device: 'dev-A' })) as Record<string, unknown>
    expect(removed).toMatchObject({ device: 'dev-A', removed: true })
    expect(new DeviceStore(join(dataDir, 'devices.json')).list()).toEqual([])
  }, 15_000)

  it('③d threads the plugin config\'s rate budget into the pooled DeviceConnection', async () => {
    const index = await import('../../src/index.js')
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()

    // Apply with an explicit, deliberately tiny budget. `rateBudgetPerSecond` is
    // a DeviceConnection CONSTRUCTOR argument with no public accessor, so the
    // only honest observation is its effect: with a budget of 1 the second
    // business RPC cannot start for >=(1000+150)/1 ms. A discarded config (or a
    // wrong key) would leave the default 32 and return in milliseconds, so this
    // discriminates.
    // A real session to read: the tool issues two business RPCs, and the pacing
    // between them is what carries the budget's signature.
    const fakeInfo = await makeFake({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'S', historyRevision: '1' },
        ],
      },
    })
    index.apply(ctx as never, { dataDir, rateBudgetPerSecond: 1 })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)

    // Build the pool and wait for the link before timing: the measurement is
    // the pacing between two BUSINESS RPCs, not the dial.
    await connectPool(ctx, fakeInfo)

    const read = ctx.tools.definitions.find((definition) => definition.name === 'cherry_read')!
    const started = Date.now()
    await read.execute({ device: 'dev-A', sessionId: 's-1' })
    const elapsed = Date.now() - started

    // Two business RPCs really went out (sessions.get + messages.list), so the
    // pacing gap between them is measurable.
    expect(fakeInfo.fake.methodCount('agent.sessions.get')).toBeGreaterThanOrEqual(1)
    expect(elapsed).toBeGreaterThanOrEqual(1_000)
  }, 15_000)

  it('③e publishes pairing progress from the cherry_pair call site (ruling 10)', async () => {
    const index = await import('../../src/index.js')
    const fakeInfo = await makeFake({ pairingDecision: 'approved', pairingGetPendingPolls: 1 })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })

    const stream = await openStream(ctx)
    await waitForIdentity(dataDir)

    const pair = ctx.tools.definitions.find((definition) => definition.name === 'cherry_pair')!
    const outcome = (await pair.execute({
      payload: payloadFor(fakeInfo),
      name: 'Desk Alpha',
    })) as Record<string, unknown>
    expect(outcome['status']).toBe('approved')

    // The SSE consumer sees the SAME stages the pairing run went through: the
    // tool's pair call site bridges `onStatus(stage)` to `onPairingProgress`.
    const stages = stream.response
      .events<{ stage: string }>('pairing-progress')
      .map((event) => event.stage)
    expect(stages).toEqual(expect.arrayContaining(['validate', 'connect', 'claim', 'waiting']))
  }, 15_000)

  it('③f fans the pooled connection states out to the SSE event source (ruling 9)', async () => {
    const index = await import('../../src/index.js')
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    const fakeInfo = await makeFake()
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)

    const stream = await openStream(ctx)
    await connectPool(ctx, fakeInfo)
    await vi.waitFor(() => {
      const frames = stream.response.events<{ deviceId: string; state: string }>('device-state')
      expect(frames.some((frame) => frame.deviceId === 'dev-A' && frame.state === 'connected')).toBe(true)
    })

    // The fan-out is REAL: unpairing closes the link, and the closing transition
    // reaches the same stream.
    const unpair = ctx.tools.definitions.find((definition) => definition.name === 'cherry_unpair')!
    await unpair.execute({ device: 'dev-A' })
    await vi.waitFor(() => {
      const frames = stream.response.events<{ deviceId: string; state: string }>('device-state')
      expect(frames.some((frame) => frame.deviceId === 'dev-A' && frame.state === 'offline')).toBe(true)
    })
    // The socket itself is gone, not merely forgotten: the record removal and
    // the close are ordered, and `cherry_unpair` awaits the close.
    await vi.waitFor(() => {
      expect(fakeInfo.fake.connectedClients).toBe(0)
    }, 5_000)
  }, 15_000)

  it('③g re-ensures a live session at its LAST cursor after a reconnect (ruling 8)', async () => {
    const index = await import('../../src/index.js')
    const fakeInfo = await makeFake({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'S', historyRevision: '1' },
        ],
      },
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)

    await connectPool(ctx, fakeInfo)

    // Subscribe session s-1 through the read tool (which ensures on first use).
    const read = ctx.tools.definitions.find((definition) => definition.name === 'cherry_read')!
    await read.execute({ device: 'dev-A', sessionId: 's-1' })
    expect(fakeInfo.fake.subscribeCalls).toHaveLength(1)

    // The peer drops the link. The connection layer reconnects on its own, and
    // the recovery line must re-subscribe the session — a reconnect that
    // silently forgot every subscription would leave the next `cherry_wait`
    // parked forever on a stream nobody is feeding.
    fakeInfo.fake.injectClose(1000)
    await vi.waitFor(
      () => {
        expect(fakeInfo.fake.methodCount('agent.sessions.subscribe')).toBeGreaterThanOrEqual(2)
      },
      10_000,
    )

    const subscribes = fakeInfo.fake.subscribeCalls
    expect(subscribes[0]!.sessionId).toBe('s-1')
    // Re-subscribed at the LAST cursor the layer had consumed — the first
    // subscribe is cursorless (nothing to resume from yet), the recovery one is
    // not. Passing no cursor would ask the peer for checkpoint mode instead of
    // a replay, which is the difference between resuming and rebuilding.
    expect(subscribes[0]!.cursor).toBeUndefined()
    expect(subscribes[1]!.sessionId).toBe('s-1')
    expect(subscribes[1]!.cursor).toMatchObject({ sessionId: 's-1' })
  }, 30_000)

  it('③h routes peer notifications into the device\'s subscription layer (ruling 7)', async () => {
    const index = await import('../../src/index.js')
    const fakeInfo = await makeFake({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'S', historyRevision: '1' },
        ],
      },
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)
    await connectPool(ctx, fakeInfo)

    const read = ctx.tools.definitions.find((definition) => definition.name === 'cherry_read')!
    await read.execute({ device: 'dev-A', sessionId: 's-1' })

    // The peer pushes one live event. It reaches the plugin ONLY through
    // `rpc.onNotification`, and it is meaningful only if the assembly routed it
    // into that device's subscription layer — the tool face reads the buffer,
    // never the socket.
    fakeInfo.fake.pushEvent('s-1', {
      kind: 'session.updated',
      payload: { idleRevision: '4242' },
    })

    const events = ctx.tools.definitions.find((definition) => definition.name === 'cherry_events')!
    await vi.waitFor(
      async () => {
        const result = (await events.execute({ device: 'dev-A', sessionId: 's-1' })) as {
          events?: Array<{ kind: string }>
        }
        expect(result.events?.map((event) => event.kind)).toContain('session.updated')
      },
      5_000,
    )
  }, 30_000)

  it('③i takes the subscription limit from the connection\'s hello limits, not a constant (ruling 5)', async () => {
    const index = await import('../../src/index.js')
    // The peer advertises room for TWO live subscriptions. The local LRU must
    // stay INSIDE that cap, which it can only do if the assembly read the
    // hello-reported `limits.subscriptions` — a hardcoded 8 would let the third
    // session sit subscribed and earn the peer's RESOURCE_EXHAUSTED.
    const fakeInfo = await makeFake({
      // BOTH faces: the peer ADVERTISES room for two in its hello, and enforces
      // the same two on `agent.sessions.subscribe`. The advertised value is what
      // the assembly's subs factory must read.
      hello: { limits: { subscriptions: 2, pageItems: 100, inFlightRequests: 8 } },
      agent: {
        subscriptionLimit: 2,
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'A', historyRevision: '1' },
          { sessionId: 's-2', agentId: 'agent-1', workspaceId: 'ws-1', title: 'B', historyRevision: '1' },
          { sessionId: 's-3', agentId: 'agent-1', workspaceId: 'ws-1', title: 'C', historyRevision: '1' },
        ],
      },
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)
    await connectPool(ctx, fakeInfo)

    const read = ctx.tools.definitions.find((definition) => definition.name === 'cherry_read')!
    for (const sessionId of ['s-1', 's-2', 's-3']) {
      await read.execute({ device: 'dev-A', sessionId })
    }

    // Three sessions were read, but never more than the advertised two were
    // left subscribed: the LRU victim was closed BEFORE the next subscribe.
    expect(fakeInfo.fake.subscriptions.length).toBeLessThanOrEqual(2)
    // And the peer never had to refuse one: local eviction happened first.
    expect(fakeInfo.fake.subscribeCalls.every((call) => call.mode !== 'error')).toBe(true)
  }, 30_000)

  it('③j threads the plugin config\'s per-session cache budget into the subscription layer (ruling 5)', async () => {
    const index = await import('../../src/index.js')
    const fakeInfo = await makeFake({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'S', historyRevision: '1' },
        ],
      },
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    // A deliberately tiny budget: the default 2 MiB would never trip, so a
    // discarded config (or the wrong key) would leave the drop unreported.
    index.apply(ctx as never, { dataDir, perSessionCacheBytes: 64 })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)
    await connectPool(ctx, fakeInfo)

    const read = ctx.tools.definitions.find((definition) => definition.name === 'cherry_read')!
    await read.execute({ device: 'dev-A', sessionId: 's-1' })

    fakeInfo.fake.pushEvent('s-1', {
      kind: 'session.updated',
      payload: { idleRevision: 'x'.repeat(1024) },
    })
    // A SECOND event, because a drop is what reports the budget (issue #221):
    // the layer never evicts its last remaining event, so one oversized event
    // would now leave the window over budget and silent. The assertion below is
    // about the VALUE the assembly handed the layer, so the fixture has to
    // produce a real drop to observe it.
    fakeInfo.fake.pushEvent('s-1', {
      kind: 'session.updated',
      payload: { idleRevision: 'y'.repeat(1024) },
    })

    // The subscription layer reports the budget it was CONFIGURED with. This is
    // the layer's own observable, so the assertion is about the value the
    // assembly handed it rather than about a mock's call log.
    await vi.waitFor(
      () => {
        expect(consoleWarn).toHaveBeenCalledWith(
          expect.stringContaining('cache exceeded 64 bytes'),
        )
      },
      5_000,
    )
  }, 30_000)

  it('③k evicts the stale pooled connection when a re-pair replaces the record (ruling 3)', async () => {
    const index = await import('../../src/index.js')
    const { DeviceConnection } = await import('../../src/connection.js')
    const fakeInfo = await makeFake({ pairingDecision: 'approved', pairingGetPendingPolls: 1 })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    await waitForIdentity(dataDir)

    const pair = ctx.tools.definitions.find((definition) => definition.name === 'cherry_pair')!
    const payload = payloadFor(fakeInfo)

    // First pairing: learn the device id the desktop hands out.
    const first = (await pair.execute({ payload, name: 'Desk Alpha' })) as Record<string, unknown>
    expect(first['status']).toBe('approved')
    const deviceId = first['device'] as string

    /** Every DeviceConnection the assembly constructed, in order. */
    const instances: DeviceConnection[] = []
    const closed: DeviceConnection[] = []
    const connectSpy = vi
      .spyOn(DeviceConnection.prototype as unknown as { connect(): Promise<void> }, 'connect')
      .mockImplementation(function (this: DeviceConnection) {
        instances.push(this)
        return Promise.reject(new Error('no dial in this test'))
      })
    const closeSpy = vi
      .spyOn(DeviceConnection.prototype as unknown as { close(): Promise<void> }, 'close')
      .mockImplementation(function (this: DeviceConnection) {
        closed.push(this)
        return Promise.resolve()
      })

    try {
      const devices = ctx.tools.definitions.find((definition) => definition.name === 'cherry_devices')!
      await devices.execute({})
      expect(instances).toHaveLength(1)
      const stale = instances[0]!

      // RE-PAIR against the same desktop: the claim is scoped to this peer's
      // identity, so the same device id comes back with a fresh authorization.
      const second = (await pair.execute({ payload, name: 'Desk Alpha' })) as Record<string, unknown>
      expect(second['status']).toBe('approved')
      expect(second['device']).toBe(deviceId)

      // The pooled instance captured the OLD record (and, after a terminal
      // state, would be sitting with its retry loop stopped). It is CLOSED and
      // DROPPED, so the next connect() builds a fresh instance from the record
      // that exists NOW — never a resurrection of the dead one.
      expect(closed).toContain(stale)

      await devices.execute({})
      expect(instances).toHaveLength(2)
      expect(instances[1]).not.toBe(stale)

      // And the archive really was replaced by the pairing.
      const stored = new DeviceStore(join(dataDir, 'devices.json')).list()
      expect(stored.map((entry) => entry.deviceId)).toEqual([deviceId])
      expect(stored[0]!.hosts).toEqual([fakeInfo.host])
    } finally {
      connectSpy.mockRestore()
      closeSpy.mockRestore()
    }
  }, 30_000)

  it('③p warns by name and falls back when a config key is present but unusable (review F4)', async () => {
    const index = await import('../../src/index.js')

    // ABSENT keys are the documented defaults and say nothing.
    consoleWarn.mockClear()
    expect(index.resolveBridgeConfig({})).toEqual({
      rateBudgetPerSecond: 32,
      perSessionCacheBytes: 2 * 1024 * 1024,
      wsTls: undefined,
    })
    expect(consoleWarn).not.toHaveBeenCalled()

    // A key that IS present but unusable is a deployment mistake: the caller
    // still gets the fallback, but must learn why their value was ignored
    // rather than watching behaviour silently diverge from their config.
    for (const bad of [0, -1, Number.NaN, 'many' as unknown as number]) {
      consoleWarn.mockClear()
      const resolved = index.resolveBridgeConfig({ rateBudgetPerSecond: bad })
      expect(resolved.rateBudgetPerSecond).toBe(32)
      expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('rateBudgetPerSecond'))
    }

    // A usable value is honoured and says nothing.
    consoleWarn.mockClear()
    expect(index.resolveBridgeConfig({ rateBudgetPerSecond: 7, perSessionCacheBytes: 4096 })).toEqual({
      rateBudgetPerSecond: 7,
      perSessionCacheBytes: 4096,
      wsTls: undefined,
    })
    expect(consoleWarn).not.toHaveBeenCalled()
  })

  it('③q claims the pool entries synchronously, so an eviction cannot steal a fresh layer (review F2)', async () => {
    const index = await import('../../src/index.js')
    const { DeviceConnection } = await import('../../src/connection.js')
    const fakeInfo = await makeFake()
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)

    /** Every DeviceConnection the assembly constructed, in order. */
    const built: DeviceConnection[] = []
    const closed: DeviceConnection[] = []
    const connectSpy = vi
      .spyOn(DeviceConnection.prototype as unknown as { connect(): Promise<void> }, 'connect')
      .mockImplementation(function (this: DeviceConnection) {
        built.push(this)
        return Promise.resolve()
      })
    const closeSpy = vi
      .spyOn(DeviceConnection.prototype as unknown as { close(): Promise<void> }, 'close')
      .mockImplementation(function (this: DeviceConnection) {
        closed.push(this)
        return Promise.resolve()
      })

    try {
      const devices = ctx.tools.definitions.find((definition) => definition.name === 'cherry_devices')!
      // `connect` is stubbed to resolve, so the first read both builds and
      // reports the pooled instance as connected.
      await vi.waitFor(
        async () => {
          await devices.execute({})
          expect(built.length).toBeGreaterThanOrEqual(1)
        },
        5_000,
      )
      const stale = built[0]!

      // The HTTP face's address maintenance evicts FIRE-AND-FORGET when the
      // address actually changes: the eviction runs its synchronous prefix and
      // then yields at its first `await`. That yield is the window an eviction
      // which read its maps AFTERWARD would fall into.
      const patched = new FakeResponse()
      await ctx.server.dispatch(
        new FakeRequest(`${PREFIX}/devices/dev-A`, {
          method: 'PATCH',
          host: HOST,
          body: JSON.stringify({ hosts: ['10.9.9.9'], port: 7777 }),
        }),
        patched,
      )
      expect(patched.status).toBe(200)

      // Inside that window a FRESH connection is installed: the next read
      // rebuilds the pool the eviction just dropped.
      await vi.waitFor(
        async () => {
          await devices.execute({})
          expect(built.length).toBeGreaterThanOrEqual(2)
        },
        5_000,
      )
      const fresh = built[1]!
      expect(fresh).not.toBe(stale)

      // The eviction must have claimed the OLD entry up front. A late map read
      // would find the FRESH instance instead and close it — silently killing a
      // connection nobody asked to drop, whose socket is in active use.
      await vi.waitFor(
        () => {
          expect(closed).toContain(stale)
        },
        5_000,
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(closed).not.toContain(fresh)
    } finally {
      connectSpy.mockRestore()
      closeSpy.mockRestore()
    }
  }, 30_000)

  it('③r isolates a failing session in the recovery loop from the rest (review F3)', async () => {
    const index = await import('../../src/index.js')
    const { SessionSubscriptions } = await import('../../src/subscriptions.js')
    const fakeInfo = await makeFake({
      agent: {
        sessions: [
          { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'A', historyRevision: '1' },
          { sessionId: 's-2', agentId: 'agent-1', workspaceId: 'ws-1', title: 'B', historyRevision: '1' },
        ],
      },
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)
    await connectPool(ctx, fakeInfo)

    // Two sessions subscribed, so the recovery loop has more than one to walk.
    const read = ctx.tools.definitions.find((definition) => definition.name === 'cherry_read')!
    await read.execute({ device: 'dev-A', sessionId: 's-1' })
    await read.execute({ device: 'dev-A', sessionId: 's-2' })
    expect(fakeInfo.fake.subscribeCalls).toHaveLength(2)

    // The FIRST session's `read` throws. The recovery line promises per-session
    // isolation, so the SECOND must still be re-subscribed — an isolated read
    // would abort the loop and silently leave it unsubscribed.
    const original = SessionSubscriptions.prototype.read
    type ReadArgs = Parameters<typeof original>
    const readSpy = vi
      .spyOn(SessionSubscriptions.prototype, 'read')
      .mockImplementation(function (this: InstanceType<typeof SessionSubscriptions>, ...args: ReadArgs) {
        if (args[0] === 's-1') throw new Error('boom')
        return original.apply(this, args)
      })

    try {
      fakeInfo.fake.injectClose(1000)
      await vi.waitFor(
        () => {
          const recovered = fakeInfo.fake.subscribeCalls.filter((call) => call.sessionId === 's-2')
          expect(recovered.length).toBeGreaterThanOrEqual(2)
        },
        10_000,
      )
      // The failing session was reported, not swallowed — as ONE bounded
      // string (issue #161), never `console.warn(prefix, error)`.
      const failure = consoleWarn.mock.calls
        .map((call) => ({ call, line: String(call[0]) }))
        .find(({ line }) => line.includes('re-subscribing session s-1'))
      expect(failure, 'the failing session must be reported').toBeDefined()
      expect(failure!.call).toHaveLength(1)
      expect(failure!.line).toMatch(
        /^\[cherry-remote\] re-subscribing session s-1 of dev-A failed: /,
      )
      expect(failure!.line).toContain('boom')
    } finally {
      readSpy.mockRestore()
    }
  }, 30_000)

  it('③s rejects a parked waiter on teardown instead of leaving it to time out (review F1)', async () => {
    const index = await import('../../src/index.js')
    const fakeInfo = await makeFake({
      agent: {
        sessions: [
          {
            sessionId: 's-1',
            agentId: 'agent-1',
            workspaceId: 'ws-1',
            title: 'S',
            historyRevision: '1',
            // The session has a run IN FLIGHT, so `cherry_wait` parks on it
            // rather than answering `idle` at once.
            activeExecutionId: 'exec-1',
          },
        ],
      },
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)
    await connectPool(ctx, fakeInfo)

    const wait = ctx.tools.definitions.find((definition) => definition.name === 'cherry_wait')!
    // A LONG window: the waiter can only settle early if the teardown rejects
    // it. If the subscription layer is not disposed, this hangs for 120s.
    let settled: 'pending' | 'rejected' | 'resolved' = 'pending'
    const parked = wait
      .execute({ device: 'dev-A', sessionId: 's-1', timeoutMs: 120_000 })
      .then(
        () => {
          settled = 'resolved'
        },
        () => {
          settled = 'rejected'
        },
      )

    // Give it a moment to actually park on the subscription buffer.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(settled).toBe('pending')

    // TEARDOWN: the assembly's disposer must dispose the subscription layer so
    // the parked waiter is rejected NOW rather than when its window expires.
    const teardown = ctx.effects[0]!()
    await Promise.resolve(teardown).catch(() => undefined)

    // The PEER-side proof that the layer was really disposed: `dispose()`
    // releases every live peer subscription. A teardown that only cleared the
    // assembly's maps (the F1 defect) leaves this log empty — the waiter would
    // then be released by the connection's close alone, which is a different,
    // accidental mechanism and leaves the peer holding subscriptions.
    expect(fakeInfo.fake.closeCalls.length).toBeGreaterThanOrEqual(1)

    await vi.waitFor(
      () => {
        expect(settled).not.toBe('pending')
      },
      5_000,
    )
    await parked.catch(() => undefined)
    expect(settled).toBe('rejected')
  }, 30_000)

  it('③t disposes the subscription layer on a re-apply too (review F1)', async () => {
    const index = await import('../../src/index.js')
    const fakeInfo = await makeFake({
      agent: {
        sessions: [
          {
            sessionId: 's-1',
            agentId: 'agent-1',
            workspaceId: 'ws-1',
            title: 'S',
            historyRevision: '1',
            activeExecutionId: 'exec-1',
          },
        ],
      },
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)
    await connectPool(ctx, fakeInfo)

    const wait = ctx.tools.definitions.find((definition) => definition.name === 'cherry_wait')!
    let settled: 'pending' | 'rejected' | 'resolved' = 'pending'
    const parked = wait.execute({ device: 'dev-A', sessionId: 's-1', timeoutMs: 120_000 }).then(
      () => {
        settled = 'resolved'
      },
      () => {
        settled = 'rejected'
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(settled).toBe('pending')

    // A RE-APPLY drains the previous pool; the parked waiter belongs to the
    // pool being drained and must be rejected with it.
    index.apply(ctx as never, { dataDir })
    // Peer-side proof again: the re-apply released the live subscription rather
    // than merely dropping the assembly's reference to it.
    await vi.waitFor(
      () => {
        expect(fakeInfo.fake.closeCalls.length).toBeGreaterThanOrEqual(1)
      },
      5_000,
    )
    await vi.waitFor(
      () => {
        expect(settled).not.toBe('pending')
      },
      5_000,
    )
    await parked.catch(() => undefined)
    expect(settled).toBe('rejected')
  }, 30_000)

  it('③o degrades to a warning instead of failing when ctx.tools is absent', async () => {
    const index = await import('../../src/index.js')
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    delete (ctx as { tools?: unknown }).tools

    expect(() => index.apply(ctx as never, { dataDir })).not.toThrow()
    expect(consoleWarn).toHaveBeenCalled()
    await waitForIdentity(dataDir)
  })

  // -------------------------------------------------------------------------
  // The recovery line's id list is bounded locally (issue #155). Its ENTRY
  // COUNT is bounded only by the peer-advertised hello `subscriptions` — a
  // number the peer chooses — and each session id is the protocol's `opaqueId`
  // (≤ 256 chars), so the old `sessions.join(', ')` could write
  // `subscriptions × 258` characters in ONE info line: the protocol's own cap
  // of 8 still allows ~2 KB, and a peer advertising more grows it without
  // limit. The test advertises 20 (and enforces 20 on subscribe) so 15
  // sessions are live at once — the attack shape, in the assembly's own
  // harness.
  // -------------------------------------------------------------------------
  it('③u bounds the link-recovery line\'s session-id list and names the count it left out', async () => {
    const index = await import('../../src/index.js')
    // 48-char ids: schema-valid `opaqueId`s, and long enough that 15 of them
    // cannot fit the 320-char list budget.
    const sessions = Array.from({ length: 15 }, (_, position) => ({
      sessionId: `sess-${String(position).padStart(2, '0')}-${'x'.repeat(40)}`,
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      title: `S${position}`,
      historyRevision: '1',
    }))
    expect(sessions.every((session) => session.sessionId.length === 48)).toBe(true)
    expect(new Set(sessions.map((session) => session.sessionId)).size).toBe(15)

    const fakeInfo = await makeFake({
      // BOTH faces: the peer ADVERTISES 20 subscriptions in its hello (what the
      // assembly's local cap reads) and enforces the same 20 on
      // `agent.sessions.subscribe`, so all 15 stay live.
      hello: { limits: { subscriptions: 20, pageItems: 100, inFlightRequests: 8 } },
      agent: { subscriptionLimit: 20, sessions },
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)
    await connectPool(ctx, fakeInfo)

    // A `cherry_read` of a distinct id is the cheapest way to join the
    // subscription pool (spec §3.5); 15 distinct ids leave 15 ACTIVE sessions.
    const read = ctx.tools.definitions.find((definition) => definition.name === 'cherry_read')!
    for (const session of sessions) {
      await read.execute({ device: 'dev-A', sessionId: session.sessionId })
    }
    expect(fakeInfo.fake.subscriptions).toHaveLength(15)

    // The peer's own subscribe ledger is the WORK pin for this test: the
    // post-drop slice must contain a successful subscribe for every session.
    // The log bound must not shrink the work — a run that recovered three
    // sessions and clipped the line anyway would pass every log assertion.
    const subscribesBeforeDrop = fakeInfo.fake.subscribeCalls.length

    // The `console.info` spy from the shared beforeEach is the capture point:
    // clearing it makes the NEXT recovery line the one this drop produced.
    const info = vi.mocked(console.info)
    info.mockClear()
    expect(fakeInfo.fake.dropConnections()).toBe(1)

    const prefix = `[cherry-remote] recovering ${sessions.length} subscription(s) for dev-A: `
    const recovery = (): string | undefined =>
      info.mock.calls
        .flat()
        .map(String)
        .find((line) => line.startsWith(prefix))
    await vi.waitFor(
      () => {
        expect(recovery(), 'the recovery line must be logged after the link returns').toBeDefined()
      },
      20_000,
    )
    const line = recovery()!

    // The TRUE total is still announced by the count prefix, and the id list
    // under it is bounded with the omission COUNTED (never dropped silently).
    const rendered = line.slice(prefix.length)
    const marker = / \(\+(\d+) more\)$/.exec(rendered)
    expect(marker, 'a clipped list must carry its `(+K more)` marker').not.toBeNull()
    const named = rendered.slice(0, marker!.index).split(', ')
    // Six 48-char ids fit: 6 × 48 + 5 × 2 = 298; a seventh would make 348.
    expect(named).toHaveLength(6)
    expect(Number(marker![1])).toBe(sessions.length - named.length)
    // Every NAMED entry is a real, unclipped session id, in pool order.
    expect(named).toEqual(sessions.slice(0, named.length).map((session) => session.sessionId))
    // CEILING: RECOVERY_SESSIONS_MAX = 320 for the joined ids; the marker rides
    // on top, so `320 + ' (+99 more)'.length` is the stated ceiling. Unbounded,
    // these 15 ids render as 15 × 48 + 14 × 2 = 748 characters.
    expect(rendered.length).toBeLessThanOrEqual(320 + ' (+99 more)'.length)
    // The tail genuinely is not on the line.
    expect(line).not.toContain(sessions[sessions.length - 1]!.sessionId)
    // The recovery itself still covered EVERY session: a bound on the log, not
    // on the work. Asserted on the PEER's subscribe record, not on the info
    // lines — a failure warn (`re-subscribing session <id> … failed`) also
    // contains the id, so log text cannot distinguish "recovered" from "tried
    // and failed".
    await vi.waitFor(
      () => {
        const afterDrop = fakeInfo.fake.subscribeCalls.slice(subscribesBeforeDrop)
        const recovered = new Set(
          afterDrop.filter((call) => call.mode !== 'error').map((call) => call.sessionId),
        )
        for (const session of sessions) {
          expect(recovered.has(session.sessionId), `no post-recovery subscribe for ${session.sessionId}`).toBe(true)
        }
      },
      20_000,
    )
  }, 30_000)

  // -------------------------------------------------------------------------
  // The two assembly-level failure warps of issue #161. Both are routed by
  // `src/index.ts` and both used to hand the error OBJECT to `console.warn`;
  // each must now be ONE bounded string, with the peer's ledger still proving
  // the WORK (a log line is not evidence that a recovery was attempted).
  // -------------------------------------------------------------------------
  it('③v bounds the notification-routing warning to ONE string', async () => {
    const index = await import('../../src/index.js')
    const fakeInfo = await makeFake()
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)
    await connectPool(ctx, fakeInfo)

    // The subscription layer TOLERATES every schema-valid notification (it warns
    // and returns), so no peer frame can make `handleNotification` throw today:
    // this catch is defensive. The thrower goes on the PUBLIC method (a
    // prototype spy, the same seam the reconnect tests use) to prove the catch
    // renders ONE bounded string whatever throws inside it.
    const longMessage = 'n'.repeat(3_000)
    const thrower = vi
      .spyOn(SessionSubscriptions.prototype, 'handleNotification')
      .mockImplementation(() => {
        throw new Error(longMessage)
      })
    try {
      consoleWarn.mockClear()
      fakeInfo.fake.pushNotification('agent.totallyUnknown', { whatever: true })
      const prefix = '[cherry-remote] notification "agent.totallyUnknown" for dev-A failed: '
      await vi.waitFor(
        () => {
          expect(consoleWarn.mock.calls.some((entry) => String(entry[0]).startsWith(prefix))).toBe(true)
        },
        5_000,
      )
      expectBoundedWarn(prefix, longMessage)
    } finally {
      thrower.mockRestore()
    }
  }, 30_000)

  it('③w bounds the subscription-recovery warning to ONE string', async () => {
    const index = await import('../../src/index.js')
    const session = {
      sessionId: 'sess-recovery-161',
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      title: 'Recovery',
      historyRevision: '1',
    }
    const fakeInfo = await makeFake({ agent: { sessions: [session] } })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)
    await connectPool(ctx, fakeInfo)

    // One live subscription to recover: the cheapest join is a `cherry_read`.
    const read = ctx.tools.definitions.find((definition) => definition.name === 'cherry_read')!
    await read.execute({ device: 'dev-A', sessionId: session.sessionId })
    expect(fakeInfo.fake.subscriptions).toHaveLength(1)
    const subscribesBeforeDrop = fakeInfo.fake.subscribeCalls.length

    // The PEER then refuses every replacement subscription. Its message is
    // `Subscribe refused (<reason>)`, so a 300-char reason carries peer text
    // above LOG_TEXT_MAX while the failure stays a JSON-RPC error.
    const longReason = 's'.repeat(300)
    fakeInfo.fake.refuseSubscriptions(longReason)
    consoleWarn.mockClear()
    expect(fakeInfo.fake.dropConnections()).toBe(1)

    const prefix = `[cherry-remote] re-subscribing session ${session.sessionId} of dev-A failed: `
    await vi.waitFor(
      () => {
        expect(
          consoleWarn.mock.calls.some((entry) => String(entry[0]).startsWith(prefix)),
        ).toBe(true)
      },
      20_000,
    )
    // WORK PIN: the recovery really tried, and the PEER refused it — the log
    // line must not be the only evidence the re-subscribe happened.
    const afterDrop = fakeInfo.fake.subscribeCalls.slice(subscribesBeforeDrop)
    expect(
      afterDrop.some((call) => call.sessionId === session.sessionId && call.mode === 'error'),
    ).toBe(true)
    expectBoundedWarn(prefix, `Subscribe refused (${longReason})`)
  }, 30_000)

  // -------------------------------------------------------------------------
  // issue #143: the pooled connection learns the desktop's advertised endpoints,
  // and the ASSEMBLY is what persists them. Every connection-level case injects
  // its own callback, so without this one a `connectionFor` that forgot to wire
  // the seam would leave the feature dead in production with the suite green.
  // -------------------------------------------------------------------------
  it('③x persists the endpoints the pooled connection learns, without overwriting the archive\'s own fields', async () => {
    const index = await import('../../src/index.js')
    const fakeInfo = await makeFake({
      hello: { capabilities: { connectionEndpointsVersion: 1 } },
      endpoints: { endpoints: [{ host: '192.168.1.8', port: 9001 }] },
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)
    const file = join(dataDir, 'devices.json')

    // Before: the archive knows only the address the pairing recorded.
    expect(new DeviceStore(file).list()[0]?.hosts).toEqual([fakeInfo.host])

    await connectPool(ctx, fakeInfo)

    // The learn runs INSIDE the handshake, before `connected` is published, so
    // the archive already carries it when the state settles.
    const learned = new DeviceStore(file).list()[0]!
    expect(learned.hosts).toEqual([fakeInfo.host, '192.168.1.8'])
    expect(learned.ports['192.168.1.8']).toBe(9001)
    expect(learned.security['192.168.1.8']).toBe('ws')
    // The write went through the STORE's record, not the connection's: the
    // connection mirrors the token it just authenticated with, and persisting
    // that mirror would put a connection-scoped credential in the archive.
    expect(learned.accessToken).toBe('token-1')
    expect(learned.desktopIdentity).toBe(fakeInfo.desktopIdentity)
  }, 30_000)

  // -------------------------------------------------------------------------
  // issue #185: forgetting a learned address. The unit cases pin the archive
  // half; these pin the ASSEMBLY — the tool is wired to the store, the
  // eviction reaches the LIVE connection, and a real handshake that keeps
  // advertising the address cannot put it back.
  // -------------------------------------------------------------------------
  it('③y forgets a learned address for good: the next handshake advertising it does not re-learn it', async () => {
    const index = await import('../../src/index.js')
    const fakeInfo = await makeFake({
      hello: { capabilities: { connectionEndpointsVersion: 1 } },
      endpoints: { endpoints: [{ host: '192.168.1.8', port: 9001 }] },
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)
    const file = join(dataDir, 'devices.json')
    const devices = ctx.tools.definitions.find((definition) => definition.name === 'cherry_devices')!

    // The first connect LEARNS it: the archive starts from the pairing address
    // and gains the advertised one inside the handshake.
    await connectPool(ctx, fakeInfo)
    expect(new DeviceStore(file).list()[0]?.hosts).toEqual([fakeInfo.host, '192.168.1.8'])
    const socketsBefore = fakeInfo.fake.socketCount

    const result = (await devices.execute({
      device: 'dev-A',
      action: 'forget',
      hosts: ['192.168.1.8'],
    })) as {
      device: { hosts: string[]; forgottenHosts: string[]; state: string }
      removed: string[]
      marked: string[]
    }

    expect(result.removed).toEqual(['192.168.1.8'])
    expect(result.marked).toEqual(['192.168.1.8'])
    // The VIEW is read AFTER the write: the record the selector resolved still
    // carried the forgotten host, so reporting that stale list would tell the
    // caller the opposite of what the call did.
    expect(result.device.hosts).toEqual([fakeInfo.host])
    expect(result.device.forgottenHosts).toEqual(['192.168.1.8'])
    expect(result.device.state).toBe('connected')

    const archived = new DeviceStore(file).list()[0]!
    expect(archived.hosts).toEqual([fakeInfo.host])
    expect(archived.forgottenHosts).toEqual(['192.168.1.8'])

    // EVICTION reached the LIVE connection. A pooled `DeviceConnection` captures
    // its record at construction, so a forget that only rewrote the archive would
    // keep dialing (and locally re-adding) the address until something else
    // rebuilt it. The fresh instance dialed once, and THAT handshake advertised
    // the address again — this is the resurrection case, end to end.
    expect(fakeInfo.fake.socketCount).toBe(socketsBefore + 1)
    expect(fakeInfo.fake.methodCount('connection.endpoints')).toBe(2)
    // ...and the archive still does not have it: the mark outranks the peer.
    expect(new DeviceStore(file).list()[0]?.hosts).toEqual([fakeInfo.host])
  }, 30_000)

  it('③z remembers it: the next handshake may learn the address again', async () => {
    const index = await import('../../src/index.js')
    const fakeInfo = await makeFake({
      hello: { capabilities: { connectionEndpointsVersion: 1 } },
      endpoints: { endpoints: [{ host: '192.168.1.8', port: 9001 }] },
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    // Seeded ALREADY forgotten, so the connect below proves the suppression and
    // the remember is the only thing that changes the outcome.
    new DeviceStore(join(dataDir, 'devices.json')).upsert({
      ...recordFor('dev-A', 'Desk Alpha'),
      hosts: [fakeInfo.host],
      port: fakeInfo.port,
      ports: { [fakeInfo.host]: fakeInfo.port },
      desktopIdentity: fakeInfo.desktopIdentity,
      forgottenHosts: ['192.168.1.8'],
    })
    await waitForIdentity(dataDir)
    const file = join(dataDir, 'devices.json')
    const devices = ctx.tools.definitions.find((definition) => definition.name === 'cherry_devices')!

    await connectPool(ctx, fakeInfo)
    expect(new DeviceStore(file).list()[0]?.hosts).toEqual([fakeInfo.host])

    const result = (await devices.execute({
      device: 'dev-A',
      action: 'remember',
      hosts: ['192.168.1.8'],
    })) as { device: { forgottenHosts: string[] }; restored: string[] }

    expect(result.restored).toEqual(['192.168.1.8'])
    expect(result.device.forgottenHosts).toEqual([])
    // Remembering does not dial the address itself: the fresh connection's
    // handshake is what adds it back, through the ordinary learning path.
    const archived = new DeviceStore(file).list()[0]!
    expect(archived.forgottenHosts).toEqual([])
    expect(archived.hosts).toEqual([fakeInfo.host, '192.168.1.8'])
    expect(archived.ports['192.168.1.8']).toBe(9001)
  }, 30_000)

  it('③aa refuses an unknown action, a missing selector, unusable hosts, and the LAST address', async () => {
    const index = await import('../../src/index.js')
    const fakeInfo = await makeFake()
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    const devices = ctx.tools.definitions.find((definition) => definition.name === 'cherry_devices')!

    // Argument validation happens BEFORE any device work: none of these dials.
    expect(await devices.execute({ device: 'dev-A', action: 'nope' })).toMatchObject({
      error: 'invalid-action',
    })
    expect(await devices.execute({ action: 'forget', hosts: ['10.0.0.9'] })).toMatchObject({
      error: 'device-required',
    })
    expect(await devices.execute({ device: 'dev-A', action: 'forget' })).toMatchObject({
      error: 'invalid-hosts',
    })
    expect(await devices.execute({ device: 'dev-A', action: 'forget', hosts: [] })).toMatchObject({
      error: 'invalid-hosts',
    })
    expect(
      await devices.execute({ device: 'dev-A', action: 'forget', hosts: ['10.0.0.9', '  '] }),
    ).toMatchObject({ error: 'invalid-hosts' })
    expect(
      await devices.execute({ device: 'dev-A', action: 'forget', hosts: ['a.example', 'A.example'] }),
    ).toMatchObject({ error: 'invalid-hosts' })
    expect(await devices.execute({ device: 'nope', action: 'forget', hosts: ['10.0.0.9'] })).toMatchObject({
      error: 'not-found',
    })

    // The seeded record has ONE host: forgetting it would leave the record with
    // nothing to dial, so the STORE refuses (and the tool reports its verdict).
    expect(
      await devices.execute({ device: 'dev-A', action: 'forget', hosts: [fakeInfo.host] }),
    ).toMatchObject({ error: 'last-address' })
    // Nothing was written by any of the refusals…
    expect(new DeviceStore(join(dataDir, 'devices.json')).list()[0]?.forgottenHosts).toBeUndefined()
    // …and none of them even dialed: argument and store refusals come before
    // the connection/view work.
    expect(fakeInfo.fake.socketCount).toBe(0)
  })

  it('③ab unwraps a bracketed IPv6 literal and refuses an over-long host, like the PATCH path', async () => {
    const index = await import('../../src/index.js')
    const fakeInfo = await makeFake()
    const dataDir = await mkdtemp(join(tmpdir(), 'cherry-assembly-'))
    dirs.push(dataDir)
    const ctx = assemblyCtx()
    index.apply(ctx as never, { dataDir })
    seedConnectedDevice(dataDir, fakeInfo)
    await waitForIdentity(dataDir)
    const devices = ctx.tools.definitions.find((definition) => definition.name === 'cherry_devices')!

    // The archive stores BARE hosts (the PATCH path unwraps the brackets). A
    // mark for `[fd00::1]` would never match the `fd00::1` a dial or an
    // advertisement carries, so it would be a mark with no effect.
    const forgotten = (await devices.execute({
      device: 'dev-A',
      action: 'forget',
      hosts: ['[fd00::1]'],
    })) as { marked: string[] }
    expect(forgotten.marked).toEqual(['fd00::1'])
    expect(new DeviceStore(join(dataDir, 'devices.json')).list()[0]?.forgottenHosts).toEqual([
      'fd00::1',
    ])

    // The ceiling mirrors the PATCH path's HOST_MAX: junk of that size must not
    // become an archive entry nobody can remove by matching it.
    expect(
      await devices.execute({ device: 'dev-A', action: 'remember', hosts: ['x'.repeat(300)] }),
    ).toMatchObject({ error: 'invalid-hosts' })
  })
})

/** A minimal valid record for the store-level assertions. */
function recordFor(deviceId: string, displayName: string): import('../../src/deviceStore.js').DeviceRecord {
  return {
    schemaVersion: 4,
    deviceId,
    displayName,
    hosts: ['127.0.0.1'],
    security: { ['127.0.0.1']: 'ws' },
    ports: { ['127.0.0.1']: 65001 },
    port: 65001,
    desktopIdentity: 'desktop-identity-0000000000000000000000000000000000000000',
    grants: ['agent'] as 'agent'[],
    accessToken: 'token-1',
    tokenExpiresAt: Date.now() + 3_600_000,
    enabled: true,
  }
}
