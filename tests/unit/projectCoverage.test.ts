/**
 * F6 (UltraReview) — the tsconfig SPLIT is a partition, not a hope.
 *
 * `npm run typecheck` runs two projects:
 *
 *   - `tsconfig.json`      — the server project (Node libs, no JSX);
 *   - `tsconfig.ui.json`   — the UI project (DOM libs + `jsx: react-jsx`).
 *
 * They are separated because `lib`/`jsx`/`types` are per-project: the UI tests
 * need `document`, `EventSource` and the JSX transform, while the server tests
 * must NOT resolve them (a server file that used `document` would typecheck
 * green against a lib set that only exists in a browser).
 *
 * The failure this guards is silent, not loud. If a test file is dropped from
 * one project's `include` and never added to the other's, `tsc` simply does not
 * see it: typecheck stays green while the file goes unchecked forever. So this
 * asserts the two sets PARTITION `tests/**\/*.test.ts` — every test matched by
 * EXACTLY ONE project.
 *
 * The tsconfigs are parsed with a minimal JSONC reader (they carry rationale
 * comments) and matched with a minimal glob matcher, both deliberately small:
 * adding a dependency to test a two-line `include` list would be worse than the
 * risk it removes. The reader is itself asserted against the real files below,
 * so a silent parse failure cannot make this test pass vacuously.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Strips `//` and block comments from a JSONC document, then parses it.
 *
 * Comment-aware rather than regex-only: a `//` inside a string value (a path
 * like `https://…`, or a glob) must survive. The scanner walks the text once
 * and only treats `//`/`/*` as a comment when it is OUTSIDE a string, so the
 * tsconfigs' own comments are removed without corrupting their values.
 */
function parseJsonc(text: string): Record<string, unknown> {
  let out = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    const next = text[index + 1]

    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 1
      continue
    }
    out += char
  }

  return JSON.parse(out) as Record<string, unknown>
}

/** Reads one tsconfig's `include` / `exclude` lists, defaulting to `[]`. */
function readProject(file: string): { include: string[]; exclude: string[] } {
  const parsed = parseJsonc(readFileSync(join(repoRoot, file), 'utf8'))
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])
  return { include: list(parsed['include']), exclude: list(parsed['exclude']) }
}

/**
 * Compiles a tsconfig-style glob into a regex over a repo-relative POSIX path.
 *
 * Supports what these two files actually use — `**` (any depth, including
 * none), `*` (within one segment), `?` — which is the whole `include` idiom
 * here. Anything fancier would be unused generality.
 */
function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**/` — zero or more whole segments; a bare `**` — anything.
        if (glob[index + 2] === '/') {
          source += '(?:[^/]+/)*'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/**
 * Matches a path the way `tsc` does for these lists: a pattern matches the path
 * itself OR a DIRECTORY PREFIX of it (that is how `"ui"` and `"src"` name whole
 * trees), so a file is included when any pattern matches it or an ancestor.
 */
function matchesAny(patterns: string[], path: string): boolean {
  const segments = path.split('/')
  const ancestors = segments.map((_, index) => segments.slice(0, index + 1).join('/'))
  return patterns.some((pattern) => {
    const regex = globToRegExp(pattern)
    return ancestors.some((candidate) => regex.test(candidate))
  })
}

/** Every `tests/**\/*.test.ts` file, repo-relative and POSIX-separated. */
function collectTestFiles(): string[] {
  const root = join(repoRoot, 'tests')
  const found: string[] = []
  const walk = (directory: string): void => {
    // `readdirSync` with `withFileTypes` avoids a second stat per entry.
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        found.push(relative(repoRoot, absolute).split(sep).join('/'))
      }
    }
  }
  walk(root)
  return found.sort()
}

const SERVER = 'tsconfig.json'
const UI = 'tsconfig.ui.json'

describe('F6: the two tsconfig projects partition tests/**/*.test.ts', () => {
  const testFiles = collectTestFiles()
  const server = readProject(SERVER)
  const ui = readProject(UI)

  it('parses both tsconfigs as JSONC (the guard against a vacuous pass)', () => {
    // If the comment-stripping reader broke, every list would come back empty
    // and the partition assertions below would fail confusingly — so assert the
    // inputs are real first. The comments themselves are asserted too: F6/F7
    // require the split to be EXPLAINED where it is declared.
    expect(server.include).toContain('src')
    expect(server.include).toContain('tests')
    expect(server.exclude).toContain('ui')
    expect(ui.include).toContain('ui')
    expect(ui.include).toContain('tests/unit/ui.test.ts')

    expect(readFileSync(join(repoRoot, SERVER), 'utf8')).toMatch(/partition|exactly once/)
    expect(readFileSync(join(repoRoot, UI), 'utf8')).toContain('projectCoverage')
    // F7: the dev-harness boundary is documented, not merely implied.
    expect(readFileSync(join(repoRoot, UI), 'utf8')).toContain('dev.tsx')
    // F8: the research checkout is named as excluded where that is decided.
    expect(readFileSync(join(repoRoot, SERVER), 'utf8')).toContain('_research')
  })

  it('discovers the whole test tree (so the partition is over every file)', () => {
    expect(testFiles.length).toBeGreaterThanOrEqual(16)
    expect(testFiles).toContain('tests/unit/ui.test.ts')
    expect(testFiles).toContain('tests/integration/clientBundle.test.ts')
    expect(testFiles).toContain('tests/contract/contract.test.ts')
    // The three UI-environment files this split exists for.
    expect(testFiles).toContain('tests/unit/projectCoverage.test.ts')
  })

  it('matches every test file to EXACTLY ONE project', () => {
    const inServer = (path: string): boolean =>
      matchesAny(server.include, path) && !matchesAny(server.exclude, path)
    const inUi = (path: string): boolean => matchesAny(ui.include, path) && !matchesAny(ui.exclude, path)

    const uncovered: string[] = []
    const doublyCovered: string[] = []

    for (const file of testFiles) {
      const serverCovers = inServer(file)
      const uiCovers = inUi(file)
      if (!serverCovers && !uiCovers) uncovered.push(file)
      if (serverCovers && uiCovers) doublyCovered.push(file)
    }

    // Named explicitly so a regression reports WHICH file slipped, not just a
    // count: an unchecked test is invisible in every other signal we have.
    expect(doublyCovered).toEqual([])
    expect(uncovered).toEqual([])
  })

  it('routes the three UI-environment tests to the UI project specifically', () => {
    // The point of the split, stated directly: these two need DOM libs / jsdom
    // and must be the UI project's, not the server's.
    for (const file of ['tests/unit/ui.test.ts', 'tests/integration/clientBundle.test.ts']) {
      expect(matchesAny(ui.include, file)).toBe(true)
      expect(matchesAny(server.exclude, file)).toBe(true)
    }
  })

  it('keeps ui/** and _research/** out of the server project', () => {
    // `ui/**` is the UI project's; `_research/**` is a vendored upstream
    // checkout that this plugin neither builds nor typechecks (F8).
    expect(matchesAny(server.exclude, 'ui/src/dev.tsx')).toBe(true)
    expect(matchesAny(server.exclude, '_research/cherry-studio/src/index.ts')).toBe(true)
    expect(matchesAny(ui.include, 'ui/src/dev.tsx')).toBe(true)
  })
})
