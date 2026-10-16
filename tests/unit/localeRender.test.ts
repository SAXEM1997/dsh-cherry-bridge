// @vitest-environment jsdom
/**
 * Task 3 (cherry-locale) — the DEVICE-DOMAIN components' English rendering.
 *
 * Task 1 built the dictionary and Task 2 wired the host's locale service into
 * `localeStore`. Both left every component rendering Chinese LITERALS, which is
 * why `tests/unit/ui.test.ts` — ~140 assertions on that Chinese copy — stays
 * green either way. This file is the other side of that coin: it pins that the
 * components actually READ the translator, so a language switch reaches the
 * page. Without it, "localization" could be a dictionary nobody consults.
 *
 * ## What the criterion is, and what it is not
 *
 * The assertion is **"after switching to `en`, this component's OWN copy is
 * English"** — NOT "no CJK character survives anywhere in the tree". The two are
 * different, and the weaker-sounding one is the honest one: these components
 * render server data and third-party error text. A workspace name, a device
 * display name, an archive path, or a `Error.message` that arrives in Chinese
 * is DATA, and translating it (or refusing to render it) would be worse than
 * leaving it alone — it is exactly what `ui/src/i18n.ts`'s header calls the
 * "interpolated data is passed through untranslated" rule. Every fixture below
 * therefore supplies its server-side strings as ENGLISH MARKERS, so the only
 * Chinese that could remain is the component's own copy, which is what the
 * assertions name.
 *
 * ## The `wizard.failed` case is the file's sharpest assertion
 *
 * The settled-failure paragraph is where this task's ruling lives: the template
 * is `Pairing failed: {stage}` in English / `配对失败：{stage}` in Chinese, and
 * `{stage}` carries the ALREADY-TRANSLATED recovery sentence. The English
 * assertion below (`Pairing failed: ` + the recovery clause in English) fails
 * for every wrong shape — a raw stage enum, an untranslated label, or a
 * `?? 原值` passthrough — which is the point of pinning it here rather than
 * trusting the zh-only assertions in `ui.test.ts`.
 *
 * ## Fixtures
 *
 * The fetch stub and the fake `EventSource` are local copies of the shapes
 * `tests/unit/ui.test.ts` uses, per the brief's "no new test-only exports from
 * the components" rule: the seam under test is the PUBLIC one (a props-optional
 * `App`, `DeviceCard`, `PairingWizard` + the module-level `localeStore`), so no
 * source file has to grow a hook for this file to exist.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { dictionaries, localeStore } from '../../ui/src/i18n'
import { App } from '../../ui/src/App'
import { DeviceCard } from '../../ui/src/DeviceCard'
import { PairingWizard } from '../../ui/src/PairingWizard'
import type { DeviceSummary, EventSourceLike } from '../../ui/src/types'

const en = dictionaries.en
const zh = dictionaries.zh

/**
 * The components' copy is read through the DICTIONARY rather than retyped, so
 * these cases pin "the component renders what the translator says" — the seam
 * this task changes — instead of re-asserting Task 1's English wording. The one
 * exception is deliberate and named at its use site: `shows a QR code`, which
 * pins the RULED split-render shape of the hint paragraph.
 */
const tr = (key: string): string => en[key]!

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // The store is a module-level singleton: every case starts from the page's
  // historical default, through the PUBLIC store API only.
  localeStore.setLocale('zh')
})

/** One buffered `event:`/`data:` frame, as the server writes it. */
type Frame = { event: string; data: unknown }

/** The minimal controllable `EventSource`; jsdom ships none. */
class FakeEventSource implements EventSourceLike {
  static readonly instances: FakeEventSource[] = []

  readonly url: string
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

  close(): void {}

  emit(frame: Frame): void {
    for (const listener of this.listeners.get(frame.event) ?? []) {
      listener({ data: JSON.stringify(frame.data) })
    }
  }
}

/** The stream the app opened; it opens exactly one per mount. */
function stream(): FakeEventSource {
  const latest = FakeEventSource.instances.at(-1)
  if (latest === undefined) throw new Error('the app opened no /events stream')
  return latest
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * Answers the reads a full `App` mount makes: the device list, the scope
 * document, and the event stream. Bodies are ENGLISH MARKERS on purpose — they
 * are server data, and the assertions below must be able to tell that data
 * apart from the component's own copy.
 *
 * `POST /pair` is answered too: it is what a wizard run needs to reach
 * `phase === 'waiting'`. The `PairingWizard` cases below drive the terminal
 * transition through the REAL submit path rather than poking component state,
 * which is also what keeps the `claimId` filter honest — a frame is only
 * attributable to this wizard once `POST /pair` has returned the id.
 */
function installApp(devices: unknown[]): { eventSourceFactory: (url: string) => EventSourceLike } {
  const table: Array<[string, string, Response]> = [
    ['GET', '/cherry-remote/api/devices', jsonResponse(200, devices)],
    [
      'GET',
      '/cherry-remote/api/scope',
      jsonResponse(200, {
        scope: { mode: 'selected', workspaceIds: [], revision: 0 },
        workspaces: [],
        staleWorkspaceIds: [],
        pathUnmatched: [],
        // The host's own reason string: server prose, passed through
        // untranslated, and therefore an English marker rather than copy.
        host: { state: 'ready', capable: true, reason: 'host capability probe ok', degraded: [] },
      }),
    ],
    ['POST', '/cherry-remote/api/pair', jsonResponse(202, { claimId: PAIR_CLAIM_ID })],
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      for (const [responseMethod, responseUrl, response] of table) {
        if (responseMethod === method && url.endsWith(responseUrl)) return response
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    }),
  )
  return {
    eventSourceFactory: (url: string): EventSourceLike => {
      if (!url.endsWith('/cherry-remote/api/events')) {
        throw new Error(`unexpected event stream url: ${url}`)
      }
      return new FakeEventSource(url)
    },
  }
}

/** The `claimId` the stubbed `POST /pair` returns; frames must carry it. */
const PAIR_CLAIM_ID = 'claim-locale'

/** A device record whose every server-supplied string is an English marker. */
const DEVICE: DeviceSummary = {
  deviceId: 'dev-1',
  displayName: 'Workstation Alpha',
  state: 'offline',
  enabled: true,
  hosts: ['192.168.1.10'],
  port: 4343,
}

// ---------------------------------------------------------------------------
// ① App — the shell copy
// ---------------------------------------------------------------------------

describe('App renders its own copy in English', () => {
  it('translates the header and the paired-devices section for an English locale', async () => {
    const harness = installApp([DEVICE])
    localeStore.setLocale('en')
    render(createElement(App, { eventSourceFactory: harness.eventSourceFactory }))

    // The two static paragraphs of the shell. Both are the component's OWN copy,
    // so both must follow the locale.
    expect(await screen.findByText(tr('app.title'))).toBeTruthy()
    expect(screen.getByText(tr('app.subtitle'))).toBeTruthy()

    // The section heading, and the card that proves the list rendered.
    expect(await screen.findByText(tr('app.devices.heading'))).toBeTruthy()
    expect(await screen.findByText(DEVICE.displayName)).toBeTruthy()

    // The shell is not left in Chinese: the zh half of the same two keys is
    // gone. (Other zh copy may legitimately remain in Task 4's scope panel —
    // this assertion is scoped to the shell's own two strings.)
    expect(screen.queryByText(zh['app.title']!)).toBeNull()
    expect(screen.queryByText(zh['app.subtitle']!)).toBeNull()
    // `enabled: true` on the device means the action button is the DISABLE one.
    expect(screen.getByRole('button', { name: tr('device.disable') })).toBeTruthy()
  })

  it('renders the EventSource refusal through the dictionary instead of a literal', async () => {
    // App.tsx's one pre-existing English literal: with no `EventSource` in the
    // environment the stream opener throws, and the refusal reaches the error
    // line. Under an English locale it is the en dictionary's value; the point
    // of the case is that the string now comes from `t`, so the zh half EXISTS
    // (before this task the Chinese page showed English here).
    installApp([DEVICE])
    const original = (globalThis as { EventSource?: unknown }).EventSource
    delete (globalThis as { EventSource?: unknown }).EventSource
    try {
      localeStore.setLocale('zh')
      render(createElement(App, {}))
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe(zh['app.eventSourceUnavailable'])
      expect(alert.textContent).toBe('此环境不支持 EventSource')
    } finally {
      if (original !== undefined) {
        Object.defineProperty(globalThis, 'EventSource', { value: original, configurable: true })
      }
    }
  })
})

// ---------------------------------------------------------------------------
// ② DeviceCard — five states, four actions, three editors
// ---------------------------------------------------------------------------

describe('DeviceCard renders its own copy in English', () => {
  const renderCard = (state: DeviceSummary['state'] | undefined): void => {
    render(
      createElement(DeviceCard, {
        device: DEVICE,
        state,
        onSaved: () => {},
        onRemoved: () => {},
      }),
    )
  }

  it('translates the status light, the facts list and the four actions', () => {
    localeStore.setLocale('en')
    renderCard('connected')

    // The light's accessible name AND its visible label are one string.
    expect(screen.getByRole('img', { name: tr('device.state.connected') })).toBeTruthy()
    expect(screen.getByText(tr('device.state.connected'))).toBeTruthy()

    // The facts list: the LABELS are the card's own copy; the values are server
    // data and stay verbatim (the host list is joined by the data-plane
    // separator, which is deliberately not a dictionary entry).
    expect(screen.getAllByText(tr('device.field.addresses')).length).toBeGreaterThan(0)
    expect(screen.getByText(tr('device.field.port'))).toBeTruthy()
    expect(screen.getByText(tr('device.field.id'))).toBeTruthy()
    expect(screen.getByText('192.168.1.10')).toBeTruthy()
    expect(screen.getByText('4343')).toBeTruthy()
    expect(screen.getByText(DEVICE.deviceId)).toBeTruthy()

    // Four actions, each English. ("Addresses" is deliberately NOT asserted
    // through `getByText` here: the action button and the facts-list label share
    // the same English word, so the ROLE-scoped query below is the precise one.)
    expect(screen.getByRole('button', { name: tr('device.disable') })).toBeTruthy()
    expect(screen.getByRole('button', { name: tr('device.rename') })).toBeTruthy()
    expect(screen.getByRole('button', { name: tr('device.addresses') })).toBeTruthy()
    expect(screen.getByRole('button', { name: tr('device.remove') })).toBeTruthy()
  })

  it('renders the unknown-state light in English when the stream has not spoken', () => {
    localeStore.setLocale('en')
    renderCard(undefined)
    // The `unknown` light has its own vocabulary (it is not a `DeviceState`).
    expect(screen.getByText(tr('device.state.unknown'))).toBeTruthy()
  })

  it('translates the editor forms and their validation refusals', () => {
    localeStore.setLocale('en')
    renderCard('connected')

    // The address editor: two labels, the separator hint, and the submit button.
    fireEvent.click(screen.getByRole('button', { name: tr('device.addresses') }))
    expect(screen.getByLabelText(tr('device.field.hosts'))).toBeTruthy()
    expect(screen.getByLabelText(tr('device.field.port'))).toBeTruthy()
    expect(screen.getByText(tr('device.hosts.hint'))).toBeTruthy()
    expect(screen.getByRole('button', { name: tr('device.save.addresses') })).toBeTruthy()

    // A refusal is copy too: an empty host box must answer in English.
    fireEvent.change(screen.getByLabelText(tr('device.field.hosts')), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: tr('device.save.addresses') }))
    expect(screen.getByRole('alert').textContent).toBe(tr('device.error.hostsRequired'))
    expect(screen.getByRole('alert').textContent).not.toContain('至少')
  })

  it('translates the rename form and its empty-name refusal', () => {
    localeStore.setLocale('en')
    renderCard('connected')

    fireEvent.click(screen.getByRole('button', { name: tr('device.rename') }))
    // The input is SEEDED from the server record, so it shows the marker, while
    // its label is the card's own copy.
    expect((screen.getByLabelText(tr('device.field.name')) as HTMLInputElement).value).toBe(DEVICE.displayName)

    fireEvent.change(screen.getByLabelText(tr('device.field.name')), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: tr('device.save.name') }))
    expect(screen.getByRole('alert').textContent).toBe(tr('device.error.nameRequired'))
    // The device record is untouched, so the title still shows the server name.
    expect(screen.getByText(DEVICE.displayName)).toBeTruthy()
  })

  it('translates the two-step removal confirmation', () => {
    localeStore.setLocale('en')
    renderCard('connected')

    fireEvent.click(screen.getByRole('button', { name: tr('device.remove') }))
    expect(screen.getByText(tr('device.remove.warning'))).toBeTruthy()
    expect(screen.getByRole('button', { name: tr('device.remove.confirm') })).toBeTruthy()
    expect(screen.getByRole('button', { name: tr('device.cancel') })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// ③ PairingWizard — hint seam, steps, in-flight narration, settled verdict
// ---------------------------------------------------------------------------

/**
 * Drives the wizard through a REAL submit so `phase` reaches 'waiting'.
 *
 * The wizard does NOT open the event stream — `App` owns it — so only
 * `POST /pair` needs stubbing. The stub answers with `PAIR_CLAIM_ID`, and each
 * case then hands the SAME view a `progress` frame carrying that id, which is
 * what makes the frame attributable to this run: the component's own claim
 * filter is exercised, not bypassed. Labels are read through `tr()` because
 * every caller flips the store to `en` first.
 */
async function submitRun(): Promise<ReturnType<typeof render>> {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(202, { claimId: PAIR_CLAIM_ID })))
  const view = render(createElement(PairingWizard, { subscribed: true, progress: undefined }))
  fireEvent.change(screen.getByLabelText(tr('wizard.payload.label')), { target: { value: 'cherry-pair-locale' } })
  fireEvent.click(screen.getByRole('button', { name: tr('wizard.submit') }))
  await screen.findByText(tr('wizard.running'))
  return view
}

describe('PairingWizard renders its own copy in English', () => {
  it('renders the ruled hint seam with exactly one space before the emphasis', () => {
    localeStore.setLocale('en')
    const { container } = render(createElement(PairingWizard, { subscribed: true, progress: undefined }))

    // THE RULED SHAPE, pinned executably: `before` + ONE JSX space + the
    // `<strong>` emphasis + `after` flush against it. Asserted on
    // `textContent`, which is what the user reads and what a dropped or doubled
    // JSX space would change.
    const hint = container.querySelector('p.cherry-hint')
    expect(hint).not.toBeNull()
    expect(hint?.textContent).toContain('shows a QR code')
    expect(hint?.textContent).toContain(`${tr('wizard.hint.before')} ${tr('wizard.hint.qrCode')}`)
    expect(hint?.textContent).toBe(`${tr('wizard.hint.before')} ${tr('wizard.hint.qrCode')}${tr('wizard.hint.after')}`)
    // The emphasized words really are the `<strong>` element's, not loose text.
    expect(hint?.querySelector('strong')?.textContent).toBe(tr('wizard.hint.qrCode'))
    // ...and the seam is ONE space, not a doubled one.
    expect(hint?.textContent).not.toContain(`${tr('wizard.hint.qrCode')}  `)
    expect(hint?.textContent).not.toContain(`  ${tr('wizard.hint.qrCode')}`)
  })

  it('translates the heading, the three steps, the form and the pending notice', () => {
    localeStore.setLocale('en')
    render(createElement(PairingWizard, { subscribed: false, progress: undefined }))

    expect(screen.getByText(tr('wizard.heading'))).toBeTruthy()
    for (const key of ['wizard.step.open', 'wizard.step.scan', 'wizard.step.paste']) {
      expect(screen.getByText(tr(key)), key).toBeTruthy()
    }
    expect(screen.getByLabelText(tr('wizard.payload.label'))).toBeTruthy()
    expect(screen.getByPlaceholderText(tr('wizard.payload.placeholder'))).toBeTruthy()
    // Not yet subscribed: the submit button is disabled and the wizard says why.
    expect((screen.getByRole('button', { name: tr('wizard.submit') }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(tr('wizard.streamPending'))).toBeTruthy()
  })

  it('translates the empty-payload refusal', () => {
    localeStore.setLocale('en')
    render(createElement(PairingWizard, { subscribed: true, progress: undefined }))

    fireEvent.click(screen.getByRole('button', { name: tr('wizard.submit') }))
    expect(screen.getByRole('alert').textContent).toBe(tr('wizard.error.payloadRequired'))
    expect(screen.getByRole('alert').textContent).not.toContain('请先粘贴')
  })

  it('translates the in-flight narration and a known stage label', async () => {
    localeStore.setLocale('en')
    const view = await submitRun()

    // Before any frame: the run has been submitted but the stream is quiet.
    expect(screen.getByText(tr('wizard.running'))).toBeTruthy()
    expect(screen.getByText(tr('wizard.submitted'))).toBeTruthy()
    // `claim {id}` is a technical token, not copy, and stays verbatim.
    expect(screen.getByText(`claim ${PAIR_CLAIM_ID}`)).toBeTruthy()

    // A non-terminal stage narrates through the same `STAGE_KEYS` lookup the
    // enum-transparent `?? stage` fallback guards.
    view.rerender(createElement(PairingWizard, { subscribed: true, progress: { stage: 'claim' } }))
    expect(screen.getByText(tr('wizard.stage.claim'))).toBeTruthy()
    expect(screen.queryByText(tr('wizard.submitted'))).toBeNull()
  })

  it('translates the settled failure with the recovery sentence, never a raw stage', async () => {
    localeStore.setLocale('en')
    const view = await submitRun()
    // The claim-scoped terminal frame: same `claimId`, so the wizard attributes
    // it to its own run and captures the verdict.
    view.rerender(
      createElement(PairingWizard, { subscribed: true, progress: { stage: 'expired', claimId: PAIR_CLAIM_ID } }),
    )

    // THE `wizard.failed` CONTRACT: the English template, with `{stage}` filled
    // by the TRANSLATED recovery sentence — not the enum, not the zh label.
    const settled = screen.getByText(`Pairing failed: ${en['wizard.stage.expired']!}`)
    expect(settled.textContent).toBe(`${tr('wizard.failed').replace('{stage}', tr('wizard.stage.expired'))}`)
    // A raw stage token never reaches the user AS AN ENUM. Asserted as an exact
    // whole-string comparison rather than a substring ban, because the English
    // recovery sentence legitimately CONTAINS the word "expired" — a substring
    // test would fail on correct copy. `wizard.failed` + the bare enum is
    // precisely what a `?? 原值` passthrough would have produced.
    expect(settled.textContent).not.toBe('Pairing failed: expired')
    expect(settled.textContent).not.toContain('{stage}')
    // ...and neither does the UNKNOWN-verdict copy, which is the other half of
    // the ruling (a known verdict must not fall back).
    expect(settled.textContent).not.toContain('未知错误')
    expect(settled.textContent).not.toContain(en['wizard.unknownError']!)
  })

  it('translates the success paragraph', async () => {
    localeStore.setLocale('en')
    const view = await submitRun()
    view.rerender(
      createElement(PairingWizard, { subscribed: true, progress: { stage: 'approved', claimId: PAIR_CLAIM_ID } }),
    )
    expect(screen.getByText(tr('wizard.succeeded'))).toBeTruthy()
    // The success path is not a failure: no verdict paragraph at all.
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
