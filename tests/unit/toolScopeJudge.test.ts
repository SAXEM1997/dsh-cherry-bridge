/**
 * Task 3 — the session → workspace judgement: the canonical path map, the four
 * resolution states, the per-agent judgement cache and the `pathUnmatched`
 * diagnostics (§6.1 second half; D14 + B2/B3/B5/B13/B16; R8/R9).
 *
 * The judgement is the module's second half and the contract Tasks 4–6 read:
 * `rebuild()` is the ONLY asynchronous method here and the ONLY production
 * writer of `setWorkspaces`; `judgement()` and `pathUnmatched()` are synchronous
 * map lookups of one generation. Four things are easy to get subtly wrong and
 * are therefore pinned as SEPARATE cases rather than folded into one
 * "judgement works" case:
 *
 *   1. the map's key is the ENTITY path `resolveByPath` returns for a registry
 *      item (realpath semantics — both sides of a symlink converge on one key),
 *      never the return value run through `normalizeWorkspaceId` as if it were a
 *      path string. The fixtures model the REAL contract: the registry ENTITY
 *      for a path the host owns, `undefined` for a directory it does not own,
 *      and a REJECTION for a path that is missing;
 *   2. `visible` has exactly ONE definition — `isVisible(doc, workspaceId)` — and
 *      is never derived from `status === 'resolved'`: under `global` all four
 *      states are visible, and fail-closed applies to `selected` only;
 *   3. the four states keep their meanings when the list itself is unreadable
 *      (every cwd-bearing agent becomes `unresolved`, which is the state D14's
 *      bounded recheck is defined to start from) and when the host has no
 *      `resolveByPath` (an honest, recorded degradation to case-sensitive string
 *      equality — never claimed to be canonical-path equivalence);
 *   4. `pathUnmatched` is DIAGNOSTICS, not degradation: a `no-match` leaves a
 *      record and adds NO `degraded` entry.
 *
 * The fixtures are fakes, not a real registry: what is under test is the
 * algorithm this module owns (§6.1's state ownership), and a real
 * `workspaceRegistry` would only make the four states unreachable.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SCOPE_DOC_VERSION,
  ToolScopeState,
  isVisible,
  type AgentJudgement,
  type RebuildSummary,
  type ResolutionStatus,
  type ScopeAgentLike,
  type ScopeMode,
  type WorkspaceRegistryLike,
} from '../../src/toolScope.js'

const tempDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

/** One registry item, shaped the way the real `list()` projects it. */
interface Item {
  id: string
  title?: string
  path: string
  sessionIds?: string[]
}

/**
 * How the fixture's `resolveByPath` answers for one path.
 *
 *  - an ENTITY (`{ id, path }`) — the host owns the directory;
 *  - `undefined` — the host explicitly owns no such directory (⇒ `no-match`);
 *  - `'missing'` — the path is gone, so the call REJECTS (⇒ `unresolved` when it
 *    is an agent's cwd, "skip this item" when it is a registry item's path).
 */
type Resolution = { id: string; path: string } | undefined | 'missing'

/** A registry whose `resolveByPath` follows the real contract, path by path. */
function registryFixture(
  items: readonly Item[],
  resolutions: Record<string, Resolution> = {},
): WorkspaceRegistryLike {
  return {
    // A fresh list per read, like the real registry's projection.
    list: () => items.map((item) => ({ ...item, sessionIds: [...(item.sessionIds ?? [])] })),
    async resolveByPath(path: string): Promise<unknown | undefined> {
      const resolution: Resolution = Object.hasOwn(resolutions, path)
        ? resolutions[path]
        : 'missing'
      if (resolution === 'missing') {
        throw new Error(`ENOENT: no such file or directory, realpath '${path}'`)
      }
      return resolution
    },
  }
}

/** The same fixture with every `resolveByPath` held until `gate` settles. */
function gatedRegistry(
  items: readonly Item[],
  resolutions: Record<string, Resolution>,
  gate: Promise<void>,
): WorkspaceRegistryLike {
  const inner = registryFixture(items, resolutions)
  return {
    list: () => inner.list(),
    async resolveByPath(path: string): Promise<unknown | undefined> {
      await gate
      return inner.resolveByPath!(path)
    },
  }
}

/** A promise plus its settlement handles: how a test holds `await` open. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * A state over a fresh scope file. No `mode` ⇒ no file at all, i.e. the D3
 * default (selected + empty), which is what "no document yet" really looks like.
 */
function makeState(options: { mode?: ScopeMode; workspaceIds?: string[]; version?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-scope-judge-'))
  tempDirs.push(dir)
  const file = join(dir, 'scope.json')
  if (options.mode !== undefined) {
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          version: options.version ?? SCOPE_DOC_VERSION,
          revision: 1,
          mode: options.mode,
          workspaceIds: options.workspaceIds ?? [],
        },
        null,
        2,
      )}\n`,
    )
  }
  const log = vi.fn()
  return { state: new ToolScopeState({ file, log }), log, file }
}

function statusOf(state: ToolScopeState, agentId: string): ResolutionStatus {
  const judgement = state.judgement(agentId)
  if (judgement === undefined) throw new Error(`no judgement for ${agentId}`)
  return judgement.status
}

function sourcesOf(state: ToolScopeState): string[] {
  return state.degraded().map((note) => note.source)
}

describe('① rule one — the membership projection wins (§4)', () => {
  it('resolves through sessionIds even when the cwd matches no registry item', async () => {
    const { state } = makeState({ mode: 'selected', workspaceIds: ['W'] })
    const summary: RebuildSummary = await state.rebuild(
      registryFixture(
        [{ id: 'W', title: 'Work', path: '/w/real', sessionIds: ['s1'] }],
        // The cwd is a directory the host owns but matches no item: rule two
        // alone would answer `no-match`.
        { '/w/real': { id: 'W', path: '/w/real' }, '/elsewhere': undefined },
      ),
      [{ id: 's1', cwd: '/elsewhere' }],
    )

    const judgement: AgentJudgement = state.judgement('s1')!
    expect(judgement.status).toBe('resolved')
    expect(judgement.workspaceId).toBe('W')
    expect(judgement.visible).toBe(true)
    // The reason carries a workspace title or id: Task 5 writes it into the
    // installed-layer record and `guard` echoes it back (B6).
    expect(judgement.reason).toContain('Work')
    expect(judgement.reason).toContain('W')
    expect(summary).toEqual({ listAvailable: true, agents: 1, resolved: 1, unresolved: 0, pathUnmatched: 0 })
    // A membership hit is a workspace, so no path-mismatch record — even though
    // the cwd on its own would not have matched.
    expect(state.pathUnmatched()).toEqual([])
  })

  it('wins over a cwd that would have matched a DIFFERENT item', async () => {
    const { state } = makeState({ mode: 'selected', workspaceIds: ['BY-CWD', 'BY-ID'] })
    await state.rebuild(
      registryFixture(
        [
          { id: 'BY-CWD', title: 'By cwd', path: '/w/by-cwd' },
          { id: 'BY-ID', title: 'By id', path: '/w/by-id', sessionIds: ['s1'] },
        ],
        { '/w/by-cwd': { id: 'BY-CWD', path: '/w/by-cwd' }, '/w/by-id': { id: 'BY-ID', path: '/w/by-id' } },
      ),
      [{ id: 's1', cwd: '/w/by-cwd' }],
    )

    expect(state.judgement('s1')).toMatchObject({ status: 'resolved', workspaceId: 'BY-ID' })
  })
})

describe('② rule two — one canonical path map, realpath semantics (D14/B13)', () => {
  it('converges a symlink and its target on one key and one workspaceId', async () => {
    const { state } = makeState({ mode: 'selected', workspaceIds: ['W'] })
    // The registry lists the REAL path; one session's cwd is the link. The bare
    // strings differ, `resolveByPath` returns the SAME entity for both, and the
    // map is keyed on the entity path.
    const agents: ScopeAgentLike[] = [
      { id: 'a-real', cwd: '/w/real' },
      { id: 'a-link', cwd: '/w/link' },
    ]
    await state.rebuild(
      registryFixture([{ id: 'W', title: 'Work', path: '/w/real' }], {
        '/w/real': { id: 'W', path: '/w/real' },
        '/w/link': { id: 'W', path: '/w/real' },
      }),
      agents,
    )

    const direct = state.judgement('a-real')!
    const viaLink = state.judgement('a-link')!
    expect('/w/link').not.toBe('/w/real')
    expect(direct.status).toBe('resolved')
    expect(viaLink.status).toEqual(direct.status)
    expect(viaLink.workspaceId).toBe('W')
    expect(viaLink.workspaceId).toEqual(direct.workspaceId)
    expect(viaLink.visible).toEqual(direct.visible)
    // Rule two's reason names the workspace too: Task 5 copies it into the
    // installed-layer record and `guard` echoes it back (B6).
    expect(viaLink.reason).toContain('Work')
    expect(viaLink.reason).toContain('W')
    expect(state.pathUnmatched()).toEqual([])
  })

  it('does not key the map on the item path when the entity reports another one', async () => {
    const { state } = makeState({ mode: 'selected', workspaceIds: ['W'] })
    // The item's path is a stale spelling; the entity knows the canonical path.
    // Keying on the ITEM path would leave the canonical cwd unmatched.
    await state.rebuild(
      registryFixture([{ id: 'W', title: 'Work', path: '/w/stale' }], {
        '/w/stale': { id: 'W', path: '/w/canonical' },
        '/w/canonical': { id: 'W', path: '/w/canonical' },
      }),
      [{ id: 'a1', cwd: '/w/canonical' }],
    )

    expect(state.judgement('a1')).toMatchObject({ status: 'resolved', workspaceId: 'W' })
  })
})

describe('④ the four resolution states, and `visible` from `isVisible` alone', () => {
  /** One agent per state reachable in this module (plus a second `no-match` shape). */
  const agents: ScopeAgentLike[] = [
    { id: 'agent-no-cwd' },
    { id: 'agent-unresolved', cwd: '/w/unreachable' },
    { id: 'agent-unowned', cwd: '/w/unowned' },
    { id: 'agent-unmatched', cwd: '/w/elsewhere' },
    { id: 'agent-resolved', cwd: '/w/real' },
  ]

  function fourStates(): WorkspaceRegistryLike {
    return registryFixture([{ id: 'W', title: 'Work', path: '/w/real' }], {
      '/w/real': { id: 'W', path: '/w/real' },
      // The path is gone ⇒ REJECT ⇒ `unresolved`.
      '/w/unreachable': 'missing',
      // The host explicitly owns no such directory ⇒ `no-match`.
      '/w/unowned': undefined,
      // Resolves fine but the entity is in no map entry ⇒ `no-match`.
      '/w/elsewhere': { id: 'OTHER', path: '/w/other' },
    })
  }

  it('selected: only a hit that `isVisible` accepts is visible (fail-closed, D7)', async () => {
    const { state } = makeState({ mode: 'selected', workspaceIds: ['W'] })
    const summary = await state.rebuild(fourStates(), agents)

    expect(summary).toEqual({
      listAvailable: true,
      agents: 5,
      resolved: 1,
      unresolved: 1,
      pathUnmatched: 2,
    })
    expect(statusOf(state, 'agent-no-cwd')).toBe('no-cwd')
    expect(statusOf(state, 'agent-unresolved')).toBe('unresolved')
    expect(statusOf(state, 'agent-unowned')).toBe('no-match')
    expect(statusOf(state, 'agent-unmatched')).toBe('no-match')
    expect(statusOf(state, 'agent-resolved')).toBe('resolved')

    expect(state.judgement('agent-resolved')).toMatchObject({ workspaceId: 'W', visible: true })
    for (const id of ['agent-no-cwd', 'agent-unresolved', 'agent-unowned', 'agent-unmatched']) {
      expect(state.judgement(id)).toMatchObject({ visible: false })
      expect(state.judgement(id)!.workspaceId).toBeUndefined()
    }

    // §6.1: the mismatch is DIAGNOSTIC, not degradation.
    expect(state.pathUnmatched()).toEqual([
      { agentId: 'agent-unowned', cwd: '/w/unowned' },
      { agentId: 'agent-unmatched', cwd: '/w/elsewhere' },
    ])
    expect(sourcesOf(state)).not.toContain('path-normalization')
    expect(state.degraded()).toEqual([])
  })

  it('global: `visible` is true for all four states (B2)', async () => {
    const { state } = makeState({ mode: 'global' })
    await state.rebuild(fourStates(), agents)

    expect(state.judgement('agent-no-cwd')!.status).toBe('no-cwd')
    expect(state.judgement('agent-unresolved')!.status).toBe('unresolved')
    expect(state.judgement('agent-unowned')!.status).toBe('no-match')
    expect(state.judgement('agent-resolved')!.status).toBe('resolved')
    for (const agent of agents) {
      expect(state.judgement(agent.id)!.visible).toBe(true)
    }
    // A mismatch still leaves its diagnostic under `global`.
    expect(state.pathUnmatched()).toHaveLength(2)
    expect(state.degraded()).toEqual([])
  })

  it('a resolved workspace the document does not select is invisible (B3)', async () => {
    const { state } = makeState({ mode: 'selected', workspaceIds: ['OTHER'] })
    await state.rebuild(fourStates(), agents)

    // Same `resolved` judgement as the visible case, opposite `visible`: the one
    // definition is `isVisible(doc, workspaceId)`, not `status === 'resolved'`.
    expect(state.judgement('agent-resolved')).toMatchObject({
      status: 'resolved',
      workspaceId: 'W',
      visible: false,
    })
  })
})

describe('③ the old host without resolveByPath degrades honestly (D14)', () => {
  function oldHost(): WorkspaceRegistryLike {
    // No `resolveByPath` at all: `list()` is the whole method surface.
    return { list: () => [{ id: 'W', title: 'Work', path: '/w/real', sessionIds: ['member'] }] }
  }

  it('matches case-sensitive path strings, records `path-normalization`, and keeps sessionIds', async () => {
    const { state } = makeState({ mode: 'selected', workspaceIds: ['W'] })
    await state.rebuild(oldHost(), [
      { id: 'member', cwd: '/w/link' },
      { id: 'exact', cwd: '/w/real' },
      { id: 'synonym', cwd: '/w/link' },
      { id: 'case', cwd: '/W/REAL' },
    ])

    // The projection still works; the path rule degrades to string equality.
    expect(state.judgement('member')).toMatchObject({ status: 'resolved', workspaceId: 'W' })
    expect(state.judgement('exact')).toMatchObject({ status: 'resolved', workspaceId: 'W' })
    // A symlink is NOT resolved (no realpath) …
    expect(state.judgement('synonym')).toMatchObject({ status: 'no-match', visible: false })
    // … and the degraded comparison stays case-sensitive (no case folding).
    expect(state.judgement('case')).toMatchObject({ status: 'no-match', visible: false })

    const notes = state.degraded()
    expect(notes).toHaveLength(1)
    expect(notes[0]!.source).toBe('path-normalization')
    expect(notes[0]!.reason).toContain('宿主无 resolveByPath')
    expect(notes[0]!.reason).toContain('大小写敏感字符串等价')
    expect(notes[0]!.reason).toContain('不做 realpath')
    // D14: the degradation is never presented as canonical-path equivalence.
    expect(notes[0]!.reason).not.toContain('与规范化匹配等价')

    // The mismatches are diagnostics — they add NO second `degraded` entry.
    expect(state.pathUnmatched()).toEqual([
      { agentId: 'synonym', cwd: '/w/link' },
      { agentId: 'case', cwd: '/W/REAL' },
    ])
  })
})

describe('⑤⑥⑦ the synchronous read contract and the atomic generation swap', () => {
  it('⑤ reads `undefined` until the first rebuild settles, then reads synchronously', async () => {
    const selected = makeState({ mode: 'selected', workspaceIds: ['W'] })
    const global = makeState({ mode: 'global' })
    const gate = deferred<void>()
    const registry = gatedRegistry(
      [{ id: 'W', title: 'Work', path: '/w/real' }],
      { '/w/real': { id: 'W', path: '/w/real' } },
      gate.promise,
    )
    const agents: ScopeAgentLike[] = [{ id: 'a1', cwd: '/w/real' }]

    const pendingSelected = selected.state.rebuild(registry, agents)
    const pendingGlobal = global.state.rebuild(registry, agents)

    // Cache miss ⇒ D7's fallback, and its definition is `isVisible` — fail-closed
    // for `selected` ONLY. Under `global` a miss is still visible (B2).
    expect(selected.state.judgement('a1')).toBeUndefined()
    expect(isVisible(selected.state.doc(), selected.state.judgement('a1')?.workspaceId)).toBe(false)
    expect(global.state.judgement('a1')).toBeUndefined()
    expect(isVisible(global.state.doc(), global.state.judgement('a1')?.workspaceId)).toBe(true)

    gate.resolve()
    await Promise.all([pendingSelected, pendingGlobal])

    // Immediately readable afterwards, as a synchronous map lookup.
    const judgement = selected.state.judgement('a1')!
    expect(judgement).toMatchObject({ status: 'resolved', workspaceId: 'W', visible: true })
    expect(judgement).not.toBeInstanceOf(Promise)
    // The cache is per agent: an id this round never judged stays a miss.
    expect(selected.state.judgement('never-seen')).toBeUndefined()
  })

  it('⑥ swaps the whole judgement generation at once — never a half-built map', async () => {
    const { state } = makeState({ mode: 'selected', workspaceIds: ['W1', 'W2'] })
    const agents: ScopeAgentLike[] = [{ id: 'a1', cwd: '/w/one' }]

    await state.rebuild(
      registryFixture([{ id: 'W1', title: 'One', path: '/w/one' }], {
        '/w/one': { id: 'W1', path: '/w/one' },
      }),
      agents,
    )
    const first = state.judgement('a1')!
    expect(first).toMatchObject({ status: 'resolved', workspaceId: 'W1' })

    const gate = deferred<void>()
    const pending = state.rebuild(
      gatedRegistry(
        [{ id: 'W2', title: 'Two', path: '/w/two' }],
        { '/w/one': { id: 'W2', path: '/w/two' }, '/w/two': { id: 'W2', path: '/w/two' } },
        gate.promise,
      ),
      agents,
    )

    // Mid-rebuild: the previous generation, object-identical, and never a
    // half-built one. (The LIST is written first by design — the brief fixes the
    // build order as list ⇒ map ⇒ judgements — but the judgement generation
    // switches in one assignment.)
    expect(state.judgement('a1')).toBe(first)

    gate.resolve()
    await pending

    expect(state.judgement('a1')).toMatchObject({ status: 'resolved', workspaceId: 'W2' })
    expect(state.judgement('a1')).not.toBe(first)
  })

  it('⑦ invalidateDerived() voids the judgements and the diagnostics (Task 4 teardown)', async () => {
    const { state } = makeState({ mode: 'selected', workspaceIds: ['W'] })
    await state.rebuild(
      registryFixture([{ id: 'W', title: 'Work', path: '/w/real' }], {
        '/w/real': { id: 'W', path: '/w/real' },
        '/w/link': undefined,
      }),
      [{ id: 'a1', cwd: '/w/link' }],
    )
    expect(state.judgement('a1')).toBeDefined()
    expect(state.pathUnmatched()).toHaveLength(1)
    state.setLayer('a1', { deny: ['cherry_ping'], reason: 'test' })

    state.invalidateDerived()

    expect(state.judgement('a1')).toBeUndefined()
    expect(state.pathUnmatched()).toEqual([])
    expect(state.layer('a1')).toBeUndefined()
  })
})

describe('⑧⑨ the list is unreadable: fail-closed for selected, never for global (B16)', () => {
  const agents: ScopeAgentLike[] = [{ id: 'with-cwd', cwd: '/w/real' }, { id: 'no-cwd' }]

  const failures: ReadonlyArray<[string, () => unknown]> = [
    ['a throwing list()', () => {
      throw new Error('registry not ready')
    }],
    ['an empty list() ([] ≡ read failure)', () => []],
  ]

  it.each(failures)('%s ⇒ unresolved for every cwd-bearing agent, degraded, selected fail-closed', async (_label, list) => {
    const { state } = makeState({ mode: 'selected', workspaceIds: ['W'] })
    const summary = await state.rebuild({ list }, agents)

    expect(summary).toEqual({
      listAvailable: false,
      agents: 2,
      resolved: 0,
      unresolved: 1,
      pathUnmatched: 0,
    })
    expect(sourcesOf(state)).toContain('workspace-list')
    // "This resolution failed" is exactly the state D14's bounded recheck starts from.
    expect(state.judgement('with-cwd')).toMatchObject({ status: 'unresolved', visible: false })
    // No cwd is not a resolution failure: it stays `no-cwd` (and never rechecks).
    expect(state.judgement('no-cwd')).toMatchObject({ status: 'no-cwd', visible: false })
    // A failed read is not a path mismatch.
    expect(state.pathUnmatched()).toEqual([])
  })

  it.each(failures)('%s leaves the `global` judgement visible (B16)', async (_label, list) => {
    const { state } = makeState({ mode: 'global' })
    await state.rebuild({ list }, agents)

    expect(state.judgement('with-cwd')!.status).toBe('unresolved')
    expect(state.judgement('no-cwd')!.status).toBe('no-cwd')
    expect(state.judgement('with-cwd')!.visible).toBe(true)
    expect(state.judgement('no-cwd')!.visible).toBe(true)
    expect(sourcesOf(state)).toContain('workspace-list')
  })

  it('⑨ global + no cwd + degraded list ⇒ visible (empty target set ⇒ release only)', async () => {
    const { state } = makeState({ mode: 'global' })
    const summary = await state.rebuild(
      {
        list: () => {
          throw new Error('registry not ready')
        },
      },
      [{ id: 'a1' }],
    )

    expect(summary.listAvailable).toBe(false)
    const judgement = state.judgement('a1')!
    expect(judgement.status).toBe('no-cwd')
    expect(judgement.workspaceId).toBeUndefined()
    // The ONLY criterion is `isVisible`: not the cwd, not the list's health.
    // (The install action this implies — release, never install — is Task 5 ③.)
    expect(judgement.visible).toBe(true)
    expect(sourcesOf(state)).toContain('workspace-list')
  })
})

describe('⑩ the tri-state and the single production writer of setWorkspaces', () => {
  it('未读: no list, no note, no judgement generation, and a save that prunes nothing', () => {
    const { state, log } = makeState()

    expect(state.workspaces()).toEqual([])
    expect(state.staleWorkspaceIds()).toEqual([])
    expect(state.degraded()).toEqual([])
    // The generation is EMPTY: D14's four values only exist after a rebuild.
    expect(state.judgement('any-agent')).toBeUndefined()
    expect(state.pathUnmatched()).toEqual([])
    // …and 未读 is not 读失败: the write side is open and deletes nothing.
    const result = state.save({ mode: 'selected', workspaceIds: ['GONE', 'W'] }, 0)
    expect(result).toMatchObject({ ok: true, pruned: [] })
    expect(state.doc().workspaceIds).toEqual(['GONE', 'W'])
    expect(log).not.toHaveBeenCalled()
  })

  it('读成功: rebuild() writes the list and the reconciliation reports registry-outside ids', async () => {
    const { state } = makeState({ mode: 'selected', workspaceIds: ['GONE', 'W'] })
    // 未读 first: "cannot reconcile" is not "every id is stale".
    expect(state.staleWorkspaceIds()).toEqual([])

    await state.rebuild(
      registryFixture([{ id: 'W', title: 'Work', path: '/w/real' }], {
        '/w/real': { id: 'W', path: '/w/real' },
      }),
      [],
    )

    expect(state.workspaces().map((workspace) => workspace.id)).toEqual(['W'])
    expect(state.staleWorkspaceIds()).toEqual(['GONE'])
    expect(sourcesOf(state)).not.toContain('workspace-list')
  })
})

describe('R8 — the `workspace-list` note is STATE, not history', () => {
  function brokenList(): () => unknown {
    return () => {
      throw new Error('registry not ready')
    }
  }

  /**
   * A MODERN host (it has `resolveByPath`) whose list read fails in the given
   * way: the only degradation in play is the list itself, so the "other notes
   * survive" case cannot be confounded by the old-host `path-normalization`
   * note.
   */
  function brokenRegistry(list: () => unknown): WorkspaceRegistryLike {
    return {
      list,
      async resolveByPath() {
        return undefined
      },
    }
  }

  function workingRegistry(): WorkspaceRegistryLike {
    return registryFixture([{ id: 'W', title: 'Work', path: '/w/real' }], {
      '/w/real': { id: 'W', path: '/w/real' },
    })
  }

  it.each([
    ['a throwing list()', brokenList],
    ['an empty list()', () => [] as unknown[]],
  ])('clears the note on a later read-OK rebuild (%s first)', async (_label, list) => {
    const { state } = makeState({ mode: 'selected', workspaceIds: ['W'] })

    await state.rebuild(brokenRegistry(list), [{ id: 'a1', cwd: '/w/real' }])
    expect(sourcesOf(state)).toContain('workspace-list')
    // While the list is CURRENTLY unavailable the write side is refused (503).
    expect(state.save({ mode: 'selected', workspaceIds: ['W'] }, state.doc().revision)).toMatchObject({
      status: 503,
      error: 'workspace-list-unavailable',
    })

    await state.rebuild(workingRegistry(), [{ id: 'a1', cwd: '/w/real' }])

    expect(sourcesOf(state)).not.toContain('workspace-list')
    // The point of the clearing: the server now accepts the very PUT whose
    // button the note would have kept disabled for the rest of the process (R8).
    expect(state.save({ mode: 'selected', workspaceIds: ['W'] }, state.doc().revision)).toMatchObject({
      ok: true,
    })
  })

  it('keeps the other sources’ notes when the read recovers', async () => {
    // A version-2 document is a second, independent production-path note.
    const { state } = makeState({ mode: 'selected', workspaceIds: [], version: 2 })
    state.load()
    expect(sourcesOf(state)).toEqual(['scope-version'])

    await state.rebuild(brokenRegistry(brokenList()), [])
    expect(sourcesOf(state)).toEqual(expect.arrayContaining(['scope-version', 'workspace-list']))

    await state.rebuild(workingRegistry(), [])
    expect(sourcesOf(state)).toEqual(['scope-version'])
  })
})

describe('⑪ one bad item does not affect the others or any judgement (R9)', () => {
  const badItem: Item = { id: 'B', title: 'Beta', path: '/w/missing' }
  const goodResolutions: Record<string, Resolution> = {
    '/w/a': { id: 'A', path: '/w/a' },
    '/w/c': { id: 'C', path: '/w/c' },
    // Owned by nobody ⇒ the unmatched agent's `no-match`, and no rejection to log.
    '/w/else': undefined,
  }
  const agents: ScopeAgentLike[] = [
    { id: 'a', cwd: '/w/a' },
    { id: 'c', cwd: '/w/c' },
    { id: 'unmatched', cwd: '/w/else' },
    { id: 'no-cwd' },
  ]

  function withBadItem(): WorkspaceRegistryLike {
    return registryFixture(
      [{ id: 'A', title: 'Alpha', path: '/w/a' }, badItem, { id: 'C', title: 'Gamma', path: '/w/c' }],
      // `/w/missing` is absent from the table ⇒ the fixture REJECTS, exactly as
      // the real registry does for a path that is gone.
      goodResolutions,
    )
  }

  function withoutBadItem(): WorkspaceRegistryLike {
    return registryFixture(
      [{ id: 'A', title: 'Alpha', path: '/w/a' }, { id: 'C', title: 'Gamma', path: '/w/c' }],
      goodResolutions,
    )
  }

  it('skips the item, logs exactly once, adds no degraded entry and leaves every judgement equal', async () => {
    const first = makeState({ mode: 'selected', workspaceIds: ['A', 'C'] })
    const second = makeState({ mode: 'selected', workspaceIds: ['A', 'C'] })

    const summary = await first.state.rebuild(withBadItem(), agents)

    // The bad item never collapses the list into a read failure (R9): the read
    // was authoritative, the item is skipped, the round still succeeds.
    expect(summary).toEqual({
      listAvailable: true,
      agents: 4,
      resolved: 2,
      unresolved: 0,
      pathUnmatched: 1,
    })
    expect(first.log).toHaveBeenCalledTimes(1)
    // Not a degradation: the five-value enum has no member for "one item's path
    // could not be resolved".
    expect(first.state.degraded()).toEqual([])
    expect(first.state.workspaces().map((workspace) => workspace.id)).toEqual(['A', 'B', 'C'])

    expect(first.state.judgement('a')).toMatchObject({ status: 'resolved', workspaceId: 'A', visible: true })
    expect(first.state.judgement('c')).toMatchObject({ status: 'resolved', workspaceId: 'C', visible: true })
    expect(first.state.judgement('unmatched')).toMatchObject({ status: 'no-match', visible: false })
    expect(first.state.judgement('no-cwd')).toMatchObject({ status: 'no-cwd', visible: false })
    expect(first.state.pathUnmatched()).toEqual([{ agentId: 'unmatched', cwd: '/w/else' }])

    const other = await second.state.rebuild(withoutBadItem(), agents)
    expect(other.listAvailable).toBe(true)
    expect(second.log).not.toHaveBeenCalled()

    // 逐条逐字段: removing the bad item changes NO agent's judgement.
    for (const agent of agents) {
      const left = first.state.judgement(agent.id)!
      const right = second.state.judgement(agent.id)!
      expect(left.status).toBe(right.status)
      expect(left.workspaceId).toBe(right.workspaceId)
      expect(left.visible).toBe(right.visible)
    }
    expect(first.state.pathUnmatched()).toEqual(second.state.pathUnmatched())
  })
})
