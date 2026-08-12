# Pi 流式语音任务索引

状态：Ready for assignment
总规范：[`../PI-STREAMING-SPEECH-SPEC.md`](../PI-STREAMING-SPEECH-SPEC.md)

## 1. 任务清单

| ID | 任务 | 状态 | 主要产物 | 前置 |
| --- | --- | --- | --- | --- |
| V1 | [Voice Service streaming](./V1-voice-service-streaming.md) | Review | Python 正式流式 API | 总规范批准 |
| V2 | [Protocol + Server proxy](./V2-protocol-server-proxy.md) | Review | Protocol v3、SpeechManager、HTTP proxy | 总规范批准；真实联调依赖 V1 |
| V3 | [Client + Web Audio](./V3-client-web-audio.md) | Blocked | typed client、PCM player、朗读 UI | V2 schema/API frozen |
| V4 | [Avatar integration](./V4-avatar-integration.md) | Blocked | speaking/audioLevel 联动 | V3 approved；Avatar 包可消费 |

## 2. 推荐执行顺序

```text
                 ┌─ V1 Voice Service ───────┐
Spec approved ───┤                          ├─ V3 Client/Web ── V4 Avatar
                 └─ V2 Protocol/Server ─────┘
```

- V1 和 V2 可由两名开发者并行。V2 使用 fake upstream 完成大部分测试，最后与 V1 联调。
- V2 应先提交 protocol-only contract commit，V3 才能基于冻结 schema 开工。
- V3 可先实现纯 PCM parser 和 fake AudioContext 测试，但正式接线必须等待 V2。
- V4 不修改语音协议，不重新实现播放器，只消费 V3 的播放生命周期和音量 hook。

## 3. 共同规则

- 开始前完整阅读总规范和自己的任务单。
- Node 任务使用 Node `>=22.19.0`；Python 使用 3.12。
- 不修改任务单“禁止修改”的边界；确需变更时先写 ADR/交接说明并暂停合并。
- 不把 token、原始朗读文本、模型路径、CUDA stack 写入客户端错误或普通日志。
- 不把 PCM 放入 Pi protocol、SessionSnapshot、transcript 或 event log。
- 每个任务使用 fake 完成自动化测试；真实 GPU/声卡仅作为手动 smoke。
- 提交前运行该任务列出的全部验收命令和 `git diff --check`。
- 交接文档必须记录实际接口、偏离 spec 的决策、测试结果、已知风险和下游使用示例。

## 4. 接口冻结点

1. V1 冻结 `/v1/synthesize/stream` 请求、响应头、PCM 格式和错误矩阵。
2. V2 冻结 Protocol v3 SpeechJob、命令、事件、browser HTTP route 和 client-facing errors。
3. V3 冻结 `SpeechController` 的播放状态与 Avatar hooks。
4. V4 只做组合，不反向修改前三层接口。

若冻结后必须破坏性变更，更新总规范、受影响任务单和 protocol version，再通知所有 owner。

## 5. 合并顺序

1. V2 protocol-only commit（schema、codec、类型与测试）。
2. V1 Voice Service streaming。
3. V2 Server proxy 与 V1 联调。
4. V3 Client + Web Audio。
5. V4 Avatar integration。

每一步必须保持主分支可构建；未完成的功能用 server 配置/capability 隐藏，不能提交一个
默认展示但必然失败的朗读按钮。
