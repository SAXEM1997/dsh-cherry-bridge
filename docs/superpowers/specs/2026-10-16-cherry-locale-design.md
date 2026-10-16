# cherry-locale — 插件配置页中英双语适配 设计文档

- 任务名：`cherry-locale`（Phase 1-4 沿用）
- 需求真相源：`docs/superpowers/clarifications/cherry-locale.md`（下称「澄清文档」）
- 模式：复杂（20-49 文件，运行时升级）
- 日期：2026-10-16
- 状态：五段设计已经用户逐段审批（PP-02 第一实例），**整体审批已通过**；Gate 0 审查通过（2026-10-16，用户终止出口）；Gate 2 审查通过（2026-10-16，用户终止出口，§8.1⑥/§8.4/§9 引用随计划评审做了三处澄清性修正）
- 变更文件面（共 **23** 个：新增 9 + 修改 13 + 构建产物 1）
  - 新增 9：`ui/src/i18n.ts`；`locale/en.json`、`locale/zh.json`；`tests/unit/i18n.test.ts`、`localeMeta.test.ts`、`i18nUsage.test.ts`、`localeWiring.test.ts`、`localeRender.test.ts`、`i18nAssets.test.ts`
  - 修改 13：`ui/src/{App,DeviceCard,PairingWizard,ToolScopePanel}.tsx`（4）、`ui/src/types.ts`、`ui/src/main.tsx`、`package.json`、`tsconfig.json`、`tsconfig.ui.json`、`tests/unit/ui.test.ts`、`tests/unit/uiScopePanel.test.ts`、`tests/integration/clientBundle.test.ts`、`docs/e2e-checklist.md`
  - 构建产物 1：`lib/client.js`（`vite build:client` 重建，与源码同一 commit）

---

## 1. 概述：意图与为什么

`dsh-cherry-bridge` 是一个要发布到 GitHub、给外部用户安装的 DSH 插件。它的设置页（`settings.section` 里的「Cherry Studio 互联」）目前**全部文案硬编码中文**，而插件在插件列表里的标题/描述又**只有英文**——两种语言环境都不完整。

本次改造让这页在**中英两种语言环境下都完整可用**：跟随宿主的语言设置，并在宿主不具备本地化能力时安全降级。

为什么现在做：用户明确「后续需要发布到 github，需要兼容性适配」——英文不是点缀，是面向外部用户的一等公民；同时"兼容性"必须包含"在版本不确定的宿主上不因本地化而损坏"。后者不是空话：本设计的第一条硬约束就是**做错这一步会让整个 Web GUI 起不来**（见 §3 F10）。

---

## 2. 目标 / 非目标 / 反目标

### 目标
1. 设置页**全部正常路径文案**随宿主语言在中文/英文之间切换，切换后**无需刷新**即时生效。
2. 插件在**插件列表**里的标题与描述也随语言切换（当前是中文界面显示英文描述，方向正好反了）。
3. 在**不具备 locale 服务的宿主**上，插件行为安全：页面照常注册与渲染，绝不因本地化引入的依赖或选项而使宿主启动失败。
4. 中英两份字典**结构性对齐**（键集与占位符一一对应），并由测试持续保证。
5. 现有测试的既有断言尽量不动——只在"行为确实变了"的地方改，并补上覆盖新行为的用例。

### 非目标（本次不做）
- **服务端诊断/告警/降级文案不翻译**（`src/` 的 63 条非注释中文串，其中一部分经 HTTP 到达界面）。用户裁决原话：「告警等先不管」。因此英文界面会出现中英混排（到达面见 §9 第 1 项）。
- **HTTP API 契约不改**（不引入 `Accept-Language`、不把 reason 改成错误码）。
- **既有文档不翻译**（README / `docs/e2e-checklist.md` 的**既有内容**照旧，用户裁决原话：「readme后续单独处理」）；**但 `docs/e2e-checklist.md` 需新增一节**操作者验收步骤（见 §8.4 交付物）——这是交付物，不是翻译。
- **不新增插件自己的语言切换入口**。语言选择属于宿主 General 设置里的「语言」行，由宿主的 locale 插件拥有。
- **14 个 `cherry_*` 工具的描述与 schema 不动**——它们本来就是英文（`src/tools.ts` 全英文，`src/rpc/**` 零中文）。

### 反目标（即使"技术上能用"也算失败）
- 让插件的服务依赖里多出 `locale`，从而在缺该服务的宿主上把整个 Web GUI 拖垮（见 §3 F10）。
- 让组件在没有宿主注入的情况下无法独立渲染——这会同时毁掉"老宿主降级"与"现有单测直渲"两条路径（见 §3 F16）。
- 用 `dangerouslySetInnerHTML` 拼接含 JSX 的句子，或把长句按中文语序切成前后两段硬拼——那样英文语序永远调不对。
- 交付一份"英文键值随手写写"的字典：占位符不齐、键集不等、漏翻。这类缺陷只会在用户那里暴露，故用测试在本地消灭（§8）。

---

## 3. 约束：来自实测的硬事实

> 这些不是偏好，是宿主产物里读出来的机制。违背其中任何一条都会产生明确后果，故列为约束。完整证据见澄清文档 §一 与 §四之二。

| # | 事实 | 对本设计的约束 |
|---|---|---|
| **F10** | 把 `locale` 写进 bundle 的 `exports.inject` 是 cordis 的**必需依赖门控**：宿主缺该 provider 时 fiber 停在 `pending`，而 Web 外壳的 boot 审计发现任何非 active entry 就 `throw` ⇒ **整个 Web GUI 启动失败**（不是"设置页消失"） | `export const inject` **必须保持 `['slots']`**；宿主 locale 只能经 `ctx.get('locale')` **可选查找**取得 |
| **F12** | 渲染器对注册项里的 `locale: NS` 有硬要求：locale face 缺席时抛 `SlotAssemblyError`，且 `SlotErrorBoundary` 对该错误**显式重抛**，不被 entry 边界吞掉 | 本设计**不写** `locale` 字段（§4.3 不向宿主注册字典）；该事实约束的是**未来若重启该机制**的情形 |
| **F16** | 测试**直接 import `ui/src/*` 源码**渲染组件、不传任何 props；约 140 处断言中文文本 | 组件**必须**在无任何注入 props 时以中文正常渲染；`props` 面不得新增必填字段 |
| **F17** | `tests/unit/ui.test.ts:774` 与 `tests/integration/clientBundle.test.ts:317` 断言 `inject === ['slots']`；`ui.test.ts:800` 在**无 locale 的 fake ctx** 下断言 `label()` 返回中文 | `inject` 不改 ⇒ 两条契约断言保持原样通过，本身就是"我们没声明 locale"的证据。**证据承接**：`:800` 那条随 §8.2 的 `ui.test.ts:782/:815`、`uiScopePanel.test.ts:606` 改造而**被取代**，覆盖由 §8.1④ 缺席三态用例 + `clientBundle.test.ts:371/:379` 承接 |
| **F5/F13** | 宿主 `ctx.locale` 的能力：`register(ns, dicts)` 接受**成对形态** `register(ns, { zh, en })`（另支持单语言三参形态 `register(ns, locale, dict)`；**重复注册同 ns+locale 会抛**）、`bind(ns)→t`、`getLocale()`、`subscribe()`；`t` 的 key 是**命名空间内**的 key，miss 后回落 `common`，再 miss **原样返回 key** | 我们自己的 `t` 采用**同样的 miss 语义**（返回 key），行为可预期且便于发现漏配 |
| **F15** | 用户可见文案约 **96 处**（App 6 / DeviceCard 21 / PairingWizard 15 / ToolScopePanel 38 / main 1 / types.ts 15）；其中 `App.tsx:53` 的 `EventSource is unavailable in this environment` 是当前**唯一以英文出现在中文界面上**的用户可见串 | 字典规模已知；这条英文串一并收编 |
| **B3** | 宿主的 typed 注册形式**强制双语成对**（缺一边注册失败） | 我们自建同等的"键集 + 占位符 parity"测试（§8.1①）替代该强制 |

---

## 4. 架构

### 4.1 模块划分与依赖方向

```
ui/src/i18n.ts        纯 TS：字典 + t + store（唯一真相源）
      ↑
ui/src/{App,DeviceCard,PairingWizard,ToolScopePanel,types}.tsx
      ↑  （useT()）
ui/src/main.tsx       宿主接线：唯一接触 ctx 的地方
      ↑
lib/client.js         构建产物（vite build:client）

locale/{en,zh}.json   宿主 Node 侧读取的插件列表元数据（不经 store）
```

- 依赖单向向上，`i18n.ts` 不认识 React 以外的任何东西，更不认识宿主。
- `src/`（服务端）**完全不参与**本次改造。

### 4.2 新增 `ui/src/i18n.ts`

- `zh` / `en` 两份**扁平点分 key** 字典（`app.title`、`device.port`、`wizard.stage.claim`、`scope.mode.global`…）。
- `createTranslator(locale)` → `t(key, params?)`：替换 `{name}` 占位符；**缺 key 返回 key 本身**；**未知/缺失的占位符原样保留**（`params` 里没有 `{name}` 时就输出字面 `{name}`，与宿主 `translate` 的 `/\{(\w+)\}/g` 替换规则一致，见 §8.1①）。
- `localeStore`：模块级外部 store，`getSnapshot()` / `subscribe()` / `setLocale()`；**模块加载时的默认语言是 `zh`，不读 `navigator`**（F16 要求；读 navigator 只发生在 `apply()` 的降级路径里）。
- `useT()`：`useSyncExternalStore(localeStore…)` → 绑定当前语言的 `t`。
- **不引入 React context**：模块级 store 一层就够，且"宿主改语言 → store 变更 → 已挂载组件重渲染"与生产行为一致，测试可用同一条链路驱动英文。

### 4.3 改动 `ui/src/main.tsx`

```
apply(ctx)
  └─ fallback = resolveLocaleFromNavigator(守卫读取 navigator.language)   // §6.1 单点求值
  └─ host = ctx.get?.('locale')，经 isLocaleService() 形状校验
       ├─ 在场：测出 active → localeStore.setLocale(active)
       │        + ctx.effect(() => host.subscribe(刷新 store))
       │        + active 非 zh/en（白名单拦截）→ localeStore.setLocale(fallback)
       └─ 缺席：localeStore.setLocale(fallback)
  slots.inject 回调内：再探一次 ctx.get?.('locale')（此刻 boot 图谱已定型）
       └─ 探到且此前缺席：采纳并订阅（同 §4.3 在场分支，幂等，不重复订阅）
  label: () => t('app.title')        // 中文「Cherry Studio 互联」/ 英文「Cherry Studio Bridge」
```

- `export const inject` **保持 `['slots']`**（F10、F17）。
- **再探的依据是一条待核实假设**：boot graph 中 locale 行带 `immediately: true` 是侦察**实测观察**，但"该 flag ⇒ 该行先于共享批次激活"的**排序语义未证实**（`dsh-app-boot` 与 frontend dist 中均未找到证据）⇒ 本设计把它**按待核实假设处理、不作为保证**，只作为"再探值得一试"的理由；正确性不依赖它（再探探不到就按缺席降级，见 §10 R2）。
- **不向宿主注册字典、注册项也不带 `locale`**：宿主字典与 `t` 座席没有读取者（组件自持 `t`，导航标签走我方 store），故删除该机制，连带消除 F12 的 `SlotAssemblyError` 面与"重复注册抛错"面。

### 4.4 四个组件

- 只把中文字面量换成 `useT()(...)`。
- **`props` 面一个字段都不加**（F16）。`App` 现有的三个可选 prop、`DeviceCard` 的四个必填 prop 等全部不动。
- 组件不需要知道宿主、语言或 store 的存在。

### 4.5 `types.ts` 的两个标签表

`STAGE_LABELS`（10 条）与 `STATE_LABELS`（5 条）目前是模块级中文常量。**形态钉死如下**：

- **保留导出名，其值 = zh 字典的对应条目**（模块加载时自 `dictionaries.zh` 取得）。zh 字符串的**唯一来源在 `i18n.ts`**，本表只是它的再导出；zh 下与今天的字面量**逐字相同**，故 `ui.test.ts:391/:401/:406/:475` 的 `findByText(STAGE_LABELS[x])` **零改动**。
- **渲染侧改用新增 key 表** `STAGE_KEYS` / `STATE_KEYS`（值为 `wizard.stage.*` / `device.state.*` 形式的 key 字面量）+ `t()`；`types.ts` 里除这两张表外不再有中文字面量。
- **不得把标签表的值钉成 key 字符串**：那会打红上面四处断言，并违背 §8.2「约 140 处中文断言零改动」的承诺。
- 约束句保留：**`ui.test.ts` 里 `findByText(STAGE_LABELS[stage]!)` 这类用法在 zh 下必须仍然成立**。

---

## 5. 数据流

### 5.1 语言来源（apply 时一次接线）

| 情形 | 语言来源 |
|---|---|
| 宿主有 locale 服务 | `host.getLocale().active`（宿主已把浏览器语言与用户显式选择解析好，我们只取用） |
| 宿主无 locale 服务 | `resolveLocaleFromNavigator(读取守卫)`：**读取动作自带守卫** `typeof navigator === 'undefined' ? undefined : navigator.language`（**不裸读** `navigator.language`）；`zh*`→`zh`，其余→`en`，取不到→`zh` |

**已确认的行为变化**：缺 locale 服务的宿主上，英文浏览器会看到**英文**（今天是中文）。这是"面向外部用户"的必然结果，已获用户确认。

### 5.2 语言变化到界面的传播

```
宿主切语言 → locale/change → host.subscribe 回调
  → localeStore.setLocale(id) → 通知 useSyncExternalStore 订阅者
     → 已挂载组件重渲染（不刷新页面、不重挂载组件树）
```

**导航标签的跟随机制**：shell 的 `sections.getSnapshot()` 重算行时才解析 `resolveSlotLabel` 得到的 `label()`，结果**随 locale revision 缓存**（revision 变则行缓存失效重算）⇒ 「shell 订阅 locale revision」这一层成立。但**不能据此断言"我方 store 已更新"**：`react-dom@18.3.1` 的 `useSyncExternalStore` 监听器 `handleStoreChange` 会在监听器循环内**同步**调用 `checkIfSnapshotChanged` → `getSnapshot()`（`react-dom.development.js:16126-16150`），因此 shell 的行缓存重算（含 `label()` 解析）**可能先于我方监听器执行**；结果取决于我方 `host.subscribe` 监听器与 shell 监听器的**插入序**（sidebar 甚至把重解析直接挂在自己的 locale 监听器里同步做）。插入序是可观测前提，不能当作保证。

**缓解（设计决策）**：**`label()` 在宿主在场时直接读宿主 `getLocale().active` 解析文案**——宿主 snapshot 在监听器循环**开始之前**就已推进，与监听器插入序无关；无宿主时回退读我方 store（无宿主则语言在运行期不变，时序无关）。

### 5.3 文案的形态如何落进字典

| 形态 | 处理 |
|---|---|
| 纯静态 | `t('device.port')` |
| 带插值 | **整句一个 key + 占位符**：`t('scope.revision', { revision })` → `当前 revision：{revision}` / `Revision: {revision}` |
| 被插值**切成前后两段**的长句（如 `ToolScopePanel.tsx:327`；以及 `:274`/`:275` 的模板串、`:462-464` 的模板 + `join`） | 合并为**一个整句 key**，服务端 `reason` 作为参数注入 ⇒ 英文可自由重排语序，不出现"半句中文 + 半句英文" |
| 静态文本**夹 JSX 子元素**（`PairingWizard.tsx:150-153` 的 `<strong>二维码</strong>`） | 拆为前段/后段两个 key，`<strong>{t('wizard.qrCode')}</strong>` 夹在中间（Gate 3 勘误：实建为 `wizard.hint.{before,qrCode,after}` 三个 key）；**禁止 `dangerouslySetInnerHTML`** |
| 列表分隔符 | 进字典：`t('list.separator')`（zh `、` / en `, `），供 `saved.pruned.join(...)`；`aria-label` 的 `' '` 保持不变（两种语言都是空格，且被测试钉住） |
| **标签＋原因**的整句（如 `ToolScopePanel.tsx:355` 的全角 `：`） | 该全角冒号是**静态文案**、不是插值数据 ⇒ 整行改为**整句模板** `t('scope.degradedLine', { label, reason })`（`label` = 已翻译的降级标签，`reason` = 服务端原文透传）；**不得**在代码里硬编码 `"："`，否则会漏进英文界面 |

#### 不可本地化清单（数据面 / 技术面，**不进字典**）

| 项 | 实例 | 理由 |
|---|---|---|
| 数据面分隔符 | `DeviceCard` 的 `hosts.join(', ')` 与 `parseHosts` 的 `split(',')` | 它是**数据格式**不是文案：本地化成 `、` 会直接破坏解析（`parseHosts` 固定 `split(',')`）；且该行为被 `ui.test.ts:653/662/663` 钉住 |
| `data-*` 属性取值 | 如 `data-*` 上的状态/模式字符串 | 被测试与 CSS/宿主读取，属技术面标识 |
| 元素 `id` | 各处 `id=` | 被 `aria-*`、测试查询与宿主的锚点引用 |
| `aria-labelledby` 指向的 id | 同上 | 引用关系，改了就断链 |

**注**：`aria-label` 的**文本**（如空格串）仍按上表处理；上表只覆盖**取值即标识**的那些串。

### 5.4 三条互不相通的文案通道（写下来防止以后有人试图合并）

1. **运行时界面**：`i18n.ts` 字典 → `localeStore` → 组件（我们全权控制）。
2. **插件列表元数据**：`locale/{en,zh}.json` → 宿主 **Node 侧** `readPluginMeta` → inventory API → 宿主客户端 `resolveText` 渲染。**不经过我们的 store**，纯文件驱动。
3. **服务端返回的 `message`/`reason` 文本**：不经过任何本地化通道，原样中文（Q3 已排除；到达面见 §9 第 1 项）。

### 5.5 生命周期

语言订阅挂在 `ctx.effect(...)` 上，bundle 卸载即退订（若 §4.3 的再探在 `slots.inject` 回调里补订，同样登记 disposer 一并摘除）。**语言切换与卸载交叠**时无需额外处理：组件侧由 `useSyncExternalStore` 的订阅清理**结构性覆盖**（组件卸载即退订，迟到的通知不触达已卸载组件，不会触发对已卸载组件的重渲染）；我方对**宿主**的退订同样挂在 `ctx.effect` 的清理里。

---

## 6. 接口

### 6.1 `ui/src/i18n.ts` 导出面

```ts
export type LocaleId = 'zh' | 'en'
export type Dict = Record<string, string>
export type T = (key: string, params?: Record<string, string | number>) => string

export const LOCALE_IDS: readonly LocaleId[]
export const dictionaries: Record<LocaleId, Dict>

export function createTranslator(locale: LocaleId): T
export function resolveLocaleFromNavigator(language?: string): LocaleId
export const localeStore: {
  getSnapshot(): { locale: LocaleId }        // 引用稳定
  subscribe(listener: () => void): () => void
  setLocale(locale: LocaleId): void          // 同值不通知
}
export function useT(): T
```

**key 规约**：扁平点分、按域前缀（`app.` / `device.` / `wizard.` / `scope.` / `list.`）；占位符一律 `{name}`，两种语言必须同名同数；key 自身不含任何自然语言。

**`t` 的占位符契约**：替换规则为全局 `{name}` 匹配；`params` 未提供的占位符**原样保留**（输出字面 `{name}`），**不抛错、不置空**——与宿主 `translate` 的 `/\{(\w+)\}/g` 规则一致（§8.1① 断言该行为）。

**`resolveLocaleFromNavigator` 的边界**：匹配**大小写不敏感**（与宿主侧一致）；**`zh*` 前缀（大小写不敏感）⇒ `zh`**（`zh`、`ZH`、`zh-CN` 皆是）；**其余 ⇒ `en`**（含 `en*` 与一切未识别语言）；**空串与 `undefined` ⇒ `zh`**。

**navigator 读取守卫**：`resolveLocaleFromNavigator` 的**调用只发生在 `apply()` 内**，且是**单点守卫**——在 `apply` 开头求值一次 `const fallback = resolveLocaleFromNavigator(typeof navigator === 'undefined' ? undefined : navigator.language)`，**缺席分支**与**"active 白名单拦截"分支共用同一结果**（不散落、不重复读取）；函数本体对 `undefined` 入参返回 `zh`。**VM 沙箱上下文里没有 `navigator`**（`clientBundle.test.ts` 的 `createContext({ window, document, console })` 只显式传入这三者，连 `console` 都要传）——裸读会抛 `ReferenceError`，而该路径**恰好**由 `clientBundle.test.ts:371/:379` 覆盖。

### 6.2 宿主接口（本地结构类型 + 运行时形状校验）

```ts
export interface LocaleService {                       // 本地声明，不 import 宿主包
  getLocale(): { active: string }
  subscribe(listener: () => void): () => void
}
export interface ClientContext {
  slots?: SlotsService
  get?(name: string): unknown                          // 可选方法：测试 fake ctx 没有它
  effect?(callback: () => void | (() => void), label?: string): void
}
```

- **绝不写 `ctx.locale`**（撞 cordis 门禁）；只走 `ctx.get?.('locale')`，再用 `isLocaleService(value)`（两个方法都是函数）做形状校验，拿不准即按"缺席"处理。
- `active` 只接受 `'zh'`/`'en'`；其它值（含宿主未来新增语言）→ 采用 **`apply` 开头求值的 navigator 判定结果**（经 §6.1 的同一守卫入口），navigator 也取不到 ⇒ `zh`。

### 6.3 slot 注册面

`inject: () => ({})` 保持空对象；`label` 由常量改为 `() => t('app.title')`（文案解析读宿主 `getLocale().active`，无宿主则读我方 store，见 §5.2）；注册项**不带** `locale` 字段（不注册宿主字典，见 §4.3）。

### 6.4 `locale/*.json`（宿主读的文件接口）

```json
// locale/en.json                        // locale/zh.json
{ "meta": {                              { "meta": {
  "title": "Cherry Studio Bridge",        "title": "Cherry Studio 互联",
  "description": "<英文一句话>"             "description": "<中文一句话>"
} }                                      } }
```

- 文件结构是 **`{"meta":{...}}`**（键在 `meta` 下，不是平铺）。
- **`en.json` 的 `meta.title` 必须显式写**：宿主对 title 的兜底是 `package.json.name`（`dsh-cherry-bridge`），description 的兜底才是 `package.json.description`。
- `package.json`：`exports` 增加**通配**子路径 `"./locale/*.json"`（宿主探测到 `en.json` 后会**枚举目录内每个** `*.json` 并逐个解析；逐文件精确列举会在新增语言文件时静默失败——宿主把解析失败当"不存在"）；`files` 增加 `"locale"`。
- **`dsh.client.inject` 保持 `[]` 不动**。

### 6.5 不动的接口

`src/` 的任何导出、HTTP API 契约、工具 schema、`dist/` 的公开类型——零改动。

---

## 7. 错误处理与回退

**总原则（由 F10 推出）**：**任何宿主侧调用的失败都必须降级为"没有本地化"，绝不允许异常冒出 `apply`。**

| 失败模式 | 处理 |
|---|---|
| `ctx.get` 不存在 | 按"服务缺席"走 |
| `ctx.get('locale')` 返回 `undefined`（含宿主插件"已 provide 但未 active"时的探测落空） | 按缺席走。**时序风险**：若在 `apply` 时落空，本次会话的语言将退化为 navigator 判定（jsdom 外通常非用户所选），且**在本次会话内不可恢复**（宿主服务随后激活不会重放我们的 `apply`）——缓解见 §4.3 的 `slots.inject` 再探；再探仍未命中即接受降级（§10 R2） |
| 返回对象形状不对 | `isLocaleService()` 判否 ⇒ 按缺席走，**不抛** |
| `getLocale()` 抛 / 返回怪值 / `active` 非 zh/en | `try/catch` + 白名单拦截 ⇒ 采用 **§6.1 单点求值的 navigator 判定**（`en-US` 浏览器得 `en`）⇒ 再回退 `zh` |
| `subscribe()` 抛 | `try/catch` + warn，退化为"不跟随切换"，页面仍可用 |
| `navigator` 不存在或取值异常 | `try/catch` ⇒ `zh` |
| 组件侧 `t('不存在的key')` | 返回 key 本身（可见但不崩） |
| 卸载时 disposer 抛 | 捕获 + warn，不让卸载失败 |

---

## 8. 测试策略

### 8.1 新增测试文件

**① `tests/unit/i18n.test.ts`（纯逻辑，无 DOM）**
- 键集 parity：`Object.keys(zh)` 与 `Object.keys(en)` 完全相同
- **占位符 parity**：逐 key 提取 `{name}` 集合，zh 与 en 同名同数
- 无空串；**无首尾空白适用于除显式白名单外的所有 key**——白名单当前**仅 `list.separator` 一项**，其 en 值 `', '` **刻意**携带尾随空格（英文列表分隔符惯例，见 §5.3），zh 值 `、` 不受影响；白名单**写进测试用例**（逐项列出，新增白名单项需显式改测试）
- `t` 行为：正常取值、插值替换、**缺 key 原样返回 key**、**缺参数保留 `{name}` 原样**
- `resolveLocaleFromNavigator`：`zh-CN→zh`、`en-US→en`、`fr→en`、`undefined→zh`、**`ZH→zh`（大小写不敏感）**、**`''→zh`（空串）**
- `localeStore`：同值不通知、异值通知一次、`getSnapshot()` **引用稳定**、退订生效

**② `tests/unit/localeMeta.test.ts`（跨层一致性守卫）**
- `locale/{en,zh}.json` 结构合法、`meta.title`/`meta.description` 非空
- `meta.title` **逐字等于** `dictionaries[lang]['app.title']`（该文件也是 §6.4 **通配**导出的落点，断言按目录枚举而非硬编码两个 specifier）
- 目录内无多余 `*.json`、文件名为合法语言 id
- `package.json` 的 `exports` 含 `locale` 目录的**通配**子路径（`"./locale/*.json"`）、`files` 含 `locale`，且目录内**每个** `*.json` 都可被宿主解析（宿主探测到 `en.json` 后会枚举目录逐个解析，任一解析失败即把插件行标成 meta 错误）
- **驱动宿主真实解析器（不是只断言结构）**：沿用 `clientBundle.test.ts` 直接 import 宿主已安装产物的先例，调用 `@deepseek-ai/dsh-app-boot` 的 `readPluginMeta(specifier, parentURL)` 一次，断言取回 `{title:{en,zh}, description:{en,zh}}` 且与字典一致。这把"exports/files 放行对不对、目录里每个 json 是否都能被解析"从结构断言升级为**真实路径断言**（宿主解析失败时会把插件行标成 meta 错误，只有真跑一遍才能发现）
- **宿主产物的解析基址与缺席策略**：`specifier = 'dsh-cherry-bridge'`、`parentURL = import.meta.url`（以仓库内文件为基址可自引用解析）；宿主产物缺席时**参照 `clientBundle.test.ts:38-67` 的"绝对路径候选 + 带理由 skip"机制**（注意：该先例解析的是 `dsh-client-modules`，与本用例的 `dsh-app-boot` 是两个包、两种缺席语义——**候选路径表须独立给出**，实现细节见计划 Task 6）

**③ `tests/unit/i18nUsage.test.ts`（key 引用完整性）**
- 扫描范围 `ui/src/**/*.{ts,tsx}`；**判据 = 扫描到的 `t('…')` 字面量 ∪ `Object.values(STAGE_KEYS)` ∪ `Object.values(STATE_KEYS)`** ⇒ 全部存在于字典
- 反向：字典每个 key 至少被上述**并集**引用一次

**④ `tests/unit/localeWiring.test.ts`（宿主接线与降级）**
- **在场**：fake 服务（zh）⇒ 注册项不带 `locale`、`label()` 为中文；把 active 切到 `en` 并触发订阅 ⇒ **不重挂载**下 label 与组件文案变英文
- **标签时序**：模拟"标签按 locale revision 缓存重算、且 `label()` 在我方监听器之前被调用"（监听器循环内同步 `getSnapshot` 见 §5.2）⇒ 断言标签语言仍正确（宿主在场时 `label()` 直读宿主 `getLocale().active`）
- **缺席三态**：无 `get` / `get` 返回 `undefined` / 形状错误 ⇒ 都不抛、注册项不含 `locale`、页面照常渲染、语言来自 navigator（`en-US`→英、`zh-CN`→中）
- **白名单拦截**：`active='fr'` ⇒ 语言取 **navigator 判定**（`en-US` ⇒ 英文；`zh-CN` ⇒ 中文），navigator 缺失 ⇒ `zh`（与 §6.1/§6.2/§7 同一口径）
- **宿主抛错两态**：`getLocale()` 抛 / `subscribe()` 抛 ⇒ 异常不冒泡、有 warn、页面可用
- **再探**：`apply` 时缺席、`slots.inject` 回调时服务已在场 ⇒ 采纳该语言并订阅（不重复订阅）
- **卸载**：调用 disposer ⇒ 订阅被退订

**⑤ `tests/unit/localeRender.test.ts`（英文渲染基线，4 条，一组件一条）**
- en 下渲染四个组件，断言关键文本为英文，并断言**我方自有文案零中文**——判据**不是**全树 `textContent` 不含 CJK（那会误伤下面这些**非我方**文本源，它们在本用例 fixture 里换成英文标记串）：
  - 服务端返回的 message / `reason` / 降级注记（透传，Q3 已排除；到达面见 §9 第 1 项）
  - 注册表提供的工作区名与路径（数据面）
  - 透传的 `Error.message`
- **`afterEach` 用公开的 `localeStore.setLocale('zh')` 复位**，防 en 用例污染同文件/其后文件的中文断言；**不新增任何测试专用导出**

**⑥ `tests/unit/i18nAssets.test.ts`（源码级中文字面量守卫，TypeScript 编译器 API）**
- 用 TS 编译器 API 遍历 **`ui/src/**/*.{ts,tsx}` 全域**的**字符串字面量与 JSX 文本**，断言**无 CJK**
- **唯一例外 `i18n.ts`**（zh 字典的唯一来源，ui/src 全域唯一允许 CJK 的文件）；`types.ts` 经 §4.5 改造后表值取自 `dictionaries.zh`，同样不含中文字面量
- **扫描范围是全域而非具名清单**：具名名单 ≠ "全域唯一白名单"的意图——`api.ts`/`dev.tsx`/`vite-env.d.ts` 等灰区文件当前 CJK=0，但具名名单**不设防**，将来往它们里写中文不会被发现
- **动机**：⑤ 的渲染判据受 fixture 覆盖面限制（没渲染到的分支、从未进入字典的中文它看不见）；**源码级守卫才能抓住"从未进入字典的中文"**
- **解析入口的机制适配（Gate 3 勘误）**：本文档 §8.1⑥ 与计划 Task 5 提到的 `ts.createSourceFile` 在**实装的 typescript@7 上已不存在**（`'typescript'` 具名空间只剩 `lib/version.cjs`，无 `createSourceFile`）。守卫改用 `typescript/unstable/sync` 的 `API` 解析同一批节点类型（StringLiteral/NoSubstitutionTemplateLiteral/JsxText）；**语义不变**，仅解析入口随编译器版本适配（实测记录见 `tests/unit/i18nAssets.test.ts` 文件头）。

### 8.2 既有用例的改动面（全仓 6 处 `apply` 调用点）

`apply()` 会写模块级单例 `localeStore`，而 **jsdom 的 `navigator.language` 是 `en-US`** ⇒ 任何"调用 apply 但不提供 locale 宿主"的用例都会把全局语言置成 en，**污染同文件其后的中文断言**（模块级单例的跨用例污染是结构性的）。

已核实全仓 `apply` 调用点共 **6 处**，分两类：**UI 侧 3 处需适配**（`ui.test.ts:782`、`ui.test.ts:815`、`uiScopePanel.test.ts:606` ⇒ 补一个 zh locale 服务），**集成侧 3 处仅新增断言、不改行为**（`clientBundle.test.ts:328/:371/:379` ⇒ 该文件只断言信封 / `inject` / 注册面形状，不涉文本；新增的一条断言是该 fake ctx 下**注册项不含 `locale`**）。**不采用**"给 `i18n.ts` 加测试专用复位入口"：那会扩张 §6.1 的公共导出面，而给宿主建模本来就是这些用例该做的事。

| 调用点 | 处理 |
|---|---|
| `ui.test.ts:782` | **适配**：fake ctx 补 zh locale 服务；顺带断言注册项**不含** `locale` |
| `ui.test.ts:815` | **适配**：同上（该用例随后渲染 Section 并断言中文） |
| `uiScopePanel.test.ts:606` | **适配**：同上（其后的 ⑫⑬⑭ 仍断言中文） |
| `clientBundle.test.ts:328/:371/:379` | **不改行为，仅新增一条断言**：该 fake ctx 下注册项不含 `locale`；将来若出现文本断言，按同一规则处理 |

其余约 140 处中文断言**零改动**：模块默认语言是 `zh`，且**模块加载时不读 navigator**，只有 `apply()` 才嗅探。

`clientBundle.test.ts:317`（`inject === ['slots']`）**保持原样**——它正好证明我们没声明 `locale`；另加一条断言：该 fake ctx 下注册项不含 `locale`。

### 8.3 不测的

- 无法构造"宿主 locale 服务在场但**不可用**/异常"的宿主（见 §10 R1）。
- 不测服务端告警文案的英文（Q3 范围排除）。

### 8.4 收口条件

- `npm run typecheck` + `npm test` 全绿。
- **新增测试文件必须进 tsconfig 分区**（`tsconfig.ui.json` 的 include 与 `tsconfig.json` 的 exclude 都是**逐文件列举**，缺一个 `npm run typecheck` 直接红；`tests/unit/projectCoverage.test.ts` 断言 `tests/**/*.test.ts` 恰好被一个 tsconfig 项目覆盖）。**判据是"是否 import `ui/src/**`"，不是"是否 jsdom/JSX 渲染"**，论据三点：① `tsconfig.json` 的 `exclude` 含 `"ui"`，两项目的 include/exclude 集是对 `tests/**/*.test.ts` 的**划分**（"每文件恰检一次"），跨项目 import 会让同一份 `ui/src/**` 同时进两个 program、被两套互斥选项各检一次；② 全仓**零反例**——只有 `tests/unit/ui.test.ts` 与 `tests/unit/uiScopePanel.test.ts` import `ui/src/**`，两者都在 UI 分区（`clientBundle.test.ts` 虽在 UI 分区但不静态 import ui）；③ server 项目是 `moduleResolution: nodenext`，**相对 import 必须带 `.js` 后缀**，按 UI 侧自然风格（bundler、无后缀）写的 test 进 server 分区直接 **TS2835** 红。
  - **进 UI 分区**（import `ui/src/**`，须**同时**加进 `tsconfig.ui.json` 的 `include` 与 `tsconfig.json` 的 `exclude`）：`tests/unit/i18n.test.ts`、`tests/unit/localeWiring.test.ts`、`tests/unit/localeRender.test.ts`、`tests/unit/localeMeta.test.ts`、`tests/unit/i18nUsage.test.ts`
  - **由 server 项目默认覆盖**（不 import ui 模块，纯文本扫描 / 读文件 / TS 编译器 API）：`tests/unit/i18nAssets.test.ts`
- `lib/client.js` 重建产物与源码进**同一个 commit**（本仓库 `artifactFreshness` 是字节比对，硬约束）。
- **交付物包含 `docs/e2e-checklist.md` 新增一节**（用户已确认的收口范围）：放在「第二部分：真机主流程」中，紧随 F「工具启用范围（`/scope`）」之后，形如 `### G. 语言切换与降级`。验收步骤至少覆盖两点：
  1. 在宿主 General 设置里切换语言（中 ↔ 英），核对**导航标签 / 页面正文 / 插件列表的标题与描述**三处**无需刷新**跟随；
  2. 在英文界面下遇到服务端中文告警时，按 §9 的已知折中判定（**不算失败**），而不是记成缺陷。
  **第一部分（契约六项）不得改动**——`tests/contract/contract.test.ts` 的 ⑦ 钉住它。
  **真机执行留到发布前**，本次交付只到"清单有步骤"为止（用户选择）。

---

## 9. 已知折中（显式声明，防止被当成缺陷）

1. **英文界面会出现中文**——**任何服务端返回的 `message`/`reason` 文本**（**不限于降级/告警路径**：`api.ts` 透传的**普通拒绝**原因同样算，如保存失败、配对失败的具体原因）按 Q3 保持中文，可能在英文界面原样显示。界面会中英混排。
2. **`Capability` 类技术 token 一律不译**：`cherry_*`、`tools.guard`、`tools.restrict`、`install`、`workspace-list`、`visibility-only`、`scope-version`、`path-normalization`、`scope-revision-conflict`、`expectedRevision`、`mode`/`global`/`selected`/`workspaceIds`、`revision`、`cwd`、`HTTP`、`DSH`、`ID`、`claim`（配对流程的 claim 阶段标签，见 `STAGE_LABELS.claim`）、`EventSource`、`.corrupt`、产品名 `Cherry Studio` / `DeepSeek Harness`。
3. **插件列表元数据与运行时字典是两份物理拷贝**（前者必须是文件，后者必须在 bundle 里），由 §8.1② 的测试焊死一致性，而非构建期生成。
4. **首次进入的默认语言**在缺 locale 服务的宿主上由 `navigator` 决定（英文浏览器→英文），不再一律中文。
5. **插值数据不进字典**：文件路径、workspace 名、revision 数字、状态码/错误码等一律**按原样渲染**（它们不是文案，翻译会破坏可核对性；见澄清文档 B4）。

---

## 10. 残余风险

| # | 风险 | 影响 | 现状 |
|---|---|---|---|
| R1 | 探针**时序**：`apply` 时宿主 locale 插件"已 provide 但未 active"⇒ 探针落空；且"boot graph 中 locale 行带 `immediately: true` ⇒ 先于共享批次激活"**排序语义未证实**（侦察实测到该 flag，但语义未证实） | 语言退化为 navigator 判定，且**本次会话内不可恢复**（宿主服务随后激活不会重放 `apply`） | 已设计缓解：§4.3 `slots.inject` 回调内**再探**一次并订阅；未命中即接受降级（R2）。假设按"待核实"处理，不作为保证 |
| R2 | 第三方/极简宿主组合完全不含 locale 插件 | 走降级路径（英文由 navigator 决定） | 已按 §7 设计并测试 |
| R3 | 宿主未来新增第三语言 | `active` 白名单拦截 ⇒ 采用 §6.1 单点求值的 navigator 判定 ⇒ 再回退 `zh` | 已设计；无法预知宿主语言集 |
| R4 | `useT()` 的 store 是模块级单例 | 同页面多处挂载共享同一语言 | 与宿主模型一致，无需多实例 |
| R5 | 导航标签的语言跟随依赖**监听器插入序**：shell 的行缓存在监听器循环内**同步**重算，可能先于我方 store 更新（§5.2） | 理论上标签语言**滞后一次切换** | **已由 §5.2 缓解**：宿主在场时 `label()` 直读宿主 `getLocale().active`（与插入序无关），无宿主时运行期语言不变 ⇒ 残余风险≈0；登记以备将来重启该机制时复核 |

---

## 11. 术语与英文基调（决定项）

| 中文 | 英文 |
|---|---|
| Cherry Studio 互联 | Cherry Studio Bridge |
| 已配对设备 | Paired devices |
| 配对向导 / 配对信息 | Pairing wizard / Pairing payload |
| 设备名称 / 主机地址 / 端口 / 设备 ID | Device name / Host addresses / Port / Device ID |
| 地址维护 / 重命名 / 移除 / 确认移除 | Addresses / Rename / Remove / Confirm removal |
| 停用 / 启用 | Disable / Enable |
| 已连接 / 连接中 / 离线 / 已停用 / 身份不匹配 | Connected / Connecting / Offline / Disabled / Identity mismatch |
| 状态未知 | Unknown status |
| 启用范围 | Tool scope |
| 模式 / 全局 / 仅选定工作区 | Mode / Global / Selected workspaces only |
| 工作区 / 作用域文档 | workspace / scope document |
| 保存启用范围 / 重新读取 / 清除已失效选择 | Save scope / Reload / Clear stale selections |
| 已失效（工作区已删除） | Stale (workspace deleted) |
| 已勾选但会话 cwd 对不上 | Selected, but the session cwd doesn't match |
| 降级 / 只读告警 | degraded / read-only warning |
| 当前 revision | Current revision |
| 保存成功 | Saved. |
| 宿主 / 升级宿主 / DSH | host / upgrade the host / DSH（DSH 不译） |
| 注册表列表 | workspace registry list |
| 扫码 / 二维码 / 验证码 / 一次性邀请 | scan the QR code / QR code / verification code / one-time invite |
| 事件流 / 凭据 / 设备档案 | event stream / credentials / device records |

**基调**：简洁、直陈、第二人称祈使句；专有名词保留原拼写；错误信息说明**发生了什么**再说明**可以怎么做**，不用感叹号、不卖萌。英文句子里技术 token 用反引号或原样裸写皆可，但同一 key 内保持一致。

---

## 12. 留给实现者的余地（不必再回来问）

1. 字典是单文件还是按域拆文件（只要 `i18n.ts` 的导出面不变）。
2. `STAGE_LABELS` / `STATE_LABELS` 的改造形态**已钉死于 §4.5**，不再留有实现选择。
3. `useT()` 的内部实现（`useSyncExternalStore` 之外的做法只要满足"引用稳定 + 语言变化重渲染"）。
4. 英文文案的措辞微调（§11 已给术语与基调；措辞在基调内可优化）。
5. `i18nUsage.test.ts` 的扫描实现细节（正则或 TS AST 皆可）。
