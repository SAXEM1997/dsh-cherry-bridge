import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The workflows are the only place three documented silent failures are caught
 * automatically, and nothing else in the suite reads them — delete a step and
 * every test still passes while the release procedure quietly loses its guard.
 *
 * These assertions are deliberately TEXTUAL. There is no YAML parser in the
 * dependency tree, and a hand-rolled one would assert less than the three
 * literal strings that actually matter: the asset NAME, the artifact diff, and
 * the refusal to attach before approval.
 *
 * Each case names the failure mode it prevents, because a test whose value is
 * "this string is still there" rots into an obstacle without one.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const CI = join(repoRoot, '.github', 'workflows', 'ci.yml')
const PUBLISH = join(repoRoot, '.github', 'workflows', 'publish.yml')

describe('the workflows keep the guards that make a silent failure loud', () => {
  it('①a both workflows exist', () => {
    expect(existsSync(CI), 'ci.yml is gone: no push or PR runs any gate').toBe(true)
    expect(existsSync(PUBLISH), 'publish.yml is gone: the release path is manual again').toBe(true)
  })

  it('①b the release asset is attached under the version-INDEPENDENT name', () => {
    // The plugin catalog points at
    // releases/latest/download/dsh-cherry-bridge.tgz. Attaching
    // `dsh-cherry-bridge-0.3.0.tgz` instead 404s that URL for every catalog
    // user, and nothing in the release itself looks wrong (0.1.5 shipped
    // exactly this way).
    const text = readFileSync(PUBLISH, 'utf8')
    // Scoped to the UPLOAD line: the step above legitimately renames the
    // downloaded `dsh-cherry-bridge-$VERSION.tgz`, and only what gets attached
    // is what the catalog URL resolves to.
    const upload = /^.*gh release upload.*$/m.exec(text)?.[0] ?? ''
    expect(upload, 'the upload step is gone').toContain('gh release upload')
    expect(upload).toContain('dsh-cherry-bridge.tgz')
    expect(upload, 'a versioned asset name 404s the catalog URL').not.toMatch(/dsh-cherry-bridge-\$/)
  })

  it('①c ci.yml compares the committed artifacts against a fresh build', () => {
    // `artifactFreshness` does this byte for byte inside the suite, against
    // `git show HEAD:`. The workflow's copy is the arm that names the file in
    // the log, so a "changed source, forgot to rebuild" failure is readable
    // without reading a test report.
    const text = readFileSync(CI, 'utf8')
    expect(text).toMatch(/git diff --exit-code -- dist lib/)
  })

  it('①e the catalog URL check retries, so propagation delay is not a red release', () => {
    // 0.3.0's attach run failed on a single `curl` that answered 504 for about
    // three minutes after the upload — the release was complete and correct.
    const text = readFileSync(PUBLISH, 'utf8')
    expect(text).toContain('for attempt in')
  })

  it('①d publish.yml refuses to attach before the stage was approved', () => {
    // An unapproved stage is SILENT: `dist-tags` simply does not move. Without
    // this gate the workflow would happily attach a tarball for a version
    // nobody can install.
    const text = readFileSync(PUBLISH, 'utf8')
    // The QUERY, not a mention: the error message quotes `dist-tags.latest`
    // too, so asserting the bare string survives deleting the check.
    expect(text).toContain('npm view dsh-cherry-bridge dist-tags.latest')
    expect(text).toContain('[ "$LATEST" = "$VERSION" ]')
    // And the tarball really is the published one, not a hopeful rebuild.
    expect(text).toContain('dist.shasum')
    expect(text).toContain('[ "$ACTUAL" = "$EXPECTED" ]')
  })
})
