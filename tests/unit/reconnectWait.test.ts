import { describe, expect, it } from 'vitest'
import { reconnectWait } from '../../src/connection.js'

/**
 * Issue #21: the reconnect wait one read is granted, and WHICH bound shortened
 * it.
 *
 * The two answers must come from the RAW remaining time. The wait is ceiled for
 * `setTimeout` (which truncates a fractional delay, and a budget-capped wait
 * firing early would report the deadline as expired sub-ms before it is), so a
 * raw remaining just under the allowance produces a wait EQUAL to the
 * allowance — and a caller that re-derived the attribution from that timer value
 * would report a spent budget as a plain transport loss. The wait faces convert
 * only the deadline class into the graceful stop that keeps their partial
 * content, so the difference is a result shape, not cosmetics.
 *
 * These are the boundary cases the full suite cannot reach: the window is one
 * millisecond of `performance.now()` arithmetic, and an integration test cannot
 * place a link failure inside it.
 */
describe('issue #21: reconnectWait — the wait and its binding bound', () => {
  it('uses the allowance when it is the shorter bound (or when there is no deadline)', () => {
    expect(reconnectWait(undefined, 5_000)).toEqual({ waitMs: 5_000, deadlineCapped: false })
    // Exactly equal is NOT capped: neither bound is shorter than the other.
    expect(reconnectWait(5_000, 5_000)).toEqual({ waitMs: 5_000, deadlineCapped: false })
    expect(reconnectWait(9_000, 5_000)).toEqual({ waitMs: 5_000, deadlineCapped: false })
  })

  it('caps by the remaining budget and reports the deadline as the binding bound', () => {
    expect(reconnectWait(200, 5_000)).toEqual({ waitMs: 200, deadlineCapped: true })
    // A sub-millisecond remainder still waits 1 ms: a timer of 0 is immediate,
    // which would turn "one last look" into "no wait at all".
    expect(reconnectWait(0.4, 5_000)).toEqual({ waitMs: 1, deadlineCapped: true })
  })

  it('attributes a CEILED wait that EQUALS the allowance to the deadline', () => {
    // The reviewed bug (delta review of 5701675): ceil(4,999.4) === 5,000, so
    // `waitMs < allowance` says "allowance" while the deadline was shorter.
    expect(reconnectWait(4_999.4, 5_000)).toEqual({ waitMs: 5_000, deadlineCapped: true })
    expect(reconnectWait(4_999.000_1, 5_000)).toEqual({ waitMs: 5_000, deadlineCapped: true })
  })
})
