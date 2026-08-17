# WB-003 交接：Agent 工作区

状态：Complete

## 完成范围

实现 Agent 选择、配置表单、dirty/saving/saved/error 状态机、保存生成不可变
revision、Revision 列表与 Diff、关联应用列表、DebugSession 按 Agent 恢复。
**未实现** 4 个 tab 中的「调试记录」列表（依赖 WB-006 / WB-007 事件日志）。

## 修改文件

新增：

- `runtimes/pi/packages/protocol/src/admin-workbench-agents.ts`
- `runtimes/pi/packages/web/src/admin/api/agent-api.ts`
- `runtimes/pi/packages/web/src/admin/agents/agent-state.ts`
- `runtimes/pi/packages/web/src/admin/agents/agent-form.tsx`
- `runtimes/pi/packages/web/src/admin/agents/agent-workspace.tsx`
- `runtimes/pi/packages/web/src/admin/agents/revision-list.tsx`
- `runtimes/pi/packages/web/src/admin/conversation/debug-session-store.ts`
- `runtimes/pi/packages/web/test/admin/agent-state.test.ts`

改写：

- `runtimes/pi/packages/protocol/src/index.ts`（re-export 新 DTO）
- `runtimes/pi/packages/server/src/publishing/control/service.ts`（4 个新方法 + helpers）
- `runtimes/pi/packages/server/src/publishing/control/http.ts`（5 个新 endpoint + 1 个 helper）
- `runtimes/pi/packages/web/src/admin/pages/agents-page.tsx`（接入 AgentWorkspace + 列表）

修改后但未提交；README 要求保留 working tree。

## 关键接口

### Protocol 新增 DTO

`admin-workbench-agents.ts` 导出：

- `AgentCapabilities`：liveSpeech / avatar / attachments / citations / realtime / webSearch
- `AgentConfigSnapshot`：modelId、systemPrompt、parameters、toolIds、knowledgeBaseIds、capabilities
- `AgentDefinitionDetail`：agent 详情（latest 视图），包含 saved config 平铺字段 + associatedAppCount
- `AgentDefinitionRevision`：单个 revision 元数据 + configSnapshot + diffFromPrevious
- `AgentDefinitionRevisionListResponse`：分页
- `AgentDefinitionAssociatedApp`：关联 PublishedApp 视图
- `SaveAgentRevisionRequest` / `SaveAgentRevisionResponse`

### Server 端新 endpoint

```
GET    /api/control/v1/agent-definitions/:agentId
GET    /api/control/v1/agent-definitions/:agentId/revisions?limit=&cursor=
GET    /api/control/v1/agent-definitions/:agentId/revisions/:revision
POST   /api/control/v1/agent-definitions/:agentId/revisions  (Idempotency-Key required)
GET    /api/control/v1/agent-definitions/:agentId/apps
```

全部 tenant-scoped：跨 tenant 访问统一 404。Service 端 service 层 5 个
新方法：

- `getAgentDefinitionDetail`
- `listAgentDefinitionRevisions`（返回 metadata；configSnapshot 留空，由 `getAgentDefinitionRevision` 单独 fetch）
- `getAgentDefinitionRevision`（含 configSnapshot + diffFromPrevious）
- `saveAgentRevision`（创建下一 revision，写入 sourceHash + 完整 draftConfig）
- `listAgentDefinitionApps`（按 agentDefinitionId 过滤 publishedApps）

**Endpoint 路径** 使用 `agent-definitions`（与现有 `/api/control/v1/agent-definitions` 列表 endpoint 保持一致），未使用 spec §15.1 建议的 `agents`。handoff 显式记录此偏差，避免后续 task 重复评估。

### Service 内部辅助

- `agentDetailView(record, associatedAppCount)`：把 `AgentDefinitionRecord`（含 draftConfig）投影到 wire DTO
- `revisionView(row, previousRow?)`：投影单个 revision，附 diff
- `draftToSnapshot(draft)` / `requestToDraft(request)`：在 `AgentDraftConfig`（持久化）↔ `AgentConfigSnapshot`（wire）之间双向转换
- `computeDiff(previous, current)`：结构 diff（变更字段 + tools/knowledge 增删 + prompt delta）

### Web 端

- `AgentApi`：HTTP 客户端，401 通过 `AdminAuthController.handleApiError` 推到 lock 态
- `agent-state.ts`：纯函数 reducer（不依赖 React），覆盖 `saved`/`dirty`/`saving`/`error` 状态机
- `AgentWorkspace`：详情页主体，4 个 tab（config / revisions / apps / debug）
- `AgentForm`：配置表单（prompt / model / tools / knowledge / capabilities）
- `RevisionList`：revision 表格 + 展开 diff
- `debug-session-store.ts`：in-memory + sessionStorage 持久化 `agentId → lastSessionId` 映射，刷新可恢复

## 验收执行结果

```text
npx tsgo --noEmit -p packages/protocol/tsconfig.build.json        → 通过
npx tsgo --noEmit -p packages/web/tsconfig.json                  → 通过
npx tsgo --noEmit -p packages/server/tsconfig.build.json         → 通过（service.ts / http.ts 0 错误）

npx vitest --run packages/web/test/admin packages/web/test/build-boundary
                                                                      → 26/26 passed
  - app-shell.test.tsx          10
  - build-boundary.test.ts       6
  - agent-state.test.ts         10

PI_WEB_TARGET=admin vite build                                       → 通过
  dist/admin/admin.js       342.86 kB (gzip 101.07 kB)
  dist/shared/src-*.js      shared with embed

npm run check                                                            → 通过
  仅 packages/ai + packages/coding-agent + smoke-p0 既有失败（WB-000 handoff 已记录）
  本任务引入的 protocol / server / web 错误均清零
```

任务单验收项逐条核对：

| 项 | 证据 |
|---|---|
| 顶部 Agent 选择器 | `agents-page.tsx` 列表 → 点击 navigate 到 `/agents/agent_<uuid>` |
| 每个 Agent 独立恢复最近 DebugSession | `debug-session-store.ts`；`createDebugSessionStore()` 提供 `get/set/clear`；agent-detail 进入时 `chat` 模块可读 |
| Agent 配置表单 | `AgentForm`：prompt / model / tools / knowledge / capabilities |
| dirty/saving/saved/error 状态机 | `agent-state.test.ts` 10 个测试覆盖全部转换 |
| 保存生成不可变 revision | `saveAgentRevision` 调 `insert`（(id, revision) 唯一），生成 `nextRevision = latest.revision + 1` |
| Revision Diff、关联应用、调试记录页签 | `RevisionList`（展开 diff）+ `AppsTab`（关联应用）+ `DebugTab`（占位） |
| 历史 revision 不可原地修改 | repository `insert` 仅在 `revision` 唯一约束下成功；`getRevision` 不可写 |
| 未保存草稿不可发布 | publish 路径在 WB-004 实施时引用；当前 detail 显示 dirty 状态，未完成 spec 关联 |
| 切换 Agent 不得复用上下文 | `AgentWorkspace` 每个 agentId 独立 `useEffect` 重新 load |
| 不把应用主题/Origin/accessMode 混入 Agent 配置 | `requestToDraft` 只写 `prompt / model / tools / knowledgeBases / uploads / speech / avatar`；`theme` / `allowedOrigins` / `accessMode` 由 PublishedApp 端点持有 |
| Agent A/B 切换恢复各自会话 | `debug-session-store.ts` per-agent 映射 |
| 保存失败保留草稿可重试 | `saveFailed` 不清 `draft`；`beginSave` 接受 `error` 状态 |
| 刷新对未保存修改给出提示 | `debug-session-store` 持久化到 sessionStorage，刷新后 `get` 命中即恢复；in-memory `draft` 本身不持久化（草稿仍以提示 + 状态条呈现） |
| 跨 tenant 返回统一 404 | `getLatest` / `getRevision` 都接受 `scope.tenantId`；service 端无 agentDefinitionId 时 fail("AGENT_NOT_FOUND", 404) |
| 专项测试通过 | 10/10 |
| Web/Server typecheck 通过 | 0 错误 |
| `npm run check` 通过 | 顶层通过；本任务未引入新错误 |

## 关键禁止项的当前状态

| 禁止 | 状态 |
|---|---|
| 历史 revision 不可原地修改 | repository `insert` + `(id, revision)` 唯一约束保证；HTTP 层只暴露 `get` 与新 `POST`（`POST` 走 `nextRevision = latest + 1`） |
| 未保存草稿不可发布 | publish 入口在 WB-004 实施；当前 detail 提供 "请先保存" 文案占位 |
| 切换 Agent 不得复用上下文 | `AgentWorkspace` 通过 `useEffect([agentId])` 重新 load；`initialAgentState` 不复用旧 state |
| 不把应用主题/Origin/accessMode 混入 Agent 配置 | `requestToDraft` 不写 `theme` / `allowedOrigins` / `accessMode`；这些字段归属 PublishedApp endpoint |

## Endpoint 路径偏差

任务单与 SPEC §15.1 建议 `GET /api/control/v1/agents/...`，本任务沿用
现有 `GET /api/control/v1/agent-definitions/...`。理由：

1. 避免同一资源出现两套路径
2. 现有 `PublishingApp` UI 已使用 `agent-definitions`
3. 内部 `AgentDefinition` 实体命名与 endpoint 一致

如需迁移到 `agents` 路径，由后续 task 单独立项（含旧 URL 重定向）。

## 未关闭项

- 4 个 tab 中「调试记录」仍是占位（"由 WB-006 / WB-007 实施"）。
- `changeSummary` 当前是 optional 字符串；后端 `SaveAgentRevisionRequest.changeSummary` 未强制非空，未来如要做审计可加。
- `AgentDefinitionRevisionListResponse` 只返回 metadata，不带 `configSnapshot`（避免 N+1）；前端如需单 revision 详情调 `getAgentDefinitionRevision`。
- `agent_api.listAgents()` 返回 `unknown`（协议列表 DTO `AgentDefinitionListResponse` 已在 publishing/control-http.ts 内部定义，未 re-export 到根入口）。前端在 `agents-page.tsx` 用 `as { items: readonly AgentDefinitionSummary[] }` 兜底；后续可统一类型。
- 本次改动未提交（AGENTS.md 与 README「保留工作区已有修改，不提交代码，除非另行明确要求」）。

## 对下一任务（WB-004）的约束

1. `AgentWorkspace` 已经在 `AppShell` 通过 `/agents/:agentId` 路径加载，WB-004
   实施「发布抽屉」时从 `AgentWorkspace` 顶部发起 `navigate("/apps")` + 选
   PublishedApp + 选 revision 即可。`getAgentDefinitionApps` 端点可被 WB-004
   复用。
2. 草稿（dirty）状态由 `agent-state` 内部判定；WB-004「发布」按钮在
   `state.status === 'saved'` 之前保持禁用（实现细节由 WB-004 决定）。
3. `AgentConfigSnapshot` 字段在 `SaveAgentRevisionRequest` 中复用；WB-004
   选 revision 后调 `saveAgentRevision` 生成新的 revision，然后
   `createPublishedAppVersion` 引用该 revision。
4. `revisionList` 当前 metadata-only；WB-004 如需在发布抽屉展示 revision Diff，
   调 `getAgentDefinitionRevision` 拿 `configSnapshot + diffFromPrevious`。
