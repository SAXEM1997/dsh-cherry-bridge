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

/**
 * Issue #80: the CONTENT dimension of the same symmetry #76 bounded by LENGTH.
 *
 * `messageResumeToken` filtered a peer answer through `optionalString` (which
 * rejects `''` and nothing else), while `parseMessageResume` refuses any
 * remainder `mangledRemainder` calls mangled. A peer page whose `nextCursor` was
 * `' 4 '` — schema-legal, `opaqueId` only forbids lone surrogates — therefore
 * minted `cursor: 4 `, a token the same tool refuses on replay. Both arms have
 * this hole, so both are pinned here on the pure function.
 *
 * What `mangledRemainder` actually refuses, precisely: a remainder that is empty,
 * that is not equal to its own `.trim()` (leading/trailing whitespace), or that
 * carries a control character ANYWHERE. An interior plain space is legal and
 * round-trips — the guard is not "no whitespace".
 */
describe('issue #80: the message token is never minted from a mangled remainder', () => {
  /** A page the walk stopped INSIDE: items were left, so the `after:` arm is taken. */
  const stoppedInside = (): CherryPage<unknown> => ({ items: ['m-0', 'm-1'], truncated: true })

  /** A page the walk consumed whole: its own position is the stop point. */
  const consumedWhole = (nextCursor: string): CherryPage<unknown> => ({
    items: ['m-0', 'm-1'],
    truncated: true,
    nextCursor,
  })

  it('names no `cursor:` position with padding or a control character', () => {
    // Leading/trailing whitespace: `' 4 '` is what a peer padding its opaque
    // position produces, and it used to mint `cursor: 4 `.
    expect(messageResumeToken(consumedWhole(' 4 '), 2, 'm-1')).toBeUndefined()
    // A control character ANYWHERE, including the middle.
    expect(messageResumeToken(consumedWhole('4\u0000'), 2, 'm-1')).toBeUndefined()
    // The clean position on the same shape is still named.
    expect(messageResumeToken(consumedWhole('4'), 2, 'm-1')).toBe('cursor:4')
    // An INTERIOR plain space is legal: only the ENDS are judged.
    expect(messageResumeToken(consumedWhole('4 5'), 2, 'm-1')).toBe('cursor:4 5')
  })

  it('names no `after:` anchor with padding or a control character', () => {
    expect(messageResumeToken(stoppedInside(), 1, ' m-1 ')).toBeUndefined()
    expect(messageResumeToken(stoppedInside(), 1, 'm\u00071')).toBeUndefined()
    // The clean anchor on the same shape is still named.
    expect(messageResumeToken(stoppedInside(), 1, 'm-1')).toBe('after:m-1')
    // Interior space, same rule as the cursor arm.
    expect(messageResumeToken(stoppedInside(), 1, 'a b')).toBe('after:a b')
  })
})
