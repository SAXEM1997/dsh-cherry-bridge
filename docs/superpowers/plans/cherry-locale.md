# cherry-locale 实现计划（插件配置页中英双语适配）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dsh-cherry-bridge 的设置页与插件列表元数据在中文/英文两种语言下完整可用，随宿主语言运行时切换，且在不具备 locale 服务的宿主上安全降级。

**Architecture:** 自持 `ui/src/i18n.ts`（zh/en 双字典 + `t` + 模块级 `localeStore` + `useT()`）为唯一真相源；`main.tsx` 用 `ctx.get?.('locale')` **可选**接入宿主语言源（单点 fallback、订阅、`slots.inject` 内再探），**不向宿主注册字典、注册项不写 `locale`**、`export const inject` 保持 `['slots']`；组件把字面量换成 `useT()(...)`，props 面零改动；`locale/{en,zh}.json` + package.json 通配导出负责插件列表元数据。

**Tech Stack:** TypeScript + React 18（`useSyncExternalStore`）+ Vite（client bundle）+ Vitest（jsdom）+ TypeScript 编译器 API（源码级守卫）。

**Spec:** `docs/superpowers/specs/2026-10-16-cherry-locale-design.md`（name-keyed 符号链接 `specs/cherry-locale-design.md` 指向它；本计划引用的 § 编号均指该文档）；需求真相源 `docs/superpowers/clarifications/cherry-locale.md`。

---

## Global Constraints

*每个 task 的要求都隐含本节（值逐字取自设计文档，冲突时以设计文档为准）：*

1. `ui/src/main.tsx` 的 `export const inject` **保持 `['slots']`**（F10：声明 `locale` 会让缺该 provider 的宿主整个 Web GUI 启动失败）。
2. **绝不直读 `ctx.locale`**（cordis 门禁会抛）；只走 `ctx.get?.('locale')` + `isLocaleService()` 形状校验（`getLocale`/`subscribe` 两个方法都是函数才算数），拿不准按"缺席"处理。
3. 注册项**不带 `locale` 字段**；不调用 `host.register`（M10 用户批准删除：无消费方，仅两条失败面）。
4. **组件 props 面零新增**：`App`/`DeviceCard`/`PairingWizard`/`ToolScopePanel` 的 props 接口一个字段不加（F16：既有测试直接 render 不传 props）。
5. `t` 契约：**缺 key 原样返回 key**；**`params` 未提供的 `{name}` 占位符原样保留**（不抛错、不置空）；与宿主 `translate` 的 `/\{(\w+)\}/g` 规则一致。
6. **navigator 单点守卫**：`resolveLocaleFromNavigator` 只在 `apply()` 内调用——开头求值一次 `const fallback = resolveLocaleFromNavigator(typeof navigator === 'undefined' ? undefined : navigator.language)`，**缺席分支与"active 白名单拦截"分支共用同一结果**；边界=大小写不敏感 `zh*` 前缀 ⇒ `zh`，其余 ⇒ `en`，空串与 `undefined` ⇒ `zh`。
7. **zh 字符串唯一来源是 `i18n.ts`**：`types.ts` 的 `STAGE_LABELS`/`STATE_LABELS` 值**逐字取自 `dictionaries.zh` 对应条目**（保证 zh 下与今天字面量逐字相同 ⇒ 约 140 处既有断言零改动）；渲染侧走 `STAGE_KEYS`/`STATE_KEYS`（key 字面量表）+ `t()`。
8. **技术 token 不译**（§9 第 2 项清单：`cherry_*`、`tools.guard`、`tools.restrict`、`install`、`workspace-list`、`visibility-only`、`scope-version`、`path-normalization`、`scope-revision-conflict`、`expectedRevision`、`mode`/`global`/`selected`/`workspaceIds`、`revision`、`cwd`、`HTTP`、`DSH`、`ID`、`claim`、`EventSource`、`.corrupt`、`Cherry Studio`、`DeepSeek Harness`）；**插值数据**（路径、workspace 名、revision 数字、状态码）原样渲染不进字典。
9. **不可本地化清单**（§5.3）：`DeviceCard` 的 `hosts.join(', ')` 与 `parseHosts` 的 `split(',')`（数据面，被 `ui.test.ts:653/662/663` 钉住）、`data-*` 取值、元素 id、`aria-labelledby` 指向的 id。
10. 文案形态规约（§5.3）：整句一个 key + `{name}` 占位符；被插值切段的长句合并为整句模板（服务端 reason 作参数）；`PairingWizard.tsx:150-153` 拆前段/后段两个 key 夹 `<strong>`；列表分隔符 key `list.separator`（zh `、` / en `', '`，**刻意带尾随空格**，是"无首尾空白"检查的唯一白名单项）；`ToolScopePanel.tsx:355` 改整句 `t('scope.degradedLine', { label, reason })`。
11. **产物同 commit**：凡改 `ui/src/**` 的 commit 必须携带 `npm run build:client` 重建的 `lib/client.js`（`artifactFreshness` 字节比对 `git show HEAD:` vs 重建）。
12. **测试分区**：判据是**是否 import `ui/src/**`**，不是"是否 jsdom/JSX"。凡 import `ui/src/**` 的新测试文件**必须进 UI 分区**——**同时**加进 `tsconfig.ui.json` 的 `include` 与 `tsconfig.json` 的 `exclude`（二者都是逐文件列举；`tests/unit/projectCoverage.test.ts` 断言每个 test 文件**恰好被一个项目覆盖**）。只有**不 import ui 模块**的纯文本扫描类测试（`i18nAssets`）走 server 项目默认覆盖，无需改 tsconfig。论据三点：① **分区不变量**：`tsconfig.json` 的 `exclude` 含 `"ui"`（两项目 include/exclude 集被证明是对 `tests/**/*.test.ts` 的划分），跨项目 import 会让同一份 `ui/src/**` 同时进两个 program、被两套互斥选项各检一次，违反"每文件恰检一次"；② **全仓零反例**：仅 `ui.test.ts`、`uiScopePanel.test.ts` 两个测试 import `ui/src/**`，两者都在 UI 分区（`clientBundle.test.ts` 虽在 UI 分区但不静态 import ui，走 `node:vm` 加载产物）；③ **nodenext 强制**：server 项目是 `moduleResolution: nodenext`，**相对 import 必须带 `.js` 后缀**，按 UI 侧自然风格（bundler、无后缀）写的 `from '../../ui/src/i18n'` 放进 server 分区直接 **TS2835** 红。**本计划的分区清单**：UI 分区 = `i18n` / `localeWiring` / `localeRender` / `localeMeta` / `i18nUsage` 五个；server 默认仅 `i18nAssets`。
13. `docs/e2e-checklist.md` **第一部分（契约六项）不得改动**（`tests/contract/contract.test.ts` ⑦ 钉住）；新节放第二部分 F 节之后。
14. 英文基调（§11）：简洁直陈、祈使句、术语按 §11 对照表；`app.title` 逐字 pinned：zh `Cherry Studio 互联` / en `Cherry Studio Bridge`。
15. 跑测试用本地 vitest（无网络依赖）：`npx vitest run <file>`；**不要**运行 `npm install`。

## Review Focus

*设计文档隐含但无任务测试直接覆盖、且最可能咬人的五类输入/失败模式（每行后的括号 = 钉住它的 task 与测试）：*

1. **宿主没有 locale 服务**（老/极简宿主）——apply 必须不抛、页面照常注册、语言走 navigator 回退（Task 2 `localeWiring` 缺席三态 + 既有 `clientBundle.test.ts:371` 的 `not.toThrow`）。
2. **运行时切语言**——宿主切 en 后已挂载组件与导航标签必须**不重挂载**跟随（Task 2 在场用例 + 标签时序用例：label 在我方监听器之前被调用仍正确）。
3. **双语字典失配**——en 漏 key / 漏占位符 / zh 值与今天字面量不逐字相同（Task 1 parity 三测 + 既有 `ui.test.ts` 全量；Task 5 `i18nUsage`）。
4. **漏翻**——中文字面量从未进字典（Task 5 `i18nAssets` TS 编译器 API 源码级扫描 + `localeRender` en 渲染基线）。
5. **误本地化数据面**——hosts 分隔符/`data-*`/id 被当文案翻译（Task 3 既有 `ui.test.ts:653/662/663` + Task 5 `i18nAssets` 仅扫字符串字面量与 JSX 文本）。

---

### Task 1: i18n 核心——字典、翻译器、语言源、store 与标签表改造

**Files:**
- Create: `ui/src/i18n.ts`
- Modify: `ui/src/types.ts`（仅标签表两处）
- Test: `tests/unit/i18n.test.ts`（import `ui/src/i18n.ts` ⇒ **UI 分区**，双 tsconfig 加名）
- **不触碰 `ui/src/main.tsx`**（边界钉死）：导航 label 的 `'Cherry Studio 互联'` 字面量由 **Task 2** 替换；本 task 完成后 bundle 内"新字典 + `main.tsx` 旧字面量"并存属**预期**，不是缺陷。

**Interfaces:**
- Produces（后续所有 task 依赖）：
  ```ts
  export type LocaleId = 'zh' | 'en'
  export type Dict = Record<string, string>
  export type T = (key: string, params?: Record<string, string | number>) => string
  export const LOCALE_IDS: readonly LocaleId[]
  export const dictionaries: Record<LocaleId, Dict>
  export function createTranslator(locale: LocaleId): T
  export function resolveLocaleFromNavigator(language?: string): LocaleId
  export const localeStore: {
    getSnapshot(): { locale: LocaleId }   // 引用稳定（同语言重复调用返回同一对象）
    subscribe(listener: () => void): () => void
    setLocale(locale: LocaleId): void     // 同值不通知
  }
  export function useT(): T               // useSyncExternalStore(localeStore)
  ```
- Produces（types.ts，导出名与 key 集不变）：`STAGE_KEYS: Record<string, string>`（**与既有 `STAGE_LABELS`（`types.ts:112`）同形、key 集相同**——全仓**没有** `PairingStage` 类型，写 `Record<PairingStage, string>` 必撞 TS2304，且与 Task 3 的 `?? 原值` 宽键控兜底矛盾）、`STATE_KEYS: Record<DeviceState, string>`（`STATE_LABELS`（`types.ts:239`）**已是 `Record<DeviceState, string>`**——`DeviceState` 在 `types.ts:17`——此处为**同形沿用**，非收紧；键集 = `Object.keys(STATE_LABELS)`）（key 字面量，命名 `wizard.stage.<stage>` / `device.state.<state>`）；`STAGE_LABELS`/`STATE_LABELS` 保留导出，**值 === `dictionaries.zh` 对应条目**。

- [ ] **Step 1: 写失败测试 `tests/unit/i18n.test.ts`**

  覆盖设计 §8.1① 全部断言：
  - 键集 parity：`Object.keys(zh)` 与 `Object.keys(en)` 逐字相同
  - 占位符 parity：逐 key 提取 `/\{(\w+)\}/g` 集合，两语言同名同数
  - 无空串；"无首尾空白"适用于**除白名单 `list.separator` 外**的所有 key（白名单逐项写进测试：en 值 `', '`、zh 值 `、`）
  - `t` 行为：`createTranslator('zh')('app.title')` === `'Cherry Studio 互联'`、`createTranslator('en')('app.title')` === `'Cherry Studio Bridge'`、插值替换、缺 key 原样返回 key、缺参数 `{name}` 原样保留
  - `resolveLocaleFromNavigator`：`zh-CN→zh`、`en-US→en`、`fr→en`、`undefined→zh`、`ZH→zh`（大小写不敏感）、`''→zh`
  - `localeStore`：模块默认语言 `zh`、同值 `setLocale` 不通知、异值通知一次、`getSnapshot()` 引用稳定、退订生效　→ **来源：设计 §4.2**（"模块加载时默认 `zh`、不读 navigator"，非 §8.1①）
  - 标签表：`STAGE_KEYS`/`STATE_KEYS` 的每个 value 都在字典里；`STAGE_LABELS` 每个值 === `dictionaries.zh[STAGE_KEYS[k]]`（STATE 同理）　→ **来源：设计 §4.5**（KEYS/LABELS 的对齐约定，非 §8.1①）
  - `tsconfig.ui.json` include 与 `tsconfig.json` exclude 同时加 `tests/unit/i18n.test.ts`（本文件 import `ui/src/i18n.ts` ⇒ 见 Global Constraint 12）

- [ ] **Step 2: 运行确认失败**

  Run: `npx vitest run tests/unit/i18n.test.ts`
  Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `ui/src/i18n.ts` 与 types.ts 标签表**

  - 字典构建：走查 `ui/src/{App,DeviceCard,PairingWizard,ToolScopePanel}.tsx`、`ui/src/types.ts` 的全部用户可见中文字符串（设计 §3 F15 计 96 处），按域前缀建 key（`app.` / `device.` / `wizard.` / `scope.` / `list.`）；zh 值**逐字拷贝现源码字符串**（不重打字）；en 值按 §11 术语表与基调新写；`App.tsx:53` 的英文串 `'EventSource is unavailable in this environment'` 收编为 key（zh 补中文）；含插值的句子按 Global Constraint 10 的形态规约。
  - pinned 值：`app.title` zh `Cherry Studio 互联` / en `Cherry Studio Bridge`；`app.eventSourceUnavailable` zh `此环境不支持 EventSource` / en `EventSource is unavailable in this environment`（原 `App.tsx:53` 英文串收编）。
  - `useT()` 用 `useSyncExternalStore(localeStore.subscribe, localeStore.getSnapshot)` → `createTranslator(snapshot.locale)`。
  - types.ts：新增两个 KEYS 表（key 字面量）；LABELS 表改为从 `dictionaries.zh` 取值（机制自选：逐项引用或小工具函数），**导出名与 key 集不变**。
  - **完成判据（字典完备的可执行定义）**：**Task 5 的 `i18nUsage` 正反向断言全绿 + `i18nAssets` 零 CJK**——两者同时成立即"字典完备"，无需在 Task 1 逐项枚举 96 处。
  - **Task 1 完成时自跑一次源码 CJK 预检**（提前暴露漏翻，不等 Task 5）：`grep -Pn '[\x{4e00}-\x{9fff}]' ui/src/App.tsx ui/src/DeviceCard.tsx ui/src/PairingWizard.tsx ui/src/ToolScopePanel.tsx ui/src/types.ts`，**人工过目**每一处命中——要么已进字典，要么属 Global Constraint 9 的不可本地化清单（数据面/id/`data-*`）。注意本 task 只保证"字典就位"，四组件与 types 的**消费点**仍在 Task 3/4 替换（预检只核对"每处中文都已进字典"，不要求此刻已无中文）。

- [ ] **Step 4: 运行确认通过（含既有测试不回归）**

  Run: `npx vitest run tests/unit/i18n.test.ts tests/unit/ui.test.ts tests/unit/uiScopePanel.test.ts`
  Expected: 全 PASS（`ui.test.ts:391/:401/:406/:475` 依赖 LABELS 值与今天逐字相同）

- [ ] **Step 5: 类型检查**

  Run: `npm run typecheck`
  Expected: 0 error

- [ ] **Step 6: 重建产物并 Commit（同一 commit）**

  `types.ts` 在 client bundle 的模块图内（组件 import 它），LABELS 改为派生自 `dictionaries.zh` 后 `i18n.ts` 会进 bundle ⇒ **本 task 必须携带重建产物**。

  ```bash
  npm run build:client && git add ui/src/i18n.ts ui/src/types.ts tests/unit/i18n.test.ts tsconfig.ui.json tsconfig.json lib/client.js && \
  git commit -m "feat(cherry-locale): i18n 核心——zh/en 字典、t、navigator 语言源、localeStore 与标签表改造（+lib，双 tsconfig 分区；字典就位、消费点未接）"
  ```

---

### Task 2: 宿主接线——main.tsx 单点 fallback、订阅、再探与 label

**Files:**
- Modify: `ui/src/main.tsx`、`tests/unit/ui.test.ts:778-810`（用例 `registers the settings section through slots.inject, not a body mount`，`apply` 在 `:782`）与 `:812-831`（用例 `renders the registered component as the settings page`，`apply` 在 `:815`）、`tests/unit/uiScopePanel.test.ts:580-617`（用例 `⑪ answers GET /scope on every App render path the existing suite uses`，`apply` 在 `:606` 的 `for (const path of paths)` 循环体内，见 Step 4 的循环体提示）、`tests/integration/clientBundle.test.ts`、`tsconfig.ui.json`、`tsconfig.json`
- Create: `tests/unit/localeWiring.test.ts`（UI 分区 → 双 tsconfig 加名）、`lib/client.js`（重建）
- Test: `tests/unit/localeWiring.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `dictionaries`/`localeStore`/`resolveLocaleFromNavigator`。
- Produces（Task 3/4 组件在真实宿主内的运行环境）：
  ```ts
  export interface LocaleService {           // main.tsx 本地声明，不 import 宿主包
    getLocale(): { active: string }
    subscribe(listener: () => void): () => void
  }
  ```
  `apply(ctx)` 行为契约：开头单点求值 `fallback`；在场 ⇒ `setLocale(active∈{zh,en} ? active : fallback)` + `ctx.effect` 订阅；缺席 ⇒ `setLocale(fallback)`；`slots.inject` 回调内再探一次（幂等，探到且此前缺席则采纳并订阅）；`label: () => t(...)` 宿主在场直读 `getLocale().active` 解析、无宿主读 store；注册项**不含** `locale`。
  **label 双路判定的依据 = 当前缓存的 host 引用**（不是"apply 时是否探到"这个一次性判断）：`apply` 的探针与 `slots.inject` 的再探**都写同一个缓存的 host 引用**，`label()` 每次调用读该引用——**在场恒直读 `host.getLocale().active`**（使"label 在我方监听器之前被调用"仍正确），**缺席恒读 `localeStore`**。故**再探成功后**（apply 时缺席、inject 时在场）该引用被更新，label 自动从"读 store"切到"直读宿主"，无需额外开关；与设计 §5.2 一致。

- [ ] **Step 1: 写失败测试 `tests/unit/localeWiring.test.ts`**

  覆盖设计 §8.1④ 全部用例：在场（zh，切 en 后**不重挂载**下 label 与组件文案变英文）/ 缺席三态（无 `get`、`get` 返回 `undefined`、形状错误对象 ⇒ 都不抛、注册项不含 `locale`、页面照常渲染、`en-US`→英文 `zh-CN`→中文）/ 白名单拦截（`active='fr'` ⇒ 取 navigator 判定；navigator 缺失 ⇒ zh）/ 宿主抛错两态（`getLocale()` 抛、`subscribe()` 抛 ⇒ 异常不冒泡 + warn + 页面可用）/ 标签时序（label 在我方监听器之前被调用 ⇒ 语言仍正确）/ 再探（apply 时缺席、inject 回调时在场 ⇒ 采纳并订阅、不重复订阅）/ 卸载（disposer ⇒ 退订）。
  组件渲染用 fixture 英文标记串避免中文断言混入。

- [ ] **Step 2: 运行确认失败**

  Run: `npx vitest run tests/unit/localeWiring.test.ts`
  Expected: FAIL（apply 仍返回常量 label）

- [ ] **Step 3: 实现 `ui/src/main.tsx`**

  按 Interfaces 的行为契约重写 `apply`；`ctx` 类型加 `get?(name: string): unknown`；所有宿主交互 try/catch 包裹（§7 总原则：任何失败降级为"没有本地化"，异常绝不冒出 apply）。

- [ ] **Step 4: 适配三处既有 apply 调用点 + 新断言**

  - `ui.test.ts:782` 与 `:815`、`uiScopePanel.test.ts:606`：fake ctx 补 **zh locale 服务**（jsdom 的 `navigator.language='en-US'`，不补会污染其后中文断言）；`ui.test.ts:795-800`（`registrations[0].options` 断言群，含 `:800` 的 label 回调）顺带断言注册项**不含** `locale`。
  - **`uiScopePanel.test.ts:606` 的坑：该 `apply` 在 `for (const path of paths)` 循环体内**（见 `:598-617`），所以 fake ctx 必须**每轮都可用**——要么在**循环体内每轮新建**、要么复用**同一个无状态实例**（zh locale 服务本身无状态，两种都可）。不要只在循环外建一次却让回调捕获会随轮次变化的变量。
  - `clientBundle.test.ts`：新增断言——该 fake ctx（无 `get`）下注册项不含 `locale`（现有 `:317` 的 `inject === ['slots']` 断言**保持不动**）。**落点点名**：加在 **`:328` 所在的 `registers the settings entry through the slots service` 用例内**（`:321` 起，其 fake ctx 才带 `slots`，`registrations` 数组在 `:323`）；`:371`/`:379` 是 `apply({ effect })` 形态、**不产注册项**，不在此列。
  - `tsconfig.ui.json` include 与 `tsconfig.json` exclude 同时加 `tests/unit/localeWiring.test.ts`。

- [ ] **Step 5: 重建产物并运行（UI 侧 + 集成）**

  Run: `npm run build:client && npx vitest run tests/unit/localeWiring.test.ts tests/unit/ui.test.ts tests/unit/uiScopePanel.test.ts tests/integration/clientBundle.test.ts`
  Expected: 全 PASS（`clientBundle.test.ts:371` 的 `not.toThrow` 验证 VM 无 navigator 的守卫路径）

- [ ] **Step 6: Commit（含重建产物，同一 commit）**

  ```bash
  git add ui/src/main.tsx tests/unit/localeWiring.test.ts tests/unit/ui.test.ts \
    tests/unit/uiScopePanel.test.ts tests/integration/clientBundle.test.ts \
    tsconfig.ui.json tsconfig.json lib/client.js
  git commit -m "feat(cherry-locale): 宿主可选接线——单点 fallback、订阅、slots.inject 再探、label 直读宿主（+lib）"
  ```

---

### Task 3: 设备域组件本地化——App / DeviceCard / PairingWizard

**Files:**
- Modify: `ui/src/App.tsx`、`ui/src/DeviceCard.tsx`、`ui/src/PairingWizard.tsx`、`ui/src/i18n.ts`（缺 key 回补）、`tsconfig.ui.json`、`tsconfig.json`（`localeRender.test.ts` 分区）、`lib/client.js`（重建）
- Create: `tests/unit/localeRender.test.ts`（**本 task 创建**，含 App / DeviceCard / PairingWizard 三条；UI 分区 → 双 tsconfig 加名。Task 4 追加 ToolScopePanel 一条）
- Test: 既有 `tests/unit/ui.test.ts`（**零改动**即为验收）+ 新建 `tests/unit/localeRender.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `useT()`、`STAGE_KEYS`/`STATE_KEYS`；字典 key 已在 Task 1 建好。
- Produces: 三个组件的渲染文案全部经 `t`（供 Task 5 的引用完整性消费）；`tests/unit/localeRender.test.ts`（三个组件的 en 渲染用例，Task 4 追加第四条）。

- [ ] **Step 1: 先跑既有测试确立基线，并先读断言形态**

  Run: `npx vitest run tests/unit/ui.test.ts`
  Expected: 全 PASS（改动前的绿色基线）

  **"零改动即为验收"不等于不用读**：替换前先读点名行段的**断言形态**，确保任一替换都保持 **zh 渲染逐字不变**——
  - `tests/unit/ui.test.ts:325-410`：配对终局断言按**前缀 + 全文拼装**（四条 recovery 文案是**测试侧独立重抄**，`STAGE_LABELS` 只在 `:391/:401/:406` 等处取值）⇒ 必须满足 Task 3 Step 3 的 `wizard.failed` 唯一解。
  - `tests/unit/ui.test.ts:505-680`：设备卡片动作/标签群（状态灯五态文案 `:509-515`、四个动作按钮、移除两步确认 `:675-683`）⇒ `DeviceCard` 的文案替换须与这些字面量逐字一致。

- [ ] **Step 2: 写本组件的 en 渲染失败测试 `tests/unit/localeRender.test.ts`**

  先读 `tests/unit/ui.test.ts:325-410` 的**断言形态**（四条 recovery 全文是**测试侧独立重抄**、不取 `STAGE_LABELS`；`:356`/`:374` 按 `` `配对失败：${guidance}` `` 前缀+全文拼装、`:401` 按前缀 `+` `STAGE_LABELS['expired']` 拼装）——替换字面量时必须保持 **zh 渲染逐字不变**。

  用例三条（App / DeviceCard / PairingWizard）：`localeStore.setLocale('en')` 后渲染该组件（fixture 的服务端 reason / 工作区名 / 路径 / `Error.message` 一律用英文标记串），断言**切 en 后本组件我方自有文案为英文**（判据不是全树零 CJK）；`afterEach` 用公开的 `localeStore.setLocale('zh')` 复位；**不新增任何测试专用导出**。落点与判据同设计 §8.1⑤。

  Run: `npx vitest run tests/unit/localeRender.test.ts`
  Expected: FAIL——组件此刻仍是中文字面量（字面量不受 `localeStore` 影响）⇒ 英文断言必红。

- [ ] **Step 3: 三个组件字面量替换为 `t(...)`**

  - 每组件顶部 `const t = useT()`；静态文本/错误串/三元/`STATE_LABELS[state]` → `t(...)`（状态与阶段走 `t(STAGE_KEYS[x] ?? x)` 形态，`?? 原值` 兜底保留枚举不泄漏 key）。
  - `PairingWizard.tsx:150-153`：拆两个 key 夹 `<strong>{t('wizard.qrCode')}</strong>`；`:201` 配对失败整句模板 `t('wizard.failed', { stage })`——**pin 死**（见下）。
  - `App.tsx:53` 英文串改走 `t`（key 在 Task 1 已建）。
  - `DeviceCard` 的 `hosts.join(', ')`、`id=`、`data-*` **一律不动**（Global Constraint 9）。
  - 缺的 key 回补进 `i18n.ts` 双语（保持 parity）。

  **`wizard.failed` 模板与 `{stage}` 取值（唯一解，逐字 pin）：**

  - zh 模板恰为 `配对失败：{stage}`（**全角冒号 `：`、无空格**）/ en `Pairing failed: {stage}`。
  - `{stage}` 传**已翻译的 recovery 全文**，取值规则：**`STAGE_KEYS[verdict]` 存在 ⇒ `t(STAGE_KEYS[verdict])`；否则 ⇒ `t('wizard.unknownError')`**（zh `未知错误` / en `Unknown error`）。`?? 原值` 兜底**仅**用于枚举透传场景（进行中 stage 的 `?? stage`），**配对失败终局不用**。
  - **依据**：`ui.test.ts:331-336` 把四条 recovery 文案**独立重抄**（不从 `STAGE_LABELS` 取）；`:356`/`:374` 断言 `` `配对失败：${guidance}` ``、`:401` 断言 `` `配对失败：${STAGE_LABELS['expired']}` `` ⇒ 前缀硬编码 + 值取全文，两约束交集**唯一**；`:357`/`:402` 的 `not.toContain('未知错误')` 与 `:369` 的 raw stage token 不泄漏进一步排除"传枚举"写法。
  - 未知 verdict 走 `t('wizard.unknownError')` 而**不是** `?? 原值`：保持 `PairingWizard.tsx:201` 今日 `STAGE_LABELS[verdict ?? ''] ?? '未知错误'` 的用户可见语义（"未知错误"不得消失；`?? 原值` 会把原始 stage token 渲染给用户）。

- [ ] **Step 4: 运行确认通过（en 用例转绿 + zh 基线不变）**

  Run: `npx vitest run tests/unit/localeRender.test.ts tests/unit/ui.test.ts tests/unit/i18n.test.ts && npm run typecheck`
  Expected: 全 PASS（Step 2 的红用例转绿；`ui.test.ts` 余约 140 处中文断言因 zh 逐字不变而零改动）/ 0 error

- [ ] **Step 5: 重建产物**

  Run: `npm run build:client`
  Expected: 构建成功，`lib/client.js` 更新

- [ ] **Step 6: Commit（含产物 + 双 tsconfig 分区）**

  ```bash
  git add ui/src/App.tsx ui/src/DeviceCard.tsx ui/src/PairingWizard.tsx ui/src/i18n.ts \
    tests/unit/localeRender.test.ts tsconfig.ui.json tsconfig.json lib/client.js
  git commit -m "feat(cherry-locale): App/DeviceCard/PairingWizard 文案接入 t()，en 渲染基线（+lib，双 tsconfig 分区）"
  ```

---

### Task 4: 作用域面板本地化——ToolScopePanel

**Files:**
- Modify: `ui/src/ToolScopePanel.tsx`、`ui/src/i18n.ts`（缺 key 回补）、`lib/client.js`（重建）
- Test: 既有 `tests/unit/uiScopePanel.test.ts`（**零改动**即为验收）+ 追加 `tests/unit/localeRender.test.ts` 的 ToolScopePanel 一条（文件与分区已在 Task 3 建好，**本 task 无需再动 tsconfig**）

**Interfaces:**
- Consumes: 同 Task 3；`tests/unit/localeRender.test.ts`（Task 3 创建）。
- Produces: 面板全部自有文案经 `t`（含 `DEGRADED_LABELS`/`SAVE_FAILURE_LABELS` 两张表 → key 化）；`localeRender.test.ts` 补第 4 条用例。

- [ ] **Step 1: 先跑既有测试确立基线，并先读断言形态**

  Run: `npx vitest run tests/unit/uiScopePanel.test.ts`
  Expected: 全 PASS（改动前的绿色基线）

  **"零改动即为验收"不等于不用读**：替换前先读点名行段的**断言形态**（本文件大量用 `slotText(...)` / `pageText()` + `toContain` 的**子串**断言，而非全文相等），确保替换后这些子串仍命中、zh 渲染逐字不变——
  - `tests/unit/uiScopePanel.test.ts:230-260`：模式单选对 + 工作区多选的标题/路径断言、`[data-scope-empty]` 的 `toContain` 整句。
  - `tests/unit/uiScopePanel.test.ts:320-400`：`[data-scope-stale]` / `[data-degraded-source="…"]` 的逐源子串群（含 `隐藏层应用曾失败（install）`、`仅可见性降级`、`路径规范化降级`）。
  - `tests/unit/uiScopePanel.test.ts:650-770`：`scope-version` 降级、未加载态 `[data-scope-empty]` 为空串、保存按钮禁用等边界。

- [ ] **Step 2: 追加本组件的 en 渲染失败测试**

  在 `tests/unit/localeRender.test.ts`（Task 3 创建）追加 **ToolScopePanel 一条**，形态同前三条：`localeStore.setLocale('en')` 后渲染面板（fixture 的服务端 `reason`/工作区名/路径/`Error.message` 用英文标记串），断言**切 en 后面板我方自有文案为英文**；`afterEach` 复位 zh。

  Run: `npx vitest run tests/unit/localeRender.test.ts`
  Expected: FAIL——面板此刻仍是中文字面量 ⇒ 英文断言必红。

- [ ] **Step 3: 面板字面量替换**

  - `SELECTED_EMPTY_HINT`/`GLOBAL_EMPTY_HINT`/`EFFECT_NOTE` → `t` 一对一；`DEGRADED_LABELS`（5）与 `SAVE_FAILURE_LABELS`（5）改为 key 表 + `t()`（形态同 Task 1 的 KEYS/LABELS 约定，值不重复声明）。
  - **两张表必须改为模块级 key 字符串表**（`DEGRADED_KEYS`/`SAVE_FAILURE_KEYS` 重命名或保持原名改值，实现者定；**模块级、纯 key、不含 `t`**——它们被 `useCallback` 与纯模块函数消费，函数体外拿不到 `t`）：
    - 取值点统一 `t(表[source] ?? source)`：`:354` 的 `<strong>{DEGRADED_LABELS[note.source] ?? note.source}</strong>` → `t(DEGRADED_KEYS[note.source] ?? note.source)`；`:274` 的 `label: (code === undefined ? undefined : SAVE_FAILURE_LABELS[code]) ?? 保存失败：${describeCause(cause)}` → **`t(SAVE_FAILURE_KEYS[code] ?? 'scope.saveFailed', { cause })`** 形态（key 名实现者可调，**模块表内只剩 key**；未知 code 落到 `scope.saveFailed` 整句模板并传 `{cause}`——占位符必须被替换，见下方 `:274`/`:275` 整句模板条目与 GC5）。
    - `resolveEmptyHint`（`:146-156`）改为**接收 `t` 作参数**（在 `input` 之外新增 `t` 形参或并入 `input`），调用点 `:243` 传入组件内的 `t`。
    - 消费 `SAVE_FAILURE_LABELS` 的 `useCallback`（`:249-279`，标签在 `:274`）**依赖数组加入 `t`**（`:279` 的 `[client, ids, mode, revision]` → `[client, ids, mode, revision, t]`）。
  - `:327`/`:318` 被插值切段的长句 → **整句模板**（`{reason}`/`{error}` 作参数）；`:355` → `t('scope.degradedLine', { label, reason })`（`label` 即上面的 `t(表[source] ?? source)`）；`:458` → `t('scope.revision', { revision })`；`:464` → `t('scope.savedPruned', { list: saved.pruned.join(t('list.separator')) })`。
  - **`:274`/`:275` 两条插值切段模板（设计 §5.3 点名，勿漏）**：`:274` → `t('scope.saveFailed', { cause })`；`:275` → `t('scope.serverSaid', { code, status })`——**key 名实现者可调，但形态必须整句模板**（两条**各自**合并为一个整句 key + 参数：把 `服务端返回 ${code}（HTTP ${status}）。` 与被插值切段的保存失败句分别收进各自的 key），因为 `i18nAssets` 只保"无中文"、**不保整句形态**，漏成"半句 + 拼接"不会被自动守卫发现。
  - `:355` 的 DOM 结构**允许微调**（`<strong>{…}</strong>` + `<span>{…}</span>` 两节点 → **单节点整句**），但**不得破坏** `uiScopePanel.test.ts` 既有的 `slotText()`/`toContain` 断言——现测试用整段 `slotText` 取值故恰好安全，但那是运气不是保证；若合成整句，**必须用单节点文本**（把 label 与 reason 拼成一个字符串再渲染），不要保留"两节点各自成句"的分裂形态。**验收即 Step 4 全绿**（无需为本项新增测试）。
  - `data-scope-*`/`data-degraded-source` 取值、`aria-labelledby` id **不动**；服务端 `reason`/`loadError` 原样插值不翻译。
  - 缺的 key 回补进 `i18n.ts` 双语。

- [ ] **Step 4: 运行确认通过**

  Run: `npx vitest run tests/unit/localeRender.test.ts tests/unit/uiScopePanel.test.ts tests/unit/i18n.test.ts && npm run typecheck`
  Expected: 全 PASS（Step 2 的红用例转绿）/ 0 error

- [ ] **Step 5: 重建产物并 Commit（同一 commit）**

  ```bash
  npm run build:client && git add ui/src/ToolScopePanel.tsx ui/src/i18n.ts tests/unit/localeRender.test.ts lib/client.js && \
  git commit -m "feat(cherry-locale): ToolScopePanel 文案接入 t()，标签表 key 化（+lib）"
  ```

---

### Task 5: 三件守卫——key 引用完整性、en 渲染基线、源码级 CJK 扫描

**Files:**
- Create: `tests/unit/i18nUsage.test.ts`（UI 分区 → 双 tsconfig 加名）、`tests/unit/i18nAssets.test.ts`（**扫 `ui/src/**/*.{ts,tsx}` 全域**；不 import ui 模块 ⇒ server 默认，不改 tsconfig）
- Modify: `tsconfig.ui.json`、`tsconfig.json`

**Interfaces:**
- Consumes: Task 1 字典与 KEYS 表、Task 3/4 已本地化的组件与 `tests/unit/localeRender.test.ts`（Task 3 创建、Task 4 追加）。

- [ ] **Step 1: 写两个守卫测试（`i18nUsage` 为失败测试，`i18nAssets` 为回归守卫）**

  - `i18nUsage`（§8.1③）：扫 `ui/src/**/*.{ts,tsx}` 的 `t('…')` 字面量 ∪ `Object.values(STAGE_KEYS)` ∪ `Object.values(STATE_KEYS)` ⇒ 全在字典；反向：字典每个 key 至少被该并集引用一次。**扫描模式须覆盖 `t('…')` 的任意出现位置**（含**实参内**形态，如 `join(t('list.separator'))`）——只匹配"语句独立成行"的正则会漏报；并在本测试里放一条 `join(t('list.separator'))` 形态的**正例断言**（防扫描器漏报）。
  - `i18nAssets`（§8.1⑥）：TypeScript 编译器 API（`ts.createSourceFile` 遍历 StringLiteral/NoSubstitutionTemplateLiteral/JsxText）扫 **`ui/src/**/*.{ts,tsx}` 全域**，断言无 CJK——**白名单仅 `i18n.ts`**（ui/src 全域唯一允许 CJK 的文件）。**不得退回"6 个具名文件"清单**：具名名单 ≠ "全域唯一白名单"的意图——灰区（`api.ts`/`dev.tsx`/`vite-env.d.ts`）当前 CJK=0，但具名名单**不设防**，将来往它们里写中文不会被发现。
  - `tsconfig.ui.json` include 与 `tsconfig.json` exclude 同时加 `tests/unit/i18nUsage.test.ts`（本文件 import `ui/src/**` 的 KEYS/LABELS ⇒ UI 分区，见 Global Constraint 12）。`i18nAssets` 不 import ui 模块（只 fs + TS API）⇒ **server 项目默认覆盖，不改 tsconfig**。
  - **`localeRender.test.ts` 本 task 不再创建**：该文件已在 Task 3 创建并登记双 tsconfig，Task 4 追加了第 4 条；本 task 只把它拉进回归命令（Step 4）。

- [ ] **Step 2: 运行两条守卫，按实际输出记录（不预设结果）**

  Run: `npx vitest run tests/unit/i18nUsage.test.ts tests/unit/i18nAssets.test.ts`

  两条守卫的**预期不同**，且**都不预设必红**——任务的先后顺序决定了它们的初始状态：

  - **`i18nAssets`（源码级 CJK 扫描）：预期 PASS（回归守卫）**——Task 3/4 已完成组件本地化并逐字收口，本 task 晚于它们 ⇒ 此时源码应已零 CJK。它在这里的角色是**回归守卫**（防后续改动重新引入中文字面量），不是"待转红"的失败测试。

  - **`i18nUsage`（key 引用完整性）：预期可能 FAIL（仅反向断言）**——正向（`t('…')` 字面量 ∪ KEYS 表值 ⇒ 全在字典）此刻应已绿；**反向**（字典每个 key 至少被引用一次）可能因**死 key / 漏引用**而红。**按实际输出记录**，红则进 Step 3 修补，绿则作为守卫保留——**不预设必红**。

  若两条都直接绿：如实记录"两项均作回归守卫保留"，不必为制造红而改动测试（本 task 的 RED 已在 Task 3/4 的 `localeRender` 用例中取得）。

- [ ] **Step 3: 修补暴露的漏项**

  按失败输出补：漏 key / 漏引用 / 残留中文字面量（回改对应组件或字典，保持 parity 与 zh 逐字不变）。

- [ ] **Step 4: 运行确认通过**

  Run: `npx vitest run tests/unit/i18nUsage.test.ts tests/unit/localeRender.test.ts tests/unit/i18nAssets.test.ts tests/unit/projectCoverage.test.ts && npm run typecheck`
  Expected: 全 PASS / 0 error

- [ ] **Step 5: Commit（产物条款见下，条件携带）**

  **若 Step 3 回改了 `ui/src/**`**（修补漏项时改了组件或字典）⇒ **必须先 `npm run build:client`，并把重建的 `lib/client.js` 一并 commit**（Global Constraint 11：改 `ui/src/**` 的 commit 必须携带产物，`artifactFreshness` 是 `git show HEAD:` vs 重建的**字节比对**，漏了直接红）。**若 Step 3 未触碰 `ui/src/**`**（只新建测试文件）⇒ 无产物变更，不重建、不 add `lib/client.js`。

  ```bash
  # Step 3 回改了 ui/src/** 时，先跑这一句：
  #   npm run build:client
  git add tests/unit/i18nUsage.test.ts tests/unit/i18nAssets.test.ts tsconfig.ui.json tsconfig.json
  # 且仅当上面那步跑过，把 lib/client.js 追加进同一条 git add：
  #   git add lib/client.js
  git commit -m "test(cherry-locale): key 引用完整性 + 源码级 CJK 守卫（双 tsconfig 分区）"
  ```

---

### Task 6: 插件列表元数据文件、导出与收口

**Files:**
- Create: `locale/en.json`、`locale/zh.json`
- Modify: `package.json`（exports 加 `"./locale/*.json": "./locale/*.json"`；files 加 `"locale"`）、`docs/e2e-checklist.md`（第二部分 F 节后新增 `### G. 语言切换与降级`）、`tsconfig.ui.json`、`tsconfig.json`（`localeMeta.test.ts` 分区）
- Test: `tests/unit/localeMeta.test.ts`（import `ui/src/i18n.ts` 的 `dictionaries` ⇒ **UI 分区**，双 tsconfig 加名）

**Interfaces:**
- Consumes: Task 1 `dictionaries`（`meta.title` 逐字等于 `dictionaries[lang]['app.title']`）。

- [ ] **Step 1: 写失败测试 `tests/unit/localeMeta.test.ts`**

  §8.1② 全部：两 json 结构 `{"meta":{"title","description"}}` 且非空；`meta.title` 逐字等于 `dictionaries[lang]['app.title']`；目录无多余 `*.json`、文件名合法语言 id；`package.json` exports 含 `"./locale/*.json"`、files 含 `"locale"`。
  pinned：`en.json` `meta.title` = `"Cherry Studio Bridge"`、`zh.json` `meta.title` = `"Cherry Studio 互联"`（= `dictionaries[lang]['app.title']`；**这是唯一"不写就静默回退成包名 `dsh-cherry-bridge`"的字段**）；`en.json` `meta.description` = `"DeepSeek Harness plugin bridging to Cherry Studio desktop instances over remote transport"`（与 package.json description 逐字相同）；`zh.json` = `"通过远程传输把本机 DeepSeek Harness 连接到 Cherry Studio 桌面端的插件"`。
  `tsconfig.ui.json` include 与 `tsconfig.json` exclude 同时加 `tests/unit/localeMeta.test.ts`。
  **禁止把 `locale/{en,zh}.json` 改为构建期生成**（设计 §9 第 3 项的显式取舍）：宿主 `readPluginMeta` 是**纯文件驱动**——它 `readdirSync` 枚举 `locale/` 目录并**直读磁盘上的 `*.json`**（探测 `en.json` 后逐个解析同目录文件），不会执行任何构建脚本。因此两份物理拷贝（bundle 内的 `dictionaries` vs 磁盘上的 `locale/*.json`）**必须真实存在于仓库**，二者的一致性由 `localeMeta.test.ts` **焊死**（`meta.title` 逐字等于 `dictionaries[lang]['app.title']`），**不是**由构建期从字典生成 json 来"消重"——那样做会让 `locale/` 在安装产物里缺失或滞后，插件行静默回退。

  **真实解析器（独立接入，不沿用任何既有先例）** ——`readPluginMeta` 来自 `@deepseek-ai/dsh-app-boot`，与本仓库既有的 `clientBundle.test.ts`（那是 `@deepseek-ai/dsh-client-modules` 的 `ClientModuleRegistry`，**另一个包、另一种缺席语义**）**不是同一份候选表**，必须独立给出：

  - **候选路径表**（本文件自带 `HOST_APP_BOOT_CANDIDATES`，可沿用 `DSH_WEB_CHECKOUT` 环境变量但路径片段改为 app-boot，至少两条候选）：
    ```ts
    const HOST_APP_BOOT_CANDIDATES = [
      process.env['DSH_WEB_CHECKOUT'] === undefined
        ? undefined
        : join(process.env['DSH_WEB_CHECKOUT'], 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'),
      '/dsh-home/profiles/web/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    ].filter((candidate): candidate is string => candidate !== undefined)
    ```
  - **动态 import 失败守卫**：逐候选 `existsSync` + `await import(pathToFileURL(candidate).href)`，**try/catch 包住 import**（候选在场但加载失败 ⇒ 视为缺席，不得让 `import` 异常冒泡炸掉整个测试文件）；拿到 `readPluginMeta` 函数才算在场，否则 `describeIfHost = describe.skipIf(readPluginMeta === undefined)`。
  - **`parentURL = import.meta.url`**：以仓库内文件为基址可经 Node 自引用解析本包 `package.json`（判据写成一条可勾选子项，不要用 `repoRoot` 另造探针文件）。
  - **skip 时的验收降级**：宿主产物缺席 ⇒ 该用例**带理由 skip**（理由文案写明"宿主 app-boot 产物缺席，真实解析器未验证"），**但结构断言（json 结构合法 / 与字典逐字一致 / exports 通配放行）必须照跑**；并在测试输出里**显式声明"真实解析器未验证"**——`npm test` 全绿**不得**被误读为真实路径已验证。
  - 断言形态：`readPluginMeta('dsh-cherry-bridge', import.meta.url)` 返回 `{title:{en,zh}, description:{en,zh}}` 且与字典/两 json 逐字一致（通配 exports 放行的**唯一**证明在被 skip 时即告缺席，见上）。

  **两段式断言（RED 阶段 ≠ 建成阶段，同一断言无法描述两种形态）**：

  - **RED 阶段**（`locale/*.json` 尚不存在，本 Step 的第一次 Run 就是此态）：`readPluginMeta` 走 **package.json 兜底链** ⇒ `title` 是**扁平字符串** `'dsh-cherry-bridge'`（包名）、`description` === `package.json.description`。写成 `expect(meta.title).toBe('dsh-cherry-bridge')` + `expect(meta.description).toBe(pkg.description)`。
  - **建成文件后**（Step 2 写两 json 之后）**改写同一条断言**：`{title:{en,zh}, description:{en,zh}}`，且 en/zh **既与字典逐字一致、又与两份 json 逐字一致**。两段是**同一条用例的前后两态**（RED 先钉兜底链，建成后钉双语文案），不是两条并发用例。

- [ ] **Step 2: 运行确认失败 → 建文件与导出 → 再运行确认通过**

  Run: `npx vitest run tests/unit/localeMeta.test.ts`（FAIL：文件不存在）→ 写两 json + 改 package.json → 再 Run → PASS。

- [ ] **Step 3: checklist 新增 G 节**

  `docs/e2e-checklist.md` 第二部分 `### F. 工具启用范围（/scope）` 之后新增 `### G. 语言切换与降级`：①宿主 General 设置切语言（中↔英），核对导航标签/页面正文/插件列表标题与描述三处**无需刷新**跟随；②英文界面遇服务端中文 message/reason 按已知折中判定（设计 §9 第 1 项，不算失败）。**第一部分不动**（contract ⑦）。

- [ ] **Step 4: 全量收口**

  Run: `npm run typecheck && npx vitest run tests/contract/contract.test.ts tests/unit/artifactFreshness.test.ts && npm test`

  前一段是**本任务特有的高风险面**，必须在全量之前先单跑定位：
  - `tests/contract/contract.test.ts`——本 task 改了 `package.json`（manifest）⇒ **manifest 正向断言**受影响（新增 `exports` 条目 / `files` 增 `"locale"`）。
  - `tests/unit/artifactFreshness.test.ts`——产物面 ⇒ 与 `lib/client.js` 的**字节比对**。

  Expected: **全量绿，以 `npx vitest list` 实测基线为准（不写死数字）**——判定口径是"**既有全绿 + 本任务新增项全绿、Test Files 计数较执行前不减**"，**不要**与任何写死的绝对数比对。（`connection.test.ts > F2-5b` 为已知 flake，红则单跑该文件复核，不算本任务回归。）

- [ ] **Step 5: Commit**

  ```bash
  git add locale/en.json locale/zh.json package.json tests/unit/localeMeta.test.ts \
    tsconfig.ui.json tsconfig.json docs/e2e-checklist.md
  git commit -m "feat(cherry-locale): 插件列表元数据 locale/{en,zh}.json + 通配导出 + e2e checklist G 节（双 tsconfig 分区）"
  ```

---

## 任务依赖

Task 1 → Task 2 →（Task 3 → Task 4）→ Task 5 → Task 6。**Task 3 → Task 4 串行**（两者都会回补 `ui/src/i18n.ts` 的 key，**同文件禁止并发写**）；其余串行。

> 携带**双 tsconfig 改动**的 commit 共 5 处，逐一标注在对应 task：Task 1（`i18n.test.ts`）、Task 2（`localeWiring.test.ts`）、Task 3（`localeRender.test.ts`）、Task 5（`i18nUsage.test.ts`）、Task 6（`localeMeta.test.ts`）。`i18nAssets.test.ts` 是唯一走 server 默认的测试（不 import ui 模块）。
