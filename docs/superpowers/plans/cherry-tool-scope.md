# cherry-tool-scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本计划的书写约定**（与仓库既有计划 `2026-10-09-dsh-cherry-bridge.md` 同风格）：每个 task 的
> Step 1 给出**测试文件名 + 断言逐条**（含规格里钉死的值：签名、常量、稳定错误码、动作次序），
> **不逐段抄测试体**——执行者按断言写测试。凡"不可自定"的部分（disposers 释放次序、`deny` 取交集
> 的观测源、空集语义、错误码字符串、HTTP 状态码）逐字给出；其余实现细节自定。

**Goal:** 把 14 个 `cherry_*` 工具从"所有工作区全局可见"改成"按作用域文档（全局 / 仅选定工作区）受管"——未启用的工作区里它们**不进模型的工具表**，改配置后**进行中的会话下一轮即生效**。

**Architecture:** 新增一个状态所有者（`src/toolScope.ts`：作用域文档 + `degraded` 集合 + 规范化路径映射 + 每 agent 判定缓存 + **已装层记录**）与一个宿主集成层（`src/toolScopeHost.ts`：能力三态、注入门控的**唯一装配点**、restriction 安装/释放、guard、合并式重入闸、有界复检）。工具仍注册在插件根 ctx 的**全局层**，可见性**只**由装在每个 `agent.ctx` 上的 restriction 决定；HTTP 面新增 `GET/PUT /cherry-remote/api/scope`，设置页新增「启用范围」面板。

**Tech Stack:** TypeScript (Node ≥22.18)、Cordis 插件（`ctx.inject` / `ctx.effect`）、`@deepseek-ai/dsh-tools` restriction/guard 面、vitest（jsdom 用于 UI 测试）、tsdown + vite 构建、React。

**Spec:** `docs/superpowers/specs/2026-10-15-cherry-tool-scope-design.md`（793 行，两轮外部审查 + 最终通读 PASS 后的版本；**本计划从 spec 立论，执行者必须同时读 spec**）。澄清记录：`docs/superpowers/clarifications/cherry-tool-scope.md`。

## Global Constraints

- **唯一装配点**：工具的注册、restriction、guard、事件订阅全部落在**注入回调内的同一个 effect**，其 disposer 是那个 effect 的返回值（B10/§6.2）。
- **teardown 次序即正确性**：① 先退订全部事件（或先置 `torn-down` 标志使重算短路）⇒ ② 再释放注册 ⇒ ③ 再释放全部 restriction ⇒ ④ 最后释放 guard；同一次 teardown **一并作废**判定缓存 / 规范化路径映射 / 解析状态 / `pathUnmatched` / 已装层记录。
- **restriction 只装 `agent.ctx`**；在插件根 ctx 或注入回调的 `agentCtx` 上调用会抛 `tools.restrict() requires a scoped context (agent.ctx)`。**只用 `deny`、绝不用 `allow`**。
- **`deny` 的观测源**：**无参全局视图** `ctx.tools.schemas()` ∩ `CHERRY_TOOL_NAMES`；**禁止** `schemas(agent)`（已被 `layers.every(admits)` 过滤，自引用会把已隐藏的工具放回去）。
- **空集语义**：目标 deny 为空集 ⇒ **只释放、不安装**；观测集合为空（工具尚未注册）⇒ **绝不提交空 `deny`**（会装成 no-op 层，被 guard 误读成"已隐藏"），但既有层的释放照常。
- **每 agent 任一刻只允许一层**本插件的 restriction；换层一律"**先装新、后释放旧**"（restriction 取交集，叠加不可恢复）。
- **同步判定**：guard、restriction 安装与 `agent/created` 监听器**只读缓存**，绝不在同步窗口里 `await`；缓存未命中即 fail-closed（不可见）并触发重算。
- **默认都不给**：文档不存在 ⇒ `mode:'selected'` + 空列表 ⇒ 谁都不给；文档读不出/字段非法 ⇒ 落到严格度序（`selected`+空 > `selected`+非空 > `global`）**更严**的一侧，**绝不**静默变成全局。
- **稳定错误码**（字符串常量，不得往 `error` 槽位塞对象）：`invalid-scope`(400) / `missing-expected-revision`(400) / `scope-revision-conflict`(409) / `workspace-list-unavailable`(503) / `scope-version-unsupported`(503)。
- **作用域文档**：`$DSH_HOME/cherry-remote/scope.json`，0600，原子写（`.tmp` + fsync + chmod + rename），`revision` 单调递增；**权威态在内存**，写盘仅作持久化。
- **设置页与 `/cherry-remote/api` 不受范围约束**（被排除的工作区必须能自救与配对，D9）。
- 改 `src/` 后**必须 `npm run build`**、改 `ui/` 后**必须 `npm run build:client`**，并把重建后的 `dist/`（或 `lib/client.js`）**放进同一个 commit**——`tests/unit/artifactFreshness.test.ts` 用 `git show HEAD:<产物>` 与"当前源码的重建结果"逐字节比对，源码提交而产物没提交就红；新增测试文件必须**同时**登记进 `tsconfig.json` 的 `exclude` 与 `tsconfig.ui.json` 的 `include`（或反之），否则 `tests/unit/projectCoverage.test.ts` 变红。
- 文案只说"**本插件未遮蔽**这些工具"，**不得**声称"模型一定能看到 / 一定能调用"（上游 `allow` 型过滤可能整体遮蔽，那是接受的行为，B15）。
- 测试命令：单文件 `npx vitest run <path>`；全量门禁 `npm run typecheck && npm test`；构建 `npm run build && npm run build:client`。
- **同一文件同一时刻只能有一个写者**：见文末「文件写者矩阵」，执行时按它串行化子代理。

## Review Focus

spec 未逐条测试、但最可能咬到真实用户的五类输入（每条都已在拥有它的 task 里落成断言）：

1. **`restrict()` 的入参形状**——空 `deny` 会装成"对任何名字都放行的 no-op 层"，而本插件的 guard 是"层在 ⇒ 拒绝"，于是**工具可见却被拒**：夹具必须记录**每一次** `restrict` 入参，断言从未出现 `{deny: []}`（Task 5 ①）。
2. **依赖卸载 → 重挂循环**（HMR / 重载 / 宿主依赖重启）——注册与隐藏必须同生共死，卸载后任一时刻不得存在"已注册未隐藏"，重挂后不得叠加第二层、不得抛 `already registered`，释放动作自身发出的 `tools/change` 不得把层装回来（Task 4 ④⑤）。
3. **并发保存**——两个携带同一基准 revision 的 `PUT` 同时到达：校验与写入之间不得有 `await`，否则后写静默覆盖先写（Task 7 ⑦）。
4. **路径同一性**——符号链接 / 大小写 / 拼写差异，以及无 `cwd` 的会话、注册表里根本没有的目录：判定必须只有一套契约（规范化后相等），老宿主如实退化，且"勾了却没工具"必须能从诊断看出是**路径对不上**（Task 3 ②③④ + Task 7 ⑩）。
5. **上游 `allow` 遮蔽被误报成本插件故障**——子代理等上游把 `cherry_*` 整体遮蔽时，guard 不得拒绝、不得报 degraded、文案不得声称"模型可见"（Task 5 ⑦ + Task 8 ⑦）。

---

### Task 1: 14 个工具名的单一常量 + 契约断言（B11）

**Files:**
- Modify: `src/tools.ts`（新增导出常量；`registerCherryTools` 附近加"名单来源"注释）
- Test: `tests/contract/contract.test.ts`（追加一个 `describe`）

**Interfaces:**
- Produces: `export const CHERRY_TOOL_NAMES: readonly string[]`（顺序固定：`cherry_devices`, `cherry_agents`, `cherry_workspaces`, `cherry_sessions`, `cherry_read`, `cherry_events`, `cherry_create`, `cherry_send`, `cherry_wait`, `cherry_interactions`, `cherry_respond`, `cherry_cancel`, `cherry_pair`, `cherry_unpair`）
- 后续 task 消费它：可见性（Task 5 的 `deny` 交集）、guard 的理由、诊断、契约测试。

- [ ] **Step 1: 写失败测试**——`tests/contract/contract.test.ts` 追加：① `CHERRY_TOOL_NAMES` 长度 14、无重复（`new Set(...).size === 14`）、全部以 `cherry_` 开头；② 用收集型假 `ctx.tools`（`tests/integration/toolsRead.test.ts:42` 的 `makeCtx` 同形）跑 `registerCherryTools`，断言**实际注册的名字集合与常量集合双向差集为空**（漏一个或写错一个名字都必须红）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/contract/contract.test.ts`，预期 FAIL（`CHERRY_TOOL_NAMES` 未导出）。
- [ ] **Step 3: 实现**——在 `src/tools.ts` 导出该常量（`as const` 亦可，但导出类型标 `readonly string[]`），并在 `registerCherryTools` 上方写明：**这是可见性 / guard / 诊断 / 契约测试的唯一名单来源**，`CherryToolEngine.definitions()` 与它漂移由契约测试拦截。
- [ ] **Step 4: 运行确认通过**——同命令，预期 PASS。
- [ ] **Step 5: 重建产物 + 提交**——`npm run build` ⇒ `git add src/tools.ts tests/contract/contract.test.ts dist && git commit -m "feat(scope): single source of truth for the 14 cherry_* tool names"`。**改了 `src/` 就必须把重建后的 `dist/` 放进同一个 commit**：`artifactFreshness.test.ts` 拿 `git show HEAD:dist/…` 与"当前源码的重建结果"逐字节比，源码提交而产物不提交 ⇒ 该测试红。

---

### Task 2: 作用域文档：解析、严格度序、原子写、`degraded` 集合、写侧护栏（§6.1 前半 + B9/B14/B16 的存储侧）

**Files:**
- Create: `src/atomicFile.ts`（从 `deviceStore.ts` 的 `persistArchive` 抽出可复用的原子写）
- Modify: `src/deviceStore.ts`（`persistArchive` 改为调用它；**行为不变**，其既有测试即安全网）
- Create: `src/toolScope.ts`
- Test: `tests/unit/toolScopeDoc.test.ts`（新）、`tests/unit/deviceStore.test.ts`（保持全绿，不新增断言）

**Interfaces:**
- Produces（后续 task 全部消费这些名字，不得改名）：
  - `export function writeFileAtomicSync(file: string, text: string, mode = 0o600): void`
  - `export const SCOPE_DOC_VERSION = 1`
  - `export type ScopeMode = 'global' | 'selected'`
  - `export interface ScopeDoc { version: number; revision: number; updatedAt: string; mode: ScopeMode; workspaceIds: string[] }`
  - `export const DEFAULT_SCOPE: ScopeDoc`（`{version:1, revision:0, mode:'selected', workspaceIds:[]}`）
  - `export type DegradedSource = 'install' | 'workspace-list' | 'visibility-only' | 'scope-version' | 'path-normalization'`
  - `export interface DegradedNote { source: DegradedSource; reason: string }`
  - `export interface ScopeWorkspace { id: string; title: string; path: string; sessionIds: readonly string[] }`
  - `export function toScopeWorkspace(raw: unknown): ScopeWorkspace | undefined`（边界归一：`id` 一律 `String(...).trim()`，无可用 id 或 path 则 `undefined`；`sessionIds` 非数组即 `[]`）
  - `export function normalizeWorkspaceId(value: unknown): string`（`String(value).trim()`）
  - `export function isVisible(doc: Pick<ScopeDoc,'mode'|'workspaceIds'>, workspaceId: string | undefined): boolean`
  - `export function parseScopeDoc(raw: string): { doc: ScopeDoc; problem?: 'parse' | 'version-unsupported' }`
  - `export interface SaveResult`：`{ ok: true; doc: ScopeDoc; pruned: string[] }` | `{ ok: false; status: 400 | 409 | 503; error: string; message: string }`
  - `export class ToolScopeState`，构造 `new ToolScopeState({ file, log? })`，本 task 实现的方法：`load()`、`doc()`、`degraded()`、`noteDegraded(note)`、`host()`、`setHost(next)`、`setWorkspaces(list | undefined)`、`workspaces()`、`staleWorkspaceIds()`、`save(body: unknown, expectedRevision: unknown): SaveResult`、`layer(agentId)`、`setLayer(agentId, layer)`、`clearLayer(agentId)`、`invalidateDerived()`
  - `export interface ScopeHostState { state: 'pending' | 'unsupported' | 'ready'; capable: boolean; reason: string }`
  - `export interface MountedLayer { deny: readonly string[]; reason: string }`
- Consumes：Task 1 的 `CHERRY_TOOL_NAMES`（本 task 只需 `deny` 交集在 Task 5 用到，这里不引入）。

- [ ] **Step 1: 写失败测试**——`tests/unit/toolScopeDoc.test.ts`：
  ① 文件不存在 ⇒ `doc()` 等于 `{version:1, revision:0, mode:'selected', workspaceIds:[]}`（D3，默认都不给）；`load()` 不抛。
  ② `parseScopeDoc`：合法 JSON ⇒ 无 `problem`；缺字段 / 类型错 / `mode:'nope'` ⇒ `problem:'parse'` 且 `doc` 落到**严格侧**（`selected` + 空列表，B9）；`{"version":2,...}` ⇒ `problem:'version-unsupported'` 且**不得**被当成"用户空选"（判定口径同严格侧，但 `load()` 必须追加 degraded 标注 `scope-version`，reason 含"文档版本高于本插件支持"）。
  ③ `isVisible`：`global` ⇒ 任意 id（含 `undefined`）可见（B2）；`selected` + 非空 ⇒ 命中可见、未命中/`undefined` 不可见（D7/B5）；`selected` + 空 ⇒ 全员不可见（B1）。
  ④ id 归一（§6.1 输入契约）：`normalizeWorkspaceId(123) === '123'`、`normalizeWorkspaceId('  W ') === 'W'`；文档里 `'123'` 与注册表的 `123` **判定为同一工作区**；归一后仍不同 ⇒ 不匹配。
  ⑤ 严格度序方向（B9 判据）：同一组工作区下，可见集合满足 `selected+[]` ⊆ `selected+[W]` ⊆ `global`。
  ⑥ `degraded` 集合语义：同源两次 `noteDegraded` ⇒ 仍**一条**且 reason 为**最新**；异源（`install` / `workspace-list` / `visibility-only` / `scope-version`）⇒ **四条并存**；空集合 = 无降级（`degraded()` 返回 `[]`）。
  ⑦ 写侧（§6.3 语义，状态层负责）：`save({mode:'selected',workspaceIds:['W','GONE']}, 0)` 在 `setWorkspaces([W])` 后 ⇒ `{ok:true, pruned:['GONE']}`、`doc().revision === 1`、文档里没有 `GONE`、`mode` 未变；再存一次 ⇒ revision 2（单调 +1）；`expectedRevision` 不匹配 ⇒ `{ok:false,status:409,error:'scope-revision-conflict'}` 且 `doc()` **一位不动**；`expectedRevision === undefined` ⇒ 400 `missing-expected-revision`；`{mode:'nope'}` / `{workspaceIds:'x'}` ⇒ 400 `invalid-scope`；`setWorkspaces(undefined)`（列表读不到）⇒ 503 `workspace-list-unavailable`、不修剪、`staleWorkspaceIds()` 为 `[]`、degraded 含 `workspace-list`；`version:2` 文档在盘上 ⇒ 503 `scope-version-unsupported`、不落盘；写盘后 0600 且无 `.tmp` 残留，`staleWorkspaceIds()` 返回注册表外的 id 并随修剪变空（B14）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/unit/toolScopeDoc.test.ts`，预期 FAIL（模块不存在）。
- [ ] **Step 3: 实现**——`src/atomicFile.ts` 抽出 `persistArchive` 的写法（`mkdirSync(dirname)` → `openSync(temp,'w',mode)` → `writeSync` → `fsyncSync` → `closeSync` → `chmodSync(temp,mode)` → `renameSync`，rename 失败时尽力 `unlinkSync(temp)` 再抛）；`deviceStore.ts` 改为调用它并保持原有注释/行为。`src/toolScope.ts` 按上面的签名实现：内存态为唯一权威（`load()` 只在 `apply()` 时读一次盘）、`save()` **同步**完成"校验 → 修剪 → revision+1 → 落盘 → 更新内存"，全程无 `await`（§6.3 临界区前提）。`save()` 的拒绝优先级固定：`version-unsupported`（503）> 列表降级（503）> 字段非法（400）> revision 缺失（400）> revision 冲突（409）——**先决状态**优先于请求体校验，测试按此顺序断言。
- [ ] **Step 4: 运行确认通过**——`npx vitest run tests/unit/toolScopeDoc.test.ts tests/unit/deviceStore.test.ts`，预期全 PASS。
- [ ] **Step 5: 门禁**——`npm run typecheck`（`src/atomicFile.ts` 被 `tsconfig.json` 的 `src` 覆盖，无需登记）。
- [ ] **Step 6: 重建产物 + 提交**——`npm run build` ⇒ `git add src/atomicFile.ts src/deviceStore.ts src/toolScope.ts tests/unit/toolScopeDoc.test.ts dist && git commit -m "feat(scope): the scope document — strictness order, atomic write, degraded set"`（产物与源码同 commit，理由同 Task 1 Step 5）。

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
  - `export interface WorkspaceRegistryLike { list(): unknown; resolveByPath?(path: string): Promise<unknown> }`
  - `export interface RebuildSummary { listAvailable: boolean; agents: number; resolved: number; unresolved: number; pathUnmatched: number }`
  - `ToolScopeState` 增量：`async rebuild(registry: WorkspaceRegistryLike, agents: readonly ScopeAgentLike[]): Promise<RebuildSummary>`、`judgement(agentId: string): AgentJudgement | undefined`、`pathUnmatched(): ReadonlyArray<{ agentId: string; cwd: string }>`
- 判定规则（spec §4 的两条，**唯一契约**）：`sessionIds.includes(agent.id)` 命中优先；否则在"规范化路径 → workspaceId"映射上做**规范化后相等**查表（**不是**裸 `===`）；两者都不中 ⇒ 无工作区（fail-closed）。`reason` 必须含工作区**标题或 id**（供 guard 直接回显，Task 5 ⑦）。

- [ ] **Step 1: 写失败测试**——`tests/unit/toolScopeJudge.test.ts`：
  ① `sessionIds` 命中优先：agent 的 `cwd` 对不上任何项，但其 id 在某项的 `sessionIds` 里 ⇒ `status:'resolved'` + 该 `workspaceId`（§4 规则一）。
  ② 规则二（规范化后相等，D14 单一契约）：夹具 `resolveByPath` 把 `/w/link` 解析为 `/w/real`，注册表项 `path:'/w/real'`、agent `cwd:'/w/link'` ⇒ `resolved` 命中同一 `workspaceId`（B13"第一轮就有工具"的前提）；裸字符串不同、规范化后相同的两侧断言**同一结果**。
  ③ 老宿主（无 `resolveByPath`）⇒ 退化为**大小写敏感的字符串等价**（不做 realpath）：同义路径**不**命中，此时只剩 `sessionIds`；且必须向 `degraded` 追加 `source:'path-normalization'`（D14 明文要求"该降级在诊断标注"——这是它的承载枚举值，reason 写明"宿主无 resolveByPath，路径匹配退化为大小写敏感字符串等价"），**不得**声称与规范化等价。
  ④ 四值齐备：无 `cwd` ⇒ `no-cwd`；`resolveByPath` 抛错 ⇒ `unresolved`；解析成功但不属任何注册表项 ⇒ `no-match`；命中 ⇒ `resolved`。四种一律 `visible:false`（除命中且 `isVisible` 为真），**`no-match` 另产生一条 `pathUnmatched()`**（含 `agentId` 与 `cwd` 样本）且**不出现在 `degraded()`** 里（§6.1：诊断而非降级）。
  ⑤ 同步可读 + fail-closed：`rebuild()` 未完成时 `judgement(id)` 为 `undefined`，`isVisible` 类判定一律不可见；`rebuild()` 完成后立即可读（**同步查表**，不再 await）。
  ⑥ 原子替换：`rebuild()` 进行中（`resolveByPath` 挂起）读到的仍是**上一代**（不会看到半建映射）；完成后整代切换。
  ⑦ `invalidateDerived()` ⇒ `judgement()` 与 `pathUnmatched()` 清空（teardown 的载体，Task 4 ④ 会用）。
  ⑧ 列表读不到（`list()` 抛错或返回空）⇒ `listAvailable:false`、degraded 追加 `workspace-list`、**全部** agent 判定落 fail-closed（B16 判定侧）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/unit/toolScopeJudge.test.ts`，预期 FAIL（导出/方法不存在）。
- [ ] **Step 3: 实现**——在 `ToolScopeState` 内按"构建新一代（映射 + 判定 + 解析状态 + `pathUnmatched`）→ 一次赋值原子替换"实现；`rebuild()` 是**唯一**允许 async 的地方；`judgement` 只读当代缓存。规范化路径映射的键用 `resolveByPath` 的返回值再 `normalizeWorkspaceId`（去尾斜杠/统一大小写**不做**——realpath 语义已足够，退化路径保持大小写敏感，见 ③）。
- [ ] **Step 4: 运行确认通过**——同命令 PASS；并跑 `npx vitest run tests/unit/toolScopeDoc.test.ts` 确认未回归。
- [ ] **Step 5: 重建产物 + 提交**——`npm run build` ⇒ `git add src/toolScope.ts tests/unit/toolScopeJudge.test.ts dist && git commit -m "feat(scope): canonical-path session-to-workspace judgement with four resolution states"`。

---

### Task 4: 宿主集成与唯一装配点：能力三态、注入门控、注册与隐藏同生共死、teardown 次序（§6.2 + B7/B10/B17）

**Files:**
- Create: `tests/helpers/fakeToolHost.ts`（**复刻 7 条宿主语义的假宿主**，Task 5/6/7 复用）
- Create: `src/toolScopeHost.ts`
- Modify: `src/index.ts`（`apply()` 里创建 `ToolScopeState` + `createToolScopeHost`，并把它交给 HTTP deps；**移除** `apply()` 里对 `registerCherryTools` 的直接调用，改由本子系统在注入回调内调用）
- Test: `tests/integration/toolScopeHost.test.ts`（新）

**Interfaces:**
- Produces：
  - `export interface ScopeHostContext { tools: {...}; inject?<T>(keys: readonly string[], cb: (ctx: T) => void | (() => void)): void; effect?(cb: () => () => void): unknown }`
  - `export interface ScopeHostDeps { scope: ToolScopeState; names: readonly string[]; registerTools: () => () => void; recheckDelaysMs?: readonly number[]; log?: (message: string, error?: unknown) => void }`
  - `export interface ToolScopeHost { mount(ctx: ScopeHostContext): () => void; refresh(): RefreshSummary | undefined; state(): ScopeHostState; dispose(): void }`
  - `export function createToolScopeHost(deps: ScopeHostDeps): ToolScopeHost`
  - `export interface RefreshSummary { agents: number; installed: number; released: number; skipped: number }`
- 假宿主（`tests/helpers/fakeToolHost.ts`）**必须复刻** spec §7 的七条，否则相关断言恒真而空过：
  ① `restrict({})`（两键全缺）**抛**；② `restrict({deny: []})` **不抛**，装入"对任何名字都放行的 no-op 层"，并**记录每次入参**；③ 未知名字 / 作用域局部名 / 保留 `run_code` ⇒ 抛；④ 跨层取交集（`layers.every(admits)`）；⑤ `schemas()` 无参 = 全局视图、`schemas(agent)` = 已按该 agent 的 restriction 过滤后的视图；⑥ 在非作用域 ctx（插件根 ctx / 注入回调的 ctx）上调 `restrict()` **抛** `tools.restrict() requires a scoped context (agent.ctx)`；⑦ `guard()` 的安装与释放在**两侧都不发** `tools/change`，`register()` 与 `restrict()` 在**安装与释放两侧都发**。
- Consumes：Task 2/3 的 `ToolScopeState`。

- [ ] **Step 1: 写失败测试**——先写假宿主（Step 3 与它同时落地，测试引用它），再写 `tests/integration/toolScopeHost.test.ts`：
  ① `pending`：未调用 `mount`（注入回调未到达）⇒ 一个工具都没注册、`state() === {state:'pending', capable:false}`、`reason` 是**中性等待**措辞（断言**不含**"不支持"/"unsupported"）。
  ② `unsupported`：夹具删掉 `ctx.tools.restrict` ⇒ 一个工具都没注册、`reason` 含 `tools.restrict`（**按真实缺因**，不得硬编码"agents 服务不可用"）、`degraded()` 不含 `visibility-only`（B7①）。
  ③ `ready`：静态能力齐备 + 注入到达 ⇒ 注册恰好 14 个、对全部 live agent 装了 restriction、`state()==='ready'`、`capable===true`（B7④）。
  ④ **依赖卸载**（调用 effect disposer）⇒ 注册、全部 restriction、guard、订阅**同时消失**（夹具分别计数，四者都归零）；卸载后**任一时刻**不存在"已注册未隐藏"；夹具在释放时发出 `tools/change` ⇒ **不产生重算、不装回无主层**（`torn-down` 短路）；`scope.judgement()`/`layer()` 已作废（R-c 的载体）；重算计数不发生。
  ⑤ **依赖重挂** ⇒ 注册 / guard / restriction **同时恢复**、不抛 `already registered`、每个 agent 仍只有**一层**（夹具记录每 agent 层数恒 ≤ 1）（B10）。
  ⑥ `guard` 缺失（夹具不提供 `guard`）⇒ 照常注册 14 个 + 照常装层 + `degraded()` 追加 `visibility-only`，**且不拒绝注册**（B17）。
  ⑦ 拒绝的兜底：夹具令 `registerTools()` 返回的注册 disposers 为 3 个 ⇒ teardown 时三个都调用（释放计数器 = 3）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/integration/toolScopeHost.test.ts`，预期 FAIL（`src/toolScopeHost.ts` 不存在）。
- [ ] **Step 3: 实现**——`createToolScopeHost` 不作状态所有（状态归 `ToolScopeState`）；`mount(ctx)` 内：`ctx.inject(['agents','workspaceRegistry'], (agentCtx) => agentCtx.effect(() => { … }))`，effect 内**次序固定**：探能力 ⇒ `ready` 才 `registerTools()` 并把**每个** disposer 收进本 effect ⇒ 对全部 live agent 装 restriction + 在**普通 ctx** 上装**一层** guard ⇒ 订阅 `agent/created` / `agent/disposed` / `tools/change` ⇒ **返回合并 disposer**（退订/置 `torn-down` ⇒ 释放注册 ⇒ 释放 restriction ⇒ 释放 guard ⇒ `scope.invalidateDerived()`）。`pending`/`unsupported` 都要把三态写进 `scope.setHost(...)` 且**什么都不注册**。`src/index.ts` 的 `apply()`：`const scope = new ToolScopeState({ file: join(dataDir,'scope.json') }); scope.load()`；HTTP 注册**照旧无条件**（含 pending/unsupported）；`registerHttpApi(ctx, deps)` 的 `deps` 增加 `scope` 与 `refreshScope: () => host.refresh()`；工具注册改为传 `registerTools: () => registerCherryTools(ctx, deps)`。
- [ ] **Step 4: 运行确认通过**——`npx vitest run tests/integration/toolScopeHost.test.ts tests/integration/toolsRead.test.ts tests/integration/httpApi.test.ts`，预期全 PASS（后两者证明既有装配没被改坏）。
- [ ] **Step 5: 门禁**——`npm run typecheck`（`tests/helpers/fakeToolHost.ts` 落在 `tests` 里、被 server 项目覆盖；它不是 `*.test.ts`，不会被 vitest 收集）。
- [ ] **Step 6: 重建产物 + 提交**——`npm run build` ⇒ `git add src/toolScopeHost.ts src/index.ts tests/helpers/fakeToolHost.ts tests/integration/toolScopeHost.test.ts dist && git commit -m "feat(scope): one assembly point — registration, restriction and guard co-lifecycle"`。

---

### Task 5: 安装/释放判据、空集语义、guard 镜像、安装失败路径（§6.2 动作条 + B6/B12/B18/B15）

**Files:**
- Modify: `src/toolScopeHost.ts`（同一文件，**必须在 Task 4 之后单独执行**）
- Test: `tests/integration/toolScopeHost.test.ts`（同一文件追加 `describe`，串行）

**Interfaces:**
- Consumes：Task 4 的 `createToolScopeHost` / 假宿主 / `MountedLayer`。
- 关键不变量（实现时必须成立）：**层在 ⇔ 记录在**——`restrict()` 返回即层已装入，记录写在同一同步块内、**先装层后写记录**；释放侧**同步清除记录、再调用 disposer**；换层时记录在同一同步块内整体替换。

- [ ] **Step 1: 写失败测试**——追加断言：
  ① **`deny` 的入参**：夹具记录每次 `restrict` 入参 ⇒ 每次都是 `{deny:[...]}`，且各项 = `schemas()`（无参全局视图）∩ `CHERRY_TOOL_NAMES`，逐名相等；**从未**出现 `{deny: []}`、从未出现 `allow` 键（B12①/B18③）。
  ② **观测集合为空**：在注册前让无参 `schemas()` 取不到我们的名字 ⇒ 不调用 `restrict`（无 no-op 层）、不抛错；注册完成后由补齐**恰好装一层**完整交集（`restrict` 调用次数 = 1）；若该 agent 已有旧层，该旧层照常释放（"不阻止既有层的维护"）（B18③④）。
  ③ **目标集合变空**（`global`，或该 agent 判定为不在范围内）⇒ **只释放**旧层、不安装；释放夹具重新计算 agent 视图后 `cherry_*` **回到**该 agent 的工具表，且无层残留（B18①/B2）。
  ④ **先装新、后释放旧**：夹具记录同一 agent 上的动作序列，断言 `install(new)` 严格早于 `release(old)`；任一时刻层数 ≤ 1；`release` 后 `layer(agent)` 为 `undefined`（B18②/B10）。
  ⑤ **幂等短路**：目标 deny 与当前层逐名相同 ⇒ `restrict` 不被再次调用（§4 ②）。
  ⑥ **安装失败路径**：夹具令 `restrict` 抛错（含"两个时刻错位 ⇒ 交集仍含未知名而抛错"一例）⇒ 不抛到调用方、不静默 ⇒ `degraded()` 追加 `install`（reason 可读），紧随其后的 `tools/change` / 配置保存**重试并成功**（B12②④）。
  ⑦ **guard 是已装层的执行侧镜像**：层在 ⇒ 拒绝且返回字符串**含**工作区标题或 id；层不在 ⇒ 放行；即便把判定缓存清空 / 令 `judgement()` 返回矛盾值（夹具注入），裁决仍与层状态一致——不存在"可见却被拒"或"已隐藏却放行"（B6/G4/G1）。
  ⑧ **上游 `allow` 遮蔽不是故障**：夹具额外叠加一层上游 `allow` 把 `cherry_*` 排除 ⇒ `guard` **不**因此拒绝、`degraded()` **不**新增条目、不写错误日志（B15 的 guard 侧）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/integration/toolScopeHost.test.ts`，预期新增断言 FAIL（尚未实现空集/装层逻辑）。
- [ ] **Step 3: 实现**——把"算目标集合 ⇒ 定动作 ⇒ 记录与层的原子对"写成 `installOrRelease(agent)`：目标为空 ⇒ 只释放；非空且观测集为空 ⇒ 什么都不做（但释放既有层）；非空 ⇒ 先装新后释放旧；失败 ⇒ `noteDegraded({source:'install'})` + 标脏重试。guard 的注册在普通 ctx 上只做一次（幂等），其函数体**只**读 `scope.layer(execution.agent.id)`。
- [ ] **Step 4: 运行确认通过**——同命令 PASS；`npx vitest run tests/unit/toolScopeDoc.test.ts tests/unit/toolScopeJudge.test.ts` 未回归。
- [ ] **Step 5: 重建产物 + 提交**——`npm run build` ⇒ `git add src/toolScopeHost.ts tests/integration/toolScopeHost.test.ts dist && git commit -m "feat(scope): empty-set semantics, install-failure path and the layer mirroring guard"`。

---

### Task 6: 重入闸（合并/置脏补跑）、有界复检、同步判定（§4 硬约束 + D14 + B13）

**Files:**
- Modify: `src/toolScopeHost.ts`（同一文件，**必须在 Task 5 之后单独执行**）
- Test: `tests/integration/toolScopeHost.test.ts`（同一文件追加 `describe`，串行）

**Interfaces:**
- Consumes：Task 4/5 的编排与假宿主；`ScopeHostDeps.recheckDelaysMs`（默认 `[250, 2000]`，测试注入小值 + `vi.useFakeTimers()`）。
- Produces：`RefreshSummary` 的字段语义（`skipped` = 幂等短路跳过的 agent 数），重算计数口径供 Task 7 断言"保存 ⇒ 同步重算"。

- [ ] **Step 1: 写失败测试**——追加断言：
  ① **合并 / 置脏补跑**：夹具在重算体执行期间再发一次 `tools/change` ⇒ 本轮结束前**补跑一次**（重算轮数 = 2），不递归放大（每 agent 每轮至多重装一次）。
  ② 重算期间新建 agent（`agent/created`）⇒ 其**首次安装**落在补跑轮内（不丢；§4 的"新 agent 首次安装永不弃权"）。
  ③ **唯一弃权点**：teardown 期间到达的 `tools/change` 与 `agent/created` ⇒ 不触发重算、不装层（R-a）。
  ④ **有界复检**：`unresolved` ⇒ 按 `recheckDelaysMs` 各排一次（两个定时器）；两次后仍 `unresolved` ⇒ 不再排（定时器总数 = 2）；`no-cwd` / `no-match` / `resolved` ⇒ **零定时器**（无空转）；夹具断言"复检只对 `unresolved` 启动"（D14）。
  ⑤ 复检只修正"暂时不可见"：夹具先给缺失的 `sessionIds` 投影、在第一次复检时刻补上 ⇒ 复检后该 agent 装层（B13 的 `sessionIds` 滞后补偿）；`cwd` 缺失的会话**不因复检翻盘**（仍不可见）。
  ⑥ **同步返回**：夹具令 `rebuild()` 挂起（`resolveByPath` 永不 resolve）⇒ `agent/created` 监听器**立即同步返回**、建会话不失败、当轮按 fail-closed 处理；`rebuild()` 完成后由补跑轮纠正（不丢收敛）。
  ⑦ teardown 清掉未触发的复检定时器（无泄漏）：`vi.getTimerCount() === 0`。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/integration/toolScopeHost.test.ts`，预期新增断言 FAIL。
- [ ] **Step 3: 实现**——重算入口统一走一个"合并闸"：进行中 ⇒ `dirty = true` 返回；结束时若 `dirty` ⇒ 再跑一轮（不递归）；`tornDown` ⇒ 直接返回。`agent/created` 监听器只做同步判定 + 装层（或 fail-closed），`unresolved` 时才 `setTimeout` 有界复检；所有定时器登记在 effect 的 disposer 里一并清除。
- [ ] **Step 4: 运行确认通过**——同命令 PASS。
- [ ] **Step 5: 重建产物 + 提交**——`npm run build` ⇒ `git add src/toolScopeHost.ts tests/integration/toolScopeHost.test.ts dist && git commit -m "feat(scope): coalescing re-entrancy gate, bounded recheck and synchronous judgement"`。

---

### Task 7: HTTP 面 `GET/PUT /cherry-remote/api/scope`（§6.3 + B4/B14/B16）

**Files:**
- Modify: `src/httpApi.ts`（在既有的 `handleRequest` 分发表加 `first === 'scope'` 分支；`writeError` 原样复用）、`src/index.ts`（`assemblyDeps()` 暴露 `scope` 与 `refreshScope`）
- Test: `tests/integration/scopeHttpApi.test.ts`（新；复用 `tests/helpers/fakeToolHost.ts` 与 `httpApi.test.ts` 的 `FakeWebServer` 风格）

**Interfaces:**
- Consumes：`ToolScopeState` 的 `doc()/workspaces()/staleWorkspaceIds()/pathUnmatched()/host()/degraded()/save()`、`ToolScopeHost.refresh()`、既有 `isTrustedWebRequest` 围栏与 `writeError(res, status, error, message?)`。
- Produces（响应形状逐字）：
  - `GET /cherry-remote/api/scope` → `{ scope: {mode, workspaceIds, revision}, workspaces: [{id,title,path}], staleWorkspaceIds: string[], pathUnmatched: [{agentId, cwd}], host: {state, capable, reason, degraded: [{source, reason}]} }`
  - `PUT /cherry-remote/api/scope` → 成功 `{ scope: {…规范化文档}, pruned: string[] }`；失败 `{error, message?}`（`writeError` 形状）
- `CherryHttpDeps` 增量：`scope: ToolScopeState`、`refreshScope(): RefreshSummary | undefined`。

- [ ] **Step 1: 写失败测试**——`tests/integration/scopeHttpApi.test.ts`：
  ① `GET` 形状逐字段断言（含 `degraded` 为**数组**、空数组 = 无降级；`host.capable === (host.state === 'ready')`）。
  ② 同源围栏：坏 `Origin` ⇒ 403 `forbidden`（沿用既有围栏，不新开例外）。
  ③ `PUT` 成功：`revision` 单调 +1、`pruned` 列出被修剪 id、返回规范化文档，且**同步**调用 `refreshScope()`——夹具记录"save 完成 → refresh 被调用"的先后（同一同步段内，无 `await` 间隔）（B4/D10）。
  ④ `400 invalid-scope`：非法 `mode`、`workspaceIds` 非字符串数组 ⇒ 结构化错误、已存状态一位不动。
  ⑤ `400 missing-expected-revision`：请求体缺 `expectedRevision` ⇒ 拒绝（**有意的加严**，先例对 `undefined` 不抛错）。
  ⑥ `409 scope-revision-conflict`：`error` 是**字符串常量**、`message` 含当前 revision；不写入、不改动已存状态。
  ⑦ **并发**：两个携带**同一基准 revision** 的 `PUT` 并发提交 ⇒ 恰有一个成功且新 revision 单调 +1，另一个得到 `scope-revision-conflict`（临界区内无 `await`，不存在双双通过后的静默覆盖）。
  ⑧ `503 workspace-list-unavailable`：`list()` 不可用夹具 ⇒ 拒绝、不修剪、已存 `workspaceIds`/`mode` 一位不动、`GET.staleWorkspaceIds` 为空数组且带 `workspace-list` 标注（B14/B16 写侧护栏）。
  ⑨ `503 scope-version-unsupported`：盘上 `version:2` 文档 ⇒ 拒绝、不修剪不落盘、`GET.host.degraded` 含 `scope-version`。
  ⑩ `pathUnmatched` 传输通道：造"工作区已勾选、但该会话 `cwd` 规范化后对不上任何注册表项"的 agent ⇒ `GET.pathUnmatched` 含其 `agentId` 与 `cwd` 样本，且**不**出现在 `host.degraded` 里（非 degraded，不得与"已失效选择"互相推导）。
  ⑪ `host.state === 'pending'` 时 `GET` 照常 200（D9：被排除的工作区能自救），`PUT` 也能成功（范围写入不依赖宿主注入到达）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/integration/scopeHttpApi.test.ts`，预期 FAIL（路由 404）。
- [ ] **Step 3: 实现**——在 `handleRequest` 里加 `first === 'scope' && match.segments.length === 1` 分支：`GET` ⇒ 组装上面的响应（工作区列表**由插件侧**投影下发）；`PUT` ⇒ 读 JSON body（沿用既有 body 读取方式）⇒ `scope.save(body, body?.expectedRevision)` ⇒ `ok` 时**同步** `deps.refreshScope?.()` 再回 `{scope, pruned}`，否则 `writeError(res, status, error, message)`。`assemblyDeps()` 增加 `scope` 与 `refreshScope`。
- [ ] **Step 4: 运行确认通过**——`npx vitest run tests/integration/scopeHttpApi.test.ts tests/integration/httpApi.test.ts`，预期全 PASS（后者证明既有路由未回归）。
- [ ] **Step 5: 重建产物 + 提交**——`npm run build` ⇒ `git add src/httpApi.ts src/index.ts tests/integration/scopeHttpApi.test.ts dist && git commit -m "feat(scope): GET/PUT /cherry-remote/api/scope with stable error codes"`。

---

### Task 8: 设置页「启用范围」面板（§6.4 + B8/B14–B17 的 UI 侧）

**Files:**
- Create: `ui/src/ToolScopePanel.tsx`
- Modify: `ui/src/api.ts`（`getScope()` / `putScope(body)`，复用 `ApiError` 的 `{status, code, message}`）、`ui/src/types.ts`（`ScopeDoc`/`ScopeResponse`/`ScopeHostState`/`DegradedNote` 的 UI 侧类型）、`ui/src/App.tsx`（在设备列表上方挂载面板）
- Modify: `tsconfig.ui.json`（`include` 加 `tests/unit/uiScopePanel.test.ts`）、`tsconfig.json`（`exclude` 加同一路径）
- Test: `tests/unit/uiScopePanel.test.ts`（新，`// @vitest-environment jsdom`，沿用 `tests/unit/ui.test.ts` 的 testing-library 风格）

**Interfaces:**
- Consumes：Task 7 的响应形状与错误码；`ApiError.status/code/message`。
- Produces：`export function ToolScopePanel(props: { client?: ScopeClient }): JSX.Element`（`ScopeClient` 默认真实 `fetch` 包装，测试注入假客户端——与 `App` 的 `eventSourceFactory` 同一套接缝风格）。

- [ ] **Step 1: 写失败测试**——`tests/unit/uiScopePanel.test.ts`：
  ① 渲染模式单选 + 工作区多选（标题 + 路径）；空态文案**按模式区分**（D11 逐字）：`selected` + 未勾 ⇒ 含"此状态下 `cherry_*` 工具不会出现在任何会话里"；`global` + 未勾 ⇒ 含"这些工具在所有工作区都可用"且**不含**前一句。
  ② `unsupported` ⇒ 顶部只读告警 + **按真实缺因**的原因（夹具给"缺 tools.restrict" ⇒ 文本含 `tools.restrict`）+ **禁用保存**；`pending` ⇒ **只**中性等待提示（断言文本**不含**"不支持"）、**不禁用**保存、配对区（`PairingWizard`）仍渲染（D9）。
  ③ 已失效选择：`staleWorkspaceIds` 非空 ⇒ 渲染"已失效（工作区已删除）"分组 + 一键清除；点击后发出 `PUT` 且界面据 `pruned` 回显（**不得**显示"校验失败"）。
  ④ 列表不可用（`degraded` 含 `workspace-list`）⇒ 禁用保存并显示原因；`global` 模式下仍显示"注册表列表当前读不到"。
  ⑤ 降级标注**逐条**渲染：`degraded` 三条（`install`/`workspace-list`/`visibility-only`）⇒ 三条文本**同时**在文档里（异源并存，不得只渲染最后一条）。
  ⑥ 保存失败按**稳定错误码**分流：`scope-revision-conflict` ⇒ 冲突提示；`scope-version-unsupported` ⇒ 含"版本高于本插件支持"且**禁用保存**、**不得**出现"请重新读取后再保存"；`invalid-scope`/`missing-expected-revision`/`workspace-list-unavailable` ⇒ 各自的提示；**所有失败不改动本地状态**（断言勾选与模式未被重置）。
  ⑦ 文案边界：面板文本**不得**出现"模型一定能看到"/"一定能调用"；只声称"本插件未遮蔽"（B15）。
  ⑧ `pathUnmatched` 非空 ⇒ 逐条列出 `agentId` 与 `cwd` 样本并说明三者不可区分，且**不**与"已失效选择"分组合并（§6.4）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/unit/uiScopePanel.test.ts`，预期 FAIL（模块不存在 / 项目未登记 ⇒ 先登记再跑，见 Step 3）。
- [ ] **Step 3: 实现**——先登记 `tsconfig.ui.json` 的 `include` 与 `tsconfig.json` 的 `exclude`（否则 `projectCoverage` 门禁变红且该文件被 `tsc` 静默跳过），再写面板组件；`api.ts` 的 `putScope` 必须把非 2xx 的 `{error, message}` 原样抛成 `ApiError`（面板据 `error` 分流）。
- [ ] **Step 4: 运行确认通过**——`npx vitest run tests/unit/uiScopePanel.test.ts tests/unit/ui.test.ts tests/unit/projectCoverage.test.ts`，预期全 PASS。
- [ ] **Step 5: 门禁**——`npm run typecheck`（两个项目都要过）+ `npm run build:client`（客户端产物是 `dist`/`lib` 之外的另一半，`clientBundle.test.ts` 会校验）。
- [ ] **Step 6: 重建产物 + 提交**——`npm run build:client`（客户端半，产物 `lib/client.js`）⇒ `git add ui/src tsconfig.ui.json tsconfig.json tests/unit/uiScopePanel.test.ts lib && git commit -m "feat(scope): settings panel for the enablement scope"`。

---

### Task 9: 诊断面 + 门禁 + 真机清单（收口）

**Files:**
- Modify: `src/diagnostics.ts`（`DiagnosticsReport` 增 `scope` 段；来源经 `DiagnosticsSources` 注入）、`src/index.ts`（把 `scope` 的读取口接进诊断来源）、`docs/e2e-checklist.md`、`README.md`
- Test: `tests/unit/diagnostics.test.ts`（追加）

**Interfaces:**
- Consumes：`ToolScopeState` 的 `doc()/host()/degraded()/pathUnmatched()/workspaces()`。
- Produces：`DiagnosticsReport.scope = { mode, revision, workspaceIds, host: {state, capable, reason, degraded}, pathUnmatched: [{agentId, cwd}] }`——与 `GET /scope` 的 `host` **同源同值**（同一次读取，不各持副本）。

- [ ] **Step 1: 写失败测试**——`tests/unit/diagnostics.test.ts` 追加：① 报告含 `scope` 段且字段齐全、`capable === (state === 'ready')`；② 与 `/scope` 的 `host` 取自**同一对象/同一次读取**（夹具改一次 `setHost` ⇒ 两处同时变，证明没有第二份副本）；③ `pathUnmatched` 的 cwd 走既有脱敏边界（`sanitizeDiagnostics` 的白名单口径；断言未被白名单允许的字段不会透出）。
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/unit/diagnostics.test.ts`，预期 FAIL（无 `scope` 段）。
- [ ] **Step 3: 实现**——`DiagnosticsSources` 增加可选 `scope?(): {...}`，`buildDiagnostics` 拼装；`src/index.ts` 的 `assemblyDeps()` 提供实现。
- [ ] **Step 4: 运行确认通过 + 全量门禁**——`npm run typecheck && npm test && npm run build && npm run build:client` 全绿；`tests/unit/artifactFreshness.test.ts` 与 `tests/contract/contract.test.ts` 保持绿。
- [ ] **Step 5: 文档**——`docs/e2e-checklist.md` 增真机步骤：**默认谁都没有工具** → 设置页勾选一个工作区并保存 → **进行中的会话**下一轮工具出现 → 取消勾选即时消失 → 无工作区的会话始终没有 → 删除一个已勾选的工作区后设置页显示"已失效"并可一键清除 → 宿主能力 `pending` 时设置页只给中性提示（人为制造：临时移除 `agents` 注入）。`README.md` 增「启用范围」一节（两种模式、默认都不给、`/cherry-remote/api/scope` 两个端点、五个稳定错误码）。
- [ ] **Step 6: 提交**——两个半都已在上一步重建 ⇒ `git add src/diagnostics.ts src/index.ts docs/e2e-checklist.md README.md tests/unit/diagnostics.test.ts dist lib && git commit -m "feat(scope): diagnostics face, e2e checklist and README for the scope feature"`。

---

## 文件写者矩阵（执行时的串行化依据）

| 文件 | 写它的 task（**严格按序，不得并发**） |
| --- | --- |
| `src/tools.ts` | 1 |
| `src/atomicFile.ts` / `src/deviceStore.ts` | 2 |
| `src/toolScope.ts` | 2 → 3 |
| `src/toolScopeHost.ts` | 4 → 5 → 6 |
| `tests/integration/toolScopeHost.test.ts` | 4 → 5 → 6 |
| `src/httpApi.ts` / `src/index.ts` | 4 → 7 → 9（`index.ts` 三次，仍串行） |
| `ui/src/**` / `tsconfig*.json` | 8 |
| `tests/helpers/fakeToolHost.ts` | 4（创建后由 5/6 只读消费） |
| `src/diagnostics.ts` | 9 |

可并行对：Task 1 与 Task 2 的准备（不同文件）；Task 8 与 Task 5/6（`ui/` vs `src/toolScopeHost.ts`）。其余一律串行。

## Self-Review 记录

**1. Spec 覆盖**：B1(T2①/T5③)、B2(T2③/T5③)、B3(T3①②/T5)、B4(T7③)、B5(T2③/T3④)、B6(T5⑦)、B7(T4①②③)、B8(T7⑪/T8②)、B9(T2②)、B10(T4④⑤/T5④)、B11(T1)、B12(T5①⑥)、B13(T3②/T4⑦/T6⑥)、B14(T2⑦/T7③⑧)、B15(T5⑧/T8⑦)、B16(T2⑦/T3⑧/T7⑧/T8④)、B17(T4⑥)、B18(T5①③④)；D14 的四值/有界复检在 T3④/T6④⑤⑥；§6.3 五个错误码在 T2⑦（状态层）与 T7④⑥⑧⑨（传输层）；§6.4 每一条在 T8 都有对应断言；§7 的"假宿主必须复刻的七条"在 T4 的夹具接口里逐条列出。无遗漏项。

**2. Step 扫描**：每个 Step 都是"一个动作 + 可核对的产物"（写断言 / 跑命令看 FAIL / 实现精确签名 / 跑命令看 PASS / 门禁 / 提交）。没有"处理边界情况"这类无判据的步骤；没有把某个函数的完整函数体抄进计划（只给签名、不变量与次序）。

**3. 类型一致性**：`ToolScopeState` / `ScopeDoc` / `DegradedNote` / `AgentJudgement` / `MountedLayer` / `RefreshSummary` / `ScopeHostState` / `ScopeWorkspace` 在 T2/T3 定义一次，T4–T9 只消费；`createToolScopeHost` 与 `ToolScopeHost` 的方法名（`mount` / `refresh` / `state` / `dispose`）在 T4 定义、T6/T7 消费同一批名字；错误码字符串五处出现、写法完全一致。

**4. Review Focus**：五条都已在对应 task 落成断言（见该节脚注的 task 编号），无空条目。

**5. 比例**：spec 793 行，本计划 345 行（自检修正后的实测值）；代码块只出现三次（命令、JSON 形状、假宿主七条语义清单），未把实现抄成代码。

**6. 自检修正记录**：Step 扫描发现 Task 1–9 的提交步骤原本漏了"改源码必须重建产物并放进同一个 commit"这条硬门禁（`artifactFreshness` 拿 HEAD 的产物与当前源码的重建结果比对），已逐条补上并写进 Global Constraints；`git add` 行里一处 `2>/dev/null` 的凑合写法也一并去掉了。

**留给执行者的判断（spec §9 已授权）**：模块内私有结构的形状、面板控件交互（列表 + 复选 / 搜索 / 全选）、诊断字段的具体措辞、`path-normalization` 标注的具体文案、复检间隔的默认值（约束：有界、只对 `unresolved`）。
