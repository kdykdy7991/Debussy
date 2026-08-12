import type { LiveSpeechJob, SpeechJob } from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import { openLiveSpeechStream, openSpeechStream } from "../src/index.ts";
import type { SpeechStreamFetch, SpeechStreamResponse } from "../src/speech-stream.ts";
import { collectRequests, connectClient, MemoryByteServer, sessionSnapshot } from "./support.ts";

const STREAM_PATH = "/api/pi/v3/speech/job-1/stream";
const BASE_URL = "http://127.0.0.1:8765";

function makeJob(overrides: Partial<SpeechJob> = {}): SpeechJob {
	return {
		id: "job-1",
		sessionId: "session-1",
		messageId: "message-1",
		voiceProfileId: "default",
		status: "queued",
		streamPath: STREAM_PATH,
		createdAt: 1000,
		updatedAt: 1000,
		...overrides,
	};
}

class FakeHeaders {
	readonly #values = new Map<string, string>();

	set(name: string, value: string): void {
		this.#values.set(name.toLowerCase(), value);
	}

	get(name: string): string | null {
		return this.#values.get(name.toLowerCase()) ?? null;
	}
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function makeResponse(
	options: { status?: number; headers?: FakeHeaders; body?: Uint8Array } = {},
): SpeechStreamResponse {
	const headers = options.headers ?? new FakeHeaders();
	return {
		ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
		status: options.status ?? 200,
		headers,
		body: options.body ? bytesToStream(options.body) : null,
	};
}

function audioHeaders(): FakeHeaders {
	const headers = new FakeHeaders();
	headers.set("Content-Type", "application/vnd.pi.pcm");
	headers.set("X-Pi-Audio-Encoding", "pcm_f32le");
	headers.set("X-Pi-Audio-Sample-Rate", "24000");
	headers.set("X-Pi-Audio-Channels", "1");
	return headers;
}

function makeFetchMock(
	handler: (
		url: URL,
		init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
	) => SpeechStreamResponse,
): {
	fetch: SpeechStreamFetch;
	calls: Array<{ url: URL; init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } }>;
} {
	const calls: Array<{
		url: URL;
		init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal };
	}> = [];
	const fetch: SpeechStreamFetch = (url, init) => {
		calls.push({ url, init });
		return Promise.resolve(handler(url, init));
	};
	return { fetch, calls };
}

describe("PiClient.startSpeech", () => {
	test("sends start_speech and resolves with a queued job handle", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);

		const starting = client.startSpeech({ sessionId: "session-1", messageId: "message-1" });
		const request = requests.find((candidate) => candidate.request.command === "start_speech");
		expect(request).toBeDefined();
		expect(request?.request).toMatchObject({
			command: "start_speech",
			sessionId: "session-1",
			messageId: "message-1",
		});
		server.send({
			type: "response",
			id: request?.id ?? "missing",
			ok: true,
			result: { command: "start_speech", job: makeJob() },
		});

		const handle = await starting;
		expect(handle.job.id).toBe("job-1");
		expect(handle.job.status).toBe("queued");
	});

	test("forwards the optional voiceProfileId", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);

		const starting = client.startSpeech({ sessionId: "s", messageId: "m", voiceProfileId: "vivian" });
		const request = requests.find((candidate) => candidate.request.command === "start_speech");
		expect(request?.request).toMatchObject({ command: "start_speech", voiceProfileId: "vivian" });
		server.send({
			type: "response",
			id: request?.id ?? "missing",
			ok: true,
			result: { command: "start_speech", job: makeJob() },
		});
		await starting;
	});

	test("routes speech_job events to the owning handle and notifies subscribers", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const starting = client.startSpeech({ sessionId: "s", messageId: "m" });
		const request = requests.find((candidate) => candidate.request.command === "start_speech");
		server.send({
			type: "response",
			id: request?.id ?? "missing",
			ok: true,
			result: { command: "start_speech", job: makeJob() },
		});
		const handle = await starting;
		const listener = vi.fn();
		handle.subscribe(listener);

		server.send({
			type: "event",
			event: { type: "speech_job", job: makeJob({ status: "generating", updatedAt: 1001 }) },
		});
		expect(handle.job.status).toBe("generating");
		expect(listener).toHaveBeenCalledTimes(1);

		server.send({
			type: "event",
			event: {
				type: "speech_job",
				job: makeJob({
					status: "streaming",
					updatedAt: 1002,
					audio: { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 },
				}),
			},
		});
		expect(handle.job.status).toBe("streaming");
		expect(listener).toHaveBeenCalledTimes(2);
	});

	test("ignores speech_job events for unknown jobs", async () => {
		const server = new MemoryByteServer();
		await connectClient(server);
		expect(() =>
			server.send({
				type: "event",
				event: { type: "speech_job", job: makeJob({ id: "unknown-job", updatedAt: 1001 }) },
			}),
		).not.toThrow();
	});

	test("drops stale and terminal-regressing job updates", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const starting = client.startSpeech({ sessionId: "s", messageId: "m" });
		const request = requests.find((candidate) => candidate.request.command === "start_speech");
		server.send({
			type: "response",
			id: request?.id ?? "missing",
			ok: true,
			result: { command: "start_speech", job: makeJob() },
		});
		const handle = await starting;
		const listener = vi.fn();
		handle.subscribe(listener);

		server.send({
			type: "event",
			event: { type: "speech_job", job: makeJob({ status: "generating", updatedAt: 1001 }) },
		});
		expect(handle.job.status).toBe("generating");

		// Older update is ignored.
		server.send({
			type: "event",
			event: { type: "speech_job", job: makeJob({ status: "queued", updatedAt: 1000 }) },
		});
		expect(handle.job.status).toBe("generating");
		expect(listener).toHaveBeenCalledTimes(1);

		// Terminal is irreversible: a later non-terminal update is ignored.
		server.send({
			type: "event",
			event: { type: "speech_job", job: makeJob({ status: "completed", updatedAt: 1002 }) },
		});
		expect(handle.job.status).toBe("completed");
		server.send({
			type: "event",
			event: { type: "speech_job", job: makeJob({ status: "streaming", updatedAt: 1003 }) },
		});
		expect(handle.job.status).toBe("completed");
		expect(listener).toHaveBeenCalledTimes(2);
	});

	test("stops routing events after a terminal job is deregistered", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const starting = client.startSpeech({ sessionId: "s", messageId: "m" });
		const request = requests.find((candidate) => candidate.request.command === "start_speech");
		server.send({
			type: "response",
			id: request?.id ?? "missing",
			ok: true,
			result: { command: "start_speech", job: makeJob() },
		});
		const handle = await starting;
		const listener = vi.fn();
		handle.subscribe(listener);

		server.send({
			type: "event",
			event: { type: "speech_job", job: makeJob({ status: "completed", updatedAt: 1001 }) },
		});
		expect(listener).toHaveBeenCalledTimes(1);
		server.send({
			type: "event",
			event: { type: "speech_job", job: makeJob({ status: "completed", updatedAt: 1002 }) },
		});
		expect(listener).toHaveBeenCalledTimes(1);
	});

	test("cancel sends cancel_speech and applies the resulting job", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const starting = client.startSpeech({ sessionId: "s", messageId: "m" });
		const startRequest = requests.find((candidate) => candidate.request.command === "start_speech");
		server.send({
			type: "response",
			id: startRequest?.id ?? "missing",
			ok: true,
			result: { command: "start_speech", job: makeJob({ status: "streaming", updatedAt: 1002 }) },
		});
		const handle = await starting;

		const cancelling = handle.cancel();
		const cancelRequest = requests.find((candidate) => candidate.request.command === "cancel_speech");
		expect(cancelRequest?.request).toMatchObject({ command: "cancel_speech", jobId: "job-1" });
		server.send({
			type: "response",
			id: cancelRequest?.id ?? "missing",
			ok: true,
			result: { command: "cancel_speech", job: makeJob({ status: "cancelled", updatedAt: 1003 }) },
		});

		const job = await cancelling;
		expect(job.status).toBe("cancelled");
		expect(handle.job.status).toBe("cancelled");
	});

	test("disconnect rejects pending requests and stops job delivery", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const starting = client.startSpeech({ sessionId: "s", messageId: "m" });
		const request = requests.find((candidate) => candidate.request.command === "start_speech");
		server.send({
			type: "response",
			id: request?.id ?? "missing",
			ok: true,
			result: { command: "start_speech", job: makeJob() },
		});
		const handle = await starting;
		const listener = vi.fn();
		handle.subscribe(listener);

		server.close();
		expect(client.connectionState).toBe("disconnected");
		server.send({
			type: "event",
			event: { type: "speech_job", job: makeJob({ status: "generating", updatedAt: 1001 }) },
		});
		expect(listener).not.toHaveBeenCalled();

		await expect(handle.cancel()).rejects.toMatchObject({ name: "PiDisconnectedError" });
	});

	test("startSpeech rejects after dispose", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		await client.dispose();
		await expect(client.startSpeech({ sessionId: "s", messageId: "m" })).rejects.toMatchObject({
			name: "PiClientDisposedError",
		});
	});
});

describe("openSpeechStream", () => {
	test("fetches the relative stream and parses audio metadata", async () => {
		const bytes = new Uint8Array([0, 0, 128, 63]);
		const { fetch, calls } = makeFetchMock(() => makeResponse({ headers: audioHeaders(), body: bytes }));

		const stream = await openSpeechStream({ baseUrl: BASE_URL, streamPath: STREAM_PATH, fetch });

		expect(stream.format).toEqual({ encoding: "pcm_f32le", sampleRate: 24000, channels: 1 });
		const reader = stream.body.getReader();
		const { value } = await reader.read();
		expect([...(value ?? new Uint8Array(0))]).toEqual([0, 0, 128, 63]);
		expect(calls[0]?.url.pathname).toBe(STREAM_PATH);
		expect(calls[0]?.init?.method).toBe("GET");
	});

	test("sends the bearer token only in the Authorization header", async () => {
		const { fetch, calls } = makeFetchMock(() => makeResponse({ headers: audioHeaders(), body: new Uint8Array(4) }));

		await openSpeechStream({ baseUrl: BASE_URL, streamPath: STREAM_PATH, token: "secret", fetch });

		expect(calls[0]?.init?.headers).toEqual({ Authorization: "Bearer secret" });
	});

	test("rejects an absolute or cross-origin stream path", async () => {
		const { fetch } = makeFetchMock(() => makeResponse({ headers: audioHeaders(), body: new Uint8Array(4) }));
		await expect(
			openSpeechStream({ baseUrl: BASE_URL, streamPath: "http://evil.example/stream", fetch }),
		).rejects.toMatchObject({ name: "SpeechStreamError", code: "invalid_stream_path" });
		await expect(
			openSpeechStream({ baseUrl: BASE_URL, streamPath: "//evil.example/stream", fetch }),
		).rejects.toMatchObject({ name: "SpeechStreamError", code: "invalid_stream_path" });
		await expect(openSpeechStream({ baseUrl: BASE_URL, streamPath: "relative/path", fetch })).rejects.toMatchObject({
			name: "SpeechStreamError",
			code: "invalid_stream_path",
		});
	});

	test("surfaces HTTP errors with status and the server error code", async () => {
		const errorBody = new TextEncoder().encode(
			JSON.stringify({ error: { code: "speech_stream_claimed", message: "Already claimed" } }),
		);
		const { fetch } = makeFetchMock(() => makeResponse({ status: 409, body: errorBody }));

		await expect(openSpeechStream({ baseUrl: BASE_URL, streamPath: STREAM_PATH, fetch })).rejects.toMatchObject({
			name: "SpeechStreamError",
			code: "http_error",
			status: 409,
			serverCode: "speech_stream_claimed",
		});
	});

	test("rejects invalid audio metadata", async () => {
		const wrongEncoding = audioHeaders();
		wrongEncoding.set("X-Pi-Audio-Encoding", "wav");
		const { fetch } = makeFetchMock(() => makeResponse({ headers: wrongEncoding, body: new Uint8Array(4) }));
		await expect(openSpeechStream({ baseUrl: BASE_URL, streamPath: STREAM_PATH, fetch })).rejects.toMatchObject({
			code: "invalid_audio_format",
		});

		const missingHeaders = new FakeHeaders();
		missingHeaders.set("Content-Type", "application/vnd.pi.pcm");
		missingHeaders.set("X-Pi-Audio-Encoding", "pcm_f32le");
		const { fetch: fetch2 } = makeFetchMock(() => makeResponse({ headers: missingHeaders, body: new Uint8Array(4) }));
		await expect(
			openSpeechStream({ baseUrl: BASE_URL, streamPath: STREAM_PATH, fetch: fetch2 }),
		).rejects.toMatchObject({
			code: "invalid_audio_format",
		});
	});

	test("rejects a mismatched content type", async () => {
		const headers = audioHeaders();
		headers.set("Content-Type", "text/html");
		const { fetch } = makeFetchMock(() => makeResponse({ headers, body: new Uint8Array(4) }));
		await expect(openSpeechStream({ baseUrl: BASE_URL, streamPath: STREAM_PATH, fetch })).rejects.toMatchObject({
			code: "invalid_audio_format",
		});
	});

	test("classifies network failures as network_error", async () => {
		const { fetch } = makeFetchMock(() => {
			throw new Error("socket hang up");
		});
		await expect(openSpeechStream({ baseUrl: BASE_URL, streamPath: STREAM_PATH, fetch })).rejects.toMatchObject({
			name: "SpeechStreamError",
			code: "network_error",
		});
	});
});

describe("openLiveSpeechStream", () => {
	const LIVE_STREAM_PATH = "/api/pi/v4/live-speech/job-1/stream";

	test("returns null on a 204 (no speakable text) without throwing", async () => {
		const { fetch } = makeFetchMock(() => makeResponse({ status: 204 }));
		const result = await openLiveSpeechStream({ baseUrl: BASE_URL, streamPath: LIVE_STREAM_PATH, fetch });
		expect(result).toBeNull();
	});

	test("parses audio metadata on a 200 response", async () => {
		const bytes = new Uint8Array([0, 0, 128, 63]);
		const { fetch } = makeFetchMock(() => makeResponse({ headers: audioHeaders(), body: bytes }));
		const result = await openLiveSpeechStream({ baseUrl: BASE_URL, streamPath: LIVE_STREAM_PATH, fetch });
		expect(result).not.toBeNull();
		if (result) {
			expect(result.format).toEqual({ encoding: "pcm_f32le", sampleRate: 24000, channels: 1 });
			const reader = result.body.getReader();
			const { value } = await reader.read();
			expect([...(value ?? new Uint8Array(0))]).toEqual([0, 0, 128, 63]);
		}
	});

	test("sends the bearer token only in the Authorization header", async () => {
		const { fetch, calls } = makeFetchMock(() => makeResponse({ status: 204 }));
		await openLiveSpeechStream({ baseUrl: BASE_URL, streamPath: LIVE_STREAM_PATH, token: "secret", fetch });
		expect(calls[0]?.init?.headers).toEqual({ Authorization: "Bearer secret" });
	});

	test("rejects a cross-origin stream path", async () => {
		const { fetch } = makeFetchMock(() => makeResponse({ status: 204 }));
		await expect(
			openLiveSpeechStream({ baseUrl: BASE_URL, streamPath: "http://evil.example/stream", fetch }),
		).rejects.toMatchObject({ code: "invalid_stream_path" });
	});

	test("classifies a 410 gone as http_error", async () => {
		const { fetch } = makeFetchMock(() => makeResponse({ status: 410 }));
		await expect(
			openLiveSpeechStream({ baseUrl: BASE_URL, streamPath: LIVE_STREAM_PATH, fetch }),
		).rejects.toMatchObject({ name: "SpeechStreamError", code: "http_error", status: 410 });
	});

	test("classifies network failures as network_error", async () => {
		const { fetch } = makeFetchMock(() => {
			throw new Error("socket hang up");
		});
		await expect(
			openLiveSpeechStream({ baseUrl: BASE_URL, streamPath: LIVE_STREAM_PATH, fetch }),
		).rejects.toMatchObject({ name: "SpeechStreamError", code: "network_error" });
	});
});

describe("PiClient.liveSpeech (V9)", () => {
	test("prompt with speech attaches the option; result.liveSpeech auto-registers a handle", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const initial = sessionSnapshot("session-1");
		const attaching = client.attachSession("session-1");
		const attachRequest = requests.find((candidate) => candidate.request.command === "attach");
		if (!attachRequest) throw new Error("missing attach request");
		server.send({
			type: "response",
			id: attachRequest.id,
			ok: true,
			result: { command: "attach", session: initial },
		});
		const handle = await attaching;

		const prompting = handle.prompt("hi", { speech: { mode: "live" } });
		const promptRequest = requests.find((candidate) => candidate.request.command === "prompt");
		if (!promptRequest) throw new Error("missing prompt request");
		expect(promptRequest.request).toMatchObject({ command: "prompt", speech: { mode: "live" } });
		const updated = sessionSnapshot("session-1", { revision: 2, phase: "turn" });
		const liveJob: LiveSpeechJob = {
			id: "live-1",
			sessionId: "session-1",
			voiceProfileId: "default",
			status: "waiting_for_text",
			streamPath: "/api/pi/v4/live-speech/live-1/stream",
			createdAt: 1,
			updatedAt: 1,
			progress: { committedUtterances: 0, completedUtterances: 0, pendingCharacters: 0 },
		};
		server.send({
			type: "response",
			id: promptRequest.id,
			ok: true,
			result: { command: "prompt", session: updated, liveSpeech: liveJob },
		});
		const result = await prompting;
		if (result.command !== "prompt") throw new Error("unexpected prompt result shape");
		expect(result.liveSpeech?.id).toBe("live-1");

		// Auto-registered handle is reachable via getLiveSpeechHandle.
		const liveHandle = client.getLiveSpeechHandle("live-1");
		expect(liveHandle).toBeDefined();
		const listener = vi.fn();
		liveHandle?.subscribe(listener);
		server.send({
			type: "event",
			event: {
				type: "live_speech_job",
				job: { ...liveJob, status: "streaming", updatedAt: 2 },
			},
		});
		expect(listener).toHaveBeenCalledOnce();
		expect(liveHandle?.job.status).toBe("streaming");
	});

	test("cancelLiveSpeech sends the cancel command and is idempotent", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const cancel = client.cancelLiveSpeech("live-1");
		const first = requests.find((candidate) => candidate.request.command === "cancel_live_speech");
		expect(first?.request).toEqual({ command: "cancel_live_speech", jobId: "live-1" });
		server.send({
			type: "response",
			id: first?.id ?? "missing",
			ok: true,
			result: {
				command: "cancel_live_speech",
				job: {
					id: "live-1",
					sessionId: "session-1",
					voiceProfileId: "default",
					status: "cancelled",
					streamPath: "/api/pi/v4/live-speech/live-1/stream",
					createdAt: 1,
					updatedAt: 2,
					progress: { committedUtterances: 0, completedUtterances: 0, pendingCharacters: 0 },
				},
			},
		});
		await expect(cancel).resolves.toBeUndefined();

		// Second call dispatches another request and resolves cleanly.
		const second = client.cancelLiveSpeech("live-1");
		const secondRequest = requests.filter((candidate) => candidate.request.command === "cancel_live_speech").at(-1);
		if (secondRequest) {
			server.send({
				type: "response",
				id: secondRequest.id,
				ok: true,
				result: {
					command: "cancel_live_speech",
					job: {
						id: "live-1",
						sessionId: "session-1",
						voiceProfileId: "default",
						status: "cancelled",
						streamPath: "/api/pi/v4/live-speech/live-1/stream",
						createdAt: 1,
						updatedAt: 3,
						progress: { committedUtterances: 0, completedUtterances: 0, pendingCharacters: 0 },
					},
				},
			});
		}
		await expect(second).resolves.toBeUndefined();
	});
});
