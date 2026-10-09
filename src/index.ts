import { homedir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore } from './deviceStore'
import { loadOrCreateIdentity } from './identity'
import { DeviceConnection } from './connection'
import type { DeviceState } from './connection'
import { pairWithPayload } from './pairing'
import { SessionSubscriptions } from './subscriptions'
import { registerCherryTools } from './tools'
import type { CherryToolsContext, CherryToolsDeps } from './tools'
import { registerHttpApi } from './httpApi'
import type {
  CherryHttpContext,
  CherryHttpDeps,
  DeviceStateEvent,
  PairingProgressEvent,
} from './httpApi'
import type { DiagnosticsError } from './diagnostics'
import { truncateErrorMessage } from './diagnostics'

export const name = 'cherry-remote'

export const inject = ['tools']

/**
 * Plugin assembly — the FULL M3 wiring.
 *
 * Four things live here and nowhere else, because only the assembly can own
 * them:
 *
 *  1. **The device pool** — one lazily created {@link DeviceConnection} per
 *     archive record, shared by the tool face and the HTTP face so a device has
 *     exactly one socket however it is reached. The pool's load-bearing rule is
 *     that a `DeviceConnection` captures its `DeviceRecord` at construction and
 *     never re-reads it, so anything that changes the record must EVICT the
 *     pooled entry (see {@link evictConnection}).
 *  2. **The subscription pool** — one {@link SessionSubscriptions} per device,
 *     whose peer-negotiated `subscriptionsLimit` is read from THAT connection's
 *     hello-effective limits (never a hardcoded constant), plus the notification
 *     routing and the reconnect recovery that keep it live across a link drop.
 *  3. **The two assembly channels** — {@link publishDeviceState} and
 *     {@link publishPairingProgress}, the single fan-out every observer (the SSE
 *     event source, later a UI) subscribes to.
 *  4. **Config resolution** — the plugin-config keys with their fallbacks,
 *     applied to the objects that take them as constructor arguments.
 *
 * ## The four-line subscription wiring (brief Step 3)
 *
 *  - **subs factory** — {@link subsFor}: `subs(deviceId)` returns (lazily
 *    creating) that device's `SessionSubscriptions`.
 *  - **notification routing** — the `rpc.onNotification` hook installed in
 *    {@link connectionFor} hands every peer notification to that device's
 *    subscription layer, which is the only thing that reads the event stream.
 *  - **subscription recovery** — {@link recoverSubscriptions} runs on every
 *    transition INTO `connected`, re-ensuring each active session at its last
 *    cursor.
 *  - **event source** — the same `onState` hook publishes
 *    {@link DeviceStateEvent}s onto the assembly channel the SSE route consumes.
 *
 * Pairing's `onStatus(stage)` bridges to {@link publishPairingProgress} in
 * {@link assemblyDeps}'s `pair` member.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CherryBridgeConfig {
  /**
   * Plugin data directory holding `identity.key` and `devices.json`, both
   * 0600. Omitted follows `$DSH_HOME`, then `~/.dsh`.
   */
  dataDir?: string
  /**
   * Second-level smoothed request budget per device, handed to
   * {@link DeviceConnection}. Omitted uses {@link DEFAULT_RATE_BUDGET_PER_SECOND}.
   */
  rateBudgetPerSecond?: number
  /**
   * LOCAL per-session event-cache byte budget for {@link SessionSubscriptions}
   * (not a protocol value). Omitted uses {@link DEFAULT_PER_SESSION_CACHE_BYTES}.
   */
  perSessionCacheBytes?: number
}

/**
 * The two config values that reach constructor arguments, with their defaults
 * applied.
 *
 * Resolved ONCE per `apply` and threaded explicitly, rather than re-read at each
 * construction site: a config surface that can change between two constructions
 * of the same pool would let two devices of one plugin disagree about the budget.
 */
export interface ResolvedBridgeConfig {
  rateBudgetPerSecond: number
  perSessionCacheBytes: number
}

/** The second-level smoothed request budget (matches `DeviceConnection`'s own). */
export const DEFAULT_RATE_BUDGET_PER_SECOND = 32
/** 2 MiB of event text per session (spec §3.5). */
export const DEFAULT_PER_SESSION_CACHE_BYTES = 2 * 1024 * 1024

/** Applies the documented fallbacks to the plugin config's numeric keys. */
export function resolveBridgeConfig(config: CherryBridgeConfig = {}): ResolvedBridgeConfig {
  return {
    rateBudgetPerSecond: positive('rateBudgetPerSecond', config.rateBudgetPerSecond, DEFAULT_RATE_BUDGET_PER_SECOND),
    perSessionCacheBytes: positive('perSessionCacheBytes', config.perSessionCacheBytes, DEFAULT_PER_SESSION_CACHE_BYTES),
  }
}

/**
 * A configured positive number, or the fallback when absent/unusable.
 *
 * An ABSENT key is the documented default and says nothing; a key that is
 * PRESENT but unusable (`0`, `-1`, `NaN`, a string from a hand-edited config) is
 * a deployment mistake that silently changes behaviour, so it is warned about
 * by name rather than swallowed — the caller gets the fallback they would have
 * got anyway, plus the reason it was not their value.
 */
function positive(key: string, value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    console.warn(
      `[cherry-remote] config "${key}" must be a positive number (got ${JSON.stringify(value)}); ` +
        `falling back to ${fallback}`,
    )
    return fallback
  }
  return value
}

/** The context slice `apply` touches beyond the HTTP face's own services. */
export interface CherryBridgeContext extends CherryHttpContext, CherryToolsContext {
  effect?(callback: () => () => void): unknown
}

/** The data directory convention every DSH plugin follows. */
export function resolveDataDir(config: CherryBridgeConfig = {}, env = process.env): string {
  if (config.dataDir !== undefined && config.dataDir !== '') return config.dataDir
  const home = env['DSH_HOME']
  if (home !== undefined && home !== '') return join(home, 'cherry-remote')
  return join(homedir(), '.dsh', 'cherry-remote')
}

// ---------------------------------------------------------------------------
// Assembly state
// ---------------------------------------------------------------------------

interface AssemblyState {
  store: DeviceStore
  /** Resolved once the identity load settles; pairing reads it lazily. */
  identity: Uint8Array | undefined
  /**
   * The current apply's resolved config. Held on the state (rather than closed
   * over) because the pool helpers are module functions the HTTP face and the
   * tool face both call: a re-apply must move BOTH faces onto the new config.
   */
  rateBudgetPerSecond: number
  perSessionCacheBytes: number
  readonly connections: Map<string, DeviceConnection>
  /**
   * One subscription layer per device, sharing nothing with its siblings: the
   * peer's subscription cap is negotiated per CONNECTION, so the LRU pool that
   * enforces it must be per connection too.
   */
  readonly subscriptions: Map<string, SessionSubscriptions>
  readonly deviceStateListeners: Set<(event: DeviceStateEvent) => void>
  readonly pairingProgressListeners: Set<(event: PairingProgressEvent) => void>
  /** The previous `apply`'s teardown, so a re-apply rebinds instead of stacking. */
  disposers: Array<() => void>
  /**
   * Connections the pool has BUILT since the last `apply` — the "连接统计"
   * dimension of the diagnostics report. Deliberately NOT an RPC counter: the
   * transport layer owns request accounting, and re-deriving it here would
   * mean a second, drifting source.
   */
  connectionsBuilt: number
  /**
   * The bounded ring of recent error summaries `GET /diagnostics` serves.
   * Deliberately small and in-memory: it exists to answer "what just went
   * wrong", not to be a log store. Only the reason and a sanitized message are
   * kept — never a payload.
   */
  readonly recentErrors: DiagnosticsError[]
}

/** How many recent errors the diagnostics ring holds. */
const RECENT_ERROR_LIMIT = 20

/**
 * Records one error summary for the diagnostics endpoint.
 *
 * TWO bounds, both real:
 *
 *  - the ring keeps at most {@link RECENT_ERROR_LIMIT} entries, and
 *  - the `message` is truncated to {@link ERROR_MESSAGE_MAX} characters here
 *    too, so an over-long string never enters memory in the first place. The
 *    HTTP boundary applies the same cap again (`sanitizeDiagnostics`), which is
 *    the one that actually protects the endpoint — this one is cheap
 *    defense in depth.
 *
 * PRODUCER DISCIPLINE (not enforced by types): pass pre-redacted static context
 * — a device id, a state name, a protocol reason. NEVER a peer-echoed payload:
 * `message` is the only free-text field that reaches the report, and the
 * truncation bounds its LENGTH, not its sensitivity.
 */
export function noteError(entry: DiagnosticsError): void {
  state.recentErrors.unshift({ ...entry, message: truncateErrorMessage(entry.message) })
  if (state.recentErrors.length > RECENT_ERROR_LIMIT) state.recentErrors.length = RECENT_ERROR_LIMIT
}

const state: AssemblyState = {
  store: new DeviceStore(join(tmpdirFallback(), 'devices.json')),
  identity: undefined,
  rateBudgetPerSecond: DEFAULT_RATE_BUDGET_PER_SECOND,
  perSessionCacheBytes: DEFAULT_PER_SESSION_CACHE_BYTES,
  connections: new Map(),
  subscriptions: new Map(),
  deviceStateListeners: new Set(),
  pairingProgressListeners: new Set(),
  disposers: [],
  connectionsBuilt: 0,
  recentErrors: [],
}

/** A placeholder archive path; `apply` always replaces it before any use. */
function tmpdirFallback(): string {
  return join(homedir(), '.dsh', 'cherry-remote')
}

/** Fans one device's state transition out to every observer (SSE, later tools). */
function publishDeviceState(event: DeviceStateEvent): void {
  for (const listener of [...state.deviceStateListeners]) {
    try {
      listener(event)
    } catch (error) {
      console.warn(`[cherry-remote] device-state listener threw for ${event.deviceId}`, error)
    }
  }
}

function publishPairingProgress(event: PairingProgressEvent): void {
  for (const listener of [...state.pairingProgressListeners]) {
    try {
      listener(event)
    } catch (error) {
      console.warn('[cherry-remote] pairing-progress listener threw', error)
    }
  }
}

function requireIdentity(): Uint8Array {
  if (state.identity === undefined) {
    throw new Error('cherry-remote: the device identity is still loading; retry in a moment')
  }
  return state.identity
}

// ---------------------------------------------------------------------------
// The connection pool
// ---------------------------------------------------------------------------

/**
 * The per-device connection pool: one lazily created {@link DeviceConnection}
 * per record, kept so a device's state survives repeated reads by either face.
 *
 * Three rules make the pool safe, and each one guards a real defect:
 *
 *  - **Never await `connect()` across a cycle.** `DeviceConnection.connect()`
 *    rejects on the FIRST attempt while its backoff loop keeps retrying in the
 *    background, and its `#cycle` is settled without cycle-identity guarding —
 *    so holding a `connect()` promise across a close-then-reconnect window can
 *    surface a spurious rejection belonging to the previous cycle. The
 *    assembly's flows (upsert-then-connect, evict-then-connect) therefore never
 *    do; the state channel is how progress is observed, not the promise.
 *  - **A terminal state is final for that INSTANCE.** `identity-mismatch`,
 *    revoked grants, an incompatible protocol version and `UNAUTHENTICATED` all
 *    stop the retry loop. The only repair is eviction, so the next `connect()`
 *    builds a fresh instance — a terminal connection is never resurrected.
 *  - **Eviction is the only way a record edit is observed.** See
 *    {@link evictConnection}.
 */
function connectionFor(deviceId: string): DeviceConnection {
  const existing = state.connections.get(deviceId)
  if (existing !== undefined) return existing

  const record = state.store.list().find((device) => device.deviceId === deviceId)
  if (record === undefined) throw new Error(`cherry-remote: no device ${deviceId}`)

  const connection = new DeviceConnection({
    identity: requireIdentity(),
    record,
    rateBudgetPerSecond: state.rateBudgetPerSecond,
  })
  state.connectionsBuilt += 1
  connection.onState((deviceState: DeviceState) => {
    // The event source (ruling 9): every transition reaches the SSE fan-out.
    publishDeviceState({ deviceId, state: deviceState })
    // Diagnostics (§5 「最近错误摘要」): landing in `offline` after having been up
    // is the connection-level error an operator comes to this report for.
    if (deviceState === 'offline' || deviceState === 'identity-mismatch') {
      noteError({
        at: new Date().toISOString(),
        deviceId,
        reason: deviceState === 'identity-mismatch' ? 'IDENTITY_MISMATCH' : 'CONNECTION_OFFLINE',
        message: `device transitioned to ${deviceState}`,
      })
    }
    // Subscription recovery (ruling 8): a transition INTO `connected` means the
    // link is back, and the peer has forgotten every subscription with it.
    if (deviceState === 'connected') void recoverSubscriptions(deviceId)
  })
  // Notification routing (ruling 7): the subscription layer is the ONE reader of
  // the peer's event stream, so every notification is handed to it. The layer
  // tolerates methods it does not know.
  connection.rpc.onNotification((method, params) => {
    try {
      subsFor(deviceId).handleNotification(method, params)
    } catch (error) {
      console.warn(`[cherry-remote] notification "${method}" for ${deviceId} failed`, error)
    }
  })
  state.connections.set(deviceId, connection)
  // connect() rejects on the FIRST attempt while the backoff loop keeps
  // retrying in the background; the state channel already reported `offline`,
  // so there is nothing for the assembly to escalate.
  void connection.connect().catch(() => {})
  return connection
}

/**
 * Drops one pooled connection, closing it first so a stale socket cannot
 * outlive its record. The next `connect()` builds a fresh instance from the
 * current store record — the only way a `DeviceConnection` can observe an
 * edited address, a re-enabled flag or a RE-PAIRED record, since it captures
 * its `DeviceRecord` at construction and never re-reads it.
 *
 * The closure is AWAITED, so a caller that has a reason to care can order
 * against it: `cherry_unpair` must not delete the archive entry while the
 * socket it is holding is still up. Callers that do not care (a re-apply, the
 * HTTP face's maintenance paths) simply ignore the returned promise.
 *
 * The device's subscription layer goes with it: it is bound to the socket's rpc
 * facade and its peer-negotiated cap, so keeping it would leave the next
 * connection's notifications routed into a stale LRU pool. BOTH entries are
 * claimed in the synchronous prefix below, which is what makes that promise
 * hold for fire-and-forget callers too.
 */
async function evictConnection(deviceId: string): Promise<void> {
  // BOTH map entries are claimed SYNCHRONOUSLY, before the first `await`, and
  // that is load-bearing twice over:
  //
  //  1. `DeviceConnection.close()` contains no `await`, so awaiting it still
  //     yields a microtask. Reading the subscription map after that yield let a
  //     caller which clears the maps synchronously right after a
  //     fire-and-forget eviction (the re-apply and teardown paths) empty them
  //     first: the subscription phase then found nothing and `dispose()` was
  //     NEVER called, leaving parked waiters to hang out their whole timeout.
  //  2. A layer installed during that gap (a fresh connect racing the eviction)
  //     would otherwise be stolen by this eviction and disposed as though it
  //     were the stale one. Claiming the entry up front means we only ever
  //     dispose the instance THIS eviction owns.
  const connection = state.connections.get(deviceId)
  if (connection !== undefined) state.connections.delete(deviceId)
  const subscriptions = state.subscriptions.get(deviceId)
  if (subscriptions !== undefined) state.subscriptions.delete(deviceId)

  if (subscriptions !== undefined) {
    // The subscription layer goes FIRST: it releases the peer subscriptions over
    // the still-live socket, and it rejects any parked waiter. Closing the
    // connection first would make every `agent.subscriptions.close` fail with
    // the offline fail-fast, leaving the peer to reap the subscriptions on its
    // own and the release path noisy.
    try {
      await subscriptions.dispose()
    } catch (error) {
      console.warn(`[cherry-remote] device ${deviceId} subscription dispose failed`, error)
    }
  }
  if (connection !== undefined) {
    try {
      await connection.close()
    } catch (error) {
      console.warn(`[cherry-remote] device ${deviceId} close failed during eviction`, error)
    }
  }
}

/**
 * Evicts EVERY pooled device, as one awaited group.
 *
 * The key snapshot is taken synchronously and each eviction claims its own map
 * entries in the same turn, so no entry can be missed and the maps are empty by
 * the time the first `await` yields — there is deliberately no `clear()` here.
 * That matters for both bulk callers:
 *
 *  - the re-apply path (a reload with a different data dir) drops the previous
 *    archive's pool, and
 *  - the `ctx.effect` teardown releases it on plugin disable/unload.
 *
 * Both used to fire-and-forget the evictions and then `clear()` the maps, which
 * raced each eviction's subscription phase: `dispose()` never ran and parked
 * `cherry_wait` waiters were left to hang out their full timeout.
 *
 * A failure on one device never blocks the rest — each eviction already isolates
 * its own errors.
 */
async function evictAllConnections(): Promise<void> {
  const deviceIds = [...state.connections.keys()]
  for (const deviceId of [...state.subscriptions.keys()]) {
    if (!deviceIds.includes(deviceId)) deviceIds.push(deviceId)
  }
  await Promise.all(deviceIds.map((deviceId) => evictConnection(deviceId)))
}

// ---------------------------------------------------------------------------
// The subscription pool and its recovery line
// ---------------------------------------------------------------------------

/**
 * The subs factory (ruling 5): the device's subscription layer, created on
 * first use.
 *
 * `subscriptionsLimit` comes from THAT connection's hello-effective limits —
 * never a constant, because the peer's advertised cap is what the local LRU has
 * to stay inside (local eviction must happen BEFORE the peer can answer
 * RESOURCE_EXHAUSTED). Every caller reaches this only once its device is
 * `connected` (the tools refuse a non-connected device, and notifications only
 * arrive on a live link), which is exactly when the hello limits are real. The
 * constructor's own fallback covers the one exception: a `connected` event
 * whose recovery line finds no pool yet, where nothing can be subscribed anyway.
 */
function subsFor(deviceId: string): SessionSubscriptions {
  const existing = state.subscriptions.get(deviceId)
  if (existing !== undefined) return existing

  const connection = connectionFor(deviceId)
  const created = new SessionSubscriptions(connection.rpc, {
    subscriptionsLimit: connection.limits.subscriptions,
    perSessionCacheBytes: state.perSessionCacheBytes,
  })
  state.subscriptions.set(deviceId, created)
  return created
}

/**
 * The reconnect recovery line (ruling 8): every session this device had
 * subscribed is re-ensured at its LAST cursor, so the peer replays only what
 * this harness has not yet consumed.
 *
 * A failure is per-session and never aborts the rest: one session the peer
 * refuses to replay must not cost the others their subscription. Nothing is
 * escalated to the caller because there is no caller — the state transition
 * that triggered this has already been published.
 */
async function recoverSubscriptions(deviceId: string): Promise<void> {
  // Resolve an EXISTING layer only: a device with no subscriptions has nothing
  // to recover, and creating one here would fabricate state for a device that
  // never asked to subscribe.
  const subscriptions = state.subscriptions.get(deviceId)
  if (subscriptions === undefined) return

  for (const sessionId of subscriptions.activeSessions()) {
    // The READ is inside the isolation too: it consults the layer's own state,
    // so a layer that throws here (a disposed or half-rebuilt one) must cost
    // only THIS session, not every session after it in the loop.
    try {
      const result = subscriptions.read(sessionId)
      const cursor = 'events' in result ? result.nextCursor : undefined
      await subscriptions.ensure(sessionId, cursor)
    } catch (error) {
      console.warn(`[cherry-remote] re-subscribing session ${sessionId} of ${deviceId} failed`, error)
    }
  }
}

// ---------------------------------------------------------------------------
// Assembly dependencies (the shape both faces receive)
// ---------------------------------------------------------------------------

/** One dep object, shared by both faces, so there is exactly ONE pool. */
function assemblyDeps(): CherryHttpDeps & CherryToolsDeps {
  return {
    store: state.store,
    pair: async (request) => {
      const record = await pairWithPayload({
        identity: requireIdentity(),
        payload: request.payload,
        store: state.store,
        ...(request.name === undefined ? {} : { name: request.name }),
        onVerificationCode: request.onVerificationCode,
        // Pair bridging (ruling 10): the call site's stages reach the assembly's
        // progress fan-out, which is what the SSE route consumes.
        onStatus: (stage) => publishPairingProgress({ stage }),
      })
      // NEVER RESURRECT A TERMINAL CONNECTION (ruling 3): a re-pair replaces the
      // record for the same deviceId, so any pooled instance still holds the OLD
      // address/token and may be sitting in a terminal state whose retry loop has
      // stopped. Evict it, so the next `connect()` dials the NEW record.
      await evictConnection(record.deviceId)
      return record
    },
    // Lazy: `apply` cannot await the identity load, and pairing is the only
    // consumer, so the key is read when a payload is actually submitted.
    identity: requireIdentity,
    connect: connectionFor,
    // Resolve an EXISTING pooled connection without fabricating one. Used by
    // DELETE (never resurrect the record being removed) and by the disable
    // branch (a disabled device must not have a connection built for it).
    detach: (deviceId) => state.connections.get(deviceId),
    // Drop a pooled entry so the next `connect()` reconstructs from the CURRENT
    // store record (see evictConnection for the four flows that need it).
    evict: evictConnection,
    subs: subsFor,
    // Both channels return a DETACHER: the listener sets live on this assembly,
    // not on the SSE hub that subscribes to them, so a hub cannot remove its
    // callbacks unless the seam hands it the means to. Without this, every
    // re-apply left one dead hub's pair behind (see `SseHub.start`/`dispose`).
    onDeviceState: (cb) => {
      state.deviceStateListeners.add(cb)
      return () => {
        state.deviceStateListeners.delete(cb)
      }
    },
    onPairingProgress: (cb) => {
      state.pairingProgressListeners.add(cb)
      return () => {
        state.pairingProgressListeners.delete(cb)
      }
    },
    // Diagnostics (Task 13): the SAME pool the tool face reads, projected onto
    // counters and identifiers only. Every source here is synchronous and
    // non-throwing by construction; the HTTP face still guards each one.
    diagnosticsStats: () => ({
      connections: state.connections.size,
      sockets: [...state.connections.values()].filter((connection) => connection.state === 'connected').length,
      // Published under the name of what it MEASURES: connections the pool has
      // built. Never relabel it `requests` — that number is the transport's.
      connectionsBuilt: state.connectionsBuilt,
      subscriptions: [...state.subscriptions.values()].reduce(
        (total, layer) => total + layer.activeSessions().length,
        0,
      ),
    }),
    diagnosticsSessions: () =>
      [...state.subscriptions.entries()].flatMap(([deviceId, layer]) =>
        layer.activeSessions().map((sessionId) => ({ deviceId, sessionId, subscriptions: 1 })),
      ),
    diagnosticsErrors: () => [...state.recentErrors],
    diagnosticsConfig: () => ({
      rateBudgetPerSecond: state.rateBudgetPerSecond,
      perSessionCacheBytes: state.perSessionCacheBytes,
    }),
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx: CherryBridgeContext, config: CherryBridgeConfig = {}): void {
  const dataDir = resolveDataDir(config)
  const bridgeConfig = resolveBridgeConfig(config)
  state.rateBudgetPerSecond = bridgeConfig.rateBudgetPerSecond
  state.perSessionCacheBytes = bridgeConfig.perSessionCacheBytes
  state.store = new DeviceStore(join(dataDir, 'devices.json'))

  // A re-apply is a fresh assembly: the previous run's error summaries and
  // connection count describe a pool that no longer exists, so reporting them
  // would attribute an old failure (or an old socket count) to the new
  // deployment. Stats must only ever describe the CURRENT apply.
  state.recentErrors.length = 0
  state.connectionsBuilt = 0

  // IDEMPOTENCE (brief ③): a second apply — a reload — must REBIND, not stack.
  // Releasing the previous apply's registrations first is what keeps the host
  // registry holding exactly one definition per tool name; without it every
  // `cherry_*` call would be ambiguous between two definitions.
  for (const dispose of state.disposers.splice(0)) {
    try {
      dispose()
    } catch (error) {
      console.warn('[cherry-remote] releasing the previous assembly failed', error)
    }
  }

  // Re-apply (a reload with a different data dir) must not adopt connections
  // bound to the previous archive: drop them so the pool is rebuilt against the
  // records that actually exist now.
  //
  // The evictions run as ONE awaited group rather than fire-and-forget followed
  // by a `clear()`. `evictConnection` claims both map entries synchronously, so
  // draining the keys first and awaiting the group is what guarantees
  // `SessionSubscriptions.dispose()` actually runs on this path — a bare
  // `clear()` used to race it and leave parked `cherry_wait` waiters hanging.
  void evictAllConnections()

  const deps = assemblyDeps()
  // `registerHttpApi` owns the headless degradation (warn + skip) and the route
  // disposer; `registerCherryTools` owns the same for the tool registry.
  state.disposers.push(registerHttpApi(ctx, deps))
  state.disposers.push(registerCherryTools(ctx, deps))

  // `ctx.effect` ties the teardown to plugin disable/unload. The disposer
  // RETURNS the teardown promise: a host that awaits it (or a test) can order
  // against the sockets actually being down and the waiters actually rejected,
  // instead of racing a microtask.
  ctx.effect?.(() => () => {
    for (const dispose of state.disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        console.warn('[cherry-remote] releasing the assembly failed', error)
      }
    }
    state.deviceStateListeners.clear()
    state.pairingProgressListeners.clear()
    return evictAllConnections()
  })

  void loadOrCreateIdentity(dataDir).then(
    (identity) => {
      state.identity = identity.key
    },
    (error: unknown) => {
      console.error('[cherry-remote] failed to load the device identity', error)
      noteError({
        at: new Date().toISOString(),
        reason: 'IDENTITY_LOAD_FAILED',
        message: error instanceof Error ? error.message : String(error),
      })
    },
  )
}
