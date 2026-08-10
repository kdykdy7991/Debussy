# A7 任务单：浏览器音频播放器

状态：Deferred（视觉预览和 Agent 通信之后再启动）  
执行者：AI-A（强模型/技术负责人）  
前置：A1 Core 语音契约已完成

优先级说明：技术前置已满足，但按产品顺序暂不执行；先完成 A6、A6-PREVIEW 和后续 Agent Adapter 阶段。

## 1. 目标

实现内部 Web Audio 播放器，使 `AvatarRuntimePort.startSpeech()` 能获得符合 `AvatarSpeechSession` 的真实会话。A7 只负责加载、播放、结束、停止、打断和资源清理；音量采样属于 A8。

## 2. 必须阅读

- `docs/avatar/decisions/0001-public-contract-and-package-exports.md`
- `packages/avatar/src/core/controller.ts`
- `packages/avatar/src/core/runtime.ts`
- `packages/avatar/src/testing/fake-audio.ts`
- `packages/avatar/test/controller.test.mjs`

## 3. 允许修改

- `packages/avatar/src/audio/**`
- `packages/avatar/test/audio-player*.test.mjs`
- 音频测试所需的最小依赖接口
- 音频内部设计 ADR
- `docs/avatar/handoffs/A7-audio-player.md`

禁止新增 `unlockAudio()` 等公共方法，禁止修改 Controller 事件顺序和 reason。

## 4. 冻结的内部行为

- 提供内部 `AvatarAudioPlayer` 能力：`startSpeech(input, signal)`、`destroy()`；返回现有 `AvatarSpeechSession`。
- 使用可注入测试的 `HTMLAudioElement`/`AudioContext` 依赖，设置 `src` 前设置跨域策略。
- 只有媒体实际进入 playing 状态后 start Promise 才 resolve。
- `ended` → completed；`stop("stopped")` → stopped；`stop("interrupted")` → interrupted。
- AbortSignal reason 为 stopped 时按 stopped，其余按 interrupted。
- 新播放开始前终止旧会话；旧事件不得结束或修改新会话。
- stop/destroy 幂等；移除监听器、pause、断开节点，释放本实例拥有的 AudioContext。
- destroy 后 start 抛 `ALREADY_DESTROYED`。

## 5. 错误映射

| 场景 | AvatarError code |
| --- | --- |
| `play()` 以 `NotAllowedError` 拒绝 | `AUDIO_AUTOPLAY_BLOCKED` |
| URL/媒体/网络/CORS 在播放前失败 | `AUDIO_LOAD_FAILED` |
| 已开始播放后的失败或其他 play reject | `AUDIO_PLAYBACK_FAILED` |

不得把自动播放受阻伪装成 completed，不得留下未处理 Promise rejection。

## 6. 测试、验证与交接

测试覆盖正常播放、自然结束、停止、打断、开始前 abort、连续播放、旧事件迟到、错误映射、pending start destroy、重复 destroy 和资源清理；不得访问真实网络或声卡。

运行完整 typecheck/test/build/pack/diff-check。创建 A7 handoff，写明构造入口、依赖注入、错误矩阵、会话时序、清理证明和 A8 插入音量分析的位置。等待 Review，不启动 A8。
