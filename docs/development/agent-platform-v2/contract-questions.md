# V2 契约问题清单（M0）

状态：M0 调研；本文仅为问题清单，不含前端对后端契约的"候选"或"定义"

负责人：前端工程师

创建日期：2026-08-24

本文列出前端在 DTO 冻结前**不能自行决定**的问题。所有问题都不要求前端补猜，必须由后端给出字段口径或由总架构师批准。配套的代码现状与方案调研见 [m0-survey.md](./m0-survey.md)。

> **第二轮范围说明**：总架构师第二轮回退指出，前端不应自行起草 `TurnMetrics` 状态枚举、事件名、分页接口、MCP/Skill DTO、或 ISO 时间/单调时钟语义。M0 契约候选由后端工程师起草，总架构师批准后冻结；本文只保留"前端不能决定、需要后端/总架构师回答"的问题清单。

## 5.1 会话指标 / 上下文

1. `GET /api/control/v1/conversations/:id/metrics` 与 `/context` 的精确路径、鉴权（Admin Token？Conversation-scoped token？）、分页/游标策略；返回是单对象还是 `turns: [...]` 列表？
2. `TurnMetrics` 中"无文本输出"的轮次是否返回 `firstOutputAt = null`，要求前端不要写0？会话均值只统计有值样本——后端预先聚合还是前端在 `turns` 上聚合？
3. `ContextUsageSnapshot.measurement` 在哪些模型/场景标 `estimated`？旧会话（采集功能上线之前）服务端是否直接给"未采集"标志位？前端文案要写"该会话创建时尚未采集"，还是由前端推断 `createdAt`？
4. `breakdown` 七项是否包含尚未识别的项（如 `userProvidedFiles` 与 `attachments` 合并/分开）？不可归类内容的扩展字段是否在白名单中？
5. 会话分页聚合的口径与边界：当前实现是否在服务端基于完整数据集聚合？分页参数（`pageSize` 上限、游标格式）、`aggregates` 字段（`totalTokens`、`avgTotalLatencyMs`、`sampleSize` 等）由谁、何时给出？
6. `TurnMetrics` 的成功/失败/取消状态枚举与事件名（包括 `turn/succeeded`、`turn/failed` 等）由谁维护？前端消费时是否使用统一的事件枚举？

## 5.2 模型生成参数

7. `LlmAvailableModel.parameterCapabilities` 是否随模型目录升级加入**互斥约束 / 步长**字段？当前协议只暴露 `supported / toggle / efforts / defaultEffort`；[README §4.3](./README.md) 提到"互斥约束"但 DTO 尚未对应。
8. 会话级 `reasoningEffort` 覆盖放在 `Conversation.metadata` 还是独立端点（如 `POST /api/embed/v1/conversations/:id/effort`）？恢复时从哪里读？"同会话内重连不丢"的语义是否要求服务端持久化？
9. 管理员 Chat 与 Embed Chat 共享同一覆盖路径还是两条独立路径？两者错误码与权限是否一致？
10. 模型目录中各 Provider 的合法 effort 档位与默认 effort 映射表由谁负责？前端是否需要读取 provider 维度的 capability 字典？
11. 现有 `SessionController.setThinking(thinkingLevel: ThinkingLevel)` 通道与 V2 `reasoningEffort` 的迁移计划（是否删除、何时删除、是否保留兼容路径）由谁、何时给出？

## 5.3 Skill

12. Skill DTO 形态：命名空间、版本 hash、状态、最近校验结果、被哪些 Agent 使用——最小字段集？`Skill Revision` 与 Agent Revision 是 N:M 还是绑定在 Agent Revision 上？
13. 上传/导入：浏览器直传还是经 Control 转发？大小/格式/安全校验错误码？是否需要前端展示 hash？
14. 发布确认页的"校验失败"是否要求前端显示服务端原始错误（结构/路径），还是只展示聚合 message？
15. KnowledgeBase 与 Skill 的迁移期语义：Skill 上线后是否完全取代 `knowledgeBaseIds`？过渡期内是否需要双写（前端两个入口都允许）？

## 5.4 MCP

16. MCP DTO：Transport（stdio / http / sse / streamableHttp）、Tool 列表/版本、Secret 字段命名与序列化（不进入日志/事件）；创建/编辑的 Secret 替换 UI 字段名？
17. Tool 白名单（allowlist）的存储位置与生命周期：随 Agent Revision 还是随 MCP Revision？默认值是否"全部不选"？
18. "测试连接"与"同步 Tools" 的错误码与超时；schema 漂移告警的来源是 Event 还是 REST 拉取？
19. 浏览器是否允许"测试连接"调用——若 MCP 是私有地址，是否必须经 Control Plane 代理？前端不能直连。

## 5.5 Embed SDK / 通用

20. SDK 包名/导出名是否冻结为 `@earendil-works/embed-sdk` + `createEmbed` / `EmbedInstance`？若需 v2 postMessage，是否要双轨支持 v1？
21. 控制台"接入方式"示例代码片段是否需要由 SDK 文档示例与 `app-detail.tsx` 双向对齐？展示哪些事件默认监听？
22. Admin / Embed 错误信封是否统一为 `{ code, message, requestId }`？Metrics / Context / Skill / MCP 是否沿用？
23. Admin/Embed 各模块静态检查：`backend typecheck / test` 与前端 `npm run check` 顺序在 [README §8](./README.md) 已列，是否需要把 protocol typecheck 单独提早跑（DTO 变化最频繁）？注：protocol package 没有 `typecheck` script，类型检查需用两个 tsconfig（`tsconfig.build.json` / `tsconfig.test.json`）的 `tsgo --noEmit`，不得写入不存在的 `npm run typecheck --workspace=@earendil-works/pi-protocol`。
24. DTO 冻结时间窗：M0 冻结 DTO/错误码 → M1 才能接入真实 API。本周内能否给到第一批冻结？

## 5.6 单调时钟与"事件顺序"语义（第二轮回退，归属后端）

25. 单调时钟与墙钟对齐策略：后端是否同时持久化 `monotonicDurationNs` 与 `wallClockAt`？回拨/闰秒处理与漂移阈值如何界定？前端不在此处自定语义，仅按服务端返回字段渲染。
26. "同一会话内 turn 顺序"由后端在采集点保证，前端不重新排序；如有时间戳倒置，是否由前端显示"采集异常"提示？提示文案与触发条件由谁定义？

## 5.7 后端独立负责、本文件只跟踪的 M0 缺口（不再在前端文档代办）

| # | 缺口 | 责任人 |
|---|---|---|
| R1 | 会话分页聚合（当前按当前页错误聚合） | 后端 |
| R2 | `turn/failed` 等事件不在权威事件枚举 | 后端 |
| R3 | 单调时钟采集点与持久字段 | 后端 + 总架构师 |
| R4 | Skill / MCP / `reasoningEffort` 持久化 DTO 与错误码 | 后端 + 总架构师 |
| R5 | Reasoning Provider 映射 + 互斥约束 | 后端 + 总架构师 |

R1～R5 由后端工程师真正提交契约或代码后冻结，前端不再代办。