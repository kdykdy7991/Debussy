 核心 loop 在：

  - packages/agent/src/agent-loop.ts：真正的模型调用、工具执行和多轮循环。
  - packages/agent/src/agent.ts：有状态封装，管理消息、事件、取消以及 steering/follow-up 队列。

  最核心的流程是：

  用户消息
  → streamAssistantResponse()
  → 模型产生 toolCall
  → executeToolCalls()
  → 写入 toolResult
  → 再次请求模型
  → 没有工具调用和排队消息后结束

  Coding Agent 在 packages/coding-agent/src/core/agent-session.ts 上层加入会话持久化、压缩、扩展和交互行为。

  4. 从零研究，我建议先看这三部分：
  5. packages/agent

     先读 types.ts、agent-loop.ts、agent.ts。这是最小且完整的 Agent 工作原理，理解后其他代码容易很多。

  6. packages/ai

     先读 types.ts、models.ts、api/lazy.ts，再挑一个 provider API，例如 api/openai-responses.ts。重点理解统一消息格式、流式事件和 provider 差异如何被屏蔽。

  7. packages/coding-agent

     按以下路径阅读：

  src/cli.ts
  → src/main.ts
  → src/core/agent-session-services.ts
  → src/core/agent-session.ts
  → src/core/tools/
  → src/modes/interactive/interactive-mode.ts

  暂时不要先钻进 TUI 组件、模型生成脚本和 experimental server；它们不是理解主流程的最短路径。
