# ADR-0004：Rive Renderer 运行时与输入映射

状态：Accepted  
日期：2026-08-10  
决策人：AI-A（A5）

## 背景

第一阶段需要真实 Rive Canvas renderer，同时必须保持 Core、Web Component 和 testing bundle 不依赖 Rive SDK。Character Manifest 已冻结为标准状态与 Rive input 名称的映射。

## 决策

1. 使用官方 `@rive-app/canvas` `2.39.2`，版本精确锁定。
2. SDK 只允许在 `src/renderers/rive/**` 中出现；Rive renderer 继续是内部实现，不新增 npm package export。
3. Renderer 创建并拥有一个 Canvas，但不拥有宿主 stage；销毁时只移除自己的 Canvas。
4. 使用 Manifest 的 `stateMachine` 启动单个状态机，并保持 Rive 动画 autoplay。
5. `AvatarConfig.autoplay` 不控制 Renderer 初始化或状态机播放，它保留给后续语音层。
6. 状态映射兼容 Boolean、Number 和 Trigger：Boolean 使用 true/false，Number 使用 1/0，Trigger 只在目标状态激活时 fire。
7. `audioLevel` 只接受 Number input，并在 Renderer 内再次钳制到 `0..1`。
8. Manifest 映射到不存在的 input、重复 input 或错误的 audioLevel 类型时抛 `INVALID_MANIFEST`。
9. resize 使用显式 CSS 像素和 DPR，并调用官方 `resizeDrawingSurfaceToCanvas(dpr)`。
10. 外部 AbortSignal 或直接 `destroy()` 都必须终止待完成的初始化、清理 Rive/WASM 并移除 Canvas。
11. 自动处理 Rive Events 和 Rive Listeners 默认关闭，避免数字人资源隐式打开 URL或拦截宿主页面输入。

## 输入系统说明

Rive 官方当前推荐新项目使用 Data Binding，并将 State Machine Inputs 标记为旧式方案。本阶段仍使用 inputs，因为公共 Manifest 已冻结且第一阶段资源映射简单。该兼容逻辑完全封装在 Renderer 内；未来切换 Data Binding 时不修改 AvatarController、Web Component 或 Agent Adapter。

## 构建影响

- `@rive-app/canvas` 是 Avatar 包的运行依赖，但不会进入 root/core/web-component/testing 的 Vite 可达 chunk。
- A5 增加构建图遍历测试，避免 Rive SDK 因未来误引用进入基础或嵌入 bundle。
- `.riv` 文件继续通过 Manifest URL 加载，不静态 import 或内联。
