# 编排侧 PublishedApp 依赖审计

状态：已完成（只读核对与影响分析，非解耦实现）。创建日期：2026-11-03。

## 目标与本次范围

Chat Agent 与 Agent 编排是独立上层业务模型。编排拥有自己的配置事实及不可变版本，Integration 负责外部系统身份、权限、生效版本和任务凭据策略；两边共享 RuntimeSpec 编译产物与底层 Runtime。不把现有 Chat 关联解释为目标业务关系。

本次只核对引用的写入、读取及行为影响，不新增领域对象、迁移或 Runtime 代码，不改变现有双 API、任务或历史数据。表中“首期处理”是实现边界，不代表已经实现。

当前结论：AaaS 已有独立入口和终态语义，但配置读取、版本生成、应用可用性及部分执行归属仍依赖 Chat 发布体系。不能将它们整体称为“旧审计字段”。

## 分类与判定

- **配置事实**：决定 Prompt、Model、Thinking、MCP、Tool、Skill、Context 或执行策略；必须改为编排自己的版本来源。
- **执行适配**：用于现有执行接口、数据库完整性、隔离、缓存或资源目录；可能保留桥接，但需证明不继续决定 Chat 配置和 Chat 可用性。
- **归属/审计**：记录来源及历史事实；可以保留历史值，但必须保证不会误归属、误解释，不能据字段名直接认定无运行影响。
- **混合依赖**：同一个字段有多种读者，必须按调用点分别处理。不能把归属鉴权归为“仅 trace”，不能为解耦删除租户/主体/任务隔离。

表中 C=配置、P=权限/归属校验、A=接收/执行可用性、T=追踪/展示。标为“否”仅针对该行列出的调用点，不代表全仓同名字段都无影响。

## 引用审计表：配置与生命周期

代码证据编号在文末列出；行号为本次核对定位，后续以函数名复查。

| 字段 / 调用点 | 谁写入 | 谁读取、决定什么 | C / P / A / T；仅 trace？ | 首期处理边界 |
| --- | --- | --- | --- | --- |
| 创建请求 `publicAppId` | 控制台选择已发布 Agent，提交 `publicAppId` | `createIntegration()` 解析 PublishedApp 当前版本，校验模型和 MCP 绑定；[S1]、[S2] | 是 / 是 / 是 / 是；否 | 独立编排创建不应再要求先有 Chat 发布应用；不是只删选择框 |
| `Integration.published_app_id` | `store.createIntegration()` | `accept()` 检查原应用 active/未删除；`execute()` 再检查 active；配置读取也以它定位 App；[S2]、[S3] | 是 / 是 / 是 / 是；否 | 去除对 Chat 应用状态和配置查找的控制；是否保留内部归属值需另证 |
| `Integration.published_app_version_id` | 创建时引用 App.currentVersion；保存时更新 | `snapshot()` 找源 Agent Revision；接受任务时写入 WorkItem/Conversation；[S2]、[S3] | 是 / 是 / 是 / 是；否 | 编排生效版本必须成为配置事实；旧指针不能继续决定新 Run 的配置 |
| `Integration.settings` | 管理员创建接入 | `allowedModels` 限配置保存；`bindings` 校验/注入任务凭据；`queueTimeoutMs` 限排队；接受任务时冻结；[S3]、[S14] | 是 / 是 / 是 / 否；否 | 保持编排侧职责，明确哪些属于能力版本、哪些属于接入策略；Run 保留当时快照 |
| `WorkItem.published_app_version_id` | `accept()` 从 Integration 固定 | `claim()` 生成执行身份版本，`run()` 返回 agent_version；[S3] | 是 / 是 / 是 / 是；否 | 新 Run 必须冻结编排版本；历史 Run 不改写。技术兼容引用不得冒充配置事实 |
| `PublishedApp.current_version_id` | 普通 Chat 发布的激活步骤 | 创建新 Integration 时读取；已有 Integration 不自动跟随；[S2]、[S5] | 是 / 否 / 是 / 是；否 | 独立编排不再从 Chat 当前版本初始化；不要误认为现有指针分开就已完成配置解耦 |
| `PublishedApp.agent_definition_id` + Version.source_agent_revision | Chat 发布服务 | `snapshot()` 和 `createPublishedAppVersion()` 定位 AgentDefinition 的配置、MCP、Skill 绑定；[S2]、[S5] | 是 / 是 / 是 / 是；否 | 新编排保存/编译不走这套配置来源 |
| `prepareConfigurationVersion()` | 编排内部保存；现存外部配置发布实现也复用它 | 调用同一 AgentDefinition 的 `saveAgentRevision()`，随后为同一 App 创建发布版本；[S2]、[S5]、[S15] | 是 / 否 / 是 / 是；否 | 必须替换配置写入与编译来源；不能只改加载端 |
| 编排保存产生的 Agent Revision | `saveAgentRevision()` 对相同 ID 插入 latest+1 | 管理台读 latest；普通 `publishAgent()` 也取 latest；[S5] | 是 / 否 / 是 / 是；否 | 必须停止该副作用。只是不切 Chat.currentVersion，仍会改变 Chat 最新修订及后续发布输入 |
| 编排保存产生的 PublishedAppVersion | 同一发布服务及版本仓库 | Chat 发布版本列表、编排执行、上下文配置读取；[S5]、[S6] | 是 / 是 / 是 / 是；否 | 编排发布不再生成 Chat 版本，包括不得用每次生成“影子 Chat 版本”伪装解耦 |

说明：Integration 当前有 `UNIQUE(tenant_id,published_app_id)`；一个发布应用只能有一个 Integration。它限制“同一能力开放给多个外部项目”的目标语义，需要单独列入影响，不直接在本轮改变约束。[S4]

## 引用审计表：执行适配与归属

| 字段 / 调用点 | 谁写入 | 谁读取、决定什么 | C / P / A / T；仅 trace？ | 首期处理边界 |
| --- | --- | --- | --- | --- |
| 内部 `Conversation.published_app_id` | `accept()` 创建任务上下文 | Conversation 仓库 get 按 tenant/app/owner 匹配；事件追加和历史读取也按该 scope 校验；[S3]、[S7]、[S8] | 否 / 是 / 是 / 是；否 | 是归属隔离依赖，不是纯审计；桥接需保留等价隔离，不能沿用 Chat 状态门控 |
| 内部 `Conversation.published_app_version_id` | `accept()` 固定 | `ConversationService.executeTurn()` 在 TurnExecutor 之前读取版本、解析及校验 spec hash，随后用于上下文准备、限制和模型元信息；[S9] | 是 / 是 / 是 / 是；否 | 当前明确混合。先替换真实配置解析入口，才可能保留其余兼容作用；不能仅在末端替换 spec |
| Conversation / Principal / Event 的应用与版本外键 | 表结构与 store 插入 | 数据库要求上下文、主体、事件及版本属于一致 App；[S10] | 否 / 是 / 是 / 是；否 | 外键不是运行配置，但直接限制独立新建。保留方案须证明新编排不需创建/发布 Chat Agent；不在本轮选定桥接方案 |
| `EmbedAuthContext.publishedAppId / VersionId` | `OrchestrationService.principal()` 从接入及派工生成；不是使用聊天 Token 交换 | `ownerScope()` 和执行服务建立归属；取消入口也构造相同 scope；[S2]、[S9] | 是 / 是 / 是 / 是；否 | 业务认证继续由 Integration Token 决定；内部类型可以适配，不能让 Chat 身份状态重新决定任务权限 |
| `ScopeContext.publishedAppVersionId` | ConversationService 构造运行 scope | Runtime manager 比较缓存 Runtime 的版本，不一致时重开；[S11] | 否 / 否 / 是 / 是；否 | 即使不读取配置内容，也影响能力缓存隔离；替代值必须与编排冻结版本可靠对应，不能复用一个恒定 ID 造成串配置 |
| `RuntimeSpec.publishedAppVersionId` | 当前编译器生成 | Skill materializer 用作版本资源目录；[S12] | 否 / 否 / 是 / 是；否 | RuntimeSpec 结构可继续复用，但标识映射须唯一稳定；不能因名称似发布字段就认定只用于 trace |
| Turn.start 的 agentId / agentRevisionId / runtimeSpecHash | ConversationService 从旧 Version/App 记录生成 | 记录当次执行配置来源及审计；[S9] | 否 / 否 / 否 / 是；针对这些 payload 字段是 | 历史值保留；新 Run 要记录实际编排版本/契约，不能继续把 Chat Revision 标成实际任务配置来源 |
| `mcp_call_audits.published_app_version_id` | MCP Factory 从运行 scope 写入 | MCP 调用追踪，当前调用审计表该字段无发布版本外键；[S13] | 否 / 否 / 否 / 是；针对写入点是 | 可保留历史值或增加准确来源；不能因此推导整个 scope.version 只用于审计 |
| Conversation 事件用量聚合 | 任务执行同样写 turn/end usage | 统计 SQL 经 Conversation → Version → App → AgentDefinition 聚合到 Agent；[S8] | 否 / 否 / 否 / 是；不控制执行但影响统计 | 后续需区分业务来源，避免任务用量继续算到原 Chat Agent；不是配置阻断，但不能忽略归属错误 |
| AaaS 查询 `agent_version` | `store.run()` 将冻结版本拼为 pav_ 字符串 | 对外返回、排障及客户端可能的版本识别；[S3] | 否 / 否 / 否 / 是；该投影不控制执行 | 历史响应不重新解释。新版本标识不能伪称 Chat 版本，需明确返回值语义及兼容，不因路径不变就认为契约不变 |

## 当前真实配置读取顺序

```text
Integration Token → 接入范围
  → accept() 检查 Chat PublishedApp 可用性
  → WorkItem 冻结 published version + settings + task_prompt + 加密凭据
  → Dispatcher / claim()
  → service.execute() 再检查 Chat PublishedApp 状态
  → 内部 ConversationService：归属校验 → 读取 Chat Version.runtime_spec → hash 校验
  → 恢复上下文 / 计算限制 / 记录配置及上下文 / pre-prompt guard
  → OrchestrationTurnExecutor：读取 task_prompt，覆盖业务 System Prompt
  → Shared Runtime / MCP / Tools
```

因此，把 RuntimeSpec 只在 TurnExecutor 中替换，不能完成本次解耦：前面的配置查找、上下文处理和 Chat 可用性门控仍存在。需要一个能在相关配置消费前取得编排版本产物的最小解析边界，具体接口位置待实施设计，不预设重写执行内核。[S2]、[S3]、[S9]

共享 MCP/Skill 自身的停用、删除、连接密钥轮换及工具兼容校验仍是共享资源治理，不等同于 Chat Agent 生命周期依赖。目标是 Chat 编辑/发布/停用不改变编排；不是要求 MCP 服务被停用后任务仍能使用它。[S13]

## 请求契约冻结审计

目前 `aaas.ts` 只接受 prompt，没有 input/prompt 双契约兼容。`task_prompt != null` 可判断当前这批请求采用系统提示词覆盖；`origin='aaas'` 只标记入口来源。历史上还存在 task_prompt 为空的早期 AaaS JSON 输入和旧事件任务，不能全部重新标成新 input_v1。[S3]、[S14]

新实施必须可持久辨认 input_v1 与 legacy_prompt，并让接受、派工、恢复、重试/幂等查询按冻结语义执行；可以用明确字段或同等可靠的不可变快照，但不能通过正文是否像 JSON 猜测。input 与 prompt 同时出现返回 400。旧 prompt 兼容窗口内仍覆盖系统提示词；新 input 是编排规则下的任务数据。幂等 hash 要包含契约语义，重投不更新授权截止时间，历史 Run 的来源/状态/结果不被回填改写。兼容截止时间需与实际接入方约定，本审计不虚构日期。

## 尚未证明可安全保留的部分

1. 不关联任何 Chat 发布对象时，如何满足当前 Principal/Conversation/Event 外键与 OwnerScope 接口；尚未选定桥接实现。
2. 为独立编排提供 spec 的解析边界，能否同时覆盖上下文预算、hash、日志、取消和恢复，而不只覆盖最终模型调用。
3. 技术版本标识如何同时满足缓存隔离、Skill 目录分隔、审计真实性及对外版本查询。
4. Chat 应用停用或软删除后，保留的归属引用及历史查询是否仍可用；不得仅凭读表无 status 条件推导完整链路已独立。
5. 历史编排写入 Chat Revision 的事实不回写删除；新配置接管只面向明确切换后的任务。不得把旧 Run 改绑到新版本以“清理引用”。

## 后续实现验收清单（尚未执行）

- 编排保存/发布前后 Chat Revision 数量、最新 Revision、PublishedAppVersion 数量和 currentVersion 均不变；包括失败发布路径。
- 无 Chat Agent/发布应用先决条件，也能创建独立编排配置、版本、Integration 和 Run。
- Chat 编辑、发布、停用不会改变新编排的当前版本、接收或执行可用性；归属和工具授权不因此放宽。
- 两个编排版本进入同一 Runtime 时模型/MCP/Skill/Context/Prompt 正确隔离，不靠缓存偶然工作。
- Run 冻结编排版本、请求契约、settings 与凭据策略；后续发布不改变排队/执行中及历史任务的解释。
- 新 input 与旧 prompt 的执行语义分别验证；双字段拒绝，旧请求调用方仅记录接入 ID/契约类型，不记录密钥或完整正文。
- API 路径、Run ID、异步状态、原文 result、现有 Dispatcher/工具注入/恢复能力保持；版本值、请求体及统计归属的契约变化另行明确。

## 证据索引

以下均相对仓库根目录，定位为本次核对时行号。

| 编号 | 文件与定位 |
| --- | --- |
| S1 | [orchestration-create.tsx](../../runtimes/pi/packages/web/src/admin/pages/orchestration-create.tsx) 提交 publicAppId 约 145 行；[orchestration-page.tsx](../../runtimes/pi/packages/web/src/admin/pages/orchestration-page.tsx) 名称/修订显示约 411、420 行 |
| S2 | [orchestration/service.ts](../../runtimes/pi/packages/server/src/orchestration/service.ts) createIntegration 35；snapshot 156；saveConfiguration 175；prepareConfigurationVersion 222；principal 256；execute 270；abort 315 |
| S3 | [orchestration/store.ts](../../runtimes/pi/packages/server/src/orchestration/store.ts) createIntegration 92；accept 151；上下文/快照插入 216；run 365；claim 393；credentials 435；taskPrompt 459 |
| S4 | [0022 编排迁移](../../runtimes/pi/packages/server/src/persistence/postgres/migrations/0022_agent_orchestration.sql)；[0026 task_prompt](../../runtimes/pi/packages/server/src/persistence/postgres/migrations/0026_aaas_task_prompt.sql) |
| S5 | [publishing/control/service.ts](../../runtimes/pi/packages/server/src/publishing/control/service.ts) createPublishedAppVersion 764；publishAgent 863；saveAgentRevision 1336；[Agent 仓库](../../runtimes/pi/packages/server/src/persistence/postgres/repositories/agent-definitions.ts) getLatest 285 |
| S6 | [发布版本仓库](../../runtimes/pi/packages/server/src/persistence/postgres/repositories/published-app-versions.ts) get 90；[0006 迁移](../../runtimes/pi/packages/server/src/persistence/postgres/migrations/0006_agent_definition_source_hash.sql) 改用复合 Agent Revision 主键、移除 App 对 Agent 单列旧外键 |
| S7 | [Conversation 仓库](../../runtimes/pi/packages/server/src/persistence/postgres/repositories/conversations.ts) get 97；[Principal 仓库](../../runtimes/pi/packages/server/src/persistence/postgres/repositories/principals.ts) get 64 |
| S8 | [事件仓库](../../runtimes/pi/packages/server/src/persistence/postgres/repositories/conversation-events.ts) append 86；历史读取 137；用量聚合 183 |
| S9 | [ConversationService](../../runtimes/pi/packages/server/src/embed/conversations/service.ts) executeTurn 834；版本解析/hash 848；scope 894；turn/start 913；上下文快照 937；pre-prompt guard 与执行约 1000；ownerScope 1191 |
| S10 | [0002 主体/会话迁移](../../runtimes/pi/packages/server/src/persistence/postgres/migrations/0002_principals_conversations.sql)；[0003 事件迁移](../../runtimes/pi/packages/server/src/persistence/postgres/migrations/0003_conversation_events.sql) |
| S11 | [ScopeContext](../../runtimes/pi/packages/server/src/runtime/scope-context.ts) 23；[Runtime manager](../../runtimes/pi/packages/server/src/runtime/conversation-runtime-manager.ts) acquire 95、版本比较 105 |
| S12 | [RuntimeSpec 编译器](../../runtimes/pi/packages/server/src/publishing/runtime-spec/compiler.ts) 162；[Skill materializer](../../runtimes/pi/packages/server/src/publishing/runtime/skill-materializer.ts) 38；[Pi Runtime adapter](../../runtimes/pi/packages/server/src/runtime/pi-runtime-adapter.ts) 65 |
| S13 | [MCP Factory](../../runtimes/pi/packages/server/src/publishing/mcp/runtime-tools.ts) 当前状态/密钥 130、调用审计 221；[0014 MCP 迁移](../../runtimes/pi/packages/server/src/persistence/postgres/migrations/0014_mcp.sql) 调用审计 84 |
| S14 | [AaaS 请求适配](../../runtimes/pi/packages/server/src/orchestration/aaas.ts) 7、29；[编排 TurnExecutor](../../runtimes/pi/packages/server/src/orchestration/conversation-executor.ts) 5；[编排 compose](../../runtimes/pi/packages/server/src/orchestration/compose.ts) 26；[settings 契约](../../runtimes/pi/packages/server/src/orchestration/contracts.ts) 15 |
| S15 | [现存外部配置服务](../../runtimes/pi/packages/server/src/orchestration/configuration-service.ts) publish 383；该模块代码仍存在，但当前接入的外部配置授权已停用，不作为本次新领域模型的依据 |

本次未执行任务、迁移或测试，没有验证上述后续验收不变量已经成立。新增仅为本审计文档及索引；结论基于静态代码、SQL 定义和调用链核对，不以历史专项通过替代新边界验收。
