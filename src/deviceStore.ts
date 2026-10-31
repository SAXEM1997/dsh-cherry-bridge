import {
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { DirectEndpoint } from '@cherrystudio/remote-protocol'

/**
 * Crash-durable, corruption-safe archive of paired Cherry Studio desktop
 * devices.
 *
 * Durability: the archive is one 0600 JSON file, and EVERY write is atomic —
 * serialized into `<file>.tmp`, fsynced while still open, chmod'd, then
 * `renameSync`d over the target. No code path truncates the target in place,
 * so a crash, a full disk, or a kill at any instant leaves either the complete
 * old archive or the complete new one.
 *
 * Safety: an archive that exists but cannot be READ is never silently treated
 * as an empty one — that would let the next write destroy every pairing and
 * stored token it held. It is copied to `<file>.corrupt`, served as an empty
 * read-only view, and the store refuses further writes with
 * {@link QuarantinedArchiveError} until an operator moves the bad file aside.
 * Only ENOENT (first run, or an archive deleted underneath the plugin) degrades
 * to a writable empty archive.
 */

/**
 * A paired Cherry Studio desktop device, as stored in the device archive.
 *
 * `schemaVersion` is part of the public contract, so it is required here even
 * though v1 archives on disk do not carry the key: the read path parses into
 * {@link DeviceRecordOnDisk} first, judges the version, migrates, and only then
 * asserts this type. This required type is the read path's exit, never its
 * entry — casting raw disk content straight to `DeviceRecord` would skip the
 * version judgement and is forbidden.
 */
export interface DeviceRecord {
  schemaVersion: number
  deviceId: string
  displayName: string
  /**
   * Ordered dial candidates. `security` and `ports` are keyed by these same
   * hosts — one scheme and one port per candidate, exactly the shape the
   * pairing dial already carries (`PairCandidate`), so a candidate and its
   * address are added and replaced as one unit.
   */
  hosts: string[]
  /**
   * The record-level dial port: the WINNER candidate's port at pairing, the
   * operator's after a PATCH, and always the dial's fallback. A stored v4
   * record carries an explicit `ports` entry for every host; this value is only
   * the fallback for an in-memory record assembled before validation. Before
   * schemaVersion 4 it was the only port — see `ports`.
   */
  port: number
  /**
   * Dial scheme per host (issue #126). Every entry of `hosts` has exactly one
   * key here; `wss` is a TLS-proxied desktop. Introduced with schemaVersion 3:
   * a v2 archive had `hosts` + `port` only, and the migration backfills `ws`.
   */
  security: Record<string, 'ws' | 'wss'>
  /**
   * Dial port per host (issue #135). Every entry of `hosts` has exactly one
   * key here, and the value is the port that host was paired on. Introduced
   * with schemaVersion 4: before it, one `port` was shared by every host (the
   * winner candidate's), so a steady-state reconnect to a non-winner host
   * dialed the right scheme at the WRONG port. The v3→v4 migration backfills
   * `ports` from `port`; `port` itself stays the record-level fallback.
   */
  ports: Record<string, number>
  desktopIdentity: string
  grants: 'agent'[]
  /** Paired with `tokenExpiresAt`: present together or absent together. */
  accessToken?: string
  /** Paired with `accessToken`: present together or absent together. */
  tokenExpiresAt?: number
  enabled: boolean
}

/**
 * A selector that matched SEVERAL devices: the candidate display names, in
 * archive order, and nothing chosen for the caller.
 */
export interface AmbiguousDevice {
  ambiguous: string[]
}

/**
 * A `resolve` MISS: nothing matched, which is not the same answer as
 * ambiguity. A miss means the selector names no paired device at all, so there
 * is no candidate to offer — reporting it as ambiguity with no candidates
 * would tell the caller to choose from a list that does not exist.
 */
export interface UnresolvedDevice {
  notFound: true
}

export type DeviceResolution = DeviceRecord | AmbiguousDevice | UnresolvedDevice

/** The only `schemaVersion` this build reads and writes. */
export const CURRENT_SCHEMA_VERSION = 4

/**
 * The most candidate hosts one record may carry (issue #143).
 *
 * `hosts` is a DIAL list, not a table: every reconnect walks it with one
 * `connectTimeoutMs` per address, so its LENGTH is a time cost — a 32-host
 * record already allows a 320 s pass, which is the number the pairing walk's
 * aggregate budget exists for. Pairing can only ever produce 32
 * (`pairingQrSchema`'s `.max(32)`), and learning is held to the same bound: an
 * enrichment may not build a record that no pairing could have produced.
 */
export const MAX_CANDIDATE_HOSTS = 32

/**
 * Adds the candidate addresses a peer ADVERTISED that this record does not
 * already dial, returning how many hosts were added (issue #143).
 *
 * The rule is ADD-ONLY, deliberately:
 *
 *  - a host already in `hosts` is left exactly as it is, INCLUDING its port and
 *    its scheme. The peer's snapshot describes where it listens NOW, while a
 *    record entry may be an operator's choice (a pinned port, a TLS proxy) that
 *    every reconnect must keep honouring; re-pointing it would silently rewrite
 *    the operator's address book on a schedule. "Already dials" is judged
 *    CASE-INSENSITIVELY: a hostname is case-insensitive, the peer's schema
 *    lowercases what it advertises, and a PATCHed record stores what the
 *    operator typed — without this, `MyNAS.example` and `mynas.example` would
 *    both hold a dial slot. (An IPv6 literal in a different EXPANSION is NOT
 *    reconciled here; the PATCH path owns the archive's spelling, and it does
 *    not canonicalize either.)
 *  - nothing is ever removed, and nothing is remembered as removed: a host the
 *    peer still advertises is re-learned after an operator PATCH drops it. The
 *    peer is the source of truth for where it listens, so this is the intended
 *    reading of "add-only" — to make a removal stick, stop the desktop
 *    advertising the address (or disable the device);
 *  - host, port and scheme are appended TOGETHER, which is what keeps the v4
 *    one-entry-per-host invariant true. That invariant is enforced on the READ
 *    path by `assertValidSecurity`/`assertValidPorts`, and a semantic failure
 *    there is NOT a quarantine (that class covers unreadable bytes): the throw
 *    escapes `parseArchive` out of `list()`, so a split entry would break every
 *    tool until an operator repaired the file;
 *  - past {@link MAX_CANDIDATE_HOSTS} nothing is added, and the loop stops
 *    rather than scanning the rest.
 *
 * `endpoints` must already have passed the peer's own `advertisedEndpointSchema`
 * (which bounds the port to 1..65535, the scheme to `ws`/`wss`, and rejects a
 * loopback destination), so every value written here is archive-valid without a
 * second validation pass.
 */
export function mergeAdvertisedEndpoints(
  record: DeviceRecord,
  endpoints: readonly DirectEndpoint[],
): number {
  // One comparison rule, applied to what the record already dials AND to what
  // this answer has added so far: a duplicate inside one answer must not take a
  // second slot either.
  const dialed = new Set(record.hosts.map((host) => host.toLowerCase()))
  let added = 0
  for (const endpoint of endpoints) {
    const key = endpoint.host.toLowerCase()
    if (dialed.has(key)) continue
    if (record.hosts.length >= MAX_CANDIDATE_HOSTS) break
    record.hosts.push(endpoint.host)
    record.ports[endpoint.host] = endpoint.port
    record.security[endpoint.host] = endpoint.security
    dialed.add(key)
    added += 1
  }
  return added
}

const FILE_MODE = 0o600

/**
 * Loose view of one archive entry. Deliberately module-internal and never
 * exported: it is the read path's entry type, and must not escape the store.
 */
type DeviceRecordOnDisk = Partial<DeviceRecord> & { schemaVersion?: number }

/**
 * A parsed, migrated archive: the read path's exit type. The loose on-disk type
 * is fully resolved by the time an `ArchiveFile` exists.
 */
interface ArchiveFile {
  schemaVersion: number
  devices: DeviceRecord[]
}

/** One explicit migration step; the table's keys are the source versions. */
type Migration = (record: DeviceRecordOnDisk) => DeviceRecordOnDisk

/**
 * Version-to-version migrations, keyed by the version they upgrade from.
 *
 * `{ 1 -> 2 }` is a mechanism sample only, mirroring the plan's convention that
 * real schema evolution starts at version 2 after release. A v1 archive is the
 * current field set minus `schemaVersion`.
 *
 * `{ 2 -> 3 }` (issue #126) adds the per-host `security` map. v2 had `hosts` +
 * one `port` and no scheme at all, so every host is backfilled `ws` — the
 * plain dial v2 always used. An archive that already carries SOME entries
 * (a half-migrated file, or one a newer build wrote) keeps them: a scheme the
 * record remembers is never overwritten by the default, because that would
 * downgrade a TLS-proxied desktop to a dial that cannot connect.
 *
 * `{ 3 -> 4 }` (issue #135) adds the per-host `ports` map. v3 had `hosts` + one
 * shared `port` (the winner candidate's), so the step backfills `ports` from
 * `port` for every host — the only one v3 ever dialed. A half-migrated file
 * keeps the entries it already carries, for the same reason the scheme step
 * does: a remembered port is the address the pairing actually used, and
 * overwriting it would point the host at the winner's port again.
 *
 * **A legacy file is read loosely, this build's own output strictly —
 * deliberately.** Each step fills its map for the CURRENT host list and
 * nothing else: an entry naming a host the older file no longer lists is
 * silently DROPPED (it was unreachable anyway), a non-object `security`/`ports`
 * degrades to "every host on `ws`"/"every host at `port`", and a junk scheme or
 * port VALUE is not repaired here at all — the migrated entry then continues
 * down the chain and `assertValidSecurity`/`assertValidPorts` reject the whole
 * archive. That split is the point: a v2 or v3 file is a supported legacy shape
 * and is normalised into one, while a v4 file is this build's own output and
 * any deviation from it is a hand edit worth failing loudly on.
 */
const MIGRATIONS: Record<number, Migration> = {
  1: (record) => ({ ...record, schemaVersion: 2 }),
  2: (record) => ({ ...record, schemaVersion: 3, security: backfilledSecurity(record) }),
  3: (record) => ({ ...record, schemaVersion: 4, ports: backfilledPorts(record) }),
}

/** Every host of a v2 record, defaulting anything it did not already say. */
function backfilledSecurity(
  disk: Partial<DeviceRecord>,
): Record<string, 'ws' | 'wss'> {
  // A hand-edited file can carry a non-array `hosts`; read it as empty here and
  // let `assertValidRecord` name the real rule, instead of throwing a TypeError
  // out of `.map` first.
  const hosts = Array.isArray(disk.hosts) ? disk.hosts : []
  const existing = disk.security ?? {}
  // `Object.hasOwn`, never `existing[host] ?? …`: on an empty map a host named
  // `constructor`/`__proto__`/`toString` would otherwise pick up an INHERITED
  // function and poison the map. A remembered own entry wins even when its
  // value is null — a junk value is the validator's to reject, not to repair.
  return Object.fromEntries(
    hosts.map((host) => [host, Object.hasOwn(existing, host) ? existing[host] : 'ws']),
  )
}

/** Every host of a v3 record, defaulting anything it did not already say. */
function backfilledPorts(disk: Partial<DeviceRecord>): Record<string, number> {
  // Same two rules as `backfilledSecurity`: non-array hosts read as empty, and
  // only an OWN entry is remembered (an inherited function is not a port).
  const hosts = Array.isArray(disk.hosts) ? disk.hosts : []
  const existing = disk.ports ?? {}
  // The cast states this function's EXIT shape, not a guarantee about the
  // input: a malformed entry may omit `port`, and the `undefined` that would
  // produce is rejected by `assertValidPorts` right after the migration chain.
  const fallback = disk.port as number
  return Object.fromEntries(
    hosts.map((host): [string, number] => [
      host,
      Object.hasOwn(existing, host) ? existing[host] : fallback,
    ]),
  )
}

/**
 * The field set of a v1 entry: what the store wrote before it carried a
 * version at all.
 *
 * FROZEN. It must not track the current record — a v1 archive predates every
 * later field, so demanding one here (as `'security'` was, briefly) fails the
 * completeness gate on an archive that is perfectly intact and quarantines it
 * instead of migrating it. Later fields are the migration chain's business
 * (`backfilledSecurity`/`backfilledPorts` supply `security`/`ports`).
 */
const V1_KEYS = [
  'deviceId',
  'displayName',
  'hosts',
  'port',
  'desktopIdentity',
  'grants',
  'enabled',
] as const satisfies readonly (keyof DeviceRecord)[]

/**
 * Every field of the CURRENT set plus `schemaVersion`. Unlike {@link V1_KEYS}
 * this is not a historical snapshot: it grows with the record, and it is what
 * `upsert` and the post-migration exit demand (which is why a v4 entry without
 * `security`/`ports` never reaches its own validator).
 */
const REQUIRED_KEYS = [
  ...V1_KEYS,
  'security',
  'ports',
  'schemaVersion',
] as const satisfies readonly (keyof DeviceRecord)[]

/**
 * A version-less entry reads as the legacy (v1) shape only when every v1 field
 * is present. A missing `schemaVersion` alone means v1; a missing
 * `schemaVersion` plus missing fields means corruption, and the entry must be
 * rejected rather than migrated.
 */
function hasCompleteFieldSet(disk: DeviceRecordOnDisk): boolean {
  return V1_KEYS.every((key) => disk[key] !== undefined)
}

/** Asserts the required `DeviceRecord` shape. The read path's exit. */
function assertValidRecord(disk: DeviceRecordOnDisk): DeviceRecord {
  if (disk.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `device archive entry has unsupported schemaVersion ${String(disk.schemaVersion)}; ` +
        `expected ${CURRENT_SCHEMA_VERSION}`,
    )
  }

  const missing = REQUIRED_KEYS.filter((key) => disk[key] === undefined)
  if (missing.length > 0) {
    throw new Error(`device archive entry is missing required field(s): ${missing.join(', ')}`)
  }
  if (!Array.isArray(disk.hosts)) {
    throw new Error('device archive entry field hosts must be an array')
  }
  // The record-level port is the fallback a hosts-only PATCH derives a NEW
  // host's entry from, so it is judged like any map value: a hand-edited v4
  // record with a valid `ports` map but a junk `port` would otherwise make that
  // PATCH 400 (naming a field absent from its body). The message names the
  // field, never the value. Before this it was the one unchecked record number.
  if (
    typeof disk.port !== 'number' ||
    !Number.isInteger(disk.port) ||
    disk.port < 1 ||
    disk.port > 65_535
  ) {
    throw new Error('device archive entry field port must be an integer in 1..65535')
  }
  assertValidSecurity(disk.hosts, disk.security)
  assertValidPorts(disk.hosts, disk.ports)

  // accessToken / tokenExpiresAt live and die together.
  const hasToken = disk.accessToken !== undefined
  const hasExpiry = disk.tokenExpiresAt !== undefined
  if (hasToken !== hasExpiry) {
    throw new Error(
      'device archive entry must carry accessToken and tokenExpiresAt together or not at all',
    )
  }

  return disk as DeviceRecord
}

/**
 * The `security` map must be EXACTLY one entry per host, each a known scheme.
 *
 * Keyed by host, so a record can carry an entry the dial will never consult
 * (a host it no longer lists) and a host the dial will fall back on silently.
 * Both are hand-edited-archive states, and both are rejected rather than
 * repaired in memory: the archive a human edits is the archive the store
 * judges, and a silent repair would hide the very mistake. The message names
 * the offending HOSTS (they are addresses an operator chose, not secrets).
 */
function assertValidSecurity(hosts: string[], security: unknown): void {
  // NOT reached with `undefined` through the store: `REQUIRED_KEYS` rejects a
  // missing `security` before this runs (a current-version archive is written
  // by this build, so an absent map there is breakage, not a legacy shape). The
  // arm exists for the OTHER entry point — `upsert`, which callers may reach
  // with an in-memory record assembled by hand — and for the length of time a
  // record exists between construction and its first validation.
  if (security === undefined) return
  if (security === null || typeof security !== 'object' || Array.isArray(security)) {
    throw new Error('device archive entry field security must be an object keyed by host')
  }
  const map = security as Record<string, unknown>
  const wanted = new Set(hosts)
  const unknownHost = Object.keys(map).find((host) => !wanted.has(host))
  if (unknownHost !== undefined) {
    throw new Error(
      `device archive entry field security names host "${unknownHost}", which is not in hosts`,
    )
  }
  for (const host of hosts) {
    const scheme = map[host]
    if (scheme !== 'ws' && scheme !== 'wss') {
      throw new Error(
        `device archive entry field security["${host}"] must be "ws" or "wss"`,
      )
    }
  }
}

/**
 * The `ports` map must be EXACTLY one entry per host, each an integer port.
 *
 * The same reasoning as {@link assertValidSecurity}: an entry for a host the
 * record no longer lists would never be consulted, and a missing one would
 * leave that host on the record-level (winner's) port — the exact failure the
 * map exists to prevent. Both are rejected rather than repaired. The
 * message names the offending HOST, never the value (a port is not a secret, but
 * echoing a junk value back from a hand-edited file adds nothing actionable).
 */
function assertValidPorts(hosts: string[], ports: unknown): void {
  // NOT reached with `undefined` through the store: `REQUIRED_KEYS` rejects a
  // missing `ports` before this runs. Same other-entry-point reason as
  // `assertValidSecurity`: `upsert` and construction-to-first-validation.
  if (ports === undefined) return
  if (ports === null || typeof ports !== 'object' || Array.isArray(ports)) {
    throw new Error('device archive entry field ports must be an object keyed by host')
  }
  const map = ports as Record<string, unknown>
  const wanted = new Set(hosts)
  const unknownHost = Object.keys(map).find((host) => !wanted.has(host))
  if (unknownHost !== undefined) {
    throw new Error(
      `device archive entry field ports names host "${unknownHost}", which is not in hosts`,
    )
  }
  for (const host of hosts) {
    const port = map[host]
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(
        `device archive entry field ports["${host}"] must be an integer in 1..65535`,
      )
    }
  }
}

/**
 * Read path, fixed order: loose parse -> completeness gate -> version judgement
 * -> migration -> assert the required `DeviceRecord` type.
 *
 * `archiveVersion` is the single migration authority: it decides the migration
 * chain for every entry, and an entry's own `schemaVersion` is inert — present
 * only as a cross-check against the archive, never to drive migration, version
 * rejection, or a version-less default of its own.
 *
 * A version-less entry is the legacy (v1) shape, valid only inside a
 * schemaVersion-1 archive; under any newer archive it is rejected.
 *
 * `archiveVersion` is always a version this build understands, because
 * {@link parseArchive} rejects unknown archive versions before reaching here.
 */
function parseRecord(raw: unknown, archiveVersion: number): DeviceRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('device archive entry must be a JSON object')
  }

  const disk = raw as DeviceRecordOnDisk
  const declared = disk.schemaVersion

  // A version-less entry only reads as the pre-versioning v1 shape, and only a
  // COMPLETE field set proves it really is one. This gate runs before any
  // migration, so an incomplete entry is rejected rather than migrated.
  if (declared === undefined && !hasCompleteFieldSet(disk)) {
    throw new Error(
      'device archive entry has no schemaVersion and an incomplete field set; ' +
        'only a complete field set may be read as a legacy (v1) entry',
    )
  }

  // A version-less entry is the legacy (v1) shape, and that shape is only valid
  // inside a schemaVersion-1 archive. The store's own writes never produce this
  // combination, so reaching it means the file was hand-edited or corrupted; it
  // is rejected rather than silently migrated up.
  if (declared === undefined && archiveVersion > 1) {
    throw new Error(
      'device archive entry has no schemaVersion but its archive is schemaVersion ' +
        `${archiveVersion}; legacy (v1) entries are only valid inside a schemaVersion-1 archive`,
    )
  }

  // An entry that does declare a version must agree with the archive that
  // contains it — a mismatch means the file was hand-edited or half-written.
  if (declared !== undefined && declared !== archiveVersion) {
    throw new Error(
      `device archive entry declares schemaVersion ${declared} but its archive is ` +
        `schemaVersion ${archiveVersion}; the archive version is authoritative`,
    )
  }

  let migrated = disk
  for (let step = archiveVersion; step < CURRENT_SCHEMA_VERSION; step += 1) {
    const migrate = MIGRATIONS[step]
    if (migrate === undefined) {
      throw new Error(`no migration registered from device archive schemaVersion ${step}`)
    }
    migrated = migrate(migrated)
  }

  return assertValidRecord(migrated)
}

function parseArchive(parsed: unknown): ArchiveFile {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('device archive must be a JSON object')
  }

  const archive = parsed as { schemaVersion?: unknown; devices?: unknown }
  if (typeof archive.schemaVersion !== 'number') {
    throw new Error('device archive is missing a numeric schemaVersion')
  }
  if (archive.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `device archive declares schemaVersion ${archive.schemaVersion}, newer than supported ` +
        `${CURRENT_SCHEMA_VERSION}; refusing to read it`,
    )
  }
  if (!Array.isArray(archive.devices)) {
    throw new Error('device archive is missing a devices array')
  }
  // Bound to a local so the narrowing survives into the mapping closure: this
  // is the single version every entry below is read under.
  const archiveVersion = archive.schemaVersion

  return {
    schemaVersion: archiveVersion,
    devices: archive.devices.map((record) => parseRecord(record, archiveVersion)),
  }
}

function serializeArchive(devices: DeviceRecord[]): string {
  return `${JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, devices }, null, 2)}\n`
}

/**
 * Reads the archive at `file`, degrading to "unreadable" at the FILE layer
 * only, and letting semantic rejections propagate.
 *
 * Graceful (empty archive + warning, never a throw):
 *  - a MISSING file (ENOENT) — first-run has no archive yet, and an archive
 *    deleted underneath the plugin must not take it down. This is the one
 *    read failure that leaves the store writable: there is nothing to lose.
 *
 * Quarantined (empty read-only view + warning, see {@link QuarantinedArchiveError}):
 *  - any OTHER read failure (EACCES/EBUSY/EIO/…), and
 *  - bytes that are not parsable JSON.
 *
 *  Both mean the same thing — bytes exist on disk that this build cannot read
 *  — so neither may be treated as "empty". Degrading a corrupt archive to an
 *  empty one and then overwriting it destroys every pairing and token in it,
 *  unrecoverably. Instead the bad file is COPIED to `<file>.corrupt` (best
 *  effort, the original is never moved or truncated), an empty read-only view
 *  is served, and the store is poisoned so {@link DeviceStore} refuses to
 *  write until an operator moves the bad file aside.
 *
 * Rejected (thrown to the caller), because a readable archive that declares
 * something this build cannot honour must never be silently discarded:
 *  - a version-less entry with an incomplete field set;
 *  - an unknown higher `schemaVersion`.
 */
function readArchive(file: string): ArchiveFile | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (isNotFound(error)) {
      // INFO, not a warning: a missing archive is the NORMAL first-run state
      // (and also what a deliberate delete looks like). Warning here would put
      // a line in every operator's log on every fresh install, for a condition
      // that is not actionable and not a fault — which is precisely how a log
      // teaches its reader to ignore warnings. The quarantine path below keeps
      // `warn`, because that one really does need a human.
      console.info(`device archive ${file} does not exist yet; starting from an empty archive`)
      return undefined
    }
    throw new QuarantinedArchiveError(file, error)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new QuarantinedArchiveError(file, error)
  }

  return parseArchive(parsed)
}

/** ENOENT is the only "there is nothing here yet" read failure. */
function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** A JSON error's message, for the operator-facing half of the throw. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The one recovery instruction for a quarantined archive, shared by every face
 * that reports it (the HTTP 503 body, the SSE `archive-quarantined` stage, and
 * `cherry_pair`'s structured result).
 *
 * It lives beside the error because the error is the only thing that knows the
 * condition, and three independently-worded copies of "move the file aside"
 * would drift into three different instructions the first time one is edited.
 */
export const QUARANTINE_RECOVERY =
  'the device archive cannot be read and the plugin will not overwrite it; move the bad file ' +
  'aside (then restart or re-apply the plugin) to resume device management'

/**
 * The structured write-refusal raised by an archive the store could not read.
 *
 * It is deliberately NOT a plain {@link Error}: the assembly and the HTTP API
 * distinguish "this device is unavailable" from "the archive must be repaired
 * by hand", and the latter is only safe to report if the operator is told
 * exactly which two files to look at. Nothing in this build ever deletes the
 * two paths named here.
 */
export class QuarantinedArchiveError extends Error {
  /** The archive that could not be read; still on disk, byte-for-byte. */
  readonly file: string
  /** The best-effort preservation copy, or `undefined` when the copy failed. */
  readonly corruptPath: string | undefined
  /** The underlying read/parse failure the quarantine was raised for. */
  readonly cause: unknown

  constructor(file: string, cause: unknown, corruptPath?: string) {
    super(
      `device archive ${file} is unreadable (${reasonOf(cause)}); it was preserved as ` +
        `${corruptPath ?? `${file}.corrupt`} and the store is now READ-ONLY — refusing to ` +
        'overwrite it, because that would destroy every pairing and stored token. Move the ' +
        'bad file aside to resume writing.',
    )
    this.name = 'QuarantinedArchiveError'
    this.file = file
    this.corruptPath = corruptPath
    this.cause = cause
    Object.setPrototypeOf(this, new.target.prototype)
  }

  /**
   * The same failure, describing the preservation copy that was actually made.
   * The read path can only name the path it WOULD copy to; the store re-raises
   * with the path it DID, so an operator is never sent to a file that does not
   * exist (the copy is best effort).
   */
  withCorruptPath(corruptPath: string | undefined): QuarantinedArchiveError {
    return new QuarantinedArchiveError(this.file, this.cause, corruptPath)
  }
}

/**
 * Preserves an unreadable archive as `<file>.corrupt` (best effort — a failed
 * copy must not mask the original problem) and returns the path it landed at.
 */
function quarantine(file: string): string | undefined {
  const target = `${file}.corrupt`
  try {
    copyFileSync(file, target)
    chmodSync(target, FILE_MODE)
    return target
  } catch (error) {
    console.warn(`device archive ${file} could not be preserved as ${target}:`, error)
    return undefined
  }
}

/**
 * Writes the archive atomically and flushes it to disk.
 *
 * The archive is serialized into `<file>.tmp`, fsynced, and only then renamed
 * over the target. `renameSync` is atomic within one filesystem, so an observer
 * (including the next process to start) sees either the whole old archive or
 * the whole new one — never the truncated middle. Truncating the target in
 * place is what turns a crash or a full disk into an unparsable archive, and
 * that is exactly the destruction chain the quarantine path exists to stop.
 *
 * `mode` only applies when a file is created, and `rename` carries the temp
 * file's own mode over to the target, so the temp file is chmod'd explicitly:
 * both halves of the swap are 0600, and a pre-existing looser archive is
 * re-tightened by the rename rather than left as it was.
 *
 * `fsync` follows the plan's write-path requirement: a crash must not be able
 * to acknowledge a pairing that never reached the disk. The rename itself is
 * what makes the *name* switch durable; the data was already flushed before it.
 *
 * File I/O is synchronous because the store's API is synchronous (per the
 * plan's Interfaces) — `list`/`resolve` consume the store directly.
 */
function persistArchive(file: string, devices: DeviceRecord[]): void {
  mkdirSync(dirname(file), { recursive: true })

  const temp = `${file}.tmp`
  const fd = openSync(temp, 'w', FILE_MODE)
  try {
    writeSync(fd, serializeArchive(devices), undefined, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(temp, FILE_MODE)

  try {
    renameSync(temp, file)
  } catch (error) {
    // Never leave a half-written temp file behind for the next quarantine to
    // trip over: the target is untouched, so dropping the temp is safe.
    try {
      unlinkSync(temp)
    } catch {
      // Best effort only — the rename failure below is the real error.
    }
    throw error
  }
}

/**
 * Versioned archive of paired devices, persisted as one 0600 JSON file.
 *
 * Crash durability: every write is atomic — serialized to `<file>.tmp`, fsynced,
 * then renamed over the target — so a crash at any point leaves either the old
 * archive or the new one, never a truncated one.
 *
 * Reads are lazy and synchronous: the archive is loaded on first use and
 * migrated to {@link CURRENT_SCHEMA_VERSION} — written back only when the
 * stored version actually trails the current one, so re-reading a
 * current-version archive is a pure no-op. Writes persist immediately.
 *
 * Corruption is quarantined, never overwritten: a missing archive is an empty
 * one (first run), but an archive that EXISTS and cannot be read or parsed is
 * preserved as `<file>.corrupt`, served as an empty read-only view, and every
 * subsequent write REFUSES with {@link QuarantinedArchiveError} until an
 * operator moves the bad file aside. An archive that reads but declares an
 * unsupported schema is rejected loudly instead (a throw from the read path).
 */
export class DeviceStore {
  readonly #file: string
  #devices: DeviceRecord[] | undefined
  /**
   * Set when the archive on disk was unreadable and had to be quarantined.
   * While set, {@link #persist} refuses to write — the whole point of the flag
   * is that the bytes on disk are the only remaining copy of the pairings.
   */
  #quarantine: QuarantinedArchiveError | undefined

  constructor(file: string) {
    this.#file = file
  }

  /**
   * Whether the archive has been found unreadable and quarantined.
   *
   * A READ-ONLY PROBE, and deliberately not a `list()`-shaped one. The whole
   * problem it solves is that a quarantined store's empty view is
   * INDISTINGUISHABLE from a genuinely empty one: `list()` returns `[]` either
   * way, so a caller that only looks at the returned array cannot tell "no
   * devices are paired" from "the device list is unknowable". Faces that would
   * otherwise answer with that empty view — every device tool, and the HTTP
   * reads — ask this instead and report the real condition.
   *
   * It consults `#load()` so a store that has never been read still answers
   * truthfully (reading is what DISCOVERS the corruption), and so a store whose
   * archive went bad mid-life is reported as it is NOW rather than as it was at
   * construction. `#load()` cannot throw for this reason: a corrupt archive is
   * quarantined into the empty view rather than propagated.
   */
  get quarantined(): boolean {
    this.#load()
    return this.#quarantine !== undefined
  }

  /**
   * The quarantine, when there is one: the file, the preservation copy, and the
   * underlying failure. `undefined` for a healthy store.
   *
   * Same read-only contract as {@link quarantined}, for the faces that need to
   * NAME the two files the operator has to look at rather than only report that
   * something is wrong.
   */
  quarantineInfo(): QuarantinedArchiveError | undefined {
    this.#load()
    return this.#quarantine
  }

  list(): DeviceRecord[] {
    return this.#load().map((record) => structuredClone(record))
  }

  /**
   * Resolves a selector to exactly one record, the ambiguous candidates, or a
   * miss.
   *
   * Order of precedence: an exact `deviceId` wins outright, then a prefix of
   * EITHER the `deviceId` or the display name — the one abbreviation every
   * tool documents ("exact deviceId, or a unique prefix of a deviceId or
   * display name"), so a truncated id resolves like a truncated name does.
   * Candidates keep archive order, so the same selector always answers the
   * same list.
   *
   * A miss is its own member ({@link UnresolvedDevice}): nothing matching is
   * not several things matching, and folding the two together made
   * `cherry_devices` answer `ambiguous-device` with `candidates: []` on a
   * machine with a single paired device.
   *
   * AN EMPTY SELECTOR IS A MISS (v0.1.3 review, P3-1). `''.startsWith('')` is
   * true, so the prefix branch used to match EVERY record: one paired device
   * resolved silently to it and several answered `ambiguous` — an answer about
   * a selector that names nothing. The guard sits AFTER the exact branch, not
   * before it, so a record whose own `deviceId` is the empty string still
   * resolves exactly; only the PREFIX branch refuses the empty selector.
   */
  resolve(device: string): DeviceResolution {
    const devices = this.list()

    const exact = devices.find((record) => record.deviceId === device)
    if (exact !== undefined) return exact

    // Every non-empty selector used to reach the prefix branch; only the empty
    // one is refused, because it prefixes everything.
    if (device === '') return { notFound: true }

    // One `filter` over the archive list yields the UNION of the two prefix
    // spaces, already deduplicated by `deviceId` (the filter visits each record
    // once) and already in store order.
    const matches = devices.filter(
      (record) => record.deviceId.startsWith(device) || record.displayName.startsWith(device),
    )
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) return { notFound: true }
    return { ambiguous: matches.map((record) => record.displayName) }
  }

  upsert(record: DeviceRecord): void {
    const insert = assertValidRecord(record)
    const devices = this.#load().filter((existing) => existing.deviceId !== insert.deviceId)
    devices.push(structuredClone(insert))
    this.#persist(devices)
  }

  remove(deviceId: string): void {
    const devices = this.#load().filter((record) => record.deviceId !== deviceId)
    this.#persist(devices)
  }

  /**
   * Merges freshly learned addresses into one record and writes ONLY when that
   * record gained a host (issue #143), returning the number added.
   *
   * It exists so the enrichment is an ARCHIVE operation rather than an
   * `upsert` the assembly assembles by hand, and so a merge that adds nothing
   * never rewrites (and fsyncs) the archive: `connection.endpoints` is asked on
   * every connect, and a stable desktop would otherwise pay a full atomic write
   * per reconnect. The merge runs on a CLONE and is committed as a new list,
   * mirroring `upsert`'s discipline — the store never adopts a caller's object
   * graph, and a write refused at {@link #persist}'s own gate cannot have
   * half-edited the record the archive still holds.
   *
   * `desktopIdentity` is the pin the answering connection belongs to: the
   * record must still name that desktop. A RE-PAIR under the same `deviceId`
   * (the desktop regenerated its identity) would otherwise take an address
   * learned from the previous pairing — a stale candidate whose every dial then
   * fails the Noise pin, permanently, because learning never removes.
   *
   * An unknown `deviceId` is a no-op — the record may have been removed (or
   * re-paired) between the RPC and this write.
   */
  learnEndpoints(deviceId: string, endpoints: readonly DirectEndpoint[], desktopIdentity: string): number {
    const devices = this.#load()
    const index = devices.findIndex((record) => record.deviceId === deviceId)
    if (index < 0) return 0
    if (devices[index]!.desktopIdentity !== desktopIdentity) return 0
    const merged = structuredClone(devices[index]!)
    const added = mergeAdvertisedEndpoints(merged, endpoints)
    if (added === 0) return 0
    const next = [...devices]
    next[index] = merged
    this.#persist(next)
    return added
  }

  #load(): DeviceRecord[] {
    if (this.#devices !== undefined) return this.#devices

    let archive: ArchiveFile | undefined
    try {
      archive = readArchive(this.#file)
    } catch (error) {
      if (!(error instanceof QuarantinedArchiveError)) throw error
      // Quarantine: preserve the bad bytes, then serve an empty READ-ONLY view.
      // `list`/`resolve` keep working (RF4's spirit — a corrupt archive never
      // takes the plugin down), but nothing may write over the evidence.
      this.#quarantine = error.withCorruptPath(quarantine(error.file))
      // LOCAL fs/parse cause, never peer text (issue #161 audit): the object
      // print keeps the cause's stack, which is the useful part here.
      console.warn(
        `device archive ${this.#file} is unreadable and was quarantined; serving an empty ` +
          `read-only archive and refusing all writes until the bad file is moved aside:`,
        error.cause,
      )
      archive = undefined
    }

    // `parseArchive` is the exit of the read path: every entry has already been
    // migrated and asserted, so the loose on-disk type never reaches here.
    const devices: DeviceRecord[] = archive === undefined ? [] : archive.devices
    this.#devices = devices

    // Lazy migration writes back only when the stored version trails the
    // current one; a current-version archive is left untouched (idempotent).
    if (archive !== undefined && archive.schemaVersion < CURRENT_SCHEMA_VERSION) {
      this.#persist(devices)
    }

    return devices
  }

  #persist(devices: DeviceRecord[]): void {
    // Checked BEFORE the memo is updated: a refused write must not leave the
    // in-memory view claiming bytes that were never persisted.
    if (this.#quarantine !== undefined) throw this.#quarantine
    this.#devices = devices
    persistArchive(this.#file, devices)
  }
}
