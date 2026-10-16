import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * R3-F2 (routed from F1): the committed build artifacts must stay FRESH.
 *
 * `dist/index.mjs`, `dist/index.d.mts` and `lib/client.js` are committed — the
 * host loads them directly when this plugin is installed from git, so a stale
 * artifact is not a cosmetic problem: it is a plugin that does not contain the
 * fix its own source claims. The `.d.mts` arm exists for the same reason on the
 * TYPE face: `exports.types` resolves to it, so a stale copy describes a public
 * surface the shipped `.mjs` no longer implements — a consumer typechecks
 * against a signature the runtime does not have, or misses one it does. (The
 * committed file happens to be byte-identical to the base commit today, which is
 * exactly what this arm is here to keep true through the next source change; it
 * is not evidence that some method is currently missing.) Nothing else in the
 * suite catches that. `clientBundle.test.ts` does run `build:client`, but it
 * then asserts on the bundle it JUST produced, so a stale committed file and a
 * fresh one are indistinguishable to it; and nothing rebuilds the server half at
 * all.
 *
 * The check is the strong one — REBUILD AND COMPARE BYTES — rather than a
 * checked-in hash manifest, and the tradeoff is worth stating because it is the
 * whole design of this file:
 *
 *  - A manifest is cheap but WEAK. It only proves the artifacts have not changed
 *    since the manifest was last updated, and the manifest is updated by the
 *    same command that rebuilds them (`prepublishOnly`). A developer who
 *    rebuilds, forgets to commit `dist`, and refreshes the manifest in the same
 *    sweep leaves the manifest green over an artifact that no longer matches
 *    `src` — the exact failure this exists to catch.
 *  - A real rebuild is the ground truth: it compares the committed artifact
 *    against what the CURRENT source actually produces. It costs a couple of
 *    seconds per server artifact plus the client build on this repo (measured),
 *    which is within the suite's budget.
 *
 * TWO THINGS MAKE THIS SOUND, and both are load-bearing rather than stylistic:
 *
 *  1. The build goes to a TEMP OUT DIR, never over the artifact under test. An
 *     in-place rebuild would REPAIR the staleness and then compare the repaired
 *     file against itself — a test that can only ever pass. (tsdown takes
 *     `--out-dir`; vite's client build is pointed at a temp dir through the
 *     outDir override in `ui/vite.config.ts`.)
 *  2. The comparison is against the artifact AS COMMITTED (`git show
 *     HEAD:<path>`), not the working-tree copy. The working tree is exactly
 *     what a careless `npm run build` mutates, so comparing against it would
 *     let an uncommitted rebuild satisfy the check.
 *
 * Both builds are byte-deterministic here (repeated runs produce identical
 * output, which is why `git status` stays clean after a rebuild), so byte
 * equality is a legitimate assertion rather than a flaky one.
 *
 * When it fails the fix is one command: `npm run build && npm run build:client`
 * then commit `dist` and `lib`.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The committed artifacts and the script that regenerates each one.
 *
 * `args` are appended to the SCRIPT's own command (`npm run <script> -- <args>`),
 * which is how tsdown is redirected: it takes `--out-dir` on the command line.
 * The client build has no such flag, so it reads `CHERRY_BUILD_OUT_DIR` from the
 * environment instead (see `ui/vite.config.ts`).
 */
const ARTIFACTS: ReadonlyArray<{ label: string; path: string; script: string; entry: string; args: string[] }> = [
  { label: 'server (dist/index.mjs)', path: 'dist/index.mjs', script: 'build', entry: 'index.mjs', args: ['--out-dir'] },
  {
    label: 'types (dist/index.d.mts)',
    path: 'dist/index.d.mts',
    script: 'build',
    entry: 'index.d.mts',
    args: ['--out-dir'],
  },
  { label: 'client (lib/client.js)', path: 'lib/client.js', script: 'build:client', entry: 'client.js', args: [] },
]

/** The artifact as COMMITTED — the only copy a careless rebuild cannot touch. */
function committedArtifact(path: string): Buffer {
  return execFileSync('git', ['show', `HEAD:${path}`], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
}

/** Builds one artifact into `outDir` and returns the bytes it produced. */
function buildInto(
  artifact: { script: string; entry: string; args: string[] },
  outDir: string,
): Buffer {
  execFileSync('npm', ['run', artifact.script, '--', ...artifact.args, outDir], {
    cwd: repoRoot,
    stdio: 'pipe',
    // Read by the vite client config to redirect its `outDir`. Unset in every
    // normal build, so the published path is unchanged.
    env: { ...process.env, CHERRY_BUILD_OUT_DIR: outDir },
  })
  return readFileSync(join(outDir, artifact.entry))
}

describe('R3-F2: the committed build artifacts match a fresh build of the current source', () => {
  for (const artifact of ARTIFACTS) {
    it(`${artifact.label} is byte-identical to \`npm run ${artifact.script}\` from the current source`, () => {
      const outDir = mkdtempSync(join(tmpdir(), 'cherry-freshness-'))
      try {
        const fresh = buildInto(artifact, outDir)
        const committed = committedArtifact(artifact.path)
        expect(committed.length).toBeGreaterThan(0)
        expect(
          fresh.equals(committed),
          `${artifact.label} is STALE: the committed artifact differs from a fresh build of the current ` +
            'source. Run `npm run build && npm run build:client` and commit dist/ and lib/.',
        ).toBe(true)
      } finally {
        rmSync(outDir, { recursive: true, force: true })
      }
    }, 120_000)
  }

  it('neither check mutates the committed artifacts', () => {
    // The suite must be a no-op on a healthy tree. An in-place rebuild would
    // both dirty the tree and — far worse — repair the very staleness the
    // assertions above exist to detect.
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'dist', 'lib'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(dirty.trim()).toBe('')
  })
})
