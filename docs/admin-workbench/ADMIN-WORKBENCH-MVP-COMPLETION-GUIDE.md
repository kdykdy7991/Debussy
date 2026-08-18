# Admin Workbench 初版可用补全开发手册

状态：待实施

适用范围：在 WB-000～WB-010 已有代码基础上，将 Admin Workbench 从“页面和后端能力部分存在”补全到可完成真实主链路的初版。

## 1. 背景与结论

WB-000～WB-010 的任务文档目前标记为全部完成，但真实本地环境验收表明，Admin Workbench 仍存在开发代理、鉴权、SQL、首次使用闭环和占位页面等阻断项。

当前状态不是重新开发：Control/Embed 平面、数据库迁移、Agent/App/Conversation 的大部分服务端能力已经存在；主要工作是修复已确认缺陷并完成 Web 集成。

本手册是补全工作的执行入口。开发完成前，不应再以各 WB handoff 的 `Complete` 状态代替真实浏览器验收。

## 2. 初版可用定义

管理员必须能够在空的本地 Tenant 中完成以下主链路：

```text
使用真实 Admin Token 解锁
  → 导入当前 Agent
  → 编辑并保存 Agent Revision
  → 创建 PublishedApp
  → 从 Revision 创建 App Version
  → Preview 并激活 Version
  → 在管理员调试对话中选择 Agent、发送消息并恢复 DebugSession
  → 在用户会话控制台查看 Conversation、事件、Summary 和附件
  → 导出诊断包、Transcript 或经二次确认的完整包
  → 在设置页核对真实 Tenant/Base URL 并锁定退出
```

初版完成时，五个一级模块不得再出现“即将提供”“由 WB-xxx 实施”等占位文案。

## 3. 已确认问题

### 3.1 P0 阻断项

| ID | 问题 | 已确认表现 | 主要位置 |
|---|---|---|---|
| MVP-01 | Vite Admin API 代理被 SPA rewrite 抢先处理 | 浏览器请求 `/api/control/*` 返回 `index.html`，Web 客户端把 HTML 当 JSON 解析 | `packages/web/vite.config.ts` |
| MVP-02 | 解锁流程未验证 Token | 任意非空 Token 都会进入 connected，并显示硬编码“默认租户” | `packages/web/src/admin/auth/admin-auth-context.tsx` |
| MVP-03 | Agent 列表 SQL 参数编号错误 | 空库调用 `GET /agent-definitions?limit=50` 返回 500 | `packages/server/src/persistence/postgres/repositories/agent-definitions.ts` |
| MVP-04 | Conversation 管理列表关联了不存在的列 | 空库调用 `GET /conversations?limit=50` 返回 500；SQL 使用 `v.agent_definition_id`，实际 Agent 归属在 App | `packages/server/src/persistence/postgres/repositories/conversations.ts` |
| MVP-05 | 空 Tenant 没有 Agent 首次导入入口 | Agent 空状态只提示“请导入或创建”，没有操作按钮 | `packages/web/src/admin/pages/agents-page.tsx`、`api/agent-api.ts` |
| MVP-06 | 没有创建 PublishedApp 的 Web 入口 | Publish Drawer 要求先有 App，应用页又不能创建 App，形成死路 | `packages/web/src/admin/pages/apps-page.tsx`、`api/app-api.ts` |
| MVP-07 | 管理员调试对话仍是占位 | 无 Agent 选择、WebSocket、消息输入、历史和 DebugSession 恢复 | `packages/web/src/admin/pages/chat-page.tsx` |

### 3.2 P1 可用性缺口

| ID | 问题 | 主要位置 |
|---|---|---|
| MVP-08 | 次级栏始终显示过期占位文案 | `admin/nav/secondary-panel.tsx` |
| MVP-09 | 右侧 360px 抽屉始终显示占位内容，压缩主工作区 | `admin/right-drawer/right-drawer.tsx`、`admin/styles.css` |
| MVP-10 | Agent 顶部选择器没有实现 | `admin/pages/agents-page.tsx`、`admin/agents/` |
| MVP-11 | Agent“调试记录”页签仍是占位 | `admin/agents/agent-workspace.tsx` |
| MVP-12 | App“应用配置”仍是占位 | `admin/apps/app-detail.tsx` |
| MVP-13 | App“用户会话”仍是占位，没有按 App 跳转/筛选 | `admin/apps/app-detail.tsx` |
| MVP-14 | App“接入方式”没有呈现 WB-010 的 iframe/SDK 接入信息 | `admin/apps/app-detail.tsx` |
| MVP-15 | 设置页只显示硬编码连接信息 | `admin/pages/settings-page.tsx` |
| MVP-16 | App 详情预加载并静默吞掉 Launch Key/Audit 错误 | `admin/apps/app-detail.tsx` |
| MVP-17 | 部分列表缺少可靠 retry、分页保留和过期请求保护 | Agent/App 列表组件 |

### 3.3 验收覆盖缺口

- 现有 Shell 测试主要检查导航文字、路由解析和 CSS 字符串。
- 没有验证 Vite dev proxy 对 `/api/control` 返回 JSON。
- 没有空数据库首次使用测试。
- 没有真实 Token 解锁测试。
- 没有 Chromium 主链路测试。
- handoff 中的专项测试通过不能证明五个模块在浏览器内可用。

## 4. 实施顺序

严格按以下顺序执行。每一批完成并通过专项验证后再进入下一批。

### Batch 1：开发代理与真实鉴权

目标：管理员输入错误 Token 时留在锁屏；正确 Token 解锁后所有 Control API 通过同源代理可用。

要求：

1. Vite rewrite 必须跳过 `/api/`、WebSocket 和其他后端路径；`/api/control/*`、`/api/embed/*` 先交给 proxy。
2. 解锁必须调用一个真实、只读的 Control endpoint 验证 Token。
3. connected 状态只能在服务端返回成功后建立。
4. Tenant 名称和 ID 必须来自服务端，不得使用 `ten_placeholder` 或“默认租户”。如现有 endpoint 不返回 Tenant，新增最小的 `GET /api/control/v1/session` 或等价 whoami endpoint。
5. 401 必须清除内存 Token、Tenant 和模块数据并返回锁屏。
6. Token 不进入 Storage、URL、日志或错误文本。

验收：

- 错误 Token → 401，保持锁屏。
- 正确 Token → 显示真实 Local Admin Tenant。
- 浏览器访问应用、Agent、会话页面时，Network 响应为 JSON，不是 `index.html`。

### Batch 2：修复 Server 列表 500

目标：空 Tenant 下所有一级列表返回合法空页。

要求：

1. 修正 Agent repository 无 cursor/cursor 两种模式的 SQL placeholder 编号。
2. Conversation admin 查询从正确关系取得 `agentDefinitionId`，不得引用 schema 中不存在的列。
3. 为两处添加 PostgreSQL repository 回归测试，至少覆盖空页、单行、cursor 和 Agent 筛选。
4. 内部异常保留 requestId；不得把 SQL/secret 暴露给 Web。

验收：

```text
GET /api/control/v1/agent-definitions?limit=50 → 200 empty page
GET /api/control/v1/conversations?limit=50    → 200 redacted empty page
```

### Batch 3：空 Tenant 首次使用闭环

目标：管理员无需 curl 或直接操作数据库即可创建第一组可发布资源。

要求：

1. Agent 空状态提供“导入当前 Agent”主按钮，接入现有 `POST /agent-definitions/import-current`。
2. 导入成功后刷新列表并自动进入 Agent 详情。
3. 应用列表提供“创建应用”入口，接入现有 `POST /published-apps`。
4. 创建表单至少包含 Agent、名称、accessMode、allowedOrigins；不把私钥或 Launch Token 放入浏览器。
5. Agent 的 Publish Drawer 在没有关联 App 时提供创建入口或明确跳转并保留 Agent 上下文。
6. 所有写操作使用新的 Idempotency-Key；失败可重试且不重复创建。

验收：全新数据库中仅通过 UI 可完成“导入 Agent → 创建 App”。

### Batch 4：管理员调试对话

目标：完成原 WB-003 未交付的核心功能。

要求：

1. 复用现有 `connection-controller`、`session-controller` 和 Pi WebSocket 协议；不要另造第二套消息协议。
2. 提供 Agent 选择器；Agent A/B 的 DebugSession 必须隔离。
3. 使用 `debug-session-store.ts` 恢复每个 Agent 最近一次 sessionId；Store 只是映射，不得替代服务端历史。
4. 支持新建调试会话、发送文本、流式响应、错误/重连和历史恢复。
5. 明确显示本次调试使用的 Agent Revision 或“未保存草稿测试”。
6. 不在管理员调试页展示真实企业用户 Conversation。
7. Tool、Attachment、Citation 至少安全只读展示；未知事件不得导致页面崩溃。

验收：

- Agent A 发消息，切换 B，再切回 A，A 的上下文和历史恢复。
- 刷新页面后恢复最近 DebugSession。
- WebSocket 断开时显示可重试错误，不丢失已确认历史。

### Batch 5：Agent 工作区补全

目标：使 Agent 一级模块独立可用。

要求：

1. 在顶部或次级栏实现真实 Agent 选择器和 loading/empty/error/retry。
2. Agent 列表支持 cursor 分页。
3. “调试记录”显示该 Agent 的管理员 DebugSession，而不是企业用户会话。
4. 保存失败保留 draft；切换 Agent 前提示未保存修改。
5. 时间、状态、未知字段使用一致格式。

### Batch 6：应用工作区补全

目标：隐藏或完成所有对初版主链路可见的占位页签。

要求：

1. “应用配置”提供真实可编辑字段；如果字段必须通过新 Version 生效，UI 要明确区分保存与上线。
2. “用户会话”跳转到 `/conversations` 并带 App 筛选，或直接复用同一筛选组件。
3. “接入方式”展示可复制 iframe 和 WB-010 SDK 示例；Origin、publicAppId 使用真实数据。
4. Launch Keys、Audit 改为页签进入时加载；错误不能静默转为空数组。
5. Preview、activate、rollback、suspend 保留二次确认和审计语义。
6. 列表 retry 保留当前筛选；加载更多需要防重复点击和过期响应覆盖。

### Batch 7：Shell 与设置收口

目标：移除明显的脚手架外观。

要求：

1. 次级栏显示当前模块的真实列表/筛选；没有内容价值时应折叠，而不是显示占位文案。
2. 右侧抽屉仅在有上下文内容时打开；默认不永久占用 360px。
3. 设置页显示真实 Tenant、Base URL 和连接状态。
4. 如允许切换 Base URL，切换时必须重新验证 Token 并清空旧 Tenant 数据。
5. 保留“重新锁定”，并明确 Token 只存在内存。
6. 桌面、960px、720px 三档布局都不得遮挡主操作。

### Batch 8：真实浏览器验收与文档校正

目标：用实际行为而非组件存在性决定完成状态。

要求：

1. 增加 Chromium smoke/E2E，覆盖本手册第 2 节主链路。
2. 测试必须启动真实 Vite proxy 和真实 Control Server；mock API 测试不能替代。
3. 覆盖 loading、empty、error、retry、401、未知状态和 cursor 分页。
4. 验收后修正 WB-002～WB-006 handoff 中不准确的 Complete/占位说明。
5. 在 `docs/admin-workbench/tasks/README.md` 记录补全任务和最终验收结果。

## 5. 建议代码范围

主要 Web 文件：

```text
runtimes/pi/packages/web/vite.config.ts
runtimes/pi/packages/web/src/admin/auth/
runtimes/pi/packages/web/src/admin/pages/
runtimes/pi/packages/web/src/admin/agents/
runtimes/pi/packages/web/src/admin/apps/
runtimes/pi/packages/web/src/admin/user-conversations/
runtimes/pi/packages/web/src/admin/nav/
runtimes/pi/packages/web/src/admin/right-drawer/
runtimes/pi/packages/web/src/admin/styles.css
runtimes/pi/packages/web/test/admin/
```

主要 Server 文件：

```text
runtimes/pi/packages/server/src/publishing/control/
runtimes/pi/packages/server/src/persistence/postgres/repositories/agent-definitions.ts
runtimes/pi/packages/server/src/persistence/postgres/repositories/conversations.ts
runtimes/pi/packages/server/test/publishing/
runtimes/pi/packages/server/test/persistence/
```

协议变更仅在真实缺少 DTO 时进行，不要在 Web 内继续使用 `unknown` 或复制接口形状。

## 6. 测试要求

每批修改后运行对应专项测试。最终至少执行：

```bash
cd /home/hello/workspace/skdy-agent/runtimes/pi

# 仓库规定检查
npm run check

# Web Admin 专项
cd packages/web
node ../../node_modules/vitest/dist/cli.js --run \
  test/admin/app-shell.test.tsx \
  test/admin/app-api.test.ts \
  test/admin/conversations-api.test.ts \
  test/admin/agent-state.test.ts
cd ../..

# Server 专项：按实际新增/修改文件逐个运行，不直接运行完整 Vitest suite
```

还必须完成真实本地验收：

```bash
npm run dev:admin
```

使用终端打印的 Admin Token，在实际 Chromium 中执行第 2 节完整主链路。记录：

- Web 与 Server 端口；
- 浏览器控制台错误；
- 失败请求的 requestId；
- 每一步的 HTTP 状态；
- Preview/Embed 的宿主 Origin；
- Conversation 和导出审计记录。

## 7. 禁止项

- 不增加免 Token 或开发态绕过鉴权分支。
- 不用静态“默认租户”伪造连接成功。
- 不删除失败测试来获得绿色结果。
- 不用前端 mock 数据掩盖空库主链路缺失。
- 不让 Vite SPA fallback 接管 `/api/*`。
- 不把真实企业用户会话混入管理员 DebugSession。
- 不在浏览器 Storage、URL、console 或异常中保存 Token、PEM、pepper。
- 不把所有页签数据在详情首次进入时预加载并提前产生审计。
- 不用 handoff 的 Complete 状态替代真实 Chromium 验收。

## 8. 完成判定

同时满足以下条件才可标记“初版可用”：

- 第 2 节主链路可以在全新数据库中只通过 UI 完成。
- 五个一级模块没有阻断错误和过期占位文案。
- 错误 Token 无法进入工作台，正确 Token 显示真实 Tenant。
- Agent 和 Conversation 空列表均返回 200。
- Admin 调试对话支持按 Agent 创建、发送、切换和恢复。
- App 创建、Version、Preview、Activate 闭环可用。
- 用户会话详情、增量事件、Summary、附件和三种导出可用。
- `npm run check`、专项测试和真实 Chromium 主链路全部通过。
- handoff 与实际代码状态一致，所有保留缺口有新的任务编号和责任边界。

## 9. 开发交付模板

开发完成后提交一份补全 handoff，至少包含：

```text
1. 完成的 MVP-xx 列表
2. 实际修改文件
3. API/DTO/数据库变化
4. 首次使用步骤
5. 执行过的检查和专项测试
6. Chromium 主链路结果
7. 仍未关闭的问题及其任务编号
8. 与原 WB-000～010 handoff 的状态修正
```
