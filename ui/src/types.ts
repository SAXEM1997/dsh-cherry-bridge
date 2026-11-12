/**
 * Shared wire + component types for the Cherry Bridge settings page.
 *
 * These mirror the Task 11 HTTP face VERBATIM (src/httpApi.ts): the base path is
 * relative and same-origin by construction — there is no port, no bootstrap
 * file and no credential channel, so the browser reads its own origin.
 *
 * No `import` statements live here on purpose: this module is imported by the
 * callers' type positions as well as by value (`API_BASE`, the label maps), and
 * keeping it dependency-free means the vite bundle inlines it exactly once.
 *
 * The one EXCEPTION is `./i18n`, imported for the two re-exported label tables
 * below: the Chinese strings the page shows must have exactly one home, and that
 * home is the zh dictionary. `i18n.ts` pulls in nothing but `react`, and the
 * label tables take their values at MODULE LOAD (not per render), so the
 * inlining story above is unchanged — `types.ts` still has no host dependency.
 */
import { dictionaries } from './i18n'

/** The plugin's same-origin route prefix; relative, never absolute. */
export const API_BASE = '/cherry-remote/api'

/** The five device states the connection layer reports. */
export type DeviceState = 'connected' | 'connecting' | 'offline' | 'disabled' | 'identity-mismatch'

/**
 * One device exactly as `GET /devices` returns it. Never carries a credential.
 *
 * `ports` is the per-HOST dial port map: each candidate address dials its own
 * port, and the record-level `port` is the fallback for a host the map does not
 * carry (a stored v4 record has an entry for every host, so the card's `??` arm
 * only fires on a malformed map). Required — `GET /devices` always emits it.
 */
export interface DeviceSummary {
  deviceId: string
  displayName: string
  state: DeviceState
  enabled: boolean
  hosts: string[]
  port: number
  ports: Record<string, number>
  /**
   * The addresses the operator has FORGOTTEN (issues #185/#204): not dialed, and
   * not re-learned from the desktop's own advertisement until 恢复 lifts the
   * mark. Required — `GET /devices` emits an empty list rather than omitting the
   * key — so the card branches on `length`, never on presence.
   */
  forgottenHosts: string[]
}

/** A `PATCH /devices/:id` body; every field optional, `hosts` is whole-replace. */
export interface DevicePatch {
  displayName?: string
  enabled?: boolean
  hosts?: string[]
  port?: number
}

/** The `device-state` SSE payload. */
export interface DeviceStateEvent {
  deviceId: string
  state: DeviceState
}

/**
 * The `pairing-progress` SSE payload; `stage` arrives verbatim from pairing.
 *
 * `claimId` identifies WHICH run produced the frame. The stream is shared by
 * every tab, so a wizard must filter frames by the id its own `POST /pair`
 * returned — otherwise a second tab would show the first tab's verification
 * code and settle on the first tab's verdict. Optional because a frame is only
 * stamped when it came from a pairing run.
 */
export interface PairingProgressEvent {
  stage: string
  detail?: string
  claimId?: string
}

/**
 * The `EventSource` surface this client uses. Declared structurally so the app
 * never depends on the DOM lib (the bundle is externalized, the tests run in
 * jsdom) and so tests can inject a controllable fake — jsdom ships none.
 */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void
  removeEventListener(type: string, listener: (event: { data: string }) => void): void
  close(): void
}

/** Opens an event stream; defaults to the global `EventSource`. */
export type EventSourceFactory = (url: string) => EventSourceLike

/** The state machine of one pairing run, derived from the progress stages. */
export type PairingPhase = 'idle' | 'submitting' | 'waiting' | 'done' | 'failed'

/**
 * The pairing stages that end a run.
 *
 * `approved` is the one success. The rest are the FAILURE verdicts the server
 * publishes after the 202: `POST /pair` returns immediately, so a failure is not
 * an HTTP status — it arrives as a `pairing-progress` frame whose `stage` is
 * `verdict.error` (src/httpApi.ts `startPairing`), and `PairingErrorKind` is
 * `invalid-payload | rejected | expired | unreachable`. Every one of them must
 * end the run, or the wizard sits in 'waiting' forever with a disabled submit
 * button. `pairing-failed` is the non-`PairingError` fallback verdict, and
 * `archive-quarantined` is the damaged-`devices.json` refusal — also a terminal
 * state, since no retry can succeed until the file is moved aside.
 */
export const TERMINAL_STAGES = [
  'approved',
  'rejected',
  'expired',
  'unreachable',
  'invalid-payload',
  'pairing-failed',
  'archive-quarantined',
] as const

/** The single stage that ends a run successfully. */
export const APPROVED_STAGE = 'approved'

/** The single stage that carries the 6-digit verification code (ruling). */
export const VERIFICATION_CODE_STAGE = 'verification-code'

/**
 * Human labels for the progress stages the wizard narrates.
 *
 * The three FAILURE labels carry the recovery step, not just the verdict: the
 * user is standing in front of two windows, and "被拒绝" without "go compare the
 * code" leaves them with nothing to do but retry blindly. The wording mirrors
 * the server's own verdict messages (`src/pairing.ts`).
 *
 * The VALUES are the zh dictionary's entries, not a second copy of them:
 * `ui/src/i18n.ts` is the single source of truth for every Chinese string the
 * page shows, so the Chinese rendering of this table is unchanged by
 * construction and the ~140 existing assertions against these literals in
 * `tests/unit/ui.test.ts` keep holding. The RENDER side uses {@link STAGE_KEYS}
 * (see below), which picks the same entry for whichever language is active.
 */
export const STAGE_LABELS: Record<string, string> = {
  validate: dictionaries.zh['wizard.stage.validate']!,
  connect: dictionaries.zh['wizard.stage.connect']!,
  claim: dictionaries.zh['wizard.stage.claim']!,
  waiting: dictionaries.zh['wizard.stage.waiting']!,
  'pairing-failed': dictionaries.zh['wizard.stage.pairing-failed']!,
  // Refused: the overwhelmingly common cause is a code mismatch, so the label
  // names the comparison and the way out (a fresh payload).
  rejected: dictionaries.zh['wizard.stage.rejected']!,
  expired: dictionaries.zh['wizard.stage.expired']!,
  // The everyday failure: the desktop is off, asleep, or off the network.
  unreachable: dictionaries.zh['wizard.stage.unreachable']!,
  'invalid-payload': dictionaries.zh['wizard.stage.invalid-payload']!,
  // The plugin's own archive is unreadable: nothing here can fix it, and a
  // retry will fail identically until an operator moves the bad file aside.
  'archive-quarantined': dictionaries.zh['wizard.stage.archive-quarantined']!,
}

/**
 * The dictionary KEYS behind {@link STAGE_LABELS}, one per stage.
 *
 * Same shape and same key set as the label table — `Record<string, string>`
 * rather than a union-keyed map, because a stage arrives as an arbitrary string
 * off the wire and the render side falls back to the raw stage for one this
 * build does not know.
 *
 * Why both tables exist: a component labels a verdict with `t(STAGE_KEYS[stage]
 * ?? stage)`, which needs a KEY, while assertions and any non-translating caller
 * need the Chinese TEXT. Pinning the text to `dictionaries.zh` and exposing the
 * key separately is what keeps those two in step.
 */
export const STAGE_KEYS: Record<string, string> = {
  validate: 'wizard.stage.validate',
  connect: 'wizard.stage.connect',
  claim: 'wizard.stage.claim',
  waiting: 'wizard.stage.waiting',
  'pairing-failed': 'wizard.stage.pairing-failed',
  rejected: 'wizard.stage.rejected',
  expired: 'wizard.stage.expired',
  unreachable: 'wizard.stage.unreachable',
  'invalid-payload': 'wizard.stage.invalid-payload',
  'archive-quarantined': 'wizard.stage.archive-quarantined',
}

// ---------------------------------------------------------------------------
// The scope document face (spec §6.3/§6.4)
// ---------------------------------------------------------------------------

/**
 * The two enablement modes, verbatim from the server's document.
 *
 * `global` means the tools are available in every workspace and the saved
 * `workspaceIds` do NOT take part in the judgement (B2) — which is why the page
 * must say so rather than pretending an unticked list means "nothing enabled".
 */
export type ScopeMode = 'global' | 'selected'

/** One scope document, exactly as `GET/PUT /cherry-remote/api/scope` carries it. */
export interface ScopeDoc {
  mode: ScopeMode
  workspaceIds: string[]
  revision: number
}

/** One registered workspace, projected down to what the page may see. */
export interface ScopeWorkspace {
  id: string
  title: string
  path: string
}

/**
 * The host capability tri-state (B7/D8/D13).
 *
 * `capable` is `state === 'ready'` and nothing else; `pending` is "the injected
 * callbacks have not arrived yet" and must never be rendered as a refusal.
 */
export type ScopeHostState = 'pending' | 'unsupported' | 'ready'

/**
 * The three degradation sources (B12/B16/B17).
 *
 * The list is FIXED: a corrupt scope document is carried by the strictness
 * order (`selected` + an empty list) and the page's own empty-state wording,
 * NOT by a fourth member here (B9).
 */
export type DegradedSource =
  | 'workspace-list'
  | 'scope-version'
  | 'path-normalization'

/** One degradation note; the same source never appears twice (latest wins). */
export interface DegradedNote {
  source: DegradedSource
  reason: string
}

/** The host block beside the document: capability plus its degradation notes. */
export interface ScopeHost {
  state: ScopeHostState
  capable: boolean
  reason: string
  degraded: DegradedNote[]
}

/** One "ticked, but this session's cwd does not match" diagnostic entry. */
export interface PathUnmatchedEntry {
  agentId: string
  cwd: string
}

/**
 * The whole `GET /cherry-remote/api/scope` body.
 *
 * `staleWorkspaceIds` and `pathUnmatched` are two SEPARATE channels on purpose
 * (§6.1): "an id the registry no longer has" and "this session's cwd belongs to
 * no registered workspace" are different answers and neither may be derived
 * from — or merged with — the other.
 */
export interface ScopeResponse {
  scope: ScopeDoc
  workspaces: ScopeWorkspace[]
  staleWorkspaceIds: string[]
  pathUnmatched: PathUnmatchedEntry[]
  host: ScopeHost
}

/** The read-modify-write body `PUT /scope` accepts. */
export interface ScopeSaveRequest {
  mode: ScopeMode
  workspaceIds: string[]
  expectedRevision: number
}

/** The `PUT /scope` success body: the committed document plus what it pruned. */
export interface ScopeSaveResult {
  scope: ScopeDoc
  pruned: string[]
}

/**
 * The panel's HTTP seam, in the same style as {@link EventSourceFactory}: the
 * default is the real same-origin `fetch` client, and tests inject a stub.
 */
export interface ScopeClient {
  get(): Promise<ScopeResponse>
  put(body: ScopeSaveRequest): Promise<ScopeSaveResult>
}

/** Human labels for the five states, shared by the light and the light's name. */
export const STATE_LABELS: Record<DeviceState, string> = {
  connected: dictionaries.zh['device.state.connected']!,
  connecting: dictionaries.zh['device.state.connecting']!,
  offline: dictionaries.zh['device.state.offline']!,
  disabled: dictionaries.zh['device.state.disabled']!,
  'identity-mismatch': dictionaries.zh['device.state.identity-mismatch']!,
}

/**
 * The dictionary KEYS behind {@link STATE_LABELS}, one per device state.
 *
 * Same shape as the label table (`Record<DeviceState, string>`), so a component
 * can translate a state with `t(STATE_KEYS[state] ?? state)` and stay exhaustive
 * over {@link DeviceState} at compile time.
 */
export const STATE_KEYS: Record<DeviceState, string> = {
  connected: 'device.state.connected',
  connecting: 'device.state.connecting',
  offline: 'device.state.offline',
  disabled: 'device.state.disabled',
  'identity-mismatch': 'device.state.identity-mismatch',
}

// ---------------------------------------------------------------------------
// The experimental subagent face (#233)
// ---------------------------------------------------------------------------

/**
 * The shape the server reports for a config value that arrived unusable.
 *
 * Mirrors `ReceivedShape` in `src/subagent.ts`. It is a CLOSED set because the
 * page translates it: rendering a raw `typeof` result inside a Chinese sentence
 * is the mixed-language page these codes exist to remove. A value outside this
 * set (a newer server) falls back to the token itself rather than throwing.
 */
export type ReceivedShape =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null'
  | 'undefined'
  | 'function'
  | 'symbol'
  | 'bigint'
  | 'NaN'
  | 'Infinity'
  | '-Infinity'

/**
 * One reason the configuration is unusable, as the server sends it: a code plus
 * its parameters, never a sentence.
 *
 * The page owns the wording (`subagent.problem.*`). Keeping the split here is
 * what lets the same document be shown in two languages, and it is why these
 * arms are exact rather than one bag of optional fields.
 */
export type SubagentProblem =
  | {
      readonly code: 'not-string' | 'not-boolean' | 'not-array' | 'not-object'
      readonly field: string
      readonly received: ReceivedShape
    }
  | {
      readonly code:
        | 'empty'
        | 'missing'
        | 'route-cwd-prefix'
        | 'route-cwd-prefix-root'
        | 'route-cwd-prefix-relative'
        | 'cwd-mode-unimplemented'
      readonly field: string
    }
  | {
      readonly code: 'out-of-range'
      readonly field: string
      readonly min: number
      readonly max: number
      readonly received: ReceivedShape
    }
  | {
      readonly code: 'enum'
      readonly field: string
      readonly allowed: readonly string[]
      readonly received: ReceivedShape
    }
  | { readonly code: 'exclusive'; readonly field: string; readonly other: string }

/** Why the provider is registered but the model-facing tool is not. */
export type SubagentToolProblem =
  | { code: 'no-tools-service' }
  | { code: 'no-start-activation' }
  | { code: 'no-step-condition' }
  | { code: 'host-refused'; message: string }

/**
 * Why the subsystem is in the state it is.
 *
 * `unsupported` and `failed` are the pair the page must NOT collapse: one is a
 * host this operator cannot change, the other is a typo they can fix on the
 * same screen.
 */
export type SubagentStatusReason =
  | { code: 'disabled' | 'awaiting-injection' | 'unsupported' }
  | { code: 'invalid'; problems: SubagentProblem[] }
  | { code: 'provider-refused'; message: string }
  | { code: 'ready'; providerName: string; toolName: string }
  | { code: 'ready-without-tool'; providerName: string; toolName: string; problem: SubagentToolProblem }

/** `SubagentHost.status()`, as `GET /subagent` echoes it. */
export interface SubagentStatus {
  state: 'pending' | 'unsupported' | 'failed' | 'ready'
  reason: SubagentStatusReason
}

/**
 * One per-directory override — `CherrySubagentRoute` in `src/subagent.ts`.
 *
 * Mirrored because the panel SHOWS the table: a route can make the document
 * invalid with a problem path (`routes[0].cwdPrefix`) the operator has to be
 * able to read against something, and the page has no editor for it.
 */
export interface CherrySubagentRoute {
  cwdPrefix: string
  device?: string
  workspaceId?: string
}

/**
 * The stored configuration document — `SubagentConfig` in `src/subagent.ts`.
 *
 * Every field is optional because the document is a draft: the switch is what
 * decides, and a half-written target behind a closed switch is not an error.
 * `revision` is the server's lock, not a field the page edits.
 */
export interface SubagentConfig {
  enabled?: boolean
  providerName?: string
  toolName?: string
  device?: string
  agentId?: string
  workspaceId?: string
  workspaceKind?: 'system'
  cwdMode?: 'isolated' | 'shared'
  /** Per-directory device/workspace overrides, in precedence order. */
  routes?: readonly CherrySubagentRoute[]
  timeoutMs?: number
  maxInteractionAbandons?: number
  revision?: number
}

/** The whole `GET /cherry-remote/api/subagent` body. */
export interface SubagentResponse {
  /** The document as an object, always, even when the stored value was not one. */
  subagent: SubagentConfig & { revision: number }
  /** `config` = the profile seed; `file` = the document this page saves. */
  source: 'file' | 'config'
  /** What the RUNNING assembly decided — not what the stored document implies. */
  status: SubagentStatus
  /** True while the stored document's decision differs from the running one. */
  pendingRestart: boolean
}

/** The read-modify-write body `PUT /subagent` accepts. */
export interface SubagentSaveRequest extends SubagentConfig {
  expectedRevision: number
}

import type { TargetProblem } from './subagentTargets'

/** One agent a device's peer reported — `GET /subagent/targets`'s `agents[]` row. */
export interface SubagentTargetAgent {
  agentId: string
  /**
   * Optional ON THE WIRE, and the page must survive its absence: the endpoint's
   * own contract is "the page falls back to the id", so a peer that reports no
   * names still gets a usable list rather than an empty one.
   */
  name?: string
  emoji?: string
}

/** One registered workspace — the same row shape, keyed by `workspaceId`. */
export interface SubagentTargetWorkspace {
  workspaceId: string
  name?: string
}

/**
 * The endpoint's success body: exactly the four keys the page renders.
 *
 * `workspaces` and `systemWorkspace` are present ONLY when the request carried an
 * `agentId` (a workspace belongs to an agent), so their absence means "not
 * asked", never "none". `truncated` says the walk stopped at its safety bound —
 * the list is real but incomplete, which the page reports rather than hides.
 */
export interface SubagentTargetsListing {
  agents: readonly SubagentTargetAgent[]
  workspaces?: readonly SubagentTargetWorkspace[]
  systemWorkspace?: boolean
  truncated?: { lists: readonly string[]; reason: string }
}

/**
 * `GET /subagent/targets`: a listing or a problem, never both.
 *
 * The problem type is `TargetProblem` from `./subagentTargets` — ONE declaration,
 * because the panel hands the value straight to `targetOptions`' field state. A
 * second, structurally identical interface here would be two names for one fact,
 * and the day one grows a field the other would silently not.
 */
export type SubagentTargetsResponse = SubagentTargetsListing | { problem: TargetProblem }

/** The panel's HTTP seam: the default is the same-origin client, tests inject a stub. */
export interface SubagentClient {
  get(): Promise<SubagentResponse>
  put(body: SubagentSaveRequest): Promise<SubagentResponse>
  /**
   * The candidate source (#260). `agentId` is what makes the answer carry the
   * workspace half; without it the page is asking only "which agents exist here".
   */
  targets(device: string, agentId?: string): Promise<SubagentTargetsResponse>
}
