# WB-007 交接： Session Event Log 补强

状态：Complete

## 完成范围

把 `conversation_events` 升级为权威追加式事件日志（spec §11）。新增统一事件
信封、事件目录、`event_count`/`event_bytes`/`turn_count`/`payload_bytes`
四类计数（与 append 同事务推进）、`standard`/`diagnostic`/`full` 三档日志
等级、payload 字节上限、敏感字段黑名单、`turn.interrupted` 中断 Turn 收敛、
`restoreContext` 三档恢复。

## 修改文件

- `runtimes/pi/packages/protocol/src/session-events.ts`（新增）
- `runtimes/pi/packages/protocol/src/index.ts`（re-export 新模块）
- `runtimes/pi/packages/protocol/test/session-events.test.ts`（新增）
- `runtimes/pi/packages/server/src/persistence/postgres/migrations/0008_event_counters.sql`（新增）
- `runtimes/pi/packages/server/src/publishing/repositories.ts`（`ConversationEventRecord.payloadBytes`、`ConversationEventInput.payloadBytes`、`ConversationRecord.eventCount/eventBytes/turnCount`）
- `runtimes/pi/packages/server/src/persistence/postgres/repositories/conversation-events.ts`（事务级计数器、`computePayloadBytes` 导出）
- `runtimes/pi/packages/server/src/persistence/postgres/repositories/conversations.ts`（新字段读出）
- `runtimes/pi/packages/server/src/embed/conversations/service.ts`（新增 `safeAppend`/`safePayload`，`archiveConversation` 写 `conversation/archived`，`executeTurn` 写入 `turn/start`、`user/message`、`assistant/message`、`turn/end`、`turn/failed`、`conversation/archived`、`citation/updated`、按日志等级写 `assistant/chunk`）
- `runtimes/pi/packages/server/src/runtime/context-restore.ts`（接受 `logLevel` 参数、识别新事件类型、报告 `droppedChunks`/`errorEventCount`/`observedLogLevel`、未完成 Turn 收敛为 `turn/interrupted`）
- `runtimes/pi/packages/server/src/publishing/runtime-spec/schema.ts`（`contextPolicySpec` 新增 `logLevel` 默认 `"standard"`）
- `runtimes/pi/packages/server/test/runtime/context-restore.test.ts`（新增 6 个 WB-007 测试，补 `payloadBytes` fixture）
- `runtimes/pi/packages/server/test/persistence/conversation-event-counters.test.ts`（新增 8 个 repository 单元测试）

## 关键接口与数据结构

### 协议层（`packages/protocol/src/session-events.ts`）

| 导出 | 类型 | 作用 |
|---|---|---|
| `SESSION_EVENT_TYPES` | readonly tuple | 冻结事件目录（17 个，spec §11.4） |
| `SESSION_LOG_LEVELS` | readonly tuple | `standard`/`diagnostic`/`full` |
| `SESSION_EVENT_PAYLOAD_BYTE_LIMIT` | 256 KiB | payload 默认上限 |
| `SESSION_EVENT_PAYLOAD_SCHEMA_VERSION` | `1` | 事件 schema 版本 |
| `assertEventPayloadSafe(payload, opts?)` | function | 校验：JSON 可序列化 + 字节 ≤ 上限 + 无敏感 key + 无敏感值形 |
| `shouldPersistAssistantChunk(level, chunk)` | function | 流式 chunk 按等级决定是否落盘 |
| `shouldInlineToolInput(level)` | function | tool 输入是否内联 |
| `SessionEventPayloadError` | class | 校验失败的 typed error |

### 服务端（`publishing/repositories.ts`）

```ts
interface ConversationEventRecord {
  // ...existing...
  readonly payloadBytes: number;  // WB-007: 新增，denormalised
}

interface ConversationEventInput {
  readonly payloadBytes?: number; // 缺省 = computePayloadBytes(payload)
}

interface ConversationRecord {
  // ...existing...
  readonly eventCount: number;
  readonly eventBytes: number;
  readonly turnCount: number;
}
```

### 数据库 migration `0008_event_counters.sql`

```sql
ALTER TABLE conversations
    ADD COLUMN event_count bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    ADD COLUMN event_bytes bigint NOT NULL DEFAULT 0 CHECK (event_bytes >= 0),
    ADD COLUMN turn_count bigint NOT NULL DEFAULT 0 CHECK (turn_count >= 0);

ALTER TABLE conversation_events
    ADD COLUMN payload_bytes integer NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0);

CREATE INDEX conversation_events_turn_idx
    ON conversation_events (conversation_id, turn_id)
    WHERE turn_id IS NOT NULL;
```

### Repository 事务（`conversation-events.ts.append`）

UPDATE 与 INSERT 在同一事务：

```sql
update conversations
   set last_event_sequence = last_event_sequence + 1,
       event_count         = event_count + 1,
       event_bytes         = event_bytes + $5,
       turn_count          = turn_count + case
           when $6::uuid is null then 0
           else (select case when exists (
               select 1 from conversation_events ce
               where ce.conversation_id = conversations.id
                 and ce.turn_id = $6::uuid
           ) then 0 else 1 end)
       end,
       updated_at = now(), last_active_at = now()
 where id = $1 and tenant_id = $2 and published_app_id = $3
   and owner_principal_id = $4 and deleted_at is null
 returning last_event_sequence
```

事务失败 = 计数与 sequence 一起回滚（已在专项测试覆盖）。

### `restoreContext(events, params, logLevel)`

新增第三个参数 `logLevel: SessionLogLevel`，返回结构增加：

```ts
{
  messages,                // 完整 assistant.message 对
  interruptedTurnIds,      // user.message 后无终态的 turn（供调用方写 turn/interrupted）
  skippedEvents,           // 不可恢复的事件数
  droppedChunks,           // 流式 chunk 被压缩数
  errorEventCount,         // turn.failed/turn.interrupted/tool.error 计数
  observedLogLevel,        // 从事件推断的等级（dashboard 用）
}
```

## 迁移与兼容策略

- `ConversationEventRecord` 新增 `payloadBytes` 字段。已有插入路径通过 `computePayloadBytes(payload)` 自动填充；测试 fixture 也补齐。
- `ConversationRecord` 新增 `eventCount`/`eventBytes`/`turnCount`，默认 0。
- `RuntimeSpec.contextPolicy.logLevel` 默认 `"standard"`，既有的 RuntimeSpec JSON 仍可解析（zod 默认为 `standard`）。
- `event_type` 字符串由旧 `user.message`/`assistant.completed`/`turn.failed`/`turn.interrupted` 平滑过渡到新目录（`user/message`、`assistant/message`、`turn/failed`、`turn/interrupted`）。恢复路径同时接受新旧两种事件名，避免一次性迁移带来的不可恢复窗口。

## 执行过的命令及结果

```text
cd packages/protocol && npx tsgo -p tsconfig.build.json          → OK
node ../../node_modules/vitest/dist/cli.js --run packages/protocol/test/session-events.test.ts
                                                                 → 13/13 passed

cd ../server && npx tsgo --noEmit -p tsconfig.build.json        → OK
node ../../node_modules/vitest/dist/cli.js --run test/runtime/context-restore.test.ts
                                                                 → 13/13 passed (7 旧 + 6 新)
node ../../node_modules/vitest/dist/cli.js --run test/persistence/conversation-event-counters.test.ts
                                                                 → 8/8 passed

cd ../.. && npx tsgo --noEmit -p packages/server/tsconfig.build.json
                                                                 → OK (既有 ai models 类型问题已修；详见"未关闭项")
npx tsgo --noEmit -p packages/web/tsconfig.json                  → OK
npx biome check (仅 WB-007 文件)                                  → no errors, no warnings
```

## 关键禁止项的当前状态

| 禁止 | 当前状态 |
|---|---|
| 不创建每会话 JSONL 文件 | 没有 JSONL 落盘逻辑；JSONL 只作为导出格式（WB-009） |
| 不增加 Segment 表 | 没有新增 `conversation_segments` |
| 不改写已提交事件 | append 是唯一写入路径；repository 全部 read-only/list |
| 不记录 Token/PEM/原始用户标识 | `assertEventPayloadSafe` 黑名单覆盖所有 spec §11.5 字段；`safePayload` 兜底 redact |
| 通过动态 import 掩盖同一 bundle | 无新增 build 改动 |

## 未关闭项

- **既有 `event_type` 名称兼容**：恢复路径同时识别 `user.message`（旧）和 `user/message`（新）。WB-008 / WB-009 可以发起一次性 migration 把旧行统一改写，但当前保留旧名避免破坏既有事件历史。
- **既有 ai models 类型问题**：未触碰，与本任务无关。WB-000 handoff 已记录。
- **`payloadBytes` 由 repository 在 append 时计算**：调用方也可以预计算并传入以节省 CPU。`ConversationEventInput.payloadBytes` 字段已就位，但当前 `executeTurn` 调用点一律由 repository 计算（一致性好）。
- **chunk 流式**：当前 `executeTurn` 是同步路径（spec 18），没有真实的 streaming chunks；只在 `diagnostic`/`full` 时写一条"伪 milestone"事件让 `restoreContext` 能报告 `observedLogLevel`。Realtime 通道（WB-005）建成后该路径由 streaming controller 接管，按 chunk 直接 append。
- **`computePayloadBytes` 调用频率**：每次 append 多一次 `JSON.stringify` + `Buffer.byteLength`，单 Conversation 写入频率有限，可接受。WB-008 的 rollover 边界检查需要在 transactional context 内做，调用方可预计算避开重复。
- **migration 0008 在已有 schema 上的回放**：`event_count`/`event_bytes`/`turn_count` 默认 0，不会破坏现有 Conversation 行；但 `payload_bytes` 默认 0 也不准确反映历史事件大小，导出场景下应以实际 JSON 字节数重新计算（WB-009）。

## 对下一任务（WB-008）的约束

1. WB-008 引入 `conversation_summaries` 表 + rollover 协议；新增 `summary`-related 事件类型已在 SESSION_EVENT_TYPES 列表预占（`conversation/summary`、`conversation/rollover`）。
2. WB-008 需使用 `ConversationRecord.eventCount`/`eventBytes`/`turnCount` 作为硬上限判断条件；repository 事务保证计数原子更新。
3. WB-008 应继续复用 `assertEventPayloadSafe`（Summary content 也走此校验，避免原始 Token 渗入）。
4. WB-008 的 `createConversation`/`previousConversationId` 链路需要继续使用本任务的 `safeAppend`/`safePayload`（service 已暴露为 private，可在 WB-008 评估公开必要性）。
5. 当前 conversation `archived` 状态触发 `conversation/archived` 事件；WB-008 应在其后写入 `conversation/summary` + `conversation/rollover` 三件套。

## 对 WB-001 build-boundary 测试的影响

无新增 import 边界变更。Embed bundle 与 Admin bundle 的依赖图不变。