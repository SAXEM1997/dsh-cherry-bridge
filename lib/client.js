window.__ModuleLoader__.load({
	id: "dsh-cherry-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
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
		/**
		* Human labels for the progress stages the wizard narrates.
		*
		* The three FAILURE labels carry the recovery step, not just the verdict: the
		* user is standing in front of two windows, and "被拒绝" without "go compare the
		* code" leaves them with nothing to do but retry blindly. The wording mirrors
		* the server's own verdict messages (`src/pairing.ts`).
		*/
		var STAGE_LABELS = {
			validate: "正在校验配对信息…",
			connect: "正在连接 Cherry Studio…",
			claim: "正在交换凭据…",
			waiting: "等待在 Cherry Studio 上确认…",
			"pairing-failed": "配对失败",
			rejected: "配对被拒绝——请核对桌面端显示的 6 位验证码是否与本页一致，并在 Cherry Studio 重新生成配对码后重试",
			expired: "配对邀请已过期——请在 Cherry Studio 重新生成配对码后重试",
			unreachable: "无法连接 Cherry Studio，请确认桌面端已启动且与本机同网",
			"invalid-payload": "配对信息无效或已过期，请在 Cherry Studio 重新生成后重试",
			"archive-quarantined": "设备档案无法读取（已保留为 .corrupt 副本）。请将该文件移开后重启或重新加载插件，再重试配对"
		};
		/** Human labels for the five states, shared by the light and the light's name. */
		var STATE_LABELS = {
			connected: "已连接",
			connecting: "连接中",
			offline: "离线",
			disabled: "已停用",
			"identity-mismatch": "身份不匹配"
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
		*/
		async function startPairing(payload, name) {
			return await request(`/cherry-remote/api/pair`, {
				method: "POST",
				body: JSON.stringify(name === void 0 || name === "" ? { payload } : {
					payload,
					name
				})
			}) ?? {};
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
		/**
		* Whether focus currently sits INSIDE this card's editors.
		*
		* Read from the document rather than tracked with local state: focus moves
		* between the card's own inputs (name → hosts → port) and out to another card
		* or a button, and a per-input handler would have to coordinate all of those.
		* `document.activeElement` is the single source of truth, and it is only
		* consulted when the effect runs (a prop change), never during a render.
		*/
		function useIsFocusedWithin(root) {
			const [focused, setFocused] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				const check = () => {
					const node = root.current;
					const active = node?.ownerDocument.activeElement ?? null;
					setFocused(node !== null && node !== void 0 && active !== null && node.contains(active));
				};
				const owner = root.current?.ownerDocument ?? globalThis.document;
				owner.addEventListener("focusin", check);
				owner.addEventListener("focusout", check);
				return () => {
					owner.removeEventListener("focusin", check);
					owner.removeEventListener("focusout", check);
				};
			}, [root]);
			return focused;
		}
		/** Splits the comma-separated host box into the whole-replace list the API wants. */
		function parseHosts(raw) {
			return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
		}
		function DeviceCard({ device, state, onSaved, onRemoved }) {
			const root = (0, react.useRef)(null);
			const [editor, setEditor] = (0, react.useState)("none");
			const [name, setName] = (0, react.useState)(device.displayName);
			const [hostsText, setHostsText] = (0, react.useState)(device.hosts.join(", "));
			const [portText, setPortText] = (0, react.useState)(String(device.port));
			const [error, setError] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			/**
			* RESYNC FROM PROPS. Each editor holds a local draft seeded from the record,
			* and `device` can change underneath it: a refresh (`GET /devices` after a
			* pairing settles) replaces the card's record, and another tab's PATCH arrives
			* the same way. Without this the box would keep showing a value the server no
			* longer holds, and saving that box would write the STALE value back — the
			* exact failure the "server's verdict is authoritative" rule elsewhere in
			* this component exists to prevent.
			*
			* Skipped while an editor is OPEN and focus sits inside the card, because there the
			* user's in-progress typing outranks the server: overwriting a half-typed
			* address from a background refresh would lose their edit. Closing the editor
			* clears the guard, and the next prop change resyncs.
			*
			* Keyed on the fields themselves, not the object identity: `listDevices`
			* rebuilds every record on each refresh, so an identity check would resync on
			* every poll even when nothing changed.
			*/
			const focused = useIsFocusedWithin(root);
			(0, react.useEffect)(() => {
				if (editor !== "none" && focused) return;
				setName(device.displayName);
				setHostsText(device.hosts.join(", "));
				setPortText(String(device.port));
			}, [
				device.displayName,
				device.hosts,
				device.port,
				editor,
				focused
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
					setError("设备名称不能为空");
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
					setError("至少需要一个主机地址");
					return;
				}
				const port = Number(portText);
				if (!Number.isInteger(port) || port < 1 || port > 65535) {
					setError("端口必须是 1..65535 之间的整数");
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
			const label = state === void 0 ? "状态未知" : STATE_LABELS[state];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "cherry-card",
				"data-device-id": device.deviceId,
				ref: root,
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
										children: device.enabled ? "停用" : "启用"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => setEditor(editor === "rename" ? "none" : "rename"),
										disabled: busy,
										children: "重命名"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => setEditor(editor === "address" ? "none" : "address"),
										disabled: busy,
										children: "地址维护"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => setEditor(editor === "remove" ? "none" : "remove"),
										disabled: busy,
										children: "移除"
									})
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
						className: "cherry-card-facts",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "地址" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: device.hosts.join(", ") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "端口" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: device.port }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "设备 ID" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
								className: "cherry-mono",
								children: device.deviceId
							})
						]
					}),
					editor === "rename" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: "cherry-inline-form",
						onSubmit: saveName,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								htmlFor: `name-${device.deviceId}`,
								children: "设备名称"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: `name-${device.deviceId}`,
								value: name,
								onChange: (event) => setName(event.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								disabled: busy,
								children: "保存名称"
							})
						]
					}),
					editor === "address" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: "cherry-inline-form",
						onSubmit: saveAddress,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								htmlFor: `hosts-${device.deviceId}`,
								children: "主机地址"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: `hosts-${device.deviceId}`,
								value: hostsText,
								onChange: (event) => setHostsText(event.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cherry-hint",
								children: "多个候选地址用逗号分隔（整体替换）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								htmlFor: `port-${device.deviceId}`,
								children: "端口"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: `port-${device.deviceId}`,
								inputMode: "numeric",
								value: portText,
								onChange: (event) => setPortText(event.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								disabled: busy,
								children: "保存地址"
							})
						]
					}),
					editor === "remove" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cherry-inline-form",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "移除后本机将不再连接该设备，凭据保留在对方一侧。" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: confirmRemove,
								disabled: busy,
								children: "确认移除"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => setEditor("none"),
								disabled: busy,
								children: "取消"
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
		function PairingWizard({ subscribed, progress, codeLifetimeMs = DEFAULT_CODE_LIFETIME_MS, onRunStart, onSettled }) {
			const [payload, setPayload] = (0, react.useState)("");
			const [claimId, setClaimId] = (0, react.useState)(void 0);
			const [phase, setPhase] = (0, react.useState)("idle");
			const [error, setError] = (0, react.useState)(void 0);
			const [code, setCode] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [verdict, setVerdict] = (0, react.useState)(void 0);
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
			const submit = (event) => {
				event.preventDefault();
				const trimmed = payload.trim();
				if (trimmed === "") {
					setError("请先粘贴扫码页显示的配对信息");
					return;
				}
				setBusy(true);
				setError(void 0);
				setPhase("submitting");
				setClaimId(void 0);
				setVerdict(void 0);
				onRunStart?.();
				startPairing(trimmed).then((result) => {
					setClaimId(result.claimId);
					setPhase("waiting");
				}, (cause) => {
					setError(cause instanceof Error ? cause.message : String(cause));
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
						children: "配对向导"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cherry-hint",
						children: [
							"在 Cherry Studio 桌面端打开「远程连接 → 添加设备」；该界面显示的是",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "二维码" }),
							"。 请用微信或浏览器等扫码，把扫码后页面上显示的配对信息复制下来，粘贴到下方。"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ol", {
						className: "cherry-steps",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: "Cherry Studio 中打开「添加设备」，屏幕上显示二维码" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: "用微信或浏览器等扫码，复制扫码页显示的配对信息（含地址、端口与一次性邀请）" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: "粘贴到下方输入框并开始配对，再对照桌面端窗口上的 6 位验证码确认" })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: "cherry-pair-form",
						onSubmit: submit,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								htmlFor: "cherry-payload",
								children: "配对信息"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								id: "cherry-payload",
								value: payload,
								rows: 3,
								placeholder: "粘贴扫码后页面上显示的配对信息",
								onChange: (event) => setPayload(event.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								disabled: busy || running || !subscribed,
								children: "开始配对"
							})
						]
					}),
					!subscribed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: "正在建立事件流，稍候即可开始配对…"
					}),
					running && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cherry-progress",
						"aria-live": "polite",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "配对进行中" }),
							claimId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "cherry-hint cherry-mono",
								children: ["claim ", claimId]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: stage === void 0 ? "已提交配对请求…" : STAGE_LABELS[stage] ?? stage })
						]
					}),
					code !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cherry-code",
						role: "status",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "请在 Cherry Studio 上核对验证码" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("output", {
							className: "cherry-code-digits",
							children: code
						})]
					}),
					phase === "done" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-ok",
						children: "配对成功"
					}),
					phase === "failed" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cherry-error",
						role: "alert",
						children: ["配对失败：", STAGE_LABELS[verdict ?? ""] ?? "未知错误"]
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
		*    the operator's edit; a refusal leaves them exactly where they were (§6.4).
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
		* D11's empty-state wording, one sentence per mode.
		*
		* They are NOT interchangeable: under `selected` an empty list means the tools
		* are enabled nowhere, while under `global` the ticks are not judgement input at
		* all (B2). One sentence for both would state the opposite of the truth in one
		* of the two modes.
		*/
		var SELECTED_EMPTY_HINT = "尚未启用任何工作区——此状态下 cherry_* 工具不会出现在任何会话里；勾选后对应工作区的会话（含进行中的）即可使用。";
		var GLOBAL_EMPTY_HINT = "当前为全局模式：这些工具在所有工作区都可用；下面的勾选仅在切到「仅选定工作区」后才生效。";
		/**
		* B15's copy boundary, in the positive form.
		*
		* The page may only claim that THIS PLUGIN did not shadow the tools. Whether a
		* given session sees them can still be decided upstream by an `allow`-shaped
		* filter (a sub-agent's `toolFilter`), which is accepted behaviour — so any
		* "the model can see / call them" phrasing would promise something this plugin
		* cannot keep.
		*/
		var EFFECT_NOTE = "生效范围内本插件未遮蔽这些 cherry_* 工具；上游的 allow 型过滤（例如子代理的 toolFilter）仍可能让某个会话看不到它们——本页只说明本插件未遮蔽，不对上层过滤的结果作保证。";
		/** One line per degradation source; the server's own reason is shown beside it. */
		var DEGRADED_LABELS = {
			install: "工具注册失败（install）：启用范围未生效",
			"workspace-list": "注册表列表当前读不到",
			"visibility-only": "仅可见性降级（缺 tools.guard）：部分会话可能仍看得到这些工具",
			"scope-version": "作用域文档版本高于本插件支持",
			"path-normalization": "路径规范化降级：cwd 比对可能不准确"
		};
		/**
		* The copy for each stable `PUT` refusal code.
		*
		* `scope-version-unsupported` gets its own recovery sentence: re-reading cannot
		* change the document's version, so sending the operator round that loop would
		* be an instruction that cannot work (§6.3).
		*/
		var SAVE_FAILURE_LABELS = {
			"scope-revision-conflict": "配置已被他处修改，请重新读取后再保存。",
			"scope-version-unsupported": "作用域文档版本高于本插件支持：重读不会改变文档版本，请升级宿主 / DSH 或本插件后再试。",
			"invalid-scope": "保存被拒绝：作用域字段非法（mode 必须是 global 或 selected，workspaceIds 必须是字符串数组）。",
			"missing-expected-revision": "保存被拒绝：请求缺少基准 expectedRevision，请重新读取后再保存。",
			"workspace-list-unavailable": "工作区列表当前读不到，无法保存；已存勾选与 mode 一位不动。"
		};
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
		*/
		function resolveEmptyHint(input) {
			if (!input.loaded) return void 0;
			if (input.mode === "selected" && input.scopeVersionDegraded) return void 0;
			if (input.mode === "global") return GLOBAL_EMPTY_HINT;
			return input.count === 0 ? SELECTED_EMPTY_HINT : void 0;
		}
		function ToolScopePanel({ client = defaultScopeClient }) {
			const [data, setData] = (0, react.useState)(void 0);
			const [loadError, setLoadError] = (0, react.useState)(void 0);
			const [mode, setMode] = (0, react.useState)("selected");
			const [ids, setIds] = (0, react.useState)([]);
			const [revision, setRevision] = (0, react.useState)(0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [saved, setSaved] = (0, react.useState)(void 0);
			const [failure, setFailure] = (0, react.useState)(void 0);
			const [versionBlocked, setVersionBlocked] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				let live = true;
				client.get().then((response) => {
					if (!live) return;
					setData(response);
					setMode(response.scope.mode);
					setIds([...response.scope.workspaceIds]);
					setRevision(response.scope.revision);
					setLoadError(void 0);
				}, (cause) => {
					if (live) setLoadError(describeCause(cause));
				});
				return () => {
					live = false;
				};
			}, [client]);
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
						path: "（注册表里没有该工作区的信息）"
					});
				}
				return list;
			}, [data, ids]);
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
			});
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
						label: (code === void 0 ? void 0 : SAVE_FAILURE_LABELS[code]) ?? `保存失败：${describeCause(cause)}`,
						detail: status === void 0 ? void 0 : `服务端返回 ${code}（HTTP ${status}）。`
					});
				});
			}, [
				client,
				ids,
				mode,
				revision
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "cherry-panel",
				"aria-labelledby": "cherry-scope-title",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						id: "cherry-scope-title",
						children: "启用范围"
					}),
					loadError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cherry-error",
						role: "alert",
						children: ["读取启用范围失败：", loadError]
					}),
					!loaded && loadError === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: "正在读取启用范围…"
					}),
					unsupported && data !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cherry-error",
						role: "alert",
						"data-scope-warning": "unsupported",
						children: [
							"宿主不支持工具作用域能力（只读告警）：",
							data.host.reason,
							"。请升级宿主 / DSH 以获得该能力后再试；升级前本插件不会注册这些工具。"
						]
					}),
					scopeVersionDegraded && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-error",
						role: "alert",
						"data-scope-warning": "scope-version",
						children: "作用域文档版本高于本插件支持，已进入只读降级：保存被禁用。重读仍是同一份文档，请升级宿主 / DSH 或本插件后再试。"
					}),
					listUnavailable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-error",
						role: "alert",
						"data-scope-warning": "workspace-list",
						children: "注册表列表当前读不到，已禁用保存（原因见下方降级标注）。"
					}),
					pending && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						role: "status",
						"data-scope-notice": "pending",
						children: "宿主服务挂载中，稍后自动就绪；此期间的配对与设备管理照常可用。"
					}),
					degraded.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "cherry-scope-degraded",
						children: degraded.map((note, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							"data-degraded-source": note.source,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: DEGRADED_LABELS[note.source] ?? note.source }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "cherry-hint",
								children: ["：", note.reason]
							})]
						}, `${note.source}:${index}`))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
						className: "cherry-scope-modes",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", { children: "模式" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: "cherry-scope-mode",
								checked: mode === "global",
								onChange: () => setMode("global")
							}), "全局"] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: "cherry-scope-mode",
								checked: mode === "selected",
								onChange: () => setMode("selected")
							}), "仅选定工作区"] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: EFFECT_NOTE
					}),
					options.length === 0 ? !listUnavailable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: "当前没有任何已注册的工作区。"
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
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "已失效（工作区已删除）" }) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: staleShown.map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
								className: "cherry-mono",
								children: id
							}, id)) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cherry-hint",
								children: "这些 id 在注册表里已不存在；保存时由服务端修剪，不会被判为非法输入。"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: save,
								disabled: saveDisabled,
								children: "清除已失效选择"
							})
						]
					}),
					unmatched.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cherry-scope-unmatched",
						"data-scope-unmatched": "",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "已勾选但会话 cwd 对不上" }) }),
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
								children: "这些会话勾选了工作区却拿不到工具：拼写不同 / 符号链接 / 该目录确实未注册，这三种原因在这里无法区分。本条只解释原因，不改动勾选或模式，也不会触发保存。"
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
								children: "保存启用范围"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "cherry-hint cherry-mono",
								"data-scope-revision": revision,
								children: ["当前 revision：", revision]
							}),
							saved !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cherry-ok",
								role: "status",
								"data-scope-saved": "",
								children: saved.pruned.length === 0 ? "保存成功。" : `保存成功，按服务端修剪清除了失效选择：${saved.pruned.join("、")}。`
							}),
							failure !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								"data-scope-save-error": failure.code,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-error",
									role: "alert",
									children: failure.label
								}), failure.detail !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cherry-hint cherry-mono",
									children: failure.detail
								})]
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
			if (source === void 0) throw new Error("EventSource is unavailable in this environment");
			return new source(url);
		};
		/** Parses one SSE frame payload, ignoring a malformed one rather than crashing. */
		function parseFrame(data) {
			try {
				return JSON.parse(data);
			} catch {
				return;
			}
		}
		function App({ eventSourceFactory = defaultEventSourceFactory, codeLifetimeMs, scopeClient }) {
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
					setError(cause instanceof Error ? cause.message : String(cause));
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
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "Cherry Studio 互联" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cherry-hint",
							children: "通过远程传输把本机 DeepSeek Harness 连接到 Cherry Studio 桌面端；设备档案保存在插件数据目录，页面不接触任何凭据。"
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
								children: "已配对设备"
							}),
							sorted.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cherry-hint",
								children: listed ? "暂无已配对设备，使用上方向导完成首次配对。" : "正在读取设备列表…"
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
		* Registers the settings page with the host shell.
		*
		* Registration goes through the `slots` service, exactly as the reference
		* plugin does — the host owns where a settings section appears, so a plugin
		* must never append its own container to `document.body`. `slots.inject` waits
		* for the slot to exist before `slots.register` claims a seat, and the returned
		* disposer is returned so the caller can tie it to the plugin lifecycle.
		*/
		function apply(ctx) {
			ctx.effect?.(() => installStyles(), `${SETTINGS_NAMESPACE}: settings styles`);
			if (ctx.slots === void 0) {
				console.warn(`[${SETTINGS_NAMESPACE}] client slots service unavailable; settings page not registered`);
				return;
			}
			ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots?.register({
				name: SETTINGS_SLOT,
				id: SETTINGS_NAMESPACE,
				order: 50,
				label: () => "Cherry Studio 互联",
				inject: () => ({})
			}, App));
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
