# Agent 平台 V2 实施总计划

状态：可开发

负责人：前端 1 人、后端 1 人、总架构师 1 人

创建日期：2026-08-21

## 1. 目标

在现有发布、Embed、Coding Agent Skill 和 Usage 基础上，补齐以下端到端能力：

1. 发布 Agent 可稳定嵌入，并提供与控制台示例一致的正式 Embed SDK；
2. Agent 可绑定并调用 MCP Server，控制台可管理 MCP；
3. Agent 可绑定固定版本的 Skill，控制台可管理 Skill；
4. 单会话可查看上下文已用量、总容量和来源分项；
5. 单会话可查看输入/输出 Token、TTFT、生成速度和完整耗时；
6. 管理员可为 Agent Revision 配置模型生成参数，发布后按固定版本执行；终端对话框只允许调整思考强度。

本文负责跨角色边界与顺序。具体执行要求见：

- [前端任务单](./frontend.md)
- [后端任务单](./backend.md)
- [总架构师验收任务单](./architect-acceptance.md)

## 2. 当前基线与必须承认的限制

- Control/Data/Runtime Plane、发布版本、Embed 页面和会话事件已经存在；不重建第二套发布系统。
- 当前发布 Runtime 只接受 `chat-only`，并拒绝带 Tool/Knowledge Base 的 RuntimeSpec。
- 当前发布运行时没有可靠地按已发布版本注入 system prompt，必须先修复版本一致性。
- Coding Agent 已能发现和调用本地 Skill；控制台目前只有手填 `knowledgeBaseIds`，发布运行时不能执行它们。
- MCP 不是核心一等能力；Extension 能力不能视为 MCP 管理已经完成。
- Provider Usage 和部分事件已有 Token 数据；控制台的部分会话指标是展示占位，不得作为真实统计验收。
- Agent Revision 的 `parameters` 已收敛为 reasoning 白名单；RuntimeSpec 仍使用通用 `model.params` 承载内部固化值，但控制台和请求不能写入 sampling/generation 覆盖。

## 3. 团队边界

| 角色 | 唯一主责 | 不承担 |
|---|---|---|
| 后端 | 协议、迁移、运行时、统计采集、MCP/Skill 服务与安全 | 页面布局与交互实现 |
| 前端 | 控制台、Embed SDK、数据状态、错误与权限体验 | 自行定义服务端协议或伪造生产统计 |
| 总架构师 | 冻结契约、威胁建模、阶段验收、上线/回退裁决 | 替开发人员补实现、只看截图验收 |

每个共享 DTO 由后端提出，总架构师批准后冻结；前端基于冻结 DTO 建 mock 并行开发。协议需要变化时必须先更新本文或 ADR，不能在实现中静默漂移。

## 4. 冻结的统计口径

### 4.1 每轮性能

```ts
interface TurnMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requestStartedAt: string;
  providerStartedAt: string;
  firstOutputAt: string | null;
  completedAt: string;
  ttftMs: number | null;
  generationMs: number | null;
  totalLatencyMs: number;
  outputTokensPerSecond: number | null;
}
```

- `ttftMs = firstOutputAt - providerStartedAt`；首个可展示文本增量才算首 Token，不把 thinking、心跳或 Tool 事件算进去。
- `generationMs = completedAt - firstOutputAt`。
- `outputTokensPerSecond = outputTokens / generationMs * 1000`，不包含 TTFT。
- 无文本输出、失败或取消时允许相关字段为 `null`，不得写成 0 混入平均值。
- 会话均值只统计有值的成功轮次，同时返回样本数；控制台至少展示平均值，验收数据同时检查 p50/p95。

### 4.2 上下文快照

```ts
interface ContextUsageSnapshot {
  usedTokens: number;
  contextWindow: number;
  remainingTokens: number;
  reservedOutputTokens: number;
  usagePercent: number;
measurement: "exact" | "estimated";
  breakdown: {
    systemPrompt: number;
    skillInstructions: number;
    toolDefinitions: number;
    conversationMessages: number;
    toolResults: number;
    retrievalContext: number;
    attachments: number;
  };
}
```

快照必须在最终模型请求组装完成、发送之前生成。所有分项之和必须能解释 `usedTokens`；不可归类的内容必须增加明确字段，不得塞入 `conversationMessages` 隐藏差异。无法使用模型精确 tokenizer 时标为 `estimated`。

### 4.3 模型生成参数与暴露边界

平台采用类型化配置，不允许控制台直接编辑任意 JSON：

```ts
interface AgentModelParameters {
  reasoning?: {
    enabled?: boolean;
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  };
}
```

- 模型能力目录只公开思考开关、合法档位和默认档位。
- 保存和发布时服务端执行白名单校验；sampling/generation 和未知字段明确报错，不能静默忽略。
- 控制台只可配置 Agent Revision 的 `reasoning.enabled/effort` 默认值；其他生成参数由服务端代码或 Provider 模型定义固定。
- 管理员 Chat 与 Embed Chat 的唯一模型级覆盖是“思考强度”，且只能从当前模型声明支持的档位中选择。
- 生效优先级为：会话显式 effort 覆盖 → Agent Revision 默认 effort → Provider/模型默认。
- 会话级 effort 必须随会话持久化并可恢复，但不得改写 Revision，也不得顺带改变其他采样参数。
- 固化参数的调整必须通过服务端代码变更、测试、评审和部署完成，不能通过 Revision JSON 或浏览器请求注入。

## 5. 实施顺序与人员安排

建议工期是单人容量估算，不是对交付日期的承诺。

| 里程碑 | 后端主线 | 前端并行线 | 架构师门禁 | 建议工期 |
|---|---|---|---|---|
| M0 契约与版本一致性 | 冻结 DTO/错误码；reasoning 能力契约；迁移骨架；发布 Runtime 按版本注入 prompt | 建指标/思考设置页 mock；修正 SDK API 设计 | 批准口径、参数暴露边界、迁移、权限和回退方案 | 1 周 |
| M1 统计、参数与 Embed | 采集/查询指标；校验 reasoning 并固化其余模型参数；会话聚合接口 | 单会话指标 UI；思考设置表单；正式 Embed SDK | 用可控 Provider 验证公式、固定参数 wire payload 与版本一致性 | 3 周 |
| M2 Skill 产品化 | Skill 注册、校验、版本、绑定；发布 Runtime 加载固定版本 | Skill 列表/详情/导入/版本/绑定 UI | 校验不可变发布、安全边界和回滚 | 2 周 |
| M3 MCP 产品化 | MCP 连接、发现、健康、绑定、调用、审计和 Secret 引用 | MCP 管理、连接测试、Tool 白名单和状态 UI | 威胁模型、故障注入、租户隔离与上线批准 | 3 周 |
| M4 收口 | 全链路回归、迁移/运维文档、指标告警 | 浏览器 E2E、空态/错误/权限/响应式收口 | 最终验收与灰度/回退演练 | 1 周 |

M1 可在 M2、M3 之前单独上线。M2 和 M3 对同一发布 Runtime 有修改，在只有一名后端时必须串行。前端在每个里程碑的 DTO 冻结后使用 mock 并行，但合并前必须替换为真实接口测试。

## 6. 共享接口与数据要求

后端至少提供：

- `GET /api/control/v1/conversations/:id/metrics`
- `GET /api/control/v1/conversations/:id/context`
- 模型目录返回各参数的支持状态、范围、默认值、步长和互斥约束；Agent Revision 保存类型化生成参数；
- Skill 的列表、详情、导入、校验、版本、启停和 Agent Revision 绑定接口；
- MCP Server 的列表、详情、创建、更新、测试、同步 Tool、启停和 Agent Revision 绑定接口；
- 发布版本返回固定的 Skill 版本、MCP Server Revision 与 Tool 白名单；
- 所有写操作进入现有审计链路。

具体路径可以在 M0 调整，但响应语义、租户边界和不可变版本原则不得改变。

## 7. 跨角色完成定义

一个里程碑只有同时满足以下条件才算完成：

- DTO、数据库迁移、服务实现、页面和自动化测试均已合入；
- 前端没有生产占位指标或静态成功状态；
- 发布会话绑定的 Agent Revision、Skill Revision、MCP 配置可从审计记录追溯；
- 实际 Provider 请求使用已发布 Revision 的生成参数；终端用户只能覆盖 `reasoningEffort`，且覆盖值可恢复、可审计；
- Secret 不进入 RuntimeSpec、浏览器、日志、事件 payload 或导出文件；
- 失败、取消、重连、回滚和无权限路径有明确行为；
- 架构师已在 [验收任务单](./architect-acceptance.md) 留下证据和结论。

## 8. 公共验证命令

在 `runtimes/pi` 下执行：

```bash
npm run typecheck --workspace=@earendil-works/pi-server
npm test --workspace=@earendil-works/pi-server
npm run typecheck --workspace=@earendil-works/pi-web
npm test --workspace=@earendil-works/pi-web
npm run build:admin --workspace=@earendil-works/pi-web
npm run build:embed --workspace=@earendil-works/pi-web
```

涉及 protocol、ai 或 coding-agent 时，追加对应 workspace 的 typecheck/test。最终 M4 再运行仓库级 `npm run check` 和 `npm test`；不要把全仓检查作为每次局部迭代的唯一反馈。
