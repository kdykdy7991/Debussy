# V5 任务单：Live Speech Contract

状态：Ready  
职责：Protocol v4 与 server/client compile boundary  
总规范：[`../PI-LIVE-AGENT-SPEECH-SPEC.md`](../PI-LIVE-AGENT-SPEECH-SPEC.md)

## 1. 依赖门槛

### Hard prerequisites

- Phase 1 V2 protocol v3 SpeechJob contract 已冻结。
- 当前 protocol/server/client tests 在开始前通过。

### Soft prerequisites

- V1/V2/V3 真实端到端联调可仍在 Review；本任务使用类型和 fake，不依赖 GPU。

### Parallel-safe subset

- 可与 V6 全量并行。
- 不等待 V7/V8/V9。

### Integration gate

- V8 开始前，本任务必须提交 protocol-only frozen commit。

### Merge gate

- protocol、server、client 全部能针对 v4 编译。
- v3/v4 handshake、codec 和 schema tests 通过。
- 未修改 Phase 1 manual speech 语义。

## 2. 目标

定义 live speech 的公开、provider-neutral 契约，使 Web 可在 prompt 时原子请求实时语音，
并可观察/取消 LiveSpeechJob。V5 不实现分段、队列、Voice Service 调用或 Web UI。

## 3. 必须阅读

- Phase 1 与 Phase 2 两份总 Spec
- V2/V3 handoff
- `packages/protocol/src/schemas.ts`、codec/framing tests
- `packages/server/src/server.ts`、`sessions.ts`、`types.ts`
- `packages/client/src/client.ts`、speech handle/state

## 4. 允许修改

- `runtimes/pi/packages/protocol/src/**`
- `runtimes/pi/packages/protocol/test/**`
- server/client 中为新 union/type 编译所需的最小 stub
- package README/CHANGELOG（协议版本说明）
- `docs/voice/handoffs/V5-live-speech-contract.md`

## 5. 禁止修改

- `services/voice/**`
- Server coordinator/HTTP handler 的真实实现
- Web/Avatar
- Phase 1 SpeechJob 字段和 route
- 将 utterance text、PCM 或 delta 放入 protocol

## 6. 必须交付

- Protocol version 3 -> 4。
- `LiveSpeechRequestSchema`。
- `LiveSpeechStatus/Progress/Error/JobSchema`。
- PromptCommand 可选 `speech`。
- PromptResult 可选 `liveSpeech`。
- `cancel_live_speech` command/result。
- `live_speech_job` event。
- VoiceCapability 增加 `live: boolean`。
- Command/Result/Event/ResultForCommand/codec 全部接线。
- server/client exhaustive switch 使用明确的 `not implemented` stub 或类型处理，不可静默吞消息。

严格遵循 Phase 2 Spec 第 7 节。所有对象使用 `StrictObject`，ID、timestamp、计数范围与现有
schema 一致。

## 7. 决策测试

必须冻结：

- Prompt 不带 `speech` 的 v3 语义保持不变。
- `speech` 只接受 `{mode:"live", voiceProfileId?}`。
- `liveSpeech` 只在 result 中可选出现。
- Live Job 的 turnId/messageId/audio/error 可选组合。
- terminal 状态不可由 client handle 回退。
- `live_speech_job` 不进入 SessionSnapshot。
- VoiceCapability `live=false` 是合法能力降级。
- v3 hello 对 v4 server 明确 version error。

## 8. 验收命令

从 `runtimes/pi`：

```bash
npm run test --workspace=@earendil-works/pi-protocol
npm run build --workspace=@earendil-works/pi-protocol
npm run typecheck --workspace=@earendil-works/pi-server
npm run typecheck --workspace=@earendil-works/pi-client
npm run check:ts-imports
git diff --check
```

## 9. 交接

Handoff 必须包含完整 TypeScript 示例、字段表、兼容性说明、codec test 结果、frozen commit、
V8/V9 应消费的确切类型，以及任何偏离。完成后标记 `Review / Contract frozen`。

