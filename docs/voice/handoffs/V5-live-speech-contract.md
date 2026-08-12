# V5 Handoff：Live Speech Contract

**状态**：Contract frozen（pending commit）  
**执行者**：V5 owner  
**总规范**：[`../PI-LIVE-AGENT-SPEECH-SPEC.md`](../PI-LIVE-AGENT-SPEECH-SPEC.md)  
**任务单**：[`../tasks/V5-live-speech-contract.md`](../tasks/V5-live-speech-contract.md)  
**日期**：2026-08-12  
**下游**：V6 Incremental Segmenter（已并行进行）；V7 Utterance Queue；V8 Server Coordinator；V9 Web UX

---

## 1. 完成情况总览

| 交付物 | 文件 | 状态 |
| --- | --- | --- |
| Protocol v4 schema 冻结 | `packages/protocol/src/schemas.ts` | ✅ |
| `LiveSpeechRequest` / `LiveSpeechStatus` / `LiveSpeechProgress` / `LiveSpeechErrorCode` / `LiveSpeechJob` | 同上 | ✅ |
| `cancel_live_speech` command/result + `live_speech_job` event | 同上 | ✅ |
| `PromptCommand` 可选 `speech`（**仅** prompt；steer 不带） | 同上 | ✅ |
| `PromptResult` 可选 `liveSpeech` | 同上 | ✅ |
| `VoiceCapability` 增加 `live: boolean`（`live: false` 合法降级） | 同上 + `voice/types.ts` + `voice/speech-manager.ts` | ✅ |
| `CommandSchema` / `CommandResultSchema` / `ServerEventSchema` 接线 | 同上 | ✅ |
| Server `cancel_live_speech` 显式 stub（返回 `invalid_state`） | `packages/server/src/sessions.ts` | ✅ |
| Client `LiveSpeechJobHandle` + `cancelLiveSpeech` + `live_speech_job` 事件路由 | `packages/client/src/client.ts` + `speech-handle.ts` + `types.ts` + `state.ts` | ✅ |
| v3/v4 handshake + v4 codec 测试 | `packages/protocol/test/live-speech-protocol.test.ts` + `speech-protocol.test.ts` + `protocol.test.ts` 更新 | ✅ |

**测试结果（V5 边界内）**：

```text
protocol: 271 passed（含 live-speech-protocol 新增 38 例 + 旧 speech/protocol 兼容更新）
server:   218/222 passed（V5 文件全绿；4 个失败在 test/live-text-projector.test.ts，
         属于 V6 territory，未追踪）
client:   typecheck 绿
check:ts-imports: 0
git diff --check: 0
```

> V6 的 `packages/server/src/voice/live/text-projector.ts` 是 V6 task 拥有的在制品；V5
> 不触碰 live/ 子目录，与 V6 严格并行。

---

## 2. Pi Protocol v4 schema 表

| 类型 | Schema 名 | 说明 |
| --- | --- | --- |
| `LiveSpeechStatus` | `LiveSpeechStatusSchema` | `waiting_for_text/generating/streaming/completed/cancelled/failed`（Strict Union） |
| `LiveSpeechProgress` | `LiveSpeechProgressSchema` | `{ committedUtterances, completedUtterances, pendingCharacters }`，均 `>= 0` |
| `LiveSpeechErrorCode` | `LiveSpeechErrorCodeSchema` | 9 个错误码（见 §3.5） |
| `LiveSpeechError` | `LiveSpeechErrorSchema` | `{ code, message }` |
| `LiveSpeechJob` | `LiveSpeechJobSchema` | id/sessionId/voiceProfileId/status/streamPath/createdAt/updatedAt + 可选 turnId/messageId/firstChunkAt/audio/error + required progress |
| `LiveSpeechRequest` | `LiveSpeechRequestSchema` | `{ mode:"live", voiceProfileId? }` |
| 命令 | `CancelLiveSpeechCommandSchema` | `{ command, jobId }` |
| 结果 | `CancelLiveSpeechResultSchema` | `{ command, job: LiveSpeechJob }` |
| 事件 | `LiveSpeechJobEventSchema` | `{ type:"live_speech_job", job }` |
| capability | `VoiceCapabilitySchema`（已扩展） | `{ available, live, defaultProfile, profiles? }` |

- 全部 `StrictObject`（`additionalProperties: false`）；`ResultForCommand` 对 `prompt` /
  `cancel_live_speech` 静态解析。
- `speech` **只**挂在 `PromptCommandSchema`，**不**挂在 `SteerCommandSchema`（V2 §6
  与 Phase 2 §7.6 一致）。

### 2.1 Wire 示例

```jsonc
// prompt with live opt-in
{ "type":"request", "id":"r1",
  "request":{ "command":"prompt", "sessionId":"s1", "text":"hi",
               "speech":{ "mode":"live" } } }

// prompt result carrying the live job
{ "type":"response", "id":"r1", "ok":true,
  "result":{ "command":"prompt",
             "session":<SessionSnapshot>,
             "liveSpeech":{ "id":"j1", "sessionId":"s1",
                            "voiceProfileId":"default",
                            "status":"waiting_for_text",
                            "streamPath":"/api/pi/v4/live-speech/j1/stream",
                            "createdAt":1, "updatedAt":1,
                            "progress":{ "committedUtterances":0,
                                         "completedUtterances":0,
                                         "pendingCharacters":0 } } } }

// live_speech_job event
{ "type":"event",
  "event":{ "type":"live_speech_job",
            "job":{ "id":"j1", "status":"streaming", "firstChunkAt":2,
                    "audio":{ "encoding":"pcm_f32le","sampleRate":24000,"channels":1 },
                    "progress":{ "committedUtterances":1, "completedUtterances":1,
                                 "pendingCharacters":0 } } } }

// cancel_live_speech
{ "type":"request", "id":"r2",
  "request":{ "command":"cancel_live_speech", "jobId":"j1" } }
```

### 2.2 版本迁移

- `PROTOCOL_VERSION` 3 → 4。`isSupportedProtocolVersion(4) === true`；`(3) === false`。
- v3 client `hello{version:3}` 在 v4 server 上 `parseClientMessage` 仍合法（schema
  允许 integer），但 `isSupportedProtocolVersion(3) === false`，server 在
  `finishHandshake` 返回 `hello_error{code:"version"}`。无静默降级。
- `speech` / `live` / `liveSpeech` 是 v4-only 字段；v3 client 不识别时直接被
  `StrictObject` 拒绝（`Unknown field: speech`）。
- 旧 `SpeechJob` / `start_speech` / `cancel_speech` / `speech_job` event / `available`
  capability 完全不变。

---

## 3. 决策测试（冻结）

| # | 决策 | 测试位置 |
| --- | --- | --- |
| 1 | prompt 不带 `speech` 的 v3 语义保持不变 | `live-speech-protocol.test.ts > LiveSpeechRequest schema > keeps prompt without speech wire-compatible with v3` |
| 2 | `speech` 只接受 `{mode:"live", voiceProfileId?}` | `LiveSpeechRequest schema > rejects a speech request with an unknown mode` |
| 3 | `liveSpeech` 只在 result 中可选出现 | `PromptResult with optional liveSpeech` describe |
| 4 | Live Job 的 turnId/messageId/audio/error 可选组合 | `LiveSpeechJob schema > accepts a live job with progress and optional ...` |
| 5 | terminal 状态不可由 client handle 回退 | `speech-handle.ts > LiveSpeechJobHandleImpl > #isStale`（与 Phase 1 `SpeechJobHandleImpl` 镜像） |
| 6 | `live_speech_job` 不进入 SessionSnapshot | `client.ts > #handleMessage`：`live_speech_job` 走 `#dispatchLiveSpeechJob`，**不**调用 `state.applyEvent`；`state.ts > applyResult` 中 `cancel_live_speech` 与 `start_speech` / `cancel_speech` 一起短路返回，不写 session |
| 7 | `live:false` 是合法能力降级 | `speech-protocol.test.ts > server snapshot exposes voice capability when present`（`live: false` + V8 时 `live: true` 各一例） |
| 8 | v3 hello 对 v4 server 明确 version error | `protocol.test.ts > uses protocol version 4` + `speech-protocol.test.ts > protocol v4 versioning and wire round-trip` |
| 9 | `speech` **不**泄漏到 steer | `live-speech-protocol.test.ts > LiveSpeechRequest schema > does not leak 'speech' onto steer commands` |

---

## 4. Server / Client 编译边界

### 4.1 Server

- `packages/server/src/sessions.ts > executeCommand` 增加 `case "cancel_live_speech"`：
  抛 `PiServerError("invalid_state", "Live speech is not available on this server build")`。
  Phase 1 `start_speech` / `cancel_speech` 仍由 `server.ts > isSpeechCommand` 路由到
  `SpeechManager`，未变。
- `packages/server/src/voice/speech-manager.ts > getCapability` 增加 `live: false`（V5
  freeze；V8 coordinator 落地后切换 `live: true`）。
- `packages/server/src/voice/types.ts > VoiceCapability` 镜像协议层加 `live: boolean`。

### 4.2 Client

- `packages/client/src/types.ts` 新增 `LiveSpeechJobHandle` interface。
- `packages/client/src/speech-handle.ts` 新增 `isLiveSpeechTerminal`、`LiveSpeechJobHandleImpl`
  与 `LiveSpeechJobHandleDeps`（镜像 Phase 1 形状，便于 V8/V9 直接替换实现）。
- `packages/client/src/client.ts`：
  - `#liveSpeechHandles` 路由表 + `#dispatchLiveSpeechJob`（与 Phase 1 并列）。
  - `#handleMessage` 识别 `live_speech_job` 事件并走 live 路由，**不**写入 session。
  - `cancelLiveSpeech(jobId)` 发送 `cancel_live_speech` 命令并返回 latest result。
  - `registerLiveSpeechHandle(job)` 注册句柄（V8/V9/test fixture 用，不破坏现有 API）。
  - `#handleConnectionStateChange` 与 `dispose()` 中清空 `#liveSpeechHandles`。
- `packages/client/src/state.ts > applyResult` 中 `cancel_live_speech` 与
  `start_speech` / `cancel_speech` 一起短路，不写 session。

---

## 5. V8/V9 应消费的确切类型

```ts
import {
  PROMPT_COMMAND_SCHEMA,                  // v4 prompt 含可选 speech
  type LiveSpeechRequest,                 // { mode:"live", voiceProfileId? }
  type LiveSpeechJob,                     // 全字段（id, status, streamPath, progress, ...）
  type LiveSpeechStatus,                  // waiting_for_text/generating/streaming/completed/cancelled/failed
  type LiveSpeechProgress,                // 三个非负整数
  type LiveSpeechErrorCode,               // 9 个错误码
  type LiveSpeechError,                   // { code, message }
  type CancelLiveSpeechCommand,
  type CancelLiveSpeechResult,
  type LiveSpeechJobEvent,
  type VoiceCapability,                   // 含 live: boolean
  PROMPT_RESULT_SCHEMA,                   // v4 prompt result 含可选 liveSpeech
} from "@earendil-works/pi-protocol";
```

- V8 server coordinator 必须：
  1. 在 prompt 路径上调用 `runtime.prompt()` **之前**先创建 LiveSpeechJob 并
     注册 progress subscription（Spec §12）。
  2. 失败时原子取消 Job 并返回 `PromptResult`（无 `liveSpeech`）。
  3. 通过 `PiServer.sendMessage(connection, { type:"event", event:{ type:"live_speech_job", job }})`
     投递事件（**仅** owner connection，**不**进 SessionSnapshot）。
- V9 web UX 必须：
  1. 仅在 `snapshot.voice?.live === true` 时显示"实时朗读"入口；`false` 视为合法降级。
  2. `AudioContext.resume()` 在用户手势内成功后才发送带 `speech` 的 prompt；否则
     不带 `speech` 走文字 + Phase 1 手动朗读路径。
  3. consume `live_speech_job` 事件并按 `LiveSpeechStatus` 推进本地播放器。

---

## 6. 验收命令（V5 边界内）

```bash
# runtimes/pi，Node >=22.19（环境用 /home/hello/.nvm/versions/node/v22.23.2/bin）
npm run test --workspace=@earendil-works/pi-protocol      # 271 passed
npm run build --workspace=@earendil-works/pi-protocol
npm run typecheck --workspace=@earendil-works/pi-server    # V5 文件绿；V6 live/* 是另案
npm run typecheck --workspace=@earendil-works/pi-client    # 绿
npm run check:ts-imports                                   # 0
git diff --check                                           # 0
```

> V5 不触碰 `packages/server/src/voice/live/*`（V6 territory）与
> `packages/server/test/live-text-projector.test.ts`；这 4 个测试在 V6 修复前会
> 持续红，但不影响 V5 acceptance gate。

---

## 7. Spec 偏离 / ADR

| # | 偏离 | 理由 |
| --- | --- | --- |
| 1 | `VoiceCapability` **不**删除 `available`，**不**新增 `streaming: true`，仅新增 `live: boolean` | Phase 2 §7.6 写出 `streaming: true` + `live: boolean`，但任务单 §6 仅要求"增加 `live: boolean`"。保守增量避免破坏 Phase 1 server snapshot 消费方；V8 coordinator 落地后再决定是否一并升级。 |
| 2 | Server `cancel_live_speech` 走 `LiveSessionManager.executeCommand` 而非新 `LiveSpeechCoordinator` | V8 才需要 coordinator；V5 显式 stub 返回 `invalid_state` 比静默丢消息更可观察；client 仍可测 cancel 的 wire 与错误语义。 |
| 3 | Client 暴露 `registerLiveSpeechHandle(job)` 而非 `createLiveSpeechHandle` | V5 没有 server-side live job creator；保留 register-only API 防止 V8/V9 误以为可以本地伪造 job ID；`cancelLiveSpeech(jobId)` 仍是公开入口，可由未来外部 creator 注入句柄后调用。 |
| 4 | `speech` 仅出现在 `PromptCommandSchema`，**不**复制到 `SteerCommandSchema`（即使二者原本共享 `PromptPayloadProperties`） | Phase 2 Spec §6 与 V5 任务单明确只 opt-in 在 prompt；steer 朗读不在当前里程碑；显式拆开共享结构避免隐性放宽。 |
| 5 | Server capability 显式 `live: false`，**不**由 SnapshotPublisher 决定 | 当前 `getCapability()` 由 SpeechManager 唯一提供；与 Phase 1 路径一致；V8 落地后只需修改 `getCapability()`，无需改 publisher/snapshots。 |

无破坏冻结 schema 的接口变更（`SpeechJob` / `start_speech` / `cancel_speech` /
`speech_job` 字段未变）。

---

## 8. 给 V8/V9 的提示

- 完整类型表 + ResultForCommand 推导在 §5。V8/V9 应直接 import 协议层类型，不要
  在 server/client 内部再定义一次。
- V8 coordinator 需要 `LiveSpeechJob` 全字段（status / progress / audio / error / turnId
  / messageId / firstChunkAt）；不要遗漏 `progress`（V5 schema 设为 required，避免
 后续补字段导致 snapshot diff）。
- V9 web 在 `live: false` 时**不要**报错——按"未配置"处理，与 `voice` 字段缺失一致
  （隐藏入口 + 复用 Phase 1 手动朗读）。
- `live_speech_job` 事件被 V5 client 路由到 `#liveSpeechHandles`；`registerLiveSpeechHandle`
  是 V8 server-issued job 的官方注册入口。
- V8 HTTP 路由固定为 `/api/pi/v4/live-speech/{jobId}/stream`（与 Phase 1
  `/api/pi/v3/speech/{jobId}/stream` 隔离）；Phase 1 路由、claim/expire 规则不变。