import { readFileSync } from 'node:fs'

import { writeFileAtomicSync } from './atomicFile.js'

/**
 * The scope document and its storage side: parsing, the visibility strictness
 * order, the atomic write, the `degraded` note set and the write-side guard
 * rails (spec §6.1 first half; B9/B14/B16 storage side).
 *
 * The document answers one question — which workspaces see the 14 `cherry_*`
 * tools — and everything here serves making that answer fail-closed without
 * ever silently inventing one. Three rules carry that:
 *
 *  1. **Every unreadable or invalid document falls to the STRICT side**
 *     (`selected` + empty list, i.e. nobody), never to `global`: 静默损坏 is an
 *     explicit anti-goal (spec §3). The strictness order is
 *     `selected + []` > `selected + [W]` > `global`, and every "cannot read /
 *     cannot decide" path lands on the stricter side of it (B9).
 *  2. **A document version this plugin does not understand is a READ-ONLY
 *     degradation**: it is never overwritten (the plugin has no mandate to
 *     rewrite a newer format), it gets its own `scope-version` note and its own
 *     stable refusal code, and it is explicitly NOT the parse path — a
 *     type-invalid `version` is the parse path (warn + strictness order, still
 *     writable). The two sides are separate because their remedies differ.
 *  3. **The authoritative state is in memory**: the file is read once, and
 *     `save()` completes validate → prune → revision+1 → write → swap without a
 *     single `await`, so the HTTP critical section (§6.3) cannot be interleaved.
 *
 * Ownership: this module owns the scope document, the `degraded` set, and (from
 * Task 3 on) the canonical path map, the per-agent judgement cache and the
 * installed-layer records. `guard` reads ONLY the installed-layer records — the
 * layer is present ⇒ deny — and never recomputes a judgement (G4/B6). No other
 * module may keep a copy of any of it.
 */

/** The only `version` this build reads and writes. */
export const SCOPE_DOC_VERSION = 1

/** `global` sees every workspace; `selected` sees exactly `workspaceIds`. */
export type ScopeMode = 'global' | 'selected'

/**
 * The persisted scope document.
 *
 * `workspaceIds` is the de-duplicated, ascending-by-string-comparison form
 * produced by {@link normalizeScope}; `updatedAt` is optional and deliberately
 * absent from {@link DEFAULT_SCOPE} so that "a fresh state equals the default"
 * is assertable as a whole-object comparison (D3: 谁都不给).
 */
export interface ScopeDoc {
  version: number
  revision: number
  updatedAt?: string
  mode: ScopeMode
  workspaceIds: string[]
}

/**
 * The default scope: nobody, write-enabled.
 *
 * This is what a missing file reads as (first run), and it is also the exact
 * shape every unreadable/invalid document falls back to. It carries NO
 * `updatedAt` key — the absence is load-bearing, because assertion ① compares
 * a fresh state's document to this constant with a deep-equality check.
 */
export const DEFAULT_SCOPE: ScopeDoc = {
  version: SCOPE_DOC_VERSION,
  revision: 0,
  mode: 'selected',
  workspaceIds: [],
}

/**
 * The five, fixed degradation sources.
 *
 * Deliberately five: a parse failure or an invalid field has NO member here. Its
 * carrier is the existing warn channel (`log`, else `console.warn`) plus the
 * strictness order, and its document stays writable (B9) — unlike
 * `scope-version`, which is the dedicated "the document is newer than this
 * plugin" read-only degradation, and unlike `workspace-list`, which blocks the
 * write entirely.
 */
export type DegradedSource =
  | 'install'
  | 'workspace-list'
  | 'visibility-only'
  | 'scope-version'
  | 'path-normalization'

/** One degradation note. Same source ⇒ one note (the latest reason wins). */
export interface DegradedNote {
  source: DegradedSource
  reason: string
}

/** One workspace as the settings page needs it, already boundary-normalized. */
export interface ScopeWorkspace {
  id: string
  title: string
  path: string
  sessionIds: readonly string[]
}

/** The host capability tri-state; `capable` is only `state === 'ready'`. */
export interface ScopeHostState {
  state: 'pending' | 'unsupported' | 'ready'
  capable: boolean
  reason: string
}

/**
 * One installed restriction layer, as recorded by the host integration layer:
 * the deny set it was installed with, and the judgement reason it carries.
 * `guard` reads this record (and only this) to decide 层在 ⇒ 拒绝.
 */
export interface MountedLayer {
  deny: readonly string[]
  reason: string
}

/**
 * The four resolution states of one session → workspace judgement (§6.1/D14):
 * a canonical-path hit, a failed resolution (registry not ready, a directory
 * that is momentarily unreachable, a realpath failure — the ONLY state D14's
 * bounded recheck starts from), a session header without a `cwd`, and a
 * resolution that succeeded but belongs to no registered workspace.
 */
export type ResolutionStatus = 'resolved' | 'unresolved' | 'no-cwd' | 'no-match'

/**
 * One agent's judgement, as produced by one generation of `rebuild()`.
 *
 * `visible` is NOT derived from `status`: it is `isVisible(doc, workspaceId)`
 * and nothing else, so under `global` every state is visible (B2) while
 * `selected` fails closed. `reason` names the workspace (title or id) whenever
 * there is one — Task 5 copies it into the installed-layer record, and `guard`
 * echoes it back without recomputing anything (B6).
 */
export interface AgentJudgement {
  agentId: string
  status: ResolutionStatus
  workspaceId?: string
  visible: boolean
  reason: string
  cwd?: string
}

/** The slice of a live agent the judgement needs (`agent.session.header.cwd`). */
export interface ScopeAgentLike {
  id: string
  cwd?: string
}

/**
 * The workspace registry as this module consumes it.
 *
 * `resolveByPath` follows the REAL contract (§4): it resolves to the registry
 * ENTITY (an object with `id`/`path`), resolves to `undefined` for a directory
 * the host does not own, and REJECTS for a path that is missing. It is never a
 * path-string transformer. An old host has no such method at all — that is the
 * degradation D14 describes.
 */
export interface WorkspaceRegistryLike {
  list(): unknown
  resolveByPath?(path: string): Promise<unknown | undefined>
}

/** What one `rebuild()` produced, for the host layer's logging and diagnostics. */
export interface RebuildSummary {
  listAvailable: boolean
  agents: number
  resolved: number
  unresolved: number
  pathUnmatched: number
}

/**
 * The result of a write attempt.
 *
 * The failure arm carries the stable error code and the status the HTTP face
 * returns verbatim; the success arm carries the very document that was stored
 * (not a copy) plus the ids dropped as no longer in the registry.
 */
export type SaveResult =
  | { ok: true; doc: ScopeDoc; pruned: string[] }
  | { ok: false; status: 400 | 409 | 503; error: string; message: string }

/** The id comparison contract: `String(value).trim()`, on both sides. */
export function normalizeWorkspaceId(value: unknown): string {
  return String(value).trim()
}

/**
 * Boundary normalization of one registry item.
 *
 * The registry's return type is not ours to assume (its ids are not guaranteed
 * to be strings), so every text field goes through `String(...)`: an item with
 * no usable id or path is `undefined` and is dropped by the caller, while
 * `sessionIds` that is not an array degrades to `[]` rather than throwing.
 */
export function toScopeWorkspace(raw: unknown): ScopeWorkspace | undefined {
  if (!isRecord(raw)) return undefined

  const id = usableText(raw.id)
  if (id === undefined) return undefined

  const path = usableText(raw.path)
  if (path === undefined) return undefined

  return {
    id,
    title: raw.title === undefined || raw.title === null ? '' : String(raw.title),
    path,
    sessionIds: Array.isArray(raw.sessionIds) ? raw.sessionIds.map((value) => String(value)) : [],
  }
}

/**
 * The visibility strictness order (B9), and the single implementation of it that
 * the visibility layer, diagnostics, the settings page and the tests share.
 *
 * `global` is visible for any id — including `undefined`, which is why a
 * `global` document never installs a deny layer even when no judgement exists.
 * `selected` is fail-closed: a hit is visible, and a miss, `undefined`, or an
 * empty list is not. Both sides of the comparison are normalized through
 * {@link normalizeWorkspaceId} first; normalizing still unequal means "not a
 * match" — no case folding and no path-level guessing.
 */
export function isVisible(
  doc: Pick<ScopeDoc, 'mode' | 'workspaceIds'>,
  workspaceId: string | undefined,
): boolean {
  if (doc.mode === 'global') return true
  if (workspaceId === undefined) return false

  const wanted = normalizeWorkspaceId(workspaceId)
  return doc.workspaceIds.some((id) => normalizeWorkspaceId(id) === wanted)
}

/**
 * One judgement record.
 *
 * `visible` is computed in exactly this one place, from {@link isVisible} alone
 * — never from `status`, and never from the list's health or the presence of a
 * `cwd`. The optional fields are OMITTED when absent rather than set to
 * `undefined`, so `Object.hasOwn` still tells "there is no workspace" from
 * "there is one".
 */
function judged(
  doc: Pick<ScopeDoc, 'mode' | 'workspaceIds'>,
  agent: ScopeAgentLike,
  status: ResolutionStatus,
  workspaceId: string | undefined,
  reason: string,
): AgentJudgement {
  return {
    agentId: agent.id,
    status,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    visible: isVisible(doc, workspaceId),
    reason,
    ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
  }
}

/**
 * A workspace as a `reason` fragment: the title when the registry supplied one,
 * and always the id. Task 5 writes this reason into the installed-layer record
 * and `guard` echoes it back, so it has to name a workspace a reader can resolve
 * — the tuple is what makes that true for a titleless item (B6).
 */
function describeWorkspace(workspace: Pick<ScopeWorkspace, 'id' | 'title'>): string {
  return workspace.title === ''
    ? `工作区 ${workspace.id}`
    : `工作区「${workspace.title}」(${workspace.id})`
}

/**
 * The one "input → normalized document" entry point; both `load()` and `save()`
 * go through it, so the document shape exists in exactly one place.
 *
 * `input` is either the text read from disk or an already-parsed value.
 *  - unparsable text, a type-invalid `version` (missing / non-numeric / a
 *    string), or any other invalid field ⇒ `problem: 'parse'` and the STRICT
 *    side (`selected` + empty): the caller warns through the existing carrier
 *    and the document stays writable (B9);
 *  - a type-legal `version` other than {@link SCOPE_DOC_VERSION} ⇒
 *    `problem: 'version-unsupported'`, the same strict side, and a read-only
 *    degradation the caller records (never a silent "the user selected
 *    nothing"). That branch is decided by `version` ALONE, before the remaining
 *    field checks: a newer format plausibly carries fields this build cannot
 *    parse, and letting that combination read as a parse failure would hand a
 *    newer document back as WRITABLE — the exact opposite of the latch's
 *    purpose;
 *  - otherwise the normalized document, with `workspaceIds` de-duplicated and
 *    stably sorted ascending by string comparison. The stored literals are
 *    never rewritten — comparison normalization is `isVisible`'s job.
 *
 * `parseScopeDoc` deliberately does not exist as a separate export: this is the
 * only entry, module-internal helpers included.
 */
export function normalizeScope(input: unknown): {
  doc: ScopeDoc
  problem?: 'parse' | 'version-unsupported'
} {
  const parsed = parseScopeInput(input)
  if (!parsed.ok) return { doc: strictScope(), problem: 'parse' }

  const value = parsed.value
  if (!isRecord(value)) return { doc: strictScope(), problem: 'parse' }

  const { version, revision } = value
  if (!isFiniteNumber(version)) return { doc: strictScope(), problem: 'parse' }

  // Before every other field check: a type-legal version that is not ours is the
  // READ-ONLY side, and the rest of such a document may be an evolved shape this
  // build cannot parse — which must not make it writable.
  if (version !== SCOPE_DOC_VERSION) return { doc: strictScope(), problem: 'version-unsupported' }

  if (!isFiniteNumber(revision)) return { doc: strictScope(), problem: 'parse' }

  const fields = readScopeFields(value)
  if (fields === undefined) return { doc: strictScope(), problem: 'parse' }

  const updatedAt = value.updatedAt
  if (updatedAt !== undefined && typeof updatedAt !== 'string') {
    return { doc: strictScope(), problem: 'parse' }
  }

  return {
    doc:
      updatedAt === undefined
        ? { version, revision, mode: fields.mode, workspaceIds: fields.workspaceIds }
        : { version, revision, updatedAt, mode: fields.mode, workspaceIds: fields.workspaceIds },
  }
}

/** A fresh strict-side document (never the shared `DEFAULT_SCOPE` object). */
function strictScope(): ScopeDoc {
  return { version: SCOPE_DOC_VERSION, revision: 0, mode: 'selected', workspaceIds: [] }
}

/** `JSON.parse` for text input; any other value is taken as already parsed. */
function parseScopeInput(input: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof input !== 'string') return { ok: true, value: input }
  try {
    return { ok: true, value: JSON.parse(input) }
  } catch {
    return { ok: false }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** `String(value).trim()`, or `undefined` when there is nothing usable. */
function usableText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text === '' ? undefined : text
}

/**
 * The field-and-type validation shared by the PUT body and the document: `mode`
 * must be one of the two modes and `workspaceIds` must be an array of strings.
 * Registry-outside ids are NOT a validation failure — pruning is their ruling
 * (B14). The returned ids are de-duplicated and sorted.
 */
function readScopeFields(
  value: unknown,
): { mode: ScopeMode; workspaceIds: string[] } | undefined {
  if (!isRecord(value)) return undefined

  const mode = value.mode
  if (mode !== 'global' && mode !== 'selected') return undefined

  const raw = value.workspaceIds
  if (!Array.isArray(raw)) return undefined

  const ids: string[] = []
  for (const id of raw) {
    if (typeof id !== 'string') return undefined
    ids.push(id)
  }

  return { mode, workspaceIds: [...new Set(ids)].sort() }
}

/** The on-disk form, matching the shape the rest of the repo writes. */
function serializeScope(doc: ScopeDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/**
 * In-memory authority over the scope document.
 *
 * A missing file is the default scope (D3) and is SILENT — no warn, no note.
 * Anything else unreadable lands on the strict side with one warn. The document
 * is read at most once per state (`load()` is idempotent), and every read
 * accessor loads lazily, so a caller cannot observe a half-initialized state.
 *
 * The workspace list has exactly three states, fixed by the shape of
 * `setWorkspaces`' argument: 未读 (never called — the initial state, written by
 * nobody), 读成功 (a non-empty array), 读失败 (`undefined` OR an empty array).
 * `[]` counting as read failure is the point of B16: reading an empty registry
 * as "every id is gone" would silently prune the user's whole selection.
 * `setWorkspaces` is the ONLY production writer, and it holds the only write
 * site of the `workspace-list` note in this codebase (added when a read fails,
 * dropped again when one succeeds — the note is state, not history, R8).
 *
 * From Task 3 on this class also owns the judgement: `rebuild()` is the only
 * asynchronous method here and the only caller of `setWorkspaces`; it builds one
 * whole generation — the canonical path map, the per-agent judgements and the
 * `pathUnmatched` diagnostics — and swaps it in at once, while `judgement()` and
 * `pathUnmatched()` are synchronous reads of that generation.
 */
export class ToolScopeState {
  readonly #file: string
  readonly #log: ((message: string, error?: unknown) => void) | undefined

  #loaded = false
  #doc: ScopeDoc = strictScope()
  /** Set when the on-disk document declared a version this build cannot use. */
  #versionUnsupported = false

  /** Same source ⇒ one entry, latest reason; different sources coexist. */
  #degraded = new Map<DegradedSource, DegradedNote>()

  #host: ScopeHostState = {
    state: 'pending',
    capable: false,
    reason: '等待宿主注入 agents / workspaceRegistry',
  }

  #listState: 'unread' | 'read' | 'unavailable' = 'unread'
  #workspaces: ScopeWorkspace[] = []

  /** Per-agent installed layers: the execution-side mirror `guard` reads. */
  #layers = new Map<string, MountedLayer>()

  /** The current generation's canonical path map: entity path ⇒ workspaceId. */
  #pathMap = new Map<string, string>()

  /** The current generation's per-agent judgements. `rebuild()` replaces it whole. */
  #judgements = new Map<string, AgentJudgement>()

  /** cwd samples that resolved outside the registry: diagnostics, NOT degraded. */
  #pathUnmatched: Array<{ agentId: string; cwd: string }> = []

  constructor(options: { file: string; log?: (message: string, error?: unknown) => void }) {
    this.#file = options.file
    this.#log = options.log
  }

  /** Reads the document once. Idempotent, and never throws (B9). */
  load(): void {
    this.#ensureLoaded()
  }

  /** The current document. The returned object IS the authoritative one. */
  doc(): ScopeDoc {
    this.#ensureLoaded()
    return this.#doc
  }

  /** The degradation notes, one per source; `[]` means no degradation. */
  degraded(): DegradedNote[] {
    this.#ensureLoaded()
    return [...this.#degraded.values()]
  }

  /** Records a note: same source replaces the reason, other sources survive. */
  noteDegraded(note: DegradedNote): void {
    this.#degraded.set(note.source, { source: note.source, reason: note.reason })
  }

  /** The host capability tri-state, as written by the host integration layer. */
  host(): ScopeHostState {
    return this.#host
  }

  setHost(next: ScopeHostState): void {
    this.#host = next
  }

  /**
   * The workspace list's single write site.
   *
   * A non-empty array is an authoritative read (reconcile and prune, and the
   * `workspace-list` note is dropped here because a later read succeeded);
   * `undefined` or `[]` is a read FAILURE — the list becomes unavailable, the
   * judgement goes fail-closed for `selected`, the write side is refused (503)
   * and the `workspace-list` note is recorded right here, once, and nowhere
   * else.
   */
  setWorkspaces(list: readonly unknown[] | undefined): void {
    if (list === undefined || list.length === 0) {
      this.#listState = 'unavailable'
      this.#workspaces = []
      // The only write site of this source in the codebase: neither the HTTP
      // face, the host layer nor the UI may add a second `workspace-list` note.
      this.noteDegraded({
        source: 'workspace-list',
        reason: '工作区列表不可用（注册表读取失败或返回空表）；判定 fail-closed，写侧拒绝',
      })
      return
    }

    this.#listState = 'read'
    // R8: `degraded` is STATE, not history. This branch is the same single write
    // site as the note above and the only place this source is ever dropped —
    // a note outliving its read failure would keep Task 8's save button
    // disabled while `save()` itself would accept the very same PUT.
    this.#clearDegraded('workspace-list')
    this.#workspaces = list
      .map((raw) => toScopeWorkspace(raw))
      .filter((workspace): workspace is ScopeWorkspace => workspace !== undefined)
  }

  /** The normalized registry list; `[]` for both 未读 and 读失败. */
  workspaces(): ScopeWorkspace[] {
    return this.#workspaces
  }

  /**
   * Document ids the registry no longer has (B14), for the settings page.
   *
   * `[]` for 未读 and for 读失败 as well as for a clean document: "cannot read
   * the list" must never be presented as "every id is stale".
   */
  staleWorkspaceIds(): string[] {
    this.#ensureLoaded()
    if (this.#listState !== 'read') return []
    const known = this.#knownWorkspaceIds()
    return this.#doc.workspaceIds.filter((id) => !known.has(normalizeWorkspaceId(id)))
  }

  /**
   * Recomputes ONE generation — the canonical path map, the per-agent judgement
   * cache and the `pathUnmatched` diagnostics — and swaps it in with a single
   * assignment. The only asynchronous method on this class.
   *
   * The build order is fixed: the list first (`setWorkspaces` is its only
   * production writer, `[]` counting as a read failure exactly as `undefined`
   * does), then the map keyed on each item's ENTITY path, then one judgement per
   * agent. Everything the readers see is built into locals, so a rebuild still
   * awaiting `resolveByPath` leaves them on the PREVIOUS generation instead of
   * exposing a half-built map.
   */
  async rebuild(
    registry: WorkspaceRegistryLike,
    agents: readonly ScopeAgentLike[],
  ): Promise<RebuildSummary> {
    this.#ensureLoaded()
    // One document and one list per generation: an interleaved save or list
    // write must not be able to judge two agents of the same round differently.
    const doc = this.#doc

    let listed: readonly unknown[] | undefined
    let listAvailable = false
    try {
      const raw = registry.list()
      if (Array.isArray(raw) && raw.length > 0) {
        listed = raw
        listAvailable = true
      }
    } catch (error) {
      this.#warn('工作区注册表 list() 抛出，按 B16 视为列表不可用（判定 fail-closed，写侧拒绝）', error)
    }

    // R9: the items go to `setWorkspaces` AS-IS. A non-empty list whose items
    // are individually unusable is still an authoritative read — the stricter
    // alternative would answer 503 and refuse the very save that clears the ids
    // this plugin itself just reported as stale.
    this.setWorkspaces(listed)
    const workspaces = this.#workspaces

    const pathMap = new Map<string, string>()
    const resolveByPath = registry.resolveByPath
    if (typeof resolveByPath === 'function') {
      for (const workspace of workspaces) {
        let entity: unknown
        try {
          // `call(registry, …)` so a class method keeps its `this`.
          entity = await resolveByPath.call(registry, workspace.path)
        } catch (error) {
          // ⑪: one unreadable item is skipped — never a failed read, and never a
          // `degraded` entry (the five-value enum has no member for it).
          this.#warn(
            `工作区注册表项 ${workspace.path} 的路径解析失败（resolveByPath reject）；本轮跳过该项，其余项与全部 agent 的判定不受影响`,
            error,
          )
          continue
        }
        // Key = the ENTITY's path (realpath semantics: both sides of a symlink
        // converge here), value = that entity's workspaceId. `undefined` means
        // the host owns no such directory, so there is no key to record.
        const resolved = entity === undefined ? undefined : toScopeWorkspace(entity)
        if (resolved === undefined) continue
        pathMap.set(resolved.path, resolved.id)
      }
    } else {
      // D14's honest degradation: no realpath, case-sensitive string equality,
      // and a note that never claims to be canonical-path equivalence.
      this.noteDegraded({
        source: 'path-normalization',
        reason:
          '宿主无 resolveByPath，路径匹配退化为大小写敏感字符串等价（不做 realpath）；符号链接或拼写差异下规则二可能不命中，此时只剩 sessionIds 一条路',
      })
      for (const workspace of workspaces) pathMap.set(workspace.path, workspace.id)
    }

    const judgements = new Map<string, AgentJudgement>()
    const pathUnmatched: Array<{ agentId: string; cwd: string }> = []
    for (const agent of agents) {
      const judgement = await this.#judge(doc, workspaces, agent, registry, pathMap, listAvailable)
      judgements.set(agent.id, judgement)
      // §6.1: a resolved cwd that belongs to no workspace is DIAGNOSTIC, never a
      // degradation — and it is one of the two states D14 refuses to recheck.
      if (judgement.status === 'no-match' && judgement.cwd !== undefined) {
        pathUnmatched.push({ agentId: judgement.agentId, cwd: judgement.cwd })
      }
    }

    // One assignment: the generation switches whole.
    this.#pathMap = pathMap
    this.#judgements = judgements
    this.#pathUnmatched = pathUnmatched

    let resolved = 0
    let unresolved = 0
    for (const judgement of judgements.values()) {
      if (judgement.status === 'resolved') resolved += 1
      else if (judgement.status === 'unresolved') unresolved += 1
    }

    return {
      listAvailable,
      agents: agents.length,
      resolved,
      unresolved,
      pathUnmatched: pathUnmatched.length,
    }
  }

  /** The current generation's judgement for one agent, or a cache miss. */
  judgement(agentId: string): AgentJudgement | undefined {
    return this.#judgements.get(agentId)
  }

  /**
   * Agents whose `cwd` resolved outside every registered workspace, with the
   * `cwd` sample (§6.1's 路径不匹配诊断). Diagnostics only — no `degraded` entry
   * carries this, so "勾了却无工具" can be told apart from a degraded read.
   */
  pathUnmatched(): ReadonlyArray<{ agentId: string; cwd: string }> {
    return this.#pathUnmatched
  }

  /**
   * Validates and commits one write, synchronously (no `await` anywhere in the
   * critical section, §6.3).
   *
   * The refusal priority is FIXED: an unsupported document version (503) > an
   * unavailable workspace list (503) > invalid request fields (400) > a missing
   * base revision (400) > a revision conflict (409). Pre-existing state
   * outranks request-body validation — a newer document plus a malformed body
   * must report the newer document, never `invalid-scope`.
   *
   * On success the pruned ids are dropped (only under an authoritative list —
   * never while 未读 or 读失败), the revision is bumped by exactly one, the
   * normalized document is written atomically as 0600, and the in-memory
   * authority holds THAT document: the returned `doc` is the same object
   * `doc()` serves.
   */
  save(body: unknown, expectedRevision: unknown): SaveResult {
    this.#ensureLoaded()

    if (this.#versionUnsupported) {
      return {
        ok: false,
        status: 503,
        error: 'scope-version-unsupported',
        message:
          '作用域文档版本高于本插件支持（本插件支持 version 1），不能覆写该文档；已存内容一位不动',
      }
    }

    if (this.#listState === 'unavailable') {
      return {
        ok: false,
        status: 503,
        error: 'workspace-list-unavailable',
        message: '工作区列表不可用，无法替用户做写决策；已存内容一位不动',
      }
    }

    const fields = readScopeFields(body)
    if (fields === undefined) {
      return {
        ok: false,
        status: 400,
        error: 'invalid-scope',
        message: 'mode 必须是 global 或 selected，workspaceIds 必须是字符串数组',
      }
    }

    if (!isFiniteNumber(expectedRevision)) {
      return {
        ok: false,
        status: 400,
        error: 'missing-expected-revision',
        message: '请求必须携带基准 expectedRevision（读-改-写）',
      }
    }

    const current = this.#doc.revision
    if (expectedRevision !== current) {
      return {
        ok: false,
        status: 409,
        error: 'scope-revision-conflict',
        message: `配置已被他处修改（当前 revision=${current}），请重新读取后再保存`,
      }
    }

    // Pruning needs an AUTHORITATIVE list read; 未读 and 读失败 both leave every
    // id alone ("no authoritative list" is not "the user's picks are stale").
    const known = this.#listState === 'read' ? this.#knownWorkspaceIds() : undefined
    const pruned: string[] = []
    const kept: string[] = []
    for (const id of fields.workspaceIds) {
      if (known !== undefined && !known.has(normalizeWorkspaceId(id))) pruned.push(id)
      else kept.push(id)
    }

    const { doc } = normalizeScope({
      version: SCOPE_DOC_VERSION,
      revision: current + 1,
      updatedAt: new Date().toISOString(),
      mode: fields.mode,
      workspaceIds: kept,
    })

    writeFileAtomicSync(this.#file, serializeScope(doc))
    this.#doc = doc
    return { ok: true, doc, pruned }
  }

  /** The installed layer for one agent, or `undefined` when none is mounted. */
  layer(agentId: string): MountedLayer | undefined {
    return this.#layers.get(agentId)
  }

  /** Records the layer installed for one agent (the record IS the mirror). */
  setLayer(agentId: string, layer: MountedLayer): void {
    this.#layers.set(agentId, layer)
  }

  /** Forgets one agent's layer, in the same turn its restriction is released. */
  clearLayer(agentId: string): void {
    this.#layers.delete(agentId)
  }

  /**
   * Drops everything derived from a previous mount: the installed-layer records
   * and the whole judgement generation — the canonical path map, the per-agent
   * judgements and the `pathUnmatched` diagnostics (Task 4's teardown asserts
   * exactly this).
   */
  invalidateDerived(): void {
    this.#layers.clear()
    this.#pathMap = new Map()
    this.#judgements = new Map()
    this.#pathUnmatched = []
  }

  /**
   * One agent's judgement against the generation being built, following §4's
   * two rules in order: the header-validated `sessionIds` projection wins, and
   * the canonical path map is the only path comparison there is.
   *
   * `doc` and `workspaces` are the snapshots `rebuild()` took for this whole
   * round, so two agents of one generation can never be judged against two
   * different documents or lists.
   */
  async #judge(
    doc: ScopeDoc,
    workspaces: readonly ScopeWorkspace[],
    agent: ScopeAgentLike,
    registry: WorkspaceRegistryLike,
    pathMap: ReadonlyMap<string, string>,
    listAvailable: boolean,
  ): Promise<AgentJudgement> {
    // Rule one.
    const member = workspaces.find((workspace) => workspace.sessionIds.includes(agent.id))
    if (member !== undefined) {
      return judged(doc, agent, 'resolved', member.id, `会话成员命中 ${describeWorkspace(member)}`)
    }

    // Rule two.
    if (agent.cwd === undefined) {
      return judged(
        doc,
        agent,
        'no-cwd',
        undefined,
        '会话 header 无 cwd，路径规则无法判定（D7：仅 selected 下不可见；该状态不启动复检）',
      )
    }

    if (!listAvailable) {
      // ⑧/B16: "the list could not be read" is "this resolution failed" — the
      // state D14's bounded recheck is defined to start from.
      return judged(
        doc,
        agent,
        'unresolved',
        undefined,
        `工作区列表不可用，cwd ${agent.cwd} 本次无法解析（D14 的有界复检只对该状态启动）`,
      )
    }

    const resolveByPath = registry.resolveByPath
    if (typeof resolveByPath !== 'function') {
      // Old host (D14): case-sensitive string equality against the item paths.
      const workspaceId = pathMap.get(agent.cwd)
      return workspaceId === undefined
        ? judged(
            doc,
            agent,
            'no-match',
            undefined,
            `宿主无 resolveByPath，cwd ${agent.cwd} 与任何注册表项都不大小写敏感相等（D7：无工作区）`,
          )
        : judged(doc, agent, 'resolved', workspaceId, `路径字符串等价命中 ${this.#label(workspaces, workspaceId)}`)
    }

    let entity: unknown
    try {
      entity = await resolveByPath.call(registry, agent.cwd)
    } catch (error) {
      this.#warn(
        `cwd ${agent.cwd} 的 resolveByPath 调用失败；判定为 unresolved（D14 的有界复检只对该状态启动）`,
        error,
      )
      return judged(
        doc,
        agent,
        'unresolved',
        undefined,
        `cwd ${agent.cwd} 本次解析失败（注册表未就绪或 realpath 失败）`,
      )
    }

    if (entity === undefined) {
      return judged(
        doc,
        agent,
        'no-match',
        undefined,
        `宿主不拥有目录 ${agent.cwd}（resolveByPath 返回 undefined），不属任何已注册工作区（D7）`,
      )
    }

    // A successful resolution is looked up on the canonical map — the one path
    // comparison in this module. An entity outside it is `no-match`, not a hit
    // on the entity's own id.
    const resolved = toScopeWorkspace(entity)
    const workspaceId = resolved === undefined ? undefined : pathMap.get(resolved.path)
    if (workspaceId === undefined) {
      return judged(
        doc,
        agent,
        'no-match',
        undefined,
        `cwd ${agent.cwd} 解析成功但不属任何已注册工作区（D7）`,
      )
    }
    return judged(doc, agent, 'resolved', workspaceId, `规范化路径命中 ${this.#label(workspaces, workspaceId)}`)
  }

  /** The workspace id, plus its title when this generation's list carries one. */
  #label(workspaces: readonly ScopeWorkspace[], workspaceId: string): string {
    const workspace = workspaces.find((item) => item.id === workspaceId)
    return workspace === undefined ? `工作区 ${workspaceId}` : describeWorkspace(workspace)
  }

  /**
   * The removal half of the note set. `degraded` is STATE, not history (R8):
   * the `workspace-list` note must not outlive the read failure that produced
   * it, or one transient registry failure would keep Task 8's save button
   * disabled for the rest of the process while `save()` itself accepts the very
   * same `PUT` (it refuses only while the list is CURRENTLY unavailable).
   *
   * Module-private on purpose: the method list is a contract for Tasks 4–9, and
   * `setWorkspaces` is the only place allowed to add OR drop this source. The
   * other four sources stay append-only — none of them has a success trigger.
   */
  #clearDegraded(source: DegradedSource): void {
    this.#degraded.delete(source)
  }

  #knownWorkspaceIds(): Set<string> {
    return new Set(this.#workspaces.map((workspace) => normalizeWorkspaceId(workspace.id)))
  }

  /**
   * The one read of the file, and the one place the strictness order is applied
   * to disk content:
   *  - ENOENT ⇒ the default scope, silently (first run, D3);
   *  - another read error ⇒ the strict side + one warn;
   *  - an unsupported version ⇒ the strict side + the `scope-version` note and a
   *    latch that refuses every write;
   *  - a parse failure / invalid field ⇒ the strict side + one warn, writable.
   */
  #ensureLoaded(): void {
    if (this.#loaded) return
    this.#loaded = true

    let text: string
    try {
      text = readFileSync(this.#file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.#warn(
        `作用域文档 ${this.#file} 读取失败；按 B9 落到更严一侧（selected + 空列表），写入仍可覆盖`,
        error,
      )
      return
    }

    const { doc, problem } = normalizeScope(text)
    this.#doc = doc

    if (problem === 'parse') {
      // No DegradedSource member exists for this on purpose: the carrier is this
      // warn plus the strictness order, and the document stays writable (B9).
      this.#warn(
        `作用域文档 ${this.#file} 解析失败或字段非法；按 B9 落到更严一侧（selected + 空列表），写入仍可覆盖`,
      )
      return
    }

    if (problem === 'version-unsupported') {
      this.#versionUnsupported = true
      this.noteDegraded({
        source: 'scope-version',
        reason:
          '作用域文档版本高于本插件支持（本插件支持 version 1）；已只读降级并拒绝写入，避免覆写更新格式的文档',
      })
    }
  }

  /** The existing warn channel: the injected `log`, else `console.warn`. */
  #warn(message: string, error?: unknown): void {
    if (this.#log !== undefined) {
      this.#log(message, error)
      return
    }
    console.warn(message, error)
  }
}
