"""Stream a local Qwen3-TTS model through the formal FasterQwen3TTSProvider.

Provider-level manual regression tool: it drives the same provider boundary as
``POST /v1/synthesize/stream`` (no HTTP service, no fake), so it is the fastest
way to verify first-chunk latency, sample rate, audio duration and RTF against a
real model on the local GPU. Requires CUDA and a local model directory.

The first ``next()`` triggers lazy model load, so the reported "first audio
chunk" time is a cold number that includes loading; run the script a second time
against the same process only if warm numbers are needed.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import soundfile as sf

from pi_voice.config import VoiceConfig
from pi_voice.providers.base import SynthesisRequest
from pi_voice.providers.faster_qwen3_tts import FasterQwen3TTSProvider


DEFAULT_MODEL = Path.home() / ".cache/modelscope/models/Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice/snapshots/master"
DEFAULT_TEXT = "这是一段用于验证流式语音首包延迟的测试文本。"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL, help="Local model directory or model ID")
    parser.add_argument("--speaker", default="Vivian", help="CustomVoice speaker")
    parser.add_argument("--instruct", default=None, help="Optional CustomVoice instruction")
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--chunk-size", type=int, default=8, help="Codec steps per audio chunk")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float16", "float32"])
    parser.add_argument("--attention", default="sdpa", choices=["sdpa", "flash_attention_2"])
    parser.add_argument("--output", type=Path, default=Path("/tmp/faster-qwen3-tts-stream.wav"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.chunk_size < 1:
        raise SystemExit("--chunk-size must be positive")
    config = VoiceConfig(
        host="127.0.0.1",
        port=18876,
        token="manual-smoke",
        model=str(args.model.expanduser()),
        device=args.device,
        dtype=args.dtype,
        attention=args.attention,
        max_concurrency=1,
        max_text_length=4000,
        artifact_dir=Path("/tmp/pi-voice-artifacts"),
        stream_chunk_size=args.chunk_size,
        stream_max_chunk_size=64,
    )
    provider = FasterQwen3TTSProvider(config)

    output_path = args.output.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Loading model: {config.model}")
    iterator = iter(
        provider.stream(
            SynthesisRequest(
                text=args.text,
                language=args.language,
                speaker=args.speaker,
                instruct=args.instruct,
            ),
            chunk_size=args.chunk_size,
        )
    )
    started = time.perf_counter()
    try:
        first = next(iterator)
    except StopIteration as error:
        raise SystemExit("The model returned no audio chunks") from error
    first_chunk_ms = (time.perf_counter() - started) * 1000
    first_samples = first["samples"]
    sample_rate = first["sample_rate"]
    print(f"First audio chunk (cold, includes model load): {first_chunk_ms:.1f} ms")
    print(f"Sample rate: {sample_rate} Hz; encoding: pcm_f32le; mono")

    chunks = 1
    audio_samples = len(first_samples)
    with sf.SoundFile(output_path, mode="w", samplerate=sample_rate, channels=1, format="WAV") as wav_file:
        wav_file.write(first_samples)
        for chunk in iterator:
            wav_file.write(chunk["samples"])
            audio_samples += len(chunk["samples"])
            chunks += 1
    elapsed = time.perf_counter() - started
    duration = audio_samples / sample_rate
    print(f"Wrote {output_path}")
    print(f"Chunks: {chunks}; audio duration: {duration:.2f} s")
    if duration:
        print(f"Total inference time: {elapsed:.2f} s; real-time factor: {elapsed / duration:.3f}")
    else:
        print("Real-time factor: n/a")


if __name__ == "__main__":
    main()
