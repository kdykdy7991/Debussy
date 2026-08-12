# Pi Voice Service

Pi Voice Service 是独立的本机 Python 语音合成服务。第一阶段使用 Qwen3-TTS CustomVoice，把文本转换为 WAV artifact；它不负责语音识别，也不直接向浏览器开放。

## 1. 为什么独立部署

当前 Pi 主仓库是 Node.js/TypeScript monorepo，而 Qwen3-TTS 依赖 Python、PyTorch、CUDA 和可选的 FlashAttention。将推理运行时隔离在 `services/voice` 可以：

- 避免 Python/CUDA 依赖污染 npm workspace。
- 让模型只加载一次，并独立控制 GPU 并发。
- 保持 `runtimes/pi/packages/server` 为认证和业务编排边界。
- 后续替换 TTS Provider、增加流式音频或语音克隆时不改 Web 组件架构。
- TTS 故障时不影响文本对话。

## 2. 目录结构

```text
services/voice/
├── .env.example
├── pyproject.toml
├── README.md
├── src/pi_voice/
│   ├── __init__.py
│   ├── config.py
│   ├── main.py
│   ├── schemas.py
│   ├── service.py
│   └── providers/
│       ├── __init__.py
│       ├── base.py
│       ├── faster_qwen3_tts.py
│       └── qwen3_tts.py
└── tests/
    ├── test_service.py
    └── test_streaming.py
```

## 3. 系统边界

```text
runtimes/pi/packages/web
    │ 朗读操作
    ▼
runtimes/pi/packages/server
    │ 内部 Bearer token
    ▼
services/voice
    │ CUDA inference
    ▼
Qwen3-TTS → 流式 PCM 直接到 server；/v1/synthesize 写 ~/.pi/agent/audio/artifacts/*.wav
```

浏览器不得直接调用本服务。未来由 `runtimes/pi/packages/server/src/voice` 调用
`/v1/synthesize/stream`（或 `/v1/synthesize`），再通过经过认证的 Pi 音频路由向
浏览器转发 PCM / artifact。Python 返回的本地 `path` 只供 server 使用，不能进入公开
protocol 或前端响应。

## 4. 当前能力

- `GET /health`：检查服务状态；不会触发模型加载。
- `POST /v1/synthesize`：使用 CustomVoice 生成 WAV artifact（保留以作回退/对比）。
- `POST /v1/synthesize/stream`：使用 faster-qwen3-tts 流式返回连续 `pcm_f32le`，
  首个模型 chunk 可用后立即开始传输。
- 流式与非流式共享同一个 GPU 并发 semaphore（默认 concurrency=1）。
- 流式支持取消：客户端断开/请求取消会停止迭代并 close generator，尽快释放 GPU。
- Bearer token 鉴权、文本长度限制。
- 模型首次请求时延迟加载，流式模型进程级单例。
- 随机 artifact ID 和仓库外音频目录。

当前未实现：

- TypeScript server 集成（V2）。
- Web 播放器（V3）。
- SpeechJob 持久化。
- VoiceDesign、Voice Clone。
- ASR 和麦克风输入。

注意：流式端点由 `faster_qwen3_tts`（CUDA graph）驱动，与 `/v1/synthesize` 使用的
`qwen-tts` CustomVoice 是各自独立的懒加载模型实例。只使用其中一个端点时进程内只会
加载对应模型；同时使用两个端点会各自加载一个模型。

## 5. 环境准备

`skdy-agent` 根目录使用 uv workspace 统一管理 Python 3.12 和锁文件。Voice Service 是 workspace 成员，依赖由根目录 `uv.lock` 锁定。

```bash
cd /path/to/skdy-agent
uv sync --package pi-voice-service --extra dev
```

`uv sync` 会在仓库根目录创建 `.venv`。锁文件已经包含 Qwen3-TTS 和 PyTorch；实际运行前仍需确认锁定的 PyTorch wheel 与本机 CUDA 驱动兼容。

Qwen3-TTS 官方推荐 FlashAttention 2 以减少显存占用，但它只适用于兼容硬件和 FP16/BF16。无法安装时设置：

```bash
PI_VOICE_ATTENTION=sdpa
```

复制配置并生成本机 token：

```bash
cp .env.example .env.local
openssl rand -hex 32
```

`.env.local`、虚拟环境、模型缓存和音频 artifact 不得提交 Git。

## 6. 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PI_VOICE_HOST` | `127.0.0.1` | 只允许本机监听 |
| `PI_VOICE_PORT` | `18876` | 内部 HTTP 端口 |
| `PI_VOICE_TOKEN` | 无 | 必填的 server-to-service token |
| `PI_VOICE_MODEL` | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | 模型 ID 或本地目录 |
| `PI_VOICE_DEVICE` | `cuda:0` | 推理设备 |
| `PI_VOICE_DTYPE` | `bfloat16` | `bfloat16`、`float16` 或 `float32` |
| `PI_VOICE_ATTENTION` | `flash_attention_2` | 可回退为 `sdpa` |
| `PI_VOICE_MAX_CONCURRENCY` | `1` | 同时占用 GPU 的生成数量（流式与非流式共享） |
| `PI_VOICE_MAX_TEXT_LENGTH` | `4000` | 单次字符上限 |
| `PI_VOICE_ARTIFACT_DIR` | `~/.pi/agent/audio/artifacts` | WAV 输出目录 |
| `PI_VOICE_STREAM_CHUNK_SIZE` | `8` | 流式请求缺省 chunkSize（codec steps per chunk） |
| `PI_VOICE_STREAM_MAX_CHUNK_SIZE` | `64` | 流式 chunkSize 服务端上限 |

不要把 token、模型访问凭据或用户文本写入日志。

## 7. 启动

当前骨架读取进程环境变量，不自动读取 `.env.local`：

```bash
export PI_VOICE_TOKEN='<local-token>'
export PI_VOICE_DEVICE='cuda:0'
export PI_VOICE_ATTENTION='flash_attention_2'
pi-voice-service
```

健康检查：

```bash
curl -H "Authorization: Bearer $PI_VOICE_TOKEN" http://127.0.0.1:18876/health
```

首次合成会下载并加载模型，耗时明显长于后续请求：

```bash
curl -X POST \
  -H "Authorization: Bearer $PI_VOICE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"text":"其实我真的有发现，我是一个特别善于观察别人情绪的人。","language":"Chinese","speaker":"Vivian","instruct":"用特别愤怒的语气说"}' \
  http://127.0.0.1:18876/v1/synthesize
```

流式端点（第一个 PCM chunk 就绪后立即开始传输，不需要等到完整生成结束）：

```bash
curl -N -X POST \
  -H "Authorization: Bearer $PI_VOICE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"text":"其实我真的有发现，我是一个特别善于观察别人情绪的人。","language":"Chinese","speaker":"Vivian","chunkSize":8,"encoding":"pcm_f32le"}' \
  -o /tmp/stream.pcm \
  -D - http://127.0.0.1:18876/v1/synthesize/stream
```

响应头：`Content-Type: application/vnd.pi.pcm`、`Cache-Control: no-store`、
`X-Content-Type-Options: nosniff`、`X-Pi-Audio-Encoding: pcm_f32le`、
`X-Pi-Audio-Sample-Rate`、`X-Pi-Audio-Channels: 1`。响应体是连续 mono
little-endian float32 PCM，可用 Python 还原为音频：

```bash
uv run --package pi-voice-service python - <<'PY'
import numpy as np
import soundfile as sf
pcm = np.fromfile("/tmp/stream.pcm", dtype="<f4")
sf.write("/tmp/stream.wav", pcm, 24000)  # sample rate 以响应头 X-Pi-Audio-Sample-Rate 为准
PY
```

请求约束：

- `text`、`language`、`speaker` 非空；`chunkSize` 为正整数且不超过
  `PI_VOICE_STREAM_MAX_CHUNK_SIZE`；第一阶段 `encoding` 只接受 `pcm_f32le`。
- 额外字段会被 422 拒绝。
- 首包前错误返回 `{"error": {"code": ..., "message": ...}}`；首包后的失败只关闭流，
  不把内部细节写进响应。

手动回归工具：`faster_qwen3_tts_stream_smoke.py` 直接驱动正式 provider 测首包延迟和
RTF；`faster_qwen3_tts_stream_player.py` 在浏览器里边收边播（二者都不依赖 GPU 之外
的 Python 环境，但需要本机模型与 CUDA）。

### 故障排查

| 现象 | 处理 |
| --- | --- |
| `401 Unauthorized` | `PI_VOICE_TOKEN` 与请求 `Authorization: Bearer` 不一致；服务端 token 为空时直接拒绝 |
| `422` | 请求体多出额外字段、`chunkSize` 超上限（`PI_VOICE_STREAM_MAX_CHUNK_SIZE`）、或文本为空/超长 |
| `502` 首包前失败 | 模型加载或推理失败；查看服务日志确认模型路径和 CUDA 状态 |
| 模型加载报 FlashAttention 相关错误 | 硬件/驱动不支持时设 `PI_VOICE_ATTENTION=sdpa` |
| `torch`/CUDA wheel 与驱动不兼容 | 确认 uv.lock 锁定的 PyTorch wheel 与本机 CUDA 版本匹配 |
| 返回空流（`empty_output`） | 本地模型目录需指向含 `config.json` 的 `snapshots/master`，不能是 Modelscope 缓存根目录 |
| 首包明显偏慢 | 冷启动需加载模型，属预期；warm 后首包应明显缩短 |

服务端日志只记录安全错误码和耗时，不记录 token、朗读文本或模型缓存绝对路径。

## 8. 开发规则

- Provider 必须实现 `TTSProvider`，业务层不能直接依赖 Qwen 类型。
- 一个进程只持有一个模型实例。
- GPU 默认单并发；提高并发前必须做显存压测。
- 文件名由服务端随机生成，用户输入不能参与路径拼接。
- artifact 必须写入配置目录，不能写入仓库。
- API 错误不能包含堆栈、CUDA 环境详情或本地敏感路径。
- 单元测试使用 FakeProvider，不下载模型、不调用 GPU。
- 真实模型测试单独标记为手动 smoke test。

直接验证本地 CustomVoice 模型：

```bash
cd /path/to/skdy-agent
uv run --package pi-voice-service \
  python services/voice/examples/custom_voice_smoke.py \
  --model /home/hello/.cache/modelscope/models/Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice/snapshots/master \
  --output /tmp/qwen3-tts-smoke.wav
```

ModelScope 缓存根目录不能直接传给 `from_pretrained`；这里使用包含 `config.json` 和模型权重的 `snapshots/master`。

运行单元测试：

```bash
cd /path/to/skdy-agent
uv run --package pi-voice-service pytest
```

## 9. 下一阶段

1. V2：在 `runtimes/pi/packages/server/src/voice` 增加内部 client、SpeechManager 和
   browser-facing 音频路由，把本服务的 `/v1/synthesize/stream` 升级为受保护流式链路。
2. V2：在 `runtimes/pi/packages/protocol` 定义 SpeechJob 状态，不传递 PCM 或服务端路径。
3. V3：在 `runtimes/pi/packages/web/src/features/voice` 增加朗读、播放、停止和设置组件。
4. 麦克风输入属于 ASR，另行设计和实施。

## 10. 上游依据

- Qwen3-TTS 官方仓库：https://github.com/QwenLM/Qwen3-TTS
- PyPI `qwen-tts`：https://pypi.org/project/qwen-tts/
- CustomVoice 模型：`Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`
