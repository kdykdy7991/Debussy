"""Application service for bounded speech synthesis."""

import asyncio

from pi_voice.providers.base import AudioArtifact, SynthesisRequest, TTSProvider


class VoiceService:
    def __init__(self, provider: TTSProvider, max_concurrency: int, max_text_length: int) -> None:
        self._provider = provider
        self._slots = asyncio.Semaphore(max_concurrency)
        self._max_text_length = max_text_length

    @property
    def model_loaded(self) -> bool:
        return self._provider.loaded

    async def synthesize(self, request: SynthesisRequest) -> AudioArtifact:
        text = request.text.strip()
        if not text:
            raise ValueError("Text must not be empty")
        if len(text) > self._max_text_length:
            raise ValueError(f"Text exceeds the {self._max_text_length} character limit")
        normalized = SynthesisRequest(
            text=text,
            language=request.language,
            speaker=request.speaker,
            instruct=request.instruct,
        )
        async with self._slots:
            return await asyncio.to_thread(self._provider.synthesize, normalized)

