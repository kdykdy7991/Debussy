# M0 代码现状与方案调研

状态：M0 调研；DTO / 错误码 / 持久化路径尚未由后端 + 总架构师冻结，本文件不视为契约

负责人：前端工程师

创建日期：2026-08-24

本文回答"现在前端能用什么、缺什么、方案如何选、最小原型验证什么"。配套的契约问题清单见 [contract-questions.md](./contract-questions.md)。所有结论必须在 DTO 冻结后再落地为正式实现；本阶段产出仅为骨架与原型。

> **M0 文档措辞规约（修订二）**
> - 本文不复述 "已冻结/可开发" 等通过性语言：M0 阶段后端只提交了类型枚举的草稿，DTO 路径、错误码、持久化位置与回退边界**尚未冻结**，任何代码或文档不得宣称 "已冻结"。
> - "已否决的 reasoning 预留开关"：`SessionController.setThinking(ThinkingLevel)` 是 V1 临时通道（`thinkingLevel` 字符串字段），V2 正式通道为 `reasoningEffort` / `ReasoningEffort`；V2 不再保留 V1 字符串预留开关，`thinkingLevel` 路径在 M1 替换为 `setReasoningEffort(reasoningEffort: ReasoningEffort)`，原方法在 M1 删除。本文件不把 `setThinking` 当成 V2 reasoning 通道。
> - V2 reasoning cover 称作 `sessionEffort`，区别于 Agent Revision 默认 `reasoningEffort`；二者不能混淆。
> - V2 用量称 `usage`（与 Provider 返回口径一致），估算仅用于上下文分项，不能覆盖权威 usage。

## 1. 现有代码可以复用什么

### 1.1 Admin 端

| 模块 | 路径 | V2 复用点 |
|---|---|---|
| AppShell + 鉴权挂载 | [packages/web/src/admin/app-shell.tsx](../../../runtimes/pi/packages/web/src/admin/app-shell.tsx) | V2 新增 Skill / MCP 页面继续挂同一 shell；连接失败只把 controller 推到 error 态，不弹解锁对话框 |
| Hash 路由 + 路由常量 | [packages/web/src/admin/router.ts](../../../runtimes/pi/packages/web/src/admin/router.ts) | 路由条目只在 protocol `ADMIN_WORKBENCH_ROUTES` 添加，不在 router.ts 内重复 |
| Agent 表单与思考编辑器 | [packages/web/src/admin/agents/agent-form.tsx](../../../runtimes/pi/packages/web/src/admin/agents/agent-form.tsx) | `ModelParametersEditor` 仍仅渲染 `reasoning.{enabled,effort}`；其余生成参数在表单注释中标 "由服务端代码固定"，前端不暴露控件 |
| Agent 草稿状态机 | [packages/web/src/admin/agents/agent-state.ts](../../../runtimes/pi/packages/web/src/admin/agents/agent-form.tsx) | `saved/dirty/saving/error`；`AgentConfigSnapshot` 为表单状态真源；V2 在新字段时复用相同状态机 |
| Reasoning 标签映射 | [packages/web/src/admin/agents/reasoning-efforts.ts](../../../runtimes/pi/packages/web/src/admin/agents/reasoning-efforts.ts) | provider 枚举→UI 标签映射（V2 仍然按 `ReasoningEffort` 枚举） |
| 发布确认抽屉 | [packages/web/src/admin/apps/publish-drawer.tsx](../../../runtimes/pi/packages/web/src/admin/apps/publish-drawer.tsx) | V2 复用为发布确认页骨架，把 Skill / MCP 卡片插到 confirm 步骤 |
| Admin API 客户端 | [packages/web/src/admin/api/](../../../runtimes/pi/packages/web/src/admin/api/) | `AgentApi`、`AppApi`、`ConversationsApi`、`UsageApi`、`LlmApi` 统一模式：Bearer token → 401 触发 `auth.failConnection`；POST 带 `Idempotency-Key` |
| Usage 页面状态壳 | [packages/web/src/admin/pages/usage-page.tsx](../../../runtimes/pi/packages/web/src/admin/pages/usage-page.tsx) | 加载/错误/重试壳，会话详情"性能"区块直接套同一壳 |
| Aurora UI 组件 | [packages/web/src/admin/components/](../../../runtimes/pi/packages/web/src/admin/components/) | `MetricsRow` / `Table` / `Pagination` / `EmptyState` / `AuroraPageHeader` |
| 用户会话详情 | [packages/web/src/admin/user-conversations/conversation-detail.tsx](../../../runtimes/pi/packages/web/src/admin/user-conversations/conversation-detail.tsx) | 在此页加"上下文"与"性能" tab，保留既有未知事件降级路径 |

### 1.2 Embed 端

| 模块 | 路径 | V2 复用点 |
|---|---|---|
| Embed SDK | [packages/web/src/embed/sdk/skdy-embed.ts](../../../runtimes/pi/packages/web/src/embed/sdk/skdy-embed.ts) | V2 SDK 改造基线：`mount/destroy`、`ready`/`error`/`conversation-created`/`resize` 事件、origin 白名单、`launchToken` 一次性发送；`height == 0` 已在协议 + SDK 双重拒绝（修订二） |
| postMessage 通道 | [packages/web/src/embed/post-message.ts](../../../runtimes/pi/packages/web/src/embed/post-message.ts) | iframe 侧协议实现，校验 `event.source === window.parent` + origin allowlist + 信封 decode + 明确 `targetOrigin` |
| WebSocket 传输抽象 | [packages/web/src/embed/realtime-transport.ts](../../../runtimes/pi/packages/web/src/embed/realtime-transport.ts) | 复用 |
| Embed 应用根 | [packages/web/src/embed/embed-app.tsx](../../../runtimes/pi/packages/web/src/embed/embed-app.tsx) | bootstrap → 鉴权 → 会话 → chat；resize 上报已就位 |

### 1.3 Chat / 流式

| 模块 | 路径 | V2 复用点 |
|---|---|---|
| AI 消息流 | [packages/web/src/conversation/ai-message-flow.tsx](../../../runtimes/pi/packages/web/src/conversation/ai-message-flow.tsx) | turn 聚合（user + assistant + tools）+ FlowToken `<AnimatedMarkdown sep="diff" animation="slideUp" streaming?>` |
| Composer | [packages/web/src/conversation/conversation-composer.tsx](../../../runtimes/pi/packages/web/src/conversation/conversation-composer.tsx) | 输入/附件/上传失败恢复/Abort |
| SessionController | [packages/web/src/lib/session-controller.ts](../../../runtimes/pi/packages/web/src/lib/session-controller.ts) | `createSession/send/abort/uploadFiles`；**V2 删除 `setThinking(ThinkingLevel)`**，改为 `setReasoningEffort(reasoningEffort: ReasoningEffort)`；持久化通过 `sessionEffort` 走会话端点，不在本类内发明 |
| ConnectionController | [packages/web/src/lib/connection-controller.ts](../../../runtimes/pi/packages/web/src/lib/connection-controller.ts) | idle / connecting / connected / reconnecting / error |
| WebSocket Transport | [packages/web/src/lib/websocket-transport.ts](../../../runtimes/pi/packages/web/src/lib/websocket-transport.ts) | 浏览器 WS → pi-client `ByteTransportFactory` |
| Uploader | [packages/web/src/lib/uploader.ts](../../../runtimes/pi/packages/web/src/lib/uploader.ts) | XMLHttpRequest + 进度 → `Attachment` |

### 1.4 Protocol（只读，不复制类型）

| 类型 | 路径 | V2 状态 |
|---|---|---|
| `AgentModelParameters` | [protocol/admin-workbench-agents.ts:89](../../../runtimes/pi/packages/protocol/src/admin-workbench-agents.ts#L89) | 枚举存在：`reasoning.{enabled,effort}`；**整体契约（含合法 effort、Provider 映射、默认值语义、互斥与默认优先级）尚未由总架构师冻结** |
| `ReasoningEffort` | [protocol/admin-workbench-agents.ts:87](../../../runtimes/pi/packages/protocol/src/admin-workbench-agents.ts#L87) | 字面量联合 `"minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"`；M1 起各 Provider 的合法档位与默认档位需后端给出映射 |
| `LlmAvailableModel.parameterCapabilities.reasoning` | [protocol/admin-workbench-llm.ts:70](../../../runtimes/pi/packages/protocol/src/admin-workbench-llm.ts#L70) | 字段存在；**互斥/步长/默认 effort 字段尚未冻结**（README §4.3 已描述边界，但协议尚未落地） |
| `PublishedAppDetail` / `VersionCapabilitiesSummary` | [protocol/publishing/control-http.ts](../../../runtimes/pi/packages/protocol/src/publishing/control-http.ts) | V2 替换为 Skill + MCP |
| `EmbedHostPostMessage` / `EmbedIframePostMessage` | [protocol/embed/post-message.ts](../../../runtimes/pi/packages/protocol/src/embed/post-message.ts) | v1 协议；含 `init`/`logout`/`focus`/`resize-request` 与 `ready`/`error`/`resize`/`conversation-created`；**`height == 0` 已在修订二拒绝（`<= 0`）** |
| `POST_MESSAGE_LAUNCH_TOKEN_MAX_CHARS = 16384` | 同上 | SDK 端必须保留 |
| `POST_MESSAGE_RESIZE_MAX_HEIGHT = 100000` | 同上 | SDK 端必须保留；修订二后 SDK 与协议层均拒绝 `<= 0` |

### 1.5 V2 reasoning 与用量术语（修订二补全）

| 术语 | 含义 | 所在层 | 出处 |
|---|---|---|---|
| `ReasoningEffort` | 字面量枚举，前端只消费 | 协议 | `protocol/admin-workbench-agents.ts:87` |
| `AgentModelParameters.reasoning.{enabled,effort}` | Revision 持久化字段 | 协议 | `protocol/admin-workbench-agents.ts:89` |
| `sessionEffort` | 会话级 `reasoningEffort` 覆盖，**V2 命名**；写入路径由后端冻结（见 [contract-questions.md §3](./contract-questions.md)） | 协议 + 服务端 | 待冻结 |
| `usage` | 单轮 Provider 权威 input/output/cacheRead/cacheWrite Token；不允许前端估算覆盖 | 服务端 → 协议 | `TurnMetrics` 待冻结 |
| `TurnMetrics` | 单轮性能（TTFT/generation/totalLatencyMs/outputTokensPerSecond）；`null` 不等于 0 | 协议 | README §4.1 草案，未冻结 |
| `ContextUsageSnapshot` | 单会话上下文用量与 breakdown | 协议 | README §4.2 草案，未冻结 |

## 2. 当前缺少什么

按 [frontend.md](./frontend.md) FE-0..FE-4 拆分，标注是否需要 DTO 冻结后才能动手：

| 缺口 | 等 DTO？ | 备注 |
|---|---|---|
| 会话详情"上下文"区块 | 是 | 等 `ContextUsageSnapshot`；前端不写 0，估算与 exact 必须分别渲染 |
| 会话详情"性能"区块 | 是 | 等 `TurnMetrics`；`null` 必须等于"未采集"，不得写 0；会话均值只统计成功有值样本 |
| 会话分页契约 | 是 | 后端分页契约不完整、当前实现按当前页错误地计算全会话统计（第二轮回退） |
| 单调时钟顺序 | 是 | 后端在 Provider 请求开始/首个可展示文本增量/结束/失败/取消处打单调时钟时间点，前端只在快照中按时间戳排序展示，不在前端重算 |
| `sessionEffort` 持久化端点 | 是 | 端点位置未定；不通过 `Conversation.metadata` 暗藏，必须有独立路径 |
| Agent 编辑页 `Skill Revision` 选择器 | 是 | 替换 `knowledgeBaseIds` 文本框；保留旧字段读取迁移 |
| Agent 编辑页 `MCP Revision` + `Tool allowlist` | 是 | 默认不选新发现 Tool |
| 发布确认页"固定 Skill/MCP"卡片 | 是 | 含 hash / 校验失败原因 |
| MCP Secret 替换 UI | 是 | 字段名/序列化未定；不回显已存值 |
| 测试连接 / 同步 Tools 状态机 | 是 | 等错误码与超时约定 |
| Skill / MCP 列表/详情/导入/启停 | 是 | 等 DTO |
| 事件枚举冻结（含 `turn/failed`） | 是 | 修订二：服务端实际写入 `turn/failed`，但不在权威枚举中；前端必须在 enum 冻结后再消费 |
| 上下文 / 指标 / Skill / MCP 的错误码与文案 | 是 | 等 [README §6](./README.md) 错误码冻结 |
| Embed SDK 正式 package | 否 | 前端独立做；不修改协议共享上限 |
| 单一 fixture 适配层 | 否 | 前端搭；DTO 字段集合占位枚举/字符串，不写业务数字 |
| 加载/空/部分/失败/无权限 状态壳 | 否 | 前端搭 |
| 旧占位/兜底数字清理 | 否 | `tokenTotal` / `avgResponseMs` 等 |
| 浏览器 E2E、键盘、焦点、窄屏、长 Tool 名 | 否 | V2 收口阶段 |

仓库当前**完全没有 Skill / MCP 类型或 UI**（已确认）。FE-2 / FE-3 几乎全绿。

## 3. 候选方案及比较

### 3.1 Embed SDK 改造路径

| 方案 | 优点 | 风险 | 推荐 |
|---|---|---|---|
| A. 仓库内独立 package `packages/embed-sdk`，新 workspace `@earendil-works/pi-embed-sdk` | 包名/导出名稳定；与控制台示例天然一致；构建产物独立 | 锁文件变更需要审查 | 推荐 |
| B. monorepo 内 `packages/web/src/embed-sdk/` 单独 entry | 改动小 | 与 `embed/` 耦合，不能被非 web 包消费 | 备选 |
| C. 仓库外独立 npm 包 | 长期可独立发布 | 与"短期 DTO 冻结前不重构"冲突 | 不推荐 |

### 3.2 流式 Markdown 渲染

仓库现状：FlowToken 1.0.40，`AnimatedMarkdown sep="diff" animation="slideUp" streaming?`，专门为流式字符级淡入服务。结论：继续沿用，V2 不再触发二次选型；仅做"上下文/性能"与 FlowToken 内容共存的最小验证。

### 3.3 状态管理

仓库已有 snapshot-store 模式（`SessionController` / `PiConnectionController` / `AgentChatController` / `AdminAuthController` / `PublishingController`），统一 `getSnapshot() / subscribe()`。V2 沿用同一模式：

- `ConversationMetricsStore` / `ContextSnapshotStore` / `SkillCatalogStore` / `McpCatalogStore`。
- 不引入 Redux / Zustand。

### 3.4 Fixture 适配层

| 方案 | 评价 |
|---|---|
| 仓库内 `packages/web/src/admin/fixtures/` 集中模块 + `useFixtureData(name)` 钩子 | 推荐：与现有 Api* 类解耦；真实接口接入后整目录删除 |
| MSW 拦截 fetch | 需把所有 fetch 改成走 MSW，与现有 Api* 模式冲突 |
| 在 Api* 类里加 mock 分支 | 与"只做 fetch + JSON序列化"规则冲突，不允许 |

## 4. 最小原型要验证什么

只针对关键不确定点；不直接当生产实现。

| 不确定点 | 验证内容 | 验收方式 |
|---|---|---|
| SDK 包名/导出名 | `import { createEmbed } from "@earendil-works/pi-embed-sdk"` 与控制台 `app-detail.tsx` 示例一致 | 构建产物清单 + 最小 HTML 复刻运行 |
| mount / destroy 幂等 | 多次 destroy 不抛；listener 被移除；iframe 被摘除 | vitest fake window 断言 |
| 事件名稳定性 | `ready`/`error`/`conversation-created`/`resize` 不漂移；不引入未在协议中枚举的事件 | 单测 + 类型导出与文档示例同源 |
| resize 上下限 | `<= 0` 与 `> POST_MESSAGE_RESIZE_MAX_HEIGHT` 必须拒绝（修订二：协议层 + SDK 层双重） | 单测覆盖 max+1 / 0 / -1 / NaN / 字符串 |
| origin 校验 | 不在白名单的 origin 不更新 `targetOrigin`、不分发；错误 source 不分发 | 单测覆盖错误 source / origin / version |
| 多实例清理 | 共享同一宿主 window 时两个独立实例互不串 listener；A.destroy() 不影响 B；B 仍能收到事件 | 双实例 + sharedWin 计数断言 |
| launchToken 不落盘 | SDK 不写 sessionStorage/localStorage/cookie；销毁后内存引用清除（最佳努力） | 静态扫描 + localStorage.length 断言 |
| 单调时间顺序 | 同一会话的 turn 时间戳按 `requestStartedAt ≤ providerStartedAt ≤ firstOutputAt ≤ completedAt` 排序展示；不允许前端重新排序 | 单测：乱序样本仍按时间戳升序渲染 |
| FlowToken 与新组件共存 | 新会话详情页与 AiMessageFlow 同页渲染时不互相破坏样式/动画 | 浏览器目检 + 可选 DOM 比对 |
| Idempotency-Key 与 401 | 提交时统一 `newIdempotencyKey({ operation })`；401 触发 `auth.failConnection` | 静态检查 + 单测 |
| `sessionEffort` 覆盖 | V1 `setThinking` → V2 `setReasoningEffort`，落 `sessionEffort`；刷新/重连从服务端读回 | 单测 + 手动 e2e |

## 5. 工作顺序（与用户确认一致）

1. 本文档 + [contract-questions.md](./contract-questions.md) 提交推送。
2. 对 §4 中"不需要 DTO"的项做最小原型，单独 commit。
3. 后端提交修订后的 Metrics/Context 第一批候选（含 `sessionEffort`、`usage`、`turn/failed` 事件枚举、单调时钟采集位置、分页契约）+ 总架构师执行第二轮审查 + 首批 DTO 冻结。
4. DTO 冻结方向明确后，进入页面骨架、状态壳与单一 fixture 适配层。