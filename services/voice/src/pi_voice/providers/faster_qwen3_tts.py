"""Faster-Qwen3-TTS streaming provider (CUDA-graph accelerated).

Wraps ``faster_qwen3_tts`` behind the :class:`StreamingTTSProvider` boundary so
the FastAPI route and ``VoiceService`` never depend on the library directly.
The model stays a process-level singleton with the same lazy-load behavior as
the artifact provider.
"""

from threading import Lock
from typing import Iterator

import numpy as np
from faster_qwen3_tts import FasterQwen3TTS

from pi_voice.config import VoiceConfig
from pi_voice.providers.base import AudioChunk, SynthesisRequest


class FasterQwen3TTSProvider:
    """Owns one FasterQwen3TTS model instance and yields mono PCM chunks."""

    def __init__(self, config: VoiceConfig) -> None:
        self._config = config
        self._model: FasterQwen3TTS | None = None
        self._load_lock = Lock()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def stream(self, request: SynthesisRequest, *, chunk_size: int) -> Iterator[AudioChunk]:
        model = self._get_model()
        generator = model.generate_custom_voice_streaming(
            text=request.text,
            language=request.language,
            speaker=request.speaker,
            instruct=request.instruct,
            chunk_size=chunk_size,
        )
        try:
            for samples, sample_rate, _timing in generator:
                yield {"samples": np.asarray(samples), "sample_rate": int(sample_rate)}
        finally:
            # The outer iterator may be closed early by cancellation. Closing the
            # inner generator stops the CUDA loop at the next iteration boundary;
            # closing an already-exhausted generator is a no-op.
            generator.close()

    def _get_model(self) -> FasterQwen3TTS:
        if self._model is not None:
            return self._model
        with self._load_lock:
            if self._model is None:
                self._model = FasterQwen3TTS.from_pretrained(
                    self._config.model,
                    device=self._config.device,
                    dtype=self._config.dtype,
                    attn_implementation=self._config.attention,
                )
        return self._model
