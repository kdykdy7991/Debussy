# 总架构师任务单：Agent 平台 V2 验收

状态：可开发

负责人：总架构师

创建日期：2026-08-21

## 1. 角色职责

总架构师负责把关契约、安全、可演进性和验收证据，不代替前后端开发。没有证据的“页面能打开”或“接口返回 200”不能通过验收。

## 2. 开始前必须掌握

1. [产品决策](../../product/DECISIONS.md)、[产品主流程](../../product/PRD.md) 和 [稳定技术边界](../../product/TECHNICAL.md)；
2. 发布对象关系：Tenant → Agent → Agent Revision → Published App Version → Conversation；
3. Control/Data/Runtime Plane 的信任边界和管理员/终端用户两条鉴权链；
4. RuntimeSpec 不可变、Secret 引用与实际 Secret 分离原则；
5. LLM Usage、上下文估算、TTFT、generation latency、tokens/s 的口径差异；
6. 模型采样参数的 Provider 差异、默认值语义、reasoning 互斥以及 Agent Revision/会话覆盖优先级；
7. Skill 可能携带指令、资源和可执行行为，MCP 相当于受控的远程工具执行边界；
8. SSRF、Prompt Injection、Tool schema 漂移、跨租户访问、日志泄密和供应链风险。

## 3. M0 架构门禁

编码进入持久化和运行时前，必须批准以下内容：

- DTO、错误码、事件顺序和 null/旧数据语义；
- 数据库迁移、索引、保留周期与回退方案；
- Skill Revision、MCP Revision 与 Published App Version 的固定关系；
- Secret 存储/解析/轮换边界；
- MCP 首期 Transport 范围与出站网络策略；
- 指标公式和时钟采集位置；
- reasoning 能力目录、合法档位、Provider 映射，以及“仅思考可配置、其他参数由代码固化”的边界；
- 功能开关和回退到 chat-only 的路径。

结论记录为“通过 / 有条件通过 / 不通过”，有条件通过必须有负责人和截止里程碑。

## 4. 分阶段验收场景

### M1：统计与 Embed

使用可控 fake provider：首输出延迟 300ms，随后 10 个输出 Token 用 500ms 完成。允许调度误差后，应验证 TTFT 约 300ms、生成速度约 20 tokens/s，且完整耗时单独统计。

还必须验证：

- thinking/心跳先到达时不会提前结束 TTFT；
- Tool-only、失败和取消回合的空值不进入平均数；
- 上下文分项之和与总量一致，估算值明确标记；
- 旧会话显示不可用而不是 0；
- 发布版本 prompt 修改后，旧会话仍使用固定版本；
- SDK 示例可直接运行，错误 origin 被拒绝，Token 不落盘，多实例销毁无监听器泄漏。

模型参数同时验证：

- 模型目录只暴露 reasoning capability，Agent Revision 只保存 `reasoning.enabled/effort`；
- sampling/generation、未知字段、非法 effort 和模型不支持的开关被服务端拒绝；
- 修改 reasoning 后旧发布版本和旧会话不漂移；
- 代码固化的生成参数能在捕获到的 Provider wire payload 中验证，且不能被 Revision JSON 覆盖；
- 管理员 Chat、Embed UI、Embed SDK 和直接伪造的对话请求都不能覆盖 `reasoningEffort` 之外的生成参数；
- 控制台可设置 Revision 默认 `reasoningEffort`；对话框只能调整当前模型支持的档位，会话覆盖可恢复且不改写 Agent Revision 和其他采样参数；
- 能证明优先级为“会话 reasoning 覆盖 → Revision reasoning 默认 → Provider 默认”。

### M2：Skill

- 导入合法、非法、超大、路径穿越和符号链接逃逸样本；
- 同一 Skill 更新后，旧发布版本仍执行旧 Revision；
- 禁用/删除被引用 Skill 时遵守约束，不产生悬空发布版本；
- Skill 注入能在上下文快照中单独解释；
- 租户 A 不能查看或绑定租户 B 的 Skill；
- 回退开关关闭 Skill 后，纯对话仍可用。

### M3：MCP

- 正常发现与调用、超时、断连、慢响应、超大响应、非法 schema 和服务重启；
- DNS/重定向/私网地址等 SSRF 绕过尝试；
- MCP Server 新增 Tool 后不会自动扩大已发布 Agent 的 allowlist；
- Secret 轮换后可恢复连接，旧 Secret 不出现在任意日志、事件、导出或浏览器中；
- 并发取消后无子进程、socket、promise 或会话状态泄漏；
- 跨租户 ID 枚举和调用全部失败并留下审计；
- MCP 故障不破坏已有文本对话和事件序列。

### M4：最终验收

- 从创建 Skill/MCP、绑定 Agent Revision、发布、Embed 对话、Tool 调用到会话指标查看完成一条真实 E2E；
- 执行迁移备份与恢复、灰度开启、关闭开关和应用版本回滚；
- 检查聚合查询在目标数据量下的执行计划；
- 审核告警、Runbook、数据保留、审计和故障定位字段；
- 仓库级类型检查、测试和 Admin/Embed 构建通过。

## 5. 验收证据模板

每个里程碑保存以下内容，不只保存口头结论：

```text
里程碑：
提交/构建版本：
环境与特性开关：
数据库迁移版本：
执行场景：
自动化测试命令与结果：
人工 E2E 步骤与结果：
安全/隔离检查：
性能样本与允许误差：
已知限制：
回退演练结果：
结论：通过 / 有条件通过 / 不通过
遗留项、负责人、截止里程碑：
```

## 6. 一票否决项

出现任一项不得上线：

- 发布运行时使用了未固定版本的 prompt、Skill 或 MCP Tool；
- 发布运行时静默忽略、改写生成参数，或终端对话能覆盖思考强度以外的模型参数；
- MCP Secret 出现在客户端、RuntimeSpec、日志、事件或导出中；
- 存在跨租户读取或调用；
- 控制台仍用占位数字冒充真实统计；
- 指标无法说明采集点、公式、空值和样本范围；
- MCP/Skill 故障无法通过开关隔离并回退到纯对话；
- 数据库迁移不可恢复且没有经批准的备份方案。
