/**
 * Where the experiment's configuration lives: `<dataDir>/subagent.json` (#233).
 *
 * The settings page cannot write the profile's YAML, so a switch there would be
 * a control nothing reads. This is the document it writes instead, deliberately
 * the same shape as `scope.json`: 0600, atomic, one monotonic `revision`, and a
 * read-modify-write save so two open pages cannot silently overwrite each other.
 *
 * ## Two sources, one winner
 *
 * The profile's `subagent` key still works — it is the SEED, used until the page
 * writes a document. After that the FILE wins, because a save the operator just
 * made must not be undone by a YAML value they edited last week. A seed has no
 * `revision` (the profile cannot carry an `expectedRevision`), so {@link read}
 * drops it rather than let it pose as a baseline.
 *
 * **A damaged file is not an absent one** (#258). Only ENOENT seeds: a file that
 * exists and cannot be read or parsed is fail-CLOSED — an empty document, which
 * resolves to `disabled` — because falling back to the seed would let a broken
 * document re-enable an experiment the operator had turned off.
 *
 * ## The resolver stays the only validator
 *
 * `save` checks the LOCK and the body's shape, and nothing else. Every field
 * verdict belongs to `resolveSubagentConfig`, which already answers with the
 * codes the page renders — so a save that stores an unusable value is not a
 * refused request, it is a document whose next read reports `failed` with its
 * problems. One validator, one set of codes, no second dialect to keep in step.
 *
 * The consequence is stated rather than hidden: this store will happily write
 * `{ enabled: 'true' }`, and the page then shows the `not-boolean` problem. That
 * is the same answer the profile YAML gets, which is the point.
 */
import { readFileSync } from 'node:fs'
import { writeFileAtomicSync } from './atomicFile.js'

/** What a save or a read found. */
export interface StoredSubagentConfig {
  /**
   * The document exactly as stored or seeded.
   *
   * `unknown` on purpose: the seed is whatever the profile held, and a
   * hand-edited file is whatever JSON it contains. Narrowing here would mean
   * either sanitizing (which hides a broken document from the resolver that is
   * supposed to report it) or asserting a shape nothing checked.
   */
  readonly document: unknown
  /** The lock this document was read at; the next save quotes it. */
  readonly revision: number
  /** `file` wins over `config`; the page says which one it is looking at. */
  readonly source: 'file' | 'config'
}

/** The verdict of one save. */
export type SubagentConfigSaveResult =
  | { readonly ok: true; readonly stored: StoredSubagentConfig }
  | {
      readonly ok: false
      readonly status: 400 | 409
      readonly error: 'invalid-request' | 'missing-expected-revision' | 'subagent-revision-conflict'
      readonly message: string
    }

/** What one look at the file found. `absent` is the only state that seeds. */
type FileRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'damaged' }
  | { readonly kind: 'ok'; readonly stored: StoredSubagentConfig }

/** The document's face: read it, or read-modify-write it. */
export interface SubagentConfigDocument {
  read(): StoredSubagentConfig
  save(body: unknown, expectedRevision: unknown): SubagentConfigSaveResult
}

/** A plain JSON object, which is the only thing a config document can be. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The document's own `revision`, or `0` when it does not carry a usable one. */
function revisionOf(document: unknown): number {
  if (!isRecord(document)) return 0
  const revision = document['revision']
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : 0
}

/**
 * Build the store for ONE apply.
 *
 * @param parts - the file, the profile's seed value, and a warning sink. Nothing
 *   is read here: {@link SubagentConfigDocument.read} does the I/O, so building
 *   a store cannot throw on a missing or unreadable data directory.
 */
export function createSubagentConfigDocument(parts: {
  file: string
  /** The profile's `subagent` value, used only while no document exists. */
  seed: unknown
  log?: (message: string) => void
}): SubagentConfigDocument {
  const log = parts.log ?? ((): void => {})

  const readFile = (): FileRead => {
    let text: string
    try {
      text = readFileSync(parts.file, 'utf8')
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : ''
      // ENOENT is the ordinary "the page has never saved" state, not a fault.
      if (code === 'ENOENT') return { kind: 'absent' }
      // Anything else is the file being there and unusable — the same class as
      // a parse error, and just as capable of handing the experiment back to
      // the seed if it were called absent (#258).
      // No "保存会覆盖它" here, unlike the parse arm: the path itself is
      // unusable, so a save cannot repair it — `writeFileAtomicSync` renames
      // onto that path and fails the same way the read did. Promising a repair
      // the next click cannot deliver is the same class of lie as the one this
      // issue is about.
      log(`[cherry-remote] 读取子智能体配置失败（${code || 'unknown'}）；按未启用处理`)
      return { kind: 'damaged' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      log('[cherry-remote] 子智能体配置文件损坏（不是合法 JSON）；按未启用处理，保存会覆盖它')
      return { kind: 'damaged' }
    }
    if (!isRecord(parsed)) {
      log('[cherry-remote] 子智能体配置文件损坏（不是对象）；按未启用处理，保存会覆盖它')
      return { kind: 'damaged' }
    }
    return { kind: 'ok', stored: { document: parsed, revision: revisionOf(parsed), source: 'file' } }
  }

  const read = (): StoredSubagentConfig => {
    const found = readFile()
    if (found.kind === 'ok') return found.stored
    if (found.kind === 'absent') return { document: parts.seed, revision: 0, source: 'config' }
    // #258: fail CLOSED. A damaged file used to fall through to the seed, so a
    // document the operator had saved `enabled: false` into could come back as
    // `enabled: true` from a YAML value they had already overridden — the one
    // direction the "off by default" promise cannot afford. An EMPTY document
    // resolves to `disabled`, and `revision: 0` still lets the page save over
    // the damage, so the fault is reported and repairable rather than fatal.
    //
    // `source: 'file'` because the file IS what won: it exists, it is the
    // authority, and its content is unusable. Calling it `config` would blame
    // the profile for a document the profile never held.
    return { document: {}, revision: 0, source: 'file' }
  }

  return {
    read,
    save(body: unknown, expectedRevision: unknown): SubagentConfigSaveResult {
      if (!isRecord(body)) {
        return { ok: false, status: 400, error: 'invalid-request', message: '请求体必须是 JSON 对象' }
      }
      if (typeof expectedRevision !== 'number' || !Number.isFinite(expectedRevision)) {
        return {
          ok: false,
          status: 400,
          error: 'missing-expected-revision',
          message: '请求必须携带基准 expectedRevision（读-改-写）',
        }
      }
      // The LOCK is judged against the document on disk, never against what the
      // request claims to have read — otherwise the lock would check itself.
      const current = read()
      if (expectedRevision !== current.revision) {
        return {
          ok: false,
          status: 409,
          error: 'subagent-revision-conflict',
          message: `配置已被他处修改（当前 revision=${current.revision}），请重新读取后再保存`,
        }
      }
      // TWO fields are the PROTOCOL's, not the document's: the baseline the
      // caller quotes and the revision the server owns. Storing either would put
      // a lock token in a config field and echo it back on every later read.
      const { revision: _serverOwned, expectedRevision: _baseline, ...fields } = body
      const revision = current.revision + 1
      const document = { ...fields, revision }
      writeFileAtomicSync(parts.file, `${JSON.stringify(document, null, 2)}\n`)
      return { ok: true, stored: { document, revision, source: 'file' } }
    },
  }
}
