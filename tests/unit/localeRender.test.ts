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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { dictionaries, localeStore } from '../../ui/src/i18n'
import { App } from '../../ui/src/App'
import { DeviceCard } from '../../ui/src/DeviceCard'
import { PairingWizard } from '../../ui/src/PairingWizard'
import { ToolScopePanel } from '../../ui/src/ToolScopePanel'
import { ApiError } from '../../ui/src/api'
import type { DeviceSummary, EventSourceLike, ScopeClient, ScopeResponse } from '../../ui/src/types'

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
  ports: { '192.168.1.10': 4343 },
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

  it('renders the ruled zh hint seam with the adjudicated inter-word space', () => {
    // The zh half of the same seam. It is the branch's ONLY Chinese DOM delta,
    // which is precisely why it can rot invisibly: the ~140 zh assertions in
    // `ui.test.ts` predate the split, and the English cases above cannot see a
    // dropped space in the Chinese sentence. Pinned literally — not through a
    // dictionary lookup — because the SHAPE is what was adjudicated: exactly one
    // space before `二维码` (the inter-word space the ruling kept) and the
    // JSX-collapsed space after `。` coming from `hint.after`'s own leading
    // space. Asserting via `zh[...]` would re-derive the string and let a
    // changed dictionary pass.
    localeStore.setLocale('zh')
    const { container } = render(createElement(PairingWizard, { subscribed: true, progress: undefined }))

    const hint = container.querySelector('p.cherry-hint')
    expect(hint).not.toBeNull()
    expect(hint?.textContent).toContain('显示的是 二维码。 请用微信')
    // The emphasis is the `<strong>` element's own text, and the seam around it
    // is exactly one space on each side of the ruled pair.
    expect(hint?.querySelector('strong')?.textContent).toBe('二维码')
    expect(hint?.textContent).toBe(
      `${zh['wizard.hint.before']} ${zh['wizard.hint.qrCode']}${zh['wizard.hint.after']}`,
    )
    expect(hint?.textContent).not.toContain('二维码  ')
    expect(hint?.textContent).not.toContain('  二维码')
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

// ---------------------------------------------------------------------------
// ④ ToolScopePanel — notices, the two key tables, and the merged templates
// ---------------------------------------------------------------------------

/**
 * The panel's scope document, with every server-supplied string an ENGLISH
 * MARKER: the host's `reason`, the workspace titles/paths, the degraded notes'
 * `reason`s and an `Error.message` are DATA — passed through untranslated — so
 * supplying them in English is what lets the assertions below isolate the
 * panel's OWN copy as the only thing that could still be Chinese.
 */
const SCOPE_REASON = 'host capability probe: workspaceRegistry reachable'
const WS_EN_A = { id: 'ws-1', title: 'Project Alpha', path: '/srv/alpha' }
const WS_EN_B = { id: 'ws-2', title: 'Project Beta', path: '/srv/beta' }

function scopeSnapshot(over: Partial<ScopeResponse> = {}): ScopeResponse {
  return {
    scope: { mode: 'selected', workspaceIds: ['ws-1'], revision: 7 },
    workspaces: [WS_EN_A, WS_EN_B],
    staleWorkspaceIds: [],
    pathUnmatched: [],
    host: { state: 'ready', capable: true, reason: SCOPE_REASON, degraded: [] },
    ...over,
  }
}

/**
 * A `ScopeClient` that answers `get()` with `served` and `put()` with `outcome`.
 *
 * The outcome is discriminated by SHAPE, because the panel's two arms are
 * exactly that: an `Error` (an `ApiError` refusal, or a transport failure) is
 * REJECTED, while a `{scope, pruned}` commit is RESOLVED. Leaving it out means
 * "succeed with the served document and prune nothing".
 */
function scopeClient(served: ScopeResponse, outcome?: unknown): ScopeClient {
  return {
    get: () => Promise.resolve(served),
    put: () => {
      if (outcome === undefined) return Promise.resolve({ scope: served.scope, pruned: [] })
      if (outcome instanceof Error) return Promise.reject(outcome)
      return Promise.resolve(outcome as { scope: ScopeResponse['scope']; pruned: string[] })
    },
  }
}

describe('ToolScopePanel renders its own copy in English', () => {
  const renderPanel = (client: ScopeClient): ReturnType<typeof render> =>
    render(createElement(ToolScopePanel, { client }))

  it('translates the chrome: heading, mode pair, effect note, save and revision line', async () => {
    localeStore.setLocale('en')
    renderPanel(scopeClient(scopeSnapshot()))

    expect(await screen.findByText(tr('scope.heading'))).toBeTruthy()
    // The `revision` line only exists once the read has landed, so awaiting it
    // here is what makes the assertions below about the LOADED render.
    await screen.findByText(tr('scope.revision').replace('{revision}', '7'))
    expect(screen.getByText(tr('scope.mode.legend'))).toBeTruthy()
    expect(screen.getByRole('radio', { name: tr('scope.mode.global') })).toBeTruthy()
    expect(screen.getByRole('radio', { name: tr('scope.mode.selected') })).toBeTruthy()
    expect(screen.getByText(tr('scope.effectNote'))).toBeTruthy()
    expect(screen.getByRole('button', { name: tr('scope.save') })).toBeTruthy()

    // `scope.revision` is a WHOLE-SENTENCE template: the number is a param, not a
    // JSX-adjacent literal. Asserted as one node's exact text so a half-sentence
    // plus a `{revision}` interpolation would fail.
    const revision = document.querySelector('[data-scope-revision]')
    expect(revision?.textContent).toBe(tr('scope.revision').replace('{revision}', '7'))

    // The server's own reason is DATA and never translated: the marker survives.
    // (Nothing renders it while the host is `ready`, so it is asserted absent.)
    expect(screen.queryByText(SCOPE_REASON)).toBeNull()
  })

  it('renders the whole-sentence empty state and the degraded line with BOTH params filled', async () => {
    localeStore.setLocale('en')
    renderPanel(
      scopeClient(
        scopeSnapshot({
          scope: { mode: 'selected', workspaceIds: [], revision: 2 },
          host: {
            state: 'ready',
            capable: true,
            reason: SCOPE_REASON,
            degraded: [{ source: 'path-normalization', reason: 'realpath lookup failed on /srv/alpha' }],
          },
        }),
      ),
    )

    // The panel's read is a resolved promise: wait for the load to land before
    // querying, or every assertion below reads a pre-seed render.
    await screen.findByText(tr('scope.effectNote'))

    // D11's `selected` sentence: one key, no assembly.
    const empty = document.querySelector('[data-scope-empty]')
    expect(empty?.textContent).toBe(tr('scope.empty.selected'))

    // THE DEGRADED LINE is the merge this case exists to pin: `scope.degradedLine`
    // is ONE template carrying the TRANSLATED source label AND the server's own
    // untranslated reason. A split `<strong>{label}</strong><span>：{reason}</span>`
    // shape would still render here, so the assertion is on the WHOLE line — and
    // on the en label + en template rather than their zh halves.
    const install = document.querySelector('[data-degraded-source="path-normalization"]')
    expect(install?.textContent).toBe(
      tr('scope.degradedLine')
        .replace('{label}', tr('scope.degraded.path-normalization'))
        .replace('{reason}', 'realpath lookup failed on /srv/alpha'),
    )
    // Not the zh label, and not a zh separator: the line is genuinely translated.
    expect(install?.textContent).not.toContain(zh['scope.degraded.path-normalization']!)
    expect(install?.textContent).not.toContain('：')
  })

  it('translates a KNOWN save refusal through the key table, and the server detail line', async () => {
    localeStore.setLocale('en')
    renderPanel(
      scopeClient(scopeSnapshot(), new ApiError(409, 'scope-revision-conflict', 'the document moved on')),
    )

    await screen.findByText(tr('scope.revision').replace('{revision}', '7'))
    fireEvent.click(screen.getByRole('button', { name: tr('scope.save') }))

    // `scope.saveFailure.scope-revision-conflict` — the table lookup, not a literal.
    //
    // EXACT equality on the alert node, for the same reason as the unknown-code
    // case below: `findByText` matches a normalised SUBSTRING, so a superset
    // like `Save failed: <message>` satisfies a `findByText` expectation of this
    // sentence's own prefix. Pinning `textContent` makes the table lookup's WHOLE
    // sentence — the code's own copy, with no glue — the assertion.
    //
    // This arm is ALSO the one that catches the glue mutation applied to the
    // SHARED `?? SAVE_FAILED_KEY` fallback, which is worth recording because it
    // is not obvious: for the unknown-code arm that mutation is textually
    // INVISIBLE (see the note below), so before this assertion existed nothing
    // caught it — the reviewer's finding, reproduced. The known code reaches the
    // same fallback expression, so a glue splice corrupts this sentence into a
    // CONCATENATION and is caught here.
    const failure = await screen.findByRole('alert')
    const conflictCopy = tr('scope.saveFailure.scope-revision-conflict')
    expect(failure.textContent).toBe(conflictCopy)
    expect(failure.textContent).not.toContain(zh['scope.saveFailure.scope-revision-conflict']!)
    // The conflict's own recovery control, in English.
    expect(screen.getByRole('button', { name: tr('scope.reread') })).toBeTruthy()

    // `scope.serverSaid` is the OTHER merged template: `{code}` and `{status}`
    // both interpolated into one sentence, not "The server answered " + a code.
    // Asserted on the DETAIL NODE's exact text — `body.textContent` containment
    // would pass for the split shape `'The server answered ' + code`, which is
    // the assembly this key exists to forbid.
    //
    // Scoped by `[data-scope-save-error]` rather than by a class selector: the
    // revision line wears the SAME `cherry-hint cherry-mono` pair, so
    // `.cherry-scope-save .cherry-hint.cherry-mono` silently resolves to the
    // revision paragraph — which is why the original containment form, whose
    // only structural check was `detail !== null`, could never have pinned this
    // sentence at all.
    const detail = document.querySelector('[data-scope-save-error] .cherry-hint.cherry-mono')
    expect(detail?.textContent).toBe(
      tr('scope.serverSaid').replace('{code}', 'scope-revision-conflict').replace('{status}', '409'),
    )
    // No placeholder survives unfilled in EITHER merged template. `body` is the
    // right scope here: if a param were dropped the literal `{code}`/`{status}`
    // would stand wherever the template rendered.
    expect(document.body.textContent).not.toContain('{code}')
    expect(document.body.textContent).not.toContain('{status}')
    expect(document.body.textContent).not.toContain('{cause}')
  })

  it('translates the UNKNOWN refusal into the whole `scope.saveFailed` sentence with {cause} filled', async () => {
    localeStore.setLocale('en')

    // BOTH ways of "no entry in `SAVE_FAILURE_KEYS`" reach the same template, and
    // both are exercised because they are different code paths: a plain `Error`
    // (no `ApiError` at all ⇒ `code === undefined`) and an `ApiError` carrying a
    // code this build does not know (⇒ the `?? SAVE_FAILED_KEY` arm). Asserting
    // only the first would leave the second — the one a NEWER SERVER produces —
    // free to regress into a half-sentence.
    for (const cause of [
      new Error('socket closed before the scope write landed'),
      new ApiError(503, 'some-future-refusal', 'the server learned a new code'),
    ]) {
      cleanup()
      localeStore.setLocale('en')
      renderPanel(scopeClient(scopeSnapshot(), cause))

      await screen.findByText(tr('scope.revision').replace('{revision}', '7'))
      fireEvent.click(screen.getByRole('button', { name: tr('scope.save') }))

      // The fallback arm: a code the table has no copy for lands on the ONE
      // `scope.saveFailed` template with the message interpolated.
      //
      // THE SHAPE IS PINNED BY EXACT EQUALITY, not by `findByText`. Testing
      // Library's text matcher is a normalised SUBSTRING match, so
      // `findByText(tr(...).replace('{cause}', message))` accepts any SUPERSET —
      // `Save failed: ` is a substring of `Save failed: <message>`. `i18nAssets`
      // only guarantees "no Chinese", not whole-sentence form, so this assertion
      // is the only guard on the shape.
      //
      // HONEST LIMIT, measured rather than assumed: for THIS arm the glue splice
      // `` `${t(KEY).replace('{cause}','')}${describeCause(cause)}` `` is
      // textually INDISTINGUISHABLE from the template, in both locales. The
      // en template's `Save failed: {cause}` and `ApiError.message`'s own
      // `"<code>: <message>"` (api.ts:32) put the SAME `": "` in front of the
      // cause, and in zh the splice leaves the template's `：` behind, which the
      // correct render also has. So the unknown arm alone cannot bite that
      // mutation; the KNOWN arm's exact-equality assertion is what does, because
      // it reaches the same shared fallback and lacks the coincidence. Together
      // the two arms cover it. What this arm DOES bite is the dropped-param
      // shape (`{cause}` left literal) and any glue that changes the sentence.
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe(tr('scope.saveFailed').replace('{cause}', cause.message))

      // The cause must appear EXACTLY ONCE. This is the guard that survives the
      // coincidence: a glue form that re-emits the sentence prefix rather than
      // substituting into it would duplicate the cause, and the exact-equality
      // assertion above would have to be satisfied by accident for this to pass.
      expect(alert.textContent!.split(cause.message)).toHaveLength(2)
      // The zh half must be GONE, and no placeholder may survive unfilled: a
      // dropped param leaves the literal `{cause}` standing, which is the
      // half-sentence shape the brief names (t() returns the template untouched
      // when no params are passed).
      expect(alert.textContent).not.toContain(zh['scope.saveFailed']!.replace('{cause}', cause.message))
      expect(alert.textContent).not.toContain('{cause}')
      // No placeholder survives unfilled ANYWHERE in the tree.
      expect(document.body.textContent).not.toContain('{cause}')
    }
  })

  it('translates the pruned-list success line with the en list separator', async () => {
    localeStore.setLocale('en')
    renderPanel(
      scopeClient(scopeSnapshot(), {
        scope: { mode: 'selected', workspaceIds: ['ws-1'], revision: 8 },
        pruned: ['ws-2', 'ws-3'],
      }),
    )

    // The save control EXISTS from the first render but is DISABLED until the
    // read lands, so the click has to wait for the loaded state — clicking the
    // pre-load button would fire no `PUT` at all and this case would pass
    // vacuously. The revision line is the loaded marker (it needs the document).
    await screen.findByText(tr('scope.revision').replace('{revision}', '7'))
    fireEvent.click(screen.getByRole('button', { name: tr('scope.save') }))

    // `scope.savedPruned` + `list.separator`: the separator is its OWN key, so the
    // joined list reads correctly per language — an English sentence with an
    // English-separated list, not the zh `、`.
    const expected = tr('scope.savedPruned').replace('{list}', ['ws-2', 'ws-3'].join(tr('list.separator')))
    // Queried INSIDE `waitFor`: the saved paragraph only exists once the `PUT`
    // resolves, so a query taken before it would pin `null` forever.
    await waitFor(() => {
      expect(document.querySelector('[data-scope-saved]')?.textContent).toBe(expected)
    })
    expect(document.querySelector('[data-scope-saved]')?.textContent).toBe(
      'Saved. The server pruned these stale selections: ws-2, ws-3.',
    )
  })

  it('translates the stale/unmatched groups and the unknown-workspace row', async () => {
    localeStore.setLocale('en')
    renderPanel(
      scopeClient(
        scopeSnapshot({
          // Three distinct ticked ids on purpose: `ws-1` is registered, `ws-gone`
          // is a SAVED stale pick (its own group), and `ws-nowhere` is in NEITHER
          // list — the row the panel must keep visible with `scope.workspaceUnknown`
          // rather than dropping (which would turn "unreadable registry" into
          // "nothing was ticked").
          scope: { mode: 'selected', workspaceIds: ['ws-1', 'ws-gone', 'ws-nowhere'], revision: 4 },
          staleWorkspaceIds: ['ws-gone'],
          pathUnmatched: [{ agentId: 'agent-7', cwd: '/srv/alpha/./sub' }],
        }),
      ),
    )

    await screen.findByText(tr('scope.stale.heading'))
    expect(screen.getByText(tr('scope.stale.note'))).toBeTruthy()
    // Two buttons carry `scope.stale.clear` and `scope.save`; both English.
    expect(screen.getByRole('button', { name: tr('scope.stale.clear') })).toBeTruthy()
    expect(screen.getByText(tr('scope.unmatched.heading'))).toBeTruthy()
    expect(screen.getByText(tr('scope.unmatched.note'))).toBeTruthy()
    // The unmatched session is DATA: agentId and cwd render verbatim.
    expect(document.querySelector('[data-scope-unmatched]')?.textContent).toContain('/srv/alpha/./sub')
    expect(screen.getByText(tr('scope.workspaceUnknown'))).toBeTruthy()
  })

  it('translates the loading line and the no-workspaces line', async () => {
    localeStore.setLocale('en')
    renderPanel({ get: () => new Promise<ScopeResponse>(() => {}), put: () => new Promise<never>(() => {}) })
    expect(screen.getByText(tr('scope.loading'))).toBeTruthy()

    cleanup()
    renderPanel(scopeClient(scopeSnapshot({ workspaces: [], scope: { mode: 'global', workspaceIds: [], revision: 1 } })))
    expect(await screen.findByText(tr('scope.noWorkspaces'))).toBeTruthy()
  })
})
