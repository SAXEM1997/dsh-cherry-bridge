# dsh-cherry-bridge 设计文档

- 日期：2026-10-09
- 状态：待用户审阅
- 路径分类：Architectural（新插件子系统）

## 1. 目标与背景

做一个 DeepSeek Harness（DSH）插件 `dsh-cherry-bridge`，让 DSH 中的 agent 能与
Cherry Studio 桌面端的 Agent 会话交互，并支持配对、管理多台 Cherry Studio 桌面实例。

依据：Cherry Studio 2.x「设备互联」功能（`src/main/services/remoteAccess/`、
`packages/remote-protocol`、`packages/remote-transport`）。该功能将桌面端的 Agent
会话能力通过局域网加密信道暴露给配对设备（官方移动端即以此接入），协议以 npm 包
`@cherrystudio/remote-protocol`、`@cherrystudio/remote-transport` 公开发布，第三方可
以客户端身份接入。Cherry Studio 的 Agent 会话可运行于三种 runtime
（claude-code / pi / dsh），`agent.*` 协议层是 runtime 无关的中立抽象。插件交互的
对象是会话（经 `agent.*` 抽象），不感知也不依赖对端 runtime 选型。

### 身份与命名

Cherry Studio 自带一个反向桥 `@cherrystudio/dsh-bridge`（插件 id `cherry-bridge`，
方向为 Cherry 主进程驱动内嵌 DSH 运行时）；本插件方向相反——DSH 作为客户端连接
Cherry 桌面端。为避免同一 DSH profile 中插件 id 冲突与运维混淆，本插件取 id
`cherry-remote`、包名 `dsh-cherry-bridge`（`dsh` 前缀标明宿主方向）。

### 用户已确认的决策

- 交互形态：**DSH agent 工具化操控**——在 DSH 对话中通过 `cherry_*` 工具列出、读取、
  驱动 Cherry Studio Agent 会话，等待并取回回复。
- 多端语义：**多个 Cherry 桌面实例**——同时配对管理多台（如公司机+家里机），各自独立
  状态与会话树，在 DSH 内统一管理与切换。
- 配置能力（configuration 域，服务商/密钥/模型导出）：**MVP 不做**，留待后续版本。
- 交付定位：**完整社区插件**，发布 npm，含服务端连接管理、工具面、web 配置 UI。
- 主方案：**方案 A 协议原生客户端**（零改动对端）。备选方案界定——B：Cherry 网关
  OpenAI 兼容端点作 DSH 的 LLM provider（仅模型代理，二期可选）；C：分叉 Cherry
  加私有控制面（否决）。

### 明确出界与推迟

**出界（不在当前产品方向）：**

- 普通聊天 topic 的交互（remote 协议不覆盖，仅 Agent 会话）
- 把 DSH 会话反向镜像到 Cherry Studio
- 经 Cherry 中转触达其配对的移动设备

**MVP 推迟（后续版本）：**

- configuration 域的导入/导出（对应上方「用户已确认的决策」中 MVP 不做项）

## 2. 总体架构

```
┌─ DSH Web GUI ──────────────────────────────────────────┐
│  设置页「Cherry Studio 互联」                            │
│  · 配对向导（粘贴二维码 payload JSON）                   │
│  · 设备卡片：状态灯 / 启停 / 重命名 / 移除 / 地址维护    │
└───────────────┬─────────────────────────────────────────┘
                │ 插件 HTTP 面（宿主同源路由，REST + SSE）
┌───────────────▼─────────────────────────────────────────┐
│  dsh-cherry-bridge（dsh 进程内 Cordis 插件）              │
│  identity / deviceStore / pairing / connection /         │
│  subscriptions / tools / httpApi + web client（设置页 UI）│
└───────────────┬──────────────────────────────────────────┘
                │ ws://<host>:<port>/v1/remote/connect
                │ （Noise XX 加密记录，JSON-RPC 2.0）
      ┌─────────┴─────────┬──────────────┐
      ▼                   ▼              ▼
 Cherry 桌面 A        Cherry 桌面 B   Cherry 桌面 C
```

要点：

- 一台 DSH profile 持有**一个** Ed25519 设备身份；对每台 Cherry 桌面各建一条常驻
  加密连接。对端连接预算为 32 条 / 每地址 4 条、64 req/s，插件侧以请求队列对齐
  （见 §3.4）。出处层级（两层，不得混用）：
  - **协议预算项**（分页/订阅/重放/心跳等）：以 `connection.hello` 返回的
    `limits`/`heartbeatMs` 为准。注意 `limits` 为**单向报告**而非协商——当前
    报告值即协议 `remoteLimits` 常量原样回传，协议无协商消费方（仅
    `protocolVersions` 参与协商）；插件按回报值自适应、**不得硬编码**这些数字，
    且须容忍键缺失（缺键时回落保守默认）。限额项含：分页上限 `pageItems`、
    每连接订阅上限 `subscriptions`、在途请求上限 `inFlightRequests`、
    未确认事件字节预算 `unackedBytes`、重放保留窗口 `replayBytes`/`replayMs`、
    心跳 `heartbeatMs` 等（均为协议承诺值）。
  - **服务端实现值**：连接数预算（32 条 / 每地址 4 条）与请求速率（64 req/s）为
    Cherry 服务端当前实现值（**非**协议 `remoteLimits` 承诺，可能随版本变化），
    **无协商通道**；插件按保守值设计，并将对端拒绝（close code 1013）与会话终止
    视为权威信号。
- 配对即绑定：payload 携带的 `desktopIdentity` 被 pin 进设备档案，此后每次连接都校验
  Noise 对端静态公钥与 pin 一致（防二维码劫持后的中间人替换）。
- 每设备仅申请 `agent` capability（MVP 不申请 `configuration`）。

## 3. 组件设计

插件为 Cordis bundle：`cordis.patch.yml` 插入行，id `cherry-remote`（呼应协议发现
类型 `remoteDiscoveryType` 的 mDNS/Bonjour 服务类型标识）。形态为服务端 Node 插件
+ web client（`dsh.client` 注入 UI，参照 dsh-mcp-connector 模式）。

### 3.1 identity.ts

- `createDeviceIdentity()`（`@cherrystudio/remote-transport`）生成本机身份。
- 持久化为插件数据目录下的密钥文件，权限 0600；损坏/缺失时重新生成；对端仍持有
  旧身份档案会持续认证失败，需用户在各 Cherry 端手动移除本设备后重新配对（见 §6）。

### 3.2 deviceStore.ts

设备档案（JSON，插件数据目录），每设备字段：

| 字段 | 说明 |
|---|---|
| `deviceId` | 配对成功后对端分配的设备 ID |
| `displayName` | 用户可改名 |
| `hosts[]` + `port` | 候选地址（来自二维码 ips，允许增删）；MVP 仅支持 `ws` 传输（加密由 Noise 记录层提供）且所有候选地址共享同一 `port`；协议 `directEndpointSchema` 允许的 per-endpoint 独立 port 与 `wss` 列为后续版本 |
| `desktopIdentity` | pin 的对端身份（必填，校验 Noise 对端公钥） |
| `grants` | 授权域（MVP 恒为 `['agent']`） |
| `accessToken` / 过期时间 | 凭据，UI 不回显 |
| `enabled` | 启停开关（停用即断开不删档） |

地址维护：主入口为 web UI 设备卡片「地址维护」与 `PATCH /devices/:id`（端点见 §3.7，
hosts 数组整体替换）；手工编辑数据文件仅为兜底。

档案版本化：设备档案带 schema 版本号，升级时惰性迁移（读取时检测旧版并升级
写回），迁移逻辑随版本演进（对应 §7 单元测试的「deviceStore 读写/迁移」）。

### 3.3 pairing.ts

配对流程（UI 与 `cherry_pair` 工具共用流程实现；入口分阶段交付——M2 仅 web UI
配对向导，`cherry_pair` 工具随 M3 工具面交付，见 §9）：

1. 解析并校验 payload：`v===2 && t==='cherry-studio-pair'`，取
   `ips/port/invitationId/invitationSecret/desktopIdentity/protocolVersions`。
   payload 的 `ips` 来自二维码（Cherry 端生成时已排除 scoped 与 link-local
   IPv6）；IPv6 字面量可能为方括号形态，入库时须规范化（统一存不带方括号的
   host 字符串，连接时再按需加括号）。payload 可能含本设计未采纳的字段（如
   `name` 主机名），解析时忽略未知字段、仅校验与消费清单内字段。
2. 建立临时加密连接（对任意候选地址依次尝试），`connection.hello` 版本确认（语义见 §3.4）。
3. `pairing.claim`：`platform:'desktop'`、`capabilities:['agent']`、本机设备名
   （默认取 hostname，可由 `name` 参数覆盖）。
4. 将返回的 6 位 `verificationCode` 醒目呈现给用户（UI 卡片 / 工具结果文本），
   用户在 Cherry 桌面端核对一致后批准。
5. 轮询 `pairing.get` 至 `approved`（存 deviceId/grants/accessToken 入档案）或
   `rejected` / `expired`；邀请 120s 到期统一表现为 `expired` 状态（`pairing.get`
   返回 `expired`，非本地超时报错）。
6. 成功后销毁临时连接，转入常驻 connection。

### 3.4 connection.ts

每设备一个连接对象：

- WebSocket 连接 `ws://<host>:<port>/v1/remote/connect` →
  `connectSecureChannel()`（Noise XX 发起方，`identity` 为本机身份；握手完成后校验
  对端静态公钥与档案 pin 一致，不一致立即断开并标记设备 `identity-mismatch`）。
- `connection.hello`（协议版本**确认**——版本协商实际发生在 Noise 前导；hello 须原样回传握手时 offered 的 protocolVersions，两处须恒等，否则对端报 INVALID_CONNECTION_STATE）→ `connection.authenticate` → 获得
  accessToken。注：accessToken 当前有效期为 10 分钟——为协议 `tokenMs` 承诺值的
  当前值；refresh 调度以 `authenticate`/`refresh` 返回的实际 `expiresAt` 为准，
  不硬编码时长。到期前自动 `connection.refresh`（30s 宽限内重试）。
- 心跳：按 `hello` 返回的 `heartbeatMs`（默认 20s）`connection.ping`。
- 断线：指数退避重连（封顶 60s）；重连成功后重认证并触发订阅恢复。
- 恢复路径相互独立，状态机互不隐含：
  - **连接存活但 token refresh 失败**：在 refresh 30s 宽限窗口内重试；超时后设备
    转 `offline`，提示检查对端是否移除了本设备（见 §6）。
  - **连接断开**：指数退避重连 → 重新 `connection.authenticate` → 活动订阅以
    最后游标恢复（见 §4.3）。
- 请求队列：per-device 有界并发窗口（在途请求 ≤ 8。注：协议在途上限为 hello 回报
  的 16（出处层级见 §2），取其保守一半以预留心跳、token refresh、订阅 ack 等内务
  RPC 通道），并在秒级窗口内平滑注入速率。注意：64 req/s 超限的后果是对端**直接终止整条会话**（而非拒绝
  单个请求），故速率控制必须保守，避免 DSH agent 并发调用触发对端限流。
  多设备并发时 per-device 队列各自独立、无跨设备全局调度；对端按连接维度裁决
  速率，任一连接超限即被终止（不影响其他设备连接）；如未来需要全局速率预算，
  列为后续版本（当前以保守单设备速率 + 多设备天然分连接为限流边界）。
- 断线判定：主信号为底层 WebSocket `close` 事件与 ping 静默超时（约 2×`heartbeatMs`
  无 ping 响应即判定断线），命中任一即按失败原因更新设备状态并进入重连流程。
  注：协议 schema 定义了 `connection.closed` 通知，但当前 Cherry Studio 服务端
  实现（remote-protocol 0.3.0 线）从不发送，插件**不得依赖**它；仅当未来服务端
  版本启用该通知时，作为辅助信号（按携带的失败码细化状态）处理。
- 注记：MVP **不使用** `connection.endpoints`（候选地址由设备档案维护，见 §3.2）。
  该方法入参携带 capability domain 且服务端按已授权能力校验；未来启用时必须以
  已授权域（`agent`）调用（已登记 §9 后续版本项）。

### 3.5 subscriptions.ts

- 按需订阅：所有依赖会话快照/游标的工具——`cherry_send(wait)`、`cherry_wait`、
  `cherry_events`、`cherry_read`（依赖订阅缓存的修订基线）——首次使用某会话时调用
  `agent.sessions.subscribe(cursor?)`；对端订阅上限以 hello 回传
  `limits.subscriptions` 为准（当前报告值 8，出处层级见 §2），插件侧 LRU 淘汰
  不活跃会话的订阅（close 释放）。`cherry_events` 首次调用即建立订阅并计入 LRU
  池（与 send/wait 同池）；纯轮询型消费会占用订阅额度——LRU 淘汰不活跃会话订阅
  即为缓解，被淘汰后下次调用重建（可能入 checkpoint 模式）。
- 协议约束：同一连接对同一会话**不可重复订阅**（对端返回 CONFLICT）。断线重连后
  为新连接可直接 subscribe；但同连接内的重订阅须先 `agent.subscriptions.close`
  释放旧订阅。
- 维护每会话游标，事件处理后 `agent.subscriptions.ack`。
- `agent.events` 批量通知分发：更新会话内缓存（消息/part 快照），唤醒等待中的
  `cherry_send`/`cherry_wait`。
- `agent.subscriptions.resetRequired` → 重新 subscribe；对端回 `checkpoint` 模式时走
  `agent.checkpoints.read` 重建**投影状态**（分页读取检查点内容，其 nextCursor 为分页
  游标而非流游标）后 `subscriptions.activate`。
- 协议约束：`agent.subscriptions.activate` 的 `appliedCursor` 必须与 subscribe 准备
  阶段返回的游标一致，否则对端返回 CONFLICT 或 RESET_REQUIRED；checkpoint 恢复路径
  中 `appliedCursor` 只能以 **subscribe 返回的 checkpoint 描述符内游标**为准（不得
  使用 `checkpoints.read` 的分页 nextCursor）再 activate。
- 会话事件缓存为插件侧策略（默认每会话 2MiB 事件文本），独立于协议层预算：未确认
  事件字节预算 unackedBytes 256KiB（订阅信用窗口）与重放保留窗口 replay 8MiB/5min
  （服务端重放能力）。插件缓存超限丢最旧并记录，不影响协议预算语义。插件缓存上限
  （2MiB/会话）刻意小于对端重放窗口（8MiB/5min），保证缓存窗口内丢失的游标在
  **字节维度**上倾向可经重放恢复；重放逐出还受时间维（5min）与全局字节预算
  （跨会话）约束，超限时回落 checkpoint 恢复路径（见 §4.3）。

### 3.6 tools.ts（工具面）

注册到 `ctx.tools`，前缀 `cherry_`，`device` 参数一律为设备显示名或 deviceId。

工具命名约定：全部 `cherry_*` 短名形式，列表语义不带 `_list` 后缀（如
`cherry_sessions`）；`cherry_send` 等动作语义直用动词。

`device` 参数解析：优先精确匹配 deviceId；显示名仅在前缀唯一匹配时生效，歧义
（重名/多前缀命中）时返回结构化错误并列出候选，要求以 deviceId 指定。

分页通用约定：凡行为列标注分页的工具，分页上限以 `connection.hello` 回报的
`limits` 为准（当前报告值 100，协议常量 `remoteLimits.pageItems`），插件不得
直接硬编码常量（出处层级见 §2），`limit` 参数以此为上限、超出自动分页聚合。

| 工具 | 参数 | 行为 |
|---|---|---|
| `cherry_devices` | — | 列设备 + 连接状态（`connected`/`connecting`/`offline`/`disabled`/`identity-mismatch`）；状态全集（封闭）；密钥损坏再生成后的既有设备落 `offline` 并要求重新配对（见 §3.1/§6） |
| `cherry_pair` | `payload`, `name?` | 执行 §3.3 配对流程；结果含验证码与最终状态 |
| `cherry_agents` | `device` | `agent.agents.list`（分页，通用约定见上） |
| `cherry_sessions` | `device`, `agentId?`, `workspaceId?`, `limit?` | `agent.sessions.list`（分页，通用约定见上） |
| `cherry_read` | `device`, `sessionId`, `limit?` | 两级前置流程：`agent.sessions.get` 取 `historyRevision` 基线 → `agent.messages.list`（该参数为协议必填）→ 对每条消息以其 `messageRevision` 调 `agent.parts.list`，聚合文本快照。大文本外置路径：part 内容超过对端阈值时由 `{text}` 变为 `{ref}` 引用形态，此时须经 `agent.content.read` 分页读取（每次 ≤24KiB、带 sha256 校验、offset/nextOffset/eof 游标），聚合进读取结果 |
| `cherry_create` | `device`, `agentId`, `title?`, `workspace: {workspaceId（registered）\| 'system'}`（必填二选一） | `agent.sessions.create`（幂等 commandId）；两种 workspace 选择形态一一映射协议判别式选择；协议两个 union 分支均必填 workspace 选择，无『未指定』形态——工具面要求显式选择（registered 以 workspaceId、系统工作区以 'system' 字面量），插件侧不做隐式默认，创建回执仅含 sessionId——实际 workspaceId/workspaceKind 须经 `agent.sessions.get` 二次调用回读 |
| `cherry_send` | `device`, `sessionId`, `text`（协议上限 32,768 字符，超长对端拒绝——工具面前置校验并提示分段）, `wait=true`, `timeoutMs=120000` | 见下 |
| `cherry_wait` | `device`, `sessionId`, `timeoutMs?` | 纯等待：不发送消息，等待该会话执行到达终态或超时，返回与 `cherry_send(wait=true)` 相同形态的结果；会话无进行中执行时立即返回当前快照（不报错、不等待）；缺省 `timeoutMs` 同 `cherry_send` 默认（120000） |
| `cherry_workspaces` | `device`, `agentId` | `agent.workspaces.list`（分页，通用约定见上）：**registered 工作区的发现路径**，结果附 `systemWorkspace` 存在性标志；系统工作区不在分页项内、无枚举 ID，其身份只能经 `cherry_create(workspace:'system')` + `agent.sessions.get` 两步回读——不得将系统工作区回读 ID 误按 registered 语义复用；已知取舍：系统工作区身份的获取必须以创建会话为代价（无副作用探测途径），需要频繁探测的场景应缓存回读结果 |
| `cherry_events` | `device`, `sessionId`, `cursor?` | 读订阅缓存中自游标以来事件；传入游标早于缓存窗口起点时返回结构化错误 `cursor-out-of-window`（含当前窗口起点）（插件侧缓存窗口错误，区别于 §6 协议侧 CONFLICT 的订阅游标冲突），建议消费方改用 `cherry_read` 拉快照重建基线 |
| `cherry_interactions` | `device`, `sessionId` | `agent.interactions.list` 过滤待答 |
| `cherry_respond` | `device`, `sessionId`, `interactionId`, `decision`（approve/deny）或 `response`（结构化回答） | `agent.interactions.respond`（两种形态均须携带 `expectedRevision`/`expectedExecutionId`/`inputDigest` 三重校验参数，协议必填；区分审批类 decision 与提问类 response，按问题键值作答） |
| `cherry_cancel` | `device`, `sessionId`, `expectedExecutionId` | `agent.executions.cancel`（`expectedExecutionId` 为协议必填，服务端据此校验目标执行；取自订阅缓存或 executions 事件的当前执行 ID） |
| `cherry_unpair` | `device` | 删除设备档案并断开（对端侧由用户在 Cherry 移除）⁽¹⁾ |

⁽¹⁾ 协议 0.3.0 无客户端发起的对端解除配对 RPC；对端设备档案残留由用户在 Cherry Studio
设置页手动清理（含级联的命令回执清理）。

**question 可达性注记**：`kind:'question'` 仅在 claudeCode-runtime 会话（对端
`AskUserQuestion` 工具）下可达；DSH-runtime 会话的 plan-review 以 `kind:'decision'`
形式出现（桥接仅支持单条问题）；pi-runtime 无 question 路径。插件**不假设** question
普遍存在，交互一律按 `kind` 自适应呈现。

**question 应答契约**：①`question` 类交互必须以
`response:{kind:'answer', answers}` 应答，question 类**不得以 approve 应答**（对端拒绝）；作答用
`response:{kind:'answer', answers}`，放弃用 `decision:'deny'`（对端接受，正常落账
denied）——deny 是③回退路径的依据；②`answers` 为以每条 question 的问题文本为 key 的 record，
所有 question 必须全部回答；③协议层 `answers` 由对端转换为宿主**完整**工具输入对象
（全量替换）——无法构造完整输入时回退 deny，不得部分提交。

`cherry_send` 语义（收敛为「发送 + 可选等待终态」；纯等待见 `cherry_wait`）：

- `wait=true`（默认）：发送后等待该会话执行到达终态（成功/失败/取消/中断
  （`interrupted`）四种，协议 schema 终态全集，
  `execution.updated` 终态事件）或超时；终态后聚合助手最终消息文本作为工具结果。
  注：当前服务端版本不产生 `interrupted`，但契约已 pin schema，谓词须覆盖全集以防
  挂起至超时。
  期间出现**任何未应答的挂起交互**（提问类 question 或审批类 decision，经实时
  `interaction.updated` 入流）即视为软终态，提前返回「等待应答」+ 交互摘要
  （标注 kind），agent 继续用
  `cherry_interactions` + `cherry_respond` 处理后可调 `cherry_wait` 恢复等待
  （空转语义与发送解耦）或直接 `cherry_events` 轮询。
- `wait=false`：立即返回命令回执（commandId/状态）。
- `timeoutMs=120000` 为默认值而非上限，调用方可按需调大调小。
- 超时不是失败：返回已收到的部分内容 + 当前游标，agent 可续查（§6 错误表同义引用本条）。
- 大文本外置路径见 `cherry_read` 行为定义（{ref}/content.read/24KiB/sha256/游标），
  发送与等待结果中的大文本 part 同样经该路径聚合。
- 协议行为注记：审批类交互卡若在回合结束后才持久化，不会以 `interaction.updated`
  实时入流（仅可经 `agent.interactions.list` 查询并应答）；`cherry_wait`/`cherry_send`
  的等待判定依据实时入流的挂起交互，不依赖这类非实时的持久化审批卡（仅经
  `cherry_interactions` 查询发现）。

### 3.7 httpApi.ts + web client

- 插件 HTTP 面挂载到宿主 Web 服务器的同源前缀，路由前缀为既定值
  `/cherry-remote/api`（下述端点均为该前缀下的短路径），web
  client 以同源相对路径访问（如实对齐 dsh-mcp-connector 实际做法）。端点：
  - **MVP 端点（M2）**：`GET /devices`、`POST /pair`、`DELETE /devices/:id`、
    `PATCH /devices/:id`（改名/启停/地址维护）、`GET /events`（SSE）
  - **M4 端点**：`GET /diagnostics`（运维诊断，见 §5 可观测性）
- **信任边界分工（用户已确认）**：宿主提供 `ctx.webServer` 同源注册能力与回环
  监听；**同源/回环校验由插件在每条路由自行实施**（对齐 dsh-mcp-connector 的
  `isTrustedWebRequest` 做法：Host 回环 + 非 cross-site + Origin/Host 同源
  判定）。插件**无独立端口、无 token、无引导文件、无落盘凭据**；web client
  与插件 HTTP 面天然同源，无需额外的发现与鉴权通道。
- **同源路由生命周期**：路由前缀随插件启用注册、禁用/卸载时注销；无端口冲突
  递增/引导文件原子更新等存量问题。
- `GET /events`（SSE）载荷范围：MVP 仅承载设备状态变化与配对进度；「订阅事件
  摘要」为二期载荷（随会话浏览器交付），当前订阅事件仅供工具面消费。
- web client（`dsh.client`，注入 layout/conversation）：设置页「Cherry Studio 互联」。
  配对向导粘贴 payload JSON（附二维码内容获取路径的图文指引）；设备卡片含状态灯、
  启停/重命名/移除/地址维护；配对向导/配对进行中的卡片展示 6 位验证码（配对完成
  即消失）。会话浏览器（列会话+读消息）为二期可选。

## 4. 数据流

### 4.1 配对

配对数据流：UI/工具入口 → pairing.ts 解析 payload（含 IPv6 规范化）→ 临时连接
hello → claim →（桌面端人工批准 + 验证码核对）→ `pairing.get` 轮询至 `approved` →
档案入库 → 常驻连接接管。各步细节见 §3.3（含邀请 120s 到期语义）；UI/工具需提示
「先在 Cherry 端生成二维码再粘贴」。

### 4.2 发送并等待

`cherry_send(wait)` → subscriptions 确保订阅（携带缓存游标；缓存缺失时先
`agent.sessions.get` + `agent.messages.list` 对齐基线，无游标首订可能入 checkpoint
模式）→ 请求队列 → `agent.messages.send({commandId, text,
expectedIdleRevision})` → 收 `agent.events`
（`part.append` 增量、`execution.updated`、`interaction.updated`、终态）→ 终态聚合
返回。`expectedIdleRevision` 取订阅缓存最新值。大文本外置路径见 `cherry_read`
行为定义。典型顺序：先经
`cherry_workspaces`（`agent.workspaces.list`）枚举 workspace，再以 workspaceId 过滤
列举会话；需系统工作区时经 `cherry_create(workspace:'system')` 显式选择，经 create + `agent.sessions.get` 两步回读身份。

### 4.3 断线恢复

重连 → 重新 authenticate → 活动订阅以最后游标 `subscribe(cursor)` → 对端 replay
或 checkpoint 模式（后者经 `checkpoints.read` 重建投影状态，`activate` 的游标来源为
subscribe 返回的 checkpoint 描述符内游标）→ `subscriptions.activate`。

## 5. 安全设计

- 身份 pin（见 §3.4）；能力最小化（仅 `agent`）。
- 敏感持久化分类与权限：
  - identity Ed25519 密钥文件：0600；
  - 设备档案 JSON（含 accessToken/grants）：0600 或目录级限制。
  UI 对以上两类均不回显敏感值。
- 6 位验证码双向人工核对是配对的人因防线，UI 与 `cherry_pair` 结果均醒目展示。
- `cherry_respond` 允许 DSH agent 代替用户批准 Cherry 端审批，存在滥用面。MVP 不做
  额外拦截层（信任 DSH 自身 approval（工具调用审批）体系约束 agent 行为）；**已知限制**记录
  于本文档，二期可加「审批类应答需经 DSH 侧 ask_user_question 确认」的 gate。
- 插件 HTTP 面复用宿主 Web 服务器同源路由（回环 + 同源信任边界），不新增独立
  监听与凭据，不暴露局域网（详见 §3.7）。

**可观测性与诊断**

- 日志分级：error（连接失败/认证失败/协议错误）、warn（重连退避/缓存淘汰/限流
  退避）、info（配对进度/订阅建立与恢复/设备状态迁移）。
- 敏感字段脱敏原则：token、invitationSecret、accessToken、消息内容与 part 文本
  一律不入日志；设备身份（deviceId/desktopIdentity 摘要）与 sessionId 可记。
- 订阅缓存淘汰等「记录」条目（见 §3.5）落入插件日志。
- 诊断信息获取途径：同源路由下的 `GET /diagnostics`（前缀见 §3.7）端点（字段范围见
  本节，M4 交付，服务于社区插件的运维诊断需求），汇总设备状态/连接统计/
  最近错误摘要，按上述脱敏原则处理后输出。

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| 设备离线 | 工具返回结构化错误 `{device, state}`；不自动重试轰炸 |
| 邀请过期/被拒 | 过期语义见 §3.3（120s 到期统一表现为 `expired` 状态）；明确提示在 Cherry 端重新生成二维码 / 核对验证码 |
| 工具等待超时（`cherry_send`/`cherry_wait` 的 `timeoutMs`） | 非失败，语义见 §3.6 `cherry_send` 定义（返回部分内容 + 当前游标，agent 可续查） |
| token refresh 失败 | 设备转 `offline`，提示检查对端是否移除了本设备 |
| 协议协商失败 | 报版本不兼容，提示升级 Cherry Studio / 插件 |
| 幂等冲突·CONFLICT（状态机冲突，如重复订阅/订阅状态机游标不匹配（appliedCursor 与准备游标不一致）） | 透传协议 CONFLICT 错误码；提示检查状态机序列（先 close 释放旧订阅、对齐游标后再重试）；注意命令类冲突（respond/send/cancel 的状态机不匹配）以**命令回执** `status:'rejected'` + error 携带，而非 RPC 错误——两种表面须分别处理 |
| 幂等冲突·IDEMPOTENCY_CONFLICT（同 commandId 不同参数重试） | 透传协议 IDEMPOTENCY_CONFLICT 错误码；提示更换新 commandId 重发，不得以异参复用同一 commandId |
| GRANT_REVOKED（授权被对端撤销） | 设备转 `offline`，提示重新配对 |
| REVISION_EXPIRED（修订号过期） | 重新拉取基线（sessions.get/messages.list）后重试 |
| CHECKPOINT_EXPIRED / RESET_REQUIRED（订阅/检查点失效） | 重新 subscribe，走 checkpoint 恢复路径 |
| TARGET_UNAVAILABLE（分发目标校验失败） | 命令被拒；以同 commandId 重试返回同样拒绝，须修正目标后换新 commandId |
| RESOURCE_EXHAUSTED（对端资源预算耗尽，如命令回执达上限） | 提示清理（对端移除设备级联清理回执）或等待预算恢复 |
| replay 超预算（8MiB/5min） | 自动走 checkpoint 恢复路径 |
| 限流 | per-device 队列退避 |
| 身份不匹配 | 断开并标记 `identity-mismatch`，要求人工重新配对 |
| identity 密钥损坏/缺失再生成 | 全部既有配对失效（对端仍持有旧身份档案，会持续认证失败）；需用户在各 Cherry 端手动移除本设备后重新配对（与 §3.1 行为呼应） |
| 候选地址全部不可达/网络迁移地址漂移 | 设备转 `offline`；提示经设备卡片「地址维护」更新候选地址（二维码重扫或手工），网络恢复后自动重连 |
| `cursor-out-of-window`（插件侧：`cherry_events` 传入游标早于订阅缓存窗口起点） | 返回结构化错误并附当前窗口起点；建议改用 `cherry_read` 拉快照重建基线（见 §3.6） |

## 7. 测试策略

1. 单元：payload 解析、deviceStore 读写/迁移、工具参数 schema 校验（工具参数以字面
   JSON Schema 声明，遵循 DSH 工具面约定；zod 仅用于协议侧与自有持久化数据）。
2. 集成（自环）：测试内以 `acceptSecureChannel` + 内存 WebSocket 对起假 Cherry 端
   （hello/authenticate/pairing/agent.* 最小面，复用协议包 zod schema 做服务端校验），
   覆盖：配对全流程、发送等待终态、事件游标 ack、断线重连与 checkpoint 恢复、
   幂等冲突、限流退避；以及交互应答契约与软终态流——question answer 全答/缺键拒绝/
   approve-on-question 拒绝/deny 回退，挂起交互软终态（`interaction.updated` →
   提前返回 → respond → `cherry_wait` 恢复等待）。错误表映射用例（对应 §6 各行）：
   identity 密钥再生成致全配对失效、`identity-mismatch` 状态迁移、
   `cursor-out-of-window`、`REVISION_EXPIRED` 重拉基线重试。
3. 契约：pin `@cherrystudio/remote-protocol`/`remote-transport` 版本；升级时跑契约
   测试防 schema drift。契约测试须显式建模自环假对端与真实 Cherry Studio 的行为
   差异清单（如 `connection.closed` 不发送、审批卡非实时入流、限流终止语义、
   当前服务端不产生 `interrupted` 终态但契约已 pin schema），
   差异项权威来源为 §3.4/§3.6 相应注记，此处为汇总；
   差异项在手动 E2E checklist 中对应覆盖。
4. 手动 E2E：真实 Cherry Studio 配对（Electron 端人工批准无法 CI 化），发布前走
   checklist（配对/发送/交互/断连恢复/多设备并存）。
5. httpApi 与 web client：接口契约测试（REST 端点 + SSE 载荷 schema、同源路由注册/
   注销生命周期）；web client UI 冒烟（配对向导/设备卡片渲染与状态灯）。对齐 M2/M3
   交付物（工具集清单见 §9）。
6. 安全与可观测性：敏感字段不入日志的脱敏断言（见 §5 可观测性）；同源路由信任边界
   （非同源/非回环拒绝）。

## 8. 依赖与发布

- 运行时依赖：`@cherrystudio/remote-protocol`、`@cherrystudio/remote-transport`
  （携带 libp2p noise 栈，纯 JS）、`ws`（Node WebSocket 客户端；与
  `RemoteSocketStream` 的 EventTarget/backpressure 适配层验证为 M1 前置门
  （见 §9），须逐项对齐 RemoteSocket 语义——注意 `ws` 在
  `@cherrystudio/remote-transport` 中仅为 devDependency，插件须
  自带 `ws` 运行时依赖；MVP 仅使用 `ws://` 传输，加密由 Noise 记录层提供）。
  `@cherrystudio/remote-protocol` 将 `zod` 声明为 peerDependency，插件须自带
  `zod`（`^4.3.4`）并与协议包要求版本对齐。
- 客户端 RPC 层归属：`@cherrystudio/remote-transport` 仅导出 RPC **Server**
  （`RemoteRpcServer`）与安全信道原语，**不导出** RPC 客户端——插件的 JSON-RPC 2.0
  客户端层（请求-响应关联、通知分发、批量限制）为**自研组件**，基于 `SecureChannel`
  读写 + 协议包的 `jsonRpc*Schema` 校验构建。
- 发布：npm 包 `dsh-cherry-bridge`；`cordis.patch.yml` 插入行（id `cherry-remote`，
  默认配置：订阅缓存上限、请求队列参数）；`dsh.client` web UI。
- 安装：`dsh plugin --profile <name> add dsh-cherry-bridge` 或 profile 手工加行。

## 9. 里程碑切分（供实施计划参考）

- M1 通道底座：identity/deviceStore/connection（hello/auth/refresh/心跳/重连）+
  自环集成测试。交付清单：**JSON-RPC 客户端层（自研）**——`@cherrystudio/remote-transport`
  不导出 RPC 客户端（见 §8），请求-响应关联、通知分发、批量限制均须自行实现，
  并同样纳入下述前置门验证范围。**前置门**：Node WebSocket（`ws`）与
  `RemoteSocketStream` 的
  适配层验证必须先于 M1 完成，适配不成立则 M1 不得标记完成；适配层须逐项对齐
  以下语义：`binaryType='arraybuffer'`、ArrayBuffer 二进制帧、`bufferedAmount`
  背压、`readyState` 状态机；自研 JSON-RPC 客户端层亦须在 M1 前置门中验证
  （请求-响应关联、通知分发、批量限制，基于 `SecureChannel` 读写 +
  `jsonRpc*Schema` 校验）。
- M2 配对与设备管理：pairing + httpApi + web UI 设置页。httpApi 交付同源路由
  端点集合：`GET /devices`、`POST /pair`、`DELETE /devices/:id`、
  `PATCH /devices/:id`、`GET /events`（SSE）（清单见 §3.7）。本阶段配对入口
  仅 web UI 配对向导。
- M3 工具面：tools.ts 全量 + subscriptions + 自环覆盖发送等待/恢复/幂等。
  工具面交付清单：`cherry_devices`/`cherry_pair`/`cherry_agents`/
  `cherry_workspaces`/`cherry_sessions`/`cherry_read`/`cherry_create`/
  `cherry_send`/`cherry_wait`/`cherry_events`/`cherry_interactions`/
  `cherry_respond`/`cherry_cancel`/`cherry_unpair`。
- M4 打磨与发布：契约测试、手动 E2E checklist、`GET /diagnostics`（前缀见 §3.7）
  诊断端点（见 §5 可观测性，服务于社区插件的运维诊断需求）、npm 发布与文档。

后续版本跟踪：`connection.endpoints` 启用时的授权语义回补（见 §3.4 注记）。

## 10. 协议事实出处

本文引用的协议事实（方法名/参数/限制值/流程）核对自 Cherry Studio 仓库
`_research/cherry-studio`（packages/remote-protocol@0.3.0、
packages/remote-transport@0.1.2、src/main/services/remoteAccess/）；此外，配对二维码
payload 形态（`v:2`、`t:'cherry-studio-pair'` 及各字段）核对自 Cherry Studio 渲染层
`src/renderer/pages/settings/DeviceConnectionsSettings/`（该 payload 的生成方），属
二维码/移动端配对层，超出上述三个来源，特此补充列出；实现时应以
发布 npm 包的 zod schema 为准。服务端实现值（连接预算/限流）与协议承诺值的区分
原则见 §2。
