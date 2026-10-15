# dsh-cherry-bridge 工具启用范围 + 配对文案 设计文档

- 日期：2026-10-15
- 状态：待用户审阅（已过一轮独立 builder 复核）
- 路径分类：Architectural（新增宿主集成子系统 + 配置面）
- 上游设计：[2026-10-09-cherry-dsh-bridge-design.md](2026-10-09-cherry-dsh-bridge-design.md)

## 1. 目标与背景

本插件现有 14 个 `cherry_*` 工具在**所有**工作区全局注册：每个会话的工具表里都有它们，
既占上下文，也可能干扰不需要该能力的工作区。本次两件事：

**① 配对提示措辞**。Cherry Studio 桌面端的配对界面**只显示二维码**，配对信息（地址/
端口/一次性邀请）要点开扫码后的网页才看得到。现有文案写的是「复制生成的配对信息」，
与实际操作不符，用户要求的说法是：请用微信或浏览器等扫码后，再把显示的配对信息拷贝
到配对框里。

**② 工具启用范围**。可配置为「全局」或「仅在勾选的工作区里启用」，未启用的工作区里
这些工具**不出现在模型的工具表里**。

### 用户原话（决策依据）

- 「工具本身占用上下文，可能会给不需要该工具能力的工作区造成干扰」
- 「这种情况应该手动在配置页的范围里勾选上该工作区，再继续该工作区的会话」（⇒ 无逃生口；改配置后**已在进行**的会话要立即生效）
- 「默认都不给」（⇒ 首次上线/作用域文档不存在时，任何工作区都不可见）

## 2. 决策台账

| # | 决策 | 谁定的 | 内容 |
| --- | --- | --- | --- |
| D1 | 隐藏而非拒绝 | 用户 | 不在范围 = **不进工具表**（省上下文）；不是"可见但调用报错" |
| D2 | 无逃生口 | 用户 | 没有"临时借用/会话内激活"通道；补救路径只有配置页 |
| D3 | 默认都不给 | 用户 | 文档不存在 = `selected` + 空列表 = 全部不可见 |
| D4 | 两种模式 | 用户 | `全局`（所有工作区）或 `仅选定工作区`（多选） |
| D5 | 工作区列表来源 | 本设计 | DSH 已注册工作区（`ctx.workspaceRegistry.list()`），沿用 `dsh-mcp-connector` 的既有先例 |
| D6 | 配置存哪 | 本设计 | 插件数据目录内的作用域文档（带 revision）；**不进** profile YAML，避免双真相源 |
| D7 | 无工作区的会话 | 本设计 | `仅选定` 模式下 fail-closed（不可见） |
| D8 | 宿主能力不足 | 本设计 | 缺 `tools.restrict` ⇒ **不注册**这 14 个工具并明确报告；绝不退回"全局可见" |
| D9 | 受管范围 | 本设计 | 14 个工具作为**一个整体**受管；设置页与 `/cherry-remote/api` **不受**范围影响（否则被排除的工作区无法自救/配对） |
| D10 | 生效方式 | 本设计（D2 的必然要求） | 配置变更时对**所有 live agent** 重装 restriction；下一轮装配即生效，无需重启或新建会话 |
| D11 | 空态呈现 | 本设计 | 设置页在"一个都没勾"时明确写出：此状态下工具不会出现在任何会话里 |
| D12 | restriction 安装的健壮性 | 本设计（复核 Q2） | `deny` 取**我们的名单 ∩ 当前已注册名单**（宿主的 `restrict` 遇未知名字/空过滤器直接失败）；交集为空则跳过（此刻没有可隐藏的东西）。安装失败 → 记录 + 标记 degraded（诊断/设置页可见）+ 等下一个 `tools/change` 或配置保存重试；**不**升级成"拒绝注册"（一次瞬时窗口不该让整个 profile 失去工具），也**不**静默 |
| D13 | 启用门槛 | 本设计（复核 Q4） | 门槛 = `tools.restrict` 可用 **且** `agents` 服务已挂载（缺任一都无法隐藏 ⇒ 走 B7）；`guard` 与 `schemas` **有则用**：`schemas` 用于 D12 的交集，`guard` 缺失时降级为"仅可见性"并在诊断/设置页标注（本功能的目标是上下文，不是安全边界） |
| D14 | 路径与收敛 | 本设计（复核 Q3） | 路径比较两侧都做 realpath 归一（归一失败退回原样比较）；`agent/created` 时两规则都不中的 agent 做**有界**延迟复检（如 +250ms、+2s 各一次），之后交给 `tools/change` 与配置保存触发 |

## 3. 目标 / 非目标 / 反目标

**目标**

- G1 不在范围内的工作区：14 个工具不进入该会话的工具表（模型看不到，无上下文成本）。
- G2 设置页可改：`全局` / `仅选定工作区` + 工作区多选；保存后即时生效（含进行中的会话）。
- G3 默认谁都不给（D3），且这个默认是**可解释的**：设置页空态写明原因与下一步。
- G4 判定与执行两侧一致：可见性层与执行兜底层用同一个纯函数判定"该 agent 是否有权"。

**非目标**

- 不做按工具、按设备、按会话的细分范围（14 个工具整体；设备级治理不在本次）。
- 不做会话级激活 / TTL（即 `dsh-mcp-connector` 的 session injection 那一套）。
- 不改 profile YAML 的配置面（`perSessionCacheBytes` / `rateBudgetPerSecond` 维持原样）。
- 不改配对协议、设备档案、订阅缓存等既有子系统。

**反目标**

- 假限制：只隐藏 UI 或在渲染层过滤、实际仍可执行 ⇒ 失败。
- 静默降级：宿主不支持所需原语时假装限制了、或悄悄退回全局可见 ⇒ 失败。
- 静默损坏：作用域文档读不出来时被当作"全局" ⇒ 失败（必须落到更严的一侧，见 B9）。

## 4. 宿主机制与先例（本机实测，实施时以这些为准）

宿主 `@deepseek-ai/dsh-tools` 0.2.0-rc.2（本机 profile `web` 实装版本）提供：

- `ctx.tools.register(definition): () => void` —— 可全局或在调用 agent 作用域注册；作用域注册遮蔽全局。
- `ctx.tools.restrict(filter: ToolRestriction): () => void` —— 类型注释原文：*Global tool
  names removed from visibility*；`ToolRestriction = { allow?: string[]; deny?: string[] }`；
  **多个 restriction 取交集**，且不影响作用域注册与保留的 PTC 通道；返回精确的解除函数。
  **失败条件（复核 Q2 补充）**：空过滤器、未知名字、作用域局部名字与保留传输名都会让
  `restrict()` 直接抛错——所以 `deny` 必须是"我们的名字 ∩ 当前已注册名字"（D12）。
- `ctx.tools.guard(guard): () => void` —— 派发口的单调守卫；经普通 ctx 注册为全局，经
  `agent.ctx` 注册只对该 agent 生效；返回字符串即拒绝，且没有"强制放行"的反向能力。
- `ctx.tools.schemas()` —— 当前工具表（用于自查与诊断）。
- 事件 `tools/change()` —— 工具注册/注销**或某个作用域的 restriction 变化**时触发；注释明确
  "a global change concerns every agent's next assembly"，即**每次装配重新读取可见性**，
  这就是 D10「即时生效」的机制依据。
- `ToolDefinition.execute(args, exec)` —— 参数在前、`exec: ToolRunContext` 在后（本插件现有
  `execute(args)` 形状与之兼容）；`exec.agent` 即调用方 agent（注释称之为 *the scope routing key*）。

Agent 与工作区：

- Agent 服务经 `ctx.inject(['agents'], (agentCtx) => agentCtx.effect(() => {...}))` 获取；
  `agentCtx.agents.list()` 列出 live agent，事件 `agent/created` / `agent/disposed`。
- 每个 agent 有 `agent.ctx.tools.restrict(...)`，即 restriction 按 **agent** 维度安装。
- 工作区注册表：`ctx.workspaceRegistry.list()` → `{ id, title, path, sessionIds }`。本机现有
  11 项：hermes、oa、dsh、ppt-master、specpowers、mcphub、1panel、llm、personal、cloud、workspace。
  注册表只有 `list()` / `get(id)` / `create(path, title?)`，**没有**按会话或按路径的查询方法，
  因此判定必须自建（与先例一致）。
- 会话归属判定（沿用先例顺序）：`workspace.sessionIds.includes(agent.id)` 命中优先；否则
  `agent.session.header.cwd === workspace.path`；两者都不中 ⇒ 无工作区（走 D7）。
  **时序依据（复核 Q3）**：`Session.header` 的类型注释写明它是 *detached, deep-frozen
  creation metadata*（format version、cwd、lineage…），即 `cwd` 在会话创建时即存在，所以第二条
  规则在 `agent/created` 时刻就能命中；`sessionIds` 是 header-validated 的成员投影，可能滞后，
  故只作"优先"而不作依赖。注册表**没有**成员变化事件（只有 archive/activity 面），因此收敛靠
  `tools/change`、配置保存与 D14 的有界复检。

现成先例 `dsh-mcp-connector@0.2.72`（本机已装，可直接对照源码）：

- `lib/session-injection.js`：`installRestriction(agent, denied)` **先装新层再释放旧层**（避免
  `tools/change` 竞态期间出现"无限制"窗口）；per-agent 保存 disposer；`refresh()` 在
  `agent/created` / `agent/disposed` / `tools/change` 上重算；`capabilities()` 探测
  `typeof ctx.tools?.restrict === 'function'`，缺能力时**拒绝启用**而不是降级。
- `lib/tools.js` + `lib/index.js`：`ctx.tools.guard(...)` 作为执行兜底；`workspaceIdForAgent` /
  `workspaceList` 即上面两条判定与列表来源。
- `lib/connection-scopes.js`：作用域文档形如 `{ connectionKey, global, projects[] }`，带
  `revision` 与最近 20 条 history，由插件自己的 UI 编辑——**D6 的先例**。

> ⚠️ 交集语义：restriction 是**取交集**的，叠加两层 deny 无法靠释放其中一层恢复。因此
> 任何时刻每个 agent 只允许存在**一层**本插件的 restriction，且必须"先装新、后释放旧"。

## 5. 行为规格（可测条目）

- **B1** 作用域文档不存在（首次升级即此状态）：每个 live agent 都装上 `deny: [14 个名字]`；
  模型工具表中没有 `cherry_*`（D3）。
- **B2** `mode = "global"`：不装 restriction；14 个工具对所有权 agent 可见（等价于今天的行为）。
- **B3** `mode = "selected"` + `workspaceIds = [W]`：属于 W 的 agent 可见；其他 agent 不可见。
- **B4** 保存配置后，**所有 live agent** 重算：正在进行的会话下一轮即可用/即消失；不需要重启
  DSH、不需要新建会话（D2 的用法要求）。
- **B5** `mode = "selected"` 且会话无工作区（cwd 不在注册表）：不可见（D7）。
- **B6** 执行兜底：guard 用与可见性相同的判定函数；拒绝时理由可读（含工作区标题或 id）。
- **B7** 宿主缺 `tools.restrict` **或** `agents` 服务始终未挂载（两者都无法隐藏）：**不注册**这
  14 个工具（fail-closed），诊断输出与设置页给出明确原因与升级提示；绝不退回全局可见（D8/D13）。
- **B8** 设置页与 `/cherry-remote/api` 在所有工作区都可用（D9）；配对向导照常工作。
- **B9** 作用域文档损坏/非法：按 `selected` + 空列表处理（更严的一侧），并在设置页提示；
  绝不静默变成全局。
- **B10** 反复 `apply`（HMR/重载）不产生叠加 restriction；插件销毁时释放全部 restriction 与
  guard、退订全部事件。
- **B11** 14 个工具的名字表是**单一常量**，可见性、guard、诊断、合约测试共用它（避免名单漂移）。
- **B12** restriction 的安装只提交"当前已注册"的交集名字；安装失败不抛到调用方、不静默：记录 +
  degraded 状态 + 下一个 `tools/change`/配置保存重试；**部分注册窗口**（HMR 中途只有部分工具在场）
  必须能装成功并随后补齐（D12）。
- **B13** 新会话在允许的工作区里**第一轮就有**工具：`cwd` 规则在 `agent/created` 即可判定；
  两规则都不中的 agent 走 D14 的有界复检，复检只可能把"暂时不可见"修正为"可见"（判定函数不变）。

## 6. 组件设计

### 6.1 作用域文档与存储（新文件，建议 `src/toolScope.ts`）

```jsonc
// $DSH_HOME/cherry-remote/scope.json   (0600)
{
  "version": 1,
  "revision": 3,
  "updatedAt": "2026-10-15T06:20:00.000Z",
  "mode": "selected",              // "global" | "selected"
  "workspaceIds": ["1a5d14fe-…"]   // mode=selected 时生效；去重、排序
}
```

- 读取：文件不存在 ⇒ `{mode:'selected', workspaceIds:[]}`（D3）；解析失败/字段非法 ⇒ 同样落到
  这一侧并记录 warn（B9）。
- 写入：沿用仓库既有原子写法（同目录 `.tmp` + fsync + rename，0600），`revision` 单调递增。
- 纯函数化：`normalizeScope(input)`、`isVisible(mode, workspaceIds, workspaceId | undefined)`
  —— 这两个函数是可见性层、guard、诊断、UI 与测试的**共同真相**（G4）。

### 6.2 宿主集成（新文件，建议 `src/toolScopeHost.ts`）

- 能力探测：`ctx.tools?.register/restrict/guard/schemas` 与 `ctx.inject` 是否可用；结果作为
  可读状态暴露给诊断与设置页（B7）。
- 装配：`ctx.inject(['agents'], (agentCtx) => agentCtx.effect(() => mount(agentCtx), 'cherry-remote.tool-scope()'))`。
- `mount`：订阅 `agent/created` / `agent/disposed` / `tools/change`；维护
  `Map<agent, disposer>`；每次重算遵循"先装新、后释放旧"；`agent/disposed` 时释放该 agent 的层。
- guard：在普通 ctx 上注册**一层**全局 guard（幂等），判定用 §6.1 的纯函数；不在范围内的调用
  返回可读理由（B6）。
- 与原注册路径的关系：`registerCherryTools` 保持现状（工具照常注册），**可见性由 restriction
  决定**；只有 B7（宿主无 restrict）才走"不注册"分支。

### 6.3 HTTP 面（扩展 `src/httpApi.ts`）

- `GET /cherry-remote/api/scope` → `{ scope: {mode, workspaceIds, revision}, workspaces: [{id,title,path}], host: {capable, reason} }`
  （工作区列表必须由插件侧读取注册表后下发，浏览器读不到）。
- `PUT /cherry-remote/api/scope` → 校验并原子写入；返回新 revision 与规范化后的文档。
- 沿用既有同源/信任围栏（Host/Origin/sec-fetch-site 规则），不新开例外。

### 6.4 设置页（扩展 `ui/src/*`）

- 新增「启用范围」面板：`全局` / `仅选定工作区` 二选一 + 工作区多选（标题 + 路径）。
- 空态文案（D11）：*尚未启用任何工作区——此状态下 `cherry_*` 工具不会出现在任何会话里；
  勾选后对应工作区的会话（含进行中的）即可使用。*
- 宿主能力不足时（B7）：面板顶部显示只读告警与原因，禁用保存。
- 保存后回显新 revision；失败（校验/IO）给出结构化错误，不改动本地状态。

### 6.5 配对文案（第 ① 项，**已实施**：`c4b8b80`）

> 状态：本条已随 `fix(pairing-ui): the desktop shows only a QR code — route the user
> through a scan`（`c4b8b80`）落地，并由 `tests/unit/ui.test.ts` 的 ①a 断言钉住。实施第 ② 项时
> **不要**重做这一节；下面保留为背景与措辞出处。

- `ui/src/PairingWizard.tsx` 顶部提示 →
  *「在 Cherry Studio 桌面端打开「远程连接 → 添加设备」；该界面显示的是二维码。请用微信或浏览器等扫码，把扫码后页面上显示的配对信息复制下来，粘贴到下方。」*
- 同文件三步说明 → ①桌面端「添加设备」显示二维码；②用微信/浏览器扫码，复制扫码页显示的
  配对信息（含地址、端口与一次性邀请）；③粘贴到下方开始配对，再对照桌面端窗口的 6 位验证码确认。
- 输入框标签与占位符 → 「扫码页显示的配对信息」。
- `cherry_pair` 的 `payload` 参数说明、`README.md`「首次配对」步骤、`docs/e2e-checklist.md`
  对应条目同步。

## 7. 测试策略

- 单测：`normalizeScope` / `isVisible` 的边界（缺失、损坏、未知 mode、重复 id、空列表）；
  会话→工作区判定的两种命中与都不命中。
- 集成：假 `agents` ctx（模拟 `inject` + `agents.list` + `agent/created|disposed` + `tools/change`
  + 可观测的 `restrict`/`guard`）驱动真插件装配，断言 B1–B13；特别断言"先装新后释放旧"与
  "不叠加"（B10，叠加会因交集语义不可恢复）、"部分注册窗口下按交集安装成功并补齐"（B12）、
  "新会话首轮即有工具 + 无 cwd 时的有界复检"（B13）。
- 契约：把「宿主 restrict/guard 交集语义」与「14 个工具名单单一真相」写成断言（B11）。
- 门禁：改 `src/` 或 `ui/` 后必须重建 `dist/` + `lib/`（`tests/unit/artifactFreshness.test.ts`
  会拦）；`tests/contract/contract.test.ts` 的既有断言（工具名、版本 pin、六项差异）必须继续绿。
- 真机：重启 DSH 后按 `docs/e2e-checklist.md` 新增步骤走一遍（默认不可见 → 勾选 → 进行中的
  会话即时可用 → 取消勾选即时消失 → 无工作区的会话不可见）。

## 8. 出界与推迟

- 按工具/按设备/按连接的范围细分；范围作用于 `/cherry-remote/api` 或设置页；范围的服务端强制
  多用户隔离（本插件是单机单用户假设）。
- 作用域文档的 history/回滚（`dsh-mcp-connector` 有 20 条 history；本次**不做**，只保留 revision）。
- 首次升级时的迁移向导（"要不要顺便帮你勾上 dsh 工作区"）——本次只做空态说明。

## 9. 留给实施者的决定

- 模块与文件的具体切分、命名、以及是否把 §6.1 的纯函数并入现有模块。
- 假 `agents` ctx 测试夹具的具体形状（仓库现有 loopback 夹具风格可复用）。
- 设置页多选控件的具体交互（列表 + 复选、搜索、全选/清空）。
- 诊断面（`src/diagnostics.ts`）里范围状态的具体字段与脱敏口径。
- restriction 安装时机与 `tools/change` 抖动下的去重策略细节（先装新后释放旧、按交集安装、
  失败重试这三条是硬约束，其余自定）。
- D14 有界复检的具体次数/间隔（约束是：有界、只在"两规则都不中"时启动）。
- degraded 状态在诊断与设置页的具体措辞。

## 10. 事实出处

- `@deepseek-ai/dsh-tools@0.2.0-rc.2`：`lib/types/index.d.ts` —— `ToolRestriction`（520 行附近）、
  `register` / `restrict` / `guard`（631–660 行）、`tools/change`（94–99 行）、
  `ToolDefinition.execute(args, exec)`（113–125 行）、`ToolRunContext`（297–312 行）。
- `dsh-mcp-connector@0.2.72`：`lib/session-injection.js`（`installRestriction` 144–165 行、
  `refresh` 167–190 行、`mountAgents` 351–373 行、`capabilities` 375–384 行）、
  `lib/tools.js`（guard 兜底 275–310 行附近）、`lib/index.js`（`workspaceIdForAgent` 223–230 行、
  `ctx.inject(['agents'], …)` 3358–3375 行）、`lib/connection-scopes.js`（文档形状）。
- `@deepseek-ai/dsh-session`：`lib/types/index.d.ts`（`Session.header` 为 *detached, deep-frozen
  creation metadata*，含 cwd —— 复核 Q3 的时序依据）。
- `@deepseek-ai/dsh-workspace`：`lib/types/index.d.ts`（`WorkspaceRegistry` 只有 `list/get/create`；
  事件面只有 `workspace/session-activity` / `workspace/session-stop`，无成员变化事件）。
- `@deepseek-ai/dsh-agent`：`lib/types/runtime-types.d.ts`（`agent/created` 载荷带 live session
  与 completed setup；`Agent.session`、`Agent.ctx`）。
- 本机工作区注册表：`$DSH_HOME/storages/workspace.json` 的 `tables.workspaces`（11 项，见 §4）。
- 第 ① 项的实施提交：`c4b8b80`（配对文案 + 其 UI 断言）。
- 本仓库既有约定：`docs/superpowers/specs/2026-10-09-cherry-dsh-bridge-design.md`、
  `docs/e2e-checklist.md`、`tests/contract/contract.test.ts`、`tests/unit/artifactFreshness.test.ts`。
