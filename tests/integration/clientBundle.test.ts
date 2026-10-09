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
function loadBundle(source = readFileSync(bundlePath, 'utf8')): { loaded: LoadedModule; requires: RequireLog } {
  const requires: RequireLog = []
  const loaded: LoadedModule = { id: '', exports: {} }

  const reactStub = {
    createElement: () => ({}),
    StrictMode: () => ({}),
    useCallback: (fn: unknown) => fn,
    useEffect: () => {},
    useMemo: (fn: () => unknown) => fn(),
    useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
  }
  const reactDomClientStub = { createRoot: () => ({ render: () => {}, unmount: () => {} }) }
  const jsxRuntimeStub = { jsx: () => ({}), jsxs: () => ({}), Fragment: () => ({}) }

  // The bundle mounts into a detached element and injects a <style> node; the
  // loader smoke is about the ENVELOPE, not about DOM fidelity, so a minimal
  // element stub is enough and keeps the test free of jsdom.
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
          if (specifier === 'react') return reactStub
          if (specifier === 'react-dom' || specifier === 'react-dom/client') return reactDomClientStub
          if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
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

  const reactStub = {
    createElement: () => ({}),
    useCallback: (fn: unknown) => fn,
    useEffect: () => {},
    useMemo: (fn: () => unknown) => fn(),
    useState: (initial: unknown) => [initial, () => {}],
  }
  runInContext(
    source,
    createContext({
      window: {
        __ModuleLoader__: {
          load(record: { id: string; factory: (require: (specifier: string) => unknown) => unknown }) {
            captured.id = record.id
            captured.exports = record.factory((specifier: string) => {
              if (specifier === 'react') return reactStub
              if (specifier === 'react-dom' || specifier === 'react-dom/client') {
                return { createRoot: () => ({ render: () => {}, unmount: () => {} }) }
              }
              if (specifier === 'react/jsx-runtime') {
                return { jsx: () => ({}), jsxs: () => ({}), Fragment: () => ({}) }
              }
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

  it('resolves react through the loader require, never a global', () => {
    const { requires } = loadBundle()
    expect(requires).toContain('react')
    // Only `react` is required: the shell owns the React DOM root and renders
    // this bundle's component itself, so `react-dom/client` is no longer pulled
    // in. A bundled React would make this tree see a different instance than the
    // shell and break hooks, so it must be required, not embedded.
    expect(readFileSync(bundlePath, 'utf8')).not.toContain('react.development.js')
    expect(readFileSync(bundlePath, 'utf8')).not.toMatch(/var React\s*=/)
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
