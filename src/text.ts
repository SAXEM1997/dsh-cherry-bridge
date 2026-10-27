/**
 * Bounded rendering for peer- and payload-controlled text (issue #155).
 *
 * The ONE helper this audit STANDARDISED ON — not the first attempt at the
 * idea: `src/diagnostics.ts`'s `truncateErrorMessage` (the diagnostics error
 * digest) and `src/rpc/jsonRpcClient.ts`'s `bounded()` (the frame-drop
 * warning's classification fields) predate it and stay where they are, for
 * their own callers. #155 is where the rendering rule was stated once and
 * applied to the SIX sites the audit found — four files: pairing's unknown-key
 * warning and stage verdict, the link-recovery line, the two connection error
 * lines, and the JSON-RPC notification-handler line. Each was unbounded for a
 * different "why not" (a 10 KiB payload cap, a hello-advertised field, the
 * 64 KiB record budget), which is exactly how the class of defect recurs: each
 * site answered the question for itself.
 *
 * The rule these helpers establish is stated once, here: bound the text where
 * it is RENDERED (never where it is carried — an error message is a value
 * until a log line or a verdict makes it text), name the amount removed with
 * the `… (+N chars)` marker, and never drop a list ENTRY silently (the
 * `(+K more)` count is explicit).
 *
 * Issue #161 finished the class the same review left behind: the SAME SHAPE at
 * sites #155 did not name — a catch handing an error OBJECT to `console.warn`
 * as its second argument. One renderer now states the answer for all of them,
 * {@link failureText}: the message alone, bounded. The two earlier forms it did
 * NOT absorb — `truncateErrorMessage` (the diagnostics digest) and `bounded()`
 * (the frame-drop path) — are deliberately left alone: each emits a different
 * marker (`…[truncated]`, a bare `…`) and its callers/tests assert that exact
 * text, so folding would change output rather than converge on the rule.
 */

/**
 * Clips `text` into `max` characters, the `… (+N chars)` marker included in
 * the count. `kept` is a fixed point — the number of removed characters sets
 * the marker's own digits — and it is the LARGEST prefix that fits, so a
 * caller's ceiling is used without ever being exceeded.
 *
 * The final guard never ends the kept prefix between a UTF-16 surrogate pair: a
 * clip there would emit a lone surrogate, which is not valid unicode text (the
 * peer's `unicodeText` params face refuses it) and would travel in a
 * user-visible verdict. Dropping one char pays for a marker that can grow by
 * one digit at a 9→10 boundary, and the marker is re-derived from the new
 * dropped count. Pinned by `tests/unit/text.test.ts` — the branch used to be a
 * declared coverage gap while the clip point was private to pairing.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  let kept = max
  for (;;) {
    const next = max - `… (+${text.length - kept} chars)`.length
    if (next === kept) break
    // A room too small for the marker cannot carry both; admit the loss with
    // the bare ellipsis rather than overrun the caller's bound.
    if (next < 0) return '…'.slice(0, max)
    kept = next
  }
  const before = text.charCodeAt(kept - 1)
  const after = text.charCodeAt(kept)
  if (kept > 0 && before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
    kept -= 1
  }
  return `${text.slice(0, kept)}… (+${text.length - kept} chars)`
}

/**
 * Renders `items` as a comma-joined list under `limits.max`, each item clipped
 * to `limits.itemMax` FIRST. When anything is left out the list says so:
 * ` (+K more)` where K is the number of items NOT named.
 *
 * Caller contract: `itemMax <= max`, so the first item always fits and a list
 * carrying a single over-long entry never renders an empty one. The marker
 * rides ON TOP of `limits.max` — it is a count, not an item, so the named text
 * never has to absorb its length. `[]` renders as `''`.
 *
 * Pairing's progress line (`stageHosts`) deliberately does NOT use this helper:
 * it always shows the FIRST host in full even above its own budget, because
 * that host is the run's identity. That is not an oversight, and it is not a
 * reason to weaken the contract here.
 */
export function boundedJoin(
  items: readonly string[],
  limits: { max: number; itemMax: number },
): string {
  const rendered = items.map((item) => clipText(item, limits.itemMax))
  const first = rendered[0]
  if (first === undefined) return ''
  let text = first
  let shown = 1
  for (; shown < rendered.length; shown += 1) {
    // The separator is charged to the same budget as the item: a list that
    // stops two characters early on paper would still refuse an entry it could
    // have named.
    if (text.length + 2 + rendered[shown]!.length > limits.max) break
    text += `, ${rendered[shown]}`
  }
  const omitted = items.length - shown
  return omitted > 0 ? `${text} (+${omitted} more)` : text
}

/**
 * The ceiling for ONE peer- or payload-controlled detail interpolated into a
 * log line: 240 characters, the `… (+N chars)` marker included.
 *
 * It is deliberately NOT the same budget as pairing's `FAILURE_SEGMENT_MAX`,
 * although both read 240: that one bounds the WHOLE `<label>: <detail>`, so
 * the label eats from it and the detail there is at most 218 (a
 * `pairing hello failed` label — 20 characters — plus its `': '`) and often
 * less. Same number, different quantity: this one is the detail alone.
 *
 * Call sites. Two shapes are rendered with it:
 *
 *  - peer-controlled DETAIL through {@link clipText}: `src/connection.ts`'s
 *    protocol-version console.error (the cause is the peer's own hello-echo
 *    text) and transient-failure console.warn (the transport's own message).
 *  - a caught FAILURE through {@link failureText} (issue #161): the JSON-RPC
 *    notification-handler catch (`src/rpc/jsonRpcClient.ts`), the notification
 *    routing and subscription-recovery warnings in `src/index.ts`, the ack and
 *    re-ensure warnings in `src/tools.ts`, the reconnect rejection in
 *    `src/httpApi.ts`, the listener catches in `src/connection.ts`, and the
 *    subscription-close catch in `src/subscriptions.ts`. None of them passes
 *    the error object: the console would print its stack plus every own
 *    property with nothing bounding it.
 *
 * Other bounded faces state their own value beside the line they bound
 * (`UNKNOWN_FIELDS_MAX` / `RECOVERY_SESSIONS_MAX`), because what they bound is
 * a rendered LIST or a joined field, not one detail.
 */
export const LOG_TEXT_MAX = 240

/**
 * Renders ONE caught failure for a log line: the message alone, clipped to
 * {@link LOG_TEXT_MAX}.
 *
 * This is the ONE form a caught failure takes in a log line (issue #161). The
 * old shape — `console.warn(prefix, error)` — handed the console the OBJECT, so
 * the console chose the rendering: the stack plus every own property, with
 * nothing bounding it. These catches are defensive (a listener, a background
 * recovery or a best-effort close whose own failure must not escape), so what
 * an operator needs is the message and nothing else; a non-`Error` value is
 * stringified exactly as the console would have rendered it.
 */
export function failureText(error: unknown): string {
  return clipText(error instanceof Error ? error.message : String(error), LOG_TEXT_MAX)
}
