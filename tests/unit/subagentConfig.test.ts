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
 *    at `failed` and the problems are the reason a human reads (SUB-03).
 *  - `ready` — enabled and complete; the provider and tool names come from here
 *    (SUB-04).
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
    expect(resolved.problems).toHaveLength(3)
    expect(resolved.problems.some((p) => p.includes('device'))).toBe(true)
    expect(resolved.problems.some((p) => p.includes('agentId'))).toBe(true)
    expect(resolved.problems.some((p) => p.includes('workspaceId'))).toBe(true)
  })

  it('reports ONLY what is missing — a field that is present is not named', () => {
    const resolved = resolveSubagentConfig({ enabled: true, device: 'desk-1' })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems.some((p) => p.includes('device'))).toBe(false)
    expect(resolved.problems).toHaveLength(2)
  })

  it('refuses workspaceId together with workspaceKind, naming both', () => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, workspaceKind: 'system' })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toHaveLength(1)
    expect(resolved.problems[0]).toContain('workspaceId')
    expect(resolved.problems[0]).toContain('workspaceKind')
  })

  it('a blank string is missing, not present', () => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, device: '   ' })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toHaveLength(1)
    expect(resolved.problems[0]).toContain('device')
  })
})

describe('resolution: `timeoutMs` — 0 is a decision, a negative is a mistake (SUB-40/42/43)', () => {
  it('`0` means no wall-clock bound and is legal', () => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, timeoutMs: 0 })
    if (resolved.kind !== 'ready') throw new Error('expected ready')
    expect(resolved.config.timeoutMs).toBe(0)
  })

  it.each([
    ['a negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '1800000'],
    ['null', null],
  ])('%s is refused by name', (_label, value) => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, timeoutMs: value })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toHaveLength(1)
    expect(resolved.problems[0]).toContain('timeoutMs')
  })

  it('above the host timer ceiling is refused: setTimeout clamps silently past it', () => {
    // 2^31-1 is Node's setTimeout ceiling. A value above it does not fail — it
    // fires after ~24.8 days, so the configured deadline would be a lie rather
    // than an error, which is exactly what must be caught here.
    const resolved = resolveSubagentConfig({ ...COMPLETE, timeoutMs: 2_147_483_648 })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems[0]).toContain('timeoutMs')
  })

  it('exactly the ceiling is legal', () => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, timeoutMs: 2_147_483_647 })
    expect(resolved.kind).toBe('ready')
  })
})

describe('resolution: the remaining scalars are validated where they are read', () => {
  it.each([
    ['cwdMode', 'elsewhere'],
    ['maxInteractionAbandons', 0],
    ['maxInteractionAbandons', 2.5],
    ['providerName', ''],
    ['toolName', 42],
    ['revision', -1],
  ])('%s = %s is refused by name', (key, value) => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, [key]: value })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems.some((p) => p.includes(key))).toBe(true)
  })

  it('`cwdMode: shared` is accepted — it is a declaration, not a behaviour switch (D1)', () => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, cwdMode: 'shared' })
    if (resolved.kind !== 'ready') throw new Error('expected ready')
    expect(resolved.config.cwdMode).toBe('shared')
  })
})

describe('resolution: routes are the delegation target table (SUB-10..14)', () => {
  it('a route without a cwdPrefix is refused, naming the index', () => {
    const resolved = resolveSubagentConfig({ ...COMPLETE, routes: [{ device: 'desk-2' }] })
    if (resolved.kind !== 'invalid') throw new Error('expected invalid')
    expect(resolved.problems).toHaveLength(1)
    expect(resolved.problems[0]).toContain('routes[0]')
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
    expect(resolved.problems.some((p) => p.includes('routes'))).toBe(true)
  })
})
