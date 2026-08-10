# Web 数字人交付优先级路线

状态：Visual MVP Integration Complete（P1、P2 已通过）
更新时间：2026-08-10
当前产品范围：可展示、可打包、可嵌入已有前端项目。Agent 与语音不在当前范围。

## P1：可见数字人预览（当前最高优先级）

目标：不依赖 Agent、不依赖音频，在浏览器里加载真实 Rive 角色，并能切换五种标准状态。

执行顺序：

```text
A6 Character Manifest 加载/校验
  ↓
A6-PREVIEW 视觉生产链路
  ├─ Rive 动态加载
  ├─ 默认 Controller 工厂
  ├─ Demo Manifest + 合法 .riv 资产
  ├─ resize / destroy
  └─ 最小 Vanilla 预览页
```

P1 完成标志：打开预览 URL 能看到角色；可切换 idle/listening/thinking/speaking/error；刷新、resize、销毁重建无控制台错误。此时 `speak()` 不属于验收范围。

## P2：独立项目嵌入和发布验证（已完成）

目标：证明其他部门可以安装同一个正式产物，并把可见数字人嵌入已有页面；不要求为每种框架维护实现。

```text
B4 createAvatar() Embed SDK
  ↓
B5 React 薄适配器（可选语法糖，已放行）
  ↓
B6 独立消费者项目：npm pack → 安装 tarball → production build → 浏览器展示
```

B6 只验证一个框架无关的正式包，不再建设 Vanilla/React/Vue 三套实现。真正发布到 npm/private registry 需要用户另行确认版本、registry 和凭据；B6 先完成发布前的等价验证。

## Deferred：Agent 通信

目标：在不侵入 Avatar Core 的前提下，由前端 Adapter 把后端 Agent 消息映射到已有 Controller 命令和 DOM 事件。

不在当前 Visual MVP 中实现。未来启动前必须由 Agent runtime 负责人提供并共同确认：

- transport：WebSocket、SSE、postMessage 或组合方式；
- 消息 envelope：`source/version/type/requestId/payload`；
- 重连、心跳、顺序、取消和鉴权语义；
- state/interrupt/error 的映射；
- 音频尚未完成时，Agent 不得依赖 `speak()` 成功。

确认后另建 Agent Adapter 任务包；Adapter 只能依赖 `AvatarController`，不能把会话协议写入 Core、Renderer 或 Web Component。

## Deferred：语音和嘴型

```text
A7 浏览器音频播放器
  ↓
A8 AnalyserNode 音量采样
  ↓
A9 最终生产 Runtime 集成
```

A7～A9 不属于当前 Visual MVP，不作为可发布视觉组件的完成条件。

## P3：Visual MVP 验收与发布候选

```text
B6 独立消费者安装/展示
  ↓
视觉 E2E + 消费者接入/发布文档
  ↓
Visual MVP 最终技术 Review
```

当前发布候选只验收视觉展示、打包安装、嵌入、布局、状态、销毁和错误路径；Agent、音频和嘴型不进入门禁。
