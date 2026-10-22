/**
 * The cross-cutting default constants, in ONE place.
 *
 * These two values are contractual (spec §3.4 / §3.5) and are consumed by three
 * different modules: the assembly's config resolver (`index.ts`), the connection
 * layer's rate limiter, and the subscription layer's cache budget. They used to
 * be declared privately in each, which is a drift surface with a silent failure
 * mode: change one copy and the assembly's documented default stops matching the
 * behaviour a layer actually applies, with no test able to see the disagreement.
 *
 * IMPORT CYCLE RULE: this module imports NOTHING from `index.ts`,
 * `connection.ts` or `subscriptions.ts`. It is a leaf, so all three can depend
 * on it directly. `index.ts` re-exports both names, keeping the public surface
 * (and the contract test that pins it) stable.
 */

/**
 * The second-level smoothed request budget: admissions per second for business
 * RPCs (spec §3.4). Injectable through plugin config; this is the fallback.
 *
 * This is the SHARED tier: it covers every business RPC EXCEPT the content-read
 * tier below (see {@link DEFAULT_CONTENT_READ_BUDGET_PER_SECOND}).
 *
 * WHY 32: the desktop's allowance for "other" RPCs is 64/s through 2.1.6 and
 * 256/s from 2.1.7 (`RemoteAccessService.ts`; the official client paces them at
 * 40/s, `DesktopSession.ts:36-37`). What an over-budget request does also
 * changed: through 2.1.6 it closes the WHOLE session (1011), while 2.1.7 (PR
 * #21687) refuses that one request (`RATE_LIMITED` + `retryAfterMs`) and keeps
 * the session. The generations cannot be told apart before one answers, so the
 * default is sized for the older, harsher peer: 32 is half of 64 and an eighth
 * of 256, leaving room for the housekeeping traffic that shares the socket
 * (hello/authenticate/ping/refresh bypass pacing by design) and for arrival
 * compression between our admission times and the peer's arrival times.
 *
 * SOURCES (neither is in this repository): the desktop lines are
 * `_research/cherry-studio` @ v2.1.6 (90b234e) and CherryHQ/cherry-studio @
 * v2.1.7; the official-client lines are CherryHQ/cherry-studio-app @ v0.4.0,
 * both read on 2026-10-22 (issue #102).
 */
export const DEFAULT_RATE_BUDGET_PER_SECOND = 32

/**
 * The second-level smoothed request budget for the CONTENT-READ tier, which
 * carries exactly one method: `agent.content.read` (see `classifyRateTier` in
 * `connection.ts` — the classification is exact-match, not a prefix).
 *
 * WHY A SEPARATE TIER: an externalized part is read as a walk of
 * `agent.content.read` slices, so this one method carries the whole throughput
 * of every large reply. Cherry Studio >= 2.1.6 externalizes every part over
 * 4,096 characters, which makes long replies the common case, while the desktop
 * paces content reads against a 512/s allowance of their own
 * (`RemoteAccessService.ts:223-225`) and the official client issues them at
 * 480/s (`DesktopSession.ts:33-37`). Pacing them with the 32/s shared tier
 * bound a multi-slice walk to ~670 KiB/s and queued it behind unrelated RPCs;
 * 256 is half the 512/s content allowance in BOTH desktop generations (the
 * shared-tier allowance changed in 2.1.7; this one did not) and lifts the bound
 * to the multi-MiB/s range of the official client while leaving the desktop a
 * session-sized headroom.
 *
 * NOT a plugin-config key: the two tiers derive from ONE injected shared budget
 * at the ratio below, so an operator who lowers `rateBudgetPerSecond` lowers
 * both. A second config key is deliberately deferred until there is a field
 * report that needs one.
 *
 * THE MARGINS ARE A DEFAULT-INJECTION CLAIM: the 2× headroom above holds at
 * the default injection (32/s), where this tier is exactly 256/s. An injected
 * budget consumes BOTH tiers' headroom in proportion — at 64/s the shared tier
 * sits on the ≤2.1.6 line (the harsher generation, where overrun still closes
 * the session) and this tier derives to 512/s, i.e. nominal saturation of both
 * allowances. The limiter's integer gap means the ACHIEVED rate stays below the
 * nominal one in that case (≤ 334/s on this tier, 55.6/s on the shared one; see
 * `SecondWindowRateLimiter` in `connection.ts`), which is margin by accident
 * rather than by design.
 */
export const DEFAULT_CONTENT_READ_BUDGET_PER_SECOND = 256

/**
 * How long one READ may wait for a reconnected link before it reports the
 * transport loss to its caller (`DeviceConnectionOptions.transportRetryWaitMs`).
 *
 * It lives here because it is the caller-facing half of issue #12: a read whose
 * link dies in flight is replayed on the next connection, and this is how long
 * the caller is made to wait for that to happen. A bound long enough to outlast
 * the reconnect backoff turns a transient blip into a call that outlives its
 * own patience — the very complaint the classified error exists to answer.
 */
export const DEFAULT_TRANSPORT_RETRY_WAIT_MS = 5_000

/**
 * The longest a READ may wait for the peer's rate window to clear before its
 * ONE bounded replay (`RATE_LIMITED` + `retryAfterMs`, desktop >= 2.1.7).
 *
 * Why the peer's own window and not a separate budget: the desktop derives
 * `retryAfterMs` from its 1 s accounting window, so a larger value cannot come
 * from the peer, and waiting longer would hold a tool call for no reason. The
 * caller's own deadline (`JsonRpcRequestOptions.deadline`) still clamps it, and
 * a wait answer's `AssemblyDeadline` is what makes a refusal near the budget a
 * `'deadline'` stop rather than an overrun. A COMMAND never takes this wait: its
 * refusal is a verdict on that arrival, and commands are never replayed.
 */
export const RATE_LIMIT_MAX_WAIT_MS = 1_000

/**
 * How long a DEVICE TOOL waits for an establishment attempt that is already in
 * flight (`state === 'connecting'`) before judging the device.
 *
 * WHY THIS EXISTS: the connection pool builds a `DeviceConnection` on FIRST
 * TOUCH and that constructor dials immediately, so every tool called in the
 * same tick as the first touch — and every tool called during a reconnect —
 * observed `connecting` and answered `device-unavailable` about a connection
 * that comes up a moment later. The state is a transient, not a verdict.
 *
 * It is deliberately NOT a reconnect budget: an `offline` device is parked in
 * its backoff, where waiting cannot change anything, so the tools answer at
 * once. Five seconds is ~15x a LAN dial plus handshake; a bound longer than
 * that only delays the unavoidable answer, and the tool call is the caller's
 * unit of patience.
 */
export const DEVICE_SETTLE_WAIT_MS = 5_000

/** 2 MiB of event text cached per session (spec §3.5). */
export const DEFAULT_PER_SESSION_CACHE_BYTES = 2 * 1024 * 1024

/**
 * Byte-safe per-page clamps for the aggregated `agent.*.list` walks.
 *
 * WHY THESE EXIST: every JSON-RPC record on the wire is hard-capped at
 * `remoteLimits.recordBytes` = 65,536 bytes — the transport refuses a larger
 * record by aborting the connection, so every in-flight request then fails
 * with "JSON-RPC channel closed". The Cherry Studio desktop's `pageOf`
 * (src/main/services/remoteAccess/agentQueries.ts) slices pages by COUNT
 * alone, so a client that asks for `pageItems` (100) fat parts receives a
 * record the transport must kill: reading a complex session (many parts per
 * message, or many messages) became a deterministic connection reset before
 * these clamps.
 *
 * PARTS_LIST_PAGE_CLAMP and INTERACTIONS_LIST_PAGE_CLAMP are DERIVED from the
 * strict UTF-8 worst case (4 bytes per character — emoji and CJK extension
 * planes), not tuned: the peer may inline up to 4,096 CHARACTERS of text per
 * field (its `INLINE_TEXT_LIMIT`), an interaction record additionally carries
 * a 2,048-character summary, and each item adds an envelope (ids are
 * schema-capped at 256 characters each — roughly 1 KiB across an item's id
 * fields, which the page margin below absorbs). Dividing the 64 KiB record
 * budget (minus a 2 KiB page/margin overhead) by each list's worst-case item
 * gives the clamp.
 *
 * LIST_PAGE_CLAMP is pragmatic, not provable: message/session/agent records
 * carry large schema-bounded fields (`partIds` up to 4,096 entries, titles up
 * to 4,096 characters), so no count is provably sub-budget. 16 covers every
 * observed record with headroom. The server-side fix has landed upstream
 * (byte-budgeted pages: CherryHQ/cherry-studio#21852 closed by #21854), but
 * the clamps stay: deployed peers (2.1.6 and earlier) still page by count
 * alone.
 */

/** Usable bytes of one wire record after page/margin overhead. */
const RECORD_BUDGET_BYTES = 65_536 - 2_048

/** Strict worst-case UTF-8 bytes of one inline character (astral planes). */
const CHAR_BYTES = 4

/** Per-item envelope: ids (schema-capped), revisions, enums, punctuation. */
const ITEM_ENVELOPE_BYTES = 512

/** Parts per parts.list page: one inline content field per part. */
export const PARTS_LIST_PAGE_CLAMP = Math.floor(
  RECORD_BUDGET_BYTES / (4_096 * CHAR_BYTES + ITEM_ENVELOPE_BYTES),
)

/** Interactions per interactions.list page: inline input + inline summary. */
export const INTERACTIONS_LIST_PAGE_CLAMP = Math.floor(
  RECORD_BUDGET_BYTES / (4_096 * CHAR_BYTES + 2_048 * CHAR_BYTES + ITEM_ENVELOPE_BYTES),
)

/** Items per every other aggregated list page (agents/sessions/messages). */
export const LIST_PAGE_CLAMP = 16

/**
 * Hard ceiling on ONE resume token (issues #70 and #74), in characters.
 *
 * BOTH faces take a token back from the caller — `cursor` on the four list
 * tools, `messagesResumeCursor` on `cherry_read` — and both tail it with a
 * peer-supplied position whose length we do not control: the desktop's session
 * cursor is `entity:<orderKey>:<uuid>` (~57 characters), a message cursor
 * `<ms>:<uuid>`, the numeric `pageOf` faces a handful of digits, and a future
 * desktop may use something longer — but nothing legitimate comes near this.
 * The bound exists so a hand-built or model-mangled string is refused by a
 * BOUND instead of being split, hashed and carried to the peer, and so both
 * parameters can declare `maxLength` honestly. ONE number for both faces: it
 * bounds caller INPUT, not what a token means.
 *
 * The emit side enforces it too (#76): a stop point whose token would exceed
 * this is not named at all, because a token this tool refuses to replay is
 * worse than no token — `truncated` still says the walk was cut. One number,
 * judged in both directions.
 */
export const MAX_RESUME_TOKEN_CHARS = 4_096
