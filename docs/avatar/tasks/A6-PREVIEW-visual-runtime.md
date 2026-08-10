# A6-PREVIEW 任务单：真实数字人视觉预览

状态：Complete（等待用户视觉确认；全仓门禁待并行 B5 收口后复跑）  
执行者：AI-A（强模型/技术负责人）  
前置：A5 Rive Renderer、A6 Manifest loader  
优先级：当前最高；先于 A7/A8 语音任务执行。

## 1. 完成后用户能看到什么

- 浏览器加载真实 Rive 角色。
- 手工切换 `idle/listening/thinking/speaking/error` 五种视觉状态。
- inline/floating 和左右角布局生效。
- resize、销毁、重新创建正常。
- 不需要 Agent runtime、TTS、音频播放器或嘴型采样。

## 2. 允许修改

- `packages/avatar/src/runtime/**` 中 renderer-only production runtime skeleton
- `packages/avatar/src/web-component/**` 中默认 Controller factory 接入
- `packages/avatar/assets/characters/demo/**`
- `packages/avatar/dev/preview/**`（最小内部预览页）
- A6-PREVIEW 单元、集成和浏览器 smoke 测试
- `docs/avatar/handoffs/A6-PREVIEW-visual-runtime.md`

不得修改公共状态、事件、错误码、Manifest schema、package exports；不得实现 Agent/TTS/音频。

## 3. 必须实现

### Visual Runtime

- 使用 A6 loader 得到已校验 Manifest。
- 动态创建 A5 `RiveAvatarRenderer` 并初始化到 Web Component stage。
- `setState()`、`setAudioLevel()` 转发 renderer；预览页只使用 state，手工 audioLevel 可作为内部调试但不是公开新 API。
- `ResizeObserver` + 初次尺寸读取驱动 renderer resize，传递有限 DPR。
- show/hide、destroy、初始化中 abort、多实例隔离完整。
- `startSpeech()` 在预览检查点明确 reject 已有 `AUDIO_PLAYBACK_FAILED`，message 说明语音能力尚未安装；不得 resolve 或伪装播放。

### 默认工厂

- 未显式调用 `setControllerFactory()` 时，Web Component 使用 Visual Runtime 创建真实 Controller。
- 测试 factory 覆盖仍可用，并能恢复默认。
- Rive SDK 保持动态/按需加载，不进入 root/core/web-component 基础 chunk。
- 根入口导入仍不自动注册 Custom Element。

### Demo 资源

- 提供合法 demo Manifest，五种状态映射完整且 input 名唯一。
- 必须使用真实、获准使用并记录来源/许可证的 `.riv` 文件或稳定资源。
- 缺少合法资产时不得伪造；这是 P1 唯一允许上报的外部阻塞项。

### 最小预览页

- 从正式 production build 导入，不从 `src` 深路径导入。
- 显示角色、当前状态、ready/error 日志和五个状态按钮。
- 支持 inline/floating、bottom-left/bottom-right、destroy/recreate。
- 不展示可用语音按钮，不需要 React/Vue。

## 4. 必须测试

Manifest URL/object、默认/覆盖 factory、五状态、动态 Rive chunk 边界、resize/DPR、show/hide、初始化中 destroy、重复 destroy、多实例、角色加载错误和无 unhandled rejection。

浏览器 smoke 至少覆盖桌面和 375px floating，并保存截图。验证命令包括完整 typecheck/test/build/pack/diff-check 和预览页 production build。

## 5. 交接与停止

创建 A6-PREVIEW handoff，提供预览启动命令、URL、截图、资产来源、bundle 证明和交给 B6/A9 的内部入口。完成后等待用户确认视觉预览，不自动启动 A7。
