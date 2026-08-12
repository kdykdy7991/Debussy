import { afterEach, describe, expect, test, vi } from "vitest";
import { VoiceServiceHttpClient } from "../src/voice/client.ts";
import { VoiceLimitError, VoiceUpstreamError } from "../src/voice/types.ts";

const PCM_HEADERS = {
	"content-type": "application/vnd.pi.pcm",
	"x-pi-audio-encoding": "pcm_f32le",
	"x-pi-audio-sample-rate": "24000",
	"x-pi-audio-channels": "1",
};

function pcm(chunks: Uint8Array[]): Uint8Array[] {
	return chunks;
}

function pcmResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		}),
		{ status: 200, headers: { ...PCM_HEADERS, ...headers } },
	);
}

/** A body that yields `chunks` then never resolves (or aborts when signalled). */
function hangingBody(signal?: AbortSignal): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			signal?.addEventListener(
				"abort",
				() => {
					try {
						controller.error(new DOMException("Aborted", "AbortError"));
					} catch {
						// Controller already closed.
					}
				},
				{ once: true },
			);
		},
	});
}

function fakeFetch(response: Response): typeof fetch {
	return async () => response;
}

function makeClient(overrides: Record<string, unknown> = {}): VoiceServiceHttpClient {
	return new VoiceServiceHttpClient({
		baseUrl: "http://127.0.0.1:18876",
		token: "service-secret",
		...overrides,
	});
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("VoiceServiceHttpClient happy path", () => {
	test("parses headers and streams chunks without buffering", async () => {
		const chunk1 = new Uint8Array([1, 2, 3, 4]);
		const chunk2 = new Uint8Array([5, 6, 7, 8]);
		const fetch = fakeFetch(pcmResponse(pcm([chunk1, chunk2])));
		const clientWithFetch = new VoiceServiceHttpClient({
			baseUrl: "http://127.0.0.1:18876",
			token: "service-secret",
			fetch: fetch as typeof fetch,
		});
		const result = await clientWithFetch.openStream(
			{ text: "你好", language: "Chinese", speaker: "Vivian" },
			new AbortController().signal,
		);
		expect(result.format).toEqual({ encoding: "pcm_f32le", sampleRate: 24000, channels: 1 });
		expect(await readAll(result.body)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
	});

	test("posts the resolved synthesis with an internal bearer token", async () => {
		let captured: { url: string; init: RequestInit } | undefined;
		const client = makeClient({
			fetch: (async (url: string | URL, init?: RequestInit) => {
				captured = { url: String(url), init: init ?? {} };
				return pcmResponse(pcm([new Uint8Array([1, 2, 3, 4])]));
			}) as typeof fetch,
		});
		await client.openStream(
			{ text: "hi", language: "Chinese", speaker: "Vivian", instruct: "cheerful" },
			new AbortController().signal,
		);
		expect(captured?.url).toBe("http://127.0.0.1:18876/v1/synthesize/stream");
		expect(captured?.init.method).toBe("POST");
		expect((captured?.init.headers as Record<string, string>).authorization).toBe("Bearer service-secret");
		expect(JSON.parse(captured?.init.body as string)).toMatchObject({
			text: "hi",
			language: "Chinese",
			speaker: "Vivian",
			instruct: "cheerful",
			encoding: "pcm_f32le",
		});
	});

	test("decodes arbitrary upstream chunk boundaries by reassembling bytes", async () => {
		// float32 samples split across network chunks must be forwarded verbatim.
		const samples = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
		const client = makeClient({
			fetch: fakeFetch(pcmResponse([samples.subarray(0, 3), samples.subarray(3)])) as typeof fetch,
		});
		const result = await client.openStream(
			{ text: "hi", language: "Chinese", speaker: "Vivian" },
			new AbortController().signal,
		);
		expect(await readAll(result.body)).toEqual(samples);
	});
});

describe("VoiceServiceHttpClient upstream validation", () => {
	test("rejects a non-200 status with voice_unavailable", async () => {
		const client = makeClient({
			fetch: (async () => new Response(JSON.stringify({ error: { code: "bad" } }), { status: 500 })) as typeof fetch,
		});
		await expect(
			client.openStream({ text: "hi", language: "Chinese", speaker: "Vivian" }, new AbortController().signal),
		).rejects.toBeInstanceOf(VoiceUpstreamError);
	});

	test.each([
		["content-type", { "content-type": "application/json" }],
		["encoding", { "x-pi-audio-encoding": "wav" }],
		["sample-rate", { "x-pi-audio-sample-rate": "abc" }],
		["channels", { "x-pi-audio-channels": "2" }],
	] as const)("rejects a response with a bad %s header", (_label, headers) => {
		const client = makeClient({ fetch: fakeFetch(pcmResponse(pcm([]), headers)) as typeof fetch });
		return expect(
			client.openStream({ text: "hi", language: "Chinese", speaker: "Vivian" }, new AbortController().signal),
		).rejects.toBeInstanceOf(VoiceUpstreamError);
	});

	test("rejects a body that produces no audio", async () => {
		const client = makeClient({ fetch: fakeFetch(pcmResponse(pcm([]))) as typeof fetch });
		await expect(
			client.openStream({ text: "hi", language: "Chinese", speaker: "Vivian" }, new AbortController().signal),
		).rejects.toBeInstanceOf(VoiceUpstreamError);
	});
});

describe("VoiceServiceHttpClient limits", () => {
	test("first-chunk timeout surfaces as voice_unavailable", async () => {
		vi.useFakeTimers();
		const client = makeClient({
			firstChunkTimeoutMs: 50,
			fetch: (async () => new Response(hangingBody(), { status: 200, headers: PCM_HEADERS })) as typeof fetch,
		});
		const pending = client.openStream(
			{ text: "hi", language: "Chinese", speaker: "Vivian" },
			new AbortController().signal,
		);
		const assertion = expect(pending).rejects.toBeInstanceOf(VoiceUpstreamError);
		await vi.advanceTimersByTimeAsync(60);
		await assertion;
	});

	test("idle timeout between chunks yields a limit error", async () => {
		vi.useFakeTimers();
		const client = makeClient({
			idleTimeoutMs: 50,
			firstChunkTimeoutMs: 1_000,
			totalTimeoutMs: 10_000,
			fetch: (async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array([1, 2, 3, 4]));
						},
					}),
					{ status: 200, headers: PCM_HEADERS },
				)) as typeof fetch,
		});
		const result = await client.openStream(
			{ text: "hi", language: "Chinese", speaker: "Vivian" },
			new AbortController().signal,
		);
		const reader = result.body.getReader();
		await reader.read(); // first chunk
		const pending = reader.read(); // limited pull hangs on upstream
		const assertion = expect(pending).rejects.toBeInstanceOf(VoiceLimitError);
		await vi.advanceTimersByTimeAsync(60);
		await assertion;
	});

	test("max bytes cap errors mid-stream", async () => {
		vi.useFakeTimers();
		const chunk = new Uint8Array([1, 2, 3, 4]);
		const client = makeClient({
			maxBytes: 8,
			fetch: fakeFetch(pcmResponse([chunk, chunk, chunk, chunk])) as typeof fetch,
		});
		const result = await client.openStream(
			{ text: "hi", language: "Chinese", speaker: "Vivian" },
			new AbortController().signal,
		);
		const reader = result.body.getReader();
		// First chunk is prepended outside the byte counter; the cap counts the
		// remaining limited chunks (4 each, cap 8) so the fourth read trips it.
		await reader.read();
		await reader.read();
		await reader.read();
		const assertion = expect(reader.read()).rejects.toBeInstanceOf(VoiceLimitError);
		await vi.advanceTimersByTimeAsync(10);
		await assertion;
	});

	test("aborting the caller rejects the stream with AbortError", async () => {
		const controller = new AbortController();
		const client = makeClient({
			fetch: (async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(streamController) {
							streamController.enqueue(new Uint8Array([1, 2, 3, 4]));
							controller.signal.addEventListener("abort", () => {
								try {
									streamController.error(new DOMException("Aborted", "AbortError"));
								} catch {
									// Already closed.
								}
							});
						},
					}),
					{ status: 200, headers: PCM_HEADERS },
				)) as typeof fetch,
		});
		const result = await client.openStream({ text: "hi", language: "Chinese", speaker: "Vivian" }, controller.signal);
		const reader = result.body.getReader();
		await reader.read();
		const pending = reader.read();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});
});
