import { describe, expect, it } from 'vitest'
import { MAX_RESUME_TOKEN_CHARS } from '../../src/defaults.js'
import { messageResumeToken } from '../../src/tools.js'
import type { CherryPage } from '../../src/tools.js'

/**
 * Issue #76, the arm an integration test cannot reach.
 *
 * Both emitters run their FINAL token string through `withinResumeTokenCeiling`.
 * The `cursor:` arm and the list face are driven end to end by
 * `tests/integration/toolsReadResume.test.ts` ⑭a/⑭b and `tests/integration/
 * toolsRead.test.ts` ⑦h. The `after:` arm is different: its anchor is a message
 * ID, and projecting that message sends the same id to `agent.parts.list`, whose
 * `messageId` is an `opaqueId` (256 characters). A peer item carrying an id above
 * the ceiling therefore fails its parts walk and is never RETURNED, so no walk
 * can reach the point of naming it — the state is unreachable THROUGH THE
 * PROTOCOL, not merely untested. The guard is still required (the emitter must
 * never mint what the parser refuses, whatever the peer's cap becomes), so it is
 * pinned here, on the pure function, where the ceiling is a fact about the
 * string and nothing else.
 */
describe('issue #76: the message token is never minted past the ceiling', () => {
  /** A page the walk stopped INSIDE: items were left, so the `after:` arm is taken. */
  const stoppedInside = (): CherryPage<unknown> => ({ items: ['m-0', 'm-1'], truncated: true })

  /** The same stop reached by a peer that OVERSHOT the requested page. */
  const overshot = (): CherryPage<unknown> => ({
    items: ['m-0', 'm-1'],
    truncated: true,
    pageOverflow: true,
  })

  /** A page the walk consumed whole: its own position is the stop point. */
  const consumedWhole = (nextCursor: string): CherryPage<unknown> => ({
    items: ['m-0', 'm-1'],
    truncated: true,
    nextCursor,
  })

  it('names no `after:` anchor whose token would exceed the ceiling', () => {
    const overLong = 'x'.repeat(MAX_RESUME_TOKEN_CHARS - 'after:'.length + 1)
    expect(`after:${overLong}`).toHaveLength(MAX_RESUME_TOKEN_CHARS + 1)
    // BOTH routes into the anchor arm: items trimmed from the window, and a page
    // the peer overshot.
    expect(messageResumeToken(stoppedInside(), 1, overLong)).toBeUndefined()
    expect(messageResumeToken(overshot(), 2, overLong)).toBeUndefined()
  })

  it('still names an `after:` anchor EXACTLY at the ceiling — the comparison is `<=`', () => {
    const atCeiling = 'x'.repeat(MAX_RESUME_TOKEN_CHARS - 'after:'.length)
    expect(messageResumeToken(stoppedInside(), 1, atCeiling)).toBe(`after:${atCeiling}`)
  })

  it('names no `cursor:` position whose token would exceed the ceiling', () => {
    const overLong = '9'.repeat(MAX_RESUME_TOKEN_CHARS - 'cursor:'.length + 1)
    expect(messageResumeToken(consumedWhole(overLong), 2, 'm-1')).toBeUndefined()
  })

  it('still names a `cursor:` position exactly at the ceiling', () => {
    const atCeiling = '9'.repeat(MAX_RESUME_TOKEN_CHARS - 'cursor:'.length)
    expect(messageResumeToken(consumedWhole(atCeiling), 2, 'm-1')).toBe(`cursor:${atCeiling}`)
  })

  it('leaves the ordinary cases alone: short anchor, short position, nothing to name', () => {
    expect(messageResumeToken(stoppedInside(), 1, 'm-1')).toBe('after:m-1')
    expect(messageResumeToken(consumedWhole('20'), 2, 'm-1')).toBe('cursor:20')
    expect(messageResumeToken(stoppedInside(), 1, undefined)).toBeUndefined()
    expect(messageResumeToken(consumedWhole(''), 2, 'm-1')).toBeUndefined()
  })
})
