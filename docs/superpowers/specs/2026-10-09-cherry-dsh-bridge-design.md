# cherry-dsh-bridge 设计文档

- 日期：2026-10-09
- 状态：待用户审阅
- 路径分类：Architectural（新插件子系统）

## 1. 目标与背景

做一个 DeepSeek Harness（DSH）插件 `cherry-dsh-bridge`，让 DSH 中的 agent 能与
Cherry Studio 桌面端的 Agent 会话交互，并支持配对、管理多台 Cherry Studio 桌面实例。

依据：Cherry Studio 2.x「设备互联」功能（`src/main/services/remoteAccess/`、
`packages/remote-protocol`、`packages/remote-transport`）。该功能将桌面端的 Agent
会话能力通过局域网加密信道暴露给配对设备（官方移动端即以此接入），协议以 npm 包
`@cherrystudio/remote-protocol`、`@cherrystudio/remote-transport` 公开发布，第三方可
以客户端身份接入。Cherry Studio 的 Agent 会话可运行于三种 runtime
（claude-code / pi / dsh），`agent.*` 协议层是 runtime 无关的中立抽象。

### 用户已确认的决策

- 交互形态：**DSH agent 工具化操控**——在 DSH 对话中通过 `cherry_*` 工具列出、读取、
  驱动 Cherry Studio Agent 会话，等待并取回回复。
- 多端语义：**多个 Cherry 桌面实例**——同时配对管理多台（如公司机+家里机），各自独立
  状态与会话树，在 DSH 内统一管理与切换。
- 配置能力（configuration 域，服务商/密钥/模型导出）：**MVP 不做**，留待后续版本。
- 交付定位：**完整社区插件**，发布 npm，含服务端连接管理、工具面、web 配置 UI。
- 主方案：**方案 A 协议原生客户端**（零改动对端；方案 B 的「Cherry 作为 DSH 的 LLM
  provider」列为二期可选；方案 C 分叉明确否决）。

### 明确出界（MVP 不做）

- 普通聊天 topic 的交互（remote 协议不覆盖，仅 Agent 会话）
- configuration 域的导入/导出
- 把 DSH 会话反向镜像到 Cherry Studio
- 经 Cherry 中转触达其配对的移动设备

## 2. 总体架构

```
┌─ DSH Web GUI ──────────────────────────────────────────┐
│  设置页「Cherry Studio 互联」                            │
│  · 配对向导（粘贴二维码 payload JSON）                   │
│  · 设备卡片：状态灯 / 启停 / 重命名 / 移除               │
└───────────────┬─────────────────────────────────────────┘
                │ 插件 HTTP API（REST + SSE）
┌───────────────▼─────────────────────────────────────────┐
│  cherry-dsh-bridge（dsh 进程内 Cordis 插件）              │
│  identity / deviceStore / pairing / connection /         │
│  subscriptions / tools / httpApi                         │
└───────────────┬──────────────────────────────────────────┘
                │ ws://<host>:<port>/v1/remote/connect
                │ （Noise XX 加密记录，JSON-RPC 2.0）
      ┌─────────┴─────────┬──────────────┐
      ▼                   ▼              ▼
 Cherry 桌面 A        Cherry 桌面 B   Cherry 桌面 C
```

要点：

- 一台 DSH profile 持有**一个** Ed25519 设备身份；对每台 Cherry 桌面各建一条常驻
  加密连接。对端连接预算为 32 条 / 每地址 4 条、64 req/s，插件侧以请求队列对齐。
- 配对即绑定：payload 携带的 `desktopIdentity` 被 pin 进设备档案，此后每次连接都校验
  Noise 对端静态公钥与 pin 一致（防二维码劫持后的中间人替换）。
- 每设备仅申请 `agent` capability（MVP 不申请 `configuration`）。

## 3. 组件设计

插件为 Cordis bundle（`cordis.patch.yml` 插入行，示例 id `cherry-bridge`），服务端
Node 插件 + web client（`dsh.client` 注入 UI，参照 dsh-mcp-connector 模式）。

### 3.1 identity.ts

- `createDeviceIdentity()`（`@cherrystudio/remote-transport`）生成本机身份。
- 持久化为插件数据目录下的密钥文件，权限 0600；损坏/缺失时重新生成
  （旧身份随对端设备移除自然失效，重新配对即可恢复）。

### 3.2 deviceStore.ts

设备档案（JSON，插件数据目录），每设备字段：

| 字段 | 说明 |
|---|---|
| `deviceId` | 配对成功后对端分配的设备 ID |
| `displayName` | 用户可改名 |
| `hosts[]` + `port` | 候选地址（来自二维码 ips，允许手工增删） |
| `desktopIdentity` | pin 的对端身份（必填，校验 Noise 对端公钥） |
| `grants` | 授权域（MVP 恒为 `['agent']`） |
| `accessToken` / 过期时间 | 凭据，UI 不回显 |
| `enabled` | 启停开关（停用即断开不删档） |

### 3.3 pairing.ts

配对流程（UI 与 `cherry_pair` 工具共用）：

1. 解析并校验 payload：`v===2 && t==='cherry-studio-pair'`，取
   `ips/port/invitationId/invitationSecret/desktopIdentity/protocolVersions`。
2. 建立临时加密连接（对任意候选地址依次尝试），`connection.hello` 协商。
3. `pairing.claim`：`platform:'desktop'`、`capabilities:['agent']`、本机设备名
   （默认取 hostname，可由 `name` 参数覆盖）。
4. 将返回的 6 位 `verificationCode` 醒目呈现给用户（UI 卡片 / 工具结果文本），
   用户在 Cherry 桌面端核对一致后批准。
5. 轮询 `pairing.get` 至 `approved`（存 deviceId/grants/accessToken 入档案）或
   `rejected` / `expired` / 邀请 120s 超时。
6. 成功后销毁临时连接，转入常驻 connection。

### 3.4 connection.ts

每设备一个连接对象：

- WebSocket 连接 `ws://<host>:<port>/v1/remote/connect` →
  `connectSecureChannel()`（Noise XX 发起方，`identity` 为本机身份；握手完成后校验
  对端静态公钥与档案 pin 一致，不一致立即断开并标记设备 `identity-mismatch`）。
- `connection.hello`（协议版本协商）→ `connection.authenticate` → 获得 10 分钟
  accessToken；到期前自动 `connection.refresh`（30s 宽限内重试）。
- 心跳：按 `hello` 返回的 `heartbeatMs`（默认 20s）`connection.ping`。
- 断线：指数退避重连（封顶 60s）；重连成功后重认证并触发订阅恢复。
- 请求队列：per-device 串行窗口（并发 ≤ 8、自适应于 64 req/s 限速），避免 DSH agent
  并发调用触发对端限流。
- 收到 `connection.closed` 通知：按携带的失败码更新设备状态并进入重连流程。

### 3.5 subscriptions.ts

- 按需订阅：`cherry_send(wait)`、`cherry_events` 首次使用某会话时调用
  `agent.sessions.subscribe(cursor?)`；对端上限 8 个订阅，插件侧 LRU 淘汰不活跃会话
  的订阅（close 释放）。
- 维护每会话游标，事件处理后 `agent.subscriptions.ack`。
- `agent.events` 批量通知分发：更新会话内缓存（消息/part 快照），唤醒等待中的
  `cherry_send`。
- `agent.subscriptions.resetRequired` → 重新 subscribe；对端回 `checkpoint` 模式时走
  `agent.checkpoints.read` 重建游标后 `subscriptions.activate`。
- 会话事件缓存有界（默认每会话 2MiB 事件文本），超出丢最旧并记录。

### 3.6 tools.ts（工具面）

注册到 `ctx.tools`，前缀 `cherry_`，`device` 参数一律为设备显示名或 deviceId：

| 工具 | 参数 | 行为 |
|---|---|---|
| `cherry_devices` | — | 列设备 + 连接状态（connected/connecting/offline/disabled/identity-mismatch） |
| `cherry_pair` | `payload`, `name?` | 执行 3.3 配对流程；结果含验证码与最终状态 |
| `cherry_agents` | `device` | `agent.agents.list`（分页聚合） |
| `cherry_sessions` | `device`, `agentId?`, `workspaceId?`, `limit?` | `agent.sessions.list` |
| `cherry_read` | `device`, `sessionId`, `limit?` | `agent.messages.list` + `agent.parts.list` 聚合文本快照 |
| `cherry_create` | `device`, `agentId`, `title?`, `workspaceId?` | `agent.sessions.create`（幂等 commandId） |
| `cherry_send` | `device`, `sessionId`, `text`, `wait=true`, `timeoutMs=120000` | 见下 |
| `cherry_events` | `device`, `sessionId`, `cursor?` | 读订阅缓存中自游标以来事件 |
| `cherry_interactions` | `device`, `sessionId` | `agent.interactions.list` 过滤待答 |
| `cherry_respond` | `device`, `sessionId`, `interactionId`, `decision` 或 `answers` | `agent.interactions.respond`（严格透传 revision/execution/digest 校验） |
| `cherry_cancel` | `device`, `sessionId` | `agent.executions.cancel` |
| `cherry_unpair` | `device` | 删除设备档案并断开（对端侧由用户在 Cherry 移除） |

`cherry_send` 语义：

- `wait=true`（默认）：发送后等待该会话执行到达终态（成功/失败/取消）或超时；
  终态后聚合助手最终消息文本作为工具结果。期间出现提问类 `interaction.updated`
  时，工具结果改为返回「等待应答」+ 交互摘要，agent 继续用
  `cherry_interactions` + `cherry_respond` 处理后可再次 `cherry_send`（空转等待）或
  直接 `cherry_events` 轮询。
- `wait=false`：立即返回命令回执（commandId/状态）。
- 超时不是失败：返回已收到的部分内容 + 当前游标，agent 可续查。

### 3.7 httpApi.ts + web client

- 插件自有 HTTP 端口（默认 127.0.0.1 随机/可配）：`GET /devices`、`POST /pair`、
  `DELETE /devices/:id`、`PATCH /devices/:id`（改名/启停）、`GET /events`（SSE：设备
  状态变化、配对进度、订阅事件摘要）。绑定回环，鉴权用随机 token（UI 与插件同机）。
- web client（`dsh.client`，注入 layout/conversation）：设置页「Cherry Studio 互联」。
  配对向导粘贴 payload JSON（附二维码内容获取路径的图文指引）；设备卡片含状态灯、
  6 位验证码展示位、启停/重命名/移除。会话浏览器（列会话+读消息）为二期可选。

## 4. 数据流

### 4.1 配对

见 3.3。要点：邀请 120s 有效期，UI/工具需提示「先在 Cherry 端生成二维码再粘贴」。

### 4.2 发送并等待

`cherry_send(wait)` → 请求队列 → `agent.messages.send({commandId, text,
expectedIdleRevision})` → subscriptions 确保订阅 → 收 `agent.events`
（`part.append` 增量、`execution.updated`、`interaction.updated`、终态）→ 终态聚合
返回。`expectedIdleRevision` 取订阅缓存最新值；缓存缺失时先 `agent.sessions.get` +
`agent.messages.list` 对齐基线。

### 4.3 断线恢复

重连 → 重新 authenticate → 活动订阅以最后游标 `subscribe(cursor)` → 对端 replay
或 checkpoint 模式（后者 `checkpoints.read` 重建）→ `subscriptions.activate`。

## 5. 安全设计

- 身份 pin（见 3.4）；能力最小化（仅 `agent`）；凭据文件 0600、UI 不回显。
- 6 位验证码双向人工核对是配对的人因防线，UI 与 `cherry_pair` 结果均醒目展示。
- `cherry_respond` 允许 DSH agent 代替用户批准 Cherry 端审批，存在滥用面。MVP 不做
  额外拦截层（信任 DSH 自身 sandbox/approval 体系约束 agent 行为）；**已知限制**记录
  于本文档，二期可加「审批类应答需经 DSH 侧 ask_user_question 确认」的 gate。
- 插件 HTTP API 仅回环 + 随机 token，不暴露局域网。

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| 设备离线 | 工具返回结构化错误 `{device, state}`；不自动重试轰炸 |
| 邀请过期/被拒 | 明确提示在 Cherry 端重新生成二维码 / 核对验证码 |
| token refresh 失败 | 设备转 offline，提示检查对端是否移除了本设备 |
| 协议协商失败 | 报版本不兼容，提示升级 Cherry Studio / 插件 |
| 幂等冲突（同 commandId 异参） | 透传协议 CONFLICT 错误 |
| replay 超预算（8MiB/5min） | 自动走 checkpoint 恢复路径 |
| 限流 | per-device 队列退避 |
| 身份不匹配 | 断开并标记 `identity-mismatch`，要求人工重新配对 |

## 7. 测试策略

1. 单元：payload 解析、deviceStore 读写/迁移、工具 zod schema。
2. 集成（自环）：测试内以 `acceptSecureChannel` + 内存 WebSocket 对起假 Cherry 端
   （hello/authenticate/pairing/agent.* 最小面，复用协议包 zod schema 做服务端校验），
   覆盖：配对全流程、发送等待终态、事件游标 ack、断线重连与 checkpoint 恢复、
   幂等冲突、限流退避。
3. 契约：pin `@cherrystudio/remote-protocol`/`remote-transport` 版本；升级时跑契约
   测试防 schema drift。
4. 手动 E2E：真实 Cherry Studio 配对（Electron 端人工批准无法 CI 化），发布前走
   checklist（配对/发送/交互/断连恢复/多设备并存）。

## 8. 依赖与发布

- 运行时依赖：`@cherrystudio/remote-protocol`、`@cherrystudio/remote-transport`
  （携带 libp2p noise 栈，纯 JS）、`ws`（Node WebSocket 客户端；与
  `RemoteSocketStream` 的 EventTarget/backpressure 适配层在实现首日验证）。
- 发布：npm 包 `cherry-dsh-bridge`；`cordis.patch.yml` 插入行（id `cherry-bridge`，
  默认配置：http 端口策略、订阅缓存上限、请求队列参数）；`dsh.client` web UI。
- 安装：`dsh plugin --profile <name> add cherry-dsh-bridge` 或 profile 手工加行。

## 9. 里程碑切分（供实施计划参考）

- M1 通道底座：identity/deviceStore/connection（hello/auth/refresh/心跳/重连）+
  自环集成测试。
- M2 配对与设备管理：pairing + httpApi + web UI 设置页。
- M3 工具面：tools.ts 全量 + subscriptions + 自环覆盖发送等待/恢复/幂等。
- M4 打磨与发布：契约测试、手动 E2E checklist、npm 发布与文档。
