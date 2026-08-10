# B6 任务单：独立前端项目嵌入与发布验证

状态：Completed（AI-A Review #3 Accepted）
执行者：AI-B（经济模型/实现者）
前置：B4、B5、A6-PREVIEW
范围：Visual MVP；不实现 Agent、语音、嘴型，不开发新的框架适配器。

> 文件名为兼容既有链接保留；任务内容已从“三框架示例”调整为“一个通用产物的消费者验证”。

## 1. 目标

证明 `@skdy/avatar` 是可以交付给已有前端项目的独立包，而不只是仓库内部 Demo：

1. Avatar 包能够完成 production build 和 `npm pack`。
2. 一个与 Avatar 源码隔离的消费者前端，能够安装生成的 `.tgz` 包。
3. 消费者只通过公开入口使用数字人，不引用 `src/**` 或仓库内部模块。
4. 浏览器能展示真实 Rive 角色，并完成状态切换、布局切换、销毁和重建。

这一步验证的是“可发布、可安装、可嵌入”。不执行真实 npm registry 发布；正式发布需要用户另行确认 registry、包版本和凭据。

## 2. 技术策略

- 只建立一个独立的最小消费者项目，模拟任意已有前端项目。
- 默认使用 Vite + 原生 TypeScript/JavaScript，避免把某个业务框架变成产品依赖。
- 消费者优先通过根入口 `createAvatar()` 使用；可额外展示 `<pi-avatar>`，但不是必需。
- React B5 保留为可选语法糖，不是当前发布验收的前置使用方式。
- 不新增 Vue、Angular、Svelte 等专用 wrapper 或 package export。

## 3. 允许修改

- `packages/avatar/examples/consumer/**`
- `packages/avatar/test/consumer*.test.*`
- 消费者安装/构建验证脚本
- `docs/avatar/handoffs/B6-consumer-integration.md`
- 必要的消费者 README

禁止修改 Core、Renderer、Audio、Manifest schema、公共事件和 package exports。不得从消费者导入 `src/**`、`dist/**` 深路径或 Testing 入口。

## 4. 必须实现

### 独立消费者

- 有自己的 `package.json`、Vite 配置和入口文件。
- 依赖来自 `npm pack` 生成的 `@skdy/avatar` tarball，而不是 workspace/link/file 源码目录。
- 页面展示真实数字人、ready/error 日志和五状态按钮。
- 支持 inline/floating、左右位置、destroy/recreate。
- 页面不出现 Agent、speech、TTS、录音或音频按钮。

### 发布前验证

- Avatar `npm run build` 成功。
- `npm pack --dry-run` 内容正确，生产必需文件齐全。
- 实际生成 `.tgz` 后，消费者执行 clean install 和 production build 成功。
- 消费者产物不引用 Avatar 仓库绝对路径或 `src/**`。
- 在桌面与 375px 浏览器中可见角色，无 console error/unhandled rejection。

### B5 Follow-up

补充回归：仅更新 `state/background/mode/position/size` 时不得重建 Controller；只有 `character` 真正变化时才允许按 B2 语义重建。修复仅限 `src/react/**` 和 React 测试。

## 5. 验收与交接

必须提供：

- 从 pack 到消费者安装、构建、启动的完整命令。
- 消费者使用的公开 import 证明。
- 桌面和 375px 截图。
- build、pack、consumer clean install/build、浏览器 smoke 结果。
- 明确记录“未真实发布 registry；未实现 Agent/语音”。

完成后创建 `docs/avatar/handoffs/B6-consumer-integration.md`，等待 AI-A Review，不自动进入其他任务。
