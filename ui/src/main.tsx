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
 *    name** (the reference declares `["slots","sessions","workspaces",
 *    "conversation"]`). This plugin consumes none of the shell's services: it
 *    renders its own settings view from the same-origin HTTP API, so the array
 *    is EMPTY. This is a different field from the manifest's
 *    `dsh.client.inject` (a module-graph preload row list, also empty here);
 *    `@deepseek-ai/dsh-client-ui-*` package names belong in neither.
 *  - `exports.apply(ctx)` — the host's mount hook.
 *
 * `react`/`react-dom` stay external: the host already loaded them, and a second
 * bundled copy would give this tree a different React instance than the shell,
 * breaking hooks.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import styles from './styles.css?inline'

/** This bundle's service dependencies, by module short name. */
const inject: string[] = []

/** The element the settings page mounts into when the shell provides none. */
const MOUNT_ATTRIBUTE = 'data-cherry-remote-settings'

/** The host context this bundle uses; it declares no services, so only `effect`. */
export interface ClientContext {
  effect?(callback: () => void | (() => void)): void
}

/**
 * Mounts the settings page.
 *
 * `ctx.effect` ties the rendered tree to the plugin's lifecycle, so disabling
 * the plugin unmounts it and reopening it renders a fresh subscription.
 */
function apply(ctx: ClientContext): void {
  ctx.effect?.(() => {
    // Styles arrive as a STRING (vite `?inline`), not as a sibling .css file:
    // the host loads `lib/client.js` through the module loader, which has no
    // notion of a co-located stylesheet, so a separate `lib/client.css` would
    // simply never load. Injecting a <style> node is the pattern the reference
    // plugin uses too.
    const style = installStyles()
    const target = document.querySelector(`[${MOUNT_ATTRIBUTE}]`) ?? createMountNode()
    const root = createRoot(target)
    root.render(createElement(App))
    return () => {
      root.unmount()
      style.remove()
    }
  })
}

/** Injects the page styles once, returning the node so it can be removed. */
function installStyles(): HTMLStyleElement {
  const node = document.createElement('style')
  node.setAttribute('data-cherry-remote-styles', '')
  node.textContent = styles
  document.head.append(node)
  return node
}

/** A host page without a dedicated settings seat still gets a mount point. */
function createMountNode(): Element {
  const node = document.createElement('div')
  node.setAttribute(MOUNT_ATTRIBUTE, '')
  document.body.append(node)
  return node
}

export { inject, apply }
