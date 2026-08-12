import type { ServerResponse } from "node:http";
import type { LiveSpeechJob, TranscriptProgress } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import type { ConnectionState } from "../src/connection.ts";
import { TestSessionBackend, type TestSessionRuntime } from "../src/testing/index.ts";
import type { LiveSpeechManagerHost } from "../src/voice/live/live-speech-manager.ts";
import { LiveSpeechManager } from "../src/voice/live/live-speech-manager.ts";
import type {
	StreamSynthesisRequest,
	VoiceAudioFormat,
	VoiceProfile,
	VoiceServiceClient,
	VoiceStreamResult,
} from "../src/voice/types.ts";

const FORMAT: VoiceAudioFormat = { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 };
const PROFILE: VoiceProfile = { id: "default", provider: "qwen3-tts", language: "Chinese", speaker: "Vivian" };

/** Auto-streaming Voice Service fake: each utterance yields `chunks` then closes. */
class FakeVoiceClient implements VoiceServiceClient {
	readonly requests: StreamSynthesisRequest[] = [];
	readonly aborted = new Set<AbortSignal>();
	chunks: Uint8Array[] = [new Uint8Array([1, 2, 3, 4])];
	hang = false;
	errorBeforeFirstByte?: Error;
	errorMidStream?: Error;
	format: VoiceAudioFormat = FORMAT;
	/** Fail format validation on the Nth openStream (1-based) to simulate mismatch. */
	failFormatOn?: number;

	async openStream(request: StreamSynthesisRequest, signal: AbortSignal): Promise<VoiceStreamResult> {
		this.requests.push(request);
		if (signal.aborted) this.aborted.add(signal);
		signal.addEventListener("abort", () => this.aborted.add(signal), { once: true });
		if (this.errorBeforeFirstByte) throw this.errorBeforeFirstByte;
		if (this.failFormatOn !== undefined && this.requests.length === this.failFormatOn) {
			return {
				format: { ...this.format, sampleRate: this.format.sampleRate - 8000 },
				body: this.hangingBody(signal),
			};
		}
		const chunks = [...this.chunks];
		const midError = this.errorMidStream;
		const hang = this.hang;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (hang) return;
				if (midError) {
					controller.error(midError);
					return;
				}
				if (chunks.length > 0) {
					controller.enqueue(chunks.shift()!);
					return;
				}
				controller.close();
			},
			cancel() {
				// observed via the abort listener
			},
		});
		return { format: this.format, body };
	}

	private hangingBody(_signal: AbortSignal): ReadableStream<Uint8Array> {
		return new ReadableStream({ pull() {} });
	}
}

class FakeHost implements LiveSpeechManagerHost {
	readonly events: LiveSpeechJob[] = [];
	sendJobEvent(_connection: ConnectionState, job: LiveSpeechJob): void {
		this.events.push(job);
	}
	reportError(error: unknown): void {
		throw error instanceof Error ? error : new Error(String(error));
	}
}

function fakeConnection(id = "conn-1"): ConnectionState {
	return {
		id,
		connection: {} as ConnectionState["connection"],
		decoder: {} as ConnectionState["decoder"],
		sessionIds: new Set<string>(),
		stage: "ready",
		disconnected: false,
		handshakeComplete: true,
		handshakeTimeout: {} as NodeJS.Timeout,
	};
}

/** Minimal ServerResponse the PendingPcmSink writes to. */
class FakeResponse {
	statusCode = 0;
	headers: Record<string, string> = {};
	chunks: Buffer[] = [];
	destroyed = false;
	writableEnded = false;
	ended = false;
	private listeners = new Map<string, Set<() => void>>();

	writeHead(status: number, headers?: Record<string, string>): this {
		this.statusCode = status;
		if (headers) Object.assign(this.headers, headers);
		return this;
	}

	write(chunk: Uint8Array): boolean {
		this.chunks.push(Buffer.from(chunk));
		return true;
	}

	end(): this {
		this.ended = true;
		this.writableEnded = true;
		this.emit("finish");
		return this;
	}

	destroy(): void {
		this.destroyed = true;
		this.emit("close");
	}

	once(event: string, listener: () => void): this {
		const set = this.listeners.get(event) ?? new Set();
		set.add(listener);
		this.listeners.set(event, set);
		return this;
	}

	off(event: string, listener: () => void): this {
		this.listeners.get(event)?.delete(listener);
		return this;
	}

	emit(event: string): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
	}

	bytes(): Buffer {
		return Buffer.concat(this.chunks);
	}
}

interface Harness {
	manager: LiveSpeechManager;
	runtime: TestSessionRuntime;
	voice: FakeVoiceClient;
	host: FakeHost;
	connection: ConnectionState;
	response: FakeResponse;
	prepare: (overrides?: { voiceProfileId?: string }) => LiveSpeechJob;
	rollbackLast: () => void;
}

let sequence = 0;

async function makeHarness(options: { firstTextTimeoutMs?: number; claimTtlMs?: number } = {}): Promise<Harness> {
	const backend = new TestSessionBackend();
	backend.seed("session-1");
	const runtime = (await backend.openSession("session-1")) as TestSessionRuntime;
	const voice = new FakeVoiceClient();
	const host = new FakeHost();
	const manager = new LiveSpeechManager({
		voiceClient: voice,
		profiles: [PROFILE],
		defaultProfileId: "default",
		clock: () => 1_000,
		uuid: () => `job-${++sequence}`,
		...options,
	});
	manager.bind(host);
	const connection = fakeConnection();
	const response = new FakeResponse();
	let lastRollback: (() => void) | undefined;
	const prepare = (overrides: { voiceProfileId?: string } = {}): LiveSpeechJob => {
		const result = manager.prepare({
			connection,
			runtime,
			sessionId: "session-1",
			speech: { mode: "live", ...(overrides.voiceProfileId ? { voiceProfileId: overrides.voiceProfileId } : {}) },
			turnId: "turn-1",
		});
		lastRollback = result.rollback;
		return result.job;
	};
	return {
		manager,
		runtime,
		voice,
		host,
		connection,
		response,
		prepare,
		rollbackLast: () => lastRollback?.(),
	};
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function assistantStarted(timestamp = 1_000): TranscriptProgress {
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

function textDelta(
	messageId: string,
	delta: string,
	kind: "text" | "thinking" | "toolCall" = "text",
): TranscriptProgress {
	return { type: "assistant_delta", messageId, contentIndex: 0, kind, delta };
}

function assistantFinished(status: "complete" | "error" | "aborted"): TranscriptProgress {
	return {
		type: "item_finished",
		item: {
			id: "assistant-1",
			role: "assistant",
			status,
			content: [{ type: "text", text: "done" }],
			model: { provider: "test", id: "model" },
			stopReason: status === "complete" ? "stop" : status,
			timestamp: 1_000,
		},
	} as TranscriptProgress;
}

describe("LiveSpeechManager — prompt transaction", () => {
	test("prepare creates a waiting_for_text job with the v4 stream path", async () => {
		const h = await makeHarness();
		const job = h.prepare();
		expect(job.status).toBe("waiting_for_text");
		expect(job.sessionId).toBe("session-1");
		expect(job.voiceProfileId).toBe("default");
		expect(job.streamPath).toBe(`/api/pi/v4/live-speech/${job.id}/stream`);
		expect(job.progress).toEqual({ committedUtterances: 0, completedUtterances: 0, pendingCharacters: 0 });
	});

	test("prepare is atomic: two active jobs for one connection are rejected as busy", async () => {
		const h = await makeHarness();
		h.prepare();
		expect(() => h.prepare()).toThrow(/active live speech job/);
	});

	test("prepare rejects an unknown voice profile", async () => {
		const h = await makeHarness();
		expect(() => h.prepare({ voiceProfileId: "missing" })).toThrow(/Unknown voice profile/);
	});

	test("rollback drops the job with no client-visible event", async () => {
		const h = await makeHarness();
		const job = h.prepare();
		expect(h.manager.claimStream(job.id).status).toBe("ok");
		// Simulate a failed prompt: the session manager calls rollback.
		h.rollbackLast();
		expect(h.manager.claimStream(job.id).status).toBe("not_found");
		expect(h.host.events).toHaveLength(0);
	});
});

describe("LiveSpeechManager — binding and filtering", () => {
	test("registers the progress listener at prepare, so a synchronous first event is captured", async () => {
		const h = await makeHarness();
		const job = h.prepare();
		// The listener is live the moment prepare returns — emit before any prompt.
		h.runtime.emitProgress(assistantStarted());
		h.runtime.emitProgress(textDelta("assistant-1", "这是一段足够长的中文句子，超过最短长度。"));
		await tick();
		expect(h.voice.requests.length).toBe(1);
		expect(h.voice.requests[0]!.text).toBe("这是一段足够长的中文句子，超过最短长度。");
		expect(job.messageId).toBe("assistant-1");
		expect(job.turnId).toBe("turn-1");
		expect(job.status).toBe("generating");
	});

	test("ignores tool items and late cross-turn items until the current assistant item binds", async () => {
		const h = await makeHarness();
		h.prepare();
		h.runtime.emitProgress({
			type: "item_started",
			item: {
				id: "tool-1",
				role: "tool",
				toolCallId: "t1",
				toolName: "x",
				input: null,
				content: [],
				status: "running",
				timestamp: 1_000,
			},
		} as unknown as TranscriptProgress);
		h.runtime.emitProgress(assistantStarted(500)); // timestamp < createdAt → ignored
		h.runtime.emitProgress(assistantStarted(1_000)); // current item → binds "assistant-1"
		h.runtime.emitProgress(textDelta("assistant-2", "这是另一个消息的文本，也应被忽略。"));
		await tick();
		expect(h.voice.requests.length).toBe(0);
		// Only the bound message's delta reaches the queue.
		h.runtime.emitProgress(textDelta("assistant-1", "这是一段足够长的中文句子，超过最短长度。"));
		await tick();
		expect(h.voice.requests.length).toBe(1);
	});

	test("never projects thinking or toolCall deltas", async () => {
		const h = await makeHarness();
		h.prepare();
		h.runtime.emitProgress(assistantStarted());
		h.runtime.emitProgress(textDelta("assistant-1", "这是思考过程，不应该朗读。", "thinking"));
		h.runtime.emitProgress(textDelta("assistant-1", "这是工具调用参数。", "toolCall"));
		await tick();
		expect(h.voice.requests.length).toBe(0);
	});
});

describe("LiveSpeechManager — turn pipeline", () => {
	test("drives 3 utterances through 3 upstream opens and completes with one response", async () => {
		const h = await makeHarness();
		const job = h.prepare();
		const claim = h.manager.claimStream(job.id);
		expect(claim.status).toBe("ok");
		if (claim.status === "ok") claim.claim.run.attachResponse(h.response as unknown as ServerResponse);

		h.runtime.emitProgress(assistantStarted());
		h.runtime.emitProgress(textDelta("assistant-1", "第一句足够长，应当提交朗读。"));
		h.runtime.emitProgress(textDelta("assistant-1", "第二句也足够长，应当提交朗读。"));
		h.runtime.emitProgress(textDelta("assistant-1", "第三句足够长，应当提交朗读。"));
		await tick();
		await tick();

		expect(h.voice.requests.length).toBe(3);
		expect(job.status).toBe("generating");
		expect(job.progress.committedUtterances).toBe(3);

		h.runtime.emitProgress(assistantFinished("complete"));
		await tick();
		await tick();

		expect(job.status).toBe("completed");
		expect(job.progress.completedUtterances).toBe(3);
		expect(job.audio?.sampleRate).toBe(24000);
		expect(job.firstChunkAt).toBeDefined();
		expect(h.response.ended).toBe(true);
		expect(h.response.statusCode).toBe(200);
		expect(h.response.headers["x-pi-live-speech-job-id"]).toBe(job.id);
		expect(h.response.bytes().length % 4).toBe(0);
	});

	test("completes with 204 when the turn has no speakable text", async () => {
		const h = await makeHarness();
		const job = h.prepare();
		const claim = h.manager.claimStream(job.id);
		if (claim.status === "ok") claim.claim.run.attachResponse(h.response as unknown as ServerResponse);

		h.runtime.emitProgress(assistantStarted());
		h.runtime.emitProgress(textDelta("assistant-1", "思考", "thinking"));
		h.runtime.emitProgress(assistantFinished("complete"));
		await tick();
		await tick();

		expect(job.status).toBe("completed");
		expect(h.response.statusCode).toBe(204);
		expect(h.response.bytes().length).toBe(0);
	});

	test("aborted turn cancels the queue", async () => {
		const h = await makeHarness();
		const job = h.prepare();
		const claim = h.manager.claimStream(job.id);
		if (claim.status === "ok") claim.claim.run.attachResponse(h.response as unknown as ServerResponse);

		h.runtime.emitProgress(assistantStarted());
		h.runtime.emitProgress(textDelta("assistant-1", "这是一段足够长的中文句子，超过最短长度。"));
		await tick();
		h.runtime.emitProgress(assistantFinished("aborted"));
		await tick();

		expect(job.status).toBe("cancelled");
	});
});

describe("LiveSpeechManager — claim and cancel", () => {
	test("single claim wins; a second claim is rejected", async () => {
		const h = await makeHarness();
		const job = h.prepare();
		expect(h.manager.claimStream(job.id).status).toBe("ok");
		expect(h.manager.claimStream(job.id).status).toBe("claimed");
	});

	test("an unclaimed job expires via the claim TTL", async () => {
		const h = await makeHarness({ claimTtlMs: 100 });
		const job = h.prepare();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(job.status).toBe("failed");
		expect(job.error?.code).toBe("live_speech_expired");
		expect(h.manager.claimStream(job.id).status).toBe("expired");
	});

	test("cancel_live_speech cancels the job without aborting the Agent", async () => {
		const h = await makeHarness();
		const job = h.prepare();
		const result = await h.manager.executeCancel(h.connection, { command: "cancel_live_speech", jobId: job.id });
		expect(result.job.status).toBe("cancelled");
		// The runtime was never asked to abort.
		expect(h.runtime.promptInputs.length).toBe(0);
	});

	test("cancel_live_speech from a non-owner is not found", async () => {
		const h = await makeHarness();
		const job = h.prepare();
		await expect(
			h.manager.executeCancel(fakeConnection("other"), { command: "cancel_live_speech", jobId: job.id }),
		).rejects.toThrow(/Unknown live speech job/);
	});

	test("downstream close cancels the job", async () => {
		const h = await makeHarness();
		const job = h.prepare();
		const claim = h.manager.claimStream(job.id);
		if (claim.status === "ok") claim.claim.run.attachResponse(h.response as unknown as ServerResponse);
		h.runtime.emitProgress(assistantStarted());
		h.runtime.emitProgress(textDelta("assistant-1", "这是一段足够长的中文句子，超过最短长度。"));
		await tick();
		h.response.emit("close"); // browser disconnected before a clean end
		await tick();
		expect(job.status).toBe("cancelled");
	});

	test("connection disconnect cancels owned jobs", async () => {
		const h = await makeHarness();
		const job = h.prepare();
		h.manager.abortConnectionJobs(h.connection);
		expect(job.status).toBe("cancelled");
	});

	test("session abort/steer cancel jobs", async () => {
		const h = await makeHarness();
		const job = h.prepare();
		h.manager.abortSessionJobs("session-1", "agent_steer", "steered");
		expect(job.status).toBe("cancelled");
	});
});

describe("LiveSpeechManager — timers and lifecycle", () => {
	test("first-text timeout fails with turn_not_started", async () => {
		const h = await makeHarness({ firstTextTimeoutMs: 100 });
		const job = h.prepare();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(job.status).toBe("failed");
		expect(job.error?.code).toBe("turn_not_started");
	});

	test("shutdown cancels all active jobs", async () => {
		const h = await makeHarness();
		const job = h.prepare();
		h.manager.close();
		expect(job.status).toBe("cancelled");
	});
});
