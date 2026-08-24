# Agent 平台 V2：metrics / context API 示例（M0）

接口路径在 M0 可调整；响应语义、租户边界与不可变版本原则不变。控制面需
`X-Tenant-Name` 与 Admin Token；写操作仍需 Idempotency-Key（均为只读查询，无需）。

## 1. 单会话指标：`GET /api/control/v1/conversations/:id/metrics`

```bash
curl -sS \
  -H "X-Tenant-Name: acme" \
  -H "Authorization: Bearer $CONTROL_ADMIN_TOKEN" \
  "https://localhost:PORT/api/control/v1/conversations/conv_8f3a2e/metrics"
```

成功（HTTP 200）：正文见 `../m0-fixtures/metrics-success.json`。
旧会话/无指标（HTTP 200，`stats.available=false`、`items=[]`）：见 `../m0-fixtures/metrics-empty.json`。
权限失败（HTTP 404 统一信封）：见 `../m0-fixtures/metrics-forbidden.json`。
验证失败（HTTP 422 `INVALID_METRICS_FILTER`）：见 `../m0-fixtures/metrics-invalid.json`。
服务不可用（HTTP 503 `RUNTIME_UNAVAILABLE`）：见 `../m0-fixtures/metrics-unavailable.json`。

## 2. 单会话上下文快照：`GET /api/control/v1/conversations/:id/context`

```bash
curl -sS \
  -H "X-Tenant-Name: acme" \
  -H "Authorization: Bearer $CONTROL_ADMIN_TOKEN" \
  "https://localhost:PORT/api/control/v1/conversations/conv_8f3a2e/context"
```

成功（HTTP 200）：

```json
{
  "conversationId": "conv_8f3a2e",
  "available": true,
  "latest": {
    "usedTokens": 21430,
    "contextWindow": 100000,
    "remainingTokens": 76570,
    "reservedOutputTokens": 2000,
    "usagePercent": 21.43,
    "measurement": "estimated",
    "breakdown": {
      "systemPrompt": 3200,
      "skillInstructions": 0,
      "toolDefinitions": 0,
      "conversationMessages": 16980,
      "toolResults": 0,
      "retrievalContext": 1250,
      "attachments": 0
    }
  },
  "atSequence": 42
}
```

旧会话/无快照（HTTP 200，`available=false`、`latest=null`、`atSequence=null`）：
分项之和必须等于 `usedTokens`（21430 = 3200 + 16980 + 1250）。

## 3. 空值、空态与错误分界

- `latest.breakdown` 缺省分项为 0，但“无该来源”与“值为 0”在调用端语义一致。
- `TurnMetrics` 中 `ttftMs/generationMs/outputTokensPerSecond` 无值必须为 `null`
  而非 0；`totalLatencyMs` 恒有值。failed/cancelled 回合以前三者均为 `null` 表达。
- 空态 ≠ 错误：会话存在但无指标/快照 → HTTP 200 `available=false`；子系统不可用 →
  HTTP 503 `METRICS_UNAVAILABLE`/`CONTEXT_SNAPSHOT_UNAVAILABLE`；会话不存在/越权 →
  HTTP 404 `CONVERSATION_NOT_FOUND`。
- `nextAfterSequence` 为 metrics 列表分页游标；为 `null` 表示没有下一页。
- 完整错误码表见 `m0-contract-2026-08-24.md` §3，`turn/end` payload 扩展见同一文档 §4。
## 4. 分页示例（默认 50 / 上限 200）

第 1 页 `GET .../metrics?afterSequence=0&limit=2` 返回 seq 41/42：
`items` 升序、`nextAfterSequence = 42`；`stats` 为**全会话**（turnCount=3）。
第 2 页 `GET .../metrics?afterSequence=42&limit=2` 返回 seq 43、
`nextAfterSequence = null`；**两页 `stats` 相同**。

对应正文见 `metrics-page-1.json` / `metrics-page-2.json`。

非法参数（`afterSequence=0`、`limit=0`、非整数）→ 422 信封：
```json
{ "error": { "code": "INVALID_METRICS_FILTER", "message": "limit must be a positive integer", "requestId": "req_7", "retryable": false } }
```

## 5. reasoning 会话覆盖示例（PUT）

`PUT /api/control/v1/conversations/:id/reasoning`，请求体 `ReasoningUpdateRequest`：
```json
{ "effort": "high" }
```
响应 `ConversationReasoningState`：
```json
{ "conversationId": "conv_8f3a2e", "effort": "high", "updatedAt": "2026-08-24T09:35:00.000Z" }
```
`effort: null` 清除会话覆盖，回到 Agent Revision 默认。每次更新写
`conversation.reasoning-updated` 审计事件（before/after + 生效快照）。档位不在模型
能力目录 → 422 `REASONING_INVALID_EFFORT`；无权调整 → 403 `REASONING_NOT_CONFIGURABLE`。
