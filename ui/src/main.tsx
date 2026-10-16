/**
 * The plugin's CLIENT half — the published bundle entry (`lib/client.js`).
 *
 * This module is written as ordinary ESM. The
 * `window.__ModuleLoader__.load({ id, factory })` envelope the DSH host requires
 * (identical to the reference plugin `dsh-mcp-connector/lib/client.js`) is
 * applied by vite's rollup `output.banner`/`output.footer` in
 * `ui/vite.config.ts`, so the wrapper has exactly one definition and this file
 * stays type-checkable and unit-testable.
 *
 * Two fields the host reads off the bundle's exports:
 *
 *  - `exports.inject` — this bundle's SERVICE dependencies **by module short
 *    name**. The settings page is registered into the shell's `settings.section`
 *    slot, so the one service it consumes is `slots`. (The reference declares
 *    `["slots","sessions","workspaces","conversation"]` because it also renders
 *    into session and sidebar seats; a longer list here would declare services
 *    this plugin never touches.) This is a DIFFERENT layer from the manifest's
 *    `dsh.client.inject`, which is a module-graph PRELOAD row list and stays
 *    empty — this plugin has no dependent graph rows. Package names such as
 *    `@deepseek-ai/dsh-client-ui-*` belong in neither field.
 *  - `exports.apply(ctx)` — the host's mount hook.
 *
 * `react`/`react-dom` stay external: the host already loaded them, and a second
 * bundled copy would give this tree a different React instance than the shell,
 * breaking hooks.
 */
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { App } from './App'
import { createTranslator, localeStore, resolveLocaleFromNavigator } from './i18n'
import type { LocaleId } from './i18n'
import styles from './styles.css?inline'

/** The slot a settings page registers into, per the shell's settings contract. */
export const SETTINGS_SLOT = 'settings.section'

/** The settings-pages namespace: this plugin's nav id and locale key. */
export const SETTINGS_NAMESPACE = 'cherry-remote'

/** This bundle's service dependencies, by module short name. */
const inject: string[] = ['slots']

/** The `slots` service surface this bundle uses. */
export interface SlotsService {
  /**
   * Declares that this bundle owns content for `slot`, invoking `callback` when
   * the slot is available; the callback's return value is the disposer.
   */
  inject(slot: string, callback: () => void | (() => void)): void
  /** Registers one entry into a slot; returns the disposer removing it. */
  register(options: SlotRegistration, component: ComponentType): () => void
}

/** A `settings.section` registration, as the shell reads it. */
export interface SlotRegistration {
  name: string
  /** The section's stable id; also its route key. */
  id: string
  /** Nav ordering among the settings sections. */
  order: number
  /** The nav label; a callback so it re-resolves on a locale change. */
  label: () => string
  /** The injected-props face handed to the component. */
  inject: () => Record<string, unknown>
}

/**
 * The host context: the services declared in {@link inject}, plus lifecycle.
 *
 * `get` is the host's SERVICE LOOKUP and is the only sanctioned way to reach a
 * service this bundle does not declare (see {@link readLocaleService}): cordis
 * gates an undeclared service behind a throwing getter, so a property read such
 * as `ctx.locale` would take the whole Web GUI boot down on a host that ships
 * no locale provider. It is optional because the VM-sandbox smoke path and the
 * unit fakes build a ctx without it.
 */
export interface ClientContext {
  slots?: SlotsService
  effect?(callback: () => void | (() => void), label?: string): void
  get?(name: string): unknown
}

/**
 * The host's locale service, as this bundle uses it.
 *
 * Declared LOCALLY on purpose: the plugin depends on no host package for this
 * (it is resolved through {@link ClientContext.get} at runtime), so importing
 * the host's own type would add a dependency this bundle does not have. Both
 * members are required — a service missing either is treated as absent.
 */
export interface LocaleService {
  getLocale(): { active: string }
  subscribe(listener: () => void): () => void
}

/**
 * The shape check every host answer must survive before it is trusted.
 *
 * A shape check rather than a plugin-facing type: what arrives through `get` is
 * `unknown`, and a host is free to mount a PARTIAL or differently-shaped
 * service. Both methods must be functions; anything else is "absent", and
 * absent degrades to the navigator fallback rather than to a thrown error in a
 * nav label.
 */
function isLocaleService(value: unknown): value is LocaleService {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { getLocale?: unknown; subscribe?: unknown }
  return typeof candidate.getLocale === 'function' && typeof candidate.subscribe === 'function'
}

/**
 * Reads the host's locale service through `ctx.get`, or undefined when there is
 * none to trust.
 *
 * `get` itself may throw on a host whose gating differs from the documented
 * one, so the call is guarded too: this function NEVER throws. It is called
 * from exactly two places — `apply()`'s probe and the `slots.inject` re-probe —
 * and both write the SAME cached reference (see {@link apply}).
 */
function readLocaleService(ctx: ClientContext): LocaleService | undefined {
  try {
    const service = ctx.get?.('locale')
    return isLocaleService(service) ? service : undefined
  } catch (cause) {
    console.warn(`[${SETTINGS_NAMESPACE}] locale service lookup failed`, cause)
    return undefined
  }
}

/** The translator the plugin's own copy uses, for the language the store holds. */
function translate(key: string): string {
  return createTranslator(localeStore.getSnapshot().locale)(key)
}

/**
 * Maps an ACTIVE locale the host reported onto one of this page's languages.
 *
 * The whitelist: only `zh`/`en` are adopted verbatim, and anything else — a
 * language this page does not ship, an empty string, a non-string — resolves to
 * `fallback`, the single navigator evaluation `apply()` performed. ONE rule,
 * used by both the store write and the label read, so the shell's nav item can
 * never disagree with the page it opens.
 */
function resolveActiveLocale(active: unknown, fallback: LocaleId): LocaleId {
  return active === 'zh' || active === 'en' ? active : fallback
}

/**
 * Registers the settings page with the host shell.
 *
 * Registration goes through the `slots` service, exactly as the reference
 * plugin does — the host owns where a settings section appears, so a plugin
 * must never append its own container to `document.body`. `slots.inject` waits
 * for the slot to exist before `slots.register` claims a seat, and the returned
 * disposer is returned so the caller can tie it to the plugin lifecycle.
 *
 * ## Localization wiring (the whole of this plugin's host coupling)
 *
 * The plugin ships its own two dictionaries and its own store; the host's
 * locale service is an OPTIONAL SOURCE, wired here and nowhere else:
 *
 *  - **the navigator fallback is evaluated exactly once**, at the top, behind
 *    the `typeof navigator === 'undefined'` guard. A VM sandbox has no
 *    `navigator` at all, so an unguarded read would throw before the page
 *    registered; `resolveLocaleFromNavigator` itself is pure. The single value
 *    is shared by BOTH branches that need it — "no host service" and "the host
 *    named a language outside the whitelist" — so there is one place where the
 *    ambient language can enter.
 *  - **the host service is read through `ctx.get('locale')`, never
 *    `ctx.locale`**, and only after {@link isLocaleService} accepts its shape.
 *  - **`host` is the CACHED reference both probes write.** `label()` reads it
 *    on every call: a present host is answered DIRECTLY from
 *    `getLocale().active` (so a label asked in the same tick as the host's
 *    announcement, before our own listener has run, is still correct — React's
 *    `handleStoreChange` calls `getSnapshot` synchronously, and the shell may
 *    ask for its nav item even earlier), while an absent host falls back to
 *    `localeStore`, which is what a React re-render reads. Because the re-probe
 *    updates the same variable, a host that appears after `apply()` switches
 *    the label from the store to the host with no extra flag.
 *  - **the registration carries no `locale` field**, and `inject` stays
 *    `['slots']`: declaring `locale` would make a host without the provider
 *    fail the entire Web GUI boot, for a feature that is optional by design.
 *  - **nothing here may throw.** Every host interaction is guarded and degrades
 *    to "no localization" (a warning plus the fallback language); a misbehaving
 *    host costs the page its English, never its registration.
 */
function apply(ctx: ClientContext): void {
  // The ONE navigator read in the plugin (Global Constraint: 单点守卫).
  const fallback: LocaleId = resolveLocaleFromNavigator(
    typeof navigator === 'undefined' ? undefined : navigator.language,
  )

  /**
   * The cached host reference {@link apply}'s probe and the inject re-probe
   * BOTH write; `label()` reads it on every call.
   */
  let host: LocaleService | undefined
  /** The host subscription's disposer, so the effect teardown can release it. */
  let unsubscribe: (() => void) | undefined

  /**
   * Adopts the language the cached host reports.
   *
   * Called by BOTH probes and by every announcement the host makes. An
   * unreadable answer degrades to {@link fallback} — the same single navigator
   * evaluation the no-host branch uses — rather than leaving the store at
   * whatever it held or throwing into a nav render.
   */
  const adopt = (service: LocaleService): void => {
    let active: unknown
    try {
      active = service.getLocale().active
    } catch (cause) {
      // The host is not trustworthy right now, so it is NOT adopted: the label
      // then reads the store rather than throwing on every nav render.
      if (host === service) host = undefined
      localeStore.setLocale(fallback)
      console.warn(`[${SETTINGS_NAMESPACE}] host locale unavailable; falling back to ${fallback}`, cause)
      return
    }
    localeStore.setLocale(resolveActiveLocale(active, fallback))
  }

  /**
   * Re-reads the host service, adopts its language, and subscribes if it has
   * not happened yet. Idempotent in the way the two probe sites need: the
   * second probe sees `host` already set, subscribes nothing, and re-adopting a
   * language the store already holds is a no-op (`setLocale` does not notify
   * for the same value).
   *
   * With no host to read, the store takes {@link fallback} — the single
   * navigator evaluation performed at the top of {@link apply}. That is what
   * makes the absent branch and the "host named a language outside the
   * whitelist" branch share one result, and it is why the store is never left
   * at an unrelated language: the page's own default applies until a host says
   * otherwise.
   */
  const probe = (): void => {
    if (host === undefined) {
      const service = readLocaleService(ctx)
      if (service === undefined) {
        localeStore.setLocale(fallback)
        return
      }
      host = service

      // Subscribing is best-effort: a host that cannot be followed still gets
      // its language adopted below.
      try {
        const off = service.subscribe(() => probe())
        // Idempotent: a host that tears the plugin down twice must not call the
        // service's own unsubscribe twice.
        unsubscribe = () => {
          unsubscribe = undefined
          try {
            off()
          } catch (cause) {
            console.warn(`[${SETTINGS_NAMESPACE}] unsubscribing from the host locale failed`, cause)
          }
        }
      } catch (cause) {
        console.warn(`[${SETTINGS_NAMESPACE}] could not follow the host locale`, cause)
      }
    }
    if (host !== undefined) adopt(host)
  }

  probe()

  // Styles arrive as a STRING (vite `?inline`), not as a sibling .css file: the
  // host loads `lib/client.js` through the module loader, which has no notion of
  // a co-located stylesheet, so a separate `lib/client.css` would never load.
  // Injecting a <style> node is the pattern the reference plugin uses too.
  //
  // ONE effect carries both teardowns — the styles node and the host locale
  // subscription — because the effect count is itself part of the host-facing
  // shape the tests pin (`clientBundle.test.ts` asserts exactly one effect).
  // Teardown order: release the host first, then the styles.
  ctx.effect?.(
    () => {
      const removeStyles = installStyles()
      return () => {
        unsubscribe?.()
        removeStyles()
      }
    },
    `${SETTINGS_NAMESPACE}: settings styles`,
  )

  if (ctx.slots === undefined) {
    console.warn(`[${SETTINGS_NAMESPACE}] client slots service unavailable; settings page not registered`)
    return
  }

  ctx.slots.inject(SETTINGS_SLOT, () => {
    // The re-probe: a host whose locale service mounts AFTER this plugin does
    // (the common ordering when both are plugins of the same shell) is adopted
    // the moment the slot opens.
    probe()
    return ctx.slots?.register(
      {
        name: SETTINGS_SLOT,
        id: SETTINGS_NAMESPACE,
        order: 50,
        // Resolved per call so the shell re-resolves it on a locale change. The
        // host, when present, is asked directly — see the contract above — and
        // its answer goes through the SAME whitelist rule the store write uses,
        // so the nav label and the page can never disagree.
        label: (): string => {
          if (host === undefined) return translate('app.title')
          try {
            const active = host.getLocale().active
            return createTranslator(resolveActiveLocale(active, fallback))('app.title')
          } catch {
            // A host that only misbehaves LATER (its service tearing down) must
            // not take the shell's nav render with it.
            return translate('app.title')
          }
        },
        inject: () => ({}),
      },
      // The shell passes the slot's runtime props to the component; this page
      // renders from its own same-origin API, so it ignores them.
      App as ComponentType,
    )
  })
}

/** Injects the page styles, returning the disposer that removes the node. */
function installStyles(): () => void {
  const node = document.createElement('style')
  node.setAttribute('data-cherry-remote-styles', '')
  node.textContent = styles
  document.head.append(node)
  return () => node.remove()
}

export { inject, apply }
