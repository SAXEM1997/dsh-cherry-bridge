// @vitest-environment jsdom
/**
 * Task 2 (cherry-locale) — the HOST WIRING contract of `main.tsx`'s `apply()`.
 *
 * Task 1 built the localization ENGINE (`ui/src/i18n.ts`) but left every
 * consumption site alone: `apply()` still registered a constant Chinese label
 * and every component still rendered Chinese literals. This file pins the half
 * Task 2 owns — the ONE place the plugin is allowed to look at the host's
 * locale service:
 *
 *  - **the navigator fallback is evaluated exactly once**, at the top of
 *    `apply()`, behind a `typeof navigator === 'undefined'` guard (a VM sandbox
 *    with no `navigator` must not throw before the page registers), and the
 *    SAME value serves both the "no host locale service" branch and the
 *    "the host named a language outside the whitelist" branch;
 *  - **the host service is read through `ctx.get('locale')`** with a SHAPE
 *    check, never through `ctx.locale` (cordis gates an undeclared service
 *    behind a throwing getter, so a property read would take the whole page
 *    down on a host without the provider). Anything that is not exactly
 *    `{ getLocale(), subscribe() }` counts as ABSENT;
 *  - **the registration carries no `locale` field**: localization is not a
 *    second, parallel registration path — the label callback plus the store is
 *    the whole mechanism (declaring `locale` in `inject` would additionally
 *    make a host without the provider fail the entire Web GUI boot);
 *  - **the label resolves through the CACHED host reference** that BOTH
 *    `apply()`'s probe and the `slots.inject` re-probe write. A cached host is
 *    read DIRECTLY (`getLocale().active`) on every call, so a label asked
 *    before our own listener has fired still answers correctly; with no cached
 *    host the label reads `localeStore`;
 *  - **failure never escapes `apply()`**: a `getLocale()`/`subscribe()` that
 *    throws is caught, warned about, and degraded to "no localization" (the
 *    page still renders), and teardown is idempotent.
 *
 * ## Three fixture choices that are not cosmetic
 *
 * 1. **The registered component is a local MARKER component**, not the real
 *    `App`. Task 3/4 have not localized the components yet — they still render
 *    Chinese literals — so asserting the page's English copy here would assert
 *    a future task's work. The marker renders `t('app.title')` through the
 *    plugin's own `useT()`, which is exactly the channel a localized component
 *    will use, so this file pins the HOST-side wiring (does a host locale reach
 *    a component's translator, without a remount?) without pretending to pin
 *    Task 4's copy.
 * 2. **The fake host service's `getLocale()` reads a live variable**, so a test
 *    can make the host speak a different language at any point — and the fake's
 *    `subscribe` delegates to the real `localeStore`, which is the arrangement
 *    a real host wiring has (the host announces; the plugin's store is what
 *    components read). Nothing here rewrites `navigator.language`: jsdom's
 *    `navigator` has no such setter, and adding one would be a fixture
 *    pretending to be the host.
 * 3. **`slots.inject` does NOT run its callback synchronously.** The real
 *    service may defer it until the slot exists, and the re-probe only means
 *    something if a test can control when the slot arrives — `slots.openSlot()`
 *    is that control.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { dictionaries, localeStore, useT } from '../../ui/src/i18n'
import { apply, SETTINGS_SLOT } from '../../ui/src/main'
import type { ClientContext, SlotRegistration, SlotsService } from '../../ui/src/main'

// `app.title` is the one key this file leans on: it is the settings section's
// own name, it exists in both dictionaries, and Task 1 pinned both values.
const ZH_TITLE = dictionaries.zh['app.title']!
const EN_TITLE = dictionaries.en['app.title']!

/**
 * The marker component standing in for a localized settings page.
 *
 * It reads the plugin's own `useT()`, so it is subscribed to `localeStore` in
 * exactly the way Task 3/4 will make the real components — no host access and
 * no props from the registration.
 */
function LocaleMarker(): ReturnType<typeof Object> {
  const t = useT()
  return createElement('div', { 'data-marker': 'locale' }, t('app.title'))
}

/** Records what the bundle registers, and defers the inject callback. */
class FakeSlots implements SlotsService {
  readonly injected: string[] = []
  readonly registrations: Array<{ options: SlotRegistration; component: ComponentType }> = []
  disposed = 0
  private deferred: (() => void | (() => void)) | undefined

  inject(slot: string, callback: () => void | (() => void)): void {
    this.injected.push(slot)
    this.deferred = callback
  }

  register(options: SlotRegistration, component: ComponentType): () => void {
    this.registrations.push({ options, component })
    return () => {
      this.disposed += 1
    }
  }

  /** The slot became available: run the callback the way the host would. */
  openSlot(): void {
    const dispose = this.deferred?.()
    if (typeof dispose === 'function') this.lastInjectDisposer = dispose
  }

  /** The disposer the inject callback returned, if the host took one. */
  lastInjectDisposer: (() => void) | undefined

  /** The first registration, or undefined while the callback has not run. */
  get registration(): { options: SlotRegistration; component: ComponentType } | undefined {
    return this.registrations[0]
  }
}

/** A stand-in for the host's `locale` service, shape-checked by `apply()`. */
function fakeLocaleService(options: {
  /** The active locale the host reports, read live on every `getLocale()`. */
  active: () => string
  subscribe?: (listener: () => void) => () => void
  getLocaleThrows?: boolean
  subscribeThrows?: boolean
}): unknown {
  return {
    getLocale(): { active: string } {
      if (options.getLocaleThrows === true) throw new Error('host getLocale exploded')
      return { active: options.active() }
    },
    subscribe(listener: () => void): () => void {
      if (options.subscribeThrows === true) throw new Error('host subscribe exploded')
      // The default HOST subscription is deliberately NOT `localeStore`'s own
      // listener: the host announces by calling back, and the plugin is what
      // writes the store (`probe()` does it). Delegating to the store directly
      // would wire the store to itself and prove nothing. When a test supplies
      // its own `subscribe`, that is the wiring under test.
      return (options.subscribe ?? (() => () => {}))(listener)
    },
  }
}

/**
 * A host service whose `subscribe` behaves like a real one: it records the
 * listener and returns an unsubscribe that removes it — nothing else. The
 * plugin is what writes `localeStore` from the host's answer.
 */
function announcingLocaleService(active: () => string): {
  service: unknown
  listeners: Set<() => void>
} {
  const listeners = new Set<() => void>()
  return {
    service: {
      getLocale: () => ({ active: active() }),
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    listeners,
  }
}

/** The host announces: every listener it holds is called, as the real one does. */
function announce(service: { listeners: Set<() => void> }): void {
  for (const listener of [...service.listeners]) listener()
}

/**
 * Runs `apply` against a fresh fake `slots` service.
 *
 * Every ctx is built INSIDE the call, so the captured inject callback never
 * closes over a variable an outer loop could change between rounds.
 */
function applyWith(options: {
  /** The value `ctx.get('locale')` answers; ignored unless `hasGet`. */
  localeService?: unknown
  /** Whether the ctx offers `get` at all (absent = the VM/legacy ctx shape). */
  hasGet?: boolean
}): { slots: FakeSlots; teardown: (() => void) | undefined; getCalls: string[] } {
  const slots = new FakeSlots()
  const getCalls: string[] = []
  let teardown: (() => void) | undefined

  const ctx: ClientContext = {
    slots,
    effect: (callback: () => void | (() => void)) => {
      teardown = callback() ?? undefined
    },
  }
  if (options.hasGet === true) {
    ctx.get = (name: string): unknown => {
      getCalls.push(name)
      return name === 'locale' ? options.localeService : undefined
    }
  }

  apply(ctx)
  return { slots, teardown, getCalls }
}

/** Silences (and records) the console noise a degraded wiring produces. */
function quietConsole(): { warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn()
  vi.spyOn(console, 'warn').mockImplementation(warn)
  return { warn }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // The store is a module-level singleton: every case starts from the page's
  // historical default so no test inherits another's language.
  localeStore.setLocale('zh')
})

// ---------------------------------------------------------------------------
// A host that provides a locale service
// ---------------------------------------------------------------------------

describe('a host that provides a locale service', () => {
  it('adopts the host locale for the store and for the label', () => {
    const { slots } = applyWith({ hasGet: true, localeService: fakeLocaleService({ active: () => 'en' }) })
    slots.openSlot()

    // The store is what every `useT()` consumer reads.
    expect(localeStore.getSnapshot().locale).toBe('en')
    // The label takes the host's answer DIRECTLY, not the store's: the shell
    // asks for its nav item before any React commit has run.
    expect(slots.registration?.options.label()).toBe(EN_TITLE)
    expect(slots.disposed).toBe(0)
  })

  it('follows a locale change the host announces, without remounting the page', async () => {
    let active = 'zh'
    const host = announcingLocaleService(() => active)

    const { slots } = applyWith({ hasGet: true, localeService: host.service })
    slots.openSlot()

    // The registration's own component IS the real `App`, whose copy Task 3/4
    // localize; what this case pins is that the HOST-side wiring reaches a
    // `useT()` consumer at all, so it renders the marker through the same
    // channel. The registration's component identity is asserted separately
    // (tests/unit/ui.test.ts renders it as the settings page).
    expect(slots.registration?.component).toBeTypeOf('function')
    render(createElement(LocaleMarker))
    expect(screen.getByText(ZH_TITLE)).toBeTruthy()

    // The host announces a new language exactly as a real `locale` service
    // does: it flips its own state and calls the listener the plugin handed it.
    active = 'en'
    announce(host)

    await waitFor(() => expect(screen.getByText(EN_TITLE)).toBeTruthy())
    // No remount: the same single node re-rendered in place.
    expect(screen.getAllByText(EN_TITLE)).toHaveLength(1)
    // The label follows the announcement too, off the cached host reference.
    expect(slots.registration?.options.label()).toBe(EN_TITLE)
  })

  it('answers the label from the host even when called before our listener fires', () => {
    // The ordering hazard: the shell may ask for the nav label in the same tick
    // it announced the change, BEFORE the plugin's store listener has run
    // (react-dom calls `getSnapshot` synchronously inside `handleStoreChange`,
    // and the shell can ask even earlier). Reading the host directly makes that
    // still correct.
    let active = 'zh'
    const host = announcingLocaleService(() => active)
    const { slots } = applyWith({ hasGet: true, localeService: host.service })
    slots.openSlot()

    expect(slots.registration?.options.label()).toBe(ZH_TITLE)

    // The host changed its answer; the plugin's store has NOT been told yet —
    // this is the pre-listener instant (`announce` has not run).
    active = 'en'
    expect(localeStore.getSnapshot().locale).toBe('zh')
    expect(slots.registration?.options.label()).toBe(EN_TITLE)

    // Once the listener does run, the store and the label agree.
    announce(host)
    expect(localeStore.getSnapshot().locale).toBe('en')
    expect(slots.registration?.options.label()).toBe(EN_TITLE)
  })
})

// ---------------------------------------------------------------------------
// A host without a usable locale service
// ---------------------------------------------------------------------------

describe('a host without a usable locale service', () => {
  it.each<[string, { hasGet?: boolean; localeService?: unknown }]>([
    ['the ctx has no get at all', {}],
    ['get answers undefined', { hasGet: true, localeService: undefined }],
    ['the answer is a primitive', { hasGet: true, localeService: 42 }],
    ['the answer is null', { hasGet: true, localeService: null }],
    ['getLocale is not a function', { hasGet: true, localeService: { getLocale: 'nope', subscribe: () => () => {} } }],
    ['subscribe is not a function', { hasGet: true, localeService: { getLocale: () => ({ active: 'en' }) } }],
    ['subscribe is missing entirely', { hasGet: true, localeService: { getLocale: () => ({ active: 'en' }), subscribe: {} } }],
  ])('degrades to no localization when %s', (_name, options) => {
    const { slots } = applyWith(options)
    expect(() => slots.openSlot()).not.toThrow()

    // jsdom's own `navigator.language` is `en-US`, so the single fallback
    // evaluation resolves to English here. The point of the case is that a
    // missing or malformed service neither throws nor blocks registration.
    expect(localeStore.getSnapshot().locale).toBe('en')
    expect(slots.registrations).toHaveLength(1)
    // No `locale` field on the registration: localization is not a second
    // registration path, and F10 forbids one.
    expect(Object.keys(slots.registration?.options ?? {})).not.toContain('locale')
    // The label falls back to the store.
    expect(slots.registration?.options.label()).toBe(EN_TITLE)
  })

  it('uses the navigator fallback when the host names a language outside the whitelist', () => {
    // `active: 'fr'` is not ours, so the SINGLE navigator fallback (jsdom:
    // `en-US`) decides — not Chinese, and not the host's own string.
    const { slots } = applyWith({ hasGet: true, localeService: fakeLocaleService({ active: () => 'fr' }) })
    slots.openSlot()

    expect(localeStore.getSnapshot().locale).toBe('en')
    expect(slots.registration?.options.label()).toBe(EN_TITLE)
  })

  it('accepts either whitelisted language from the host, verbatim', () => {
    for (const active of ['zh', 'en']) {
      localeStore.setLocale('zh')
      const { slots } = applyWith({ hasGet: true, localeService: fakeLocaleService({ active: () => active }) })
      slots.openSlot()
      expect(localeStore.getSnapshot().locale, active).toBe(active)
    }
  })

  it('keeps registering on a host whose navigator is missing, defaulting to Chinese', () => {
    // The VM-sandbox path: the single navigator read is guarded, and "cannot
    // tell" resolves to Chinese — the page's historical default — rather than
    // throwing before the page registers.
    const original = globalThis.navigator
    delete (globalThis as { navigator?: unknown }).navigator
    try {
      const { slots } = applyWith({})
      expect(() => slots.openSlot()).not.toThrow()
      expect(localeStore.getSnapshot().locale).toBe('zh')
      expect(slots.registration?.options.label()).toBe(ZH_TITLE)
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true })
    }
  })
})

// ---------------------------------------------------------------------------
// A host service that misbehaves
// ---------------------------------------------------------------------------

describe('a host locale service that misbehaves', () => {
  it('warns, does not throw, and keeps the page usable when getLocale throws', () => {
    const { warn } = quietConsole()
    const service = fakeLocaleService({ active: () => 'zh', getLocaleThrows: true })

    const { slots } = applyWith({ hasGet: true, localeService: service })
    // Both probe sites must survive it: apply()'s probe and the re-probe.
    expect(() => slots.openSlot()).not.toThrow()

    expect(slots.registrations).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    // No localization: the store keeps the navigator fallback and the label
    // reads it, rather than the label throwing on every nav render.
    expect(localeStore.getSnapshot().locale).toBe('en')
    expect(slots.registration?.options.label()).toBe(EN_TITLE)
  })

  it('warns, does not throw, and keeps the page usable when subscribe throws', () => {
    const { warn } = quietConsole()
    const service = fakeLocaleService({ active: () => 'zh', subscribeThrows: true })

    const { slots } = applyWith({ hasGet: true, localeService: service })
    expect(() => slots.openSlot()).not.toThrow()

    expect(slots.registrations).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    // The probe's own answer still counts; only FOLLOWING the host is degraded.
    expect(localeStore.getSnapshot().locale).toBe('zh')
    expect(slots.registration?.options.label()).toBe(ZH_TITLE)
  })

  it('still renders the page when the cached host starts throwing later', () => {
    // A service that tears down underneath a live page: the label may not take
    // the shell's nav render with it.
    let alive = true
    const service = {
      getLocale: () => {
        if (!alive) throw new Error('host locale torn down')
        return { active: 'zh' }
      },
      subscribe: () => () => {},
    }
    const { slots } = applyWith({ hasGet: true, localeService: service })
    slots.openSlot()
    expect(slots.registration?.options.label()).toBe(ZH_TITLE)

    alive = false
    expect(() => slots.registration?.options.label()).not.toThrow()
    // Degraded to the store, which holds the language last adopted (zh here).
    expect(slots.registration?.options.label()).toBe(ZH_TITLE)
  })
})

// ---------------------------------------------------------------------------
// The re-probe inside `slots.inject`
// ---------------------------------------------------------------------------

describe('a locale service that appears after apply()', () => {
  it('adopts it inside slots.inject and subscribes exactly once', () => {
    let service: unknown
    let subscriptions = 0
    const getCalls: string[] = []
    const slots = new FakeSlots()

    // The ctx's `get` is a LIVE lookup, so the service can mount between
    // `apply()` and the slot callback — the very shape the re-probe exists for.
    apply({
      slots,
      effect: (callback: () => void | (() => void)) => void callback(),
      get: (name: string): unknown => {
        getCalls.push(name)
        return name === 'locale' ? service : undefined
      },
    })
    expect(localeStore.getSnapshot().locale).toBe('en')

    service = {
      getLocale: () => ({ active: 'zh' }),
      subscribe: () => {
        subscriptions += 1
        return () => {}
      },
    }
    slots.openSlot()

    // Adopted by the re-probe; the label now reads the host directly.
    expect(localeStore.getSnapshot().locale).toBe('zh')
    expect(slots.registration?.options.label()).toBe(ZH_TITLE)
    expect(subscriptions).toBe(1)

    // A second inject callback must not subscribe twice.
    slots.openSlot()
    expect(subscriptions).toBe(1)

    // Exactly the two probe sites (`apply()` then the inject callback); more
    // would mean a per-call host read has crept into the label.
    expect(getCalls).toEqual(['locale', 'locale'])
  })

  it('keeps the label on the store when the re-probe finds nothing', () => {
    const { slots } = applyWith({})
    slots.openSlot()
    expect(slots.registration?.options.label()).toBe(EN_TITLE)
    // The store is still the label's source, so a change reaches it.
    localeStore.setLocale('zh')
    expect(slots.registration?.options.label()).toBe(ZH_TITLE)
  })
})

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('teardown', () => {
  it('unsubscribes from the host and releases the seat when the disposer runs', () => {
    const listeners = new Set<() => void>()
    let hostUnsubscribes = 0
    const service = fakeLocaleService({
      active: () => 'zh',
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          hostUnsubscribes += 1
          listeners.delete(listener)
        }
      },
    })

    const { slots, teardown } = applyWith({ hasGet: true, localeService: service })
    slots.openSlot()
    expect(listeners.size).toBe(1)

    // The effect disposer is the plugin's own teardown: it removes the styles
    // node and must also unsubscribe from the host.
    expect(teardown).toBeTypeOf('function')
    teardown?.()
    expect(listeners.size).toBe(0)

    // Idempotent: a host that tears a plugin down twice must not break, and the
    // host's own unsubscribe must not be called a second time.
    expect(() => teardown?.()).not.toThrow()
    expect(hostUnsubscribes).toBe(1)
    expect(slots.registration?.options.label()).toBe(ZH_TITLE)
  })
})

// ---------------------------------------------------------------------------
// The registration's shape (F10)
// ---------------------------------------------------------------------------

describe('the registration shape', () => {
  it('claims exactly the settings seat, with no locale field', () => {
    const { slots } = applyWith({})
    slots.openSlot()

    expect(slots.injected).toEqual([SETTINGS_SLOT])
    expect(slots.registrations).toHaveLength(1)
    expect(slots.registration?.options.name).toBe(SETTINGS_SLOT)
    expect(Object.keys(slots.registration?.options ?? {})).not.toContain('locale')
  })

  it('keeps the label a callback the shell can re-resolve', () => {
    const { slots } = applyWith({})
    slots.openSlot()
    expect(slots.registration?.options.label).toBeTypeOf('function')
  })
})
