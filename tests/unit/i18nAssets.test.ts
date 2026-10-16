/**
 * §8.1⑥ — SOURCE-LEVEL CJK GUARD: no Chinese literal lives in `ui/src/**` except
 * in the dictionary itself.
 *
 * `tests/unit/localeRender.test.ts` proves the components RENDER English under
 * an `en` store, but its reach is bounded by its fixtures: a branch no case
 * enters, or a Chinese string that never made it into the dictionary at all,
 * renders on a real page and no render test notices. This file is the
 * complementary guard — it reads the SOURCE, so it sees every string that
 * exists, whether or not a test ever reaches the line that renders it.
 *
 * ## Why `ui/src/**` and not a named list of the four components
 *
 * The brief is explicit, and the reason is worth restating because the weaker
 * version passes today: a named list ("the 4 components + types.ts") is green
 * right now only because the grey-area files — `api.ts`, `dev.tsx`,
 * `vite-env.d.ts`, `main.tsx` — happen to contain no CJK. That is a coincidence,
 * not a guard: the day someone writes a Chinese sentence into `dev.tsx` or into
 * a new `ui/src/foo.ts`, a named list says nothing. The whitelist below is a
 * FILE (`i18n.ts`), and everything else under `ui/src` is in scope by default,
 * including files that do not exist yet.
 *
 * ## The TypeScript compiler API, and all three literal kinds
 *
 * A regex over the text would have to guess where a string starts: `'…'` inside
 * a `//` comment is prose (and `i18n.ts` is nothing but such prose), a template
 * literal may span lines, and `Ui/src` appears inside identifiers. The parser
 * knows the difference, so the unit of the scan is the NODE, not the line:
 *
 *  - `StringLiteral` — `'中文'`, `"中文"`, and the `"中文"` of a JSX attribute
 *    (a JSX attribute's value is an ordinary string literal, so it needs no kind
 *    of its own);
 *  - `NoSubstitutionTemplateLiteral` — `` `中文` ``;
 *  - `JsxText` — the raw text children of a JSX element (`<p>中文</p>`), which is
 *    where a component's copy lives before it is a string at all.
 *
 * Comments are deliberately invisible to this walk: they are trivia attached to
 * nodes, not nodes, so `i18n.ts`'s long Chinese rationale never trips the guard
 * even though the file is whitelisted for its VALUES.
 *
 * ## The parse entry point: `typescript@7` has no `ts.createSourceFile`
 *
 * The brief assumes the classic `ts.createSourceFile(file, text, ScriptTarget,
 * setParentNodes)` API. The installed compiler is **typescript 7.0.2**, whose
 * `exports` map no longer exposes the monolithic `typescript` namespace: the
 * bare `'typescript'` specifier resolves to `lib/version.cjs` (two version
 * fields and nothing else), and the parser is reachable only through the
 * `typescript/unstable/*` subpaths. Measured, not assumed:
 *
 *  - `import ts from 'typescript'` yields an object with NO `createSourceFile`
 *    and NO `ScriptTarget` — the first draft of this file died on
 *    `Cannot read properties of undefined (reading 'Latest')`;
 *  - `ts.SyntaxKind` under `'typescript/unstable/ast'` DOES exist, and the
 *    literal kinds are the classic numeric values (`StringLiteral` 10,
 *    `JsxText` 11, `NoSubstitutionTemplateLiteral` 14);
 *  - the supported way to get a parsed `SourceFile` is the LSP-shaped
 *    `unstable/sync` `API`: `updateSnapshot({ openFiles })` then
 *    `snapshot.getProject('/dev/null/inferred').program.getSourceFile(name)`.
 *
 * This file therefore uses that API — ONE session for the whole scan, because
 * opening a session per file costs a project load each time. The trade is
 * stated in the test below: the session is a genuinely in-memory parse of the
 * files on disk (no `tsconfig` is consulted for the scan, so a file excluded
 * from a project is still scanned, which is exactly the property a source-level
 * guard needs).
 *
 * ## The CJK range
 *
 * `\u4e00-\u9fff` (CJK Unified Ideographs, the block the brief names as the
 * minimum) plus the four common extensions and the compatibility block:
 *
 *  - `\u3400-\u4dbf` — Extension A (rare ideographs);
 *  - `\uf900-\ufaff` — CJK Compatibility Ideographs (NFC-stable duplicates);
 *  - `\U00020000-\U0002ebef` — Extension B and the C–F blocks on the first
 *    astral plane, where a pasted rare character commonly lands.
 *
 * Deliberately NOT included, each for a reason that is about SOURCE text rather
 * than about Chinese: the CJK punctuation blocks (`\u3000-\u303f`, including
 * `、` and `。`) — the zh dictionary is whitelisted by FILE, so including them
 * would only widen the blast radius of a stray full-width comma in a comment;
 * the kana and Hangul blocks — the guard is named "CJK" and Japanese/Korean
 * copy is not what it exists to catch; and the Halfwidth/Fullwidth Forms block,
 * which contains `：` and `（）`.
 *
 * The range is stated once, here, and asserted against real characters below so
 * a mis-escaped pattern cannot make this file pass vacuously.
 *
 * ## Partition
 *
 * This file imports NO `ui/src` module — it reads them as TEXT and parses them
 * with the compiler API — so it belongs to the SERVER tsconfig project by
 * default. Unlike `i18nUsage.test.ts` it is named in NEITHER tsconfig, and
 * `tests/unit/projectCoverage.test.ts` proves it is still covered exactly once.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API } from 'typescript/unstable/sync'
import { SyntaxKind } from 'typescript/unstable/ast'
import type { Node, SourceFile } from 'typescript/unstable/ast'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UI_SRC = join(repoRoot, 'ui', 'src')

/**
 * The ONE file allowed to contain CJK: the zh dictionary (§8.1⑥).
 *
 * It is also the only place a Chinese string may live, which is what makes
 * "whitelist by file" the right shape — a whitelist by STRING would have to
 * enumerate 98 sentences and would need editing every time the copy changes.
 */
const CJK_WHITELIST = ['ui/src/i18n.ts']

/**
 * The CJK Unified Ideographs range plus the extensions listed in the header.
 * `/u` so the astral ranges are real code points rather than surrogate halves.
 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[\u{20000}-\u{2ebef}]/u

/** The three literal kinds §8.1⑥ names, as `SyntaxKind` values. */
const SCANNED_KINDS = new Set<number>([
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.JsxText,
])

/** One CJK-bearing literal found in one file. */
interface CjkHit {
  line: number
  kind: string
  text: string
}

/** Every `ui/src/**\/*.{ts,tsx}` file, repo-relative and POSIX-separated. */
function collectSources(): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        found.push(relative(repoRoot, absolute).split(sep).join('/'))
      }
    }
  }
  walk(UI_SRC)
  return found.sort()
}

const sources = collectSources()

/**
 * ONE parse session for the whole scan.
 *
 * `openFiles` is the scan set itself, so the inferred project holds exactly the
 * files this test reads — no `tsconfig` is involved, which is what keeps the
 * scan total over `ui/src/**`: a file some project excludes (or that no project
 * includes) is still parsed here.
 */
const session = new API()
const snapshot = session.updateSnapshot({ openFiles: sources })
/**
 * The LSP-shaped session exposes the inferred project under a synthetic config
 * path. Asserted rather than `!`-ed: if a future compiler version renames it,
 * this fails HERE with a message naming the cause, instead of throwing an
 * unrelated `undefined` deep inside the walk.
 */
const INFERRED_PROJECT = '/dev/null/inferred'
const inferred = snapshot.getProject(INFERRED_PROJECT)
if (inferred === undefined) {
  throw new Error(
    `typescript's sync API exposed no project at ${INFERRED_PROJECT}; ` +
      'the parse entry point for this guard has moved (see the file header)',
  )
}
const program = inferred.program

/**
 * The CJK-bearing literals of one already-parsed file.
 *
 * The node's own `text` is read (not `getText()`), because for these three
 * kinds `text` IS the literal's decoded value — the same characters the browser
 * would receive — while `getText()` would hand back the SOURCE slice, quoting
 * and all: `'中文'` with its apostrophes. For a JSX text child the two agree.
 */
function cjkTokens(parsed: SourceFile): CjkHit[] {
  const hits: CjkHit[] = []
  const visit = (node: Node): void => {
    if (SCANNED_KINDS.has(node.kind)) {
      const text = String((node as { text?: unknown }).text ?? '')
      if (CJK.test(text)) hits.push({ line: lineOf(parsed, node), kind: SyntaxKind[node.kind]!, text })
    }
    node.forEachChild(visit)
  }
  visit(parsed)
  return hits
}

/** The 1-based line of a node, for a message a human can act on. */
function lineOf(source: SourceFile, node: Node): number {
  // `getStart(source)` skips leading trivia, so the line reported is the
  // literal's own — not a comment's above it.
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

/** Parse one on-disk file through the shared session. */
function parseFile(fileName: string): SourceFile {
  const parsed = program.getSourceFile(fileName)
  if (parsed === undefined) throw new Error(`the inferred project did not parse ${fileName}`)
  return parsed
}

describe('the CJK scanner itself (the guard against a vacuously green file)', () => {
  it('matches the CJK the range claims to cover, and nothing else', () => {
    // Real characters, one per range the header lists: Unified Ideographs,
    // Extension A, Compatibility Ideographs, Extension B (astral) and C–F.
    for (const sample of ['中', '华', '㐀', '豈', '\u{20000}', '\u{2a700}']) {
      expect(CJK.test(sample), `expected ${JSON.stringify(sample)} to be CJK`).toBe(true)
    }
    // The negative side is just as load-bearing: English, digits, punctuation
    // and the technical tokens this page is full of must NOT trip the guard.
    // The last four are the deliberate exclusions named in the header — if one
    // of them ever starts matching, the range grew without the header changing.
    for (const sample of ['Cherry Studio Bridge', 'scope.saveFailed', '{revision}', '…', '—', '、', '。', '　']) {
      expect(CJK.test(sample), `expected ${JSON.stringify(sample)} NOT to be CJK`).toBe(false)
    }
  })

  it('sees all three scanned kinds and ignores Chinese that only lives in a comment', () => {
    // A REAL file on disk, not a synthetic string: `ui/src/i18n.ts` is the one
    // file that contains all of it at once — Chinese string VALUES, Chinese
    // prose in `//` comments and in the module docblock, and `t('…')` spellings
    // inside those comments. Its counts are asserted as "greater than", not as
    // exact numbers, so editing the copy cannot break this scanner test.
    const hits = cjkTokens(parseFile('ui/src/i18n.ts'))

    // 96 today; the floor is what matters, so a comment-only reformat cannot
    // fail this while a broken walk (0 hits) fails loudly.
    expect(hits.length).toBeGreaterThan(50)
    expect(hits.every((hit) => hit.kind === 'StringLiteral')).toBe(true)

    // THE COMMENT CHECK, stated as the property rather than as an anecdote:
    // every hit's line, read back from the source, contains a quoted literal.
    // The docblock's own line (`It is the only place Chinese literals live …`)
    // and the `wizard.hint.*` prose must NOT appear among them.
    const lines = readFileSync(join(UI_SRC, 'i18n.ts'), 'utf8').split('\n')
    for (const hit of hits) {
      expect(lines[hit.line - 1], `line ${hit.line} of i18n.ts`).toMatch(/['"`]/)
    }
    expect(hits.some((hit) => /hint|comment|唯一/.test(hit.text))).toBe(false)
  })
})

describe('§8.1⑥: no Chinese literal in ui/src outside the dictionary', () => {
  it('scans the whole ui/src tree rather than a named file list', () => {
    for (const file of [
      'ui/src/App.tsx',
      'ui/src/DeviceCard.tsx',
      'ui/src/PairingWizard.tsx',
      'ui/src/ToolScopePanel.tsx',
      'ui/src/types.ts',
      'ui/src/main.tsx',
      // The three grey-area files the brief names: currently CJK-free, and
      // exactly the ones a named list would stop guarding.
      'ui/src/api.ts',
      'ui/src/dev.tsx',
      'ui/src/vite-env.d.ts',
      // ...and the whitelisted dictionary, which is only meaningful if it is IN
      // the scanned set: excluding it from the walk would be a different (and
      // weaker) claim than whitelisting it.
      'ui/src/i18n.ts',
    ]) {
      expect(sources, `${file} must be in the scan`).toContain(file)
    }
  })

  it('has no CJK string literal or JSX text anywhere outside the whitelist', () => {
    const offenders: string[] = []
    for (const file of sources) {
      if (CJK_WHITELIST.includes(file)) continue
      for (const hit of cjkTokens(parseFile(file))) {
        // Reported as `file:line  kind  "text"` — the exact line, because the
        // fix is to move that sentence into `i18n.ts` and call `t()`.
        offenders.push(`${file}:${hit.line}  ${hit.kind}  ${JSON.stringify(hit.text)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the whitelist down to the one dictionary file', () => {
    // The whitelist is the whole risk of this file: widening it silently is how
    // a CJK guard dies. Pinned content-for-content, and asserted to be a real
    // subset of the scan (a whitelist entry naming a file nobody scans would be
    // a no-op that looks like a safeguard).
    expect(CJK_WHITELIST).toEqual(['ui/src/i18n.ts'])
    for (const file of CJK_WHITELIST) expect(sources).toContain(file)
  })

  it('finds no CJK inside `ui/src/types.ts` — the label tables re-export the dictionary', () => {
    // §4.5's ruling, asserted where it is easy to regress: `STAGE_LABELS` /
    // `STATE_LABELS` are `dictionaries.zh['…']` lookups, NOT a second copy of
    // the Chinese. A literal creeping back into those tables is exactly the
    // "Chinese that never entered the dictionary" this file exists to catch.
    expect(cjkTokens(parseFile('ui/src/types.ts'))).toEqual([])
  })

  it('parses every scanned file (so the green result is a scanned result)', () => {
    // A guard against the failure mode where the walk silently skipped files:
    // the scan set and the parsed set must be the same list, not merely the same
    // size by coincidence.
    const parsed = sources.map((file) => parseFile(file).fileName.replace(`${repoRoot}/`, ''))
    expect([...parsed].sort()).toEqual(sources)
    expect(sources.length).toBeGreaterThanOrEqual(9)
  })
})
