// @vitest-environment jsdom
/**
 * Step 1 (RED) — the settings-page web client contract.
 *
 * Three scenarios from the Task 12 brief, one `describe` each:
 *
 *  1. pairing wizard: POST /pair returns 202 + `{claimId}` immediately (the HTTP
 *     call does NOT block until approval), the 6-digit verification code is
 *     rendered from the SSE `pairing-progress` frame that carries it, and the
 *     whole flow disappears once a terminal frame arrives;
 *  2. device cards: the five-state status light plus the four actions, each
 *     asserting the exact endpoint and body it must call;
 *  3. SSE: a state change updates an already-rendered card, and the FIRST-FRAME
 *     contract renders the full current state before any change happens.
 *
 * Plus the mount path: the bundle registers its page through the host's `slots`
 * service (a fake slots service records the registration), and claims no
 * `document.body` mount point of its own.
 *
 * Two seams make this testable in jsdom, where `EventSource` does not exist:
 * `eventSourceFactory` (a controllable fake) and `codeLifetimeMs` (the transient
 * display window). Both default to production behaviour.
 *
 * The load-bearing assertion of the whole file is the subscribe-before-pair
 * ordering in test 1: the SSE stream carries no replay, so a wizard that POSTs
 * before subscribing loses the verification code forever.
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import type { ComponentProps, ComponentType } from 'react'
import type { DeviceSummary, EventSourceLike } from '../../ui/src/types'
import { ApiError, REQUEST_TIMEOUT, listDevices, startPairing } from '../../ui/src/api'
import { App } from '../../ui/src/App'
import { DeviceCard } from '../../ui/src/DeviceCard'
import { dictionaries } from '../../ui/src/i18n'
import { inject, apply, SETTINGS_NAMESPACE, SETTINGS_SLOT } from '../../ui/src/main'
import type { SlotRegistration, SlotsService } from '../../ui/src/main'
import { STAGE_LABELS } from '../../ui/src/types'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** One `event:`/`data:` frame, as the server writes it to the stream. */
type Frame = { event: string; data: unknown }

/** A controllable `EventSource` stand-in: no jsdom `EventSource` exists. */
class FakeEventSource implements EventSourceLike {
  static readonly instances: FakeEventSource[] = []

  readonly url: string
  readyState = 0
  closed = false
  onopen: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly listeners = new Map<string, Set<(event: { data: string }) => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.closed = true
    this.readyState = 2
  }

  /** Pushes one frame to every subscriber of its event type. */
  emit(frame: Frame): void {
    for (const listener of this.listeners.get(frame.event) ?? []) {
      listener({ data: JSON.stringify(frame.data) })
    }
  }
}

/** The most recently opened stream; the app opens exactly one. */
function stream(): FakeEventSource {
  const latest = FakeEventSource.instances.at(-1)
  if (latest === undefined) throw new Error('the app opened no /events stream')
  return latest
}

interface FetchCall {
  url: string
  method: string
  body: unknown
  /** Order relative to the SSE stream opening, for the ordering assertion. */
  at: number
}

interface Harness {
  calls: FetchCall[]
  /** Ordered operation log: `sse` once, then one `fetch <METHOD> <url>` each. */
  order: string[]
  eventSourceFactory: (url: string) => EventSourceLike
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * The `GET /cherry-remote/api/scope` answer every render path needs.
 *
 * `App` mounts the 「启用范围」 panel, which reads on mount — and this mock THROWS
 * on an unregistered request, so a path with no `/scope` answer rejects the
 * panel's promise and renders its error line instead (the failure mode is per
 * render path, not "every case turns red"). Registered LAST inside
 * `installFetch`, because the lookup is first-match-wins: a case that ever needs
 * its own `/scope` entry still overrides it. Built fresh per harness on purpose
 * — a `Response` body can only be read once.
 */
function scopeSnapshot(): Response {
  return jsonResponse(200, {
    scope: { mode: 'selected', workspaceIds: [], revision: 0 },
    workspaces: [],
    staleWorkspaceIds: [],
    pathUnmatched: [],
    host: { state: 'ready', capable: true, reason: '宿主能力齐备', degraded: [] },
  })
}

function installFetch(responses: Array<[string, string, Response]>): Harness {
  const calls: FetchCall[] = []
  const order: string[] = []
  let counter = 0
  const table: Array<[string, string, Response]> = [...responses, ['GET', '/cherry-remote/api/scope', scopeSnapshot()]]
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const raw = init?.body
    calls.push({ url, method, body: raw === undefined ? undefined : JSON.parse(String(raw)), at: counter++ })
    order.push(`fetch ${method} ${url}`)
    for (const [responseMethod, responseUrl, response] of table) {
      if (responseMethod === method && url.endsWith(responseUrl)) return response
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const eventSourceFactory = (url: string): EventSourceLike => {
    order.push('sse')
    if (!url.endsWith('/cherry-remote/api/events')) {
      throw new Error(`unexpected event stream url: ${url}`)
    }
    return new FakeEventSource(url)
  }
  return { calls, order, eventSourceFactory }
}

const DEVICE = {
  deviceId: 'dev-1',
  displayName: '工作站',
  state: 'offline',
  enabled: true,
  hosts: ['192.168.1.10'],
  port: 4343,
  // Uniform on purpose: every host dials the record port, so the per-address
  // row stays hidden and every existing card assertion renders the same tree.
  ports: { '192.168.1.10': 4343 },
}

type AppProps = ComponentProps<typeof App>

/**
 * Renders the settings page, pushes the initial `device-state` frame, and waits
 * for the card to appear — the shared opening move of every card test.
 *
 * Only `/devices` is registered here: `/scope` (the panel `App` mounts) is
 * answered by `installFetch` itself, so the four DIRECT render paths below get
 * it through the same table.
 */
async function renderWithDevice(
  responses: Array<[string, string, Response]> = [],
  props: Partial<AppProps> = {},
): Promise<Harness> {
  const harness = installFetch([
    ['GET', '/cherry-remote/api/devices', jsonResponse(200, [DEVICE])],
    ...responses,
  ])
  render(
    createElement(App, {
      eventSourceFactory: harness.eventSourceFactory,
      codeLifetimeMs: 60_000,
      ...props,
    }),
  )
  stream().emit({ event: 'device-state', data: { deviceId: DEVICE.deviceId, state: DEVICE.state } })
  await screen.findByText(DEVICE.displayName)
  return harness
}

/** Fills the payload box and submits the wizard form. */
function submitPayload(payload = 'cherry-pair-abc'): void {
  fireEvent.change(screen.getByLabelText('配对信息'), { target: { value: payload } })
  fireEvent.click(screen.getByRole('button', { name: '开始配对' }))
}

// ---------------------------------------------------------------------------
// ① Pairing wizard
// ---------------------------------------------------------------------------

describe('pairing wizard', () => {
  it('①a tells the user to SCAN the desktop QR code (the desktop never shows the pairing text itself)', async () => {
    // The desktop's pairing screen renders only a QR code; the pairing
    // information lives on the page that QR points at. The wizard therefore
    // cannot say "copy the generated pairing information" — it must route the
    // user through a scan.
    await renderWithDevice([])

    // Both the hint and the numbered steps have to route through a scan.
    expect(screen.getAllByText(/扫码/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/微信/).length).toBeGreaterThan(0)
    // The input is labelled in the user's terms, and its placeholder says WHERE
    // the text comes from.
    expect(screen.getByLabelText('配对信息')).toBeTruthy()
    expect(screen.getByPlaceholderText('粘贴扫码后页面上显示的配对信息')).toBeTruthy()
    expect(screen.queryByText(/复制生成的配对信息/)).toBeNull()
  })

  it('returns 202 + claimId immediately and renders the code from the SSE frame', async () => {
    const { calls } = await renderWithDevice([['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: 'claim-7' })]])

    submitPayload('cherry-pair-abc')

    // The 202 body is enough to leave the "starting" state: the request does not
    // block until approval (ruling 2).
    await screen.findByText('配对进行中')
    expect(screen.getByText(/claim-7/)).toBeTruthy()

    const pairCall = calls.find((call) => call.url.endsWith('/pair'))
    expect(pairCall?.method).toBe('POST')
    expect(pairCall?.body).toEqual({ payload: 'cherry-pair-abc' })

    // The code exists ONLY as this SSE frame (controller ruling).
    expect(screen.queryByText('482915')).toBeNull()
    stream().emit({
      event: 'pairing-progress',
      data: { stage: 'verification-code', detail: '482915', claimId: 'claim-7' },
    })
    expect(await screen.findByText('482915')).toBeTruthy()

    // Terminal frame → the transient display goes away and the flow is done.
    stream().emit({ event: 'pairing-progress', data: { stage: 'approved', claimId: 'claim-7' } })
    // Waited on the SETTLED state, not the instant after emit: the app clears
    // the progress frame once the run ends, so an assertion that only held
    // before the next render would be testing timing, not behaviour.
    await screen.findByText('配对成功')
    await waitFor(() => {
      expect(screen.queryByText('482915')).toBeNull()
    })
    // The wizard is usable again for a second pairing run.
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '开始配对' }) as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('subscribes to the SSE stream before POSTing /pair', async () => {
    const { order } = await renderWithDevice([['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: 'claim-9' })]])

    // `order` records EVERY request, and the scope panel's own `GET /scope` read
    // is one of them (child effects flush before the app's, so it can even come
    // first). The claim below is about two events — the stream opening and the
    // pairing POST — so it is read off a view restricted to those two, derived
    // at each point of use (the POST has not happened yet at the first one).
    const pairingOf = (): string[] =>
      order.filter((entry) => entry === 'sse' || entry.includes('POST /cherry-remote/api/pair'))
    // The stream is already open from the first render.
    expect(pairingOf()[0]).toBe('sse')
    expect(stream().listeners.get('pairing-progress')?.size ?? 0).toBeGreaterThan(0)

    submitPayload()

    await screen.findByText('配对进行中')
    const pairIndex = pairingOf().findIndex((entry) => entry.includes('POST /cherry-remote/api/pair'))
    expect(pairIndex).toBeGreaterThan(0)
    // Subscribe-before-pair: the code frame is never replayed, so a POST that
    // beat the subscription would lose it forever.
    expect(pairingOf().indexOf('sse')).toBeLessThan(pairIndex)
  })

  it('keeps the code when the stream was open before the POST', async () => {
    // The end-to-end consequence of the ordering rule: with the subscription in
    // place, the very first `pairing-progress` frame reaches the wizard. (The
    // inverse — POSTing first — is asserted positionally in the ordering test.)
    await renderWithDevice([['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: 'claim-11' })]])
    expect(stream().listeners.get('pairing-progress')?.size ?? 0).toBeGreaterThan(0)

    submitPayload()
    await screen.findByText('配对进行中')

    // The code frame carries THIS run's claim id, which is what makes it
    // attributable — and a frame can only be attributed once `POST /pair` has
    // returned the id, so this is the earliest real point one can arrive.
    stream().emit({
      event: 'pairing-progress',
      data: { stage: 'verification-code', detail: '204816', claimId: 'claim-11' },
    })

    expect(await screen.findByText('204816')).toBeTruthy()
  })

  // Every post-202 failure verdict the server can publish (src/httpApi.ts
  // `pairingVerdict` → `PairingErrorKind`, plus the quarantined-archive stage).
  // These arrive as `pairing-progress` frames with `stage = verdict.error`, NOT
  // as an HTTP error — the 202 was already returned — so each one must settle
  // the wizard just like a terminal approval would. Missing any of them leaves
  // the run stuck in 'waiting' with the submit button permanently disabled.
  //
  // The copy each one must render is the STAGE_LABELS RECOVERY text, asserted in
  // full: a wizard that settles with `progress` already cleared would fall back
  // to '未知错误' in the settled frame, and a substring match on the verdict word
  // alone ('配对被拒绝') cannot tell that apart from the real guidance. These
  // stages therefore assert the recovery clause the user is supposed to act on.
  const postPairingFailures = [
    ['unreachable', '无法连接 Cherry Studio，请确认桌面端已启动且与本机同网'],
    ['invalid-payload', '配对信息无效或已过期，请在 Cherry Studio 重新生成后重试'],
    ['rejected', '配对被拒绝——请核对桌面端显示的 6 位验证码是否与本页一致，并在 Cherry Studio 重新生成配对码后重试'],
    ['expired', '配对邀请已过期——请在 Cherry Studio 重新生成配对码后重试'],
  ] as const

  for (const [stage, guidance] of postPairingFailures) {
    it(`settles the wizard on a post-202 ${stage} frame with its recovery guidance`, async () => {
      await renderWithDevice([['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: 'claim-fail' })]])

      submitPayload()
      await screen.findByText('配对进行中')
      expect((screen.getByRole('button', { name: '开始配对' }) as HTMLButtonElement).disabled).toBe(true)

      // The everyday failure: the desktop is offline, and the verdict only ever
      // arrives on the stream.
      stream().emit({
        event: 'pairing-progress',
        data: { stage, detail: 'peer is offline', claimId: 'claim-fail' },
      })

      // The SETTLED paragraph, not the frame immediately after the emit: the app
      // clears `progress` when the run ends, so the terminal render has no frame
      // left to label the verdict from. The content must therefore come from the
      // wizard's own captured verdict.
      const settled = await screen.findByText(`配对失败：${guidance}`)
      expect(settled.textContent).not.toContain('未知错误')
      expect(settled.textContent).not.toContain('undefined')

      await waitFor(() => {
        expect(screen.queryByText('配对进行中')).toBeNull()
      })
      // The wizard is usable again: the payload box and submit are re-enabled.
      await waitFor(() => {
        expect((screen.getByRole('button', { name: '开始配对' }) as HTMLButtonElement).disabled).toBe(false)
      })
      expect(screen.getByLabelText('配对信息')).toBeTruthy()
      // No raw stage string leaks into the UI.
      expect(screen.queryByText(stage)).toBeNull()

      // ...and the verdict SURVIVES the cleared frame: a later unrelated render
      // (the app re-reads /devices when the run settles) must not blank it out.
      await waitFor(() => {
        expect(screen.getByText(`配对失败：${guidance}`)).toBeTruthy()
      })
    })
  }

  it('keeps the settled verdict after a run that published progress frames first', async () => {
    // The multi-stage shape: a real run narrates validate → connect → claim →
    // verification-code before it fails. The terminal must still render ITS
    // stage's guidance once the frame is cleared — the wizard cannot rely on
    // whatever `progress` happened to hold, because the app drops it on settle.
    await renderWithDevice([['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: 'claim-multi' })]])

    submitPayload()
    await screen.findByText('配对进行中')

    for (const stage of ['validate', 'connect', 'claim'] as const) {
      stream().emit({ event: 'pairing-progress', data: { stage, claimId: 'claim-multi' } })
      await screen.findByText(STAGE_LABELS[stage]!)
    }
    stream().emit({
      event: 'pairing-progress',
      data: { stage: 'verification-code', detail: '482915', claimId: 'claim-multi' },
    })
    await screen.findByText('482915')

    stream().emit({ event: 'pairing-progress', data: { stage: 'expired', claimId: 'claim-multi' } })

    const settled = await screen.findByText(`配对失败：${STAGE_LABELS['expired']!}`)
    expect(settled.textContent).not.toContain('未知错误')
    // The transient code went away with the terminal frame, and the verdict did
    // NOT fall back to the last non-terminal stage's label.
    expect(screen.queryByText('482915')).toBeNull()
    expect(screen.queryByText(STAGE_LABELS['claim']!)).toBeNull()
  })

  it('IGNORES another run\'s frames: a foreign claimId cannot show its code or settle this wizard', async () => {
    // The stream is shared by every tab. A second tab pairing a different
    // desktop publishes its own code and verdict on the SAME channel, and a
    // wizard that trusted any frame would display a stranger's 6-digit code —
    // the one number the user is supposed to compare against their own desktop
    // — and then settle on the stranger's outcome.
    await renderWithDevice([['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: 'claim-mine' })]])

    submitPayload()
    await screen.findByText('配对进行中')

    // A foreign run's stages, code and terminal — all of them must be ignored.
    stream().emit({ event: 'pairing-progress', data: { stage: 'validate', claimId: 'claim-theirs' } })
    stream().emit({
      event: 'pairing-progress',
      data: { stage: 'verification-code', detail: '999999', claimId: 'claim-theirs' },
    })
    stream().emit({ event: 'pairing-progress', data: { stage: 'approved', claimId: 'claim-theirs' } })

    // ...and an UNATTRIBUTED frame is ignored too: this wizard only acts on
    // frames it can prove belong to its own run.
    stream().emit({ event: 'pairing-progress', data: { stage: 'rejected' } })

    // Still waiting, still showing nothing foreign.
    expect(screen.queryByText('999999')).toBeNull()
    expect(screen.queryByText('配对成功')).toBeNull()
    expect(screen.getByText('配对进行中')).toBeTruthy()

    // Its OWN code and terminal are honoured.
    stream().emit({
      event: 'pairing-progress',
      data: { stage: 'verification-code', detail: '135790', claimId: 'claim-mine' },
    })
    expect(await screen.findByText('135790')).toBeTruthy()
    stream().emit({ event: 'pairing-progress', data: { stage: 'approved', claimId: 'claim-mine' } })
    expect(await screen.findByText('配对成功')).toBeTruthy()
  })

  it('tells the user how to recover from an expired and a rejected pairing', async () => {
    // The two failure labels carry the RECOVERY step, not just the verdict: the
    // user is standing in front of two windows with nothing else to go on. Read
    // from the SETTLED paragraph, after the app has cleared the progress frame —
    // the point of the copy is that it is still there when the user looks.
    for (const [stage, advice] of [
      ['expired', /重新生成配对码后重试/],
      // The RECOVERY clause, not the bare '6 位验证码': the wizard's step list
      // mentions the code too, so the loose pattern is not a unique match.
      ['rejected', /核对桌面端显示的 6 位验证码是否与本页一致/],
    ] as const) {
      cleanup()
      await renderWithDevice([
        ['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: `claim-${stage}` })],
      ])
      submitPayload()
      await screen.findByText('配对进行中')

      stream().emit({ event: 'pairing-progress', data: { stage, claimId: `claim-${stage}` } })

      // Settled state reached, then re-read: the guidance must persist.
      await waitFor(() => {
        expect(screen.queryByText('配对进行中')).toBeNull()
      })
      // Scoped to the wizard panel: this loop renders the page repeatedly without
      // a full teardown, so a document-wide query could match a stale tree.
      const panel = screen.getByRole('region', { name: '配对向导' })
      const settled = within(panel).getByText(new RegExp(advice))
      expect(settled.textContent).toContain(STAGE_LABELS[stage]!)
      expect(settled.textContent).not.toContain('未知错误')
    }
  })

  it('surfaces a validation refusal without leaving the wizard', async () => {
    await renderWithDevice([
      [
        'POST',
        '/cherry-remote/api/pair',
        jsonResponse(400, { error: 'invalid-payload', message: 'payload does not decode as a pairing invitation' }),
      ],
    ])

    submitPayload('garbage')

    // `textContent` is read rather than matched in place: the panel renders two
    // `role="alert"` nodes (wizard + panel), so the wizard's own message is
    // asserted through its ancestor, not through a positional query.
    await waitFor(() => {
      const alerts = screen.getAllByRole('alert').map((node) => node.textContent ?? '')
      expect(alerts.some((text) => text.includes('invalid-payload'))).toBe(true)
    })
    expect(screen.getByLabelText('配对信息')).toBeTruthy()
    expect(screen.queryByText('配对进行中')).toBeNull()
  })

  it('①b a run no terminal frame reaches still hands the form back, without claiming failure', async () => {
    // The server publishes a terminal stage on every outcome, but the stream
    // carries NO replay: one dropped frame after the 202 and the verdict is gone
    // for good. `busy` is then never cleared (only a terminal frame or a refused
    // POST clears it) and the submit button stays disabled with no cancel
    // control — the page can only recover by a reload. The run deadline is the
    // exit for exactly that case.
    const harness = await renderWithDevice(
      [['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: 'claim-silent' })]],
      { runLifetimeMs: 80 },
    )

    submitPayload()
    stream().emit({
      event: 'pairing-progress',
      data: { stage: 'verification-code', detail: '246810', claimId: 'claim-silent' },
    })
    await screen.findByText('246810')

    // The run is in 'waiting': nothing but a terminal frame can settle it.
    expect((screen.getByRole('button', { name: '开始配对' }) as HTMLButtonElement).disabled).toBe(true)

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert').map((node) => node.textContent ?? '')
      expect(alerts.some((text) => text.includes('没有等到配对结果'))).toBe(true)
    })

    // The form works again, the in-flight narration is gone, and the transient
    // code went with it (a code left on screen beside a dead run invites
    // comparing a stale number, which is what its own lifetime rule prevents).
    expect((screen.getByRole('button', { name: '开始配对' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText('配对进行中')).toBeNull()
    expect(screen.queryByText('246810')).toBeNull()
    // NOT a verdict. The run may have been APPROVED while its frame was lost, so
    // the copy points at the device list instead of asserting a failure — a
    // "配对失败" here would be a lie the list right below it contradicts.
    expect(screen.queryByText(/配对失败/)).toBeNull()
    // …and "look below" must be TRUE, not merely said: settling re-reads the
    // list (mount + settle = two GETs), so an approved-but-silent run shows up.
    expect(harness.calls.filter((call) => call.url.endsWith('/devices'))).toHaveLength(2)
  })

  it('①c an idle wizard never raises the deadline alarm', async () => {
    // The deadline is armed by a RUN, never by the page. A zero lifetime makes
    // the difference observable without a sleep: were the timer armed at mount,
    // it would fire on the very next macrotask and an operator who has not
    // paired anything would be told "no result arrived".
    const harness = await renderWithDevice([], { runLifetimeMs: 0 })

    // `findByText` flushes a macrotask, so a mount-armed timer has fired by here.
    await screen.findByText('配对向导')
    const alerts = screen.queryAllByRole('alert').map((node) => node.textContent ?? '')
    expect(alerts.some((text) => text.includes('没有等到配对结果'))).toBe(false)
    expect((screen.getByRole('button', { name: '开始配对' }) as HTMLButtonElement).disabled).toBe(false)
    expect(harness.calls.filter((call) => call.url.endsWith('/devices'))).toHaveLength(1)
  })

  it('①d a terminal frame that arrives after the deadline replaces the alarm', async () => {
    // The deadline is a BACKSTOP, not a verdict: `POST /pair` is fire-and-forget
    // (`src/httpApi.ts`), so the run keeps going after the wizard stops waiting
    // and its frames still carry this run's claimId. A truth that arrives late
    // must win, or a slow-but-successful pairing would read as a timeout forever.
    await renderWithDevice([['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: 'claim-late' })]], {
      runLifetimeMs: 80,
    })

    submitPayload()
    await waitFor(() => {
      const alerts = screen.getAllByRole('alert').map((node) => node.textContent ?? '')
      expect(alerts.some((text) => text.includes('没有等到配对结果'))).toBe(true)
    })

    stream().emit({ event: 'pairing-progress', data: { stage: 'rejected', claimId: 'claim-late' } })

    const settled = await screen.findByText(/配对失败：/)
    expect(settled.textContent).toContain(STAGE_LABELS['rejected']!)
    expect(screen.queryByText(/没有等到配对结果/)).toBeNull()
  })

  it('①e a terminal frame that BEATS the /pair response still settles the run', async () => {
    // The mirror image of ①d, in a window nobody had pinned: the server writes
    // the 202 before it can publish a verdict, but the two travel on different
    // connections and the frame can reach the browser while this wizard still
    // holds NO claimId to match it against.
    //
    // It is not dropped. The app keeps the newest frame in `progress` (its own
    // state, never cleared on settle), and the stage effect lists `claimId` as a
    // dependency — so the handle committing is what re-runs the effect with the
    // frame already in hand. That dependency is the whole mechanism, and nothing
    // tested it: drop it and this case goes red.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await renderWithDevice([])
    // The parallel calls (devices, scope) are already answered; from here on the
    // ONLY request is the pairing POST, and it is held open on purpose.
    vi.stubGlobal('fetch', async () => {
      await gate
      return jsonResponse(202, { claimId: 'claim-early' })
    })

    submitPayload()
    // In flight and unidentifiable: the verdict is already here, the handle is not.
    stream().emit({
      event: 'pairing-progress',
      data: { stage: 'invalid-payload', claimId: 'claim-early' },
    })
    expect(screen.queryByText(/配对失败/)).toBeNull()

    release()

    const settled = await screen.findByText(/配对失败/)
    expect(settled.textContent).toContain(STAGE_LABELS['invalid-payload']!)
    // Settled for real — the form is back and no deadline alarm was needed.
    expect((screen.getByRole('button', { name: '开始配对' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText(/没有等到配对结果/)).toBeNull()
  })

  it('①f a /pair request that never answers becomes a sentence, not a marker', async () => {
    // The transport ceiling (`ui/src/api.ts`, issue #173) surfaces as an internal
    // marker, exactly like a missing EventSource does. This is the ONE failure the
    // run deadline cannot reach: the phase never leaves 'submitting', so nothing
    // arms — which is why the request itself has to be bounded.
    await renderWithDevice([])
    // Only the pairing POST is left to run: devices and scope were answered above.
    vi.stubGlobal('fetch', async () => {
      throw new Error(REQUEST_TIMEOUT)
    })

    submitPayload()

    const alert = await screen.findByText('配对请求迟迟没有回应，已中止——请重试；若反复出现，宿主可能已卡住，重启后再试')
    // The token must never reach a page: the user reads the dictionary, not the
    // string the transport happened to throw.
    expect(alert.textContent).not.toContain(REQUEST_TIMEOUT)
    expect((screen.getByRole('button', { name: '开始配对' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ② Device cards — five-state light + four actions
// ---------------------------------------------------------------------------

describe('device card status light', () => {
  const states = [
    ['connected', '已连接'],
    ['connecting', '连接中'],
    ['offline', '离线'],
    ['disabled', '已停用'],
    ['identity-mismatch', '身份不匹配'],
  ] as const

  for (const [state, label] of states) {
    it(`renders the ${state} state as a labelled light`, async () => {
      const harness = installFetch([
        ['GET', '/cherry-remote/api/devices', jsonResponse(200, [{ ...DEVICE, state, enabled: state !== 'disabled' }])],
      ])
      render(createElement(App, { eventSourceFactory: harness.eventSourceFactory }))
      stream().emit({ event: 'device-state', data: { deviceId: DEVICE.deviceId, state } })

      const light = await screen.findByRole('img', { name: label })
      expect(light.getAttribute('data-state')).toBe(state)
      // Every render path in this file must be answered for the scope panel's
      // own `/scope` read (one of the four DIRECT paths this line covers).
      expect(await screen.findByRole('radio', { name: '仅选定工作区' })).toBeTruthy()
    })
  }
})

describe('device card actions', () => {
  it('does NOT clobber an open editor when the record changes underneath it, and reseeds on close', async () => {
    // While an editor is OPEN the draft is sacred — even when focus sits
    // outside the card. Resyncing a live draft was the live-page rename bug:
    // a focus artifact mid-edit resynced the draft to the OLD name, and the
    // subsequent save silently PATCHed the pre-edit name. The server's values
    // return only when the editor CLOSES (the close itself re-runs the sync),
    // so a reopened editor is always seeded fresh.
    const { rerender } = render(
      createElement(DeviceCard, {
        device: { ...DEVICE, displayName: 'Old Name', hosts: ['10.0.0.1'], port: 1111 } as DeviceSummary,
        state: 'connected' as const,
        onSaved: () => {},
        onRemoved: () => {},
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    const box = screen.getByLabelText('设备名称') as HTMLInputElement
    expect(box.value).toBe('Old Name')
    // Focus sits OUTSIDE the card (never entered the box) — the draft still wins.
    fireEvent.change(box, { target: { value: 'half typed' } })
    fireEvent.blur(box)

    rerender(
      createElement(DeviceCard, {
        device: { ...DEVICE, displayName: 'New Name', hosts: ['10.0.0.9'], port: 2222 } as DeviceSummary,
        state: 'connected' as const,
        onSaved: () => {},
        onRemoved: () => {},
      }),
    )
    expect((screen.getByLabelText('设备名称') as HTMLInputElement).value).toBe('half typed')

    // Closing the editor re-runs the sync; the address editor then seeds the
    // SERVER's values, not the stale drafts.
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    fireEvent.click(screen.getByRole('button', { name: '地址维护' }))
    expect((screen.getByLabelText('主机地址') as HTMLInputElement).value).toBe('10.0.0.9')
    expect((screen.getByLabelText('端口') as HTMLInputElement).value).toBe('2222')
  })

  it('a save after a mid-edit refresh PATCHes the TYPED name, never the pre-edit one', async () => {
    // The live-incident regression: type a new name, let a background
    // refresh land (carrying the OLD record) while focus is anywhere, save —
    // the wire body must carry the typed draft. The old focus-consulting
    // resync wiped the draft on a focus artifact and saved the OLD name.
    const { rerender } = render(
      createElement(DeviceCard, {
        device: { ...DEVICE, displayName: 'Old Name' } as DeviceSummary,
        state: 'connected' as const,
        onSaved: () => {},
        onRemoved: () => {},
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    const box = screen.getByLabelText('设备名称') as HTMLInputElement
    box.focus()
    fireEvent.change(box, { target: { value: 'typed name' } })
    // The focus artifact: focus leaves the card entirely.
    fireEvent.blur(box)

    // The background refresh lands with the pre-edit record.
    rerender(
      createElement(DeviceCard, {
        device: { ...DEVICE, displayName: 'Old Name' } as DeviceSummary,
        state: 'connected' as const,
        onSaved: () => {},
        onRemoved: () => {},
      }),
    )

    const harness = installFetch([
      ['PATCH', '/cherry-remote/api/devices/dev-1', jsonResponse(200, { ...DEVICE, displayName: 'typed name' })],
    ])
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }))
    await waitFor(() => {
      expect(harness.calls.some((call) => call.method === 'PATCH')).toBe(true)
    })
    const patch = harness.calls.find((call) => call.method === 'PATCH')
    expect(patch?.body).toEqual({ displayName: 'typed name' })
  })

  it('disables an enabled device through PATCH enabled:false', async () => {
    const { calls } = await renderWithDevice([
      ['PATCH', '/cherry-remote/api/devices/dev-1', jsonResponse(200, { ...DEVICE, enabled: false, state: 'disabled' })],
    ])

    fireEvent.click(screen.getByRole('button', { name: '停用' }))

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PATCH')).toBe(true)
    })
    const patch = calls.find((call) => call.method === 'PATCH')
    expect(patch?.url).toBe('/cherry-remote/api/devices/dev-1')
    expect(patch?.body).toEqual({ enabled: false })
  })

  it('re-enables a disabled device through PATCH enabled:true', async () => {
    installFetch([
      ['GET', '/cherry-remote/api/devices', jsonResponse(200, [{ ...DEVICE, enabled: false, state: 'disabled' }])],
      ['PATCH', '/cherry-remote/api/devices/dev-1', jsonResponse(200, { ...DEVICE, enabled: true, state: 'connecting' })],
    ])
    render(createElement(App, { eventSourceFactory: harnessFactory() }))
    stream().emit({ event: 'device-state', data: { deviceId: DEVICE.deviceId, state: 'disabled' } })
    await screen.findByText(DEVICE.displayName)
    // Second DIRECT render path: the scope panel's read is answered here too.
    expect(await screen.findByRole('radio', { name: '仅选定工作区' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '启用' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '停用' })).toBeTruthy()
    })
  })

  it('renames through PATCH displayName', async () => {
    const { calls } = await renderWithDevice([
      ['PATCH', '/cherry-remote/api/devices/dev-1', jsonResponse(200, { ...DEVICE, displayName: '新名字' })],
    ])

    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    fireEvent.change(screen.getByLabelText('设备名称'), { target: { value: '新名字' } })
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }))

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PATCH' && call.body && 'displayName' in (call.body as object))).toBe(true)
    })
    const patch = calls.find((call) => call.method === 'PATCH')
    expect(patch?.body).toEqual({ displayName: '新名字' })
  })

  it('maintains the address through a whole-replace PATCH hosts + port', async () => {
    const { calls } = await renderWithDevice([
      ['PATCH', '/cherry-remote/api/devices/dev-1', jsonResponse(200, { ...DEVICE, hosts: ['10.0.0.5', '10.0.0.6'], port: 5555 })],
    ])

    fireEvent.click(screen.getByRole('button', { name: '地址维护' }))
    // A UNIFORM record still shows the read-only map inside the open form: it
    // is context for the one port field, not part of the mixed-port warning.
    const form = screen.getByLabelText('端口').closest('form') as HTMLElement
    expect(within(form).getByText('192.168.1.10:4343')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('主机地址'), { target: { value: '10.0.0.5, 10.0.0.6' } })
    fireEvent.change(screen.getByLabelText('端口'), { target: { value: '5555' } })
    fireEvent.click(screen.getByRole('button', { name: '保存地址' }))

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PATCH')).toBe(true)
    })
    const patch = calls.find((call) => call.method === 'PATCH')
    // hosts is WHOLE-REPLACE by contract: the list is sent, never a diff.
    expect(patch?.body).toEqual({ hosts: ['10.0.0.5', '10.0.0.6'], port: 5555 })
    expect(await screen.findByText('10.0.0.5, 10.0.0.6')).toBeTruthy()
  })

  it('removes through DELETE and drops the card', async () => {
    const { calls } = await renderWithDevice([
      ['DELETE', '/cherry-remote/api/devices/dev-1', new Response(null, { status: 204 })],
    ])

    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    // Removal is a two-step confirmation: the destructive call is behind it.
    fireEvent.click(screen.getByRole('button', { name: '确认移除' }))

    await waitFor(() => {
      const remove = calls.find((call) => call.method === 'DELETE')
      expect(remove?.url).toBe('/cherry-remote/api/devices/dev-1')
    })
    await waitFor(() => {
      expect(screen.queryByText(DEVICE.displayName)).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// ②b Per-host dial ports — READ-ONLY, and one port field still re-points every
// host when (and only when) its value CHANGES.
// ---------------------------------------------------------------------------

describe('device card per-host ports', () => {
  /**
   * The record whose hosts disagree: `a.local` keeps the record port and
   * `b.local` dials another one, which is exactly what the record-level `port`
   * alone cannot show an operator.
   */
  const mixed: DeviceSummary = {
    deviceId: 'dev-ports',
    displayName: '混合端口设备',
    state: 'offline',
    enabled: true,
    hosts: ['a.local', 'b.local'],
    port: 65001,
    ports: { 'a.local': 65001, 'b.local': 65002 },
  }

  const mixedHint = '部分候选地址的端口与上方的端口不同；在「地址维护」里改动端口会把所有候选地址改为同一端口。'

  /** The row label is the dictionary's, so a copy edit cannot leave ①b vacuous. */
  const portsLabel = dictionaries.zh['device.field.ports']!

  /**
   * Renders the page for ONE record, the same opening move as the status-light
   * tests above (which is why the assertion style is repeated rather than a new
   * harness invented): the PATCH answer echoes the record it was handed.
   */
  async function renderRecord(device: DeviceSummary): Promise<Harness> {
    const harness = installFetch([
      ['GET', '/cherry-remote/api/devices', jsonResponse(200, [device])],
      ['PATCH', `/cherry-remote/api/devices/${device.deviceId}`, jsonResponse(200, device)],
    ])
    render(createElement(App, { eventSourceFactory: harness.eventSourceFactory }))
    stream().emit({ event: 'device-state', data: { deviceId: device.deviceId, state: device.state } })
    await screen.findByText(device.displayName)
    return harness
  }

  it('①a shows every candidate address port and says the ports differ', async () => {
    await renderRecord(mixed)

    expect(screen.getByText(portsLabel)).toBeTruthy()
    expect(screen.getByText('a.local:65001, b.local:65002')).toBeTruthy()
    expect(screen.getByText(mixedHint)).toBeTruthy()
  })

  it('①b hides the per-address row and the hint when every host dials the record port', async () => {
    await renderRecord({ ...mixed, ports: { 'a.local': 65001, 'b.local': 65001 } })

    expect(screen.queryByText(portsLabel)).toBeNull()
    expect(screen.queryByText(mixedHint)).toBeNull()
  })

  it('①c falls back to the record port for a host the map does not carry', async () => {
    // A map missing one of the record's hosts is not a wire shape: the store's
    // `assertValidPorts` rejects it on read, so the only way this record can
    // exist in the page is `ui/src/api.ts`'s unvalidated `as DeviceSummary`
    // cast. The case pins the card's defensive fallback arm, not a stored v4
    // record (`GET /devices` always emits an entry for every host).
    await renderRecord({ ...mixed, ports: { 'a.local': 65002 } })

    expect(screen.getByText('a.local:65002, b.local:65001')).toBeTruthy()
  })

  it('①e still warns when the record port matches no listed host', async () => {
    // Reachable through the card itself: open 地址维护 on a mixed record,
    // delete the host that owned the record port, save. The one remaining host
    // dials its own port, so the single port row is now wrong for EVERY
    // address on the card — the shape a "the hosts disagree with each other"
    // predicate would let through silently.
    await renderRecord({ ...mixed, hosts: ['b.local'], ports: { 'b.local': 65002 } })

    expect(screen.getByText(portsLabel)).toBeTruthy()
    expect(screen.getByText('b.local:65002')).toBeTruthy()
    expect(screen.getByText(mixedHint)).toBeTruthy()
  })

  it('①f brackets an IPv6 candidate so its port stays readable', async () => {
    // Stored hosts are BARE IPv6 literals (`normalizeHost` strips the
    // brackets), so `fe80::1:65001` would read as one ambiguous address.
    await renderRecord({
      ...mixed,
      hosts: ['fe80::1', 'b.local'],
      ports: { 'fe80::1': 65001, 'b.local': 65002 },
    })

    expect(screen.getByText('[fe80::1]:65001, b.local:65002')).toBeTruthy()
  })

  it('①d shows the current map in the editor, and an unchanged port keeps the map', async () => {
    // The field is a re-point control, not a per-host editor: saving the value
    // the record already holds is the documented map no-op, so the PATCH body
    // still carries the address list plus that one port — never `ports`.
    const harness = await renderRecord(mixed)

    fireEvent.click(screen.getByRole('button', { name: '地址维护' }))
    const form = screen.getByLabelText('端口').closest('form')
    expect(form).not.toBeNull()
    expect(within(form as HTMLElement).getByText('当前端口映射：')).toBeTruthy()
    expect(within(form as HTMLElement).getByText('a.local:65001, b.local:65002')).toBeTruthy()
    expect(within(form as HTMLElement).getByText(/保持当前值/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '保存地址' }))

    await waitFor(() => {
      expect(harness.calls.some((call) => call.method === 'PATCH')).toBe(true)
    })
    const patch = harness.calls.find((call) => call.method === 'PATCH')
    expect(patch?.body).toEqual({ hosts: ['a.local', 'b.local'], port: 65001 })
  })
})

// ---------------------------------------------------------------------------
// ③ SSE state updates + first-frame render
// ---------------------------------------------------------------------------

describe('sse driven state', () => {
  it('updates an already-rendered card when a device-state frame arrives', async () => {
    await renderWithDevice()

    expect(screen.getByRole('img', { name: '离线' })).toBeTruthy()

    stream().emit({ event: 'device-state', data: { deviceId: DEVICE.deviceId, state: 'connected' } })

    const light = await screen.findByRole('img', { name: '已连接' })
    expect(light.getAttribute('data-state')).toBe('connected')
  })

  it('renders the full state from the first device-state frames, before any change', async () => {
    const harness = installFetch([
      ['GET', '/cherry-remote/api/devices', jsonResponse(200, [DEVICE, { ...DEVICE, deviceId: 'dev-2', displayName: '笔记本', state: 'connected' }])],
    ])
    render(createElement(App, { eventSourceFactory: harness.eventSourceFactory }))
    await screen.findByText(DEVICE.displayName)
    await screen.findByText('笔记本')
    // Third DIRECT render path: the scope panel's read is answered here too.
    expect(await screen.findByRole('radio', { name: '仅选定工作区' })).toBeTruthy()

    // Both cards exist but no state has been reported on the stream yet: the
    // FIRST-FRAME contract (one `device-state` per device on connect) is the
    // only source of the light, so nothing is claimed before it arrives.
    expect(screen.queryAllByRole('img')).toHaveLength(0)

    // The connect-time frames, no change involved.
    stream().emit({ event: 'device-state', data: { deviceId: 'dev-1', state: 'connecting' } })
    stream().emit({ event: 'device-state', data: { deviceId: 'dev-2', state: 'connected' } })

    const cardOne = screen.getByText(DEVICE.displayName).closest('[data-device-id]') as HTMLElement
    const cardTwo = screen.getByText('笔记本').closest('[data-device-id]') as HTMLElement
    await waitFor(() => {
      expect(within(cardOne).getByRole('img', { name: '连接中' })).toBeTruthy()
    })
    expect(within(cardTwo).getByRole('img', { name: '已连接' })).toBeTruthy()
  })

  it('hides the transient code once its lifetime elapses', async () => {
    // Real timers with a short lifetime: fake timers cannot drive RTL's async
    // `waitFor`, and the lifetime is already injectable (ruling 7).
    await renderWithDevice([['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: 'claim-lifetime' })]], {
      codeLifetimeMs: 80,
    })

    submitPayload()
    await screen.findByText('配对进行中')
    stream().emit({
      event: 'pairing-progress',
      data: { stage: 'verification-code', detail: '135790', claimId: 'claim-lifetime' },
    })
    await screen.findByText('135790')

    await waitFor(() => {
      expect(screen.queryByText('135790')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// Mount path: registration through the host's slots service
// ---------------------------------------------------------------------------

/** Records what the bundle registers, in the shape the reference pattern uses. */
class FakeSlots implements SlotsService {
  readonly injected: string[] = []
  readonly registrations: Array<{ options: SlotRegistration; component: ComponentType }> = []

  inject(slot: string, callback: () => void | (() => void)): void {
    this.injected.push(slot)
    // The real service defers the callback until the slot exists; calling it
    // synchronously is the immediate-availability case and still proves the
    // registration happens inside it.
    callback()
  }

  register(options: SlotRegistration, component: ComponentType): () => void {
    this.registrations.push({ options, component })
    return () => {}
  }
}

/**
 * The `ctx.get('locale')` half of a fake host context, answering `zh`.
 *
 * These cases assert CHINESE copy, and jsdom's `navigator.language` is `en-US`,
 * so a ctx with no locale service would make `apply` resolve the page to English
 * and the assertions would be testing the navigator fallback instead of the
 * host's answer. Spread into the ctx: `apply({ slots, ...zhLocaleService() })`.
 *
 * The service is stateless and answers `zh` for the life of the test; the
 * `subscribe` it hands out is never fired, because nothing here changes the
 * language.
 */
function zhLocaleService(): { get: (name: string) => unknown } {
  const service = {
    getLocale: () => ({ active: 'zh' }),
    subscribe: () => () => {},
  }
  return { get: (name: string) => (name === 'locale' ? service : undefined) }
}

describe('settings page registration', () => {
  it('declares the slots service dependency by module short name', () => {
    expect(inject).toEqual(['slots'])
  })

  it('registers the settings section through slots.inject, not a body mount', () => {
    const slots = new FakeSlots()
    const before = document.body.childElementCount
    const disposers: Array<() => void> = []

    apply({
      slots,
      effect: (callback: () => void | (() => void)) => {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      // A zh locale service. Without it `apply` would fall back to the
      // navigator (jsdom's `en-US`) and the Chinese assertions below would be
      // testing the fallback rather than the host's answer.
      ...zhLocaleService(),
    })

    // The registration is claimed inside the slot's inject callback, exactly as
    // the reference plugin does.
    expect(slots.injected).toEqual([SETTINGS_SLOT])
    expect(slots.registrations).toHaveLength(1)

    const registration = slots.registrations[0]
    expect(registration?.options.name).toBe(SETTINGS_SLOT)
    expect(registration?.options.id).toBe(SETTINGS_NAMESPACE)
    expect(typeof registration?.options.order).toBe('number')
    // The label is a callback so the shell can re-resolve it on a locale change.
    expect(registration?.options.label()).toBe('Cherry 互联')
    // Localization is NOT a second registration path: the host locale is read
    // through `ctx.get`, so no `locale` field may appear on the entry.
    expect(Object.keys(registration?.options ?? {})).not.toContain('locale')

    // No ad-hoc container: the shell owns where a settings section appears.
    expect(document.body.childElementCount).toBe(before)

    // Every teardown is safe to call, and the styles node goes away with them.
    expect(document.head.querySelectorAll('[data-cherry-remote-styles]').length).toBe(1)
    for (const dispose of disposers) expect(dispose).not.toThrow()
    expect(document.head.querySelectorAll('[data-cherry-remote-styles]').length).toBe(0)
  })

  it('renders the registered component as the settings page', async () => {
    const slots = new FakeSlots()
    installFetch([['GET', '/cherry-remote/api/devices', jsonResponse(200, [])]])

    apply({
      slots,
      effect: (callback: () => void | (() => void)) => void callback(),
      ...zhLocaleService(),
    })

    const Section = slots.registrations[0]?.component
    expect(Section).toBeTypeOf('function')
    render(createElement(Section as ComponentType))

    // The page the shell would show is this plugin's settings view.
    expect(screen.getByText('Cherry 互联')).toBeTruthy()
    expect(screen.getByLabelText('配对信息')).toBeTruthy()
    // Fourth DIRECT render path: the scope panel read its `/scope` answer through
    // the same harness (this is the component the shell renders, so it is the
    // path an operator actually arrives on).
    expect(await screen.findByRole('radio', { name: '仅选定工作区' })).toBeTruthy()
  })

  it('scopes every stylesheet rule to the plugin root, so no host UI is restyled', () => {
    // The stylesheet is injected into the HOST page's head, not a sandboxed
    // frame: a bare `button {}` rule would restyle every button in the shell.
    // Every selector in the shipped file must therefore be rooted at the
    // plugin's own class (or be a scoped descendant/pseudo of one).
    const css = readFileSync(join(process.cwd(), 'ui', 'src', 'styles.css'), 'utf8')
    // Strip comments so prose (which may contain braces or the word `button`)
    // is never mistaken for a selector.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
    // Selectors are everything before a `{`, minus at-rule preludes.
    const selectors = [...withoutComments.matchAll(/(^|[};])\s*([^{}@;]+?)\s*\{/g)].flatMap((match) =>
      match[2]!
        .split(',')
        .map((selector) => selector.trim())
        .filter((selector) => selector !== ''),
    )

    expect(selectors.length).toBeGreaterThan(20)
    for (const selector of selectors) {
      expect(
        selector.startsWith('.cherry-'),
        `stylesheet rule "${selector}" is not scoped to the plugin root and would leak into the host UI`,
      ).toBe(true)
    }
  })
})

/** The factory of the most recently installed fetch harness (single-render tests). */
function harnessFactory(): (url: string) => EventSourceLike {
  return (url: string): EventSourceLike => new FakeEventSource(url)
}

// ---------------------------------------------------------------------------
// ⑨ The `POST /pair` ceiling (`ui/src/api.ts`, issue #173)
// ---------------------------------------------------------------------------

/**
 * `POST /pair` is not a slow call: the server answers 202 as soon as it has a
 * claim id and does no I/O before that. A request still open is a wedged
 * same-origin transport — and it is the ONE failure the run deadline cannot
 * reach, because the phase never leaves 'submitting', so nothing arms.
 *
 * It lives in this file rather than its own because `tsconfig.json` and
 * `tsconfig.ui.json` PARTITION `tests/**` (`tests/unit/projectCoverage.test.ts`
 * enforces it), and a file importing `ui/src/**` belongs to the UI project.
 */
describe('the pairing request ceiling', () => {
  /** A fetch that never answers on its own but OBEYS the signal it is handed. */
  function hangingFetch(): { handler: typeof fetch; aborted: () => boolean } {
    let signal: AbortSignal | undefined
    const handler = ((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as unknown as typeof fetch
    return { handler, aborted: () => signal?.aborted === true }
  }

  it('⑨a a request that never answers becomes the timeout marker', async () => {
    const hang = hangingFetch()
    vi.stubGlobal('fetch', hang.handler)

    await expect(startPairing('payload', { timeoutMs: 10 })).rejects.toThrow(REQUEST_TIMEOUT)
    // The ceiling produced it, not a stray rejection.
    expect(hang.aborted()).toBe(true)
  })

  it('⑨b a refusal keeps its ApiError, and never becomes a timeout', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse(400, { error: 'invalid-payload', message: 'payload does not decode' }),
    )

    const cause = await startPairing('payload', { timeoutMs: 10 }).catch((error: unknown) => error)

    // The CODE is the contract (`api.ts`'s header): callers branch on
    // `invalid-payload` vs `unreachable`, so a refusal that arrived with the
    // signal still clear must keep both its type and its code.
    expect(cause).toBeInstanceOf(ApiError)
    expect((cause as ApiError).code).toBe('invalid-payload')
    expect((cause as Error).message).not.toContain(REQUEST_TIMEOUT)
  })

  it('⑨c the PRODUCTION ceiling fires with nothing injected', async () => {
    // Every other case passes `timeoutMs`, which leaves the default unwatched —
    // and the default is the invariant the issue is about. Mutate it to
    // `Infinity` and #173 ships unfixed; mutate it to 0 and every real pairing is
    // aborted on the spot. Both leave the rest of this file green, so this case
    // exists to see them.
    //
    // Fake timers make the default observable without waiting for it. The
    // two-step advance pins the ORDER OF MAGNITUDE, not the exact number: 1 ms
    // must not have fired (kills 0), a minute must have (kills `Infinity`).
    vi.useFakeTimers()
    try {
      const hang = hangingFetch()
      vi.stubGlobal('fetch', hang.handler)

      const settled = startPairing('payload').catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(1)
      expect(hang.aborted()).toBe(false)

      await vi.advanceTimersByTimeAsync(59_999)
      const cause = await settled
      expect((cause as Error).message).toBe(REQUEST_TIMEOUT)
      expect(hang.aborted()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('⑨d the ceiling is in request(), not on the pairing call', async () => {
    // Every call the page makes passes through `request()`, so a hang there
    // strands a control on every surface — the device list and the scope save as
    // well as the wizard (issue #180). This case is about the OTHER call sites:
    // it would go red if the ceiling were still bolted onto `startPairing` alone.
    vi.useFakeTimers()
    try {
      const hang = hangingFetch()
      vi.stubGlobal('fetch', hang.handler)

      const settled = listDevices().catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(60_000)

      const cause = await settled
      expect((cause as Error).message).toBe(REQUEST_TIMEOUT)
      expect(hang.aborted()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('⑨e the device list reports a timed-out read, and stops claiming to load', async () => {
    // The page-level sentence plus the state that follows it. Two surfaces time
    // out here — the device list and the scope panel's own read — so the query
    // names the app's sentence by its distinctive clause, and the list must have
    // left 「正在读取设备列表…」 behind (`listed` turns true on failure).
    vi.stubGlobal('fetch', async () => {
      throw new Error(REQUEST_TIMEOUT)
    })
    render(createElement(App, { eventSourceFactory: (url: string) => new FakeEventSource(url) }))

    const alert = await screen.findByText(/请确认宿主仍在运行/)
    expect(alert.textContent).not.toContain(REQUEST_TIMEOUT)
    expect(screen.queryByText('正在读取设备列表…')).toBeNull()
    // The empty state is what a failed read leaves: nothing is claimed about
    // devices, which is honest — the list is unknown, not empty.
    expect(screen.getByText(/暂无已配对设备/)).toBeTruthy()
  })
})
