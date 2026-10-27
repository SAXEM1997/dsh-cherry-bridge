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
7. [Agent skills](#agent-skills)

---

## Development conventions

**Flow — GitHub Flow, one issue per branch.**

    issue → branch (off main) → TDD → PR → independent review → squash merge

- **Test first.** Write the failing test, watch it fail for the intended
  reason, then implement. Every new or changed test must be **mutation-verified**:
  break the implementation deliberately (invert the branch, delete the guard,
  return the old value) and confirm the test turns red. A test that passes
  against both the old and new code is not a test.
- **Sub-task test strategy.** While working, run only the fast subset —
  `npx vitest run tests/<area>/<file>.test.ts` plus `npm run typecheck` when
  types moved. The **full** suite (`npm test`, contract tests
  included) is run **once by the integrator before merge**, not per iteration.
  `tests/unit/artifactFreshness.test.ts` is the exception: it matters when
  source comments or build config changed, and is cheap enough to run then.
- **No source change without its artifact.** `src/`/`ui/` edits and their
  rebuilt `dist/`/`lib/` go in the **same commit** (see [Build facts](#build-facts)).
- **Scope discipline.** Change what the issue names. Adjacent discoveries go
  into a new issue, not into the diff. A doc-only change touches only docs.
- **The READMEs are a pair.** `README.md` (简体中文) and `README.en.md` (English)
  are expected to say the same thing; an edit to one is an edit to both.
- **AGENTS.md lives under a byte budget.** The workspace-instruction budget is
  65,536 bytes, and the harness **silently truncates the tail** past what fits
  — observed when this file stood past the budget: rules at the file's end
  vanished from context. Keep the file
  **≤ 64,512 bytes** (64 KiB − 1 KiB safety; check `wc -c AGENTS.md`); an
  addition needs a compensating trim in the same change.
- **Every promise a test starts settles INSIDE the test.** A request or
  `connect()` nobody awaits still holds its caller for `DEFAULT_TIMEOUT_MS`
  when the answer never comes; `void ... .catch(() => {})` hides that, and the
  next afterEach that awaits it turns it into a stalled suite.
  Produce the settlement (usually `close()`) and **assert** the verdict — issue
  #43 is the two sites that were masked this way.
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
  — `tests/unit/artifactFreshness.test.ts` rebuilds into a temp dir and compares
  **byte for byte** against the committed files. A missing rebuild
  is a red test, not a style nit.
- **`prepublishOnly` vs `artifactFreshness` — two different gates.**
  - `prepublishOnly` =
    `typecheck && test && build && build:client && npm pack --dry-run`: runs
    the whole chain (both type projects, the full suite, both builds, and the
    pack check) on the publish path. It proves the tree *is* buildable.
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
  dies (exit 127) looking for `tsdown`/`vite`. Committing the artifacts makes
  git installs, `--omit=dev` and packing a bare clone work with zero build steps.
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
| `@cherrystudio/remote-protocol` | `0.7.0` |
| `@cherrystudio/remote-transport` | `0.2.5` |
| `ws` | `8.22.0` |
| `zod` | `4.3.4` |

These are the versions Cherry Studio **desktop 2.1.8** ships (verified at
tag `v2.1.8`). Upgrading either protocol package means re-running
`tests/contract/contract.test.ts` against schema drift — the suite models the
**six behavioral differences** between our loopback fake peer and a real
desktop, each mapped to a manual step
in [`docs/e2e-checklist.md`](docs/e2e-checklist.md).

**Wire budget (from `remoteLimits` in the protocol package):**

| Limit | Value | Consequence in this plugin |
| --- | --- | --- |
| `recordBytes` | 65,536 (64 KiB) | one JSON-RPC record above it **aborts the connection** — the transport answers by killing it, so every in-flight request fails |
| `contentBytes` | 24,576 (24 KiB) | the slice size for one `agent.content.read` |
| `pageItems` | 100 | the protocol's single-page hard cap; `hello` may negotiate smaller |

Through 2.1.7 the desktop's `pageOf` pages by **count alone** (2.1.8's byte
budget aside, still count-paged): `pageItems: 100` fat parts produced a record
the transport killed — reading a complex session reset the connection. The
byte-safe clamps (`defaults.ts`: a 4-bytes-per-char worst case over the peer's
4,096-char `INLINE_TEXT_LIMIT`, +2 KiB margin) fix it; the effective page size
is `min(negotiated pageItems, clamp)`.

**Upstream context (#21854, shipped in 2.1.8).** Upstream added a
`PAGE_ITEM_BYTES` byte budget (62,279) to every paged `agent.*.list` face
(`pageOf` truncates, `queryPage` re-queries a keyset page at a halved limit);
an item that cannot fit raises `RESOURCE_EXHAUSTED`. No release through 2.1.7
carries it, so deployed peers mostly page by count alone and the clamps stay.

Follow-up [`#21951`](https://github.com/CherryHQ/cherry-studio/issues/21951):
an item above the budget **dead-ends the cursor** — it and everything behind it
become unreachable via a schema-valid record (`partIds` has no bound) —
`RESOURCE_EXHAUSTED` presents that permanent condition as retryable, and
`queryPage`'s halving wastes up to half the budget. A peer may therefore
come back with a page **shorter** than requested while still promising more,
which our walk already follows (`toolsListWalkCompat.test.ts` T2); it must
never come back **longer** (`CherryPage.pageOverflow`).

**Paged summaries (#105).** The hello `agentMessageSummariesVersion` bit is
stored beside `limits` per hello (absent when unadvertised — no reconnect
inherits it); ONE helper (`messageListRequest`) serves both message walks and
sends `partsMode: 'paged'` only at exactly `1`. Parts keep their clamp; only
the message page widens (to the negotiated `pageItems`); a
`RESOURCE_EXHAUSTED` with `details.retryable: false` says retrying cannot help.

**Pacing: two tiers against the desktop's allowances.**

| Tier | Methods | Desktop allowance | Default |
| --- | --- | --- | --- |
| `shared` | every business RPC but content reads | 64 req/s (≤2.1.6), **256 req/s** (≥2.1.7) | `rateBudgetPerSecond` = **32** |
| `content` | `agent.content.read` alone | 512 req/s (both) | `DEFAULT_CONTENT_READ_BUDGET_PER_SECOND` = **256** |

- **An over-budget request's verdict is generation-dependent**: through 2.1.6
  the desktop closes the whole session (`1011`); from 2.1.7 (PR #21687) it
  refuses that one request (`RATE_LIMITED` + `retryAfterMs`) and keeps the
  session. The generations cannot be told apart before one answers, so the
  default is sized for the harsher: 32/s is 2× under 64, 8× under 256; the
  content tier is 2× under 512.
- The tier is chosen by `classifyRateTier`, an **exact match**, not a prefix:
  widening it gives a shared-tier method the content budget silently.
- The content tier is **not a config key** — it derives from the one injected
  shared budget at 8:1, so lowering `rateBudgetPerSecond` lowers both, and is
  **capped at the peer's 512/s** (both generations), so a shared budget above 64
  stops scaling it.
- Since 2.1.6 the desktop externalizes every part over **4,096 characters**,
  making multi-slice content walks the common case — the reason the content
  tier exists (one 32/s tier bound such a walk to ~670 KiB/s).

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

### The `connecting` window: waited out, then judged

- The pool builds a `DeviceConnection` on **first touch** and dials it at once
  (`connectionFor`), so a tool called in the same tick — or during a reconnect —
  observes `connecting`: **an attempt in flight, not a verdict**. It used to be
  answered `device-unavailable` about a connection that came up a moment later.
- `#resolve` (the eleven device tools; `cherry_devices` and `cherry_unpair` take
  their own paths) and `cherry_devices`' rows wait for that
  attempt, bounded by `DEVICE_SETTLE_WAIT_MS` = 5 s: the wait ends on the first
  transition out of `connecting`, or on the bound with the state it finds, so the
  error face is the same — just later, after the attempt had its chance (before
  any wait answer's `AssemblyDeadline`).
- **Only `connecting` is waited on.** `offline` (parked in backoff), `disabled`
  and `identity-mismatch` answer at once: no wait can change them, and a
  powered-off desktop would pay the bound on every call. Nothing here starts a
  dial — the pool already did — so tools still never dial implicitly; kicking a
  device out of backoff is separate work.

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
  call, every device — shares it, so the ASSEMBLY peak is
  **4 × 3 × 32 MiB = 384 MiB worst case**, and in ordinary traffic
  `4 × 3 × (the declared size)`. It bounds the COUNT, not bytes: a byte budget
  must reserve each ref's declared size (optimistic) or its cap when unusable
  (serializing all behind one slot) — deliberately not what landed.
  It bounds what is being ASSEMBLED, not everything resident: finished content
  is retained by its caller OUTSIDE this product (up to one whole message per
  concurrent read, because `AGGREGATE_BYTES` is judged only between messages),
  plus the parts cache's own budgeted bytes (32 MiB per device).
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
(`#projectMessage`), which runs in two steps: obtain the parts RECORDS (one
`agent.parts.list` walk), then project them (one `agent.content.read` walk per
externalized `{ref}`, digest-verified). The cache sits BETWEEN the steps —
lookup before the list, store after it — and holds the LIST, never the
projection. An unchanged message therefore costs no repeat `agent.parts.list`
RPC on send → wait → read rounds, while every read still re-fetches and
sha256-verifies every `{ref}`'s bytes (a corrupted ref behind an unchanged
revision fails with `ContentIntegrityError`; `toolsReadCache.test.ts` T1b pins
this beside the cache). That is the honest claim — 2.1.6+ externalizes every
part over 4,096 characters, so a hit is not a zero-RPC read.

- **Entry & key**: the `agent.parts.list` result — `{revision, page}` — keyed
  `<deviceId>\0<messageId>` (device-scoped: a message id is the peer's; two
  desktops can issue the same one). The revision is the FENCE, not part of the
  key, and it covers parts RECORDS only: the cache inherits the peer's own
  `REVISION_EXPIRED` staleness class and adds none — and no more strength: the
  revision is a millisecond wall clock, so two writes inside one millisecond
  can keep it equal while the parts differ — a hit would then serve the older
  list for that revision's lifetime, and reproducing it needs a read between
  the two same-millisecond writes (a shared property of the scheme, not one
  the cache invented).
- **Never cached**: a row with an EMPTY revision (no fence — defensive only,
  `messageRevision` is a strict decimal, so no test drives it), a TRUNCATED
  parts page (a short list
  from a transient fault is retried, never remembered; the refusal is
  reason-blind so a future reason cannot reintroduce the bug), and a page above
  `MESSAGE_CACHE_ENTRY_BYTES` (1 MiB; walked fresh rather than allowed to crowd
  out a device's working set).
- **A failed part does NOT forget the list**: degradation happens in
  projection; the held records stay the peer's complete answer and every part
  is re-attempted next read.
- **Sizing**: `JSON.stringify(page.items).length` (the `AGGREGATE_BYTES`
  proxy). It excludes `{ref}` text (the multi-megabyte half) but INCLUDES
  inline text — up to the peer's 4,096-char `INLINE_TEXT_LIMIT` per part, so a
  few hundred fat inline parts can legitimately reach the 1 MiB entry cap.
  `MESSAGE_CACHE_BYTES_PER_DEVICE` = 32 MiB. Two bounds judged INDEPENDENTLY:
  an entry exceeding the entry cap **or** the device budget is refused — an
  entry the device can never fit must not evict it wholesale to store itself.
- **Eviction is FIFO** — `Map` order IS the policy (the same choice `#remember`
  documents). A **refresh keeps the key's insertion position** (a rewrite, not
  a use; delete-then-set would silently make it LRU). Room is made BEFORE a
  write for the write's **growth** (`bytes - previous`, zero when it shrinks),
  so a device never passes budget on either path — the refresh-that-grew case
  is the one that used to slip through. `#dropCachedMessage` is the ONE delete
  path (totals cannot drift from the map); the loop skips the key being written
  (self-eviction would reorder it). A drop warns once per insert that dropped
  anything: device and count only, never a message id.
- **A hit hands the PAGE out BY REFERENCE** — safe while projection only reads
  it; a future mutator must copy first.
- **Invalidation** rides `#forgetDevice` with the three session caches;
  `#watchConnection` routes `offline` / `identity-mismatch` there. An ordinary
  link loss also publishes `offline`, so a reconnect drops the cache — one
  re-walk per session, the documented cost of the seam.

### Walks: what is tolerated, what is refused

- **Empty pages.** The desktop's pinned-list walk legally answers
  `{items: [], nextCursor: 'entity:'}` once per walk (the pin→entity section
  transition). Tolerance is **2 consecutive** advancing empty pages; the **3rd**
  refuses. Any non-empty page resets the count.
- **A page whose `items` is not an array** (wrong type, or absent) is a
  PROTOCOL violation, refused on EVERY page, terminal or not: `pageOf` types the
  field `array(item)`, so a page with no rows says `items: []`. Read as an empty
  page it loses a whole page silently — on a terminal page even as
  `truncated: false`. The throw names the shape it got (`missing`, `null`,
  `string`, …) and never the payload, and it sits **before** the dropped-item
  bookkeeping (no array, no drop count to report).
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
reconnect, so under a flapping link each of the walk's ~30 requests could
absorb that wait — a 1 s window answering ~150 s later, the shape
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
  The IDLE face is different, and it is no longer a gap (issue #51): its
  `agent.sessions.get` is the §6 PRECONDITION that decides whether the session
  is idle at all, so there is nothing to degrade to — but it now rides an
  `AssemblyDeadline` of its own, anchored at TOOL ENTRY with the caller's window.
  A spent budget FAILS the call with a guidance error: nothing was learned about
  the run, so a retry is the recovery, and the caller is never handed a verdict
  the snapshot never produced. Before this it was the one wait-answer request
  with no absolute bound, and a flapping link could put 5–10 s of reconnect +
  replay behind a 500 ms window. The idle answer's HISTORY walk keeps its own
  anchor AFTER the snapshot, deliberately: a snapshot that was slow but
  succeeded must not leave the walk with nothing, so the two phases are bounded
  separately (a pathological call can spend both).

What this is NOT: a global time budget for `cherry_read` or the list tools —
they have no deadline argument; their bounds are `limit`, the safety breaker
and the byte budgets.

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
round trip, and still never saw the cut-off history. The second half was a
marker with no consumer: the loss stated, nothing able to act on it.

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
an opaque keyset token, the loopback peer's is a numeric offset, and a future
desktop may change it. Every token we emit is
therefore self-describing, and every token we accept must carry one of our two
prefixes; anything else is refused **before any device work**. This is not
pedantry: a malformed cursor handed to the real desktop is **silently swallowed**
(it falls back to the newest page), so a forwarded foreign string would come
back as the newest page presented as "continued history".

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

**The LIST face (issue #65) speaks the same vocabulary with one addition.** A
list walk is scoped by (method, device, filters), and the peer's page position is
opaque: replaying one from a different query is a perfectly valid number that
reads the wrong slice with no error anywhere. So a truncated list answers
`resumeCursor: "list:<opaque>"` — the position PLUS a fingerprint of that
binding — and the token is refused locally (no dial, no page) when replayed
against a different tool, device or filter set. The bare peer position never
leaves the tool: `nextCursor` is internal now. The `after:` anchor form stays
message-only (a list walk never trims a page, so a stop it can name always has a
peer position). From a resume point `limit` bounds THAT answer; a page the peer
overshoots is re-read from the position the walk sent (duplicates, never a gap),
and `cherry_interactions` counts pre-filter rows against `limit`.

**The token itself is compact and checksummed (issue #70):**

    list:v2:<tool>:<device12>:<filters8>:<checksum8>:<peer position>

- One character per tool (`a`/`w`/`s`/`i`) instead of the method name, a 12-hex
  **digest** of the deviceId instead of the 36-character UUID, an 8-hex filter
  fingerprint, and an 8-hex checksum. The peer position goes **last and
  verbatim** (it may contain the delimiter — the desktop's session cursor is
  `entity:<orderKey>:<uuid>`), so the split stops at a fixed field count. The
  three binding verdicts keep their own wording; `MAX_RESUME_TOKEN_CHARS` (4,096,
  shared with `cherry_read`'s `messagesResumeCursor`) is enforced by the parser and
  declared as the parameter's `maxLength`.
- **The checksum is the load-bearing half of that change, not the length.** The
  position is the one field no structural check can validate: measured over
  20,000 random single-character corruptions of the old base64-JSON token,
  **28.7% were accepted with a different position** — and the desktop's cursor
  decoders (`decodePinnedListCursor`, `decodeListCursor`) warn and fall back to
  the FIRST page for a position they cannot parse, so "continue from here"
  silently became the newest page presented as older history. Every
  single-character corruption is now refused locally (a test walks every
  position of a real token), and the token is 225 → ~100 characters on the
  sessions worst case, ~150 → ~44 on the numeric faces.
- **Two faces, two prefixes (issue #72).** The message face owns `cursor:` /
  `after:`; the list face owns `list:`. They must stay disjoint: while they
  shared one prefix, a list token replayed as `messagesResumeCursor` was a legal
  message cursor and was forwarded to the desktop, which answers an unparseable
  position by serving its FIRST page — the silent "newest page as older history"
  again. Each face now refuses the other's prefix with a message naming the
  mistake where the prefix identifies the other face (a bare `after:` on a list
  tool gets the generic "must be a `list:` token" verdict).
  The two exceptions are about OUR OWN retired formats, never about the peer's:
  a v1 list token is recognised by DECODING it (it lived under `cursor:` and its
  payload is colon-free base64url, so the message face would otherwise forward
  it), and it is named as an older format FIRST. A peer position is never
  inspected for a marker: `cursor:list:20` is still a message cursor whose
  `list:20` position travels verbatim, because the peer's format is opaque.
- A v1 token (base64 JSON, `{v,m,d,h,p}`) is refused by name — a plugin upgrade
  invalidates a held token, and "start the walk over" is the actionable answer,
  so that refusal does NOT reuse the generic "…or replay the token" tail: a v1
  token can never be replayed, whoever holds it.
- **Both faces name only a remainder their own parser would accept, and the rule
  lives in ONE pair of helpers.** `nameableRemainder` is the content dimension —
  `mangledRemainder` itself, the predicate `parseMessageResume` and
  `parseListResumeCursor` apply on replay — so the two sides cannot drift into
  two dialects. It refuses an empty remainder, one that is not equal to its own
  `.trim()` (leading/trailing whitespace), and one carrying a control character
  ANYWHERE; an interior plain space is legal and round-trips (`a b`).
  `nameablePeerPosition` adds the one refusal that applies to a POSITION and not
  to an anchor: `looksLikeV1ListToken`, because our retired 0.1.6 token
  (colon-free base64url of `{v,m,d,h,p}`) is indistinguishable from a peer
  position and both parsers name it. The `after:` arm deliberately does NOT take
  that second check — `parseMessageResume`'s `after:` branch never consults the
  detector, so applying it there would be the same bug mirrored: refusing to name
  a token the parser takes.
  **The round trip itself is a test, not a promise.** `parseMessageResume` is
  exported for one property: every token these emitters NAME is one it ACCEPTS.
  It is asserted over a varied probe table (numeric, keyset, unicode, interior
  space, base64url-shaped, the retired v1 payload) rather than per-clause, so a
  refusal added to the parser WITHOUT mirroring it here turns red for any probe
  that reaches it — the compensations are that a clause no probe reaches still
  slips through, and that over-refusal (naming less than the parser would take)
  is allowed by design, since it costs resumability rather than correctness.
  The failure mode all of this prevents is the emitter minting a stop point the
  same tool then refuses: the caller holds a token that can never be used, and
  the refusal surfaces at the resume call instead of at the answer that produced
  it. A refused remainder yields no token at all — `truncated` already says the
  walk was cut, and the remedy then follows the REASON rather than the absence:
  a `'limit'` stop answers to a wider `limit` only where the caller owns that
  ceiling (`cherry_read` and the four list tools — a WAIT answer's `'limit'` is
  its own fixed message allowance, so `cherry_read` is the way further), an
  `'aggregate-bytes'` stop is that answer's own output budget (more round trips,
  same budget), a `'safety-bound'` stop is an internal circuit breaker a caller
  cannot move, and a `'deadline'` stop — a wait answer's reason — is continued
  with `cherry_read`, which carries no deadline. The message face applies the
  content rule to the `after:` anchor as well as the `cursor:` position: a
  message id is an `opaqueId` too, so a padded id is schema-valid and really does
  reach the anchor arm. The LENGTH ceiling is the sibling guard in the next
  bullet.
- **The ceiling is enforced on the way OUT too — the same refusal in one more
  dimension.** `MAX_RESUME_TOKEN_CHARS` is judged by both parsers, so a token
  over it is one this tool would refuse on replay, and emitting it would hand
  the caller a stop point that can never be used. Both emitters run the FINAL
  token string through `withinResumeTokenCeiling` — the message face's
  `cursor:` and `after:` arms alike, and the list face's encoded token — and
  name nothing when it is over the bound: `truncated` still says the walk was
  cut, and the remedy follows the reason as set out above. The comparison is
  `<=`, so exactly 4,096 characters is still emitted. The guard measures the
  string it is about to hand out, never a reconstruction of its length, so a
  format change cannot leave it behind. This is about what the tool ACCEPTS; a
  well-behaved peer is far below it (the protocol's own `opaqueId` caps a cursor
  at 256 characters).
- **The `after:` arm's LENGTH case is pinned on the function; its CONTENT case
  runs through the tool.** An anchor is a message ID, and projecting that
  message sends the same id to `agent.parts.list`, whose `messageId` is an
  `opaqueId`. A peer item carrying an id above the token ceiling therefore
  fails its parts walk and is never RETURNED, so the over-long state is
  unreachable through the protocol, not merely untested; that arm is pinned by
  driving `messageResumeToken` directly (`tests/unit/resumeTokenEmit.test.ts`,
  both arms, both sides of the boundary), and the guard stays regardless,
  because the emitter must never mint what the parser refuses, whatever the
  peer's cap becomes. The CONTENT refusal IS reachable: `opaqueId` allows
  padding, so the parts walk for `' m-0 '` succeeds and that message becomes
  the anchor — `tests/integration/toolsReadResume.test.ts` ⑭d/⑭e/⑭f drive both
  arms through the tools. The `cursor:` arm and the list face keep their
  end-to-end tests as well (`toolsReadResume.test.ts` ⑭a/⑭b,
  `toolsRead.test.ts` ⑦h), which is why that helper is exported.
- **The tool DESCRIPTION is part of the contract, and it is pinned.** The guards
  above bound what a tool ACCEPTS and NAMES, so a description promising a token
  unconditionally is a claim the tool contradicts — and it is the claim a model
  reads first, more consequentially than the READMEs. Every TOP-LEVEL description
  that mentions a resume token says "when the stop point can be named", and none
  names the wrong absent case ("reached the peer's last page" was the stale one:
  a TRUNCATED walk by definition never reaches it). `cherry_read` states the
  exceptions, and it states them as EXAMPLES, deliberately: an exhaustive list is
  a promise that the next guard will falsify.
  `tests/unit/toolSchemas.test.ts` asserts the clause on every description that
  mentions the token (naming the tools would let a future one slip in) and the
  retired wording across all fourteen, so reverting one to the old text is a red
  test rather than a review catch.

### `AGGREGATE_BYTES`: one budget, two faces

`AGGREGATE_BYTES` = 256 KiB bounds a **projected message aggregate** (measured
with `JSON.stringify(...).length` as a cheap approximation of wire cost). Two
faces share it and one vocabulary:

- the terminal/timeout/idle aggregate returned by `cherry_send(wait: true)` /
  `cherry_wait` (message ceiling 20, `TERMINAL_AGGREGATE_MESSAGES` — ten runs'
  slack, newest-first), and
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
- A failed message may carry `failure: {reasonCode, retryable, message}`
  (peer classification, retry-worthiness, bounded summary); only its
  `source`/`context` are withheld.
- Attachments — `kind: 'file'`, and legacy `kind: 'data'` named `file` whose
  `{mediaType, filename}` is JSON in `content.text` — report `name`/`mediaType`
  (`byteLength` from a ref only), no `unavailable` (bytes not fetched), and
  `content` **empty** unless the record has a key we skip (then raw text,
  lossless).
- A terminal aggregate that cannot assemble is a **content** problem, not a
  verdict — the status stands; guidance points at `cherry_read`.

### Device archive: scheme+port per host

`DeviceRecord` (schemaVersion 4) stores `security` (`'ws'|'wss'`) and `ports`
(`number`) maps keyed by host, beside `hosts` — one each per candidate, every
host once (absent: `ws`/winner's record `port`). Both dials use
`directEndpointUrl` + both maps (`??`): `wss`→`wss` (#126), a non-winner host→its
OWN port (#135). v2→v3 backfills `ws`, v3→v4 `port`; both rewritten atomically
on read. Scheme loss breaks a TLS proxy; port loss dials right scheme at a dead
address. Re-typing keeps scheme (`securityFor`)/port (`portsFor`); whole-replace
`hosts` defaults new ones to `ws`/record port; `port` re-points EVERY final host.
`GET /devices` reports both maps (addresses, not credentials); tools/diagnostics
do not.
TLS trust is operator config (`wsTls`: FLAT `tls.connect` `rejectUnauthorized`/
`ca` only), forwarded to both dial sites (pool, pairing). `resolveBridgeConfig`
validates it: unknown key or unusable value warns by FIELD NAME, WHOLE object
ignored (half-applied trust reaches some peers, not others). Never persisted,
logged or reported; `ca` is PEM text.

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
> **additionally** attaches the optional `claimId` (a cross-run isolation
> extension, not in the minimal set) — consumers must tolerate its absence.
> The heartbeat is a payload-free comment line.

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
  dials and never wakes a device to fetch fallbacks), `messageSummaries` (the
  hello capability bit, absent when not advertised), `sessionId` and session
  cursors (unsubscribed sessions have none), the `stats` counters
  (`connections`/`sockets`/`connectionsBuilt`/`subscriptions`), the two resolved
  `config` keys, and error `reason`/`message`.
- **Never emitted**: `accessToken`, `tokenExpiresAt`, `invitationSecret`, the
  raw pinned `desktopIdentity`, message text and part text.
- The report is built field by field into a fresh object, so a credential added
  to the device archive later is excluded **by construction** — it never
  depends on someone updating a deny-list. `limits` is re-projected from its
  four keys: a whitelist inside the whitelist.
- `stats.connectionsBuilt` counts connections built since the last `apply`, not
  RPC requests — those belong to the transport; a same-named metric would be
  misread. Counters and the error ring are zeroed on every `apply`: the
  statistics describe **only** the current assembly.

### Logging: levels, identifiers, and what never appears

Level convention: **error** = connection failure / authentication failure /
protocol errors; **warn** = reconnect backoff / cache eviction / subscription
LRU eviction; **info** = pairing progress / subscription establish & recovery /
device-state transitions. Info logs the **stage name and identifiers only**
(`deviceId`, `sessionId`, pairing stage) — never payloads. Sensitive fields
(tokens, `invitationSecret`, `accessToken`, message and part text) **never
enter any log**; `deviceId`, the `desktopIdentity` digest and `sessionId` may.
The contract suite holds both sides over a full pair → connect → send →
interact flow, asserting sentinel message/reply strings never reach a console
channel (`contract.test.ts`, “leaks no secret to the log”).

### Trust fence

Every `/cherry-remote/api` route re-checks same-origin before acting, in order:
(1) non-loopback undeclared `Host` → refuse; (2) `sec-fetch-site: cross-site` →
refuse; (3) `Origin` present and not same-origin with `Host` → refuse;
(4) `Origin` absent → **allow** (curl, not a cross-site page).

- **A folded bind is normalized to an AUTHORITY.** `webStartup.host` is a bare
  hostname, but every `trustedHosts` entry is parsed with
  `new URL('http://' + entry)`, and an IPv6 literal MUST be bracketed there. So
  an IPv6 `--host` is bracketed when folded (`fe80::1` → `[fe80::1]`) and a
  value that is already bracketed is left alone (`[[fe80::2]]` would parse to
  nothing). Without this an IPv6 LAN bind contributed no usable entry and only
  loopback stayed reachable — fail-closed, but an availability gap (issue #9).
  Zone-scoped literals (`fe80::1%eth0`, with or without the `%25` spelling) still
  parse to nothing — this runtime rejects zone ids in an IPv6 literal outright —
  and a browser sends no zone id at all. A bind carrying a PORT
  (`example.com:8080`) is out of contract for `webStartup.host` and is dropped
  rather than trusted, which is the fail-closed direction.

## Upstream references

Neither reference lives in this repository.

- **`/tmp/csa`** — the official Cherry Studio **app** (`CherryHQ/cherry-studio-app`
  @ v0.4.0, read 2026-10-22), the **same role we play** (protocol *client*
  against the desktop's server). Its remote layer is
  `src/backend/services/remoteAgent/`; "what the official client does" comes
  from there.
- **`_research/cherry-studio`** — the **desktop** source at v2.1.6 (`90b234e`),
  read alongside v2.1.7, the protocol **server** of record. The faces we depend
  on are `src/main/services/remoteAccess/` and
  `packages/remote-{protocol,transport}`; `RemoteAccessService.ts` carries the
  512/s content-read line and the shared line (64/s through 2.1.6, 256/s from
  2.1.7). Gitignored; treated as read-only research.
- `node_modules/@cherrystudio/remote-protocol` / `remote-transport` are the
  protocol schema source of truth for what we send and decode.

**Verified desktop range: 2.1.4 → 2.1.8** (plus post-2.1.8 commits on `main`).
mDNS, protocol versions (`[1]`) and Noise saw **zero changes** there; pairing
changed only by ADDING the v3 QR arm (below).
Notable faces:

| Upstream change | Impact |
| --- | --- |
| 2.1.5 `connection.hello` adds `agentUploadsVersion` / `agentUploadChecksum` / `agentAttachmentSelections` and 5 `agentUpload*` limits | Additive: hello has no strict validation, limits are read by name |
| 2.1.5 record framing adds a binary marker (first byte `1`) for upload chunks | Additive: JSON record encoding is unchanged; we neither send nor receive binary |
| 2.1.5 attachments project as `{kind: 'file', name, ref}` | Metadata only — bytes are never fetched |
| 2.1.5 `agent.messages.send` requires non-empty trimmed `text` | `cherry_send` rejects blank text locally as `text-empty` |
| `agent.content.read` relaxed to 512/s | Our 32/s shared budget is unchanged; the content tier exists for throughput, not for the ceiling |
| 2.1.5 keychain-less Linux stores the identity as plaintext 0600; identity is never regenerated | Upgrades need **no re-pairing** |
| 2.1.7 raises the shared allowance to 256/s and refuses an over-budget request (`RATE_LIMITED` + `retryAfterMs`) instead of closing 1011 | No schema change; our 32/s default already sits far below it |
| 2.1.8: v3 pairing QR (`bc570d2b9`, PR #21387) — `pairingQrSchema` v2|v3 with custom host/port/security `endpoints`, tightened IPv6; paged message summaries (`54736dc9`/`8bf2fe28d`, PR #21992) advertised by the `agentMessageSummariesVersion` hello capability; server `PAGE_ITEM_BYTES = 62_279` per-item budget | Pairing consumes the published union (#124); summaries are consumed behind the hello capability (#105); a byte-budgeted page may come back SHORTER, which our walk already follows |
| `5db8ab7` (agent runtime DSH → Pi, deleting `packages/dsh-bridge`) | The **opposite** bridge (Cherry driving DSH); unrelated to the remote-access face |

**Traps in the official app (a cautionary list, not a spec).**

- Its `RemoteAgentError` marks `RATE_LIMITED`/`TOKEN_EXPIRED`/
  `RESOURCE_EXHAUSTED`/`CONNECTION_LOST` retryable and retries forever at the
  same page size, so a `RESOURCE_EXHAUSTED` from the byte budget never
  converges. Our answer is the byte-safe page **clamp**: never ask for a page
  that cannot fit.
- Its read path refuses a ref whose `byteLength` is unusable; we fall back to a
  slice bound plus the cumulative arm.
- Its read path never replays a read; we replay reads **once** (deliberate
  enhancement) while both sides keep commands receipt-recovered.
- Its command journal backs command recovery — the reason our commands are
  never replayed; recovery is a caller retry with the original `commandId`.

## Release

`npm run prepublishOnly` is the gate (typecheck, the full suite, both builds,
and `npm pack --dry-run`).
Then walk [`docs/e2e-checklist.md`](docs/e2e-checklist.md): Electron-side
approvals cannot be CI'd, so pairing / send / interaction answers / disconnect
recovery / multi-device coexistence must be exercised by hand on a real desktop.
Tag `vX.Y.Z`, publish to npm (`publishConfig` pins the public registry), and
attach the notes to the GitHub release.

**Three release steps fail silently when skipped.**

1. **Publish through staged publishing.** Direct `npm publish` is refused on
   this account (`E403 … two-factor authentication … required`). The npm bundled
   with Node 22 (10.x) has no `stage` subcommand, so stage with npm 11:
   `NPM_CONFIG_CACHE=/workspace/dsh/.superpowers/npm-cache npx npm@11 stage publish --registry=https://registry.npmjs.org/ --access public --tag latest`
   (add `--ignore-scripts` only when `prepublishOnly` just passed on this exact
   clean tree), then approve the printed stage id on npmjs.com →
   **Staged Packages**. `npm stage approve` answers `404 staged version … not
   found` here (every token tried, incl. publish-capable and `--otp`), while
   `GET /-/stage/<id>` returns 200 — so the web approval is the one that works.
   Check the result with
   `npm view dsh-cherry-bridge dist-tags`: an unapproved stage is silent.
   A first publish also leaves a public `0.0.0-stage` placeholder in
   `versions` (0.1.5 did); approving moves `latest` to the real version.
2. **Bump BOTH README install pins in the same commit, before staging** — the
   `@X.Y.Z` and `#vX.Y.Z` specs in `README.md` and `README.en.md`. npm serves
   the README captured in the tarball, so a pin bumped after the publish is
   stale on the npm page, and the two files are a pair that must never drift.
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

### Issue tracker

Issues live in this repo's GitHub Issues, via the `gh` CLI (`origin` is a GitLab
mirror; issues are on GitHub only). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels, unchanged from the defaults (`needs-triage`,
`needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See
`docs/agents/triage-labels.md`.

### Domain docs

single-context: one `GLOSSARY.md` and one `docs/adr/` at the repo root, both
created lazily. See `docs/agents/domain.md`.
