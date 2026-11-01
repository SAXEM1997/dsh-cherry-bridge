# Changelog

All notable changes to `dsh-cherry-bridge`. This project adheres to
[Semantic Versioning](https://semver.org/): the minor digit carries new
capability, the patch digit carries fixes and hardening with no protocol
surface change.

## Compatibility

Every release section states the Cherry Studio **desktop** range it was verified
against; the range for the current tree is **2.1.4 – 2.1.10** (the `v3` pairing QR
needs 2.1.8+, the `v2` QR works from 2.1.4). The newest generation whose protocol
packages this project pins is 2.1.8 — 2.1.9 and 2.1.10 ship the same
`0.7.0` / `0.2.5` pair and differ from 2.1.8 on the remote-access face by one
robustness fix in the desktop's write chain (PR #22593), smoke-tested here on a
real 2.1.10. Sections written before this
convention do not carry the line; both READMEs state the same range for readers
who never open this file.

## v0.2.1 (2026-11-01)

Addresses stay where the operator puts them. A desktop has advertised its own
endpoints since 2.1.4 (`connection.endpoints`, hello bit
`connectionEndpointsVersion: 1`) and this client consumed neither of them, so an
address that appeared after the QR was minted — a VPN, a second NIC — stayed
unreachable until someone edited the device card. Every handshake now asks once
and learns the answer into the dial list. The other half is the refusal to undo an
operator: an address can be FORGOTTEN, which drops it from the dial list **and**
keeps every later advertisement from adding it back, from the settings page or
from the `cherry_devices` tool.

Verified against desktop **2.1.4 – 2.1.10**: the upper bound moves from 2.1.8 in
this release (PR #199), where 2.1.9 and 2.1.10 differ from 2.1.8 on this
face by one robustness fix in the desktop's own write chain (PR #22593, with the
protocol packages still `0.7.0` / `0.2.5`). The peer protocol surface, the
protocol pins and the tool COUNT are unchanged — still 14 `cherry_*` tools. What
moved is the DEVICE face: `cherry_devices` gained `action: "forget" | "remember"`,
every device view gained `forgottenHosts`, and the page gained two matching
routes. The version preamble above reserves "new capability" for the minor
digit; this ships as a patch by the maintainer's decision, with the new
capability on the LOCAL faces only.

### Upgrade notes

- **The archive is still `schemaVersion` 4.** 0.2.1 adds one OPTIONAL key
  (`forgottenHosts`): nothing migrates, and 0.2.0 reads the file unchanged.
- **A downgrade to 0.2.0 keeps the key and ignores it.** An address the operator
  forgot is dialed and re-learned again, and an edit that names one writes a
  record holding it in BOTH `hosts` and `forgottenHosts`. 0.2.1 REPAIRS that one
  cross-version state on read — the address is kept, the mark dropped, a warning
  logged — instead of refusing the archive, because refusing it would take every
  device tool down until someone edited `devices.json` by hand.
- **A forgotten address returns only through `remember`, or through a PATCH that
  names it.** `remember` lifts the mark and nothing more: the address comes back
  on the next handshake the desktop advertises it on, at the port and scheme the
  peer reports then, never from a copy that was captured before the forget.

### Added

- **The desktop's advertised endpoints are learned into the dial list** (#143,
  PR #182). The call is made once per handshake, after `authenticate` (the
  desktop gates it on the authenticated session) and bounded by its own 2 s
  (`ENDPOINTS_LEARN_TIMEOUT_MS`, below `DEVICE_SETTLE_WAIT_MS`, so this wait
  alone cannot outlive a tool's `connecting` window). The answer decides where
  this client dials, so three gates stand between it and the archive: the hello
  capability bit strictly `1` (a version this client cannot speak is not evidence
  that it speaks 1), the identity pin (an answer that does not name our own
  `desktopIdentity` is dropped WHOLE), and the peer's own
  `advertisedEndpointSchema` per entry (which rejects a loopback destination and
  normalizes the host). The merge is ADD-ONLY: unseen hosts only, compared
  case-insensitively because a PATCHed record keeps the operator's spelling while
  the peer's schema lowercases; an existing entry is never re-pointed, none is
  ever removed, and the list is capped at the 32 candidates a pairing QR can
  carry. Persistence goes through `DeviceStore.learnEndpoints`, which merges a
  CLONE of the stored record — the connection's copy mirrors the live access
  token and this archive deliberately keeps the pairing's — re-checks the
  identity pin so a re-pair under the same `deviceId` cannot inherit an address
  from the previous pairing, and writes only when a host was added. EVERY failure
  is silent by construction: everything after the capability gate sits in one
  catch, so a refused or wedged call, a malformed answer, or a throwing
  persistence hook cannot fail the handshake.
- **An address can be forgotten for good** (#185, PR #188). Removing a host from
  the list never held: the desktop keeps advertising it on every handshake and
  the learn merge re-added it, which made the address list a suggestion. One
  per-host mark (`forgottenHosts`, case-insensitive, no duplicate) now makes the
  merge skip that host in every case — a dialed host removed by `forget` is
  marked in the same write, and its `security` / `ports` entries go with it.
  `forget` refuses to remove the LAST candidate (`last-address`), because a
  record with no address is a record that never dials. Reachable from
  `cherry_devices` (`action: "forget"`, `hosts: [...]`) and, since PR #207, from
  the settings page; a PATCH whose `hosts` names a forgotten host clears its mark
  on the same write, so "put it back" needs no second request.
- **The settings page forgets and restores addresses** (#204, PR #207). Every
  dialed host carries a 忘记 button, and a non-empty 已忘记地址 row shows one 恢复
  per mark plus the hint that restoring only lifts the mark. Two POST routes —
  `POST /devices/:id/forget`, `POST /devices/:id/remember` — open the same door
  the tool uses and call the same two store methods, so the refusal vocabulary,
  the case-insensitive matching and the disjointness of the two lists stay the
  store's; only the body parser differs (it inherits the PATCH's host
  normalization, not its duplicate-spelling refusal). Both answer the SAME flat
  projection `PATCH /devices/:id` answers, one builder now feeding all four
  faces, and both EVICT the pooled connection on a change — for two different
  reasons: a captured record would keep dialing a forgotten host, and a restored
  host is only ever re-learned INSIDE a handshake, so without the eviction a
  stably connected desktop would never re-handshake and 恢复 would look inert.
  The cost is real and stated in the code: the subscription layer is disposed, a
  healthy socket closes, and an in-flight command can be lost. The two controls
  are INERT while the address editor is open, because that form PATCHes the
  whole host list from a draft the card deliberately does not reseed — a mark
  chosen underneath it would be silently reverted by the next 保存地址.

### Fixed

- **A PATCH that re-types a host's case keeps its scheme and port** (#189,
  PR #195). `securityFor` / `portsFor` retained a staying host by exact string
  match while every other host comparison on that face is case-insensitive, so
  re-typing `NAS.example` as `nas.example` kept the address and reset its scheme
  to `ws` and its port to the record-level one: a TLS proxy silently demoted to a
  plaintext dial the desktop refuses, with the archive making it look like an
  operator choice. Both helpers now consult a lowercased index built from the
  previous map's OWN entries, AFTER the exact spelling (so a surviving spelling
  keeps its own entry and the collision rule only decides what a third spelling
  inherits); `Object.hasOwn` stays, so an inherited `constructor` is still not a
  remembered scheme. The duplicate rule in `parsePatch` became case-insensitive
  FIRST: two spellings of one host have no single map entry, and without that
  guard a PATCH could WRITE the ambiguous record the new lookup would have to
  resolve.
- **A pairing run whose terminal frame never arrives now exits** (#170, PR #171).
  The wizard cleared its submit gate only on a terminal `pairing-progress` frame
  or a refused `POST /pair`, and the stream carries no replay, so one dropped
  frame parked the page on 「配对进行中」 with no cancel control and a dead submit
  button. A 180 s deadline now arms when the phase reaches `waiting` and on
  expiry does what a settle does minus the verdict: restore the form, drop the
  transient code, re-read the device list, and point the copy at that list
  instead of claiming 配对失败 — the run may have been approved while its frame
  was lost. `claimId` is deliberately kept, so a late terminal frame still
  replaces the alarm with the truth.
- **The pairing POST is bounded, and then every call on the page** (#173,
  PR #177; #180, PR #181). A wedged transport used to strand the first-run gate
  with nothing to click; there is now one bounded request helper
  (`DEFAULT_REQUEST_TIMEOUT_MS` = 10 s) that every surface turns into a sentence
  of its own, so a hung 停用/重命名/移除 says so instead of printing the internal
  `cherry-remote.request-timeout` marker onto a Chinese page. The device list
  became three-state — empty, loading, or UNKNOWN, where the error speaks alone —
  because a failed read used to sit beside 「暂无已配对设备」 and contradict it.
- **The per-tier pacing queue can no longer wedge** (#200, PR #202). This is a
  guard, not a fix: both arms of the chain now hand off the same way, so a future
  rejecting link (or a throwing `release`) cannot make every later link skip its
  callback. No link can reject today, so no test can turn red for it — that is
  stated here rather than left to look like a regression that was observed.

### Tests

- **The loopback fake now models the gates a real desktop applies**, one face at
  a time, each change pinned by an observation from the peer's own ledger rather
  than by an error alone: the pairing path's authenticated state (#183, PR #184);
  `connection.authenticate` behind a confirmed hello and `connection.refresh`
  behind an authenticated session, with a stale stored token made drivable
  (#186, PR #190); every `agent.*` handler behind
  `requireAgent()` → `requireCapability('agent')` (#187, PR #193);
  `connection.ping` behind the hello (#192, PR #197); an approved-device lookup
  before the token gate (#191, PR #198); a per-domain capability snapshot taken
  at the same door that sets `authenticated`, with `connection.endpoints` no
  longer hardcoding `domain === 'agent'` (#194, PR #196). Every new knob is
  OPT-IN, so unset means "accept everything, as before"; the gates themselves are
  unconditional, so an un-greeted or unauthenticated socket is refused whether a
  case opted in or not.
- **The `configuration.*` faces answer behind the `configuration` grant** (#201,
  PR #203), reproducing the desktop's own arithmetic: a size ceiling on the
  bytes, one export per connection, `byteLength` as a decimal string, `eof`
  judged on the slice actually returned, and the params schema that refuses what
  the desktop refuses (`maxBytes` past 24,576, a negative `offset`, non-empty
  `prepare` params). The export's ownership is now asserted from both directions
  — two sockets on one fake, neither able to read the other's export (#205,
  PR #206).
- **The pairing frame that beats the `/pair` response is pinned** (#172,
  PR #176): the run settles from a frame that arrives while `claimId` is still
  undefined, because the app keeps the newest frame and the effect re-runs when
  the handle commits. No source change — the mechanism worked and nothing tested
  it.
- Making the fake stricter found two rigs that had been passing on its
  permissiveness: a `SessionSubscriptions` fixture that drove 27 tests over a raw
  socket which never helloed or authenticated, and a hand-built client that
  pinged before greeting (#187, #192). The rigs were repaired, not the gates
  relaxed.

### Docs

- **Both READMEs, this file and `src/AGENTS.md` state the range through desktop
  2.1.10** (PR #199), verified on a real 2.1.10 desktop — and the upstream
  research note gained the one-command check (a tree hash) that settles "did a
  new app version move the wire" without a 26-commit diff. The app baseline moves
  to v0.5.2 (#174, PR #175).
- **A contract test pins both README install specs to `package.json`'s version**
  (#168, PR #169). Skipping that bump fails silently — npm serves the README
  captured in the tarball — so the invariant is now a test: the two whole specs
  must be present per README, and no OTHER version may be pinned anywhere.
- **The release section names the three destinations and the retry discipline**
  (PR #169), and the release commit is recorded as an integrator-reviewed tier
  whose notes are still checked claim by claim (PR #166), because the
  section ships verbatim as the GitHub release body.
- **`ui/AGENTS.md` records that the client bundle carries its source comments**
  (#178, PR #179): `minify: false`, so a comment-only edit under `ui/src/**`
  changes `lib/client.js`, and `artifactFreshness` compares against
  `git show HEAD:<path>` — it stays red until the rebuild is committed.
- **The e2e checklist gains the 0.2.0 machine-verifiable record** (PR #167):
  what an agent can assert alone, and what it cannot — named as uncovered, not
  as passes.

## v0.2.0 (2026-10-27)

Alignment with desktop **2.1.8**. The protocol pins move to `0.7.0` / `0.2.5` —
the versions 2.1.8 ships — which brings custom-address (`v3`) pairing
invitations, paged message summaries behind the hello capability, and a `wss`
desktop that is now pairable **and** re-connectable. Verified against desktop
**2.1.4 – 2.1.8**: the `v3` QR needs 2.1.8+, the `v2` QR keeps working from
2.1.4. A 2.1.4 – 2.1.7 desktop keeps working exactly as before: the new
capabilities are gated on what the peer advertises (paged summaries) or on a
`v3` QR only 2.1.8 can mint. The tool face is unchanged — still 14 `cherry_*`
tools with the same input schemas — everything below is transport, pairing,
durability and rendering.

Two one-way doors travel with this release; both are stated first.

### Upgrade notes

- **The device archive migrates itself on first read.** `2→3` adds the per-host
  `security` map, `3→4` the per-host `ports` map; the file is rewritten at
  `schemaVersion` 4 in one atomic write and every paired device keeps working —
  no re-pairing, no manual step.
- **A downgrade to 0.1.x loses the device list.** 0.1.11 reads at most
  `schemaVersion` 2 and refuses a newer archive (`device archive declares
  schemaVersion 4, newer than supported 2; refusing to read it`), so every
  device tool fails until `devices.json` is moved aside — and then each desktop
  must be paired again. Copy `<dataDir>/devices.json` before downgrading.
- **A `wss` desktop behind a private CA needs `wsTls`.** The SCHEME is
  persisted with the device; the TRUST deliberately is not, because a
  certificate in an archive is a certificate in every backup of that archive.
  Without `wsTls` a self-signed TLS front fails the handshake exactly as it did
  in 0.1.11 — now tagged `websocket:` before the upgrade and `channel:` after
  it, so the failure says which half broke.

### Added

- **A custom-address pairing invitation (`v3` QR) is accepted** (#124,
  PR #125). Pairing now consumes the published `pairingQrSchema` as a `v2` |
  `v3` union instead of hand-rolling field checks. A 2.1.8 desktop can mint an
  invitation that names its own host, port and scheme per endpoint (up to 32
  candidates), and the walk dials each one — `ws` for a plain address, `wss`
  for a TLS front. `v2` payloads (auto-detected addresses) keep their exact
  error face, host normalization and redaction. `@libp2p/peer-id` joins the
  dependencies (pinned `6.0.15`, the transport's own version) for the pin
  decode below.
- **Paged message summaries are adopted behind the hello capability** (#105,
  PR #129). When a connection's hello advertises
  `agentMessageSummariesVersion: 1`, `cherry_read` and the
  terminal/timeout/idle wait send `partsMode: 'paged'` and enumerate parts
  through `agent.parts.list`; message rows stay metadata instead of carrying
  their `partIds`, which is what made a large row collide with the peer's
  per-item byte budget. The dialect is decided in ONE helper both walks go
  through, never sent to a peer that did not advertise it, and re-decided on
  every reconnect (the hello is re-negotiated). The byte-safe page clamp is
  relaxed for that peer, never removed: a count-paged desktop still gets the
  16-item page, a summary peer a full 100-item page. `GET …/diagnostics` gained
  a top-level `messageSummaries` field — present only while a live connection
  reported it — so one `curl` answers "does this desktop speak summaries?"
  without a packet capture.
- **A permanent peer refusal explains the recovery it cannot offer** (#105,
  PR #129). `RESOURCE_EXHAUSTED` carrying `details.retryable: false` now
  extends the message with the two opposite pieces of advice it needs:
  `ITEM_TOO_LARGE` means the item itself is past the peer's 62,279-byte
  per-item budget, so no page size and no request shape can fetch it (nor the
  items behind it — upstream #21951), while any other permanent shape says to
  ask for fewer items per page. The reason, the `data` and the error identity
  stay the peer's.
- **`wsTls`: operator TLS trust for `wss` dials** (#133, PR #137). Flat
  `tls.connect` options — `rejectUnauthorized` and `ca` only — applied to BOTH
  dial sites (pairing and the reconnect pool). Never written to the device
  archive, never logged, never in diagnostics. All-or-nothing: an unknown key
  or an unusable value warns by name and falls back to Node's default trust
  store, with no partial application. `ca` is PEM CONTENT (the certificate
  text), not a path. Both READMEs gained the config row.
- **Per-host dial ports are visible in the settings page** (#140, PR #145).
  When a record's `ports` map disagrees with its record-level `port`, the
  device card shows a read-only `host:port` list (IPv6 literals bracketed for
  display) plus a hint, so an operator can see that a host dials somewhere
  other than the single number the record advertises. Per-host EDITING stays
  out: the card keeps one port field, and changing it re-points every host.

### Fixed

- **A `wss`-paired desktop reconnects over `wss`** (#126, PR #132). The pairing
  dial honoured the endpoint's own scheme while the steady-state reconnect
  rebuilt a plain `ws://` URL: such a device paired, worked for one session,
  then failed every reconnect. The record now carries `security` per host
  (`schemaVersion` 3), and both dial sites build their URL through the same
  `directEndpointUrl` helper.
- **A multi-endpoint `v3` record reconnects each host on ITS OWN port** (#135,
  PR #138). The record kept one `port` — the winner candidate's — beside a
  per-host scheme map, so a non-winner host dialled the right scheme at the
  wrong port. `schemaVersion` 4 adds `ports: Record<host, number>`, backfilled
  from `port` for every existing host. `GET …/devices` returns both maps, and a
  PATCH derives them rather than accepting them: a host that survives a `hosts`
  replacement keeps its own scheme and port, a CHANGED `port` re-points every
  final host, and a re-sent unchanged `port` leaves a mixed map intact (which is
  what the settings page does on every save). A PATCH whose `hosts` repeats a
  host after normalization is refused — the maps are keyed by host, so a
  duplicate has no single entry.
- **The candidate dial walk has ONE aggregate budget** (#141, PR #146). Each
  attempt was bounded (10 s), the walk was not: a schema-valid `v3` invitation
  admits 32 endpoints, so an unreachable one could spend 320 s before
  `unreachable`, outliving the 120 s invitation it was trying to claim. The
  walk now derives a 30 s budget once (never above the poll timeout), stops
  when it expires, names what it skipped (`not attempted (the 30000 ms dial
  budget was exhausted before this candidate)`), and clamps the last attempt so
  it cannot overshoot. The per-attempt `connectTimeoutMs` is unchanged: a slow
  LAN Noise handshake is real.
- **Every candidate failure names its kind** (#142, PR #149; #147, PR #151). A
  failure used to reach the operator as a raw `Error.message`, dropping the
  discriminator that decides the fix. There are now three kinds: `timeout:`
  (the per-attempt timer won — check the network), `websocket:` (the socket
  failed BEFORE the upgrade — check this address or its TLS, with the `ws`/OS
  code appended when one exists, including a close frame's code), and
  `channel:` (the upgrade completed and the CHANNEL failed — Noise handshake,
  remote identity proof, protocol offer — so blaming the address would send the
  operator to inspect something that demonstrably answered).
- **The joined `unreachable` verdict is bounded** (#148, PR #154). One segment
  per candidate with no cap reached roughly 17–18 KB for a pathological `v3`
  QR (32 endpoints × long hosts, each host repeated inside its `ENOTFOUND`
  text). A segment is now `<label>: <detail>`, at most 240 characters, so 32
  candidates join to ≤ 7,742; every `host:port` stays identifiable, the label
  is clipped in the HOST so the port survives, and a truncated detail carries
  the shared `… (+N chars)` marker. No candidate is dropped — #141's contract is
  that an unattempted candidate is NAMED.
- **The progress line and the stage-failure text are bounded too** (#152,
  PR #157). `report()` runs once per stage transition and joined every
  candidate host: ~8 KB per stage for the same pathological QR. The host list
  is now at most 160 characters of names, with the first host always shown and
  an explicit `(+K more)` marker on top, and `asPairingError`'s
  `pairing <stage> failed: …` — the one `unreachable` text that never passed
  through the segment helper — is clipped through the same bound.
- **A malformed `desktopIdentity` is refused at parse time** (#153, PR #158).
  The schema accepts any 1..256-character string for the pin, so junk passed
  validation, every candidate consumed a socket, and the verdict named a
  multibase decoder. The pin is now decoded before any dial
  (`peerIdFromString`), refused as `invalid-payload` naming the field, with
  zero sockets opened and nothing persisted — the same rule the address checks
  already follow: an invalid invitation must never consume itself.
- **Peer- and payload-controlled text is bounded everywhere it is RENDERED**
  (#155, PR #162; #161, PR #164). One module (`src/text.ts`) now owns the
  bounded-rendering forms: `clipText` (fixed-point `… (+N chars)` marker),
  `boundedJoin` (`(+K more)` count), `LOG_TEXT_MAX` = 240 for one detail, and
  `failureText` for a caught failure — the message alone, clipped, and TOTAL: a
  caught value whose `toString` or `message` getter throws yields
  `<unrenderable failure>` instead of escaping the catch. What is bounded is
  what a peer or an operator-supplied payload controls (pairing segments, the
  unknown-key warning, the recovery session list, the two connection log lines,
  the JSON-RPC notification line). The follow-up audit covered 27
  `console.*(…, error)` sites — 7 converted to `failureText`, 20 kept as the
  error OBJECT because they are purely local fan-out, where the stack is the
  useful half — plus the sites an `error`-shaped grep misses (two
  `reportError` catches and one `error.cause`, all local and now marked) and
  one log line that interpolated a message unbounded. The rule and its
  boundary (`deviceId` stays unclipped — the operator correlates on it; tool
  RESULTS stay unbounded by product decision; `truncateErrorMessage` and
  `bounded()` stay separate because their markers mean different things) are
  written down in `src/AGENTS.md`.

### Changed

- **Protocol pins**: `@cherrystudio/remote-protocol` `0.5.0` → `0.7.0`,
  `@cherrystudio/remote-transport` `0.2.1` → `0.2.5` (#124, PR #125). `zod`
  stays `4.3.4` (0.7.0's peer is still `^4.3.4`); `json-canonicalize@3.0.1`
  arrives transitively with the protocol package and is not a direct
  dependency.
- `src/urlHost.ts` is retired: both dial sites build their URL from one helper,
  `directEndpointUrl` (#134, PR #136).
- Repository hygiene: `.gitignore`'s scratch rule widens from `.scratch-*/` to
  `.scratch-*`, so a scratch FILE can no longer ride into a commit (#139).

### Docs

- **Both READMEs state the desktop range** (#159): 2.1.4 – 2.1.8 tested, the
  `v3` QR needs 2.1.8+, and outside that range the peer fails loudly as
  `unreachable` because the handshake negotiates protocol version `[1]` only.
  This file gained the `## Compatibility` preamble that makes the range a
  standing part of every release section — the GitHub release bodies are these
  sections verbatim.
- **`AGENTS.md` is split into per-tree files** (#160, PR #163). The root keeps
  the rules every session needs (flow, tests + mutation, commits, build facts,
  release); the protocol basis and every design invariant moved to
  `src/AGENTS.md`, the test shapes and numbering to `tests/AGENTS.md`, the
  settings page's seams to `ui/AGENTS.md`. A nested file loads automatically
  when a file tool touches its tree, so ~54 KB of invariants is no longer paid
  on every turn — same content, same rules, relocated. (Just before it, #128,
  PR #131 had pulled the single root file back under the 64 KiB instruction
  budget, which is what the split then made durable.)
- **The upstream research baseline moves to app v0.5.0** (#144, PR #150): it
  sits on exactly our pins, so there is no new capability to track at desktop
  2.1.8, and the "retries forever" claim is corrected (the app honours
  `details.retryable: false`).
- **The e2e checklist's verified range moves to 2.1.8** (#127, PR #130), and its
  "Protocol basis" pointer now targets `src/AGENTS.md`.

## v0.1.11 (2026-10-23)

Receipt recovery for all three command tools, and a legacy attachment face.
No protocol-surface change: the tool input/output schemas stay as 0.1.10 had
them — what changed is which local retry the desktop's command ledger
recognises, and what an attachment read reports.

### Fixed

- **`cherry_send` under a retried `commandId` replays the original body, so
  the desktop replays the recorded receipt** (#115, PR #117). A command
  whose reply was lost mid-wire stays uncertain, and its only recovery is a
  retry with the SAME id and the SAME body — but send's body carries a
  DERIVED field (`expectedIdleRevision`, read from the session cache at call
  time), so a retry after the session moved composed a different body and
  the peer answered `IDEMPOTENCY_CONFLICT`, with advice that most likely
  sends the message a second time. The engine now remembers the exact body
  it issued for each caller-supplied `commandId` (written at issue time,
  before the reply is awaited — the lost-reply path is the one it exists
  for; bounded FIFO, 128 ids per device) and replays it verbatim on a
  same-id retry. A same-id call with different `sessionId`/`text` is
  refused LOCALLY, no wire call, in the peer's own wording. The memory
  survives an ordinary reconnect — the ledger it replays against does too —
  and is dropped only by `cherry_unpair` and `identity-mismatch`.
- **`cherry_respond` and `cherry_cancel` recover the same way** (#118,
  PR #122). Their bodies carry even more call-time state (respond's
  expected triple from the interaction snapshot, cancel's
  `expectedExecutionId` from the cached active execution), and their
  retries usually died BEFORE the body was compared — at
  `unknown-interaction` / `no-active-execution` once the card or run had
  moved on. The remembered entry generalizes to `{method, fingerprint,
  body}` and both tools consult it FIRST, before the snapshot and the
  pre-check verdicts: a same-id retry with deep-equal arguments (key order
  ignored) replays the exact body verbatim; differing arguments, or an id
  minted for another method, are refused locally with zero wire calls. The
  send self-heal keeps its own fresh-uuid attempt, and the caller id
  afterwards holds the healed body — a later same-id retry meets the peer's
  conflict rather than replaying a rejected receipt that would duplicate
  the run.
- **A legacy `data` attachment's metadata is lifted out of its JSON text**
  (#114, PR #119). A 2.1.7 desktop returns an attachment it did not upload
  as `{kind:'data', name:'file'}` whose `content.text` is a JSON
  `{mediaType, filename}` string — which the read path presented as the
  attachment's text, with no `name`/`mediaType` of its own. The projection
  now lifts those two fields exactly like the uploaded face: the
  DISCRIMINATOR is the part's `name` (`file` = attachment;
  `data-compaction-anchor`, `data-error` and every other label pass through
  untouched), `filename`→`name` (absent when null), no `byteLength`, and
  `content` is emptied only when every key of the parsed record is one of
  the two reported fields — an extra key keeps the raw text, so nothing
  unprojected is silently dropped. An externalized record (past the peer's
  4,096-character inline limit) resolves through exactly one content walk,
  and the parsed record outranks the serialization envelope (`text/plain`
  never wins).

### Docs

- The e2e checklist's attachment step verifies BOTH faces by hand — the
  uploaded `kind:"file"` face and the legacy data-named-`file` face that
  produced #114 — mirroring the projection guarantee (#120, PR #121).

## v0.1.10 (2026-10-22)

Alignment with desktop **2.1.7**, whose over-budget answer changed from "close
the session" to "refuse this one request". No protocol-surface change: the tool
INPUT schemas stay the same (the `failure` field below is additive on the output
side), and a 0.1.9 install keeps working against both desktop generations.

### Fixed

- **A rate-limited READ is retried once instead of failing** (#104, PR #108).
  Desktop >= 2.1.7 answers an over-budget request with `RATE_LIMITED` +
  `retryAfterMs` and keeps the session, while <= 2.1.6 closed it (`1011`). A
  read now waits `min(retryAfterMs, 1 s, deadline)` and replays **once** through
  a fresh pacing admission; a second refusal surfaces as itself. A refused
  `agent.content.read` slice fails the whole read instead of degrading the part
  to `unavailable` — a rate limit is session-wide, not part-specific, and a
  visibly degraded, empty part on a session-wide refusal was the worse answer.
- **A rate-limited COMMAND explains itself** (#109, PR #110). Commands are never
  replayed, so their refusal is the caller's to recover: the error text now says
  that **this attempt** was not applied (the desktop refuses before dispatch,
  so nothing reached its command ledger), that the SAME `commandId` may be
  reused, how long the peer asked us to wait (`retryAfterMs`, when it sent one),
  and the likely cause — a `rateBudgetPerSecond` raised past the peer's
  allowance. The peer's reason, `data` and the error identity are untouched.
- **The derived content tier is capped at the peer's 512/s** (#111, PR #112).
  The content tier scales with `rateBudgetPerSecond` at 8 : 1, but the desktop's
  content-read allowance is 512/s in **both** generations. A shared budget above
  64 therefore derived a tier past a line that never moved — `256` (2.1.7's
  sharing figure) meant a 2,048/s nominal tier, ~1,000/s achieved against the
  512/s allowance, so roughly every other content read was refused. The
  derivation is now clamped at 512/s (~333/s achieved), and the default 32 still
  yields exactly 256/s nominal (200/s achieved).

### Added

- **A failed message's `failure` metadata is projected** (#103, PR #107).
  `cherry_read` and the terminal/timeout/idle wait answers carry
  `failure: {reasonCode, retryable, message}` when the peer attached one. It is
  shape-checked rather than whitelisted, so an unfamiliar reason code is relayed
  instead of silently dropped; the peer's `source` and `context.responseBody`
  are never projected.

### Docs

- The over-budget verdict is documented per generation — <= 2.1.6 closes the
  session with `1011`, >= 2.1.7 refuses one request — in the READMEs, the config
  table, the pacing notes and the e2e checklist (#102, PR #106).

## v0.1.9 (2026-10-21)

Two field annoyances, neither touching the protocol surface.

### Fixed

- **The settings page title no longer truncates** (#95, #97). The nav label and
  the page heading are one string per language (`app.title`), and "Cherry Studio
  互联" overflowed a narrow settings sidebar — the English half was longer
  still. They are now **Cherry 互联** / **Cherry Bridge**. The plugin-list row
  moves with them, because `locale/*.json` `meta.title` is pinned to the same
  dictionary value on purpose.
- **A device caught while it is still dialing is waited for, not refused**
  (#99). The connection pool builds a `DeviceConnection` on first touch and
  dials immediately, while the tools read `connection.state` in the same tick —
  so the first device tool call after an idle period or a restart answered
  `device-unavailable { state: "connecting" }` about a connection that came up
  a moment later, and `cherry_devices` showed the same transient as a row. Both
  device entry points now wait for the in-flight attempt, bounded at
  `DEVICE_SETTLE_WAIT_MS` = 5 s. Only `connecting` is waited on: `offline`
  (parked in its backoff), `disabled` and `identity-mismatch` still answer at
  once, and nothing starts a dial the pool had not already started.

## v0.1.8 (2026-10-20)

The emit-side half of the resume-token story. Every stop point this bridge names
is now one it will accept back, and the documentation says what a missing token
actually means. No protocol or wire change — a token issued by v0.1.7 is still
accepted.

### Fixed

- **A resume token is never emitted past the length the same tool accepts**
  (#76). Both faces judge `MAX_RESUME_TOKEN_CHARS` (4,096) on replay, but the
  emit side did not: a peer answering a truncated page with a position longer
  than ~4,089 characters made the bridge mint a stop point its own parser then
  refused, so the caller held a token that could never be used. The ceiling is
  now enforced on the way OUT as well — the message face's `cursor:` and
  `after:` forms and the list face's `resumeCursor` alike — and an over-long
  stop point is simply not named: `truncated` still says the walk was cut, and
  the remedy then follows the reason. A token of exactly 4,096 characters is
  still emitted.
- **A resume token is never minted from a remainder the same tool refuses**
  (#80). Both parsers reject a remainder `mangledRemainder` calls mangled —
  empty, not equal to its own `.trim()` (leading/trailing whitespace), or
  carrying a control character anywhere — while the message face's emitter
  only filtered `''`. A peer page whose `nextCursor` was `' 4 '` (schema-valid:
  `opaqueId` forbids only lone surrogates) therefore minted `cursor: 4 `, and
  the `after:` anchor had the same hole (`after: m-0 `, from a padded message
  id that the parts walk accepts): a token the tool then refused on replay, so
  the refusal surfaced at the resume call instead of at the answer that
  produced it. The message face now applies the parser's own predicate to BOTH
  the `cursor:` position and the `after:` anchor, so a mangled remainder yields
  no token at all — `truncated` still says the walk was cut, and the remedy
  then follows the reason. The list face already ran that guard.
- **The tool DESCRIPTIONS no longer promise a resume token unconditionally**
  (#82). They are the contract a model reads, and the four list tools promised
  `resumeCursor` for every truncated answer, while `cherry_read` named the wrong
  absent case ("the walk reached the peer's last page" — a truncated walk never
  reaches it). Each description now makes the token conditional on the stop
  point being nameable, and `cherry_read`'s names the exceptions it can name
  (an empty or malformed position, a token past the length ceiling, no anchor
  id) as examples rather than as an exhaustive list.
- **A peer position shaped like our retired v1 token is no longer named either**
  (#85). The parsers have two refusals on a `cursor:` remainder —
  `mangledRemainder` and `looksLikeV1ListToken` — and the emitters mirrored only
  the first, so a position that happened to BE the v1 payload shape was wrapped
  into a token the same tool then refused as "issued by an older plugin
  version". Both guards now live in one pair of helpers (`nameableRemainder` for
  content, `nameablePeerPosition` for positions), and a round-trip test asserts
  that every token these emitters produce is one the parser takes — so a parser
  clause added without mirroring it turns that test red for any probe shape that
  reaches it (a clause no probe reaches would still slip through, which is why
  the table is varied and its non-vacuity is asserted). The `after:` anchor
  deliberately takes only the content one, because that is exactly what its
  parser checks.

### Docs

- **A missing resume token no longer reads as "the history ended"** (#88, #89).
  The emit-side guards mean a TRUNCATED walk can omit the token while older
  messages remain unread, and five docblocks, both READMEs and `AGENTS.md` said
  the opposite (one of them: "absent only when …"). The absence is now stated as
  two cases distinguished by `truncated`, and the remedy follows the reason
  rather than a blanket "raise `limit`": a `limit` stop answers to a wider
  `limit` only where the caller owns that ceiling (`cherry_read`, the four list
  tools), an `aggregate-bytes` stop is the answer's own output budget, a
  `safety-bound` stop is the internal circuit breaker, and a wait answer's
  `limit` or `deadline` stop is continued with `cherry_read`.

## v0.1.7 (2026-10-19)

The resume-token batch. **A resume token issued by v0.1.6 cannot be replayed
after this upgrade** — the list face names it as an older format and the remedy
is to start the walk over; nothing else changes on the wire, and the peer's own
cursor is still passed through verbatim.

### Changed

- The list tools' `resumeCursor` is a **new, compact, checked format** (#70):
  `list:v2:<tool>:<device12>:<filters8>:<checksum8>:<peer position>`. It is 225
  → ~100 characters on the desktop's session cursor and ~150 → ~44 on the
  numeric faces, and its 8-hex checksum covers the peer position — the one field
  no structural check can validate. Measured over 20,000 random single-character
  corruptions of the old token, **28.7% were accepted with a different
  position**, and the desktop answers a position it cannot parse by serving its
  FIRST page, so "continue from here" silently re-read the newest page. Every
  single-character corruption (and every insertion/deletion) is now refused
  locally, before any RPC.
- **The two token faces have disjoint prefixes** (#72): the message face keeps
  `cursor:<peer position>` / `after:<messageId>`; the list face owns `list:`.
  A list `resumeCursor` replayed as `cherry_read`'s `messagesResumeCursor` — and
  a v1 list token, which v0.1.6 issued under `cursor:` — are refused locally,
  naming the mistake, instead of being forwarded to the desktop.
- **Both faces bound the token they accept** (#74): `MAX_RESUME_TOKEN_CHARS`
  (4,096) is enforced by the parser and declared as `maxLength`, so an over-long
  string is refused by its length instead of being carried to the peer.

## v0.1.6 (2026-10-19)

The follow-up to v0.1.5: a list walk's stop point became a resume INPUT, and
the tool declarations now say what their answers actually carry.

### Added

- `feat(tools)`: a truncated `cherry_agents` / `cherry_sessions` /
  `cherry_workspaces` / `cherry_interactions` answer now carries `resumeCursor`,
  and the same tool accepts it back as `cursor` — a history longer than the
  1000-item ceiling is walked in successive answers (`limit` then bounds one
  answer), the round trip the message face already had (#65). The token is bound
  to (method, device, filters): replaying it against another query is refused
  locally, before any RPC, because the peer's page position is opaque and would
  otherwise read the wrong slice silently. The raw peer `nextCursor` is no
  longer exposed; it was never an input.

### Changed

- The tool declarations describe their real answers: `cherry_events` returns
  `{events, nextCursor}` (that cursor is the ack cursor to pass back), and list
  answers report `truncated` / `truncationReason` (#64).
- The install instructions lead with the npm package; the GitHub tag stays as
  the source channel (#59).
- The release documentation names the three steps that fail silently — staged
  publishing, both README pins, and the version-independent release asset
  (#61) — and the `prepublishOnly` description now names `npm pack --dry-run`
  (#63).

## v0.1.5 (2026-10-19)

The 2026-10-19 batch: eight issues merged after the v0.1.4 tag — bounded wait
answers and list walks, a resumable read and a read cache, plus the field
follow-ups the surrounding reviews left behind.

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

- `fix(tools)`: `cherry_wait`'s idle precondition — the `agent.sessions.get`
  that decides whether anything is running — now rides an assembly deadline
  anchored at **tool entry**, so an idle wait on a flapping link is bounded by
  the caller's window instead of waiting out a reconnect plus a replay (5–10 s
  behind a 500 ms window). A spent budget **fails the call with guidance**: the
  run's state is UNKNOWN and a retry is the recovery, rather than returning a
  verdict it never learned. The idle answer's history walk keeps its own anchor
  after the snapshot, so a slow-but-successful snapshot cannot squeeze the walk
  to nothing (#51).
- `fix(http)`: an IPv6 `--host` bind is folded into the trust fence as a
  PARSEABLE authority (`fe80::1` → `[fe80::1]`), so a browser on that LAN bind is
  admitted instead of the deployment silently falling back to loopback only. The
  normalization brackets IPv6 literals once, leaves IPv4/DNS entries untouched,
  and does not relax the fence (the bare spelling is still refused); zone-scoped
  literals still parse to nothing (#9). The `scopeHttpApi` fixture no longer
  hands the injected callback a `webRuntime` payload that no host generation can
  produce.
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
