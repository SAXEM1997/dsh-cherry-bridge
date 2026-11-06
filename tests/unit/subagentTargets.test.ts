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

  it('③d a candidate naming a RESERVED value is dropped, not shown beside the option that owns it', () => {
    // `''` and the sentinel are the control's own values. A peer naming either
    // one cannot be represented without two options sharing a value, so the row
    // is dropped: neither can be a real target, and a row the operator can see
    // but never select is worse than a row that is not there.
    const answer = targetOptions(
      {
        current: '',
        draft: '',
        candidates: {
          kind: 'ready',
          items: [
            { value: '', label: 'Blank id' },
            { value: MANUAL_TARGET_VALUE, label: 'Sentinel-ish' },
            A,
          ],
        },
      },
      LABELS,
    )

    expect(answer.options).toEqual([
      { value: '', label: 'nothing-chosen', empty: true },
      { value: 'agent-a', label: 'Agent A' },
      { value: MANUAL_TARGET_VALUE, label: 'type-it-myself', manual: true },
    ])
    // …and the reserved value a candidate claimed still selects the option that
    // OWNS it, so a stored sentinel keeps working.
    expect(targetOptions({ current: MANUAL_TARGET_VALUE, draft: '', candidates: READY }, LABELS).selected).toBe(
      MANUAL_TARGET_VALUE,
    )
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
    // A peer naming one of the control's OWN values. Review finding (#261): the
    // first draft's fixtures used only real ids, so the sweep could not see the
    // duplicate these produce.
    { kind: 'ready', items: [{ value: '', label: 'Blank id' }, A] },
    { kind: 'ready', items: [{ value: MANUAL_TARGET_VALUE, label: 'Sentinel-ish' }, A] },
  ]
  /** Values a field can hold, WITHOUT the manual sentinel. */
  const PLAIN = ['', 'agent-a', 'agent-b', 'agent-zzz']
  /** …and with it, for the cases that are about the sentinel. */
  const ALL = [...PLAIN, MANUAL_TARGET_VALUE]

  /**
   * The invariant assertion, as one helper so every case below states the same
   * property. The message names the combination, because a bare `false` in a
   * 343-cell sweep is unattributable.
   */
  function expectSelectedOffered(
    current: string,
    draft: string,
    candidates: TargetCandidates,
    label: string,
  ): void {
    const answer = targetOptions({ current, draft, candidates }, LABELS)
    expect(
      answer.options.some((option) => option.value === answer.selected),
      `${label}: no option for selected=${JSON.stringify(answer.selected)} ` +
        `(current=${JSON.stringify(current)}, draft=${JSON.stringify(draft)}, ` +
        `candidates=${candidates.kind}${candidates.kind === 'ready' ? `/${candidates.items.length}` : ''})`,
    ).toBe(true)
  }

  it('④a the invariant holds over every combination of candidates × current × draft', () => {
    // The failure this catches: a `<select>` renders BLANK for a value it cannot
    // match, while the form state still holds the right value — so every
    // request-body assertion in the suite stays green and the operator sees an
    // empty control.
    //
    // This sweep deliberately EXCLUDES the sentinel, which is what makes it the
    // case that isolates the injected-`unknown` guard: deleting the injection
    // turns this red, deleting the trailing sentinel does not.
    let checked = 0
    for (const candidates of CANDIDATE_STATES) {
      for (const current of PLAIN) {
        for (const draft of PLAIN) {
          expectSelectedOffered(current, draft, candidates, '④a')
          checked += 1
        }
      }
    }
    // The table really was walked, so a shrunken loop cannot pass silently.
    expect(checked).toBe(CANDIDATE_STATES.length * PLAIN.length * PLAIN.length)
  })

  it('④b the invariant also holds when the field itself holds the sentinel', () => {
    // The sentinel is a value the control can hold, so it is a value the sweep
    // must include — and a stored sentinel is the state a page reaches after the
    // operator chose manual entry and saved.
    let checked = 0
    for (const candidates of CANDIDATE_STATES) {
      for (const current of ALL) {
        for (const draft of ALL) {
          expectSelectedOffered(current, draft, candidates, '④b')
          checked += 1
        }
      }
    }
    expect(checked).toBe(CANDIDATE_STATES.length * ALL.length * ALL.length)
  })

  it('④c the manual sentinel is ALWAYS the last option, and exactly one of them', () => {
    // This is the case that isolates the trailing-sentinel guard: it never
    // mentions the injected option, so deleting the injection leaves it green.
    for (const candidates of CANDIDATE_STATES) {
      for (const current of ALL) {
        for (const draft of ALL) {
          const { options } = targetOptions({ current, draft, candidates }, LABELS)
          const manuals = options.filter((option) => option.manual === true)
          expect(manuals).toHaveLength(1)
          expect(options[options.length - 1]).toBe(manuals[0])
        }
      }
    }
  })

  it('④d option values are unique, so the browser has no tie to break', () => {
    // Two options with one value is the same class of defect as a blank control:
    // the browser shows whichever comes first and "which option is selected"
    // stops being answerable. This is the assertion that caught the first
    // draft's duplicate `''` (a candidate naming the control's own empty value)
    // and its duplicate sentinel.
    for (const candidates of CANDIDATE_STATES) {
      for (const current of ALL) {
        for (const draft of ALL) {
          const answer = targetOptions({ current, draft, candidates }, LABELS)
          const values = answer.options.map((option) => option.value)
          expect(new Set(values).size, `duplicate option value in ${JSON.stringify(values)}`).toBe(values.length)
          // The reserved values are owned by at most one option each, never two.
          // The empty value is offered exactly when the control holds it; the
          // sentinel is offered always (it is the way back to manual entry).
          const emptyOptions = answer.options.filter((option) => option.value === '')
          expect(emptyOptions.length).toBeLessThanOrEqual(1)
          expect(emptyOptions).toHaveLength(answer.selected === '' ? 1 : 0)
          expect(answer.options.filter((option) => option.value === MANUAL_TARGET_VALUE)).toHaveLength(1)
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

  it('⑤b the sentinel is a value no real id carries, and a colliding one is dropped rather than trusted', () => {
    // NOT "a NUL is impossible in an id": the protocol's `opaqueId` is
    // `unicodeText.min(1).max(256)`, which permits one. What actually protects
    // the invariant is the reserved-value filter, so the second half of this case
    // drives the collision instead of arguing it away.
    expect(MANUAL_TARGET_VALUE).toContain('\u0000')
    expect(MANUAL_TARGET_VALUE).not.toBe('')

    const colliding = targetOptions(
      { current: '', draft: '', candidates: { kind: 'ready', items: [{ value: MANUAL_TARGET_VALUE, label: 'Peer id' }] } },
      LABELS,
    )
    const values = colliding.options.map((option) => option.value)
    expect(new Set(values).size).toBe(values.length)
    expect(colliding.options.filter((option) => option.value === MANUAL_TARGET_VALUE)).toHaveLength(1)
  })
})
