# MULTI-USER-PUBLISHING MVP — 交接记录

> **本文件是开发交接文档**：记录「现在做到哪 + 后面接手的人需要知道什么」。
> 需求与实施规格见 `docs/MULTI-USER-PUBLISHING-MVP-SPEC.md`（TASK-000～039、数据模型、API 契约、完成/禁止条件）。
> 依赖选型评审见 `docs/PUBLISHING-DEPENDENCIES-REVIEW.md`。

## 一、当前进度

**阶段：D（匿名 iframe 文本闭环），TASK-015~019 已完成。服务端全链路与 web 逻辑层已验证；浏览器级 iframe 演示验证受环境限制待完整环境补做。**

### 任务清单

- [x] **TASK-000** 记录基线并建立功能开关（`PI_PUBLISHING_ENABLED`，默认 false）
- [x] **TASK-001** 建立领域 ID、状态和错误类型
- [x] **TASK-002** 引入并评审基础依赖（postgres/ioredis/jose/minio/zod）
- [x] **TASK-003** 建立 PostgreSQL/Redis/ObjectStore 客户端
- [x] **TASK-004** 实现 migration runner 和核心发布表（0001）
- [x] **TASK-005** 创建 Principal/Conversation/Event 表（0002/0003）
- [x] **TASK-006** 创建 Attachment/Idempotency/Audit 表（0004/0005）
- [x] **TASK-007** 实现作用域安全 Repository（ResourceScope 必填、禁裸 ID）
- [x] **TASK-008** 实现 Event 原子追加和幂等记录
- [x] **TASK-009** 实现 RuntimeSpec Schema
- [x] **TASK-010** 实现 RuntimeSpec Compiler
- [x] **TASK-011** 实现 PublishedApp/Version Service
- [x] **TASK-012** 实现激活、停用和回滚
- [x] **TASK-013** 暴露 Control Plane HTTP API
- [x] **TASK-014** 实现 Origin 策略
- [x] **TASK-015** 实现匿名 Principal Exchange
- [x] **TASK-016** 实现 Conversation Service/API
- [x] **TASK-017** 实现最小 PiRuntimeAdapter
- [x] **TASK-018** 实现同步/测试用文本 Turn HTTP 路径
- [x] **TASK-019** 实现 Embed Web 壳和匿名 Bootstrap ⏭ 已完成
- [x] **TASK-020** 实现 EffectOwner ⏭ 已完成
- [x] **TASK-021** 实现 ConversationRuntimeManager ⏭ 已完成
- [x] **TASK-022** 实现持久事件到 Pi 上下文恢复 ⏭ 已完成
- [x] **TASK-023** 定义 Embed Realtime v1 Decoder ⏭ 已完成
- [x] **TASK-024** 实现 WebSocket Ticket ⏭ 已完成
- [x] **TASK-025** 实现 Realtime Connection ⏭ 已完成
- [x] **TASK-026** 实现 Web Realtime 与断线恢复 ⏭ 已完成
- [ ] **TASK-027** 实现 Launch Key 管理 ⏭ 下一步
- [ ] **TASK-023** 定义 Embed Realtime v1 Decoder
- [ ] **TASK-024** 实现 WebSocket Ticket
- [ ] **TASK-025** 实现 Realtime Connection
- [ ] **TASK-026** 实现 Web Realtime 与断线恢复
- [ ] **TASK-027** 实现 Launch Key 管理
- [ ] **TASK-028** 实现 signed-user Exchange 与 nonce 防重放
- [ ] **TASK-029** 实现 postMessage v1
- [ ] **TASK-030** 实现对象存储 Attachment Service
- [ ] **TASK-031** 加入 Attachment ResourceOwner 和配额
- [ ] **TASK-032** 迁移 Citation 到 Conversation Scope
- [ ] **TASK-033** 完善 Embed UI
- [ ] **TASK-034** 实现分层限流与并发槽
- [ ] **TASK-035** 实现审计、指标和日志脱敏
- [ ] **TASK-036** 条件性接入 TTS/Avatar
- [ ] **TASK-037** 安全验收
- [ ] **TASK-038** 容量与故障压测
- [ ] **TASK-039** 灰度、回滚和交付

**工作树状态**：未提交（所有改动仅存在于 working tree；按 AGENTS.md 只在用户要求时提交）。

## 二、后面的人需要知道什么

### 环境（本地开发）

- PostgreSQL：`127.0.0.1:5433`，用户/密码 `skdy`/`skdy123`（docker 容器 `backend-db-1`，PG 15）。
  - 测试库 `skdy_agent_test` 已创建；集成测试每个文件用**独立 schema**（`pub_test_<pid>_<ts>`，经 `searchPath` 连接参数），并行不冲突，afterAll 自动 drop，**不要**把测试指向真实数据。
- Redis：`127.0.0.1:6380`（docker 容器 `backend-redis-1`）；测试用 DB 15。
- 对象存储：本机 **没有** MinIO（9000 端口是其他服务）；`S3ObjectStore` 未联真实 S3 验证过，接口语义由 `LocalTestObjectStore` 覆盖。
- 环境变量默认值（测试自动探测，服务不可达时相关用例自动 skip）：`PI_TEST_DATABASE_URL`、`PI_TEST_REDIS_URL`。

### 质量门（每个 TASK 固定流程）

1. 先写/改单文件测试，证明缺失行为；
2. 实现代码；
3. 跑该文件测试：`node ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts`（在 `packages/server/` 下）；
4. `npm run check`（根目录，biome 会自动 `--write` 格式化少量文件，正常）；
5. 核对完成条件与禁止继续条件，记录到本文件。

**不要**运行完整 `npm test` / `npm run build`（AGENTS.md 规定）。

### 已建目录（均在 `runtimes/pi/packages/server/`）

```text
src/embed/
  http-shared.ts               Embed 数据面共享：统一错误信封 / CORS / requestId / 读 JSON 体
  auth/origin.ts               Strict Origin 策略（TASK-014，HTTP/Exchange/Realtime 共用）
  auth/access-token.ts         AccessTokenService（Ed25519 JWS 签发/验签）+ EmbedAccessKey 类型 + PEM 加载
  auth/principal.ts            anonymousSubjectHash（HMAC pepper）+ ExchangeService（App/accessMode/Origin 校验 + Principal upsert + 签发）
  auth/exchange-http.ts        POST /api/embed/v1/exchange 端点（匿名模式）
  middleware/authenticate.ts   EmbedAuthenticator（Bearer AccessToken -> EmbedAuthContext，401 统一映射）
  conversations/service.ts     ConversationService（创建固定版本/列表 cursor/读取/事件恢复/归档/executeTurn，全 scope）
  conversations/http.ts        Conversation HTTP API（create 幂等 / list / get+events / archive / dev turn）
  start.ts                     Embed 数据面组合：loadEmbedPlaneConfig（pepper/密钥校验）+ createEmbedServices + composeEmbedPlane
src/runtime/
  scope-context.ts             ScopeContext 最小层级（Process->Tenant->Version->Principal->Conversation->Turn）
  conversation-runtime.ts      ConversationRuntime（包装 PiSessionRuntime + RuntimeSpec + Scope；幂等 close）
  pi-runtime-adapter.ts        PiRuntimeAdapter（RuntimeSpec -> session，chat-only 白名单，依赖注入 createSession）
  turn-executor.ts             TurnExecutor + runtimeTurnExecutor（open->prompt->提取文本->close）+ managedTurnExecutor（manager 复用活跃 Runtime）
  effect-owner.ts              EffectOwner（LIFO disposer、幂等 close、聚合错误）
  runtime-owner.ts             RuntimeOwner + LocalRuntimeOwner（nodeId/epoch，未来 Lease 边界）
  conversation-runtime-manager.ts  ConversationRuntimeManager（opening 去重、active map、空闲 TTL、drain）
  context-restore.ts           持久事件 -> 上下文恢复（只恢复完成对、in-flight 收敛、schema/预算过滤）
src/embed/bootstrap-http.ts    GET /api/embed/v1/bootstrap（公开主题摘要，无凭据）

web（packages/web/src/embed/）:
  types.ts                     embed HTTP 契约类型（与 server 对齐；TASK-023 合并进 protocol 包）
  storage.ts                   visitorId 生成/保存（localStorage，可注入；PD-17）
  api.ts                       EmbedApi + EmbedApiError（fetch 封装、错误信封、Bearer）
  auth-controller.ts           EmbedAuthController（Exchange、内存 token、logout）
  conversation-controller.ts   EmbedConversationController（list/create/open/send + 事件推导消息）
  bootstrap.ts 由 api.bootstrap 承担
  embed-app.tsx / embed-shell.tsx / conversation-list.tsx / error-state.tsx / embed.css
  main.tsx 路径分流：/embed/:publicAppId -> EmbedApp；其余 -> 现有内部 App
src/publishing/
  config.ts                     PI_PUBLISHING_ENABLED 解析（默认 false，非法值启动失败）
  domain/ids.ts                 12 种 branded ID + UUIDv7 + parseId/toPublicId/fromPublicId
  domain/states.ts              状态 union + *_VALUES + isXxx 谓词（禁 enum）
  domain/errors.ts              14 个 EmbedErrorCode + HTTP/retryable 映射 + EmbedError
  domain/types.ts               ResourceOwner / ResourceScope / Principal
  repositories.ts               Repository 接口 + TenantScope/AppScope/OwnerScope/IdempotencyScope
  runtime-spec/
    schema.ts                   RuntimeSpec zod schema + PLATFORM_LIMITS（spec 5.5）+ parseRuntimeSpec
    compiler.ts                 compileRuntimeSpec（纯函数 + CapabilityCatalog 白名单）
    hash.ts                     canonicalJson（键排序）+ sha256Hex
  control/service.ts           ControlService（bootstrapTenant/importAgent/createApp/createVersion）
  embed/auth/origin.ts        Strict Origin 策略（TASK-014，HTTP/Exchange/Realtime 共用）
src/persistence/
  postgres/client.ts            PostgresClient（惰性、脱敏、幂等 close、searchPath、transaction）
  postgres/migrate.ts           runMigrations（单事务 + pg_advisory_xact_lock + _migrations 表）
  postgres/migrations/0001_publishing_core.sql      tenants/agent_definitions/published_apps/versions/launch_keys
  postgres/migrations/0002_principals_conversations.sql
  postgres/migrations/0003_conversation_events.sql
  postgres/migrations/0004_attachments.sql
  postgres/migrations/0005_idempotency_audit.sql
  postgres/migrations/0006_agent_definition_source_hash.sql   agent_definitions 复合主键 (id,revision) + source_hash + 版本 runtime_spec/hash 可空
  postgres/repositories/       tenants / agent-definitions / published-apps / published-app-versions
                               principals / conversations / conversation-events / idempotency / audit / tx
                               （createPublishingRepositories 组装）
  redis/client.ts               RedisClient（lazyConnect + 首命令显式 connect）
  object-store/{types,s3,local-test}.ts
src/web/start.ts                增加 publishing 选项，关闭时不创建任何新连接
```

### 关键决策（接手时不要破坏）

- **开关默认关闭**：`PI_PUBLISHING_ENABLED=false` 时现有 `/api/pi/v1/ws`、上传、引用、语音路径零改动。
- **无 TypeScript enum**：状态全部用 string literal union + 常量数组 + 谓词。
- **资源 ID 是裸 UUIDv7**（Spec 24.1 冻结）：数据库 uuid 列存裸 UUID；`ten_`/`conv_`/`att_` 等前缀**仅是表示层**，经 `toPublicId`/`fromPublicId` 进出；唯一例外是 `PublicAppId`（`pub_` 前缀存 text 列，公开定位符非凭据）。`parseId` 只接受裸 UUID。
- **Repository 作用域是类型级强制**：接口用具体 scope 子类型（TenantScope/AppScope/OwnerScope）而不是全可选 `ResourceScope`，调用方漏传作用域直接编译失败；SQL 内嵌 scope 条件，跨作用域一律返回 `undefined`（与缺失不可区分）。
- **jsonb 参数直接传对象/数组**：postgres.js 运行时自动序列化，不要 `JSON.stringify`（否则存成 JSON 字符串）。`PostgresClient.run` 参数类型已含 JSON 值。
- **复合外键防跨 App**：conversations → versions/principals、events → conversations、attachments → conversations/principals 全部带 `published_app_id` 复合外键，数据库层杜绝跨 App 引用（TASK-005/006 已验证）。
- **object_key 服务端生成**：客户端文件名只进 `filename` 列，绝不进 object_key。
- **幂等键唯一性**：`(tenant_id, principal_id, operation, idempotency_key)` 主键。
- **Event 追加与 sequence 递增同事务**（Spec 26.3）：`conversation-events.append` 在 `client.transaction` 内 `UPDATE conversations ... RETURNING last_event_sequence` + INSERT 事件；INSERT 失败整体回滚（无空洞、无递增）。禁止先读 sequence 再增。
- **幂等回收语义**（TASK-008）：begin 事务内 INSERT ON CONFLICT DO NOTHING 抢占；同 hash 已完成 → replay 原响应；不同 hash → conflict(409)；running 未过期 → in_progress；running 过期或 failed → 条件 UPDATE 原子回收（并发回收恰好一个 claimed）。`sweepExpired` 提供显式清扫。
- **RuntimeSpec 平台硬上限在 spec 5.5**（TASK-009 新增，数值锚定 5.4 示例与 PD-08/09/13/14）：Schema 拒绝越界值不钳制；`schemaVersion` 仅接受 1；strict 拒绝未知字段；capabilities 仅 5 个已知键。
- **Compiler 是纯函数**（TASK-010）：显式 `CapabilityCatalog` 白名单，禁止从全局可变 Settings 取配置；相同输入恒同 hash；只读 AgentDraftConfig 声明字段，Provider secret 永不进 spec/hash；输出经 parseRuntimeSpec 复检（Decoder 必可重读）。
- **agent_definitions 是 revision 行模型**（TASK-011）：主键 `(id, revision)`，同一 agent 多行共享 id；`source_hash` 持久化（spec 33.3），同 hash 导入幂等返回现有 revision，hash 变化才 revision+1，永不覆盖旧版。0006 移除了 published_apps → agent_definitions 的 FK（复合主键下无法表达），跨 tenant agent 归属由 ControlService 在 tenant scope 内解析校验。
- **版本号原子分配**（TASK-011）：`publishedAppVersions.createVersion` 在事务内 `SELECT ... FOR UPDATE` 锁 app 行 + max+1 + insert，并发建版本号唯一；Service 编译用与插入行相同的 versionId（id 是 spec 一部分，5.4），rejected 版本 runtime_spec/runtime_spec_hash 为 NULL（无激活 spec）。
- **Control 导入幂等**：importAgent 的幂等由「name + sourceHash」自然保证（idempotency 表依赖 app 级 principal，Control 发生在建 App 之前不可用）；expectedSourceHash 不匹配返回 409。
- **平台服务 Principal**（TASK-013，33.1 扩展 + 26.2）：Control 幂等/审计需要 principal 但 import-current 发生在任何 App 之前 → principals.published_app_id 允许 NULL（仅 service 类型，CHECK 约束），migration 0007 加部分唯一索引 `(tenant_id, principal_type, subject_hash) WHERE published_app_id IS NULL`；bootstrapTenant 幂等 upsert 平台 principal（id=tenantId、type=service、subject=SHA-256("control:"+tenantId)）；Control HTTP 的 idempotency scope 即 tenant 自身。
- **Origin 策略单点**（TASK-014，13.1）：`embed/auth/origin.ts` 单一策略函数供 HTTP/Exchange/Realtime 共用（禁止三分支各自实现）；严格解析 scheme/host/port，生产仅 HTTPS（localhost/127.0.0.0/8/::1 例外）；默认端口等价；仅接受 `*.sub.example.com` 单级子域通配（拒绝裸 `*`、通配 TLD、通配+端口）；拒绝路径/userinfo/`null` Origin；`buildFrameAncestors` 与运行时匹配同源生成（`'none'` 兜底）。ControlService.createPublishedApp 保存前 `validateOriginList` 校验，非法 → 400 INVALID_ORIGINS。
- **匿名 subject hash 用 HMAC pepper**（TASK-015，7.1/AD-09）：`anonymousSubjectHash(pepper, tenant, app, visitorId)` = `HMAC-SHA256(pepper, "anonymous\n<tenant>\n<app>\n<visitor>")`；visitorId 永不落库（库中只有 64 位 hex subject_hash，`external_user_id_ciphertext` 恒 NULL）、永不进 token/日志。pepper 环境变量 `PI_EMBED_SUBJECT_PEPPER`（新增到 spec 24.2），与 Access Token 私钥独立；ExchangeService 构造时显式注入。
- **`getByPublicAppId` 是仓库层唯一无 scope 查找**（TASK-015）：Exchange 是公开端点，客户端只持有 `publicAppId`（全局 UNIQUE、不可猜测的公开定位符，AD-10），无法预先知道 tenant，故该方法去掉 TenantScope 参数；查到的 `tenantId` 立即成为下游所有操作的作用域。原「要求 tenant scope」的测试改为断言「按公开定位符解析且返回 tenant」。
- **Access Token 类型**（TASK-015，7.3/24.1）：Ed25519/EdDSA JWS，独立 keyId（`PI_EMBED_ACCESS_TOKEN_KEY_ID`）；claims 只含 tokenId(jti)/tenantId/publishedAppId/principalId/principalType/scopes/publishedAppVersionId，无任何秘密；aud 固定 `skdy-embed-access`；TTL 默认 600s（`PI_EMBED_ACCESS_TOKEN_TTL_SECONDS`，1..86400 整数，非法启动失败）。由于仓库 tsconfig 无 DOM lib，密钥类型用 `EmbedAccessKey = GenerateKeyPairResult["privateKey"]`（jose 结构类型）而非裸 `CryptoKey`。
- **Exchange 校验顺序**（TASK-015，27.4）：publicAppId 定位 App（404 APP_NOT_FOUND）→ status != active → 403 APP_SUSPENDED（draft/suspended/archived 同）→ accessMode 不含 anonymous → 403 FORBIDDEN → Origin 不在 allowlist → 403 ORIGIN_NOT_ALLOWED（缺 Origin 头同）→ HMAC subjectHash → `principals.upsert`（ON CONFLICT 保留既有 id，同访客稳定）→ 检查返回 status active → 签发 Token。features（uploads/speech/avatar）读当前版本 RuntimeSpec 的 capabilities，无版本/不可解析时全 false。
- **Exchange HTTP 只做 HTTP 关注点**（TASK-015）：`embed/http-shared.ts` 统一错误信封/CORS/requestId/读 JSON 体（后续 Conversations/Uploads/Realtime 复用）；请求体校验在 handler（400 INVALID_REQUEST，错误消息绝不含 visitorId 值）；OPTIONS 预检 204 回 CORS；413 用 64 KiB 上限。**尚未挂进 startWebServer**——等 embed/start.ts 组合任务（含 pepper/密钥文件缺失启动失败校验）。
- **Conversation 认证/授权分离**（TASK-016）：`middleware/authenticate.ts` 只认证（Bearer AccessToken → EmbedAuthContext，401 统一）；逐资源授权在 `ConversationService` 以 scope 完成（越权 = 统一 CONVERSATION_NOT_FOUND）。创建时服务端读 App currentVersion 并固定（客户端提交的 `publishedAppVersionId`/`ownerPrincipalId` 被忽略）；App 非 active → 403 APP_SUSPENDED（PD-04）；无 ready 版本 → 409 VERSION_UNAVAILABLE。create 支持 Idempotency-Key（scope = token principal，operation `embed.conversations.create`）。列表 cursor 复用仓库 `(last_active_at, id)` 游标；GET /:id 支持 `afterSequence` 增量事件恢复（limit 默认 50 上限 200）。query 解析用 `Map`（缺失键为 undefined，解析函数须同时处理 null/undefined）。
- **Runtime 依赖注入**（TASK-017）：`PiRuntimeAdapter` 通过注入的 `createSession` 工厂使用现有 `PiSessionRuntime`（真实组合接 `CodingAgentPiSessionBackend`，测试接 fake），模块不直接 import `@earendil-works/pi-coding-agent`，可独立测试。chat-only 白名单在 `open` 时强制（非 chat-only profile / tools / knowledgeBases 拒绝打开），「禁用工具不能调用」无需依赖调用方自觉。session id 直接用 Conversation 裸 UUID；模型/thinkingLevel 来自 RuntimeSpec。
- **TASK-017 systemPrompt 已知限制**：`RuntimeSpec.agent.systemPrompt` 已随版本冻结存档，但现有 `PiSessionRuntime.prompt` 不透传 per-conversation prompt（底层 AgentSession 支持 `prompt(text,{systemPrompt})` 覆盖），本阶段沿用 Agent 自身配置——发布版本编译自同一 Agent，二者一致；TASK-022 恢复链路时统一注入。
- **executeTurn 内部/测试路径**（TASK-018）：`POST /api/embed/v1/dev/conversations/:id/turn`（dev 前缀，不作为最终公开协议）；持久化 user.message → TurnExecutor → assistant.completed / turn.failed；进程内单写者守卫 `runningTurns`（has 检查与 add 之间无 await，事件循环内原子；PD-13 并发 409）；幂等 operation `embed.turns.execute`；模型失败 → 503 RUNTIME_UNAVAILABLE + turn.failed 事件。`ConversationRuntime` 增加 `snapshot()`，`runtimeTurnExecutor` 从 transcript 提取最后一条 complete assistant 文本。
- **Embed 数据面组合**（TASK-019 前置，spec 25.2）：`embed/start.ts` 的 `loadEmbedPlaneConfig` 校验 pepper 与 Access Token 密钥文件缺失即启动失败（24.2）；`createEmbedServices` 纯组装（Exchange + Conversations + authenticator + `runtimeTurnExecutor(createPiRuntimeAdapter(createSession))`），不依赖 pi-coding-agent 可独立测试；`composeEmbedPlane` 供 startWebServer 使用。`ControlPlaneHandle` 新增暴露 `client`/`repositories` 供 embed 复用同一 PG 连接；startWebServer 在 publishing enabled 时挂载 bootstrap + exchange + conversations handler，`createSession` 适配 `CodingAgentPiSessionBackend.createSession`（session id = conversation 裸 UUID，model/thinkingLevel 来自 RuntimeSpec）。
- **Bootstrap 端点**（TASK-019）：`GET /api/embed/v1/bootstrap?publicAppId=` 公开摘要（name/status/currentVersionId/features/theme 从 mutablePolicy.theme 读），无凭据，供 iframe 壳渲染主题；App 不存在 404、缺参 400。
- **Web 壳与路径分流**（TASK-019）：`main.tsx` 匹配 `/embed/pub_<uuid>` → `EmbedApp`（不建立内部 WS 连接、不加载内部管理能力，spec 25.4 禁止条件）；否则原内部 App 流程不变。Embed 前端：storage（visitorId）/api（fetch 封装 + 错误信封）/auth（Exchange + 内存 token）/conversation（list/create/open/dev-turn + 事件推导消息）/组件（shell/list/error）。web typecheck（tsgo）在无 dist 环境下可用（paths 映射 pi-client/pi-protocol 到 src）。
- **TASK-019 已知验证限制**：浏览器级 iframe 演示（嵌入允许 Origin、刷新恢复、清理 storage 新身份、App 停用展示）需完整环境（workspace dist + 浏览器）手工验证；逻辑层已由 `test/embed/embed-logic.test.ts`（9 passed：storage/api 信封与错误映射/Bearer/auth 登入登出/事件推导/list-create-open）覆盖；组件未做 DOM 级测试（未引入 jsdom，避免新增依赖）。
- **EffectOwner**（TASK-020）：LIFO 释放、幂等 close（同一 Promise）、单 disposer 失败不阻断其他清理且聚合为 AggregateError、close 开始后 register 拒绝。实现细节：`close` 先赋值 closing 再经 `Promise.resolve().then` 执行释放体，保证同步 disposer 期间的 register 也能被拒绝。`ConversationRuntime` 的会话 dispose 已改经 owner 注册（完成条件落地）。
- **ConversationRuntimeManager**（TASK-021）：`acquire` opening 去重（并发同会话只创建一次）、active map、`release` 刷新活跃时间、`sweepIdle` 空闲 TTL 回收（返回 Promise 等待 close）、`drain`/`close` 节点退出（幂等，close 后 acquire 拒绝）；`RuntimeOwner`（LocalRuntimeOwner：nodeId/epoch，未来 Lease 边界）。生产路径：`embed/start.ts` 用 `managedTurnExecutor`（Turn 复用活跃 Runtime、release 不 close，空闲由 TTL 回收——Runtime 生命周期不再跟随单次 HTTP 请求）；TASK-018 的进程内 `runningTurns` 单写者守卫保留（manager 的 opening 去重不与之冲突）。
- **WebSocket Ticket**（TASK-024）：256-bit opaque（base64url 43 字符），Redis 只存 SHA-256 + claims JSON（`embed:ws-ticket:<hash>`），Lua 原子 get+del 单次消费；TTL 默认 45s（Redis EX 秒级粒度，最小 1s）。claims 绑定 tenant/app/principal(principalType/tokenId)/conversation/origin；consume 的 conversationId 可选（Realtime upgrade 时未知，由 claims 携带）；**错误 Origin/Conversation 的消费尝试同样原子消耗 ticket**（防探测/重放，第二次必定失败）。`POST /api/embed/v1/conversations/:id/ws-ticket` 需 token 且本人会话（越权 404），未配置服务 503。生产组合：`composeEmbedPlane` 校验 `PI_REDIS_URL`（新增到 config，web-start 断言同步）并建 RedisTicketStore。
- **Realtime Connection**（TASK-025）：`GET /api/embed/v1/realtime?ticket=` upgrade（ticket 消费成功才握手，失败 401/403 拒绝）；`EmbedRealtimeConnection` 只允许操作 claims 绑定的 Conversation（越权 1008、非法消息 1002、协议消息用 public `conv_<uuid>` 形式）；`turn.start` 复用 ConversationService.executeTurn（持久化 + 单写者），流式事件带 sequence，`message.completed` 来自持久事件（禁止流式 delta 当唯一真相）；`conversation.sync` 按 lastSeenSequence **从持久事件补发 completed**（spec 9.2 断线补齐，TASK-026）。接线：listener 新增 `onUnhandledUpgrade` 钩子（非主路径 upgrade 转给 embed），startWebServer 传入。
- **Web Realtime 传输**（TASK-026）：`packages/web/src/embed/realtime-transport.ts`——申请 Ticket → 连接 → sync 订阅；断线指数退避重连（maxRetries/backoffBaseMs 可配）；按 sequence 去重（重复/乱序丢弃）；切换 Conversation 关闭旧连接；**重连绝不自动重发用户消息**（只在用户动作时发送一次）。web/vite.config 补 pi-protocol 运行时别名（此前仅 type 级引用）。：`packages/protocol/src/embed/`（common/realtime/public-http）成为 embed wire 契约唯一来源；Web 端 `types.ts` 改为从协议包 re-export（消除重复），Server HTTP 层 inline 类型为历史偏差（TASK-025 Realtime 接线时收敛）。Realtime Decoder：`decodeClientCommand`/`decodeServerEvent` 校验未知 type（UNKNOWN_TYPE）、非对象（NOT_OBJECT）、缺/错字段（INVALID_FIELD）、超限（TOO_LONG：text 32k、attachmentIds ≤10、requestId ≤128、sequence 非负整数）。注意：协议包 `schemas.ts` 已有语音相关 `ServerEvent`，embed 的命名为 `EmbedServerEvent` 避免冲突；`REALTIME_LIMITS` 带 `as const`，`stringField` 的 maxChars 参数需显式 `number` 标注。
- **持久事件恢复**（TASK-022）：`runtime/context-restore.ts` 纯函数——只恢复 `user.message`+`assistant.completed` 完整对；in-flight（user 无终态）收敛为 interrupted（executeTurn 幂等落库 `turn.interrupted`，已收敛不重复）；未知 eventSchemaVersion 与工具等不支持类型跳过；文本按 `maxContextTokens` 预算从最近往旧保留完整对（至少保留最近一对）。恢复上下文经 `ConversationRuntime.prompt(text, { history })` 以 `PromptInput.retrieval` 注入（context=历史全文、reference=摘要）。executeTurn 增加 spec 26.4 的 RuntimeSpec hash 重算校验（不一致拒绝启动 Runtime）——**测试 fixtures 的 runtimeSpecHash 必须用真实 hash**（`specHash(buildSpec(...))`），伪占位符会导致 503。
- **Control HTTP 幂等**（TASK-013）：写操作接收 Idempotency-Key，复用 idempotency_records（operation=路由操作名）；同 key 同 hash → replay 原响应；同 key 不同 hash → 409；running 未过期 → 409；校验失败（400/413）在 claim 前发生，不落槽。
- **激活/回滚/停用**（TASK-012，27.3 + PD-04）：`publishedApps.transitionVersion` 事务内 `SELECT ... FOR UPDATE` 锁 app 行 → 校验目标版本属于本 App 且 ready → 翻转指针（activate 同时置 App active；rollback 只改指针、status 保持 active、历史 RuntimeSpec 永不复制/修改）；suspend 只置 suspended 不改指针；每个操作追加 audit_events（13.4），actor=platform_admin/tenant。并发 activate 串行化，无丢更新。
- **migration 只前进**：已部署环境不修改旧文件；build 脚本会拷贝 migrations 进 dist。
- 新增依赖必须固定精确版本、`npm install --ignore-scripts`（AGENTS.md + 依赖评审记录）。

### 已知限制 / 未决项

- S3 适配未连真实 MinIO 验证（TASK-030 附件链路联调时处理）。
- `npm audit` 3 个 high 漏洞来自**既有**传递依赖（minimatch/nanoid/undici），非本次引入，留待安全任务。
- lockfile 新增 `@skdy/avatar` 条目是既有 `file:` 引用的补齐（HEAD 的 web/package.json 已引用但 lockfile 未同步），与发布 MVP 无关，保留。
- **本机环境 2026-08 起无法复现完整开发环境**：`models.dev` 不可达 → `packages/ai/src/providers/data/*` 无法 hydrate → `@earendil-works/pi-ai`/`pi-coding-agent` 等 workspace 包无 dist → `test/web-start.test.ts` 与 `test/publishing/control-compose.test.ts`（以及一切运行时 import workspace 包的测试）在本环境**无法运行**。它们的类型正确性由根 `tsgo --noEmit`（paths 映射到 src，server 包 0 错误）与 biome 覆盖；`web-start` 的 config 断言与 `control-compose` 的 config() helper 已按新字段同步更新。恢复方法：网络可达后 `npm run hydrate:model-data` + `npm run build`（root 顺序）。
- **本地依赖容器已重建**：原 `backend-db-1`/`backend-redis-1` 在本机 docker 环境不存在，已按交接参数重建——`postgres:16-alpine`（5433，skdy/skdy123，`skdy_agent_test`）与 `redis:5.0.5`（6380）。与文档记载的 PG15/Redis7 版本有差异，行为等价（测试仅用 SQL/基本 Redis 语义）。
- Exchange 端点（`/api/embed/v1/exchange`）**尚未挂进 startWebServer**：等 embed/start.ts 组合任务统一挂载，并在那时校验 `PI_EMBED_SUBJECT_PEPPER` 与 Access Token 密钥文件缺失即启动失败。

## 三、已完成任务明细

### TASK-000 功能开关
- `publishing/config.ts` 解析 `PI_PUBLISHING_ENABLED`（默认 false，非法布尔启动失败）；`start.ts` 增加 publishing 选项，关闭时不建任何新连接，现有路径不变。
- 测试 `test/web-start.test.ts`（12 passed）。基线：WS `/api/pi/v1/ws`、上传 `/api/pi/v2/uploads`（25 MiB/10 个）、Citation、语音由 `PI_VOICE_*` 驱动。

### TASK-001 领域 ID/状态/错误
- 12 种 branded ID（UUIDv7 生成；**TASK-007 按 Spec 24.1 重写为裸 UUID**，前缀仅表示层）、全部状态 union；14 个错误码 → HTTP 映射；`ResourceOwner`/`ResourceScope`/`Principal`。
- 测试 `test/publishing/domain.test.ts`（13 passed）。

### TASK-002 依赖引入与评审
- 新增 `postgres@3.4.9`、`ioredis@6.0.0`、`jose@6.2.8`、`minio@8.0.7`、`zod@3.25.76`（精确版本，`--ignore-scripts`）；评审记录在 `docs/PUBLISHING-DEPENDENCIES-REVIEW.md`。
- 测试 `test/publishing/dependencies.test.ts`（5 passed）。注意 jose 6 顶层导出 `generateKeyPair`、ioredis 6 用命名导出 `Redis`。

### TASK-003 持久化客户端
- `PostgresClient`（惰性、脱敏、幂等 close、backoff 可关）、`RedisClient`（lazyConnect+首命令 connect、error 监听防 unhandled）、`ObjectStore` 接口 + `S3ObjectStore` + `LocalTestObjectStore`（路径穿越防护）。
- 测试 `test/publishing/persistence-clients.test.ts`（17 passed）。

### 阶段 A 检查点（2026-08-14）
- 开关默认关闭现有路径零改动；四个测试文件 12/13/5/17 全过；`npm run check` 全绿；允许进入阶段 B。

### TASK-004 migration runner + 0001 核心表
- `runMigrations`：单事务 + `pg_advisory_xact_lock` + `_migrations` 书签；失败原子回滚；并发只执行一次。
- `0001_publishing_core.sql`：tenants / agent_definitions / published_apps / published_app_versions（`UNIQUE(published_app_id, version_number)`）/ embed_launch_keys。
- build 脚本拷贝 migrations 进 dist。测试 `test/publishing/migrations.test.ts`（6 passed）。

### TASK-005 Principal/Conversation/Event 表
- `0002`：principals（subject 唯一按 tenant+app+type+hash）、conversations（复合外键 `(version_id, app)`、`(principal_id, app)` 防跨 App、软删除、owner 列表部分索引）。
- `0003`：conversation_events（`UNIQUE(conversation_id, sequence)`、sequence>0、复合外键）。
- 测试 `test/publishing/conversation-schema.test.ts`（11 passed）。

### TASK-006 Attachment/Idempotency/Audit 表
- `0004`：attachments（object_key UNIQUE、checksum 64、复合外键、expiry 部分索引、软删除）。
- `0005`：idempotency_records（4 列主键、state CHECK、expiry 索引）+ audit_events（追加写、request/resource 索引）。
- 测试 `test/publishing/attachment-schema.test.ts`（9 passed）。

### TASK-007 作用域安全 Repository
- `publishing/repositories.ts` 接口：Tenant/AgentDefinition/PublishedApp/PublishedAppVersion/Principal/Conversation 六类 Repository，无任何公共裸 ID 方法；`ConversationListParams` 带 opaque cursor。
- 实现 `persistence/postgres/repositories/*`：SQL 内嵌 scope（tenant/app/owner），跨作用域与缺失同返回 `undefined`；`nextEventSequence` 用 `UPDATE … RETURNING` 原子递增（Spec 26.3，禁先读后增）；`nextVersionNumber` 用 `max+1`；版本只 insert + updateStatus（不可变）。
- **ids.ts 按 Spec 24.1 重写为裸 UUIDv7**：`toPublicId`/`fromPublicId` 负责表示层前缀，`newPublicAppId()` 保留 `pub_`。
- **集成测试改造**：每个测试文件独立 schema（`pub_test_<pid>_<ts>`，`searchPath` 连接参数），并行互不冲突、afterAll 自动 drop；`PostgresClient` 新增 `searchPath` 选项。
- 测试 `test/publishing/repositories.test.ts`（13 passed，作用域隔离/游标分页/原子序列/幂等 upsert）；全量 publishing + web-start 87 passed；`npm run check` 全绿。

### TASK-008 Event 原子追加与幂等记录
- `conversation-events.ts`：`append`（事务内 UPDATE RETURNING 分配 + INSERT，回滚原子）/`list`（join conversations 校验 owner，sequence 升序增量回放）。
- `idempotency.ts`：begin（事务抢占/回收）/complete/fail/sweepExpired；`PostgresClient.transaction` + `repositories/tx.ts` 事务 helper。
- 测试 `test/publishing/event-idempotency.test.ts`（10 passed）：50 并发 append 序列连续 1..50、事务失败不增 sequence、越权 append 不可用、replay/conflict/in_progress/过期回收/并发回收唯一胜者/failed 重试。
- **阶段 B 检查点（2026-08-14）**：Event 追加与幂等语义稳定；持久 sequence 真相源在数据库（UPDATE RETURNING），无进程内计数器；重启后按 Principal Scope 恢复 Conversation 依赖 TASK-016 服务层。

### TASK-009 RuntimeSpec Schema
- `runtime-spec/schema.ts`：zod strict 校验 + 规范化（可选字段填平台默认值）；`PLATFORM_LIMITS`/`PLATFORM_DEFAULTS`；拒绝未知 schemaVersion/未知字段/越界配额/越权 capability/错误模型结构。
- **Spec 更新**：新增 5.5 平台硬上限表（数值锚定 5.4 示例与 PD-08/09/13/14）；`theme` 扩展说明（27.1 契约，不携带凭据）。
- 测试 `test/publishing/runtime-spec-schema.test.ts`（12 passed）。

### TASK-010 RuntimeSpec Compiler
- `runtime-spec/compiler.ts`：纯函数 + 显式 `CapabilityCatalog`（tools/models/knowledgeBases 白名单）；复制 prompt/model/tools/knowledge/upload/theme；只读声明字段（secret 永不进 spec）；输出 canonical JSON + SHA-256（`hash.ts`）。
- 测试 `test/publishing/runtime-spec-compiler.test.ts`（10 passed）：同输入同 hash、改草稿不变旧输出、未批准工具/模型/知识库拒绝、secret 不泄漏、spec 可被 schema 重读。

### TASK-014 Origin 策略
- `embed/auth/origin.ts`：`parseStrictOrigin` / `originAllowed` / `validateOriginList` / `buildFrameAncestors` / `isLoopbackHost`。
- 接入：`ControlService.createPublishedApp` 保存前校验 allowedOrigins（27.1，非法 400）；后续 Exchange/Realtime（TASK-015+）复用 `originAllowed`。
- 测试 `test/publishing/origin-policy.test.ts`（23 passed）：大小写、默认端口、伪造子域、`null` Origin、非法 URL、允许/拒绝列表、CSP 生成；`control-service.test.ts` 补 INVALID_ORIGINS 400 用例（control-service 36、全量 179）。

### TASK-016 Conversation Service/API
- `embed/middleware/authenticate.ts`：`createEmbedAuthenticator`（Bearer → `AccessTokenService.verify` → `EmbedAuthContext`；缺失/无效 TOKEN_INVALID、过期 TOKEN_EXPIRED，统一 401）。
- `embed/conversations/service.ts`：`ConversationService`（create 服务端固定 currentVersion / list cursor / get / listEvents afterSequence / archive；全部 OwnerScope）。
- `embed/conversations/http.ts`：4 端点（POST create 幂等、GET list、GET :id+events、POST :id/archive）；limit 1..100、events limit ≤200、afterSequence ≥0；query 用 Map（缺失键 undefined）。
- 测试 `test/embed/conversations.test.ts`（12 passed）：创建固定版本、客户端指定版本/owner 被忽略（库内验证 owner=token principal）、A/B 隔离、跨 App 隔离、新版本发布后旧会话仍绑 v1 / 新会话 v2、suspended 403、无版本 409、cursor 分页+归档后列表消失、增量事件恢复、401 三种、幂等 replay/conflict、400/404。
- 全量回归：embed + publishing 17 文件 194 passed、0 failed；biome 0 警告；根 tsgo --noEmit server 包 0 错误。

### TASK-017 最小 PiRuntimeAdapter
- `runtime/scope-context.ts`：ScopeContext 最小层级（含 limits 配额提示）。
- `runtime/conversation-runtime.ts`：ConversationRuntime（scope/spec/session 包装；subscribe/snapshot/prompt/幂等 close）。
- `runtime/pi-runtime-adapter.ts`：`createPiRuntimeAdapter({ createSession })`（依赖注入）；chat-only 白名单拒绝非 chat-only profile/tools/knowledgeBases；model/thinkingLevel 映射自 RuntimeSpec。
- 测试 `test/runtime/pi-runtime-adapter.test.ts`（5 passed）：独立 Runtime、模型来自各自 spec、白名单拒绝、close 幂等、prompt 转发。

### TASK-018 同步/测试用文本 Turn HTTP 路径
- `runtime/turn-executor.ts`：`TurnExecutor` + `runtimeTurnExecutor(adapter)`（open→prompt→从 snapshot.transcript 提取最后 complete assistant 文本→close）。
- `ConversationService.executeTurn`：持久化 user.message → executor → assistant.completed/turn.failed；`runningTurns` 进程内单写者（PD-13 并发 409）；turnScope 带 limits。
- `conversations/http.ts`：`POST /api/embed/v1/dev/conversations/:id/turn`（dev 前缀；text ≤ 32k；Idempotency-Key 幂等）。
- 测试 `test/embed/turns.test.ts`（7 passed）：成功+事件持久化、模拟重启读历史、两用户并发、同会话并发 409、幂等 replay 不重复事件、模型失败 503+turn.failed、归档后 404、401/400。
- 全量回归：embed + runtime + publishing 19 文件 206 passed、0 failed；biome 0 警告；根 tsgo --noEmit server 包 0 错误。

### TASK-019 Embed Web 壳和匿名 Bootstrap
- server：`embed/bootstrap-http.ts`（GET /api/embed/v1/bootstrap，公开主题摘要）；`start.ts`/`web/start.ts` 挂载 bootstrap handler；`embed-plane.test.ts` 补 bootstrap 用例（3 passed）。
- web（`packages/web/src/embed/`）：types/api/storage/auth-controller/conversation-controller/embed-app/embed-shell/conversation-list/error-state/embed.css；`main.tsx` 路径分流（`/embed/:publicAppId` → EmbedApp，其余 → 内部 App）。
- 测试 `packages/web/test/embed/embed-logic.test.ts`（9 passed）：visitor 稳定/清除/格式、api 信封与错误映射（APP_SUSPENDED/NETWORK_ERROR）、Bearer 头、auth 登入登出、事件推导消息、list/create/open。
- 质量门：web typecheck（tsgo）0 错误；biome 全仓 0 警告；server 全量 209 passed + web 9 passed = 218、0 failed。
- 验证限制：iframe 浏览器级演示与 CSP frame-ancestors 头（13.1）待完整环境补做（见关键决策）。

### TASK-020 EffectOwner
- `runtime/effect-owner.ts`：`createEffectOwner`（register/close；LIFO、幂等、聚合错误、close 后拒绝注册）。
- `ConversationRuntime` 资源改经 owner 注册（session dispose）；close 幂等语义保持（closePromise 缓存）。
- 测试 `test/runtime/effect-owner.test.ts`（7 passed）：LIFO 顺序、幂等同 Promise、失败不阻断+聚合、多错误聚合、close 后注册被拒、异步顺序、空 close。

### TASK-021 ConversationRuntimeManager
- `runtime/runtime-owner.ts`：`RuntimeOwner` + `createLocalRuntimeOwner`（nodeId/epoch=1，未来 Lease 边界）。
- `runtime/conversation-runtime-manager.ts`：opening 去重、active map、release、sweepIdle（Promise）、drain/close、autoSweep 周期回收（unref）。
- `runtime/turn-executor.ts` 新增 `managedTurnExecutor(manager)`；`embed/start.ts` 生产路径改用它（close -> manager.drain）。
- 测试 `test/runtime/conversation-runtime-manager.test.ts`（7 passed）：10 并发同会话只创建一次、30 会话并行独立、重复 acquire 同实例、idle 回收+重建、close 后拒绝、drain 幂等、release 刷新 TTL。
- 全量回归：server 223 passed + web 9 passed = 232、0 failed；biome 0 警告；根 tsgo --noEmit server+web 0 错误。


### TASK-022 持久事件到 Pi 上下文恢复
- `runtime/context-restore.ts`：`restoreContext`（只恢复完成对、in-flight 收敛、schema/预算过滤）+ `historyToContextText`/`historyToReference`。
- `ConversationRuntime.prompt(text, { history })`：历史经 `PromptInput.retrieval` 注入（context=全文、reference=摘要）。
- `ConversationService.executeTurn`：读事件恢复历史（limit 10000）→ in-flight 收敛落库 `turn.interrupted`（幂等）→ 传 history 给 executor；新增 RuntimeSpec hash 重算校验（spec 26.4）。
- 测试 `test/runtime/context-restore.test.ts`（8 passed）：完成对、in-flight、终态事件、未知 schema 跳过、工具事件跳过、孤立 assistant 跳过、长会话预算截断、序列化；`turns.test.ts` 补 2 个集成用例（模拟重启后第三轮收到完整历史 [0,2,4]；in-flight 收敛为 turn.interrupted 且不恢复、收敛幂等）。
- 全量回归：server 233 passed + web 9 passed = 242、0 failed；biome 0 警告；根 tsgo --noEmit server+web 0 错误。
- 注意：executeTurn 现要求 `version.runtimeSpecHash` 与重算一致；测试 fixtures 已改用 `specHash(buildSpec(...))` 真实 hash。

### TASK-023 Embed Realtime v1 Decoder
- `packages/protocol/src/embed/`：common（协议名/版本/错误信封）、realtime（ClientCommand 5 种命令 + EmbedServerEvent 11 种事件 + decodeClientCommand/decodeServerEvent 运行时 Decoder）、public-http（HTTP 契约类型归位）。
- Web `types.ts` 改为从协议包 re-export（仅保留 ChatMessage 展示类型）；`api.ts` 错误信封改用协议包 `EmbedErrorEnvelope`。
- 测试 `packages/protocol/test/embed/realtime.test.ts`（9 passed）：全部合法命令/事件、非对象、未知类型、缺/错字段、超长 text/requestId、超量附件、负数 sequence、null turnId 合法、缺失 recoverable 字段。
- 全量回归：server 233 + protocol 9 + web 9 = 251、0 failed；biome 0 警告；根 tsgo --noEmit 0 错误。

### TASK-024 WebSocket Ticket
- `embed/auth/ws-ticket.ts`：`TicketClaims`（含 principalType/tokenId）+ `createWsTicketService`（issue/consume）+ `newTicket`（256-bit base64url）+ `hashOf`。
- `persistence/redis/ticket-store.ts`：`RedisTicketStore`（SET EX + Lua 原子 get+del 单次消费）。
- `conversations/http.ts`：`POST /:id/ws-ticket`（token + 本人会话；响应 ticket/expiresAt/realtimeUrl；未配置 503）。
- `config.ts` 新增 `PI_REDIS_URL`；`composeEmbedPlane` 校验并建 Redis 连接（缺失启动失败）。
- 测试 `test/embed/ws-ticket.test.ts`（8 passed）：签发/单次消费、重放失败、过期（1s TTL）、Origin 不匹配（尝试也消耗）、Conversation 不匹配、只存 hash、HTTP 200/越权 404。

### TASK-025 Realtime Connection
- `embed/realtime/connection.ts`：`EmbedRealtimeConnection`（Ticket claims 绑定会话；turn.start 复用 executeTurn；事件带 sequence；sync 补发）；`RealtimeServices` 接口 + `conversationRealtimeServices` 适配。
- `embed/realtime/http.ts`：`createRealtimeUpgradeHandler`（ticket 消费 upgrade；失败 401/403）。
- `transports/websocket`：listener 新增 `onUnhandledUpgrade`；`startWebServer` 传入 embed upgrade；`composeEmbedPlane` 组装（Redis + ticket + upgrade + createSession 闭包建连接）。
- 测试 `test/embed/realtime-connection.test.ts`（7 passed）：turn.start 执行+持久化、并发 409、越权 1008、非法消息 1002、sync 快照、ticket 无效/重放拒绝、**断线补齐**（sync 补发 completed 且不重复）。

### TASK-026 Web Realtime 与断线恢复
- `packages/web/src/embed/realtime-transport.ts`：`EmbedRealtimeTransport`（Ticket 申请、连接、sync 订阅、指数退避重连、sequence 去重、切换会话取消旧订阅、重连不重发用户消息）。
- server：connection `handleSync` 按 lastSeenSequence 补发持久 completed（spec 9.2）。
- web/vite.config.ts 补 pi-protocol 运行时别名。
- 测试 `packages/web/test/embed/realtime-transport.test.ts`（6 passed）：连接+sync、重连不重发 turn、退避+上限、去重/乱序、跨会话忽略、切换会话；server realtime 测试补断线补齐用例。
- 全量回归：server 248 + web 15 + protocol 9 = 272、0 failed；biome 0 警告；根 tsgo --noEmit 0 错误。
- 注：embed-app 前端仍走 dev turn HTTP（TASK-033 完善 UI 时切 Realtime）；transport 层已完成并可复用。

### TASK-015 匿名 Principal Exchange
- `embed/auth/access-token.ts`：`AccessTokenService`（jose `SignJWT`/`jwtVerify`，Ed25519/EdDSA；iss/aud/kid/jti/iat/exp；`TOKEN_EXPIRED`/`TOKEN_INVALID` 区分）、`EmbedAccessKey` 类型（= jose `GenerateKeyPairResult["privateKey"]`，规避无 DOM lib 的裸 `CryptoKey`）、`loadAccessTokenKeyMaterial`（PKCS8/SPKI PEM → CryptoKey）。
- `embed/auth/principal.ts`：`anonymousSubjectHash`（HMAC-SHA256 pepper）+ `ExchangeService.exchangeAnonymous`（App 404 / 非 active 403 APP_SUSPENDED / accessMode 403 FORBIDDEN / Origin 403 ORIGIN_NOT_ALLOWED → upsert Principal（ON CONFLICT 稳定同访客身份）→ 签 Token）；features 读当前版本 RuntimeSpec capabilities。
- `embed/auth/exchange-http.ts`：`POST /api/embed/v1/exchange`（匿名模式；signed_user 400 待 TASK-028）；OPTIONS 预检 204；413（64 KiB）；请求体校验 400 且错误不回显 visitorId；requestId 回显。
- `embed/http-shared.ts`：统一 errorEnvelope / setEmbedCorsHeaders / respondPreflight / readRequestId / readJsonBody，后续 embed 端点复用。
- 仓库调整：`getByPublicAppId` 去 TenantScope（全局 UNIQUE 公开定位符，唯一无 scope 查找，见关键决策）；`repositories.test.ts` 对应用例更新。
- 配置：`config.ts` 新增 `PI_EMBED_SUBJECT_PEPPER` + `PI_EMBED_ACCESS_TOKEN_{PRIVATE_KEY_FILE,PUBLIC_KEY_FILE,KEY_ID,TTL_SECONDS}`（TTL 1..86400 整数，非法启动失败）；spec 24.2 同步补充 pepper 与规则；`web-start.test.ts` 断言更新 + TTL 非法值用例。
- 测试：`test/embed/access-token.test.ts`（6 passed：往返/版本 claim/错密钥/过期/篡改/错 audience）；`test/embed/exchange.test.ts`（15 passed：200+scope 校验、同访客稳定、跨访客/跨 App 隔离、suspended/draft/signed_user-only/未知 App/Origin 拒绝/缺 Origin、无版本 App、400 表、413、脱敏（token 与响应不含 visitorId、DB 只有 hash）、预检/405/未认领路径）。
- 全量回归：publishing 14 文件 161 passed + embed 21 passed = 182 passed、0 失败；根 tsgo --noEmit server 包 0 错误；biome 全仓 0 警告。

### TASK-013 Control Plane HTTP API
- `publishing/control/http.ts`：6 路由（import-current / create app / create version / activate / rollback / suspend）；Bearer 恒定时间认证（`token.ts` secureEqual）统一 401；requestId 回显（X-Request-Id + body）；错误统一信封 `{error:{code,message,requestId,retryable}}`；状态码 201/200/422/400/401/404/409/413；Idempotency-Key 幂等（replay/conflict/in_progress）；body ≤1MiB（413）。
- `publishing/control/token.ts`：`PI_CONTROL_ADMIN_TOKEN_FILE` 读取 + ≥32 字符校验 + 恒定时间比较；token 不写日志不返回。
- migration 0007 + SPEC 26.2/33.1 更新（平台 service principal，见关键决策）。
- 测试 `test/publishing/control-http.test.ts`（12 passed）：401 统一/错误 token、import-current 201+hash+warnings、key 幂等 replay、建 App 201（pub_/embedUrl）、ready 201 / rejected 422、阶段 C 检查点（建 App→版本→激活→publicAppId）、rollback/suspend 审计 id、404 不泄漏、400（坏 JSON/schema）、413、409 key 冲突。
- `publishing/control/source.ts`：生产 `CurrentAgentDefinitionSource`（从 AgentSessionServices 采集 systemPrompt/默认模型/白名单工具与知识库；禁 secret/文件/路径，不可映射字段 → warning）。
- `publishing/control/catalog.ts`：`buildCapabilityCatalog` —— MVP 白名单 = 当前 Agent 自身能力（扩展注册工具 + 可用模型 + skills）。
- `publishing/control/compose.ts` + `startWebServer`：publishing enabled 时读 token 文件（缺失启动失败）、连 PG + migrations + bootstrap tenant（33.1）、挂 control handler；close 关连接。
- 测试 `control-compose.test.ts`（5 passed）：token 文件缺失/db url 缺失/非法 tenant id 启动失败；完整组合可 bootstrap 并关闭；`web-start.test.ts` 补 24.2 env 解析断言。

### TASK-012 激活、停用和回滚
- `control/service.ts`：`activateApp`/`rollbackApp`（共用事务 transitionVersion + 审计 `app.activate`/`app.rollback`，metadata 含 versionId/previousVersionId）/`suspendApp`（PD-04，审计 `app.suspend`，reason 进 metadata）。
- `repositories/audit.ts`：`AuditEventRepository`（insert 追加写 + listByTenant）；`publishedApps.transitionVersion`（行锁 + ready 校验 + 指针翻转）；`ids.ts` 新增 `AuditEventId`。
- 测试 `test/publishing/activate-rollback-suspend.test.ts`（7 passed）：激活成功+审计、rejected 版本 409、他 App 版本 409、回滚只改指针且历史 spec 不变、suspend 不改指针+审计、并发激活无丢更新、跨 tenant APP_NOT_FOUND。

### TASK-011 PublishedApp/Version Service
- `control/service.ts`：`bootstrapTenant`（幂等，已存在只校验不覆盖，BOOTSTRAP_MISMATCH 409）/`importAgent`（revision 递增 + expectedSourceHash 409 + 自然幂等）/`createPublishedApp`（draft、publicAppId、theme 存 mutablePolicy、embedUrl）/`createPublishedAppVersion`（编译 → ready/rejected + validationErrors，版本号原子分配，无 update 路径）。
- **migration 0006**：`agent_definitions` 复合主键 `(id, revision)` + `source_hash` 列（修复 0001 的 id 主键无法存多 revision 缺陷）；`published_app_versions.runtime_spec/runtime_spec_hash` 可空（rejected 版本无 spec）；移除 published_apps→agent_definitions FK。
- 测试 `test/publishing/control-service.test.ts`（11 passed）：bootstrap 幂等、导入 revision 递增且旧版保留、跨 tenant agent 404、10 并发建版本号 1..10 唯一、rejected 版本带 validationErrors、草稿漂移不影响旧版、未知 revision 404。

## 四、下一步（TASK-027）

**实现 Launch Key 管理**（Control Service/API、launch-key Repository 和审计测试，前置 TASK-013）：

- 创建 keyId、公钥登记、active/retiring/revoked、轮换窗口；平台不接收宿主私钥。
- 测试：重复 keyId、过期 key、撤销、跨 App key、审计。
- 完成条件：一个 App 可在轮换期同时接受旧/新公钥；禁止继续：私钥上传或持久化到平台数据库。
- 之后 TASK-028（signed-user Exchange 与 nonce 防重放）用 Launch Key 验签 Launch Token。
