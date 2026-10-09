import type { AddressInfo } from 'node:net'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import type { ComponentLogger, Logger } from '@libp2p/interface'
import {
  acceptSecureChannel,
  createDeviceIdentity,
  deviceIdentityId,
  RemoteSocketStream,
} from '@cherrystudio/remote-transport'
import type { SecureChannel } from '@cherrystudio/remote-transport'
import { connectionMethods, pairingMethods, remoteLimits } from '@cherrystudio/remote-protocol'
import { agentAuthorizationSchema, agentMethods } from '@cherrystudio/remote-protocol/agent'
import type { AgentCheckpointPage, AgentCursor } from '@cherrystudio/remote-protocol/agent'
import { toRemoteSocket } from '../../src/rpc/wsAdapter'

/**
 * A protocol-level failure injected by a test, shaped exactly like the
 * `remoteFailure` payload the real desktop returns inside JSON-RPC `error.data`.
 */
export interface FakeFailure {
  reason: string
  message: string
  retryAfterMs?: number
}

/** Configuration of the `connection.hello` reply (limits/heartbeat face). */
export interface FakeHelloOptions {
  /** Echoed heartbeatMs; the client pings on this cadence (default 20_000). */
  heartbeatMs?: number
  /** Omit the heartbeatMs key entirely to exercise the client's fallback. */
  omitHeartbeatMs?: boolean
  /** Echoed `limits` record (client reads pageItems/subscriptions/inFlightRequests). */
  limits?: Record<string, number>
  /** Omit the limits key entirely to exercise the client's fallback. */
  omitLimits?: boolean
}

/**
 * Config surface of the fake desktop. Deliberately wide: Tasks 6/7/8/9/13
 * extend this harness (pairing, subscriptions, agent methods, rate-limit
 * semantics) rather than rewrite it, so every injection knob is optional and
 * independently combinable.
 */
export interface FakeCherryOptions {
  /** Desktop static identity; a fresh key is generated when omitted. */
  identity?: Uint8Array
  /** Versions offered in the Noise-prelude negotiation (default [1]). */
  protocolVersions?: number[]
  hello?: FakeHelloOptions
  /** Token lifetime handed out by authenticate/refresh (default 600_000). */
  tokenTtlMs?: number
  /** Every `connection.authenticate` fails with this protocol failure. */
  authenticateFailure?: FakeFailure
  /** Every `connection.refresh` fails with this protocol failure. */
  refreshFailure?: FakeFailure
  /** Accept pings but never answer them (silence-timeout exercises). */
  dropPings?: boolean
  /**
   * Interface the ws server binds (default 127.0.0.1). Set '::1' to exercise
   * the IPv6 candidate path, which needs a bare-or-bracketed IPv6 authority.
   */
  bindHost?: string
  /** Artificial per-request delay; requests stay counted as in-flight while waiting. */
  requestDelayMs?: number
  /**
   * Server-side rate cap per second. Exceeding it closes the whole session
   * with 1011 (the authoritative rate-termination face — NOT a per-request
   * rejection), mirroring the real desktop's session-level enforcement.
   */
  rateLimitPerSecond?: number
  /**
   * Terminal state `pairing.get` settles on. `undefined` (default) keeps
   * answering `pending` forever, which is what a real invitation does until the
   * user acts or the invitation expires.
   */
  pairingDecision?: 'approved' | 'rejected' | 'expired'
  /** Number of `pairing.get` calls answered `pending` before the decision. */
  pairingGetPendingPolls?: number
  /**
   * Capability domains the approved `pairing.get` branch grants (default
   * ['agent']). An empty array models a desktop that approved nothing usable.
   */
  approvedGrants?: readonly string[]
  /** Agent face (Task 7): journal replay/checkpoint/subscription-limit knobs. */
  agent?: FakeAgentOptions
}

/**
 * Injection surface of the agent face. Every knob defaults to the REAL peer's
 * behaviour (see `_research/cherry-studio/src/main/services/remoteAccess/
 * agentSubscriptions.ts` + `agentJournal.ts`), so a test only states the one
 * dimension it is moving.
 */
export interface FakeAgentOptions {
  /**
   * Peer subscription cap enforced by `agent.sessions.subscribe` (default
   * `remoteLimits.subscriptions` = 8). The N+1-th concurrent subscription is
   * answered `RESOURCE_EXHAUSTED` — the peer-side dimension Task 7⑨ anchors.
   */
  subscriptionLimit?: number
  /**
   * Prepared-lease window in ms (default `remoteLimits.checkpointMs` = 300_000).
   * Test ⑧/⑩ inject a small value so an expired lease needs no real wait.
   */
  checkpointMs?: number
  /**
   * Epoch of the session journal. A requested cursor whose `streamEpoch`
   * differs is refused with a `checkpoint` descriptor ("epoch changed").
   */
  streamEpoch?: string
  /**
   * Highest seq the journal watermark has reached. A replay request beyond it
   * is refused with a `checkpoint` descriptor ("cursor ahead of watermark").
   */
  watermark?: number
  /**
   * Oldest seq still retained by the replay window. A requested cursor older
   * than `firstRetainedSeq - 1` is refused with a `checkpoint` descriptor
   * ("replay window evicted") — the §6 「replay 超预算 → checkpoint 回退」 face
   * that Task 7⑪ injects explicitly.
   */
  firstRetainedSeq?: number
  /**
   * Milliseconds to delay every `agent.checkpoints.read` reply. Lets a test
   * drive a pagination pass past the prepared lease without racing.
   */
  checkpointReadDelayMs?: number
  /**
   * Number of leading `agent.checkpoints.read` calls the delay applies to
   * (default: all of them). Set 1 so only the FIRST chain overruns its lease
   * and the recovery retry can converge.
   */
  checkpointReadDelayCalls?: number
  /**
   * Force `agent.checkpoints.read`/`activate` to answer this failure ONCE
   * (the injection consumes itself). Test ⑩'s explicit CHECKPOINT_EXPIRED-on-
   * activate anchor, independent of the natural lease-expiry path.
   */
  failNextCheckpointCall?: FakeFailure
  /**
   * When true, an injected `CHECKPOINT_EXPIRED` does NOT free the peer-side
   * subscription. Models a peer that reports the expiry without resetting its
   * own bookkeeping, so a client that fails to close the dead prepared
   * subscription before re-subscribing collides with CONFLICT.
   */
  keepSubscriptionOnInjectedExpiry?: boolean
  /**
   * PERSISTENT `CHECKPOINT_EXPIRED` injection: EVERY checkpoint face expires
   * forever, so the submission can never converge. Unlike
   * `failNextCheckpointCall` this does not consume itself — it is the anchor
   * for "the client's retry budget is finite", where a layer without a real
   * shared budget would loop forever.
   */
  alwaysExpireCheckpoints?: boolean
  /**
   * Force `agent.sessions.subscribe` to answer with a checkpoint descriptor
   * regardless of the requested cursor — the "no usable replay" face used to
   * enter the recovery chain deterministically.
   */
  forceCheckpointMode?: boolean
  /**
   * Read-face fixtures (Task 8): the agent/workspace/session/message/part
   * records the read RPCs serve. Absent means "no records registered", which is
   * the honest state of a desktop that has none.
   */
  agents?: FakeAgentRecord[]
  workspaces?: FakeWorkspaceRecord[]
  /**
   * Sessions the read face serves. Task 9's create face PUSHES into this array
   * (the peer's `createSessionTx` really does add a row), so a test can assert
   * the two-step read-back of a session it just created.
   */
  sessions?: FakeSessionRecord[]
  /**
   * Messages every registered session serves; `parts` decide the two-level
   * read. Task 9's `terminalMessage` is appended here by an accepted run.
   */
  messages?: FakeMessageRecord[]
  /**
   * Page size the read faces use when a request omits `limit` (the real peer's
   * `DEFAULT_PAGE` is 20). Every reply is clamped to `remoteLimits.pageItems`
   * regardless, exactly like the real `pageOf`.
   */
  defaultPageSize?: number
  /**
   * A ceiling the read faces impose on EVERY page on top of the requested
   * limit — a peer that pages smaller than the protocol cap. Models the
   * three-pages-of-50 case without violating the protocol's 100-item cap.
   */
  maxPageSize?: number
  /**
   * PEER FAULT injection: answer with an EMPTY `items` array plus this dangling
   * `nextCursor`, forever. Models a broken peer whose pagination never makes
   * progress — a walk bounded only by item count would spin here indefinitely.
   */
  emptyPagesWithDanglingCursor?: string
  /**
   * PEER FAULT injection: serve the FIRST page normally, then repeat it forever
   * with this unchanged `nextCursor`. Models a peer whose cursor never advances
   * — the same no-progress class as an empty page, but reached through
   * non-empty pages, so the two guards are independently observable.
   */
  stuckCursor?: string
  /**
   * One-shot failures for the read faces, keyed by method name. Each entry is
   * consumed by the first call it matches (the §6 REVISION_EXPIRED injection).
   */
  failNext?: Record<string, FakeFailure>
  /**
   * PERSISTENT failures for the read faces, keyed by method name: every call
   * answers this failure. The "never converges" anchor for the single-retry
   * rule.
   */
  failAlways?: Record<string, FakeFailure>

  // --- Interactive command face (Task 9) -----------------------------------

  /**
   * `agent.interactions.list` fixture: the FULL set the peer holds, exactly as
   * the real `interactionsOf` merges live journal items with persisted rows
   * (pending/approved/denied/expired all present). The peer never filters by
   * status — filtering is CLIENT-side — so a fixture carrying answered items is
   * the honest shape a settled session serves.
   */
  interactions?: FakeInteractionRecord[]
  /**
   * The execution the peer considers ACTIVE for the session
   * (`activeExecutionId`). `agent.executions.cancel` validates
   * `expectedExecutionId` against it, mirroring the real `abortAndDrain`
   * precondition.
   */
  activeExecutionId?: string
  /**
   * The `agent.messages.send` outcome. `'applied'` (default) admits a run;
   * `'busy'` answers the rejected receipt "Session is busy";
   * `'target-unavailable'` answers the §6 TARGET_UNAVAILABLE rejected receipt.
   */
  sendOutcome?: 'applied' | 'busy' | 'target-unavailable'
  /** Same injection for `agent.executions.cancel` (Task 9⑮ covers both verbs). */
  cancelOutcome?: 'applied' | 'target-unavailable'
  /**
   * Delay before an accepted run reaches its terminal `execution.updated`
   * notification. Omitted means the terminal event lands promptly (the
   * waiter's happy path); a value above the caller's `timeoutMs` is what makes
   * the timeout face deterministic.
   */
  runDelayMs?: number
  /**
   * Terminal status the accepted run settles on (default `completed`). Set
   * `'interrupted'` for Task 9⑭ — the transition the CURRENT real server does
   * not produce but whose schema is already pinned (Task 13 asserts that
   * difference). The injected fixture carries `messageId` + the persisted
   * result fields so it satisfies `executionSchema`'s terminal superRefine;
   * without those the schema layer would reject it first and the test would be
   * meaningless.
   */
  runTerminalStatus?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  /**
   * Assistant message a completed run appends to `agent.messages.list` (and
   * whose parts `agent.parts.list` then serves). This is the text the
   * terminal aggregate must return.
   */
  terminalMessage?: FakeMessageRecord
  /**
   * The pending interaction a run pushes as `interaction.updated` (spec §3.6's
   * soft terminal). When set, the soft-terminal scenario is driven entirely by
   * the peer: send → `interaction.updated` → the tool returns early.
   */
  pushInteractionOnRun?: FakeInteractionRecord
  /** Delay before `pushInteractionOnRun` lands (default 0). */
  pushInteractionDelayMs?: number
  /**
   * Message id a run adopts for its terminal `execution.updated`. Defaults to
   * `terminalMessage.messageId` when one is configured, else `msg-1`.
   */
  runMessageId?: string
}

/** One interaction as `agent.interactions.list`/`agent.interactions.get` serve it. */
export interface FakeInteractionRecord {
  interactionId: string
  /** The interaction revision, a numeric string (`/^(0|[1-9][0-9]*)$/`). */
  revision: string
  executionId: string
  toolCallId: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  summary: string
  /** Defaults to `decision` (the peer omits `kind` for non-question cards). */
  kind?: 'question' | 'decision'
  /** Defaults to a digest derived from the interaction id (64 lowercase hex). */
  inputDigest?: string
  /**
   * The interaction's FULL input. For `kind: 'question'` this is the
   * `questionInputSchema` object (`{questions: [{question, options, ...}]}`)
   * the peer parses to validate a full-answer set. Defaults to a single
   * question keyed by `summary`.
   */
  input?: Record<string, unknown>
}

/** One execution as the peer's `execution.updated` events report it. */
export interface FakeExecutionRecord {
  executionId: string
  status: 'running' | 'awaiting-approval' | 'finalizing' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
  messageId?: string
  commandId?: string
}

/** One entry in the peer's idempotency ledger (the real `remoteCommandService`). */
export interface FakeCommandRecord {
  commandId: string
  method: string
  /** Digest of the admitted body; a DIFFERENT body under the same id conflicts. */
  identityDigest: string
  receipt: Record<string, unknown>
}

/** The wire shape `interactions.list` serves for one interaction. */
export type FakeInteractionView = Record<string, unknown>

/**
 * One agent as `agent.agents.list` serves it. `model` mirrors the protocol's
 * nullable model summary, so a fixture can pin the null case too.
 */
export interface FakeAgentRecord {
  agentId: string
  name: string
  emoji?: string
  model?: { modelId: string; providerId: string; name: string } | null
}

/** One registered workspace as `agent.workspaces.list` serves it. */
export interface FakeWorkspaceRecord {
  workspaceId: string
  name: string
}

/**
 * One session as `agent.sessions.list`/`agent.sessions.get` serve it. The
 * `historyRevision` is the read baseline's first hop; `workspaceKind` defaults
 * to `registered` because a system-workspace session must say so explicitly.
 */
export interface FakeSessionRecord {
  sessionId: string
  agentId: string
  workspaceId: string
  workspaceKind?: 'registered' | 'system'
  title: string
  historyRevision: string
  updatedAt?: string
  activeExecutionId?: string
}

/**
 * One message as `agent.messages.list` serves it, with the parts
 * `agent.parts.list` then serves under its `messageRevision`.
 *
 * A part's `content` is either inline `{text}` or a `{ref}` — the large-text
 * externalization the real peer applies above 4096 UTF-16 units. A `ref` part
 * is only resolvable through `agent.content.read`, and that read verifies the
 * whole content's sha256 (not the slice's), exactly like `sliceContent`.
 */
export interface FakeMessageRecord {
  messageId: string
  revision: string
  role: 'system' | 'user' | 'assistant'
  status: 'success' | 'error' | 'pending' | 'paused'
  parts: FakePartRecord[]
}

/** One part fixture; `text` is the FULL text a `{ref}` part resolves to. */
export interface FakePartRecord {
  kind: 'text' | 'reasoning' | 'tool-input' | 'tool-output' | 'file' | 'data'
  text: string
  /** Force the `{ref}` externalized form regardless of length. */
  external?: boolean
  state?: 'completed' | 'streaming' | 'failed'
  toolName?: string
  toolCallId?: string
  name?: string
}

/** One event appended to a fake journal; `seq`/`streamEpoch` are assigned on append. */
export interface FakeAgentEvent {
  kind: string
  payload: unknown
}

/**
 * Peer-observed subscription state, mirroring the real `Subscription` record
 * (`phase` especially: the peer sets `reset` on close, which is what makes a
 * same-session re-subscribe legal).
 */
export interface FakeSubscriptionRecord {
  subscriptionId: string
  sessionId: string
  phase: 'prepared' | 'active' | 'reset'
  cursorSeq: number
  lastAck: number
}

/** One `agent.sessions.subscribe` request as the peer received it. */
export interface FakeSubscribeCall {
  sessionId: string
  cursor: AgentCursor | undefined
  /** The outcome the peer replied with. */
  mode: 'replay' | 'checkpoint' | 'error'
  reason?: string
  subscriptionId?: string
}

interface IssuedToken {
  token: string
  at: number
  expiresAt: number
}

interface LiveConnection {
  socket: WebSocket
  channel: SecureChannel
  controller: AbortController
  /** Set once `connection.hello` confirmed the prelude offer, like the peer's. */
  hello: boolean
}

const noop = (): void => {}
const DEFAULT_PROTOCOL_VERSIONS = [1]
const JSON_RPC_ERROR_CODE = 1000
/** The invitation lifetime the real desktop uses (protocol `invitationMs`). */
const INVITATION_MS = 120_000
const CLAIM_ID = 'claim-1'
/** The real peer's `INLINE_TEXT_LIMIT`: above it, part text travels as a `{ref}`. */
const INLINE_TEXT_LIMIT = 4096

/** The real peer's content digest: lowercase hex sha256 over the whole content. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Deterministic JSON with sorted keys — the digest input for the fake's
 * idempotency ledger, so a replay of the SAME body hashes identically while a
 * reordered-but-equal object does not spuriously conflict.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
}

/** A callable libp2p logger: noise/inbound streams invoke it as `log('msg')`. */
function makeLogger(name: string): Logger {
  const log = (() => {}) as unknown as Logger
  log.error = noop
  log.trace = noop
  log.enabled = false
  log.newScope = (scope: string) => makeLogger(`${name}:${scope}`)
  return log
}

const componentLogger: ComponentLogger = { forComponent: (name: string) => makeLogger(name) }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Inbound params schemas come from the real protocol package so the fake
 * rejects malformed requests exactly like the real desktop face. The agent
 * face (Task 7) is validated against `agentMethods` too.
 */
const methodSchemas = {
  ...connectionMethods(agentAuthorizationSchema),
  ...pairingMethods(agentAuthorizationSchema),
  ...agentMethods,
} as unknown as Record<
  string,
  { params: { safeParse: (input: unknown) => { success: boolean } } }
>

function parseParams(method: string, params: unknown): Record<string, unknown> | undefined {
  const schema = methodSchemas[method]
  if (schema === undefined || schema.params.safeParse(params).success) {
    return params as Record<string, unknown>
  }
  return undefined
}

/** Internal control-flow channel: a handler-thrown protocol failure. */
class FakeRpcError extends Error {
  constructor(readonly failure: FakeFailure) {
    super(failure.message)
  }
}

/**
 * A loopback stand-in for the Cherry Studio desktop: a real `ws` server whose
 * connections are upgraded with `acceptSecureChannel` (real Noise XX, real
 * prelude negotiation) and then serve a minimal hello/authenticate/refresh/ping
 * JSON-RPC face.
 *
 * The read loop dispatches frames CONCURRENTLY: a slow handler must never
 * block the next frame, or the fake could not observe the client's true
 * in-flight concurrency.
 */
export class FakeCherry {
  readonly #options: FakeCherryOptions
  readonly #identity: Promise<Uint8Array>
  #server: WebSocketServer | undefined
  #live: LiveConnection[] = []

  // Runtime-mutable injection state (tests flip these mid-flight).
  #refreshFailure: FakeFailure | undefined
  #authenticateFailure: FakeFailure | undefined
  #dropPings: boolean

  // Observation surface.
  #socketCount = 0
  #connectionCount = 0
  #socketCloseTimes: number[] = []
  #requestCount = 0
  #requestTimestamps: number[] = []
  #methodCounts = new Map<string, number>()
  #inFlight = 0
  #maxInFlight = 0
  #lastHelloProtocolVersions: number[] | undefined
  #helloEchoMatchesOffer = false
  #offeredVersionsAtHello: readonly number[] = []
  #tokenIssues: IssuedToken[] = []
  #refreshCalls: number[] = []

  // Pairing face observation (Task 6).
  #claimPeerIdentity: string | undefined
  #verificationCode: string | undefined
  #expiresAt: string | undefined
  #approvedDeviceId: string | undefined
  #issuedAccessToken: string | undefined
  #approvedTokenExpiresAt: string | undefined
  #getStates: string[] = []
  #lastClaim: Record<string, unknown> | undefined

  // Agent face observation (Task 7).
  /** Journal events per session, seq assigned from the session watermark. */
  #journals = new Map<string, Array<{ seq: number; kind: string; payload: unknown }>>()
  #journalEpoch: string
  #watermark: number
  #subscriptions = new Map<string, FakeSubscriptionRecord>()
  #subscribeCalls: FakeSubscribeCall[] = []
  #checkpointReadCalls: Array<{ subscriptionId: string; checkpointId: string; pageCursor: string | undefined }> = []
  #activateCalls: Array<{ subscriptionId: string; appliedCursor: AgentCursor; ok: boolean }> = []
  #ackCalls: Array<{ subscriptionId: string; cursor: AgentCursor }> = []
  #closeCalls: Array<{ subscriptionId: string; sessionId: string | undefined }> = []
  /** Per-subscription prepared-lease deadline (ms since epoch). */
  #leaseDeadlines = new Map<string, number>()
  #checkpointSequences = new Map<string, string[]>()
  #checkpointCursorBySubscription = new Map<string, AgentCursor>()
  #storedCheckpoints = new Map<string, { descriptor: AgentCursor; pages: AgentCheckpointPage[] }>()
  #failNextCheckpointCall: FakeFailure | undefined
  #subscriptionPhases: string[] = []
  /** Ordered agent-face call log (`agent.subscriptions.close`, `...subscribe`, ...). */
  #agentCallSequence: string[] = []
  #agentCallTimestamps: Array<{ method: string; at: number }> = []

  // Read-face observation (Task 8).
  /** Every read-face request's params exactly as the peer received them. */
  #readCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  /** One-shot read-face failures, consumed by the first matching call. */
  #readFailNext: Map<string, FakeFailure>
  /** Externalized content bytes, keyed `<contentId>:<revision>` (the peer's pins). */
  #contentBytes = new Map<string, Uint8Array>()
  /**
   * The digest each pin ADVERTISED when its `{ref}` part was projected. The
   * real peer's `content.read` returns this same recorded digest, so a
   * mutation of the bytes shows up as a disagreement exactly as it would
   * against the real desktop.
   */
  #contentDigests = new Map<string, string>()
  /** Deliberately FALSE `byteLength` declarations (see `understateContentLength`). */
  #contentByteOverrides = new Map<string, number>()

  // Interactive command face observation (Task 9).
  /**
   * The peer's command-receipt store, keyed by commandId — the real
   * `remoteCommandService`'s per-(device, grant, commandId) memory. Replaying
   * the same id with the same body returns the RECORDED receipt; a different
   * body is `IDEMPOTENCY_CONFLICT`, exactly like the real `admit`.
   */
  #commands = new Map<string, FakeCommandRecord>()
  /** Every command-face request's params exactly as the peer received them. */
  #commandCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  /** Interactions the peer currently serves via `agent.interactions.list`. */
  #interactions: FakeInteractionRecord[]
  /** The execution id the peer reports as active for the session. */
  #activeExecutionId: string | undefined
  /** Every execution status the peer emitted as `execution.updated`, in order. */
  #executionUpdates: Array<{ executionId: string; status: string; messageId?: string }> = []
  /** Monotonic counter behind the fake's own interaction revisions. */
  #interactionRevision = 0
  /** The digest of each interaction as the peer LAST projected it. */
  #interactionDigests = new Map<string, string>()
  /**
   * Runs SUSPENDED on an interaction, keyed by that interaction's id. Answering
   * the interaction resumes the run to the terminal state recorded here — the
   * peer-side half of spec §3.6's 「respond 后可调 cherry_wait 恢复等待」.
   */
  #parkedRuns = new Map<string, { sessionId: string; executionId: string; status: string; messageId: string }>()

  constructor(options: FakeCherryOptions = {}) {
    this.#options = options
    this.#identity = options.identity !== undefined ? Promise.resolve(options.identity) : createDeviceIdentity()
    this.#refreshFailure = options.refreshFailure
    this.#authenticateFailure = options.authenticateFailure
    this.#dropPings = options.dropPings ?? false
    this.#journalEpoch = options.agent?.streamEpoch ?? 'epoch-1'
    this.#watermark = options.agent?.watermark ?? 0
    this.#failNextCheckpointCall = options.agent?.failNextCheckpointCall
    this.#readFailNext = new Map(Object.entries(options.agent?.failNext ?? {}))
    this.#interactions = [...(options.agent?.interactions ?? [])]
    this.#activeExecutionId = options.agent?.activeExecutionId
    for (const interaction of this.#interactions) {
      this.#interactionDigests.set(interaction.interactionId, this.#digestOf(interaction))
    }
  }

  /** The desktop's pinned peer id, for `DeviceRecord.desktopIdentity`. */
  get identityId(): Promise<string> {
    return this.#identity.then((key) => deviceIdentityId(key))
  }

  /** Sockets accepted (TCP/WS layer, before any handshake outcome). */
  get socketCount(): number {
    return this.#socketCount
  }

  /** Noise handshakes completed successfully. */
  get connectionCount(): number {
    return this.#connectionCount
  }

  /** Currently connected client sockets (live server.clients size). */
  get connectedClients(): number {
    return this.#server?.clients.size ?? 0
  }

  /**
   * Wall-clock times (performance.now) of peer-observed socket closes —
   * ordering evidence for "the socket was still open when X happened".
   */
  get socketCloseTimes(): readonly number[] {
    return this.#socketCloseTimes
  }

  get requestCount(): number {
    return this.#requestCount
  }

  /** Arrival time of every served request — the rate-window observation. */
  get requestTimestamps(): readonly number[] {
    return this.#requestTimestamps
  }

  get inFlight(): number {
    return this.#inFlight
  }

  /** Peak simultaneous unanswered requests observed since start. */
  get maxInFlight(): number {
    return this.#maxInFlight
  }

  get lastHelloProtocolVersions(): readonly number[] | undefined {
    return this.#lastHelloProtocolVersions
  }

  /** True iff the last hello echoed the prelude offer element-wise (index-by-index). */
  get helloEchoMatchesOffer(): boolean {
    return this.#helloEchoMatchesOffer
  }

  /**
   * Versions the peer actually received in the Noise prelude of the most
   * recent connection — the wire truth about what was offered.
   */
  get offeredVersionsAtHello(): readonly number[] {
    return this.#offeredVersionsAtHello
  }

  get helloCount(): number {
    return this.#methodCounts.get('connection.hello') ?? 0
  }

  get authenticateCount(): number {
    return this.#methodCounts.get('connection.authenticate') ?? 0
  }

  get refreshCount(): number {
    return this.#methodCounts.get('connection.refresh') ?? 0
  }

  get pingCount(): number {
    return this.#methodCounts.get('connection.ping') ?? 0
  }

  /** Arrivals of any method, by exact name (pairing face and future faces). */
  methodCount(method: string): number {
    return this.#methodCounts.get(method) ?? 0
  }

  /** Server-side record of every token issued (authenticate and refresh alike). */
  get tokenIssues(): readonly IssuedToken[] {
    return this.#tokenIssues
  }

  /** Wall-clock times of refresh calls, for "refreshed before expiry" assertions. */
  get refreshCalls(): readonly number[] {
    return this.#refreshCalls
  }

  /** The 6-digit code handed to the claiming device (undefined before a claim). */
  get verificationCode(): string | undefined {
    return this.#verificationCode
  }

  /** The invitation expiry the claim reported, ISO-8601. */
  get claimExpiresAt(): string | undefined {
    return this.#expiresAt
  }

  /** The access-token expiry bundled into the approved `pairing.get` reply. */
  get approvedTokenExpiresAt(): string | undefined {
    return this.#approvedTokenExpiresAt
  }

  /** The device id `pairing.get` hands out on the approved branch. */
  get approvedDeviceId(): string | undefined {
    return this.#approvedDeviceId
  }

  /** The access token bundled into the approved `pairing.get` reply. */
  get issuedAccessToken(): string | undefined {
    return this.#issuedAccessToken
  }

  /** Every `pairing.get` reply status, in arrival order. */
  get getStates(): readonly string[] {
    return this.#getStates
  }

  /** Params of the last `pairing.claim`, exactly as the peer received them. */
  get lastClaimDeviceName(): string | undefined {
    return this.#lastClaim?.['deviceName'] as string | undefined
  }

  get lastClaimPlatform(): string | undefined {
    return this.#lastClaim?.['platform'] as string | undefined
  }

  get lastClaimCapabilities(): readonly string[] | undefined {
    return this.#lastClaim?.['capabilities'] as readonly string[] | undefined
  }

  // -------------------------------------------------------------------------
  // Agent face observation + journal control (Task 7)
  // -------------------------------------------------------------------------

  /** Every subscribe request in arrival order, with the outcome replied. */
  get subscribeCalls(): readonly FakeSubscribeCall[] {
    return this.#subscribeCalls
  }

  /** Live peer-side subscription records, keyed by subscriptionId. */
  get subscriptions(): readonly FakeSubscriptionRecord[] {
    return [...this.#subscriptions.values()]
  }

  /** Phases of every subscription ever created, in creation order. */
  get subscriptionPhases(): readonly string[] {
    return this.#subscriptionPhases
  }

  get checkpointReadCalls(): readonly { subscriptionId: string; checkpointId: string; pageCursor: string | undefined }[] {
    return this.#checkpointReadCalls
  }

  get activateCalls(): readonly { subscriptionId: string; appliedCursor: AgentCursor; ok: boolean }[] {
    return this.#activateCalls
  }

  get ackCalls(): readonly { subscriptionId: string; cursor: AgentCursor }[] {
    return this.#ackCalls
  }

  /** Every `agent.subscriptions.close`, in arrival order (ordering evidence). */
  get closeCalls(): readonly { subscriptionId: string; sessionId: string | undefined }[] {
    return this.#closeCalls
  }

  /**
   * The peer's own call log across the agent-subscription faces, in arrival
   * order — the currency for "close was sent BEFORE the new subscribe" and
   * "pagination read + activate both landed inside the lease" assertions.
   */
  get agentCallSequence(): readonly string[] {
    return this.#agentCallSequence
  }

  /** Arrival time (ms since epoch) of each agent-face call, keyed the same way. */
  agentCallTimes(method: string): readonly number[] {
    return this.#agentCallTimestamps
      .filter((entry) => entry.method === method)
      .map((entry) => entry.at)
  }

  // -------------------------------------------------------------------------
  // Interactive command face observation (Task 9)
  // -------------------------------------------------------------------------

  /** Every command-face call in arrival order, with its params verbatim. */
  get commandCalls(): readonly { method: string; params: Record<string, unknown> }[] {
    return this.#commandCalls
  }

  /** The params of every call to one command-face method, in arrival order. */
  commandCallsFor(method: string): readonly Record<string, unknown>[] {
    return this.#commandCalls.filter((entry) => entry.method === method).map((entry) => entry.params)
  }

  /** Every command receipt the peer admitted, keyed by commandId. */
  get admittedCommands(): ReadonlyMap<string, FakeCommandRecord> {
    return this.#commands
  }

  /**
   * The receipt the peer recorded for `commandId`, or undefined. The currency
   * for "the same id with the same body replays the RECORDED receipt".
   */
  receiptFor(commandId: string): Record<string, unknown> | undefined {
    return this.#commands.get(commandId)?.receipt
  }

  /** Every terminal/non-terminal `execution.updated` the peer emitted, in order. */
  get executionUpdates(): readonly { executionId: string; status: string; messageId?: string }[] {
    return this.#executionUpdates
  }

  /** The interaction view the peer currently serves, in fixture order. */
  get interactions(): readonly FakeInteractionView[] {
    return this.#interactions.map((interaction) => this.#interactionView(interaction))
  }

  /** The session's active execution as the peer reports it (undefined = idle). */
  get activeExecutionId(): string | undefined {
    return this.#activeExecutionId
  }

  /** Flips one interaction's status without touching its revision. */
  setInteractionStatus(interactionId: string, status: FakeInteractionRecord['status']): void {
    const interaction = this.#interactions.find((entry) => entry.interactionId === interactionId)
    if (interaction === undefined) throw new Error(`no interaction ${interactionId}`)
    interaction.status = status
  }

  // -------------------------------------------------------------------------
  // Read-face observation (Task 8)
  // -------------------------------------------------------------------------

  /** Every read-face call in arrival order, with its params verbatim. */
  get readCalls(): readonly { method: string; params: Record<string, unknown> }[] {
    return this.#readCalls
  }

  /**
   * The params of every call to one read-face method, in arrival order — the
   * currency for "the per-page limit was clamped" and "the baseline revisions
   * were threaded through" assertions.
   */
  readCallsFor(method: string): readonly Record<string, unknown>[] {
    return this.#readCalls.filter((entry) => entry.method === method).map((entry) => entry.params)
  }

  /** Install a one-shot read-face failure (consumed by the first match). */
  setReadFailure(method: string, failure: FakeFailure | undefined): void {
    if (failure === undefined) this.#readFailNext.delete(method)
    else this.#readFailNext.set(method, failure)
  }

  /**
   * Corrupt one `{ref}` content: the stored bytes are replaced while the
   * digest the pin ADVERTISED stays as it was. A caller that trusts the bytes
   * without verifying sha256 therefore accepts corrupted text; a caller that
   * verifies rejects it. The advertised digest is deliberately NOT re-derived,
   * which is exactly the peer-side fault this check exists for.
   */
  tamperContent(contentId: string, revision: string, replacement = 'tampered'): void {
    const key = `${contentId}:${revision}`
    if (!this.#contentBytes.has(key)) throw new Error(`no externalized content ${key}`)
    this.#contentBytes.set(key, new TextEncoder().encode(replacement))
  }

  /**
   * Under-declare one `{ref}`'s `byteLength` — the peer-side lie that makes a
   * length-derived slice budget too small to ever reach `eof`. Models a peer
   * whose declared content size cannot be trusted. Callable BEFORE the part is
   * projected (the pins are created lazily on first projection).
   */
  understateContentLength(contentId: string, revision: string, declaredBytes: number): void {
    this.#contentByteOverrides.set(`${contentId}:${revision}`, declaredBytes)
  }

  /** The current journal watermark cursor for a session. */
  cursorFor(sessionId: string): AgentCursor {
    return { sessionId, streamEpoch: this.#journalEpoch, seq: String(this.#watermark) }
  }

  /**
   * Appends one event to a session journal and pushes an `agent.events`
   * notification to EVERY live subscriber of that session that is `active`.
   * Mirrors the peer's pump: one notification per batch, single event here.
   */
  pushEvent(sessionId: string, event: FakeAgentEvent): AgentCursor {
    this.#watermark += 1
    const seq = this.#watermark
    const journal = this.#journals.get(sessionId) ?? []
    journal.push({ seq, kind: event.kind, payload: event.payload })
    this.#journals.set(sessionId, journal)
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.sessionId !== sessionId || subscription.phase !== 'active') continue
      const params = {
        subscriptionId: subscription.subscriptionId,
        sessionId,
        streamEpoch: this.#journalEpoch,
        events: [{ kind: event.kind, seq: String(seq), payload: event.payload }],
      }
      this.#notify('agent.events', params)
    }
    return { sessionId, streamEpoch: this.#journalEpoch, seq: String(seq) }
  }

  /** Appends several events at once, delivering them as ONE notification batch. */
  pushEventBatch(sessionId: string, events: readonly FakeAgentEvent[]): AgentCursor {
    for (const event of events) {
      this.#watermark += 1
      const journal = this.#journals.get(sessionId) ?? []
      journal.push({ seq: this.#watermark, kind: event.kind, payload: event.payload })
      this.#journals.set(sessionId, journal)
    }
    const cursor = this.cursorFor(sessionId)
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.sessionId !== sessionId || subscription.phase !== 'active') continue
      const batch = events.map((event, index) => ({
        kind: event.kind,
        seq: String(this.#watermark - events.length + 1 + index),
        payload: event.payload,
      }))
      this.#notify('agent.events', {
        subscriptionId: subscription.subscriptionId,
        sessionId,
        streamEpoch: this.#journalEpoch,
        events: batch,
      })
    }
    return cursor
  }

  /**
   * Pushes `agent.subscriptions.resetRequired` for a live subscription — the
   * peer does this when the replay suffix is no longer retained (see
   * `AgentSubscriptions.reset`), which is the signal that forces a re-subscribe.
   */
  pushResetRequired(
    sessionId: string,
    reason: 'RESET_REQUIRED' | 'CHECKPOINT_EXPIRED' | 'RESOURCE_EXHAUSTED' = 'RESET_REQUIRED',
  ): void {
    const subscription = [...this.#subscriptions.values()].find(
      (entry) => entry.sessionId === sessionId && entry.phase === 'active',
    )
    if (subscription === undefined) throw new Error(`no active subscription for ${sessionId}`)
    subscription.phase = 'reset'
    this.#subscriptions.delete(subscription.subscriptionId)
    this.#notify('agent.subscriptions.resetRequired', { subscriptionId: subscription.subscriptionId, reason })
  }

  /** Pushes an arbitrary notification — the unknown-method consumer-side probe. */
  pushNotification(method: string, params: unknown): void {
    this.#notify(method, params)
  }

  /** The sessionId a subscriptionId belongs to, or undefined once it was closed. */
  sessionOf(subscriptionId: string): string | undefined {
    return this.#subscriptions.get(subscriptionId)?.sessionId
  }

  /**
   * The PREPARED cursor the peer holds for a subscription — the exact value
   * `agent.subscriptions.activate` must echo back in `appliedCursor`.
   */
  checkpointCursorOf(subscriptionId: string): AgentCursor | undefined {
    return this.#checkpointCursorBySubscription.get(subscriptionId)
  }

  async start(): Promise<{ host: string; port: number }> {
    const identity = await this.#identity
    const server = new WebSocketServer({ host: this.#options.bindHost ?? '127.0.0.1', port: 0 })
    this.#server = server
    server.on('connection', (socket) => {
      this.#socketCount += 1
      socket.on('close', () => this.#socketCloseTimes.push(performance.now()))
      this.#handleSocket(socket, identity)
    })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const { address: host, port } = server.address() as AddressInfo
    return { host, port }
  }

  /** Closes every live client socket with the given code (disconnect injection). */
  injectClose(code: 1000 | 1011 | 1013, reason = 'injected'): void {
    for (const { socket } of this.#live) socket.close(code, reason)
  }

  setRefreshFailure(failure: FakeFailure | undefined): void {
    this.#refreshFailure = failure
  }

  setAuthenticateFailure(failure: FakeFailure | undefined): void {
    this.#authenticateFailure = failure
  }

  setDropPings(drop: boolean): void {
    this.#dropPings = drop
  }

  async stop(): Promise<void> {
    for (const { socket, controller } of this.#live) {
      controller.abort()
      socket.terminate()
    }
    this.#live = []
    const server = this.#server
    this.#server = undefined
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  /**
   * Writes one JSON-RPC notification (no id) to every live connection. The
   * real peer's `send` is connection-scoped; every test here runs a single
   * client, so fanning out keeps the fake honest without modelling ownership.
   */
  #notify(method: string, params: unknown): void {
    const frame = { jsonrpc: '2.0', method, params }
    for (const { channel } of this.#live) {
      void channel.write(frame).catch(() => {
        // The client vanished mid-notification; nothing to do.
      })
    }
  }

  #handleSocket(socket: WebSocket, identity: Uint8Array): void {
    const controller = new AbortController()
    const stream = new RemoteSocketStream(toRemoteSocket(socket), componentLogger.forComponent('fake'), 'inbound')
    void acceptSecureChannel(stream, {
      identity,
      logger: componentLogger,
      protocolVersions: this.#options.protocolVersions ?? DEFAULT_PROTOCOL_VERSIONS,
      signal: controller.signal,
    })
      .then((channel) => {
        this.#connectionCount += 1
        const live: LiveConnection = { socket, channel, controller, hello: false }
        this.#live.push(live)
        void this.#serve(live)
      })
      .catch(() => {
        // Handshake failed (pin mismatch, bad prelude, abort): the transport
        // already tore the socket down; nothing to record beyond socketCount.
      })
  }

  async #serve(live: LiveConnection): Promise<void> {
    try {
      for (;;) {
        const frame = await live.channel.read()
        if (typeof frame === 'object' && frame !== null) {
          // Dispatch without awaiting: a delayed handler must not stall the loop.
          void this.#dispatch(live, frame as Record<string, unknown>)
        }
      }
    } catch {
      // Channel closed; RemoteSocketStream already cleaned the socket up.
    } finally {
      this.#live = this.#live.filter((entry) => entry !== live)
    }
  }

  async #dispatch(live: LiveConnection, frame: Record<string, unknown>): Promise<void> {
    if (typeof frame.method !== 'string' || frame.id === undefined) return
    const method = frame.method
    const params = parseParams(method, frame.params)
    this.#countArrival(method)
    if (method === 'connection.hello' && Array.isArray(params?.['protocolVersions'])) {
      this.#lastHelloProtocolVersions = [...(params['protocolVersions'] as number[])]
    }

    this.#inFlight += 1
    if (this.#inFlight > this.#maxInFlight) this.#maxInFlight = this.#inFlight
    try {
      if (this.#rateLimited(live)) return // session terminated; nothing further to say

      if (method === 'connection.ping' && this.#dropPings) {
        // Accepted, counted, never answered: the client's silence window judges.
        return
      }

      if (params === undefined) {
        await this.#reply(live, frame.id, undefined, {
          reason: 'INVALID_CONNECTION_STATE',
          message: `malformed params for ${method}`,
        })
        return
      }

      try {
        const result = await this.#handleMethod(live, method, params)
        await this.#reply(live, frame.id, result)
      } catch (error) {
        const failure =
          error instanceof FakeRpcError ? error.failure : { reason: 'INTERNAL', message: String(error) }
        await this.#reply(live, frame.id, undefined, failure)
      }
    } finally {
      this.#inFlight -= 1
    }
  }

  async #handleMethod(
    live: LiveConnection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.#options.requestDelayMs !== undefined) await sleep(this.#options.requestDelayMs)
    switch (method) {
      case 'connection.hello':
        return this.#handleHello(live)
      case 'connection.authenticate':
        return this.#handleAuthenticate(params)
      case 'connection.refresh':
        return this.#handleRefresh()
      case 'connection.ping':
        return { nonce: params['nonce'], serverTime: new Date().toISOString() }
      case 'pairing.claim':
        return this.#handlePairingClaim(params, live)
      case 'pairing.get':
        return this.#handlePairingGet(params, live)
      case 'agent.sessions.subscribe':
        return this.#handleAgentSubscribe(params)
      case 'agent.agents.list':
      case 'agent.workspaces.list':
      case 'agent.sessions.list':
      case 'agent.sessions.get':
      case 'agent.messages.list':
      case 'agent.parts.list':
      case 'agent.content.read':
        return this.#handleRead(method, params)
      case 'agent.sessions.create':
      case 'agent.messages.send':
      case 'agent.executions.cancel':
      case 'agent.interactions.list':
      case 'agent.interactions.get':
      case 'agent.interactions.respond':
      case 'agent.commands.get':
        return this.#handleCommand(method, params)
      case 'agent.checkpoints.read':
        return await this.#handleCheckpointRead(params)
      case 'agent.subscriptions.activate':
        return this.#handleActivate(params)
      case 'agent.subscriptions.ack':
        return this.#handleAck(params)
      case 'agent.subscriptions.close':
        return this.#handleClose(params)
      default:
        throw new FakeRpcError({ reason: 'NOT_FOUND', message: `unknown method ${method}` })
    }
  }

  /** The real desktop's gate: pairing/authenticate require a confirmed hello. */
  #requireHello(live: LiveConnection): void {
    if (!live.hello) {
      throw new FakeRpcError({ reason: 'INVALID_CONNECTION_STATE', message: 'Hello is required' })
    }
  }

  #handleHello(live: LiveConnection): Record<string, unknown> {
    const offered = [...live.channel.offeredVersions]
    this.#offeredVersionsAtHello = offered
    const echoed = this.#lastHelloProtocolVersions
    // Ruling: the peer compares the hello echo against the prelude offer
    // INDEX BY INDEX (length and position). Set equality is not enough — a
    // permuted echo must fail even though it holds the same set.
    this.#helloEchoMatchesOffer =
      echoed !== undefined && echoed.length === offered.length && echoed.every((v, i) => v === offered[i])
    if (!this.#helloEchoMatchesOffer) {
      throw new FakeRpcError({
        reason: 'INVALID_CONNECTION_STATE',
        message: 'hello protocolVersions must equal the handshake offer element-wise',
      })
    }
    live.hello = true
    const hello = this.#options.hello ?? {}
    return {
      protocolVersion: live.channel.protocolVersion,
      ...(hello.omitLimits ? {} : { limits: hello.limits ?? {} }),
      ...(hello.omitHeartbeatMs ? {} : { heartbeatMs: hello.heartbeatMs ?? 20_000 }),
    }
  }

  #handleAuthenticate(params: Record<string, unknown>): Record<string, unknown> {
    if (this.#authenticateFailure !== undefined) throw new FakeRpcError(this.#authenticateFailure)
    const token = this.#issueToken()
    return {
      authorization: { grants: [{ domain: 'agent', grantId: 'grant-1' }] },
      accessToken: token.token,
      expiresAt: new Date(token.expiresAt).toISOString(),
      deviceId: params['deviceId'],
    }
  }

  #handleRefresh(): Record<string, unknown> {
    this.#refreshCalls.push(Date.now())
    if (this.#refreshFailure !== undefined) throw new FakeRpcError(this.#refreshFailure)
    const token = this.#issueToken()
    return {
      authorization: { grants: [{ domain: 'agent', grantId: 'grant-1' }] },
      accessToken: token.token,
      expiresAt: new Date(token.expiresAt).toISOString(),
    }
  }

  #issueToken(): IssuedToken {
    const at = Date.now()
    const issued: IssuedToken = {
      token: `tok-${randomUUID()}`,
      at,
      expiresAt: at + (this.#options.tokenTtlMs ?? 600_000),
    }
    this.#tokenIssues.push(issued)
    return issued
  }

  /**
   * `pairing.claim` — the minimal claim face: while the claim is held it is
   * SCOPED TO ITS CLAIMING PEER (ruling 5), so a second, unauthenticated
   * connection to the same pairing invitation cannot claim it.
   *
   * The receipt carries ONLY claimId/verificationCode/expiresAt, exactly like
   * the real desktop: device identity and grants come from the approved
   * `pairing.get` branch alone.
   */
  #handlePairingClaim(params: Record<string, unknown>, live: LiveConnection): Record<string, unknown> {
    // The real desktop answers INVALID_CONNECTION_STATE without a confirmed
    // hello; the pairing client must therefore run the hello face too.
    this.#requireHello(live)
    const claimedBy = this.#claimPeerIdentity
    if (claimedBy !== undefined && claimedBy !== live.channel.remoteIdentity) {
      throw new FakeRpcError({ reason: 'CONFLICT', message: 'Invitation already claimed' })
    }
    this.#claimPeerIdentity = live.channel.remoteIdentity
    this.#lastClaim = { ...params }
    this.#verificationCode ??= String(randomInt(1_000_000)).padStart(6, '0')
    this.#expiresAt ??= new Date(Date.now() + INVITATION_MS).toISOString()
    return {
      claimId: CLAIM_ID,
      verificationCode: this.#verificationCode,
      expiresAt: this.#expiresAt,
    }
  }

  /**
   * `pairing.get` — `pending` for `pairingGetPendingPolls` calls, then the
   * configured terminal state. The approved branch is the ONLY source of
   * deviceId/grants/accessToken.
   */
  #handlePairingGet(params: Record<string, unknown>, live: LiveConnection): Record<string, unknown> {
    this.#requireHello(live)
    if (params['claimId'] !== CLAIM_ID) {
      throw new FakeRpcError({ reason: 'NOT_FOUND', message: 'unknown claimId' })
    }
    this.#getStates.push('pending')
    const decision = this.#options.pairingDecision
    const pendingPolls = this.#options.pairingGetPendingPolls ?? 0
    if (decision === undefined || this.#getStates.length <= pendingPolls) return { status: 'pending' }
    if (decision !== 'approved') {
      this.#getStates[this.#getStates.length - 1] = decision
      return { status: decision }
    }
    this.#getStates[this.#getStates.length - 1] = 'approved'
    this.#approvedDeviceId ??= `dev-${randomUUID()}`
    const token = this.#issueToken()
    this.#issuedAccessToken = token.token
    this.#approvedTokenExpiresAt = new Date(token.expiresAt).toISOString()
    const grants = (this.#options.approvedGrants ?? ['agent']).map((domain) => ({
      domain,
      grantId: `grant-${domain}`,
    }))
    return {
      status: 'approved',
      deviceId: this.#approvedDeviceId,
      authorization: { grants },
      accessToken: token.token,
      expiresAt: this.#approvedTokenExpiresAt,
    }
  }

  #countArrival(method: string): void {
    this.#requestCount += 1
    this.#requestTimestamps.push(Date.now())
    this.#methodCounts.set(method, (this.#methodCounts.get(method) ?? 0) + 1)
    if (method.startsWith('agent.')) {
      this.#agentCallSequence.push(method)
      this.#agentCallTimestamps.push({ method, at: Date.now() })
    }
  }

  // -------------------------------------------------------------------------
  // Agent face (Task 7) — ported from the real peer
  // -------------------------------------------------------------------------

  #agent(): FakeAgentOptions {
    return this.#options.agent ?? {}
  }

  /**
   * `agent.sessions.subscribe`, faithful to `AgentSubscriptions.subscribe`:
   * a same-session subscription that is NOT in `reset` phase is CONFLICT, the
   * cap is `subscriptionLimit` (RESOURCE_EXHAUSTED beyond it), and the mode is
   * decided by the requested cursor — absent / epoch-changed / ahead of the
   * watermark / evicted past `firstRetainedSeq` all fall to `checkpoint`.
   */
  #handleAgentSubscribe(params: Record<string, unknown>): Record<string, unknown> {
    const sessionId = params['sessionId'] as string
    const cursor = params['cursor'] as AgentCursor | undefined

    for (const existing of this.#subscriptions.values()) {
      if (existing.sessionId === sessionId && existing.phase !== 'reset') {
        this.#subscribeCalls.push({ sessionId, cursor, mode: 'error', reason: 'CONFLICT' })
        throw new FakeRpcError({
          reason: 'CONFLICT',
          message: 'Session already has a subscription on this connection',
        })
      }
    }
    const limit = this.#agent().subscriptionLimit ?? remoteLimits.subscriptions
    if (this.#subscriptions.size >= limit) {
      this.#subscribeCalls.push({ sessionId, cursor, mode: 'error', reason: 'RESOURCE_EXHAUSTED' })
      throw new FakeRpcError({ reason: 'RESOURCE_EXHAUSTED', message: 'Too many subscriptions' })
    }

    const subscriptionId = randomUUID()
    const currentSeq = this.#watermark
    const firstRetained = this.#agent().firstRetainedSeq ?? 1
    const reason = this.#agent().forceCheckpointMode
      ? 'forced checkpoint'
      : cursor === undefined
        ? 'no cursor'
        : cursor.sessionId !== sessionId || cursor.streamEpoch !== this.#journalEpoch
          ? 'epoch changed'
          : Number(cursor.seq) > currentSeq
            ? 'cursor ahead of watermark'
            : Number(cursor.seq) + 1 < firstRetained
              ? 'replay window evicted'
              : undefined

    if (cursor !== undefined && reason === undefined) {
      const record: FakeSubscriptionRecord = {
        subscriptionId,
        sessionId,
        phase: 'active',
        cursorSeq: Number(cursor.seq),
        lastAck: Number(cursor.seq),
      }
      this.#subscriptions.set(subscriptionId, record)
      this.#subscriptionPhases.push('active')
      this.#subscribeCalls.push({ sessionId, cursor, mode: 'replay', subscriptionId })
      return {
        subscriptionId,
        mode: 'replay',
        fromCursor: cursor,
        highWatermark: this.cursorFor(sessionId),
        leaseExpiresAt: new Date(Date.now() + (this.#agent().checkpointMs ?? remoteLimits.checkpointMs)).toISOString(),
      }
    }

    // Checkpoint mode: the descriptor cursor IS the session watermark at
    // capture, and the lease starts NOW.
    const checkpointCursor = this.cursorFor(sessionId)
    const checkpointId = randomUUID()
    const pages = this.#buildCheckpointPages(sessionId, checkpointId)
    this.#storedCheckpoints.set(checkpointId, { descriptor: checkpointCursor, pages })
    this.#checkpointCursorBySubscription.set(subscriptionId, checkpointCursor)
    this.#checkpointSequences.set(
      subscriptionId,
      pages.map((page) => page.nextCursor ?? ''),
    )
    this.#leaseDeadlines.set(
      subscriptionId,
      Date.now() + (this.#agent().checkpointMs ?? remoteLimits.checkpointMs),
    )
    this.#subscriptions.set(subscriptionId, {
      subscriptionId,
      sessionId,
      phase: 'prepared',
      cursorSeq: Number(checkpointCursor.seq),
      lastAck: Number(checkpointCursor.seq),
    })
    this.#subscriptionPhases.push('prepared')
    this.#subscribeCalls.push({ sessionId, cursor, mode: 'checkpoint', reason, subscriptionId })
    return {
      subscriptionId,
      mode: 'checkpoint',
      reason: reason ?? 'no cursor',
      checkpoint: {
        checkpointId,
        cursor: checkpointCursor,
        historyRevision: 'rev-1',
        pageCount: pages.length,
        byteLength: '0',
        sha256: '0'.repeat(64),
        expiresAt: new Date(this.#leaseDeadlines.get(subscriptionId)!).toISOString(),
      },
    }
  }

  /**
   * The projection pages a checkpoint carries. The real peer flushes whenever
   * a page fills (100 items or a byte ceiling), so a checkpoint of the state
   * this fake models has at least TWO pages whenever there is state to carry:
   * page 0 with `nextCursor: '1'`, page 1 with `nextCursor: null`. Two pages
   * make the recovery chain's PAGINATION loop genuinely exercised rather than
   * satisfied by a single read.
   */
  #buildCheckpointPages(sessionId: string, checkpointId: string): AgentCheckpointPage[] {
    const journal = this.#journals.get(sessionId) ?? []
    const session = {
      sessionId,
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      title: 't',
      updatedAt: new Date().toISOString(),
      historyRevision: 'rev-1',
    }
    const executions: Array<{ kind: 'execution'; value: unknown }> = journal.map((entry) => ({
      kind: 'execution' as const,
      value: { executionId: `exec-${entry.seq}`, status: 'running' as const },
    }))
    // Page 0 always carries the session snapshot; page 1 carries the rest of
    // the projection state (executions and beyond), so pagination always runs.
    const firstPage: AgentCheckpointPage = {
      checkpointId,
      pageIndex: 0,
      items: [{ kind: 'session', value: session as never }],
      nextCursor: '1',
      pageDigest: '0'.repeat(64),
    }
    const secondPage: AgentCheckpointPage = {
      checkpointId,
      pageIndex: 1,
      items: [
        ...(executions as never[]),
        { kind: 'interaction', value: { interactionId: 'i1', revision: '1' } } as never,
      ],
      nextCursor: null,
      pageDigest: '0'.repeat(64),
    }
    return [firstPage, secondPage]
  }

  /**
   * `agent.checkpoints.read`: requires a PREPARED subscription whose lease is
   * still live; pagination is driven by `pageCursor` (an index string), and
   * `nextCursor` is a PAGE cursor — never a stream cursor.
   */
  async #handleCheckpointRead(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const subscriptionId = params['subscriptionId'] as string
    const checkpointId = params['checkpointId'] as string
    const pageCursor = params['pageCursor'] as string | undefined
    this.#checkpointReadCalls.push({ subscriptionId, checkpointId, pageCursor })
    const delay = this.#agent().checkpointReadDelayMs
    const delayCalls = this.#agent().checkpointReadDelayCalls
    if (delay !== undefined && (delayCalls === undefined || this.#checkpointReadCalls.length <= delayCalls)) {
      await sleep(delay)
    }
    this.#consumeInjectedCheckpointFailure()

    const subscription = this.#subscriptions.get(subscriptionId)
    const stored = this.#storedCheckpoints.get(checkpointId)
    if (
      subscription === undefined ||
      subscription.phase !== 'prepared' ||
      stored === undefined
    ) {
      throw new FakeRpcError({ reason: 'NOT_FOUND', message: 'Checkpoint is not available' })
    }
    if ((this.#leaseDeadlines.get(subscriptionId) ?? 0) <= Date.now()) {
      this.#resetSubscription(subscription, 'CHECKPOINT_EXPIRED')
      throw new FakeRpcError({ reason: 'CHECKPOINT_EXPIRED', message: 'Checkpoint lease expired' })
    }
    const index = pageCursor === undefined ? 0 : Number(pageCursor)
    const page = Number.isSafeInteger(index) ? stored.pages[index] : undefined
    if (page === undefined) throw new FakeRpcError({ reason: 'NOT_FOUND', message: 'Checkpoint page not found' })
    return page as unknown as Record<string, unknown>
  }

  /**
   * `agent.subscriptions.activate`: `appliedCursor` must equal the prepared
   * cursor in ALL THREE fields, and the lease must still be live — otherwise
   * CHECKPOINT_EXPIRED (lease) or CONFLICT (cursor mismatch), exactly like the
   * real peer. A mismatch is surfaced, never silently accepted.
   */
  #handleActivate(params: Record<string, unknown>): Record<string, unknown> {
    const subscriptionId = params['subscriptionId'] as string
    const appliedCursor = params['appliedCursor'] as AgentCursor
    this.#consumeInjectedCheckpointFailure()
    const subscription = this.#subscriptions.get(subscriptionId)
    if (subscription === undefined) {
      this.#activateCalls.push({ subscriptionId, appliedCursor, ok: false })
      throw new FakeRpcError({ reason: 'NOT_FOUND', message: 'Unknown subscription' })
    }
    if (subscription.phase !== 'prepared') {
      this.#activateCalls.push({ subscriptionId, appliedCursor, ok: false })
      throw new FakeRpcError({ reason: 'CONFLICT', message: 'Subscription is not awaiting activation' })
    }
    if ((this.#leaseDeadlines.get(subscriptionId) ?? 0) <= Date.now()) {
      this.#activateCalls.push({ subscriptionId, appliedCursor, ok: false })
      this.#resetSubscription(subscription, 'CHECKPOINT_EXPIRED')
      throw new FakeRpcError({ reason: 'CHECKPOINT_EXPIRED', message: 'Preparation lease expired' })
    }
    const prepared = this.#checkpointCursorBySubscription.get(subscriptionId)
    // THREE-FIELD equality: sessionId / streamEpoch / seq, one by one.
    const matches =
      prepared !== undefined &&
      appliedCursor.sessionId === prepared.sessionId &&
      appliedCursor.streamEpoch === prepared.streamEpoch &&
      Number(appliedCursor.seq) === Number(prepared.seq)
    if (!matches) {
      this.#activateCalls.push({ subscriptionId, appliedCursor, ok: false })
      throw new FakeRpcError({ reason: 'CONFLICT', message: 'Applied cursor does not match the prepared cursor' })
    }
    subscription.phase = 'active'
    subscription.cursorSeq = Number(prepared.seq)
    subscription.lastAck = Number(prepared.seq)
    this.#subscriptionPhases.push('active')
    this.#activateCalls.push({ subscriptionId, appliedCursor, ok: true })
    return { subscriptionId, status: 'active' }
  }

  /** `agent.subscriptions.ack`: only an ACTIVE subscription, within the window. */
  #handleAck(params: Record<string, unknown>): Record<string, unknown> {
    const subscriptionId = params['subscriptionId'] as string
    const cursor = params['cursor'] as AgentCursor
    this.#ackCalls.push({ subscriptionId, cursor })
    const subscription = this.#subscriptions.get(subscriptionId)
    const seq = Number(cursor.seq)
    if (
      subscription === undefined ||
      subscription.phase !== 'active' ||
      cursor.sessionId !== subscription.sessionId ||
      cursor.streamEpoch !== this.#journalEpoch ||
      seq < subscription.lastAck ||
      seq > this.#watermark
    ) {
      throw new FakeRpcError({ reason: 'CONFLICT', message: 'Cursor is outside the delivered window' })
    }
    subscription.lastAck = seq
    return {
      acknowledged: { sessionId: subscription.sessionId, streamEpoch: this.#journalEpoch, seq: String(seq) },
    }
  }

  /** `agent.subscriptions.close`: `reset` phase + removal, per the real peer. */
  #handleClose(params: Record<string, unknown>): Record<string, unknown> {
    const subscriptionId = params['subscriptionId'] as string
    const subscription = this.#subscriptions.get(subscriptionId)
    this.#closeCalls.push({ subscriptionId, sessionId: subscription?.sessionId })
    if (subscription !== undefined) {
      subscription.phase = 'reset'
      this.#subscriptionPhases.push('reset')
      this.#subscriptions.delete(subscriptionId)
      this.#leaseDeadlines.delete(subscriptionId)
      this.#checkpointSequences.delete(subscriptionId)
      this.#checkpointCursorBySubscription.delete(subscriptionId)
    }
    return { closed: true }
  }

  /** The peer's `reset`: close + a `resetRequired` notification. */
  #resetSubscription(subscription: FakeSubscriptionRecord, reason: string): void {
    subscription.phase = 'reset'
    this.#subscriptionPhases.push('reset')
    this.#subscriptions.delete(subscription.subscriptionId)
    this.#leaseDeadlines.delete(subscription.subscriptionId)
    this.#notify('agent.subscriptions.resetRequired', { subscriptionId: subscription.subscriptionId, reason })
  }

  // -------------------------------------------------------------------------
  // Read face (Task 8) — ported from the real peer's `agentQueries.ts` /
  // `agentHandlers.ts`: the same `pageOf` cursor arithmetic (a numeric offset
  // string, clamped to `remoteLimits.pageItems`), the same
  // REVISION_EXPIRED-on-stale-revision rule for `messages.list`/`parts.list`,
  // the same INLINE_TEXT_LIMIT / `{ref}` / sha256-over-the-whole-content
  // externalization for `content.read`.
  // -------------------------------------------------------------------------

  /** One read-face call: inject a failure, then serve the ported semantics. */
  #handleRead(method: string, params: Record<string, unknown>): Record<string, unknown> {
    this.#readCalls.push({ method, params })
    const always = this.#agent().failAlways?.[method]
    if (always !== undefined) throw new FakeRpcError(always)
    const once = this.#readFailNext.get(method)
    if (once !== undefined) {
      this.#readFailNext.delete(method)
      throw new FakeRpcError(once)
    }
    switch (method) {
      case 'agent.agents.list':
        return this.#page(
          (this.#agent().agents ?? []).map((agent) => ({
            agentId: agent.agentId,
            name: agent.name,
            ...(agent.emoji === undefined ? {} : { emoji: agent.emoji }),
            model: agent.model ?? null,
          })),
          params,
        )
      case 'agent.workspaces.list': {
        const agentId = params['agentId'] as string
        if (!(this.#agent().agents ?? []).some((agent) => agent.agentId === agentId)) {
          throw new FakeRpcError({ reason: 'NOT_FOUND', message: 'Agent not found' })
        }
        return { ...this.#page(this.#agent().workspaces ?? [], params), systemWorkspace: true }
      }
      case 'agent.sessions.list': {
        const agentId = params['agentId'] as string | undefined
        const workspaceId = params['workspaceId'] as string | undefined
        const items = (this.#agent().sessions ?? []).filter(
          (session) =>
            (agentId === undefined || session.agentId === agentId) &&
            (workspaceId === undefined || session.workspaceId === workspaceId),
        )
        return this.#page(items.map((session) => this.#sessionSummary(session)), params)
      }
      case 'agent.sessions.get': {
        const session = this.#requireSession(params['sessionId'] as string)
        return { session: this.#sessionSummary(session) }
      }
      case 'agent.messages.list':
        return this.#handleMessagesList(params)
      case 'agent.parts.list':
        return this.#handlePartsList(params)
      default:
        return this.#handleContentRead(params)
    }
  }

  /** The protocol's session summary, including the `workspaceKind` discriminator. */
  #sessionSummary(session: FakeSessionRecord): Record<string, unknown> {
    // The LIVE active execution wins over the fixture's static field: an
    // accepted run really does make the session busy, and its terminal event
    // really does return it to idle (the real `toSessionSummary(…, activeExecutionId)`).
    const activeExecutionId = this.#activeExecutionId ?? session.activeExecutionId
    return {
      sessionId: session.sessionId,
      agentId: session.agentId,
      workspaceId: session.workspaceId,
      workspaceKind: session.workspaceKind ?? 'registered',
      title: session.title,
      updatedAt: session.updatedAt ?? new Date(0).toISOString(),
      historyRevision: session.historyRevision,
      ...(activeExecutionId === undefined
        ? { idleRevision: session.historyRevision }
        : { activeExecutionId }),
    }
  }

  #requireSession(sessionId: string): FakeSessionRecord {
    const session = (this.#agent().sessions ?? []).find((entry) => entry.sessionId === sessionId)
    if (session === undefined) throw new FakeRpcError({ reason: 'NOT_FOUND', message: 'Resource not found' })
    return session
  }

  /**
   * The real `listMessages`: a `historyRevision` that no longer matches the
   * session's current one is REVISION_EXPIRED, which is exactly what makes the
   * caller re-pull the baseline.
   */
  #handleMessagesList(params: Record<string, unknown>): Record<string, unknown> {
    const session = this.#requireSession(params['sessionId'] as string)
    if (session.historyRevision !== params['historyRevision']) {
      throw new FakeRpcError({ reason: 'REVISION_EXPIRED', message: 'History revision expired' })
    }
    const messages = (this.#agent().messages ?? []).map((message) => ({
      messageId: message.messageId,
      revision: message.revision,
      role: message.role,
      partIds: message.parts.map((_part, index) => `${message.messageId}:${index}`),
      status: message.status,
    }))
    return this.#page(messages, params)
  }

  /** The real `listParts`: a stale `messageRevision` is REVISION_EXPIRED. */
  #handlePartsList(params: Record<string, unknown>): Record<string, unknown> {
    this.#requireSession(params['sessionId'] as string)
    const messages = this.#agent().messages ?? []
    const message = messages.find((entry) => entry.messageId === params['messageId'])
    if (message === undefined) throw new FakeRpcError({ reason: 'NOT_FOUND', message: 'Resource not found' })
    if (message.revision !== params['messageRevision']) {
      throw new FakeRpcError({ reason: 'REVISION_EXPIRED', message: 'Message revision expired' })
    }
    const parts = message.parts.map((part, index) => this.#part(message.messageId, index, part))
    return this.#page(parts, params)
  }

  /**
   * Project one part fixture onto the wire. Text above the peer's inline limit
   * (or a fixture that asks for it) becomes a `{ref}`; the ref's byteLength and
   * sha256 describe the FULL content, and the bytes themselves are held for
   * `agent.content.read` to slice.
   */
  #part(messageId: string, index: number, part: FakePartRecord): Record<string, unknown> {
    const partId = `${messageId}:${index}`
    const revision = this.#revisionFor(messageId)
    const bytes = new TextEncoder().encode(part.text)
    const external = part.external === true || part.text.length > INLINE_TEXT_LIMIT
    const digest = sha256Hex(bytes)
    const key = `${partId}:${revision}`
    // Content pins are IMMUTABLE once created (the real peer pins them when the
    // part is projected and re-serves the same bytes thereafter), so a tamper
    // survives re-listing the parts.
    const pinned = this.#contentBytes.has(key)
    const advertised = this.#contentDigests.get(key) ?? digest
    const declaredBytes = this.#contentByteOverrides.get(key) ?? bytes.length
    const content = external
      ? {
          ref: {
            contentId: partId,
            revision,
            byteLength: String(declaredBytes),
            mediaType: 'text/plain',
            sha256: advertised,
          },
        }
      : { text: part.text }
    if (!pinned) {
      this.#contentBytes.set(key, bytes)
      this.#contentDigests.set(key, digest)
    }
    return {
      partId,
      revision,
      kind: part.kind,
      content,
      ...(part.kind === 'tool-input' || part.kind === 'tool-output'
        ? { toolName: part.toolName ?? 'tool', ...(part.toolCallId === undefined ? {} : { toolCallId: part.toolCallId }) }
        : {}),
      ...(part.kind === 'file' || part.kind === 'data' ? { name: part.name ?? 'file' } : {}),
      ...(part.kind === 'text' || part.kind === 'reasoning' || part.kind === 'tool-input'
        ? { state: part.state ?? 'completed' }
        : part.kind === 'tool-output'
          ? { state: part.state ?? 'completed' }
          : {}),
    }
  }

  #revisionFor(messageId: string): string {
    return (this.#agent().messages ?? []).find((entry) => entry.messageId === messageId)?.revision ?? '0'
  }

  /**
   * `agent.content.read`, faithful to `sliceContent`: `offset` is a numeric
   * string, the slice is capped by `maxBytes`, `eof` says whether the slice
   * reached the end, and `sha256` is the digest of the WHOLE content — the
   * caller's verification target.
   */
  #handleContentRead(params: Record<string, unknown>): Record<string, unknown> {
    const contentId = params['contentId'] as string
    const revision = params['revision'] as string
    const bytes = this.#contentBytes.get(`${contentId}:${revision}`)
    if (bytes === undefined) throw new FakeRpcError({ reason: 'NOT_FOUND', message: 'Content not found' })
    const start = Number(params['offset'])
    if (!Number.isSafeInteger(start) || start < 0 || start > bytes.length) {
      throw new FakeRpcError({ reason: 'NOT_FOUND', message: 'Offset exceeds content length' })
    }
    const maxBytes = params['maxBytes'] as number
    const slice = bytes.subarray(start, start + maxBytes)
    return {
      contentId,
      revision,
      offset: params['offset'],
      dataBase64: Buffer.from(slice).toString('base64'),
      nextOffset: String(start + slice.length),
      eof: start + slice.length === bytes.length,
      // The digest recorded with the pin, NOT re-derived from the bytes on
      // hand — that is exactly what makes a mutation detectable.
      sha256: this.#contentDigests.get(`${contentId}:${revision}`) ?? sha256Hex(bytes),
    }
  }

  /** The real `pageOf`: a numeric-offset cursor, clamped to the protocol cap. */
  #page<T>(items: readonly T[], params: Record<string, unknown>): { items: T[]; nextCursor: string | null } {
    // Peer-fault face: an empty page that still claims more are coming.
    const dangling = this.#agent().emptyPagesWithDanglingCursor
    if (dangling !== undefined) return { items: [], nextCursor: dangling }
    const start = params['cursor'] === undefined ? 0 : Number(params['cursor'])
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new FakeRpcError({ reason: 'NOT_FOUND', message: 'Invalid page cursor' })
    }
    // Peer-fault face: a cursor that never advances. The page is served
    // normally, but it always advertises the same stuck position.
    const stuck = this.#agent().stuckCursor
    if (stuck !== undefined && start > 0) {
      const replay = items.slice(0, Math.max(1, Math.min(Number(stuck) || 1, items.length))) as T[]
      return { items: replay, nextCursor: stuck }
    }
    const requested = (params['limit'] as number | undefined) ?? this.#agent().defaultPageSize ?? 20
    // Two independent ceilings: the protocol's own page cap, and a peer that
    // pages smaller than the cap. The effective page is the smaller of the two.
    const ceiling = Math.min(remoteLimits.pageItems, this.#agent().maxPageSize ?? remoteLimits.pageItems)
    const limit = Math.max(1, Math.min(requested, ceiling))
    const end = start + limit
    return { items: items.slice(start, end), nextCursor: end < items.length ? String(end) : null }
  }

  // -------------------------------------------------------------------------
  // Interactive command face (Task 9) — ported from the real peer's
  // `agentHandlers.ts` (`command()`'s idempotency ledger, `interactionsOf`'s
  // unfiltered merge, the respond answer/approve contracts, the cancel
  // active-execution precondition) and `agentJournal.ts`'s event payloads.
  // -------------------------------------------------------------------------

  /**
   * The idempotency ledger, faithful to `remoteCommandService.admit` + the
   * `command()` wrapper: the FIRST call for a commandId runs the body and
   * records the outcome; a REPLAY with the same body returns the recorded
   * receipt (the owner runs at most once, which is what makes Task 9⑮'s
   * same-id/same-answer assertion possible); a replay with a DIFFERENT body is
   * `IDEMPOTENCY_CONFLICT` (Task 9⑪).
   */
  async #handleCommand(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.#commandCalls.push({ method, params })
    const commandId = params['commandId'] as string | undefined

    // The two query/read verbs of this face are NOT commands: they carry no
    // commandId and never enter the ledger.
    if (method === 'agent.interactions.list') return this.#page(this.#interactionViews(), params)
    if (method === 'agent.interactions.get') {
      const view = this.#interactionViews().find(
        (entry) => entry['interactionId'] === params['interactionId'],
      )
      if (view === undefined) throw new FakeRpcError({ reason: 'NOT_FOUND', message: 'Interaction not found' })
      return { interaction: view }
    }
    if (method === 'agent.commands.get') {
      if (commandId === undefined) throw new FakeRpcError({ reason: 'NOT_FOUND', message: 'Command not found' })
      const recorded = this.#commands.get(commandId)
      if (recorded === undefined) throw new FakeRpcError({ reason: 'NOT_FOUND', message: 'Command not found' })
      return recorded.receipt
    }

    if (commandId === undefined) {
      throw new FakeRpcError({ reason: 'INTERNAL', message: `missing commandId for ${method}` })
    }
    const identityDigest = this.#identityDigest(method, params)
    const recorded = this.#commands.get(commandId)
    if (recorded !== undefined) {
      if (recorded.identityDigest !== identityDigest) {
        throw new FakeRpcError({
          reason: 'IDEMPOTENCY_CONFLICT',
          message: 'Command body differs from the recorded command',
        })
      }
      return recorded.receipt
    }

    const receipt = await this.#runCommand(method, params)
    this.#commands.set(commandId, { commandId, method, identityDigest, receipt })
    return receipt
  }

  /** The body the idempotency digest is taken over (the real `encodeAgentCommand`). */
  #identityDigest(method: string, params: Record<string, unknown>): string {
    const { commandId: _ignored, ...body } = params
    return sha256Hex(new TextEncoder().encode(`${method}:${stableStringify(body)}`))
  }

  /** One command body, mirroring the real handler for each verb. */
  async #runCommand(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = params['sessionId'] as string
    switch (method) {
      case 'agent.sessions.create':
        return this.#runSessionCreate(params)
      case 'agent.messages.send':
        return this.#runSend(sessionId, params)
      case 'agent.executions.cancel':
        return this.#runCancel(sessionId, params)
      default:
        return this.#runRespond(sessionId, params)
    }
  }

  /**
   * `agent.sessions.create`: the receipt carries ONLY the sessionId (the real
   * peer's `{status:'applied', sessionId, result:{sessionId}}`), so the caller
   * must read the identity back through `agent.sessions.get`.
   */
  #runSessionCreate(params: Record<string, unknown>): Record<string, unknown> {
    const agentId = params['agentId'] as string
    const workspaceId =
      typeof params['workspaceId'] === 'string'
        ? (params['workspaceId'] as string)
        : ((params['workspace'] as { id?: string } | undefined)?.id ?? '')
    const systemWorkspace = params['workspaceId'] === undefined
    const sessionId = `session-${randomUUID().slice(0, 8)}`
    this.#agent().sessions?.push({
      sessionId,
      agentId,
      workspaceId: systemWorkspace ? 'system-workspace' : workspaceId,
      workspaceKind: systemWorkspace ? 'system' : 'registered',
      title: (params['title'] as string | undefined) ?? 'New chat',
      historyRevision: '1',
    })
    return {
      commandId: params['commandId'],
      method: 'agent.sessions.create',
      status: 'applied',
      admittedAt: new Date().toISOString(),
      sessionId,
      result: { sessionId },
    }
  }

  /**
   * `agent.messages.send`, faithful to the real handler: the §6 rejected
   * receipts (`busy` → CONFLICT "Session is busy", target routing failure →
   * TARGET_UNAVAILABLE), otherwise `applied` + an executionId, and the run
   * drives the session's events.
   */
  async #runSend(sessionId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.#requireSession(sessionId)
    const outcome = this.#agent().sendOutcome ?? 'applied'
    if (outcome === 'busy') {
      return this.#rejectedReceipt(params, 'agent.messages.send', {
        reason: 'CONFLICT',
        message: 'Session is busy',
      })
    }
    if (outcome === 'target-unavailable') {
      return this.#rejectedReceipt(params, 'agent.messages.send', {
        reason: 'TARGET_UNAVAILABLE',
        message: 'Session delivery target is unavailable',
      })
    }

    const executionId = `exec-${randomUUID().slice(0, 8)}`
    this.#activeExecutionId = executionId
    this.#appendTerminalMessage()
    const status = this.#agent().runTerminalStatus ?? 'completed'
    const messageId = this.#agent().runMessageId ?? this.#agent().terminalMessage?.messageId ?? 'msg-1'

    // The run is driven OFF the reply path: the receipt is the RPC result, the
    // execution's lifecycle is the notification stream — exactly the split the
    // real peer has.
    void this.#driveRun(sessionId, executionId, status, messageId)
    return {
      commandId: params['commandId'],
      method: 'agent.messages.send',
      status: 'applied',
      admittedAt: new Date().toISOString(),
      executionId,
    }
  }

  /** `agent.executions.cancel`, faithful to `abortAndDrain`'s precondition. */
  #runCancel(sessionId: string, params: Record<string, unknown>): Record<string, unknown> {
    this.#requireSession(sessionId)
    if ((this.#agent().cancelOutcome ?? 'applied') === 'target-unavailable') {
      return this.#rejectedReceipt(params, 'agent.executions.cancel', {
        reason: 'TARGET_UNAVAILABLE',
        message: 'Session delivery target is unavailable',
      })
    }
    const expectedExecutionId = params['expectedExecutionId'] as string
    // The peer's authority is its OWN active execution — the live run if one is
    // in flight, otherwise the session fixture's declared one. Comparing
    // against the live field alone would refuse a cancel of a run the fixture
    // says is active.
    const active =
      this.#activeExecutionId ??
      (this.#agent().sessions ?? []).find((entry) => entry.sessionId === sessionId)?.activeExecutionId
    if (active !== expectedExecutionId) {
      return this.#rejectedReceipt(params, 'agent.executions.cancel', {
        reason: 'CONFLICT',
        message: 'Execution is not active',
      })
    }
    const executionId = expectedExecutionId
    const messageId = this.#agent().runMessageId ?? this.#agent().terminalMessage?.messageId ?? 'msg-1'
    void this.#driveRun(sessionId, executionId, 'cancelled', messageId)
    return {
      commandId: params['commandId'],
      method: 'agent.executions.cancel',
      status: 'applied',
      admittedAt: new Date().toISOString(),
      executionId,
      result: { executionId, disposition: 'cancelled' },
    }
  }

  /**
   * `agent.interactions.respond`, faithful to the real handler: the
   * three-parameter staleness gate, then the answer/approve contracts. BOTH
   * §6 refusals are COMMAND RECEIPTS (`status:'rejected'` + `error`), never RPC
   * errors — the distinction Task 9④⑬ is built on.
   */
  #runRespond(sessionId: string, params: Record<string, unknown>): Record<string, unknown> {
    this.#requireSession(sessionId)
    const interaction = this.#interactions.find(
      (entry) => entry.interactionId === params['interactionId'],
    )
    const response = (params['response'] ?? { kind: params['decision'] }) as Record<string, unknown>
    if (
      interaction === undefined ||
      interaction.status !== 'pending' ||
      interaction.revision !== params['expectedRevision'] ||
      interaction.executionId !== params['expectedExecutionId'] ||
      this.#digestOf(interaction) !== params['inputDigest']
    ) {
      return this.#rejectedReceipt(params, 'agent.interactions.respond', {
        reason: 'CONFLICT',
        message: 'Interaction changed since it was read',
      })
    }

    const kind = response['kind']
    if (kind === 'answer') {
      if ((interaction.kind ?? 'decision') !== 'question') {
        return this.#rejectedReceipt(params, 'agent.interactions.respond', {
          reason: 'CONFLICT',
          message: 'Interaction does not accept answers',
        })
      }
      const questions = this.#questionsOf(interaction)
      const answers = (response['answers'] ?? {}) as Record<string, string>
      // The FULL-ANSWER contract: the count must match AND every question key
      // must be present with non-blank text. The refusal message is the fixed
      // wire文案 — never a per-key diagnostic.
      if (
        Object.keys(answers).length !== questions.length ||
        questions.some(
          (question) => !Object.hasOwn(answers, question) || answers[question]!.trim() === '',
        )
      ) {
        return this.#rejectedReceipt(params, 'agent.interactions.respond', {
          reason: 'CONFLICT',
          message: 'Every question requires an answer',
        })
      }
      this.#settleInteraction(interaction, 'approved')
      return this.#appliedReceipt(params, 'agent.interactions.respond', interaction.executionId, {
        interactionId: interaction.interactionId,
        decision: 'answer',
      })
    }

    if (kind === 'approve' && (interaction.kind ?? 'decision') === 'question') {
      return this.#rejectedReceipt(params, 'agent.interactions.respond', {
        reason: 'CONFLICT',
        message: 'Question requires answers',
      })
    }

    const approved = kind !== 'deny'
    this.#settleInteraction(interaction, approved ? 'approved' : 'denied')
    return this.#appliedReceipt(params, 'agent.interactions.respond', interaction.executionId, {
      interactionId: interaction.interactionId,
      decision: approved ? 'approve' : 'deny',
    })
  }

  /** The three question keys the peer parses out of a question interaction. */
  #questionsOf(interaction: FakeInteractionRecord): string[] {
    const input = interaction.input ?? {
      questions: [{ question: interaction.summary, options: [{ label: 'ok' }] }],
    }
    const questions = input['questions']
    if (!Array.isArray(questions)) return []
    return questions.map((question) => String((question as { question?: unknown }).question ?? ''))
  }

  /**
   * Records an interaction's new status, streams the `interaction.updated`, and
   * RESUMES any run that was parked on it (spec §3.6: after a response the
   * caller can `cherry_wait` again and expect the real terminal).
   */
  #settleInteraction(interaction: FakeInteractionRecord, status: 'approved' | 'denied'): void {
    interaction.status = status
    this.#interactionRevision += 1
    interaction.revision = String(this.#interactionRevision + 100)
    const parked = this.#parkedRuns.get(interaction.interactionId)
    const sessionId = parked?.sessionId ?? this.#sessionOfExecution(interaction.executionId)
    this.#notify('agent.events', {
      sessionId,
      subscriptionId: [...this.#subscriptions.values()].find((entry) => entry.sessionId === sessionId)
        ?.subscriptionId,
      streamEpoch: this.#journalEpoch,
      events: [
        {
          kind: 'interaction.updated',
          seq: String(++this.#watermark),
          payload: this.#interactionView(interaction),
        },
      ],
    })

    if (parked === undefined) return
    this.#parkedRuns.delete(interaction.interactionId)
    // A DENIED interaction ends the run as cancelled (the work is abandoned); an
    // APPROVED/answered one proceeds to its configured terminal.
    const status2 = status === 'denied' ? 'cancelled' : parked.status
    this.#emitExecutionUpdated(sessionId, parked.executionId, status2, parked.messageId)
    if (status2 !== 'running' && status2 !== 'finalizing' && status2 !== 'awaiting-approval') {
      this.#activeExecutionId = undefined
    }
  }

  /** The session an execution belongs to, from the execution's own fixture. */
  #sessionOfExecution(executionId: string): string {
    const sessions = this.#agent().sessions ?? []
    const owning = sessions.find((entry) => entry.activeExecutionId === executionId)
    if (owning !== undefined) return owning.sessionId
    // The live run's session is the only one this fake models.
    return sessions[0]?.sessionId ?? 'session-1'
  }

  #appliedReceipt(
    params: Record<string, unknown>,
    method: string,
    executionId: string,
    result: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      commandId: params['commandId'],
      method,
      status: 'applied',
      admittedAt: new Date().toISOString(),
      executionId,
      result,
    }
  }

  #rejectedReceipt(
    params: Record<string, unknown>,
    method: string,
    error: { reason: string; message: string },
  ): Record<string, unknown> {
    return {
      commandId: params['commandId'],
      method,
      status: 'rejected',
      admittedAt: new Date().toISOString(),
      error,
    }
  }

  /**
   * The terminal `execution.updated` (+ any soft-terminal interaction) a run
   * emits.
   *
   * With `pushInteractionOnRun`, the run PARKS on the interaction: it emits the
   * soft terminal and returns, exactly like the real peer suspends a run while
   * it awaits a decision. {@link #settleInteraction} then finishes it once the
   * interaction is answered — which is what makes the resume-after-answer
   * scenario expressible at all.
   */
  async #driveRun(
    sessionId: string,
    executionId: string,
    status: string,
    messageId: string,
  ): Promise<void> {
    const interaction = this.#agent().pushInteractionOnRun
    if (interaction !== undefined) {
      const delay = this.#agent().pushInteractionDelayMs ?? 0
      if (delay > 0) await sleep(delay)
      const live: FakeInteractionRecord = { ...interaction, executionId, status: 'pending' }
      this.#interactions.push(live)
      this.#interactionDigests.set(live.interactionId, this.#digestOf(live))
      this.#parkedRuns.set(live.interactionId, { sessionId, executionId, status, messageId })
      this.#notify('agent.events', {
        sessionId,
        subscriptionId: [...this.#subscriptions.values()].find((entry) => entry.sessionId === sessionId)
          ?.subscriptionId,
        streamEpoch: this.#journalEpoch,
        events: [
          {
            kind: 'interaction.updated',
            seq: String(++this.#watermark),
            payload: this.#interactionView(live),
          },
        ],
      })
      return
    }

    const delay = this.#agent().runDelayMs ?? 0
    if (delay > 0) await sleep(delay)
    this.#emitExecutionUpdated(sessionId, executionId, status, messageId)
    if (status !== 'running' && status !== 'finalizing' && status !== 'awaiting-approval') {
      this.#activeExecutionId = undefined
    }
  }

  /**
   * One `execution.updated` notification. A TERMINAL status additionally
   * carries the persisted result fields (`durable` + `history`) the schema's
   * terminal superRefine demands ("Terminal executions require a message and a
   * persistence outcome") — injected without them, the fixture would be
   * rejected by the schema layer before any waiter could judge it.
   */
  #emitExecutionUpdated(sessionId: string, executionId: string, status: string, messageId: string): void {
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
    const payload: Record<string, unknown> = {
      executionId,
      status,
      messageId,
      durable: terminal,
      ...(terminal ? { history: { messageRevision: '1', historyRevision: '1' } } : {}),
      ...(status === 'failed'
        ? { error: { reason: 'INTERNAL', message: 'Run failed' } }
        : {}),
    }
    this.#executionUpdates.push({ executionId, status, messageId })
    this.#notify('agent.events', {
      sessionId,
      subscriptionId: [...this.#subscriptions.values()].find((entry) => entry.sessionId === sessionId)
        ?.subscriptionId,
      streamEpoch: this.#journalEpoch,
      events: [
        { kind: 'execution.updated', seq: String(++this.#watermark), payload },
      ],
    })
  }

  /**
   * A completed run appends its assistant message to the read fixtures.
   *
   * The array is MATERIALIZED onto the options object when the fixture declared
   * none: `?? []` would push into a throwaway and silently serve an empty
   * message list, which is precisely the bug this face would otherwise hide.
   */
  #appendTerminalMessage(): void {
    const agent = this.#options.agent
    const message = agent?.terminalMessage
    if (agent === undefined || message === undefined) return
    agent.messages ??= []
    if (agent.messages.some((entry) => entry.messageId === message.messageId)) return
    agent.messages.push(message)
  }

  /** Every interaction, in the wire view the real `interactionsOf` serves. */
  #interactionViews(): FakeInteractionView[] {
    return this.#interactions.map((interaction) => this.#interactionView(interaction))
  }

  #interactionView(interaction: FakeInteractionRecord): Record<string, unknown> {
    return {
      interactionId: interaction.interactionId,
      revision: interaction.revision,
      executionId: interaction.executionId,
      toolCallId: interaction.toolCallId,
      status: interaction.status,
      summary: interaction.summary,
      ...(interaction.kind === undefined ? {} : { kind: interaction.kind }),
      inputDigest: this.#digestOf(interaction),
      input: interaction.input ?? {
        text: JSON.stringify({
          questions: [{ question: interaction.summary, options: [{ label: 'ok' }] }],
        }),
      },
    }
  }

  /** The interaction's current input digest (stable across re-projections). */
  #digestOf(interaction: FakeInteractionRecord): string {
    return (
      interaction.inputDigest ??
      sha256Hex(new TextEncoder().encode(stableStringify(interaction.input ?? interaction.summary)))
    )
  }

  /**
   * Failure injection across the two checkpoint faces. `alwaysExpireCheckpoints`
   * is PERSISTENT (never converges); `failNextCheckpointCall` is one-shot.
   */  #consumeInjectedCheckpointFailure(): void {
    const failure = this.#agent().alwaysExpireCheckpoints
      ? { reason: 'CHECKPOINT_EXPIRED', message: 'Preparation lease expired' }
      : this.#failNextCheckpointCall
    if (failure === undefined) return
    if (this.#agent().alwaysExpireCheckpoints !== true) this.#failNextCheckpointCall = undefined
    if (failure.reason === 'CHECKPOINT_EXPIRED' && this.#agent().keepSubscriptionOnInjectedExpiry !== true) {
      // The real peer's `activate` expiry branch calls `reset()`, which drops
      // the subscription and notifies `resetRequired` before throwing. The
      // injected face mirrors that, so the client is not misled into thinking
      // the peer still holds a slot.
      for (const subscription of [...this.#subscriptions.values()]) {
        this.#resetSubscription(subscription, 'CHECKPOINT_EXPIRED')
        break
      }
    }
    throw new FakeRpcError(failure)
  }

  async #reply(
    live: LiveConnection,
    id: unknown,
    result: Record<string, unknown> | undefined,
    failure?: { reason: string; message: string },
  ): Promise<void> {
    const frame =
      failure === undefined
        ? { jsonrpc: '2.0', id, result: result ?? {} }
        : {
            jsonrpc: '2.0',
            id,
            error: { code: JSON_RPC_ERROR_CODE, message: failure.message, data: { ...failure } },
          }
    try {
      await live.channel.write(frame)
    } catch {
      // The client vanished mid-reply; nothing to do.
    }
  }

  /**
   * Whole-session rate termination: over-budget closes the socket with 1011
   * and returns true. Per-connection (per-socket) counting only — no global
   * scheduling, mirroring the real desktop's per-connection rate window.
   */
  #rateLimited(live: LiveConnection): boolean {
    const budget = this.#options.rateLimitPerSecond
    if (budget === undefined) return false
    const now = Date.now()
    const inWindow = this.#requestTimestamps.filter((t) => now - t < 1000).length
    if (inWindow <= budget) return false
    live.socket.close(1011, 'rate limit exceeded')
    return true
  }
}

/**
 * Max number of request timestamps falling inside any 1-second sliding
 * window — the assertion currency of the client rate-smoothing test.
 */
export function maxRequestsInAnyOneSecondWindow(timestamps: readonly number[]): number {
  let max = 0
  for (let i = 0; i < timestamps.length; i += 1) {
    const count = timestamps.filter((t) => timestamps[i]! <= t && t < timestamps[i]! + 1000).length
    if (count > max) max = count
  }
  return max
}
