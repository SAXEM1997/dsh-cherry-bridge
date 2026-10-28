import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Release surface: the README pins ARE the published install.
 *
 * Both READMEs open with two pinned install commands — one for the npm registry
 * (`dsh-cherry-bridge@X.Y.Z`) and one for the git spec (`…/dsh-cherry-bridge#vX.Y.Z`).
 * Release step ② is "bump both pins in the same commit as the version, BEFORE
 * staging", and skipping it fails SILENTLY: npm serves the README captured in the
 * tarball, so the npm page keeps advertising the previous version and nothing
 * anywhere goes red.
 *
 * So the invariant is made a test. It costs nothing on a normal commit — the bump
 * and the pins ship together, so `package.json`'s version IS the pinned version at
 * every point in history — and it turns the forgotten half into a red suite.
 *
 * The expected value comes from an INDEPENDENT artifact (`package.json`), never
 * from the README itself, so a test that agreed by construction cannot happen here.
 *
 * Package: `@cherrystudio/remote-protocol` is unrelated; the pattern is anchored on
 * OUR package name, so the READMEs' other pinned versions (`zod`, `ws`) cannot
 * satisfy or trip either case.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const README_FILES = ['README.md', 'README.en.md'] as const

/**
 * `@` for the npm spec, `#v` for the git spec. The version may carry a
 * prerelease suffix, and the match is anchored on the package name so an
 * unprefixed prose mention (`dsh-cherry-bridge`) is not a pin.
 */
const PIN_PATTERN = /dsh-cherry-bridge[#@]v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g

const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  version: string
}

const VERSION = manifest.version

function pinnedVersions(file: (typeof README_FILES)[number]): string[] {
  const text = readFileSync(join(repoRoot, file), 'utf8')
  return [...text.matchAll(PIN_PATTERN)].map((match) => match[1]!)
}

describe('release pins: both READMEs install the version package.json ships', () => {
  it('①a both install forms carry the CURRENT version, per README', () => {
    for (const file of README_FILES) {
      const text = readFileSync(join(repoRoot, file), 'utf8')
      // The two forms are asserted as whole specs, not as "some version" — a pin
      // that matched trivially would let a README ship the right number in the
      // wrong command.
      expect(text, `${file} is missing the pinned npm spec @${VERSION}`).toContain(
        `dsh-cherry-bridge@${VERSION}`,
      )
      expect(text, `${file} is missing the pinned git spec #v${VERSION}`).toContain(
        `dsh-cherry-bridge#v${VERSION}`,
      )
    }
  })

  it('①b no OTHER version is pinned anywhere in a README', () => {
    // The half that a presence-only assertion cannot catch: someone adds the new
    // pin and leaves the previous one behind, and both forms then "carry the
    // current version" while the older command still installs 0.1.9.
    for (const file of README_FILES) {
      const stale = pinnedVersions(file).filter((version) => version !== VERSION)
      expect(stale, `${file} still pins an older release`).toEqual([])
    }
  })
})
