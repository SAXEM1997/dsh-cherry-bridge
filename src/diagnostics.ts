import { createHash } from 'node:crypto'
import type { DeviceRecord, DeviceStore } from './deviceStore.js'
import type { DeviceState, EffectiveLimits } from './connection.js'

/**
 * M4 operations surface (spec §5 「可观测性与诊断」, §3.7 route prefix).
 *
 * Two things live here, and they are deliberately in one module because the
 * manual pre-release pass and the automated contract suite must not be able to
 * disagree:
 *
 *  1. {@link CONTRACT_DIFFERENCES} — the six-entry list of places where the
 *     loopback fake (`tests/loopback/fakeCherry.ts`) and the REAL Cherry Studio
 *     desktop differ. `tests/contract/contract.test.ts` asserts each entry
 *     against the wire and the pinned schema; `docs/e2e-checklist.md` carries
 *     the manual step for the same entry, generated from this table.
 *  2. {@link buildDiagnostics}/{@link sanitizeDiagnostics} — the aggregator
 *     behind `GET /diagnostics`, whose whole job is to emit the operationally
 *     useful facts WHILE every credential stays behind.
 *
 * ## The redaction rule (spec §5)
 *
 *  - **May be emitted**: `deviceId`, `displayName`, `state`, `hosts`, `port`,
 *    `sessionId`, a SHORT DIGEST of `desktopIdentity`, effective limits,
 *    counters, and the reason/message of a recent error.
 *  - **Never emitted**: `accessToken`, `tokenExpiresAt`, `invitationSecret`,
 *    the raw pinned `desktopIdentity`, message text and part text.
 *
 * The sanitizer is a WHITELIST projection, not a blacklist filter: it builds a
 * fresh object field by field, so a new credential added to `DeviceRecord`
 * later is excluded by construction rather than by remembering to add it to a
 * deny list. That property is what the contract suite's "no token/secret field"
 * assertion is really protecting.
 */

// ---------------------------------------------------------------------------
// The contract difference list (① / ⑦ share this constant)
// ---------------------------------------------------------------------------

/** One documented behavioural gap between the fake peer and the real desktop. */
export interface ContractDifference {
  /** Stable kebab-case id; the key used by the checklist and the tests. */
  id: string
  /** Human-readable headline, carried verbatim into the checklist. */
  title: string
  /** What the REAL Cherry Studio desktop does (spec §3.4/§3.6 authority). */
  realPeer: string
  /** What this repo's loopback fake does instead, and why that is legal. */
  fakePeer: string
  /** The pinned protocol construct that anchors the claim. */
  schemaAnchor: string
  /** The manual verification step in `docs/e2e-checklist.md`, verbatim. */
  checklistStep: string
}

/**
 * The six differences, in the order the spec's §7-3 list names them.
 *
 * Adding a seventh entry here is a TWO-line change (this table plus the
 * checklist document); the behavioural work of a new difference belongs in the
 * fake and in a new assertion, and the tests will fail until both land.
 */
export const CONTRACT_DIFFERENCES: readonly ContractDifference[] = [
  {
    id: 'connection-closed-not-sent',
    title: 'connection.closed is never sent by the real peer',
    realPeer:
      'The desktop terminates a session with the SOCKET close code (1000/1011/1013) and never ' +
      'emits a `connection.closed` notification. The frame exists in the schema as a notification ' +
      'shape only: it is absent from connectionMethods/pairingMethods, so no request face produces it.',
    fakePeer:
      'The fake exposes `pushNotification("connection.closed", ...)` so a client that must TOLERATE ' +
      'the schema-valid frame can be exercised; it never fabricates one on its own.',
    schemaAnchor: 'connectionNotificationSchema (@cherrystudio/remote-protocol)',
    checklistStep:
      'connection-closed-not-sent: with a real desktop connected, force a link drop (disable the ' +
      'desktop\'s Wi-Fi or quit Cherry Studio) and confirm the plugin logs a socket-close/reconnect ' +
      'path and NOTHING resembling a received `connection.closed` notification.',
  },
  {
    id: 'approval-card-not-realtime',
    title: 'Approval cards are not delivered in real time by the real stream',
    realPeer:
      'An approval/question card is persisted and is read back through `agent.interactions.list`; ' +
      'it is NOT pushed in real time over the `agent.events` stream the way this fake pushes it, so ' +
      'the list query is the authoritative source and the in-stream event is a bonus.',
    fakePeer:
      'The fake pushes `interaction.updated` in-stream (`pushInteractionOnRun`) AND serves the same ' +
      'card from `agent.interactions.list`, so both client paths are exercisable.',
    schemaAnchor: 'agentNotificationSchema + agentMethods["agent.interactions.list"]',
    checklistStep:
      'approval-card-not-realtime: trigger a tool call on the real desktop that raises an approval ' +
      'card; confirm `cherry_interactions` finds it through `agent.interactions.list` even when no ' +
      '`interaction.updated` event arrived, and that `cherry_respond` still accepts the listed snapshot.',
  },
  {
    id: 'rate-limit-terminates-session',
    title: 'Over-limit rate limiting terminates the whole session (close 1011)',
    realPeer:
      'Exceeding the desktop\'s per-socket budget (64 req/s in the current implementation, a server ' +
      'value with no negotiation channel) terminates the ENTIRE session with close code 1011 — it is ' +
      'not a per-request `RATE_LIMITED` rejection the caller can retry in place.',
    fakePeer:
      'The fake closes the session with 1011 once `rateLimitPerSecond` is exceeded, so the client\'s ' +
      'offline→backoff→reconnect path is exercised rather than a request-level refusal.',
    schemaAnchor: 'remoteLimits + peer close code 1011 (implementation value, not a protocol promise)',
    checklistStep:
      'rate-limit-terminates-session: against a real desktop, drive a burst well above the smooth ' +
      'budget and confirm the socket is closed with 1011 (session gone, state offline, backoff ' +
      'restart) rather than a single structured per-request rejection.',
  },
  {
    id: 'execution-terminal-no-interrupted',
    title: 'The real agent journal never produces an `interrupted` execution terminal',
    realPeer:
      'agentJournal settles an execution on `completed` | `failed` | `cancelled` only. The schema ' +
      'already admits `interrupted`, so the client must handle it, but the current server never ' +
      'emits it for an execution.',
    fakePeer:
      'The fake injects a schema-valid `interrupted` terminal through `runTerminalStatus` (Task 9⑭) ' +
      'so the client\'s waiter is proven to converge on it instead of hanging to its timeout.',
    schemaAnchor: 'executionSchema (@cherrystudio/remote-protocol/agent)',
    checklistStep:
      'execution-terminal-no-interrupted: run several real turns (including a cancelled one) and ' +
      'confirm every observed `execution.updated` terminal is completed/failed/cancelled; treat any ' +
      '`interrupted` as a protocol change worth reporting, not as expected noise.',
  },
  {
    id: 'command-receipt-can-be-interrupted',
    title: 'A command receipt status may be `interrupted` (a different dimension)',
    realPeer:
      'The command receipt\'s `status` enum is accepted|applied|rejected|interrupted: `interrupted` ' +
      'means the command\'s OUTCOME IS UNDETERMINED. That is a separate axis from the execution ' +
      'terminal set, and a caller must not fold the two together.',
    fakePeer:
      'The fake records and replays receipts verbatim through its idempotency ledger, so any ' +
      'schema-valid receipt status — including `interrupted` — round-trips unchanged.',
    schemaAnchor: 'commandReceiptSchema (@cherrystudio/remote-protocol/agent)',
    checklistStep:
      'command-receipt-can-be-interrupted: after a send the plugin reports as undetermined, query ' +
      'the command (or re-issue the same commandId) and confirm an `interrupted` receipt is passed ' +
      'through as an undetermined outcome, NOT reported as a finished run.',
  },
  {
    id: 'resource-exhausted-receipt-cap',
    title: 'RESOURCE_EXHAUSTED on the receipt dimension is a rejected receipt, not a dead link',
    realPeer:
      'When the peer\'s command/receipt capacity is exhausted the command comes back as a REJECTED ' +
      'RECEIPT carrying `error.reason: "RESOURCE_EXHAUSTED"` while the session stays healthy. ' +
      '(The SUBSCRIPTION dimension, `agent.sessions.subscribe` beyond the cap, is a different ' +
      'injection anchored by Task 7⑨.)',
    fakePeer:
      'The fake answers `sendOutcome: "resource-exhausted"` with that exact rejected receipt, ' +
      'leaving the socket up so a client that mistakes it for a transport failure is caught.',
    schemaAnchor: 'commandReceiptSchema.error.reason includes RESOURCE_EXHAUSTED',
    checklistStep:
      'resource-exhausted-receipt-cap: force the real desktop into receipt exhaustion (repeat ' +
      'commands until it refuses) and confirm the plugin surfaces a structured rejected receipt ' +
      'with `RESOURCE_EXHAUSTED`, keeps the connection up, and does not crash.',
  },
]

// ---------------------------------------------------------------------------
// Sanitized diagnostics (② / ③)
// ---------------------------------------------------------------------------

/**
 * A device as the diagnostics report emits it: no credential field, ever.
 *
 * `limits` are the peer-negotiated caps when the device has a live connection
 * (see {@link DiagnosticsSources.connect}); they are omitted when there is
 * none, rather than fabricated from the client-side fallbacks.
 */
export interface DiagnosticsDevice {
  deviceId: string
  displayName: string
  state: DeviceState
  enabled: boolean
  hosts: string[]
  port: number
  /**
   * A SHORT DIGEST of the pinned desktop identity — enough to tell two
   * desktops apart in a bug report, not enough to be the pin itself.
   */
  desktopIdentity: string
  limits?: EffectiveLimits
}

/** One session's LOCAL subscription bookkeeping. */
export interface DiagnosticsSession {
  sessionId: string
  deviceId: string
  subscriptions: number
  cursor?: { sessionId: string; streamEpoch: string; seq: string }
}

/** One recent error summary (spec §5: 「最近错误摘要」). */
export interface DiagnosticsError {
  at: string
  deviceId?: string
  sessionId?: string
  reason: string
  message: string
}

/**
 * Counters the connection pool can report without exposing any payload.
 *
 * There is deliberately NO `requests` key: the transport layer owns RPC
 * accounting, and this report must not publish a differently-derived number
 * under the name an operator would read as RPC volume. `connectionsBuilt` is
 * what the assembly actually owns (see `AssemblyState.connectionsBuilt`).
 */
export interface DiagnosticsStats {
  connections: number
  sockets: number
  connectionsBuilt: number
  subscriptions: number
}

/** The full report served by `GET /diagnostics`. */
export interface DiagnosticsReport {
  generatedAt: string
  plugin: { name: string; prefix: string }
  devices: DiagnosticsDevice[]
  sessions: DiagnosticsSession[]
  stats: DiagnosticsStats
  recentErrors: DiagnosticsError[]
  /** The six contract differences, so an operator sees them in the report too. */
  contractDifferences: Array<{ id: string; title: string }>
}

/** Local per-session subscription counters, as the assembly can report them. */
export interface SubscriptionStat {
  deviceId: string
  sessionId: string
  subscriptions: number
  cursor?: { sessionId: string; streamEpoch: string; seq: string }
}

/** The pool/dep surfaces the aggregator draws from. Every extra is optional. */
export interface DiagnosticsSources {
  store: DeviceStore
  /**
   * The same connection resolver the HTTP face uses: `state` is the live
   * projection, and `limits` is what the peer's hello actually negotiated.
   */
  connect(deviceId: string): {
    state: DeviceState
    limits?: EffectiveLimits
  }
  /** Pool counters; absent means zero, never a throw. */
  stats?(): Partial<DiagnosticsStats>
  /** Local subscription bookkeeping; absent means "none reported". */
  sessions?(): readonly SubscriptionStat[]
  /** The ring of recent errors the assembly keeps; absent means "none". */
  recentErrors?(): readonly DiagnosticsError[]
}

/**
 * The character cap on one recent-error `message`.
 *
 * `recentErrors[].message` is the ONE free-text field the whitelist passes
 * through, so it is bounded AT THE BOUNDARY rather than trusted: a future call
 * site that hands over a peer-echoed payload (a protocol failure whose message
 * quotes the offending body) must not be able to inflate a GET endpoint or
 * smuggle unbounded text into a report an operator pastes into a bug tracker.
 * 200 characters is enough for a protocol reason plus context.
 */
export const ERROR_MESSAGE_MAX = 200

/** The marker appended when a message was cut, so a reader knows it is partial. */
export const ERROR_MESSAGE_ELLIPSIS = '…[truncated]'

/**
 * Bounds one error message, KEEPING the ellipsis inside the cap.
 *
 * Exported because it is the unit the contract suite asserts directly: given a
 * 10 000-character message it must return something at most
 * {@link ERROR_MESSAGE_MAX} characters long that still starts with the original
 * head, so an operator keeps the discriminating part of the reason.
 */
export function truncateErrorMessage(message: string): string {
  if (message.length <= ERROR_MESSAGE_MAX) return message
  return `${message.slice(0, ERROR_MESSAGE_MAX - ERROR_MESSAGE_ELLIPSIS.length)}${ERROR_MESSAGE_ELLIPSIS}`
}

/**
 * The 12-hex digest that stands in for a raw pinned identity, or `'unknown'`
 * when there is no identity to stand in for.
 *
 * The empty guard is not cosmetic: sha256('') is a FIXED, perfectly
 * well-formed 12-hex string, so digesting an absent identity would publish
 * something an operator reads as a real (if unusual) pin — and every
 * identity-less device in the report would share it. `'unknown'` is outside
 * the digest's own shape, so it cannot be mistaken for one.
 */
export function digestIdentity(identity: string): string {
  if (identity === '') return 'unknown'
  return createHash('sha256').update(identity).digest('hex').slice(0, 12)
}

/**
 * Projects ONE device record onto the whitelist.
 *
 * Note what is NOT here: the record's `accessToken`/`tokenExpiresAt` never
 * leave this function even though they are present on the input, and
 * `desktopIdentity` is replaced by its digest. The `state` is passed in rather
 * than read from the record because a record has no state — the projection does.
 *
 * `limits` are the hello-NEGOTIATED caps (or the conservative fallbacks), which
 * are pure numbers with no credential in them and are exactly what an operator
 * needs to judge whether a refusal was the peer's cap talking.
 */
export function sanitizeDevice(
  record: DeviceRecord,
  state: DeviceState,
  limits?: EffectiveLimits,
): DiagnosticsDevice {
  return {
    deviceId: record.deviceId,
    displayName: record.displayName,
    state,
    enabled: record.enabled,
    hosts: [...record.hosts],
    port: record.port,
    desktopIdentity: digestIdentity(record.desktopIdentity),
    ...(limits === undefined
      ? {}
      : {
          limits: {
            heartbeatMs: limits.heartbeatMs,
            subscriptions: limits.subscriptions,
            pageItems: limits.pageItems,
            inFlightRequests: limits.inFlightRequests,
          },
        }),
  }
}

/** Narrows an unknown bag to the report's own shapes, dropping everything else. */
function projectDevice(raw: unknown): DiagnosticsDevice {
  const value = (raw ?? {}) as Record<string, unknown>
  const desktopIdentity = typeof value['desktopIdentity'] === 'string' ? value['desktopIdentity'] : ''
  return {
    deviceId: typeof value['deviceId'] === 'string' ? value['deviceId'] : '',
    displayName: typeof value['displayName'] === 'string' ? value['displayName'] : '',
    state: (value['state'] as DeviceState | undefined) ?? 'offline',
    enabled: value['enabled'] === true,
    hosts: Array.isArray(value['hosts']) ? value['hosts'].map((host) => String(host)) : [],
    port: typeof value['port'] === 'number' ? value['port'] : 0,
    // Either an already-digested value (12 hex) or an explicit `unknown`, or a
    // raw pin still to be digested.
    desktopIdentity:
      desktopIdentity === 'unknown' || /^[0-9a-f]{12}$/.test(desktopIdentity)
        ? desktopIdentity
        : digestIdentity(desktopIdentity),
    ...projectLimits(value['limits']),
  }
}

/**
 * Re-projects the four numeric limit keys, dropping any foreign key that a
 * caller's `limits` object might carry. A whitelist inside the whitelist: the
 * shape is rebuilt field by field rather than spread, so a future addition to
 * `EffectiveLimits` cannot arrive here unvetted.
 */
function projectLimits(raw: unknown): { limits?: EffectiveLimits } {
  if (raw === null || typeof raw !== 'object') return {}
  const value = raw as Record<string, unknown>
  const limits: EffectiveLimits = {
    heartbeatMs: numberOr(value['heartbeatMs'], 0),
    subscriptions: numberOr(value['subscriptions'], 0),
    pageItems: numberOr(value['pageItems'], 0),
    inFlightRequests: numberOr(value['inFlightRequests'], 0),
  }
  return { limits }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * The sanitizer, as a pure function over a loose bag.
 *
 * Exposed (rather than kept private to {@link buildDiagnostics}) because it is
 * the unit the contract suite drives with a deliberately over-stuffed input:
 * a caller that hands this an object carrying every credential field in the
 * record must still get a report without any of them.
 */
export function sanitizeDiagnostics(source: {
  devices?: readonly unknown[]
  sessions?: readonly unknown[]
  recentErrors?: readonly unknown[]
  stats?: Partial<DiagnosticsStats>
}): {
  devices: DiagnosticsDevice[]
  sessions: DiagnosticsSession[]
  recentErrors: DiagnosticsError[]
  stats: DiagnosticsStats
} {
  return {
    devices: (source.devices ?? []).map(projectDevice),
    sessions: (source.sessions ?? []).map((raw): DiagnosticsSession => {
      const value = (raw ?? {}) as Record<string, unknown>
      const cursor = value['cursor'] as Record<string, unknown> | undefined
      const deviceId = typeof value['deviceId'] === 'string' ? value['deviceId'] : ''
      const sessionId = typeof value['sessionId'] === 'string' ? value['sessionId'] : ''
      return {
        sessionId,
        deviceId,
        subscriptions: typeof value['subscriptions'] === 'number' ? value['subscriptions'] : 0,
        ...(cursor === undefined
          ? {}
          : {
              cursor: {
                sessionId: typeof cursor['sessionId'] === 'string' ? cursor['sessionId'] : sessionId,
                streamEpoch: typeof cursor['streamEpoch'] === 'string' ? cursor['streamEpoch'] : '',
                seq: typeof cursor['seq'] === 'string' ? cursor['seq'] : '',
              },
            }),
      }
    }),
    recentErrors: (source.recentErrors ?? []).map((raw): DiagnosticsError => {
      const value = (raw ?? {}) as Record<string, unknown>
      return {
        at: typeof value['at'] === 'string' ? value['at'] : new Date(0).toISOString(),
        ...(typeof value['deviceId'] === 'string' ? { deviceId: value['deviceId'] } : {}),
        ...(typeof value['sessionId'] === 'string' ? { sessionId: value['sessionId'] } : {}),
        reason: typeof value['reason'] === 'string' ? value['reason'] : 'INTERNAL',
        // Bounded HERE, at the boundary, not merely by producer discipline:
        // this is the only free-text field the whitelist passes through.
        message: truncateErrorMessage(typeof value['message'] === 'string' ? value['message'] : ''),
      }
    }),
    stats: {
      connections: source.stats?.connections ?? 0,
      sockets: source.stats?.sockets ?? 0,
      connectionsBuilt: source.stats?.connectionsBuilt ?? 0,
      subscriptions: source.stats?.subscriptions ?? 0,
    },
  }
}

/** Names the plugin and its route prefix in the report header. */
export interface DiagnosticsIdentity {
  name: string
  prefix: string
}

const DEFAULT_IDENTITY: DiagnosticsIdentity = { name: 'dsh-cherry-bridge', prefix: '/cherry-remote/api' }

/**
 * Aggregates the live report.
 *
 * Every source is read through a guard: a diagnostics endpoint that throws
 * because one device's connection resolver misbehaved would be useless exactly
 * when it is needed most. A failed device is reported as `offline` (the honest
 * "unknown") and the rest of the report still goes out.
 */
export function buildDiagnostics(
  sources: DiagnosticsSources,
  identity: DiagnosticsIdentity = DEFAULT_IDENTITY,
): DiagnosticsReport {
  // Guarded like every other source below. The store is a legitimate thrower (a
  // quarantined archive refuses to be read at all), and this endpoint is opened
  // exactly when something is wrong — so it must not itself be the thing that
  // fails. A failed read degrades the DEVICE section to empty and the rest of
  // the report still ships, which is the same contract the sessions/stats/
  // recentErrors guards below already honour.
  let records: readonly DeviceRecord[] = []
  try {
    records = sources.store.list()
  } catch {
    records = []
  }
  const devices: DiagnosticsDevice[] = []
  const sessions: DiagnosticsSession[] = []

  for (const record of records) {
    let state: DeviceState = 'offline'
    let limits: EffectiveLimits | undefined
    try {
      const connection = sources.connect(record.deviceId)
      state = connection.state
      limits = connection.limits
    } catch {
      state = 'offline'
      limits = undefined
    }
    devices.push(sanitizeDevice(record, state, limits))
  }

  try {
    for (const entry of sources.sessions?.() ?? []) {
      sessions.push({
        sessionId: entry.sessionId,
        deviceId: entry.deviceId,
        subscriptions: entry.subscriptions,
        ...(entry.cursor === undefined ? {} : { cursor: { ...entry.cursor } }),
      })
    }
  } catch {
    // A subscription source that misbehaves costs its own section only.
  }

  let recentErrors: readonly DiagnosticsError[] = []
  try {
    recentErrors = sources.recentErrors?.() ?? []
  } catch {
    recentErrors = []
  }

  let stats: Partial<DiagnosticsStats> = {}
  try {
    stats = sources.stats?.() ?? {}
  } catch {
    stats = {}
  }

  const projected = sanitizeDiagnostics({ devices, sessions, recentErrors, stats })
  return {
    generatedAt: new Date().toISOString(),
    plugin: { name: identity.name, prefix: identity.prefix },
    devices: projected.devices,
    sessions: projected.sessions,
    stats: projected.stats,
    recentErrors: projected.recentErrors,
    contractDifferences: CONTRACT_DIFFERENCES.map((entry) => ({ id: entry.id, title: entry.title })),
  }
}

/**
 * The device keys a sanitized report is allowed to carry (contract ③).
 *
 * `limits` is here because {@link sanitizeDevice} EMITS it. A whitelist that
 * omits a field the projection produces is a false statement about the
 * contract: an operator (or a test) reading this list to decide what may appear
 * in a report would conclude the negotiated caps never reach it, when in fact
 * they are exactly what an operator needs to judge whether a refusal was the
 * peer's cap talking. They carry no credential — four numbers, themselves
 * re-projected field by field in {@link projectLimits}.
 */
export const DIAGNOSTICS_DEVICE_KEYS: readonly string[] = [
  'deviceId',
  'displayName',
  'state',
  'enabled',
  'hosts',
  'port',
  'desktopIdentity',
  'limits',
]
