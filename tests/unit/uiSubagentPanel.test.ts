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
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { SubagentPanel } from '../../ui/src/SubagentPanel'
import { ApiError } from '../../ui/src/api'
import { createTranslator, localeStore } from '../../ui/src/i18n'
import { MANUAL_TARGET_VALUE } from '../../ui/src/subagentTargets'
import type {
  DeviceSummary,
  SubagentClient,
  SubagentResponse,
  SubagentSaveRequest,
  SubagentStatusReason,
  SubagentTargetsResponse,
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

/**
 * The candidate answer the stub gives unless a case says otherwise.
 *
 * It names the two ids `READY` and the older cases already use, so a case that
 * selects one is selecting from a real list rather than relying on the
 * unknown-value escape hatch.
 */
const CANDIDATES: SubagentTargetsResponse = {
  agents: [
    { agentId: 'agent-7', name: 'Cherry Seven' },
    { agentId: 'agent-9', name: 'Cherry Nine' },
  ],
  workspaces: [
    { workspaceId: 'ws-1', name: 'Repo One' },
    { workspaceId: 'ws-9', name: 'Repo Nine' },
  ],
  systemWorkspace: true,
}

/**
 * A stub client that records every PUT and answers like the real route.
 *
 * `targets` defaults to an EMPTY listing rather than a problem: every case that
 * predates #262 is about the form's save/lock behaviour, and an empty list is the
 * quietest answer that still lets the panel render. A case that cares passes its
 * own.
 */
function stubClient(
  answer: SubagentResponse = DISABLED,
  targets: (device: string, agentId?: string) => Promise<SubagentTargetsResponse> = async () => CANDIDATES,
): SubagentClient & { puts: SubagentSaveRequest[]; targetCalls: [string, string | undefined][] } {
  const puts: SubagentSaveRequest[] = []
  const targetCalls: [string, string | undefined][] = []
  return {
    puts,
    targetCalls,
    targets: async (device, agentId) => {
      targetCalls.push([device, agentId])
      return targets(device, agentId)
    },
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

const renderPanel = (client: SubagentClient, devices: readonly DeviceSummary[] = []): void => {
  render(createElement(SubagentPanel, { client, devices }))
}

/** The devices `App` hands down, sorted the way it sorts them. */
const DEVICES: DeviceSummary[] = [
  { deviceId: 'desk-1', displayName: 'Desk One', state: 'connected', enabled: true, hosts: [], port: 1, ports: {}, forgottenHosts: [] },
  { deviceId: 'desk-2', displayName: 'Desk Two', state: 'offline', enabled: true, hosts: [], port: 1, ports: {}, forgottenHosts: [] },
]

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
        '实验性功能：仿 DSH 官方 subagent 的委派方式（与 Claude Code / Codex 的子智能体同一路数），把任务交给 Cherry Studio 桌面端上的 agent 执行、结果以文本回来。它跨了 DSH 与 Cherry Studio 两个不受本插件控制的系统，接口与行为都可能变。默认关闭。',
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
    renderPanel(client, DEVICES)
    // The device is a DROP-DOWN now (#262), so a hand-typed id — the only place
    // a value with spaces can still come from — arrives through the manual
    // sentinel. The trim assertion is still worth keeping: the box is real.
    const device = (await screen.findByLabelText('目标设备')) as HTMLSelectElement
    fireEvent.change(device, { target: { value: MANUAL_TARGET_VALUE } })
    const deviceBox = (await screen.findByLabelText('设备 id')) as HTMLInputElement
    fireEvent.change(deviceBox, { target: { value: '  desk-2  ' } })
    // The prompt is visible WHILE the edit is pending — that is the point of it.
    // After the save the document agrees with the draft again and the line goes
    // away, so asserting it afterwards would be asserting the opposite.
    expect(screen.getByText('设备已更换，目标 agent 已清空，请重新选择。')).toBeDefined()
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
    // NOT 'agent-7': the device changed, and an agent id belongs to a device
    // (#262). Keeping it would write desk-1's agent onto desk-2 — the silent
    // cross-device mistake the "choose it again" prompt exists to prevent.
    expect(body.agentId).toBe('')
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
    const agent = (await screen.findByLabelText('目标 agent')) as HTMLSelectElement
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

// ---------------------------------------------------------------------------
// ⑤ the README pair quotes these sentences, not a paraphrase
// ---------------------------------------------------------------------------

describe('⑤ the README pair carries the same three sentences', () => {
  it('⑤a both READMEs quote their language’s experimental, default-off and feedback lines', () => {
    // The user's hard requirement is that nobody turns this on without knowing
    // it is experimental, and it was stated for BOTH surfaces: the settings page
    // and the README. A paraphrase on the page and a reword in the README is how
    // the two drift apart, so the README is checked against the DICTIONARY — the
    // one place the page's wording lives — instead of against a second copy.
    // `URL` here is jsdom's, not Node's: it resolves a relative path against the
    // DOCUMENT url (`http://localhost:3000`), so `file:` bases are ignored. The
    // node implementation is imported by name for that reason.
    const readme = (name: string): string =>
      readFileSync(fileURLToPath(new NodeURL(`../../${name}`, import.meta.url)), 'utf8')

    for (const [name, locale] of [
      ['README.md', 'zh'],
      ['README.en.md', 'en'],
    ] as const) {
      const t = createTranslator(locale)
      const text = readme(name)
      const heading = locale === 'zh' ? /^## 实验性子智能体$/m : /^## Experimental subagent$/m
      // `subagent.experimental` carries two of the three phrases (实验性 and
      // 默认关闭) and `subagent.feedback` the third, so these two sentences are
      // the whole hard requirement. `subagent.defaultOff` is NOT pinned: its
      // restart line is the README's own prose, and quoting it as well put
      // 默认关闭 on two adjacent lines — which reads like a copy-paste slip.
      //
      // The HEADING is pinned too, and the sentences must follow it: without
      // that, deleting the section left this case green (a sentence anywhere in
      // the file, a fenced code block included, satisfied a presence check).
      expect(text, `${name} must carry the section heading`).toMatch(heading)
      // Fenced blocks are stripped: a sentence inside a code block is not the
      // README telling anyone anything, and `toContain` over raw Markdown cannot
      // tell the two apart (the reviewer's fifth mutation).
      const prose = text.replace(/```[\s\S]*?```/g, '')
      const at = prose.search(heading)
      for (const key of ['subagent.experimental', 'subagent.feedback']) {
        expect(prose, `${name} must quote ${key} verbatim, in prose`).toContain(t(key))
        expect(prose.indexOf(t(key)), `${name} quotes ${key} before its heading`).toBeGreaterThan(at)
      }
      // The feedback entry point is the same string as the page's (#234).
      expect(text).toContain('https://github.com/SAXEM1997/dsh-cherry-bridge/issues')
    }
  })
})

// ---------------------------------------------------------------------------
// ⑥ the form actually reaches the request body
// ---------------------------------------------------------------------------

/**
 * `bodyOf` is the one place a rendered field becomes a stored field, and until
 * #251 no case read the body for four of its five wirings: replacing `enabled`,
 * `agentId`, the workspace radio or `timeoutMs` with a constant left every UI
 * case green. These are the assertions that make the form a form.
 */
describe('⑥ every rendered control reaches the save body', () => {
  it('⑥a clearing the timeout box CLEARS the field instead of re-sending the stored one', async () => {
    // `...stored` puts the stored `timeoutMs` in the body FIRST, so "leave the
    // field out" only ever meant "do not override it" — the box could not be
    // cleared, whatever the comment promised.
    const client = stubClient(READY)
    renderPanel(client)
    const box = (await screen.findByLabelText('单次委托超时（毫秒；0 表示不限）')) as HTMLInputElement
    expect(box.value).toBe('1800000')
    fireEvent.change(box, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存子智能体配置' }))

    await waitFor(() => expect(client.puts).toHaveLength(1))
    // Asserted on the WIRE form, because that is what the server parses: the
    // stub client hands the object over in process, where an explicit
    // `timeoutMs: undefined` is still an own key. `JSON.stringify` drops it, so
    // the server sees no field at all — and it writes the body as the document,
    // supplying the default only when the field is missing.
    const wire = JSON.parse(JSON.stringify(client.puts[0])) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(wire, 'timeoutMs')).toBe(false)
  })

  it('⑥b the enable switch reaches the body, both ways', async () => {
    const client = stubClient(READY)
    renderPanel(client)
    const toggle = (await screen.findByRole('checkbox')) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: '保存子智能体配置' }))
    await waitFor(() => expect(client.puts).toHaveLength(1))
    // FALSE, not merely absent: an omitted `enabled` would leave the stored
    // document's `true` in place and the feature would stay on.
    expect(client.puts[0]!.enabled).toBe(false)
  })

  it('⑥c the agent box reaches the body, trimmed', async () => {
    const client = stubClient(READY)
    renderPanel(client)
    const agent = (await screen.findByLabelText('目标 agent')) as HTMLSelectElement
    fireEvent.change(agent, { target: { value: MANUAL_TARGET_VALUE } })
    const agentBox = (await screen.findByLabelText('agent id')) as HTMLInputElement
    fireEvent.change(agentBox, { target: { value: '  agent-9  ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存子智能体配置' }))
    await waitFor(() => expect(client.puts).toHaveLength(1))
    expect(client.puts[0]!.agentId).toBe('agent-9')
  })

  it('⑥d the workspace radio picks the KIND, and switching back undoes it', async () => {
    const client = stubClient(READY)
    renderPanel(client)
    await screen.findByText('目标设备')
    fireEvent.click(screen.getByLabelText('系统工作区'))
    fireEvent.click(screen.getByRole('button', { name: '保存子智能体配置' }))
    await waitFor(() => expect(client.puts).toHaveLength(1))
    // BOTH halves: `workspaceKind` is what the server reads, and a stale
    // `workspaceId` beside it would name a workspace the kind says to ignore.
    expect(client.puts[0]!.workspaceKind).toBe('system')
    expect(client.puts[0]!.workspaceId).toBeUndefined()

    // Switching back, and naming a workspace: the previous save really did
    // clear the id, so the box comes back EMPTY — re-typing is the operator's
    // job, and a case that expected the old id to survive would be asserting
    // that the save did not work.
    fireEvent.click(screen.getByLabelText('指定已注册的工作区'))
    const idSelect = (await screen.findByLabelText('工作区 id')) as HTMLSelectElement
    // UNSELECTED, and visibly so: the save really did clear the id, so the
    // control comes back on the empty option rather than showing a value the
    // document no longer has.
    expect(idSelect.value).toBe('')
    expect(idSelect.selectedOptions[0]?.textContent).toBe('（未选择）')
    fireEvent.change(idSelect, { target: { value: MANUAL_TARGET_VALUE } })
    const idBox = (await screen.findByLabelText('工作区 id（手工）')) as HTMLInputElement
    fireEvent.change(idBox, { target: { value: ' ws-9 ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存子智能体配置' }))
    await waitFor(() => expect(client.puts).toHaveLength(2))
    expect(client.puts[1]!.workspaceKind).toBeUndefined()
    expect(client.puts[1]!.workspaceId).toBe('ws-9')
  })
})

// ---------------------------------------------------------------------------
// ⑦ the candidate source (#262)
// ---------------------------------------------------------------------------

describe('⑦ the three target fields are drop-downs with names', () => {
  it('⑦a the device options carry the name, the id and the STATE', async () => {
    // `READY` names desk-1; `DISABLED` names nothing, and then the control is
    // correctly on the empty option.
    renderPanel(stubClient(READY), DEVICES)
    const select = (await screen.findByLabelText('目标设备')) as HTMLSelectElement
    // Asserted on the SELECTED OPTION, not on a request body: a control that
    // showed nothing while its state was right is exactly the failure a body
    // assertion cannot see.
    expect(select.value).toBe('desk-1')
    expect(select.selectedOptions[0]?.textContent).toBe('Desk One（desk-1） · 已连接')
    // The state belongs in the label: choosing an offline device makes every
    // delegation fail, and that is worth knowing BEFORE choosing.
    expect(screen.getByRole('option', { name: 'Desk Two（desk-2） · 离线' })).toBeDefined()
  })

  it('⑦b picking an agent from the list selects it, and only the id reaches the body', async () => {
    const client = stubClient(READY)
    renderPanel(client)
    const select = (await screen.findByLabelText('目标 agent')) as HTMLSelectElement
    // The NAME is what the operator reads; the id is what is stored.
    expect(screen.getByRole('option', { name: 'Cherry Nine（agent-9）' })).toBeDefined()
    fireEvent.change(select, { target: { value: 'agent-9' } })
    expect(select.value).toBe('agent-9')
    fireEvent.click(screen.getByRole('button', { name: '保存子智能体配置' }))
    await waitFor(() => expect(client.puts).toHaveLength(1))
    expect(client.puts[0]!.agentId).toBe('agent-9')
  })

  it('⑦c a device change leaves the agent UNSELECTED, says why, and never re-sends the old id', async () => {
    const client = stubClient(READY)
    renderPanel(client, DEVICES)
    const device = (await screen.findByLabelText('目标设备')) as HTMLSelectElement
    fireEvent.change(device, { target: { value: 'desk-2' } })

    const agent = (await screen.findByLabelText('目标 agent')) as HTMLSelectElement
    expect(agent.value).toBe('')
    expect(agent.selectedOptions[0]?.textContent).toBe('（未选择）')
    // Still OFFERED: "unselected" must not mean "nothing to choose".
    expect(screen.getByRole('option', { name: 'Cherry Seven（agent-7）' })).toBeDefined()
    expect(screen.getByText('设备已更换，目标 agent 已清空，请重新选择。')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '保存子智能体配置' }))
    await waitFor(() => expect(client.puts).toHaveLength(1))
    expect(client.puts[0]!.device).toBe('desk-2')
    expect(client.puts[0]!.agentId).toBe('')
    // …and the workspace that belonged to the OLD agent goes with it. Nothing
    // was picked for the new device, so the body must not pair one device with
    // another one's workspace.
    expect(client.puts[0]!.workspaceId).toBe('')
  })

  it('⑦k a NEW device can be given a new agent AND a new workspace without saving in between', async () => {
    // #271, reported from a real desktop: "the second drop-down only takes
    // effect if you save the first one first". The invalidation was derived
    // against the SAVED device, so it stayed armed for as long as the draft
    // differed from the document — which is exactly the whole time an operator
    // is filling the form in. Every pick below the first was blanked again the
    // instant it was made, and a save silently sent ''.
    const client = stubClient(READY)
    renderPanel(client, DEVICES)
    const device = (await screen.findByLabelText('目标设备')) as HTMLSelectElement
    fireEvent.change(device, { target: { value: 'desk-2' } })

    const agent = (await screen.findByLabelText('目标 agent')) as HTMLSelectElement
    await waitFor(() => expect(agent.value).toBe(''))
    fireEvent.change(agent, { target: { value: 'agent-9' } })
    // The pick belongs to the device it was chosen under, so it applies.
    expect(agent.value).toBe('agent-9')

    const workspace = (await screen.findByLabelText('工作区 id')) as HTMLSelectElement
    await waitFor(() => expect(screen.getByRole('option', { name: 'Repo Nine（ws-9）' })).toBeDefined())
    fireEvent.change(workspace, { target: { value: 'ws-9' } })
    expect(workspace.value).toBe('ws-9')

    fireEvent.click(screen.getByRole('button', { name: '保存子智能体配置' }))
    await waitFor(() => expect(client.puts).toHaveLength(1))
    expect(client.puts[0]).toMatchObject({ device: 'desk-2', agentId: 'agent-9', workspaceId: 'ws-9' })
  })

  it('⑦l a HAND-TYPED agent also applies to the new device, without a save in between', async () => {
    // The same defect through the escape hatch: the manual box writes the draft
    // per keystroke, so the derived invalidation blanked it on every render too.
    const client = stubClient(READY)
    renderPanel(client, DEVICES)
    const device = (await screen.findByLabelText('目标设备')) as HTMLSelectElement
    fireEvent.change(device, { target: { value: 'desk-2' } })

    const agent = (await screen.findByLabelText('目标 agent')) as HTMLSelectElement
    await waitFor(() => expect(agent.value).toBe(''))
    fireEvent.change(agent, { target: { value: MANUAL_TARGET_VALUE } })
    const box = (await screen.findByLabelText('agent id')) as HTMLInputElement
    fireEvent.change(box, { target: { value: 'agent-hand' } })
    expect(box.value).toBe('agent-hand')

    fireEvent.click(screen.getByRole('button', { name: '保存子智能体配置' }))
    await waitFor(() => expect(client.puts).toHaveLength(1))
    expect(client.puts[0]!.device).toBe('desk-2')
    expect(client.puts[0]!.agentId).toBe('agent-hand')
  })

  it('⑦d an unreachable candidate source KEEPS the stored value and explains itself in Chinese', async () => {
    const problem = { code: 'device-unavailable', message: 'device "desk-1" is offline, not connected' }
    renderPanel(stubClient(READY, async () => ({ problem })))
    const agent = (await screen.findByLabelText('目标 agent')) as HTMLSelectElement
    // #261's unknown option: the value is still selectable, so the form neither
    // blanks nor forgets it — a failed READ is not a decision to erase anything.
    expect(agent.value).toBe('agent-7')
    expect(agent.selectedOptions[0]?.textContent).toBe('当前值（未知）：agent-7')
    // The CODE is translated; the server's English prose never reaches a Chinese
    // page (it would read as an English sentence in the middle of the form).
    expect(screen.getByText('目标设备当前不可用，请先连接再选择。')).toBeDefined()
    expect(screen.queryByText('device "desk-1" is offline, not connected')).toBeNull()
  })

  it('⑦e asks by DEVICE first, and adds the agent only once that agent is known to be there', async () => {
    // The endpoint refuses an unknown `agentId` with a whole-body problem, so a
    // request carrying a stale one would throw away the very list the operator
    // needs to correct it. The agent list is therefore asked for by device alone.
    const client = stubClient(READY)
    renderPanel(client, DEVICES)
    await screen.findByRole('option', { name: 'Cherry Seven（agent-7）' })
    await waitFor(() => expect(client.targetCalls.some(([, agentId]) => agentId === 'agent-7')).toBe(true))
    const asked = client.targetCalls
    expect(asked[0]).toEqual(['desk-1', undefined])
    // Every call names the same device, and no call ever carries an id the list
    // did not name.
    for (const [device, agentId] of asked) {
      expect(device).toBe('desk-1')
      if (agentId !== undefined) expect(agentId).toBe('agent-7')
    }
  })

  it('⑦g a device change never shows the PREVIOUS device’s agents while the new list loads', async () => {
    // The keyed-staleness rule, tested where it matters: "keep the old list while
    // the new one loads" is safe only within ONE key. Across keys it is the
    // cross-device mistake — desk-2's form offering desk-1's agents, one save
    // away from writing A's target into B's document.
    let release: (answer: SubagentTargetsResponse) => void = () => {}
    const client = stubClient(READY, (device) =>
      device === 'desk-1'
        ? Promise.resolve(CANDIDATES)
        : new Promise<SubagentTargetsResponse>((resolve) => {
            release = resolve
          }),
    )
    renderPanel(client, DEVICES)
    await screen.findByRole('option', { name: 'Cherry Seven（agent-7）' })

    fireEvent.change(screen.getByLabelText('目标设备'), { target: { value: 'desk-2' } })
    expect(screen.queryByRole('option', { name: 'Cherry Seven（agent-7）' })).toBeNull()
    expect(screen.getByText('正在读取可选目标…')).toBeDefined()

    release({ agents: [{ agentId: 'agent-b', name: 'Only B' }] })
    await screen.findByRole('option', { name: 'Only B（agent-b）' })
    // …and the OLD device's agent never comes back.
    expect(screen.queryByRole('option', { name: 'Cherry Seven（agent-7）' })).toBeNull()
  })

  it('⑦h a HAND-TYPED agent invalidates the workspace too, so no save mixes the two', async () => {
    // The half the stored-copy version got wrong: a remembered "chosen agent"
    // is not updated by the manual box, so the workspace list kept offering the
    // PREVIOUS agent's workspaces and a save sent the new agent with the old
    // workspace. Derived, the two move together.
    const client = stubClient(READY)
    renderPanel(client)
    const agent = (await screen.findByLabelText('目标 agent')) as HTMLSelectElement
    fireEvent.change(agent, { target: { value: MANUAL_TARGET_VALUE } })
    fireEvent.change((await screen.findByLabelText('agent id')) as HTMLInputElement, {
      target: { value: 'agent-9' },
    })
    const workspace = (await screen.findByLabelText('工作区 id')) as HTMLSelectElement
    expect(workspace.value).toBe('')
    expect(screen.getByText('agent 已更换，工作区已清空，请重新选择。')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '保存子智能体配置' }))
    await waitFor(() => expect(client.puts).toHaveLength(1))
    expect(client.puts[0]!.agentId).toBe('agent-9')
    // The OLD agent's workspace must not ride along.
    expect(client.puts[0]!.workspaceId).toBe('')
  })

  it('⑦i a thrown candidate call becomes a sentence, not a crash', async () => {
    // The endpoint answers its refusals IN BAND, so anything that THROWS is
    // off-contract: a wedged transport, or a 4xx this page caused. Both land on
    // the same synthetic problem.
    renderPanel(stubClient(READY, async () => Promise.reject(new Error('socket died'))))
    expect(await screen.findByText('取不到可选目标（client-error），可以继续手工填写。')).toBeDefined()
    // …and the stored value survives the failure.
    const agent = screen.getByLabelText('目标 agent') as HTMLSelectElement
    expect(agent.value).toBe('agent-7')
  })

  it('⑦j a nameless candidate shows its id alone, and a long id is clipped in the DISPLAY only', async () => {
    const longId = 'agent-id-that-is-far-too-long-to-show-in-a-drop-down'
    renderPanel(
      stubClient(READY, async () => ({
        agents: [{ agentId: 'agent-nameless' }, { agentId: longId, name: 'Long One' }],
      })),
    )
    // No name: the id is the whole label. The endpoint's own contract is that the
    // page falls back to the id rather than showing an empty row.
    expect(await screen.findByRole('option', { name: 'agent-nameless' })).toBeDefined()
    const clipped = screen.getByRole('option', { name: /^Long One（agent-id-that-is-far-too-lo…）$/ })
    // The DISPLAY is clipped; the value is the whole id, which is what a save sends.
    expect((clipped as HTMLOptionElement).value).toBe(longId)
  })

  it('⑦f `unsupported` disables the drop-downs with the rest of the form', async () => {
    const client = stubClient(
      withStatus('unsupported', { code: 'unsupported' }),
    )
    renderPanel(client, DEVICES)
    const device = (await screen.findByLabelText('目标设备')) as HTMLSelectElement
    const agent = (await screen.findByLabelText('目标 agent')) as HTMLSelectElement
    expect(device.disabled).toBe(true)
    expect(agent.disabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ⑧ the system workspace, when the peer has none (#263)
// ---------------------------------------------------------------------------

describe('⑧ the system workspace radio tells the truth about the peer', () => {
  it('⑧a `systemWorkspace: false` disables the radio and says why', async () => {
    // The failure this prevents: the radio is choosable, `resolveSubagentConfig`
    // says `ready`, the save succeeds, the restart reports ready — and the FIRST
    // real delegation dies in `agent.sessions.create`. Same shape as #246: the
    // failure point is pushed somewhere the operator is not looking.
    renderPanel(stubClient(READY, async () => ({ agents: CANDIDATES.agents as never, workspaces: [], systemWorkspace: false })))
    const radio = (await screen.findByLabelText('系统工作区')) as HTMLInputElement
    expect(radio.disabled).toBe(true)
    expect(screen.getByText('这台桌面不支持系统工作区，请选一个已注册的工作区。')).toBeDefined()
    // Saving is NOT blocked: an offline device cannot be judged, and a refusal to
    // save would lose the operator's edit for a fact this page may not have.
    expect((screen.getByRole('button', { name: '保存子智能体配置' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('⑧b `systemWorkspace: true` leaves the radio usable', async () => {
    renderPanel(stubClient(READY, async () => ({ agents: CANDIDATES.agents as never, workspaces: [], systemWorkspace: true })))
    const radio = (await screen.findByLabelText('系统工作区')) as HTMLInputElement
    expect(radio.disabled).toBe(false)
    expect(screen.queryByText('这台桌面不支持系统工作区，请选一个已注册的工作区。')).toBeNull()
  })

  it('⑧c a candidate source that cannot be READ does not pretend to know', async () => {
    // "Unknown" is not "unsupported". Disabling here would be the panel inventing
    // a fact from a failed request — and an offline desktop must still be
    // configurable (the data-preservation rule #261 sets).
    renderPanel(stubClient(READY, async () => ({ problem: { code: 'device-unavailable', message: 'offline' } })))
    const radio = (await screen.findByLabelText('系统工作区')) as HTMLInputElement
    expect(radio.disabled).toBe(false)
    expect(screen.queryByText('这台桌面不支持系统工作区，请选一个已注册的工作区。')).toBeNull()
  })

  it('⑧e a workspace walk that FAILS leaves the radio usable — unknown is not unsupported', async () => {
    // The agents walk succeeds and the workspace walk does not: the panel knows
    // which agents exist and NOTHING about their catalogs. Treating that as
    // "no system workspace" would disable a control on a fact nobody established.
    renderPanel(
      stubClient(READY, async (_device, agentId) =>
        agentId === undefined
          ? { agents: CANDIDATES.agents as never }
          : { problem: { code: 'peer-timeout', message: 'the peer did not answer' } },
      ),
    )
    const radio = (await screen.findByLabelText('系统工作区')) as HTMLInputElement
    expect(radio.disabled).toBe(false)
    expect(screen.queryByText('这台桌面不支持系统工作区，请选一个已注册的工作区。')).toBeNull()
  })

  it('⑧d a STORED system workspace on a peer without one is shown as the contradiction it is', async () => {
    const stored: SubagentResponse = {
      ...READY,
      subagent: { ...READY.subagent, workspaceKind: 'system', workspaceId: undefined },
    }
    const client = stubClient(stored, async () => ({ agents: CANDIDATES.agents as never, workspaces: [], systemWorkspace: false }))
    renderPanel(client)
    expect(
      await screen.findByText('当前保存的是系统工作区，但这台桌面不支持它；委派会失败。'),
    ).toBeDefined()
    // The value is SHOWN, never silently rewritten: the operator chose it, and a
    // page that quietly changed it would be editing a document they did not ask
    // to edit.
    expect((screen.getByLabelText('系统工作区') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '保存子智能体配置' }))
    await waitFor(() => expect(client.puts).toHaveLength(1))
    expect(client.puts[0]!.workspaceKind).toBe('system')
  })
})
