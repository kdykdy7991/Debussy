"""Provider boundary shared by production and fake implementations."""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class SynthesisRequest:
    text: str
    language: str
    speaker: str
    instruct: str | None = None


@dataclass(frozen=True)
class AudioArtifact:
    artifact_id: str
    path: Path
    media_type: str
    sample_rate: int


class TTSProvider(Protocol):
    @property
    def loaded(self) -> bool: ...

    def synthesize(self, request: SynthesisRequest) -> AudioArtifact: ...
