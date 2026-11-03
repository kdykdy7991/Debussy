# Agent 任务 API 接入说明

接入方只需调用两个 API：下发任务、查询结果。模型、思考强度和 MCP 工具由平台配置，无需嵌入页面或接入配置接口。

本说明对应含迁移 `0027` 的新版本；现有运行实例是否已升级，以平台方通知为准。旧 `prompt` 请求保留兼容，不需要接入方立即切换。

## 接入信息

平台方提供可达的 `BASE_URL`、`INTEGRATION_ID` 和 `INTEGRATION_TOKEN`。Token 仅存放在接入方后端，单独安全交付；局域网跨机器时使用平台局域网地址，不能使用 127.0.0.1。

## 1. 下发任务

```http
POST {BASE_URL}/api/aaas/v1/integrations/{INTEGRATION_ID}/runs
Authorization: Bearer {INTEGRATION_TOKEN}
Idempotency-Key: <本次任务唯一标识>
Content-Type: application/json
```

```json
{
  "input": {"ticket_id":"TK001", "content":"设备持续连接超时，请分析原因"},
  "credentials": {"authToken": "<本次工具调用的业务密钥>"}
}
```

- `input`：通用 JSON 对象，作为当前任务消息交给 Agent，与平台配置的系统提示词配合使用。`ticket_id`、`content` 是示例业务字段，平台不自动按 ID 查询；是否查询和调用哪些工具由任务规则与模型决定。总请求体不超过 96 KiB。
- `credentials.authToken`：独立提供工具业务密钥，可按任务变化，不提供用户名映射。无需传有效期，平台内部默认授权 30 分钟；这不会延长下游密钥本身的有效期。未配置任务凭据映射时可省略 credentials。
- 可选 `external_ref: {"type":"ticket","id":"TK001"}` 仅作业务关联，不会自动拼入任务消息。
- 网络重试使用相同幂等键和完全相同的请求；主动重新执行使用新键。不同内容重复用键返回 409。

兼容期仍接受 `{"prompt":"本次系统提示词", "credentials":{...}}`：保持旧的系统提示词覆盖语义（非空白字符串，最长 48000 字符），不会修改平台配置，也不能扩大模型或工具权限。`input` 与 `prompt` 必须二选一，同时提供返回 400。一个幂等键不能从旧契约切换为新契约；迁移请求格式时使用新任务键，历史 Run 保持原语义。兼容下线日期另行通知。

成功返回 HTTP 202：

```json
{"data":{"run_id":"<任务ID>","status":"queued","duplicate":false},"requestId":"<请求ID>"}
```

## 2. 查询结果

```http
GET {BASE_URL}/api/aaas/v1/runs/{run_id}
Authorization: Bearer {INTEGRATION_TOKEN}
```

建议每隔 2～5 秒查询。状态为 queued（排队）、running（执行）、completed（完成）、failed（失败）、cancelled（取消），后三者停止轮询。

完成响应的关键字段：

```json
{"data":{"run_id":"<任务ID>","status":"completed","result":"LLM最终原文输出","error":null},"requestId":"<请求ID>"}
```

`result` 为字符串，保留 Markdown、换行和空白，不限制报告字段；即使模型输出 JSON，也作为文本返回，由接入方按需解析。未成功时 result 为 null；失败读取 `data.error.code`。当前使用轮询，无 Webhook。

`agent_version` 对新编排版本返回 `orv_<UUID>`，历史 Run 的 `pav_<UUID>` 保持不变。Run 固定接受时的版本，后续发布不改变它的执行配置或结果。

联调报错时提供 HTTP 状态码、error.code、requestId、run_id，不发送密钥明文。
