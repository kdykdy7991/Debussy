"""Configuration contract tests: defaults, validation and loopback enforcement."""

import pytest

from pi_voice.config import VoiceConfig


@pytest.fixture(autouse=True)
def _clean_environ(monkeypatch: pytest.MonkeyPatch) -> None:
    # The service reads only environment variables; keep every test hermetic.
    for key in (
        "PI_VOICE_TOKEN",
        "PI_VOICE_HOST",
        "PI_VOICE_PORT",
        "PI_VOICE_MODEL",
        "PI_VOICE_DEVICE",
        "PI_VOICE_DTYPE",
        "PI_VOICE_ATTENTION",
        "PI_VOICE_MAX_CONCURRENCY",
        "PI_VOICE_MAX_TEXT_LENGTH",
        "PI_VOICE_ARTIFACT_DIR",
        "PI_VOICE_STREAM_CHUNK_SIZE",
        "PI_VOICE_STREAM_MAX_CHUNK_SIZE",
    ):
        monkeypatch.delenv(key, raising=False)


def test_requires_token() -> None:
    with pytest.raises(ValueError, match="PI_VOICE_TOKEN"):
        VoiceConfig.from_environment()


def test_defaults_and_stream_chunk_bounds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PI_VOICE_TOKEN", "t")
    config = VoiceConfig.from_environment()
    assert config.host == "127.0.0.1"
    assert config.port == 18876
    assert config.stream_chunk_size == 8
    assert config.stream_max_chunk_size == 64
    assert config.max_concurrency == 1


def test_accepts_loopback_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PI_VOICE_TOKEN", "t")
    for host in ("127.0.0.1", "::1", "localhost"):
        monkeypatch.setenv("PI_VOICE_HOST", host)
        assert VoiceConfig.from_environment().host == host


def test_rejects_non_loopback_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PI_VOICE_TOKEN", "t")
    monkeypatch.setenv("PI_VOICE_HOST", "0.0.0.0")
    with pytest.raises(ValueError, match="loopback"):
        VoiceConfig.from_environment()
