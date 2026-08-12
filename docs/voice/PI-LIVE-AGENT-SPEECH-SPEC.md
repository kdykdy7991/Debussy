# Pi Agent 增量实时语音规范（Phase 2）

状态：Ready for implementation  
目标版本：Pi Protocol v4  
范围：Agent 文本生成期间自动分段、排队、合成和播放  
不包含：Avatar、ASR、viseme、服务端音频持久化  
日期：2026-08-12

## 1. 背景与基线

Phase 1 已实现或进入 Review：

- V1：Voice Service `POST /v1/synthesize/stream`，输入一段完整文本，输出连续
  `pcm_f32le`。
- V2：Protocol v3 SpeechJob、Pi Server 受鉴权 PCM proxy、取消和 owner connection。
- V3：Pi Client SpeechJob API、PCM parser、Web Audio scheduler、手动朗读 UI。
- V4：Avatar bridge 第一版；不属于当前核心里程碑，冻结为 Deferred/Experimental。

Phase 1 的语义是：

```text
assistant message complete
  -> start_speech(messageId)
  -> one Voice Service request
  -> browser stream/play
```

Phase 2 的目标是：

```text
assistant_delta still arriving
  -> server incrementally extracts speakable text
  -> segmenter commits natural utterances
  -> ordered queue invokes Voice Service once per utterance
  -> one browser PCM response remains open across utterances
  -> playback begins before the assistant message completes
```

Phase 2 是增量扩展，不删除或改变 Phase 1 手动朗读。实时模式故障时，文字对话和完成后
手动朗读必须仍可使用。

## 2. 可行性结论

当前 Qwen3-TTS streaming API 接受一段已知文本并流式产生该段的音频，不支持在同一次
模型调用中持续追加 Agent token。因此“每个 token 立即 TTS”不可行且不合理。

本规范将“实时”定义为：

> Agent 形成第一个稳定自然语义片段后，立即开始该片段的 TTS；后续文本继续生成、分段
> 和排队。用户不等待完整 assistant message。

Voice Service 仍按 utterance 接收完整短文本；Pi Server 将多个 utterance 的、格式一致的
PCM 串接进一个 browser HTTP response。

## 3. 产品效果

1. 用户在 Pi Web 开启“实时朗读”。
2. 用户点击发送时，Web 在该用户手势内解锁 `AudioContext`。
3. prompt 与 live speech 请求原子提交。
4. Agent 文字照常增量显示。
5. 第一完整句或兜底片段形成后开始 TTS，并在首个 PCM chunk 后播放。
6. Agent 继续输出的同时，后续句子排队生成并连续播放。
7. 用户点击“停止朗读”只停止语音，不中止 Agent。
8. 用户 abort Agent、steer、切换 session、断线或刷新时，旧语音任务与队列被取消。
9. Voice Service 不可用时，文字对话不受影响，并保留 Phase 1 手动重试入口。

## 4. 非目标

- token、单字或单词级 TTS。
- 声音精确对齐屏幕 token。
- Markdown/代码的完美语义朗读。
- 同一浏览器连接同时播放多个 turn。
- 在服务端保存语音或断线后恢复到精确播放位置。
- 跨设备接续一个 live speech stream。
- 数字人、Rive、Avatar speech bridge、audioLevel、口型。
- ASR、麦克风、唤醒词、全双工语音对话。

## 5. 总体架构

```text
Pi Web
  │ PromptCommand { speech: { mode: "live" } }
  ▼
Pi Server
  ├─ Agent session runtime
  │    └─ item_started / assistant_delta / item_finished
  ├─ LiveSpeechCoordinator
  │    ├─ SpeakableTextProjector
  │    ├─ IncrementalTextSegmenter
  │    └─ UtteranceQueue
  └─ one browser HTTP PCM stream
           │
           ├─ utterance 1 -> Voice Service stream ┐
           ├─ utterance 2 -> Voice Service stream ├─ concatenated PCM
           └─ utterance N -> Voice Service stream ┘
  ▼
Pi Web PcmDecoder -> AudioPlayer
```

### 5.1 所有权

- Agent Runtime 是 transcript 和 progress 的权威来源。
- Pi Server 负责选择可朗读文本、分段、排队、调用 TTS、顺序和取消。
- Voice Service 只负责把一个 utterance 转成 PCM，不理解 turn 或队列。
- Web 只负责 opt-in、AudioContext 解锁、读取一个 PCM stream、播放和停止。
- Client 不将 `assistant_delta` 文本回传 Server。

### 5.2 控制面与数据面

- 控制面：Pi Protocol v4 WebSocket。
- 数据面：`GET /api/pi/v4/live-speech/{jobId}/stream`。
- PCM 不进入 CBOR、transcript、SessionSnapshot、session event log 或持久化存储。

## 6. Prompt 原子关联

不采用“Web 收到第一条 delta 后再发送 start_live_speech”，因为会产生首批 delta
丢失/重复、snapshot-subscribe 窗口和 turn/message 绑定竞态。

Phase 2 在 `PromptCommand` 增加可选 `speech`。Pi Server 在调用 runtime `prompt()` 前先
创建 LiveSpeechJob 和 progress subscription；若 prompt 失败则原子取消 Job。

```ts
interface LiveSpeechRequest {
  mode: "live";
  voiceProfileId?: string;
}

interface PromptCommand {
  command: "prompt";
  sessionId: string;
  text: string;
  attachmentIds?: string[];
  speech?: LiveSpeechRequest;
}
```

未带 `speech` 时行为与 Phase 1 完全一致。

## 7. Pi Protocol v4

### 7.1 版本与兼容

`PROTOCOL_VERSION` 从 3 升为 4。v3 与 v4 使用现有握手不兼容机制，不静默忽略
`speech`。Phase 1 `start_speech`、`cancel_speech` 和 `SpeechJob` 保持兼容。

### 7.2 LiveSpeechJob

```ts
type LiveSpeechStatus =
  | "waiting_for_text"
  | "generating"
  | "streaming"
  | "completed"
  | "cancelled"
  | "failed";

interface LiveSpeechProgress {
  committedUtterances: number;
  completedUtterances: number;
  pendingCharacters: number;
}

interface LiveSpeechJob {
  id: string;
  sessionId: string;
  voiceProfileId: string;
  status: LiveSpeechStatus;
  streamPath: string;
  createdAt: number;
  updatedAt: number;
  turnId?: string;
  messageId?: string;
  firstChunkAt?: number;
  audio?: {
    encoding: "pcm_f32le";
    sampleRate: number;
    channels: 1;
  };
  progress: LiveSpeechProgress;
  error?: {
    code: LiveSpeechErrorCode;
    message: string;
  };
}
```

`turnId/messageId` 在对应 `item_started` 到达后填入。`completed` 表示 Agent turn 已结束、
segmenter 已 flush、queue 已耗尽且 Server PCM response 已结束；浏览器仍可能 draining。

### 7.3 PromptResult

```ts
interface PromptResult {
  command: "prompt";
  session: SessionSnapshot;
  liveSpeech?: LiveSpeechJob;
}
```

只有请求携带 live speech 且成功创建 Job 时存在 `liveSpeech`。

### 7.4 取消与事件

```ts
interface CancelLiveSpeechCommand {
  command: "cancel_live_speech";
  jobId: string;
}

interface CancelLiveSpeechResult {
  command: "cancel_live_speech";
  job: LiveSpeechJob;
}

interface LiveSpeechJobEvent {
  type: "live_speech_job";
  job: LiveSpeechJob;
}
```

- 只有 owner connection 可取消；取消幂等且不调用 Agent `abort()`。
- Job event 只发 owner，不进入 session replay。
- 至少在绑定 turn/message、首 utterance、generating、首 PCM、进度和终态时发事件。
- 高频进度应节流，建议不高于 4 Hz。

### 7.5 错误码

```ts
type LiveSpeechErrorCode =
  | "voice_unavailable"
  | "voice_profile_not_found"
  | "live_speech_busy"
  | "live_speech_expired"
  | "turn_not_started"
  | "unsupported_content"
  | "speech_backlog_exceeded"
  | "speech_generation_failed"
  | "speech_cancelled";
```

同步校验沿用 ProtocolError。Job 创建后的错误进入 `LiveSpeechJob.error`。

### 7.6 Voice capability

```ts
interface VoiceCapability {
  streaming: true;
  live: boolean;
  defaultProfileId: string;
  profiles: VoiceProfileSummary[];
}
```

V8 完成前 Server 发布 `live: false`；正式能力通过后才发布 `live: true`。

## 8. Browser HTTP live stream

```http
GET /api/pi/v4/live-speech/{jobId}/stream
Authorization: Bearer <PI_WEB_TOKEN>
```

成功 headers 与 Phase 1 相同。一个 Job 只允许 claim 一次；GET 可在第一 utterance 前
建立，headers 在第一 Voice Service response 确认格式后发送。utterance 间保持 response
打开，不插入 WAV header、JSON、边界 marker 或静音。

- 所有 utterance 必须保持相同 encoding/sample rate/channels。
- Agent turn 完成后还需 flush segmenter 并耗尽 queue。
- 无可朗读文本推荐 `204 No Content`，由 V8 contract test 最终冻结。
- 30 秒未 claim 过期；等待第一片段默认 60 秒；总时长默认 10 分钟。
- 每连接、每 session 最多一个活动 live Job。
- 与 Phase 1 manual job 共享全局语音并发和页面单播放器约束。
- 鉴权、Host、Origin、CORS、loopback、token header 规则完全复用 Phase 1。

## 9. Speakable text projection

只消费绑定 assistant item 的 `assistant_delta(kind="text")`。永不朗读 thinking、toolCall、
tool result、diagnostics、用户 prompt 和其他 turn/message 的迟到事件。

增量 Markdown projector 第一阶段规则：

- 普通文本、标题和列表项可朗读。
- emphasis/link 标记移除；链接只读 label，不读 URL。
- fenced code 内容默认跳过。
- inline code 保留内容但移除 backtick。
- 图片只读非空 alt。
- HTML tag 移除且不执行。
- 表格按行投影，不读 `|`。

Projector 必须保存跨 delta 的 code fence、backtick、link、HTML 状态，不能逐 delta 独立
regex。输出只允许追加，已经 committed 的文本不可修改。

## 10. IncrementalTextSegmenter

```ts
interface Segmenter {
  push(text: string, now: number): readonly CommittedUtterance[];
  tick(now: number): readonly CommittedUtterance[];
  flush(now: number): readonly CommittedUtterance[];
  reset(): void;
}

interface CommittedUtterance {
  sequence: number;
  text: string;
  reason: "terminal_punctuation" | "paragraph" | "soft_limit" | "idle_timeout" | "turn_end";
}
```

默认参数：

```text
minCharacters = 12
targetCharacters = 60
maxCharacters = 120
idleFlushMs = 1000
```

规则：

1. `。！？` 和可靠的 `.?!` 为强边界，达到最短长度立即 commit。
2. 过短句暂存并与下一片段合并，turn end 除外。
3. 达到 target 后优先在 `；;：:，,` 或空格 commit。
4. 达到 max 必须 commit。
5. 已达到 min 且 idle timeout 无新文本时在最佳软边界 commit。
6. turn finished 时 flush 所有非空剩余文本。
7. 一旦 committed 不可撤回、合并或重排。

必须正确处理小数、版本号、域名、中英文混合、引号括号、emoji、长无标点、Unicode 和
任意 delta 分割。

## 11. UtteranceQueue

```ts
interface Utterance {
  sequence: number;
  text: string;
  status: "queued" | "generating" | "streaming" | "completed" | "discarded" | "failed";
  committedAt: number;
}
```

- 单 Job 严格按 sequence、单 Voice Service request in flight。
- N 完整 upstream EOF 后才启动 N+1，不做并行生成重排。
- downstream backpressure 会暂停 upstream，也会阻止 N+1 启动。
- 第一 utterance 冻结 audio format；后续格式变化立即失败。
- 文本仅存内存，不进协议、普通日志或持久化。

默认 backlog：

```text
maxQueuedUtterances = 12
maxQueuedCharacters = 1200
maxEstimatedAudioSeconds = 90
```

超限时 Job 失败为 `speech_backlog_exceeded`，取消当前 TTS并清空队列，但 Agent 继续。

## 12. LiveSpeechCoordinator

创建顺序：

1. 校验 session attach、profile、连接/session 无活动 live Job。
2. 创建 Job、AbortController、projector、segmenter、queue。
3. 在 runtime prompt 前注册 progress listener。
4. 调用 runtime prompt。
5. prompt 失败时取消 Job并清理。
6. 返回带 `liveSpeech` 的 PromptResult。
7. Web claim stream；Coordinator 等待第一 utterance。

绑定和结束：

- 第一条属于本 prompt operation 的 assistant `item_started` 绑定 messageId。
- matching session progress 绑定 turnId，之后忽略其他 item/turn。
- complete：projector flush -> segmenter flush -> queue close input。
- assistant error/aborted：取消未生成内容并关闭流。
- toolCall 不朗读；同一 turn 后续 text 可继续。

取消：

- `cancel_live_speech` 只取消语音。
- Agent `abort`、`steer` 取消旧 live speech；第一版 steer 后不自动恢复。
- disconnect、detach、session removal、HTTP close、shutdown 走同一幂等 cleanup。
- cleanup 包含 upstream abort、queue discard、timer clear、runtime unsubscribe 和 downstream close。

Coordinator 通过最小 progress/prompt lifecycle boundary 接入 `LiveSessionManager`，不得访问
其私有 map 或复制第二套 event log。

## 13. Client 与 Web

Client 增加 live prompt result、live Job event/handle、cancel 和 v4 HTTP helper。不得与
Phase 1 `SpeechJobHandle` 混淆。

Web：

- “实时朗读”默认关闭，仅 `voice.live=true` 时启用。
- 点击发送时先在用户手势内 `AudioContext.resume()`，成功后 prompt 带 `speech`。
- unlock 失败仍发送文字 prompt，但不请求 live speech。
- 复用 V3 PcmDecoder/AudioPlayer；utterance 边界对播放器透明。
- Stop 立即停止 nodes、abort GET、发送 cancel；Agent 继续。
- session switch、disconnect、pagehide、unmount 和新 prompt 清理旧 playback。
- live 与 manual 互斥；开始一种前先停止另一种。
- live 失败后，完成消息仍保留手动朗读。
- 当前里程碑不得 import 或挂载 Avatar bridge。

## 14. 性能预算

| 指标 | warm model 目标 |
| --- | --- |
| 稳定片段形成到 commit | < 50 ms |
| commit 到 Voice request | < 20 ms |
| utterance 首 PCM | < 1.5 s |
| Server 转发附加延迟 | < 50 ms |
| Web 初始缓冲 | 80–150 ms |
| utterance 间非语言停顿 | p95 < 300 ms |
| Stop 到静音 | < 500 ms |
| steady-state underrun | 0 |

TTS 持续慢于 Agent 时必须触发 backlog policy，不能无限积压。

## 15. 错误与降级

| 场景 | 行为 |
| --- | --- |
| Voice Service down | live failed；文字继续 |
| 无可朗读文本 | 204/complete；不显示错误 |
| utterance 首包前失败 | live failed，关闭 downstream |
| 已写 PCM 后失败 | 关闭 stream + failed event |
| projector/segmenter 异常 | live failed；不发送未清洗原文 |
| backlog 超限 | live failed；Agent 继续 |
| AudioContext blocked | 不请求 live；文字继续 |
| WebSocket 断线 | Server cleanup；Web stop |

## 16. 安全、日志与指标

- TTS 文本只来自 Server 权威 assistant delta。
- utterance 文本只在内存和 Voice Service request 中存在。
- 日志仅记录 ID、sequence、字符数、耗时和安全错误码，不记录原文/token/path/stack。
- 浏览器拿不到 `PI_VOICE_TOKEN`，web token 只在 Authorization header。
- Markdown/HTML projector 不执行内容。

指标至少包括 job/utterance totals、segment characters/wait、first audio、utterance gap、
queue depth/characters、backlog failures、cancel reason，以及 Web unlock/underrun/stop latency。
metrics label 不得使用 job/session/message ID。

## 17. 测试与 E2E

自动化：

- Protocol v4、strict schema、v3/v4 handshake、有/无 speech prompt。
- projector 任意 delta 分割。
- segmenter 中英文/标点/idle/length/flush/Unicode。
- queue 顺序/format/backlog/backpressure/cancel。
- listener-before-prompt、turn binding、多 utterance 单 response。
- abort/steer/stop/disconnect/HTTP close/shutdown。
- Client live event、AudioContext unlock、manual/live 互斥和所有 Web cleanup。

真实 E2E：

1. 300–800 字回答在完整结束前开始说话。
2. 至少 3 个 utterance，顺序正确、无重复/漏读。
3. Markdown link、列表、代码块符合 projector 规则。
4. Stop 后 500 ms 内静音，Agent 继续。
5. abort/steer 后旧语音不继续。
6. 连续 20 turn 无 timer/listener/fetch/AudioNode/GPU 泄漏。
7. Voice down 时文字和 Phase 1 手动朗读 UI不崩溃。

## 18. 任务依赖

```text
Phase 1 V1/V2/V3 approved baseline
          │
          ├──────────────┐
          ▼              ▼
 V5 Live contract    V6 Segmenter
          │              │
          └──────┬───────┘
                 ▼
          V7 Utterance Queue
                 │
                 ▼
          V8 Server Coordinator
                 │
                 ▼
          V9 Web Live UX
```

V9 的纯 UI/unlock fake 可在 V5 frozen 后并行；正式接线必须等待 V8。

## 19. Definition of Done

- Phase 1 手动朗读无回归。
- live opt-in 与 prompt 原子关联，无首 delta race。
- 第一自然片段形成后、完整 message 结束前开始播放。
- projector 不朗读 thinking/tool/code fence 原文。
- utterance 无重复、漏读、乱序，一个 turn 使用一个 browser response。
- Stop 只停止语音；Agent abort/steer 停止旧语音。
- backlog 有硬上限，Voice 故障不影响文字。
- Browser autoplay 和所有 lifecycle cleanup 完整。
- contract/pure/server/client/web tests 与真实 E2E 通过。
- Avatar 不是本里程碑依赖。
