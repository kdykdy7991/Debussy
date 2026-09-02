import { describe, expect, test, vi } from "vitest";
import type { RawData } from "ws";
import type { ConversationService } from "../src/embed/conversations/service.ts";
import type { EmbedAuthContext } from "../src/embed/middleware/authenticate.ts";
import { runtimeUnavailable } from "../src/publishing/domain/errors.ts";
import {
	newConversationId,
	newPrincipalId,
	newPublishedAppId,
	newPublishedAppVersionId,
	newTenantId,
	newTurnId,
} from "../src/publishing/domain/ids.ts";
import { loadVoicePocConfig } from "../src/voice-poc/config.ts";
import { VoicePocConnection, type VoicePocTransport } from "../src/voice-poc/connection.ts";

describe("Voice POC configuration", () => {
	test("stays disabled when every setting is absent", () => {
		expect(loadVoicePocConfig({})).toBeUndefined();
	});

	test("loads a token-only binding", () => {
		expect(loadVoicePocConfig({ VOICE_POC_TOKEN: "poc-secret" })).toEqual({ token: "poc-secret" });
	});

	test("rejects an empty token", () => {
		expect(() => loadVoicePocConfig({ VOICE_POC_TOKEN: "" })).toThrow(/must not be empty/);
	});
});

describe("Voice POC connection", () => {
	test("forwards only visible text deltas and finishes the turn", async () => {
		const transport = new FakeTransport();
		const service: Pick<ConversationService, "executeTurn"> = {
			executeTurn: vi.fn(async (input) => {
				input.onProgress?.({
					type: "assistant_delta",
					messageId: "message-1",
					contentIndex: 0,
					kind: "thinking",
					delta: "hidden",
				});
				input.onProgress?.({
					type: "assistant_delta",
					messageId: "message-1",
					contentIndex: 0,
					kind: "text",
					delta: "你好",
				});
				return {
					ok: true as const,
					data: {
						turnId: newTurnId(),
						userMessageSequence: 1,
						assistantSequence: 2,
						outputText: "你好",
						citations: [],
					},
				};
			}),
		};
		new VoicePocConnection({
			transport,
			service,
			principal: principal(),
			conversationId: newConversationId(),
		});

		transport.receive(JSON.stringify({ type: "turn.start", text: "你好" }));
		await vi.waitFor(() => expect(transport.messages).toHaveLength(2));
		expect(transport.messages.map((message) => JSON.parse(message))).toEqual([
			{ type: "text.delta", text: "你好" },
			{ type: "text.done" },
		]);
	});

	test("rejects malformed and overlapping turns", async () => {
		const transport = new FakeTransport();
		let finish: (() => void) | undefined;
		const service: Pick<ConversationService, "executeTurn"> = {
			executeTurn: () =>
				new Promise((resolve) => {
					finish = () =>
						resolve({
							ok: false,
							error: runtimeUnavailable("stopped"),
						});
				}),
		};
		new VoicePocConnection({
			transport,
			service,
			principal: principal(),
			conversationId: newConversationId(),
		});

		transport.receive("not-json");
		transport.receive(JSON.stringify({ type: "turn.start", text: "first" }));
		transport.receive(JSON.stringify({ type: "turn.start", text: "second" }));
		await vi.waitFor(() => expect(transport.messages).toHaveLength(2));
		expect(transport.messages.map((message) => JSON.parse(message))).toEqual([
			{ type: "error", message: "invalid JSON" },
			{ type: "error", message: "turn already running" },
		]);
		finish?.();
	});
});

class FakeTransport implements VoicePocTransport {
	readonly messages: string[] = [];
	private messageListener: ((data: RawData) => void) | undefined;

	send(payload: string): void {
		this.messages.push(payload);
	}

	onMessage(listener: (data: RawData) => void): void {
		this.messageListener = listener;
	}

	onClose(_listener: () => void): void {}

	receive(payload: string): void {
		this.messageListener?.(Buffer.from(payload));
	}
}

function principal(): EmbedAuthContext {
	return {
		tokenId: "voice-poc",
		tenantId: newTenantId(),
		publishedAppId: newPublishedAppId(),
		principalId: newPrincipalId(),
		principalType: "service",
		scopes: [],
		issuedAt: new Date(),
		expiresAt: new Date(8640000000000000),
		publishedAppVersionId: newPublishedAppVersionId(),
	};
}
