import { describe, expect, it } from 'vitest'
import { dictionaries } from '../../ui/src/i18n'

/**
 * The two dictionaries are ONE dictionary in two languages, and nothing checked
 * that until this file existed.
 *
 * The failure this prevents is not a typo: it is `t()`'s contract. A key missing
 * from `en` renders the KEY ITSELF on the English page (`scope.empty.selected`
 * as a visible string), and a translation that drops a `{placeholder}` renders a
 * sentence with `{revision}` standing in it or a number silently missing. Both
 * look like a broken page rather than a missing translation, and neither is
 * visible from the Chinese side — which is where the work is done.
 *
 * The host's own `translate` behaves the same way on a miss, so this is also the
 * guarantee that a key that works here would work there.
 */
describe('the zh and en dictionaries are in step', () => {
  const zh = Object.keys(dictionaries.zh).sort()
  const en = Object.keys(dictionaries.en).sort()

  it('① carries exactly the same keys', () => {
    // Both directions in one comparison: a key only in `en` reds as loudly as
    // one only in `zh`, because either way one page renders a raw key.
    expect(en).toEqual(zh)
  })

  it('② has no blank value in either language', () => {
    for (const locale of ['zh', 'en'] as const) {
      const dictionary = dictionaries[locale]
      for (const key of Object.keys(dictionary)) {
        expect(dictionary[key]?.trim().length ?? 0, `${locale}: ${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('③ uses the SAME placeholder set on both sides', () => {
    // The subtle half. A translation may reorder a sentence freely — that is why
    // a sentence is one key — but it may not drop or invent a placeholder: a
    // missing `{revision}` renders a sentence that quietly lost its number, and
    // an invented one renders the literal braces on screen.
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()
    for (const key of zh) {
      expect(placeholders(dictionaries.en[key] ?? ''), key).toEqual(placeholders(dictionaries.zh[key] ?? ''))
    }
  })
})
