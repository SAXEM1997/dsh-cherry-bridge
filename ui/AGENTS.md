# AGENTS.md — `ui/`

The settings page: pairing wizard, device cards and the tool-scope panel. It
builds to `lib/client.js` (`npm run build:client`) and that bundle is COMMITTED
with its source. Loaded automatically when a file tool touches `ui/**`.

- **One view, no router.** `App.tsx` owns the two things that outlive both
  children: the SSE stream and the device map.
- **The stream opens ONCE on mount and closes on unmount, in that order.** The
  verification code exists only as a frame with no replay, so the stream must
  exist before the wizard can `POST /pair` — which is why the submit button
  stays disabled until `subscribed` flips true.
- **`device-state` is a FIRST-FRAME contract.** The REST list supplies the
  static fields; a card's light shows only a state the server actually sent.
- **Every user-visible string goes through `t()`** (`i18n.ts`, zh and en in the
  same change). A token that must never render — the missing-`EventSource`
  marker — is a constant, not a sentence, and the component translates it.
- **HTTP lives in `api.ts`** (same-origin `/cherry-remote/api`); a component
  never fetches directly. Both seams are injected for tests
  (`eventSourceFactory`, `scopeClient`), so no test stands up a server.
- **A run always ends, and the deadline is not a verdict.** The server publishes
  a terminal stage on every outcome, but the stream has no replay, so one lost
  frame would otherwise park the wizard on 「配对进行中」 with the submit button
  disabled and no cancel. The run deadline (`runLifetimeMs`, same injection
  style as `codeLifetimeMs`) restores the form and re-reads the device list;
  its copy points at that list instead of claiming failure, and it keeps
  `claimId` so a terminal frame that arrives late still wins. Arm it on the
  `waiting` phase only — never at mount.
- **The bundle carries the SOURCE COMMENTS.** `ui/vite.config.ts` sets
  `minify: false`, so the docblocks that hold most of this page's reasoning ship
  inside `lib/client.js`: a comment-only edit in `ui/src/**` changes the
  artifact's bytes and needs the rebuild in the same commit. Two follow-ons from
  that: `artifactFreshness` compares against `git show HEAD:<path>`, so it only
  goes green once the rebuild is COMMITTED — running the full suite before
  committing reports it red for the same reason its sibling case ("neither check
  mutates the committed artifacts") is red. Neither red is a real failure.
- **jsdom only.** `tests/unit/ui.test.ts` and `uiScopePanel.test.ts` render the
  page; a browser-only API needs a fake in the test, not a guard in the page.

