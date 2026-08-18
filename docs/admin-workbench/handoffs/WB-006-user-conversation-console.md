# WB-006 交接： 用户会话控制台

状态：Complete

## 完成范围

实现保存了真实企业用户 Conversation 的全局检索与详情（spec §5.4）：
默认脱敏列表（跨 App/Agent/主体/应用筛选 + cursor 分页）、会话详情
（概览 / 事件日志 / Summary / 附件页签 + 前后 rollover 导航），以及进入
正文/附件/事件/摘要时的审计记录。独立的 Admin Control API 由
`/api/control/v1/conversations*` 提供，UI 位于
`packages/web/src/admin/user-conversations/`。

## 修改文件

### 协议层（`@earendil-works/pi-protocol`）

- `packages/protocol/src/admin-workbench-conversations.ts`（新增）— 管理面
  会话契约：`ConversationListFilter`、`ConversationAdminListResponse`（含
  `redacted: true` 哨兵）、`ConversationAdminEvent` / `AdminConversationEventKind`
  （未知类型 → `"unknown"`）、`ConversationAdminEventListResponse`、
  `ConversationAdminSummaryEntry` / `ConversationAdminSummaryListResponse`、
  `ConversationAdminAttachment` / `ConversationAdminAttachmentListResponse`、
  `ADMIN_CONVERSATION_READ_ACTIONS` 审计动作枚举
- `packages/protocol/src/index.ts` — re-export 新文件

### 服务端（`@earendil-works/pi-server`）

- `packages/server/src/publishing/repositories.ts` —
  - `ConversationRepository.listByTenant` / `getByTenant`（tenant 维、跨
    principal、无正文）
  - `AdminConversationListParams` / `AdminConversationListRow`
    （含 `messageCount`/`errorCount`/`agentId`/`principalDisplayId`/
    `principalType`/`appName`/`publicAppId`）
  - `ConversationEventRepository.listByConversation`（admin 版事件分页）
  - `AttachmentRepository.listByConversationTenant`
    - `AdminConversationEventListParams`
- `packages/server/src/persistence/postgres/repositories/conversations.ts` —
  `listByTenant`（按 app/status/时间/version/agentId/hasErrors/principalType/
  cursor 过滤，join principals + published_apps + published_app_versions，
  错误/消息计数经子查询）+ `getByTenant`；`toAdminListRow` 用 subject hash
  前 8 位生成 `principalDisplayId`（永远不暴露原始 subject）
- `packages/server/src/persistence/postgres/repositories/conversation-events.ts` —
  `listByConversation`（tenant + conversationId 唯一作用域）
- `packages/server/src/persistence/postgres/repositories/attachments.ts` —
  `listByConversationTenant`（ready + staged 元数据）
- `packages/server/src/publishing/control/service.ts` —
  `listConversations` / `getConversationAdminDetail` / `listConversationEvents` /
  `listConversationSummaries` / `listConversationAttachments`，全部在读取时
  写 `conversation.read-*` 审计；新增 `CONVERSATION_NOT_FOUND` 错误码；
  helper `toConversationAdminSummary` / `toConversationAdminSummaryEntry` /
  `mapPrincipalType` / `isSessionEventType`
- `packages/server/src/publishing/control/http.ts` — 4 个 GET 路由
  （`/conversations`、`/conversations/:cid`、`/conversations/:cid/events`、
  `/conversations/:cid/attachments`、`/conversations/:cid/summaries`），
  `parseConversationListQuery` / `parseConversationId` / `parsePositiveInt` /
  `parseIsoOrNull`

### Web 端（`@earendil-works/pi-web`）

- `packages/web/src/admin/api/conversations-api.ts`（新增）— admin 会话 HTTP
  客户端（Authorization header、401 冒泡、脱敏）
- `packages/web/src/admin/user-conversations/conversations-index.tsx`（新增）—
  列表页：状态/主体类型/仅错误筛选 + 本地自由文本搜索 + cursor 分页
- `packages/web/src/admin/user-conversations/conversation-detail.tsx`（新增）—
  详情页：概览 / 事件日志（按 `afterSequence` 增量加载，未知事件安全只读）/
  Summary / 附件页签 + rollover 前后导航
- `packages/web/src/admin/pages/user-conversations-page.tsx` — 路由到 index/detail
- `packages/web/src/admin/styles.css` — WB-006 会话控制台样式

### 测试

- `packages/server/test/publishing/control-conversations.test.ts`（新增，6 测试）—
  脱敏列表无正文、principal 类型收窄、未知事件 `kind="unknown"`、跨租户统一
  404、审计写入、summary/rollover 投影

## 关键接口与数据结构

### `GET /api/control/v1/conversations`

筛选 query 参数：`limit`(1..100) / `cursor` / `appId` / `agentId` /
`publishedAppVersionId` / `status`(active|archived|deleted) / `hasErrors`(true|false) /
`principalType`(external_user|anonymous_visitor) / `createdAfter` / `createdBefore`。

响应 `ConversationAdminListResponse`：

```jsonc
{
  "items": [ {
    "id": "conv_…", "appId": "app_…", "publicAppId": "pub_…", "appName": "…",
    "agentId": "agent_…",          // 无 Agent 时为空字符串哨兵
    "principalDisplayId": "prn_abcdef12",   // subject hash 前 8 位
    "principalType": "external_user",
    "publishedAppVersionId": "pav_…",
    "title": "…", "status": "active",
    "messageCount": 6, "errorCount": 1,
    "lastEventSequence": 12,
    "createdAt": "…", "lastActiveAt": "…"
  } ],
  "nextCursor": "…",
  "redacted": true
}
```

### `GET /api/control/v1/conversations/:cid/events`

query：`limit`(1..500) / `afterSequence`（增量加载，避免一次拉全量历史）。
每个事件带 `kind`（已知类型原样、未知→`"unknown"`），未知事件仍以
`eventType` 原值安全只读展示。响应含 `lastEventSequence`（会话已确认序号）与
`nextAfterSequence`（`null` == 无更多）。

### 审计

每次进入正文/事件/摘要/附件都会写一条审计：
`conversation.read-transcript` / `read-events` / `read-summary` /
`read-attachments`，resourceType=`conversation`，记录会话 id 与 requestId。

### 越权

跨 tenant 的会话读取统一返回 `CONVERSATION_NOT_FOUND`（404），与「会话不存在」
不可区分；跨 owner（同一 tenant 内任意 principal）允许，符合 Admin 控制台语义。

## 安全/脱敏规则（spec §15.3 + §18）

- 列表默认**不含**消息正文；`redacted: true` 明示，正文需显式拉取 `/events`
- **不返回**原始 `externalUserId` / `visitorId` / subject：仅暴露
  `principalDisplayId`（subject hash 截断前 8 位）
- **不返回** Token / PEM / provider secret；附件仅元数据（无 objectKey /
  checksum）
- 未知事件类型不回导致页面崩溃，以安全只读占位渲染

## 执行过的命令及结果

```text
(cd packages/protocol && npx tsgo -p tsconfig.build.json)                 → OK
npx tsgo --noEmit -p packages/server/tsconfig.build.json                 → OK
npx tsgo --noEmit -p packages/web/tsconfig.json                          → OK
node ../node_modules/vitest/dist/cli.js --run test/publishing/control-conversations.test.ts  → 6/6
同目录回归：summary-repository + event-counters + summary-builder + context-restore        → 34/34
packages/web/test/embed/embed-logic.test.ts                              → 10/10
packages/protocol/test/session-events.test.ts                            → 19/19
npx biome check (WB-006 文件)                                            → no errors
```

## 未关闭项

- **附件下载面**：MVP 控制面只列出附件元数据，没有下载/预览端点（需要对象
  存储授权 URL），后续做下载时补 `/attachments/:id/content` 并再次审计。
- **Agent 筛选的可见性**：`agentId` 过滤走 `published_app_versions.join`，
  依赖该版本仍存在；若版本被清理会导致该会话不出现（现有 schema 保留历史版本，
  故通常可用）。
- **正文无需单独 Transcript 端点**：概览页展示头部与最新 Summary，正文走
  事件日志 Tab；若需「完整 Transcript」视图（合并 user/assistant 消息流），
  可在 WB-009 导出时一并消费 `/events`。

## 对下一任务（WB-009 日志导出）的约束

1. `/api/control/v1/conversations/:cid/events` 增量分页已就绪，导出可直接复用
   该契约（`limit`+`afterSequence`），并应在导出动作写一条 `conversation.exported`
   审计。
2. 导出时仍须遵守脱敏规则：不导出原始 subject/PEM 等敏感字段；导出正文前
   校验跨租户 404。
3. UI 会话详情的事件日志已按 `afterSequence` 增量加载，WB-009 的「导出 JSONL」
   可从服务端直接流式生成，避免一次拉全量进内存。