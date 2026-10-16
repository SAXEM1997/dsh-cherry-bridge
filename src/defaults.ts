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
 */
export const DEFAULT_RATE_BUDGET_PER_SECOND = 32

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
 * PARTS_LIST_PAGE_CLAMP and INTERACTIONS_LIST_PAGE_CLAMP are DERIVED, not
 * tuned: the peer may inline up to 4,096 CHARACTERS of text per field (its
 * `INLINE_TEXT_LIMIT`; ≈3 UTF-8 bytes per CJK character) plus a ~0.5 KiB
 * envelope per item, and an interaction record additionally carries a
 * 2,048-character summary. Dividing the 64 KiB record budget (minus a 2 KiB
 * page/margin overhead) by each list's worst-case item gives the clamp.
 *
 * LIST_PAGE_CLAMP is pragmatic, not provable: message/session/agent records
 * carry unbounded `partIds`/title fields, so no count alone guarantees a
 * sub-budget record. 16 covers every observed record with ≈4× headroom; the
 * complete fix is byte-budgeted paging on the server (tracked upstream).
 */

/** Usable bytes of one wire record after page/margin overhead. */
const RECORD_BUDGET_BYTES = 65_536 - 2_048

/** Worst-case UTF-8 bytes of one inline text field (4,096 CJK characters). */
const INLINE_FIELD_BYTES = 4_096 * 3

/** Per-item envelope: ids, revisions, kind/state enums, JSON punctuation. */
const ITEM_ENVELOPE_BYTES = 512

/** Parts per parts.list page: one inline content field per part. */
export const PARTS_LIST_PAGE_CLAMP = Math.floor(RECORD_BUDGET_BYTES / (INLINE_FIELD_BYTES + ITEM_ENVELOPE_BYTES))

/** Interactions per interactions.list page: inline input + inline summary. */
export const INTERACTIONS_LIST_PAGE_CLAMP = Math.floor(
  RECORD_BUDGET_BYTES / (INLINE_FIELD_BYTES + 2_048 * 3 + ITEM_ENVELOPE_BYTES),
)

/** Items per every other aggregated list page (agents/sessions/messages). */
export const LIST_PAGE_CLAMP = 16
