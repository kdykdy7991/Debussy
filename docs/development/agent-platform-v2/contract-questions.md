# V2 契约候选与未决项（M0 第二轮）

状态：M0 第二轮；本文为前端对 M0 契约的**正式候选**与**未决项**，由后端/总架构师在第二轮审查中批准或退回

负责人：前端工程师

创建日期：2026-08-24（修订二：2026-08-24）

> **措辞规约**
> - §1 列出前端已按总架构师第一轮反馈拟订的"候选契约"——含字段名、类型与端点草案，等待后端补齐与总架构师批准。
> - §2 列出仍待决的"待补候选"（需后端/总架构师给出字段口径或路径）。
> - §3 列出需要从"已冻结"语言回到"候选"语言、或在前端删除的项。
> - §4 列出本文件外、必须由后端工程师负责的 M0 缺口（前端无法独自决定）。
> - 配套调研见 [m0-survey.md](./m0-survey.md)，前端行为原型见 [m0-sdk-prototype.md](./m0-sdk-prototype.md)。

## 1. 前端已拟订的 M0 候选契约

### 1.1 `TurnMetrics`（单轮性能）— 候选

来源：[README §4.1](../../product/DECISIONS.md#4-冻结的统计口径) 草案。前端不写业务数字，只消费；以下字段为前端期望的最小集合。

```ts
interface TurnMetrics {
  readonly turnId: string;
  readonly conversationId: string;
  readonly inputTokens: number;          // 权威：Provider Usage
  readonly outputTokens: number;         // 权威：Provider Usage
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly requestStartedAt: string;     // ISO8601，单调时钟
  readonly providerStartedAt: string;    // ISO8601，单调时钟
  readonly firstOutputAt: string | null; // 首个可展示文本增量；不包含 thinking/心跳/Tool
  readonly completedAt: string;          // ISO8601，含失败/取消时间
  readonly status: "succeeded" | "tool_only" | "failed" | "cancelled" | "retried" | "interrupted";
  readonly failureCode: string | null;   // 失败/取消时的稳定错误码
  readonly ttftMs: number | null;        // firstOutputAt - providerStartedAt；失败/取消时为 null
  readonly generationMs: number | null;  // completedAt - firstOutputAt；无文本输出时为 null
  readonly totalLatencyMs: number;
  readonly outputTokensPerSecond: number | null; // outputTokens / generationMs * 1000；不含 TTFT
}
```

**前端契约**：

- `ttftMs === null` / `generationMs === null` / `outputTokensPerSecond === null` 表示"无可展示文本或回合未正常结束"；前端**禁止用 0 填空**。
- 会话级均值只对 `status === "succeeded" || status === "tool_only"` 且 `firstOutputAt !== null` 的样本聚合；返回 `sampleSize` 与 `null` 计数。
- 前端不在 `usage` 之上做估算覆盖；估算仅用于 [§1.2](#12-contextusagesnapshot-单会话上下文-候选) 的 `breakdown`。
- 验收材料要求包含可控 fake provider 的 TTFT 与 tokens/s 抓包（[architect-acceptance.md §4.1](../../product/architect-acceptance.md#41-m1统计与embed)）。

### 1.2 `ContextUsageSnapshot`（单会话上下文）— 候选

来源：[README §4.2](../../product/DECISIONS.md#42-上下文快照) 草案。

```ts
interface ContextUsageSnapshot {
  readonly conversationId: string;
  readonly capturedAt: string;       // ISO8601，单调时钟；快照必须采自最终模型请求前
  readonly usedTokens: number;
  readonly contextWindow: number;
  readonly remainingTokens: number;
  readonly reservedOutputTokens: number;
  readonly usagePercent: number;
  readonly measurement: "exact" | "estimated";
  readonly unavailableReason: "no_snapshot_yet" | "legacy_conversation" | null;
  readonly breakdown: {
    readonly systemPrompt: number;
    readonly skillInstructions: number;
    readonly toolDefinitions: number;
    readonly conversationMessages: number;
    readonly toolResults: number;
    readonly retrievalContext: number;
    readonly attachments: number;
  };
}
```

**前端契约**：

- 快照中 `breakdown` 各分项之和必须能解释 `usedTokens`；前端不做交叉验证，仅按服务端值渲染。
- `measurement: "estimated"` 在 UI 上显示 "估算" 标签；`unavailableReason !== null` 时整段显示"该会话创建时尚未采集"。
- `usedTokens === 0` 与 `unavailableReason` 必须互斥；后端应保证不出现 `usedTokens: 0, unavailableReason: null` 这种被怀疑伪造 0 的组合。

### 1.3 `sessionEffort`（会话级 reasoningEffort 覆盖）— 候选

```ts
type SessionEffort = {
  readonly conversationId: string;
  readonly reasoningEffort: ReasoningEffort | null; // null = 回到 Revision 默认
  readonly updatedAt: string;        // ISO8601，单调时钟
  readonly source: "user" | "system" | "policy";
};

interface SessionEffortPatch {
  readonly reasoningEffort: ReasoningEffort | null;
}
```

**前端契约**：

- 端点（候选）：`PUT /api/embed/v1/conversations/:id/effort`，body 为 `SessionEffortPatch`；**不写到 `Conversation.metadata`**（与 architect-acceptance §4.1 一致：覆盖值必须可审计、不能混入通用 metadata）。
- 服务端校验：会话覆盖值必须属于已发布 Agent Revision 当前模型支持的合法档位，否则返回稳定错误码（如 `EFFORT_NOT_SUPPORTED`）；非法档位由服务端拒绝，前端不在 UI 外做兜底。
- 优先级：`sessionEffort.reasoningEffort` → Agent Revision `parameters.reasoning.effort` → Provider/模型默认。前端只在 UI 中展示此优先级，**不**改写 Revision。
- 失效策略：模型目录变更导致当前覆盖档位不再合法时，服务端将 `sessionEffort` 重置为 `null` 并返回 `EFFORT_NO_LONGER_SUPPORTED` 错误码；前端在收到该错误码时把 UI 切回 Revision 默认并显示提示。
- **已否决**：`Conversation.metadata.reasoningEffort`、`SessionController.setThinking(ThinkingLevel)` 这两个 V1 通道；M1 删除。

### 1.4 Skill 与 MCP（产品化）— 候选

#### 1.4.1 Skill Revision

```ts
type SkillId = string & { __brand: "SkillId" };
type SkillRevisionId = string & { __brand: "SkillRevisionId" };

interface Skill {
  readonly id: SkillId;
  readonly name: string;
  readonly status: "active" | "disabled";
  readonly latestRevisionId: SkillRevisionId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SkillRevision {
  readonly id: SkillRevisionId;
  readonly skillId: SkillId;
  readonly versionHash: string;
  readonly content: { readonly body: string; readonly resources: readonly { path: string; bytes: number }[] };
  readonly validation: { readonly ok: boolean; readonly diagnostics: readonly readonly { readonly path: string; readonly message: string }[] };
  readonly createdAt: string;
}

interface AgentSkillBinding {
  readonly skillRevisionId: SkillRevisionId;
  readonly allowOverride: boolean;
}
```

#### 1.4.2 MCP Server / Revision / Tool

```ts
type McpServerId = string & { __brand: "McpServerId" };
type McpRevisionId = string & { __brand: "McpRevisionId" };

interface McpServer {
  readonly id: McpServerId;
  readonly displayName: string;
  readonly transport: "streamable_http" | "stdio"; // 修订二建议：M3 首期仅 streamable_http
  readonly endpoint: string | null;
  readonly status: "active" | "disabled";
  readonly latestRevisionId: McpRevisionId | null;
  readonly secretRefs: readonly { readonly slot: string; readonly version: number }[];
}

interface McpRevision {
  readonly id: McpRevisionId;
  readonly serverId: McpServerId;
  readonly versionHash: string;
  readonly transportConfig: { readonly streamableHttpUrl?: string };
  readonly tools: readonly McpTool[];
  readonly createdAt: string;
}

interface McpTool {
  readonly name: string;
  readonly versionHash: string;
  readonly schema: unknown; // JSON Schema
}

interface AgentMcpBinding {
  readonly mcpRevisionId: McpRevisionId;
  readonly toolAllowlist: readonly string[]; // 工具名；空数组 = 全部不允许
}
```

**前端契约**：

- Skill Revision 与 Agent Revision 是 N:M 关系，绑定在 Agent Revision 上；发布后固定。
- MCP Tool 白名单默认"全部不选"；发布后新增 Tool 不自动扩 allowlist。
- Secret 只在控制台保存"引用"，不写入 RuntimeSpec、事件、导出与日志；详情永不回显 Secret，只允许替换。
- 路径穿越、符号链接逃逸、超大文件、可执行内容等导入校验失败时返回稳定错误码；前端展示服务端原始诊断，不擅自通过。

### 1.5 Embed SDK 行为契约 — 候选（修订二补）

来源：[m0-sdk-prototype.md §4](./m0-sdk-prototype.md)。

| 维度 | 候选契约 |
|---|---|
| 包名 | `@earendil-works/pi-embed-sdk`（M1 落地） |
| 公开 API | `createEmbed(options) → EmbedInstance`（M1 改名；当前 `create` 等价语义） |
| 事件名 | `ready` / `error` / `conversation-created` / `resize`，向后兼容扩展 |
| postMessage 协议 | v1 + 兼容扩展；不兼容升级时引入 v2 并保持 v1 解析 |
| resize 高度合法区间 | `1 ≤ height ≤ POST_MESSAGE_RESIZE_MAX_HEIGHT (100000)`，`<= 0` 在协议 + SDK 双重拒绝（修订二） |
| launchToken | 仅在内存中；`destroy()` 后断开引用；不写入 URL / localStorage / sessionStorage / cookie |
| 多实例共享宿主 window | 同 `window.addEventListener("message", ...)` 池；监听器按 `event.source === iframe.contentWindow` 精确路由 |
| 发布范围 | 仅限内部网络（[DECISIONS D-010](../../product/DECISIONS.md)） |

## 2. 仍待决项（前端无法决定，待后端 + 总架构师给出）

### 2.1 会话分页契约（修订二新增，**后端阻断**）

- 第一轮回退：`GET /api/control/v1/conversations` 当前实现按当前页错误地计算全会话统计（总耗时均值、Token 总和等）。聚合必须在服务端基于完整游标集合进行；前端只渲染服务端返回的 `aggregates`。
- 待补：`pageSize` 上限、游标格式（`nextCursor: string \| null`）、`aggregates` 字段（`totalTokens`、`avgTotalLatencyMs`、`sampleSize`）与是否独立端点；与 README §6 错误码冻结一并落地。
- 前端要求：聚合错误（如"按当前页统计"导致的数据失真）必须由可重放 fixture 复现并附回归测试。

### 2.2 事件枚举（修订二新增，**后端阻断**）

- 服务端实际写入 `turn/failed`，但不在权威事件枚举中。前端无法在没有权威枚举的情况下消费事件；M1 起前端只消费枚举内事件，未知事件保留既有降级路径（参见 [architect-acceptance.md §4.1](../../product/architect-acceptance.md#41-m1统计与embed)）。
- 待补：完整事件枚举（含 `turn/succeeded`、`turn/failed`、`turn/cancelled`、`turn/tool_only`、`turn/retried`、`turn/interrupted` 等），并把 `turn/failed` 纳入权威枚举。

### 2.3 单调时钟顺序（修订二新增，**后端阻断**）

- 后端必须在 Provider 请求开始、首个可展示文本增量、结束/失败/取消处打**单调**时钟时间点（`monotonicTimeNs: number` + 对齐墙钟 `wallClockAt: string`）。
- 前端校验用例：乱序样本（人为倒置 `firstOutputAt` 与 `completedAt`）进入 UI 后仍按时间戳升序渲染，不重新排序；这是**前端契约**而非"前端计算"——前端只决定渲染顺序。
- 待补：单调时钟与墙钟对齐策略、NTP/闰秒处理、时钟漂移阈值。

### 2.4 模型生成参数白名单（**总架构师**）

- `LlmAvailableModel.parameterCapabilities.reasoning` 字段是否补"互斥约束 / 步长"；是否新增 `defaultEffort` 之外字段（如 `providerMapping`）。
- 各 Provider 的合法 effort 档位与默认 effort 映射表。

### 2.5 Skill / MCP / reasoning 持久化（修订二升级为待补候选）

- Skill Revision 内容存储与版本 hash 算法（git-like / 内容 hash）。
- MCP Secret 存储：本地 vs KMS；Secret 替换是否需要双 Secret 轮换窗口。
- `sessionEffort` 写入位置：固定 `/api/embed/v1/conversations/:id/effort`，但需要总架构师批准"不写 `Conversation.metadata`"的边界。
- `AgentSkillBinding` / `AgentMcpBinding` 与发布版本固定关系：绑定字段落到 Agent Revision 还是 Published App Version？后端给出。

### 2.6 Embed SDK / 通用

- 控制台"接入方式"示例代码片段是否需要由 SDK 文档示例与 `app-detail.tsx` 双向对齐；展示哪些事件默认监听。
- Admin / Embed 错误信封是否统一为 `{ code, message, requestId }`；Metrics / Context / Skill / MCP 是否沿用。

## 3. 措辞与契约清理（修订二必须落实）

- 仓库 `m0-survey.md` / `m0-sdk-prototype.md` / 本文件修订二版**不再**使用 "已冻结/可开发" 等通过性语言描述未冻结字段；任何通过性措辞只在 M0 门禁通过后才可写入。
- **已否决**：
  - `Conversation.metadata.reasoningEffort`（V1 通道）— 不写入 `metadata`；改走 `sessionEffort`。
  - `SessionController.setThinking(ThinkingLevel)`（V1 字符串预留开关）— M1 删除，改为 `setReasoningEffort(ReasoningEffort)`；前端不把 V1 `thinkingLevel` 当成 V2 reasoning 通道。
- **已批准**（首轮反馈中总架构师批的方向，保留措辞规约但保留结论）：
  - Embed 高度 `1 ≤ h ≤ 100000`（修订二已落地协议 + SDK 双重拒绝）。
  - M0 不修改 Runtime；事件日志仍是单一真源；指标延展现有 turn/end payload；新事件 slash 风格 + legacy 只读兼容；`PI_AGENT_V2_METRICS` 默认 off；前向兼容迁移。
  - SDK 包名 `@earendil-works/pi-embed-sdk`；公开 API `createEmbed` / `EmbedInstance`。
  - postMessage 保持 v1，扩展必须向后兼容。
  - fixture 只通过单一 typed adapter 进入测试/开发环境。
  - 发布范围仅限内部网络。

## 4. 后端独立负责、本文件只跟踪的 M0 缺口

| # | 缺口 | 责任人 | 阻塞场景 |
|---|---|---|---|
| 1 | 会话分页聚合按当前页计算 | 后端 | 控制台会话列表统计失真 |
| 2 | `turn/failed` 不在权威事件枚举 | 后端 | 前端无法安全消费 |
| 3 | 单调时钟顺序采集与契约 | 后端 + 总架构师 | 排序/聚合口径无依据 |
| 4 | Skill / MCP / `sessionEffort` 持久化端点 | 后端 | DTO 未冻结，骨架不动 |
| 5 | Reasoning Provider 映射 + 互斥约束 | 后端 + 总架构师 | 表单档位不完整 |
| 6 | README §6 错误码冻结 | 后端 + 总架构师 | 前端文案无依据 |
| 7 | fake provider 验证 TTFT/tokens/s | 后端 | M1 验收证据缺失 |

## 5. 冻结时间窗与下一轮节奏

- M0 门禁由总架构师在第二轮审查中给出：通过 / 有条件通过 / 不通过；前端在门禁前不再扩大 M0 范围。
- 通过后：首批冻结 DTO → M1 短期分支同步创建 → 后端先交付真实 API、五组 fixture 与可控 fake provider → 前端再展开 Embed SDK 改造与页面骨架。