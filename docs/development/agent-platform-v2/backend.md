# 后端任务单：Agent 平台 V2

状态：可开发

负责人：后端工程师

创建日期：2026-08-21

## 1. 开始前必须掌握

按顺序阅读并能向架构师解释调用链：

1. [稳定技术边界](../../product/TECHNICAL.md)：Control/Data/Runtime Plane、租户和不可变 Revision；
2. `runtimes/pi/packages/server/src/publishing`：RuntimeSpec、发布控制面与数据面；
3. `runtimes/pi/packages/server/src/runtime/pi-runtime-adapter.ts`：当前 chat-only 限制和 prompt 注入缺口；
4. `runtimes/pi/packages/server/src/embed` 与 `src/persistence/postgres`：会话事件、Usage 聚合、迁移约定；
5. `runtimes/pi/packages/coding-agent/src/core/skills.ts`：现有 Skill 发现、校验与 prompt 注入语义；
6. `runtimes/pi/packages/ai/src/utils/estimate.ts` 和 AI Usage 类型：现有估算与 Provider 返回值边界；
7. `runtimes/pi/packages/ai/src/types.ts` 的 `StreamOptions`、各 Provider adapter 与模型能力元数据：命名参数、`samplingParams` 和 Provider 差异；
8. MCP 基础：JSON-RPC 2.0、初始化/能力协商、Tool discovery/call、stdio 与 Streamable HTTP 生命周期。

必须理解：Provider 的 input token 是整个请求总量，不能直接提供 prompt/tools/messages 精确分项；分项必须在最终请求组装点计量，并标记 exact/estimated。

## 2. 执行步骤

### BE-0：契约与版本一致性

- 定义并测试总计划中的 `TurnMetrics`、`ContextUsageSnapshot`、Skill、MCP DTO 和错误码。
- 把泛型 `parameters` 收敛为仅包含 `reasoning.enabled/effort` 的白名单契约；模型目录只声明思考开关、支持档位和默认档位。
- 创建向前迁移；大表新增列优先 nullable/独立表，避免长锁。提供回退说明，不写破坏性 down migration。
- 修复发布 Runtime，使 system prompt 和能力配置来自会话固定的 Published App Version/RuntimeSpec。
- 修复发布 Runtime，使 reasoning 来自固定 Revision；其他生成参数来自服务端模型常量或 Provider 定义并传入 AI `StreamOptions`。
- 保留 chat-only 回退开关；新能力未启用时行为必须与当前一致。

交付物：协议类型、迁移、版本一致性集成测试、ADR 草案。

### BE-1：会话统计

- 在最终模型请求前生成上下文快照，不在控制台查询时重新猜测历史值。
- 在 Provider 请求开始、首个可展示文本增量、结束/失败/取消处打单调时钟时间点。
- Provider Usage 作为 input/output Token 权威值；估算只用于上下文分项，不覆盖权威 Usage。
- 持久化每轮指标，并提供单会话汇总与逐轮明细。
- 旧会话返回 `available: false` 或空样本，不伪造 0。
- 增加成功、无文本 Tool 回合、失败、取消、重试、断流和恢复测试。

交付物：真实查询接口、迁移、单元/集成测试、指标口径说明。

### BE-1B：模型生成参数

- Revision 只保存和发布 `reasoning.enabled/effort`。Temperature、Top P、Top K、Min P、Penalty、Token 上限、Seed、Stop Sequences 由服务端模型代码或 Provider 定义固定，不接受配置透传。
- 服务端对白名单、模型支持开关和 effort 档位执行校验；sampling/generation 及未知字段一律明确拒绝。
- 固化参数只由对应 Provider adapter 映射，并用请求捕获测试验证实际 wire payload。
- Revision 保存与对话请求协议都只允许受模型能力约束的 reasoning 字段。
- `reasoningEffort` 生效优先级为会话覆盖、Agent Revision 默认、Provider 默认；会话覆盖写入并恢复现有 thinking-level 会话状态。
- 审计记录参数变更与最终生效快照，但不重复记录每个 Token 事件。

交付物：模型能力契约、校验器、Runtime 透传、Provider payload 测试、版本回归测试。

### BE-2：Skill 产品化

- 建立 Skill 与 Skill Revision；原始文件、解析结果、校验诊断和内容 hash 可追溯。
- 导入时防路径穿越、符号链接逃逸、超大文件和不允许的可执行内容。
- Agent Revision 绑定明确的 Skill Revision，发布后不可漂移。
- Runtime 只加载发布版本允许的 Skill，并把实际注入量计入上下文快照。
- 不再把 Skill 仅当作 `knowledgeBaseIds`；保留旧字段兼容读取并提供迁移策略。

交付物：CRUD/校验/版本/绑定接口、Runtime 接线、安全测试和迁移说明。

### BE-3：MCP 产品化

- 建立租户级 MCP Server 与 Revision；Secret 仅保存引用，不写入 RuntimeSpec 和事件。
- 首期支持的 Transport 必须在 ADR 中明确。建议先做 Streamable HTTP；stdio 仅在部署模型和进程隔离获批后启用。
- 实现连接测试、初始化、Tool discovery、schema 快照、超时、取消、重试边界和健康状态。
- Agent Revision 固定 MCP Revision 和 Tool allowlist；运行时不得调用未发布 Tool。
- 增加 SSRF 防护、出站目的地策略、响应大小限制、并发限制、租户隔离、敏感字段脱敏和审计。
- MCP Tool 定义和结果分别计入上下文快照；调用失败不能破坏会话事件顺序。

交付物：管理/运行 API、Runtime 客户端生命周期、审计、故障注入测试和运维说明。

### BE-4：收口

- 删除会话接口中的假指标依赖，补查询索引和 explain 记录。
- 为迁移、Secret 解析失败、MCP 不可达、Skill 丢失建立可观测错误。
- 完成灰度开关和关闭新能力后的回退演练。

## 3. 后端完成标准

- 发布版本修改后，已存在会话仍使用其固定版本配置。
- 控制台 reasoning 修改只有保存新 Revision 并重新发布后才影响新版本；旧会话不漂移。
- 任意客户端篡改请求都不能覆盖 `reasoningEffort` 以外的生成参数；非法 reasoning 档位同样被拒绝。
- 统计公式能由可控 fake streaming provider 得出确定结果，误差原因可解释。
- 任意租户无法读取、绑定或调用另一租户的 Skill/MCP。
- 任意日志、RuntimeSpec、事件导出和 API 响应均不含 MCP Secret。
- MCP 超时、断连或 Tool schema 变化不会造成服务进程泄漏或跨回合污染。
- 所有接口同时覆盖成功、权限、非法状态和资源不存在。

## 4. 向前端提供的联调材料

每个里程碑开始时提供：

- 冻结 DTO 与错误码；
- 最小成功、空状态、权限失败、验证失败、服务不可用五组 fixture；
- API 调用示例；
- 能稳定复现 TTFT 和 tokens/s 的 fake provider；
- 特性开关名称与默认值。
