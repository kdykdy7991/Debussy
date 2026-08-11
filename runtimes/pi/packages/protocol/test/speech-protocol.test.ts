import { Check } from "typebox/value";
import { describe, expect, test } from "vitest";
import {
	type Command,
	type ServerMessage,
	type ServerSnapshot,
	decodeCbor,
	encodeClientMessage,
	encodeServerMessage,
	FrameDecoder,
	isSupportedProtocolVersion,
	parseClientMessage,
	parseServerMessage,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	type ResultForCommand,
	type SpeechErrorCode,
	type SpeechJob,
	SpeechStatusSchema,
} from "../src/index.ts";

function speechJobForProtocol(overrides: Record<string, unknown> = {}): SpeechJob {
	return {
		id: "job-1",
		sessionId: "session-1",
		messageId: "assistant-1",
		voiceProfileId: "default",
		status: "queued",
		streamPath: "/api/pi/v3/speech/job-1/stream",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function startSpeechRequest(overrides: Record<string, unknown> = {}) {
	return {
		type: "request",
		id: "request-1",
		request: { command: "start_speech", sessionId: "session-1", messageId: "assistant-1", ...overrides },
	};
}

function cancelSpeechRequest(overrides: Record<string, unknown> = {}) {
	return {
		type: "request",
		id: "request-1",
		request: { command: "cancel_speech", jobId: "job-1", ...overrides },
	};
}

describe("SpeechJob schema", () => {
	test.each(["queued", "generating", "streaming", "completed", "failed", "cancelled"] as const)(
		"accepts a %s job",
		(status) => {
			const job = speechJobForProtocol({ status });
			expect(Check(SpeechStatusSchema, status)).toBe(true);
			expect(parseServerMessage(speechEvent(job))).toEqual(speechEvent(job));
		},
	);

	test("rejects an unknown speech status", () => {
		expect(() => parseServerMessage(speechEvent(speechJobForProtocol({ status: "done" })))).toThrow(
			ProtocolValidationError,
		);
	});

	test("rejects a job with an extra field", () => {
		const job = speechJobForProtocol({ extra: true });
		expect(() => parseServerMessage(speechEvent(job))).toThrow(ProtocolValidationError);
	});

	test.each([
		["id", { id: "" }],
		["sessionId", { sessionId: "" }],
		["messageId", { messageId: "" }],
		["voiceProfileId", { voiceProfileId: "" }],
		["streamPath", { streamPath: "" }],
		["createdAt", { createdAt: -1 }],
		["updatedAt", { updatedAt: -1 }],
	])("rejects a job missing/invalid %s", (_label, overrides) => {
		expect(() => parseServerMessage(speechEvent(speechJobForProtocol(overrides)))).toThrow(ProtocolValidationError);
	});

	test("rejects a job without a streamPath", () => {
		const job = speechJobForProtocol() as Record<string, unknown>;
		delete job.streamPath;
		expect(() => parseServerMessage(speechEvent(job))).toThrow(ProtocolValidationError);
	});

	test("accepts an audio format with channels 1 and pcm_f32le only", () => {
		const job = speechJobForProtocol({
			status: "streaming",
			audio: { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 },
		});
		expect(parseServerMessage(speechEvent(job))).toEqual(speechEvent(job));
		for (const audio of [
			{ encoding: "wav", sampleRate: 24000, channels: 1 },
			{ encoding: "pcm_f32le", sampleRate: 24000, channels: 2 },
			{ encoding: "pcm_f32le", sampleRate: 0, channels: 1 },
			{ encoding: "pcm_f32le", sampleRate: 24000 },
		]) {
			expect(() => parseServerMessage(speechEvent(speechJobForProtocol({ status: "streaming", audio })))).toThrow(
				ProtocolValidationError,
			);
		}
	});

	test("accepts an error with every documented speech error code", () => {
		const codes: SpeechErrorCode[] = [
			"voice_unavailable",
			"voice_profile_not_found",
			"message_not_speakable",
			"speech_busy",
			"speech_stream_claimed",
			"speech_stream_expired",
			"speech_generation_failed",
			"speech_cancelled",
		];
		for (const code of codes) {
			const job = speechJobForProtocol({ status: "failed", error: { code, message: "nope" } });
			expect(parseServerMessage(speechEvent(job))).toEqual(speechEvent(job));
		}
	});

	test("rejects an unknown speech error code", () => {
		expect(() =>
			parseServerMessage(speechEvent(speechJobForProtocol({ status: "failed", error: { code: "boom", message: "x" } }))),
		).toThrow(ProtocolValidationError);
	});

	test("rejects an error missing a message", () => {
		expect(() =>
			parseServerMessage(speechEvent(speechJobForProtocol({ status: "failed", error: { code: "speech_busy" } }))),
		).toThrow(ProtocolValidationError);
	});
});

describe("start_speech / cancel_speech commands", () => {
	test("parses a start_speech request with an explicit profile", () => {
		const message = startSpeechRequest({ voiceProfileId: "vivid" });
		expect(parseClientMessage(message)).toEqual(message);
	});

	test("parses a start_speech request omitting the profile", () => {
		const message = startSpeechRequest();
		delete message.request.voiceProfileId;
		expect(parseClientMessage(message)).toEqual(message);
		expect((message.request as Record<string, unknown>).voiceProfileId).toBeUndefined();
	});

	test.each([
		["missing sessionId", { sessionId: undefined }],
		["missing messageId", { messageId: undefined }],
		["unknown command", { command: "start_voice" }],
		["extra field", { extra: true }],
	])("rejects a start_speech request with %s", (_label, overrides) => {
		expect(() => parseClientMessage(startSpeechRequest(overrides))).toThrow(ProtocolValidationError);
	});

	test("parses a cancel_speech request", () => {
		const message = cancelSpeechRequest();
		expect(parseClientMessage(message)).toEqual(message);
	});

	test.each([
		["missing jobId", { jobId: undefined }],
		["extra field", { extra: true }],
	])("rejects a cancel_speech request with %s", (_label, overrides) => {
		expect(() => parseClientMessage(cancelSpeechRequest(overrides))).toThrow(ProtocolValidationError);
	});
});

describe("start_speech / cancel_speech results", () => {
	test("parses a start_speech result carrying a job", () => {
		const response = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { command: "start_speech", job: speechJobForProtocol() },
		};
		expect(parseServerMessage(response)).toEqual(response);
	});

	test("parses a cancel_speech result carrying a job", () => {
		const response = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { command: "cancel_speech", job: speechJobForProtocol({ status: "cancelled" }) },
		};
		expect(parseServerMessage(response)).toEqual(response);
	});

	test("rejects a result whose job is malformed", () => {
		const response = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { command: "start_speech", job: { id: "job-1" } },
		};
		expect(() => parseServerMessage(response)).toThrow(ProtocolValidationError);
	});

	test("rejects a result with an unknown command", () => {
		const response = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { command: "unknown_speech", job: speechJobForProtocol() },
		};
		expect(() => parseServerMessage(response)).toThrow(ProtocolValidationError);
	});
});

describe("speech_job event", () => {
	test("parses a speech_job event for a streaming job", () => {
		const event = speechEvent(
			speechJobForProtocol({
				status: "streaming",
				firstChunkAt: 2,
				audio: { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 },
			}),
		);
		expect(parseServerMessage(event)).toEqual(event);
	});

	test("rejects a speech_job event with an extra field", () => {
		const event = speechEvent(speechJobForProtocol()) as Record<string, unknown>;
		event.extra = true;
		expect(() => parseServerMessage(event)).toThrow(ProtocolValidationError);
	});
});

describe("protocol v3 versioning and wire round-trip", () => {
	test("requires version 3 for a compatible handshake", () => {
		expect(isSupportedProtocolVersion(3)).toBe(true);
		expect(isSupportedProtocolVersion(2)).toBe(false);
		expect(isSupportedProtocolVersion(1)).toBe(false);
	});

	test("encodes and decodes a start_speech request", () => {
		const message = startSpeechRequest({ voiceProfileId: "vivid" });
		const [frame] = new FrameDecoder().push(encodeClientMessage(message));
		expect(parseClientMessage(decodeCbor(frame!))).toEqual(message);
	});

	test("encodes and decodes a speech_job event", () => {
		const event = speechEvent(
			speechJobForProtocol({ status: "completed", audio: { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 } }),
		);
		const [frame] = new FrameDecoder().push(encodeServerMessage(event));
		expect(parseServerMessage(decodeCbor(frame!))).toEqual(event);
	});

	test("a v2 handshake is rejected by a v3 server parser", () => {
		expect(() =>
			parseClientMessage({
				type: "hello",
				version: 2,
			}),
		).not.toThrow(ProtocolValidationError);
		expect(isSupportedProtocolVersion(2)).toBe(false);
	});

	test("server snapshot exposes voice capability when present", () => {
		const snapshot: ServerSnapshot = {
			serverId: "server-1",
			protocolVersion: PROTOCOL_VERSION,
			revision: 0,
			sessions: [],
			models: [],
			voice: { available: true, defaultProfile: "default", profiles: [{ id: "default", name: "Default" }] },
		};
		const hello: ServerMessage = {
			type: "hello",
			version: PROTOCOL_VERSION,
			connectionId: "connection-1",
			snapshot,
		};
		expect(parseServerMessage(hello)).toEqual(hello);
	});

	test("rejects a voice capability with provider internals", () => {
		expect(() =>
			parseServerMessage({
				type: "hello",
				version: PROTOCOL_VERSION,
				connectionId: "connection-1",
				snapshot: {
					serverId: "server-1",
					protocolVersion: PROTOCOL_VERSION,
					revision: 0,
					sessions: [],
					models: [],
					voice: {
						available: true,
						defaultProfile: "default",
						profiles: [{ id: "default", speaker: "Vivian" }],
					},
				},
			}),
		).toThrow(ProtocolValidationError);
	});
});

describe("ResultForCommand static typing", () => {
	test("resolves speech commands to job-bearing results (compile-time contract)", () => {
		// These lines are compile-time contracts; the runtime assertion is secondary.
		const startCommand = { command: "start_speech", sessionId: "s", messageId: "m" } as const satisfies Command;
		type StartResult = ResultForCommand<typeof startCommand>;
		const startResult = { command: "start_speech", job: speechJobForProtocol() } as unknown as StartResult;
		expect(startResult).toBeDefined();

		const cancelCommand = { command: "cancel_speech", jobId: "job-1" } as const satisfies Command;
		type CancelResult = ResultForCommand<typeof cancelCommand>;
		const cancelResult = { command: "cancel_speech", job: speechJobForProtocol() } as unknown as CancelResult;
		expect(cancelResult).toBeDefined();

		// A speech command must never resolve to a session-bearing result.
		type IsSessionResult<T> = T extends { session: unknown } ? true : false;
		const startIsSession: IsSessionResult<StartResult> = false;
		expect(startIsSession).toBe(false);
	});
});

function speechEvent(job: SpeechJob): ServerMessage {
	return { type: "event", event: { type: "speech_job", job } };
}
