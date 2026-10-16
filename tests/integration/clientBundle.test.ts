/**
 * Step 4 — the client-bundle loader smoke test.
 *
 * The REAL host is not reachable from the test suite (it needs a live Web
 * server and a settings shell), so this exercises the observable parts of the
 * loading path in-repo instead of pretending to boot the host:
 *
 *  1. `npm run build:client` produces `lib/client.js` (asserted, and skipped
 *     with an explicit message when the artifact is absent — the file is a
 *     build product and is not committed);
 *  2. the bundle registers itself through `window.__ModuleLoader__.load` with
 *     the package id, its factory resolves `react` through the LOADER's
 *     `require` (not a global), and the registered module exposes
 *     `exports.inject` + `exports.apply` — the two fields the host reads;
 *  3. the REVERSE assertion: removing `exports["./client"]` from the manifest
 *     makes `ClientModuleRegistry.resolveMeta` throw
 *     `declares dsh.client but exports no "./client" bundle`.
 *
 * Assertion 3 is the load-bearing one: it proves the manifest really does
 * declare a client half, so assertions 1-2 are testing a bundle the host would
 * actually look for rather than a file nothing references.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bundlePath = join(repoRoot, 'lib', 'client.js')
const manifestPath = join(repoRoot, 'package.json')

const PACKAGE_NAME = 'dsh-cherry-bridge'
const MISSING_CLIENT_ERROR = `client-modules: ${PACKAGE_NAME} declares dsh.client but exports no "./client" bundle`

/**
 * The host's own client-modules package, located by absolute path.
 *
 * It is a HOST dependency, not one of this plugin's: resolving it from here
 * would mean depending on a private package at build time, so it is imported
 * from the host checkout instead. When that checkout is absent the
 * manifest-contract assertions are skipped with an explicit reason rather than
 * silently passing — see `resolveRegistryClass`.
 */
const HOST_CLIENT_MODULES_CANDIDATES = [
  process.env['DSH_WEB_CHECKOUT'] === undefined
    ? undefined
    : join(process.env['DSH_WEB_CHECKOUT'], 'node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'),
  '/dsh-home/profiles/web/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js',
].filter((candidate): candidate is string => candidate !== undefined)

/** The registry class, or undefined when the host checkout is unavailable. */
type RegistryClass = new (...args: never[]) => unknown

async function resolveRegistryClass(): Promise<RegistryClass | undefined> {
  for (const candidate of HOST_CLIENT_MODULES_CANDIDATES) {
    if (!existsSync(candidate)) continue
    const loaded = (await import(pathToFileURL(candidate).href)) as { ClientModuleRegistry?: RegistryClass }
    if (loaded.ClientModuleRegistry !== undefined) return loaded.ClientModuleRegistry
  }
  return undefined
}

const registryClass = await resolveRegistryClass()
const describeIfHost = describe.skipIf(registryClass === undefined)

/** The module record a loader stub captured, or undefined if none loaded. */
interface LoadedModule {
  id: string
  exports: Record<string, unknown>
}

/** What the fake `require` was asked for, in order. */
type RequireLog = string[]

/**
 * Loads the built bundle in a fresh VM context whose `window.__ModuleLoader__`
 * is a stub, exactly as the host's loader would consume it.
 *
 * The stub's `require` returns a stand-in for the externalized React packages:
 * building the module graph must not need a real DOM, only the identifiers the
 * bundle destructures at load time.
 */
/**
 * The host's OWN client-module seed: the complete set of specifiers the host
 * module loader can resolve for a client bundle.
 *
 * This is a TRANSCRIPT of the real host seed (9 modules), not a design choice.
 * The stub below mirrors it exactly and must never be a superset: masking a
 * specifier here would let a bundle that the host cannot load pass the smoke
 * test. `react/jsx-dev-runtime` in particular was stubbed away while the build
 * emitted a dev-transform bundle, and the settings page threw on the host —
 * F1 of the UltraReview. Adding a module here is a HOST change, not a test
 * change, and the subset assertion below makes any new external fail loudly.
 */
const HOST_SEED_SPECIFIERS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'dsh-client-store',
  'dsh-client-ui-slots',
  'dsh-client-ui-primitives',
  'dsh-client-ui-dockkit',
] as const

/**
 * The host-`require` stand-in for the externalized React family.
 *
 * Keyed by the specifier the bundle actually asks for. The bundle resolves
 * `react` and — in a production build — the automatic JSX runtime
 * (`react/jsx-runtime`); `react-dom` is listed for completeness but is not
 * expected, since the shell owns the DOM root and renders this bundle's
 * component.
 *
 * There is deliberately NO `react/jsx-dev-runtime` branch: the host seed has no
 * such module, so a bundle that requires it fails against the real loader, and
 * this stub must reproduce that failure rather than paper over it.
 */
function reactFamilyStub(specifier: string): unknown | undefined {
  if (specifier === 'react') {
    return {
      createElement: () => ({}),
      StrictMode: () => ({}),
      useCallback: (fn: unknown) => fn,
      useEffect: () => {},
      useMemo: (fn: () => unknown) => fn(),
      useRef: (initial: unknown) => ({ current: initial }),
      useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
    }
  }
  if (specifier === 'react/jsx-runtime') {
    return { jsx: () => ({}), jsxs: () => ({}), Fragment: () => ({}) }
  }
  if (specifier === 'react-dom' || specifier === 'react-dom/client') {
    return { createRoot: () => ({ render: () => {}, unmount: () => {} }) }
  }
  return undefined
}

function loadBundle(source = readFileSync(bundlePath, 'utf8')): { loaded: LoadedModule; requires: RequireLog } {
  const requires: RequireLog = []
  const loaded: LoadedModule = { id: '', exports: {} }

  // The bundle injects a <style> node; the loader smoke is about the ENVELOPE,
  // not DOM fidelity, so a minimal element stub keeps it free of jsdom.
  const fakeElement = {
    setAttribute: () => {},
    append: () => {},
    remove: () => {},
    textContent: '',
  }
  const document = {
    createElement: () => fakeElement,
    querySelector: () => null,
    head: fakeElement,
    body: fakeElement,
  }

  const window = {
    __ModuleLoader__: {
      load(record: { id: string; factory: (require: (specifier: string) => unknown) => unknown }) {
        loaded.id = record.id
        loaded.exports = record.factory((specifier: string) => {
          requires.push(specifier)
          const stub = reactFamilyStub(specifier)
          if (stub !== undefined) return stub
          throw new Error(`the bundle required an undeclared external: ${specifier}`)
        }) as Record<string, unknown>
      },
    },
  }

  runInContext(source, createContext({ window, document, console }))
  return { loaded, requires }
}

/**
 * Loads the bundle against a SUPPLIED document and returns its exports.
 *
 * Separate from {@link loadBundle} so a test can substitute the document (the
 * degraded-host case asserts nothing was appended to `document.body`).
 */
function loadBundleWithDocument(document: Record<string, unknown>): LoadedModule {
  const source = readFileSync(bundlePath, 'utf8')
  const captured: LoadedModule = { id: '', exports: {} }

  runInContext(
    source,
    createContext({
      window: {
        __ModuleLoader__: {
          load(record: { id: string; factory: (require: (specifier: string) => unknown) => unknown }) {
            captured.id = record.id
            captured.exports = record.factory((specifier: string) => {
              const stub = reactFamilyStub(specifier)
              if (stub !== undefined) return stub
              throw new Error(`the bundle required an undeclared external: ${specifier}`)
            }) as Record<string, unknown>
          },
        },
      },
      document,
      console: { ...console, warn: () => {} },
    }),
  )
  return captured
}

beforeAll(() => {
  // Build the artifact rather than trusting a stale one: assertions 1-2 are only
  // meaningful against what `build:client` produces today.
  execFileSync('npm', ['run', 'build:client'], { cwd: repoRoot, stdio: 'pipe' })
}, 120_000)

describe('client bundle (build smoke)', () => {
  it('build:client produces lib/client.js', () => {
    expect(existsSync(bundlePath)).toBe(true)
    expect(readFileSync(bundlePath, 'utf8').length).toBeGreaterThan(0)
  })

  it('registers through window.__ModuleLoader__.load under the package id', () => {
    const { loaded } = loadBundle()
    expect(loaded.id).toBe(PACKAGE_NAME)
  })

  it('embeds no React source, on any subpath', () => {
    const source = readFileSync(bundlePath, 'utf8')

    // A robust discriminator: every React file — core, `react-dom`, AND the
    // `react/jsx-runtime` SUBPATH — carries a `@license React` banner and is
    // wrapped by rollup's CommonJS interop helper. Asserting on the license text
    // catches an embedded copy regardless of which entry point pulled it in,
    // which is exactly how ~2.6 kB of `react-jsx-runtime.production.min.js`
    // slipped past the earlier (too narrow) assertions.
    expect(source).not.toContain('@license React')
    expect(source).not.toContain('react-jsx-runtime')
    expect(source).not.toContain('react-jsx-dev-runtime')
    expect(source).not.toContain('react.development.js')
    expect(source).not.toMatch(/var React\s*=/)
    // No CommonJS interop wrapper at all: with every react subpath external,
    // nothing in this bundle needs one.
    expect(source).not.toContain('__commonJSMin')
  })

  it('externalizes every react subpath through the loader require', () => {
    // The build must declare the react FAMILY external, not just the bare
    // specifier: `external: ['react']` does not match `react/jsx-runtime`, so
    // the subpath was silently bundled. Asserting the config is what keeps the
    // artifact assertion above from regressing unnoticed.
    const config = readFileSync(resolve(repoRoot, 'ui', 'vite.config.ts'), 'utf8')
    expect(config).toContain("external: [/^react$/, /^react\\//]")
  })

  // ---------------------------------------------------------------------------
  // F1 (UltraReview) — the artifact must use the PRODUCTION JSX runtime
  // ---------------------------------------------------------------------------

  it('requires the production JSX runtime, never the dev transform', () => {
    // The host seed has `react/jsx-runtime` and NO `react/jsx-dev-runtime`: a
    // bundle built with the dev transform throws `Cannot find module
    // "react/jsx-dev-runtime"` at load, and the settings page never renders.
    //
    // The build selects the transform from `process.env.NODE_ENV` AT BUILD TIME
    // (vite derives `isProduction` from it; the `define` below only substitutes
    // output text). Any non-production value — including vitest's own `test`,
    // which this suite's `beforeAll` rebuild inherits — used to select the dev
    // transform. So the assertion is on the quoted require the loader will
    // serve, not on a hyphenated filename that appears in both variants.
    const source = readFileSync(bundlePath, 'utf8')
    expect(source).not.toContain('require("react/jsx-dev-runtime")')
    expect(source).not.toContain('react/jsx-dev-runtime')
    // No `jsxDEV` call sites either: that is what the dev transform emits.
    expect(source).not.toContain('jsxDEV')
    // The production runtime is present, so the assertion above cannot pass on
    // a bundle that mysteriously emitted no JSX at all.
    expect(source).toContain('require("react/jsx-runtime")')
    expect(source).toContain('jsx')
  })

  it('builds the client bundle in production mode whatever NODE_ENV the caller has', () => {
    // The config must set NODE_ENV itself rather than inherit it: the suite's
    // `beforeAll` runs `npm run build:client` from a vitest process (NODE_ENV =
    // `test`), a maintainer may build from a dev shell, and CI may export a
    // different value. A config-level assignment is the only fix that covers
    // the `execFileSync` path as well as a direct `vite build`.
    const config = readFileSync(resolve(repoRoot, 'ui', 'vite.config.ts'), 'utf8')
    expect(config).toMatch(/process\.env\.NODE_ENV\s*=\s*'production'/)
  })

  it('requires nothing the host seed cannot resolve (require-set ⊆ seed)', () => {
    // THE transcript assertion: whatever the bundle asks `require` for, the
    // host must have it. Any NEW external specifier fails here rather than
    // surfacing as a runtime `Cannot find module` on a user's host.
    const { requires } = loadBundle()
    expect(requires.length).toBeGreaterThan(0)

    const seed = new Set<string>(HOST_SEED_SPECIFIERS)
    const unresolvable = [...new Set(requires)].filter((specifier) => !seed.has(specifier))
    expect(unresolvable).toEqual([])

    // F3: the exact posture after F1 — `react` plus the production JSX runtime,
    // and NOT `react-dom` (the shell owns the DOM root).
    expect([...new Set(requires)].sort()).toEqual(['react', 'react/jsx-runtime'])
    expect(new Set(requires).has('react-dom')).toBe(false)
  })

  it('exports the slots service dependency and an apply function', () => {
    const { loaded } = loadBundle()
    // Module SHORT names of the services the bundle actually consumes. The page
    // registers into the shell's `settings.section` slot, so `slots` is the one
    // service it needs — deliberately NOT the reference plugin's four-name list,
    // which exists because that plugin also renders session and sidebar seats.
    expect(loaded.exports['inject']).toEqual(['slots'])
    expect(typeof loaded.exports['apply']).toBe('function')
  })

  it('registers the settings entry through the slots service', () => {
    const { loaded } = loadBundle()
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const disposers: Array<() => void> = []
    let effects = 0

    const apply = loaded.exports['apply'] as (ctx: unknown) => void
    apply({
      slots: {
        inject(slot: string, callback: () => void | (() => void)) {
          const dispose = callback()
          if (typeof dispose === 'function') disposers.push(dispose)
        },
        register(options: Record<string, unknown>, component: unknown) {
          registrations.push({ options, component })
          return () => {}
        },
      },
      effect: (callback: () => void | (() => void)) => {
        effects += 1
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
    })

    // One settings section, claimed by the slot's own name, wired to the page.
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.options['name']).toBe('settings.section')
    expect(registrations[0]?.options['id']).toBe('cherry-remote')
    expect(registrations[0]?.options['order']).toBeTypeOf('number')
    expect(registrations[0]?.options['label']).toBeTypeOf('function')
    expect(registrations[0]?.component).toBeTypeOf('function')
    // Localization is NOT a second registration path: this ctx has no `get` at
    // all (the degraded shape), and the entry must still carry no `locale`
    // field. The host locale is read through `ctx.get('locale')` and reflected
    // in the label callback, never declared as its own slot option.
    expect(Object.keys(registrations[0]?.options ?? {})).not.toContain('locale')
    // The styles effect ran, and every teardown the host could call is safe.
    expect(effects).toBe(1)
    expect(disposers.length).toBeGreaterThan(0)
    for (const dispose of disposers) expect(dispose).not.toThrow()
  })

  it('claims no document mount point when the slots service is unavailable', () => {
    // A degraded host must warn and skip: appending our own container to
    // `document.body` would bypass the shell's layout entirely.
    const appended: unknown[] = []
    const captured = loadBundleWithDocument({
      createElement: () => ({ setAttribute: () => {}, remove: () => {}, textContent: '' }),
      querySelector: () => null,
      head: { append: () => {} },
      body: { append: (node: unknown) => appended.push(node) },
    })

    const apply = captured.exports['apply'] as (ctx: unknown) => void
    expect(() => apply({ effect: () => {} })).not.toThrow()
    expect(appended).toHaveLength(0)
  })

  it('mounts the settings page when apply is called with an effect context', () => {
    const { loaded } = loadBundle()
    let teardown: (() => void) | undefined
    const apply = loaded.exports['apply'] as (ctx: unknown) => void
    apply({
      effect: (callback: () => void | (() => void)) => {
        teardown = callback() as (() => void) | undefined
      },
    })
    expect(typeof teardown).toBe('function')
    // The teardown unmounts the tree; calling it twice would be a lifecycle bug
    // the host would hit on unload.
    expect(() => teardown?.()).not.toThrow()
  })
})

describeIfHost('manifest ↔ loader contract', () => {
  it('declares dsh.client and exports ./client consistently', async () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      exports?: Record<string, unknown>
      dsh?: { client?: unknown }
    }
    expect(manifest.dsh?.client).toEqual({ platform: 'web', inject: [] })
    expect(manifest.exports?.['./client']).toBe('./lib/client.js')

    const meta = await resolveMetaFor(manifestPath)
    expect(meta?.packageName).toBe(PACKAGE_NAME)
    // `dsh.client.inject` is the module-graph PRELOAD row list: empty for us.
    expect(meta?.meta.inject).toEqual([])
    expect(meta?.meta.clientPath).toBe(bundlePath)
  })

  it('throws when dsh.client is declared but exports["./client"] is removed', async () => {
    await expect(resolveMetaWithoutClientExport()).rejects.toThrow(MISSING_CLIENT_ERROR)
  })
})

/** The resolved meta record `resolveMeta` returns, narrowed for assertions. */
interface ResolvedMeta {
  packageName: string
  meta: { clientPath: string; inject?: string[] }
}

/**
 * Drives the host's OWN `resolveMeta` against an arbitrary manifest.
 *
 * `resolveMeta` is a private class method with no public wrapper that accepts a
 * package path, but its dependencies are just `this.sourceKey`, `this.pkgMeta`
 * and `this.locatePkgJson` — none of which are needed when the manifest path is
 * supplied. So the method is invoked on a prototype-only receiver (no
 * constructor side effects, no host services) with `locatePkgJson` stubbed to
 * the manifest under test. That keeps the assertion against the real
 * implementation and its real error text rather than a re-implementation.
 */
function resolveMetaWithManifest(manifestFile: string): Promise<ResolvedMeta | null> {
  const RegistryPrototype = (registryClass as unknown as { prototype: object }).prototype
  const receiver = Object.create(RegistryPrototype) as {
    sourceKey(loaderName: string, baseUrl: string): string
    pkgMeta: Map<string, unknown>
    locatePkgJson(): { path: string; packageName: string }
    resolveMeta(loaderName: string, baseUrl: string): ResolvedMeta | null
  }
  receiver.pkgMeta = new Map()
  receiver.sourceKey = (loaderName: string, baseUrl: string) => `${baseUrl}|${loaderName}`
  receiver.locatePkgJson = () => ({
    path: manifestFile,
    packageName: (JSON.parse(readFileSync(manifestFile, 'utf8')) as { name: string }).name,
  })
  // The method is synchronous; the promise wrapper keeps the caller's shape
  // uniform with the `rejects` assertion above.
  return Promise.resolve().then(() => receiver.resolveMeta(manifestFile, pathToFileURL(repoRoot).href))
}

function resolveMetaFor(manifestFile: string): Promise<ResolvedMeta | null> {
  return resolveMetaWithManifest(manifestFile)
}

/**
 * Copies the real manifest into a temp package with `exports["./client"]`
 * stripped, then runs the real `resolveMeta` against that copy.
 *
 * The temp copy is removed afterwards; nothing in the repository is touched.
 */
async function resolveMetaWithoutClientExport(): Promise<ResolvedMeta | null> {
  const directory = mkdtempSync(join(tmpdir(), 'cherry-remote-manifest-'))
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { exports: Record<string, unknown> }
    delete manifest.exports['./client']
    const stripped = join(directory, 'package.json')
    writeFileSync(stripped, JSON.stringify(manifest, null, 2))
    return await resolveMetaWithManifest(stripped)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
