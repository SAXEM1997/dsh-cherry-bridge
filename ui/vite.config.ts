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
 * Where `npm run dev:ui` forwards the plugin's API calls: the DSH host's web
 * server, which owns the `/cherry-remote/api` prefix. Override with
 * `CHERRY_DEV_HOST` when the host listens elsewhere (a non-default
 * `--port`), rather than editing the page — the page itself never learns an
 * absolute URL.
 */
const DEV_HOST_ORIGIN = process.env.CHERRY_DEV_HOST ?? 'http://127.0.0.1:23023'

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

  if (isClientBundle) {
    // MANDATORY, and NOT the same thing as the `define` below.
    //
    // vite decides `isProduction` from `process.env.NODE_ENV` at BUILD TIME and
    // picks the JSX transform accordingly: production emits
    // `require("react/jsx-runtime")`, anything else emits
    // `require("react/jsx-dev-runtime")` plus `jsxDEV` call sites. The host's
    // module seed carries `react/jsx-runtime` and NO dev runtime, so a dev-mode
    // build loads fine in a test stub and then throws `Cannot find module` in
    // the settings page — which is exactly how F1 shipped.
    //
    // `define` only substitutes output text; it does NOT steer the transform.
    // And the value cannot be inherited: a vitest worker runs with
    // `NODE_ENV=test` and the suite rebuilds this artifact through
    // `execFileSync`, so the test path, a dev shell and CI all disagree.
    // Setting it here is the one place that covers every entry point.
    process.env.NODE_ENV = 'production'
  }

  return {
    root: here,
    plugins: [react()],
    define: isClientBundle ? { 'process.env.NODE_ENV': JSON.stringify('production') } : {},
    // DEV-ONLY proxy (see `DEV_HOST_ORIGIN`): `npm run dev:ui` serves the page
    // from vite's own port, but the page's API calls are RELATIVE and
    // same-origin by construction (`/cherry-remote/api/...`). Without this the
    // dev page would ask ITS OWN origin for the plugin's routes, get vite's 404
    // and render an empty device list beside a dead SSE stream — the settings
    // page is only exercisable against a host.
    //
    // Present only in the dev branch: the published bundle carries no proxy and
    // makes no absolute request, so this cannot leak into a build.
    server: isClientBundle
      ? undefined
      : {
          proxy: {
            '/cherry-remote/api': {
              target: DEV_HOST_ORIGIN,
              // `changeOrigin` MUST stay false, and the load-bearing reason is
              // the host's same-origin fence, not streaming. The fence admits a
              // request only when the attached `Origin` and the `Host` header
              // name the SAME authority (`new URL(origin).host === host` in
              // `src/httpApi.ts`). The browser sends `Origin: <vite origin>`;
              // with `changeOrigin: false` the proxy forwards vite's own Host
              // too, so the two agree and the fence admits. With
              // `changeOrigin: true` the proxy would rewrite Host to the DSH
              // host's authority while Origin stayed vite's — the comparison
              // fails, every request is answered 403, and the dev page dies
              // with an empty device list. (Secondary: SSE must not be
              // buffered, or live device/pairing updates arrive in chunks
              // instead of as they happen.)
              changeOrigin: false,
              ws: false,
            },
          },
        },
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
