import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { DeviceStore } from '../../src/deviceStore.js'
import { registerCherryTools } from '../../src/tools.js'
import type { CherryToolDefinition, CherryToolsContext } from '../../src/tools.js'

/**
 * The tool face's DEVICE-SELECTOR contract, kept in sync with what
 * `DeviceStore.resolve` actually does.
 *
 * `resolve()` matches an exact `deviceId` first, then the UNION of `deviceId`
 * prefixes and display-name prefixes, and answering with 0 / 1 / many matches
 * yields `{notFound:true}` / the record / `{ambiguous:[...]}`. Before #19 the
 * tools documented only a display-name prefix, and v0.1.3's UltraReview found
 * 13 of the 14 tool schemas still saying so while `cherry_devices` (the one
 * #19 had already updated) said the new thing. A doc that under-describes the
 * selector is not cosmetic: a caller holding a truncated `deviceId` is told
 * its selector is unsupported, and a caller holding a display name is told it
 * is.
 *
 * TWO ARMS, because the two faces fail differently:
 *
 *  1. REGISTRY — the compiled schemas the HOST receives. Every `cherry_*`
 *     tool declares exactly one `device` string parameter, and its description
 *     must contain the one canonical selector clause. This is the behavioral
 *     arm: a tool added tomorrow without the clause fails here.
 *  2. SOURCE — the retired sentence must be GONE from `src/tools.ts`
 *     (count 0) and the canonical clause must appear 14 times. The registry
 *     arm alone cannot see a second, dormant copy of the old sentence inside a
 *     description the registry still happens to compile past (e.g. a doc
 *     comment, or the unpair top-level description, which is NOT the `device`
 *     parameter's description), so the raw text is pinned too.
 *
 * COUNT DISCLAIMER for arm 2: 14 is what the raw text contains, and it
 * decomposes as 12 repaired PARAMETER descriptions (11 single-line plus
 * `cherry_unpair`'s multi-line block) + `cherry_devices`' own parameter
 * description, already written in the new form by #19 + `cherry_unpair`'s
 * TOP-LEVEL description clause (:2930). The top-level clause counts here
 * because this arm is a literal substring count over the whole file — prose
 * that contains the same clause is text like any other, and letting it drift
 * silently is exactly what this arm is for. The registry arm below pins the
 * PARAMETER descriptions independently (a tool whose `device` parameter lost
 * its description fails there), so the two arms cover different faces and the
 * counts are not expected to agree.
 */

/** The canonical selector clause. Every `device` parameter must contain it. */
const CANONICAL_CLAUSE = 'exact deviceId, or a unique prefix of a deviceId or display name'

/** The retired #19-preceding sentence, which must survive nowhere. */
const RETIRED_SENTENCE = 'exact deviceId, or a unique display-name prefix'

/**
 * How many times the canonical clause appears in `src/tools.ts`: 12 repaired
 * parameter descriptions + `cherry_devices` + the unpair top-level clause.
 * See the file comment for the counting method (literal occurrences).
 */
const CANONICAL_OCCURRENCES_IN_SOURCE = 14

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The 13 tools that TAKE a device selector. `cherry_pair` is the one member of
 * the 14-tool registry without a `device` parameter — it receives pairing
 * information, not a target — so it is excluded by name rather than folded in.
 */
const SELECTOR_TOOLS = [
  'cherry_devices',
  'cherry_agents',
  'cherry_workspaces',
  'cherry_sessions',
  'cherry_read',
  'cherry_events',
  'cherry_create',
  'cherry_send',
  'cherry_wait',
  'cherry_interactions',
  'cherry_respond',
  'cherry_cancel',
  'cherry_unpair',
] as const

/** The full registry, wired exactly as `toolSchemas.test.ts` wires it. */
function registerAll(): CherryToolDefinition[] {
  const definitions: CherryToolDefinition[] = []
  const ctx: CherryToolsContext = {
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
  }
  registerCherryTools(ctx, {
    store: new DeviceStore('/nonexistent/devices.json'),
    connect: () => {
      throw new Error('the doc-sync suite never connects')
    },
    subs: () => {
      throw new Error('the doc-sync suite never subscribes')
    },
    pair: async () => {
      throw new Error('the doc-sync suite never pairs')
    },
    evict: () => {
      throw new Error('the doc-sync suite never evicts')
    },
  })
  return definitions
}

/** Whether this tool declares a `device` parameter at all. */
function hasSelector(definition: CherryToolDefinition): boolean {
  return 'device' in definition.parameters.properties
}

/** The `device` parameter's description, or `undefined` when it has none. */
function deviceDescription(definition: CherryToolDefinition): string | undefined {
  const parameter = definition.parameters.properties['device'] as { description?: string } | undefined
  return parameter?.description
}

function sourceText(): string {
  return readFileSync(resolve(repoRoot, 'src', 'tools.ts'), 'utf8')
}

/** Occurrences of a literal substring, non-overlapping. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('the device selector is documented as DeviceStore.resolve actually behaves', () => {
  it('every selector tool describes the full selector, and no other tool has one', () => {
    const definitions = registerAll()
    // The registry arm is worthless if it silently matched nothing.
    expect(definitions.length).toBeGreaterThanOrEqual(14)
    // Filter on the PARAMETER'S PRESENCE, not on its description: a
    // `device: { type: 'string' }` with no description would slip past a
    // description-based filter as "a tool without a selector" and its missing
    // doc would never be reported. Presence selects the tools; the assertions
    // below then require a description from every one of them.
    const withSelector = definitions.filter(hasSelector).map((definition) => definition.name).sort()
    expect(withSelector).toEqual([...SELECTOR_TOOLS].sort())
    const undescribed = definitions.filter(
      (definition) => hasSelector(definition) && deviceDescription(definition) === undefined,
    )
    expect(
      undescribed.map((definition) => definition.name),
      'selector tools whose `device` parameter has NO description',
    ).toEqual([])
    const missing = definitions
      .filter(hasSelector)
      .map((definition) => `${definition.name}: ${deviceDescription(definition)}`)
      .filter((line) => !line.slice(line.indexOf(': ') + 2).includes(CANONICAL_CLAUSE))
    expect(missing, 'parameters still describe the pre-#19 selector').toEqual([])
  })

  it('no tool description anywhere in the registry keeps the retired sentence', () => {
    const offenders = registerAll().filter((definition) =>
      JSON.stringify(definition).includes(RETIRED_SENTENCE),
    )
    expect(offenders.map((definition) => definition.name)).toEqual([])
  })

  it('src/tools.ts carries the retired sentence zero times and the canonical clause 14 times', () => {
    const source = sourceText()
    expect(countOf(source, RETIRED_SENTENCE)).toBe(0)
    expect(countOf(source, CANONICAL_CLAUSE)).toBe(CANONICAL_OCCURRENCES_IN_SOURCE)
  })
})
