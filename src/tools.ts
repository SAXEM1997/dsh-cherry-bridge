import { createHash, randomUUID } from 'node:crypto'
import { DeviceUnavailableError, RpcDeadlineExceededError } from './connection.js'
import type { DeviceConnection, DeviceState } from './connection.js'
import type { DeviceRecord, DeviceResolution, DeviceStore } from './deviceStore.js'
import { QUARANTINE_RECOVERY, QuarantinedArchiveError } from './deviceStore.js'
import {
  INTERACTIONS_LIST_PAGE_CLAMP,
  LIST_PAGE_CLAMP,
  PARTS_LIST_PAGE_CLAMP,
} from './defaults.js'
import { JsonRpcRequestError, RequestTimeoutError } from './rpc/jsonRpcClient.js'
import { ContentReadGate } from './contentGate.js'
import type { ReadResult, SessionSubscriptions } from './subscriptions.js'
import { PairingError } from './pairing.js'
import type { PairingErrorKind } from './pairing.js'
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
 *    to BOTH the peer-negotiated `limits.pageItems` AND a byte-safe page budget
 *    (`defaults.ts`) — the protocol's single-page hard cap is never exceeded
 *    and no page may serialize past the 64 KiB record budget the transport
 *    enforces by killing the connection.
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
 * five-state set; a disabled device reports `disabled` from its stored
 * `enabled` flag without touching the pool, and an enabled one reports the
 * pooled connection's live state.
 *
 * Answering DOES warm the pool: the row is read through `deps.connect`, the
 * accepted resident-pool design — it resolves an existing connection and, on a
 * miss, builds the (disconnected) one the assembly would have built anyway, so
 * a listed device is also a primed one. The alternative — reporting `offline`
 * for anything not currently pooled — would misreport a device the caller can
 * immediately use.
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

/**
 * The selector names NO paired device. Its own verdict rather than
 * `ambiguous-device` with an empty candidate list: a miss has no candidate to
 * offer, and the empty-candidates shape asked the caller to disambiguate
 * against nothing — see {@link DeviceResolution}.
 */
export interface CherryDeviceNotFound {
  error: 'not-found'
  device: string
  /** The ids the caller could have meant — a hint, never a guess. */
  known: string[]
}

/**
 * The device archive is unreadable and READ-ONLY, so no device question can be
 * answered at all.
 *
 * Its own verdict rather than `ambiguous-device` with an empty candidate list,
 * and that is the whole point. Ambiguity is an ANSWER — "pick one of these" —
 * and with no candidates it tells the caller to disambiguate against a device
 * set the plugin cannot see, while the real condition (a damaged
 * `devices.json` that only an operator can repair) never surfaces. Every
 * device-dependent tool answers this instead, so one branch on the caller's
 * side covers the whole face.
 */
export interface CherryArchiveQuarantined {
  error: 'archive-quarantined'
  /** The shared recovery instruction ({@link QUARANTINE_RECOVERY}). */
  guidance: string
  /** The archive that cannot be read; still on disk, byte-for-byte. */
  archive: string
  /** The best-effort preservation copy, when one was made. */
  preservedAs?: string
}

/**
 * Why an aggregate stopped before the peer said it was done.
 *
 * TWO scopes carry these reasons, and the scope — not the reason — decides
 * which end is dropped:
 *
 * The MESSAGE-walk verdicts (`CherryReadSnapshot.truncationReason`,
 * `CherryMessageWalkVerdict.messagesTruncationReason`) are about the message
 * LIST: that walk runs newest-first, so every reason there drops the OLDER end
 * of the history, and the messages returned are taken whole (see
 * {@link CherryReadMessage.incomplete} for the one way a retained message can
 * still be missing its own content).
 *
 * `CherryReadMessage.partsTruncated` reuses the type for a DIFFERENT scope —
 * one message's own part list — where the walk runs OLDEST-part-first, so a
 * stop drops that message's LATER parts and flags the message incomplete.
 * Parts have no byte budget of their own, so only two reasons appear there:
 * `'safety-bound'` (the circuit breaker) and `'deadline'` (a wait answer's
 * budget — see {@link AssemblyDeadline}).
 */
export type CherryTruncationReason =
  /** The caller's `limit` was reached with more items available. */
  | 'limit'
  /** The safety circuit-breaker tripped; the peer still had pages to serve. */
  | 'safety-bound'
  /**
   * A BYTE budget was spent while the walk still had items to project
   * ({@link AGGREGATE_BYTES}).
   *
   * Its own member rather than a reuse of `'limit'`/`'safety-bound'`: neither
   * describes what happened. No caller asked for this, and no peer misbehaved
   * — the aggregate stopped because the CONTENT it had already assembled
   * reached the size this tool is willing to put in one answer, which is a
   * different sentence from both ("you asked for this many" / "the peer still
   * had pages"). A caller told `'limit'` here would look for a `limit` it never
   * passed.
   *
   * The budget is only checked BETWEEN messages, so this drops the OLDER
   * messages like every other reason and never cuts inside one: the newest
   * message is always returned whole.
   *
   * TWO faces emit it, one budget: the terminal/timeout/idle aggregates
   * (`CherryMessageWalkVerdict.messagesTruncationReason`) and `cherry_read`
   * (`CherryReadSnapshot.truncationReason`, issue #29).
   */
  | 'aggregate-bytes'
  /**
   * The ANSWER's own time budget ran out (issue #21).
   *
   * Emitted ONLY by the wait faces' aggregate (terminal / timeout / idle), which
   * runs after — or under — the caller's wait window and must not outlive a
   * bounded tail of it. Nothing was misreported and no bound the caller chose
   * was reached: the assembly simply ran out of time, which is why resuming with
   * the stop-point token (or raising `limit`) is the wrong reading of this word
   * and `cherry_read` is the recovery.
   *
   * `cherry_read` itself never emits it — it has no deadline — but its parts
   * walk may REPORT it on a message the wait faces projected under theirs
   * ({@link CherryReadMessage.partsTruncated}), because the projection is shared.
   */
  | 'deadline'

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
  /**
   * The peer's page position the walk was handed when it stopped. An internal
   * pagination value (the walk resumes its own pages from it, see
   * {@link CherryPage}). It is NOT itself a tool input: the MESSAGE faces wrap
   * it in the `cursor:` / `after:` resume token a caller may hand back
   * ({@link CherryReadSnapshot.messagesResumeCursor}), and the parts face has
   * no cursor-taking argument at all.
   */
  nextCursor?: string
  /**
   * True when the peer served MORE items than this walk asked for and the walk
   * took only part of that page (review P2-2).
   *
   * `limit` is a MAXIMUM on a list method, so an overshooting page is a peer
   * fault — but one this walk absorbs rather than refuses, unlike the
   * stuck/cycling cursors: nothing has been lost yet, and throwing would make
   * the list unreadable, which is the worse failure. What the walk must not do
   * is TRUST that page's position: it sits past items the walk never collected,
   * so a resume from it would skip them, and a terminal overshooting page would
   * otherwise be reported complete while dropping its tail. The walk therefore
   * stops with the caller's own attribution and re-uses the position it SENT for
   * that page — a resume re-reads the page (duplicates, never a gap) — while the
   * message faces prefer the exact `after:<last id>` anchor
   * ({@link messageResumeToken}).
   */
  pageOverflow?: true
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
  /**
   * Present when this part's text could NOT be read: the peer refused the
   * content read, or it could not be completed. `content` is then empty and
   * this field carries the reason, so a caller can tell "there was no text"
   * from "the text was there but unreadable" — a distinction the rest of the
   * snapshot would otherwise hide. Absent means the text was read.
   *
   * An INTEGRITY failure (the bytes do not match the ref's digest) never
   * degrades to this: it fails the whole read instead, because unverified
   * content must not be presented as a partial success.
   */
  unavailable?: string
  state?: string
  toolName?: string
  toolCallId?: string
  /**
   * The DESCRIPTIVE face of a binary attachment (`kind: 'file'`): what the file
   * is, never what it holds. `content` stays empty for such a part by design —
   * see {@link CherryToolEngine.#attachmentFace}.
   */
  name?: string
  mediaType?: string
  byteLength?: string
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
   * circuit-breaker stopped the walk (`'safety-bound'`) or a WAIT ANSWER's own
   * time budget did (`'deadline'` — see {@link AssemblyDeadline}). Parts have no
   * byte budget, so those are the only two reasons here. The walk runs
   * OLDEST-part-first, so what it drops is this message's LATER parts. Absent
   * means the part list is complete.
   */
  partsTruncated?: CherryTruncationReason
  /**
   * Where the parts walk stopped — a STOP-POINT MARKER, not an input.
   *
   * `parts.list` has no cursor parameter on this tool, so the value cannot be
   * handed back to read the rest; it is the peer's page position the parts walk
   * was handed when it stopped (the end of the last page it touched). Its
   * presence says those LATER parts are still unread (the message is also
   * flagged `incomplete`). It is a marker, not a way in: no caller input can
   * raise the parts circuit-breaker that cut this walk (it is an engine option,
   * and the part walk is otherwise unbounded), so a caller cannot ask "give me
   * the rest of THIS message" — the readable face of the loss is `incomplete`
   * plus this stop point. Present exactly when `partsTruncated` is.
   */
  partsResumeCursor?: string
  /**
   * Present (`true`) when any part of this message could not be fully read.
   *
   * Two triggers, because a caller asking "is this message whole?" does not
   * care WHICH layer lost the content: any part carrying `unavailable` (its
   * text was refused or could not be completed — see
   * {@link CherryReadPart.unavailable}), or `partsTruncated` being present (the
   * parts walk circuit-broke, so the part list ITSELF is short). Without this
   * flag a damaged message is indistinguishable from a complete one at the
   * message level: the healthy parts render, `content` is just empty on the one
   * that failed, and only a caller who walks every part learns otherwise.
   *
   * The message walk plays no part in this: a message truncated OUT of the walk
   * is absent entirely, never marked. Cross-reference
   * {@link CherryTruncationReason} for which end the walk drops.
   */
  incomplete?: true
  /** How many of this message's parts carry an `unavailable` reason. */
  unavailableParts?: number
}

/** The two-level `cherry_read` snapshot. */
export interface CherryReadSnapshot {
  session: Record<string, unknown>
  /** NEWEST-first: `messages[0]` is the most recent message in the session. */
  messages: CherryReadMessage[]
  truncated: boolean
  /**
   * The MESSAGE-walk truncation reason, when `truncated` is true.
   *
   * Every reason means the OLDER messages were dropped: the walk is
   * newest-first and each message is projected whole before the walk decides
   * whether to go on. A returned message is never cut inside its parts — if its
   * own content could not be fully read, IT says so
   * ({@link CherryReadMessage.incomplete}), not this field.
   *
   * This walk is bounded by the caller's `limit` AND by an output budget
   * ({@link AGGREGATE_BYTES}, the terminal faces' budget): the two arms have
   * different remedies, which is why they are different reasons.
   */
  truncationReason?: CherryTruncationReason
  /**
   * Where the message walk stopped — and the token `cherry_read` ACCEPTS back as
   * its own `messagesResumeCursor` argument (issue #26): a round trip, not a
   * marker with nowhere to go.
   *
   * TWO FORMS, both self-describing because the peer's cursor format is never
   * parsed by this bridge (the desktop's is an opaque keyset token, a peer's may
   * be a numeric offset, and a malformed one is SILENTLY swallowed there):
   *
   *  - `cursor:<peer position>` — the walk consumed its whole collected window,
   *    so the peer's page position is exactly where the unread history begins.
   *    Handing it back starts the next walk's FIRST request from it.
   *  - `after:<messageId>` — the walk stopped INSIDE its collected window (a
   *    byte stop), so the page position sits past messages the walk had already
   *    collected and would skip them; `AgentMessage` carries no `createdAt`, so
   *    no peer cursor can be synthesised for that boundary either. The anchor
   *    is the last message RETURNED, and "strictly older than it" is the honest
   *    stop. The resume read therefore starts cursorless, scans from the newest
   *    end to the anchor, and returns what follows it.
   *
   * Present exactly when `truncated` is true and a stop point can be named
   * honestly; because the walk runs newest-first, it marks OLDER messages as
   * still unread — the only direction a truncation leaves behind. It is ABSENT
   * when the walk reached the peer's last page having returned everything it
   * collected: there is nothing older left to name, and no marker is invented.
   *
   * WHAT REACHES THE UNREAD MESSAGES DEPENDS ON THE REASON. A `'limit'` stop was
   * the caller's own ceiling: raise `limit`, or resume with this token to walk
   * onward in another answer. An `'aggregate-bytes'` stop was the OUTPUT budget,
   * which raising `limit` does not move — a larger `limit` pays for more round
   * trips and still stops at the same byte budget. The RESUME TOKEN is how those
   * messages are reached. From the resume point `limit` bounds how many messages
   * ONE answer carries, so a long history is walked in successive answers, each
   * carrying the next stop point.
   */
  messagesResumeCursor?: string
}

/**
 * The MESSAGE-walk verdict a terminal/timeout/idle aggregate carries.
 *
 * These three results ride the SAME `#readTerminalMessages` walk `cherry_read`
 * does, but unlike `cherry_read` they cannot simply hand back a page: their
 * `text` is the ANSWER (the run's reply, or the partial content so far), so a
 * walk that stopped early is a correctness problem rather than a listing
 * detail. The fields are MESSAGE-scoped (`messagesTruncated`, not `truncated`)
 * because the result already carries an EVENT cursor under `cursor`, and a
 * bare `truncated` would read as a verdict on the whole result.
 *
 * The flag never changes the STATUS: a truncated terminal aggregate is still
 * `completed`. Surfacing is the contract — the caller learns that the text may
 * be partial and that older history is still unread, and decides what to do
 * about it.
 */
export interface CherryMessageWalkVerdict {
  /**
   * Present and true exactly when the message walk stopped before the peer's end.
   *
   * The stop is always at the OLD end: the walk is newest-first, so what is
   * missing is history BEHIND the returned messages, never content taken from
   * one of them. A returned message whose own parts could not be fully read is
   * content-incomplete and says so itself
   * ({@link CherryReadMessage.incomplete}) — that is a different verdict, and
   * `messagesTruncated` does not stand in for it.
   */
  messagesTruncated?: boolean
  /** Why it stopped, present exactly when `messagesTruncated` is true. */
  messagesTruncationReason?: CherryTruncationReason
  /**
   * Where the walk stopped — in the SAME token vocabulary `cherry_read` emits
   * and accepts as `messagesResumeCursor` (issue #26), from the same helper
   * ({@link messageResumeToken}), so a caller that stops on a terminal
   * aggregate resumes the older history with `cherry_read` instead of
   * re-waiting and hoping.
   *
   * `cursor:<peer position>` when the whole collected window was returned;
   * `after:<last returned message id>` when the byte stop happened INSIDE that
   * window, because the peer's position sits past messages this walk trimmed
   * and `AgentMessage` carries no `createdAt` to synthesise a closer one. The
   * token is OMITTED when nothing older is left to name (the walk reached the
   * peer's last page having returned everything it collected) — absence says
   * "no marker", `messagesTruncated` still says the walk was cut.
   */
  messagesResumeCursor?: string
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
 *    what arrived plus a stop-point cursor marking where the unread history
 *    begins.
 *  - `idle` — `cherry_wait` on a session with no in-flight execution: the
 *    current snapshot, returned at once (no error, no waiting).
 *  - `subscription-lost` — the run's event stream went away mid-wait and could
 *    not be rebuilt. The run's outcome is UNKNOWABLE from here, which is a
 *    different statement from `timeout` ("nothing settled inside the window")
 *    and must not borrow its name: a caller that saw `timeout` would re-wait,
 *    while this one has to fix the subscription (or read the run back by id)
 *    first.
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
  | 'subscription-lost'

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
/**
 * MESSAGE CEILING for the terminal/timeout/idle aggregate (issue #3).
 *
 * These three results are answers to a WAIT, not listings: the caller asked
 * "what did my run produce?" and the walk exists to find the run's own
 * messages. Reading the session's whole history to answer that was the field
 * defect — a 459-message session meant 29+ `agent.messages.list` pages plus
 * every part of every message, i.e. 118-124 s of round trips AFTER the
 * deadline had already elapsed.
 *
 * 20 is not a guess about how much history a caller might like: one run
 * persists a user message and an assistant message (a pair), and the peer's
 * `listSessionMessages` walks NEWEST-FIRST, so the walk reaches the run's own
 * messages FIRST. Ten runs' worth of slack is therefore already an order of
 * magnitude more than the walk needs to see the current one.
 *
 * Truncation is SURFACED (`messagesTruncated` + reason + stop-point token),
 * never silent: a caller that really wants the deeper history re-waits, or
 * hands the stop-point token to `cherry_read` as `messagesResumeCursor` and
 * keeps walking the older history with that tool's own `limit`.
 */
const TERMINAL_AGGREGATE_MESSAGES = 20
/**
 * BYTE BUDGET for a MESSAGE aggregate, applied to the PROJECTED messages (each
 * one after `#projectMessage`, measured with `JSON.stringify`'s length as a
 * cheap approximation of its wire cost). Shared by the terminal/timeout/idle
 * aggregates and by `cherry_read` — one budget, one vocabulary (issue #29).
 *
 * The message ceiling alone does not bound the RESULT: one message can carry
 * hundreds of parts, each an externalized `{ref}` resolved through a separate
 * `agent.content.read`. The field report's aggregate was 13 MB across 459
 * messages, and a result that size does not survive the MCP boundary at all
 * ("value is not lossless JSON") — the caller loses the verdict along with the
 * content. 256 KiB is a deliberate fraction of a tool result: enough for a
 * long reply plus its reasoning, small enough to stay well inside the limit.
 *
 * WHY `cherry_read` REUSES IT RATHER THAN GETTING ITS OWN (issue #29). The
 * read face is a batch history tool, so a LARGER budget would read more per
 * call — but the constraint that failed in the field is the MCP output
 * boundary, and it does not care which tool produced the oversized answer: a
 * `cherry_read(limit: 1000)` over a fat session produced tens of megabytes
 * after paying for every round trip first. A SECOND value would also mean two
 * answers to "how big may one aggregate be?", drifting apart silently, on two
 * faces that already share the reason vocabulary. What differs between them is
 * the MESSAGE CEILING, not the byte cost of one message. The read face's own
 * way to ask for more is the RESUME TOKEN: each stop is surfaced with one, and
 * handing it back walks the older history from there at the same budget.
 *
 * THE NEWEST MESSAGE IS ALWAYS WHOLE. The budget is checked only AFTER a
 * message's projection completes, and the first message is always taken before
 * any check runs — it is the run's own reply, and on `cherry_read` it is the
 * one message a caller asking "what is the latest?" cannot do without.
 */
const AGGREGATE_BYTES = 262_144
/**
 * What a caller whose terminal aggregate could not be assembled should do.
 *
 * The assembly failure is a CONTENT problem (an unverifiable `{ref}`, a part
 * walk the peer would not terminate, a message list that moved under us), not
 * a verdict on the run: the run's status is already known and is still true.
 * Saying so — and naming the route that rebuilds the content without a wait —
 * is what keeps the caller from re-running a command whose outcome is settled.
 */
const AGGREGATE_FAILED_GUIDANCE =
  'content assembly failed; the run verdict stands — use cherry_read to fetch the messages'
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
 * in items is never reached. Runs of empty pages are a peer fault handled
 * directly ({@link MAX_CONSECUTIVE_EMPTY_PAGES}); this is the backstop against
 * every other non-terminating shape, and a walk that hits it FAILS rather than
 * returning a partial (or empty) result as though it were complete.
 */
const MAX_AGGREGATE_PAGES = 10_000
/**
 * How a message-walk resume INPUT is expressed after parsing (issue #26): the
 * caller's `messagesResumeCursor` token, understood and judged HERE.
 *
 * The two forms exist because a message walk can stop in two different places,
 * and only one of them has a peer position to name:
 *
 *  - `cursor` — the whole collected window was consumed, so the peer's own page
 *    position is exactly where the unread history begins. The walk's FIRST
 *    request already carries it.
 *  - `anchor` — the stop happened INSIDE the collected window (an
 *    `aggregate-bytes` stop that trimmed messages the walk had already
 *    collected). The peer's page position sits PAST them and would skip them,
 *    and `AgentMessage` carries no `createdAt`, so no peer cursor can be
 *    synthesised for the in-window boundary. The token is therefore a MESSAGE
 *    ID: "strictly older than this one". The walk starts cursorless — there is
 *    no protocol way to ask the peer "begin after message X" — and scans from
 *    the newest end until it finds the anchor.
 */
type MessageResume =
  | { kind: 'cursor'; cursor: string }
  | { kind: 'anchor'; messageId: string }

/**
 * The same two forms, plus how a walk RECOGNISES its anchor: `idOf` reads an
 * item's message id. Only a message walk can resume from an anchor, so only the
 * message faces pass it.
 */
type AggregateResume<T> =
  | { kind: 'cursor'; cursor: string }
  | { kind: 'anchor'; messageId: string; idOf: (item: T) => string | undefined }

/**
 * Everything one page-walk call configures, in ONE bag: the caller's ceiling and
 * the three optional dimensions a walk can carry (a tighter safety bound, a
 * different per-page clamp, a resume point) plus the ANSWER's deadline
 * (issue #21).
 *
 * A bag rather than six positional parameters because the optional ones sit at
 * different ends of the list: an `#aggregate` call that wants only the deadline
 * would otherwise spell out three `undefined`s between what it sets and what it
 * means, and the next optional dimension would make that worse.
 */
interface AggregateWalk<T> {
  /** The caller's ceiling on COLLECTED items (`Infinity` for "no caller bound"). */
  limit: number
  /** Internal circuit breaker; defaults to {@link MAX_AGGREGATE_LIMIT}. */
  safetyBound?: number
  /** Byte-safe page request; defaults to {@link LIST_PAGE_CLAMP}. */
  maxPerPage?: number
  /** Where the walk BEGINS (issue #26). */
  resume?: AggregateResume<T>
  /** The answer's own time budget (issue #21) — see `AssemblyDeadline`. */
  deadline?: AssemblyDeadline
}

/** Token prefix for a peer page position; the one `#aggregate` can send back. */
const RESUME_CURSOR_PREFIX = 'cursor:'
/** Token prefix for "strictly older than this message id". */
const RESUME_ANCHOR_PREFIX = 'after:'
/**
 * PAGE-COUNT BOUND on the scan an `after:` token performs (issue #26).
 *
 * Derivation. An anchor is only ever emitted for a message this bridge
 * RETURNED, and the largest message walk here collects at most
 * {@link MAX_AGGREGATE_LIMIT} messages, so an anchor is at most 1000 messages
 * deep AT THE MOMENT IT IS EMITTED. The scan asks for a FULL page
 * ({@link LIST_PAGE_CLAMP} items against any peer whose negotiated `pageItems`
 * is at or above it), so reaching that depth costs at most 1000 / 16 = 63
 * pages. A peer negotiating BELOW the clamp pages smaller and needs more — the
 * floor is the clamp for every desktop build we support, and the clamp is also
 * what our byte-safe page budget asks for.
 *
 * The slack between 63 and 500 covers two things that GROW the distance: every
 * message appended since the token was emitted adds one item of scan distance
 * (the scan starts at the newest end, so a busy session pushes the anchor
 * further away, not closer), and a pinned-list walk legally serves empty pages
 * that advance the cursor without advancing position. A scan that has still not
 * met its anchor after 500 pages is a session this tool should not chase, and it
 * fails LOUDLY rather than truncating a walk that never really started.
 */
const MAX_ANCHOR_SCAN_PAGES = 500
/** The device id separator inside every engine cache key (neither id may hold NUL). */
const CACHE_KEY_SEPARATOR = '\u0000'
/**
 * CAP on each engine cache, PER DEVICE (v0.1.3 UltraReview P3-1).
 *
 * The three session caches ({@link CherryToolEngine.#revisionCache},
 * `#executionCache`, `#interactionCache`) are keyed by device + session (+
 * interaction), and before this bound they were cleared ONLY on
 * `cherry_unpair`: a long-lived process accumulated one entry per session and
 * per interaction card it had ever seen, for every device it ever talked to,
 * with nothing to release it. 256 is chosen as "far above any live working
 * set, far below anything that matters in memory":
 *
 *  - a single device's realistic working set is a handful of sessions and a few
 *    cards — the MCP caller drives one session at a time in practice;
 *  - 256 entries of short strings is tens of kilobytes per cache per device, so
 *    even a fleet of devices keeps the maps trivial;
 *  - eviction is CHEAP because every value is DERIVED state the desktop still
 *    holds authoritatively (`agent.sessions.get`, `agent.interactions.list`).
 *    An evicted entry costs one round trip on next use — the same cost a cold
 *    process pays — and can never cost CORRECTNESS: eviction removes the
 *    snapshot, so the next use re-queries instead of trusting it.
 *
 * The bound is per DEVICE rather than global so one busy desktop cannot evict
 * a quiet one's snapshots: the caches describe pairings, and a device's
 * snapshots are useless to every other device.
 *
 * INJECTABLE for tests (`cacheEntriesPerDevice`), because the production value
 * needs 257 live sessions before it evicts and a loopback test should not.
 */
const CACHE_ENTRIES_PER_DEVICE = 256
/**
 * CAP on ONE cached parts page, in bytes (issue #15) — measured the same cheap
 * way {@link AGGREGATE_BYTES} measures a message, with
 * `JSON.stringify(page.items).length`, i.e. the same wire-cost proxy.
 *
 * What an entry holds is a message's part RECORDS: ids, kinds, and either an
 * inline text body (up to the peer's 4,096-character `INLINE_TEXT_LIMIT` per
 * part) or a `{ref}` — never the resolved text, which is re-fetched and
 * re-verified on every read. That is the whole point of caching the list result
 * rather than the projection.
 *
 * Note what this does NOT bound: an entry is the AGGREGATED page, i.e. EVERY
 * part record of one message, and {@link DEFAULT_PARTS_SAFETY_BOUND} lets a
 * parts walk collect up to 10,000 of them. Ten thousand inline bodies at 4,096
 * characters is ~40 MB, far ABOVE this cap — so the bound is not decorative.
 * It bites on exactly the message a cache can least afford to hold: one whose
 * records alone would evict everything else for nothing (the `{ref}` byte
 * payload is not what is being cached). That it rarely bites for ordinary
 * history is an expectation, not a measurement.
 *
 * It stays as the guard it is: the protocol bounds neither a part's inline text
 * nor a message's part count, so an entry that did outgrow the device budget on
 * its own would evict every other message — a cache that thrashes on the one
 * entry it cannot afford to lose. An over-cap entry is simply walked FRESH on
 * every read: correct, and the same cost a cold process pays.
 *
 * INJECTABLE for tests (`messageCacheEntryBytes`), because no loopback fixture
 * should have to allocate a megabyte to prove the bound.
 */
const MESSAGE_CACHE_ENTRY_BYTES = 1_048_576
/**
 * BYTE BUDGET for ONE DEVICE's parts-page cache, across every session that
 * device served (issue #15).
 *
 * Derivation: it equals {@link MAX_EXTERNALIZED_BYTES}, the 32 MiB the official
 * client and this bridge already accept as the ceiling for a single `{ref}` —
 * the largest piece of content the read path will ever assemble. An entry is
 * the AGGREGATED part-record list (inline text included, `{ref}` payload
 * excluded), so this is far more headroom than ordinary history needs; it is
 * chosen to be a bound that never forces churn on ordinary traffic, not a
 * memory claim of its own.
 *
 * PER DEVICE, not global, for the same reason the session caches are: the
 * cached lists describe one peer, and a busy desktop must not evict a quiet
 * one's.
 *
 * Eviction is FIFO (`Map` insertion order, oldest first) — the policy
 * {@link CherryToolEngine.#remember} documents, and for the same reason: an
 * evicted entry costs one re-walk from a peer that still holds the message
 * authoritatively, never a wrong answer.
 *
 * INJECTABLE for tests (`messageCacheBytesPerDevice`), because a test cannot
 * drive 32 MiB honestly.
 */
const MESSAGE_CACHE_BYTES_PER_DEVICE = 33_554_432

/**
 * EMPTY-PAGE RUN limit for every aggregate walk. The desktop's pinned-list walk
 * legally answers ONE empty page with an advancing cursor (the pin→entity
 * section transition, `{items: [], nextCursor: 'entity:'}`), so a single empty
 * page is not a fault; a run of them is, and fails the walk.
 *
 * THREE, not one: the transition happens at most once per walk upstream, and
 * the margin keeps the walk working if a future peer chains section transitions
 * — while any bounded number still ends a peer that answers empty pages forever
 * (the `MAX_AGGREGATE_PAGES` backstop remains the last resort).
 */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3
/**
 * CIRCUIT-BREAKER for one `{ref}`'s content walk, used only when the ref
 * carries no usable `byteLength`. The ref's declared length normally derives
 * the bound exactly; this is the fallback for a malformed ref, and exceeding it
 * FAILS the read rather than returning a partial (unverifiable) content.
 */
const DEFAULT_CONTENT_SLICE_BOUND = 4_096
/**
 * ABSOLUTE ceiling on one `{ref}`'s content, in bytes — the same 32 MiB the
 * official Cherry Studio client applies (`remoteContent.ts`).
 *
 * The walk's slice budget derives from the length the REF DECLARES, so without
 * an absolute ceiling a peer declaring 4 GiB makes this client issue ~170,000
 * `agent.content.read` round trips before it reaches `eof` — a read that cannot
 * finish in any caller's patience, and one the caller has no way to stop. The
 * cap is a refusal to attempt that walk, not a proof about the content: content
 * the desktop really does externalize never approaches it, and a part above it
 * degrades to `unavailable` exactly like any other part this client will not
 * read.
 *
 * PER REF, NOT PER CALL — the memory contract (issue #7). The cap bounds ONE
 * ref, and a walk holds its content at roughly THREE times its size while
 * assembling it (the decoded slices, their concatenation, and the decoded
 * string — see {@link CherryToolEngine.#readExternalized}). An aggregate that
 * reads refs sequentially pays that peak one ref at a time; when several
 * partition reads are in flight at once (independent tool calls, not this
 * engine's own walk), the peak multiplies by the number of in-flight reads.
 * A process-wide gate over that product is deliberately NOT here; callers
 * that issued the concurrency are the ones that know its size.
 */
const MAX_EXTERNALIZED_BYTES = 32 * 1024 * 1024
/**
 * How many `{ref}` contents may be assembled AT ONCE, process-wide (issue #39).
 *
 * {@link MAX_EXTERNALIZED_BYTES} bounds one ref and one ref's assembly peaks at
 * ~3× its size, so without this number the process peak was that product times
 * however many independent tool calls happened to be reading. The gate makes it
 * a product of two stated constants: 4 × 3 × 32 MiB = 384 MiB worst case, and
 * in ordinary traffic 4 × 3 × (the declared size).
 *
 * 4 is the official client's read-concurrency policy
 * (`REMOTE_READ_CACHE_POLICY.concurrency`), not a measurement of this plugin:
 * it keeps a burst of independent reads flowing without letting them multiply
 * the transient buffers without bound. It is injectable, but NOT a config key —
 * like the content-rate tier, a second knob is deferred until a field report
 * needs one.
 */
const DEFAULT_CONTENT_READ_CONCURRENCY = 4

/** The protocol's `agent.messages.send.text` ceiling, pre-validated tool-side. */
const TEXT_MAX_LENGTH = 32_768
/** The default wait window, in ms (spec §3.6). A default, never a cap. */
const DEFAULT_WAIT_TIMEOUT_MS = 120_000
/** The smallest meaningful timeout: below this the wait is a snapshot read. */
const MIN_WAIT_TIMEOUT_MS = 1

/**
 * How much EXTRA time a wait ANSWER may spend assembling its content, at most
 * (issue #21). The effective tail is the caller's own window, CLAMPED to
 * [{@link WAIT_ANSWER_TAIL_FLOOR_MS}, this]: one more window, never less than 1 s
 * and never more than 15 s.
 *
 * WHY THE ANSWER NEEDS A BUDGET OF ITS OWN. The wait window bounds how long the
 * RUN may take, not how long reading its history may take. That read (the
 * bounded message walk: `agent.messages.list`, one `agent.parts.list` per
 * message, one `agent.content.read` walk per externalized part) happens AFTER
 * the window elapses, and before #21 it had no time bound at all: since #12 a
 * read whose link dies waits up to `transportRetryWaitMs` (5 s) for a reconnect
 * before replaying, so a flapping link let each of the walk's ~30 requests
 * absorb that wait — the 1 s timeout of the field report could answer ~150 s
 * later, exactly the shape #3 fixed.
 *
 * WHY 15 s. The walk is already bounded to 20 messages and 256 KiB, so a healthy
 * assembly is a handful of round trips. The worst SINGLE item inside it is one
 * max-size (32 MiB) `{ref}`, which at the content tier's 24 KiB slices is ~1,365
 * sequential reads — single-digit seconds on a LAN, and the only way one ref
 * approaches this bound. 15 s covers that plus the rest of the walk, and stays a
 * small absolute cost for the shortest useful windows (1 s → ≤2 s total).
 *
 * WHY THE WINDOW RATHER THAN THE CONSTANT ALONE. The tail is a fraction of the
 * patience the caller stated: a caller who asked for 5 s is not served by a
 * 15 s tail, and one who asked for 120 s is not served by 120 s more. One more
 * window is the honest reading of "the answer costs about what the wait did".
 */
export const WAIT_ANSWER_TAIL_MS = 15_000

/**
 * The LEAST extra time a wait answer may spend assembling its content (issue
 * #21) — one second, whatever window the caller chose.
 *
 * The window alone is not enough as a budget, because the tool's window has a
 * floor of 1 ms ({@link MIN_WAIT_TIMEOUT_MS}): `cherry_wait(timeoutMs: 1)` is a
 * legal "give me a snapshot now", and a 1 ms answer budget would return the stub
 * receipt for a run whose reply is one round trip away. One second is far more
 * than a healthy assembly needs (the walk is bounded to 20 messages) and is
 * small next to any window a caller actually waits on, so the floor never
 * extends a real answer — it only rescues a degenerate one.
 */
export const WAIT_ANSWER_TAIL_FLOOR_MS = 1_000

/**
 * The ONE instant a wait ANSWER may still be assembling content (issue #21).
 *
 * Built from the caller's own window, so every face of the answer — the session
 * snapshot, the message walk, each message's parts walk, each `{ref}` content
 * walk, and the transport layer's reconnect waits — is bounded by the same
 * clock. Passing an absolute instant (rather than a duration) is what makes
 * that possible: each layer derives its own remaining time when it is about to
 * wait, so time already spent is charged exactly once and no layer can reset
 * the budget.
 *
 * The clock is `performance.now()` — MONOTONIC, the same one the waiter's own
 * deadline uses. A wall clock can be stepped by the system, which would either
 * expire the answer instantly or extend it by the jump.
 *
 * WHEN IT EXPIRES, the walk STOPS and reports `'deadline'`; it does not throw.
 * The content already read is exactly what the answer is for (spec §3.6:
 * 超时非失败, return the partial content plus a cursor), so a spent budget
 * degrades the answer to what it has — with a stop-point token — rather than
 * throwing that away. The one exception is the message snapshot itself: without
 * it there is no walk to stop, and the caller gets the stub receipt.
 */
class AssemblyDeadline {
  /** The absolute instant, on `performance.now()`'s clock. */
  readonly instant: number

  constructor(startedAt: number, windowMs: number) {
    const tail = Math.min(Math.max(windowMs, WAIT_ANSWER_TAIL_FLOOR_MS), WAIT_ANSWER_TAIL_MS)
    this.instant = startedAt + windowMs + tail
  }

  /** Whether the budget is spent (a deadline exactly now counts as spent). */
  expired(): boolean {
    return performance.now() >= this.instant
  }
}

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
 * What a caller whose wait lost its event stream should do next.
 *
 * Reached only when the re-ensure itself could not be completed, so the run's
 * outcome genuinely cannot be observed from here. The instruction names the two
 * routes that DO work — the read face does not depend on the subscription, and
 * a later `cherry_wait` rebuilds one from scratch — because "subscription lost"
 * without a next step is a dead end for the caller.
 */
const SUBSCRIPTION_LOST_GUIDANCE =
  'the session\'s event subscription was lost mid-wait and could not be re-established; the run\'s ' +
  'outcome is unknowable from this wait. Read the session with cherry_read (it does not need a ' +
  'subscription), or call cherry_wait again to rebuild the subscription from a fresh baseline'

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
  /**
   * Subscribe to a device's connection-state transitions — the channel the
   * caches are INVALIDATED on (v0.1.3 UltraReview P3-2).
   *
   * OPTIONAL, and wired by the assembly from the SAME `connection.onState(cb)`
   * it already uses for the SSE fan-out and subscription recovery. It is a dep
   * rather than a new `Subscribe` method on `DeviceConnection` for the usual
   * reason: the state channel already exists and is already multicast, so the
   * tool face joins it instead of adding a second one.
   *
   * Absent (a bare engine, a test rig without it) means NO invalidation on
   * state transitions — the caches then only shrink on the capacity bound and
   * on `cherry_unpair`, which is the pre-P3-2 behaviour. It is not optional for
   * correctness of a long-lived process: see
   * {@link CherryToolEngine.#watchConnection}.
   *
   * Distinct from the assembly's own `onDeviceState` feed (which the SSE hub
   * consumes): that one is a broadcast to observers of EVERY device, while
   * this one subscribes the engine to ONE device's transitions.
   */
  watchDeviceState?: (deviceId: string, cb: (state: DeviceState) => void) => void
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
  /**
   * `approved` on success, the peer's/plugin's `PairingErrorKind` verdict on a
   * pairing failure, or `archive-quarantined` when the run failed at its last
   * step because the device archive is unreadable and READ-ONLY.
   */
  status: 'approved' | PairingErrorKind | 'archive-quarantined'
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

/**
 * The waiter's incremental fold state, carried from one poll pass to the next.
 *
 * The session buffer is append-only, so a pass only has to fold what arrived
 * since the last one. This carries the accumulated result — the pending
 * interaction map, the pre-baseline settled set, the adopted execution and its
 * observed terminal, and the high-water `scannedSeq` — so each pass is
 * proportional to the NEW events instead of the whole run.
 */
interface ObservationCarry {
  /** Highest event seq already folded; entries at or below it are skipped. */
  scannedSeq?: number
  pending?: Map<string, { interactionId: string; kind: string; summary: string; questions: string[] }>
  settledBeforeBaseline?: Set<string>
  /** The execution this wait attached to, once adopted or supplied. */
  awaited?: string
  executionId?: string
  terminalStatus?: string
  terminalMessageId?: string
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

/**
 * One `{ref}`'s content could not be TRUSTED: the bytes served do not match the
 * digest the ref advertises (or there was no digest to check against).
 *
 * A class rather than a message, because the callers act on the difference: a
 * single unreadable part degrades to `unavailable` (see
 * {@link CherryToolEngine} `#projectPart`), while an integrity failure must
 * fail the WHOLE read — content that cannot be verified must never be reported
 * as though it were complete. Matching on message text would break silently the
 * first time the wording changed.
 */
class ContentIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContentIntegrityError'
  }
}

/**
 * Why one part's text is missing, as the `unavailable` field reports it.
 *
 * The peer's own reason is preferred (`NOT_FOUND`, `RESOURCE_EXHAUSTED`, ...)
 * because it is the actionable half; an error with no protocol reason falls
 * back to its message. Bounded so a peer-echoed string cannot inflate a tool
 * result.
 */
function unavailableReason(error: unknown): string {
  const reason = failureReason(error)
  if (reason !== undefined) return reason
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}

/**
 * The §6 recovery advice appended to the peer's `IDEMPOTENCY_CONFLICT`.
 *
 * The peer refused a `commandId` that is already in its ledger under a
 * DIFFERENT body. That is not a transient failure and must never be retried
 * as-is: the id is the identity of the command, so re-sending the changed body
 * under it will be refused forever. The recovery is to REGENERATE the id for
 * the new body (or re-send the ORIGINAL body to replay the original outcome).
 */
const IDEMPOTENCY_HINT =
  'the peer already recorded this commandId with a different body; regenerate the commandId for ' +
  'a retry whose parameters changed — never reuse an id with a different body (re-send the ' +
  'ORIGINAL body to replay the original receipt).'

/**
 * Passes a command failure through UNCHANGED, except that `IDEMPOTENCY_CONFLICT`
 * gets {@link IDEMPOTENCY_HINT} appended to its message.
 *
 * The error object itself is NOT replaced: the reason, the structured `data`
 * and the {@link JsonRpcRequestError} identity all survive, so a caller that
 * branches on the reason (and the existing suites that assert it) see exactly
 * what the peer sent. Only `message` — the human-readable half — is extended.
 * Mutating in place is deliberate: a re-wrap would cost the prototype and with
 * it every `instanceof` check downstream.
 */
function withIdempotencyHint(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  if (failureReason(error) !== 'IDEMPOTENCY_CONFLICT') return error
  if (error.message.includes(IDEMPOTENCY_HINT)) return error
  error.message = `${error.message} — ${IDEMPOTENCY_HINT}`
  return error
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The peer's `agent.messages.send` refusal for a STALE `expectedIdleRevision`,
 * in the exact shape Cherry Studio answers it: a `rejected` receipt whose
 * `error` is `{reason: 'CONFLICT', message: 'Session is not idle at the
 * expected revision'}` (a throw inside the handler's `startRun` guard, folded
 * into a receipt by its `command()` wrapper).
 *
 * Deliberately NOT "any CONFLICT": two other CONFLICT refusals share the
 * reason and mean something entirely different —
 *
 *  - "Session is busy" says a run is in flight. The revision is moot, and a
 *    retry would change nothing; retrying it would spend a command per call
 *    on a session that is working normally.
 *  - "Execution is not active" belongs to the cancel verb, not to this one.
 *
 * The message match is what separates them, so this predicate keys on the
 * message the peer actually sends rather than on the reason alone.
 */
function isStaleRevisionRefusal(receipt: Record<string, unknown>): boolean {
  if (receipt['status'] !== 'rejected') return false
  const error = isRecord(receipt['error']) ? receipt['error'] : undefined
  if (error === undefined || error['reason'] !== 'CONFLICT') return false
  const message = error['message']
  return typeof message === 'string' && message.includes(SEND_STALE_REVISION_MESSAGE)
}

/** The peer's exact wire文案 for a stale admission baseline (see above). */
const SEND_STALE_REVISION_MESSAGE = 'not idle at the expected revision'

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
   * Byte ceiling for one `{ref}`'s externalized content. Omitted uses
   * {@link MAX_EXTERNALIZED_BYTES}.
   *
   * Injectable so a test can prove the CUMULATIVE arm of the ceiling is
   * load-bearing: with the real 32 MiB value, any ref that crosses it through
   * honest 24 KiB slices exhausts the slice budget first, and only a small cap
   * makes the byte check the arm that actually stops a peer that serves more
   * than it declared.
   */
  externalizedByteCap?: number
  /**
   * How long a waiter may sit between two judgement passes when the session
   * buffer has not moved. Omitted uses {@link DEFAULT_WAIT_POLL_MS}. Lowering
   * it makes a wait react sooner at the cost of more wakeups; raising it makes
   * a quiet peer's answer later.
   */
  waitPollMs?: number
  /**
   * Cap on EACH of the engine's three session caches, per device. Omitted uses
   * {@link CACHE_ENTRIES_PER_DEVICE}.
   *
   * Injectable so a test can drive the bound down to two and observe eviction:
   * at the production value a proof needs 257 live sessions, which no loopback
   * suite should spend its run on.
   */
  cacheEntriesPerDevice?: number
  /**
   * Size ceiling for ONE cached `agent.parts.list` result. Omitted uses
   * {@link MESSAGE_CACHE_ENTRY_BYTES}.
   *
   * Injectable so a test can prove the per-entry arm: at the production 1 MiB
   * (which ordinary part-record lists stay far below) a loopback fixture would
   * have to allocate a megabyte to cross it, and the bound's consequence —
   * "walked fresh every time, never held" — is the same at 64 bytes.
   */
  messageCacheEntryBytes?: number
  /**
   * Byte budget for one DEVICE's cached parts lists. Omitted uses
   * {@link MESSAGE_CACHE_BYTES_PER_DEVICE}.
   *
   * Injectable for the same reason as `cacheEntriesPerDevice`: the production
   * 32 MiB needs tens of megabytes of fixtures before it evicts one entry,
   * which no loopback suite should spend its run on.
   */
  messageCacheBytesPerDevice?: number
  /**
   * How many `{ref}` contents may be assembled at once across the WHOLE engine
   * — every tool call, every device. Omitted uses
   * {@link DEFAULT_CONTENT_READ_CONCURRENCY} (4).
   *
   * Injectable so a test can drive it to one and observe serialization: at the
   * production 4 a proof needs five genuinely concurrent fat reads, and the
   * property under test ("no more than the limit at once") is the same at 1.
   */
  contentReadConcurrency?: number
}

/**
 * The 14 `cherry_*` tool names, in the family's documented order.
 *
 * THE one list: the plugin assembly (`src/index.ts` hands it to the scope host
 * as `names`, which is where the visibility `deny` sets and the dispatch
 * guard's scope come from) and the contract suite read this constant instead of
 * keeping a copy of their own. The diagnostics face does NOT read it — its
 * scope segment reports the live scope state, not this list.
 *
 * {@link CherryToolEngine.definitions()} still spells each name inside its own
 * declaration — that literal is what the host registry receives — so the two
 * CAN drift. The contract suite's bidirectional-difference assertion is the
 * interceptor: a tool added, renamed or dropped on either side turns red
 * instead of leaving the published list silently wrong.
 */
export const CHERRY_TOOL_NAMES: readonly string[] = [
  'cherry_devices',
  'cherry_agents',
  'cherry_workspaces',
  'cherry_sessions',
  'cherry_read',
  'cherry_events',
  'cherry_create',
  'cherry_send',
  'cherry_wait',
  'cherry_interactions',
  'cherry_respond',
  'cherry_cancel',
  'cherry_pair',
  'cherry_unpair',
] as const

/**
 * Registers the whole `cherry_*` family on `ctx.tools` — exactly the names in
 * {@link CHERRY_TOOL_NAMES}, which the contract suite asserts against this
 * function's own registrations.
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
 * The six read tools — and, below them, the WHOLE fourteen-tool `cherry_*`
 * family: the six READ-ONLY tools (Task 8), six INTERACTIVE ones (Task 9), and
 * two MANAGEMENT ones (Task 10), plus the registration framework they all
 * share. Kept as one class (rather than per-face closures) so the per-session
 * and per-device state the later faces add has an obvious home.
 */
class CherryToolEngine {
  readonly #deps: CherryToolsDeps
  /**
   * Circuit-breaker for the parts walk. A LOCAL policy value, injectable so a
   * test can drive the bound low enough to prove that tripping it SURFACES
   * rather than silently truncating.
   */
  readonly #partsSafetyBound: number
  /** Externalized-content byte ceiling, injectable for the reason above. */
  readonly #externalizedByteCap: number
  /** Poll cadence for the interactive waiters (see `DEFAULT_WAIT_POLL_MS`). */
  readonly #waitPollMs: number
  /**
   * The subscription cache's latest IDLE revision per `<deviceId>\0<sessionId>`
   * — the source of `agent.messages.send`'s `expectedIdleRevision` (spec §4.2).
   * A cold cache is baselined from `agent.sessions.get`, so the value sent is
   * always one the peer itself reported.
   *
   * The DEVICE component is load-bearing: this engine is one instance shared by
   * every device in the pool, while a session id belongs to a peer. See
   * {@link CherryToolEngine.#cacheKey}.
   */
  readonly #revisionCache = new Map<string, string>()
  /**
   * The subscription cache's current ACTIVE execution per `<deviceId>\0
   * <sessionId>` — ONE source shared by `cherry_cancel`'s `expectedExecutionId`
   * and `cherry_respond`'s staleness triple, so the two can never disagree
   * about what is running. Device-scoped for the same reason as
   * {@link CherryToolEngine.#revisionCache}: execution ids are the peer's, and
   * a bare-sessionId key would let one desktop name another's run.
   */
  readonly #executionCache = new Map<string, string>()
  /**
   * The subscription cache's interaction snapshots, keyed `<deviceId>\0<sessionId>\0
   * <interactionId>`: the `expectedRevision`/`expectedExecutionId`/
   * `inputDigest` triple `cherry_respond` sends.
   *
   * AUTHORITY (adjudicated): `agent.interactions.list` is the AUTHORITATIVE
   * source for respond-eligibility snapshots — it is the peer's persisted,
   * four-state view, and it is the path that makes a card the peer never
   * streamed answerable at all. The real-time `interaction.updated` stream is
   * an ACCELERATOR/FRESHENER: it refreshes this cache without a round trip, so
   * the common case answers instantly, but nothing here may treat "not
   * streamed" as "not answerable". {@link CherryToolEngine.#interactionSnapshot}
   * implements exactly that order: fold the stream in first, then fall back to
   * ONE list query.
   */
  readonly #interactionCache = new Map<
    string,
    { revision: string; executionId: string; inputDigest: string }
  >()
  /**
   * The per-device cap on EACH of the three caches above.
   *
   * COUNTS, not bytes, and that is deliberate: every value here is a handful of
   * short strings the peer itself reported (a revision, an execution id, an
   * interaction triple), so the memory per entry is bounded by the protocol's
   * own field sizes rather than by anything this engine decides. A count cap is
   * therefore a real bound on the maps, not a proxy for one, and it needs no
   * bookkeeping to stay true.
   */
  readonly #cacheEntriesPerDevice: number
  /**
   * One cached parts page's size ceiling and the device's whole byte budget
   * (issue #15) — see {@link MESSAGE_CACHE_ENTRY_BYTES} and
   * {@link MESSAGE_CACHE_BYTES_PER_DEVICE}. Both injected, so the bounds are
   * policy rather than magic numbers scattered through the store below.
   */
  readonly #messageCacheEntryBytes: number
  readonly #messageCacheBytesPerDevice: number
  /**
   * The process-wide gate over `{ref}` assembly (issue #39) — one slot per ref
   * being read, shared by every tool call and every device this engine serves.
   */
  readonly #contentGate: ContentReadGate
  /**
   * The parts pages already walked, keyed `<deviceId>\0<messageId>`.
   *
   * WHAT IS HELD is the RESULT of `agent.parts.list` — the raw part records plus
   * the walk's verdict — NOT the projection built from it. Every face projects
   * through {@link CherryToolEngine.#projectMessage}, so a hit skips that
   * message's `agent.parts.list` walk and then runs the ordinary projection loop
   * over the cached records: every `{ref}` is still fetched and sha256-verified
   * on every read.
   *
   * THAT IS THE WHOLE ARGUMENT. A message revision fences the parts RECORDS the
   * peer serves — its own `agent.parts.list` raises `REVISION_EXPIRED` for a
   * stale `messageRevision` — and says nothing about the content store behind a
   * `{ref}`. Caching the PROJECTION would therefore serve text the peer has
   * since corrupted, turning a `ContentIntegrityError` into a confident answer.
   * Caching the RECORDS re-resolves the content on every hit, so the integrity
   * guarantee is untouched and the staleness class is exactly the peer's own,
   * with no new one. The trade-off is stated rather than hidden: externalized
   * content still costs its `agent.content.read` walk on every read (the 2.1.6
   * common case); what the cache saves is the list walk.
   *
   * NEVER CACHED (each is a correctness or a permanence argument, not a memory
   * one):
   *
   *  - a row with an EMPTY revision — there is no fence to trust, so the entry
   *    could never be validated against anything;
   *  - a TRUNCATED page — the walk stopped early (the circuit breaker, or a
   *    wait answer's deadline), so the list is short. Remembering it would make
   *    a transient short walk permanent; the refusal is reason-blind;
   *  - a page above {@link MESSAGE_CACHE_ENTRY_BYTES} — walked fresh every time
   *    rather than allowed to crowd out every other message.
   *
   * EVERYTHING ELSE MAY BE HELD — including a message whose parts failed to
   * resolve. That degradation happens at PROJECTION time: the cached records
   * are still the peer's complete answer, the next read re-attempts every part,
   * and an incomplete projection is no longer a reason to forget a good list.
   *
   * BYTES, not entries: a part record carries inline text (bounded only by the
   * paste the user made) and a `{ref}` descriptor, so a count cap would bound
   * the map without bounding its memory. {@link CherryToolEngine.#deviceMessageCacheBytes}
   * carries the running total, maintained ONLY by
   * {@link CherryToolEngine.#dropCachedMessage} (every removal) and by the
   * insert/refresh arithmetic in
   * {@link CherryToolEngine.#rememberPartsPage}, so it cannot drift from the
   * map.
   */
  readonly #messageCache = new Map<
    string,
    { revision: string; bytes: number; page: CherryPage<Record<string, unknown>> }
  >()
  /**
   * The running byte total of {@link CherryToolEngine.#messageCache}, per
   * device. Kept beside the map rather than recomputed on eviction: summing a
   * device's entries on every insert would make a long session quadratic.
   * A device with no live entry has its key REMOVED (not zeroed), so the map
   * describes exactly the devices that hold cache memory.
   */
  readonly #deviceMessageCacheBytes = new Map<string, number>()
  /**
   * Connections whose state channel this engine already joined.
   *
   * `connect()` is called on EVERY tool entry point, so the watch is installed
   * from there — and this set is what makes installing it idempotent. Without
   * it every `cherry_read` would add another listener to the same connection
   * for the life of the process, and a device going offline once would fire N
   * invalidations. Keyed by the CONNECTION (not the device) so a re-built
   * connection after `evict` is watched afresh; weak so an evicted instance is
   * not pinned by bookkeeping.
   */
  readonly #watchedConnections = new WeakSet<DeviceConnection>()

  constructor(deps: CherryToolsDeps, options: CherryToolEngineOptions = {}) {
    this.#deps = deps
    this.#partsSafetyBound = Math.max(
      1,
      Math.floor(options.partsSafetyBound ?? DEFAULT_PARTS_SAFETY_BOUND),
    )
    this.#externalizedByteCap = Math.max(
      1,
      Math.floor(options.externalizedByteCap ?? MAX_EXTERNALIZED_BYTES),
    )
    this.#waitPollMs = Math.max(1, Math.floor(options.waitPollMs ?? DEFAULT_WAIT_POLL_MS))
    this.#cacheEntriesPerDevice = Math.max(
      1,
      Math.floor(options.cacheEntriesPerDevice ?? CACHE_ENTRIES_PER_DEVICE),
    )
    this.#messageCacheEntryBytes = Math.max(
      1,
      Math.floor(options.messageCacheEntryBytes ?? MESSAGE_CACHE_ENTRY_BYTES),
    )
    this.#messageCacheBytesPerDevice = Math.max(
      1,
      Math.floor(options.messageCacheBytesPerDevice ?? MESSAGE_CACHE_BYTES_PER_DEVICE),
    )
    this.#contentGate = new ContentReadGate(options.contentReadConcurrency ?? DEFAULT_CONTENT_READ_CONCURRENCY)
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
   * ⑤): the candidate list is the answer. A MISS is a verdict too — see
   * {@link CherryDeviceNotFound} — and it carries the ids the caller could have
   * meant so the answer stays actionable.
   */
  #resolve(
    device: string,
  ): ResolvedDevice | CherryAmbiguousDevice | CherryDeviceNotFound | CherryDeviceUnavailable {
    const resolution: DeviceResolution = this.#deps.store.resolve(device)
    if ('ambiguous' in resolution) {
      return { error: 'ambiguous-device', device, candidates: resolution.ambiguous }
    }
    if ('notFound' in resolution) return this.#notFoundVerdict(device)

    const connection = this.#deps.connect(resolution.deviceId)
    // EVERY tool that names a device comes through here, so this is where the
    // device's state channel is joined — once per CONNECTION, see
    // {@link #watchConnection}. It is installed BEFORE the state check: the
    // transition this exists for can land while the device is already offline,
    // and the watch must be in place from the first call either way.
    this.#watchConnection(resolution.deviceId, connection)
    if (connection.state !== 'connected') {
      // The established Task 5 shape: the tool never dials implicitly, and the
      // caller gets the same `{device, state}` verdict the RPC layer throws.
      return { error: 'device-unavailable', device: resolution.deviceId, state: connection.state }
    }
    return { record: resolution, connection }
  }

  /**
   * The quarantined-archive verdict, or `undefined` for a healthy store.
   *
   * Consulted BEFORE any resolution, because a quarantined store's empty view
   * makes every downstream answer a lie: `resolve` cannot find a device that IS
   * paired (the archive is unreadable), so it reports a miss — and a caller
   * reasonably concludes the device is not paired, about a store that still
   * holds its access token on disk. The probe is a cheap readonly field read on
   * the store, and it is deliberately checked on every device-dependent entry
   * point rather than once at registration: the archive can go bad while the
   * process is running.
   */
  #quarantineVerdict(): CherryArchiveQuarantined | undefined {
    const info = this.#deps.store.quarantineInfo()
    if (info === undefined) return undefined
    return {
      error: 'archive-quarantined',
      guidance: QUARANTINE_RECOVERY,
      archive: info.file,
      ...(info.corruptPath === undefined ? {} : { preservedAs: info.corruptPath }),
    }
  }

  /** True when `#resolve` answered with a structured verdict instead of a link. */
  #isVerdict(
    resolved: ResolvedDevice | CherryAmbiguousDevice | CherryDeviceNotFound | CherryDeviceUnavailable,
  ): resolved is CherryAmbiguousDevice | CherryDeviceNotFound | CherryDeviceUnavailable {
    return 'error' in resolved
  }

  /**
   * Resolve-or-verdict: every non-`cherry_devices` tool needs a live link.
   *
   * The failure faces are deliberately DIFFERENT (controller ruling ⑤): an
   * ambiguous selector and a MISS are ANSWERS — the candidate list, or the
   * known ids, returned in band, because the caller can act on them — while a
   * non-connected device is the §6 `DeviceUnavailableError` the established
   * error face already defines.
   *
   * A miss cannot ride in band here: a non-`cherry_devices` tool has nothing to
   * do without a device, and returning a not-found OBJECT from a tool whose
   * result is consumed as data would be mistaken for one. It throws instead.
   * `cherry_devices` does not come through this method — it goes through
   * {@link #selectRecords}, which returns the verdict in band.
   */
  #requireConnection(device: string): ResolvedDevice | CherryAmbiguousDevice {
    const resolved = this.#resolve(device)
    if (!this.#isVerdict(resolved)) return resolved
    if (resolved.error === 'ambiguous-device') return resolved
    if (resolved.error === 'not-found') {
      const known = resolved.known.length === 0 ? 'none' : resolved.known.join(', ')
      throw new Error(
        `no paired device matches "${device}"; known device ids: ${known}`,
      )
    }
    throw new DeviceUnavailableError(resolved.device, resolved.state)
  }

  /**
   * The connection-plus-record pair, or the verdict to return verbatim. Lets
   * each tool's body read as `resolved.link ?? resolved.verdict` without
   * repeating the discriminant dance.
   *
   * The quarantine check comes FIRST: it is the strongest statement available
   * (the device set itself is unknowable), and letting resolution run would
   * replace it with a weaker, wrong one — a miss under a READ-ONLY archive
   * would describe a store that still holds a valid token as "no such device".
   */
  #linkOr(
    device: string,
  ):
    | { link: ResolvedDevice; verdict?: undefined }
    | { link?: undefined; verdict: CherryAmbiguousDevice | CherryArchiveQuarantined } {
    const quarantined = this.#quarantineVerdict()
    if (quarantined !== undefined) return { verdict: quarantined }
    const resolved = this.#requireConnection(device)
    if ('error' in resolved) return { verdict: resolved }
    return { link: resolved }
  }

  /**
   * The `{ notFound: true }` member of a store resolution as the tool-face
   * verdict, with the ids the caller could have meant.
   */
  #notFoundVerdict(device: string): CherryDeviceNotFound {
    return {
      error: 'not-found',
      device,
      known: this.#deps.store.list().map((record) => record.deviceId),
    }
  }

  // -------------------------------------------------------------------------
  // Pagination: the aggregate/clamp discipline (controller ruling ②)
  // -------------------------------------------------------------------------

  /**
   * Walks pages until `limit` items are collected or the peer runs out,
   * clamping EVERY page to the byte-safe page budget.
   *
   * TWO clamps bound every page request. `limits.pageItems` is the
   * peer-negotiated COUNT cap (the protocol's single-page hard limit, whatever
   * the caller asks for), and `maxPerPage` is the plugin's own WIRE-SAFETY
   * clamp: one JSON-RPC record may not exceed `remoteLimits.recordBytes`
   * (64 KiB), the desktop's `pageOf` budgets pages by count alone (deployed
   * 2.1.6 and earlier; byte-budgeted upstream main as of #21854, unreleased),
   * and a page of fat inline items is a record the transport answers by
   * killing the connection. The clamps live in `defaults.ts` with their
   * derivation; the effective page size is whichever of the two is smaller.
   *
   * `limit` is a CALLER contract, and reaching it is reported as
   * `truncationReason: 'limit'`. `safetyBound` is different in kind: it is an
   * internal circuit-breaker against a peer that never terminates, and tripping
   * it is ALWAYS surfaced (`truncationReason: 'safety-bound'` plus the
   * stop-point cursor) — a walk never stops early and reports success.
   *
   * A page whose `items` are not all records is PROJECTED: every list face
   * runs through `arrayOf`, which keeps the records and drops the rest (an
   * item that is not an object cannot be an entry of anything this layer
   * renders). Dropping is the only option for a mid-walk page, but it must
   * never be SILENT, because a dropped item is a short answer that otherwise
   * reads exactly like a complete one:
   *
   *  - one bounded `console.warn` per WALK, naming the method and the number of
   *    dropped items — never their contents, which are peer-supplied payload;
   *  - a TERMINAL page (`nextCursor: null`) that offered items and had ALL of
   *    them dropped is a contradiction: the peer says the walk is over and
   *    simultaneously retracts everything on its last page. It is thrown with
   *    the exact diagnosis — same family as the stuck-cursor refusal — rather
   *    than returned as `truncated: false` with a hole in it.
   *
   * An EMPTY page with a non-null `nextCursor` is legal progress while the
   * cursor advances: the desktop's pinned-list walk answers exactly
   * `{items: [], nextCursor: 'entity:'}` when a pin anchor is unpinned or
   * deleted between two requests (the pin→entity section transition). What is
   * a FAULT is a walk that makes no progress: the same cursor again (stuck),
   * three CONSECUTIVE empty pages (a peer that answers empty pages forever), or
   * {@link MAX_AGGREGATE_PAGES} (the backstop). Each is thrown, never reported
   * as a completed walk.
   *
   * `resume` (issue #26) is where the walk BEGINS, and it is the one optional
   * trailing parameter: `cursor` seeds the first request with a peer page
   * position, `anchor` makes the walk start cursorless and DISCARD items until
   * `idOf` reports the anchor id — the anchor itself is not collected, and
   * collection starts at the item after it. An `anchor` scan cannot be told to
   * the peer (no protocol cursor means "after message X"), which is why it is a
   * local scan. EVERY guard above stays in force during it: a page that does
   * not hold the anchor is discarded WHOLE and the walk goes on, `emptyPages`
   * keeps counting the RAW page (a discarded non-empty page is progress, not an
   * empty-page run), and the stuck/cycle/backstop checks are untouched. Two
   * failures are specific to a scan, and both are LOUD rather than a short
   * result that reads complete: the peer's terminal page arriving with the
   * anchor still unfound (it is gone), and {@link MAX_ANCHOR_SCAN_PAGES} pages
   * spent without finding it. The ceiling counts COLLECTED items, so a scan's
   * discarded pages do not spend the caller's `limit`.
   *
   * `deadline` (issue #21) is the ANSWER's own budget, and it is the one bound
   * that stops the walk GRACEFULLY: a spent budget returns what was collected
   * with `'deadline'` as the reason and the page position it was about to ask
   * for as the stop point. Every other bound here either throws (a peer fault)
   * or returns a caller-attributed truncation; this one returns a TIME
   * attribution, because neither the caller nor the peer did anything wrong.
   * The budget is re-judged BEFORE each request (so a spent one is not spent on
   * the wire) and is handed to the request itself, where the transport clamps
   * the request's own timeout to it and refuses to wait past it for a reconnect.
   */
  async #aggregate<T>(
    connection: DeviceConnection,
    method: string,
    params: Record<string, unknown>,
    extract: (page: Record<string, unknown>) => { items: T[]; nextCursor: unknown; dropped?: number },
    walk: AggregateWalk<T>,
  ): Promise<CherryPage<T>> {
    const {
      limit,
      safetyBound = MAX_AGGREGATE_LIMIT,
      maxPerPage = LIST_PAGE_CLAMP,
      resume,
      deadline,
    } = walk
    const negotiated = Math.max(1, Math.floor(connection.limits.pageItems || PAGE_ITEMS_FALLBACK))
    // The byte-safe clamp intersects the negotiated one: a peer that already
    // pages smaller keeps its size, and no page request ever exceeds either.
    const pageItems = Math.min(negotiated, Math.max(1, Math.floor(maxPerPage)))
    // `limit` may be Infinity (a walk with NO caller bound), so the two
    // ceilings are intersected rather than maxed: the effective stop is
    // whichever binds first, and Infinity simply never binds.
    const aggregate = Math.max(1, Math.floor(limit))
    const bound = Math.max(1, Math.floor(safetyBound))
    const ceiling = Math.min(aggregate, bound)
    // WHICH ceiling the stop is attributed to. The caller's limit is the
    // constraint only when it is STRICTLY below the safety bound; at or above
    // it, the walk stops because of the internal breaker, and saying 'limit'
    // would tell the caller "you asked for this many" about a bound they never
    // set. The equality case is the one that matters: `limit === safetyBound`
    // must read as 'safety-bound', because that is the only reason the walk is
    // not allowed to continue. An unbounded walk (`limit: Infinity`) is always
    // the safety bound.
    const bindsCallerLimit = aggregate < bound
    const items: T[] = []
    // WHERE THE WALK BEGINS. A `cursor` resume seeds the FIRST request; an
    // `anchor` resume starts cursorless (there is no protocol cursor for
    // "after message X") and scans forward until it has met its anchor.
    let cursor: string | undefined = resume?.kind === 'cursor' ? resume.cursor : undefined
    // The anchor still owed an id, or `undefined` once collection started. The
    // scan below only ever compares ids, never the peer's cursor format.
    let pendingAnchor: string | undefined = resume?.kind === 'anchor' ? resume.messageId : undefined
    let scannedPages = 0
    let emptyPages = 0
    // Non-record items this walk dropped. Reported ONCE for the walk (the
    // warning says WHICH method, which a per-page line would repeat), and
    // consulted again on a terminal page (see the fail-loud check below).
    let droppedTotal = 0
    // Every cursor this walk has been HANDED back, so a loop of any length is
    // caught: the advance check below can only see a cursor that repeats
    // IMMEDIATELY, and a longer cycle (A → B → A) would otherwise spin to the
    // page backstop — thousands of RPCs spent to learn what one Set lookup
    // answers on the second visit. Bounded by the backstop for the same reason.
    const seen = new Set<string>()

    for (let pages = 0; ; pages += 1) {
      // THE ANSWER'S OWN BUDGET, judged BEFORE the request rather than instead
      // of one: a spent deadline must not spend an admission, a round trip and
      // a reconnect wait on a request whose answer could not be used. Re-judged
      // here on every page for the same reason the transport re-judges it after
      // its pacing admission — every wait in between is charged to the budget.
      //
      // ORDERED BEFORE THE CEILING CHECK on purpose: when the budget and the
      // caller's `limit` bind at the same item, `'deadline'` is reported. Both
      // are true, but the deadline is the one that would stop the NEXT answer
      // too, and `'limit'` would send the caller to raise a bound that cannot
      // help. (Neither is wrong to re-ask: the stop point is emitted either way.)
      if (deadline !== undefined && deadline.expired()) {
        return this.#truncated(items, 'deadline', cursor)
      }
      if (items.length >= ceiling) {
        // Which ceiling stopped it decides how the caller reads the result.
        //
        // BOUNDARY (honest, not exact): `'limit'` is ALSO reported when the
        // caller's limit lands exactly on the peer's last item — at that point
        // the two cases are indistinguishable from here, because the walk
        // stops before it ever learns whether a further page existed. The
        // conservative reading is the right one for a caller: "there may be
        // more" is safe to re-ask, whereas a false "complete" is not.
        return this.#truncated(items, bindsCallerLimit ? 'limit' : 'safety-bound', cursor)
      }
      if (pages >= MAX_AGGREGATE_PAGES) {
        throw new Error(
          `${method} did not terminate within ${MAX_AGGREGATE_PAGES} page(s) for ${JSON.stringify(params)}`,
        )
      }
      // A SCAN is bounded too, and far tighter: it exists to walk back to a
      // message this bridge itself handed out, so a walk that cannot find it
      // within {@link MAX_ANCHOR_SCAN_PAGES} pages is chasing a session it
      // should not chase. Thrown, like every other bound.
      if (pendingAnchor !== undefined && scannedPages >= MAX_ANCHOR_SCAN_PAGES) {
        throw new Error(
          `${method}: could not find resume anchor message ${JSON.stringify(pendingAnchor)} within ` +
            `${MAX_ANCHOR_SCAN_PAGES} page(s) for ${JSON.stringify(params)}`,
        )
      }
      const request: Record<string, unknown> = {
        ...params,
        // The per-page clamp: never more than one page's worth, whatever the
        // remaining aggregate says.
        //
        // A SCAN asks for a FULL page regardless (review P3-1). While the anchor
        // is still owed nothing is collected, so `ceiling - items.length` would
        // be the CALLER's remaining `limit` — and a caller resuming with
        // `limit: 1` (the documented "walk it in successive answers" pattern)
        // would then walk the history ONE ITEM PER PAGE, spending
        // {@link MAX_ANCHOR_SCAN_PAGES} on a history a full page reaches in
        // dozens. The scan's items are discarded either way, so the wider page
        // costs nothing and is what the page bound is derived against.
        limit: pendingAnchor === undefined ? Math.min(ceiling - items.length, pageItems) : pageItems,
      }
      if (cursor !== undefined) request['cursor'] = cursor
      let result: Record<string, unknown>
      try {
        result = (await connection.rpc.request(
          method,
          request,
          deadline === undefined ? undefined : { deadline: deadline.instant },
        )) as Record<string, unknown>
      } catch (error) {
        // A request that died OF THE BUDGET is a STOP, not a failure: the
        // transport reports the spent deadline as one of these two classes
        // (its own request timeout, or a refused replay), and both mean "no
        // further attempt was possible", not "the peer or the link misbehaved".
        // Converting them is what keeps the content already collected — a
        // timeout answer exists to hand back partial content, so turning it
        // into the stub receipt would throw away the very thing it promises.
        //
        // NOTHING ELSE is converted, deliberately: a peer refusal, an offline
        // device or an integrity failure after the deadline is still a real
        // verdict about something else, and reporting it as `'deadline'` would
        // send the caller looking at their own clock.
        if (deadline !== undefined && deadlineExhaustion(error)) {
          return this.#truncated(items, 'deadline', cursor)
        }
        throw error
      }
      const extracted = extract(result)
      const dropped = extracted.dropped ?? 0
      if (dropped > 0 && droppedTotal === 0) {
        // Once per walk, and the ITEMS themselves never reach the log: a peer
        // that answers with garbage may answer with payload-shaped garbage.
        console.warn(
          `[cherry-remote] ${method} dropped ${dropped} non-record items from a page ` +
            `for ${JSON.stringify(params)}; they cannot be projected as entries`,
        )
      }
      droppedTotal += dropped
      // The ANCHOR SCAN (issue #26): while the anchor is still owed, items are
      // compared by id and discarded. The item that IS the anchor is not
      // collected either — the resume is "strictly older than it". A page that
      // does not contain it is discarded WHOLE and the walk continues; the
      // page's own `emptyPages` bookkeeping below deliberately keeps counting
      // the RAW `extracted.items`, so a discarded NON-empty page reads as
      // progress (it is) and only a genuinely empty page extends the run.
      let start = 0
      if (pendingAnchor !== undefined) {
        const found = extracted.items.findIndex((item) => resume?.kind === 'anchor' && resume.idOf(item) === pendingAnchor)
        if (found >= 0) {
          pendingAnchor = undefined
          start = found + 1
        } else {
          start = extracted.items.length
        }
      }
      let consumed = start
      for (; consumed < extracted.items.length; consumed += 1) {
        if (items.length >= ceiling) break
        items.push(extracted.items[consumed] as T)
      }
      // THE PEER SERVED MORE THAN THIS WALK ASKED FOR (review P2-2). `limit` is
      // a MAXIMUM on a list method, so an overshooting page is a peer fault —
      // but one this walk can absorb without losing anything, which is why it is
      // NOT thrown like the stuck/cycling cursors below. What it must not do is
      // fall through to the normal paths, because BOTH of them would misreport:
      //
      //  - the loop-top ceiling check of the next iteration would report THIS
      //    page's `nextCursor`, a position past items the walk never collected —
      //    and that position is now a resume token, so it would skip them;
      //  - a terminal overshooting page (`nextCursor: null`) would be returned
      //    as `truncated: false`, presenting a short result as the complete one.
      //
      // So the walk stops HERE, with the attribution the ceiling check would
      // have given, and re-uses the position it SENT for this page: resuming
      // from it re-reads the page (duplicates, never a gap), and
      // {@link messageResumeToken} prefers the exact `after:` anchor anyway.
      if (consumed < extracted.items.length) {
        return this.#truncated(items, bindsCallerLimit ? 'limit' : 'safety-bound', cursor, true)
      }
      const next = extracted.nextCursor
      if (next === null || next === undefined) {
        // A terminal page that OFFERED items and had every one of them dropped
        // is not "an empty last page": the answers contradict each other, and
        // returning what was collected would present a short result as the
        // complete one. Refused with the count, like a stuck cursor.
        if (dropped > 0 && extracted.items.length === 0) {
          throw new Error(
            `${method}: peer returned ${dropped} non-record items that were dropped from its terminal ` +
              `page (nextCursor null) for ${JSON.stringify(params)}; refusing a silently short result`,
          )
        }
        if (pendingAnchor !== undefined) {
          // The peer says there is no more history and the anchor was not on
          // any page of it. Answering "nothing older" would be a measured
          // claim about history this walk could not even locate, and the most
          // likely truth is the opposite: the message is GONE (deleted, or the
          // session was replaced). Loud, with the recovery.
          throw new Error(
            `${method}: resume anchor message ${JSON.stringify(pendingAnchor)} was not found before the ` +
              `peer's last page for ${JSON.stringify(params)}; the message is probably gone — re-read ` +
              'from the newest message (omit `messagesResumeCursor`) instead of resuming from it',
          )
        }
        return { items, truncated: false }
      }
      const advanced = String(next)
      // A cursor that does not move is zero progress whatever the page held, so
      // this is checked FIRST: when an empty page also echoes the cursor it was
      // sent, "did not advance" is the precise diagnosis and the empty-page run
      // would only describe the symptom.
      if (advanced === cursor) {
        throw new Error(
          `${method} did not advance its cursor (stuck at ${advanced}) for ${JSON.stringify(params)}`,
        )
      }
      if (seen.has(advanced)) {
        throw new Error(
          `${method} cycled back to cursor ${advanced} it already served for ${JSON.stringify(params)}; ` +
            'refusing to spin on a peer whose pagination loops',
        )
      }
      seen.add(advanced)
      // An empty page that advances the cursor is PROGRESS: the desktop's
      // pinned-list walk answers `{items: [], nextCursor: 'entity:'}` when a pin
      // anchor vanished between requests. Only a RUN of them is a peer fault —
      // no item ceiling can ever be reached, so it is thrown instead of spun
      // on. Any non-empty page resets the run.
      if (pendingAnchor !== undefined) scannedPages += 1
      emptyPages = extracted.items.length === 0 ? emptyPages + 1 : 0
      if (emptyPages >= MAX_CONSECUTIVE_EMPTY_PAGES) {
        throw new Error(
          `${method} answered ${emptyPages} consecutive empty page(s) (last nextCursor ${advanced}) ` +
            `for ${JSON.stringify(params)}; refusing to spin on a peer that makes no progress`,
        )
      }
      cursor = advanced
    }
  }

  /** A stopped aggregate: always says why it stopped and where (stop point). */
  #truncated<T>(
    items: T[],
    reason: CherryTruncationReason,
    cursor: string | undefined,
    pageOverflow?: true,
  ): CherryPage<T> {
    return {
      items,
      truncated: true,
      truncationReason: reason,
      ...(cursor === undefined ? {} : { nextCursor: cursor }),
      ...(pageOverflow === undefined ? {} : { pageOverflow }),
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
          device: { type: 'string', description: 'Optional device selector: exact deviceId, or a unique prefix of a deviceId or display name.' },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const selector = optionalString(args['device'])
        const quarantined = this.#quarantineVerdict()
        if (quarantined !== undefined) return quarantined
        if (selector === undefined) {
          return { devices: this.#deps.store.list().map((record) => this.#deviceView(record)) }
        }
        const selected = this.#selectRecords(selector)
        if (!Array.isArray(selected)) return selected
        return { devices: selected.map((record) => this.#deviceView(record)) }
      },
    })
  }

  /**
   * The `cherry_devices` selector: candidates and a miss beat a throw (ruling
   * ⑤), and the quarantined archive outranks both.
   *
   * The QUARANTINE check comes first and is a real precedence rule, not a
   * formality: a quarantined archive serves an empty view, so every selector
   * misses, and answering "no such device" would describe a store that still
   * holds a valid token on disk as one with nothing paired.
   *
   * `cherry_unpair` shares this, so the quarantine check here is what keeps its
   * `store.remove` from ever being reached on a READ-ONLY archive — the write
   * would refuse and throw `QuarantinedArchiveError` straight out of the tool.
   */
  #selectRecords(
    selector: string,
  ): DeviceRecord[] | CherryAmbiguousDevice | CherryDeviceNotFound | CherryArchiveQuarantined {
    const quarantined = this.#quarantineVerdict()
    if (quarantined !== undefined) return quarantined
    const resolution = this.#deps.store.resolve(selector)
    if ('ambiguous' in resolution) {
      return { error: 'ambiguous-device', device: selector, candidates: resolution.ambiguous }
    }
    if ('notFound' in resolution) return this.#notFoundVerdict(selector)
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
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique prefix of a deviceId or display name.' },
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
          (page) => ({ ...arrayOf(page['items']), nextCursor: page['nextCursor'] }),
          { limit: aggregateLimit(args['limit']) },
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
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique prefix of a deviceId or display name.' },
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
            return { ...arrayOf(result['items']), nextCursor: result['nextCursor'] }
          },
          { limit: aggregateLimit(args['limit']) },
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
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique prefix of a deviceId or display name.' },
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
          (page) => ({ ...arrayOf(page['items']), nextCursor: page['nextCursor'] }),
          { limit: aggregateLimit(args['limit']) },
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
        'sha256-verified through `agent.content.read`. An unchanged message (same message ' +
        'revision) reuses its cached part LIST, fenced by that revision, so a repeated read of a ' +
        'quiet session costs no `agent.parts.list` RPC; externalized content is still fetched ' +
        'and sha256-verified on every read, so unverified bytes are never served from memory. A binary attachment is reported as ' +
        '`kind: "file"` with `name`/`mediaType`/`byteLength` and an EMPTY `content` — the bytes ' +
        'are deliberately not fetched into a text channel. Messages come NEWEST-first, so the ' +
        'first entry is the latest and `limit` drops the OLDEST messages — truncation never cuts ' +
        'inside a retained message\'s parts; a message whose own parts could not be fully read ' +
        'carries `incomplete`, and may carry `unavailableParts` when parts were unreadable. The ' +
        'answer is ALSO bounded by an output budget: `truncated` with `truncationReason: ' +
        '"aggregate-bytes"` means the walk stopped because the result reached its size limit, ' +
        'not because `limit` was reached — raising `limit` does NOT reach the messages left out ' +
        '(it only costs more round trips and stops at the same budget). THE OLDER MESSAGES ARE ' +
        'REACHED BY THE RESUME TOKEN: a truncated answer carries `messagesResumeCursor` whenever a ' +
        'stop point can be named honestly (it is absent when the walk reached the peer\'s last page), and ' +
        'passing it back as `messagesResumeCursor` continues the walk from there (`limit` then ' +
        'bounds how many messages are returned FROM that point). The two token forms are ' +
        '`"cursor:<peer position>"` (the walk consumed its whole page window) and ' +
        '`"after:<messageId>"` (it stopped inside the window; the read restarts at the newest end ' +
        'and resumes strictly after that message). A token this tool did not emit is refused ' +
        'locally rather than forwarded, and an `after:` anchor that no longer exists in the ' +
        'history is an error, not an empty page. A `truncationReason` of "limit" is the caller\'s ' +
        'own ceiling and is reached by raising `limit`. Either way the newest message is always ' +
        'returned whole.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique prefix of a deviceId or display name.' },
          sessionId: { type: 'string', description: 'The session to read.' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_AGGREGATE_LIMIT,
            description:
              'Maximum number of messages to return in total across pages (default 100). Distinct from ' +
              'the output budget: the answer may stop earlier with `truncationReason: "aggregate-bytes"`, ' +
              'which a larger `limit` does not extend — the resume token is how older messages are reached.',
          },
          messagesResumeCursor: {
            type: 'string',
            description:
              'A `messagesResumeCursor` a previous truncated read (this tool, or cherry_send/cherry_wait) ' +
              'returned: `"cursor:<peer position>"` or `"after:<messageId>"`. Continues the walk at that ' +
              'stop point instead of at the newest message; `limit` bounds what comes back from there. ' +
              'Omit it to read from the newest message.',
          },
        },
        required: ['device', 'sessionId'],
        additionalProperties: false,
      },
      execute: async (args) => {
        // BEFORE any device work: a token is judged here, so a bad argument
        // never dials a device and never reaches the peer with an unvetted
        // cursor. The real desktop SILENTLY falls back to the newest page for
        // a malformed cursor, which would present the newest page again as
        // "continued history" — the refusal has to be ours.
        const resume = parseMessageResume(args['messagesResumeCursor'])
        const resolved = this.#linkOr(requiredString(args, 'device'))
        if (resolved.link === undefined) return resolved.verdict
        const { connection, record } = resolved.link
        const sessionId = requiredString(args, 'sessionId')
        const limit = aggregateLimit(args['limit'])

        // First-use ensure (spec §3.5): reading a session's history depends on
        // the subscription cache, so the session joins the same LRU pool the
        // send/wait tools use. A live subscription is left exactly as it is.
        await this.#ensureSubscription(record.deviceId, sessionId)

        return this.#readRound(connection, sessionId, limit, true, resume)
      },
    })
  }

  /**
   * ONE read round: re-pull the baseline, then list and project everything.
   *
   * `retryOnExpiry` implements the §6 REVISION_EXPIRED rule — a stale revision
   * re-pulls the baseline (`sessions.get` → `messages.list`) and retries the
   * WHOLE round ONCE. A second expiry is surfaced unchanged, so a peer whose
   * revisions never settle cannot loop the caller. `resume` travels with the
   * retry: the retry re-pulls the baseline because the history MOVED under the
   * walk, and the caller asked for the history after a position, not for one
   * particular attempt at it.
   */
  async #readRound(
    connection: DeviceConnection,
    sessionId: string,
    limit: number,
    retryOnExpiry: boolean,
    resume?: MessageResume,
  ): Promise<CherryReadSnapshot> {
    try {
      return await this.#readOnce(connection, sessionId, limit, resume)
    } catch (error) {
      if (retryOnExpiry && failureReason(error) === 'REVISION_EXPIRED') {
        console.warn(
          `[cherry-remote] session ${sessionId} history revision expired; re-pulling the baseline and retrying once`,
        )
        return this.#readRound(connection, sessionId, limit, false, resume)
      }
      throw error
    }
  }

  /**
   * One read round, bounded on TWO arms: the caller's `limit` (a message
   * count) and {@link AGGREGATE_BYTES} (the projected messages' size).
   *
   * The byte arm is the terminal faces' budget applied to this walk (issue
   * #29). Without it the COUNT was the only bound, so `cherry_read(limit:
   * 1000)` over a fat session paid for every message, every part and every
   * externalized content read before producing an answer of tens of megabytes
   * that the MCP boundary rejects — the caller lost the verdict along with the
   * content. The guarantees are the terminal walk's, restated:
   *
   *  - the budget is checked only AFTER a message is fully projected, so what a
   *    stop leaves out is the OLDER end and {@link CherryReadSnapshot.messages}
   *    are all returned WHOLE — the newest first, already taken before any
   *    check runs;
   *  - a stop is SURFACED (`truncated` + `truncationReason`), never silent;
   *  - the reason is `'aggregate-bytes'`, the terminal face's own member. It is
   *    NOT `'limit'`: the caller set no such limit, and telling them to raise
   *    one they already set above the budget would teach a remedy that cannot
   *    work (see {@link CherryReadSnapshot.messagesResumeCursor}).
   *
   * The verdict describes the walk that ACTUALLY happened, so the page
   * aggregate's own verdict is only inherited when the byte arm did not fire —
   * a walk the budget cut is not the page aggregate's `'limit'`/`'safety-bound'`
   * stop, even when the page aggregate also ran out.
   *
   * `resume` is where this walk starts (issue #26; absent = the newest
   * message). It is handed to `#aggregate` as the walk's own starting point, so
   * `limit` bounds what comes back FROM there, and the stop point is derived
   * from where THIS walk ended — never from the caller's token. That is what
   * makes repeated resumes a chain rather than a loop.
   */
  async #readOnce(
    connection: DeviceConnection,
    sessionId: string,
    limit: number,
    resume?: MessageResume,
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
      (result) => ({ ...arrayOf(result['items']), nextCursor: result['nextCursor'] }),
      {
        limit,
        safetyBound: MAX_AGGREGATE_LIMIT,
        maxPerPage: LIST_PAGE_CLAMP,
        resume:
          resume === undefined
            ? undefined
            : resume.kind === 'cursor'
              ? { kind: 'cursor', cursor: resume.cursor }
              : {
                  kind: 'anchor',
                  messageId: resume.messageId,
                  // `messageIdOf` — the SAME reading `#projectMessage` prints, so
                  // this bridge can never emit an `after:` anchor its own scan
                  // cannot match. An item with no id reads as `''` and can never
                  // BE the anchor.
                  idOf: (raw) => {
                    const id = messageIdOf(raw)
                    return id === '' ? undefined : id
                  },
                },
      },
    )

    const messages: CherryReadMessage[] = []
    let projectedBytes = 0
    let outOfBudget = false
    for (const raw of page.items) {
      const message = await this.#projectMessage(connection, sessionId, raw)
      messages.push(message)
      projectedBytes += JSON.stringify(message).length
      // AFTER the message is complete — the budget trims what comes NEXT, never
      // what has already been taken, so `messages[0]` is always whole.
      if (projectedBytes >= AGGREGATE_BYTES) {
        outOfBudget = true
        break
      }
    }
    // A BYTE stop is truncation only when messages were LEFT BEHIND: spending
    // the budget on the peer's last message is a complete walk (same boundary
    // rule as the terminal walk).
    const exhausted = outOfBudget && (messages.length < page.items.length || page.truncated)
    const truncated = exhausted || page.truncated
    const truncationReason: CherryTruncationReason | undefined = exhausted
      ? 'aggregate-bytes'
      : page.truncationReason
    // The stop point, in the ONE vocabulary both message-walk faces use
    // ({@link messageResumeToken}). The last RETURNED message is the anchor
    // when the walk stopped inside its collected window; otherwise the page's
    // own position is the stop.
    const resumeToken = messageResumeToken(page, messages.length, messages[messages.length - 1]?.messageId)
    return {
      session,
      messages,
      truncated,
      ...(truncationReason === undefined ? {} : { truncationReason }),
      // Only a TRUNCATED walk has unread history, and the token then marks the
      // stop point (OLDER messages remain unread) —
      // {@link CherryReadSnapshot.messagesResumeCursor}. When the walk's own
      // verdict names no stop (it reached the peer's last page AND returned
      // every message it collected) the key is OMITTED rather than emitted
      // undefined: the absence says "nothing older left", the `truncated` flag
      // still says whether the walk was cut.
      ...(truncated && resumeToken !== undefined ? { messagesResumeCursor: resumeToken } : {}),
    }
  }

  /**
   * One message: obtain its parts under the message's OWN revision, then resolve
   * each part's content.
   *
   * THE ONE PROJECTION every face uses (`cherry_read` and the terminal/timeout/
   * idle aggregates), which is why the read cache lives HERE and nowhere else:
   * the parts lookup is at the top, the store right after a miss, and no caller
   * keeps a second path.
   *
   * TWO STEPS, and the cache sits between them on purpose:
   *
   *  1. THE LIST — the parts RECORDS, from `agent.parts.list` or, on a hit, from
   *     the cached page ({@link CherryToolEngine.#cachedPartsPage}). Fenced by
   *     the row's message revision, which is the peer's own rule (it refuses
   *     `agent.parts.list` with `REVISION_EXPIRED` for a stale
   *     `messageRevision`). A hit is therefore the list a fresh walk would have
   *     returned UNDER THAT RULE — no stronger: the revision is
   *     `String(Date.parse(updatedAt))`, a millisecond clock, so two writes
   *     inside one millisecond keep the revision equal while the parts differ.
   *     That is the protocol's own assumption about the fence, shared by every
   *     revision-checked operation, not something the cache introduces.
   *  2. THE PROJECTION — {@link CherryToolEngine.#projectPart} over those
   *     records, which fetches and sha256-verifies every `{ref}`. This step runs
   *     on EVERY read, hit or miss: the revision fence says nothing about the
   *     content store behind a ref, so the cache must never be able to serve
   *     unverified bytes. A missed re-walk therefore costs one
   *     `agent.parts.list`; a hit costs zero of those and still pays every
   *     content read it owes.
   */
  async #projectMessage(
    connection: DeviceConnection,
    sessionId: string,
    raw: Record<string, unknown>,
    deadline?: AssemblyDeadline,
  ): Promise<CherryReadMessage> {
    const messageId = messageIdOf(raw)
    const revision = String(raw['revision'] ?? '')
    // FENCED BY THE PEER'S OWN REVISION: the row just served by
    // `agent.messages.list` is the fence, so a hit is the list the walk below
    // would have returned under that same rule (a stale revision would be
    // REVISION_EXPIRED at the peer, not a different answer). The rule's own
    // resolution is a millisecond timestamp, and that limit is the PEER's —
    // shared with every other revision-checked operation, not added here.
    let page = this.#cachedPartsPage(connection.record.deviceId, messageId, revision)
    if (page === undefined) {
      // A message's parts are read to COMPLETION: the caller's `limit` bounds
      // MESSAGES, so any part budget here would drop content from the snapshot.
      // The walk therefore runs until the peer reports `nextCursor: null`, with
      // `DEFAULT_PARTS_SAFETY_BOUND` as a pure circuit-breaker against a peer
      // that never terminates — and tripping it is reported, never silent.
      page = await this.#aggregate(
        connection,
        'agent.parts.list',
        { sessionId, messageId, messageRevision: revision },
        (result) => ({ ...arrayOf(result['items']), nextCursor: result['nextCursor'] }),
        {
          limit: Number.POSITIVE_INFINITY,
          safetyBound: this.#partsSafetyBound,
          // Parts records are the fattest per item (inline text), so they ride
          // the tightest derived clamp.
          maxPerPage: PARTS_LIST_PAGE_CLAMP,
          // A wait answer's budget reaches the parts walk too (issue #21): a
          // message's parts are read to COMPLETION, so without this a single fat
          // message could outlive the whole answer. A deadline stop returns the
          // parts read so far and marks the message `incomplete`
          // (`partsTruncated: 'deadline'`), never a silently short list.
          deadline,
        },
      )
      // The REFUSAL list lives in the store (`#rememberPartsPage`), the one
      // place it can be enforced for every current and future caller. The walk's
      // own RESULT is what is held — not the projection built below, whose
      // `{ref}` text is re-resolved and re-verified on every read.
      this.#rememberPartsPage(connection.record.deviceId, messageId, revision, page)
    }

    const parts: CherryReadPart[] = []
    for (const part of page.items) {
      parts.push(await this.#projectPart(connection, sessionId, part, deadline))
    }
    const partsTruncated = page.truncated ? (page.truncationReason ?? 'safety-bound') : undefined
    // The message-level completeness verdict is set HERE, the one projection
    // every face shares (`cherry_read` and the three terminal aggregates), so
    // no caller can be told a different story by a different tool about the
    // same message. Two ways to be incomplete, counted separately: parts that
    // failed keep `unavailable` (the count says how many), a circuit-broken
    // walk has no failing part at all — its list is merely short — so the count
    // stays absent rather than claiming a zero.
    const unavailableParts = parts.filter((part) => part.unavailable !== undefined).length
    const incomplete = unavailableParts > 0 || partsTruncated !== undefined
    return {
      messageId,
      revision,
      role: String(raw['role'] ?? ''),
      status: String(raw['status'] ?? ''),
      parts,
      // A circuit-broken part list advertises itself: the caller can see that
      // this message is incomplete and that later parts are still unread, so
      // content is never dropped silently. `partsResumeCursor` below is that
      // stop point — a marker, not an input (see the field's docblock; the
      // message faces' stop point IS an input, this one is not).
      ...(partsTruncated === undefined
        ? {}
        : {
            partsTruncated,
            ...(page.nextCursor === undefined ? {} : { partsResumeCursor: page.nextCursor }),
          }),
      ...(incomplete ? { incomplete: true as const } : {}),
      ...(unavailableParts > 0 ? { unavailableParts } : {}),
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
    deadline?: AssemblyDeadline,
  ): Promise<CherryReadPart> {
    const partId = String(raw['partId'] ?? '')
    const revision = String(raw['revision'] ?? '')
    const kind = String(raw['kind'] ?? '')
    const content = isRecord(raw['content']) ? raw['content'] : {}

    // A FILE PART IS NEVER RESOLVED AS TEXT, whatever shape its reference
    // takes. Cherry ≥ 2.1.5 projects an uploaded attachment as
    // `{kind: 'file', name, ref}` — a TOP-LEVEL `ref`, no `content` at all —
    // and `agent.content.read` really will serve those bytes. They are FILE
    // bytes: this projection hands text to a model, so resolving them would
    // decode binary as UTF-8 and pull megabytes into the context window. The
    // honest face is the file's METADATA with an empty body.
    //
    // (`{ref}` nested under `content` on a `file` part is not the real peer's
    // shape, but it is schema-legal — `partSchema`'s file variant is a loose
    // object — and the same rule is the safe one for it.)
    if (kind === 'file') {
      return {
        partId,
        kind,
        revision,
        content: '',
        ...this.#attachmentFace(kind, raw, content),
        ...(typeof raw['state'] === 'string' ? { state: raw['state'] } : {}),
        ...(typeof raw['toolName'] === 'string' ? { toolName: raw['toolName'] } : {}),
        ...(typeof raw['toolCallId'] === 'string' ? { toolCallId: raw['toolCallId'] } : {}),
      }
    }

    let text: string
    if (typeof content['text'] === 'string') {
      text = content['text']
    } else if (isRecord(content['ref'])) {
      // PER-PART DEGRADATION (bounded failure). One `{ref}` the peer will not
      // serve costs THIS part's text, not the whole snapshot: a read is a page
      // of history, and a failed content pin (an expired lease, a transient
      // fault) would otherwise make every other message in the same page
      // unreachable. The part stays in the result with `unavailable` naming the
      // fault, so the loss is VISIBLE rather than silent.
      // ONE PROCESS-WIDE SLOT for the WHOLE assembly (issue #39): slices,
      // digest, decode — the window in which the ~3× transient peak exists. The
      // slot is released on EVERY path, including a degradable per-part failure
      // (`finally`), so a peer's refusal cannot leak capacity.
      //
      // A wait for the slot is part of the answer's budget: `acquire` abandons
      // a queued caller at its deadline (`ContentGateTimeoutError`), which the
      // catch below degrades to this part's `unavailable` — the same class as a
      // content read the budget cut. Once the walk is RUNNING it is not
      // interrupted here; its per-slice requests carry the same deadline to the
      // transport, which is where the I/O actually stops.
      let releaseSlot: (() => void) | undefined
      try {
        releaseSlot = await this.#contentGate.acquire(deadline?.instant)
        text = await this.#readExternalized(connection, sessionId, content['ref'], deadline)
      } catch (error) {
        // An INTEGRITY failure is not degradable: see `#degradableReadFailure`.
        if (!this.#degradableReadFailure(error)) throw error
        return {
          partId,
          kind,
          revision,
          content: '',
          unavailable: unavailableReason(error),
          ...(typeof raw['state'] === 'string' ? { state: raw['state'] } : {}),
          ...(typeof raw['toolName'] === 'string' ? { toolName: raw['toolName'] } : {}),
          ...(typeof raw['toolCallId'] === 'string' ? { toolCallId: raw['toolCallId'] } : {}),
        }
      } finally {
        releaseSlot?.()
      }
    } else {
      text = ''
    }

    return {
      partId,
      kind,
      revision,
      content: text,
      // Pre-2.1.5 peers (2.1.4 is inside the verified range) projected a file
      // as a `data` part whose metadata sits INSIDE `content`; lifting it here
      // is what keeps an attachment from degrading into an anonymous empty
      // part across the peer upgrade.
      ...this.#attachmentFace(kind, raw, content),
      ...(typeof raw['state'] === 'string' ? { state: raw['state'] } : {}),
      ...(typeof raw['toolName'] === 'string' ? { toolName: raw['toolName'] } : {}),
      ...(typeof raw['toolCallId'] === 'string' ? { toolCallId: raw['toolCallId'] } : {}),
    }
  }

  /**
   * The descriptive metadata of an attachment part — and deliberately NOT a
   * way to reach its bytes.
   *
   * Two peer generations are covered, because both are inside the verified
   * range and they disagree about where the metadata lives:
   *
   *  - **Cherry ≥ 2.1.5** — `{kind: 'file', name, ref}`, ref at the TOP level.
   *  - **Cherry 2.1.4** — `{kind: 'data', name, content: {mediaType, filename}}`.
   *
   * Only string fields are lifted: a null `filename` (the peer's explicit "no
   * name") stays absent rather than becoming the string "null". Anything a
   * caller needs beyond this — the bytes — stays behind `agent.content.read`,
   * which this plugin does not call for a file part.
   */
  #attachmentFace(
    kind: string,
    raw: Record<string, unknown>,
    content: Record<string, unknown>,
  ): { name?: string; mediaType?: string; byteLength?: string } {
    if (kind !== 'file' && kind !== 'data') return {}
    const ref = isRecord(raw['ref']) ? raw['ref'] : isRecord(content['ref']) ? content['ref'] : {}
    // WHERE the name lives is part of the shape, not a matter of preference: on
    // a `file` part `name` IS the filename, while a `data` part's `name` is the
    // data KIND label — the 2.1.4 projection passes the literal `'file'` there —
    // so the filename can only come from `content.filename`. Reading `name` for
    // the data kind would report "file" as the attachment's name.
    const name = kind === 'file' ? optionalString(raw['name']) : optionalString(content['filename'])
    const mediaType = optionalString(ref['mediaType']) ?? optionalString(content['mediaType'])
    const byteLength = optionalString(ref['byteLength'])
    return {
      ...(name === undefined ? {} : { name }),
      ...(mediaType === undefined ? {} : { mediaType }),
      ...(byteLength === undefined ? {} : { byteLength }),
    }
  }

  /**
   * Whether one `{ref}` read failure may DEGRADE (the part is marked
   * unavailable) rather than fail the whole `cherry_read`.
   *
   * The line is drawn at WHO COULD BE TRUSTED, not at how inconvenient the
   * failure is:
   *
   *  - **Degradable** — the peer refused or could not complete the read: a
   *    `NOT_FOUND` pin, a transient RPC failure, a non-advancing cursor. Nothing
   *    was returned, so there is nothing to misreport; the honest report is
   *    "this part's text could not be read", and the rest of the snapshot is
   *    still exactly what the peer said it was.
   *  - **NOT degradable — an INTEGRITY failure.** The peer DID answer and the
   *    reassembled bytes do NOT match the digest the ref advertises. Those bytes
   *    are provably not the content the ref describes, so degrading would hand
   *    back a snapshot that looks complete while containing content the peer
   *    never certified. That is worse than an error: the caller cannot tell it
   *    apart from a good read. It keeps failing loudly.
   *
   * The discriminator is the DIGEST CHECK specifically, which is why
   * {@link CherryToolEngine.#readExternalized} marks it: matching on message
   * text would break the moment the wording changed.
   */
  #degradableReadFailure(error: unknown): boolean {
    return !(error instanceof ContentIntegrityError)
  }

  /**
   * Paginate `agent.content.read` over one `{ref}` and verify its sha256.
   *
   * The digest is checked against BOTH its sources (the ref's declaration and
   * the slices' own reports), which must agree when both are present, and the
   * certified bytes must then decode as legal UTF-8 — a digest certifies bytes,
   * not text.
   *
   * THE MEMORY CONTRACT (issue #7). {@link MAX_EXTERNALIZED_BYTES} caps ONE
   * ref, and this walk holds its content at roughly 3x that cap at its peak:
   * the decoded slice buffers, the single concatenation the digest and the
   * decoder both need, and the decoded string handed back. Three copies is the
   * price of never hashing or decoding a buffer that the caller could mutate,
   * and it is paid ONE REF AT A TIME by this engine's walks — messages and
   * parts are projected sequentially, so an aggregate's own peak is one ref's.
   * It is NOT a process-wide bound: independent reads (separate tool calls)
   * in flight together multiply the peak by their count. A global gate or
   * budget is a separate concern, deliberately outside this walk.
   */
  async #readExternalized(
    connection: DeviceConnection,
    sessionId: string,
    ref: Record<string, unknown>,
    deadline?: AssemblyDeadline,
  ): Promise<string> {
    const contentId = String(ref['contentId'] ?? '')
    const revision = String(ref['revision'] ?? '')
    const declaredSha = typeof ref['sha256'] === 'string' ? ref['sha256'] : undefined
    // The advertised byte length bounds the walk honestly: the peer declares it
    // on the ref, so a read that needs more slices than the content can hold is
    // a peer fault, not a reason to return a partial (and unverifiable) value.
    const declaredBytes = Number(ref['byteLength'])
    // The declared length bounds the walk honestly, but only up to the absolute
    // cap: past it the walk is refused BEFORE any round trip (see
    // MAX_EXTERNALIZED_BYTES). This is the degradable class — a plain Error, so
    // the part is marked unavailable instead of failing the read.
    if (Number.isFinite(declaredBytes) && declaredBytes > this.#externalizedByteCap) {
      throw new Error(
        `{ref} ${contentId} declares ${declaredBytes} bytes, above the ${this.#externalizedByteCap}-byte limit ` +
          'for externalized content; not read',
      )
    }
    const maxSlices = Number.isSafeInteger(declaredBytes)
      ? Math.max(1, Math.ceil(declaredBytes / CONTENT_READ_MAX_BYTES))
      : DEFAULT_CONTENT_SLICE_BOUND

    let offset = '0'
    let sha: string | undefined
    let complete = false
    let read = 0
    // BYTES, never text: a 24 KiB slice boundary lands inside a multi-byte
    // character often enough to matter, and decoding each slice on its own turns
    // the split character into U+FFFD in BOTH halves — while the digest, which
    // covers the raw bytes, still matches. The bytes are decoded ONCE at the end
    // (the official client does the same), so the walk cannot corrupt text it
    // has certified.
    const chunks: Buffer[] = []
    const hash = createHash('sha256')
    for (let sliceIndex = 0; sliceIndex < maxSlices; sliceIndex += 1) {
      // The slice walk is bounded by the answer's budget like every other
      // request it makes (issue #21). A slice that cannot be read in time makes
      // this ONE part `unavailable` — the degradable class — because the
      // reassembled bytes could not be verified; the rest of the snapshot is
      // still exactly what the peer said, and the message is flagged
      // `incomplete` by the ordinary projection.
      const slice = (await connection.rpc.request(
        'agent.content.read',
        {
          sessionId,
          contentId,
          revision,
          offset,
          maxBytes: CONTENT_READ_MAX_BYTES,
        },
        deadline === undefined ? undefined : { deadline: deadline.instant },
      )) as Record<string, unknown>
      const data = typeof slice['dataBase64'] === 'string' ? slice['dataBase64'] : ''
      // The cap is checked on the base64 LENGTH first, before the decode: a
      // slice may carry any size a hostile peer puts in one frame, and decoding
      // it just to measure it is the memory exposure the cap exists to bound.
      // ceil(len/4)*3 is the exact byte count for unpadded base64 and errs high
      // by at most the padding — the safe direction for a ceiling.
      const cap = this.#externalizedByteCap
      if (read + Math.ceil(data.length / 4) * 3 > cap + 2) {
        throw new Error(
          `agent.content.read for ${contentId} exceeded the ${cap}-byte limit ` +
            'for externalized content; not read',
        )
      }
      const chunk = Buffer.from(data, 'base64')
      // PER SLICE, not once at the end: `sha` below keeps only the LAST
      // slice's report, so a single end-of-walk check would let a peer echo a
      // different digest on every EARLY slice and still be certified by an
      // honest final one. The official client compares `page.sha256` against
      // the ref's on EVERY slice; this does the same, against the ref's
      // declaration only (a slice cannot referee itself), and only when both
      // values are present — the end-of-walk check covers what remains.
      const sliceSha = typeof slice['sha256'] === 'string' ? slice['sha256'] : undefined
      if (sliceSha !== undefined && declaredSha !== undefined && sliceSha !== declaredSha) {
        // Same degradable class as the end-of-walk disagreement below: the
        // content is self-inconsistent, so no certified value exists for it.
        throw new Error(
          `agent.content.read for ${contentId} returned a sha256 at slice ${sliceIndex + 1} ` +
            `(offset ${offset}) that disagrees with the ref (slice ${sliceSha}, ref ${declaredSha}); ` +
            'refusing to certify either',
        )
      }
      hash.update(chunk)
      chunks.push(chunk)
      read += chunk.length
      // The slice budget cannot hold the cap on its own: a ref with no usable
      // `byteLength` falls back to the slice bound, which the peer can fill with
      // more than the cap, and a peer may simply serve more than it declared.
      // Bytes actually read are the only honest measure here.
      if (read > cap) {
        throw new Error(
          `agent.content.read for ${contentId} exceeded the ${cap}-byte limit ` +
            'for externalized content; not read',
        )
      }
      if (typeof slice['sha256'] === 'string') sha = slice['sha256']
      if (slice['eof'] === true) {
        complete = true
        break
      }
      const next = slice['nextOffset']
      if (typeof next !== 'string' || next === offset) {
        // A walk that cannot progress leaves the content INCOMPLETE, and an
        // incomplete content can never pass the digest check below — so this is
        // the integrity class, not a degradable per-part miss.
        throw new ContentIntegrityError(
          `agent.content.read for ${contentId} did not advance (offset ${offset})`,
        )
      }
      offset = next
    }
    // A partial content is never returned: the digest check below could not
    // certify it, so an incomplete walk is a hard failure rather than a
    // silently short read.
    if (!complete) {
      // Same class as the digest mismatch below, and for the same reason: the
      // bytes on hand are not the whole content, so they cannot be certified.
      // Returning them as a "partially available" part would be reporting
      // unverified content as a partial success.
      throw new ContentIntegrityError(
        `agent.content.read for ${contentId} did not reach eof within ${maxSlices} slice(s); refusing to aggregate a partial content`,
      )
    }

    // TWO SOURCES, ONE DIGEST. The ref advertises the digest of the content it
    // describes; every slice reports the digest of what it believes it served.
    // When BOTH are present they must AGREE before either can certify anything:
    // the official client enforces exactly this per slice, because a peer whose
    // two sources disagree is self-inconsistent — one of them is describing
    // different bytes — so neither can be trusted as the verification target.
    // Preferring one (`sha ?? declaredSha`) would certify such a peer. (Only
    // one source present keeps the previous behaviour: use what the peer
    // offers.)
    if (sha !== undefined && declaredSha !== undefined && sha !== declaredSha) {
      // Degradable, NOT fatal: unlike a digest mismatch, no bytes are being
      // reported under a dishonest certificate — there is simply no single
      // certified value here. The part loses its text and says so.
      throw new Error(
        `agent.content.read for ${contentId} returned a sha256 that disagrees with the ref ` +
          `(slice ${sha}, ref ${declaredSha}); refusing to certify either`,
      )
    }
    const expected = sha ?? declaredSha
    if (expected === undefined) {
      // Not degradable either: nothing can verify these bytes, so reporting
      // them as a partial part would be certifying the unverifiable.
      throw new ContentIntegrityError(`agent.content.read for ${contentId} returned no sha256 to verify`)
    }
    const actual = hash.digest('hex')
    if (actual !== expected) {
      // A DIGEST MISMATCH, marked as its own class: the caller must be able to
      // tell "the peer would not serve this" (degradable, per-part) from "the
      // peer served bytes that are not what it promised" (fatal for the read).
      throw new ContentIntegrityError(
        `agent.content.read for ${contentId} failed its sha256 check (expected ${expected}, got ${actual})`,
      )
    }
    // A MATCHING DIGEST CERTIFIES THE BYTES, NOT THEIR LEGALITY. The sha256 says
    // these are the bytes the content is made of; it says nothing about whether
    // those bytes ARE text. A lenient decode would rewrite every illegal
    // sequence to U+FFFD and hand the model substitution characters as though
    // they were the part's content — so the decode is FATAL, and content that
    // is not legal UTF-8 fails like any other unreadable content (degradable,
    // per part) rather than being silently mangled. The decoder also applies
    // the standard encoding rule of DROPPING a leading U+FEFF — what the
    // official reducer's decode does too, and what keeps an invisible zero-width
    // character out of the model's context.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } catch {
      throw new Error(
        `agent.content.read for ${contentId} returned bytes that are not valid UTF-8; not decoded`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // ⑤ cherry_events
  // -------------------------------------------------------------------------

  #eventsTool(): CherryToolDefinition {
    return defineCherryTool({
      name: 'cherry_events',
      description:
        'Read the session\'s buffered events newer than `cursor`, delivering them and then ' +
        'acknowledging the advanced cursor to the peer. While the window has dropped no events, ' +
        'every cursor this plugin handed out is servable, including the baseline ' +
        '`cherry_send`/`cherry_wait` report on an empty window. Once the window DISCARDS events, ' +
        'the boundary it reports is not: that boundary and everything below it answer a structured ' +
        '`cursor-out-of-window` verdict, and only positions strictly past it are served — rebuild ' +
        'the baseline with `cherry_read` and resume from that instead.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique prefix of a deviceId or display name.' },
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
              `the requested cursor is before the cache window start for session ${sessionId}, or at it ` +
              'after the cache discarded events; the window can no longer prove continuity from that ' +
              'position. Use cherry_read to rebuild the baseline, or cherry_events with no cursor to ' +
              'read the whole retained window',
            // Reported even when the caller sent NO cursor: the verdict means
            // the session's cache cannot serve a replay from a provable
            // position, and the boundary is the actionable half of that answer.
            // It reaches TWO states, which are not interchangeable: a cursor
            // strictly BELOW the window start (refused whether or not anything
            // was ever dropped), and a cursor exactly ON a boundary that a drop
            // advanced (refused only because the event there is gone). In the
            // dropped state the reported boundary is the position the verdict
            // just refused, so a caller must resume from the FIRST retained
            // event past it — or rebuild with `cherry_read`; in the
            // nothing-dropped state no at-boundary cursor was refused at all,
            // and the boundary IS the resumable baseline.
            windowStart: this.#windowStart(subscriptions, sessionId),
          } satisfies CherryCursorOutOfWindow
        }

        // ACK AFTER DELIVERY (controller ruling ④): the peer may only advance
        // its view once the caller actually holds these events. A failing ack
        // is logged, never allowed to swallow the delivered events.
        // A FAILING ACK ALSO RE-ENSURES THE SESSION (v0.1.3 UltraReview P3-3).
        // The ack is the peer's verdict on the SUBSCRIPTION, not on the
        // delivery: a refused ack says the cursor is outside the window this
        // subscription is serving, i.e. the stream we are reading is no longer
        // the one we think it is. Logging that alone left the session dead in
        // whatever state caused it, and the NEXT call would fail on the same
        // broken subscription rather than rebuilding it.
        //
        // FIRE-AND-FORGET, deliberately: the caller already holds these events,
        // and the re-ensure is a peer round trip (close + subscribe). Awaiting
        // it would charge the recovery's latency to an answer that is complete
        // without it, and a re-ensure that fails must not turn a successful
        // delivery into an error. The `.catch` is what keeps a REJECTED
        // re-ensure from surfacing as an unhandled rejection.
        try {
          await subscriptions.ack(sessionId, result.nextCursor)
        } catch (error) {
          console.warn(`[cherry-remote] acknowledging session ${sessionId} at ${result.nextCursor.seq} failed`, error)
          this.#reEnsureInBackground(record.deviceId, sessionId)
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
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique prefix of a deviceId or display name.' },
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
        'and, whenever a stop point can be named honestly, a `messagesResumeCursor` token marking ' +
        'where the unread history begins: hand it to `cherry_read` as `messagesResumeCursor` to read ' +
        'the older messages (re-waiting re-reads the newest window). When content is cut, ' +
        '`messagesTruncated`/`messagesTruncationReason` ' +
        'report a MESSAGE-level cut: the OLDER messages were dropped, never part of a returned one — a ' +
        'returned message missing its own parts carries `incomplete`. The reason `deadline` means the ' +
        'ANSWER\'s own assembly budget ran out (your window plus a bounded tail): the content read so ' +
        'far is still returned, and `cherry_read` continues past the stop-point token.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique prefix of a deviceId or display name.' },
          sessionId: { type: 'string', description: 'The session to send into.' },
          text: {
            type: 'string',
            maxLength: TEXT_MAX_LENGTH,
            description:
              `The message text, which must not be blank. At most ${TEXT_MAX_LENGTH} characters ` +
              '(the protocol ceiling).',
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

        // A BLANK BODY IS A LOCAL VERDICT, not a peer error. Cherry ≥ 2.1.5
        // validates `agent.messages.send` with a refine that requires text which
        // TRIMS to something (attachments are the other legal way to carry a
        // send, and this client never sends them), so a whitespace-only body is
        // refused by the peer's schema. Answering here keeps the caller on the
        // plugin's structured verdicts instead of round-tripping a validation
        // error from the wire.
        //
        // Deliberately NOT mirrored as a JSON-Schema `pattern`: `maxLength` is a
        // host-side guard against an unbounded input, while blankness is a
        // semantic rule whose useful answer is this verdict.
        if (text.trim().length === 0) {
          return {
            error: 'text-empty',
            message: 'the message text is empty (or whitespace only); the peer requires a non-blank body.',
          } satisfies Record<string, unknown>
        }

        await this.#ensureSubscription(record.deviceId, sessionId)
        const subscriptions = this.#deps.subs(record.deviceId)

        // The ADMITTED send: its receipt, and the event-buffer cut taken before
        // the command that produced it (see `#admitSend`).
        const { receipt, baselineSeq } = await this.#admitSend(connection, subscriptions, record.deviceId, sessionId, {
          args,
          text,
        })

        if (args['wait'] === false) {
          // The caller asked for the receipt only: hand it back untouched.
          return receipt
        }
        if (receipt['status'] === 'rejected' || receipt['status'] === 'interrupted') {
          // A rejected receipt is the peer's final word on this command; there
          // is no run to wait for. `interrupted` means the command's OUTCOME IS
          // UNDETERMINED — a different dimension from the execution terminal
          // set — so it is likewise an answer, never something to park on.
          //
          // `accepted` is deliberately NOT in this set: it is the schema-legal
          // QUEUED status (the peer admitted the command, its run has not
          // started yet), so an implicit `wait: true` must keep waiting for the
          // terminal instead of handing back a non-terminal receipt.
          return receipt
        }

        const timeoutMs = waitTimeout(args['timeoutMs'])
        return this.#awaitRun(connection, subscriptions, sessionId, {
          timeoutMs,
          // MONOTONIC, not `Date.now()`: see `#awaitRun`'s `startedAt`.
          startedAt: performance.now(),
          // The cut taken BEFORE the (successful) send — see `#admitSend`.
          // Passed explicitly so the waiter does not re-derive it from a buffer
          // a fast run has already written into.
          baselineSeq,
          executionId: typeof receipt['executionId'] === 'string' ? receipt['executionId'] : undefined,
          commandId: typeof receipt['commandId'] === 'string' ? receipt['commandId'] : undefined,
        })
      },
    })
  }

  /**
   * Issues `agent.messages.send` and returns the receipt the caller should act
   * on — self-healing ONCE a stale admission baseline.
   *
   * `expectedIdleRevision` comes from the CACHE's session snapshot. A cold cache
   * is baselined first (`sessions.get`), so the value is always one the peer
   * itself reported; a warm one is trusted without revalidation. That trust is
   * what issue #1 breaks: the cache's freshest source is the event stream, and
   * the stream's buffer is dropped WHOLESALE when its epoch rotates, a
   * re-subscribe rebuilds it, or the LRU evicts it. With the buffer empty the
   * cached value can be arbitrarily old, the peer refuses admission with
   * CONFLICT "Session is not idle at the expected revision", and the same stale
   * entry would be sent again on every later call: a PERMANENT conflict.
   *
   * So a refusal on exactly that ground earns ONE re-baseline and ONE retry:
   *
   *  - "Session is busy" is a DIFFERENT refusal and is never retried. It says
   *    the peer has a run in flight, so the revision is not even the question
   *    and a second attempt could only fail; the receipt is final.
   *  - The retry asks the peer (`agent.sessions.get`) rather than guessing a
   *    revision, and only when that snapshot shows an IDLE session: it must
   *    report NO `activeExecutionId` AND carry an `idleRevision`/
   *    `historyRevision` to quote. A busy session means the first receipt
   *    stands. (A busy summary DOES carry a mid-run `historyRevision`, so the
   *    execution check — not the revision's absence — is what decides this.)
   *  - The retry QUOTES the revision that read returned, rather than letting
   *    `#idleRevision` re-derive one: that helper prefers the event stream, and
   *    a stale buffered `session.updated` would hand back the revision the peer
   *    has just refused.
   *  - The retry uses a FRESH `randomUUID()`, never the caller's id. The peer
   *    settled the refused command in its ledger as `rejected`, and the retry's
   *    body DIFFERS (a new `expectedIdleRevision`): replaying that id would
   *    return the recorded refusal, and a differing body under a settled id is
   *    the peer's IDEMPOTENCY_CONFLICT. A new id is a new command.
   *  - Exactly one retry. A second refusal is returned as-is — the peer has
   *    then answered this caller twice, and a third attempt would just loop.
   *
   * The returned `baselineSeq` belongs to the attempt whose receipt is
   * returned: the caller's waiter must fold events that arrived after the
   * command which actually started the run.
   */
  async #admitSend(
    connection: DeviceConnection,
    subscriptions: SessionSubscriptions,
    deviceId: string,
    sessionId: string,
    request: { args: Record<string, unknown>; text: string },
  ): Promise<{ receipt: Record<string, unknown>; baselineSeq: number }> {
    const { args, text } = request
    const attempt = async (
      commandId: string,
      revisionOverride?: string,
    ): Promise<{ receipt: Record<string, unknown>; baselineSeq: number }> => {
      const expectedIdleRevision =
        revisionOverride ?? (await this.#idleRevision(connection, subscriptions, deviceId, sessionId))
      // THE BASELINE IS TAKEN BEFORE THE COMMAND IS ISSUED, and that ordering
      // is what makes a fast run observable at all. The waiter's baseline is
      // the cut that decides which events belong to THIS run; taking it after
      // the receipt would put a run that settled during the round trip on the
      // wrong side of the cut, and the wait would then park out its whole
      // window for a run that had already finished. (A peer with no
      // `runDelayMs` really does settle that fast.)
      //
      // Nothing before this point can emit this run's events: the command has
      // not been sent yet.
      const baselineSeq = this.#newestSeq(subscriptions, sessionId)
      const receipt = await this.#command(connection, 'agent.messages.send', {
        commandId,
        sessionId,
        text,
        expectedIdleRevision,
      })
      return { receipt, baselineSeq }
    }

    const first = await attempt(this.#commandId(args))
    if (!isStaleRevisionRefusal(first.receipt)) return first

    const sessionResult = (await connection.rpc.request('agent.sessions.get', { sessionId })) as Record<
      string,
      unknown
    >
    const session = isRecord(sessionResult['session']) ? sessionResult['session'] : {}
    const idle = optionalString(session['idleRevision']) ?? optionalString(session['historyRevision'])
    // TWO conditions, and BOTH must hold before anything is retried — neither
    // alone proves the session is idle:
    //
    //  - no `activeExecutionId`: the peer is reporting no run in flight, so the
    //    refusal really did turn on a stale revision rather than on a busy
    //    session (whose "Session is busy" answer this branch never reaches);
    //  - a revision the send can quote: the snapshot actually carries
    //    `idleRevision`/`historyRevision`.
    //
    // The `activeExecutionId` test is what carries the decision: a BUSY summary
    // DOES carry a `historyRevision` (the mid-run one), so keying the guard on
    // the revision alone would call a running session idle and retry into a
    // guaranteed "Session is busy". Failing either condition leaves the first
    // receipt standing.
    if (idle === undefined || optionalString(session['activeExecutionId']) !== undefined) return first
    this.#remember(this.#revisionCache, deviceId, this.#cacheKey(deviceId, sessionId), idle)

    // THE HEALED VALUE IS PASSED THROUGH, not re-derived. `#idleRevision`
    // prefers the EVENT STREAM, and that stream is exactly what went stale here:
    // a buffered `session.updated` older than the peer's current `idleRevision`
    // would be returned again, so the retry would re-send the very revision that
    // was just refused — a second identical refusal, and the healing did
    // nothing. The snapshot above is the peer's answer taken moments ago, so it
    // wins this one retry.
    //
    // The trade-off, stated honestly: if the stream delivers a NEWER
    // `session.updated` between that read and the retry (a value DIFFERENT from
    // the one refused), this still quotes the healing read's value and can earn
    // one more refusal. That is bounded by construction — exactly one retry, no
    // loop — and the receipt is then returned as the peer gave it.
    return attempt(randomUUID(), idle)
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
        'never a park. Use it to resume after answering an interaction. Its message walk is bounded ' +
        'like `cherry_send`\'s, with the same verdict wording: a cut drops the OLDER messages, and a ' +
        'returned message missing its own parts carries `incomplete`. A cut whose reason is `deadline` ' +
        'means the ANSWER\'s own assembly budget ran out — the content read so far is still returned.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique prefix of a deviceId or display name.' },
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
          // The snapshot is FRESH — it was just taken — so the revision it
          // carries is fresher than anything the caches can hold. Refreshing
          // the send baseline from it is what closes the loop issue #1 opened:
          // an idle snapshot is precisely the moment the caller is about to
          // send again, and the value was previously discarded, leaving the
          // next `cherry_send` on a stale `expectedIdleRevision` whenever the
          // event buffer had gone blind.
          const idle = optionalString(session['idleRevision']) ?? optionalString(session['historyRevision'])
          if (idle !== undefined) {
            this.#remember(
              this.#revisionCache,
              record.deviceId,
              this.#cacheKey(record.deviceId, sessionId),
              idle,
            )
          }

          // The IDLE answer, not a failure and not a wait: nothing is in flight,
          // so the current snapshot IS the result. The message walk is bounded
          // like every other aggregate ({@link TERMINAL_AGGREGATE_MESSAGES} /
          // {@link AGGREGATE_BYTES}), so its verdict rides along — an
          // idle snapshot of a session past either bound is a PARTIAL history,
          // and a caller stacking it against a later read would otherwise see
          // content vanish with nothing to explain it.
          //
          // A failed assembly degrades the same way the terminal and timeout
          // answers do (issue #3): `idle` is still true, and the failure to
          // read the history behind it is reported beside the verdict.
          // The answer's own budget (issue #21) starts HERE, for an idle
          // answer: nothing was waited for, so the caller's window is what its
          // history read may spend (plus the bounded tail — see
          // `AssemblyDeadline`). Anchoring it at the assembly rather than at the
          // tool entry is deliberate: the window is the WAIT's, and there was
          // no wait; the snapshot above is the §6 precondition, not part of the
          // answer's content.
          const answerDeadline = new AssemblyDeadline(performance.now(), waitTimeout(args['timeoutMs']))
          const assembled = await this.#assembledTerminalMessages(
            connection,
            sessionId,
            session,
            {
              status: 'idle' satisfies CherryRunStatus,
              sessionId,
              cursor: this.#cursorOf(subscriptions, sessionId),
            },
            answerDeadline,
          )
          if (assembled.failed !== undefined) {
            return { ...assembled.failed, session, executionId: null }
          }
          return {
            status: 'idle' satisfies CherryRunStatus,
            sessionId,
            session,
            executionId: null,
            messages: assembled.messages,
            cursor: this.#cursorOf(subscriptions, sessionId),
            ...assembled.walk,
          }
        }

        return this.#awaitRun(connection, subscriptions, sessionId, {
          timeoutMs: waitTimeout(args['timeoutMs']),
          // MONOTONIC, not `Date.now()`: see `#awaitRun`'s `startedAt`.
          startedAt: performance.now(),
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
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique prefix of a deviceId or display name.' },
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
          (result) => ({ ...arrayOf(result['items']), nextCursor: result['nextCursor'] }),
          {
            limit: aggregateLimit(args['limit']),
            safetyBound: MAX_AGGREGATE_LIMIT,
            // An interaction record carries an inline input AND an inline
            // summary, the fattest item of the plain lists.
            maxPerPage: INTERACTIONS_LIST_PAGE_CLAMP,
          },
        )

        const includeAnswered = args['includeAnswered'] === true
        const items = page.items
          .filter((item) => includeAnswered || item['status'] === 'pending')
          .map((item) => this.#interactionView(item))

        // The REAL-TIME soft-terminal predicate reads this same view, so caching
        // it keeps a later `cherry_respond` from having to re-ask the peer.
        // `agent.interactions.list` is the AUTHORITATIVE source (see the cache
        // docblock): priming from it is what makes every listed card answerable.
        for (const item of page.items) this.#rememberInteraction(record.deviceId, sessionId, item)

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
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique prefix of a deviceId or display name.' },
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
        const snapshot = await this.#interactionSnapshot(
          connection,
          subscriptions,
          record.deviceId,
          sessionId,
          interactionId,
        )
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
          device: { type: 'string', description: 'Device selector: exact deviceId, or a unique prefix of a deviceId or display name.' },
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
        const cached = await this.#activeExecutionId(connection, subscriptions, record.deviceId, sessionId)
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
        'Pair this harness with a Cherry Studio desktop from its pairing information. The desktop ' +
        'shows only a QR CODE: scan it (WeChat, a browser) and paste the pairing information that ' +
        'page displays. The 6-digit `verificationCode` the desktop displays is returned so ' +
        'the user can confirm it matches. Every outcome is a RESULT, never an error: `status` is ' +
        '"approved" (with the new device id), or the terminal "rejected"/"expired" verdict, or ' +
        'this plugin\'s own "invalid-payload"/"unreachable", or "archive-quarantined" when the ' +
        'device archive is unreadable and must be moved aside by hand. Pairing can take up to a ' +
        'minute — it waits for the user to approve on the desktop.',
      parameters: {
        type: 'object',
        properties: {
          payload: {
            type: 'string',
            description:
              'The pairing information shown by the page the desktop QR code points at (a JSON ' +
              'string). Scan that code with WeChat or a browser and copy the text from there.',
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
   * The mapping is TOTAL over the outcome currency a pairing can legitimately
   * reach: `PairingError.kind` IS the result's `status`, and the quarantined
   * archive — the run's LAST step, the persist — gets its own structured status
   * rather than an exception. "Every pairing outcome is a RESULT" is the tool's
   * whole contract: a damaged `devices.json` is a condition the caller must be
   * told about in-band, with the recovery step, not a raw file error thrown out
   * of a tool call. Anything else that is NOT a `PairingError` is a real fault
   * (a bug, or the identity not being loaded yet) and is rethrown — the tool has
   * no honest in-band shape for "this should not have happened".
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
      // The persist step failed because the archive is READ-ONLY. The copy is
      // deliberate: the SAME recovery instruction the HTTP face returns (503)
      // and the SSE stage publishes, plus the two paths an operator needs.
      if (error instanceof QuarantinedArchiveError) {
        return {
          status: 'archive-quarantined',
          message:
            `${QUARANTINE_RECOVERY} (archive: ${error.file}; preserved as ` +
            `${error.corruptPath ?? `${error.file}.corrupt`})`,
        }
      }
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
        'REQUIRED (an exact deviceId, or a unique prefix of a deviceId or display name); ' +
        'unpairing is permanent and the device must be paired again from a fresh QR code.',
      parameters: {
        type: 'object',
        properties: {
          device: {
            type: 'string',
            description: 'Device selector: exact deviceId, or a unique prefix of a deviceId or display name.',
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
        //
        // THE ENGINE'S CACHES GO WITH IT, and they go FIRST for the same reason
        // the socket does: everything cached under this deviceId describes a
        // pairing that is about to stop existing. Leaving it behind would let a
        // device paired afresh into the same slot inherit the previous
        // pairing's idle revisions and execution ids, and would grow the maps
        // for the lifetime of the process. The store record is untouched by
        // this — the caches are pure derived state and can always be rebuilt.
        this.#forgetDevice(record.deviceId)
        await this.#deps.evict(record.deviceId)
        // The remove is GUARDED, not merely ordered. `#selectRecords` already
        // rejects a quarantined store before a record can be named, so reaching
        // here in that state would mean the archive went bad between the two
        // reads — rare, but the window is real and the consequence is a raw
        // `QuarantinedArchiveError` thrown out of a tool call, which is the one
        // thing no face of this plugin does. Re-checking turns it into the same
        // structured verdict, and the eviction above is harmless either way
        // (the caches describe a pairing this call is abandoning regardless).
        try {
          this.#deps.store.remove(record.deviceId)
        } catch (error) {
          if (error instanceof QuarantinedArchiveError) {
            return {
              error: 'archive-quarantined',
              guidance: QUARANTINE_RECOVERY,
              archive: error.file,
              ...(error.corruptPath === undefined ? {} : { preservedAs: error.corruptPath }),
            }
          }
          throw error
        }

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
   *
   * ONE exception, and it is a HINT rather than a translation: the peer's
   * `IDEMPOTENCY_CONFLICT` — the same `commandId` re-used with a DIFFERENT body
   * — carries the §6 recovery advice on the rethrown error (see
   * {@link withIdempotencyHint}). The reason, the `data` and the failure
   * currency are untouched; only the prose a caller reads grows the actionable
   * half.
   */
  async #command(
    connection: DeviceConnection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      return (await connection.rpc.request(method, params)) as Record<string, unknown>
    } catch (error) {
      throw withIdempotencyHint(error)
    }
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

  /**
   * The cache key for one session's revision/execution snapshot.
   *
   * DEVICE-SCOPED, and that is not defensive padding: this engine is
   * ENGINE-GLOBAL (one instance serves every device the pool holds) while a
   * `sessionId` is the PEER's identifier, not this plugin's. Two desktops can
   * hand out the same session id, and a bare-sessionId key then injects the
   * first device's `idleRevision`/`activeExecutionId` into the second device's
   * commands — revisions and executions its peer has never issued. The `\u0000`
   * separator makes the composite unambiguous (neither id may contain NUL).
   */
  #cacheKey(deviceId: string, sessionId: string): string {
    return `${deviceId}\u0000${sessionId}`
  }

  /** The subscription cache key for one interaction's staleness snapshot. */
  #interactionKey(deviceId: string, sessionId: string, interactionId: string): string {
    return `${deviceId}\u0000${sessionId}\u0000${interactionId}`
  }

  /**
   * One message's cache key (issue #15). Device-scoped for exactly the reason
   * {@link CherryToolEngine.#cacheKey} is: a message id is the PEER's, and two
   * desktops can hand out the same one. The revision is deliberately NOT part of
   * the key — it is the FENCE, checked on lookup, so a moved revision finds the
   * stale entry, rejects it, and the store overwrites it in place (see
   * {@link CherryToolEngine.#rememberPartsPage}).
   */
  #messageKey(deviceId: string, messageId: string): string {
    return `${deviceId}${CACHE_KEY_SEPARATOR}${messageId}`
  }

  /**
   * The cached parts page of one message, or `undefined` when this call must
   * walk `agent.parts.list`.
   *
   * THE ONE LOOKUP every face reaches through
   * {@link CherryToolEngine.#projectMessage}, and it returns the PARTS LIST, not
   * a projection: the caller re-resolves every part's content from it, so a hit
   * never short-circuits the digest verification. A hit requires a stored entry
   * whose revision EQUALS the revision the current `agent.messages.list` row
   * carries; anything else is a miss, which costs exactly the walk a cold
   * process pays.
   *
   * The page is handed out BY REFERENCE, and that is safe precisely because it
   * is a list of RECORDS: the projection loop only reads it (it builds new part
   * objects), so no caller can mutate what a later hit reads.
   */
  #cachedPartsPage(
    deviceId: string,
    messageId: string,
    revision: string,
  ): CherryPage<Record<string, unknown>> | undefined {
    // An EMPTY revision needs no separate guard: an entry is only ever stored
    // under a non-empty revision, so `''` (a row without one) can never equal a
    // stored value and is a miss by the fence itself.
    const lookupKey = this.#messageKey(deviceId, messageId)
    const found = this.#messageCache.get(lookupKey)
    if (found === undefined || found.revision !== revision) return undefined
    return found.page
  }

  /**
   * Holds one `agent.parts.list` RESULT for as long as the peer keeps serving
   * the message under the same revision, and makes room first.
   *
   * The refusal list is the mirror of {@link CherryToolEngine.#cachedPartsPage}
   * and belongs HERE, at the one store path, so no future caller can cache
   * something the lookup would never serve correctly:
   *
   *  - `revision === ''` — nothing to fence;
   *  - `page.truncated` — the parts walk stopped early, so the list is SHORT.
   *    REASON-BLIND on purpose: the circuit breaker (`'safety-bound'`) and a
   *    wait answer's spent budget (`'deadline'`) are both transient from the
   *    cache's point of view — the next read may well complete — and the ONE
   *    thing that must not happen is remembering a short list as if it were the
   *    peer's complete answer. Matching on the reason would leave the next
   *    reason word free to reintroduce that bug;
   *  - `bytes > messageCacheEntryBytes` — walked fresh every time instead.
   *
   * NOT a refusal: a message whose parts then FAILED to resolve. That
   * degradation happens in the projection loop, not in the list, so the held
   * records are still the peer's complete answer and the next read re-attempts
   * every part. (The previous, projection-cached design had to refuse an
   * `incomplete` message because the projection WAS the entry, and holding a
   * degraded one would have made a transient content failure permanent for as
   * long as the revision stood.)
   *
   * EVICTION IS FIFO, oldest insertion first, and it drops the device's entries
   * only: `Map` iterates in insertion order, which IS the policy, so no recency
   * structure has to be kept in sync. A refresh (`set` on an existing key) keeps
   * its position — deliberately not delete-then-set, which would make this LRU
   * (the reason is spelled out in {@link CherryToolEngine.#remember}).
   *
   * The entry is sized with `JSON.stringify(page.items).length`, the same cheap
   * approximation of wire cost {@link AGGREGATE_BYTES} uses — and here it is a
   * fair one, because what is held IS a subset of what travelled on the wire.
   * What it keeps OUT is the `{ref}` text (the multi-megabyte half); what it
   * KEEPS IN is inline part text, up to the peer's 4,096-character
   * `INLINE_TEXT_LIMIT` per part, and the entry is the AGGREGATED page rather
   * than one 3-item RPC page. A few hundred fat inline parts therefore reach
   * {@link MESSAGE_CACHE_ENTRY_BYTES}, which is what the bound is for: no single
   * entry may evict the device's working set. That it rarely bites for real
   * traffic is an expectation, not a measurement.
   */
  #rememberPartsPage(
    deviceId: string,
    messageId: string,
    revision: string,
    page: CherryPage<Record<string, unknown>>,
  ): void {
    // DEFENSIVE ONLY, and said so on purpose: the peer's `messageRevision` is a
    // strict `decimal`, so a `''` can never reach a successful walk (the RPC is
    // refused locally by the protocol schema) and this line cannot be driven
    // through the wire — no test covers it, and none should have to. It stays
    // because the store is the one place that decides what memory is held, and
    // "unfenced entries are never held" should be true of the store on its own
    // terms rather than by a dependency on a schema two layers away.
    if (revision === '') return
    // A circuit-broken walk is SHORT. Remembering it would turn one transient
    // trip into a permanently truncated part list for as long as the revision
    // stands, so it is retried on the next read instead.
    if (page.truncated) return
    // An entry bigger than the DEVICE budget can never fit, whatever the entry
    // cap says, so both ceilings judge it. Without this, an injection that puts
    // the entry cap above the device budget (a test, a future option) would let
    // one entry evict the whole device and then be stored anyway — the thrash
    // the cap exists to prevent.
    const bytes = JSON.stringify(page.items).length
    if (bytes > Math.min(this.#messageCacheEntryBytes, this.#messageCacheBytesPerDevice)) return
    const key = this.#messageKey(deviceId, messageId)
    const previous = this.#messageCache.get(key)?.bytes ?? 0
    // GROWTH is what has to fit, not the whole entry. A REFRESH replaces an
    // entry in place, so only the difference is new memory — and a refresh that
    // SHRINKS needs no room, so it must not evict anything to make some. Getting
    // this wrong is what let a refresh (the revision moved because the message
    // was EDITED, so its list grew) raise the device total with no eviction at
    // all, straight through the budget.
    const growth = Math.max(0, bytes - previous)
    // Make room BEFORE the insert, so the device never passes its budget, not
    // even by the bytes being written.
    let evicted = 0
    for (const candidate of [...this.#messageCache.keys()]) {
      // Re-read the total each pass: `#dropCachedMessage` is what lowered it,
      // so a snapshot taken once would keep evicting after the room was made.
      const total = this.#deviceMessageCacheBytes.get(deviceId) ?? 0
      if (total + growth <= this.#messageCacheBytesPerDevice) break
      if (!candidate.startsWith(`${deviceId}${CACHE_KEY_SEPARATOR}`)) continue
      // The entry being written is not a victim: replacing it IS this call, and
      // its old bytes are already excluded from `growth`.
      if (candidate === key) continue
      this.#dropCachedMessage(candidate)
      evicted += 1
    }
    // A refresh replaces the value IN PLACE (`Map.set` keeps the key's
    // position, so eviction order is insert-order, not write-order) and the
    // running total is corrected by the size difference. The entry itself never
    // leaves the map, so `#dropCachedMessage` is not involved — it owns every
    // REMOVAL, and a refresh removes nothing.
    this.#messageCache.set(key, { revision, bytes, page })
    this.#deviceMessageCacheBytes.set(
      deviceId,
      (this.#deviceMessageCacheBytes.get(deviceId) ?? 0) - previous + bytes,
    )
    if (evicted > 0) {
      // ONE line per insert that evicted anything — not per victim — naming the
      // DEVICE and the COUNT only: a message id is peer-supplied payload (see
      // the logging contract).
      console.warn(
        `[cherry-remote] message cache for device ${deviceId} reached its ` +
          `${this.#messageCacheBytesPerDevice}-byte budget; evicted ${evicted} ` +
          `${evicted === 1 ? 'oldest entry' : 'oldest entries'} ` +
          '(they will be re-read from the desktop on next use)',
      )
    }
  }

  /**
   * Removes one entry and returns its bytes to the device's total — the ONE
   * path by which an entry LEAVES {@link CherryToolEngine.#messageCache}.
   *
   * One delete path is what keeps {@link CherryToolEngine.#deviceMessageCacheBytes}
   * true: every route that removes (an eviction, a device being forgotten) runs
   * through here, so no caller can drop from the map and leave the total
   * counting bytes nothing holds. (A REFRESH is not a removal — it replaces the
   * value in place and the store corrects the total by the size difference.)
   * A device whose last entry leaves has its total key REMOVED rather than
   * zeroed, so the totals map describes exactly the devices holding memory.
   */
  #dropCachedMessage(key: string): void {
    const entry = this.#messageCache.get(key)
    if (entry === undefined) return
    this.#messageCache.delete(key)
    const deviceId = key.slice(0, key.indexOf(CACHE_KEY_SEPARATOR))
    const remaining = (this.#deviceMessageCacheBytes.get(deviceId) ?? 0) - entry.bytes
    if (remaining > 0) this.#deviceMessageCacheBytes.set(deviceId, remaining)
    else this.#deviceMessageCacheBytes.delete(deviceId)
  }

  /**
   * The ONE write path into {@link CherryToolEngine.#revisionCache} and
   * {@link CherryToolEngine.#executionCache}.
   *
   * Every writer goes through here instead of touching the map, because the
   * capacity bound is only as good as its coverage: a single `map.set` left
   * raw would be an unbounded growth path that no test at a small bound would
   * notice. The mechanics are the same for all three caches, and they are
   * deliberately trivial:
   *
   *  - `Map` iterates in INSERTION order, so the first key is the oldest;
   *  - an INSERT whose key is NEW first makes room (evicting this device's
   *    oldest entry when the device is already at the bound) and then sets the
   *    new key at the END — it becomes the newest. Steady state therefore holds
   *    at most `cacheEntriesPerDevice` entries per device; the check runs
   *    BEFORE the insert, so the map never passes the bound by one.
   *  - a REFRESH (an existing key) overwrites the value in place. `Map.set` on
   *    an existing key keeps its position, which is why no delete-then-set is
   *    used: that WOULD move the key to the back.
   *
   * WHY FIFO rather than LRU. Both bound the map, so the choice is not about
   * the cap; it is about what it costs to maintain and to reason about. FIFO
   * needs no bookkeeping at all — `Map` insertion order IS the policy — so
   * there is no recency structure to keep in sync with three caches and two
   * write paths. And eviction here never costs correctness, only a re-read:
   * every value is derived state the desktop serves authoritatively, so an
   * evicted (or wrongly evicted) entry costs one round trip on next use, not a
   * wrong answer. LRU's extra bookkeeping would buy a hit-rate improvement on
   * exactly the wrong shapes — a working set larger than the bound, where
   * either policy evicts something live.
   *
   * The warning names only the device and the count — never session ids.
   */
  #remember<V>(cache: Map<string, V>, deviceId: string, key: string, value: V): void {
    if (!cache.has(key)) this.#evictOldestForKey(cache, deviceId)
    // `set` on an EXISTING key overwrites in place and keeps its position, so
    // a refresh does not reorder — see the docblock. Deliberately NOT
    // delete-then-set: that moves the key to the back and makes this LRU.
    cache.set(key, value)
  }

  /**
   * Drops the device's oldest entry when the device is already AT the bound.
   *
   * `Map` iteration is insertion-ordered, so the first matching key is the
   * oldest one for that device. The scan is bounded by the map's own size —
   * which the bound keeps small — and stops at the first hit.
   */
  #evictOldestForKey<V>(cache: Map<string, V>, deviceId: string): void {
    const prefix = `${deviceId}${CACHE_KEY_SEPARATOR}`
    let own = 0
    let oldest: string | undefined
    for (const key of cache.keys()) {
      if (!key.startsWith(prefix)) continue
      own += 1
      if (oldest === undefined) oldest = key
    }
    if (own < this.#cacheEntriesPerDevice || oldest === undefined) return
    cache.delete(oldest)
    // One line per eviction, naming the device and the bound — never the
    // session id, which is peer-supplied payload (see the logging contract).
    console.warn(
      `[cherry-remote] cache for device ${deviceId} reached its ${this.#cacheEntriesPerDevice}-entry ` +
        'bound; evicted the oldest entry (it will be re-read from the desktop on next use)',
    )
  }

  /** Removes one key from a cache — the ONE delete path, beside `#remember`. */
  #forget<V>(cache: Map<string, V>, key: string): void {
    cache.delete(key)
  }

  /**
   * Joins the device's connection-state channel ONCE, so its caches can be
   * invalidated when the pairing itself stops being good (P3-2).
   *
   * What this closes: the caches outlive every ordinary reconnect — that is
   * their point — so a device that was re-paired (or whose grant was revoked
   * and re-granted) would keep answering from snapshots taken against the OLD
   * pairing. The two transitions that say "this evidence is void" are the ones
   * where the peer REFUSED us rather than merely went away:
   *
   *  - `offline` — reached on a rejected `authenticate` (`GRANT_REVOKED` /
   *    `UNAUTHENTICATED`) and on the refresh-grace expiry, both of which mean
   *    the stored credential no longer describes a valid pairing. A transient
   *    network drop ALSO lands here and clears the caches unnecessarily; that
   *    is accepted, because the cost is one round trip per session on reuse and
   *    the alternative is keeping snapshots across an identity change.
   *  - `identity-mismatch` — the peer's pinned key changed: the pairing is over.
   *
   * {@link CherryToolEngine.#resolve} installs the watch on every tool call that
   * names a device, and {@link CherryToolEngine.#watchedConnections} makes that
   * idempotent.
   *
   * RESIDUAL WINDOW, stated where the hook is: invalidation happens on STATE
   * TRANSITIONS, and a live session's revisions can move WITHOUT one. A message
   * edited on the desktop while the link stays up leaves a cached
   * `expectedIdleRevision` behind, and `cherry_send` then eats the peer's
   * CONFLICT ("Session is not idle at the expected revision") with no re-list
   * hint in the verdict. `#admitSend`'s single self-heal absorbs the common
   * case; the rest is the documented cost of caching at all, and closing it
   * (a verdict shape change) is deliberately OUT of this batch.
   */
  #watchConnection(deviceId: string, connection: DeviceConnection): void {
    const watch = this.#deps.watchDeviceState
    if (watch === undefined) return
    // PER CONNECTION INSTANCE, not per device: `evict` (a re-pair, a disable,
    // `cherry_unpair`) drops the pooled connection and the next `connect()`
    // builds a NEW one — a handler left on the old instance would watch a
    // socket nobody uses any more and miss every transition of the live one.
    // The WeakSet keeps that correct without holding dead connections alive.
    if (this.#watchedConnections.has(connection)) return
    this.#watchedConnections.add(connection)
    watch(deviceId, (state) => {
      if (state !== 'offline' && state !== 'identity-mismatch') return
      this.#forgetDevice(deviceId)
    })
  }

  /**
   * Every cache key that belongs to one device, for eviction.
   *
   * A prefix match is safe because the device id is the FIRST component and the
   * separator cannot appear inside an id: the only strings that start with
   * `${deviceId}\u0000` are that device's own entries. Called when the device
   * leaves the archive (`cherry_unpair`), so a re-paired device cannot inherit
   * the previous pairing's snapshots and a long-lived process does not
   * accumulate entries for devices that no longer exist.
   */
  #forgetDevice(deviceId: string): void {
    const prefix = `${deviceId}\u0000`
    for (const key of [...this.#revisionCache.keys()]) {
      if (key.startsWith(prefix)) this.#forget(this.#revisionCache, key)
    }
    for (const key of [...this.#executionCache.keys()]) {
      if (key.startsWith(prefix)) this.#forget(this.#executionCache, key)
    }
    for (const key of [...this.#interactionCache.keys()]) {
      if (key.startsWith(prefix)) this.#forget(this.#interactionCache, key)
    }
    // The PARTS-PAGE cache (issue #15) belongs to the same device and goes for
    // the same reason: a re-paired device must not inherit lists read under the
    // previous pairing (the content behind them is re-verified anyway, but the
    // session caches' seam is the documented one, and narrowing it per entry
    // shape would be a second rule nobody asked for). `#dropCachedMessage` is
    // the only delete path, so the running byte total follows the map without a
    // second loop.
    for (const key of [...this.#messageCache.keys()]) {
      if (key.startsWith(prefix)) this.#dropCachedMessage(key)
    }
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
    deviceId: string,
    sessionId: string,
  ): Promise<string> {
    const streamed = this.#streamedIdleRevision(subscriptions, sessionId)
    if (streamed !== undefined) {
      this.#remember(this.#revisionCache, deviceId, this.#cacheKey(deviceId, sessionId), streamed)
      return streamed
    }
    const cached = this.#revisionCache.get(this.#cacheKey(deviceId, sessionId))
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
    this.#remember(this.#revisionCache, deviceId, this.#cacheKey(deviceId, sessionId), idle)
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
    deviceId: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const streamed = this.#streamedActiveExecution(subscriptions, sessionId)
    if (streamed !== undefined) {
      this.#remember(this.#executionCache, deviceId, this.#cacheKey(deviceId, sessionId), streamed)
      return streamed
    }

    const sessionResult = (await connection.rpc.request('agent.sessions.get', { sessionId })) as Record<
      string,
      unknown
    >
    const session = isRecord(sessionResult['session']) ? sessionResult['session'] : {}
    // The same snapshot answers a SECOND question for free: what the peer's
    // current idle revision is. An IDLE session's summary is the revision the
    // next `agent.messages.send` must quote, so folding it in here keeps the
    // send baseline fresh without another round trip — and, together with the
    // idle-snapshot write-back in `cherry_wait`, keeps a blind event buffer
    // from pinning a stale revision forever (issue #1).
    //
    // A BUSY session's summary is written too, and that is deliberate rather
    // than an oversight: it carries no `idleRevision`, but it does carry the
    // MID-RUN `historyRevision`, which is what lands here. Writing it is safe
    // because every reader of this entry can live with it:
    //
    //  - a send issued while the session is still busy is refused with
    //    "Session is busy" — a refusal `#admitSend` never retries, so a value
    //    written mid-run cannot be quoted into a retry;
    //  - once the run settles, the written revision is stale, and that is
    //    exactly the case `#admitSend`'s self-heal exists to absorb (issue #1):
    //    the refusal triggers one `sessions.get` and one retry on the fresh
    //    value;
    //  - the peer's revision is MONOTONIC, so a mid-run value is never newer
    //    than the truth and can only ever be too old — the recoverable side.
    const idle = optionalString(session['idleRevision']) ?? optionalString(session['historyRevision'])
    if (idle !== undefined) {
      this.#remember(this.#revisionCache, deviceId, this.#cacheKey(deviceId, sessionId), idle)
    }
    const active = optionalString(session['activeExecutionId'])
    if (active !== undefined) {
      this.#remember(this.#executionCache, deviceId, this.#cacheKey(deviceId, sessionId), active)
      return active
    }
    // The peer says the session is idle: any cached id is stale by definition.
    this.#forget(this.#executionCache, this.#cacheKey(deviceId, sessionId))
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
    deviceId: string,
    sessionId: string,
    interactionId: string,
  ): Promise<{ revision: string; executionId: string; inputDigest: string } | undefined> {
    // (1) Fold the live stream in first, so a freshly pushed interaction is
    // answerable without a round trip.
    for (const entry of this.#eventsOf(subscriptions, sessionId)) {
      if (String(entry['kind'] ?? '') !== 'interaction.updated') continue
      const payload = isRecord(entry['payload']) ? entry['payload'] : {}
      if (optionalString(payload['interactionId']) !== interactionId) continue
      this.#rememberInteraction(deviceId, sessionId, payload)
    }
    const streamed = this.#interactionCache.get(this.#interactionKey(deviceId, sessionId, interactionId))
    if (streamed !== undefined) return streamed

    // (2) The query fallback for a card that never streamed.
    const page = await this.#aggregate(
      connection,
      'agent.interactions.list',
      { sessionId },
      (result) => ({ ...arrayOf(result['items']), nextCursor: result['nextCursor'] }),
      {
        limit: MAX_AGGREGATE_LIMIT,
        safetyBound: MAX_AGGREGATE_LIMIT,
        maxPerPage: INTERACTIONS_LIST_PAGE_CLAMP,
      },
    )
    for (const item of page.items) this.#rememberInteraction(deviceId, sessionId, item)

    return this.#interactionCache.get(this.#interactionKey(deviceId, sessionId, interactionId))
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
  #rememberInteraction(deviceId: string, sessionId: string, raw: Record<string, unknown>): void {
    const interactionId = optionalString(raw['interactionId'])
    const revision = optionalString(raw['revision'])
    const executionId = optionalString(raw['executionId'])
    const inputDigest = optionalString(raw['inputDigest'])
    // A snapshot missing any of the three is not answerable: recording it would
    // let `cherry_respond` send a half-complete staleness triple.
    if (interactionId === undefined || revision === undefined || executionId === undefined) return
    if (inputDigest === undefined) return
    this.#remember(
      this.#interactionCache,
      deviceId,
      this.#interactionKey(deviceId, sessionId, interactionId),
      { revision, executionId, inputDigest },
    )
    if (raw['status'] === 'pending') {
      this.#remember(this.#executionCache, deviceId, this.#cacheKey(deviceId, sessionId), executionId)
    }
  }

  /**
   * The session's current EVENT cursor, for a result that has to say where the
   * event stream stands (this one IS an input: `cherry_events` takes it).
   * Read from the subscription cache without advancing the ACK cursor —
   * waiters CONSUME, they do not acknowledge (controller ruling: ack stays the
   * `cherry_events` delivery call site).
   */
  #cursorOf(subscriptions: SessionSubscriptions, sessionId: string): AgentCursor | undefined {
    const result = subscriptions.read(sessionId)
    return 'events' in result ? result.nextCursor : undefined
  }

  /**
   * The cursor a re-ensure should resume a MID-WAIT session from.
   *
   * It CANNOT be {@link #cursorOf} at the moment of recovery: the subscription
   * is gone by definition, so `read` answers `cursor-out-of-window` and there is
   * no layer cursor left to ask for. So the cursor is CARRIED — the last one the
   * layer handed out while the session was still live, captured on every pass of
   * the wait.
   *
   * Carrying it matters because the two recovery modes are NOT equivalent for a
   * waiter. A cursor lets the peer REPLAY, so the events that arrived while the
   * stream was down reach the fold as events — which is all `#observedState`
   * understands. A cursorless ensure lands in checkpoint mode instead, which
   * rebuilds peer-side STATE and delivers no events at all: the run could settle
   * and this wait would never see it. The carried cursor keeps the recovery on
   * the replay path.
   *
   * It is only usable while its EPOCH still matches: a re-subscribe creates a
   * new peer-side stream, and offering a foreign epoch is refused as "epoch
   * changed". That refusal is not a hazard — the layer answers it by falling
   * back to a checkpoint, which is the same place the cursorless call would have
   * landed — so the stale-epoch cursor is passed through rather than guessed
   * about here.
   */
  #resumeCursorOf(carried: AgentCursor | undefined): AgentCursor | undefined {
    return carried
  }

  /**
   * The wait's terminal answer when its event stream could not be rebuilt.
   *
   * A RESULT, not a throw: the run is almost certainly fine — it is this
   * harness's VIEW of it that was lost — and a caller that can read the session
   * back (`cherry_read` needs no subscription) has everything it needs to
   * recover. The `guidance` says so in one sentence, because a bare status name
   * leaves the caller with no next step.
   *
   * The execution id is still reported whenever the wait had attached to one,
   * so a caller can re-wait on it or read it back by id rather than guess.
   */
  #subscriptionLostResult(
    sessionId: string,
    executionId: string | undefined,
    commandId: string | undefined,
    reason: string,
  ): Record<string, unknown> {
    console.warn(
      `[cherry-remote] wait on session ${sessionId} lost its event subscription and could not re-` +
        `establish it (${reason || 'the session is no longer tracked'}); reporting subscription-lost ` +
        'rather than inventing a timeout',
    )
    return {
      status: 'subscription-lost' satisfies CherryRunStatus,
      sessionId,
      executionId: executionId ?? null,
      ...(commandId === undefined ? {} : { commandId }),
      reason: reason === '' ? 'the session is no longer tracked' : reason,
      guidance: SUBSCRIPTION_LOST_GUIDANCE,
    }
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
    options: {
      timeoutMs: number
      /**
       * The wait's start on a MONOTONIC clock — `performance.now()`, NOT
       * `Date.now()`. Both ends of the window (this and the deadline computed
       * from it below) must come from the same clock, and a WALL clock is the
       * wrong one: an NTP correction, a VM resume after suspend, or a user's
       * manual time change can jump `Date.now()` forward by minutes (the wait
       * gives up instantly, for a run that was given no time at all) or
       * backward (the wait parks out the jump AND its window). `performance.now()`
       * is monotonic by contract, so the window elapses exactly once, in real
       * elapsed time. No external field changes: this value never reaches a
       * result.
       */
      startedAt: number
      executionId?: string
      commandId?: string
      /**
       * The run-scoping cut, when the caller already took it. `cherry_send`
       * takes it BEFORE issuing its command, so a run that settles during the
       * round trip is still on the observable side of the cut. Omitted (as
       * `cherry_wait` does) means "take it now": a wait that did not cause the
       * run has nothing earlier to cut at.
       */
      baselineSeq?: number
    },
  ): Promise<Record<string, unknown>> {
    // The deadline and every `now` below are on the SAME monotonic clock as
    // `startedAt` (see its documentation): a wall clock can be stepped by the
    // system, and a wait whose deadline raced a time jump would either expire
    // instantly or park for far longer than the caller asked.
    const deadline = options.startedAt + options.timeoutMs
    // THE ANSWER'S OWN BUDGET (issue #21), built from the same clock and the
    // same window as `deadline` above. Passing it to both answer faces (the
    // terminal one and the timeout one) is what keeps a settled run's history
    // read — and a timed-out run's — from outliving the caller's patience: the
    // aggregate may spend only the bounded TAIL past the window (see
    // `AssemblyDeadline`), and every request it issues is clamped to that
    // instant.
    const answerDeadline = new AssemblyDeadline(options.startedAt, options.timeoutMs)
    let latestExecutionId = options.executionId
    // THE BASELINE: the newest seq already in the buffer when this wait began.
    // The fold below sees only events strictly after it, so a prior run's
    // terminal — still sitting in the cumulative buffer — can never speak for
    // this wait. Captured ONCE, so each pass is cheap and the cut never moves.
    const baselineSeq = options.baselineSeq ?? this.#newestSeq(subscriptions, sessionId)
    // The incremental fold state, shared across every pass of THIS wait: the
    // buffer only appends, so each pass folds just the events that arrived since
    // the previous one instead of rescanning the whole (cumulative) buffer.
    const observation: ObservationCarry = {}
    // The ONE re-ensure budget (see the recovery block in the loop). A boolean,
    // not a counter: the point is that a wait cannot convert its whole window
    // into subscribe round trips.
    let reEnsureAttempted = false
    // Why the re-ensure failed, for the structured verdict. Set only on the
    // path that also sets `reEnsureAttempted`, so it always describes a real
    // attempt rather than a guessed cause.
    let reEnsureFailure = ''
    // The last cursor the subscription LAYER handed out while this session was
    // still live. Kept so a mid-wait recovery has a replay position to offer
    // (see `#resumeCursorOf`); it is captured fresh on every pass, so it is the
    // newest position the wait was actually parked at.
    let carriedCursor: AgentCursor | undefined

    for (;;) {
      // The link is the precondition for EVERYTHING below: a closed connection
      // cannot deliver the event this wait exists to see, so continuing would
      // only delay the caller's discovery that the run is unobservable.
      if (connection.state !== 'connected') {
        throw new DeviceUnavailableError(connection.record.deviceId, connection.state)
      }

      // The session's SUBSCRIPTION is the second precondition, and it can be
      // lost on a perfectly healthy link. Two ordinary routes do it mid-wait:
      // the peer pushes `agent.subscriptions.resetRequired` (the layer drops the
      // session outright), or a 9th subscribe evicts this session under the
      // local LRU cap. Both leave `read` answering `cursor-out-of-window`, so
      // every later pass would see an EMPTY buffer, spin its poll interval, and
      // finally report `timeout` — a wrong verdict for a run that settled long
      // before, and one the caller cannot distinguish from a genuinely slow run.
      //
      // Recovery is one re-ensure from the cursor already held (which the layer
      // accepts as a replay request, so the peer sends only what arrived since).
      // It is attempted AT MOST ONCE per wait: a peer that keeps tearing the
      // subscription down would otherwise turn every poll pass into a subscribe
      // round trip, and the caller would still never get an answer. Failing that
      // one attempt ends the wait with a structured verdict rather than burning
      // the rest of the window on a stream nobody is feeding.
      if (!subscriptions.activeSessions().includes(sessionId)) {
        if (reEnsureAttempted) {
          return this.#subscriptionLostResult(sessionId, latestExecutionId, options.commandId, reEnsureFailure)
        }
        reEnsureAttempted = true
        try {
          await subscriptions.ensure(sessionId, this.#resumeCursorOf(carriedCursor))
        } catch (error) {
          reEnsureFailure = error instanceof Error ? error.message : String(error)
          return this.#subscriptionLostResult(sessionId, latestExecutionId, options.commandId, reEnsureFailure)
        }
        // Another pass is needed before any judgement: the replayed events have
        // to be folded before the run can be judged. The OBSERVATION CARRY is
        // deliberately kept rather than rebuilt — it holds this wait's baseline
        // cut, adopted execution and any terminal already seen, none of which the
        // lost buffer can invalidate — and the fold is seq-gated, so a replayed
        // event at the boundary is not folded twice.
        continue
      }

      const observed = this.#observedState(subscriptions, sessionId, {
        baselineSeq,
        carry: observation,
        ...(latestExecutionId === undefined ? {} : { awaitedExecutionId: latestExecutionId }),
      })
      // STICKY ADOPTION: the first pass with no id lets `#observedState` adopt
      // the first post-baseline run, and this assignment carries that id into
      // every later pass (it is passed back down as `awaitedExecutionId`). From
      // then on the cut is fixed: a LATER unrelated run cannot re-adopt and
      // steal a wait that has already attached to a run.
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
        return await this.#terminalResult(
          connection,
          subscriptions,
          sessionId,
          observed.terminalStatus,
          {
            ...(latestExecutionId === undefined ? {} : { executionId: latestExecutionId }),
            ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
            // The run-scoped cut for the terminal aggregate: the message THIS run
            // persisted, when the peer named one.
            ...(observed.terminalMessageId === undefined ? {} : { terminalMessageId: observed.terminalMessageId }),
          },
          answerDeadline,
        )
      }

      // The window is judged on the monotonic clock, like `deadline` itself.
      const now = performance.now()
      if (now >= deadline) {
        // TIMEOUT IS NOT A FAILURE (spec §6): hand back what arrived, plus the
        // cursor, so the caller can continue from exactly here.
        return await this.#timeoutResult(
          connection,
          subscriptions,
          sessionId,
          {
            timeoutMs: options.timeoutMs,
            ...(latestExecutionId === undefined ? {} : { executionId: latestExecutionId }),
            ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
          },
          answerDeadline,
        )
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
      // Remember the parked position for the recovery path: by the time the
      // loss is noticed, this is the only cursor still describing where this
      // wait had got to.
      if (cursor !== undefined) carriedCursor = cursor
      const pollMs = Math.min(this.#waitPollMs, Math.max(1, deadline - now))
      // The park is CANCELLED before the next one is made, and also when this
      // pass ends for any other reason. Without the disposer the loop would
      // leave one resolver in the session's waiter queue on every judgement
      // pass, for the whole life of the wait — an unbounded queue that every
      // buffer advance then walks. `dispose` is idempotent and a no-op once the
      // park settled, so it is safe on every exit path.
      const park = subscriptions.waitFor(sessionId, cursor)
      try {
        const woke = await Promise.race([park.promise.then(() => true, () => false), sleep(pollMs).then(() => true)])
        if (!woke) await sleep(pollMs)
      } finally {
        park.dispose()
      }
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
   *  3. **A wait with no id ADOPTS the first post-baseline run.** See
   *     {@link CherryToolEngine.#adoptExecution}.
   *
   * `terminalStatus` is the closed four-state set; the receipt dimension's
   * `interrupted` never lands here.
   *
   * `pendingInteractions` is a SET, not a slot: the soft-terminal predicate is
   * "ANY unanswered pending interaction" (spec §3.6), so two pendings where the
   * later-registered settles first must leave the earlier one visible.
   *
   * INCREMENTAL BY DESIGN. The fold is cumulative over the session buffer, which
   * only ever APPENDS, so re-reading it from index 0 on every poll pass is
   * wasted work that grows with the run's length. `carry` is the fold state from
   * the previous pass; when supplied, only entries with a seq above
   * `carry.scannedSeq` are folded, and the pending map / settled set / terminal
   * observation are inherited rather than rebuilt. The semantics are IDENTICAL —
   * the same events are folded in the same order, exactly once — because the
   * buffer preserves order and `scannedSeq` only ever moves forward.
   *
   * A caller with no carry (the first pass) simply folds everything, which is
   * still linear in the buffer once.
   */
  #observedState(
    subscriptions: SessionSubscriptions,
    sessionId: string,
    options: { baselineSeq: number; awaitedExecutionId?: string; carry?: ObservationCarry },
  ): {
    executionId?: string
    terminalStatus?: string
    terminalMessageId?: string
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
      terminalMessageId?: string
      pendingInteractions: Array<{ interactionId: string; kind: string; summary: string; questions: string[] }>
    } = { pendingInteractions: [] }

    // ADOPTION (rule 3). `awaitedExecutionId` is absent when the command
    // receipt did not name the run it started — `executionId` is optional in
    // the receipt schema, and the peer may legitimately omit it. Without an
    // id, the fold below matches NOTHING, so the wait would park out its whole
    // window and answer `timeout` for a run that finished long ago.
    //
    // The recovery is to take the first `execution.updated` that arrives AFTER
    // this wait's baseline as the run this wait is about to observe. The
    // baseline is what makes that safe: it is the same cut the terminal
    // attribution uses, so an earlier run's events — still sitting in the
    // cumulative buffer — can never be adopted. `#adoptExecution` is
    // one-time and sticky in the caller, so a LATER unrelated run cannot steal
    // a wait that has already attached to one.
    //
    // The adopted id is CARRIED: once a run has been attached to, a later pass
    // must not re-adopt (the caller's sticky `latestExecutionId` also guards
    // this, but the carry keeps the two consistent when the caller passes it
    // back down).
    const awaited = options.awaitedExecutionId ?? options.carry?.awaited ?? this.#adoptExecution(
      subscriptions,
      sessionId,
      options.baselineSeq,
    )
    // Keyed by interactionId: a later `interaction.updated` for the same
    // interaction REPLACES its entry, and a settled one REMOVES it — but only
    // its own, so an unrelated pending is never clobbered.
    //
    // When a carry exists the map is INHERITED (same object, mutated in place),
    // which is what makes the incremental fold equivalent: the pending set is
    // the accumulated result of every interaction event seen so far.
    const pending =
      options.carry?.pending ??
      new Map<string, { interactionId: string; kind: string; summary: string; questions: string[] }>()
    // The baseline decides ONLY whether an execution terminal is in scope. An
    // execution that had already settled when the wait began belongs to an
    // earlier run; one that settles after it is this wait's answer.
    const settledBeforeBaseline = options.carry?.settledBeforeBaseline ?? new Set<string>()
    // Where the previous pass stopped. Entries at or below it were folded then.
    const scannedSeq = options.carry?.scannedSeq
    // The terminal observed so far for `awaited`, inherited so a pass that folds
    // no new events still reports it.
    state.executionId = options.carry?.executionId
    state.terminalStatus = options.carry?.terminalStatus
    state.terminalMessageId = options.carry?.terminalMessageId

    // The high-water mark moves INSIDE the fold below, so the next pass skips
    // exactly what this one already consumed without a second scan (which would
    // be the very full rescan this exists to remove).
    let scannedSeqNext = scannedSeq ?? -Infinity

    for (const entry of this.#eventsOf(subscriptions, sessionId)) {
      const seq = Number(entry['seq'])
      // INCREMENTAL SKIP: only entries past the previous pass's high-water mark
      // are new. Entries without a finite seq are never skippable (they were not
      // counted into the mark), so they are re-folded — which is what the
      // full-scan version did too.
      if (scannedSeq !== undefined && Number.isFinite(seq) && seq <= scannedSeq) continue
      if (Number.isFinite(seq) && seq > scannedSeqNext) scannedSeqNext = seq
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
      // (`awaited` may have just been ADOPTED above, in which case it names the
      // first post-baseline run and this predicate matches exactly it.)
      if (awaited === undefined || executionId !== awaited) continue
      state.executionId = executionId
      state.terminalStatus = terminal ? status : undefined
      // The terminal names the message THIS run persisted, which is the one
      // boundary the terminal aggregate must cut at: the session's history is
      // cumulative, so concatenating every assistant message would re-deliver
      // a prior run's reply as this run's output.
      if (terminal) state.terminalMessageId = optionalString(payload['messageId'])
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
      const settled = this.#settledStatusOf(subscriptions, sessionId, awaited, options.baselineSeq)
      state.terminalStatus = settled.status
      state.terminalMessageId = settled.messageId
      state.executionId = awaited
    }
    state.pendingInteractions = [...pending.values()]
    // Publish the fold state for the next pass: the same pending map and settled
    // set (mutated in place), the observation so far, and the new high-water
    // mark. A caller that passes this back gets an incremental fold with
    // identical semantics.
    if (options.carry !== undefined) {
      options.carry.pending = pending
      options.carry.settledBeforeBaseline = settledBeforeBaseline
      options.carry.awaited = awaited
      options.carry.executionId = state.executionId
      options.carry.terminalStatus = state.terminalStatus
      options.carry.terminalMessageId = state.terminalMessageId
      options.carry.scannedSeq = Number.isFinite(scannedSeqNext) ? scannedSeqNext : undefined
    }
    return state
  }

  /**
   * The execution a wait with NO id should attach to: the first
   * `execution.updated` that arrived strictly after `baselineSeq`, or undefined
   * when no run has appeared yet.
   *
   * This is the "receipt did not name the run" recovery (see
   * {@link CherryToolEngine.#observedState}'s rule 3). The BASELINE is what
   * makes it sound rather than a guess: an execution whose only events sit at or
   * before the cut belongs to a run that was already under way when this wait
   * began, so it cannot be the run this command is about to start.
   *
   * "First" means first in the buffer's own order — the buffer is append-ordered
   * by construction, so this is the earliest post-baseline run, not whichever
   * event happens to be newest.
   *
   * ACCEPTED BOUND (adjudicated, no behavior change): both this scan and
   * {@link CherryToolEngine.#settledStatusOf} read the session buffer, which the
   * subscription layer TRIMS to its per-session byte budget by dropping the
   * OLDEST events. Once a run's `execution.updated` has been trimmed away, the
   * id it named is no longer knowable from here, so a wait that has not yet
   * attached to that run degrades to what it would have been without adoption at
   * all: it parks out its window and answers `timeout` (with the partial content
   * and the stop-point cursor, per spec §6's timeout row) rather than
   * `completed`. The bound is therefore ~2 MiB of buffered events per session —
   * the default budget — and reaching it takes a run that both emits that much
   * event traffic AND whose command receipt omitted `executionId`. The
   * degradation is bounded and recoverable rather than silent: `timeout` is a
   * non-failure answer, and `cherry_read` rebuilds the full picture without the
   * buffer.
   *
   * It is NOT fixed by scanning the peer's journal, because the peer's replay
   * window is itself bounded and the tool has no cursor to offer it — the same
   * trim would simply move one layer down, at the cost of an RPC on every pass.
   */
  #adoptExecution(
    subscriptions: SessionSubscriptions,
    sessionId: string,
    baselineSeq: number,
  ): string | undefined {
    for (const entry of this.#eventsOf(subscriptions, sessionId)) {
      if (String(entry['kind'] ?? '') !== 'execution.updated') continue
      const seq = Number(entry['seq'])
      if (Number.isFinite(seq) && seq <= baselineSeq) continue
      const payload = isRecord(entry['payload']) ? entry['payload'] : {}
      const executionId = optionalString(payload['executionId'])
      if (executionId !== undefined) return executionId
    }
    return undefined
  }

  /**
   * The terminal an awaited execution settled on at or before the baseline, or
   * undefined when it never settled. Only consulted for an awaited execution
   * that was already over when the wait began — the "I am waiting on a run that
   * has already finished" case `cherry_wait` must answer rather than park on.
   */
  #settledStatusOf(
    subscriptions: SessionSubscriptions,
    sessionId: string,
    executionId: string,
    baselineSeq: number,
  ): { status?: string; messageId?: string } {
    let settled: { status?: string; messageId?: string } = {}
    for (const entry of this.#eventsOf(subscriptions, sessionId)) {
      if (String(entry['kind'] ?? '') !== 'execution.updated') continue
      const seq = Number(entry['seq'])
      if (Number.isFinite(seq) && seq > baselineSeq) continue
      const payload = isRecord(entry['payload']) ? entry['payload'] : {}
      if (optionalString(payload['executionId']) !== executionId) continue
      const status = optionalString(payload['status'])
      if (status !== undefined && (TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(status)) {
        settled = { status, messageId: optionalString(payload['messageId']) }
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
   * The terminal aggregate: the run's status plus the assistant text THIS RUN
   * produced, with `{ref}` parts resolved through the same externalized content
   * walk `cherry_read` uses.
   *
   * `text` is RUN-SCOPED (spec §3.6: 「终态后聚合助手最终消息文本」). The session
   * history is cumulative and the peer appends a FRESH assistant message per
   * run, so concatenating every assistant message would re-deliver a prior
   * run's reply on the second send of a reused session — the primary workflow.
   * The cut is the terminal's own `messageId` when the peer named one (the
   * waiter carries it from `execution.updated`); without that name the text
   * falls back to the NEWEST assistant message (see
   * {@link aggregateAssistantText}). Either way the `messages` array stays on
   * the result as context, bounded by {@link TERMINAL_AGGREGATE_MESSAGES} and
   * {@link AGGREGATE_BYTES}.
   *
   * A CONTENT ASSEMBLY FAILURE DOES NOT UNDO THE VERDICT (issue #3). The run
   * really did settle on `status`; only the history read behind `text` failed.
   * Throwing would take the status and the run's identifiers down with it —
   * the field report could not even recover the `commandId` of the command it
   * had just issued. So the failure DEGRADES to a stub receipt: the verdict,
   * the session, the execution/command ids and the event cursor, plus
   * `aggregateError` and `guidance`, and NO `messages`/`text` (half an
   * assembly must never be presented as the run's output).
   */
  async #terminalResult(
    connection: DeviceConnection,
    subscriptions: SessionSubscriptions,
    sessionId: string,
    status: string,
    extra: Record<string, unknown>,
    deadline?: AssemblyDeadline,
  ): Promise<Record<string, unknown>> {
    const { terminalMessageId, ...rest } = extra
    const cursor = this.#cursorOf(subscriptions, sessionId)
    // THE SNAPSHOT IS INSIDE THE DEGRADE ARM TOO (issue #21, and the #3
    // invariant it extends): without it there is no `historyRevision` and so no
    // history to assemble, but the RUN's verdict is already known and must
    // survive. A dead link here used to make `cherry_send` REJECT — taking the
    // status and the run's identifiers down with the content, which is exactly
    // what #3 removed for every other assembly failure.
    let session: Record<string, unknown>
    try {
      session = await this.#sessionSnapshot(connection, sessionId, deadline)
    } catch (error) {
      return this.#assemblyFailed({ status, sessionId, ...rest, cursor }, error)
    }
    // The cache is refreshed from the terminal snapshot so a follow-up send
    // does not have to re-read the session. Done BEFORE the aggregate: it does
    // not depend on the content read, so a failed assembly must not cost it.
    const idle = optionalString(session['idleRevision']) ?? optionalString(session['historyRevision'])
    if (idle !== undefined) {
      this.#remember(
        this.#revisionCache,
        connection.record.deviceId,
        this.#cacheKey(connection.record.deviceId, sessionId),
        idle,
      )
    }
    const assembled = await this.#assembledTerminalMessages(
      connection,
      sessionId,
      session,
      { status, sessionId, ...rest, cursor },
      deadline,
    )
    if (assembled.failed !== undefined) return assembled.failed

    return {
      status,
      sessionId,
      ...rest,
      session,
      text: aggregateAssistantText(
        assembled.messages,
        typeof terminalMessageId === 'string' ? terminalMessageId : undefined,
      ),
      messages: assembled.messages,
      cursor,
      // The walk's own verdict rides beside the EVENT cursor, never replacing
      // it: a caller resuming the RUN and a caller resuming the HISTORY are
      // asking two different questions.
      ...assembled.walk,
    }
  }

  /**
   * The timeout result: NOT a failure. Partial content read so far +, whenever a
   * stop point can be named honestly, a `messagesResumeCursor` token marking where
   * the unread history begins — absent when the walk reached the peer's last page
   * or its last returned message carried no id.
   *
   * The spec's own sentence (§3.6, 2026-10-09 design: 「超时不是失败：返回已收到
   * 的部分内容 + 当前游标，agent 可续查」) is a statement of that contract in
   * cursor terms, and BOTH halves are now answerable: the event cursor
   * (`cursor`, still returned) resumes the run's EVENT stream through
   * `cherry_events`, and `messagesResumeCursor` resumes the HISTORY through
   * `cherry_read`'s `messagesResumeCursor` argument (issue #26) — so "续查"
   * reaches the older messages instead of re-reading the newest window.
   *
   * Unlike the terminal aggregate the text here is NOT run-scoped: the run has
   * not settled, so there is no terminal message to cut at, and the whole point
   * of the timeout answer is to hand back the PARTIAL content produced so far
   * (spec §3.6: 超时非失败返回部分内容+游标).
   *
   * WHERE THE PARTIAL CONTENT ACTUALLY LIVES — and therefore how honest `text`
   * is. A run that has not settled has usually not committed anything to the
   * HISTORY face yet: on the real peer the assistant message exists as a
   * pending row whose `parts` are still empty, and the tokens stream on the
   * EVENT channel as `part.append` events. So a timeout's `text` is very often
   * `''`, and that empty string is the truthful answer: the newest assistant
   * message — this run's — has no parts in the history face. The content is in
   * the event stream, which is where `part.append` carries it; it reaches the
   * history face (and this aggregate) only when the run commits. The fallback
   * anchor is the NEWEST assistant message for exactly this reason: an older
   * message's text would say "this is your run's output" about a run that has
   * produced none. See {@link aggregateAssistantText}.
   *
   * The result also carries `progress` — a zero-round-trip HEARTBEAT: the
   * newest event already in this session's subscription buffer, with its kind.
   * It costs no RPC (the waiter holds the buffer) and it is the one thing that
   * lets a caller tell "the run is still moving" from "the stream went silent"
   * without a second call. Its limits are stated where it is built
   * ({@link CherryToolEngine.#timeoutProgress}).
   */
  async #timeoutResult(
    connection: DeviceConnection,
    subscriptions: SessionSubscriptions,
    sessionId: string,
    extra: Record<string, unknown>,
    deadline?: AssemblyDeadline,
  ): Promise<Record<string, unknown>> {
    const cursor = this.#cursorOf(subscriptions, sessionId)
    const progress = this.#timeoutProgress(subscriptions, sessionId)
    const identity = {
      status: 'timeout' satisfies CherryRunStatus,
      sessionId,
      ...extra,
      cursor,
      ...(progress === undefined ? {} : { progress }),
    }
    // The snapshot is the FIRST request of the answer and rides the same
    // deadline (issue #21); its failure is an ASSEMBLY failure, not a run
    // verdict, so it degrades to the stub receipt instead of rejecting the
    // call. Before this, a dead link here made `cherry_send` throw and the
    // caller lost even the `commandId` of the run it had just issued.
    let session: Record<string, unknown>
    try {
      session = await this.#sessionSnapshot(connection, sessionId, deadline)
    } catch (error) {
      return this.#assemblyFailed(identity, error)
    }

    const assembled = await this.#assembledTerminalMessages(
      connection,
      sessionId,
      session,
      identity,
      deadline,
    )
    if (assembled.failed !== undefined) return assembled.failed

    return {
      status: 'timeout' satisfies CherryRunStatus,
      sessionId,
      ...extra,
      session,
      text: aggregateAssistantText(assembled.messages),
      messages: assembled.messages,
      cursor,
      ...(progress === undefined ? {} : { progress }),
      // Partial content is the POINT of a timeout answer, so the walk verdict
      // matters most here: "here is what arrived" must not read as "here is
      // everything" when the history walk itself ran out at the ceiling.
      ...assembled.walk,
    }
  }

  /**
   * The timeout answer's HEARTBEAT: the newest event the session's own
   * subscription buffer already holds, and its kind.
   *
   * ZERO ROUND TRIPS BY CONSTRUCTION. The waiter has been folding this buffer
   * every poll pass, so the newest entry is already in hand; asking the peer
   * (`agent.sessions.get`, a journal read) for the same fact would spend the
   * caller's window on a second RPC at the exact moment the first one is
   * already late — and would re-introduce the unbounded-ring-time defect this
   * result is being fixed for. Both numbers are read from one scan of the
   * buffer's tail, so they always describe the SAME event.
   *
   * ITS LIMITS, stated here rather than discovered by a caller:
   *
   *  - **Omitted when the buffer is empty.** An epoch rotation (a
   *    `resetRequired`, a re-subscribe, an LRU eviction) drops the buffer
   *    WHOLESALE, and a session with no event traffic at all starts empty. In
   *    both cases there is no event to report, so the field is ABSENT — never a
   *    zero or an invented seq, which a caller would read as "the stream is at
   *    position 0" and conclude the opposite of what is true.
   *  - **It is not a liveness PROOF, only a liveness HINT.** `seq` is this
   *    session's stream position, so an unchanged `lastEventSeq` across two
   *    timeouts means no event arrived in between — the stream is quiet, not
   *    that the run is dead (a run can legitimately emit nothing for a while).
   *    A CHANGED `lastEventSeq` is the strong signal: the run (or the session)
   *    is producing events.
   *  - **The buffer is bounded per session** (the subscriptions layer trims it
   *    to a byte budget by dropping the OLDEST events). That only ever hides
   *    old events, and the heartbeat reads the newest.
   */
  #timeoutProgress(
    subscriptions: SessionSubscriptions,
    sessionId: string,
  ): { lastEventSeq: number; lastEventKind: string } | undefined {
    // One pass, comparing `seq` NUMERICALLY (the protocol carries it as a
    // decimal string, where `'9' > '10'` lexicographically): the buffer is
    // append-ordered, but the heartbeat's contract is "the newest by seq", so it
    // says what it means whatever order it is handed.
    let newest: Record<string, unknown> | undefined
    let newestSeq = Number.NEGATIVE_INFINITY
    for (const entry of this.#eventsOf(subscriptions, sessionId)) {
      const seq = Number(entry['seq'])
      if (!Number.isFinite(seq) || seq <= newestSeq) continue
      newest = entry
      newestSeq = seq
    }
    if (newest === undefined) return undefined
    return { lastEventSeq: newestSeq, lastEventKind: String(newest['kind'] ?? '') }
  }

  /**
   * The bounded history read the three wait answers share, with its two
   * possible outcomes folded into one type:
   *
   *  - the projection succeeded → `messages` + the walk verdict (which may
   *    itself say the walk was bounded or byte-capped — surfaced, never
   *    silent);
   *  - the projection FAILED → `failed`, the STUB RECEIPT the caller returns
   *    verbatim (issue #3): the verdict and the identifiers already collected
   *    in `identity`, plus `aggregateError` and `guidance`, and no content.
   *
   * Failure does not distinguish an integrity error from a transport fault
   * here, deliberately: `cherry_read`'s rule (an unverifiable `{ref}` fails the
   * WHOLE read) is about not presenting unverified content as a snapshot, and
   * that rule still holds — `cherry_read` still throws. A WAIT is a different
   * question: the run's verdict is already known and must survive, so here the
   * same failure degrades the CONTENT (`messages`/`text` absent) while the
   * verdict stands. Nothing unverified is handed back either way.
   */
  async #assembledTerminalMessages(
    connection: DeviceConnection,
    sessionId: string,
    session: Record<string, unknown>,
    identity: Record<string, unknown>,
    deadline?: AssemblyDeadline,
  ): Promise<
    | { failed?: undefined; messages: CherryReadMessage[]; walk: CherryMessageWalkVerdict }
    | { failed: Record<string, unknown>; messages?: undefined; walk?: undefined }
  > {
    try {
      const { messages, ...walk } = await this.#readTerminalMessages(connection, sessionId, session, deadline)
      return { messages, walk }
    } catch (error) {
      return { failed: this.#assemblyFailed(identity, error) }
    }
  }

  /**
   * The STUB RECEIPT: the run's verdict and identifiers, the assembly failure,
   * and the route that rebuilds the content (issue #3).
   *
   * One builder for both failure points of all three wait faces — the session
   * snapshot and the message walk — so the shape cannot drift between paths
   * that mean the same thing. It is deliberately built from the CALLER's
   * identity object: the verdict is already known and true, and only the
   * content behind it failed.
   *
   * `aggregateError` is BOUNDED like every other peer-echoed string in a result
   * (the full text goes to the log): the reason is actionable at 200 characters
   * and the log is where the operator reads the rest.
   */
  #assemblyFailed(identity: Record<string, unknown>, error: unknown): Record<string, unknown> {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `[cherry-remote] the ${String(identity['status'])} answer for session ${String(identity['sessionId'])} ` +
        `could not assemble its content (${message}); returning the verdict with the assembly failure reported`,
    )
    return {
      ...identity,
      aggregateError: message.slice(0, 200),
      guidance: AGGREGATE_FAILED_GUIDANCE,
    }
  }

  /**
   * One session snapshot, inside the answer's budget when it has one (issue
   * #21).
   *
   * The snapshot is the FIRST request every wait answer makes (it carries the
   * `historyRevision` the history walk needs), so it sits inside the same
   * deadline as the walk: a link that would make the caller wait
   * `transportRetryWaitMs` for a replay must not do so after the answer's
   * budget is spent.
   *
   * A reply whose `session` is not a record yields `{}` — the same tolerance
   * every reader here applies — and the walk then finds no `historyRevision`
   * and answers with an empty message list. That is the pre-existing behaviour
   * and deliberately not an error: a peer that sends no session has no history
   * to read, which is different from one that refused the read.
   */
  async #sessionSnapshot(
    connection: DeviceConnection,
    sessionId: string,
    deadline?: AssemblyDeadline,
  ): Promise<Record<string, unknown>> {
    const result = (await connection.rpc.request(
      'agent.sessions.get',
      { sessionId },
      deadline === undefined ? undefined : { deadline: deadline.instant },
    )) as Record<string, unknown>
    return isRecord(result['session']) ? result['session'] : {}
  }

  /**
   * The session's recent messages, projected with `{ref}` parts aggregated
   * through `agent.content.read` — the SAME projection `cherry_read` uses
   * (spec §3.6: the terminal aggregate resolves externalized parts too).
   *
   * BOUNDED, in two dimensions (issue #3):
   *
   *  1. **Messages** — at most {@link TERMINAL_AGGREGATE_MESSAGES}, starting
   *     from the NEWEST page. The peer's `listSessionMessages` walks
   *     newest-first, so the walk reaches the current run's own messages first;
   *     history past the ceiling is not what a wait is asking for.
   *  2. **Bytes** — the projected messages are accumulated (their
   *     `JSON.stringify` length as a wire-cost proxy) and the projection stops
   *     once {@link AGGREGATE_BYTES} is exceeded. The message COUNT
   *     alone bounds nothing: one message may carry hundreds of parts, each a
   *     separate `agent.content.read`.
   *
   * The FIRST message is always projected and always kept WHOLE — it is the
   * newest, i.e. the run's own reply — so the byte budget is only ever checked
   * AFTER a complete message has been taken. That places the budget on the
   * same side as every other bound: the walk runs newest-first and stops
   * BETWEEN messages, so what it leaves out is the OLDER end of the history,
   * never the tail of a message it returned. A returned message missing part
   * of its OWN content is flagged by its own projection
   * ({@link CherryReadMessage.incomplete}) — a content verdict, not this
   * walk's. A walk that stopped for either reason comes back with the verdict
   * filled in (`messageWalkVerdict` handles the ceiling;
   * `'aggregate-bytes'` is attributed here), and the three callers (terminal,
   * timeout, idle) each surface it.
   *
   * THE STOP POINT IS THE SAME TOKEN `cherry_read` EMITS AND ACCEPTS (issue
   * #26), from the same helper ({@link messageResumeToken}), so the two message
   * faces can never word a stop differently:
   *
   *  - the WHOLE collected window was returned → `cursor:<peer position>`, the
   *    position the walk was handed when it stopped;
   *  - the stop happened INSIDE the window (a byte stop that trimmed collected
   *    messages) → `after:<last returned id>`. The peer's position sits past
   *    those trimmed messages and would skip them, and no peer cursor can be
   *    synthesised for the boundary (`AgentMessage` has no `createdAt`), so the
   *    anchor is the honest stop. It is feedable to `cherry_read` as
   *    `messagesResumeCursor`: the read scans from the newest end to the anchor
   *    and continues strictly after it.
   *
   * The token is absent only when there is nothing older to point at (the walk
   * reached the peer's last page having returned everything it collected).
   * See {@link CherryMessageWalkVerdict.messagesResumeCursor}.
   */
  async #readTerminalMessages(
    connection: DeviceConnection,
    sessionId: string,
    session: Record<string, unknown>,
    deadline?: AssemblyDeadline,
  ): Promise<{ messages: CherryReadMessage[] } & CherryMessageWalkVerdict> {
    const historyRevision = optionalString(session['historyRevision'])
    if (historyRevision === undefined) return { messages: [] }

    const page = await this.#aggregate(
      connection,
      'agent.messages.list',
      { sessionId, historyRevision },
      (result) => ({ ...arrayOf(result['items']), nextCursor: result['nextCursor'] }),
      { limit: TERMINAL_AGGREGATE_MESSAGES, deadline },
    )

    const messages: CherryReadMessage[] = []
    let projectedBytes = 0
    // WHY the loop stopped, when it did — the two budgets are independent and
    // each has its own word, so the first stop wins and is reported as itself.
    let stop: CherryTruncationReason | undefined
    for (const raw of page.items) {
      // The ANSWER's budget, judged BEFORE every message: one message's parts
      // walk is a whole sub-walk (one `agent.parts.list` page set plus one
      // `agent.content.read` walk per externalized part), so the check has to
      // sit here as well as inside `#aggregate` — that is where a hard-bounded
      // answer actually spends its last round trip.
      if (deadline !== undefined && deadline.expired()) {
        stop = 'deadline'
        break
      }
      const message = await this.#projectMessage(connection, sessionId, raw, deadline)
      messages.push(message)
      projectedBytes += JSON.stringify(message).length
      // Checked AFTER the message is complete: the budget trims what comes
      // NEXT, never what has already been taken, so message 0 is always whole.
      if (projectedBytes >= AGGREGATE_BYTES) {
        stop = 'aggregate-bytes'
        break
      }
    }
    // A STOP only counts as truncation when items were LEFT BEHIND: spending the
    // budget exactly on the peer's last message is a complete walk, and flagging
    // it would be a false alarm (the same honesty the aggregate's own boundary
    // case records).
    const leftBehind = messages.length < page.items.length || page.truncated
    if (stop !== undefined && leftBehind) {
      // The token comes from the SAME helper `cherry_read` uses, so this face's
      // mid-window stop emits `after:<last returned id>` instead of nothing —
      // and that token is a `cherry_read` input. The truncation VERDICT is
      // unchanged; only the word differs (a byte budget vs. a time budget).
      const resumeToken = messageResumeToken(page, messages.length, messages[messages.length - 1]?.messageId)
      return {
        messages,
        messagesTruncated: true,
        messagesTruncationReason: stop,
        ...(resumeToken === undefined ? {} : { messagesResumeCursor: resumeToken }),
      }
    }
    return { messages, ...messageWalkVerdict(page, messages.length, messages[messages.length - 1]?.messageId) }
  }

  async #ensureSubscription(deviceId: string, sessionId: string): Promise<void> {
    const subscriptions = this.#deps.subs(deviceId)
    if (subscriptions.activeSessions().includes(sessionId)) return
    await subscriptions.ensure(sessionId)
  }

  /**
   * Rebuilds one session's subscription in the BACKGROUND, for the recovery
   * paths that must not block the answer they are attached to (P3-3).
   *
   * It goes through the SAME `ensure` entry every other re-ensure uses — the
   * layer closes the old peer subscription first and subscribes once — rather
   * than inventing a second recovery route. Cursorless on purpose: the caller's
   * delivered cursor has just been REFUSED, so handing it back would ask the
   * peer to replay from exactly the position it said is outside its window.
   * The layer falls back to checkpoint mode, which rebuilds peer-side state
   * without events — the right mode when the cursor is the thing that is wrong.
   *
   * A failure here is logged and dropped: the delivery already succeeded, and
   * the caller can still `cherry_read` the history without this subscription.
   */
  #reEnsureInBackground(deviceId: string, sessionId: string): void {
    let layer: SessionSubscriptions
    try {
      layer = this.#deps.subs(deviceId)
    } catch (error) {
      console.warn(`[cherry-remote] could not re-ensure session ${sessionId} of ${deviceId}`, error)
      return
    }
    void layer.ensure(sessionId).catch((error: unknown) => {
      console.warn(`[cherry-remote] re-ensuring session ${sessionId} of ${deviceId} failed`, error)
    })
  }

  /**
   * The session's current cache window start, or null when it is untracked.
   *
   * The subscriptions layer OWNS this boundary and now exposes it directly
   * (`windowStart(sessionId)`), so the tool reads it instead of rediscovering
   * it. It used to reconstruct the value from the outside by probing `read`
   * with candidate cursors, which was worse in every dimension: the probe
   * compared seqs as NUMBERS while the verdict compares them numerically too,
   * but it could not tell "below the window" apart from "wrong stream epoch",
   * and it scanned upward one seq at a time, so a session whose window start
   * was far above 0 walked the whole interval.
   *
   * The read-only accessor is the same adjudication `subscriptions.ts` records
   * for its own boundary (controller ruling in commit f2b852b): the layer is
   * the only thing that knows the window start, so it publishes it rather than
   * leaving callers to rediscover it.
   *
   * `streamEpoch` is reported from the LAYER's current epoch rather than from
   * the caller's stale cursor: the verdict is about what can be served NOW, and
   * echoing a foreign epoch back would name a stream this session never had.
   */
  #windowStart(subscriptions: SessionSubscriptions, sessionId: string): AgentCursor | null {
    return subscriptions.windowStart(sessionId) ?? null
  }
}

// ---------------------------------------------------------------------------
// Small shared readers
// ---------------------------------------------------------------------------

/**
 * The array at `value`, or an empty array when the peer sent something else —
 * plus HOW MANY entries were dropped as non-records (v0.1.3 review, P3-6a).
 *
 * The count is returned rather than logged here because this helper has no
 * idea which method it is projecting: the CALLER (`#aggregate`) owns the
 * method name and the page's terminality, so it is the only place that can
 * say "agent.sessions.list dropped 2" without guessing, and the only place
 * that can decide what a wholesale drop means.
 */
function arrayOf(value: unknown): { items: Array<Record<string, unknown>>; dropped: number } {
  if (!Array.isArray(value)) return { items: [], dropped: 0 }
  const items = value.filter(isRecord)
  return { items, dropped: value.length - items.length }
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

/**
 * Extracts the ordered question texts from an interaction input, if any.
 *
 * BEST-EFFORT BY DESIGN, and the `{ref}` branch is where that shows. The peer
 * externalizes an interaction input above 4 KiB into a `{ref}`, and resolving
 * one needs an `agent.content.read` round trip this pure parse has no way to
 * make. So a `{ref}` input yields `undefined` and the caller gets an EMPTY
 * question list.
 *
 * What that means for a caller is worth stating plainly: a question card whose
 * input was externalized is UNANSWERABLE through the tool face today, because
 * `cherry_respond`'s `response` form is keyed by question TEXT and there is no
 * text to key by. The card is still visible (`cherry_interactions` reports its
 * id, kind and summary) and a `decision` card is unaffected — its answer is the
 * `decision` field, not a per-question map. Resolving `{ref}` inputs through the
 * SAME externalized-content walk `cherry_read` uses is the deferred fix
 * (adjudicated: documented best-effort now, `content.read` resolution later),
 * and it is deferred rather than half-done because an unverified ref must never
 * be presented as an answer key.
 */
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
 * The full stop-point TOKEN a message walk hands out (issue #26), or
 * `undefined` when the walk has no older history left to name.
 *
 * ONE helper, shared by BOTH message-walk faces (`#readOnce` and
 * `#readTerminalMessages` via {@link messageWalkVerdict}), because the marker
 * is now also the resume INPUT: two independently derived tokens would give the
 * two faces two dialects, and a caller that fed one into `cherry_read` would be
 * refused by a token the bridge itself had just printed.
 *
 * `returned < page.items.length` says the walk stopped INSIDE the window it
 * collected: messages it already holds were trimmed, so the page's own
 * `nextCursor` — which sits past ALL of them — would skip them on the way back.
 * A peer that OVERSHOT the requested page leaves items in the same position
 * ({@link CherryPage.pageOverflow}) and takes the same branch, for the same
 * reason. The token is then `after:<lastReturnedId>`, "strictly older than this
 * one". With no id to anchor (a peer item that carried none) NO token is
 * invented: a wrong anchor is worse than no anchor, and `truncated` still says
 * the walk was cut. Otherwise the whole collected window was consumed, and the
 * peer's page position is exactly where the unread history begins
 * (`cursor:<pos>`) — unless the peer answered an EMPTY position, which names
 * nothing and is therefore not emitted at all.
 */
function messageResumeToken(
  page: CherryPage<unknown>,
  returned: number,
  lastReturnedId: string | undefined,
): string | undefined {
  const anchor = optionalString(lastReturnedId)
  // TWO forms of "the walk stopped inside what it was given": it returned fewer
  // items than it collected, or the PEER overshot the requested page and items
  // were left in it ({@link CherryPage.pageOverflow}). Either way the page's own
  // position sits past messages this walk never returned, so only the anchor is
  // exact.
  if (returned < page.items.length || page.pageOverflow === true) {
    return anchor === undefined ? undefined : `${RESUME_ANCHOR_PREFIX}${anchor}`
  }
  // An empty position is not a position: a peer answering `nextCursor: ''` on a
  // non-terminal page would otherwise make this face emit a bare `cursor:`,
  // which the same face REFUSES on the way back (review P3-4).
  const position = optionalString(page.nextCursor)
  return position === undefined ? undefined : `${RESUME_CURSOR_PREFIX}${position}`
}

/**
 * The message-walk verdict, projected off an aggregate page.
 *
 * Extracted so the three non-`cherry_read` walkers ({@link
 * CherryToolEngine.#readTerminalMessages}) report truncation in EXACTLY the
 * shape `cherry_read` already does, from one place: a second, independently
 * worded projection is how the terminal face and the read face drift apart
 * again. `returned`/`lastReturnedId` describe how much of this page the caller
 * actually took, because the stop point depends on it
 * ({@link messageResumeToken}). Absent fields (rather than `false`/`undefined`
 * keys) keep a complete walk's result shape unchanged for existing callers.
 */
function messageWalkVerdict(
  page: CherryPage<unknown>,
  returned: number,
  lastReturnedId: string | undefined,
): CherryMessageWalkVerdict {
  if (!page.truncated) return {}
  const resumeToken = messageResumeToken(page, returned, lastReturnedId)
  return {
    messagesTruncated: true,
    ...(page.truncationReason === undefined ? {} : { messagesTruncationReason: page.truncationReason }),
    ...(resumeToken === undefined ? {} : { messagesResumeCursor: resumeToken }),
  }
}

/**
 * Whether a token REMAINDER is one this bridge could not have emitted (review
 * P2-1).
 *
 * Checking the prefix is not enough: `'cursor: 20'` (a token copied with a stray
 * space) and `'cursor:\n7'` carry a remainder no emission can produce. Passing
 * one on is the exact failure the prefix check exists to prevent — the real
 * desktop SILENTLY falls back to the newest page for a malformed cursor, so the
 * caller would receive the newest window as "continued history" — and an
 * `after:` remainder that can never match a message id turns into a misleading
 * "the message is probably gone" naming a phantom id. Blank, leading/trailing
 * whitespace and control characters are refused. INTERIOR characters are left
 * alone on purpose: the remainder is the peer's opaque token and this bridge does
 * not know its alphabet.
 */
function mangledRemainder(remainder: string): boolean {
  return remainder === '' || remainder !== remainder.trim() || /[\u0000-\u001f\u007f]/.test(remainder)
}

/**
 * Whether a request's rejection means the ANSWER's budget ran out (issue #21).
 *
 * Two classes, one meaning, from the two layers that wait:
 *
 *  - {@link RpcDeadlineExceededError} — the connection refused to wait longer
 *    for a reconnect, or refused the replay, because the deadline had passed.
 *    It is raised only in that case, so no extra test is needed.
 *  - {@link RequestTimeoutError} — the rpc layer's per-request timeout, but ONLY
 *    when that timeout was DERIVED from the deadline (`clampedByDeadline`). The
 *    same class is raised by the ordinary 60 s default on a walk whose deadline
 *    is farther away, and a peer that goes silent for a minute is not the
 *    caller's budget running out: converting that one would report `'deadline'`
 *    for a different failure, and the caller would stop looking for a peer that
 *    stopped answering. The flag exists instead of a clock comparison because a
 *    timer may fire a millisecond early — "the budget shortened my timeout" is a
 *    fact, "the deadline has passed by now" is a race.
 *
 * Everything else is a verdict about something else (the peer, the link, the
 * content) and keeps its own error.
 */
function deadlineExhaustion(error: unknown): boolean {
  if (error instanceof RpcDeadlineExceededError) return true
  return error instanceof RequestTimeoutError && error.clampedByDeadline
}

/**
 * The message id a projection uses, read from a raw `agent.messages.list` item.
 *
 * ONE reading, TWO users: `#projectMessage` prints it into the result and the
 * anchor scan compares against it, so a divergence would make this bridge emit
 * an `after:` token its own scan can never match (review P3-4). Coerced exactly
 * as the projection always has (`String(value)`), and `''` when the item carries
 * none — which can never equal a non-empty anchor, so such an item is simply
 * never the anchor.
 */
function messageIdOf(raw: Record<string, unknown>): string {
  const value = raw['messageId']
  return value === undefined || value === null ? '' : String(value)
}

/**
 * Parse a caller's `messagesResumeCursor` into a {@link MessageResume}, or
 * refuse it HERE (issue #26).
 *
 * The peer's cursor format is NEVER parsed or validated: the real desktop's is
 * an opaque keyset token (`<createdAt-ms>:<messageId>`), the loopback peer's is
 * a numeric offset, and a future desktop may change it. Every token this bridge
 * EMITS is therefore self-describing — it carries one of OUR two prefixes — and
 * every token it ACCEPTS must carry one of them too. That is the only property
 * that can be checked without knowing the peer's format, and it is the property
 * that matters: the real desktop SILENTLY falls back to the newest page for a
 * malformed cursor, so a foreign string forwarded to it would come back as the
 * newest page presented as "continued history". A refusal here costs no dial
 * and no page, and it names both accepted forms.
 *
 * `undefined`/`null` means "from the newest message", which is the ordinary
 * read. An empty remainder (`'cursor:'`, `'after:'`) is refused like any other
 * foreign token: an empty anchor could never match a message.
 */
function parseMessageResume(value: unknown): MessageResume | undefined {
  if (value === undefined || value === null) return undefined
  const refuse = (): never => {
    throw new Error(
      'cherry_read: messagesResumeCursor must be a token this tool emitted ("cursor:<peer position>" or ' +
        `"after:<messageId>"), got ${JSON.stringify(value)}; omit the argument to read from the newest message.`,
    )
  }
  if (typeof value !== 'string') refuse()
  const token = value as string
  if (token.startsWith(RESUME_CURSOR_PREFIX)) {
    const cursor = token.slice(RESUME_CURSOR_PREFIX.length)
    if (mangledRemainder(cursor)) refuse()
    return { kind: 'cursor', cursor }
  }
  if (token.startsWith(RESUME_ANCHOR_PREFIX)) {
    const messageId = token.slice(RESUME_ANCHOR_PREFIX.length)
    if (mangledRemainder(messageId)) refuse()
    return { kind: 'anchor', messageId }
  }
  return refuse()
}

/**
 * The assistant text a terminal aggregate reports: the awaited RUN's assistant
 * message text parts, joined.
 *
 * `{ref}` parts are already resolved by {@link CherryToolEngine}'s
 * `#projectMessage` (the externalized content walk), so this only has to
 * concatenate what the read produced.
 *
 * The scope is what makes this correct on a REUSED session: the peer appends a
 * fresh assistant message per run and `messages.list` serves the cumulative
 * history, so summing every assistant message would re-deliver run N-1's reply
 * as run N's output. `terminalMessageId` — the message the awaited execution's
 * terminal named — is the exact cut, and it is matched BY ID, so the array's
 * order is irrelevant to it.
 *
 * ## The fallback anchors the NEWEST assistant message
 *
 * The array is NEWEST-FIRST. The peer's `listSessionMessages` "walks
 * newest-first; an absent cursor returns the most recent page, each
 * `nextCursor` walks one page older", so `messages[0]` is the most recent
 * message in the session — which is why the fallback starts at index 0 and
 * takes the first assistant message it meets.
 *
 * It used to anchor the array's TAIL, on the assumption that the protocol
 * appended per run in read order. It does not: the tail is the OLDEST assistant
 * message in the whole history, and the field defect was a 2026-10 run whose
 * fallback text came from a July message. Anchoring the newest end is the exact
 * inverse mistake — the right one, because the run this answer is about is the
 * most recent thing the session produced.
 *
 * ## An empty string is a real answer
 *
 * On the TIMEOUT path the run is still in flight and has usually committed
 * nothing to the history face: its assistant message exists as a pending row
 * whose `parts` are empty, while the streamed tokens ride the EVENT channel as
 * `part.append`. So the newest assistant message is the run's own, and it can
 * legitimately have no text — `''` then says exactly that, where an older
 * message's text would say "this is your run's output" about a run that has
 * produced none. The partial content is in the event stream, not here.
 *
 * ## The scope is bounded, and that is flagged
 *
 * The walk this reads was bounded by the caller
 * (`TERMINAL_AGGREGATE_MESSAGES` / `AGGREGATE_BYTES`), so on a long
 * session the text is assembled from the newest window only. When even that
 * window was cut, the result carries the walk verdict
 * ({@link CherryMessageWalkVerdict}) and `terminalMessageId` may fall outside
 * it — both leave the text partial or stale, and neither may be presented as a
 * complete answer.
 */
function aggregateAssistantText(messages: CherryReadMessage[], terminalMessageId?: string): string {
  const scoped =
    terminalMessageId === undefined
      ? newestAssistantMessage(messages)
      : messages.filter((message) => message.messageId === terminalMessageId)
  const chunks: string[] = []
  for (const message of scoped) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      if (part.kind !== 'text') continue
      if (part.content === '') continue
      chunks.push(part.content)
    }
  }
  return chunks.join('')
}

/**
 * The session's NEWEST assistant message, as a one-element list (or empty).
 *
 * Index 0 is the newest: the peer serves the history newest-first (see
 * {@link aggregateAssistantText}). Named for the direction it reads rather than
 * for its position, because conflating the two is exactly the defect this
 * replaced.
 */
function newestAssistantMessage(messages: CherryReadMessage[]): CherryReadMessage[] {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message !== undefined && message.role === 'assistant') return [message]
  }
  return []
}
