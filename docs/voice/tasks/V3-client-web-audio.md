# V3 任务单：Client + Web Audio

状态：Blocked（等待 V2 protocol-only contract frozen）  
建议执行者：TypeScript client / React Web 开发  
总规范：[`../PI-STREAMING-SPEECH-SPEC.md`](../PI-STREAMING-SPEECH-SPEC.md)  
前置：V2 schema frozen；正式联调依赖 V2 Server approved

## 1. 目标

在 `pi-client` 中提供 typed SpeechJob 控制能力，在 Pi Web 中实现健壮的 PCM stream
解析、Web Audio 调度、朗读/停止 UI 和生命周期清理。必须做到“首包后播放、EOF 前出声”，
不能退化为先收完整音频再播放。

## 2. 必须阅读

- 总规范第 5–7、10–14、18、19 节
- V2 handoff
- `runtimes/pi/packages/client/src/client.ts`
- `runtimes/pi/packages/client/src/state.ts`
- `runtimes/pi/packages/client/src/types.ts`
- `runtimes/pi/packages/web/src/app.tsx`
- `runtimes/pi/packages/web/src/lib/connection-controller.ts`
- `runtimes/pi/packages/web/src/lib/session-controller.ts`
- `runtimes/pi/packages/web/src/lib/uploader.ts`
- Web 现有 tests、styles 和 transcript rendering

## 3. 允许修改

- `runtimes/pi/packages/client/src/**`
- `runtimes/pi/packages/client/test/**`
- `runtimes/pi/packages/web/src/features/voice/**`
- `runtimes/pi/packages/web/src/app.tsx`
- `runtimes/pi/packages/web/src/styles.css`
- `runtimes/pi/packages/web/test/**`
- client/web README 和必要 package metadata
- `docs/voice/handoffs/V3-client-web-audio.md`

## 4. 禁止修改

- Protocol schema（问题交回 V2）
- Server/Voice Service
- `packages/avatar/**`
- 在本任务加入数字人依赖或 viseme
- 使用 `<audio src>` 假装支持 raw PCM
- 完整 `arrayBuffer()` 后再播放
- token query parameter、localStorage 新增明文 secret

## 5. Pi Client deliverable

提供：

```ts
PiClient.startSpeech(options): Promise<SpeechJobHandle>
SpeechJobHandle.subscribe(listener): Unsubscribe
SpeechJobHandle.cancel(): Promise<SpeechJob>
openSpeechStream({ baseUrl, streamPath, token, signal })
```

要求：

- start/cancel 使用 V2 typed command。
- `speech_job` 只更新对应 handle；终态后 listener 可安全释放。
- disconnect/dispose reject pending request，并使活动 handle 不可继续操作。
- HTTP helper 校验 relative streamPath，拒绝跨 origin URL。
- Bearer token 只进入 Authorization header。
- 严格校验 response status 和音频 metadata；错误 body 有大小上限。
- `fetch` 可注入，Node client 用户不需要 DOM/AudioContext。

## 6. Web 内部模块

```text
runtimes/pi/packages/web/src/features/voice/
├── audio-player.ts
├── pcm-stream.ts
├── speech-controller.ts
├── speech-button.tsx
├── voice-settings.tsx
└── types.ts
```

### 6.1 PCM parser

- 接收任意 `Uint8Array` 网络分块。
- 保存 1/2/3 字节 remainder。
- 显式 little-endian 解码 float32。
- NaN/Infinity 失败；有限值 clamp 到 `[-1, 1]`。
- EOF remainder 非空失败。
- parser 是纯逻辑，可无浏览器测试。

### 6.2 Audio player

- AudioContext 只在用户手势路径创建/resume。
- 默认首播缓冲 120 ms，目标 250 ms，最大 queued duration 2 秒。
- 使用 `AudioBufferSourceNode` 顺序调度。
- generation EOF 后进入 draining，最后一个 source ended 后才 ended。
- underrun 重建 safety lead 并计数。
- queued 超限暂停 reader，形成 fetch/HTTP backpressure。
- stop 幂等：abort fetch、stop nodes、移除 handler、清空 queue。
- 可注入 AudioContext、clock 和 RAF，测试不使用真实声卡。

### 6.3 SpeechController

本地状态：

```text
idle -> requesting -> buffering -> playing -> draining -> ended
                      └──────────── stop/error ──────────>
```

- 同一页面只允许一个 active playback。
- 开始新消息前完整停止旧消息。
- server Job completed 与本地 ended 分开。
- session change、disconnect、unmount、pagehide 都清理。
- 公开内部 hooks：`onPlaybackStart`、`onAudioLevel`（可选）、`onPlaybackEnd`，供 V4 使用；
  V3 不依赖 Avatar。

### 6.4 UI

- 仅 complete assistant message 且 server snapshot 宣称 voice capability 时显示朗读按钮。
- requesting/buffering 显示加载；playing/draining 显示停止。
- 不给 thinking、tool、streaming/error/aborted item 显示朗读。
- 错误可恢复，不破坏 transcript 或发送消息。
- 第一次播放必须由 click/tap 触发；自动朗读暂不实现或默认关闭。
- 基础键盘、focus、aria-label 和 reduced-motion 行为符合现有 Web 规范。

## 7. 自动化测试

Client：

- start/cancel request、Job event、终态、disconnect/dispose。
- streamPath/origin/token/header/status/metadata。
- fetch abort 与有限大小错误 body。

Web：

- 1/2/3 字节和随机网络分块 parser property cases。
- finite/clamp/NaN/Infinity/truncated EOF。
- buffer scheduling、resampling input metadata、underrun、backpressure。
- normal EOF -> draining -> ended。
- stop during request/buffer/play/drain。
- 快速切换消息、旧 callback 迟到、unmount/session/disconnect。
- autoplay blocked 显示可恢复提示。
- voice capability 缺失时不展示按钮。
- 不访问真实网络、GPU 或声卡。

## 8. 验收命令

从 `runtimes/pi`：

```bash
npm run test --workspace=@earendil-works/pi-client
npm run typecheck --workspace=@earendil-works/pi-client
npm run build --workspace=@earendil-works/pi-client
npm run test --workspace=@earendil-works/pi-web
npm run typecheck --workspace=@earendil-works/pi-web
npm run build --workspace=@earendil-works/pi-web
npm run check:browser-smoke
git diff --check
```

手动浏览器验收：

1. warm model 在完整生成结束前出声。
2. 连续朗读不同消息只有最后一个播放。
3. Stop 到静音小于 500 ms。
4. session 切换、刷新、断网不留后台声音。
5. Voice Service down 时聊天仍正常。

## 9. 交接产物

创建 `docs/voice/handoffs/V3-client-web-audio.md`：

- Client API 示例、HTTP base URL/token 配置方式。
- Playback 状态机与 server Job 状态对应表。
- PCM remainder、缓冲、underrun 和 backpressure 算法。
- 所有清理路径和资源所有权。
- UI 截图/手动浏览器结果。
- V4 hooks 的类型、调用顺序和 audioLevel 频率。
- 自动化测试结果、已知浏览器差异、spec 偏离。

完成后状态改为 `Review`；V4 只能消费已交接的 hooks。

