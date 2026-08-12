"""Application service for bounded speech synthesis."""

import asyncio
import logging
import threading
from dataclasses import dataclass
from queue import Queue
from typing import AsyncIterator

import anyio
import numpy as np

from pi_voice.providers.base import (
    AudioArtifact,
    StreamingTTSProvider,
    SynthesisRequest,
    TTSProvider,
)

logger = logging.getLogger(__name__)


class AudioStreamError(Exception):
    """A streaming failure surfaced before the first PCM byte or mid-stream.

    ``code`` is a stable, safe machine-readable identifier that is allowed to
    cross the service boundary; ``message`` never contains user text, model
    paths, CUDA details or stack traces.
    """

    code = "generation_failed"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code


class EmptyAudioError(AudioStreamError):
    """The generator finished without producing a usable audio chunk."""

    code = "empty_output"


class InvalidAudioError(AudioStreamError):
    """The provider yielded audio that violates the PCM contract."""

    code = "invalid_audio"


@dataclass(frozen=True)
class AudioStream:
    sample_rate: int
    encoding: str
    chunks: AsyncIterator[bytes]


class _StreamProducer:
    """Consumes a synchronous streaming provider generator on a worker thread.

    A Python generator cannot be interrupted from another thread while a CUDA
    step is executing, so cancellation is cooperative: setting ``stop`` ends the
    loop at the next chunk boundary, after which the generator is closed by the
    same thread that advanced it. ``wait_closed`` lets the caller release the
    concurrency slot only after the generator has actually been torn down.
    """

    def __init__(
        self,
        provider: StreamingTTSProvider,
        request: SynthesisRequest,
        chunk_size: int,
    ) -> None:
        self._iterator = iter(provider.stream(request, chunk_size=chunk_size))
        self._queue: Queue[tuple[str, object]] = Queue()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="voice-stream", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    async def receive(self) -> tuple[str, object]:
        return await asyncio.to_thread(self._queue.get)

    async def wait_closed(self, timeout: float = 30.0) -> None:
        # Cleanup always runs, even while the request task is being cancelled
        # (uvicorn cancels the app task via an anyio cancel scope on client
        # disconnect). Without the shield, every await here would immediately
        # re-raise CancelledError and the concurrency slot would leak.
        with anyio.CancelScope(shield=True):
            try:
                await asyncio.wait_for(self._drain(), timeout=timeout)
            except asyncio.TimeoutError:
                logger.warning("voice stream producer did not close within %.0fs", timeout)

    async def _drain(self) -> None:
        while True:
            kind, _ = await self.receive()
            if kind == "closed":
                return

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                try:
                    chunk = next(self._iterator)
                except StopIteration:
                    self._queue.put(("done", None))
                    return
                self._queue.put(("chunk", chunk))
            self._queue.put(("done", None))
        except Exception as exc:
            self._queue.put(("error", exc))
        finally:
            close = getattr(self._iterator, "close", None)
            if close is not None:
                try:
                    close()
                except Exception:
                    pass
            self._queue.put(("closed", None))


class VoiceService:
    def __init__(
        self,
        provider: TTSProvider,
        max_concurrency: int,
        max_text_length: int,
        *,
        streaming_provider: StreamingTTSProvider | None = None,
    ) -> None:
        self._provider = provider
        self._streaming_provider = streaming_provider
        self._slots = asyncio.Semaphore(max_concurrency)
        self._max_text_length = max_text_length

    @property
    def model_loaded(self) -> bool:
        if self._provider.loaded:
            return True
        return bool(self._streaming_provider is not None and self._streaming_provider.loaded)

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

    async def stream(
        self,
        request: SynthesisRequest,
        *,
        chunk_size: int,
        encoding: str = "pcm_f32le",
    ) -> AudioStream:
        """Open a streaming synthesis and consume its first chunk.

        The concurrency slot is acquired here and held until the returned
        ``AudioStream.chunks`` generator is exhausted, closed or cancelled, so
        both streaming and non-streaming requests share the same limit.
        """
        if self._streaming_provider is None:
            raise ValueError("Streaming synthesis is not configured")
        if chunk_size < 1:
            raise ValueError("chunk_size must be positive")
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

        await self._slots.acquire()
        producer = _StreamProducer(self._streaming_provider, normalized, chunk_size)
        producer.start()
        try:
            kind, payload = await producer.receive()
            if kind in ("done", "closed"):
                raise EmptyAudioError("The model returned no audio chunks")
            if kind == "error":
                raise self._upstream_error(payload)
            first_samples, sample_rate = self._validate_chunk(
                payload["samples"], payload["sample_rate"], expected_rate=None
            )
        except BaseException:
            producer.stop()
            await producer.wait_closed()
            self._slots.release()
            raise

        async def chunks() -> AsyncIterator[bytes]:
            try:
                yield first_samples.tobytes()
                while True:
                    kind, payload = await producer.receive()
                    if kind in ("done", "closed"):
                        return
                    if kind == "error":
                        raise self._upstream_error(payload)
                    samples, _ = self._validate_chunk(
                        payload["samples"], payload["sample_rate"], expected_rate=sample_rate
                    )
                    yield samples.tobytes()
            finally:
                producer.stop()
                await producer.wait_closed()
                self._slots.release()

        return AudioStream(sample_rate=sample_rate, encoding=encoding, chunks=chunks())

    def _validate_chunk(
        self,
        samples: object,
        sample_rate: object,
        expected_rate: int | None,
    ) -> tuple[np.ndarray, int]:
        if isinstance(sample_rate, bool) or not isinstance(sample_rate, int):
            raise InvalidAudioError("Sample rate must be a positive integer")
        if sample_rate <= 0:
            raise InvalidAudioError("Sample rate must be positive")
        array = np.asarray(samples)
        if array.dtype.kind != "f":
            raise InvalidAudioError("Audio samples must be floating point")
        if array.ndim not in (1, 2) or (array.ndim == 2 and array.shape[1] != 1):
            raise InvalidAudioError("Audio must be mono")
        flat = array.reshape(-1)
        if flat.size == 0:
            raise EmptyAudioError("Audio chunk is empty")
        if not np.all(np.isfinite(flat)):
            raise InvalidAudioError("Audio contains non-finite samples")
        if expected_rate is not None and sample_rate != expected_rate:
            raise InvalidAudioError("Sample rate changed mid-stream")
        return flat.astype("<f4", copy=False), sample_rate

    def _upstream_error(self, exc: BaseException) -> AudioStreamError:
        # The real exception stays in internal logs; the client only sees a safe
        # code/message. type() name + str avoids dumping a full CUDA stack.
        logger.warning("voice streaming failed: %s: %s", type(exc).__name__, exc)
        return AudioStreamError("Voice generation failed")
