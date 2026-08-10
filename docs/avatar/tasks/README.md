# Avatar 第一阶段剩余任务索引

状态：Active
更新时间：2026-08-10
已完成：A0～A6、A6-PREVIEW、B0～B6
当前范围待执行：视觉 E2E、消费者发布文档、Visual MVP 最终 Review
Deferred：A7～A9（语音）、Agent Adapter

本目录中的任务单是两个 AI 的唯一执行入口。启动时只把对应任务单路径和角色告诉 AI；AI 必须一次只执行一个任务 ID，完成后等待 Review，不得自行进入下一项。

## 1. 当前可并行启动

| 执行者 | 当前任务 | 任务单 | 状态 |
| --- | --- | --- | --- |
| AI-A（强模型） | 等待用户确认真实数字人预览 | [A6-PREVIEW](./A6-PREVIEW-visual-runtime.md) | Complete |
| AI-B（经济模型） | B7/B8 等待派发 | [B7](./B7-playwright-acceptance.md) / [B8](./B8-consumer-docs.md) | Ready |

A6-PREVIEW 已完成。AI-A 不进入 A7，先等待用户确认真实数字人的视觉效果。

## 2. 完整剩余顺序

```text
视觉优先：A6 → A6-PREVIEW ───────→ 用户确认可见角色
交付验证：B4 → B5 → B6 ─────────→ pack 安装与独立项目展示
Agent：   Deferred
语音：    A7 → A8 → A9（Deferred）
```

- 完整优先级说明见 [PRIORITY-ROADMAP](../PRIORITY-ROADMAP.md)。
- B6 已通过 AI-A Review #3。
- 当前视觉发布不等待 A7～A9，也不等待 Agent Adapter。
- 后续 E2E、消费者文档和最终 Review 只按 Visual MVP 范围验收。

## 3. 任务单列表

| ID | Owner | 内容 | 前置 |
| --- | --- | --- | --- |
| [A6](./A6-character-manifest.md) | AI-A | Manifest URL/对象加载、校验、URL 解析 | A5 |
| [A6-PREVIEW](./A6-PREVIEW-visual-runtime.md) | AI-A | 真实 Rive 视觉 Runtime、Demo 资产和预览页 | A5、A6 |
| [A7](./A7-audio-player.md) | AI-A | 浏览器音频播放器与标准错误映射 | A1 |
| [A8](./A8-audio-analyser.md) | AI-A | `AnalyserNode` 音量采样与 RAF 生命周期 | A7 |
| [A9](./A9-demo-character-integration.md) | AI-A | 在视觉 Runtime 上补齐音频/嘴型生产组合 | A6-PREVIEW、A7、A8 |
| [A10](./A10-e2e-risk-scenarios.md) | AI-A | 原完整语音阶段高风险场景设计（Deferred） | A9 |
| [A11](./A11-final-technical-review.md) | AI-A | Visual MVP 最终 Review 和发布候选结论 | B6、B7、B8 |
| [B4](./B4-embed-sdk.md) | AI-B | `createAvatar()` Embed SDK | B3 |
| [B5](./B5-react-adapter.md) | AI-B | React 薄适配器 | B4 |
| [B6](./B6-framework-examples.md) | AI-B | 独立消费者安装、构建和真实角色展示 | B5、A6-PREVIEW |
| [B7](./B7-playwright-acceptance.md) | AI-B | Visual MVP Chromium 嵌入验收 | B6 |
| [B8](./B8-consumer-docs.md) | AI-B | Visual MVP 消费者与发布文档 | B6 |

## 4. 已冻结的跨任务决策

剩余任务统一遵守 [ADR-0005](../decisions/0005-remaining-integration-contracts.md)：

1. `createAvatar()` 从 `@skdy/avatar` 根入口导出；不新增 `./embed` package export。
2. 导入根入口不得自动注册 Custom Element；调用 `createAvatar()` 时才按需注册。
3. B4 返回 `AvatarEmbedHandle`，其中 `controller` 是 `<pi-avatar>` 的 Controller 形状代理，不暴露内部 `CoreAvatarController`。
4. A6-PREVIEW 先交付 Manifest + Rive 的可见生产链路和默认工厂；A9 最后在其上接入音频播放器和音量采样。
5. Rive 运行时必须保持按需加载，不得静态进入 root/core/web-component 基础入口。

## 5. 通用停止条件

出现以下任一情况必须停止当前受影响部分并写契约变更请求：

- 需要更改已冻结状态、事件名、错误码或 Manifest schema。
- 需要让 Core 引用 React、Vue、Rive 类型、Pi 或 Agent runtime。
- 需要新增 package export、HTML 属性或公共 Controller 方法。
- 无法在不破坏已通过测试的情况下完成任务。
- 需要覆盖另一任务尚未 Review 的工作区改动。

未受阻塞的测试、文档和内部实现可以继续。所有任务完成后都要创建 `docs/avatar/handoffs/<ID>-*.md` 并等待指定 Review。
