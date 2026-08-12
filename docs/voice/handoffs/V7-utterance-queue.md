# V7 Handoff: Utterance Queue

状态：Review / **API frozen**
任务：[`../tasks/V7-utterance-queue.md`](../tasks/V7-utterance-queue.md)
总规范：[`../PI-LIVE-AGENT-SPEECH-SPEC.md`](../PI-LIVE-AGENT-SPEECH-SPEC.md)

V7 完成 Phase 2 实时朗读链路「文本 → PCM」的执行半段：`UtteranceQueue` 把 V6 提交的
`CommittedUtterance` 按 sequence 严格转成单条连续 PCM sink。Queue 是纯执行组件——
不订阅 Agent events、不创建公开 Job、不处理 HTTP 鉴权、不知道 profile 之外任何业务，
全部由 V8 `LiveSpeechCoordinator` 负责。仅依赖 V6 frozen 的 `CommittedUtterance` 与
Phase 1 V1 的流式 wire contract（经 `synthesize` 工厂注入）。

## 1. 产物

| 文件 | 角色 |
| --- | --- |
| `runtimes/pi/packages/server/src/voice/live/utterance-queue.ts` | `createUtteranceQueue` 工厂与状态机 |
| `runtimes/pi/packages/server/test/utterance-queue.test.ts` | 全需求矩阵测试（27 用例） |

构建后 `dist/voice/live/utterance-queue.{js,d.ts}` 同步发布，但本任务不对外暴露公共
npm export；Coordinator（V8）以相对 import 方式使用（同 V6）。

## 2. 公开 API（frozen）

```ts
import {
  createUtteranceQueue,
  DEFAULT_MAX_QUEUED_UTTERANCES,     // 12
  DEFAULT_MAX_QUEUED_CHARACTERS,      // 1200
  DEFAULT_MAX_ESTIMATED_AUDIO_SECONDS, // 90
  DEFAULT_CHARACTERS_PER_SECOND,       // 16
  type PcmSource,
  type PcmSink,
  type QueueLimits,
  type QueueCancelReason,
  type QueueEvent,
  type QueueResult,
  type SynthesizeFn,
  type UtteranceQueue,
} from "@earendil-works/pi-server/voice/live/utterance-queue";

const queue = createUtteranceQueue({
  profileId: "default",
  synthesize: openStream,        // (input: {text, profileId, signal}) => Promise<PcmSource>
  sink,                          // PcmSink: write / close / fail
  limits: { /* 可选，缺省即 V7 frozen */ },
  signal: abortController.signal, // 外部 abort → 整条队列取消
  onEvent: (event) => {/* 生命周期事件，不含原文 */},
});

queue.enqueue(utterance);    // 同步；sequence 必须 === lastSequence+1
await queue.closeInput();    // 停止接收，drain 后 completed
await queue.cancel(reason);  // 幂等；settle 恰好一次
const result = await queue.completion; // 单次 settle
```

核心类型：

```ts
interface UtteranceQueue {
  enqueue(utterance: CommittedUtterance): void;
  closeInput(): Promise<QueueResult>;
  cancel(reason: QueueCancelReason): Promise<QueueResult>;
  readonly completion: Promise<QueueResult>;
}

type SynthesizeFn = (input: {
  text: string; profileId: string; signal: AbortSignal;
}) => Promise<PcmSource>;

interface PcmSource {
  format: VoiceAudioFormat;            // pcm_f32le / sampleRate / channels=1
  body: ReadableStream<Uint8Array>;    // 4 字节 = 1 个 Float32LE 样本
}

interface PcmSink {
  write(chunk: Uint8Array, signal: AbortSignal): Promise<void>; // 返回下游已 drain
  close(signal: AbortSignal): Promise<void>;   // 幂等
  fail(error: { code: LiveSpeechErrorCode; message: string }, signal: AbortSignal): Promise<void>; // 幂等
}

type QueueCancelReason =
  | "user_cancel" | "owner_disconnect" | "agent_abort" | "agent_steer"
  | "session_removed" | "downstream_close" | "shutdown"
  | "backlog_exceeded" | "format_mismatch";

type QueueResult =
  | { status: "completed"; completedUtterances: number; failedUtterances: number; discardedUtterances: number }
  | { status: "cancelled"; reason: QueueCancelReason; completedUtterances: number; failedUtterances: number; discardedUtterances: number }
  | { status: "failed"; error: { code: LiveSpeechErrorCode; message: string }; completedUtterances: number; failedUtterances: number; discardedUtterances: number };
```

事件（全部不含原文，只带安全元数据）：

```ts
type QueueEvent =
  | { type: "enqueued"; sequence: number; characters: number }
  | { type: "started"; sequence: number }
  | { type: "format_locked"; format: VoiceAudioFormat }
  | { type: "backlog_exceeded"; reason: "max_utterances" | "max_characters" | "max_audio_seconds";
      queueDepth: number; queueCharacters: number; estimatedAudioSeconds: number }
  | { type: "completed"; sequence: number; characters: number }
  | { type: "discarded"; sequence: number; reason: "cancelled" | "backlog_exceeded" | "format_mismatch" }
  | { type: "cancelled"; reason: QueueCancelReason }
  | { type: "failed"; error: { code: LiveSpeechErrorCode; message: string } };
```

## 3. 状态机

### 3.1 队列级生命周期

```text
                ┌─────────────────────────────────────────────┐
   create ────► │ open (接收 enqueue)                          │
                │   ├─ closeInput() → draining                │
                │   ├─ cancel() / failWith() / 外部 abort ─► settling
                │   └─ backlog/format/sequence 违例 ────────► settling
                └─────────────────────────────────────────────┘
                          settling ──(drain + sink close/fail + 释放监听)──► settled (completion resolve ×1)
```

- `open`：`enqueue` 可用。`step()` 在 pending 有货时自驱动。
- `draining`：`closeInput()` 已调用，`enqueue` 抛错；等 in-flight + pending 排空后
  `completed`。
- `settling`：任意终态已触发，`finalizeSettle` 中；之后 `enqueue`/`cancel` 均返回
  completion，不再产生副作用。
- `settled`：completion 恰好 resolve 一次（同一 promise，多个 awaiter 都拿到同一结果）。

### 3.2 单 utterance 生命周期

```text
enqueue(seq N)
   │ sequence 必须 === lastSequence+1，否则 failWith(speech_generation_failed) + throw
   │ backlog 投影超限 → emit backlog_exceeded + failWith(speech_backlog_exceeded)
   ▼
pending（queued）── step() 取出 ──► claimed（generating，await synthesize）
                                       │  emit started
                                       ▼
                                   synthesize 返回 PcmSource
                                       │  ├─ throw → discarded + failed → failWith
                                       │  ├─ 非 pcm_f32le/坏 sampleRate/非单声道 → discarded(format_mismatch) + failed → failWith
                                       │  └─ ok → claimed ──► inFlight（streaming）
                                       ▼
                              streamEntry: 首 chunk 锁 format（emit format_locked）→
                              read → sink.write（backpressure）→ … → EOF
                                       ▼
                                   emit completed → inFlight=null → 唤醒 step() 处理 N+1
```

关键点：

- **claimed 与 inFlight**：entry 离开 `pending` 的瞬间记为 `claimed`（仍处于
  `await synthesize`），synthesize 成功并拿到 reader 后转为 `inFlight`。两者互斥，
  都是「正在生成/流式」的唯一一项。backlog 估算把这一项计入未完成总量（见 §5）。
- **single-flight**：`step()` 由 `inFlight || stepInFlight || settled` 守卫，任意时刻
  只有一个 step 越过 entry-shift 临界区；N 的 source EOF 后才 `void step()` 启动 N+1。
- **settle 单次**：`settled` 标志在所有终态入口检查；`failWith`/`completeWith`/
  `cancel` 先判 `settled` 再执行，保证 completion 恰好 resolve 一次。
- **清理**：`finalizeSettle` 对 sink 做 best-effort `close`（completed）或 `fail`
  （cancelled/failed，错误码 `speech_cancelled`/原始 code），移除外部 abort 监听、
  `reader.cancel()` 残留读取器、清空 claimed/inFlight 引用，最后 resolve completion。

## 4. Format 冻结算法

1. **结构校验**（synthesize 返回后立即）：`source.format` 必须满足
   `encoding === "pcm_f32le" && Number.isInteger(sampleRate) && sampleRate > 0 &&
   channels === 1`，否则该 utterance `discarded(format_mismatch)` + `failed`，整队列
   `failWith(speech_generation_failed)`。
2. **首字节锁格式**：第一条 source 的**第一个非空 chunk** 写入前，把该格式记为
   `lockedFormat` 并 emit `format_locked`。空 chunk 跳过不参与锁定。
3. **后续一致性**：每条后续 utterance 的首个非空 chunk 在 `sink.write` **之前**比对
   `sameFormat(lockedFormat, source.format)`（encoding/sampleRate/channels 全等），
   不等则 `discarded(format_mismatch)` + `failed` + `failWith(speech_generation_failed)`。
   因此「格式不一致在写该 utterance 首字节前失败」被满足。

## 5. Backpressure 与 Backlog 算法

### 5.1 Backpressure

`streamEntry` 的转发循环是严格串行的：

```text
while (!entryController.signal.aborted) {
  read = await reader.read();          // 上游一个 chunk
  if (done) → completed, 启动 N+1
  await sink.write(chunk, signal);     // 等下游 drain 后才拉下一个 chunk
}
```

- `sink.write` 返回 pending promise 时，上游 reader 自然暂停（慢下游限速慢上游）。
- 由于 `inFlight` 仍被占用，backpressure 期间 N+1 也不会启动（Spec §11「backpressure
  暂停 upstream，也阻止 N+1 启动」）。
- `write`/`close`/`fail` 都带 `signal`，下游可随取消立即退出。

### 5.2 Backlog 估算（frozen，含决策）

```ts
generating = claimed ?? inFlight?.entry;              // 正在生成或流式的那一项
characters = Σ(pending.characters) + extra?.characters + generating?.characters;
count      = pending.length + (extra ? 1 : 0) + (generating ? 1 : 0);
estimatedAudioSeconds = characters / charactersPerSecond;
```

- **generating 计入限制（frozen，V7 §6 推荐项）**：`claimed` 覆盖 `await synthesize`
  尚未返回 source 的窗口，`inFlight` 覆盖流式窗口，两者取一即为未完成总量。这样在
  TTS 慢、文本持续涌入时提前 fail，而不是淹没队列。两个 backlog 超限测试专门钉死
  该行为（见 §6）。
- **顺序判定**：先 `count`，再 `characters`，再 `estimatedAudioSeconds`，首个违例即
  返回原因（`max_utterances`/`max_characters`/`max_audio_seconds`）。
- **保守估算**：`charactersPerSecond = 16`（frozen），把字符换算成*偏大*的音频时长，
  让保护先于浏览器实际欠载触发。字符数按 Unicode code point 统计（`for…of`），不是
  UTF-16 code unit。
- **违例即终态**：超限 emit `backlog_exceeded`（带 reason 与投影后的 depth/characters/
  audioSeconds），随后 `failWith("speech_backlog_exceeded")` → 取消当前 TTS、清空队列，
  `completion` 以 `failed` 结算（Spec §11：Agent 继续）。绝不静默丢句。
- 边界语义：恰等于上限不算超限（`>` 判定）。

## 6. 与 V8 的集成示例

```ts
import { createUtteranceQueue, type UtteranceQueue } from "@earendil-works/pi-server/voice/live/utterance-queue";
import { createSpeakableTextProjector } from "@earendil-works/pi-server/voice/live/text-projector";
import { createTextSegmenter } from "@earendil-works/pi-server/voice/live/text-segmenter";

class LiveSpeechJobCore {
  private readonly projector = createSpeakableTextProjector();
  private readonly segmenter = createTextSegmenter();
  private queue!: UtteranceQueue;

  start(profileId: string, httpResponse: Response, onJobEvent: (e: unknown) => void) {
    const sink: PcmSink = {
      write: (chunk, signal) => httpWriter.write(chunk, signal),   // 单条浏览器 PCM response
      close: (signal) => httpWriter.end(signal),
      fail: (err, signal) => httpWriter.fail(err, signal),
    };
    this.queue = createUtteranceQueue({
      profileId,
      synthesize: ({ text, signal }) => voiceClient.synthesizeStream(text, { signal }), // V1 wire
      sink,
      signal: this.ownerSignal,          // disconnect / shutdown / steer 的取消源
      onEvent: (event) => onJobEvent(mapToJobEvent(event)), // 只映射安全字段
    });
  }

  onAssistantTextDelta(delta: string, now: number) {
    for (const u of this.segmenter.push(this.projector.project(delta), now)) this.queue.enqueue(u);
  }
  onTick(now: number) {
    for (const u of this.segmenter.tick(now)) this.queue.enqueue(u);
  }
  onTurnFinished(now: number) {
    this.projector.flush();
    for (const u of this.segmenter.flush(now)) this.queue.enqueue(u);
    void this.queue.closeInput();
  }
  onCancel() {
    this.projector.reset(); this.segmenter.reset();
    void this.queue.cancel("user_cancel");
  }
}
```

要点：

- Queue 不感知 turn / profile 之外的信息；`profileId` 只在 `synthesize` 原样转发。
- `onEvent` 必须同步且不抛（内部已 try/catch 兜底）。事件字段全部安全，可直接映射到
  `live_speech_job` 事件，不得把 `text` 带进任何日志/事件。
- 每个 V1 `synthesize` 调用都用 queue 注入的 AbortSignal；cancel 会级联 abort 上游 body。
- `closeInput()` 返回的 `QueueResult` 与 `completion` 相同，V8 等待其一即可。

## 7. 边界案例矩阵（已写测试，27 用例）

- **顺序与单并发**：3 条 utterance 严格按 sequence、任意时刻恰好 1 个 synthesize in
  flight；N EOF 后才启动 N+1。
- **任意分割**：upstream chunk 任意切分、字节原样按序写入 sink（`bytes()` 拼接断言）。
- **source 错误**：第一/中间/最后一条 read 抛错 → `discarded` + `failed` +
  `failWith(speech_generation_failed)`。
- **format mismatch**：非 `pcm_f32le` / 非单声道结构违例；后续 source 采样率改变 →
  首字节前失败。
- **sink backpressure**：gate 挂起 `write` → 上游 reader 暂停；release 后恢复；pending
  write 期间 N+1 不启动。`sink.write` 抛错 → 整队列 failed。
- **close 路径**：generating 中 enqueue；pending 中 close；empty close（立即 completed）；
  closeInput 后 enqueue 抛错。
- **cancel 矩阵**：queued / generating / streaming / draining 各阶段 cancel；多次
  cancel 幂等、settle 一次、结果一致。
- **backlog**：三种限制各自触发 + 边界值恰等于上限不触发 + generating 计入（见 §5.2）。
- **late callback**：cancel 后到达的 chunk 不写入 sink；settle 后 flush 不转发。
- **无泄漏**：外部 abort 监听移除、reader cancel、settle 后无残留引用（无 timer 分支）。

## 8. 验证命令与结果

```bash
cd runtimes/pi
npm run test      --workspace=@earendil-works/pi-server -- utterance-queue  # 27 passed
npm run typecheck --workspace=@earendil-works/pi-server                      # clean
npm run build     --workspace=@earendil-works/pi-server                      # clean
git diff --check                                                              # clean
```

- `utterance-queue` 27/27 全绿；typecheck、build 无新增告警；`git diff --check` 干净
  （含 untracked 的 `voice/live/**` 手动扫过无尾随空白）。
- 交付前移除了实现中的 4 处 `console.error("DBG …")` 调试残留。

## 9. 已知风险与决策

- **generating 计入 backlog（frozen 决策）**：实现初期 `claimed` 缺失导致
  `await synthesize` 窗口内正在生成的一项不被计入限制，`maxQueuedUtterances=2` 在
  「1 生成 + 2 排队」场景漏判并让 `completion` 永不 settle（测试超时）。已加 `claimed`
  状态并清零于所有放弃/成功路径，两个 backlog 测试与边界测试同时钉死该行为。V8 不得
  回退。
- **backlog 违例是终态**：整队列以 `failed` 结算、不静默丢句，符合 Spec §11。Agent
  继续朗读的恢复逻辑由 V8 决定（例如重建队列）。
- **sequence 违例 fail loud**：重复/跳号 → `failWith` + `enqueue` 同步 throw，不做
  自排序猜测（V7 §5）。
- **sink 错误吞掉**：`finalizeSettle` 里 close/fail 的异常被吞（shutdown 期不可操作），
  但运行期 `write` 抛错会正常 fail 队列。
- **测试 FakeUpstream 的 `hang` 字段是惰性字段**（set 但未读）：空流且未 close 时
  `reader.read()` 天然挂起，测试意图由该行为表达。保留以提示意图，无运行语义。
- **环境性：undici 集成测试无法加载（与 V7 无关）**：全套 server 测试中 5 个集成文件
  （`server.test.ts`/`uploads.test.ts`/`conformance.test.ts`/`coding-agent-backend.test.ts`/
  `web-start.test.ts`）在模块加载阶段抛
  `TypeError: webidl.util.markAsUncloneable is not a function`
  （undici `lib/web/cache/cachestorage.js` 初始化失败），0 个断言被运行。这是
  Node v20.20.2 与已装 undici 的版本不匹配，预存在、与 V7 无 import 关联。V8 若要跑
  HTTP 集成测试，需先对齐 undici/Node（升 undici 或换 Node LTS）。

## 10. API frozen 范围

下列 API 在 V7 中冻结；V8/V9 不得修改，必须变更时升级 Phase 2 协议版本：

- `createUtteranceQueue` 的参数形状（profileId / synthesize / sink / limits / signal /
  onEvent / now）与返回对象四个成员。
- `PcmSource` / `PcmSink` / `QueueLimits` / `SynthesizeFn` 的字段与语义。
- `QueueCancelReason` 枚举成员、`QueueResult` 判别联合、`QueueEvent` 各变体字段。
- 四个默认常量：`DEFAULT_MAX_QUEUED_UTTERANCES=12`、`DEFAULT_MAX_QUEUED_CHARACTERS=1200`、
  `DEFAULT_MAX_ESTIMATED_AUDIO_SECONDS=90`、`DEFAULT_CHARACTERS_PER_SECOND=16`。
- 冻结行为：generating 计入 backlog；backlog 违例 → `speech_backlog_exceeded` 终态；
  sequence 违例 fail loud；首字节锁格式；sink backpressure 语义。

## 11. 下游接入指引

- V8（`LiveSpeechCoordinator`）：§6 示例处接线。创建顺序按 Spec §12（校验 → Job →
  projector/segmenter/queue → progress listener → prompt）。cleanup 包含 upstream abort、
  queue discard、downstream close，全部走 queue 的 `cancel`/`closeInput`。
- V9（Web UX）：不 import 本任务模块；只通过 V8 的 `LiveSpeechJobEvent` 接收进度，
  不接触 queue 内部状态。
- 冻结接口变更需先与总规范 owner 同步，并升级 Phase 2 协议版本（见
  [`README.md`](../README.md) §5）。
