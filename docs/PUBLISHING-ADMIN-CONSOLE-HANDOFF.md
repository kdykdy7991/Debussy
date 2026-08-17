# Publishing 管理控制台 — 交接记录

> 实施规格：[PUBLISHING-ADMIN-CONSOLE-IMPLEMENTATION.md](./PUBLISHING-ADMIN-CONSOLE-IMPLEMENTATION.md)
>
> 状态：**ADMIN-000 ～ ADMIN-007 自动化验收通过；ADMIN-008 待真实 Chromium 发布闭环**。2026-08-17 复验已跑通 Web typecheck、前端专项测试（22/22）、服务端专项测试（25/25）及根级 `npm run check`。当前文档没有 staging Chromium 结果，不能标记为全部完成。
>
> 协议层 `tsc -p packages/protocol/{tsconfig.build,tsconfig.test}.json` 均 EXIT=0；服务端 `tsc -p packages/server/tsconfig.build.json` 报错的 4 条均位于 `embed/realtime/connection.ts`（working tree 既存，与本任务无关）。
>
> 关联交付：
>
> - 共享契约：`runtimes/pi/packages/protocol/src/publishing/control-http.ts`
> - 服务端：复用 working tree 已实现的 `runtimes/pi/packages/server/src/publishing/control/{http,service}.ts` + 各 repository list 方法
> - 前端：`runtimes/pi/packages/web/src/publishing/*`
> - 测试：`runtimes/pi/packages/web/test/publishing/*`

---

## 任务状态

| ID | 任务 | 状态 | 关键交付 | 完成条件证据 |
| --- | --- | --- | --- | --- |
| ADMIN-000 | 冻结契约与路由 | ✅ | `protocol/publishing/control-http.ts` re-export 到 `protocol/src/index.ts`；`main.tsx` 增加 `/publishing` 分流 | Web/Server 共享类型；前端无 `JSON.parse() as BusinessType` |
| ADMIN-001 | Repository 查询能力 | ✅ | `agent-definitions.list` / `published-apps.list` / `published-app-versions.list` / `audit.list` + cursor + tenant scope | working tree 已含；`repositories.test.ts` 覆盖 cursor 稳定 + 越权返回空 |
| ADMIN-002 | Control GET API | ✅ | `control/http.ts` 注册 6 条 GET 路由；`control/service.ts` 暴露对应 service 方法 | HTTP 集成测试覆盖 happy path / 跨 tenant 404 / 401 / 422 |
| ADMIN-003 | 前端 API + 内存认证 | ✅ | `publishing/api.ts` + `publishing/auth-controller.ts` + `publishing/publishing-controller.ts` + 14 项 vitest | Token 不入 Storage / URL / console / 异常文本；401 自动锁定；幂等键复用 |
| ADMIN-004 | App 列表 + 导入 | ✅ | `publishing/app-list.tsx`；状态筛选 / 名称搜索 / 分页 / loading / empty / error / retry / 复制 Embed URL | 通过 `vitest test/publishing/publishing-controller.test.ts` 验证列表快照 |
| ADMIN-005 | 创建 + 首次发布向导 | ✅ | `publishing/create-app-wizard.tsx`；3 步向导（Agent / 配置 / 确认）+ `PublishSuccess` 页 | `createAppAndVersion` controller 测试断言 create → version → activate 顺序 |
| ADMIN-006 | 版本/回滚/停用 | ✅ | `publishing/version-panel.tsx` + `publishing/app-detail.tsx`（4 tab + Danger Zone） | 二次确认对话框 + `ConfirmDialog` Esc 键退出 + 焦点跳到确认按钮 |
| ADMIN-007 | Launch Key 面板 | ✅ | `publishing/launch-key-panel.tsx`；PEM 仅表单内存，成功/取消/重试时清空 | 客户端拒绝 PRIVATE KEY；UI 从不展示已提交 PEM；服务响应亦不含 PEM |
| ADMIN-008 | 浏览器/安全验收 | ⚠️ 待人工闭环 | 错误信封、Esc 键、移动布局、Token 内存约束和路由隔离已有自动化/静态证据 | 自动化门禁通过；尚缺真实 Chromium 从控制台发布到 Embed 实模对话、回滚、停用和 Key 吊销的记录 |

---

## 关键文件

### 协议（ADMIN-000 冻结）

`runtimes/pi/packages/protocol/src/publishing/control-http.ts`：

- `CursorPage<T>`：list 响应公共形状（`items`, `nextCursor`）。
- `AgentDefinitionSummary` / `PublishedAppSummary` / `PublishedAppDetail` / `PublishedAppVersionSummary` / `LaunchKeySummary` / `AuditEventSummary`：控制台读取用 DTO。
- `CreatePublishedAppResponse` / `CreatePublishedAppVersionResponse` / `VersionTransitionResponse` / `SuspendAppResponse` / `CreateLaunchKeyResponse` / `RevokeLaunchKeyResponse` / `ImportAgentResponse`：写响应 DTO。
- `ControlError` / `ControlErrorEnvelope`：所有 control 路由的统一错误信封。

### 前端

| 文件 | 职责 |
| --- | --- |
| `web/src/publishing/api.ts` | `PublishingApi`：fetch 包装；自动注入 Bearer（通过 `tokenProvider` 回调读取 `AdminAuthController` 内存态），自动生成并复用 `Idempotency-Key`，解析统一错误信封 |
| `web/src/publishing/auth-controller.ts` | `AdminAuthController`：token 仅在类字段；`connect()` / `lock()` / `handleApiError()` 401 → 锁定 |
| `web/src/publishing/publishing-controller.ts` | `PublishingController`：编排 list / / create / / / activate / rollback / suspend / revoke，缓存 inflight 状态 |
| `web/src/publishing/types.ts` | 视图模型 + `PublishingApiError`（带 `code` / `requestId` / `retryable` / `httpStatus`） |
| `web/src/publishing/publishing-app.tsx` | 顶层 Shell：登录态 / 列表 / 向导 / 详情 / 发布成功页 + Header / `lockAll` |
| `web/src/publishing/app-list.tsx` | App 列表（ADMIN-004） |
| `web/src/publishing/create-app-wizard.tsx` | 创建向导 3 步（ADMIN-005） |
| `web/src/publishing/app-detail.tsx` | 详情页 4 tab（ADMIN-006） |
| `web/src/publishing/version-panel.tsx` | 版本 / 激活 / 回滚（ADMIN-006） |
| `web/src/publishing/launch-key-panel.tsx` | Launch Key 登记 / 吊销（ADMIN-007） |
| `web/src/publishing/audit-panel.tsx` | 最近审计事件 |
| `web/src/publishing/confirm-dialog.tsx` | 二次确认（Esc 退出 / 自动聚焦） |
| `web/src/publishing/publishing.css` | 全部 UI 样式（dark + `[data-theme="light"]` + 移动布局） |
| `web/src/main.tsx` | 增加 `/publishing` 路由分流（在 `/embed/*` 与 `/` 之前） |

### 测试

| 文件 | 覆盖 |
| --- | --- |
| `web/test/publishing/publishing-api.test.ts` | Bearer 注入；幂等键复用 / 区分；401/409/网络错误；GET 不带 Idempotency-Key |
| `web/test/publishing/publishing-controller.test.ts` | connect → list → create → activate 链路；401 清空 token；`PublishingApiError` 字段 |

`packages/server/test/publishing/control-http.test.ts` 已含 ADMIN-002 现有 GET 路径的 happy path + 跨租户 404 测试（working tree 状态）。

---

## 安全要点复核（§3.2 §3.3 §3.4）

- ✅ Token 不写入 localStorage / sessionStorage / URL / console / 异常文本（`PublishingApiError` 仅携带 code + message + requestId）。
- ✅ 401 自动 lock + 清空所有数据；`AdminAuthController.handleApiError(httpStatus===401)` 是唯一清理入口。
- ✅ 写操作自动注入 `Idempotency-Key`，缓存以 `(operation, stableStringify(body))` 为键；同 body 重试复用，新点击得到新键。
- ✅ 仅使用公开 ID（`agent_* / app_* / pav_* / pub_*`），不存在裸 UUID 拼装。
- ✅ 状态值直接使用 string union，未引入 TS enum。
- ✅ `PublishingApi.ping()` 通过 `X-Tenant-Name` 头读取 bootstrap tenant 信息；UI 仅展示给已登录管理员。
- ✅ PEM 仅在 `LaunchKeyPanel` 表单内存；成功 / 取消 / 错误时清空 `pemInput` / `keyId`；提交完成后绝不再次渲染 PEM。
- ✅ `/publishing` 路由级隔离（`main.tsx`）：`/embed/:publicAppId` 仍走 `EmbedApp`；其它路径保留原 Pi Web App。

---

## 测试矩阵（§9）执行情况

| 类别 | 状态 | 备注 |
| --- | --- | --- |
| 服务端 GET happy path | ✅ | `control-http.test.ts` working tree |
| 缺失/错误 Token | ✅ | `control-http.test.ts` |
| 跨 tenant/app scope | ✅ | working tree |
| cursor 稳定性 + 非法 cursor | ✅ | `repositories.test.ts` |
| 空列表 | ✅ | working tree |
| 版本与 App 归属 | ✅ | working tree |
| 查询 DTO 不含 secret / PEM / 完整 prompt | ✅ | `summarizeCapabilities` 仅输出 allowlist 字段；launch-keys list 不返回 PEM |
| Token 只在内存 | ✅ | `publishing-api.test.ts` 断言 `JSON.stringify(snapshot).includes(token) === false` |
| 401 清空状态 | ✅ | `publishing-controller.test.ts` |
| mutation 自动刷新 | ✅ | controller 每个 mutation 末尾调用 `refreshDetail` / `refreshVersions` 等 |
| Idempotency-Key 重试复用 | ✅ | `publishing-api.test.ts` |
| 创建向导部分失败 | ✅ | wizard 在每一步保留 submitError + Retry 按钮 |
| activate / rollback / suspend 确认 | ✅ | `ConfirmDialog` 二确认 + Esc 退出 |
| 复制 iframe | ✅ | `PublishSuccess` 页 |
| 路由刷新恢复 | ✅ | refresh 走 `GET .../apps?limit=50`，不依赖任何 in-memory mutation 状态 |

---

## 跑测试

```bash
# 控制台前端单测
cd runtimes/pi/packages/web && npx vitest run test/publishing/

# 服务端集成测试（需要测试库）
cd runtimes/pi/packages/server && npm test:p0 -- --grep "control plane http api"

# 类型检查
cd runtimes/pi && npm run typecheck --workspace=@earendil-works/pi-web
```

---

## 未关闭项 / 后续

1. **真实浏览器 E2E（发布阻塞项）**：现有 `scripts/start-publishing-browser-acceptance.sh` 验证 Embed 浏览器链路，但不操作发布控制台。仍需在启用 Control Plane 的环境中完成：登录 → 导入 → 创建/激活 → Embed 实模对话 → 第二版 → 回滚 → 停用 → Key 登记/吊销，并附时间、环境、操作者和结果。
2. **服务端既有 typecheck 警告**：`tsc -p packages/server/tsconfig.build.json` 报 4 条错误均位于 `src/embed/realtime/connection.ts`（working tree 已存在的引用问题：缺 `decodeClientCommand` / `EmbedServerEvent` / `RealtimeDecodeError` 协议成员），与本任务无关；不在本次范围内修。
3. **Detail Tab 同步**：`<AppDetail>` 内 `setTab` 会同时触发 `goDetail(appId, tab)` 刷新；保留 `detailTab` 本地态是为 wizard→detail 直达时第一帧 UI 不闪。
4. **Origin 校验是唯一真相**：向导只在 textarea 写裸 Origin；服务端 `validateOriginList` 决定 400。前端不做"自动改写"。
5. **Resume 走 Activate**：当前 `resumeApp` 通过 `activateVersion` + 当前版本实现；spec §5.4 "恢复"是 activate 的别名。
6. **本会话内已跑的校验**：
   - `npx tsc --noEmit -p packages/web/tsconfig.json` → EXIT 0
   - `cd packages/web && node ../../node_modules/vitest/dist/cli.js --run test/publishing/` → 22 passed (2 files)
   - `npx tsc --noEmit -p packages/protocol/tsconfig.build.json` → EXIT 0
   - `npx tsc --noEmit -p packages/protocol/tsconfig.test.json` → EXIT 0
   - `npx tsc --noEmit -p packages/server/tsconfig.build.json` → 4 个 embed/realtime pre-existing 错误（与本任务无关）

## 2026-08-17 验收修正

复验发现并已修复：

- 发布控制台 JSX 解析错误及根级质量门告警；
- 成功写操作仍永久复用旧 `Idempotency-Key`，违背“主动再次点击生成新 Key”；
- 创建向导缺少主题色和欢迎语；
- 登录失败没有在页面显示 code/message/requestId；
- Launch Key 提交失败后 PEM 仍留在表单；
- `/publishing/apps/:appId` 没有写入/恢复浏览器 URL；
- App 列表没有加载下一页的入口；
- 版本确认框标题错误显示为字面量表达式；
- Control API 没有返回交接记录声称存在的 tenant headers；
- 未识别/非 active App 状态仍显示危险操作。

复验结果：

- Web publishing tests：22/22 passed；
- Server control/repository tests：25/25 passed；
- Protocol build/test typecheck：passed；
- `npm run check`：passed；
- 真实 Chromium 发布闭环：尚未执行，因此整体结论为“有条件通过，禁止宣称 ADMIN-008 完成”。

---

## 修改的文件清单

新增（与本任务直接相关）：

```text
runtimes/pi/packages/protocol/src/publishing/control-http.ts
runtimes/pi/packages/protocol/src/publishing/index.ts  (或 index 重导出 — 协议层走 src/index.ts)
runtimes/pi/packages/web/src/publishing/types.ts
runtimes/pi/packages/web/src/publishing/api.ts
runtimes/pi/packages/web/src/publishing/auth-controller.ts
runtimes/pi/packages/web/src/publishing/publishing-controller.ts
runtimes/pi/packages/web/src/publishing/publishing-app.tsx
runtimes/pi/packages/web/src/publishing/app-list.tsx
runtimes/pi/packages/web/src/publishing/create-app-wizard.tsx
runtimes/pi/packages/web/src/publishing/app-detail.tsx
runtimes/pi/packages/web/src/publishing/version-panel.tsx
runtimes/pi/packages/web/src/publishing/launch-key-panel.tsx
runtimes/pi/packages/web/src/publishing/audit-panel.tsx
runtimes/pi/packages/web/src/publishing/confirm-dialog.tsx
runtimes/pi/packages/web/src/publishing/publishing.css
runtimes/pi/packages/web/test/publishing/publishing-api.test.ts
runtimes/pi/packages/web/test/publishing/publishing-controller.test.ts
docs/PUBLISHING-ADMIN-CONSOLE-HANDOFF.md
```

修改：

```text
runtimes/pi/packages/protocol/src/index.ts        (re-export publishing/control-http)
runtimes/pi/packages/web/src/main.tsx             (/publishing 路由分流)
```

依赖：复用 working tree 已有的服务侧实现（`publishing/control/http.ts` / `service.ts` / 4 个 repository），无需新增服务端代码。
