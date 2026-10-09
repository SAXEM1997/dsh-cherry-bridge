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
 */

/** The plugin's same-origin route prefix; relative, never absolute. */
export const API_BASE = '/cherry-remote/api'

/** The five device states the connection layer reports. */
export type DeviceState = 'connected' | 'connecting' | 'offline' | 'disabled' | 'identity-mismatch'

/** One device exactly as `GET /devices` returns it. Never carries a credential. */
export interface DeviceSummary {
  deviceId: string
  displayName: string
  state: DeviceState
  enabled: boolean
  hosts: string[]
  port: number
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
 */
export const STAGE_LABELS: Record<string, string> = {
  validate: '正在校验配对信息…',
  connect: '正在连接 Cherry Studio…',
  claim: '正在交换凭据…',
  waiting: '等待在 Cherry Studio 上确认…',
  'pairing-failed': '配对失败',
  // Refused: the overwhelmingly common cause is a code mismatch, so the label
  // names the comparison and the way out (a fresh payload).
  rejected: '配对被拒绝——请核对桌面端显示的 6 位验证码是否与本页一致，并在 Cherry Studio 重新生成配对码后重试',
  expired: '配对邀请已过期——请在 Cherry Studio 重新生成配对码后重试',
  // The everyday failure: the desktop is off, asleep, or off the network.
  unreachable: '无法连接 Cherry Studio，请确认桌面端已启动且与本机同网',
  'invalid-payload': '配对信息无效或已过期，请在 Cherry Studio 重新生成后重试',
  // The plugin's own archive is unreadable: nothing here can fix it, and a
  // retry will fail identically until an operator moves the bad file aside.
  'archive-quarantined':
    '设备档案无法读取（已保留为 .corrupt 副本）。请将该文件移开后重启或重新加载插件，再重试配对',
}

/** Human labels for the five states, shared by the light and the light's name. */
export const STATE_LABELS: Record<DeviceState, string> = {
  connected: '已连接',
  connecting: '连接中',
  offline: '离线',
  disabled: '已停用',
  'identity-mismatch': '身份不匹配',
}
