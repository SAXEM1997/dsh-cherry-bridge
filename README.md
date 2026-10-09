# dsh-cherry-bridge

把本机 **DeepSeek Harness** 桥接到局域网内的 **Cherry Studio 桌面端**（remote
access）。插件在 DSH 侧维护设备连接池与订阅缓存，对外暴露 `cherry_*` 工具面与一个
同源设置页，让你可以在 DSH 会话里驱动 Cherry 端的 agent：列设备/列会话、读历史、
发消息并等待终态、应答审批与提问卡、取消执行。

- 包名：`dsh-cherry-bridge`
- 插件 id：`cherry-remote`（呼应协议发现类型 `remoteDiscoveryType` 的 mDNS 服务标识）
- 传输：`ws://` + Noise XX（加密由 Noise 记录层提供，不依赖 TLS 终止）
- 工具面：14 个 `cherry_*` 工具
- HTTP 面：宿主 Web 服务器上的同源前缀 `/cherry-remote/api`

## 安装

```bash
# DSH profile 方式安装（推荐）
dsh plugin --profile <name> add dsh-cherry-bridge
```

或以 bundle patch 方式合入 profile —— 本包自带 `cordis.patch.yml`，其中已声明插入行
`cherry-remote` 与默认配置（见下文「配置」）。`package.json` 的
`dsh.bundle.patch` 指向该文件，dsh-plugin-manager 据此自动插入插件行。

profile 手工加行等价于：

```yaml
- id: cherry-remote
  name: 'dsh-cherry-bridge'
  config:
    perSessionCacheBytes: 2097152
    rateBudgetPerSecond: 32
```

### 首次配对

1. 在 Cherry Studio 桌面端打开 **remote access**，展示配对二维码（或 payload 文本）。
2. 在 DSH 里调用 `cherry_pair`（设置页向导亦可），提交该 payload。
3. **双向核对 6 位验证码**：`cherry_pair` 结果与设置页都会醒目展示该代码，请与桌面端
   显示的数字人工比对一致后再在桌面端批准。
4. 批准后设备档案写入插件数据目录（`devices.json`，权限 `0600`），其
   `desktopIdentity` 被 pin 住；此后每次连接都校验 Noise 对端静态公钥与 pin 一致，
   防止二维码被劫持后的中间人替换。

## 配置

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `dataDir` | string | `$DSH_HOME/cherry-remote`（回退 `~/.dsh/cherry-remote`） | 插件数据目录，存放 `identity.key` 与 `devices.json`（均 `0600`）。 |
| `perSessionCacheBytes` | number | `2097152`（2 MiB） | 每个会话的**本地**订阅事件缓存字节上限。超出时按 LRU 丢弃最旧事件并 `warn` 记录。 |
| `rateBudgetPerSecond` | number | `32` | 每设备二级平滑请求预算（请求/秒）。桌面端实现的硬上限是 64 req/s 且**无协商通道**，超限会以 close `1011` 终止整条会话；这里取保守值。 |

> ⚠️ `cordis.patch.yml` 的 `config` 是**整体替换**，不与 bundle 默认值合并。装配层
> （`resolveBridgeConfig`）对缺键回落上述默认值——因此删掉一个键得到的是**插件默认
> 值**，不是 profile 里别处的值。缺键与非法值是两回事：键存在但不可用（`0`、负数、
> 字符串）会按名 `warn` 后回落。

## 工具

| 工具 | 作用 |
| --- | --- |
| `cherry_devices` | 列出所有已配对设备及其连接状态（`connected`/`connecting`/`offline`/`disabled`/`identity-mismatch`）。 |
| `cherry_agents` | 列出某设备上可用的 agent（分页）。 |
| `cherry_workspaces` | 列出某 agent 的**已注册**工作区，以及是否存在系统工作区。 |
| `cherry_sessions` | 列出某 agent 的会话，可按工作区过滤。 |
| `cherry_read` | 读取会话的消息历史快照（两级基线：`agent.sessions.get` + `agent.messages.list`/`agent.parts.list`；parts 按**每条消息自身**的 revision 读取）。 |
| `cherry_events` | 读取该会话缓冲区内比 `cursor` 更新的事件，并在投递后 ack。 |
| `cherry_create` | 在 agent 工作区创建会话（工作区选择**必填**；创建后经 `agent.sessions.get` 回读身份）。 |
| `cherry_send` | 向会话发消息，默认等待运行到终态并返回助手文本；`wait: false` 立即返回命令回执。 |
| `cherry_wait` | 只等待该会话在途执行收敛（不发送新消息）。 |
| `cherry_interactions` | 列出该会话**待答**的交互卡（提问 / 审批）。 |
| `cherry_respond` | 应答交互卡：提问必须全量作答，审批走 `decision`。 |
| `cherry_cancel` | 取消会话在途执行（`expectedExecutionId` 必填）。 |
| `cherry_pair` | 用配对 payload 建立与桌面端的配对。 |
| `cherry_unpair` | 解除配对：断开连接并从设备档案删除。 |

设备选择器（`device` 参数）接受**精确 `deviceId`** 或**唯一的显示名前缀**；前缀命中
多项时返回结构化歧义错误，不会任选一个。

`cherry_send(wait: true)` / `cherry_wait` 返回的 `status` 有 **7 个取值**：四个协议终态
（`completed`/`failed`/`cancelled`/`interrupted`）之外，还有三个 waiter 自己的判定——
`awaiting-interaction`（软终态：出现待答交互卡，运行仍活着）、`timeout`（窗口用尽，
**不是失败**，返回已到达的部分内容与续读游标）、`idle`（`cherry_wait` 遇到没有在途执行
的会话，立即返回当前快照）。

## 设置页（web client）

插件同时是一个 **web client bundle**（`package.json` 的 `dsh.client` 声明
`platform: web`，导出 `./client`）。它通过宿主设置页的 `settings.section` 槽位注册
一个 **`cherry-remote`** 命名空间页面，提供：

- 设备卡片列表：显示名、地址、连接状态灯、启用/停用、删除；
- 配对向导：粘贴 payload → 展示 6 位验证码 → 展示终态；
- 实时状态：设备状态与配对进度经同源 SSE 流（`/cherry-remote/api/events`）推送。

开发时可单独跑 `npm run dev:ui`（`ui/` 下的 Vite 入口）。**前提是同一个 DSH 宿主已在
`http://127.0.0.1:23023` 运行**：该 dev server 只服务页面本身，页面调用的
`/cherry-remote/api` 由 `ui/vite.config.ts` 里的 **dev-only 代理**转发到宿主（SSE 也走
同一条代理，不被缓冲）。没有宿主时页面能渲染，但设备列表与事件流会报错。宿主在别的
端口时用 `CHERRY_DEV_HOST=http://127.0.0.1:<port> npm run dev:ui` 覆盖，不必改代码。

## HTTP 面（同源）

挂载在宿主 Web 服务器的 `/cherry-remote/api` 前缀下，**不新增独立监听、不暴露局域网、
不设独立凭据**：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /cherry-remote/api/devices` | 设备列表。 |
| `PATCH /cherry-remote/api/devices/:id` | 改显示名/启用状态/地址/端口（`hosts` 为**整体替换**）。 |
| `DELETE /cherry-remote/api/devices/:id` | 移除设备并断开其连接。 |
| `POST /cherry-remote/api/pair` | 启动一次配对，立即返回 `202 {claimId}`，进度走 SSE。 |
| `GET /cherry-remote/api/events` | SSE：`device-state` / `pairing-progress`（每帧带产生它的 `claimId`，含心跳）。 |
| `GET /cherry-remote/api/diagnostics` | 运维诊断报告（见下）。 |

> `pairing-progress` 帧的最小形状是 `{stage, detail?}`；本插件在其上**额外**附带可选的
> `claimId`（跨 run 隔离用的裁定扩展，非计划内最小字段），消费方须容忍该字段缺失。

**信任 fence**：每个路由在动手前都自行过一遍同源判定，四分支按序为
(1) 非回环且未声明的 `Host` → 拒绝；(2) `sec-fetch-site: cross-site` → 拒绝；
(3) 附带 `Origin` 与 `Host` 非同源 → 拒绝；(4) **`Origin` 缺失 → 放行**（那是
curl 之类的非浏览器客户端，不是跨站页面）。

### `GET /diagnostics`

汇总设备状态 / 连接统计 / 最近错误摘要，**并按 §5 脱敏规则处理**：

- 可出：`deviceId`、显示名、状态、地址、端口、`desktopIdentity` 的 **12 位摘要**、
  **hello 协商后的有效 limits**（`heartbeatMs`/`subscriptions`/`pageItems`/
  `inFlightRequests`；**只有存在活连接时才报**——本端点从不拨号，无连接的设备既不报
  limits、也不会被顺手唤醒，而不是拿客户端回退值冒充）、
  `sessionId` 与会话游标（游标取自订阅层当前状态，未订阅的会话没有该字段）、
  `stats` 计数器（`connections`/`sockets`/`connectionsBuilt`/`subscriptions`）、
  装配层解析出的**两个 `config` 键**
  （`rateBudgetPerSecond`/`perSessionCacheBytes`，与日志里报的是同一组数字）、
  错误的 reason/message（**message 在端点边界被截断到 200 字符**，
  见 `ERROR_MESSAGE_MAX`）；
- 绝不出：`accessToken`、`tokenExpiresAt`、`invitationSecret`、原始
  `desktopIdentity`、消息文本与 part 文本。

> `stats.connectionsBuilt` 是**连接池自上次 `apply` 以来构建过的连接数**，
> 不是 RPC 请求量——请求计数归传输层所有，本端点不发布同名指标以免误读。
> 计数器与错误环都在每次 `apply` 时清零：统计只描述**当前**这次装配。

脱敏是**白名单投影**而非黑名单过滤：报告是逐字段新建的对象，因此日后往设备档案里
新增的凭据字段会**按构造**被排除，而不依赖有人记得去更新一份拒绝清单。

## 日志

分级约定（spec §5）：

- **error** —— 连接失败 / 认证失败 / 协议错误；
- **warn** —— 重连退避 / 缓存淘汰 / 订阅 LRU 驱逐；
- **info** —— 配对进度 / 订阅建立与恢复 / 设备状态迁移。

info 级只记**阶段名与标识符**（`deviceId`/`sessionId`/配对阶段），不记任何载荷。

敏感字段（token、`invitationSecret`、`accessToken`、消息内容与 part 文本）**一律不入
日志**；`deviceId`、`desktopIdentity` 摘要与 `sessionId` 可记。契约套件对一条完整的
配对→连接→发送→交互流程做了日志脱敏断言（`tests/contract/contract.test.ts`）。

## 开发

```bash
npm test            # vitest 全量（含 tests/contract/）
npm run typecheck   # 服务端 + UI 两侧
npm run build       # tsdown → dist/index.mjs
npm run build:client # vite → lib/client.js
npm run dev:ui      # 设置页 dev server（需宿主在 127.0.0.1:23023 运行，见上）
npm run prepare     # git 安装/本地 install 钩子：build + build:client
npm run prepublishOnly # 发布前钩子：build + build:client
```

> `dist/` 与 `lib/` 都是 git 忽略的**构建产物**。`prepublishOnly` 只在 `npm publish`
> 时运行，`npm install <git-url>` 或对克隆目录打包都**不会**触发它——那样的 tarball
> 里既没有 `dist/index.mjs` 也没有 `lib/client.js`，宿主加载 `./client` 时会直接以
> `MissingClientBundleError` 失败。因此发布物由 `prepare` 钩子构建：git 依赖安装与
> 本地 install 都会运行它；发布时 `prepublishOnly` 先跑、`prepare` 随后再跑一次，
> 两者是同一份输入的幂等构建，重复执行无害。`tests/contract/contract.test.ts` 里的
> 「clean clone → pack」用例是这条的**闸门**：它克隆本仓库、跑 `prepare`、打包，
> 断言 tarball 内确实含 `dist/index.mjs`、`dist/index.d.mts`、`lib/client.js`。

依赖 `@cherrystudio/remote-protocol@0.3.0` 与 `@cherrystudio/remote-transport@0.1.2`
以**精确版本**固定（无 `^`），并有测试断言锁死——升级时必须重跑
`tests/contract/contract.test.ts` 以防 schema drift。契约套件同时逐条建模了「本仓库
自环假对端」与「真实 Cherry Studio」的**六项行为差异**，并逐条对应
[`docs/e2e-checklist.md`](docs/e2e-checklist.md) 中的人工核验步骤。

> `zod` 是**运行时**依赖，不是可删的死依赖：本包的 `dist` 把
> `@cherrystudio/remote-protocol` 作为 external，而该协议的运行时产物处处 `import
> zod`（peer `^4.3.4`，其自身 dev pin 为 4.3.4）。把它降级为 devDependency 或移除，
> 都会让协议包在运行时加载 schema 失败。这里精确钉在 `4.3.4`——即 peer 区间下界，
> 也是协议包的测试基线。

> 说明：本仓库的 `tests/loopback/fakeCherry.ts` 是**测试内**的自环假对端，不是发布物；
> 文档与代码注释中出现的 `Task N`、`spec §x`、`controller ruling`、`UltraReview` 等编号，
> 指向本项目内部的 SDD 过程文档（设计/任务/审查记录），**不随包发布**——它们只是把
> 「这条规则为什么长这样」的出处留在原处。

发布前请走完 `docs/e2e-checklist.md`：Electron 端的人工批准无法 CI 化，真机流程
（配对 / 发送 / 交互应答 / 断连恢复 / 多设备并存）必须人工过一遍。

## 已知限制

- `cherry_respond` 允许 DSH agent 代替用户批准 Cherry 端的审批卡，存在滥用面。MVP
  不再加拦截层，信任 DSH 自身的工具调用审批体系约束 agent 行为；二期可加「审批类应答
  需经 DSH 侧 `ask_user_question` 确认」的 gate。
- 每设备仅申请 `agent` capability，不申请 `configuration`。
- MVP 仅使用 `ws://` 传输（加密由 Noise 记录层提供），不做 TLS 直连。

## License

MIT
