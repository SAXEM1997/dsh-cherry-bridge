/**
 * #261 — `ui/src/subagentTargets.ts`, the candidate-state → options rule.
 *
 * PURE: no DOM, no fetch, no React. The whole point of the module is that this
 * rule can be pinned here, so #262's panel only consumes it — a `<select>` whose
 * `value` has no matching `<option>` renders blank while the form state is
 * correct, and a panel test that only checks the saved body cannot see that.
 *
 * Labels are injected ASCII on purpose. The module must emit no user-visible
 * string of its own (`i18n.ts` is the only place Chinese lives in `ui/src/**`),
 * so a case that asserted Chinese would prove the opposite of what it claims;
 * these distinctive English labels make "the caller's label reached the option"
 * observable.
 */
import { describe, expect, it } from 'vitest'
import {
  MANUAL_TARGET_VALUE,
  targetOptions,
} from '../../ui/src/subagentTargets'
import type {
  TargetCandidate,
  TargetCandidates,
  TargetFieldState,
  TargetLabels,
  TargetProblem,
} from '../../ui/src/subagentTargets'

const LABELS: TargetLabels = {
  unknown: (value) => `unknown:${value}`,
  manual: 'type-it-myself',
  empty: 'nothing-chosen',
}

const A: TargetCandidate = { value: 'agent-a', label: 'Agent A' }
const B: TargetCandidate = { value: 'agent-b', label: 'Agent B' }
const READY: TargetCandidates = { kind: 'ready', items: [A, B] }
const LOADING: TargetCandidates = { kind: 'loading' }
const PROBLEM: TargetProblem = { code: 'device-unavailable', message: 'device "d" is offline, not connected' }
const UNAVAILABLE: TargetCandidates = { kind: 'unavailable', problem: PROBLEM }

function field(overrides: Partial<TargetFieldState> = {}): TargetFieldState {
  return { current: '', draft: '', candidates: READY, ...overrides }
}

/** The values the control offers, in order. */
function values(state: TargetFieldState): string[] {
  return targetOptions(state, LABELS).options.map((option) => option.value)
}

// ---------------------------------------------------------------------------
// ① the three candidate states
// ---------------------------------------------------------------------------

describe('① the three candidate states', () => {
  it('①a `ready` that names the draft offers the candidates verbatim', () => {
    const answer = targetOptions(field({ draft: 'agent-b' }), LABELS)

    expect(answer.selected).toBe('agent-b')
    expect(answer.options).toEqual([
      { value: 'agent-a', label: 'Agent A' },
      { value: 'agent-b', label: 'Agent B' },
      { value: MANUAL_TARGET_VALUE, label: 'type-it-myself', manual: true },
    ])
  })

  it('①b `ready` that does NOT name the draft appends the injected unknown option', () => {
    const answer = targetOptions(field({ draft: 'agent-gone' }), LABELS)

    expect(answer.selected).toBe('agent-gone')
    // AFTER the candidates, before the sentinel — the ticket's row 2 order.
    expect(answer.options).toEqual([
      { value: 'agent-a', label: 'Agent A' },
      { value: 'agent-b', label: 'Agent B' },
      { value: 'agent-gone', label: 'unknown:agent-gone', unknown: true },
      { value: MANUAL_TARGET_VALUE, label: 'type-it-myself', manual: true },
    ])
  })

  it('①c `loading` offers ONLY the injected option, so the current value stays selectable', () => {
    const answer = targetOptions(field({ draft: 'agent-a', candidates: LOADING }), LABELS)

    expect(answer.selected).toBe('agent-a')
    expect(answer.options).toEqual([
      { value: 'agent-a', label: 'unknown:agent-a', unknown: true },
      { value: MANUAL_TARGET_VALUE, label: 'type-it-myself', manual: true },
    ])
  })

  it('①d `unavailable` behaves like `loading` — and the problem rides through the state untouched', () => {
    const state = field({ draft: 'agent-a', candidates: UNAVAILABLE })
    const answer = targetOptions(state, LABELS)

    expect(answer.options).toEqual([
      { value: 'agent-a', label: 'unknown:agent-a', unknown: true },
      { value: MANUAL_TARGET_VALUE, label: 'type-it-myself', manual: true },
    ])
    // The module never reads the problem, so it must never rewrite it: #262
    // renders `problem.message` beside the field, and a module that dropped or
    // re-created the object would silently blank that hint.
    expect(state.candidates).toBe(UNAVAILABLE)
    if (state.candidates.kind === 'unavailable') expect(state.candidates.problem).toBe(PROBLEM)
  })
})

// ---------------------------------------------------------------------------
// ② the five boundaries the ticket names
// ---------------------------------------------------------------------------

describe('② the boundaries', () => {
  it('②a a non-empty draft decides the selection, whatever the candidates say', () => {
    for (const candidates of [READY, LOADING, UNAVAILABLE, { kind: 'ready', items: [] } as TargetCandidates]) {
      for (const current of ['', 'agent-a', 'agent-gone']) {
        const answer = targetOptions({ current, draft: 'agent-zzz', candidates }, LABELS)
        expect(answer.selected).toBe('agent-zzz')
      }
    }
  })

  it('②b an EMPTY draft with a stored value falls back to it instead of clearing the field', () => {
    // The panel renders this select beside a text input for the same value, so
    // an empty draft is "not touched here", not "erase it". Selecting '' would
    // make the next save drop a configured target.
    for (const candidates of [READY, LOADING, UNAVAILABLE]) {
      const answer = targetOptions({ current: 'agent-a', draft: '', candidates }, LABELS)
      expect(answer.selected).toBe('agent-a')
    }
  })

  it('②c a draft that IS the manual sentinel selects the sentinel, and only one option carries it', () => {
    const answer = targetOptions(field({ draft: MANUAL_TARGET_VALUE }), LABELS)

    expect(answer.selected).toBe(MANUAL_TARGET_VALUE)
    expect(answer.options.filter((option) => option.value === MANUAL_TARGET_VALUE)).toHaveLength(1)
    // …and it is not ALSO injected as an unknown: two options with one value
    // would leave the browser free to pick the first, which is the bug again.
    expect(answer.options.some((option) => option.unknown === true)).toBe(false)
  })

  it('②d the draft is never rewritten to a candidate that is not the draft', () => {
    // The tempting "fix" is to snap the selection to the first candidate when
    // the draft is missing from the list. That silently changes what a save
    // would send, and it is what the operator would NOT have chosen.
    for (const draft of ['agent-gone', 'agent-zzz', MANUAL_TARGET_VALUE]) {
      for (const candidates of [READY, LOADING, UNAVAILABLE]) {
        const answer = targetOptions({ current: 'agent-a', draft, candidates }, LABELS)
        expect(answer.selected).toBe(draft)
        expect(answer.options.some((option) => option.value === draft)).toBe(true)
      }
    }
  })

  it('②e a stored PREFIX with only the full id among the candidates keeps the prefix selectable', () => {
    // The real case: the document says `desk` (a unique prefix, which the device
    // selector accepts) while the candidate list names `desk-1`.
    const answer = targetOptions(
      { current: 'desk', draft: '', candidates: { kind: 'ready', items: [{ value: 'desk-1', label: 'Desk 1' }] } },
      LABELS,
    )

    expect(answer.selected).toBe('desk')
    expect(answer.options.map((option) => option.value)).toEqual(['desk-1', 'desk', MANUAL_TARGET_VALUE])
    expect(answer.options.find((option) => option.value === 'desk')).toMatchObject({
      label: 'unknown:desk',
      unknown: true,
    })
  })
})

// ---------------------------------------------------------------------------
// ③ the empty draft: the same bug in its smallest form
// ---------------------------------------------------------------------------

describe('③ the empty draft', () => {
  it('③a an empty effective value is an OPTION, not just an empty selection', () => {
    // Without this, a pristine form renders a `<select value="">` whose options
    // all carry real ids: the browser shows the first agent's name while nothing
    // is configured — and the operator saves what the screen appeared to say.
    const answer = targetOptions(field(), LABELS)

    expect(answer.selected).toBe('')
    expect(answer.options[0]).toEqual({ value: '', label: 'nothing-chosen', empty: true })
    expect(answer.options.some((option) => option.value === '')).toBe(true)
  })

  it('③b the empty option comes FIRST, so it reads as a prompt rather than a value', () => {
    const answer = targetOptions(field(), LABELS)
    expect(answer.options.map((option) => option.value)).toEqual([
      '',
      'agent-a',
      'agent-b',
      MANUAL_TARGET_VALUE,
    ])
  })

  it('③c no candidates and nothing stored leaves the empty option and the sentinel', () => {
    const answer = targetOptions({ current: '', draft: '', candidates: LOADING }, LABELS)

    expect(answer.selected).toBe('')
    expect(answer.options).toEqual([
      { value: '', label: 'nothing-chosen', empty: true },
      { value: MANUAL_TARGET_VALUE, label: 'type-it-myself', manual: true },
    ])
  })
})

// ---------------------------------------------------------------------------
// ④ the invariant, over every combination
// ---------------------------------------------------------------------------

describe('④ the one invariant', () => {
  const CANDIDATE_STATES: TargetCandidates[] = [
    LOADING,
    UNAVAILABLE,
    { kind: 'ready', items: [] },
    { kind: 'ready', items: [A] },
    { kind: 'ready', items: [A, B] },
  ]
  const VALUES = ['', 'agent-a', 'agent-b', 'agent-zzz', MANUAL_TARGET_VALUE]

  it('④a `selected` is always the value of one of the options', () => {
    // The failure this catches: a `<select>` renders BLANK for a value it cannot
    // match, while the form state still holds the right value — so every
    // request-body assertion in the suite stays green and the operator sees an
    // empty control.
    let checked = 0
    for (const candidates of CANDIDATE_STATES) {
      for (const current of VALUES) {
        for (const draft of VALUES) {
          const answer = targetOptions({ current, draft, candidates }, LABELS)
          expect(
            answer.options.some((option) => option.value === answer.selected),
            `no option for selected=${JSON.stringify(answer.selected)} ` +
              `(current=${JSON.stringify(current)}, draft=${JSON.stringify(draft)}, ` +
              `candidates=${candidates.kind}${candidates.kind === 'ready' ? `/${candidates.items.length}` : ''})`,
          ).toBe(true)
          checked += 1
        }
      }
    }
    // The table really was walked, so a shrunken loop cannot pass silently.
    expect(checked).toBe(CANDIDATE_STATES.length * VALUES.length * VALUES.length)
  })

  it('④b the manual sentinel is ALWAYS the last option, and exactly one of them', () => {
    for (const candidates of CANDIDATE_STATES) {
      for (const current of VALUES) {
        for (const draft of VALUES) {
          const { options } = targetOptions({ current, draft, candidates }, LABELS)
          const manuals = options.filter((option) => option.manual === true)
          expect(manuals).toHaveLength(1)
          expect(options[options.length - 1]).toBe(manuals[0])
        }
      }
    }
  })

  it('④c option values are unique, so the browser has no tie to break', () => {
    // Two options with one value is the same class of defect: the control shows
    // whichever the browser picks, and the operator cannot tell which one they
    // selected. The candidate list is not deduped (a peer listing an id twice is
    // a peer fault), but nothing this module INJECTS may collide with it.
    for (const candidates of CANDIDATE_STATES) {
      for (const current of VALUES) {
        for (const draft of VALUES) {
          const { options } = targetOptions({ current, draft, candidates }, LABELS)
          const injected = options.filter((option) => option.unknown === true || option.empty === true || option.manual === true)
          const injectedValues = injected.map((option) => option.value)
          expect(new Set(injectedValues).size).toBe(injectedValues.length)
          // An injected option never repeats a value a candidate already names.
          if (candidates.kind === 'ready') {
            for (const option of injected) {
              expect(candidates.items.some((item) => item.value === option.value)).toBe(false)
            }
          }
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// ⑤ the labels come from the caller
// ---------------------------------------------------------------------------

describe('⑤ the labels are the caller’s', () => {
  it('⑤a every emitted label is one the caller supplied', () => {
    const seen: string[] = []
    const other: TargetLabels = {
      unknown: (value) => {
        seen.push(value)
        return `<${value}>`
      },
      manual: 'MANUAL-HERE',
      empty: 'EMPTY-HERE',
    }

    const unknownAnswer = targetOptions(field({ draft: 'agent-gone' }), other)
    const emptyAnswer = targetOptions(field(), other)

    expect(seen).toEqual(['agent-gone'])
    expect(unknownAnswer.options.map((option) => option.label)).toEqual([
      'Agent A',
      'Agent B',
      '<agent-gone>',
      'MANUAL-HERE',
    ])
    expect(emptyAnswer.options.map((option) => option.label)).toEqual(['EMPTY-HERE', 'Agent A', 'Agent B', 'MANUAL-HERE'])
  })

  it('⑤b the manual sentinel cannot collide with an id that could reach this field', () => {
    // A real id travels through JSON and a URL query, so it cannot carry a NUL.
    expect(MANUAL_TARGET_VALUE).toContain('\u0000')
    expect(MANUAL_TARGET_VALUE).not.toBe('')
  })
})
