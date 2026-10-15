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
 * The one "input → normalized document" entry point; both `load()` and `save()`
 * go through it, so the document shape exists in exactly one place.
 *
 * `input` is either the text read from disk or an already-parsed value.
 *  - unparsable text or an invalid field ⇒ `problem: 'parse'` and the STRICT
 *    side (`selected` + empty): the caller warns through the existing carrier
 *    and the document stays writable (B9);
 *  - a type-legal `version` other than {@link SCOPE_DOC_VERSION} ⇒
 *    `problem: 'version-unsupported'`, the same strict side, and a read-only
 *    degradation the caller records (never a silent "the user selected
 *    nothing");
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
  if (!isFiniteNumber(revision)) return { doc: strictScope(), problem: 'parse' }

  const fields = readScopeFields(value)
  if (fields === undefined) return { doc: strictScope(), problem: 'parse' }

  const updatedAt = value.updatedAt
  if (updatedAt !== undefined && typeof updatedAt !== 'string') {
    return { doc: strictScope(), problem: 'parse' }
  }

  // A type-legal version that is not ours is the READ-ONLY side: the caller must
  // not overwrite the document, so this is not merged into the parse branch.
  if (version !== SCOPE_DOC_VERSION) return { doc: strictScope(), problem: 'version-unsupported' }

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
 * site of the `workspace-list` note in this codebase.
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
   * A non-empty array is an authoritative read (reconcile and prune); `undefined`
   * or `[]` is a read FAILURE — the list becomes unavailable, the judgement goes
   * fail-closed for `selected`, the write side is refused (503) and the
   * `workspace-list` note is recorded right here, once, and nowhere else.
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
   * Drops everything derived from a previous mount. At this task that is the
   * installed-layer records; the judgement cache, the canonical path map and the
   * `pathUnmatched` diagnostics join them in Task 3.
   */
  invalidateDerived(): void {
    this.#layers.clear()
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
