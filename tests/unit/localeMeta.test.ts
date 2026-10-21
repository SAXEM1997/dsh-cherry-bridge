/**
 * Task 6 — the plugin-list metadata files the HOST reads off disk.
 *
 * The settings page renders from the `dictionaries` BUNDLE, but the plugin LIST
 * row (the entry a user sees before ever opening the page) is rendered by the
 * host from `locale/*.json` — two PHYSICAL files this repository ships. The host
 * resolver is pure file-driven: `readPluginMeta` enumerates the `locale/`
 * directory with `readdirSync` and parses each `*.json` it finds. It executes no
 * build script, so a generated-at-build-time `locale/` would be missing or stale
 * in an installed artifact and the row would silently fall back to the package
 * name. That is the design's explicit tradeoff (design §9 item 3): the two
 * copies — the bundled `dictionaries` and the on-disk JSON — BOTH really exist in
 * the repo, and their consistency is welded HERE, by this test, not by a build
 * step that "de-duplicates" them.
 *
 * ## Two-stage assertion (one case, two states)
 *
 * `meta.title` is the ONE field whose absence degrades SILENTLY to the package
 * name `dsh-cherry-bridge`, so this file pins it in both states of the same test:
 *
 *   - RED stage (before `locale/*.json` exist): `readPluginMeta` walks its
 *     package.json fallback chain, so `title` is the FLAT string
 *     `'dsh-cherry-bridge'` and `description` is `package.json.description`;
 *   - after the files exist: `{title: {en, zh}, description: {en, zh}}`, matching
 *     BOTH `dictionaries` and the two JSON files byte-for-byte.
 *
 * These are the before/after states of ONE case, not two concurrent cases.
 *
 * ## The real resolver is wired INDEPENDENTLY
 *
 * `readPluginMeta` comes from `@deepseek-ai/dsh-app-boot`. That is a DIFFERENT
 * package — with a different absence semantics — from
 * `tests/integration/clientBundle.test.ts`'s `@deepseek-ai/dsh-client-modules`
 * `ClientModuleRegistry`, so the candidate table below is this file's own and
 * deliberately NOT shared with that precedent.
 *
 * When the host artifact is absent, the real-resolver case SKIPS with a reason
 * that says so in as many words — a green `npm test` must NOT be misread as
 * "the real path was verified". The structural assertions (JSON shape, verbatim
 * agreement with the dictionaries, wildcard-export admission) run either way,
 * because they are what actually guards the shipped files.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { dictionaries } from '../../ui/src/i18n'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const localeDir = join(repoRoot, 'locale')
const manifestPath = join(repoRoot, 'package.json')

const PACKAGE_NAME = 'dsh-cherry-bridge'

/** The host's `readPluginMeta`, or undefined when the host checkout is unavailable. */
type ReadPluginMeta = (specifier: string, parentURL: string) => unknown

/**
 * The host app-boot package, located by absolute path.
 *
 * It is a HOST dependency, not one of this plugin's: resolving it from here
 * would mean depending on a private package at build time, so it is imported
 * from the host checkout instead. Mirrors the shape `clientBundle.test.ts` uses
 * for its OWN host package, but the path fragment is `dsh-app-boot` — a distinct
 * package that must not be confused with `dsh-client-modules`.
 */
const HOST_APP_BOOT_CANDIDATES = [
  process.env['DSH_WEB_CHECKOUT'] === undefined
    ? undefined
    : join(process.env['DSH_WEB_CHECKOUT'], 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'),
  '/dsh-home/profiles/web/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
].filter((candidate): candidate is string => candidate !== undefined)

/**
 * Resolves `readPluginMeta` from the first candidate that both exists AND loads.
 *
 * A candidate that is present but FAILS to load is treated as ABSENT: the
 * `import` is wrapped in try/catch so a structural mismatch inside the host
 * artifact degrades this case to a skip instead of throwing out of the module
 * graph and failing the whole file. Only actually obtaining the FUNCTION counts
 * as present.
 */
async function resolveReadPluginMeta(): Promise<ReadPluginMeta | undefined> {
  for (const candidate of HOST_APP_BOOT_CANDIDATES) {
    if (!existsSync(candidate)) continue
    try {
      const loaded = (await import(pathToFileURL(candidate).href)) as { readPluginMeta?: ReadPluginMeta }
      if (typeof loaded.readPluginMeta === 'function') return loaded.readPluginMeta
    } catch {
      // Present but unloadable ⇒ absent. Never rethrow: an artifact this test
      // does not control must not be able to fail the suite.
    }
  }
  return undefined
}

const readPluginMeta = await resolveReadPluginMeta()

/**
 * The reason the real-resolver case is skipped, spelled out so a reader of the
 * output cannot mistake a green run for "the real resolver was verified".
 */
const HOST_ABSENT_REASON =
  '宿主 app-boot 产物缺席，真实解析器未验证（readPluginMeta 未能从任何候选路径加载）'

const describeIfHost = describe.skipIf(readPluginMeta === undefined)

/** Reads and parses one locale file. */
function readLocaleJson(language: string): unknown {
  return JSON.parse(readFileSync(join(localeDir, `${language}.json`), 'utf8'))
}

/** The `meta` object of one locale file, narrowed for assertions. */
function metaOf(language: string): { title?: unknown; description?: unknown } {
  const parsed = readLocaleJson(language) as { meta?: { title?: unknown; description?: unknown } }
  return parsed.meta ?? {}
}

const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  name: string
  description: string
  exports: Record<string, unknown>
  files: string[]
}

// ---------------------------------------------------------------------------
// Structure — these run whether or not the host artifact is present
// ---------------------------------------------------------------------------

describe('locale/*.json structure', () => {
  it('ships both language files with a non-empty {meta:{title,description}}', () => {
    for (const language of ['en', 'zh']) {
      const meta = metaOf(language)
      expect(typeof meta.title, `${language}.json meta.title`).toBe('string')
      expect(typeof meta.description, `${language}.json meta.description`).toBe('string')
      expect((meta.title as string).trim(), `${language}.json meta.title`).not.toBe('')
      expect((meta.description as string).trim(), `${language}.json meta.description`).not.toBe('')
    }
  })

  it('holds no extra *.json and every filename is a legal language id', () => {
    // The host enumerates the DIRECTORY, so a stray JSON here becomes a bogus
    // locale (or a hard error) in the plugin list.
    const files = readdirSync(localeDir).filter((name) => name.endsWith('.json'))
    expect([...files].sort()).toEqual(['en.json', 'zh.json'])
    for (const name of files) {
      expect(name.slice(0, -'.json'.length)).toMatch(/^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/)
    }
  })

  it('exports the locale wildcard and ships the directory', () => {
    // Node's resolver refuses an unpublished subpath: without this export entry
    // `dsh-cherry-bridge/locale/en.json` never resolves, the host reads no
    // locale, and the row falls back to the package name.
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json')
    expect(pkg.files).toContain('locale')
  })

  it('pins the titles to the dictionaries and the descriptions to the pinned copy', () => {
    // `app.title` is the ONE value that silently degrades to the package name.
    expect(metaOf('en').title).toBe(dictionaries.en['app.title'])
    expect(metaOf('zh').title).toBe(dictionaries.zh['app.title'])
    expect(metaOf('en').title).toBe('Cherry Bridge')
    expect(metaOf('zh').title).toBe('Cherry 互联')
    // The English description is the manifest's own, verbatim.
    expect(metaOf('en').description).toBe(pkg.description)
    expect(metaOf('zh').description).toBe(
      '通过远程传输把本机 DeepSeek Harness 连接到 Cherry Studio 桌面端的插件',
    )
  })
})

// ---------------------------------------------------------------------------
// The REAL resolver, through the REAL wildcard export
// ---------------------------------------------------------------------------

describeIfHost(
  readPluginMeta === undefined ? `readPluginMeta (host app-boot) — SKIPPED: ${HOST_ABSENT_REASON}` : 'readPluginMeta (host app-boot)',
  () => {
    it('reads the bilingual title/description through the locale wildcard export', () => {
      // `parentURL = import.meta.url`: a file INSIDE this repository, so Node's
      // self-reference resolution finds this package's own `package.json` and
      // its `exports` map. No `repoRoot` probe file is invented for this.
      const meta = readPluginMeta?.(PACKAGE_NAME, import.meta.url)
      expect(meta).toBeDefined()

      const localized = meta as { title: unknown; description: unknown }
      // The bilingual shape is the proof that the wildcard export admitted the
      // files: absent that, this is the flat package-name string instead — the
      // SILENT degradation RED stage pinned above.
      expect(localized.title).toEqual({ en: dictionaries.en['app.title'], zh: dictionaries.zh['app.title'] })
      expect(localized.description).toEqual({
        en: pkg.description,
        zh: '通过远程传输把本机 DeepSeek Harness 连接到 Cherry Studio 桌面端的插件',
      })

      // ...and the same values are on DISK, byte-for-byte: the host reads the
      // files, so agreeing with the bundle alone would not ship a working row.
      for (const language of ['en', 'zh'] as const) {
        expect(metaOf(language).title).toBe((localized.title as Record<string, string>)[language])
        expect(metaOf(language).description).toBe((localized.description as Record<string, string>)[language])
      }
    })
  },
)
