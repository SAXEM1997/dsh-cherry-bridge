/**
 * The plugin's same-origin HTTP calls.
 *
 * Every path is RELATIVE: the settings page is served by the host, so the API
 * lives on the page's own origin (spec §3.7). Requests are JSON in / JSON out,
 * and a non-2xx response is turned into an {@link ApiError} carrying the
 * server's structured verdict (`{error, message}`), which is what the UI shows —
 * distinguishing a client-side `invalid-payload` from a peer-side `unreachable`
 * is the whole point of the wire contract.
 */
import { API_BASE } from './types'
import type {
  DevicePatch,
  DeviceSummary,
  ScopeClient,
  ScopeResponse,
  ScopeSaveRequest,
  ScopeSaveResult,
} from './types'

/** A refused call, carrying the server's structured error verbatim. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    // The code is part of the user-facing text on purpose: `invalid-payload` (a
    // bad paste, fixable here) and `unreachable` (the peer, nothing to fix here)
    // are the same 4xx/5xx shape otherwise, and the wire contract exists so the
    // page can tell them apart.
    super(`${code}: ${message}`)
    this.name = 'ApiError'
  }
}

/** Reads a JSON body without throwing on an empty (204) or non-JSON response. */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function request(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await readBody(response)
  if (!response.ok) {
    const record = (body ?? {}) as { error?: unknown; message?: unknown }
    const code = typeof record.error === 'string' ? record.error : `http-${response.status}`
    const message = typeof record.message === 'string' ? record.message : code
    throw new ApiError(response.status, code, message)
  }
  return body
}

/** `GET /devices` — the full card list, states projected server-side. */
export async function listDevices(): Promise<DeviceSummary[]> {
  const body = await request(`${API_BASE}/devices`)
  return Array.isArray(body) ? (body as DeviceSummary[]) : []
}

/**
 * `POST /pair` — returns as soon as the server has a claim (202 + `{claimId}`).
 *
 * It deliberately does NOT wait for approval: the 6-digit code and the verdict
 * arrive as `pairing-progress` SSE frames, which is why the caller must already
 * be subscribed when this resolves.
 */
export async function startPairing(payload: string, name?: string): Promise<{ claimId?: string }> {
  const body = await request(`${API_BASE}/pair`, {
    method: 'POST',
    body: JSON.stringify(name === undefined || name === '' ? { payload } : { payload, name }),
  })
  return (body ?? {}) as { claimId?: string }
}

/** `PATCH /devices/:id` — `hosts` is whole-replace; omitted fields are untouched. */
export async function patchDevice(deviceId: string, patch: DevicePatch): Promise<DeviceSummary> {
  const body = await request(`${API_BASE}/devices/${encodeURIComponent(deviceId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return body as DeviceSummary
}

/** `DELETE /devices/:id` — 204, no body. */
export async function removeDevice(deviceId: string): Promise<void> {
  await request(`${API_BASE}/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' })
}

/**
 * `GET /scope` — the whole scope state in ONE body (spec §6.3).
 *
 * The page cannot reach the workspace registry itself, so the server projects
 * the list down (`id`/`title`/`path` only) and answers with the document, the
 * two diagnostic channels and the host block together.
 */
export async function getScope(): Promise<ScopeResponse> {
  const body = await request(`${API_BASE}/scope`)
  return body as ScopeResponse
}

/**
 * `PUT /scope` — validate and commit the read-modify-write cycle.
 *
 * `expectedRevision` travels beside the document (that is what makes the write
 * conflict-detecting), and a refusal arrives as an {@link ApiError} carrying the
 * server's stable code VERBATIM: `invalid-scope` / `missing-expected-revision`
 * (400), `scope-revision-conflict` (409), `workspace-list-unavailable` /
 * `scope-version-unsupported` (503). The caller branches on that string — never
 * on the prose — because only the code is stable across versions.
 */
export async function putScope(body: ScopeSaveRequest): Promise<ScopeSaveResult> {
  const result = await request(`${API_BASE}/scope`, { method: 'PUT', body: JSON.stringify(body) })
  return result as ScopeSaveResult
}

/**
 * The production {@link ScopeClient}: the same-origin calls above behind the
 * seam the panel (and `App`) accept, so tests can inject a stub without
 * touching production wiring.
 */
export const defaultScopeClient: ScopeClient = {
  get: () => getScope(),
  put: (body) => putScope(body),
}
