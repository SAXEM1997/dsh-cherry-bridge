import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSubagentConfigDocument } from '../../src/subagentConfigStore.js'
import { resolveSubagentConfig } from '../../src/subagent.js'
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from '../../src/defaults.js'

/**
 * Issue #233 — the experiment's configuration document.
 *
 * The settings page needs a switch that survives a restart and cannot be
 * silently overwritten by a second open page, so the document is a file with a
 * monotonic `revision` (the same discipline `scope.json` uses) rather than a
 * field of the profile YAML the browser cannot write.
 *
 * Two things this file is careful about, because they are the failure modes:
 *
 *  - **The seed has no lock.** The profile cannot carry an `expectedRevision`,
 *    so a seed's own `revision` must not pose as one.
 *  - **A refused save writes NOTHING.** The revision check is worth having only
 *    if a mismatch leaves the file byte-identical — asserted by reading it.
 */
function fixture(seed?: unknown): {
  file: string
  logs: string[]
  document: ReturnType<typeof createSubagentConfigDocument>
  dispose(): void
} {
  const dir = mkdtempSync(join(tmpdir(), 'cherry-subagent-config-'))
  const file = join(dir, 'subagent.json')
  const logs: string[] = []
  return {
    file,
    logs,
    document: createSubagentConfigDocument({ file, seed, log: (message) => logs.push(message) }),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const ENABLED = { enabled: true, device: 'desk-1', agentId: 'agent-7', workspaceId: 'ws-1' }

describe('reading: the file wins over the seed', () => {
  it('①a with no file the profile value is the document, and it is the SEED', () => {
    const fixtureUnderTest = fixture(ENABLED)
    try {
      expect(fixtureUnderTest.document.read()).toEqual({
        document: ENABLED,
        revision: 0,
        source: 'config',
      })
    } finally {
      fixtureUnderTest.dispose()
    }
  })

  it('①b a seed’s own `revision` is not a baseline: the profile cannot lock anything', () => {
    // A profile value carrying `revision: 7` must not become the lock, or the
    // page's first save would be refused against a document that never existed.
    const fixtureUnderTest = fixture({ ...ENABLED, revision: 7 })
    try {
      expect(fixtureUnderTest.document.read()).toEqual({ document: { ...ENABLED, revision: 7 }, revision: 0, source: 'config' })
    } finally {
      fixtureUnderTest.dispose()
    }
  })

  it('② a saved document replaces the seed, and its own revision is the lock', () => {
    const fixtureUnderTest = fixture({ enabled: false })
    try {
      writeFileSync(fixtureUnderTest.file, JSON.stringify({ ...ENABLED, revision: 3 }))
      expect(fixtureUnderTest.document.read()).toEqual({
        document: { ...ENABLED, revision: 3 },
        revision: 3,
        source: 'file',
      })
    } finally {
      fixtureUnderTest.dispose()
    }
  })
})

describe('saving: a monotonic revision and an atomic 0600 write', () => {
  it('③a the first save writes revision 1, atomically, mode 0600', () => {
    const fixtureUnderTest = fixture(undefined)
    try {
      const result = fixtureUnderTest.document.save(ENABLED, 0)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.stored).toEqual({ document: { ...ENABLED, revision: 1 }, revision: 1, source: 'file' })
      // The stored bytes are the document, not a wrapper around it: the next
      // apply reads this file as the config itself.
      expect(JSON.parse(readFileSync(fixtureUnderTest.file, 'utf8'))).toEqual({ ...ENABLED, revision: 1 })
      expect(statSync(fixtureUnderTest.file).mode & 0o777).toBe(0o600)
    } finally {
      fixtureUnderTest.dispose()
    }
  })

  it('③b a stale baseline is refused with 409 and writes NOTHING', () => {
    const fixtureUnderTest = fixture(undefined)
    try {
      fixtureUnderTest.document.save(ENABLED, 0)
      const before = readFileSync(fixtureUnderTest.file)
      const refused = fixtureUnderTest.document.save({ enabled: false }, 0)
      expect(refused).toEqual({
        ok: false,
        status: 409,
        error: 'subagent-revision-conflict',
        message: expect.stringContaining('revision=1'),
      })
      expect(readFileSync(fixtureUnderTest.file).equals(before)).toBe(true)
      // And the document is still readable at the revision the refusal named.
      expect(fixtureUnderTest.document.read().revision).toBe(1)
    } finally {
      fixtureUnderTest.dispose()
    }
  })

  it('③c a missing or non-numeric baseline is 400, never a silent overwrite', () => {
    const fixtureUnderTest = fixture(undefined)
    try {
      for (const baseline of [undefined, '0', Number.NaN, null]) {
        expect(fixtureUnderTest.document.save(ENABLED, baseline)).toEqual({
          ok: false,
          status: 400,
          error: 'missing-expected-revision',
          message: expect.any(String),
        })
      }
      expect(existsSync(fixtureUnderTest.file)).toBe(false)
    } finally {
      fixtureUnderTest.dispose()
    }
  })

  it('③d the body’s own `revision` and `expectedRevision` are ignored — both are the protocol’s', () => {
    // The baseline is a lock token, not a config field: storing it would echo it
    // back on every later read, and `revision` is server-owned by definition.
    // Found by the ROUTE test (⑩b) rather than here, which is why this case now
    // pins both keys on the body.
    const fixtureUnderTest = fixture(undefined)
    try {
      const result = fixtureUnderTest.document.save({ ...ENABLED, revision: 99, expectedRevision: 5 }, 0)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.stored.document).toEqual({ ...ENABLED, revision: 1 })
      expect(fixtureUnderTest.document.read().revision).toBe(1)
    } finally {
      fixtureUnderTest.dispose()
    }
  })

  it('③e a non-object body is refused by the module’s own guard', () => {
    // The route's `readJsonBody` already refuses a non-object, so this arm is
    // the STORE's contract for a caller that is not the HTTP face. Covered here
    // because a guard nothing can reach is a guard that rots.
    const fixtureUnderTest = fixture(undefined)
    try {
      expect(fixtureUnderTest.document.save([ENABLED], 0)).toEqual({
        ok: false,
        status: 400,
        error: 'invalid-request',
        message: expect.any(String),
      })
    } finally {
      fixtureUnderTest.dispose()
    }
  })
})

describe('saving: a field the caller omits stays omitted (#251)', () => {
  it('③f a body with no `timeoutMs` stores no key, and the resolver supplies the default', () => {
    // The wire promise the settings page makes when the operator CLEARS the
    // timeout box: `JSON.stringify` drops the key, `save()` writes the body as
    // the document, so an absent key stays absent on disk — and
    // `resolveSubagentConfig` is then the only place a number can come back
    // from. Pinned end to end because ⑥a of `uiSubagentPanel` only proves the
    // key leaves the browser.
    const { document, dispose, file } = fixture()
    try {
      const saved = document.save(ENABLED, 0)
      expect(saved.ok).toBe(true)
      const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(stored, 'timeoutMs')).toBe(false)
      const resolution = resolveSubagentConfig(document.read().document)
      expect(resolution.kind).toBe('ready')
      if (resolution.kind !== 'ready') throw new Error('expected a ready resolution')
      expect(resolution.config.timeoutMs).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS)
    } finally {
      dispose()
    }
  })
})

describe('reading: a damaged file is reported, and stays fixable', () => {
  it('④a invalid JSON falls back to the seed, warns, and a save overwrites it', () => {
    const fixtureUnderTest = fixture({ enabled: false })
    try {
      writeFileSync(fixtureUnderTest.file, '{not json')
      expect(fixtureUnderTest.document.read()).toEqual({
        document: { enabled: false },
        revision: 0,
        source: 'config',
      })
      expect(fixtureUnderTest.logs.join('\n')).toContain('不是合法 JSON')
      // The lock restarts at 0, which is what makes the damage repairable from
      // the page: refusing writes would need a hand-edited 0600 file.
      expect(fixtureUnderTest.document.save(ENABLED, 0).ok).toBe(true)
      expect(JSON.parse(readFileSync(fixtureUnderTest.file, 'utf8'))).toEqual({ ...ENABLED, revision: 1 })
    } finally {
      fixtureUnderTest.dispose()
    }
  })

  it('④b a JSON array or scalar is the same damage, not a config', () => {
    const fixtureUnderTest = fixture(undefined)
    try {
      for (const text of ['[]', '"enabled"', 'null', '3']) {
        writeFileSync(fixtureUnderTest.file, text)
        expect(fixtureUnderTest.document.read()).toEqual({
          document: undefined,
          revision: 0,
          source: 'config',
        })
      }
      expect(fixtureUnderTest.logs.join('\n')).toContain('不是对象')
    } finally {
      fixtureUnderTest.dispose()
    }
  })
})
