# ADR-001：Agent 平台 V2 M0 契约

状态：草案（待总架构师批准）

创建日期：2026-08-24

## 决定

为 Agent 平台 V2 会话统计 / 上下文快照建立冻结契约，明确以下长期影响决策：

### D1　M0 只做契约层，不改运行时接线

M0 新增 DTO、错误码、纯函数推导、迁移草案、fixture 与 API 示例，**不改
`pi-runtime-adapter.ts` / `turn-executor.ts`**。reasoning 接线沿用已完成的
`model-parameters-2026-08-21.md` 实施。运行时接线、版本一致性 prompt 注入与
metrics 采集留到 M1，避免契约未完全冻结前触碰运行时。

影响：前端可基于冻结 DTO 并行 mock；后端 M1 才动运行时。

### D2　Turn metrics 落库：扩 `turn/end` payload

不新增独立 `turn_metrics` 表（避免第二事实源），不**发明**新事件类型。在
`conversation_events` 的 `turn/end` 事件 payload 中写入 `TurnMetrics`（jsonb，无需
DDL），保持事件日志为唯一真源。例外：把**已实际发射**的 `turn/failed` 对齐进权威
`SESSION_EVENT_TYPES`（见 D7；text 列，无 DDL）。

影响：向后兼容；M1 只需在 `turn/end` 写 payload 与加可选索引，无需破坏性迁移。

### D3　事件命名统一到斜杠式，恢复兼容 legacy 读

权威枚举为 `SESSION_EVENT_TYPES`（`turn/start`、`user/message` 等斜杠式）。
`context-restore.ts` 恢复路径继续兼容 legacy 命名（`turn.start`、`assistant.message`）
以读取存量会话，不破坏既有数据。

影响：新事件采用斜杠式；存量恢复不受影响。

### D4　特性开关 `PI_*` 前缀，默认关闭

新增 `PI_AGENT_V2_METRICS`（默认 `false`）控制指标采集与查询。reasoning 为已启用产品
能力，**不设预留开关**（`PI_AGENT_V2_REASONING` 已否决，未提交）。关闭时行为与
现在完全一致（chat-only 回退沿用现有 `runtimePolicy.profile` 机制）。

影响：低风险灰度；回退=关闭开关 + 保留 jsonb 字段（非破坏性）。

### D5　迁移只前向，回退不做破坏性 down

沿用 `migrate.ts`（`_migrations` + advisory lock，无 down 执行器）。jsonb 扩字段免
DDL；未来索引回退=关闭开关 + 索引非关键。不做任何删除列的 down migration。

### D6　Metrics 空值/分页/终态/单调时钟语义（首轮审查修订）

- `TurnMetrics` 增加 `outcome: "success"|"failed"|"cancelled"`；仅 success 的派生时序
  有值，failed/cancelled 一律 `null`，不得写 0。
- 时间测量使用**单调时钟**（`TurnMonotonicDelays`），墙上时间戳（`TurnWallClockStamps`）
  仅用于展示/追溯，二者显式分离，杜绝 NTP 跳变污染推导。
- `turn/end` payload 扩 `metrics`（保留 `ok`/`usage`，用量聚合继续读 `payload->'usage'`）。
- 逐轮列表带 `nextAfterSequence` 分页游标；`stats` 为**全会话**聚合，不得由当前页推导。
- 空态（200 `available=false`）与子系统不可用（503 `*_UNAVAILABLE`）语义分界明确。
- 终态事件边界冻结：`turn/end`→success、`turn/failed`→failed、`turn/interrupted`→cancelled、
  legacy 只读映射（`turnOutcomeFromTerminalEvent`）。

### D7　第二轮审查修订

- 权威事件枚举补齐 `turn/failed`（实际已写入的事件；text 列，无 DDL）。
- `sessionEffort` 恢复精确类型 `ReasoningEffort | null`；`TurnEndPayload.usage` 用
  `schemas.ts` 的 `Usage`，不弱化为 `Record<string, unknown>`。
- 单调时序新增校验 `validateTurnMonotonicOrder`，乱序由 `deriveTurnMetrics` 抛错，
  不静默忽略。
- 新增 `ConversationReasoningState`（会话 effort 持久化、可恢复）。
- 新增 Skill / MCP 管理契约候选（`admin-workbench-skills.ts`、`admin-workbench-mcp.ts`）；
  MCP transport 集合仍待 BE-3 ADR 冻结，管理形状已含在契约。

### D8　第三轮结构性修订

- 分页边界冻结：默认 `limit=50`、上限 `limit=200`（钳制）、`afterSequence` 必须正整数；
  非法分页参数 → 422 `INVALID_METRICS_FILTER`（`resolveMetricsPage`）；补两页 fixture
  （`metrics-page-1.json`/`metrics-page-2.json`，两页 stats 均为全会话）。
- Skill / MCP 绑定**固定到不可变 Agent Revision**（`AgentBindingRef.agentRevision` /
  `AgentMcpBinding.agentRevision`），不随后续 revision 漂移。
- MCP 配置结构化（`McpServerConfig`/`McpHttpTarget`），**Secret 只以 `*Ref` 引用保存**，
  读取仅回 `secretConfigured`；新增 `MCP_SECRET_NOT_CONFIGURED`（409）。
- **MCP transport 未评审**：不以公共类型导出 stdio；当前仅 `streamable-http` 候选描述，
  其它 transport 待 BE-3 ADR（transport 最终形态见 D9）。
- reasoning 补齐会话更新端点（`PUT .../reasoning`）、权限边界、
  `REASONING_INVALID_EFFORT`/`REASONING_NOT_CONFIGURABLE` 错误码与
  `conversation.reasoning-updated` 审计动作（入口拆分与审计定性见 D9）。

### D9　第四轮收口

- **M0-A Metrics/Context 冻结**：`admin-workbench-metrics.ts`（turn metrics、context
  快照、分页/聚合、`AGENT_V2_METRICS_ERRORS`）冻结，不再改动。
- **reasoning 双入口共享服务语义**：Control Admin（`/api/control/v1/.../reasoning`）与
  Embed 属主（`/api/embed/v1/.../reasoning`）两个入口落到同一服务操作，避免权限混用；
  契约移至独立模块 `admin-workbench-reasoning.ts`。
- **事实源与审计分离**：当前 effort 事实源 = `conversation_reasoning_state` 专用持久状态
  （恢复/查询读它）；`conversation.reasoning-updated` 为独立只追加审计日志，**不是**
  `conversation_events` 事件类型、不进 `SESSION_EVENT_TYPES`、不推进序列号、不参与回放。
- **MCP 连接配置不冻结 + 禁明文**：不导出任何 transport union；`McpServerConfig` 仅承载
  Secret 引用，禁止自由文本 headers 与明文凭据（不含 `Authorization` 头）；新增
  `MCP_CONFIG_NOT_APPROVED`。完整连接语义待 BE-3 安全 ADR。

## 待办（BE-3 安全 ADR）

- MCP **连接配置 / transport / 鉴权方式**待 BE-3 安全 ADR 明确后冻结；M0 仅固定管理 DTO
  与“禁明文 headers/凭据”安全边界（D8/D9）。
- reasoning 会话 thinking-level 的运行时持久化接线属 M1（M0 仅契约）。

## 批准状态

- [x] 后端自检（protocol tsgo、vitest 354 项、biome 零告警、git diff --check）
- [x] M0-A Metrics/Context（received）已冻结
- [ ] 总架构师审查剩余 D8–D9（reasoning / Skill / MCP 契约）
- [ ] 前端基于已冻结 Metrics DTO 建 mock；M1 Runtime/MCP 待 BE-3

## 变更历史

- 2026-08-24　建立草案（D1–D5）。
- 2026-08-24　第一轮审查修订（D6）。
- 2026-08-24　第二轮修订（D7，turn/failed 枚举、类型收紧、单调校验、Skill/MCP 契约）。
- 2026-08-24　第三轮修订（D8，分页边界、Agent Revision 绑定、MCP Secret 引用、
  transport 不导出 stdio、reasoning 更新/权限/错误码/审计）。
- 2026-08-24　第四轮收口（D9，M0-A 冻结、reasoning 双入口+事实源/审计分离、
  MCP 禁明文/连接配置待 BE-3）。