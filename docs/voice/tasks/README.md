# Pi 语音开发任务索引

状态：Phase 1 Review / Phase 2 Ready for assignment

- Phase 1 总规范：[`../PI-STREAMING-SPEECH-SPEC.md`](../PI-STREAMING-SPEECH-SPEC.md)
- Phase 2 总规范：[`../PI-LIVE-AGENT-SPEECH-SPEC.md`](../PI-LIVE-AGENT-SPEECH-SPEC.md)

## 1. 任务清单

| ID | 任务 | 状态 | 主要产物 | 前置 |
| --- | --- | --- | --- | --- |
| V1 | [Voice Service streaming](./V1-voice-service-streaming.md) | Review | Python 正式流式 API | 总规范批准 |
| V2 | [Protocol + Server proxy](./V2-protocol-server-proxy.md) | Review | Protocol v3、SpeechManager、HTTP proxy | 总规范批准；真实联调依赖 V1 |
| V3 | [Client + Web Audio](./V3-client-web-audio.md) | Review | typed client、PCM player、朗读 UI | V2 schema/API frozen |
| V4 | [Avatar integration](./V4-avatar-integration.md) | Deferred / Experimental | bridge 第一版；不属当前里程碑 | 无 |
| V5 | [Live Speech Contract](./V5-live-speech-contract.md) | Ready | Protocol v4 live contract | Phase 1 V2 |
| V6 | [Incremental Text Segmenter](./V6-incremental-text-segmenter.md) | Ready | projector + segmenter | 可与 V5 并行 |
| V7 | [Utterance Queue](./V7-utterance-queue.md) | Review | ordered TTS queue | V5 + V6 + V1 |
| V8 | [Server Live Coordinator](./V8-server-live-coordinator.md) | Review | Agent delta 到单 PCM stream | V5 + V6 + V7 |
| V9 | [Web Live Speech UX](./V9-web-live-speech-ux.md) | Phase 2 E2E ready | 自动朗读和 Stop | V5 frozen + V8 ready |

## 2. Phase 1 历史顺序

```text
                 ┌─ V1 Voice Service ───────┐
Spec approved ───┤                          ├─ V3 Client/Web ── V4 Avatar
                 └─ V2 Protocol/Server ─────┘
```

- V1 和 V2 可由两名开发者并行。V2 使用 fake upstream 完成大部分测试，最后与 V1 联调。
- V2 应先提交 protocol-only contract commit，V3 才能基于冻结 schema 开工。
- V3 可先实现纯 PCM parser 和 fake AudioContext 测试，但正式接线必须等待 V2。
- V4 当前延期，不是 Phase 2 依赖或验收项。

## 3. Phase 2 依赖与门槛

```text
Phase 1 V1/V2/V3 baseline
          ├──────────────┐
          ▼              ▼
 V5 Live contract    V6 Segmenter
          └──────┬───────┘
                 ▼
          V7 Utterance Queue
                 ▼
          V8 Server Coordinator
                 ▼
          V9 Web Live UX
```

- V5 与 V6 可全量并行。
- V9 在 V5 frozen 后只可提前做纯 UI、AudioContext unlock 和 fake tests。
- V7 必须等 V5/V6 frozen；V8 必须等 V7；V9 正式接线必须等 V8。
- V5–V9 每份任务单都明确 Hard prerequisite、Soft prerequisite、Parallel-safe subset、Integration gate 和 Merge gate。

## 4. 共同规则

- 开始前完整阅读总规范和自己的任务单。
- Node 任务使用 Node `>=22.19.0`；Python 使用 3.12。
- 不修改任务单“禁止修改”的边界；确需变更时先写 ADR/交接说明并暂停合并。
- 不把 token、原始朗读文本、模型路径、CUDA stack 写入客户端错误或普通日志。
- 不把 PCM 放入 Pi protocol、SessionSnapshot、transcript 或 event log。
- 每个任务使用 fake 完成自动化测试；真实 GPU/声卡仅作为手动 smoke。
- 提交前运行该任务列出的全部验收命令和 `git diff --check`。
- 交接文档必须记录实际接口、偏离 spec 的决策、测试结果、已知风险和下游使用示例。

## 5. 接口冻结点

1. V1 冻结 `/v1/synthesize/stream` 请求、响应头、PCM 格式和错误矩阵。
2. V2 冻结 Protocol v3 SpeechJob、命令、事件、browser HTTP route 和 client-facing errors。
3. V3 冻结 `SpeechController` 的播放状态与 Avatar hooks。
4. V4 延期，不参与 Phase 2。
5. V5 冻结 v4 live contract。
6. V6 冻结 projector/segmenter。
7. V7 冻结 queue/backpressure/backlog。
8. V8 冻结 live HTTP route 和 coordinator。
9. V9 不反向修改 V5–V8。

若冻结后必须破坏性变更，更新总规范、受影响任务单和 protocol version，再通知所有 owner。

## 6. 合并顺序

1. V2 protocol-only commit（schema、codec、类型与测试）。
2. V1 Voice Service streaming。
3. V2 Server proxy 与 V1 联调。
4. V3 Client + Web Audio。
5. V4 暂缓。
6. V5 contract。
7. V6 projector/segmenter。
8. V7 queue。
9. V8 coordinator + real V1 smoke。
10. V9 client/web + browser E2E。

每一步必须保持主分支可构建；未完成的功能用 server 配置/capability 隐藏，不能提交一个
默认展示但必然失败的朗读按钮。
