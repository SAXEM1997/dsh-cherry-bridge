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
8. **技术 token 不译**（§9.2 清单：`cherry_*`、`tools.guard`、`install`、`workspace-list`、`visibility-only`、`scope-version`、`path-normalization`、`scope-revision-conflict`、`expectedRevision`、`mode`/`global`/`selected`/`workspaceIds`、`revision`、`cwd`、`HTTP`、`DSH`、`ID`、`claim`、`EventSource`、`.corrupt`、`Cherry Studio`、`DeepSeek Harness`）；**插值数据**（路径、workspace 名、revision 数字、状态码）原样渲染不进字典。
9. **不可本地化清单**（§5.3）：`DeviceCard` 的 `hosts.join(', ')` 与 `parseHosts` 的 `split(',')`（数据面，被 `ui.test.ts:653/662/663` 钉住）、`data-*` 取值、元素 id、`aria-labelledby` 指向的 id。
10. 文案形态规约（§5.3）：整句一个 key + `{name}` 占位符；被插值切段的长句合并为整句模板（服务端 reason 作参数）；`PairingWizard.tsx:150-153` 拆前段/后段两个 key 夹 `<strong>`；列表分隔符 key `list.separator`（zh `、` / en `', '`，**刻意带尾随空格**，是"无首尾空白"检查的唯一白名单项）；`ToolScopePanel.tsx:355` 改整句 `t('scope.degradedLine', { label, reason })`。
11. **产物同 commit**：凡改 `ui/src/**` 的 commit 必须携带 `npm run build:client` 重建的 `lib/client.js`（`artifactFreshness` 字节比对 `git show HEAD:` vs 重建）。
12. **测试分区**：新建 UI 侧测试文件（jsdom/JSX 渲染）须**同时**加进 `tsconfig.ui.json` 的 `include` 与 `tsconfig.json` 的 `exclude`（二者都是逐文件列举；`tests/unit/projectCoverage.test.ts` 断言每个 test 文件恰好被一个项目覆盖）；纯逻辑/读文件/TS API 的测试文件由 server 项目默认覆盖，无需改 tsconfig。
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
- Test: `tests/unit/i18n.test.ts`（server 分区，无需改 tsconfig）

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
- Produces（types.ts，导出名与 key 集不变）：`STAGE_KEYS: Record<PairingStage, string>`、`STATE_KEYS: Record<DeviceState, string>`（key 字面量，命名 `wizard.stage.<stage>` / `device.state.<state>`）；`STAGE_LABELS`/`STATE_LABELS` 保留导出，**值 === `dictionaries.zh` 对应条目**。

- [ ] **Step 1: 写失败测试 `tests/unit/i18n.test.ts`**

  覆盖设计 §8.1① 全部断言：
  - 键集 parity：`Object.keys(zh)` 与 `Object.keys(en)` 逐字相同
  - 占位符 parity：逐 key 提取 `/\{(\w+)\}/g` 集合，两语言同名同数
  - 无空串；"无首尾空白"适用于**除白名单 `list.separator` 外**的所有 key（白名单逐项写进测试：en 值 `', '`、zh 值 `、`）
  - `t` 行为：`createTranslator('zh')('app.title')` === `'Cherry Studio 互联'`、`createTranslator('en')('app.title')` === `'Cherry Studio Bridge'`、插值替换、缺 key 原样返回 key、缺参数 `{name}` 原样保留
  - `resolveLocaleFromNavigator`：`zh-CN→zh`、`en-US→en`、`fr→en`、`undefined→zh`、`ZH→zh`（大小写不敏感）、`''→zh`
  - `localeStore`：模块默认语言 `zh`、同值 `setLocale` 不通知、异值通知一次、`getSnapshot()` 引用稳定、退订生效
  - 标签表：`STAGE_KEYS`/`STATE_KEYS` 的每个 value 都在字典里；`STAGE_LABELS` 每个值 === `dictionaries.zh[STAGE_KEYS[k]]`（STATE 同理）

- [ ] **Step 2: 运行确认失败**

  Run: `npx vitest run tests/unit/i18n.test.ts`
  Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `ui/src/i18n.ts` 与 types.ts 标签表**

  - 字典构建：走查 `ui/src/{App,DeviceCard,PairingWizard,ToolScopePanel}.tsx`、`ui/src/types.ts` 的全部用户可见中文字符串（设计 §3 F15 计 96 处），按域前缀建 key（`app.` / `device.` / `wizard.` / `scope.` / `list.`）；zh 值**逐字拷贝现源码字符串**（不重打字）；en 值按 §11 术语表与基调新写；`App.tsx:53` 的英文串 `'EventSource is unavailable in this environment'` 收编为 key（zh 补中文）；含插值的句子按 Global Constraint 10 的形态规约。
  - pinned 值：`app.title` zh `Cherry Studio 互联` / en `Cherry Studio Bridge`；`app.eventSourceUnavailable` zh `此环境不支持 EventSource` / en `EventSource is unavailable in this environment`（原 `App.tsx:53` 英文串收编）。
  - `useT()` 用 `useSyncExternalStore(localeStore.subscribe, localeStore.getSnapshot)` → `createTranslator(snapshot.locale)`。
  - types.ts：新增两个 KEYS 表（key 字面量）；LABELS 表改为从 `dictionaries.zh` 取值（机制自选：逐项引用或小工具函数），**导出名与 key 集不变**。

- [ ] **Step 4: 运行确认通过（含既有测试不回归）**

  Run: `npx vitest run tests/unit/i18n.test.ts tests/unit/ui.test.ts tests/unit/uiScopePanel.test.ts`
  Expected: 全 PASS（`ui.test.ts:391/:401/:406/:475` 依赖 LABELS 值与今天逐字相同）

- [ ] **Step 5: 类型检查**

  Run: `npm run typecheck`
  Expected: 0 error

- [ ] **Step 6: 重建产物并 Commit（同一 commit）**

  `types.ts` 在 client bundle 的模块图内（组件 import 它），LABELS 改为派生自 `dictionaries.zh` 后 `i18n.ts` 会进 bundle ⇒ **本 task 必须携带重建产物**。

  ```bash
  npm run build:client && git add ui/src/i18n.ts ui/src/types.ts tests/unit/i18n.test.ts lib/client.js && \
  git commit -m "feat(cherry-locale): i18n 核心——zh/en 字典、t、navigator 语言源、localeStore 与标签表改造（+lib）"
  ```

---

### Task 2: 宿主接线——main.tsx 单点 fallback、订阅、再探与 label

**Files:**
- Modify: `ui/src/main.tsx`、`tests/unit/ui.test.ts:782-800 一带与 :811-828 一带`、`tests/unit/uiScopePanel.test.ts:600-612 一带`、`tests/integration/clientBundle.test.ts`、`tsconfig.ui.json`、`tsconfig.json`
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

- [ ] **Step 1: 写失败测试 `tests/unit/localeWiring.test.ts`**

  覆盖设计 §8.1④ 全部用例：在场（zh，切 en 后**不重挂载**下 label 与组件文案变英文）/ 缺席三态（无 `get`、`get` 返回 `undefined`、形状错误对象 ⇒ 都不抛、注册项不含 `locale`、页面照常渲染、`en-US`→英文 `zh-CN`→中文）/ 白名单拦截（`active='fr'` ⇒ 取 navigator 判定；navigator 缺失 ⇒ zh）/ 宿主抛错两态（`getLocale()` 抛、`subscribe()` 抛 ⇒ 异常不冒泡 + warn + 页面可用）/ 标签时序（label 在我方监听器之前被调用 ⇒ 语言仍正确）/ 再探（apply 时缺席、inject 回调时在场 ⇒ 采纳并订阅、不重复订阅）/ 卸载（disposer ⇒ 退订）。
  组件渲染用 fixture 英文标记串避免中文断言混入。

- [ ] **Step 2: 运行确认失败**

  Run: `npx vitest run tests/unit/localeWiring.test.ts`
  Expected: FAIL（apply 仍返回常量 label）

- [ ] **Step 3: 实现 `ui/src/main.tsx`**

  按 Interfaces 的行为契约重写 `apply`；`ctx` 类型加 `get?(name: string): unknown`；所有宿主交互 try/catch 包裹（§7 总原则：任何失败降级为"没有本地化"，异常绝不冒出 apply）。

- [ ] **Step 4: 适配三处既有 apply 调用点 + 新断言**

  - `ui.test.ts:782` 与 `:815`、`uiScopePanel.test.ts:606`：fake ctx 补 **zh locale 服务**（jsdom 的 `navigator.language='en-US'`，不补会污染其后中文断言）；`ui.test.ts:800` 一带顺带断言注册项**不含** `locale`。
  - `clientBundle.test.ts`：新增断言——该 fake ctx（无 `get`）下注册项不含 `locale`（现有 `:317` 的 `inject === ['slots']` 断言**保持不动**）。
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
- Modify: `ui/src/App.tsx`、`ui/src/DeviceCard.tsx`、`ui/src/PairingWizard.tsx`、`lib/client.js`（重建）
- Test: 既有 `tests/unit/ui.test.ts`（**零改动**即为验收）

**Interfaces:**
- Consumes: Task 1 的 `useT()`、`STAGE_KEYS`/`STATE_KEYS`；字典 key 已在 Task 1 建好。
- Produces: 三个组件的渲染文案全部经 `t`（供 Task 5 的引用完整性与 en 渲染基线消费）。

- [ ] **Step 1: 先跑既有测试确立基线**

  Run: `npx vitest run tests/unit/ui.test.ts`
  Expected: 全 PASS（改动前的绿色基线）

- [ ] **Step 2: 三个组件字面量替换为 `t(...)`**

  - 每组件顶部 `const t = useT()`；静态文本/错误串/三元/`STATE_LABELS[state]` → `t(...)`（状态与阶段走 `t(STAGE_KEYS[x] ?? x)` 形态，`?? 原值` 兜底保留枚举不泄漏 key）。
  - `PairingWizard.tsx:150-153`：拆两个 key 夹 `<strong>{t('wizard.qrCode')}</strong>`；`:201` 配对失败整句模板 `t('wizard.failed', { stage })`。
  - `App.tsx:53` 英文串改走 `t`（key 在 Task 1 已建）。
  - `DeviceCard` 的 `hosts.join(', ')`、`id=`、`data-*` **一律不动**（Global Constraint 9）。
  - 缺的 key 回补进 `i18n.ts` 双语（保持 parity）。

- [ ] **Step 3: 运行确认通过（zh 基线不变）**

  Run: `npx vitest run tests/unit/ui.test.ts tests/unit/i18n.test.ts && npm run typecheck`
  Expected: 全 PASS / 0 error

- [ ] **Step 4: 重建产物**

  Run: `npm run build:client`
  Expected: 构建成功，`lib/client.js` 更新

- [ ] **Step 5: Commit（含产物）**

  ```bash
  git add ui/src/App.tsx ui/src/DeviceCard.tsx ui/src/PairingWizard.tsx ui/src/i18n.ts lib/client.js
  git commit -m "feat(cherry-locale): App/DeviceCard/PairingWizard 文案接入 t()（+lib）"
  ```

---

### Task 4: 作用域面板本地化——ToolScopePanel

**Files:**
- Modify: `ui/src/ToolScopePanel.tsx`、`lib/client.js`（重建）
- Test: 既有 `tests/unit/uiScopePanel.test.ts`（**零改动**即为验收）

**Interfaces:**
- Consumes: 同 Task 3。
- Produces: 面板全部自有文案经 `t`（含 `DEGRADED_LABELS`/`SAVE_FAILURE_LABELS` 两张表 → key 化）。

- [ ] **Step 1: 先跑既有测试确立基线**

  Run: `npx vitest run tests/unit/uiScopePanel.test.ts`
  Expected: 全 PASS

- [ ] **Step 2: 面板字面量替换**

  - `SELECTED_EMPTY_HINT`/`GLOBAL_EMPTY_HINT`/`EFFECT_NOTE` → `t` 一对一；`DEGRADED_LABELS`（5）与 `SAVE_FAILURE_LABELS`（5）改为 key 表 + `t()`（形态同 Task 1 的 KEYS/LABELS 约定，值不重复声明）。
  - `:327`/`:318` 被插值切段的长句 → **整句模板**（`{reason}`/`{error}` 作参数）；`:355` → `t('scope.degradedLine', { label, reason })`；`:458` → `t('scope.revision', { revision })`；`:464` → `t('scope.savedPruned', { list: saved.pruned.join(t('list.separator')) })`。
  - `data-scope-*`/`data-degraded-source` 取值、`aria-labelledby` id **不动**；服务端 `reason`/`loadError` 原样插值不翻译。
  - 缺的 key 回补进 `i18n.ts` 双语。

- [ ] **Step 3: 运行确认通过**

  Run: `npx vitest run tests/unit/uiScopePanel.test.ts tests/unit/i18n.test.ts && npm run typecheck`
  Expected: 全 PASS / 0 error

- [ ] **Step 4: 重建产物并 Commit（同一 commit）**

  ```bash
  npm run build:client && git add ui/src/ToolScopePanel.tsx ui/src/i18n.ts lib/client.js && \
  git commit -m "feat(cherry-locale): ToolScopePanel 文案接入 t()，标签表 key 化（+lib）"
  ```

---

### Task 5: 三件守卫——key 引用完整性、en 渲染基线、源码级 CJK 扫描

**Files:**
- Create: `tests/unit/i18nUsage.test.ts`、`tests/unit/localeRender.test.ts`（UI 分区 → 双 tsconfig 加名）、`tests/unit/i18nAssets.test.ts`
- Modify: `tsconfig.ui.json`、`tsconfig.json`

**Interfaces:**
- Consumes: Task 1 字典与 KEYS 表、Task 3/4 已本地化的组件。

- [ ] **Step 1: 写三个失败测试**

  - `i18nUsage`（§8.1③）：扫 `ui/src/**/*.{ts,tsx}` 的 `t('…')` 字面量 ∪ `Object.values(STAGE_KEYS)` ∪ `Object.values(STATE_KEYS)` ⇒ 全在字典；反向：字典每个 key 至少被该并集引用一次。
  - `localeRender`（§8.1⑤）：`localeStore.setLocale('en')` 后渲染四个组件（fixture 的服务端 reason/工作区名/路径/Error.message 用英文标记串），断言关键文本为英文且**我方自有文案零中文**（判据不是全树零 CJK）；`afterEach` 用公开 `localeStore.setLocale('zh')` 复位；**不新增任何测试专用导出**。
  - `i18nAssets`（§8.1⑥）：TypeScript 编译器 API（`ts.createSourceFile` 遍历 StringLiteral/NoSubstitutionTemplateLiteral/JsxText）扫 `ui/src/{App,DeviceCard,PairingWizard,ToolScopePanel,main,types}.ts(x)` 断言无 CJK——`i18n.ts` 不在名单内（ui/src 全域唯一允许 CJK 的文件）。
  - `tsconfig.ui.json` include 与 `tsconfig.json` exclude 同时加 `tests/unit/localeRender.test.ts`。

- [ ] **Step 2: 运行确认失败**

  Run: `npx vitest run tests/unit/i18nUsage.test.ts tests/unit/localeRender.test.ts tests/unit/i18nAssets.test.ts`
  Expected: FAIL（组件未接入完成则引用扫描/渲染判据不齐）——若 Task 3/4 已使某项直接绿，记录实际输出后继续（该项作为回归守卫保留）

- [ ] **Step 3: 修补暴露的漏项**

  按失败输出补：漏 key / 漏引用 / 残留中文字面量（回改对应组件或字典，保持 parity 与 zh 逐字不变）。

- [ ] **Step 4: 运行确认通过**

  Run: `npx vitest run tests/unit/i18nUsage.test.ts tests/unit/localeRender.test.ts tests/unit/i18nAssets.test.ts tests/unit/projectCoverage.test.ts && npm run typecheck`
  Expected: 全 PASS / 0 error

- [ ] **Step 5: Commit**

  ```bash
  git add tests/unit/i18nUsage.test.ts tests/unit/localeRender.test.ts tests/unit/i18nAssets.test.ts tsconfig.ui.json tsconfig.json
  git commit -m "test(cherry-locale): key 引用完整性 + en 渲染基线 + 源码级 CJK 守卫"
  ```

---

### Task 6: 插件列表元数据文件、导出与收口

**Files:**
- Create: `locale/en.json`、`locale/zh.json`
- Modify: `package.json`（exports 加 `"./locale/*.json": "./locale/*.json"`；files 加 `"locale"`）、`docs/e2e-checklist.md`（第二部分 F 节后新增 `### G. 语言切换与降级`）
- Test: `tests/unit/localeMeta.test.ts`

**Interfaces:**
- Consumes: Task 1 `dictionaries`（`meta.title` 逐字等于 `dictionaries[lang]['app.title']`）。

- [ ] **Step 1: 写失败测试 `tests/unit/localeMeta.test.ts`**

  §8.1② 全部：两 json 结构 `{"meta":{"title","description"}}` 且非空；`meta.title` 逐字等于 `dictionaries[lang]['app.title']`；目录无多余 `*.json`、文件名合法语言 id；`package.json` exports 含 `"./locale/*.json"`、files 含 `"locale"`；**真实解析器**——按 `clientBundle.test.ts:38-67` 先例（绝对路径候选 + `describeIfHost` 带理由 skip）import `@deepseek-ai/dsh-app-boot`，调 `readPluginMeta('dsh-cherry-bridge', import.meta.url)`，断言 `{title:{en,zh}, description:{en,zh}}` 与字典/文件一致。
  pinned：`en.json` `meta.description` = `"DeepSeek Harness plugin bridging to Cherry Studio desktop instances over remote transport"`（与 package.json description 逐字相同）；`zh.json` = `"通过远程传输把本机 DeepSeek Harness 连接到 Cherry Studio 桌面端的插件"`。

- [ ] **Step 2: 运行确认失败 → 建文件与导出 → 再运行确认通过**

  Run: `npx vitest run tests/unit/localeMeta.test.ts`（FAIL：文件不存在）→ 写两 json + 改 package.json → 再 Run → PASS。

- [ ] **Step 3: checklist 新增 G 节**

  `docs/e2e-checklist.md` 第二部分 `### F. 工具启用范围（/scope）` 之后新增 `### G. 语言切换与降级`：①宿主 General 设置切语言（中↔英），核对导航标签/页面正文/插件列表标题与描述三处**无需刷新**跟随；②英文界面遇服务端中文 message/reason 按已知折中判定（设计 §9.1，不算失败）。**第一部分不动**（contract ⑦）。

- [ ] **Step 4: 全量收口**

  Run: `npm run typecheck && npm test`
  Expected: 全绿（574+ 既有 + 新增；`connection.test.ts > F2-5b` 为已知 flake，红则单跑该文件复核，不算本任务回归）

- [ ] **Step 5: Commit**

  ```bash
  git add locale/en.json locale/zh.json package.json tests/unit/localeMeta.test.ts docs/e2e-checklist.md
  git commit -m "feat(cherry-locale): 插件列表元数据 locale/{en,zh}.json + 通配导出 + e2e checklist G 节"
  ```

---

## 任务依赖

Task 1 → Task 2 →（Task 3 → Task 4）→ Task 5 → Task 6。Task 3 与 Task 4 互相独立（不同文件），可并行；其余串行。
