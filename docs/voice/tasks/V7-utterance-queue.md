# V7 任务单：Utterance Queue

状态：Review / API frozen
职责：有序 TTS 队列、格式冻结、backlog 与 downstream backpressure  
总规范：[`../PI-LIVE-AGENT-SPEECH-SPEC.md`](../PI-LIVE-AGENT-SPEECH-SPEC.md)

## 1. 依赖门槛

### Hard prerequisites

- V5 LiveSpeechJob/error contract frozen。
- V6 CommittedUtterance API frozen。
- Phase 1 V1 stream wire contract 可用。

### Soft prerequisites

- V8 coordinator 尚未实现；本任务用 fake Voice client/downstream。

### Parallel-safe subset

- 在 V5/V6 未冻结前只能写 spike，不得合并正式 API。

### Integration gate

- V8 开始前 queue factory、events、cancel/backpressure API 必须冻结。

### Merge gate

- fake upstream/downstream 下顺序、格式、backlog、cancel、资源清理全测。
- 不访问真实 GPU/网络。

## 2. 目标

把 V6 committed utterance 按 sequence 严格转成连续 PCM sink。Queue 不订阅 Agent events，
不创建公开 Job，不处理 HTTP 鉴权；它是 V8 可注入、可取消的内部执行组件。

## 3. 允许修改

- `runtimes/pi/packages/server/src/voice/live/utterance-queue.ts`
- 对应内部 types/test fixtures/tests
- V7 handoff

禁止修改 Protocol、Web、Voice Service、Avatar 和 Phase 1 route。

## 4. 建议接口

```ts
interface UtteranceQueueOptions {
  synthesize(input: { text: string; profileId: string; signal: AbortSignal }): Promise<PcmSource>;
  sink: PcmSink;
  limits: QueueLimits;
  signal: AbortSignal;
  onEvent(event: QueueEvent): void;
}

interface UtteranceQueue {
  enqueue(utterance: CommittedUtterance): void;
  closeInput(): Promise<void>;
  cancel(reason: QueueCancelReason): Promise<void>;
  readonly completion: Promise<QueueResult>;
}
```

具体命名可调整，但必须满足：同步 enqueue ownership 明确、closeInput 可等待 drain、cancel
幂等、completion 单次 settle、事件不含原文。

## 5. 冻结行为

- sequence 必须从 1 连续；重复/跳号失败，不自行排序猜测。
- 单 request in flight，N EOF 后才开始 N+1。
- 首 source 冻结 `pcm_f32le/sampleRate/channels=1`。
- 后续格式不一致在写该 utterance 首字节前失败。
- sink `write=false`/promise pending 时暂停 source 读取。
- cancel abort 当前 source、discard pending、关闭 sink、settle once。
- source/sink/listener error 进入安全 QueueResult，不泄漏文本/upstream body。
- `closeInput()` 后拒绝 enqueue，queue drain 后 completed。
- empty input close 合法完成。

## 6. Backlog

默认限制：

```text
maxQueuedUtterances=12
maxQueuedCharacters=1200
maxEstimatedAudioSeconds=90
```

估算算法必须确定、保守、记录在 handoff。超限立即 `speech_backlog_exceeded`，不静默丢句。
generating 当前项是否计入限制必须冻结并测试，推荐计入总未完成 backlog。

## 7. 必测矩阵

- 3+ utterance 顺序与单并发。
- upstream chunk 任意分割，字节原样顺序写。
- source 第一/中间/最后错误。
- format mismatch。
- sink backpressure、close/error。
- enqueue while generating、close while pending、empty close。
- cancel queued/generating/streaming/draining，多次 cancel。
- backlog 三种限制及边界值。
- late upstream callback 不写已取消 sink。
- timer/listener/reader 无泄漏。

## 8. 验收与交接

```bash
cd runtimes/pi
npm run test --workspace=@earendil-works/pi-server -- utterance-queue
npm run typecheck --workspace=@earendil-works/pi-server
npm run build --workspace=@earendil-works/pi-server
git diff --check
```

Handoff 提供 API、状态图、format/backpressure/backlog 算法、fake 使用法、测试结果和 V8
组合示例。完成后标记 `Review / API frozen`。

