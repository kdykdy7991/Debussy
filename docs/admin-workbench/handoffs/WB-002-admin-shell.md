# WB-002 交接：管理员 App Shell

状态：Complete

> **MVP-08 状态校正（2026-08）**：本 handoff 撰写时（仅 Shell 框架交付）记录
> `chat-page.tsx` / `/apps` / `/apps/:appId` 为占位页。后续 MVP 已把这些占位
> 替换为真实实现：`chat-page` → MVP-04 管理员调试对话，`/apps` 与 `/apps/:appId`
> → MVP-03 / MVP-06 应用列表与详情工作区，模块侧栏占位文案 → MVP-07 折叠/真实内容，
> 右侧抽屉 → MVP-07 默认折叠。下方「未关闭项」「对下一任务约束」中的占位表述仅在
> 当时语境下成立，现已被对应 MVP 取代。Shell 框架本身（五标签 / 侧栏 / 抽屉 /
> Token 解锁）不变。

## 完成范围

建立对话优先的管理员框架：五个一级标签、模块侧栏、主工作区、右侧抽屉、Admin Token 统一解锁/锁定、`/publishing/*` 重定向。**未实施** Agent 表单、发布业务、用户会话管理（WB-003/004/006 范围）。

## 修改文件

新增：

- `runtimes/pi/packages/web/src/admin/app-shell.tsx`
- `runtimes/pi/packages/web/src/admin/router.ts`
- `runtimes/pi/packages/web/src/admin/nav/sidebar.tsx`
- `runtimes/pi/packages/web/src/admin/nav/secondary-panel.tsx`
- `runtimes/pi/packages/web/src/admin/right-drawer/right-drawer.tsx`
- `runtimes/pi/packages/web/src/admin/auth/admin-auth-context.tsx`
- `runtimes/pi/packages/web/src/admin/auth/unlock-dialog.tsx`
- `runtimes/pi/packages/web/src/admin/pages/chat-page.tsx`
- `runtimes/pi/packages/web/src/admin/pages/agents-page.tsx`
- `runtimes/pi/packages/web/src/admin/pages/apps-page.tsx`
- `runtimes/pi/packages/web/src/admin/pages/user-conversations-page.tsx`
- `runtimes/pi/packages/web/src/admin/pages/settings-page.tsx`
- `runtimes/pi/packages/web/src/admin/styles.css`
- `runtimes/pi/packages/web/test/admin/app-shell.test.tsx`

改写：

- `runtimes/pi/packages/web/src/admin/main.tsx`（接入 Shell 框架 + `/publishing` 重定向）

顺手修复（WB-000 未完成项）：

- `runtimes/pi/packages/protocol/src/index.ts`：添加 `export * from "./admin-workbench.ts";`
  让 `ADMIN_WORKBENCH_TERMS`、`ADMIN_WORKBENCH_ROUTES`、`legacyPublishingRedirect`
  等冻结契约能从 `@earendil-works/pi-protocol` 根入口直接 import

未触碰：

- `src/publishing/` 全部子模块：WB-004 才迁移到 `admin/apps/`（任务单禁止"把旧
  PublishingApp 整体嵌入 Shell"）。当前 `/apps` 与 `/apps/:appId` 是占位页，
  `legacyPublishingRedirect` 把旧深链接从 pathname 层重定向到 hash 路由后由
  Shell 接管。
- 既有 `app.tsx`：内部 Pi Web App 的 `App` 组件未在本任务接入。WB-003 把
  「调试对话」按 SPEC §5.1 接到 `admin/pages/chat-page.tsx`。

## 关键接口

### 路由（hash-based）

`router.ts` 提供：

- `parseRoute(path)` → `AdminRoute`：按 `ADMIN_WORKBENCH_ROUTES` 解析，公共
  ID 不匹配一律回落 `chat`。
- `navigate(to)`：写 `window.location.hash`，触发 `hashchange` 让 `useAdminRoute`
  更新。**不接触 pathname**，所以 `/publishing` 重定向走 `legacyPublishingRedirect`
  在 `main.tsx` 顶层做。
- `useAdminRoute()`：订阅 `hashchange`，返回当前 `AdminRoute`。

理由：选择 hash 路由是因为 admin 部署到独立域名，无须服务端 history
fallback；hash 永远由前端处理，刷新与前进/后退由 `hashchange` 自然恢复。

### Auth 状态

`auth/admin-auth-context.tsx` 把 `AdminAuthController`（来自
`publishing/auth-controller.ts`）暴露为 React Context：

- 读：`snapshot`（`state`、`baseUrl`、`tenant.name`、`error`）
- 写：`unlock(token)`、`lock()`、`markApiError(status, message)`
- 关键约束：**React 层不持有 token**；token 仅在 controller 内存。
  `unlock` 内部清空本地 `token` 临时变量后再 await；任何错误路径也不写
  console / Storage / URL / 异常文本。

### 401 处理

`AdminAuthController.failConnection()` 把 token 置 null，state 变 `error`，
tenant 变 null；React 层在 `snapshot.state` 不为 `connected` 时显示
`AdminUnlockDialog`，自然回到锁屏。

### 抽屉 API

`right-drawer/right-drawer.tsx` 暴露 `<AdminRightDrawer route={route} />`；
后续模块（WB-003 Agent 配置、WB-004 发布管理、WB-006 事件详情）按 route
id 注入不同内容。Shell 不变。

## 验收执行结果

```text
npx tsgo --noEmit -p packages/web/tsconfig.json                    → 通过
npx vitest --run packages/web/test/admin/app-shell.test.tsx       → 10/10 passed
npx vitest --run packages/web/test/build-boundary.test.ts         → 6/6 passed (WB-001 不回归)
npm run check                                                       → 通过（仅 ai/coding-agent 既有失败；见 WB-000 handoff）

dev admin (port 5173)：
  /                 → 200
  /agents           → 200
  /apps             → 200
  /conversations    → 200
  /settings         → 200
  /publishing       → 200（JS 端 location.replace 到 /apps）
```

任务单验收项逐条核对：

| 项 | 证据 |
|---|---|
| 五个标签键盘可达并有当前态 | `app-shell.test.tsx` "renders five primary nav items" + "marks the current route with aria-current"；CSS `:focus-visible` 描边 |
| 401 清空全部管理数据并回到锁定态 | `app-shell.test.tsx` "AdminAuthController locks the session on 401 and clears tenant data"；`unlock-dialog.tsx` 在非 connected 状态渲染 |
| 桌面、窄屏无横向溢出 | `styles.css` `html,body,#root { overflow-x: hidden }`；`@media (max-width: 960px)` 隐藏右侧抽屉；`@media (max-width: 720px)` 隐藏模块侧栏；测试 "prevents horizontal overflow / grid layout / media queries" |
| 路由刷新和浏览器前进/后退正确 | hash 路由 + `hashchange` 事件 + `parseRoute` 覆盖所有 admin 路径与未知回落；测试 "parses known admin paths and falls back to chat on unknown" |
| Admin Shell 组件测试通过 | 10/10 passed |
| Web typecheck 通过 | `npx tsgo --noEmit -p packages/web/tsconfig.json` 0 errors |
| `npm run check` 通过 | 顶层 check exit 0；剩余错误为 ai model catalog 既有失败 |

## 关键禁止项的当前状态

| 禁止 | 状态 |
|---|---|
| 不把旧 `PublishingApp` 整体嵌入 Shell | `src/admin/app-shell.tsx` 不 import `./publishing/publishing-app.tsx`；旧 `/publishing/*` 走 `legacyPublishingRedirect` 重定向到 `/apps` 与 `/apps/:appId`；`/apps` 与 `/apps/:appId` 是占位页，WB-004 才迁移 PublishingApp 子模块 |
| Token 不进 Storage、URL、console 或异常 | `AdminAuthController` 没有 Storage 字段；React Context 投影只含 `state/baseUrl/tenant/error`；`unlock-dialog` 错误展示使用 controller 透出的 `error` 字段，不重新抛 token；测试覆盖 failConnection 清空路径 |
| 不在本任务实现 Agent 表单或发布业务 | 5 个模块页全部占位（"由 WB-003/WB-004/WB-006 实施"） |

## 未关闭项

- `chat-page.tsx` 当前是占位；WB-003 实施时把 `App` 组件（内部 Pi Web App）
  作为对话模块主体接入，需要把 `connection` + `sessions` 提到 `admin/main.tsx`
  顶层或 `AdminAppShell` 内部。
- 5 个占位页只渲染标题与说明；SPEC §4.1 规定的「全局状态」中除 auth 外，
  当前 Agent、最近 DebugSession、当前 PublishedApp、抽屉类型、主题、requestId
  仍是裸占位。WB-003 引入 Agent 状态，WB-004 引入 PublishedApp 状态，主题
  与全局 requestId 由后续任务按需补。
- `protocol/src/index.ts` 的 export 修改顺手做了；之前 WB-000 handoff 提
  到「既有 Control HTTP DTO 的字符串 ID 尚未全部收窄为 template literal
  类型」，本任务未触碰该遗留项。
- 本次改动未提交。AGENTS.md 规则与 README 「保留工作区已有修改，不提交
  代码，除非我另行明确要求」。

## 对下一任务（WB-003）的约束

1. `AdminChatPage` 当前位置在 `src/admin/pages/chat-page.tsx`，WB-003
   需要把它升级为「管理员调试对话」主体，复用 `src/lib/` 的
   `connection-controller` 与 `session-controller`；`admin/main.tsx` 顶层
   应改为在 Shell 渲染前建立 controller，并把它通过 Context 注入 Shell。
2. 5 个一级标签中只有 `Agent` 是 WB-003 主战场；`app-list` / `app-detail`
   占位保留，WB-004 再迁移 PublishingApp 子模块。
3. `AdminIconRail` 的 `aria-current` 已经能基于 `parseRoute` 区分
   `agents` 与 `agent-detail`；WB-003 引入 `AgentSummary` 列表后无需改
   Shell，只往次级侧栏注入数据。
4. 路由恢复：刷新后 `parseRoute(window.location.hash)` 直接给到当前
   `agentId`，WB-003 实现 `agent-detail` 视图时直接 `route.params.agentId`
   即可。

## dev/部署说明

dev 阶段维持 WB-001 的 dev plugin 行为：所有非 asset、非 `/embed/*` 的
GET 请求 fallback 到 `index.html`，让 SPA 路由刷新直接命中。

生产部署保持 WB-001 推荐的 nginx rewrite：admin 入口把 `try_files $uri
$uri/ /index.html;` 兜底到 admin index，禁止 `/embed.html`。
