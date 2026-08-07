# CosyVoice3 流式验证

CosyVoice3 与 Qwen 共用 `skdy-agent/.venv`。CosyVoice 源码 checkout 和模型目录放在仓库外，不纳入 Git；不会创建第二个环境，也不会覆盖现有 Qwen 的 PyTorch。

## 安装依赖

```bash
cd /home/hello/workspace/skdy-agent
uv pip install --python .venv/bin/python -r services/voice/cosyvoice-requirements.txt
export COSYVOICE_ROOT=/path/to/CosyVoice
```

依赖清单刻意没有锁定 `torch`、`torchaudio` 和 `numpy`。CosyVoice 官方 requirements 使用 Python 3.10/PyTorch 2.3，而当前统一环境是 Python 3.12/PyTorch 2.13；先验证兼容性，不要直接降级现有环境。

## 运行流式 smoke test

模型和参考音频由使用者准备。CosyVoice3 零样本流式推理需要一段短 WAV 参考音频及其文字内容：

```bash
cd /home/hello/workspace/skdy-agent
uv run --project services/voice \
  python services/voice/examples/cosyvoice3_stream_smoke.py \
  --cosyvoice-root "$COSYVOICE_ROOT" \
  --model pretrained_models/Fun-CosyVoice3-0.5B \
  --prompt-audio "$COSYVOICE_ROOT/asset/zero_shot_prompt.wav" \
  --output /tmp/cosyvoice3-stream-smoke.wav
```

脚本调用官方 `inference_zero_shot(..., stream=True)`，输出首个音频分片延迟、分片数、音频时长、推理耗时和实时率（RTF），结果写入 `/tmp`，不会调用 Pi Server。
