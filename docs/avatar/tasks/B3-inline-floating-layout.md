# B3 任务单：inline/floating 布局

状态：Complete（AI-A 二次 Review 通过，2026-08-10）  
执行者：AI-B（经济模型/实现者）  
前置：B2 已通过 AI-A 二次 Review  
任务边界：只实现 `<pi-avatar>` 的 Shadow DOM 布局与响应式样式，不实现 Rive、音频、业务 UI 或新的公共 JavaScript API。

## 1. 开始前必须阅读

1. `docs/avatar/PHASE-1-DEVELOPMENT-PLAN.md`
2. `docs/avatar/handoffs/B0-contract-usage-checklist.md`
3. `docs/avatar/handoffs/A3-testing-fixtures.md`
4. `docs/avatar/handoffs/A4-build-approval.md`
5. `docs/avatar/handoffs/B2-handoff.md`
6. `packages/avatar/src/web-component/pi-avatar.ts`
7. `packages/avatar/test/pi-avatar.test.mjs`

开始前先检查工作区，确认 B2 的三个已 Review 修改仍然存在，不得覆盖或回退它们。

## 2. 允许修改

- `packages/avatar/src/web-component/**`
- `packages/avatar/test/pi-avatar*.test.mjs`
- B3 必需的 DOM 测试辅助代码；如需修改 `test/helpers/dom-shim.mjs`，只能增加布局测试所需的最小能力
- `docs/avatar/handoffs/B3-handoff.md`
- `packages/avatar/README.md` 中与布局使用有关的消费者说明

## 3. 禁止修改

- `packages/avatar/src/core/**`
- `packages/avatar/src/renderers/**`
- `packages/avatar/src/audio/**`
- `packages/avatar/src/testing/**`
- `packages/avatar/package.json` 的 exports、sideEffects、peerDependencies、files
- `packages/avatar/vite.config.ts` 的构建入口
- 公共状态、事件、错误码、Controller 和 Character Manifest
- B2 已通过 Review 的初始化竞态、pending state、autoplay 和样式清理语义

B3 不得新增 `z-index`、offset、mobile-width 等 HTML 属性。需要配置的布局值通过下文冻结的 CSS Custom Properties 暴露。

## 4. 必须实现的布局行为

### 4.1 Shadow DOM 样式隔离

- 布局 CSS 必须放在 `<pi-avatar>` 的 Shadow DOM 中。
- 不向 `document.head` 插入 style，不修改全局 `html/body`，不注册全局 class。
- 每个元素实例只创建一份布局 style；断开重连不能重复插入。
- 继续复用 B2 的唯一 `[data-avatar-stage]` 容器。

### 4.2 inline 模式

`mode` 缺失或非法时回退为 `inline`。

- 元素参与宿主页面正常文档流，不使用 `position: fixed`。
- 默认尺寸为宽 `320px`、高 `480px`。
- `width`、`height` 属性继续使用 B2 的内联样式覆盖默认尺寸。
- stage 不得溢出 host，Canvas/子内容必须限制在容器内。

### 4.3 floating 模式

`mode="floating"` 时：

- host 使用固定定位，相对浏览器视口悬浮。
- 默认位置为右下角。
- `position="bottom-left"` 固定左下角。
- `position="bottom-right"` 固定右下角。
- position 缺失或非法时回退为 `bottom-right`。
- 必须考虑 `env(safe-area-inset-left/right/bottom)`。
- 不得硬编码不可覆盖的 z-index 和边距。

### 4.4 移动端和视口约束

- stage 最大宽度不能超过可用视口宽度。
- stage 最大高度不能超过可用动态视口高度，优先使用 `100dvh`，并提供合理回退。
- 在窄屏下保持角色比例的责任属于 renderer；B3 只保证容器不溢出。
- 不得通过 JavaScript 监听 resize；第一阶段使用 CSS 响应式约束。

### 4.5 冻结的 CSS Custom Properties

```css
--pi-avatar-width: 320px;
--pi-avatar-height: 480px;
--pi-avatar-z-index: 1000;
--pi-avatar-offset-x: 16px;
--pi-avatar-offset-y: 16px;
```

- CSS 变量提供上述默认值，但允许宿主在 `<pi-avatar>` 上覆盖。
- `width`/`height` HTML 属性的内联样式优先于 CSS 变量。
- 不新增同义变量，不使用 `skdy-*` 或 Rive 专有变量名。

## 5. 推荐 DOM 结构

保持最小结构，不提前加入工具栏或按钮：

```text
<pi-avatar>
  #shadow-root
    <style data-avatar-layout>
    <div data-avatar-stage></div>
```

第一阶段优先使用普通 `<style>`，不引入 Constructable Stylesheet 兼容成本。

## 6. 属性规范化

- stage 的 `data-avatar-mode` 只能是 `inline | floating`。
- stage 的 `data-avatar-position` 只能是 `bottom-left | bottom-right`。
- 非法输入按第 4 节回退，不把非法原始值写入 data 属性。
- 动态切换 mode/position 必须立即更新布局，不重建 Controller。
- 动态移除 width/height/background 必须继续保留 B2 已通过的清理行为。

## 7. 必须新增的测试

至少覆盖：

1. Shadow Root 中只存在一个 `[data-avatar-layout]` style。
2. 断开重连后 style 不重复。
3. 默认 mode 为 inline，默认 position 为 bottom-right。
4. floating + bottom-right 映射正确。
5. floating + bottom-left 映射正确。
6. 动态切换 inline/floating 不重建 Controller。
7. 动态切换 bottom-left/bottom-right 不重建 Controller。
8. 非法 mode/position 回退到默认规范值。
9. 布局 CSS 包含五个冻结变量及默认值。
10. 布局 CSS 包含 safe-area 和动态视口约束。
11. B2 的 character 竞态、pending state、autoplay 与样式移除回归测试继续通过。

Node DOM shim 无法计算真实 CSS 布局。B3 单测验证 DOM、规范化值、样式隔离和 CSS 契约；真实视口与浏览器布局留给 B7 Playwright，但 B3 必须准备好可测结构。

## 8. 验收标准

- inline/floating 均有明确且隔离的 Shadow DOM CSS。
- 左下/右下、safe-area、z-index、offset 和移动端约束均在 CSS 中表达。
- 不新增公共 JavaScript API 或 HTML 属性。
- 所有 B2 测试继续通过，新布局测试全部通过。
- TypeScript、完整测试、production build 和构建测试通过。
- React/Rive 不进入 root/core/web-component。

必须运行：

```text
npm run typecheck
npm test
npm run test:build
npm pack --dry-run
git diff --check
```

## 9. 必须停止并请求 AI-A 的情况

- 需要新增 HTML 属性或公共 TypeScript 类型。
- 需要修改 AvatarConfig、Controller、事件或错误码。
- 需要修改 Vite entries/package exports。
- 需要 JavaScript ResizeObserver 才能完成需求。
- B2 生命周期语义与布局实现发生冲突。
- Shadow DOM 无法满足某个宿主覆盖需求。

按开发计划的“契约变更请求”格式报告，并继续不受阻塞影响的工作。

## 10. 交接要求

完成后创建 `docs/avatar/handoffs/B3-handoff.md`，包含：

- 修改文件
- DOM/CSS 结构
- 五个 CSS 变量的实际默认值
- inline/floating 和 position 映射
- safe-area/移动端策略
- 新增测试与 AC 映射
- 全部验证命令及结果
- 已知限制
- 契约变更请求（没有则写“无”）
- 明确写明“B4 未开始”

完成后等待 AI-A Review，不得自行启动 B4。
