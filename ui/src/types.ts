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
 * The five degradation sources (B12/B16/B17).
 *
 * The list is FIXED: a corrupt scope document is carried by the strictness
 * order (`selected` + an empty list) and the page's own empty-state wording,
 * NOT by a sixth member here (B9).
 */
export type DegradedSource =
  | 'install'
  | 'workspace-list'
  | 'visibility-only'
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
