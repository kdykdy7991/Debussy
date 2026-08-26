# Agent 平台 MVP 代码 Review

状态：实施中（review 进行中）  
创建日期：2026-08-26  
对应分支：`verify/agent-v2-m0-acceptance`（未提交）  
对应规格：`docs/development/agent-platform-mvp-2026-08-26.md`

本文档登记 MVP 实施阶段一轮代码 review 发现的问题，作为后续修复的待办底稿。所有"严重程度"是 reviewer 的判断，"严重" = 真实条件下会破规格、安全或可发布性；"次要" = 问题真实但可控。

## 1. 范围与基线

- 改动规模：63 文件，+2769 / −3812。
- 删除：整个 `docs/development/agent-platform-v2/` 文档树 + `docs/development/agent-design-workspace-rebuild.md`。
- 新增：MVP 规格、acceptance、frontend、backend 文档；`runtimes/pi/packages/server/src/publishing/mcp/` 全目录；`skill-import.ts`；`skills.ts` 仓库（pg + 内存未改动）；两个 migration（0013_skills / 0014_mcp）。
- 大改：`publishing/control/service.ts` (+964)、`publishing/control/http.ts` (+399)、`persistence/postgres/repositories/agent-definitions.ts` (+223)、`publishing/repositories.ts` (+245)。
- 协议 DTO：`admin-workbench-{agents,mcp,skills}.ts` 改写。

**未深读**：protocol DTO 三个文件的详细 diff、embed 侧 `ScopeContext` 接线、测试 fixture 完整性、迁移数据迁移策略。这几块建议另起 review。

## 2. 严重问题（建议合 PR 前处理）

### 2.1 软删除 + 密钥硬删除不查 Published App 引用 — 违反规格 §5
- `persistence/postgres/repositories/skills.ts:200-208` `softDelete` 不查 `agent_revision_skills`。
- `persistence/postgres/repositories/mcp-servers.ts:241-248` `softDelete` 不查 `agent_revision_mcp_bindings`。
- `persistence/postgres/repositories/mcp-secrets.ts:54-61` `delete` 是无条件硬删除。
- `publishing/control/service.ts:1653-1661` `deleteMcpServer` 上面三步一气呵成。

后果：被发布版本引用的 Skill/MCP Revision/secret 会被静默删除，已发布 app 在每次对话轮次都会因为 secret/skill 不可用而 fail。  
修复方向：在 service 层加 `(tenant, published_app_version)` 引用检查；或把"逻辑删除"与"secret 清除"拆成两个独立动作。

### 2.2 `skill-import.ts:186` `instructionText` 与 `sourceHash` 不一致
```ts
const instructionText = await readFile(skill.filePath, "utf8");  // 从 /tmp 重新读
...
sourceHash: createHash("sha256").update(bytes).digest("hex"),   // 来自原始 bytes
```
`bytes` 是原始输入；`instructionText` 是 `/tmp/pi-skill-import-XXX/SKILL.md` 经 `parseFrontmatter` 剥离 YAML 并可能归一化换行符后的内容。两者 hash 必然不等。  
规格 §3.3 要求"原始文件、解析结果、诊断、内容 hash 和不可变 Skill Revision 可追溯" — 这条链断了。  
修复方向：直接从原始 bytes 提取 frontmatter body，或重新定义 source-of-truth hash。

### 2.3 `service.ts:519-583` `importAgent` 缺 advisory lock + 不在事务里
并发导入同名 Agent 会从同一 `latest` 行拿到同一 `revision` 然后两次 `INSERT`。`createInitial*` 走 `pg_advisory_xact_lock` 是对的（`agent-definitions.ts:184, 218`），`importAgent` 漏了。规格的"自然幂等"承诺因此是脆弱的。  
修复方向：在 `importAgent` 入口加 `pg_advisory_xact_lock(hash(tenant, name))` 并把读+写放到一个事务里。

### 2.4 `createPublishedAppVersion` 不在事务里 + N+1
`service.ts:682-790` 顺序：读 agent revision → 读每个 skill → 读每个 MCP server + tools → 查 secret 存在性 → 然后**另一个事务**里 `createVersion`。中间任一软删除/secret 删除都会让版本 `ready` 但运行时拿不到资源。N+1 在 MCP 重 agent 上是 3-4× DB round-trip per binding。  
修复方向：包成一个事务；skill/mcp 校验改 JOIN / `ANY` 一次返回。

### 2.5 `runtime-tools.ts:39` `execute` 签名漂移
```ts
execute: async (_toolCallId, params, signal) => { ... }
```
但 `core/extensions/types.ts:480` 的 `ToolDefinition.execute` 是 5 参数（`onUpdate, ctx`）。测试用 `undefined as never` 绕过类型检查（`mcp-runtime-tools.test.ts:114, 196`）。`onUpdate` 被静默吞掉，流式 tool 结果回不到 LLM。  
修复方向：补齐 5 参数签名；测试用 mock adapter。

### 2.6 `runtime-tools.ts:70-75` 每次 tool call 都新建 MCP session
工厂是 per-conversation 的，但 connector 是 per-tool-call 调用。20 会话 × 5 tool call = 100 次 connect/close/分钟，是 MVP 容量目标（20 并发文本对话）的主要瓶颈。spec 确实说"每次 Tool 调用创建有界会话"，但 dispatcher/连接复用是必要的。  
修复方向：会话级 dispatcher 池 + 信号量限流；或换 per-conversation 会话 + 复用。

### 2.7 关键变更没有审计 — 违反 §7
这 12 个 mutation **没**写 `audit_event`：
- `createAgentDefinition` / `saveAgentRevision` / `deleteAgentDefinition`
- `createPublishedApp` / `createPublishedAppVersion` / `deletePublishedApp`
- `importSkill` / `addSkillRevision` / `setSkillStatus` / `deleteSkill`
- `createMcpServer` / `addMcpServerRevision` / `replaceMcpSecret` / `testMcpServer` / `syncMcpTools` / `setMcpServerStatus` / `deleteMcpServer`

`createLaunchKey`、`revokeLaunchKey`、`activateApp`、`rollbackApp`、`suspendApp` 那些老的反而有。新功能的核心 mutation 全部漏审计。  
修复方向：把 `setEffortWithAudit` 模式推广到所有 mutation，或抽 `withAudit(scope, action, fn)` helper。

## 3. 主要架构 / 规格合规问题

| 位置 | 问题 | 严重 |
| --- | --- | --- |
| `service.ts:711-753` | publish 前校验失败只返回 "a bound Skill revision is unavailable"，不指明 skillId/mcpServerId/toolName。验收 §6 要"具体诊断" | major |
| `service.ts:1700` | `MCP_SECRET_NOT_CONFIGURED` 同时表示"无密钥行"和"keyVersion 不匹配"，rotation bug 被错误地报成凭证缺失 | major |
| `skill-import.ts:176` | 解析器 `warning` 全部提升为 `error` 然后拒绝。`name: Bad Name`（解析器认为仅 warning）被拒。`skill-import.test.ts:55` 把这个错误行为写死成测试断言 | major |
| `compiler.ts:121-123` | "tool 名重名"和"超过 32 个 tool"两条校验顺序导致错误信息错位 | minor |
| `service.ts:1541-1581` `testMcpServer` | 所有错误归一为 `MCP_TEST_FAILED`，network policy / SDK 错误码都丢失 | major |
| `runtime-tools.ts:115` | 审计 `requestId` 始终 `null`，`ScopeContext` 没带 `requestId`。规格 §5.6 要"管理员从 Session 日志定位失败原因"关联不上 embed 端消息 | major |
| `runtime-tools.ts:32-33` | `Type.Unsafe(inputSchema)` 不校验 schema 本身是否合法 JSON Schema，DB 写脏了 runtime 跟着走 | major |
| `mcp-servers.ts:71-87` | per-tool 单条 INSERT，128 tool × N 服务器 = 数百次 round-trip | major |
| `mcp-servers.ts:148-149` | sync 出 0 个 tool 仍创建新 revision（schema 要求 `min(1)`，但 repo 让你留永久空壳）| major |
| `0013_skills.sql:50-52` | 给已有 `agent_definitions` 加 `UNIQUE (tenant_id, id, revision)`，生产数据若有重复迁移会失败 | major |
| `0014_mcp.sql:87-88` | `mcp_call_audits.conversation_id` 和 `published_app_version_id` 是 NULL，"连接测试"也进同一张表，审计链断了 | major |
| `compose.ts:95-103` | `mcpNetworkPolicy` 用默认 `{}`，没暴露 `PI_MCP_ALLOW_HTTP` / `PI_MCP_ALLOW_PRIVATE_NETWORK` 这类开发期 escape hatch，规格 §6 要求的"启动警告"也缺位 | major |
| `service.ts:1950-1985` `computeDiff` | 用 `JSON.stringify` 比较 parameters，key 顺序不同就误报 changed；应该用 `canonicalJson` | minor |
| `ids.ts:187` | `newAuditEventId` 用 `buildId("IdempotencyKey") as AuditEventId` — 类型品牌写错（typo） | minor |
| `secure-client.ts:170-180` | `secureFetch` 不防 SDK 传相对 URL 的 `Request` 对象（`new URL(input.toString())` 直接 throw）| major |
| `service.ts:1583-1637` `syncMcpTools` | `nextTools` 用 `currentRevision + 1` 预计算，但 `addRevision` 自己又自增一次，并发下可能碰撞 | minor |
| `secure-client.ts:204` | SDK 的 `reconnectionOptions.maxRetries: 0` 仅控制 connect 阶段，listTools 重新连接时的重定向没测 | major |
| `mcp-servers.ts:135-160` & `skills.ts:113-138` | revision 号在 SQL 里算然后回填，依赖 `UNIQUE` 兜底而非显式冲突处理 | minor |
| `skill-import.ts:109-144` | zip 展开按 header 限大小，fflate 全量解压到内存，zip bomb 可 OOM | major |
| `secureFetch` `redirect: "error"` | 比规格略严（规格允许"限制重定向次数"），但安全 | — |
| `pi-runtime-adapter.ts:103-114` `chatOnlyRejection` | 唯一运行时侧 gate，未来加 `chat-with-files` profile 会被静默拒 | minor |

## 4. 性能 N+1（直接影响 20 并发容量目标）

- `createPublishedAppVersion`（见 2.4）
- `listMcpServers` / `getMcpServerDetail` 每行都再 `listTools` + `mcpSecrets.has`（`service.ts:1437-1518`）
- `mcp-servers.ts` 的 per-tool INSERT
- `runtime-tools.ts` 的 per-tool DB 查询 + per-tool session open/close
- `published-app-versions.ts:160-180` `listPendingByTenant` 缺 `LIMIT`

这些叠加，文档里写的 20 并发文本对话很可能跑不到。

## 5. 测试缺口

- `mcp-secure-client.test.ts` 没测 SDK 内部 `listTools` 触发的重定向（只测了初始 connect）
- `mcp-runtime-tools.test.ts` 用 `undefined as never` 绕过 5 参数签名
- `skill-import.test.ts:55` 把"warning 被当 error 拒"这个错误行为固化成断言（应改成 warning pass）
- 没有 IPv6 (`::1`) 端到端测试（`mcp-secure-client.test.ts:42` 只测 `isPublicMcpAddress`，没测真连接）
- 没测 1.5MB 单文件触发 per-file 1MiB 限制
- 没测 abort 实际耗时（`mcp-sdk-prototype.test.ts` 慢 tool 测试不计时）
- 没测 "no `SKILL.md` 的 archive" 拒绝路径
- `parseSkillArtifact` 的 `instructionText` 一致性没断言

## 6. 文档 & 命名遗留

- **40-50 处**代码注释引用了已删的 v2 spec 段号（"spec 5.3"、"TASK-011"、"AD-05/06/07"、"WB-005"、"PD-08/09"…）。`service.ts:2`、`compiler.ts:2` 等处都还指着旧编号。删了 `agent-platform-v2/` 但没替换引用，新人无法对照。
- `agent-v2/` 目录仍在用（`agent-v2/query.ts` 等被 `service.ts:89-90` 引用）。需要明确它是"沿用旧内部名"还是"应该改名"。
- `composer` 不传 `mcpNetworkPolicy`，整体 MCP 网络策略只能在构造时改。
- `bootstrapTenant` 不检查 `mcp_secret_master_key` 是否已设置（首启 OK，后续从备份恢复会静默失败）。
- `migration` 没在多实例启动时协调（两边同时跑可能失败，需 `pg_advisory_xact_lock` 或显式幂等）。
- 删除路径里 `secretId` 每次 upsert 都重新生成但被丢弃（cosmetic）。

## 7. 推荐的修复顺序

1. **安全/数据完整性**（2.1、2.2、2.3、2.4）— 规格硬性要求 + 现状会破。
2. **审计补全**（2.7）— 验收 §7 硬性要求，影响备份恢复。
3. **N+1 修复**（2.4、4 节）— 容量目标跑得过跑不过的关键。
4. **签名漂移 + 性能**（2.5、2.6）— 运行时正确性 + 容量。
5. **替换 v2 段号引用**（6 节）— 可维护性。
6. **补测试 / DTO 同步 / 性能基准** — 验收前置。

## 8. Reviewer 备注

- 本 review 由两个 explore agent 并行执行；上文结论已合并去重。
- 引用行号以 `origin/main` 实际生产入口为准，**不是**历史 v2 计划。
- 任何修复都应同步更新 `docs/development/agent-platform-mvp-acceptance-2026-08-26.md` 中"通过条件"一节的状态。
