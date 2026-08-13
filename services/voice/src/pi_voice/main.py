"""Loopback-only HTTP entry point for the Pi voice service."""

import logging
from contextlib import asynccontextmanager
from hmac import compare_digest
from typing import AsyncIterator

import anyio
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse, StreamingResponse

from pi_voice.config import VoiceConfig
from pi_voice.providers.base import SynthesisRequest
from pi_voice.providers.faster_qwen3_tts import FasterQwen3TTSProvider
from pi_voice.providers.qwen3_tts import Qwen3TTSProvider
from pi_voice.schemas import HealthResult, SynthesisBody, SynthesisResult, SynthesisStreamBody
from pi_voice.service import AudioStreamError, VoiceService

logger = logging.getLogger(__name__)

_LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "()": "uvicorn.logging.DefaultFormatter",
            "fmt": "%(asctime)s %(levelprefix)s %(message)s",
            "use_colors": None,
        },
        "access": {
            "()": "uvicorn.logging.AccessFormatter",
            "fmt": '%(asctime)s %(levelprefix)s %(client_addr)s - "%(request_line)s" %(status_code)s',
        },
    },
    "handlers": {
        "default": {
            "formatter": "default",
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stderr",
        },
        "access": {
            "formatter": "access",
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stdout",
        },
    },
    "loggers": {
        "uvicorn": {"handlers": ["default"], "level": "INFO", "propagate": False},
        "uvicorn.error": {"level": "INFO"},
        "uvicorn.access": {"handlers": ["access"], "level": "INFO", "propagate": False},
    },
}


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message}})


def create_app(config: VoiceConfig | None = None, service: VoiceService | None = None) -> FastAPI:
    resolved_config = config or VoiceConfig.from_environment()
    resolved_service = service or VoiceService(
        Qwen3TTSProvider(resolved_config),
        resolved_config.max_concurrency,
        resolved_config.max_text_length,
        streaming_provider=FasterQwen3TTSProvider(resolved_config),
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

    @app.post("/v1/synthesize/stream", dependencies=[Depends(authorize)], response_model=None)
    async def synthesize_stream(body: SynthesisStreamBody, request: Request) -> StreamingResponse | JSONResponse:
        voice_service: VoiceService = request.app.state.voice_service
        chunk_size = body.chunk_size if body.chunk_size is not None else resolved_config.stream_chunk_size
        if chunk_size > resolved_config.stream_max_chunk_size:
            return _error_response(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "invalid_request",
                f"chunkSize exceeds the configured maximum of {resolved_config.stream_max_chunk_size}",
            )
        try:
            stream = await voice_service.stream(
                SynthesisRequest(
                    text=body.text,
                    language=body.language,
                    speaker=body.speaker,
                    instruct=body.instruct,
                ),
                chunk_size=chunk_size,
                encoding=body.encoding,
            )
        except ValueError as error:
            return _error_response(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_request", str(error))
        except AudioStreamError as error:
            return _error_response(status.HTTP_502_BAD_GATEWAY, error.code, error.message)

        async def generator() -> AsyncIterator[bytes]:
            try:
                async for chunk in stream.chunks:
                    yield chunk
            except AudioStreamError as error:
                # Headers and at least one PCM byte have already been sent;
                # the response can no longer switch to a JSON error.
                logger.warning("speech stream ended with %s after headers", error.code)
            finally:
                # On client disconnect uvicorn cancels the app task, throwing
                # CancelledError into this generator at the current ``yield`` and
                # re-raising it on every subsequent await. The shield lets the
                # upstream chunks generator close anyway — that stops the producer
                # thread and releases the concurrency slot before the cancellation
                # propagates. aclose() is idempotent on an exhausted generator.
                with anyio.CancelScope(shield=True):
                    await stream.chunks.aclose()

        return StreamingResponse(
            generator(),
            media_type="application/vnd.pi.pcm",
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "X-Pi-Audio-Encoding": stream.encoding,
                "X-Pi-Audio-Sample-Rate": str(stream.sample_rate),
                "X-Pi-Audio-Channels": "1",
            },
        )

    return app


def run() -> None:
    config = VoiceConfig.from_environment()
    uvicorn.run(create_app(config), host=config.host, port=config.port, log_config=_LOGGING_CONFIG)


if __name__ == "__main__":
    run()

