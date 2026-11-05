// @vitest-environment jsdom
/**
 * #233 — the settings page's experimental subagent panel.
 *
 * The user's hard requirement is the reason this file starts where it does:
 * 「实验性」「默认关闭」「欢迎贡献思路和问题反馈」 must be on the page, so ① asserts
 * them VERBATIM (the wording is the contract, and #234's README quotes the same
 * three sentences).
 *
 * The other three groups pin the parts a screenshot cannot:
 *
 *  - ② the two failure states that must NOT be collapsed (`unsupported` is a
 *    host the operator cannot change, so the form is read-only; `invalid` is a
 *    typo they can fix here, so saving stays possible) — and that each problem
 *    is rendered as a TRANSLATED sentence from its code, not as the server's
 *    prose or the raw code;
 *  - ③ the read-modify-write cycle: the baseline is the revision that was read,
 *    the unrendered fields survive a save, and a conflict leaves the draft alone;
 *  - ④ the English half actually renders English — the whole reason the server
 *    stopped sending sentences.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { SubagentPanel } from '../../ui/src/SubagentPanel'
import { ApiError } from '../../ui/src/api'
import { localeStore } from '../../ui/src/i18n'
import type {
  SubagentClient,
  SubagentResponse,
  SubagentSaveRequest,
  SubagentStatusReason,
} from '../../ui/src/types'

afterEach(() => {
  cleanup()
  // The locale store is module-level and shared by every case in this worker: a
  // case that switched to English would otherwise leak into the next one.
  localeStore.setLocale('zh')
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DISABLED: SubagentResponse = {
  subagent: { revision: 0 },
  source: 'config',
  status: { state: 'pending', reason: { code: 'disabled' } },
  pendingRestart: false,
}

/** A response with a chosen verdict; the document stays the disabled default. */
function withStatus(
  state: SubagentResponse['status']['state'],
  reason: SubagentStatusReason,
): SubagentResponse {
  return { ...DISABLED, status: { state, reason } }
}

const READY: SubagentResponse = {
  subagent: {
    enabled: true,
    device: 'desk-1',
    agentId: 'agent-7',
    workspaceId: 'ws-1',
    cwdMode: 'shared',
    timeoutMs: 1_800_000,
    revision: 4,
  },
  source: 'file',
  status: { state: 'ready', reason: { code: 'ready', providerName: 'cherry', toolName: 'cherry_subagent' } },
  pendingRestart: false,
}

/** A stub client that records every PUT and answers like the real route. */
function stubClient(answer: SubagentResponse = DISABLED): SubagentClient & { puts: SubagentSaveRequest[] } {
  const puts: SubagentSaveRequest[] = []
  return {
    puts,
    get: async () => answer,
    put: async (body) => {
      puts.push(body)
      const { expectedRevision: _baseline, ...fields } = body
      return {
        ...answer,
        subagent: { ...fields, revision: answer.subagent.revision + 1 },
        source: 'file',
        // A save that differs from the running decision is exactly the
        // "restart owed" state; the panel must say so.
        pendingRestart: true,
      }
    },
  }
}

const renderPanel = (client: SubagentClient): void => {
  render(createElement(SubagentPanel, { client }))
}

// ---------------------------------------------------------------------------
// ① the hard requirement, and the default
// ---------------------------------------------------------------------------

describe('① experimental, off by default, feedback welcome', () => {
  it('①a renders the badge, the why, the default-off line and the issues link — in the OFF state', async () => {
    renderPanel(stubClient())
    await screen.findByText('未启用（默认关闭）。')
    // SUB-70. The badge and the sentence are on the page BEFORE the feature is
    // configured: a label that only appears once it works is no warning at all.
    expect(screen.getByText('实验性')).toBeDefined()
    expect(
      screen.getByText(
        '实验性功能：它跨了 DSH 与 Cherry Studio 两个不受本插件控制的系统，接口与行为都可能变。默认关闭。',
      ),
    ).toBeDefined()
    expect(screen.getByText('默认关闭。打开需要填写目标设备、agent 与工作区；保存后在重启 DSH 时生效。')).toBeDefined()
    // SUB-71, and the SAME string #234 quotes in the README pair.
    const link = screen.getByRole('link') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://github.com/SAXEM1997/dsh-cherry-bridge/issues')
    expect(link.textContent).toBe('dsh-cherry-bridge issues')
  })

  it('①b the switch is OFF, and an off document renders no required-field error', async () => {
    const client = stubClient()
    renderPanel(client)
    const toggle = (await screen.findByRole('checkbox')) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    // The ticket's discipline: the block stays visible while off (otherwise the
    // feature is unfindable), but nothing is marked as an error for being
    // half-written — a draft behind a closed switch is not a mistake.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ② the four states, translated from codes
// ---------------------------------------------------------------------------

describe('② the status is rendered from CODES, and the two failures differ', () => {
  it('②a `unsupported` explains the host, SAYS the form is read-only, and makes it so', async () => {
    renderPanel(stubClient(withStatus('unsupported', { code: 'unsupported' })))
    // The sentence and the button must agree. The first draft read
    // 本页仍可保存配置 while `readOnly` disabled the save: an operator was told
    // to do something the page refuses. The spec review found it; the wording
    // now states the read-only form instead of promising a save.
    await screen.findByText(
      '当前 DSH 版本没有 subagents 服务，这个功能无法使用；其余功能不受影响。表单已置为只读——在这个版本上保存也不会生效。',
    )
    // Saving cannot help here, and a control that looks effective while it
    // cannot be is the fake switch this ticket exists to prevent.
    expect((screen.getByRole('button', { name: '保存子智能体配置' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
  })

  it('②b `failed` lists every problem as a translated sentence AND keeps saving possible', async () => {
    renderPanel(
      stubClient(
        withStatus('failed', {
          code: 'invalid',
          problems: [
            { code: 'missing', field: 'device' },
            { code: 'out-of-range', field: 'timeoutMs', min: 0, max: 2_147_483_647, received: 'string' },
            { code: 'enum', field: 'cwdMode', allowed: ['isolated', 'shared'], received: 'number' },
            { code: 'exclusive', field: 'workspaceId', other: 'workspaceKind' },
            { code: 'route-cwd-prefix', field: 'routes[0].cwdPrefix' },
          ],
        }),
      ),
    )
    await screen.findByText('开关已打开，但配置还不可用：')
    // Each sentence comes from the code + its params, in the page's language:
    // the shape (`string`) is translated too, which is why it reads 字符串.
    for (const sentence of [
      '缺少 device',
      'timeoutMs 必须是 0 到 2147483647 之间的整数（收到 字符串）',
      'cwdMode 只接受 isolated、shared（收到 数字）',
      'workspaceId 与 workspaceKind 只能二选一',
      'routes[0].cwdPrefix 必须是非空字符串',
    ]) {
      expect(screen.getByText(sentence)).toBeDefined()
    }
    // The operator fixes this HERE, so the save must stay available.
    expect((screen.getByRole('button', { name: '保存子智能体配置' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('②c `ready` names both registrations, and `ready-without-tool` names what is missing', async () => {
    renderPanel(stubClient(READY))
    await screen.findByText('已注册 provider cherry 与工具 cherry_subagent。')

    cleanup()
    renderPanel(
      stubClient(
        withStatus('ready', {
          code: 'ready-without-tool',
          providerName: 'cherry',
          toolName: 'cherry_subagent',
          problem: { code: 'no-step-condition' },
        }),
      ),
    )
    await screen.findByText('已注册 provider cherry，但工具 cherry_subagent 未注册：')
    expect(
      screen.getByText(
        '宿主没有 tools.resolve（不支持步骤级激活条件）：工具不注册，以免在所有工作区都可见（fail-closed）。',
      ),
    ).toBeDefined()
  })

  it('②d says the experiment is scope-gated, including the arm the status cannot show', async () => {
    renderPanel(stubClient(READY))
    await screen.findByText('已注册 provider cherry 与工具 cherry_subagent。')
    // `ready` over a scope that excludes every workspace is the confusing case:
    // the operator reads "registered", the model never sees the tool, and the
    // cause is in the OTHER panel. The degraded arm (selected + an unreadable
    // workspace list) is invisible from this status at all, so it is stated.
    expect(
      screen.getByText(
        '它和其余 14 个工具一样受「启用范围」约束：被排除的工作区看不到它。启用范围为「仅选定工作区」而工作区列表读不到时，任何工作区都看不到它。',
      ),
    ).toBeDefined()
  })

  it('②e shows the stored routes read-only, because a problem can name one this form cannot edit', async () => {
    renderPanel(
      stubClient({
        ...READY,
        subagent: { ...READY.subagent, routes: [{ cwdPrefix: '/repo/a', device: 'desk-9' }] },
      }),
    )
    // `routesOf` validates every entry and pushes `routes[0].cwdPrefix`-style
    // problems, so a bad route has to be visible HERE or nowhere: the page has
    // no editor for it, and `bodyOf` carries the stored value through untouched.
    // It is not a declaration: `matchRoute` picks the device and workspace for
    // a subdirectory from exactly this table.
    await screen.findByText(
      'routes：[{"cwdPrefix":"/repo/a","device":"desk-9"}]（按子目录前缀覆盖设备与工作区；本页只展示，不编辑）',
    )
  })
})

// ---------------------------------------------------------------------------
// ③ the read-modify-write cycle
// ---------------------------------------------------------------------------

describe('③ a save is a read-modify-write, locked on what was read', () => {
  it('③a sends the read revision, the edited fields, and the fields the form never showed', async () => {
    const client = stubClient({
      ...READY,
      subagent: { ...READY.subagent, routes: [{ cwdPrefix: '/repo/a', workspaceId: 'ws-2' }] },
    })
    renderPanel(client)
    const device = (await screen.findByLabelText('目标设备')) as HTMLInputElement
    fireEvent.change(device, { target: { value: '  desk-2  ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存子智能体配置' }))

    await waitFor(() => expect(client.puts).toHaveLength(1))
    const body = client.puts[0]!
    // The baseline is the revision that was READ, which is the whole lock.
    expect(body.expectedRevision).toBe(4)
    // Trimmed at the boundary: a pasted name with spaces is not a different
    // device id.
    expect(body.device).toBe('desk-2')
    // `cwdMode` has no control on this page — dropping it would make a save
    // delete configuration the operator never saw.
    expect(body.cwdMode).toBe('shared')
    // `routes` picks the device and workspace for a directory, and it has no
    // control here either: a save that sent only the rendered half would
    // re-route every delegated directory, silently.
    expect(body.routes).toEqual([{ cwdPrefix: '/repo/a', workspaceId: 'ws-2' }])
    expect(body.agentId).toBe('agent-7')
    expect(body.timeoutMs).toBe(1_800_000)
    await screen.findByText('已保存。')
    // The save answered `pendingRestart: true`, and the panel says so rather
    // than pretending the change is live.
    expect(screen.getByText('已保存，但当前装配仍在用旧配置：重启 DSH 后生效。')).toBeDefined()
  })

  it('③b the restart notice is absent when the running assembly already matches', async () => {
    renderPanel(stubClient({ ...READY, pendingRestart: false }))
    await screen.findByText('已注册 provider cherry 与工具 cherry_subagent。')
    expect(screen.queryByText('已保存，但当前装配仍在用旧配置：重启 DSH 后生效。')).toBeNull()
    // And the source line tells the operator which document they are editing.
    expect(screen.getByText('当前配置来自本页保存的配置文档。')).toBeDefined()
  })

  it('③c a conflict is reported and the operator’s edit is NOT reset', async () => {
    const client = stubClient(READY)
    const conflict = new ApiError(409, 'subagent-revision-conflict', 'stale')
    client.put = async () => {
      throw conflict
    }
    renderPanel(client)
    const agent = (await screen.findByLabelText('目标 agent')) as HTMLInputElement
    fireEvent.change(agent, { target: { value: 'agent-9' } })
    fireEvent.click(screen.getByRole('button', { name: '保存子智能体配置' }))

    await screen.findByText('保存失败：配置已被他处修改，请重新读取后再保存。')
    // The draft is the operator's; a refusal must not overwrite it, or the
    // recovery (read again) would silently discard their typing.
    expect((screen.getByLabelText('目标 agent') as HTMLInputElement).value).toBe('agent-9')
    // The recovery is an explicit click, not an automatic re-read.
    expect(screen.getByRole('button', { name: '重新读取' })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// ④ the English half
// ---------------------------------------------------------------------------

describe('④ the page is bilingual, including the codes', () => {
  it('④a renders the problems in English when the locale is en', async () => {
    localeStore.setLocale('en')
    renderPanel(
      stubClient(
        withStatus('failed', {
          code: 'invalid',
          // `string` → "a string", NOT `null` → "null": a token that reads the
          // same in both languages and as the raw token cannot distinguish a
          // translated shape from an untranslated one. (The standards review
          // caught the original `null` here, where deleting SHAPE_KEYS left this
          // case green.)
          problems: [{ code: 'out-of-range', field: 'timeoutMs', min: 0, max: 2_147_483_647, received: 'string' }],
        }),
      ),
    )
    await screen.findByText('The switch is on, but the configuration is not usable yet:')
    // The SHAPE is translated — `string` reads "a string", so no `typeof`
    // result ever lands inside an English sentence.
    expect(
      screen.getByText('timeoutMs must be an integer between 0 and 2147483647 (got a string)'),
    ).toBeDefined()
    // And the hard requirement travels with the language.
    expect(screen.getByText('Experimental')).toBeDefined()
    expect(
      screen.getByText(
        'Off by default. Turning it on needs a target device, agent and workspace; a save takes effect when DSH restarts.',
      ),
    ).toBeDefined()
  })
})
