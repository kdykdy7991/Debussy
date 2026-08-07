"""Stream a local Qwen3-TTS model with faster-qwen3-tts."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import soundfile as sf
from faster_qwen3_tts import FasterQwen3TTS


DEFAULT_MODEL = Path.home() / ".cache/modelscope/models/Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice/snapshots/master"
DEFAULT_TEXT = "这是一段用于验证流式语音首包延迟的测试文本。"
DEFAULT_REF_TEXT = "这是参考音频对应的文字内容，请替换成真实录音的逐字稿。"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL, help="Local model directory or model ID")
    parser.add_argument("--mode", choices=("auto", "custom", "clone"), default="auto")
    parser.add_argument("--speaker", default="Vivian", help="CustomVoice speaker")
    parser.add_argument("--instruct", default=None, help="Optional CustomVoice instruction")
    parser.add_argument("--ref-audio", type=Path, help="Reference WAV for clone mode")
    parser.add_argument("--ref-text", default=DEFAULT_REF_TEXT)
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--chunk-size", type=int, default=8, help="Codec steps per audio chunk")
    parser.add_argument("--output", type=Path, default=Path("/tmp/faster-qwen3-tts-stream.wav"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    model_path = args.model.expanduser()
    mode = "custom" if args.mode == "auto" and "CustomVoice" in str(model_path) else args.mode
    if mode == "clone":
        if args.ref_audio is None:
            raise SystemExit("Clone mode requires --ref-audio")
        ref_audio = args.ref_audio.expanduser().resolve()
        if not ref_audio.is_file():
            raise SystemExit(f"Reference audio does not exist: {ref_audio}")
    if args.chunk_size < 1:
        raise SystemExit("--chunk-size must be positive")

    output_path = args.output.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Loading model: {model_path}")
    load_started = time.perf_counter()
    model = FasterQwen3TTS.from_pretrained(str(model_path))
    load_elapsed = time.perf_counter() - load_started
    started = time.perf_counter()
    if mode == "custom":
        stream = model.generate_custom_voice_streaming(
            text=args.text, speaker=args.speaker, language=args.language,
            instruct=args.instruct, chunk_size=args.chunk_size,
        )
    else:
        stream = model.generate_voice_clone_streaming(
            text=args.text, language=args.language, ref_audio=str(ref_audio),
            ref_text=args.ref_text, chunk_size=args.chunk_size,
        )
    stream_iterator = iter(stream)
    try:
        first_audio_chunk, sample_rate, first_timing = next(stream_iterator)
    except StopIteration as error:
        raise SystemExit("The model returned no audio chunks") from error
    print(f"First audio chunk: {(time.perf_counter() - started) * 1000:.1f} ms")
    chunks = 1
    audio_samples = len(first_audio_chunk)
    with sf.SoundFile(output_path, mode="w", samplerate=sample_rate, channels=1, format="WAV") as wav_file:
        wav_file.write(first_audio_chunk)
        if first_timing:
            print(f"chunk=1 timing={first_timing}")
        for audio_chunk, _, timing in stream_iterator:
            wav_file.write(audio_chunk)
            audio_samples += len(audio_chunk)
            chunks += 1
            if timing:
                print(f"chunk={chunks} timing={timing}")
    elapsed = time.perf_counter() - started
    duration = audio_samples / sample_rate
    print(f"Wrote {output_path}")
    print(f"Mode: {mode}; chunks: {chunks}; audio duration: {duration:.2f} s")
    print(f"Inference time: {elapsed:.2f} s; real-time factor: {elapsed / duration:.3f}" if duration else "Real-time factor: n/a")
    print(f"Model load time: {load_elapsed:.2f} s")


if __name__ == "__main__":
    main()
