# AGENTS.md — `tests/`

Unit, integration and contract suites, plus `tests/loopback/fakeCherry.ts` — the
in-test fake desktop every integration file drives over a real loopback Noise
connection. Loaded automatically when a file tool touches `tests/**`.

Flow, mutation discipline and the once-per-merge full-suite rule are in the root
[`AGENTS.md`](../AGENTS.md); this file is the suites' own shape.

- **Three shapes, one rule each.** `tests/unit/` is pure (no sockets, no clock);
  `tests/integration/` drives the real code against `FakeCherry` on loopback;
  `tests/contract/` asserts the PINNED protocol package, the lockfile and the
  packaging surface. A behaviour that needs a socket belongs in integration; a
  parse or a judgement that needs none belongs in unit.
- **The fake is the peer, and it is the only one.** It models the real desktop,
  read from `_research/cherry-studio` (never from our own code). Extend it with
  an OPTIONAL, additive, documented knob (`authenticateFailure`, `helloFailure`,
  `pairingClaimFailure`, …) rather than forking a second fake; an unset knob
  must leave every existing path byte-identical.
- **Never sleep.** Wait on a predicate — `vi.waitFor`, `fake.helloCount`, a
  state transition, a subscribe ledger — so a slow machine lengthens the wait
  instead of turning it red. A short sleep is a flake with a countdown, and the
  reverse (a fixed budget for an unbounded wait) is a red test on a loaded CI.
- **Pin the WORK when the log is the visible face.** A log line can name a
  session the code never re-subscribed (issue #155's review caught exactly that
  assertion), so assert on the peer's own ledger, not on the message.
- **Console spies per file.** `vi.spyOn(console, …)` in `beforeEach`,
  `vi.restoreAllMocks()` in `afterEach`; assert a line's CONTENT, and never let
  a captured line be the only evidence of work that did or did not happen.
- **Cases are numbered** (①a, ③u, ⑯b, `#155a`) so a review can name one. A new
  case takes the next FREE slot in its file — a duplicate number was a real
  review finding (#155's ③p).
- **`tests/integration/toolsManage.test.ts` imports `src/index.ts`**, whose
  assembly state is module-level: a new case there runs after the file's earlier
  applies. Do not assume a fresh module; reset through the file's helpers, and
  leave it last if it cannot be reset.
- **Timers are not verdicts.** A suite-green single file can still fail under a
  full run's worker contention (issue #21: a 1 ms timer fired early and the
  attribution flipped), so anything touching timeouts or reconnects is settled
  by the full suite before merge.

