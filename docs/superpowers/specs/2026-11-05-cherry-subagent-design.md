# dsh-cherry-bridge：Cherry Studio 作为 DSH 子智能体（实验性）设计文档

状态：设计已定，待实施
日期：2026-11-05
调研记录：`_research/notes/2026-11-05-dsh-subagent-provider-seam.md`（gitignore，含逐条行号出处）

---

## 1. 目标与背景

DSH 0.2.2 的 `ctx.subagents` 是一条**命名 provider 注册表**接缝。官方已经用它在同一条接缝上封装了
Claude Code、Codex、以及基于 OAR 的七个外部 runtime：每个 provider 只声明 4 个字段，
真正干活的是 `start()` 里那 40 行共用助手。

本插件已经能把 DSH 的话发到 Cherry Studio 并读回答案（`cherry_send` / `cherry_wait` / `cherry_read`）。
把这些原语包成一个 provider，就能让 DSH 的模型**把任务委派给 Cherry Studio 里那个跑在桌面端的 agent**——
它有自己的模型、自己的工具、自己的知识库。这与官方封装的 Claude Code / Codex 是同一件事。

**本功能定位为实验性、默认关闭。** 理由不是谦虚：它跨了两个不受我们控制的系统（DSH 接缝 + Cherry 桌面端），
而其中若干语义（cwd 归属、子的角色边界、容量上限）在本仓库没有能力完整保证。

### 用户原话（决策依据）

> 可以深度调研参考deepseek harness的新版本（0.2.2）的基于subagent_oar的claude/codex dsh子智能体封装，看本插件能否借鉴参考实现类似功能，使得cherry studio也能够像官方封装的claude/codex一样作为子agent

> 按你建议来，也可先测并发，另外整个功能在配置页和readme和release说明里都标明是实验性功能，默认关闭，欢迎贡献思路和问题反馈

六条决策的逐条回答见 §2。

---

## 2. 决策台账

| # | 决策点 | 结论 | 依据 |
| --- | --- | --- | --- |
| D1 | cwd 归属 | 判据换成「共享 / 隔离」，一期只做**声明式**；`cwdMode` 默认 `isolated` | 协议里没有 workspace 路径，无法验证；「本地/远程」不是正确判据（DSH 在容器里，同一台机器路径也可能不同） |
| D2 | 子中途提问 | 一律 `cherry_respond` `deny`，绝不转发给人；连续放弃超限则整轮 error | 官方三级教义：能掐就掐（claude-code 删工具），不能掐就无人值守回答（codex 回空答案/挑非批准项），没有合法响应就 fail closed |
| D3 | 目标怎么选 | **不加工具参数**；用 `request.cwd` 匹配配置里的 `routes`，未命中回落默认目标 | 接缝没有 per-call 通道：provider 收到的对象由 `SubagentStartRequest` 锁死字段。`cwd` 是唯一被调用方影响又能到 provider 手里的字符串 |
| D4 | 工具归谁 | **自己注册 `subagent_cherry`**；provider 同时以 `cherry` 名注册 | 用户从插件市场装，「手改 profile 补丁」是真实门槛，与「装了就 work」冲突 |
| D5 | child id | 接缝 id 用 `randomUUID()`；工具返回值附带 `device` + `cherrySessionId` | 守「id 全局唯一」契约；可检查性（模型能 `cherry_read` 回看）用返回值给出，不混 id 空间 |
| D6 | 超时 | 默认有限 **30 分钟**，可配，`0` = 不限 | 与官方**刻意分歧**：codex 走「调用方取消」，但我们的调用方是模型，它手里没有取消工具；卡死的运行会占满 `maxActiveSubagents`（默认 8） |
| D7 | 实验性开关 | **一个开关**，默认关；关着时 provider 与工具都不注册 | 用户选定 |
| D8 | 反馈入口 | README 直接链到 GitHub issues 列表，不加新 label | 用户选定，零维护 |

### 实测支撑（D1 / D3 / D6 的前提）

| 事实 | 证据 |
| --- | --- |
| 协议没有 workspace 路径 | `remote-protocol/dist/agent.d.ts:670-675`（`workspaceSelectionSchema` 只有 id/system）、`:20-33`（`sessionSchema` 无 cwd） |
| 接缝没有 per-call 通道 | `dsh-subagent/lib/index.js:1504-1509`（provider 收到的是新建对象，字段由 `SubagentStartRequest` 锁死） |
| Cherry 侧**真并行** | 同一 agent 三会话同发，结束时刻相差 **348 ms**，各自耗时 85.9 / 85.2 / 85.2 s（串行应错开约 85 s） |
| 子的 persona 会拒任务 | 探针 A/B 被 `Cherry Assistant` 的角色边界拒绝 |

---

## 3. 目标 / 非目标 / 反目标

### 目标

- G1 让模型能把一个自包含任务委派给 Cherry Studio 的 agent，**不阻塞当前回合**，结束时收到通知。
- G2 目标是**配置声明的**，并且能被 `cwd` 上下文自动路由；模型不需要、也不能直接指定设备。
- G3 子永远不向人提问：所有 interaction 无人值守地放弃。
- G4 任何一次委派都有界：有超时、有放弃次数上限、能被父取消。
- G5 整个功能**默认不可见**，打开后配置页、README（中英一对）、CHANGELOG 都标明实验性。
- G6 诊断能区分「子拒绝执行」与「桥接/传输失败」——这两类用户该做的事完全不同。

### 非目标

- N1 不做可续子 agent（continuable / 冷恢复 / 后续消息）。接缝的 continuable 路径要求 manager 自己建本地 Agent，Cherry 侧没有对应物。
- N2 不做结构化输出（`outputSchema`）、模型选择（`agentOptions`）、深度上限（`depthLimit`）——provider 四项能力全 false，与官方外部 provider 一致。
- N3 不做远程机器/容器的 cwd 映射（SSH 方式留二期）。
- N4 不做进度流。子运行中途不可见；只能事后 `cherry_read`。

### 反目标

- A1 **不**把子 agent 的审批/提问转发给 DSH 的用户。这是官方明确拒绝的路径（codex README：「No human approval path」）。
- A2 **不**用 Cherry 的 sessionId 当接缝 child id。
- A3 **不**在 `enabled: false` 时注册任何 provider 或工具——模型不应该看见一个关着的功能。

---

## 4. 宿主机制与先例（实施时以这些为准）

### 4.1 provider 的形状

`SubagentProvider`（`dsh-subagent/lib/types/types.d.ts`）只需要：

```ts
{
  name: string
  capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }
  inheritsParentContext: false
  start?(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
}
```

`SubagentRun` 是 `{ id, result, dispose() }`。三条硬契约：

1. `result` **永不 reject**——子级失败解析成 `stopReason`。
2. 返回**之前**失败 = 清理半成品再 reject；返回**之后**的故障走 `result`。
3. `dispose()` 幂等，跑到真的停了。

### 4.2 两个共用助手的语义（本地重写，40 行）

| 助手 | 行为 |
| --- | --- |
| `settleRunResult` | `await attempt()`；`cancelled()` 为真 → `{output: collectOutput(), stopReason:'aborted'}`；抛错时同样先看 `cancelled()`，否则 `onError` + `diagnostic`（截 4096 字节）→ `stopReason:'error'`；`finally` 摘 abort 监听 |
| `subprocessRunHandle` | `dispose()` 记忆化一次：摘监听 → `requestCancel()`（**不假设子会配合**）→ `await teardown()` |

两者都是纯函数、无 import。**本地重写而非引入依赖**，与本仓库既有立场一致
（`src/tools.ts:46`：「Structural types, deliberately narrow」）。对冲漂移的方式见 §7.1。

### 4.3 官方 provider 的 `start()` 五步

1. 校验 prompt 只含 text 块、非全空白（claude-code 的 `textTask`）。
2. 建本地 `AbortController`，把 `request.signal` 接上（`{once:true}`）。
3. 起执行；失败则清理后 rethrow，并区分「取消导致的失败」与「真失败」。
4. `settleRunResult(...)`。
5. `subprocessRunHandle({ id: SessionId(randomUUID()), ... })`。

### 4.4 我们已有的原语

| 需要 | 现成的东西 |
| --- | --- |
| 建会话 | `agent.sessions.create`（`src/tools.ts` 的 `#createTool`） |
| 发消息并等终态 | `agent.messages.send` + 等待循环（`#sendTool`） |
| 只取本次 run 的 assistant 文本 | `#sendTool` / `#waitTool` 的终态聚合（「历史是累积的，peer 每次 run 追加一条新 assistant 消息」） |
| 放弃 interaction | `cherry_respond` 的 `decision: 'deny'` |
| 取消运行 | `cherry_cancel` 的 `agent.executions.cancel` |

**这四件事必须复用，不能另写一份**，否则工具面和子智能体面会给出不同的答案。

---

## 5. 行为规格（可测条目）

编号前缀 `SUB-`，每条都应当能被一个测试咬住。

### 5.1 注册与开关

| # | 规格 |
| --- | --- |
| SUB-01 | `subagent` 配置缺省、或 `enabled: false` 时，**不**调用 `subagents.registerProvider`，**不**注册 `subagent_cherry` 工具；`ctx.subagents.list()` 里没有 `cherry` |
| SUB-02 | 宿主没有 `subagents` 服务时，整个插件其余功能照常工作；子智能体子系统停在 `unavailable` 并带原因，不抛 |
| SUB-03 | `enabled: true` 但目标配置不完整（缺 `device` / `agentId` / workspace 二选一）时，子智能体子系统停在 `failed` 并带**可读原因**（列出缺哪一项），插件其余功能照常 |
| SUB-04 | `enabled: true` 且配置完整时，注册 provider 名 `subagent.providerName`（默认 `cherry`）与工具 `subagent.toolName`（默认 `subagent_cherry`） |
| SUB-05 | provider 的 `capabilities` 四项全 `false`，`inheritsParentContext` 为 `false` |
| SUB-06 | 卸载/重载插件时 provider 与工具都被摘掉（用 `registerProvider` 返回的 disposer 与工具 disposer） |

### 5.2 目标路由

| # | 规格 |
| --- | --- |
| SUB-10 | `routes` 按声明顺序匹配，**第一个** `cwdPrefix` 在**路径分段边界**上是 `request.cwd` 前缀的命中（`/w/dsh` 不匹配 `/w/dsh2`） |
| SUB-11 | 路由命中项可以只覆盖 `workspaceId`（沿用默认 `device`/`agentId`），也可以覆盖 `device` |
| SUB-12 | 无路由命中时回落默认目标 |
| SUB-13 | 路由表为空或缺省时，全部委派走默认目标（不报错） |
| SUB-14 | `cwdPrefix` 比较前两端都做路径规范化（去掉尾斜杠、`..` 折叠），且**大小写敏感** |

### 5.3 provider.start 的执行序

| # | 规格 |
| --- | --- |
| SUB-20 | prompt 含非 text 块 → 在**建任何 Cherry 会话之前**抛错 |
| SUB-21 | prompt 全空白 → 同样在建会话之前抛错 |
| SUB-22 | 正常路径：建会话 → 发消息 → 等终态 → 折叠本次 run 的 assistant 文本 → `{output:[{type:'text',text}], stopReason:'completed'}` |
| SUB-23 | 建会话标题取 `request.label`（接缝会传），缺省取 prompt 前 60 字 |
| SUB-24 | `request.signal` 已 abort → 立即抛错，不建会话 |
| SUB-25 | 运行中 `request.signal` abort → Cherry 侧取消该 run，结果 `{stopReason:'aborted'}`，`output` 取已收到的部分 |
| SUB-26 | `dispose()` 幂等：第一次取消 Cherry run 并释放订阅，后续调用返回同一个 Promise |
| SUB-27 | `result` 在任何路径下都不 reject（含 Cherry 侧 `failed`/`interrupted`/传输错误） |

### 5.4 interaction 策略（D2）

| # | 规格 |
| --- | --- |
| SUB-30 | 等待期间出现 pending interaction → 对每一条 `cherry_respond` `decision: 'deny'`，然后**继续等**，不结束运行 |
| SUB-31 | 同一个 run 内放弃次数超过 `maxInteractionAbandons`（默认 8）→ 取消该 run，`stopReason:'error'`，`diagnostic` 说明「子反复要求人工介入」 |
| SUB-32 | 任何情况下**不**把 interaction 呈现给 DSH 侧用户，不产生 `ask_user_question` 调用 |

### 5.5 超时（D6）

| # | 规格 |
| --- | --- |
| SUB-40 | `timeoutMs` 默认 `1_800_000`（30 min），从**发消息成功**起算，不含建会话 |
| SUB-41 | 到期 → 取消 Cherry run，`stopReason:'error'`，`diagnostic` 说明超时值与「运行可能仍在桌面端继续」 |
| SUB-42 | `timeoutMs: 0` → 不设挂钟上限，只靠父取消 |
| SUB-43 | `timeoutMs` 非法（负数、NaN、超过 timer 上限）→ 子系统 `failed` 并带原因 |

### 5.6 停止原因与诊断

| # | 规格 |
| --- | --- |
| SUB-50 | Cherry 执行状态 `completed` 且折叠出非空文本 → `completed` |
| SUB-51 | `completed` 但折叠出空文本 → `error`，`diagnostic` 说明「子完成了但没有产出文本」 |
| SUB-52 | `failed` / `interrupted` → `error`，`diagnostic` 带 peer 的 `error.reason`（不是原始 JSON） |
| SUB-53 | `diagnostic` 不超过 4096 UTF-8 字节，且**不含**凭据、消息正文、原始协议负载 |
| SUB-54 | 子**拒绝执行**（persona 角色边界）仍然是一次 `completed`——它的拒绝文本就是 `output`。工具 description 必须告诉模型这种情况会发生 |

### 5.7 工具面

| # | 规格 |
| --- | --- |
| SUB-60 | 工具参数：`description`（必填 string）、`prompt`（必填 string）、`cwd`（可选 string）；**没有** `device` / `agentId` / `workspace` 参数 |
| SUB-61 | 参数 schema 落在宿主的 JSON Schema 子集内（复用 `tests/unit/toolParameterSubset.test.ts` 的检查器，#219） |
| SUB-62 | 返回值 `{kind:'activation', subagentId, device, cherrySessionId}`，`render` 为 `started subagent <subagentId>` |
| SUB-63 | `isConcurrencySafe: () => true` |
| SUB-64 | 工具 description 必须写明：子在自己的上下文里工作、看不到本对话、**不接受后续消息**、可能拒绝任务、完成后会有通知 |
| SUB-65 | 没有 calling agent（`exec.agent === undefined`）→ 抛错 |

### 5.8 实验性标注（用户硬要求）

| # | 位置 | 规格 |
| --- | --- | --- |
| SUB-70 | 配置页 | 区块标题带「实验性」字样与默认关闭的说明；开关默认 `false` |
| SUB-71 | 配置页 | 可见一段「欢迎贡献思路和问题反馈」+ 指向 `https://github.com/SAXEM1997/dsh-cherry-bridge/issues` 的链接 |
| SUB-72 | `README.md` 与 `README.en.md`（**一对，同一次提交**） | 各有一节，标明实验性、默认关闭、反馈入口、以及 §8 的限制清单 |
| SUB-73 | `CHANGELOG.md` | 该版本的条目里标明「实验性 / 默认关闭」 |
| SUB-74 | release notes | 同 CHANGELOG 的措辞（release body 逐字来自 CHANGELOG 段落） |

---

## 6. 组件设计

### 6.1 新文件 `src/subagent.ts`

职责：**只有 provider 与接缝适配**，不认识 UI、不认识 HTTP。

```ts
export const CHERRY_SUBAGENT_PROVIDER_DEFAULT = 'cherry'
export const CHERRY_SUBAGENT_TOOL_DEFAULT = 'subagent_cherry'
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 1_800_000
export const DEFAULT_MAX_INTERACTION_ABANDONS = 8

/** 接缝要求的四项能力全 false（本地转录，见 §7.1）。 */
export const NO_START_CAPABILITIES = Object.freeze({
  agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false,
} as const)

export function settleRunResult(parts: RunResultSettlement): Promise<SubagentResult>
export function externalRunHandle(parts: ExternalRunHandleParts): SubagentRun
export function matchRoute(routes, cwd): Target | undefined   // SUB-10..14
export function createCherryProvider(deps): SubagentProvider   // SUB-05, SUB-20..54
```

`deps` 是**窄结构类型**，形状与本仓库既有风格一致（`src/toolScopeHost.ts` 的 `ScopeHostContext`）：
只需要「跑一次委派」这一个能力，由 `src/tools.ts` 提供，不让 provider 认识 rpc 细节。

### 6.2 新增的复用缝：`src/tools.ts` 的一个内部方法

现有 `cherry_send` 的终态聚合逻辑是私有方法。为让 provider 复用同一份判定，新增一个内部方法：

```ts
/** 建会话 → 发消息 → 等终态（含 interaction 放弃策略）→ 折叠本次 run 的文本。 */
async runOnce(input: {
  device: string; agentId: string
  workspace: { workspaceId: string } | { kind: 'system' }
  title: string; text: string
  timeoutMs: number | undefined
  maxInteractionAbandons: number
  signal: AbortSignal
  onSessionCreated(sessionId: string): void
}): Promise<{ status; text; diagnostic? }>
```

`onSessionCreated` 是 D5 的落点：provider 在会话建好、`start()` 返回之前把
`runId → {device, sessionId}` 记进插件内的一个 `Map`，工具在 `startActivation` 返回后读它。
这个顺序是安全的，因为接缝规定 provider 必须在返回 run **之前**建立好子。

### 6.3 新文件 `src/subagentTool.ts`

职责：工具定义 + 那次 `startActivation` 调用。形状照 `dsh-experimental-tool-subagent-oar`
（`execute` 三句），返回值补上 D5 的两个字段。

### 6.4 装配 `src/index.ts`

- `CherryBridgeConfig` 增加 `subagent?: SubagentConfig`。
- 在**已有的** `ctx.inject([...], cb)` 模式旁，再加一个 `ctx.inject(['subagents'], cb)`——
  **不能**把 `subagents` 写进 `inject = ['tools']`，那会让插件在缺该服务的组合里永久 pending。
- 子系统状态用既有的三态（`pending` / `ready` / `unavailable|failed` + reason），
  与 `toolScopeHost` 的 `READY_REASON` / `PENDING_REASON` 同一套措辞风格。

### 6.5 设置页 `ui/src/*`

一个「实验性」区块：开关（默认关）、实验性徽标、目标三字段（device / agentId / workspace）、
`cwdMode`、`routes`（可先只读展示，编辑留二期）、`timeoutMs`、反馈链接。

### 6.6 常量 `src/defaults.ts`

§6.1 的四个默认值集中在这里，docblock 写明「这些是**文案里也要出现的数字**」——
与 `#219` 的做法一致（数字搬进 description 后由测试钉住）。

---

## 7. 测试策略

### 7.1 接缝契约的转录测试（本设计的关键防线）

本仓库不依赖 `@deepseek-ai/*`，所以 provider 的形状、`settleRunResult` 的语义、`dispose()` 的幂等性
都是**我们自己转录**的。必须有 hermetic 测试钉住：

- provider 对象满足 manager 的注册前置（有 `start`；`capabilities` 四键齐全且为布尔；`inheritsParentContext` 为布尔）。
- `settleRunResult` 的三态：完成 / 取消 / 抛错，各自产出正确的 `stopReason`，且**永不 reject**。
- `externalRunHandle` 的 `dispose()` 幂等：两次调用返回同一 Promise，`teardown` 只跑一次。
- `diagnostic` 截断到 4096 字节。

docblock 钉住宿主版本（`@deepseek-ai/dsh-subagent@0.2.2-rc.1`），并写明**未钉住**：
宿主将来改这两个助手的语义，转录不会自动跟随。

### 7.2 路由

`matchRoute` 的纯函数单测，覆盖 SUB-10..14，含边界：空路由表、尾斜杠、`..`、大小写、最长前缀 vs 声明顺序。

### 7.3 provider 端到端（loopback fake）

用 `tests/loopback/fakeCherry.ts` 驱动 `start()` 的每条路径：

| 用例 | 期望 |
| --- | --- |
| 正常完成 | `completed` + 正确文本 |
| 子中途抛 interaction | 自动 deny 后继续，最终 `completed`（SUB-30） |
| interaction 刷屏 | 超过上限 → `error` + diagnostic（SUB-31） |
| 超时 | `error` + diagnostic 含超时值（SUB-41） |
| 父取消 | `aborted`（SUB-25） |
| peer `failed` | `error` + `error.reason`（SUB-52） |
| 空文本 | `error`（SUB-51） |
| 非 text 块 prompt | 建会话前抛错（SUB-20） |

### 7.4 工具面

- schema 落在子集内（扩展 `tests/unit/toolParameterSubset.test.ts` 的工具清单，SUB-61）。
- 参数与返回值的形状（SUB-60/62）。
- `enabled: false` 时工具不存在（SUB-01）。

### 7.5 变异验证

每个新增测试都要按仓库规则做变异验证：故意破坏实现（反转分支、删守卫、返回旧值），确认测试变红，
且**每个声称的守卫要有各自独立的变异**。特别要验的是：

- 删掉 `cancelled()` 检查 → SUB-25 必须红。
- 把 `dispose()` 的记忆化去掉 → 幂等性测试必须红。
- 把 interaction deny 换成 approve → SUB-30 必须红。
- 把 `timeoutMs` 的到期分支删掉 → SUB-41 必须红。

### 7.6 文档一致性

- `README.md` / `README.en.md` 必须同时改动（仓库规则：一对）。
- `artifactFreshness`：`src/**` 与 `dist/` 同一次提交。
- `src/AGENTS.md` 若新增子智能体不变量，需在同一次改动里做**补偿性删减**（当前 62,153 / 64,512 字节）。

---

## 8. 出界与推迟

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 可续子 agent（后续消息、冷恢复） | 出界 | 接缝的 continuable 路径要求本地 Agent，Cherry 侧没有对应物 |
| 结构化输出 / 模型选择 / 深度上限 | 出界 | provider 四项能力全 false，与官方外部 provider 一致 |
| 远程机器 / 容器的 cwd 映射（SSH） | 二期 | 用户明确分期 |
| `routes` 的可视化编辑 | 二期 | 一期只读展示 + 配置文件手写 |
| 进度流（子运行中途可见） | 出界 | 只能事后 `cherry_read` |
| 容量上限实测到 8 | 未验证 | 已证 N=3 并行；N=8 是否被 Cherry 侧限流未知 |
| 并发下的单任务延迟劣化 | 未验证 | 三条探针都是 ~85 s，只能说明没有数量级退化 |

### 已知限制（必须进 README）

1. **一次性**：没有后续消息、没有冷恢复、没有结构化输出、没有进度流。
2. **无沙箱继承**：子运行在 Cherry Studio 自己的权限模型下；DSH 的 sandbox、审批 UI 都不适用。
3. **子可能拒绝任务**：Cherry agent 有自己的角色边界，拒绝是正常结果，不是故障。
4. **`cwdMode: shared` 是声明，不是验证**：我们无法证明两端文件系统真的共享；声明错了，子会在它自己的目录里工作。
5. **容量未知**：`maxActiveSubagents` 默认 8，Cherry 侧是否存在更低上限未验证。

---

## 9. 留给实施者的决定

1. **`runOnce` 放哪**：作为 `CherryTools` 的私有方法 + 一个导出的窄接口，还是把终态聚合抽成独立纯函数？
   倾向后者——纯函数更好测，但改动面更大。按最小改动原则，先做前者。
2. **`routes` 一期的编辑形态**：配置文件手写 + 设置页只读展示，还是设置页也能加行？
3. **会话标题**：`request.label` 是否足够（它是模型给的 `description`），还是加前缀 `[dsh-subagent] ` 便于在 Cherry 侧筛出来？
4. **`cwdMode: shared` 一期是否发**：可以先只发 `isolated`，把 `shared` 留到二期——那会让 §6.4 少一个分支。
5. **反馈链接是否带版本号**：`issues` 列表 vs 预填模板。

---

## 10. 事实出处

| 结论 | 出处 |
| --- | --- |
| provider 只有 4 个字段 | `dsh-subagent-claude-code/lib/index.js:331-360`、`dsh-subagent-codex/lib/index.js:471-510`、`dsh-experimental-subagent-oar/lib/index.js:14551-14557` |
| 两个共用助手 40 行纯函数 | `dsh-subagent/lib/index.js:2803-2910` |
| 接缝无 per-call 通道 | `dsh-subagent/lib/index.js:1504-1509` |
| provider 的注册前置与能力校验 | `dsh-subagent/lib/types/index.d.ts`（`registerProvider`）、`lib/index.js:3273` |
| 官方「不转发审批」教义 | `dsh-subagent-codex/README.md:13, 88`；`dsh-subagent-claude-code` 的 `claudeQueryOptions`（`disallowedTools: ["AskUserQuestion"]`） |
| 协议无 workspace 路径 | `@cherrystudio/remote-protocol@0.7.0` `dist/agent.d.ts:20-33, 670-675` |
| `execution.status` 含 `awaiting-approval` | 同上 `:34-44` |
| 三会话真并行 | 本文件 §2 实测表（`_research/notes/2026-11-05-dsh-subagent-provider-seam.md` §9.5） |
| 子 agent 会拒绝通用任务 | 探针 A/B（同上 §9.5） |
