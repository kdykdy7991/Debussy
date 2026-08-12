# Pi 流式语音协议与前端接入规范（Phase 1）

状态：Implemented / Review  
目标版本：Pi Protocol v3 / Voice Service v0.2  
范围：已完成 assistant 消息的手动流式朗读，不含 ASR  
日期：2026-08-12

> 本文是 Phase 1 的架构与验收基线。Agent 尚在输出时的自动分段朗读属于 Phase 2，
> 见 [`PI-LIVE-AGENT-SPEECH-SPEC.md`](./PI-LIVE-AGENT-SPEECH-SPEC.md)。Phase 2 复用
> 本文的 Voice Service、PCM proxy、Pi Client 和 Web Audio 能力，不覆盖本文。

## 1. 背景

仓库当前已经具备两组彼此独立的能力：

1. `services/voice` 提供受 Bearer Token 保护的本机 Qwen3-TTS 服务，正式接口
   `POST /v1/synthesize` 生成完整 WAV artifact。
2. `faster_qwen3_tts_stream_player.py` 已验证 `faster-qwen3-tts` 可以逐块产生
   `float32` PCM，并由测试页面使用 Web Audio API 边接收边播放。

当前缺口是：流式能力只存在于 smoke player，Pi 的 protocol、server、client 和 web
均不知道 SpeechJob，也没有受正式鉴权边界保护的音频流路由。

本规范把 smoke player 中已经验证的链路升级为正式架构：

```text
Pi Web
  ├─ WebSocket control ──> Pi Server ── HTTP control ──> Voice Service
  └─ HTTP PCM stream <──── Pi Server <── PCM stream ───── Voice Service
```

控制状态使用现有版本化 WebSocket 协议；音频字节使用同一 Node HTTP listener 上的
独立路由。PCM 不进入 JSON/CBOR 帧，不进入 transcript，不写入 SessionSnapshot。

## 2. 目标

- 用户可以对一条已完成的 assistant 消息点击“朗读”。
- 浏览器在 Voice Service 产生首个音频块后立即开始接收，不等待完整 WAV。
- Pi Server 是浏览器与 Voice Service 之间唯一的安全边界。
- WebSocket 可观察、取消 SpeechJob，并收到明确的终态。
- 浏览器断流、用户停止、会话释放或服务关闭时，取消信号能够传播到 GPU generator。
- 协议不暴露 Python 本地路径、Qwen 模型 ID、speaker 名称或 `instruct` 实现细节。
- 第一阶段保留现有非流式 `/v1/synthesize`，便于回退和对比。

## 3. 非目标

- 语音识别、麦克风采集和唤醒词。
- 服务端音频持久化、历史音频下载和跨重启恢复。
- 多声道、空间音频、SSML 和逐字时间戳。
- 服务端混音或同一连接同时播放多个 SpeechJob。
- 第一阶段实现精确 viseme 口型；只预留音量驱动接口。
- 让浏览器直接访问 Python Voice Service。
- 把 PCM、WAV base64 或服务端文件路径加入 Pi protocol。

## 4. 设计原则

### 4.1 控制面与数据面分离

WebSocket 只传小型、可校验、可回放的控制消息。原始音频通过 HTTP chunked response
传输。HTTP chunk 边界不是模型 chunk 边界，客户端必须按样本宽度自行重组。

### 4.2 Provider-neutral 协议

客户端发送 `voiceProfileId`，不发送 Qwen `speaker`、`language`、模型路径或推理参数。
Pi Server 根据本地配置把 profile 解析为 Voice Service 请求。以后替换 CosyVoice 或
Opus 编码时，无需修改公开命令语义。

### 4.3 服务端解析权威文本

客户端只提交 `sessionId + messageId`。Pi Server 从权威 SessionSnapshot 中提取已完成
assistant 消息的公开 `text` content，拒绝 thinking、toolCall、streaming、error 和
aborted 内容。客户端不能提交一份与界面显示不一致的任意文本。

### 4.4 第一阶段 SpeechJob 不持久化

SpeechJob 属于发起它的 WebSocket 连接：不写 session 文件、不参与 resume replay、
不进入 ServerSnapshot。连接断开时全部取消。它描述“生成和传输”，不声称音频已经被
人听完。

## 5. 端到端流程

```text
User       Web/PiClient        Pi Server          Voice Service       AudioContext
 │ click        │                  │                    │                  │
 │─────────────>│ start_speech     │                    │                  │
 │              │─────────────────>│ validate message   │                  │
 │              │<─────────────────│ job: queued        │                  │
 │              │ GET stream       │                    │                  │
 │              │─────────────────>│ POST /v1/stream    │                  │
 │              │                  │───────────────────>│ load/generate    │
 │              │                  │<───────────────────│ first PCM chunk   │
 │              │<─────────────────│ headers + PCM       │                  │
 │              │ parse/schedule   │                    │                  │
 │              │────────────────────────────────────────────────────────>│
 │              │<─ speech_job(streaming/completed) ───│                  │
 │              │ local playback ended                 │                  │
 │<─────────────│ UI returns to idle                    │                  │
```

详细顺序：

1. 用户手势创建或恢复 `AudioContext`。
2. Web 发送 `start_speech`。
3. Server 校验连接、session、message、profile、长度和单连接并发限制。
4. Server 创建 `queued` SpeechJob，返回相对 `streamPath`。
5. Web 使用同一 web token 发起 HTTP GET；首次 GET 原子地 claim 该 Job。
6. Server 调用 Voice Service 流式端点，并在等待首包时把 Job 更新为 `generating`。
7. Python 首包可用后返回 PCM 元数据头；Server 原样规范化并转发。
8. Server 发送 `streaming` 事件，浏览器开始调度音频。
9. 上游正常结束后 Server 标记 `completed`；浏览器继续播放已排队缓冲。
10. 最后一个 `AudioBufferSourceNode` 的 `ended` 才表示本地播放完成。

## 6. Pi Protocol v3

公开协议新增命令和事件，因此 `PROTOCOL_VERSION` 从 `2` 升为 `3`。v2 client 与 v3
server 按现有握手逻辑明确失败，不做静默降级。

### 6.1 SpeechJob schema

```ts
type SpeechStatus =
  | "queued"
  | "generating"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

interface SpeechAudioFormat {
  encoding: "pcm_f32le";
  sampleRate: number;
  channels: 1;
}

interface SpeechJob {
  id: string;
  sessionId: string;
  messageId: string;
  voiceProfileId: string;
  status: SpeechStatus;
  streamPath: string;
  createdAt: number;
  updatedAt: number;
  firstChunkAt?: number;
  audio?: SpeechAudioFormat;
  error?: {
    code: SpeechErrorCode;
    message: string;
  };
}
```

`completed` 表示 Voice Service 已耗尽并且 Server 已写完 HTTP response，不表示浏览器已
播放结束。播放状态是 Web 本地状态，不进入服务端协议。

### 6.2 错误码

```ts
type SpeechErrorCode =
  | "voice_unavailable"
  | "voice_profile_not_found"
  | "message_not_speakable"
  | "speech_busy"
  | "speech_stream_claimed"
  | "speech_stream_expired"
  | "speech_generation_failed"
  | "speech_cancelled";
```

创建命令前的错误沿用 `ProtocolError`：`not_found`、`invalid_request`、`invalid_state`、
`busy`、`unauthorized`。Job 创建后的异步错误写入 `SpeechJob.error`。

### 6.3 start_speech 命令

```ts
interface StartSpeechCommand {
  command: "start_speech";
  sessionId: string;
  messageId: string;
  voiceProfileId?: string;
}

interface StartSpeechResult {
  command: "start_speech";
  job: SpeechJob;
}
```

约束：

- session 必须存在且当前连接已 attach。
- message 必须是该 session transcript 中 `status="complete"` 的 assistant item。
- 只拼接 `content.type === "text"` 的内容，按内容块顺序用换行连接并 trim。
- 空文本拒绝为 `message_not_speakable`。
- 规范化后的文本长度不得超过 Voice Service 配置上限，第一阶段默认 4000 字符。
- 一个 WebSocket 连接最多一个非终态 Job；再次请求返回 `busy`。
- `voiceProfileId` 缺省时使用 server 的默认 profile。
- 幂等性不由 `messageId` 推断；每次成功命令创建新的 job ID。

### 6.4 cancel_speech 命令

```ts
interface CancelSpeechCommand {
  command: "cancel_speech";
  jobId: string;
}

interface CancelSpeechResult {
  command: "cancel_speech";
  job: SpeechJob;
}
```

- 只有创建该 Job 的连接可以取消。
- `queued/generating/streaming -> cancelled`。
- 对 `completed/failed/cancelled` 重复取消是幂等的，返回当前 Job。
- 取消会 abort Node 到 Python 的请求并关闭浏览器 HTTP response。

### 6.5 speech_job 事件

```ts
interface SpeechJobEvent {
  type: "speech_job";
  job: SpeechJob;
}
```

事件只发送给创建 Job 的连接，不向 session 其他订阅者广播，不写 session event log。
Server 至少在以下变化发事件：`generating`、`streaming`、任一终态。

### 6.6 状态机

```text
queued ──HTTP claim──> generating ──first PCM──> streaming ──EOF──> completed
  │                         │                       │
  ├──────── cancel ─────────┴──────── cancel ──────┴────────────> cancelled
  │                         │                       │
  └──────── error ──────────┴──────── error ───────┴────────────> failed
```

所有终态不可逆。事件重复或乱序时，client 以 `updatedAt` 和终态不可逆规则保护状态。

## 7. Browser-facing HTTP API

### 7.1 路由

```http
GET /api/pi/v3/speech/{jobId}/stream
Authorization: Bearer <PI_WEB_TOKEN>
Origin: http://127.0.0.1:<port>
```

成功响应：

```http
HTTP/1.1 200 OK
Content-Type: application/vnd.pi.pcm
Cache-Control: no-store
X-Content-Type-Options: nosniff
X-Pi-Speech-Job-Id: <jobId>
X-Pi-Audio-Encoding: pcm_f32le
X-Pi-Audio-Sample-Rate: 24000
X-Pi-Audio-Channels: 1
Access-Control-Expose-Headers: X-Pi-Speech-Job-Id, X-Pi-Audio-Encoding, X-Pi-Audio-Sample-Rate, X-Pi-Audio-Channels
Transfer-Encoding: chunked
```

响应体是连续、单声道、little-endian IEEE-754 float32 PCM。值域目标为 `[-1, 1]`。
HTTP chunk 可以拆开一个 float32，也可以合并多个模型 chunk。客户端必须保留不足 4
字节的尾部并与下一网络 chunk 拼接。

### 7.2 HTTP 错误

所有失败响应为：

```json
{ "error": { "code": "not_found", "message": "Speech job not found" } }
```

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `invalid_request` | job ID/path 非法 |
| 401 | `unauthorized` | Bearer token 缺失或错误 |
| 403 | `forbidden` | Host/Origin 不允许 |
| 404 | `not_found` | Job 不存在或不属于当前 principal |
| 409 | `speech_stream_claimed` | 流已被另一个 GET claim |
| 410 | `speech_stream_expired` | 未 claim 的 Job 已过期 |
| 502 | `voice_unavailable` | 无法连接 Voice Service 或首包前失败 |

首个 PCM 字节发出之后无法再切换为 JSON 错误。此时 Server 关闭响应，并通过 WebSocket
发送 `failed` Job。浏览器把非正常 EOF 与 Job 终态结合后显示错误。

### 7.3 Claim 和过期

- 每个 stream 只允许成功 claim 一次。
- 创建后默认 30 秒未 GET，Job 变为 `cancelled`，HTTP 返回 410。
- Job 终态元数据在内存保留 5 分钟，随后清除。
- WebSocket 断开、Server shutdown、session detach 均取消该连接的活动 Job。

### 7.4 鉴权与 CORS

复用 upload HTTP handler 已有策略：

- 校验 Host allowlist。
- 校验 Origin allowlist。
- 配置了 `PI_WEB_TOKEN` 时要求 Bearer token；token 不放 query string。
- `OPTIONS` 只校验 Origin，并返回允许的 method/header。
- 默认仅绑定 loopback；禁止 `0.0.0.0` 和 `::` 的规则不变。

## 8. Pi Server 设计

### 8.1 新增模块

```text
runtimes/pi/packages/server/src/voice/
├── client.ts          # Voice Service HTTP client
├── profiles.ts        # profile 解析与校验
├── speech-manager.ts  # Job 状态机、ownership、cancel、TTL
└── types.ts

runtimes/pi/packages/server/src/web/speech.ts
```

`SpeechManager` 由 `PiServer` 持有，依赖注入到 WebSocket command dispatch 和 HTTP
handler。不要把 GPU/HTTP 逻辑放进 `LiveSessionManager`。

### 8.2 Voice profile

```ts
interface VoiceProfile {
  id: string;
  provider: "qwen3-tts";
  language: string;
  speaker: string;
  instruct?: string;
}
```

公开协议只返回 profile 的 `id` 和可选 display name，不回传 provider 内部字段。
第一阶段至少配置：

```text
PI_VOICE_URL=http://127.0.0.1:18876
PI_VOICE_TOKEN=<server-to-service secret>
PI_VOICE_DEFAULT_PROFILE=default
```

### 8.3 文本解析

Server 从 snapshot 中查找 message：

```ts
function extractSpeakableText(item: AssistantTranscriptItem): string {
  if (item.status !== "complete") throw messageNotSpeakable();
  return item.content
    .filter((part) => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}
```

第一阶段不做 Markdown AST 改写，避免误删代码和专有符号。后续可在独立 normalizer 中
加入链接、代码块、表格和 emoji 的朗读规则，并为每条规则增加 golden test。

### 8.4 Backpressure

Node 使用 stream pipeline 把 Voice Service response 写入 `ServerResponse`，不得先
`arrayBuffer()`。当下游 `write()` 返回 false 时暂停读取，等待 `drain`。限制：

- 上游首包超时：60 秒（模型首次加载可通过配置放宽）。
- chunk 间空闲超时：30 秒。
- 单 Job 最长生成时间：5 分钟。
- 单 Job 最大转发字节：默认 100 MiB。
- 单连接活动 Job：1；全局活动 Job 默认与 Voice Service concurrency 一致。

Node 不假设上游网络 chunk 对齐 float32；只校验总字节数最终能被 4 整除。无法整除时
Job 失败为 `speech_generation_failed`。

### 8.5 取消传播

每个 Job 持有一个 `AbortController`。以下任一事件触发 abort：

- `cancel_speech`；
- 浏览器 HTTP request/response `close`；
- owner WebSocket disconnect；
- Server shutdown；
- timeout；
- upstream/downstream error。

Abort 必须幂等。用户主动取消产生 `cancelled`，基础设施错误产生 `failed`。

## 9. Voice Service v0.2

### 9.1 正式流式端点

```http
POST /v1/synthesize/stream
Authorization: Bearer <PI_VOICE_TOKEN>
Content-Type: application/json
```

请求：

```json
{
  "text": "需要朗读的权威 assistant 文本",
  "language": "Chinese",
  "speaker": "Vivian",
  "instruct": null,
  "chunkSize": 8,
  "encoding": "pcm_f32le"
}
```

响应头与 Browser-facing API 使用相同音频元数据，但不包含 Pi job ID。响应体为连续
PCM。Python 必须把 numpy 输出显式转换为 little-endian float32、flatten 为 mono，再
yield bytes。

### 9.2 Provider 接口

现有只返回 `AudioArtifact` 的 provider 扩展为：

```py
class AudioChunk(TypedDict):
    samples: NDArray[np.float32]
    sample_rate: int

class TTSProvider(Protocol):
    def synthesize(self, request: SynthesisRequest) -> AudioArtifact: ...
    def stream(self, request: SynthesisRequest, *, chunk_size: int) -> Iterator[AudioChunk]: ...
```

`VoiceService.stream()` 负责统一完成：文本长度、并发 semaphore、采样率一致性、mono
校验、取消和安全错误映射。FastAPI route 不直接依赖 `FasterQwen3TTS`。

### 9.3 模型生命周期

- 一个进程只加载一个模型实例。
- 非流式和流式请求共享同一个并发 semaphore。
- 第一次请求允许 lazy load；health 仍不触发加载。
- generator 必须在 `finally` 中 close；客户端断开时尽快释放 GPU 生成。
- 若底层库不能立即中断一次正在执行的 CUDA step，取消语义是“停止下一次迭代和下游
  传输”，文档和指标必须如实记录。

### 9.4 错误响应

首包前：返回结构化 JSON 和合适 HTTP status。首包后：记录内部错误、关闭流，绝不把
stack、CUDA 详情、模型路径或用户文本写入响应。

## 10. Pi Client API

`@earendil-works/pi-client` 增加控制面能力：

```ts
interface StartSpeechOptions {
  sessionId: string;
  messageId: string;
  voiceProfileId?: string;
}

interface SpeechJobHandle {
  readonly job: SpeechJob;
  subscribe(listener: (job: SpeechJob) => void): Unsubscribe;
  cancel(): Promise<SpeechJob>;
}

PiClient.startSpeech(options: StartSpeechOptions): Promise<SpeechJobHandle>;
```

HTTP 数据面保持独立：

```ts
interface OpenSpeechStreamOptions {
  baseUrl: string;
  streamPath: string;
  token?: string;
  signal?: AbortSignal;
}

openSpeechStream(options): Promise<{
  format: SpeechAudioFormat;
  body: ReadableStream<Uint8Array>;
}>;
```

这样 Node/Unix transport 用户不会被强制依赖浏览器 `fetch`，Web 仍可复用严格的头部
解析和错误映射。

## 11. Web 前端设计

### 11.1 目录

```text
runtimes/pi/packages/web/src/features/voice/
├── audio-player.ts
├── pcm-stream.ts
├── speech-controller.ts
├── speech-button.tsx
├── voice-settings.tsx
└── types.ts
```

### 11.2 用户体验

- 每条 `complete` assistant 消息显示朗读按钮。
- 点击后按钮变为 loading；首包调度后变为“停止”。
- 同时只能朗读一条消息；开始新朗读前先取消旧 Job 并停止本地节点。
- 显示可恢复错误，不把底层 upstream 信息展示给用户。
- 页面切换 session、连接断开、组件 unmount 时停止播放并取消 Job。
- 浏览器自动播放策略要求第一次播放来自明确用户手势。
- 自动朗读作为后续设置，只有 AudioContext 已由用户解锁时才启用。

### 11.3 PCM 解码与调度

`pcm-stream.ts`：

- 校验 encoding、sample rate、channels。
- 合并网络 chunk，保存不足 4 字节 remainder。
- 按 little-endian float32 解码；拒绝 NaN/Infinity，必要时 clamp 到 `[-1, 1]`。
- EOF 时 remainder 非空视为损坏。

`audio-player.ts`：

- 首次至少缓冲 80–150 ms，再开始调度，默认 120 ms。
- `nextStartTime = max(nextStartTime, context.currentTime + safetyLead)`。
- 使用 `AudioBufferSourceNode` 顺序播放；AudioContext 自动完成采样率转换。
- 记录 queued duration；超过上限时暂停 reader，依赖 fetch/HTTP backpressure。
- 默认目标缓冲 250 ms，最大缓冲 2 秒。
- 发生 underrun 时重新建立 safety lead 并计数，不让旧时间轴持续漂移。
- Stop 时 abort fetch、stop 所有 source、断开 analyser、关闭或复用 AudioContext。

### 11.4 本地播放状态

```ts
type PlaybackState =
  | "idle"
  | "requesting"
  | "buffering"
  | "playing"
  | "draining"
  | "ended"
  | "stopped"
  | "error";
```

Server Job `completed` 且还有已排队音频时，本地状态为 `draining`。

### 11.5 数字人集成点

第一阶段只定义 hook，不要求精确口型：

- 实际第一个 source `onstart`：Avatar state -> `speaking`。
- 每个 animation frame 从 `AnalyserNode` 计算 RMS，调用 `setAudioLevel(0..1)`。
- ended/stopped/error：`setAudioLevel(0)`，Avatar state -> `idle`。
- Avatar 不存在或不支持 audioLevel 时，不影响语音播放。

## 12. 可观测性

### 12.1 指标

至少记录聚合指标，不记录原始文本：

- `speech_jobs_total{status,profile}`
- `speech_active_jobs`
- `speech_queue_wait_ms`
- `speech_first_chunk_ms`
- `speech_stream_duration_ms`
- `speech_audio_duration_ms`
- `speech_bytes_total`
- `speech_cancel_total{reason}`
- Web 本地：首声延迟、underrun 次数、最大缓冲时长。

### 12.2 日志

允许：job ID、session ID、message ID、profile ID、状态、耗时、字节数和安全错误码。
禁止：Bearer token、原始文本、模型缓存绝对路径、完整 upstream body、堆栈返回客户端。

## 13. 测试策略

### 13.1 Protocol

- 新 schema 的成功/失败 validation。
- strict object 拒绝额外字段。
- v2/v3 handshake 不兼容测试。
- `ResultForCommand` 对 start/cancel 的静态类型测试。
- SpeechJob 每个状态与 error/audio 可选字段组合测试。

### 13.2 Voice Service

- Fake streaming provider 输出多个不同长度 chunk。
- 首包 headers 正确。
- float32 little-endian、mono、采样率一致性。
- 空输出、采样率变化、非有限 sample、provider 异常。
- 文本/并发限制与非流式共享。
- consumer disconnect 后 generator close。
- 单元测试不加载模型；真实 GPU 作为手动 smoke。

### 13.3 Pi Server

- 只能朗读已完成 assistant text。
- thinking/toolCall 不进入 TTS 文本。
- profile/default/长度/ownership 校验。
- 一个连接单活动 Job。
- GET claim 一次、过期、Bearer/Origin/Host。
- upstream headers 和 PCM 转发，不发生全量 buffer。
- backpressure、首包超时、chunk timeout、最大字节。
- cancel、HTTP close、WS disconnect、shutdown 均 abort upstream。
- 首包前失败返回 JSON；首包后失败关闭流并发 Job event。

### 13.4 Client/Web

- 任意网络分块下 float32 重组正确，包括 1/2/3 字节碎片。
- 非有限值、错误 metadata、截断尾部。
- AudioContext fake 验证调度顺序、buffer target、stop 清理。
- completed -> draining -> ended。
- 快速连续点击只留下最后一个 Job。
- session change/unmount/disconnect 清理。
- 浏览器集成测试验证首包到达前不创建播放节点、到达后无需等待 EOF。

### 13.5 端到端验收

使用真实本地 Qwen 模型，至少验证：

1. 100–300 字中文 assistant 消息可朗读。
2. 首声音在完整生成结束前出现。
3. 点击停止后 500 ms 内浏览器静音，Server Job 进入 cancelled。
4. 刷新页面或关闭 WebSocket 不留下活动生成任务。
5. 连续运行 20 次无持续增长的 Job、stream、AudioNode 或 GPU 显存泄漏。
6. Voice Service 不可用时文本聊天仍正常，UI 显示可恢复错误。

## 14. 性能预算

本地 warm model 的目标（不是硬编码协议保证）：

| 指标 | 目标 |
| --- | --- |
| click 到 start_speech result | < 100 ms |
| warm model 首 PCM chunk | < 1.5 s |
| Server 转发附加延迟 | < 50 ms |
| 浏览器初始播放缓冲 | 80–150 ms |
| steady-state underrun | 0 |
| Stop 到静音 | < 500 ms |
| Node 单 Job PCM 缓冲 | < 4 MiB |

冷模型加载单独计量，不与 warm SLO 混合；UI 应显示“正在加载语音模型”。

## 15. 分阶段实施

### Phase A：Voice Service 正式流

- 把 faster-qwen streaming 封装为 provider/service 接口。
- 实现 `/v1/synthesize/stream`、取消、并发和单测。
- 保留 smoke player 作为手动回归工具，但让它调用正式 service 或共享 provider。

完成条件：curl/测试客户端可边接收 PCM 边写入播放管线，取消不再继续产出下游字节。

### Phase B：Pi Protocol + Server proxy

- 升级 protocol v3。
- 实现 SpeechManager、VoiceServiceClient 和 speech HTTP handler。
- 串接 WebSocket Job events、HTTP claim、鉴权、TTL、取消和测试。

完成条件：不使用正式 Web UI，也可由协议测试 client 创建 Job 并读取受保护 PCM 流。

### Phase C：Pi Client + Web 播放

- 实现 typed client API、PCM parser、AudioContext scheduler。
- assistant 消息加入朗读/停止按钮。
- 完成错误、断线、session 切换和资源清理。

完成条件：真实 Pi assistant 消息可在浏览器中流式朗读，首包前后状态正确。

### Phase D：数字人联动与体验

- 接入 Avatar speaking/idle 状态。
- AnalyserNode 驱动 audioLevel。
- 增加 profile 设置、可选自动朗读和性能指标。

完成条件：没有 Avatar 时语音独立工作，有 Avatar 时可观察 speaking 与音量联动。

## 16. 代码改动清单

```text
services/voice/
  src/pi_voice/main.py
  src/pi_voice/service.py
  src/pi_voice/providers/base.py
  src/pi_voice/providers/faster_qwen3_tts.py       (new)
  src/pi_voice/schemas.py
  tests/test_streaming.py                          (new)

runtimes/pi/packages/protocol/
  src/schemas.ts
  test/speech-protocol.test.ts                     (new)

runtimes/pi/packages/server/
  src/server.ts
  src/types.ts
  src/voice/client.ts                              (new)
  src/voice/profiles.ts                            (new)
  src/voice/speech-manager.ts                      (new)
  src/voice/types.ts                               (new)
  src/web/speech.ts                                (new)
  src/web/start.ts
  test/speech-server.test.ts                       (new)

runtimes/pi/packages/client/
  src/client.ts
  src/state.ts
  src/speech-stream.ts                             (new)
  src/types.ts
  test/speech-client.test.ts                       (new)

runtimes/pi/packages/web/
  src/features/voice/*                             (new)
  src/app.tsx
  src/styles.css
```

具体测试文件名应遵循各 package 现有惯例；不要为了语音建立第二套测试框架。

## 17. 回退策略

- `/v1/synthesize` 保持兼容，流式端点通过配置开关启用。
- Web 可在流式能力不可用时隐藏朗读按钮或回退为完整 WAV artifact；回退不能让浏览器
  直接访问 Python 路径。
- protocol v3 server 不向 v2 client 宣称支持 speech。
- 发布时先启用手动朗读，再启用自动朗读和 Avatar audioLevel。

## 18. 安全检查表

- [ ] Voice Service 仍只监听 loopback。
- [ ] 浏览器永远拿不到 `PI_VOICE_TOKEN`。
- [ ] 浏览器 HTTP 使用 `PI_WEB_TOKEN` header，不使用 query token。
- [ ] streamPath 是相对路径且由 Server 生成。
- [ ] Job ID 使用 `randomUUID()`，但不把不可猜测性当作唯一鉴权。
- [ ] text 从服务端 snapshot 读取并限制长度。
- [ ] 错误和日志不包含 text、token、路径、CUDA stack。
- [ ] disconnect/cancel/shutdown 可终止活动流。
- [ ] HTTP response 禁止缓存和 MIME sniffing。
- [ ] 不把 PCM 写入 transcript、event log 或 SessionSnapshot。

## 19. Definition of Done

只有同时满足以下条件，本任务才算完成：

- 协议 schema、server/client API 和 HTTP wire format 均有自动化契约测试。
- Web 浏览器能从一条真实 complete assistant 消息开始流式播放。
- 播放在完整生成完成前开始，网络 chunk 任意拆分不会损坏音频。
- 用户停止、HTTP 断开和 WebSocket 断开都会终止 Job 并释放资源。
- Python 路径、provider 参数和 secret 不跨越其所属安全边界。
- Voice Service 故障不影响文字会话。
- 非流式合成与现有单元测试保持通过。
- README/运行配置包含 Voice Service、Pi Server 和 Web 的本地启动步骤。
