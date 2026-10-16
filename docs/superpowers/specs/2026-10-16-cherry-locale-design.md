# cherry-locale — 插件配置页中英双语适配 设计文档

- 任务名：`cherry-locale`（Phase 1-4 沿用）
- 需求真相源：`docs/superpowers/clarifications/cherry-locale.md`（下称「澄清文档」）
- 模式：中等（4-19 文件）
- 日期：2026-10-16
- 状态：五段设计已经用户逐段审批（PP-02 第一实例），待整体审批（PP-02 第二实例）

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
- **服务端诊断/告警/降级文案不翻译**（`src/` 的 63 条非注释中文串，其中一部分经 HTTP 到达界面）。用户裁决原话：「告警等先不管」。因此英文界面在降级路径下会中英混排。
- **HTTP API 契约不改**（不引入 `Accept-Language`、不把 reason 改成错误码）。
- **README / `docs/e2e-checklist.md` 等文档不翻译**。用户裁决原话：「readme后续单独处理」。
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
| **F12** | 渲染器对注册项里的 `locale: NS` 有硬要求：locale face 缺席时抛 `SlotAssemblyError`，且 `SlotErrorBoundary` 对该错误**显式重抛**，不被 entry 边界吞掉 | `locale: NS` **只在探到服务在场时才写** |
| **F16** | 测试**直接 import `ui/src/*` 源码**渲染组件、不传任何 props；约 140 处断言中文文本 | 组件**必须**在无任何注入 props 时以中文正常渲染；`props` 面不得新增必填字段 |
| **F17** | `tests/unit/ui.test.ts:774` 与 `tests/integration/clientBundle.test.ts:317` 断言 `inject === ['slots']`；`ui.test.ts:800` 在**无 locale 的 fake ctx** 下断言 `label()` 返回中文 | `inject` 不改 ⇒ 两条契约断言保持原样通过，本身就是"我们没声明 locale"的证据 |
| **F5/F13** | 宿主 `ctx.locale` 的能力：`register(ns, locale, dict)`（**重复注册同 ns+locale 会抛**）、`bind(ns)→t`、`getLocale()`、`subscribe()`；`t` 的 key 是**命名空间内**的 key，miss 后回落 `common`，再 miss **原样返回 key** | 我们自己的 `t` 采用**同样的 miss 语义**（返回 key），行为可预期且便于发现漏配 |
| **F15** | 用户可见文案约 **96 处**（App 6 / DeviceCard 21 / PairingWizard 15 / ToolScopePanel 38 / main 1 / types.ts 15）；其中 `App.tsx:53` 的 `EventSource is unavailable in this environment` 是当前**唯一以英文出现在中文界面上**的用户可见串 | 字典规模已知；这条英文串一并收编 |
| **B3** | 宿主的 typed 注册形式**强制双语成对**（缺一边注册失败） | 我们自建同等的"键集 + 占位符 parity"测试（§8 ①）替代该强制 |

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
- `createTranslator(locale)` → `t(key, params?)`：替换 `{name}` 占位符；**miss 返回 key 本身**。
- `localeStore`：模块级外部 store，`getSnapshot()` / `subscribe()` / `setLocale()`；**模块加载时的默认语言是 `zh`，不读 `navigator`**（F16 要求；读 navigator 只发生在 `apply()` 的降级路径里）。
- `useT()`：`useSyncExternalStore(localeStore…)` → 绑定当前语言的 `t`。
- **不引入 React context**：模块级 store 一层就够，且"宿主改语言 → store 变更 → 已挂载组件重渲染"与生产行为一致，测试可用同一条链路驱动英文。

### 4.3 改动 `ui/src/main.tsx`

```
apply(ctx)
  └─ host = ctx.get?.('locale')，经 isLocaleService() 形状校验
       ├─ 在场：测出 active → localeStore.setLocale(active)
       │        + ctx.effect(() => host.subscribe(刷新 store))
       │        + ctx.effect(() => host.register('cherry-remote', { zh, en }))   // 同一份字典对象
       │        + 注册项带 locale: 'cherry-remote'
       └─ 缺席：localeStore.setLocale(resolveLocaleFromNavigator())
                // 注册项不带 locale（F12）
  label: () => t('app.title')        // 中文「Cherry Studio 互联」/ 英文「Cherry Studio Bridge」
```

- `export const inject` **保持 `['slots']`**（F10、F17）。

### 4.4 四个组件

- 只把中文字面量换成 `useT()(...)`。
- **`props` 面一个字段都不加**（F16）。`App` 现有的三个可选 prop、`DeviceCard` 的四个必填 prop 等全部不动。
- 组件不需要知道宿主、语言或 store 的存在。

### 4.5 `types.ts` 的两个标签表

`STAGE_LABELS`（10 条）与 `STATE_LABELS`（5 条）目前是模块级中文常量。改为**按 key 取值**：保留导出名（测试在比较它们），但其值改为「key 字符串」或改由 `t()` 解析——具体形态留给实现者，约束是：**`ui.test.ts` 里 `findByText(STAGE_LABELS[stage]!)` 这类用法在 zh 下必须仍然成立**。

---

## 5. 数据流

### 5.1 语言来源（apply 时一次接线）

| 情形 | 语言来源 |
|---|---|
| 宿主有 locale 服务 | `host.getLocale().active`（宿主已把浏览器语言与用户显式选择解析好，我们只取用） |
| 宿主无 locale 服务 | `resolveLocaleFromNavigator(navigator.language)`：`zh*`→`zh`，其余→`en`，取不到 `navigator`→`zh` |

**已确认的行为变化**：缺 locale 服务的宿主上，英文浏览器会看到**英文**（今天是中文）。这是"面向外部用户"的必然结果，已获用户确认。

### 5.2 语言变化到界面的传播

```
宿主切语言 → locale/change → host.subscribe 回调
  → localeStore.setLocale(id) → 通知 useSyncExternalStore 订阅者
     → 已挂载组件重渲染（不刷新页面、不重挂载组件树）
导航标签：shell 自己订阅 locale revision 并重调 label() → label 内部读 store → 跟随
```

### 5.3 文案的三类形态如何落进字典

| 形态 | 处理 |
|---|---|
| 纯静态 | `t('device.port')` |
| 带插值 | **整句一个 key + 占位符**：`t('scope.revision', { revision })` → `当前 revision：{revision}` / `Revision: {revision}` |
| 被插值**切成前后两段**的长句（如 `ToolScopePanel.tsx:327`、`:202` 的三元） | 合并为**一个整句 key**，服务端 `reason` 作为参数注入 ⇒ 英文可自由重排语序，不出现"半句中文 + 半句英文" |
| 静态文本**夹 JSX 子元素**（`PairingWizard.tsx:150-153` 的 `<strong>二维码</strong>`） | 拆为前段/后段两个 key，`<strong>{t('wizard.qrCode')}</strong>` 夹在中间；**禁止 `dangerouslySetInnerHTML`** |
| 列表分隔符 | 进字典：`t('list.separator')`（zh `、` / en `, `），供 `saved.pruned.join(...)`；`aria-label` 的 `' '` 保持不变（两种语言都是空格，且被测试钉住） |

### 5.4 三条互不相通的文案通道（写下来防止以后有人试图合并）

1. **运行时界面**：`i18n.ts` 字典 → `localeStore` → 组件（我们全权控制）。
2. **插件列表元数据**：`locale/{en,zh}.json` → 宿主 **Node 侧** `readPluginMeta` → inventory API → 宿主客户端 `resolveText` 渲染。**不经过我们的 store**，纯文件驱动。
3. **服务端诊断/告警**：不经过任何本地化通道，原样中文（Q3 已排除）。

### 5.5 生命周期

注册字典与订阅都挂在 `ctx.effect(...)` 上，bundle 卸载即摘除——这同时规避了宿主"重复注册同一 ns+locale 会抛"的约束（重挂载时先摘后注册）。

---

## 6. 接口

### 6.1 `ui/src/i18n.ts` 导出面

```ts
export type LocaleId = 'zh' | 'en'
export type Dict = Record<string, string>
export type T = (key: string, params?: Record<string, string | number>) => string

export const NS = 'cherry-remote'            // 字典命名空间（main.tsx 继续 re-export SETTINGS_NAMESPACE）
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

### 6.2 宿主接口（本地结构类型 + 运行时形状校验）

```ts
export interface LocaleService {                       // 本地声明，不 import 宿主包
  getLocale(): { active: string }
  subscribe(listener: () => void): () => void
  register(ns: string, locale: string, dict: Dict): () => void
}
export interface ClientContext {
  slots?: SlotsService
  get?(name: string): unknown                          // 可选方法：测试 fake ctx 没有它
  effect?(callback: () => void | (() => void), label?: string): void
}
```

- **绝不写 `ctx.locale`**（撞 cordis 门禁）；只走 `ctx.get?.('locale')`，再用 `isLocaleService(value)`（三个方法都是函数）做形状校验，拿不准即按"缺席"处理。
- `active` 只接受 `'zh'`/`'en'`；其它值（含宿主未来新增语言）→ 回退 `resolveLocaleFromNavigator()`。

### 6.3 slot 注册面

本地 `SlotRegistration` 增加**可选** `locale?: string`，**仅当 face 在场时赋值**；`inject: () => ({})` 保持空对象；`label` 由常量改为 `() => t('app.title')`。

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
- `package.json`：`exports` 增加 `"./locale/en.json"`、`"./locale/zh.json"`（宿主按这两个精确 specifier 经 Node ESM 解析，缺了会被当成"不存在"静默回退）；`files` 增加 `"locale"`。
- **`dsh.client.inject` 保持 `[]` 不动**。

### 6.5 不动的接口

`src/` 的任何导出、HTTP API 契约、工具 schema、`dist/` 的公开类型——零改动。

---

## 7. 错误处理与回退

**总原则（由 F10 推出）**：**任何宿主侧调用的失败都必须降级为"没有本地化"，绝不允许异常冒出 `apply`。**

| 失败模式 | 处理 |
|---|---|
| `ctx.get` 不存在 | 按"服务缺席"走 |
| `ctx.get('locale')` 返回 `undefined` | 按缺席走 |
| 返回对象形状不对 | `isLocaleService()` 判否 ⇒ 按缺席走，**不抛** |
| `getLocale()` 抛 / 返回怪值 / `active` 非 zh/en | `try/catch` + 白名单 ⇒ 回退 navigator ⇒ 回退 `zh` |
| `register()` 抛（重复注册等） | `try/catch` + `console.warn` 后**继续**：组件用自持字典，界面不受影响 |
| `subscribe()` 抛 | `try/catch` + warn，退化为"不跟随切换"，页面仍可用 |
| `navigator` 不存在或取值异常 | `try/catch` ⇒ `zh` |
| 组件侧 `t('不存在的key')` | 返回 key 本身（可见但不崩） |
| 卸载时 disposer 抛 | 捕获 + warn，不让卸载失败 |

**假设（含残余风险）**：把"`ctx.get('locale')` 有值"当作"渲染器 locale face 已安装"的证据，因而 `locale: NS` 的写入门槛就是这个探针。依据：宿主那两个动作在**同一次同步 apply** 内先后完成（`ctx.provide('locale', …)` 紧跟 `ctx.slots.installLocale(locale)`，中间无 await），JS 单线程下不存在"服务已 provide 而 face 未装"的可观测窗口。**假设不成立时**的后果是 `SlotAssemblyError` 且不被 entry 边界吞；目前构造不出这种组合（两者由同一插件同一段代码安装），故列为残余风险。

---

## 8. 测试策略

### 8.1 新增测试文件

**① `tests/unit/i18n.test.ts`（纯逻辑，无 DOM）**
- 键集 parity：`Object.keys(zh)` 与 `Object.keys(en)` 完全相同
- **占位符 parity**：逐 key 提取 `{name}` 集合，zh 与 en 同名同数
- 无空串、无首尾空白
- `t` 行为：正常取值、插值替换、**缺 key 原样返回 key**、**缺参数保留 `{name}` 原样**
- `resolveLocaleFromNavigator`：`zh-CN→zh`、`en-US→en`、`fr→en`、`undefined→zh`
- `localeStore`：同值不通知、异值通知一次、`getSnapshot()` **引用稳定**、退订生效

**② `tests/unit/localeMeta.test.ts`（跨层一致性守卫）**
- `locale/{en,zh}.json` 结构合法、`meta.title`/`meta.description` 非空
- `meta.title` **逐字等于** `dictionaries[lang]['app.title']`
- 目录内无多余 `*.json`、文件名为合法语言 id
- `package.json` 的 `exports` 含那两个精确 specifier、`files` 含 `locale`
- **驱动宿主真实解析器（不是只断言结构）**：沿用 `clientBundle.test.ts` 直接 import 宿主已安装产物的先例，调用 `@deepseek-ai/dsh-app-boot` 的 `readPluginMeta(specifier, parentURL)` 一次，断言取回 `{title:{en,zh}, description:{en,zh}}` 且与字典一致。这把"exports/files 放行对不对、目录里每个 json 是否都能被解析"从结构断言升级为**真实路径断言**（宿主解析失败时会把插件行标成 meta 错误，只有真跑一遍才能发现）

**③ `tests/unit/i18nUsage.test.ts`（key 引用完整性）**
- 扫 `ui/src/*.tsx` 的 `t('…')` 字面量 ⇒ 全部存在于字典
- 反向：字典每个 key 至少被引用一次

**④ `tests/unit/localeWiring.test.ts`（宿主接线与降级）**
- **在场**：fake 服务（zh）⇒ 注册项带 `locale`、`register` 收到的字典与 `i18n.ts` 的 `zh` **引用相等**、`label()` 为中文；把 active 切到 `en` 并触发订阅 ⇒ **不重挂载**下 label 与组件文案变英文
- **缺席三态**：无 `get` / `get` 返回 `undefined` / 形状错误 ⇒ 都不抛、注册项不含 `locale`、页面照常渲染、语言来自 navigator（`en-US`→英、`zh-CN`→中）
- **宿主抛错三态**：`getLocale()` 抛 / `register()` 抛 / `subscribe()` 抛 ⇒ 异常不冒泡、有 warn、页面可用
- **卸载**：调用 disposer ⇒ 退订与字典摘除都被调用

**⑤ 英文渲染基线（4 条，一组件一条）**
- en 下渲染四个组件，断言关键文本为英文，并断言渲染出的 `textContent` **不含任何 CJK**
- fixture 的服务端 `reason` 在这些用例里换成英文标记串（reason 本是透传，不归我们管），把断言限定在我们能控制的部分

### 8.2 既有用例的改动面（3 处 `apply` 调用点）

`apply()` 会写模块级单例 `localeStore`，而 **jsdom 的 `navigator.language` 是 `en-US`** ⇒ 任何"调用 apply 但不提供 locale 宿主"的用例都会把全局语言置成 en，**污染同文件其后的中文断言**（模块级单例的跨用例污染是结构性的）。

已核实共有 3 处这样的调用点，全部按"补一个 zh locale 服务"处理。**不采用**"给 `i18n.ts` 加测试专用复位入口"：那会扩张 §6.1 的公共导出面，而给宿主建模本来就是这些用例该做的事。

| 调用点 | 处理 |
|---|---|
| `ui.test.ts:782` | fake ctx 补 zh locale 服务；顺带断言注册项带 `locale`、字典与 `i18n.ts` 引用相等 |
| `ui.test.ts:815` | 同上（该用例随后渲染 Section 并断言中文） |
| `uiScopePanel.test.ts:606` | 同上（其后的 ⑫⑬⑭ 仍断言中文） |
| `clientBundle.test.ts:328/:371/:379` | 该文件只断言信封 / `inject` / 注册面形状，不涉文本 ⇒ 无需改动；将来若出现文本断言，按同一规则处理 |

其余约 140 处中文断言**零改动**：模块默认语言是 `zh`，且**模块加载时不读 navigator**，只有 `apply()` 才嗅探。

`clientBundle.test.ts:317`（`inject === ['slots']`）**保持原样**——它正好证明我们没声明 `locale`；另加一条断言：该 fake ctx 下注册项不含 `locale`。

### 8.3 不测的

- 无法构造"有 locale 服务但渲染器 face 缺失"的宿主（见 §7 残余风险）。
- 不测服务端告警文案的英文（Q3 范围排除）。

### 8.4 收口条件

- `npm run typecheck` + `npm test` 全绿。
- **新增测试文件必须进 tsconfig 分区**：`tests/unit/projectCoverage.test.ts` 断言 `tests/**/*.test.ts` 恰好被一个 tsconfig 项目覆盖；带 jsdom/JSX 的用例要**同时**加进 `tsconfig.ui.json` 的 `include` 与 `tsconfig.json` 的 `exclude`，否则 `npm run typecheck` 直接红。
- `lib/client.js` 重建产物与源码进**同一个 commit**（本仓库 `artifactFreshness` 是字节比对，硬约束）。

---

## 9. 已知折中（显式声明，防止被当成缺陷）

1. **英文界面在降级/告警路径下会出现中文**——因为服务端 `reason`/告警文本按 Q3 保持中文。界面会中英混排。
2. **`Capability` 类技术 token 一律不译**：`cherry_*`、`tools.guard`、`tools.restrict`、`install`、`workspace-list`、`visibility-only`、`scope-version`、`path-normalization`、`scope-revision-conflict`、`expectedRevision`、`mode`/`global`/`selected`/`workspaceIds`、`revision`、`cwd`、`HTTP`、`DSH`、`ID`、`claim `、`EventSource`、`.corrupt`、产品名 `Cherry Studio` / `DeepSeek Harness`。
3. **插件列表元数据与运行时字典是两份物理拷贝**（前者必须是文件，后者必须在 bundle 里），由 §8.1② 的测试焊死一致性，而非构建期生成。
4. **首次进入的默认语言**在缺 locale 服务的宿主上由 `navigator` 决定（英文浏览器→英文），不再一律中文。

---

## 10. 残余风险

| # | 风险 | 影响 | 现状 |
|---|---|---|---|
| R1 | §7 的"探到服务 ⇒ face 已在场"假设 | 若被打破：`SlotAssemblyError` 冒到 entry 外 | 构造不出该组合；列为假设 |
| R2 | 第三方/极简宿主组合完全不含 locale 插件 | 走降级路径（英文由 navigator 决定） | 已按 §7 设计并测试 |
| R3 | 宿主未来新增第三语言 | `active` 白名单拦截 ⇒ 回退 navigator | 已设计；无法预知宿主语言集 |
| R4 | `useT()` 的 store 是模块级单例 | 同页面多处挂载共享同一语言 | 与宿主模型一致，无需多实例 |

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
2. `STAGE_LABELS` / `STATE_LABELS` 的具体改造形态（见 §4.5 的约束）。
3. `useT()` 的内部实现（`useSyncExternalStore` 之外的做法只要满足"引用稳定 + 语言变化重渲染"）。
4. 英文文案的措辞微调（§11 已给术语与基调；措辞在基调内可优化）。
5. `i18nUsage.test.ts` 的扫描实现细节（正则或 TS AST 皆可）。
