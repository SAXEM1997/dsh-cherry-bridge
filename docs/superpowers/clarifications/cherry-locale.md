# cherry-locale — 需求澄清记录

- 任务名：`cherry-locale`（贯穿 Phase 0-4）
- 设计文档：`docs/superpowers/specs/2026-10-16-cherry-locale-design.md`
- 模式：复杂（20-49 文件，Gate 0 运行时升级，见设计文档头部变更清单）
- 澄清时间：2026-10-16
- 触发问题（用户在会话中提出）：「当前的该插件配置页适配了中英文locale吗」

> 本文件是需求真相源。设计文档与后续 spec 必须与本文逐条对得上；文中「用户明说」与「我的推断/拍板」严格区分。

---

## 一、背景事实（我实测确认，非用户陈述）

| # | 事实 | 证据 |
|---|---|---|
| F1 | 插件配置页当前**零本地化**：无 `locale/` 目录、无字典、无 `t()` 调用 | 全仓库 grep `i18n\|locale\|translate`，仅命中 `App.tsx:168` 的 `localeCompare` 与两处注释 |
| F2 | 全部界面文案硬编码中文 | `ui/src/*.tsx` 非注释 CJK 行：ToolScopePanel 41 / DeviceCard 20 / PairingWizard 18 / App 5 / main.tsx 1（导航标签） |
| F3 | 导航标签形式正确但内容恒为中文 | `ui/src/main.tsx:99` `label: () => 'Cherry Studio 互联'`；宿主 `resolveSlotLabel` 支持函数，且 shell 订阅 locale revision 后会重解析 |
| F4 | 插件列表元数据方向相反：只有英文 | `package.json.description` 为英文；无 `locale/en.json`/`locale/zh.json` ⇒ 宿主 `readPluginMeta` 回退 name+description；客户端 `locale.resolveText` 渲染 |
| F5 | 宿主具备完整 locale 能力 | `ctx.locale`（LocaleRuntime，`ctx.provide("locale", …)`）：`register(ns,{en,zh})`（强制双语成对）/`bind(ns)`/`getLocale()`/`subscribe()`；slot 组件由框架注入 `t` 座席，按注册项 `locale: NS` 绑定（范例 `LanguageRow({t,…})` 用 `t("language.title")`） |
| F6 | 宿主内建 `zh`/`en` 两套字典，`FALLBACK_LOCALE` = 英文 | `dsh-client-locale/lib/types/client/index.d.ts` 注释与常量 |
| F7 | **14 个 `cherry_*` 工具的描述本来就是英文** | `src/tools.ts` 描述全英文；`src/rpc/**` 非注释 CJK = 0 ⇒ 模型/会话侧无需改动 |
| F8 | 服务端有 63 条非注释中文串，其中一部分经 HTTP 原样到达界面 | `src/toolScope.ts`、`src/toolScopeHost.ts`、`src/diagnostics.ts:329`；面板渲染 `data.host.reason` 等 |
| F9 | 客户端 bundle 的 `inject` 声明会被宿主用作**激活门控**（activation gating on inject）；直接访问未声明的服务会被守卫拒绝，而 `ctx.get(name)` 是**可选查找**（不需要声明） | `dsh-cordis-client-runner/lib/client.js`：`dynamicCordisContext` 中 `if (prop === "get") return (name) => readService(name, false)`；`readService(prop, true)` 对未声明服务 `denyRead`；注释「activation gating on inject」 |

---

## 二、澄清问答（原始对话）

### Q1｜英文界面的使用场景是什么？
**我问**：是你自己把宿主语言切成 English 时不想看到中文，还是这插件要给不读中文的人用（同事上手 / 对外发布）？

**用户答**：「后续需要发布到github，需要兼容性适配」

**结论（用户明说）**：面向公开发布，非个人偏好 ⇒ 英文必须是一等公民（完整、正确、可长期维护），不是"中文页面上贴几个英文标签"。

### Q2｜「兼容性适配」指什么？
**我的推断 + 用户未否认**：指**语言环境兼容**（中英文环境都能正常用），不是 DSH/宿主版本兼容。

**处理**：按此理解推进；同时把"宿主缺少 locale 服务时页面必须照常渲染"作为**必须**满足的兼容性要求（见 Q5 与「边界条件」B1）。

### Q3｜英文界面里出现中文算不算不可接受？（服务端告警文本）
**我问**：面板上若干降级告警由 `src/` 生成、经 HTTP 原样显示（如「宿主缺 tools.guard：执行层兜底不可用…」「判定缓存未命中（按 D7 fail-closed 隐藏）」），共 63 条非注释中文串。要求一句中文都没有 ⇒ 需改成错误码+参数由客户端翻译，会动 HTTP 契约与既有测试；只要求正常路径双语 ⇒ 改动只落在 `ui/`。

**用户答**：「告警等先不管」

**结论（用户明说）**：**范围排除**——`src/` 的服务端诊断/降级/日志文案保持中文，本次不改，也不改 HTTP 契约。英文界面在异常路径下会中英混排，这是**已知且接受**的折中，须写入设计文档的「不做/已知折中」。

### Q4｜README 是否纳入本次范围？
**我问**：GitHub 第一屏就是 README（现 345 行、248 行含中文），这次一起做双语还是留到发布前？

**用户答**：「readme后续单独处理」

**结论（用户明说）**：**范围排除**——README 与 `docs/e2e-checklist.md` 等文档的翻译不在本次范围。

### Q5｜locale 服务缺席时的行为？
**我拍板（用户未反对）**：**不得**因声明 `locale` 依赖而导致整包停用（F9/F10 的风险）。

**回退链（设计段 2A 呈现，用户答「行」确认，2026-10-16）**：宿主服务缺席 ⇒ `navigator.language`（`zh*` → 中文，其余 → 英文）⇒ 取不到 navigator ⇒ 中文。

> **修订记录**：本条原始写法是"一律回退中文"。设计段 2A 把"英文浏览器在缺服务的宿主上会看到英文"这一行为变化单独提请确认，用户答「行」⇒ 改为上面的回退链。这正是"面向 GitHub 外部用户"的意图所在。宿主自身的语言解析（含无法判定时的英文兜底）由宿主决定，本插件不干预。

### Q6｜英文界面里插件叫什么名字？
**我问**：现为「Cherry Studio 互联」，出现在导航、页面大标题、插件列表三处。候选方向：Bridge / Remote / 其他。

**用户答**：「bridge那个吧」

**结论（用户明说）**：英文名 = **Cherry Studio Bridge**，与包名 `dsh-cherry-bridge` 对齐。中文名保持「Cherry Studio 互联」不变。

---

## 三、用户的选择与偏好汇总

| 项 | 值 | 来源 |
|---|---|---|
| 动机 | 后续发布到 GitHub，面向外部用户 | 用户明说（Q1） |
| 范围 | 插件**运行时界面**的中英双语（`ui/` 一侧 + 插件列表元数据） | 用户明说（Q1/Q3/Q4 收敛） |
| 范围外 | 服务端诊断/告警文案（`src/`）、HTTP 契约 | 用户明说（Q3） |
| 范围外 | README、E2E checklist 等文档翻译 | 用户明说（Q4） |
| 英文名 | Cherry Studio Bridge | 用户明说（Q6） |
| 中文名 | Cherry Studio 互联（不变） | 沿用现状 |
| 兼容性底线 | 无 locale 服务的宿主上页面照常可用 | 我拍板（Q5） |
| 风格偏好（观察） | 回复从简、按段给结论、不要长篇问答；先给事实与证据再要决策 | 会话观察 |

---

## 四、边界条件与隐含假设

- **B1（必须）** 宿主未提供 `locale` 服务（老版本 / 注入缺席）时：设置页必须**照常注册并渲染**，文案按 Q5 的回退链解析（navigator → 中文）。绝不能因为依赖声明而"等待服务"导致整页消失（F9），更不能让宿主启动失败（F10）。
- **B2（必须）** 语言切换必须是**运行时可响应**的：宿主切到 English 后，已挂载的页面文案随之更新，无需刷新（导航标签由宿主重解析；组件内文案需组件自身订阅或用注入的 `t` 随 revision 刷新）。
- **B3（约束）** 宿主的 typed 注册形式**强制双语成对**（en/zh 必须同时给，缺一边注册失败）——这正好是我们要的，不允许只补英文。
- **B4（约束）** 技术 token 必须逐字保留、不翻译：`cherry_*` 工具名、`tools.guard`、`tools.restrict`、`install`、`workspace-list`、`visibility-only`、`scope-version`、`path-normalization`、`scope-revision-conflict`、HTTP 状态码、revision 数字、文件路径。
- **B5（假设，需验证）** 框架会向注册了 `locale: NS` 的 slot 组件自动注入 `t`；若实测不成立，则改为经注册项 `inject: () => ({ t })` 自行传参（二者取其一，由实现阶段证实后定稿）。——**该假设依附的机制已按「四之四」的 M10 删除**（不再注册宿主字典、注册项不写 `locale: NS`；组件自持 `t`），保留原文仅作历史轨迹，Gate 1 对齐遇本行 DRIFT 以设计文档为准。
- **B6（假设）** `docs/` 与 `README.md` 不进构建产物；`locale/{en,zh}.json` 需同时进 `package.json` 的 `files` 与 `exports` 才能被宿主 `readPluginMeta` 经 Node ESM 解析到。
- **B7（已知折中）** 英文界面会出现中文（Q3 的代价；到达面**不限于**降级/告警路径，`api.ts` 透传的普通拒绝原因同样算，见设计文档 §9.1），设计文档须显式声明，避免后续被当作缺陷。
- **B8（不做）** 不新增插件自己的语言切换入口——语言选择是宿主 General 设置里的「语言」行，由宿主 locale 插件拥有。

---

## 四之二、实测核查补充（子 Agent 侦察报告要点，2026-10-16）

> 全部为上表 F 系列的加强/修正，来自对宿主**已安装产物**的只读核查；改变了方案取舍，故独立成节。

| # | 事实 | 证据 |
|---|---|---|
| F10 | **把 `locale` 写进 bundle 的 `exports.inject` 会导致"整个 Web GUI 启动失败"**，而非"设置页消失"：声明的服务永不 provide 时 fiber 停在 pending，而外壳 boot 审计 `eM()` 发现非 active entry 就 `throw` → `page.fail` | `cordis/lib/index.js:1317-1333`（`_refresh`/`_setEpoch` 对未 provide 的服务置 `INACTIVE` 并直接 return ⇒ `_reload` 不执行）；`dsh-web-frontend/dist/assets/index-5SrrfWpU.js:126` 的 `eM()` |
| F11 | `ctx.get(name)` 是 cordis 核心 mixin，**明确"without the inject requirement"**，未 provide 时返回 `undefined` 而不抛；未声明的**直读** `ctx.locale` 才抛 `cannot get property … without inject` | `cordis/lib/index.js:736-764`、`:674-690` |
| F12 | `t` 座席由**渲染器按注册项的 `locale:` 选项自动注入**，与消费方 fiber 的 `inject` 声明无关；唯一注入点会抛 `SlotAssemblyError`（缺 face 时），且 `SlotErrorBoundary` 对该错误**显式重抛**，不被 entry 级错误边界吞掉 | `dsh-client-ui-renderer/lib/client.js:721-724`、`:928-931`、`:521-538`、`:611-616`；反证 `dsh-client-ui-tool/lib/client.js:4543`（inject 无 locale）`:2347`（注册带 locale）且全文件无 `ctx.locale` |
| F13 | `t` 的实参是**命名空间内的 key**（如 `t("nav")`），不是 `'ns.key'`；miss 后回落 `common`，再 miss 原样返回 key | `dsh-client-locale/lib/client.js:1414-1428`；宿主范例 `dsh-client-ui-settings-plugins/lib/client.js:166-212` |
| F14 | 标准 web 组合**无条件**装配 locale 行（`dsh-web-app/cordis.patch.yml:239-240`，无 `disabled:`），且运行中宿主的 boot graph 里确有该行 ⇒ 现代宿主必然有该服务；风险只存在于自定义/极简组合 | `dsh-web-app/package.json` 依赖 + patch 行；`http://127.0.0.1:23023/` 的 boot graph |
| F15 | 侦察到的**文案总量**（非注释、用户可见）：App 6 + DeviceCard 21 + PairingWizard 15 + ToolScopePanel 38 + main 1 + types.ts 15（`STAGE_LABELS` 10 / `STATE_LABELS` 5）≈ **96 处**；其中 `App.tsx:53` 的 `'EventSource is unavailable in this environment'` 是**当前唯一以英文出现在中文界面上的**用户可见串 | 侦察报告 A 节 |
| F16 | 测试**直接 import `ui/src/*` 源码**（不经 `lib/client.js`），约 140 处断言中文文本；最大面积的破坏点是"直接 render、不传 props"的挂载点——若组件把 `t` 做成必填 prop 会全线 TypeError | `tests/unit/ui.test.ts:196-202` 等；侦察报告 B 节 |
| F17 | 两处契约断言钉住服务面：`tests/unit/ui.test.ts:774` 与 `tests/integration/clientBundle.test.ts:317` 都断言 `inject === ['slots']`；`ui.test.ts:800` 在**无 locale 的 fake ctx** 下断言 `label()` 返回「Cherry Studio 互联」 | 同上 |

**由 F10–F12 得出的设计硬约束（替换先前 F9 的粗判断）**：
1. **禁止**把 `locale` 写进 `exports.inject`（代价是整个 GUI 起不来）。
2. **`locale: NS` 只能在确认 locale face 在场时写**（否则 SlotAssemblyError 会冒到 entry 外）——而"face 在场"可由 F11 的 `ctx.get('locale')` 探知。
3. 组件**必须**在没有任何注入 props 时仍能独立渲染（F16）——这条与"老宿主降级"是同一个要求，因此组件自持 `t` 是硬需求而非风格选择。

---

## 四之三、PP-01 方案选择结论（2026-10-16）

呈现了三个替代方案（A 只借宿主 `t` 座席 / B 自持字典 + 宿主可选接入 / C 只看浏览器语言），并附侦察报告的两条硬证据（F10：声明 `inject: ['locale']` 会让缺该 provider 的宿主**整个 Web GUI 启动失败**；F12：注册项写 `locale: NS` 而 face 缺席时抛 `SlotAssemblyError` 且不被 entry 边界吞）。

**用户选择**：**方案 B**（确认「确认方案 B（推荐）」）。

**理由（我的推荐，用户采纳）**：B 是唯一同时满足「随宿主语言切换」（Q1 的动机）与「无 locale 服务的宿主上页面照常可用」（B1 兼容性底线）的方案；且因 F16（测试直接 render 组件、不传 props），"组件自持 `t`" 本身已是硬需求。

**排除理由（记录在案）**：
- 方案 A：为拿 `ctx.locale` 必须声明 `inject: ['locale']` ⇒ 命中 F10，代价是整个 GUI 起不来；只借 `t` 座席则无法驱动切换与自持回退。
- 方案 C：与宿主设置脱节，宿主内切换语言页面不跟随，直接违背 Q1。

**方案 B 的最终形状（已由 F10/F12/F16 修正）**：
1. `ui/src/i18n.ts` 自持 `zh`/`en` 字典 + `t` 实现，作为唯一真相源；组件在没有任何注入 props 时以 zh 正常渲染。
2. `ctx.get('locale')` **可选**查找宿主服务：在场 ⇒ 取其 active locale 作为语言源、订阅变化驱动重渲染，并注册同一份字典到 `cherry-remote` 命名空间；缺席 ⇒ 按 `navigator.language` 判定、最终回退 zh。
3. 注册项的 `locale: NS` **仅当探到 face 在场时才写**（F12）。
4. `export const inject` **保持 `['slots']` 不变**（F10；同时保住 F17 的两条契约断言）。
5. `locale/{en,zh}.json`（结构 `{"meta":{...}}`）+ `package.json` 的 `exports`/`files` 放行，负责插件列表元数据。

---

## 四之四、PP-02 审批与收口范围（2026-10-16）

### PP-02 整体审批：已通过

- 五段设计（**架构 / 数据流 / 接口 / 错误处理 / 测试策略**）逐段审批**全部通过**（PP-02 第一实例）。
- builder 预审 3 问的处置：**1 处文档矛盾已修**、**2 项由主 Agent 自裁**、**1 项升级用户裁决**。
- **整体审批于 2026-10-16 获用户「批准」**（PP-02 第二实例）⇒ 设计文档进入可实施状态。

### 收口范围（用户裁决）

- **纯单测收口 + `docs/e2e-checklist.md` 新增一节**操作者验收步骤；**不做真机执行**。用户选择原话：「纯单测收口 + checklist 加节（推荐）」。
- **真机执行留到发布前**，本次交付只到"清单有步骤"为止。
- 设计文档 §8.4「用户已确认的收口范围」即指本条；该项在 Gate 0 审查中被登记为可追溯性缺口（M25），在此补记消除。

### Gate 0 结构性修订（用户批准）

- **M10**：Gate 0 审查发现"**向宿主注册字典** + **注册项写 `locale: NS`**"这套机制**全文无消费方**（组件自持 `t`、导航标签走我方 store，宿主字典与 `t` 座席均无读取者），却只有失败面——`SlotAssemblyError` 冒出 entry 边界、以及"重复注册同 ns+locale 抛错"。
- **用户 2026-10-16 批准删除**该机制（合并表 M10，disposition=user_adjudicated）。
- ⇒ **本节「四之三」第 2、3 点的对应叙述已被取代**：不再向 `cherry-remote` 命名空间注册字典，注册项也不写 `locale: NS`。**以设计文档 §4.3 / §6.2 现行为准**（宿主接口收窄为 `{ getLocale, subscribe }`，本地 `LocaleService` 不再声明 `register`）。
- 本节保留原文以存留决策轨迹；**Gate 1 对齐审查遇 DRIFT 时以设计文档为准，并回溯到本条裁决**。

---

## 五、待设计阶段决定的开放项（不阻塞澄清）

1. 字典的组织形式：单一 `ui/src/locales.ts` 导出 `{en, zh}` 两套对象，还是按组件分文件。
2. 组件取文案的通道：依赖框架注入的 `t`（B5）还是自建 `createT` 经 props 传递（影响可测试性与降级路径）。
3. 既有测试中钉住中文字面量的断言如何改造：改为断言 key、还是断言中文渲染结果（影响回归强度）。倾向后者——断言用户实际看到的文本，且新增英文渲染断言。
4. 英文文案的取舍与术语表（我先出对照表给用户过目再铺开）。
