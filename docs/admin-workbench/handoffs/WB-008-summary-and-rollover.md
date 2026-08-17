# WB-008 交接： Summary 与自动续接

状态：Complete

## 完成范围

实现 Conversation 的 Summary 生成、上下文恢复路径改造、以及自动 Rollover
（spec §12）。Conversation 在达到任一硬上限（事件数 / 字节数 / Turn 数）
后，服务端在当前 Turn 边界生成确定性 Summary 并写入 `conversation/rollover`
事件；客户端下一次 `createConversation` 携带 `previousConversationId` 时，
服务端验证旧会话已封存并链上 `previous_conversation_id`，
`POST /api/embed/v1/conversations` 返回的 envelope 中显式给出 `rollover`
字段，让客户端不再靠错误文案推断是否发生续接。

## 修改文件

### 协议层（`@earendil-works/pi-protocol`）

- `packages/protocol/src/session-events.ts` — 新增 `ConversationEventSummaryBody`、
  `ConversationEventSummary`、`ConversationRollover`、`ConversationLimits`、
  `DEFAULT_CONVERSATION_LIMITS`、`shouldRolloverConversation()`
- `packages/protocol/test/session-events.test.ts` — 新增 6 个 rollover 边界测试
- `packages/protocol/src/embed/public-http.ts` — 新增 `CreateConversationResponse`

### 服务端（`@earendil-works/pi-server`）

- `packages/server/src/publishing/domain/ids.ts` — 新增 `ConversationSummaryId` 与
  `newConversationSummaryId()`
- `packages/server/src/publishing/repositories.ts` — `ConversationRecord` 新增
  `latestSummarySequence`/`previousConversationId`/`nextConversationId`/
  `rolledOverAt`；新增 `ConversationSummaryRecord` / `ConversationSummaryRepository`；
  `ConversationRepository` 新增 `sealForRollover()` / `updateLatestSummarySequence()`；
  `PublishingRepositories` 暴露 `summaries`
- `packages/server/src/persistence/postgres/migrations/0009_conversation_summaries.sql`
  — 新增 `conversation_summaries` 表与 `conversations` 的 chain 列
- `packages/server/src/persistence/postgres/repositories/conversation-summaries.ts`
  — 新增 summary repository（基于 23505 SQLSTATE 区分 duplicate）
- `packages/server/src/persistence/postgres/repositories/conversations.ts` —
  `rowToRecord` 读取新列；新增 `sealForRollover` / `updateLatestSummarySequence` 方法
- `packages/server/src/persistence/postgres/repositories/index.ts` — 注册 summary repository
- `packages/server/src/runtime/summary-builder.ts` — 新增纯函数式 `buildSummary()`
- `packages/server/src/embed/conversations/service.ts` —
  - `CreateConversationInput` 新增 `previousConversationId`
  - `createConversation()` 改返回 `{ conversation, rollover }`，
    验证旧会话已封存 + 写入链 + 调用 `sealForRollover`
  - `restoreHistory()` 优先读 `summaries.getLatest()`，仅重放
    `sequence > throughSequence` 的事件，把 summary 文本作为
    synthetic user/assistant 消息前置注入
  - `executeTurn()` 在成功路径写入 `conversation/rollover` 事件 +
    调用 `tryRolloverIfNeeded()`
  - 新增 helper `mergeRestored()`、`resolveLimits()`、`tryRolloverIfNeeded()`
- `packages/server/src/embed/conversations/http.ts` — 调整 `POST /conversations`
  响应为 `{ data: { conversation, rollover } }`

### Web 端（`@earendil-works/pi-web`）

- `packages/web/src/embed/types.ts` — re-export `CreateConversationResponse`
- `packages/web/src/embed/api.ts` — `createConversation` 返回 `CreateConversationResponse`
- `packages/web/src/embed/conversation-controller.ts` — `create()` 返回 `CreateConversationResponse`
- `packages/web/src/embed/chat-controller.ts` —
  - `EmbedChatState` 新增 `rolloverNotice`
  - 新增 `EmbedRolloverNotice` interface
  - `newConversation()` 在 `rolledOver: true` 时把 `rollover` 写入 state
- `packages/web/src/embed/embed-app.tsx` — `EMPTY_STATE` 增加 `rolloverNotice: null`
- `packages/web/test/embed/embed-logic.test.ts` — mock 改为新 envelope 形状

### 测试

- `packages/server/test/runtime/summary-builder.test.ts`（新增，5 测试）
- `packages/server/test/persistence/conversation-summary-repository.test.ts`（新增，8 测试）

## 关键接口与数据结构

### `protocol/src/session-events.ts`

```ts
export interface ConversationEventSummaryBody {
  readonly text: string;
  readonly keyFacts: readonly string[];
  readonly openItems: readonly string[];
  readonly lastUserMessage: string;
}

export interface ConversationEventSummary {
  readonly id: string;
  readonly conversationId: string;
  readonly throughSequence: number;
  readonly modelId: string;
  readonly sourceEventCount: number;
  readonly sourceBytes: number;
  readonly body: ConversationEventSummaryBody;
  readonly createdAt: string;
}

export interface ConversationRollover {
  readonly conversationId: string;
  readonly rolledOver: boolean;
  readonly previousConversationId: string | null;
  readonly rolledOverAtSequence: number | null;
  readonly rolloverSummaryId: string | null;
}

export interface ConversationLimits {
  readonly maxConversationEvents: number;
  readonly maxConversationEventBytes: number;
  readonly maxConversationTurns: number;
}

export const DEFAULT_CONVERSATION_LIMITS: ConversationLimits = {
  maxConversationEvents: 5_000,
  maxConversationEventBytes: 20 * 1024 * 1024,
  maxConversationTurns: 500,
};

export function shouldRolloverConversation(
  counters: { eventCount; eventBytes; turnCount },
  limits: ConversationLimits,
): boolean;
```

### Migration `0009_conversation_summaries.sql`

- 新表 `conversation_summaries`：`UNIQUE (conversation_id, through_sequence)` +
  `UNIQUE (tenant_id, id)` + 复合 FK 锁住 (app, owner)
- `conversations` 新增 `latest_summary_sequence` / `previous_conversation_id` /
  `next_conversation_id` / `rolled_over_at`，并把 `previous_conversation_id` 与
  `(id, published_app_id)` 建立 FK，确保 rollover 链不出 scope

### Summary 生成器（`runtime/summary-builder.ts`）

```ts
export function buildSummary(
  events: readonly ConversationEventRecord[],
  options?: { maxTurns?: number },
): BuiltSummary;
```

- 确定性：不调外部模型；纯文本拼接最后 N 个完整 Turn
- `throughSequence` 必须落在 assistant.message 完整 Turn 边界
- `openItems`：末尾未结束的 user.message（spec §12.2 强制要求保留未完成事项）
- 默认 window = 8 turns（`DEFAULT_SUMMARY_TURN_WINDOW`）

### Repository — `ConversationSummaryRepository`

```ts
insert(scope, record):
  | { outcome: "inserted" }
  | { outcome: "duplicate" }  // (conversation_id, through_sequence) 冲突
getLatest(scope, conversationId)
list(scope, conversationId)
```

### Repository — `ConversationRepository` 新增

```ts
sealForRollover(scope, conversationId, {
  nextConversationId,
  atSequence,
}): Promise<boolean>; // 条件：status='active' 才允许
updateLatestSummarySequence(scope, conversationId, atSequence): Promise<boolean>; // 单调前进
```

### HTTP / Web envelope

`POST /api/embed/v1/conversations` 响应：

```jsonc
{
  "data": {
    "conversation": { /* ConversationSummary */ },
    "rollover": {
      "conversationId": "conv_xxx",
      "rolledOver": true,
      "previousConversationId": "conv_yyy",
      "rolledOverAtSequence": 1024,
      "rolloverSummaryId": "csum_zzz"
    }
  }
}
```

## 迁移与兼容策略

- `ConversationRecord` 新增 4 个字段，老代码 default 为 0/null，insert 路径需要
  默认填充（`service.createConversation` 已补齐）。
- `CreateConversationInput.previousConversationId` 是可选的；不传时行为与 WB-007
  完全一致。
- HTTP 响应从 `{ data: ConversationSummary }` 升级为 `{ data: { conversation, rollover } }`，
  一次性破坏性变更：所有 `createConversation` 客户端已在本任务内同步更新。
- `tryRolloverIfNeeded` 只在 `turn/end` 之后调用，确保"当前 Turn 不被硬切断"。

## 执行过的命令及结果

```text
cd packages/protocol && npx tsgo -p tsconfig.build.json          → OK
node ../../node_modules/vitest/dist/cli.js --run test/session-events.test.ts
                                                                 → 19/19 passed

cd ../server && npx tsgo --noEmit -p tsconfig.build.json        → OK
node ../../node_modules/vitest/dist/cli.js --run test/runtime/context-restore.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/runtime/summary-builder.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/persistence/conversation-event-counters.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/persistence/conversation-summary-repository.test.ts
                                                                 → 34/34 passed

cd ../web && node ../../node_modules/vitest/dist/cli.js --run test/embed/embed-logic.test.ts
                                                                 → 10/10 passed
npx tsgo --noEmit -p packages/web/tsconfig.json                  → OK
npx biome check (WB-008 文件)                                    → no errors
```

## 关键禁止项的当前状态

| 禁止 | 当前状态 |
|---|---|
| 不静默删除旧事件 | rollover 之后旧 Conversation 标记 archived，所有事件保留；新 Conversation 仅引用 `latest_summary_sequence` |
| 不重新编号 sequence | rollover 不动 `last_event_sequence`；只在 conversations 上加 4 个新列 |
| 不在半个 Turn 中间 Summary 或 rollover | `buildSummary.throughSequence` 必须落在完整 Turn 边界；`tryRolloverIfNeeded` 只在 `turn/end` 成功路径触发 |
| Summary 失败不得改变旧 Conversation 可恢复性 | `tryRolloverIfNeeded` 中 summary insert / update 各自 try/catch；append 失败不影响 Conversation |
| Summary 关键事实不得包含 Token/PEM | summary body 走 `safePayload` 上层校验（创建时由 buildSummary 拼接纯文本，无敏感字段） |

## 未关闭项

- **Summary 模型依赖**：当前 `buildSummary` 是无模型的纯文本拼接。规范允许但
  `tryRolloverIfNeeded` 的注释里点名"未来可升级到调用小模型"。本次不接模型调用，
  保持摘要确定性与可重放；后续 WB-006（用户会话详情）若有强需求再扩展。
- **operator-tunable 阈值**：`DEFAULT_CONVERSATION_LIMITS` 是协议常量，但运行期
  实际生效的 `resolveLimits()` 当前固定返回该默认值。下一步应在 `RuntimeSpec`
  或租户级 config 增加配置入口（属于控制平面，不是本任务范围）。
- **`conversation/summary` 事件**：当前 `tryRolloverIfNeeded` 只在 rollover 触发
  时写 `conversation/rollover`，不显式写 `conversation/summary`。summary 行本身已
  在 `conversation_summaries` 表中；事件日志的可观察性可后续用
  `safeAppend({ eventType: "conversation/summary" })` 补一条引用事件。
- **concurrent rollover 抢锁**：`sealForRollover` 是条件 update；如果两个并发
  `createConversation` 同时携带同一 `previousConversationId`，只有一个能 seal
  成功，另一个返回 `conversation_not_found`（统一不可用）。这符合 spec §12.3
  第 6 步"新 Conversation"语义，但调用方需自行重试或退避。
- **summary modelId 字段**：当前写死 `"(deterministic-summary)"`，方便日志/UI
  区分。后续接入真实模型时改为实际 model id。

## 对下一任务（WB-006）的约束

1. `ConversationRecord.previousConversationId` / `nextConversationId` 已经暴露在
   read 路径上；用户会话详情页（WB-006）应展示 rollover 链。
2. `ConversationSummaryRecord.body` 是 opaque，UI 展示前需要做 JSON 反序列化；
   类型来自 `protocol/src/session-events.ts` 的 `ConversationEventSummaryBody`。
3. 当前 `ConversationSummaryRepository` 只暴露 `insert/getLatest/list`；后续
   WB-006 若需要按 sequence range 查询，可扩展 `listAfter(throughSequence)`。
4. `tryRolloverIfNeeded` 在 `executeTurn` 内异步触发，写入 `conversation/rollover`
   事件；如果该写入失败，仅影响审计，不影响 Turn 主流程。
5. WB-006 引入"会话详情页"时，应直接读取 `latestSummarySequence` + `summaries.getLatest()`
   渲染 Summary tab，无需新建 repository 方法。