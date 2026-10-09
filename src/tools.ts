import { createHash } from 'node:crypto'
import { DeviceUnavailableError } from './connection'
import type { DeviceConnection, DeviceState } from './connection'
import type { DeviceRecord, DeviceResolution, DeviceStore } from './deviceStore'
import { JsonRpcRequestError } from './rpc/jsonRpcClient'
import type { ReadResult, SessionSubscriptions } from './subscriptions'
import type { PairWithPayloadOptions } from './pairing'
import type { AgentCursor } from '@cherrystudio/remote-protocol/agent'

/**
 * The plugin's tool face, part 1: the six READ-ONLY `cherry_*` tools plus the
 * registration framework Tasks 9/10 extend.
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

/** A page-aggregating result: the items plus how much of the aggregate is here. */
export interface CherryPage<T> {
  items: T[]
  /** True when the aggregate stopped at the caller's limit with more available. */
  truncated: boolean
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
}

/** The two-level `cherry_read` snapshot. */
export interface CherryReadSnapshot {
  session: Record<string, unknown>
  messages: CherryReadMessage[]
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Protocol constants (values come from the peer's hello, never hardcoded here)
// ---------------------------------------------------------------------------

/** The protocol's single-page hard cap, used only as the pre-hello ceiling. */
const PAGE_ITEMS_FALLBACK = 100
/** The largest aggregate a caller may ask for; the per-page clamp still applies. */
const MAX_AGGREGATE_LIMIT = 1000
/** One `agent.content.read` slice is capped at the protocol's `remoteLimits.contentBytes`. */
const CONTENT_READ_MAX_BYTES = 24 * 1024
/** Guard against a peer that never reports `nextCursor: null`. */
const MAX_PAGES = 10_000

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
  /** Task 9/10's pairing entry point; unused by the read-only tools. */
  pair: (options: PairWithPayloadOptions) => Promise<unknown>
  /** The local Ed25519 identity bytes; unused by the read-only tools. */
  identity: Uint8Array
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

/**
 * Registers the six read-only `cherry_*` tools on `ctx.tools`.
 *
 * The registration framework is deliberately thin because Tasks 9/10 extend it:
 * {@link defineCherryTool} is the ONE place a tool declaration is assembled, so
 * those tasks add mutating tools without touching the host seam.
 */
export function registerCherryTools(ctx: CherryToolsContext, deps: CherryToolsDeps): () => void {
  const tools = ctx.tools
  if (tools === undefined) {
    // Headless deployments have no tool registry. Degrade to a warning rather
    // than throwing: the assembly's HTTP/UI half must still come up.
    console.warn('[cherry-remote] ctx.tools is unavailable; the cherry_* tools were not registered')
    return () => {}
  }

  const engine = new CherryToolEngine(deps)
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

  constructor(deps: CherryToolsDeps) {
    this.#deps = deps
  }

  definitions(): CherryToolDefinition[] {
    return [
      this.#devicesTool(),
      this.#agentsTool(),
      this.#workspacesTool(),
      this.#sessionsTool(),
      this.#readTool(),
      this.#eventsTool(),
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
   * Walks pages until the caller's aggregate `limit` is reached or the peer
   * runs out, clamping EVERY page to the negotiated `pageItems`.
   *
   * The clamp is the whole point: `limit: 150` means "at most 150 items
   * total", never "ask the peer for 150 in one page" — the protocol's
   * single-page cap is a hard wire limit the plugin cannot override.
   */
  async #aggregate<T>(
    connection: DeviceConnection,
    method: string,
    params: Record<string, unknown>,
    extract: (page: Record<string, unknown>) => { items: T[]; nextCursor: unknown },
    limit: number,
  ): Promise<CherryPage<T>> {
    const pageItems = Math.max(1, Math.floor(connection.limits.pageItems || PAGE_ITEMS_FALLBACK))
    const aggregate = Math.max(1, Math.floor(limit))
    const items: T[] = []
    let cursor: string | undefined
    let truncated = false

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const remaining = aggregate - items.length
      if (remaining <= 0) {
        truncated = true
        break
      }
      const request: Record<string, unknown> = {
        ...params,
        // The per-page clamp: never more than one page's worth, whatever the
        // remaining aggregate says.
        limit: Math.min(remaining, pageItems),
      }
      if (cursor !== undefined) request['cursor'] = cursor
      const result = (await connection.rpc.request(method, request)) as Record<string, unknown>
      const extracted = extract(result)
      for (const item of extracted.items) {
        if (items.length >= aggregate) break
        items.push(item)
      }
      const next = extracted.nextCursor
      if (next === null || next === undefined) break
      cursor = String(next)
    }

    return { items, truncated }
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
        return { items: page.items, systemWorkspace, truncated: page.truncated }
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
    return { session, messages, truncated: page.truncated }
  }

  /** One message: list ALL its parts under the message's OWN revision, then aggregate. */
  async #projectMessage(
    connection: DeviceConnection,
    sessionId: string,
    raw: Record<string, unknown>,
  ): Promise<CherryReadMessage> {
    const messageId = String(raw['messageId'] ?? '')
    const revision = String(raw['revision'] ?? '')
    // A message's parts are read to COMPLETION (not caller-bounded): a partial
    // part list would silently drop content from the snapshot, so the aggregate
    // ceiling here is the protocol maximum, walked page by page under the same
    // per-page clamp every other read obeys.
    const page = await this.#aggregate(
      connection,
      'agent.parts.list',
      { sessionId, messageId, messageRevision: revision },
      (result) => ({ items: arrayOf(result['items']), nextCursor: result['nextCursor'] }),
      MAX_AGGREGATE_LIMIT,
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

    const chunks: Uint8Array[] = []
    let offset = '0'
    let sha: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
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
      if (slice['eof'] === true) break
      const next = slice['nextOffset']
      if (typeof next !== 'string' || next === offset) {
        throw new Error(`agent.content.read for ${contentId} did not advance (offset ${offset})`)
      }
      offset = next
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

  /**
   * First-use ensure per session, cursorless by design (spec §3.5): a session
   * with a live subscription is left alone, so the same-session re-subscribe
   * CONFLICT the protocol forbids is never provoked.
   */
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
