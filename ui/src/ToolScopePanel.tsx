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
 *    the operator's edit; a refusal leaves them exactly where they were (§6.4).
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
 * D11's empty-state wording, one sentence per mode.
 *
 * They are NOT interchangeable: under `selected` an empty list means the tools
 * are enabled nowhere, while under `global` the ticks are not judgement input at
 * all (B2). One sentence for both would state the opposite of the truth in one
 * of the two modes.
 */
export const SELECTED_EMPTY_HINT =
  '尚未启用任何工作区——此状态下 cherry_* 工具不会出现在任何会话里；勾选后对应工作区的会话（含进行中的）即可使用。'
export const GLOBAL_EMPTY_HINT =
  '当前为全局模式：这些工具在所有工作区都可用；下面的勾选仅在切到「仅选定工作区」后才生效。'

/**
 * B15's copy boundary, in the positive form.
 *
 * The page may only claim that THIS PLUGIN did not shadow the tools. Whether a
 * given session sees them can still be decided upstream by an `allow`-shaped
 * filter (a sub-agent's `toolFilter`), which is accepted behaviour — so any
 * "the model can see / call them" phrasing would promise something this plugin
 * cannot keep.
 */
export const EFFECT_NOTE =
  '生效范围内本插件未遮蔽这些 cherry_* 工具；上游的 allow 型过滤（例如子代理的 toolFilter）仍可能让某个会话看不到它们——本页只说明本插件未遮蔽，不对上层过滤的结果作保证。'

/** One line per degradation source; the server's own reason is shown beside it. */
const DEGRADED_LABELS: Record<DegradedSource, string> = {
  install: '工具注册失败（install）：启用范围未生效',
  'workspace-list': '注册表列表当前读不到',
  'visibility-only': '仅可见性降级（缺 tools.guard）：部分会话可能仍看得到这些工具',
  'scope-version': '作用域文档版本高于本插件支持',
  'path-normalization': '路径规范化降级：cwd 比对可能不准确',
}

/**
 * The copy for each stable `PUT` refusal code.
 *
 * `scope-version-unsupported` gets its own recovery sentence: re-reading cannot
 * change the document's version, so sending the operator round that loop would
 * be an instruction that cannot work (§6.3).
 */
const SAVE_FAILURE_LABELS: Record<string, string> = {
  'scope-revision-conflict': '配置已被他处修改，请重新读取后再保存。',
  'scope-version-unsupported':
    '作用域文档版本高于本插件支持：重读不会改变文档版本，请升级宿主 / DSH 或本插件后再试。',
  'invalid-scope': '保存被拒绝：作用域字段非法（mode 必须是 global 或 selected，workspaceIds 必须是字符串数组）。',
  'missing-expected-revision': '保存被拒绝：请求缺少基准 expectedRevision，请重新读取后再保存。',
  'workspace-list-unavailable': '工作区列表当前读不到，无法保存；已存勾选与 mode 一位不动。',
}

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
 */
function resolveEmptyHint(input: {
  loaded: boolean
  mode: ScopeMode
  count: number
  scopeVersionDegraded: boolean
}): string | undefined {
  if (!input.loaded) return undefined
  if (input.mode === 'selected' && input.scopeVersionDegraded) return undefined
  if (input.mode === 'global') return GLOBAL_EMPTY_HINT
  return input.count === 0 ? SELECTED_EMPTY_HINT : undefined
}

export function ToolScopePanel({ client = defaultScopeClient }: ToolScopePanelProps): ReturnType<typeof Object> {
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

  useEffect(() => {
    let live = true
    void client.get().then(
      (response) => {
        if (!live) return
        setData(response)
        setMode(response.scope.mode)
        setIds([...response.scope.workspaceIds])
        setRevision(response.scope.revision)
        setLoadError(undefined)
      },
      (cause: unknown) => {
        if (live) setLoadError(describeCause(cause))
      },
    )
    return () => {
      live = false
    }
  }, [client])

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
      list.push({ id, title: id, path: '（注册表里没有该工作区的信息）' })
    }
    return list
  }, [data, ids])

  // Stale picks are shown only while they are still part of the served document:
  // once a save prunes them, the group is gone and the `pruned` echo says so.
  const staleShown = (data?.staleWorkspaceIds ?? []).filter((id) => ids.includes(id))
  const unmatched = data?.pathUnmatched ?? []

  /**
   * D11's empty state, or nothing at all — see {@link resolveEmptyHint} for the
   * three cases that must stay silent rather than describe a state wrongly.
   */
  const emptyHint = resolveEmptyHint({ loaded, mode, count: ids.length, scopeVersionDegraded })

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
          label: (code === undefined ? undefined : SAVE_FAILURE_LABELS[code]) ?? `保存失败：${describeCause(cause)}`,
          detail: status === undefined ? undefined : `服务端返回 ${code}（HTTP ${status}）。`,
        })
      },
    )
  }, [client, ids, mode, revision])

  return (
    <section className="cherry-panel" aria-labelledby="cherry-scope-title">
      <h3 id="cherry-scope-title">启用范围</h3>

      {loadError !== undefined && (
        <p className="cherry-error" role="alert">
          读取启用范围失败：{loadError}
        </p>
      )}
      {!loaded && loadError === undefined && <p className="cherry-hint">正在读取启用范围…</p>}

      {/* The three independent read-only conditions, each with its own element:
          they can coexist, and none is derived from another (§6.4). */}
      {unsupported && data !== undefined && (
        <p className="cherry-error" role="alert" data-scope-warning="unsupported">
          宿主不支持工具作用域能力（只读告警）：{data.host.reason}。请升级宿主 / DSH 以获得该能力后再试；升级前本插件不会注册这些工具。
        </p>
      )}
      {scopeVersionDegraded && (
        <p className="cherry-error" role="alert" data-scope-warning="scope-version">
          作用域文档版本高于本插件支持，已进入只读降级：保存被禁用。重读仍是同一份文档，请升级宿主 / DSH 或本插件后再试。
        </p>
      )}
      {listUnavailable && (
        <p className="cherry-error" role="alert" data-scope-warning="workspace-list">
          注册表列表当前读不到，已禁用保存（原因见下方降级标注）。
        </p>
      )}
      {/* The NEUTRAL waiting note: it must not read as a refusal, so it carries
          neither "不支持" nor any upgrade instruction (D9). */}
      {pending && (
        <p className="cherry-hint" role="status" data-scope-notice="pending">
          宿主服务挂载中，稍后自动就绪；此期间的配对与设备管理照常可用。
        </p>
      )}

      {/* B12/B16/B17: EVERY note, one element each — different sources coexist
          and the last one must never overwrite the others. */}
      {degraded.length > 0 && (
        <ul className="cherry-scope-degraded">
          {degraded.map((note: DegradedNote, index) => (
            <li key={`${note.source}:${index}`} data-degraded-source={note.source}>
              <strong>{DEGRADED_LABELS[note.source] ?? note.source}</strong>
              <span className="cherry-hint">：{note.reason}</span>
            </li>
          ))}
        </ul>
      )}

      <fieldset className="cherry-scope-modes">
        <legend>模式</legend>
        <label>
          <input type="radio" name="cherry-scope-mode" checked={mode === 'global'} onChange={() => setMode('global')} />
          全局
        </label>
        <label>
          <input
            type="radio"
            name="cherry-scope-mode"
            checked={mode === 'selected'}
            onChange={() => setMode('selected')}
          />
          仅选定工作区
        </label>
      </fieldset>

      <p className="cherry-hint">{EFFECT_NOTE}</p>

      {options.length === 0
        ? !listUnavailable && <p className="cherry-hint">当前没有任何已注册的工作区。</p>
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
            <strong>已失效（工作区已删除）</strong>
          </p>
          <ul>
            {staleShown.map((id) => (
              <li key={id} className="cherry-mono">
                {id}
              </li>
            ))}
          </ul>
          <p className="cherry-hint">这些 id 在注册表里已不存在；保存时由服务端修剪，不会被判为非法输入。</p>
          <button type="button" onClick={save} disabled={saveDisabled}>
            清除已失效选择
          </button>
        </div>
      )}

      {/* §6.1's diagnosis, NOT an input: it explains "ticked, yet no tools" and
          changes neither the draft nor the document. Kept apart from the stale
          group on purpose — the two answer different questions. */}
      {unmatched.length > 0 && (
        <div className="cherry-scope-unmatched" data-scope-unmatched="">
          <p>
            <strong>已勾选但会话 cwd 对不上</strong>
          </p>
          <ul>
            {unmatched.map((entry, index) => (
              <li key={`${entry.agentId}:${index}`} className="cherry-mono">
                {entry.agentId} — {entry.cwd}
              </li>
            ))}
          </ul>
          <p className="cherry-hint">
            这些会话勾选了工作区却拿不到工具：拼写不同 / 符号链接 / 该目录确实未注册，这三种原因在这里无法区分。本条只解释原因，不改动勾选或模式，也不会触发保存。
          </p>
        </div>
      )}

      <div className="cherry-scope-save">
        <button type="button" onClick={save} disabled={saveDisabled}>
          保存启用范围
        </button>
        <p className="cherry-hint cherry-mono" data-scope-revision={revision}>
          当前 revision：{revision}
        </p>
        {saved !== undefined && (
          <p className="cherry-ok" role="status" data-scope-saved="">
            {saved.pruned.length === 0
              ? '保存成功。'
              : `保存成功，按服务端修剪清除了失效选择：${saved.pruned.join('、')}。`}
          </p>
        )}
        {failure !== undefined && (
          <div data-scope-save-error={failure.code}>
            <p className="cherry-error" role="alert">
              {failure.label}
            </p>
            {failure.detail !== undefined && <p className="cherry-hint cherry-mono">{failure.detail}</p>}
          </div>
        )}
      </div>
    </section>
  )
}
