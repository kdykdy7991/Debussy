"""Play faster-qwen3-tts audio chunks immediately in a local browser.

Manual regression tool kept after formalization: it reuses the same
:class:`FasterQwen3TTSProvider` boundary as ``POST /v1/synthesize/stream`` so the
browser latency and stop behavior can be eyeballed without running the full
service. Headers here are tool-internal (``X-Audio-Sample-Rate``,
``X-First-Chunk-Ms``); the formal streaming endpoint uses the ``X-Pi-Audio-*``
header contract instead.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path
from typing import AsyncIterator

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, StreamingResponse
import uvicorn

from pi_voice.config import VoiceConfig
from pi_voice.providers.base import SynthesisRequest
from pi_voice.providers.faster_qwen3_tts import FasterQwen3TTSProvider

DEFAULT_MODEL = Path.home() / ".cache/modelscope/models/Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice/snapshots/master"
DEFAULT_TEXT = "这是一段用于验证流式语音首包延迟的测试文本。"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL, help="Local model directory or model ID")
    parser.add_argument("--speaker", default="Vivian", help="CustomVoice speaker")
    parser.add_argument("--instruct", default=None, help="Optional CustomVoice instruction")
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--chunk-size", type=int, default=8)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float16", "float32"])
    parser.add_argument("--attention", default="sdpa", choices=["sdpa", "flash_attention_2"])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8888)
    return parser.parse_args()


PLAYER_HTML = f"""<!doctype html>
<meta charset="utf-8"><title>Qwen3-TTS streaming smoke</title>
<style>body{{max-width:720px;margin:48px auto;font:16px system-ui}}textarea{{box-sizing:border-box;width:100%;min-height:7em;padding:10px}}button{{margin:12px 8px 12px 0;padding:9px 14px}}#status{{white-space:pre-wrap;font-family:monospace}}</style>
<h1>Qwen3-TTS streaming smoke</h1>
<textarea id="text">{DEFAULT_TEXT}</textarea><br>
<button id="play">Stream & play</button><button id="stop" disabled>Stop</button>
<div id="status">Ready.</div>
<script>
let controller, audioContext, nextStart = 0;
const status = document.querySelector('#status'), play = document.querySelector('#play'), stop = document.querySelector('#stop');
function end() {{ controller?.abort(); controller = null; if (audioContext) {{ audioContext.close(); audioContext = null; }} stop.disabled = true; play.disabled = false; }}
stop.onclick = end;
play.onclick = async () => {{
  end(); status.textContent = 'Requesting stream…'; play.disabled = true; stop.disabled = false;
  controller = new AbortController(); audioContext = new AudioContext(); await audioContext.resume(); nextStart = audioContext.currentTime + .08;
  try {{
    const response = await fetch('/stream', {{method: 'POST', body: document.querySelector('#text').value, signal: controller.signal}});
    if (!response.ok || !response.body) throw Error(await response.text() || response.statusText);
    const rate = Number(response.headers.get('X-Audio-Sample-Rate'));
    status.textContent += `\\nFirst chunk: ${{response.headers.get('X-First-Chunk-Ms')}} ms; ${{rate}} Hz`;
    const reader = response.body.getReader(); let remaining = new Uint8Array(0), chunks = 0;
    for (;;) {{
      const {{value, done}} = await reader.read(); if (done) break;
      const joined = new Uint8Array(remaining.length + value.length); joined.set(remaining); joined.set(value, remaining.length);
      const bytes = joined.byteLength - joined.byteLength % 4; remaining = joined.slice(bytes); if (!bytes) continue;
      const samples = new Float32Array(joined.buffer, joined.byteOffset, bytes / 4);
      const buffer = audioContext.createBuffer(1, samples.length, rate); buffer.copyToChannel(samples, 0);
      const source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(audioContext.destination);
      nextStart = Math.max(nextStart, audioContext.currentTime + .03); source.start(nextStart); nextStart += buffer.duration; chunks++;
    }}
    status.textContent += `\\nStream finished (${{chunks}} chunks).`;
  }} catch (error) {{ if (error.name !== 'AbortError') status.textContent += '\\nError: ' + error.message; }}
  finally {{ stop.disabled = true; play.disabled = false; controller = null; }}
}};
</script>"""


def main() -> None:
    args = parse_args()
    if args.chunk_size < 1:
        raise SystemExit("--chunk-size must be positive")
    model_path = args.model.expanduser()
    config = VoiceConfig(
        host="127.0.0.1",
        port=18876,
        token="manual-player",
        model=str(model_path),
        device=args.device,
        dtype=args.dtype,
        attention=args.attention,
        max_concurrency=1,
        max_text_length=4000,
        artifact_dir=Path("/tmp/pi-voice-artifacts"),
        stream_chunk_size=args.chunk_size,
        stream_max_chunk_size=64,
    )
    provider = FasterQwen3TTSProvider(config)
    print(f"Model will be loaded lazily on the first request: {model_path}")
    app = FastAPI(docs_url=None, redoc_url=None)

    @app.get("/", response_class=HTMLResponse)
    def player() -> str:
        return PLAYER_HTML

    @app.post("/stream")
    async def stream(request: Request) -> StreamingResponse:
        text = (await request.body()).decode("utf-8").strip()
        if not text:
            raise HTTPException(status_code=422, detail="Text must not be empty")
        started = time.perf_counter()
        iterator = iter(
            provider.stream(
                SynthesisRequest(
                    text=text,
                    language=args.language,
                    speaker=args.speaker,
                    instruct=args.instruct,
                ),
                chunk_size=args.chunk_size,
            )
        )
        try:
            first = await run_in_threadpool(next, iterator)
        except StopIteration as error:
            raise HTTPException(status_code=502, detail="The model returned no audio chunks") from error
        first_bytes = np.asarray(first["samples"], dtype="<f4").reshape(-1).tobytes()
        sample_rate = first["sample_rate"]

        async def pcm_chunks() -> AsyncIterator[bytes]:
            try:
                yield first_bytes
                while True:
                    try:
                        chunk = await run_in_threadpool(next, iterator)
                    except StopIteration:
                        return
                    yield np.asarray(chunk["samples"], dtype="<f4").reshape(-1).tobytes()
            finally:
                # Browser disconnect or request cancellation closes this async
                # generator; closing the inner iterator stops the CUDA loop at
                # the next chunk boundary so the GPU is released promptly.
                iterator.close()

        return StreamingResponse(
            pcm_chunks(),
            media_type="application/octet-stream",
            headers={
                "X-Audio-Sample-Rate": str(sample_rate),
                "X-First-Chunk-Ms": f"{(time.perf_counter() - started) * 1000:.1f}",
                "Cache-Control": "no-store",
            },
        )

    print(f"Open http://{args.host}:{args.port} in a browser")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
