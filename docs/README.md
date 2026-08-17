# 文档索引

本目录只在顶层保留当前架构、实施、接入、运维和验收入口。已完成阶段的交接与报告位于 [`archive/`](./archive/README.md)。

## 当前开发入口

- [架构基线](./ARCHITECTURE-BASELINE.md)
- [管理员工作台整合与会话日志实施规格](./ADMIN-WORKBENCH-INTEGRATION-IMPLEMENTATION.md)
- [管理员工作台开发任务索引](./admin-workbench/tasks/README.md)
- [多用户发布总体架构](./MULTI-USER-PUBLISHING-ARCHITECTURE.md)
- [多用户发布 MVP 实施规格](./MULTI-USER-PUBLISHING-MVP-SPEC.md)

## 接入、运维与验收

- [宿主接入与灰度 rollout](./MULTI-USER-PUBLISHING-HOST-INTEGRATION.md)
- [运维 Runbook](./MULTI-USER-PUBLISHING-OPS-RUNBOOK.md)
- [验收执行说明](./MULTI-USER-PUBLISHING-ACCEPTANCE.md)
- [`mvp.env.example`](./mvp.env.example)

## 专题文档

- [`avatar/`](./avatar/README.md)：数字人设计、任务、决策和交接。
- [`voice/`](./voice/)：语音规范、任务、交接和验证记录。
- [`debugging-notes/`](./debugging-notes/README.md)：可复用问题排查记录。
- [DeepSeek Harness 与 Pi 对比](./DEEPSEEK-HARNESS-VS-PI.md)：架构研究材料。

## 维护规则

- 顶层文档必须是当前入口或跨模块基线。
- 已被新规格覆盖但仍有证据价值的文档移入 `archive/`，不要继续从当前索引引用为实施入口。
- 模块专属文档放入对应子目录。
- 系统垃圾文件和无内容重复文件直接删除。
