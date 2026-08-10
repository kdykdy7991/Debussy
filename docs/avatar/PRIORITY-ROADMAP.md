# Web 数字人交付优先级路线

状态：P1 Complete（等待用户视觉确认）  
更新时间：2026-08-10  
产品优先级：先看到数字人预览，其次补 Agent 通信，最后补语音。

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

## P2：嵌入和跨框架使用

目标：其他部门能方便地把可见数字人嵌入自己的页面。

```text
B4 createAvatar() Embed SDK
  ↓
B5 React 薄适配器
  ↓
B6 Vanilla / React / Vue 视觉示例
```

B4 可以与 P1 并行；B6 的真实角色预览必须等待 A6-PREVIEW。语音按钮可以暂不出现或明确标记为后续能力，不能伪装成功。

## P3：Agent 通信（单独阶段）

目标：在不侵入 Avatar Core 的前提下，由前端 Adapter 把后端 Agent 消息映射到已有 Controller 命令和 DOM 事件。

P3 不在当前第一阶段任务中直接实现。启动前必须由 Agent runtime 负责人提供并共同确认：

- transport：WebSocket、SSE、postMessage 或组合方式；
- 消息 envelope：`source/version/type/requestId/payload`；
- 重连、心跳、顺序、取消和鉴权语义；
- state/interrupt/error 的映射；
- 音频尚未完成时，Agent 不得依赖 `speak()` 成功。

确认后另建 Agent Adapter 任务包；Adapter 只能依赖 `AvatarController`，不能把会话协议写入 Core、Renderer 或 Web Component。

## P4：语音和嘴型（最后实现）

```text
A7 浏览器音频播放器
  ↓
A8 AnalyserNode 音量采样
  ↓
A9 最终生产 Runtime 集成
```

A9 复用 A6-PREVIEW 的视觉 Runtime，只补齐真实 `startSpeech()`、音量驱动、错误映射和完整资源释放，不重新实现视觉链路。

## P5：完整验收与发布候选

```text
A10 高风险 E2E 场景
  ↓
B7 Playwright + B8 最终消费者文档
  ↓
A11 最终技术 Review
```

完整 AC-01～AC-12 仍在 P5 验收；P1 是提前可见的产品检查点，不代表语音或发布候选已经完成。
