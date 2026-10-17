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
 * So the gate is exact: BOTH scope keys present is the scope injection, the
 * web-only call's OWN set (`WEB_INJECT_KEYS`) is the web-only injection, and
 * ANYTHING ELSE — one scope key misspelled (PARTIAL), or both of them (a
 * two-key typo) — THROWS rather than routing to either ctx. Both throws can only
 * come from a typo in the plugin's own `INJECT_KEYS`
 * (`src/toolScopeHost.ts`): there are exactly two dynamic `inject` call sites in
 * `src/` and they request disjoint key sets — `['webServer']` (no scope key;
 * issue #7 removed the co-injected `webRuntime`, whose AND semantics had made
 * the callback unreachable on DSH 0.2.1) and the two below.
 *
 * "NEITHER scope key" is deliberately NOT the same test as "the web-only call":
 * classifying by the ABSENCE of the scope keys alone is what let a two-key typo
 * (`['agent','workspaceRegistries']`) pass for the web-only injection, so the
 * misrouted fixture reported the wrong diagnosis (`registerCherryTools` never
 * runs, and the 17 red tests point at the tools rather than at the typo). The
 * web-only set is a positive match against the literal below.
 *
 * The list is deliberately NOT derived from the plugin's `INJECT_KEYS`: a
 * fixture that imported it would agree with any typo. The runtime list itself is
 * pinned separately, against the keys the plugin actually hands to `inject`
 * (`FakeToolHost.injectKeys()`, asserted in `tests/integration/toolScopeHost.test.ts`).
 */
export const SCOPE_INJECT_KEYS = ['agents', 'workspaceRegistry'] as const

/**
 * The web-only dynamic `inject` call site's key set (`registerHttpApi` in
 * `src/httpApi.ts`): the ONLY production call that asks for no scope key. Named
 * here as a literal for the same reason as {@link SCOPE_INJECT_KEYS} — the gate
 * must not agree with a typo by construction. It is pinned to ONE key since
 * issue #7: `webRuntime` was removed in DSH 0.2.1, and asking for it as well
 * turned this injection into an AND gate that never fired.
 */
export const WEB_INJECT_KEYS = ['webServer'] as const

/**
 * Classifies one `inject(deps, cb)` call: `true` ⇒ the scope-capable ctx,
 * `false` ⇒ the web-only ctx, a PARTIAL match or a two-key typo ⇒ a thrown error
 * naming what was received, what was required and which of the two it is.
 */
export function asksForScopeKeys(deps: readonly string[]): boolean {
  const present = SCOPE_INJECT_KEYS.filter((key) => deps.includes(key))
  if (present.length === SCOPE_INJECT_KEYS.length) return true
  if (present.length === 0) {
    const webOnly =
      deps.length === WEB_INJECT_KEYS.length && WEB_INJECT_KEYS.every((key) => deps.includes(key))
    if (webOnly) return false
    throw new Error(
      `inject() asked for NEITHER tool-scope key, and is not the web-only call either: received ` +
        `[${deps.join(', ')}] but the only scope-free call site asks for ` +
        `[${WEB_INJECT_KEYS.join(', ')}]. BOTH scope keys are misspelled — most likely in ` +
        'INJECT_KEYS (src/toolScopeHost.ts); in production that fibre waits forever and registers no tool.',
    )
  }
  throw new Error(
    `inject() asked for a PARTIAL match of the tool-scope keys: received [${deps.join(', ')}] but ` +
      `required [${SCOPE_INJECT_KEYS.join(', ')}]. One of the two is misspelled — most likely in ` +
      'INJECT_KEYS (src/toolScopeHost.ts); in production that fibre waits forever and registers no tool.',
  )
}
