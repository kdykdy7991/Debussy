import type { SpeechJob, TranscriptItem } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import type { ConnectionState } from "../src/connection.ts";
import { PiServerError } from "../src/errors.ts";
import { extractSpeakableText, SpeechManager, type SpeechManagerHost } from "../src/voice/speech-manager.ts";
import type {
	StreamSynthesisRequest,
	VoiceAudioFormat,
	VoiceServiceClient,
	VoiceStreamResult,
} from "../src/voice/types.ts";

const FORMAT: VoiceAudioFormat = { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 };

class FakeVoiceClient implements VoiceServiceClient {
	readonly requests: StreamSynthesisRequest[] = [];
	readonly aborted = new Set<AbortSignal>();
	nextError: Error | undefined;
	openCalls = 0;

	async openStream(request: StreamSynthesisRequest, signal: AbortSignal): Promise<VoiceStreamResult> {
		this.openCalls += 1;
		this.requests.push(request);
		if (signal.aborted) this.aborted.add(signal);
		signal.addEventListener("abort", () => this.aborted.add(signal), { once: true });
		if (this.nextError) throw this.nextError;
		return { format: FORMAT, body: new ReadableStream() };
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

function thinkingAssistant(messageId: string): TranscriptItem {
	return {
		id: messageId,
		role: "assistant",
		status: "complete",
		content: [{ type: "thinking", thinking: "hmm", redacted: false }],
		model: { provider: "test", id: "model" },
		stopReason: "stop",
		timestamp: 1,
	};
}

function streamingAssistant(messageId: string): TranscriptItem {
	return {
		id: messageId,
		role: "assistant",
		status: "streaming",
		content: [{ type: "text", text: "partial" }],
		model: { provider: "test", id: "model" },
		timestamp: 1,
	};
}

interface FakeHost extends SpeechManagerHost {
	events: SpeechJob[];
}

function makeManager(options: { text?: string; items?: TranscriptItem[] } = {}): {
	manager: SpeechManager;
	host: FakeHost;
	client: FakeVoiceClient;
	connection: ConnectionState;
} {
	const client = new FakeVoiceClient();
	const host: FakeHost = {
		events: [],
		resolveMessage: (_connection, _sessionId, messageId) =>
			options.items?.find((item) => item.id === messageId) ??
			completeAssistant(messageId, options.text ?? "hello world"),
		sendJobEvent: (_connection, job) => {
			host.events.push(job);
		},
		reportError: () => {},
	};
	const manager = new SpeechManager({
		voiceClient: client,
		profiles: [{ id: "default", provider: "qwen3-tts", language: "Chinese", speaker: "Vivian" }],
		defaultProfileId: "default",
		clock: () => 1_000,
		uuid: () => "job-1",
	});
	manager.bind(host);
	return { manager, host, client, connection: fakeConnection() };
}

function fakeConnection(id = "conn-1"): ConnectionState {
	return {
		id,
		connection: {} as never,
		decoder: {} as never,
		sessionIds: new Set(["session-1"]),
		stage: "ready",
		disconnected: false,
		handshakeComplete: true,
		handshakeTimeout: {} as never,
	};
}

async function startJob(
	manager: SpeechManager,
	connection: ConnectionState,
	overrides: Record<string, unknown> = {},
): Promise<SpeechJob> {
	const result = await manager.executeCommand(connection, {
		command: "start_speech",
		sessionId: "session-1",
		messageId: "assistant-1",
		...overrides,
	});
	if (result.command !== "start_speech") throw new Error(`Unexpected result: ${result.command}`);
	return result.job;
}

describe("extractSpeakableText", () => {
	test("joins text parts in order and trims", () => {
		const item: TranscriptItem = {
			id: "m",
			role: "assistant",
			status: "complete",
			content: [
				{ type: "text", text: "  first  " },
				{ type: "thinking", thinking: "secret", redacted: false },
				{ type: "text", text: "second\n\nthird" },
			],
			model: { provider: "test", id: "model" },
			stopReason: "stop",
			timestamp: 1,
		};
		expect(extractSpeakableText(item)).toBe("first\nsecond\n\nthird");
	});

	test("rejects a streaming assistant message", () => {
		expect(() => extractSpeakableText(streamingAssistant("m"))).toThrow(/completed assistant/i);
	});

	test("rejects thinking-only content", () => {
		expect(() => extractSpeakableText(thinkingAssistant("m"))).toThrow(/no speakable text/i);
	});
});

describe("start_speech", () => {
	test("creates a queued job with a server-generated stream path", async () => {
		const { manager, connection } = makeManager();
		const job = await startJob(manager, connection);
		expect(job.status).toBe("queued");
		expect(job.id).toBe("job-1");
		expect(job.streamPath).toBe("/api/pi/v3/speech/job-1/stream");
		expect(job.voiceProfileId).toBe("default");
		expect(job.sessionId).toBe("session-1");
	});

	test("rejects a second active job on the same connection with busy", async () => {
		const { manager, connection } = makeManager();
		await startJob(manager, connection);
		await expect(startJob(manager, connection)).rejects.toThrow(PiServerError);
		await expect(startJob(manager, connection)).rejects.toMatchObject({ code: "busy" });
	});

	test("rejects a non-completed assistant message", async () => {
		const { manager, connection } = makeManager({ items: [streamingAssistant("assistant-1")] });
		await expect(startJob(manager, connection)).rejects.toMatchObject({ code: "invalid_request" });
	});

	test("rejects an unknown profile with not_found", async () => {
		const { manager, connection } = makeManager();
		await expect(startJob(manager, connection, { voiceProfileId: "missing" })).rejects.toMatchObject({
			code: "not_found",
		});
	});

	test("rejects text that exceeds the configured limit", async () => {
		const { manager, connection } = makeManager({ text: "x".repeat(4_001) });
		await expect(startJob(manager, connection)).rejects.toMatchObject({ code: "invalid_request" });
	});

	test("resolves the profile at claim time for the upstream request", async () => {
		const { manager, connection, client } = makeManager();
		const job = await startJob(manager, connection);
		manager.claimStream(job.id);
		await manager.openStream(job.id);
		expect(client.requests[0]).toMatchObject({
			text: "hello world",
			language: "Chinese",
			speaker: "Vivian",
		});
	});
});

describe("claim and state machine", () => {
	test("claims once and transitions to generating with an event", async () => {
		const { manager, connection, host } = makeManager();
		const job = await startJob(manager, connection);
		expect(host.events).toHaveLength(0);
		const claim = manager.claimStream(job.id);
		expect(claim.status).toBe("ok");
		if (claim.status !== "ok") return;
		expect(claim.claim.job.status).toBe("generating");
		expect(host.events.at(-1)?.status).toBe("generating");
	});

	test("a second claim is rejected as claimed", async () => {
		const { manager, connection } = makeManager();
		const job = await startJob(manager, connection);
		manager.claimStream(job.id);
		expect(manager.claimStream(job.id).status).toBe("claimed");
	});

	test("an unknown job is not_found", async () => {
		const { manager } = makeManager();
		expect(manager.claimStream("nope").status).toBe("not_found");
	});

	test("unclaimed job expires to cancelled and is not claimable", async () => {
		const { manager, connection, host } = makeManager();
		const job = await startJob(manager, connection);
		// Fire the unclaimed TTL expiry directly (the timer path is exercised in
		// the integration suite with a real clock).
		const internal = manager as unknown as { expireUnclaimed(id: string): void };
		internal.expireUnclaimed(job.id);
		expect(host.events.at(-1)?.status).toBe("cancelled");
		expect(manager.claimStream(job.id).status).toBe("expired");
	});

	test("a claimed job completes and emits completed", async () => {
		const { manager, connection, host } = makeManager();
		const job = await startJob(manager, connection);
		manager.claimStream(job.id);
		manager.noteStreaming(job.id, FORMAT);
		manager.noteBytes(job.id, 8);
		expect(manager.completeJob(job.id)).toBe(true);
		expect(host.events.at(-1)?.status).toBe("completed");
		expect(host.events.at(-1)?.audio).toEqual(FORMAT);
	});

	test("a stream with a non-multiple-of-4 length fails as generation_failed", async () => {
		const { manager, connection, host } = makeManager();
		const job = await startJob(manager, connection);
		manager.claimStream(job.id);
		manager.noteBytes(job.id, 5);
		expect(manager.completeJob(job.id)).toBe(false);
		const final = host.events.at(-1);
		expect(final?.status).toBe("failed");
		expect(final?.error?.code).toBe("speech_generation_failed");
	});

	test("failJob emits failed with the given error", async () => {
		const { manager, connection, host } = makeManager();
		const job = await startJob(manager, connection);
		manager.claimStream(job.id);
		manager.failJob(job.id, "voice_unavailable", "Voice Service is unavailable");
		const final = host.events.at(-1);
		expect(final?.status).toBe("failed");
		expect(final?.error).toEqual({ code: "voice_unavailable", message: "Voice Service is unavailable" });
	});
});

describe("cancel and abort propagation", () => {
	test("the owning connection can cancel and the job aborts upstream", async () => {
		const { manager, connection, client } = makeManager();
		const job = await startJob(manager, connection);
		const signal = manager.claimStream(job.id);
		if (signal.status !== "ok") throw new Error("claim failed");
		await manager.openStream(job.id);
		const result = await manager.executeCommand(connection, { command: "cancel_speech", jobId: job.id });
		expect(result.command).toBe("cancel_speech");
		if (result.command !== "cancel_speech") return;
		expect(result.job.status).toBe("cancelled");
		expect(client.aborted.has(signal.claim.signal)).toBe(true);
	});

	test("a non-owner cancel does not reveal the job", async () => {
		const { manager, connection } = makeManager();
		const job = await startJob(manager, connection);
		await expect(
			manager.executeCommand(fakeConnection("other"), { command: "cancel_speech", jobId: job.id }),
		).rejects.toMatchObject({ code: "not_found" });
	});

	test("repeating a cancel on a terminal job is idempotent", async () => {
		const { manager, connection } = makeManager();
		const job = await startJob(manager, connection);
		await manager.executeCommand(connection, { command: "cancel_speech", jobId: job.id });
		const again = await manager.executeCommand(connection, { command: "cancel_speech", jobId: job.id });
		if (again.command !== "cancel_speech") return;
		expect(again.job.status).toBe("cancelled");
	});

	test("disconnecting the owner cancels its active jobs", async () => {
		const { manager, connection, host } = makeManager();
		const job = await startJob(manager, connection);
		manager.abortConnectionJobs(connection);
		expect(host.events.at(-1)?.status).toBe("cancelled");
		expect(manager.claimStream(job.id).status).toBe("expired");
	});

	test("close cancels all live jobs", async () => {
		const { manager, connection, host } = makeManager();
		await startJob(manager, connection);
		manager.close();
		expect(host.events.at(-1)?.status).toBe("cancelled");
	});

	test("terminal jobs are retained for the retention window then dropped", async () => {
		const { manager, connection, host } = makeManager();
		const job = await startJob(manager, connection);
		manager.claimStream(job.id);
		manager.completeJob(job.id);
		expect(host.events.at(-1)?.status).toBe("completed");
		(manager as unknown as { drop(id: string): void }).drop(job.id);
		expect(manager.claimStream(job.id).status).toBe("not_found");
	});
});
