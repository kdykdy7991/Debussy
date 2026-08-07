"""Measure local Fun-CosyVoice 3 streaming inference."""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path


DEFAULT_TEXT = "这是一段用于验证流式语音首包延迟的测试文本。"
DEFAULT_MODEL = "pretrained_models/Fun-CosyVoice3-0.5B"
DEFAULT_PROMPT_TEXT = "希望你以后能够做的比我还好呦。"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cosyvoice-root", type=Path, default=Path(os.environ["COSYVOICE_ROOT"]) if os.environ.get("COSYVOICE_ROOT") else None)
    parser.add_argument("--model", type=Path, default=Path(os.environ.get("PI_COSYVOICE_MODEL", DEFAULT_MODEL)))
    parser.add_argument("--prompt-audio", type=Path, required=True, help="Reference WAV for zero-shot voice cloning")
    parser.add_argument("--prompt-text", default=DEFAULT_PROMPT_TEXT)
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument("--output", type=Path, default=Path("/tmp/cosyvoice3-stream-smoke.wav"))
    return parser.parse_args()


def resolve_path(path: Path, root: Path) -> Path:
    return path if path.is_absolute() else root / path


def main() -> None:
    args = parse_args()
    if args.cosyvoice_root is None:
        raise SystemExit("Set COSYVOICE_ROOT or pass --cosyvoice-root <CosyVoice checkout>")
    root = args.cosyvoice_root.expanduser().resolve()
    if not (root / "cosyvoice/cli/cosyvoice.py").is_file():
        raise SystemExit(f"CosyVoice checkout is invalid: {root}")
    model_dir = resolve_path(args.model.expanduser(), root).resolve()
    if not model_dir.is_dir():
        raise SystemExit(f"Model directory does not exist: {model_dir}")
    prompt_audio = args.prompt_audio.expanduser().resolve()
    if not prompt_audio.is_file():
        raise SystemExit(f"Prompt audio does not exist: {prompt_audio}")

    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / "third_party/Matcha-TTS"))
    try:
        import soundfile as sf
        from cosyvoice.cli.cosyvoice import AutoModel
    except ImportError as error:
        raise SystemExit("CosyVoice dependencies are missing in the unified uv environment") from error

    output_path = args.output.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Loading model: {model_dir}")
    load_started = time.perf_counter()
    cosyvoice = AutoModel(model_dir=str(model_dir), load_jit=False, load_trt=False, fp16=True)
    load_elapsed = time.perf_counter() - load_started
    print("Starting stream...")
    started = time.perf_counter()
    first_chunk_at: float | None = None
    chunks = 0
    sample_rate = int(cosyvoice.sample_rate)
    audio_samples = 0
    with sf.SoundFile(output_path, mode="w", samplerate=sample_rate, channels=1, format="WAV") as wav_file:
        stream = cosyvoice.inference_zero_shot(args.text, args.prompt_text, str(prompt_audio), stream=True)
        for result in stream:
            if first_chunk_at is None:
                first_chunk_at = time.perf_counter()
                print(f"First audio chunk: {(first_chunk_at - started) * 1000:.1f} ms")
            audio = result["tts_speech"].detach().float().cpu().numpy().reshape(-1)
            wav_file.write(audio)
            audio_samples += len(audio)
            chunks += 1
    elapsed = time.perf_counter() - started
    duration = audio_samples / sample_rate
    print(f"Wrote {output_path}")
    print(f"Chunks: {chunks}")
    print(f"Audio duration: {duration:.2f} s")
    print(f"Inference time: {elapsed:.2f} s")
    print(f"Real-time factor: {elapsed / duration:.3f}" if duration else "Real-time factor: n/a")
    print(f"Model load time: {load_elapsed:.2f} s")


if __name__ == "__main__":
    main()
