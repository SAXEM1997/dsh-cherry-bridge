import { describe, expect, it } from 'vitest'
import { boundedJoin, clipText } from '../../src/text.js'

/**
 * The ONE bounded-rendering helper (issue #155). Every face that interpolates
 * peer- or payload-controlled text into a log line or a verdict renders it
 * through `clipText` / `boundedJoin`, so the helper's own edge cases are pinned
 * here rather than re-derived per site: the marker's exact shape, the fixed
 * point that makes the kept prefix the LARGEST that fits, the too-small room,
 * and the lone-surrogate guard (a clip must never emit half of a UTF-16
 * surrogate pair).
 */
describe('clipText', () => {
  it('returns text at or under the bound BYTE FOR BYTE', () => {
    expect(clipText('abc', 3)).toBe('abc')
    expect(clipText('abc', 4)).toBe('abc')
    expect(clipText('', 0)).toBe('')
    // No marker may appear on text that was never clipped: a silently clipped
    // line reads as the peer's actual text, and a marker on an intact one is
    // noise an operator learns to ignore.
    expect(clipText('x'.repeat(240), 240)).toBe('x'.repeat(240))
  })

  it('clips over-long text with the explicit `… (+N chars)` marker', () => {
    const text = 'x'.repeat(300)
    const clipped = clipText(text, 240)

    expect(clipped).toMatch(/… \(\+\d+ chars\)$/)
    // The kept prefix is the text's own prefix, not a rewritten string.
    expect(text.startsWith(clipped.slice(0, clipped.indexOf('…')))).toBe(true)
    // The marker names a REAL removal: the count is the number of characters
    // dropped, not a constant.
    const removed = Number(/… \(\+(\d+) chars\)$/.exec(clipped)![1])
    expect(removed).toBe(text.length - clipped.indexOf('…'))
  })

  it('is a FIXED POINT: the marker own digits are charged to the budget', () => {
    // 300 -> kept 227, removal 73 (2 digits): 227 + marker 13 = 240 exactly.
    expect(clipText('x'.repeat(300), 240)).toBe(`${'x'.repeat(227)}… (+73 chars)`)
    expect(clipText('x'.repeat(300), 240).length).toBe(240)

    // THE DISCRIMINATING CASE, where the fixed point and a one-shot estimate
    // part ways. At 249 chars into 240 the removal AT the bound has one digit
    // (9), but the removal the kept prefix actually produces has two (21), so a
    // helper that computed the marker once from `length - max` would keep 228
    // and then need a 13-char marker for 21 -> 241 characters, one OVER the
    // bound. The loop re-derives 227 + `… (+22 chars)` = 240.
    expect(clipText('x'.repeat(249), 240)).toBe(`${'x'.repeat(227)}… (+22 chars)`)
    expect(clipText('x'.repeat(249), 240).length).toBe(240)
  })

  it('admits the loss with a bare ellipsis when the room cannot carry the marker', () => {
    // 10 chars into 5: the marker alone is 12+ characters, so the bound cannot
    // be honoured AND the removal counted. The bare ellipsis says "clipped"
    // without overrunning the segment bound.
    expect(clipText('x'.repeat(10), 5)).toBe('…')
    // The degenerate rooms cannot exceed the bound either.
    expect(clipText('x'.repeat(10), 1)).toBe('…')
    expect(clipText('x'.repeat(10), 0)).toBe('')
  })

  it('never emits a lone surrogate when the clip point lands inside a pair', () => {
    // 😀 is ONE code point / FOUR UTF-8 bytes / TWO UTF-16 units. At room 30
    // the fixed point is kept 17: text.charCodeAt(16) is the high half and
    // charCodeAt(17) the low half, so a naive slice(0, 17) ends with a lone
    // high surrogate — invalid unicode text that would travel in a verdict.
    const high = '\uD83D'
    const low = '\uDE00'
    const text = `${'a'.repeat(16)}${high}${low}${'b'.repeat(42)}`
    expect(text.length).toBe(60)
    // The pair sits EXACTLY on the naive clip point, which is what makes this
    // fixture reach the guard instead of merely passing near it.
    expect(text.charCodeAt(16)).toBe(0xd83d)
    expect(text.charCodeAt(17)).toBe(0xde00)

    const clipped = clipText(text, 30)

    // One character was dropped to avoid the split; the marker was re-derived
    // from the new removed count (44), so the result still fits the room.
    expect(clipped).toBe(`${'a'.repeat(16)}… (+44 chars)`)
    expect(clipped.length).toBeLessThanOrEqual(30)
    // No lone high or low surrogate anywhere in the rendered text.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped)).toBe(false)
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clipped)).toBe(false)
  })
})

describe('boundedJoin', () => {
  it('renders an empty list as the empty string', () => {
    expect(boundedJoin([], { max: 240, itemMax: 64 })).toBe('')
  })

  it('clips each item to itemMax before the fitting accounting', () => {
    const clipped = boundedJoin(['x'.repeat(100)], { max: 50, itemMax: 20 })
    // ONE item, no omission: the entry-level clip is the only bound here.
    expect(clipped.length).toBe(20)
    expect(clipped).toMatch(/… \(\+\d+ chars\)$/)
    // No LIST-omission marker: nothing was left out, so a `(+K more)` here
    // would count an entry that is right there.
    expect(clipped).not.toMatch(/ \(\+\d+ more\)$/)
    expect(clipped.slice(0, 1)).toBe('x')
  })

  it('pins the exact fit boundary: used + item + 2 == max fits, +1 does not', () => {
    // 4 + ', ' + 2 = 8, exactly the budget.
    expect(boundedJoin(['abcd', 'ef'], { max: 8, itemMax: 8 })).toBe('abcd, ef')
    // 4 + ', ' + 3 = 9: one over, so the second entry is NOT named and the
    // count says so.
    expect(boundedJoin(['abcd', 'efg'], { max: 8, itemMax: 8 })).toBe('abcd (+1 more)')
  })

  it('counts every entry it did not name in `(+K more)`', () => {
    const items = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee']
    // 4 + 2 + 4 = 10 for the second; the third would make 16 > 10.
    expect(boundedJoin(items, { max: 10, itemMax: 8 })).toBe('aaaa, bbbb (+3 more)')
    // The marker rides ON TOP of the budget: it is a count, not an item, so
    // the named text never has to absorb its length.
    const text = boundedJoin(items, { max: 10, itemMax: 8 })
    expect(text.slice(0, -' (+3 more)'.length).length).toBeLessThanOrEqual(10)
  })
})
