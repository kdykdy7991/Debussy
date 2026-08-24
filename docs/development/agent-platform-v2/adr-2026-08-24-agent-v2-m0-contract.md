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

不新增独立 `turn_metrics` 表（避免第二事实源），不新增事件类型（M0 内仍不扩
`SESSION_EVENT_TYPES`）。在 `conversation_events` 的 `turn/end` 事件 payload 中写入
`TurnMetrics`（jsonb，无需 DDL），保持事件日志为唯一真源。

影响：向后兼容；M1 只需在 `turn/end` 写 payload 与加可选索引，无需破坏性迁移。

### D3　事件命名统一到斜杠式，恢复兼容 legacy 读

权威枚举为 `SESSION_EVENT_TYPES`（`turn/start`、`user/message` 等斜杠式）。
`context-restore.ts` 恢复路径继续兼容 legacy 命名（`turn.start`、`assistant.message`）
以读取存量会话，不破坏既有数据。

影响：新事件采用括号式；存量恢复不受影响。

### D4　特性开关 `PI_*` 前缀，默认关闭

新增 `PI_AGENT_V2_METRICS`（默认 `false`）控制指标采集与查询；预留
`PI_AGENT_V2_REASONING`（默认 `false`）。关闭时行为与现在完全一致（chat-only 回退
沿用现有 `runtimePolicy.profile` 机制）。

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
- 逐轮列表带 `nextAfterSequence` 分页游标。
- 空态（200 `available=false`）与子系统不可用（503 `*_UNAVAILABLE`）语义分界明确。
- 终态事件边界冻结：`turn/end`→success、`turn/interrupted`→cancelled、legacy 只读映射
  （`turnOutcomeFromTerminalEvent`）。

## 待办（第 8 项阻断）

- **Skill / MCP / reasoning 持久化其余 M0 契约**：尚未提交。MCP 首期 Transport 需按
  BE-3 在 ADR 明确后才能避免臆造；reasoning 持久化会话 thinking-level 在 M1 接线。
  该项列入下一批契约，不含在 Metrics/Context 候选内。

## 批准状态

- [ ] 后端自检
- [ ] 总架构师审查 D1–D5
- [ ] 前端基于本契约建 mock

## 变更历史

- 2026-08-24　建立草案（D1–D5）。