import { describe, expect, it } from 'vitest'
import { createCherrySubagentTool } from '../../src/subagentTool.js'
import type { CherryToolDefinition } from '../../src/tools.js'
import { properties, registerAll, toolOf } from '../helpers/cherryRegistry.js'

/**
 * Issue #219: every `parameters` schema stays inside the JSON Schema subset the
 * HOST enforces.
 *
 * `ctx.tools.register()` asserts `output.schema` through
 * `assertSupportedJsonSchema` and never looks at `parameters`
 * (`@deepseek-ai/dsh-tools@0.2.2-rc.1`, `lib/index.js:437`), so a parameter
 * schema may carry anything at all today. The subset it WOULD be judged by is
 * the one `checkSchemaNode` implements (`lib/shared-DTdn5dXO.js:177-341`):
 *
 *     type / oneOf / properties / required / additionalProperties / items /
 *     enum / const  —  plus the annotations description / title / default /
 *     examples
 *
 * Everything else is rejected: `minimum`, `maximum`, `maxLength`, and an
 * OBJECT-valued `additionalProperties`. None of them is implemented by the
 * host's value validator either (`checkValue`, `lib/shared-DTdn5dXO.js:396-536`
 * reads `additionalProperties` only as the literal `false`, and has no numeric
 * or length comparison anywhere) — so before this pin those annotations were
 * inert on both sides while carrying a trigger: the day any host site asserts
 * `parameters`, all eight schemas fail at once and the whole tool face
 * disappears.
 *
 * The rules live HERE, not in `src/`: the plugin carries no copy of the host's
 * subset, and this file is the spec it is measured against. `#219c` is what
 * keeps that transcription honest — a checker that returned `[]` for
 * everything would let `#219a` pass vacuously.
 *
 * The transcription was CROSS-CHECKED against the real function once
 * (2026-11-05), because a transcription can only be as right as its reading:
 * driving `assertSupportedJsonSchema` from the installed
 * `@deepseek-ai/dsh-tools@0.2.2-rc.1` over this branch's fourteen schemas
 * accepts 14/14, and over `main`'s it rejects the same EIGHT tools with the
 * same NINETEEN keyword paths this file reports. That check needs the host
 * package on disk, so it is deliberately not part of the suite; the
 * transcription is the arm that runs everywhere.
 *
 * Two rules of `checkSchemaNode` are deliberately NOT transcribed, both
 * because they cannot fire on a declaration a human writes as a literal:
 * the circular-reference guard, and the lossless-JSON check on annotation
 * values (every annotation here is a string literal).
 */

// ---------------------------------------------------------------------------
// The host's subset, transcribed
// ---------------------------------------------------------------------------

const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])

const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])

/** Keywords that are invalid beside `oneOf`, and invalid without `type`. */
const ONE_OF_SIBLING_KEYWORDS = [
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
] as const

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null'] as const

/** Which schema type each non-`type` constraint keyword is legal on. */
const KEYWORD_TYPES: Readonly<Record<string, readonly string[]>> = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: SCALAR_TYPES,
  const: SCALAR_TYPES,
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scalarMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return false
  }
}

/**
 * Every way `schema` falls outside the host's enforced subset, path-qualified.
 *
 * The PATHS are the contract — which node is outside the subset, and which
 * keyword put it there. The diagnostic wording is transcribed verbatim where
 * this file carries the rule, but it is not itself mirrored: the host's
 * `JsonSchemaError` message format is not something a plugin should pin.
 */
function subsetViolations(schema: unknown, path = 'parameters'): string[] {
  if (!isPlainRecord(schema)) return [`${path} must be a schema object`]

  const violations: string[] = []
  for (const key of Object.keys(schema)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue
    violations.push(
      `${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/` +
        'additionalProperties/items/enum/const + annotations)',
    )
  }
  for (const key of ['description', 'title']) {
    if (Object.hasOwn(schema, key) && typeof schema[key] !== 'string') {
      violations.push(`${path}.${key} must be a string`)
    }
  }

  const hasType = Object.hasOwn(schema, 'type')
  const hasOneOf = Object.hasOwn(schema, 'oneOf')
  if (hasType && hasOneOf) return [...violations, `${path} cannot declare both type and oneOf`]
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(schema, key)) violations.push(`${path}.${key} requires type or oneOf`)
    }
    return violations
  }

  if (hasOneOf) {
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(schema, key)) violations.push(`${path}.${key} is not supported beside oneOf`)
    }
    const oneOf = schema['oneOf']
    if (!Array.isArray(oneOf) || oneOf.length < 2) {
      violations.push(`${path}.oneOf must be an array of at least two schemas`)
    } else {
      oneOf.forEach((branch, index) => {
        violations.push(...subsetViolations(branch, `${path}.oneOf[${index}]`))
      })
    }
    return violations
  }

  const type = schema['type']
  if (typeof type !== 'string' || !(SCHEMA_TYPES as readonly string[]).includes(type)) {
    return [
      ...violations,
      Array.isArray(type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`,
    ]
  }
  for (const [key, types] of Object.entries(KEYWORD_TYPES)) {
    if (Object.hasOwn(schema, key) && !types.includes(type)) {
      violations.push(`${path}.${key} is not supported on type "${type}"`)
    }
  }

  if (type === 'object') {
    const properties = schema['properties']
    const declared = isPlainRecord(properties) ? properties : {}
    if (Object.hasOwn(schema, 'properties')) {
      if (!isPlainRecord(properties)) {
        violations.push(`${path}.properties must be an object of schemas`)
      } else {
        for (const [key, child] of Object.entries(properties)) {
          violations.push(...subsetViolations(child, `${path}.properties.${key}`))
        }
      }
    }
    if (Object.hasOwn(schema, 'required')) {
      const required = schema['required']
      if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
        violations.push(`${path}.required must be an array of strings`)
      } else {
        for (const key of required) {
          if (!Object.hasOwn(declared, key)) {
            violations.push(`${path}.required names "${key}" which is not in properties`)
          }
        }
      }
    }
    if (Object.hasOwn(schema, 'additionalProperties') && typeof schema['additionalProperties'] !== 'boolean') {
      violations.push(`${path}.additionalProperties must be a boolean`)
    }
    return violations
  }

  if (type === 'array') {
    if (Object.hasOwn(schema, 'items')) violations.push(...subsetViolations(schema['items'], `${path}.items`))
    return violations
  }

  const enumValues = schema['enum']
  const enumValid =
    Array.isArray(enumValues) && enumValues.length > 0 && enumValues.every((entry) => scalarMatches(type, entry))
  if (Object.hasOwn(schema, 'enum') && !enumValid) {
    violations.push(`${path}.enum must be a non-empty array of ${type} values`)
  }
  if (Object.hasOwn(schema, 'const') && !scalarMatches(type, schema['const'])) {
    violations.push(`${path}.const must be a ${type} value`)
  }
  if (
    Object.hasOwn(schema, 'const') &&
    scalarMatches(type, schema['const']) &&
    enumValid &&
    !(enumValues as unknown[]).includes(schema['const'])
  ) {
    violations.push(`${path}.const must be one of ${path}.enum when both are declared`)
  }
  return violations
}

// ---------------------------------------------------------------------------
// The registry under test
// ---------------------------------------------------------------------------

/**
 * The FIFTEENTH tool: `cherry_subagent`, registered by the subagent subsystem
 * rather than by `registerCherryTools` (issue #232).
 *
 * It is checked here because the subset is a property of the host, not of which
 * subsystem happens to declare a schema — and this is the one tool whose
 * parameters were written after the pin, which is exactly when a forbidden
 * keyword (`maxLength` on `prompt`, say) is tempting.
 */
function subagentTool(): CherryToolDefinition {
  return createCherrySubagentTool({
    providerName: 'cherry',
    resolveDevice: () => 'desk-1',
    startActivation: async () => ({ childId: 'child' }),
  })
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('issue #219: the host-enforced JSON Schema subset', () => {
  it('#219a: every one of the sixteen parameter schemas is inside the subset', () => {
    const definitions = [...registerAll(), subagentTool()]
    // Anchor: the loop must actually walk the whole registry, so a silently
    // emptied fixture cannot pass this by having nothing to check. Sixteen, not
    // fifteen: the delegation tool's schema is judged by the same host.
    expect(definitions).toHaveLength(16)
    // One flat assertion, not one per tool: a red run then names EVERY offending
    // tool at once, which is the whole point of the pin (they fail together).
    const violations = definitions.flatMap((definition) =>
      subsetViolations(definition.parameters, `${definition.name}.parameters`),
    )
    expect(violations).toEqual([])
  })

  it('#219d: every one of the sixteen OUTPUT schemas is inside the subset too', () => {
    // The host asserts `output.schema` through the SAME checker, at the SAME
    // call site (`ctx.tools.register`, `lib/index.js:437`) — and it does so
    // BEFORE `parameters` is ever looked at. Issue #232 shipped a tool whose
    // output schema used the AUTHORING dialect (`required: true` on a string
    // property, which `defineTool` compiles away) and the host rejected the
    // registration outright: the tool never existed, and every test was green
    // because no fixture validates. This is the interceptor.
    const definitions = [...registerAll(), subagentTool()]
    expect(definitions).toHaveLength(16)
    const violations = definitions.flatMap((definition) =>
      subsetViolations(definition.output.schema, `${definition.name}.output.schema`),
    )
    expect(violations).toEqual([])
  })

  it('#219b: the numbers that left the schema are still in the text a model reads', () => {
    // A bound the subset cannot carry is not dropped, it MOVES: the description
    // is what the model sees, so the promise has to survive there — and the
    // numbers are pinned LITERALLY, so moving one is a declaration change
    // rather than a refactor.
    const carried: ReadonlyArray<readonly [tool: string, property: string, promise: RegExp]> = [
      ['cherry_agents', 'limit', /min 1, max 1000; values outside that range are clamped/],
      ['cherry_workspaces', 'limit', /min 1, max 1000; values outside that range are clamped/],
      ['cherry_sessions', 'limit', /min 1, max 1000; values outside that range are clamped/],
      ['cherry_interactions', 'limit', /min 1, max 1000; values outside that range are clamped/],
      ['cherry_read', 'limit', /min 1, max 1000; values outside that range are clamped/],
      ['cherry_agents', 'cursor', /4096 characters is the ceiling/],
      ['cherry_workspaces', 'cursor', /4096 characters is the ceiling/],
      ['cherry_sessions', 'cursor', /4096 characters is the ceiling/],
      ['cherry_interactions', 'cursor', /4096 characters is the ceiling/],
      ['cherry_read', 'messagesResumeCursor', /4096 characters is the ceiling/],
      ['cherry_send', 'text', /At most 32768 characters/],
      ['cherry_send', 'timeoutMs', /a value below 1 is raised to 1/],
      ['cherry_wait', 'timeoutMs', /a value below 1 is raised to 1/],
      ['cherry_respond', 'response', /each value a string/],
    ]
    for (const [tool, property, promise] of carried) {
      const declaration = properties(toolOf(tool))[property]
      expect(declaration, `${tool}.${property} is not declared`).toBeDefined()
      const description =
        property === 'response'
          ? String((declaration!['properties'] as Record<string, Record<string, unknown>>)['answers']!['description'])
          : String(declaration!['description'])
      expect(description, `${tool}.${property} lost its bound`).toMatch(promise)
    }
  })

  it('#219c: the checker itself rejects every keyword the subset forbids', () => {
    // Negative controls. Without these, a checker that always answered `[]`
    // would make `#219a` green no matter what the schemas said.
    const rejected: ReadonlyArray<readonly [why: string, schema: unknown, needle: RegExp]> = [
      ['minimum', { type: 'integer', minimum: 1 }, /minimum is not a supported keyword/],
      ['maximum', { type: 'integer', maximum: 1000 }, /maximum is not a supported keyword/],
      ['maxLength', { type: 'string', maxLength: 4096 }, /maxLength is not a supported keyword/],
      [
        'object-valued additionalProperties',
        { type: 'object', additionalProperties: { type: 'string' } },
        /additionalProperties must be a boolean/,
      ],
      [
        'a nested violation',
        { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } } },
        /parameters\.properties\.limit\.minimum is not a supported keyword/,
      ],
      [
        'required outside properties',
        { type: 'object', properties: {}, required: ['device'] },
        /required names "device" which is not in properties/,
      ],
      ['a misplaced keyword', { type: 'string', properties: {} }, /properties is not supported on type "string"/],
      ['a type array', { type: ['string', 'null'] }, /type arrays are not supported/],
      [
        'oneOf beside type',
        { type: 'string', oneOf: [{ type: 'string' }, { type: 'integer' }] },
        /cannot declare both type and oneOf/,
      ],
      [
        'a oneOf sibling keyword',
        { oneOf: [{ type: 'string' }, { type: 'integer' }], properties: {} },
        /properties is not supported beside oneOf/,
      ],
      ['a one-element oneOf', { oneOf: [{ type: 'string' }] }, /at least two schemas/],
      ['a const of the wrong type', { type: 'string', const: 5 }, /const must be a string value/],
      [
        'a const outside its own enum',
        { type: 'string', enum: ['a'], const: 'b' },
        /const must be one of parameters\.enum when both are declared/,
      ],
      ['an empty enum', { type: 'string', enum: [] }, /enum must be a non-empty array of string values/],
    ]
    for (const [why, schema, needle] of rejected) {
      const violations = subsetViolations(schema)
      expect(violations.join('; '), `${why} was accepted`).toMatch(needle)
    }
    // Positive controls: the subset's own keywords, nested, are clean — and so
    // are the four annotations, which the subset accepts on any node.
    expect(
      subsetViolations({
        type: 'object',
        properties: {
          decision: { type: 'string', enum: ['approve', 'deny'], description: 'card answer' },
          answers: { type: 'object', additionalProperties: true },
          tags: { type: 'array', items: { type: 'string' } },
          title: { type: 'string', title: 'a title', default: 'x', examples: ['a', 'b'] },
        },
        required: ['decision'],
        additionalProperties: false,
      }),
    ).toEqual([])
  })
})
