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

/** The `pairing-progress` SSE payload; `stage` arrives verbatim from pairing. */
export interface PairingProgressEvent {
  stage: string
  detail?: string
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

/** The pairing stages that end a run. */
export const TERMINAL_STAGES = ['approved', 'rejected', 'expired'] as const

/** The single stage that carries the 6-digit verification code (ruling). */
export const VERIFICATION_CODE_STAGE = 'verification-code'

/** Human labels for the progress stages the wizard narrates. */
export const STAGE_LABELS: Record<string, string> = {
  validate: '正在校验配对信息…',
  connect: '正在连接 Cherry Studio…',
  claim: '正在交换凭据…',
  waiting: '等待在 Cherry Studio 上确认…',
  'pairing-failed': '配对失败',
  rejected: '配对被拒绝',
  expired: '配对邀请已过期',
}

/** Human labels for the five states, shared by the light and the light's name. */
export const STATE_LABELS: Record<DeviceState, string> = {
  connected: '已连接',
  connecting: '连接中',
  offline: '离线',
  disabled: '已停用',
  'identity-mismatch': '身份不匹配',
}
