import { request as httpRequest, type IncomingMessage } from "node:http";
import type { LiveSpeechJob, ServerMessage, TranscriptProgress } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import type { PiServer } from "../src/index.ts";
import { connectWebSocketTestClient, type ProtocolTestClient, TestSessionBackend } from "../src/testing/index.ts";
import { createWebSocketServer } from "../src/transports/websocket/index.ts";
import { LiveSpeechManager } from "../src/voice/live/live-speech-manager.ts";
import { SpeechManager } from "../src/voice/speech-manager.ts";
import type {
	StreamSynthesisRequest,
	VoiceAudioFormat,
	VoiceProfile,
	VoiceServiceClient,
	VoiceStreamResult,
} from "../src/voice/types.ts";
import { createLiveSpeechHttpHandler } from "../src/web/live-speech.ts";

const TOKEN = "web-secret";
const FORMAT: VoiceAudioFormat = { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 };
const PROFILES: VoiceProfile[] = [{ id: "default", provider: "qwen3-tts", language: "Chinese", speaker: "Vivian" }];

/** Auto-streaming Voice Service fake: utterance N yields the 4-byte chunk [N,N,N,N] then closes. */
class FakeVoiceClient implements VoiceServiceClient {
	readonly requests: StreamSynthesisRequest[] = [];
	readonly aborted = new Set<AbortSignal>();
	errorBeforeFirstByte?: Error;

	async openStream(request: StreamSynthesisRequest, signal: AbortSignal): Promise<VoiceStreamResult> {
		this.requests.push(request);
		signal.addEventListener("abort", () => this.aborted.add(signal), { once: true });
		if (this.errorBeforeFirstByte) throw this.errorBeforeFirstByte;
		const byte = this.requests.length;
		let emitted = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!emitted) {
					emitted = true;
					controller.enqueue(new Uint8Array([byte, byte, byte, byte]));
					return;
				}
				controller.close();
			},
		});
		return { format: FORMAT, body };
	}
}

interface Harness {
	server: PiServer;
	backend: TestSessionBackend;
	fakeVoice: FakeVoiceClient;
	url: string;
	httpBase: string;
}

const servers = new Set<PiServer>();
const clients = new Set<ProtocolTestClient>();

async function makeHarness(): Promise<Harness> {
	const backend = new TestSessionBackend();
	backend.seed("session-1");
	const fakeVoice = new FakeVoiceClient();
	const speech = new SpeechManager({
		voiceClient: fakeVoice,
		profiles: PROFILES,
		defaultProfileId: "default",
		live: true,
	});
	const liveSpeech = new LiveSpeechManager({
		voiceClient: fakeVoice,
		profiles: PROFILES,
		defaultProfileId: "default",
	});
	const httpHandler = createLiveSpeechHttpHandler({
		getLiveSpeechManager: () => liveSpeech,
		webToken: TOKEN,
		allowedOrigins: ["http://127.0.0.1:*"],
		allowedHosts: ["127.0.0.1", "localhost"],
	});
	const server = createWebSocketServer(backend, { port: 0, httpHandler, speech, liveSpeech });
	servers.add(server);
	await server.start();
	const address = server.addresses[0]!;
	const port = Number(address.slice(address.lastIndexOf(":") + 1));
	return {
		server,
		backend,
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function isJobEvent(message: ServerMessage): boolean {
	return message.type === "event" && message.event.type === "live_speech_job";
}

function jobOf(message: ServerMessage): LiveSpeechJob {
	if (message.type !== "event" || message.event.type !== "live_speech_job") {
		throw new Error("Expected a live_speech_job event");
	}
	return message.event.job;
}

function assistantStarted(timestamp = Date.now()): TranscriptProgress {
	return {
		type: "item_started",
		item: {
			id: "assistant-1",
			role: "assistant",
			status: "streaming",
			content: [{ type: "text", text: "" }],
			model: { provider: "test", id: "model" },
			timestamp,
		},
	} as TranscriptProgress;
}

function textDelta(delta: string): TranscriptProgress {
	return { type: "assistant_delta", messageId: "assistant-1", contentIndex: 0, kind: "text", delta };
}

function assistantFinished(status: "complete" | "aborted"): TranscriptProgress {
	return {
		type: "item_finished",
		item: {
			id: "assistant-1",
			role: "assistant",
			status,
			content: [{ type: "text", text: "done" }],
			model: { provider: "test", id: "model" },
			stopReason: status === "complete" ? "stop" : "aborted",
			timestamp: 1_000,
		},
	} as TranscriptProgress;
}

interface StreamResult {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
}

/** GET a live stream; resolves on any terminal response state. */
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

describe("live speech end-to-end over WebSocket + HTTP", () => {
	test("streams three utterances into one PCM response and reaches completed", async () => {
		const { url, httpBase, backend, fakeVoice } = await makeHarness();
		const client = await connect(url);
		await client.request({ command: "attach", sessionId: "session-1" });

		const promptP = client.request({
			command: "prompt",
			sessionId: "session-1",
			text: "hi",
			speech: { mode: "live" },
		});
		const runtime = backend.latestRuntime("session-1");
		await waitFor(() => runtime.promptInputs.length === 1);

		// The listener was registered before prompt ran; drive the turn.
		runtime.emitProgress(assistantStarted());
		runtime.emitProgress(textDelta("第一句足够长，应当提交朗读。"));
		runtime.emitProgress(textDelta("第二句也足够长，应当提交朗读。"));
		runtime.emitProgress(textDelta("第三句足够长，应当提交朗读。"));

		// The bind milestone publishes the job with the stream path.
		const jobMessage = await client.next(isJobEvent);
		const job = jobOf(jobMessage);
		expect(job.streamPath).toMatch(/^\/api\/pi\/v4\/live-speech\//);

		const streamP = streamCall(httpBase, job.streamPath, TOKEN);
		runtime.finishPrompt();
		runtime.emitProgress(assistantFinished("complete"));
		const [stream, promptResult] = await Promise.all([streamP, promptP]);

		// Prompt result carries the live job handle.
		if (!promptResult.ok) throw new Error("prompt failed");
		const liveSpeech = (promptResult.result as { liveSpeech?: LiveSpeechJob }).liveSpeech;
		expect(liveSpeech).toBeDefined();
		expect(liveSpeech!.sessionId).toBe("session-1");

		// 3 utterances → 3 upstream opens → 1 response with per-utterance bytes.
		expect(fakeVoice.requests.length).toBe(3);
		expect(stream.status).toBe(200);
		expect(stream.headers["content-type"]).toBe("application/vnd.pi.pcm");
		expect(stream.headers["x-pi-audio-encoding"]).toBe("pcm_f32le");
		expect(stream.headers["x-pi-audio-sample-rate"]).toBe("24000");
		expect(stream.headers["x-pi-live-speech-job-id"]).toBe(job.id);
		expect(Array.from(stream.body)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);

		// Terminal status reached on the job events.
		await waitFor(() => client.messages.some((m) => isJobEvent(m) && jobOf(m).status === "completed"));
	});

	test("advertises voice.live=true in the hello snapshot", async () => {
		const { url } = await makeHarness();
		const client = await connect(url);
		const hello = client.messages[0];
		expect(hello?.type).toBe("hello");
		if (hello?.type !== "hello") return;
		expect(hello.snapshot.voice).toEqual({
			available: true,
			live: true,
			defaultProfile: "default",
			profiles: [{ id: "default" }],
		});
	});

	test("rejects an unauthenticated stream with 401", async () => {
		const { url, httpBase, backend } = await makeHarness();
		const client = await connect(url);
		await client.request({ command: "attach", sessionId: "session-1" });
		const promptP = client.request({
			command: "prompt",
			sessionId: "session-1",
			text: "hi",
			speech: { mode: "live" },
		});
		const runtime = backend.latestRuntime("session-1");
		await waitFor(() => runtime.promptInputs.length === 1);
		runtime.emitProgress(assistantStarted());
		const jobMessage = await client.next(isJobEvent);
		const job = jobOf(jobMessage);
		const result = await httpCall(httpBase, { method: "GET", path: job.streamPath });
		expect(result.status).toBe(401);
		expect(result.body.error.code).toBe("unauthorized");
		runtime.finishPrompt();
		await promptP;
	});

	test("returns 404 for an unknown job and 409 for a double claim", async () => {
		const { url, httpBase, backend } = await makeHarness();
		const client = await connect(url);
		await client.request({ command: "attach", sessionId: "session-1" });
		expect(
			(
				await httpCall(httpBase, {
					method: "GET",
					path: "/api/pi/v4/live-speech/unknown/stream",
					headers: { authorization: `Bearer ${TOKEN}` },
				})
			).status,
		).toBe(404);

		const promptP = client.request({
			command: "prompt",
			sessionId: "session-1",
			text: "hi",
			speech: { mode: "live" },
		});
		const runtime = backend.latestRuntime("session-1");
		await waitFor(() => runtime.promptInputs.length === 1);
		runtime.emitProgress(assistantStarted());
		runtime.emitProgress(textDelta("这是一段足够长的中文句子，超过最短长度。"));
		const jobMessage = await client.next(isJobEvent);
		const job = jobOf(jobMessage);
		// The first GET claims the stream and stays open until the turn ends.
		const first = streamCall(httpBase, job.streamPath, TOKEN);
		const second = await httpCall(httpBase, {
			method: "GET",
			path: job.streamPath,
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(second.status).toBe(409);
		expect(second.body.error.code).toBe("live_speech_stream_claimed");
		runtime.finishPrompt();
		runtime.emitProgress(assistantFinished("complete"));
		const [firstResult] = await Promise.all([first, promptP]);
		expect(firstResult.status).toBe(200);
	});

	test("completes with 204 when the turn has no speakable text", async () => {
		const { url, httpBase, backend } = await makeHarness();
		const client = await connect(url);
		await client.request({ command: "attach", sessionId: "session-1" });
		const promptP = client.request({
			command: "prompt",
			sessionId: "session-1",
			text: "hi",
			speech: { mode: "live" },
		});
		const runtime = backend.latestRuntime("session-1");
		await waitFor(() => runtime.promptInputs.length === 1);
		runtime.emitProgress(assistantStarted());
		const jobMessage = await client.next(isJobEvent);
		const job = jobOf(jobMessage);
		const streamP = streamCall(httpBase, job.streamPath, TOKEN);
		runtime.finishPrompt();
		runtime.emitProgress(assistantFinished("complete"));
		const [stream] = await Promise.all([streamP, promptP]);
		expect(stream.status).toBe(204);
		expect(stream.body.length).toBe(0);
	});

	test("cancel_live_speech cancels the job while the Agent prompt still completes", async () => {
		const { url, backend } = await makeHarness();
		const client = await connect(url);
		await client.request({ command: "attach", sessionId: "session-1" });
		const promptP = client.request({
			command: "prompt",
			sessionId: "session-1",
			text: "hi",
			speech: { mode: "live" },
		});
		const runtime = backend.latestRuntime("session-1");
		await waitFor(() => runtime.promptInputs.length === 1);
		runtime.emitProgress(assistantStarted());
		runtime.emitProgress(textDelta("这是一段足够长的中文句子，超过最短长度。"));
		const jobMessage = await client.next(isJobEvent);
		const job = jobOf(jobMessage);
		const cancelled = await client.request({ command: "cancel_live_speech", jobId: job.id });
		if (!cancelled.ok) throw new Error("cancel_live_speech failed");
		const cancelledJob = (cancelled.result as { job: LiveSpeechJob }).job;
		expect(cancelledJob.status).toBe("cancelled");
		// The Agent prompt was not aborted; it completes normally.
		runtime.finishPrompt();
		const promptResult = await promptP;
		expect(promptResult.ok).toBe(true);
	});

	test("prompt without speech creates no live job", async () => {
		const { url, backend } = await makeHarness();
		const client = await connect(url);
		await client.request({ command: "attach", sessionId: "session-1" });
		const promptP = client.request({ command: "prompt", sessionId: "session-1", text: "hi" });
		const runtime = backend.latestRuntime("session-1");
		await waitFor(() => runtime.promptInputs.length === 1);
		runtime.finishPrompt();
		const result = await promptP;
		if (!result.ok) throw new Error("prompt failed");
		expect((result.result as { liveSpeech?: LiveSpeechJob }).liveSpeech).toBeUndefined();
	});
});
