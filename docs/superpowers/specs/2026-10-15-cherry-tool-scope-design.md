# dsh-cherry-bridge 工具启用范围 + 配对文案 设计文档

- 日期：2026-10-15
- 状态：待用户复审（R2 修复后）
- 路径分类：Architectural（新增宿主集成子系统 + 配置面）
- 上游设计：[2026-10-09-cherry-dsh-bridge-design.md](2026-10-09-cherry-dsh-bridge-design.md)

## 1. 目标与背景

本插件现有 14 个 `cherry_*` 工具在**所有**工作区全局注册：每个会话的工具表里都有它们，
既占上下文，也可能干扰不需要该能力的工作区。本次两件事：

**① 配对提示措辞**。Cherry Studio 桌面端的配对界面**只显示二维码**，配对信息（地址/
端口/一次性邀请）要点开扫码后的网页才看得到。现有文案写的是「复制生成的配对信息」，
与实际操作不符，用户要求的说法是：请用微信或浏览器等扫码后，再把显示的配对信息拷贝
到配对框里。

**② 工具启用范围**。可配置为「全局」或「仅在勾选的工作区里启用」，未启用的工作区里
这些工具**不出现在模型的工具表里**。

### 用户原话（决策依据）

- 「工具本身占用上下文，可能会给不需要该工具能力的工作区造成干扰」
- 「这种情况应该手动在配置页的范围里勾选上该工作区，再继续该工作区的会话」（⇒ 无逃生口；改配置后**已在进行**的会话要立即生效）
- 「默认都不给」（⇒ 首次上线/作用域文档不存在时，任何工作区都不可见）

## 2. 决策台账

| # | 决策 | 谁定的 | 内容 |
| --- | --- | --- | --- |
| D1 | 隐藏而非拒绝 | 用户 | 不在范围 = **不进工具表**（省上下文）；不是"可见但调用报错" |
| D2 | 无逃生口 | 用户 | 没有"临时借用/会话内激活"通道；补救路径只有配置页 |
| D3 | 默认都不给 | 用户 | 文档不存在 = `selected` + 空列表 = 全部不可见 |
| D4 | 两种模式 | 用户（§1② 任务描述） | `全局`（所有工作区）或 `仅选定工作区`（多选） |
| D5 | 工作区列表来源 | 本设计 | DSH 已注册工作区（`ctx.workspaceRegistry.list()`），沿用 `dsh-mcp-connector` 的既有先例；注册表**没有同步的按会话成员查询**（`sessionIds` 成员判定需自建），故判定逻辑留在插件侧 |
| D6 | 配置存哪 | 本设计 | 插件数据目录内的作用域文档（带 revision）；**不进** profile YAML，避免双真相源 |
| D7 | 无工作区的会话 | 本设计 | `仅选定` 模式下 fail-closed（不可见） |
| D8 | 宿主能力不足 | 本设计 | 能力状态为**三态**（枚举口径以 §6.2 为准）：`pending`（注入回调尚未到达）/ `unsupported`（静态能力缺失：`register`/`restrict`/`schemas` 任一不可用）/ `ready`。`pending` 与 `unsupported` 都**不注册**这 14 个工具（fail-closed）并明确报告，`reason` 按真实缺因生成；`unsupported` 给升级提示，`pending` 只给中性等待提示（不得说成"宿主不支持"）；绝不退回"全局可见" |
| D9 | 受管范围 | 本设计 | 14 个工具作为**一个整体**受管；设置页与 `/cherry-remote/api` **不受**范围影响（否则被排除的工作区无法自救/配对） |
| D10 | 生效方式 | 本设计（D2 的必然要求） | 配置变更时对**所有 live agent** 重装 restriction；下一轮装配即生效，无需重启或新建会话。显式数据流：§6.3 的 PUT 写入成功 ⇒ **同步**调用 §6.2 `refreshScope()` ⇒ §6.1 所有者状态 ⇒ 逐 agent 重算（B4 据此可测） |
| D11 | 空态呈现 | 本设计 | 设置页空态**按模式区分**（文案不得与判定矛盾）：`仅选定工作区` 模式下"一个都没勾" ⇒ 明确写出"此状态下 `cherry_*` 工具不会出现在任何会话里"；`全局` 模式下未勾选任何工作区（勾选不参与判定，B2）⇒ 写明"当前为全局模式：这些工具在所有工作区都可用" |
| D12 | restriction 安装的健壮性 | 本设计 | `deny` 取**无参全局视图 `ctx.tools.schemas()` ∩ 我们的 14 个静态名字**（**禁止**用 agent 视图 `schemas(agent)` 推导：该视图已被 `layers.every(admits)` 过滤，自引用会把已隐藏的工具重新放回工具表）；**只用 `deny`、不用 `allow`**（不变量：这 14 个工具作为**一个整体**受管——`allow` 会遮蔽该 agent 的**全部继承面**工具而波及无关工具，机制依据见 §4）。**动作由目标集合（含空集）决定**：**空集 ⇒ 只释放、不安装**（幂等），**非空 ⇒ 先装新、后释放旧**；**观测集合为空**（14 个工具尚未注册 ⇒ 无参全局视图里还没有我们的名字）⇒ **不提交空 deny**，但**不得阻止既有层的维护**（既有层的释放照常执行）——**绝不提交空 deny 的真实原因**：宿主只在 `allow` 与 `deny` **两键全缺**时抛错（`restrict({})`）；`restrict({ deny: [] })` **不抛错**，而是装入一个**对任何名字都放行的 no-op 层**，而本插件的 guard 是**已装层的执行侧镜像**（层在 ⇒ 拒绝）⇒ no-op 层会被误读成"该 agent 已被隐藏"，造成**工具可见却被拒**；且空 deny 本身无意义——**注册先于首次安装**（§5 B18）。**每个 agent 任一刻只允许一层**；"部分注册窗口的补齐" = **重装该 agent 的单层完整交集**（先装新后释放旧），**不得**追加第二层（§4 交集语义）。**安装失败路径（规则本身；触发源与可测断言见 B12②）**：抛错（含"两个时刻观测错位"导致交集仍抛错，机制见 §4）与其余安装失败一律走此路径——记录 + 向 `degraded` **追加** `source: 'install'` 标注 + 重试；**不吞掉**、**不**静默、**不**升级成"拒绝注册"（一次瞬时窗口不该让整个 profile 失去工具） |
| D13 | 启用门槛 | 本设计 | 门槛即上面的**能力三态**（枚举口径以 §6.2 为准）：`ready` = `ctx.tools.register`/`restrict`/`schemas` 三个**静态能力**齐备**且** `agents` + `workspaceRegistry` 注入回调**已到达**；`unsupported` = 任一静态能力缺失；`pending` = 注入回调**尚未到达**。`pending`/`unsupported` 都**不注册**这 14 个工具（走 B7/§6.2 的注册门控）且 `reason` **按真实缺因生成**（缺哪个键/哪个 API 就写哪个）。`guard` **有则用**：缺失时降级为"仅可见性"并在诊断/设置页追加 `degraded` 标注（`source: 'visibility-only'`；本功能的目标是上下文，不是安全边界），不影响三态判定与注册；`schemas` 已计入静态能力，不再属于"有则用" |
| D14 | 路径与收敛 | 本设计 | **路径同一性只有一套契约**：会话→工作区判定**一律基于规范化路径**——**重算期（允许 async）**用 `resolveByPath`（realpath 语义）或等价规范化解析注册表各项的路径，据此构建"**规范化路径 → workspaceId** 映射"与**每 agent 判定缓存**（唯一所有者是 §6.1），§4 规则二在该映射上查表（即"**规范化后相等**"，不是裸 `===`）。**老宿主（无 `resolveByPath`）必须如实降级**：退化为**仅大小写敏感的字符串等价**（**不做 realpath**）——代价是符号链接/拼写差异下规则二可能不命中，此时该会话只剩 `sessionIds` 一条路（投影滞后则暂不可见）；该降级在诊断标注，**不得**声称与规范化匹配等价。**判定必须同步可读**：guard、restriction 安装与 `agent/created` 监听器**只读缓存**，**绝不在同步窗口里等待异步解析**；缓存未命中即按 D7 的 fail-closed 处理并触发重算（B13 的"第一轮就有工具"只在 **`cwd` 可解析、规范化后可匹配**时成立，即"缓存同步命中"）；`agent/created` 时**有 cwd 但暂不可解析**（异步解析尚未给出确定结论：注册表未就绪或解析调用失败）的 agent 做**有界**延迟复检（如 +250ms、+2s 各一次）——**无 cwd** 的会话（按 D7 永久不可见）与**已解析但明确不属于任何注册表项**的会话（永久无工作区）**都不启动**复检，避免空转定时器；复检**仅用于补偿 `sessionIds` 投影滞后与注册表就绪延迟**（cwd 是深冻结的创建元数据，缺失即永远缺失 ⇒ 复检不可能在 cwd 一侧翻盘）。`agent/created` 监听器必须**同步返回**（宿主 `@mode serial` 且 await 监听器，抛错会让建会话失败）：复检走定时器，失败只记录、不抛。此后交给 `tools/change` 与配置保存触发；收敛闸门见 §4——**合并 / 置脏后补跑**，且**新 agent 的首次安装**与**注册完成后的补齐**两个触发源**永不弃权** |

## 3. 目标 / 非目标 / 反目标

**目标**

- G1 不在范围内的工作区：14 个工具不进入该会话的工具表（模型看不到，无上下文成本）。
- G2 设置页可改：`全局` / `仅选定工作区` + 工作区多选；保存后即时生效（含进行中的会话）。
- G3 默认谁都不给（D3），且这个默认是**可解释的**：设置页空态写明原因与下一步。
- G4 **判定与执行两侧裁决恒一致**：guard 是**已装层的执行侧镜像**（层在 ⇒ 拒绝、层不在 ⇒ 放行），**不**独立判定、**不**读判定缓存。

**非目标**（**永不**范畴：这些方向不作为目标，也不列入后续路线；"本次不做、可能后续"见 §8）

- **永不**做按工具、按设备、按连接、按会话的细分范围（14 个工具**整体**受管；设备级/连接级治理
  不进路线）。
- **永不**做会话级激活 / TTL（即 `dsh-mcp-connector` 的 session injection 那一套）。
- 不改 profile YAML 的配置面（`perSessionCacheBytes` / `rateBudgetPerSecond` 维持原样）。
- 不改配对协议、设备档案、订阅缓存等既有子系统。

**反目标**

- 假限制：只隐藏 UI 或在渲染层过滤、实际仍可执行 ⇒ 失败。
- 静默降级：宿主不支持所需原语时假装限制了、或悄悄退回全局可见 ⇒ 失败。
- 静默损坏：作用域文档读不出来时被当作"全局" ⇒ 失败（必须落到更严的一侧，见 §6.1 严格度序 / B9）。

## 4. 宿主机制与先例（本机实测，实施时以这些为准）

宿主 `@deepseek-ai/dsh-tools` 0.2.0-rc.2（本机 profile `web` 实装版本）提供：

- `ctx.tools.register(definition): () => void` —— 可全局或在调用 agent 作用域注册；作用域注册遮蔽全局。
- `ctx.tools.restrict(filter: ToolRestriction): () => void` —— 类型注释原文：*Global tool
  names removed from visibility*；`ToolRestriction = { allow?: string[]; deny?: string[] }`；
  **多个 restriction 取交集**，且不影响作用域注册与保留的 PTC 通道；返回精确的解除函数。
  **失败条件**：`restrict({})`（`allow`/`deny` **两键全缺**）抛错；但 `restrict({ deny: [] })` **不抛错**，
  而是装入一个**对任何名字都放行的 no-op 层**——这正是本设计"**绝不提交空 deny**"的真实原因
  （见 D12/B18③，机制后果由 guard 的"层在 ⇒ 拒绝"给出）；未知名字、作用域局部名字与保留传输名都会让
  `restrict()` 直接抛错——所以 `deny` 只能是"**无参全局视图** ∩ 我们的 14 个静态名字"（规则见 D12）。
- **只用 `deny`、不用 `allow`（不变量；规则见 D12，下面是机制依据）**：restriction 过滤的是该 agent 的
  **继承面**——全局层与**祖先层**（preset 下移到 agent 平面的工具也属祖先贡献）；它**不**过滤该 agent
  **自己那层**的注册（宿主原注释：*A restriction filters what a scope inherits … and never what its
  OWN layer registers*）。改用 `allow`（保留名单）会遮蔽该 agent 继承面里除名单外的**全部**工具，
  而本设计只对这 14 个工具整体受管 ⇒ 任何路径都不得生成 `allow` 型 restriction。
- **两个时刻的观测（机制依据）**："名单取自**无参全局视图 `schemas()`**"与"`restrict` 的**接受
  集**"是**两个时刻**的观测，二者之间可能发生注册/注销 ⇒ 交集仍可能含未知名而抛错；这**不是**可以
  假定不发生的事，失败路径的规则与可测断言见 D12/B12。
- `ctx.tools.guard(guard): () => void` —— 派发口的单调守卫；经普通 ctx 注册为全局，经
  `agent.ctx` 注册只对该 agent 生效；返回字符串即拒绝，且没有"强制放行"的反向能力。
- `ctx.tools.schemas(scope?)` —— **省略 scope 才是无参全局视图**；传入 agent 得到的是该 agent
  视图，而它**已被 `layers.every(admits)` 过滤**（含本插件自己的 restriction）。**定名：D12 的
  观测源只能是"无参全局视图 `ctx.tools.schemas()` ∩ 我们的 14 个静态名字"**；**明文禁止**用
  `schemas(agent)` 推导 `deny`——自引用会把我们已隐藏的工具重新放回工具表。agent 视图仅用于
  诊断显示（D12/B12/§7）。
- 事件 `tools/change()` —— 工具注册/注销**或某个作用域的 restriction 变化**时触发；注释明确
  "a global change concerns every agent's next assembly"，即**每次装配重新读取可见性**，
  这就是 D10「即时生效」的机制依据。
- `ToolDefinition.execute(args, exec)` —— 参数在前、`exec: ToolRunContext` 在后（本插件现有
  `execute(args)` 形状与之兼容）；`ToolExecutionInput.agent` 字段存在，其类型注释原文是
  *The agent on whose behalf the call runs (set by the agent loop)*，即**本次调用的调用方
  agent**。（**勿混引**：*the scope routing key* 是 `PtcDispatchLog.agent` 的注释，不属本字段。）

Agent 与工作区：

- Agent 服务经 `ctx.inject(['agents'], (agentCtx) => agentCtx.effect(() => {...}))` 获取；
  `agentCtx.agents.list()` 列出 live agent，事件 `agent/created` / `agent/disposed`。
- 每个 agent 有 `agent.ctx.tools.restrict(...)`，即 restriction 按 **agent** 维度安装。
- 工作区注册表：`ctx.workspaceRegistry.list()` → `{ id, title, path, sessionIds }`。本机现有
  11 项（**顺序无关**：此处的列举顺序与实测 title 顺序不同，也不作为任何排序或判定依据）：
  hermes、oa、dsh、ppt-master、specpowers、mcphub、1panel、llm、personal、cloud、workspace。
  方法面除 `list()` / `get(id)` / `create(path, title?)` 外**还另有**：`resolveByPath(path):
  Promise<Workspace | undefined>`（realpath 语义：未拥有的目录返回 `undefined`，路径缺失则
  reject）、`delete` / `insertBefore` / `initializeDefault` / `archiveSession|unarchiveSession|
  pinSession|unpinSession` / `pinnedSessionIds` 等。但它**没有同步的按会话成员查询**——
  `sessionIds` 只是实体上的投影，成员判定仍须自建（D5/D14）。
- 会话归属判定（沿用先例顺序，**路径同一性的单一契约**）：`workspace.sessionIds.includes(agent.id)`
  命中优先；否则 **`agent.session.header.cwd` 与 `workspace.path` "规范化后相等"**（在 §6.1 的
  "规范化路径 → workspaceId"映射上查表，**不是**裸 `===`）；两者都不中 ⇒ 无工作区（走 D7）。
  **时序依据**：`Session.header` 的类型注释写明它是 *detached, deep-frozen
  creation metadata*（format version、cwd、lineage…）；**store-owned header 会携带 `cwd`**，此时
  第二条规则在 `agent/created` 时刻就能命中。但 header 是深冻结的创建元数据，且无 store-owned
  header 时合成的 minimal header 只钉 format version——**可能不含 `cwd`**，此时第二条规则不中，
  按 D7 永久不可见（D14 的复检不改变这一点）。`sessionIds` 是 header-validated 的成员投影，可能
  滞后，故只作"优先"而不作依赖。注册表**没有**成员变化事件（只有 archive/activity 面），因此收敛靠
  `tools/change`、配置保存与 D14 的有界复检。
- **路径同一性（唯一契约，D14）**：所有"会话 → 工作区"判定都消费**同一张规范化映射**——重算期
  （允许 async）用 `resolveByPath`（realpath 语义）或等价规范化构建，规则二在它上面做"规范化后
  相等"的查表，**不得**另立一套裸字符串比较；`sessionIds` 是成员投影、规则二是路径投影，两者落到
  **同一个** workspaceId 判定（G4）。老宿主无 `resolveByPath` 时按 D14 **如实退化**为大小写敏感的
  字符串等价（不做 realpath，代价与诊断见 D14/§6.1），**不得**把这套退化说成与规范化匹配等价。
  **路径不匹配必须可诊断**：有 `cwd` 但规范化后不匹配任何注册表项 ⇒ 判定照旧落 D7（无工作区，
  不计入 `degraded`），但诊断面留一条**路径不匹配**记录（§6.1），使"勾了却无工具"能看出原因是
  路径对不上。

现成先例 `dsh-mcp-connector@0.2.72`（本机已装，可直接对照源码）：

- `lib/session-injection.js`：`installRestriction(agent, denied)` **先装新层再释放旧层**（避免
  `tools/change` 竞态期间出现"无限制"窗口）；per-agent 保存 disposer；`refresh()` 在
  `agent/created` / `agent/disposed` / `tools/change` 上重算（另有 `syncing` 闸与同名短路）。
- 先例 `capabilities()` 的**准确**语义（实测）：它**只上报标志**——
  `visibilityRestriction: agentsMounted && typeof ctx.tools?.restrict === 'function'`、
  `executionGuard: Boolean(disposeGuard)`；`guard` 缺失时 `disposeGuard = null` 是**静默降级**，
  `capabilities()` 本身不拒绝任何东西。"拒绝启用"发生在它的**治理 / 项目作用域路径**
  （`lib/index.js` 243 / 1477 / 2752 三处抛错：缺 `executionGuard` 就不允许保存 project 作用域 /
  deny 策略 / session 注入）。**本设计据此选更严的策略**：`guard` 缺失时不是"上报后照常启用"，
  而是降级为"仅可见性"并在诊断/设置页**显式标注**（B17）；`restrict`/`schemas` 缺失或 `agents`
  未挂载 ⇒ 连这 14 个工具都不注册（B7/D8）——理由是"注册了却隐藏不了"是最坏状态。
- `lib/session-injection.js:188-189`、`lib/connection-scopes.js:274-275`、`lib/governance.js:296-297`：
  三处 `ctx.tools.guard(...)` 即执行兜底先例（`lib/tools.js` **零** guard，不要再指到那里——
  它 275–310 行是工具定义）；`lib/index.js` 的 `workspaceIdForAgent` / `workspaceList` 即上面两条
  判定与列表来源。
- 先例的 guard 注册在**普通 ctx**（全局生效，不是 `agent.ctx`），判定只读**本次执行所属 agent**
  的状态（`execution.agent`）——本设计照此办理（B6）。**不变量：guard 是已装层的执行侧镜像，不得
  独立判定**——**该 agent 当前存在本插件的 restriction 层 ⇒ 拒绝**（理由取该层携带的判定记录，
  可读）；**不存在层 ⇒ 放行**。于是"判定缓存缺失/陈旧"不是第三种输入：fail-open 只可能出现在
  "层本就不该存在"（本就不该被隐藏）的状态，与 D1/G4 的可见性一致；guard **不得**读裸判定缓存
  自行重算，也不得在缓存缺失时另立判据（B6/§6.2）。
- `lib/connection-scopes.js`：作用域文档形如 `{ connectionKey, global, projects[] }`，带
  `revision` 与最近 20 条 history，由插件自己的 UI 编辑——**D6 的先例**。

> ⚠️ 交集语义：restriction 是**取交集**的，叠加两层 deny 无法靠释放其中一层恢复。因此
> 任何时刻每个 agent 只允许存在**一层**本插件的 restriction，且必须"先装新、后释放旧"。
>
> ⚠️ **同步判定与缓存（硬约束，D14）**：`resolveByPath` 是 async，而 `agent/created` 监听器必须
> **同步返回**、restriction 的安装也只发生在同步窗口。所以判定拆两段：**重算期（允许 async）**用
> `resolveByPath`/realpath 解析并构建"**规范化路径 → workspaceId** 映射"与**每 agent 判定缓存**
> （两者唯一所有者是 §6.1）；**guard 与 restriction 安装只读缓存**，**不得**在同步窗口里等待异步
> 结果——缓存未命中即按 D7 的 fail-closed 处理并触发重算（`agent/created` 情形走 D14 的有界复检）。
>
> ⚠️ **重入与收敛（硬约束）**：本插件自己的 `restrict()` **会**发 `tools/change`——宿主
> `guard()` 的 effect 带 `notify:false`，而 `restrict()` **不带**——而 §6.2 的 `mount` 又订阅了
> 该事件 ⇒ 不设闸就会自我递归/放大。所以"重算必须可重入且收敛"是规格而非实现细节：
> ① **重入闸 = 合并 / 置脏后补跑（coalescing）**——重算进行中再次触发的**不丢弃**：把本轮标记为
> "脏"，本轮结束前**补跑一次**（异步区间内到达的 `tools/change` 与新 `agent/created` 因此不会漏）；
> ② **幂等短路**（目标 deny 集合与该 agent 当前已装层逐名相同时不重装）；③ **有界放大**（一次重算里
> 每个 agent 至多重装一次）。合并语义下有两个触发源**在子系统存活期间永不弃权**：**新 agent 的
> 首次安装**与**注册完成后的补齐**（可分别落在重算体内或紧随其后的补跑轮）。**唯一弃权点是
> teardown**：`torn-down` 置位后这两个触发源与其它重算请求一样**短路返回**（§6.2 的合并 disposer）
> ——释放动作本身也会发 `tools/change`，"弃权"在那里才是正确的。先例的两道同类防护
> （`syncing` 闸 + 同名短路）可作对照。

## 5. 行为规格（可测条目）

- **B1** 作用域文档不存在（首次升级即此状态）：每个 live agent 都装上对 14 个名字**按 D12 取交集**
  后的 deny 层（**注册先于首次安装** ⇒ 此处观测集合非空，见 B18③）；模型工具表中没有 `cherry_*`（D3）。
- **B2** `mode = "global"`：不装 restriction；14 个工具对**全部 live agent（及后续新建的 agent）**
  可见（等价于今天的行为）。
- **B3** `mode = "selected"` + `workspaceIds = [W]`：属于 W 的 agent 可见；其他 agent 不可见。
- **B4** 保存配置后，**所有 live agent** 重算：正在进行的会话下一轮即可用/即消失；不需要重启
  DSH、不需要新建会话（D2 的用法要求）。可测依据是 §6.1→§6.2→§6.3 的显式调用链：PUT 写入成功后
  **同步**调用 `refreshScope()`；**在规范化路径映射与判定缓存已就绪时**（重算期允许 async 重建，
  收敛由 coalescing 保证），一次断言即可观察到全部 live agent 的层被重装。
- **B5** `mode = "selected"` 且会话无工作区（cwd 不在注册表）：不可见（D7）。
- **B6** 执行兜底：guard **与可见性层同源**——它读的**不是**判定函数的重算结果，而是 §6.1 的
  **已装层记录**（该 agent 当前是否存在本插件的 restriction 层，及该层携带的判定理由）：**层在 ⇒
  拒绝**（理由可读，含工作区标题或 id）；**层不在 ⇒ 放行**。因此"判定缓存缺失/陈旧"不构成第三种
  输入：guard 的裁决**恒与可见性层的实际状态一致**（fail-open 只可能出现在"层本就不该存在"的状态），
  不得独立判定、不得在缓存缺失时另立判据（D1/G4）。
- **B7** 宿主能力**三态**（D8/D13，枚举口径以 §6.2 为准）：`pending`（`agents`/`workspaceRegistry`
  注入回调**尚未到达**）/ `unsupported`（**静态能力缺失**：`ctx.tools.register` / `restrict` /
  `schemas` 任一不可用）/ `ready`。`pending` 与 `unsupported` 下这 14 个工具都**不注册**
  （fail-closed），只有 `ready` 才注册，且**绝无**"已注册未隐藏"窗口、绝不退回全局可见；
  `capable` 仅是 `state === 'ready'` 的布尔投影。可测断言：① `unsupported` ⇒ 不注册，诊断与设置页
  给出原因与**升级提示**并禁用保存；② `pending` ⇒ 不注册，诊断与设置页只给**中性等待提示**
  （**不得**出现"宿主不支持"类结论、**不禁用**无关操作，D9 的自救面照常可用）；③ `reason`
  **按真实缺因生成**——缺哪个键（`agents` / `workspaceRegistry`）或哪个 API（`register`/`restrict`/
  `schemas`）就写哪个，**不得硬编码**"agents 服务不可用"；④ `ready` ⇒ 注册且在注册完成后完成首次
  安装（与 B18③ 的次序一致）。
- **B8** 设置页与 `/cherry-remote/api` 在所有工作区都可用（D9）；配对向导照常工作。
- **B9** 作用域文档损坏/非法：按 §6.1 的**可见性严格度序**落到更严的一侧 ⇒ `selected` + 空列表，
  并在设置页提示；绝不静默变成全局。
- **B10** 反复 `apply`（HMR/重载）不产生叠加 restriction；插件销毁时释放全部 restriction 与
  guard、退订全部事件（**次序见 §6.2 的合并 disposer：先退订 ⇒ 再释放注册 ⇒ 再释放 restriction ⇒
  最后释放 guard**——理由是该释放侧也发 `tools/change`，见 §6.2）。**覆盖面扩到"依赖卸载-重挂循环"**
  （§6.2 的唯一装配点）：`agents` / `workspaceRegistry` 注入依赖卸载 ⇒ 工具的**注册**与该 effect 内
  安装的**全部 restriction**、**guard**（随同一个合并 disposer 一并释放）与**订阅**一并释放
  （不存在"已注册未隐藏"窗口，也不存在"释放后被重算装回"的**无主层**——释放侧同样通知，§6.2）；
  依赖重挂 ⇒ effect 重跑并做**全新注册**（不抛"already registered"、**重挂后不出现叠加层**——每个
  agent 仍只有**一层**本插件的 restriction）。
- **B11** 14 个工具的名字表是**单一常量**，可见性、guard、诊断、合约测试共用它（避免名单漂移）。
- **B12** restriction 的安装按 D12 的交集与失败路径执行。可测断言：① 只提交"**无参全局视图
  `schemas()` ∩ 14 个静态名字**"的交集名字；② 安装失败不抛到调用方、不静默 ⇒ 记录 + 向 §6.1 的
  `degraded` 标注集合**追加**一条（`source: 'install'`）+ 下一个 `tools/change`/配置保存重试；
  ③ **部分注册窗口**（HMR 中途只有部分工具在场）必须能装成功并随后补齐；
  ④ **交集仍抛错**（D12 的"两个时刻"错位）同样走失败路径，不得吞掉。
- **B13** 新会话在允许的工作区里**第一轮就有**工具（**限定：`cwd` 可解析、规范化后可匹配时**）：
  store-owned header 的 `cwd` 经 §6.1 的**规范化路径映射**在 `agent/created` 同步命中即当轮装层
  ——规则二是"**规范化后相等**"而非裸字符串比较（D14 的单一契约；老宿主无 `resolveByPath` 时退化为
  大小写敏感的字符串等价，拼写/符号链接差异下可能不命中，此时只剩 `sessionIds` 一条路）。**有 cwd
  但规范化后不匹配任何注册表项** ⇒ 按 D7 永久不可见，并**留下路径不匹配诊断**（§6.1：让"勾了却
  无工具"能看出是路径对不上）；**有 cwd 但暂不可解析**（注册表未就绪 / 解析调用失败）的 agent 走
  D14 的有界复检——**无 cwd** 的会话与**已解析但明确无工作区**的会话**都不复检**；复检**只补偿
  `sessionIds` 投影滞后与注册表就绪延迟**（cwd 缺失的会话不因此翻盘，按 D7 永久不可见）；复检只
  可能把"暂时不可见"修正为"可见"，判定函数不变。`agent/created` 监听器**同步返回**（不 await
  复检），复检在定时器上执行、失败只记录不抛——**任何情况下都不得阻塞或让建会话失败**。
- **B14** 悬空 `workspaceId` 对账（唯一裁决：注册表外即已失效，以修剪为准）：注册表**没有成员变化
  事件**（只有 archive/activity 面）
  ⇒ 只能**在读写时对账**，不依赖事件。**唯一裁决**：注册表**之外**的 id **就是已失效的 id**——`PUT`
  以**修剪**方式移除它（**不是**校验失败；校验面只留非法 `mode` / 字段类型，§6.3/§7），响应回报被
  修剪的 id 列表（如 `pruned: [...]`）；因此"已失效选择"的清除只有一条路径：`PUT` 修剪 + 据 `pruned`
  回显（§6.4）。① `GET` 额外返回 `staleWorkspaceIds`（仍存于文档、但注册表已无此 id 的子集），供
  设置页把"已失效选择"显式呈现给用户（可一键清除）；② 对账只修剪 id，不改 `mode`，`revision` 仍按
  写入单调递增；③ **修剪护栏（与 B16 的降级态交叉）**：只有**非 degraded 的权威列表读**才允许修剪
  ——列表不可用时 `PUT` **被拒绝**、不得修剪也不得写入（§6.3），`staleWorkspaceIds`
  返回**空数组**并带 `degraded`（`source: 'workspace-list'`）标注。可测：删除一个已勾选的工作区后，`GET.staleWorkspaceIds` 含该 id
  且 `workspaces[]` 不含它；任意一次**非 degraded** 的合法 `PUT` 后该 id 从文档消失、`pruned` 列出它、
  `staleWorkspaceIds` 变空；而在列表不可用的夹具下同一次 `PUT` ⇒ **被拒绝且已存勾选一位不动**。
- **B15** 与上游 `allow` 型过滤共存（**接受的行为**）：诊断与设置页的措辞**只声称"本插件未
  遮蔽"**，**不得**声称"模型一定看得到/一定调用得到"——上游/委派链可能装 `allow` 型 restriction
  把 `cherry_*` 整体遮蔽（如 `dsh-subagent` 的 `composition.toolFilter` →
  `childCtx.tools.restrict(...)`，`lib/index.js:522`），此时工具确实不在该会话工具表里，而遮蔽方
  **不是本插件**。`guard` 只对"**本插件范围内/外**"的判定负责，**不得**把这种上游遮蔽当成故障：
  不报 degraded、不写错误日志、不据此拒绝调用（B6）。可测：夹具叠加一层上游 `allow` 把
  `cherry_*` 排除后，诊断/设置页文案仍是"本插件未遮蔽"、不出现"可见/模型可调用"字样，且调用不被
  `guard` 拒绝。
- **B16** 工作区列表读取失败的 fail 方向（不变量：读不到 ≠ 全都失效）：判定侧——`list()` **抛错或
  返回空**时按"**空表**"处理，`selected` 模式下结果与"谁都不选"完全相同（全员不可见，fail-closed，
  D7），并向 `degraded` 标注集合**追加**一条（`source: 'workspace-list'`，原因：工作区列表不可用）；
  `global` 模式的判定**不依赖列表**，因此不受影响。UI 侧——列表不可用时**禁用保存**并显示原因；
  `global` 模式下同样要在 UI 说明"注册表列表读不到"（虽然判定不受影响）。可测：夹具令 `list()`
  抛错 ⇒ `selected` 文档下全部 live agent 仍装 deny 层、诊断出现该 degraded 标注、保存被禁用；
  `global` 文档下不装 restriction 且 UI 显示列表不可用。
  **写侧护栏（与 B14 交叉）**：该降级态下 `staleWorkspaceIds` 返回**空数组**并带同一 source 的
  degraded 标注（"读不到"**不等于**"全都失效"），`PUT` **被拒绝**（`workspace-list-unavailable`）
  ——已存 `workspaceIds`/`mode` 一位不动、`pruned` 语义不发生。可测：降级夹具下 `PUT` ⇒ 被拒绝且勾选不变。
- **B17** `guard` 缺失的降级模式（不变量：缺失不拒注册、不静默）：`restrict` 可用而 `guard` 不可用
  时，插件降级为"**仅可见性**"——不可见性**照常**由 `restrict` 在装配层生效（`cherry_*` 根本不进
  工具表），只是没有派发口的执行兜底；诊断与设置页**必须**显示该降级标注（向 `degraded` 标注集合
  **追加**一条，`source: 'visibility-only'`，原因"宿主缺 tools.guard"），不得静默。与 §3 反目标
  "假限制"的调和：该降级仍是**宿主 restriction
  的真隐藏**（装配层移除），**不是**渲染层假过滤，故不落入该反目标。可测：夹具去掉 `guard` ⇒
  越界 agent 的 `restrict` 层照常安装、诊断与设置页出现降级标注、且不因此拒绝注册（B7 的门槛
  只看 `register`/`restrict`/`schemas` 与 `agents`+`workspaceRegistry` 注入回调的到达态，D13）。
- **B18** 安装/释放的动作判据（D12）：① **目标集合（含空集）决定动作**——目标 deny 集合为**空集**
  （该 agent 判定为不在范围内，或按 D7 无工作区）⇒ **只释放旧层、不安装**（幂等：重复触发不叠加），
  因此"取消勾选"后该 agent 的层被释放、工具**回到**该 agent 的工具表（B2/B4 的反方向可测）；
  ② 目标集合**非空** ⇒ **先装新、后释放旧**；③ **观测集合为空**（14 个工具尚未注册 ⇒ 无参全局视图
  `schemas()` 里还没有我们的名字）⇒ **不提交空 deny**（**真实原因**：宿主只在 `allow`/`deny`
  **两键全缺**时抛错——即 `restrict({})`；而 `restrict({ deny: [] })` **不抛错**，会装入一个
  **对任何名字都放行的 no-op 层**，本插件的 guard 是**已装层的执行侧镜像**（层在 ⇒ 拒绝）⇒ 该层会被
  误读成"该 agent 已被隐藏"，造成**工具可见却被拒**；空 deny 本身也无意义），但**不得阻止既有层的
  维护**（既有层该释放照常释放）；**注册先于首次安装**（§6.2 的唯一装配点保证次序）；④ **"部分
  注册窗口的补齐" = 重装单层完整交集**（先装新后释放旧），**不得**追加第二层——每个 agent 任一刻
  只允许一层（§4 交集语义）。可测：① 同一 agent 先被隐藏、目标集合变空后工具重新可见且**无层残留**；
  ② 首次安装前令无参 `schemas()` 取不到这 14 个名字 ⇒ 不装层、不抛错，注册完成后由补齐恰好装
  **一层**完整交集。

## 6. 组件设计

### 6.1 作用域文档与存储（新文件，建议 `src/toolScope.ts`）

```jsonc
// $DSH_HOME/cherry-remote/scope.json   (0600)
{
  "version": 1,
  "revision": 3,
  "updatedAt": "2026-10-15T06:20:00.000Z",
  "mode": "selected",              // "global" | "selected"
  "workspaceIds": ["1a5d14fe-…"]   // mode=selected 时生效；去重、排序
}
```

- 读取：文件不存在 ⇒ `{mode:'selected', workspaceIds:[]}`（D3）；解析失败/字段非法 ⇒ 同样落到
  这一侧并记录 warn（B9）。
- **`version` 更高 / 未知的文档（本插件支持 1，文档是 `version: 2` 等）⇒ 拒绝写入 + 只读降级 +
  显式告警，且与其他"读不出来"的路径明确区分**：① `PUT` **一律被拒绝**（不修剪、不落盘、已存内容
  一位不动）——本插件无权覆写更新格式的文档；**该拒绝有稳定错误码：`scope-version-unsupported`
  （`503`，语义类别与理由见 §6.3）**；② 向 `degraded` 集合**追加**一条专属标注
  （`source: 'scope-version'`，reason 写明"文档版本高于本插件支持"），设置页与诊断**显式告警**
  （只读降级：照 §6.4 的降级呈现，禁用保存）；③ **不得**静默按"空列表"处理——**不得**把它记成或
  呈现成"用户什么都还没勾"（那会让用户以为是自己没勾），空态文案必须与"用户空选"可区分。判定口径
  仍按下面的**可见性严格度序**落到**更严的一侧**（fail-closed），但降级来源是这条显式标注而不是
  "空选"；解析失败 / 字段非法走 B9 的路径（warn + 严格度序，写入仍可覆盖），与本条**不同**。
- **可见性严格度序（B9 与 §3 反目标引用的判据）**：`selected` + 空列表 **>** `selected` + 非空
  **>** `global`；任何"读不出来 / 判不出来"的路径都落到该序中**更严的一侧**。
- 写入：沿用仓库既有原子写法（同目录 `.tmp` + fsync + rename，0600），`revision` 单调递增。
- 纯函数化（**单一真相**）：`normalizeScope(input)`、`isVisible(mode, workspaceIds, workspaceId |
  undefined)` 与**会话→工作区判定**（§4 的两条规则：`sessionIds` 成员投影命中优先，否则在"规范化
  路径 → workspaceId"映射上做"规范化后相等"查表，结果写入每 agent 判定缓存）——这三者由**规范化
  路径映射 + 判定缓存**支撑，且是**可见性层、诊断、UI 与测试共用的同一实现**（G4）；任何
  一侧都不得另立一份判定或缓存的副本。**`guard` 不在这个共用名单里**：它是**已装层的执行侧镜像**
  ——按下面的"guard 的读源"只读**每 agent 的已装层记录**（层在 ⇒ 拒绝、层不在 ⇒ 放行），**不**读
  判定缓存、**不**独立重算（**该不变量定义在 G4 与 B6**；本节只说明 **guard 的读源**——**guard 的
  读源说明见下**，§4、B6 与 §6.2 陈述的是**同一读源**，本节不另立判据）。
- `isVisible` 的**输入契约（不变量：id 两侧归一后才比较）**：工作区 id 比较前**两侧都做 `String()` +
  trim 归一**（作用域文档里的 id 来自 UI 的 JSON 字符串；注册表返回的 id 类型不可假设为 string——
  先例一律 `String(...)`）；归一后仍不等即视为不匹配，不做大小写或路径级猜测。
- 悬空 id 对账（**机制**；唯一裁决与可测断言见 B14）：注册表**没有成员变化事件** ⇒ 只能**在读写时
  对账**——读取时算出 `staleWorkspaceIds` 下发给 UI，写入时**修剪**注册表已无的 id 并在响应回报
  `pruned`；两者都不改 `mode`，`revision` 仍按写入单调递增。**修剪护栏**：只有**非 degraded 的权威
  列表读**才允许修剪——列表读不到时 `staleWorkspaceIds` 返回**空数组**并带 `degraded`
  （`source: 'workspace-list'`）标注，`PUT` **一律被拒绝**（§6.3）。
- 状态所有权与分层（消歧）：本模块是作用域**状态与判定缓存（含重算的算法）的唯一所有者**——
  作用域文档、`degraded` 标注集合、规范化路径映射与每 agent 判定缓存都由它持有，对外暴露读取
  （当前文档 / `degraded` / 能力与挂载态）与重算的**算法**；**§6.2 只提供按宿主事件 / 保存事件
  触发重算的编排入口（`refreshScope()`）与返回值**，不持有状态，**不得**把判定缓存挪到宿主集成层；
  HTTP 面与设置页只经本模块读写，不得各自持有副本。**`degraded` 是集合**：每项形如
  `{ source, reason }`，`source` 取 `install`（安装失败）/ `workspace-list`（列表不可用）/
  `visibility-only`（`guard` 缺失的仅可见性降级）/ `scope-version`（文档版本高于本插件支持，见上）
  等来源；**合并规则：同源去重（保留最新 reason）、异源并存**——任何一侧都**不得**用一条新标注覆盖
  其他来源的标注，**空集合 = 无降级**。
  **权威态在内存**：文档（含 `revision`）以**内存**为
  准，文件写盘**仅作持久化**（启动时读入一次）——因此 `PUT` 的"校验 → 写入 → 同步
  `refreshScope()`"全程不需要异步读盘（§6.3 的临界区前提；B4 的"一次断言即可观察到"以此为据）。
- **规范化路径映射与判定缓存（同步读契约，D14；路径同一性唯一契约）**：重算的**算法**归本模块——
  在**重算期（允许 async）**用 `resolveByPath`（realpath 语义）或等价规范化解析**注册表每一项的
  路径**，构建"**规范化路径 → workspaceId** 映射"与**每 agent 判定缓存**；**会话→工作区判定**
  （§4 的规则二）**只查这一张映射**（"规范化后相等"），**不得**另立裸字符串比较；老宿主无
  `resolveByPath` 时按 D14 **如实退化**为大小写敏感的字符串等价。构建完成后**原子替换**（读者只会
  看到完整的一代映射，不会看到半建状态）。**同步读契约**：guard 与 restriction 安装（含 §6.2 的
  `agent/created` 同步监听器）**只读缓存**，不得在同步窗口里等待异步解析；缓存未命中即按 D7 的
  fail-closed 处理并触发重算（`agent/created` 情形另有 D14 的有界复检）。**解析状态（D14"暂不可
  解析"的唯一判据；与判定缓存同源同寿命）**：映射构建（**重算期**）对每个 agent 另记一个**解析状态**，
  至少四值——`resolved`（命中某 `workspaceId`）/ `unresolved`（**有 `cwd` 但本次解析失败**：如
  `resolveByPath` 抛错、目录暂不可达、注册表尚未就绪）/ `no-cwd`（header 无 `cwd`）/ `no-match`
  （有 `cwd`、解析成功但不属于任何已注册工作区）；**有界复检只对 `unresolved` 启动**（`no-cwd` 与
  `no-match` **不启动**：二者不会因时间推移而翻盘）；该状态与判定缓存由**同一所有者**持有、**同寿命**
  ——随同一代映射**原子替换**（老宿主无 `resolveByPath` 的降级路径同样产出这四值，只是 `resolved`
  的命中口径退化为大小写敏感的字符串等价）；**guard 仍只读已装层记录、不读该状态**（读源不变量见
  下面的"guard 的读源"与 G4）。
- **路径不匹配的诊断（D14，二选一已定：诊断而不静默）**：一个 agent **有 `cwd` 但规范化后不匹配
  映射里任何一项**时，判定照旧落到 D7"无工作区"（该语义不变、**不计入 `degraded`**），但**必须留下
  记录**：诊断面（`src/diagnostics.ts`）与设置页暴露一个**非 degraded** 的诊断字段（如
  `pathUnmatched`，含 agent id 与 `cwd` 样本），使"勾了却无工具"能被看出**原因是路径对不上**
  （拼写 / 符号链接 / 该目录确实未注册——三者在此不可区分，文案只陈述事实）。
- **guard 的读源（与可见性层同源）**：本模块同时持有**每 agent 的已装层记录**（当前 deny 集合 +
  该层携带的判定理由），guard 只读它——**层在 ⇒ 拒绝、层不在 ⇒ 放行**，不读裸判定缓存、不自行
  重算（§4 的不变量 / B6）。

### 6.2 宿主集成（新文件，建议 `src/toolScopeHost.ts`）

- 能力探测（**三态**，D8/D13）：宿主能力状态只取三值——`pending`（**注入回调尚未到达**：
  `agents` / `workspaceRegistry` 依赖未就绪）、`unsupported`（**静态能力缺失**：
  `ctx.tools.register` / `restrict` / `schemas` 任一不可用）、`ready`（上述静态能力齐备**且**两个
  注入回调已到达）。**`guard` 不在门槛内**——它缺失只降级为"仅可见性"（B17）。三态与 `reason`
  作为可读状态暴露给诊断与设置页（`capable` 仅是 `state === 'ready'` 的布尔投影）；`reason`
  **必须按真实缺因生成**——缺哪个键（`agents` / `workspaceRegistry`）或哪个 API
  （`register`/`restrict`/`schemas`）就写哪个，**不得**硬编码"agents 服务不可用"，**不得**把
  `pending` 说成宿主不支持（B7）。
- 注入键声明：本子系统新增两个硬依赖键 `agents` 与 `workspaceRegistry`
  （`ctx.inject(['agents', 'workspaceRegistry'], …)`）。与既有 `tools` 注入的关系：`tools` 仍是
  插件级已声明的**工具注册面**（**restriction 面属 `agent.ctx`**，见下面的"restriction 的安装
  位置"）；这两个键**只门控本子系统的装配与这 14 个工具的注册**，
  它们未到达时插件的 HTTP 面与设置页照常工作（D9：被排除的工作区必须能自救），UI 只给中性等待提示。
- **装配、注册与隐藏同生共死（唯一装配点）**：全部装配都在注入回调的**同一个 effect** 内完成——
  `ctx.inject(['agents', 'workspaceRegistry'], (agentCtx) => agentCtx.effect(() => { … }, 'cherry-remote.tool-scope()'))`，
  次序固定：
  1. **先注册**（**前置条件：能力三态为 `ready`**）：**仅当能力三态为 `ready` 才注册**——`pending`
     （注入回调尚未到达）与 `unsupported`（静态能力缺失）**都不注册**（三态与 `reason` 口径见上面的
     能力探测与 B7/D8；**D13 所指"§6.2 的注册门控"即此条**）。满足时调用 `registerCherryTools(...)`，
     把这 14 个工具 `register` 到**插件的根 ctx（全局层）**（不变量见下），并**把 `register()` 返回的
     每一个 disposer 都收进这个 effect**；
  2. **再隐藏**：同一 effect 内对**全部 live agent** 安装 restriction（restriction 只能装在每个
     agent **自己的 ctx** 上，见下），并在**普通 ctx** 上注册**一层**全局 guard（幂等；见下）
     ——**把 `restrict()` / `guard()` 返回的每一个 disposer 与 `agent/created` / `agent/disposed` /
     `tools/change` 的订阅都收进这个 effect**；
  3. **返回一个合并的 disposer**（**次序即正确性**）：① **先退订全部事件**（`agent/created` /
     `agent/disposed` / `tools/change`）——或等价的"**先置 `torn-down` 标志**，使任何重算请求短路
     返回，**不再新增**对 disposer `Map` 的读写、不再装层"（**释放本身**按本步骤已捕获的**快照**
     迭代该 `Map`，见下面的④与生命周期后果）；② 再释放全部**注册**；③ 再释放全部 **restriction**；
     ④ 最后**释放 guard**（即上面那次 `ctx.tools.guard(...)` 的返回函数）。
     **理由：释放侧同样会通知**——`dsh-scope` 的 `ScopedLayers.effect` 其 **undo 路径同样调用
     `onChange()`**（源码：`yield () => { undo(); …; if (notify) this.onChange(); }`），而
     `register()` 与 `restrict()` 的 effect **都没有** `notify:false`（**只有 `guard()` 有**）⇒
     **释放注册 / 释放 restriction 本身就会发 `tools/change`**。若把释放放在**退订之前**（即"释放
     在仍订阅的窗口里"），释放动作就会触发一次重算；该重算按**尚未改变的 §6.1 所有者状态**（判定仍
     说"该 agent 应在范围内"）**把刚释放的层重新装回**，而 disposer `Map` 已被清空 ⇒ 产生**无主层**，
     按 §4 的交集语义**永不可恢复**（并直接违反 B10 的"释放全部 restriction"）。先退订（或先置
     `torn-down` 标志使重算短路）即封死这个窗口——guard 最后释放是因为它**不通知**（无 `tools/change`），
     放在末尾不产生任何重算，而它恰是释放期间的最后一道执行兜底。
     **同一次 teardown 一并作废 §6.1 的派生状态**：判定缓存、规范化路径映射、解析状态（四值）、
     `pathUnmatched` 诊断与已装层记录随这次释放**一并清空**（派生状态的清空点只有两处：§6.1 的
     "原子替换"与这里）——于是"依赖回归 ⇒ effect 重跑"从**全新一代**开始，**绝不**复用上一代的
     判定或映射（旧一代里的 `workspaceId` 可能已被删除，复用它正是 B14 要修剪的那类失效选择）。
  三条生命周期后果（必须成立）：**依赖从未到达** ⇒ 该 effect **从未运行** ⇒ **什么都没注册**
  （fail-closed，合 D3/B7）；**依赖卸载**（门控 fiber 被 `_unload`）⇒ effect 的 disposer 一并释放
  **注册、隐藏与 guard** ⇒ **不存在"已注册未隐藏"窗口**（这是结构排除，**不**依赖"回调从未到达"这一单向
  假设）；**依赖回归**（fiber 重挂）⇒ effect **重跑**并做**全新注册**（旧的已随 disposer 释放，
  不会撞"already registered"）。回调必须**幂等**：同一次运行内不得重复注册（重跑前旧注册必已释放）。
- `mount`：订阅 `agent/created` / `agent/disposed` / `tools/change`；维护
  `Map<agent, disposer>`；每次重算遵循"先装新、后释放旧"；`agent/disposed` 时释放该 agent 的层。
  **判定同步（硬约束，见 §4/D14）**：`agent/created` 监听器**同步返回**，只读 §6.1 的规范化路径
  映射与判定缓存（**绝不**在同步窗口里 await `resolveByPath`；未命中即按 D7 fail-closed 处理并触发
  重算，有界复检照 D14）。**重入与收敛（硬约束，见 §4）**：① **重入闸 = 合并 / 置脏后补跑
  （coalescing）**——重算进行中再次触发的**不丢弃**：标记脏、本轮结束前补跑一次（异步区间内到达的
  `tools/change` 与新 `agent/created` 因此不会漏），且**新 agent 的首次安装**与**注册完成后的补齐**
  两个触发源**在子系统存活期间永不弃权**（**唯一弃权点**：`torn-down` 置位后的 teardown 窗口，见上面的合并 disposer——那时短路返回才是正确的）；② **幂等短路**——目标 deny 集合与该 agent 当前已装层逐名相同时不重装；
  ③ **有界放大**——一次重算里每个 agent 至多重装一次。理由是 `restrict()` 自身会发 `tools/change`
  而这里又订阅了它：无闸即递归/放大。
- **安装/释放的判据（B18）**：**目标集合（含空集）决定动作**——目标 deny 集合为**空集**（该 agent
  不该被隐藏）⇒ **只释放旧层、不安装**（幂等；对齐先例 `session-injection.js:146-152` 的"空集释放
  旧层"）；**非空** ⇒ **先装新、后释放旧**。**观测集合为空**（14 个工具尚未注册 ⇒ 无参全局视图里
  取不到我们的名字）⇒ **不提交空 deny**（**真实原因**：宿主只在 `allow`/`deny` **两键全缺**时抛错
  ——`restrict({})`；而 `restrict({ deny: [] })` **不抛错**，会装入一个**对任何名字都放行的 no-op
  层**，本插件的 guard 是**已装层的执行侧镜像**（层在 ⇒ 拒绝）⇒ 该层会被误读成"该 agent 已被隐藏"，
  造成**工具可见却被拒**；空 deny 本身也无意义），但**不得阻止既有层的维护**（既有层
  的释放照常执行）。因此**注册先于首次安装**：首次安装只可能发生在注册完成之后（上面的装配点保证
  次序）；"部分注册窗口的补齐" = **重装该 agent 的单层完整交集**，**不得**追加第二层（每个 agent
  任一刻只允许一层，§4 交集语义）。
- **已装层记录的写者与同步次序（G4/B6 的"层在 ⇔ 记录在"由此成立）**：§6.1 的**已装层记录**（该
  agent 当前是否存在本插件的 restriction 层、该层的 deny 集合与判定理由）由 §6.1 持有，其**唯一写者
  是本节的安装/释放动作**（与 `Map<agent, disposer>` 同源同寿命，见上面的 `mount` 条）——**写记录与
  装层必须在同一个同步块内完成，中间不得出现 `await`**，次序固定为**先装层、后写记录**：先调用
  `agent.ctx.tools.restrict({ deny: [...] })` 拿到 disposer（返回即表示层已装入），**紧接着在同一
  同步块内**把新记录写进去。**为何没有窗口**：写记录与装层之间不存在任何让步点，guard 只在派发口
  同步读记录、不会被调度到两者之间；而这一同步块内由 `restrict()` 同步触发的 `tools/change` 重算
  请求**被 §6.2 的合并闸吸收**（置脏后补跑，见上面的重入与收敛三条硬约束），**不会在块内重入**，
  因此任何观察者看到的都是"层与记录已成对"。次序**不得**反过来（先写记录、后装层）：装层抛错就会
  留下"记录在而层不在"的**假隐藏**，与 B6 的"层在 ⇒ 拒绝"冲突。**释放侧对称**：在同一同步块内
  **同步清除记录、再调用该层的 disposer**（清除在前，使释放窗口里 guard 读不到已失效的记录）；
  **"先装新、后释放旧"**时记录在同一同步块内**整体替换**为新层的 deny 集合与理由（不存在**可观测的**"两层都在"
  或"记录指向旧层"的中间态——该同步块内"先装新、后释放旧"确有两层并存的**瞬时**，但块内没有任何让步点，任何观察者都调度不到那一刻）。于是**每一刻**都满足：**层在 ⇔ 记录在**——记录只由装层/释放动作改写、
  且二者同块原子，guard 便观察不到"记录在而层不在"（假拒绝）或"层在而记录不在"（假放行），这正是
  G4 与 B6 所断言的恒一致。
- **restriction 的安装位置（消歧，硬约束）**：restriction **只能装在每个 agent 自己的 ctx** 上——
  `agent.ctx.tools.restrict({ deny: [...] })`（agent 取自 `agents.list()` 或 `agent/created` 载荷）。
  在**非作用域 ctx**（插件的根 ctx、注入回调的 `agentCtx`）上调用 `restrict()` 宿主会**直接抛错**：
  *"tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask
  every agent — deny the tool for the intended agent instead"*。注入回调的 ctx **只用于**取得
  `agents` / `workspaceRegistry` 服务与**承载挂载生命周期**（effect 的作用域），**绝不在它上面安装
  restriction**。
- guard：在普通 ctx 上注册**一层**全局 guard（幂等）。**不变量（定义在 G4 与 B6；此处只作机制说明、
  不另立判据）**：guard 是**已装层的执行侧镜像**——它读 §6.1 的**已装层记录**（该 agent 当前是否存在
  本插件的 restriction 层，以及该层携带的判定理由），**不**自行重算判定：**层在 ⇒ 拒绝**（理由可读，
  B6）；
  **层不在 ⇒ 放行**。所以判定缓存缺失/陈旧时没有第三种裁决——fail-open 只可能出现在"层本就不该
  存在"（可见）的状态，与可见性一致（D1/G4）。它只对"**本插件范围内/外**"负责——**不得**把上游
  `allow` 遮蔽当成故障（B15）。`guard` 不存在时降级为"仅可见性"：向 §6.1 的 `degraded` 集合追加
  `source: 'visibility-only'` 标注（可测断言见 B17），不因此拒绝注册。
- 工作区列表读取（**机制**；判据与可测断言见 B16）：判定侧经 §6.1 的缓存读取
  `ctx.workspaceRegistry.list()`；**抛错或返回空**一律按"空表"处理（`selected` ⇒ 全员不可见，
  fail-closed；`global` 判定不依赖列表）并追加 `degraded`（`source: 'workspace-list'`）标注；
  该降级态下写侧一律被拒绝（§6.3）、设置页禁用保存（§6.4）——服务端与 UI 同一语义。
- `refreshScope()`（**导出**）：**按宿主事件 / 保存事件触发重算的编排入口**——不是状态或缓存的第二
  所有者（作用域文档、`degraded`、规范化路径映射、判定缓存与重算的**算法**都归 §6.1，见 §6.1 的
  "状态所有权与分层"）：它按 `agent/created` / `agent/disposed` / `tools/change` 与配置保存触发一次
  重算，读取 §6.1 的所有者状态，对**全部 live agent** 重算并重装 restriction（先装新、后释放旧），
  返回本次结果供 HTTP 面回显。它是"保存 ⇒ 即时生效"的唯一入口（D10/B4）。
  该重算同样受上面三条**硬约束**约束（**合并 / 置脏后补跑** / 幂等短路 / 有界放大）。
- 与工具层的关系：`registerCherryTools` 仍注册到**插件的根 ctx（全局层）**（本设计不改注册位置），
  **可见性由 restriction 决定**；注册时机由注入回调门控，注册的 disposer 归属该 effect（见上）。
- **不变量：这 14 个工具必须留在全局层（注册位置）**：`restriction` 只过滤**继承面**，作用域注册的工具
  不会被 restriction 屏蔽；若改到 agent 层注册，`restrict` 会以
  `tools.restrict() names unknown global tool …` 抛错，症状是范围功能**整体不可用**（不是个别工具
  漏出）。**两个位置必须分清**：工具**注册**在插件的根 ctx（全局层）；restriction **安装**在每个
  agent 自己的 ctx（`agent.ctx.tools.restrict(...)`）。注入回调的 `agentCtx` 既**不**注册工具、
  也**不**装 restriction——它只用来取得 `agents`/`workspaceRegistry` 服务并承载 effect 的生命周期。

### 6.3 HTTP 面（扩展 `src/httpApi.ts`）

- `GET /cherry-remote/api/scope` → `{ scope: {mode, workspaceIds, revision}, workspaces: [{id,title,path}], staleWorkspaceIds: [...], pathUnmatched: [...], host: {state, capable, reason, degraded} }`
  （工作区列表必须由插件侧读取注册表后下发，浏览器读不到；`staleWorkspaceIds` 见 B14
  （**列表降级时返回空数组并带 `degraded` 标注**——不把"读不到"当成"全都失效"，B16）；
  **`pathUnmatched`** 是 §6.1 的**路径不匹配诊断**的传输通道（与 `staleWorkspaceIds`、`host`
  **并列**的独立字段）：每项含 agent id 与 `cwd` 样本，语义是"该会话 `cwd` 规范化后对不上任何
  注册表项"，**非 degraded**——**不得**并入 `host.degraded`、也**不得**与"已失效选择"
  （`staleWorkspaceIds`）互相推导，设置页的呈现方式见 §6.4；`host.state`
  ∈ `pending`/`unsupported`/`ready`，`capable` 是 `state === 'ready'` 的布尔投影，`reason` 按真实
  缺因生成（§6.2/B7）；**`degraded` 是数组**——形状为 `[{source, reason}, …]`，**空数组 = 无降级**；
  `source` 取 `install`（安装失败）/ `workspace-list`（列表不可用）/ `visibility-only`（`guard`
  缺失的仅可见性降级）/ `scope-version`（文档版本高于本插件支持，§6.1）等来源，每项一条标注；
  集合语义与**合并规则见 §6.1**——**同源去重（保留
  最新）、异源并存**，因此多种降级同时成立时数组里有**多条**，客户端**不得**只渲染最后一条，
  也不得让后写覆盖先写）。
- `PUT /cherry-remote/api/scope` → 校验并原子写入；**写入成功后同步调用 §6.2 的 `refreshScope()`**
  （保存 ⇒ 全部 live agent 重算，D10/B4；**"一次断言即可观察到"以 §6.1 的规范化路径映射与判定缓存
  已就绪为前提**，见下面的"校验与写入是同一临界区"条），再返回新 revision、被修剪的 id 列表（`pruned`，B14）
  与规范化后的文档。
- **校验面只覆盖"字段与类型"（唯一裁决，B14）**：`mode` 不是 `global`/`selected`、`workspaceIds`
  不是字符串数组之类 ⇒ 校验失败（`400` + 稳定错误码 `invalid-scope`）。**注册表外的 id 不是校验
  失败**——它就是**已失效的 id**，唯一裁决是**以修剪为准**：`PUT` 把它从文档移除并在响应回报
  `pruned`。因此 §6.4 的"一键清除 + 据 `pruned` 回显"是清除已失效选择的**唯一路径**，不存在
  "先校验失败、修剪永不可达"的第二条裁决。
- **修剪护栏（B16 的降级态；二选一已定：直接拒绝该次 `PUT`）**：只有**非 degraded 的权威列表读**
  才允许修剪。工作区列表读不到（`list()` 抛错或返回空 ⇒ degraded，B16）时，`PUT` **不得修剪**、
  更不得写入：该次请求**一律被拒绝**（`503` + 稳定错误码 `workspace-list-unavailable`），已存
  `workspaceIds` 与 `mode` **一位不动**（判据是"读不到列表就不能替用户做写决策"，与 §6.4 的
  "禁用保存"同一语义、服务端兜住 `GET→PUT` 竞态）；`staleWorkspaceIds` 此时返回**空数组**并带
  `degraded`（`source: 'workspace-list'`）标注。**不得**把"读不到列表"当成"所有 id 都已失效"。
- **版本过高的文档（§6.1 的 `scope-version` 只读降级）⇒ 写入一律被拒绝，稳定错误码
  `scope-version-unsupported`（`503`）**：不修剪、不落盘、已存内容一位不动。**语义类别与理由**：这不是
  请求体的问题（`400` 的 `invalid-scope` 不适用——请求字段与类型完全合法），也不是"重读后就能重发"的
  状态冲突（`409` 的 `scope-revision-conflict` 不适用——重读得到的仍是同一份更高版本的文档，改基准
  revision 也无济于事；把它混进 `409` 还会让 §6.4 显示"请重新读取后再保存"这种**无济于事**的提示）；
  它是**服务端此刻不能处理写入且重试无益**，与 `workspace-list-unavailable` 同属一类，故取 `503`。
  §6.4 的"禁用保存"与 `degraded`（`source: 'scope-version'`）标注同源于 §6.1 的这条降级。
- **乐观并发（D6 的先例；三个前提见下）**：请求体**必须**携带基准 `expectedRevision`（读-改-写）；
  **缺失即失败**（`400` + 稳定错误码 `missing-expected-revision`）——这是**有意的加严**：先例
  `dsh-mcp-connector/lib/connection-scopes.js` 的 `apply(input, { expectedRevision })` 对
  `undefined` **不抛错**（`if (expectedRevision !== undefined && …)`），而本设计即便在单用户配置面
  也要堵掉"不带基准的盲写覆盖"。与当前 revision **不匹配** ⇒ **不写入**，返回 **HTTP `409`** 的
  **结构化冲突错误**：沿用模块既有的错误封装维度 `{ error: <稳定错误码字符串>, message? }`
  （`src/httpApi.ts:377-380` 的 `writeError`），即
  `{ error: 'scope-revision-conflict', message: '配置已被他处修改（当前 revision=3），请重新读取后再保存' }`
  ——**错误码是字符串常量，不得往 `error` 槽位塞对象**；当前 revision 写进 `message`（客户端本就
  必须重新 `GET`，不另开机器可读字段）。校验失败（`400`）与冲突（`409`）分属两个**稳定错误码**，
  §6.4 据此判别"冲突提示"与"其他失败提示"。语义与 D6 声称沿用的先例一致：先例在不匹配时抛
  "连接作用域已变化（当前 revision=…），请重新预览"。
- **校验与写入是同一临界区（硬约束）**：`expectedRevision` 的校验与写入之间**不得出现 `await`**
  （同一不可中断的临界区，或等价的显式串行化点）——否则两个并发 `PUT` 会双双通过校验、后写静默
  覆盖先写。另有**权威态在内存**（§6.1）：文档与 `revision` 以内存为准、文件写盘**仅作持久化**，
  因此"写入成功后**同步**调用 `refreshScope()`"成立、全程不依赖异步读盘；B4/D10 的"一次断言即可
  观察到"以此为据，**并以"规范化路径映射与判定缓存已就绪"为前提**（重算期允许 async 重建，收敛由
  coalescing 保证——见 §4/§6.2 的重入与收敛三条硬约束）。
- 沿用既有同源/信任围栏（Host/Origin/sec-fetch-site 规则），不新开例外。

### 6.4 设置页（扩展 `ui/src/*`）

- 新增「启用范围」面板：`全局` / `仅选定工作区` 二选一 + 工作区多选（标题 + 路径）。
- 空态文案（D11，**按模式区分**——文案不得与判定矛盾）：`仅选定工作区` 模式下**一个都没勾** ⇒
  *尚未启用任何工作区——此状态下 `cherry_*` 工具不会出现在任何会话里；勾选后对应工作区的会话
  （含进行中的）即可使用。*；`全局` 模式下**未勾选任何工作区**（勾选不参与判定，B2）⇒
  *当前为全局模式：这些工具在所有工作区都可用；下面的勾选仅在切到「仅选定工作区」后才生效。*
- 生效范围文案（B15）：只说"**本插件未遮蔽**这些工具"，**不写**"模型一定能看到 / 一定能调用"——
  上游 `allow` 型过滤（如子代理的 `toolFilter`）可能把 `cherry_*` 整体遮蔽，那是接受的行为。
- 已失效选择（B14）：把 `staleWorkspaceIds` 显式渲染成"已失效（工作区已删除）"分组，列出 id 并
  提供**一键清除**；**这是清除已失效选择的唯一路径**——保存时这些 id 由 `PUT` **修剪**（注册表外
  的 id 就是已失效 id，**不是**校验失败），界面据 `pruned` 回显清除结果，而**不是**提示"校验失败"。
- 路径不匹配（§6.1 的诊断字段经 §6.3 的 `pathUnmatched` 下发，**非 degraded**）：该数组非空时，
  在面板里逐条呈现"**该工作区已勾选，但该会话的 `cwd` 规范化后对不上**"（列出 agent id 与 `cwd`
  样本，并说明"拼写不同 / 符号链接 / 该目录确实未注册"三者在此不可区分）；它只解释"勾了却无工具"
  的原因，**不**改动勾选与 `mode`、**不**触发 `PUT`，也**不**与"已失效选择"（`staleWorkspaceIds`）
  或降级标注合并显示。
- 列表不可用（B16）：工作区列表读不到时**禁用保存**并显示原因；**服务端同语义**——该降级态下
  `PUT` 一律被拒绝（`503` + `workspace-list-unavailable`），已存勾选与 `mode` **一位不动**、更不
  修剪（§6.3 的二选一裁决），因此 `GET→PUT` 竞态（先读到健康列表、随后列表降级）也不会清空勾选；
  面板若仍收到该错误（如另一标签页触发），按结构化错误显示原因、**不改动本地状态**。`全局` 模式下
  判定不受影响，但面板仍须说明"注册表列表当前读不到"。
- 降级标注（B12/B16/B17；`scope-version` 见 §6.1）：`host.degraded` 为**数组**——非空时在面板顶部
  **逐条**显示**全部**标注（数组每一项一条：来源 + 原因；安装失败 / 列表不可用 / 仅可见性降级 /
  文档版本过高……），按 §6.1 的合并规则
  呈现：同一来源只显示最新一条，**不同来源必须同时可见**，**不得**只渲染最后一条。
- 宿主能力**三态**（B7/D8/D13）：`unsupported`（静态能力缺失）⇒ 面板顶部显示只读告警 + **按真实
  缺因生成的**原因（缺哪个 API 就写哪个）与**升级提示**，并**禁用保存**；`pending`（注入回调尚未
  到达）⇒ **只**显示**中性等待提示**（如"宿主服务挂载中，稍后自动就绪"），**不得**出现"宿主不支持"
  类措辞、**不禁用**与范围无关的操作（配对/设置页自救面照常可用，D9）；`ready` ⇒ 无提示。
  **`pending` 与"列表降级"是两件独立的事**：`pending`（注入回调未到达）只给**中性等待提示**，
  **不**产生"宿主不支持"结论、**不**因此禁用保存。**"UI 禁用保存"有三类独立来源**
  （`unsupported`／`scope-version`／`workspace-list`）：
  ① `unsupported`（能力态，B7①——**它只有 UI 禁用保存**，§6.3 **没有**对应的服务端 `PUT` 拒绝条款）；
  ② `scope-version` 降级（§6.1）；③ `workspace-list` 降级（B16）。**服务端拒绝另见 §6.3 的错误码
  清单**——`400 invalid-scope`／`400 missing-expected-revision`／`409 scope-revision-conflict`／
  `503 workspace-list-unavailable`／`503 scope-version-unsupported` **也是"不写入"来源**，但它们与
  上面三类**不是同一份清单**（服务端拒绝不由"禁用保存"推导，反之亦然），**不得**把两者读成互斥或
  互相推导。`pending` **不**导致禁用保存，三类来源**不得互相推导**（也不得合成一条）。二者**同屏
  可能出现两条独立提示**（中性等待 + 列表不可用），**不得互相吞并**（合成或只渲染一条）、**不得互相
  推导**（由 `pending` 推出"宿主不支持"或"列表读不到"，或由列表降级反推能力态）。
- 保存后回显新 revision；失败提示**按稳定错误码字符串判别**（沿用模块既有 `{error, message?}` 维度，
  §6.3）——`error === 'scope-revision-conflict'`（`409`，`message` 内含当前 revision）⇒ 冲突提示
  "配置已被他处修改，请重新读取后再保存"；`error === 'scope-version-unsupported'`（`503`，§6.3 的
  只读降级）⇒ 提示"作用域文档版本高于本插件支持"并**禁用保存**，**不得**提示"请重新读取后再保存"
  （重读不会改变文档版本，重读后仍是同一份文档）；其他错误码（`invalid-scope` /
  `missing-expected-revision` / `workspace-list-unavailable` / IO 类）⇒ 校验/列表不可用/IO 失败提示；
  **所有失败都不改动本地状态**。

### 6.5 配对文案（第 ① 项，**已实施**：`c4b8b80`）

> 状态：本条已随 `fix(pairing-ui): the desktop shows only a QR code — route the user
> through a scan`（`c4b8b80`）落地，并由 `tests/unit/ui.test.ts` 的 ①a 断言钉住。实施第 ② 项时
> **不要**重做这一节；下面保留为背景与措辞出处。

- `ui/src/PairingWizard.tsx` 顶部提示 →
  *「在 Cherry Studio 桌面端打开「远程连接 → 添加设备」；该界面显示的是二维码。请用微信或浏览器等扫码，把扫码后页面上显示的配对信息复制下来，粘贴到下方。」*
- 同文件三步说明 → ①桌面端「添加设备」显示二维码；②用微信/浏览器扫码，复制扫码页显示的
  配对信息（含地址、端口与一次性邀请）；③粘贴到下方开始配对，再对照桌面端窗口的 6 位验证码确认。
- 输入框**标签**「配对信息」；**占位符**「粘贴扫码后页面上显示的配对信息」。
- `cherry_pair` 的 `payload` 参数说明、`README.md`「首次配对」步骤、`docs/e2e-checklist.md`
  对应条目同步。

## 7. 测试策略

- 单测：`normalizeScope` / `isVisible` 的边界（缺失、损坏、未知 mode、重复 id、空列表、
  `version` 更高 / 未知）；
  **id 字符串归一边界**：一侧是字符串、另一侧是非 string（或带首尾空白）时，判定结果与
  两侧都规范化后一致；**会话→工作区判定是 §6.1 的单一真相**：`sessionIds` 命中、规范化路径命中、
  两者都不命中各一例，且可见性层 / 诊断 / UI 走**同一实现**（同输入必同输出，不得各持副本）；
  **`guard` 的断言与"同一实现"无关**：它断言的是**行为与已装层状态一致**（层在 ⇒ 拒绝、层不在 ⇒
  放行，拒绝理由可读），**不**是"走同一实现"——见下面的"guard 与可见性层同源"（B6）；
  **路径规范化（D14 的单一契约）**：规则二只在"规范化后相等"时命中（裸字符串不同、规范化后相同
  ⇒ 命中）；**老宿主的回退比较语义**：夹具令 `resolveByPath` 不可用 ⇒ 断言退化为**仅大小写敏感的
  字符串等价**（不做 realpath；同义路径不命中 ⇒ 只剩 `sessionIds`，且诊断出现路径不匹配记录）；
  "有 `cwd` 但规范化后不匹配任何注册表项" ⇒ 判定为无工作区**且**产生**路径不匹配诊断**（非 degraded）。
- 集成：假 `agents` ctx（模拟 `inject` + `agents.list` + `agent/created|disposed` + `tools/change`
  + 可观测的 `restrict`/`guard` + **有作用域语义的 `schemas`**，即无参 = 全局视图、带 agent =
  已过滤视图）驱动真插件装配，断言 B1–B18；特别断言"先装新后释放旧"与
  "不叠加"（B10，叠加会因交集语义不可恢复）、"部分注册窗口下按交集安装成功并补齐"（B12）、
  **"交集仍抛错走安装失败路径（记录 + degraded（`source: 'install'`）+ 重试，不吞掉）"（B12）**、
  "新会话首轮即有工具（cwd 缺失的会话按 D7 永久不可见）+ 仅补偿 `sessionIds` 滞后的有界复检
  同步返回不阻塞建会话"（B13）；**同一夹具断言 D14 的解析状态四值可测（"复检只对暂不可解析启动"）**：
  令 `resolveByPath` 抛错 ⇒ 该 agent 为 `unresolved` 且**已启动**有界复检；令 header 无 `cwd`
  （`no-cwd`）或解析成功但规范化后不属于任何注册表项（`no-match`）⇒ 断言**任何复检定时器都未启动**
  （无空转），判定照旧落 D7 的"无工作区"（`no-match` 另产生路径不匹配诊断）；`resolved` 一例则断言
  当轮装层且**不**启动复检；
  **"依赖卸载 → 重挂循环"（B10）**：模拟 `agents`/`workspaceRegistry` 注入依赖卸载 ⇒ 断言这 14 个
  工具的注册、该 effect 内注册的 **guard** 与全部 restriction、订阅**同时消失**（四者随同一个合并
  disposer 释放；卸载后任一时刻都不存在"已注册未隐藏"，也不存在释放后被重算装回的**无主层**——
  释放侧同样发 `tools/change`，见下面的第⑦点）；依赖重挂 ⇒ 断言注册 / guard / restriction
  **同时恢复**、不抛"already registered"、**不出现叠加层**（重挂后每个 agent 仍只有**一层**
  restriction，交集语义下不应出现任何叠加）；
  **"取消勾选后工具回来"（B18①）**：同一 agent 先装上 deny 层（不可见），目标集合变空后断言旧层被
  释放、`cherry_*` 重新出现在该 agent 的工具表里、且**无层残留**；
  **"观测集为空时跳过安装但既有层被维护"（B18③）**：在注册前令无参 `schemas()` 取不到我们的名字
  ⇒ 断言**绝不提交空 deny**（夹具记录每次 `restrict` 入参 ⇒ 从未收到 `{ deny: [] }`）、不抛错，
  且既有层的释放照常发生；注册完成后断言补齐恰好装**一层**完整交集
  （B12③/B18④）；
  **"同步判定"（§4 硬约束/D14）**：夹具令 `resolveByPath` 挂起（永不 resolve）⇒ 断言
  `agent/created` 监听器仍**同步返回**、按 D7 fail-closed 装层，且不因异步区间丢掉收敛；
  **"重入闸 = 合并 / 置脏后补跑（coalescing） / 幂等短路 / 有界放大"（§4 硬约束：重入与收敛）**：重算期间
  到达的 `tools/change` 与新 `agent/created` **不丢失**——被合并到本轮末尾**补跑一次**（不递归放大，
  每个 agent 每轮至多重装一次），同一 deny 集合不重装；该断言与 B12③"部分注册窗口随后补齐"在**同一
  夹具上同时成立**（补齐正由补跑轮完成）；
  **"路径同一性单一契约"（D14/B13）**：夹具令注册表项的 `path` 与会话 `cwd` 仅在拼写/大小写/符号
  链接上不同 ⇒ 断言经 `resolveByPath`（realpath）规范化后命中**同一 workspaceId**、规则二当轮装层
  （B13"第一轮就有"）；再把 `resolveByPath` 置为不可用（老宿主）⇒ 断言退化为大小写敏感的字符串等价、
  规则二不命中时**只剩 `sessionIds`**，且诊断出现**路径不匹配**记录（非 degraded）；
  **"guard 与可见性层同源"（B6/D14）**：在判定缓存缺失/陈旧的夹具下（清空缓存、令下一次重算不可用）
  断言 guard 的裁决与**已装层**恒一致——层在 ⇒ 拒绝且理由可读（含工作区标题或 id），层不在 ⇒ 放行，
  不存在"可见却被拒"或"已隐藏却放行"的窗口。
- 假宿主**必须复刻**的语义清单（不复刻这七点，B10"不叠加"、B12"部分注册窗口"与重入/合并类断言会在
  夹具上**恒真而空过**）：① `restrict({})`（`allow`/`deny` **两键全缺**）**必抛**；
  ② `restrict({ deny: [] })` **不抛**，而是装入一个**对任何名字都放行的 no-op 层** ⇒ 断言插件
  **绝不提交空 deny**（否则该 no-op 层会被"层在 ⇒ 拒绝"的 guard 误读成"该 agent 已被隐藏"⇒
  **工具可见却被拒**）——①②**分别**断言，**不得**混成一条；③ `restrict` 对**未知名字 / 作用域局部名 /
  保留 `run_code` 名**三类入参抛错；④ **跨层取交集**（`layers.every(admits)`）——叠加两层 `deny`
  无法靠释放其中一层恢复；⑤ `schemas` 的**作用域语义**——无参 = 全局视图，带 agent = 已按该 agent 的
  restriction 过滤后的视图（D12 的交集只允许取前者）；⑥ **在非作用域 ctx（插件根 ctx / 注入回调的
  ctx）上调用 `restrict()` 必抛**（宿主原文 *"requires a scoped context (agent.ctx)"*）——不复刻则
  "restriction 只能装在每个 agent 自己的 ctx"这一硬约束在夹具上测不出来（写错位置照样全绿）；
  ⑦ **`guard()` 不触发 `tools/change`，而 `restrict()` 触发**（宿主 `guard` 的 effect 带
  `notify:false`，`restrict` 不带）——**且该差异在释放侧同样成立**：宿主 `dsh-scope` 的
  `ScopedLayers.effect` 的 **undo 路径同样调用 `onChange()`**（`yield () => { undo(); …; if
  (notify) this.onChange(); }`），而 `register()` / `restrict()` 的 effect **都没有** `notify:false`
  ⇒ 假宿主的 `restrict()`/`register()` 在**释放**时也**必须**发 `tools/change`（**`guard()` 的释放
  不发**）。不复刻（尤其漏掉释放侧通知）则该差异相关断言会在夹具上**空过**——据此断言
  **teardown 期间不发生重算**（退订在前 ⇒ 释放发出的 `tools/change` 已无人订阅；或重算被
  `torn-down` 标志短路），且 **teardown 之后无残留层**（B10：不存在被重算装回的**无主层**，
  每个 agent 的 restriction 层与 disposer `Map` 一同清零，§6.1 的判定缓存 / 路径映射 / 解析状态同样作废，见 §6.2 的合并 disposer）。
- 边界与降级（B14–B17）：① 删除已勾选的工作区后 `GET.staleWorkspaceIds` 含其 id、`workspaces[]`
  不含它；一次**非 degraded** 的 `PUT` 修剪该 id 并在 `pruned` 回报、随后 `staleWorkspaceIds` 变空（B14）；
  ② 夹具叠加一层上游 `allow` 把 `cherry_*` 排除 ⇒ 诊断/设置页文案只声称"本插件未遮蔽"、不出现
  "可见/模型可调用"字样、`guard` 不因此拒绝调用也不报 degraded（B15）；③ 夹具令 `list()` 抛错或
  返回空 ⇒ `selected` 下全员不可见 + 诊断 degraded + 设置页禁用保存；`global` 下不装 restriction
  但 UI 仍显示列表不可用（B16）；**该夹具下再发一次 `PUT` ⇒ 被拒绝（`workspace-list-unavailable`）、
  已存 `workspaceIds`/`mode` 一位不动、`staleWorkspaceIds` 为空数组且带 degraded 标注**
  （B14/B16 的写侧护栏：降级读下 PUT 不清空勾选）；④ 夹具去掉 `guard` ⇒ 越界 agent 的 `restrict`
  层照常安装、诊断与设置页出现 `source: 'visibility-only'` 的降级标注、且不拒绝注册（B17）；
  ⑤ **多源并存断言（`degraded` 是集合）**：同一夹具里**同时**令 `list()` 抛错（`workspace-list`）
  与 `guard` 缺失（`visibility-only`），并叠加一次安装失败（`install`）⇒ `GET.host.degraded` 是
  **数组**、三个 source 各自一条**同时可见**（异源不得互相覆盖），设置页顶部与诊断**逐条**显示
  **全部**标注；再对同一 source 触发一次 ⇒ 该 source 仍只**一条**且 reason 为最新（同源去重）。
  ⑥ **`version` 更高 / 未知的文档（如 `version: 2`，本插件支持 1）**：夹具放入该文档 ⇒ 断言 `PUT`
  **被拒绝**（**稳定错误码 `scope-version-unsupported`，`503`**；不修剪、不落盘、已存内容一位不动）、
  `GET.host.degraded` 含 `source: 'scope-version'`
  且 reason 写明"文档版本高于本插件支持"、设置页**显式告警**并禁用保存（提示按该错误码分流，**不得**
  提示"请重新读取后再保存"）；且**不得**把它呈现为
  "一个都没勾"的空态文案（与解析失败 / 字段非法走 B9 的路径可区分：后者写入仍可覆盖）。
- HTTP 面（§6.3）：`PUT /scope` 的**非法 `mode` / 字段类型非法** ⇒ 校验失败（稳定错误码
  `invalid-scope`）、返回结构化错误且不改动已存状态；**注册表外的 `workspaceId` 不是校验失败**——
  它就是已失效 id，按**修剪**处理：响应 `pruned` 列出它、文档里消失（唯一裁决，B14）；
  **`expectedRevision` 缺失 ⇒ 校验失败（`missing-expected-revision`）；与当前 revision 不匹配 ⇒
  冲突错误（稳定错误码 `scope-revision-conflict`，`409`，`message` 内含当前 revision）且不写入、
  不改动已存状态**，要求重读后再提交（B14）；**并发断言**：两个携带**同一基准 revision** 的 `PUT`
  并发提交 ⇒ 恰有一个成功且新 revision 单调 +1，另一个得到 `scope-revision-conflict`（校验-写入是
  同一临界区，不存在双双通过后的静默覆盖）；**降级读下 PUT 不清空勾选**：夹具令 `list()` 不可用 ⇒
  `PUT` 被拒绝（`workspace-list-unavailable`）、已存 `workspaceIds`/`mode` **一位不动**、不修剪、
  `GET.staleWorkspaceIds` 为**空数组**且带 degraded 标注（B14/B16 的护栏）；**版本过高的文档下写侧
  同样被拒绝**：夹具放入 `version: 2` 的文档 ⇒ `PUT` 得到稳定错误码 `scope-version-unsupported`
  （`503`）、**不修剪不落盘**、已存内容一位不动（§6.1/§6.3）；成功写入 ⇒ 响应回显**新
  revision**（单调递增）、`pruned` 与规范化文档，并已**同步**调用 `refreshScope()`（B4）；`GET /scope`
  ⇒ 工作区列表**投影**（`{id,title,path}`）、`staleWorkspaceIds` 与 `host` 的**能力三态**
  （`pending` / `unsupported` / `ready`；`capable` = `state === 'ready'`；`reason` 按真实缺因生成）
  与 `host.degraded` 的**数组**形状呈现正确（**空数组 = 无降级**；多源并存 ⇒ 多条同时可见，
  同源重复只留最新一条）；**`pathUnmatched` 的传输通道**：夹具造一个"工作区已勾选、但该会话
  `cwd` 规范化后对不上任何注册表项"的 agent ⇒ `GET.pathUnmatched` 含该 agent 的 id 与 `cwd`
  样本，且**不**出现在 `host.degraded` 里（非 degraded，与"已失效选择"不得互相推导），设置页按
  §6.4 呈现该提示。
- 设置页（§6.4）：空态文案（D11，**按模式限定**）——`仅选定工作区` 模式下一个都没勾时**必须**写出
  "工具不会出现在任何会话里"；`全局` 模式下未勾选任何工作区时**不得**出现该表述（判定与勾选无关，
  B2），须写出"这些工具在所有工作区都可用"；
  **能力三态与降级来源分开断言**：`unsupported` ⇒ 升级提示 + **禁用保存**且原因**按真实缺因**；
  `pending` ⇒ **只**有中性等待提示（**不得**出现"宿主不支持"类结论）、**不禁用**无关操作（配对/自救面
  可用，D9）、**不因此禁用保存**；**列表不可用 ⇒ 禁用保存并显示原因**、已失效 id 分组渲染且可一键清除
  （B14/B16）；**`scope-version` 降级（§6.1）⇒ 禁用保存 + 显式告警**（不得呈现为"一个都没勾"）；
  **"UI 禁用保存"的三类来源互相独立**（`unsupported` / `scope-version` / `workspace-list`，**仅指 UI
  禁用保存**；**服务端拒绝另见 §6.3 的错误码清单**——`invalid-scope` / `missing-expected-revision` /
  `scope-revision-conflict` / `workspace-list-unavailable` / `scope-version-unsupported` 也是"不写入"
  来源，但与这三类不是同一份清单），**不得互相推导**；**`pending` 与列表降级互相独立**：同屏两条
  提示**同时可见**（不得只渲染一条、不得由其一推导其二），**亦不得由任一类降级或能力态推出另一类**；
  **降级标注必须逐条可见**（`host.degraded` 数组的**全部**条目，异源并存；B12/B16/B17）；保存失败
  **按稳定错误码分流**（`scope-revision-conflict` ⇒ 冲突提示、
  `invalid-scope` / `missing-expected-revision` ⇒ 校验失败、`workspace-list-unavailable` ⇒ 列表
  不可用、`scope-version-unsupported` ⇒ 只读降级提示"文档版本高于本插件支持"并禁用保存，**不得**
  提示"请重新读取后再保存"）且**不改动本地状态**；保存成功回显新 revision。
- 契约：把「restriction 的交集语义（guard 无交集语义，只有单调拒绝）」与「14 个工具名单的**单一常量**」
  写成断言（B11）。
- 门禁：改 `src/` 或 `ui/` 后必须重建 `dist/` + `lib/`（`tests/unit/artifactFreshness.test.ts`
  会拦）；`tests/contract/contract.test.ts` 的既有断言（工具名、版本 pin、六项差异）必须继续绿。
- 门禁（**新增测试文件的 tsconfig 项目归属**）：`tests/unit/projectCoverage.test.ts` 断言
  `tsconfig.json`（server 项目，Node 环境）与 `tsconfig.ui.json`（ui 项目，DOM + JSX）构成
  `tests/**/*.test.ts` 的**精确划分**（每个测试文件**恰好**被一个项目覆盖）；因此**UI 侧测试必须
  同时**加入 ui 项目的 `include` 与 server 项目的 `exclude`，新增测试文件也必须落在正确的项目里，
  否则门禁变红（漏掉一侧会让该文件被 `tsc` 静默跳过）。
- 真机：重启 DSH 后按 `docs/e2e-checklist.md` 新增步骤走一遍（默认不可见 → 勾选 → 进行中的
  会话即时可用 → 取消勾选即时消失 → 无工作区的会话不可见 → 删除一个已勾选的工作区后设置页显示
  "已失效"并可一键清除）。

## 8. 出界与推迟

本节只收"**本次不做、可能后续**"的条目；"**永不**"的范畴见 §3 非目标（按工具/按设备/按连接/按会话
的范围细分、会话级激活 / TTL 已在 §3 列明，此处不重述）。

- 范围作用于 `/cherry-remote/api` 或设置页；范围的服务端强制多用户隔离（本插件是单机单用户假设）。
- 作用域文档的 history/回滚（`dsh-mcp-connector` 有 20 条 history；本次**不做**，只保留 revision）。
- 首次升级时的迁移向导（"要不要顺便帮你勾上 dsh 工作区"）——本次只做空态说明。

## 9. 留给实施者的决定

- 模块与文件的具体切分、命名、以及是否把 §6.1 的纯函数并入现有模块。
- 假 `agents` ctx 测试夹具的具体形状（仓库现有 loopback 夹具风格可复用）。
- 设置页多选控件的具体交互（列表 + 复选、搜索、全选/清空）。
- 诊断面（`src/diagnostics.ts`）里范围状态的具体字段与脱敏口径。
- restriction 安装的其余实现细节自定；但"先装新后释放旧、按交集安装、空集只释放、失败重试"与
  §4/§6.2 的**重入与收敛三条硬约束**（合并 / 置脏后补跑、幂等短路、有界放大）不得自定。
- D14 有界复检的具体次数/间隔（约束是：有界、**只对"有 cwd 但暂不可解析"的 agent** 启动——
  无 cwd 与已判定无工作区的会话都不启动）。
- `degraded` 标注在诊断与设置页的具体措辞（判据：`host.degraded` 数组逐条呈现，同源去重、
  异源并存，见 §6.1/§6.3/§6.4）。

## 10. 事实出处

- `@deepseek-ai/dsh-tools@0.2.0-rc.2`：`lib/types/index.d.ts` —— `ToolRestriction`（508–513 行）、
  `register` / `restrict` / `guard`（636 / 644 / 655 行）、`tools/change` 声明（102 行；93–101 行是
  其 doc 注释）、`ToolDefinition.execute(args, exec)`（128 行）、`ToolRunContext`（305–322 行）。
- `dsh-mcp-connector@0.2.72`：`lib/session-injection.js`（`installRestriction` 144–162 行、
  `refresh` 164–186 行、guard 兜底 188–189 行、`mountAgents` 351–373 行、`capabilities` 375–384 行
  （**只上报标志**；`guard` 缺失 ⇒ `disposeGuard = null` 静默降级 188–199 行）、
  `lib/connection-scopes.js`（guard 兜底 274–275 行；作用域文档形状）、`lib/governance.js`
  （guard 兜底 296–297 行；**`lib/tools.js` 无 guard，勿引**）、`lib/index.js`
  （`workspaceIdForAgent` 223–230 行、`ctx.inject(['agents'], …)` 3358–3375 行、**拒绝启用路径
  243 / 1477 / 2752 行**）。
- `@deepseek-ai/dsh-session`：`lib/types/index.d.ts`（`Session.header` 为 *detached, deep-frozen
  creation metadata*；store-owned header 携带 `cwd`，无 store-owned header 时合成的 minimal
  header 可能不含 —— 时序依据）。
- `@deepseek-ai/dsh-workspace`：`lib/types/index.d.ts`（`WorkspaceRegistry` = `list/get/create` +
  `resolveByPath`（L264，realpath 语义）+ `delete`/`insertBefore`/`initializeDefault` 与
  archive/pin 面；**按会话成员查询须自建**——`sessionIds` 只是实体上的投影，没有同步查询方法。
  事件面只有 `workspace/session-activity` / `workspace/session-stop`，无成员变化事件）。
- `@deepseek-ai/dsh-agent`：`lib/types/runtime-types.d.ts`（`agent/created` 载荷带 live session
  与 completed setup；`Agent.session`、`Agent.ctx`）。
- `@deepseek-ai/dsh-subagent@0.2.0-rc.2`（本机实装）：`lib/index.js:522` 的
  `if (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter)` ——
  上游 `allow` 型过滤的实例（B15 引用；遮蔽方**不是**本插件）。
- 本机工作区注册表：`$DSH_HOME/storages/workspace.json` 的 `tables.workspaces`（11 项，见 §4）。
- 第 ① 项的实施提交：`c4b8b80`（配对文案 + 其 UI 断言）。
- 本仓库既有约定：`docs/superpowers/specs/2026-10-09-cherry-dsh-bridge-design.md`、
  `docs/e2e-checklist.md`、`tests/contract/contract.test.ts`、`tests/unit/artifactFreshness.test.ts`。

> 审查沿革（**仅历史记录，不作规范**）：本设计经两轮外部审查并按合并结论修复；当时的审查发现编号
> 已全部从正文移除，正文规则一律以本文自身的 Dn / Bn / §n 为准。
