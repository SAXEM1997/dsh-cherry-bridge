# Changelog

All notable changes to `dsh-cherry-bridge`. This project adheres to
[Semantic Versioning](https://semver.org/): the minor digit carries new
capability, the patch digit carries fixes and hardening with no protocol
surface change.

## [Unreleased]

### Added

- `feat(tools)`: `cherry_read` takes an optional `messagesResumeCursor`, the stop
  point a truncated read returned — the older messages cut by an
  `aggregate-bytes` (or `limit`) stop are now reachable through the tool instead
  of only on the desktop (#26). From a resume point, `limit` bounds how many
  messages one answer carries, so a long history is walked in successive answers.
  The token from the terminal/timeout/idle aggregate (`cherry_send(wait: true)` /
  `cherry_wait`) is accepted by `cherry_read` too.
- Resume tokens whose anchor message is no longer in the history fail with an
  error naming the message id, and an anchor scan is bounded by
  `MAX_ANCHOR_SCAN_PAGES` (500 pages) — both loud, never an empty page presented
  as "no older history".
- `feat(tools)`: a read cache for message part LISTS (#15). The
  `agent.parts.list` result — the raw part records plus the walk's verdict — is
  held per message and reused while `agent.messages.list` still reports the same
  revision, so a repeated read of a quiet session costs no `agent.parts.list`
  RPC for an unchanged message; the terminal/timeout/idle aggregates share the
  same cache. A hit still re-projects the records: every externalized `{ref}` is
  re-fetched through `agent.content.read` and sha256-verified on every read, so
  the cache never serves unverified bytes and a tampered content store still
  fails the read. What it saves is the list walk; what it holds is the part
  RECORDS (the resolved `{ref}` text is never retained, though inline part text
  is). Entries are never held for a row with no revision, for a TRUNCATED parts
  page (a circuit-broken walk must be retried), or above either byte bound (1
  MiB per entry, 32 MiB per device — an entry that cannot fit the device budget
  is refused whatever the entry cap says). Eviction is FIFO, a refresh keeps the
  entry's insertion position and makes room for its GROWTH, and each evicting
  insert warns once naming only the device and the count; the entries are
  dropped with the device's session caches when it goes offline.

### Changed

- The `messagesResumeCursor` token SHAPE is now self-describing:
  `cursor:<peer position>` (the whole collected window was consumed) or
  `after:<messageId>` (the walk stopped inside that window, where the peer's
  page position would skip trimmed messages). The previous raw peer position
  (`"20"`) is no longer emitted, and a token not carrying one of these two
  prefixes — including a raw peer position — is refused locally before any
  device work. The peer's cursor format is never parsed or validated, because a
  malformed cursor is silently swallowed by the real desktop (it falls back to
  the newest page).
- `fix(tools)`: externalized `{ref}` assembly is bounded by ONE process-wide
  gate (#39). `MAX_EXTERNALIZED_BYTES` caps a single ref and its assembly peaks
  at ~3× that, so before this the process peak was that product times however
  many independent tool calls happened to be reading — with no number anywhere
  saying so. At most 4 refs are assembled at once now (the official client's
  read-concurrency policy), which makes the worst case `4 × 3 × 32 MiB`; the
  gate is FIFO with a direct slot hand-off, its release is idempotent, and a
  caller waiting for a slot honours the answer's time budget (it leaves the
  queue at its deadline, and a slot that frees after it is re-checked and
  passed on). The limit is an engine option (`contentReadConcurrency`), not a
  config key.
- The terminal/timeout/idle aggregate's mid-window byte stop now carries
  `messagesResumeCursor: "after:<lastReturnedId>"` instead of nothing, from the
  same helper the read face uses.
- A wait ANSWER is now **deadline-bounded** (#21). The aggregate behind
  `cherry_send(wait: true)` / `cherry_wait` receives one absolute deadline — the
  caller's window plus a tail of the same length, floored at 1 s and capped at
  15 s — and every request it issues is clamped to it: the rpc layer shortens
  the per-request timeout, the connection caps the reconnect wait by the
  remaining budget and refuses a replay once it has expired. Before this, each
  of the walk's ~30 requests could absorb another `transportRetryWaitMs` (5 s)
  under a flapping link, so a 1 s window could answer ~150 s late — the shape
  #3 fixed, still present on this path. A spent budget now STOPS the walk and
  returns the content already read with `messagesTruncationReason: "deadline"`
  (a message whose own parts were cut carries `partsTruncated: "deadline"`), and
  a request that hangs is cut at the budget instead of riding the 60 s default.
  The session snapshot each wait answer needs rides the same budget and now
  DEGRADES to the stub receipt (`aggregateError` + `guidance`) instead of
  rejecting the call, so a run's verdict and its identifiers survive a link that
  dies after the run settled.

### Fixed

- `test(connection)`: the two promises a test started and never awaited are now
  settled deterministically and ASSERTED (#43) — the abandoned handshake must
  REJECT, and the never-answered ping is released by `close()` with a classified
  error inside the test instead of waiting out the 60 s client default behind a
  `void ... .catch()`.
- `fix(tools)`: a list page whose `items` is not an array — wrong type, or
  absent — is refused as a protocol violation instead of being read as an empty
  page (#46). On a terminal page (`nextCursor: null`) that used to answer
  `truncated: false` over a hole; mid-walk it skipped a whole page with not even
  the non-record warning (there was no array to count drops against). The
  diagnosis names the SHAPE it got (`missing`, `null`, `string`, …), never the
  payload, and the refusal applies to EVERY page, not only the last one.

## v0.1.4 (2026-10-18)

The 2026-10-18 UltraReview batch: eleven fixes and hardening merged after the
v0.1.3 tag, closing all 37 adjudicated findings of the v0.1.3 review round.

- `fix(connection, rpc)`: a write that fails on a dying socket is classified as transport loss instead of an opaque RPC error; reads replay once, commands never (#37).
- `fix(tools)`: `cherry_read` is bounded by an output budget (`AGGREGATE_BYTES`, 256 KiB) at message boundaries, with `truncationReason: "aggregate-bytes"` — raising `limit` no longer buys round trips that end at the same ceiling (#38).
- `fix(connection)`: `agent.content.read` is paced on its own 256/s tier, so a multi-slice walk no longer queues behind unrelated RPCs on the shared 32/s tier (#40).
- `fix(tools)`: externalized content requires the ref and slice digests to AGREE and decodes as fatal UTF-8 — a mismatched or undecodable part becomes `unavailable` instead of silently wrong text (#36).
- `fix(tools)`: `messagesResumeCursor` / `partsResumeCursor` are documented and tested as STOP POINTS, not inputs; no tool accepts a history-walk cursor (#35).
- `fix(tools)`: device-selector documentation matches prefix resolution; recovery semantics for lost subscriptions are spelled out in the tool schemas (#33).
- `fix(deps)`: the lockfile's version fields agree with their resolved tarballs, enforced by a contract assertion so a mirrored lock cannot slip through (#41).
- `fix(connection, tools, deviceStore)`: the v0.1.3 review's P3 tail (group B) — empty-selector resolution, a dead replay-epoch check, deterministic reconnect backoff, `DEFAULT_TIMEOUT_MS` raised 30 s → 60 s to align with the protocol's `remoteLimits.idleMs`, and a malformed list page that no longer answers as if it were complete (#45).
- `test(loopback)`: the fake peer's lifecycle seams are hardened and residual sleeps removed (#44).
- `docs`: the engineering ledger moved to `AGENTS.md`; the READMEs are slimmed to the user-facing surface (#42).
- `fix(tools)`: the engine's three session caches are bounded at 256 entries per device each, evicting the oldest on insert, and a device's caches are now invalidated when its pairing stops being good — a refused `authenticate` (`GRANT_REVOKED` / `UNAUTHENTICATED` → `offline`) or an `identity-mismatch` — instead of only on `cherry_unpair`.
- `fix(tools)`: a refused `agent.subscriptions.ack` in `cherry_events` re-ensures that session in the background; the delivered events are still returned, and the log line is no longer the only outcome.
- `chore(release)`: `CHANGELOG.md` added (this file), and `prepublishOnly` now ends with `npm pack --dry-run` so the publish path always prints the file list it is about to ship.

## v0.1.3

Resilience against field-reported failures. Five fixes on top of v0.1.2, all
from the 2026-10-17/18 field run.

- List walks accept the desktop's legal empty pin→entity transition page: a page with zero items and an advancing cursor is progress, not a peer fault. The no-progress guards (stuck cursor, empty-page run) are kept and pinned on both list faces.
- Device selectors resolve `deviceId` prefixes, and a miss answers `not-found` with the known ids instead of an ambiguity with no candidates. Read ordering documented with it: newest-first, `limit` drops the oldest.
- A link lost under an in-flight request is a classified, retryable `TransportLostError`, with ONE paced replay for reads. Cursor cycles are refused early, and one `{ref}`'s externalized content is capped at 32 MiB.
- Messages carry `incomplete`/`unavailableParts` when their own content could not be fully read, and every truncation verdict names which END it drops — the field misdiagnosis ("the run was interrupted") is no longer a plausible reading of a result.
- Test reliability: the in-loopback sleep(20) gate was replaced by an accepted-socket gate after it failed deterministically on a warm process.

Known limits: `truncationReason: "aggregate-bytes"` did not exist yet, so an
oversized `cherry_read` could still reach the MCP output boundary; the
history-walk stop-point cursors are documented but not yet accepted as inputs.

## v0.1.2

DSH 0.2.1 compatibility.

- The HTTP API face (and the settings page's backend) mounts again under DSH 0.2.1: `webServer`-only injection, with trusted hosts resolved through `ctx.get` (`webRuntime` → `webStartup`, listener bind folded in as a bare hostname).
- `engines.dsh` declares `>=0.2.0-rc.2 <0.3.0-0`, so the compatibility gate has something to enforce — the 0.3.0 prerelease family is refused until re-evaluated.
- README install pins follow the tag.

Known limits: the pacing tiers still share one budget, and an oversized list
record can still kill a session (byte-safe page clamps landed later).

## v0.1.1

Bridge fixes for the first field report (issues #1–#3).

- Send admission self-heals a stale `expectedIdleRevision`: one re-baseline through `agent.sessions.get`, then exactly one retry, so a permanently-blind event buffer can no longer cause a permanent CONFLICT.
- The events baseline cursor is servable until events are actually dropped; a cursor at an advanced boundary is still refused, with the boundary reported for the rebuild.
- Run-scoped terminal aggregates are bounded (`TERMINAL_AGGREGATE_MESSAGES`, 20) and deadlines are monotonic, so a clock step can neither extend nor cut a wait; a timeout answers with partial content and a heartbeat taken from the event buffer (zero round trips).
- README install pins follow the tag.

## v0.1.0

First public release.

- Pairing from an invitation payload, with the six-digit verification code surfaced before the terminal state.
- The fourteen `cherry_*` tools over the Cherry Studio remote transport: devices, agents, workspaces, sessions, read, events, create, send, wait, interactions, respond, cancel, pair, unpair.
- A settings page (React/Vite bundle in `lib/`) for device maintenance, pairing and scope, plus the `/cherry-remote/api` HTTP face.
- Per-workspace tool scope with a fail-closed default — nobody gets the tools until a workspace is ticked — and tool-only gating, so the settings page can always be used to rescue an excluded workspace.
- Byte-safe page clamps derived from the protocol's 64 KiB record budget, a 10,000-page backstop on every aggregate walk, and pacing at half the desktop's own rate allowances.
- Bilingual READMEs, MIT licence, and GitHub as the canonical home.

Known limits: no replay of a read whose link dies mid-flight; a stale
`expectedIdleRevision` could cause a permanent CONFLICT (fixed in v0.1.1); a
large `cherry_read` could return an unbounded aggregate; no changelog existed
before this file.
