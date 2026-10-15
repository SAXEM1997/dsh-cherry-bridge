/**
 * Task 2 — the scope document: parse, strictness order, atomic write, the
 * `degraded` set and the write-side guard rails (§6.1 first half; B9/B14/B16
 * storage side).
 *
 * Every name imported here is consumed verbatim by a later task (…), so these
 * assertions are a contract, not a smoke test. Three behaviours are easy to get
 * subtly wrong and are therefore pinned as SEPARATE cases rather than folded
 * into one "save works" case:
 *
 *   1. `save()`'s rejection precedence — pre-existing state (an unsupported
 *      document version, an unavailable workspace list) outranks request-body
 *      validation, which outranks the revision checks;
 *   2. the two sides of the version branch — a type-legal but unsupported
 *      `version` is a READ-ONLY degradation (503 + `scope-version` note), while
 *      a type-INVALID `version` is the B9 parse path (warn + strictness order,
 *      still writable);
 *   3. the three states of the workspace list — 未读 / 读成功 / 读失败, where an
 *      empty array is read FAILURE (B16) and only a non-empty array is
 *      authoritative.
 *
 * File-system assertions (0600, no `.tmp` leftover, bytes untouched on a
 * refused write) run against a real temp directory: the atomic write is the
 * point of `src/atomicFile.ts`, so mocking `node:fs` here would only prove the
 * mock was called.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeFileAtomicSync } from '../../src/atomicFile.js'
import {
  DEFAULT_SCOPE,
  SCOPE_DOC_VERSION,
  ToolScopeState,
  isVisible,
  normalizeScope,
  normalizeWorkspaceId,
  toScopeWorkspace,
  type SaveResult,
  type ScopeDoc,
  type ScopeMode,
} from '../../src/toolScope.js'

const tempDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

/** A fresh scope-file path inside a temp directory this suite cleans up. */
function makeScopeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-scope-'))
  tempDirs.push(dir)
  return join(dir, 'scope.json')
}

/** Writes a scope document fixture in the same shape the plugin writes. */
function writeScopeFixture(file: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(file, text)
  return text
}

function readText(file: string): string {
  return readFileSync(file, 'utf8')
}

/** The file mode bits, without the file-type bits `stat` also carries. */
function permissions(file: string): number {
  return statSync(file).mode & 0o777
}

/** Narrows a `SaveResult` to its success arm, failing loudly otherwise. */
function savedDoc(result: SaveResult) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`expected a saved document, got ${result.status} ${result.error}`)
  return result.doc
}

function subset(of: readonly string[], inSet: readonly string[]): boolean {
  return of.every((value) => inSet.includes(value))
}

/** The slice of a document `isVisible` reads; the pure cases build only this. */
function scopeView(
  mode: ScopeMode,
  workspaceIds: string[],
): Pick<ScopeDoc, 'mode' | 'workspaceIds'> {
  return { mode, workspaceIds }
}

describe('the default document — 谁都不给 (D3, ①)', () => {
  it('reads a missing file as DEFAULT_SCOPE, without warning', () => {
    const file = makeScopeFile()
    const log = vi.fn()
    const state = new ToolScopeState({ file, log })

    expect(state.doc()).toEqual(DEFAULT_SCOPE)
    // `toEqual` ignores an `undefined`-valued key, so the "no updatedAt key"
    // half of the contract (which is what makes D3 observable as a whole-object
    // comparison) has to be asserted on the key itself.
    expect(Object.hasOwn(DEFAULT_SCOPE, 'updatedAt')).toBe(false)
    expect(Object.hasOwn(state.doc(), 'updatedAt')).toBe(false)

    expect(() => state.load()).not.toThrow()
    expect(state.doc()).toEqual(DEFAULT_SCOPE)
    expect(log).not.toHaveBeenCalled()
  })

  it('declares version 1 as the only version this plugin reads and writes', () => {
    expect(SCOPE_DOC_VERSION).toBe(1)
    expect(DEFAULT_SCOPE).toEqual({ version: 1, revision: 0, mode: 'selected', workspaceIds: [] })
  })
})

describe('normalizeScope — the single input → document entry point (②, ⑩)', () => {
  it('accepts a valid document read as text, keeping its updatedAt', () => {
    const text = JSON.stringify({
      version: 1,
      revision: 3,
      updatedAt: '2026-10-15T06:20:00.000Z',
      mode: 'global',
      workspaceIds: ['W2', 'W1'],
    })

    const { doc, problem } = normalizeScope(text)

    expect(problem).toBeUndefined()
    expect(doc).toEqual({
      version: 1,
      revision: 3,
      updatedAt: '2026-10-15T06:20:00.000Z',
      mode: 'global',
      // normalized: de-duplicated and sorted ascending by string comparison
      workspaceIds: ['W1', 'W2'],
    })
  })

  it('falls to the strict side — selected + empty — on unparsable text', () => {
    const { doc, problem } = normalizeScope('{ this is not json')

    expect(problem).toBe('parse')
    expect(doc).toEqual(DEFAULT_SCOPE)
  })

  it.each([
    ['a missing version', { revision: 0, mode: 'selected', workspaceIds: [] }],
    ['a string version', { version: '1', revision: 0, mode: 'selected', workspaceIds: [] }],
    ['a missing revision', { version: 1, mode: 'selected', workspaceIds: [] }],
    ['an unknown mode', { version: 1, revision: 0, mode: 'nope', workspaceIds: [] }],
    ['a missing workspaceIds', { version: 1, revision: 0, mode: 'selected' }],
    ['a non-array workspaceIds', { version: 1, revision: 0, mode: 'selected', workspaceIds: 'x' }],
    ['a non-string workspace id', { version: 1, revision: 0, mode: 'selected', workspaceIds: [1] }],
    ['a non-string updatedAt', { version: 1, revision: 0, mode: 'selected', workspaceIds: [], updatedAt: 5 }],
  ])('falls to the strict side on %s', (_label, input) => {
    const { doc, problem } = normalizeScope(input)

    expect(problem).toBe('parse')
    expect(doc).toEqual(DEFAULT_SCOPE)
  })

  it('de-duplicates and stably sorts workspaceIds by string comparison', () => {
    // ⑩'s shape, with the version/revision ② requires: a document that is
    // missing `version` is the parse path by definition, not a normalizable one.
    const input = { version: SCOPE_DOC_VERSION, revision: 0, mode: 'selected', workspaceIds: ['B', 'A', 'B'] }

    const first = normalizeScope(input)
    const second = normalizeScope(input)

    expect(first.problem).toBeUndefined()
    expect(first.doc.workspaceIds).toEqual(['A', 'B'])
    // 逐字: a second run over the same unordered input produces the same bytes.
    expect(JSON.stringify(second.doc)).toBe(JSON.stringify(first.doc))
  })

  it.each([0, 2, 99])('routes a type-legal version %i to version-unsupported', (version) => {
    const { doc, problem } = normalizeScope({ version, revision: 5, mode: 'global', workspaceIds: ['W'] })

    expect(problem).toBe('version-unsupported')
    // 判定口径同严格侧 — never "the user selected nothing" in a writable sense.
    expect(doc.mode).toBe('selected')
    expect(doc.workspaceIds).toEqual([])
  })
})

describe('the warn carrier — parse failures only, exactly once (②)', () => {
  it('warns once through the injected log on an unparsable document, adding no degraded source', () => {
    const file = makeScopeFile()
    writeFileSync(file, '{ this is not json')
    const log = vi.fn()
    const state = new ToolScopeState({ file, log })

    state.load()
    // A second read is a no-op: reads are memoized, so "exactly once" holds for
    // the lifetime of the state, not merely for the first call.
    state.load()

    expect(state.doc()).toEqual(DEFAULT_SCOPE)
    // No new DegradedSource member exists for parse failures (the enum is
    // exactly five values) — the carrier is this warn plus the strict side.
    expect(state.degraded()).toEqual([])
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('warns once through the injected log on a field-invalid document', () => {
    const file = makeScopeFile()
    writeScopeFixture(file, { version: 1, revision: 0, mode: 'nope', workspaceIds: [] })
    const log = vi.fn()
    const state = new ToolScopeState({ file, log })

    state.load()

    expect(state.doc()).toEqual(DEFAULT_SCOPE)
    expect(state.degraded()).toEqual([])
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('falls back to the existing console.warn carrier when no log is injected', () => {
    const file = makeScopeFile()
    writeFileSync(file, 'not json at all')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    new ToolScopeState({ file }).load()

    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not warn for a valid document', () => {
    const file = makeScopeFile()
    writeScopeFixture(file, { version: 1, revision: 2, mode: 'global', workspaceIds: ['W'] })
    const log = vi.fn()

    const state = new ToolScopeState({ file, log })
    state.load()

    expect(state.doc()).toEqual({ version: 1, revision: 2, mode: 'global', workspaceIds: ['W'] })
    expect(state.degraded()).toEqual([])
    expect(log).not.toHaveBeenCalled()
  })
})

describe('the version branch has two sides, asserted apart (②, ⑦)', () => {
  it.each([0, 2, 99])('reads version %i as a read-only degradation, never as parse', (version) => {
    const file = makeScopeFile()
    const original = writeScopeFixture(file, {
      version,
      revision: 7,
      mode: 'global',
      workspaceIds: ['W'],
    })
    const log = vi.fn()
    const state = new ToolScopeState({ file, log })

    state.load()

    // The strict side, but degraded by an explicit note rather than "空选".
    expect(state.doc().mode).toBe('selected')
    expect(state.doc().workspaceIds).toEqual([])
    const notes = state.degraded()
    expect(notes).toHaveLength(1)
    expect(notes[0]!.source).toBe('scope-version')
    expect(notes[0]!.reason).toContain('文档版本高于本插件支持')

    // The document is not ours to overwrite: refused, and byte-for-byte intact.
    expect(state.save({ mode: 'selected', workspaceIds: ['W'] }, 7)).toEqual({
      ok: false,
      status: 503,
      error: 'scope-version-unsupported',
      message: expect.any(String),
    })
    expect(readText(file)).toBe(original)
    expect(state.doc().mode).toBe('selected')
    expect(state.doc().workspaceIds).toEqual([])
  })

  it('decides the version branch by version alone, before any other field check', () => {
    // A newer format plausibly carries fields this build cannot parse. The
    // read-only latch exists for exactly that document: deciding the branch
    // after the field checks would classify it as a parse failure, hand it back
    // as writable, and let the next PUT destroy the newer document.
    const evolved = { version: 2, workspaceIds: 'evolved-shape' }

    expect(normalizeScope(JSON.stringify(evolved)).problem).toBe('version-unsupported')

    const file = makeScopeFile()
    const original = writeScopeFixture(file, evolved)
    const state = new ToolScopeState({ file })

    state.load()

    expect(state.doc()).toEqual(DEFAULT_SCOPE)
    expect(state.degraded()).toEqual([
      { source: 'scope-version', reason: expect.stringContaining('文档版本高于本插件支持') },
    ])
    expect(state.save({ mode: 'global', workspaceIds: [] }, 0)).toEqual({
      ok: false,
      status: 503,
      error: 'scope-version-unsupported',
      message: expect.any(String),
    })
    // 不可覆写 is the property under test, not the error code alone.
    expect(readText(file)).toBe(original)

    // The other side stays separate: with the SAME otherwise-invalid field, a
    // type-invalid version is still the parse path (and therefore writable).
    const mistyped = normalizeScope({ version: '2', workspaceIds: 'evolved-shape' })
    expect(mistyped.problem).toBe('parse')
    expect(mistyped.doc).toEqual(DEFAULT_SCOPE)
  })

  it('treats a type-invalid version as the parse path, which stays writable (B9)', () => {
    const file = makeScopeFile()
    // `version: '1'` is a type error, NOT "a version above this plugin": the
    // parse path must not be reachable only from unparsable text.
    writeScopeFixture(file, { version: '1', revision: 9, mode: 'global', workspaceIds: ['W'] })
    const log = vi.fn()
    const state = new ToolScopeState({ file, log })

    state.load()

    expect(state.doc()).toEqual(DEFAULT_SCOPE)
    expect(log).toHaveBeenCalledTimes(1)
    expect(state.degraded()).toEqual([])
    // B9: a field-invalid document is overwritable — the strict default is a
    // revision-0 document, so a client can save over it.
    const result = state.save({ mode: 'global', workspaceIds: [] }, 0)
    expect(result).toMatchObject({ ok: true })
    expect(savedDoc(result).revision).toBe(1)
  })
})

describe('isVisible — the strictness order (③, ④, ⑤)', () => {
  it('global is visible for any id, including undefined (B2)', () => {
    const doc = scopeView('global', [])

    expect(isVisible(doc, 'W')).toBe(true)
    expect(isVisible(doc, 'not-in-any-list')).toBe(true)
    expect(isVisible(doc, undefined)).toBe(true)
  })

  it('selected + non-empty: a member is visible, a miss or undefined is not (D7/B5)', () => {
    const doc = scopeView('selected', ['W'])

    expect(isVisible(doc, 'W')).toBe(true)
    expect(isVisible(doc, 'X')).toBe(false)
    expect(isVisible(doc, undefined)).toBe(false)
  })

  it('selected + empty: nobody is visible (B1)', () => {
    const doc = scopeView('selected', [])

    expect(isVisible(doc, 'W')).toBe(false)
    expect(isVisible(doc, undefined)).toBe(false)
  })

  it('normalizes both sides of the comparison before comparing (id contract)', () => {
    expect(normalizeWorkspaceId(123)).toBe('123')
    expect(normalizeWorkspaceId('  W ')).toBe('W')

    // The document side is normalized, not just the lookup side.
    expect(isVisible({ mode: 'selected', workspaceIds: ['  W '] }, 'W')).toBe(true)
    // …and the lookup side too.
    expect(isVisible({ mode: 'selected', workspaceIds: ['W'] }, '  W ')).toBe(true)
    // Normalizing still unequal ⇒ not a match; no case or path guessing.
    expect(isVisible({ mode: 'selected', workspaceIds: ['W'] }, 'w')).toBe(false)

    // A registry id that is not a string reaches the same workspace as the
    // document's string id.
    const registryId = toScopeWorkspace({ id: 123, path: '/n' })!.id
    expect(registryId).toBe('123')
    expect(isVisible({ mode: 'selected', workspaceIds: ['123'] }, registryId)).toBe(true)
  })

  it('orders the visible sets selected+[] ⊆ selected+[W] ⊆ global (B9)', () => {
    const candidates = ['W', 'X', '123']
    const visible = (mode: 'global' | 'selected', workspaceIds: string[]) =>
      candidates.filter((id) => isVisible({ mode, workspaceIds }, id))

    const none = visible('selected', [])
    const one = visible('selected', ['W'])
    const all = visible('global', [])

    expect(none).toEqual([])
    expect(one).toEqual(['W'])
    expect(all).toEqual(candidates)
    expect(subset(none, one)).toBe(true)
    expect(subset(one, all)).toBe(true)
  })
})

describe('toScopeWorkspace — boundary normalization of a registry item', () => {
  it('keeps a usable item and String()-normalizes its id and path', () => {
    expect(toScopeWorkspace({ id: 'W', title: 'Work', path: '/w', sessionIds: ['s1'] })).toEqual({
      id: 'W',
      title: 'Work',
      path: '/w',
      sessionIds: ['s1'],
    })
    expect(toScopeWorkspace({ id: 123, title: 'N', path: '/n' })).toEqual({
      id: '123',
      title: 'N',
      path: '/n',
      sessionIds: [],
    })
    expect(toScopeWorkspace({ id: '  W  ', path: '  /w  ' })).toEqual({
      id: 'W',
      title: '',
      path: '/w',
      sessionIds: [],
    })
    expect(toScopeWorkspace({ id: 'W', path: '/w', sessionIds: 'not-an-array' })).toEqual({
      id: 'W',
      title: '',
      path: '/w',
      sessionIds: [],
    })
  })

  it('rejects an item with no usable id or path', () => {
    expect(toScopeWorkspace({ path: '/w' })).toBeUndefined()
    expect(toScopeWorkspace({ id: '', path: '/w' })).toBeUndefined()
    expect(toScopeWorkspace({ id: '   ', path: '/w' })).toBeUndefined()
    expect(toScopeWorkspace({ id: 'W' })).toBeUndefined()
    expect(toScopeWorkspace({ id: 'W', path: '   ' })).toBeUndefined()
    expect(toScopeWorkspace(undefined)).toBeUndefined()
    expect(toScopeWorkspace('W')).toBeUndefined()
  })

  it('exposes only items that normalized once a read succeeded', () => {
    const state = new ToolScopeState({ file: makeScopeFile() })

    state.setWorkspaces([
      { id: 123, title: 'N', path: '/n' },
      { id: 'B', path: '/b' },
      { title: 'no id', path: '/x' },
    ])

    expect(state.workspaces()).toEqual([
      { id: '123', title: 'N', path: '/n', sessionIds: [] },
      { id: 'B', title: '', path: '/b', sessionIds: [] },
    ])
  })
})

describe('the degraded set — same source dedupes, different sources coexist (⑥)', () => {
  it('starts empty and keeps only the latest reason per source', () => {
    const state = new ToolScopeState({ file: makeScopeFile() })

    expect(state.degraded()).toEqual([])

    state.noteDegraded({ source: 'install', reason: 'first' })
    state.noteDegraded({ source: 'install', reason: 'second' })

    expect(state.degraded()).toEqual([{ source: 'install', reason: 'second' }])
  })

  it('keeps one note per source while all five sources coexist', () => {
    const state = new ToolScopeState({ file: makeScopeFile() })

    // `workspace-list` is written by its one write site, not by the test.
    state.setWorkspaces([])
    state.noteDegraded({ source: 'install', reason: 'install failed' })
    state.noteDegraded({ source: 'visibility-only', reason: 'no tools.guard' })
    state.noteDegraded({ source: 'scope-version', reason: 'version above this plugin' })
    state.noteDegraded({ source: 'path-normalization', reason: 'no resolveByPath' })

    const notes = state.degraded()
    expect(notes).toHaveLength(5)
    expect(notes.map((note) => note.source).sort()).toEqual([
      'install',
      'path-normalization',
      'scope-version',
      'visibility-only',
      'workspace-list',
    ])
    expect(notes.find((note) => note.source === 'workspace-list')!.reason).toEqual(expect.any(String))
  })
})

describe('the workspace list has three states and one write site (⑧, ⑨)', () => {
  /** A version-1 document already on disk, with an id the registry will not have. */
  function storedFixture(file: string): string {
    return writeScopeFixture(file, {
      version: 1,
      revision: 2,
      mode: 'selected',
      workspaceIds: ['GONE', 'W'],
    })
  }

  /** Read failure ⇒ 503, nothing pruned, nothing written, one degraded note. */
  function assertReadFailureRefuses(list: readonly unknown[] | undefined): void {
    const file = makeScopeFile()
    const original = storedFixture(file)
    const state = new ToolScopeState({ file })
    state.load()

    state.setWorkspaces(list)

    expect(state.save({ mode: 'global', workspaceIds: ['X'] }, 2)).toEqual({
      ok: false,
      status: 503,
      error: 'workspace-list-unavailable',
      message: expect.any(String),
    })
    // 一位不动: the in-memory document and the bytes on disk are both untouched.
    expect(state.doc().mode).toBe('selected')
    expect(state.doc().workspaceIds).toEqual(['GONE', 'W'])
    expect(state.doc().revision).toBe(2)
    expect(readText(file)).toBe(original)
    // "读不到" is not "全都失效".
    expect(state.staleWorkspaceIds()).toEqual([])
    expect(state.workspaces()).toEqual([])
    expect(state.degraded().some((note) => note.source === 'workspace-list')).toBe(true)
  }

  it('treats setWorkspaces(undefined) as a read failure', () => {
    assertReadFailureRefuses(undefined)
  })

  it('treats setWorkspaces([]) as a read failure (B16: [] ≡ read failure)', () => {
    assertReadFailureRefuses([])
  })

  it('allows a write but never prunes while the list has never been read', () => {
    const file = makeScopeFile()
    const state = new ToolScopeState({ file })

    const result = state.save({ mode: 'selected', workspaceIds: ['W', 'GONE'] }, 0)

    expect(result).toMatchObject({ ok: true, pruned: [] })
    // Written as sent (normalized order), GONE kept: no authoritative list means
    // no deletion decision on the user's behalf.
    expect(savedDoc(result).workspaceIds).toEqual(['GONE', 'W'])
    expect(state.doc().workspaceIds).toEqual(['GONE', 'W'])
    expect(state.workspaces()).toEqual([])
    expect(state.staleWorkspaceIds()).toEqual([])
    // 还没读过 is not 读不出来.
    expect(state.degraded()).toEqual([])
  })
})

describe('save() — pruning, revisions and the refusal order (⑦)', () => {
  it('prunes registry-outside ids, bumps the revision and keeps the mode', () => {
    const file = makeScopeFile()
    const state = new ToolScopeState({ file })
    state.setWorkspaces([{ id: 'W', title: 'W', path: '/w' }])

    const first = state.save({ mode: 'selected', workspaceIds: ['W', 'GONE'] }, 0)

    expect(first).toMatchObject({ ok: true, pruned: ['GONE'] })
    expect(savedDoc(first).revision).toBe(1)
    expect(state.doc().revision).toBe(1)
    expect(state.doc().workspaceIds).toEqual(['W'])
    expect(state.doc().mode).toBe('selected')
    expect(state.staleWorkspaceIds()).toEqual([])
    // The write is atomic and 0600, with no temp file left behind.
    expect(permissions(file)).toBe(0o600)
    expect(existsSync(`${file}.tmp`)).toBe(false)

    const second = state.save({ mode: 'selected', workspaceIds: ['W'] }, 1)
    expect(savedDoc(second).revision).toBe(2)
    expect(state.doc().revision).toBe(2)
  })

  it('returns the very document it stored, from one normalization (⑩)', () => {
    const file = makeScopeFile()
    const state = new ToolScopeState({ file })
    state.setWorkspaces([
      { id: 'B', title: 'B', path: '/b' },
      { id: 'A', title: 'A', path: '/a' },
    ])

    const result = state.save({ mode: 'selected', workspaceIds: ['B', 'A', 'B'] }, 0)

    const doc = savedDoc(result)
    expect(doc.workspaceIds).toEqual(['A', 'B'])
    // Not a second copy and not a second sort: the returned document IS the one
    // `doc()` serves, down to the array instance.
    expect(doc).toBe(state.doc())
    expect(doc.workspaceIds).toBe(state.doc().workspaceIds)
  })

  it('reports registry-outside ids as stale and clears them on an authoritative save (B14)', () => {
    const file = makeScopeFile()
    const stored = writeScopeFixture(file, {
      version: 1,
      revision: 4,
      mode: 'selected',
      workspaceIds: ['GONE', 'W'],
    })
    const state = new ToolScopeState({ file })
    state.load()
    state.setWorkspaces([{ id: 'W', title: 'W', path: '/w' }])

    expect(state.staleWorkspaceIds()).toEqual(['GONE'])
    expect(state.workspaces().map((workspace) => workspace.id)).toEqual(['W'])
    expect(stored).toContain('GONE')

    const result = state.save({ mode: 'selected', workspaceIds: ['GONE', 'W'] }, 4)

    expect(result).toMatchObject({ ok: true, pruned: ['GONE'] })
    expect(state.doc().workspaceIds).toEqual(['W'])
    expect(state.staleWorkspaceIds()).toEqual([])
    expect(state.doc().mode).toBe('selected')
    expect(readText(file)).not.toContain('GONE')
  })

  it('refuses a stale expectedRevision with 409 and leaves the document untouched', () => {
    const file = makeScopeFile()
    const state = new ToolScopeState({ file })
    state.setWorkspaces([{ id: 'W', title: 'W', path: '/w' }])
    state.save({ mode: 'selected', workspaceIds: ['W'] }, 0)
    const before = state.doc()
    const bytes = readText(file)

    const result = state.save({ mode: 'global', workspaceIds: [] }, 0)

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'scope-revision-conflict',
      message: expect.stringContaining('revision=1'),
    })
    expect(state.doc()).toEqual(before)
    expect(state.doc().revision).toBe(1)
    expect(state.doc().mode).toBe('selected')
    expect(readText(file)).toBe(bytes)
  })

  it.each([
    ['an invalid mode', { mode: 'nope', workspaceIds: [] }],
    ['a non-array workspaceIds', { mode: 'selected', workspaceIds: 'x' }],
    ['a missing workspaceIds', { mode: 'selected' }],
    ['a null body', null],
    ['a string body', 'nope'],
  ])('refuses %s with 400 invalid-scope', (_label, body) => {
    const state = new ToolScopeState({ file: makeScopeFile() })

    expect(state.save(body, 0)).toEqual({
      ok: false,
      status: 400,
      error: 'invalid-scope',
      message: expect.any(String),
    })
  })

  it('refuses a missing expectedRevision with 400 missing-expected-revision', () => {
    const state = new ToolScopeState({ file: makeScopeFile() })

    expect(state.save({ mode: 'selected', workspaceIds: [] }, undefined)).toEqual({
      ok: false,
      status: 400,
      error: 'missing-expected-revision',
      message: expect.any(String),
    })
  })

  it('orders its refusals: pre-existing state, then fields, then the revision', () => {
    // Version-unsupported outranks an invalid body (the else-branch of the
    // "stricter field validation wins" mistake).
    const versioned = makeScopeFile()
    writeScopeFixture(versioned, { version: 2, revision: 0, mode: 'selected', workspaceIds: [] })
    const versionState = new ToolScopeState({ file: versioned })
    versionState.load()
    expect(versionState.save({ mode: 'nope' }, 0)).toMatchObject({
      status: 503,
      error: 'scope-version-unsupported',
    })

    // An unavailable list outranks an invalid body.
    const listed = new ToolScopeState({ file: makeScopeFile() })
    listed.setWorkspaces([])
    expect(listed.save({ mode: 'nope' }, 0)).toMatchObject({
      status: 503,
      error: 'workspace-list-unavailable',
    })

    // Invalid fields outrank a missing revision…
    const plain = new ToolScopeState({ file: makeScopeFile() })
    expect(plain.save({ mode: 'nope' }, undefined)).toMatchObject({
      status: 400,
      error: 'invalid-scope',
    })
    // …and a missing revision outranks a revision conflict: on a revision-1
    // document a swapped order would compare `undefined !== 1` and answer 409,
    // so the 400 below is what makes the order observable.
    plain.setWorkspaces([{ id: 'W', title: 'W', path: '/w' }])
    expect(savedDoc(plain.save({ mode: 'selected', workspaceIds: [] }, 0)).revision).toBe(1)
    expect(plain.save({ mode: 'selected', workspaceIds: [] }, undefined)).toMatchObject({
      status: 400,
      error: 'missing-expected-revision',
    })
  })
})

describe('writeFileAtomicSync — the replicated atomic write', () => {
  it('creates the parent directory, writes 0600 by default and leaves no temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-scope-'))
    tempDirs.push(dir)
    const file = join(dir, 'nested', 'scope.json')

    writeFileAtomicSync(file, 'first\n')

    expect(readText(file)).toBe('first\n')
    expect(permissions(file)).toBe(0o600)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('replaces an existing file in place and honors an explicit mode', () => {
    const file = makeScopeFile()
    writeFileSync(file, 'old\n')

    writeFileAtomicSync(file, 'new\n', 0o644)

    expect(readText(file)).toBe('new\n')
    expect(permissions(file)).toBe(0o644)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('removes the temp file and rethrows when the rename fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-scope-'))
    tempDirs.push(dir)
    // The target is an existing non-empty directory, so `rename` cannot replace
    // it: the failure branch must drop the temp file and surface the error.
    const file = join(dir, 'scope.json')
    mkdirSync(file)
    writeFileSync(join(file, 'keep.txt'), 'keep\n')

    let thrown: unknown
    try {
      writeFileAtomicSync(file, 'never lands\n')
    } catch (error) {
      thrown = error
    }

    // The errno is what proves the failure happened at the RENAME (and not
    // earlier, at the open): only then does the cleanup below mean anything.
    expect((thrown as NodeJS.ErrnoException).code).toBe('EISDIR')
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(readText(join(file, 'keep.txt'))).toBe('keep\n')
  })
})
