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
