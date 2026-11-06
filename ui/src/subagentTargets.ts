/**
 * #261 — the ONE rule that turns "candidate state × stored value × form draft"
 * into "what the control offers, and what it has selected".
 *
 * ## Why this is a module and not a few lines inside the panel
 *
 * A `<select>` whose `value` has no matching `<option>` renders BLANK (or the
 * first option) while React's state still holds the right value. That is the
 * failure this file exists to make impossible: a test that only inspects the
 * request body a save sends is green against a control that shows the operator
 * nothing. So the rule lives where it can be pinned without a DOM, and #262's
 * panel only CONSUMES it.
 *
 * ## The one invariant
 *
 * > `selected` is always the `value` of one of the returned `options`.
 *
 * It holds for EVERY input combination, which is why the empty draft gets an
 * option of its own: `''` is a value the control can hold, so `''` must be a
 * value the control offers. That is the same bug in its smallest form — a
 * pristine form whose select shows the first agent's name while nothing is
 * saved.
 *
 * ## Labels are INJECTED, never produced here
 *
 * This module emits no user-visible string. `ui/AGENTS.md` makes `i18n.ts` the
 * only place Chinese literals live in `ui/src/**` (a source-level guard scans
 * every file), and the panel is where `t()` is available — so the caller passes
 * the three labels in. The ticket's draft signature had the module build
 * `当前值（未知）：<draft>` itself; that cannot coexist with the same ticket's
 * "模块自己不产出用户可见字符串", and the label rule wins because it is
 * enforced by a test.
 *
 * ## What this module deliberately does NOT do
 *
 *  - It does not fetch, cache or retry candidates (#260 owns the endpoint, #262
 *    owns the refresh).
 *  - It does not decide whether the field is editable, nor whether a save is
 *    allowed. It answers "options and selection", nothing else.
 *  - It does not dedupe candidates: a peer that lists the same id twice gets two
 *    options, because inventing a merge rule here would hide a peer fault the
 *    operator can see.
 */

/**
 * The sentinel value of the trailing "type it by hand" option.
 *
 * NUL-prefixed to make a collision with a real id implausible — NOT impossible,
 * and the difference matters. The protocol's id type is
 * `opaqueId = unicodeText.min(1).max(256)`, whose only character rule forbids
 * LONE SURROGATES, so a peer may legitimately send a NUL. (An earlier comment
 * here claimed a NUL "cannot appear in JSON or a URL query"; both encodings
 * carry one — `\u0000` and `%00` — so that claim was simply wrong, and a
 * standards review caught it.)
 *
 * The guarantee therefore comes from the RESERVED-VALUE FILTER below, not from
 * this constant: a candidate naming the sentinel is dropped, so even a colliding
 * id cannot produce two options sharing one value. The NUL only makes that drop
 * cost nothing in practice.
 *
 * It is a CONSTANT rather than a sentence — the panel translates the LABEL, and
 * this value must never be rendered.
 */
export const MANUAL_TARGET_VALUE = '\u0000manual'

/** One selectable candidate, as the endpoint (#260) named it. */
export interface TargetCandidate {
  readonly value: string
  readonly label: string
}

/**
 * The candidate source's state, as the panel holds it.
 *
 * `unavailable` carries the endpoint's `problem` so the panel can render the
 * sentence that explains WHY the list is missing — the three states are not
 * interchangeable to an operator even though this module treats two of them
 * identically.
 */
export type TargetCandidates =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly problem: TargetProblem }
  | { readonly kind: 'ready'; readonly items: readonly TargetCandidate[] }

/**
 * The `problem` body `GET /subagent/targets` answers with (#260).
 *
 * `code` is a plain `string` on purpose, NOT the endpoint's closed set spelled
 * out as a union: the page must survive a NEWER server that answers a code this
 * build has never heard of (it renders its fallback sentence), and a union here
 * would turn that into a compile error in a consumer that cannot do anything
 * about it. `message` is the sentence the page shows; the remaining fields
 * differ per code (`known`, `candidates`, `state`, `timeoutMs`, …) and this
 * module passes them through untouched.
 */
export interface TargetProblem {
  readonly code: string
  readonly message: string
  readonly [field: string]: unknown
}

/**
 * The three strings the caller must supply.
 *
 * Three, not two: the empty draft needs an option too (see the invariant), and
 * its label is not "current value (unknown)" — that option would read as a
 * value the form has, when the form has none.
 */
export interface TargetLabels {
  /** Label for an injected option whose value is a stored/drafted id no candidate names. */
  unknown(value: string): string
  /** Label for the trailing manual-entry sentinel. */
  manual: string
  /** Label for the empty draft — the "nothing chosen yet" option. */
  empty: string
}

/** What the control renders. */
export interface TargetOption {
  readonly value: string
  readonly label: string
  /** An injected option standing for a value the candidate list does not name. */
  readonly unknown?: true
  /** The "nothing chosen yet" option; only ever present when the effective value is empty. */
  readonly empty?: true
  /** The trailing manual-entry sentinel. Always the LAST option. */
  readonly manual?: true
}

/** The control's whole input: what is stored, what is typed, what is available. */
export interface TargetFieldState {
  /** The value in the saved document — it may be a prefix, or an agent that is gone. */
  readonly current: string
  /** The form's own value; equal to `current` means "untouched". */
  readonly draft: string
  readonly candidates: TargetCandidates
}

/** The control's whole output. */
export interface TargetOptions {
  readonly options: readonly TargetOption[]
  readonly selected: string
}

/**
 * The effective value the control holds.
 *
 * A draft that is EMPTY is not a decision to clear the field: the panel renders
 * this control beside a text input for the same value, so an empty draft while
 * the document holds something is the ordinary "not touched here" state. Falling
 * back to `current` is what keeps a save from silently erasing it — and what
 * keeps the selection non-blank, which is the invariant's other half.
 */
function effectiveValue(field: TargetFieldState): string {
  return field.draft === '' ? field.current : field.draft
}

/**
 * The options and the selection for one target field.
 *
 * The order is fixed so a test can assert it whole:
 *
 *  1. the empty option, when the effective value is empty;
 *  2. the candidates, when there are any (verbatim, in the peer's order);
 *  3. the injected `unknown` option, when the effective value is non-empty and
 *     no candidate names it — this is the ONE line that makes a stored-but-gone
 *     id selectable instead of invisible;
 *  4. the manual sentinel, ALWAYS last.
 *
 * ## Two values are RESERVED, and a candidate claiming one is dropped
 *
 * `''` is the control's "nothing chosen" value and {@link MANUAL_TARGET_VALUE}
 * is its "type it by hand" value. A candidate naming either one cannot be shown
 * beside the option that owns that value without producing TWO options with one
 * value — the browser then picks whichever comes first, and "which option is
 * selected" stops being answerable. That is the same class of defect this module
 * exists to prevent, one level down.
 *
 * Dropping is the honest resolution rather than a merge: `''` is not an id at
 * all, and the sentinel carries a NUL no REAL agent or workspace id has ever
 * been seen to carry. Inventing a display for either would put a row in front of
 * the operator that cannot mean anything. The alternative — letting the
 * duplicate through — was the first draft, and a review found it.
 *
 * Note the honest scope of the sentinel's claim: the protocol's `opaqueId` is
 * `unicodeText.min(1).max(256)`, which does NOT forbid a NUL, so a hostile or
 * broken peer really could name the sentinel. THIS FILTER is what keeps the
 * invariant true in that case; the constant's NUL only makes it a curiosity
 * rather than a collision the operator would ever meet.
 */
export function targetOptions(field: TargetFieldState, labels: TargetLabels): TargetOptions {
  const selected = effectiveValue(field)
  const candidates = (field.candidates.kind === 'ready' ? field.candidates.items : []).filter(
    (candidate) => candidate.value !== '' && candidate.value !== MANUAL_TARGET_VALUE,
  )
  const options: TargetOption[] = []

  if (selected === '') {
    // The form holds no value, so the control must be able to hold no value.
    options.push({ value: '', label: labels.empty, empty: true })
  }

  for (const candidate of candidates) {
    options.push({ value: candidate.value, label: candidate.label })
  }

  const named = candidates.some((candidate) => candidate.value === selected)
  // The sentinel is its own option, so a draft that IS the sentinel is already
  // named — injecting an `unknown` twin beside it would be two options with one
  // value, and the browser would pick the first.
  if (selected !== '' && !named && selected !== MANUAL_TARGET_VALUE) {
    options.push({ value: selected, label: labels.unknown(selected), unknown: true })
  }

  options.push({ value: MANUAL_TARGET_VALUE, label: labels.manual, manual: true })

  return { options, selected }
}
