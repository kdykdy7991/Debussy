# WB-000：冻结契约、术语和路由

状态：Complete / Ready for review

## 目标

在任何页面重构或数据库改动前，冻结管理员工作台共享术语、公开 ID、路由和首批 DTO，消除旧 `/publishing` 规格与新工作台的冲突。

## 修改范围

- `runtimes/pi/packages/protocol/src/`
- `runtimes/pi/packages/protocol/test/`
- `docs/ADMIN-WORKBENCH-INTEGRATION-IMPLEMENTATION.md`
- `docs/admin-workbench/`

## 交付

1. 冻结 `AgentSummary`、`AgentRevisionSummary`、`PublishedAppSummary`、`ConversationAdminSummary`、`SessionEventEnvelope` 等共享类型。
2. 冻结 UI 术语：对话、Agent、应用、用户会话。
3. 冻结管理员路由及 `/publishing/*` 重定向表。
4. 为未知状态定义只读 fallback，不使用 TypeScript enum。
5. 明确 AgentDefinition 与 UI Agent 的映射；协议中只保留一个权威名称。

## 禁止

- 不改 Web 布局。
- 不增加数据库 migration。
- 不改变 Embed 身份和 Conversation scope。
- 不暴露裸 UUID、RuntimeSpec secret 或完整 system prompt。

## 验收

- protocol build/test typecheck 通过。
- DTO 不含 Token、PEM、visitorId、externalUserId 或 Provider secret。
- 所有公开资源 ID 使用现有前缀表示。
- 路由和术语在总规格、任务索引和协议 JSDoc 中一致。

## 交接

创建 `docs/admin-workbench/handoffs/WB-000-contracts-and-routing.md`，列出冻结类型、路由、状态联合和下游导入路径。
