# Agent 模型参数控制

状态：已完成

更新日期：2026-08-21

## 1. 产品边界

管理员和对话用户仅可修改模型的思考设置：

- 是否开启思考（仅模型支持切换时展示）；
- 思考强度 `low / medium / high`。

Temperature、Top P、Top K、Min P、Penalty、最大输出 Token、思考 Token
预算、Seed 和 Stop Sequences 均不作为产品配置项。它们由服务端代码或 Provider
模型定义固定，不能通过 Agent Revision、管理员 Chat、Embed Chat 或直接构造请求覆盖。

## 2. 共享契约

```ts
interface AgentModelParameters {
  reasoning?: {
    enabled?: boolean;
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  };
}
```

公共 `ReasoningEffort` 类型保留完整运行时集合，用于读取历史值和 Provider 映射；产品
界面只展示 `low / medium / high`。模型目录中的 `ModelParameterCapabilities` 也只发布
reasoning 能力，不再发布采样、生成范围或参数 preset。

服务端保存 Revision 时执行白名单校验：

- 顶层只接受 `reasoning`；
- `reasoning` 内只接受 `enabled` 和 `effort`；
- 非法档位、模型不支持的开关，以及任何 sampling/generation 字段返回
  `INVALID_MODEL_PARAMETERS`，不得静默忽略。

## 3. 生效优先级

```text
会话 reasoning effort override
→ Agent Revision reasoning 默认值
→ 模型/Provider 默认值
```

除 reasoning 外不存在 Revision 或会话 override。生成参数的解析链是：

```text
服务端模型常量 / Provider 模型定义
→ Runtime stream options
→ Provider adapter
→ Provider payload
```

## 4. Qwen3.8 固化参数

Qwen3.8 的产品思考档位为 `low / medium / high`，默认 `high`。运行时将产品
`high` 映射为 Provider 的 `xhigh`。

思考模式固定值：

```text
temperature=1.0
top_p=0.95
top_k=20
min_p=0.0
presence_penalty=0.0
repetition_penalty=1.0
```

非思考模式固定值：

```text
temperature=0.7
top_p=0.8
top_k=20
min_p=0.0
presence_penalty=1.5
repetition_penalty=1.0
```

这些值定义在 `packages/server/src/model-parameters.ts`，不进入前端 DTO 或 Agent
Revision。`reasoning.enabled` 由 adapter 映射为
`chat_template_kwargs.enable_thinking`，解析后的 effort 映射为 `reasoning_effort`。

## 5. 后端实现

1. Protocol 只定义 reasoning 配置和 reasoning capability；
2. LLM 模型目录只返回模型支持的思考开关、档位和默认档位；
3. 保存 Agent Revision 前按白名单校验参数；
4. Revision 的 reasoning 默认值编译进不可变 RuntimeSpec；
5. Runtime adapter 合并会话思考覆盖并选择代码内的模型固定参数；
6. Coding Agent 将固定 stream options 传给每轮 Provider 请求；
7. Provider adapter 完成 Qwen wire 字段映射。

旧 RuntimeSpec 或外部 JSON 即使仍带有 sampling/generation 字段，运行时也不会使用它们
覆盖代码常量；重新保存 Revision 时会被白名单校验拒绝，需先移除旧字段。

## 6. 前端实现

- Agent 编辑页的“模型参数”收敛为“思考设置”；
- 仅展示“开启深度思考”和“默认思考强度”；
- 不再展示推荐 preset、思考 Token 上限、Sampling 或 Generation 输入框；
- 页面明确提示其他生成参数由服务端代码固定；
- 管理员 Chat 仍只允许调整当前会话的思考强度，繁忙回合不能切换；
- 管理员 Chat 不提供“其他参数”入口；
- Embed Chat 和 SDK 不接受其他模型参数覆盖。

## 7. 验收

| 场景 | 预期 |
|---|---|
| Agent 编辑页 | 只出现思考开关与低/中/高档位 |
| 模型目录 | 只返回 reasoning capability |
| Revision 提交 sampling/generation | 服务端拒绝 |
| Revision 提交非法 effort | 服务端拒绝 |
| Qwen 思考开启 | 使用代码固定的 thinking sampling 值 |
| Qwen 思考关闭 | 使用代码固定的 instruction sampling 值 |
| 产品 effort=high | Qwen 解析为 xhigh，通用模型保持 high |
| 会话修改思考强度 | 只覆盖 reasoning，不修改 Revision 或固定生成参数 |

关键代码入口：

- `packages/protocol/src/admin-workbench-agents.ts`
- `packages/protocol/src/admin-workbench-llm.ts`
- `packages/server/src/model-parameters.ts`
- `packages/server/src/runtime/pi-runtime-adapter.ts`
- `packages/web/src/admin/agents/agent-form.tsx`
- `packages/web/src/admin/pages/chat-page.tsx`

## 8. 修改固化参数

生成参数调整属于代码变更，不是运营配置：修改服务端模型常量，补充对应 Provider payload
与 Runtime adapter 测试，通过代码评审和部署后生效。不得临时通过数据库、Revision JSON
或浏览器请求注入覆盖值。
