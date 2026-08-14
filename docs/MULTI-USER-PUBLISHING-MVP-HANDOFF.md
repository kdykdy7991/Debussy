# MULTI-USER-PUBLISHING MVP — 交接记录

> **本文件是开发交接文档**：记录「现在做到哪 + 后面接手的人需要知道什么」。
> 需求与实施规格见 `docs/MULTI-USER-PUBLISHING-MVP-SPEC.md`（TASK-000～039、数据模型、API 契约、完成/禁止条件）。
> 依赖选型评审见 `docs/PUBLISHING-DEPENDENCIES-REVIEW.md`。

## 一、当前进度

**阶段：C（管理员发布控制面），进行中。阶段 B 检查点已记录（见 TASK-008 明细）。**

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
- [ ] **TASK-015** 实现匿名 Principal Exchange ⏭ 下一步
- [ ] **TASK-016** 实现 Conversation Service/API
- [ ] **TASK-017** 实现最小 PiRuntimeAdapter
- [ ] **TASK-018** 实现同步/测试用文本 Turn HTTP 路径
- [ ] **TASK-019** 实现 Embed Web 壳和匿名 Bootstrap
- [ ] **TASK-020** 实现 EffectOwner
- [ ] **TASK-021** 实现 ConversationRuntimeManager
- [ ] **TASK-022** 实现持久事件到 Pi 上下文恢复
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
- **Control HTTP 幂等**（TASK-013）：写操作接收 Idempotency-Key，复用 idempotency_records（operation=路由操作名）；同 key 同 hash → replay 原响应；同 key 不同 hash → 409；running 未过期 → 409；校验失败（400/413）在 claim 前发生，不落槽。
- **激活/回滚/停用**（TASK-012，27.3 + PD-04）：`publishedApps.transitionVersion` 事务内 `SELECT ... FOR UPDATE` 锁 app 行 → 校验目标版本属于本 App 且 ready → 翻转指针（activate 同时置 App active；rollback 只改指针、status 保持 active、历史 RuntimeSpec 永不复制/修改）；suspend 只置 suspended 不改指针；每个操作追加 audit_events（13.4），actor=platform_admin/tenant。并发 activate 串行化，无丢更新。
- **migration 只前进**：已部署环境不修改旧文件；build 脚本会拷贝 migrations 进 dist。
- 新增依赖必须固定精确版本、`npm install --ignore-scripts`（AGENTS.md + 依赖评审记录）。

### 已知限制 / 未决项

- S3 适配未连真实 MinIO 验证（TASK-030 附件链路联调时处理）。
- `npm audit` 3 个 high 漏洞来自**既有**传递依赖（minimatch/nanoid/undici），非本次引入，留待安全任务。
- lockfile 新增 `@skdy/avatar` 条目是既有 `file:` 引用的补齐（HEAD 的 web/package.json 已引用但 lockfile 未同步），与发布 MVP 无关，保留。

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

## 四、下一步（TASK-015）

**实现匿名 Principal Exchange**（`embed/auth/principal.ts`、`access-token.ts`、Exchange HTTP、Principal Repository）：

- 校验 App active / accessMode / Origin（复用 TASK-014 `originAllowed`）；平台 HMAC/pepper 将 `(tenant, app, visitorId)` → subjectHash；upsert Principal；签发短期 Access Token；
- 测试：同访客同 App 稳定、不同 App 隔离、App suspended、Origin 拒绝、日志脱敏。
- 前置：TASK-014。
