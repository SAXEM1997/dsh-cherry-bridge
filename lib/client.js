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
				"wizard.timedOut": "没有等到配对结果——若桌面端已批准，下面的设备列表里会出现该设备；否则请在 Cherry Studio 重新生成配对码后重试",
				"wizard.error.payloadRequired": "请先粘贴扫码页显示的配对信息",
				"wizard.error.timeout": "配对请求没有回应——请确认宿主仍在运行，然后重试",
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
				"scope.unsupported": "宿主不支持工具作用域能力（只读告警）：{reason}。请升级宿主 / DSH 以获得该能力后再试；升级前本插件不会注册这些工具。",
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
				"scope.serverSaid": "服务端返回 {code}（HTTP {status}）。",
				"scope.degraded.install": "隐藏层应用曾失败（install）：相关 agent 的隐藏层未生效或无法确认，启用范围对它可能不适用",
				"scope.degraded.workspace-list": "注册表列表当前读不到",
				"scope.degraded.visibility-only": "仅可见性降级（缺 tools.guard）：restrict 仍在装配层移除这 14 个工具，但执行侧没有任何一层拒绝它们的调用（不是渲染层假过滤）；连 restrict 都装不上的 agent 则既隐藏不了、也无人拒绝",
				"scope.degraded.scope-version": "作用域文档版本与本插件支持的不一致（高于或低于皆同一条守卫）",
				"scope.degraded.path-normalization": "路径规范化降级：cwd 比对可能不准确",
				"scope.saveFailure.scope-revision-conflict": "配置已被他处修改，请重新读取后再保存。",
				"scope.saveFailure.scope-version-unsupported": "作用域文档版本与本插件支持的不一致（高于或低于皆同一条守卫），文档版本高于本插件支持、或低于本插件支持：重读不会改变文档版本，请升级宿主 / DSH 或本插件后再试。",
				"scope.saveFailure.invalid-scope": "保存被拒绝：作用域字段非法（mode 必须是 global 或 selected，workspaceIds 必须是字符串数组）。",
				"scope.saveFailure.missing-expected-revision": "保存被拒绝：请求缺少基准 expectedRevision，请重新读取后再保存。",
				"scope.saveFailure.workspace-list-unavailable": "工作区列表当前读不到，无法保存；已存勾选与 mode 一位不动。",
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
				"wizard.timedOut": "No pairing result arrived. If the desktop approved it, the device appears in the list below; otherwise generate a new pairing code in Cherry Studio and try again.",
				"wizard.error.payloadRequired": "Paste the pairing payload shown on the scan page first",
				"wizard.error.timeout": "The pairing request got no answer. Check that the host is still running, then try again.",
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
				"scope.unsupported": "The host does not support tool scoping (read-only warning): {reason}. Upgrade the host / DSH to use it; until then this plugin registers none of these tools.",
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
				"scope.serverSaid": "The server answered {code} (HTTP {status}).",
				"scope.degraded.install": "Applying a hidden layer failed earlier (install): the affected agent’s hidden layer is not in effect or cannot be confirmed, so the tool scope may not apply to it",
				"scope.degraded.workspace-list": "The workspace registry list is currently unreadable",
				"scope.degraded.visibility-only": "Visibility-only degradation (tools.guard is missing): restrict still removes these 14 tools at the assembly layer, but nothing on the execution side refuses a call to them (this is not a render-layer fake filter). An agent that cannot install restrict at all both fails to hide them and has nothing to refuse them",
				"scope.degraded.scope-version": "The scope document version does not match the one this plugin supports (one guard covers newer and older)",
				"scope.degraded.path-normalization": "Path normalization degraded: the cwd comparison may be inaccurate",
				"scope.saveFailure.scope-revision-conflict": "The configuration changed elsewhere. Reload before saving again.",
				"scope.saveFailure.scope-version-unsupported": "The scope document version does not match the one this plugin supports (the same guard covers newer and older). Re-reading cannot change the document version — upgrade the host / DSH or this plugin and try again.",
				"scope.saveFailure.invalid-scope": "Save refused: an illegal scope field (mode must be global or selected, workspaceIds must be an array of strings).",
				"scope.saveFailure.missing-expected-revision": "Save refused: the request carries no base expectedRevision. Reload before saving again.",
				"scope.saveFailure.workspace-list-unavailable": "The workspace list is unreadable, so it cannot be saved. The stored ticks and mode are left untouched.",
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
		* The marker a PAIRING request that never answered throws with.
		*
		* Internal token, never copy: the wizard renders `wizard.error.timeout` and this
		* string only travels from here to the catch block that recognizes it — the same
		* split as `app.eventSourceUnavailable` (see `App.tsx`), which is what keeps an
		* English literal off a Chinese page.
		*/
		var PAIRING_REQUEST_TIMEOUT = "cherry-remote.pairing-request-timeout";
		/**
		* How long `POST /pair` may stay open, in milliseconds.
		*
		* It is not a slow call. The server answers 202 as soon as it has a claim id and
		* does no I/O before that (`src/httpApi.ts` `startPairing`), so a request still
		* open after this long is a wedged same-origin transport, not a busy server.
		* Without a ceiling the caller waits forever: the wizard's submit button stays
		* disabled for the life of the page (issue #173).
		*
		* Only the PAIRING call carries the ceiling. It is the one request whose hang
		* strands a user-facing gate; the rest of the page's calls fail visibly when the
		* host is unreachable, and a page-wide timeout is a separate decision.
		*/
		var DEFAULT_PAIRING_REQUEST_TIMEOUT_MS = 1e4;
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
		async function request(url, init) {
			const response = await fetch(url, {
				...init,
				headers: {
					"content-type": "application/json",
					...init?.headers ?? {}
				}
			});
			const body = await readBody(response);
			if (!response.ok) {
				const record = body ?? {};
				const code = typeof record.error === "string" ? record.error : `http-${response.status}`;
				const message = typeof record.message === "string" ? record.message : code;
				throw new ApiError(response.status, code, message);
			}
			return body;
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
		* The call is bounded (see {@link DEFAULT_PAIRING_REQUEST_TIMEOUT_MS}): a hang
		* here is the one transport failure that leaves the page waiting forever, so it
		* becomes {@link PAIRING_REQUEST_TIMEOUT} instead. `timeoutMs` is the same
		* injectable seam the components expose for their timers, so a test can prove
		* the ceiling without waiting for it.
		*/
		async function startPairing(payload, options = {}) {
			const { name, timeoutMs = DEFAULT_PAIRING_REQUEST_TIMEOUT_MS } = options;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				return await request(`/cherry-remote/api/pair`, {
					method: "POST",
					body: JSON.stringify(name === void 0 || name === "" ? { payload } : {
						payload,
						name
					}),
					signal: controller.signal
				}) ?? {};
			} catch (cause) {
				if (controller.signal.aborted) throw new Error(PAIRING_REQUEST_TIMEOUT);
				throw cause;
			} finally {
				clearTimeout(timer);
			}
		}
		/** `PATCH /devices/:id` — `hosts` is whole-replace; omitted fields are untouched. */
		async function patchDevice(deviceId, patch) {
			return await request(`${API_BASE}/devices/${encodeURIComponent(deviceId)}`, {
				method: "PATCH",
				body: JSON.stringify(patch)
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
			/** Runs one mutation, mapping a refusal into the card's error line. */
			const run = async (action) => {
				setBusy(true);
				setError(void 0);
				try {
					await action();
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy(false);
				}
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
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: device.hosts.join(", ") }),
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
					setError(cause instanceof Error && cause.message === "cherry-remote.pairing-request-timeout" ? t("wizard.error.timeout") : cause instanceof Error ? cause.message : String(cause));
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
		var describeCause = (cause) => cause instanceof Error ? cause.message : String(cause);
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
					if (live) setLoadError(describeCause(cause));
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
						label: code === void 0 ? t(SAVE_FAILED_KEY, { cause: describeCause(cause) }) : t(SAVE_FAILURE_KEYS[code] ?? SAVE_FAILED_KEY, { cause: describeCause(cause) }),
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
					setLoadError(describeCause(cause));
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
		/** Parses one SSE frame payload, ignoring a malformed one rather than crashing. */
		function parseFrame(data) {
			try {
				return JSON.parse(data);
			} catch {
				return;
			}
		}
		function App({ eventSourceFactory = defaultEventSourceFactory, codeLifetimeMs, runLifetimeMs, scopeClient }) {
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
					setError(cause instanceof Error && cause.message === EVENT_SOURCE_UNAVAILABLE ? t("app.eventSourceUnavailable") : cause instanceof Error ? cause.message : String(cause));
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
					setError(cause instanceof Error ? cause.message : String(cause));
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "cherry-panel",
						"aria-labelledby": "cherry-devices-title",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								id: "cherry-devices-title",
								children: t("app.devices.heading")
							}),
							sorted.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
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
		var styles_default = "/**\n * The settings page's own styles.\n *\n * Hand-written CSS, no UI framework (ruling 6). The palette follows the DSH web\n * client's dark-friendly aesthetic: it leans on `currentColor` and a few\n * neutral surface variables so the page reads correctly on both a dark and a\n * light shell, and the five state colours stay distinguishable (and are always paired\n * with a text label — colour alone is never the status).\n */\n.cherry-settings {\n  display: flex;\n  flex-direction: column;\n  gap: 20px;\n  padding: 16px;\n  color: inherit;\n  font-size: 13px;\n  line-height: 1.6;\n}\n\n.cherry-header h2 {\n  margin: 0 0 4px;\n  font-size: 16px;\n}\n\n.cherry-panel {\n  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);\n  border-radius: 10px;\n  padding: 14px 16px;\n  background: color-mix(in srgb, currentColor 4%, transparent);\n}\n\n.cherry-panel h3 {\n  margin: 0 0 8px;\n  font-size: 14px;\n}\n\n.cherry-hint {\n  margin: 4px 0;\n  opacity: 0.7;\n  font-size: 12px;\n}\n\n.cherry-mono {\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 12px;\n}\n\n/* --- pairing wizard ------------------------------------------------------ */\n\n.cherry-steps {\n  margin: 8px 0 12px;\n  padding-left: 20px;\n  opacity: 0.85;\n}\n\n.cherry-pair-form {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  align-items: flex-start;\n}\n\n.cherry-pair-form textarea,\n.cherry-inline-form input {\n  width: 100%;\n  box-sizing: border-box;\n  padding: 6px 8px;\n  border-radius: 6px;\n  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);\n  background: color-mix(in srgb, currentColor 6%, transparent);\n  color: inherit;\n  font: inherit;\n}\n\n.cherry-progress {\n  margin-top: 10px;\n  padding: 10px 12px;\n  border-radius: 8px;\n  border: 1px dashed color-mix(in srgb, currentColor 25%, transparent);\n}\n\n.cherry-code {\n  margin-top: 10px;\n  padding: 12px;\n  border-radius: 8px;\n  text-align: center;\n  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);\n}\n\n.cherry-code-digits {\n  display: block;\n  margin-top: 6px;\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 26px;\n  letter-spacing: 0.3em;\n}\n\n.cherry-ok {\n  color: #3fb950;\n}\n\n.cherry-error {\n  color: #f85149;\n}\n\n/* --- enablement scope panel ---------------------------------------------- */\n\n/* All three visible as a group, never as one combined verdict: the mode radio\n   pair, the workspace ticks and the save that commits them (§6.4). */\n.cherry-scope-modes {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 14px;\n  margin: 8px 0;\n  padding: 6px 10px;\n  border: 1px dashed color-mix(in srgb, currentColor 20%, transparent);\n  border-radius: 8px;\n}\n\n.cherry-scope-modes label {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n}\n\n.cherry-scope-degraded,\n.cherry-scope-options,\n.cherry-scope-stale ul,\n.cherry-scope-unmatched ul {\n  margin: 6px 0;\n  padding-left: 18px;\n}\n\n.cherry-scope-degraded li,\n.cherry-scope-options li {\n  margin: 2px 0;\n}\n\n.cherry-scope-options label {\n  display: inline-flex;\n  align-items: baseline;\n  gap: 8px;\n}\n\n.cherry-scope-option-title {\n  font-weight: 600;\n}\n\n/* The two diagnostic boxes are deliberately separate surfaces: a deleted\n   workspace and an unmatched cwd are different answers (§6.1/§6.4). */\n.cherry-scope-stale,\n.cherry-scope-unmatched {\n  margin-top: 10px;\n  padding: 8px 10px;\n  border-radius: 8px;\n  border: 1px dashed color-mix(in srgb, currentColor 25%, transparent);\n}\n\n.cherry-scope-save {\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  gap: 10px;\n  margin-top: 12px;\n  padding-top: 10px;\n  border-top: 1px dashed color-mix(in srgb, currentColor 18%, transparent);\n}\n\n/* --- device cards -------------------------------------------------------- */\n\n.cherry-cards {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));\n  gap: 12px;\n  margin: 8px 0 0;\n  padding: 0;\n  list-style: none;\n}\n\n.cherry-card {\n  border: 1px solid color-mix(in srgb, currentColor 15%, transparent);\n  border-radius: 10px;\n  padding: 12px;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.cherry-card-head {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n}\n\n.cherry-card-title {\n  display: flex;\n  flex-direction: column;\n  min-width: 0;\n  flex: 1;\n}\n\n.cherry-state-label {\n  font-size: 11px;\n  opacity: 0.7;\n}\n\n.cherry-card-actions {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n}\n\n.cherry-card-facts {\n  display: grid;\n  grid-template-columns: auto 1fr;\n  gap: 2px 10px;\n  margin: 0;\n  font-size: 12px;\n}\n\n.cherry-card-facts dt {\n  opacity: 0.6;\n}\n\n.cherry-card-facts dd {\n  margin: 0;\n  overflow-wrap: anywhere;\n}\n\n.cherry-inline-form {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  align-items: flex-start;\n  padding-top: 6px;\n  border-top: 1px dashed color-mix(in srgb, currentColor 18%, transparent);\n}\n\n/* SCOPED DELIBERATELY. This stylesheet is injected into the HOST page's\n   document head, not a sandboxed frame, so a bare `button {}` rule restyles\n   every button in the host UI — a plugin must not do that. Every top-level\n   selector in this file is therefore rooted at a plugin-owned class in the\n   `cherry-` namespace: the element rules here at the plugin's own\n   `.cherry-settings` container, and the rest at their own component classes\n   (`.cherry-panel`, `.cherry-card`, `.cherry-state`, …). None of them matches\n   anything outside the markup this plugin renders. */\n.cherry-settings button {\n  padding: 4px 10px;\n  border-radius: 6px;\n  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);\n  background: color-mix(in srgb, currentColor 8%, transparent);\n  color: inherit;\n  font: inherit;\n  cursor: pointer;\n}\n\n.cherry-settings button:disabled {\n  opacity: 0.5;\n  cursor: not-allowed;\n}\n\n/* --- five-state light ---------------------------------------------------- */\n\n.cherry-state {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 14px;\n  height: 14px;\n  flex: none;\n}\n\n.cherry-state-dot {\n  width: 10px;\n  height: 10px;\n  border-radius: 50%;\n  background: var(--cherry-state-color, #8b949e);\n  box-shadow: 0 0 6px var(--cherry-state-color, transparent);\n}\n\n.cherry-state[data-state='connected'] {\n  --cherry-state-color: #3fb950;\n}\n\n.cherry-state[data-state='connecting'] {\n  --cherry-state-color: #d29922;\n}\n\n.cherry-state[data-state='offline'] {\n  --cherry-state-color: #8b949e;\n}\n\n.cherry-state[data-state='disabled'] {\n  --cherry-state-color: #6e7681;\n}\n\n.cherry-state[data-state='identity-mismatch'] {\n  --cherry-state-color: #f85149;\n}\n\n.cherry-state[data-state='unknown'] {\n  --cherry-state-color: #484f58;\n}\n";
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
