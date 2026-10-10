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
					setError("请先粘贴配对 payload");
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cherry-hint",
						children: "在 Cherry Studio 桌面端打开「远程连接 → 添加设备」，复制生成的配对信息，粘贴到下方。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ol", {
						className: "cherry-steps",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: "Cherry Studio 中生成配对信息（含地址、端口与一次性邀请）" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: "粘贴到下方输入框并开始配对" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: "对照 Cherry Studio 窗口上的 6 位验证码，确认后即完成" })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: "cherry-pair-form",
						onSubmit: submit,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								htmlFor: "cherry-payload",
								children: "配对 payload"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								id: "cherry-payload",
								value: payload,
								rows: 3,
								placeholder: "粘贴 Cherry Studio 生成的配对信息",
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
		function App({ eventSourceFactory = defaultEventSourceFactory, codeLifetimeMs }) {
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
		var styles_default = "/**\n * The settings page's own styles.\n *\n * Hand-written CSS, no UI framework (ruling 6). The palette follows the DSH web\n * client's dark-friendly aesthetic: it leans on `currentColor` and a few\n * neutral surface variables so the page reads correctly on both a dark and a\n * light shell, and the five state colours stay distinguishable (and are always paired\n * with a text label — colour alone is never the status).\n */\n.cherry-settings {\n  display: flex;\n  flex-direction: column;\n  gap: 20px;\n  padding: 16px;\n  color: inherit;\n  font-size: 13px;\n  line-height: 1.6;\n}\n\n.cherry-header h2 {\n  margin: 0 0 4px;\n  font-size: 16px;\n}\n\n.cherry-panel {\n  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);\n  border-radius: 10px;\n  padding: 14px 16px;\n  background: color-mix(in srgb, currentColor 4%, transparent);\n}\n\n.cherry-panel h3 {\n  margin: 0 0 8px;\n  font-size: 14px;\n}\n\n.cherry-hint {\n  margin: 4px 0;\n  opacity: 0.7;\n  font-size: 12px;\n}\n\n.cherry-mono {\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 12px;\n}\n\n/* --- pairing wizard ------------------------------------------------------ */\n\n.cherry-steps {\n  margin: 8px 0 12px;\n  padding-left: 20px;\n  opacity: 0.85;\n}\n\n.cherry-pair-form {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  align-items: flex-start;\n}\n\n.cherry-pair-form textarea,\n.cherry-inline-form input {\n  width: 100%;\n  box-sizing: border-box;\n  padding: 6px 8px;\n  border-radius: 6px;\n  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);\n  background: color-mix(in srgb, currentColor 6%, transparent);\n  color: inherit;\n  font: inherit;\n}\n\n.cherry-progress {\n  margin-top: 10px;\n  padding: 10px 12px;\n  border-radius: 8px;\n  border: 1px dashed color-mix(in srgb, currentColor 25%, transparent);\n}\n\n.cherry-code {\n  margin-top: 10px;\n  padding: 12px;\n  border-radius: 8px;\n  text-align: center;\n  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);\n}\n\n.cherry-code-digits {\n  display: block;\n  margin-top: 6px;\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 26px;\n  letter-spacing: 0.3em;\n}\n\n.cherry-ok {\n  color: #3fb950;\n}\n\n.cherry-error {\n  color: #f85149;\n}\n\n/* --- device cards -------------------------------------------------------- */\n\n.cherry-cards {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));\n  gap: 12px;\n  margin: 8px 0 0;\n  padding: 0;\n  list-style: none;\n}\n\n.cherry-card {\n  border: 1px solid color-mix(in srgb, currentColor 15%, transparent);\n  border-radius: 10px;\n  padding: 12px;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.cherry-card-head {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n}\n\n.cherry-card-title {\n  display: flex;\n  flex-direction: column;\n  min-width: 0;\n  flex: 1;\n}\n\n.cherry-state-label {\n  font-size: 11px;\n  opacity: 0.7;\n}\n\n.cherry-card-actions {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n}\n\n.cherry-card-facts {\n  display: grid;\n  grid-template-columns: auto 1fr;\n  gap: 2px 10px;\n  margin: 0;\n  font-size: 12px;\n}\n\n.cherry-card-facts dt {\n  opacity: 0.6;\n}\n\n.cherry-card-facts dd {\n  margin: 0;\n  overflow-wrap: anywhere;\n}\n\n.cherry-inline-form {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  align-items: flex-start;\n  padding-top: 6px;\n  border-top: 1px dashed color-mix(in srgb, currentColor 18%, transparent);\n}\n\n/* SCOPED DELIBERATELY. This stylesheet is injected into the HOST page's\n   document head, not a sandboxed frame, so a bare `button {}` rule restyles\n   every button in the host UI — a plugin must not do that. Every rule in this\n   file is therefore rooted at the plugin's own `.cherry-settings` class, which\n   is the single element the settings slot renders. */\n.cherry-settings button {\n  padding: 4px 10px;\n  border-radius: 6px;\n  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);\n  background: color-mix(in srgb, currentColor 8%, transparent);\n  color: inherit;\n  font: inherit;\n  cursor: pointer;\n}\n\n.cherry-settings button:disabled {\n  opacity: 0.5;\n  cursor: not-allowed;\n}\n\n/* --- five-state light ---------------------------------------------------- */\n\n.cherry-state {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 14px;\n  height: 14px;\n  flex: none;\n}\n\n.cherry-state-dot {\n  width: 10px;\n  height: 10px;\n  border-radius: 50%;\n  background: var(--cherry-state-color, #8b949e);\n  box-shadow: 0 0 6px var(--cherry-state-color, transparent);\n}\n\n.cherry-state[data-state='connected'] {\n  --cherry-state-color: #3fb950;\n}\n\n.cherry-state[data-state='connecting'] {\n  --cherry-state-color: #d29922;\n}\n\n.cherry-state[data-state='offline'] {\n  --cherry-state-color: #8b949e;\n}\n\n.cherry-state[data-state='disabled'] {\n  --cherry-state-color: #6e7681;\n}\n\n.cherry-state[data-state='identity-mismatch'] {\n  --cherry-state-color: #f85149;\n}\n\n.cherry-state[data-state='unknown'] {\n  --cherry-state-color: #484f58;\n}\n";
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
