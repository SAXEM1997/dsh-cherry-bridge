import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHERRY_TOOL_NAMES } from '../../src/tools.js'
import { CHERRY_SUBAGENT_TOOL_DEFAULT } from '../../src/defaults.js'

/**
 * The tool COUNT is stated in prose in a dozen places, and every time the
 * family grew the sweep missed some of them: #381 added `cherry_tasks` and left
 * "fourteen" in a test comment, "the fifteenth" on the delegation tool's own
 * docblock, and the wrong ordinal in both READMEs — twice, because #385 and #387
 * each found more. Remembering to grep is not a mechanism.
 *
 * So this file IS the mechanism. It derives the numbers from the registry and
 * refuses the words that go stale when a tool is added:
 *
 *   - `spell(FAMILY - 1)` — the count as it was before the newest tool, e.g.
 *     "fourteen" while the family is fifteen;
 *   - `ordinal(FAMILY - 1)` and `ordinal(REGISTRY - 1)` — the rank a tool held
 *     before the newest one arrived, e.g. "fifteenth" for the delegation tool;
 *   - the same stale count in its Chinese digit form (`14 个工具`, `14 个
 *     \`cherry_*\``), which is how the READMEs state totals.
 *
 * WHAT THIS CANNOT SEE, stated so a green run is not mistaken for proof:
 * English counts written in DIGITS (`14 tools` legitimately means the fourteen
 * that take a `device` selector — a different quantity `toolDeviceDocSync`
 * owns, and why digits are not policed here), Chinese numerals (`十五`), and
 * anything older than ONE generation (adding two tools at once leaves the
 * previous count's word unused — the README pair below catches that case
 * instead, because it demands the exact current strings).
 *
 * WHAT IS SCANNED — every document that describes the CURRENT state, plus every
 * source and test file (comments included). WHAT IS NOT: `CHANGELOG.md` and
 * `docs/superpowers/**` (release history and process records — rewriting a past
 * observation to satisfy a count is the opposite of the point), and
 * `docs/e2e-checklist.md`, which mixes dated walk rows with live procedure
 * steps: its live step was corrected by hand in #389 and can drift again, since
 * no check reads that file.
 */
const FAMILY = CHERRY_TOOL_NAMES.length
const REGISTRY = FAMILY + 1

const SPELLED = [
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'twenty-one',
  'twenty-two',
  'twenty-three',
  'twenty-four',
] as const

const ORDINALS = [
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
  'fifteenth',
  'sixteenth',
  'seventeenth',
  'eighteenth',
  'nineteenth',
  'twentieth',
  'twenty-first',
  'twenty-second',
  'twenty-third',
  'twenty-fourth',
] as const

/** The spelled form of a count, or `undefined` past the table. */
function spell(count: number): string | undefined {
  return SPELLED[count - 10]
}

/** The ordinal word for a rank, or `undefined` past the table. */
function ordinal(rank: number): string | undefined {
  return ORDINALS[rank - 10]
}

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'lib' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path)
  }
  return out
}

function markdownIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(dir, name))
}

/** Current-state documents, then every source and test file. */
function scannedFiles(): string[] {
  const documents = [
    'README.md',
    'README.en.md',
    'AGENTS.md',
    'src/AGENTS.md',
    'tests/AGENTS.md',
    'ui/AGENTS.md',
  ].map((name) => join(ROOT, name))
  const code = [...walk(join(ROOT, 'src'), []), ...walk(join(ROOT, 'tests'), []), ...walk(join(ROOT, 'ui/src'), [])]
  // This file is the one place that has to SPELL the stale words to ban them.
  const self = join(ROOT, 'tests/unit/toolCountDocSync.test.ts')
  return [
    ...documents,
    ...markdownIn(join(ROOT, 'docs/adr')),
    ...markdownIn(join(ROOT, 'docs/agents')),
    ...code.filter((path) => path !== self),
  ]
}

function offenders(pattern: RegExp): string[] {
  return scannedFiles()
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(ROOT, path))
}

describe('the tool count stated in prose matches the registry', () => {
  it(`#389a knows the family is ${String(FAMILY)} and the registry ${String(REGISTRY)}`, () => {
    // A guard on the guard: if either number leaves the spelling table the
    // checks below would silently stop covering anything. Extend the table when
    // this fails; do not delete the case.
    expect(spell(FAMILY - 1), 'extend SPELLED').toBeDefined()
    expect(ordinal(FAMILY - 1), 'extend ORDINALS').toBeDefined()
    expect(ordinal(REGISTRY - 1), 'extend ORDINALS').toBeDefined()
    expect(CHERRY_SUBAGENT_TOOL_DEFAULT).toBe('cherry_subagent')
  })

  it('#389b states no count from before the newest tool', () => {
    const stale = spell(FAMILY - 1)
    expect(stale).toBeDefined()
    expect(offenders(new RegExp(`\\b${String(stale)}\\b`, 'i'))).toEqual([])
    // The same count in the digit form the Chinese docs use for totals.
    expect(offenders(new RegExp(`${String(FAMILY - 1)} 个(工具|\`?cherry_)`))).toEqual([])
  })

  it('#389c ranks the delegation tool where the registry actually puts it', () => {
    const stale = [ordinal(FAMILY - 1), ordinal(REGISTRY - 1)]
    for (const word of stale) {
      expect(word).toBeDefined()
      expect(offenders(new RegExp(`\\b${String(word)}\\b`, 'i'))).toEqual([])
    }
  })

  it('#389d spells both numbers in the README pair', () => {
    // This arm also catches a TWO-generation jump: it demands the exact current
    // strings, so any change to the count reddens it even when the banned words
    // above are unused.
    const zh = readFileSync(join(ROOT, 'README.md'), 'utf8')
    const en = readFileSync(join(ROOT, 'README.en.md'), 'utf8')
    expect(zh).toContain(`${String(FAMILY)} 个 \`cherry_*\` 工具`)
    expect(zh).toContain(`第 ${String(REGISTRY)} 个 \`${CHERRY_SUBAGENT_TOOL_DEFAULT}\``)
    expect(en).toContain(`${String(FAMILY)} \`cherry_*\` tools`)
    expect(en).toContain(`the ${String(ordinal(REGISTRY))}, \`${CHERRY_SUBAGENT_TOOL_DEFAULT}\``)
  })

  it('#389e reads the files it claims to read', () => {
    // A vacuity guard: `offenders` returning [] proves nothing if the scan is
    // empty or the root resolved somewhere else.
    const files = scannedFiles()
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((path) => path.endsWith('src/tools.ts'))).toBe(true)
    expect(files.some((path) => path.endsWith('AGENTS.md'))).toBe(true)
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toContain('cherry_subagent')
  })
})
