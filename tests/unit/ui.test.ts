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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import type { ComponentProps, ComponentType } from 'react'
import type { EventSourceLike } from '../../ui/src/types'
import { App } from '../../ui/src/App'
import { inject, apply, SETTINGS_NAMESPACE, SETTINGS_SLOT } from '../../ui/src/main'
import type { SlotRegistration, SlotsService } from '../../ui/src/main'

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

function installFetch(responses: Array<[string, string, Response]>): Harness {
  const calls: FetchCall[] = []
  const order: string[] = []
  let counter = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const raw = init?.body
    calls.push({ url, method, body: raw === undefined ? undefined : JSON.parse(String(raw)), at: counter++ })
    order.push(`fetch ${method} ${url}`)
    for (const [responseMethod, responseUrl, response] of responses) {
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
}

type AppProps = ComponentProps<typeof App>

/**
 * Renders the settings page, pushes the initial `device-state` frame, and waits
 * for the card to appear — the shared opening move of every card test.
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
  fireEvent.change(screen.getByLabelText('配对 payload'), { target: { value: payload } })
  fireEvent.click(screen.getByRole('button', { name: '开始配对' }))
}

// ---------------------------------------------------------------------------
// ① Pairing wizard
// ---------------------------------------------------------------------------

describe('pairing wizard', () => {
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
    stream().emit({ event: 'pairing-progress', data: { stage: 'verification-code', detail: '482915' } })
    expect(await screen.findByText('482915')).toBeTruthy()

    // Terminal frame → the transient display goes away and the flow is done.
    stream().emit({ event: 'pairing-progress', data: { stage: 'approved' } })
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

    // The stream is already open from the first render.
    expect(order[0]).toBe('sse')
    expect(stream().listeners.get('pairing-progress')?.size ?? 0).toBeGreaterThan(0)

    submitPayload()

    await screen.findByText('配对进行中')
    const pairIndex = order.findIndex((entry) => entry.includes('POST /cherry-remote/api/pair'))
    expect(pairIndex).toBeGreaterThan(0)
    // Subscribe-before-pair: the code frame is never replayed, so a POST that
    // beat the subscription would lose it forever.
    expect(order.indexOf('sse')).toBeLessThan(pairIndex)
  })

  it('keeps the code when the stream was open before the POST', async () => {
    // The end-to-end consequence of the ordering rule: with the subscription in
    // place, the very first `pairing-progress` frame reaches the wizard. (The
    // inverse — POSTing first — is asserted positionally in the ordering test.)
    await renderWithDevice([['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: 'claim-11' })]])

    // The stream subscribes before the POST, so this frame is not replayed away.
    stream().emit({ event: 'pairing-progress', data: { stage: 'verification-code', detail: '204816' } })
    submitPayload()

    expect(await screen.findByText('204816')).toBeTruthy()
  })

  // Every post-202 failure verdict the server can publish (src/httpApi.ts
  // `pairingVerdict` → `PairingErrorKind`). These arrive as `pairing-progress`
  // frames with `stage = verdict.error`, NOT as an HTTP error — the 202 was
  // already returned — so each one must settle the wizard just like a terminal
  // approval would. Missing any of them leaves the run stuck in 'waiting' with
  // the submit button permanently disabled.
  const postPairingFailures = [
    ['unreachable', '无法连接 Cherry Studio'],
    ['invalid-payload', '配对信息无效'],
    ['rejected', '配对被拒绝'],
    ['expired', '配对邀请已过期'],
  ] as const

  for (const [stage, label] of postPairingFailures) {
    it(`settles the wizard on a post-202 ${stage} frame`, async () => {
      await renderWithDevice([['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: 'claim-fail' })]])

      submitPayload()
      await screen.findByText('配对进行中')
      expect((screen.getByRole('button', { name: '开始配对' }) as HTMLButtonElement).disabled).toBe(true)

      // The everyday failure: the desktop is offline, and the verdict only ever
      // arrives on the stream.
      stream().emit({ event: 'pairing-progress', data: { stage, detail: 'peer is offline' } })

      // The run ends, in user-facing copy rather than a raw stage string.
      const settled = await screen.findByText(new RegExp(label))
      expect(settled.textContent).not.toContain(stage === 'rejected' ? 'pairing-progress' : 'undefined')

      await waitFor(() => {
        expect(screen.queryByText('配对进行中')).toBeNull()
      })
      // The wizard is usable again: the payload box and submit are re-enabled.
      await waitFor(() => {
        expect((screen.getByRole('button', { name: '开始配对' }) as HTMLButtonElement).disabled).toBe(false)
      })
      expect(screen.getByLabelText('配对 payload')).toBeTruthy()
      // No raw stage string leaks into the UI.
      expect(screen.queryByText(stage)).toBeNull()
    })
  }

  it('surfaces a validation refusal without leaving the wizard', async () => {    await renderWithDevice([
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
    expect(screen.getByLabelText('配对 payload')).toBeTruthy()
    expect(screen.queryByText('配对进行中')).toBeNull()
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
    })
  }
})

describe('device card actions', () => {
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
    await renderWithDevice([['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: 'claim-3' })]], {
      codeLifetimeMs: 80,
    })

    submitPayload()
    await screen.findByText('配对进行中')
    stream().emit({ event: 'pairing-progress', data: { stage: 'verification-code', detail: '135790' } })
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
    expect(registration?.options.label()).toBe('Cherry Studio 互联')

    // No ad-hoc container: the shell owns where a settings section appears.
    expect(document.body.childElementCount).toBe(before)

    // Every teardown is safe to call, and the styles node goes away with them.
    expect(document.head.querySelectorAll('[data-cherry-remote-styles]').length).toBe(1)
    for (const dispose of disposers) expect(dispose).not.toThrow()
    expect(document.head.querySelectorAll('[data-cherry-remote-styles]').length).toBe(0)
  })

  it('renders the registered component as the settings page', () => {
    const slots = new FakeSlots()
    installFetch([['GET', '/cherry-remote/api/devices', jsonResponse(200, [])]])

    apply({ slots, effect: (callback: () => void | (() => void)) => void callback() })

    const Section = slots.registrations[0]?.component
    expect(Section).toBeTypeOf('function')
    render(createElement(Section as ComponentType))

    // The page the shell would show is this plugin's settings view.
    expect(screen.getByText('Cherry Studio 互联')).toBeTruthy()
    expect(screen.getByLabelText('配对 payload')).toBeTruthy()
  })
})

/** The factory of the most recently installed fetch harness (single-render tests). */
function harnessFactory(): (url: string) => EventSourceLike {
  return (url: string): EventSourceLike => new FakeEventSource(url)
}
