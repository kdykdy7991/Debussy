# 编排配置域最小解耦设计

状态：实施中（正式代码已迁入，部署与真实业务联调待执行）。创建日期：2026-11-03。

## 1. 目标与约束

依据用户确认及 [依赖审计](./orchestration-published-dependency-audit-2026-11-03.md)，编排拥有独立的配置事实与不可变版本，Chat 编辑/发布/停用不改变编排配置或可用性；只共享编译产物与执行能力。

不修改两个 AaaS API 路径、Run ID、异步状态机、结果查询和原文 result。继续复用 WorkItem、Dispatcher、Conversation 的执行编排、Runtime Adapter、MCP Factory、任务凭据注入及结果持久化。不引入 Deployment、Attempt、第二套调度器或 ReAct Loop。

本设计包含两项必要适配：**提前解析独立版本的配置**与**消除新执行上下文对 Chat 发布行的外键先决条件**。不能将后者掩盖为“以后处理”，也不顺势重写共享执行内核。

## 2. 核心决定：在哪里解析版本

在 `ConversationService.executeTurn()` 已校验上下文归属之后、第一次消费执行配置之前，调用一个服务端注入的配置解析接口。具体替换当前约 848～859 行的 PublishedAppVersion 读取、Agent 追溯及 spec/hash 校验，而不是在 TurnExecutor 末端覆盖 spec。

```text
Integration Token → 已授权任务 → 冻结配置引用的 WorkItem
  ↓
执行上下文归属校验（tenant + Chat App 或 Integration + principal + conversation）
  ↓
resolveExecutionConfiguration(持久化的上下文/任务引用)
  ├─ Chat 实例：读取原 PublishedAppVersion（保持原行为）
  └─ 编排实例：读取 WorkItem 冻结的 Orchestration Version
  ↓
统一 parseRuntimeSpec + canonical hash 校验
  ↓
恢复历史 / 上下文预算 / 检索门控 / Turn 审计
  ↓
现有 TurnExecutor → Runtime manager → PiRuntimeAdapter → LLM/MCP
```

`orchestration/compose.ts` 已创建独立 ConversationService 实例：在这里注入编排解析器。聊天组合默认使用原发布解析器。配置来源必须由服务端组合与数据库 source 标签共同决定，外部请求不能传 spec、版本覆盖、source 或解析器选项。

接口草图（内部契约，命名可随实现调整）：

```ts
resolveExecutionConfiguration(ownedContext, turnId): Promise<{
  source: {
    kind: "chat" | "orchestration" | "legacy_orchestration";
    ownerId: string;
    versionId: string;
  };
  runtimeSpec: unknown;
  runtimeSpecHash: string;
  audit: {
    configurationId?: string;
    configurationRevision?: number;
    requestContract?: string;
    agentDefinitionId?: string; // 仅真实 Chat 来源
  };
}>;
```

编排解析器必须校验 tenant、Integration、WorkItem、Conversation、当前 Turn 的一致性，读取 **WorkItem 的冻结版本**，不能读取 Integration 最新 active version。来源不匹配、版本缺失或 hash 错误直接失败，不回退到 Chat、当前最新配置或其他版本。

解析后的 spec 是该 Turn 的唯一配置来源：日志模型信息、上下文快照、预算、压缩、模型元信息和实际模型调用必须使用同一份。不能前半段继续用 Chat spec、最后调用才换 Task spec。对外取消和恢复同样使用编排归属校验；已提交结果恢复不调用模型。

## 3. 独立配置、版本与 Integration

仅增加两类已确认的编排事实，复用现有任务对象，不增加 Run 表。

| 存储语义 | 最小内容与规则 |
| --- | --- |
| 编排配置定义 | tenant、id、name、enabled、draft、draft_revision；管理 System Prompt、Model/Thinking、MCP 工具选择、Skill、Context、Runtime Policy |
| 编排不可变版本 | tenant、id、configuration_id、version_number、source_draft_revision、完整 snapshot、runtime_spec、hash、created_at；编译成功后只读，不更新配置内容 |
| Integration | 保留外部项目身份、Token 哈希、enabled、凭据策略与并发 revision；增加编排 configuration_id 和 active_version_id，不再以 Chat App/Version 为配置来源 |
| WorkItem | 新任务固定编排 version_id、configuration_source、request_contract、版本/策略快照及现有加密凭据关联；复用现有状态和派工 |

分步草稿发布的边界是：保存只改 draft，发布检查草稿 revision 和 active version，编译明确的 draft 副本，成功后原子切指针。本阶段不恢复外部配置生命周期；内部控制台继续保留“保存并生效”，在同一事务内更新编排草稿 revision、复制生成不可变版本并切换指针，失败全部回滚。新管理请求同时提交 expectedRevision、expectedDraftRevision、expectedActiveVersion；旧内部调用保留原 Integration revision CAS。多个 Integration 的生效指针不能隐式批量切换。

模型、思考强度及工具选择由平台内部管理。只适配现有“Agent 编排”管理页的配置来源、创建方式、保存/发布和版本显示，不增加对外配置页，不展开 UI 风格改造。

同一配置下的版本引用、Integration/WorkItem 归属使用带 tenant 和配置/接入关系的外键或等效事务校验。不得取消现有隔离来节省迁移工作。历史 PublishedApp 字段允许为旧记录保留，新编排字段不能与旧来源同时生效。

## 4. 编译：复用纯编译器，不复用 Chat 发布服务

已核对 `compileRuntimeSpec()` 是显式输入的纯编译器，不要求数据库中存在 AgentDefinition 或 PublishedAppVersion；其版本标识参数及 schema 目前是非空字符串。可以复用产物结构。

编排编译路径：

```text
编排 draft 的完整配置及明确 MCP/Skill Revision 引用
  → 验证模型目录、模型参数、资源同租户归属、启用状态和权限
  → 读取已冻结的 Skill/MCP revision 与工具清单（复用现有资源仓库）
  → 编译器输入 DTO（仅编译参数适配，不持久化为 AgentDefinition）
  → compileRuntimeSpec()
  → 编排 Version.runtime_spec + hash
```

禁止调用 `ControlService.saveAgentRevision()`、`createPublishedAppVersion()`、`publishAgent()`。现有 `resolveAgentRevisionConfig()` 通过 AgentRevision 绑定读取资源，不能直接作为新事实来源；复用其中资源校验/快照逻辑时需让输入来自编排显式引用，不传伪 Agent ID。

首期保持 RuntimeSpec JSON 结构：沿用旧字段名 `publishedAppVersionId` 作为编译产物的技术版本键，值使用独立编排版本命名空间，例如 `orv_<UUID>`。这是对共享产物的技术适配，不生成同 ID 的 Chat 数据行，不使用 pav_ 冒充 Chat 发布版本。hash 包含该值，缓存键及 Skill 目录与编排版本一一对应。

运行 scope 必须有可识别的配置来源和真实版本/归属 ID；内部旧字段如需映射，集中在一个适配处并补齐类型语义，不能仅用 TypeScript 强制断言把 Integration 伪装成 Chat App。新 MCP 审计应记录真实编排版本/来源，不将新版本写成 Chat 归属。

Task 配置不开放聊天 UI 开关。共享产物仍保留 schema 要求的 capabilities 默认值，不通过这些默认值控制 Task 准入。当前 Runtime 对内置工具、知识库及 profile 的既有限制保持，配置发布应提前拒绝暂不支持的能力，不在本阶段扩展 Runtime 能力。

## 5. 必要的存储与归属适配

选用**在现有内部上下文存储中增加明确的编排分支**，继续使用已有事件、计数、摘要和恢复机制，不复制第二套 ConversationService。

| 位置 | 首期改动边界 |
| --- | --- |
| 内部 Conversation | 新增明确 source 和 Integration/编排版本引用；新编排上下文不要求非空 Chat App/Version 外键；旧 Chat 分支保留原约束 |
| 执行 Principal | 独立编排 service principal 绑定 Integration；保留 Chat principal 与平台 service principal 原有类别/唯一性；不得共用一个无归属的通用主体 |
| Event、Summary | 新记录保留 tenant、conversation、owner、来源一致性；Chat App 引用在 Chat 分支必需，在编排分支不作为准入条件；仍使用原序列分配/追加/摘要实现 |
| OwnerScope/查询 | Chat 查询使用 tenant+app+principal；编排查询使用 tenant+integration+principal；均匹配 conversation 来源，不能把 app 条件简单删掉变成裸 ID 查询 |
| Reasoning | 编排按冻结版本参数执行，不开放外部会话级 effort 修改；新编排读取不依赖 Chat reasoning 行。旧 Chat 路径不变 |
| Runtime cache/Skill | 使用真实编排版本技术键，保留既有版本不一致重建和资源目录隔离算法 |
| 审计/用量 | 历史事件不改写；新编排不再经 Chat 版本归入 Chat Agent 用量；按编排来源统计或明确排除 Chat 统计，不伪装归属 |

数据库约束使用带 source 的互斥条件与复合引用：Chat 分支必须有原 App/Version；编排分支必须有 Integration/编排版本，不能同时设置两套配置事实。必须同时考虑旧平台 service principal 的空 App 规则（迁移 0007），不能用“App 为空都是 Task”误分类。

具体 DDL、索引和受影响仓库方法在编码前以隔离 schema 先做最小验证；未验证前不宣称外键可以安全放宽。这是必要的持久化适配，不是新增 Runtime 或取消权限边界。

不选方案：

| 候选 | 不采用原因 |
| --- | --- |
| 仅在 TurnExecutor 替换 spec | 上下文处理已提前读取 Chat Version，且 Chat 外键与状态门控仍存在 |
| 为每个编排版本创建隐藏 Chat Agent/PublishedVersion | 违反不写 Chat 修订、不生成 Chat 发布版本的红线，继续造成生命周期耦合 |
| 每次调用允许客户端传完整 RuntimeSpec | 失去平台能力控制与可信版本冻结，不能以输入代替授权 |
| 新建一套任务执行器/事件存储 | 重复已验证的上下文、恢复和工具链，扩大范围 |

## 6. Run 接受、派工与执行

接受任务时在现有事务内：校验 Integration/编排自身启用状态 → 幂等检查 → 读取接入生效编排版本 → 校验资源及凭据策略 → 创建 WorkItem/内部上下文与派工 → 固定版本、契约、settings、凭据有效期。新接受路径不查询 Chat PublishedApp 状态。

Dispatcher 仍 claim 并调用现有 service.execute()；其 Chat active 检查替换为编排自身准入，不重写队列和状态机。编排能力或 Integration 的停用可以影响编排可用性，Chat 停用不能影响。共享 MCP/Skill 自身被停用是资源治理，继续按原规则处理。

`input_v1` 使用编排 Version 的业务 System Prompt，JSON input 按确定性序列化转为任务消息。`legacy_prompt` 由同一个提前配置解析边界从冻结 prompt 生成该 Run 的有效 spec，再计算/校验执行 hash，供上下文与 Runtime 一致消费；不能继续到末端才覆盖。基础编排版本仍不变，记录 base_version 与有效执行配置 hash，明确 hash 对应哪个对象。

只查询已冻结版本；后续发布不漂移。版本缺失/损坏、隔离不匹配、凭据过期/缺失是明确失败，不调用 Chat 当前配置兜底。取消、执行超时、迟到结果保护、恢复已提交 Turn 仍沿用原机制。

## 7. 请求契约与历史

路径不变：POST `/api/aaas/v1/integrations/{integration_id}/runs`；GET `/api/aaas/v1/runs/{run_id}`。

新推荐请求：

```json
{
  "input": {"ticket_id":"TK001","alarm_id":"ALM001"},
  "credentials": {"authToken":"<本次业务密钥>"}
}
```

input 第一版为通用 JSON 对象，保留当前请求体大小/字段隔离限制，不引入 input_schema/output_schema。没有任务凭据映射时 credentials 可省略；平台内部仍默认授权 30 分钟，幂等重投不续期。

| 接受契约 | 固定语义 |
| --- | --- |
| input_v1 | 编排版本系统规则 + input 任务消息，不覆盖系统提示词 |
| legacy_prompt | 兼容窗口内保留旧 prompt 系统覆盖语义，标记 deprecated；只记接入 ID/契约类型等元数据，不记录秘密或完整正文 |
| input 和 prompt 同时提供 | HTTP 400；不设置优先级 |

WorkItem 持久化 request_contract，与 configuration_source 分开；前者决定输入解释，后者决定冻结配置来自编排还是历史发布快照。不能用输入看起来像 JSON 来判定。

历史分类依据接受时已存在的可靠事实：task_prompt 非空为旧覆盖语义；早期 AaaS 且无 task_prompt 标为 legacy_input；旧事件工作标为 orchestration_event。它们不能全部标为新 input_v1。不修改历史版本、结果、状态或 ID；缺少证据的历史分类明确保留未知，不猜测。

新接受请求的幂等 hash 包含契约和规范化有效请求。历史已接受请求的重投仍按该记录原 hash 规则验证，不改写原 hash、不自动创建第二个 Run；迁移测试须覆盖当前 legacy_prompt 客户端的原请求重投。对无法可靠辨认的早期格式，不以猜测算法放行。

GET 的 agent_version 字段名可继续保留，但新 Run 返回真实编排版本标识，历史 pav_ 值保持；这是返回值语义迁移，要在指南中说明，不伪称 API 契约完全不变。result 仍为原文 string/null。

## 8. 现有接入的切换

不设置长期 Chat 关联，也不让新建编排强制从 Chat 复制。对已经存在的接入允许**一次性、显式迁移**：读取其当时固定版本的完整快照，保存为独立编排配置/版本，管理员核对后原子切换 Integration。来源只作为迁移记录，后续编辑不再读取或写回 Chat。此为存量迁移，不是新产品的继承机制。

旧排队/执行中任务继续按原冻结来源解释；为读取历史事实可以保留明确的 legacy 分支，但不能读取 Chat 最新版本或用新 input 语义解释它们。Chat 当前 active 状态不应成为任务 gate；确实缺失历史冻结数据时明确失败，不能改绑新版本掩盖缺失。

执行 Token、Integration ID、Run ID 和两个 API 路径保持。双契约窗口在代码启用后才开始，对方完成迁移再约定截止时间；本设计不指定未经确认的下线日期。测试台和主接入指南只推荐 input，含凭据的私有说明在实际上线后同步，不提前把草案当已生效接口。

外部配置页不恢复、不新增外部配置权限。内部旧保存入口要切向编排发布逻辑，不能保留一个仍写 Chat Revision 的旁路。

## 9. 按依赖顺序实施

1. **持久化适配最小验证**：隔离数据库验证无 Chat 行也能插入编排 Principal/Conversation/Event/Summary；跨 tenant/Integration 写入和读取均被拒绝，旧 Chat/平台 service 约束不变。
2. **编排配置与编译**：独立定义/版本仓库及管理员保存发布，复用编译器、资源目录与凭据治理。断言 Chat 两张修订/发布表零增量。
3. **提前解析端口与执行来源**：接入 ConversationService 的配置消费起点，连接真实冻结版本、有效 hash、归属 scope、缓存/Skill/审计适配。复用现有 Dispatcher/Runtime。
4. **Run 契约及存量切换**：input/legacy_prompt 分流与冻结、幂等兼容、历史读取和现有 Integration 显式迁移。
5. **现有管理页与联调资料**：去掉创建时选择 Chat Agent，显示真实编排版本；测试台使用 input；完善取消/日志入口和统计归属。不做额外 UI 重设计。

每步的失败应暴露为可定位错误；不通过退回 Chat 最新配置维持表面成功。第一步如需复制完整执行服务、绕过归属校验或制造 Chat 版本才能通过，应停止扩展并重新缩小/选择适配边界。

## 10. 验收与检查

- 无 AgentDefinition/PublishedApp/PublishedAppVersion 业务行先决条件，独立创建编排、发布、Integration、Run，真实适配器可获得正确 spec。
- 编排保存、发布成功或失败，均不新增 Chat Revision/Version、不切 Chat 当前版本；Chat 编辑/发布/停用不影响独立编排配置和可用性。
- 两个编排版本/Integration 并发运行，配置、凭据、缓存、Skill 目录及上下文不串用，越权读取失败。
- 输入、上下文预算/日志快照、实际 Session.systemPrompt 和执行 hash 来源一致，故意损坏 hash 拒绝启动。
- 发布期间创建 Run 可得到事务确定的旧或新版本；已有排队/执行/完成 Run 不漂移，结果/契约不改写。
- input_v1、legacy_prompt、双字段拒绝、旧幂等重投、过期授权和历史恢复分别测试；重启不重复调用已提交 Turn 的工具。
- 新编排用量不归入 Chat Agent；取消和后台 Session 日志仍可查，审计不伪装版本来源。
- 对相关包运行定向 Vitest、隔离 Postgres 集成、真实 Runtime Adapter/Fake Session 测试、必要浏览器回归及仓库要求检查。基线失败独立记录，不把旧专项结果当作本次实现验收。

## 11. 方案依据及待验证项

选择复用仓库纯 RuntimeSpec 编译器、Conversation 执行流程及现有资源仓库，通过早期配置解析和最小来源/归属适配补缺口。没有引入外部依赖；通用工作流平台或另一个 Agent 框架不能替代本仓库配置域和 SQL 归属关系的拆分，当前不引入。

已静态验证的关键位置：`embed/conversations/service.ts:834`（归属校验及读取配置）；`orchestration/compose.ts:55`（独立服务实例）；`publishing/runtime-spec/compiler.ts:77`（纯编译输入）；`runtime-spec/schema.ts:226`（版本键字符串）；`repositories.ts:55`（OwnerScope）；迁移 0002/0003/0007/0009/0011（上下文、主体、事件、摘要、reasoning 的约束）。完整证据见审计表。

隔离原型和正式代码迁入均已完成，见下两节。现网后端没有重启，未在现网执行 0027 或迁移接入，真实模型/MCP 的新版联调尚未执行；不能将隔离测试等同于已上线。

## 12. 原型阶段记录（2026-11-03）

实验及复现入口：[orchestration-decoupling](../../runtimes/pi/experiments/orchestration-decoupling/README.md)。独立 Vitest **8 项通过**，使用随机 schema 的真实 Postgres、当前编译器/Runtime Adapter/Runtime Manager/Skill materializer，假 Session 与 MCP transport 桩。

| 用户提出的验证 | 实测结果 |
| --- | --- |
| 没有 Chat App/Version 能否创建上下文 | 原 schema 明确拒绝；试验适配后 Chat 三张配置/发布表零行时，可存储 Integration、Principal、Conversation、WorkItem、Event、Summary；跨 tenant/Integration/principal 读写被拒绝 |
| 独立版本能否生成 RuntimeSpec | 显式配置编译成功，包括模型、System Prompt、Context、MCP/Skill 快照；不调用 Chat 发布服务；未授权模型拒绝 |
| 两条解析路径能否合流 | 同一服务源码实验副本在归属校验后解析，Chat/编排进入相同公共历史/上下文/执行/结果落库流程；任务禁止读取 Chat 配置；冻结 A 不因接入切到 B 漂移，Chat 停用不阻断任务 |
| 版本键是否正确隔离 | 真实缓存 A 复用、A→B 释放重建；Skill 目录与内容独立，同版本物化幂等；spec hash 包含版本身份；损坏 hash 在历史恢复及 Runtime 前拒绝 |

为了验证位置而不改现有接入，实验只在临时**源码副本**加入 resolver 和明确 Integration scope；生产源码、数据库和 API 未切换。实验副本仅运行转译，正式 discriminated scope/record 类型、仓库全路径、管理发布事务、历史契约及真实 MCP 联调仍需实施，不能把此次 8 项测试当成生产解耦验收。

首次实验一项上下文快照断言失败：预期遗漏了现有摘要恢复包装。改为按执行器实际收到的历史构造预期后通过，执行流程未为断言改变。由此验证快照与 Runtime 使用同一份解析配置及恢复上下文。

`npm run check` 已执行，在原有 Biome 基线失败（16 errors、16 warnings、4 infos），后续阶段未执行。没有修改这些无关问题。

据此，正式实现继续采用本设计的早期 resolver + 明确归属存储适配，不需要另建 Runtime 或在 TurnExecutor 末端替换配置。

## 13. 正式迁入记录（2026-11-03）

本阶段只迁入已验证的配置解析与持久化边界。没有新增 TaskAgent、Deployment、Attempt、Run 表、调度器或 ReAct Loop。

| 范围 | 实际落点 |
| --- | --- |
| 独立配置事实 | `orchestration_configurations` 存可变定义/草稿与 revision；`orchestration_versions` 存完整快照、source_draft_revision、RuntimeSpec/hash，数据库 trigger 禁止更新和删除版本 |
| 编译与仓库 | `orchestration/configuration-domain.ts` 从显式 Skill/MCP Revision 解析平台资源，复用 compileRuntimeSpec；不保存 AgentDefinition，不创建 Chat PublishedAppVersion |
| 解析入口 | `embed/conversations/execution-configuration.ts` 定义端口，默认走 Chat；`orchestration/execution-configuration.ts` 只读当前 owned/running Assignment 的冻结版本；同一 executeTurn 在恢复历史之前统一解析、验 hash、准备上下文 |
| 归属适配 | 0027 为现有 Principal/Conversation/Event/Summary 增加真实 Integration 维度与互斥约束；仓库 SQL 选择固定白名单归属列，保留 tenant+owner；旧平台 service 主体规则不变 |
| 冻结与契约 | WorkItem 保存编排版本和 request_contract；来源由互斥新旧版本引用及 Conversation.source 表示；input_v1 作为任务消息，legacy_prompt 在早期解析器里覆盖 prompt，记录有效执行 hash 与基础 hash |
| 幂等与历史 | 旧 event hash 原样保留并标记 version=1，新请求用含契约语义的 hash version=2；只对明确旧 hash 版本校验兼容值，不根据正文猜测；历史 Run 的版本、状态和结果不改 |
| Runtime 与审计 | RuntimeSpec 旧技术键使用真实 orv_ 标识，复用现有缓存与 Skill 目录算法；MCP 审计独立记录 Integration/编排版本，不写假 Chat version；Task 从 Chat 用量关联中自然排除 |
| 控制台 | 新建直接选择 Prompt/Model/MCP/Skill，不再选择或显示“关联 Agent”；可编辑自己的资源引用，查看实际生效版本；旧接入显示历史快照并提供显式迁移操作 |

旧接入的迁移由管理员调用 `POST /api/admin/v1/orchestration/integrations/{id}/migrate`，携带 expected_revision 和 expected_active_version。事务锁定 Integration，复制当前冻结快照形成独立版本，切换指针、增加 revision，保留 Token 和 ID；不修改任何已接受的 WorkItem/Conversation。旧外部配置授权撤销，不将它们自动升级为独立编排的编辑权限。历史配置编辑在迁移前返回 MIGRATION_REQUIRED。

内部一键保存仍有明确边界：先校验模型/资源和凭据映射，复制成新 draft revision 与不可变版本；Integration revision、可选明确草稿 revision 和 active version 均校验后生效。这里没有重新开放外部配置页，也没有新增“外部保存即生效”路径。完整的分步草稿管理页面不属于本次迁入。

### 正式测试与基线

- 新增 `test/orchestration/independent-configuration.test.ts`：真实隔离 Postgres + 当前 Runtime Adapter/Manager/MCP Factory/凭据保护器，Fake Session 与 Fake MCP transport。覆盖零 Chat 行执行、原文结果、真实凭据注入和审计落库、并发发布 CAS、版本冻结、Skill/hash/cache 隔离、两种契约、上下文快照一致性、损坏 hash 在历史恢复前拒绝、跨归属读写、Chat 编辑/发布/停用后的独立执行，以及旧 hash 重投。
- 新增 `test/orchestration/configuration-migration.test.ts`：先只运行 0001～0026，写入已有三类历史任务及结果，再真实应用 0027；断言版本/结果/hash/状态不变，契约分别归类，重复迁移无操作。这里修正了原型没有覆盖的旧工作项外键：只有独立任务的 generated execution_integration_id 参与新上下文复合 FK。
- 17 个相关服务端文件 **131 项通过**；最新编排专项 7 文件 **56 项通过**。前端 API 专项 3 项通过，前端 typecheck 通过。
- 较广回归为 19 文件、133 通过/21 失败；两个失败套件是旧 `embed/conversations.test.ts`、`embed/turns.test.ts`。对未修改的 HEAD 使用临时源码副本复跑，确认同名 21 项失败，未改变认证来放行错误测试 Token。另修正已触及 citation 测试的过期夹具：Token 固定真实已发布版本，事件预期使用现有斜杠事件名。
- `npm run check` 已执行，仍为既有 Biome 16 errors / 16 warnings / 4 infos，后续阶段被短路；独立 tsgo 为既有 9 项错误，未新增诊断。没有修补无关全仓问题。

复现正式专项：在 `runtimes/pi/packages/server` 设置测试数据库变量后运行 `node ../../node_modules/vitest/dist/cli.js --run test/orchestration`。主接入说明已更新为新 input 推荐契约，同时明确旧 prompt 保留兼容且现网尚未切换；含凭据的本机私有交接文件和 8080 测试服务保持原状。

尚待上线验证：部署新后端、管理员核对并显式迁移真实 Integration、与接入方约定 input 迁移，再做真实 Qwen/MCP 联调。不自动修改真实工单或重试历史 Run。

另行记录本轮只读排查的[两分钟超时问题](./aaas-execution-timeout-2026-11-03.md)：固定 120 秒截止与空成功 Turn 的状态传播没有混入本次配置解耦改造。
