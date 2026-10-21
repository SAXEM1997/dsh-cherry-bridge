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
2. **真机主流程**——配对 / 发送 / 交互应答 / 断连恢复 / 多设备并存 / 工具启用范围（`/scope`）。

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
