# ADR-0001: An optional capability is decided once, recorded, and reported as its own verdict

- **Status:** accepted
- **Date:** 2026-11-13
- **Issues:** #365 (the code this records), #363 (the upstream survey that prompted it)

## Context

A desktop, or the host this plugin runs in, may or may not offer a given
capability. Three of ours are already like this — uploads (`agentUploadsVersion`
in `hello`), paged message summaries (`agentMessageSummariesVersion`),
advertised endpoints (`connectionEndpointsVersion`) — and every one of them is
negotiated by a **hello bit**: absent means unsupported, decided once per
connection, no probe.

That works while the desktop advertises the bit. The Cherry Studio app's
`v0.5.5` added a face that does **not**: `agent.tasks.*` (protocol 0.8.0) ships
with no capability bit at all, so a client can only learn support by calling and
reading the refusal. Its handling of that is the pattern worth copying, and it
is visible in two places:

- `RemoteAgentScope.ts:530` — `if (error.reason === 'UPGRADE_REQUIRED' && method !== 'agent.tasks.list')`.
  The task probe is deliberately EXEMPT from the state transition that a
  `UPGRADE_REQUIRED` on any other method causes. Without that clause one
  optional method the user does not have would mark the whole connection
  `upgrade-required` and take every other face down with it.
- `RemoteTaskCatalog.ts:120` — `if (generation === this.generation) this.isUnsupported = true`,
  with `reset()` (`:30-31`) clearing the flag and bumping the generation when the
  connection becomes ready. The verdict is latched — the probe is not repeated
  on every call — but a RECONNECT gets a fresh chance, because the desktop may
  have been upgraded in between.

The app is not a spec, and this ADR is not a plan to add `agent.tasks.*`: no
released desktop serves it (v2.1.10, v2.2.0 and v2.2.1 all pin protocol 0.7.0),
so a `cherry_tasks` today would be a tool that can only ever answer
`unsupported`. What it records is the policy any FUTURE optional capability
follows, so the first one does not have to rediscover it.

## Decision

**1. Prefer a hello bit.** If the desktop advertises the capability at handshake,
read it there and store it with the connection, beside `limits`. An absent bit is
`unsupported`, decided once — never "try it and see".

**2. With no bit, probe on demand and LATCH the verdict per connection
generation.** A probe's failure is a verdict about **that call**. It must not:

- change the device's state (`upgrade-required`, `offline`, …);
- add an entry to the `degraded` set;
- unregister, hide or refuse any other tool.

The latch is dropped when the connection becomes ready again, not on a timer and
not per call.

**3. Never widen the closed `degraded` set for an optional capability.**
`degraded` names the three conditions that make the SCOPE decision less
trustworthy — `workspace-list`, `scope-version`, `path-normalization`. A
capability the user may simply not have is not a degradation of that decision;
it is an answer to a different question.

The rule is about the PEER. The host has the same shape one level up: a
deployment without an attachments service answers
`cherry_read(includeImages: true)` with `{error: 'unsupported'}` and leaves the
fourteen tools registered and working. Same principle — a missing capability is
reported about itself.

## Consequences

- A tool built on an optional method answers `unsupported` (or a structured
  `{problem}` on the HTTP face) and the rest of the family keeps working. The
  test that proves it must assert BOTH halves: the verdict, and that the
  siblings are untouched.
- A latched `unsupported` costs one refused call per connection, not one per
  tool call.
- The probe must be reachable in tests without a real peer that lacks the
  capability — the loopback fake gains the knob, the same way every other
  absence is driven.
- Adding a `degraded` source is a scope decision, not a convenience: it needs
  its own ADR, because the settings page and `/scope` both surface the set.

## What this does not decide

- Which capability to add next, or whether `agent.tasks.*` is worth having. The
  answer today is no, for the reason above; that is a product call, and it
  changes the day a desktop ships the methods.
- Whether a probe may be COALESCED across concurrent callers. That is a
  per-capability implementation detail; the pattern it would follow is the
  in-flight de-duplication in `CherryToolEngine.#readRefBytes` (#365).

## References

- `src/AGENTS.md` — "Scope: hiding, not refusing" (the closed `degraded` set)
  and the hello capability bits in "Protocol basis".
- Cherry Studio app `v0.5.5`, `src/backend/services/remoteAgent/RemoteAgentScope.ts:530`
  and `RemoteTaskCatalog.ts:30-31,120` (gitignored clone; the survey note is
  `_research/notes/2026-11-13-cherry-app-0.5.5.md`).
- `@cherrystudio/remote-protocol` 0.8.0 `dist/agent.d.ts` — the five additive
  `agent.tasks.*` methods, and the unchanged `agent*Version` set.
