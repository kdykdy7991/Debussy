# V1 Handoff: Voice Service streaming

状态：Review  
日期：2026-08-12  
执行者：V1  
下游：V2 Protocol + Server proxy  
总规范：[`../PI-STREAMING-SPEECH-SPEC.md`](../PI-STREAMING-SPEECH-SPEC.md)  
任务单：[`../tasks/V1-voice-service-streaming.md`](../tasks/V1-voice-service-streaming.md)

## 1. 交付摘要

- 新增正式流式端点 `POST /v1/synthesize/stream`，首个模型 chunk 可用后立即开始
  传输连续 `pcm_f32le`。
- 流式能力封装在 provider boundary：`FasterQwen3TTSProvider` 实现
  `StreamingTTSProvider`，`VoiceService.stream()` 负责校验/并发/取消/安全错误。
- 非流式 `/v1/synthesize` 与既有测试零回归。
- smoke 脚本改为驱动正式 provider：`faster_qwen3_tts_stream_smoke.py` 报告首包
  延迟/时长/RTF；`faster_qwen3_tts_stream_player.py` 浏览器边收边播（工具内部
  header，非正式契约）。
- 真实 GPU 端到端验证通过（见 §7）。

## 2. 冻结的 wire contract（V1 冻结，V2 按此对接）

### 2.1 请求

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

约束：

- `text`、`language`、`speaker` 非空；额外字段 422。
- `chunkSize` 为正整数，服务端上限 `PI_VOICE_STREAM_MAX_CHUNK_SIZE`（默认 64）；
  缺省取 `PI_VOICE_STREAM_CHUNK_SIZE`（默认 8）。
- `encoding` 第一阶段只接受 `pcm_f32le`。
- 文本长度与现有 `PI_VOICE_MAX_TEXT_LENGTH` 共用（默认 4000）。

### 2.2 成功响应头

| Header | 值 |
| --- | --- |
| `Content-Type` | `application/vnd.pi.pcm` |
| `Cache-Control` | `no-store` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Pi-Audio-Encoding` | `pcm_f32le` |
| `X-Pi-Audio-Sample-Rate` | 正整数（真实 Qwen3-TTS 为 `24000`） |
| `X-Pi-Audio-Channels` | `1` |
| `Transfer-Encoding` | chunked（无 `Content-Length`） |

响应体是连续、mono、little-endian IEEE-754 float32 PCM，值域目标 `[-1, 1]`。
HTTP chunk 边界无语义；消费方必须按 4 字节对齐自行重组，尾部不足 4 字节与下一
网络 chunk 拼接。真实模型峰值实测约 0.58–0.82。

### 2.3 错误响应（首包前）

| HTTP | code | 场景 |
| --- | --- | --- |
| 401 | — | token 缺失/错误（FastAPI 默认 `{"detail": "Invalid service token"}`，未用 `{"error": {...}}` 格式） |
| 422 | `invalid_request` | 额外字段、文本空/超长、`chunkSize` 越界、`chunk_size < 1` |
| 502 | `generation_failed` | provider 首包前抛异常 |
| 502 | `empty_output` | generator 无输出或首个 chunk 为空 |
| 502 | `invalid_audio` | 非 mono / 非 float / 非有限值 / 采样率不合法 |

首包前错误格式：`{"error": {"code": "<code>", "message": "<安全信息>"}}`。
首包后失败只关闭流并写内部日志，绝不把 stack/CUDA 详情/模型路径/用户文本写入响应。

## 3. 架构与生命周期

### 3.1 模块

```text
services/voice/src/pi_voice/
├── main.py                 # FastAPI route：鉴权、chunkSize 上限、StreamingResponse
├── service.py              # VoiceService.stream()：校验、semaphore、取消、AudioStream
├── config.py               # PI_VOICE_STREAM_* 、loopback 强制
├── schemas.py              # SynthesisStreamBody（extra=forbid, chunkSize alias）
└── providers/
    ├── base.py             # StreamingTTSProvider Protocol + AudioChunk
    └── faster_qwen3_tts.py # FasterQwen3TTSProvider：进程级单例、lazy load、yield mono chunk
```

### 3.2 Provider → Service → HTTP 生命周期

```text
HTTP route
  │ body → SynthesisStreamBody
  ▼
VoiceService.stream()                      _StreamProducer (worker thread)
  ├─ text 校验 / chunk_size 校验            ├─ 消费 provider.stream() 同步生成器
  ├─ await semaphore.acquire()  ←共享──────┤   （与 /v1/synthesize 同一信号量）
  ├─ producer.start()  ──────────────────> │
  ├─ receive() 取首 chunk                  │  每 chunk: put(("chunk", {...}))
  ├─ _validate_chunk(dtype/shape/finite/rate)
  ├─ 返回 AudioStream(sample_rate, chunks)
  ▼
chunks() async generator
  ├─ yield first.tobytes()   （<f4 little-endian mono）
  ├─ 循环: receive() → 校验 → yield tobytes()
  └─ finally: producer.stop()
              with anyio.CancelScope(shield=True): await producer.wait_closed()
              semaphore.release()
```

取消/断流清理路径（双保险，见 §4）：

- HTTP 断流时 uvicorn 通过 anyio cancel scope 取消 app task，CancelledError 可能
  投递到 **main.py 生成器 `yield`** 或 **chunks() 内部 `producer.receive()`**。
- main.py 生成器 `finally`：`with anyio.CancelScope(shield=True): await chunks.aclose()`。
- service.wait_closed 内部同样 shield，保证两处清理 await 在取消态下照常完成。

### 3.3 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_VOICE_STREAM_CHUNK_SIZE` | `8` | 请求缺省 chunkSize（codec steps per chunk） |
| `PI_VOICE_STREAM_MAX_CHUNK_SIZE` | `64` | 服务端上限 |
| `PI_VOICE_HOST` | `127.0.0.1` | **强制 loopback**：`0.0.0.0`/`:8080` 等非 loopback 直接拒绝启动 |

## 4. 取消语义与底层库限制（精确粒度）

- **合作式取消**：正在执行的 CUDA step 无法被另一线程打断；`producer.stop()`
  只在下一次 chunk 边界生效。生成器在 `finally` 中 `close()`，已被耗尽时 close 为
  no-op。
- 底层库 `faster_qwen3_tts.FasterQwen3TTS.generate_custom_voice_streaming` 是同步
  Python 生成器；`.close()` 只能在下一次迭代边界停止，无法抢占执行中的 CUDA 内核。
  文档和指标需如实记录这一点。
- **断流信号**：实测 Starlette 1.4.1 的 `request.is_disconnected()` 永远返回
  `False`（内部 CancelScope 立即被 cancel，`_receive()` 从未真正执行），因此
  **不依赖**该 API；断流由 uvicorn 的 anyio cancel scope 取消 app task 驱动。
- **清理保证**：`wait_closed` 与 `chunks.aclose()` 均在 `CancelScope(shield=True)`
  内执行，确保即使在任务取消中 `producer.stop()` + `wait_closed` + 信号量释放
  完整运行。槽位只在 producer 线程实际关闭后释放（`wait_closed` 上限 30s）。
- 取消结果：用户主动/HTTP 断流 → generator 停止下一次迭代并关闭 → GPU 尽快释放；
  上游/下游异常 → 安全错误码，不泄漏内部详情。

## 5. 自动化测试结果

`uv run --package pi-voice-service pytest services/voice/tests`：

```text
38 passed in 5.54s
```

覆盖（`tests/test_streaming.py` + `tests/test_service.py` + `tests/test_config.py`）：

- 多 chunk 正常输出与 headers；`<f4` 还原。
- 真实 HTTP（`_live_server` uvicorn）验证首 chunk 在完整生成结束前到达。
- 空 generator / 空 chunk / NaN/Infinity / 非 mono / 非 float / 采样率变化。
- 请求 schema、文本限制、chunkSize 边界、鉴权（401/422/502 不泄漏）。
- 流式与非流式共享 `concurrency=1` 信号量。
- provider 首包前/中途异常。
- 消费者 cancel/disconnect 关闭 generator、释放信号量。
- **断流回归测试**：`test_http_stream_client_disconnect_closes_provider_and_releases_slot`
  模拟浏览器中途断开，断言第二个请求不挂起、provider 已关闭（此测试在修复前失败，
  见 §8 问题）。
- `/v1/synthesize` 与既有测试零回归。

## 6. 真实 GPU smoke 数据

环境：NVIDIA RTX PRO 5000 Blackwell；模型 `Qwen3-TTS-12Hz-0.6B-CustomVoice`
（本地 Modelscope `snapshots/master`）；`PI_VOICE_ATTENTION=sdpa`
（flash_attention_2 未安装，库自动回退）。

命令（冷启动，含模型加载 + CUDA graph 捕获）：

```bash
uv run --package pi-voice-service python services/voice/examples/faster_qwen3_tts_stream_smoke.py
```

| 指标 | 实测 |
| --- | --- |
| 首 PCM chunk（冷，含加载） | 12.6 s（独立 smoke）/ 8.6 s（HTTP 服务进程） |
| 采样率 / 声道 / 编码 | 24000 Hz / mono / pcm_f32le |
| 音频时长 | 5.20 s（9 chunks） |
| RTF（冷，含加载，偏大） | 2.698 |
| WAV 校验 | mono、24000 Hz、peak 0.578、全有限 |
| warm 全量生成 | ~5.9 s 产出 ~22 s 音频（RTF ≈ 0.27） |

端到端断流（正式服务）：

1. 请求 A 读取首 chunk 后主动断开。
2. 请求 B 随后正常完成（修复前会无限挂起）→ 槽位已释放、producer 已关闭。
3. 服务日志无 AudioStreamError，两端均 `200 OK`。

warm 首包预算（Spec §14 目标 < 1.5 s）需在常驻进程中对同一模型做第二次请求测量；
本次单进程冷启动不适用。

## 7. V2 对接要点

- **base URL**：`http://127.0.0.1:18876`
- **token**：`PI_VOICE_TOKEN`（server-to-service secret；浏览器永远不该拿到）
- **建议 timeout**：首字节 60 s（冷加载可放宽）；chunk 间空闲 30 s；单 Job 最长 5 分钟。
- **转发头**：`Content-Type: application/vnd.pi.pcm`、`X-Pi-Audio-Encoding`、
  `X-Pi-Audio-Sample-Rate`、`X-Pi-Audio-Channels`，服务端按此构造 browser-facing
  响应头。
- **fake fixture**：`tests/test_streaming.py` 的 `FakeStreamingProvider`
  （`stream(request, *, chunk_size)` yield `{"samples": np.ndarray, "sample_rate": int}`），
  V2 的 Python 侧 mock 可直接复用该形状；Node 侧建议照抄该语义写 TS fake。
- 服务端校验：文本长度上限 4000、`chunkSize` 上限 64、首包前错误
  `{"error": {"code", "message"}}`（402/502 已按安全码隔离）。
- `/health` 返回 `model_loaded`，不触发模型加载。

## 8. 与总规范 / 任务单的偏离（ADR 记录）

1. **Provider 接口拆分**（Spec §9.2 原设计为单一 `TTSProvider` 同时含
   `synthesize` + `stream`）：实现为 `TTSProvider`（artifact）与
   `StreamingTTSProvider`（stream）两个 Protocol。理由：CUDA-graph faster 引擎与
   传统 artifact provider 是**两个独立模型生命周期**；任务单 §6.1 明确要求
   「清楚区分 artifact provider 与 faster streaming provider，不用运行时字符串
   判断偷偷切 provider」。已写入 `base.py` docstring。
2. **模型实例数**（Spec §9.3「一个进程只加载一个模型实例」）：实现为每个 provider
   各持一个进程级单例。只使用一个端点时进程只加载对应模型；同时使用两个端点会
   各加载一个模型。README 已如实说明。留给 V2 决定是否收敛。
3. **断流检测**（Spec §9.3「检测 request disconnect；停止迭代并 close generator」）：
   未使用 `request.is_disconnected()`（Starlette 1.4.1 中该 API 实测恒为 False），
   改为依赖 uvicorn 的 anyio cancel-scope 任务取消 + 双 shield 清理。取消信号仍能
   传播到 GPU generator，语义与 spec 的合作式取消一致。
4. **401 错误体**：由 FastAPI `Depends(authorize)` 产生 `{"detail": "Invalid service
   token"}`，与路由层 `{"error": {...}}` 格式不一致。V2 的 browser-facing 错误映射
   需自行归一（Spec §7.2 已规定 `{"error": {...}}`）。
5. **smoke player**：保留为 provider-level 手动工具，使用工具内部 header
   （`X-Audio-Sample-Rate`、`X-First-Chunk-Ms`），任务单 §7.6 允许；正式端点使用
   `X-Pi-Audio-*` 契约。
6. **HTTP chunk 边界**：模型 chunk 与网络 chunk 一一对应（每个 chunk 一次 yield）。
   Spec §4.1 允许任意分块；客户端必须自行按 4 字节重组，不能假设边界对齐。

## 9. 已知风险与遗留

- 断流清理的等待上限是 `wait_closed` 30 s；若 producer 卡在单次 CUDA step 超长，
  槽位释放最多延迟 30 s（有告警日志）。
- `_StreamProducer` 使用无界 `Queue`：若下游慢、上游持续产块，队列会积压
  （HTTP 层有 backpressure 时不会无限涨，但 Python 侧未设队列上限）。Spec 把
  背压划给 V2 Server（§8.4），V1 未做队列上限。
- 20 次连续运行的显存/线程泄漏验收（Spec §13.5 #5）需手动 e2e，未纳入 CI。
- `flash-attn` 未安装时用 `PI_VOICE_ATTENTION=sdpa` 回退，性能稍低。

## 10. 验收命令（全部通过）

```bash
uv sync --package pi-voice-service --extra dev
uv run --package pi-voice-service pytest services/voice/tests   # 38 passed
uv run --package pi-voice-service python -m compileall -q services/voice/src services/voice/examples
git diff --check
```

GPU smoke 为手动（不下载模型到 CI）。命令见 §6。
