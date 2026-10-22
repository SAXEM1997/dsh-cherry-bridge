import { describe, expect, it } from 'vitest'
import { contentBudgetFor } from '../../src/connection.js'

/**
 * `contentBudgetFor` maps the ONE injected knob (`rateBudgetPerSecond`, the
 * shared tier) onto the content tier at the 8 : 1 production ratio, issue #111.
 *
 * The ratio exists so an operator who LOWERS the knob lowers both tiers. It is
 * right at the default and in the downward direction, but the desktop's
 * content-read allowance is 512/s in BOTH generations and does not move with
 * the shared line — so the derived value has to stop there. Without the
 * ceiling, `rateBudgetPerSecond: 256` (2.1.7's SHARED figure, and an easy thing
 * to copy) derives 2,048/s, which the limiter compresses to ~1,000/s against a
 * 512/s allowance: half the content reads are refused, each costing a
 * `retryAfterMs` wait plus one replay, and on <=2.1.6 an overrun closes the
 * whole session with 1011.
 *
 * The default case below is deliberately asserted next to the ceiling cases: it
 * is the one datum that REMOVING or raising the cap cannot move (lowering the
 * ceiling below 256 would move it), so a suite that stays green after deleting
 * `Math.min` is proving the ratio, not the cap.
 */
describe('contentBudgetFor: the content tier is capped at the peer\'s 512/s', () => {
  it('derives 8 : 1 from the shared budget at and below the ceiling', () => {
    // Absent injection = the production default: exactly 256/s, no cap involved.
    expect(contentBudgetFor(undefined)).toBe(256)
    expect(contentBudgetFor(32)).toBe(256)
    // 64 × 8 = 512, the ceiling and the last ratio-exact value.
    expect(contentBudgetFor(64)).toBe(512)
  })

  it('stops at 512 however far the shared budget is raised', () => {
    // 65 is the first integer whose raw ratio crosses the ceiling (520): it is
    // the boundary the docs call "above 64", pinned from the other side.
    expect(contentBudgetFor(65)).toBe(512)
    // Every one of these derives ABOVE 512 by the raw ratio (1,024 / 1,032 /
    // 2,048 / 80,000); the desktop allows 512 in either generation.
    expect(contentBudgetFor(128)).toBe(512)
    expect(contentBudgetFor(129)).toBe(512)
    expect(contentBudgetFor(256)).toBe(512)
    expect(contentBudgetFor(10_000)).toBe(512)
  })
})
