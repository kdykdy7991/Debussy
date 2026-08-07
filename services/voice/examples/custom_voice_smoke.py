"""Generate one WAV file directly with a local Qwen3-TTS CustomVoice model."""

import argparse
import os
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


DTYPES = {
    "bfloat16": torch.bfloat16,
    "float16": torch.float16,
    "float32": torch.float32,
}


DEFAULT_MODEL_CACHE = Path.home() / ".cache/modelscope/models/Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice/snapshots/master"


def default_model_path() -> Path | None:
    configured = os.environ.get("PI_VOICE_MODEL")
    if configured:
        return Path(configured)
    if (DEFAULT_MODEL_CACHE / "config.json").is_file():
        return DEFAULT_MODEL_CACHE
    return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        type=Path,
        default=default_model_path(),
        help="Local model snapshot directory (or set PI_VOICE_MODEL)",
    )
    parser.add_argument(
        "--text",
        default="其实我真的有发现，我是一个特别善于观察别人情绪的人。",
        help="Text to synthesize",
    )
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--speaker", default="Vivian")
    parser.add_argument("--instruct", default="用特别愤怒的语气说")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--dtype", choices=DTYPES, default="bfloat16")
    parser.add_argument("--attention", default="sdpa", help="Attention backend; use flash_attention_2 only when installed")
    parser.add_argument("--output", type=Path, default=Path("output.wav"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.model is None:
        raise SystemExit(
            "No local model found. Pass --model <snapshot> or set PI_VOICE_MODEL. "
            "Expected a directory containing config.json, usually .../snapshots/master."
        )
    model_path = args.model.expanduser().resolve()
    if not (model_path / "config.json").is_file():
        raise SystemExit(f"Model snapshot is invalid or incomplete: {model_path}")

    output_path = args.output.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Loading model: {model_path}")
    model = Qwen3TTSModel.from_pretrained(
        str(model_path),
        device_map=args.device,
        dtype=DTYPES[args.dtype],
        attn_implementation=args.attention,
    )
    print(f"Generating voice: language={args.language}, speaker={args.speaker}")
    wavs, sample_rate = model.generate_custom_voice(
        text=args.text,
        language=args.language,
        speaker=args.speaker,
        instruct=args.instruct,
    )
    sf.write(output_path, wavs[0], sample_rate)
    print(f"Wrote {output_path} ({sample_rate} Hz)")


if __name__ == "__main__":
    main()
