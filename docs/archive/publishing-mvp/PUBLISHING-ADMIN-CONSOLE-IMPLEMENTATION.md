# Publishing 管理控制台实施规格

> 状态：待实施
>
> 目标：在不改变现有 Embed 数据面的前提下，为内部管理员提供可视化发布、版本切换、回滚、停用和宿主接入信息管理。
>
> 依赖：`MULTI-USER-PUBLISHING-MVP-SPEC.md`、`MULTI-USER-PUBLISHING-OPS-RUNBOOK.md`、现有 Control Plane HTTP API。

## 1. 交付目标

管理员可以通过 `/publishing` 完成以下闭环：

1. 连接 Control Plane；
2. 导入当前 AgentDefinition；
3. 创建 PublishedApp；
4. 创建不可变 PublishedAppVersion；
5. 激活指定版本；
6. 查看 App、版本、状态和 Embed URL；
7. 回滚、停用和恢复 App；
8. 管理 signed-user Launch Key；
9. 复制 iframe、Embed URL 和宿主接入信息；
10. 查看最近管理操作及错误 requestId。

控制台是内部管理工具，不进入 `/embed/:publicAppId` bundle，也不允许 Embed 页面访问管理 API。

## 2. 当前能力与缺口

### 2.1 已有写接口

```text
POST /api/control/v1/agent-definitions/import-current
POST /api/control/v1/published-apps
POST /api/control/v1/published-apps/:appId/versions
POST /api/control/v1/published-apps/:appId/activate
POST /api/control/v1/published-apps/:appId/rollback
POST /api/control/v1/published-apps/:appId/suspend
POST /api/control/v1/published-apps/:appId/launch-keys
POST /api/control/v1/published-apps/:appId/launch-keys/:keyId/revoke
```

### 2.2 阻塞控制台的缺口

现有 Control API 没有查询接口。控制台不能可靠刷新、恢复页面或展示已有资源，因此必须先补：

```text
GET /api/control/v1/agent-definitions
GET /api/control/v1/published-apps
GET /api/control/v1/published-apps/:appId
GET /api/control/v1/published-apps/:appId/versions
GET /api/control/v1/published-apps/:appId/launch-keys
GET /api/control/v1/audit-events
```

不得通过浏览器直连数据库、缓存写接口响应冒充查询结果，或要求管理员手工输入数据库 ID。

## 3. 冻结决策

### 3.1 路由与构建边界

- `/publishing`：App 列表和创建入口。
- `/publishing/apps/:appId`：App 详情、版本、Origin、Key 和危险操作。
- `/embed/:publicAppId`：保持现有最终用户页面，不加载管理代码。
- 现有内部 Pi 对话页保持 `/`，不改变行为。
- 第一阶段可以继续使用同一 Vite 应用，但必须通过路由级分支隔离；后续可独立构建管理 bundle。

### 3.2 管理员认证

- Control API 继续使用 `Authorization: Bearer <admin-token>`。
- 首版由管理员在页面输入 Token。
- Token 只保存在 React Controller 内存，不写 localStorage、sessionStorage、URL、日志或错误对象。
- 页面刷新后必须重新输入 Token。
- logout/锁定动作立即清空内存 Token 和所有管理数据。
- 生产部署必须限制 `/publishing` 和 `/api/control/v1/*` 到内网、VPN 或身份代理之后。
- 后续可增加 BFF/HttpOnly Session，但不作为首版阻塞项。

### 3.3 幂等与并发

- 每个写操作由客户端生成新的 `Idempotency-Key`。
- 自动重试同一个请求时复用原 Key。
- 用户再次主动点击是新操作，生成新 Key。
- 提交期间禁用对应按钮，防止重复操作。
- 409 `IDEMPOTENCY_IN_PROGRESS` 显示“操作处理中”，不得自动创建第二次操作。

### 3.4 ID 与状态

- UI 只使用 API 返回的公开表示 ID：`agent_*`、`app_*`、`pav_*`、`pub_*`。
- 不在前端构造或解析裸 UUID。
- 状态值直接使用服务端 string union，不定义 TypeScript enum。
- 未识别的新状态以只读“未知状态”展示，不允许危险操作。

## 4. 查询 API 契约

所有查询接口要求管理员 Bearer Token，按 bootstrap tenant scope 返回资源。跨租户与不存在统一 404。

### 4.1 AgentDefinition 列表

```http
GET /api/control/v1/agent-definitions?limit=50&cursor=...
```

```json
{
  "data": {
    "items": [
      {
        "id": "agent_<uuid>",
        "name": "Support Agent",
        "revision": 3,
        "sourceHash": "...",
        "createdAt": "2026-08-17T00:00:00.000Z"
      }
    ],
    "nextCursor": null
  },
  "requestId": "req_<uuid>"
}
```

默认仅返回每个 Agent 的最新 revision；`includeRevisions=true` 可返回历史 revision。

### 4.2 PublishedApp 列表

```http
GET /api/control/v1/published-apps?limit=50&cursor=...&status=active
```

每项至少包含：

```text
id
publicAppId
name
status
accessMode
allowedOrigins
currentVersionId
embedUrl
createdAt
updatedAt
```

### 4.3 App 详情

```http
GET /api/control/v1/published-apps/:appId
```

返回 App 基本信息、当前版本摘要、源 Agent 摘要和能力摘要。不得返回 RuntimeSpec 中的 Provider secret。

### 4.4 版本列表

```http
GET /api/control/v1/published-apps/:appId/versions?limit=50&cursor=...
```

每项至少包含：

```text
id
versionNumber
status
sourceAgentRevision
runtimeSpecHash
validationErrors
createdAt
isCurrent
```

首版不向浏览器返回完整 system prompt 或完整 RuntimeSpec；详情只返回经过 allowlist 的能力、模型 ID、上下文和配额摘要。

### 4.5 Launch Key 列表

```http
GET /api/control/v1/published-apps/:appId/launch-keys
```

只返回 `keyId`、algorithm、status、notBefore、expiresAt 和 createdAt。永不返回 PEM 内容。

### 4.6 审计事件

```http
GET /api/control/v1/audit-events?appId=app_<uuid>&limit=50&cursor=...
```

返回有界 metadata；不得返回 Token、PEM、visitorId、externalUserId、prompt 或完整请求体。

## 5. 页面与交互设计

### 5.1 登录/连接态

页面初始显示：

- Control Plane 地址，默认同源且生产环境不可编辑；
- Admin Token 密码输入框；
- “连接”按钮；
- 连接成功后显示 bootstrap tenant 名称；
- 401 时清空 Token 并回到锁定态。

### 5.2 App 列表页

包含：

- 状态筛选、名称搜索；
- App 名称、状态、访问模式、当前版本、Origin 数量；
- Embed URL 复制；
- “导入当前 Agent”；
- “创建应用”；
- 空状态、加载态、错误态和分页。

### 5.3 创建应用向导

分三步：

1. 选择已导入的 Agent 和 revision；
2. 输入 App 名称、accessMode、allowedOrigins、主题色和欢迎语；
3. 预览并确认创建。

Origin 输入规则：

- 一行一个 Origin；
- 客户端只做即时格式提示；
- 服务端校验是唯一真相；
- 不自动把非法 Origin 改写为其他值。

### 5.4 App 详情页

分区：

- Overview：状态、publicAppId、Embed URL、iframe 示例；
- Versions：创建版本、激活、回滚、查看 validationErrors；
- Origins/Access：只读显示当前策略；修改策略仍通过创建新版本或明确的后续策略接口；
- Launch Keys：登记公钥、轮换状态、吊销；
- Audit：最近管理事件；
- Danger Zone：Suspend、恢复/Activate。

危险操作要求二次确认，确认框显示 App 名称和影响，不使用浏览器原生 `confirm()`。

### 5.5 发布成功页

显示并可复制：

```html
<iframe
  src="https://agent.example.com/embed/{publicAppId}"
  allow="microphone"
></iframe>
```

同时显示：

- publicAppId；
- 当前版本；
- allowedOrigins；
- anonymous/signed-user 接入提示；
- 回滚和停用入口。

## 6. 前端结构

建议新增：

```text
packages/web/src/publishing/
  types.ts
  api.ts
  auth-controller.ts
  publishing-controller.ts
  publishing-app.tsx
  app-list.tsx
  create-app-wizard.tsx
  app-detail.tsx
  version-panel.tsx
  launch-key-panel.tsx
  audit-panel.tsx
  confirm-dialog.tsx
  publishing.css
```

职责：

- `api.ts`：Control API、错误信封、Bearer、Idempotency-Key。
- `auth-controller.ts`：内存 Token 生命周期和 401 清理。
- `publishing-controller.ts`：加载、分页、mutation 状态和刷新。
- React 组件只处理展示和用户事件，不直接拼 API 请求。
- `main.tsx` 只负责 `/publishing` 路由分流。

## 7. 服务端结构

优先扩展：

```text
packages/server/src/publishing/control/http.ts
packages/server/src/publishing/control/service.ts
packages/server/src/persistence/postgres/repositories/
```

原则：

- Repository 查询必须带 Tenant/App scope；
- 列表使用稳定 cursor，不用 offset；
- SQL 中包含 scope 条件；
- 查询返回 DTO，不直接暴露数据库 record；
- GET 不写 idempotency 记录；
- 查询操作也必须记录 requestId，但普通读取不写 audit event。

## 8. 实施任务

### ADMIN-000：冻结契约与路由

- 补查询 API decoder/type；
- 冻结 `/publishing` 路由；
- 添加本规格文档。

完成条件：Server/Web 使用共享协议类型；没有 `JSON.parse() as BusinessType`。

### ADMIN-001：Repository 查询能力

- Agent 最新 revision 列表；
- App 列表/详情；
- Version 列表；
- Launch Key 列表；
- Audit 列表；
- cursor 和 tenant scope 测试。

完成条件：猜中其他 tenant/app ID 仍返回 404 或空列表。

### ADMIN-002：Control GET API

- 实现第 4 节全部 GET；
- 管理员认证、分页、参数校验、错误信封；
- HTTP 集成测试。

完成条件：刷新浏览器后可完全从 API 恢复页面，不依赖之前 mutation 响应。

### ADMIN-003：前端 API 与内存认证

- `PublishingApi`；
- Token 内存存储；
- 401 自动锁定；
- 幂等键复用规则；
- API 单元测试。

完成条件：Token 不出现在 Storage、URL、console 或异常文本。

### ADMIN-004：App 列表与导入

- 登录态；
- App 列表、筛选、分页；
- 导入当前 Agent；
- loading/empty/error/retry。

完成条件：管理员能看到既有 App，并可导入新 revision。

### ADMIN-005：创建与首次发布向导

- 创建 App；
- 创建 Version；
- 激活 Version；
- 一次向导串联三步，但每一步保留独立错误和重试；
- 成功页展示 Embed 信息。

完成条件：全新数据库无需 curl 即可获得可访问 Embed URL。

### ADMIN-006：版本、回滚与停用

- Version 列表；
- 创建版本；
- 激活、回滚、Suspend；
- 二次确认与审计刷新。

完成条件：运维 runbook 的常用操作可通过 UI 完成，且不需要贴库。

### ADMIN-007：Launch Key

- 公钥登记；
- active/retiring/revoked 展示；
- 吊销；
- PEM 仅在提交期间存在于表单内存，成功/取消立即清空。

完成条件：UI、日志、查询响应均无法取回 PEM。

### ADMIN-008：浏览器与安全验收

- 真实 Chromium 发布闭环；
- Token Storage/URL/日志检查；
- 401、403、404、409、422、500 错误态；
- 键盘操作、焦点、移动布局；
- Embed bundle 不含管理模块检查。

完成条件：无未关闭 P0/P1；控制台可完成发布、回滚、停用和 Key 吊销。

## 9. 测试矩阵

### 9.1 服务端

- 每个 GET 的 happy path；
- 缺失/错误 Token；
- 跨 tenant/app scope；
- cursor 稳定性和非法 cursor；
- 空列表；
- 版本与 App 归属；
- 查询 DTO 不含 secret、PEM、完整 prompt。

### 9.2 前端

- Token 只在内存；
- 401 清空状态；
- mutation 自动刷新；
- Idempotency-Key 重试复用；
- 创建向导部分失败后可继续；
- activate/rollback/suspend 确认；
- 表单和服务端 validationErrors 显示；
- 复制 iframe；
- 路由刷新恢复。

### 9.3 端到端

```text
空数据库
→ 输入 Admin Token
→ 导入当前 Agent
→ 创建 App
→ 创建 Version
→ Activate
→ 打开 Embed URL
→ 完成真实模型对话
→ 发布第二版
→ 旧会话仍绑定旧版
→ 新会话使用新版
→ Rollback
→ Suspend
→ Embed 立即拒绝新操作
```

## 10. 质量门

每个任务：

1. 先写对应单元或集成测试；
2. 跑具体测试文件；
3. `npm run check`；
4. 检查 Token/PEM/Provider secret 是否出现在 diff、日志或 fixture；
5. 更新本文件任务状态和交接记录。

禁止使用完整付费模型做日常回归；只在最终 E2E 运行两次最短真实请求。

## 11. Definition of Done

- [ ] 查询 API 完整且全 scope；
- [ ] `/publishing` 不影响 `/` 和 `/embed/*`；
- [ ] Token 仅内存保存；
- [ ] 无需 curl 可完成首次发布；
- [ ] 可视化完成新版本、激活、回滚、停用；
- [ ] Launch Key 可登记和吊销，PEM 不可回读；
- [ ] 页面刷新可从 GET API 恢复；
- [ ] 错误显示 code、message、requestId，不泄 secret；
- [ ] 真实浏览器发布到 Embed 对话闭环通过；
- [ ] `npm run check` 和专项测试全绿；
- [ ] 运维与宿主接入文档同步更新。

## 12. 非目标

- 多租户管理员切换；
- RBAC/SSO 管理后台；
- 计费和套餐；
- RuntimeSpec 原始 JSON 编辑器；
- 在线编辑 system prompt；
- 自定义域名；
- 删除 App/Version；
- 把 Admin Token 持久化到浏览器。

这些能力需要独立安全和产品评审，不在本控制台首版范围。
