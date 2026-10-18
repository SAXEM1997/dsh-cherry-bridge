# Changelog

All notable changes to `dsh-cherry-bridge`. This project adheres to
[Semantic Versioning](https://semver.org/): the minor digit carries new
capability, the patch digit carries fixes and hardening with no protocol
surface change.

## Unreleased

Batches merged after the v0.1.3 tag. They are not part of any published
version yet; the install pins in both READMEs still name v0.1.3.

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
