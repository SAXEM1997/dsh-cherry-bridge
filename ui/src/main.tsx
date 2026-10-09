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

/** The host context: the services declared in {@link inject}, plus lifecycle. */
export interface ClientContext {
  slots?: SlotsService
  effect?(callback: () => void | (() => void), label?: string): void
}

/**
 * Registers the settings page with the host shell.
 *
 * Registration goes through the `slots` service, exactly as the reference
 * plugin does — the host owns where a settings section appears, so a plugin
 * must never append its own container to `document.body`. `slots.inject` waits
 * for the slot to exist before `slots.register` claims a seat, and the returned
 * disposer is returned so the caller can tie it to the plugin lifecycle.
 */
function apply(ctx: ClientContext): void {
  // Styles arrive as a STRING (vite `?inline`), not as a sibling .css file: the
  // host loads `lib/client.js` through the module loader, which has no notion of
  // a co-located stylesheet, so a separate `lib/client.css` would never load.
  // Injecting a <style> node is the pattern the reference plugin uses too.
  ctx.effect?.(() => installStyles(), `${SETTINGS_NAMESPACE}: settings styles`)

  if (ctx.slots === undefined) {
    console.warn(`[${SETTINGS_NAMESPACE}] client slots service unavailable; settings page not registered`)
    return
  }

  ctx.slots.inject(SETTINGS_SLOT, () =>
    ctx.slots?.register(
      {
        name: SETTINGS_SLOT,
        id: SETTINGS_NAMESPACE,
        order: 50,
        label: () => 'Cherry Studio 互联',
        inject: () => ({}),
      },
      // The shell passes the slot's runtime props to the component; this page
      // renders from its own same-origin API, so it ignores them.
      App as ComponentType,
    ),
  )
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
