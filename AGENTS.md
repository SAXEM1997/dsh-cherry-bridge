# AGENTS.md — working on dsh-cherry-bridge

Engineering notes for AI agents and contributors. **`README.md` / `README.en.md`
are for users**: what the plugin is, how to install and use it, the config table
and a one-line-per-tool overview.

THIS file holds the rules that apply wherever you work: the flow, the build
facts, the release procedure. Each tree's own contracts live beside it, in a
nested `AGENTS.md` the harness loads when you touch that tree, so ~54 KB of
invariants is not paid on every turn. Review verdicts, fix histories and issue
numbers are **not** migration targets: they are process records, and they stay
in `docs/superpowers/**` (not published).

## Where the rules live

| File | Loads when | Holds |
| --- | --- | --- |
| `AGENTS.md` (this file) | every session | flow, TDD + mutation, commits, npm env, build facts, release, agent skills |
| `src/AGENTS.md` | a file tool touches `src/**` | protocol basis, every design invariant, upstream references |
| `tests/AGENTS.md` | a file tool touches `tests/**` | the loopback fake, test shapes and numbering, waiting without sleeps |
| `ui/AGENTS.md` | a file tool touches `ui/**` | the settings page's seams (i18n, SSE, the API client) |

A nested file loads AUTOMATICALLY when a file tool (`read`, `write`, `edit`, …)
touches something beneath its directory. A **`bash`-only** turn (`sed`, `awk`,
`grep`) does not trigger it, which is why the rules that must survive such a
turn — the byte budget, artifact freshness, commit style, the README pair — stay
in THIS file. The logging rule sits in `src/AGENTS.md`, beside every site it
governs: a turn that could add a log line edits a `src/**` file, and that is
what loads it.

## Contents

1. [Development conventions](#development-conventions)
2. [Build facts](#build-facts)
3. [Release](#release)
4. [Agent skills](#agent-skills)

---

## Development conventions

**Flow — GitHub Flow, one issue per branch.**

    issue → branch (off main) → TDD → PR → independent review → squash merge

- **Test first.** Write the failing test, watch it fail for the intended
  reason, then implement. Every new or changed test must be **mutation-verified**:
  break the implementation deliberately (invert the branch, delete the guard,
  return the old value) and confirm the test turns red. A test that passes
  against both the old and new code is not a test.
- **Sub-task test strategy.** While working, run only `npx vitest run
  tests/<area>/<file>.test.ts` plus `npm run typecheck` when types moved; the
  **full** suite (`npm test`) runs **once, by the integrator before merge**.
  `artifactFreshness` is the exception: it matters when source comments or
  build config changed.
- **No source change without its artifact.** `src/`/`ui/` edits and their
  rebuilt `dist/`/`lib/` go in the **same commit** (see [Build facts](#build-facts)).
- **Scope discipline.** Change what the issue names. Adjacent discoveries go
  into a new issue, not into the diff. A doc-only change touches only docs.
- **Review tier follows weight.** A code change of substance gets INDEPENDENT
  reviewers (two axes, read-only, evidence and coverage boundaries); a small
  fix (a number, a comment, a renumbering) and a docs-only change are reviewed
  by the integrator itself. The tier decides WHO looks, never WHAT is checked:
  the same evidence and mutation standard applies at every tier.
- **The READMEs are a pair.** `README.md` (简体中文) and `README.en.md` (English)
  are expected to say the same thing; an edit to one is an edit to both.
- **Every AGENTS.md lives under a byte budget.** The workspace-instruction
  budget is 65,536 bytes per rendered baseline or batch; the harness **silently
  truncates the tail** past it — observed here: rules at the file's end vanished
  from context. Keep each file **≤ 64,512 bytes** (64 KiB − 1 KiB safety; check
  `wc -c` on it); an addition needs a compensating trim in the same change.
- **Every promise a test starts settles INSIDE the test.** A request or
  `connect()` nobody awaits still holds its caller for `DEFAULT_TIMEOUT_MS` when
  the answer never comes; `void ... .catch(() => {})` hides that, and the next
  afterEach that awaits it turns it into a stalled suite. Produce the settlement
  (usually `close()`) and **assert** the verdict — issue #43 is the two masked
  sites.
- **Commit messages** are English, imperative, `type(scope): summary` —
  `fix(tools):`, `feat(scope):`, `test(connection):`, `docs:`, `chore(release):`.
  The body explains the failure mode that motivated the change and the
  invariant the new code establishes, not a restatement of the diff.

**npm environment (this machine).** Any `npm install` / `npm view` / lock
regeneration must run with

```bash
NPM_CONFIG_CACHE=/workspace/dsh/.superpowers/npm-cache \
  npm <command> --registry=https://registry.npmjs.org/
```

The default registry here is `registry.npmmirror.com`, and `~/.npm` is not
writable under the file sandbox. Without both flags you get (a) `EACCES`, and
(b) **`package-lock.json` rewritten to npmmirror URLs**, which fails the
contract suite's resolved-URL host assertion. `node_modules/` is normally
already installed — do not reinstall casually. `packageManager` is pinned;
`package-lock.json` is committed and its `resolved` versions must agree with
their keys (there is a contract assertion for exactly that).

## Build facts

**Two outputs, both committed.**

| Output | Built by | Command |
| --- | --- | --- |
| `dist/index.mjs`, `dist/index.d.mts` | tsdown (`tsdown.config.ts`) | `npm run build` |
| `lib/client.js` (settings-page web bundle) | vite (`ui/vite.config.ts`) | `npm run build:client` |

- **tsdown preserves JSDoc into `dist/index.mjs`.** A change that only touches
  `src/**` **comments** still changes the artifact bytes; editing an exported
  declaration's doc comment needs `dist` rebuilt in the same commit.
- **`prepublishOnly` vs `artifactFreshness` — two different gates.**
  - `prepublishOnly` =
    `typecheck && test && build && build:client && npm pack --dry-run`: the
    whole chain (both type projects, the full suite, both builds, the pack
    check) on the publish path; it proves the tree *is* buildable.
  - `artifactFreshness` = rebuild from current source (into a temp dir) and
    byte-compare against **what is committed** — the gate that catches
    "changed source, forgot to rebuild", including comment-only drift. It
    proves the artifacts came from this exact source and runs in the fast suite.
  - The contract suite's "clean clone → pack" case is a third, coarser arm: a
    clone without `node_modules` must already carry the three artifacts, and
    the `npm pack --ignore-scripts` tarball must contain them. It sees
    *existence*, never bytes.
- **There is deliberately no `prepare` hook:** it also runs on `npm install`,
  where `--omit=dev` prunes devDependencies first, so it dies (exit 127)
  looking for `tsdown`/`vite`. Committing the artifacts makes git installs,
  `--omit=dev` and packing a bare clone work with zero build steps.
- **The publish surface** (`package.json` `files`): `lib`, `dist`, `src`, `ui`,
  `locale`, `docs/e2e-checklist.md`, `cordis.patch.yml`, `README.md`,
  `README.en.md`, `static`.
  - `src` and `ui` are published **on purpose** (host-side troubleshooting
    against the artifacts, fork development); runtime resolution goes through
    `exports` → `dist/*` and `lib/client.js` only.
  - `static` carries the README banner; `README.en.md` is the other half of the
    language switcher — dropping either breaks the rendered npm page.
  - `docs/e2e-checklist.md` is listed by file; the **`docs` directory itself
    must not be listed**, or `docs/superpowers/**` internal specs/plans would
    ship in the tarball.
  - Exports: `.` is conditioned (`types` → `dist/index.d.mts`, `default` →
    `dist/index.mjs`); `./client` → `lib/client.js`; `./locale/*.json`;
    `./package.json`.
- **Runtime dependencies that are not dead weight:** `zod` is a **runtime**
  dependency (the protocol package `import`s it in its runtime output; peer
  `^4.3.4`, pinned `4.3.4`). `@cherrystudio/remote-protocol` is external in
  `dist`, so zod is not bundled away. `@libp2p/peer-id` (pinned `6.0.15`, at the
  transport's own dependency — contract-asserted) exists for ONE thing: the pin
  decode in Pairing.
- **TypeScript is pinned `~7.0.2`** (patch digit only). Accepted risk:
  tsdown's dts output rides TS 7's experimental declaration API, which may
  move across minors; the patch-only range means it cannot move silently. An
  upgrade is an explicit edit plus a build plus the full suite; a bad one
  shows in the byte gate at once.

## Release

`npm run prepublishOnly` is the gate (typecheck, the full suite, both builds,
and `npm pack --dry-run`).
Then walk [`docs/e2e-checklist.md`](docs/e2e-checklist.md): Electron-side
approvals cannot be CI'd, so pairing / send / interaction answers / disconnect
recovery / multi-device coexistence must be exercised by hand on a real desktop.
Tag `vX.Y.Z`, publish to npm (`publishConfig` pins the public registry), and
attach the notes to the GitHub release.

**Three release steps fail silently when skipped.**

1. **Publish through staged publishing.** Direct `npm publish` is refused here
   (`E403 … two-factor authentication … required`); the npm bundled with Node 22
   (10.x) has no `stage`, so use npm 11:
   `NPM_CONFIG_CACHE=/workspace/dsh/.superpowers/npm-cache npx npm@11 stage publish --registry=https://registry.npmjs.org/ --access public --tag latest`
   (add `--ignore-scripts` only when `prepublishOnly` just passed on this exact
   clean tree), then approve the printed stage id on npmjs.com →
   **Staged Packages**. `npm stage approve` answers `404 staged version … not
   found` here (every token tried, incl. `--otp`), while `GET /-/stage/<id>`
   returns 200 — the web approval is the one that works.
   Check the result with
   `npm view dsh-cherry-bridge dist-tags`: an unapproved stage is silent.
   A first publish also leaves a public `0.0.0-stage` placeholder in
   `versions` (0.1.5 did); approving moves `latest` to the real version.
2. **Bump BOTH README install pins in the same commit, before staging** — the
   `@X.Y.Z` and `#vX.Y.Z` specs in `README.md` and `README.en.md`. npm serves
   the README captured in the tarball, so a pin bumped after the publish is
   stale on the npm page.
3. **Re-attach the version-INDEPENDENT release asset.** The market entry
   (`awesome-dsh-plugin`, `data/plugins/SAXEM1997__dsh-cherry-bridge.yml`)
   points at `releases/latest/download/dsh-cherry-bridge.tgz`, so **every**
   release must attach the tarball under exactly that name (not
   `dsh-cherry-bridge-X.Y.Z.tgz`). Verify that URL answers 200 and that its sha1
   equals the npm tarball's: without the asset the download URL 404s for every
   catalog user (0.1.5 did exactly that).

The catalog needs no PR for a new version: the merged entry is picked up by the
index's nightly probe (02:23 UTC) once `package.json`'s `repository` points
back at this repo.

Documentary labels in code comments and docs — `Task N`, `spec §x`, `controller
ruling`, `UltraReview` — point at internal SDD process records under
`docs/superpowers/**`, **not published** with the package; they stay
where the rule is, as provenance. `tests/loopback/fakeCherry.ts` is an in-test
loopback fake peer, not a shipped artifact.

## Agent skills

Issue tracker: GitHub Issues via the `gh` CLI (`origin` is a GitLab mirror;
issues are on GitHub only). Triage labels: the five canonical defaults
(`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`). Domain docs: single-context — one `GLOSSARY.md` and one `docs/adr/`
at the repo root, both created lazily. Each has a file in `docs/agents/`.
