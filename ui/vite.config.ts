/**
 * The build for the plugin's CLIENT half.
 *
 * Two modes share one config:
 *
 *  - `build:client` (`--mode client`, the default here) emits `lib/client.js`,
 *    the published artifact. It is a single-file **CJS** module wrapped in the
 *    host loader envelope `window.__ModuleLoader__.load({ id, factory })` — the
 *    exact shape `dsh-mcp-connector/lib/client.js` ships, produced by the
 *    banner/footer below so the wrapper has one definition. CJS (not IIFE) is
 *    load-bearing: the factory parameter is named `require` because that is the
 *    host's own module resolver, and only the CJS format emits `require("react")`
 *    calls; IIFE would emit bare identifiers that resolve to nothing at runtime.
 *    Every React entry point is externalized so the bundle resolves the shell's
 *    single copy through that `require` instead of embedding its own (which
 *    would break hooks) — see the `external` matcher below.
 *  - `dev` is a plain dev harness page (`ui/index.html`) for rendering the
 *    settings page in a browser against a running host.
 *
 * No CSS file is emitted: the stylesheet is imported with `?inline` and injected
 * as a `<style>` node by the bundle entry, because the host's module loader has
 * no notion of a co-located stylesheet.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = dirname(fileURLToPath(import.meta.url))
const packageName = 'dsh-cherry-bridge'

/**
 * The host loader envelope, matching the reference plugin's shape.
 *
 * There is deliberately no `Symbol.toStringTag` line here: vite's CJS output
 * emits its own, and declaring it twice redefines the same property (harmless,
 * but noise in a hand-maintained banner).
 */
const loaderBanner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(packageName)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;`

const loaderFooter = `\t\treturn module.exports;
\t}
});`

export default defineConfig(({ mode }) => {
  const isClientBundle = mode === 'client'
  return {
    root: here,
    plugins: [react()],
    define: isClientBundle ? { 'process.env.NODE_ENV': JSON.stringify('production') } : {},
    build: isClientBundle
      ? {
          outDir: resolve(here, '..', 'lib'),
          emptyOutDir: false,
          // The host loads this file as a classic script through the module
          // loader, so it must be one self-contained IIFE — no code splitting,
          // no shared chunks, no hashed asset names.
          cssCodeSplit: false,
          minify: false,
          sourcemap: false,
          lib: {
            entry: resolve(here, 'src', 'main.tsx'),
            name: '__CherryRemoteClient',
            // CJS, not IIFE: external specifiers must become `require("react")`
            // calls against the LOADER's resolver. An IIFE emits bare
            // identifiers (`(function(exports, react) {...})`) that resolve to
            // nothing at runtime — see the reference bundle, which calls
            // `require` exactly this way.
            formats: ['cjs'],
            fileName: () => 'client.js',
            cssFileName: 'client',
          },
          rollupOptions: {
            // Every React entry point, externalized so the shell's single copy is
            // resolved through its `require` — a bundled second copy would give
            // this tree a different React instance and break hooks.
            //
            // The regex is REQUIRED, not stylistic: the bare string `'react'`
            // matches only that exact specifier, so `react/jsx-runtime` (the
            // automatic JSX runtime the plugin-react transform injects) was
            // silently bundled — ~2.6 kB of React's own source in the artifact,
            // and a second React internal to go with it. `/^react/` covers
            // `react`, `react/jsx-runtime`, `react/jsx-dev-runtime` and any
            // `react-dom` subpath.
            external: [/^react/],
            output: {
              banner: loaderBanner,
              footer: loaderFooter,
            },
          },
        }
      : undefined,
  }
})
