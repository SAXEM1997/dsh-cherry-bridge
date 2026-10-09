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
- 协议包有**根入口**与 **`./agent` 子路径**两套导出面：`agentMethods`/agent 面符号**仅从 `@cherrystudio/remote-protocol/agent` 导入**（根入口不导出 agent 面符号）
- 协议两包以精确版本 pin（`@cherrystudio/remote-protocol@0.3.0` / `@cherrystudio/remote-transport@0.1.2`），升级须走契约测试
- 工具命名：`cherry_*` 短名、无 `_list` 后缀；工具参数以**字面 JSON Schema** 声明（zod 仅用于协议侧与自有持久化数据）
- 同源/回环校验由插件在每条路由自行实施（`isTrustedWebRequest` 式三重判定）

## Review Focus

1. **畸形配对 payload**（非 JSON / `t` 值错误 / 缺 `invitationId` / 超长字符串）→ 结构化错误返回，不抛裸异常 → 测试在 Task 6 Step 1
2. **对端未知通知方法 / 未知错误码**（协议前向演进）→ 客户端不崩溃并投递 handler；「忽略 + warn」在 Task 7 消费侧 → 测试在 Task 2 Step 1（③⑥）+ Task 7
3. **工具并发风暴**（agent 并行 10 个 `cherry_send`）→ 队列排队消化，不触发对端 64 req/s 断连 → 测试在 Task 5 Step 1
4. **设备档案文件损坏/被外部删除** → 降级为空库 + warn，不崩溃 → 测试在 Task 4 Step 1
5. **SSE 客户端断开后配对进度推送**→ 订阅清理、无句柄泄漏 → 测试在 Task 11 Step 1（③）

---

### Task 1: 工程脚手架 + ws 适配层（M1 前置门 ½）

**Files:**
- Create: `package.json`、`tsconfig.json`、`tsdown.config.ts`、`src/index.ts`（空插件骨架：`export const name = 'cherry-remote'` + `export const inject = ['tools']` + 空 `apply`）、`src/rpc/wsAdapter.ts`
- Test: `tests/unit/wsAdapter.test.ts`

**Interfaces:**
- Produces: `toRemoteSocket(ws: import('ws').WebSocket): import('@cherrystudio/remote-transport').RemoteSocket`——逐项对齐四语义：`binaryType='arraybuffer'`（**可写属性**：RemoteSocketStream 构造时对其赋值 `'arraybuffer'`——socket.ts:32；适配层实现为 getter-only 会在 ESM 严格模式下赋值抛 `TypeError`）、`bufferedAmount`、`readyState`、发送签名 `send(data: Uint8Array)`（上游 `RemoteSocketStream.sendData` 以 `data.subarray()` 调用，发送侧恒为 Uint8Array；ArrayBuffer 仅出现在接收方向，由 `binaryType='arraybuffer'` 保障）

- [ ] **Step 1: 写失败测试**——内存 WebSocket 对（`new WebSocket.Server({ port:0 })` 回环连接）经 `toRemoteSocket` 适配后：接收侧二进制帧为 ArrayBuffer 实例（`binaryType='arraybuffer'`）、发送侧接受 Uint8Array（`send(data: Uint8Array)`，断言 `ws` 侧收到二进制帧）；`readyState` 随 open/close 迁移（**open 后 `readyState === 1`、close 后为非 1**——消费方 `RemoteSocketStream.sendData` 以 `readyState !== 1` 为不可发判据）；`bufferedAmount` 透传；`close()` 触发 close 事件
- [ ] **Step 2: 运行确认失败**——`npx vitest run tests/unit/wsAdapter.test.ts`，预期 FAIL（模块不存在）
- [ ] **Step 3: 实现适配层**——包装 `ws` WebSocket：转发 open/message(binary)/close/error 事件为 EventTarget 风格、`send` 签名为 `send(data: Uint8Array): void`（对端 `ws` 侧仍以二进制帧落地，接收侧由 `binaryType='arraybuffer'` 保证 ArrayBuffer）、透传 `bufferedAmount`/`readyState`/`close()`；脚手架文件同步落地（`pnpm`/`npm` scripts：`test`=vitest、`build`=tsdown）；**依赖以精确版本写入 `package.json`（无 `^` 前缀，pin `@cherrystudio/remote-protocol@0.3.0` / `@cherrystudio/remote-transport@0.1.2`）——使 Task 13 的 pin 断言成为回归保护而非首次落地**
- [ ] **Step 4: 运行确认通过**——`npx vitest run tests/unit/wsAdapter.test.ts`，预期 PASS
- [ ] **Step 5: Commit**——`git add -A && git commit -m "feat: scaffold + ws RemoteSocket adapter (M1 gate 1/2)"`

### Task 2: 自研 JSON-RPC 客户端层（M1 前置门 ½）

**Files:**
- Create: `src/rpc/jsonRpcClient.ts`
- Test: `tests/unit/jsonRpcClient.test.ts`（用 `acceptSecureChannel` + 内存 WS 对做自环服务端）

**Interfaces:**
- Consumes: Task 1 的 `toRemoteSocket`；`connectSecureChannel`/`acceptSecureChannel`
- Produces: `class JsonRpcClient { constructor(channel: SecureChannel, opts?: { maxInFlight?: number; timeoutMs?: number }); request<T>(method: string, params: unknown): Promise<T>; onNotification(h: (method: string, params: unknown) => void): void; dispose(): void }`——请求-响应按 id 关联、超时与 in-flight 上限（默认 8）、出入站均过协议包 `jsonRpc*Schema` 校验（复用其 zod schema）、**客户端将全部合法通知分发给已注册 handler**（客户端层不做方法过滤，未知方法与已登记方法一视同仁地投递；「忽略 + warn」职责落在消费侧——Task 7 `handleNotification` 对未登记 method 忽略并 warn）；`onNotification` 可重复调用、**追加**到 handler 列表（非覆盖）；每连接一个 `JsonRpcClient` 实例，多设备天然按连接隔离分派

- [ ] **Step 1: 写失败测试**——自环对端回显请求：①请求-响应关联正确；②in-flight 超 8 时排队；③对端推送未知 `method:'future.thing'` 通知 → 该帧在通知 schema 层合法（`method` 仅约束长度）、handler 收到且不抛（「忽略 + warn」的断言归属 Task 7 消费侧）；④对端回畸形响应（缺 id）→ 请求 promise reject；⑤出入站 schema 校验拒绝非 2.0 帧；⑥对端响应携带未知 `reason` 的错误对象（如 `reason:'FUTURE_REASON'`）→ 客户端不崩溃，错误结构化透传给请求方（保留原始 `code`/`message`）——**断言 `error.data.reason` 原样可达请求方**（`code` 恒为字面量 1000，`reason` 才是错误判别键——Task 8/9 的 `REVISION_EXPIRED`/`CONFLICT`/`TARGET_UNAVAILABLE` 锚定依赖此透传路径）；**注：`reason` 为协议封闭枚举（16 固定值），未来值将在 schema 层被拒——本用例验证的是拒绝路径不崩溃并降级为通用错误，而非透传未知 reason（与③的 `method` 自由字符串对照）**
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——id 自增计数器 + pending Map；`channel.read` 循环分发；`JSON.stringify/parse` + `jsonRpcRequestSchema`/`jsonRpcResponseSchema`（协议包实际导出名以 npm 包为准）校验；入站帧按**固定顺序**分支判定：(a) `id` 缺失 → notification（`jsonRpcNotificationSchema`，协议包为 `z.strictObject(envelope)`、无 `id` 字段）→ 交 handler；(b) 有 `id` 且带 `method` → request（`jsonRpcRequestSchema`）；(c) 其余有 `id` 帧 → response（`jsonRpcResponseSchema`）；**三分支皆不匹配**（缺 `jsonrpc:'2.0'`，或 `id` 合法但 `result` 与 `error` 皆无）→ **丢弃该帧并 warn（不崩溃）**。对端 `agent.events` 通知必须走 (a) 判定——若先用 response schema 严格解析会因缺少 `result`/`error` 把合法通知判为非法；默认超时 30s
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: self-built JSON-RPC 2.0 client layer (M1 gate 2/2)"`

### Task 3: identity.ts

**Files:**
- Create: `src/identity.ts`
- Test: `tests/unit/identity.test.ts`

**Interfaces:**
- Produces: `async function loadOrCreateIdentity(dataDir: string): Promise<{ key: Uint8Array; id: string }>`（`id = deviceIdentityId(key)`）；文件名 `identity.key`、权限 0600、损坏/缺失时重新生成
- 落盘格式：`identity.key` 持久化为 `createDeviceIdentity` 返回的**原始私钥字节**（protobuf 编码，非文本——不得以 hex/base64/PEM/JSON 包装写入）
- 损坏判据：读取后经协议包身份解析（或 `deviceIdentityId` 计算）**抛错即视为损坏 → 重新生成**

- [ ] **Step 1: 写失败测试**——①首次生成并持久化（0600）；②再次加载返回同一 id；③写入非 Ed25519/损坏字节后加载 → 重新生成（id 变化）+ 返回新身份
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——`createDeviceIdentity()`（remote-transport）；`fs.writeFile(..., { mode: 0o600 })`，写入返回的原始私钥字节（protobuf，非文本）；**写后显式 `chmod 0600`**（`fs.writeFile` 的 `mode` 仅对新建生效，覆盖已存在文件不改变权限——重生成覆盖路径须 `chmod` 兜底）；损坏判据实现同 Interfaces 定义（协议包身份解析抛错即重生成）；读失败/损坏 → 重生成覆盖
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: ed25519 device identity with 0600 persistence"`

### Task 4: deviceStore.ts

**Files:**
- Create: `src/deviceStore.ts`
- Test: `tests/unit/deviceStore.test.ts`

**Interfaces:**
- Produces: `interface DeviceRecord { schemaVersion: number; deviceId: string; displayName: string; hosts: string[]; port: number; desktopIdentity: string; grants: 'agent'[]; accessToken?: string; tokenExpiresAt?: number; enabled: boolean }`——`accessToken`/`tokenExpiresAt` **同生同灭**（成对出现或均缺省，不得只存其一）；`class DeviceStore { constructor(file: string); list(): DeviceRecord[]; resolve(device: string): DeviceRecord | { ambiguous: string[] }; upsert(r: DeviceRecord): void; remove(deviceId: string): void }`——档案带 `schemaVersion`，读时惰性迁移；resolve 规则：deviceId 精确优先、显示名前缀唯一生效、歧义返回候选
- **类型层后果（必填类型与 v1 缺失键的共存）**：`schemaVersion` 在 `DeviceRecord` 上为**必填**（对外契约），但 v1 档案不含该键——故读取层**不得**直接以 `DeviceRecord` 反序列化磁盘内容，而须先落到**宽松解析类型**（`DeviceRecordOnDisk = Partial<DeviceRecord> & { schemaVersion?: number }`，模块内部类型、不导出），经「判版本 → 迁移 → 校验」后再断言为 `DeviceRecord` 必填类型；即必填类型是**读路径出口**而非入口，两者以宽松中间类型共存，禁止用 `as DeviceRecord` 跳过版本判定

- [ ] **Step 1: 写失败测试**——①upsert/list/remove 往返持久化（0600）；②resolve 三规则（精确/唯一前缀/歧义候选）；③`schemaVersion: 1` 旧档案读入时迁移到当前版本且字段不丢——**v1 fixture 形态定义：v1 = 当前字段集减 `schemaVersion`**（合成旧档 fixture，仅作迁移机制验证样本，不代表真实历史版本）；**补例：`schemaVersion` 缺失 + 字段集残缺（如缺 `port`/`grants`）→ 报错、不迁移**（区别于字段集完整的 v1：`schemaVersion` 缺失只在字段集完整时才等价于 v1，残缺档案须拒绝而非按 v1 迁移）；**读路径顺序固定：先用宽松结构（`schemaVersion?: number`，其余键全部可选）`JSON.parse` 后判版本 → 命中迁移表则迁移 → 迁移完成后再落 `DeviceRecord` 必填类型**（不得让宽松结构逸出读取层）；④当前版本档案读入**免迁移（幂等）**——重复读入不触发迁移、字段与版本号不变；⑤**高版本档案（未知 `schemaVersion`，如 99）→ 拒绝读取并报错**（不降级、不按当前版本解析）；⑥文件损坏 → 空库 + 不抛 + **warn 日志断言（RF4）**
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——JSON 文件读写（写后 fsync）；**读路径按 Interfaces 固定顺序实现：宽松解析（`DeviceRecordOnDisk`）→ 判 `schemaVersion` → 迁移 → 校验落 `DeviceRecord` 必填类型**；`schemaVersion` 缺失时**仅当字段集完整**才按 1 处理，字段集残缺即报错；迁移函数表 `{ 1 → 2 }` 起步（**`{1→2}` 仅为机制样本；真实演进自发布后的版本 2 起**，schemaVersion 缺失视为 1）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: versioned device store with lazy migration"`

### Task 5: connection.ts（通道底座）

**Files:**
- Create: `src/connection.ts`、`tests/loopback/fakeCherry.ts`（假对端：`acceptSecureChannel` + hello/authenticate/refresh/ping + 可配置限流与断连注入）
- Test: `tests/integration/connection.test.ts`

**Interfaces:**
- Consumes: Task 1-4 全部
- Produces: `class DeviceConnection { constructor(opts: { identity: Uint8Array; record: DeviceRecord; rateBudgetPerSecond?: number }); readonly rpc: JsonRpcClient; readonly limits: EffectiveLimits; state: DeviceState; connect(): Promise<void>; close(): Promise<void>; onState(cb): void }`（`DeviceState = 'connected'|'connecting'|'offline'|'disabled'|'identity-mismatch'`；`rateBudgetPerSecond` 默认 32，**由装配层自插件配置（cordis 默认键）注入**，驱动秒级速率平滑预算）；**`readonly limits: EffectiveLimits` 为只读访问器**——`hello` 回报经缺键回落后的**生效值**形态（`pageItems`/`subscriptions`/`heartbeatMs`/`inFlightRequests`），供 Task 8（分页上限）/Task 10（`subscriptionsLimit` 装配）消费；内部：指数退避重连（封顶 60s）、ping 静默超时（2×heartbeatMs）判定断线、refresh 以 `expiresAt` 驱动
- 并发所有权单一化：`DeviceConnection` 以 `maxInFlight: 8` 构造 `JsonRpcClient`（**in-flight 上限由 rpc 层持有**）；`DeviceConnection` 自身仅做秒级速率平滑，**不再另设并发信号量**（避免双层限流互相遮蔽）；**`maxInFlight: 8` 语义边界：8 为「业务请求」在途上限；心跳、token refresh、订阅 ack 等内务 RPC 走独立通道、不占该窗口（spec §3.4 预留意图）；若实现无法分通道，则收紧该预算并注明取舍**
- refresh 宽限：refresh 失败在 **30s 宽限窗口（协议 `refreshGraceMs`）** 内重试；超时后设备转 `offline` 并提示检查对端移除
- 类型来源标注：`SecureChannel`/`RemoteLimits` 等自 `import('@cherrystudio/remote-transport')` 导入

- [ ] **Step 1: 写失败测试**（对 fakeCherry）——①hello 确认（回传相同 protocolVersions；**注入版本不匹配例 → 报版本不兼容并转 offline**，锚定 §6「协议协商失败」行——**此例模拟回执不一致（`INVALID_CONNECTION_STATE`——客户端 bug 信号）；真实的协议版本协商失败发生在 Noise 前导（`connectSecureChannel` 选版失败）——两种失败面在用例注释中区分**）+ authenticate 拿 token；②refresh 在 expiresAt 前自动发起；③对端 pin 公钥不符 → `identity-mismatch` 且断开；④对端主动 close → 状态 offline → 退避重连成功重认证；⑤ping 静默 2×heartbeatMs → 判定断线；⑥并发可证伪：fakeCherry 以可控延迟（如每请求延迟 50ms）+ 在途计数器暴露实际在途请求数，断言 10 个并发请求期间**对端观测在途 ≤8**、完成后全部成功；**补充一条：以 `maxInFlight: 3` 手工构造 `JsonRpcClient` → 对端观测在途 ≤3（证伪上限归属 rpc 层，防装配层误加第二信号量）**；⑦对端 close 1013（连接数超限）与 1011（限流终止）走**同一断线判定/退避路径**，各注入一例断言状态迁移一致；**限流超限的权威信号为对端 close 1011/1013（整条会话终止，非单请求拒绝）——与 Task 13 契约「限流终止语义」项互引**；⑧速率用例：以可配置注入速率发起 100 请求 → 1s 滑窗内对端观测到的请求数 ≤ 平滑预算（如 32），全部完成无断连；⑨对端持续拒绝 refresh → 宽限窗口（30s）后转 offline；⑩authenticate 回 `GRANT_REVOKED` → 转 offline 并提示重新配对；⑪身份再生成后（identity 密钥变更）旧档案认证全败 → 全配对失效链路断言；⑫既有设备 hosts 全部不可达（注入连接拒绝）→ 状态 `offline`；修正 hosts 后（PATCH 模拟）自动重连成功——锚定 §6「候选地址全部不可达」行（区别于 Task 6 配对期 `unreachable`）；⑬设备处于 `offline` 时调用工具面（经装配 mock）→ 结构化错误 `{device, state}`——锚定 §6「设备离线」行；**并断言 offline 设备在工具调用期间连接尝试计数不增——即不触发 `connect()`**（spec §6「不自动重试轰炸」半句的显式断言：离线态工具调用失败即返回，不得隐式触发重连）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——`connectSecureChannel`（校验对端静态公钥=record.desktopIdentity）→ hello（回传数组与握手 offer **逐元素同序相等**：长度与每项顺序均须一致，对端按 index 比对；**集合相等会假通过自环、真对端报 `INVALID_CONNECTION_STATE`**）→ authenticate；limits/heartbeatMs 从 hello 回报取，缺键回落保守默认（**20s 心跳**/8 订阅/100 分页/**`inFlightRequests` 8（spec §3.4 一半原则）**，与 spec §3.4「默认 20s」一致；断线窗口 2×heartbeatMs 随之 40s）；`JsonRpcClient` 以 `maxInFlight: 8` 构造（**in-flight 归属：同 Interfaces 并发所有权注记**），本层仅做秒级速率平滑；**对端速率窗为 per-connection（限流计数是 per-socket 变量）；per-device 预算独立即满足，不得引入跨设备全局调度**
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: per-device connection with pin check, refresh, backoff, bounded queue"`

### Task 6: pairing.ts

**Files:**
- Create: `src/pairing.ts`
- Test: `tests/integration/pairing.test.ts`（fakeCherry 补 pairing.claim/get 最小面）

**Interfaces:**
- Consumes: `connectSecureChannel`（配对用**临时连接**：本任务自带一次性握手，非 `DeviceConnection`）、`DeviceStore`（成功后入库）；**不消费 `DeviceConnection`**——配对期无 hello/limits/refresh 内务面，档案入库后由 Task 5 的 `DeviceConnection` 承接常驻连接
- Produces: `async function pairWithPayload(opts: { identity: Uint8Array; payload: string; name?: string; onVerificationCode: (code: string) => void; onStatus?: (s: string) => void }): Promise<DeviceRecord>`——成功返回已入库档案；失败抛 `PairingError`（kind: `invalid-payload | rejected | expired | unreachable`——`unreachable` 表示逐候选地址尝试全败，无一条通道可用）

- [ ] **Step 1: 写失败测试**——①合法 payload 全流程（claim → 6 位码回调 → 轮询 approved → 档案入库含 grants/token）；②畸形 payload（五种形态：非 JSON / `t` 值错误 / 缺 `invitationId` / `invitationId` 300 字符 / 整体超长 10KB）逐字段判据 → 均须 `invalid-payload`（Review Focus #1）；③`rejected`/`expired` 透传 kind；**轮询持续至对端回 expired——断言错误 kind 来自对端终态而非本地轮询超时（120s 到期统一表现为 expired 的竞态防护）**；④IPv6 方括号形态入库规范化为裸 host；⑤未知字段（`name`）忽略；⑥payload 携带版本集与本机支持集**交集为空** → connectSecureChannel 选版失败（`unreachable` 类错误）——锚定 §6「协议协商失败」行的真实协商失败面（Noise 前导；与 Task 5① 的回执不一致例区分）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——payload 解析（`v===2 && t==='cherry-studio-pair'`，清单内字段白名单，**按字段上限判定**：`invitationId` 等 opaqueId ≤256、各字段长度上限一并取自协议 `values.ts`，超出即 `invalid-payload`）；临时连接逐候选地址尝试（**`connectSecureChannel` 的 `protocolVersions` 取 payload 携带值与本机支持集的交集——空集即协商失败**）；`pairing.claim(platform:'desktop', capabilities:['agent'], deviceName: opts.name ?? os.hostname())`（**claim 携带设备名**：默认取 hostname，`opts.name` 覆盖；**deviceName 超 64 字符（协议上限，hostname 可达 253）→ 截断至 64（截断策略为插件行为）；`opts.name` 同样受限**）；轮询至终态（**`deviceId`/`grants`/`accessToken` 仅从 `pairing.get` 的 `approved` 分支取得**——`claim` 只返回 `claimId`/`verificationCode`/`expiresAt`，不得从 claim 回执取设备身份或令牌）；成功销毁临时连接
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: pairing flow with payload validation and IPv6 normalization"`

### Task 7: subscriptions.ts

**Files:**
- Create: `src/subscriptions.ts`
- Test: `tests/integration/subscriptions.test.ts`（fakeCherry 补 agent.events/subscribe/ack/checkpoint 最小面）

**Interfaces:**
- Consumes: `DeviceConnection.rpc`
- Produces: `class SessionSubscriptions { constructor(rpc: JsonRpcClient, opts: { subscriptionsLimit: number /* hello 回报，缺省 8 */; perSessionCacheBytes?: number /* 插件策略，默认 2MiB，由装配层提供 */ }); ensure(sessionId: string, cursor?: Cursor): Promise<void>; read(sessionId: string, fromCursor?: Cursor): { events: AgentEvent[]; nextCursor: Cursor } | { error: 'cursor-out-of-window' }; handleNotification(method: string, params: unknown): void; activeSessions(): string[] }`——`activeSessions()` **返回当前持有活跃订阅的 sessionId 列表**（供 Task 10 重连恢复接线遍历）；**协议回报与插件策略分离**：`subscriptionsLimit` 来自 `connection.hello` 的 `limits`（对端协商值），`perSessionCacheBytes` 是本地策略（装配层注入，非协议协商）；LRU（上限=`subscriptionsLimit`）、同连接重复订阅先 close、ack 推进、`resetRequired` 重订、checkpoint 恢复（**恢复流程完整链：subscribe 回 checkpoint 模式 → `agent.checkpoints.read` 分页重建投影状态（其 `nextCursor` 为分页游标、不得用作流游标）→ 以 subscribe 返回描述符内游标 activate**）、每会话缓存上限 `perSessionCacheBytes` 丢最旧；**恢复链的租约窗口约束：`agent.checkpoints.read` 分页与 `agent.checkpoints.activate` 必须落在同一 `subscribe` 返回的 prepared 租约窗口内完成（`checkpointMs`，默认 300s）——租约自 subscribe 返回描述符起算，超时则对端回 `CHECKPOINT_EXPIRED`，插件须重走整条恢复链（重新 subscribe → 重新分页重建 → 重新 activate），不得续用过期租约或旧分页结果**；**LRU 上限恒 ≤ hello `limits.subscriptions`：本地淘汰必须发生在触达对端上限之前；若本地上限被配得高于对端值，则对端在 subscribe 时抛 `RESOURCE_EXHAUSTED`（整条订阅失败），而非插件侧静默淘汰——故构造时须以 `limits.subscriptions` 钳制本地 LRU 上限**
- 类型来源标注：`Cursor`/`AgentEvent` 取自 `@cherrystudio/remote-protocol/agent` 导出类型（或以本地最小结构对齐其 zod 推断类型）

- [ ] **Step 1: 写失败测试**——①ensure 建订阅后 `agent.events` 通知进缓存、read 按游标返回增量；②游标早于窗口 → `cursor-out-of-window`（含窗口起点）；③第 9 个会话订阅 → 最旧被 LRU 淘汰（close 被调）；**LRU 淘汰时 warn 日志被记录（「丢最旧并记录」）**；④同会话二次 ensure → **收敛为单路径**：先 `agent.subscriptions.close` 释放旧订阅、再 `subscribe`（对端对重复订阅抛 `CONFLICT`，故不得复用旧订阅）；断言 `close` 被调用且**仅一次**新的 `subscribe`；**并断言时序而非仅次数：`agent.subscriptions.close` 携带旧 `subscriptionId`，且该调用先于新的 `agent.subscriptions.subscribe` 发出**（对端须先因 close 把订阅置 `phase:'reset'` 才允许重订阅——顺序颠倒会撞 `CONFLICT`，故以调用序列断言）；⑤`resetRequired` → 重订阅成功；⑥伪 checkpoint 流 → activate 提交的 `appliedCursor` 须与 `subscribe` 的 checkpoint 分支返回描述符内 cursor **三字段全等**（`sessionId`/`streamEpoch`/`seq` 逐一相等）激活成功（对端校验），**且断言 `agent.checkpoints.read` 被调、分页重建后的投影状态与预期一致**（`checkpoints.read` 的 `nextCursor` 仅作分页推进、不得用作流游标）；**并断言分页 `read` 与 `activate` 均在同一 subscribe 返回的 prepared 租约窗口内完成（`checkpointMs` 300s 内，对端以租约计时校验）**；**反例**：伪造与描述符不一致的游标 → 对端回 `CONFLICT`，插件不吞错；⑦`handleNotification` 对未登记 method 忽略并 warn（RF#2 消费侧断言，与 Task 2 用例③⑥ 配对）；⑧**租约过期路径：fakeCherry 在 subscribe 后延迟超过 `checkpointMs`（测试中以可注入的小值缩短，如 `checkpointMs: 50`）才收到 `activate` → 对端回 `CHECKPOINT_EXPIRED` → 插件重走恢复链（重新 subscribe → 重新分页 read → 重新 activate）成功收敛**（锚定恢复链的租约窗口约束，与 Interfaces 注记配对）；⑨**订阅上限维度：fakeCherry 注入对端订阅上限（`limits.subscriptions`），使第 N+1 次 subscribe 回 `RESOURCE_EXHAUSTED` → 插件捕获该错误码并触发 LRU 淘汰（close 最旧）后重试成功**（锚定 §6 RESOURCE_EXHAUSTED 的**订阅维度**来源——区别于 Task 13 契约的回执上限维度）；⑩**注入例：fakeCherry 对 `activate` 回 `CHECKPOINT_EXPIRED` → 重走恢复链**（对照表 CHECKPOINT_EXPIRED 行的显式注入锚）；⑪**注入例：replay 窗口拒绝（请求游标过旧、超出 replay 预算）→ 对端回以 checkpoint 模式描述符，插件进入恢复链而非报错**（对照表「replay 超预算 → checkpoint 回退」行的显式注入锚）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——per-session `{ subscriptionId, cursor, buffer: string[], bytes }`；通知 coalesce 后唤醒等待者（Promise resolver 队列）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: session subscriptions with LRU, cursor ack, checkpoint recovery"`

### Task 8: tools.ts 只读族（devices/agents/workspaces/sessions/read/events）

**Files:**
- Create: `src/tools.ts`（本 task 注册 6 个只读工具 + 注册框架）
- Test: `tests/integration/toolsRead.test.ts`、`tests/unit/toolSchemas.test.ts`

**Interfaces:**
- Consumes: `DeviceStore.resolve`、`JsonRpcClient`、`SessionSubscriptions`
- Produces: `function registerCherryTools(ctx: Context, deps: { store: DeviceStore; connect(deviceId): DeviceConnection; subs(deviceId): SessionSubscriptions; pair: typeof pairWithPayload; identity: Uint8Array }): void`——工具以字面 JSON Schema 声明参数；`device` 解析歧义时返回候选列表
- 注记：**系统工作区回读 ID 不得误按 registered 语义复用；频繁探测场景应缓存回读结果**（spec §3.6 取舍注记）

- [ ] **Step 1: 写失败测试**——①`cherry_devices` 返回状态枚举（封闭五态）；②`cherry_agents`/`cherry_sessions` 分页聚合（对端返回 3 页×50 → limit 150 时聚合为 150 条，上限取 hello limits.pageItems（缺省 100）；**补注：聚合的逐页 `limit` 恒 ≤ `pageItems`（协议单页硬上限 100）——`limit` 150 只约束聚合总数（可跨多页），下发到每页的 `limit` 必须被钳到 `pageItems`，聚合不突破单页上限**；**带 `workspaceId`/`agentId` 过滤参数 → 断言过滤参数透传至 `agent.sessions.list`**（§4.2 典型顺序））；③`cherry_workspaces` 返回 registered 列表+`systemWorkspace` 标志；④`cherry_read` 两级流程（fakeCherry 校验收到 historyRevision/messageRevision）+ `{ref}` part 经 content.read 聚合（≤24KiB/次、sha256 校验）；⑤`cherry_events` 委托 subscriptions.read——**`cherry_send(wait)`/`cherry_wait`/`cherry_events`/`cherry_read` 四工具首用同会话先 `ensure` 建订阅（同池 LRU，spec §3.5/§4.2），再读缓存/拉基线**；⑥device 歧义 → 结构化候选；⑦fakeCherry 首轮回 `REVISION_EXPIRED` → `cherry_read` 重拉基线（`sessions.get`→`messages.list`）整轮重试一次成功；连续两次失败 → 透传错误（锚定 §6 `REVISION_EXPIRED` 行）；⑧**6 只读工具 schema 校验（本任务注册集）**（字面 JSON Schema 逐项校验 required/enum/上限——本任务 6 工具为 `cherry_devices`/`cherry_agents`/`cherry_workspaces`/`cherry_sessions`/`cherry_read`/`cherry_events`；**14 工具全集断言见 Task 10④**）（于 `tests/unit/toolSchemas.test.ts`）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——`ctx.tools` 注册（参照 dsh-mcp-connector 的字面 parameters 形态）；read 的基线：sessions.get → messages.list → 逐消息 parts.list；**基线取值：`sessions.get` 的 `historyRevision` 传入 `messages.list`；逐消息以其 `messageRevision` 传入 `parts.list`；对端回 `REVISION_EXPIRED` → 重拉基线（`sessions.get`→`messages.list`）后整轮重试一次，再失败则透传错误**
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: read-only cherry tools (devices/agents/workspaces/sessions/read/events)"`

### Task 9: tools.ts 交互族（create/send/wait/interactions/respond/cancel）

**Files:**
- Modify: `src/tools.ts`
- Test: `tests/integration/toolsInteract.test.ts`

**Interfaces:**
- Consumes: Task 8 框架；`SessionSubscriptions.ensure`（**ensure 首用语义：同 Task 8⑤ 注记（四工具首用 ensure）**）
- Produces: 6 个工具，行为契约见 spec §3.6——`cherry_create` workspace 必填二选一 + 回执仅 sessionId + sessions.get 两步回读；`cherry_send` text≤32768 前置校验、终态四集（含 interrupted）、挂起交互=软终态、超时非失败返回部分内容+游标；**`wait=false`：立即返回命令回执（`commandId`/状态），不等待终态**；`cherry_wait` 空会话立即返回快照、缺省 timeoutMs=120000；`cherry_interactions(device, sessionId)`：`agent.interactions.list` **返回全集**（对端不过滤——服务端合并实时与持久项、含 pending/approved/denied/expired 四态），**待答过滤为插件侧行为**（按 `status==='pending'` 筛），返回含 kind（question/decision）与摘要；`cherry_respond` 三重校验参数必填、question 不得 approve（deny 允许）；`cherry_cancel` 必带 expectedExecutionId
- 注记：**send/wait 终态聚合中遇到 `{ref}` part 同样经 `agent.content.read` 聚合**（同 `cherry_read` 路径，spec §3.6 L270-271）；**`expectedIdleRevision` 取订阅缓存的最新 idle revision（缓存缺失先建基线）；`commandId` 每次调用新生成（uuid），重试复用同一 id**；**`cherry_cancel` 的 `expectedExecutionId` 取自订阅缓存 `execution.updated` 的当前活跃执行 ID**（与 respond 三重参数同源——订阅缓存交互/执行快照，非调用方透传）

- [ ] **Step 1: 写失败测试**——①create 必填校验（两参皆空 → 结构化错误）+ 两步回读；②send→终态聚合返回助手文本（**注入一条 `{ref}` part → 断言聚合结果含 `content.read` 取回内容**）；③send 期间 fakeCherry 推 question 交互 → 软终态提前返回（标注 kind）→ respond(answer 全答) → cherry_wait 恢复等待到终态；④**双表面断言**：respond question+approve → **命令回执** `status:'rejected'` + `error.reason:'CONFLICT'`（非 RPC 错误）、**并断言 `error.message === 'Question requires answers'`**；question+deny → 回执 applied（对端接受）；⑤send text 40k → 前置校验拒绝；⑥send 超时 1s（timeoutMs 可调）→ 部分内容+游标；⑦cancel 带 expectedExecutionId（缺失 → 工具参数校验失败——**必填缺失由宿主字面 schema 校验层拦截，集成测试断言注册 schema 的 `required` 含 `expectedExecutionId`，而非工具内运行时错误**）；⑧cherry_interactions 对端返回含已答项的全集 → 插件过滤后仅返回 pending（空集返回空数组）；⑨cherry_wait 对无进行中执行的会话 → 立即返回当前快照（不报错、不等待）；⑩订阅类状态机冲突（如重复订阅）→ RPC 错误 CONFLICT——两种表面分别断言；⑪同 commandId 异参重发 → 对端 `IDEMPOTENCY_CONFLICT` 透传；⑫**`wait=false` 调用 → 立即返回命令回执（commandId/状态）、终态后可经 `cherry_events`/`cherry_wait` 续查**；⑬**`respond` 的 answers 缺某问题键 → 对端以命令回执拒绝、断言无部分提交**（锚定 §7-2 交互应答四例之「缺键拒绝」），**并断言 `error.message === 'Every question requires an answer'`——两条失败（④⑬）语义同 reason（`CONFLICT`）同 status（`rejected`）、仅 message 不同，以 message 区分防互蔽；不得依赖 error 指明具体缺失键名（服务端 message 为固定文案）**；⑭**fakeCherry 注入 `execution.updated` 终态 `interrupted` → 等待器收敛返回**（不挂起至超时；与 Task 13 契约断言「真实对端不产生」构成两面）；**注：注入的 interrupted 终态 fixture 须满足 `executionSchema` 终态 superRefine 约束（messageId + 持久化结果字段），否则 schema 层先拒、用例失去意义**；⑮**fakeCherry 对 send/cancel 回 TARGET_UNAVAILABLE 拒绝回执 → 透传，同 commandId 重试返回同样拒绝（锚 §6）**
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——等待器挂在 subscriptions 的会话缓冲上；**等待终态谓词只覆盖 execution 维度四态（成功/失败/取消/中断）；命令回执 `status` 的 `'interrupted'`（命令结果未定）是另一维度，不进入等待谓词——契约测试（Task 13）对两层分别断言**；软终态谓词=任何未应答挂起交互（实时入流）；answers 以问题文本为 key 全量必答；**respond 三重参数取值来源：`expectedRevision`/`expectedExecutionId`/`inputDigest` 取自订阅缓存的交互快照（`interaction.updated` 事件携带或 `interactions.list` 查询获得），不从调用方参数透传**；**`expectedIdleRevision`/`commandId` 取值与重试语义：同 Task 9 Interfaces 注记**
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: interactive cherry tools with soft-terminal and answer contract"`

### Task 10: tools.ts 管理族（pair/unpair）+ index.ts 装配

**Files:**
- Modify: `src/tools.ts`、`src/index.ts`
- Test: `tests/integration/toolsManage.test.ts`

**Interfaces:**
- Consumes: `pairWithPayload`（Task 6）、`loadOrCreateIdentity`（Task 3）、`DeviceStore`（Task 4）、`DeviceConnection`（Task 5）、`SessionSubscriptions`（Task 7）
- Produces: `cherry_pair(payload, name?)`（结果含验证码）与 `cherry_unpair(device)`（删档断连）；`src/index.ts` 装配：inject `['tools']`，apply 中初始化 identity/store/连接池并注册工具

- [ ] **Step 1: 写失败测试**——①cherry_pair 走通配对（验证码出现在结果）；**cherry_pair 结果含最终状态（approved/rejected/expired，断言三者路径各一）**；②unpair 删除档案且连接关闭；③插件 apply 幂等（重复 apply 不重复注册）；④**14 工具齐后全量 schema 校验**（承接 Task 8⑧ 的 6 工具本任务集断言，扩为全集：respond 的 `interactionId` 必填与 `decision|response` 二选一、`cherry_cancel` 的 `expectedExecutionId` required、`cherry_send` 的 `text` 上限 32768——集中归属 §7-1「工具参数 schema 校验」）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——连接池 `Map<deviceId, DeviceConnection>`；unpair 调 `connection.close()` + `store.remove()`；装配接线四行：**subs 工厂**——`subs(deviceId)` 返回（或惰性创建）该设备的 `SessionSubscriptions`（构造参数 `subscriptionsLimit` 取自该连接 hello 回报，`perSessionCacheBytes` 取装配配置默认 2MiB；**`DeviceConnection` 构造时传入插件配置的 `rateBudgetPerSecond`**）；**通知路由**——`connection.rpc.onNotification((m,p) => subs(deviceId).handleNotification(m,p))`；**订阅恢复接线**——`connection.onState` 进入 `connected`（重连成功）→ 对该设备活跃订阅以最后游标 re-ensure（`subs(deviceId).ensure(sessionId, cursor)`，遍历 `subs(deviceId).activeSessions()`）；**事件源接线**——`connection.onState` → `onDeviceState(deviceId, state)` 分发；pair 调用处的 `onStatus(stage)` 桥接为 `onPairingProgress({stage})`
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: management tools and plugin assembly"`

### Task 11: httpApi.ts（同源路由 + SSE）

**Files:**
- Create: `src/httpApi.ts`
- Modify: `src/index.ts`（apply 中调用 `registerHttpApi`；disposer 随插件 dispose 注销）
- Test: `tests/integration/httpApi.test.ts`

**Interfaces:**
- Consumes: `ctx.webServer`（prefix 注册）、`ctx.webRuntime.trustedHosts`
- Produces: `function registerHttpApi(ctx: Context, deps): void`——deps：`{ store: DeviceStore; pair: typeof pairWithPayload; identity: Uint8Array; connect(deviceId): DeviceConnection; onDeviceState(cb): void; onPairingProgress(cb): void }`；`isTrustedWebRequest(req)`（Host 回环 + 非 cross-site + Origin/Host 同源）逐路由调用；端点：`GET /devices`、`POST /pair`、`DELETE /devices/:id`、`PATCH /devices/:id`（改名/启停/地址维护=hosts 整体替换）、`GET /events`（SSE：设备状态+配对进度）；生命周期随插件启关注销

- **最小 HTTP/UI 契约（Task 11/12 共享，两步须一致）**：
  - `GET /devices` 响应 `[{ deviceId, displayName, state, enabled, hosts, port }]`（**不含 `accessToken`**）
  - `POST /pair` 体 `{ payload, name? }` → **立即返回 202 + `{claimId}`（或配对会话句柄），验证码与终态经 SSE `pairing-progress` 事件推送（最长 120s；HTTP 不阻塞至 approved）**
  - `PATCH /devices/:id` 体 `{ displayName?, enabled?, hosts?, port? }`（**`hosts` 整体替换**，非增量合并；**`port` 为全部 `hosts` 共享（spec §3.2），非 per-host**）
  - SSE 事件类型 `device-state | pairing-progress`，载荷分别为 `{ deviceId, state }` / `{ stage, detail? }`；**订阅建立即推一帧当前全量状态（每设备一条 `device-state`）——客户端首连即有初始态可渲染（对齐 dsh-mcp-connector status-events 实物）**
  - **stage 映射注记**：`pairWithPayload` 的 `onStatus(stage)` 字符串 stage **直映射** `pairing-progress` 载荷的 `stage` 字段（不改名、不包装、不枚举化）；装配层桥接为 `onPairingProgress({stage})`

- [ ] **Step 1: 写失败测试**——①五端点往返（REST schema；`GET /devices` **响应不含 accessToken/tokenExpiresAt 字段断言**）；②fence 四分支各有断言：非回环 Host 拒绝 / 非同源 Origin 拒绝 / `sec-fetch-site: cross-site` 拒绝 / **Origin 缺失（非浏览器客户端）放行**；③SSE 推送**设备状态变化与配对进度**（MVP 载荷边界；「订阅事件摘要」为二期载荷，不在本任务范围）+ 客户端断开 → 清理无泄漏（Review Focus #5）；④PATCH hosts 整体替换生效；⑤disable→enable 设备状态流转；⑥插件禁用/卸载后路由不再响应（disposer 生效）——注册/注销生命周期断言
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——`webServer`/`webRuntime` 以 `ctx.inject(['webServer','webRuntime'], wctx => {...})` **动态注入**（**对齐 dsh-mcp-connector index.js 做法**）；不可用时（headless 部署）warn 降级跳过 HTTP 面注册，**不抛错**；disposer 在动态注入回调内管理；注册 `wctx.webServer.register({ kind: 'prefix', path: '/cherry-remote/api', handler })`（字段为 `path` 非 `prefix`；必须提供 `handler`；返回 disposer 用于插件禁用/卸载时注销——参照 dsh-mcp-connector/lib/web.js 实际用法）；SSE 用 `text/event-stream` + 心跳注释行
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**——`"feat: same-origin http api with trust fence and SSE"`

### Task 12: web client 设置页

**Files:**
- Create: `ui/`（`index.html` + `src/main.tsx` + `App.tsx` + `vite.config.ts`）
- Modify: `package.json`——① `exports` 增 `"./client": "./lib/client.js"`；② 增 `dsh` 字段完整形态：`"dsh": { "client": { "platform": "web", "inject": [] } }`（**`client` 是 `dsh` 对象的子键——顶层扁平键 `"dsh.client"` 会被宿主静默忽略**；`inject` 为**模块图行依赖预装载**声明——本插件无依赖的图行，留空数组；此前示例中的 UI 包名数组是**错误语义**，那两个 `@deepseek-ai/dsh-client-ui-*` 是宿主内建行、无 `./client` bundle，注入无效果）；**UI 注入点（layout/conversation）的服务依赖在 `lib/client.js` bundle 的 `exports.inject` 以模块短名声明**（参照 dsh-mcp-connector/lib/client.js 实物：`const inject = ["slots","sessions","workspaces","conversation"]` + 底部 `exports.inject = inject`）；③ scripts 增 `build:client`
- Test: `tests/unit/ui.test.ts`（组件级，jsdom）；**加载器解析冒烟（loader 冒烟，见 Step 4）归属本 task 构建产物验证——非契约测试语境**
- 构建产物：`ui/` 为**源码**（vite dev harness 用），发布产物为 `lib/client.js`（vite lib 模式构建，目标格式见 Interfaces）

**Interfaces:**
- Consumes: Task 11 的同源端点（`/cherry-remote/api` 相对路径）
- Produces: 设置页「Cherry Studio 互联」——配对向导（粘贴 payload + 图文指引 + 6 位验证码瞬态展示）、设备卡片（状态灯五态/启停/重命名/移除/地址维护）
- **client bundle 目标格式**：`window.__ModuleLoader__.load({ id, factory })` 包装（**对齐 dsh-mcp-connector/lib/client.js 实物**）；`react`/`react-dom` 外部化（宿主已加载，不打入 bundle）；**bundle 须导出 `exports.inject`（模块短名数组，而非 UI 包名）与 `exports.apply`——UI 注入点（layout/conversation）的服务依赖以短名声明**（参照 dsh-mcp-connector/lib/client.js 实物：`const inject = ["slots","sessions","workspaces","conversation"]` + 底部 `exports.inject = inject`）

- [ ] **Step 1: 写失败测试**——①配对向导提交 payload → **POST /pair 被调且立即回 202 + `{claimId}`（HTTP 不阻塞至 approved）**、验证码经 SSE `pairing-progress` 渲染、配对完成即消失；②设备卡片渲染状态灯五态 + 四操作各自 API 调用；③SSE 状态变化 → 卡片状态更新；**首帧渲染：连接建立即收到每设备一条 `device-state` 初始帧 → 未发生任何变化前卡片已渲染出当前全量状态**
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——React + fetch 相对路径；SSE 用 `EventSource('/cherry-remote/api/events')`；**构建脚本 `build:client`（`vite build --mode client` 产出 `lib/client.js`）**
- [ ] **Step 4: 运行确认通过**（`npx vitest run tests/unit/ui.test.ts` + **构建冒烟：`npm run build:client` 产出 `lib/client.js` 后，宿主加载本包无 `client-modules:` 报错 + 设置页入口出现；反向断言：临时移除 `exports['./client']` → 宿主抛 `declares dsh.client but exports no "./client" bundle`（`resolveMeta` 为私有方法，冒烟须经可观测外层）**）
- [ ] **Step 5: Commit**——`"feat: web client settings page with pairing wizard and device cards"`

### Task 13: M4 打磨——契约测试、diagnostics、发布

**Files:**
- Create: `tests/contract/contract.test.ts`、`src/diagnostics.ts`（`GET /diagnostics` 并入 httpApi 路由）、`docs/e2e-checklist.md`（E2E checklist：契约六项差异逐条人工核验 + 配对/发送/交互应答/断连恢复/多设备并存的真机步骤；**checklist 内容即以 Interfaces ① 的差异清单常量表六项为准逐条展开**）、`README.md`（发布用：安装/配置/工具与设置页说明）、`cordis.patch.yml`（**Create**——插入行 id `cherry-remote` + 默认配置键值：`perSessionCacheBytes: 2097152`、`rateBudgetPerSecond: 32`，即订阅缓存上限与请求队列参数，spec §8；**注：patch `config` 为整体替换而非合并——装配层须对缺键回落默认值（不得依赖 patch 与 bundle config 合并语义）**）
- Modify: `package.json`（发布字段——`files`/`prepublishOnly` build/README，并增嵌套 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；**dsh-plugin-manager 以 `manifest.dsh?.bundle?.patch` 识别 bundle patch——与 `dsh.client` 同根对象**）、`src/httpApi.ts`（diagnostics 端点并入路由注册处）
- Test: 契约测试本体

**Interfaces:**
- Consumes: fakeCherry 全量面
- Produces: ①契约差异清单建模（`connection.closed` 不发送、审批卡非实时入流、限流终止语义、**execution 终态不产生 interrupted（agentJournal 仅 completed/failed/cancelled）**、**command receipt status 可为 interrupted（命令在结果未定时）**、**⑥ RESOURCE_EXHAUSTED 注入例（回执上限维度）**——每项一个显式断言 fakeCherry 与真实协议 schema 的行为差异）；②`GET /diagnostics`（设备状态/连接统计/最近错误摘要，脱敏后输出）；③发布配置（files/prepublishOnly build/README）

- [ ] **Step 1: 写失败测试**——①契约六项差异各有断言（如：fakeCherry 收到 `connection.closed` schema 合法帧的 fixture 时客户端能处理，但契约标注真实对端不发送）；②**差异断言中显式列出 RESOURCE_EXHAUSTED 注入例：fakeCherry 模拟回执上限 → 客户端结构化透传该错误码、不崩溃**；③diagnostics 输出无 token/secret 字段；④**日志脱敏断言：对注入的 fake logger，断言全流程日志输出不含 token/invitationSecret/accessToken/消息文本/part 文本子串（锚定 §7-6/§5）**；⑤**版本 pin 断言：`package.json` 依赖为精确版本 `@cherrystudio/remote-protocol@0.3.0`、`@cherrystudio/remote-transport@0.1.2`（无 `^` 前缀，防 schema drift）**；⑥**`GET /diagnostics` 同样过信任 fence（四分支复用，Global Constraints 每路由自行实施）——非回环 Host / 非同源 Origin / `sec-fetch-site: cross-site` / Origin 缺失（放行）四例各有断言**；⑦**e2e-checklist 内容断言：`docs/e2e-checklist.md` 逐条覆盖契约六项差异的人工核验步骤（与①的自动化断言同一清单）**
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**——差异清单常量表 + diagnostics 聚合器（脱敏白名单：deviceId/desktopIdentity 摘要/sessionId 可出）；**日志分级约定：error=连接/认证/协议错误，warn=重连退避/缓存淘汰/限流退避，info=配对进度/订阅恢复/状态迁移（spec §5 清单）**
- [ ] **Step 4: 运行确认通过**（全量 `npm test`）
- [ ] **Step 5: Commit**——`"feat: contract tests, diagnostics endpoint, release config"`

---

## Self-Review 记录

1. **Spec 覆盖**：§3.1-3.7 → Task 3/4/5/6/7/8-10/11-12；§4 数据流散入对应集成测试；§5 → Task 3/4（0600）+ Task 11（信任 fence）+ Task 13（脱敏断言）；§6 错误表逐行锚定见下表；§7 → 各 Test + Task 13 契约（**§7.5 UI 冒烟 → Task 12（jsdom 组件级）**）；§8 → 脚手架/Task 13 发布；§9 M1-M4 → Task 1-5（M1）/6/11/12（M2）/7-10（M3）/13（M4）。无缺口。

   **§6 错误表逐行对照（错误表行 → 锚定 Task.Step）**：
   - 设备离线 → Task 5⑬（结构化错误 `{device,state}` + 不自动重试断言）+ Task 8①（五态封闭）
   - 邀请过期 / 被拒 → Task 6③（`expired` / `rejected` 透传）
   - 工具等待超时 → Task 9⑥
   - token refresh 失败 → Task 5⑨
   - 协议协商失败 → Task 5①（回执不一致面）+ Task 6⑥（Noise 前导交集为空的真实协商失败面）
   - CONFLICT 双表面 → Task 9④⑩
   - IDEMPOTENCY_CONFLICT → Task 9⑪（同 commandId 异参重发 → 对端 `IDEMPOTENCY_CONFLICT` 透传）
   - GRANT_REVOKED → Task 5⑩（authenticate 回 `GRANT_REVOKED` → offline + 提示重配对）
   - REVISION_EXPIRED → Task 8⑦（Step 3 重试路径为实现侧）
   - CHECKPOINT_EXPIRED / RESET_REQUIRED → Task 7⑤⑥，**CHECKPOINT_EXPIRED 另有显式注入锚 Task 7⑧（租约过期）与⑩（activate 回该码）**
   - TARGET_UNAVAILABLE → Task 9 Step 1⑮（对端拒绝回执透传 + 同 commandId 重试同样拒绝）
   - RESOURCE_EXHAUSTED → Task 13 契约（回执上限模拟）保持，并在 Task 13 Step 1 差异断言中显式列出该注入例；**订阅维度来源另由 Task 7⑨显式注入锚定（对端订阅上限 → LRU 淘汰重试）**
   - replay 超预算 → Task 7⑥（checkpoint 回退），**并另有显式注入锚 Task 7⑪（游标过旧被拒 → 对端回 checkpoint 模式 → 进入恢复链）**
   - 限流 → Task 5⑦⑧
   - 身份不匹配 → Task 5③
   - identity 密钥再生成 → Task 3③ + Task 5⑪（身份再生成后旧档案认证全败 → 全配对失效链路断言）
   - 地址不可达 → Task 6（配对期 `unreachable`）+ Task 5⑫（既有设备运行期面）
   - `cursor-out-of-window` → Task 7②（含窗口起点的结构化错误）

   补记：**M2 交付边界**：pairing + httpApi + web UI，不含任何 `cherry_*` 工具（`cherry_pair` 随 M3）——**M2 阶段工具面未交付；Task 11 的 pair 依赖直调 `pairWithPayload`（Task 6 产物），非经 `cherry_pair` 工具**；Task 11/12 依赖的 pairing 流程在 Task 6 已就绪。
2. **步骤扫描**：每步单一动作；算法性内容仅限协议正确性约束与流程方向（如 JSON-RPC 三分支判定顺序、修订号基线取值链、hello 同序比对判据），无代码正文转写。
3. **类型一致性**：`DeviceRecord`/`DeviceState`/`JsonRpcClient`/`SessionSubscriptions.read` 签名在 Task 4/5/2/7 定义并被 Task 8-11 按名引用 ✓
4. **Review Focus**：五项各有归属测试 ✓
5. **比例**：计划 ~13 任务 × 5 步，与 453 行 spec 相称；无代码正文转写。
6. **任务编号语义**：任务编号为逻辑分组（M1=1-5、M2=6/11/12、M3=7-10、M4=13），非严格执行顺序——按编号顺序执行时 M3 先于 M2 的 11/12 完成，无依赖冲突（11/12 仅依赖 ≤Task 6）；如需按里程碑交付，执行顺序调整为 1-6 → 11 → 12 → 7-10 → 13。**M2 顺序装配归属**：按 1-6 → 11 → 12 里程碑顺序执行时，`index.ts` 的连接池/identity/store **最小装配**需**提前**（identity/store/连接池初始化提前至 Task 11 前完成，或由 Task 6 后的最小 `index.ts` 提供——Task 10 才完整装配）。
