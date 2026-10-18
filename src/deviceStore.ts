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
  hosts: string[]
  port: number
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
export const CURRENT_SCHEMA_VERSION = 2

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
 */
const MIGRATIONS: Record<number, Migration> = {
  1: (record) => ({ ...record, schemaVersion: 2 }),
}

/**
 * Every field of the *current* set except `schemaVersion` — v1 is defined as
 * the current field set minus the version key, so these are exactly the keys a
 * complete v1 archive must carry.
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

const REQUIRED_KEYS = [...V1_KEYS, 'schemaVersion'] as const satisfies readonly (keyof DeviceRecord)[]

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
   */
  resolve(device: string): DeviceResolution {
    const devices = this.list()

    const exact = devices.find((record) => record.deviceId === device)
    if (exact !== undefined) return exact

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
