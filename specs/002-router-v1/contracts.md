# Router V1 正式契约

中文开发者文档位于 `/api/aaas-docs/`，提供快速开始，并从 `/api/aaas-docs/v1/public/openapi.json` 读取六条 Router 接口和两条 MCP 发现接口。

## 通用约定

- 身份：`Authorization: Bearer <API Key>`，与旧 `oi_` Integration Token 互斥。
- 写入幂等：`Idempotency-Key` 必填，作用域 `(tenant_id, key_id, request_scope, scope_id, idempotency_key)`。创建时 `scope_id = key_id`（按 Key 隔离），追加时 `scope_id = task_id`（按 Key + 目标 Task 隔离）；同一键可用于不同 Task 的追加，但同一 Task 重复登记同一键被唯一约束拒绝。同作用域同请求返回原资源并 `duplicate: true`，内容不同返回 `409 IDEMPOTENCY_CONFLICT`。
- 能力范围：双入口 Key 创建 Task 和追加 Input 时必须在请求头携带 `X-Router-Capability-Scope: router` 才使用 Key 直接能力；旧客户端不带该头时 MCP 发现沿旧配置解析。Router-only Key 默认读取直接能力，显式 `legacy` 被拒绝。Router 发现与受理共用同一解析结果。Task、Operation 和事件查询及取消按原 Key 校验归属，不读取范围头。
- 管理端可在 Key 的直接能力中设置 `local_tools: ["bash"]`。该授权随 Operation 冻结，创建和追加请求无此字段。`mcp_servers: []` 仅关闭本次 MCP 选择。授权 Bash 的 Operation 使用受限运行环境，环境未配置或启动失败时可能返回 `SANDBOX_UNAVAILABLE` 或 `SANDBOX_START_FAILED`。部署与验收见[离线运行环境](../../docs/deployment/router-sandbox.md)。
- 凭据：请求体只提交密封前的分层值，服务端立即密封；任何响应、错误、公开事件与进度不包含凭据值。
- 响应包络：`{ "data": ..., "requestId": "..." }`；错误包络：`{ "error": { "code", "message", "requestId", "retryable" } }`。
- 游标：`after` 为不透明字符串，编码 Task 内递增 sequence；`GET /tasks/{id}` 与 `GET /tasks/{id}/events` 的 `limit` 默认 50、上限 200。响应返回 `next_cursor` 与 `has_more`，客户端按 sequence 去重；公开 Events 的 `sequence` 为十进制字符串。
- 输入正文唯一存于 `user.message` History 事件的 `payload.text`；Operation 只存 `input_event_sequence`，复合外键保证事件、Operation 与 Task 同属。Task 不保存输入副本。History 只有一个递增 sequence；`user.message`、`assistant.message`、`tool.call`、`tool.result` 为原始事实，不进入公开 Events；公开 Events 为按类型绑定严格 payload 的投影视图。
- 排队默认 1 小时，平台凭据上限 30 分钟；受理预算检查按前序剩余预算、本次执行预算与余量协调两者，V1 无凭据续期接口。前序失败只导致已排队 Operation 被取消，取消原因为 `PREDECESSOR_FAILED`；调用方仍可提交新输入。
- `operation.progress` 可选，字段白名单仅 `stage`、`stage_at`、`tools_completed`、`tools_total`、`updated_at`。来源只可是可验证执行阶段/工具完成计数；禁止模型思考、工具原始参数与原始返回。

## 凭据结构

```json
{
  "credentials": {
    "servers": {
      "mcp_<uuid>": {
        "tool_credential": "<secret>"
      }
    }
  }
}
```

连接凭据由 MCP 管理中心提供。授权工具存在敏感参数映射时，本次请求需提供对应 Server 的 tool_credential；没有业务凭据要求时可省略 credentials。敏感参数名与工具范围由 MCP Revision 规则确定，响应和错误不回显秘密值。

## 1. POST /api/aaas/v1/tasks

请求：

```json
{
  "prompt": "普通 User 输入：分析工单并给出结论",
  "mcp_servers": ["mcp_<uuid>"],
  "credentials": { "servers": {} }
}
```

- `prompt`：必填，1..48000 字符，非空白。语义是第一条普通 User 输入，不是永久 System Prompt。
- `mcp_servers`：可选；省略表示使用直接能力中全部可用 Server，空数组表示不启用。
- `credentials`：可选，省略等价于 `{ "servers": {} }`；实际必需维度由冻结能力决定。
- 凭据有效期由平台按 Key 执行策略控制。受理时冻结 Key 当前能力；双入口 Key 仍须在请求头传 `X-Router-Capability-Scope: router`。
- `Idempotency-Key` 必填。

响应 `201`：

```json
{
  "data": {
    "task_id": "<uuid>",
    "status": "active",
    "operation_id": "<uuid>",
    "operation_status": "queued",
    "ordinal": 1,
    "duplicate": false
  },
  "requestId": "..."
}
```

错误：`400 INVALID_REQUEST`、`400 MISSING_CREDENTIAL`、`403 CAPABILITY_SCOPE_REQUIRED`、`403 CAPABILITY_UNAVAILABLE`、`409 IDEMPOTENCY_CONFLICT`、`413 PAYLOAD_TOO_LARGE`、`401 UNAUTHORIZED`。

## 2. POST /api/aaas/v1/tasks/{id}/inputs

请求：

```json
{
  "input": "普通 User 输入：改为只统计本周工单",
  "mcp_servers": ["mcp_<uuid>"],
  "credentials": { "servers": {} }
}
```

`credentials` 的约定同创建接口。
`input` 与创建时 `prompt` 同级；后续输入可改变目标，但不篡改已保存历史。当前输入只注入当前 Operation 一次；排队中的后序输入不可提前可见。

响应 `202`：

```json
{
  "data": {
    "task_id": "<uuid>",
    "operation_id": "<uuid>",
    "operation_status": "queued",
    "ordinal": 2,
    "duplicate": false
  },
  "requestId": "..."
}
```

错误：通用错误 + `404 TASK_NOT_ACCESSIBLE`、`409 TASK_CANCELED`、`422 CREDENTIAL_WINDOW_EXPIRED`、`429 QUEUE_FULL`。前序失败不是新输入的错误码，只取消已排队 Operation。

## 3. GET /api/aaas/v1/tasks/{id}

查询参数：`after`（Operation 分页游标）、`limit`（1..200，默认 50）。

响应 `200`：

```json
{
  "data": {
    "id": "<uuid>",
    "status": "active",
    "cleanup_status": "pending",
    "cleanup_reason": "cleanup pending after failure",
    "latest_result": { "operation_id": "<uuid>", "result": "<text>" },
    "latest_operation": { "id": "<uuid>", "status": "failed", "error": { "code": "EXECUTION_FAILED" } },
    "operations": [{ "id": "<uuid>", "sequence": 1, "status": "completed" }],
    "usage": { "complete": false, "known_totals": { "total_tokens": 12 }, "unknown_operations": 1 },
    "next_cursor": null,
    "has_more": false
  },
  "requestId": "..."
}
```

`cleanup_status: "pending"` 表示 Task 仍有清理占用。此时未永久取消的 Task 为 `active`，已永久取消的 Task 为 `canceled`。`idle` 表示任务当前无排队、执行或清理占用。`latest_result` 只指向最近一个 completed Operation，失败不覆盖上次成功结果。Usage 未知不为零。错误：`404 TASK_NOT_ACCESSIBLE`。

## 4. GET /api/aaas/v1/operations/{id}

响应 `200`：

```json
{
  "data": {
    "id": "<uuid>",
    "task_id": "<uuid>",
    "sequence": 1,
    "status": "completed",
    "input": "<text>",
    "result": "<text>",
    "error": null,
    "cancel_reason": null,
    "progress": { "stage": "tools", "tools_completed": 2, "tools_total": 3, "updated_at": "<date-time>" },
    "usage": { "complete": true, "total_tokens": 42, "input_tokens": 30, "output_tokens": 12 },
    "queued_at": "<date-time>",
    "started_at": "<date-time>",
    "ended_at": "<date-time>"
  },
  "requestId": "..."
}
```

错误：`404 OPERATION_NOT_ACCESSIBLE`。失败执行可返回部分执行说明，但不含模型思考、工具原始参数或原始返回。

## 5. GET /api/aaas/v1/tasks/{id}/events

查询参数：`after`（不透明游标，省略从最早）、`limit`（1..200，默认 50）。Task 与 Events 共用同一分页常量。

响应 `200`：

```json
{
  "data": {
    "events": [
      {
        "sequence": "7",
        "operation_id": "<uuid>|null",
        "type": "operation.progress",
        "schema_version": 1,
        "payload": { "stage": "tools", "tools_completed": 2, "tools_total": 3 },
        "created_at": "<date-time>"
      }
    ],
    "next_cursor": "<opaque>|null",
    "has_more": false
  },
  "requestId": "..."
}
```

History 完整类型：`task.created`、`operation.accepted`、`operation.queued`、`operation.started`、`operation.progress`、`operation.completed`、`operation.failed`、`operation.canceled`、`task.canceled`、`task.cleanup_completed`、`context.committed`、`user.message`、`assistant.message`、`tool.call`、`tool.result`。后四类只存原始 History，不投影到公开接口。

公开事件按类型绑定严格 payload：生命周期类为空对象；`operation.progress` 仅安全进度白名单；`operation.completed` 可含 `result`；`operation.failed` 含 `error.code`；`operation.canceled`/`task.canceled` 可含 `reason`；`context.committed` 含 `sequence`。公开事件不携带模型思考、工具原始参数、原始返回或凭据。错误：`404 TASK_NOT_ACCESSIBLE`。

## 6. POST /api/aaas/v1/tasks/{id}/cancel

请求：`{ "reason": "<optional text>" }`。

响应 `200`：

```json
{
  "data": {
    "task_id": "<uuid>",
    "status": "canceled",
    "canceled_at": "<date-time>",
    "cleanup_pending": true
  },
  "requestId": "..."
}
```

取消提交即业务终止；物理停止可以仍在清理。取消不改写此前已提交的终态；新输入返回 `409 TASK_CANCELED`。错误：`404 TASK_NOT_ACCESSIBLE`。

## MCP 发现（保留旧契约）

`GET /api/aaas/v1/mcp-servers` 返回 Server 概要与 `tool_count`；`GET /api/aaas/v1/mcp-servers/{server_id}` 返回该 Server 的冻结工具白名单、公开参数 Schema 与凭据需求。两者共用有效能力解析；范围外 Server 当前返回 `404 NOT_FOUND`，响应不含凭据值。第三阶段已把发现接到 `resolveEffectiveCapabilities`：Router-only Key 默认直接能力；双入口 Key 带 `X-Router-Capability-Scope: router` 使用直接能力，无该头保留旧配置行为；显式 Router 遇到缺失或无效能力直接失败，不回退。公开 Schema 由敏感规则过滤，不含敏感参数。同一解析接口供第四阶段受理复用。

管理端新增 `POST /api/control/v1/mcp-servers/{server_id}/sensitive-rules`，请求 `{ rules: [{ mcpServerId, toolNames, parameter, credentialId }], expected_revision?, reuse_equivalent? }`；路径与规则体的 Server ID 都接受 `mcp_<uuid>` 或裸 UUID，按同一 Server 比较，跨 Server 规则返回 `422 MCP_BINDING_VIOLATION`。批量规则冻结为精确工具集合，返回 `{ revision, created, sensitive_bindings }`。NULL 表示未登记，`[]` 表示明确登记为空；新增或 Schema 已变更的工具在规则发布前不得授权给 Router。Router 发现详情 `required_credentials` 仅包含已授权工具需要的业务凭据条目。此接口不改变旧 AaaS V1 三条发现路径的字段语义。

## 管理端

以下路径沿用现有管理员认证，按当前租户与 Key 限定读取范围。共用前缀为 `/api/admin/v1/aaas/keys`。

| 路径 | 行为 |
| --- | --- |
| `POST /` | `router_only: true` 创建 Router-only Key。管理端默认选择此模式，配置直接能力后即可受理 Router 请求。 |
| `GET /{key_id}/router` | 读取 `scope`、`capabilityRevision`、`capabilities` 与 `canRollback`。 |
| `PUT /{key_id}/router` | 提交 `expected_revision` 与完整 `capabilities`。已配置的 Key 保持范围，旧 Key 首次保存成功后进入双入口。 |
| `PATCH /{key_id}/router` | `cutover` 需要 `expected_revision`、`migration_confirmed: true`。`rollback` 需要 `expected_revision`、已留档的切换记录及可用旧配置。两个动作都递增修订并写入审计。 |
| `GET /{key_id}/router/tasks` | 按 `after` Task ID 分页列出任务，并返回该 Key 的 Router Usage 汇总。 |
| `GET /{key_id}/router/tasks/{task_id}` | 查看任务、Operation 分页、Usage 和当前占用状态。 |
| `GET /{key_id}/router/tasks/{task_id}/history` | 按 `after`、`limit` 读取事件摘要，标明模型与工具结果是否进入后续上下文。 |
| `GET /{key_id}/router/operations/{operation_id}` | 读取 Operation 详情和 Usage。 |
| `GET /{key_id}/router/operations/{operation_id}/trajectory` | 读取当前 Operation 的调用摘要 `{ entries, next_cursor }`；`limit` 默认 50、最多 200，`after` 使用上一页游标。返回模型或 MCP 工具名、起止时间、已记录耗时与调用状态；找不到归属时返回 `404 OPERATION_NOT_ACCESSIBLE`。 |
| `GET /legacy-configuration-status` | `writable: false` 时，旧 AaaS 兼容入口提供历史读取。旧配置写入返回 `409 LEGACY_CONFIGURATION_RETIRED`。 |

修订竞争返回 `409 CAPABILITY_REVISION_CONFLICT`。旧 Run 的重放、历史查询和 Usage 继续按旧契约执行。管理读取记录审计，History 中工具往返提供工具名称摘要。Operation 仍使用公开详情的安全结果投影。MCP 管理中心通过现有 `/api/control/v1/mcp-servers/{server_id}/sensitive-rules` 读取当前规则并发布新 Revision。

## 错误码表（第一阶段定义）

| 状态 | code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 请求结构或字段无效 |
| 400 | `MISSING_CREDENTIAL` | 缺少冻结能力要求的凭据维度，可返回维度名 |
| 400 | `INVALID_CREDENTIAL` | 多余、重复或不合法的凭据 |
| 401 | `UNAUTHORIZED` | API Key 缺失、无效、禁用或撤销 |
| 403 | `CAPABILITY_SCOPE_REQUIRED` | 双入口 Key 未显式选择 Router 能力范围 |
| 403 | `CAPABILITY_UNAVAILABLE` | 直接能力未登记、引用失效或能力不完整 |
| 404 | `TASK_NOT_ACCESSIBLE` / `OPERATION_NOT_ACCESSIBLE` / `NOT_FOUND`（MCP 详情） | 不存在、不属于当前 Key 或不在有效能力范围内，共用不可访问响应 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同幂等键对应不同请求内容 |
| 409 | `TASK_CANCELED` | Task 已永久取消；前序失败不是新输入错误 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过 96 KiB |
| 422 | `CREDENTIAL_WINDOW_EXPIRED` | 保守凭据窗口检查失败；V1 无续期接口 |
| 429 | `QUEUE_FULL` | 等待队列已满，稍后可重新提交 |
| 500 | `INTERNAL` | 操作失败，请检查服务状态或配置冲突 |

静态 Schema/OpenAPI/错误码一致性由 `router-contracts.test.ts` 校验；实际可调用性、鉴权、调度与执行属于后续阶段验收。

## 管理端执行读取

控制台的四类来源保持各自身份。会话列表接受可选的 `executionState`，旧 Run 取工作项状态，Chat 取最近一轮执行事件推导的状态。会话生命周期继续由 `status` 表示。

`GET /api/admin/v1/aaas/keys/router-executions` 需要管理员认证，按当前租户返回 Operation、Task 和 Key 标识。支持 `q`（Task、Operation、Key ID 或 Key 名称）、`status`（Operation 状态）、`key_id` 与 `after`，每页 50 项。指定 Key 时同时返回该 Key 的累计已知用量。详情继续使用按 Key 限定的 Task、Operation 与脱敏 History 接口。

`GET /api/control/v1/usage` 的 `router` 视图按 Operation 受理时间筛选 `[from,to)`。完整用量与已知部分分别统计，未知字段保留空值。旧用量字段和公开业务路由沿用原契约。
