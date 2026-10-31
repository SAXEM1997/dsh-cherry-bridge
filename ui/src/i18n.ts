/**
 * The plugin settings page's OWN localization: two flat dictionaries, a
 * translator, and a module-level locale store.
 *
 * This module is the single source of truth for every user-visible string the
 * page renders. It knows nothing about the host, and deliberately so:
 *
 *  - **It never reads `navigator` at module load.** The store opens in `zh` —
 *    the page's historical language — so a component rendered by a test (or by
 *    a host that never wired localization) sees the same Chinese it always did.
 *    Reading the browser's language is `apply()`'s job, through the PURE
 *    {@link resolveLocaleFromNavigator}, which is why the existing ~140 Chinese
 *    assertions in `tests/unit/ui.test.ts` keep passing untouched.
 *  - **It is the only place Chinese literals live** in `ui/src/**`
 *    (`tests/unit/i18nAssets.test.ts` guards that by scanning every source
 *    file). `types.ts`'s `STAGE_LABELS`/`STATE_LABELS` are now re-exports of
 *    {@link dictionaries}`.zh`, not second copies.
 *
 * ## Key conventions
 *
 * Flat, dot-separated, prefixed by domain (`app.` / `device.` / `wizard.` /
 * `scope.` / `list.`); no natural language in the key itself. A sentence is ONE
 * key with `{name}` placeholders — never a prefix/suffix pair glued together in
 * JSX — so the English half can reorder the sentence freely. The one list
 * separator is a key of its own (`list.separator`) so a joined list reads
 * correctly in both languages.
 *
 * ## The `t` contract (matches the host's own `translate`)
 *
 * Placeholders are replaced by the global regex `/\{(\w+)\}/g`; a param that was
 * NOT supplied leaves the literal `{name}` standing rather than rendering
 * `undefined` or throwing, and a missing key returns the KEY itself. Both make a
 * gap loud and visible in the UI instead of catastrophic — and the host's
 * dictionary does exactly the same, so a key that works here works there.
 */
import { useMemo, useSyncExternalStore } from 'react'

/** The two languages this page ships. */
export type LocaleId = 'zh' | 'en'

/** One flat dictionary: dot-separated key to template string. */
export type Dict = Record<string, string>

/** Translate `key`, substituting any `{name}` placeholders present in `params`. */
export type T = (key: string, params?: Record<string, string | number>) => string

/** Dictionary order of {@link dictionaries}; also the order of a language list. */
export const LOCALE_IDS: readonly LocaleId[] = ['zh', 'en']

/**
 * The Chinese dictionary — the ORIGINAL wording, copied verbatim from the
 * components as they stood before localization.
 *
 * Verbatim is a requirement, not a courtesy: `tests/unit/ui.test.ts` asserts
 * these sentences as they appear on screen, and `STAGE_LABELS`/`STATE_LABELS`
 * re-export five and ten of them. Editing a value here changes the Chinese UI.
 */
const zh: Dict = {
  // -- app shell ------------------------------------------------------------
  'app.title': 'Cherry 互联',
  'app.subtitle':
    '通过远程传输把本机 DeepSeek Harness 连接到 Cherry Studio 桌面端；设备档案保存在插件数据目录，页面不接触任何凭据。',
  // The one string that used to reach a Chinese page in English (App.tsx's
  // stream opener); adopted as a key so the English half is unchanged and the
  // Chinese half finally exists.
  'app.eventSourceUnavailable': '此环境不支持 EventSource',
  'app.devices.heading': '已配对设备',
  'app.devices.empty': '暂无已配对设备，使用上方向导完成首次配对。',
  'app.devices.loading': '正在读取设备列表…',

  // -- device card ----------------------------------------------------------
  'device.state.connected': '已连接',
  'device.state.connecting': '连接中',
  'device.state.offline': '离线',
  'device.state.disabled': '已停用',
  'device.state.identity-mismatch': '身份不匹配',
  'device.state.unknown': '状态未知',
  'device.disable': '停用',
  'device.enable': '启用',
  'device.rename': '重命名',
  'device.addresses': '地址维护',
  'device.remove': '移除',
  'device.field.addresses': '地址',
  'device.field.port': '端口',
  'device.field.id': '设备 ID',
  'device.field.name': '设备名称',
  'device.field.hosts': '主机地址',
  'device.hosts.hint': '多个候选地址用逗号分隔（整体替换）',
  'device.field.ports': '每地址端口',
  'device.ports.hint': '部分候选地址的端口与上方的端口不同；在「地址维护」里改动端口会把所有候选地址改为同一端口。',
  'device.ports.current': '当前端口映射：',
  'device.port.hint': '保持当前值会保留各地址自己的端口；改成新值会把所有候选地址重指到该端口。',
  'device.save.name': '保存名称',
  'device.save.addresses': '保存地址',
  'device.remove.confirm': '确认移除',
  'device.remove.warning': '移除后本机将不再连接该设备，凭据保留在对方一侧。',
  'device.cancel': '取消',
  'device.error.nameRequired': '设备名称不能为空',
  'device.error.hostsRequired': '至少需要一个主机地址',
  'device.error.portInvalid': '端口必须是 1..65535 之间的整数',

  // -- pairing wizard -------------------------------------------------------
  'wizard.heading': '配对向导',
  // Split around the `<strong>` in the hint on purpose: the emphasized words are
  // the instruction, and `dangerouslySetInnerHTML` is not an option. The render
  // is `{t('wizard.hint.before')} <strong>{t('wizard.hint.qrCode')}</strong>
  // {t('wizard.hint.after')}` — ONE literal JSX space before `<strong>`, and
  // nothing but the values themselves after `</strong>`. So `before` ends bare
  // (the JSX space supplies the gap) while `after` opens flush with its own
  // punctuation: `。` in Chinese, `.` in English, each followed by one space.
  // That is why the whitespace rule must not be read as "no internal space" —
  // no value here carries LEADING or TRAILING whitespace.
  'wizard.hint.before': '在 Cherry Studio 桌面端打开「远程连接 → 添加设备」；该界面显示的是',
  'wizard.hint.qrCode': '二维码',
  'wizard.hint.after': '。 请用微信或浏览器等扫码，把扫码后页面上显示的配对信息复制下来，粘贴到下方。',
  'wizard.step.open': 'Cherry Studio 中打开「添加设备」，屏幕上显示二维码',
  'wizard.step.scan': '用微信或浏览器等扫码，复制扫码页显示的配对信息（含地址、端口与一次性邀请）',
  'wizard.step.paste': '粘贴到下方输入框并开始配对，再对照桌面端窗口上的 6 位验证码确认',
  'wizard.payload.label': '配对信息',
  'wizard.payload.placeholder': '粘贴扫码后页面上显示的配对信息',
  'wizard.submit': '开始配对',
  'wizard.streamPending': '正在建立事件流，稍候即可开始配对…',
  'wizard.running': '配对进行中',
  'wizard.submitted': '已提交配对请求…',
  'wizard.code.check': '请在 Cherry Studio 上核对验证码',
  'wizard.succeeded': '配对成功',
  // One sentence, `{stage}` carrying the already-translated verdict: the English
  // half is free to reorder, and the existing `配对失败：{guidance}` assertions
  // keep matching.
  'wizard.failed': '配对失败：{stage}',
  'wizard.unknownError': '未知错误',
  // NO VERDICT WORDING. This is the run deadline, not a stage: the pairing may
  // have been approved while its frame was lost, so it points at the list right
  // below (which the settle refreshes) instead of asserting an outcome.
  // The page-wide request ceiling (`api.ts`): the device list gave up waiting.
  'app.error.timeout': '请求长时间没有回应，已中止——请确认宿主仍在运行；若反复出现，请重启宿主后再试',
  'wizard.timedOut':
    '没有等到配对结果——若桌面端已批准，下面的设备列表里会出现该设备；否则请在 Cherry Studio 重新生成配对码后重试',
  'wizard.error.payloadRequired': '请先粘贴扫码页显示的配对信息',
  // The pairing POST never answered. Names the LIKELY cause (a wedged host) and
  // nothing about pairing itself, so the user does not go re-scanning a QR code.
  'wizard.error.timeout': '配对请求迟迟没有回应，已中止——请重试；若反复出现，宿主可能已卡住，重启后再试',
  // The stages the wizard narrates while a run is in flight.
  'wizard.stage.validate': '正在校验配对信息…',
  'wizard.stage.connect': '正在连接 Cherry Studio…',
  'wizard.stage.claim': '正在交换凭据…',
  'wizard.stage.waiting': '等待在 Cherry Studio 上确认…',
  'wizard.stage.pairing-failed': '配对失败',
  // The failure verdicts carry the RECOVERY step: "被拒绝" alone leaves the user
  // with nothing to do but retry blindly.
  'wizard.stage.rejected': '配对被拒绝——请核对桌面端显示的 6 位验证码是否与本页一致，并在 Cherry Studio 重新生成配对码后重试',
  'wizard.stage.expired': '配对邀请已过期——请在 Cherry Studio 重新生成配对码后重试',
  'wizard.stage.unreachable': '无法连接 Cherry Studio，请确认桌面端已启动且与本机同网',
  'wizard.stage.invalid-payload': '配对信息无效或已过期，请在 Cherry Studio 重新生成后重试',
  'wizard.stage.archive-quarantined':
    '设备档案无法读取（已保留为 .corrupt 副本）。请将该文件移开后重启或重新加载插件，再重试配对',

  // -- tool scope panel -----------------------------------------------------
  'scope.heading': '启用范围',
  'scope.loadError': '读取启用范围失败：{error}',
  'scope.loading': '正在读取启用范围…',
  'scope.unsupported': '宿主不支持工具作用域能力（只读告警）：{reason}。请升级宿主 / DSH 以获得该能力后再试；升级前本插件不会注册这些工具。',
  'scope.versionDegraded':
    '作用域文档版本与本插件支持的不一致（高于或低于皆同一条守卫）：文档版本高于本插件支持、或低于本插件支持，已进入只读降级，保存被禁用。重读仍是同一份文档，请升级宿主 / DSH 或本插件后再试。',
  'scope.listUnavailable': '注册表列表当前读不到，已禁用保存（原因见下方降级标注）。',
  'scope.pending': '宿主服务挂载中，稍后自动就绪；此期间的配对与设备管理照常可用。',
  // One line per degradation note: `{label}` is the translated source label and
  // `{reason}` is the server's own prose, passed through untranslated.
  'scope.degradedLine': '{label}：{reason}',
  'scope.mode.legend': '模式',
  'scope.mode.global': '全局',
  'scope.mode.selected': '仅选定工作区',
  'scope.effectNote':
    '生效范围内本插件未遮蔽这些 cherry_* 工具；上游的 allow 型过滤（例如子代理的 toolFilter）仍可能让某个会话看不到它们——本页只说明本插件未遮蔽，不对上层过滤的结果作保证。',
  'scope.noWorkspaces': '当前没有任何已注册的工作区。',
  'scope.workspaceUnknown': '（注册表里没有该工作区的信息）',
  'scope.empty.selected':
    '尚未启用任何工作区——此状态下 cherry_* 工具不会出现在任何会话里；勾选后对应工作区的会话（含进行中的）即可使用。',
  'scope.empty.global':
    '当前为全局模式：这些工具在所有工作区都可用；下面的勾选仅在切到「仅选定工作区」后才生效。',
  'scope.stale.heading': '已失效（工作区已删除）',
  'scope.stale.note': '这些 id 在注册表里已不存在；保存时由服务端修剪，不会被判为非法输入。',
  'scope.stale.clear': '清除已失效选择',
  'scope.unmatched.heading': '已勾选但会话 cwd 对不上',
  'scope.unmatched.note':
    '这些会话勾选了工作区却拿不到工具：拼写不同 / 符号链接 / 该目录确实未注册，这三种原因在这里无法区分。本条只解释原因，不改动勾选或模式，也不会触发保存。',
  'scope.save': '保存启用范围',
  'scope.revision': '当前 revision：{revision}',
  'scope.saved': '保存成功。',
  'scope.savedPruned': '保存成功，按服务端修剪清除了失效选择：{list}。',
  'scope.reread': '重新读取',
  // A refusal whose code this panel has no copy for: the server's own message is
  // the best available explanation, so it is interpolated verbatim.
  'scope.saveFailed': '保存失败：{cause}',
  // The page-wide request ceiling (`api.ts`), rendered where the server's own
  // message would go: there is no server message when nothing answered.
  'scope.error.timeout': '请求长时间没有回应，已中止——请稍后重试',
  'scope.serverSaid': '服务端返回 {code}（HTTP {status}）。',
  'scope.degraded.install': '隐藏层应用曾失败（install）：相关 agent 的隐藏层未生效或无法确认，启用范围对它可能不适用',
  'scope.degraded.workspace-list': '注册表列表当前读不到',
  'scope.degraded.visibility-only':
    '仅可见性降级（缺 tools.guard）：restrict 仍在装配层移除这 14 个工具，但执行侧没有任何一层拒绝它们的调用（不是渲染层假过滤）；连 restrict 都装不上的 agent 则既隐藏不了、也无人拒绝',
  'scope.degraded.scope-version': '作用域文档版本与本插件支持的不一致（高于或低于皆同一条守卫）',
  'scope.degraded.path-normalization': '路径规范化降级：cwd 比对可能不准确',
  'scope.saveFailure.scope-revision-conflict': '配置已被他处修改，请重新读取后再保存。',
  'scope.saveFailure.scope-version-unsupported':
    '作用域文档版本与本插件支持的不一致（高于或低于皆同一条守卫），文档版本高于本插件支持、或低于本插件支持：重读不会改变文档版本，请升级宿主 / DSH 或本插件后再试。',
  'scope.saveFailure.invalid-scope':
    '保存被拒绝：作用域字段非法（mode 必须是 global 或 selected，workspaceIds 必须是字符串数组）。',
  'scope.saveFailure.missing-expected-revision': '保存被拒绝：请求缺少基准 expectedRevision，请重新读取后再保存。',
  'scope.saveFailure.workspace-list-unavailable': '工作区列表当前读不到，无法保存；已存勾选与 mode 一位不动。',

  // -- shared -------------------------------------------------------------
  // The ONE deliberate whitespace exception: a list separator carries the space
  // that a joined sentence needs (English "a, b" vs Chinese "a、b"). It is
  // whitelisted explicitly in `tests/unit/i18n.test.ts`.
  'list.separator': '、',
}

/**
 * The English dictionary — written to the plugin's English voice: plain,
 * declarative, second-person imperative; no exclamation marks. Technical tokens
 * (`cherry_*`, `tools.guard`, `install`, `revision`, `cwd`, `DSH`,
 * `EventSource`, `Cherry Studio`, …) keep their exact spelling, and interpolated
 * DATA — file paths, workspace names, revision numbers, error codes — is passed
 * through untranslated because translating it would make it unverifiable.
 */
const en: Dict = {
  // -- app shell ------------------------------------------------------------
  'app.title': 'Cherry Bridge',
  'app.subtitle':
    'Connect this machine’s DeepSeek Harness to a Cherry Studio desktop over the remote transport. Device records live in the plugin data directory; this page never touches a credential.',
  'app.eventSourceUnavailable': 'EventSource is unavailable in this environment',
  'app.devices.heading': 'Paired devices',
  'app.devices.empty': 'No paired devices yet. Use the wizard above to pair your first one.',
  'app.devices.loading': 'Reading the device list…',

  // -- device card ----------------------------------------------------------
  'device.state.connected': 'Connected',
  'device.state.connecting': 'Connecting',
  'device.state.offline': 'Offline',
  'device.state.disabled': 'Disabled',
  'device.state.identity-mismatch': 'Identity mismatch',
  'device.state.unknown': 'Unknown status',
  'device.disable': 'Disable',
  'device.enable': 'Enable',
  'device.rename': 'Rename',
  'device.addresses': 'Addresses',
  'device.remove': 'Remove',
  'device.field.addresses': 'Addresses',
  'device.field.port': 'Port',
  'device.field.id': 'Device ID',
  'device.field.name': 'Device name',
  'device.field.hosts': 'Host addresses',
  'device.hosts.hint': 'Separate candidate addresses with commas (the whole list is replaced)',
  'device.field.ports': 'Ports per address',
  'device.ports.hint':
    'Some candidate addresses dial a different port than the one above; changing the port in address maintenance moves every candidate address to that one port.',
  'device.ports.current': 'Current port map:',
  'device.port.hint':
    'Keeping the current value preserves each address’s own port; a new value re-points every candidate address.',
  'device.save.name': 'Save name',
  'device.save.addresses': 'Save addresses',
  'device.remove.confirm': 'Confirm removal',
  'device.remove.warning': 'This machine will stop connecting to the device. Its credentials stay on the peer.',
  'device.cancel': 'Cancel',
  'device.error.nameRequired': 'Device name cannot be empty',
  'device.error.hostsRequired': 'At least one host address is required',
  'device.error.portInvalid': 'Port must be an integer between 1 and 65535',

  // -- pairing wizard -------------------------------------------------------
  'wizard.heading': 'Pairing wizard',
  // Rendered as `…shows a <strong>QR code</strong>. Scan it with…`: the JSX
  // space before `<strong>` separates `before` from the emphasized words, and
  // `after` starts with the sentence's own `. ` flush against `</strong>`.
  'wizard.hint.before': 'In the Cherry Studio desktop, open “Remote connection → Add device”; that screen shows a',
  'wizard.hint.qrCode': 'QR code',
  'wizard.hint.after':
    '. Scan it with WeChat or a browser, then copy the pairing payload that page displays and paste it below.',
  'wizard.step.open': 'Open “Add device” in Cherry Studio; a QR code appears on screen',
  'wizard.step.scan': 'Scan it with WeChat or a browser and copy the pairing payload (address, port and one-time invite)',
  'wizard.step.paste': 'Paste it below and start pairing, then compare the 6-digit verification code shown in the desktop window',
  'wizard.payload.label': 'Pairing payload',
  'wizard.payload.placeholder': 'Paste the pairing payload shown on the page the QR code points at',
  'wizard.submit': 'Start pairing',
  'wizard.streamPending': 'Opening the event stream. Pairing is available in a moment…',
  'wizard.running': 'Pairing in progress',
  'wizard.submitted': 'Pairing request submitted…',
  'wizard.code.check': 'Compare the verification code in Cherry Studio',
  'wizard.succeeded': 'Paired',
  'wizard.failed': 'Pairing failed: {stage}',
  'wizard.unknownError': 'Unknown error',
  // See the zh entry: the run deadline is not a verdict.
  // See the zh entry: the page-wide request ceiling.
  'app.error.timeout': 'The request stopped answering and was abandoned. Check that the host is still running; if it keeps happening, restart it and try again.',
  'wizard.timedOut':
    'No pairing result arrived. If the desktop approved it, the device appears in the list below; otherwise generate a new pairing code in Cherry Studio and try again.',
  'wizard.error.payloadRequired': 'Paste the pairing payload shown on the scan page first',
  // See the zh entry: the cause is the host, not the payload.
  'wizard.error.timeout': 'The pairing request stopped answering and was abandoned. Try again; if it keeps happening the host may be stuck — restart it and retry.',
  'wizard.stage.validate': 'Validating the pairing payload…',
  'wizard.stage.connect': 'Connecting to Cherry Studio…',
  'wizard.stage.claim': 'Exchanging credentials…',
  'wizard.stage.waiting': 'Waiting for confirmation in Cherry Studio…',
  'wizard.stage.pairing-failed': 'Pairing failed',
  'wizard.stage.rejected':
    'Pairing was rejected. Check that the 6-digit verification code shown in the desktop matches this page, then generate a new pairing code in Cherry Studio and try again.',
  'wizard.stage.expired': 'The pairing invite expired. Generate a new pairing code in Cherry Studio and try again.',
  'wizard.stage.unreachable':
    'Cannot reach Cherry Studio. Make sure the desktop is running and on the same network as this machine.',
  'wizard.stage.invalid-payload':
    'The pairing payload is invalid or expired. Generate a new one in Cherry Studio and try again.',
  'wizard.stage.archive-quarantined':
    'The device archive cannot be read (it was kept as a .corrupt copy). Move that file aside, restart or reload the plugin, then pair again.',

  // -- tool scope panel -----------------------------------------------------
  'scope.heading': 'Tool scope',
  'scope.loadError': 'Failed to read the tool scope: {error}',
  'scope.loading': 'Reading the tool scope…',
  'scope.unsupported':
    'The host does not support tool scoping (read-only warning): {reason}. Upgrade the host / DSH to use it; until then this plugin registers none of these tools.',
  'scope.versionDegraded':
    'The scope document version does not match the one this plugin supports (the same guard covers newer and older versions). The document is either newer or older than this plugin supports, so the panel is read-only and saving is disabled. Re-reading returns the same document; upgrade the host / DSH or this plugin and try again.',
  'scope.listUnavailable': 'The workspace registry list is unreadable, so saving is disabled (see the note below).',
  'scope.pending': 'The host service is still mounting and will be ready shortly. Pairing and device management keep working meanwhile.',
  'scope.degradedLine': '{label}: {reason}',
  'scope.mode.legend': 'Mode',
  'scope.mode.global': 'Global',
  'scope.mode.selected': 'Selected workspaces only',
  'scope.effectNote':
    'Within the effective scope this plugin does not shadow these cherry_* tools. An upstream allow-shaped filter (a sub-agent’s toolFilter, for example) can still keep them out of a session — this page only states that this plugin does not shadow them, and makes no promise about upstream filtering.',
  'scope.noWorkspaces': 'No workspaces are registered.',
  'scope.workspaceUnknown': '(the registry has no information about this workspace)',
  'scope.empty.selected':
    'No workspace is enabled — while that holds, the cherry_* tools appear in no session at all. Tick one and its sessions (including running ones) can use them.',
  'scope.empty.global':
    'Global mode: these tools are available in every workspace. The ticks below take effect only after you switch to “Selected workspaces only”.',
  'scope.stale.heading': 'Stale (workspace deleted)',
  'scope.stale.note': 'These ids are no longer in the registry. Saving prunes them server-side; they are not judged invalid input.',
  'scope.stale.clear': 'Clear stale selections',
  'scope.unmatched.heading': 'Selected, but the session cwd does not match',
  'scope.unmatched.note':
    'These sessions ticked a workspace but get no tools: a spelling difference, a symlink, or a directory that genuinely is not registered — this page cannot tell the three apart. This note only explains the cause; it changes neither your ticks nor the mode, and triggers no save.',
  'scope.save': 'Save scope',
  'scope.revision': 'Current revision: {revision}',
  'scope.saved': 'Saved.',
  'scope.savedPruned': 'Saved. The server pruned these stale selections: {list}.',
  'scope.reread': 'Reload',
  'scope.saveFailed': 'Save failed: {cause}',
  'scope.error.timeout': 'The request stopped answering and was abandoned. Try again in a moment.',
  'scope.serverSaid': 'The server answered {code} (HTTP {status}).',
  'scope.degraded.install':
    'Applying a hidden layer failed earlier (install): the affected agent’s hidden layer is not in effect or cannot be confirmed, so the tool scope may not apply to it',
  'scope.degraded.workspace-list': 'The workspace registry list is currently unreadable',
  'scope.degraded.visibility-only':
    'Visibility-only degradation (tools.guard is missing): restrict still removes these 14 tools at the assembly layer, but nothing on the execution side refuses a call to them (this is not a render-layer fake filter). An agent that cannot install restrict at all both fails to hide them and has nothing to refuse them',
  'scope.degraded.scope-version': 'The scope document version does not match the one this plugin supports (one guard covers newer and older)',
  'scope.degraded.path-normalization': 'Path normalization degraded: the cwd comparison may be inaccurate',
  'scope.saveFailure.scope-revision-conflict': 'The configuration changed elsewhere. Reload before saving again.',
  'scope.saveFailure.scope-version-unsupported':
    'The scope document version does not match the one this plugin supports (the same guard covers newer and older). Re-reading cannot change the document version — upgrade the host / DSH or this plugin and try again.',
  'scope.saveFailure.invalid-scope':
    'Save refused: an illegal scope field (mode must be global or selected, workspaceIds must be an array of strings).',
  'scope.saveFailure.missing-expected-revision':
    'Save refused: the request carries no base expectedRevision. Reload before saving again.',
  'scope.saveFailure.workspace-list-unavailable':
    'The workspace list is unreadable, so it cannot be saved. The stored ticks and mode are left untouched.',

  // -- shared -------------------------------------------------------------
  'list.separator': ', ',
}

/**
 * The two dictionaries, keyed by locale.
 *
 * `en` is declared AFTER `zh` purely so reading order matches `LOCALE_IDS`.
 */
export const dictionaries: Record<LocaleId, Dict> = { zh, en }

/**
 * Binds `locale` to a translator.
 *
 * The returned function reads the DICTIONARY it closed over, so it stays valid
 * across a language change only as long as the caller re-binds (which
 * {@link useT} does on every store change). It never throws: an unknown key and
 * an unsupplied param both survive as literal text.
 */
export function createTranslator(locale: LocaleId): T {
  const dict = dictionaries[locale]
  return (key, params) => {
    const template = dict[key]
    // A miss returns the key: visible, greppable, and impossible to mistake for
    // copy — the same rule the host's dictionary follows for the same reason.
    if (template === undefined) return key
    // No params ⇒ no substitution pass at all, so a template that merely LOOKS
    // like a placeholder (a literal `{` in prose) is returned untouched.
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    )
  }
}

/**
 * The language a bare `navigator.language` implies.
 *
 * A PURE function: it reads no global, so the single guarded navigator read
 * lives in `apply()` (`typeof navigator === 'undefined' ? undefined :
 * navigator.language`) — a VM sandbox has no `navigator` at all, and a stray
 * read there would throw before the page could register.
 *
 * The boundary: a `zh` prefix, case-insensitively, is Chinese; EVERY other named
 * language (English included) is English; and "cannot tell" — `undefined` or an
 * empty string — is Chinese, the page's historical default.
 */
export function resolveLocaleFromNavigator(language?: string): LocaleId {
  const tag = (language ?? '').trim().toLowerCase()
  if (tag === '') return 'zh'
  return tag.startsWith('zh') ? 'zh' : 'en'
}

/**
 * The page's locale, as an external store (`useSyncExternalStore`-shaped).
 *
 * `getSnapshot()` hands back the SAME object until the language actually
 * changes: React compares snapshots by identity, so allocating a fresh object
 * per read would re-render every subscribed component in an endless loop. The
 * snapshot is frozen because it is shared.
 *
 * `setLocale` is a no-op for the current language — a host that re-announces the
 * active locale (registration bumps its revision too) must not churn the tree.
 */
let snapshot: { locale: LocaleId } = Object.freeze({ locale: 'zh' })
const listeners = new Set<() => void>()

/**
 * The module-level locale store every component reads through {@link useT}.
 *
 * A module-level singleton rather than a React context: the host may change the
 * language at any time and every mounted component must follow it without being
 * re-mounted, which is exactly what an external store provides.
 */
export const localeStore = {
  getSnapshot(): { locale: LocaleId } {
    return snapshot
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  setLocale(locale: LocaleId): void {
    if (locale === snapshot.locale) return
    snapshot = Object.freeze({ locale })
    // Iterate a copy: a listener may unsubscribe (or subscribe) in response, and
    // mutating the set mid-iteration would skip or double-visit entries.
    for (const listener of [...listeners]) listener()
  },
}

/**
 * The translator for the CURRENT language, re-rendering the caller on a switch.
 *
 * The translator is MEMOIZED on the locale, so its identity is stable across
 * renders that do not change the language: a consumer may put `t` in a
 * dependency array (or a `useMemo`/`useCallback` list) without re-running on
 * every render. `localeStore.getSnapshot()` already returns a stable frozen
 * object per locale, so `current.locale` is the right memo key.
 */
export function useT(): T {
  const current = useSyncExternalStore(localeStore.subscribe, localeStore.getSnapshot)
  return useMemo(() => createTranslator(current.locale), [current.locale])
}
