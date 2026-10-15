// @vitest-environment jsdom
/**
 * Task 8 — the settings page's 「启用范围」 panel (spec §6.4 + B8/B14–B17).
 *
 * One case per numbered assertion in the task brief (①–⑭). The fixtures ARE the
 * server's answers: Task 7 froze the wire shape
 * (`{scope, workspaces, staleWorkspaceIds, pathUnmatched, host}`) and the five
 * stable error codes, so every case here starts from that shape and asserts what
 * the operator sees.
 *
 * Two seams keep the fixtures honest:
 *
 *  - the panel is rendered with an injected `ScopeClient`, so no `fetch` stands
 *    between the fixture and the component under test and every `PUT` the panel
 *    issues is RECORDED (`puts`);
 *  - ② and ⑪ render `App` itself (the real mount path and the `Section`
 *    registered through `slots`), where `/devices` goes through a fetch mock
 *    that THROWS on an unregistered request — the same harness shape
 *    `tests/unit/ui.test.ts` uses. That is what makes a missing `/scope` answer
 *    loud (the panel renders its load-error line) rather than silent.
 *
 * Copy is asserted VERBATIM where the spec fixes it (D11's two empty states, the
 * `scope-version` warning, the upgrade hint), because the wording is the
 * contract: "文案不得与判定矛盾" is only checkable against literal text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { App } from '../../ui/src/App'
import { ToolScopePanel } from '../../ui/src/ToolScopePanel'
import { ApiError } from '../../ui/src/api'
import { apply } from '../../ui/src/main'
import type { SlotRegistration, SlotsService } from '../../ui/src/main'
import type {
  DegradedNote,
  EventSourceLike,
  ScopeClient,
  ScopeDoc,
  ScopeHost,
  ScopeResponse,
  ScopeSaveRequest,
  ScopeSaveResult,
  ScopeWorkspace,
} from '../../ui/src/types'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const READY_REASON =
  '宿主能力齐备（tools.register / tools.restrict / tools.schemas）且 agents / workspaceRegistry 注入已到达'

const WS_ALPHA: ScopeWorkspace = { id: 'ws-1', title: '项目甲', path: '/srv/alpha' }
const WS_BETA: ScopeWorkspace = { id: 'ws-2', title: '项目乙', path: '/srv/beta' }

function doc(over: Partial<ScopeDoc> = {}): ScopeDoc {
  return { mode: 'selected', workspaceIds: [], revision: 3, ...over }
}

function host(over: Partial<ScopeHost> = {}): ScopeHost {
  return { state: 'ready', capable: true, reason: READY_REASON, degraded: [], ...over }
}

function snapshot(over: Partial<ScopeResponse> = {}): ScopeResponse {
  return {
    scope: doc(),
    workspaces: [WS_ALPHA, WS_BETA],
    staleWorkspaceIds: [],
    pathUnmatched: [],
    host: host(),
    ...over,
  }
}

/** A `PUT` verdict: the document the server committed, or a stable-code refusal. */
type PutOutcome = { scope: ScopeDoc; pruned: string[] } | { status: number; code: string; message: string }

interface ScopeStub {
  client: ScopeClient
  /** Every `PUT` body the panel sent, in order. */
  puts: ScopeSaveRequest[]
  /** How many `GET`s were issued (a refusal must not silently re-read). */
  gets: number
}

function installScope(response: ScopeResponse, outcome?: PutOutcome): ScopeStub {
  const puts: ScopeSaveRequest[] = []
  const stub: ScopeStub = {
    puts,
    gets: 0,
    client: {
      get: () => {
        stub.gets += 1
        return Promise.resolve(response)
      },
      put: (body) => {
        puts.push(body)
        if (outcome === undefined) return Promise.resolve({ scope: response.scope, pruned: [] })
        if ('code' in outcome) return Promise.reject(new ApiError(outcome.status, outcome.code, outcome.message))
        return Promise.resolve(outcome)
      },
    },
  }
  return stub
}

// ---------------------------------------------------------------------------
// Queries shared by most assertions
// ---------------------------------------------------------------------------

const SAVE_BUTTON = '保存启用范围'
const CLEAR_BUTTON = '清除已失效选择'

const pageText = (): string => document.body.textContent ?? ''
/** The text of one addressed slot; '' when the slot is absent. */
const slotText = (selector: string): string => document.querySelector(selector)?.textContent ?? ''

const saveButton = (): HTMLButtonElement => screen.getByRole('button', { name: SAVE_BUTTON }) as HTMLButtonElement

const isChecked = (role: 'radio' | 'checkbox', name: string): boolean =>
  (screen.getByRole(role, { name }) as HTMLInputElement).checked

function renderPanel(stub: ScopeStub): ScopeStub {
  render(createElement(ToolScopePanel, { client: stub.client }))
  return stub
}

/** Awaits the panel's read: the mode radios only exist once it has landed. */
async function loaded(): Promise<void> {
  await screen.findByRole('radio', { name: '仅选定工作区' })
}

// ---------------------------------------------------------------------------
// The `App` path: the same throw-on-unregistered-request harness ui.test.ts uses
// ---------------------------------------------------------------------------

class FakeEventSource implements EventSourceLike {
  readonly url: string

  constructor(url: string) {
    this.url = url
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface AppHarness {
  calls: Array<{ url: string; method: string }>
  eventSourceFactory: (url: string) => EventSourceLike
}

function installFetch(responses: Array<[string, string, Response]>): AppHarness {
  const calls: Array<{ url: string; method: string }> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method })
    for (const [responseMethod, responseUrl, response] of responses) {
      if (responseMethod === method && url.endsWith(responseUrl)) return response
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    calls,
    eventSourceFactory: (url: string): EventSourceLike => {
      if (!url.endsWith('/cherry-remote/api/events')) {
        throw new Error(`unexpected event stream url: ${url}`)
      }
      return new FakeEventSource(url)
    },
  }
}

/** Records what the bundle registers; the slots service's immediate-availability case. */
class FakeSlots implements SlotsService {
  readonly registrations: Array<{ options: SlotRegistration; component: ComponentType }> = []

  inject(_slot: string, callback: () => void | (() => void)): void {
    callback()
  }

  register(options: SlotRegistration, component: ComponentType): () => void {
    this.registrations.push({ options, component })
    return () => {}
  }
}

const DEVICE_FIXTURE = {
  deviceId: 'dev-1',
  displayName: '工作站',
  state: 'offline',
  enabled: true,
  hosts: ['192.168.1.10'],
  port: 4343,
}

// ---------------------------------------------------------------------------
// ① Rendering: mode pair + workspace multi-select, D11's per-mode empty state
// ---------------------------------------------------------------------------

describe('启用范围面板 (§6.4)', () => {
  it('① renders the mode radio pair and a workspace multi-select with title + path', async () => {
    renderPanel(installScope(snapshot()))
    await loaded()

    expect(isChecked('radio', '仅选定工作区')).toBe(true)
    expect(isChecked('radio', '全局')).toBe(false)
    expect(screen.getByRole('checkbox', { name: '项目甲 /srv/alpha' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '项目乙 /srv/beta' })).toBeTruthy()
    // Title AND path are both visible, not just the id.
    expect(screen.getByText('项目甲')).toBeTruthy()
    expect(screen.getByText('/srv/beta')).toBeTruthy()
  })

  it('① words the empty state per mode, verbatim (D11)', async () => {
    const stub = renderPanel(installScope(snapshot({ scope: doc({ mode: 'selected', workspaceIds: [] }) })))
    await loaded()

    expect(slotText('[data-scope-empty]')).toContain(
      '尚未启用任何工作区——此状态下 cherry_* 工具不会出现在任何会话里；勾选后对应工作区的会话（含进行中的）即可使用。',
    )
    expect(pageText()).not.toContain('这些工具在所有工作区都可用')

    fireEvent.click(screen.getByRole('radio', { name: '全局' }))

    expect(slotText('[data-scope-empty]')).toContain(
      '当前为全局模式：这些工具在所有工作区都可用；下面的勾选仅在切到「仅选定工作区」后才生效。',
    )
    expect(pageText()).not.toContain('此状态下 cherry_* 工具不会出现在任何会话里')
    // A mode switch is a local draft edit; only a save writes.
    expect(stub.puts).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // ② The host capability tri-state (B7/D8/D13)
  // -------------------------------------------------------------------------

  it('② unsupported: names the REAL gap, adds an upgrade hint, disables save', async () => {
    renderPanel(
      installScope(
        snapshot({
          host: host({
            state: 'unsupported',
            capable: false,
            reason: '宿主缺 tools.restrict，无法做到「注册即可隐藏」 ⇒ 这 12 个工具一个都不注册（fail-closed）',
          }),
        }),
      ),
    )
    await loaded()

    const warning = slotText('[data-scope-warning="unsupported"]')
    // B7③: the reason names the real gap rather than a hardcoded verdict.
    expect(warning).toContain('tools.restrict')
    expect(warning).toContain('只读')
    // B7①/§6.4: an UPGRADE hint is required — cause + disabled save is not enough.
    expect(warning).toContain('升级宿主')
    expect(warning).toContain('以获得该能力')
    expect(saveButton().disabled).toBe(true)
  })

  it('② pending: ONLY the neutral waiting note — no "不支持", no upgrade wording, save enabled, pairing area intact (D9)', async () => {
    const harness = installFetch([['GET', '/cherry-remote/api/devices', jsonResponse(200, [])]])
    const stub = installScope(
      snapshot({ host: host({ state: 'pending', capable: false, reason: '等待宿主注入 agents / workspaceRegistry' }) }),
    )
    render(
      createElement(App, { eventSourceFactory: harness.eventSourceFactory, scopeClient: stub.client }),
    )
    await loaded()

    expect(slotText('[data-scope-notice="pending"]')).toContain('宿主服务挂载中')
    // The deliberate opposite of `unsupported`: neither the refusal verdict nor
    // any upgrade instruction belongs on a `pending` screen.
    expect(pageText()).not.toContain('不支持')
    expect(pageText()).not.toContain('升级')
    expect(saveButton().disabled).toBe(false)
    // D9: the pairing surface is not collateral damage of the capability state.
    expect(screen.getByLabelText('配对信息')).toBeTruthy()
    expect(screen.getByRole('button', { name: '开始配对' })).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // ③ Stale picks (B14)
  // -------------------------------------------------------------------------

  it('③ renders stale picks as their own group and clears them through the PUT `pruned` echo', async () => {
    const stub = installScope(
      snapshot({ scope: doc({ workspaceIds: ['ws-1', 'ws-gone'] }), staleWorkspaceIds: ['ws-gone'] }),
      { scope: doc({ workspaceIds: ['ws-1'], revision: 4 }), pruned: ['ws-gone'] },
    )
    renderPanel(stub)
    await screen.findByText('已失效（工作区已删除）')

    expect(slotText('[data-scope-stale]')).toContain('ws-gone')
    expect(pageText()).not.toContain('校验失败')

    fireEvent.click(screen.getByRole('button', { name: CLEAR_BUTTON }))

    // The clear IS a save: registry-external ids are pruned by the PUT, which
    // §6.4 makes the only path that clears them.
    await waitFor(() => {
      expect(stub.puts).toHaveLength(1)
    })
    expect(stub.puts[0]).toEqual({ mode: 'selected', workspaceIds: ['ws-1', 'ws-gone'], expectedRevision: 3 })

    await waitFor(() => {
      expect(pageText()).toContain('按服务端修剪清除了失效选择：ws-gone')
    })
    // The group is gone because the id is no longer part of the served document.
    expect(screen.queryByText('已失效（工作区已删除）')).toBeNull()
    expect(pageText()).not.toContain('校验失败')
    expect(pageText()).toContain('当前 revision：4')
  })

  // -------------------------------------------------------------------------
  // ④ The workspace list is unreadable (B16)
  // -------------------------------------------------------------------------

  it('④ an unavailable registry list disables save with its reason — under global mode too', async () => {
    renderPanel(
      installScope(
        snapshot({
          scope: doc({ mode: 'global', workspaceIds: [] }),
          workspaces: [],
          host: host({
            degraded: [{ source: 'workspace-list', reason: '工作区列表读取失败：agents / workspaceRegistry 注入未到达' }],
          }),
        }),
      ),
    )
    await loaded()

    expect(slotText('[data-scope-warning="workspace-list"]')).toContain('注册表列表当前读不到')
    expect(pageText()).toContain('工作区列表读取失败：agents / workspaceRegistry 注入未到达')
    expect(saveButton().disabled).toBe(true)
    // Judgement is unaffected under `global`, but the panel still says the list
    // is unreadable — the two facts are not the same statement.
    expect(isChecked('radio', '全局')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // ⑤ Every degradation note, side by side (B12/B16/B17)
  // -------------------------------------------------------------------------

  it('⑤ renders EVERY degradation note at once, not just the last one', async () => {
    const notes: DegradedNote[] = [
      { source: 'install', reason: '工具注册失败：宿主拒绝 register（原因甲）' },
      { source: 'workspace-list', reason: '注册表列表读取失败（原因乙）' },
      { source: 'visibility-only', reason: 'tools.guard 缺失，仅可见性降级（原因丙）' },
      { source: 'scope-version', reason: '作用域文档版本高于本插件支持（原因丁）' },
      { source: 'path-normalization', reason: '真实路径解析失败（原因戊）' },
    ]
    renderPanel(installScope(snapshot({ host: host({ degraded: notes }) })))
    await loaded()

    for (const note of notes) {
      expect(slotText(`[data-degraded-source="${note.source}"]`)).toContain(note.reason)
    }
    // Different sources coexist: all five reasons are in the document together.
    for (const reason of ['原因甲', '原因乙', '原因丙', '原因丁', '原因戊']) {
      expect(pageText()).toContain(reason)
    }
    expect(slotText('[data-degraded-source="install"]')).toContain('工具注册失败（install）')
    expect(slotText('[data-degraded-source="visibility-only"]')).toContain('仅可见性降级')
    expect(slotText('[data-degraded-source="path-normalization"]')).toContain('路径规范化降级')
  })

  // -------------------------------------------------------------------------
  // ⑥ Save refusals branch on the stable code (§6.3, §6.4)
  // -------------------------------------------------------------------------

  it('⑥ branches every save refusal on the STABLE code and never mutates local state', async () => {
    const cases: Array<[string, number, string, string | undefined]> = [
      ['scope-revision-conflict', 409, '配置已被他处修改，请重新读取后再保存', '请重新读取后再保存'],
      ['scope-version-unsupported', 503, '版本高于本插件支持', undefined],
      ['invalid-scope', 400, '作用域字段非法', undefined],
      ['missing-expected-revision', 400, '缺少基准 expectedRevision', undefined],
      ['workspace-list-unavailable', 503, '工作区列表当前读不到，无法保存', undefined],
    ]

    for (const [code, status, expected, alsoExpected] of cases) {
      cleanup()
      const stub = installScope(snapshot({ scope: doc({ workspaceIds: ['ws-1'] }) }), {
        status,
        code,
        message: `服务端对 ${code} 的说明`,
      })
      renderPanel(stub)
      await loaded()

      // A local edit the operator made before the refusal: it must survive it.
      fireEvent.click(screen.getByRole('checkbox', { name: '项目乙 /srv/beta' }))
      fireEvent.click(saveButton())

      await waitFor(() => {
        expect(pageText()).toContain(expected)
      })
      expect(pageText()).toContain(code)
      expect(stub.puts[0]).toEqual({ mode: 'selected', workspaceIds: ['ws-1', 'ws-2'], expectedRevision: 3 })

      // NO failure mutates local state: mode and ticks are bit-for-bit the same,
      // and the document is not silently re-read either.
      expect(isChecked('radio', '仅选定工作区')).toBe(true)
      expect(isChecked('checkbox', '项目甲 /srv/alpha')).toBe(true)
      expect(isChecked('checkbox', '项目乙 /srv/beta')).toBe(true)
      expect(stub.gets).toBe(1)

      if (alsoExpected !== undefined) expect(pageText()).toContain(alsoExpected)
      if (code === 'scope-version-unsupported') {
        // Re-reading cannot change the document's version, so the panel must not
        // send the operator round that loop — and the save is disabled.
        expect(pageText()).not.toContain('请重新读取后再保存')
        expect(saveButton().disabled).toBe(true)
      } else {
        expect(saveButton().disabled).toBe(false)
      }
    }
  })

  // -------------------------------------------------------------------------
  // ⑦ Copy boundary (B15)
  // -------------------------------------------------------------------------

  it('⑦ claims only that this plugin did not shadow the tools — never that the model sees or calls them', async () => {
    renderPanel(installScope(snapshot({ scope: doc({ workspaceIds: ['ws-1'] }) })))
    await loaded()

    expect(pageText()).toContain('本插件未遮蔽')
    expect(pageText()).not.toContain('一定能看到')
    expect(pageText()).not.toContain('一定能调用')
  })

  // -------------------------------------------------------------------------
  // ⑧ `pathUnmatched`: a diagnosis, not an input (§6.1/§6.4)
  // -------------------------------------------------------------------------

  it('⑧ lists each unmatched session (agentId + cwd) apart from the stale group, changing nothing', async () => {
    const stub = installScope(
      snapshot({
        scope: doc({ workspaceIds: ['ws-1'] }),
        pathUnmatched: [
          { agentId: 'agent-7', cwd: '/srv/alpha/./sub' },
          { agentId: 'agent-9', cwd: '/srv/Alpha' },
        ],
      }),
    )
    renderPanel(stub)
    await screen.findByText(/agent-7/)

    const section = slotText('[data-scope-unmatched]')
    expect(section).toContain('agent-7')
    expect(section).toContain('/srv/alpha/./sub')
    expect(section).toContain('agent-9')
    expect(section).toContain('/srv/Alpha')
    // The three causes are indistinguishable HERE — said plainly rather than
    // resolved into one of them.
    expect(section).toContain('拼写不同')
    expect(section).toContain('符号链接')
    expect(section).toContain('确实未注册')
    expect(section).toContain('无法区分')
    // A separate channel from `staleWorkspaceIds` (empty here): never merged.
    expect(screen.queryByText('已失效（工作区已删除）')).toBeNull()
    expect(section).not.toContain('已失效')

    // Presenting the diagnosis is read-only: zero PUTs, ticks and mode untouched.
    expect(stub.puts).toHaveLength(0)
    expect(isChecked('radio', '仅选定工作区')).toBe(true)
    expect(isChecked('checkbox', '项目甲 /srv/alpha')).toBe(true)
    expect(isChecked('checkbox', '项目乙 /srv/beta')).toBe(false)

    await waitFor(() => {
      expect(pageText()).toContain('agent-9')
    })
    expect(stub.puts).toHaveLength(0)
    expect(isChecked('checkbox', '项目甲 /srv/alpha')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // ⑨ The new revision is echoed back (§6.4 last sentence)
  // -------------------------------------------------------------------------

  it('⑨ echoes the NEW revision after a successful save', async () => {
    const stub = installScope(snapshot({ scope: doc({ revision: 3, workspaceIds: [] }) }), {
      scope: doc({ revision: 8, workspaceIds: [] }),
      pruned: [],
    })
    renderPanel(stub)
    await screen.findByText('当前 revision：3')

    fireEvent.click(saveButton())

    await screen.findByText('当前 revision：8')
    expect(screen.queryByText('当前 revision：3')).toBeNull()
    expect(slotText('[data-scope-saved]')).toContain('保存成功')
  })

  // -------------------------------------------------------------------------
  // ⑩ `pending` and the list degradation are two independent notices
  // -------------------------------------------------------------------------

  it('⑩ shows the pending note AND the unavailable-list note on one screen, neither derived from the other', async () => {
    const pendingOnly = snapshot({
      host: host({ state: 'pending', capable: false, reason: '等待宿主注入 agents / workspaceRegistry' }),
    })
    renderPanel(installScope(pendingOnly))
    await loaded()
    expect(slotText('[data-scope-notice="pending"]')).toContain('宿主服务挂载中')
    expect(pageText()).not.toContain('注册表列表当前读不到')
    expect(pageText()).not.toContain('宿主不支持')

    cleanup()

    const listOnly = snapshot({ host: host({ degraded: [{ source: 'workspace-list', reason: '注册表列表读取失败' }] }) })
    renderPanel(installScope(listOnly))
    await loaded()
    expect(slotText('[data-scope-warning="workspace-list"]')).toContain('注册表列表当前读不到')
    expect(pageText()).not.toContain('宿主服务挂载中')

    cleanup()

    const both = snapshot({
      host: host({
        state: 'pending',
        capable: false,
        reason: '等待宿主注入 agents / workspaceRegistry',
        degraded: [{ source: 'workspace-list', reason: '注册表列表读取失败' }],
      }),
    })
    renderPanel(installScope(both))
    await loaded()
    expect(slotText('[data-scope-notice="pending"]')).toContain('宿主服务挂载中')
    expect(slotText('[data-scope-warning="workspace-list"]')).toContain('注册表列表当前读不到')
    expect(pageText()).not.toContain('宿主不支持')
  })

  // -------------------------------------------------------------------------
  // ⑪ Every `App` render path gets a `/scope` answer
  // -------------------------------------------------------------------------

  it('⑪ answers GET /scope on every App render path the existing suite uses', async () => {
    // The four DIRECT render paths in tests/unit/ui.test.ts — the status-light
    // matrix loop (:488), the single-card PATCH case (:582), the two-card
    // first-frames case (:667) and the `Section` registered through `slots`
    // (:779) — plus `renderWithDevice`'s shape. Each runs against a harness that
    // THROWS on an unregistered request, so a missing `/scope` answer shows up
    // here as the panel's load-error line instead of passing silently.
    const paths: Array<{ name: string; devices: unknown[]; section?: boolean }> = [
      { name: 'status-light matrix (:488)', devices: [{ ...DEVICE_FIXTURE, state: 'offline' }] },
      { name: 'single card + PATCH (:582)', devices: [{ ...DEVICE_FIXTURE, enabled: false, state: 'disabled' }] },
      {
        name: 'two cards, first frames (:667)',
        devices: [DEVICE_FIXTURE, { ...DEVICE_FIXTURE, deviceId: 'dev-2', displayName: '笔记本' }],
      },
      { name: 'renderWithDevice (:162)', devices: [DEVICE_FIXTURE] },
      { name: 'registered settings Section (:779)', devices: [], section: true },
    ]

    for (const path of paths) {
      cleanup()
      const harness = installFetch([
        ['GET', '/cherry-remote/api/devices', jsonResponse(200, path.devices)],
        ['GET', '/cherry-remote/api/scope', jsonResponse(200, snapshot())],
      ])
      if (path.section === true) {
        const slots = new FakeSlots()
        apply({ slots, effect: (callback: () => void | (() => void)) => void callback() })
        const Section = slots.registrations[0]?.component as ComponentType
        render(createElement(Section))
      } else {
        render(createElement(App, { eventSourceFactory: harness.eventSourceFactory }))
      }

      await loaded()
      expect(pageText(), path.name).not.toContain('读取启用范围失败')
      expect(harness.calls.some((call) => call.url.endsWith('/cherry-remote/api/scope')), path.name).toBe(true)
    }
  })

  // -------------------------------------------------------------------------
  // ⑫ A corrupt document warns in the EXISTING wording slot (B9)
  // -------------------------------------------------------------------------

  it('⑫ warns for a corrupt document in the existing slot — never as global / "all is well"', async () => {
    // A parse failure or an illegal field falls to the stricter side: `selected`
    // + an empty list (B9), and the wire shape is then the same as "nothing
    // ticked yet". The carrier is that very line — no new region, no new
    // `DegradedSource` member.
    renderPanel(
      installScope(
        snapshot({
          scope: doc({ mode: 'selected', workspaceIds: [], revision: 0 }),
          workspaces: [WS_ALPHA, WS_BETA],
        }),
      ),
    )
    await loaded()

    expect(slotText('[data-scope-empty]')).toContain('此状态下 cherry_* 工具不会出现在任何会话里')
    expect(pageText()).not.toContain('当前为全局模式')
    expect(pageText()).not.toContain('这些工具在所有工作区都可用')
  })

  // -------------------------------------------------------------------------
  // ⑬/⑭ The `scope-version` degradation (a GET-side state, not a PUT verdict)
  // -------------------------------------------------------------------------

  it('⑬ a scope-version degradation is an explicit disabled-save warning, with NO PUT in the round', async () => {
    const stub = installScope(
      snapshot({
        host: host({
          degraded: [
            {
              source: 'scope-version',
              reason: '作用域文档版本高于本插件支持（本插件支持 version 1）；已只读降级并拒绝写入',
            },
          ],
        }),
      }),
    )
    renderPanel(stub)
    await loaded()

    // The explicit TOP warning, separate from ⑤'s per-note rendering.
    expect(slotText('[data-scope-warning="scope-version"]')).toContain('文档版本高于本插件支持')
    expect(slotText('[data-degraded-source="scope-version"]')).toContain(
      '作用域文档版本高于本插件支持（本插件支持 version 1）',
    )
    expect(saveButton().disabled).toBe(true)
    // This round is the GET alone: nothing about the state triggers a write.
    expect(stub.puts).toHaveLength(0)
  })

  it('⑭ a scope-version degradation is never shown as "nothing ticked"', async () => {
    const degraded = snapshot({
      scope: doc({ mode: 'selected', workspaceIds: [] }),
      host: host({
        degraded: [
          {
            source: 'scope-version',
            reason: '作用域文档版本高于本插件支持（本插件支持 version 1）；已只读降级并拒绝写入',
          },
        ],
      }),
    })
    renderPanel(installScope(degraded))
    await loaded()

    expect(pageText()).not.toContain('此状态下 cherry_* 工具不会出现在任何会话里')
    expect(slotText('[data-scope-empty]')).toBe('')

    cleanup()

    // The same document without the degradation: only THEN is the empty state
    // the operator's own doing, and only then may the panel say so.
    renderPanel(installScope(snapshot({ scope: doc({ mode: 'selected', workspaceIds: [] }) })))
    await loaded()

    expect(slotText('[data-scope-empty]')).toContain('此状态下 cherry_* 工具不会出现在任何会话里')
  })

  it('self-review: nothing is claimed before the read lands', async () => {
    // The draft is seeded BY the read, so before it arrives the panel only LOOKS
    // empty. Saying "这些工具不会出现在任何会话里" then would be a claim about a
    // document nobody has read — the same class of defect D11 warns about.
    const never = new Promise<ScopeResponse>(() => {})
    const neverPut = new Promise<ScopeSaveResult>(() => {})
    render(
      createElement(ToolScopePanel, {
        client: { get: () => never, put: () => neverPut },
      }),
    )

    expect(screen.getByText('正在读取启用范围…')).toBeTruthy()
    expect(slotText('[data-scope-empty]')).toBe('')
    expect(saveButton().disabled).toBe(true)
  })
})
