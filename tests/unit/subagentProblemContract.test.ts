import { describe, expect, it } from 'vitest'
import { resolveSubagentConfig } from '../../src/subagent.js'
import type { SubagentProblem as ServerProblem } from '../../src/subagent.js'
import type { SubagentProblem as PageProblem } from '../../ui/src/types.js'

/**
 * The two `SubagentProblem` unions — the one `src/subagent.ts` PRODUCES and the
 * one `ui/src/types.ts` CONSUMES — had no binding between them (#280), and only
 * one direction of drift was loud.
 *
 * The page renders an unknown code by falling through `problemText`'s default
 * arm and printing the raw code, which is deliberate tolerance for a NEWER
 * server. So when the server gained a code the page had not learned, typecheck
 * stayed green, all 82 page and i18n cases stayed green, and the operator saw
 * `route-cwd-prefix-root` where a sentence belonged. The other direction — the
 * page gaining a code the server never emits — fails to compile, because the
 * page's union is then not assignable to the resolver's result type.
 *
 * Both directions are asserted below, so neither side can move alone.
 */
type Mutual =
  [ServerProblem] extends [PageProblem]
    ? [PageProblem] extends [ServerProblem]
      ? true
      : false
    : false

// The assertion IS the assignment: if the two unions drift apart in either
// direction this stops compiling, which fails `npm run typecheck` — the gate the
// repo already runs on every change that moves a type.
const mutuallyAssignable: Mutual = true

describe('#280 the page’s problem union and the server’s are the same union', () => {
  it('holds at the type level', () => {
    expect(mutuallyAssignable).toBe(true)
  })

  it('every problem the REAL resolver produces is one the page can render', () => {
    // A runtime half, on the real producer rather than a fixture list: the
    // assignment below is what would fail to compile if the page's union lacked
    // a code this document provokes. The document is deliberately bad in several
    // ways at once so the walk reaches more than one arm.
    const resolved = resolveSubagentConfig({
      enabled: true,
      device: 42,
      agentId: 'agent-7',
      workspaceId: '',
      routes: [{ cwdPrefix: '/' }, { cwdPrefix: 'relative' }],
      timeoutMs: -1,
      unknownKey: true,
    })
    if (resolved.kind !== 'invalid') throw new Error('expected an invalid document')
    const asPageProblems: readonly PageProblem[] = resolved.problems
    // …and back the other way, so the union is the same set rather than merely a
    // superset in one direction.
    const back: readonly ServerProblem[] = asPageProblems
    // A LITERAL expectation, not a comparison against the same reference: the
    // first version mapped `back` and `resolved.problems` — the same array under
    // two type annotations — so it could never fail. This one also catches a
    // resolver that lies about what it produced.
    expect(back.map((problem) => problem.code)).toEqual([
      'not-string',
      'empty',
      'out-of-range',
      'route-cwd-prefix-root',
      'route-cwd-prefix-relative',
      'missing',
    ])
  })
})
