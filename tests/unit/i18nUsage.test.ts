/**
 * §8.1③ — KEY REFERENCE INTEGRITY: every key the page uses exists, and every key
 * it ships is used.
 *
 * A dictionary rots in two directions and they fail differently:
 *
 *  - **A missing key is loud but late.** `t()` returns the key itself (§6.1), so
 *    `scope.typo.here` renders on the page as `scope.typo.here`. A human sees it;
 *    no test does. This file is the test that sees it.
 *  - **A dead key is silent forever.** A key nobody references is copy that
 *    still gets translated, reviewed and shipped — and the next person edits a
 *    sentence that no longer appears anywhere.
 *
 * ## The usage universe (deliberately wider than "the `t(` call sites")
 *
 * Three sources count as a reference, and all three are needed:
 *
 *  1. **`t('…')` literals anywhere in `ui/src/**\/*.{ts,tsx}`** — scanned
 *     TEXTUALLY, in ANY position (see {@link SCAN_PATTERN}).
 *  2. **`Object.values(STAGE_KEYS)` / `Object.values(STATE_KEYS)`** — the two
 *     key tables in `ui/src/types.ts`. `DeviceCard` renders
 *     `t(STATE_KEYS[state] ?? state)` and `PairingWizard` renders
 *     `t(STAGE_KEYS[stage] ?? stage)`: the key is chosen DYNAMICALLY, so no
 *     literal for those ten + ten keys exists anywhere. Reading the tables
 *     themselves is what makes them referenced.
 *  3. **`Object.values` of `ToolScopePanel`'s own key tables** —
 *     `DEGRADED_KEYS`, `SAVE_FAILURE_KEYS`, and the four module-level `*_KEY`
 *     constants (`SAVE_FAILED_KEY`, `SELECTED_EMPTY_KEY`, `GLOBAL_EMPTY_KEY`,
 *     `EFFECT_NOTE_KEY`). Same reason: `t(DEGRADED_KEYS[note.source] ?? …)` and
 *     `t(SAVE_FAILURE_KEYS[code] ?? …)` resolve the key at runtime.
 *
 * `ui/src/i18n.ts` is EXCLUDED from the reference scan — not as a courtesy, but
 * because it is where the dictionary is declared. Its `dictionaries.zh['k']`
 * lookups (in the label tables) and the `t('…')` spellings inside its comments
 * are not consumers; counting them would make the reverse direction vacuous
 * (every key would reference itself).
 *
 * ## Why the scan is textual rather than AST-based
 *
 * The forward direction is "would this key resolve at runtime?", and the honest
 * answer for a `t(` argument is textual: `t(STATE_KEYS[state] ?? state)` passes
 * no literal at all, while `str.replace('{revision}', '7')` in a TEST contains
 * the shapes `{revision}` that a template-literal scan would have to reason
 * about. The scanner reads one thing — quoted keys written next to `t(` — and
 * the mandatory positive control below proves it sees them in ARGUMENT position
 * (`join(t('list.separator'))`), which a line-anchored pattern silently misses.
 *
 * This file imports `ui/src/**` (the KEYS tables), so it belongs to the UI
 * tsconfig project: it is named in `tsconfig.ui.json`'s `include` AND in
 * `tsconfig.json`'s `exclude`, or
 * `tests/unit/projectCoverage.test.ts` fails on the partition.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { dictionaries } from '../../ui/src/i18n'
import { STAGE_KEYS, STATE_KEYS } from '../../ui/src/types'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const UI_SRC = join(repoRoot, 'ui', 'src')

/** The one file the reference scan skips: the dictionary's own declaration. */
const DICTIONARY_FILE = 'i18n.ts'

/**
 * THE SCANNER: `t(` followed by a single-, double- or back-quoted literal.
 *
 * What it deliberately does NOT do:
 *
 *  - **No line anchoring, no `^`, no statement shape.** The occurrence the brief
 *    names (`saved.pruned.join(t('list.separator'))`) is an ARGUMENT to `.join`,
 *    on a line that starts with `: t('scope.savedPruned', …)`. A pattern written
 *    as "a statement that is exactly a `t('…')` call" — `/^\s*t\(/m`, or one
 *    that requires `;`/`)` right after the closing quote — matches the two
 *    standalone calls and misses that one, so the separator would look dead.
 *    `SCAN_PATTERN` has no anchor and no lookahead for statement position.
 *  - **No JSX restriction.** `{t('app.title')}` is the same call with a `{` in
 *    front of it; the `t(` is what is matched.
 *  - **No `global` flag on the shared constant.** `String.prototype.match` with
 *    a `/g` regex returns the matched STRINGS without capture groups, which is
 *    exactly how the positive control below reads the key back out.
 *
 * The two boundaries are what make it a scanner for `t` rather than for the
 * letter `t`, and both were needed on the real tree:
 *
 *  - **`(?<![\w$.])`** — the call must not be a PROPERTY access or the tail of a
 *    longer identifier. Without it, `ctx.get('locale')` and
 *    `createElement('style')` match on their trailing `t(`, and this guard
 *    reports two "keys" (`locale`, `style`) that no dictionary could ever hold.
 *    Excluding `.` is what keeps the check on the callee name: `x.t('k')` is not
 *    this page's translator.
 *  - **`\b` after `t`** is implied by the `(` that follows.
 *
 * The character class for the key is `[A-Za-z0-9_.-]`: every key in this
 * dictionary is dot-separated lowercase words, and `${…}`-interpolated keys
 * (the dynamic-lookup form) are correctly NOT matched — those are covered by the
 * key-table universe above, never by a literal.
 */
const SCAN_PATTERN = /(?<![\w$.])t\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g

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

/** The keys a source file references through `t('…')`, in file order. */
function literalKeys(text: string): string[] {
  return [...text.matchAll(SCAN_PATTERN)].map((match) => match[2]!)
}

/**
 * The module-level `*_KEY(S)` tables in `ToolScopePanel.tsx`, recovered from the
 * source because they are deliberately NOT exported.
 *
 * The panel's dynamic consumers are `t(SAVE_FAILURE_KEYS[code] ?? SAVE_FAILED_KEY)`,
 * `t(DEGRADED_KEYS[note.source] ?? note.source)`, `t(GLOBAL_EMPTY_KEY)` and
 * friends: the key is chosen at RUNTIME, so no `t('…')` literal for those
 * sentences exists in the tree. The ruling is that their VALUES count as usage,
 * and the tables are module-PRIVATE (`const`, no `export`), so importing them is
 * not an option — widening the module's public surface for a test would be the
 * worse trade. They are read here as source text.
 *
 * The pattern is deliberately narrow: a `const NAME = {` block or a single
 * `const NAME = 'literal'` line, where NAME contains `KEY`, followed by the
 * quoted string values inside it. A key literal is `[A-Za-z0-9_.-]+` with at
 * least one dot, which is what distinguishes `'scope.degraded.install'` (a
 * dictionary key) from the `'install'`/`'workspace-list'` object KEYS beside it
 * — those are `DegradedSource` values, not dictionary keys, and counting them
 * would make the forward direction pass for the wrong reason.
 */
function keyTableValues(text: string): string[] {
  const values = new Set<string>()
  // `const DEGRADED_KEYS: Record<…> = { … }` (multi-line) and
  // `const SAVE_FAILED_KEY = 'scope.saveFailed'` (single line).
  const declaration = /const\s+(\w*KEY\w*)\s*(?::[^=]+)?=\s*(\{[^}]*\}|'[^']*')/g
  for (const match of text.matchAll(declaration)) {
    for (const literal of match[2]!.matchAll(/'([^']*)'/g)) {
      // A dictionary key is dotted and flat; the object keys it maps from (a
      // `DegradedSource` or a server refusal code) are not.
      if (literal[1]!.includes('.')) values.add(literal[1]!)
    }
  }
  return [...values]
}

/**
 * Every key referenced anywhere in `ui/src`, minus the dictionary's own file.
 *
 * Read through the filesystem rather than the module graph on purpose: the point
 * is to cover `ui/src/**` that NO test imports (`dev.tsx`, `api.ts`,
 * `vite-env.d.ts`), which an import-based universe could never reach.
 */
const sources = collectSources()
const referenced = new Set<string>()
const tableKeys = new Set<string>([
  ...Object.values(STAGE_KEYS),
  ...Object.values(STATE_KEYS),
])
for (const file of sources) {
  if (file.endsWith(`/${DICTIONARY_FILE}`)) continue
  const text = readFileSync(join(repoRoot, file), 'utf8')
  for (const key of literalKeys(text)) referenced.add(key)
  for (const key of keyTableValues(text)) tableKeys.add(key)
}

/** The union §8.1③ calls the usage universe. */
const universe = new Set<string>([...referenced, ...tableKeys])

const dictKeys = Object.keys(dictionaries.zh)

describe('the scanner itself (the guard against a vacuously green file)', () => {
  it('finds `t(` literals in ARGUMENT position, not only as standalone statements', () => {
    // THE MANDATORY POSITIVE CONTROL (brief Step 1). This is the exact shape the
    // source uses — `saved.pruned.join(t('list.separator'))` — embedded in a
    // synthetic line that is NOT a statement of its own: it begins mid-call, the
    // `t(` sits inside another call's argument list, and the line ends with `),`.
    // A line-anchored or statement-shaped pattern returns `[]` here, which is
    // what makes this assertion the proof that the real scan cannot silently
    // miss the separator.
    const line = "              : t('scope.savedPruned', { list: saved.pruned.join(t('list.separator')) }),"
    expect(line.match(SCAN_PATTERN)).toEqual(["t('scope.savedPruned'", "t('list.separator'"])
    // ...and the key is recoverable from that match, not merely the string.
    expect([...line.matchAll(SCAN_PATTERN)].map((match) => match[2])).toEqual([
      'scope.savedPruned',
      'list.separator',
    ])

    // The counter-example that states the trap: the same line, scanned with an
    // anchored "standalone statement" pattern. It finds NOTHING, so a scanner
    // written that way would report `list.separator` as dead.
    expect(line.match(/^\s*t\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g)).toBeNull()
    // ...while a genuinely standalone call IS what such a pattern matches, which
    // is why the trap is invisible on a first glance at the source.
    expect("  t('scope.save')".match(/^\s*t\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g)).toEqual(["  t('scope.save'"])
  })

  it('does not mistake a property access ending in `t` for a `t()` call', () => {
    // The two false positives this tree actually produced, each a real line:
    // `ctx.get('locale')` and `document.createElement('style')`. Both end in
    // `t(`, and a bare `/t\(…/` reads them as dictionary keys `locale` and
    // `style` — neither of which exists, so the FORWARD direction would fail on
    // correct source. Pinned as a control so the boundary cannot be dropped.
    const getLine = "    const service = ctx.get('locale')"
    expect(getLine.match(SCAN_PATTERN)).toBeNull()
    expect("  const node = document.createElement('style')".match(SCAN_PATTERN)).toBeNull()
    // ...while the bare pattern DOES match them, which is the whole point: the
    // negative cases above are only meaningful because the naive pattern fails them.
    expect([...getLine.matchAll(/t\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g)].map((match) => match[2])).toEqual(['locale'])
    // A method named `t` on some object is not this page's translator either:
    // the usage universe is the COMPONENTS' `t`, reached as a bare identifier.
    expect("  foo.t('app.title')".match(SCAN_PATTERN)).toBeNull()
  })

  it('scans the whole ui/src tree, not a named file list', () => {
    // §8.1⑥'s ruling applies to the usage scan too: a named list does not guard
    // the grey-area files. Named one by one so a dropped file is reported by
    // name rather than as a count.
    for (const file of [
      'ui/src/App.tsx',
      'ui/src/DeviceCard.tsx',
      'ui/src/PairingWizard.tsx',
      'ui/src/ToolScopePanel.tsx',
      'ui/src/main.tsx',
      'ui/src/types.ts',
      'ui/src/api.ts',
      'ui/src/dev.tsx',
      'ui/src/vite-env.d.ts',
    ]) {
      expect(sources, `${file} must be in the scan`).toContain(file)
    }
    expect(sources.some((file) => file.endsWith('/i18n.ts'))).toBe(true)
  })

  it('ignores the dictionary file, so the reverse direction is not self-satisfying', () => {
    // `i18n.ts` mentions `t('wizard.hint.before')` inside a comment and looks up
    // `dictionaries.zh['…']` in the label tables. Counting those as consumers
    // would make "every key is referenced" true by construction.
    expect(referenced.has('wizard.hint.qrCode')).toBe(true) // via the components
    const i18nOnlyKeys = literalKeys(readFileSync(join(UI_SRC, DICTIONARY_FILE), 'utf8'))
    expect(i18nOnlyKeys.length).toBeGreaterThan(0) // the file does contain such spellings
    for (const key of i18nOnlyKeys) {
      expect(dictKeys, `i18n.ts must not be the only reference to ${key}`).toContain(key)
    }
  })
})

describe('§8.1③: every referenced key exists in the dictionary', () => {
  it('resolves every `t(…)` literal in ui/src against the zh dictionary', () => {
    const missing = [...referenced].filter((key) => !(key in dictionaries.zh)).sort()
    // Reported as a LIST rather than a count: a bare key on screen is the
    // failure mode, so the failure message names the key that would render as
    // itself.
    expect(missing).toEqual([])
  })

  it('resolves every key-table value against the zh dictionary', () => {
    const missing = [...tableKeys].filter((key) => !(key in dictionaries.zh)).sort()
    expect(missing).toEqual([])
    // The dynamic universe is not empty: a table that lost its entries would
    // make the assertion above trivially true.
    expect(tableKeys.size).toBeGreaterThanOrEqual(28)
  })

  it('produces a translation for every referenced key, in both locales', () => {
    for (const key of universe) {
      // `createTranslator` returns the KEY on a miss, so an exact inequality is
      // the same statement as "the key resolves" — checked through the public
      // contract rather than the dictionary shape.
      expect(dictionaries.zh[key], `zh["${key}"]`).toBeTypeOf('string')
      expect(dictionaries.en[key], `en["${key}"]`).toBeTypeOf('string')
      expect(dictionaries.zh[key]).not.toBe('')
    }
  })
})

describe('§8.1③: every dictionary key is referenced at least once', () => {
  it('has no dead key in either locale', () => {
    const dead = dictKeys.filter((key) => !universe.has(key)).sort()
    // A dead key is copy that still gets translated and reviewed while nothing
    // renders it. The fix is to delete it from BOTH dictionaries (parity is
    // asserted by `tests/unit/i18n.test.ts`), or to reference it.
    expect(dead).toEqual([])
  })

  it('accounts for the whole dictionary through the union of the three sources', () => {
    // The same statement in coverage form, so a failure says HOW MUCH is
    // unreferenced and a pass says the union really spans the dictionary.
    const covered = dictKeys.filter((key) => universe.has(key))
    expect(covered.length).toBe(dictKeys.length)
    expect(dictKeys.length).toBeGreaterThan(50)
    // The union is not accidentally the whole dictionary: the dynamic tables
    // carry keys that no literal spells, and both halves are non-trivial.
    expect([...tableKeys].filter((key) => !referenced.has(key)).length).toBeGreaterThan(0)
    expect([...referenced].filter((key) => !tableKeys.has(key)).length).toBeGreaterThan(0)
  })
})
