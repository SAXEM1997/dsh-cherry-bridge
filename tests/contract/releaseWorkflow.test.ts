import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The tag-driven release is the PRIMARY release path: pushing `v*` publishes to
 * npm and creates the GitHub Release without a human in the loop. Its guards
 * are exactly the ones that fail silently when they are missing, so they are
 * asserted here rather than left to a checklist:
 *
 *  - a tag that does not name the `package.json` version publishes one version
 *    while the tag and the release announce another;
 *  - a missing or one-language CHANGELOG section ships an empty or
 *    half-translated release body (npm also serves the README captured in the
 *    tarball, so a pin bumped after publishing is stale forever);
 *  - an already-published version must be skipped, not republished (npm 409);
 *  - the release asset must be the PUBLISHED tarball, under the bare name the
 *    plugin catalog probes, not a hopeful rebuild or a versioned name.
 *
 * Read as text, like `workflows.test.ts`: the workflow is YAML with heavy
 * comments, and the assertions are about triggers, step order and command
 * presence, not about structure. A YAML round-trip would drop the comments
 * that carry the reasoning.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const RELEASE = join(repoRoot, '.github', 'workflows', 'release.yml')
const CI = join(repoRoot, '.github', 'workflows', 'ci.yml')
const CHANGELOG = join(repoRoot, 'CHANGELOG.md')

const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  version: string
}
const VERSION = manifest.version

const read = (path: string): string => readFileSync(path, 'utf8')

describe('the tag-driven release keeps the guards that fail silently', () => {
  it('①a release.yml exists, triggers on v* tags, and may write the release', () => {
    expect(existsSync(RELEASE), 'release.yml is gone: the release path is manual again').toBe(true)
    const text = read(RELEASE)
    expect(text).toMatch(/^on:\n {2}push:\n {4}tags: \['v\*'\]/m)
    // A dispatch is the dry-run door; the tag is the only real publish trigger.
    expect(text).toMatch(/^ {2}workflow_dispatch:/m)
    expect(text).toMatch(/^permissions:\n {2}contents: write$/m)
  })

  it('①b the tag check names the package.json version, and only a tag push enforces it', () => {
    const text = read(RELEASE)
    const tagStep = text.slice(
      text.indexOf('the tag names the version in package.json'),
      text.indexOf('the release notes for this version exist'),
    )
    expect(tagStep).toContain('TAG="${GITHUB_REF_NAME}"')
    expect(tagStep).toContain('[ "v$VERSION" = "$TAG" ]')
    // The dispatch mode is a dry run; a branch name is not a tag and must not
    // be compared as one.
    expect(tagStep).toContain('if [ "${{ github.event_name }}" = "push" ]; then')
    expect(tagStep.match(/exit 1/g)?.length, 'a tag mismatch must stop the run').toBe(1)
  })

  it('①c the token is preflighted before the notes and the gate', () => {
    // A dry run must answer "is the token still usable?" first, not after two
    // minutes of tests and a missing-notes failure.
    const text = read(RELEASE)
    expect(text).toContain('npm whoami')
    expect(text.indexOf('npm whoami')).toBeLessThan(
      text.indexOf('the release notes for this version exist'),
    )
  })

  it('①d the CHANGELOG section for this version exists, Chinese before English', () => {
    const text = read(CHANGELOG)
    const heading = `## v${VERSION} `
    const start = text.indexOf(heading)
    expect(start, `${heading} is the release body and must exist`).toBeGreaterThan(-1)
    const next = text.indexOf('\n## v', start + heading.length)
    const section = next === -1 ? text.slice(start) : text.slice(start, next)
    const zh = section.indexOf('**中文**')
    const en = section.indexOf('**English**')
    expect(zh, 'the section has no **中文**').toBeGreaterThan(-1)
    expect(en, 'the section has no **English**').toBeGreaterThan(zh)
    const enBody = section.slice(en + '**English**'.length).trim()
    expect(enBody.length, 'the English half is empty').toBeGreaterThan(0)
  })

  it('①e the workflow extracts that section and checks both language markers', () => {
    const text = read(RELEASE)
    expect(text).toContain('CHANGELOG.md')
    // The extraction line itself, not the `--notes-file` consumer: a bare
    // `toContain('release-notes.md')` survives renaming the awk target.
    expect(text).toContain('CHANGELOG.md > release-notes.md')
    // Anchor to the whole assignment: the error message quotes both markers,
    // and the `|| true` is what makes the missing-marker branch reachable
    // under `set -euo pipefail`.
    expect(text).toContain(
      "ZH=$(grep -n '^\\*\\*中文\\*\\*$' release-notes.md | cut -d: -f1 || true)",
    )
    expect(text).toContain(
      "EN=$(grep -n '^\\*\\*English\\*\\*$' release-notes.md | cut -d: -f1 || true)",
    )
    // Both markers existing is not enough: the order check keeps Chinese first.
    expect(text).toContain('[ "$ZH" -lt "$EN" ]')
    const notes = text.slice(
      text.indexOf('the release notes for this version exist'),
      text.indexOf('the README install pins'),
    )
    expect(notes.match(/exit 1/g)?.length, 'both notes failures must stop the run').toBe(2)
  })

  it('①f both README pin forms are checked before publishing', () => {
    // npm serves the README captured in the tarball; a pin bumped after the
    // publish is stale on the npm page for that version, permanently.
    const text = read(RELEASE)
    expect(text).toContain('for f in README.md README.en.md')
    // Anchor to the grep lines: the pack step also contains the @ spec, and
    // the error messages quote both specs, so bare `toContain` is too weak.
    expect(text).toContain('grep -q "dsh-cherry-bridge@$VERSION" "$f"')
    expect(text).toContain('grep -q "#v$VERSION" "$f"')
    expect(text.indexOf('README.en.md')).toBeLessThan(text.indexOf('npm publish --tag latest'))
    const pins = text.slice(
      text.indexOf('the README install pins'),
      text.indexOf('a backfill must not move latest backwards'),
    )
    expect(pins.match(/exit 1/g)?.length, 'both pin forms must stop the run').toBe(2)
  })

  it('①g the gate runs prepublishOnly and the committed-artifact diff before publishing', () => {
    const text = read(RELEASE)
    expect(text).toContain('npm run prepublishOnly')
    expect(text).toContain('git diff --exit-code -- dist lib')
    expect(text).toContain('npm ci')
    expect(text.indexOf('npm ci')).toBeLessThan(text.indexOf('npm run prepublishOnly'))
    expect(text.indexOf('npm run prepublishOnly')).toBeLessThan(
      text.indexOf('npm publish --tag latest'),
    )
    expect(text.indexOf('git diff --exit-code -- dist lib')).toBeLessThan(
      text.indexOf('npm publish --tag latest'),
    )
  })

  it('①h publishing is idempotent, names latest, and has a dry-run door', () => {
    const text = read(RELEASE)
    // Two steps, not one shell branch: the tag step is the only one that can
    // publish; the dispatch step is the only one that can dry-run.
    const publish = text.slice(
      text.indexOf('publish (tag push only)'),
      text.indexOf('dry run (dispatch only)'),
    )
    expect(publish).toContain("if: github.event_name == 'push'")
    expect(publish).toContain('if npm view "dsh-cherry-bridge@$VERSION" version')
    expect(publish).toContain('is already published; skipping')
    expect(publish).toContain('npm publish --tag latest')
    const dry = text.slice(
      text.indexOf('dry run (dispatch only)'),
      text.indexOf('take the published tarball'),
    )
    expect(dry).toContain("if: github.event_name == 'workflow_dispatch'")
    expect(dry).toContain('npm publish --dry-run --tag latest')
    // A bare `npm publish` in the dry-run step would publish for real; the
    // negative lookahead keeps every publish here behind `--dry-run`.
    expect(dry).not.toMatch(/npm publish(?! --dry-run)/)
  })

  it('①i the registry latest tag must name this version before the release', () => {
    // An unapproved stage was silent; a backfill is not. A release may only be
    // created for the version the registry calls latest, or `--latest` moves
    // the catalog URL onto a version nobody can install.
    const text = read(RELEASE)
    // The pre-publish check is what refuses a backfill: publishing first would
    // move `latest` to the older version, and the post-publish check would then
    // agree with itself.
    const backfill = text.slice(
      text.indexOf('a backfill must not move latest backwards'),
      text.indexOf('      - run: npm ci'),
    )
    expect(backfill).toContain('case "$VERSION" in')
    expect(backfill).toContain('*-*')
    expect(backfill).toContain('LATEST=$(npm view dsh-cherry-bridge dist-tags.latest)')
    // Pin the whole comparison line: changing the printf arguments to
    // `"$LATEST" "$LATEST"` would make the guard refuse every new release.
    expect(backfill).toContain(
      "HIGHER=$(printf '%s\\n%s\\n' \"$LATEST\" \"$VERSION\" | sort -V | tail -1)",
    )
    expect(backfill).toContain('[ "$HIGHER" = "$VERSION" ]')
    expect(backfill.match(/exit 1/g)?.length, 'both backfill failures must stop the run').toBe(2)
    expect(text.indexOf('a backfill must not move latest backwards')).toBeLessThan(
      text.indexOf('npm publish --tag latest'),
    )
    expect(text).toContain('[ "$LATEST" = "$VERSION" ]')
    // Both checks are only meaningful before the release exists.
    expect(text.indexOf("the registry's latest tag names this version")).toBeLessThan(
      text.indexOf('gh release create'),
    )
    const latest = text.slice(
      text.indexOf("the registry's latest tag names this version"),
      text.indexOf('create the GitHub Release (idempotent)'),
    )
    expect(latest.match(/exit 1/g)?.length, 'a stale latest tag must stop the release').toBe(1)
  })

  it('①j the published tarball is downloaded and checked against dist.shasum', () => {
    const text = read(RELEASE)
    expect(text).toContain('npm pack "dsh-cherry-bridge@$VERSION"')
    expect(text).toContain('dist.shasum')
    expect(text).toContain('[ "$ACTUAL" = "$EXPECTED" ]')
    // The bytes are only evidence if they are taken before the release exists.
    expect(text.indexOf('dist.shasum')).toBeLessThan(text.indexOf('gh release create'))
    // Registry metadata can be visible before the tarball is downloadable.
    expect(text).toContain('for attempt in $(seq 1 12)')
    const pack = text.slice(
      text.indexOf('take the published tarball, byte for byte'),
      text.indexOf("the registry's latest tag names this version"),
    )
    expect(pack.match(/exit 1/g)?.length, 'both pack failures must stop the run').toBe(2)
  })

  it('①k the release is created from the extracted notes, and the bare asset is attached', () => {
    const text = read(RELEASE)
    expect(text).toContain('gh release view "v$VERSION"')
    expect(text).toContain('gh release create "v$VERSION"')
    expect(text).toContain('--notes-file release-notes.md')
    // Anchor to the create command: the header comment mentions `--latest`
    // too, so a bare `toContain` would survive deleting the flag.
    expect(text).toMatch(/gh release create[\s\S]*?--latest/)
    // The upload line is what the catalog URL resolves to; a versioned name
    // there 404s every catalog user (0.1.5 shipped exactly this way).
    const upload = /^.*gh release upload.*$/m.exec(text)?.[0] ?? ''
    expect(upload, 'the upload step is gone').toContain('gh release upload')
    expect(upload).toContain('dsh-cherry-bridge.tgz')
    expect(upload, 'a re-run must overwrite the asset, not fail on it').toContain('--clobber')
    expect(upload, 'a versioned asset name 404s the catalog URL').not.toMatch(
      /dsh-cherry-bridge-\$/,
    )
  })

  it('①l the catalog URL check retries, so propagation delay is not a red release', () => {
    // 0.3.0's attach run failed on a single curl that answered 504 for about
    // three minutes after the upload — the release was complete and correct.
    const text = read(RELEASE)
    const urlStep = text.slice(text.indexOf("the catalog's URL answers 200"))
    // Anchor to the URL step: the dist-tags loop also uses `seq 1 6`, so a bare
    // `toContain` would survive deleting the URL retry.
    expect(urlStep).toContain('for attempt in $(seq 1 6)')
    // Anchor to the URL variable: the same path is quoted in the header
    // comments, so a bare `toContain` would survive breaking the actual URL.
    expect(urlStep).toContain(
      'URL="https://github.com/${GITHUB_REPOSITORY}/releases/latest/download/dsh-cherry-bridge.tgz"',
    )
    expect(urlStep.match(/exit 1/g)?.length, 'the URL failure must stop the run').toBe(1)
  })

  it('①m ci.yml does not also trigger on tags', () => {
    // Two gates for one release would run the whole suite twice and make it
    // ambiguous which run is authoritative. The branch filter is what keeps
    // the push trigger off tags; removing it makes the workflow fire on both.
    const ci = read(CI)
    const on = ci.slice(ci.indexOf('on:'), ci.indexOf('permissions:'))
    // Any `tags:` spelling under `on:` makes CI fire on a release tag; the
    // push trigger must also keep its branch filter.
    expect(on).not.toMatch(/tags:/)
    expect(on).toMatch(/push:\n\s+branches: \[main\]/)
  })

  it('①n every publishing and release step is gated to a tag push', () => {
    // The dispatch is a dry run: without these gates it would publish, create a
    // release and attach an asset while the dry-run step is the only one that
    // should run.
    const text = read(RELEASE)
    const gated = [
      'publish (tag push only)',
      'take the published tarball, byte for byte',
      "the registry's latest tag names this version",
      'create the GitHub Release (idempotent)',
      'attach the version-independent tarball name',
      "the catalog's URL answers 200",
    ]
    for (const name of gated) {
      const start = text.indexOf(`- name: ${name}`)
      expect(start, `${name} is missing`).toBeGreaterThan(-1)
      const run = text.indexOf('run: |', start)
      // Anchor the whole line: an appended `|| github.event_name == ...`
      // would keep a bare `toContain` green while letting a dispatch through.
      expect(text.slice(start, run), `${name} is not gated to a tag push`).toMatch(
        /^\s*if: github\.event_name == 'push'$/m,
      )
    }
  })
})
