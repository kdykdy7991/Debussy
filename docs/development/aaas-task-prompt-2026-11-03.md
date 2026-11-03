# AaaS 按任务提供系统提示词

状态：已完成。创建日期：2026-11-03。

本文保留早期 prompt-only 阶段的事实。后续[配置域解耦](./orchestration-config-decoupling-design-2026-11-03.md)已将 input_v1 与 legacy_prompt 分开，覆盖发生在上下文准备之前；现行契约以[接入说明](../../runtimes/pi/docs/aaas-api-integration.md)为准。

用户确认将任务请求简化为顶层 prompt 字符串，作为本次任务的系统提示词，替换已发布 Agent 的业务系统提示词。模型、思考参数、MCP/工具授权、Skill 和凭据注入继续来自冻结发布版本。返回结果继续为原文字符串。本次覆盖不保存 Draft、不发布、不影响其他任务或普通聊天。

后续范围确认：对外只交付创建 Run 和查询 Run 两个 API；模型、思考强度等只由平台管理员配置。不再要求对方接入 iframe 或配置交换接口，撤销当前接入的测试配置授权，测试台移除配置入口。已实现的配置模块保留供内部实现参考，不扩展或要求对方对接。

随后简化请求：不再接受 credential_expires_at，平台内部默认设置 30 分钟任务授权，有工具凭据也不要求调用方计算有效期。幂等重投保持首次授权截止时间，不续期；下游业务密钥的真实有效期不受影响。接入文件与测试台同步移除该字段，旧 events 内部接口保持原有效期校验。

本次有效期简化回归：61 项服务端专项通过，新增断言覆盖带真实加密测试凭据的 Run 不传有效期成功、默认截止时间为接受后 30 分钟、同键重投保持原截止时间、旧有效期字段拒绝。测试台 Python 转发验证通过；含 Token 的私有接入文件同步更新且保持 0600。全仓 check 仍为既有 16 errors / 16 warnings / 4 infos。

先复用现有 orchestration TurnExecutor 薄适配和 RuntimeSpec.agent.systemPrompt，不修改共享 Runtime 或 ConversationService。迁移在 WorkItem 增加 task_prompt，接受任务时与版本、凭据和事件原子保存；执行适配器按租户/Conversation/Turn 查该任务冻结值，在内存中复制 spec 替换 systemPrompt，启动消息仅触发执行。旧事件工作及历史 Run 的空 task_prompt 继续使用其原语义，不反推旧输入为系统指令。

POST Run 新契约：prompt 为非空白字符串，最长 48000 字符；credentials、credential_expires_at、可选 external_ref 和幂等头保留。旧 input 请求拒绝，不兼容混用。请求 hash 包含 prompt，不同 prompt 复用键冲突。工具资源使用说明及 Skill 仍由共享运行时按原逻辑注入，不将调用方的提示词控制等同于扩大工具/模型权限。

验收：HTTP 参数校验、幂等、原样保存及重建 Store 后取值；两个并发 Run 的提示词隔离；适配后 spec/system role 确实覆盖且原发布 spec 不变、模型及工具不变；旧事件无覆盖；启动重载不发布真实配置，不执行付费模型。接入文档及 8080 测试台同步。

## 实施与验证

- 新增迁移 0026，在 WorkItem 冻结 task_prompt；createRun 改为严格 prompt 请求，原幂等和原子接受链路复用。OrchestrationTurnExecutor 按当前活动派工解析覆盖，仅复制执行 spec.agent.systemPrompt，并使用固定触发消息开始执行。共享 ConversationService/Runtime 未改。
- 服务端 6 文件 61 项专项通过，控制台 API 3 项通过，合计 64 项。覆盖旧 input 拒绝、空白/类型/长度校验、同键不同 prompt 冲突、原文保存与 Store 重建、精确 Turn 绑定、并发覆盖隔离，以及真实 PiRuntimeAdapter 向 Session.prompt.systemPrompt 传值；原发布 spec/model/capabilities 保持不变。
- 当前开发服务已重载并应用迁移，验证旧 input 返回 INVALID_REQUEST，新 prompt 进入原工具凭据校验；缺少工具授权的请求事务回滚，不创建任务，不调用模型。历史 Run 完整 DTO 与 Integration 版本前后不变。
- 当前接入全部活动配置授权已停用。8080 测试台移除配置页和交换接口，改为 POST Run、GET Run，仅展示任务表单、状态和 result 原文；Python 转发验证与 Chromium 页面验证通过，模拟任务响应，无真实模型调用。后端配置 Token 已从测试项目 .env 删除。
- 接入方交付文档为 [双 API 说明](../../runtimes/pi/docs/aaas-api-integration.md)。本轮 18 个编排源码/测试文件 Biome 通过、web 类型检查通过；全仓 check 仍为既有 16 errors / 16 warnings / 4 infos，全仓 tsgo 仍为既有 9 项诊断，无新增本轮诊断。代码未提交。
