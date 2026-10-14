# dsh-cherry-bridge — 发布前手动 E2E Checklist

本清单是 M4 手工 E2E 的**唯一权威文档**（spec §7-4）。自动化套件覆盖不到
「真实 Cherry Studio 桌面 + Electron 端人工批准」这一环，因此每次发布前必须由人工
逐条走完。

清单分为两部分：

1. **契约六项差异逐条核验**——与 `src/diagnostics.ts` 的
   `CONTRACT_DIFFERENCES` 常量表**同源**：每一节给出该表的 `id`、`title` 与
   `checklistStep` 原文，并由 `tests/contract/contract.test.ts` 的 ⑦ 断言
   「文档逐条覆盖、且与自动化断言同一清单」。**改动差异清单 = 同步改本文件**，
   否则测试红色。
2. **真机主流程**——配对 / 发送 / 交互应答 / 断连恢复 / 多设备并存。

> 准备：一台安装了 Cherry Studio 桌面的机器（与被测 DSH 同局域网），
> 桌面端开好 remote access 并展示配对二维码；DSH 侧以插件方式装载
> `dsh-cherry-bridge`（`dsh plugin --profile <name> add dsh-cherry-bridge`，
> 或 profile 手工加行 + `cordis.patch.yml`）。

---

## 第一部分：契约六项差异逐条人工核验

### 1. `connection-closed-not-sent` — connection.closed is never sent by the real peer

**真实对端行为**：桌面以**套接字 close code**（1000/1011/1013）终止会话，从不发送
`connection.closed` 通知。该帧在 schema 中仅作为 notification 形状存在——它不在
`connectionMethods`/`pairingMethods` 中，因此没有任何请求面会产生它。

**手动核验步骤**（与 `CONTRACT_DIFFERENCES[0].checklistStep` 同源）：

- [ ] connection-closed-not-sent: with a real desktop connected, force a link drop (disable the desktop's Wi-Fi or quit Cherry Studio) and confirm the plugin logs a socket-close/reconnect path and NOTHING resembling a received `connection.closed` notification.

**期望**：日志出现断连/退避重连路径；**不出现**任何「收到 `connection.closed`」字样。
若真出现，说明服务端新增了该通知 → 回归 `tests/contract/contract.test.ts` 相应断言。

---

### 2. `approval-card-not-realtime` — Approval cards are not delivered in real time by the real stream

**真实对端行为**：审批/提问卡被**持久化**，`agent.interactions.list` 是应答资格快照的
**权威来源**；实时 `interaction.updated` 流是**加速器/保鲜器**——它让插件不必为每张卡都
回查一次，但**不保证**送达，也不构成资格依据。任何一张卡都必须仅凭 list 快照可应答。

**手动核验步骤**（与 `CONTRACT_DIFFERENCES[1].checklistStep` 同源）：

- [ ] approval-card-not-realtime: trigger a tool call on the real desktop that raises an approval card; confirm `cherry_interactions` finds it through `agent.interactions.list` even when no `interaction.updated` event arrived, and that `cherry_respond` still accepts the listed snapshot.

**期望**：即使没有收到 `interaction.updated`，`cherry_interactions` 仍能列出该卡；
`cherry_respond` 用列表快照（revision/executionId/inputDigest 三元组）成功应答。

---

### 3. `rate-limit-terminates-session` — Over-limit rate limiting terminates the whole session (close 1011)

**真实对端行为**：超过桌面每套接字预算（当前实现值 64 req/s，无协商通道）会以 close
code **1011 终止整条会话**——不是可原地重试的**单请求** `RATE_LIMITED` 拒绝。

**手动核验步骤**（与 `CONTRACT_DIFFERENCES[2].checklistStep` 同源）：

- [ ] rate-limit-terminates-session: against a real desktop, drive a burst well above the smooth budget and confirm the socket is closed with 1011 (session gone, state offline, backoff restart) rather than a single structured per-request rejection.

**期望**：套接字被 1011 关闭 → 设备状态转 `offline` → 进入退避重启；
**不出现**「某一条请求被单独拒绝、连接仍存活」这一形态。

---

### 4. `execution-terminal-no-interrupted` — The real agent journal never produces an `interrupted` execution terminal

**真实对端行为**：`agentJournal` 的执行终态只有 `completed` | `failed` | `cancelled`。
schema 已允许 `interrupted`，所以客户端**必须**处理，但当前服务端不会为执行产生它。

**手动核验步骤**（与 `CONTRACT_DIFFERENCES[3].checklistStep` 同源）：

- [ ] execution-terminal-no-interrupted: run several real turns (including a cancelled one) and confirm every observed `execution.updated` terminal is completed/failed/cancelled; treat any `interrupted` as a protocol change worth reporting, not as expected noise.

**期望**：多次真实跑批（含一次取消）后，观察到的终态全部落在三值内。
一旦出现 `interrupted`，按「协议已变更」上报，而非当作正常噪声。

---

### 5. `command-receipt-can-be-interrupted` — A command receipt status may be `interrupted` (a different dimension)

**真实对端行为**：命令回执的 `status` 枚举为
`accepted | applied | rejected | interrupted`；其中 `interrupted` 表示
**命令结果未定**。它与「执行终态」是**两条不同的维度**，调用方不得混为一谈。

**手动核验步骤**（与 `CONTRACT_DIFFERENCES[4].checklistStep` 同源）：

- [ ] command-receipt-can-be-interrupted: after a send the plugin reports as undetermined, query the command (or re-issue the same commandId) and confirm an `interrupted` receipt is passed through as an undetermined outcome, NOT reported as a finished run.

**期望**：`interrupted` 回执被**原样透传**为「结果未定」，
**不得**被报告为一个已完成的 run。

---

### 6. `resource-exhausted-receipt-cap` — RESOURCE_EXHAUSTED on the receipt dimension is a rejected receipt, not a dead link

**真实对端行为**：当对端命令/回执容量耗尽，命令以**被拒回执**返回
（`error.reason: "RESOURCE_EXHAUSTED"`），**会话本身保持健康**。
（订阅维度——`agent.sessions.subscribe` 超上限——是另一个注入例，由 Task 7⑨ 锚定。）

**手动核验步骤**（与 `CONTRACT_DIFFERENCES[5].checklistStep` 同源）：

- [ ] resource-exhausted-receipt-cap: force the real desktop into receipt exhaustion (repeat commands until it refuses) and confirm the plugin surfaces a structured rejected receipt with `RESOURCE_EXHAUSTED`, keeps the connection up, and does not crash.

**期望**：结构化被拒回执（`status: rejected` + `error.reason: RESOURCE_EXHAUSTED`）
抵达调用方；连接**保持 `connected`**；进程不崩溃。

---

## 第二部分：真机主流程

### A. 配对

- [ ] 桌面端打开 remote access，展示配对二维码/payload。
- [ ] DSH 侧执行 `cherry_pair`（或设置页向导），提交 payload。
- [ ] **双向核对 6 位验证码**：`cherry_pair` 结果与设置页均醒目展示该码，人工与桌面端比对一致后再在桌面端批准。
- [ ] 批准后设备档案落盘：`deviceId` / `desktopIdentity` 为**已批准分支**的值（非 claim 回执值），`grants` 仅 `agent`。
- [ ] 档案文件权限为 `0600`，`accessToken` 不出现在任何日志或 UI 回显中。
- [ ] 桌面端拒绝该请求 → `cherry_pair` 返回 `rejected`；让邀请过期 → 返回 `expired`。

### B. 发送

- [ ] `cherry_sessions` / `cherry_agents` / `cherry_workspaces` 列出真实数据。
- [ ] `cherry_send` 向真实会话发送文本，`wait: true` 收敛到终态并返回助手文本。
- [ ] 长回复（>4096 单元）经 `{ref}` 外置，聚合结果仍包含完整文本。
- [ ] `cherry_read` 能按 messageId 读到该轮消息与 parts。
- [ ] `wait: false` 立即返回命令回执，随后 `cherry_wait` / `cherry_events` 能续查到同一终态。
- [ ] 同 `commandId` 同参重发 → 返回**同一回执**（幂等）；异参重发 → `IDEMPOTENCY_CONFLICT` 透传。

### C. 交互应答

- [ ] 触发需审批/提问的工具调用，`cherry_wait` 在软终态提前返回并标注交互 kind。
- [ ] `cherry_interactions` 列出待答项（已答项被客户端过滤掉）；**资格以 `agent.interactions.list` 为准**——即使一张 `interaction.updated` 都没收到，列出的卡仍可 `cherry_respond` 成功（实时流只是加速器，不是资格依据）。
- [ ] 批准（approve）→ 回执 `applied`，随后 `cherry_wait` 恢复等待到真实终态。
- [ ] 提问卡缺键回答 → 回执 `rejected` + `CONFLICT`，**无部分提交**；对提问卡 approve → `CONFLICT`（"Question requires answers"）。
- [ ] 拒绝（deny）→ 回执 `applied`，运行以 `cancelled` 收束。
- [ ] `cherry_cancel` 带 `expectedExecutionId` 成功取消活跃执行。

### D. 断连恢复

- [ ] 断开桌面网络/退出桌面 → 插件转 `offline` 并按退避重连（日志为 warn 级）。
- [ ] 恢复网络/重启桌面 → 自动重连 + 重新认证成功，状态回 `connected`。
- [ ] 重连后**订阅恢复**：既有会话按最后游标重新订阅，不漏不重（`cherry_events` 续读一致）。
- [ ] 断连期间调用工具 → 结构化错误 `{device, state}`，**且不触发隐式重连轰炸**。
- [ ] 桌面端侧删除本设备（GRANT_REVOKED 面）→ 状态 `offline` 并提示重新配对。
- [ ] 桌面端把连接数打满（1013）→ 与 1011 走同一断线/退避判定路径。

### E. 多设备并存

- [ ] 配对第二台桌面，`cherry_devices` 同时列出两台及其独立状态。
- [ ] 两台设备的连接、订阅、游标**互不串扰**（对 A 的操作不影响 B 的状态与缓存）。
- [ ] 设置页同时渲染两张设备卡片，状态灯随各自连接独立变化。
- [ ] 停用其中一台 → 该设备转 `disabled` 且套接字被断开；再启用 → 从档案重建连接。
- [ ] `cherry_unpair` 移除一台 → 另一台连接与订阅不受影响。

---

## 第三部分：诊断与发布核对

- [ ] `GET /cherry-remote/api/diagnostics` 返回设备状态/连接统计/最近错误摘要，
      且**不含** `accessToken` / `tokenExpiresAt` / `invitationSecret` / 原始
      `desktopIdentity`（应为 12 位摘要）。
- [ ] 该端点同样受信任 fence 约束：非回环 Host、非同源 Origin、`sec-fetch-site: cross-site`
      一律 403；无 Origin 的非浏览器客户端放行。
- [ ] 全流程日志不含 token / invitationSecret / accessToken / 消息文本 / part 文本。
- [ ] **上游版本核验**（桌面端为 2.1.4–2.1.6 或已比对过的更新版本；依据见 README
      「与 Cherry Studio 版本的对应关系」）：
      - [ ] 桌面端**升级后无需重新配对**：设备档案直接连上，`desktopIdentity` 未变。
      - [ ] 桌面端为 2.1.5+ 且会话里有**来自手机上传的附件**时：该 part 为 `kind:"file"`
            并带 `name`/`mediaType`/`byteLength`，`content` 为空，且**没有**任何
            `agent.content.read` 调用（一次都不该有——那些字节是文件，不是文本）。
      - [ ] `cherry_send` 传空白文本（如 `"   "`）→ 本地返回 `text-empty`，对端未收到
            `agent.messages.send`。
      - [ ] 桌面端广播了本插件不认识的支持字段时，`cherry_devices` 的 limits 投影仍只有
            4 个已知键（heartbeatMs/subscriptions/pageItems/inFlightRequests），连接不被拒。
- [ ] `package.json` 中 `@cherrystudio/remote-protocol`、`@cherrystudio/remote-transport`
      为精确版本（无 `^`）。
- [ ] `npm test` 全绿（含 `tests/contract/contract.test.ts`）。
