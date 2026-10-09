import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `node:fs` is mocked so the fsync requirement is observable at all. Spying on
// the module's *default export* does not work: the ESM named bindings that
// `src/deviceStore.ts` imports keep pointing at the original functions even
// after `vi.spyOn(fsDefault, 'fsyncSync')`. Every mocked member delegates to the
// real implementation before recording, so the store still does real file I/O
// and the remaining tests exercise real temp files.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: actual,
    fsyncSync: vi.fn((fd: number) => actual.fsyncSync(fd)),
    closeSync: vi.fn((fd: number) => actual.closeSync(fd)),
    openSync: vi.fn((...args: Parameters<typeof actual.openSync>) => actual.openSync(...args)),
    renameSync: vi.fn((...args: Parameters<typeof actual.renameSync>) => actual.renameSync(...args)),
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) =>
      actual.readFileSync(...args),
    ),
  }
})

import * as fs from 'node:fs'
import { CURRENT_SCHEMA_VERSION, DeviceStore, type DeviceRecord } from '../../src/deviceStore'

const SCHEMA_VERSION = 2
const DEVICES_FILENAME = 'devices.json'

const tempDirs: string[] = []

beforeEach(() => {
  // The store legitimately warns on every unreadable archive — including the
  // first-run ENOENT that most tests trigger just by pointing at a fresh
  // directory. Silence it globally so the suite output stays pristine; the
  // tests that ASSERT on the warning re-spy inside themselves.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true })
})

async function makeStoreFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-device-store-'))
  tempDirs.push(dir)
  return join(dir, DEVICES_FILENAME)
}

function makeRecord(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: 'dev-alpha',
    displayName: 'Alpha Workstation',
    hosts: ['10.0.0.5', '10.0.0.6'],
    port: 8765,
    desktopIdentity: 'desktop-identity-alpha',
    grants: ['agent'],
    accessToken: 'token-alpha',
    tokenExpiresAt: 1_800_000_000_000,
    enabled: true,
    ...overrides,
  }
}

function permissions(mode: number): number {
  return mode & 0o777
}

/** Writes an archive fixture whose per-entry shape the test controls. */
async function writeArchive(
  file: string,
  entries: unknown[],
  schemaVersion: number = SCHEMA_VERSION,
): Promise<void> {
  await writeFile(file, JSON.stringify({ schemaVersion, devices: entries }), 'utf8')
}

async function readArchive(file: string): Promise<{ schemaVersion: number; devices: DeviceRecord[] }> {
  return JSON.parse(await readFile(file, 'utf8')) as {
    schemaVersion: number
    devices: DeviceRecord[]
  }
}

/** Raw text check, so a broken fs mock cannot hide whether the write landed. */
async function storeContains(file: string, record: DeviceRecord): Promise<boolean> {
  return (await readFile(file, 'utf8')).includes(`"${record.deviceId}"`)
}

describe('DeviceStore persistence', () => {
  it('persists upsert/remove round-trips in a 0600 JSON file (①)', async () => {
    const file = await makeStoreFile()
    const store = new DeviceStore(file)

    expect(store.list()).toEqual([])
    await expect(readFile(file, 'utf8')).rejects.toThrow()

    const alpha = makeRecord()
    const beta = makeRecord({
      deviceId: 'dev-beta',
      displayName: 'Beta Laptop',
      hosts: ['10.0.0.9'],
      port: 9000,
      desktopIdentity: 'desktop-identity-beta',
      accessToken: undefined,
      tokenExpiresAt: undefined,
      enabled: false,
    })

    store.upsert(alpha)
    store.upsert(beta)

    expect(store.list()).toEqual([alpha, beta])
    const { mode } = await stat(file)
    expect(permissions(mode)).toBe(0o600)
    expect((await readArchive(file)).devices).toEqual([alpha, beta])

    store.remove('dev-alpha')

    expect(store.list()).toEqual([beta])
    expect(await readArchive(file)).toEqual({ schemaVersion: SCHEMA_VERSION, devices: [beta] })

    // Reloading from disk (a fresh store) yields the same records.
    expect(new DeviceStore(file).list()).toEqual([beta])

    store.remove('dev-beta')
    expect(store.list()).toEqual([])
    expect(new DeviceStore(file).list()).toEqual([])
  })

  it('re-tightens permissions to 0600 when persisting over a looser pre-existing file', async () => {
    const file = await makeStoreFile()
    await writeFile(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, devices: [] }), {
      mode: 0o644,
    })
    await chmod(file, 0o644)
    expect(permissions((await stat(file)).mode)).toBe(0o644)

    new DeviceStore(file).upsert(makeRecord())

    expect(permissions((await stat(file)).mode)).toBe(0o600)
  })

  it('fsyncs the file before acknowledging a write (S1)', async () => {
    const file = await makeStoreFile()
    const store = new DeviceStore(file)
    store.upsert(makeRecord())

    // The archived descriptor was flushed...
    expect(fs.fsyncSync).toHaveBeenCalled()
    const fsyncedFds = new Set(
      (fs.fsyncSync as unknown as MockInstance).mock.calls.map(([fd]) => fd as number),
    )
    expect(fsyncedFds.size).toBeGreaterThan(0)

    // ...while it was still open, i.e. after the bytes were written and before
    // the close, and the archive really did land on disk.
    const closedFds = (fs.closeSync as unknown as MockInstance).mock.calls.map(
      ([fd]) => fd as number,
    )
    expect(closedFds.some((fd) => fsyncedFds.has(fd))).toBe(true)
    expect(await storeContains(file, makeRecord())).toBe(true)
  })

  it('flushes an older archive it migrates, but not one it merely reads (S1/④)', async () => {
    const file = await makeStoreFile()
    const { schemaVersion: _current, ...fields } = makeRecord()
    await writeArchive(file, [fields], 1)

    vi.mocked(fs.fsyncSync).mockClear()
    new DeviceStore(file).list()
    expect(fs.fsyncSync).toHaveBeenCalled()

    // A current-version archive is read without any write, hence no flush.
    vi.mocked(fs.fsyncSync).mockClear()
    new DeviceStore(file).list()
    expect(fs.fsyncSync).not.toHaveBeenCalled()
  })
})

describe('DeviceStore.resolve', () => {
  it('matches deviceId exactly first, then a unique display-name prefix, else candidates (②)', async () => {
    const store = new DeviceStore(await makeStoreFile())

    store.upsert(
      makeRecord({ deviceId: 'dev-alpha', displayName: 'Alpha Workstation' }),
    )
    store.upsert(makeRecord({ deviceId: 'dev-alp', displayName: 'Alpine Box' }))
    store.upsert(
      makeRecord({ deviceId: 'dev-gamma', displayName: 'Gamma Rig', enabled: false }),
    )

    // Exact deviceId wins, even when it is also a prefix of other names.
    expect(store.resolve('dev-alpha')).toEqual(
      expect.objectContaining({ deviceId: 'dev-alpha' }),
    )
    expect(store.resolve('dev-gamma')).toEqual(
      expect.objectContaining({ deviceId: 'dev-gamma', enabled: false }),
    )

    // Unique display-name prefix is effective.
    expect(store.resolve('Gamma')).toEqual(
      expect.objectContaining({ deviceId: 'dev-gamma' }),
    )
    expect(store.resolve('Beta')).toEqual({ ambiguous: [] })

    // Ambiguous prefix returns the candidate display names.
    expect(store.resolve('Alp')).toEqual({
      ambiguous: ['Alpha Workstation', 'Alpine Box'],
    })

    // Exact display-name match is itself unique.
    expect(store.resolve('Alpine Box')).toEqual(
      expect.objectContaining({ deviceId: 'dev-alp' }),
    )
  })
})

describe('DeviceStore schema migration', () => {
  it('lazily migrates a v1 archive (schemaVersion 1) to the current version without losing fields (③)', async () => {
    const file = await makeStoreFile()
    const { schemaVersion: _current, ...fields } = makeRecord()
    // v1 is defined as the current field set minus `schemaVersion`; this
    // fixture is a synthetic sample proving the migration mechanism only.
    await writeArchive(file, [{ schemaVersion: 1, ...fields }], 1)

    const store = new DeviceStore(file)

    expect(store.list()).toEqual([makeRecord()])
    expect(await readArchive(file)).toEqual({ schemaVersion: SCHEMA_VERSION, devices: [makeRecord()] })
  })

  it('treats a complete archive without schemaVersion as v1 (③)', async () => {
    const file = await makeStoreFile()
    const { schemaVersion: _current, ...fields } = makeRecord()
    await writeArchive(file, [fields], 1)

    const store = new DeviceStore(file)

    expect(store.list()).toEqual([makeRecord()])
    expect(await readArchive(file)).toEqual({ schemaVersion: SCHEMA_VERSION, devices: [makeRecord()] })
  })

  it('rejects an incomplete version-less entry before migrating it (③)', async () => {
    const file = await makeStoreFile()
    const { schemaVersion: _current, port: _port, grants: _grants, ...partial } = makeRecord()
    // No entry-level schemaVersion, and fields missing: rejected up front.
    await writeArchive(file, [partial], 1)
    const before = await readFile(file, 'utf8')

    // The guard fires — not the post-migration backstop. `不迁移` means the
    // rejection happens BEFORE any migration step runs.
    expect(() => new DeviceStore(file).list()).toThrow(/incomplete field set/)
    // Rejected, so nothing was migrated or written back.
    expect(await readFile(file, 'utf8')).toBe(before)
    expect((await readArchive(file)).schemaVersion).toBe(1)
  })

  it('rejects a version-less entry missing a single field before migrating it (③)', async () => {
    const file = await makeStoreFile()
    const { schemaVersion: _current, port: _port, ...partial } = makeRecord()
    await writeArchive(file, [partial], 1)
    const before = await readFile(file, 'utf8')

    expect(() => new DeviceStore(file).list()).toThrow(/incomplete field set/)
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('rejects a version-less entry missing fields even when the archive is current (③)', async () => {
    const file = await makeStoreFile()
    const { schemaVersion: _current, port: _port, ...partial } = makeRecord()
    // The entry's own completeness is judged regardless of the archive version.
    await writeArchive(file, [partial], SCHEMA_VERSION)
    const before = await readFile(file, 'utf8')

    expect(() => new DeviceStore(file).list()).toThrow(/incomplete field set/)
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('re-reads a current-version archive without re-migrating or altering it (④)', async () => {
    const file = await makeStoreFile()
    const store = new DeviceStore(file)
    store.upsert(makeRecord())
    const before = await readFile(file, 'utf8')

    const reread = new DeviceStore(file)
    expect(reread.list()).toEqual([makeRecord()])
    expect(reread.list()).toEqual([makeRecord()])
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readArchive(file)).toEqual({ schemaVersion: SCHEMA_VERSION, devices: [makeRecord()] })
  })

  it('rejects an archive with an unknown higher schemaVersion (⑤)', async () => {
    const file = await makeStoreFile()
    await writeArchive(file, [makeRecord({ schemaVersion: 99 })], 99)

    const store = new DeviceStore(file)

    expect(() => store.list()).toThrow(/99/)
    // No downgrade and no parse-as-current: the file is untouched.
    expect((await readArchive(file)).schemaVersion).toBe(99)
  })

  it('rejects an entry whose schemaVersion disagrees with its archive (F2)', async () => {
    const file = await makeStoreFile()
    // Archive is current; the entry claims 99 of its own.
    await writeArchive(file, [makeRecord({ schemaVersion: 99 })])

    const store = new DeviceStore(file)

    // Entry-level versions are inert: they never drive migration or rejection on
    // their own, they are only checked for consistency with the archive.
    expect(() => store.list()).toThrow(
      /entry declares schemaVersion 99 but its archive is schemaVersion 2/,
    )
  })

  it('rejects an entry that trails its own archive version (F2)', async () => {
    const file = await makeStoreFile()
    await writeArchive(file, [makeRecord({ schemaVersion: 1 })], SCHEMA_VERSION)

    expect(() => new DeviceStore(file).list()).toThrow(
      /entry declares schemaVersion 1 but its archive is schemaVersion 2/,
    )
  })

  it('rejects a version-less entry inside a current-version archive, accurately (F2-r2)', async () => {
    const file = await makeStoreFile()
    const { schemaVersion: _current, ...fields } = makeRecord()
    // The legacy (version-less) shape is only valid inside a v1 archive; the
    // store's own writes never produce this combination, so reaching it means
    // hand-editing or external corruption. Rejected, not silently migrated up.
    await writeArchive(file, [fields], SCHEMA_VERSION)
    const before = await readFile(file, 'utf8')

    // The message must name what actually went wrong: NOT
    // "unsupported schemaVersion undefined", which names a value the entry
    // never declared.
    expect(() => new DeviceStore(file).list()).toThrow(
      /entry has no schemaVersion but its archive is schemaVersion 2/,
    )
    // Rejected before the migration loop: the archive is left untouched.
    expect(await readFile(file, 'utf8')).toBe(before)
    expect((await readArchive(file)).schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('accepts a version-less entry that agrees with its archive version (F2)', async () => {
    const file = await makeStoreFile()
    await writeArchive(file, [makeRecord()], SCHEMA_VERSION)

    expect(new DeviceStore(file).list()).toEqual([makeRecord()])
  })

  it('covers the whole archive-version/entry-version matrix (F2-r2)', async () => {
    const { schemaVersion: _current, ...versionless } = makeRecord()
    const { port: _port, ...incomplete } = versionless

    const cases: {
      name: string
      archiveVersion: number
      entry: unknown
      expect: 'migrates' | 'throws'
      message?: RegExp
    }[] = [
      {
        name: 'archive 1 + version-less complete',
        archiveVersion: 1,
        entry: versionless,
        expect: 'migrates',
      },
      {
        name: 'archive 1 + version-less incomplete',
        archiveVersion: 1,
        entry: incomplete,
        expect: 'throws',
        message: /incomplete field set/,
      },
      {
        name: 'archive 2 + declared 2',
        archiveVersion: SCHEMA_VERSION,
        entry: makeRecord(),
        expect: 'migrates',
      },
      {
        name: 'archive 2 + declared other',
        archiveVersion: SCHEMA_VERSION,
        entry: makeRecord({ schemaVersion: 1 }),
        expect: 'throws',
        message: /entry declares schemaVersion 1 but its archive is schemaVersion 2/,
      },
      {
        name: 'archive 2 + version-less',
        archiveVersion: SCHEMA_VERSION,
        entry: versionless,
        expect: 'throws',
        message: /entry has no schemaVersion but its archive is schemaVersion 2/,
      },
      {
        name: 'archive 99',
        archiveVersion: 99,
        entry: makeRecord({ schemaVersion: 99 }),
        expect: 'throws',
        message: /archive declares schemaVersion 99/,
      },
    ]

    for (const testCase of cases) {
      const file = await makeStoreFile()
      await writeArchive(file, [testCase.entry], testCase.archiveVersion)
      const before = await readFile(file, 'utf8')
      const store = new DeviceStore(file)

      if (testCase.expect === 'migrates') {
        expect(store.list(), testCase.name).toEqual([makeRecord()])
      } else {
        expect(() => store.list(), testCase.name).toThrow(testCase.message)
        // Every rejection happens before any migration write-back.
        expect(await readFile(file, 'utf8'), testCase.name).toBe(before)
      }
    }
  })
})

describe('DeviceStore write validation', () => {
  it('requires accessToken and tokenExpiresAt together or not at all (⑤/同生同灭)', async () => {
    const file = await makeStoreFile()
    const store = new DeviceStore(file)

    expect(() =>
      store.upsert(makeRecord({ accessToken: 'token-only', tokenExpiresAt: undefined })),
    ).toThrow(/together/)
    expect(() =>
      store.upsert(makeRecord({ accessToken: undefined, tokenExpiresAt: 1_800_000_000_000 })),
    ).toThrow(/together/)
    // Rejecting the write leaves the archive untouched.
    await expect(readFile(file, 'utf8')).rejects.toThrow()

    store.upsert(makeRecord({ accessToken: undefined, tokenExpiresAt: undefined }))
    store.upsert(makeRecord())
    expect(store.list()).toEqual([makeRecord()])
  })

  it('rejects a record written with a foreign schemaVersion', async () => {
    const store = new DeviceStore(await makeStoreFile())

    expect(() => store.upsert(makeRecord({ schemaVersion: 1 }))).toThrow(/schemaVersion 1/)
  })

  it('enforces every required key at runtime, not just the token pair (addendum)', async () => {
    // `DeviceRecord`'s required keys are a compile-time contract only; a caller
    // reaching upsert from JS or through a cast can still omit one. Every
    // missing key is rejected before it can reach the archive, which is what
    // keeps the anomalous version-less-inside-v2 shape out of the store's own
    // writes (only hand-edited files can produce it).
    const requiredKeys = [
      'schemaVersion',
      'deviceId',
      'displayName',
      'hosts',
      'port',
      'desktopIdentity',
      'grants',
      'enabled',
    ] as const

    for (const key of requiredKeys) {
      const file = await makeStoreFile()
      const store = new DeviceStore(file)
      const incomplete = makeRecord() as unknown as Record<string, unknown>
      delete incomplete[key]

      expect(() => store.upsert(incomplete as unknown as DeviceRecord), key).toThrow(key)
      // Nothing was persisted: a rejected write never touches the archive.
      await expect(readFile(file, 'utf8'), key).rejects.toThrow()
    }
  })
})

describe('DeviceStore corruption handling', () => {
  it('(F1) an atomic persist never opens the target file for in-place truncation', async () => {
    const file = await makeStoreFile()
    const store = new DeviceStore(file)
    const open = vi.mocked(fs.openSync)

    store.upsert(makeRecord())

    // Structural: the archive is built beside the target and renamed over it,
    // so NO path may open the target itself with a truncating 'w'.
    const opensOnTarget = open.mock.calls.filter(
      ([path, flags]) => path === file && (flags === 'w' || flags === 'w+'),
    )
    expect(opensOnTarget).toEqual([])

    // The temp file is the one written, and it is gone once renamed.
    expect(open.mock.calls.some(([path]) => path === `${file}.tmp`)).toBe(true)
    await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow()
    expect(await storeContains(file, makeRecord())).toBe(true)
  })

  it('(F1) quarantines a torn archive: empty view, .corrupt copy, writes REFUSED', async () => {
    const file = await makeStoreFile()
    const torn = '{"schemaVersion": 2, "devices": [{"deviceId": "dev-alpha"'
    await writeFile(file, torn, 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = new DeviceStore(file)

    // RF4 spirit preserved: the read degrades, it never takes the plugin down.
    expect(store.list()).toEqual([])
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0]?.[0]).toContain(file)

    // The bad bytes were preserved verbatim before anything else happened.
    expect(await readFile(`${file}.corrupt`, 'utf8')).toBe(torn)
    // ...and the original is still there: quarantine COPIES, it never moves.
    expect(await readFile(file, 'utf8')).toBe(torn)

    // The poisoned store refuses to overwrite: losing every pairing silently
    // is the failure mode this guard exists to prevent.
    expect(() => store.upsert(makeRecord())).toThrow(/corrupt/i)
    expect(() =>
      store.upsert(makeRecord()),
    ).toThrow(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.corrupt`))
    expect(() => store.remove('dev-alpha')).toThrow(/corrupt/i)

    // Both the poisoned archive and the quarantine copy are untouched.
    expect(await readFile(file, 'utf8')).toBe(torn)
    expect(await readFile(`${file}.corrupt`, 'utf8')).toBe(torn)
  })

  it('(F1) keeps serving an empty read-only view after quarantine until the file is moved aside', async () => {
    const file = await makeStoreFile()
    const torn = 'not json at all'
    await writeFile(file, torn, 'utf8')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = new DeviceStore(file)
    expect(store.list()).toEqual([])

    // Address maintenance / manual repair: the operator moves the bad file
    // aside and restores a good archive. A NEW store reads it normally.
    await rm(file)
    await writeFile(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, devices: [makeRecord()] }), 'utf8')
    expect(new DeviceStore(file).list()).toEqual([makeRecord()])
  })

  it('(F1) ENOENT keeps the pinned first-run behaviour: empty, no quarantine, writes allowed', async () => {
    const file = await makeStoreFile()
    const store = new DeviceStore(file)

    // First run: no archive yet. An absent file is NOT corruption, so it must
    // not be quarantined...
    expect(store.list()).toEqual([])
    await expect(readFile(`${file}.corrupt`, 'utf8')).rejects.toThrow()

    // ...and it must not poison the store either: a first-run store writes.
    store.upsert(makeRecord())
    expect(store.list()).toEqual([makeRecord()])
    expect((await readArchive(file)).devices).toEqual([makeRecord()])
  })

  it('returns an empty store, does not throw, and warns when the file is corrupt (⑥ RF4)', async () => {
    const file = await makeStoreFile()
    await writeFile(file, '{ this is not json', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = new DeviceStore(file)

    expect(store.list()).toEqual([])
    expect(store.resolve('anything')).toEqual({ ambiguous: [] })
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0]?.[0]).toContain(file)
  })

  it('stays usable after a corrupt file is replaced by a good one (⑥ RF4)', async () => {
    const file = await makeStoreFile()
    await writeFile(file, 'not json at all', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = new DeviceStore(file)
    expect(store.list()).toEqual([])

    // The poisoned instance stays read-only even after the bad bytes are gone:
    // re-checking the disk on every write would race an operator's repair, and
    // a persisted flag is the only thing that cannot be fooled by a file that
    // reappears mid-write. Recovery is a RESTART, not a silent retry.
    await rm(file)
    expect(() => store.upsert(makeRecord())).toThrow(/READ-ONLY/)
    expect(store.list()).toEqual([])

    // A fresh store (the restart) reads the repaired path normally.
    const restarted = new DeviceStore(file)
    restarted.upsert(makeRecord())
    expect(restarted.list()).toEqual([makeRecord()])
    expect(await readArchive(file)).toEqual({
      schemaVersion: SCHEMA_VERSION,
      devices: [makeRecord()],
    })
    expect(warn).toHaveBeenCalled()
  })

  it('warns but does not throw when the archive disappeared (⑥ RF4)', async () => {
    const file = await makeStoreFile()
    // Spied BEFORE the first read: the first-run read is exactly the path under
    // test here, and letting its warning escape would leave stray stderr in the
    // suite output (the store genuinely warns on every unreadable archive).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    new DeviceStore(file).upsert(makeRecord())

    // Simulates the archive being deleted underneath a running plugin.
    await rm(file)

    const store = new DeviceStore(file)
    expect(store.list()).toEqual([])
    expect(store.resolve('dev-alpha')).toEqual({ ambiguous: [] })
    expect(warn).toHaveBeenCalled()
  })
})
