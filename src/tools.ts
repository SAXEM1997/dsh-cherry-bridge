import { createHash, randomUUID } from 'node:crypto'
import { DeviceUnavailableError } from './connection'
import type { DeviceConnection, DeviceState } from './connection'
import type { DeviceRecord, DeviceResolution, DeviceStore } from './deviceStore'
import { JsonRpcRequestError } from './rpc/jsonRpcClient'
import type { ReadResult, SessionSubscriptions } from './subscriptions'
import { PairingError } from './pairing'
import type { PairingErrorKind } from './pairing'
import type { AgentCursor } from '@cherrystudio/remote-protocol/agent'

/**
 * The plugin's tool face: the complete fourteen-tool `cherry_*` family — six
 * READ-ONLY tools (Task 8), six INTERACTIVE ones (Task 9) and two MANAGEMENT
 * ones (Task 10) — plus the registration framework they all share.
 *
 * Three disciplines run through every tool:
 *
 *  - **Literal JSON Schema parameters** (global constraint): the host registry
 *    consumes the declaration directly, so no zod enters this file.
 *  - **The device selector never throws for ambiguity**: an ambiguous display
 *    name is a structured candidate list, and a non-connected device is the
 *    structured `{device, state}` verdict of spec §6 — never an implicit dial.
 *  - **Pagination is an aggregate concern** (controller ruling ②): the caller's
 *    `limit` bounds the TOTAL across pages, while every page request is clamped
 *    to the peer-negotiated `limits.pageItems` — the protocol's single-page
 *    hard cap is never exceeded, whatever the caller asks for.
 */

// ---------------------------------------------------------------------------
// Host service seams
// ---------------------------------------------------------------------------
//
// Structural types, deliberately narrow: the host's `ctx.tools.register` is not
// imported as a type, so the plugin neither depends on a host package at build
// time nor breaks when the host's declarations move. Verified against the real
// host registry (@deepseek-ai/dsh-tools `ToolDefinition` +
// `parameterSchemaSpecToJsonSchema`), whose compiled `parameters` output is
// exactly the literal shape declared here.

/** One tool's literal JSON Schema parameters, as the host registry stores them. */
export interface ToolParametersSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

/** A content block the host turns into model-facing tool output. */
export interface ToolContentBlock {
  type: 'text'
  text: string
}

/** The registry-ready definition this plugin hands the host. */
export interface CherryToolDefinition {
  name: string
  description: string
  parameters: ToolParametersSchema
  output: {
    /** Canonical value schema; the host validates `execute`'s return against it. */
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ToolContentBlock[]
  }
  execute(args: Record<string, unknown>): Promise<unknown>
}

/** The host's tool registry, as this plugin consumes it. */
export interface ToolsServiceLike {
  register(definition: CherryToolDefinition): () => void
}

/** The context slice the tool face needs. */
export interface CherryToolsContext {
  tools?: ToolsServiceLike
}

// ---------------------------------------------------------------------------
// Tool-facing output contract
// ---------------------------------------------------------------------------

/**
 * One device as `cherry_devices` reports it. `state` is the connection's CLOSED
 * five-state set; a device with no live connection reports its stored `enabled`
 * flag as `disabled`, otherwise `offline` — answering never dials.
 */
export interface CherryDeviceView {
  deviceId: string
  displayName: string
  state: DeviceState
  enabled: boolean
  hosts: string[]
  port: number
}

/** The shared `{device, state}` verdict (spec §6: 设备离线). */
export interface CherryDeviceUnavailable {
  error: 'device-unavailable'
  device: string
  state: DeviceState
}

/** An unresolved device name: the candidates the caller must disambiguate. */
export interface CherryAmbiguousDevice {
  error: 'ambiguous-device'
  device: string
  candidates: string[]
}

/** Why an aggregate stopped before the peer said it was done. */
export type CherryTruncationReason =
  /** The caller's `limit` was reached with more items available. */
  | 'limit'
  /** The safety circuit-breaker tripped; the peer still had pages to serve. */
  | 'safety-bound'

/** A page-aggregating result: the items plus how completely they were read. */
export interface CherryPage<T> {
  items: T[]
  /** True when the aggregate stopped before the peer ran out. */
  truncated: boolean
  /**
   * Present exactly when `truncated` is true: WHY the walk stopped. A truncated
   * result is never silent — the caller always learns that content was left.
   */
  truncationReason?: CherryTruncationReason
  /** The cursor to resume from, present only on a non-limit truncation. */
  nextCursor?: string
}

/** `cherry_events`' structured window verdict (spec §6: cursor-out-of-window). */
export interface CherryCursorOutOfWindow {
  error: 'cursor-out-of-window'
  message: string
  windowStart: AgentCursor | null
}

/** One aggregated part in a `cherry_read` snapshot. */
export interface CherryReadPart {
  partId: string
  kind: string
  revision: string
  /** The fully aggregated text (a `{ref}` part resolved and verified). */
  content: string
  state?: string
  toolName?: string
  toolCallId?: string
}

/** One message in a `cherry_read` snapshot. */
export interface CherryReadMessage {
  messageId: string
  revision: string
  role: string
  status: string
  parts: CherryReadPart[]
  /**
   * Present only when this message's parts could NOT all be read: the safety
   * circuit-breaker stopped the walk. Absent means the part list is complete.
   */
  partsTruncated?: CherryTruncationReason
  /** The `parts.list` cursor to resume this message's part walk from. */
  partsResumeCursor?: string
}

/** The two-level `cherry_read` snapshot. */
export interface CherryReadSnapshot {
  session: Record<string, unknown>
  messages: CherryReadMessage[]
  truncated: boolean
  /** The MESSAGE-walk truncation reason, when `truncated` is true. */
  truncationReason?: CherryTruncationReason
}

// ---------------------------------------------------------------------------
// Interactive-face contracts (Task 9)
// ---------------------------------------------------------------------------

/**
 * `cherry_send`/`cherry_wait`'s result status.
 *
 * The FOUR terminal execution states (`completed`/`failed`/`cancelled`/
 * `interrupted`) are the waiter predicate's whole vocabulary — the protocol's
 * closed terminal set. The other three are the waiter's OWN verdicts:
 *
 *  - `awaiting-interaction` — the SOFT terminal: an unanswered interaction
 *    arrived, so the run is still alive but cannot progress without the caller.
 *  - `timeout` — the window elapsed. NOT a failure (spec §6): the caller gets
 *    what arrived plus the cursor to resume from.
 *  - `idle` — `cherry_wait` on a session with no in-flight execution: the
 *    current snapshot, returned at once (no error, no waiting).
 *
 * NOTE the deliberate omission: a COMMAND RECEIPT's `interrupted` (the command
 * outcome is undecided) is a DIFFERENT dimension and never appears here.
 */
export type CherryRunStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'awaiting-interaction'
  | 'timeout'
  | 'idle'

/** The four terminal execution statuses the waiter predicate covers. */
const TERMINAL_EXECUTION_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'] as const

/** The `cherry_create` result: the receipt plus the two-step read-back. */
export interface CherryCreateResult {
  sessionId: string
  device: string
  /** Read back through `agent.sessions.get` — never taken from the receipt. */
  workspaceId?: string
  workspaceKind?: string
  session?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Protocol constants (values come from the peer's hello, never hardcoded here)
// ---------------------------------------------------------------------------

/** The protocol's single-page hard cap, used only as the pre-hello ceiling. */
const PAGE_ITEMS_FALLBACK = 100
/** The largest MESSAGE aggregate a caller may ask for; the per-page clamp still applies. */
const MAX_AGGREGATE_LIMIT = 1000
/** One `agent.content.read` slice is capped at the protocol's `remoteLimits.contentBytes`. */
const CONTENT_READ_MAX_BYTES = 24 * 1024
/**
 * CIRCUIT-BREAKER for the parts walk (a local policy bound, NOT a protocol
 * limit — the protocol caps nothing at 1000 parts). A message's parts are read
 * to COMPLETION, so this exists only to stop a peer that never terminates its
 * pagination. Tripping it is SURFACED (`partsTruncated` + `partsResumeCursor`),
 * never silent, so a caller can always tell a complete part list from a
 * circuit-broken one. Injectable for tests.
 */
const DEFAULT_PARTS_SAFETY_BOUND = 10_000
/**
 * PAGE-COUNT BACKSTOP for every aggregate walk, alongside the item ceiling.
 *
 * The item ceiling alone cannot stop a peer that answers `items: []` with a
 * non-null `nextCursor`: the item count never grows, so a bound expressed only
 * in items is never reached. This is a peer fault, and a walk that hits it
 * FAILS — an empty page that claims more are coming is never a reason to return
 * a partial (or empty) result as though it were complete.
 */
const MAX_AGGREGATE_PAGES = 10_000
/**
 * CIRCUIT-BREAKER for one `{ref}`'s content walk, used only when the ref
 * carries no usable `byteLength`. The ref's declared length normally derives
 * the bound exactly; this is the fallback for a malformed ref, and exceeding it
 * FAILS the read rather than returning a partial (unverifiable) content.
 */
const DEFAULT_CONTENT_SLICE_BOUND = 4_096

/** The protocol's `agent.messages.send.text` ceiling, pre-validated tool-side. */
const TEXT_MAX_LENGTH = 32_768
/** The default wait window, in ms (spec §3.6). A default, never a cap. */
const DEFAULT_WAIT_TIMEOUT_MS = 120_000
/** The smallest meaningful timeout: below this the wait is a snapshot read. */
const MIN_WAIT_TIMEOUT_MS = 1

/**
 * POLL CADENCE for the waiter loop.
 *
 * The waiter rides the subscriptions layer's event buffer, which exposes a
 * cursor-gated `waitFor` rather than a predicate hook, so the run is judged by
 * re-reading the projection after each wake. This constant only bounds how long
 * a wait may sit between two judgement passes when the peer has gone quiet, so
 * a missed wake degrades into a slightly late answer instead of a hang. It is
 * injectable for tests.
 */
const DEFAULT_WAIT_POLL_MS = 25

/**
 * Externalized part content is read in ≤24 KiB slices and the WHOLE content's
 * sha256 is verified once the slices are reassembled — the digest the ref
 * advertises covers the full content, not any single slice (the real peer's
 * `sliceContent` returns exactly that).
 */

// ---------------------------------------------------------------------------
// Dependency surface
// ---------------------------------------------------------------------------

/** Everything the tool face needs from the assembly. */
export interface CherryToolsDeps {
  store: DeviceStore
  /** Resolve (creating on first use) the pooled connection for a device. */
  connect(deviceId: string): DeviceConnection
  /** Per-device session subscriptions, sharing one LRU pool. */
  subs(deviceId: string): SessionSubscriptions
  /**
   * Task 10's pairing entry point (see {@link CherryPairRequest}).
   *
   * The LOCAL IDENTITY lives behind this seam rather than in the deps: the tool
   * passes a payload and receives a record, and the key bytes — the assembly's
   * own state, whose load is asynchronous — never enter the tool face. (The HTTP
   * face names it for the same reason, and needs a lazy accessor: `apply` cannot
   * await the key load.)
   */
  pair: (request: CherryPairRequest) => Promise<DeviceRecord>
  /**
   * Drop the pooled connection for a device, closing it. Resolves-existing-only:
   * a device with no pooled entry must NOT have one fabricated, because the
   * whole point of eviction is that the next `connect()` rebuilds from the
   * CURRENT store record.
   *
   * REQUIRED, not an optimization (controller ruling 1): a pool that can only
   * `connect`/`detach` silently reintroduces the disable→enable wedge — a
   * `DeviceConnection` captures its record at construction, so a pooled
   * instance can never observe an edited address or a flipped `enabled` flag.
   *
   * `cherry_unpair` is the other caller: it evicts (drop + close) and then
   * removes the archive entry, so no live socket outlives its record.
   */
  evict(deviceId: string): void | Promise<void>
}

// ---------------------------------------------------------------------------
// The management face's contracts (Task 10)
// ---------------------------------------------------------------------------

/**
 * One pairing run, as `cherry_pair` asks the assembly to perform it.
 *
 * Deliberately NARROWER than `PairWithPayloadOptions`: the tool states the
 * payload and where to report the verification code and the progress stages,
 * while `identity` and `store` — the assembly's own state, which the tool has no
 * business naming — stay behind the seam.
 */
export interface CherryPairRequest {
  /** The desktop's pairing payload (QR content / exported string). */
  payload: string
  /** Overrides the claimed device name (default: this machine's hostname). */
  name?: string
  /**
   * Receives the 6-digit code the user compares on the desktop. The pairing
   * cannot complete without it, so it reaches the caller before the terminal
   * state, whatever that state turns out to be.
   */
  onVerificationCode: (code: string) => void
  /**
   * Coarse progress stages ('validate' | 'connect' | 'claim' | 'waiting'), for
   * a caller that wants to narrate a run which can take a minute. The assembly
   * bridges this to its pairing-progress fan-out (ruling 10).
   */
  onStatus?: (stage: string) => void
}

/**
 * `cherry_pair`'s outcome.
 *
 * The pairing is a CONVERSATION with a human: every terminal state is an ANSWER
 * the caller acts on, never a thrown error. `rejected` and `expired` are the
 * peer's verdicts; `invalid-payload` and `unreachable` are this plugin's own
 * (the payload never named a reachable desktop). All four still carry the
 * verification code when one had already been surfaced — the code is exactly
 * what the user is comparing when they decide.
 */
export interface CherryPairResult {
  status: 'approved' | PairingErrorKind
  /** The paired device id. Present only on `approved`: no other branch has one. */
  device?: string
  /** The name the desktop shows for this device. Present only on `approved`. */
  displayName?: string
  /** The 6-digit code, once the claim reached this device. */
  verificationCode?: string
  /** Why the pairing ended where it did (absent on `approved`). */
  message?: string
}

/** `cherry_unpair`'s outcome. */
export interface CherryUnpairResult {
  device: string
  displayName: string
  /** Always true on a successful unpair; the shape lets a caller assert it. */
  removed: true
}

interface ResolvedDevice {
  record: DeviceRecord
  connection: DeviceConnection
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The peer's failure discriminator, or undefined for a non-protocol error. */
function failureReason(error: unknown): string | undefined {
  if (!(error instanceof JsonRpcRequestError)) return undefined
  const data = error.data
  if (isRecord(data) && typeof data['reason'] === 'string') return data['reason']
  return undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`cherry tools: "${key}" is required and must be a non-empty string`)
  }
  return value
}

/** One text block: the tool result the model reads. */
function textBlock(text: string): ToolContentBlock[] {
  return [{ type: 'text', text }]
}

/** The read tools' canonical output contract: whatever the tool declared. */
const FREE_OUTPUT_SCHEMA: Record<string, unknown> = { type: 'object', additionalProperties: true }

/** A generous, honest renderer: the model gets the whole aggregated value as JSON. */
function jsonRender(_args: unknown, value: unknown): ToolContentBlock[] {
  return textBlock(JSON.stringify(value, null, 2))
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Local policy knobs (never protocol values); all optional. */
export interface CherryToolEngineOptions {
  /**
   * Circuit-breaker for one message's part walk. Omitted uses
   * {@link DEFAULT_PARTS_SAFETY_BOUND}. Exists so a test can prove the bound
   * surfaces instead of truncating silently.
   */
  partsSafetyBound?: number
  /**
   * How long a waiter may sit between two judgement passes when the session
   * buffer has not moved. Omitted uses {@link DEFAULT_WAIT_POLL_MS}. Lowering
   * it makes a wait react sooner at the cost of more wakeups; raising it makes
   * a quiet peer's answer later.
   */
  waitPollMs?: number
}

/**
 * Registers the whole `cherry_*` family on `ctx.tools`.
 *
 * The registration framework is deliberately thin because Tasks 9/10 extend it:
 * {@link defineCherryTool} is the ONE place a tool declaration is assembled, so
 * those tasks add mutating tools without touching the host seam.
 */
export function registerCherryTools(
  ctx: CherryToolsContext,
  deps: CherryToolsDeps,
  options: CherryToolEngineOptions = {},
): () => void {
  const tools = ctx.tools
  if (tools === undefined) {
    // Headless deployments have no tool registry. Degrade to a warning rather
    // than throwing: the assembly's HTTP/UI half must still come up.
    console.warn('[cherry-remote] ctx.tools is unavailable; the cherry_* tools were not registered')
    return () => {}
  }

  const engine = new CherryToolEngine(deps, options)
  const disposers = engine.definitions().map((definition) => tools.register(definition))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** One tool declaration, in the exact shape the host registry consumes. */
function defineCherryTool(definition: {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<unknown>
}): CherryToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters as unknown as ToolParametersSchema,
    output: { schema: FREE_OUTPUT_SCHEMA, render: jsonRender },
    execute: definition.execute,
  }
}

/**
 * The six read tools. Kept as one class (rather than six closures) so the
 * per-session and per-device state Tasks 9/10 add has an obvious home.
 */
class CherryToolEngine {
  readonly #deps: CherryToolsDeps
  /**
   * Circuit-breaker for the parts walk. A LOCAL policy value, injectable so a
   * test can drive the bound low enough to prove that tripping it SURFACES
   * rather than silently truncating.
   */
  readonly #partsSafetyBound: number
  /** Poll cadence for the interactive waiters (see `DEFAULT_WAIT_POLL_MS`). */
  readonly #waitPollMs: number
  /**
   * The subscription cache's latest IDLE revision per session — the source of
   * `agent.messages.send`'s `expectedIdleRevision` (spec §4.2). A cold cache is
   * baselined from `agent.sessions.get`, so the value sent is always one the
   * peer itself reported.
   */
  readonly #revisionCache = new Map<string, string>()
  /**
   * The subscription cache's current ACTIVE execution per session — ONE source
   * shared by `cherry_cancel`'s `expectedExecutionId` and `cherry_respond`'s
   * staleness triple, so the two can never disagree about what is running.
   */
  readonly #executionCache = new Map<string, string>()
  /**
   * The subscription cache's interaction snapshots, keyed `<sessionId>
   * <interactionId>`: the `expectedRevision`/`expectedExecutionId`/
   * `inputDigest` triple `cherry_respond` sends. Fed by the real-time
   * `interaction.updated` stream, and — for a card the peer persisted only
   * after the turn ended — by an `agent.interactions.list` query.
   */
  readonly #interactionCache = new Map<
    string,
    { revision: string; executionId: string; inputDigest: string }
  >()

  constructor(deps: CherryToolsDeps, options: CherryToolEngineOptions = {}) {
    this.#deps = deps
    this.#partsSafetyBound = Math.max(
      1,
      Math.floor(options.partsSafetyBound ?? DEFAULT_PARTS_SAFETY_BOUND),
    )
    this.#waitPollMs = Math.max(1, Math.floor(options.waitPollMs ?? DEFAULT_WAIT_POLL_MS))
  }

  definitions(): CherryToolDefinition[] {
    return [
      this.#devicesTool(),
      this.#agentsTool(),
      this.#workspacesTool(),
      this.#sessionsTool(),
      this.#readTool(),
      this.#eventsTool(),
      // The interactive face (Task 9).
      this.#createTool(),
      this.#sendTool(),
      this.#waitTool(),
      this.#interactionsTool(),
      this.#respondTool(),
      this.#cancelTool(),
      // The management face (Task 10).
      this.#pairTool(),
      this.#unpairTool(),
    ]
  }

  // -------------------------------------------------------------------------
  // Device resolution
  // -------------------------------------------------------------------------

  /**
   * Resolves `device` to a live connection, or returns the structured verdict
   * the caller must report. Ambiguity is NOT an error throw (controller ruling
   * ⑤): the candidate list is the answer.
   */
  #resolve(device: string): ResolvedDevice | CherryAmbiguousDevice | CherryDeviceUnavailable {
    const resolution: DeviceResolution = this.#deps.store.resolve(device)
    if ('ambiguous' in resolution) {
      return { error: 'ambiguous-device', device, candidates: resolution.ambiguous }
    }

    const connection = this.#deps.connect(resolution.deviceId)
    if (connection.state !== 'connected') {
      // The established Task 5 shape: the tool never dials implicitly, and the
      // caller gets the same `{device, state}` verdict the RPC layer throws.
      return { error: 'device-unavailable', device: resolution.deviceId, state: connection.state }
    }
    return { record: resolution, connection }
  }

  /** True when `#resolve` answered with a structured verdict instead of a link. */
  #isVerdict(
    resolved: ResolvedDevice | CherryAmbiguousDevice | CherryDeviceUnavailable,
  ): resolved is CherryAmbiguousDevice | CherryDeviceUnavailable {
    return 'error' in resolved
  }

  /**
   * Resolve-or-verdict: every non-`cherry_devices` tool needs a live link.
   *
   * The two failure faces are deliberately DIFFERENT (controller ruling ⑤):
   * an ambiguous selector is an ANSWER — the structured candidate list is
   * returned in band, because the caller can act on it — while a non-connected
   * device is the §6 `DeviceUnavailableError` the established error face
   * already defines.
   */
  #requireConnection(device: string): ResolvedDevice | CherryAmbiguousDevice {
    const resolved = this.#resolve(device)
    if (!this.#isVerdict(resolved)) return resolved
    if (resolved.error === 'ambiguous-device') return resolved
    throw new DeviceUnavailableError(resolved.device, resolved.state)
  }

  /**
   * The connection-plus-record pair, or the ambiguous verdict to return
   * verbatim. Lets each tool's body read as `resolved.link ?? resolved.verdict`
   * without repeating the discriminant dance.
   */
  #linkOr(
    device: string,
  ): { link: ResolvedDevice; verdict?: undefined } | { link?: undefined; verdict: CherryAmbiguousDevice } {
    const resolved = this.#requireConnection(device)
    if ('error' in resolved) return { verdict: resolved }
    return { link: resolved }
  }

  // -------------------------------------------------------------------------
  // Pagination: the aggregate/clamp discipline (controller ruling ②)
  // -------------------------------------------------------------------------

  /**
   * Walks pages until `limit` items are collected or the peer runs out,
   * clamping EVERY page to the negotiated `pageItems`.
   *
   * The clamp is the whole point: `limit: 150` means "at most 150 items
   * total", never "ask the peer for 150 in one page" — the protocol's
   * single-page cap is a hard wire limit the plugin cannot override.
   *
   * `limit` is a CALLER contract, and reaching it is reported as
   * `truncationReason: 'limit'`. `safetyBound` is different in kind: it is an
   * internal circuit-breaker against a peer that never terminates, and tripping
   * it is ALWAYS surfaced (`truncationReason: 'safety-bound'` plus the resume
   * cursor) — a walk never stops early and reports success.
   *
   * A peer that answers empty pages with a non-null `nextCursor` is a FAULT,
   * not a slow walk: no item ceiling can ever be reached, so it is detected
   * directly and thrown (see {@link MAX_AGGREGATE_PAGES} for the backstop).
   */
  async #aggregate<T>(
    connection: DeviceConnection,
    method: string,
    params: Record<string, unknown>,
    extract: (page: Record<string, unknown>) => { items: T[]; nextCursor: unknown },
    limit: number,
    safetyBound: number = MAX_AGGREGATE_LIMIT,
  ): Promise<CherryPage<T>> {
    const pageItems = Math.max(1, Math.floor(connection.limits.pageItems || PAGE_ITEMS_FALLBACK))
    // `limit` may be Infinity (a walk with NO caller bound), so the two
    // ceilings are intersected rather than maxed: the effective stop is
    // whichever binds first, and Infinity simply never binds.
    const aggregate = Math.max(1, Math.floor(limit))
    const bound = Math.max(1, Math.floor(safetyBound))
    const ceiling = Math.min(aggregate, bound)
    const items: T[] = []
    let cursor: string | undefined

    for (let pages = 0; ; pages += 1) {
      if (items.length >= ceiling) {
        // Which ceiling stopped it decides how the caller reads the result:
        // the caller's own limit, or the internal circuit-breaker.
        return this.#truncated(items, aggregate <= bound ? 'limit' : 'safety-bound', cursor)
      }
      if (pages >= MAX_AGGREGATE_PAGES) {
        throw new Error(
          `${method} did not terminate within ${MAX_AGGREGATE_PAGES} page(s) for ${JSON.stringify(params)}`,
        )
      }
      const request: Record<string, unknown> = {
        ...params,
        // The per-page clamp: never more than one page's worth, whatever the
        // remaining aggregate says.
        limit: Math.min(ceiling - items.length, pageItems),
      }
      if (cursor !== undefined) request['cursor'] = cursor
      const result = (await connection.rpc.request(method, request)) as Record<string, unknown>
      const extracted = extract(result)
      for (const item of extracted.items) {
        if (items.length >= ceiling) break
        items.push(item)
      }
      const next = extracted.nextCursor
      if (next === null || next === undefined) return { items, truncated: false }
      const advanced = String(next)
      // An empty page that promises more is not progress: without this the walk
      // spins forever, because the item ceiling is never reached. Treating it as
      // a peer fault is the honest verdict — the alternative (returning the
      // partial items as if complete) would hide real content loss.
      if (extracted.items.length === 0) {
        throw new Error(
          `${method} answered an empty page with nextCursor ${advanced} for ${JSON.stringify(params)}; ` +
            'refusing to spin on a peer that makes no progress',
        )
      }
      if (advanced === cursor) {
        throw new Error(
          `${method} did not advance its cursor (stuck at ${advanced}) for ${JSON.stringify(params)}`,
        )
      }
      cursor = advanced
    }
  }

  /** A stopped aggregate, always carrying why it stopped and where to resume. */
  #truncated<T>(items: T[], reason: CherryTruncationReason, cursor: string | undefined): CherryPage<T> {
    return {
      items,
      truncated: true,
      truncationReason: reason,
      ...(cursor === undefined ? {} : { nextCursor: cursor }),
    }
  }

  // -------------------------------------------------------------------------
  // ① cherry_devices
  // -------------------------------------------------------------------------

  #devicesTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_devices',
      description:
        'List every paired Cherry Studio desktop with its connection state ' +
        '(connected/connecting/offline/disabled/identity-mismatch). An optional `device` ' +
        'narrows the list to one device (display name prefix or deviceId).',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Optional device selector: exact deviceId, or a unique display-name prefix.' },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const selector = optionalString(args['device'])
        if (selector === undefined) {
          return { devices: this.#deps.store.list().map((record) => this.#deviceView(record)) }
        }
        const selected = this.#selectRecords(selector)
        if (!Array.isArray(selected)) return selected
        return { devices: selected.map((record) => this.#deviceView(record)) }
      },
    })
  }

  /** The `cherry_devices` selector: candidates beat a throw (ruling ⑤). */
  #selectRecords(selector: string): DeviceRecord[] | CherryAmbiguousDevice {
    const resolution = this.#deps.store.resolve(selector)
    if ('ambiguous' in resolution) {
      return { error: 'ambiguous-device', device: selector, candidates: resolution.ambiguous }
    }
    return [resolution]
  }

  /**
   * One device's view WITHOUT dialing.
   *
   * A disabled record is authoritative: the pooled connection is constructed
   * with its own `record.enabled` snapshot and reports `disabled` only once
   * `connect()` has run, so reading the store flag first keeps the row truthful
   * for a device whose connection was never started. Everything else falls back
   * to the connection's own CLOSED state set.
   */
  #deviceView(record: DeviceRecord): CherryDeviceView {
    let state: DeviceState = record.enabled ? 'offline' : 'disabled'
    if (record.enabled) {
      try {
        state = this.#deps.connect(record.deviceId).state
      } catch (error) {
        // A device that cannot even be resolved to a connection still deserves a
        // truthful row; `offline` is the fallback verdict.
        console.warn(`[cherry-remote] cherry_devices could not read the connection for ${record.deviceId}`, error)
      }
    }
    return {
      deviceId: record.deviceId,
      displayName: record.displayName,
      state,
      enabled: record.enabled,
      hosts: record.hosts,
      port: record.port,
    }
  }

  // -------------------------------------------------------------------------
  // ② cherry_agents / cherry_sessions / ③ cherry_workspaces
  // -------------------------------------------------------------------------

  #agentsTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_agents',
      description:
        'List the Cherry Studio agents available on a device. Paginated: `limit` bounds ' +
        'the TOTAL across pages (default 100, max 1000) and is aggregated internally.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique display-name prefix.' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_AGGREGATE_LIMIT,
            description: 'Maximum number of agents to return in total across pages (default 100).',
          },
        },
        required: ['device'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const resolved = this.#linkOr(requiredString(args, 'device'))
        if (resolved.link === undefined) return resolved.verdict
        const { connection } = resolved.link
        return this.#aggregate(
          connection,
          'agent.agents.list',
          {},
          (page) => ({ items: arrayOf(page['items']), nextCursor: page['nextCursor'] }),
          aggregateLimit(args['limit']),
        )
      },
    })
  }

  #workspacesTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_workspaces',
      description:
        'List an agent\'s REGISTERED workspaces, plus whether a system workspace exists. ' +
        'The system workspace has no enumerable id: it is not in `items`, and its identity ' +
        'is only observable by creating a session in it and reading it back.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique display-name prefix.' },
          agentId: { type: 'string', description: 'The agent whose workspaces to list.' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_AGGREGATE_LIMIT,
            description: 'Maximum number of workspaces to return in total across pages (default 100).',
          },
        },
        required: ['device', 'agentId'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const resolved = this.#linkOr(requiredString(args, 'device'))
        if (resolved.link === undefined) return resolved.verdict
        const { connection } = resolved.link
        const agentId = requiredString(args, 'agentId')
        let systemWorkspace = false
        const page = await this.#aggregate(
          connection,
          'agent.workspaces.list',
          { agentId },
          (result) => {
            // The flag rides on every page; the last page read wins, and the
            // real peer always sends it.
            if (typeof result['systemWorkspace'] === 'boolean') systemWorkspace = result['systemWorkspace']
            return { items: arrayOf(result['items']), nextCursor: result['nextCursor'] }
          },
          aggregateLimit(args['limit']),
        )
        return {
          items: page.items,
          systemWorkspace,
          truncated: page.truncated,
          ...(page.truncationReason === undefined ? {} : { truncationReason: page.truncationReason }),
        }
      },
    })
  }

  #sessionsTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_sessions',
      description:
        'List an agent\'s sessions, optionally filtered by workspace. The `agentId` and ' +
        '`workspaceId` filters pass straight through to the peer. Paginated: `limit` bounds ' +
        'the TOTAL across pages (default 100, max 1000) and is aggregated internally.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique display-name prefix.' },
          agentId: { type: 'string', description: 'Only sessions of this agent.' },
          workspaceId: { type: 'string', description: 'Only sessions in this registered workspace.' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_AGGREGATE_LIMIT,
            description: 'Maximum number of sessions to return in total across pages (default 100).',
          },
        },
        required: ['device'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const resolved = this.#linkOr(requiredString(args, 'device'))
        if (resolved.link === undefined) return resolved.verdict
        const { connection } = resolved.link
        const agentId = optionalString(args['agentId'])
        const workspaceId = optionalString(args['workspaceId'])
        // Filter passthrough: the params carry the caller's filters verbatim,
        // and `#aggregate` adds only `limit`/`cursor`.
        return this.#aggregate(
          connection,
          'agent.sessions.list',
          {
            ...(agentId === undefined ? {} : { agentId }),
            ...(workspaceId === undefined ? {} : { workspaceId }),
          },
          (page) => ({ items: arrayOf(page['items']), nextCursor: page['nextCursor'] }),
          aggregateLimit(args['limit']),
        )
      },
    })
  }

  // -------------------------------------------------------------------------
  // ④ cherry_read — the two-level baseline with {ref} aggregation
  // -------------------------------------------------------------------------

  #readTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_read',
      description:
        'Read a session\'s message history snapshot. Two-level baseline: `agent.sessions.get` ' +
        'supplies the history revision, `agent.messages.list` the messages, and each message\'s ' +
        'own revision the parts. Large part text is externalized by the peer and fetched and ' +
        'sha256-verified through `agent.content.read`.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique display-name prefix.' },
          sessionId: { type: 'string', description: 'The session to read.' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_AGGREGATE_LIMIT,
            description: 'Maximum number of messages to return in total across pages (default 100).',
          },
        },
        required: ['device', 'sessionId'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const resolved = this.#linkOr(requiredString(args, 'device'))
        if (resolved.link === undefined) return resolved.verdict
        const { connection, record } = resolved.link
        const sessionId = requiredString(args, 'sessionId')
        const limit = aggregateLimit(args['limit'])

        // First-use ensure (spec §3.5): reading a session's history depends on
        // the subscription cache, so the session joins the same LRU pool the
        // send/wait tools use. A live subscription is left exactly as it is.
        await this.#ensureSubscription(record.deviceId, sessionId)

        return this.#readRound(connection, sessionId, limit, true)
      },
    })
  }

  /**
   * ONE read round: re-pull the baseline, then list and project everything.
   *
   * `retryOnExpiry` implements the §6 REVISION_EXPIRED rule — a stale revision
   * re-pulls the baseline (`sessions.get` → `messages.list`) and retries the
   * WHOLE round ONCE. A second expiry is surfaced unchanged, so a peer whose
   * revisions never settle cannot loop the caller.
   */
  async #readRound(
    connection: DeviceConnection,
    sessionId: string,
    limit: number,
    retryOnExpiry: boolean,
  ): Promise<CherryReadSnapshot> {
    try {
      return await this.#readOnce(connection, sessionId, limit)
    } catch (error) {
      if (retryOnExpiry && failureReason(error) === 'REVISION_EXPIRED') {
        console.warn(
          `[cherry-remote] session ${sessionId} history revision expired; re-pulling the baseline and retrying once`,
        )
        return this.#readRound(connection, sessionId, limit, false)
      }
      throw error
    }
  }

  async #readOnce(
    connection: DeviceConnection,
    sessionId: string,
    limit: number,
  ): Promise<CherryReadSnapshot> {
    const sessionResult = (await connection.rpc.request('agent.sessions.get', { sessionId })) as Record<
      string,
      unknown
    >
    const session = isRecord(sessionResult['session']) ? sessionResult['session'] : {}
    const historyRevision = session['historyRevision']
    if (typeof historyRevision !== 'string') {
      throw new Error(`agent.sessions.get returned no historyRevision for session ${sessionId}`)
    }

    const page = await this.#aggregate(
      connection,
      'agent.messages.list',
      { sessionId, historyRevision },
      (result) => ({ items: arrayOf(result['items']), nextCursor: result['nextCursor'] }),
      limit,
    )

    const messages: CherryReadMessage[] = []
    for (const raw of page.items) {
      messages.push(await this.#projectMessage(connection, sessionId, raw))
    }
    return {
      session,
      messages,
      truncated: page.truncated,
      ...(page.truncationReason === undefined ? {} : { truncationReason: page.truncationReason }),
    }
  }

  /** One message: list ALL its parts under the message's OWN revision, then aggregate. */
  async #projectMessage(
    connection: DeviceConnection,
    sessionId: string,
    raw: Record<string, unknown>,
  ): Promise<CherryReadMessage> {
    const messageId = String(raw['messageId'] ?? '')
    const revision = String(raw['revision'] ?? '')
    // A message's parts are read to COMPLETION: the caller's `limit` bounds
    // MESSAGES, so any part budget here would drop content from the snapshot.
    // The walk therefore runs until the peer reports `nextCursor: null`, with
    // `DEFAULT_PARTS_SAFETY_BOUND` as a pure circuit-breaker against a peer that
    // never terminates — and tripping it is reported, never silent.
    const page = await this.#aggregate(
      connection,
      'agent.parts.list',
      { sessionId, messageId, messageRevision: revision },
      (result) => ({ items: arrayOf(result['items']), nextCursor: result['nextCursor'] }),
      Number.POSITIVE_INFINITY,
      this.#partsSafetyBound,
    )

    const parts: CherryReadPart[] = []
    for (const part of page.items) {
      parts.push(await this.#projectPart(connection, sessionId, part))
    }
    return {
      messageId,
      revision,
      role: String(raw['role'] ?? ''),
      status: String(raw['status'] ?? ''),
      parts,
      // A circuit-broken part list advertises itself, with the cursor to resume
      // from: the caller can see that this message is incomplete and where to
      // continue, so content is never dropped silently.
      ...(page.truncated
        ? {
            partsTruncated: page.truncationReason ?? 'safety-bound',
            ...(page.nextCursor === undefined ? {} : { partsResumeCursor: page.nextCursor }),
          }
        : {}),
    }
  }

  /**
   * One part, with `{ref}` content resolved through `agent.content.read`.
   *
   * The slices are reassembled in ≤24 KiB steps and the WHOLE content's sha256
   * (what the ref advertises, and what the peer returns on every slice) is
   * verified against the reassembled bytes before any text is handed back.
   */
  async #projectPart(
    connection: DeviceConnection,
    sessionId: string,
    raw: Record<string, unknown>,
  ): Promise<CherryReadPart> {
    const partId = String(raw['partId'] ?? '')
    const revision = String(raw['revision'] ?? '')
    const kind = String(raw['kind'] ?? '')
    const content = isRecord(raw['content']) ? raw['content'] : {}

    let text: string
    if (typeof content['text'] === 'string') {
      text = content['text']
    } else if (isRecord(content['ref'])) {
      text = await this.#readExternalized(connection, sessionId, content['ref'])
    } else {
      text = ''
    }

    return {
      partId,
      kind,
      revision,
      content: text,
      ...(typeof raw['state'] === 'string' ? { state: raw['state'] } : {}),
      ...(typeof raw['toolName'] === 'string' ? { toolName: raw['toolName'] } : {}),
      ...(typeof raw['toolCallId'] === 'string' ? { toolCallId: raw['toolCallId'] } : {}),
    }
  }

  /** Paginate `agent.content.read` over one `{ref}` and verify its sha256. */
  async #readExternalized(
    connection: DeviceConnection,
    sessionId: string,
    ref: Record<string, unknown>,
  ): Promise<string> {
    const contentId = String(ref['contentId'] ?? '')
    const revision = String(ref['revision'] ?? '')
    const declaredSha = typeof ref['sha256'] === 'string' ? ref['sha256'] : undefined
    // The advertised byte length bounds the walk honestly: the peer declares it
    // on the ref, so a read that needs more slices than the content can hold is
    // a peer fault, not a reason to return a partial (and unverifiable) value.
    const declaredBytes = Number(ref['byteLength'])
    const maxSlices = Number.isSafeInteger(declaredBytes)
      ? Math.max(1, Math.ceil(declaredBytes / CONTENT_READ_MAX_BYTES))
      : DEFAULT_CONTENT_SLICE_BOUND

    const chunks: Uint8Array[] = []
    let offset = '0'
    let sha: string | undefined
    let complete = false
    for (let sliceIndex = 0; sliceIndex < maxSlices; sliceIndex += 1) {
      const slice = (await connection.rpc.request('agent.content.read', {
        sessionId,
        contentId,
        revision,
        offset,
        maxBytes: CONTENT_READ_MAX_BYTES,
      })) as Record<string, unknown>
      const data = typeof slice['dataBase64'] === 'string' ? slice['dataBase64'] : ''
      chunks.push(new Uint8Array(Buffer.from(data, 'base64')))
      if (typeof slice['sha256'] === 'string') sha = slice['sha256']
      if (slice['eof'] === true) {
        complete = true
        break
      }
      const next = slice['nextOffset']
      if (typeof next !== 'string' || next === offset) {
        throw new Error(`agent.content.read for ${contentId} did not advance (offset ${offset})`)
      }
      offset = next
    }
    // A partial content is never returned: the digest check below could not
    // certify it, so an incomplete walk is a hard failure rather than a
    // silently short read.
    if (!complete) {
      throw new Error(
        `agent.content.read for ${contentId} did not reach eof within ${maxSlices} slice(s); refusing to aggregate a partial content`,
      )
    }

    const bytes = Buffer.concat(chunks)
    const expected = sha ?? declaredSha
    if (expected === undefined) {
      throw new Error(`agent.content.read for ${contentId} returned no sha256 to verify`)
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) {
      throw new Error(
        `agent.content.read for ${contentId} failed its sha256 check (expected ${expected}, got ${actual})`,
      )
    }
    return bytes.toString('utf8')
  }

  // -------------------------------------------------------------------------
  // ⑤ cherry_events
  // -------------------------------------------------------------------------

  #eventsTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_events',
      description:
        'Read the session\'s buffered events newer than `cursor`, delivering them and then ' +
        'acknowledging the advanced cursor to the peer. A cursor at or before the cache ' +
        'window start answers a structured `cursor-out-of-window` verdict; rebuild the ' +
        'baseline with `cherry_read` instead.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique display-name prefix.' },
          sessionId: { type: 'string', description: 'The session whose events to read.' },
          cursor: {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              streamEpoch: { type: 'string' },
              seq: { type: 'string' },
            },
            required: ['sessionId', 'streamEpoch', 'seq'],
            additionalProperties: false,
            description: 'Resume point: the last cursor the caller consumed.',
          },
        },
        required: ['device', 'sessionId'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const resolved = this.#linkOr(requiredString(args, 'device'))
        if (resolved.link === undefined) return resolved.verdict
        const { record } = resolved.link
        const sessionId = requiredString(args, 'sessionId')
        const subscriptions = this.#deps.subs(record.deviceId)
        await this.#ensureSubscription(record.deviceId, sessionId)

        const cursor = readCursor(args['cursor'])
        const result: ReadResult = subscriptions.read(sessionId, cursor)
        if ('error' in result) {
          return {
            error: 'cursor-out-of-window',
            message:
              `the requested cursor is at or before the cache window start for session ${sessionId}; ` +
              'use cherry_read to rebuild the baseline',
            windowStart:
              cursor === undefined ? null : this.#windowStart(subscriptions, sessionId, cursor),
          } satisfies CherryCursorOutOfWindow
        }

        // ACK AFTER DELIVERY (controller ruling ④): the peer may only advance
        // its view once the caller actually holds these events. A failing ack
        // is logged, never allowed to swallow the delivered events.
        try {
          await subscriptions.ack(sessionId, result.nextCursor)
        } catch (error) {
          console.warn(`[cherry-remote] acknowledging session ${sessionId} at ${result.nextCursor.seq} failed`, error)
        }
        return { events: result.events, nextCursor: result.nextCursor }
      },
    })
  }

  // -------------------------------------------------------------------------
  // Interactive face (Task 9): create / send / wait / interactions / respond /
  // cancel.
  //
  // Two disciplines separate this face from the read one:
  //
  //  - **Two failure SURFACES, never conflated** (spec §6). A command's
  //    state-machine refusal is a RECEIPT (`status:'rejected'` + `error`) the
  //    call RESOLVES with; a subscription/transport refusal is an RPC ERROR the
  //    call REJECTS with. This file never converts one into the other.
  //  - **The staleness triple comes from the CACHE, not the caller.**
  //    `expectedRevision`/`expectedExecutionId`/`inputDigest` are read from the
  //    subscription's interaction snapshot (and `expectedIdleRevision` /
  //    the cancel target from its execution snapshot), so callers cannot
  //    mis-state what they have seen.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // ⑥ cherry_create
  // -------------------------------------------------------------------------

  #createTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_create',
      description:
        'Create a session in an agent workspace. The workspace selection is MANDATORY and ' +
        'explicit: pass `workspaceId` for a registered workspace, or `workspace: "system"` for ' +
        'the system workspace (which has no enumerable id). There is no implicit default. The ' +
        'receipt carries only the sessionId, so the workspace identity is read back through ' +
        'agent.sessions.get.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique display-name prefix.' },
          agentId: { type: 'string', description: 'The agent that owns the new session.' },
          workspaceId: {
            type: 'string',
            description:
              'The registered workspace to create the session in. Mutually exclusive with `workspace`.',
          },
          workspace: {
            type: 'string',
            enum: ['system'],
            description:
              'The literal "system" selects the system workspace. Mutually exclusive with `workspaceId`.',
          },
          title: { type: 'string', description: 'Optional session title.' },
          commandId: {
            type: 'string',
            description:
              'Optional idempotency id. Omit to have one generated; REUSE the same id to retry safely.',
          },
        },
        required: ['device', 'agentId'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const resolved = this.#linkOr(requiredString(args, 'device'))
        if (resolved.link === undefined) return resolved.verdict
        const { connection, record } = resolved.link

        const agentId = requiredString(args, 'agentId')
        const workspaceId = optionalString(args['workspaceId'])
        const system = args['workspace'] === 'system'
        const title = optionalString(args['title'])

        // The protocol declares TWO union branches, both requiring a workspace
        // selection, and no "unspecified" form. Choosing one implicitly would
        // silently write into a workspace the caller never named, so the tool
        // refuses in band BEFORE reaching the wire.
        if (workspaceId !== undefined && system) {
          return {
            error: 'invalid-workspace-selection',
            message: 'specify either `workspaceId` or `workspace: "system"`, not both',
          } satisfies Record<string, unknown>
        }
        if (workspaceId === undefined && !system) {
          return {
            error: 'workspace-required',
            message:
              'a workspace selection is required: pass `workspaceId` for a registered workspace, ' +
              'or `workspace: "system"` for the system workspace',
          } satisfies Record<string, unknown>
        }
        if (args['workspace'] !== undefined && !system) {
          return {
            error: 'invalid-workspace-selection',
            message: '`workspace` accepts exactly the literal "system"',
          } satisfies Record<string, unknown>
        }

        const receipt = await this.#command(connection, 'agent.sessions.create', {
          commandId: this.#commandId(args),
          agentId,
          // The two protocol branches are mutually exclusive by construction.
          ...(system ? { workspace: { kind: 'system' } } : { workspaceId }),
          ...(title === undefined ? {} : { title }),
        })

        const sessionId = typeof receipt['sessionId'] === 'string' ? receipt['sessionId'] : undefined
        if (sessionId === undefined) {
          // A rejected/odd receipt is surfaced as-is; there is nothing to read
          // back without an id.
          return receipt
        }

        // TWO-STEP READ-BACK: the receipt's `result` carries only the id, so the
        // workspace identity comes from a fresh `agent.sessions.get`.
        const sessionResult = (await connection.rpc.request('agent.sessions.get', { sessionId })) as Record<
          string,
          unknown
        >
        const session = isRecord(sessionResult['session']) ? sessionResult['session'] : {}
        const created: CherryCreateResult = {
          sessionId,
          device: record.deviceId,
          ...(typeof session['workspaceId'] === 'string' ? { workspaceId: session['workspaceId'] } : {}),
          ...(typeof session['workspaceKind'] === 'string' ? { workspaceKind: session['workspaceKind'] } : {}),
          session,
        }
        return { ...receipt, ...created }
      },
    })
  }

  // -------------------------------------------------------------------------
  // ⑦ cherry_send
  // -------------------------------------------------------------------------

  #sendTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_send',
      description:
        'Send a message to a session and, by default, wait for the run to reach a terminal state ' +
        '(completed/failed/cancelled/interrupted), then aggregate the assistant text. A pending ' +
        'interaction ends the wait EARLY as a soft terminal (`awaiting-interaction`): answer it with ' +
        'cherry_interactions + cherry_respond, then resume with cherry_wait. `wait: false` returns ' +
        'the command receipt immediately. A timeout is NOT a failure — it returns the partial content ' +
        'and the cursor to resume from.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique display-name prefix.' },
          sessionId: { type: 'string', description: 'The session to send into.' },
          text: {
            type: 'string',
            maxLength: TEXT_MAX_LENGTH,
            description: `The message text. At most ${TEXT_MAX_LENGTH} characters (the protocol ceiling).`,
          },
          wait: {
            type: 'boolean',
            description: 'Wait for a terminal state (default true). False returns the command receipt at once.',
          },
          timeoutMs: {
            type: 'integer',
            minimum: MIN_WAIT_TIMEOUT_MS,
            description: `How long to wait, in ms (default ${DEFAULT_WAIT_TIMEOUT_MS}). A default, not a cap.`,
          },
          commandId: {
            type: 'string',
            description:
              'Optional idempotency id. Omit to have one generated; REUSE the same id to retry a command ' +
              'whose outcome is unknown.',
          },
        },
        required: ['device', 'sessionId', 'text'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const resolved = this.#linkOr(requiredString(args, 'device'))
        if (resolved.link === undefined) return resolved.verdict
        const { connection, record } = resolved.link
        const sessionId = requiredString(args, 'sessionId')
        const text = requiredString(args, 'text')

        // PRE-VALIDATION, before any wire call: the protocol caps `text` at
        // 32768 characters, so an over-long body is refused here with a hint to
        // split it rather than round-tripped into a peer error.
        if (text.length > TEXT_MAX_LENGTH) {
          return {
            error: 'text-too-long',
            limit: TEXT_MAX_LENGTH,
            length: text.length,
            message:
              `the message is ${text.length} characters; the protocol caps a single send at ` +
              `${TEXT_MAX_LENGTH}. Split it into several cherry_send calls.`,
          } satisfies Record<string, unknown>
        }

        await this.#ensureSubscription(record.deviceId, sessionId)
        const subscriptions = this.#deps.subs(record.deviceId)

        // `expectedIdleRevision` comes from the CACHE's session snapshot. A cold
        // cache is baselined first (`sessions.get`), so the value is always the
        // peer's own current revision rather than a caller-supplied guess.
        const expectedIdleRevision = await this.#idleRevision(connection, subscriptions, sessionId)

        const receipt = await this.#command(connection, 'agent.messages.send', {
          commandId: this.#commandId(args),
          sessionId,
          text,
          expectedIdleRevision,
        })

        if (args['wait'] === false) {
          // The caller asked for the receipt only: hand it back untouched.
          return receipt
        }
        if (receipt['status'] !== 'applied') {
          // A rejected receipt is the peer's final word on this command; there
          // is no run to wait for.
          return receipt
        }

        const timeoutMs = waitTimeout(args['timeoutMs'])
        return this.#awaitRun(connection, subscriptions, sessionId, {
          timeoutMs,
          startedAt: Date.now(),
          executionId: typeof receipt['executionId'] === 'string' ? receipt['executionId'] : undefined,
          commandId: typeof receipt['commandId'] === 'string' ? receipt['commandId'] : undefined,
        })
      },
    })
  }

  // -------------------------------------------------------------------------
  // ⑧ cherry_wait
  // -------------------------------------------------------------------------

  #waitTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_wait',
      description:
        'Wait for a session\'s in-flight execution to reach a terminal state, without sending ' +
        'anything. Returns the same shape as `cherry_send(wait: true)`. A session with no in-flight ' +
        'execution answers IMMEDIATELY with its current snapshot (status `idle`) — never an error, ' +
        'never a park. Use it to resume after answering an interaction.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique display-name prefix.' },
          sessionId: { type: 'string', description: 'The session to wait on.' },
          timeoutMs: {
            type: 'integer',
            minimum: MIN_WAIT_TIMEOUT_MS,
            description: `How long to wait, in ms (default ${DEFAULT_WAIT_TIMEOUT_MS}). A default, not a cap.`,
          },
        },
        required: ['device', 'sessionId'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const resolved = this.#linkOr(requiredString(args, 'device'))
        if (resolved.link === undefined) return resolved.verdict
        const { connection, record } = resolved.link
        const sessionId = requiredString(args, 'sessionId')

        await this.#ensureSubscription(record.deviceId, sessionId)
        const subscriptions = this.#deps.subs(record.deviceId)

        // The session snapshot is the authority on whether anything is running.
        const sessionResult = (await connection.rpc.request('agent.sessions.get', { sessionId })) as Record<
          string,
          unknown
        >
        const session = isRecord(sessionResult['session']) ? sessionResult['session'] : {}
        const activeExecutionId = optionalString(session['activeExecutionId'])

        if (activeExecutionId === undefined) {
          // The IDLE answer, not a failure and not a wait: nothing is in flight,
          // so the current snapshot IS the result.
          return {
            status: 'idle' satisfies CherryRunStatus,
            sessionId,
            session,
            executionId: null,
            messages: await this.#readTerminalMessages(connection, sessionId, session),
            cursor: this.#cursorOf(subscriptions, sessionId),
          }
        }

        return this.#awaitRun(connection, subscriptions, sessionId, {
          timeoutMs: waitTimeout(args['timeoutMs']),
          startedAt: Date.now(),
          executionId: activeExecutionId,
        })
      },
    })
  }

  // -------------------------------------------------------------------------
  // ⑨ cherry_interactions
  // -------------------------------------------------------------------------

  #interactionsTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_interactions',
      description:
        'List the session\'s PENDING interactions (questions and approval decisions) that need an ' +
        'answer. The peer serves the full four-state set (pending/approved/denied/expired) — the ' +
        'pending filter is applied here. Each entry carries its `kind` (question|decision) and a ' +
        'summary; answer questions with cherry_respond\'s `response` form and decisions with ' +
        '`decision`.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique display-name prefix.' },
          sessionId: { type: 'string', description: 'The session whose interactions to list.' },
          includeAnswered: {
            type: 'boolean',
            description:
              'Include already-answered interactions too (default false). The peer always returns them; ' +
              'this only controls the local filter.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_AGGREGATE_LIMIT,
            description: 'Maximum number of interactions to return in total across pages (default 100).',
          },
        },
        required: ['device', 'sessionId'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const resolved = this.#linkOr(requiredString(args, 'device'))
        if (resolved.link === undefined) return resolved.verdict
        const { connection, record } = resolved.link
        const sessionId = requiredString(args, 'sessionId')

        await this.#ensureSubscription(record.deviceId, sessionId)

        // The peer's `interactionsOf` MERGES live journal items with persisted
        // rows and never filters by status, so the whole four-state set arrives
        // here; crossing `pending` is this tool's own behaviour.
        const page = await this.#aggregate(
          connection,
          'agent.interactions.list',
          { sessionId },
          (result) => ({ items: arrayOf(result['items']), nextCursor: result['nextCursor'] }),
          aggregateLimit(args['limit']),
        )

        const includeAnswered = args['includeAnswered'] === true
        const items = page.items
          .filter((item) => includeAnswered || item['status'] === 'pending')
          .map((item) => this.#interactionView(item))

        // The REAL-TIME soft-terminal predicate reads this same view, so caching
        // it keeps a later `cherry_respond` from having to re-ask the peer.
        const cache = this.#deps.subs(record.deviceId)
        for (const item of page.items) this.#rememberInteraction(cache, sessionId, item)

        return {
          items,
          truncated: page.truncated,
          ...(page.truncationReason === undefined ? {} : { truncationReason: page.truncationReason }),
        }
      },
    })
  }

  /** The tool-facing projection of one interaction. */
  #interactionView(raw: Record<string, unknown>): Record<string, unknown> {
    const kind = typeof raw['kind'] === 'string' ? raw['kind'] : 'decision'
    return {
      interactionId: String(raw['interactionId'] ?? ''),
      revision: String(raw['revision'] ?? ''),
      executionId: String(raw['executionId'] ?? ''),
      toolCallId: String(raw['toolCallId'] ?? ''),
      status: String(raw['status'] ?? ''),
      kind,
      summary: String(raw['summary'] ?? ''),
      ...(typeof raw['inputDigest'] === 'string' ? { inputDigest: raw['inputDigest'] } : {}),
      // The `question` kind carries the question TEXTS a caller must key its
      // answers by; a call never has to parse the raw input itself.
      ...(kind === 'question' ? { questions: questionKeysOf(raw['input']) } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // ⑩ cherry_respond
  // -------------------------------------------------------------------------

  #respondTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_respond',
      description:
        'Answer a pending interaction. A `question` MUST be answered with ' +
        '`response: {kind: "answer", answers: {...}}`, keyed by the FULL question text and covering ' +
        'EVERY question (the peer refuses a partial set with CONFLICT). Approving a question is ' +
        'refused; use `decision: "deny"` to abandon one. A `decision` card takes ' +
        '`decision: "approve" | "deny"`. The staleness triple (expectedRevision / ' +
        'expectedExecutionId / inputDigest) is taken from the subscription cache, not from the caller.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique display-name prefix.' },
          sessionId: { type: 'string', description: 'The session holding the interaction.' },
          interactionId: { type: 'string', description: 'The interaction to answer.' },
          decision: {
            type: 'string',
            enum: ['approve', 'deny'],
            description: 'For a `decision` card. `deny` is also the sanctioned way to abandon a question.',
          },
          response: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['answer'] },
              answers: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Every question text mapped to its answer. Blank answers are refused.',
              },
            },
            required: ['kind', 'answers'],
            additionalProperties: false,
            description: 'The structured answer form, required for a `question` card.',
          },
          commandId: {
            type: 'string',
            description: 'Optional idempotency id. Omit to have one generated; REUSE the same id to retry safely.',
          },
        },
        required: ['device', 'sessionId', 'interactionId'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const resolved = this.#linkOr(requiredString(args, 'device'))
        if (resolved.link === undefined) return resolved.verdict
        const { connection, record } = resolved.link
        const sessionId = requiredString(args, 'sessionId')
        const interactionId = requiredString(args, 'interactionId')

        const decision = optionalString(args['decision'])
        const response = isRecord(args['response']) ? args['response'] : undefined
        // TRIPLE parameter validation: exactly one answer form must be given,
        // and it must be well-formed. Anything else is refused before the wire.
        if (decision === undefined && response === undefined) {
          return {
            error: 'response-required',
            message: 'provide either `decision` (approve|deny) or `response` ({kind:"answer", answers})',
          } satisfies Record<string, unknown>
        }
        if (decision !== undefined && response !== undefined) {
          return {
            error: 'ambiguous-response',
            message: 'provide either `decision` or `response`, not both',
          } satisfies Record<string, unknown>
        }
        if (decision !== undefined && decision !== 'approve' && decision !== 'deny') {
          return {
            error: 'invalid-decision',
            message: '`decision` accepts exactly "approve" or "deny"',
          } satisfies Record<string, unknown>
        }
        if (response !== undefined) {
          const answers = response['answers']
          if (response['kind'] !== 'answer' || !isRecord(answers)) {
            return {
              error: 'invalid-response',
              message: '`response` must be {kind:"answer", answers:{<question text>: <answer>}}',
            } satisfies Record<string, unknown>
          }
        }

        await this.#ensureSubscription(record.deviceId, sessionId)
        const subscriptions = this.#deps.subs(record.deviceId)

        // THE STALENESS TRIPLE COMES FROM THE CACHE. The interaction snapshot is
        // primed from the real-time `interaction.updated` events, and — when the
        // cache has never seen this interaction — from a single
        // `agent.interactions.list` query. The CALLER never supplies these: it
        // cannot know what the plugin has actually observed.
        const snapshot = await this.#interactionSnapshot(connection, subscriptions, sessionId, interactionId)
        if (snapshot === undefined) {
          return {
            error: 'unknown-interaction',
            message: `no interaction ${interactionId} is known for session ${sessionId}`,
          } satisfies Record<string, unknown>
        }

        return this.#command(connection, 'agent.interactions.respond', {
          commandId: this.#commandId(args),
          sessionId,
          interactionId,
          expectedRevision: snapshot.revision,
          expectedExecutionId: snapshot.executionId,
          inputDigest: snapshot.inputDigest,
          ...(response === undefined ? { decision } : { response }),
        })
      },
    })
  }

  // -------------------------------------------------------------------------
  // ⑪ cherry_cancel
  // -------------------------------------------------------------------------

  #cancelTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_cancel',
      description:
        'Cancel a session\'s in-flight execution. `expectedExecutionId` is REQUIRED by the protocol ' +
        'and is checked against the subscription cache\'s current active execution: pass the id a ' +
        'previous result reported, and the call succeeds only while it is still the active run. A ' +
        'divergence is refused in band with the id the cache actually holds, so a stale caller is ' +
        'told what to re-read rather than cancelling the wrong execution.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique display-name prefix.' },
          sessionId: { type: 'string', description: 'The session whose execution to cancel.' },
          expectedExecutionId: {
            type: 'string',
            description:
              'The execution to cancel. Required by the protocol; must match the cached active execution, ' +
              'so the caller can only cancel a run it has actually observed.',
          },
          commandId: {
            type: 'string',
            description: 'Optional idempotency id. Omit to have one generated; REUSE the same id to retry safely.',
          },
        },
        required: ['device', 'sessionId', 'expectedExecutionId'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const resolved = this.#linkOr(requiredString(args, 'device'))
        if (resolved.link === undefined) return resolved.verdict
        const { connection, record } = resolved.link
        const sessionId = requiredString(args, 'sessionId')

        await this.#ensureSubscription(record.deviceId, sessionId)
        const subscriptions = this.#deps.subs(record.deviceId)

        // Same SOURCE as respond's triple: the cached execution snapshot. The
        // caller's own value is honoured only when it matches what the cache
        // holds, because a divergence means one of the two has gone stale.
        const cached = await this.#activeExecutionId(connection, subscriptions, sessionId)
        const expectedExecutionId = cached
        if (expectedExecutionId === undefined) {
          return {
            error: 'no-active-execution',
            message: `session ${sessionId} has no in-flight execution to cancel`,
          } satisfies Record<string, unknown>
        }
        const supplied = optionalString(args['expectedExecutionId'])
        if (supplied !== undefined && supplied !== expectedExecutionId) {
          return {
            error: 'execution-mismatch',
            expectedExecutionId,
            supplied,
            message:
              `the cached active execution is ${expectedExecutionId}, not ${supplied}; re-read the ` +
              'session before cancelling',
          } satisfies Record<string, unknown>
        }

        return this.#command(connection, 'agent.executions.cancel', {
          commandId: this.#commandId(args),
          sessionId,
          expectedExecutionId,
        })
      },
    })
  }

  // -------------------------------------------------------------------------
  // Management face (Task 10): pair / unpair
  //
  // Pairing is the one tool that talks to a desktop the plugin has NOT paired
  // with yet, and the one whose terminal states are a HUMAN's decision. So it
  // breaks the read face's two habits for a reason:
  //
  //  - **It never resolves a device.** The device does not exist until the
  //    desktop approves; the payload is the address, and the tool's job is to
  //    hand it to the pairing face.
  //  - **Every pairing outcome is a RESULT, not a throw.** `rejected` and
  //    `expired` are answers the caller acts on (retry, ask for a new QR code),
  //    and the verification code has to survive them: it is what the user was
  //    comparing when they decided.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // ⑫ cherry_pair
  // -------------------------------------------------------------------------

  #pairTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_pair',
      description:
        'Pair this harness with a Cherry Studio desktop from its pairing payload (the QR ' +
        'content it shows). The 6-digit `verificationCode` the desktop displays is returned so ' +
        'the user can confirm it matches. Every outcome is a RESULT, never an error: `status` is ' +
        '"approved" (with the new device id), or the terminal "rejected"/"expired" verdict, or ' +
        'this plugin\'s own "invalid-payload"/"unreachable". Pairing can take up to a minute — it ' +
        'waits for the user to approve on the desktop.',
      parameters: {
        type: 'object',
        properties: {
          payload: {
            type: 'string',
            description: 'The pairing payload the desktop rendered into its QR code (a JSON string).',
          },
          name: {
            type: 'string',
            description:
              'Optional display name for this device as the desktop will show it (default: this host\'s name).',
          },
        },
        required: ['payload'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const payload = requiredString(args, 'payload')
        const name = optionalString(args['name'])

        // The code arrives mid-run (at `claim`), so it is captured here and
        // folded into EVERY terminal answer below.
        let verificationCode: string | undefined
        const outcome: CherryPairResult = await this.#runPair({
          payload,
          ...(name === undefined ? {} : { name }),
          onVerificationCode: (code) => {
            verificationCode = code
          },
        })

        return {
          ...outcome,
          ...(verificationCode === undefined ? {} : { verificationCode }),
        }
      },
    })
  }

  /**
   * Runs one pairing and maps its outcome onto {@link CherryPairResult}.
   *
   * The mapping is TOTAL over the pairing error currency: `PairingError.kind`
   * IS the result's `status`, so no terminal state can be silently reclassified
   * as success or swallowed. Anything that is NOT a `PairingError` is a real
   * fault (a bug, or the identity not being loaded yet) and is rethrown — the
   * tool has no honest in-band shape for "this should not have happened".
   */
  async #runPair(request: CherryPairRequest): Promise<CherryPairResult> {
    try {
      const record = await this.#deps.pair(request)
      return {
        status: 'approved',
        device: record.deviceId,
        displayName: record.displayName,
      }
    } catch (error) {
      if (!(error instanceof PairingError)) throw error
      return { status: error.kind, message: error.message }
    }
  }

  // -------------------------------------------------------------------------
  // ⑬ cherry_unpair
  // -------------------------------------------------------------------------

  #unpairTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_unpair',
      description:
        'Forget a paired desktop: tear its connection down and delete it from the device ' +
        'archive, so this harness no longer holds its access token. The `device` selector is ' +
        'REQUIRED (an exact deviceId, or a unique display-name prefix); unpairing is permanent ' +
        'and the device must be paired again from a fresh QR code.',
      parameters: {
        type: 'object',
        properties: {
          device: {
            type: 'string',
            description: 'Device selector: exact deviceId, or a unique display-name prefix.',
          },
        },
        required: ['device'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const selector = requiredString(args, 'device')
        // The same selector discipline as every other tool (ruling ⑤): an
        // ambiguous name is the structured candidate list, NOT a throw, and it
        // must not tear anything down — the caller has not said which device.
        const selected = this.#selectRecords(selector)
        if (!Array.isArray(selected)) return selected
        const record = selected[0]!

        // ORDER MATTERS: evict (drop + close) BEFORE removing the archive entry.
        // The other order leaves a window where the record is gone but its live
        // socket — still authenticated with a token that is about to be
        // discarded — is not. Eviction resolves an EXISTING pooled connection
        // only, so an unpaired-but-never-dialed device is simply removed.
        await this.#deps.evict(record.deviceId)
        this.#deps.store.remove(record.deviceId)

        return {
          device: record.deviceId,
          displayName: record.displayName,
          removed: true,
        } satisfies CherryUnpairResult
      },
    })
  }

  // -------------------------------------------------------------------------
  // Interactive-face plumbing
  // -------------------------------------------------------------------------

  /**
   * Issues one command and returns its RECEIPT verbatim.
   *
   * A receipt (`accepted`/`applied`/`rejected`/`interrupted`) is the peer's
   * own record of a command and is handed back UNCHANGED — including its
   * `error`, which is a receipt field, not a thrown RPC error. Transport and
   * subscription failures still reject this call: the two surfaces stay
   * distinct all the way to the caller (spec §6).
   */
  async #command(
    connection: DeviceConnection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return (await connection.rpc.request(method, params)) as Record<string, unknown>
  }

  /**
   * The commandId for this call. A caller-supplied id is honoured verbatim —
   * that is what makes a RETRY reuse the same id (and what makes a differing
   * body under the same id surface as the peer's IDEMPOTENCY_CONFLICT rather
   * than being silently re-run). Otherwise a fresh uuid is generated.
   */
  #commandId(args: Record<string, unknown>): string {
    return optionalString(args['commandId']) ?? randomUUID()
  }

  /** The subscription cache key for one session's revision/execution snapshot. */
  #cacheKey(sessionId: string): string {
    return sessionId
  }

  /** The subscription cache key for one interaction's staleness snapshot. */
  #interactionKey(sessionId: string, interactionId: string): string {
    return `${sessionId}\u0000${interactionId}`
  }

  /**
   * The session's current idle revision, from the SUBSCRIPTION CACHE.
   *
   * Two sources, in this order:
   *  1. the REAL-TIME event stream — a `session.updated` carries the peer's own
   *     `idleRevision`, which is the freshest value the plugin can hold;
   *  2. a baseline `agent.sessions.get`, used when the cache has nothing.
   *
   * The sent `expectedIdleRevision` must be a revision the peer recognises as
   * current, so the baseline is mandatory rather than optional: guessing would
   * earn a CONFLICT from a session that had merely moved on.
   */
  async #idleRevision(
    connection: DeviceConnection,
    subscriptions: SessionSubscriptions,
    sessionId: string,
  ): Promise<string> {
    const streamed = this.#streamedIdleRevision(subscriptions, sessionId)
    if (streamed !== undefined) {
      this.#revisionCache.set(this.#cacheKey(sessionId), streamed)
      return streamed
    }
    const cached = this.#revisionCache.get(this.#cacheKey(sessionId))
    if (cached !== undefined) return cached

    const sessionResult = (await connection.rpc.request('agent.sessions.get', { sessionId })) as Record<
      string,
      unknown
    >
    const session = isRecord(sessionResult['session']) ? sessionResult['session'] : {}
    const idle = optionalString(session['idleRevision']) ?? optionalString(session['historyRevision'])
    if (idle === undefined) {
      throw new Error(`agent.sessions.get returned no idle revision for session ${sessionId}`)
    }
    this.#revisionCache.set(this.#cacheKey(sessionId), idle)
    return idle
  }

  /** The newest idle/history revision the session's live events have carried. */
  #streamedIdleRevision(subscriptions: SessionSubscriptions, sessionId: string): string | undefined {
    let revision: string | undefined
    for (const entry of this.#eventsOf(subscriptions, sessionId)) {
      if (String(entry['kind'] ?? '') !== 'session.updated') continue
      const payload = isRecord(entry['payload']) ? entry['payload'] : {}
      revision =
        optionalString(payload['idleRevision']) ??
        optionalString(payload['historyRevision']) ??
        revision
    }
    return revision
  }

  /**
   * The session's ACTIVE execution id, from the most authoritative source
   * available — in this order:
   *
   *  1. the live `execution.updated` stream (a non-terminal status means the run
   *     is still in flight; a terminal one means nothing is);
   *  2. the PEER's current `agent.sessions.get` snapshot, which is the ground
   *     truth about what is running right now;
   *  3. the local cache, and only as a value the peer CONFIRMS — a cached id the
   *     peer no longer reports is dropped rather than returned.
   *
   * The cache deliberately does NOT outrank the peer (I2): a stale entry would
   * otherwise become the `execution-mismatch` authority, refusing a caller that
   * holds the CORRECT live id and telling it the wrong one.
   *
   * Shared by `cherry_cancel` and the responder's `expectedExecutionId` — ONE
   * source, so the two can never disagree about what is running.
   */
  async #activeExecutionId(
    connection: DeviceConnection,
    subscriptions: SessionSubscriptions,
    sessionId: string,
  ): Promise<string | undefined> {
    const streamed = this.#streamedActiveExecution(subscriptions, sessionId)
    if (streamed !== undefined) {
      this.#executionCache.set(this.#cacheKey(sessionId), streamed)
      return streamed
    }

    const sessionResult = (await connection.rpc.request('agent.sessions.get', { sessionId })) as Record<
      string,
      unknown
    >
    const session = isRecord(sessionResult['session']) ? sessionResult['session'] : {}
    const active = optionalString(session['activeExecutionId'])
    if (active !== undefined) {
      this.#executionCache.set(this.#cacheKey(sessionId), active)
      return active
    }
    // The peer says the session is idle: any cached id is stale by definition.
    this.#executionCache.delete(this.#cacheKey(sessionId))
    return undefined
  }

  /**
   * The live stream's verdict on the session's active execution: the newest
   * `execution.updated`'s executionId while it is non-terminal, or undefined
   * once it has settled (the run is over, so nothing is active).
   */
  #streamedActiveExecution(subscriptions: SessionSubscriptions, sessionId: string): string | undefined {
    let active: string | undefined
    for (const entry of this.#eventsOf(subscriptions, sessionId)) {
      if (String(entry['kind'] ?? '') !== 'execution.updated') continue
      const payload = isRecord(entry['payload']) ? entry['payload'] : {}
      const executionId = optionalString(payload['executionId'])
      const status = optionalString(payload['status'])
      if (executionId === undefined || status === undefined) continue
      active = (TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(status) ? undefined : executionId
    }
    return active
  }

  /**
   * The cached interaction snapshot — the SOURCE of respond's staleness triple.
   *
   * Two sources, in this order:
   *  1. the REAL-TIME `interaction.updated` stream, folded into the cache before
   *     every lookup (spec §3.6: the soft terminal rides exactly these events);
   *  2. ONE `agent.interactions.list` query, when the stream has never carried
   *     this interaction. That path is not optional: an approval card the peer
   *     persisted only after the turn ended never streams live, so the query is
   *     the only way to discover it.
   *
   * The caller supplies NONE of these values — it cannot know what the plugin
   * has actually observed.
   */
  async #interactionSnapshot(
    connection: DeviceConnection,
    subscriptions: SessionSubscriptions,
    sessionId: string,
    interactionId: string,
  ): Promise<{ revision: string; executionId: string; inputDigest: string } | undefined> {
    // (1) Fold the live stream in first, so a freshly pushed interaction is
    // answerable without a round trip.
    for (const entry of this.#eventsOf(subscriptions, sessionId)) {
      if (String(entry['kind'] ?? '') !== 'interaction.updated') continue
      const payload = isRecord(entry['payload']) ? entry['payload'] : {}
      if (optionalString(payload['interactionId']) !== interactionId) continue
      this.#rememberInteraction(subscriptions, sessionId, payload)
    }
    const streamed = this.#interactionCache.get(this.#interactionKey(sessionId, interactionId))
    if (streamed !== undefined) return streamed

    // (2) The query fallback for a card that never streamed.
    const page = await this.#aggregate(
      connection,
      'agent.interactions.list',
      { sessionId },
      (result) => ({ items: arrayOf(result['items']), nextCursor: result['nextCursor'] }),
      MAX_AGGREGATE_LIMIT,
    )
    for (const item of page.items) this.#rememberInteraction(subscriptions, sessionId, item)

    return this.#interactionCache.get(this.#interactionKey(sessionId, interactionId))
  }

  /**
   * Records one interaction's staleness snapshot from a wire view.
   *
   * A PENDING interaction also refreshes the session's active-execution cache,
   * because the run it blocks is by definition still in flight. A SETTLED
   * (approved/denied/expired) one deliberately does NOT: its execution may have
   * finished long ago, and recording it would make `cherry_cancel` name a dead
   * run and turn an idle session into a peer-side CONFLICT instead of the
   * in-band `no-active-execution`.
   */
  #rememberInteraction(
    _subscriptions: SessionSubscriptions,
    sessionId: string,
    raw: Record<string, unknown>,
  ): void {
    const interactionId = optionalString(raw['interactionId'])
    const revision = optionalString(raw['revision'])
    const executionId = optionalString(raw['executionId'])
    const inputDigest = optionalString(raw['inputDigest'])
    // A snapshot missing any of the three is not answerable: recording it would
    // let `cherry_respond` send a half-complete staleness triple.
    if (interactionId === undefined || revision === undefined || executionId === undefined) return
    if (inputDigest === undefined) return
    this.#interactionCache.set(this.#interactionKey(sessionId, interactionId), {
      revision,
      executionId,
      inputDigest,
    })
    if (raw['status'] === 'pending') this.#executionCache.set(this.#cacheKey(sessionId), executionId)
  }

  /**
   * The session's current cursor, for a result that has to say where to resume.
   * Read from the subscription cache without advancing the ACK cursor —
   * waiters CONSUME, they do not acknowledge (controller ruling: ack stays the
   * `cherry_events` delivery call site).
   */
  #cursorOf(subscriptions: SessionSubscriptions, sessionId: string): AgentCursor | undefined {
    const result = subscriptions.read(sessionId)
    return 'events' in result ? result.nextCursor : undefined
  }

  /**
   * The waiter: parks until the session's EXECUTION reaches one of the four
   * terminal states, an unanswered interaction makes the run a SOFT terminal,
   * or the window elapses.
   *
   * The predicate covers the execution dimension ONLY. A command receipt's
   * `interrupted` — where the command's outcome is undecided — is a different
   * dimension and deliberately does NOT settle a wait (Task 13 asserts the two
   * layers separately).
   *
   * Waiters never ack: they consume the projection and leave the peer's view
   * untouched.
   *
   * A wait can also end because the LINK went away — the plugin was torn down,
   * the device was unpaired, or the connection closed. That is not a timeout and
   * not a terminal state: the run's outcome is simply unknowable, so the wait
   * FAILS FAST with the established {@link DeviceUnavailableError} rather than
   * parking out its whole window. Without this check a torn-down pool's parked
   * waiter would sit for the full timeout (120s by default), because `waitFor`'s
   * rejection — the disposal signal — is deliberately swallowed below.
   */
  async #awaitRun(
    connection: DeviceConnection,
    subscriptions: SessionSubscriptions,
    sessionId: string,
    options: { timeoutMs: number; startedAt: number; executionId?: string; commandId?: string },
  ): Promise<Record<string, unknown>> {
    const deadline = options.startedAt + options.timeoutMs
    let latestExecutionId = options.executionId
    // THE BASELINE: the newest seq already in the buffer when this wait began.
    // The fold below sees only events strictly after it, so a prior run's
    // terminal — still sitting in the cumulative buffer — can never speak for
    // this wait. Captured ONCE, so each pass is cheap and the cut never moves.
    const baselineSeq = this.#newestSeq(subscriptions, sessionId)

    for (;;) {
      // The link is the precondition for EVERYTHING below: a closed connection
      // cannot deliver the event this wait exists to see, so continuing would
      // only delay the caller's discovery that the run is unobservable.
      if (connection.state !== 'connected') {
        throw new DeviceUnavailableError(connection.record.deviceId, connection.state)
      }

      const observed = this.#observedState(subscriptions, sessionId, {
        baselineSeq,
        ...(latestExecutionId === undefined ? {} : { awaitedExecutionId: latestExecutionId }),
      })
      if (observed.executionId !== undefined) latestExecutionId = observed.executionId

      // SOFT TERMINAL first: ANY unanswered pending interaction means the run
      // cannot progress without the caller, so waiting longer would burn the
      // window for nothing. The report names the OLDEST such interaction, which
      // is the deterministic one to answer first.
      const pending = observed.pendingInteractions[0]
      if (pending !== undefined) {
        return {
          status: 'awaiting-interaction' satisfies CherryRunStatus,
          sessionId,
          executionId: observed.executionId ?? options.executionId ?? null,
          ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
          interactionId: pending.interactionId,
          kind: pending.kind,
          summary: pending.summary,
          questions: pending.questions,
          // Every interaction still awaiting an answer, so a caller that wants
          // to drain them all does not have to re-list.
          pendingInteractions: observed.pendingInteractions,
          cursor: this.#cursorOf(subscriptions, sessionId),
        }
      }

      // HARD TERMINAL: one of the four execution states, FOR THIS EXECUTION.
      if (observed.terminalStatus !== undefined) {
        return await this.#terminalResult(connection, subscriptions, sessionId, observed.terminalStatus, {
          ...(latestExecutionId === undefined ? {} : { executionId: latestExecutionId }),
          ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
        })
      }

      const now = Date.now()
      if (now >= deadline) {
        // TIMEOUT IS NOT A FAILURE (spec §6): hand back what arrived, plus the
        // cursor, so the caller can continue from exactly here.
        return await this.#timeoutResult(connection, subscriptions, sessionId, {
          timeoutMs: options.timeoutMs,
          ...(latestExecutionId === undefined ? {} : { executionId: latestExecutionId }),
          ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
        })
      }

      // Park on the session buffer: `waitFor` settles when the buffer advances
      // past the cursor we have already consumed, and the poll bounds how long
      // a MISSED wake can delay the next judgement pass.
      //
      // The rejection path is SWALLOWED deliberately — a `waitFor` rejection
      // normally means the buffer moved or the session was re-subscribed, and
      // the next pass re-judges from the fresh state. But it must still be
      // THROTTLED, and that fallback is the whole reason this is not a bare
      // `.catch()` on the race: `waitFor` rejects SYNCHRONOUSLY once the layer
      // no longer tracks the session (the disposal path clears its map), so a
      // race that settled instantly on that rejection would spin the loop with
      // no sleep at all — burning the heap rather than the clock. A rejecting
      // wake therefore falls back to a full poll interval before the next pass.
      const cursor = this.#cursorOf(subscriptions, sessionId)
      const pollMs = Math.min(this.#waitPollMs, Math.max(1, deadline - now))
      const woke = await Promise.race([
        subscriptions.waitFor(sessionId, cursor).then(
          () => true,
          () => false,
        ),
        sleep(pollMs).then(() => true),
      ])
      if (!woke) await sleep(pollMs)
    }
  }

  /**
   * The session's observed execution/interaction state, as the real-time event
   * stream has reported it.
   *
   * Two scoping rules make this correct across CONSECUTIVE runs on one session
   * (the session buffer is cumulative and an ack does not shrink it, so a naive
   * replay would re-see every prior run's terminal):
   *
   *  1. **A terminal is attributed to its own execution.** `terminalStatus` is
   *     reported ONLY for `awaitedExecutionId`; every other execution's terminal
   *     is ignored. This is the fix for the stale-terminal bug — a second send
   *     on one session must not read the FIRST run's `completed` and return
   *     while its own run is still in flight.
   *  2. **Only terminals are cut at the baseline; pendings never are.** The
   *     baseline excludes an execution that settled BEFORE this wait began, but
   *     a still-unanswered interaction is not history — it is exactly the soft
   *     terminal the waiter exists to report, so it must stay visible however
   *     long it has been pending.
   *
   * `terminalStatus` is the closed four-state set; the receipt dimension's
   * `interrupted` never lands here.
   *
   * `pendingInteractions` is a SET, not a slot: the soft-terminal predicate is
   * "ANY unanswered pending interaction" (spec §3.6), so two pendings where the
   * later-registered settles first must leave the earlier one visible.
   */
  #observedState(
    subscriptions: SessionSubscriptions,
    sessionId: string,
    options: { baselineSeq: number; awaitedExecutionId?: string },
  ): {
    executionId?: string
    terminalStatus?: string
    pendingInteractions: Array<{
      interactionId: string
      kind: string
      summary: string
      questions: string[]
    }>
  } {
    const state: {
      executionId?: string
      terminalStatus?: string
      pendingInteractions: Array<{ interactionId: string; kind: string; summary: string; questions: string[] }>
    } = { pendingInteractions: [] }

    const awaited = options.awaitedExecutionId
    // Keyed by interactionId: a later `interaction.updated` for the same
    // interaction REPLACES its entry, and a settled one REMOVES it — but only
    // its own, so an unrelated pending is never clobbered.
    const pending = new Map<
      string,
      { interactionId: string; kind: string; summary: string; questions: string[] }
    >()
    // The baseline decides ONLY whether an execution terminal is in scope. An
    // execution that had already settled when the wait began belongs to an
    // earlier run; one that settles after it is this wait's answer.
    const settledBeforeBaseline = new Set<string>()

    for (const entry of this.#eventsOf(subscriptions, sessionId)) {
      const seq = Number(entry['seq'])
      const beforeBaseline = !Number.isFinite(seq) || seq <= options.baselineSeq

      const kind = String(entry['kind'] ?? '')
      const payload = isRecord(entry['payload']) ? entry['payload'] : {}

      if (kind === 'interaction.updated') {
        const interactionId = optionalString(payload['interactionId'])
        const status = optionalString(payload['status'])
        if (interactionId === undefined) continue
        if (status !== 'pending') {
          pending.delete(interactionId)
          continue
        }
        // A pending interaction is NOT history: it stays a soft terminal
        // regardless of when it arrived.
        pending.set(interactionId, {
          interactionId,
          kind: optionalString(payload['kind']) ?? 'decision',
          summary: String(payload['summary'] ?? ''),
          questions: questionKeysOf(payload['input']),
        })
        continue
      }

      if (kind !== 'execution.updated') continue
      const executionId = optionalString(payload['executionId'])
      const status = optionalString(payload['status'])
      if (executionId === undefined || status === undefined) continue
      const terminal = (TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(status)

      // Record every pre-baseline settlement, whichever execution it belongs to:
      // it identifies a run that is already over.
      if (beforeBaseline) {
        if (terminal) settledBeforeBaseline.add(executionId)
        continue
      }

      // Post-baseline events of OTHER executions are not this wait's business.
      if (awaited === undefined || executionId !== awaited) continue
      state.executionId = executionId
      state.terminalStatus = terminal ? status : undefined
    }

    // An awaited run that was ALREADY over when the wait began, with nothing
    // pending, is not something to park on: report the terminal it settled on.
    // (Guarded by the pending set: a live interaction outranks a prior terminal,
    // because the run it belongs to is still answerable.)
    if (
      state.terminalStatus === undefined &&
      awaited !== undefined &&
      settledBeforeBaseline.has(awaited) &&
      pending.size === 0
    ) {
      state.terminalStatus = this.#settledStatusOf(subscriptions, sessionId, awaited, options.baselineSeq)
      state.executionId = awaited
    }
    state.pendingInteractions = [...pending.values()]
    return state
  }

  /**
   * The terminal status an execution settled on at or before the baseline, or
   * undefined when it never settled. Only consulted for an awaited execution
   * that was already over when the wait began — the "I am waiting on a run that
   * has already finished" case `cherry_wait` must answer rather than park on.
   */
  #settledStatusOf(
    subscriptions: SessionSubscriptions,
    sessionId: string,
    executionId: string,
    baselineSeq: number,
  ): string | undefined {
    let settled: string | undefined
    for (const entry of this.#eventsOf(subscriptions, sessionId)) {
      if (String(entry['kind'] ?? '') !== 'execution.updated') continue
      const seq = Number(entry['seq'])
      if (Number.isFinite(seq) && seq > baselineSeq) continue
      const payload = isRecord(entry['payload']) ? entry['payload'] : {}
      if (optionalString(payload['executionId']) !== executionId) continue
      const status = optionalString(payload['status'])
      if (status !== undefined && (TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(status)) {
        settled = status
      }
    }
    return settled
  }

  /**
   * The session's buffered events as raw views, oldest first — read through the
   * subscription layer's own `read` with NO cursor, so nothing is consumed and
   * no waiter can disturb the delivery ack.
   *
   * This is the real-time view the soft-terminal predicate is defined over
   * (spec §3.6: 「经实时 `interaction.updated` 入流」). It is deliberately NOT
   * `projection()`, which carries checkpoint-rebuilt STATE rather than stream
   * events and so has no notion of what arrived live.
   *
   * `seq` is preserved on each view — {@link CherryToolEngine.#observedState}
   * needs it to cut the fold at a baseline.
   */
  #eventsOf(subscriptions: SessionSubscriptions, sessionId: string): Array<Record<string, unknown>> {
    const result = subscriptions.read(sessionId)
    if (!('events' in result)) return []
    return result.events.map((event) => event as unknown as Record<string, unknown>)
  }

  /**
   * The newest stream seq the session buffer holds — the baseline a waiter
   * captures at its start, so its fold sees only events that arrive AFTER it.
   */
  #newestSeq(subscriptions: SessionSubscriptions, sessionId: string): number {
    const events = this.#eventsOf(subscriptions, sessionId)
    let newest = 0
    for (const entry of events) {
      const seq = Number(entry['seq'])
      if (Number.isFinite(seq) && seq > newest) newest = seq
    }
    return newest
  }

  /**
   * The terminal aggregate: the run's status plus the assistant text the peer
   * has by now, with `{ref}` parts resolved through the same externalized
   * content walk `cherry_read` uses.
   */
  async #terminalResult(
    connection: DeviceConnection,
    subscriptions: SessionSubscriptions,
    sessionId: string,
    status: string,
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sessionResult = (await connection.rpc.request('agent.sessions.get', { sessionId })) as Record<
      string,
      unknown
    >
    const session = isRecord(sessionResult['session']) ? sessionResult['session'] : {}
    const messages = await this.#readTerminalMessages(connection, sessionId, session)
    // The cache is refreshed from the terminal snapshot so a follow-up send
    // does not have to re-read the session.
    const idle = optionalString(session['idleRevision']) ?? optionalString(session['historyRevision'])
    if (idle !== undefined) this.#revisionCache.set(this.#cacheKey(sessionId), idle)

    return {
      status,
      sessionId,
      ...extra,
      session,
      text: aggregateAssistantText(messages),
      messages,
      cursor: this.#cursorOf(subscriptions, sessionId),
    }
  }

  /**
   * The timeout result: NOT a failure. Partial content read so far + the
   * cursor to resume from.
   */
  async #timeoutResult(
    connection: DeviceConnection,
    subscriptions: SessionSubscriptions,
    sessionId: string,
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sessionResult = (await connection.rpc.request('agent.sessions.get', { sessionId })) as Record<
      string,
      unknown
    >
    const session = isRecord(sessionResult['session']) ? sessionResult['session'] : {}
    const messages = await this.#readTerminalMessages(connection, sessionId, session)
    return {
      status: 'timeout' satisfies CherryRunStatus,
      sessionId,
      ...extra,
      session,
      text: aggregateAssistantText(messages),
      messages,
      cursor: this.#cursorOf(subscriptions, sessionId),
    }
  }

  /**
   * The session's assistant messages, read to completion with `{ref}` parts
   * aggregated through `agent.content.read` — the SAME path `cherry_read` uses
   * (spec §3.6: the terminal aggregate resolves externalized parts too).
   */
  async #readTerminalMessages(
    connection: DeviceConnection,
    sessionId: string,
    session: Record<string, unknown>,
  ): Promise<CherryReadMessage[]> {
    const historyRevision = optionalString(session['historyRevision'])
    if (historyRevision === undefined) return []

    const page = await this.#aggregate(
      connection,
      'agent.messages.list',
      { sessionId, historyRevision },
      (result) => ({ items: arrayOf(result['items']), nextCursor: result['nextCursor'] }),
      MAX_AGGREGATE_LIMIT,
    )

    const messages: CherryReadMessage[] = []
    for (const raw of page.items) {
      messages.push(await this.#projectMessage(connection, sessionId, raw))
    }
    return messages
  }

  async #ensureSubscription(deviceId: string, sessionId: string): Promise<void> {
    const subscriptions = this.#deps.subs(deviceId)
    if (subscriptions.activeSessions().includes(sessionId)) return
    await subscriptions.ensure(sessionId)
  }

  /**
   * The session's current cache window start, or null when it is untracked.
   *
   * The subscriptions layer owns the boundary and exposes it only through
   * `read`'s verdict, so the tool finds it honestly instead of reaching into
   * private state: the servable range is strictly after the window start, so
   * the start is the smallest seq `read` refuses. `read` is purely local (it
   * never touches the channel), so probing it costs no RPC.
   */
  #windowStart(subscriptions: SessionSubscriptions, sessionId: string, probe: AgentCursor): AgentCursor | null {
    if (!subscriptions.activeSessions().includes(sessionId)) return null
    const epoch = probe.streamEpoch
    const servable = (seq: number): boolean =>
      'events' in subscriptions.read(sessionId, { sessionId, streamEpoch: epoch, seq: String(seq) })

    // Bracket an upper bound that IS servable, then binary-search the boundary.
    // The window start can never exceed the newest delivered seq, which is what
    // the caller's own cursor is at or behind, so this terminates quickly.
    const ceiling = Number(probe.seq) + 1
    let high = 0
    while (!servable(high)) {
      high += 1
      if (high > ceiling) return null
    }
    let low = 0
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (servable(mid)) high = mid
      else low = mid + 1
    }
    // `low` is servable and `low - 1` is not: the window start is `low - 1`.
    return { sessionId, streamEpoch: epoch, seq: String(low - 1) }
  }
}

// ---------------------------------------------------------------------------
// Small shared readers
// ---------------------------------------------------------------------------

/** The array at `value`, or an empty array when the peer sent something else. */
function arrayOf(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

/** The caller's aggregate limit, defaulting to one page and capped at the max. */
function aggregateLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PAGE_ITEMS_FALLBACK
  return Math.min(Math.max(Math.floor(value), 1), MAX_AGGREGATE_LIMIT)
}

/** Parses the tool-facing cursor argument into the protocol's cursor shape. */
function readCursor(value: unknown): AgentCursor | undefined {
  if (!isRecord(value)) return undefined
  const { sessionId, streamEpoch, seq } = value
  if (typeof sessionId !== 'string' || typeof streamEpoch !== 'string' || typeof seq !== 'string') return undefined
  return { sessionId, streamEpoch, seq }
}

/** A cancellable-free sleep, used only to bound a waiter's judgement cadence. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The caller's wait window in ms, defaulting to {@link DEFAULT_WAIT_TIMEOUT_MS}.
 *
 * The default is a DEFAULT, never a ceiling (spec §3.6): a caller may raise or
 * lower it freely, and the only floor is {@link MIN_WAIT_TIMEOUT_MS} — below
 * that a "wait" would be a snapshot read wearing a wait's name.
 */
function waitTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WAIT_TIMEOUT_MS
  return Math.max(MIN_WAIT_TIMEOUT_MS, Math.floor(value))
}

/**
 * The question TEXTS an interaction asks its answers to be keyed by.
 *
 * The protocol carries a question interaction's input as serialized JSON under
 * `input.text` (or an externalized `input.ref`), with the shape
 * `{questions: [{question, options, ...}]}`. A caller answering by question
 * text should not have to parse that itself, so the texts are surfaced.
 */
function questionKeysOf(input: unknown): string[] {
  const parsed = parseQuestionInput(input)
  if (parsed === undefined) return []
  return parsed
}

/** Extracts the ordered question texts from an interaction input, if any. */
function parseQuestionInput(input: unknown): string[] | undefined {
  if (!isRecord(input)) return undefined
  let body: unknown
  if (typeof input['text'] === 'string') {
    try {
      body = JSON.parse(input['text'])
    } catch {
      return undefined
    }
  } else if (isRecord(input['ref'])) {
    // An externalized input is resolved through `agent.content.read` by the
    // tool that needs the answers; the question list is best-effort here.
    return undefined
  } else {
    body = input
  }
  if (!isRecord(body) || !Array.isArray(body['questions'])) return undefined
  return body['questions']
    .map((question) => (isRecord(question) ? optionalString(question['question']) : undefined))
    .filter((question): question is string => question !== undefined)
}

/**
 * The assistant text a terminal aggregate reports: every `assistant` message's
 * text parts, in order, joined.
 *
 * `{ref}` parts are already resolved by {@link CherryToolEngine}'s
 * `#projectMessage` (the externalized content walk), so this only has to
 * concatenate what the read produced.
 */
function aggregateAssistantText(messages: CherryReadMessage[]): string {
  const chunks: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      if (part.kind !== 'text') continue
      if (part.content === '') continue
      chunks.push(part.content)
    }
  }
  return chunks.join('')
}
