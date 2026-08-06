"""HTTP request and response schemas."""

from pydantic import BaseModel, ConfigDict, Field


class SynthesisBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1)
    language: str = Field(min_length=1)
    speaker: str = Field(min_length=1)
    instruct: str | None = None


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

