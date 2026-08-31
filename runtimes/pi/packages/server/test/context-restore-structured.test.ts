import { describe, expect, it } from "vitest";
import { toAgentMessages } from "../src/coding-agent/history-mapper.ts";
import { mergeRestored, restoreContext } from "../src/runtime/context-restore.ts";
import type { ConversationEventRecord } from "../src/publishing/repositories.ts";
import { toToolCallEventPayload, toToolResultEventPayload } from "../src/runtime/tool-event-payload.ts";

function evt(
	sequence: number,
	eventType: string,
	turnId: string,
	payload: Record<string, unknown>,
): ConversationEventRecord {
	return {
		eventId: `ev-${sequence}` as ConversationEventRecord["eventId"],
		tenantId: "t" as ConversationEventRecord["tenantId"],
		publishedAppId: "a" as ConversationEventRecord["publishedAppId"],
		conversationId: "c" as ConversationEventRecord["conversationId"],
		sequence,
		eventType,
		eventSchemaVersion: 1,
		turnId: turnId as ConversationEventRecord["turnId"],
		payload,
		payloadBytes: 0,
		createdAt: new Date(0),
	};
}

describe("restoreContext structured transcript (Phase-1)", () => {
	it("reconstructs user -> assistant toolCall -> toolResult -> assistant as native transcript", () => {
		const events = [
			evt(1, "turn/start", "t1", { model: "m" }),
			evt(2, "user/message", "t1", { text: "list the file" }),
			evt(3, "tool/call", "t1", { toolCallId: "call-1", toolName: "readfile", input: { path: "a.txt" } }),
			evt(4, "tool/result", "t1", {
				toolCallId: "call-1",
				toolName: "readfile",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				truncated: false,
			}),
			evt(5, "assistant/message", "t1", { text: "done" }),
		];
		const restored = restoreContext(events, { maxContextTokens: 10_000 });

		expect(restored.transcript.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const toolCall = restored.transcript[1];
		const toolResult = restored.transcript[2];
		if (toolCall.role !== "assistant" || toolResult.role !== "toolResult") throw new Error("shape");
		expect(toolCall.content[0]).toMatchObject({
			type: "toolCall",
			toolCallId: "call-1",
			toolName: "readfile",
			input: { path: "a.txt" },
		});
		// toolCallId pairing is preserved between the toolCall and its toolResult.
		expect(toolResult.toolCallId).toBe("call-1");
		expect(toolResult.content[0]).toMatchObject({ type: "text", text: "file contents" });
		expect(toolResult.isError).toBe(false);
		// final assistant text is the last native message.
		expect(restored.transcript[3].role).toBe("assistant");
	});

	it("keeps tool arguments as a JSON object, not a flattened string", () => {
		const args = { path: "x", count: 2, nested: { ok: true } };
		const events = [
			evt(1, "user/message", "t1", { text: "u" }),
			evt(2, "tool/call", "t1", { toolCallId: "c", toolName: "n", input: args }),
		];
		const restored = restoreContext(events, { maxContextTokens: 10_000 });
		const toolCall = restored.transcript.find((m) => m.role === "assistant")!;
		const block = toolCall.content[0];
		expect(block.type).toBe("toolCall");
		expect((block as { input?: unknown }).input).toEqual(args);
		expect(typeof (block as { input?: unknown }).input).toBe("object");
	});

	it("reconstructs tool/error as an error toolResult with the error text", () => {
		const events = [
			evt(1, "user/message", "t1", { text: "u" }),
			evt(2, "tool/call", "t1", { toolCallId: "e1", toolName: "ex", input: {} }),
			evt(3, "tool/error", "t1", { toolCallId: "e1", toolName: "ex", error: "boom" }),
		];
		const restored = restoreContext(events, { maxContextTokens: 10_000 });
		const toolResult = restored.transcript[restored.transcript.length - 1];
		expect(toolResult.role).toBe("toolResult");
		if (toolResult.role !== "toolResult") throw new Error("shape");
		expect(toolResult.isError).toBe(true);
		expect(toolResult.toolCallId).toBe("e1");
		expect(toolResult.content[0]).toMatchObject({ type: "text", text: "boom" });
	});

	it("backward-compat: old tool/call without input and old tool/result without content degrade safely", () => {
		const events = [
			evt(1, "user/message", "t1", { text: "u" }),
			evt(2, "tool/call", "t1", { toolCallId: "old", toolName: "n" }), // no input
			evt(3, "tool/result", "t1", { toolCallId: "old", toolName: "n" }), // no content
			evt(4, "assistant/message", "t1", { text: "final" }),
		];
		const restored = restoreContext(events, { maxContextTokens: 10_000 });
		expect(restored.transcript.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const toolCall = restored.transcript[1];
		if (toolCall.role !== "assistant") throw new Error("shape");
		expect((toolCall.content[0] as { input?: unknown }).input).toBeUndefined(); // not fabricated
		const toolResult = restored.transcript[2];
		if (toolResult.role !== "toolResult") throw new Error("shape");
		expect(toolResult.content).toEqual([]); // empty, never invented
	});

	it("does not fabricate an assistant(missing tool call) pairing without a preceding user", () => {
		const events = [evt(1, "assistant/message", "t1", { text: "orphan" })];
		const restored = restoreContext(events, { maxContextTokens: 10_000 });
		expect(restored.transcript).toEqual([]);
	});

	it("marks an incomplete user turn (no completion) as interrupted and excludes it", () => {
		const events = [evt(1, "user/message", "t1", { text: "abandoned" })];
		const restored = restoreContext(events, { maxContextTokens: 10_000 });
		expect(restored.transcript).toEqual([]);
		expect(restored.interruptedTurnIds).toContain("t1");
	});

	it("summary + structured recent tool history merge preserves native structure", () => {
		const recent = restoreContext(
			[
				evt(10, "user/message", "t9", { text: "follow up" }),
				evt(11, "tool/call", "t9", { toolCallId: "c9", toolName: "read", input: { p: 1 } }),
				evt(12, "tool/result", "t9", {
					toolCallId: "c9",
					toolName: "read",
					content: [{ type: "text", text: "r" }],
				}),
				evt(13, "assistant/message", "t9", { text: "answered" }),
			],
			{ maxContextTokens: 10_000 },
		);
		const summary: ReturnType<typeof restoreContext> = {
			messages: [
				{ role: "user", text: "[summary]" },
				{ role: "assistant", text: "ok" },
			],
			transcript: [
				{ role: "user", content: [{ type: "text", text: "[summary]" }] },
				{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			],
			turns: [
				{
					turnId: null,
					items: [
						{ role: "user", content: [{ type: "text", text: "[summary]" }] },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
					],
				},
			],
			interruptedTurnIds: [],
			skippedEvents: 0,
			droppedChunks: 0,
			errorEventCount: 0,
			observedLogLevel: "standard",
		};
		const merged = mergeRestored(summary, recent);
		expect(merged.transcript.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		// The tool turn survives after the summary header.
		const toolCall = merged.transcript[3];
		expect(toolCall.role).toBe("assistant");
		expect((toolCall.content[0] as { type: string }).type).toBe("toolCall");
		expect(merged.transcript[4].role).toBe("toolResult");
	});
});
describe("Phase-2.5: tool input/result survive a Postgres-only rebuild", () => {
	const spec = {
		capabilities: {
			skills: [],
			mcpServers: [],
			tools: [],
			knowledgeBases: [],
			uploads: {},
			speech: {},
			avatar: {},
			conversations: {},
		},
		agent: { systemPrompt: "", model: { provider: "", modelId: "" } },
	} as unknown as Parameters<typeof toToolCallEventPayload>[0];

	function txItem(partial: Record<string, unknown>) {
		return {
			id: "i",
			role: "tool",
			input: null,
			content: [],
			status: "running",
			isError: false,
			timestamp: 100,
			...partial,
		} as unknown as import("@earendil-works/pi-protocol").ToolTranscriptItem;
	}

	// Requirement A: tool arguments above the old 64 KB inline budget are stored
	// fully and reconstructed verbatim into the next model context after rebuild.
	it("rebuild restores tool arguments > 64 KB exactly", () => {
		const hugeArgs = { blob: "z".repeat(90 * 1024), nested: { ok: true } };
		const callEvent = toToolCallEventPayload(
			spec,
			txItem({ toolCallId: "call-big", toolName: "write", input: hugeArgs }),
		);
		const events = [
			evt(1, "user/message", "t1", { text: "go" }),
			evt(2, "tool/call", "t1", { toolCallId: "call-big", toolName: "write", input: callEvent.input }),
			evt(3, "tool/result", "t1", {
				toolCallId: "call-big",
				toolName: "write",
				content: [{ type: "text", text: "ok" }],
			}),
			evt(4, "assistant/message", "t1", { text: "done" }),
		];
		const restored = restoreContext(events, { maxContextTokens: 1_000_000 });
		const toolCall = restored.transcript.find((m) => m.role === "assistant")!;
		const block = toolCall.content[0];
		expect(block).toMatchObject({ type: "toolCall", toolCallId: "call-big", toolName: "write" });
		if (block.type !== "toolCall") throw new Error("shape");
		expect(block.input).toEqual(hugeArgs);

		// And it lands in the coding-agent's native assistant(toolCall) message.
		const agent = toAgentMessages(restored.transcript, { provider: "p", model: "m", now: 0 });
		const asst = agent.find((m) => m.role === "assistant");
		expect(asst?.role).toBe("assistant");
		if (asst?.role !== "assistant") throw new Error("shape");
		const callBlock = asst.content.find((b) => (b as { type?: string }).type === "toolCall") as {
			type: string;
			arguments?: Record<string, unknown>;
			id?: string;
		};
		expect(callBlock.arguments).toEqual(hugeArgs);
		expect(JSON.stringify(callBlock.arguments).length).toBeGreaterThan(90 * 1024);
	});

	// Requirement B: result content at / above the old 128 KB inline budget is
	// persisted verbatim — Event content === model-visible content, no re-truncation.
	it("rebuild restores a large tool result verbatim (no second truncation)", () => {
		const bigText = "k".repeat(200 * 1024);
		const resultEvent = toToolResultEventPayload(
			spec,
			txItem({
				toolCallId: "call-big-result",
				toolName: "mcp",
				status: "complete",
				content: [{ type: "text", text: bigText }],
			}),
		);
		const events = [
			evt(1, "user/message", "t1", { text: "u" }),
			evt(2, "tool/call", "t1", { toolCallId: "call-big-result", toolName: "mcp", input: {} }),
			evt(3, "tool/result", "t1", {
				toolCallId: "call-big-result",
				toolName: "mcp",
				content: resultEvent.content,
				isError: false,
				truncated: resultEvent.truncated,
			}),
			evt(4, "assistant/message", "t1", { text: "ok" }),
		];
		const restored = restoreContext(events, { maxContextTokens: 1_000_000 });
		const toolResult = restored.transcript.find((m) => m.role === "toolResult");
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role !== "toolResult") throw new Error("shape");
		expect(toolResult.content[0]).toEqual({ type: "text", text: bigText });
	});
});
