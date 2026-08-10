# B5 交接：React 薄适配器 `PiAvatar`

状态：**Ready for AI-A Re-Review**（已通过自测：typecheck / 全量 test / test:build / pack / react 未打包）
作者：AI-B（经济模型/实现者）
日期：2026-08-10
依赖：B2（Approved）、B3（Approved）、B4（Approved）、ADR-0005（冻结契约）、React 19（可选 peer）

## 任务 ID：B5

```text
按 B5 任务单实现 React 薄适配器（forwardRef 细粒度包装）
完成标准（任务单 §4/§5/§6）：从 @skdy/avatar 的 react 入口导出 PiAvatar 与 PiAvatarProps；
PiAvatar 用 forwardRef<PiAvatarElement> 让宿主经 ref 调用已有 Controller 方法，不复制核心状态机/音频/Rive 逻辑；
props 冻结为任务单所列清单；属性变更改属性不重建元素/Controller；unmount 调用 destroy；ref 指向真实 PiAvatarElement，
卸载后置 null；事件监听只注册一组、始终调用最新回调；不把 React 打进产物（外部化 + 可选 peer）。
```

## 1. 只允许修改的路径（任务单 §2 满足）

| 文件 | 说明 |
| --- | --- |
| `packages/avatar/src/react/pi-avatar.ts` | 新增 `PiAvatar`、`PiAvatarProps`；forwardRef 细粒度包装 |
| `packages/avatar/src/react/index.ts` | 新增 react 入口导出 |
| `packages/avatar/test/react-adapter.test.mjs` | 新增 12 个 React 适配器行为测试（jsdom + 真实 ControllerFactory 夹具） |
| `packages/avatar/package.json` | 仅新增 react/react-dom/@types/react/jsdom 为 **devDependencies**；react 保持可选 peer（范围不变） |
| `packages/avatar/package-lock.json` | 随 devDependencies 更新 |
| `packages/avatar/README.md` | 新增「React 使用（task B5）」最小片段（任务单 §3 未列入；仅文档，已声明） |

未修改：Core、Renderer、Audio、Testing 实现、公共状态/事件/错误码/Manifest schema、`package.json` 的 exports/sideEffects/peerDependencies 范围、Vite entries、Web Component 语义。`vite.config.ts` 未改动（react 入口已存在且已 `external: /^react($|\/)/`）。未新增 `@skdy/avatar/react` 之外的 package export。React 仅出现在 devDependencies 与可选 peer，未被打包进 `dist/`。

## 2. 设计说明

`PiAvatar` 是 `<pi-avatar>` 的薄包装，职责被压缩到最小：

- **forwardRef**：ref 直接转发到真实 `PiAvatarElement`，宿主经 ref 调用已有的命令式 `AvatarController` 方法（`setState`/`speak`/`show`/`hide`/`destroy` 等），不重复暴露任何控制器逻辑。
- **属性用 `useLayoutEffect` 命令式写入**：不做属性透传。React 默认把未知 props 反射为自定义元素**属性（property）**，而 `PiAvatarElement.state` 是只读 getter——直接传参会抛 `Cannot set property state…`。改为在 effect 里对受支持属性 `setAttribute`/`removeAttribute`，并精确控制「prop 移除即移除属性」。
- **事件：一组原生监听、始终最新回调**：用 `handlersRef` 保存每个 `onAvatar*` 的最新版本；只在元素挂载时注册一组监听（空依赖数组），派发时走 `handlersRef.current[prop]`，因此重传回调不会重复注册、不会双触发、不会重建元素。
- **不注册副作用**：模块加载只调用受保护的 `registerPiAvatarElement()`（幂等防重注册），保证只 import React 入口也能拿到已定义元素。
- **尺寸归一化**：数值 → `px`（`320` → `320px`），字符串（含 `50vh`）原样透传；`autoplay=false` 表达为可识别的 `"false"` 属性。

## 3. 覆盖的验证点（任务单 §5 全覆盖）

| 验证点 | 结果 |
| --- | --- |
| 首次渲染产生单个 `<pi-avatar>` | PASS（`renders a single…`） |
| 序列化 props 映射为元素属性（含数值→px） | PASS |
| `autoplay` true/false/absent 三种形态 | PASS |
| props 更新改变属性但不重建元素/Controller | PASS（`props updates…`） |
| 可选 prop 移除时移除对应属性 | PASS |
| character 变更按 B2 latest-wins 重初始化、元素复用 | PASS（`character change…`） |
| 六个事件回调收到公共 detail | PASS（`six event callbacks…`） |
| 回调更新调用最新处理器、不重注册监听 | PASS（`callback updates…`） |
| ref 转发到真实 `PiAvatarElement`、暴露控制器方法 | PASS |
| unmount 销毁 renderer + audio、ref 置 null、DOM 清空 | PASS |
| destroy 幂等安全 | PASS |
| 状态更新（prop 变更）经 Controller 转发到 renderer | PASS（`state update…`） |
| 多实例同树互不干扰、卸载单个不影响他者 | PASS（`two PiAvatar instances…`） |
| StrictMode mount/unmount/mount 不泄漏、仅一个活 Controller | PASS（`StrictMode double-invokes…`） |

## 4. 测试/构建结果

```text
npm run typecheck             PASS（tsc -p tsconfig.json --noEmit，0 错误）
npm test                      PASS（113/113，含 12 个 react-adapter 用例）
npm run test:build            PASS（7/7，验证 react/react-dom 未进入基础运行时 bundle）
npm pack --dry-run            PASS（@skdy/avatar@0.1.0-alpha.0）
```

React 外部化证据：`dist/react/pi-avatar.js` 仅有 `import * as React from "react"`，无任何 React 内部实现被内联；`vite` 构建测试断言 React 从不进入 base 运行时 bundle。

## 5. 已知限制

- 第一阶段 `character` 只接受 manifest URL 字符串（与元素属性一致，任务单冻结）。对象 manifest 走 `createAvatar()` / 命令式元素 API。
- jsdom 无法计算真实布局/事件调度；B5 验证属性映射、生命周期、事件转发与 ref 语义，真实浏览器交互（StrictMode 生产、并发渲染、Suspense 边缘）留待 Playwright（B7）。
- React 18 与 19 均兼容（peer `>=18.0.0` 不变）；`createRoot` 异步提交已用轮询 settle 覆盖，未绑定具体 React 大版本实现细节。
- 任务单 §3 允许修改清单未列 `README.md`；为与 B4/B3 handoff 一致新增了「React 使用」最小片段（仅文档，无实现影响）。

## 6. 遗留事项

- 生产 `setControllerFactory()` 注入与真实 Visual Runtime 组合仍属 A6/A9（AI-A 侧）；B5 用 `createAvatarTestHarness` Fake 验收。
- **B6 / React Router 之外的后续阶段未开始。** 交接状态：**Ready for AI-A Re-Review**，等待 Review 后由 AI-A 放行后续阶段。