# cherry-tool-scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本计划的书写约定**（与仓库既有计划 `2026-10-09-dsh-cherry-bridge.md` 同风格）：每个 task 的
> Step 1 给出**测试文件名 + 断言逐条**（含规格里钉死的值：签名、常量、稳定错误码、动作次序），
> **不逐段抄测试体**——执行者按断言写测试。凡"不可自定"的部分（disposers 释放次序、`deny` 取交集
> 的观测源、空集语义、错误码字符串、HTTP 状态码）逐字给出；其余实现细节自定。

**Goal:** 把 14 个 `cherry_*` 工具从"所有工作区全局可见"改成"按作用域文档（全局 / 仅选定工作区）受管"——未启用的工作区里它们**不进模型的工具表**，改配置后**进行中的会话下一轮即生效**。

**Architecture:** 新增一个状态所有者（`src/toolScope.ts`：作用域文档 + `degraded` 集合 + 规范化路径映射 + 每 agent 判定缓存 + **已装层记录**）与一个宿主集成层（`src/toolScopeHost.ts`：能力三态、注入门控的**唯一装配点**、restriction 安装/释放、guard、合并式重入闸、有界复检）。工具仍注册在插件根 ctx 的**全局层**，可见性**只**由装在每个 `agent.ctx` 上的 restriction 决定；HTTP 面新增 `GET/PUT /cherry-remote/api/scope`，设置页新增「启用范围」面板。

**Tech Stack:** TypeScript (Node ≥22.18)、Cordis 插件（`ctx.inject` / `ctx.effect`）、`@deepseek-ai/dsh-tools` restriction/guard 面（**以结构化类型对接，不新增运行时依赖**——与 `src/tools.ts:69-76` 的既有做法一致）、vitest（jsdom 用于 UI 测试）、tsdown + vite 构建、React。

**Spec:** `docs/superpowers/specs/2026-10-15-cherry-tool-scope-design.md`（实测 **834** 行；**spec 头部的状态行照录于此（spec 第 4 行逐字），计划侧不另写一套状态叙述**：`- 状态：已复审（两轮外部审查 + 最终通读 PASS）+ 计划阶段按 Gate 2 结论补三处澄清（工作区列表三态 / guard 作用域 / B18① 极性修正）`；计划阶段落进 spec 的消歧**一律以 spec 正文为准**，其中本计划正文逐条消费的两处是：**工作区列表三态**（§6.1，未读 / 读成功 / 读失败）与 **guard 作用域**（§4，只对 `CHERRY_TOOL_NAMES` 生效）。**本计划从 spec 立论，执行者必须同时读 spec**）。**本计划自身的行数不在此写死**：以文末「Self-Review 记录」节的实测值为准。澄清记录：`docs/superpowers/clarifications/cherry-tool-scope.md`。

## Global Constraints

- **唯一装配点**：工具的注册、restriction、guard、事件订阅全部落在**注入回调内的同一个 effect**，其 disposer 是那个 effect 的返回值（B10/§6.2）。
- **两个新依赖键只进 `ctx.inject(...)` 这一次调用**：`agents` / `workspaceRegistry` **只**出现在 `ctx.inject(['agents','workspaceRegistry'], …)` 里，**不得**加进插件的静态 `export const inject`（`src/index.ts:24`）——`tests/integration/httpApi.test.ts:1436-1437` 断言 `index.inject` **恰为 `['tools']`**。
- **teardown 次序即正确性**：① 先退订全部事件（或先置 `torn-down` 标志使重算短路）⇒ ② 再释放注册 ⇒ ③ 再释放全部 restriction ⇒ ④ 最后释放 guard；同一次 teardown **一并作废**判定缓存 / 规范化路径映射 / 解析状态 / `pathUnmatched` / 已装层记录。
- **ctx 术语三词并用（不得使用未定义的说法）**：**插件根 ctx**（工具注册与 guard 的安装面）/ **注入回调 ctx**（`ctx.inject` 的回调 ctx：取服务、承载 effect）/ **`agent.ctx`**（restriction 的唯一合法安装面）。三者在全文一律按这三个名字称呼。
- **restriction 只装 `agent.ctx`**；在**插件根 ctx** 或**注入回调 ctx** 上调用会抛 `tools.restrict() requires a scoped context (agent.ctx)`。**只用 `deny`、绝不用 `allow`**。
- **`deny` 的观测源**：**无参全局视图** `ctx.tools.schemas()` ∩ `CHERRY_TOOL_NAMES`；**禁止** `schemas(agent)`（已被 `layers.every(admits)` 过滤，自引用会把已隐藏的工具放回去）。
- **空集语义**：目标 deny 为空集 ⇒ **只释放、不安装**；观测集合为空（工具尚未注册）⇒ **绝不提交空 `deny`**（会装成 no-op 层，被 guard 误读成"已隐藏"），但既有层的释放照常。
- **每 agent 任一刻只允许一层**本插件的 restriction；换层一律"**先装新、后释放旧**"（restriction 取交集，叠加不可恢复）。
- **同步判定**：guard、restriction 安装与 `agent/created` 监听器**只读缓存**，绝不在同步窗口里 `await`；缓存未命中即按 **D7** 处理——**仅 `selected`** fail-closed（不可见）；**`global` 下按唯一定义式 `isVisible(doc, judgement(agent)?.workspaceId)` 仍为可见 ⇒ 目标集合为空集、只释放不装层**，并触发重算。
- **默认都不给**：文档不存在 ⇒ `mode:'selected'` + 空列表 ⇒ 谁都不给；文档读不出/字段非法 ⇒ 落到严格度序（`selected`+空 > `selected`+非空 > `global`）**更严**的一侧，**绝不**静默变成全局。
- **稳定错误码**（字符串常量，不得往 `error` 槽位塞对象）：`invalid-scope`(400) / `missing-expected-revision`(400) / `scope-revision-conflict`(409) / `workspace-list-unavailable`(503) / `scope-version-unsupported`(503)。
- **作用域文档**：`$DSH_HOME/cherry-remote/scope.json`，0600，原子写（`.tmp` + fsync + chmod + rename），`revision` 单调递增；**权威态在内存**，写盘仅作持久化。
- **设置页与 `/cherry-remote/api` 不受范围约束**（被排除的工作区必须能自救与配对，D9）。
- 改 `src/` 后**必须 `npm run build`**、改 `ui/` 后**必须 `npm run build:client`**，并把重建后的 `dist/`（或 `lib/client.js`）**放进同一个 commit**——`tests/unit/artifactFreshness.test.ts` 用 `git show HEAD:<产物>` 与"当前源码的重建结果"逐字节比对，源码提交而产物没提交就红。**tsconfig 登记规则（只在 UI 环境测试上适用）**：**只有 UI 环境测试**（jsdom / `@testing-library/react`，如 `tests/unit/ui.test.ts`）需要**同时**登记进 `tsconfig.ui.json` 的 `include` **与** `tsconfig.json` 的 `exclude`——两个项目必须对 `tests/**/*.test.ts` 构成"**恰好被一个项目检查**"的划分（`tests/unit/projectCoverage.test.ts`）；Node 侧测试落在 `tests/**` 里**无需登记**（server 项目的 `include` 已含 `tests`）。**漏登记一边**（漏 `exclude` ⇒ 两个项目都编译它；漏 `include` ⇒ 谁都不编译它）会被 `tests/unit/projectCoverage.test.ts` 与 `npm run typecheck` 一起抓到；**两边都漏**时该文件落回 server 项目、`projectCoverage` 反而不报，仍由 `npm run typecheck` 抓到（它会在缺 DOM / JSX 的项目里编译该文件）。
- 文案只说"**本插件未遮蔽**这些工具"，**不得**声称"模型一定能看到 / 一定能调用"（上游 `allow` 型过滤可能整体遮蔽，那是接受的行为，B15）。
- 测试命令：单文件 `npx vitest run <path>`；全量门禁 `npm run typecheck && npm test`；构建 `npm run build && npm run build:client`。**全量 `npm test` 只能在产物已提交之后跑**：`tests/unit/artifactFreshness.test.ts` 以 `git show HEAD:<产物>` 与"当前源码的重建结果"逐字节比对，产物只在工作区里、或源码与产物不在同一个 commit ⇒ 必红。
- **同一文件同一时刻只能有一个写者**：见文末「文件写者矩阵」，执行时按它串行化子代理。

## Review Focus

spec 未逐条测试、但最可能咬到真实用户的五类输入（每条都已在拥有它的 task 里落成断言）：

1. **`restrict()` 的入参形状**——空 `deny` 会装成"对任何名字都放行的 no-op 层"，而本插件的 guard 是"层在 ⇒ 拒绝"，于是**工具可见却被拒**：夹具必须记录**每一次** `restrict` 入参，断言从未出现 `{deny: []}`（Task 5 ①）。
2. **依赖卸载 → 重挂循环**（HMR / 重载 / 宿主依赖重启）——注册与隐藏必须同生共死，卸载后任一时刻不得存在"已注册未隐藏"，重挂后不得叠加第二层、不得抛 `already registered`，释放动作自身发出的 `tools/change` 不得把层装回来（Task 4 ④⑤）。
3. **并发保存**——两个携带同一基准 revision 的 `PUT` 同时到达：校验与写入之间不得有 `await`，否则后写静默覆盖先写（Task 7 ⑦）。
4. **路径同一性**——符号链接 / 大小写 / 拼写差异，以及无 `cwd` 的会话、注册表里根本没有的目录：判定必须只有一套契约（规范化后相等），老宿主如实退化，且"勾了却没工具"必须能从诊断看出是**路径对不上**（Task 3 ②③④ + Task 7 ⑩）。**这些输入一律不得反向改写可见性**：`visible` 只由 `isVisible(doc, workspaceId)` 决定，`global` 模式下恒为真（与 cwd、与列表可用性都无关），fail-closed 只适用于 `selected`（Task 3 ④⑧⑨）。
5. **上游 `allow` 遮蔽被误报成本插件故障**——子代理等上游把 `cherry_*` 整体遮蔽时，guard 不得拒绝、不得报 degraded、文案不得声称"模型可见"（Task 5 ⑧ + Task 8 ⑦）。

---

### Task 1: 14 个工具名的单一常量 + 契约断言（B11）

**Files:**
- Modify: `src/tools.ts`（新增导出常量；`registerCherryTools` 附近加"名单来源"注释）
- Test: `tests/contract/contract.test.ts`（**替换** 322–337 行已有的第二份 `TOOL_NAMES` 名单：改为从 `src/tools.ts` 导入 `CHERRY_TOOL_NAMES`；1668 行的 README 断言与 1677 行的 rig 断言沿用，不新开第二份名单）

**Interfaces:**
- Produces: `export const CHERRY_TOOL_NAMES: readonly string[]`（顺序固定：`cherry_devices`, `cherry_agents`, `cherry_workspaces`, `cherry_sessions`, `cherry_read`, `cherry_events`, `cherry_create`, `cherry_send`, `cherry_wait`, `cherry_interactions`, `cherry_respond`, `cherry_cancel`, `cherry_pair`, `cherry_unpair`）
- 后续 task 消费它：可见性（Task 5 的 `deny` 交集）、guard 的理由、诊断、契约测试。

- [ ] **Step 1: 写失败测试**——`tests/contract/contract.test.ts`：① 从 `../../src/tools.js` 导入 `CHERRY_TOOL_NAMES`，把 **322–337 行的 `TOOL_NAMES` 字面量整段删除**，令 `const TOOL_NAMES = CHERRY_TOOL_NAMES`——那份名单同时被 1668 行（README 逐名断言）与 1677 行（rig 注册名断言）消费，替换后两处断言对**同一常量**生效；"两份名单逐名相等"这类**等价性断言因此不再需要**（不存在第二份名单可比）。② `CHERRY_TOOL_NAMES` 长度 14、无重复（`new Set(...).size === 14`）、全部以 `cherry_` 开头；③ 用收集型假 `ctx.tools`（`tests/integration/toolsRead.test.ts:42` 的 `makeCtx` 同形）跑 `registerCherryTools`，断言**实际注册的名字集合与常量集合双向差集为空**（漏一个或写错一个名字都必须红）。**这就是 B11「单一常量」的落地方式：合约测试与可见性 / guard / 诊断共用同一份名单**。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/contract/contract.test.ts`，预期 FAIL（`CHERRY_TOOL_NAMES` 未导出）。
- [ ] **Step 3: 实现**——在 `src/tools.ts` 导出该常量（`as const` 亦可，但导出类型标 `readonly string[]`），并在 `registerCherryTools` 上方写明：**这是可见性 / guard / 诊断 / 契约测试的唯一名单来源**，`CherryToolEngine.definitions()` 与它漂移由契约测试拦截。
- [ ] **Step 4: 运行确认通过**——同命令，预期 PASS。
- [ ] **Step 5: 门禁**——`npm run typecheck`（`src/tools.ts` 与 `tests/contract/contract.test.ts` 都落在 server 项目：`src` 与 `tests` 已在 `tsconfig.json` 的 `include` 里，**无需登记**，见 Global Constraints 的 tsconfig 规则）。
- [ ] **Step 6: 重建产物 + 提交**——`npm run build` ⇒ `git add src/tools.ts tests/contract/contract.test.ts dist && git commit -m "feat(scope): single source of truth for the 14 cherry_* tool names"`。**改了 `src/` 就必须把重建后的 `dist/` 放进同一个 commit**：`artifactFreshness.test.ts` 拿 `git show HEAD:dist/…` 与"当前源码的重建结果"逐字节比，源码提交而产物不提交 ⇒ 该测试红。

---

### Task 2: 作用域文档：解析、严格度序、原子写、`degraded` 集合、写侧护栏（§6.1 前半 + B9/B14/B16 的存储侧）

**Files:**
- Create: `src/atomicFile.ts`（**复刻** `deviceStore.ts:410-434` 的 `persistArchive` 原子写法：`.tmp` + `fsync` + `chmod 0600` + `rename`，rename 失败尽力 `unlinkSync(temp)` 再抛）
- **不改** `src/deviceStore.ts`（§3「永不」非目标：不改设备档案等既有子系统——既不从它抽出 helper，也不让它 import 新模块）
- Create: `src/toolScope.ts`
- Test: `tests/unit/toolScopeDoc.test.ts`（新）、`tests/unit/deviceStore.test.ts`（保持全绿，不新增断言）

**Interfaces:**
- Produces（后续 task 全部消费这些名字，不得改名）：
  - `export function writeFileAtomicSync(file: string, text: string, mode = 0o600): void`
  - `export const SCOPE_DOC_VERSION = 1`
  - `export type ScopeMode = 'global' | 'selected'`
  - `export interface ScopeDoc { version: number; revision: number; updatedAt?: string; mode: ScopeMode; workspaceIds: string[] }`（`updatedAt` **可选**；`workspaceIds` 是**去重 + 按字符串序升序排序**后的那一份，见 `normalizeScope`）
  - `export const DEFAULT_SCOPE: ScopeDoc`（`{version:1, revision:0, mode:'selected', workspaceIds:[]}`，**不含** `updatedAt` 键）
  - `export type DegradedSource = 'install' | 'workspace-list' | 'visibility-only' | 'scope-version' | 'path-normalization'`（**五值固定**；"解析失败 / 字段非法"**没有**专属成员，见下）
  - `export interface DegradedNote { source: DegradedSource; reason: string }`
  - `export interface ScopeWorkspace { id: string; title: string; path: string; sessionIds: readonly string[] }`
  - `export function toScopeWorkspace(raw: unknown): ScopeWorkspace | undefined`（边界归一：`id` 一律 `String(...).trim()`，无可用 id 或 path 则 `undefined`；`sessionIds` 非数组即 `[]`）
  - `export function normalizeWorkspaceId(value: unknown): string`（`String(value).trim()`）
  - `export function isVisible(doc: Pick<ScopeDoc,'mode'|'workspaceIds'>, workspaceId: string | undefined): boolean`
  - `export function normalizeScope(input: unknown): { doc: ScopeDoc; problem?: 'parse' | 'version-unsupported' }`（**spec §6.1 的名字**；`input` 是盘上读到的文本或已解析值，解析失败 ⇒ `problem:'parse'`。归一化除字段校验外**必须**做 `workspaceIds` 的**去重 + 按字符串序升序稳定排序**。若实现上仍想保留 `parseScopeDoc` 这个名字，它只能是本函数的**内部实现**：不导出、也不得被本模块之外的任何代码消费）
  - `export type SaveResult = { ok: true; doc: ScopeDoc; pruned: string[] } | { ok: false; status: 400 | 409 | 503; error: string; message: string }`
  - `export class ToolScopeState`，构造 `new ToolScopeState({ file, log? })`，本 task 实现的方法：`load()`、`doc()`、`degraded()`、`noteDegraded(note)`、`host()`、`setHost(next)`、`setWorkspaces(list: readonly unknown[] | undefined)`、`workspaces()`、`staleWorkspaceIds()`、`save(body: unknown, expectedRevision: unknown): SaveResult`、`layer(agentId)`、`setLayer(agentId, layer)`、`clearLayer(agentId)`、`invalidateDerived()`
  - `export interface ScopeHostState { state: 'pending' | 'unsupported' | 'ready'; capable: boolean; reason: string }`
  - `export interface MountedLayer { deny: readonly string[]; reason: string }`
- Consumes：Task 1 的 `CHERRY_TOOL_NAMES`——**它的消费点是 Task 5 的 `deny` 交集**（本 task 只定义作用域文档相关的常量与状态，**这里不消费它**；条目如实标注来源，不写成"列在 Consumes 下却说不引入"的自相矛盾形状）。

**列表三态与唯一写入者（§6.1 的消歧；Task 3 消费同一口径，B16）**：

- 工作区列表在本模块里只有三态——**未读**（初始态：注入回调尚未到达，从未读过）/ **读成功**（`list()` 返回**非空**列表）/ **读失败**（`list()` 抛错**或返回空数组**）。**`[]`（读成功但空表）等同读失败**（B16）：否则空注册表会被读成"全部 id 已失效"，把用户的勾选**静默修剪光**——这正是 B16 禁止的静默损坏。
- **`rebuild()`（Task 3）是 `setWorkspaces` 的唯一生产写入者**：读成功 ⇒ 写列表；读失败或返回空数组 ⇒ 写"不可用"；**"未读"是初始态、不由任何代码写入**（判据 = 从未调用过 `setWorkspaces`）。`setWorkspaces` 的入参语义据此固定：**非空数组 = 读成功**、**`undefined` 或空数组 = 读失败**。
- 对外表现：**未读** ⇒ `workspaces()` 与 `staleWorkspaceIds()` 都是**空数组**、**不**产生 `degraded` 标注（"还没读过"不是"读不出来"）、`PUT` **允许**写入但**不修剪**（`pruned` 为空）；**读成功** ⇒ 正常对账与修剪；**读失败** ⇒ **仅 `selected`** fail-closed（不可见；**`global` 下判定不受列表影响、仍为可见**）+ `degraded`（`source:'workspace-list'`）+ `PUT` 被拒绝（503）。
- **`workspace-list` 降级标注只允许一处写入**——本模块里 `setWorkspaces` 写入"不可用"的那一处；HTTP / 宿主 / UI 层**不得**再补一条同源标注（同源去重、异源并存的口径见 `degraded()`）。

- [ ] **Step 1: 写失败测试**——`tests/unit/toolScopeDoc.test.ts`：
  ① 文件不存在 ⇒ `doc()` **与 `DEFAULT_SCOPE` 整体相等**（`expect(doc()).toEqual(DEFAULT_SCOPE)`——不是逐字段列出后再比，也正因如此 `DEFAULT_SCOPE` **不含** `updatedAt` 键，D3 默认都不给）；`load()` 不抛。
  ② `normalizeScope`：合法 JSON ⇒ 无 `problem`；缺字段 / 类型错 / `mode:'nope'` ⇒ `problem:'parse'` 且 `doc` 落到**严格侧**（`selected` + 空列表，B9）；**解析失败 / 字段非法只走既有承载**——既有 `console.warn`（`log?` 注入）+ 严格度序落到更严一侧，**不得**为它新增 `DegradedSource` 成员（该枚举五值固定；`scope-version` 是"文档版本高于本插件支持"专用的那一个，解析失败**没有**专属成员）；**且"记录 warn"必须有可观测承载**——夹具注入 `log` 桩（`new ToolScopeState({ file, log })`）⇒ 一次解析失败 / 字段非法**恰好调用该桩一次**（未注入 `log` 时退回既有 `console.warn`，同一断言改用 `console.warn` 桩），而合法文档与"文件不存在"⇒ **零次**（这条断言是显式的，不得只写在实现里）；B9 的"并在设置页提示"由**既有** UI 文案位承载（Task 8 ⑫ 的空态 / 告警行，其断言在 Task 8 落），本 task 只需保证 `problem:'parse'` 在状态层可区分；`{"version":2,...}` ⇒ `problem:'version-unsupported'` 且**不得**被当成"用户空选"（判定口径同严格侧，但 `load()` 必须追加 degraded 标注 `scope-version`，reason 含"文档版本高于本插件支持"）。**版本分支覆盖两类输入，二者分开断言、不得混测**：（一）**类型合法但非支持版本**（`version: 0` / `version: 99`——本插件只支持 `1`）⇒ 走 **`version-unsupported` 路径**，与 `version: 2` **同侧**：`save()` 返回 `{ok:false,status:503,error:'scope-version-unsupported'}` + 只读降级（`load()` 追加 `scope-version` 标注）+ 不落盘、已存内容一位不动（**可覆写即红**），**不得**走 parse；（二）**类型非法**（`version` 缺失 / 非数字 / 字符串）⇒ 走 **`parse` 路径**（严格度序落到更严一侧 + 既有 `log`/`console.warn` 承载，即前段的"恰好一次"断言）。spec 把"更高 / 未知"同归（一）类，并明文与 B9 的 parse 路径**不同**。
  ③ `isVisible`：`global` ⇒ 任意 id（含 `undefined`）可见（B2）；`selected` + 非空 ⇒ 命中可见、未命中/`undefined` 不可见（D7/B5）；`selected` + 空 ⇒ 全员不可见（B1）。
  ④ id 归一（§6.1 输入契约）：`normalizeWorkspaceId(123) === '123'`、`normalizeWorkspaceId('  W ') === 'W'`；文档里 `'123'` 与注册表的 `123` **判定为同一工作区**；归一后仍不同 ⇒ 不匹配。
  ⑤ 严格度序方向（B9 判据）：同一组工作区下，可见集合满足 `selected+[]` ⊆ `selected+[W]` ⊆ `global`。
  ⑥ `degraded` 集合语义：同源两次 `noteDegraded` ⇒ 仍**一条**且 reason 为**最新**；异源（`install` / `workspace-list` / `visibility-only` / `scope-version` / `path-normalization`）⇒ **五条并存**；空集合 = 无降级（`degraded()` 返回 `[]`）。
  ⑦ 写侧（§6.3 语义，状态层负责）：`save({mode:'selected',workspaceIds:['W','GONE']}, 0)` 在 `setWorkspaces([W])` 后 ⇒ `{ok:true, pruned:['GONE']}`、`doc().revision === 1`、文档里没有 `GONE`、`mode` 未变；再存一次 ⇒ revision 2（单调 +1）；`expectedRevision` 不匹配 ⇒ `{ok:false,status:409,error:'scope-revision-conflict'}` 且 `doc()` **一位不动**；`expectedRevision === undefined` ⇒ 400 `missing-expected-revision`；`{mode:'nope'}` / `{workspaceIds:'x'}` ⇒ 400 `invalid-scope`；`version:2` 文档在盘上 ⇒ 503 `scope-version-unsupported`、不落盘；写盘后 0600 且无 `.tmp` 残留，`staleWorkspaceIds()` 返回注册表外的 id 并随修剪变空（B14）。**先决状态优先的并存用例（使五级优先级可观测）**：盘上 `version:2` 文档 + 非法 body（如 `{mode:'nope'}`）**同时**成立 ⇒ `save(...)` 必须落 `{ok:false,status:503,error:'scope-version-unsupported'}`，**不是** `invalid-scope`（400）——先决状态优先于请求体校验，故"更严的字段校验赢过先决状态"是**错**的。
  ⑧ **读失败 ⇒ 503 且一位不动**（与 ⑨ 的"未读"**分开断言，不得混测**）：`setWorkspaces(undefined)` **与** `setWorkspaces([])` 都算读失败（**`[]` 等同读失败**，B16）⇒ `save(...)` 返回 `{ok:false,status:503,error:'workspace-list-unavailable'}`、**不修剪**（已存 `workspaceIds`/`mode` 一位不动、`doc()` 未变）、`staleWorkspaceIds()` 为 `[]`、`degraded()` 含 `workspace-list`。
  ⑨ **未读 ⇒ 允许写入但不修剪**（初始态，从未调用 `setWorkspaces`）⇒ `save({mode:'selected',workspaceIds:['W','GONE']}, 0)` 仍 `{ok:true, pruned:[]}`、文档**原样写入**（`GONE` 保留在 `workspaceIds` 里）、`workspaces()` 与 `staleWorkspaceIds()` 都是 `[]`、`degraded()` **不含** `workspace-list`（"还没读过"不是"读不出来"）。
  ⑩ 规范化 + 去重排序（同时是 Task 7 的"规范化文档"的判据）：`normalizeScope` 收到 `{mode:'selected', workspaceIds:['B','A','B']}` ⇒ `doc.workspaceIds` **逐字**为 `['A','B']`（**去重** + **按字符串序升序稳定排序**；id 的比较归一仍由 `isVisible` 两侧 `normalizeWorkspaceId` 负责，不在存储侧改写字面量）；同一组乱序输入跑两次结果逐字相同；`save()` 成功后返回的 `doc` 与随后 `doc()` 读到的**就是这一份**（同一次规范化的结果，不是另建一份数组、也不再排序）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/unit/toolScopeDoc.test.ts`，预期 FAIL（模块不存在）。
- [ ] **Step 3: 实现**——**新建** `src/atomicFile.ts`：**复刻**（照抄写法，不从 `deviceStore.ts` 抽取、也不让它反向 import）`persistArchive` 的原子写法（`mkdirSync(dirname)` → `openSync(temp,'w',mode)` → `writeSync` → `fsyncSync` → `closeSync` → `chmodSync(temp,mode)` → `renameSync`，rename 失败时尽力 `unlinkSync(temp)` 再抛）；**`src/deviceStore.ts` 一行不改**（§3「永不」非目标）。`src/toolScope.ts` 按上面的签名实现：内存态为唯一权威（`load()` 只在 `apply()` 时读一次盘）、`save()` **同步**完成"校验 → 修剪 → revision+1 → 落盘 → 更新内存"，全程无 `await`（§6.3 临界区前提）。`save()` 的拒绝优先级固定：`version-unsupported`（503）> 列表降级（503）> 字段非法（400）> revision 缺失（400）> revision 冲突（409）——**先决状态**优先于请求体校验，测试按此顺序断言。**版本分支的两侧**（与 ② 的两类断言一一对应）：`version` **类型合法且 ≠ `SCOPE_DOC_VERSION`（1）**——含更低（`0`）与更高 / 未知（`2` / `99`）——一律判 `version-unsupported`（只读降级、不可覆写）；`version` **类型非法**（缺失 / 非数字 / 字符串）才落 `parse`——⑦ 的并存用例（盘上 `version:2` + 非法 body ⇒ 503 而非 400）由此在实现里有唯一归属。解析失败 / 字段非法一律走**既有**承载（`console.warn` + 严格度序落到更严一侧），**不新增** `DegradedSource` 成员。`normalizeScope` 是唯一的"输入 → 规范化文档"入口（去重 + 字符串序稳定排序），`save()` 与 `load()` 都经它；`setWorkspaces` 是列表的唯一写入口（非空 = 读成功；`undefined` 或空 = 读失败），`rebuild()`（Task 3）是它唯一的生产调用者，`workspace-list` 标注只在这一个写入口里写。
- [ ] **Step 4: 运行确认通过**——`npx vitest run tests/unit/toolScopeDoc.test.ts tests/unit/deviceStore.test.ts`，预期全 PASS。
- [ ] **Step 5: 门禁**——`npm run typecheck`（`src/atomicFile.ts`、`src/toolScope.ts` 与 `tests/unit/toolScopeDoc.test.ts` 都落在 server 项目：`src` 与 `tests` 已在 `tsconfig.json` 的 `include` 里，**无需登记**；登记规则只对 UI 环境测试适用，见 Global Constraints）。
- [ ] **Step 6: 重建产物 + 提交**——`npm run build` ⇒ `git add src/atomicFile.ts src/toolScope.ts tests/unit/toolScopeDoc.test.ts dist && git commit -m "feat(scope): the scope document — strictness order, atomic write, degraded set"`（产物与源码同 commit，理由同 Task 1 Step 6）。

---

### Task 3: 会话 → 工作区判定：规范化路径映射、解析状态四值、判定缓存、路径不匹配诊断（§6.1 后半 + D14 + B3/B5/B13）

**Files:**
- Modify: `src/toolScope.ts`（同一个文件，**必须在 Task 2 之后单独执行**）
- Test: `tests/unit/toolScopeJudge.test.ts`（新）

**Interfaces:**
- Produces：
  - `export type ResolutionStatus = 'resolved' | 'unresolved' | 'no-cwd' | 'no-match'`
  - `export interface AgentJudgement { agentId: string; status: ResolutionStatus; workspaceId?: string; visible: boolean; reason: string; cwd?: string }`
  - `export interface ScopeAgentLike { id: string; cwd?: string }`
  - `export interface WorkspaceRegistryLike { list(): unknown; resolveByPath?(path: string): Promise<unknown | undefined> }`（**真实契约**：`resolveByPath(path): Promise<Workspace | undefined>`——解析成功返回**注册表实体**（含 `id` / `path` 的对象）、**未拥有的目录返回 `undefined`**、**路径缺失则 reject**。实现与夹具都按此建模，**不得**把它当成"返回路径字符串"的转换器）
  - `export interface RebuildSummary { listAvailable: boolean; agents: number; resolved: number; unresolved: number; pathUnmatched: number }`
  - `ToolScopeState` 增量：`async rebuild(registry: WorkspaceRegistryLike, agents: readonly ScopeAgentLike[]): Promise<RebuildSummary>`、`judgement(agentId: string): AgentJudgement | undefined`、`pathUnmatched(): ReadonlyArray<{ agentId: string; cwd: string }>`。**`rebuild()` 是 `setWorkspaces` 的唯一生产写入者**（三态与"`[]` 等同读失败"的口径见 Task 2 的「列表三态与唯一写入者」，`workspace-list` 标注仍只写一处）
- 判定规则（spec §4 的两条，**唯一契约**）：
  - **规则一**：`sessionIds.includes(agent.id)` 命中优先。
  - **规则二（重算期，允许 async）**：对 agent 的 `cwd` 调 `resolveByPath` ⇒ **返回实体**——在映射上查表命中 ⇒ `resolved`（`workspaceId` = 该实体路径对应的值）；返回实体但**不在映射里**（解析成功、不属任何已注册工作区）⇒ `no-match`；**返回 `undefined`**（宿主明确"未拥有该目录"）⇒ `no-match`；**抛错**（目录暂不可达 / 注册表未就绪 / realpath 失败）⇒ `unresolved`；**无 `cwd`** ⇒ `no-cwd`。四值口径与 spec §6.1 的解析状态一致。
  - **映射的构建（键的真相）**：键 = 注册表**每一项的路径**经 `resolveByPath` 得到的**实体路径**（realpath 语义 ⇒ 符号链接两侧收敛到同一个键），值 = 该实体的 **workspaceId**；**不是**"`resolveByPath` 的返回值再过 `normalizeWorkspaceId`"那种自相矛盾的写法。老宿主无 `resolveByPath` ⇒ 退化为**大小写敏感的字符串等价**（不做 realpath），并追加 `path-normalization` 标注（见 ③）。**单项解析失败的口径**：构建映射时 `resolveByPath(item.path)` **reject**（宿主对缺失路径 reject，见上面的真实契约）⇒ **跳过该项**（该项不进映射）、**本轮 `rebuild()` 不因此失败**、经 `log` 记一条；它**不计入 `degraded`**（它不是"读不出列表"——`DegradedSource` 五值里没有它的成员位，见 ⑪）。
  - 两者都不中 ⇒ 无工作区（D7）。**`visible` 的唯一判据是 `isVisible(doc, workspaceId)`**：`global` 模式下**恒为 `true`**（与列表可用性、与 `cwd` 都无关，B2）；fail-closed 只适用于 `selected`（`selected` 下无工作区 ⇒ 不可见）。**装层动作的目标集合由 `judgement.visible` 派生**，**不是**由 `status === 'resolved'` 派生——`global` 下 `status` 可以是 `no-cwd` / `no-match` / `unresolved`，而 `visible` 仍为 `true`，此时目标集合为空 ⇒ 宿主侧只释放、不安装（Task 5 的装层判据消费 `visible`）。
  - `reason` 必须含工作区**标题或 id**（由安装动作写进**已装层记录**，供 guard 回显——guard 只读该记录，Task 5 ⑦ / §6.1「guard 的读源」）。

- [ ] **Step 1: 写失败测试**——`tests/unit/toolScopeJudge.test.ts`：
  ① `sessionIds` 命中优先：agent 的 `cwd` 对不上任何项，但其 id 在某项的 `sessionIds` 里 ⇒ `status:'resolved'` + 该 `workspaceId`（§4 规则一）。
  ② 规则二（规范化后相等，D14 单一契约）：夹具 `resolveByPath` **按真实契约**建模——`/w/link` ⇒ 返回**实体** `{id:'W', path:'/w/real'}`，**未拥有的目录 ⇒ `undefined`**，**路径缺失 ⇒ reject**（**不得**返回路径字符串）；注册表项 `path:'/w/real'`、agent `cwd:'/w/link'` ⇒ `resolved` 命中同一 `workspaceId`（B13"第一轮就有工具"的前提）；裸字符串不同、规范化后相同的两侧断言**同一结果**。
  ③ 老宿主（无 `resolveByPath`）⇒ 退化为**大小写敏感的字符串等价**（不做 realpath）：同义路径**不**命中，此时只剩 `sessionIds`；且必须向 `degraded` 追加 `source:'path-normalization'`（D14 明文要求"该降级在诊断标注"——这是它的承载枚举值，reason 写明"宿主无 resolveByPath，路径匹配退化为大小写敏感字符串等价"），**不得**声称与规范化等价；**并且**该 agent 产生一条 `pathUnmatched` 记录（同义路径 ⇒ `no-match`），且该记录**不**计入 `degraded`（只多出上面那条 `path-normalization` 标注）。
  ④ 四值齐备：无 `cwd` ⇒ `no-cwd`；`resolveByPath` 抛错 ⇒ `unresolved`；解析成功（返回实体或 `undefined`）但不属任何注册表项 ⇒ `no-match`；命中 ⇒ `resolved`。**`visible` 一律只按 `isVisible(doc, workspaceId)` 判**：`selected` 下只有命中且 `isVisible` 为真才 `true`，其余（含无工作区）不可见；**`global` 下四种 `status` 的 `visible` 全为 `true`**。**`no-match` 另产生一条 `pathUnmatched()`**（含 `agentId` 与 `cwd` 样本）且**不出现在 `degraded()`** 里（§6.1：诊断而非降级）。
  ⑤ 同步可读 + fail-closed（**仅 `selected` 夹具**）：`rebuild()` 未完成时 `judgement(id)` 为 `undefined`；夹具是 `selected` 文档 ⇒ `selected` 下判定一律不可见（fail-closed，即回退式 `isVisible(doc, undefined)` 为假）；**`global` 夹具下同一时刻按回退式仍为 `true`**（B2——不得把"`rebuild()` 未完成 ⇒ 一律不可见"写成跨模式的结论）；`rebuild()` 完成后立即可读（**同步查表**，不再 await）。
  ⑥ 原子替换：`rebuild()` 进行中（`resolveByPath` 挂起）读到的仍是**上一代**（不会看到半建映射）；完成后整代切换。
  ⑦ `invalidateDerived()` ⇒ `judgement()` 与 `pathUnmatched()` 清空（teardown 的载体，Task 4 ④ 会用）。
  ⑧ 列表读不到（`list()` 抛错**或返回空数组**）⇒ `listAvailable:false`、degraded 追加 `workspace-list`；判定侧：**有 `cwd` 的 agent 一律 `unresolved`**（列表不可用 / 注册表未就绪都算"本次解析失败"——与 D14 的"有界复检只对 `unresolved` 启动"一致），**无 `cwd` 者仍为 `no-cwd`**；`selected` 下不可见（fail-closed），**`global` 下判定不受列表影响、`visible` 仍为 `true`**（B16：fail-closed 只适用于 `selected`）。
  ⑨ `global` + 无 `cwd` + 列表降级 ⇒ `visible:true`（判据只有 `isVisible`，不看 `cwd`、不看列表）；由此目标 deny 集合为空 ⇒ 宿主侧**不装层**（只释放既有层——本 task 断言 `visible` 一侧，装层动作的断言在 Task 5 ③）。
  ⑩ **三态与唯一写入者**（与 ⑧ 的"读失败"**分开断言，不得混测**）：**未读**（`rebuild()` 从未跑过）⇒ `workspaces()`/`staleWorkspaceIds()` 都是 `[]`、`degraded()` 不含 `workspace-list`、`save()` 允许且**不修剪**；此时判定整代为**空**（`judgement()` 全 `undefined` ⇒ 按 **D7** 处理——**仅 `selected`** 同步 fail-closed（不可见）；**`global` 下按回退式仍为可见（空集、只释放）**）——三态里的**"未读"只存在于 effect 挂载前**，**D14 的四值只在 `rebuild()` 跑过之后才存在**，二者不冲突；`rebuild()` 一旦运行，列表要么**读成功**（非空 ⇒ 写列表、正常对账、`staleWorkspaceIds()` 给出注册表外的 id），要么**读失败/返回空** ⇒ 按 ⑧（`rebuild()` 是 `setWorkspaces` 的唯一生产写入者）。
  ⑪ **一个坏项不连累其它项与全部 agent**：夹具令注册表里某一项的 `path` 触发 `resolveByPath` **reject**（缺失路径）⇒ 该项**不进映射**、`rebuild()` **不抛**、`degraded()` **不新增**任何条目（尤其**不含** `workspace-list`）、经 `log` 桩记**恰好一条**；其余项照常参与判定——把该坏项从夹具里拿掉再跑一次，**全部** agent 的 `judgement()`（`status` / `workspaceId` / `visible`）与本轮逐条相同（一个坏项不影响其它项与全部 agent 的判定）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/unit/toolScopeJudge.test.ts`，预期 FAIL（导出/方法不存在）。
- [ ] **Step 3: 实现**——在 `ToolScopeState` 内按"构建新一代（映射 + 判定 + 解析状态 + `pathUnmatched`）→ 一次赋值原子替换"实现；`rebuild()` 是**唯一**允许 async 的地方；`judgement` 只读当代缓存。**构建次序固定**：先 `list()`（拿到结果就交给 `setWorkspaces`——**非空 ⇒ 写列表**；**抛错或返回空数组 ⇒ 写"不可用" + `workspace-list` 标注**）⇒ 再逐项 `resolveByPath(item.path)` 拿**实体路径**作键、实体 `workspaceId` 作值（**该项 reject ⇒ 跳过该项**：不中断本轮构建、经 `log` 记一条、**不计入 `degraded`**）⇒ 再逐 agent 调 `resolveByPath(agent.cwd)` 定四值（有 `cwd` 但列表不可用/注册表未就绪 ⇒ 一律 `unresolved`）。**去尾斜杠 / 统一大小写都不做**（realpath 语义已足够；退化路径保持大小写敏感，见 ③）。`resolveByPath` 的返回值按真实契约消费（**实体或 `undefined`**，路径缺失时它 **reject**），**不得**把它当"返回路径字符串"用。三态口径与 Task 2 一致：**`rebuild()` 是 `setWorkspaces` 的唯一生产写入者**、`workspace-list` 标注只写一处、**`[]` 等同读失败**（B16）。
- [ ] **Step 4: 运行确认通过**——同命令 PASS；并跑 `npx vitest run tests/unit/toolScopeDoc.test.ts` 确认未回归。
- [ ] **Step 5: 门禁**——`npm run typecheck`（`src/toolScope.ts` 与 `tests/unit/toolScopeJudge.test.ts` 都在 server 项目的覆盖面上，**无需登记**）。
- [ ] **Step 6: 重建产物 + 提交**——`npm run build` ⇒ `git add src/toolScope.ts tests/unit/toolScopeJudge.test.ts dist && git commit -m "feat(scope): canonical-path session-to-workspace judgement with four resolution states"`。

---

### Task 4: 宿主集成与唯一装配点：能力三态、注入门控、注册与隐藏同生共死、teardown 次序（§6.2 + B7/B10/B17）

**Files:**
- Create: `tests/helpers/fakeToolHost.ts`（**复刻 7 条宿主语义的假宿主**，Task 5/6/7 复用；它是**宿主语义**假宿主，**不是**装配夹具——两者别混，见下面的「既有装配夹具的迁移」）
- Create: `src/toolScopeHost.ts`
- Modify: `src/index.ts`（`apply()` 里创建 `ToolScopeState` + **实例化并挂载** `createToolScopeHost`；**deps 接线也归本 task**：`assemblyDeps()` 增加 `scope` 与 `refreshScope: () => host.refresh()`，随既有的 `registerHttpApi(ctx, deps)` 一起交给传输层（Task 7 只加 `/scope` 路由、只消费这两个字段，不再改本文件）——这两个字段**怎么被 `assemblyDeps()` 取到**钉死在 Step 3（**经装配状态** `state.scope` / `state.refreshScope`，不改 `assemblyDeps()` 的签名、不改成显式传参）；**移除** `apply()` 里对 `registerCherryTools` 的直接调用，改由本子系统在注入回调内调用）
- Modify: `src/httpApi.ts`（`CherryHttpDeps` 定义在 `src/httpApi.ts:148`；本 task 必须给它加 `scope` 与 `refreshScope` 两个字段——**即便字段写成可选也仍要改这个文件**，故它必然归本 task：写者顺序固定 **Task 4 → Task 7 → Task 9**）
- Modify: `tests/integration/toolsManage.test.ts`、`tests/contract/contract.test.ts`、`tests/integration/httpApi.test.ts`（**既有装配夹具的就地迁移（三处）+ 三处既有 deps 字面量补字段（`contract.test.ts` 1 处 + `httpApi.test.ts` 2 处——与"三处装配夹具"不是同一组，见下面的专节）**：`CherryHttpDeps` 的两个新字段由本 task 加，也由本 task 就地补齐全部调用点——见下面的专节）
- Test: `tests/integration/toolScopeHost.test.ts`（新）

**Interfaces:**
- Produces：
  - `export interface ScopeHostContext`（**完整字段，不得 `{…}` 略写**；以结构化类型对接 `@deepseek-ai/dsh-tools`，不新增运行时依赖）：
    - `tools?: { register(definition: { readonly name: string; readonly description: string; readonly parameters?: unknown; execute(args: unknown, exec: unknown): Promise<unknown> }): () => void; restrict?(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): () => void; guard?(guard: (execution: { readonly name: string; readonly agent?: { readonly id: string } }) => string | undefined): () => void; schemas?(scope?: unknown): ReadonlyArray<{ readonly name: string; readonly description: string; readonly parameters?: unknown }> }`——**整体可选**，因为 `apply()` 收到的是 `CherryBridgeContext`，其 `tools?` 本就可选、且真实形态只有 `register`（`src/tools.ts:74-76`）；**四个方法全列**（`register` / `restrict` / `guard` / `schemas`），其中 **缺 `register` / `restrict` / `schemas` 任一 ⇒ 能力落 `unsupported`**（与 Step 1 ② 一致）、`guard` **不在**能力门槛内（缺它只降 `visibility-only`，见 Step 1 ②⑥）；**`ctx.tools` 整体缺失 ⇒ 既有 `console.warn` + 零注册**（与 Step 1 ⑪ 的既有 headless 语义同一条）。**同步写法**：`mount(ctx)` 只要求传进来的对象是 `CherryBridgeContext` 的**结构超集**——`tools` 可选、方法也可选，调用方**不需要**做转换或 cast
    - `inject?<T>(keys: readonly string[], cb: (ctx: T) => void | (() => void)): unknown`——**返回值忽略**：它是宿主的 fiber 句柄（依赖卸载/重挂即以它为单位），本插件不持有、也不释放它（释放路径只有 `mount()` 返回的 disposer）；既有接缝 `src/httpApi.ts:85` 同样声明为 `unknown`
    - `on?<T>(event: string, cb: (payload: T) => void): () => void`——事件订阅面（宿主先例：`ctx.on('agent/created', ({ agent }) => …)`）
    - `effect?(cb: () => () => void, label?: string): unknown`——label 的**决定只在写这一处**：`'cherry-remote.tool-scope()'`（§6.2 明文）；Step 3 的装配点按这个名字使用，不再重写字符串字面量
  - `export interface ScopeHostDeps { scope: ToolScopeState; names: readonly string[]; registerTools: () => () => void; recheckDelaysMs?: readonly number[]; log?: (message: string, error?: unknown) => void }`——`registerTools` **保持单一聚合 disposer 形状**（与 `src/tools.ts:655` / `:657` 一致），不得改写成"返回多个 disposer"；**`log` 缺省 ⇒ 走既有 `console.warn`**（与 Task 2 的 `ToolScopeState({ file, log? })` 同一口径，宿主层在此补齐——Step 1 ② / ⑪ 的"仍 `console.warn` 一条"要靠它才可观测）
  - `export interface ToolScopeHost { mount(ctx: ScopeHostContext): () => void; refresh(): RefreshSummary | undefined; state(): ScopeHostState }`——**释放路径只留一条**：`mount()` 返回的 disposer；**不提供** `dispose()`，装配侧**不得**新增第二个 `ctx.effect`（`tests/integration/httpApi.test.ts:1460/1479` 断言 `effects` 长度为 1）
  - `export function createToolScopeHost(deps: ScopeHostDeps): ToolScopeHost`
  - `export interface RefreshSummary { agents: number; installed: number; released: number; skipped: number }`
- 假宿主（`tests/helpers/fakeToolHost.ts`）**必须复刻** spec §7 的七条，否则相关断言恒真而空过：
  ① `restrict({})`（两键全缺）**抛**；② `restrict({deny: []})` **不抛**，装入"对任何名字都放行的 no-op 层"，并**记录每次入参**；③ 未知名字 / 作用域局部名 / 保留 `run_code` ⇒ 抛；④ 跨层取交集（`layers.every(admits)`）；⑤ `schemas()` 无参 = 全局视图、`schemas(agent)` = 已按该 agent 的 restriction 过滤后的视图；⑥ 在**插件根 ctx** 或**注入回调 ctx**（两者都不是 `agent.ctx`）上调 `restrict()` **抛** `tools.restrict() requires a scoped context (agent.ctx)`；⑦ `guard()` 的安装与释放在**两侧都不发** `tools/change`，`register()` 与 `restrict()` 在**安装与释放两侧都发**。
- 假宿主的**事件面**（订阅经注入回调 ctx 的 `on(event, cb)`）——事件名与载荷形状逐字复刻，缺一个相关断言就恒真而空过：
  - `agent/created` ⇒ `{ agent, source, signal? }`（宿主按 `@mode serial` 派发：**监听器抛错会让建会话失败** ⇒ 本插件的监听器必须同步返回、不抛、不 await）；
  - `agent/disposed` ⇒ `{ agent }`（该事件的监听器抛错只被宿主 warn，不阻塞处置）；
  - `tools/change` ⇒ **无载荷**（宿主是 `ctx.emit('tools/change')`）。
- `ScopeAgentLike` 由**宿主集成层**从 `agent.session.header.cwd` **投影**（`Agent` 本体只有 `id` / `session` / `ctx`，**没有** `cwd` 字段）；restriction 一律走 `agent.ctx.tools.restrict(...)`（在**插件根 ctx** / **注入回调 ctx** 上调用必抛，见假宿主第⑥条）；`agents.list()` 的元素与事件载荷里的 `agent` 走**同一个**投影函数。
- Consumes：Task 2/3 的 `ToolScopeState`。

**既有装配夹具的迁移（本 task 的就地改动；与上面的假宿主是两回事）**：`tests/helpers/fakeToolHost.ts` 复刻的是**宿主语义**（供 `tests/integration/toolScopeHost.test.ts` 驱动本子系统）；下面三处是**装配夹具**——驱动真 `apply()` 的假 `ctx`。它们现在只应答 `webServer`/`webRuntime`，本子系统新增的 `ctx.inject(['agents','workspaceRegistry'], …)` 到达时拿不到服务（注入回调 ctx 上也没有 `effect`/`on`）⇒ 本 task 落地后必红，故**按依赖键分流** `inject` 并补齐服务面：

- `tests/integration/toolsManage.test.ts`（`assemblyCtx`，`:604-647`）：`inject(deps, cb)` 分流——`deps` 含 `webServer`/`webRuntime` ⇒ 既有 web 面响应；含 `agents`/`workspaceRegistry` ⇒ 注入 `{ agents, workspaceRegistry }`，并在**注入回调 ctx** 上补 `effect`（承载本子系统的挂载生命周期）与 `on`（事件订阅）；`ctx.tools` 服务补齐 `restrict`/`guard`/`schemas`（`schemas()` 无参 = 全局视图、带 agent = 已过滤视图），否则能力恒为 `unsupported`、装配级断言恒真而空过。**既有语义保留**：`:1421-1431` 删掉 `ctx.tools` ⇒ `console.warn` 且**不抛**。
- `tests/integration/httpApi.test.ts`（`assemblyCtx`，`:1403-1432`）：同一分流 + 注入回调 ctx 的 `effect`/`on` 与 `restrict`/`schemas`。这是 **1 个夹具 × 6 个用例**（`:1451` / `:1468` / `:1495` / `:1540` / `:1599` / `:1652`），要逐点核对。**三条既有断言不得变**：`:1460` / `:1479` 的 `ctx.effects` 长度为 **1**（装配只允许一个 `ctx.effect`）；`:1436-1437` 的 `index.inject` **恰为 `['tools']`**（`agents` / `workspaceRegistry` 只进 `ctx.inject(...)` 这一次调用，**不得**加进静态 `export const inject`，见 Global Constraints）；`:1647-1655` headless（`inject` 抛错）⇒ `apply()` **不抛** + warn。
- `tests/contract/contract.test.ts`（`apply()` 夹具，`:1690-1800` 区间的四处）：同一分流 + 注入回调 ctx 的 `effect`/`on`；`makeRig()`（`:237-301`）**直接**调 `registerCherryTools`、不经 `apply()`，不受影响，契约断言照旧全绿。
- 这三处的 **deps 字面量**（`tests/contract/contract.test.ts:1120-1137`、`tests/integration/httpApi.test.ts:253-261`、`:1147-1154`）**同样归本 task**：`CherryHttpDeps` 新增的 `scope` / `refreshScope` 是**必填**字段（`src/httpApi.ts:148`），三处字面量必须**就地补齐**——`npm run typecheck` 覆盖 `tests/**`，只加接口不补调用点 ⇒ 本 task 的 Step 5 必红。**补进去的 `scope` 必须是真实的 `new ToolScopeState({ file: join(dataDir, 'scope.json') })` 实例**（与 `apply()` 里那个同一构造形态），**不得**用 `as never` / 占位对象糊过去——否则 Task 9 让 `src/httpApi.ts:920-933` 的 `diagnosticsReport` 逐字段解引用该对象时，既有 `/diagnostics` 用例会 500 变红，而那个修复点已不在任何 task 的 Files 里。**这三处字面量的取值是 Task 9 的前置条件**。这两个文件本来就是本 task 的 Files（上面的装配夹具迁移也在这两个文件里），故这是**同一次就地改动**，不存在"留到后面的 task 再补"的第二步。
- **别把两组混用**：上面三处是**装配夹具**（真 `apply()` 的假 `ctx`）；`tests/contract/contract.test.ts` 里的 **4 处 `apply()` 调用**（`:1697` / `:1750` / `:1765` / `:1795`）属于**这一组**（"三处装配夹具 / 4 处 `apply()` 调用"）。而**"三处 deps 字面量"是另一组**：`tests/contract/contract.test.ts` **1** 处（`:1120-1137`，该文件里 `registerHttpApi` 的字面量只有这一处）+ `tests/integration/httpApi.test.ts` **2** 处（`:253-261` / `:1147-1154`）——**不是**"contract 3 处"。

**两条硬约束（`tests/integration/toolsManage.test.ts:1343` 以 `const teardown = ctx.effects[0]!()` 按位置取"插件根 effect"，随后断言 peer 侧 `fake.closeCalls ≥ 1` 与 parked waiter 被拒）**：

- ① **注入回调 ctx 上的 `effect(...)` 不得被记录进根 `effects` 数组**：该夹具的 `effect(cb){ ctx.effects.push(cb()) }` 记录的是**根 ctx** 的 effect；注入回调 ctx 上的 effect（承载本子系统的挂载生命周期）必须**另置一个桶、或不记录**——与下面的 ② 合起来，才保证 `ctx.effects[0]` 仍是根 effect。
- ② `host.mount(ctx)` 的装配位置固定在既有根 `ctx.effect(...)`（`src/index.ts:704`）**之后**，且仍只经 `state.disposers` 释放（**不新增第二个根 `ctx.effect`**——与 Interfaces 的"释放路径只留一条"是同一条）。

- [ ] **Step 1: 写失败测试**——**假宿主在本 Step 创建**（`tests/helpers/fakeToolHost.ts`；Step 3 只补齐 `src/toolScopeHost.ts` 的实现，不再重复"写假宿主"这件事），再写 `tests/integration/toolScopeHost.test.ts`：
  ① `pending`：**`mount()` 已调用、但注入回调尚未到达**（夹具只登记回调、不调用它）⇒ 一个工具都没注册、`state().state === 'pending'`、`state().capable === false`、`reason` 是**中性等待**措辞（断言**不含**"不支持"/"unsupported"）。
  ② `unsupported`：夹具删掉 `ctx.tools.restrict`（或 `schemas`）——**三个门槛方法 `register` / `restrict` / `schemas` 缺任一都算**（Interfaces 的口径）⇒ 一个工具都没注册、`state().state === 'unsupported'`、`state().capable === false`、`reason` 含 `tools.restrict`（**按真实缺因**，不得硬编码"agents 服务不可用"）、`degraded()` 不含 `visibility-only`（B7①）；**且仍 `console.warn` 一条**（既有 headless 语义不变）。**夹具构造口径**：静态能力探测在 `mount()` 时读**插件根 ctx** 的 `tools` 面完成（Step 3），故本夹具只要在 `mount()` 之前删掉 `ctx.tools.restrict`、**不调用**注入回调，即可让"静态能力缺失 + 注入回调未到达"**同时成立**。**优先级**：令"静态能力缺失"与"注入回调未到达"**同时成立** ⇒ 三态只能是 `unsupported`（**静态能力缺失优先**）。
  ③ `ready`：静态能力齐备 + 注入到达 ⇒ 注册恰好 14 个、对全部 live agent 装了 restriction、`state().state === 'ready'`、`state().capable === true`、且 **`state().capable === (state().state === 'ready')`**（B7④）。
  ④ **依赖卸载**（调用 effect disposer）⇒ 注册、全部 restriction、guard、**两个订阅**（`agent/created` / `agent/disposed`）**同时消失**（夹具分别计数，四者都归零）；卸载后**任一时刻**不存在"已注册未隐藏"；`scope.judgement()` / `scope.layer()` 已作废——teardown **一并作废**判定缓存 / 规范化路径映射 / 解析状态 / 已装层记录；重算计数不发生。**"释放动作自身发出的 `tools/change` 不得把层装回来"是 Task 5 ⑭ 的正面断言**（该订阅属 Task 5，本 task 不订阅它）。
  ⑤ **依赖重挂** ⇒ 注册 / guard / restriction **同时恢复**、不抛 `already registered`、每个 agent 仍只有**一层**（夹具记录每 agent 层数恒 ≤ 1）（B10）。
  ⑥ `guard` 缺失（夹具不提供 `guard`）⇒ 照常注册 14 个 + 照常装层 + `degraded()` 追加 `visibility-only`，**且不拒绝注册**（B17）。
  ⑦ **单一聚合 disposer**：夹具令 `registerTools()` 返回**一个**聚合 disposer（内部释放 3 个假注册并自计调用次数）⇒ teardown 后该聚合 disposer 被调用**恰好一次**（3 个注册全部消失，但释放入口只有一个）——**不得**改写成"返回 3 个 disposer ⇒ 三个各调一次"。
  ⑧ **装配级**（经真 `apply()` 装配；按上面三处夹具的**同一分流形状**在本文件里搭一个最小装配夹具：`inject` 按依赖键分流，webServer 侧只需 `routes` 表）：ready 宿主（静态能力齐备 + 注入到达）⇒ 注册表里出现**恰好 14 个** `cherry_*`；`pending` 宿主（注入回调未到达）⇒ **一个都不出现**；两例都断言 `apply()` 不抛、`ctx.effects` 仍只有 **1** 个。
  ⑨ **`agent/disposed`** ⇒ 该 agent 的 restriction 层被释放（夹具释放计数 +1）、**已装层记录清除**（`scope.layer(agentId) === undefined`）、disposer `Map` 无残留（夹具可见层数 = 0），且该 agent 的视图里 `cherry_*` 回到工具表。
  ⑩ **回调在同一次运行内幂等**：同一 effect 生命周期内重复触发（重复投递 `agent/created`、重复的挂载请求）⇒ **不重复注册**（`register` 调用次数恒 = 14，不随 live agent 数或事件次数增长）、每个 agent 仍只有一层；只有 effect 重跑（重挂）才做全新注册（⑤ 已覆盖"不抛 `already registered`"）。
  ⑪ **既有两例语义 + 两条新行为**——**载体分两类（内嵌项用 `(a)(b)(c)(d)` 编号，避免与顶层的 `T4①`–`T4⑪` 混淆）**：`(a)(b)(c)` 走上面三处**装配夹具**（驱动真 `apply()`）；**`(d)` 走本文件的宿主级夹具**（`tests/integration/toolScopeHost.test.ts` 里的假宿主 + `mount()`），理由是 `(d)` 断言的 `mount()` 不抛与 `state().state === 'pending'` 都是**宿主级** API，经装配夹具不可达（`/scope` 路由在 Task 7、诊断段在 Task 9，都不在本 task）。
  (a) `tests/integration/toolsManage.test.ts:1421-1431` 缺 `ctx.tools` ⇒ `console.warn` 且**不抛**；
  (b) `tests/integration/httpApi.test.ts:1647-1655` headless（`inject` 抛错）⇒ `apply()` **不抛** + warn；
  (c) 新行为一：`unsupported` 时**仍** `console.warn`（既有 headless 语义不变）；
  (d) 新行为二（**宿主级夹具**）：`inject` 抛错 ⇒ `mount()` **不抛**、降级为 `pending` 并 warn（`state().state === 'pending'`、一个工具都不注册）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/integration/toolScopeHost.test.ts`，预期 FAIL（`src/toolScopeHost.ts` 不存在）。
- [ ] **Step 3: 实现**——`createToolScopeHost` **不作状态所有**（状态归 `ToolScopeState`）；`mount(ctx)` 内：`ctx.inject(['agents','workspaceRegistry'], (agentCtx) => agentCtx.effect(() => { … }, EFFECT_LABEL))`（`EFFECT_LABEL` = Interfaces 里**唯一一处**钉死的那个 label，此处只引用、**不重写字符串**；**这两个依赖键只进这一次 `ctx.inject(...)` 调用**——不得加进静态 `export const inject`，`tests/integration/httpApi.test.ts:1436-1437` 断言它恰为 `['tools']`，见 Global Constraints）。**静态能力探测在 `mount()` 时读插件根 ctx 的 `tools` 面完成**（`register` / `restrict` / `schemas` 三个方法的有无 ⇒ 缺任一即 `unsupported`；这次探测**与注入回调到没到达无关**，故"静态能力缺失 + 注入回调未到达"可以**同时成立**并按优先级落 `unsupported`——Step 1 ② 的夹具据此构造，若把探测挪进 effect 内则该断言恒假）；**effect 内只做 `ready` 判定与注册，次序固定**：注入到达 ⇒ 能力齐备即 `ready`（`pending` = `mount()` 已调用但注入回调尚未到达；`unsupported` 仍经 `log` 发一条 warn）⇒ `ready` 才 `registerTools()` 并把**那个单一的聚合** disposer 收进本 effect ⇒ 对全部 live agent 装 restriction + 在**插件根 ctx** 上装**一层** guard ⇒ 订阅 `agent/created` / `agent/disposed`（**本 task 不订阅 `tools/change`**，理由见下）⇒ **返回合并 disposer**（退订/置 `torn-down` ⇒ 释放注册 ⇒ 释放全部 restriction ⇒ 释放 guard ⇒ `scope.invalidateDerived()`，**一并作废**判定缓存 / 规范化路径映射 / 解析状态 / 已装层记录）。`pending`/`unsupported` 都要把三态写进 `scope.setHost(...)` 且**什么都不注册**；`ctx.inject` 抛错（宿主服务未就绪）⇒ `mount()` **不抛**、降级 `pending` 并 warn。`src/index.ts` 的 `apply()`（既有写法见 `:675` / `:697-698` / `:704-715`）：`const scope = new ToolScopeState({ file: join(dataDir,'scope.json') }); scope.load()`；**实例化并挂载**（生产装配点，不得只声明不挂）`const host = createToolScopeHost({ scope, names: CHERRY_TOOL_NAMES, registerTools: () => registerCherryTools(ctx, deps) })` ⇒ `state.disposers.push(host.mount(ctx))`（**装配位置固定在既有根 `ctx.effect(...)`（`src/index.ts:704`）之后**——迁移节两条硬约束的第 ② 条）——`names` 的单一来源是 Task 1 的 `CHERRY_TOOL_NAMES`（B11），`registerTools` 用闭包**延后到注入到达时**才调 `registerCherryTools`，因此**移除** `apply()` 里既有的直接调用；HTTP 注册**照旧无条件**（含 pending/unsupported，D9），`assemblyDeps()` 增加 `scope` 与 `refreshScope: () => host.refresh()`，随 `registerHttpApi(ctx, deps)` 一起交给传输层（**接线在本 task**，Task 7 只加 `/scope` 路由、只消费这两个字段）；**`assemblyDeps()` 的取值方式（本计划选定，不留第二种）**：**经装配状态**——`apply()` 把 `scope` 与 `refreshScope` 写进装配状态（`state.scope` / `state.refreshScope = () => host.refresh()`），`assemblyDeps()`（`src/index.ts:539`，模块级无参）按既有 `state.store` / `state.identity` 的同一模式读这两个字段；**不改 `assemblyDeps()` 的签名**、也不改成从 `apply()` 显式传参。两处写入排在 `const deps = assemblyDeps()`（`src/index.ts:694`）**之前**（`refreshScope` 是惰性闭包，`host` 到 `createToolScopeHost(...)` 之后才被真正调用），故读到的必是本次装配的实例；**不得新增第二个 `ctx.effect`**——释放路径只有 `mount()` 返回的 disposer 这一条（`tests/integration/httpApi.test.ts:1460/1479` 断言 `effects` 长度为 1；插件根 ctx 上既有的那一个 `ctx.effect(...)` 负责 release 时遍历 `state.disposers`）。
  **为什么 `tools/change` 的订阅不在本 task**：理由见 Task 5 Step 3 末（订阅必须与安装/释放判据、合并闸**同轮**落地）。
- [ ] **Step 4: 运行确认通过 + 装配夹具回归清单**——`npx vitest run tests/integration/toolScopeHost.test.ts tests/integration/toolsRead.test.ts tests/integration/toolsManage.test.ts tests/integration/httpApi.test.ts tests/contract/contract.test.ts`，预期全 PASS（后四个证明既有装配没被改坏）：① `toolsManage.test.ts` 的 `assemblyCtx` 按依赖键分流后既有用例全绿（含 `:1421-1431` 缺 `ctx.tools` ⇒ warn 不抛），且 `:1343` 的 `const teardown = ctx.effects[0]!()` **仍按位置取到插件根 effect** ⇒ 既有两断言保持绿（peer 侧 `fake.closeCalls ≥ 1` + parked waiter 被拒 `settled === 'rejected'`）——位序成立的前提是迁移节那两条硬约束；② `httpApi.test.ts` 的 **6 个装配用例**（`:1451` / `:1468` / `:1495` / `:1540` / `:1599` / `:1652`）逐点绿，`:1460` / `:1479` 的 `effects` 长度 = 1 **与** `ctx.effects[0]` 仍是**根 effect**（**长度**与**位序**是两件事，两条都要核；本文件的 6 个用例保护长度、`toolsManage` 的 teardown 用例保护位序）、`:1436-1437` 的 `index.inject` **恰为 `['tools']`**、以及 `:1647-1655` 的 headless 语义均未变；③ `contract.test.ts` 的 `apply()` 夹具（`:1690-1800`，即该文件里的 **4 处 `apply()` 调用** `:1697` / `:1750` / `:1765` / `:1795`）与 `makeRig()` 驱动的契约用例全绿；④ 三处既有 deps 字面量（`contract.test.ts:1120-1137`、`httpApi.test.ts:253-261` 与 `:1147-1154`，**contract 只有 1 处**——与上面三处装配夹具不是同一组）已随本 task 补上必填的 `scope` / `refreshScope`，且补进去的 `scope` 是**真实的 `new ToolScopeState({ file: join(dataDir, 'scope.json') })` 实例**（不是 `as never` / 占位对象——这是 Task 9 逐字段解引用的前置条件）——这是本 task 的验收项之一（不是"迁移装配夹具"的附带结果），漏任何一处都会在 Step 5 的 `npm run typecheck` 上红。
- [ ] **Step 5: 门禁**——`npm run typecheck`（`tests/helpers/fakeToolHost.ts`、三处迁移过的装配夹具**以及三处补过 `scope` / `refreshScope` 的 deps 字面量**都落在 `tests` 里、被 server 项目覆盖：`CherryHttpDeps` 的两个新字段是必填，任一调用点漏补这里就红；三处字面量里的 `scope` 必须是**真实的 `new ToolScopeState({ file })` 实例**——写成 `as never` / 占位对象会在这里静默过关、却让 Task 9 的既有 `/diagnostics` 用例 500；`mount(ctx)` 只要求 `CherryBridgeContext` 的**结构超集**（`tools` 与方法都可选），故 `apply()` 侧的 `host.mount(ctx)` **不需要**转换或 cast——写成 cast 就说明 `ScopeHostContext` 又变回了不兼容的必填形状；`fakeToolHost.ts` 不是 `*.test.ts`，不会被 vitest 收集）。
- [ ] **Step 6: 重建产物 + 提交**——`npm run build` ⇒ `git add src/toolScopeHost.ts src/index.ts src/httpApi.ts tests/helpers/fakeToolHost.ts tests/integration/toolScopeHost.test.ts tests/integration/toolsManage.test.ts tests/integration/httpApi.test.ts tests/contract/contract.test.ts dist && git commit -m "feat(scope): one assembly point — registration, restriction and guard co-lifecycle"`。

---

### Task 5: 安装/释放判据、空集语义、guard 镜像、安装失败路径 + `tools/change` 订阅与合并闸（§6.2 动作条 + §4 重入与收敛 + B6/B12/B18/B15）

**Files:**
- Modify: `src/toolScopeHost.ts`（同一文件，**必须在 Task 4 之后单独执行**）
- Test: `tests/integration/toolScopeHost.test.ts`（同一文件追加 `describe`，串行）

**Interfaces:**
- Consumes：Task 4 的 `createToolScopeHost` / 假宿主；`MountedLayer`（**已装层记录**的元素类型）是 **Task 2** 在 `src/toolScope.ts` 的产出（Task 2 Interfaces 已列），本 task 只是消费它。
- **本 task 一并落地**（§4「重入与收敛」的三条硬约束）：订阅 `tools/change`、合并 / 置脏补跑、幂等短路、有界放大——它们与安装/释放判据**同轮**，理由见 Step 3 末。
- **方向锚（防止把装层判据写反）**：`deny` 目标集合 = 该 agent **要隐藏**的名字——**不可见 ⇒ `CHERRY_TOOL_NAMES` 的 14 个名字全部进 `deny`（装层 ⇒ 工具从该 agent 的工具表消失）**；**可见 ⇒ 空集（只释放、不安装 ⇒ 工具回到工具表）**。`global` 恒属"可见"（B2），故 `global` 下目标恒为空集 ⇒ 只释放。集合由 `judgement.visible` 派生（Task 3），**不是**由 `status === 'resolved'` 派生。**目标集合的唯一定义式（含判定缓存未命中的回退，本计划钉死、不留第二种）**：**目标集合 = `isVisible(doc, scope.judgement(agent.id)?.workspaceId)` 为真 ⇒ 空集；为假 ⇒ `CHERRY_TOOL_NAMES` ∩（无参）`schemas()`**（判定存在时它与 `judgement.visible` 同值——Task 3 已钉死 `visible === isVisible(doc, workspaceId)`，本式的意义是把**缓存未命中**一并纳入同一判据）。`judgement` 缺失（缓存未命中）时**按此式回退**：`judgement?.workspaceId` 代入 `undefined`，而 `global` 下 `isVisible(doc, undefined)` **恒为 `true`** ⇒ **`global` 下无论缓存状态恒为空集（只释放、不装层）**，与 B2 的字面要求一致；只有 `selected` 下未命中才 fail-closed（进 `deny`）。
- 关键不变量（实现时必须成立）：**层在 ⇔ 记录在**——`restrict()` 返回即层已装入，记录写在同一同步块内、**先装层后写记录**；释放侧**同步清除记录、再调用 disposer**；换层时记录在同一同步块内整体替换。

- [ ] **Step 1: 写失败测试**——追加断言：
  ① **`deny` 的入参**：夹具记录每次 `restrict` 入参 ⇒ 每次都是 `{deny:[...]}`，且各项 = `schemas()`（无参全局视图）∩ `CHERRY_TOOL_NAMES`，逐名相等；**从未**出现 `{deny: []}`、从未出现 `allow` 键（B12①/B18③）。
  ② **观测集合为空**（零在场例）：在注册前让无参 `schemas()` 取不到我们的名字 ⇒ 不调用 `restrict`（无 no-op 层）、不抛错；注册完成后由补齐**恰好装一层**完整交集（`restrict` 调用次数 = 1）；若该 agent 已有旧层，该旧层照常释放（"不阻止既有层的维护"）（**B18③ 的直接承载**）。
  **部分注册窗口（新例，与上面的零在场例分开断言——这就是 B12③ / B18④ 的直接承载）**：夹具令 `schemas()` 只含 **7** 个名字（其余注册尚未放行）⇒ 以 **7 名交集安装成功**——不抛错、**不断言 14 名**（不得要求此刻就装出完整交集）；随后放行其余注册并触发一次 `tools/change` ⇒ **补齐 = 以 14 名完整交集重装**、`install(new)` 仍**严格早于** `release(old)`、**可观测点**上的宿主层数 ≤ 1（与 ④ 同一口径：**已装层记录**数任一刻 ≤ 1——记录在同一同步块内整体替换，**不追加第二层**）。
  ③ **目标集合变空**（`global`，或该 agent 判定为**可见**即**在启用范围内**）⇒ **只释放**旧层、不安装；释放后夹具重新计算 agent 视图 ⇒ `cherry_*` **回到**该 agent 的工具表、且无层残留（`layer(agent)` 为 `undefined`——"释放后记录为空"这条断言**只属于纯释放场景**）（B18①/B2）。
  ④ **先装新、后释放旧**：夹具记录同一 agent 上的动作序列，断言 `install(new)` 严格早于 `release(old)`；**可观测点**上的宿主层数 ≤ 1（= **已装层记录**数任一刻 ≤ 1，记录在同一同步块内整体替换；spec §6.2 明文承认换层"确有两层并存的瞬时"，故断言只说**可观测点 / 记录数**，不说物理瞬时）；换层后 `layer(agent)` 指向**新层**（记录已整体替换，**不是** `undefined`——"`release` 后 `layer(agent)` 为 `undefined`"只在 ③ 的纯释放场景成立，**不得**在 ④ 留反向期望）（B18②/B10）。**防误改**：不得为了满足"层数 ≤ 1"而把动作改成"先释放后安装"——那正是 B18② 禁止的方向（先释放会造出"既未隐藏、也无旧层可回退"的空窗，且叠加不可恢复）。
  ⑤ **幂等短路**：目标 deny 与当前层逐名相同 ⇒ `restrict` 不被再次调用（§4 ②）。
  ⑥ **安装失败路径**：夹具令 `restrict` 抛错（含"两个时刻错位 ⇒ 交集仍含未知名而抛错"一例）⇒ 不抛到调用方、不静默 ⇒ `degraded()` 追加 `install`（reason 可读），紧随其后的 `tools/change` / 配置保存**重试并成功**（B12②④）。
  ⑦ **guard 是已装层的执行侧镜像**：层在 ⇒ 拒绝且返回字符串**含**工作区标题或 id；层不在 ⇒ 放行；即便把判定缓存清空 / 令 `judgement()` 返回矛盾值（夹具注入），裁决仍与层状态一致——不存在"可见却被拒"或"已隐藏却放行"（B6/G4/G1）。
  ⑧ **上游 `allow` 遮蔽不是故障**：夹具额外叠加一层上游 `allow` 把 `cherry_*` 排除 ⇒ `guard` **不**因此拒绝、`degraded()` **不**新增条目、不写错误日志（B15 的 guard 侧）。
  ⑨ **guard 的作用域**（§4 的消歧，硬约束）：层在时——**名单内**的名字 ⇒ 拒绝；**`CHERRY_TOOL_NAMES` 之外的名字**（夹具用 `bash` / `read` 这类）⇒ **放行**（返回 `undefined`）；`execution.agent` 取不到 ⇒ **放行**。三条**分别**断言、不得合并——guard 在派发口对**每一次**调用都会跑，不限名字会把被隐藏工作区里的全部工具一起拒掉（B6/§4）。
  ⑩ **restriction 取交集（契约断言）**：夹具在同一 agent 上叠加两层 `deny` ⇒ 释放其中一层后该名字**仍然不可见**（`layers.every(admits)`，交集不可恢复）；据此断言"每 agent 任一刻只有**一层**本插件的 restriction"（释放后层数归零、无残留）（B10/§4 的交集语义）。
  ⑪ **guard 只有单调拒绝、没有强制放行（契约断言）**：`guard` 的返回值只有"字符串 = 拒绝 / `undefined` = 放行"两态，**不存在**把拒绝翻回放行的能力 ⇒ "层在 ⇒ 拒绝"不可能被任何调用顺序或返回值反转；该断言与 ⑦ 的"层不在 ⇒ 放行"**互不推导**（前者是单调性，后者是镜像性）。
  ⑫ **合并 / 置脏补跑**（订阅与判据同轮，见 Step 3 末）：夹具在重算体执行期间再发一次 `tools/change` ⇒ 本轮结束前**补跑一次**（重算轮数 = 2），不递归放大（每 agent 每轮至多重装一次）。
  ⑬ 重算期间新建 agent（`agent/created`）⇒ 其**首次安装**落在补跑轮内（不丢；§4 的"新 agent 首次安装永不弃权"）。
  ⑭ **唯一弃权点**：teardown 期间到达的 `tools/change` 与 `agent/created` ⇒ 不触发重算、不装层——**teardown 是唯一的弃权点**（释放动作自身也会发 `tools/change`，弃权在那里才是正确的）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/integration/toolScopeHost.test.ts`，预期新增断言 FAIL（尚未实现空集/装层/闸逻辑）。
- [ ] **Step 3: 实现**——把"算目标集合 ⇒ 定动作 ⇒ 记录与层的原子对"写成 `installOrRelease(agent)`：**算目标集合只走方向锚里那一条定义式——`isVisible(doc, scope.judgement(agent.id)?.workspaceId)` 为真 ⇒ 空集、为假 ⇒ `CHERRY_TOOL_NAMES` ∩ 无参 `schemas()`**（缓存未命中不是第三种情形：`judgement()` 为 `undefined` ⇒ 代入 `undefined`，`global` 下仍为真 ⇒ 空集只释放，`selected` 下为假 ⇒ fail-closed 进 `deny`）；目标为空 ⇒ 只释放；非空且观测集为空 ⇒ 什么都不做（但释放既有层）；非空 ⇒ 先装新后释放旧；目标与该 agent 当前已装层**逐名相同** ⇒ 幂等短路（不调 `restrict`）；失败 ⇒ `noteDegraded({source:'install'})` + 标脏重试。**重算入口统一走一个"合并闸"**：进行中 ⇒ `dirty = true` 返回；结束时若 `dirty` ⇒ 再跑一轮（不递归，每 agent 每轮至多重装一次）；`tornDown` ⇒ 直接返回。`tools/change` 的订阅建立在本轮（`on?.('tools/change', …)`）。guard 的注册在**插件根 ctx** 上只做一次（幂等），其函数体**只**读 `scope.layer(execution.agent.id)`（**已装层记录**，不自行重算），且**只对 `CHERRY_TOOL_NAMES` 内的名字生效**——名字不在名单内 ⇒ `return undefined`；`execution.agent` 取不到 ⇒ `return undefined`。
  **为什么 `tools/change` 订阅与合并闸落在本 task 而不在 Task 4**：假宿主第⑦条规定 `restrict()` 在**安装与释放两侧都发** `tools/change`，订阅必须与安装/释放判据**同轮**落地——否则订阅一建立就自我触发（Task 4 的"Step 4 全 PASS"不可达）。
- [ ] **Step 4: 运行确认通过**——同命令 PASS；`npx vitest run tests/unit/toolScopeDoc.test.ts tests/unit/toolScopeJudge.test.ts` 未回归。
- [ ] **Step 5: 门禁**——`npm run typecheck`（`src/toolScopeHost.ts` 与 `tests/integration/toolScopeHost.test.ts` 都落在 server 项目：`src` 与 `tests` 已在 `tsconfig.json` 的 `include` 里，**无需登记**）。
- [ ] **Step 6: 重建产物 + 提交**——`npm run build` ⇒ `git add src/toolScopeHost.ts tests/integration/toolScopeHost.test.ts dist && git commit -m "feat(scope): empty-set semantics, install-failure path, the layer mirroring guard and the coalescing gate"`。

---

### Task 6: 有界复检、同步判定与补齐断言（§4 硬约束 + D14 + B13）

**Files:**
- Modify: `src/toolScopeHost.ts`（同一文件，**必须在 Task 5 之后单独执行**）
- Test: `tests/integration/toolScopeHost.test.ts`（同一文件追加 `describe`，串行）

**Interfaces:**
- Consumes：Task 4/5 的编排与假宿主（**含 Task 5 的合并闸**）；`ScopeHostDeps.recheckDelaysMs`（默认 `[250, 2000]`，测试注入小值 + `vi.useFakeTimers()`）。
- Produces：`refresh()` 的返回契约——触发**一轮**重算并返回**该轮**的 `RefreshSummary`（`skipped` = 幂等短路跳过的 agent 数；合并闸的补跑算**同一轮**，不额外计数）；`pending` / `unsupported` 无重算可跑 ⇒ 返回 `undefined`。重算计数口径供 Task 7 断言"保存 ⇒ 同步重算"（"同步"只指 `save → refresh` 之间**无 `await`**；PUT **不等**收敛，收敛由合并闸保证）。

- [ ] **Step 1: 写失败测试**——追加断言（**编号沿用原序列**：原来的 ①②③（合并 / 置脏补跑、新 agent 首次安装、唯一弃权点）已**整体移入 Task 5 ⑫⑬⑭**——它们与安装/释放判据同轮，故本清单从 ④ 起，不重排编号）：
  ④ **有界复检**：`unresolved` ⇒ 按 `recheckDelaysMs` 各排一次（两个定时器）；两次后仍 `unresolved` ⇒ 不再排（定时器总数 = 2）；`no-cwd` / `no-match` / `resolved` ⇒ **零定时器**（无空转）；夹具断言"复检只对 `unresolved` 启动"（D14）。**复检失败只记录、不抛**：夹具令复检定时器里那次 `rebuild()` **抛错** ⇒ 只记录（`log` 桩，缺省退回 `console.warn` 一条）+ **不抛**、**不产生未捕获拒绝**（D14 明文"失败只记录、不抛"；同步窗口同受此约束，见 ⑥）。
  ⑤ 复检只修正"暂时不可见"：夹具先给缺失的 `sessionIds` 投影、在第一次复检时刻补上 ⇒ 复检后该 agent 装层（B13 的 `sessionIds` 滞后补偿）；`cwd` 缺失的会话**不因复检翻盘**（仍不可见）。
  ⑥ **同步返回**：夹具令 `rebuild()` 挂起（`resolveByPath` 永不 resolve）⇒ `agent/created` 监听器**立即同步返回**、建会话不失败、当轮按 **D7** 处理——**仅 `selected`** 按 fail-closed（不可见）；**`global` 下按回退式仍可见（空集、只释放）**；`rebuild()` 完成后由合并闸的**补跑轮**纠正（不丢收敛）。
  ⑦ teardown 清掉未触发的复检定时器（无泄漏）：`vi.getTimerCount() === 0`。
  ⑧ **补齐断言（与 Task 5 的合并闸共用同一夹具；内嵌项用 `(a)(b)` 编号，避免与顶层的 `T6④`–`T6⑨` 混淆）**：(a) 复检触发的重算与 `tools/change` 触发的重算**共用同一个合并闸**——复检窗口内到达的 `tools/change` 只置脏、由补跑轮吸收，不产生并发的第二轮（每 agent 每轮至多重装一次）；(b) **teardown 是唯一的弃权点**：置位后到达的 `agent/created` / `tools/change` **既不排复检定时器、也不装层**（与 Task 5 ⑭ 是同一判据的两侧）。
  ⑨ **B13 的头号正路径（正向组合）**：夹具先让判定缓存**已就绪**（`judgement()` 命中且 `visible:true`——规范化路径命中，不是复检补偿来的），随后触发 `agent/created` ⇒ **当轮**即按该判定落层：目标集合为空集 ⇒ **不装 `deny`**（只释放既有层）、**不排复检定时器**（`resolved` 零定时器，与 ④ 一致）。这就是 spec §7「规则二**当轮装层**」（B13「第一轮就有工具」）的直接承载——与 ⑤ 的"复检补偿投影滞后"是**两条独立路径**，本条的层必须来自**当轮命中**而非后续复检。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/integration/toolScopeHost.test.ts`，预期新增断言 FAIL。
- [ ] **Step 3: 实现**——`agent/created` 监听器只做**同步判定** + 按方向锚的**唯一定义式**装层或只释放（缓存未命中时**仅 `selected`** fail-closed），**不在同步窗口里 await**（宿主按 `@mode serial` 派发它，监听器抛错会让建会话失败）；`unresolved` 时才 `setTimeout` 有界复检（间隔取 `recheckDelaysMs`，两次后不再排）；所有定时器登记在 effect 的 disposer 里一并清除，并受 `tornDown` 短路约束（teardown 后不再排新定时器）。重算入口的合并闸已由 Task 5 建立，本 task 只在其上触发复检。
  **为什么订阅与合并闸不在本 task**：理由见 Task 5 Step 3 末；本 task 只保留**有界复检 + 同步判定 + 补齐断言**，不重复实现闸。
- [ ] **Step 4: 运行确认通过**——同命令 PASS。
- [ ] **Step 5: 门禁**——`npm run typecheck`（`src/toolScopeHost.ts` 与 `tests/integration/toolScopeHost.test.ts` 都在 server 项目的覆盖面上，**无需登记**）。
- [ ] **Step 6: 重建产物 + 提交**——`npm run build` ⇒ `git add src/toolScopeHost.ts tests/integration/toolScopeHost.test.ts dist && git commit -m "feat(scope): bounded recheck and synchronous judgement"`。

---

### Task 7: HTTP 面 `GET/PUT /cherry-remote/api/scope`（§6.3 + B4/B14/B16）

**Files:**
- Modify: `src/httpApi.ts`（在既有的 `handleRequest` 分发表加 `first === 'scope'` 分支；`writeError` 原样复用。`CherryHttpDeps` 的两个字段 `scope` / `refreshScope` 由 **Task 4** 加好——本 task 只**消费**它们，不改接口形状，也不改 `src/index.ts`）
- Test: `tests/integration/scopeHttpApi.test.ts`（新；复用 `tests/helpers/fakeToolHost.ts` 与 `httpApi.test.ts` 的 `FakeWebServer` 风格）
- **本 task 不写**这两个文件：`tests/contract/contract.test.ts` 与 `tests/integration/httpApi.test.ts` 的三处 deps 字面量（`contract.test.ts:1120-1137`——该文件仅此 **1** 处；`httpApi.test.ts:253-261` / `:1147-1154`）已由 **Task 4** 就地补齐，`assemblyDeps()` 的接线同样在 Task 4；本 task 只在 Step 4 跑它们做回归。`scope` / `refreshScope` **保持必填**：不采纳"字段写成可选 ⇒ 缺省时 `/scope` 路由不挂载"的方案（spec 未授权——§6.3 的五个稳定错误码与 §6.4 的 D9 自救面都假定路由始终存在）

**Interfaces:**
- Consumes：`ToolScopeState` 的 `doc()/workspaces()/staleWorkspaceIds()/pathUnmatched()/host()/degraded()/save()`、`ToolScopeHost.refresh()`、既有 `isTrustedWebRequest` 围栏与 `writeError(res, status, error, message?)`，以及 **Task 4 已扩好的 `CherryHttpDeps` 两个必填字段** `scope: ToolScopeState` / `refreshScope(): RefreshSummary | undefined`（接口与 `assemblyDeps()` 接线都归 T4，本 task 只读这两个字段）。`refresh()` 的返回契约由 Task 6 产出、本 task ③ 消费：触发**一轮**重算并返回**该轮**的 `RefreshSummary`（`skipped` = 幂等短路跳过的 agent 数，合并闸的补跑算**同一轮**、不额外计数）；`pending` / `unsupported` 下无重算可跑 ⇒ 返回 `undefined`。
- Produces（响应形状逐字）：
  - `GET /cherry-remote/api/scope` → `{ scope: {mode, workspaceIds, revision}, workspaces: [{id,title,path}], staleWorkspaceIds: string[], pathUnmatched: [{agentId, cwd}], host: {state, capable, reason, degraded: [{source, reason}]} }`
  - `PUT /cherry-remote/api/scope` → 成功 `{ scope: {…规范化文档}, pruned: string[] }`；失败 `{error, message?}`（`writeError` 形状）
- **`CherryHttpDeps` 的两个字段不是本 task 的产出**：`scope` / `refreshScope` 由 **Task 4** 在 `src/httpApi.ts:148` 加入并接线（见上面的 Consumes），本 task 只加路由分支与响应组装。

- [ ] **Step 1: 写失败测试**——`tests/integration/scopeHttpApi.test.ts`：
  ① `GET` 形状逐字段断言（含 `degraded` 为**数组**、空数组 = 无降级；`host.capable === (host.state === 'ready')`）。
  ② 同源围栏：坏 `Origin` ⇒ 403 `forbidden`（沿用既有围栏，不新开例外）。
  ③ `PUT` 成功：`revision` 单调 +1、`pruned` 列出被修剪 id、返回规范化文档，且**同步**调用 `refreshScope()`——夹具记录"save 完成 → refresh 被调用"的先后（**同一同步段内、无 `await` 间隔**，B4/D10）。**"同步"只指这一件事：`save → refresh` 之间无 `await`；`PUT` 本身不等收敛**——响应不依赖本轮重算跑完（收敛由合并闸保证）：夹具令一轮重算在飞行中，`PUT` 照常返回，响应体已含新 revision 与新文档；放行该轮后**至多再补跑一轮**即收敛（重算轮数 ≤ 2），此时断言**一次**重算即可观察到**全部 live agent** 的层被重装（每个 live agent 的层都等于新文档的判定，B4）；夹具记录 `refreshScope()` 的返回值 = **该轮**的 `RefreshSummary`，`skipped` 只数幂等短路跳过的 agent、合并闸的补跑**不额外计数**（Task 6 的计数口径）。
  ④ `400 invalid-scope`：非法 `mode`、`workspaceIds` 非字符串数组 ⇒ 结构化错误、已存状态一位不动。
  ⑤ `400 missing-expected-revision`：请求体缺 `expectedRevision` ⇒ 拒绝（**有意的加严**，先例对 `undefined` 不抛错）。
  ⑥ `409 scope-revision-conflict`：`error` 是**字符串常量**、`message` 含当前 revision；不写入、不改动已存状态。
  ⑦ **并发**：两个携带**同一基准 revision** 的 `PUT` 并发提交 ⇒ 恰有一个成功且新 revision 单调 +1，另一个得到 `scope-revision-conflict`（临界区内无 `await`，不存在双双通过后的静默覆盖）。
  ⑧ `503 workspace-list-unavailable`：`list()` 不可用夹具 ⇒ 拒绝、不修剪、已存 `workspaceIds`/`mode` 一位不动、`GET.staleWorkspaceIds` 为空数组且带 `workspace-list` 标注（B14/B16 写侧护栏）。
  ⑨ `503 scope-version-unsupported`：盘上 `version:2` 文档 ⇒ 拒绝、不修剪不落盘、`GET.host.degraded` 含 `scope-version`。
  ⑩ `pathUnmatched` 传输通道：造"工作区已勾选、但该会话 `cwd` 规范化后对不上任何注册表项"的 agent ⇒ `GET.pathUnmatched` 含其 `agentId` 与 `cwd` 样本，且**不**出现在 `host.degraded` 里（非 degraded，不得与"已失效选择"互相推导）。
  ⑪ `host.state === 'pending'` 时 `GET` 照常 200（D9：被排除的工作区能自救），`PUT` 也能成功（范围写入不依赖宿主注入到达）：`pruned` 为空、不修剪，且 `refreshScope()` 无重算可跑、返回 **`undefined`**（Task 6 的返回契约）。
  ⑫ `405 method-not-allowed`：`POST /cherry-remote/api/scope`（以及其余非 `GET`/`PUT` 方法）⇒ `405`、`error === 'method-not-allowed'`（与既有五条路由同写法：`src/httpApi.ts:834/846/852/860/871`），不读 body、不改动已存状态。
  ⑬ **HTTP 级多源并存**（§7⑤）：同一夹具里同时令 `list()` 抛错（`workspace-list`）、`guard` 缺失（`visibility-only`）并叠加一次安装失败（`install`）⇒ `GET.host.degraded` 是**数组**、三个 source 各自一条**同时可见**（异源不得互相覆盖）；同一 source 再触发一次 ⇒ 仍只**一条**且 reason 为最新（同源去重）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/integration/scopeHttpApi.test.ts`，预期 FAIL（路由 404）。
- [ ] **Step 3: 实现**——在 `handleRequest` 里加 `first === 'scope' && match.segments.length === 1` 分支：先判方法——`GET` / `PUT` 之外一律 `writeError(res, 405, 'method-not-allowed', 'GET/PUT only')`（与既有五条路由同写法，`src/httpApi.ts:834/846/852/860/871`）；`GET` ⇒ 组装上面的响应（工作区列表**由插件侧**投影下发）；`PUT` ⇒ 读 JSON body（沿用既有 body 读取方式）⇒ `scope.save(body, body?.expectedRevision)` ⇒ `ok` 时**同步** `deps.refreshScope?.()` 再回 `{scope, pruned}`（只要求这一处无 `await`，**不等**重算收敛），否则 `writeError(res, status, error, message)`。`scope` 与 `refreshScope` 由 Task 4 的 `assemblyDeps()` 交出——本 task 只消费，不改 `src/index.ts`。
- [ ] **Step 4: 运行确认通过**——`npx vitest run tests/integration/scopeHttpApi.test.ts tests/integration/httpApi.test.ts`，预期全 PASS（后者证明既有路由未回归）。
- [ ] **Step 5: 门禁**——`npm run typecheck`（`src/httpApi.ts` 与 `tests/integration/scopeHttpApi.test.ts` 都落在 server 项目：`src` 与 `tests` 已在 `tsconfig.json` 的 `include` 里，**无需登记**，见 Global Constraints 的 tsconfig 规则）。
- [ ] **Step 6: 重建产物 + 提交**——`npm run build` ⇒ `git add src/httpApi.ts tests/integration/scopeHttpApi.test.ts dist && git commit -m "feat(scope): GET/PUT /cherry-remote/api/scope with stable error codes"`（三处 deps 字面量与 `src/index.ts` 已在 Task 4 的 commit 里，故不在本行的 `git add` 里）。

---

### Task 8: 设置页「启用范围」面板（§6.4 + B8/B14–B17 的 UI 侧）

**Files:**
- Create: `ui/src/ToolScopePanel.tsx`
- Modify: `ui/src/api.ts`（`getScope()` / `putScope(body)`，复用 `ApiError` 的 `{status, code, message}`）、`ui/src/types.ts`（`ScopeDoc`/`ScopeResponse`/`ScopeHostState`/`DegradedNote` 的 UI 侧类型）、`ui/src/App.tsx`（在设备列表上方挂载面板；`AppProps` 增**可选** `scopeClient?: ScopeClient` 接缝——与既有 `eventSourceFactory` 同风格，默认真实 `fetch` 包装）
- Modify: `tests/unit/ui.test.ts`（**既有 UI 夹具的就地改动，修法锚在夹具层**）——`installFetch`（`:120-134`）的白名单/响应表 + `renderWithDevice`（`:162-175`）只登记 `/devices`；对**未登记**的请求 `installFetch` 直接 `throw` ⇒ 该请求落成 **rejected promise** ⇒ 渲染进入**错误态或未捕获拒绝**（**不是**"24 个既有用例全红"这种夸大说法——失效模式是按渲染路径各自发生的）。面板挂进 `App` 后必须让**所有** App 渲染路径都能拿到 `GET /cherry-remote/api/scope` 的响应（或注入 `scopeClient` 桩）：除 `renderWithDevice`（`:162-175`，被该文件多数用例复用）外，还有 4 个**直接**渲染路径要逐一核对——`:485→:488`（状态灯矩阵的循环体内）、`:578→:582`、`:664→:667`、`:773→:779`（渲染 `slots` 注册的 `Section`，即 `App` 本身）；并把 `order[0] === 'sse'`（`:251`）这类顺序断言限定在 **sse/pair 两类事件**上（面板的 `/scope` 读请求会写进 `order`）
- Modify: `tsconfig.ui.json`（`include` 加 `tests/unit/uiScopePanel.test.ts`）、`tsconfig.json`（`exclude` 加同一路径）；**并同步更新两个文件的头部注释**——它们都以"两个 UI 环境测试"为由，加入第三个后注释即过期（仓库习惯是"注释即理由"）
- Test: `tests/unit/uiScopePanel.test.ts`（新，`// @vitest-environment jsdom`，沿用 `tests/unit/ui.test.ts` 的 testing-library 风格）

**Interfaces:**
- Consumes：Task 7 的响应形状与错误码；`ApiError.status/code/message`。
- Produces：`export function ToolScopePanel(props: { client?: ScopeClient }): JSX.Element`（`ScopeClient` 默认真实 `fetch` 包装，测试注入假客户端——与 `App` 的 `eventSourceFactory` 同一套接缝风格）；`AppProps.scopeClient?: ScopeClient`（**可选**接缝，同风格，`App` 把它透传给面板）。

- [ ] **Step 1: 写失败测试**——`tests/unit/uiScopePanel.test.ts`：
  ① 渲染模式单选 + 工作区多选（标题 + 路径）；空态文案**按模式区分**（D11 逐字）：`selected` + 未勾 ⇒ 含"此状态下 `cherry_*` 工具不会出现在任何会话里"；`global` + 未勾 ⇒ 含"这些工具在所有工作区都可用"且**不含**前一句。
  ② `unsupported` ⇒ 顶部只读告警 + **按真实缺因**的原因（夹具给"缺 tools.restrict" ⇒ 文本含 `tools.restrict`）+ **升级提示**（**逐字**要求：必须出现指向"升级宿主 / DSH 以获得该能力"的**升级**文案——只有"原因 + 禁用保存"不算，spec B7①/§6.4 明文要求）+ **禁用保存**；`pending` ⇒ **只**中性等待提示（断言文本**不含**"不支持"、**不含**升级字样，与 `unsupported` 的升级提示**措辞相反**）、**不禁用**保存、配对区（`PairingWizard`）仍渲染（D9）。
  ③ 已失效选择：`staleWorkspaceIds` 非空 ⇒ 渲染"已失效（工作区已删除）"分组 + 一键清除；点击后发出 `PUT` 且界面据 `pruned` 回显（**不得**显示"校验失败"）。
  ④ 列表不可用（`degraded` 含 `workspace-list`）⇒ 禁用保存并显示原因；`global` 模式下仍显示"注册表列表当前读不到"。
  ⑤ 降级标注**逐条**渲染：`degraded` **五源齐备**（`install`/`workspace-list`/`visibility-only`/`scope-version`/`path-normalization`——与 Task 2 的 `DegradedSource` 五值列表逐一对齐）⇒ 五条文本**同时**在文档里（异源并存：不得只渲染最后一条、不得让后写覆盖先写）。
  ⑥ 保存失败按**稳定错误码**分流：`scope-revision-conflict` ⇒ 冲突提示；`scope-version-unsupported` ⇒ 含"版本高于本插件支持"且**禁用保存**、**不得**出现"请重新读取后再保存"；`invalid-scope`/`missing-expected-revision`/`workspace-list-unavailable` ⇒ 各自的提示；**所有失败不改动本地状态**（断言勾选与模式未被重置）。
  ⑦ 文案边界：面板文本**不得**出现"模型一定能看到"/"一定能调用"；只声称"本插件未遮蔽"（B15）。
  ⑧ `pathUnmatched` 非空 ⇒ 逐条列出 `agentId` 与 `cwd` 样本并说明三者不可区分，且**不**与"已失效选择"分组合并（§6.4）。**该提示呈现期间零 `PUT`、已勾选与 `mode` 一位不动**：夹具记录 `GET` 之后没有任何 `PUT`，且断言勾选集合与 `mode` 与呈现前逐位相同——§6.4 里它只解释"勾了却无工具"的原因，**不改判定输入**。
  ⑨ **保存成功回显新 revision**（§6.4 末句）：夹具令 `PUT` 返回 `{scope:{…, revision: 8}, pruned: []}` ⇒ 面板回显**新 revision**（断言文本含新值，且旧值不再被当作当前 revision）。
  ⑩ **`pending` 与列表降级同屏两条并存**（§6.4）：夹具同时令 `host.state === 'pending'` 且 `host.degraded` 含 `workspace-list` ⇒ **两条**提示同时在文档里（中性等待提示 + "注册表列表当前读不到"），**不得**只渲染一条、**不得**由其一推导其二；断言文本**不含**"宿主不支持"。
  ⑪ **既有 UI 用例不被打烂**（`tests/unit/ui.test.ts` 的就地改动）：`installFetch` 的白名单/响应表与 `renderWithDevice` 都覆盖 `GET /cherry-remote/api/scope`（或给 `App` 注入 `scopeClient` 桩），**且所有 App 渲染路径都拿得到**——`renderWithDevice` 之外的 4 个直接渲染路径（`:488` / `:582` / `:667` / `:779`）逐一核对；未登记时的失效模式是**该请求被 `throw` ⇒ rejected promise ⇒ 渲染进入错误态或未捕获拒绝**（不是"24 个用例全红"），改动落地后该文件 **24 个既有用例**保持全绿；`order[0] === 'sse'`（`:251`）这类顺序断言只在 **sse/pair 两类事件**的范围内成立。
  ⑫ **损坏文档 ⇒ 设置页出现告警行（B9 的"并在设置页提示"，承载是既有文案位）**：夹具令作用域文档**损坏**（解析失败 / 字段非法 ⇒ 状态层按严格度序落到 `selected` + 空列表）⇒ 面板在**既有**文案位出现告警行（即 ① 里 `selected` + 未勾的那条空态 / 告警行，**同一处**；**不新增 UI 区域、不新增 `DegradedSource` 成员**，文案含"`cherry_*` 工具不会出现在任何会话里"）；同时断言**不得**静默呈现为 `global` 或"一切正常"（`global` 模式的那句空态文案**不在**文档里）。
  ⑬ **`scope-version` 的渲染态 ⇒ 显式告警 + 禁用保存**：夹具令 `GET` 的 `host.degraded` 含 `source:'scope-version'`（reason 含"文档版本高于本插件支持"，且**本轮没有任何 `PUT`**）⇒ 面板顶部除逐条渲染（⑤）外，还必须有**显式告警**（文本含"文档版本高于本插件支持"）**并禁用保存**。本条的输入是 `GET`，与 ⑥ 的"`PUT` 失败后按错误码分流"是**两条独立路径**，不得互相推导（⑥ 不得被当作本条的断言，反之亦然）。
  ⑭ **`scope-version` 不得呈现为"一个都没勾"（必须与"用户空选"可区分）**：同一夹具下，`degraded` 含 `scope-version` 时，① 里 `selected` + 未勾的那条空态文案**不在**文档里（不得让用户以为是自己没勾）；把夹具的 `degraded` 换回**空数组**（`scope` 一位不动）⇒ 该空态行**才**出现——两次渲染的文本必须不同。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/unit/uiScopePanel.test.ts`，预期 FAIL（模块不存在 / 项目未登记 ⇒ 先登记再跑，见 Step 3）。
- [ ] **Step 3: 实现**——先登记 `tsconfig.ui.json` 的 `include` 与 `tsconfig.json` 的 `exclude`（否则 `projectCoverage` 门禁变红且该文件被 `tsc` 静默跳过），再写面板组件；`App` 增**可选** `scopeClient` 接缝（与 `eventSourceFactory` 同风格）并把面板挂在设备列表上方；同时改 `tests/unit/ui.test.ts` 的既有夹具（登记 `/scope` 响应或注入桩）与顺序断言（限定 sse/pair 两类事件）；`api.ts` 的 `putScope` 必须把非 2xx 的 `{error, message}` 原样抛成 `ApiError`（面板据 `error` 分流）。
- [ ] **Step 4: 同步 tsconfig 头部注释**——更新 `tsconfig.json` 与 `tsconfig.ui.json` 的头部注释：两处都以"**两个** UI 环境测试"为由写死了理由，本 task 加入第三个（`tests/unit/uiScopePanel.test.ts`）后必须同步；仓库习惯是"注释即理由"，漏改则注释与事实不符。
- [ ] **Step 5: 运行确认通过**——`npx vitest run tests/unit/uiScopePanel.test.ts tests/unit/ui.test.ts tests/unit/projectCoverage.test.ts`，预期全 PASS。
- [ ] **Step 6: 门禁**——`npm run typecheck`（两个项目都要过）+ `npm run build:client`（客户端产物 `lib/client.js` 是与 `dist/` **并列**的另一半，`tests/integration/clientBundle.test.ts` 会校验）。
- [ ] **Step 7: 提交（产物已在 Step 6 重建，此处不重复 `build:client`）**——`git add ui/src tsconfig.ui.json tsconfig.json tests/unit/ui.test.ts tests/unit/uiScopePanel.test.ts lib && git commit -m "feat(scope): settings panel for the enablement scope"`。

---

### Task 9: 诊断面 + 门禁 + 真机清单（收口）

**Files:**
- Modify: `src/diagnostics.ts`（`DiagnosticsReport` 增 `scope` 段；来源经 `DiagnosticsSources` 注入）、`src/index.ts`（把 `scope` 的读取口接进诊断来源）、`src/httpApi.ts`（诊断来源经 deps 进入 `diagnosticsReport`——本文件的写者顺序 **4 → 7 → 9**）、`docs/e2e-checklist.md`、`README.md`
- Test: `tests/unit/diagnostics.test.ts`（追加）

**Interfaces:**
- Consumes：`ToolScopeState` 的 `doc()/host()/degraded()/pathUnmatched()/workspaces()`。
- **前置条件（由 Task 4 落地，不是本 task 的产出）**：三处既有 deps 字面量（`tests/contract/contract.test.ts:1120-1137`、`tests/integration/httpApi.test.ts:253-261` / `:1147-1154`）补进去的 `scope` 必须是**真实的 `new ToolScopeState({ file: join(dataDir, 'scope.json') })` 实例**（与 `apply()` 里同一构造形态），**不得**是 `as never` / 占位对象——`src/httpApi.ts:920-933` 的 `diagnosticsReport` 会逐字段解引用该对象，占位值会让既有 `/diagnostics` 用例 500 变红。
- Produces：`DiagnosticsReport.scope = { mode, revision, workspaceIds, host: {state, capable, reason, degraded}, pathUnmatched: [{agentId, cwd}] }`——与 `GET /scope` 的 `host` **同源同值**（同一次读取，不各持副本）。
- **脱敏承载（显式裁决）**：扩 `sanitizeDiagnostics` 的**入参**（`source` 增加 `scope?` 段），并为该段新增**字段白名单**——只允许 `mode` / `revision` / `workspaceIds` / `host{state,capable,reason,degraded}` / `pathUnmatched[{agentId,cwd}]`，白名单外的字段一律不透出。`pathUnmatched[].cwd` **原样**下发（不做摘要、不截断：与 `GET /scope` 同值，属本地路径、非凭据，是解释"勾了却无工具"的必要证据；spec §9 授权范围内的脱敏口径由此钉死）。

- [ ] **Step 1: 写失败测试**——`tests/unit/diagnostics.test.ts` 追加：① 报告含 `scope` 段且字段齐全、`capable === (state === 'ready')`；② 与 `/scope` 的 `host` 取自**同一对象/同一次读取**（夹具改一次 `setHost` ⇒ 两处同时变，证明没有第二份副本）；③ `sanitizeDiagnostics` 的 **scope 段白名单**：入参里塞入白名单外字段（如 `accessToken` / `desktopIdentity` / `identity`）⇒ 报告中不出现；`pathUnmatched[].cwd` **原样**保留（与 `GET /scope` 同值，不摘要不截断）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/unit/diagnostics.test.ts`，预期 FAIL（无 `scope` 段）。
- [ ] **Step 3: 实现**——`DiagnosticsSources` 增加可选 `scope?(): {...}`，`buildDiagnostics` 拼装；`sanitizeDiagnostics` 的入参接收 scope 段并按上面的白名单投影（白名单外字段丢弃）；`src/index.ts` 的 `assemblyDeps()` 提供实现，`src/httpApi.ts` 的诊断来源经 deps 进入 `diagnosticsReport`。**本 task 假定"三处 deps 字面量的取值是真实 `ToolScopeState` 实例"这一前置条件已由 Task 4 满足**（见 Interfaces）：若那里是占位对象，本 Step 之后的既有 `/diagnostics` 用例会 500——修复点不在本 task 的 Files 里，故这一条必须在 Task 4 落地时就钉住。
- [ ] **Step 4: 运行确认通过 + 门禁**——`npx vitest run tests/unit/diagnostics.test.ts` PASS，随后 `npm run typecheck`（`src/diagnostics.ts`、`src/httpApi.ts`、`src/index.ts` 与 `tests/unit/diagnostics.test.ts` 都落在 server 项目：`src` 与 `tests` 已在 `tsconfig.json` 的 `include` 里，**无需登记**）。
- [ ] **Step 5: 重建产物**——`npm run build`（先重建 `dist/`；本 task 不改 `ui/`，无需 `build:client`）。
- [ ] **Step 6: 文档**——`docs/e2e-checklist.md` 增真机步骤：**默认谁都没有工具** → 设置页勾选一个工作区并保存 → **进行中的会话**下一轮工具出现 → 取消勾选即时消失 → 无工作区的会话始终没有 → 删除一个已勾选的工作区后设置页显示"已失效"并可一键清除 → 宿主能力 `pending` 时设置页只给中性提示（人为制造：临时移除 `agents` 注入）。`README.md` 增「启用范围」一节（两种模式、默认都不给、`/cherry-remote/api/scope` 两个端点、五个稳定错误码）。
- [ ] **Step 7: 提交**——`git add src/diagnostics.ts src/index.ts src/httpApi.ts tests/unit/diagnostics.test.ts dist docs/e2e-checklist.md README.md && git commit -m "feat(scope): diagnostics face, e2e checklist and README for the scope feature"`。**源码 + 产物 + 文档放在同一个 commit**：全量门禁只能在产物已提交之后跑（见 Global Constraints）。
- [ ] **Step 8: 全量门禁**——`npm run typecheck && npm test` 全绿（**只能在 Step 7 的产物已提交之后跑**：`tests/unit/artifactFreshness.test.ts` 以 `git show HEAD:<产物>` 与当前源码的重建结果逐字节比，产物未提交或不在 HEAD 里必红）；`tests/contract/contract.test.ts` 保持绿。
- [ ] **Step 9: 需要时补 commit**——Step 8 暴露的问题：源码问题 ⇒ 修源码 + `npm run build` + 与产物**同一个** commit（不得只提交源码）；文档措辞 ⇒ 只补文档 commit。**不要**在产物未提交时重跑 `npm test`。

---

## 文件写者矩阵（执行时的串行化依据）

| 文件 | 写它的 task（**严格按序，不得并发**） |
| --- | --- |
| `src/tools.ts` | 1 |
| `src/atomicFile.ts` | 2（`src/deviceStore.ts` **不在本计划的写者清单里**：Task 2 只复刻写法、一行不改） |
| `src/toolScope.ts` | 2 → 3 |
| `src/toolScopeHost.ts` | 4 → 5 → 6 |
| `src/httpApi.ts` | 4 → 7 → 9（T4 加 deps 字段、T7 加 `/scope` 路由、T9 接诊断来源） |
| `src/index.ts` | 4 → 9（T4 里 `apply()` 装配 + `assemblyDeps()` 交出 `scope` / `refreshScope`；**T7 不改本文件**——它只加路由、只消费那两个字段；T9 接诊断来源。仍严格串行） |
| `src/diagnostics.ts` | 9 |
| `dist/**`（重建产物） | **每个改 `src/` 的 task**（1/2/3/4/5/6/7/9）——产物与源码**同一个 commit**；同树不得并发重建（并行会让 `artifactFreshness` 变红） |
| `lib/client.js`（客户端产物） | 8（客户端半的产物，`tests/integration/clientBundle.test.ts` 校验） |
| `tests/helpers/fakeToolHost.ts` | 4（创建后由 5/6/7 只读消费——Task 7 的 `scopeHttpApi.test.ts` 复用同一夹具） |
| `tests/integration/toolScopeHost.test.ts` | 4 → 5 → 6 |
| `tests/integration/scopeHttpApi.test.ts` | 7（新） |
| `tests/unit/toolScopeDoc.test.ts` | 2（新） |
| `tests/unit/toolScopeJudge.test.ts` | 3（新） |
| `tests/unit/uiScopePanel.test.ts` | 8（新） |
| `tests/unit/diagnostics.test.ts` | 9（追加） |
| `tests/contract/contract.test.ts`（**单列**：它是**两个 task** 的写者） | **1 → 4**（Task 1 替换 `:322-337` 的第二份 `TOOL_NAMES` 名单；Task 4 就地迁移 `apply()` 夹具并补 `:1120-1137` 的 deps 字面量——**下面两行里出现的同一个文件以本行为准**，顺序仍是 **1 → 4**） |
| 三处既有装配夹具：`tests/integration/toolsManage.test.ts`（`assemblyCtx`）、`tests/integration/httpApi.test.ts`（`assemblyCtx`，1 夹具 × 6 用例）、`tests/contract/contract.test.ts`（`apply()` 夹具——**4 处 `apply()` 调用**：`:1697` / `:1750` / `:1765` / `:1795`） | 4（就地迁移；其中 `tests/contract/contract.test.ts` 的 **Task 1 写者身份**见上面那行单列条目） |
| 三处既有 deps 字面量（**与上面那组不是同一组**）：`tests/contract/contract.test.ts:1120-1137`（**1** 处）、`tests/integration/httpApi.test.ts:253-261` 与 `:1147-1154`（**2** 处） | **4**（就地补必填的 `scope` / `refreshScope`——取值必须是真实的 `new ToolScopeState({ file })` 实例；与上面三处装配夹具是同一次改动）——这两个文件的总顺序都只到 **4**；Task 7 只加路由、只消费，不再改它们 |
| `tests/unit/ui.test.ts` | 8（既有夹具就地改动：登记 `/scope` 或注入桩 + 顺序断言限定 sse/pair） |
| `ui/src/**` | 8 |
| `tsconfig*.json` | 8（`tsconfig.ui.json` 的 `include` / `tsconfig.json` 的 `exclude` + 两处头部注释同步） |
| `docs/e2e-checklist.md` / `README.md` | 9 |

**并行纪律**：**所有 task 一律严格串行，执行顺序即任务编号顺序 1 → 9**——src 侧任务写同一棵源码树、共用同一个 `dist/` 重建（并行重建 `dist/` 会让 `artifactFreshness` 变红），且 `src/toolScope.ts`、`src/toolScopeHost.ts`、`src/httpApi.ts`/`src/index.ts` 本身就是同一文件的串行链；**Task 8 与 Task 5/6 之间也不并行**（Task 8 要改 `tsconfig.json`，而 Task 5/6 的 `npm run typecheck` 读同一份项目配置 ⇒ 并行会产生与源码无关的**假红**，把执行者引向不存在的缺陷）。

## Self-Review 记录

**1. Spec 覆盖（逐条可核对的映射；引用一律用计划自身的 Tn/Step 与 spec 自身的 Bn/Dn/§n）**：

- **B1**（文档不存在 ⇒ 谁都不给）：T2①③ + T4③ + T5①——**"ready ⇒ 对全部 live agent 装 restriction"（默认文档下 14 个名字全进 `deny`）才是 B1 的正向证据**；先前写在这一行的 T5③ 是"目标集合为空 ⇒ 只释放、不安装"，方向**相反**（它是 B18① 的承载），已剔除。
- **B2**（`global` 恒可见、不装层）：T2③⑤ + T3④⑨ + T5③。
- **B3**（`selected` 命中者可见）：T2③ + T3①④。
- **B4**（保存后全部 live agent 重算、进行中的会话下一轮即生效）：T7③（PUT 同步 `refreshScope()`；**一次**重算即可观察到全部 live agent 的层被重装；至多补跑一轮收敛）+ T5⑫/T6⑧（合并闸）。
- **B5**（无工作区不可见）：T2③ + T3④⑧。
- **B6**（guard 是已装层的执行侧镜像；"理由可读"与作用域限定）：T3 的 `reason` 行（**由安装动作写进已装层记录**，guard 只读该记录、不重算）+ T5⑦⑨⑪。
- **B7**（能力三态 / 真实缺因 / `capable` 投影 / `unsupported` 的升级提示与禁用保存）：T4①②③⑥（含三态优先级）+ T8②。
- **B8**（设置页与 `/cherry-remote/api` 全域可用、配对自救面照常）：T7⑪ + T8②。
- **B9**（损坏/非法 ⇒ 严格度序 + 既有 warn，不新增 `degraded` 成员）：T2②⑤（T2② 的**显式**断言：解析失败 / 字段非法 ⇒ 既有 warn 被调用**恰好一次**、合法输入零次）；"并在设置页提示"由**既有** UI 文案位承载（T8⑫ 的告警行 = T8① 的空态/告警位），不新开承载。
- **B10**（反复 apply / 依赖卸载-重挂不叠加）：T4④⑤ + T5⑩。
- **B11**（14 名单一常量）：T1①（**替换**合约测试里的第二份名单，不是追加 describe）②③ + T4 Step 3 的装配点传 `names: CHERRY_TOOL_NAMES`。
- **B12**（只提交交集 / 失败不抛不静默 / 部分注册窗口补齐 / 交集仍抛错走失败路径）：T5①（只提交交集，绝无空 `deny`）+ T5② **的 7 名在场新例**（部分注册窗口：以 7 名交集安装成功 ⇒ 放行后补齐为 14 名完整交集重装）+ T5⑥（失败不抛不静默；含"交集仍抛错"一例）。
- **B13**（首轮即有工具 + `sessionIds` 滞后的有界复检）：T6⑨（**头号正路径**：缓存已就绪——`judgement()` 命中且 `visible:true`——+ `agent/created` ⇒ **当轮**按判定落层、不装 `deny`、不排复检定时器）+ T6⑤⑥（`sessionIds` 滞后补偿与同步返回）；T3② 只是前提（规范化路径判定的单一契约），不是正路径本身。
- **B14**（悬空 id 对账与修剪 + 写侧护栏）：T2⑦⑧ + T7③⑧ + T8③。
- **B15**（与上游 `allow` 共存：不拒、不 degraded、文案不越界）：T5⑧ + T8⑦。
- **B16**（列表读失败 fail 方向 + `[]` 等同读失败 + 写侧拒绝）：T2⑧ + T3⑧ + T7⑧ + T8④。
- **B17**（`guard` 缺失 ⇒ 仅可见性降级、不拒注册）：T4⑥ + T8⑤（五源里的 `visibility-only`）。
- **B18**（动作判据四条）：① 空集只释放 T5③；② 先装新后释放旧 T5④；③ 不提交空 `deny`（含"既有层照常释放"）T5② 的**零在场例**；④ 补齐 = 重装单层完整交集 T5② 的 **7 名在场新例**——零在场例与 7 名在场例是**两条不同条款的承载，不得互相顶替**。
- **D7 / D10 / D11**：D7 无工作区不可见 T3④⑧ + T5③；D10 保存 ⇒ 同步 `refreshScope()` T7③；D11 空态逐字文案 T8①。
- **D14**（路径同一性唯一契约 + 四值 + 有界复检 + 路径不匹配诊断）：T3②③④ + T6④⑤⑥ + T7⑩ + T8⑧。
- **§6.1 列表三态与唯一写入者**：T2 的「列表三态与唯一写入者」小节 + T3⑧⑩ + T7⑧⑪。
- **§6.2 动作条与 teardown 次序**：Global Constraints 的 teardown 条 + T4 Step 3 + T5 Step 3。
- **§6.3 五个稳定错误码（逐一有主）+ 405 路由约定**：状态层 T2⑦（拒绝优先级）；传输层 `invalid-scope` T7④、`missing-expected-revision` T7⑤、`scope-revision-conflict` T7⑥、`workspace-list-unavailable` T7⑧、`scope-version-unsupported` T7⑨——**五个逐一有主**（上一版这里漏了 T7⑤，只列了 ④⑥⑧⑨）；`405 method-not-allowed` T7⑫（仓库既有路由约定，非 spec §6.3 的错误码清单）。
- **§6.4 每一条**：空态 T8①、能力三态与升级提示 T8②、已失效一键清除 T8③、列表不可用 T8④、降级逐条（五源）T8⑤、错误码分流 T8⑥、文案边界 T8⑦、`pathUnmatched` T8⑧、保存成功回显新 revision T8⑨、`pending` 与列表降级同屏 T8⑩、损坏文档的既有告警位 T8⑫、`scope-version` 渲染态的显式告警与禁用保存 T8⑬、`scope-version` 与"用户空选"可区分 T8⑭。
- **§7 假宿主七条**：T4 的夹具接口 ①–⑦ 逐条写出（含第⑦条"安装与释放两侧都发 / `guard` 两侧都不发"的差异）；由它支撑的断言：交集不可恢复 T5⑩、绝不提交空 `deny` T5①、"释放动作自身发的 `tools/change` 不把层装回来" T5⑭/T6⑧。
- **§7 边界⑤⑥（多源并存 / 版本过高）**：T2⑥ + T7⑬ + T8⑤；T2② + T7⑨ + T8⑥⑬⑭（"版本过高"三侧：服务端拒绝、渲染态告警与禁用保存、与"用户空选"可区分）。
- **§9 授权边界**：正文只把"模块内私有结构 / 面板控件交互 / 诊断字段措辞"留给执行者；`[250, 2000]` 复检间隔（T6 Interfaces）与 `path-normalization` 文案（T3③）**已在正文钉死**，不再列在"留给执行者"里。

**上一版的结论为什么不成立（硬证据）**：上一版只写一句"无遗漏项"，而合约测试里的**第二份 14 名单**——`tests/contract/contract.test.ts:322-337` 的 `TOOL_NAMES` 字面量（被 `:1668` 的 README 逐名断言与 `:1677` 的 rig 注册名断言消费）——在当时**没有任何归宿**；只要它还在，B11 的"单一常量"就不成立。本轮由 T1① 以"**替换**该字面量为 `CHERRY_TOOL_NAMES`（而不是追加一个 describe）"补上，本节也据此改为逐条映射，不再用结论式措辞。

**2. Step 扫描**：每个 Step 都是"一个动作 + 可核对的产物"（写断言 / 跑命令看 FAIL / 实现精确签名 / 跑命令看 PASS / 门禁 / 提交）。没有"处理边界情况"这类无判据的步骤；没有把某个函数的完整函数体抄进计划（只给签名、不变量与次序）。

**3. 类型一致性**：`ToolScopeState` / `ScopeDoc` / `DegradedNote` / `AgentJudgement` / `MountedLayer` / `RefreshSummary` / `ScopeHostState` / `ScopeWorkspace` 在 T2/T3 定义一次，T4–T9 只消费；`createToolScopeHost` 与 `ToolScopeHost` 的方法名（`mount` / `refresh` / `state`）在 T4 定义、T6/T7 消费同一批名字，**释放路径只有 `mount()` 返回的 disposer 这一条**（不提供 `dispose()`）；错误码字符串五处出现、写法完全一致。

**4. Review Focus**：五条都已在对应 task 落成断言（见该节脚注的 task 编号），无空条目。

**5. 比例**：spec **834** 行（修复时点实测）；本计划自身 **466** 行（本批次收口实测，`wc -l`——头部不写死行数、只在此处给实测值，故本批次改动后此处同步）。**全文 0 个 fenced 代码块**（没有任何三反引号围栏）；先前写的"代码块只出现三次"这个说法**不成立**——那三处（命令、JSON 形状、假宿主七条语义清单）都是**行内清单**而非代码块，故"未把实现抄成代码"的实质结论不变。

**6. 自检修正记录**：Step 扫描发现 Task 1–9 的提交步骤原本漏了"改源码必须重建产物并放进同一个 commit"这条硬门禁（`artifactFreshness` 拿 HEAD 的产物与当前源码的重建结果比对），已逐条补上并写进 Global Constraints；`git add` 行里一处 `2>/dev/null` 的凑合写法也一并去掉了。

**留给执行者的判断（spec §9 已授权）**：模块内私有结构的形状、面板控件交互（列表 + 复选 / 搜索 / 全选）、诊断字段的具体措辞。
