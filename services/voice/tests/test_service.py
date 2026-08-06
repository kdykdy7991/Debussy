import asyncio
from pathlib import Path

import pytest

from pi_voice.providers.base import AudioArtifact, SynthesisRequest
from pi_voice.service import VoiceService


class FakeProvider:
    loaded = True

    def __init__(self) -> None:
        self.requests: list[SynthesisRequest] = []

    def synthesize(self, request: SynthesisRequest) -> AudioArtifact:
        self.requests.append(request)
        return AudioArtifact("audio-1", Path("/tmp/audio-1.wav"), "audio/wav", 24000)


def test_synthesizes_trimmed_text() -> None:
    provider = FakeProvider()
    service = VoiceService(provider, max_concurrency=1, max_text_length=20)

    artifact = asyncio.run(service.synthesize(SynthesisRequest("  你好  ", "Chinese", "Vivian")))

    assert artifact.artifact_id == "audio-1"
    assert provider.requests == [SynthesisRequest("你好", "Chinese", "Vivian")]


def test_rejects_text_over_limit() -> None:
    service = VoiceService(FakeProvider(), max_concurrency=1, max_text_length=2)

    with pytest.raises(ValueError, match="character limit"):
        asyncio.run(service.synthesize(SynthesisRequest("太长了", "Chinese", "Vivian")))
