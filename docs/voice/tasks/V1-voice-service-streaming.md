# V1 任务单：Voice Service streaming

状态：Review  
建议执行者：Python / GPU 推理开发  
总规范：[`../PI-STREAMING-SPEECH-SPEC.md`](../PI-STREAMING-SPEECH-SPEC.md)  
下游：V2 Protocol + Server proxy

## 1. 目标

把 `faster_qwen3_tts_stream_player.py` 中已验证的 generator 能力移入正式
`pi_voice` provider/service 边界，提供受鉴权的 `POST /v1/synthesize/stream`。
响应必须在首个模型 chunk 可用后立即返回连续 `pcm_f32le`，支持取消、并发限制和安全错误。

任务完成后，smoke player 不再是唯一的流式实现；它只能调用正式服务或复用正式 provider。

## 2. 必须阅读

- `docs/voice/PI-STREAMING-SPEECH-SPEC.md` 第 7、9、12、13、14、18 节
- `services/voice/README.md`
- `services/voice/src/pi_voice/main.py`
- `services/voice/src/pi_voice/service.py`
- `services/voice/src/pi_voice/providers/base.py`
- `services/voice/src/pi_voice/providers/qwen3_tts.py`
- `services/voice/examples/faster_qwen3_tts_stream_smoke.py`
- `services/voice/examples/faster_qwen3_tts_stream_player.py`
- `services/voice/tests/test_service.py`

## 3. 允许修改

- `services/voice/src/pi_voice/**`
- `services/voice/tests/**`
- `services/voice/examples/faster_qwen3_tts_stream_*.py`
- `services/voice/README.md`
- `services/voice/pyproject.toml`
- 根 `pyproject.toml` / `uv.lock`，仅限正确锁定新增 Python 依赖
- `docs/voice/handoffs/V1-voice-service-streaming.md`

## 4. 禁止修改

- `runtimes/pi/**`
- Pi Protocol schema 和版本
- Avatar/Web 代码
- 浏览器直接访问 Voice Service 的设计
- 删除或破坏现有 `/v1/synthesize`
- 将模型缓存、测试 WAV 或 secret 提交 Git

## 5. 冻结的外部契约

```http
POST /v1/synthesize/stream
Authorization: Bearer <PI_VOICE_TOKEN>
Content-Type: application/json
```

```json
{
  "text": "你好",
  "language": "Chinese",
  "speaker": "Vivian",
  "instruct": null,
  "chunkSize": 8,
  "encoding": "pcm_f32le"
}
```

成功响应：

```http
Content-Type: application/vnd.pi.pcm
Cache-Control: no-store
X-Content-Type-Options: nosniff
X-Pi-Audio-Encoding: pcm_f32le
X-Pi-Audio-Sample-Rate: <positive integer>
X-Pi-Audio-Channels: 1
Transfer-Encoding: chunked
```

响应体必须是连续、mono、little-endian IEEE-754 float32 PCM。网络 chunk 边界没有语义。

请求约束：

- `text`、`language`、`speaker` 非空；拒绝额外字段。
- `chunkSize` 为正整数，并有服务端上限，建议 `1..64`。
- 第一阶段 encoding 只接受 `pcm_f32le`。
- 文本长度与现有 `PI_VOICE_MAX_TEXT_LENGTH` 共用。

## 6. 内部设计要求

### 6.1 Provider

- 在 provider boundary 增加 streaming capability，不让 FastAPI route 直接 import
  `FasterQwen3TTS`。
- 明确 chunk 类型：samples、sample rate；每个 chunk 必须 mono。
- 模型仍是进程级单例，lazy load 行为不变。
- 非流式与流式共享同一个 GPU concurrency semaphore。
- 若保留现有 `qwen-tts` provider，清楚区分 artifact provider 与 faster streaming provider；
  不用运行时字符串判断偷偷切 provider。

### 6.2 Service

- `VoiceService.stream()` 负责文本限制、semaphore、采样率一致性、dtype/shape/finite 校验。
- 第一个 chunk 为空或整个 generator 无输出必须失败。
- 后续 chunk sample rate 改变必须失败。
- 显式 `np.asarray(..., dtype="<f4").reshape(-1).tobytes()`。
- generator 在成功、异常、取消、客户端断开时都在 `finally` 中 close。

### 6.3 FastAPI

- 首包前错误返回结构化 JSON；422 用于请求问题，503/502 用于服务/推理问题。
- 首包后异常只关闭流并写安全内部日志，不能把 stack 作为音频字节返回。
- 检测 request disconnect；停止迭代并 close generator。
- streaming response 不设置 `Content-Length`，禁止缓存。
- `/health` 不触发模型加载。

### 6.4 配置

新增配置必须有默认值、环境变量说明和校验。建议：

```text
PI_VOICE_STREAM_CHUNK_SIZE=8
PI_VOICE_STREAM_MAX_CHUNK_SIZE=64
```

模型/依赖必须进入 uv workspace 锁，不依赖开发机偶然安装的 site-package。

## 7. 实施步骤

1. 写 FakeStreamingProvider 和 service-level failing tests。
2. 定义 stream request schema、chunk type 和 provider protocol。
3. 实现 service validation/concurrency/cancellation。
4. 实现 faster-qwen streaming provider。
5. 实现 FastAPI route 和安全错误映射。
6. 让 smoke player 复用正式能力，或明确保留为 provider-level manual test。
7. 更新 README 启动、curl/消费示例和故障排查。
8. 使用真实本地模型做手动首包、播放和取消 smoke。

## 8. 自动化测试

必须覆盖：

- 多 chunk 正常输出与 headers。
- HTTP reader 在完整生成前收到首 chunk。
- 网络输出字节可按 `<f4` 还原。
- 空 generator、空 chunk、NaN/Infinity、非 mono、sample rate 变化。
- 请求 schema、文本限制、chunkSize 边界、鉴权。
- 非流式与流式共享 concurrency=1。
- provider 首包前异常与中途异常。
- consumer 取消/disconnect 会 close generator 并释放 semaphore。
- `/v1/synthesize` 和既有测试不回归。

## 9. 验收命令

从仓库根目录：

```bash
uv sync --package pi-voice-service --extra dev
uv run --package pi-voice-service pytest services/voice/tests
uv run --package pi-voice-service python -m compileall -q services/voice/src services/voice/examples
git diff --check
```

手动 GPU smoke 必须单独记录命令、模型、sample rate、首包耗时、音频时长、RTF 和取消表现，
但不得让 CI 下载模型。

## 10. 交接产物

创建 `docs/voice/handoffs/V1-voice-service-streaming.md`，包含：

- 实际 request/response 示例和完整 header 表。
- Provider/Service 生命周期图。
- 取消能做到的精确粒度及底层库限制。
- 错误矩阵与不会泄漏的信息。
- 自动化测试结果、GPU smoke 数据。
- V2 可直接使用的 base URL、token、timeout 和 fake fixture。
- 与总规范的任何偏离。

完成后状态改为 `Review`，等待 V2 联调；不要开始修改 Pi Server。

