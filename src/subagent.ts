/**
 * The Cherry Studio subagent provider — the seam transcription.
 *
 * DSH 0.2.2 exposes `ctx.subagents`, a named-provider registry: a plugin hands it
 * a small object and the runtime owns capacity, parent lifetime, cancellation,
 * terminal recording and completion delivery. The official Claude Code, Codex and
 * OAR providers each declare the same four fields and do their work in `start()`
 * (`@deepseek-ai/dsh-subagent-claude-code/lib/index.js:331-360`).
 *
 * ## Why this file declares the seam instead of importing it
 *
 * This repository takes NO `@deepseek-ai/*` runtime dependency. The host face is
 * consumed structurally everywhere (`src/tools.ts:46`, "Structural types,
 * deliberately narrow"), and the subagent seam is no different: the provider
 * object, the run handle and the result shape are plain data, and the two helpers
 * that carry the seam's contracts are 40 lines of pure function
 * (`@deepseek-ai/dsh-subagent/lib/index.js:2863-2910`).
 *
 * That is a deliberate trade with a named risk: **the transcription drifts if the
 * host changes its mind.** Pinned against `@deepseek-ai/dsh-subagent@0.2.2-rc.1`;
 * `tests/unit/subagentSeam.test.ts` asserts every claim made here. What those
 * tests CANNOT see is a future host that narrows or redefines these semantics —
 * re-read the installed package before trusting this file against a new host
 * minor.
 *
 * ## The three contracts a provider must honour
 *
 *  1. `run.result` NEVER rejects. A child-level failure settles as
 *     `stopReason: 'error'`; only an infrastructure fault the seam cannot express
 *     rejects. {@link settleRunResult} is how that is kept.
 *  2. Failing BEFORE returning the run means cleaning up partial resources and
 *     rejecting; failing AFTER it means settling through `result`.
 *  3. `dispose()` is idempotent and runs until the child has actually stopped.
 *     {@link externalRunHandle} memoizes one teardown and cancels locally first,
 *     because there is no assumption the child cooperates.
 *
 * @module cherry-remote/subagent
 */

import { randomUUID } from 'node:crypto'
import { normalize, sep } from 'node:path'
import {
  CHERRY_SUBAGENT_PROVIDER_DEFAULT,
  MESSAGE_TEXT_MAX_CHARS,
  CHERRY_SUBAGENT_TOOL_DEFAULT,
  DEFAULT_MAX_INTERACTION_ABANDONS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
} from './defaults.js'

// ---------------------------------------------------------------------------
// The seam's vocabulary
// ---------------------------------------------------------------------------

/** Why a run ended. Mirrors the host's `SubagentStopReasonMap`. */
export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/**
 * One content block of a task or an answer.
 *
 * Structurally the host's `ContentBlock`; kept local because the only shape this
 * provider handles is `{ type: 'text', text }` and {@link textPrompt} refuses
 * everything else.
 */
export interface SubagentContentBlock {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

/**
 * The terminal outcome of a run.
 *
 * `diagnostic` is provider-authored, non-assistant failure detail for a
 * non-`completed` result. The seam caps it at
 * {@link SUBAGENT_DIAGNOSTIC_MAX_BYTES} and requires it to stay free of tool
 * inputs, file contents, environment values, credentials and raw protocol
 * payloads — it is shown to the parent model, so a leaked token here would be a
 * context disclosure, not just noise.
 */
export interface SubagentResult {
  readonly output: readonly SubagentContentBlock[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason: SubagentStopReason
}

/** What a start-time capability advertisement declares. */
export interface SubagentCapabilities {
  readonly agentOptions: boolean
  readonly agentPreset: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
}

/**
 * The task and the caller-owned cancellation a provider receives.
 *
 * The host hands `start` a `ResolvedSubagentStartRequest`, which is this shape
 * with `cwd` already resolved — so `cwd` is REQUIRED here even though the
 * unresolved request the runtime builds has it optional. Modelling the optional
 * form would have forced every reader to answer "what if the runtime did not
 * resolve it", a state the host cannot produce.
 *
 * The four trailing fields exist so this transcription matches the host's, and
 * they are ALWAYS ABSENT in practice: `NO_START_CAPABILITIES` turns every one of
 * them off, and the host refuses a request that asks for one BEFORE calling
 * `start`. They are declared rather than omitted because a type that is narrower
 * than the host's is a type that lies about what the host may pass.
 */
export interface SubagentStartRequest {
  /**
   * Initial child directory, already resolved to an absolute path.
   *
   * A ROUTING KEY and nothing more: the host does not check that it exists on
   * this machine's filesystem before passing an absolute path through, and the
   * Cherry side is a different machine anyway. Never stat it.
   */
  readonly cwd: string
  /** Short display label; the runtime passes it through to `start`. */
  readonly label?: string
  /** The task, as content blocks. */
  readonly prompt: readonly SubagentContentBlock[]
  /** The spawning agent. Opaque here: this provider reads nothing off it. */
  readonly parent: unknown
  /** Canonical cancellation channel, before and after startup. */
  readonly signal: AbortSignal
  /** Refused by capability: this provider declares `agentPreset: false`. */
  readonly agentPreset?: unknown
  /** Refused by capability: this provider declares `agentOptions: false`. */
  readonly agentOptions?: unknown
  /** Refused by capability: this provider declares `outputSchema: false`. */
  readonly outputSchema?: unknown
  /** Refused by capability: this provider declares `depthLimit: false`. */
  readonly maxDepth?: unknown
}

/** One registered transport. */
export interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  start?(request: SubagentStartRequest): Promise<SubagentRun>
}

/**
 * A provider whose child is a single external execution.
 *
 * Narrower than {@link SubagentProvider} in exactly one way: `start` is required.
 * That is the honest type here — a one-shot provider without `start` is rejected
 * by `registerProvider` (`UNSUPPORTED_CAPABILITY`), and `prepareContinuable` is
 * deliberately absent: its presence selects the LOCAL activation path, which
 * needs a child Agent this plugin does not own.
 */
export interface CherrySubagentProvider extends SubagentProvider {
  start(request: SubagentStartRequest): Promise<SubagentRun>
}

/** One managed external execution. */
export interface SubagentRun {
  /** Provider-minted id, unique across parents, providers and local Sessions. */
  readonly id: string
  /** Resolves with the terminal result. Never rejects after publication. */
  readonly result: Promise<SubagentResult>
  /** Cancel remaining work, reach quiescence, release resources. Idempotent. */
  dispose(): Promise<void>
}

/**
 * The seam's diagnostic byte ceiling (4096 UTF-8 bytes).
 *
 * A BYTE count, not a character count: a Chinese character is three bytes, so a
 * character-count clip overshoots by 3x and a naive byte-slice can cut a code
 * point in half. {@link clipDiagnostic} walks whole code points.
 */
export const SUBAGENT_DIAGNOSTIC_MAX_BYTES = 4_096

/**
 * The capability advertisement of an out-of-process backend: none.
 *
 * A child in another process cannot honour parent-enforced start features
 * (`agentOptions` / `agentPreset` / `outputSchema` / `maxDepth`), so the runtime
 * rejects a request needing any of them BEFORE `start` runs. Advertising one we
 * cannot honour would accept the request and silently ignore it.
 */
export const NO_START_CAPABILITIES: SubagentCapabilities = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

// ---------------------------------------------------------------------------
// settleRunResult — the never-rejecting settlement
// ---------------------------------------------------------------------------

/** Inputs to {@link settleRunResult}. */
export interface RunResultSettlement {
  /** The turn attempt. Its rejection is flattened, never propagated. */
  attempt(): Promise<SubagentResult>
  /** The partial output a cancelled or failed run still reports. A throw from it is contained. */
  collectOutput(): readonly SubagentContentBlock[]
  /** Provider-authored failure detail, clipped to the seam ceiling. A throw from it is contained. */
  collectDiagnostic?(): string | undefined
  /** Whether LOCAL cancellation settled before the attempt's outcome. */
  cancelled(): boolean
  /**
   * Where a settlement reports what went wrong — a LOGGING AND OPERATIONS
   * channel, not a data channel.
   *
   * It is deliberately NOT the source of `SubagentResult.diagnostic`: that comes
   * from {@link collectDiagnostic}, and {@link settleRunResult} folds it into the
   * result itself. Treating this sink as a diagnostic back-up produces a second,
   * competing copy of the same fact.
   *
   * What a caller must be ready for, because every point below is pinned by a
   * test rather than left to be discovered by reading the implementation:
   *
   *  - **0 to 3 calls per settlement.** A clean run reports nothing. A failed
   *    one reports the attempt's own error. A collector that then throws adds a
   *    report of its own — one per broken collector, so three at most.
   *  - **The order is meaningful.** The attempt's failure always arrives FIRST.
   *    Collector failures arrive after it, prefixed with the collector's name
   *    (`collectOutput() failed: …`). A keep-first sink therefore keeps the real
   *    cause, and a last-wins one still keeps something that names the collector
   *    instead of a silently substituted message.
   *  - **`stopReason` is always the settlement's own**, i.e. the value the parent
   *    will receive. On the cancelled paths that is `aborted` even when the child
   *    had in fact succeeded: a run we stopped listening to did not fail, and
   *    reporting `completed` there would contradict the answer the parent holds.
   *  - **A throw from this sink is contained**, so a broken sink cannot become
   *    the rejection {@link settleRunResult} exists to avoid.
   */
  onError?(error: Error, stopReason: SubagentStopReason): void
  /** The request's cancellation signal; the listener is removed on every path. */
  signal: AbortSignal
  /** The abort listener registered on {@link signal} at start. */
  onAbort: () => void
}

/**
 * Clip a diagnostic to the seam's byte ceiling on whole code points.
 *
 * Walks by code point (`for…of`) rather than slicing bytes or characters, so a
 * surrogate pair or a three-byte CJK character is either carried whole or
 * dropped — never split into a replacement character.
 *
 * @param text - the provider-authored detail.
 * @returns the detail, whole, when it fits.
 */
export function clipDiagnostic(text: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength <= SUBAGENT_DIAGNOSTIC_MAX_BYTES) return text
  let out = ''
  let bytes = 0
  for (const character of text) {
    const size = encoder.encode(character).byteLength
    if (bytes + size > SUBAGENT_DIAGNOSTIC_MAX_BYTES) break
    out += character
    bytes += size
  }
  return out
}

/**
 * Settle a run result under the seam contract: the answer never rejects.
 *
 * The ORDER matters and is the whole point. `cancelled()` is consulted BEFORE the
 * attempt's outcome on both paths, because a child that produced a late answer
 * after we stopped listening did not succeed — reporting it as `completed` would
 * tell the parent a cancelled run finished. Symmetrically, a child that throws
 * after our own cancellation did not fail; `onError` stays silent.
 *
 * @param parts - the attempt, the output snapshot, cancellation state and wiring.
 * @returns the terminal result, always.
 */
export async function settleRunResult(parts: RunResultSettlement): Promise<SubagentResult> {
  /**
   * The two collectors are the LAST things that can break this function's
   * promise, and they are exactly the ones a provider supplies from LIVE
   * backend state (a session snapshot, a session's last error) — so a throw is a
   * real possibility, not a theoretical one. `externalRunHandle` hands the
   * result promise straight through with no `.catch` of its own, so an escaping
   * throw becomes `run.result` REJECTING, which the seam contract forbids. The
   * `onError` sink was already contained; these two were not.
   *
   * Degrading to the empty value is the honest answer, but on its own it is
   * indistinguishable from a genuinely empty one, so the throw is also REPORTED
   * through that same sink, labelled with the collector that broke. The report
   * is itself contained: a sink that throws must not become the rejection this
   * whole function exists to avoid.
   */
  const report = (label: string, error: unknown, stopReason: SubagentStopReason): void => {
    try {
      const cause = toError(error)
      // `cause` keeps the original error's identity: this path reads live backend
      // state, so it is exactly the path an operator will need to investigate,
      // and a rebuilt message alone would throw away the stack that says where.
      parts.onError?.(new Error(`${label}: ${cause.message}`, { cause }), stopReason)
    } catch {
      // Contained by construction: this runs inside a collector's own catch.
    }
  }
  const collectOutput = (stopReason: SubagentStopReason): readonly SubagentContentBlock[] => {
    try {
      return parts.collectOutput()
    } catch (error) {
      report('collectOutput() failed', error, stopReason)
      return []
    }
  }
  const collectDiagnostic = (stopReason: SubagentStopReason): string | undefined => {
    try {
      return parts.collectDiagnostic?.()
    } catch (error) {
      report('collectDiagnostic() failed', error, stopReason)
      return undefined
    }
  }
  try {
    const result = await parts.attempt()
    if (parts.cancelled()) {
      return { output: collectOutput('aborted'), stopReason: 'aborted' }
    }
    // A provider-supplied diagnostic rides the same ceiling as one collected
    // here; the host normalizes both, so the transcription does too.
    return result.diagnostic === undefined
      ? result
      : { ...result, diagnostic: clipDiagnostic(result.diagnostic) }
  } catch (error) {
    if (parts.cancelled()) {
      return { output: collectOutput('aborted'), stopReason: 'aborted' }
    }
    try {
      parts.onError?.(toError(error), 'error')
    } catch {
      // A broken diagnostic sink must not turn a settled failure into a rejection.
    }
    const collected = collectDiagnostic('error')
    const diagnostic = collected === undefined ? undefined : clipDiagnostic(collected)
    return {
      output: collectOutput('error'),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      stopReason: 'error',
    }
  } finally {
    parts.signal.removeEventListener('abort', parts.onAbort)
  }
}

/** Coerce a thrown value to an Error without assuming the caller threw one. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

// ---------------------------------------------------------------------------
// externalRunHandle — the idempotent handle
// ---------------------------------------------------------------------------

/** Inputs to {@link externalRunHandle}. */
export interface ExternalRunHandleParts {
  /** The parent-scoped run id. */
  readonly id: string
  /** The flattened, never-rejecting result. */
  readonly result: Promise<SubagentResult>
  /** The request's cancellation signal; the listener is removed on dispose. */
  readonly signal: AbortSignal
  /** The abort listener registered on {@link signal} at start. */
  readonly onAbort: () => void
  /** Settle local cancellation so {@link result} resolves without the child. */
  requestCancel(): void
  /** Tear the child down to quiescence. Backend-owned. */
  teardown(): Promise<void>
}

/**
 * Publish the run handle for an external child.
 *
 * `dispose()` memoizes ONE teardown: remove the abort listener, settle local
 * cancellation, then await the backend's teardown. The order is the contract —
 * `requestCancel()` runs before teardown because there is no assumption the child
 * cooperates, and the first `dispose()`'s promise is returned by every later call
 * so a second caller cannot double-release.
 *
 * @param parts - run identity, result, cancellation wiring and teardown.
 * @returns the external run handle.
 */
export function externalRunHandle(parts: ExternalRunHandleParts): SubagentRun {
  let disposal: Promise<void> | undefined
  return {
    id: parts.id,
    result: parts.result,
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      parts.signal.removeEventListener('abort', parts.onAbort)
      parts.requestCancel()
      // WRAPPED, not assigned bare. A teardown that throws SYNCHRONOUSLY would
      // leave `disposal` undefined, so the next `dispose()` would run a second
      // teardown against a child the first one may have half-released — the
      // exact thing the memo exists to prevent. `Promise.resolve().then` turns
      // that throw into a rejection the memo can hold.
      disposal = Promise.resolve().then(() => parts.teardown())
      return disposal
    },
  }
}

// ---------------------------------------------------------------------------
// matchRoute — configuration-owned target selection
// ---------------------------------------------------------------------------

/**
 * One declared target route.
 *
 * A route names a Cherry workspace, and optionally the device that hosts it. The
 * seam has NO per-call channel for a delegation TARGET — the object a provider
 * receives is built by the runtime and its fields are fixed
 * (`@deepseek-ai/dsh-subagent/lib/index.js:1504-1509`).
 *
 * `cwd` is the only caller-influenced field that can carry a DIRECTORY, which is
 * why routing keys on it. It is NOT the only caller-influenced field: `label` and
 * `prompt` are model-authored too. They are unusable as routing keys for the
 * opposite reason — a label is a caption, not a path, and matching on prompt text
 * would make a delegation's destination depend on prose.
 */
export interface CherrySubagentRoute {
  /** Directory prefix this route claims, compared after normalization. */
  readonly cwdPrefix: string
  /** Device override; omission keeps the default device. */
  readonly device?: string
  /** Workspace override; omission keeps the default workspace. */
  readonly workspaceId?: string
}

/**
 * Normalize one path for comparison.
 *
 * Collapses `.` and `..`, folds repeated separators, and strips a trailing
 * separator (except on a bare root). Case is NOT folded: a case-insensitive
 * compare would route on a filesystem the user never declared.
 *
 * @param value - the path or prefix to normalize.
 * @returns the normalized path.
 */
function normalizeRoutePath(value: string): string {
  const normalized = normalize(value)
  if (normalized.length > 1 && normalized.endsWith(sep)) {
    return normalized.slice(0, -sep.length)
  }
  return normalized
}

/**
 * Find the route that claims a working directory.
 *
 * FIRST declared match wins, not the longest — a declaration order the user
 * writes is a precedence they can read, while longest-prefix silently reorders
 * their intent. Matching is at a PATH SEGMENT boundary: `/workspace/dsh` claims
 * `/workspace/dsh/src` but not `/workspace/dsh2`.
 *
 * @param routes - the declared routes, in precedence order.
 * @param cwd - the resolved child directory from the seam.
 * @returns the matching route, or undefined so the caller falls back.
 */
export function matchRoute(
  routes: readonly CherrySubagentRoute[] | undefined,
  cwd: string,
): CherrySubagentRoute | undefined {
  if (routes === undefined || routes.length === 0) return undefined
  const target = normalizeRoutePath(cwd)
  for (const route of routes) {
    const prefix = normalizeRoutePath(route.cwdPrefix)
    if (prefix.length === 0) continue
    if (target === prefix || target.startsWith(prefix + sep)) return route
  }
  return undefined
}

// ---------------------------------------------------------------------------
// textPrompt — what the seam can actually carry
// ---------------------------------------------------------------------------

/**
 * Flatten a task to the one string a Cherry run can carry.
 *
 * Runs BEFORE anything is created on the Cherry side, so a task this provider
 * cannot represent is refused rather than degraded: dropping an image block would
 * hand the child a different task than the parent composed, and an empty task
 * would start a run with nothing to do.
 *
 * @param prompt - the task's content blocks.
 * @returns the concatenated text, in order.
 * @throws when a block is not text, when the task is empty after trimming, or
 *   when it is longer than the peer's own body ceiling.
 */
export function textPrompt(prompt: readonly SubagentContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('cherry subagent: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('cherry subagent: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  const joined = texts.join('')
  if (joined.trim().length === 0) {
    throw new Error('cherry subagent: the one-shot task must not be empty')
  }
  // The peer's schema refuses a body over this, so a task assembled by a model
  // would come back as a schema error from the wire. Refusing here — still
  // before anything exists on the Cherry side — is the same judgement the
  // empty-task rule makes, one dimension over.
  if (joined.length > MESSAGE_TEXT_MAX_CHARS) {
    throw new Error(
      `cherry subagent: the one-shot task is ${joined.length} characters, over the ${MESSAGE_TEXT_MAX_CHARS} ` +
        'the peer accepts; shorten it or delegate it in several runs',
    )
  }
  return joined
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * What one Cherry run reports back to the provider.
 *
 * Deliberately not the seam's `SubagentResult`: the runner reports what the peer
 * said, and the provider decides what that means for `stopReason` and
 * `diagnostic`. Keeping the two apart is what lets the mapping be tested without
 * a socket.
 */
export interface CherrySubagentRunOutcome {
  /** The peer's terminal status, as `cherry_send`/`cherry_wait` report it. */
  readonly status: string
  /** This run's assistant text, folded by the same rule the tools use. */
  readonly text: string
  /** Provider-authored failure detail for a non-completed status. */
  readonly diagnostic?: string
}

/** Everything the provider needs from the rest of the plugin. */
export interface CherryProviderDeps {
  /**
   * Execute one delegation against Cherry Studio.
   *
   * The seam-to-peer wiring (target resolution, session creation, the wait loop
   * and the interaction policy) lives behind this one method so the provider does
   * not learn the rpc surface.
   */
  run(input: {
    readonly text: string
    /** The seam's resolved child directory — a routing key, never stat'ed. */
    readonly cwd: string
    readonly label: string | undefined
    readonly signal: AbortSignal
  }): Promise<CherrySubagentRunOutcome>
}

/** The output blocks for one run's text; empty when there is nothing to report. */
function textBlocks(text: string): SubagentContentBlock[] {
  return text.trim().length === 0 ? [] : [{ type: 'text', text }]
}

/**
 * What the runner's outcome means to the seam.
 *
 * `aborted` is the one status the peer never reported: the runner synthesises it
 * when OUR signal ended the wait, which is why it maps to the seam's own
 * `aborted` rather than to an error. Everything that is not `completed` carries
 * a diagnostic when the runner supplied one — and a `completed` result never
 * does, because the host appends a result's diagnostic to the settlement
 * notification and an unexplained warning on a success is worse than silence.
 *
 * @param outcome - what the run amounted to.
 * @returns the seam's result.
 */
function toSubagentResult(outcome: CherrySubagentRunOutcome): SubagentResult {
  const output = textBlocks(outcome.text)
  if (outcome.status === 'completed') return { output, stopReason: 'completed' }
  if (outcome.status === 'aborted') return { output, stopReason: 'aborted' }
  return {
    output,
    stopReason: 'error',
    ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
  }
}

/**
 * Build the one-shot Cherry provider.
 *
 * The shape the runtime sees is three declarations and one method:
 * `capabilities` is all-false (this provider cannot honour an agent preset, an
 * output schema or a depth limit, and the host refuses such a request BEFORE
 * `start`), `inheritsParentContext` is false (a Cherry child starts fresh), and
 * `start` returns a run handle immediately.
 *
 * ## What `start` refuses, and what it defers
 *
 * A task this provider cannot represent is refused BEFORE anything exists on the
 * Cherry side, so a rejected delegation leaves no orphan session behind (SUB-20,
 * SUB-21) — and so is a request whose signal has already aborted (SUB-24).
 *
 * Everything else DEFERS: an unreachable device, a session the peer refused, a
 * run that failed. `start` returns a run handle at once and those settle through
 * `run.result`, because the alternative is a parent blocked on a device handshake
 * it cannot cancel. The seam's contract draws exactly this line — fail before
 * returning means clean up and reject, fail after means settle through the
 * result — and a run whose handle already exists is on the far side of it.
 *
 * ## The two signals
 *
 * `request.signal` is the parent's. `dispose()` has to stop the child WITHOUT
 * that signal having fired (the host disposes a run for reasons of its own), so
 * the provider owns a LOCAL controller: `deps.run` watches the local one, the
 * parent's abort is forwarded into it, and `requestCancel` aborts it. That is
 * also what makes `settleRunResult`'s `cancelled()` answer `true` on the dispose
 * path — the seam requires a disposed run to settle as `aborted` rather than
 * report a `completed` nobody is listening for.
 *
 * @param deps - the run seam: the one place a delegation touches Cherry Studio.
 * @param options - the registration name; the configured one, defaulting to `cherry`.
 * @returns a provider the runtime can register under the configured name.
 */
export function createCherryProvider(
  deps: CherryProviderDeps,
  options: { readonly name?: string } = {},
): CherrySubagentProvider {
  return {
    name: options.name ?? CHERRY_SUBAGENT_PROVIDER_DEFAULT,
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    async start(request: SubagentStartRequest): Promise<SubagentRun> {
      // Both refusals happen before anything exists on the Cherry side, so a
      // rejected delegation leaves no orphan session behind.
      const text = textPrompt(request.prompt)
      if (request.signal.aborted) {
        throw new Error('cherry subagent: the request was aborted before startup')
      }

      const local = new AbortController()
      const onHostAbort = (): void => {
        local.abort()
      }
      request.signal.addEventListener('abort', onHostAbort, { once: true })

      // The run's own state, read by the collectors. `outcome` is set the moment
      // the runner reports; `failure` when it could not even be started. Both are
      // captured because `settleRunResult` asks for them AFTER the attempt
      // settles, and by then the promise's value is no longer reachable.
      let outcome: CherrySubagentRunOutcome | undefined
      let failure: Error | undefined
      const attempt = deps.run({ text, cwd: request.cwd, label: request.label, signal: local.signal }).then(
        (settled) => {
          outcome = settled
          return settled
        },
        (error: unknown) => {
          failure = error instanceof Error ? error : new Error(String(error))
          throw failure
        },
      )
      // Never rejects, so it can be awaited by `teardown` without a catch of its
      // own: a disposed run is one whose child has stopped, and a run that failed
      // to start has already stopped.
      const stopped = attempt.then(
        () => undefined,
        () => undefined,
      )

      return externalRunHandle({
        // D5: the seam's id is the HOST's `childId`, and the host refuses a
        // duplicate — so it is minted here, not borrowed from the Cherry session
        // id (which does not exist yet at this point anyway).
        id: randomUUID(),
        result: settleRunResult({
          attempt: async () => toSubagentResult(await attempt),
          // A partial only exists once the runner has reported. `cancelled()`
          // decides whether it is reported at all, and it reads the LOCAL signal
          // so a dispose settles as aborted.
          collectOutput: () => (outcome === undefined ? [] : textBlocks(outcome.text)),
          collectDiagnostic: () =>
            outcome === undefined
              ? // The runner could not start: its message is the only account of
                // why, and it is ours (an unreachable device, a refused session),
                // not peer content.
                failure?.message
              : outcome.diagnostic,
          cancelled: () => local.signal.aborted,
          signal: request.signal,
          onAbort: onHostAbort,
        }),
        signal: request.signal,
        onAbort: onHostAbort,
        requestCancel: () => {
          local.abort()
        },
        // Awaiting the settlement is what "runs until the child has actually
        // stopped" means for a remote child: the runner's cancellation path
        // issues the peer's own `agent.executions.cancel` and then answers.
        teardown: () => stopped,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// SubagentConfig — the one table both faces read
// ---------------------------------------------------------------------------

/**
 * The operator's configuration for the subagent subsystem.
 *
 * Deliberately ONE flat table, readable and writable by a single GET/PUT pair
 * (#233) with `revision` as the optimistic lock: a shape that could only be read
 * from profile YAML would have to be re-derived by the settings page, and the two
 * readings would drift. Every field is optional — the switch is what decides,
 * and a draft target behind a closed switch is not an error (SUB-01).
 */
export interface SubagentConfig {
  /** The switch. Absent or `false` registers nothing (SUB-01). */
  enabled?: boolean
  /** The name the provider is registered under. Default `cherry`. */
  providerName?: string
  /** The name the tool is exposed under. Default `cherry_subagent`. */
  toolName?: string
  /** Device selector — an exact id or a unique prefix, as the tools take it. */
  device?: string
  /** The Cherry agent that runs the delegation. */
  agentId?: string
  /** A registered workspace id, as `cherry_workspaces` reports it. */
  workspaceId?: string
  /** The other arm of the workspace choice; mutually exclusive with {@link workspaceId}. */
  workspaceKind?: 'system'
  /** Declaration only (D1): which directory a delegation is told it is in. */
  cwdMode?: 'isolated' | 'shared'
  /** Per-directory target overrides, in precedence order (SUB-10..14). */
  routes?: readonly CherrySubagentRoute[]
  /** The wait window; `0` means no wall-clock bound (SUB-40..43). */
  timeoutMs?: number
  /** How many interactions one delegation may abandon (SUB-31). */
  maxInteractionAbandons?: number
  /** The revision this config was read at; the next `PUT` quotes it (#233). */
  revision?: number
}

/** Where a delegation actually lands. */
export interface SubagentTarget {
  /** Device selector, as configured. */
  readonly device: string
  /** The Cherry agent id. */
  readonly agentId: string
  /** The workspace arm: a registered id, or the system workspace. */
  readonly workspace: { readonly workspaceId: string } | { readonly kind: 'system' }
}

/** A config that passed validation, with every default applied. */
export interface ResolvedSubagentConfig {
  readonly providerName: string
  readonly toolName: string
  readonly target: SubagentTarget
  readonly cwdMode: 'isolated' | 'shared'
  readonly routes: readonly CherrySubagentRoute[]
  readonly timeoutMs: number
  readonly maxInteractionAbandons: number
  readonly revision: number
}

/**
 * What the switch decided.
 *
 * Three outcomes, not two, because "off" and "wrong" are different answers: off
 * registers nothing and says nothing (SUB-01), while wrong stops the subsystem at
 * `failed` with a reason a human can act on (SUB-03). Folding the second into the
 * first would hide a broken configuration behind a switch the operator believes
 * is on.
 */
export type SubagentConfigResolution =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'invalid'; readonly problems: readonly string[] }
  | { readonly kind: 'ready'; readonly config: ResolvedSubagentConfig }

/** The largest delay `setTimeout` honours; above it Node fires after ~24.8 days. */
const TIMER_CEILING_MS = 2_147_483_647

/** Read one optional non-blank string field, recording a problem when it is unusable. */
function optionalText(
  raw: Record<string, unknown>,
  key: string,
  problems: string[],
): string | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    problems.push(`\`${key}\` 必须是字符串（收到 ${shapeName(value)}）`)
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    problems.push(`\`${key}\` 不能为空`)
    return undefined
  }
  return trimmed
}

/** Read one optional integer in a closed range, recording a problem when it is unusable. */
function optionalInteger(
  raw: Record<string, unknown>,
  key: string,
  problems: string[],
  range: { min: number; max: number },
): number | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < range.min || value > range.max) {
    problems.push(`\`${key}\` 必须是 ${range.min} 到 ${range.max} 之间的整数（收到 ${shapeName(value)}）`)
    return undefined
  }
  return value
}

/** The shape a config value arrived as, for a value-free problem message. */
function shapeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  return typeof value
}

/** Validate the route table, recording a problem per unusable entry. */
function routesOf(raw: Record<string, unknown>, problems: string[]): CherrySubagentRoute[] {
  const value = raw['routes']
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    problems.push(`\`routes\` 必须是数组（收到 ${shapeName(value)}）`)
    return []
  }
  const routes: CherrySubagentRoute[] = []
  value.forEach((entry: unknown, index: number) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`\`routes[${index}]\` 必须是对象（收到 ${shapeName(entry)}）`)
      return
    }
    const record = entry as Record<string, unknown>
    const prefix = optionalText(record, 'cwdPrefix', [])
    if (prefix === undefined) {
      problems.push(`\`routes[${index}]\` 缺少非空的 \`cwdPrefix\``)
      return
    }
    const device = optionalText(record, 'device', problems)
    const workspaceId = optionalText(record, 'workspaceId', problems)
    routes.push({
      cwdPrefix: prefix,
      ...(device === undefined ? {} : { device }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    })
  })
  return routes
}

/**
 * Resolve the operator's `subagent` config into the decision the assembly acts on.
 *
 * Validation is exhaustive rather than fail-fast: the answer is one `failed`
 * state whose reason lists EVERY unusable field, because an operator fixing a
 * config one reload per mistake is the outcome a first-error-wins validator
 * produces.
 *
 * @param raw - the `subagent` config value, exactly as the host handed it over.
 * @returns `disabled`, `invalid` with the problems, or `ready` with the defaults applied.
 */
export function resolveSubagentConfig(raw: unknown): SubagentConfigResolution {
  // Absent — and an explicitly empty key, which is the same statement — is the
  // switch being off, not a mistake to report.
  if (raw === undefined || raw === null) return { kind: 'disabled' }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    // Present but unreadable. Answering `disabled` here would hide a typo behind
    // a switch the operator believes is on, so it is a problem by name.
    return { kind: 'invalid', problems: [`\`subagent\` 必须是对象（收到 ${shapeName(raw)}）`] }
  }
  const record = raw as Record<string, unknown>
  const problems: string[] = []

  const enabled = record['enabled']
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    problems.push(`\`enabled\` 必须是布尔值（收到 ${shapeName(enabled)}）`)
  }
  if (enabled !== true) {
    // Off is off: a target left half-written behind a closed switch is a draft.
    // The only exception is an unreadable `enabled`, which cannot be called off.
    return problems.length > 0 ? { kind: 'invalid', problems } : { kind: 'disabled' }
  }

  const providerName = optionalText(record, 'providerName', problems) ?? CHERRY_SUBAGENT_PROVIDER_DEFAULT
  const toolName = optionalText(record, 'toolName', problems) ?? CHERRY_SUBAGENT_TOOL_DEFAULT
  const device = optionalText(record, 'device', problems)
  const agentId = optionalText(record, 'agentId', problems)
  const workspaceId = optionalText(record, 'workspaceId', problems)
  const workspaceKind = record['workspaceKind']
  if (workspaceKind !== undefined && workspaceKind !== 'system') {
    problems.push(`\`workspaceKind\` 只接受 "system"（收到 ${shapeName(workspaceKind)}）`)
  }
  const cwdModeValue = record['cwdMode']
  if (cwdModeValue !== undefined && cwdModeValue !== 'isolated' && cwdModeValue !== 'shared') {
    problems.push(`\`cwdMode\` 只接受 "isolated" 或 "shared"（收到 ${shapeName(cwdModeValue)}）`)
  }
  const timeoutMs = optionalInteger(record, 'timeoutMs', problems, { min: 0, max: TIMER_CEILING_MS })
  const maxInteractionAbandons = optionalInteger(record, 'maxInteractionAbandons', problems, {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  })
  const revision = optionalInteger(record, 'revision', problems, { min: 0, max: Number.MAX_SAFE_INTEGER })
  const routes = routesOf(record, problems)

  // The target: device and agent, plus exactly one arm of the workspace choice.
  if (device === undefined && record['device'] === undefined) problems.push('缺少 `device`')
  if (agentId === undefined && record['agentId'] === undefined) problems.push('缺少 `agentId`')
  if (workspaceId !== undefined && workspaceKind === 'system') {
    problems.push('`workspaceId` 与 `workspaceKind: "system"` 只能二选一')
  } else if (workspaceId === undefined && workspaceKind !== 'system') {
    problems.push('缺少 `workspaceId`（或 `workspaceKind: "system"`）')
  }

  if (problems.length > 0) return { kind: 'invalid', problems }
  // Narrowing: the three target fields are present because every missing one
  // pushed a problem, and a run reaching here has none.
  const workspace: SubagentTarget['workspace'] =
    workspaceId === undefined ? { kind: 'system' } : { workspaceId }
  return {
    kind: 'ready',
    config: {
      providerName,
      toolName,
      target: { device: device as string, agentId: agentId as string, workspace },
      cwdMode: cwdModeValue === 'shared' ? 'shared' : 'isolated',
      routes,
      timeoutMs: timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
      maxInteractionAbandons: maxInteractionAbandons ?? DEFAULT_MAX_INTERACTION_ABANDONS,
      revision: revision ?? 0,
    },
  }
}
