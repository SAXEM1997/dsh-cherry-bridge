import { describe, expect, it } from 'vitest'
import {
  CHERRY_SUBAGENT_PROVIDER_DEFAULT,
  CHERRY_SUBAGENT_TOOL_DEFAULT,
  DEFAULT_MAX_INTERACTION_ABANDONS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
} from '../../src/defaults.js'
import { resolveSubagentConfig } from '../../src/subagent.js'

/**
 * Issue #231 — the configuration table.
 *
 * `subagent?: SubagentConfig` had no type: its fields were scattered across
 * seven lines of the design spec and #233's UI sketch. This file pins the ONE
 * table both sides read, because #233 builds a GET/PUT pair against it and a
 * second, guessed reading is how the two faces drift.
 *
 * The three-way resolution is the registration decision itself:
 *
 *  - `disabled` — the switch is off. Nothing is registered, and a target left
 *    half-written is not an error: an operator who has not turned the feature on
 *    has not asked for anything (SUB-01).
 *  - `invalid` — enabled, but the target cannot be dialled. The subsystem stops
 *    at `failed` and the problems are what the operator is shown (SUB-03).
 *  - `ready` — enabled and complete; the provider and tool names come from here
 *    (SUB-04).
 *
 * ## Why a problem is a CODE and not a sentence (#233)
 *
 * The settings page is bilingual and this table is its data source. A Chinese
 * string traveling over the HTTP face is a sentence the English page cannot
 * translate, so each problem is `{code, field, …params}` and the page owns the
 * words. That is why these assertions are exact objects: the SHAPE is the
 * contract, and a sentence creeping back in would be a red test rather than a
 * page that reads as half-translated.
 *
 * `field` is a config PATH (`device`, `routes[0].cwdPrefix`), and `received` is
 * the SHAPE that arrived (`number`, `null`, `NaN`), never the value: a problem
 * must not carry what the operator typed into it, because it crosses a wire.
 *
 * `revision` is not decoration: #233's `PUT /cherry-remote/api/subagent` is a
 * read-modify-write with an optimistic lock, so the table has to carry the
 * baseline it was read with.
 */

const COMPLETE = {
  enabled: true,
  device: 'desk-1',
  agentId: 'agent-7',
  workspaceId: 'ws-1',
} as const

describe('the four defaults are the numbers the copy quotes (#231 §6.6)', () => {
  it('pins each one, because the README and the tool description quote them', () => {
    expect(CHERRY_SUBAGENT_PROVIDER_DEFAULT).toBe('cherry')
    expect(CHERRY_SUBAGENT_TOOL_DEFAULT).toBe('cherry_subagent')
    expect(DEFAULT_SUBAGENT_TIMEOUT_MS).toBe(1_800_000)
    expect(DEFAULT_MAX_INTERACTION_ABANDONS).toBe(8)
  })
})

describe('resolution: disabled beats everything (SUB-01)', () => {
  it('an absent config is disabled, not an empty target', () => {
    expect(resolveSubagentConfig(undefined)).toEqual({ kind: 'disabled' })
  })

  it('a config with no `enabled` key is disabled', () => {
    expect(resolveSubagentConfig({ device: 'desk-1' })).toEqual({ kind: 'disabled' })
  })

  it('`enabled: false` with a COMPLETE target is still disabled', () => {
    // The switch is the whole decision. A target left configured behind a closed
    // switch is a draft, not a mistake — reporting it as `invalid` would fail a
    // subsystem the operator deliberately turned off.
    expect(resolveSubagentConfig({ ...COMPLETE, enabled: false })).toEqual({ kind: 'disabled' })
  })

  it('`enabled: false` with a BROKEN target is still disabled, never invalid', () => {
    expect(resolveSubagentConfig({ enabled: false, timeoutMs: -5 })).toEqual({ kind: 'disabled' })
  })
})

describe('resolution: a complete target is ready (SUB-04)', () => {
  it('takes the two names and the target from the config', () => {
    const resolved = resolveSubagentConfig(COMPLETE)
    expect(resolved.kind).toBe('ready')
    if (resolved.kind !== 'ready') return
    expect(resolved.config.providerName).toBe('cherry')
    expect(resolved.config.toolName).toBe('cherry_subagent')
    expect(resolved.config.target).toEqual({
      device: 'desk-1',
      agentId: 'agent-7',
      workspace: { workspaceId: 'ws-1' },
    })
  })

  it('the system workspace is the other arm of the workspace choice', () => {
    const resolved = resolveSubagentConfig({
      enabled: true,
      device: 'desk-1',
      agentId: 'agent-7',
      workspaceKind: 'system',
    })
    expect(resolved.kind).toBe('ready')
    if (resolved.kind !== 'ready') return
    expect(resolved.config.target.workspace).toEqual({ kind: 'system' })
  })

  it('carries every remaining field at its documented default', () => {
    const resolved = resolveSubagentConfig(COMPLETE)
    if (resolved.kind !== 'ready') throw new Error('expected ready')
    expect(resolved.config.cwdMode).toBe('isolated')
    expect(resolved.config.routes).toEqual([])
    expect(resolved.config.timeoutMs).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS)
    expect(resolved.config.maxInteractionAbandons).toBe(DEFAULT_MAX_INTERACTION_ABANDONS)
    expect(resolved.config.revision).toBe(0)
  })
})

describe('resolution: an incomplete target names what is missing (SUB-03)', () => {
  it('an empty enabled config reports all three, one problem each', () => {
    const resolved = resolveSubagentConfig({ enabled: true })
    expect(resolved.kind).toBe('invalid')
    if (resolved.kind !== 'invalid') return
    // One problem PER missing field, each naming it: a reason that says
    // "configuration incomplete" makes the operator re-read the docs to find out
    // which field, which is the failure this wording exists to prevent.
    expect(resolved.problems).toEqual([
      { code: 'missing', field: 'device' },
      { code: 'missing', field: 'agentId' },
      { code: 'missing', field: 'workspaceId' },
    ])
  })

  it('reports ONLY what is missing — a field that is present is not named', () => {
    const resolved = resolveSubagentConfig({ enabled: true, device: 'desk-1' })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toEqual([
      { code: 'missing', field: 'agentId' },
      { code: 'missing', field: 'workspaceId' },
    ])
  })

  it('refuses workspaceId together with workspaceKind, naming both', () => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, workspaceKind: 'system' })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toEqual([
      { code: 'exclusive', field: 'workspaceId', other: 'workspaceKind' },
    ])
  })

  it('a blank string is `empty`, and the field is still refused', () => {
    // Not `missing`: the field IS there, and an operator who typed spaces wants
    // to be told the value is blank rather than that they left it out.
    const resolved = resolveSubagentConfig({ ...COMPLETE, device: '   ' })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toEqual([{ code: 'empty', field: 'device' }])
  })

  it('a non-object `subagent` value is refused by name, never read as off', () => {
    // An unreadable switch must not present as an OFF one: answering `disabled`
    // here would hide a typo behind a switch the operator believes is on.
    expect(resolveSubagentConfig(['enabled', true])).toEqual({
      kind: 'invalid',
      problems: [{ code: 'not-object', field: 'subagent', received: 'array' }],
    })
    expect(resolveSubagentConfig('yes')).toEqual({
      kind: 'invalid',
      problems: [{ code: 'not-object', field: 'subagent', received: 'string' }],
    })
  })

  it('a non-boolean `enabled` is a problem, not a closed switch', () => {
    // `enabled: "true"` is the classic YAML quote slip, and reading it as off is
    // the one outcome that looks like success: nothing registers, nothing says
    // why, and the operator's switch shows what they typed.
    expect(resolveSubagentConfig({ enabled: 'true', device: 'desk-1' })).toEqual({
      kind: 'invalid',
      problems: [{ code: 'not-boolean', field: 'enabled', received: 'string' }],
    })
  })
})

describe('resolution: `timeoutMs` — 0 is a decision, a negative is a mistake (SUB-40/42/43)', () => {
  it('`0` means no wall-clock bound and is legal', () => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, timeoutMs: 0 })
    if (resolved.kind !== 'ready') throw new Error('expected ready')
    expect(resolved.config.timeoutMs).toBe(0)
  })

  it.each([
    ['a negative', -1, 'number'],
    ['NaN', Number.NaN, 'NaN'],
    ['Infinity', Number.POSITIVE_INFINITY, 'Infinity'],
    ['a string', '1800000', 'string'],
    ['null', null, 'null'],
  ])('%s is refused with its range and the shape that arrived', (_label, value, received) => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, timeoutMs: value })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    // ONE code for a wrong type and for an out-of-range number, because
    // `optionalInteger` judges both in one guard — and a second code that no
    // site can emit is a translation the page would carry for nobody.
    expect(resolved.problems).toEqual([
      { code: 'out-of-range', field: 'timeoutMs', min: 0, max: 2_147_483_647, received },
    ])
  })

  it('above the host timer ceiling is refused: setTimeout clamps silently past it', () => {
    // 2^31-1 is Node's setTimeout ceiling. A value above it does not fail — it
    // fires after ~24.8 days, so the configured deadline would be a lie rather
    // than an error, which is exactly what must be caught here.
    const resolved = resolveSubagentConfig({ ...COMPLETE, timeoutMs: 2_147_483_648 })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toEqual([
      { code: 'out-of-range', field: 'timeoutMs', min: 0, max: 2_147_483_647, received: 'number' },
    ])
  })

  it('exactly the ceiling is legal', () => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, timeoutMs: 2_147_483_647 })
    expect(resolved.kind).toBe('ready')
  })
})

describe('resolution: the remaining scalars are validated where they are read', () => {
  it.each([
    [
      'cwdMode',
      'elsewhere',
      { code: 'enum', field: 'cwdMode', allowed: ['isolated', 'shared'], received: 'string' },
    ],
    // The OTHER enum, and the one whose accepted set is a single value. It had no
    // case at all: `workspaceKind: 'system'` exercised the `exclusive` arm
    // instead, so a widened `allowed` here was invisible.
    [
      'workspaceKind',
      'named',
      { code: 'enum', field: 'workspaceKind', allowed: ['system'], received: 'string' },
    ],
    [
      'maxInteractionAbandons',
      0,
      {
        code: 'out-of-range',
        field: 'maxInteractionAbandons',
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
        received: 'number',
      },
    ],
    [
      'maxInteractionAbandons',
      2.5,
      {
        code: 'out-of-range',
        field: 'maxInteractionAbandons',
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
        received: 'number',
      },
    ],
    ['providerName', '', { code: 'empty', field: 'providerName' }],
    ['toolName', 42, { code: 'not-string', field: 'toolName', received: 'number' }],
    [
      'revision',
      -1,
      { code: 'out-of-range', field: 'revision', min: 0, max: Number.MAX_SAFE_INTEGER, received: 'number' },
    ],
  ])('%s = %j is refused with its own code', (key, value, problem) => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, [key]: value })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toEqual([problem])
  })

  it('`cwdMode: shared` is accepted — it is a declaration, not a behaviour switch (D1)', () => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, cwdMode: 'shared' })
    if (resolved.kind !== 'ready') throw new Error('expected ready')
    expect(resolved.config.cwdMode).toBe('shared')
  })
})

describe('resolution: routes are the delegation target table (SUB-10..14)', () => {
  it('a route without a cwdPrefix is refused, naming its full path', () => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, routes: [{ device: 'desk-2' }] })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    // Its OWN code, not `missing`: a route prefix that is present but blank is
    // refused by the same guard, so the sentence has to say "non-empty".
    expect(resolved.problems).toEqual([{ code: 'route-cwd-prefix', field: 'routes[0].cwdPrefix' }])
  })

  it('a blank cwdPrefix is refused too — a route that can never match is dead', () => {
    // `matchRoute` normalizes the prefix and then compares at a segment
    // boundary, so a prefix of spaces matches nothing: the route is accepted,
    // listed, and never fires. Refusing it here is the only place the operator
    // finds out.
    const resolved = resolveSubagentConfig({ ...COMPLETE, routes: [{ cwdPrefix: '   ' }] })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toEqual([{ code: 'route-cwd-prefix', field: 'routes[0].cwdPrefix' }])
  })

  it('#257 the ROOT prefix is refused: it matches nothing, and "every directory" is what omitting routes means', () => {
    // `matchRoute` compares at a segment boundary, so a prefix of `/` asks for
    // `//`: it matches the root itself and NOTHING below it — a route the
    // operator wrote to cover everything, listed on the page, that never fires.
    // Worse, `matchRoute` takes
    // the FIRST declared match, so a root route that DID match would silently
    // shadow every route after it. Refusing it is the only place the operator
    // finds out, and the sentence can point at the form that already means this.
    const resolved = resolveSubagentConfig({ ...COMPLETE, routes: [{ cwdPrefix: '/' }] })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toEqual([{ code: 'route-cwd-prefix-root', field: 'routes[0].cwdPrefix' }])
  })

  it('#257 every spelling that normalizes to the root is refused too', () => {
    // `//`, `///` and `/.` all normalize to `/`. Refusing only the literal one
    // would leave three ways to write the same dead route.
    for (const cwdPrefix of ['//', '///', '/.']) {
      const resolved = resolveSubagentConfig({ ...COMPLETE, routes: [{ cwdPrefix }] })
      if (resolved.kind !== 'invalid') throw new Error(`expected invalid for ${cwdPrefix}`)
      expect(resolved.problems).toEqual([{ code: 'route-cwd-prefix-root', field: 'routes[0].cwdPrefix' }])
    }
  })

  it('#279 a RELATIVE prefix is refused: every delegation cwd is absolute, so it can never match', () => {
    // The same class as the root prefix beside it. `matchRoute` normalizes both
    // sides and compares at a segment boundary, and `cwd` is always an absolute
    // path, so a relative prefix claims nothing — while the parser used to accept
    // it, leaving the operator with a route the page lists and nothing uses.
    for (const cwdPrefix of ['.', './x', 'foo', 'foo/', '../sibling']) {
      const resolved = resolveSubagentConfig({ ...COMPLETE, routes: [{ cwdPrefix }] })
      if (resolved.kind !== 'invalid') throw new Error(`expected invalid for ${cwdPrefix}`)
      expect(resolved.problems).toEqual([{ code: 'route-cwd-prefix-relative', field: 'routes[0].cwdPrefix' }])
    }
  })

  it('#279 the field names the route the operator actually wrote', () => {
    // The guard sits inside the per-route loop, so a table with an absolute
    // first entry and a relative second one must point at index 1 — the message
    // is the only thing the operator has to find the offending line.
    const resolved = resolveSubagentConfig({
      ...COMPLETE,
      routes: [{ cwdPrefix: '/workspace/dsh' }, { cwdPrefix: 'foo' }],
    })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toEqual([{ code: 'route-cwd-prefix-relative', field: 'routes[1].cwdPrefix' }])
  })

  it('#279 an ABSOLUTE prefix is still accepted, trailing slash and all', () => {
    // The guard must not swallow the ordinary case: a trailing slash normalizes
    // away, and a dotted directory name is still absolute.
    for (const cwdPrefix of ['/workspace/dsh', '/workspace/dsh/', '/.hidden', '/a']) {
      const resolved = resolveSubagentConfig({ ...COMPLETE, routes: [{ cwdPrefix }] })
      expect(resolved.kind).toBe('ready')
    }
  })

  it('a route entry that is not an object is refused by index', () => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, routes: ['/w/dsh'] })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toEqual([{ code: 'not-object', field: 'routes[0]', received: 'string' }])
  })

  it('a route’s own fields are validated under their FULL path', () => {
    // `routes[0].device`, not `device`: the page highlights the field that is
    // wrong, and a bare name inside an array entry points at nothing.
    const resolved = resolveSubagentConfig({
      ...COMPLETE,
      routes: [{ cwdPrefix: '/w/dsh', device: 42 }],
    })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toEqual([
      { code: 'not-string', field: 'routes[0].device', received: 'number' },
    ])
  })

  it('a declared route survives resolution in DECLARATION order', () => {
    // Order is the precedence `matchRoute` honours (first declared match wins),
    // so a resolver that sorted or deduped here would silently reorder intent.
    const routes = [
      { cwdPrefix: '/w/dsh', device: 'desk-2' },
      { cwdPrefix: '/w/other', workspaceId: 'ws-9' },
    ]
    const resolved = resolveSubagentConfig({ ...COMPLETE, routes })
    if (resolved.kind !== 'ready') throw new Error('expected ready')
    expect(resolved.config.routes).toEqual(routes)
  })

  it('a non-array `routes` is refused by name', () => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, routes: '/w/dsh' })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toEqual([{ code: 'not-array', field: 'routes', received: 'string' }])
  })
})
