# B6 任务单：Vanilla、React、Vue 示例

状态：Blocked until B4、B5、A6-PREVIEW approved  
执行者：AI-B（经济模型/实现者）  
前置：B3～B5、A6-PREVIEW

## 1. 目标

交付三个最小但完整的消费者示例，证明不同技术栈共享同一正式 `dist`，没有复制 Controller、Rive、音频或状态机代码。

## 2. 允许修改

- `packages/avatar/examples/vanilla/**`
- `packages/avatar/examples/react/**`
- `packages/avatar/examples/vue/**`
- `packages/avatar/examples/` 下共享 Vite 配置、私有 package.json/lock 和说明
- 示例运行所需的 test fixture/静态资源引用
- `docs/avatar/handoffs/B6-framework-examples.md`

不得从 `src/**` 深路径导入，不得把 demo 资产静态 import 进 SDK，不得新建 Vue adapter package export。

## 3. 三个示例必须具备

- 使用同一套 production build 文件和同一个 demo manifest URL。
- 展示 ready/state/error/speech 事件日志。
- P2 先提供五状态切换、destroy/recreate 控件；播放、stop、interrupt 在 A9 完成后补入最终示例。
- 展示 inline/floating、左右位置和尺寸/CSS 变量配置。
- 页面说明浏览器用户手势和 CORS 要求。

### 技术栈要求

- Vanilla：至少演示 `<pi-avatar>` 直接使用和 `createAvatar()` 使用之一，README 同时给另一种简例。
- React：只使用 `@skdy/avatar/react` 的 `PiAvatar` 与公开类型。
- Vue：使用 Custom Element 或根入口 Embed SDK；在编译器中把 `pi-avatar` 标记为 custom element，不复制 wrapper 状态。

## 4. 构建与体验

- `packages/avatar/examples` 可独立安装、启动和 production build。
- 示例依赖可以放入 examples 私有 package，不修改 Avatar 的生产 dependencies。
- Manifest URL 可通过单一环境变量配置，缺失时显示可理解提示。
- 三个页面均无 console error/unhandled rejection，销毁后可重建。
- 提供桌面和 375px floating 截图；涉及播放/销毁流程提供短录屏或等价自动证据。

### 两个验收检查点

1. `B6-Visual`：A6-PREVIEW 后完成三框架真实角色、五状态和销毁重建，交付用户预览；不等待语音。
2. `B6-Final`：A9 后补入真实 play/stop/interrupt 和事件日志，再把 B6 状态改为 Complete。

`B6-Visual` 通过不代表完整 B6 或第一阶段发布验收通过。

## 5. 验证与交接

除 Avatar 完整门禁外，运行 examples clean install/build 和三页手工 smoke。handoff 列出启动命令、URL、dist 引用证明、截图、A9 真实资产待办（如尚未完成），明确“B7/B8 未开始”。等待 Review。
