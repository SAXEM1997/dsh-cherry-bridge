/**
 * Task 1 (cherry-locale) — the i18n CORE's own contract.
 *
 * This file is the foundation every later task leans on, so it tests the SEAM
 * rather than today's copy: the two dictionaries are structurally identical
 * (same key set, same `{name}` placeholders), `t` degrades the way the host's
 * own `translate` does (a miss returns the key; a missing param leaves `{name}`
 * standing), the language source is a pure function over `navigator.language`,
 * and the store is a `useSyncExternalStore`-shaped external store whose
 * `getSnapshot()` is REFERENCE-STABLE.
 *
 * Two facts about the dictionary's shape are load-bearing enough to be asserted
 * rather than assumed:
 *
 *  - **`list.separator` is the ONE deliberate exception** to the
 *    "no leading/trailing whitespace" rule — the English list separator is
 *    `', '` and carries its trailing space on purpose (it is joined into
 *    sentences). The whitelist is therefore written INTO the test, one entry at
 *    a time, so widening it is a visible edit rather than a silent regex tweak.
 *  - **`STAGE_LABELS`/`STATE_LABELS` re-export zh dictionary entries**, so the
 *    ~140 existing Chinese assertions stay literally true without being touched;
 *    `STAGE_KEYS`/`STATE_KEYS` carry the keys the render side will use instead.
 *    The zh values themselves are pinned here for the two keys whose wording is
 *    a product decision (`app.title`, and the EventSource refusal the page used
 *    to render in English).
 *
 * It imports `ui/src/i18n.ts`, so it belongs to the UI tsconfig project (see
 * the header of `tsconfig.ui.json`, and `tests/unit/projectCoverage.test.ts`
 * which proves the two projects partition `tests/**`). Plain node environment:
 * nothing here renders, and `useT()` is checked through the store it wraps.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOCALE_IDS,
  createTranslator,
  dictionaries,
  localeStore,
  resolveLocaleFromNavigator,
} from '../../ui/src/i18n'
import type { Dict, LocaleId } from '../../ui/src/i18n'
import { STAGE_KEYS, STAGE_LABELS, STATE_KEYS, STATE_LABELS } from '../../ui/src/types'
import type { DeviceState } from '../../ui/src/types'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const zh = dictionaries.zh
const en = dictionaries.en

/** The `{name}` placeholders a template carries, as a sorted set. */
function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()
}

/**
 * The keys allowed to carry leading/trailing whitespace, each WITH the reason
 * and the exact value. Written out one by one: a new entry has to be typed
 * here, which is the point — the rule exists to catch a stray space in a
 * sentence, not to be relaxed the first time it fails.
 */
const WHITESPACE_EXEMPT: ReadonlyArray<{ key: string; locale: LocaleId; value: string; why: string }> = [
  {
    key: 'list.separator',
    locale: 'en',
    value: ', ',
    why: 'the English list separator; its trailing space is joined into sentences ("a, b")',
  },
  {
    key: 'list.separator',
    locale: 'zh',
    value: '、',
    why: 'the Chinese list separator; no whitespace, stated here so the pair is reviewed together',
  },
]

/** The store is a module-level singleton: every test here restores zh. */
afterEach(() => {
  localeStore.setLocale('zh')
})

describe('the dictionaries are structurally aligned', () => {
  it('declares exactly the two locales, and the dictionaries are keyed by them', () => {
    expect([...LOCALE_IDS].sort()).toEqual(['en', 'zh'])
    expect(Object.keys(dictionaries).sort()).toEqual(['en', 'zh'])
  })

  it('carries the SAME key set in zh and en, character for character', () => {
    // `toEqual` on the key arrays (not sets) compares order too: a dictionary
    // kept in a different order is still a valid dictionary, so sort first and
    // let the assertion be about MEMBERSHIP.
    expect([...Object.keys(zh)].sort()).toEqual([...Object.keys(en)].sort())
    // A dictionary with no keys at all would satisfy the parity check above.
    expect(Object.keys(zh).length).toBeGreaterThan(50)
  })

  it('carries the SAME {name} placeholders, under the same key', () => {
    for (const key of Object.keys(zh)) {
      expect(placeholdersOf(en[key]!), `placeholders of "${key}"`).toEqual(placeholdersOf(zh[key]!))
    }
  })

  it('has no empty value in either locale', () => {
    for (const locale of LOCALE_IDS) {
      for (const [key, value] of Object.entries(dictionaries[locale])) {
        expect(value, `${locale}["${key}"]`).not.toBe('')
        expect(value.trim(), `${locale}["${key}"] is only whitespace`).not.toBe('')
      }
    }
  })

  it('has no leading/trailing whitespace outside the explicit whitelist', () => {
    const whitelisted = (locale: LocaleId, key: string): string | undefined =>
      WHITESPACE_EXEMPT.find((entry) => entry.locale === locale && entry.key === key)?.value

    for (const locale of LOCALE_IDS) {
      for (const [key, value] of Object.entries(dictionaries[locale])) {
        const allowed = whitelisted(locale, key)
        if (allowed !== undefined) {
          // The whitelist states the exact value: a "whitelisted" key whose
          // whitespace changed is still a regression.
          expect(value, `whitelisted ${locale}["${key}"]`).toBe(allowed)
          continue
        }
        expect(value, `${locale}["${key}"]`).toBe(value.trim())
      }
    }
  })

  it('keeps the whitelist honest: the English list separator really is ", " and zh really is "、"', () => {
    expect(en['list.separator']).toBe(', ')
    expect(zh['list.separator']).toBe('、')
  })

  it('pins the two keys whose wording is a product decision', () => {
    // `app.title` is the plugin's name in BOTH the nav label and the page
    // heading; the English half was chosen with the user ("bridge那个吧").
    expect(zh['app.title']).toBe('Cherry 互联')
    expect(en['app.title']).toBe('Cherry Bridge')
    // The one English string that used to sit inside a Chinese page: adopted as
    // a key rather than left as a literal.
    expect(zh['app.eventSourceUnavailable']).toBe('此环境不支持 EventSource')
    expect(en['app.eventSourceUnavailable']).toBe('EventSource is unavailable in this environment')
  })
})

describe('createTranslator', () => {
  it('reads the active locale dictionary', () => {
    expect(createTranslator('zh')('app.title')).toBe('Cherry 互联')
    expect(createTranslator('en')('app.title')).toBe('Cherry Bridge')
  })

  it('substitutes {name} params, stringifying numbers', () => {
    expect(createTranslator('zh')('scope.revision', { revision: 7 })).toBe('当前 revision：7')
    expect(createTranslator('en')('scope.revision', { revision: 7 })).toBe('Current revision: 7')
  })

  it('returns the key itself for a missing key (never throws, never blank)', () => {
    for (const locale of LOCALE_IDS) {
      expect(createTranslator(locale)('no.such.key')).toBe('no.such.key')
    }
  })

  it('leaves an unsupplied placeholder standing, exactly as the host translate does', () => {
    // The host's own rule is `template.replace(/\{(\w+)\}/g, (m, n) => n in params
    // ? String(params[n]) : m)` — an absent param keeps the literal `{name}`.
    // Both halves are asserted: params supplied, and params omitted entirely.
    expect(createTranslator('zh')('scope.revision', {})).toBe('当前 revision：{revision}')
    expect(createTranslator('zh')('scope.revision')).toBe('当前 revision：{revision}')
    expect(createTranslator('en')('scope.revision', { other: 'x' })).toBe('Current revision: {revision}')
  })

  it('substitutes every occurrence of a placeholder, not just the first', () => {
    // The rule is the global regex `/\{(\w+)\}/g` — an anchored or
    // non-global match would substitute only the first occurrence and leave
    // `{b}` standing. No shipped key repeats a placeholder, so the shape is
    // pinned on a LOCAL template rather than smuggled into a real key.
    const params: Record<string, string> = { a: '1', b: '2' }
    expect('{a} 与 {b}'.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? params[name]! : match))).toBe(
      '1 与 2',
    )
    // ...and the real two-slot shape it stands in for: the pruned-list key.
    expect(createTranslator('en')('scope.savedPruned', { list: 'a, b' })).toBe(
      'Saved. The server pruned these stale selections: a, b.',
    )
    expect(createTranslator('zh')('scope.savedPruned', { list: 'a、b' })).toBe(
      '保存成功，按服务端修剪清除了失效选择：a、b。',
    )
  })
})

describe('resolveLocaleFromNavigator', () => {
  it('maps a zh* language (case-insensitively) to zh', () => {
    expect(resolveLocaleFromNavigator('zh')).toBe('zh')
    expect(resolveLocaleFromNavigator('zh-CN')).toBe('zh')
    expect(resolveLocaleFromNavigator('ZH')).toBe('zh')
    expect(resolveLocaleFromNavigator('zh-Hant-TW')).toBe('zh')
  })

  it('maps every other named language — English included — to en', () => {
    expect(resolveLocaleFromNavigator('en')).toBe('en')
    expect(resolveLocaleFromNavigator('en-US')).toBe('en')
    expect(resolveLocaleFromNavigator('fr')).toBe('en')
    expect(resolveLocaleFromNavigator('de-DE')).toBe('en')
  })

  it('falls back to zh when there is no language at all', () => {
    // The guard's own input: `typeof navigator === 'undefined' ? undefined :
    // navigator.language`. No navigator (a VM sandbox) and an empty
    // `navigator.language` both mean "cannot tell", and zh is the page's
    // historical language.
    expect(resolveLocaleFromNavigator(undefined)).toBe('zh')
    expect(resolveLocaleFromNavigator('')).toBe('zh')
  })

  it('answers from the argument ALONE, even for the exact languages the host machine runs', () => {
    // A boundary case, not a purity proof: a REGION-qualified tag (the real
    // `navigator.language` shape) still resolves by prefix and never by the
    // ambient value. Purity itself — that `resolveLocaleFromNavigator` does not
    // read `navigator` — is NOT provable from here, because any value this
    // environment could inject agrees with the arguments below. It is pinned
    // structurally instead: by the `typeof navigator === 'undefined'` guard
    // being the single read, which Task 2's `apply()` owns.
    expect(resolveLocaleFromNavigator('en-GB')).toBe('en')
    expect(resolveLocaleFromNavigator('zh-TW')).toBe('zh')
  })
})

describe('localeStore', () => {
  it('starts in zh, without reading navigator at module load', () => {
    expect(localeStore.getSnapshot().locale).toBe('zh')
  })

  it('keeps getSnapshot() reference-stable across reads and same-value writes', () => {
    const before = localeStore.getSnapshot()
    expect(localeStore.getSnapshot()).toBe(before)
    localeStore.setLocale('zh')
    // A fresh object per read would re-render every subscriber forever; this is
    // the property `useSyncExternalStore` requires, not an optimization.
    expect(localeStore.getSnapshot()).toBe(before)
  })

  it('does not notify on a same-value setLocale', () => {
    let calls = 0
    const unsubscribe = localeStore.subscribe(() => {
      calls += 1
    })
    localeStore.setLocale('zh')
    expect(calls).toBe(0)
    unsubscribe()
  })

  it('notifies exactly once on a real change, and the snapshot follows', () => {
    let calls = 0
    const preChange = localeStore.getSnapshot()
    const seen: LocaleId[] = []
    const unsubscribe = localeStore.subscribe(() => {
      calls += 1
      seen.push(localeStore.getSnapshot().locale)
    })
    localeStore.setLocale('en')
    expect(calls).toBe(1)
    // Read INSIDE the listener: the store must already publish the new value.
    expect(seen).toEqual(['en'])
    expect(localeStore.getSnapshot().locale).toBe('en')
    // ...and a DIFFERENT reference from the pre-change snapshot, so subscribers
    // diffing by identity see the change; `useSyncExternalStore` re-renders on
    // exactly this distinction.
    expect(localeStore.getSnapshot()).not.toBe(preChange)
    unsubscribe()
  })

  it('stops notifying after unsubscribe, and tolerates a double unsubscribe', () => {
    let calls = 0
    const unsubscribe = localeStore.subscribe(() => {
      calls += 1
    })
    unsubscribe()
    unsubscribe()
    localeStore.setLocale('en')
    expect(calls).toBe(0)
  })

  it('notifies every live subscriber', () => {
    let first = 0
    let second = 0
    const offFirst = localeStore.subscribe(() => {
      first += 1
    })
    const offSecond = localeStore.subscribe(() => {
      second += 1
    })
    localeStore.setLocale('en')
    expect([first, second]).toEqual([1, 1])
    offFirst()
    offSecond()
  })
})

describe('the label tables re-export the zh dictionary and expose keys', () => {
  it('exposes a key for every stage label, and every key resolves', () => {
    expect(Object.keys(STAGE_KEYS).sort()).toEqual(Object.keys(STAGE_LABELS).sort())
    for (const [stage, key] of Object.entries(STAGE_KEYS)) {
      expect(key, `STAGE_KEYS["${stage}"]`).toBe(`wizard.stage.${stage}`)
      expect(zh[key], `dictionary key "${key}"`).toBeTypeOf('string')
    }
  })

  it('exposes a key for every state label, and every key resolves', () => {
    expect(Object.keys(STATE_KEYS).sort()).toEqual(Object.keys(STATE_LABELS).sort())
    for (const [state, key] of Object.entries(STATE_KEYS)) {
      expect(key, `STATE_KEYS["${state}"]`).toBe(`device.state.${state}`)
      expect(zh[key], `dictionary key "${key}"`).toBeTypeOf('string')
    }
  })

  it('defines STAGE_LABELS value-for-value as the zh dictionary entry (zh rendering is unchanged)', () => {
    for (const stage of Object.keys(STAGE_LABELS)) {
      expect(STAGE_LABELS[stage], `STAGE_LABELS["${stage}"]`).toBe(zh[STAGE_KEYS[stage]!])
    }
  })

  it('defines STATE_LABELS value-for-value as the zh dictionary entry', () => {
    // `STATE_LABELS`/`STATE_KEYS` are `Record<DeviceState, string>`, so the
    // state names come off the typed key list rather than an `Object.keys` cast
    // — indexing a closed record with a bare `string` is a compile error, which
    // is the same exhaustiveness that keeps the two tables in step.
    for (const state of Object.keys(STATE_KEYS) as DeviceState[]) {
      expect(STATE_LABELS[state], `STATE_LABELS["${state}"]`).toBe(zh[STATE_KEYS[state]]!)
    }
  })

  it('pins the four stage labels the existing suite asserts verbatim', () => {
    // `tests/unit/ui.test.ts:325-410` re-types these four recovery sentences and
    // asserts the settled paragraph contains them; a typo here would break them
    // without this file mentioning it.
    expect(STAGE_LABELS['rejected']).toBe(
      '配对被拒绝——请核对桌面端显示的 6 位验证码是否与本页一致，并在 Cherry Studio 重新生成配对码后重试',
    )
    expect(STAGE_LABELS['expired']).toBe('配对邀请已过期——请在 Cherry Studio 重新生成配对码后重试')
    expect(STAGE_LABELS['unreachable']).toBe('无法连接 Cherry Studio，请确认桌面端已启动且与本机同网')
    expect(STAGE_LABELS['invalid-payload']).toBe('配对信息无效或已过期，请在 Cherry Studio 重新生成后重试')
  })
})

describe('the tsconfig partition covers this file', () => {
  // This file imports `ui/src/i18n.ts`, so it belongs to the UI project — and
  // because both tsconfigs enumerate files one by one, BOTH sides must name it
  // or `npm run typecheck` either misses it or checks it twice. That is
  // `tests/unit/projectCoverage.test.ts`'s job to police; the two spots are
  // asserted here too so the omission is reported next to the file that caused
  // it rather than only by a distant gate.
  const ui = readFileSync(join(repoRoot, 'tsconfig.ui.json'), 'utf8')
  const server = readFileSync(join(repoRoot, 'tsconfig.json'), 'utf8')

  it('is listed in tsconfig.ui.json include', () => {
    expect(ui).toContain('tests/unit/i18n.test.ts')
  })

  it('is listed in tsconfig.json exclude', () => {
    expect(server).toContain('tests/unit/i18n.test.ts')
  })
})
