/**
 * The build for the plugin's CLIENT half.
 *
 * Two modes share one config:
 *
 *  - `build:client` (`--mode client`, the default here) emits `lib/client.js`,
 *    the published artifact. It is a single-file IIFE wrapped in the host loader
 *    envelope `window.__ModuleLoader__.load({ id, factory })` — the exact shape
 *    `dsh-mcp-connector/lib/client.js` ships, produced by the banner/footer below
 *    so the wrapper has one definition. The factory parameter is named `require`
 *    because that is the host's own module resolver, and `react`/`react-dom` are
 *    externalized so the bundle resolves them through it instead of embedding a
 *    second copy (which would break hooks).
 *  - `dev` is a plain dev harness page (`ui/index.html`) for rendering the
 *    settings page in a browser against a running host.
 *
 * CSS is emitted into `lib/client.css`; the client bundle imports no asset URLs,
 * so nothing else needs inlining.
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
            // CJS, not IIFE: the external `react`/`react-dom` specifiers must
            // become `require("react")` calls against the LOADER's resolver. An
            // IIFE emits bare identifiers (`(function(exports, react) {...})`)
            // that resolve to nothing at runtime — see the reference bundle,
            // which calls `require` exactly this way.
            formats: ['cjs'],
            fileName: () => 'client.js',
            cssFileName: 'client',
          },
          rollupOptions: {
            // Provided by the host: resolving them through its `require` keeps a
            // single React instance across the shell and this bundle.
            external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
            output: {
              banner: loaderBanner,
              footer: loaderFooter,
            },
          },
        }
      : undefined,
  }
})
