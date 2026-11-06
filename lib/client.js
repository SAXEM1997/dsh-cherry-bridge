window.__ModuleLoader__.load({
	id: "dsh-cherry-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		/**
		* The two dictionaries, keyed by locale.
		*
		* `en` is declared AFTER `zh` purely so reading order matches `LOCALE_IDS`.
		*/
		var dictionaries = {
			zh: {
				"app.title": "Cherry 互联",
				"app.subtitle": "通过远程传输把本机 DeepSeek Harness 连接到 Cherry Studio 桌面端；设备档案保存在插件数据目录，页面不接触任何凭据。",
				"app.eventSourceUnavailable": "此环境不支持 EventSource",
				"app.devices.heading": "已配对设备",
				"app.devices.empty": "暂无已配对设备，使用上方向导完成首次配对。",
				"app.devices.loading": "正在读取设备列表…",
				"device.state.connected": "已连接",
				"device.state.connecting": "连接中",
				"device.state.offline": "离线",
				"device.state.disabled": "已停用",
				"device.state.identity-mismatch": "身份不匹配",
				"device.state.unknown": "状态未知",
				"device.disable": "停用",
				"device.enable": "启用",
				"device.rename": "重命名",
				"device.addresses": "地址维护",
				"device.remove": "移除",
				"device.field.addresses": "地址",
				"device.field.port": "端口",
				"device.field.id": "设备 ID",
				"device.field.name": "设备名称",
				"device.field.hosts": "主机地址",
				"device.hosts.hint": "多个候选地址用逗号分隔（整体替换）",
				"device.field.ports": "每地址端口",
				"device.ports.hint": "部分候选地址的端口与上方的端口不同；在「地址维护」里改动端口会把所有候选地址改为同一端口。",
				"device.ports.current": "当前端口映射：",
				"device.port.hint": "保持当前值会保留各地址自己的端口；改成新值会把所有候选地址重指到该端口。",
				"device.save.name": "保存名称",
				"device.save.addresses": "保存地址",
				"device.remove.confirm": "确认移除",
				"device.remove.warning": "移除后本机将不再连接该设备，凭据保留在对方一侧。",
				"device.cancel": "取消",
				"device.forget": "忘记",
				"device.remember": "恢复",
				"device.field.forgotten": "已忘记地址",
				"device.forgotten.hint": "已忘记的地址不会再被连接；「恢复」只解除标记，桌面下次广播该地址时会重新加入。",
				"device.error.lastAddress": "不能忘记最后一个候选地址——先补一个地址，再忘记这个",
				"device.error.timeout": "请求长时间没有回应，已中止——请稍后重试",
				"device.error.nameRequired": "设备名称不能为空",
				"device.error.hostsRequired": "至少需要一个主机地址",
				"device.error.portInvalid": "端口必须是 1..65535 之间的整数",
				"wizard.heading": "配对向导",
				"wizard.hint.before": "在 Cherry Studio 桌面端打开「远程连接 → 添加设备」；该界面显示的是",
				"wizard.hint.qrCode": "二维码",
				"wizard.hint.after": "。 请用微信或浏览器等扫码，把扫码后页面上显示的配对信息复制下来，粘贴到下方。",
				"wizard.step.open": "Cherry Studio 中打开「添加设备」，屏幕上显示二维码",
				"wizard.step.scan": "用微信或浏览器等扫码，复制扫码页显示的配对信息（含地址、端口与一次性邀请）",
				"wizard.step.paste": "粘贴到下方输入框并开始配对，再对照桌面端窗口上的 6 位验证码确认",
				"wizard.payload.label": "配对信息",
				"wizard.payload.placeholder": "粘贴扫码后页面上显示的配对信息",
				"wizard.submit": "开始配对",
				"wizard.streamPending": "正在建立事件流，稍候即可开始配对…",
				"wizard.running": "配对进行中",
				"wizard.submitted": "已提交配对请求…",
				"wizard.code.check": "请在 Cherry Studio 上核对验证码",
				"wizard.succeeded": "配对成功",
				"wizard.failed": "配对失败：{stage}",
				"wizard.unknownError": "未知错误",
				"app.error.timeout": "请求长时间没有回应，已中止——请确认宿主仍在运行；若反复出现，请重启宿主后再试",
				"wizard.timedOut": "没有等到配对结果——若桌面端已批准，下面的设备列表里会出现该设备；否则请在 Cherry Studio 重新生成配对码后重试",
				"wizard.error.payloadRequired": "请先粘贴扫码页显示的配对信息",
				"wizard.error.timeout": "配对请求迟迟没有回应，已中止——请重试；若反复出现，宿主可能已卡住，重启后再试",
				"wizard.stage.validate": "正在校验配对信息…",
				"wizard.stage.connect": "正在连接 Cherry Studio…",
				"wizard.stage.claim": "正在交换凭据…",
				"wizard.stage.waiting": "等待在 Cherry Studio 上确认…",
				"wizard.stage.pairing-failed": "配对失败",
				"wizard.stage.rejected": "配对被拒绝——请核对桌面端显示的 6 位验证码是否与本页一致，并在 Cherry Studio 重新生成配对码后重试",
				"wizard.stage.expired": "配对邀请已过期——请在 Cherry Studio 重新生成配对码后重试",
				"wizard.stage.unreachable": "无法连接 Cherry Studio，请确认桌面端已启动且与本机同网",
				"wizard.stage.invalid-payload": "配对信息无效或已过期，请在 Cherry Studio 重新生成后重试",
				"wizard.stage.archive-quarantined": "设备档案无法读取（已保留为 .corrupt 副本）。请将该文件移开后重启或重新加载插件，再重试配对",
				"scope.heading": "启用范围",
				"scope.loadError": "读取启用范围失败：{error}",
				"scope.loading": "正在读取启用范围…",
				"scope.unsupported": "宿主不支持工具作用域能力（只读告警）：{reason}。请升级宿主 / DSH 以获得该能力后再试；升级前本插件的作用域工具不会注册，实验性委托工具另受其步骤级闸门约束。",
				"scope.versionDegraded": "作用域文档版本与本插件支持的不一致（高于或低于皆同一条守卫）：文档版本高于本插件支持、或低于本插件支持，已进入只读降级，保存被禁用。重读仍是同一份文档，请升级宿主 / DSH 或本插件后再试。",
				"scope.listUnavailable": "注册表列表当前读不到，已禁用保存（原因见下方降级标注）。",
				"scope.pending": "宿主服务挂载中，稍后自动就绪；此期间的配对与设备管理照常可用。",
				"scope.degradedLine": "{label}：{reason}",
				"scope.mode.legend": "模式",
				"scope.mode.global": "全局",
				"scope.mode.selected": "仅选定工作区",
				"scope.effectNote": "生效范围内本插件未遮蔽这些 cherry_* 工具；上游的 allow 型过滤（例如子代理的 toolFilter）仍可能让某个会话看不到它们——本页只说明本插件未遮蔽，不对上层过滤的结果作保证。",
				"scope.noWorkspaces": "当前没有任何已注册的工作区。",
				"scope.workspaceUnknown": "（注册表里没有该工作区的信息）",
				"scope.empty.selected": "尚未启用任何工作区——此状态下 cherry_* 工具不会出现在任何会话里；勾选后对应工作区的会话（含进行中的）即可使用。",
				"scope.empty.global": "当前为全局模式：这些工具在所有工作区都可用；下面的勾选仅在切到「仅选定工作区」后才生效。",
				"scope.stale.heading": "已失效（工作区已删除）",
				"scope.stale.note": "这些 id 在注册表里已不存在；保存时由服务端修剪，不会被判为非法输入。",
				"scope.stale.clear": "清除已失效选择",
				"scope.unmatched.heading": "已勾选但会话 cwd 对不上",
				"scope.unmatched.note": "这些会话勾选了工作区却拿不到工具：拼写不同 / 符号链接 / 该目录确实未注册，这三种原因在这里无法区分。本条只解释原因，不改动勾选或模式，也不会触发保存。",
				"scope.save": "保存启用范围",
				"scope.revision": "当前 revision：{revision}",
				"scope.saved": "保存成功。",
				"scope.savedPruned": "保存成功，按服务端修剪清除了失效选择：{list}。",
				"scope.reread": "重新读取",
				"scope.saveFailed": "保存失败：{cause}",
				"scope.error.timeout": "请求长时间没有回应，已中止——请稍后重试",
				"scope.serverSaid": "服务端返回 {code}（HTTP {status}）。",
				"scope.degraded.install": "隐藏层应用曾失败（install）：相关 agent 的隐藏层未生效或无法确认，启用范围对它可能不适用",
				"scope.degraded.workspace-list": "注册表列表当前读不到",
				"scope.degraded.visibility-only": "仅可见性降级（缺 tools.guard）：restrict 仍在装配层移除这 15 个工具，但执行侧没有任何一层拒绝它们的调用（不是渲染层假过滤）；连 restrict 都装不上的 agent 则既隐藏不了、也无人拒绝",
				"scope.degraded.scope-version": "作用域文档版本与本插件支持的不一致（高于或低于皆同一条守卫）",
				"scope.degraded.path-normalization": "路径规范化降级：cwd 比对可能不准确",
				"scope.saveFailure.scope-revision-conflict": "配置已被他处修改，请重新读取后再保存。",
				"scope.saveFailure.scope-version-unsupported": "作用域文档版本与本插件支持的不一致（高于或低于皆同一条守卫），文档版本高于本插件支持、或低于本插件支持：重读不会改变文档版本，请升级宿主 / DSH 或本插件后再试。",
				"scope.saveFailure.invalid-scope": "保存被拒绝：作用域字段非法（mode 必须是 global 或 selected，workspaceIds 必须是字符串数组）。",
				"scope.saveFailure.missing-expected-revision": "保存被拒绝：请求缺少基准 expectedRevision，请重新读取后再保存。",
				"scope.saveFailure.workspace-list-unavailable": "工作区列表当前读不到，无法保存；已存勾选与 mode 一位不动。",
				"subagent.heading": "实验性子智能体",
				"subagent.badge": "实验性",
				"subagent.experimental": "实验性功能：它跨了 DSH 与 Cherry Studio 两个不受本插件控制的系统，接口与行为都可能变。默认关闭。",
				"subagent.defaultOff": "默认关闭。打开需要填写目标设备、agent 与工作区；保存后在重启 DSH 时生效。",
				"subagent.feedback": "欢迎贡献思路和问题反馈：",
				"subagent.feedbackLink": "dsh-cherry-bridge issues",
				"subagent.loading": "正在读取子智能体配置…",
				"subagent.loadError": "读取子智能体配置失败：{error}",
				"subagent.source.config": "当前配置来自 profile 里的 subagent 配置；在本页保存一次后，改由本页的配置文档管理。",
				"subagent.source.file": "当前配置来自本页保存的配置文档。",
				"subagent.enabled": "启用子智能体（默认关闭）",
				"subagent.device": "目标设备",
				"subagent.deviceHint": "deviceId，或足以指向一个设备的前缀，与 cherry_devices 的形状一致。",
				"subagent.deviceManual": "设备 id",
				"subagent.agentIdManual": "agent id",
				"subagent.workspaceIdManual": "工作区 id（手工）",
				"subagent.agentId": "目标 agent",
				"subagent.workspace.legend": "工作区",
				"subagent.workspace.registry": "指定已注册的工作区",
				"subagent.workspace.system": "系统工作区",
				"subagent.workspace.systemUnavailable": "这台桌面不支持系统工作区，请选一个已注册的工作区。",
				"subagent.workspace.systemConflict": "当前保存的是系统工作区，但这台桌面不支持它；委派会失败。",
				"subagent.workspaceId": "工作区 id",
				"subagent.targets.loading": "正在读取可选目标…",
				"subagent.targets.empty": "没有可选项，可以手工填写。",
				"subagent.targets.pickDevice": "先选择目标设备，才会列出可选项。",
				"subagent.targets.manual": "手动输入…",
				"subagent.targets.unknown": "当前值（未知）：{value}",
				"subagent.targets.unset": "（未选择）",
				"subagent.targets.withId": "{name}（{id}）",
				"subagent.targets.reselectAgent": "设备已更换，目标 agent 已清空，请重新选择。",
				"subagent.targets.reselectWorkspace": "agent 已更换，工作区已清空，请重新选择。",
				"subagent.targets.truncated": "列表在安全上限处被截断（{lists}），可能还有更多。",
				"subagent.targets.problem.deviceUnavailable": "目标设备当前不可用，请先连接再选择。",
				"subagent.targets.problem.notFound": "找不到这台设备，请重新选择。",
				"subagent.targets.problem.ambiguous": "这个名称前缀匹配到多台设备，请选完整的那一台。",
				"subagent.targets.problem.unreachable": "取不到可选目标（{code}），可以继续手工填写。",
				"subagent.cwdMode": "cwdMode：{value}（声明字段，本期不改变行为）",
				"subagent.routes": "routes：{value}（按子目录前缀覆盖设备与工作区；本页只展示，不编辑）",
				"subagent.timeoutMs": "单次委托超时（毫秒；0 表示不限）",
				"subagent.timeoutHint": "默认 1800000（30 分钟）。",
				"subagent.save": "保存子智能体配置",
				"subagent.saved": "已保存。",
				"subagent.pendingRestart": "已保存，但当前装配仍在用旧配置：重启 DSH 后生效。",
				"subagent.revision": "当前 revision：{revision}",
				"subagent.reread": "重新读取",
				"subagent.saveFailed": "保存失败：{cause}",
				"subagent.serverSaid": "服务端返回 {code}（HTTP {status}）。",
				"subagent.error.timeout": "请求长时间没有回应，已中止——请稍后重试",
				"subagent.saveFailure.subagent-revision-conflict": "配置已被他处修改，请重新读取后再保存。",
				"subagent.saveFailure.missing-expected-revision": "保存被拒绝：请求缺少基准 expectedRevision，请重新读取后再保存。",
				"subagent.saveFailure.invalid-request": "保存被拒绝：请求体格式不对。",
				"subagent.scopeNote": "它和其余 14 个工具一样受「启用范围」约束：被排除的工作区看不到它。启用范围为「仅选定工作区」而工作区列表读不到时，任何工作区都看不到它。",
				"subagent.status.heading": "当前状态",
				"subagent.status.disabled": "未启用（默认关闭）。",
				"subagent.status.awaiting-injection": "等待宿主注入 subagents 服务。",
				"subagent.status.unsupported": "当前 DSH 版本没有 subagents 服务，这个功能无法使用；其余功能不受影响。表单已置为只读——在这个版本上保存也不会生效。",
				"subagent.status.invalid": "开关已打开，但配置还不可用：",
				"subagent.status.provider-refused": "注册 provider 失败：{message}",
				"subagent.status.ready": "已注册 provider {providerName} 与工具 {toolName}。",
				"subagent.status.ready-without-tool": "已注册 provider {providerName}，但工具 {toolName} 未注册：",
				"subagent.tool.no-tools-service": "宿主没有 tools 服务。",
				"subagent.tool.no-start-activation": "宿主的 subagents 服务没有 startActivation 接口。",
				"subagent.tool.no-step-condition": "宿主没有 tools.resolve（不支持步骤级激活条件）：工具不注册，以免在所有工作区都可见（fail-closed）。",
				"subagent.tool.host-refused": "工具注册被宿主拒绝：{message}",
				"subagent.problem.not-string": "{field} 必须是字符串（收到 {received}）",
				"subagent.problem.not-boolean": "{field} 必须是布尔值（收到 {received}）",
				"subagent.problem.not-array": "{field} 必须是数组（收到 {received}）",
				"subagent.problem.not-object": "{field} 必须是对象（收到 {received}）",
				"subagent.problem.empty": "{field} 不能为空",
				"subagent.problem.out-of-range": "{field} 必须是 {min} 到 {max} 之间的整数（收到 {received}）",
				"subagent.problem.missing": "缺少 {field}",
				"subagent.problem.enum": "{field} 只接受 {allowed}（收到 {received}）",
				"subagent.problem.exclusive": "{field} 与 {other} 只能二选一",
				"subagent.problem.route-cwd-prefix": "{field} 必须是非空字符串",
				"shape.string": "字符串",
				"shape.number": "数字",
				"shape.boolean": "布尔值",
				"shape.object": "对象",
				"shape.array": "数组",
				"shape.null": "null",
				"shape.undefined": "undefined",
				"shape.function": "函数",
				"shape.symbol": "symbol",
				"shape.bigint": "bigint",
				"shape.NaN": "NaN",
				"shape.Infinity": "Infinity",
				"shape.-Infinity": "-Infinity",
				"list.separator": "、"
			},
			en: {
				"app.title": "Cherry Bridge",
				"app.subtitle": "Connect this machine’s DeepSeek Harness to a Cherry Studio desktop over the remote transport. Device records live in the plugin data directory; this page never touches a credential.",
				"app.eventSourceUnavailable": "EventSource is unavailable in this environment",
				"app.devices.heading": "Paired devices",
				"app.devices.empty": "No paired devices yet. Use the wizard above to pair your first one.",
				"app.devices.loading": "Reading the device list…",
				"device.state.connected": "Connected",
				"device.state.connecting": "Connecting",
				"device.state.offline": "Offline",
				"device.state.disabled": "Disabled",
				"device.state.identity-mismatch": "Identity mismatch",
				"device.state.unknown": "Unknown status",
				"device.disable": "Disable",
				"device.enable": "Enable",
				"device.rename": "Rename",
				"device.addresses": "Addresses",
				"device.remove": "Remove",
				"device.field.addresses": "Addresses",
				"device.field.port": "Port",
				"device.field.id": "Device ID",
				"device.field.name": "Device name",
				"device.field.hosts": "Host addresses",
				"device.hosts.hint": "Separate candidate addresses with commas (the whole list is replaced)",
				"device.field.ports": "Ports per address",
				"device.ports.hint": "Some candidate addresses dial a different port than the one above; changing the port in address maintenance moves every candidate address to that one port.",
				"device.ports.current": "Current port map:",
				"device.port.hint": "Keeping the current value preserves each address’s own port; a new value re-points every candidate address.",
				"device.save.name": "Save name",
				"device.save.addresses": "Save addresses",
				"device.remove.confirm": "Confirm removal",
				"device.remove.warning": "This machine will stop connecting to the device. Its credentials stay on the peer.",
				"device.cancel": "Cancel",
				"device.forget": "Forget",
				"device.remember": "Restore",
				"device.field.forgotten": "Forgotten addresses",
				"device.forgotten.hint": "Forgotten addresses are never dialed. Restore only lifts the mark — the address comes back the next time the desktop advertises it.",
				"device.error.lastAddress": "The last candidate address cannot be forgotten. Add one first.",
				"device.error.timeout": "The request stopped answering and was abandoned. Try again in a moment.",
				"device.error.nameRequired": "Device name cannot be empty",
				"device.error.hostsRequired": "At least one host address is required",
				"device.error.portInvalid": "Port must be an integer between 1 and 65535",
				"wizard.heading": "Pairing wizard",
				"wizard.hint.before": "In the Cherry Studio desktop, open “Remote connection → Add device”; that screen shows a",
				"wizard.hint.qrCode": "QR code",
				"wizard.hint.after": ". Scan it with WeChat or a browser, then copy the pairing payload that page displays and paste it below.",
				"wizard.step.open": "Open “Add device” in Cherry Studio; a QR code appears on screen",
				"wizard.step.scan": "Scan it with WeChat or a browser and copy the pairing payload (address, port and one-time invite)",
				"wizard.step.paste": "Paste it below and start pairing, then compare the 6-digit verification code shown in the desktop window",
				"wizard.payload.label": "Pairing payload",
				"wizard.payload.placeholder": "Paste the pairing payload shown on the page the QR code points at",
				"wizard.submit": "Start pairing",
				"wizard.streamPending": "Opening the event stream. Pairing is available in a moment…",
				"wizard.running": "Pairing in progress",
				"wizard.submitted": "Pairing request submitted…",
				"wizard.code.check": "Compare the verification code in Cherry Studio",
				"wizard.succeeded": "Paired",
				"wizard.failed": "Pairing failed: {stage}",
				"wizard.unknownError": "Unknown error",
				"app.error.timeout": "The request stopped answering and was abandoned. Check that the host is still running; if it keeps happening, restart it and try again.",
				"wizard.timedOut": "No pairing result arrived. If the desktop approved it, the device appears in the list below; otherwise generate a new pairing code in Cherry Studio and try again.",
				"wizard.error.payloadRequired": "Paste the pairing payload shown on the scan page first",
				"wizard.error.timeout": "The pairing request stopped answering and was abandoned. Try again; if it keeps happening the host may be stuck — restart it and retry.",
				"wizard.stage.validate": "Validating the pairing payload…",
				"wizard.stage.connect": "Connecting to Cherry Studio…",
				"wizard.stage.claim": "Exchanging credentials…",
				"wizard.stage.waiting": "Waiting for confirmation in Cherry Studio…",
				"wizard.stage.pairing-failed": "Pairing failed",
				"wizard.stage.rejected": "Pairing was rejected. Check that the 6-digit verification code shown in the desktop matches this page, then generate a new pairing code in Cherry Studio and try again.",
				"wizard.stage.expired": "The pairing invite expired. Generate a new pairing code in Cherry Studio and try again.",
				"wizard.stage.unreachable": "Cannot reach Cherry Studio. Make sure the desktop is running and on the same network as this machine.",
				"wizard.stage.invalid-payload": "The pairing payload is invalid or expired. Generate a new one in Cherry Studio and try again.",
				"wizard.stage.archive-quarantined": "The device archive cannot be read (it was kept as a .corrupt copy). Move that file aside, restart or reload the plugin, then pair again.",
				"scope.heading": "Tool scope",
				"scope.loadError": "Failed to read the tool scope: {error}",
				"scope.loading": "Reading the tool scope…",
				"scope.unsupported": "The host does not support tool scoping (read-only warning): {reason}. Upgrade the host / DSH to use it; until then this plugin registers none of its scoped tools, and the experimental delegation tool is gated separately by its own step-time condition.",
				"scope.versionDegraded": "The scope document version does not match the one this plugin supports (the same guard covers newer and older versions). The document is either newer or older than this plugin supports, so the panel is read-only and saving is disabled. Re-reading returns the same document; upgrade the host / DSH or this plugin and try again.",
				"scope.listUnavailable": "The workspace registry list is unreadable, so saving is disabled (see the note below).",
				"scope.pending": "The host service is still mounting and will be ready shortly. Pairing and device management keep working meanwhile.",
				"scope.degradedLine": "{label}: {reason}",
				"scope.mode.legend": "Mode",
				"scope.mode.global": "Global",
				"scope.mode.selected": "Selected workspaces only",
				"scope.effectNote": "Within the effective scope this plugin does not shadow these cherry_* tools. An upstream allow-shaped filter (a sub-agent’s toolFilter, for example) can still keep them out of a session — this page only states that this plugin does not shadow them, and makes no promise about upstream filtering.",
				"scope.noWorkspaces": "No workspaces are registered.",
				"scope.workspaceUnknown": "(the registry has no information about this workspace)",
				"scope.empty.selected": "No workspace is enabled — while that holds, the cherry_* tools appear in no session at all. Tick one and its sessions (including running ones) can use them.",
				"scope.empty.global": "Global mode: these tools are available in every workspace. The ticks below take effect only after you switch to “Selected workspaces only”.",
				"scope.stale.heading": "Stale (workspace deleted)",
				"scope.stale.note": "These ids are no longer in the registry. Saving prunes them server-side; they are not judged invalid input.",
				"scope.stale.clear": "Clear stale selections",
				"scope.unmatched.heading": "Selected, but the session cwd does not match",
				"scope.unmatched.note": "These sessions ticked a workspace but get no tools: a spelling difference, a symlink, or a directory that genuinely is not registered — this page cannot tell the three apart. This note only explains the cause; it changes neither your ticks nor the mode, and triggers no save.",
				"scope.save": "Save scope",
				"scope.revision": "Current revision: {revision}",
				"scope.saved": "Saved.",
				"scope.savedPruned": "Saved. The server pruned these stale selections: {list}.",
				"scope.reread": "Reload",
				"scope.saveFailed": "Save failed: {cause}",
				"scope.error.timeout": "The request stopped answering and was abandoned. Try again in a moment.",
				"scope.serverSaid": "The server answered {code} (HTTP {status}).",
				"scope.degraded.install": "Applying a hidden layer failed earlier (install): the affected agent’s hidden layer is not in effect or cannot be confirmed, so the tool scope may not apply to it",
				"scope.degraded.workspace-list": "The workspace registry list is currently unreadable",
				"scope.degraded.visibility-only": "Visibility-only degradation (tools.guard is missing): restrict still removes these 15 tools at the assembly layer, but nothing on the execution side refuses a call to them (this is not a render-layer fake filter). An agent that cannot install restrict at all both fails to hide them and has nothing to refuse them",
				"scope.degraded.scope-version": "The scope document version does not match the one this plugin supports (one guard covers newer and older)",
				"scope.degraded.path-normalization": "Path normalization degraded: the cwd comparison may be inaccurate",
				"scope.saveFailure.scope-revision-conflict": "The configuration changed elsewhere. Reload before saving again.",
				"scope.saveFailure.scope-version-unsupported": "The scope document version does not match the one this plugin supports (the same guard covers newer and older). Re-reading cannot change the document version — upgrade the host / DSH or this plugin and try again.",
				"scope.saveFailure.invalid-scope": "Save refused: an illegal scope field (mode must be global or selected, workspaceIds must be an array of strings).",
				"scope.saveFailure.missing-expected-revision": "Save refused: the request carries no base expectedRevision. Reload before saving again.",
				"scope.saveFailure.workspace-list-unavailable": "The workspace list is unreadable, so it cannot be saved. The stored ticks and mode are left untouched.",
				"subagent.heading": "Experimental subagent",
				"subagent.badge": "Experimental",
				"subagent.experimental": "Experimental: this spans two systems the plugin does not control — DSH and Cherry Studio — so its interface and behaviour may change. Off by default.",
				"subagent.defaultOff": "Off by default. Turning it on needs a target device, agent and workspace; a save takes effect when DSH restarts.",
				"subagent.feedback": "Ideas and bug reports are welcome:",
				"subagent.feedbackLink": "dsh-cherry-bridge issues",
				"subagent.loading": "Reading the subagent configuration…",
				"subagent.loadError": "Reading the subagent configuration failed: {error}",
				"subagent.source.config": "This configuration comes from the profile subagent key. Once you save on this page, the page’s own document takes over.",
				"subagent.source.file": "This configuration comes from the document saved on this page.",
				"subagent.enabled": "Enable the subagent (off by default)",
				"subagent.device": "Target device",
				"subagent.deviceHint": "A deviceId or a unique prefix, the same shape cherry_devices takes.",
				"subagent.deviceManual": "Device id",
				"subagent.agentIdManual": "Agent id",
				"subagent.workspaceIdManual": "Workspace id (typed)",
				"subagent.agentId": "Target agent",
				"subagent.workspace.legend": "Workspace",
				"subagent.workspace.registry": "A registered workspace",
				"subagent.workspace.system": "The system workspace",
				"subagent.workspace.systemUnavailable": "This desktop has no system workspace — pick a registered one.",
				"subagent.workspace.systemConflict": "The saved config uses the system workspace, but this desktop has none; delegation will fail.",
				"subagent.workspaceId": "Workspace id",
				"subagent.targets.loading": "Reading the available targets…",
				"subagent.targets.empty": "Nothing to pick from — type it by hand.",
				"subagent.targets.pickDevice": "Choose a target device first; the list follows it.",
				"subagent.targets.manual": "Type it myself…",
				"subagent.targets.unknown": "Current value (unknown): {value}",
				"subagent.targets.unset": "(nothing chosen)",
				"subagent.targets.withId": "{name} ({id})",
				"subagent.targets.reselectAgent": "The device changed, so the agent was cleared — choose it again.",
				"subagent.targets.reselectWorkspace": "The agent changed, so the workspace was cleared — choose it again.",
				"subagent.targets.truncated": "The list was cut at its safety bound ({lists}); there may be more.",
				"subagent.targets.problem.deviceUnavailable": "That device is not available right now — connect it, then choose.",
				"subagent.targets.problem.notFound": "No such device — choose it again.",
				"subagent.targets.problem.ambiguous": "That prefix matches more than one device — pick the full one.",
				"subagent.targets.problem.unreachable": "Could not read the targets ({code}); you can still type them by hand.",
				"subagent.cwdMode": "cwdMode: {value} (a declared field; it changes no behaviour yet)",
				"subagent.routes": "routes: {value} (per-directory overrides for the device and the workspace; shown here, not edited here)",
				"subagent.timeoutMs": "Timeout per delegation (milliseconds; 0 means no bound)",
				"subagent.timeoutHint": "Default 1800000 (30 minutes).",
				"subagent.save": "Save the subagent configuration",
				"subagent.saved": "Saved.",
				"subagent.pendingRestart": "Saved, but this assembly is still running the previous configuration: it takes effect when DSH restarts.",
				"subagent.revision": "Current revision: {revision}",
				"subagent.reread": "Read again",
				"subagent.saveFailed": "Save failed: {cause}",
				"subagent.serverSaid": "The server answered {code} (HTTP {status}).",
				"subagent.error.timeout": "The request did not answer in time and was aborted — try again shortly",
				"subagent.saveFailure.subagent-revision-conflict": "The configuration was changed elsewhere; read it again before saving.",
				"subagent.saveFailure.missing-expected-revision": "The save was refused: the request carried no expectedRevision baseline. Read the document again before saving.",
				"subagent.saveFailure.invalid-request": "The save was refused: the request body is malformed.",
				"subagent.scopeNote": "Like the other fourteen tools, it obeys the enabled scope: an excluded workspace does not see it. Under “selected” with an unreadable workspace list, no workspace sees it.",
				"subagent.status.heading": "Current state",
				"subagent.status.disabled": "Not enabled (off by default).",
				"subagent.status.awaiting-injection": "Waiting for the host to inject the subagents service.",
				"subagent.status.unsupported": "This DSH version has no subagents service, so the feature cannot work. Nothing else is affected. The form is read-only: saving on this version would have no effect.",
				"subagent.status.invalid": "The switch is on, but the configuration is not usable yet:",
				"subagent.status.provider-refused": "Registering the provider failed: {message}",
				"subagent.status.ready": "Registered provider {providerName} and tool {toolName}.",
				"subagent.status.ready-without-tool": "Registered provider {providerName}, but not the tool {toolName}:",
				"subagent.tool.no-tools-service": "The host has no tools service.",
				"subagent.tool.no-start-activation": "The host’s subagents service has no startActivation method.",
				"subagent.tool.no-step-condition": "The host has no tools.resolve, so it cannot honour a per-step activation condition. The tool is not registered (fail-closed) rather than left visible in every workspace.",
				"subagent.tool.host-refused": "The host refused the tool registration: {message}",
				"subagent.problem.not-string": "{field} must be a string (got {received})",
				"subagent.problem.not-boolean": "{field} must be a boolean (got {received})",
				"subagent.problem.not-array": "{field} must be an array (got {received})",
				"subagent.problem.not-object": "{field} must be an object (got {received})",
				"subagent.problem.empty": "{field} must not be empty",
				"subagent.problem.out-of-range": "{field} must be an integer between {min} and {max} (got {received})",
				"subagent.problem.missing": "Missing {field}",
				"subagent.problem.enum": "{field} accepts only {allowed} (got {received})",
				"subagent.problem.exclusive": "{field} and {other} are mutually exclusive",
				"subagent.problem.route-cwd-prefix": "{field} must be a non-empty string",
				"shape.string": "a string",
				"shape.number": "a number",
				"shape.boolean": "a boolean",
				"shape.object": "an object",
				"shape.array": "an array",
				"shape.null": "null",
				"shape.undefined": "undefined",
				"shape.function": "a function",
				"shape.symbol": "a symbol",
				"shape.bigint": "a bigint",
				"shape.NaN": "NaN",
				"shape.Infinity": "Infinity",
				"shape.-Infinity": "-Infinity",
				"list.separator": ", "
			}
		};
		/**
		* Binds `locale` to a translator.
		*
		* The returned function reads the DICTIONARY it closed over, so it stays valid
		* across a language change only as long as the caller re-binds (which
		* {@link useT} does on every store change). It never throws: an unknown key and
		* an unsupplied param both survive as literal text.
		*/
		function createTranslator(locale) {
			const dict = dictionaries[locale];
			return (key, params) => {
				const template = dict[key];
				if (template === void 0) return key;
				if (params === void 0) return template;
				return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
			};
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
		function resolveLocaleFromNavigator(language) {
			const tag = (language ?? "").trim().toLowerCase();
			if (tag === "") return "zh";
			return tag.startsWith("zh") ? "zh" : "en";
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
		var snapshot = Object.freeze({ locale: "zh" });
		var listeners = /* @__PURE__ */ new Set();
		/**
		* The module-level locale store every component reads through {@link useT}.
		*
		* A module-level singleton rather than a React context: the host may change the
		* language at any time and every mounted component must follow it without being
		* re-mounted, which is exactly what an external store provides.
		*/
		var localeStore = {
			getSnapshot() {
				return snapshot;
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			setLocale(locale) {
				if (locale === snapshot.locale) return;
				snapshot = Object.freeze({ locale });
				for (const listener of [...listeners]) listener();
			}
		};
		/**
		* The translator for the CURRENT language, re-rendering the caller on a switch.
		*
		* The translator is MEMOIZED on the locale, so its identity is stable across
		* renders that do not change the language: a consumer may put `t` in a
		* dependency array (or a `useMemo`/`useCallback` list) without re-running on
		* every render. `localeStore.getSnapshot()` already returns a stable frozen
		* object per locale, so `current.locale` is the right memo key.
		*/
		function useT() {
			const current = (0, react.useSyncExternalStore)(localeStore.subscribe, localeStore.getSnapshot);
			return (0, react.useMemo)(() => createTranslator(current.locale), [current.locale]);
		}
		//#endregion
		//#region ui/src/types.ts
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
		*
		* The one EXCEPTION is `./i18n`, imported for the two re-exported label tables
		* below: the Chinese strings the page shows must have exactly one home, and that
		* home is the zh dictionary. `i18n.ts` pulls in nothing but `react`, and the
		* label tables take their values at MODULE LOAD (not per render), so the
		* inlining story above is unchanged — `types.ts` still has no host dependency.
		*/
		/** The plugin's same-origin route prefix; relative, never absolute. */
		var API_BASE = "/cherry-remote/api";
		/**
		* The pairing stages that end a run.
		*
		* `approved` is the one success. The rest are the FAILURE verdicts the server
		* publishes after the 202: `POST /pair` returns immediately, so a failure is not
		* an HTTP status — it arrives as a `pairing-progress` frame whose `stage` is
		* `verdict.error` (src/httpApi.ts `startPairing`), and `PairingErrorKind` is
		* `invalid-payload | rejected | expired | unreachable`. Every one of them must
		* end the run, or the wizard sits in 'waiting' forever with a disabled submit
		* button. `pairing-failed` is the non-`PairingError` fallback verdict, and
		* `archive-quarantined` is the damaged-`devices.json` refusal — also a terminal
		* state, since no retry can succeed until the file is moved aside.
		*/
		var TERMINAL_STAGES = [
			"approved",
			"rejected",
			"expired",
			"unreachable",
			"invalid-payload",
			"pairing-failed",
			"archive-quarantined"
		];
		dictionaries.zh["wizard.stage.validate"], dictionaries.zh["wizard.stage.connect"], dictionaries.zh["wizard.stage.claim"], dictionaries.zh["wizard.stage.waiting"], dictionaries.zh["wizard.stage.pairing-failed"], dictionaries.zh["wizard.stage.rejected"], dictionaries.zh["wizard.stage.expired"], dictionaries.zh["wizard.stage.unreachable"], dictionaries.zh["wizard.stage.invalid-payload"], dictionaries.zh["wizard.stage.archive-quarantined"];
		/**
		* The dictionary KEYS behind {@link STAGE_LABELS}, one per stage.
		*
		* Same shape and same key set as the label table — `Record<string, string>`
		* rather than a union-keyed map, because a stage arrives as an arbitrary string
		* off the wire and the render side falls back to the raw stage for one this
		* build does not know.
		*
		* Why both tables exist: a component labels a verdict with `t(STAGE_KEYS[stage]
		* ?? stage)`, which needs a KEY, while assertions and any non-translating caller
		* need the Chinese TEXT. Pinning the text to `dictionaries.zh` and exposing the
		* key separately is what keeps those two in step.
		*/
		var STAGE_KEYS = {
			validate: "wizard.stage.validate",
			connect: "wizard.stage.connect",
			claim: "wizard.stage.claim",
			waiting: "wizard.stage.waiting",
			"pairing-failed": "wizard.stage.pairing-failed",
			rejected: "wizard.stage.rejected",
			expired: "wizard.stage.expired",
			unreachable: "wizard.stage.unreachable",
			"invalid-payload": "wizard.stage.invalid-payload",
			"archive-quarantined": "wizard.stage.archive-quarantined"
		};
		dictionaries.zh["device.state.connected"], dictionaries.zh["device.state.connecting"], dictionaries.zh["device.state.offline"], dictionaries.zh["device.state.disabled"], dictionaries.zh["device.state.identity-mismatch"];
		/**
		* The dictionary KEYS behind {@link STATE_LABELS}, one per device state.
		*
		* Same shape as the label table (`Record<DeviceState, string>`), so a component
		* can translate a state with `t(STATE_KEYS[state] ?? state)` and stay exhaustive
		* over {@link DeviceState} at compile time.
		*/
		var STATE_KEYS = {
			connected: "device.state.connected",
			connecting: "device.state.connecting",
			offline: "device.state.offline",
			disabled: "device.state.disabled",
			"identity-mismatch": "device.state.identity-mismatch"
		};
		//#endregion
		//#region ui/src/api.ts
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
		/** A refused call, carrying the server's structured error verbatim. */
		var ApiError = class extends Error {
			status;
			code;
			constructor(status, code, message) {
				super(`${code}: ${message}`);
				this.status = status;
				this.code = code;
				this.name = "ApiError";
			}
		};
		/**
		* The marker a request that never answered throws with.
		*
		* Internal token, NEVER copy: each surface renders its own sentence for it —
		* `app.error.timeout`, `wizard.error.timeout`, `scope.error.timeout` — and this
		* string only travels from `request()` to the catch block that recognizes it, the
		* same split as `app.eventSourceUnavailable` (see `App.tsx`). That is what keeps
		* an English literal off a Chinese page.
		*/
		var REQUEST_TIMEOUT = "cherry-remote.request-timeout";
		/**
		* How long ANY call on this page may stay open, in milliseconds.
		*
		* None of these calls is slow: they are same-origin requests to the plugin's own
		* HTTP face, and the one that looks slowest — a pairing START — does no I/O
		* before it answers (`src/httpApi.ts` `startPairing` writes its 202 at once).
		* A request still open after this long is a WEDGED transport, not a busy server,
		* and it must not be allowed to strand a control: without a ceiling the pairing
		* wizard's submit button (issue #173), a device card's buttons, the scope panel's
		* save and the device list's "loading" state each wait for the life of the page
		* (issue #180).
		*
		* So the ceiling lives in `request()`, where every call passes, rather than on
		* one call site. Each surface turns the {@link REQUEST_TIMEOUT} marker into its
		* own sentence.
		*/
		var DEFAULT_REQUEST_TIMEOUT_MS = 1e4;
		/** Reads a JSON body without throwing on an empty (204) or non-JSON response. */
		async function readBody(response) {
			const text = await response.text();
			if (text.trim() === "") return void 0;
			try {
				return JSON.parse(text);
			} catch {
				return text;
			}
		}
		/**
		* One bounded request. `timeoutMs` exists so a test can prove the ceiling
		* without waiting for it; production always takes {@link DEFAULT_REQUEST_TIMEOUT_MS}.
		*/
		async function request(url, init, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await fetch(url, {
					...init,
					headers: {
						"content-type": "application/json",
						...init?.headers ?? {}
					},
					signal: controller.signal
				});
				const body = await readBody(response);
				if (!response.ok) {
					const record = body ?? {};
					const code = typeof record.error === "string" ? record.error : `http-${response.status}`;
					const message = typeof record.message === "string" ? record.message : code;
					throw new ApiError(response.status, code, message);
				}
				return body;
			} catch (cause) {
				if (controller.signal.aborted) throw new Error(REQUEST_TIMEOUT);
				throw cause;
			} finally {
				clearTimeout(timer);
			}
		}
		/** `GET /devices` — the full card list, states projected server-side. */
		async function listDevices() {
			const body = await request(`${API_BASE}/devices`);
			return Array.isArray(body) ? body : [];
		}
		/**
		* `POST /pair` — returns as soon as the server has a claim (202 + `{claimId}`).
		*
		* It deliberately does NOT wait for approval: the 6-digit code and the verdict
		* arrive as `pairing-progress` SSE frames, which is why the caller must already
		* be subscribed when this resolves.
		*
		* Bounded like every other call (see {@link DEFAULT_REQUEST_TIMEOUT_MS});
		* `timeoutMs` exists only so a test can prove the ceiling without waiting.
		*/
		async function startPairing(payload, options = {}) {
			const { name } = options;
			return await request(`/cherry-remote/api/pair`, {
				method: "POST",
				body: JSON.stringify(name === void 0 || name === "" ? { payload } : {
					payload,
					name
				})
			}, options.timeoutMs) ?? {};
		}
		/** `PATCH /devices/:id` — `hosts` is whole-replace; omitted fields are untouched. */
		async function patchDevice(deviceId, patch) {
			return await request(`${API_BASE}/devices/${encodeURIComponent(deviceId)}`, {
				method: "PATCH",
				body: JSON.stringify(patch)
			});
		}
		/**
		* `POST /devices/:id/forget` — stop dialing these addresses AND record them so
		* the desktop cannot advertise them back (issue #185).
		*
		* The answer is the SAME record shape {@link patchDevice} returns, which is why
		* the card hands either body to the same `onSaved`. The action is its own
		* request on purpose: folding it into the PATCH would make "replace the dial
		* list" and "forget one address" one body with an ordering to define.
		*/
		async function forgetHosts(deviceId, hosts) {
			return await request(`${API_BASE}/devices/${encodeURIComponent(deviceId)}/forget`, {
				method: "POST",
				body: JSON.stringify({ hosts })
			});
		}
		/**
		* `POST /devices/:id/remember` — lift the marks.
		*
		* It does NOT dial the address again: the record's `hosts` is untouched, and
		* the address returns when the desktop next advertises it. Putting it back into
		* the dial list immediately stays the PATCH's job (that PATCH clears the mark in
		* the same write).
		*/
		async function rememberHosts(deviceId, hosts) {
			return await request(`${API_BASE}/devices/${encodeURIComponent(deviceId)}/remember`, {
				method: "POST",
				body: JSON.stringify({ hosts })
			});
		}
		/** `DELETE /devices/:id` — 204, no body. */
		async function removeDevice(deviceId) {
			await request(`${API_BASE}/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
		}
		/**
		* `GET /scope` — the whole scope state in ONE body (spec §6.3).
		*
		* The page cannot reach the workspace registry itself, so the server projects
		* the list down (`id`/`title`/`path` only) and answers with the document, the
		* two diagnostic channels and the host block together.
		*/
		async function getScope() {
			return await request(`${API_BASE}/scope`);
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
		async function putScope(body) {
			return await request(`${API_BASE}/scope`, {
				method: "PUT",
				body: JSON.stringify(body)
			});
		}
		/**
		* The production {@link ScopeClient}: the same-origin calls above behind the
		* seam the panel (and `App`) accept, so tests can inject a stub without
		* touching production wiring.
		*/
		var defaultScopeClient = {
			get: () => getScope(),
			put: (body) => putScope(body)
		};
		/**
		* `GET /subagent` — the experiment's stored configuration and the RUNNING verdict.
		*
		* Two facts, one body, deliberately: the page must be able to show "saved, not
		* applied" without a second call, and a second call could be answered between
		* two different applies.
		*/
		async function getSubagent() {
			return await request(`${API_BASE}/subagent`);
		}
		/**
		* `PUT /subagent` — read-modify-write, locked on `expectedRevision`.
		*
		* The refusal codes are the route's, and the caller branches on them:
		* `invalid-request` / `missing-expected-revision` (400),
		* `subagent-revision-conflict` (409). `invalid-request` covers a body that is
		* not JSON at all; a config FIELD that is unusable is not a refusal — it is
		* stored, and the next read reports it as a `failed` verdict with its problems.
		*/
		async function putSubagent(body) {
			return await request(`${API_BASE}/subagent`, {
				method: "PUT",
				body: JSON.stringify(body)
			});
		}
		/**
		* `GET /subagent/targets` — the ids and NAMES behind the three target fields
		* (#260, consumed by #262).
		*
		* A refusal is a 200 with `{problem}`, not a 4xx: the endpoint resolves a device
		* and walks a peer, and "the device is offline" is an ANSWER to the question, not
		* a malformed request. Only a missing `device` is a 400, so `ApiError` here means
		* this page sent something the route rejects outright.
		*/
		async function getSubagentTargets(device, agentId) {
			const query = new URLSearchParams({ device });
			if (agentId !== void 0 && agentId !== "") query.set("agentId", agentId);
			return await request(`${API_BASE}/subagent/targets?${query.toString()}`);
		}
		/** The production {@link SubagentClient}: the three same-origin calls above. */
		var defaultSubagentClient = {
			get: () => getSubagent(),
			put: (body) => putSubagent(body),
			targets: (device, agentId) => getSubagentTargets(device, agentId)
		};
		//#endregion
		//#region ui/src/DeviceCard.tsx
		/**
		* The device card: one status light plus the four maintenance actions.
		*
		* The light is the card's whole story — five states, each with a distinct
		* colour and a distinct accessible name, because colour alone is not a status.
		* The three inline editors (rename, address, remove confirmation) are mutually
		* exclusive: two open forms on one card would make "save" ambiguous.
		*
		* Every mutation reports the server's authoritative record back through
		* `onSaved`, so the card shows what the archive holds rather than what the
		* browser hoped for. The live `state` keeps coming from SSE; the patch response
		* only seeds it.
		*
		* The addresses row is also where an address is FORGOTTEN (issue #204), and the
		* marks it leaves are listed under their own label with a 恢复 each. One click
		* is one committed action, never a draft: the two controls are INERT while the
		* address editor is open, because that form PATCHes the whole host list and its
		* draft is unconditionally sacred (see the resync effect) — a mark chosen
		* underneath it would be re-sent by the next 保存地址, and the PATCH that names a
		* forgotten host clears its mark in the same write. Freezing the controls is
		* what keeps "commit or discard the edit first" true; it is not a stylistic
		* preference.
		*/
		/** Splits the comma-separated host box into the whole-replace list the API wants. */
		function parseHosts(raw) {
			return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
		}
		/** The dial port for one host: its own stored port, else the record-level one. */
		function dialPort(device, host) {
			return device.ports?.[host] ?? device.port;
		}
		/**
		* `host:port` as one readable address.
		*
		* An IPv6 literal contains colons, so `fe80::1:4343` reads as an ambiguous
		* host; stored hosts are bare (`normalizeHost` strips the brackets), so the
		* brackets are added here, for display only.
		*/
		function formatAddress(host, port) {
			return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
		}
		function DeviceCard({ device, state, onSaved, onRemoved }) {
			const t = useT();
			const [editor, setEditor] = (0, react.useState)("none");
			const [name, setName] = (0, react.useState)(device.displayName);
			const [hostsText, setHostsText] = (0, react.useState)(device.hosts.join(", "));
			const [portText, setPortText] = (0, react.useState)(String(device.port));
			const [error, setError] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			/**
			* RESYNC FROM PROPS, but only while NO editor is open. Each editor holds a
			* local draft seeded from the record, and `device` can change underneath
			* it: a refresh (`GET /devices` after a pairing settles) replaces the
			* card's record, and another tab's PATCH arrives the same way. Without
			* this the box would keep showing a value the server no longer holds, and
			* saving that box would write the STALE value back — the exact failure
			* the "server's verdict is authoritative" rule elsewhere in this component
			* exists to prevent.
			*
			* While an editor IS open the draft is unconditionally sacred, focus
			* notwithstanding. The earlier guard also required focus to sit inside the
			* card, and the live host page proved that focus signal unreliable: a
			* focus artifact while the editor was open resynced the draft to the OLD
			* name mid-edit, so the save PATCHed the pre-edit name and the rename
			* "silently did nothing" (the input kept the typed text because React
			* never re-rendered after the wipe bailed out on an identical value).
			* Closing the editor is itself a dep change, so the drafts are always
			* reseeded fresh for the next open.
			*
			* Keyed on the fields themselves, not the object identity: `listDevices`
			* rebuilds every record on each refresh, so an identity check would resync
			* on every poll even when nothing changed.
			*/
			(0, react.useEffect)(() => {
				if (editor !== "none") return;
				setName(device.displayName);
				setHostsText(device.hosts.join(", "));
				setPortText(String(device.port));
			}, [
				device.displayName,
				device.hosts,
				device.port,
				editor
			]);
			/**
			* Runs one mutation, mapping a refusal into the card's error line.
			*
			* A request that never answered arrives as `api.ts`'s internal marker — the
			* page-wide ceiling (issue #180) — and a marker must never render. Every card
			* action is a bounded call (停用 / 重命名 / 移除 are PATCH or DELETE), so this
			* surface translates it like the other three do instead of echoing
			* `cherry-remote.request-timeout` onto the page.
			*/
			const run = async (action) => {
				setBusy(true);
				setError(void 0);
				try {
					await action();
				} catch (cause) {
					setError(describeCause(cause));
				} finally {
					setBusy(false);
				}
			};
			/**
			* One refusal for a cause, so the two markers and the one translated code
			* cannot drift between this card's arms.
			*
			* `ApiError` renders as `<code>: <server message>`, which is right for a
			* diagnostic and wrong for `last-address`: forgetting the only candidate is a
			* thing the operator can fix here, and the server's own prose is English on a
			* Chinese page. Everything else keeps the server's verdict verbatim — that is
			* what tells `invalid-payload` from `unreachable`.
			*/
			const describeCause = (cause) => {
				if (cause instanceof ApiError && cause.code === "last-address") return t("device.error.lastAddress");
				if (cause instanceof Error && cause.message === "cherry-remote.request-timeout") return t("device.error.timeout");
				return cause instanceof Error ? cause.message : String(cause);
			};
			/** Forgets ONE address: the store drops it and records the mark in one write. */
			const forget = (host) => {
				run(async () => {
					onSaved(await forgetHosts(device.deviceId, [host]));
				});
			};
			/**
			* Lifts ONE mark. The server also drops the pooled connection on a change, so
			* the very handshake that follows re-learns the address if the desktop still
			* advertises it — without that, a desktop that stays connected would not
			* re-handshake for as long as the link holds, and this button would look
			* inert.
			*/
			const remember = (host) => {
				run(async () => {
					onSaved(await rememberHosts(device.deviceId, [host]));
				});
			};
			const toggleEnabled = () => {
				const enabled = !device.enabled;
				run(async () => {
					onSaved(await patchDevice(device.deviceId, { enabled }));
				});
			};
			const saveName = (event) => {
				event.preventDefault();
				const displayName = name.trim();
				if (displayName === "") {
					setError(t("device.error.nameRequired"));
					return;
				}
				run(async () => {
					onSaved(await patchDevice(device.deviceId, { displayName }));
					setEditor("none");
				});
			};
			const saveAddress = (event) => {
				event.preventDefault();
				const hosts = parseHosts(hostsText);
				if (hosts.length === 0) {
					setError(t("device.error.hostsRequired"));
					return;
				}
				const port = Number(portText);
				if (!Number.isInteger(port) || port < 1 || port > 65535) {
					setError(t("device.error.portInvalid"));
					return;
				}
				run(async () => {
					onSaved(await patchDevice(device.deviceId, {
						hosts,
						port
					}));
					setEditor("none");
				});
			};
			const confirmRemove = () => {
				run(async () => {
					await removeDevice(device.deviceId);
					onRemoved(device.deviceId);
				});
			};
			/**
			* A defensive empty list, the same choice `dialPort` makes for the required
			* `ports` map: `GET /devices` always emits the key, but this card is one row
			* in a list, and a record missing one field must not take the whole page down
			* with a render throw — it shows a card without the mark instead.
			*/
			const forgottenHosts = device.forgottenHosts ?? [];
			const mixedPorts = device.hosts.some((host) => dialPort(device, host) !== device.port);
			const addressList = device.hosts.map((host) => formatAddress(host, dialPort(device, host))).join(", ");
			const label = state === void 0 ? t("device.state.unknown") : t(STATE_KEYS[state] ?? state);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "cherry-card",
				"data-device-id": device.deviceId,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cherry-card-head",
						children: [
							state === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cherry-state",
								"data-state": "unknown",
								title: label,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "cherry-state-dot" })
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cherry-state",
								role: "img",
								"aria-label": label,
								"data-state": state,
								title: label,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "cherry-state-dot" })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "cherry-card-title",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: device.displayName }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cherry-state-label",
									children: label
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "cherry-card-actions",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: toggleEnabled,
										disabled: busy,
										children: device.enabled ? t("device.disable") : t("device.enable")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => setEditor(editor === "rename" ? "none" : "rename"),
										disabled: busy,
										children: t("device.rename")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => setEditor(editor === "address" ? "none" : "address"),
										disabled: busy,
										children: t("device.addresses")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => setEditor(editor === "remove" ? "none" : "remove"),
										disabled: busy,
										children: t("device.remove")
									})
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
						className: "cherry-card-facts",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("device.field.addresses") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "cherry-address-list",
								children: device.hosts.map((host) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: host }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => forget(host),
									disabled: busy || editor === "address",
									children: t("device.forget")
								})] }, host))
							}) }),
							forgottenHosts.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("device.field.forgotten") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "cherry-address-list",
								children: forgottenHosts.map((host) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: host }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => remember(host),
									disabled: busy || editor === "address",
									children: t("device.remember")
								})] }, host))
							}) })] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("device.field.port") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: device.port }),
							mixedPorts && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("device.field.ports") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
								className: "cherry-mono",
								children: addressList
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("device.field.id") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
								className: "cherry-mono",
								children: device.deviceId
							})
						]
					}),
					forgottenHosts.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: t("device.forgotten.hint")
					}),
					mixedPorts && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: t("device.ports.hint")
					}),
					editor === "rename" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: "cherry-inline-form",
						onSubmit: saveName,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								htmlFor: `name-${device.deviceId}`,
								children: t("device.field.name")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: `name-${device.deviceId}`,
								value: name,
								onChange: (event) => setName(event.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								disabled: busy,
								children: t("device.save.name")
							})
						]
					}),
					editor === "address" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: "cherry-inline-form",
						onSubmit: saveAddress,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								htmlFor: `hosts-${device.deviceId}`,
								children: t("device.field.hosts")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: `hosts-${device.deviceId}`,
								value: hostsText,
								onChange: (event) => setHostsText(event.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cherry-hint",
								children: t("device.hosts.hint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "cherry-hint",
								children: [
									t("device.ports.current"),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "cherry-mono",
										children: addressList
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								htmlFor: `port-${device.deviceId}`,
								children: t("device.field.port")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: `port-${device.deviceId}`,
								inputMode: "numeric",
								value: portText,
								onChange: (event) => setPortText(event.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cherry-hint",
								children: t("device.port.hint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								disabled: busy,
								children: t("device.save.addresses")
							})
						]
					}),
					editor === "remove" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cherry-inline-form",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("device.remove.warning") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: confirmRemove,
								disabled: busy,
								children: t("device.remove.confirm")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => setEditor("none"),
								disabled: busy,
								children: t("device.cancel")
							})
						]
					}),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-error",
						role: "alert",
						children: error
					})
				]
			});
		}
		//#endregion
		//#region ui/src/PairingWizard.tsx
		/**
		* The pairing wizard: paste an invitation payload, watch the run, compare the
		* 6-digit code, done.
		*
		* Two contract details drive this component's shape:
		*
		*  - **`POST /pair` returns immediately** (202 + `{claimId}`). The wizard never
		*    waits for approval over HTTP; it moves to "配对进行中" as soon as the claim
		*    exists. That is what keeps a browser fetch from sitting open for the whole
		*    120s invitation window.
		*  - **The 6-digit code arrives ONLY as a `pairing-progress` frame** with
		*    `stage: 'verification-code'`. There is no replay: the stream the app opened
		*    on mount is the only chance to see it. The code is rendered transiently —
		*    cleared by a terminal stage or by its own countdown — because a code left
		*    on screen invites comparing a stale number.
		*/
		/** The countdown the transient code display gets, in seconds. */
		var DEFAULT_CODE_LIFETIME_MS = 12e4;
		/**
		* How long one run may sit in `waiting` before the wizard gives the form back.
		*
		* The server publishes a terminal stage on EVERY outcome (`src/httpApi.ts`
		* `startPairing`), but the event stream carries no replay, so a single dropped
		* frame loses the verdict for good — and nothing else clears `busy`: only a
		* terminal frame or a refused POST does, and there is no cancel control. Without
		* this bound a lost frame parks the wizard on 「配对进行中」 until a page reload.
		*
		* The bound must be comfortably past a REALISTIC live run: `src/pairing.ts`
		* bounds the candidate walk to 30 s (`dialBudgetMs`) and the claim/poll phase to
		* a FRESH 120 s anchored at the claim, so 150 s plus 30 s of margin.
		*
		* It is NOT past a pathological one, and it says so rather than pretending: two
		* round trips inside that walk (`hello`, then the claim) are bounded only by
		* JsonRpcClient's 60 s default request timeout, so a peer that stalls each just
		* under it can keep a run legitimately working for ~270 s. A premature alarm is
		* acceptable because it is not a verdict — it points at the device list, and a
		* terminal frame arriving later replaces it (see `claimId` below).
		*/
		var DEFAULT_RUN_LIFETIME_MS = 18e4;
		function PairingWizard({ subscribed, progress, codeLifetimeMs = DEFAULT_CODE_LIFETIME_MS, runLifetimeMs = DEFAULT_RUN_LIFETIME_MS, onRunStart, onSettled }) {
			const t = useT();
			const [payload, setPayload] = (0, react.useState)("");
			const [claimId, setClaimId] = (0, react.useState)(void 0);
			const [phase, setPhase] = (0, react.useState)("idle");
			const [error, setError] = (0, react.useState)(void 0);
			const [code, setCode] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [verdict, setVerdict] = (0, react.useState)(void 0);
			const [timedOut, setTimedOut] = (0, react.useState)(false);
			const stage = progress?.stage;
			const frameClaimId = progress?.claimId;
			(0, react.useEffect)(() => {
				if (stage === void 0) {
					setCode(void 0);
					return;
				}
				if (claimId === void 0 || frameClaimId !== claimId) return;
				if (stage === "verification-code") {
					setCode(progress?.detail);
					return;
				}
				if (TERMINAL_STAGES.includes(stage)) {
					setCode(void 0);
					setTimedOut(false);
					setVerdict(stage);
					setPhase(stage === "approved" ? "done" : "failed");
					setBusy(false);
					onSettled?.();
				}
			}, [
				stage,
				frameClaimId,
				progress?.detail,
				claimId,
				onSettled
			]);
			(0, react.useEffect)(() => {
				if (code === void 0) return void 0;
				const timer = setTimeout(() => setCode(void 0), codeLifetimeMs);
				return () => clearTimeout(timer);
			}, [code, codeLifetimeMs]);
			(0, react.useEffect)(() => {
				if (phase !== "waiting") return void 0;
				const timer = setTimeout(() => {
					setCode(void 0);
					setTimedOut(true);
					setPhase("failed");
					setBusy(false);
					onSettled?.();
				}, runLifetimeMs);
				return () => clearTimeout(timer);
			}, [
				phase,
				runLifetimeMs,
				onSettled
			]);
			const submit = (event) => {
				event.preventDefault();
				const trimmed = payload.trim();
				if (trimmed === "") {
					setError(t("wizard.error.payloadRequired"));
					return;
				}
				setBusy(true);
				setError(void 0);
				setPhase("submitting");
				setClaimId(void 0);
				setVerdict(void 0);
				setTimedOut(false);
				onRunStart?.();
				startPairing(trimmed).then((result) => {
					setClaimId(result.claimId);
					setPhase("waiting");
				}, (cause) => {
					setError(cause instanceof Error && cause.message === "cherry-remote.request-timeout" ? t("wizard.error.timeout") : cause instanceof Error ? cause.message : String(cause));
					setPhase("idle");
					setBusy(false);
				});
			};
			const running = phase === "submitting" || phase === "waiting";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "cherry-panel",
				"aria-labelledby": "cherry-pairing-title",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						id: "cherry-pairing-title",
						children: t("wizard.heading")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cherry-hint",
						children: [
							t("wizard.hint.before"),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("wizard.hint.qrCode") }),
							t("wizard.hint.after")
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ol", {
						className: "cherry-steps",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("wizard.step.open") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("wizard.step.scan") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("wizard.step.paste") })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: "cherry-pair-form",
						onSubmit: submit,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								htmlFor: "cherry-payload",
								children: t("wizard.payload.label")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								id: "cherry-payload",
								value: payload,
								rows: 3,
								placeholder: t("wizard.payload.placeholder"),
								onChange: (event) => setPayload(event.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								disabled: busy || running || !subscribed,
								children: t("wizard.submit")
							})
						]
					}),
					!subscribed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: t("wizard.streamPending")
					}),
					running && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cherry-progress",
						"aria-live": "polite",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("wizard.running") }),
							claimId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "cherry-hint cherry-mono",
								children: ["claim ", claimId]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: stage === void 0 ? t("wizard.submitted") : t(STAGE_KEYS[stage] ?? stage) })
						]
					}),
					code !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cherry-code",
						role: "status",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("wizard.code.check") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("output", {
							className: "cherry-code-digits",
							children: code
						})]
					}),
					phase === "done" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-ok",
						children: t("wizard.succeeded")
					}),
					phase === "failed" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-error",
						role: "alert",
						children: timedOut ? t("wizard.timedOut") : t("wizard.failed", { stage: STAGE_KEYS[verdict ?? ""] === void 0 ? t("wizard.unknownError") : t(STAGE_KEYS[verdict ?? ""]) })
					}),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-error",
						role: "alert",
						children: error
					})
				]
			});
		}
		//#endregion
		//#region ui/src/subagentTargets.ts
		/**
		* #261 — the ONE rule that turns "candidate state × stored value × form draft"
		* into "what the control offers, and what it has selected".
		*
		* ## Why this is a module and not a few lines inside the panel
		*
		* A `<select>` whose `value` has no matching `<option>` renders BLANK (or the
		* first option) while React's state still holds the right value. That is the
		* failure this file exists to make impossible: a test that only inspects the
		* request body a save sends is green against a control that shows the operator
		* nothing. So the rule lives where it can be pinned without a DOM, and #262's
		* panel only CONSUMES it.
		*
		* ## The one invariant
		*
		* > `selected` is always the `value` of one of the returned `options`.
		*
		* It holds for EVERY input combination, which is why the empty draft gets an
		* option of its own: `''` is a value the control can hold, so `''` must be a
		* value the control offers. That is the same bug in its smallest form — a
		* pristine form whose select shows the first agent's name while nothing is
		* saved.
		*
		* ## Labels are INJECTED, never produced here
		*
		* This module emits no user-visible string. `ui/AGENTS.md` makes `i18n.ts` the
		* only place Chinese literals live in `ui/src/**` (a source-level guard scans
		* every file), and the panel is where `t()` is available — so the caller passes
		* the three labels in. The ticket's draft signature had the module build
		* `当前值（未知）：<draft>` itself; that cannot coexist with the same ticket's
		* "模块自己不产出用户可见字符串", and the label rule wins because it is
		* enforced by a test.
		*
		* ## What this module deliberately does NOT do
		*
		*  - It does not fetch, cache or retry candidates (#260 owns the endpoint, #262
		*    owns the refresh).
		*  - It does not decide whether the field is editable, nor whether a save is
		*    allowed. It answers "options and selection", nothing else.
		*  - It does not dedupe candidates: a peer that lists the same id twice gets two
		*    options, because inventing a merge rule here would hide a peer fault the
		*    operator can see.
		*/
		/**
		* The sentinel value of the trailing "type it by hand" option.
		*
		* NUL-prefixed to make a collision with a real id implausible — NOT impossible,
		* and the difference matters. The protocol's id type is
		* `opaqueId = unicodeText.min(1).max(256)`, whose only character rule forbids
		* LONE SURROGATES, so a peer may legitimately send a NUL. (An earlier comment
		* here claimed a NUL "cannot appear in JSON or a URL query"; both encodings
		* carry one — `\u0000` and `%00` — so that claim was simply wrong, and a
		* standards review caught it.)
		*
		* The guarantee therefore comes from the RESERVED-VALUE FILTER below, not from
		* this constant: a candidate naming the sentinel is dropped, so even a colliding
		* id cannot produce two options sharing one value. The NUL only makes that drop
		* cost nothing in practice.
		*
		* It is a CONSTANT rather than a sentence — the panel translates the LABEL, and
		* this value must never be rendered.
		*/
		var MANUAL_TARGET_VALUE = "\0manual";
		/**
		* The effective value the control holds.
		*
		* A draft that is EMPTY is not a decision to clear the field: the panel renders
		* this control beside a text input for the same value, so an empty draft while
		* the document holds something is the ordinary "not touched here" state. Falling
		* back to `current` is what keeps a save from silently erasing it — and what
		* keeps the selection non-blank, which is the invariant's other half.
		*/
		function effectiveValue(field) {
			return field.draft === "" ? field.current : field.draft;
		}
		/**
		* The options and the selection for one target field.
		*
		* The order is fixed so a test can assert it whole:
		*
		*  1. the empty option, when the effective value is empty;
		*  2. the candidates, when there are any (verbatim, in the peer's order);
		*  3. the injected `unknown` option, when the effective value is non-empty and
		*     no candidate names it — this is the ONE line that makes a stored-but-gone
		*     id selectable instead of invisible;
		*  4. the manual sentinel, ALWAYS last.
		*
		* ## Two values are RESERVED, and a candidate claiming one is dropped
		*
		* `''` is the control's "nothing chosen" value and {@link MANUAL_TARGET_VALUE}
		* is its "type it by hand" value. A candidate naming either one cannot be shown
		* beside the option that owns that value without producing TWO options with one
		* value — the browser then picks whichever comes first, and "which option is
		* selected" stops being answerable. That is the same class of defect this module
		* exists to prevent, one level down.
		*
		* Dropping is the honest resolution rather than a merge: `''` is not an id at
		* all, and the sentinel carries a NUL no REAL agent or workspace id has ever
		* been seen to carry. Inventing a display for either would put a row in front of
		* the operator that cannot mean anything. The alternative — letting the
		* duplicate through — was the first draft, and a review found it.
		*
		* Note the honest scope of the sentinel's claim: the protocol's `opaqueId` is
		* `unicodeText.min(1).max(256)`, which does NOT forbid a NUL, so a hostile or
		* broken peer really could name the sentinel. THIS FILTER is what keeps the
		* invariant true in that case; the constant's NUL only makes it a curiosity
		* rather than a collision the operator would ever meet.
		*/
		function targetOptions(field, labels) {
			const selected = effectiveValue(field);
			const candidates = (field.candidates.kind === "ready" ? field.candidates.items : []).filter((candidate) => candidate.value !== "" && candidate.value !== "\0manual");
			const options = [];
			if (selected === "") options.push({
				value: "",
				label: labels.empty,
				empty: true
			});
			for (const candidate of candidates) options.push({
				value: candidate.value,
				label: candidate.label
			});
			const named = candidates.some((candidate) => candidate.value === selected);
			if (selected !== "" && !named && selected !== "\0manual") options.push({
				value: selected,
				label: labels.unknown(selected),
				unknown: true
			});
			options.push({
				value: MANUAL_TARGET_VALUE,
				label: labels.manual,
				manual: true
			});
			return {
				options,
				selected
			};
		}
		//#endregion
		//#region ui/src/SubagentPanel.tsx
		/**
		* The 「实验性子智能体」 panel (#233, spec §5.8/§6.5).
		*
		* The user's hard requirement — EXPERIMENTAL, OFF BY DEFAULT, feedback welcome —
		* is not decoration: the badge, the "why experimental" sentence and the feedback
		* line are rendered unconditionally, above the switch and in every state. A
		* panel that only said "experimental" once the feature worked would be silent in
		* exactly the case nobody needs it silent in.
		*
		* Four contracts shape the rest:
		*
		*  - **The status is translated from CODES.** `status.reason` arrives as
		*    `{code, …}` (the first half of #233) and every sentence lives in the
		*    dictionary, so the English page is English all the way down — including the
		*    configuration problems, whose `received` SHAPE is translated too
		*    (`shape.*`) instead of printing a `typeof` result inside a sentence.
		*  - **`unsupported` and `failed` are different screens.** One is a host this
		*    operator cannot change, so the form is read-only and the copy says why; the
		*    other is a typo they can fix HERE, so saving must stay possible.
		*  - **A save does not apply.** The subsystem mounts once per apply (#231), so
		*    the server answers `pendingRestart` and the panel prints that notice only
		*    when it is true. A permanent "restart to apply" line would be a lie to the
		*    operator who just restarted.
		*  - **A refusal never moves the draft.** The local fields are the operator's
		*    edit; a conflict offers a re-read instead of re-seeding over their typing.
		*
		* Fields this form does NOT render as CONTROLS — `cwdMode`, `routes`,
		* `maxInteractionAbandons` — are carried through from the stored document
		* untouched. Dropping them would make a save delete configuration the operator
		* never saw. Two of them still get a read-only line: `cwdMode` because it has
		* no consumer yet (D1), `routes` because it has one (a per-directory device and
		* workspace) and a problem can name an entry this page cannot edit.
		*/
		/**
		* The feedback entry point, and the SAME string the README pair quotes (#234).
		*
		* The issues list, not a new label and not a versioned path: a deep link into a
		* filter would rot, and the point of the line is "here is where to tell us".
		*/
		var FEEDBACK_URL = "https://github.com/SAXEM1997/dsh-cherry-bridge/issues";
		/** The dictionary keys behind {@link ReceivedShape}, so the shape is translated too. */
		var SHAPE_KEYS = {
			string: "shape.string",
			number: "shape.number",
			boolean: "shape.boolean",
			object: "shape.object",
			array: "shape.array",
			null: "shape.null",
			undefined: "shape.undefined",
			function: "shape.function",
			symbol: "shape.symbol",
			bigint: "shape.bigint",
			NaN: "shape.NaN",
			Infinity: "shape.Infinity",
			"-Infinity": "shape.-Infinity"
		};
		/**
		* The shape that arrived, in the current language.
		*
		* Falls back to the raw token for a shape this build does not know: a newer
		* server sending one must not blank the sentence, and printing `string` inside a
		* Chinese sentence is still better than printing nothing.
		*/
		function shapeText(t, shape) {
			const key = SHAPE_KEYS[shape];
			return key === void 0 ? shape : t(key);
		}
		/** One configuration problem as a sentence, from its code. */
		function problemText(t, problem) {
			switch (problem.code) {
				case "not-string": return t("subagent.problem.not-string", {
					field: problem.field,
					received: shapeText(t, problem.received)
				});
				case "not-boolean": return t("subagent.problem.not-boolean", {
					field: problem.field,
					received: shapeText(t, problem.received)
				});
				case "not-array": return t("subagent.problem.not-array", {
					field: problem.field,
					received: shapeText(t, problem.received)
				});
				case "not-object": return t("subagent.problem.not-object", {
					field: problem.field,
					received: shapeText(t, problem.received)
				});
				case "empty": return t("subagent.problem.empty", { field: problem.field });
				case "missing": return t("subagent.problem.missing", { field: problem.field });
				case "route-cwd-prefix": return t("subagent.problem.route-cwd-prefix", { field: problem.field });
				case "out-of-range": return t("subagent.problem.out-of-range", {
					field: problem.field,
					min: problem.min,
					max: problem.max,
					received: shapeText(t, problem.received)
				});
				case "enum": return t("subagent.problem.enum", {
					field: problem.field,
					allowed: problem.allowed.join(t("list.separator")),
					received: shapeText(t, problem.received)
				});
				case "exclusive": return t("subagent.problem.exclusive", {
					field: problem.field,
					other: problem.other
				});
				default: return problem.code;
			}
		}
		/** Why the provider is up but the tool is not, from its code. */
		function toolProblemText(t, problem) {
			switch (problem.code) {
				case "no-tools-service": return t("subagent.tool.no-tools-service");
				case "no-start-activation": return t("subagent.tool.no-start-activation");
				case "no-step-condition": return t("subagent.tool.no-step-condition");
				case "host-refused": return t("subagent.tool.host-refused", { message: problem.message });
				default: return problem.code;
			}
		}
		/**
		* The four states, as one block.
		*
		* `state` alone would not be enough: `ready` covers both "provider and tool" and
		* "provider only", and `failed` covers a broken config and a refused provider
		* registration. The REASON is what the operator acts on, so this switches on it
		* and lets `state` describe what is registered.
		*/
		function StatusBlock({ status }) {
			const t = useT();
			const reason = status.reason;
			switch (reason.code) {
				case "disabled": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "cherry-hint",
					children: t("subagent.status.disabled")
				});
				case "awaiting-injection": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "cherry-hint",
					children: t("subagent.status.awaiting-injection")
				});
				case "unsupported": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "cherry-hint",
					children: t("subagent.status.unsupported")
				});
				case "invalid": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "cherry-hint",
					children: t("subagent.status.invalid")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: "cherry-subagent-problems",
					children: reason.problems.map((problem, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: problemText(t, problem) }, `${problem.code}-${index}`))
				})] });
				case "provider-refused": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "cherry-hint",
					children: t("subagent.status.provider-refused", { message: reason.message })
				});
				case "ready": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "cherry-hint",
					children: t("subagent.status.ready", {
						providerName: reason.providerName,
						toolName: reason.toolName
					})
				});
				case "ready-without-tool": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "cherry-hint",
					children: t("subagent.status.ready-without-tool", {
						providerName: reason.providerName,
						toolName: reason.toolName
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "cherry-hint",
					children: toolProblemText(t, reason.problem)
				})] });
				default: return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "cherry-hint cherry-mono",
					children: reason.code
				});
			}
		}
		/** Seed the form from a document. `revision` and the unrendered fields stay behind. */
		function draftOf(config) {
			return {
				enabled: config.enabled === true,
				device: config.device ?? "",
				agentId: config.agentId ?? "",
				workspace: config.workspaceKind === "system" ? "system" : "registry",
				workspaceId: config.workspaceId ?? "",
				timeoutMs: config.timeoutMs === void 0 ? "" : String(config.timeoutMs)
			};
		}
		/**
		* The write body: the RENDERED fields from the draft, everything else from the
		* stored document.
		*
		* `expectedRevision` is the stored `revision`, which is what the read-modify-
		* write lock is for — and the reason the form must never send a revision it did
		* not read.
		*/
		function bodyOf(draft, stored) {
			const timeout = Number(draft.timeoutMs);
			return {
				...stored,
				enabled: draft.enabled,
				device: draft.device.trim(),
				agentId: draft.agentId.trim(),
				...draft.workspace === "system" ? {
					workspaceKind: "system",
					workspaceId: void 0
				} : {
					workspaceKind: void 0,
					workspaceId: draft.workspaceId.trim()
				},
				...draft.timeoutMs.trim() === "" || !Number.isFinite(timeout) ? { timeoutMs: void 0 } : { timeoutMs: timeout },
				expectedRevision: stored.revision
			};
		}
		/**
		* The three refusal codes this panel has a sentence for, as a TABLE rather than
		* an interpolated key.
		*
		* A `\`subagent.saveFailure.${code}\`` lookup would read the dictionary with a
		* key no source file spells, which makes all three sentences look dead to
		* `tests/unit/i18nUsage.test.ts` — the same reason `ToolScopePanel` keeps a
		* `SAVE_FAILURE_KEYS` table. A code outside the table falls back to the server's
		* own verdict, which is the honest line for a refusal this build does not know.
		*/
		var SAVE_FAILURE_KEYS$1 = {
			"subagent-revision-conflict": "subagent.saveFailure.subagent-revision-conflict",
			"missing-expected-revision": "subagent.saveFailure.missing-expected-revision",
			"invalid-request": "subagent.saveFailure.invalid-request"
		};
		/** A save refusal as a sentence: a known code gets its own, anything else the server's. */
		function failureSentence(t, error) {
			if (error instanceof Error && error.message === "cherry-remote.request-timeout") return t("subagent.error.timeout");
			if (error instanceof ApiError) {
				const key = SAVE_FAILURE_KEYS$1[error.code];
				return key === void 0 ? t("subagent.serverSaid", {
					code: error.code,
					status: error.status
				}) : t(key);
			}
			return error instanceof Error ? error.message : String(error);
		}
		/**
		* The longest id shown inside an option's label before it is clipped.
		*
		* The `value` is ALWAYS the full id — only the visible text is shortened, because
		* a 200-character id would otherwise push the name (the part an operator reads)
		* off the screen. `…` rather than a silent cut, so a clipped id is visibly
		* clipped.
		*/
		var ID_DISPLAY_LIMIT = 28;
		/**
		* `<name>（<id>）`, or the bare id when the peer reported no name.
		*
		* The JOIN is a dictionary key, not a literal: the brackets around the id are
		* copy, and a Chinese page wants `（…）` where an English one wants `(…)`. A
		* literal here would be the only place an English operator met full-width
		* punctuation.
		*/
		function withId(t, name, id) {
			const shown = id.length <= ID_DISPLAY_LIMIT ? id : `${id.slice(0, 27)}…`;
			return name === void 0 || name === "" ? shown : t("subagent.targets.withId", {
				name,
				id: shown
			});
		}
		/**
		* The candidate endpoint's problem codes this panel has a sentence for, as a
		* literal TABLE.
		*
		* A `\`subagent.targets.problem.${code}\`` lookup would read the dictionary with
		* a key no source file spells, which makes every sentence look dead to
		* `tests/unit/i18nUsage.test.ts` — the same reason `SAVE_FAILURE_KEYS` above is a
		* table. A code outside it falls back to `unreachable`, which names the code and
		* still tells the operator the one thing that matters: hand entry still works.
		*/
		var TARGET_PROBLEM_KEYS = {
			"device-unavailable": "subagent.targets.problem.deviceUnavailable",
			"not-found": "subagent.targets.problem.notFound",
			"ambiguous-device": "subagent.targets.problem.ambiguous"
		};
		/** A candidate-refresh failure as a sentence: by CODE, never the server's prose. */
		function targetProblemText(t, problem) {
			const key = TARGET_PROBLEM_KEYS[problem.code];
			return key === void 0 ? t("subagent.targets.problem.unreachable", { code: problem.code }) : t(key);
		}
		/**
		* A thrown call as a {@link SubagentTargetsProblem}.
		*
		* `GET /subagent/targets` answers its refusals IN BAND (`{problem}` at 200), so
		* anything that THROWS is off-contract and has no body to read: a timeout
		* (`REQUEST_TIMEOUT`), a dead socket (`TypeError`), or a 4xx this page caused.
		* Each gets a synthetic code so the renderer has one shape to handle. An
		* `ApiError` keeps the SERVER's code (it is a refusal this page caused, and the
		* code names which); the other two are the panel's own.
		*
		* NOTHING here prints `problem.message`: the endpoint's sentences are English
		* templates, and this page is Chinese. The trade is real and worth stating —
		* `archive-quarantined`'s recovery guidance lives in its `message` and is
		* therefore not shown. Translating the code is what the rest of this page does
		* with server verdicts, and one English paragraph in the middle of a Chinese
		* form is worse than a sentence that names the code.
		*/
		function thrownProblem(t, error) {
			if (error instanceof ApiError) return {
				code: error.code,
				message: error.message
			};
			if (error instanceof Error && error.message === "cherry-remote.request-timeout") return {
				code: "request-timeout",
				message: t("subagent.targets.problem.unreachable", { code: "request-timeout" })
			};
			return {
				code: "client-error",
				message: error instanceof Error ? error.message : String(error)
			};
		}
		/**
		* One target field as a `<select>`, rendered ENTIRELY from #261's
		* {@link targetOptions}.
		*
		* The panel contributes three things and nothing else: the labels, the candidate
		* state, and what a change means. It does NOT decide which option is selected —
		* that rule lives in the module, because the failure it prevents (a `<select>`
		* whose value matches no option renders blank while the form state is correct) is
		* invisible to any assertion on the request body.
		*/
		function TargetSelect(props) {
			const { options, selected } = targetOptions(props.field, props.labels);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: "cherry-subagent-field",
				children: [props.label, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
					className: "cherry-subagent-select",
					value: selected,
					disabled: props.disabled,
					onChange: (event) => props.onChange(event.target.value),
					children: options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: option.value,
						children: option.label
					}, option.value))
				})]
			});
		}
		function SubagentPanel({ client = defaultSubagentClient, devices = [] }) {
			const t = useT();
			const [data, setData] = (0, react.useState)(void 0);
			const [loadError, setLoadError] = (0, react.useState)(void 0);
			const [draft, setDraft] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [saved, setSaved] = (0, react.useState)(false);
			const [failure, setFailure] = (0, react.useState)(void 0);
			const [agentAnswer, setAgentAnswer] = (0, react.useState)(void 0);
			const [workspaceAnswer, setWorkspaceAnswer] = (0, react.useState)(void 0);
			/** The operator asked to type a value by hand instead of picking one. */
			const [manual, setManual] = (0, react.useState)(void 0);
			/**
			* The device the AGENT list is asked for.
			*
			* Not `draft.device`: the manual box edits that on every keystroke, and each
			* one would be a real peer walk. This moves when the document loads, when the
			* operator PICKS a device, and when they leave the manual box — the moments the
			* answer can actually change.
			*/
			const [committedDevice, setCommittedDevice] = (0, react.useState)("");
			const accept = (0, react.useCallback)((answer) => {
				setData(answer);
				setDraft(draftOf(answer.subagent));
				setCommittedDevice(answer.subagent.device?.trim() ?? "");
				setManual(void 0);
			}, []);
			const load = (0, react.useCallback)(async () => {
				setLoadError(void 0);
				try {
					accept(await client.get());
				} catch (error) {
					setLoadError(failureSentence(t, error));
				}
			}, [
				accept,
				client,
				t
			]);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			const device = committedDevice;
			(0, react.useEffect)(() => {
				if (device === "") {
					setAgentAnswer(void 0);
					return;
				}
				let cancelled = false;
				client.targets(device).then((answer) => {
					if (cancelled) return;
					setAgentAnswer({
						device,
						candidates: "problem" in answer ? {
							kind: "unavailable",
							problem: answer.problem
						} : {
							kind: "ready",
							items: answer.agents.map((agent) => ({
								value: agent.agentId,
								label: withId(t, agent.name, agent.agentId)
							}))
						},
						..."problem" in answer || answer.truncated === void 0 ? {} : { truncated: answer.truncated.lists }
					});
				}).catch((error) => {
					if (cancelled) return;
					setAgentAnswer({
						device,
						candidates: {
							kind: "unavailable",
							problem: thrownProblem(t, error)
						}
					});
				});
				return () => {
					cancelled = true;
				};
			}, [
				client,
				device,
				t
			]);
			const agentCandidates = agentAnswer === void 0 || agentAnswer.device !== device ? device === "" ? {
				kind: "ready",
				items: []
			} : { kind: "loading" } : agentAnswer.candidates;
			/**
			* The agent the WORKSPACE list may be asked about: the draft's, when the list
			* for this device names it.
			*
			* DERIVED, not remembered. A remembered copy of "which agent did we choose"
			* goes stale the moment the operator types an id by hand — the workspace list
			* would keep offering the PREVIOUS agent's workspaces, and a save would send
			* the new agent with the old workspace. That is the same cross-contamination
			* this ticket forbids across devices, one level down.
			*/
			const draftAgentId = draft?.agentId.trim() ?? "";
			const chosenAgentId = agentCandidates.kind === "ready" && agentCandidates.items.some((candidate) => candidate.value === draftAgentId) ? draftAgentId : "";
			/** The chosen agent is on THIS device's list, so the workspace walk may run. */
			const chosenAgentKnown = chosenAgentId !== "";
			const workspaceKey = `${device}\u0000${chosenAgentId}`;
			(0, react.useEffect)(() => {
				if (!chosenAgentKnown) {
					setWorkspaceAnswer(void 0);
					return;
				}
				let cancelled = false;
				client.targets(device, chosenAgentId).then((answer) => {
					if (cancelled) return;
					setWorkspaceAnswer({
						key: workspaceKey,
						candidates: "problem" in answer ? {
							kind: "unavailable",
							problem: answer.problem
						} : {
							kind: "ready",
							items: (answer.workspaces ?? []).map((workspace) => ({
								value: workspace.workspaceId,
								label: withId(t, workspace.name, workspace.workspaceId)
							}))
						},
						systemWorkspace: "problem" in answer ? void 0 : answer.systemWorkspace
					});
				}).catch((error) => {
					if (cancelled) return;
					setWorkspaceAnswer({
						key: workspaceKey,
						candidates: {
							kind: "unavailable",
							problem: thrownProblem(t, error)
						},
						systemWorkspace: void 0
					});
				});
				return () => {
					cancelled = true;
				};
			}, [
				client,
				device,
				chosenAgentId,
				chosenAgentKnown,
				workspaceKey,
				t
			]);
			const workspaceCandidates = workspaceAnswer === void 0 || workspaceAnswer.key !== workspaceKey ? chosenAgentId === "" ? {
				kind: "ready",
				items: []
			} : { kind: "loading" } : workspaceAnswer.candidates;
			/**
			* `true` supported, `false` the peer SAYS it has none, `undefined` we could not
			* ask. Three states, because "unknown" must not be rendered as "unsupported":
			* an offline desktop is still configurable, and disabling a control on a failed
			* request would be the page inventing a fact.
			*/
			const systemWorkspace = workspaceAnswer !== void 0 && workspaceAnswer.key === workspaceKey ? workspaceAnswer.systemWorkspace : void 0;
			/** The lists are only as good as the key they answered for. */
			const truncatedLists = agentAnswer !== void 0 && agentAnswer.device === device ? agentAnswer.truncated : void 0;
			const save = async () => {
				if (effective === void 0 || data === void 0) return;
				setBusy(true);
				setSaved(false);
				setFailure(void 0);
				try {
					accept(await client.put(bodyOf(effective, data.subagent)));
					setSaved(true);
				} catch (error) {
					setFailure(failureSentence(t, error));
				} finally {
					setBusy(false);
				}
			};
			const readOnly = data !== void 0 && data.status.state === "unsupported";
			const targetLabels = {
				unknown: (value) => t("subagent.targets.unknown", { value }),
				manual: t("subagent.targets.manual"),
				empty: t("subagent.targets.unset")
			};
			const storedDevice = data?.subagent.device ?? "";
			const deviceChanged = draft !== void 0 && draft.device.trim() !== storedDevice;
			const agentChanged = draft !== void 0 && draftAgentId !== (data?.subagent.agentId ?? "");
			const workspaceStale = deviceChanged || agentChanged;
			const effective = draft === void 0 ? void 0 : {
				...draft,
				agentId: deviceChanged ? "" : draft.agentId,
				workspaceId: workspaceStale ? "" : draft.workspaceId
			};
			const agentField = {
				current: deviceChanged ? "" : data?.subagent.agentId ?? "",
				draft: manual === "agent" ? MANUAL_TARGET_VALUE : effective?.agentId ?? "",
				candidates: agentCandidates
			};
			const workspaceField = {
				current: workspaceStale ? "" : data?.subagent.workspaceId ?? "",
				draft: manual === "workspace" ? MANUAL_TARGET_VALUE : effective?.workspaceId ?? "",
				candidates: workspaceCandidates
			};
			const deviceField = {
				current: storedDevice,
				draft: manual === "device" ? MANUAL_TARGET_VALUE : draft?.device ?? "",
				candidates: {
					kind: "ready",
					items: devices.map((device) => ({
						value: device.deviceId,
						label: `${withId(t, device.displayName, device.deviceId)} · ${t(STATE_KEYS[device.state])}`
					}))
				}
			};
			const workspaceProblem = workspaceCandidates.kind === "unavailable" ? workspaceCandidates.problem : void 0;
			const agentProblem = agentCandidates.kind === "unavailable" ? agentCandidates.problem : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "cherry-panel",
				"aria-labelledby": "cherry-subagent-title",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
						id: "cherry-subagent-title",
						children: [
							t("subagent.heading"),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cherry-experimental",
								children: t("subagent.badge")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: t("subagent.experimental")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: t("subagent.defaultOff")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cherry-hint",
						children: [
							t("subagent.feedback"),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								href: FEEDBACK_URL,
								target: "_blank",
								rel: "noreferrer noopener",
								children: t("subagent.feedbackLink")
							})
						]
					}),
					loadError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-error",
						role: "alert",
						children: t("subagent.loadError", { error: loadError })
					}),
					data === void 0 && loadError === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: t("subagent.loading")
					}),
					data !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("subagent.status.heading") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBlock, { status: data.status }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cherry-hint",
							children: data.source === "file" ? t("subagent.source.file") : t("subagent.source.config")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cherry-hint",
							children: t("subagent.scopeNote")
						}),
						data.pendingRestart && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cherry-ok",
							role: "status",
							children: t("subagent.pendingRestart")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cherry-hint cherry-mono",
							children: t("subagent.revision", { revision: data.subagent.revision })
						}),
						draft !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "cherry-subagent-form",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "cherry-subagent-check",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: draft.enabled,
										disabled: readOnly,
										onChange: (event) => {
											const enabled = event.target.checked;
											setDraft({
												...draft,
												enabled
											});
										}
									}), t("subagent.enabled")]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TargetSelect, {
									label: t("subagent.device"),
									field: deviceField,
									labels: targetLabels,
									disabled: readOnly,
									onChange: (value) => {
										if (value === "\0manual") {
											setManual("device");
											return;
										}
										setManual(void 0);
										setDraft({
											...draft,
											device: value
										});
										setCommittedDevice(value.trim());
									}
								}),
								manual === "device" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "cherry-subagent-field",
									children: [t("subagent.deviceManual"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "text",
										value: draft.device,
										disabled: readOnly,
										onChange: (event) => setDraft({
											...draft,
											device: event.target.value
										}),
										onBlur: (event) => setCommittedDevice(event.target.value.trim()),
										onKeyDown: (event) => {
											if (event.key === "Enter") setCommittedDevice(event.currentTarget.value.trim());
										}
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-hint",
									children: t("subagent.deviceHint")
								}),
								deviceChanged && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-hint",
									children: t("subagent.targets.reselectAgent")
								}),
								systemWorkspace === false && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-hint",
									children: t("subagent.workspace.systemUnavailable")
								}),
								systemWorkspace === false && draft.workspace === "system" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-hint",
									children: t("subagent.workspace.systemConflict")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TargetSelect, {
									label: t("subagent.agentId"),
									field: agentField,
									labels: targetLabels,
									disabled: readOnly,
									onChange: (value) => {
										if (value === "\0manual") {
											setManual("agent");
											return;
										}
										setManual(void 0);
										setDraft({
											...draft,
											agentId: value
										});
									}
								}),
								manual === "agent" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "cherry-subagent-field",
									children: [t("subagent.agentIdManual"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "text",
										value: draft.agentId,
										disabled: readOnly,
										onChange: (event) => setDraft({
											...draft,
											agentId: event.target.value
										})
									})]
								}),
								agentProblem !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-hint",
									children: targetProblemText(t, agentProblem)
								}),
								agentProblem === void 0 && draft.device.trim() === "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-hint",
									children: t("subagent.targets.pickDevice")
								}),
								agentProblem === void 0 && draft.device.trim() !== "" && agentCandidates.kind === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-hint",
									children: t("subagent.targets.loading")
								}),
								agentProblem === void 0 && draft.device.trim() !== "" && agentCandidates.kind === "ready" && agentCandidates.items.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-hint",
									children: t("subagent.targets.empty")
								}),
								truncatedLists !== void 0 && truncatedLists.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-hint",
									children: t("subagent.targets.truncated", { lists: truncatedLists.join(t("list.separator")) })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
									className: "cherry-scope-options",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", { children: t("subagent.workspace.legend") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: "cherry-subagent-check",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "radio",
												name: "subagent-workspace",
												checked: draft.workspace === "registry",
												disabled: readOnly,
												onChange: () => setDraft({
													...draft,
													workspace: "registry"
												})
											}), t("subagent.workspace.registry")]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: "cherry-subagent-check",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "radio",
												name: "subagent-workspace",
												checked: draft.workspace === "system",
												disabled: readOnly || systemWorkspace === false,
												onChange: () => setDraft({
													...draft,
													workspace: "system"
												})
											}), t("subagent.workspace.system")]
										})
									]
								}),
								draft.workspace === "registry" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TargetSelect, {
										label: t("subagent.workspaceId"),
										field: workspaceField,
										labels: targetLabels,
										disabled: readOnly,
										onChange: (value) => {
											if (value === "\0manual") {
												setManual("workspace");
												return;
											}
											setManual(void 0);
											setDraft({
												...draft,
												workspaceId: value
											});
										}
									}),
									manual === "workspace" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "cherry-subagent-field",
										children: [t("subagent.workspaceIdManual"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "text",
											value: draft.workspaceId,
											disabled: readOnly,
											onChange: (event) => setDraft({
												...draft,
												workspaceId: event.target.value
											})
										})]
									}),
									workspaceStale && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "cherry-hint",
										children: t("subagent.targets.reselectWorkspace")
									}),
									workspaceProblem !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "cherry-hint",
										children: targetProblemText(t, workspaceProblem)
									})
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "cherry-subagent-field",
									children: [t("subagent.timeoutMs"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "number",
										value: draft.timeoutMs,
										disabled: readOnly,
										onChange: (event) => setDraft({
											...draft,
											timeoutMs: event.target.value
										})
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-hint",
									children: t("subagent.timeoutHint")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-hint cherry-mono",
									children: t("subagent.cwdMode", { value: data.subagent.cwdMode ?? "isolated" })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-hint cherry-mono",
									children: t("subagent.routes", { value: JSON.stringify(data.subagent.routes ?? []) })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "cherry-scope-save",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: busy || readOnly,
										onClick: () => void save(),
										children: t("subagent.save")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: busy,
										onClick: () => void load(),
										children: t("subagent.reread")
									})]
								})
							]
						}),
						saved && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cherry-ok",
							role: "status",
							children: t("subagent.saved")
						}),
						failure !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cherry-error",
							role: "alert",
							children: t("subagent.saveFailed", { cause: failure })
						})
					] })
				]
			});
		}
		//#endregion
		//#region ui/src/ToolScopePanel.tsx
		/**
		* The 「启用范围」 panel: which workspaces the `cherry_*` tools appear in.
		*
		* The panel is a READ-MODIFY-WRITE client of the scope document (spec §6.3), and
		* three contract details shape everything below:
		*
		*  - **Every verdict comes from a stable code, never from prose.** A refused
		*    `PUT` arrives as an {@link ApiError} whose `code` is the server's
		*    (`invalid-scope` / `missing-expected-revision` / `scope-revision-conflict` /
		*    `workspace-list-unavailable` / `scope-version-unsupported`), and the copy
		*    per branch is the panel's own. The prose is deliberately not echoed: a
		*    refusal resolved against a message would break the moment the server's
		*    wording changed, and `scope-version-unsupported` must never read as "just
		*    re-read and retry" — re-reading cannot change the document's version.
		*  - **A failure never moves the draft.** The local `mode`/`workspaceIds` are
		*    the operator's edit; a refusal leaves them exactly where they were (§6.4),
		*    and it triggers no re-read either — re-seeding overwrites those ticks, so
		*    the conflict's recovery is an explicit click on the control the conflict
		*    arm carries (see `reread`).
		*  - **Disabling the save has THREE independent sources** — `unsupported`,
		*    the `scope-version` degradation and the `workspace-list` degradation — and
		*    `pending` is none of them. They may appear side by side and none may be
		*    derived from another, so the notices are rendered from independent
		*    conditions rather than from one combined verdict.
		*
		* `staleWorkspaceIds` and `pathUnmatched` are separated for the same reason: the
		* first is a saved pick the registry no longer has (cleared only by a save, whose
		* `pruned` echo the panel shows), the second is a pure diagnosis of "ticked, yet
		* no tools" that changes nothing and triggers no write.
		*/
		/**
		* D11's empty-state wording, one sentence per mode, as dictionary KEYS.
		*
		* They are NOT interchangeable: under `selected` an empty list means the tools
		* are enabled nowhere, while under `global` the ticks are not judgement input at
		* all (B2). One sentence for both would state the opposite of the truth in one
		* of the two modes.
		*
		* Keys, not text: `resolveEmptyHint` is a module-level function and cannot reach
		* the component's `t`, so it takes the translator as a parameter and looks the
		* sentence up through these.
		*/
		var SELECTED_EMPTY_KEY = "scope.empty.selected";
		var GLOBAL_EMPTY_KEY = "scope.empty.global";
		/**
		* B15's copy boundary, in the positive form, as a dictionary KEY.
		*
		* The page may only claim that THIS PLUGIN did not shadow the tools. Whether a
		* given session sees them can still be decided upstream by an `allow`-shaped
		* filter (a sub-agent's `toolFilter`), which is accepted behaviour — so any
		* "the model can see / call them" phrasing would promise something this plugin
		* cannot keep.
		*/
		var EFFECT_NOTE_KEY = "scope.effectNote";
		/**
		* One line per degradation source, as a module-level PURE KEY table; the
		* server's own reason is shown beside it.
		*
		* `install` is the general one — its four writers cover a `schemas()` read that
		* could not compute a target, a layer whose release threw, an agent with no
		* `agent.ctx.tools.restrict`, and a `restrict()` the host refused (the `reason`
		* says which) — so the line states the CONSEQUENCE common to all four rather
		* than any one cause. It says 曾 on purpose: the note is append-only (cleared
		* only by a successful workspace-list read), so after a recovered round the
		* surviving claim is that one application failed earlier in this session.
		*
		* The values are KEYS and only keys: the table is read at MODULE scope (the
		* render below) and inside `resolveEmptyHint`, where no `t` exists, so it must
		* not close over one. The text itself lives in `ui/src/i18n.ts`, the single
		* source of truth for every Chinese string the page shows.
		*/
		var DEGRADED_KEYS = {
			install: "scope.degraded.install",
			"workspace-list": "scope.degraded.workspace-list",
			"visibility-only": "scope.degraded.visibility-only",
			"scope-version": "scope.degraded.scope-version",
			"path-normalization": "scope.degraded.path-normalization"
		};
		/**
		* The dictionary KEYS for each stable `PUT` refusal code.
		*
		* `scope-revision-conflict` is the ONE refusal whose copy and whose control
		* agree: its message instructs a RE-READ, and its rendering carries the control
		* that performs it (`reread`) — an instruction with no way to follow it is how
		* the operator ends up re-sending the same stale revision forever. Two codes
		* instruct a re-read in their wording (this one and `missing-expected-revision`,
		* below), but only this one is REACHABLE from this panel: `save` always sends a
		* base (`expectedRevision: revision`), so the missing-base refusal exists for a
		* direct API caller and can never fire here. Reachability — not any claim about
		* which codes a stale read would refresh — is why the control belongs to this
		* arm, and to this arm only.
		*
		* `scope-version-unsupported` gets its own recovery sentence: re-reading cannot
		* change the document's version, so sending the operator round that loop would
		* be an instruction that cannot work (§6.3).
		*
		* A key table rather than a text table, for the same reason as
		* {@link DEGRADED_KEYS}: it is consumed inside `save`'s `useCallback`, which
		* reads the component's `t` (a dependency of that callback) — a text table here
		* would be a second copy of the Chinese in a file that is meant to hold none.
		* An unknown code falls through to {@link SAVE_FAILED_KEY}, whose `{cause}`
		* placeholder carries the server's own message.
		*/
		var SAVE_FAILURE_KEYS = {
			"scope-revision-conflict": "scope.saveFailure.scope-revision-conflict",
			"scope-version-unsupported": "scope.saveFailure.scope-version-unsupported",
			"invalid-scope": "scope.saveFailure.invalid-scope",
			"missing-expected-revision": "scope.saveFailure.missing-expected-revision",
			"workspace-list-unavailable": "scope.saveFailure.workspace-list-unavailable"
		};
		/**
		* The refusal copy for a code this panel has no entry for.
		*
		* Deliberately NOT in {@link SAVE_FAILURE_KEYS}: it is the `??` arm rather than
		* a sixth code, and keeping it out is what makes "every entry is a real server
		* code" checkable by eye.
		*/
		var SAVE_FAILED_KEY = "scope.saveFailed";
		/**
		* The panel's own description of a failure.
		*
		* A request that never answered arrives as `api.ts`'s internal marker (the
		* page-wide ceiling, issue #180), which must become a sentence before it reaches
		* any of the three places this feeds — the read error, the save failure and the
		* re-read error. Everything else is the server's own message, interpolated.
		*/
		var describeCause$1 = (t, cause) => cause instanceof Error && cause.message === "cherry-remote.request-timeout" ? t("scope.error.timeout") : cause instanceof Error ? cause.message : String(cause);
		/**
		* D11's empty state for the current draft, or `undefined` when nothing may be
		* claimed yet.
		*
		* Three exclusions, each of which would otherwise let the sentence contradict
		* the state it describes:
		*
		*  - **before the read lands** the draft only LOOKS empty (it is seeded by that
		*    read), and "这些工具不会出现在任何会话里" would be a claim about a document
		*    nobody has read;
		*  - **while the document's version is unsupported** the reason is a degradation
		*    with its own warning, not the operator's empty selection;
		*  - hence only a READ document reaches the two sentences below — where an empty
		*    `selected` list is exactly what a CORRUPT document falls back to (B9), which
		*    is why that warning shares this one slot rather than getting a region of its
		*    own.
		*
		* `t` is a PARAMETER rather than a module-level import: this function is called
		* during a render with the component's own translator, and `t` changes identity
		* whenever the locale store does — closing over a module-level one would pin the
		* sentence to whatever language was active when the module first loaded.
		*/
		function resolveEmptyHint(input, t) {
			if (!input.loaded) return void 0;
			if (input.mode === "selected" && input.scopeVersionDegraded) return void 0;
			if (input.mode === "global") return t(GLOBAL_EMPTY_KEY);
			return input.count === 0 ? t(SELECTED_EMPTY_KEY) : void 0;
		}
		function ToolScopePanel({ client = defaultScopeClient }) {
			const t = useT();
			const [data, setData] = (0, react.useState)(void 0);
			const [loadError, setLoadError] = (0, react.useState)(void 0);
			const [mode, setMode] = (0, react.useState)("selected");
			const [ids, setIds] = (0, react.useState)([]);
			const [revision, setRevision] = (0, react.useState)(0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [saved, setSaved] = (0, react.useState)(void 0);
			const [failure, setFailure] = (0, react.useState)(void 0);
			const [versionBlocked, setVersionBlocked] = (0, react.useState)(false);
			/**
			* The ONE place a served document becomes the draft.
			*
			* Shared by the mount read and the operator-requested re-read so the two
			* cannot drift: `mode`, the ticked ids and — the reason this is a function at
			* all — the `revision` the NEXT save bases itself on all come from the
			* response in one step.
			*/
			const seedFromDocument = (0, react.useCallback)((response) => {
				setData(response);
				setMode(response.scope.mode);
				setIds([...response.scope.workspaceIds]);
				setRevision(response.scope.revision);
				setLoadError(void 0);
			}, []);
			(0, react.useEffect)(() => {
				let live = true;
				client.get().then((response) => {
					if (!live) return;
					seedFromDocument(response);
				}, (cause) => {
					if (live) setLoadError(describeCause$1(t, cause));
				});
				return () => {
					live = false;
				};
			}, [client, seedFromDocument]);
			const degraded = data?.host.degraded ?? [];
			const hasDegraded = (source) => degraded.some((note) => note.source === source);
			const unsupported = data?.host.state === "unsupported";
			const pending = data?.host.state === "pending";
			const scopeVersionDegraded = hasDegraded("scope-version");
			const listUnavailable = hasDegraded("workspace-list");
			const loaded = data !== void 0;
			const saveDisabled = busy || !loaded || unsupported || scopeVersionDegraded || listUnavailable || versionBlocked;
			/** The rows the operator can tick: registry workspaces, plus unnamed saved ids. */
			const options = (0, react.useMemo)(() => {
				const list = [...data?.workspaces ?? []];
				const known = new Set(list.map((workspace) => workspace.id));
				const stale = new Set(data?.staleWorkspaceIds ?? []);
				for (const id of ids) {
					if (known.has(id) || stale.has(id)) continue;
					list.push({
						id,
						title: id,
						path: t("scope.workspaceUnknown")
					});
				}
				return list;
			}, [
				data,
				ids,
				t
			]);
			const staleShown = (data?.staleWorkspaceIds ?? []).filter((id) => ids.includes(id));
			const unmatched = data?.pathUnmatched ?? [];
			/**
			* D11's empty state, or nothing at all — see {@link resolveEmptyHint} for the
			* three cases that must stay silent rather than describe a state wrongly.
			*/
			const emptyHint = resolveEmptyHint({
				loaded,
				mode,
				count: ids.length,
				scopeVersionDegraded
			}, t);
			const toggle = (id) => {
				setIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
			};
			const save = (0, react.useCallback)(() => {
				setBusy(true);
				setFailure(void 0);
				setSaved(void 0);
				client.put({
					mode,
					workspaceIds: [...ids],
					expectedRevision: revision
				}).then((result) => {
					setBusy(false);
					setSaved({ pruned: [...result.pruned ?? []] });
					setMode(result.scope.mode);
					setIds([...result.scope.workspaceIds]);
					setRevision(result.scope.revision);
					setVersionBlocked(false);
				}, (cause) => {
					setBusy(false);
					const code = cause instanceof ApiError ? cause.code : void 0;
					const status = cause instanceof ApiError ? cause.status : void 0;
					if (code === "scope-version-unsupported") setVersionBlocked(true);
					setFailure({
						code: code ?? "request-failed",
						label: code === void 0 ? t(SAVE_FAILED_KEY, { cause: describeCause$1(t, cause) }) : t(SAVE_FAILURE_KEYS[code] ?? SAVE_FAILED_KEY, { cause: describeCause$1(t, cause) }),
						detail: status === void 0 ? void 0 : t("scope.serverSaid", {
							code,
							status
						})
					});
				});
			}, [
				client,
				ids,
				mode,
				revision,
				t
			]);
			/**
			* The operator-requested RE-READ: the conflict's own recovery (§6.4).
			*
			* A 409 tells the operator to re-read, so the panel must be able to do it —
			* the mount read is otherwise the page's only `GET`, which leaves every later
			* save re-sending the same stale `revision` and 409-ing until a full reload.
			*
			* Nothing here runs automatically on a refusal: re-seeding REPLACES the draft,
			* so doing it silently in response to a failed save would discard exactly the
			* edit that caused the conflict. It runs only from the control below — and
			* because it re-seeds, it also replaces the `revision` the next `PUT` sends.
			*
			* The conflict message is cleared only once the read SUCCEEDS: if the `GET`
			* itself fails the conflict still stands, the control stays on screen, and
			* `loadError` says what went wrong.
			*/
			const reread = (0, react.useCallback)(() => {
				setBusy(true);
				client.get().then((response) => {
					setBusy(false);
					seedFromDocument(response);
					setFailure(void 0);
				}, (cause) => {
					setBusy(false);
					setLoadError(describeCause$1(t, cause));
				});
			}, [client, seedFromDocument]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "cherry-panel",
				"aria-labelledby": "cherry-scope-title",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						id: "cherry-scope-title",
						children: t("scope.heading")
					}),
					loadError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-error",
						role: "alert",
						children: t("scope.loadError", { error: loadError })
					}),
					!loaded && loadError === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: t("scope.loading")
					}),
					unsupported && data !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-error",
						role: "alert",
						"data-scope-warning": "unsupported",
						children: t("scope.unsupported", { reason: data.host.reason })
					}),
					scopeVersionDegraded && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-error",
						role: "alert",
						"data-scope-warning": "scope-version",
						children: t("scope.versionDegraded")
					}),
					listUnavailable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-error",
						role: "alert",
						"data-scope-warning": "workspace-list",
						children: t("scope.listUnavailable")
					}),
					pending && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						role: "status",
						"data-scope-notice": "pending",
						children: t("scope.pending")
					}),
					degraded.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "cherry-scope-degraded",
						children: degraded.map((note, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
							"data-degraded-source": note.source,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cherry-hint",
								children: t("scope.degradedLine", {
									label: t(DEGRADED_KEYS[note.source] ?? note.source),
									reason: note.reason
								})
							})
						}, `${note.source}:${index}`))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
						className: "cherry-scope-modes",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", { children: t("scope.mode.legend") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: "cherry-scope-mode",
								checked: mode === "global",
								onChange: () => setMode("global")
							}), t("scope.mode.global")] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: "cherry-scope-mode",
								checked: mode === "selected",
								onChange: () => setMode("selected")
							}), t("scope.mode.selected")] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: t(EFFECT_NOTE_KEY)
					}),
					options.length === 0 ? !listUnavailable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: t("scope.noWorkspaces")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "cherry-scope-options",
						children: options.map((workspace) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								"aria-label": `${workspace.title} ${workspace.path}`,
								checked: ids.includes(workspace.id),
								onChange: () => toggle(workspace.id)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cherry-scope-option-title",
								children: workspace.title
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cherry-hint cherry-mono",
								children: workspace.path
							})
						] }) }, workspace.id))
					}),
					emptyHint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						"data-scope-empty": mode,
						children: emptyHint
					}),
					staleShown.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cherry-scope-stale",
						"data-scope-stale": "",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("scope.stale.heading") }) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: staleShown.map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
								className: "cherry-mono",
								children: id
							}, id)) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cherry-hint",
								children: t("scope.stale.note")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: save,
								disabled: saveDisabled,
								children: t("scope.stale.clear")
							})
						]
					}),
					unmatched.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cherry-scope-unmatched",
						"data-scope-unmatched": "",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("scope.unmatched.heading") }) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: unmatched.map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								className: "cherry-mono",
								children: [
									entry.agentId,
									" — ",
									entry.cwd
								]
							}, `${entry.agentId}:${index}`)) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cherry-hint",
								children: t("scope.unmatched.note")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cherry-scope-save",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: save,
								disabled: saveDisabled,
								children: t("scope.save")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cherry-hint cherry-mono",
								"data-scope-revision": revision,
								children: t("scope.revision", { revision })
							}),
							saved !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cherry-ok",
								role: "status",
								"data-scope-saved": "",
								children: saved.pruned.length === 0 ? t("scope.saved") : t("scope.savedPruned", { list: saved.pruned.join(t("list.separator")) })
							}),
							failure !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								"data-scope-save-error": failure.code,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "cherry-error",
										role: "alert",
										children: failure.label
									}),
									failure.code === "scope-revision-conflict" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: reread,
										disabled: busy,
										children: t("scope.reread")
									}),
									failure.detail !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "cherry-hint cherry-mono",
										children: failure.detail
									})
								]
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region ui/src/App.tsx
		/**
		* The Cherry Bridge settings page: the pairing wizard plus one card per device.
		*
		* The app owns the two things that must outlive both children:
		*
		*  - **the event stream**, opened ONCE on mount and closed on unmount. The
		*    ordering is load-bearing: the stream carries no replay, and the
		*    verification code exists only as a frame, so the subscription must exist
		*    before the wizard can POST `/pair`. That is also why the submit button
		*    stays disabled until `subscribed` flips true.
		*  - **the device map**, seeded from `GET /devices` and then driven by
		*    `device-state` frames. The FIRST FRAME contract (one frame per device on
		*    connect) means a card never shows a state the server did not send; the REST
		*    list supplies the static fields (name, hosts, port) and the light stays
		*    blank until the stream speaks.
		*
		* There is no router: this is a single settings view.
		*/
		/** The production stream opener; the host page always has `EventSource`. */
		var defaultEventSourceFactory = (url) => {
			const source = globalThis.EventSource;
			if (source === void 0) throw new Error(EVENT_SOURCE_UNAVAILABLE);
			return new source(url);
		};
		/**
		* The marker a missing `EventSource` throws with.
		*
		* A constant rather than a sentence, because the USER-VISIBLE wording is the
		* dictionary's (`app.eventSourceUnavailable`, zh and en) while this string only
		* travels from the opener to the catch block that recognizes it. Keeping them
		* separate is what makes the Chinese page finally able to say so in Chinese —
		* before this task the literal here rendered in English on a zh page.
		*/
		var EVENT_SOURCE_UNAVAILABLE = "event-source-unavailable";
		/**
		* One description for a cause, shared by the two catches below so they cannot
		* drift. Two markers get the dictionary's own sentence — the missing
		* `EventSource` and a request that never answered (`api.ts`'s ceiling) — because
		* both are INTERNAL tokens that must never render; everything else is the
		* foreign message, interpolated verbatim as data.
		*/
		function describeCause(t, cause) {
			if (cause instanceof Error && cause.message === EVENT_SOURCE_UNAVAILABLE) return t("app.eventSourceUnavailable");
			if (cause instanceof Error && cause.message === "cherry-remote.request-timeout") return t("app.error.timeout");
			return cause instanceof Error ? cause.message : String(cause);
		}
		/** Parses one SSE frame payload, ignoring a malformed one rather than crashing. */
		function parseFrame(data) {
			try {
				return JSON.parse(data);
			} catch {
				return;
			}
		}
		function App({ eventSourceFactory = defaultEventSourceFactory, codeLifetimeMs, runLifetimeMs, scopeClient, subagentClient }) {
			const t = useT();
			const [devices, setDevices] = (0, react.useState)([]);
			const [states, setStates] = (0, react.useState)({});
			const [progress, setProgress] = (0, react.useState)(void 0);
			const [subscribed, setSubscribed] = (0, react.useState)(false);
			const [listed, setListed] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				let source;
				try {
					source = eventSourceFactory(`${API_BASE}/events`);
				} catch (cause) {
					setError(describeCause(t, cause));
					return;
				}
				const onDeviceState = (event) => {
					const payload = parseFrame(event.data);
					if (payload === void 0 || typeof payload.deviceId !== "string") return;
					setStates((current) => ({
						...current,
						[payload.deviceId]: payload.state
					}));
				};
				const onPairingProgress = (event) => {
					const payload = parseFrame(event.data);
					if (payload === void 0 || typeof payload.stage !== "string") return;
					setProgress(payload);
				};
				source.addEventListener("device-state", onDeviceState);
				source.addEventListener("pairing-progress", onPairingProgress);
				setSubscribed(true);
				return () => {
					setSubscribed(false);
					source.removeEventListener("device-state", onDeviceState);
					source.removeEventListener("pairing-progress", onPairingProgress);
					source.close();
				};
			}, [eventSourceFactory]);
			const refresh = (0, react.useCallback)(() => {
				listDevices().then((list) => {
					setDevices(list);
					setListed(true);
					setError(void 0);
				}, (cause) => {
					setError(describeCause(t, cause));
					setListed(true);
				});
			}, []);
			(0, react.useEffect)(refresh, [refresh]);
			const onSaved = (0, react.useCallback)((device) => {
				setDevices((current) => {
					if (current.findIndex((entry) => entry.deviceId === device.deviceId) === -1) return [...current, device];
					return current.map((entry) => entry.deviceId === device.deviceId ? device : entry);
				});
				setStates((current) => ({
					...current,
					[device.deviceId]: device.state
				}));
			}, []);
			const onRemoved = (0, react.useCallback)((deviceId) => {
				setDevices((current) => current.filter((entry) => entry.deviceId !== deviceId));
				setStates((current) => {
					const { [deviceId]: _removed, ...rest } = current;
					return rest;
				});
			}, []);
			const onSettled = (0, react.useCallback)(() => {
				refresh();
			}, [refresh]);
			/** Retires the previous run's frame; a fresh run must never inherit it. */
			const startRun = (0, react.useCallback)(() => {
				setProgress(void 0);
			}, []);
			const sorted = (0, react.useMemo)(() => [...devices].sort((left, right) => left.displayName.localeCompare(right.displayName)), [devices]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cherry-settings",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: "cherry-header",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: t("app.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cherry-hint",
							children: t("app.subtitle")
						})]
					}),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-error",
						role: "alert",
						children: error
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PairingWizard, {
						subscribed,
						progress,
						...codeLifetimeMs === void 0 ? {} : { codeLifetimeMs },
						...runLifetimeMs === void 0 ? {} : { runLifetimeMs },
						onRunStart: startRun,
						onSettled
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToolScopePanel, { ...scopeClient === void 0 ? {} : { client: scopeClient } }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SubagentPanel, {
						...subagentClient === void 0 ? {} : { client: subagentClient },
						devices: sorted
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "cherry-panel",
						"aria-labelledby": "cherry-devices-title",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								id: "cherry-devices-title",
								children: t("app.devices.heading")
							}),
							sorted.length === 0 && error === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cherry-hint",
								children: listed ? t("app.devices.empty") : t("app.devices.loading")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "cherry-cards",
								children: sorted.map((device) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DeviceCard, {
									device,
									state: states[device.deviceId],
									onSaved,
									onRemoved
								}, device.deviceId))
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region ui/src/styles.css?inline
		var styles_default = "/**\n * The settings page's own styles.\n *\n * Hand-written CSS, no UI framework (ruling 6). The palette follows the DSH web\n * client's dark-friendly aesthetic: it leans on `currentColor` and a few\n * neutral surface variables so the page reads correctly on both a dark and a\n * light shell, and the five state colours stay distinguishable (and are always paired\n * with a text label — colour alone is never the status).\n */\n.cherry-settings {\n  display: flex;\n  flex-direction: column;\n  gap: 20px;\n  padding: 16px;\n  color: inherit;\n  font-size: 13px;\n  line-height: 1.6;\n}\n\n.cherry-header h2 {\n  margin: 0 0 4px;\n  font-size: 16px;\n}\n\n.cherry-panel {\n  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);\n  border-radius: 10px;\n  padding: 14px 16px;\n  background: color-mix(in srgb, currentColor 4%, transparent);\n}\n\n.cherry-panel h3 {\n  margin: 0 0 8px;\n  font-size: 14px;\n}\n\n.cherry-hint {\n  margin: 4px 0;\n  opacity: 0.7;\n  font-size: 12px;\n}\n\n.cherry-mono {\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 12px;\n}\n\n/* --- pairing wizard ------------------------------------------------------ */\n\n.cherry-steps {\n  margin: 8px 0 12px;\n  padding-left: 20px;\n  opacity: 0.85;\n}\n\n.cherry-pair-form {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  align-items: flex-start;\n}\n\n.cherry-pair-form textarea,\n.cherry-inline-form input {\n  width: 100%;\n  box-sizing: border-box;\n  padding: 6px 8px;\n  border-radius: 6px;\n  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);\n  background: color-mix(in srgb, currentColor 6%, transparent);\n  color: inherit;\n  font: inherit;\n}\n\n.cherry-progress {\n  margin-top: 10px;\n  padding: 10px 12px;\n  border-radius: 8px;\n  border: 1px dashed color-mix(in srgb, currentColor 25%, transparent);\n}\n\n.cherry-code {\n  margin-top: 10px;\n  padding: 12px;\n  border-radius: 8px;\n  text-align: center;\n  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);\n}\n\n.cherry-code-digits {\n  display: block;\n  margin-top: 6px;\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 26px;\n  letter-spacing: 0.3em;\n}\n\n.cherry-ok {\n  color: #3fb950;\n}\n\n.cherry-error {\n  color: #f85149;\n}\n\n/* --- enablement scope panel ---------------------------------------------- */\n\n/* All three visible as a group, never as one combined verdict: the mode radio\n   pair, the workspace ticks and the save that commits them (§6.4). */\n.cherry-scope-modes {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 14px;\n  margin: 8px 0;\n  padding: 6px 10px;\n  border: 1px dashed color-mix(in srgb, currentColor 20%, transparent);\n  border-radius: 8px;\n}\n\n.cherry-scope-modes label {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n}\n\n.cherry-scope-degraded,\n.cherry-scope-options,\n.cherry-scope-stale ul,\n.cherry-scope-unmatched ul {\n  margin: 6px 0;\n  padding-left: 18px;\n}\n\n.cherry-scope-degraded li,\n.cherry-scope-options li {\n  margin: 2px 0;\n}\n\n.cherry-scope-options label {\n  display: inline-flex;\n  align-items: baseline;\n  gap: 8px;\n}\n\n.cherry-scope-option-title {\n  font-weight: 600;\n}\n\n/* The two diagnostic boxes are deliberately separate surfaces: a deleted\n   workspace and an unmatched cwd are different answers (§6.1/§6.4). */\n.cherry-scope-stale,\n.cherry-scope-unmatched {\n  margin-top: 10px;\n  padding: 8px 10px;\n  border-radius: 8px;\n  border: 1px dashed color-mix(in srgb, currentColor 25%, transparent);\n}\n\n.cherry-scope-save {\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  gap: 10px;\n  margin-top: 12px;\n  padding-top: 10px;\n  border-top: 1px dashed color-mix(in srgb, currentColor 18%, transparent);\n}\n\n/* --- device cards -------------------------------------------------------- */\n\n.cherry-cards {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));\n  gap: 12px;\n  margin: 8px 0 0;\n  padding: 0;\n  list-style: none;\n}\n\n.cherry-card {\n  border: 1px solid color-mix(in srgb, currentColor 15%, transparent);\n  border-radius: 10px;\n  padding: 12px;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.cherry-card-head {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n}\n\n.cherry-card-title {\n  display: flex;\n  flex-direction: column;\n  min-width: 0;\n  flex: 1;\n}\n\n.cherry-state-label {\n  font-size: 11px;\n  opacity: 0.7;\n}\n\n.cherry-card-actions {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n}\n\n.cherry-card-facts {\n  display: grid;\n  grid-template-columns: auto 1fr;\n  gap: 2px 10px;\n  margin: 0;\n  font-size: 12px;\n}\n\n.cherry-card-facts dt {\n  opacity: 0.6;\n}\n\n.cherry-card-facts dd {\n  margin: 0;\n  overflow-wrap: anywhere;\n}\n\n/* A per-host action list (issue #204): the address, then its own control. The\n   buttons stay small so a record with a dozen candidates stays ONE fact row\n   instead of a column of chrome. */\n.cherry-address-list {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 4px 10px;\n  margin: 0;\n  padding: 0;\n  list-style: none;\n}\n\n.cherry-address-list li {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.cherry-address-list button {\n  padding: 0 6px;\n  font-size: 11px;\n  line-height: 1.6;\n}\n\n.cherry-inline-form {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  align-items: flex-start;\n  padding-top: 6px;\n  border-top: 1px dashed color-mix(in srgb, currentColor 18%, transparent);\n}\n\n/* SCOPED DELIBERATELY. This stylesheet is injected into the HOST page's\n   document head, not a sandboxed frame, so a bare `button {}` rule restyles\n   every button in the host UI — a plugin must not do that. Every top-level\n   selector in this file is therefore rooted at a plugin-owned class in the\n   `cherry-` namespace: the element rules here at the plugin's own\n   `.cherry-settings` container, and the rest at their own component classes\n   (`.cherry-panel`, `.cherry-card`, `.cherry-state`, …). None of them matches\n   anything outside the markup this plugin renders. */\n.cherry-settings button {\n  padding: 4px 10px;\n  border-radius: 6px;\n  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);\n  background: color-mix(in srgb, currentColor 8%, transparent);\n  color: inherit;\n  font: inherit;\n  cursor: pointer;\n}\n\n.cherry-settings button:disabled {\n  opacity: 0.5;\n  cursor: not-allowed;\n}\n\n/* --- five-state light ---------------------------------------------------- */\n\n.cherry-state {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 14px;\n  height: 14px;\n  flex: none;\n}\n\n.cherry-state-dot {\n  width: 10px;\n  height: 10px;\n  border-radius: 50%;\n  background: var(--cherry-state-color, #8b949e);\n  box-shadow: 0 0 6px var(--cherry-state-color, transparent);\n}\n\n.cherry-state[data-state='connected'] {\n  --cherry-state-color: #3fb950;\n}\n\n.cherry-state[data-state='connecting'] {\n  --cherry-state-color: #d29922;\n}\n\n.cherry-state[data-state='offline'] {\n  --cherry-state-color: #8b949e;\n}\n\n.cherry-state[data-state='disabled'] {\n  --cherry-state-color: #6e7681;\n}\n\n.cherry-state[data-state='identity-mismatch'] {\n  --cherry-state-color: #f85149;\n}\n\n.cherry-state[data-state='unknown'] {\n  --cherry-state-color: #484f58;\n}\n\n/* The experimental badge: visible in every state, including the failure states\n   that exist because the operator has not configured the feature yet. */\n.cherry-experimental {\n  display: inline-block;\n  margin-left: 6px;\n  padding: 1px 6px;\n  border: 1px solid var(--cherry-accent, #c77);\n  border-radius: 999px;\n  color: var(--cherry-accent, #c77);\n  font-size: 0.75em;\n  font-weight: 600;\n  vertical-align: middle;\n}\n.cherry-subagent-form { display: flex; flex-direction: column; gap: 8px; }\n.cherry-subagent-field { display: flex; flex-direction: column; gap: 2px; }\n.cherry-subagent-check { display: flex; align-items: center; gap: 6px; }\n.cherry-subagent-problems { margin: 4px 0 0; padding-left: 20px; }\n";
		//#endregion
		//#region ui/src/main.tsx
		/** The slot a settings page registers into, per the shell's settings contract. */
		var SETTINGS_SLOT = "settings.section";
		/** The settings-pages namespace: this plugin's nav id and locale key. */
		var SETTINGS_NAMESPACE = "cherry-remote";
		/** This bundle's service dependencies, by module short name. */
		var inject = ["slots"];
		/**
		* The shape check every host answer must survive before it is trusted.
		*
		* A shape check rather than a plugin-facing type: what arrives through `get` is
		* `unknown`, and a host is free to mount a PARTIAL or differently-shaped
		* service. Both methods must be functions; anything else is "absent", and
		* absent degrades to the navigator fallback rather than to a thrown error in a
		* nav label.
		*/
		function isLocaleService(value) {
			if (typeof value !== "object" || value === null) return false;
			const candidate = value;
			return typeof candidate.getLocale === "function" && typeof candidate.subscribe === "function";
		}
		/**
		* Reads the host's locale service through `ctx.get`, or undefined when there is
		* none to trust.
		*
		* `get` itself may throw on a host whose gating differs from the documented
		* one, so the call is guarded too: this function NEVER throws. It is called
		* from exactly two places — `apply()`'s probe and the `slots.inject` re-probe —
		* and both write the SAME cached reference (see {@link apply}).
		*/
		function readLocaleService(ctx) {
			try {
				const service = ctx.get?.("locale");
				return isLocaleService(service) ? service : void 0;
			} catch (cause) {
				console.warn(`[${SETTINGS_NAMESPACE}] locale service lookup failed`, cause);
				return;
			}
		}
		/** The translator the plugin's own copy uses, for the language the store holds. */
		function translate(key) {
			return createTranslator(localeStore.getSnapshot().locale)(key);
		}
		/**
		* Maps an ACTIVE locale the host reported onto one of this page's languages.
		*
		* The whitelist: only `zh`/`en` are adopted verbatim, and anything else — a
		* language this page does not ship, an empty string, a non-string — resolves to
		* `fallback`, the single navigator evaluation `apply()` performed. ONE rule,
		* used by both the store write and the label read, so the shell's nav item can
		* never disagree with the page it opens.
		*/
		function resolveActiveLocale(active, fallback) {
			return active === "zh" || active === "en" ? active : fallback;
		}
		/**
		* Registers the settings page with the host shell.
		*
		* Registration goes through the `slots` service, exactly as the reference
		* plugin does — the host owns where a settings section appears, so a plugin
		* must never append its own container to `document.body`. `slots.inject` waits
		* for the slot to exist before `slots.register` claims a seat, and the returned
		* disposer is returned so the caller can tie it to the plugin lifecycle.
		*
		* ## Localization wiring (the whole of this plugin's host coupling)
		*
		* The plugin ships its own two dictionaries and its own store; the host's
		* locale service is an OPTIONAL SOURCE, wired here and nowhere else:
		*
		*  - **the navigator fallback is evaluated exactly once**, at the top, behind
		*    the `typeof navigator === 'undefined'` guard. A VM sandbox has no
		*    `navigator` at all, so an unguarded read would throw before the page
		*    registered; `resolveLocaleFromNavigator` itself is pure. The single value
		*    is shared by BOTH branches that need it — "no host service" and "the host
		*    named a language outside the whitelist" — so there is one place where the
		*    ambient language can enter.
		*  - **the host service is read through `ctx.get('locale')`, never
		*    `ctx.locale`**, and only after {@link isLocaleService} accepts its shape.
		*  - **`host` is the CACHED reference both probes write.** `label()` reads it
		*    on every call: a present host is answered DIRECTLY from
		*    `getLocale().active` (so a label asked in the same tick as the host's
		*    announcement, before our own listener has run, is still correct — React's
		*    `handleStoreChange` calls `getSnapshot` synchronously, and the shell may
		*    ask for its nav item even earlier), while an absent host falls back to
		*    `localeStore`, which is what a React re-render reads. Because the re-probe
		*    updates the same variable, a host that appears after `apply()` switches
		*    the label from the store to the host with no extra flag.
		*  - **the registration carries no `locale` field**, and `inject` stays
		*    `['slots']`: declaring `locale` would make a host without the provider
		*    fail the entire Web GUI boot, for a feature that is optional by design.
		*  - **nothing in the LOCALE path may throw.** Every interaction with the host's
		*    `locale` service is guarded and degrades to "no localization" (a warning
		*    plus the fallback language); a misbehaving host costs the page its English,
		*    never its registration. (The `ctx.slots.inject`/`register` calls below are
		*    NOT wrapped — they are the pre-existing registration path, where a `slots`
		*    failure was never survivable.)
		*/
		function apply(ctx) {
			const fallback = resolveLocaleFromNavigator(typeof navigator === "undefined" ? void 0 : navigator.language);
			/**
			* The cached host reference {@link apply}'s probe and the inject re-probe
			* BOTH write; `label()` reads it on every call.
			*/
			let host;
			/** The host subscription's disposer, so the effect teardown can release it. */
			let unsubscribe;
			/**
			* Adopts the language the cached host reports.
			*
			* Called by BOTH probes and by every announcement the host makes. An
			* unreadable answer degrades to {@link fallback} — the same single navigator
			* evaluation the no-host branch uses — rather than leaving the store at
			* whatever it held or throwing into a nav render.
			*/
			const adopt = (service) => {
				let active;
				try {
					active = service.getLocale().active;
				} catch (cause) {
					if (host === service) {
						host = void 0;
						unsubscribe?.();
					}
					localeStore.setLocale(fallback);
					console.warn(`[${SETTINGS_NAMESPACE}] host locale unavailable; falling back to ${fallback}`, cause);
					return;
				}
				localeStore.setLocale(resolveActiveLocale(active, fallback));
			};
			/**
			* Re-reads the host service, adopts its language, and subscribes if it has
			* not happened yet. Idempotent in the way the two probe sites need: the
			* second probe sees `host` already set, subscribes nothing, and re-adopting a
			* language the store already holds is a no-op (`setLocale` does not notify
			* for the same value).
			*
			* With no host to read, the store takes {@link fallback} — the single
			* navigator evaluation performed at the top of {@link apply}. That is what
			* makes the absent branch and the "host named a language outside the
			* whitelist" branch share one result, and it is why the store is never left
			* at an unrelated language: the page's own default applies until a host says
			* otherwise.
			*/
			const probe = () => {
				if (host === void 0) {
					const service = readLocaleService(ctx);
					if (service === void 0) {
						localeStore.setLocale(fallback);
						return;
					}
					host = service;
					try {
						const off = service.subscribe(() => probe());
						unsubscribe = () => {
							unsubscribe = void 0;
							try {
								off();
							} catch (cause) {
								console.warn(`[${SETTINGS_NAMESPACE}] unsubscribing from the host locale failed`, cause);
							}
						};
					} catch (cause) {
						console.warn(`[${SETTINGS_NAMESPACE}] could not follow the host locale`, cause);
					}
				}
				if (host !== void 0) adopt(host);
			};
			probe();
			ctx.effect?.(() => {
				const removeStyles = installStyles();
				return () => {
					unsubscribe?.();
					removeStyles();
				};
			}, `${SETTINGS_NAMESPACE}: settings styles`);
			if (ctx.slots === void 0) {
				console.warn(`[${SETTINGS_NAMESPACE}] client slots service unavailable; settings page not registered`);
				return;
			}
			ctx.slots.inject(SETTINGS_SLOT, () => {
				probe();
				return ctx.slots?.register({
					name: SETTINGS_SLOT,
					id: SETTINGS_NAMESPACE,
					order: 50,
					label: () => {
						if (host === void 0) return translate("app.title");
						try {
							const active = host.getLocale().active;
							return createTranslator(resolveActiveLocale(active, fallback))("app.title");
						} catch {
							return translate("app.title");
						}
					},
					inject: () => ({})
				}, App);
			});
		}
		/** Injects the page styles, returning the disposer that removes the node. */
		function installStyles() {
			const node = document.createElement("style");
			node.setAttribute("data-cherry-remote-styles", "");
			node.textContent = styles_default;
			document.head.append(node);
			return () => node.remove();
		}
		//#endregion
		exports.SETTINGS_NAMESPACE = SETTINGS_NAMESPACE;
		exports.SETTINGS_SLOT = SETTINGS_SLOT;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
