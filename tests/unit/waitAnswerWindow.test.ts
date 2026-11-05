import { describe, expect, it } from 'vitest'
import { WAIT_ANSWER_TAIL_MS, answerWindowFor } from '../../src/tools.js'

/**
 * Issue #231 — the answer's budget when the WAIT has none.
 *
 * `AssemblyDeadline` exists because the caller's wait window cannot bound the
 * ANSWER that follows it (issue #21: a 1 s window once answered ~150 s later
 * under a flapping link). SUB-42 lets a delegation say "no wall-clock bound on
 * the wait", and the first version passed that through as `Infinity` — which
 * made the deadline infinite and handed the assembly exactly the unbounded
 * budget the whole mechanism was built to prevent.
 *
 * The two are different promises: an unbounded WAIT is a decision about how long
 * a parent will sit for a child, while an unbounded ASSEMBLY would let a
 * degrading link spend `transportRetryWaitMs` on every request for as long as
 * the peer felt like it.
 *
 * TWO guards, and only one of them is observable — stated rather than implied.
 * `answerWindowFor` is the tested one; `AssemblyDeadline`'s own `Number.isFinite`
 * check is defence in depth, and a mutation that removes it survives this file
 * because the helper already refuses to hand it an infinity. Keeping both is a
 * deliberate redundancy (a future caller may reach the constructor directly),
 * and it is NOT two covered guards.
 */

describe('an unbounded wait still gets a bounded answer (#231, SUB-42)', () => {
  it('①a a finite window is passed through unchanged', () => {
    expect(answerWindowFor(120_000)).toBe(120_000)
    expect(answerWindowFor(1)).toBe(1)
  })

  it('①b an infinite window becomes ONE tail, never infinity', () => {
    expect(answerWindowFor(Number.POSITIVE_INFINITY)).toBe(WAIT_ANSWER_TAIL_MS)
    expect(Number.isFinite(answerWindowFor(Number.POSITIVE_INFINITY))).toBe(true)
  })

  it('①c `0` is not special-cased here — the caller maps it to infinity first', () => {
    // The delegation turns `timeoutMs: 0` into an infinite WAIT window before
    // this function sees it (`runSubagentDelegation`), so `0` arriving here
    // would be the 1 ms-ish window `#awaitRun` judges literally. Pinned so the
    // two mappings cannot drift into a silent disagreement.
    expect(answerWindowFor(0)).toBe(0)
  })
})
