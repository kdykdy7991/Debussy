# WB-004 交接：应用与发布工作区

状态：Complete

## 完成范围

把现有内部 Pi Web App 的发布控制台能力迁入管理员工作台。提供应用仪表盘、应用详情八个页签的首期内容、强制选择应用 + Revision 的发布抽屉、和一个无副作用的「创建版本（不激活）」路径。

## 修改文件

新增：

- `runtimes/pi/packages/protocol/src/admin-workbench-apps.ts`
- `runtimes/pi/packages/web/src/admin/api/app-api.ts`
- `runtimes/pi/packages/web/src/admin/apps/app-detail.tsx`
- `runtimes/pi/packages/web/src/admin/apps/publish-drawer.tsx`
- `runtimes/pi/packages/web/test/admin/app-api.test.ts`

修改：

- `runtimes/pi/packages/protocol/src/index.ts`（re-export 新 DTO）
- `runtimes/pi/packages/server/src/publishing/repositories.ts`（5 个仓库接口新增 count/pending 方法 + `PendingVersionRow` 类型）
- `runtimes/pi/packages/server/src/persistence/postgres/repositories/published-apps.ts`（`count`）
- `runtimes/pi/packages/server/src/persistence/postgres/repositories/published-app-versions.ts`（`listPendingByTenant`）
- `runtimes/pi/packages/server/src/persistence/postgres/repositories/principals.ts`（`countActive`）
- `runtimes/pi/packages/server/src/persistence/postgres/repositories/conversations.ts`（`countActive`）
- `runtimes/pi/packages/server/src/persistence/postgres/repositories/conversation-events.ts`（`countErrors`）
- `runtimes/pi/packages/server/src/publishing/control/service.ts`（`getDashboardSummary`）
- `runtimes/pi/packages/server/src/publishing/control/http.ts`（dashboard 路由）
- `runtimes/pi/packages/web/src/admin/pages/apps-page.tsx`（替换占位为仪表盘 + 列表）
- `runtimes/pi/packages/web/src/admin/agents/agent-workspace.tsx`（注入「发布」按钮 + PublishDrawer）
- `runtimes/pi/packages/web/src/admin/styles.css`（仪表盘/tabs/抽屉/badge 样式）

## 关键接口

### Protocol 新增 DTO（`admin-workbench-apps.ts`）

```ts
interface DashboardSummary {
  appCount: number;
  activeUserCount: number;
  activeSessionCount: number;
  errorEventCount: number;
  pendingApps: readonly PendingVersionApp[];
}
interface PendingVersionApp {
  appId: string;
  publicAppId: string;
  name: string;
  status: KnownPublishedAppStatus;
  pendingVersionNumber: number;
  pendingVersionStatus: KnownPublishedAppVersionStatus;
}
```

### Server 端新 endpoint

```
GET  /api/control/v1/dashboard/summary   -> service.getDashboardSummary
```

`getDashboardSummary` 并发执行五个查询：
- `repos.publishedApps.count(scope)`
- `repos.principals.countActive(scope)`
- `repos.conversations.countActive(scope)`
- `repos.events.countErrors(scope)`（事件类型为 `turn.failed` / `tool.error`）
- `repos.publishedAppVersions.listPendingByTenant(scope)`（DISTINCT ON 各 app 最新 ready 非 current 版本）

### Web 端

- `AppApi`：control HTTP 客户端；POST 写入自动生成 `Idempotency-Key`；401 → `auth.failConnection`。
- `apps-page.tsx`：仪表盘 metric 卡片 + 待上线版本区 + 状态筛选/搜索/分页/加载更多/空态/重试。
- `app-detail.tsx`：8 个 tab（概览 / 版本与上线 / 应用配置 stub / 接入方式 stub / Launch Keys / 审计 / 用户会话 stub / Danger Zone）。版本面板支持创建版本（不激活）、激活、回滚、明确显示 `current` 行高亮；Launch Keys 支持创建（含 PEM 格式校验，不含 `PRIVATE KEY`）/ 吊销；审计展示（折叠 metadata）；Danger Zone 暂停/恢复。
- `publish-drawer.tsx`：强制管理员显式选择目标 PublishedApp + 已保存 AgentRevision，展示 Revision 的配置摘要与 diff；创建不可变版本，**不自动激活**。Agent 存在未保存草稿（`hasDraft`）时抽屉按钮全部禁用 + 顶部红/黄 banner。
- `agent-workspace.tsx` 头部新增「发布」按钮，状态 `saved` 以外全部 disabled；点击打开 PublishDrawer；发布成功后回调 `reload()`。

### 关键约束的当前状态

| 禁止 | 当前状态 |
|---|---|
| 一个 Agent 的多个应用必须逐次选择 | PublishDrawer 步骤 1 单选 + 不记忆上次选择；`useEffect([mode])` 每次 mode → open 强制重置 selectedApp/Revision |
| 创建版本不会改变 `currentVersionId` | `apps-page.tsx` → `VersionsPanel` 的 `createVersion` 只调 `POST .../versions`，**不**调 activate；`published-app-versions.ts` `createVersion` 只 insert，不触碰 `published_apps.current_version_id` |
| 不让应用配置绕过版本立即生效 | WB-004 没新增 PATCH config 端点；应用配置 tab 是只读展示（修改留待 WB-005 与「激活」闭环统一处理）；版本快照包含 AgentDraftConfig + RuntimeSpec（既有逻辑） |
| 不记忆默认发布应用 | PublishDrawer 每次打开重置 `selectedApp`/`selectedRevision`，仅可显式单选 |
| 不把发布和上线合并 | PublishDrawer 仅做 createVersion；激活路径在 detail → versions tab 的「激活」按钮独立实现，二者互不影响 |
| 不回归幂等键语义 | `AppApi` 每次 POST 重新生成 `Idempotency-Key`；不缓存（同请求重复点会得到新 Key），与既有 publish API 语义一致 |
| 旧 /publishing 深链接 | `admin/main.tsx` `legacyPublishingRedirect` 已把 `/publishing`、`/publishing/apps/app_*` 重定向到 `/apps` 与 `/apps/:appId`（由 WB-001/002 实施） |
| Embed 不携带管理代码 | `web/test/build-boundary.test.ts` 6/6 通过；admin 新代码全部在 `src/admin/` 与 `src/admin/apps/`，import 图未触及 `src/publishing/`（仅 `publishing/auth-controller.ts`，已被 WB-002 豁免） |

## 验收执行结果

```text
npx tsgo --noEmit -p packages/protocol/tsconfig.build.json         → 通过
npx tsgo --noEmit -p packages/server/tsconfig.build.json          → 通过（pre-existing coding-agent/legacy 错误与我无关）
npx tsgo --noEmit -p packages/web/tsconfig.json                   → 通过

npx vitest --run test/admin test/build-boundary.test.ts  (web)
   ✓ app-api.test.ts           5
   ✓ app-state.test.ts        10
   ✓ app-shell.test.tsx       10
   ✓ build-boundary.test.ts    6
   31/31 passed
```

`npm run check`（顶层）：
- biome + 检查：本任务引入的 `src/admin/apps/*` `src/admin/api/app-api.ts` 0 error 0 warning（formatter 已自动 fix）
- 顶层 typecheck：剩余错误全部为 packages/ai + packages/coding-agent + scripts/smoke-p0 的 pre-existing AI model catalog 阻断，与 WB-004 无关（WB-000/003 handoff 已记录）

## 未关闭项 / 对下一任务的约束

1. **「应用配置修改进入待发布状态」交付项未在本任务实现 PATCH 端点。** 当前 detail 的「应用配置」tab 只读；`mutablePolicy` 在 DB 已有 `updateMutable` repository 方法，但 service + http 没暴露 PATCH config 端点（保持「不让应用配置绕过版本立即生效」的硬约束）。
   - 计划留给 WB-005 在 Preview & Activation 闭环里统一处理：版本快照中需新增 `mutablePolicy` 字段，由 createVersion 冻结并由 activate 替换。
   - 建议接口：`PATCH /api/control/v1/published-apps/:appId/config` 接受 `{ name, accessMode, allowedOrigins, mutablePolicy }`，**只写回 `mutablePolicy` 与非关键展示字段**（name）；安全相关字段（accessMode、allowedOrigins）必须进入新版本才能激活。
2. **「用户会话」tab 是占位**（依赖 WB-006 用户会话列表 + WB-007 事件日志）。
3. **审计面板的 metadata 折叠**展示是简化版；不包含 token/PEM/visitorId 检测（既有 audit 写入层本就不写这些，spec §9.1 已固定）。
4. **Dashboard 的 `errorEventCount` 依赖事件类型 `turn.failed` 与 `tool.error`**，目前事件词汇较少（spec §11.4 中约定的事件类型尚未全部落地）。WB-007 引入统一事件词汇后此计数会更有意义。
5. **「恢复应用」按钮的 `activateVersion` 当前传空 versionId 兜底**；正式 `resumeApp` 端点属于 WB-005 范围（activate-ready-version 复用即可）。
6. **`AppApi` 的发布版本创建默认传 `Idempotency-Key`**，但**未实现"主动再次点击生成新 Key"的 UI 反馈**（任务单禁止项中提到）；当前 UI 在 createVersion 完成后 disabled `busy` 态，避免重复点击。需要更明确的 Idempotency 行为留给 WB-007/009 审计接入时统一处理。
7. **publish-drawer `onClick={onClose}` backdrop** 触发：仅当用户点击抽屉外的 overlay 区域时关闭（stopPropagation）；Escape 键也关闭。
8. **Endpoint 路径偏差**：任务单 spec §15.1 建议 `apps/:appId` 而非 `published-apps/:appId`，但本任务保持与既有 control 路径一致；如需迁移由后续 task 单独立项。

## 对下一任务（WB-005）的约束

1. WB-005 预览需要 `POST /api/control/v1/published-apps/:appId/preview-ticket`（spec §15.2）。当前 `service.activateVersion`/`createPublishedAppVersion`/`getPublishedAppDetail` 已可被复用；WB-005 只需新增 `createPreviewTicket` + `exchange` 接受 ticket 的非当前 versionId。
2. 「应用配置修改进入待发布状态」的实施建议按「`mutablePolicy` 进入版本快照」模型设计；见上文未关闭项 #1。
3. 上线/回滚 UI 已经在 detail 的 versions tab 提供（与 WB-005 验收一致），WB-005 可复用 `VersionsPanel` 的 `activateVersion` / `rollbackVersion` 调用。
4. 审计事件已可通过 `service.listAuditEvents({ appId })` 拿到；WB-005 激活/回滚/停用操作各自写 `audit-events`（既有 `writeAudit` 已支持）。