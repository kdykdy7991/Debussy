# B4 交接：`createAvatar()` Embed SDK

状态：**Approved by AI-A**（2026-08-10；二次 Review 通过，B5 可启动）
作者：AI-B（经济模型/实现者）
日期：2026-08-10
依赖：B3（Approved）、A3（Fake 夹具）、A4（构建审定）、ADR-0005（冻结契约）

## 任务 ID：B4

```text
按 B4 任务单实现 createAvatar() Embed SDK
完成标准（任务单 §4/§5/§6）：实现 ADR-0005 冻结的 createAvatar(options) API；
从 @skdy/avatar 根入口导出 createAvatar、AvatarEmbedOptions、AvatarEmbedHandle；
导入根入口不注册 <pi-avatar>，调用时按需安全注册；controller 为元素公开代理；
destroy 幂等且支持销毁后重建；全部测试通过；不新增 embed package export。
```

## 1. 只允许修改的路径（任务单 §2）

| 文件 | 说明 |
| --- | --- |
| `packages/avatar/src/embed/create-avatar.ts` | 新增 `createAvatar()`、`AvatarEmbedOptions`、`AvatarEmbedHandle`；target 解析、属性映射、惰性注册、handle 装配 |
| `packages/avatar/src/embed/index.ts` | 新增 embed 内部模块入口（不暴露为 package subpath） |
| `packages/avatar/src/index.ts` | 仅导出 ADR-0005 批准的 `createAvatar`、`AvatarEmbedOptions`、`AvatarEmbedHandle` |
| `packages/avatar/test/embed.test.mjs` | 新增 Embed 行为测试（任务单 §6 全覆盖） |
| `packages/avatar/test/embed-registration.test.mjs` | 新增「根入口导入无注册副作用」隔离测试（独立子进程） |
| `packages/avatar/test/embed-no-dom.test.mjs` | 新增「无 DOM 环境导入根入口」测试（B4 Review #1 返修） |
| `packages/avatar/src/web-component/pi-avatar.ts` | 最小改动：`PiAvatarElement` 基类回退（B4 Review #1 返修，不改变浏览器行为） |
| `packages/avatar/test/helpers/dom-shim.mjs` | 扩展：`ElementStub.appendChild` 父节点追踪、`document.querySelector`/`document.body`、`SVGElementStub` |
| `packages/avatar/test/helpers/harness.mjs` | 新增共享 `makeFactory()` |
| `packages/avatar/test/public-contract.test-d.ts` | 新增 B4 类型级断言 |
| `packages/avatar/test/vite/build-esm.test.mjs` | 新增 `createAvatar` 导出断言 + 安装 DOM shim（根入口现加载 `<pi-avatar>` 类） |
| `packages/avatar/test/controller.test.mjs` | `AvatarError` import 从根入口改为 `../dist/core/index.js`（消除根入口对 DOM 的传递依赖） |
| `packages/avatar/test/pi-avatar.test.mjs` | 同上（仅 import 路径调整，B2/B3 用例语义不变） |
| `packages/avatar/test/rive-renderer.test.mjs` | 同上（仅 import 路径调整） |
| `docs/avatar/handoffs/B4-embed-sdk.md` | 本交接单 |
| `packages/avatar/README.md` | 新增「Embed 使用（task B4）」最小片段 |

未修改：Core、Renderer、Audio、Testing 实现、公共状态/事件/错误码/Manifest schema、Vite entries、package exports/sideEffects/peerDependencies/files。未新增 `@skdy/avatar/embed` package export（embed 只是内部模块目录，通过根入口转发）。未实现 Agent 通信、语音、React/Vue。`pi-avatar.ts` 仅按 B4 Review #1 做了「类在无 DOM 环境安全求值」的最小改动，B2/B3 浏览器行为不变。

## 2. 输入契约

- **Fake**（`@skdy/avatar/testing`）：`createAvatarTestHarness({ container, renderer? })` + `setControllerFactory()`，不深路径创建 Core Controller（任务单 §6）。
- **`<pi-avatar>`**（B2/B3 已 Review）：`new PiAvatarElement()`、`element.initialize(config)`、`element.destroy()`、`element.remove()`、`element.state`、六个事件。
- **`AvatarConfig`**：`mode/position/width/height/background/autoplay` 为可序列化字段；`character` 可为字符串或 `CharacterManifest`。

## 3. 实现方式

### 3.1 惰性注册与根入口无副作用（ADR-0005 §2）

`create-avatar.ts` 从 `../web-component/pi-avatar.js`（**非** `../web-component/index.js`）导入 `registerPiAvatarElement` 与 `PiAvatarElement`。关键原因：web-component `index.js` 模块加载即调用 `registerPiAvatarElement()`（注册副作用），若根入口静态依赖它，则「仅导入根入口」也会注册，破坏 ADR-0005。`pi-avatar.js` 暴露相同符号但**无加载副作用**，注册只在 `createAvatar()` 内部调用 `registerPiAvatarElement()` 时发生（该函数自带 `customElements.get()` 防护，重复调用安全）。

```text
src/index.ts ──► src/embed/create-avatar.ts ──► src/web-component/pi-avatar.js（无副作用）
                                                     │
                                       createAvatar() 时 registerPiAvatarElement()（guarded）
```

- 根入口 bundle：Vite 把 `<pi-avatar>` 类打进 `dist/pi-avatar-*.js` 共享 chunk（`index.js` 与 `web-component/index.js` 均引用），但注册调用只在 `createAvatar()` 内执行。
- 现有 `sideEffects: ["./dist/web-component/index.js"]` 保持不变：打包器仍会把 web-component 入口当副作用保留，而根入口按需注册语义由代码实现保证。

### 3.2 target 解析（任务单 §5）

- 字符串：`document.querySelector(target)`；选择器非法（`querySelector` 抛）→ `INVALID_CONFIG`；无匹配 → `INVALID_CONFIG`；匹配到非 `HTMLElement`（如 SVG）→ `INVALID_CONFIG`。
- `HTMLElement`：直接使用，清空/替换语义不做（不 touch 已有子节点）。

### 3.3 属性映射与对象 character

- 可序列化字段（`mode/position/width/height/background/autoplay`）经 `element.setAttribute(name, String(value))` 映射为 HTML 属性；`character` 为字符串时也映射为 `character` 属性。
- `CharacterManifest` 对象**不**序列化进 attribute（ADR-0005 §1），通过 `element.initialize(config)` 传递，`config.character` 保持对象引用。

### 3.4 handle 装配

```ts
const ready = element.initialize(config);      // 挂载后初始化，.ready 即本次初始化
return { element, controller: element, ready, destroy };
```

- `controller` 就是新建的 `<pi-avatar>` 元素本身（`PiAvatarElement` 可赋值给 `AvatarController`），因此六个事件与方法原样可用，**不**暴露内部 `CoreAvatarController`（ADR-0005 §1）。
- `ready` 对应本次初始化；失败时 `initialize` reject，`createAvatar` 不 catch、不静默、不自动移除元素（元素保留供宿主读取状态与显式销毁）。
- `destroy()`：先 `element.destroy()`（Controller 幂等销毁），再 `element.remove()`（从 DOM 移除 SDK 创建的元素）。`remove()` 基于父节点追踪，宿主已自行移动/移除元素时也安全（无父节点则为 no-op）。

### 3.5 无 DOM 环境安全求值（B4 Review #1 返修）

`PiAvatarElement extends HTMLElement` 只在浏览器求值；DOM-less Node/SSR 下 `HTMLElement` 未定义，裸 `extends HTMLElement` 会在模块求值阶段抛 `ReferenceError`。现改为从守卫表达式取基类：

```ts
const BaseHTMLElement = (typeof HTMLElement !== "undefined" ? HTMLElement : class {}) as typeof HTMLElement;
export class PiAvatarElement extends BaseHTMLElement { ... }
```

- 浏览器下 `BaseHTMLElement === HTMLElement`，B2/B3 行为逐字节不变。
- 无 DOM 环境下退化为普通 class，模块可完成求值；触碰 DOM 的实例方法只在真实元素存在时被调用，不受影响。
- 根入口 `dist/index.js` 因此可在无 shim 的 Node/SSR 导入，见 `test/embed-no-dom.test.mjs`。

### 3.6 直接 target 的运行时检查（B4 Review #2 返修）

`resolveTarget()` 对直接传入的 target 也做 `instanceof HTMLElement` 检查（经 `isHTMLElement()` 守卫，DOM-less 下 `HTMLElement` 未定义时一律判非），数字、SVG、null、对象等一律抛 `AvatarError("INVALID_CONFIG")` 而非裸 `TypeError`。字符串分支复用同一守卫。

### 3.5 多实例与重建

- 每次 `createAvatar()` 都 `new PiAvatarElement()` 并 appendChild，不隐式替换 target 中已有实例（ADR-0005 §1）。
- 一个 handle `destroy()` 只销毁自己的元素与 Controller，不影响同 target 的其他实例；销毁后可再次 `createAvatar()`。

## 4. 测试与 AC 映射（任务单 §6）

`test/embed.test.mjs`（16 项）+ `test/embed-registration.test.mjs`（2 项）+ `test/embed-no-dom.test.mjs`（2 项）：

| 任务单 §6 要求 | 测试 | AC |
| --- | --- | --- |
| 根入口导入无注册副作用 | importing the root entry does not register `<pi-avatar>`（独立子进程，仅导入根入口） | ADR-0005 §2 |
| 调用时按需安全注册 | createAvatar registers the element lazily and safely on first call / 重复调用 define 不抛 | ADR-0005 §2 |
| selector target | string target resolved via querySelector and mounted | §5 |
| HTMLElement target + 不破坏 DOM | HTMLElement target used directly and existing children preserved | §5 |
| 非法 target | invalid string target throws INVALID_CONFIG / non-HTMLElement throws INVALID_CONFIG | §5 |
| 直接传数字/SVG 等非法 target | direct non-HTMLElement target throws INVALID_CONFIG, not a TypeError | Review #2 |
| 无 DOM 导入 | root entry imports cleanly / target validation still guards with no DOM globals | Review #1 |
| 所有属性映射 | serializable options map to element attributes | §5 |
| 对象 character | object character passed via initialize, not serialized | §5 |
| ready resolve/reject | ready resolves on success / rejects on failure and keeps element | §5 |
| controller 方法与事件 | speak forwards + speech events / public proxy surface + events unchanged | §5 |
| 重复 destroy | destroy is idempotent | §5 |
| 宿主先移除 | destroy safe when host already removed the element | §5 |
| 销毁后重建 | new instance can be created after destroy | §5 |
| 多实例隔离 | multiple instances on same target are isolated | §5 |

类型级断言（`test/public-contract.test-d.ts`）：`createAvatar(options)` 返回 `AvatarEmbedHandle`，`handle.controller` 可赋值 `AvatarController`，`handle.ready` 为 `Promise<void>`，`handle.destroy()` 可调用；`@ts-expect-error` 覆盖 `target` 必填、`target` 仅接受 `string | HTMLElement`。

构建断言（`test/vite/build-esm.test.mjs`）：根入口 `typeof root.createAvatar === "function"`；根入口与 testing 共享 `AvatarError` 类身份；React/Rive 不入根入口静态依赖图；媒体不内联。

## 5. 验证命令与结果（在 `packages/avatar` 内执行）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（exit 0） |
| `npm test` | 通过：**78/78**（core + 契约 + 组件 B2/B3 + 布局 + testing + rive-renderer + embed B4 + 无 DOM 导入） |
| `npm run test:build` | 通过：6/6（根入口可导入、React/Rive 不入基础 bundle、媒体不内联、类身份共享） |
| `npm pack --dry-run` | 通过：产物含 `dist/embed/**`，仅 dist + README + package.json，无源码/测试泄漏 |
| `git diff --check` | 通过（无空白错误） |

## 6. 构建影响

- 根入口 `dist/index.js` 现在传递依赖 `<pi-avatar>` 类（`dist/pi-avatar-*.js` 共享 chunk），但**不**执行注册副作用。原因是 `createAvatar()` 需要实例化该元素，无法避免类加载；注册仍被严格推迟到调用时。
- 由此带来一个必要的测试基础设施调整：`controller/pi-avatar/rive-renderer` 三个 `.test.mjs` 从 `../dist/index.js` 改为 `../dist/core/index.js` 导入 `AvatarError`（镜像既有的 `testing` 类身份共享模式），避免无 shim 的文件意外加载 DOM 依赖。用例语义未变。
- 未改 package exports/sideEffects/files；`npm pack` 产物形态不变，仅新增 `dist/embed/**` 内部模块。

## 7. 已知限制

- 根入口导入会加载 `<pi-avatar>` 类（ADR-0005 只约束「不注册」，未约束「不加载类」）。B4 Review #1 返修后，无 DOM 环境导入不再抛错（`BaseHTMLElement` 回退），但 `createAvatar()` 在无 DOM 下无法真正挂载（`document`/`HTMLElement` 不存在），target 校验会按契约抛 `INVALID_CONFIG`。
- Node DOM shim 无法计算真实布局/事件调度；B4 验证元素挂载、属性映射、惰性注册、销毁语义与事件转发，真实浏览器交互留待 Playwright（B7）。
- `controller === element`（元素即代理），因此 `handle.destroy()` 后 `handle.controller` 仍指向已销毁元素；宿主应通过 `handle` 而非保留的 controller 引用做生命周期管理（与 ADR-0005 语义一致）。

## 8. 契约变更请求

**无。** 未发现现有契约无法表达 B4 需求；未新增 package export、公共类型之外的符号、事件或错误码，未修改协议版本/Manifest schema/Vite entries。

## 9. 遗留事项

- 生产 `setControllerFactory()` 注入与真实 Visual Runtime 组合仍属 A6/A9（AI-A 侧），B4 用 Fake 验收。
- **B5 React 适配器未开始。** 当前路线中的 Agent 通信不是 B5，而是后续独立阶段。交接状态：**Ready for AI-A Re-Review**，等待 Review 后由 AI-A 放行后续阶段。
