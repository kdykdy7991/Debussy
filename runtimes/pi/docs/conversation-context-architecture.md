# Conversation / Context 主架构（封板版）

> 状态：**正式封板**。对应 Phase 1 ～ Phase 3.6 全部已实现行为。
> 本文档只记录已冻结的最终设计，不做行为层面的前瞻性修改。
> 与本次无关的既有 build / typecheck 错误不属于本文档范围。

本文档统一定义 Published Conversation（Production / Embed 平面）与
Debug Conversation（Debug 平面）的持久化、Context 恢复、Compaction、
Token Accounting、Runtime 生命周期等主架构规则。两平面的底层物理表不同，但
**行为语义必须一致**。

---

## 1. 持久化真相源

对于 Published Conversation 与 Debug Conversation：

**Postgres 是唯一持久化真相源。**

- `conversation_events` / `debug_conversation_events`
  保存完整的 Conversation 行为事实（user / assistant / toolCall / toolResult /
  turn/end 等事件流，按 sequence 严格有序）。
- `conversation_summaries` / `debug_conversation_summaries`
  保存经过压缩后的持久化 Context 状态（Summary 链）。

**Working Context 恢复规则固定为：**

```
最新 Summary
+　Summary 覆盖边界（throughSequence）之后的结构化 Events
=　当前 Working Context
```

恢复必须可重复、可确定：给定 Postgres 中的同一事件流与 Summary 链，两次恢复
必须产出字节级一致的 Working Context。

---

## 2. Pi 的职责

Published / Debug Conversation 中：

- **Pi SessionManager 只作为 in-memory runtime 使用。**
- 不得把 Pi JSONL 当作 Conversation 的持久化来源。
- Pi JSONL 仅保留给当前确实需要它的 **Admin / Coding Chat 等独立产品路径**。

Pi 的 in-memory 会话是一次性、可被销毁的临时状态；其内容必须能够且只能够由
Postgres 事件流重放重建。

---

## 3. Tool Conversation

Tool 事件必须保留以下恢复必要信息：

- `toolCall` 的 `arguments`（input）
- `toolCallId`
- `toolResult` 模型实际看到的 `content`
- `isError` / `truncated` 等恢复标记

保证 runtime 被销毁后，以下恢复链成立：

```
Postgres
→ structured restore
→ assistant(toolCall)
→ toolResult
→ assistant
```

即：工具调用被恢复成**原生模型上下文**（结构化的 `assistant(toolCall)` →
`toolResult` → `assistant` 顺序），而不是被压平成普通文本模拟。`toolCallId` 的
配对由事件流的同 Turn 顺序天然保证（`tool/call` 先于 `tool/result` / `tool/error`
落盘）。

---

## 4. Compaction ownership

**Debussy 拥有正常 Context Compaction 的最终决策权。**

Pi 对 Published / Debug 使用：

```
compactionMode = overflow-only
```

即三层防御，按优先级排列：

1. **Debussy proactive compaction**（每 Turn 结束后）
2. **Debussy pre-prompt guard**（新 Turn 的 user input 已知后、真正调用模型前）
3. **Pi emergency overflow recovery**（provider 层面，单次请求异常兜底）

Pi overflow 只是单次请求的异常兜底。**它产生的 in-memory compaction 状态不得
跨 Turn 存活**——每个完整 Turn 结束后 runtime 被 evict，Pi 的紧凑状态随之销毁。

---

## 5. Runtime 生命周期

当前 Published / Debug Conversation 在**每个完整 Turn 结束后，故意
reset / evict runtime**。

下一 Turn 的模型请求按如下路径重建上下文：

```
Postgres
→ restore
→ hydrate 新的 Pi in-memory runtime
```

这是为了**保证 Context 唯一真相源与恢复一致性**而做出的明确设计选择，不是 bug。

> **Invariant（不可破坏）：**
> 下一 Turn 的 Context 必须能够完全由 Postgres 确定。

未来如需性能优化，可以重新评估 runtime cache，但不得破坏该 invariant。

---

## 6. Summary boundary

Compaction boundary 必须位于**一个完整、已经提交成功的 Turn 的
`assistant/message` Event 流水号**。

**禁止：**

- 压缩 pending / in-flight Turn
- 在 toolCall / toolResult 中间切断
- 使用 Pi `firstKeptEntryId` 作为持久化 boundary
- 建立 Pi record ID ↔ Debussy Event 流水号映射

Boundary 一律用 Debussy Event sequence（`throughSequence`），从不落任何 Pi
record id。

---

## 7. Summary chaining

长期 Conversation 使用**链式压缩**，不每次重新扫描整个 Conversation：

```
Summary N
+  Summary N 之后到新 boundary 之间的 Events
→  Summary N+1
```

即：读取最新 Summary，仅重放其 `throughSequence` 之后的事件，把增量收敛进一条
新的 summary（`previousSummaryId` + 累计 `tokensBefore` 链式推进）。

---

## 8. Token Accounting

正常 Context 管理必须综合以下全部输入：

- resolved model.contextWindow
- resolved model.maxTokens
- RuntimeSpec.contextPolicy
- provider 实际 input usage
- Conversation Working Context estimate
- runtime overhead
- next input reserve
- safety margin

**provider usage 用于校准真实 runtime overhead**（system prompt + Skills + tool
schemas 等不可压缩的请求开销）：

```
measuredRuntimeOverhead
  = max(0, actualInputTokens(最后一条带 usage 的 turn/end)
           − estimatedWorkingContextTokens(该请求的事件集))
actualInputTokens = usage.input + usage.cacheRead
```

**Debussy estimator 用于判断**：Conversation 历史中哪些内容可以被压缩，以及
压缩到哪里。不能用一个固定 magic number 假装代表
system prompt + Skills + tool schemas。

最终 budget：

```
budget = max(0, effectiveWindow
                − model.maxTokens
                − runtimeOverhead       （实测；缺失时用窗口相对保守比例回退）
                − nextInputReserve      （turn/end 留位；pre-prompt 为 0）
                − safetyMargin)
effectiveWindow = min(model.contextWindow, policy.maxContextTokens)
```

usage 缺失时的回退是**显式、偏保守**的（窗口相对比例，随窗口缩放），绝不是固定
2048。

---

## 9. Pre-prompt Guard

除了 Turn 结束后的 proactive compaction，在**新 Turn 的 user input 已知之后、
真正调用模型之前**，还必须执行 pre-prompt budget guard。

这样当前真实 user message 会进入预算判断（被显式并入 Working Context estimate）。

**如果超过预算：只允许压缩之前已经完整提交的 Turns。**
**当前正在执行的 Turn 不得进入 Summary。**

Guard 只会在 provider 调用前静默落一个 summary（若需要）并重建 history，不改动
当前 Turn 的任何行为。

---

## 10. Published / Debug 一致性

Published Conversation 与 Debug Conversation 必须保持一致：

- Context restore 语义一致
- Tool Event 语义一致
- Compaction 算法一致
- Token Accounting 一致
- Pi 使用 inMemory
- Pi 使用 overflow-only
- Working Context 都由 Postgres 恢复

允许底层物理表不同，但**行为语义必须一致**。

---

## 非目标 / 后续专题（本轮不修改）

以下内容属于后续独立专题，不属于当前 Conversation / Context 主架构：

- multimodal / attachment 完整恢复
- reasoning / thinking signature continuity
- Summary 质量 benchmark 与优化
- runtime cache 性能优化
- Production / Debug Event 表物理统一
- Admin / Coding Chat persistence 改造
- 与本次无关的既有 build / typecheck 错误