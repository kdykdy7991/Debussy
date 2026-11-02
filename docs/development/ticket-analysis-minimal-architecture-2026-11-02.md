# 工单告警分析：现有能力与最小架构建议

日期：2026-11-02。状态：代码阅读后的设计建议，尚未实施或运行验收。

## 结论

在现有 Published Conversation 执行链外增加一个轻量、持久化的工作编排模块。复用 Agent Revision、Published App Version、Conversation、TurnExecutor 和 MCP Runtime。第一版支持一个工单来源、确定性准入/路由、一个工作项一个 Conversation、后台调度、任务级 Tool 凭据和结构化报告。

借鉴 DSH 的职责与生命周期，不引入第二套模型循环、会话数据库、配置系统或全量通用编排框架。Conversation 是执行上下文；分析工作项是业务真相源。

## 阅读依据与现状

- 本地文章《Super-agent 设计探索：迈向更自主的 Agent 系统》：§2 双层职责、§3 事件/订阅/上下文、§5 状态分离、§8.4 凭据隔离。
- `/home/hello/workspace/dsh-superagent-prototype/docs/001-domain.md`：Source、Trigger、Thread、Mandate、Ticket、Assignment、Subscription。
- 原型 `docs/003-execution.md` 和 `src/executor/dsh.ts`：每个 Ticket 使用稳定 Worker Session；重试/恢复产生新 Assignment，可以复用 Session。
- 当前 `runtimes/pi/packages/server/src/publishing/control/service.ts`：已有保存 Agent Revision、编译发布版本及激活能力；`publishAgent` 读取最新 revision，不能直接作为无并发控制的“保存后发布”组合。
- 当前 `embed/conversations/service.ts`：创建时固定发布版本；executeTurn 恢复历史、执行、保存结果/工具事件和用量；结果仍以 outputText 为主。runningTurns 是进程内 Set，不是持久派工队列。
- 当前 `runtime/pi-runtime-adapter.ts`：底层 session id 使用 conversationId；可注入 MCP Tool Factory。部分文件头注释仍写 chat-only 无工具，实际实现已经接入 MCP 和 Skill，应以执行代码为准。
- 当前 `runtime/conversation-runtime-manager.ts` 和 `embed/start.ts`：执行不依赖浏览器连接；完整 Turn 后重建 runtime 的组合接线已经存在。
- 当前 `docs/conversation-context-architecture.md`：Postgres 事件与 Summary 是执行上下文真相源，Pi Session 是临时内存对象。不能照搬 DSH 的本地状态存储。
- 当前 `runtime/runtime-owner.ts`：只有 LocalRuntimeOwner，isCurrent 恒真；不能视为现成的多节点租约。
- 当前 `publishing/mcp/runtime-tools.ts`：原始工具 Schema 暴露给模型，模型参数直接传给 callTool；连接密钥按 MCP Server 读取，尚无工作项级参数密钥注入。
- 当前 `embed/auth/trusted-app-http.ts`：可信系统凭据可作复用基础，但认证逻辑与 HTTP/身份交换混在一起，交换接口要求 userId/name/roles，不能直接充当无需用户信息的后台分析接口。

历史恢复不等于任务自动续跑；持久工具事件不保证外部调用恰好执行一次；模型完成不等于报告通过业务校验。

## 最小领域模型

| 概念 | 第一版实现 | 扩展边界 |
| --- | --- | --- |
| Source | 一个工单后端接入实例 | 后续增加其他来源适配器 |
| Thread | tenant + integration + app + alarmId 的事件流 | 不把 alarmId 直接当全局唯一键 |
| Trigger | 不可变 eventId、类型、内容、接收时间 | 唯一约束保证去重；重投不同内容应冲突 |
| Mandate | 工作项内冻结的分析范围、配置版本、允许工具/凭据用途 | 不必先单建授权表；与 MCP 下游 key 区分 |
| Ticket | AnalysisWorkItem，独立状态、目标、输入、报告 | 一个事件流可以存在多个独立目标 |
| Assignment | AnalysisAssignment，一次持久派工与执行结果 | 重试/恢复不改变工作项 ID |
| Executor | ConversationService 适配器 | 第一版一个工作项一个 Conversation，派工可以多次 |
| Subscription | 显式工作项—事件流绑定 | 第一版限制单绑定，后续放开多对多 |
| Report/Channel | 工作项报告版本 + 经授权的查询接口 | 后续增加 webhook/outbox |

第一版可以将 Thread 表现为事件表上的复合业务键，不要求马上建独立实体表。Subscription 单独保存关系，保留投递状态；不要把订阅永久简化成工作项上唯一 alarmId 列。

建议新增五类业务记录：analysis_events、analysis_work_items、analysis_subscriptions、analysis_assignments、analysis_credentials。报告第一版可存在 Assignment 的版本化 JSONB 字段中；一个派工最多发布一个最终报告，必要时用后续派工产生修订。凭据记录加密、带过期时间，业务记录仅保存引用。

事件、工作项、订阅/派工的创建应在事务内完成。Assignment 本身充当首期持久待执行队列，避免同时引入 Redis 消息队列和另一张内容重复的 job 表。排队内容必须显式引用具体输入事件，不能只在会话里隐式找“最新消息”。

## 执行链与代码边界

建议增加 `packages/server/src/analysis/`，包含 http、service、repositories、dispatcher、conversation-executor、report-validator；凭据解析注入 MCP 工厂，保持业务编排代码不进入 Pi 内部。

1. HTTP 校验接入方凭据与 app 范围，解析告警事件及独立 credentials 字段。
2. 同事务保存去重事件、创建/关联工作项、记录输入投递关系并创建待执行 Assignment，然后返回 202。
3. Dispatcher 原子领取 Assignment；单节点有界并发起步，同一工作项串行；保存执行代次、超时及领取者信息。
4. ConversationExecutor 找到或幂等建立关联 Conversation，使用绑定的 service principal 和冻结发布版本，调用既有 executeTurn。Conversation 关联创建也需要事务/唯一约束，避免崩溃后产生多个执行上下文。
5. 从 outputText 解析报告，执行服务端 Schema 校验；业务上“证据不足”是合法报告，非法 JSON/缺字段不是成功。校验失败可有限次纠正，仍失败则保留失败状态。
6. 保存派工终态和报告，并更新工作项状态。查询 API 直接返回持久业务记录，不从聊天文本临时提取结论。

不要在 HTTP handler 中调用后即丢弃 Promise；也不要跳过 ConversationService 只调用 TurnExecutor，否则会重复实现事件、上下文、用量和恢复逻辑。

ConversationService 当前输入耦合 EmbedAuthContext。最小改造是增加一个经过验证的内部 service 调用适配边界，使用现有 principal_type=service 表示接入系统；浏览器不能自行伪造内部执行 Scope。查询、补充输入及配置修改都按 integration/app 范围授权，不用 Tool key 充当平台登录凭据。

## 第一版事件路由

- 首次明确分析请求：确定性准入，建立工作项并订阅告警事件流，不需要常驻 Router LLM。
- 重复 eventId：返回既有处理记录，不重复派工。
- 明确指定工作项的补充信息：授权通过后记录为该工作项输入，在下一 Turn 消费；已有执行期间到达的输入先持久排队，不在第一版修改 Agent Loop 实现步间插入。
- 同一告警多个工作项时：必须显式指定目标或使用配置明确的订阅投递规则，不能随意找最新 Session。
- 技术重试：新 Assignment，继续原工作项及 Conversation。
- 明确要求全新独立分析/使用新配置：新工作项及 Conversation，仍属于相同告警事件流。
- 扩大分析目标、跨告警合并、模型判断新旧工作的语义路由暂后置，路由服务返回 create/deliver/ignore 等明确决策，后续可接入模型实现。

DSH 当前原型的已结束 Ticket 对人类消息和机器人事件有不同恢复规则；告警自动事件的唤醒规则属于本项目策略，需要明确配置，不能宣称直接复用了原型行为。

## 配置保存与发布

工单端仅允许修改提示词、模型、思考强度等白名单配置，不能持有管理员 Token。第一版一个接入配置绑定一个专用 Agent/Published App，避免改动影响其他共享应用。

服务端复用既有验证、Revision、编译、发布激活流程；必须使用本次保存的准确 revision。对接入配置增加 expectedVersion/CAS，避免保存 A 期间并发保存 B 导致 A 实际发布 B；并防止旧发布晚完成后覆盖新发布。

只有编译成功并激活才返回“保存生效”；失败保留当前有效版本，可记录新草稿和诊断。已有工作项继续冻结版本，新工作项取新版本；同时保留报告契约及凭据注入规则的版本，不能只冻结提示词。

## Tool API key

保留 MCP Server 固定连接凭据。每次工作项接受的业务 key 单独加密保存；明确绑定 tenant/integration/app/workItem/用途/有效期，可进一步限制到一次 Assignment。默认不因关联 alarmId 或订阅关系而共享。

在 Scope 中传入工作项/派工 ID 或不可公开的凭据引用，通过服务端 resolver 获取值；不要把明文放入 trustedIdentity、RuntimeSpec、system prompt、事件正文或进度对象。

工具适配按冻结的 mcpServerId + toolName + 参数路径规则工作：向模型暴露移除密钥字段后的 Schema；执行时克隆业务参数、拒绝/覆盖模型指定的密钥位置、注入密钥、按原始 Schema 校验后 callTool。第一版支持实际所需的简单顶层字段，复杂 Schema 应明确拒绝不支持的绑定，避免通用 Schema 重写范围失控。

原始密钥仅存在于传输参数中；事件仍记录模型业务参数。还要处理对方工具回显的结果/错误，不能仅靠日志 sink 脱敏。复用现有加密与日志处理思想，但独立的凭据命名空间和生命周期不能直接混用 MCP Server 密钥记录。

## 恢复与交付约束

第一版同进程启动 Dispatcher，明确只有一个活动执行进程。数据库原子领取与代次检查避免重复领取及旧执行回写；启动扫描中断 Assignment，根据已提交 Turn 和报告恢复状态。

崩溃发生在 Turn 成功之后、报告保存之前时，先从该 Assignment 绑定的 turnId 恢复输出并校验报告，而非重新调用 MCP。需要确认 turn/end 等终态持久化成功后再认为执行已提交；不能只以 executeTurn 的内存返回值为依据。

崩溃发生在外部工具完成、结果尚未落库时，平台无法独自保证恰好一次。首期告警研判优先只放行只读工具，仍要考虑重复查询费用；有副作用工具必须协商幂等键或改成可查询的外部任务。第一版不能自动重跑所有未知状态。

未来多执行节点需要跨进程租约、心跳、fencing 和 Conversation 单写者共同实现；当前进程内 Set 和 LocalRuntimeOwner 不够，不能仅靠启动多个 Dispatcher 扩容。

查询接口作为首期交付通道：分别查询工作项状态/报告、按告警列出工作项和最新报告。最新报告至少带 workItemId、reportVersion、分析输入截止位置和配置版本，避免把过时结论误认为已覆盖最新补充事件。

后续 webhook 使用持久 outbox 和对方去重机制；有结果接口的首期无需先实现推送。

## 分阶段范围与验收

第一阶段闭环：有限配置保存生效、事件去重、工作项/派工、持久排队、现有 Conversation 执行、任务级 Tool key、报告验证和结果查询。

同一阶段补齐可靠性：重启扫描、提交结果对账、排队超时、凭据过期/缺失、取消、单工作项串行、配置并发控制。后续补充输入如纳入首期，使用事件+订阅+派工服务同一链路，不创建第二套入口。

延后：常驻 Router LLM、动态多来源、模型自动跨告警归并、通用多对多上下文共享、Worker Team、Webhook、模型 Watchdog、分布式 Worker。保留接口和标识，不先建完整平台。

关键验收：重复请求只产生一份工作；重启不丢排队输入；结果已提交时不重复分析；并发工作项使用各自 key；模型/事件/报告没有密钥；无用户名也能后台提交和查询；配置失败不影响旧版本；执行途中保存新配置不改变旧工作；格式错误不被标为成功；后续事件不会被旧派工错误标记为已处理。

本次只完成静态分析，未改动运行代码、执行测试或验证当前部署。
