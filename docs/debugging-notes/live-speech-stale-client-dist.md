# 实时朗读失效：Web 加载陈旧 Client 构建产物

## 摘要

实时朗读的服务端增量处理、分句和 TTS 都正常，但浏览器没有及时领取音频流。根因不是模型、TTS、分句器或浏览器自动播放策略，而是 Vite 通过包导出加载了陈旧的 `packages/client/dist/client.js`。旧产物缺少实时 job 订阅逻辑，导致生成过程中的 `live_speech_job` 事件被丢弃。

最终修复是在 Web 的 Vite 配置中将 `@earendil-works/pi-client` 显式映射到当前源码入口 `packages/client/src/index.ts`。

## 用户可见现象

- 已打开“实时朗读”开关。
- 页面文字正常流式显示。
- Voice Service 的 `/v1/synthesize/stream` 请求很晚才出现，或出现后没有声音。
- 手动点击“朗读”会再次发起请求，并且可以听到声音。
- 后续一度表现为自动播放完全失效。

这些现象容易让人首先怀疑：

- 浏览器 autoplay 策略阻止了 `AudioContext`；
- TTS 冷启动期间前端提前清理播放器；
- LLM 没有输出增量 delta；
- 服务端一直等到完整回答后才提交文本；
- PCM 解码或 Web Audio 调度失败。

上述方向部分存在合理风险，但都不是本次主故障。

## 系统期望链路

```text
用户提交 prompt
  → 创建 live-speech job
  → LLM 输出 assistant_delta
  → 文本投影与增量分句
  → utterance 进入 TTS 队列
  → Voice Service 返回流式 PCM
  → 服务端向浏览器发布 live_speech_job
  → 浏览器领取 /api/pi/v4/live-speech/{jobId}/stream
  → PCM 解码并通过 Web Audio 播放
```

分句器不是等完整 output 才工作。默认规则包括：

- 至少 12 字后遇到 `。！？` 等强标点即可提交；
- 达到约 60 字时尝试在软边界切分；
- 达到 120 字时强制切分；
- delta 停顿 1 秒且累计至少 12 字时提交；
- 回答结束时 flush 剩余内容。

## 第一阶段：错误表象与保护性修复

最初日志显示首次 TTS 冷启动时，job 可能先进入 `completed`，HTTP 音频流仍在等待首个 PCM。前端 `LivePlaybackController` 原先会在 `generating` 状态收到 `completed` 后立即 teardown，可能中止尚未解析的流。

因此增加了保护：如果流仍处于 opening 状态或已有 reader，不因 job 提前完成而中止，继续等待并排空 PCM。这个修复是合理的竞态保护，但没有解决自动实时朗读完全失效的问题。

经验：局部竞态成立，不等于它就是当前端到端故障的主因。必须用跨层时间线验证。

## 第二阶段：加入服务端时序日志

为了停止猜测，为同一个 job 增加了不含正文的日志：

```text
prepared
assistant_item_bound
assistant_delta
utterance_committed
tts_request_started
tts_first_pcm_ready
browser_stream_claimed
browser_first_pcm
queue_finished
```

日志只记录 job/session 标识、字符数、序号、状态和相对耗时，不记录用户文本。

第一次关键日志证明：

```text
assistant_delta elapsed_ms=781
utterance_committed elapsed_ms=1546 sequence=1 characters=32
tts_request_started elapsed_ms=1547 characters=32
tts_first_pcm_ready elapsed_ms=8951 sample_rate=24000
queue_finished elapsed_ms=12962 status=failed committed=12 completed=0 bytes=0
```

由此得到确定结论：

1. LLM 确实流式输出；共记录到 136 个 delta、309 个字符。
2. 服务端确实边生成边分句；第一段在 1.546 秒形成。
3. TTS 在 1.547 秒启动，而 LLM 后续仍生成约 11 秒。
4. TTS 冷启动约 7.4 秒后已经产生首个 PCM。
5. 日志中没有 `browser_stream_claimed`，所以浏览器从未领取流。
6. 浏览器未领取导致首段 PCM 无法写出，后续 utterance 持续积压；第 13 段触发队列上限，job 失败。

这排除了 LLM、分句器和 TTS，故障范围被收敛到：

```text
服务端 live_speech_job 事件
  → Client 分发
  → React 订阅
  → LivePlaybackController.attach()
```

## 第三阶段：加入浏览器链路日志

前端增加以下诊断点：

```text
job_event_received
react_job_received
handle_bound
controller_attached
stream_opening
stream_opened
first_pcm_received
audio_scheduled
```

故障复现时，Console 只有：

```text
handle_bound status=failed
controller_attached status=failed
```

并且两条都在文字完整显示后才出现。

这说明生成过程中的 job 事件没有进入 React；最后两条来自 prompt 完成响应中的兜底 job。由于服务端 job 对象已经变成 `failed`，前端此时绑定已经来不及。

## 最终根因

Web 代码使用包名导入：

```ts
import { PiClient } from "@earendil-works/pi-client";
```

`packages/client/package.json` 的 exports 指向：

```text
./dist/index.js
```

Vite 开发服务器因此加载 `packages/client/dist/client.js`。该 dist 是陈旧产物，其 `#dispatchLiveSpeechJob()` 逻辑为：

```ts
const handle = this.#liveSpeechHandles.get(job.id);
if (!handle) return;
```

旧实现的关键问题：

- 没有 `onLiveSpeechJob()` 订阅 API；
- 首次收到 job 事件时不会创建 handle；
- handle 尚未由 prompt 最终响应注册时，所有实时事件直接丢弃；
- prompt 响应要等整个 Agent 操作完成才返回；
- 返回时服务端队列已经因浏览器未领取流而失败。

源码 `packages/client/src/client.ts` 已经具备正确实现，但浏览器根本没有使用这份源码。这也是为什么修改源码、测试通过，却在浏览器里没有任何改善。

## 修复

在 `packages/web/vite.config.ts` 中显式映射 workspace client 到源码入口：

```ts
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@earendil-works/pi-client": fileURLToPath(
        new URL("../client/src/index.ts", import.meta.url),
      ),
    },
  },
});
```

修复后 Vite 的实际解析结果为：

```text
@earendil-works/pi-client
→ packages/client/src/index.ts
```

必须完全重启 Vite 并强制刷新浏览器，避免继续使用依赖预构建缓存。

## 修复后的证据

浏览器 Console 出现完整链路：

```text
job_event_received status=waiting_for_text listeners=1
react_job_received active_session_match=true
handle_bound status=waiting_for_text
controller_attached status=waiting_for_text
stream_opening
stream_opened sample_rate=24000 channels=1
first_pcm_received bytes=61440
audio_scheduled
```

用户同时确认已经听到声音。这证明：

- 实时 job 事件在回答生成期间抵达；
- React 成功绑定 job；
- 浏览器及时领取 HTTP PCM 流；
- PCM 到达播放器；
- Web Audio 成功调度并发声。

## 验证命令

针对性测试：

```bash
cd runtimes/pi/packages/server
node ../../node_modules/vitest/dist/cli.js --run test/live-speech-manager.test.ts

cd ../client
node ../../node_modules/vitest/dist/cli.js --run test/speech-client.test.ts

cd ../web
node ../../node_modules/vitest/dist/cli.js --run test/live-playback-controller.test.ts
```

完整检查：

```bash
cd runtimes/pi
npm run check
```

## 排查清单

遇到“源码和测试都正确，但浏览器行为没有变化”时，优先检查：

1. 浏览器实际加载的是源码、workspace 包，还是旧 dist。
2. `package.json` 的 `main`、`exports` 和 `types` 分别指向哪里。
3. Vite/Webpack 的 alias 和依赖预构建缓存。
4. 修改 workspace 依赖后，是否需要重新构建或让开发服务器直连源码。
5. 测试导入路径是否绕开了真实应用使用的包入口。
6. 不要用“单元测试通过”替代浏览器实际模块解析验证。

对于流式链路，还应始终按阶段记录：

```text
输入 delta
→ 分段提交
→ 上游请求
→ 上游首字节
→ 下游领取
→ 下游首字节
→ 本地调度
→ 播放结束
```

缺失的第一个阶段就是最接近根因的位置。

## 经验总结

- 页面文字流式显示，能直接证明 UI 收到了增量内容，但不能证明语音订阅使用了同一套最新客户端代码。
- 服务端出现 TTS 200，不代表浏览器领取或播放了音频。
- `audio_scheduled` 比“请求成功”更接近用户能听到声音，但最终仍应由真实听感确认。
- 冷启动性能问题和事件分发故障可以同时存在，要用时间线拆开判断。
- 对 monorepo 开发环境，陈旧 dist 是高风险来源。源码测试、类型检查与实际浏览器 bundle 可能使用三条不同的解析路径。
