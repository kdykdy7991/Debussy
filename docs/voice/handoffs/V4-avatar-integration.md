# V4 Handoff：Avatar Integration

**状态**：桥接器已实现；Pi Web 宿主挂载待配置角色 manifest 后完成。

## 组合入口

`runtimes/pi/packages/web/src/features/avatar/speech-bridge.ts` 消费 V3 冻结的 `SpeechControllerHooks`，通过公开 `AvatarController` 接口转发状态和音量。`SpeechController` 继续唯一拥有 AudioContext、PCM decoder、AudioPlayer 和 playback RAF；V4 不创建第二个媒体源。

## 生命周期

```text
onPlaybackStart -> setState("speaking")
onAudioLevel(level) -> setAudioLevel(clamp(level, 0, 1))
onPlaybackEnd(reason) -> setAudioLevel(0) -> setState("idle")
```

桥接器错误只 detach 自身并调用安全诊断回调，不取消 SpeechJob，也不改变 V3 terminal reason。generation token 阻止迟到 callback 写入已切换的 controller。

## 电平与降级

V3 当前使用 PCM 窗口 RMS、noise gate `0.004`、平滑 `alpha=0.3`、clamp `[0,1]`；V4 直接消费该 hook，不创建 AnalyserNode。未 attach、Avatar 未 ready/destroyed、manifest 无映射、renderer 抛错或音频能力不可用时均 no-op，语音继续正常工作。

## 清理

宿主应在 session 切换、断开、pagehide、unmount 时 detach bridge，再销毁 Avatar handle；detach 尽力写入最终零电平。SpeechController 自己继续执行 V3 的 stop/cancel/abort 清理路径。

## 验证状态

自动化桥接测试与 Pi Web 全量 test/typecheck/build 待运行。真实 Rive CDN、声卡、Voice Service 和三类角色截图验收尚未执行。

## 限制与偏离

遵循 V3 ADR-001（电平来自 PCM 而非 AnalyserNode），未修改 SpeechJob、HTTP wire format 或 Avatar 公共契约。Pi Web 的角色 manifest/宿主开关尚未确定，因此本提交只提供可注入桥接层。
