"""HTTP request and response schemas."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class SynthesisBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1)
    language: str = Field(min_length=1)
    speaker: str = Field(min_length=1)
    instruct: str | None = None


class SynthesisStreamBody(BaseModel):
    """Body for ``POST /v1/synthesize/stream`` (frozen by V1 task contract)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    text: str = Field(min_length=1)
    language: str = Field(min_length=1)
    speaker: str = Field(min_length=1)
    instruct: str | None = None
    chunk_size: int | None = Field(default=None, ge=1, alias="chunkSize")
    encoding: Literal["pcm_f32le"] = "pcm_f32le"


class SynthesisResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifact_id: str
    media_type: str
    sample_rate: int
    path: str


class HealthResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str
    provider: str
    model_loaded: bool

