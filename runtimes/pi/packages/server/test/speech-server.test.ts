import { request as httpRequest, type IncomingMessage } from "node:http";
import type { ServerMessage, SpeechJob, TranscriptItem } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import type { PiServer } from "../src/index.ts";
import { connectWebSocketTestClient, type ProtocolTestClient, TestSessionBackend } from "../src/testing/index.ts";
import { createWebSocketServer } from "../src/transports/websocket/index.ts";
import type { HttpRequestHandler } from "../src/types.ts";
import { SpeechManager } from "../src/voice/speech-manager.ts";
import type {
	StreamSynthesisRequest,
	VoiceAudioFormat,
	VoiceServiceClient,
	VoiceStreamResult,
} from "../src/voice/types.ts";
import { VoiceUpstreamError } from "../src/voice/types.ts";
import { createSpeechHttpHandler } from "../src/web/speech.ts";

const TOKEN = "web-secret";
const FORMAT: VoiceAudioFormat = { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 };

class FakeVoiceClient implements VoiceServiceClient {
	readonly requests: StreamSynthesisRequest[] = [];
	readonly aborted = new Set<AbortSignal>();
	chunks: Uint8Array[] = [];
	errorBeforeFirstByte?: Error;
	errorMidStream?: Error;
	/** After delivering chunks, never close or error until aborted. */
	hang = false;

	async openStream(request: StreamSynthesisRequest, signal: AbortSignal): Promise<VoiceStreamResult> {
		this.requests.push(request);
		if (signal.aborted) this.aborted.add(signal);
		signal.addEventListener("abort", () => this.aborted.add(signal), { once: true });
		if (this.errorBeforeFirstByte) throw this.errorBeforeFirstByte;
		const chunks = [...this.chunks];
		const midError = this.errorMidStream;
		const hang = this.hang;
		let index = 0;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				// A hanging stream must still observe abort so the handler can
				// propagate cancellation to the browser response.
				signal.addEventListener(
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
			pull(controller) {
				if (signal.aborted) {
					controller.error(new DOMException("Aborted", "AbortError"));
					return;
				}
				if (index < chunks.length) {
					controller.enqueue(chunks[index++]!);
					return;
				}
				if (midError) {
					controller.error(midError);
					return;
				}
				if (hang) return;
				controller.close();
			},
		});
		return { format: FORMAT, body };
	}
}

function completeAssistant(messageId: string, text: string): TranscriptItem {
	return {
		id: messageId,
		role: "assistant",
		status: "complete",
		content: [{ type: "text", text }],
		model: { provider: "test", id: "model" },
		stopReason: "stop",
		timestamp: 1,
	};
}

interface Harness {
	server: PiServer;
	backend: TestSessionBackend;
	speech: SpeechManager;
	fakeVoice: FakeVoiceClient;
	url: string;
	httpBase: string;
}

const servers = new Set<PiServer>();
const clients = new Set<ProtocolTestClient>();

async function makeHarness(options: { voice?: boolean; chunks?: Uint8Array[] } = {}): Promise<Harness> {
	const backend = new TestSessionBackend();
	backend.seed("session-1");
	backend.seedTranscript("session-1", [completeAssistant("assistant-1", "你好，世界")]);

	const fakeVoice = new FakeVoiceClient();
	if (options.chunks) fakeVoice.chunks = options.chunks;

	let speech: SpeechManager | undefined;
	let httpHandler: HttpRequestHandler | undefined;
	if (options.voice !== false) {
		speech = new SpeechManager({
			voiceClient: fakeVoice,
			profiles: [{ id: "default", provider: "qwen3-tts", language: "Chinese", speaker: "Vivian" }],
			defaultProfileId: "default",
		});
		httpHandler = createSpeechHttpHandler({
			getSpeechManager: () => speech,
			webToken: TOKEN,
			allowedOrigins: ["http://127.0.0.1:*"],
			allowedHosts: ["127.0.0.1", "localhost"],
		});
	}

	const server = createWebSocketServer(backend, {
		port: 0,
		httpHandler,
		...(speech ? { speech } : {}),
	});
	servers.add(server);
	await server.start();
	const address = server.addresses[0]!;
	const port = Number(address.slice(address.lastIndexOf(":") + 1));
	return {
		server,
		backend,
		speech: speech as SpeechManager,
		fakeVoice,
		url: `ws://127.0.0.1:${port}/api/pi/v1/ws`,
		httpBase: `http://127.0.0.1:${port}`,
	};
}

async function connect(url: string): Promise<ProtocolTestClient> {
	const client = await connectWebSocketTestClient(url);
	clients.add(client);
	await client.hello();
	return client;
}

async function attachAndStart(client: ProtocolTestClient) {
	const attached = await client.request({ command: "attach", sessionId: "session-1" });
	expect(attached.ok).toBe(true);
	const started = await client.request({
		command: "start_speech",
		sessionId: "session-1",
		messageId: "assistant-1",
	});
	expect(started.ok).toBe(true);
	if (!started.ok) throw new Error(`start_speech failed: ${started.error.code}`);
	return (started.result as { job: SpeechJob }).job;
}

function isJobEvent(message: ServerMessage, status: SpeechJob["status"]): boolean {
	return message.type === "event" && message.event.type === "speech_job" && message.event.job.status === status;
}

function jobOf(message: ServerMessage): SpeechJob {
	if (message.type !== "event" || message.event.type !== "speech_job") {
		throw new Error("Expected a speech_job event");
	}
	return message.event.job;
}

function nextJobEvent(client: ProtocolTestClient, status: SpeechJob["status"]): Promise<ServerMessage> {
	return client.next((message) => isJobEvent(message, status));
}

interface StreamResult {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
}

/** GET a PCM stream; resolves on any terminal response state so truncated streams don't hang. */
function streamCall(base: string, path: string, token: string): Promise<StreamResult> {
	return new Promise((resolve) => {
		const url = new URL(path, base);
		const req = httpRequest(
			url,
			{
				method: "GET",
				headers: {
					host: url.host,
					origin: "http://127.0.0.1:5173",
					authorization: `Bearer ${token}`,
				},
			},
			(res: IncomingMessage) => {
				const headers: Record<string, string> = {};
				for (const [key, value] of Object.entries(res.headers)) headers[key] = String(value);
				const chunks: Buffer[] = [];
				let settled = false;
				const done = () => {
					if (settled) return;
					settled = true;
					resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
				};
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", done);
				res.on("aborted", done);
				res.on("error", done);
			},
		);
		req.on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
		req.end();
	});
}

/** Raw HTTP call for JSON error assertions. */
function httpCall(
	base: string,
	options: { method: string; path: string; headers?: Record<string, string> },
): Promise<{ status: number; body: any }> {
	return new Promise((resolve, reject) => {
		const url = new URL(options.path, base);
		const req = httpRequest(
			url,
			{
				method: options.method,
				headers: { host: url.host, origin: "http://127.0.0.1:5173", ...options.headers },
			},
			(res: IncomingMessage) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf-8");
					let body: any;
					try {
						body = raw ? JSON.parse(raw) : undefined;
					} catch {
						body = raw;
					}
					resolve({ status: res.statusCode ?? 0, body });
				});
			},
		);
		req.on("error", reject);
		req.end();
	});
}

afterEach(async () => {
	await Promise.all([...clients].map((client) => client.close()));
	clients.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
});

describe("speech end-to-end over WebSocket + HTTP", () => {
	test("starts a job, streams PCM, and emits generating/streaming/completed events", async () => {
		const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const { url, httpBase, fakeVoice } = await makeHarness({ chunks: [pcm.subarray(0, 3), pcm.subarray(3)] });
		const client = await connect(url);
		const job = await attachAndStart(client);
		expect(job.status).toBe("queued");
		expect(job.streamPath).toBe(`/api/pi/v3/speech/${job.id}/stream`);

		const generating = nextJobEvent(client, "generating");
		const streaming = nextJobEvent(client, "streaming");
		const completed = nextJobEvent(client, "completed");
		const streamPromise = streamCall(httpBase, job.streamPath, TOKEN);

		const [gen, str, stream, comp] = await Promise.all([generating, streaming, streamPromise, completed]);
		expect(jobOf(gen).status).toBe("generating");
		expect(jobOf(str).status).toBe("streaming");
		expect(jobOf(str).audio).toEqual(FORMAT);
		expect(jobOf(comp).status).toBe("completed");

		expect(stream.status).toBe(200);
		expect(stream.headers["content-type"]).toBe("application/vnd.pi.pcm");
		expect(stream.headers["cache-control"]).toBe("no-store");
		expect(stream.headers["x-pi-audio-sample-rate"]).toBe("24000");
		expect(stream.headers["x-pi-audio-channels"]).toBe("1");
		expect(stream.headers["x-pi-audio-encoding"]).toBe("pcm_f32le");
		expect(stream.headers["x-pi-speech-job-id"]).toBe(job.id);
		expect(stream.headers["access-control-expose-headers"]).toContain("X-Pi-Audio-Sample-Rate");
		// Arbitrary upstream chunk boundaries are forwarded verbatim.
		expect(stream.body).toEqual(Buffer.from(pcm));
		expect(fakeVoice.requests[0]).toMatchObject({ text: "你好，世界" });
	});

	test("voice capability appears in the server snapshot", async () => {
		const { url } = await makeHarness();
		const client = await connect(url);
		const hello = client.messages[0];
		expect(hello?.type).toBe("hello");
		if (hello?.type !== "hello") return;
		expect(hello.snapshot.voice).toEqual({
			available: true,
			live: false,
			defaultProfile: "default",
			profiles: [{ id: "default" }],
		});
	});
});

describe("speech HTTP auth and routing", () => {
	test("rejects a missing bearer token with 401", async () => {
		const { httpBase, url } = await makeHarness();
		const client = await connect(url);
		const job = await attachAndStart(client);
		const result = await httpCall(httpBase, { method: "GET", path: job.streamPath });
		expect(result.status).toBe(401);
		expect(result.body.error.code).toBe("unauthorized");
	});

	test("rejects a wrong bearer token with 401", async () => {
		const { httpBase, url } = await makeHarness();
		const client = await connect(url);
		const job = await attachAndStart(client);
		const result = await httpCall(httpBase, {
			method: "GET",
			path: job.streamPath,
			headers: { authorization: "Bearer wrong" },
		});
		expect(result.status).toBe(401);
	});

	test("serves an OPTIONS preflight with 204", async () => {
		const { httpBase, url } = await makeHarness();
		const client = await connect(url);
		const job = await attachAndStart(client);
		const result = await httpCall(httpBase, { method: "OPTIONS", path: job.streamPath });
		expect(result.status).toBe(204);
	});

	test("rejects a non-GET method with 405", async () => {
		const { httpBase, url } = await makeHarness();
		const client = await connect(url);
		const job = await attachAndStart(client);
		const result = await httpCall(httpBase, {
			method: "POST",
			path: job.streamPath,
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(result.status).toBe(405);
	});

	test("returns 404 for an unknown job id", async () => {
		const { httpBase } = await makeHarness();
		const result = await streamCall(httpBase, "/api/pi/v3/speech/unknown/stream", TOKEN);
		expect(result.status).toBe(404);
		expect(JSON.parse(result.body.toString())).toEqual({
			error: { code: "not_found", message: "Speech job not found" },
		});
	});
});

describe("speech claim and lifecycle over HTTP", () => {
	test("a second GET on the same stream returns 409 claimed", async () => {
		const pcm = new Uint8Array([1, 2, 3, 4]);
		const { httpBase, url } = await makeHarness({ chunks: [pcm] });
		const client = await connect(url);
		const job = await attachAndStart(client);
		const first = await streamCall(httpBase, job.streamPath, TOKEN);
		expect(first.status).toBe(200);
		const second = await streamCall(httpBase, job.streamPath, TOKEN);
		expect(second.status).toBe(409);
		expect(JSON.parse(second.body.toString()).error.code).toBe("speech_stream_claimed");
	});

	test("an unclaimed job that expired returns 410", async () => {
		const { httpBase, url, speech } = await makeHarness();
		const client = await connect(url);
		const job = await attachAndStart(client);
		(speech as unknown as { expireUnclaimed(id: string): void }).expireUnclaimed(job.id);
		const result = await streamCall(httpBase, job.streamPath, TOKEN);
		expect(result.status).toBe(410);
		expect(JSON.parse(result.body.toString()).error.code).toBe("speech_stream_expired");
	});

	test("upstream failure before the first byte returns 502 and fails the job", async () => {
		const { httpBase, url, fakeVoice } = await makeHarness();
		fakeVoice.errorBeforeFirstByte = new VoiceUpstreamError("down");
		const client = await connect(url);
		const job = await attachAndStart(client);
		const failed = nextJobEvent(client, "failed");
		const result = await streamCall(httpBase, job.streamPath, TOKEN);
		expect(result.status).toBe(502);
		expect(JSON.parse(result.body.toString()).error.code).toBe("voice_unavailable");
		const event = await failed;
		expect(jobOf(event).error?.code).toBe("voice_unavailable");
	});

	test("upstream failure mid-stream closes the response and fails the job", async () => {
		const { httpBase, url, fakeVoice } = await makeHarness({ chunks: [new Uint8Array([1, 2, 3, 4])] });
		fakeVoice.errorMidStream = new Error("mid-stream boom");
		const client = await connect(url);
		const job = await attachAndStart(client);
		const failed = nextJobEvent(client, "failed");
		const streamPromise = streamCall(httpBase, job.streamPath, TOKEN);
		const stream = await streamPromise;
		// The response may be reset before the first byte flushes; the observable
		// contract is the failed job event with a safe generation error.
		expect([0, 200]).toContain(stream.status);
		const event = await failed;
		expect(jobOf(event).error?.code).toBe("speech_generation_failed");
	});
});

describe("speech cancel and resource cleanup", () => {
	test("cancel_speech cancels a streaming job and aborts the upstream request", async () => {
		const { httpBase, url, fakeVoice } = await makeHarness({ chunks: [new Uint8Array([1, 2, 3, 4])] });
		fakeVoice.hang = true;
		const client = await connect(url);
		const job = await attachAndStart(client);
		const streaming = nextJobEvent(client, "streaming");
		const streamPromise = streamCall(httpBase, job.streamPath, TOKEN);
		await streaming;
		const cancelled = nextJobEvent(client, "cancelled");
		const cancel = await client.request({ command: "cancel_speech", jobId: job.id });
		expect(cancel.ok).toBe(true);
		if (cancel.ok) expect((cancel.result as { job: SpeechJob }).job.status).toBe("cancelled");
		const event = await cancelled;
		expect(jobOf(event).status).toBe("cancelled");
		await streamPromise;
		expect(fakeVoice.aborted.size).toBe(1);
	});

	test("disconnecting the owner cancels its active job", async () => {
		const { httpBase, url, fakeVoice } = await makeHarness({ chunks: [new Uint8Array([1, 2, 3, 4])] });
		fakeVoice.hang = true;
		const client = await connect(url);
		const job = await attachAndStart(client);
		const streaming = nextJobEvent(client, "streaming");
		const streamPromise = streamCall(httpBase, job.streamPath, TOKEN);
		await streaming;
		await client.close();
		await streamPromise;
		expect(fakeVoice.aborted.size).toBe(1);
	});

	test("server shutdown aborts active streams", async () => {
		const { httpBase, url, fakeVoice, server } = await makeHarness({ chunks: [new Uint8Array([1, 2, 3, 4])] });
		fakeVoice.hang = true;
		const client = await connect(url);
		const job = await attachAndStart(client);
		const streaming = nextJobEvent(client, "streaming");
		const streamPromise = streamCall(httpBase, job.streamPath, TOKEN);
		await streaming;
		await server.close();
		await streamPromise;
		expect(fakeVoice.aborted.size).toBe(1);
	});
});

describe("speech disabled", () => {
	test("start_speech returns a stable unavailable error and chat still works", async () => {
		const { url, backend } = await makeHarness({ voice: false });
		const client = await connect(url);
		const attached = await client.request({ command: "attach", sessionId: "session-1" });
		expect(attached.ok).toBe(true);
		const started = await client.request({
			command: "start_speech",
			sessionId: "session-1",
			messageId: "assistant-1",
		});
		expect(started.ok).toBe(false);
		if (!started.ok) expect(started.error.code).toBe("invalid_state");
		const listed = await client.request({ command: "list" });
		expect(listed.ok).toBe(true);
		expect(backend.sessions.size).toBeGreaterThan(0);
	});
});
