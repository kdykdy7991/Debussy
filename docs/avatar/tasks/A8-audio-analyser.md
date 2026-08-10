# A8 任务单：AnalyserNode 音量采样

状态：Deferred；视觉预览和 Agent 通信之后，且 A7 approved 才启动  
执行者：AI-A（强模型/技术负责人）  
前置：A7

## 1. 目标与边界

在 A7 音频图上加入 `AnalyserNode`，把时域样本转换为稳定、归一化的 `0..1` 音量并送给 renderer。不得增加 viseme、频谱公共 API、麦克风输入或 Agent/TTS 逻辑。

## 2. 允许修改

- `packages/avatar/src/audio/**`
- A8 必需的内部 runtime 集成接口
- `packages/avatar/test/audio-analyser*.test.mjs`
- `docs/avatar/handoffs/A8-audio-analyser.md`

## 3. 必须实现

- 采样来源是正在播放的媒体节点，不创建第二份播放。
- 使用时域样本计算 RMS/幅度；输出必须有限并钳制到 `0..1`，静音输出 0。
- 允许内部常量做轻量平滑/噪声门，但不得新增公共配置字段；算法与常量写入交接单。
- RAF 只在实际播放期间存在，同一会话最多一个循环。
- completed、stopped、interrupted、failed、abort、destroy 所有路径都 cancel RAF 并同步输出最后一个 0。
- 旧会话的 RAF/回调不得写入新会话。
- 缺少 Web Audio/Analyser 能力时使用现有 `UNSUPPORTED_BROWSER`。
- 公共事件仍只由 Core 负责。

## 4. 确定性测试

注入 RAF、cancelRAF、AnalyserNode 和样本 buffer，覆盖静音、已知 RMS、钳制、NaN、逐帧更新、所有结束 reason 归零、快速切换、destroy、无 RAF 泄漏和 unsupported browser。

必须断言最终 0 写入发生在 speech session `finished` resolve 之前，从而满足 `avatar-speech-end` 前嘴型归零。

## 5. 验证与交接

运行完整 typecheck/test/build/pack/diff-check。创建 A8 handoff，写明算法、采样频率、平滑参数、生命周期图、注入接口和 A9 组合示例。等待 Review，不启动 A9。
