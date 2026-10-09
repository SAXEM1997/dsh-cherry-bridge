import { homedir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore } from './deviceStore'
import { loadOrCreateIdentity } from './identity'
import { DeviceConnection } from './connection'
import type { DeviceState } from './connection'
import { pairWithPayload } from './pairing'
import { registerHttpApi } from './httpApi'
import type { CherryHttpContext, ConnectionLike, DeviceStateEvent, PairingProgressEvent } from './httpApi'

export const name = 'cherry-remote'

export const inject = ['tools']

/**
 * Plugin assembly — MINIMAL for M2 (Task 10 completes it).
 *
 * M2 ships the pairing flow plus the same-origin HTTP face; the `cherry_*`
 * tool family arrives with M3. So this `apply` does exactly what the HTTP face
 * needs to exist and be observable, and nothing more:
 *
 *   - one data directory (identity key + device archive),
 *   - a minimal per-device connection map,
 *   - the two assembly channels (`onDeviceState` / `onPairingProgress`),
 *   - `registerHttpApi`, disposed with the plugin.
 *
 * Deliberately left for Task 10: config (rate budget, subscription limits),
 * `SessionSubscriptions`, notification routing, unpair, and the `cherry_*`
 * tools. The seams it extends are {@link state.connections} (the pool),
 * {@link state.deviceStateListeners} / {@link state.pairingProgressListeners}
 * (the fan-out the tools and HTTP face share), and {@link config}, which
 * already carries the overridable data dir.
 */

export interface CherryBridgeConfig {
  /**
   * Plugin data directory holding `identity.key` and `devices.json`, both
   * 0600. Omitted follows `$DSH_HOME`, then `~/.dsh`.
   */
  dataDir?: string
}

/** The context slice `apply` touches beyond the HTTP face's own services. */
export interface CherryBridgeContext extends CherryHttpContext {
  effect?(callback: () => () => void): unknown
}

/** The data directory convention every DSH plugin follows. */
export function resolveDataDir(config: CherryBridgeConfig = {}, env = process.env): string {
  if (config.dataDir !== undefined && config.dataDir !== '') return config.dataDir
  const home = env['DSH_HOME']
  if (home !== undefined && home !== '') return join(home, 'cherry-remote')
  return join(homedir(), '.dsh', 'cherry-remote')
}

interface AssemblyState {
  store: DeviceStore
  /** Resolved once the identity load settles; pairing reads it lazily. */
  identity: Uint8Array | undefined
  readonly connections: Map<string, DeviceConnection>
  readonly deviceStateListeners: Set<(event: DeviceStateEvent) => void>
  readonly pairingProgressListeners: Set<(event: PairingProgressEvent) => void>
}

const state: AssemblyState = {
  store: new DeviceStore(join(tmpdirFallback(), 'devices.json')),
  identity: undefined,
  connections: new Map(),
  deviceStateListeners: new Set(),
  pairingProgressListeners: new Set(),
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

/**
 * The minimal connection pool (Task 10 formalizes it): one lazily created
 * {@link DeviceConnection} per record, kept so a device's state survives
 * repeated HTTP reads. A connection exists for every known device; whether it
 * is currently dialing is the connection's own business.
 */
function connectionFor(deviceId: string): ConnectionLike {
  const existing = state.connections.get(deviceId)
  if (existing !== undefined) return existing

  const record = state.store.list().find((device) => device.deviceId === deviceId)
  if (record === undefined) throw new Error(`cherry-remote: no device ${deviceId}`)

  const connection = new DeviceConnection({ identity: requireIdentity(), record })
  connection.onState((deviceState: DeviceState) => publishDeviceState({ deviceId, state: deviceState }))
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
 * edited address or a re-enabled flag, since it captures its `DeviceRecord`
 * at construction and never re-reads it.
 */
function evictConnection(deviceId: string): void {
  const existing = state.connections.get(deviceId)
  if (existing === undefined) return
  state.connections.delete(deviceId)
  void Promise.resolve(existing.close()).catch((error: unknown) => {
    console.warn(`[cherry-remote] device ${deviceId} close failed during eviction`, error)
  })
}

export function apply(ctx: CherryBridgeContext, config: CherryBridgeConfig = {}): void {
  const dataDir = resolveDataDir(config)
  state.store = new DeviceStore(join(dataDir, 'devices.json'))

  // Re-apply (a reload with a different data dir) must not adopt connections
  // bound to the previous archive: drop them so the pool is rebuilt against the
  // records that actually exist now.
  for (const connection of state.connections.values()) void connection.close()
  state.connections.clear()

  // `registerHttpApi` owns the headless degradation (warn + skip) and the route
  // disposer; `ctx.effect` ties that disposer to plugin disable/unload.
  const disposeHttpApi = registerHttpApi(ctx, {
    store: state.store,
    pair: pairWithPayload,
    // Lazy: `apply` cannot await the identity load, and pairing is the only
    // consumer, so the key is read when a payload is actually submitted.
    identity: requireIdentity,
    connect: connectionFor,
    // Resolve an EXISTING pooled connection without fabricating one. Used by
    // DELETE (never resurrect the record being removed) and by the disable
    // branch (a disabled device must not have a connection built for it).
    detach: (deviceId) => state.connections.get(deviceId),
    // Drop a pooled entry so the next `connect()` reconstructs from the
    // CURRENT store record — the fix for stale construction-time captures:
    // PATCH address maintenance and disable→enable both need a fresh instance.
    evict: evictConnection,
    onDeviceState: (cb) => {
      state.deviceStateListeners.add(cb)
    },
    onPairingProgress: (cb) => {
      state.pairingProgressListeners.add(cb)
    },
  })

  ctx.effect?.(() => () => {
    disposeHttpApi()
    for (const connection of state.connections.values()) void connection.close()
    state.connections.clear()
    state.deviceStateListeners.clear()
    state.pairingProgressListeners.clear()
  })

  void loadOrCreateIdentity(dataDir).then(
    (identity) => {
      state.identity = identity.key
    },
    (error: unknown) => {
      console.error('[cherry-remote] failed to load the device identity', error)
    },
  )
}
