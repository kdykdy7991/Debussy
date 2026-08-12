# V4 任务单：Avatar integration

状态：Deferred / Experimental（当前核心里程碑不实施）  
建议执行者：Avatar / React integration 开发  
总规范：[`../PI-STREAMING-SPEECH-SPEC.md`](../PI-STREAMING-SPEECH-SPEC.md)  
前置：V3；`@skdy/avatar` 可由 Pi Web 稳定消费

> 2026-08-12 范围调整：当前核心目标仅包括 Voice Service 可用与 Pi Agent Web
> 增量输出实时转语音。V4 第一版 bridge 可保留研究，但不得成为 V5–V9 的依赖、不得
> 挂载到正式 App，也不计入 Phase 2 Definition of Done。

## 1. 目标

把 V3 的实际播放生命周期接到数字人：真正出声时进入 `speaking`，播放结束/停止/失败时
回到 `idle`；使用同一 Web Audio graph 的 AnalyserNode 计算音量并调用
`AvatarController.setAudioLevel(0..1)`。没有 Avatar 或角色没有 audioLevel 映射时，语音
必须继续正常工作。

本任务不实现精确 viseme，不重写 V3 播放器，不改变 SpeechJob 协议。

## 2. 必须阅读

- 总规范第 3、11.5、13.4、13.5、19 节
- V3 handoff
- `packages/avatar/README.md`
- `packages/avatar/src/core/types.ts`
- `packages/avatar/src/core/controller.ts`
- `packages/avatar/src/runtime/visual-avatar-runtime.ts`
- `packages/avatar/src/renderers/rive/rive-renderer.ts`
- `docs/avatar/tasks/A7-audio-player.md`
- `docs/avatar/tasks/A8-audio-analyser.md`
- `runtimes/pi/packages/web/src/features/avatar/README.md`
- Pi Web app/session 生命周期

## 3. 允许修改

- `runtimes/pi/packages/web/src/features/avatar/**`
- `runtimes/pi/packages/web/src/features/voice/**`，仅限接入 V3 已冻结 hooks 的最小组合代码
- `runtimes/pi/packages/web/src/app.tsx`
- `runtimes/pi/packages/web/src/styles.css`
- `runtimes/pi/packages/web/test/**`
- `runtimes/pi/packages/web/package.json` 和 `runtimes/pi/package-lock.json`，仅限接入已批准
  的 `@skdy/avatar` 版本
- `packages/avatar/**` 仅允许经 Avatar owner 批准的 bug fix；默认禁止修改公共契约
- `docs/voice/handoffs/V4-avatar-integration.md`

## 4. 禁止修改

- Voice Service、Pi Server、Protocol、Pi Client
- SpeechJob 或 HTTP wire format
- 另建第二个音频播放源
- 让 Avatar failure 中断、取消或阻塞语音
- 添加 microphone/ASR/viseme
- 为单个 Marketplace 角色硬编码 input 名称
- 未经批准修改 `@skdy/avatar` public exports/events

## 5. 组合设计

### 5.1 生命周期

```text
V3 onPlaybackStart
  -> avatar.setState("speaking")
  -> start one RAF analyser loop

V3 onAudioLevel(level)
  -> avatar.setAudioLevel(level)

V3 onPlaybackEnd(reason)
  -> cancel RAF
  -> avatar.setAudioLevel(0)
  -> avatar.setState("idle")
```

必须保证最后一个 `setAudioLevel(0)` 发生在 UI 宣布播放 ended/stopped 之前。

### 5.2 Analyser

- 采样 V3 已在播放的节点，不创建第二份媒体或 AudioContext。
- 使用 time-domain RMS，结果 finite 且 clamp `0..1`。
- 可使用内部 noise gate/smoothing 常量，但写入 handoff 并确定性测试。
- 同一 playback 最多一个 RAF。
- 旧 playback callback/RAF 不得写入新角色或新 playback。
- 页面 hidden 可降频，但不能破坏归零。

### 5.3 降级

以下情况只禁用联动，不影响语音：

- Avatar feature 未启用/未 ready/已 destroy。
- 当前 manifest 没有 `speaking` 或 `audioLevel` mapping。
- renderer 报错。
- AnalyserNode 不可用。

捕获 Avatar 错误后记录安全诊断并 detach integration。不要把它转换成 SpeechJob failed。

### 5.4 UI

- Avatar 容器沿用现有 inline/floating 响应式能力。
- 语音按钮仍在 transcript，数字人不是语音入口的唯一位置。
- Avatar 加载慢时，语音可以先播放。
- session 切换或角色切换时，旧 controller/RAF 必须清理。
- 用户可关闭 Avatar，但继续使用朗读。

## 6. 自动化测试

- playback start -> speaking，end/stop/error -> audioLevel 0 + idle。
- 已知样本的 RMS、noise gate、smoothing、clamp、NaN。
- 一个 playback 一个 RAF，所有终态 cancel RAF。
- 快速连续播放和旧 callback 迟到。
- Avatar not ready/destroy/error/no mapping/analyser unsupported。
- Avatar failure 不 cancel speech，不改变 V3 playback terminal reason。
- session/avatar switch/unmount/pagehide 清理。
- React strict mode 下不重复 controller/RAF。
- 不访问真实 Rive CDN、声卡、Voice Service。

## 7. 手动验收

至少用以下三类角色：

1. 有 `speaking + audioLevel` mapping 的测试角色：状态和幅度都变化。
2. 只有 autoplay、`inputs={}` 的角色：能显示，语音正常，联动安全 no-op。
3. manifest/asset 加载失败：语音仍可播放并停止。

再验证：

- 播放真正开始前不提前 speaking。
- Stop 后 500 ms 内静音、嘴型归零、回 idle。
- 连续 20 次朗读/停止无 RAF、AudioNode、Avatar controller 泄漏。

## 8. 验收命令

Pi Web，从 `runtimes/pi`：

```bash
npm run test --workspace=@earendil-works/pi-web
npm run typecheck --workspace=@earendil-works/pi-web
npm run build --workspace=@earendil-works/pi-web
npm run check:browser-smoke
git diff --check
```

若确实修改 Avatar package，再从仓库根的 `packages/avatar` 运行：

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

不修改 Avatar package 时不要为本任务重跑或重写其公共契约。

## 9. 交接产物

创建 `docs/voice/handoffs/V4-avatar-integration.md`：

- 组合入口和依赖方向。
- playback/Avatar 生命周期时序图。
- RMS、noise gate、smoothing 参数。
- 所有 no-op/failure 降级路径。
- 三类角色的手动验收记录和截图。
- RAF/AudioNode/controller 清理证明。
- 自动化测试结果、已知限制、spec 偏离。

完成并通过 review 后，把总规范 Definition of Done 各项标记为已验证。
