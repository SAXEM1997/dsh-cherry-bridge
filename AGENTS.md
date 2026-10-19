# AGENTS.md — working on dsh-cherry-bridge

Engineering notes for AI agents and contributors. **`README.md` / `README.en.md`
are for users**: what the plugin is, how to install and use it, the config table
and a one-line-per-tool overview. Everything that explains *why* something is
built the way it is — contracts, invariants, provenance — lives here. Review
verdicts, fix histories and issue numbers are **not** migration targets: they
are process records, and they stay in `docs/superpowers/**` (not published).

## Contents

1. [Development conventions](#development-conventions)
2. [Build facts](#build-facts)
3. [Protocol basis](#protocol-basis)
4. [Design decisions and invariants](#design-decisions-and-invariants)
5. [Upstream references](#upstream-references)
6. [Release](#release)

---

## Development conventions

**Flow — GitHub Flow, one issue per branch.**

    issue → branch (off main) → TDD → PR → independent review → squash merge

- **Test first.** Write the failing test, watch it fail for the intended
  reason, then implement. Every new or changed test must be **mutation-verified**:
  break the implementation deliberately (invert the branch, delete the guard,
  return the old value) and confirm the test turns red. A test that passes
  against both the old and new code is not a test.
- **Sub-task test strategy.** While working, run only the fast, relevant
  subset — `npx vitest run tests/<area>/<file>.test.ts` plus `npm run
  typecheck` when types moved. The **full** suite (`npm test`, including
  `tests/contract/`, which takes minutes and drives a real loopback fake peer)
  is run **once by the integrator before merge**, not on every iteration.
  `tests/unit/artifactFreshness.test.ts` is the exception to "skip the slow
  stuff": it only matters when source comments or build config changed, and it
  is cheap enough to run then (see below).
- **No source change without its artifact.** `src/`/`ui/` edits and their
  rebuilt `dist/`/`lib/` go in the **same commit** (see [Build facts](#build-facts)).
- **Scope discipline.** Change what the issue names. Adjacent discoveries go
  into a new issue, not into the diff. A doc-only change touches only docs.
- **The READMEs are a pair.** `README.md` (简体中文) and `README.en.md` (English)
  are expected to say the same thing; an edit to one is an edit to both.
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

- **tsdown preserves JSDoc into `dist/index.mjs`.** Therefore a change that
  only touches `src/**` **comments** still changes the artifact bytes. If you
  edit an exported declaration's doc comment, rebuild `dist` in the same commit
  — `tests/unit/artifactFreshness.test.ts` rebuilds from source into a temp dir
  and compares **byte for byte** against the committed files. A missing rebuild
  is a red test, not a style nit.
- **`prepublishOnly` vs `artifactFreshness` — two different gates.**
  - `prepublishOnly` = `typecheck && test && build && build:client`: runs the
    whole chain (both type projects, the full suite, both builds) on the
    publish path. It proves the tree *is* buildable.
  - `artifactFreshness` = rebuild from current source and byte-compare against
    **what is committed**. It proves the committed artifacts were built from
    this exact source — the gate that catches "changed source, forgot to
    rebuild", including comment-only drift. It runs in the fast suite.
  - The contract suite's "clean clone → pack" case is a third, coarser arm: it
    clones without `node_modules` and asserts the three artifacts are already
    present in the clone and inside the `npm pack --ignore-scripts` tarball.
    It only sees *existence*, never bytes.
- **There is deliberately no `prepare` hook.** `prepare` also runs on
  `npm install`, where `--omit=dev` prunes devDependencies first — the hook then
  dies (exit 127) looking for `tsdown`/`vite` and takes the whole install down.
  Committing the artifacts is what makes git installs, `--omit=dev` and packing
  a bare clone work with zero build steps.
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
  dependency (the protocol package `import`s it everywhere in its own runtime
  output; peer `^4.3.4`, pinned at `4.3.4`). `@cherrystudio/remote-protocol`
  is external in `dist`, so zod is not bundled away.
- **TypeScript is pinned `~7.0.2`** (patch digit only). Accepted risk:
  tsdown's dts output rides TS 7's experimental declaration API, which may move
  across minors. The patch-only range means it cannot move silently; an upgrade
  is an explicit `package.json` edit plus `npm run build` plus the full suite —
  a bad upgrade shows up in the byte gate immediately, not downstream.

## Protocol basis

Pinned at **exact versions**, no `^`, with contract assertions on the pins:

| Package | Version |
| --- | --- |
| `@cherrystudio/remote-protocol` | `0.5.0` |
| `@cherrystudio/remote-transport` | `0.2.1` |
| `ws` | `8.22.0` |
| `zod` | `4.3.4` |

These are the same versions the official Cherry Studio app uses. Upgrading
either protocol package means re-running `tests/contract/contract.test.ts`
against schema drift — the suite models the **six behavioral differences**
between our loopback fake peer and a real desktop, each mapped to a manual step
in [`docs/e2e-checklist.md`](docs/e2e-checklist.md).

**Wire budget (from `remoteLimits` in the protocol package):**

| Limit | Value | Consequence in this plugin |
| --- | --- | --- |
| `recordBytes` | 65,536 (64 KiB) | one JSON-RPC record above it **aborts the connection** — the transport answers by killing it, so every in-flight request fails |
| `contentBytes` | 24,576 (24 KiB) | the slice size for one `agent.content.read` |
| `pageItems` | 100 | the protocol's single-page hard cap; `hello` may negotiate smaller |

The desktop's `pageOf` pages by **count alone**, so asking for `pageItems: 100`
fat parts produced a record the transport had to kill — reading a complex
session reset the connection deterministically. Our byte-safe per-page clamps
(`defaults.ts`, derived from a strict 4-bytes-per-character UTF-8 worst case and
the peer's `INLINE_TEXT_LIMIT` of 4,096 characters, with a 2 KiB margin) are the
fix, and the effective page size is `min(negotiated pageItems, clamp)`.

**Upstream context (#21854, merged but unreleased).** Upstream added a
`PAGE_ITEM_BYTES`-style byte budget (62,279 bytes) to every paged `agent.*.list`
face (`pageOf` truncates, `queryPage` re-queries a keyset page at a halved
limit); an item that cannot fit raises `RESOURCE_EXHAUSTED`. It is **not in any
release** as of the verified range, so deployed peers (2.1.6 and earlier) still
page by count alone and the clamps stay. Byte-safe pages must not be removed
because of that upstream commit.

Reviewed against the merged code (`7218842`) and followed up as
[`#21951`](https://github.com/CherryHQ/cherry-studio/issues/21951): an item above
the budget **dead-ends the cursor**, so it and everything behind it become
unreachable (reachable through a schema-valid record — `partIds` has no bound),
`RESOURCE_EXHAUSTED` presents that permanent condition as retryable, and
`queryPage`'s halving leaves up to half the budget unused. A peer may therefore
come back with a page **shorter** than requested while still promising more,
which our walk already follows (`tests/integration/toolsListWalkCompat.test.ts`
T2); it must never come back **longer**, and `CherryPage.pageOverflow` is what
happens if it does.

**Pacing: two tiers against the desktop's kill lines.**

| Tier | Methods | Desktop allowance | Our default |
| --- | --- | --- | --- |
| `shared` | every business RPC except content reads | 64 req/s | `rateBudgetPerSecond` = **32** |
| `content` | `agent.content.read` alone | 512 req/s | `DEFAULT_CONTENT_READ_BUDGET_PER_SECOND` = **256** |

- The desktop has **no negotiation channel**; exceeding its limit terminates the
  whole session with close `1011`. Both of our tiers sit at half the desktop
  line, the same 2× margin.
- The tier is chosen by `classifyRateTier`, which is an **exact match**, not a
  prefix: widening it to another method would silently give a 64/s method the
  256/s tier.
- The content tier is **not a config key** — it derives from the one injected
  shared budget at the 8:1 ratio, so lowering `rateBudgetPerSecond` lowers both.
  A second key is deferred until a field report needs one.
- The 2× margins are a *default-injection* claim: at an injected 64/s the
  shared tier sits on the desktop's line and the content tier derives to 512/s
  (nominal saturation; the limiter's per-second gap keeps the achieved rate
  lower — margin by accident, not by design).
- Since 2.1.6 the desktop externalizes every part over **4,096 characters**,
  which makes multi-slice content walks the common case — the reason the
  content tier exists at all (a single 32/s tier bound such a walk to ~670 KiB/s
  and queued it behind unrelated RPCs).

## Design decisions and invariants

These are load-bearing; the code comments are the long version.

### Transport loss: reads replay once, commands never

- A **read** method that loses its link mid-flight is replayed **once**, after a
  reconnect and through a **fresh** rate-limit admission (no replay storm). A
  second loss, or a torn-down connection lifecycle, yields a structured lost
  error (`TransportLostError`, retryable) instead of an endless retry. The
  replay waits at most `transportRetryWaitMs` (default 5 s).
- A **command** (`cherry_send` / `cherry_create` / `cherry_respond` /
  `cherry_cancel`) is **never replayed**. A lost reply is not a verdict — the
  command stays uncertain and is recovered by **receipt**: the caller retries
  with the **original `commandId`**, and the desktop's command ledger replays
  the original receipt. Only the same id with a *different* body is an
  idempotency conflict.

### Memory: 32 MiB per ref, ~3× assembly, 4 refs at once

- `MAX_EXTERNALIZED_BYTES` = 32 MiB caps **one `{ref}`**, the same ceiling the
  official client applies. It is a refusal to start a walk that could never
  finish (a peer declaring 4 GiB would mean ~170,000 slices), not a proof about
  the content. A part above it is `unavailable`.
- Assembling one ref's content holds roughly **3× its size** at peak: the
  decoded slices, the single concatenation the digest and decoder need, and
  the decoded string. That is the price of never hashing or decoding a buffer a
  caller could mutate.
- An aggregate reads refs **sequentially**, so its own peak is one ref's 3×.
  Across calls, ONE process-wide gate (`ContentReadGate`, issue #39) bounds how
  many refs are being assembled at once: `DEFAULT_CONTENT_READ_CONCURRENCY` = 4,
  the official client's read-concurrency policy. The whole engine — every tool
  call, every device — shares it, so the process peak is
  **4 × 3 × 32 MiB = 384 MiB worst case**, and in ordinary traffic
  `4 × 3 × (the declared size)`. It bounds the COUNT, not the bytes: a byte
  budget would have to reserve each ref's declared size (optimistic — a peer may
  serve more) or its cap when the size is unusable (serializing everything
  behind one slot), so it is deliberately not what landed.
- **The gate's boundary with the deadline (issue #21).** While a caller is
  QUEUED it honours its budget: at the deadline it leaves the queue and fails
  (`ContentGateTimeoutError`, which the projection degrades to one part's
  `unavailable`). A slot that frees after the deadline but before that timer
  runs is RE-CHECKED and passed on, never spent. Once a walk is RUNNING the gate
  does not interrupt it — its per-slice requests carry the deadline to the
  transport, which is where the I/O stops. Interrupting in both places would
  make "cancelled but still reading" an unexplainable state.

### Read cache: the parts-list RESULT, fenced by the peer's own revision

`cherry_read` and the terminal/timeout/idle aggregates share ONE projection
(`#projectMessage`), and that method runs in two steps: obtain the message's
parts RECORDS (one `agent.parts.list` walk), then project them (one
`agent.content.read` walk per externalized `{ref}`, digest-verified). The cache
sits BETWEEN the steps — lookup before the list, store after it — and holds the
LIST, not the projection. An agent doing send → wait → read therefore stops
paying for the same unchanged part list on every round, while every read still
verifies every byte it hands back.

- **What an entry holds**: the `agent.parts.list` result —
  `{revision, page: CherryPage<Record<string, unknown>>}` — i.e. the raw part
  records plus the walk's own verdict. On a hit the RPC is skipped and the
  ordinary projection loop runs again over those records, re-resolving and
  re-verifying every `{ref}`.
- **Key**: `<deviceId>\0<messageId>`. Device-scoped for the same reason every
  engine cache is: a message id is the peer's, and two desktops can issue the
  same one. The revision is the FENCE, not part of the key.
- **The fence covers parts RECORDS.** A message revision describes the parts a
  `messageRevision`-fenced `agent.parts.list` returns; the peer itself raises
  `REVISION_EXPIRED` for a stale one. So the cache inherits **that** staleness
  class and adds none of its own. It is not *stronger* than the peer's rule: the
  revision is `String(Date.parse(updatedAt))`, a millisecond wall clock, so two
  writes to one message inside the same millisecond keep the revision equal
  while its parts differ — a hit would then serve the older list for that
  revision's lifetime. The protocol's own revision-fenced operations make the
  same assumption (this is a shared property of the scheme, not something the
  cache invented), and it needs a read between two same-millisecond writes.
- **The fence never had to cover a `{ref}`'s content store**, because the cache
  does not hold the content: a `{ref}` is re-fetched through
  `agent.content.read` and its sha256 re-verified on EVERY read, hit or miss.
  Bytes corrupted behind an unchanged revision still fail the read with
  `ContentIntegrityError` — the four integrity tests (`toolsRead.test.ts`
  ④b/④j, `toolsAggregateBudget.test.ts` T3/T3b) pass unmodified against this
  design, and `toolsReadCache.test.ts` T1b pins it next to the cache. The
  earlier attempt cached the PROJECTION and had to refuse every ref-bearing
  message to keep that promise; that refusal (and the `CherryReadPart.fromRef`
  marker and `#publicMessage` that existed only to support it) is gone.
- **Never cached**: a row whose revision is EMPTY (no fence to trust —
  defensive only: the protocol's `messageRevision` is a strict decimal, so no
  test can drive it), a TRUNCATED parts page (the walk stopped early — the
  circuit breaker, or a wait answer's deadline — so the list is short; a
  transient fault must be retried, never remembered; the refusal is
  reason-blind so a future reason cannot reintroduce the bug), and a page above
  `MESSAGE_CACHE_ENTRY_BYTES` (1 MiB; walked fresh every time rather than
  allowed to crowd out every other message).
- **A failed part is NOT a reason to forget the list.** Degradation happens in
  the projection step; the held records are still the peer's complete answer and
  the next read re-attempts every part. (The projection-cached design had to
  refuse an `incomplete` message, because there the projection WAS the entry
  and a degraded one would have stayed degraded for the life of the revision.)
- **What it costs**: an unchanged message's part LIST costs no
  `agent.parts.list` RPC; its externalized content is STILL fetched and verified
  on every read. That is the honest claim — the cache is not a zero-RPC hit
  for the 2.1.6 common case (every part above 4,096 characters is a `{ref}`).
- **Memory holds the part RECORDS, not the resolved content.** An entry is sized
  with `JSON.stringify(page.items).length` (the same wire-cost proxy
  `AGGREGATE_BYTES` uses). What that excludes is the `{ref}` TEXT, which is the
  multi-megabyte half; what it INCLUDES is inline part text, up to the peer's
  4,096-character `INLINE_TEXT_LIMIT` per part — so "descriptors" understates
  the inline case, and a message with a few hundred fat inline parts can reach
  `MESSAGE_CACHE_ENTRY_BYTES` (1 MiB). That is an argument, not a measurement:
  the bound is set so one entry cannot evict the device's working set, and real
  traffic is expected to stay far below it.
  `MESSAGE_CACHE_BYTES_PER_DEVICE` = 32 MiB — deliberately far more headroom
  than that bound needs.
- **Two bounds, both per device, and they judge independently.** An entry is
  refused when it exceeds `MESSAGE_CACHE_ENTRY_BYTES` **or** when it exceeds the
  device budget — an entry bigger than the device can never fit, whatever the
  entry cap says, so allowing it would evict the whole device and then store the
  entry anyway.
- **Eviction is FIFO**, oldest insertion first — `Map` order IS the policy, the
  same deliberate choice `#remember` documents for the session caches. A
  **refresh keeps the key's insertion position** (it is a rewrite, not a use), so
  the order is insert-order and not write-order; a `delete`-then-`set` refresh
  would silently turn the policy into LRU. Room is made BEFORE a write for the
  **growth** the write needs (`bytes - previous`, zero when it shrinks), so a
  device never passes its budget on EITHER path — a refresh that grew the entry
  is the path that is easy to miss, and getting it wrong is what let an edited
  message's larger list through the budget untouched.
  `#dropCachedMessage` is the ONE delete path, so the per-device byte total
  cannot drift from the map, and the eviction loop skips the key being written
  (replacing it IS this call — self-evicting it would move it to the back and
  break insert-order). Eviction warns once per insert that dropped anything:
  device and count only, never a message id.
- **A hit hands the PAGE out BY REFERENCE**, which is safe because it is a list
  of records: the projection loop only reads it and builds new part objects
  from it. A future reader that mutates a cached page must copy first.
- **Invalidation** rides the existing seam: `#forgetDevice` drops the device's
  entries with its three session caches, and `#watchConnection` already routes
  `offline` / `identity-mismatch` there. Note what that seam covers: an ordinary
  link loss also publishes `offline`, so a reconnect drops the cache too — one
  re-walk per session, the documented cost of the seam.

### Walks: what is tolerated, what is refused

- **Empty pages.** The desktop's pinned-list walk legally answers
  `{items: [], nextCursor: 'entity:'}` once per walk (the pin→entity section
  transition). Tolerance is **2 consecutive** advancing empty pages; the **3rd**
  refuses. Any non-empty page resets the count.
- **Cursors.** A cursor that does not advance is refused, and so is a cursor
  that **loops back** to one already served (a `seen` set per walk) — never spun
  on. `MAX_AGGREGATE_PAGES` (10,000) is the backstop for every other
  non-terminating shape.
- **Ordering of guards.** The stuck-cursor check runs **before** the empty-page
  tolerance: tolerating empty pages must not blunt the no-progress guard.
- A truncated walk is **always surfaced** (a `truncationReason` plus a
  stop-point token), never a silent short result. Hitting a safety bound fails
  or reports; it never returns a partial as if it were complete.
- **An overshooting page is absorbed, not refused.** `limit` is a MAXIMUM on a
  list method, so a page carrying more items than were asked for is a peer fault
  — but nothing is lost yet, and throwing would make the list unreadable (the
  worse failure). The walk takes what its ceiling allows, stops with the
  caller's own attribution, and **re-uses the position it SENT** for that page:
  the page's own `nextCursor` sits past items the walk never collected, so a
  resume from it would skip them, and a terminal overshooting page would
  otherwise be reported complete while dropping its tail. `CherryPage.pageOverflow`
  records the case and `messageResumeToken` then prefers the exact `after:`
  anchor.
- A **resume** (an `after:` anchor scan) obeys every guard above unchanged —
  including the stuck-cursor and cycle checks, which are pinned during a scan by
  their own tests. Its two failures are its own: an anchor that is not on any
  page up to the peer's last one, and a scan longer than
  `MAX_ANCHOR_SCAN_PAGES`. Both throw. A scan asks for a **full page**
  regardless of the caller's `limit`: its items are discarded either way, and
  paging at `limit: 1` would spend the page budget on a history a full page
  reaches in dozens.

### Wait answers: one absolute deadline

The aggregate behind `cherry_send(wait: true)` / `cherry_wait` (the terminal,
timeout and idle faces) runs AFTER — or at the end of — the caller's wait
window, so the window cannot bound it. It used to have no time bound at all:
since #12 a read whose link dies waits up to `transportRetryWaitMs` (5 s) for a
reconnect before replaying, so under a flapping link each of the walk's ~30
requests could absorb that wait — a 1 s window answering ~150 s later, the shape
#3 fixed with a message ceiling and a byte budget (issue #21).

- **One instant, derived once.** `AssemblyDeadline` = `startedAt + window +
  clamp(window, WAIT_ANSWER_TAIL_FLOOR_MS, WAIT_ANSWER_TAIL_MS)` — one more
  window, floored at 1 s (the tool's window has a 1 ms minimum, and a 1 ms
  budget would return the stub receipt for a reply one round trip away) and
  capped at 15 s (the largest single item in the walk is one 32 MiB `{ref}` at
  ~1,365 sequential slices, single-digit seconds on a LAN; the rest of the walk
  is bounded to 20 messages). It is built on `performance.now()`, the same
  monotonic clock as the waiter's own deadline.
- **Every wait is charged to it, where the wait happens.** The rpc layer clamps
  a request's own timeout to `min(timeoutMs, remaining)` (so a budget farther
  away never lengthens one, and one stuck request cannot eat a whole answer);
  the connection refuses a request — and a replay — once it has expired
  (`RpcDeadlineExceededError`), caps the reconnect wait by the remaining budget,
  and judges the PACING ADMISSION before taking it (a spent budget buys no
  slot) as well as after (taking one can consume the last of the budget). The
  walk re-judges the deadline BEFORE every request so a spent budget never
  spends an admission and a round trip, and between messages so one message's
  parts walk cannot start with no time left. One bound is left over: a request
  ALREADY queued for its pacing slot is released by the limiter, so it can be
  refused up to one `#minGapMs` late (36 ms shared, 5 ms content). Refusing it
  earlier needs deadline-aware pacing — a separate piece of work.
- **A spent budget is a STOP, not a failure.** The message walk and the parts
  walk stop where they are and report `'deadline'` — the third
  `truncationReason`, beside `'limit'` and `'aggregate-bytes'` — and the content
  already read is returned (spec §3.6: a timeout answer exists to hand back
  partial content). A message whose own parts were cut carries
  `partsTruncated: 'deadline'` + `incomplete`. A CONTENT slice has no verdict of
  its own to report: it is one part inside a message, so the part is marked
  `unavailable` (the degradable class — the bytes could not be verified) and the
  message's ordinary projection flags it `incomplete`. **Only** the two
  time-exhaustion classes are converted: a peer refusal, an offline device or an
  integrity failure after the deadline still surfaces as itself, because
  reporting it as `'deadline'` would send the caller looking at their own clock.
- **`clampedByDeadline` is a flag, not a clock test.** A timer may fire a
  millisecond early, so "has the deadline passed by the time I handle the
  rejection" is a race; `RequestTimeoutError` records whether its timeout was
  DERIVED from the deadline, which is a fact about how the error was produced.
  A plain client timeout (the 60 s default) is not the budget and is not
  converted.
- **The snapshot is inside the budget and inside the degrade arm — on the
  terminal and timeout faces.** Both start with `agent.sessions.get` (it carries
  `historyRevision`); it rides the same deadline, and its failure degrades to
  the stub receipt (`aggregateError` + `guidance`) exactly like a failed walk —
  the #3 invariant: a run's verdict and its identifiers survive a content
  failure. Before #21 a dead link there made `cherry_send` reject.
  The IDLE face is the exception, and it is a known gap (issue #51): its
  `agent.sessions.get` is the §6 PRECONDITION that decides whether the session
  is idle at all, taken before any answer exists — so there is nothing to
  degrade to, and a budget that cut it would turn "is anything running?" into a
  timeout error. That request keeps the transport's ordinary bounds (one
  reconnect wait + one replay) and no deadline; the answer's own budget starts
  after it.

What this is NOT: a global time budget for `cherry_read` or the list tools. They
have no deadline argument, so nothing above applies to them — their bounds are
`limit`, the safety breaker and the byte budgets.

### Stop-point cursors (the teaching case)

`messagesResumeCursor` is a stop point **and** an input: `cherry_read` takes it
back as its own `messagesResumeCursor` argument (#26). The marker a walk emits
is the token a walk accepts — **round-trip symmetry** is the invariant, and both
message-walk faces (the read face and the terminal/timeout/idle aggregate)
derive it from the SAME helper, `messageResumeToken`, so they cannot drift into
two dialects.

Three `truncationReason` values mean different things:

- **`limit`** — the caller's own ceiling was reached with more available. Fix:
  raise `limit`, or resume with the token and keep walking in another answer.
- **`aggregate-bytes`** — the answer reached its **output budget** with the walk
  still having messages. This is **independent of `limit`**: raising `limit` only
  costs more round trips and stops at the same budget. The **resume token** is
  how the older messages are reached; from a resume point `limit` bounds how
  many messages one answer carries, so a long history is walked in successive
  answers, each carrying the next stop point.
- **`deadline`** — the WAIT ANSWER's own assembly budget ran out (see
  [Wait answers](#wait-answers-one-absolute-deadline)). Neither the caller nor
  the peer did anything wrong, so neither raising `limit` nor resuming helps by
  itself: the content that was read is returned (with the token when one can be
  named), and the rest is reached with `cherry_read`, which has no deadline.

Keep this distinction in the README. Collapsing `aggregate-bytes` into "raise
`limit`" was a field defect: a caller raised `limit` repeatedly, paid for every
round trip, and still never saw the cut-off history. Leaving the marker with no
consumer at all was the second half of that defect: the loss was stated and
nothing could act on it.

**Two token forms, both prefixed** — the prefix is ours, the rest is opaque:

- `cursor:<peerPosition>` — the walk consumed its whole collected window, so the
  peer's page position is exactly where the unread history begins. The resume
  read sends it as the **first** request's `cursor`.
- `after:<messageId>` — the walk stopped **inside** its collected window (a byte
  stop), so the peer's position sits past messages the walk already collected
  and would skip them. `AgentMessage` carries no `createdAt`, so no peer cursor
  can be synthesised for that boundary either. The anchor is the **last returned
  message**; the resume read starts cursorless, scans from the newest end until
  it has met the anchor (discarding pages whole), and returns what follows it.

**The peer's cursor format is never parsed or validated.** The real desktop's is
an opaque keyset token (`<createdAt-ms>:<messageId>`), the loopback peer's is a
numeric offset, and a future desktop may change it. Every token we emit is
therefore self-describing, and every token we accept must carry one of our two
prefixes; anything else is refused **before any device work**. This is not
pedantry: a malformed cursor handed to the real desktop is **silently swallowed**
(it falls back to the newest page), so a forwarded foreign string would come
back as the newest page presented as "continued history". A refusal that costs
no dial and names both accepted forms is the only honest answer.

**An anchor the walk cannot find is loud.** If the peer's terminal page arrives
with the anchor still unfound, the read throws naming the message id (it is
probably gone: deleted, or the session replaced), rather than returning an empty
page that reads as "no older history" — the opposite of what happened. A scan
past `MAX_ANCHOR_SCAN_PAGES` (500 pages) throws for the same reason: a session
that deep is not one this tool should chase.

**Every existing guard stays in force during a scan** — the stuck-cursor check,
the cursor-cycle `seen` set, the consecutive-empty-page run and
`MAX_AGGREGATE_PAGES`. The empty-page run counts the **raw** page the peer
served, never what the scan kept: a non-empty page nobody wanted is still
progress. The collected-item ceiling counts **returned** items, so a scan's
discarded pages do not spend the caller's `limit`.

### `AGGREGATE_BYTES`: one budget, two faces

`AGGREGATE_BYTES` = 256 KiB bounds a **projected message aggregate** (measured
with `JSON.stringify(...).length` as a cheap approximation of wire cost). Two
faces share it and one vocabulary:

- the terminal/timeout/idle aggregate returned by `cherry_send(wait: true)` /
  `cherry_wait` (with a message ceiling of 20, `TERMINAL_AGGREGATE_MESSAGES` —
  ten runs' worth of slack for reading a run's own messages newest-first), and
- `cherry_read`.

The constraint that failed in the field is the **MCP output boundary**: it does
not care which tool produced an oversized answer ("value is not lossless JSON"
loses the verdict *along with* the content). One budget, one reason word; what
differs between the faces is the **message ceiling**, not the cost of a message.
A second byte value would drift silently.

The budget is checked only **between** messages and the first message is always
taken before any check: the **newest message is always returned whole**, and a
stop only ever drops **older** messages.

### Truncation has two carriers; never conflate them

- **Message-walk truncation** (`truncated` + `truncationReason` +
  `messagesResumeCursor`) drops the **older** messages. It never cuts inside a
  returned message's parts.
- **Parts-walk truncation** (`partsTruncated` + `partsResumeCursor`) drops that
  one message's **later** parts; parts are read oldest-first. The reason is
  `'safety-bound'` for the local circuit breaker at `DEFAULT_PARTS_SAFETY_BOUND`
  = 10,000 (the protocol caps nothing there) and `'deadline'` when a wait
  answer's budget cut the walk (see
  [Wait answers](#wait-answers-one-absolute-deadline)); the parts walk has no
  byte budget of its own.

A returned message missing its own content carries `incomplete: true`, plus
`unavailableParts` when parts were unreadable — a content verdict on the
message, unrelated to either walk. **`unavailableParts` absent ≠ 0**: it is
absent when nothing was counted as unavailable (e.g. a pure parts-walk
circuit-break with no unreadable part).

### `byteLength` tolerance is a deliberate divergence

The official client refuses to read a ref whose `byteLength` is not a safe
integer ≤ 32 MiB (`RESOURCE_UNAVAILABLE`). We are **more tolerant**: a missing or
unusable `byteLength` falls back to a slice bound (`DEFAULT_CONTENT_SLICE_BOUND`
= 4,096 slices), and the **cumulative bytes-read arm** still caps the walk, so a
peer that serves more than it declared is stopped by bytes actually read. This
is intentional, commented, and covered by a test (a peer serving more than it
declared). Do not "align" it to the official behaviour without a reason.

### Integrity: what degrades, what is fatal

Content the peer **would not or could not** serve (a `NOT_FOUND` pin, a
transient RPC failure, a non-advancing cursor) **degrades**: the part is marked
`unavailable` and the rest of the snapshot is still exactly what the peer said.

Anything that certifies **wrong or unverifiable** bytes does not degrade:

- A **digest mismatch** (reassembled bytes ≠ the ref's advertised sha256) raises
  `ContentIntegrityError` and fails the **whole read**. Returning it as a
  partial part would look like a complete snapshot containing content the peer
  never certified — worse than an error, because the caller cannot tell.
- **Two sources, one digest.** The ref's declared sha256 and the slices' own
  sha256 must **agree** when both are present; neither can certify the other. A
  disagreement means no single certified value exists (degradable: the part
  loses its text). Every slice is also compared against the ref as it arrives —
  a final honest digest must not launder earlier dishonest ones.
- Bytes must be reassembled **before** decoding: slicing at 24 KiB splits
  multi-byte characters, and per-slice decoding turns both halves into U+FFFD
  while the byte digest still matches. The walk accumulates `Buffer`s, verifies
  once, then decodes **once**.
- The decode is **fatal UTF-8**: a digest certifies bytes, not their legality.
  Bytes that hash correctly but are not legal UTF-8 mark the part `unavailable`
  rather than handing the model substitution characters as if they were text.
- A walk that never reaches `eof`, or that is stopped by any arm of the 32 MiB
  cap, is a failure — never a "partial" value.

### `cherry_read` facts worth keeping in mind

- Two-level baseline: `agent.sessions.get` for the history revision,
  `agent.messages.list` for messages, and **each message's own revision** for
  its parts.
- Messages are **newest-first**; `limit` drops the **oldest**.
- Attachment parts (`kind: 'file'`, and the pre-2.1.5 `kind: 'data'` shape) are
  reported as `name`/`mediaType`/`byteLength` with an **empty** `content`, and
  no `unavailable` (nothing failed — the bytes were deliberately not fetched).
  The read path is a text channel; bytes never enter it.
- A terminal aggregate that fails to assemble is a **content** problem, not a
  verdict on the run: the run's status still stands, and the guidance points at
  `cherry_read`.

### Device selector

`DeviceStore.resolve` = exact `deviceId` → the **union** of `deviceId` prefixes
and display-name prefixes (one filter, store order, deduplicated by `deviceId`)
→ exactly one hit, `{notFound: true}` (+ `known`), or an ambiguity (+
`candidates`). `cherry_devices` returns either verdict as a structured result;
every other tool **throws** when nothing matches. A quarantined archive
(`archive-quarantined`) outranks all of this. `tests/unit/toolDeviceDocSync.test.ts`
pins the selector clause in every tool schema — 13 tools take a `device`
selector, `cherry_pair` does not.

### Scope: hiding, not refusing

- The 14 tools are decided **per workspace**, and the default is
  `selected` + an empty list — **nobody** has them (fail-closed: a corrupt,
  invalid or unreadable document lands on the stricter side; there is no
  "unreadable → global" escape).
- A save re-installs or releases the restriction layer for **every live agent**
  and takes effect on the **next turn** — no restart, no new session.
- Scope governs **tools only**; the settings page and `/cherry-remote/api` are
  never scope-gated, so an excluded workspace can rescue itself.
- Capability missing is never papered over: `pending` is a neutral wait,
  `unsupported` is a read-only warning with the real cause and save disabled;
  under both the tools stay **unregistered**.
- `visibility-only` degradation means the execution-side backstop (`tools.guard`)
  is gone but `restrict` still removes the tools from the table — a visibility
  guarantee, not an execution boundary. The panel only ever claims "this plugin
  does not shadow them"; upstream `allow`-shaped filtering can still hide them.
- The scope document lives at `<dataDir>/scope.json` (0600, atomic, monotonic
  `revision`), **not** in profile YAML. The one exception: a document that fails
  to parse or has invalid fields is rebuilt on the stricter side with `revision`
  reset to 0, and stays writable. `PUT` is read-modify-write with a required
  `expectedRevision`; a `PUT` prune is the only path that clears stale ids.

### HTTP face: endpoints, scope errors and the diagnostics body

Mounted under the host web server's `/cherry-remote/api` prefix — **no extra
listener, no LAN exposure, no separate credentials**:

| Method & path | Purpose |
| --- | --- |
| `GET /devices` | Device list. |
| `PATCH /devices/:id` | Update display name / enabled / addresses / port (`hosts` is **whole-replace**). |
| `DELETE /devices/:id` | Remove the device and tear down its connection. |
| `GET /scope` | The whole scope state in one body (see below). |
| `PUT /scope` | Save the scope — read-modify-write, `expectedRevision` required. |
| `POST /pair` | Start a pairing run; returns `202 {claimId}` at once, progress over SSE. |
| `GET /events` | SSE: `device-state` / `pairing-progress`. |
| `GET /diagnostics` | Operations report (below). |

> The minimal `pairing-progress` frame shape is `{stage, detail?}`; this plugin
> **additionally** attaches the optional `claimId` (a verdict extension for
> cross-run isolation, not part of the minimal field set) — consumers must
> tolerate its absence. The heartbeat is a payload-free comment line.

`GET /scope` returns ONE body: `scope` (the document's `mode`/`workspaceIds`/
`revision` — `version`/`updatedAt` stay behind), `workspaces` (the registry
projected to `id`/`title`/`path` only), `staleWorkspaceIds` (ticked ids the
registry no longer has — a `PUT` prune is the only path that clears them),
`pathUnmatched` (`agentId` + `cwd` for sessions whose cwd belongs to no
registered workspace — treated as workspace-less, **not** a degradation), and
`host` (`state` / `capable` / `reason` / `degraded`). `staleWorkspaceIds` and
`pathUnmatched` are two separate channels and neither derives from the other.
`degraded` is an array of `{source, reason}`, one latest entry per source, over
exactly five closed sources — `install`, `workspace-list`, `visibility-only`,
`scope-version`, `path-normalization` (an empty array is the honest "no
degradation"). `host` and `pathUnmatched` come from the same scope read the
diagnostics report uses, so the two faces cannot drift.

`PUT /scope` failures return `{error, message?}` with a stable code:

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid-scope` | `mode` is not `global`/`selected`, or `workspaceIds` is not a string array. |
| 400 | `missing-expected-revision` | The baseline is absent **or not a finite number** (one guard judges both). |
| 409 | `scope-revision-conflict` | The baseline `revision` is stale; `message` carries the current one. |
| 503 | `workspace-list-unavailable` | The registry is unreadable: write refused, stored ticks and `mode` move not one bit. |
| 503 | `scope-version-unsupported` | The document's `version` disagrees with the supported one (either direction): read-only, writes locked. |

A body that cannot be read at all (invalid JSON) is the generic `400
invalid-request` — not a scope-field verdict. Success is `200 {scope, pruned}`;
the returned `revision` is the next write's baseline.

### Diagnostics redaction is a whitelist

`GET /cherry-remote/api/diagnostics` aggregates device states, connection
statistics and a recent-error digest (`ERROR_MESSAGE_MAX` = 200 characters on
the error message).

- **May be emitted** (`sanitizeDevice`): `deviceId`, `displayName`, `state`,
  `enabled`, `hosts`, `port`, a **12-char digest** of `desktopIdentity`, the
  hello-negotiated `limits` (`heartbeatMs`/`subscriptions`/`pageItems`/
  `inFlightRequests` — **only with a live connection**; the endpoint never
  dials and never wakes a device to fetch fallbacks), `sessionId` and session
  cursors (unsubscribed sessions have none), the `stats` counters
  (`connections`/`sockets`/`connectionsBuilt`/`subscriptions`), the two resolved
  `config` keys, and error `reason`/`message`.
- **Never emitted**: `accessToken`, `tokenExpiresAt`, `invitationSecret`, the
  raw pinned `desktopIdentity`, message text and part text.
- The report is built field by field into a fresh object, so a credential added
  to the device archive later is excluded **by construction** — it never
  depends on someone updating a deny-list. `limits` is re-projected from its
  same four keys: a whitelist inside the whitelist.
- `stats.connectionsBuilt` counts connections built since the last `apply`, not
  RPC requests — request counting belongs to the transport, and publishing a
  same-named metric would be misread. Counters and the error ring are zeroed on
  every `apply`: the statistics describe **only** the current assembly.

### Logging: levels, identifiers, and what never appears

Level convention: **error** = connection failure / authentication failure /
protocol errors; **warn** = reconnect backoff / cache eviction / subscription
LRU eviction; **info** = pairing progress / subscription establish & recovery /
device-state transitions. Info logs the **stage name and identifiers only**
(`deviceId`, `sessionId`, pairing stage) — never payloads. Sensitive fields
(tokens, `invitationSecret`, `accessToken`, message and part text) **never
enter any log**; `deviceId`, the `desktopIdentity` digest and `sessionId` may.
The contract suite still holds both sides of this over a full pair → connect →
send → interact flow, asserting sentinel strings from the message and reply do
not appear in any console channel (`tests/contract/contract.test.ts`, “leaks no
secret to the log”).

### Trust fence

Every `/cherry-remote/api` route re-checks same-origin before acting, in order:
(1) non-loopback undeclared `Host` → refuse; (2) `sec-fetch-site: cross-site` →
refuse; (3) `Origin` present and not same-origin with `Host` → refuse;
(4) `Origin` absent → **allow** (curl, not a cross-site page).

## Upstream references

Neither reference lives in this repository.

- **`/tmp/csa`** — the official Cherry Studio **app** (`CherryHQ/cherry-studio-app`
  @ main `18329fe`, app 0.3.0). It plays the **same role we do** (protocol
  *client* against the desktop's server). Its remote layer is
  `src/backend/services/remoteAgent/` (`RemoteAgentScope.ts`, `remoteContent.ts`,
  `RemoteAgentActions.ts`, `SessionSync.ts`, …). This is where "what does the
  official client do" comes from.
- **`_research/cherry-studio`** — the **desktop** source at v2.1.6 (`90b234e`),
  the protocol **server** of record. The faces we depend on are
  `src/main/services/remoteAccess/` and `packages/remote-{protocol,transport}`;
  `RemoteAccessService.ts` carries the 512/s content-read line and the 64/s
  general line. Gitignored; treated as read-only research.
- `node_modules/@cherrystudio/remote-protocol` / `remote-transport` are the
  protocol schema source of truth for what we send and decode.

**Verified desktop range: 2.1.4 → 2.1.6** (plus post-2.1.6 commits on `main`).
Pairing payload, mDNS advertisement, protocol versions (`[1]`) and the Noise
profile saw **zero changes** in that window. Notable faces:

| Upstream change | Impact |
| --- | --- |
| 2.1.5 `connection.hello` adds `agentUploadsVersion` / `agentUploadChecksum` / `agentAttachmentSelections` and 5 `agentUpload*` limits | Additive: hello has no strict validation, limits are read by name |
| 2.1.5 record framing adds a binary marker (first byte `1`) for upload chunks | Additive: JSON record encoding is unchanged; we neither send nor receive binary |
| 2.1.5 attachments project as `{kind: 'file', name, ref}` | Metadata only — bytes are never fetched |
| 2.1.5 `agent.messages.send` requires non-empty trimmed `text` | `cherry_send` rejects blank text locally as `text-empty` |
| `agent.content.read` relaxed to 512/s | Our 32/s shared budget is unchanged; the content tier exists for throughput, not for the ceiling |
| 2.1.5 keychain-less Linux stores the identity as plaintext 0600; identity is never regenerated | Upgrades need **no re-pairing** |
| `5db8ab7` (agent runtime DSH → Pi, deleting `packages/dsh-bridge`) | The **opposite** bridge (Cherry driving DSH); unrelated to the remote-access face |

**Traps in the official app (a cautionary list, not a spec).**

- Its `RemoteAgentError(code, retryable)` marks `RATE_LIMITED`,
  `TOKEN_EXPIRED`, `RESOURCE_EXHAUSTED` and `CONNECTION_LOST` as retryable, and
  the background observation loop retries with exponential backoff
  (`min(20 s, 1 s · 2^n)`). A `RESOURCE_EXHAUSTED` raised by the **page size**
  (the upstream byte budget) is therefore retried forever at the same page size
  — it can never succeed. Our answer is the byte-safe page **clamp**: never ask
  for a page that cannot fit, instead of retrying a request that cannot.
- Its read path refuses a ref whose `byteLength` is unusable; we fall back to a
  slice bound plus the cumulative arm (see above). Its 32 MiB cap is a
  pre-allocated single array; ours is three transient copies (see the memory
  contract).
- Its read path never replays a read; we replay reads **once** (deliberate
  enhancement) while both sides keep commands receipt-recovered.
- Its command journal is the recovery mechanism for commands — the reason our
  commands are never replayed and recovery is a caller retry with the original
  `commandId`.

## Release

`npm run prepublishOnly` is the gate (typecheck + full suite + both builds).
Then walk [`docs/e2e-checklist.md`](docs/e2e-checklist.md): Electron-side
approvals cannot be CI'd, so pairing / send / interaction answers / disconnect
recovery / multi-device coexistence must be exercised by hand on a real desktop.
Tag `vX.Y.Z`, publish to npm (`publishConfig` pins the public registry), and
attach the notes to the GitHub release.

Notes on documentary labels: `Task N`, `spec §x`, `controller ruling`,
`UltraReview` in code comments and docs point at this project's internal SDD
process records under `docs/superpowers/**` — **not published** with the package.
They stay where the rule is, as provenance. `tests/loopback/fakeCherry.ts` is an
in-test loopback fake peer, not a shipped artifact.
