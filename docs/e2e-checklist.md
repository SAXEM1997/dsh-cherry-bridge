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
2. **真机主流程**——配对 / 发送 / 交互应答 / 断连恢复 / 多设备并存 / 工具启用范围（`/scope`）/
   语言切换与降级 / **实验性子智能体（§H，默认关闭的功能必须在真机上走一遍打开→使用→关闭）**。

> 准备：一台安装了 Cherry Studio 桌面的机器（与被测 DSH 同局域网），
> 桌面端开好 remote access 并展示配对二维码；DSH 侧以插件方式装载
> `dsh-cherry-bridge`（`dsh plugin --profile <name> add dsh-cherry-bridge`，
> 或 profile 手工加行 + `cordis.patch.yml`）。
>
> **插件安装或更新后，先重启 DSH（或等价地重载插件）再开始**：宿主只在启动 / 重载时加载
> 插件构建，未重载前跑出来的现象属于旧构建。第二部分 F 节把这条写成了硬前置（步骤 0）。

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

**上游实证**：2.1.9 之前，桌面的通知发送链会被一次失败**永久毒死**——`RemoteConnection.send()`
把可 rejected 的 Promise 直接存回链头，此后该连接上的 `interaction.updated` 等通知静默停发，
而请求-应答不受影响（应答不走这条链）。2.1.9 由 PR #22593 修复。这就是「实时流只是加速器、
list 快照才是权威」的实证来源：一条健康的连接随时可能不再推送任何通知。

**手动核验步骤**（与 `CONTRACT_DIFFERENCES[1].checklistStep` 同源）：

- [ ] approval-card-not-realtime: trigger a tool call on the real desktop that raises an approval card; confirm `cherry_interactions` finds it through `agent.interactions.list` even when no `interaction.updated` event arrived, and that `cherry_respond` still accepts the listed snapshot.

**期望**：即使没有收到 `interaction.updated`，`cherry_interactions` 仍能列出该卡；
`cherry_respond` 用列表快照（revision/executionId/inputDigest 三元组）成功应答。

---

### 3. `rate-limit-terminates-session` — Over-limit rate limiting is generation-dependent: a whole-session 1011 close (≤2.1.6) or a per-request refusal (≥2.1.7)

**真实对端行为**：≤2.1.6 超过桌面每套接字预算（64 req/s 共享、512 req/s 内容）会以 close
code **1011 终止整条会话**；≥2.1.7（PR #21687）共享额度改为 256 req/s，超限只拒绝**该条**
请求（`RATE_LIMITED` + `retryAfterMs`），会话存活。

**手动核验步骤**（与 `CONTRACT_DIFFERENCES[2].checklistStep` 同源，逐字一致）：

- [ ] rate-limit-terminates-session: on a ≥2.1.7 desktop, raise `rateBudgetPerSecond` (or use an unpaced probe) and drive a burst above the allowance; confirm each over-budget request is refused with `RATE_LIMITED` + `retryAfterMs` while the session stays live, a refused READ succeeds after ONE replay, and a refused COMMAND surfaces as a verdict and is not replayed. On ≤2.1.6, the same burst closes the socket with 1011 (state offline, backoff restart).

**期望**：按对端版本二选一命中；两种形态都**不出现**未分类的 bare channel-closed 文本。

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

- [ ] 桌面端打开 remote access →「添加设备」，屏幕上只显示**二维码**（界面本身不显示配对信息）。
- [ ] 用微信或浏览器**扫码**，确认扫码后的页面里显示配对信息（地址/端口/一次性邀请）。
- [ ] 把该页面里的配对信息复制到设置页向导（或 `cherry_pair` 的 payload 参数）并提交。
- [ ] **双向核对 6 位验证码**：`cherry_pair` 结果与设置页均醒目展示该码，人工与桌面端比对一致后再在桌面端批准。
- [ ] 批准后设备档案落盘：`deviceId` / `desktopIdentity` 为**已批准分支**的值（非 claim 回执值），`grants` 仅 `agent`。
- [ ] 档案文件权限为 `0600`，`accessToken` 不出现在任何日志或 UI 回显中。
- [ ] 桌面端拒绝该请求 → `cherry_pair` 返回 `rejected`；让邀请过期 → 返回 `expired`。

### B. 发送

- [ ] `cherry_sessions` / `cherry_agents` / `cherry_workspaces` 列出真实数据。
- [ ] `cherry_send` 向真实会话发送文本，`wait: true` 收敛到终态并返回助手文本。
- [ ] `cherry_send` 带 `attachments` 发一张本地图片到真实会话（`text` 可留空）。**期望**：
      桌面聊天里出现该附件且能打开；结果回显 `{filename, mediaType, byteLength, uploadId}`。
      再用一个 <2.1.5 的桌面（或模拟无 `agentUploadsVersion` 的 hello）重试：返回
      `unsupported`，且没有 `agent.uploads.*` 请求。
- [ ] 长回复（>4096 单元）经 `{ref}` 外置，聚合结果仍包含完整文本。
- [ ] `cherry_read` 能按 messageId 读到该轮消息与 parts。
- [ ] `wait: false` 立即返回命令回执，随后 `cherry_wait` / `cherry_events` 能续查到同一终态。
- [ ] 长回答（事件流超过 256 KiB，约 30 小节的一次长输出）时 `wait: true` 仍在终态后立即返回 `completed`；期间每 5 s 采一次 `GET /diagnostics` 的 `sessions[].cursor.seq`，确认它没有停住（修复前会冻结在窗口处，最终报 `timeout`）。
- [ ] 同 `commandId` 同参重发 → 返回**同一回执**（幂等）；异参重发 → `IDEMPOTENCY_CONFLICT` 透传。

### C. 交互应答

- [ ] 触发需审批/提问的工具调用，`cherry_wait` 在软终态提前返回并标注交互 kind。
- [ ] `cherry_interactions` 列出待答项（已答项被客户端过滤掉）；**资格以 `agent.interactions.list` 为准**——即使一张 `interaction.updated` 都没收到，列出的卡仍可 `cherry_respond` 成功（实时流只是加速器，不是资格依据）。
- [ ] 批准（approve）→ 回执 `applied`，随后 `cherry_wait` 恢复等待到真实终态。
- [ ] 提问卡缺键回答 → 回执 `rejected` + `CONFLICT`，**无部分提交**；对提问卡 approve → `CONFLICT`（"Question requires answers"）。
- [ ] 拒绝（deny）→ 回执 `applied`。**运行是否继续要实测**：源码 `AiStreamManager.resolveToolApproval` 对拒绝发出 `tool-output-denied` 而流不中断，`agentJournal` 只把 `paused`（用户中止）映射成 `cancelled`，所以预期是**继续**到真实终态；若真机上观察到 `cancelled`，说明这条源码路径不覆盖该卡种，请记下来。
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
- [ ] 设置页「忘记 / 恢复」：对某台设备的一个候选地址点「**忘记**」→ 该地址从「地址」行消失、
      出现在「**已忘记地址**」行；`GET /devices` 的 `forgottenHosts` 含它，且**重启桌面或重连后
      该地址不会被自动学回来**（`cherry_devices` 的 `action: "forget"` 是同一个写入）。
      点「**恢复**」→ 标记消失，桌面下次广播该地址时重新加入；只剩最后一个候选地址时点「忘记」
      → 页面显示「不能忘记最后一个候选地址」而**不是** `last-address:` 前缀的服务端原文。
      另外核一条**冻结**规则：打开「地址维护」后，卡片上的「忘记 / 恢复」应变为**不可点**——那是
      因为该表单整体替换 `hosts`，它的草稿不会被卡片重新播种，编辑器开着时点「忘记」会被下一次
      「保存地址」连同标记一起覆盖掉；关掉编辑器即恢复可点。

### F. 工具启用范围（`/scope`）

> **步骤 0（前置）：先重启 DSH。** 插件安装 / 更新后，宿主只有在**重启**（或等价地重载插件）
> 之后才加载新的构建；未重启前，下面每一步都可能表现为「范围没生效」——那是旧构建仍在跑，
> 不是缺陷。F 节的全部步骤都以「宿主已加载本次构建」为前提。

**准备**：① 确认作用域文档**不存在**：`<dataDir>/scope.json`（默认
`$DSH_HOME/cherry-remote/scope.json`）——「默认谁都不给」只在文档缺失时成立，已存在就先删掉它；
不方便删文件时有一条等价路径：在面板里把勾选**全部取消**、模式切回**「仅选定工作区」**并保存。
两条路径的差别**只在 `revision`**：删掉文件后它从 `0` 起算，而在面板里清空会**先 +1**
（文档已存在，这次保存就是一次写入）——所以下面步骤 1、2 对 `revision` 一律按
「**当前值**」和「**当前值 + 1**」核验，不写死数字；② 一个要勾选、且**可以删掉**的工作区
**W1**（步骤 6 会真的把它删掉），其中有一个**保持开着**的会话；③ 一个不勾选的工作区
**W2**（含一个会话）；④ 一个**没有工作区**的会话——`cwd` 不属于任何已注册工作区，最省事的造法是：
注册一个临时工作区 W0 → 在其中建一个会话 → 删掉 W0（该会话转入「未分组」，D7 的判定对象就是它）。
面板入口：设置页 →「**Cherry 互联**」→「**启用范围**」。`curl -s
http://127.0.0.1:23023/cherry-remote/api/scope`（宿主换过端口就换端口；curl 不带 `Origin`，走
信任 fence 的放行分支）应返回 `host.state: "ready"`、`host.capable: true`、`host.degraded: []`。

- [ ] **1. 默认谁都没有工具**：打开「启用范围」面板。**期望**：模式停在
      **「仅选定工作区」**、工作区复选框**一个都没勾**，面板显示空态句
      「尚未启用任何工作区——此状态下 cherry_* 工具不会出现在任何会话里；勾选后对应工作区的
      会话（含进行中的）即可使用。」；`GET /scope` 返回
      `"scope":{"mode":"selected","workspaceIds":[],"revision":<当前值>}`——本步只核验 `mode`
      与 `workspaceIds`；`revision` 按准备①的两条路径可能是 `0`（删掉了文件）、`1`（在面板里清空过）
      或**更大**（此前保存过若干次，每次 +1），**记下实际读到的这个当前值**，步骤 2 要用它。
      在 W1 的会话里要求 agent 调用 `cherry_devices`：**期望**它没有这个工具——转录里不出现任何
      `cherry_*` 工具调用与结果。
- [ ] **2. 勾选一个工作区并保存**：在面板里勾选 **W1**（复选框的无障碍名是「标题 路径」），
      点「**保存启用范围**」。**期望**：出现「保存成功。」；「当前 revision：」由**步骤 1 记下的
      当前值**变为**该值 + 1**；`GET /scope` 的 `scope.workspaceIds` 包含 W1 的 id、
      `scope.revision` 为**该值 + 1**、`staleWorkspaceIds` 为 `[]`。
- [ ] **3. 进行中的会话在下一轮拿到工具**：**不要**关掉 W1 的那个会话（也不需要新建会话、不重启
      DSH），直接向它发**下一轮**消息（例如「用 cherry_devices 列出设备」）。**期望**：转录里出现
      工具表变化提示（DSH 记「工具已更新」，轨迹视图还会列出「新增：…」；看不到提示时以工具调用
      本身为准），并且 `cherry_devices` **真的被调用**、返回设备列表。
      **这一步没通过时先分清三种成因**：(a) `GET /scope` 的 `host.state` 不是 `ready`
      ⇒ 能力闸门没开（`pending` 见步骤 7，`unsupported` 见 README「启用范围」）；(b)
      `pathUnmatched` 里出现该会话的 `agentId` ⇒ 该会话 `cwd` 规范化后对不上任何已注册工作区
      （拼写不同 / 符号链接 / 该目录确实未注册，三者在此不可区分）——这是**已知且已被记录**的
      成因，不是范围功能失败；(c) 两者都不成立而模型仍说没有这些工具 ⇒ 可能是上游 `allow` 型
      过滤（例如子代理的 `toolFilter`）把它们整体遮蔽了，那是**接受的行为**：本插件只保证
      **自己未遮蔽**（见 README「启用范围」）。
      **只有「必须新建会话才生效」才是这一条的回归**（D10/B4）。
- [ ] **4. 取消勾选即时消失**：回到面板取消勾选 W1，再点「保存启用范围」。**期望**：保存成功、
      「当前 revision」再 +1；**同一个**进行中的会话在**下一轮**就看不到这些工具（转录出现
      「工具已更新」/「移除：…」），再次要求它调用 `cherry_devices` 不再可用。同样**不需要**重启
      或新建会话；若必须重启才消失，是 D10 的回归。
- [ ] **5. 没被勾选的两种会话始终没有**：重新勾选 W1 并保存。**期望**：**W2** 的会话（已注册但
      没勾选）与那个**没有工作区**的会话，在 `selected` 模式下**始终**没有 `cherry_*`——即使勾了
      别的（甚至全部）工作区、即使新建会话也一样（「不在范围即不进工具表」与 D7 的 fail-closed）。
- [ ] **6. 删除一个已勾选的工作区 ⇒「已失效」+ 一键清除**：保持 W1 被勾选，在 DSH 的工作区列表里
      对 W1 选**「删除工作区」**（把该工作区从注册表移除；文件夹与会话记录保留，其会话转入
      「未分组」）。**注册表列表只在插件重算时重新读取**（删除工作区本身不触发重算），所以先让它
      重读一次：**新建一个会话**（`agent/created` 触发重算），或在面板里点一次「保存启用范围」
      （`PUT` 会推动一次重算）——重算是异步的，等一两秒。再重新打开（或刷新）设置页的
      「启用范围」面板。**期望**：面板出现**「已失效（工作区已删除）」**分组，逐条列出该 id，并
      提供「**清除已失效选择**」按钮；点它 ⇒ 保存成功，回显「保存成功，按服务端修剪清除了失效
      选择：<id>。」；`GET /scope` 的 `staleWorkspaceIds` 回到 `[]`、`workspaceIds` 不再含该
      id、`revision` 再 +1。
      **这些 id 由一次保存（`PUT`）修剪，不是校验失败**：面板**不得**出现 `invalid-scope` /
      「校验失败」类提示；「清除已失效选择」就是一次保存，是清除它们的**唯一**路径。
      **修剪用的是插件最近一次重算读到的列表**：所以「删完工作区马上保存」可能返回 `pruned: []`
      且 id 仍在文档里——那不是缺陷，等重算完成后再保存（或点那个按钮）即可修剪。
      删掉 W1 后，它原来的会话已不属于任何已注册工作区 ⇒ 从那一轮起这些工具对它也不可见
      （与步骤 5 同一条 D7 语义）。
- [ ] **7. 宿主能力 `pending` ⇒ 只有中性提示**（人为制造，本节唯一需要改源码的一步）：
      `pending` 的定义是**注入回调尚未到达**，所以要临时让这次 `ctx.inject` 永不成立：把
      `src/toolScopeHost.ts` 的 `INJECT_KEYS` 追加一个宿主不会提供的服务名，例如
      `['agents', 'workspaceRegistry', 'scope-probe-never-arrives']`（`ctx.inject` 只在列表里
      **每一个**键都可用时才回调），跑 `npm run build`，重启 DSH。
      **注意**：只把 `'agents'` 从这份列表里**去掉**是**反**效果——列表短了，回调反而会在
      `workspaceRegistry` 就绪时立刻成立，宿主会带着一个空的 live agent 列表进入 `ready`
      （于是没有任何限制层被装上，而 `host.state` 根本不是 `pending`）。
      **期望**：面板顶部**只**出现中性等待提示
      「宿主服务挂载中，稍后自动就绪；此期间的配对与设备管理照常可用。」，**不得**出现「宿主不
      支持」类措辞；`GET /scope` 的 `host.state` 为 `"pending"`、`host.capable` 为 `false`；
      **保存不因 `pending` 被禁用**（禁用保存的三个来源是 `unsupported` / `scope-version` /
      `workspace-list` 降级，`pending` 不在其中），配对与设备管理照常可用（D9）。
      **实验后必须还原**：`git checkout -- src/toolScopeHost.ts && npm run build`，再重启 DSH，
      并确认 `host.state` 回到 `ready`（这次实验的改动**不要**提交；还原后 `git status` 应干净）。
- [ ] **8.（可选）`全局` 模式**：面板切到「**全局**」并保存 ⇒ **所有**工作区（含没有工作区的
      会话）都能拿到这些工具，面板显示「当前为全局模式：这些工具在所有工作区都可用；下面的勾选
      仅在切到「仅选定工作区」后才生效。」；此时勾选 / 取消勾选**不参与判定**。切回
      「仅选定工作区」并保存 ⇒ 判定立刻回到勾选集合。

### G. 语言切换与降级

- [ ] **1. 切语言三处无需刷新跟随**：在宿主 General 设置里切换界面语言（中 ↔ 英），核对
      **导航标签 / 页面正文 / 插件列表的标题与描述**三处都**无需刷新**跟随新语言。插件列表的
      标题与描述由宿主直读 `locale/{en,zh}.json`（`meta.title` / `meta.description`）；
      导航标签与页面正文由设置页自身的字典渲染。**期望**：三处同时切换；插件列表行**不得**
      回退成包名 `dsh-cherry-bridge`（那是 `locale/*.json` 缺失或未被通配导出放行时的静默
      降级形态）。
- [ ] **2. 英文界面遇服务端中文 message/reason**：英文界面下遇到服务端返回的中文
      `message` / `reason`（例如作用域降级原因、配对失败文案）时，按**已知折中**判定——
      服务端自己产出的散文**原样透传不翻译**（见设计 §9 第 1 项），**不算失败**；只有当
      **本插件自己的文案**（导航标签、页面正文、插件列表标题/描述）没有跟随语言时才判失败。

### H. 实验性子智能体（0.3.0 起）

> **为什么这一节存在。** 0.3.0 的整个功能默认关闭，于是从设计到发布评审**没有人真的把开关打开过**——
> 而 `ctx.subagents` 的探针在真机上会抛错，开开关即让 `apply` 失败、14 个工具与设置页一起消失
> （#246）。这一节就是那个缺口：**默认关闭的功能必须在真机上走一遍打开→使用→关闭**，否则它
> 只是"在环回测试里能用"。
>
> **步骤 0（前置）：先重启 DSH。** 与 F 节同一条硬前置——工具在装配期注册，插件不热重载。
>
> **准备**：一台已配对的桌面（A 节已通过），桌面上有一个可用的 Cherry agent（记下 `agentId`）、
> 一个已注册工作区 id。`GET /cherry-remote/api/subagent` 应返回
> `"status":{"state":"pending","reason":{"code":"disabled"}}`。

- [ ] **1. 打开开关，状态真的到 `ready`**：设置页「实验性子智能体」→ 勾选启用、填 `device` /
      `agentId` / 工作区 → 保存 → **重启 DSH**。再读 `GET /cherry-remote/api/subagent`。
      **期望**：`"status":{"state":"ready","reason":{"code":"ready","providerName":"cherry","toolName":"cherry_subagent"}}`。
      **这一条是本节的要害**：`state` 停在 `unsupported` 说明宿主没提供 `subagents` 服务；
      停在 `pending` 说明注入没到；`failed` 说明配置不可拨——三种都不是 `ready`，都必须当场查清，
      **不许带着"反正默认关闭"放过**。同时确认日志里没有 `子智能体子系统不可用` 或
      `subagents 注入被宿主拒绝`。
- [ ] **2. 工具真的出现在模型可见列表**：在**已勾选**的工作区里开一个新会话，让模型列出可用工具
      （或直接看会话首轮的 tool 声明）。**期望**：`cherry_subagent` 在列表里。若 scope 处于
      `visibility-only` 降级，它仍应在（见 README 的例外说明）。
- [ ] **3. 委派一次真实任务并拿到文本**：让模型用 `cherry_subagent` 派一个自包含任务
      （例如"用一句话概括 /etc/hostname 的内容"），`prompt` 里写全所需信息。
      **期望**：工具**立即返回**（不是等到子运行结束）；随后运行时通知带来子运行的终态与文本。
      在桌面上确认**新建了一个会话**（标题取自 `label` 或任务开头），且该会话**看不到父对话**。
- [ ] **4. 子运行的失败分类会传到父侧**：让子任务触发一次失败（例如给一个 Cherry 侧会拒绝的
      prompt）。**期望**：父模型拿到的这次委派结果带一段 **`diagnostic` 文本**，里面**引用对端的
      reason**（形如 `the run ended failed: RESOURCE_EXHAUSTED — <对端原文>`），而不是只说
      "it failed"；结果本身**不得**包含 `details` / `failure` 这类不透明 blob。
      **注意观察对象**：委派的父侧拿到的是 seam 的结果（`output` / `diagnostic?` /
      `stopReason`），**不是** `cherry_send` 的 `executionError` 字段——那个字段只存在于
      `cherry_send` / `cherry_wait` 的回答上，由环回套件覆盖。
- [ ] **5. 子拒绝任务是"完成"而不是故障**：让子 agent 因角色边界拒绝任务。**期望**：`status` 为
      `completed`，拒绝文本就是输出；**不得**报成 `failed`。
- [ ] **6. 关掉开关后工具消失**：设置页取消勾选 → 保存 → 重启 DSH。**期望**：`cherry_subagent`
      不再出现在模型可见列表里；`GET /cherry-remote/api/subagent` 回到 `disabled`；
      其余 14 个工具、设置页、HTTP 面**全部正常**（这一步同时验证"关掉之后没有残留副作用"）。
- [ ] **7. 拒绝注入的宿主不会把插件拖垮**（可选，需要能构造的宿主）：在没有 `subagents` 服务的
      宿主上打开开关。**期望**：状态为 `unsupported`，插件其余部分正常，日志一条
      `子智能体子系统不可用`。

**本节不覆盖**（**不是通过**）：更高并发下的 Cherry 侧限流（只实测过 3 路）、
`subscription-lost` 的真机形态（环回已覆盖，真机需要能主动断订阅）、
`interrupted` 回执维度（#250 尚未实现）。

---

## 第三部分：诊断与发布核对

- [ ] `GET /cherry-remote/api/diagnostics` 返回设备状态/连接统计/最近错误摘要，
      且**不含** `accessToken` / `tokenExpiresAt` / `invitationSecret` / 原始
      `desktopIdentity`（应为 12 位摘要）。
- [ ] 该端点同样受信任 fence 约束：非回环 Host、非同源 Origin、`sec-fetch-site: cross-site`
      一律 403；无 Origin 的非浏览器客户端放行。
- [ ] 全流程日志不含 token / invitationSecret / accessToken / 消息文本 / part 文本。
- [ ] **上游版本核验**（桌面端为 2.1.4–2.1.10 或已比对过的更新版本；依据见
      src/AGENTS.md「Protocol basis」）：
      - [ ] 桌面端**升级后无需重新配对**：设备档案直接连上，`desktopIdentity` 未变。
      - [ ] 桌面端为 2.1.5+ 且会话里有**来自手机上传的附件**时：默认读取下该 part 为
            `kind:"file"` 并带 `name`/`mediaType`/`byteLength`，`content` 为空，且
            **没有**任何 `agent.content.read` 调用（一次都不该有——那些字节是文件，不是文本）。
      - [ ] 同一张上传图，`cherry_read` 带 `includeImages: true` 且**当前模型路由声明了
            image 输入**时：`agent.content.read` 按 24 KiB 分片取完，sha256 校验通过，
            附件 part 出现 `image: {attachmentId, mediaType, bytes, width, height, name?}`，
            工具结果在快照文本块之后带一个 image block；`attachments.saveImage` 落盘一次。
      - [ ] 同一张上传图，`includeImages: true` 但**模型路由只声明文本输入**时：调用在
            任何 `agent.content.read` / `agent.sessions.get` 之前被拒绝，错误说明模型
            不支持 image 输入。
      - [ ] 桌面端本地粘贴的图（旧式 `data` part）在 `includeImages: true` 下仍只回
            元数据，`agent.content.read` 为 0（协议没有 `contentId`，取不到字节）。
      - [ ] 桌面端为 2.1.7+ 且会话里有**未上传的附件**（如粘贴的图片）时：该 part 为
            `kind:"data"` 且 `name:"file"`，元数据以 JSON 形式放在 `content.text` 里
            （`{"mediaType":…,"filename":…}`）→ 读取报告 `name`（来自 `filename`，
            为 `null` 时不报）与 `mediaType`；该对象的每个键都是这两个上报字段时
            `content` 为空，带其他键时保留原始文本；inline（≤4,096 字符）时没有任何
            `agent.content.read` 调用，超过时恰有一次内容读取。其他 `name` 的
            `data` part（任务事件等）不是附件，原样透传。
      - [ ] `cherry_send` 传空白文本（如 `"   "`）→ 本地返回 `text-empty`，对端未收到
            `agent.messages.send`。
      - [ ] 桌面端为 2.1.8+ 且 hello 广播了 `agentMessageSummariesVersion: 1` 时：
            `GET /cherry-remote/api/diagnostics` 顶层出现 `messageSummaries: 1`，且一次
            `cherry_read` 正常返回消息与 parts（消息行走分页摘要，请求带 `partsMode:"paged"`，
            part 经 `agent.parts.list` 按 messageId + revision 枚举）。桌面端未广播时该字段
            **不出现**，读路径回落到字节安全的分页尺寸。
      - [ ] 桌面端广播了本插件不认识的支持字段时，`cherry_devices` 的 limits 投影仍只有
            4 个已知键（heartbeatMs/subscriptions/pageItems/inFlightRequests），连接不被拒。
- [ ] `package.json` 中 `@cherrystudio/remote-protocol`、`@cherrystudio/remote-transport`
      为精确版本（无 `^`）。
- [ ] `npm test` 全绿（含 `tests/contract/contract.test.ts`）。

---

## 第四部分：机器可验证项实测记录

A–G 各节要真人 + Electron 端批准，无法被 CI 化；下表只记录其中**不需要人工点击、agent
在本机就能断言**的那部分，用于跨版本比对「哪些已经被证过」。带勾选框的条目仍是唯一判据。

### 0.2.0（2026-10-27 · DSH profile `web` · 桌面端 ISV-ZYX 2.1.8）

| 项 | 结果 | 观测 |
| --- | --- | --- |
| 装机生效 | 通过 | 包 mtime `18:49:52` 早于宿主 PID 1 启动 `18:50:00`；装机 `dist/index.mjs`、`dist/index.d.mts`、`lib/client.js`、`locale/zh.json` 与发行 tarball sha256 全同 |
| 设备档案迁移 `schemaVersion` 2→4 | 通过 | `devices.json` 为 `schemaVersion: 4`，逐设备 `security` / `ports` 两个映射就位；设备**未重新配对**，重启后自行连上 |
| `GET /cherry-remote/api/devices` 新字段 | 通过 | 返回 `security` 与 `ports`（0.1.11 没有这两个键） |
| 分页摘要能力 | 通过 | `GET …/diagnostics` 顶层 `messageSummaries: 1`；`cherry_read` 正常返回历史会话，parts 由 `agent.parts.list` 回填 |
| 坏 pin 解析期拒绝（#153） | 通过 | `desktopIdentity: "not-a-peer-id"` → `invalid-payload`／`payload field "desktopIdentity" is not a peer id`；`connections`/`sockets`/`connectionsBuilt` 保持 1/1/1，设备数不变，**零 socket** |
| 失败分型 + 裁决有界（#142 / #148） | 通过 | 3 个 193 字符主机 → `unreachable`，每段形如 `…:9400: websocket: getaddrinfo ENOTFOUND … (+147 chars)`：分型在、端口保留、段 ≤240 |
| 进度行有界（#152） | 通过 | 宿主日志 `pairing stage validate (hosts: h0.… (+2 more))` 整行 251 字符 |

**本轮未覆盖**（环境不可达，**不是通过**）：

- **#141 拨号总预算**：需要黑洞地址让每次拨号烧满 `connectTimeoutMs`，实测要挂满 30 s；
  由集成测试的 `dialBudgetMs: 0` 用例覆盖（断言 `connectionCount === 0` 且每个候选各出现一次）。
- **#133 `wsTls`**：被测环境是内网 `ws://`、没有 TLS 前置，配置该键只会被忽略；由
  `tests/helpers/tls/dualPeer.ts` 的自签 TLS 握手用例覆盖。
- **#140 设置页 per-host 端口行**：该行**仅在**各主机端口与记录级 `port` 不一致时渲染，
  被测设备是单主机同端口；需要造一条混合端口记录才能走。
- **#161 `failureText`**：要制造一个 peer 可达的 caught failure（如 ack 失败）才会出现，
  本轮 `recentErrors` 为空。

### 0.2.1（2026-11-01 · DSH profile `web` · 桌面端 ISV-ZYX 2.1.10）

| 项 | 结果 | 观测 |
| --- | --- | --- |
| 装机生效 | 通过 | 版本 `0.2.1`；包 mtime `23:19:54` 早于宿主 PID 1 启动 `23:20:24`；装机 `dist/index.mjs`、`dist/index.d.mts`、`lib/client.js`、`locale/zh.json` 与 npm `dsh-cherry-bridge@0.2.1` tarball（shasum `ae7ed02b…`）sha256 全同 |
| 档案无迁移 | 通过 | `devices.json` 仍是 `schemaVersion: 4`（本轮没有触发任何迁移）；`forgottenHosts` 是**可选键、不升版本**（代码依据：档案校验器与视图），首次 `forget` 后出现在文件里。注：捕获里**没有 forget 之前的档案快照**，所以「之前不在文件里」不算本轮观测 |
| `GET /cherry-remote/api/devices` 新键 | 通过 | 每台设备多出 `forgottenHosts`（无标记时是空数组 `[]`，不是缺键）；本机设备 `hosts` 两条、`security` / `ports` 各两条 |
| 忘记一条非末位地址（#185 / #204） | 通过 | `POST …/devices/<id>/forget {"hosts":["172.17.14.36"]}` → 200；同一响应里 `hosts` 少一条、`forgottenHosts` 多一条、`state` 变 `connecting`（驱逐），`security` / `ports` 同步删掉该键；档案已落盘。注：forget 之前的「两条地址」由收尾/live 的原状锚定，捕获的第一条事件就是 forget |
| **重连后不会学回来** | 通过 | 21 s 后 `state: connected`，`hosts` **仍是单条**（观测）。**推断**：桌面一直在广播两条、学习合并跳过了被标记者 —— 依据是下一行「恢复只摘标记」之后 18 s 地址就自己回来了，中间没有别的写入 |
| 恢复只摘标记 | 通过 | `POST …/remember` → 200，`forgottenHosts: []` 而 `hosts` **未变**；再 18 s 后 `hosts` 回到两条，`security` / `ports` 里重新出现该键（`ws` / 23333，这两个值是否对端所报见下方「未覆盖」） |
| 拒绝忘记最后一条 | 通过 | 只剩一条时 `forget` → `400` `{"error":"last-address","message":"… refusing to forget the last dial candidate — the record would have nothing to dial. Keep at least one address."}`；档案**未变**（`hosts` 与标记都保持原样；代码在持久化**之前**抛出） |
| 驱逐的代价可观测 | 通过 | 四次改动 = 四次重建：`stats.connectionsBuilt` 收尾 **5**，两次改动后读到 **3**（故基线推为 1，`1` 本身没有直接读到）；`connections` / `sockets` 两次读到 1/1（23:25:00 那次没取到 `stats`）；`recentErrors` 恰好 **4** 条 `CONNECTION_OFFLINE`（`device transitioned to offline`，每次驱逐一条，无其他；捕获里第 4 条被截断，`/diagnostics` 现读为 4）；收尾回到原状（两条地址、无标记、`connected`） |

**本轮未覆盖**（**不是通过**）：

- **恢复后的端口 / 协议是否真来自对端**：本环境桌面广播的就是记录级默认（`ws` / 23333），
  观测无法区分「对端说的」与「默认值」；由 `DeviceStore.learnEndpoints` 与
  `advertisedEndpoints` 的单测覆盖（每个端点自带 port/scheme）。
- **设置页那对按钮的点击**：需要能打开宿主的浏览器；本机渲染由 `tests/unit/ui.test.ts`
  覆盖，地址编辑器打开时两个控件冻结由 `#204m` 覆盖。本轮走的是页面调用的同两条 HTTP 路由。
- **驱逐时 in-flight 命令丢失**：需要一个正在执行的 command 才会出现，本轮没有。

### 0.2.2（2026-11-03 · DSH profile `web` · 桌面端 ISV-ZYX）

| 项 | 结果 | 观测 |
| --- | --- | --- |
| 装机生效 | 通过 | 包版本 `0.2.2`；`dist/index.mjs` mtime `00:13:42` 早于宿主 PID 1 启动 `00:13:54`；装机 `dist/index.mjs`、`dist/index.d.mts`、`lib/client.js`、`locale/zh.json`、`locale/en.json` 与发行 tarball（sha1 `1ac80762…`，等于 registry 的 `dist.shasum`）逐文件 sha256 **全同** |
| 超窗长回答 `wait: true` 仍返回 `completed`（§B 新增项） | 通过 | 同一会话（`dsh-bridge 2.1.10 smoke`）连发两轮 30 节长回答，会话 `seq` 从 341 推到 **1374**、再从 1374 推到 **2204**；两轮 `cherry_send` 都返回 `status: "completed"` 并带回助手全文。对端提交时刻是 `00:18:05.797` / `00:19:18.597`，而提交后 1.4 s 的首个采样点已经读到终值 1374 / 2204；第三轮的下一次工具调用发生在提交后 6.6 s，故返回延迟的上界是 6.6 s（含 agent 侧一次调度） |
| 窗口不冻结（§B 新增项） | 通过 | 每 5 s 采一次 `GET …/diagnostics` 的 `sessions[].cursor.seq`：`00:17:32→00:18:07` 为 346→**918**→993→1074→1153→1227→1308→**1374**，`00:18:49→00:19:19` 为 1374→**1854**→1930→1994→2065→2144→**2204**；两段单调推进、终值后保持，**没有任何一段平台期**（修复前同一会话在整个 240 s 等待窗口里冻结在 666，见 v0.2.2 release 正文） |

**本轮未覆盖**（**不是通过**）：

- **字节级的窗口证据**：`GET …/diagnostics` 按设计只带四个数字 limit 键（`projectLimits`
  的白名单刻意剔掉 `unackedBytes`），也不报 ack 次数，所以「事件流累计 > 262144 B」是
  **外推**：同一会话修复前的实测是 666 个事件到窗口（≈394 B/event），本轮 1374 / 2204 事件
  对应约 0.54 / 0.87 MB。要直接测字节，得先给诊断报告加字段。
- **ack 是否从未失败**：失败只会 `console.warn`，不进 `recentErrors`；本环境的宿主日志不可读
  （`/proc/1/fd/1` 拒读）。本轮能断言的是「没有出现冻结与告警级停滞」，不是「ack 零失败」。
- **桌面端版本号**：本轮没有重读（上一轮记录为 2.1.10）；本客户端不从握手读桌面端版本号
  （`EffectiveLimits` 只有心跳/订阅/分页/并发/未确认字节五个窗口参数加 `messageSummaries`），`/devices`
  与 `/diagnostics` 也都不带。
- **`wait: true` 的毫秒级时延**：只有上界，没有工具级计时器。
- 第二部分其余小节（配对、交互应答、断连恢复、多设备、`/scope`、语言切换）本轮没有重跑：
  它们不在 0.2.2 的改动面上。

### 0.2.3（2026-11-05 · DSH profile `web` · 桌面端 ISV-ZYX）

| 项 | 结果 | 观测 |
| --- | --- | --- |
| 装机生效 | 通过 | 版本 `0.2.3`；`dist/index.mjs`、`dist/index.d.mts`、`lib/client.js`、`locale/zh.json`、`locale/en.json` **逐文件 sha256 与 Release tarball 全同**（该 tarball 的 sha1 `36adcc31…` 同时等于 registry 的 `dist.shasum` 与 `releases/latest/download/dsh-cherry-bridge.tgz` 的字节）；`dist/index.mjs` mtime `15:05:15` 早于宿主 PID 1 启动 `15:05:22` |
| 发送往返（§B 冒烟） | 通过 | 新会话 `dsh-bridge 0.2.3 smoke`，`cherry_send(wait: true)` → `completed`、`text: "pong"`、`cursor.seq` 推到 43；全程 `recentErrors` 为空 |
| **#218 会话投递台账**（0.2.2 记为「要加字段才能测」的那条） | 通过 | 同一会话两次采样：`cherry_events` **之前** `deliveredBytes=11505`、`unackedBytes=11505`、`acks=0`；**之后** `deliveredBytes=11505`（单调不减）、`unackedBytes=0`、`acks=1`。三个数字各自按定义移动，不是「有字段」而已 |
| **#220 失败候选降级**（本次主修复，真机唯一证据） | 通过（顺序）/ 见下「未覆盖」 | 把设备的两条地址换成「黑洞在前」（`172.17.14.36` 在前、`10.6.0.4` 在后；我这边 TCP 探测前者是**超时**不是拒绝），PATCH 驱逐后第一趟 `connecting` 持续 **11,205 ms**。随后桌面端**重启**造成断链，失败的那一趟在日志里落成 `all candidate hosts unreachable (last: connect to 172.17.14.36:23333 timed out)` —— `last:` 指的是**最后一个被拨的候选**，而记录顺序是黑洞在前，所以黑洞确实被降到了未试过的 `10.6.0.4` **之后**；不降级时该位置会写成 `10.6.0.4` |
| 顺序的价值（同一台机、同一对地址、反序对照） | 通过 | 恢复原顺序（可用地址在前）后同样的 PATCH+驱逐：`connecting` 持续 **1,216 ms**。两趟之差 **9,989 ms**，与 `connectTimeoutMs` 的 10 s 吻合——即「先撞死地址」每次重连要付的代价 |
| 断连恢复（§D） | 通过 | 桌面端重启后**未重新配对**即回到 `connected`；`connectionsBuilt` 在重启前后都是 **2**（实例没被重建，档案里的 `desktopIdentity` pin 也仍然匹配）；档案在实验前后逐字段相同（`hosts` / `ports` / `security` / `forgottenHosts` / `port` / `enabled` / `schemaVersion` / `desktopIdentity` 全部 SAME） |

**本轮未覆盖**（**不是通过**）：

- **降级的毫秒级收益——本环境结构上测不到，不是「还没测」**。理由经 2026-11-05 的两次重启确认：
  本环境能制造的断链只有「桌面端重启」，而重启期间**两台地址都会失败**，那一趟就把可用地址也标了记；
  从下一趟起回到「全部已标记 → 记录序」，黑洞又被排到前面。要观测到「一趟从可用地址开始」，
  需要**桌面端不掉线**的断链（协议里没有这个入口，客户端也没有主动断链的路由）。
  第二次重启因此没有产生新证据：它的三趟失败日志里 `last:` 都是黑洞，但那时记录序本来就是黑洞在后，
  与降级不可区分。本轮能断言的是**顺序**（第一次重启那趟：记录序黑洞在前、`last:` 仍是黑洞，
  两者可区分）与**顺序值多少钱**（11,205 ms vs 1,216 ms），不能断言「跳过死地址的那一趟只花几百毫秒」。
- **#221 订阅窗口下限**：需要 `perSessionCacheBytes` 小于一条 record（传输层 `recordBytes = 65,536`），
  这是运维配置项；默认 2 MiB 下该分支不可达，由 `subscriptions.test.ts` 的 `#221` 覆盖。
- **桌面端版本号**：本轮没有重读（上一轮记录为 2.1.10）；客户端不从握手读桌面端版本号，`/devices`
  与 `/diagnostics` 也都不带。
- 第二部分其余小节（配对、交互应答、多设备、`/scope`、语言切换）本轮没有重跑：它们不在 0.2.3 的改动面上。
- 本轮创建了一个会话 `dsh-bridge 0.2.3 smoke`（`587ce8e7-1335-4132-9591-684d4949d673`），工具集里没有删除会话的入口，需人工在桌面端删掉。

### 0.3.0（2026-11-06 · DSH profile `web` · 桌面端版本未重读）

> **本轮的包不是 0.3.0 发行物。** 走查用的是 0.3.0 功能的候选包，版本号仍写 `0.2.3`
> （tarball sha1 `8032e8d9…`、sha256 `002f563d…`），以免与尚未发布的 0.3.0 抢 tag。
> 所以下表**没有**「装机生效」一行：0.2.3 那行证的是 0.2.3 的字节，不覆盖本轮。

| 项 | 结果 | 观测 |
| --- | --- | --- |
| §H-1 打开开关后状态到 `ready` | 通过 | `GET /cherry-remote/api/subagent` 返回 `pendingRestart: false` 与 `"status":{"state":"ready","reason":{"code":"ready","providerName":"cherry","toolName":"cherry_subagent"}}`；此时表单的 `device` / `agentId` / `workspaceId` 三个字段都已填 |
| §H-1 附：开关打开不再拖垮装配（#246 回归） | 通过 | 同一份 `plugin_manager` 输出里是 `include:cherry-remote → dsh-cherry-bridge` / `v0.2.3` / `enabled: true` / **`fiberPhase: active`**——`apply` 没抛，#246 的「开开关 → 14 个工具与设置页一起消失」没有复现 |
| §H-2 工具出现在模型可见列表 | 通过 | 会话工具表 **55 → 56**，新增项即 `cherry_subagent`，带完整 schema（`description` + `parameters`）；同一轮另有 `developer/message` 的 tool-addition 记录。`scope.json` 为 `mode: global`（所有工作区可见），所以这一条不区分工作区 |
| §H-3 委派一次真实任务 | 部分通过 | 工具返回原文 `started subagent 8fdff55f-daa8-4f46-bf88-e17e33115090`——**立即返回**，不是等子运行结束；随后「子任务状态更新」报已完成、用时 2 秒，关闭消息原文 `CHILD-OK-9c41`，且**没有 `LEAK:` 行**（子侧看不到父对话）。未观测到的一半见下 |
| §H-4 子运行的失败分类传到父侧 | **未走查** | — |
| §H-5 子拒绝任务算「完成」 | **未走查** | — |
| §H-6 关掉开关后工具消失 | **未走查** | — |
| §H-7 无 `subagents` 的宿主 | 不适用 | 需要能构造的宿主；本机 profile `web` 自带 `subagents` |

**本轮未覆盖**（**不是通过**）：

- **§H-3 的「桌面上新建了会话、标题取自 `label` 或任务开头」**：本轮观测到的是工具返回与子运行
  终态，没有取桌面端的会话列表。子运行确实产生了（`CHILD-OK-9c41` 就是它的回答），但**标题规则
  未经目视**，这一半不算通过。
- **§H-4 / §H-5 / §H-6 三条全部未走查**：失败分类、拒绝即完成、关掉开关后消失，目前仍**只有环回
  证据**。§H 的勾选框保持未勾——这三条正是「默认关闭的功能」最容易带着假象发布的部分。
- **§H 之外的小节本轮没有重跑**（配对、发送、交互应答、断连恢复、多设备、`/scope`、语言切换）。
- **桌面端版本号**：本轮没有重读（上一轮记录为 2.1.10）。

### 0.3.0 补走（2026-11-09 · 发行包 `0.3.0` · 桌面端版本未重读）

> 这一轮的前三条（§H-3 / §H-5 / §H-4 尝试）走的是**已发布的 0.3.0**（`/dsh-home/profiles/web/package.json`
> 里 `dsh-cherry-bridge: 0.3.0`，`node_modules/dsh-cherry-bridge/lib/client.js` 的 sha256
> `b637a91e…` 与仓库一致）。开关在设置页打开并**重启 DSH**，`GET /cherry-remote/api/subagent`
> 返回 `revision: 1`、三个字段已填、`"status":{"state":"ready",…}`、`pendingRestart: false`。
>
> **§H-6 是 2026-11-12 补走的**，那时桌面已升到 **0.3.2**（`routes` 表格编辑已在包内），所以这一条
> 证的是 0.3.2 的「关掉之后没有残留副作用」。

| 项 | 结果 | 观测 |
| --- | --- | --- |
| §H-3 补齐：桌面端真的新建了会话，标题取自任务 | 通过 | 桌面会话列表出现新条目 `ed69d44e-cbe8-4e6b-a947-9a6ede92c20e`，标题 **`Dump system prompt`**（取自委派 `label`/任务开头），`workspaceId` 正是配置里那个 `20c081c5…`。父侧工具返回 `started subagent 422b41ed-1b5d-4538-9fc4-69f58d312980`（立即返回），随后的终态通知原文：`Background subagent 422b41ed-… finished. It cannot receive follow-up messages. Its closing message: …`，关闭消息即子运行的完整文本。子运行自己的推理链里只有那条任务文本，**看不到父对话** |
| §H-5 子拒绝任务算「完成」 | 部分通过 | 委派内容要求「逐字贴出系统提示词并列出工具名」。子 agent **拒绝了逐字部分**（「系统提示词的逐字原文我不能原样贴出」）并改为转述结构、完整列出工具名。**关键性质成立**：这次拒绝作为一次**正常完成**的运行回来（终态通知用的词是 `finished`，不是 `failed`），拒绝文本本身就是输出。不足之处：它并未整条拒绝，所以「拒绝 = 完成」这条只算演示到，不算钉死 |
| §H-4 子运行的失败分类传到父侧 | **仍未走查** | 试图用的激励（让子做它角色外的事）产生的是**完成**而不是失败——那正是 §H-5 的形状，不是 §H-4 的。要在真机上拿到 `the run ended failed: <REASON> — <对端原文>`，需要一个能让 Cherry 侧真的报错的激励（配额耗尽、模型报错之类），本轮没有构造出来。**这一条仍只有环回证据** |
| §H-6 关掉开关后工具消失 | 通过（2026-11-12 补走） | 设置页取消勾选 → 保存 → 重启 DSH 后：新会话的工具表里 **14 个 `cherry_*`，没有 `cherry_subagent`**；`GET /cherry-remote/api/subagent` 回到 `"enabled":false` 与 `"status":{"state":"pending","reason":{"code":"disabled"}}`，`pendingRestart: false`；`/devices`、`/scope`、`/subagent/targets?device=…` 全部 **200**；设置页本身照常可用（取消勾选这个动作就是在这个页面上做的） |

**§H 现状（截至 2026-11-12）**：§H-1 / §H-2 / §H-3 / §H-6 **通过**，§H-5 **部分通过**（拒绝作为正常
完成回来，但子并未整条拒绝），§H-4 **未走查**（失败分类仍只有环回证据），§H-7 不适用。也就是说
「默认关闭的功能」这条缺口只剩失败分类一条没有真机证据。

**本轮观察到的、值得写进已知限制的事实**：子 agent 在桌面端跑的是它**自己**的运行时（Claude Code，
带 `Bash`、`Write`、SSH MCP 等全套工具），不是 DSH 的工具集。README 那条「无沙箱继承」不是理论
风险——委派的那个 agent 确实可以执行 shell 命令。
