# WB-000 交接：契约、术语和路由冻结

状态：Complete / Ready for review

## 交付结果

WB-000 已新增管理员工作台共享协议契约，没有修改 Web 布局、Server 行为或数据库 schema。

## 修改文件

- `runtimes/pi/packages/protocol/src/admin-workbench.ts`
- `runtimes/pi/packages/protocol/src/index.ts`
- `runtimes/pi/packages/protocol/test/admin-workbench.test.ts`
- `docs/ADMIN-WORKBENCH-INTEGRATION-IMPLEMENTATION.md`
- `docs/admin-workbench/tasks/WB-000-contracts-and-routing.md`
- `docs/admin-workbench/handoffs/WB-000-contracts-and-routing.md`

## 冻结类型

从 `@earendil-works/pi-protocol` 根入口导入：

- `AgentSummary`
- `AgentRevisionSummary`
- `ConversationAdminSummary`
- `SessionEventEnvelope`
- `StatusResolution`
- `KnownPublishedAppStatus`
- `KnownPublishedAppVersionStatus`
- `KnownConversationStatus`
- display-prefixed public ID template literal types

既有 `PublishedAppSummary` 继续由 `publishing/control-http.ts` 提供。WB-000 没有复制或重定义它。

## Agent 命名决策

```text
UI Agent = AgentDefinition 的管理员投影
UI AgentRevision = 不可变 AgentDefinition revision
```

新工作台使用 `AgentSummary` 和 `AgentRevisionSummary`。旧 `AgentDefinitionSummary` 暂时只服务现有独立 Publishing Control DTO；WB-003/WB-004 迁移消费者后再决定是否移除旧名。

## 冻结路由

- `/`
- `/agents`
- `/agents/:agentId`
- `/apps`
- `/apps/:appId`
- `/conversations`
- `/conversations/:conversationId`
- `/settings`

下游使用 `ADMIN_WORKBENCH_ROUTES`，不要复制路由字符串。

旧路由映射：

- `/publishing`、`/publishing/` → `/apps`
- `/publishing/apps/app_*` → `/apps/app_*`
- 未知 `/publishing/*` 返回 `null`，不做含糊跳转。

## 冻结术语

`ADMIN_WORKBENCH_TERMS`：

- 对话
- Agent
- 应用
- 用户会话
- 设置

“对话”只指管理员调试；“用户会话”只指发布后的企业用户 Conversation。

## 未知状态

下游必须通过以下函数解析服务端状态：

- `resolvePublishedAppStatus`
- `resolvePublishedAppVersionStatus`
- `resolveConversationStatus`

已知状态返回 `kind: "known", readOnly: false`；任何未来未知状态返回 `kind: "unknown", readOnly: true`。危险操作不得只比较显示文本决定是否启用。

## 安全边界

新增管理员 DTO 不包含：

- Admin/Access/Launch Token；
- PEM；
- visitorId 或 externalUserId；
- Provider secret；
- 完整 system prompt 或 RuntimeSpec。

用户列表只携带服务端生成的 `principalDisplayId`。

## 验证结果

- `npx tsc --noEmit -p packages/protocol/tsconfig.build.json`：通过。
- `npx tsc --noEmit -p packages/protocol/tsconfig.test.json`：通过。
- `node ../../node_modules/vitest/dist/cli.js --run test/admin-workbench.test.ts`：10/10 通过。
- `npm run check`：未通过；Biome 完成且只格式化本任务新增协议文件，随后根级 `tsgo --noEmit` 被既有 AI model catalog 类型状态阻断。错误集中在 `packages/ai/src/providers/*.models.ts` 的 `unknown`/`ModelGroups`、依赖这些 catalog 的既有测试，以及 `scripts/smoke-p0.ts` 缺少 server 子路径声明；没有 WB-000 协议文件错误。专项 build/test typecheck 在 Biome 后复跑仍通过。

## 下游入口

- WB-001：使用 `ADMIN_WORKBENCH_ROUTES` 固定 Admin/Embed 入口和旧路由重定向。
- WB-002：使用 `ADMIN_WORKBENCH_TERMS` 和未知状态 resolver。
- WB-003：使用 Agent/Revision DTO，并迁移旧 AgentDefinition UI 命名。
- WB-006：使用 ConversationAdminSummary 和 SessionEventEnvelope。
- WB-007：以 SessionEventEnvelope 为公共投影，服务端持久记录仍使用内部 branded ID。

## 未关闭项

- 既有 Control HTTP DTO 的字符串 ID 尚未全部收窄为 template literal 类型，避免 WB-000 越界修改现有 Web。
- 旧 `main.tsx` 仍按 `/publishing` 分支；实际重定向在 WB-001/WB-002 实施。
- `SessionEventEnvelope` 是冻结的公共投影；事件目录、计数和数据库变更属于 WB-007。
