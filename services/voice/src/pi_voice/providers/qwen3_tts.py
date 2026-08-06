"""Qwen3-TTS CustomVoice provider."""

from pathlib import Path
from threading import Lock
from uuid import uuid4

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

from pi_voice.config import VoiceConfig
from pi_voice.providers.base import AudioArtifact, SynthesisRequest


DTYPES = {
    "bfloat16": torch.bfloat16,
    "float16": torch.float16,
    "float32": torch.float32,
}


class Qwen3TTSProvider:
    """Owns one model instance and serializes access to it."""

    def __init__(self, config: VoiceConfig) -> None:
        self._config = config
        self._model: Qwen3TTSModel | None = None
        self._load_lock = Lock()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def synthesize(self, request: SynthesisRequest) -> AudioArtifact:
        model = self._get_model()
        wavs, sample_rate = model.generate_custom_voice(
            text=request.text,
            language=request.language,
            speaker=request.speaker,
            instruct=request.instruct,
        )
        artifact_id = uuid4().hex
        path = self._config.artifact_dir / f"{artifact_id}.wav"
        self._config.artifact_dir.mkdir(parents=True, exist_ok=True)
        sf.write(path, wavs[0], sample_rate)
        return AudioArtifact(
            artifact_id=artifact_id,
            path=path,
            media_type="audio/wav",
            sample_rate=sample_rate,
        )

    def _get_model(self) -> Qwen3TTSModel:
        if self._model is not None:
            return self._model
        with self._load_lock:
            if self._model is None:
                try:
                    dtype = DTYPES[self._config.dtype]
                except KeyError as error:
                    raise ValueError(f"Unsupported PI_VOICE_DTYPE: {self._config.dtype}") from error
                self._model = Qwen3TTSModel.from_pretrained(
                    self._config.model,
                    device_map=self._config.device,
                    dtype=dtype,
                    attn_implementation=self._config.attention,
                )
        return self._model

