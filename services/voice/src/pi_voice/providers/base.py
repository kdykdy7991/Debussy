"""Provider boundary shared by production and fake implementations."""

from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Protocol, TypedDict

import numpy as np


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


class AudioChunk(TypedDict):
    """One produced audio segment. ``samples`` is always mono."""

    samples: np.ndarray
    sample_rate: int


class TTSProvider(Protocol):
    """Artifact-oriented provider used by the non-streaming endpoint."""

    @property
    def loaded(self) -> bool: ...

    def synthesize(self, request: SynthesisRequest) -> AudioArtifact: ...


class StreamingTTSProvider(Protocol):
    """Streaming provider used by ``POST /v1/synthesize/stream``.

    Deliberately separate from :class:`TTSProvider`: the CUDA-graph faster
    streaming engine is a distinct model lifecycle from the legacy artifact
    provider, and the service must not switch providers by string comparison.
    """

    @property
    def loaded(self) -> bool: ...

    def stream(self, request: SynthesisRequest, *, chunk_size: int) -> Iterator[AudioChunk]: ...
