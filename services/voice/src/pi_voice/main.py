"""Loopback-only HTTP entry point for the Pi voice service."""

from contextlib import asynccontextmanager
from hmac import compare_digest
from typing import AsyncIterator

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status

from pi_voice.config import VoiceConfig
from pi_voice.providers.base import SynthesisRequest
from pi_voice.providers.qwen3_tts import Qwen3TTSProvider
from pi_voice.schemas import HealthResult, SynthesisBody, SynthesisResult
from pi_voice.service import VoiceService


def create_app(config: VoiceConfig | None = None, service: VoiceService | None = None) -> FastAPI:
    resolved_config = config or VoiceConfig.from_environment()
    resolved_service = service or VoiceService(
        Qwen3TTSProvider(resolved_config),
        resolved_config.max_concurrency,
        resolved_config.max_text_length,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.voice_service = resolved_service
        yield

    app = FastAPI(title="Pi Voice Service", version="0.1.0", lifespan=lifespan)

    def authorize(authorization: str = Header(default="")) -> None:
        prefix = "Bearer "
        if not authorization.startswith(prefix) or not compare_digest(authorization[len(prefix) :], resolved_config.token):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid service token")

    @app.get("/health", response_model=HealthResult, dependencies=[Depends(authorize)])
    async def health(request: Request) -> HealthResult:
        voice_service: VoiceService = request.app.state.voice_service
        return HealthResult(status="ok", provider="qwen3-tts", model_loaded=voice_service.model_loaded)

    @app.post("/v1/synthesize", response_model=SynthesisResult, dependencies=[Depends(authorize)])
    async def synthesize(body: SynthesisBody, request: Request) -> SynthesisResult:
        voice_service: VoiceService = request.app.state.voice_service
        try:
            artifact = await voice_service.synthesize(
                SynthesisRequest(
                    text=body.text,
                    language=body.language,
                    speaker=body.speaker,
                    instruct=body.instruct,
                )
            )
        except ValueError as error:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error
        return SynthesisResult(
            artifact_id=artifact.artifact_id,
            media_type=artifact.media_type,
            sample_rate=artifact.sample_rate,
            path=str(artifact.path),
        )

    return app


def run() -> None:
    config = VoiceConfig.from_environment()
    uvicorn.run(create_app(config), host=config.host, port=config.port)


if __name__ == "__main__":
    run()

