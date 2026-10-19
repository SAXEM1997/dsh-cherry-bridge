import { describe, expect, it } from 'vitest'
import { MAX_RESUME_TOKEN_CHARS } from '../../src/defaults.js'
import { messageResumeToken, parseMessageResume } from '../../src/tools.js'
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

/**
 * Issue #85: the third refusal a `cursor:` remainder can meet.
 *
 * `parseMessageResume` has TWO checks in its `cursor:` branch — `mangledRemainder`
 * (#80) and `looksLikeV1ListToken` (#72) — and the emitter mirrored only the
 * first. A peer position that IS our retired v1 list-token shape (colon-free
 * base64url of `{v,m,d,h,p}`) would therefore be wrapped into `cursor:<shape>`,
 * and the same tool would answer it with "issued by an older plugin version"
 * about a token it had just printed.
 *
 * The asymmetry in the opposite direction is deliberate and pinned here too: the
 * `after:` branch of the parser never consults the detector, so an ANCHOR of that
 * shape is a token it accepts — the emitter must keep naming it.
 */
describe('issue #85: the retired-format detector is mirrored where the parser applies it', () => {
  /** Exactly what a v1 list token's payload looked like: colon-free base64url JSON. */
  const v1Shaped = Buffer.from(
    JSON.stringify({ v: 1, m: 'agent.sessions.list', d: 'dev-A', h: '0'.repeat(16), p: '2' }),
    'utf8',
  ).toString('base64url')

  const consumedWhole = (nextCursor: string): CherryPage<unknown> => ({
    items: ['m-0', 'm-1'],
    truncated: true,
    nextCursor,
  })
  const stoppedInside = (): CherryPage<unknown> => ({ items: ['m-0', 'm-1'], truncated: true })

  it('the fixture really is colon-free base64url JSON carrying `v: 1`', () => {
    // Guards the TEST: if this ever stopped being the shape the detector looks
    // for, the two assertions below would pass for the wrong reason.
    expect(v1Shaped).not.toContain(':')
    expect(JSON.parse(Buffer.from(v1Shaped, 'base64url').toString('utf8'))).toMatchObject({ v: 1 })
  })

  it('names no `cursor:` position shaped like a v1 list token', () => {
    expect(messageResumeToken(consumedWhole(v1Shaped), 2, 'm-1')).toBeUndefined()
    // ...while an ordinary position of the same SHAPE (colon-free, base64url-ish,
    // same length budget) is still named — the guard rejects the format, not
    // "anything that decodes".
    expect(messageResumeToken(consumedWhole('Zm9vYmFy'), 2, 'm-1')).toBe('cursor:Zm9vYmFy')
  })

  it('STILL names an `after:` anchor of that shape — the parser accepts it back', () => {
    // Over-refusal tripwire: `parseMessageResume`'s `after:` branch runs
    // `mangledRemainder` and nothing else. Applying the detector to the anchor
    // would refuse a token the tool takes, which is the mirror of this issue.
    expect(messageResumeToken(stoppedInside(), 1, v1Shaped)).toBe(`after:${v1Shaped}`)
  })
})

/**
 * Issue #85, the part that makes "we mirrored every refusal" checkable rather
 * than promised.
 *
 * The invariant the whole token design rests on is one-directional: every token
 * an emitter NAMES must be one its parser ACCEPTS (`emitted => accepted`).
 * Over-refusal is allowed — refusing to name something replayable only costs
 * resumability — but the reverse is the bug every issue in this family fixed
 * (#76 length, #80 content, #85 retired format): the caller holds a token the
 * tool then refuses, with a diagnosis about the wrong thing.
 *
 * So the property is asserted over a PROBE TABLE instead of per-clause: whatever
 * refusal the parser grows, any probe shape that hits it turns this red without
 * anyone remembering to mirror it. The table is deliberately varied (numeric,
 * keyset, unicode, interior space, base64url-shaped, the retired v1 payload) and
 * the non-vacuity count stops "refuse everything" from passing.
 */
describe('issue #85: every token these emitters name is one the parser accepts', () => {
  const consumedWhole = (nextCursor: string): CherryPage<unknown> => ({
    items: ['m-0', 'm-1'],
    truncated: true,
    nextCursor,
  })
  const stoppedInside = (messageId: string): CherryPage<unknown> => ({ items: ['m-0', 'm-1'], truncated: true })

  const V1_SHAPED = Buffer.from(
    JSON.stringify({ v: 1, m: 'agent.sessions.list', d: 'dev-A', h: '0'.repeat(16), p: '2' }),
    'utf8',
  ).toString('base64url')

  /** Every shape a real (or adversarial) peer position could take. */
  const POSITIONS = [
    '20',
    '0',
    'entity:1757923200000:9c1f0a2e-6b3d-4a71-8f55-2d6e0b1c7a44',
    '4 5', // interior plain space: legal
    '编号-①',
    '😀id',
    'Zm9vYmFy', // base64url-shaped but not our format
    'MTIz', // base64url of the JSON scalar 123
    '', // empty: refused by both sides
    ' 4 ', // padding: refused by both sides
    '4\u00007', // control char: refused by both sides
    V1_SHAPED, // retired v1 payload: refused by both sides
  ]

  it('emitted => accepted, for every probed POSITION (and nothing is named in a way the parser refuses)', () => {
    let named = 0
    for (const position of POSITIONS) {
      const token = messageResumeToken(consumedWhole(position), 2, 'm-1')
      if (token === undefined) continue
      named += 1
      // The property: the parser must take back the exact string just minted.
      expect(() => parseMessageResume(token), `emitter named ${JSON.stringify(token)}`).not.toThrow()
    }
    // Non-vacuity: most of the table is legal, so a "refuse everything" emitter
    // (or a table that drifted into all-illegal shapes) cannot pass.
    expect(named).toBeGreaterThanOrEqual(7)
  })

  it('emitted => accepted, for every probed ANCHOR', () => {
    let named = 0
    for (const messageId of ['m-1', 'a b', '编号-①', '😀id', V1_SHAPED, '', ' m-1 ']) {
      const token = messageResumeToken(stoppedInside(messageId), 1, messageId)
      if (token === undefined) continue
      named += 1
      expect(() => parseMessageResume(token), `emitter named ${JSON.stringify(token)}`).not.toThrow()
    }
    expect(named).toBeGreaterThanOrEqual(4)
  })
})
