# B3 交接：`<pi-avatar>` inline/floating 布局

状态：Approved by AI-A（2026-08-10；B4 可启动）
作者：AI-B（经济模型/实现者）
日期：2026-08-10（初审 2026-08-10，复修同日）
依赖：B2（已通过 AI-A 二次 Review）、A3（Fake 夹具）、A4（构建审定）

## 任务 ID：B3

```text
按 B3 任务单实现 <pi-avatar> 的 Shadow DOM inline/floating 布局与响应式样式
完成标准（任务单 §8）：inline/floating 均有明确且隔离的 Shadow DOM CSS；
左下/右下、safe-area、z-index、offset 和移动端约束均在 CSS 中表达；
不新增公共 JS API 或 HTML 属性；B2 测试与新增布局测试全部通过。
```

## 1. 只允许修改的路径（任务单 §2）

| 文件 | 说明 |
| --- | --- |
| `packages/avatar/src/web-component/pi-avatar.ts` | 新增 `AVATAR_LAYOUT_CSS`、`#ensureLayoutStyle()`、`#canonicalMode()`/`#canonicalPosition()`；`#applyLayoutAttributes()` 尺寸只落宿主、规范化 data 属性；floating 最大尺寸扣除 offset/safe-area |
| `packages/avatar/test/pi-avatar-layout.test.mjs` | 新增布局测试（任务单 §7 全覆盖 + B3 Review 回归） |
| `packages/avatar/test/pi-avatar.test.mjs` | 随 B3 Review #1 更新两处尺寸断言（尺寸从 stage 改为宿主），B2 语义不变 |
| `packages/avatar/test/helpers/dom-shim.mjs` | 仅增加布局测试所需最小能力：`ElementStub.matches("[data-avatar-layout]")` 与 `textContent` getter/setter |
| `docs/avatar/handoffs/B3-handoff.md` | 本交接单 |
| `packages/avatar/README.md` | 布局使用消费者说明 |

未修改：Core、Renderer、Audio、Testing、Vite entries、package exports、`package.json` 冻结字段（name/version/exports/sideEffects/peerDependencies/files）。B2 三个已 Review 修改（character 竞态、initialize 期间 pending state、autoplay 语义）与样式移除清理语义均保留。

## 2. 输入契约

- **类型/方法**（`@skdy/avatar/core`）：`AvatarDisplayMode`、`AvatarPosition` 仅用于内部规范化辅助函数（type-only import，不改变公共类型）。
- **B2 语义保持不变**：`#initializePromise` / `#pendingState`、`character` 变更重建、`autoplay` 仅作 config 字段、移除 width/height/background 清内联样式。
- **Fake**（`@skdy/avatar/testing`）：`createAvatarTestHarness({ container })` 验证「动态切换 mode/position 不重建 Controller」。

## 3. DOM/CSS 结构

```text
<pi-avatar>
  #shadow-root
    <style data-avatar-layout>     ← 每个实例恰一份，重连复用
    <div data-avatar-stage>        ← 复用 B2 唯一 stage 容器
```

- 使用普通 `<style>`（任务单 §5，不引入 Constructable Stylesheet）。
- style 经 `#ensureLayoutStyle()` 在 `#createController()` 中惰性创建；`attachShadow` 后查询 `[data-avatar-layout]`，存在则不再插入，因此断开重连不会重复（§4.1）。
- 布局样式全部在 Shadow DOM 内，不向 `document.head` 插入，不修改 `html/body`，不注册全局 class。

## 4. 五个 CSS 变量的实际默认值（§4.5 冻结）

```css
--pi-avatar-width: 320px;
--pi-avatar-height: 480px;
--pi-avatar-z-index: 1000;
--pi-avatar-offset-x: 16px;
--pi-avatar-offset-y: 16px;
```

- 变量定义在 `:host`，宿主可在 `<pi-avatar>` 上覆盖。
- `width`/`height` HTML 属性的内联样式只落在宿主，优先于 CSS 变量；stage 通过 `width: 100%; height: 100%` 填充宿主（§4.5 + B3 Review #1）。
- `background` 落在 stage（renderer 绘制容器）。
- 未新增同义变量，未使用 `skdy-*` 或 Rive 专有变量名。

## 5. inline/floating 与 position 映射

| 输入 | 结果 |
| --- | --- |
| `mode` 缺失 / 非法 | inline：`:host([mode="floating"])` 不匹配，元素在文档流，不使用 `position: fixed` |
| `mode="floating"` | 固定定位，相对视口悬浮，默认右下角 |
| `position="bottom-left"` | 左下角（`right: auto; left: calc(offset + safe-area-left)`） |
| `position` 缺失 / 非法 / `bottom-right` | 右下角（`right: calc(offset + safe-area-right)`） |
| 动态切换 mode/position | 立即更新，不重建 Controller（`attributeChangedCallback` 只调 `#applyLayoutAttributes()`） |

- CSS 侧通过 `:host([mode="floating"])` / `:host([mode="floating"][position="bottom-left"])` 属性选择器表达，非法值天然不匹配即回退，无需 JS 判断布局。
- DOM 侧 `data-avatar-mode` 只能是 `inline | floating`，`data-avatar-position` 只能是 `bottom-left | bottom-right`；非法输入经 `#canonicalMode()`/`#canonicalPosition()` 回退，不把原始值写入 data 属性（§6）。

## 6. safe-area / 移动端策略

- floating 的 `right`/`bottom`/`left` 均叠加 `env(safe-area-inset-*)`，非刘海/挖孔屏为 0，不影响桌面。
- **B3 Review #2**：floating 的 `max-width`/`max-height` 按实际可用视口计算，扣除两侧 offset 与所有 safe-area inset，否则全宽 host（320px）+ 16px 内偏移会在 320px 视口下左侧溢出 16px，高度同理：
  ```css
  max-width: calc(100vw - var(--pi-avatar-offset-x) * 2
    - env(safe-area-inset-left) - env(safe-area-inset-right));
  max-height: calc(100vh - var(--pi-avatar-offset-y) * 2
    - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  max-height: calc(100dvh - var(--pi-avatar-offset-y) * 2
    - env(safe-area-inset-top) - env(safe-area-inset-bottom)); /* 覆盖上行 */
  ```
  两侧均扣除使同一规则对左下/右下两个角落都成立；`100vh` 为 `100dvh` 的回退（B3 §4.4）。
- `:host` 与 `[data-avatar-stage]` 基础规则设 `max-width: 100vw`、`max-height: 100vh` + `100dvh`（后者优先，前者回退）。
- stage `overflow: hidden`、`box-sizing: border-box`，Canvas/子内容限制在容器内，stage 不溢出 host。
- 无 JavaScript resize 监听；响应式约束全部由 CSS 完成（§4.4）。窄屏下角色比例责任归属 renderer，B3 只保证容器不溢出。
- 无硬编码不可覆盖的 z-index 与边距：z-index 与 offset 均走 CSS 变量。

## 7. 新增测试与 AC 映射

`test/pi-avatar-layout.test.mjs`（13 项）：

| 任务单 §7 要求 | 测试 | AC 映射 |
| --- | --- | --- |
| 1. Shadow 中只存在一个 layout style | shadow root contains exactly one layout style | AC-02 |
| 2. 断开重连 style 不重复 | reconnect does not duplicate the layout style | AC-02 / AC-08 |
| 3. 默认 inline / bottom-right | default mode is inline and default position is bottom-right | AC-03 基础 |
| 4. floating + bottom-right 映射 | floating + bottom-right maps canonical attributes | AC-11 基础 |
| 5. floating + bottom-left 映射 | floating + bottom-left maps canonical attributes | AC-11 基础 |
| 6. 动态 inline/floating 不重建 Controller | switching inline/floating does not rebuild the controller | AC-03 / AC-08 |
| 7. 动态 bottom-left/bottom-right 不重建 Controller | switching bottom-left/bottom-right does not rebuild the controller | AC-03 / AC-08 |
| 8. 非法 mode/position 回退规范值 | invalid mode/position fall back to canonical defaults | AC-03 基础 |
| 9. 五个冻结变量及默认值 | layout CSS defines the five frozen custom properties with defaults | 任务单 §4.5 |
| 10. safe-area 与动态视口约束 | layout CSS contains safe-area and dynamic viewport constraints | AC-11 |
| 11. B2 回归继续通过 | 由 `test/pi-avatar.test.mjs` 全部通过保证（character 竞态 / pending state / autoplay / 样式移除） | AC-01/03/05/08 |

B3 Review 追加：

| 来源 | 测试 | 说明 |
| --- | --- | --- |
| Review #1 | width/height/background attributes style the host and stage | 尺寸只落宿主，`background` 落 stage；移除清理语义保留 |
| Review #1 | percentage width is not compounded onto the stage | `width="50%"` 时 stage 无内联尺寸，保持 CSS 100% 填充，不会缩成 25% |
| Review #2 | floating max-size CSS reserves offsets and safe areas | floating 块含扣除 `offset-x/offset-y × 2` 与四个 safe-area 的 max-width/max-height，且保留 `100vh` 回退 + `100dvh` 覆盖 |

## 8. 验证命令与结果（在 `packages/avatar` 内执行）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（exit 0） |
| `npm test` | 通过：58/58（core 10 + 契约/构建 4 + 组件 B2 18 + 布局 B3 13 + testing 4 + rive-renderer 8）；连续 3 次运行一致 |
| `npm run test:build` | 通过：6/6（含 React 不入基础产物、媒体不内联、Rive 不入公共包） |
| `npm pack --dry-run` | 通过：产物仅含 dist + README + package.json，无源码/测试泄漏 |
| `git diff --check` | 通过（无空白错误） |

## 9. 已知限制

- **一次性观测到的 AI-A 侧 flake**：初审时首次运行 `npm test` 时 `test/rive-renderer.test.mjs`（AI-A 未提交的 A5 产物）在加载 `@rive-app/canvas` 命名导出时抛出一次 `SyntaxError: The requested module '@rive-app/canvas' does not provide an export named 'Rive'`。随后多次完整 `npm test`（55/55、58/58）均通过，无法复现，判断为 Node ESM 对 CJS 包命名导出的瞬时解析问题，属 AI-A 的 `src/renderers/rive/**` 范围，B3 未触碰。
- Node DOM shim 无法计算真实 CSS 布局；B3 单测验证 DOM、规范化值、样式隔离与 CSS 契约，真实视口与浏览器布局（含 Review #2 的实际无溢出）留待 B7 Playwright（任务单 §7 末段）。B3 已提供可测结构：唯一 `[data-avatar-layout]` style 与 stage data 属性。
- 未新增 HTML 属性：z-index、offset、mobile-width 等均通过冻结 CSS 变量配置（§3）。

## 10. 契约变更请求

**无。** 未发现现有契约无法表达 B3 需求的情形；未需要新增 HTML 属性、公共类型、事件或错误码，未需要 JS ResizeObserver，未修改 Vite entries/package exports。

## 11. 遗留事项

- 真实 controller 组合层与生产 `setControllerFactory()` 注入仍属后续任务。
- B4（`createAvatar()` Embed SDK）未开始。B3 完成后等待 AI-A Review，不自行启动 B4。
