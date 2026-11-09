/**
 * The 「实验性子智能体」 panel (#233, spec §5.8/§6.5).
 *
 * The user's hard requirement — EXPERIMENTAL, OFF BY DEFAULT, feedback welcome —
 * is not decoration: the badge, the "why experimental" sentence and the feedback
 * line are rendered unconditionally, above the switch and in every state. A
 * panel that only said "experimental" once the feature worked would be silent in
 * exactly the case nobody needs it silent in.
 *
 * Four contracts shape the rest:
 *
 *  - **The status is translated from CODES.** `status.reason` arrives as
 *    `{code, …}` (the first half of #233) and every sentence lives in the
 *    dictionary, so the English page is English all the way down — including the
 *    configuration problems, whose `received` SHAPE is translated too
 *    (`shape.*`) instead of printing a `typeof` result inside a sentence.
 *  - **`unsupported` and `failed` are different screens.** One is a host this
 *    operator cannot change, so the form is read-only and the copy says why; the
 *    other is a typo they can fix HERE, so saving must stay possible.
 *  - **A save does not apply.** The subsystem mounts once per apply (#231), so
 *    the server answers `pendingRestart` and the panel prints that notice only
 *    when it is true. A permanent "restart to apply" line would be a lie to the
 *    operator who just restarted.
 *  - **A refusal never moves the draft.** The local fields are the operator's
 *    edit; a conflict offers a re-read instead of re-seeding over their typing.
 *
 * Fields this form does NOT render as CONTROLS — `cwdMode`, `routes`,
 * `maxInteractionAbandons` — are carried through from the stored document
 * untouched. Dropping them would make a save delete configuration the operator
 * never saw. Two of them still get a read-only line: `cwdMode` because it has
 * no consumer yet (D1), `routes` because it has one (a per-directory device and
 * workspace) and a problem can name an entry this page cannot edit.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, REQUEST_TIMEOUT, defaultSubagentClient } from './api'
import { useT } from './i18n'
import type { T } from './i18n'
import { MANUAL_TARGET_VALUE, targetOptions } from './subagentTargets'
import type { TargetCandidate, TargetCandidates, TargetFieldState, TargetLabels, TargetProblem } from './subagentTargets'
import { STATE_KEYS } from './types'
import type {
  DeviceSummary,
  ReceivedShape,
  SubagentClient,
  SubagentConfig,
  SubagentProblem,
  SubagentResponse,
  SubagentSaveRequest,
  SubagentStatus,
  SubagentToolProblem,
} from './types'

/**
 * The panel's props.
 *
 * `devices` is a PROP, not a fetch: `App` already holds the live list (one
 * `GET /devices` plus the SSE stream), and asking for it again here would buy a
 * second request, a second copy that can go stale, and a change in the call
 * counts `tests/unit/ui.test.ts` pins. The panel renders what it was handed.
 */
export interface SubagentPanelProps {
  /** The subagent HTTP seam. Defaults to the same-origin calls. */
  client?: SubagentClient
  /** The paired devices, already sorted by `App`. Empty when the read failed. */
  devices?: readonly DeviceSummary[]
}

/**
 * The feedback entry point, and the SAME string the README pair quotes (#234).
 *
 * The issues list, not a new label and not a versioned path: a deep link into a
 * filter would rot, and the point of the line is "here is where to tell us".
 */
const FEEDBACK_URL = 'https://github.com/SAXEM1997/dsh-cherry-bridge/issues'

/** The dictionary keys behind {@link ReceivedShape}, so the shape is translated too. */
const SHAPE_KEYS: Record<string, string> = {
  string: 'shape.string',
  number: 'shape.number',
  boolean: 'shape.boolean',
  object: 'shape.object',
  array: 'shape.array',
  null: 'shape.null',
  undefined: 'shape.undefined',
  function: 'shape.function',
  symbol: 'shape.symbol',
  bigint: 'shape.bigint',
  NaN: 'shape.NaN',
  Infinity: 'shape.Infinity',
  '-Infinity': 'shape.-Infinity',
}

/**
 * The shape that arrived, in the current language.
 *
 * Falls back to the raw token for a shape this build does not know: a newer
 * server sending one must not blank the sentence, and printing `string` inside a
 * Chinese sentence is still better than printing nothing.
 */
function shapeText(t: T, shape: ReceivedShape): string {
  const key = SHAPE_KEYS[shape]
  return key === undefined ? shape : t(key)
}

/** One configuration problem as a sentence, from its code. */
function problemText(t: T, problem: SubagentProblem): string {
  switch (problem.code) {
    case 'not-string':
      return t('subagent.problem.not-string', {
        field: problem.field,
        received: shapeText(t, problem.received),
      })
    case 'not-boolean':
      return t('subagent.problem.not-boolean', {
        field: problem.field,
        received: shapeText(t, problem.received),
      })
    case 'not-array':
      return t('subagent.problem.not-array', {
        field: problem.field,
        received: shapeText(t, problem.received),
      })
    case 'not-object':
      return t('subagent.problem.not-object', {
        field: problem.field,
        received: shapeText(t, problem.received),
      })
    case 'empty':
      return t('subagent.problem.empty', { field: problem.field })
    case 'missing':
      return t('subagent.problem.missing', { field: problem.field })
    case 'route-cwd-prefix':
      return t('subagent.problem.route-cwd-prefix', { field: problem.field })
    case 'route-cwd-prefix-root':
      return t('subagent.problem.route-cwd-prefix-root', { field: problem.field })
    case 'route-cwd-prefix-relative':
      return t('subagent.problem.route-cwd-prefix-relative', { field: problem.field })
    case 'cwd-mode-unimplemented':
      return t('subagent.problem.cwd-mode-unimplemented', { field: problem.field })
    case 'out-of-range':
      return t('subagent.problem.out-of-range', {
        field: problem.field,
        min: problem.min,
        max: problem.max,
        received: shapeText(t, problem.received),
      })
    case 'enum':
      return t('subagent.problem.enum', {
        field: problem.field,
        allowed: problem.allowed.join(t('list.separator')),
        received: shapeText(t, problem.received),
      })
    case 'exclusive':
      return t('subagent.problem.exclusive', { field: problem.field, other: problem.other })
    default: {
      // Unreachable for this build's union. Kept for a NEWER server: showing the
      // code beats showing nothing, and a silent blank would read as "fine".
      const unknown = problem as { code: string }
      return unknown.code
    }
  }
}

/** Why the provider is up but the tool is not, from its code. */
function toolProblemText(t: T, problem: SubagentToolProblem): string {
  switch (problem.code) {
    case 'no-tools-service':
      return t('subagent.tool.no-tools-service')
    case 'no-start-activation':
      return t('subagent.tool.no-start-activation')
    case 'no-step-condition':
      return t('subagent.tool.no-step-condition')
    case 'host-refused':
      return t('subagent.tool.host-refused', { message: problem.message })
    default: {
      const unknown = problem as { code: string }
      return unknown.code
    }
  }
}

/**
 * The four states, as one block.
 *
 * `state` alone would not be enough: `ready` covers both "provider and tool" and
 * "provider only", and `failed` covers a broken config and a refused provider
 * registration. The REASON is what the operator acts on, so this switches on it
 * and lets `state` describe what is registered.
 */
function StatusBlock({ status }: { status: SubagentStatus }): ReturnType<typeof Object> {
  const t = useT()
  const reason = status.reason
  switch (reason.code) {
    case 'disabled':
      return <p className="cherry-hint">{t('subagent.status.disabled')}</p>
    case 'awaiting-injection':
      return <p className="cherry-hint">{t('subagent.status.awaiting-injection')}</p>
    case 'unsupported':
      return <p className="cherry-hint">{t('subagent.status.unsupported')}</p>
    case 'invalid':
      return (
        <>
          <p className="cherry-hint">{t('subagent.status.invalid')}</p>
          <ul className="cherry-subagent-problems">
            {reason.problems.map((problem, index) => (
              // The index is part of the key because the SAME problem can occur
              // twice (two bad route entries), and a code-only key would make
              // React reuse the wrong <li>.
              <li key={`${problem.code}-${index}`}>{problemText(t, problem)}</li>
            ))}
          </ul>
        </>
      )
    case 'provider-refused':
      return <p className="cherry-hint">{t('subagent.status.provider-refused', { message: reason.message })}</p>
    case 'ready':
      return (
        <p className="cherry-hint">
          {t('subagent.status.ready', { providerName: reason.providerName, toolName: reason.toolName })}
        </p>
      )
    case 'ready-without-tool':
      return (
        <>
          <p className="cherry-hint">
            {t('subagent.status.ready-without-tool', {
              providerName: reason.providerName,
              toolName: reason.toolName,
            })}
          </p>
          <p className="cherry-hint">{toolProblemText(t, reason.problem)}</p>
        </>
      )
    default: {
      const unknown = reason as { code: string }
      return <p className="cherry-hint cherry-mono">{unknown.code}</p>
    }
  }
}

/** The editable half of the document. */
/** One editable route row: the three strings the boxes hold. */
interface RouteDraft {
  cwdPrefix: string
  device: string
  workspaceId: string
}

/**
 * A row the operator added and never filled in.
 *
 * "Add" is one click from "save", so an all-blank row is an abandoned click
 * rather than a route. Sending it would fail validation and blame the operator
 * for a row they never meant to create.
 */
function isBlankRoute(route: RouteDraft): boolean {
  return route.cwdPrefix.trim() === '' && route.device.trim() === '' && route.workspaceId.trim() === ''
}

interface Draft {
  enabled: boolean
  device: string
  agentId: string
  workspace: 'registry' | 'system'
  workspaceId: string
  timeoutMs: string
  /**
   * The per-directory route table (#303).
   *
   * Text, not the parsed values: the boxes must be able to hold a half-typed
   * path, and a row the operator just added is all blanks. `bodyOf` does the
   * trimming and the "blank means omit" translation.
   */
  routes: RouteDraft[]
  /**
   * The DEVICE `agentId` was read or chosen under (#271).
   *
   * An agent id is only meaningful together with the device it was listed on,
   * so the pairing — not the value — is what decides whether the agent still
   * applies. Seeded from the stored document (whose agent belongs to its own
   * device) and rewritten on every pick or hand-typed edit of the agent field.
   */
  agentScope: string
  /**
   * The `(device, agentId)` pair `workspaceId` was chosen under (#271), as
   * {@link workspaceScopeOf} builds it. Same reasoning one level down: a
   * workspace belongs to an agent.
   */
  workspaceScope: string
}

/**
 * The pair a workspace id is meaningful under, as ONE comparable string.
 *
 * `JSON.stringify` of the two halves rather than a `\0` join: the protocol's id
 * schema forbids lone surrogates but permits a NUL (#261), so a separator an id
 * may contain could make two different pairs compare equal. The value is
 * internal and never displayed.
 */
function workspaceScopeOf(device: string, agentId: string): string {
  return JSON.stringify([device, agentId])
}

/** Seed the form from a document. `revision` and the unrendered fields stay behind. */
function draftOf(config: SubagentConfig): Draft {
  return {
    enabled: config.enabled === true,
    device: config.device ?? '',
    agentId: config.agentId ?? '',
    workspace: config.workspaceKind === 'system' ? 'system' : 'registry',
    workspaceId: config.workspaceId ?? '',
    timeoutMs: config.timeoutMs === undefined ? '' : String(config.timeoutMs),
    routes: (config.routes ?? []).map((route) => ({
      cwdPrefix: route.cwdPrefix,
      device: route.device ?? '',
      workspaceId: route.workspaceId ?? '',
    })),
    // The stored values were read TOGETHER, so they scope each other. Seeding
    // these from the document is what makes an untouched form send the values
    // back unchanged.
    agentScope: (config.device ?? '').trim(),
    workspaceScope: workspaceScopeOf((config.device ?? '').trim(), (config.agentId ?? '').trim()),
  }
}

/**
 * The write body: the RENDERED fields from the draft, everything else from the
 * stored document.
 *
 * `expectedRevision` is the stored `revision`, which is what the read-modify-
 * write lock is for — and the reason the form must never send a revision it did
 * not read.
 */
function bodyOf(draft: Draft, stored: SubagentConfig & { revision: number }): SubagentSaveRequest {
  const timeout = Number(draft.timeoutMs)
  return {
    ...stored,
    enabled: draft.enabled,
    device: draft.device.trim(),
    agentId: draft.agentId.trim(),
    ...(draft.workspace === 'system'
      ? { workspaceKind: 'system' as const, workspaceId: undefined }
      : { workspaceKind: undefined, workspaceId: draft.workspaceId.trim() }),
    // An empty or unparseable box must CLEAR the field, not merely fail to
    // override it: `...stored` above already carries the stored value, so
    // omitting the key left it in place and the box could never be emptied.
    // `undefined` is dropped by `JSON.stringify`, which is exactly "the operator
    // cleared it" — the server then stores no value and the resolver applies the
    // default, so the re-read shows what was actually stored.
    //
    // The non-finite half is not about typed input: a `type="number"` box cannot
    // produce one. It guards a HAND-EDITED document — `draftOf` renders the
    // stored value with `String(...)`, so a `null` or a stray string reaches the
    // box as text and `Number()` of it is not finite. Re-sending that would
    // write the garbage back; clearing it is the repair.
    ...(draft.timeoutMs.trim() === '' || !Number.isFinite(timeout)
      ? { timeoutMs: undefined }
      : { timeoutMs: timeout }),
    // ALWAYS written, never omitted on a full removal: `...stored` still carries
    // the old array, so leaving the key out would silently keep every route the
    // operator just deleted — the trap `timeoutMs` above already paid for.
    //
    // A blank half is OMITTED rather than sent as `''`: an empty `device` is a
    // device selector that matches nothing, and the resolver would refuse every
    // delegation under that prefix. Absent means "fall back to the target above",
    // which is what a blank box says.
    routes: draft.routes.filter((route) => !isBlankRoute(route)).map((route) => ({
      cwdPrefix: route.cwdPrefix.trim(),
      ...(route.device.trim() === '' ? {} : { device: route.device.trim() }),
      ...(route.workspaceId.trim() === '' ? {} : { workspaceId: route.workspaceId.trim() }),
    })),
    expectedRevision: stored.revision,
  }
}

/**
 * The three refusal codes this panel has a sentence for, as a TABLE rather than
 * an interpolated key.
 *
 * A `\`subagent.saveFailure.${code}\`` lookup would read the dictionary with a
 * key no source file spells, which makes all three sentences look dead to
 * `tests/unit/i18nUsage.test.ts` — the same reason `ToolScopePanel` keeps a
 * `SAVE_FAILURE_KEYS` table. A code outside the table falls back to the server's
 * own verdict, which is the honest line for a refusal this build does not know.
 */
const SAVE_FAILURE_KEYS: Record<string, string> = {
  'subagent-revision-conflict': 'subagent.saveFailure.subagent-revision-conflict',
  'missing-expected-revision': 'subagent.saveFailure.missing-expected-revision',
  'invalid-request': 'subagent.saveFailure.invalid-request',
}

/** A save refusal as a sentence: a known code gets its own, anything else the server's. */
function failureSentence(t: T, error: unknown): string {
  if (error instanceof Error && error.message === REQUEST_TIMEOUT) return t('subagent.error.timeout')
  if (error instanceof ApiError) {
    const key = SAVE_FAILURE_KEYS[error.code]
    return key === undefined ? t('subagent.serverSaid', { code: error.code, status: error.status }) : t(key)
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * The longest id shown inside an option's label before it is clipped.
 *
 * The `value` is ALWAYS the full id — only the visible text is shortened, because
 * a 200-character id would otherwise push the name (the part an operator reads)
 * off the screen. `…` rather than a silent cut, so a clipped id is visibly
 * clipped.
 */
const ID_DISPLAY_LIMIT = 28

/**
 * `<name>（<id>）`, or the bare id when the peer reported no name.
 *
 * The JOIN is a dictionary key, not a literal: the brackets around the id are
 * copy, and a Chinese page wants `（…）` where an English one wants `(…)`. A
 * literal here would be the only place an English operator met full-width
 * punctuation.
 */
function withId(t: T, name: string | undefined, id: string): string {
  const shown = id.length <= ID_DISPLAY_LIMIT ? id : `${id.slice(0, ID_DISPLAY_LIMIT - 1)}…`
  return name === undefined || name === '' ? shown : t('subagent.targets.withId', { name, id: shown })
}

/**
 * The candidate endpoint's problem codes this panel has a sentence for, as a
 * literal TABLE.
 *
 * A `\`subagent.targets.problem.${code}\`` lookup would read the dictionary with
 * a key no source file spells, which makes every sentence look dead to
 * `tests/unit/i18nUsage.test.ts` — the same reason `SAVE_FAILURE_KEYS` above is a
 * table. A code outside it falls back to `unreachable`, which names the code and
 * still tells the operator the one thing that matters: hand entry still works.
 */
const TARGET_PROBLEM_KEYS: Record<string, string> = {
  'device-unavailable': 'subagent.targets.problem.deviceUnavailable',
  'not-found': 'subagent.targets.problem.notFound',
  'ambiguous-device': 'subagent.targets.problem.ambiguous',
}

/** A candidate-refresh failure as a sentence: by CODE, never the server's prose. */
function targetProblemText(t: T, problem: TargetProblem): string {
  const key = TARGET_PROBLEM_KEYS[problem.code]
  return key === undefined
    ? t('subagent.targets.problem.unreachable', { code: problem.code })
    : t(key)
}

/**
 * A thrown call as a {@link SubagentTargetsProblem}.
 *
 * `GET /subagent/targets` answers its refusals IN BAND (`{problem}` at 200), so
 * anything that THROWS is off-contract and has no body to read: a timeout
 * (`REQUEST_TIMEOUT`), a dead socket (`TypeError`), or a 4xx this page caused.
 * Each gets a synthetic code so the renderer has one shape to handle. An
 * `ApiError` keeps the SERVER's code (it is a refusal this page caused, and the
 * code names which); the other two are the panel's own.
 *
 * NOTHING here prints `problem.message`: the endpoint's sentences are English
 * templates, and this page is Chinese. The trade is real and worth stating —
 * `archive-quarantined`'s recovery guidance lives in its `message` and is
 * therefore not shown. Translating the code is what the rest of this page does
 * with server verdicts, and one English paragraph in the middle of a Chinese
 * form is worse than a sentence that names the code.
 */
function thrownProblem(t: T, error: unknown): TargetProblem {
  if (error instanceof ApiError) return { code: error.code, message: error.message }
  if (error instanceof Error && error.message === REQUEST_TIMEOUT) {
    return { code: 'request-timeout', message: t('subagent.targets.problem.unreachable', { code: 'request-timeout' }) }
  }
  return { code: 'client-error', message: error instanceof Error ? error.message : String(error) }
}

/**
 * One target field as a `<select>`, rendered ENTIRELY from #261's
 * {@link targetOptions}.
 *
 * The panel contributes three things and nothing else: the labels, the candidate
 * state, and what a change means. It does NOT decide which option is selected —
 * that rule lives in the module, because the failure it prevents (a `<select>`
 * whose value matches no option renders blank while the form state is correct) is
 * invisible to any assertion on the request body.
 */
function TargetSelect(props: {
  label: string
  field: TargetFieldState
  labels: TargetLabels
  disabled: boolean
  onChange(value: string): void
}): ReturnType<typeof Object> {
  const { options, selected } = targetOptions(props.field, props.labels)
  return (
    <label className="cherry-subagent-field">
      {props.label}
      <select
        className="cherry-subagent-select"
        value={selected}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function SubagentPanel({ client = defaultSubagentClient, devices = [] }: SubagentPanelProps): ReturnType<typeof Object> {
  const t = useT()
  const [data, setData] = useState<SubagentResponse | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  // --- the candidate source (#262) -----------------------------------------
  //
  // FOUR pieces of state, deliberately NOT folded into `data`: a refresh must not
  // touch the draft, and must not move the `expectedRevision` baseline a save is
  // locked on (see `save`). `accept()` does both, so it is the wrong door here.
  const [agentAnswer, setAgentAnswer] = useState<
    { device: string; candidates: TargetCandidates; truncated?: readonly string[] } | undefined
  >(undefined)
  const [workspaceAnswer, setWorkspaceAnswer] = useState<
    { key: string; candidates: TargetCandidates; systemWorkspace: boolean | undefined } | undefined
  >(undefined)
  /** The operator asked to type a value by hand instead of picking one. */
  const [manual, setManual] = useState<'device' | 'agent' | 'workspace' | undefined>(undefined)
  /**
   * The device the AGENT list is asked for.
   *
   * Not `draft.device`: the manual box edits that on every keystroke, and each
   * one would be a real peer walk. This moves when the document loads, when the
   * operator PICKS a device, and when they leave the manual box — the moments the
   * answer can actually change.
   */
  const [committedDevice, setCommittedDevice] = useState('')

  const accept = useCallback((answer: SubagentResponse) => {
    setData(answer)
    setDraft(draftOf(answer.subagent))
    setCommittedDevice(answer.subagent.device?.trim() ?? '')
    // A re-read (or a save) is a new baseline: the document now says what the
    // operator meant, so the hand-entry choice stops applying.
    setManual(undefined)
  }, [])

  const load = useCallback(async () => {
    setLoadError(undefined)
    try {
      accept(await client.get())
    } catch (error) {
      setLoadError(failureSentence(t, error))
    }
  }, [accept, client, t])

  useEffect(() => {
    void load()
  }, [load])

  // ---- the candidate source (#262) ---------------------------------------
  //
  // TWO walks, not one, and each answer is stored WITH THE KEY IT ANSWERED FOR.
  //
  // Two, because the endpoint refuses an `agentId` it cannot find, and that
  // refusal is a whole-body `problem` — one request carrying a stale agent would
  // throw away the agent list the operator needs to fix it. So the agent list is
  // asked for by DEVICE alone, and the workspace list only once the chosen agent
  // is known to be on that device.
  //
  // Keyed, because "keep the old list while the new one loads" is only safe
  // WITHIN one key. Across keys it is the cross-device mistake this ticket
  // exists to prevent: device B's form would keep offering device A's
  // workspaces, and a save would write A's workspace into B's document.
  const device = committedDevice
  useEffect(() => {
    if (device === '') {
      // Nothing to ask. `undefined` rather than a `ready: []` answer, so the
      // render below can tell "no device" from "the device has no agents".
      setAgentAnswer(undefined)
      return
    }
    let cancelled = false
    void client
      .targets(device)
      .then((answer) => {
        if (cancelled) return
        setAgentAnswer({
          device,
          candidates: 'problem' in answer
            ? { kind: 'unavailable', problem: answer.problem }
            : {
                kind: 'ready',
                items: answer.agents.map((agent) => ({ value: agent.agentId, label: withId(t, agent.name, agent.agentId) })),
              },
          // A truncated list is REAL but incomplete, and the operator is about to
          // pick from it: saying so is the difference between "that agent is not
          // there" and "we stopped looking".
          ...('problem' in answer || answer.truncated === undefined
            ? {}
            : { truncated: answer.truncated.lists }),
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setAgentAnswer({ device, candidates: { kind: 'unavailable', problem: thrownProblem(t, error) } })
      })
    // The cleanup is the OUT-OF-ORDER guard: a slow answer for device A must not
    // overwrite a fast one for B, and React re-running the effect (StrictMode
    // does) must not double-apply.
    return () => {
      cancelled = true
    }
  }, [client, device, t])

  const agentCandidates: TargetCandidates =
    agentAnswer === undefined || agentAnswer.device !== device
      ? device === ''
        ? { kind: 'ready', items: [] }
        : { kind: 'loading' }
      : agentAnswer.candidates
  /**
   * The agent the WORKSPACE list may be asked about: the draft's, when the list
   * for this device names it.
   *
   * DERIVED, not remembered. A remembered copy of "which agent did we choose"
   * goes stale the moment the operator types an id by hand — the workspace list
   * would keep offering the PREVIOUS agent's workspaces, and a save would send
   * the new agent with the old workspace. That is the same cross-contamination
   * this ticket forbids across devices, one level down.
   */
  const draftAgentId = draft?.agentId.trim() ?? ''
  const chosenAgentId =
    agentCandidates.kind === 'ready' && agentCandidates.items.some((candidate) => candidate.value === draftAgentId)
      ? draftAgentId
      : ''
  /** The chosen agent is on THIS device's list, so the workspace walk may run. */
  const chosenAgentKnown = chosenAgentId !== ''
  const workspaceKey = `${device}\u0000${chosenAgentId}`

  useEffect(() => {
    if (!chosenAgentKnown) {
      setWorkspaceAnswer(undefined)
      return
    }
    let cancelled = false
    void client
      .targets(device, chosenAgentId)
      .then((answer) => {
        if (cancelled) return
        setWorkspaceAnswer({
          key: workspaceKey,
          candidates: 'problem' in answer
            ? { kind: 'unavailable', problem: answer.problem }
            : {
                kind: 'ready',
                items: (answer.workspaces ?? []).map((workspace) => ({
                  value: workspace.workspaceId,
                  label: withId(t, workspace.name, workspace.workspaceId),
                })),
              },
          // A `problem` means the catalog could not be READ, which is not the
          // same fact as "this peer has no system workspace". `undefined` keeps
          // the two apart all the way to the radio.
          systemWorkspace: 'problem' in answer ? undefined : answer.systemWorkspace,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setWorkspaceAnswer({
          key: workspaceKey,
          candidates: { kind: 'unavailable', problem: thrownProblem(t, error) },
          systemWorkspace: undefined,
        })
      })
    return () => {
      cancelled = true
    }
  }, [client, device, chosenAgentId, chosenAgentKnown, workspaceKey, t])

  const workspaceCandidates: TargetCandidates =
    workspaceAnswer === undefined || workspaceAnswer.key !== workspaceKey
      ? chosenAgentId === ''
        ? { kind: 'ready', items: [] }
        : { kind: 'loading' }
      : workspaceAnswer.candidates
  /**
   * `true` supported, `false` the peer SAYS it has none, `undefined` we could not
   * ask. Three states, because "unknown" must not be rendered as "unsupported":
   * an offline desktop is still configurable, and disabling a control on a failed
   * request would be the page inventing a fact.
   */
  const systemWorkspace =
    workspaceAnswer !== undefined && workspaceAnswer.key === workspaceKey
      ? workspaceAnswer.systemWorkspace
      : undefined
  /** The lists are only as good as the key they answered for. */
  const truncatedLists =
    agentAnswer !== undefined && agentAnswer.device === device ? agentAnswer.truncated : undefined

  /**
   * Route table edits (#303). Index-keyed because the rows ARE positional: a
   * route's meaning is its place in the precedence order (the FIRST matching
   * prefix wins), so moving a row up is a real edit, and a key that followed the
   * value would make the boxes jump between rows.
   */
  const editRoute = (index: number, patch: Partial<RouteDraft>): void => {
    if (draft === undefined) return
    setDraft({
      ...draft,
      routes: draft.routes.map((route, at) => (at === index ? { ...route, ...patch } : route)),
    })
  }

  const addRoute = (): void => {
    if (draft === undefined) return
    setDraft({ ...draft, routes: [...draft.routes, { cwdPrefix: '', device: '', workspaceId: '' }] })
  }

  const removeRoute = (index: number): void => {
    if (draft === undefined) return
    setDraft({ ...draft, routes: draft.routes.filter((_, at) => at !== index) })
  }

  const save = async (): Promise<void> => {
    // `effective` is undefined exactly when `draft` is, so this one check covers
    // both — and it is what lets the body be built from a NON-optional draft.
    if (effective === undefined || data === undefined) return
    setBusy(true)
    setSaved(false)
    setFailure(undefined)
    try {
      // The PUT answers the same body the GET does, so the panel replaces its
      // whole state with it: a save that only patched `revision` would leave the
      // status describing the previous apply.
      accept(await client.put(bodyOf(effective, data.subagent)))
      setSaved(true)
    } catch (error) {
      // The draft is NOT reset: the operator's edit survives the refusal, and a
      // conflict's recovery is the explicit re-read button below.
      setFailure(failureSentence(t, error))
    } finally {
      setBusy(false)
    }
  }

  // `unsupported` is the one state where the form is read-only: saving cannot
  // help (the host has no subagents service), and a control that looks
  // effective while it cannot be is the fake switch this ticket exists to avoid.
  const readOnly = data !== undefined && data.status.state === 'unsupported'

  // The three strings #261 refuses to invent: they are user-visible copy, and
  // `i18n.ts` is the only file allowed to hold any.
  const targetLabels: TargetLabels = {
    unknown: (value) => t('subagent.targets.unknown', { value }),
    manual: t('subagent.targets.manual'),
    empty: t('subagent.targets.unset'),
  }

  // ---- what a change UPSTREAM invalidates (#262) --------------------------
  //
  // "The device changed" is DERIVED, not remembered. A remembered clear would
  // destroy the agent id the moment the operator typed a character into the
  // device box, and would not give it back when they typed it away again; a
  // derived one simply stops applying while the edit is in flight.
  const storedDevice = data?.subagent.device ?? ''
  const storedAgentId = data?.subagent.agentId ?? ''
  const draftDevice = draft?.device.trim() ?? ''

  // Does a value still APPLY? (#271)
  //
  // The question is not "has the device changed since the last SAVE" but "was
  // this value read under the device that is in the box NOW". Comparing with the
  // stored document — which is what this did first — stays true for the whole
  // time an operator is filling the form in, so every pick below the first was
  // blanked the instant it was made: the reported symptom was that the second
  // drop-down only took effect if you saved the first one first.
  const agentApplies = draft !== undefined && draftAgentId !== '' && draftDevice === draft.agentScope
  const workspaceApplies =
    draft !== undefined &&
    draft.workspaceId.trim() !== '' &&
    draft.workspaceScope === workspaceScopeOf(draftDevice, draftAgentId)

  /** A value the operator can see, that no longer applies to what is above it. */
  const agentInvalidated = draft !== undefined && draftAgentId !== '' && !agentApplies
  const workspaceInvalidated =
    draft !== undefined && draft.workspaceId.trim() !== '' && !workspaceApplies

  // The draft the FORM and the SAVE both use: the stale halves are blanked in one
  // place, so the control cannot show one thing while the body sends another.
  // Nothing is destroyed on the way past — a value keeps the scope it was read
  // under, and starts applying again if the scope comes back.
  const effective: Draft | undefined =
    draft === undefined
      ? undefined
      : {
          ...draft,
          agentId: agentApplies ? draft.agentId : '',
          workspaceId: workspaceApplies ? draft.workspaceId : '',
        }

  const agentField: TargetFieldState = {
    // `current: ''` is what makes #261 render the field UNSELECTED: its own rule
    // is that an empty draft falls back to the stored value, which is right for
    // "not touched" and wrong for "no longer applies". The stored agent is only
    // "current" for the stored device — that is the whole scoping rule.
    current: draftDevice === storedDevice ? storedAgentId : '',
    draft: manual === 'agent' ? MANUAL_TARGET_VALUE : (effective?.agentId ?? ''),
    candidates: agentCandidates,
  }
  const workspaceField: TargetFieldState = {
    current:
      draftDevice === storedDevice && draftAgentId === storedAgentId
        ? (data?.subagent.workspaceId ?? '')
        : '',
    draft: manual === 'workspace' ? MANUAL_TARGET_VALUE : (effective?.workspaceId ?? ''),
    candidates: workspaceCandidates,
  }
  const deviceField: TargetFieldState = {
    current: storedDevice,
    draft: manual === 'device' ? MANUAL_TARGET_VALUE : (draft?.device ?? ''),
    candidates: {
      kind: 'ready',
      items: devices.map((device) => ({
        value: device.deviceId,
        // The STATE is part of the label on purpose: delegating to a device that
        // is not `connected` fails, and that is worth knowing BEFORE choosing.
        label: `${withId(t, device.displayName, device.deviceId)} · ${t(STATE_KEYS[device.state])}`,
      })),
    },
  }
  const workspaceProblem = workspaceCandidates.kind === 'unavailable' ? workspaceCandidates.problem : undefined
  const agentProblem = agentCandidates.kind === 'unavailable' ? agentCandidates.problem : undefined

  return (
    <section className="cherry-panel" aria-labelledby="cherry-subagent-title">
      <h3 id="cherry-subagent-title">
        {t('subagent.heading')}{' '}
        <span className="cherry-experimental">{t('subagent.badge')}</span>
      </h3>
      <p className="cherry-hint">{t('subagent.experimental')}</p>
      <p className="cherry-hint">{t('subagent.defaultOff')}</p>
      <p className="cherry-hint">
        {t('subagent.feedback')}{' '}
        <a href={FEEDBACK_URL} target="_blank" rel="noreferrer noopener">
          {t('subagent.feedbackLink')}
        </a>
      </p>

      {loadError !== undefined && (
        <p className="cherry-error" role="alert">
          {t('subagent.loadError', { error: loadError })}
        </p>
      )}
      {data === undefined && loadError === undefined && <p className="cherry-hint">{t('subagent.loading')}</p>}

      {data !== undefined && (
        <>
          {/* #273: `status` is the decision this ASSEMBLY made, not a verdict
              on the form below — `pendingRestart` is the only thing that says
              the two differ. Printed unlabelled and after the restart notice,
              a stale `invalid` read as "your form is wrong", and the operator
              went looking for a field that was already filled in. The notice
              therefore comes FIRST, the heading names the document being
              judged, and the problems stay visible: they are the reason the
              restart is worth doing. */}
          {data.pendingRestart && (
            <p className="cherry-notice" role="status">
              {t('subagent.pendingRestart')}
            </p>
          )}
          <h4>
            {data.pendingRestart
              ? t('subagent.status.heading.pending')
              : t('subagent.status.heading')}
          </h4>
          <StatusBlock status={data.status} />
          <p className="cherry-hint">
            {data.source === 'file' ? t('subagent.source.file') : t('subagent.source.config')}
          </p>
          {/* The experiment is scope-gated exactly like the other fourteen
              tools, and the degraded arm is invisible from here: under
              `selected` with an unreadable workspace list NO workspace sees the
              tool, while the status still says `ready`. Saying so is the
              difference between "broken" and "your scope excludes it". */}
          <p className="cherry-hint">{t('subagent.scopeNote')}</p>
          <p className="cherry-hint cherry-mono">
            {t('subagent.revision', { revision: data.subagent.revision })}
          </p>

          {draft !== undefined && (
            <div className="cherry-subagent-form">
              <label className="cherry-subagent-check">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  disabled={readOnly}
                  onChange={(event) => {
                    const enabled = event.target.checked
                    setDraft({ ...draft, enabled })
                  }}
                />
                {t('subagent.enabled')}
              </label>

              {/* #287: while the switch is OFF the section shows only the
                  switch. Rendering-only — the draft keeps every value, so
                  turning it back on restores exactly what was there. */}
              {draft.enabled && (
                <>
                <TargetSelect
                  label={t('subagent.device')}
                  field={deviceField}
                  labels={targetLabels}
                  disabled={readOnly}
                  onChange={(value) => {
                    if (value === MANUAL_TARGET_VALUE) {
                      setManual('device')
                      return
                    }
                    setManual(undefined)
                    // ONLY the device moves here. The two downstream values stop
                    // APPLYING, because their scopes still name the old device —
                    // and a value scoped to a device the operator returns to starts
                    // applying again (#271).
                    setDraft({ ...draft, device: value })
                    setCommittedDevice(value.trim())
                  }}
                />
                {manual === 'device' && (
                  <label className="cherry-subagent-field">
                    {t('subagent.deviceManual')}
                    <input
                      type="text"
                      value={draft.device}
                      disabled={readOnly}
                      onChange={(event) => setDraft({ ...draft, device: event.target.value })}
                      // Committed on the way OUT, not per keystroke: every
                      // keystroke would otherwise be a real walk of the peer.
                      onBlur={(event) => setCommittedDevice(event.target.value.trim())}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') setCommittedDevice(event.currentTarget.value.trim())
                      }}
                    />
                  </label>
                )}
                <p className="cherry-hint">{t('subagent.deviceHint')}</p>
                {agentInvalidated && (
                  <p className="cherry-hint">{t('subagent.targets.reselectAgent')}</p>
                )}
                {/* The system workspace has NO id — it is the protocol's
                    `{ kind: 'system' }` branch and never appears in `items` — so
                    it stays a RADIO, not a list entry (#263). */}
                {systemWorkspace === false && (
                  <p className="cherry-hint">{t('subagent.workspace.systemUnavailable')}</p>
                )}
                {systemWorkspace === false && draft.workspace === 'system' && (
                  // Shown, never rewritten: the operator chose this, and a page
                  // that quietly changed it would be editing a document nobody
                  // asked it to edit.
                  <p className="cherry-hint">{t('subagent.workspace.systemConflict')}</p>
                )}

                <TargetSelect
                  label={t('subagent.agentId')}
                  field={agentField}
                  labels={targetLabels}
                  disabled={readOnly}
                  onChange={(value) => {
                    if (value === MANUAL_TARGET_VALUE) {
                      setManual('agent')
                      return
                    }
                    setManual(undefined)
                    // The pick is scoped to the device it came from (#271). NOT a
                    // clear of the workspace: the scope comparison below already
                    // makes the old workspace stop applying, and it comes back if
                    // the operator puts this agent back.
                    setDraft({ ...draft, agentId: value, agentScope: draft.device.trim() })
                  }}
                />
                {manual === 'agent' && (
                  <label className="cherry-subagent-field">
                    {t('subagent.agentIdManual')}
                    <input
                      type="text"
                      value={draft.agentId}
                      disabled={readOnly}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          agentId: event.target.value,
                          agentScope: draft.device.trim(),
                        })
                      }
                    />
                  </label>
                )}
                {agentProblem !== undefined && (
                  <p className="cherry-hint">{targetProblemText(t, agentProblem)}</p>
                )}
                {agentProblem === undefined && draft.device.trim() === '' && (
                  <p className="cherry-hint">{t('subagent.targets.pickDevice')}</p>
                )}
                {agentProblem === undefined && draft.device.trim() !== '' && agentCandidates.kind === 'loading' && (
                  <p className="cherry-hint">{t('subagent.targets.loading')}</p>
                )}
                {agentProblem === undefined && draft.device.trim() !== '' && agentCandidates.kind === 'ready' && agentCandidates.items.length === 0 && (
                  <p className="cherry-hint">{t('subagent.targets.empty')}</p>
                )}
                {truncatedLists !== undefined && truncatedLists.length > 0 && (
                  <p className="cherry-hint">
                    {t('subagent.targets.truncated', { lists: truncatedLists.join(t('list.separator')) })}
                  </p>
                )}

                <fieldset className="cherry-scope-options">
                  <legend>{t('subagent.workspace.legend')}</legend>
                  <label className="cherry-subagent-check">
                    <input
                      type="radio"
                      name="subagent-workspace"
                      checked={draft.workspace === 'registry'}
                      disabled={readOnly}
                      onChange={() => setDraft({ ...draft, workspace: 'registry' })}
                    />
                    {t('subagent.workspace.registry')}
                  </label>
                  <label className="cherry-subagent-check">
                    <input
                      type="radio"
                      name="subagent-workspace"
                      checked={draft.workspace === 'system'}
                      // Disabled only on a KNOWN absence (#263). A failed read
                      // leaves it usable, because "we could not ask" is not "the
                      // peer has none".
                      disabled={readOnly || systemWorkspace === false}
                      onChange={() => setDraft({ ...draft, workspace: 'system' })}
                    />
                    {t('subagent.workspace.system')}
                  </label>
                </fieldset>
                {draft.workspace === 'registry' && (
                  <>
                    <TargetSelect
                      label={t('subagent.workspaceId')}
                      field={workspaceField}
                      labels={targetLabels}
                      disabled={readOnly}
                      onChange={(value) => {
                        if (value === MANUAL_TARGET_VALUE) {
                          setManual('workspace')
                          return
                        }
                        setManual(undefined)
                        setDraft({
                          ...draft,
                          workspaceId: value,
                          workspaceScope: workspaceScopeOf(draft.device.trim(), draft.agentId.trim()),
                        })
                      }}
                    />
                    {manual === 'workspace' && (
                      <label className="cherry-subagent-field">
                        {t('subagent.workspaceIdManual')}
                        <input
                          type="text"
                          value={draft.workspaceId}
                          disabled={readOnly}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              workspaceId: event.target.value,
                              workspaceScope: workspaceScopeOf(draft.device.trim(), draft.agentId.trim()),
                            })
                          }
                        />
                      </label>
                    )}
                    {workspaceInvalidated && (
                      <p className="cherry-hint">{t('subagent.targets.reselectWorkspace')}</p>
                    )}
                    {workspaceProblem !== undefined && (
                      <p className="cherry-hint">{targetProblemText(t, workspaceProblem)}</p>
                    )}
                  </>
                )}

                <label className="cherry-subagent-field">
                  {t('subagent.timeoutMs')}
                  <input
                    type="number"
                    value={draft.timeoutMs}
                    disabled={readOnly}
                    onChange={(event) => setDraft({ ...draft, timeoutMs: event.target.value })}
                  />
                </label>
                <p className="cherry-hint">{t('subagent.timeoutHint')}</p>

                {/* Read-only on purpose: the field is validated and stored, but
                    nothing reads it yet (D1), so a control that looked like it
                    changed behaviour would be the fake switch again. */}
                <p className="cherry-hint cherry-mono">
                  {t('subagent.cwdMode', { value: data.subagent.cwdMode ?? 'isolated' })}
                </p>

                {/* Editable since #303: `routes` is live (`matchRoute` picks the
                    device and workspace from it), and a table the operator cannot
                    fill in left the only way to use it as hand-editing JSON.
                    Validation is NOT duplicated here — the resolver owns the
                    rules, and a second copy of "absolute, non-root, non-empty"
                    would drift (#280). A bad entry comes back named by its exact
                    path (`routes[0].cwdPrefix`) in the status block above. */}
                <fieldset className="cherry-subagent-routes">
                  <legend>{t('subagent.routes.title')}</legend>
                  <p className="cherry-hint">{t('subagent.routes.hint')}</p>
                  {draft.routes.length === 0 ? (
                    <p className="cherry-hint">{t('subagent.routes.empty')}</p>
                  ) : (
                    draft.routes.map((route, index) => (
                      <div className="cherry-subagent-route" key={index}>
                        <label className="cherry-subagent-field">
                          <span>{t('subagent.routes.cwdPrefix')}</span>
                          <input
                            type="text"
                            className="cherry-subagent-select cherry-mono"
                            aria-label={t('subagent.routes.cwdPrefixLabel', { index: index + 1 })}
                            value={route.cwdPrefix}
                            readOnly={readOnly}
                            onChange={(event) => editRoute(index, { cwdPrefix: event.target.value })}
                          />
                        </label>
                        <label className="cherry-subagent-field">
                          <span>{t('subagent.routes.device')}</span>
                          <input
                            type="text"
                            className="cherry-subagent-select cherry-mono"
                            aria-label={t('subagent.routes.deviceLabel', { index: index + 1 })}
                            value={route.device}
                            readOnly={readOnly}
                            onChange={(event) => editRoute(index, { device: event.target.value })}
                          />
                        </label>
                        <label className="cherry-subagent-field">
                          <span>{t('subagent.routes.workspaceId')}</span>
                          <input
                            type="text"
                            className="cherry-subagent-select cherry-mono"
                            aria-label={t('subagent.routes.workspaceIdLabel', { index: index + 1 })}
                            value={route.workspaceId}
                            readOnly={readOnly}
                            onChange={(event) => editRoute(index, { workspaceId: event.target.value })}
                          />
                        </label>
                        <button
                          type="button"
                          className="cherry-subagent-route-remove"
                          disabled={readOnly}
                          onClick={() => removeRoute(index)}
                        >
                          {t('subagent.routes.remove', { index: index + 1 })}
                        </button>
                      </div>
                    ))
                  )}
                  <button type="button" disabled={readOnly} onClick={() => addRoute()}>
                    {t('subagent.routes.add')}
                  </button>
                </fieldset>
                </>
              )}
              <div className="cherry-scope-save">
                <button type="button" disabled={busy || readOnly} onClick={() => void save()}>
                  {t('subagent.save')}
                </button>
                <button type="button" disabled={busy} onClick={() => void load()}>
                  {t('subagent.reread')}
                </button>
              </div>
            </div>
          )}

          {saved && (
            <p className="cherry-ok" role="status">
              {t('subagent.saved')}
            </p>
          )}
          {failure !== undefined && (
            <p className="cherry-error" role="alert">
              {t('subagent.saveFailed', { cause: failure })}
            </p>
          )}
        </>
      )}
    </section>
  )
}
