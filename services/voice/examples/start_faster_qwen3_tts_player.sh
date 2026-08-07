#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
model_dir="${QWEN3_TTS_MODEL:-${HOME}/.cache/modelscope/models/Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice/snapshots/master}"

if [[ ! -f "${model_dir}/config.json" ]]; then
  echo "模型配置不存在：${model_dir}/config.json" >&2
  echo "可通过 QWEN3_TTS_MODEL 指定包含 config.json 的模型目录。" >&2
  exit 1
fi

cd "${repo_root}"
exec uv run --package pi-voice-service python services/voice/examples/faster_qwen3_tts_stream_player.py --model "${model_dir}" "$@"
