"""Streaming endpoint tests: service-level validation and HTTP contract.

No model, no GPU: every provider is a fake. Real-GPU behavior is covered by the
manual smoke scripts under ``services/voice/examples``.
"""

import asyncio
import socket
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import httpx
import numpy as np
import pytest
import uvicorn
from fastapi.testclient import TestClient

from pi_voice.config import VoiceConfig
from pi_voice.main import create_app
from pi_voice.providers.base import AudioArtifact, SynthesisRequest
from pi_voice.service import AudioStreamError, EmptyAudioError, InvalidAudioError, VoiceService


def _request(text="你好，世界", language="Chinese", speaker="Vivian") -> SynthesisRequest:
    return SynthesisRequest(text=text, language=language, speaker=speaker)


class FakeArtifactProvider:
    loaded = True

    def synthesize(self, request: SynthesisRequest) -> AudioArtifact:
        return AudioArtifact("audio-1", Path("/tmp/audio-1.wav"), "audio/wav", 24000)


class FakeStreamingProvider:
    loaded = True

    def __init__(self, chunks=(), sample_rate: int = 24000, fail_on=None) -> None:
        self.chunks = list(chunks)
        self.sample_rate = sample_rate
        self.fail_on = fail_on
        self.requests: list[tuple[SynthesisRequest, int]] = []
        self.closed = False

    def stream(self, request: SynthesisRequest, *, chunk_size: int):
        self.requests.append((request, chunk_size))
        try:
            for index, samples in enumerate(self.chunks):
                if self.fail_on is not None and self.fail_on(index):
                    raise RuntimeError("provider exploded")
                yield {"samples": samples, "sample_rate": self.sample_rate}
        finally:
            self.closed = True


def _service(provider: FakeStreamingProvider, *, max_concurrency: int = 1, max_text_length: int = 100) -> VoiceService:
    return VoiceService(
        FakeArtifactProvider(),
        max_concurrency,
        max_text_length,
        streaming_provider=provider,
    )


async def _collect(chunks) -> bytes:
    return b"".join([chunk async for chunk in chunks])


# --------------------------------------------------------------------------- #
# Service level
# --------------------------------------------------------------------------- #


def test_stream_returns_pcm_bytes_and_metadata() -> None:
    provider = FakeStreamingProvider(chunks=(np.zeros(4, dtype="<f4"), np.zeros(4, dtype="<f4")))
    service = _service(provider)

    async def scenario():
        stream = await service.stream(_request(), chunk_size=8)
        return stream, await _collect(stream.chunks)

    stream, body = asyncio.run(scenario())
    assert stream.sample_rate == 24000
    assert stream.encoding == "pcm_f32le"
    assert len(body) == 8 * 4
    assert np.frombuffer(body, dtype="<f4").shape == (8,)
    assert provider.requests == [(_request(), 8)]


def test_stream_encodes_little_endian_float32() -> None:
    chunk = np.array([0.5, -1.0, 0.0, 0.25], dtype=np.float32)
    service = _service(FakeStreamingProvider(chunks=(chunk,)))

    async def scenario():
        stream = await service.stream(_request(), chunk_size=8)
        return await _collect(stream.chunks)

    body = asyncio.run(scenario())
    assert np.allclose(np.frombuffer(body, dtype="<f4"), [0.5, -1.0, 0.0, 0.25])


def test_stream_empty_generator_fails() -> None:
    service = _service(FakeStreamingProvider(chunks=()))
    with pytest.raises(EmptyAudioError) as exc_info:
        asyncio.run(service.stream(_request(), chunk_size=8))
    assert exc_info.value.code == "empty_output"


def test_stream_first_chunk_empty_fails() -> None:
    service = _service(FakeStreamingProvider(chunks=(np.array([], dtype="<f4"),)))
    with pytest.raises(EmptyAudioError):
        asyncio.run(service.stream(_request(), chunk_size=8))


def test_stream_mid_stream_empty_chunk_fails_and_closes() -> None:
    provider = FakeStreamingProvider(chunks=(np.zeros(4, dtype="<f4"), np.array([], dtype="<f4")))
    service = _service(provider)

    async def scenario():
        stream = await service.stream(_request(), chunk_size=8)
        await anext(stream.chunks)
        with pytest.raises(EmptyAudioError):
            await _collect(stream.chunks)
        assert provider.closed

    asyncio.run(scenario())


@pytest.mark.parametrize("value", [np.nan, np.inf, -np.inf])
def test_stream_rejects_non_finite_samples(value: float) -> None:
    service = _service(FakeStreamingProvider(chunks=(np.array([value], dtype="<f4"),)))
    with pytest.raises(InvalidAudioError) as exc_info:
        asyncio.run(service.stream(_request(), chunk_size=8))
    assert exc_info.value.code == "invalid_audio"


def test_stream_rejects_non_mono() -> None:
    service = _service(FakeStreamingProvider(chunks=(np.zeros((4, 2), dtype="<f4"),)))
    with pytest.raises(InvalidAudioError):
        asyncio.run(service.stream(_request(), chunk_size=8))


def test_stream_rejects_non_float_dtype() -> None:
    service = _service(FakeStreamingProvider(chunks=(np.zeros(4, dtype="<i4"),)))
    with pytest.raises(InvalidAudioError):
        asyncio.run(service.stream(_request(), chunk_size=8))


def test_stream_rejects_sample_rate_change_mid_stream() -> None:
    class ChangingProvider(FakeStreamingProvider):
        def stream(self, request, *, chunk_size):
            yield {"samples": np.zeros(4, dtype="<f4"), "sample_rate": 24000}
            yield {"samples": np.zeros(4, dtype="<f4"), "sample_rate": 16000}

    service = _service(ChangingProvider())

    async def scenario():
        stream = await service.stream(_request(), chunk_size=8)
        await anext(stream.chunks)
        with pytest.raises(InvalidAudioError):
            await _collect(stream.chunks)

    asyncio.run(scenario())


def test_stream_text_validation() -> None:
    service = _service(FakeStreamingProvider())
    with pytest.raises(ValueError, match="empty"):
        asyncio.run(service.stream(_request(text="   "), chunk_size=8))
    with pytest.raises(ValueError, match="limit"):
        asyncio.run(service.stream(_request(text="a" * 101), chunk_size=8))


def test_stream_rejects_non_positive_chunk_size() -> None:
    service = _service(FakeStreamingProvider())
    with pytest.raises(ValueError, match="chunk_size must be positive"):
        asyncio.run(service.stream(_request(), chunk_size=0))


def test_stream_chunk_size_passed_to_provider() -> None:
    provider = FakeStreamingProvider(chunks=(np.zeros(4, dtype="<f4"),))
    service = _service(provider)

    async def scenario():
        stream = await service.stream(_request(), chunk_size=16)
        await _collect(stream.chunks)

    asyncio.run(scenario())
    assert provider.requests[0][1] == 16


def test_stream_without_streaming_provider_raises() -> None:
    service = VoiceService(FakeArtifactProvider(), 1, 100)
    with pytest.raises(ValueError, match="not configured"):
        asyncio.run(service.stream(_request(), chunk_size=8))


def test_stream_and_synthesize_share_concurrency_slot() -> None:
    provider = FakeStreamingProvider(chunks=(np.zeros(4, dtype="<f4"), np.zeros(4, dtype="<f4")))
    service = _service(provider, max_concurrency=1)

    async def scenario():
        stream_a = await service.stream(_request(), chunk_size=8)
        await anext(stream_a.chunks)
        task_b = asyncio.create_task(service.stream(_request(text="第二句"), chunk_size=8))
        await asyncio.sleep(0.05)
        assert not task_b.done()  # stream A still holds the single slot
        await stream_a.chunks.aclose()  # releases the slot
        stream_b = await asyncio.wait_for(task_b, timeout=2)
        await _collect(stream_b.chunks)

    asyncio.run(scenario())


def test_cancel_closes_generator_and_releases_slot() -> None:
    provider = FakeStreamingProvider(chunks=(np.zeros(4, dtype="<f4"),) * 3)
    service = _service(provider)

    async def scenario():
        stream = await service.stream(_request(), chunk_size=8)
        chunks = stream.chunks
        await anext(chunks)
        consumer = asyncio.create_task(anext(chunks))
        await asyncio.sleep(0)
        consumer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await consumer
        await chunks.aclose()
        assert provider.closed
        # slot must be free for the next request immediately
        stream2 = await service.stream(_request(text="后续"), chunk_size=8)
        await _collect(stream2.chunks)

    asyncio.run(scenario())


def test_stream_mid_stream_upstream_error() -> None:
    provider = FakeStreamingProvider(
        chunks=(np.zeros(4, dtype="<f4"), np.zeros(4, dtype="<f4")),
        fail_on=lambda index: index == 1,
    )
    service = _service(provider)

    async def scenario():
        stream = await service.stream(_request(), chunk_size=8)
        await anext(stream.chunks)
        with pytest.raises(AudioStreamError) as exc_info:
            await _collect(stream.chunks)
        assert exc_info.value.code == "generation_failed"
        assert provider.closed

    asyncio.run(scenario())


def test_stream_provider_error_before_first_chunk() -> None:
    provider = FakeStreamingProvider(chunks=(np.zeros(4, dtype="<f4"),), fail_on=lambda index: index == 0)
    service = _service(provider)
    with pytest.raises(AudioStreamError) as exc_info:
        asyncio.run(service.stream(_request(), chunk_size=8))
    assert exc_info.value.code == "generation_failed"


def test_first_chunk_is_delivered_before_generation_completes() -> None:
    release = threading.Event()

    class GatedProvider(FakeStreamingProvider):
        def stream(self, request, *, chunk_size):
            try:
                yield {"samples": np.zeros(8, dtype="<f4"), "sample_rate": 24000}
                release.wait(5)
                yield {"samples": np.zeros(8, dtype="<f4"), "sample_rate": 24000}
            finally:
                self.closed = True

    service = _service(GatedProvider())

    async def scenario():
        stream = await service.stream(_request(), chunk_size=8)
        chunks = stream.chunks
        first = await anext(chunks)  # first chunk is available right now
        assert len(first) == 8 * 4
        assert not release.is_set()  # the generator is still blocked on chunk two
        release.set()
        rest = await _collect(chunks)
        assert len(first) + len(rest) == 16 * 4

    try:
        asyncio.run(scenario())
    finally:
        release.set()


# --------------------------------------------------------------------------- #
# HTTP contract
# --------------------------------------------------------------------------- #


def _config() -> VoiceConfig:
    return VoiceConfig(
        host="127.0.0.1",
        port=18876,
        token="test-token",
        model="test-model",
        device="cuda:0",
        dtype="bfloat16",
        attention="sdpa",
        max_concurrency=1,
        max_text_length=4000,
        artifact_dir=Path("/tmp/pi-voice-test-artifacts"),
        stream_chunk_size=8,
        stream_max_chunk_size=64,
    )


def _app(provider: FakeStreamingProvider):
    service = VoiceService(FakeArtifactProvider(), 1, 4000, streaming_provider=provider)
    return create_app(config=_config(), service=service)


def _client(provider: FakeStreamingProvider) -> TestClient:
    return TestClient(_app(provider))


@contextmanager
def _live_server(app):
    """Run ``app`` on a real loopback uvicorn server and yield an httpx client.

    Starlette's TestClient and httpx's ASGITransport both buffer the full body,
    so incremental first-chunk timing can only be observed against a live server.
    """
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        while not server.started:
            time.sleep(0.01)
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=15) as client:
            yield client
    finally:
        server.should_exit = True
        thread.join(timeout=5)


AUTH = {"Authorization": "Bearer test-token"}
STREAM_BODY = {"text": "你好", "language": "Chinese", "speaker": "Vivian"}


def test_http_stream_headers_and_pcm() -> None:
    provider = FakeStreamingProvider(chunks=(np.array([0.5, -1.0, 0.25], dtype="<f4"),))
    with _client(provider) as client:
        with client.stream("POST", "/v1/synthesize/stream", json=STREAM_BODY, headers=AUTH) as response:
            assert response.status_code == 200
            headers = response.headers
            assert headers["content-type"] == "application/vnd.pi.pcm"
            assert headers["cache-control"] == "no-store"
            assert headers["x-content-type-options"] == "nosniff"
            assert headers["x-pi-audio-encoding"] == "pcm_f32le"
            assert headers["x-pi-audio-sample-rate"] == "24000"
            assert headers["x-pi-audio-channels"] == "1"
            assert "content-length" not in headers
            body = b"".join(response.iter_bytes())
    assert np.allclose(np.frombuffer(body, dtype="<f4"), [0.5, -1.0, 0.25])


def test_http_streams_first_chunk_before_generation_completes() -> None:
    release = threading.Event()

    class GatedProvider(FakeStreamingProvider):
        def stream(self, request, *, chunk_size):
            try:
                yield {"samples": np.zeros(8, dtype="<f4"), "sample_rate": 24000}
                release.wait(5)
                yield {"samples": np.zeros(8, dtype="<f4"), "sample_rate": 24000}
            finally:
                self.closed = True

    try:
        with _live_server(_app(GatedProvider())) as client:
            with client.stream("POST", "/v1/synthesize/stream", json=STREAM_BODY, headers=AUTH) as response:
                assert response.status_code == 200
                reader = response.iter_bytes()
                first = next(reader)
                assert len(first) == 8 * 4
                assert not release.is_set()  # generation is still blocked on chunk two
                release.set()
                rest = b"".join(reader)
        assert len(first) + len(rest) == 16 * 4
    finally:
        release.set()


def test_http_stream_client_disconnect_closes_provider_and_releases_slot() -> None:
    release = threading.Event()

    class BlockingProvider(FakeStreamingProvider):
        def stream(self, request, *, chunk_size):
            try:
                yield {"samples": np.zeros(8, dtype="<f4"), "sample_rate": 24000}
                release.wait(10)  # block generation of a second chunk
                yield {"samples": np.zeros(8, dtype="<f4"), "sample_rate": 24000}
            finally:
                self.closed = True

    provider = BlockingProvider()
    try:
        with _live_server(_app(provider)) as client:
            with client.stream("POST", "/v1/synthesize/stream", json=STREAM_BODY, headers=AUTH) as response:
                assert response.status_code == 200
                first = next(response.iter_bytes())
                assert len(first) == 8 * 4
                # Browser disconnects mid-stream while generation is still running.
                response.close()
            release.set()  # let the blocked generator finish so cleanup completes
            # The single concurrency slot must be released: a second request
            # completes instead of hanging on the semaphore. ``release`` is
            # already set, so the provider yields both of its chunks (16 samples).
            with client.stream("POST", "/v1/synthesize/stream", json=STREAM_BODY, headers=AUTH) as response2:
                assert response2.status_code == 200
                body = b"".join(response2.iter_bytes())
        assert len(body) == 16 * 4
        assert provider.closed
    finally:
        release.set()


def test_http_stream_requires_token() -> None:
    with _client(FakeStreamingProvider()) as client:
        response = client.post("/v1/synthesize/stream", json=STREAM_BODY)
    assert response.status_code == 401


def test_http_stream_rejects_extra_field() -> None:
    with _client(FakeStreamingProvider()) as client:
        response = client.post("/v1/synthesize/stream", json={**STREAM_BODY, "unexpected": 1}, headers=AUTH)
    assert response.status_code == 422


@pytest.mark.parametrize("chunk_size", [0, -1, 65])
def test_http_stream_rejects_invalid_chunk_size(chunk_size: int) -> None:
    with _client(FakeStreamingProvider()) as client:
        response = client.post("/v1/synthesize/stream", json={**STREAM_BODY, "chunkSize": chunk_size}, headers=AUTH)
    assert response.status_code == 422


def test_http_stream_rejects_unsupported_encoding() -> None:
    with _client(FakeStreamingProvider()) as client:
        response = client.post("/v1/synthesize/stream", json={**STREAM_BODY, "encoding": "wav"}, headers=AUTH)
    assert response.status_code == 422


def test_http_stream_empty_text_rejected() -> None:
    with _client(FakeStreamingProvider()) as client:
        response = client.post("/v1/synthesize/stream", json={**STREAM_BODY, "text": "   "}, headers=AUTH)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


def test_http_stream_provider_failure_returns_502_without_leaking() -> None:
    provider = FakeStreamingProvider(chunks=(np.zeros(4, dtype="<f4"),), fail_on=lambda index: index == 0)
    with _client(provider) as client:
        response = client.post("/v1/synthesize/stream", json=STREAM_BODY, headers=AUTH)
    assert response.status_code == 502
    body = response.json()
    assert body["error"]["code"] == "generation_failed"
    assert "exploded" not in body["error"]["message"]  # upstream detail never leaks


def test_http_synthesize_endpoint_still_works() -> None:
    with _client(FakeStreamingProvider()) as client:
        response = client.post(
            "/v1/synthesize",
            json={"text": "你好", "language": "Chinese", "speaker": "Vivian", "instruct": "平静地说"},
            headers=AUTH,
        )
    assert response.status_code == 200
    assert response.json()["artifact_id"] == "audio-1"
