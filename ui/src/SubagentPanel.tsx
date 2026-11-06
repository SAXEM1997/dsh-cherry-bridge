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
import type {
  ReceivedShape,
  SubagentClient,
  SubagentConfig,
  SubagentProblem,
  SubagentResponse,
  SubagentSaveRequest,
  SubagentStatus,
  SubagentToolProblem,
} from './types'

/** The panel's only prop; the default is the real same-origin client. */
export interface SubagentPanelProps {
  /** The subagent HTTP seam. Defaults to the same-origin calls. */
  client?: SubagentClient
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
interface Draft {
  enabled: boolean
  device: string
  agentId: string
  workspace: 'registry' | 'system'
  workspaceId: string
  timeoutMs: string
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

export function SubagentPanel({ client = defaultSubagentClient }: SubagentPanelProps): ReturnType<typeof Object> {
  const t = useT()
  const [data, setData] = useState<SubagentResponse | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const accept = useCallback((answer: SubagentResponse) => {
    setData(answer)
    setDraft(draftOf(answer.subagent))
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

  const save = async (): Promise<void> => {
    if (draft === undefined || data === undefined) return
    setBusy(true)
    setSaved(false)
    setFailure(undefined)
    try {
      // The PUT answers the same body the GET does, so the panel replaces its
      // whole state with it: a save that only patched `revision` would leave the
      // status describing the previous apply.
      accept(await client.put(bodyOf(draft, data.subagent)))
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
          <h4>{t('subagent.status.heading')}</h4>
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
          {data.pendingRestart && (
            <p className="cherry-ok" role="status">
              {t('subagent.pendingRestart')}
            </p>
          )}
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

              <label className="cherry-subagent-field">
                {t('subagent.device')}
                <input
                  type="text"
                  value={draft.device}
                  disabled={readOnly}
                  onChange={(event) => setDraft({ ...draft, device: event.target.value })}
                />
              </label>
              <p className="cherry-hint">{t('subagent.deviceHint')}</p>

              <label className="cherry-subagent-field">
                {t('subagent.agentId')}
                <input
                  type="text"
                  value={draft.agentId}
                  disabled={readOnly}
                  onChange={(event) => setDraft({ ...draft, agentId: event.target.value })}
                />
              </label>

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
                    disabled={readOnly}
                    onChange={() => setDraft({ ...draft, workspace: 'system' })}
                  />
                  {t('subagent.workspace.system')}
                </label>
              </fieldset>
              {draft.workspace === 'registry' && (
                <label className="cherry-subagent-field">
                  {t('subagent.workspaceId')}
                  <input
                    type="text"
                    value={draft.workspaceId}
                    disabled={readOnly}
                    onChange={(event) => setDraft({ ...draft, workspaceId: event.target.value })}
                  />
                </label>
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

              {/* Read-only for a DIFFERENT reason than `cwdMode`: `routes` is
                  live (`matchRoute` picks the device and workspace from it),
                  but the page has no editor for a per-directory table, and a
                  bad entry is named in a problem (`routes[0].cwdPrefix`) the
                  operator would otherwise never see. JSON, not a pretty table:
                  it shows exactly the stored value. */}
              <p className="cherry-hint cherry-mono">
                {t('subagent.routes', { value: JSON.stringify(data.subagent.routes ?? []) })}
              </p>

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
