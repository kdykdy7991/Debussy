# V8 Handoff: Server Live Speech Coordinator

状态：Review / **Integration ready**
任务：[`../tasks/V8-server-live-coordinator.md`](../tasks/V8-server-live-coordinator.md)
总规范：[`../PI-LIVE-AGENT-SPEECH-SPEC.md`](../PI-LIVE-AGENT-SPEECH-SPEC.md)

V8 完成 Phase 2 服务端编排：`prompt` 携带 `speech:{mode:"live"}` 时，Pi Server 在调用
`runtime.prompt()` 之前原子创建 `LiveSpeechJob` 并注册 runtime progress listener，
把第一条 assistant item 绑定为 messageId，只投影匹配的 text delta，驱动 V6/V7
（projector → segmenter → queue），并通过一条受鉴权的 `GET /api/pi/v4/live-speech/:id/stream`
HTTP response 向浏览器连续输出多个 utterance 的 PCM。`voice.live` 能力在 voice 配置时翻转为
`true`。V9（Web UX）可在本接口上接线。

## 1. 产物

| 文件 | 角色 |
| --- | --- |
| `runtimes/pi/packages/server/src/voice/live/live-speech-manager.ts` | `LiveSpeechManager`（job registry + prompt transaction + claim/cancel/lifecycle）+ `LiveSpeechRun`（per-job 协调器：projector→segmenter→queue、runtime listener、binding/filter、job 状态机、4 Hz 事件节流、timers） |
| `runtimes/pi/packages/server/src/voice/live/pending-pcm-sink.ts` | `PendingPcmSink implements PcmSink`：延迟写 headers 的 PCM sink、claim 前 park 写（backpressure）、204/502/stream 决策、downstream-close 检测 |
| `runtimes/pi/packages/server/src/web/live-speech.ts` | `createLiveSpeechHttpHandler`：`GET/OPTIONS /api/pi/v4/live-speech/:id/stream` 路由 |
| `runtimes/pi/packages/server/test/live-speech-manager.test.ts` | 单元测试（19 用例） |
| `runtimes/pi/packages/server/test/live-speech-server.test.ts` | HTTP E2E（7 用例） |

修改：`src/types.ts`（PiServerOptions.liveSpeech）、`src/server.ts`（bind host、disconnect/close 钩子）、
`src/sessions.ts`（prompt transaction、cancel_live_speech、steer/abort/detach/dispose/terminate 钩子）、
`src/voice/speech-manager.ts`（`live` 选项 + `hasActiveJob` + `liveBusyCheck`）、
`src/web/start.ts`（buildVoiceLayer 构建 LiveSpeechManager + live HTTP handler、能力翻转）、
`src/transports/websocket/preset.ts` + `src/transports/unix/preset.ts`（转发 `liveSpeech` 到 PiServer）。

V5 协议 schema、V6/V7 冻结 API 均未改动。

## 2. 公开 API（frozen）

```ts
import {
  LiveSpeechManager,
  LIVE_SPEECH_STREAM_PATH_PREFIX,   // "/api/pi/v4/live-speech"
} from "@earendil-works/pi-server/voice/live/live-speech-manager";

const manager = new LiveSpeechManager({
  voiceClient,                 // 复用 Phase 1 VoiceServiceClient
  profiles,                    // readonly VoiceProfile[]
  defaultProfileId: "default",
  claimTtlMs: 30_000,          // 30s 未 claim 过期
  firstTextTimeoutMs: 60_000,  // 60s 无 text → turn_not_started
  maxDurationMs: 10 * 60_000,  // 总时长上限
  retentionMs: 5 * 60_000,     // 终态保留
  jobEventIntervalMs: 250,     // 4 Hz 事件节流
  idleFlushMs: 1_000,          // segmenter idle 驱动
  speechBusyCheck: (conn) => boolean,   // Phase 1 manual ↔ live 互斥
  clock, uuid,                 // 可注入（测试）
});
manager.bind({ sendJobEvent, reportError });

const { job, rollback } = manager.prepare({
  connection, runtime: live.runtime, sessionId, speech: { mode: "live", voiceProfileId? }, turnId,
});            // 同步原子；listener 在返回前已注册
manager.claimStream(jobId);    // ok | not_found | claimed | expired
await manager.executeCancel(connection, { command: "cancel_live_speech", jobId });
manager.abortConnectionJobs(conn);           // disconnect
manager.abortConnectionSessionJobs(conn, sessionId); // detach
manager.abortSessionJobs(sessionId, reason, msg);    // steer/abort/dispose/terminate
manager.close();                               // shutdown
manager.hasActiveLiveJob(conn);                // Phase 1 互斥
```

`LiveSpeechRun`（per-job，内部）持有 `job`、`claimed`、`terminal`、`bytesWritten`、
`committedUtterances`/`completedUtterances`、`attachResponse(response)`、`cancel(reason, code, msg)`、
`fail(code, msg)`、`setStatus(status)`。`PendingPcmSink` 实现 `PcmSink` 三方法 +
`attach`/`setFormat`。

## 3. Prompt transaction 时序

```text
Web ── prompt{speech:{mode:"live"}} ──► LiveSessionManager.executeCommand("prompt")
  1. requireAttached(session)                       // owner + session 校验
  2. preparePromptInputs(...)                       // 附件/检索（async，不发 runtime 事件）
  3. liveSpeech.prepare({connection, runtime, sessionId, speech, turnId})
       ├─ busy 校验：connection 或 session 已有非终态 run → busy
       ├─ resolveProfile → not_found
       ├─ 创建 LiveSpeechJob(waiting_for_text) + LiveSpeechRun
       └─ run.start()：runtime.subscribe(listener)   ◄── 同步，先于 prompt()
                     + 布 claim/firstText/maxDuration/idle 定时器
  4. runOperation(() => runtime.prompt(...))        // Agent 开始生成；delta 同步流入 run
  5. 成功 → { command:"prompt", session, liveSpeech: job }（job 原位变异，始终最新）
     失败 → prepared.rollback()（unsubscribe、queue.cancel、drop，无事件无保留）
```

关键保证：

- `prepare` 是**同步**的：busy 校验、job 创建、listener 注册在同一个同步块内完成，两个并发
  prompt 不可能同时通过校验，且 listener 保证注册于 `runtime.prompt()` 之前——首 delta 不丢。
- job 对象**原位变异**（`Object.assign`），因此 PromptResult 里的 `liveSpeech` 始终是当前
  状态而非旧快照。
- prompt 失败（`runtime.prompt` 抛错或后续 citation persist 抛错）→ rollback 原子清理，
  客户端从未拿到 job handle，无泄漏。

## 4. Binding / filter

`LiveSpeechRun.handleRuntimeEvent` 只消费绑定项的 assistant text delta：

```text
item_started (assistant, timestamp >= job.createdAt)  → 绑定 messageId=item.id，set turnId/messageId
assistant_delta (messageId === bound && kind === "text")
    → projector.project(delta) → segmenter.push → 逐条 queue.enqueue
item_finished (item.id === bound)
    → status complete: projector.flush + segmenter.flush + queue.closeInput
    → status error/aborted: queue.cancel("agent_abort")
idleTick (1s)：segmenter.tick(now) → enqueue（Agent 句中停顿也提交 idle_timeout utterance）
```

忽略：tool item、跨 turn 迟到 item（timestamp < createdAt）、其他 messageId 的 delta、
thinking/toolCall delta（绝不朗读）。

## 5. Session boundary / lifecycle

- 每连接每 session 一个活动 live job（`prepare` busy 校验）。
- `cancel_live_speech`：owner-only，`queue.cancel("user_cancel")`，**不调用 `runtime.abort()`**。
- Agent abort/steer：命令处理器在 `runOperation` 前调 `abortSessionJobs(sessionId, "agent_abort"/"agent_steer")`；
  第一版 steer 后不自动重启语音。abort 也通过 runtime 事件流的 `item_finished(aborted)` 触达。
- disconnect：`PiServer.disconnect` → `liveSpeech.abortConnectionJobs(conn)`。
- detach：`abortConnectionSessionJobs(conn, sessionId)`。
- session dispose/terminate：`abortSessionJobs(sessionId)`。
- shutdown：`liveSpeech.close()` 在 `sessions.close()` 之前（先让 run 从 runtime 退订、中止上游）。

## 6. HTTP contract

`GET/OPTIONS /api/pi/v4/live-speech/{jobId}/stream`，鉴权/CORS/Host 完全复用
`createHttpAuthorizer`（同 Phase 1）。

- OPTIONS → 204（Origin 未允许 → 403）。
- 未授权 → 401；非 GET → 405；manager 缺失 → 404。
- `claimStream`：not_found → 404；已 claim → 409 `live_speech_stream_claimed`；终态（completed
  且未写字节除外）→ 410 `live_speech_stream_expired`。
- 单次 claim；`completed && bytesWritten===0` 例外允许晚到的 GET 仍拿到 204。
- 成功响应由 sink 驱动：首 PCM 字节写 headers（`content-type: application/vnd.pi.pcm`、
  `cache-control: no-store`、`x-content-type-options: nosniff`、`x-pi-live-speech-job-id`、
  `x-pi-audio-encoding/sample-rate/channels`、`access-control-expose-headers`），随后带
  backpressure 流式写出。
- 无可朗读文本 → 204；首字节前失败 → 502 JSON；已写 PCM 后失败 → destroy。
- downstream close（浏览器断连）→ `abortFromDownstream` → `queue.cancel("downstream_close")`。

## 7. 配置

无新环境变量。voice 配置（`PI_VOICE_URL`/`PI_VOICE_TOKEN`/`PI_VOICE_DEFAULT_PROFILE`/
`PI_VOICE_PROFILES`）存在时 `buildVoiceLayer` 同时构建 `SpeechManager` 与 `LiveSpeechManager`，
`SpeechManager` 以 `live: true` 发布 `voice.live` 能力。voice 未配置时两者都不建，`voice`
能力从 snapshot 缺席，live 请求不影响文字 prompt（`this.options.liveSpeech?.prepare` 为
undefined → 无 job、无事件）。

## 8. 状态机

```text
waiting_for_text ──(首 enqueue/started)──► generating ──(首 PCM 字节)──► streaming
      │                                                    │
      ├─(claim 后未锁格式) generating 保持                    └─(queue 排空)──► completed
      └─(queue 排空，无字节)───────────────────────────────► completed (204)
terminal: completed | cancelled | failed
```

- `cancelled`：user_cancel / agent_abort / agent_steer / owner_disconnect / downstream_close /
  session_removed / shutdown。
- `failed` + error：`speech_backlog_exceeded`（queue 自失败）、`speech_generation_failed`
  （voice 失败 / format 不一致 / %4 校验）、`turn_not_started`（60s 无 text）、
  `live_speech_expired`（30s 未 claim / 10m 超时）。
- `progress`：`committedUtterances`/`completedUtterances` 由 queue `enqueued`/`completed`
  事件累加；`pendingCharacters` = `Σ(enqueued.characters) − Σ(completed.characters) −
  Σ(discarded.characters)`，经 `charsBySequence` map 维护。
- 事件节流：milestone（bind/generating/streaming/terminal）立即发；进度更新 coalesce 到
  250 ms（4 Hz），flush 最新 `run.job`。
- `settleRun` 单一幂等终态路径：清全部 timer + idle interval、退订 runtime、abort controller、
  `sink.fail`/`queue.cancel`、强制发终态、布 retention → drop。

## 9. Cleanup ownership

| 触发 | 调用 | Queue 终止方式 |
| --- | --- | --- |
| WS disconnect | `abortConnectionJobs` | `cancel("owner_disconnect")` |
| detach | `abortConnectionSessionJobs` | `cancel("session_removed")` |
| steer / abort | `abortSessionJobs` | `cancel("agent_steer"/"agent_abort")` |
| session dispose / runtime error | `abortSessionJobs` | `cancel("session_removed"/"agent_abort")` |
| browser close | sink `onDownstreamClosed` → `abortFromDownstream` | `cancel("downstream_close")` |
| `cancel_live_speech` | `executeCancel` | `cancel("user_cancel")`（不 abort Agent） |
| shutdown | `close()`（先于 sessions.close） | `cancel("shutdown")` |
| 自然排空 | `item_finished complete` → flush → `closeInput` | `completed` |

所有路径都收敛到同一个幂等清理：清 timer、退订、abort controller、`sink.fail`、
`queue.cancel`、强制终态事件、retention → drop。无 timer/listener/reader 泄漏。

## 10. 与 V9 的接口示例

```ts
// Web 侧（V9）——示意
const job = promptResult.liveSpeech;                 // { command:"prompt", ..., liveSpeech }
client.registerLiveSpeechHandle(job);                // 订阅 live_speech_job 事件
const stream = await openSpeechStream({              // 复用 client helper，V9 需补 204 处理
  baseUrl, token, streamPath: job.streamPath,
});
// 播放器复用 V3 PcmDecoder/AudioPlayer；Stop → 停 nodes + abort GET + cancel_live_speech
```

V9 注意点：当前 client `openSpeechStream` 对 204（无朗读文本）会抛 `invalid_audio_format`，
V9 需在调用方识别 204 并视为「无朗读内容，不报错」。`live` 与 `manual` 播放互斥由 V9 处理。

## 11. 测试结果

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # repo 要求 node >=22.19
cd runtimes/pi
npm run test --workspace=@earendil-works/pi-protocol        # 271 passed
npm run test --workspace=@earendil-works/pi-server          # 300 passed（含 live-speech 26）
npm run typecheck --workspace=@earendil-works/pi-server     # clean
npm run build --workspace=@earendil-works/pi-server         # clean
npm run check                                               # 全绿（biome/ts-imports/shrinkwrap/tsgo/pi-web/browser-smoke）
git diff --check                                            # clean
```

- **单元（19）**：prompt transaction（busy/profile/rollback）、listener-before-prompt 同步首事件、
  binding/filter（tool/跨 turn/其他 messageId/thinking/toolCall）、3 utterances→3 upstream→1
  response、204 无文本、aborted 取消、claim 单次/expired、cancel owner-only、downstream close、
  disconnect、steer、first-text timeout、shutdown。
- **HTTP E2E（7）**：prompt+speech 全链路（3 utterance → 200 + 逐 utterance 字节序 + completed）、
  hello snapshot `voice.live=true`、401、404、409 双 claim、204、`cancel_live_speech` 取消但不
  abort Agent、无 speech 的 prompt 无 liveSpeech。
- 修复 V8 过程中发现并解决的两个**预存 gate 阻塞**（非 V8 引入）：
  1. `packages/protocol/test/live-speech-protocol.test.ts` + `speech-protocol.test.ts` 的
     测试 builder 弱类型导致根 `tsgo --noEmit` 失败（`startSpeechRequest`/`promptWithSpeech`
     返回 `ClientMessage`/`Command` 并修 `voiceProfileId`/`type` 字面量、`speechEvent` 传参
     补 cast、`delete` 行 cast）。
  2. `packages/web/test/` 三处 fixture 缺失 V5 新增的 `voice.live` 字段 + `protocolVersion` 仍为
     3（改为 4），导致 pi-web typecheck 失败。
- 另外 Biome 门在 V6/V7 遗留文件（`text-projector`/`text-segmenter`/`utterance-queue`/
  `live-text-segmenter.test`）清理了 10 处 `noUnusedVariables`/`useTemplate` 警告（下划线改名、
  模板字面量，均为纯 cosmetic，API 不变）。

## 12. 已知风险与决策

- **`completed && bytesWritten===0` 例外**：bodyless 终态 job 仍可 claim，晚到的 GET 拿到 204
  （而非 410），保证「无朗读文本」不误报为过期。
- **sink 延迟终态**：queue 可能在 browser claim 之前就完成（如 204 场景），sink 以
  `wantsClose`/`wantsFail` 记录，attach 时立即应用——避免「closed 后再 close 被幂等拦截」。
- **job 原位变异**：`Object.assign` 更新共享 job 对象，保证 PromptResult.liveSpeech 与
  `live_speech_job` 事件始终反映当前状态。事件在发送时同步 CBOR 序列化，无别名污染。
- **4 Hz 节流只作用于进度**：milestone/终态总是立即发，客户端不会看到迟到的终态。
- **首次 text 计时**：`firstTextTimer` 在首条投影 delta 和 `item_finished` 时清除；60s 内
  turn 结束且无文本 → 正常 204；60s 无文本且 turn 未结束 → `turn_not_started`。
- **互斥**：Phase 1 manual speech 与 live 通过 `liveBusyCheck`/`speechBusyCheck` 双向互斥
  （buildVoiceLayer 里交叉注入）。
- **Node 版本**：repo 声明 `>=22.19`；本环境默认 Node 20.20.2 会因 undici 8.5.0（被
  pi-coding-agent 引用）在模块加载崩溃，5 个 server 集成测试文件无法加载。**所有 gate 必须
  在 Node 22.23.2 下运行**（`PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"`）。这是
  环境版本问题，非代码缺陷。
- **prompt 无 voice 配置**：`liveSpeech` 为 undefined 时 `speech` 请求被静默忽略（文字照常），
  符合「未配置 voice 不影响文字 prompt」。

## 13. 冻结范围 / 交接

- `LiveSpeechManager` 公开方法、`LiveSpeechRun`/`PendingPcmSink` 契约、HTTP 路由前缀与
  状态码、错误码映射、默认常量（claim 30s / first-text 60s / max-duration 10m / retention 5m /
  4 Hz）在 V8 冻结。V9 不反向修改。
- V9 接线见 §10；真实 V1 Voice Service smoke 与 20-turn 泄漏检查需在 V1/V2 联调环境中进行
  （本任务用 fake upstream/downstream 完成自动化）。
- 任务单状态与 `docs/voice/tasks/README.md` 表更新为 `Review / Integration ready`。
