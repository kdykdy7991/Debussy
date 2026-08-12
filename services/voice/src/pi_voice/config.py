"""Environment-backed service configuration."""

from dataclasses import dataclass
from os import environ
from pathlib import Path


@dataclass(frozen=True)
class VoiceConfig:
    host: str
    port: int
    token: str
    model: str
    device: str
    dtype: str
    attention: str
    max_concurrency: int
    max_text_length: int
    artifact_dir: Path
    stream_chunk_size: int
    stream_max_chunk_size: int

    @classmethod
    def from_environment(cls) -> "VoiceConfig":
        token = environ.get("PI_VOICE_TOKEN", "").strip()
        if not token:
            raise ValueError("PI_VOICE_TOKEN must be configured")
        host = environ.get("PI_VOICE_HOST", "127.0.0.1")
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise ValueError("PI_VOICE_HOST must be a loopback address; the voice service only binds locally")
        return cls(
            host=host,
            port=int(environ.get("PI_VOICE_PORT", "18876")),
            token=token,
            model=environ.get("PI_VOICE_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"),
            device=environ.get("PI_VOICE_DEVICE", "cuda:0"),
            dtype=environ.get("PI_VOICE_DTYPE", "bfloat16"),
            attention=environ.get("PI_VOICE_ATTENTION", "flash_attention_2"),
            max_concurrency=max(1, int(environ.get("PI_VOICE_MAX_CONCURRENCY", "1"))),
            max_text_length=max(1, int(environ.get("PI_VOICE_MAX_TEXT_LENGTH", "4000"))),
            artifact_dir=Path(environ.get("PI_VOICE_ARTIFACT_DIR", "~/.pi/agent/audio/artifacts")).expanduser(),
            stream_chunk_size=max(1, int(environ.get("PI_VOICE_STREAM_CHUNK_SIZE", "8"))),
            stream_max_chunk_size=max(1, int(environ.get("PI_VOICE_STREAM_MAX_CHUNK_SIZE", "64"))),
        )

