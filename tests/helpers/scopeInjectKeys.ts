/**
 * The key set the tool-scope subsystem must ask the host for, and the
 * exact-match gate every assembly fixture shares.
 *
 * The fixtures used to accept EITHER key (`deps.includes('agents') ||
 * deps.includes('workspaceRegistry')`). Under `||` a misspelled key is
 * invisible: the fixture still delivers the scope-capable ctx, every suite stays
 * green, and in production that fibre waits for a service that never arrives —
 * the plugin registers NONE of its 14 tools and nothing turns red.
 *
 * So the gate is exact: BOTH keys present is the scope injection, NEITHER is the
 * web-only injection, and a PARTIAL match THROWS rather than routing to either
 * ctx. A partial match can only come from a typo in the plugin's own
 * `INJECT_KEYS` (`src/toolScopeHost.ts`): there are exactly two dynamic `inject`
 * call sites in `src/` and they request disjoint key sets —
 * `['webServer','webRuntime']` (no scope key) and the two below.
 *
 * The list is deliberately NOT derived from the plugin's `INJECT_KEYS`: a
 * fixture that imported it would agree with any typo. The runtime list itself is
 * pinned separately, against the keys the plugin actually hands to `inject`
 * (`FakeToolHost.injectKeys()`, asserted in `tests/integration/toolScopeHost.test.ts`).
 */
export const SCOPE_INJECT_KEYS = ['agents', 'workspaceRegistry'] as const

/**
 * Classifies one `inject(deps, cb)` call: `true` ⇒ the scope-capable ctx,
 * `false` ⇒ the web-only ctx, a PARTIAL match ⇒ a thrown error naming what was
 * received and what was required.
 */
export function asksForScopeKeys(deps: readonly string[]): boolean {
  const present = SCOPE_INJECT_KEYS.filter((key) => deps.includes(key))
  if (present.length === SCOPE_INJECT_KEYS.length) return true
  if (present.length === 0) return false
  throw new Error(
    `inject() asked for a PARTIAL match of the tool-scope keys: received [${deps.join(', ')}] but ` +
      `required [${SCOPE_INJECT_KEYS.join(', ')}]. One of the two is misspelled — most likely in ` +
      'INJECT_KEYS (src/toolScopeHost.ts); in production that fibre waits forever and registers no tool.',
  )
}
