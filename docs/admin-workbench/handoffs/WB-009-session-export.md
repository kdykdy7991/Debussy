# WB-009 交接： 会话日志流式导出

状态：Complete

## 完成范围

从 PostgreSQL 权威事件日志生成一致、可验证、内存有界的 gzip JSONL 导出。
经 `/api/control/v1/conversations/:cid/export`（管理员分页流式 GET），支持
`full` / `diagnostics` / `transcript` 三种模式，审计写入之后脱敏不落敏感
字段。交付采用单一的 `session.jsonl.gz` 单 gzip 流（首行为 manifest），
满足全部验收项（连续、冻结边界、内存有界、取消传播、脱敏、审计）。

> 归档容器范围缩小说明：规范交付项写明「JSONL ZIP 含 manifest/session.jsonl/
> transcript/diagnostics」，但仓库无任何 ZIP 依赖，且「禁止在内存组装完整
> ZIP」约束下需自带流式 ZIP 写入器。经与用户确认（单文件 gzip JSONL，
> 推荐选项）后，采用单 gzip 流交付；首行 manifest 承载元数据，transcript/
> full/diagnostics 由 mode 参数投影。旧/未用的 `账本-landing.html` 非本任务文件。

## 修改文件

### 协议层（`@earendil-works/pi-protocol`）

- `packages/protocol/src/admin-workbench-conversations.ts` — 追加
  `CONVERSATION_EXPORT_MODES` / `ConversationExportMode`
  （full|diagnostics|transcript）与 `ConversationExportManifest`
  （`exportVersion: "wb009-1"`，含冻结的 `throughSequence`、`mode`、
  `conversationId`、`generatedAt`）

### 服务端（`@earendil-works/pi-server`）

- `packages/server/src/publishing/export/session-export.ts`（新增）—
  流式 JSONL 行生成器 `exportSessionLines`。核心不变量：
  - 内存有界：一次只持有 `EXPORT_PAGE_SIZE`（250）行，逐行序列化即释放
  - 冻结 `throughSequence = conversation.lastEventSequence`；导出中新增
    事件（更高 sequence）绝不进入本归档
  - 连续无缺口：以 `expected` 计数校验页内与页间 sequence 必须连续，否则抛
    `gap` 错误（不静默跳过）
  - 投影：`full` 全量；`diagnostics` 对消息类事件（user/assistant message
    /chunk/delta、tool/input）的 `text`/`content` 脱敏为 `[redacted]`；
    `transcript` 仅输出 user/assistant 的 `{v,kind,sequence,role,text}`
  - 未知事件类型记 `kind` 为该类型或 `unknown`，从不明文返回原始 subject/PEM
- `packages/server/src/publishing/control/service.ts` —
  `streamConversationExport(...): AsyncGenerator<string>`（异步生成器）：
  校验 tenant 作用域（不存在 → 抛 `ConversationExportNotFound`），写
  `conversation.exported` 审计（记录 mode + 冻结 throughSequence），再委托
  `exportSessionLines`，paging 走 `events.listByConversation(afterSequence)`。
  新增错误类 `ConversationExportNotFound`。
- `packages/server/src/publishing/control/http.ts` —
  - `Route.handler` 上下文新增可选 `response`，返回类型扩为
    `Envelope | { kind: "stream" }`；GET 分发器对 `kind==="stream"` 跳过标准
    JSON envelope（流式路由自行写字节 + end）；POST 路径按需传入 `response`
  - 新增 `GET /conversations/:cid/export`：`mode` query 参数
    （full|diagnostics|transcript，默认 full），`Content-Type:
    application/jsonl+gzip`、`Content-Disposition: attachment`；先用一次
    `generator.next()` 提前探测 not-found（统一 404 CONVERSATION_NOT_FOUND）
    或内部错误（500）再写字节；随后 `Readable.from(generator) ->
    createGzip() -> response` 用 `pipeline` 驱动：客户端断开（response
    destroyed）或 DB 取消会传播到 generator 并停止压缩/查询工作；pipeline
    错误仅在非正常关闭且未破坏响应时上报 onError
  - 复用既有 `parseConversationId` / `errorEnvelope` / `jsonBody`

### Web 端（`@earendil-works/pi-web`）

- `packages/web/src/admin/api/conversations-api.ts` — 新增带管理员认证的 gzip
  导出下载客户端；服务端 JSON 错误继续透传 requestId，并保持 401 锁定语义
- `packages/web/src/admin/user-conversations/conversation-detail.tsx` — 会话详情接入
  诊断包、Transcript 和完整包下载；完整包要求输入「完整导出」二次确认，并明确
  提示正文/工具载荷敏感性和审计行为
- 同页签读取改为懒加载：事件、Summary、附件只在实际进入对应页签时请求，避免
  未查看内容却提前产生 `conversation.read-*` 审计
- `packages/web/src/admin/user-conversations/conversations-index.tsx` — 补齐 App、
  Agent、版本、时间筛选与保留筛选条件的前后 cursor 翻页；忽略过期响应，防止
  快速切换筛选时旧请求覆盖新结果
- `packages/web/test/admin/conversations-api.test.ts` — 高级筛选序列化、gzip 下载
  认证与导出 401 错误专项测试

### 测试

- `packages/server/test/publishing/session-export.test.ts`（新增，7 测试）—
  流式行生成器 + `ControlService.streamConversationExport`：
  - full 模式：manifest 在前、连续事件、多页驱动（内存有界分页）
  - transcript 模式只投影 user/assistant 文本
  - diagnostics 模式脱敏消息体、保留元数据
  - sequence 缺口抛错（不静默跳过）
  - 冻结 `throughSequence`：导出一旦开始随后追加的事件被排除
  - 导出审计 `conversation.exported` 写出
  - 跨 tenant → `ConversationExportNotFound`

## 关键接口

`GET /api/control/v1/conversations/:cid/export?mode=full|diagnostics|transcript`

响应：200 流式 `session.jsonl.gz`（gzip）：
- 第 1 行 = manifest：`{"v":1,"kind":"manifest","exportVersion":"wb009-1",
  "conversationId","mode","throughSequence","generatedAt"}`
- 之后每行一个事件（`full` 输出 `ConversationAdminEvent` 同构对象；
  `diagnostics`/`transcript` 按投影）。错误统一为 `application/json`
  envelope：400（非法 mode/cid）、404（跨租户 CONVERSATION_NOT_FOUND）、
  500（内部）。

## 执行过的命令及结果

```text
(cd packages/protocol && npx tsgo -p tsconfig.build.json)                → OK
npx tsgo --noEmit -p packages/server/tsconfig.build.json                 → OK
node ../node_modules/vitest/dist/cli.js --run test/publishing/session-export.test.ts  → 7/7
同文件回归：+ control-conversations(6) + summary-builder(5)                    → 18/18
packages/protocol/test/session-events.test.ts                          → 19/19
npx biome check .（整仓）                                               → no errors
packages/web/test/admin/conversations-api.test.ts                      → 3/3
packages/web tsgo --noEmit                                              → OK
```

## 未关闭项

- ZIP 多成员容器（manifest/transcript/diagnostics/附件分文件）未实现，按用户
  确认以单 gzip 流交付；如需多文件 ZIP，后续可加流式 ZIP 写入器（如
  fflate 的 streaming）+ 锁文件评审。

## 对下一任务（WB-010 企业 Embed SDK）的约束

1. WB-010 是独立的「企业 Embed SDK」集成任务，正常情况下不依赖本任务；本
   端点为后续「下载原始 JSON 审计副本」提供 HT 基础。
2. Embed SDK 侧若需读取会话元数据，应仍走 WB-006 `listConversations`（脱敏
   列表），导出端点仅面向平台管理员审计。

**握手提醒**：`Route.handler` 返回类型与 ctx 签名已改（新增 `response`，
返回可为 `{kind:"stream"}`）。后续任何新增 control 路由都要传入 `response`；
非流式路由无需处理 `kind:"stream"` 分支（POST 路径已按 `Envelope` 断言）。
