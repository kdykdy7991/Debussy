import { describe, expect, test } from "vitest";
import {
	type Command,
	decodeCbor,
	encodeClientMessage,
	encodeServerMessage,
	FrameDecoder,
	isSupportedProtocolVersion,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	parseClientMessage,
	parseServerMessage,
	type ResultForCommand,
	type ServerMessage,
	type SpeechJob,
} from "../src/index.ts";

function liveJobForProtocol(overrides: Record<string, unknown> = {}) {
	return {
		id: "live-job-1",
		sessionId: "session-1",
		voiceProfileId: "default",
		status: "waiting_for_text" as const,
		streamPath: "/api/pi/v4/live-speech/live-job-1/stream",
		createdAt: 1,
		updatedAt: 1,
		progress: { committedUtterances: 0, completedUtterances: 0, pendingCharacters: 0 },
		...overrides,
	};
}

function promptWithSpeech(overrides: Record<string, unknown> = {}) {
	return {
		command: "prompt" as const,
		sessionId: "session-1",
		text: "hi",
		speech: { mode: "live" as const, ...(overrides.voiceProfileId === undefined ? {} : { voiceProfileId: overrides.voiceProfileId }) },
		...overrides,
	};
}

describe("LiveSpeechRequest schema", () => {
	test("accepts a minimal live request without voiceProfileId", () => {
		const envelope = {
			type: "request",
			id: "request-1",
			request: { command: "prompt", sessionId: "session-1", text: "hi", speech: { mode: "live" } },
		};
		expect(parseClientMessage(envelope)).toEqual(envelope);
	});

	test("accepts a live request with voiceProfileId", () => {
		const envelope = {
			type: "request",
			id: "request-1",
			request: { command: "prompt", sessionId: "session-1", text: "hi", speech: { mode: "live", voiceProfileId: "vivid" } },
		};
		expect(parseClientMessage(envelope)).toEqual(envelope);
	});

	test("rejects a speech request with an unknown mode", () => {
		const envelope = {
			type: "request",
			id: "request-1",
			request: { command: "prompt", sessionId: "session-1", text: "hi", speech: { mode: "manual" } },
		};
		expect(() => parseClientMessage(envelope)).toThrow(ProtocolValidationError);
	});

	test("rejects a speech request with extra fields", () => {
		const envelope = {
			type: "request",
			id: "request-1",
			request: { command: "prompt", sessionId: "session-1", text: "hi", speech: { mode: "live", extra: true } },
		};
		expect(() => parseClientMessage(envelope)).toThrow(ProtocolValidationError);
	});

	test("keeps prompt without speech wire-compatible with v3", () => {
		const envelope = {
			type: "request",
			id: "request-1",
			request: { command: "prompt", sessionId: "session-1", text: "hi" },
		};
		expect(parseClientMessage(envelope)).toEqual(envelope);
	});

	test("does not leak `speech` onto steer commands", () => {
		const envelope = {
			type: "request",
			id: "request-1",
			request: { command: "steer", sessionId: "session-1", text: "hi", speech: { mode: "live" } },
		};
		expect(() => parseClientMessage(envelope)).toThrow(ProtocolValidationError);
	});
});

describe("LiveSpeechJob schema", () => {
	test.each(["waiting_for_text", "generating", "streaming", "completed", "cancelled", "failed"] as const)(
		"accepts a %s live job",
		(status) => {
			const job = liveJobForProtocol({ status });
			const envelope = liveSpeechEvent(job);
			expect(parseServerMessage(envelope)).toEqual(envelope);
		},
	);

	test("rejects an unknown live status", () => {
		const envelope = liveSpeechEvent(liveJobForProtocol({ status: "speaking" }));
		expect(() => parseServerMessage(envelope)).toThrow(ProtocolValidationError);
	});

	test("rejects a live job missing the progress block", () => {
		const job = { ...liveJobForProtocol() };
		delete (job as { progress?: unknown }).progress;
		expect(() => parseServerMessage(liveSpeechEvent(job))).toThrow(ProtocolValidationError);
	});

	test("accepts a live job with progress and optional turn/message/audio fields", () => {
		const job = liveJobForProtocol({
			status: "streaming",
			turnId: "turn-1",
			messageId: "assistant-1",
			firstChunkAt: 2,
			audio: { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 },
			progress: { committedUtterances: 2, completedUtterances: 1, pendingCharacters: 12 },
		});
		expect(parseServerMessage(liveSpeechEvent(job))).toEqual(liveSpeechEvent(job));
	});

	test("rejects a live job with non-finite progress counters", () => {
		const job = liveJobForProtocol({ progress: { committedUtterances: -1, completedUtterances: 0, pendingCharacters: 0 } });
		expect(() => parseServerMessage(liveSpeechEvent(job))).toThrow(ProtocolValidationError);
	});

	test.each([
		"voice_unavailable",
		"voice_profile_not_found",
		"live_speech_busy",
		"live_speech_expired",
		"turn_not_started",
		"unsupported_content",
		"speech_backlog_exceeded",
		"speech_generation_failed",
		"speech_cancelled",
	] as const)("accepts a live job with error code %s", (code) => {
		const job = liveJobForProtocol({ status: "failed", error: { code, message: "nope" } });
		expect(parseServerMessage(liveSpeechEvent(job))).toEqual(liveSpeechEvent(job));
	});

	test("rejects an unknown live error code", () => {
		const job = liveJobForProtocol({ status: "failed", error: { code: "boom", message: "x" } });
		expect(() => parseServerMessage(liveSpeechEvent(job))).toThrow(ProtocolValidationError);
	});

	test("rejects a live job with an extra field", () => {
		const job = { ...liveJobForProtocol(), extra: true };
		expect(() => parseServerMessage(liveSpeechEvent(job as Parameters<typeof liveSpeechEvent>[0]))).toThrow(
			ProtocolValidationError,
		);
	});
});

describe("cancel_live_speech command", () => {
	test("parses a cancel_live_speech request", () => {
		const envelope = {
			type: "request",
			id: "request-1",
			request: { command: "cancel_live_speech", jobId: "live-job-1" },
		};
		expect(parseClientMessage(envelope)).toEqual(envelope);
	});

	test("rejects a cancel_live_speech request with extra fields", () => {
		const envelope = {
			type: "request",
			id: "request-1",
			request: { command: "cancel_live_speech", jobId: "live-job-1", extra: true },
		};
		expect(() => parseClientMessage(envelope)).toThrow(ProtocolValidationError);
	});

	test("parses a cancel_live_speech result carrying a job", () => {
		const response = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { command: "cancel_live_speech", job: liveJobForProtocol({ status: "cancelled" }) },
		};
		expect(parseServerMessage(response)).toEqual(response);
	});

	test("rejects a cancel_live_speech result whose job is malformed", () => {
		const response = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { command: "cancel_live_speech", job: { id: "x" } },
		};
		expect(() => parseServerMessage(response)).toThrow(ProtocolValidationError);
	});
});

describe("PromptResult with optional liveSpeech", () => {
	test("parses a prompt result without liveSpeech (Phase 1 unchanged)", () => {
		const snapshot = makeSessionSnapshot("session-1");
		const response = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { command: "prompt", session: snapshot },
		};
		expect(parseServerMessage(response)).toEqual(response);
	});

	test("parses a prompt result carrying a liveSpeech job", () => {
		const snapshot = makeSessionSnapshot("session-1");
		const job = liveJobForProtocol({ turnId: "turn-1", messageId: "assistant-1" });
		const response = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { command: "prompt", session: snapshot, liveSpeech: job },
		};
		expect(parseServerMessage(response)).toEqual(response);
	});

	test("rejects a prompt result whose liveSpeech is malformed", () => {
		const snapshot = makeSessionSnapshot("session-1");
		const response = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { command: "prompt", session: snapshot, liveSpeech: { id: "x" } },
		};
		expect(() => parseServerMessage(response)).toThrow(ProtocolValidationError);
	});
});

describe("live_speech_job event isolation", () => {
	test("parses a live_speech_job event", () => {
		const job = liveJobForProtocol({
			status: "streaming",
			turnId: "turn-1",
			messageId: "assistant-1",
			firstChunkAt: 2,
			audio: { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 },
		});
		const envelope = liveSpeechEvent(job);
		expect(parseServerMessage(envelope)).toEqual(envelope);
	});

	test("rejects a live_speech_job event with extra fields", () => {
		const job = { ...liveJobForProtocol(), extra: true };
		expect(() => parseServerMessage(liveSpeechEvent(job as Parameters<typeof liveSpeechEvent>[0]))).toThrow(
			ProtocolValidationError,
		);
	});

	test("a v3 server's speech_job event does not match a v4 live_speech_job", () => {
		const v3Job: SpeechJob = {
			id: "job-1",
			sessionId: "session-1",
			messageId: "assistant-1",
			voiceProfileId: "default",
			status: "queued",
			streamPath: "/api/pi/v3/speech/job-1/stream",
			createdAt: 1,
			updatedAt: 1,
		};
		const v3Envelope = { type: "event", event: { type: "speech_job", job: v3Job } } satisfies ServerMessage;
		expect(parseServerMessage(v3Envelope)).toEqual(v3Envelope);
		// live_speech_job is a different event type; v3 server doesn't emit it.
		expect(() =>
			parseServerMessage({ type: "event", event: { type: "live_speech_job", job: liveJobForProtocol() } }),
		).not.toThrow(ProtocolValidationError);
	});
});

describe("protocol v4 versioning and wire round-trip", () => {
	test("requires version 4 for a compatible handshake", () => {
		expect(PROTOCOL_VERSION).toBe(4);
		expect(isSupportedProtocolVersion(4)).toBe(true);
		expect(isSupportedProtocolVersion(3)).toBe(false);
		expect(isSupportedProtocolVersion(2)).toBe(false);
	});

	test("a v3 client hello parses but is rejected by v4 handshake semantics", () => {
		const hello = { type: "hello", version: 3 } as const;
		expect(() => parseClientMessage(hello)).not.toThrow(ProtocolValidationError);
		expect(isSupportedProtocolVersion(3)).toBe(false);
	});

	test("encodes and decodes a prompt request with speech payload", () => {
		const envelope = {
			type: "request",
			id: "request-1",
			request: { command: "prompt", sessionId: "session-1", text: "hi", speech: { mode: "live" } },
		};
		const [frame] = new FrameDecoder().push(encodeClientMessage(envelope));
		expect(parseClientMessage(decodeCbor(frame!))).toEqual(envelope);
	});

	test("encodes and decodes a live_speech_job event", () => {
		const job = liveJobForProtocol({
			status: "streaming",
			firstChunkAt: 2,
			audio: { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 },
		});
		const envelope = liveSpeechEvent(job);
		const [frame] = new FrameDecoder().push(encodeServerMessage(envelope));
		expect(parseServerMessage(decodeCbor(frame!))).toEqual(envelope);
	});
});

describe("ResultForCommand static typing for live speech", () => {
	test("resolves prompt-with-speech to a result that may carry liveSpeech (compile-time contract)", () => {
		const promptCommand = promptWithSpeech() satisfies Command;
		type PromptResult = ResultForCommand<typeof promptCommand>;
		// The prompt result must always include a session; liveSpeech is optional.
		const result: PromptResult = {
			command: "prompt",
			session: makeSessionSnapshot("session-1"),
		};
		expect(result.command).toBe("prompt");

		const cancelCommand = { command: "cancel_live_speech", jobId: "live-job-1" } as const satisfies Command;
		type CancelResult = ResultForCommand<typeof cancelCommand>;
		const cancelResult: CancelResult = { command: "cancel_live_speech", job: liveJobForProtocol({ status: "cancelled" }) };
		expect(cancelResult.job.id).toBe("live-job-1");
	});
});

function makeSessionSnapshot(id: string) {
	return {
		id,
		cwd: "/workspace",
		createdAt: 1,
		updatedAt: 1,
		phase: "turn" as const,
		model: { provider: "test", id: "model" },
		thinkingLevel: "off" as const,
		attached: true,
		locked: false,
		lastSequence: 0,
		revision: 1,
		transcript: [],
		queuedSteer: [],
		queuedSteerCount: 0,
	};
}

function liveSpeechEvent(job: Parameters<typeof import("../src/index.ts").parseServerMessage>[0] extends never
	? never
	: ReturnType<typeof liveJobForProtocol>): ServerMessage {
	return { type: "event", event: { type: "live_speech_job", job } };
}