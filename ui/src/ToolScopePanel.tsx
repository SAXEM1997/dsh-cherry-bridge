/**
 * The 「启用范围」 panel: which workspaces the `cherry_*` tools appear in.
 *
 * The panel is a READ-MODIFY-WRITE client of the scope document (spec §6.3), and
 * three contract details shape everything below:
 *
 *  - **Every verdict comes from a stable code, never from prose.** A refused
 *    `PUT` arrives as an {@link ApiError} whose `code` is the server's
 *    (`invalid-scope` / `missing-expected-revision` / `scope-revision-conflict` /
 *    `workspace-list-unavailable` / `scope-version-unsupported`), and the copy
 *    per branch is the panel's own. The prose is deliberately not echoed: a
 *    refusal resolved against a message would break the moment the server's
 *    wording changed, and `scope-version-unsupported` must never read as "just
 *    re-read and retry" — re-reading cannot change the document's version.
 *  - **A failure never moves the draft.** The local `mode`/`workspaceIds` are
 *    the operator's edit; a refusal leaves them exactly where they were (§6.4),
 *    and it triggers no re-read either — re-seeding overwrites those ticks, so
 *    the conflict's recovery is an explicit click on the control the conflict
 *    arm carries (see `reread`).
 *  - **Disabling the save has THREE independent sources** — `unsupported`,
 *    the `scope-version` degradation and the `workspace-list` degradation — and
 *    `pending` is none of them. They may appear side by side and none may be
 *    derived from another, so the notices are rendered from independent
 *    conditions rather than from one combined verdict.
 *
 * `staleWorkspaceIds` and `pathUnmatched` are separated for the same reason: the
 * first is a saved pick the registry no longer has (cleared only by a save, whose
 * `pruned` echo the panel shows), the second is a pure diagnosis of "ticked, yet
 * no tools" that changes nothing and triggers no write.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, defaultScopeClient } from './api'
import { useT } from './i18n'
import type { T } from './i18n'
import type {
  DegradedNote,
  DegradedSource,
  ScopeClient,
  ScopeMode,
  ScopeResponse,
  ScopeSaveResult,
  ScopeWorkspace,
} from './types'

/** The panel's only prop; the default is the real same-origin client. */
export interface ToolScopePanelProps {
  /** The scope HTTP seam. Defaults to the same-origin `fetch` calls. */
  client?: ScopeClient
}

/**
 * D11's empty-state wording, one sentence per mode, as dictionary KEYS.
 *
 * They are NOT interchangeable: under `selected` an empty list means the tools
 * are enabled nowhere, while under `global` the ticks are not judgement input at
 * all (B2). One sentence for both would state the opposite of the truth in one
 * of the two modes.
 *
 * Keys, not text: `resolveEmptyHint` is a module-level function and cannot reach
 * the component's `t`, so it takes the translator as a parameter and looks the
 * sentence up through these.
 */
const SELECTED_EMPTY_KEY = 'scope.empty.selected'
const GLOBAL_EMPTY_KEY = 'scope.empty.global'

/**
 * B15's copy boundary, in the positive form, as a dictionary KEY.
 *
 * The page may only claim that THIS PLUGIN did not shadow the tools. Whether a
 * given session sees them can still be decided upstream by an `allow`-shaped
 * filter (a sub-agent's `toolFilter`), which is accepted behaviour — so any
 * "the model can see / call them" phrasing would promise something this plugin
 * cannot keep.
 */
const EFFECT_NOTE_KEY = 'scope.effectNote'

/**
 * One line per degradation source, as a module-level PURE KEY table; the
 * server's own reason is shown beside it.
 *
 * `install` is the general one — its four writers cover a `schemas()` read that
 * could not compute a target, a layer whose release threw, an agent with no
 * `agent.ctx.tools.restrict`, and a `restrict()` the host refused (the `reason`
 * says which) — so the line states the CONSEQUENCE common to all four rather
 * than any one cause. It says 曾 on purpose: the note is append-only (cleared
 * only by a successful workspace-list read), so after a recovered round the
 * surviving claim is that one application failed earlier in this session.
 *
 * The values are KEYS and only keys: the table is read at MODULE scope (the
 * render below) and inside `resolveEmptyHint`, where no `t` exists, so it must
 * not close over one. The text itself lives in `ui/src/i18n.ts`, the single
 * source of truth for every Chinese string the page shows.
 */
const DEGRADED_KEYS: Record<DegradedSource, string> = {
  install: 'scope.degraded.install',
  'workspace-list': 'scope.degraded.workspace-list',
  'visibility-only': 'scope.degraded.visibility-only',
  'scope-version': 'scope.degraded.scope-version',
  'path-normalization': 'scope.degraded.path-normalization',
}

/**
 * The dictionary KEYS for each stable `PUT` refusal code.
 *
 * `scope-revision-conflict` is the ONE refusal whose copy and whose control
 * agree: its message instructs a RE-READ, and its rendering carries the control
 * that performs it (`reread`) — an instruction with no way to follow it is how
 * the operator ends up re-sending the same stale revision forever. Two codes
 * instruct a re-read in their wording (this one and `missing-expected-revision`,
 * below), but only this one is REACHABLE from this panel: `save` always sends a
 * base (`expectedRevision: revision`), so the missing-base refusal exists for a
 * direct API caller and can never fire here. Reachability — not any claim about
 * which codes a stale read would refresh — is why the control belongs to this
 * arm, and to this arm only.
 *
 * `scope-version-unsupported` gets its own recovery sentence: re-reading cannot
 * change the document's version, so sending the operator round that loop would
 * be an instruction that cannot work (§6.3).
 *
 * A key table rather than a text table, for the same reason as
 * {@link DEGRADED_KEYS}: it is consumed inside `save`'s `useCallback`, which
 * reads the component's `t` (a dependency of that callback) — a text table here
 * would be a second copy of the Chinese in a file that is meant to hold none.
 * An unknown code falls through to {@link SAVE_FAILED_KEY}, whose `{cause}`
 * placeholder carries the server's own message.
 */
const SAVE_FAILURE_KEYS: Record<string, string> = {
  'scope-revision-conflict': 'scope.saveFailure.scope-revision-conflict',
  'scope-version-unsupported': 'scope.saveFailure.scope-version-unsupported',
  'invalid-scope': 'scope.saveFailure.invalid-scope',
  'missing-expected-revision': 'scope.saveFailure.missing-expected-revision',
  'workspace-list-unavailable': 'scope.saveFailure.workspace-list-unavailable',
}

/**
 * The refusal copy for a code this panel has no entry for.
 *
 * Deliberately NOT in {@link SAVE_FAILURE_KEYS}: it is the `??` arm rather than
 * a sixth code, and keeping it out is what makes "every entry is a real server
 * code" checkable by eye.
 */
const SAVE_FAILED_KEY = 'scope.saveFailed'

interface SaveFailure {
  code: string
  label: string
  /** The server's own code/status, shown for diagnosis beside the copy above. */
  detail?: string
}

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * D11's empty state for the current draft, or `undefined` when nothing may be
 * claimed yet.
 *
 * Three exclusions, each of which would otherwise let the sentence contradict
 * the state it describes:
 *
 *  - **before the read lands** the draft only LOOKS empty (it is seeded by that
 *    read), and "这些工具不会出现在任何会话里" would be a claim about a document
 *    nobody has read;
 *  - **while the document's version is unsupported** the reason is a degradation
 *    with its own warning, not the operator's empty selection;
 *  - hence only a READ document reaches the two sentences below — where an empty
 *    `selected` list is exactly what a CORRUPT document falls back to (B9), which
 *    is why that warning shares this one slot rather than getting a region of its
 *    own.
 *
 * `t` is a PARAMETER rather than a module-level import: this function is called
 * during a render with the component's own translator, and `t` changes identity
 * whenever the locale store does — closing over a module-level one would pin the
 * sentence to whatever language was active when the module first loaded.
 */
function resolveEmptyHint(
  input: {
    loaded: boolean
    mode: ScopeMode
    count: number
    scopeVersionDegraded: boolean
  },
  t: T,
): string | undefined {
  if (!input.loaded) return undefined
  if (input.mode === 'selected' && input.scopeVersionDegraded) return undefined
  if (input.mode === 'global') return t(GLOBAL_EMPTY_KEY)
  return input.count === 0 ? t(SELECTED_EMPTY_KEY) : undefined
}

export function ToolScopePanel({ client = defaultScopeClient }: ToolScopePanelProps): ReturnType<typeof Object> {
  const t = useT()
  const [data, setData] = useState<ScopeResponse | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  // The DRAFT: what the operator has selected on screen. Seeded from the served
  // document and replaced only by a successful save's own answer.
  const [mode, setMode] = useState<ScopeMode>('selected')
  const [ids, setIds] = useState<string[]>([])
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<{ pruned: string[] } | undefined>(undefined)
  const [failure, setFailure] = useState<SaveFailure | undefined>(undefined)
  // A `PUT` refused with `scope-version-unsupported` is the read-only
  // degradation arriving through the write path: the save stays disabled.
  const [versionBlocked, setVersionBlocked] = useState(false)

  /**
   * The ONE place a served document becomes the draft.
   *
   * Shared by the mount read and the operator-requested re-read so the two
   * cannot drift: `mode`, the ticked ids and — the reason this is a function at
   * all — the `revision` the NEXT save bases itself on all come from the
   * response in one step.
   */
  const seedFromDocument = useCallback((response: ScopeResponse): void => {
    setData(response)
    setMode(response.scope.mode)
    setIds([...response.scope.workspaceIds])
    setRevision(response.scope.revision)
    setLoadError(undefined)
  }, [])

  useEffect(() => {
    let live = true
    void client.get().then(
      (response) => {
        if (!live) return
        seedFromDocument(response)
      },
      (cause: unknown) => {
        if (live) setLoadError(describeCause(cause))
      },
    )
    return () => {
      live = false
    }
  }, [client, seedFromDocument])

  const degraded = data?.host.degraded ?? []
  // A plain predicate, not a memo: `degraded` is projected afresh each render,
  // and the two answers below are read during that same render.
  const hasDegraded = (source: DegradedSource): boolean => degraded.some((note) => note.source === source)
  const unsupported = data?.host.state === 'unsupported'
  const pending = data?.host.state === 'pending'
  const scopeVersionDegraded = hasDegraded('scope-version')
  const listUnavailable = hasDegraded('workspace-list')
  const loaded = data !== undefined

  // The three independent sources of "save is disabled" (§6.4) plus the write
  // that is in flight. `pending` is deliberately NOT one of them.
  const saveDisabled = busy || !loaded || unsupported || scopeVersionDegraded || listUnavailable || versionBlocked

  /** The rows the operator can tick: registry workspaces, plus unnamed saved ids. */
  const options = useMemo((): ScopeWorkspace[] => {
    const list: ScopeWorkspace[] = [...(data?.workspaces ?? [])]
    const known = new Set(list.map((workspace) => workspace.id))
    const stale = new Set(data?.staleWorkspaceIds ?? [])
    // A ticked id the registry cannot name — the list is unreadable, or the host
    // is still mounting — must stay VISIBLE. Dropping it would let a save turn
    // "I cannot read the list" into "you had nothing ticked".
    for (const id of ids) {
      if (known.has(id) || stale.has(id)) continue
      list.push({ id, title: id, path: t('scope.workspaceUnknown') })
    }
    return list
  }, [data, ids, t])

  // Stale picks are shown only while they are still part of the served document:
  // once a save prunes them, the group is gone and the `pruned` echo says so.
  const staleShown = (data?.staleWorkspaceIds ?? []).filter((id) => ids.includes(id))
  const unmatched = data?.pathUnmatched ?? []

  /**
   * D11's empty state, or nothing at all — see {@link resolveEmptyHint} for the
   * three cases that must stay silent rather than describe a state wrongly.
   */
  const emptyHint = resolveEmptyHint({ loaded, mode, count: ids.length, scopeVersionDegraded }, t)

  const toggle = (id: string): void => {
    setIds((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))
  }

  const save = useCallback((): void => {
    setBusy(true)
    setFailure(undefined)
    setSaved(undefined)
    void client.put({ mode, workspaceIds: [...ids], expectedRevision: revision }).then(
      (result: ScopeSaveResult) => {
        setBusy(false)
        setSaved({ pruned: [...(result.pruned ?? [])] })
        // The server's answer is authoritative: the pruned ids are gone from the
        // document, and the revision the NEXT write must base itself on is this
        // one (§6.4's last sentence).
        setMode(result.scope.mode)
        setIds([...result.scope.workspaceIds])
        setRevision(result.scope.revision)
        setVersionBlocked(false)
      },
      (cause: unknown) => {
        setBusy(false)
        // NOTHING else is touched here: a refusal leaves mode and ticks exactly
        // as the operator left them (§6.4).
        const code = cause instanceof ApiError ? cause.code : undefined
        const status = cause instanceof ApiError ? cause.status : undefined
        if (code === 'scope-version-unsupported') setVersionBlocked(true)
        setFailure({
          code: code ?? 'request-failed',
          // ONE whole-sentence template per branch (§5.3): the known code's copy
          // and the unknown code's `保存失败：{cause}` are each a single key with
          // its params supplied — never a prefix glued to an interpolated tail.
          // An unknown code therefore falls to `SAVE_FAILED_KEY`'s template with
          // `{cause}` filled, not to a bare `保存失败：`.
          label: code === undefined
            ? t(SAVE_FAILED_KEY, { cause: describeCause(cause) })
            : t(SAVE_FAILURE_KEYS[code] ?? SAVE_FAILED_KEY, { cause: describeCause(cause) }),
          detail: status === undefined ? undefined : t('scope.serverSaid', { code: code!, status }),
        })
      },
    )
  }, [client, ids, mode, revision, t])

  /**
   * The operator-requested RE-READ: the conflict's own recovery (§6.4).
   *
   * A 409 tells the operator to re-read, so the panel must be able to do it —
   * the mount read is otherwise the page's only `GET`, which leaves every later
   * save re-sending the same stale `revision` and 409-ing until a full reload.
   *
   * Nothing here runs automatically on a refusal: re-seeding REPLACES the draft,
   * so doing it silently in response to a failed save would discard exactly the
   * edit that caused the conflict. It runs only from the control below — and
   * because it re-seeds, it also replaces the `revision` the next `PUT` sends.
   *
   * The conflict message is cleared only once the read SUCCEEDS: if the `GET`
   * itself fails the conflict still stands, the control stays on screen, and
   * `loadError` says what went wrong.
   */
  const reread = useCallback((): void => {
    setBusy(true)
    void client.get().then(
      (response) => {
        setBusy(false)
        seedFromDocument(response)
        setFailure(undefined)
      },
      (cause: unknown) => {
        setBusy(false)
        setLoadError(describeCause(cause))
      },
    )
  }, [client, seedFromDocument])

  return (
    <section className="cherry-panel" aria-labelledby="cherry-scope-title">
      <h3 id="cherry-scope-title">{t('scope.heading')}</h3>

      {loadError !== undefined && (
        <p className="cherry-error" role="alert">
          {/* {error} is the server's own message: interpolated, never translated. */}
          {t('scope.loadError', { error: loadError })}
        </p>
      )}
      {!loaded && loadError === undefined && <p className="cherry-hint">{t('scope.loading')}</p>}

      {/* The three independent read-only conditions, each with its own element:
          they can coexist, and none is derived from another (§6.4). */}
      {unsupported && data !== undefined && (
        <p className="cherry-error" role="alert" data-scope-warning="unsupported">
          {/* {reason} is the host's own prose and stays verbatim. */}
          {t('scope.unsupported', { reason: data.host.reason })}
        </p>
      )}
      {scopeVersionDegraded && (
        <p className="cherry-error" role="alert" data-scope-warning="scope-version">
          {t('scope.versionDegraded')}
        </p>
      )}
      {listUnavailable && (
        <p className="cherry-error" role="alert" data-scope-warning="workspace-list">
          {t('scope.listUnavailable')}
        </p>
      )}
      {/* The NEUTRAL waiting note: it must not read as a refusal, so it carries
          neither "不支持" nor any upgrade instruction (D9). */}
      {pending && (
        <p className="cherry-hint" role="status" data-scope-notice="pending">
          {t('scope.pending')}
        </p>
      )}

      {/* B12/B16/B17: EVERY note, one element each — different sources coexist
          and the last one must never overwrite the others. */}
      {degraded.length > 0 && (
        <ul className="cherry-scope-degraded">
          {degraded.map((note: DegradedNote, index) => (
            <li key={`${note.source}:${index}`} data-degraded-source={note.source}>
              {/* ONE node, ONE sentence: the label and the server's reason are
                  merged by the template rather than by two adjacent elements.
                  `?? note.source` keeps an unknown source visible as itself. */}
              {t('scope.degradedLine', { label: t(DEGRADED_KEYS[note.source] ?? note.source), reason: note.reason })}
            </li>
          ))}
        </ul>
      )}

      <fieldset className="cherry-scope-modes">
        <legend>{t('scope.mode.legend')}</legend>
        <label>
          <input type="radio" name="cherry-scope-mode" checked={mode === 'global'} onChange={() => setMode('global')} />
          {t('scope.mode.global')}
        </label>
        <label>
          <input
            type="radio"
            name="cherry-scope-mode"
            checked={mode === 'selected'}
            onChange={() => setMode('selected')}
          />
          {t('scope.mode.selected')}
        </label>
      </fieldset>

      <p className="cherry-hint">{t(EFFECT_NOTE_KEY)}</p>

      {options.length === 0
        ? !listUnavailable && <p className="cherry-hint">{t('scope.noWorkspaces')}</p>
        : (
          <ul className="cherry-scope-options">
            {options.map((workspace) => (
              <li key={workspace.id}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`${workspace.title} ${workspace.path}`}
                    checked={ids.includes(workspace.id)}
                    onChange={() => toggle(workspace.id)}
                  />
                  <span className="cherry-scope-option-title">{workspace.title}</span>
                  <span className="cherry-hint cherry-mono">{workspace.path}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

      {/* The ONE wording slot above: the mode-appropriate D11 sentence, or the
          corrupt document's honest reading of `selected` + an empty list (B9). */}
      {emptyHint !== undefined && (
        <p className="cherry-hint" data-scope-empty={mode}>
          {emptyHint}
        </p>
      )}

      {/* B14: the stale picks, with the one-click clear. The clear is a SAVE —
          registry-external ids are pruned by the `PUT`, which §6.4 makes the
          only path that clears them — and the group disappears with the
          document the server returns. */}
      {staleShown.length > 0 && (
        <div className="cherry-scope-stale" data-scope-stale="">
          <p>
            <strong>{t('scope.stale.heading')}</strong>
          </p>
          <ul>
            {staleShown.map((id) => (
              <li key={id} className="cherry-mono">
                {id}
              </li>
            ))}
          </ul>
          <p className="cherry-hint">{t('scope.stale.note')}</p>
          <button type="button" onClick={save} disabled={saveDisabled}>
            {t('scope.stale.clear')}
          </button>
        </div>
      )}

      {/* §6.1's diagnosis, NOT an input: it explains "ticked, yet no tools" and
          changes neither the draft nor the document. Kept apart from the stale
          group on purpose — the two answer different questions. */}
      {unmatched.length > 0 && (
        <div className="cherry-scope-unmatched" data-scope-unmatched="">
          <p>
            <strong>{t('scope.unmatched.heading')}</strong>
          </p>
          <ul>
            {unmatched.map((entry, index) => (
              <li key={`${entry.agentId}:${index}`} className="cherry-mono">
                {entry.agentId} — {entry.cwd}
              </li>
            ))}
          </ul>
          <p className="cherry-hint">{t('scope.unmatched.note')}</p>
        </div>
      )}

      <div className="cherry-scope-save">
        <button type="button" onClick={save} disabled={saveDisabled}>
          {t('scope.save')}
        </button>
        <p className="cherry-hint cherry-mono" data-scope-revision={revision}>
          {t('scope.revision', { revision })}
        </p>
        {saved !== undefined && (
          <p className="cherry-ok" role="status" data-scope-saved="">
            {saved.pruned.length === 0
              ? t('scope.saved')
              : t('scope.savedPruned', { list: saved.pruned.join(t('list.separator')) })}
          </p>
        )}
        {failure !== undefined && (
          <div data-scope-save-error={failure.code}>
            <p className="cherry-error" role="alert">
              {failure.label}
            </p>
            {/* The conflict arm's OWN recovery: its copy instructs a re-read, so
                the control that performs one belongs here. Two codes' copy
                instructs a re-read — this one and `missing-expected-revision` —
                but only this code is reachable from this panel, whose `save`
                always sends `expectedRevision: revision`; the missing-base
                refusal exists for a direct API caller, so offering the control
                there would be a button this page can never make useful. */}
            {failure.code === 'scope-revision-conflict' && (
              <button type="button" onClick={reread} disabled={busy}>
                {t('scope.reread')}
              </button>
            )}
            {failure.detail !== undefined && <p className="cherry-hint cherry-mono">{failure.detail}</p>}
          </div>
        )}
      </div>
    </section>
  )
}
