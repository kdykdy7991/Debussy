import { describe, expect, test } from "vitest";
import {
	type ClientHello,
	type ClientMessage,
	ClientMessageDecoder,
	decodeCbor,
	encodeCbor,
	encodeClientMessage,
	encodeFrame,
	encodeServerMessage,
	FrameDecoder,
	isSupportedProtocolVersion,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	parseClientMessage,
	parseServerMessage,
	type ServerHello,
	type ServerMessage,
	ServerMessageDecoder,
	type ServerSnapshot,
	type SessionSnapshot,
} from "../src/index.ts";

const emptyServerSnapshot: ServerSnapshot = {
	serverId: "server-1",
	protocolVersion: PROTOCOL_VERSION,
	revision: 0,
	sessions: [],
	models: [],
};

const clientHello: ClientHello = {
	type: "hello",
	version: PROTOCOL_VERSION,
};

const serverHello: ServerHello = {
	type: "hello",
	version: PROTOCOL_VERSION,
	connectionId: "connection-1",
	snapshot: emptyServerSnapshot,
};

function sessionSnapshotForProtocol(): SessionSnapshot {
	return {
		id: "session-1",
		cwd: "/workspace",
		createdAt: 1,
		updatedAt: 1,
		phase: "idle",
		model: { provider: "test", id: "model" },
		thinkingLevel: "off",
		attached: true,
		locked: false,
		lastSequence: 0,
		revision: 1,
		transcript: [],
		queuedSteer: [],
		queuedSteerCount: 0,
	};
}

function progressEvent(sequence: number): unknown {
	return {
		type: "event",
		event: {
			type: "session_progress",
			sessionId: "session-1",
			turnId: "turn-1",
			sequence,
			progress: {
				type: "assistant_delta",
				messageId: "assistant-1",
				contentIndex: 0,
				kind: "text",
				delta: "hi",
			},
		},
	};
}

function itemMessage(item: unknown, type: "item_updated" | "item_finished" = "item_finished") {
	return {
		type: "event",
		event: {
			type: "session_progress",
			sessionId: "session-1",
			turnId: "turn-1",
			sequence: 1,
			progress: { type, item },
		},
	};
}

describe("protocol validation", () => {
	test("uses protocol version 2", () => {
		expect(PROTOCOL_VERSION).toBe(2);
		expect(isSupportedProtocolVersion(2)).toBe(true);
		expect(isSupportedProtocolVersion(1)).toBe(false);
		expect(isSupportedProtocolVersion(2.5)).toBe(false);
	});

	test.each([0, PROTOCOL_VERSION, PROTOCOL_VERSION + 1])(
		"accepts integer client hello version %s for negotiation",
		(version) => {
			const message = { ...clientHello, version };
			expect(parseClientMessage(message)).toEqual(message);
		},
	);

	test.each([
		["string version", { type: "hello", version: String(PROTOCOL_VERSION) }],
		["fractional version", { type: "hello", version: PROTOCOL_VERSION + 0.5 }],
		["credential field", { type: "hello", version: PROTOCOL_VERSION, token: "secret" }],
		["unknown field", { type: "hello", version: PROTOCOL_VERSION, extra: true }],
	] as const)("rejects a handshake with %s", (_label, message) => {
		expect(() => parseClientMessage(message)).toThrow(ProtocolValidationError);
	});

	test("does not parse JSON strings as wire messages", () => {
		expect(() => parseClientMessage(JSON.stringify(clientHello))).toThrow(ProtocolValidationError);
		expect(() => parseServerMessage(JSON.stringify(serverHello))).toThrow(ProtocolValidationError);
	});

	test("rejects image input while the MVP remains text-only", () => {
		expect(() =>
			parseClientMessage({
				type: "request",
				id: "request-1",
				request: {
					command: "prompt",
					sessionId: "session-1",
					text: "inspect",
					images: [{ type: "image", data: "abc", mimeType: "image/png" }],
				},
			}),
		).toThrow(ProtocolValidationError);
	});

	test("parses a server handshake snapshot", () => {
		expect(parseServerMessage(serverHello)).toEqual(serverHello);
	});

	test.each([
		{
			type: "hello",
			version: PROTOCOL_VERSION + 1,
			connectionId: "connection-1",
			snapshot: emptyServerSnapshot,
		},
		{ type: "hello_error", error: { code: "auth", message: "Authentication failed" } },
		{ type: "response", id: "request-1", ok: true, result: { command: "unknown" } },
		{ type: "event", event: { type: "session_removed", sessionId: 42 } },
	])("rejects invalid server messages", (wire) => {
		expect(() => parseServerMessage(wire)).toThrow(ProtocolValidationError);
	});

	test("validates nested JSON tool details", () => {
		const message = {
			type: "event",
			event: {
				type: "session_progress",
				sessionId: "session-1",
				turnId: "turn-1",
				sequence: 1,
				progress: {
					type: "item_finished",
					item: {
						id: "tool-1",
						role: "tool",
						toolCallId: "call-1",
						toolName: "read",
						input: { path: "/tmp/file" },
						content: [{ type: "text", text: "done" }],
						details: { lines: [1, 2, 3], cached: false },
						status: "complete",
						isError: false,
						timestamp: 1,
					},
				},
			},
		};
		expect(parseServerMessage(message)).toEqual(message);
	});

	test.each([
		{ status: "streaming" },
		{ status: "complete", stopReason: "stop" },
		{ status: "error", stopReason: "error" },
		{ status: "error", stopReason: "error", errorMessage: "failed" },
		{ status: "aborted", stopReason: "aborted" },
	])("accepts a consistent $status assistant item", (state) => {
		const message = itemMessage(
			{
				id: "assistant-1",
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
				model: { provider: "test", id: "model" },
				timestamp: 1,
				...state,
			},
			state.status === "streaming" ? "item_updated" : "item_finished",
		);
		expect(parseServerMessage(message)).toEqual(message);
	});

	test.each([
		{ status: "streaming", stopReason: "stop" },
		{ status: "complete" },
		{ status: "complete", stopReason: "error" },
		{ status: "error", stopReason: "error", errorMessage: "" },
		{ status: "aborted", stopReason: "stop" },
	])("rejects an inconsistent $status assistant item", (state) => {
		expect(() =>
			parseServerMessage(
				itemMessage({
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					model: { provider: "test", id: "model" },
					timestamp: 1,
					...state,
				}),
			),
		).toThrow(ProtocolValidationError);
	});

	test.each([
		{ status: "running", isError: false },
		{ status: "complete", isError: false },
		{ status: "error", isError: true },
	])("accepts a consistent $status tool item", (state) => {
		const message = itemMessage(
			{
				id: "tool-1",
				role: "tool",
				toolCallId: "call-1",
				toolName: "read",
				input: {},
				content: [],
				timestamp: 1,
				...state,
			},
			state.status === "running" ? "item_updated" : "item_finished",
		);
		expect(parseServerMessage(message)).toEqual(message);
	});

	test("rejects nonterminal items reported as finished", () => {
		const assistant = {
			id: "assistant-1",
			role: "assistant",
			content: [],
			model: { provider: "test", id: "model" },
			status: "streaming",
			timestamp: 1,
		};
		const tool = {
			id: "tool-1",
			role: "tool",
			toolCallId: "call-1",
			toolName: "read",
			input: {},
			content: [],
			status: "running",
			isError: false,
			timestamp: 1,
		};

		expect(() => parseServerMessage(itemMessage(assistant))).toThrow(ProtocolValidationError);
		expect(() => parseServerMessage(itemMessage(tool))).toThrow(ProtocolValidationError);
	});

	test.each([
		{ status: "running", isError: true },
		{ status: "complete", isError: true },
		{ status: "error", isError: false },
	])("rejects an inconsistent $status tool item", (state) => {
		expect(() =>
			parseServerMessage(
				itemMessage({
					id: "tool-1",
					role: "tool",
					toolCallId: "call-1",
					toolName: "read",
					input: {},
					content: [],
					timestamp: 1,
					...state,
				}),
			),
		).toThrow(ProtocolValidationError);
	});

	test("rejects cyclic protocol values with a protocol validation error", () => {
		const details: Record<string, unknown> = {};
		details.self = details;
		const message = {
			type: "response",
			id: "request-1",
			ok: false,
			error: { code: "invalid_request", message: "invalid", details },
		};

		expect(() => parseServerMessage(message)).toThrow(ProtocolValidationError);
	});

	test("validation errors do not retain rejected payloads", () => {
		let thrown: unknown;
		try {
			parseClientMessage({
				type: "hello",
				version: String(PROTOCOL_VERSION),
				extra: "x".repeat(2_000_000),
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ProtocolValidationError);
		expect(Object.hasOwn(thrown as object, "value")).toBe(false);
		expect((thrown as Error).message.length).toBeLessThan(1_000);
	});
});

describe("validated framed protocol APIs", () => {
	test("encodes complete client and server frames", () => {
		const clientFrames = new FrameDecoder().push(encodeClientMessage(clientHello));
		expect(clientFrames).toHaveLength(1);
		expect(parseClientMessage(decodeCbor(clientFrames[0]!))).toEqual(clientHello);

		const serverFrames = new FrameDecoder().push(encodeServerMessage(serverHello));
		expect(serverFrames).toHaveLength(1);
		expect(parseServerMessage(decodeCbor(serverFrames[0]!))).toEqual(serverHello);
	});

	test("enforces an outbound frame limit before returning encoded bytes", () => {
		expect(() => encodeClientMessage(clientHello, { maxFrameLength: 8 })).toThrow(ProtocolValidationError);
		expect(() => encodeServerMessage(serverHello, { maxFrameLength: 8 })).toThrow(ProtocolValidationError);
	});

	test("validates messages before encoding", () => {
		expect(() => encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION + 0.5 })).toThrow(
			ProtocolValidationError,
		);
	});

	test("omits explicit undefined optional properties on the wire", () => {
		const message: ClientMessage = {
			type: "request",
			id: "request-1",
			request: { command: "create", cwd: undefined, name: undefined },
		};
		const [payload] = new FrameDecoder().push(encodeClientMessage(message));
		expect(decodeCbor(payload!)).toEqual({
			type: "request",
			id: "request-1",
			request: { command: "create" },
		});
	});

	test("incrementally decodes fragmented and coalesced client messages", () => {
		const request: ClientMessage = {
			type: "request",
			id: "request-1",
			request: { command: "list" },
		};
		const first = encodeClientMessage(clientHello);
		const second = encodeClientMessage(request);
		const wire = new Uint8Array(first.byteLength + second.byteLength);
		wire.set(first);
		wire.set(second, first.byteLength);

		for (let split = 0; split <= wire.byteLength; split++) {
			const decoder = new ClientMessageDecoder();
			const messages = [...decoder.push(wire.subarray(0, split)), ...decoder.push(wire.subarray(split))];
			decoder.end();
			expect(messages).toEqual([clientHello, request]);
		}
	});

	test("incrementally decodes server messages", () => {
		const errorMessage: ServerMessage = {
			type: "hello_error",
			error: { code: "version", message: "Unsupported protocol version" },
		};
		const decoder = new ServerMessageDecoder();
		expect(decoder.push(encodeServerMessage(errorMessage))).toEqual([errorMessage]);
		decoder.end();
	});

	test.each([
		["empty CBOR payload", encodeFrame(new Uint8Array())],
		["malformed CBOR", encodeFrame(new Uint8Array([0xff]))],
		["schema-invalid CBOR", encodeFrame(encodeCbor({ type: "hello", version: PROTOCOL_VERSION, extra: true }))],
	] as const)("rejects invalid framed client input: %s", (_label, wire) => {
		const decoder = new ClientMessageDecoder();
		expect(() => decoder.push(wire)).toThrow(ProtocolValidationError);
		expect(() => decoder.push(encodeClientMessage(clientHello))).toThrow(/failed/i);
	});

	test("rejects CBOR byte strings nested in JSON-valued fields", () => {
		const wire = encodeFrame(
			encodeCbor({
				type: "response",
				id: "request-1",
				ok: false,
				error: {
					code: "invalid_request",
					message: "invalid",
					details: { nested: new Uint8Array([1, 2, 3]) },
				},
			}),
		);
		expect(() => new ServerMessageDecoder().push(wire)).toThrow(ProtocolValidationError);
	});

	test("rejects truncated and oversized framing through the validated decoder", () => {
		const truncated = new ServerMessageDecoder();
		expect(truncated.push(new Uint8Array([0, 0, 0, 2, 1]))).toEqual([]);
		expect(() => truncated.end()).toThrow(ProtocolValidationError);

		const oversized = new ClientMessageDecoder({ maxFrameLength: 3 });
		expect(() => oversized.push(new Uint8Array([0, 0, 0, 4]))).toThrow(ProtocolValidationError);
	});
});

describe("protocol v2 resumable progress", () => {
	test("parses a session_progress event carrying turnId and sequence", () => {
		const message = progressEvent(1);
		expect(parseServerMessage(message)).toEqual(message);
	});

	test("rejects a session_progress event missing sequence or turnId", () => {
		const base = { type: "event", event: { type: "session_progress", sessionId: "session-1" } };
		expect(() => parseServerMessage(base)).toThrow(ProtocolValidationError);
		expect(() => parseServerMessage({ ...base, event: { ...base.event, turnId: "turn-1" } })).toThrow(
			ProtocolValidationError,
		);
		expect(() => parseServerMessage({ ...base, event: { ...base.event, sequence: 1 } })).toThrow(
			ProtocolValidationError,
		);
	});

	test.each([
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
	] as const)("rejects a %s session_progress sequence", (_label, sequence) => {
		expect(() => parseServerMessage(progressEvent(sequence))).toThrow(ProtocolValidationError);
	});

	test("rejects a session_progress event with an unknown field", () => {
		const message = progressEvent(1) as Record<string, unknown>;
		(message.event as Record<string, unknown>).extra = true;
		expect(() => parseServerMessage(message)).toThrow(ProtocolValidationError);
	});

	test("parses a resume command with a zero afterSequence", () => {
		const request = {
			type: "request",
			id: "request-1",
			request: { command: "resume", sessionId: "session-1", afterSequence: 0 },
		};
		expect(parseClientMessage(request)).toEqual(request);
	});

	test.each([-1, -2, 1.5])("rejects a resume command with afterSequence %s", (afterSequence) => {
		expect(() =>
			parseClientMessage({
				type: "request",
				id: "request-1",
				request: { command: "resume", sessionId: "session-1", afterSequence },
			}),
		).toThrow(ProtocolValidationError);
	});

	test("rejects a resume command with an unknown field", () => {
		expect(() =>
			parseClientMessage({
				type: "request",
				id: "request-1",
				request: { command: "resume", sessionId: "session-1", afterSequence: 0, extra: true },
			}),
		).toThrow(ProtocolValidationError);
	});

	test("parses a resume result", () => {
		const response = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { command: "resume", session: sessionSnapshotForProtocol(), replayedThrough: 3, resetRequired: false },
		};
		expect(parseServerMessage(response)).toEqual(response);
	});

	test("rejects a resume result without resetRequired", () => {
		expect(() =>
			parseServerMessage({
				type: "response",
				id: "request-1",
				ok: true,
				result: { command: "resume", session: sessionSnapshotForProtocol(), replayedThrough: 3 },
			}),
		).toThrow(ProtocolValidationError);
	});

	test("parses a session snapshot carrying lastSequence", () => {
		const event = { type: "event", event: { type: "session_snapshot", snapshot: sessionSnapshotForProtocol() } };
		expect(parseServerMessage(event)).toEqual(event);
	});

	test("rejects a session snapshot without lastSequence", () => {
		const snapshot = sessionSnapshotForProtocol() as { lastSequence?: number };
		delete snapshot.lastSequence;
		expect(() => parseServerMessage({ type: "event", event: { type: "session_snapshot", snapshot } })).toThrow(
			ProtocolValidationError,
		);
	});
});

describe("protocol P1 file upload attachments", () => {
	function attachmentForProtocol() {
		return {
			id: "upload-1",
			name: "notes.txt",
			mediaType: "text/plain",
			size: 42,
			sha256: "abc123",
			status: "ready",
			scope: "turn",
			createdAt: 1,
		};
	}

	test("parses an attachment_snapshot event", () => {
		const message = { type: "event", event: { type: "attachment_snapshot", attachment: attachmentForProtocol() } };
		expect(parseServerMessage(message)).toEqual(message);
	});

	test("parses an attachment_snapshot event for an unbound upload", () => {
		const attachment = { ...attachmentForProtocol(), sessionId: undefined, scope: undefined } as Record<
			string,
			unknown
		>;
		delete attachment.scope;
		delete attachment.sessionId;
		expect(parseServerMessage({ type: "event", event: { type: "attachment_snapshot", attachment } })).toEqual({
			type: "event",
			event: { type: "attachment_snapshot", attachment },
		});
	});

	test("rejects an attachment_snapshot event missing size or sha256", () => {
		const attachment = attachmentForProtocol() as Record<string, unknown>;
		delete attachment.size;
		expect(() => parseServerMessage({ type: "event", event: { type: "attachment_snapshot", attachment } })).toThrow(
			ProtocolValidationError,
		);
	});

	test("rejects an attachment_snapshot event with an unknown field", () => {
		const attachment = attachmentForProtocol() as Record<string, unknown>;
		attachment.extra = true;
		expect(() => parseServerMessage({ type: "event", event: { type: "attachment_snapshot", attachment } })).toThrow(
			ProtocolValidationError,
		);
	});

	test("parses an attachment_removed event", () => {
		const message = {
			type: "event",
			event: { type: "attachment_removed", sessionId: "session-1", attachmentId: "upload-1" },
		};
		expect(parseServerMessage(message)).toEqual(message);
	});

	test("parses an attach_upload command", () => {
		const request = {
			type: "request",
			id: "request-1",
			request: { command: "attach_upload", sessionId: "session-1", uploadId: "upload-1", scope: "turn" },
		};
		expect(parseClientMessage(request)).toEqual(request);
	});

	test("rejects an attach_upload command with an unknown scope", () => {
		expect(() =>
			parseClientMessage({
				type: "request",
				id: "request-1",
				request: { command: "attach_upload", sessionId: "session-1", uploadId: "upload-1", scope: "forever" },
			}),
		).toThrow(ProtocolValidationError);
	});

	test("rejects an attach_upload command missing scope or uploadId", () => {
		expect(() =>
			parseClientMessage({
				type: "request",
				id: "request-1",
				request: { command: "attach_upload", sessionId: "session-1", uploadId: "upload-1" },
			}),
		).toThrow(ProtocolValidationError);
		expect(() =>
			parseClientMessage({
				type: "request",
				id: "request-1",
				request: { command: "attach_upload", sessionId: "session-1", scope: "turn" },
			}),
		).toThrow(ProtocolValidationError);
	});

	test("parses a remove_attachment command", () => {
		const request = {
			type: "request",
			id: "request-1",
			request: { command: "remove_attachment", sessionId: "session-1", attachmentId: "upload-1" },
		};
		expect(parseClientMessage(request)).toEqual(request);
	});

	test("parses prompt and steer commands carrying optional attachmentIds", () => {
		const request = {
			type: "request",
			id: "request-1",
			request: { command: "prompt", sessionId: "session-1", text: "hello", attachmentIds: ["upload-1", "upload-2"] },
		};
		expect(parseClientMessage(request)).toEqual(request);
		const steer = {
			type: "request",
			id: "request-2",
			request: { command: "steer", sessionId: "session-1", text: "hi", attachmentIds: [] },
		};
		expect(parseClientMessage(steer)).toEqual(steer);
	});

	test("rejects a prompt command with non-string attachmentIds", () => {
		expect(() =>
			parseClientMessage({
				type: "request",
				id: "request-1",
				request: { command: "prompt", sessionId: "session-1", text: "hi", attachmentIds: [1] },
			}),
		).toThrow(ProtocolValidationError);
	});

	test("parses attach_upload and remove_attachment results", () => {
		const attachResult = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { command: "attach_upload", session: sessionSnapshotForProtocol() },
		};
		expect(parseServerMessage(attachResult)).toEqual(attachResult);
		const removeResult = {
			type: "response",
			id: "request-2",
			ok: true,
			result: { command: "remove_attachment", session: sessionSnapshotForProtocol() },
		};
		expect(parseServerMessage(removeResult)).toEqual(removeResult);
	});

	test("parses a session snapshot carrying attachments", () => {
		const snapshot = { ...sessionSnapshotForProtocol(), attachments: [attachmentForProtocol()] };
		const event = { type: "event", event: { type: "session_snapshot", snapshot } };
		expect(parseServerMessage(event)).toEqual(event);
	});

	test("rejects a session snapshot carrying a malformed attachment", () => {
		const snapshot = {
			...sessionSnapshotForProtocol(),
			attachments: [{ id: "upload-1", name: "notes.txt", status: "ready" }],
		};
		expect(() => parseServerMessage({ type: "event", event: { type: "session_snapshot", snapshot } })).toThrow(
			ProtocolValidationError,
		);
	});

	test("accepts the extended protocol error codes used by uploads", () => {
		for (const code of [
			"unauthorized",
			"forbidden",
			"payload_too_large",
			"unsupported_media_type",
			"conflict",
			"expired",
		]) {
			const response = { type: "response", id: "request-1", ok: false, error: { code, message: "nope" } };
			expect(parseServerMessage(response)).toEqual(response);
		}
	});
});
