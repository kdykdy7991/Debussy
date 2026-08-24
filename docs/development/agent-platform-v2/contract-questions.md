# V2 契约问题清单（M0）

状态：M0 调研，待后端 / 总架构师回答后冻结 DTO

负责人：前端工程师

创建日期：2026-08-24

本文列出前端在 DTO 冻结前**不能自行决定**的问题。所有问题都不要求前端补猜，必须由后端给出字段口径或由总架构师批准。配套的代码现状与方案调研见 [m0-survey.md](./m0-survey.md)。

## 5.1 会话指标 / 上下文

1. `GET /api/control/v1/conversations/:id/metrics` 与 `/context` 的精确路径、鉴权（Admin Token？Conversation-scoped token？）、分页/游标策略；返回是单对象还是 `turns: [...]` 列表？
2. `TurnMetrics` 中"无文本输出"的轮次是否返回 `firstOutputAt = null`，要求前端不要写0？会话均值只统计有值样本——后端预先聚合还是前端在 `turns` 上聚合？
3. `ContextUsageSnapshot.measurement` 在哪些模型/场景标 `estimated`？旧会话（采集功能上线之前）服务端是否直接给"未采集"标志位？前端文案要写"该会话创建时尚未采集"，还是由前端推断 `createdAt`？
4. `breakdown` 七项是否包含尚未识别的项（如 `userProvidedFiles` 与 `attachments` 合并/分开）？不可归类内容的扩展字段是否在白名单中？

## 5.2 模型生成参数

5. `LlmAvailableModel.parameterCapabilities` 是否随模型目录升级加入**互斥约束 / 步长**字段？当前协议只暴露 `supported / toggle / efforts / defaultEffort`；[README §4.3](./README.md) 提到"互斥约束"但 DTO 尚未对应。
6. 会话级 `reasoningEffort` 覆盖放在 `Conversation.metadata` 还是独立端点（如 `POST /api/embed/v1/conversations/:id/effort`）？恢复时从哪里读？"同会话内重连不丢"的语义是否要求服务端持久化？
7. 管理员 Chat 与 Embed Chat 共享同一覆盖路径还是两条独立路径？两者错误码与权限是否一致？

## 5.3 Skill

8. Skill DTO 形态：命名空间、版本 hash、状态、最近校验结果、被哪些 Agent 使用——最小字段集？`Skill Revision` 与 Agent Revision 是 N:M 还是绑定在 Agent Revision 上？
9. 上传/导入：浏览器直传还是经 Control 转发？大小/格式/安全校验错误码？是否需要前端展示 hash？
10. 发布确认页的"校验失败"是否要求前端显示服务端原始错误（结构/路径），还是只展示聚合 message？
11. KnowledgeBase 与 Skill 的迁移期语义：Skill 上线后是否完全取代 `knowledgeBaseIds`？过渡期内是否需要双写（前端两个入口都允许）？

## 5.4 MCP

12. MCP DTO：Transport（stdio / http / sse / streamableHttp）、Tool 列表/版本、Secret 字段命名与序列化（不进入日志/事件）；创建/编辑的 Secret 替换 UI 字段名？
13. Tool 白名单（allowlist）的存储位置与生命周期：随 Agent Revision 还是随 MCP Revision？默认值是否"全部不选"？
14. "测试连接"与"同步 Tools" 的错误码与超时；schema 漂移告警的来源是 Event 还是 REST 拉取？
15. 浏览器是否允许"测试连接"调用——若 MCP 是私有地址，是否必须经 Control Plane 代理？前端不能直连。

## 5.5 Embed SDK / 通用

16. SDK 包名/导出名是否冻结为 `@earendil-works/embed-sdk` + `createEmbed` / `EmbedInstance`？若需 v2 postMessage，是否要双轨支持 v1？
17. 控制台"接入方式"示例代码片段是否需要由 SDK 文档示例与 `app-detail.tsx` 双向对齐？展示哪些事件默认监听？
18. Admin / Embed 错误信封是否统一为 `{ code, message, requestId }`？Metrics / Context / Skill / MCP 是否沿用？
19. Admin/Embed 各模块静态检查：`backend typecheck / test` 与前端 `npm run check` 顺序在 [README §8](./README.md) 已列，是否需要把 protocol typecheck 单独提早跑（DTO 变化最频繁）？
20. DTO 冻结时间窗：M0 冻结 DTO/错误码 → M1 才能接入真实 API。本周内能否给到第一批冻结？