# dsh-cherry-bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DSH 插件 `dsh-cherry-bridge`：以官方 remote-protocol 客户端身份连接多台 Cherry Studio 桌面端，DSH agent 经 14 个 `cherry_*` 工具操控其 Agent 会话，附 web 设备管理 UI。

**Architecture:** Cordis bundle（服务端 Node 插件，跑在 dsh 进程内）+ web client（`dsh.client` 注入设置页）。每台 Cherry 桌面一条 Noise XX 加密 WebSocket 常驻连接；自研 JSON-RPC 2.0 客户端层（remote-transport 只导出 Server）；工具面与同源路由 HTTP 面双入口。

**Tech Stack:** TypeScript (Node ≥22.18)、`@cherrystudio/remote-protocol`、`@cherrystudio/remote-transport`、`ws`、`zod@^4.3.4`、vitest、tsdown 构建、React（web client，参照 dsh-mcp-connector 的 ui 构建）。

**Spec:** `docs/superpowers/specs/2026-10-09-cherry-dsh-bridge-design.md`（453 行，4 轮审查后版本——本计划从 spec 立论，执行者须同时读 spec）

## Global Constraints

- 插件 id `cherry-remote`；npm 包名 `dsh-cherry-bridge`；路由前缀 `/cherry-remote/api`（既定值）
- 运行时依赖自带 `ws`（remote-transport 中仅为 devDependency）与 `zod@^4.3.4`（协议包 peerDependency）
- MVP 仅 `ws://` 传输、所有候选地址共享同一 `port`；仅申请 `agent` capability
- 敏感文件 0600（identity 密钥 / 设备档案 JSON）；token/invitationSecret/accessToken/消息内容与 part 文本一律不入日志
- 协议数字不得硬编码：以 `connection.hello` 回报的 `limits`/`heartbeatMs` 为准，缺键回落保守默认；32/4/64 为服务端实现值（无协商通道），以对端 close 1013/1011 为权威信号
- 工具命名：`cherry_*` 短名、无 `_list` 后缀；工具参数以**字面 JSON Schema** 声明（zod 仅用于协议侧与自有持久化数据）
- 同源/回环校验由插件在每条路由自行实施（`isTrustedWebRequest` 式三重判定）

## Review Focus

1. **畸形配对 payload**（非 JSON / `t` 值错误 / 缺 `invitationId` / 超长字符串）→ 结构化错误返回，不抛裸异常 → 测试在 Task 6 Step 1
2. **对端未知通知方法 / 未知错误码**（协议前向演进）→ 忽略 + warn 日志，不崩溃 → 测试在 Task 2 Step 1
3. **工具并发风暴**（agent 并行 10 个 `cherry_send`）→ 队列排队消化，不触发对端 64 req/s 断连 → 测试在 Task 5 Step 1
4. **设备档案文件损坏/被外部删除** → 降级为空库 + warn，不崩溃 → 测试在 Task 4 Step 1
5. **SSE 客户端断开后配对进度推送**→ 订阅清理、无句柄泄漏 → 测试在 Task 9 Step 1

---

### Task 1: 工程脚手架 + ws 适配层（M1 前置门 ½）

**Files:**
- Create: `package.json`、`tsconfig.json`、`tsdown.config.ts`、`src/index.ts`（空插件骨架：`export const name = 'cherry-remote'` + `export const inject = ['tools']` + 空 `apply`）、`src/rpc/wsAdapter.ts`
- Test: `tests/unit/wsAdapter.test.ts`

**Interfaces:**
- Produces: `toRemoteSocket(ws: import('ws').WebSocket): import('@cherrystudio/remote-transport').RemoteSocket`——逐项对齐四语义：`binaryType='arraybuffer'`、ArrayBuffer 二进制帧、`bufferedAmount`、`readyState`

- [ ] **Step 1: 写失败测试**——内存 WebSocket 对（`new WebSocket.Server({ port:0 })` 回环连接）经 `toRemoteSocket` 适配后：收发的二进制帧为 ArrayBuffer 实例；`readyState` 随 open/close 迁移；`bufferedAmount` 透传；`close()` 触发 close 事件
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/unit/wsAdapter.test.ts`，预期 FAIL（模块不存在）
- [ ] **Step 3: 实现适配层**——包装 `ws` WebSocket：转发 open/message(binary)/close/error 事件为 EventTarget 风格、`send` 仅接受 ArrayBuffer/Uint8Array、透传 `bufferedAmount`/`readyState`/`close()`；脚手架文件同步落地（`pnpm`/`npm` scripts：`test`=vitest、`build`=tsdown）
- [ ] **Step 4: 运行确认通过**——`npx vitest run tests/unit/wsAdapter.test.ts`，预期 PASS
- [ ] **Step 5: Commit**——`git add -A && git commit -m "feat: scaffold + ws RemoteSocket adapter (M1 gate 1/2)"`

### Task 2: 自研 JSON-RPC 客户端层（M1 前置门 ½）

**Files:**
- Create: `src/rpc/jsonRpcClient.ts`
- Test: `tests/unit/jsonRpcClient.test.ts`（用 `acceptSecureChannel` + 内存 WS 对做自环服务端）

**Interfaces:**
- Consumes: Task 1 的 `toRemoteSocket`；`connectSecureChannel`/`acceptSecureChannel`
- Produces: `class JsonRpcClient { constructor(channel: SecureChannel, opts?: { maxInFlight?: number }); request<T>(method: string, params: unknown): Promise<T>; onNotification(h: (method: string, params: unknown) => void): void; dispose(): void }`——请求-响应按 id 关联、超时与 in-flight 上限（默认 8）、出入站均过协议包 `jsonRpc*Schema` 校验（复用其 zod schema）、**未知通知方法忽略+不崩溃**

- [ ] **Step 1: 写失败测试**——自环对端回显请求：①请求-响应关联正确；②in-flight 超 8 时排队；③对端推送未知 `method:'future.thing'` 通知 → handler 收到且不抛；④对端回畸形响应（缺 id）→ 请求 promise reject；⑤出入站 schema 校验拒绝非 2.0 帧
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——id 自增计数器 + pending Map；`channel.read` 循环分发；`JSON.stringify/parse` + `jsonRpcRequestSchema`/`jsonRpcResponseSchema`（协议包实际导出名以 npm 包为准）校验；默认超时 30s
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: self-built JSON-RPC 2.0 client layer (M1 gate 2/2)"`

### Task 3: identity.ts

**Files:**
- Create: `src/identity.ts`
- Test: `tests/unit/identity.test.ts`

**Interfaces:**
- Produces: `async function loadOrCreateIdentity(dataDir: string): Promise<{ key: Uint8Array; id: string }>`（`id = deviceIdentityId(key)`）；文件名 `identity.key`、权限 0600、损坏/缺失时重新生成

- [ ] **Step 1: 写失败测试**——①首次生成并持久化（0600）；②再次加载返回同一 id；③写坏文件后加载 → 重新生成（id 变化）+ 返回新身份
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——`createDeviceIdentity()`（remote-transport）；`fs.writeFile(..., { mode: 0o600 })`；读失败/解析失败 → 重生成覆盖
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: ed25519 device identity with 0600 persistence"`

### Task 4: deviceStore.ts

**Files:**
- Create: `src/deviceStore.ts`
- Test: `tests/unit/deviceStore.test.ts`

**Interfaces:**
- Produces: `interface DeviceRecord { deviceId: string; displayName: string; hosts: string[]; port: number; desktopIdentity: string; grants: 'agent'[]; accessToken?: string; tokenExpiresAt?: number; enabled: boolean }`；`class DeviceStore { constructor(file: string); list(): DeviceRecord[]; resolve(device: string): DeviceRecord | { ambiguous: string[] }; upsert(r: DeviceRecord): void; remove(deviceId: string): void }`——档案带 `schemaVersion`，读时惰性迁移；resolve 规则：deviceId 精确优先、显示名前缀唯一生效、歧义返回候选

- [ ] **Step 1: 写失败测试**——①upsert/list/remove 往返持久化（0600）；②resolve 三规则（精确/唯一前缀/歧义候选）；③`schemaVersion: 1` 旧档案读入时迁移到当前版本且字段不丢；④文件损坏 → 空库 + 不抛
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——JSON 文件读写（写后 fsync）；迁移函数表 `{ 1 → 2 }` 起步
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: versioned device store with lazy migration"`

### Task 5: connection.ts（通道底座）

**Files:**
- Create: `src/connection.ts`、`tests/loopback/fakeCherry.ts`（假对端：`acceptSecureChannel` + hello/authenticate/refresh/ping + 可配置限流与断连注入）
- Test: `tests/integration/connection.test.ts`

**Interfaces:**
- Consumes: Task 1-4 全部
- Produces: `class DeviceConnection { constructor(opts: { identity: Uint8Array; record: DeviceRecord }); readonly rpc: JsonRpcClient; state: DeviceState; connect(): Promise<void>; close(): Promise<void>; onState(cb): void }`（`DeviceState = 'connected'|'connecting'|'offline'|'disabled'|'identity-mismatch'`）；内部：有界并发队列（≤8，协议 16 的一半）、指数退避重连（封顶 60s）、ping 静默超时（2×heartbeatMs）判定断线、refresh 以 `expiresAt` 驱动

- [ ] **Step 1: 写失败测试**（对 fakeCherry）——①hello 确认（回传相同 protocolVersions）+ authenticate 拿 token；②refresh 在 expiresAt 前自动发起；③对端 pin 公钥不符 → `identity-mismatch` 且断开；④对端主动 close → 状态 offline → 退避重连成功重认证；⑤ping 静默 2×heartbeatMs → 判定断线；⑥并发 10 请求 → 排队消化、在途 ≤8；⑦对端 1011 终止（模拟超限）→ 重连不雪崩（退避递增）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——`connectSecureChannel`（校验对端静态公钥=record.desktopIdentity）→ hello（回传握手 offeredVersions，两处恒等）→ authenticate；limits/heartbeatMs 从 hello 回报取，缺键回落保守默认（10s 心跳/8 订阅/100 分页）；队列：信号量 + 秒级速率平滑
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: per-device connection with pin check, refresh, backoff, bounded queue"`

### Task 6: pairing.ts

**Files:**
- Create: `src/pairing.ts`
- Test: `tests/integration/pairing.test.ts`（fakeCherry 补 pairing.claim/get 最小面）

**Interfaces:**
- Consumes: `DeviceConnection`、`DeviceStore`
- Produces: `async function pairWithPayload(opts: { identity: Uint8Array; payload: string; name?: string; onVerificationCode: (code: string) => void; onStatus?: (s: string) => void }): Promise<DeviceRecord>`——成功返回已入库档案；失败抛 `PairingError`（kind: `invalid-payload | rejected | expired`）

- [ ] **Step 1: 写失败测试**——①合法 payload 全流程（claim → 6 位码回调 → 轮询 approved → 档案入库含 grants/token）；②畸形 payload 四例（Review Focus #1：非 JSON / t 错 / 缺 invitationId / 超长 10KB）→ `invalid-payload`；③`rejected`/`expired` 透传 kind；④IPv6 方括号形态入库规范化为裸 host；⑤未知字段（`name`）忽略
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——payload 解析（`v===2 && t==='cherry-studio-pair'`，清单内字段白名单）；临时连接逐候选地址尝试；`pairing.claim(platform:'desktop', capabilities:['agent'])`；轮询至终态；成功销毁临时连接
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: pairing flow with payload validation and IPv6 normalization"`

### Task 7: subscriptions.ts

**Files:**
- Create: `src/subscriptions.ts`
- Test: `tests/integration/subscriptions.test.ts`（fakeCherry 补 agent.events/subscribe/ack/checkpoint 最小面）

**Interfaces:**
- Consumes: `DeviceConnection.rpc`
- Produces: `class SessionSubscriptions { constructor(rpc: JsonRpcClient, limits: { subscriptions: number; cacheBytes: number }); ensure(sessionId: string, cursor?: Cursor): Promise<void>; read(sessionId: string, fromCursor?: Cursor): { events: AgentEvent[]; nextCursor: Cursor } | { error: 'cursor-out-of-window' }; handleNotification(method: string, params: unknown): void }`——LRU（上限=hello limits，默认 8）、同连接重复订阅先 close、ack 推进、`resetRequired` 重订、checkpoint 恢复（appliedCursor 取 subscribe 返回描述符游标）、每会话缓存 2MiB 丢最旧

- [ ] **Step 1: 写失败测试**——①ensure 建订阅后 `agent.events` 通知进缓存、read 按游标返回增量；②游标早于窗口 → `cursor-out-of-window`（含窗口起点）；③第 9 个会话订阅 → 最旧被 LRU 淘汰（close 被调）；④同会话二次 ensure → 不重复 subscribe（先 close 再 subscribe 或复用）；⑤`resetRequired` → 重订阅成功；⑥伪 checkpoint 流 → appliedCursor 用描述符游标激活成功（对端校验）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——per-session `{ subscriptionId, cursor, buffer: string[], bytes }`；通知 coalesce 后唤醒等待者（Promise resolver 队列）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: session subscriptions with LRU, cursor ack, checkpoint recovery"`

### Task 8: tools.ts 只读族（devices/agents/workspaces/sessions/read/events）

**Files:**
- Create: `src/tools.ts`（本 task 注册 6 个只读工具 + 注册框架）
- Test: `tests/integration/toolsRead.test.ts`

**Interfaces:**
- Consumes: `DeviceStore.resolve`、`JsonRpcClient`、`SessionSubscriptions`
- Produces: `function registerCherryTools(ctx: Context, deps: { store: DeviceStore; connect(deviceId): DeviceConnection; subs(deviceId): SessionSubscriptions; pair: typeof pairWithPayload; identity: Uint8Array }): void`——工具以字面 JSON Schema 声明参数；`device` 解析歧义时返回候选列表

- [ ] **Step 1: 写失败测试**——①`cherry_devices` 返回状态枚举（封闭五态）；②`cherry_agents`/`cherry_sessions` 分页聚合（对端返回 2 页×50 → limit 150 时聚合为 150 条，上限取 hello limits.pageItems）；③`cherry_workspaces` 返回 registered 列表+`systemWorkspace` 标志；④`cherry_read` 两级流程（fakeCherry 校验收到 historyRevision/messageRevision）+ `{ref}` part 经 content.read 聚合（≤24KiB/次、sha256 校验）；⑤`cherry_events` 委托 subscriptions.read；⑥device 歧义 → 结构化候选
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——`ctx.tools` 注册（参照 dsh-mcp-connector 的字面 parameters 形态）；read 的基线：sessions.get → messages.list → 逐消息 parts.list
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: read-only cherry tools (devices/agents/workspaces/sessions/read/events)"`

### Task 9: tools.ts 交互族（create/send/wait/interactions/respond/cancel）

**Files:**
- Modify: `src/tools.ts`
- Test: `tests/integration/toolsInteract.test.ts`

**Interfaces:**
- Consumes: Task 8 框架；`SessionSubscriptions.ensure`（先订后发）
- Produces: 6 个工具，行为契约见 spec §3.6——`cherry_create` workspace 必填二选一 + 回执仅 sessionId + sessions.get 两步回读；`cherry_send` text≤32768 前置校验、终态四集（含 interrupted）、挂起交互=软终态、超时非失败返回部分内容+游标；`cherry_wait` 空会话立即返回快照、缺省 timeoutMs=120000；`cherry_respond` 三重校验参数必填、question 不得 approve（deny 允许）；`cherry_cancel` 必带 expectedExecutionId

- [ ] **Step 1: 写失败测试**——①create 必填校验（两参皆空 → 结构化错误）+ 两步回读；②send→终态聚合返回助手文本；③send 期间 fakeCherry 推 question 交互 → 软终态提前返回（标注 kind）→ respond(answer 全答) → cherry_wait 恢复等待到终态；④respond question+approve → 对端拒绝错误透传；question+deny → 接受；⑤send text 40k → 前置校验拒绝；⑥send 超时 1s（timeoutMs 可调）→ 部分内容+游标；⑦cancel 带 expectedExecutionId（缺失 → 工具参数校验失败）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——等待器挂在 subscriptions 的会话缓冲上；软终态谓词=任何未应答挂起交互（实时入流）；answers 以问题文本为 key 全量必答
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: interactive cherry tools with soft-terminal and answer contract"`

### Task 10: tools.ts 管理族（pair/unpair）+ index.ts 装配

**Files:**
- Modify: `src/tools.ts`、`src/index.ts`
- Test: `tests/integration/toolsManage.test.ts`

**Interfaces:**
- Consumes: `pairWithPayload`
- Produces: `cherry_pair(payload, name?)`（结果含验证码）与 `cherry_unpair(device)`（删档断连）；`src/index.ts` 装配：inject `['tools']`，apply 中初始化 identity/store/连接池并注册工具

- [ ] **Step 1: 写失败测试**——①cherry_pair 走通配对（验证码出现在结果）；②unpair 删除档案且连接关闭；③插件 apply 幂等（重复 apply 不重复注册）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——连接池 `Map<deviceId, DeviceConnection>`；unpair 调 `connection.close()` + `store.remove()`
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: management tools and plugin assembly"`

### Task 11: httpApi.ts（同源路由 + SSE）

**Files:**
- Create: `src/httpApi.ts`
- Test: `tests/integration/httpApi.test.ts`

**Interfaces:**
- Consumes: `ctx.webServer`（prefix 注册）、`ctx.webRuntime.trustedHosts`
- Produces: `function registerHttpApi(ctx: Context, deps): void`——`isTrustedWebRequest(req)`（Host 回环 + 非 cross-site + Origin/Host 同源）逐路由调用；端点：`GET /devices`、`POST /pair`、`DELETE /devices/:id`、`PATCH /devices/:id`（改名/启停/地址维护=hosts 整体替换）、`GET /events`（SSE：设备状态+配对进度）；生命周期随插件启关注销

- [ ] **Step 1: 写失败测试**——①五端点往返（REST schema）；②非回环 Host → 拒绝；非同源 Origin → 拒绝；③SSE 订阅状态变化推送 + 客户端断开 → 清理无泄漏（Review Focus #5）；④PATCH hosts 整体替换生效；⑤disable→enable 设备状态流转
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——`ctx.webServer.register({ kind: 'prefix', prefix: '/cherry-remote/api' })`（API 以宿主实际签名为准，参照 dsh-mcp-connector/lib/web.js）；SSE 用 `text/event-stream` + 心跳注释行
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: same-origin http api with trust fence and SSE"`

### Task 12: web client 设置页

**Files:**
- Create: `ui/`（`index.html` + `src/main.tsx` + `App.tsx` + `vite.config.ts`）、`package.json` 增 `dsh.client` 字段（platform web + inject）
- Test: `tests/unit/ui.test.ts`（组件级，jsdom）

**Interfaces:**
- Consumes: Task 11 的同源端点（`/cherry-remote/api` 相对路径）
- Produces: 设置页「Cherry Studio 互联」——配对向导（粘贴 payload + 图文指引 + 6 位验证码瞬态展示）、设备卡片（状态灯五态/启停/重命名/移除/地址维护）

- [ ] **Step 1: 写失败测试**——①配对向导提交 payload → POST /pair 被调、验证码渲染、配对完成即消失；②设备卡片渲染状态灯五态 + 四操作各自 API 调用；③SSE 状态变化 → 卡片状态更新
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——React + fetch 相对路径；SSE 用 `EventSource('/cherry-remote/api/events')`
- [ ] **Step 4: 运行确认通过**（`npx vitest run tests/unit/ui.test.ts`）
- [ ] **Step 5: Commit**——`"feat: web client settings page with pairing wizard and device cards"`

### Task 13: M4 打磨——契约测试、diagnostics、发布

**Files:**
- Create: `tests/contract/contract.test.ts`、`src/diagnostics.ts`（`GET /diagnostics` 并入 httpApi 路由）
- Modify: `package.json`（发布字段）、`cordis.patch.yml`
- Test: 契约测试本体

**Interfaces:**
- Consumes: fakeCherry 全量面
- Produces: ①契约差异清单建模（`connection.closed` 不发送、审批卡非实时入流、限流终止语义、服务端不产生 interrupted——每项一个显式断言 fakeCherry 与真实协议 schema 的行为差异）；②`GET /diagnostics`（设备状态/连接统计/最近错误摘要，脱敏后输出）；③发布配置（files/prepublishOnly build/README）

- [ ] **Step 1: 写失败测试**——契约四差异各有断言（如：fakeCherry 收到 `connection.closed` schema 合法帧的 fixture 时客户端能处理，但契约标注真实对端不发送）；diagnostics 输出无 token/secret 字段
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——差异清单常量表 + diagnostics 聚合器（脱敏白名单：deviceId/desktopIdentity 摘要/sessionId 可出）
- [ ] **Step 4: 运行确认通过**（全量 `npm test`）
- [ ] **Step 5: Commit**——`"feat: contract tests, diagnostics endpoint, release config"`

---

## Self-Review 记录

1. **Spec 覆盖**：§3.1-3.7 → Task 3/4/5/6/7/8-10/11-12；§4 数据流散入对应集成测试；§5 → Task 3/4（0600）+ Task 11（信任 fence）+ Task 13（脱敏断言）；§6 错误表 → 各集成测试逐行锚定（Task 5⑥⑦、Task 6②③、Task 7②⑤、Task 9④⑥）；§7 → 各 Test + Task 13 契约；§8 → 脚手架/Task 13 发布；§9 M1-M4 → Task 1-5（M1）/6/11/12（M2）/7-10（M3）/13（M4）。无缺口。
2. **步骤扫描**：每步单一动作；算法仅在等待器/软终态谓词处给一句方向，不写正文。
3. **类型一致性**：`DeviceRecord`/`DeviceState`/`JsonRpcClient`/`SessionSubscriptions.read` 签名在 Task 4/5/2/7 定义并被 Task 8-11 按名引用 ✓
4. **Review Focus**：五项各有归属测试 ✓
5. **比例**：计划 ~13 任务 × 5 步，与 453 行 spec 相称；无代码正文转写。
