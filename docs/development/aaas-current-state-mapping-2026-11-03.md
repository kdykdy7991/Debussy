# AaaS 最小入口：现状映射

状态：实施中

后续确认：固定 AnalysisReport 已按用户要求取消，Run.result 改为模型原文字符串，不增加 Schema 系统。以下盘点与真实联调记录保留当时事实，当前输出契约以 [原文输出规格](./aaas-raw-output-2026-11-03.md) 及接入说明为准。

创建日期：2026-11-03

用途：依据当前代码识别薄适配的复用点和缺口。用户确认后按第 8 节实现最小 Run 边界；原有盘点记录保留作为依据，不新增 Deployment、Attempt 或重构 Runtime。

## 1. 判断标准

现有能力能够通过薄适配复用时，先复用。只有现有 Conversation、WorkItem、派工语义实际限制外部任务时，才补必要字段或抽象对象。第一阶段验证：外部提交 → 获得 Run 标识 → 固定配置 → 后台复用 Agent Runtime/MCP → 保存结果 → 按 Run 标识查询。

## 2. 六项现状映射

代码路径均相对 `runtimes/pi/packages/server`。

| 关注点 | 当前实现及证据 | 复用判断与边界 |
| --- | --- | --- |
| 一次外部任务 | `src/orchestration/store.ts` 的 `accept()`：首次输入创建 WorkItem、独立 Principal、内部 Conversation、事件和派工；同事务提交 | WorkItem 最接近外部任务的持久承载，无需立即新增 Run 表。但支持后续补充和原地技术重试，不能直接宣称等同于一次执行终态固定的 Run |
| 排队与终态 | `store.ts` 的 `claim()`、`complete()`、`cancel()`；迁移 `0022_agent_orchestration.sql` | 已覆盖 queued/running/succeeded/failed/cancelled。对外可把 succeeded 投影为 completed；超时已由 failed + QUEUE_TIMEOUT/EXECUTION_TIMEOUT 表示，无需先改数据库状态机 |
| 版本冻结 | `accept()` 将 Integration 的版本、配置修订及 settings 写入 WorkItem 和内部 Conversation；`claim()` 取 WorkItem 快照；`service.ts` 的 `principal()` 传入冻结版本 | 可直接复用。配置保存通过 `saveConfiguration()` 编译精确 Revision 后更新 Integration 指针；运行中的工作继续使用原版本 |
| 异步入口与执行 | `http.ts` 的 POST `/api/orchestration/v1/events` 返回 202；`dispatcher.ts` 轮询 `claim()`，调用 `service.execute()`；`compose.ts` 接入已有 Runtime Adapter 与 MCP Factory | 异步闭环已存在，Run 入口可以调用现有接收与调度能力。当前单活动调度器、2 并发、500ms 扫描，不新增执行体系 |
| 结果保存与查询 | `complete()` 保存派工 report/error；`workItem()` 组装工作状态和最近有报告的派工；`http.ts` 的 GET `/api/orchestration/v1/work-items/:id` 按 Integration 隔离 | 可以包装查询，但需裁剪 conversationId/assignments 等内部信息。当前可能返回旧报告，必须明确 Run 对应的那一次输入和结果，不能直接整包改名 |
| MCP 与凭据 | `compose.ts` 的 `createMcpRuntimeToolFactory()` + `protectTool()`；`store.credentials()` 按 Conversation/Turn/执行状态取有效授权；`conversation-executor.ts` 在每次执行后 reset Runtime | 直接复用固定 MCP 连接认证与任务参数注入，不重复建设。相同凭据名可供多个工具使用，缺失/过期时拒绝，不能隐式降级为共享身份 |

## 3. 对象关系：当前实际承担什么

- AgentDefinition / Revision：现有 Agent 配置及修订。
- PublishedApp / PublishedAppVersion：发布载体及包含模型、提示词和 MCP allowlist 的执行快照。
- Integration：绑定一个 PublishedApp，持有独立接入凭据、生效版本指针、允许模型与任务凭据映射。已能满足一个外部项目的一条服务接入。
- Trusted Embed App：提供受信任外部系统的聊天 Embed 身份交换，当前没有与 Integration 自动关联，也没有配置页编辑/发布授权。
- WorkItem：持续工作容器；内部关联 Conversation 和多次派工，承担业务状态与查询归属。
- Assignment：已经存在的内部调度记录，承载一次输入的执行及结果。首期无需把它升级为对外 Attempt。
- Conversation：当前 Adapter 所需的执行上下文和持久事件，不作为外部系统需要管理的资源。

迁移 0022 对 `(tenant_id, published_app_id)` 设置 Integration 唯一约束，因此一个发布应用当前只能创建一个 Integration。第一接入场景可以复用；同一发布应用要提供多个互相隔离的接入凭据时，才需要调整该限制。不能把当前实现描述成已支持完整的“一个外部 App 管理多个 Publication”授权模型。

## 4. Run 标识可以如何最小映射

候选：新入口每次主动提交都创建新的 WorkItem，返回它的标识作为对外 Run 标识；完全相同的幂等重投返回原标识。具体 ID 前缀或 URL 不影响此判断，也不要求一张新的 Run 表。

成立条件：

1. 新入口不接受旧 workItemId，不提供向同一个 Run 追加输入的语义。
2. 重新分析使用新请求标识，创建新工作；相同幂等标识、不同内容仍拒绝。
3. 查询只返回该 Run 对应执行的状态与结果，不返回历史工作中任意一个最近成功报告。
4. 已完成/失败的 Run 不能因为旧补充、旧重试接口或控制台操作而重新变为 running。

第 4 点是目前不能直接改名的具体原因：`store.retry()` 会保留 WorkItem ID 并追加派工，`accept(workItemId)` 会让已有工作继续排队。实施时需要选择最小的隔离或查询投影，确保两类入口混用时 Run 终态仍稳定，再确定最终映射；这是局部语义缺口，不是重构执行内核的依据。

## 5. 当前对外边界的实际缺口

### 可先薄适配

- 提交入口：包装 `accept()`，保留 Integration 认证、事务去重、版本冻结和队列限制。
- JSON 输入：当前 `eventSchema.input` 和事件表均为字符串。首轮可以由 Adapter 将 JSON 规范序列化为执行文本，无需立即建设 Input Schema；若 API 需要查询原输入，须明确其持久保存方式。
- 业务关联：`alarmId` 目前用于标题、订阅和查询，不决定 Agent 如何推理；可在边界映射外部业务关联标识。新接口不要求调用方理解“告警”，关联标识缺省规则实施前明确。
- 状态与结果：裁剪已有查询 DTO，映射成功状态名，保留明确的错误码和接入范围校验。

### 不能只改字段名

- 一次执行的终态与结果归属：处理上一节指出的旧入口补充/重试混用。
- 输出格式：`contracts.ts`、`service.execute()`、启动恢复逻辑、`workItem()` 都使用固定 AnalysisReport 校验。首个工单业务可以沿用该格式；若要接受其他任意 JSON 结果，需要一并调整这些读写边界，不能仅删除 Prompt 约束，也不必先建设可配置 Output Schema 系统。
- 凭据语义：当前平台 Principal 一律为内部 service 身份；请求中的 key 是不透明授权值，尚未验证为某个用户的 delegated identity。无任务凭据映射时可提交 `{}`；配置了映射则必须提供对应 key。固定 MCP 连接凭据不自动替代工具参数中的业务 key。首期系统触发可以使用获准的服务 key，不强制提供用户名或用户 key；也不能声称已有完整服务/用户身份委托体系。

外部配置页与编辑授权尚未实现。它与已有 Trusted Embed 登录机制可以做后续映射，但不是当前后台闭环的前置条件。当前业务配置接口只开放提示词、允许模型和思考参数，不等于已开放 MCP 编辑等全部 Agent 配置能力。

## 6. 建议的下一小步

1. 先用已有测试服务与当前 events/work-items 接口完成真实发布 Agent、模型和 MCP 的一次闭环，记录输入、冻结版本、结果及工具侧授权验证；模拟页面验证不替代真实联调。
2. 根据联调暴露的问题补最小 Run 边界，复用当前接收、调度和执行 Adapter，明确终态隔离和结果归属。
3. 工单报告格式先沿用。接入第二种任务时再决定最小 JSON 结果模式或 Schema 的必要性。
4. 外部配置页、Webhook、独立执行核心等按实际接入需求追加。

不新增第二套 Dispatcher，不预设 Deployment/Attempt 新表，不为概念命名迁移已有数据。

## 7. 本次证据与限制

本次为代码静态映射，没有改接口、数据库或 Runtime，没有重新运行模型/MCP 或测试。既有专项测试涉及：并发事件去重、权限隔离、密钥绑定、CAS 版本冻结、补充输入、失败重试和启动恢复，见 `test/orchestration/integration.test.ts`。已有测试的存在和先前通过记录不代表通用 Run 边界或真实业务联调已通过。

## 8. 已确认的最小实施边界

- 新增 POST `/api/aaas/v1/integrations/:integration_id/runs`、GET `/api/aaas/v1/runs/:run_id`，复用 Integration Token，路径中的接入必须与凭据匹配。
- POST 必须带 `Idempotency-Key`，body 为 JSON 对象 `input`、可选 `external_ref:{type?,id}`、可选 `credentials` 和 `credential_expires_at`；不接受 workItemId、配置覆盖或 origin。提供任务 key 时必须明确有效期；无任务 key 时内部授权默认 30 分钟。同一幂等键完整请求重投返回同一 Run，主动重跑用新键。
- 追加迁移给 WorkItem 增加 `origin=orchestration|aaas`，旧数据保持 orchestration；无新增 Run/Attempt 表。AaaS 总是新建工作，旧业务和管理员补充/retry 在 Store 事务中一律拒绝 AaaS 工作；正在运行的工作可沿用已有取消操作，终态取消不覆盖 AaaS 已有终态。
- Run 标识复用 WorkItem UUID，查询只投影首次 Assignment 的状态、报告及错误；返回冻结版本、配置修订及时间，不返回 Conversation/Turn/凭据/内部派工。仅 AaaS 来源可由 Run API 查询。
- 输入规范序列化后交给原执行链路，报告沿用 AnalysisReport；无第二套 Dispatcher/Runtime，不增加通用 Schema 管理。
- 验证并发幂等、跨接入/来源隔离、旧补充/retry 拒绝、终态取消稳定、版本冻结、重启后映射、空凭据/服务 key、有效期、真实联调与既有事件流程回归。真实 Tool key 不具备时单独记录阻塞，不用模拟结果替代。

## 9. 实施与验证结果（2026-11-03）

已实现第 8 节两个接口。新增 `src/orchestration/aaas.ts` 负责请求适配，HTTP 仍在现有 handler 中挂载；Store 复用 accept/claim/complete，查询采用单次 SQL 快照投影首次派工。追加迁移 0023 标记工作来源，并在 Store 事务内阻止 AaaS 补充和原地 retry；AaaS 终态取消不覆盖已有结果。控制台对失败的 AaaS 工作隐藏旧 retry 操作。Runtime、Dispatcher 和 ReAct 实现未改。

专项：隔离 Postgres + Fake 模型的 `test/orchestration` 4 文件 28 项通过；已有 MCP 工厂回归 15 项通过；Web API 3 项通过；Web 类型检查与本轮文件 Biome 检查通过。新增覆盖参数拒绝、并发幂等、重新分析新 ID、来源/接入/租户过滤、5 种状态下的 Store 和 HTTP 补充/retry 拒绝、终态取消不回退、版本冻结、重建 Store 查询及真实 ConversationService 后台执行。原有工单补充/重试测试继续通过。

真实开发环境：使用现有“工单处理王”发布 Agent、Qwen、智慧工单 MCP 和用户提供的任务授权，执行两次只读 getAlertStats 查询：

| 入口 | 标识 | 结果 |
| --- | --- | --- |
| events/work-items | fbce8d44-43e6-4ff0-a3fa-812ee54be633 | succeeded，结构化报告已保存 |
| AaaS Run | 5d6c4283-6452-440e-99bc-8b8f0625b032 | completed，结构化报告已保存 |

两次均存在 `tool/call → tool/result` 真实 MCP 事件，toolName=getAlertStats、isError=false。新 Run 的冻结版本为 `pav_01a19b8f-4f66-7d76-8ac9-148979f4f52a`，configuration_revision=1，与接入生效快照一致；未修改真实 Agent 配置来制造版本切换，跨配置更新冻结由隔离数据库测试覆盖。真实 Run 的幂等重投返回原 ID，旧补充和 retry 返回 409 RUN_IMMUTABLE，查询状态及结果未变化。

已用原环境重启本工作区 5176/8768 开发服务加载新增路由和迁移。未修改外部测试项目代码、未创建新发布应用、未改真实业务工单、未提交或推送。授权通过不回显的终端输入，只在联调进程内存中持有；平台按原机制加密暂存至有效期。返回报告和持久事件经检查未包含该授权明文。

本机复现脚本 `/tmp/aaas-real-smoke.mjs` 需手工通过终端输入有效授权，包含特定开发进程 PID 的重启步骤，不能原样用于其他环境；脱敏证据 `/tmp/aaas-real-smoke-evidence.json`。没有执行第二用户权限范围或错误 key 的真实对照测试，因此不据此宣称完成完整委托身份验证。

全仓 `npm run check` 仍失败于既有 16 error、16 warning、4 info；单独全仓 tsgo 仍有既有 9 处诊断，本轮文件没有新增类型诊断。自动格式化的一处无关测试已撤回。专项与真实只读链路通过不代表完整发布门禁通过。
