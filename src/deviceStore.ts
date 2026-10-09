import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

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

/** A `resolve` miss: every display name whose prefix matched is a candidate. */
export interface AmbiguousDevice {
  ambiguous: string[]
}

export type DeviceResolution = DeviceRecord | AmbiguousDevice

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
 * A loose entry counts as a complete v1 archive — and therefore safe to
 * migrate — only when every v1 field is present. An entry missing keys must be
 * rejected rather than migrated: a missing `schemaVersion` alone means v1, a
 * missing `schemaVersion` plus missing fields means corruption.
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
 * Read path, fixed order: loose parse -> version judgement -> migration ->
 * assert the required `DeviceRecord` type.
 */
function parseRecord(raw: unknown): DeviceRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('device archive entry must be a JSON object')
  }

  let disk = raw as DeviceRecordOnDisk
  const version = disk.schemaVersion ?? 1

  // An archive without a version number reads as v1, but only a complete field
  // set proves it really is one: an incomplete archive is rejected, not migrated.
  if (!(version in MIGRATIONS) && !hasCompleteFieldSet(disk)) {
    throw new Error(
      'device archive entry has no schemaVersion and an incomplete field set; ' +
        'only a complete field set may be read as v1',
    )
  }

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `device archive entry declares schemaVersion ${version}, newer than supported ` +
        `${CURRENT_SCHEMA_VERSION}; refusing to read it`,
    )
  }

  for (let step = version; step < CURRENT_SCHEMA_VERSION; step += 1) {
    const migrate = MIGRATIONS[step]
    if (migrate === undefined) {
      throw new Error(`no migration registered from device archive schemaVersion ${step}`)
    }
    disk = migrate(disk)
  }

  return assertValidRecord(disk)
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

  return {
    schemaVersion: archive.schemaVersion,
    devices: archive.devices.map((record) => parseRecord(record)),
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
 *  - a missing or unreadable file — first-run has no archive yet, and an
 *    archive deleted underneath the plugin must not take it down;
 *  - bytes that are not parsable JSON at all.
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
    console.warn(`device archive ${file} could not be read; starting from an empty archive:`, error)
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    console.warn(`device archive ${file} is not valid JSON; starting from an empty archive:`, error)
    return undefined
  }

  return parseArchive(parsed)
}

/**
 * Writes the archive and flushes it to disk.
 *
 * `mode` only applies when the file is created; overwriting an existing file
 * keeps its old permissions, so chmod explicitly afterwards (the same
 * discipline as the identity key). `fsync` follows the plan's write-path
 * requirement: a crash must not be able to acknowledge a pairing that never
 * reached the disk.
 *
 * File I/O is synchronous because the store's API is synchronous (per the
 * plan's Interfaces) — `list`/`resolve` consume the store directly.
 */
function persistArchive(file: string, devices: DeviceRecord[]): void {
  mkdirSync(dirname(file), { recursive: true })

  const fd = openSync(file, 'w', FILE_MODE)
  try {
    writeSync(fd, serializeArchive(devices), undefined, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  chmodSync(file, FILE_MODE)
}

/**
 * Versioned archive of paired devices, persisted as one 0600 JSON file.
 *
 * Reads are lazy and synchronous: the archive is loaded on first use and
 * migrated to {@link CURRENT_SCHEMA_VERSION} — written back only when the
 * stored version actually trails the current one, so re-reading a
 * current-version archive is a pure no-op. Writes persist immediately, and an
 * archive that cannot be read degrades to an empty one with a warning (while an
 * archive that reads but declares an unsupported schema is rejected loudly).
 */
export class DeviceStore {
  readonly #file: string
  #devices: DeviceRecord[] | undefined

  constructor(file: string) {
    this.#file = file
  }

  list(): DeviceRecord[] {
    return this.#load().map((record) => structuredClone(record))
  }

  resolve(device: string): DeviceResolution {
    const devices = this.list()

    const exact = devices.find((record) => record.deviceId === device)
    if (exact !== undefined) return exact

    const matches = devices.filter((record) => record.displayName.startsWith(device))
    if (matches.length === 1) return matches[0]!
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

    const archive = readArchive(this.#file)
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
    this.#devices = devices
    persistArchive(this.#file, devices)
  }
}
