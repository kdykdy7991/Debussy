import type { ToolTranscriptItem } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import type { RuntimeSpec } from "../src/publishing/runtime-spec/schema.ts";
import {
	toToolCallEventPayload,
	toToolProgressEvent,
	toToolResultEventPayload,
} from "../src/runtime/tool-event-payload.ts";

/** Minimal spec with no skills / no MCP => any tool derives to "builtin". */
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
} as unknown as RuntimeSpec;

function toolItem(partial: { toolCallId: string; toolName: string } & Record<string, unknown>): ToolTranscriptItem {
	return {
		id: "i",
		role: "tool",
		input: null,
		content: [],
		status: "running",
		isError: false,
		timestamp: 100,
		...partial,
	} as unknown as ToolTranscriptItem;
}

describe("toToolCallEventPayload (Phase-1 arguments)", () => {
	it("persists the full arguments as JSON (not flattened to text)", () => {
		const args = { path: "/tmp/a.txt", count: 3, nested: { ok: true } };
		const payload = toToolCallEventPayload(spec, toolItem({ toolCallId: "c1", toolName: "read", input: args }));
		expect(payload.toolCallId).toBe("c1");
		expect(payload.toolName).toBe("read");
		expect(payload.status).toBe("running");
		expect(payload.input).toEqual(args);
		expect(typeof payload.input).toBe("object");
		expect("inputTruncated" in payload).toBe(false);
	});

	it("persists oversized arguments fully (no 64 KB drop) so rebuild can restore them", () => {
		const huge = { blob: "x".repeat(100 * 1024), nested: { ok: true } };
		const payload = toToolCallEventPayload(spec, toolItem({ toolCallId: "c2", toolName: "write", input: huge }));
		// The full model-generated arguments are kept as JSONB — never dropped,
		// never re-truncated — so a Postgres-only rebuild can reproduce them.
		expect(payload.input).toEqual(huge);
		expect(Buffer.byteLength(JSON.stringify(payload.input), "utf8")).toBeGreaterThan(64 * 1024);
		expect("inputTruncated" in payload).toBe(false);
	});
});

describe("toToolResultEventPayload (Phase-1 content)", () => {
	it("persists the model-visible result content with toolCallId pairing", () => {
		const content = [{ type: "text" as const, text: "the result" }];
		const payload = toToolResultEventPayload(
			spec,
			toolItem({ toolCallId: "c1", toolName: "read", status: "complete", content }),
		);
		expect(payload.toolCallId).toBe("c1");
		expect(payload.status).toBe("complete");
		expect(payload.isError).toBe(false);
		expect(payload.truncated).toBe(false);
		expect(payload.content).toEqual([{ type: "text", text: "the result" }]);
	});

	it("records isError from the runtime item", () => {
		const payload = toToolResultEventPayload(
			spec,
			toolItem({ toolCallId: "c2", toolName: "exec", status: "complete", isError: true, content: [] }),
		);
		expect(payload.isError).toBe(true);
	});

	it("routes Production + Debug through one shared toToolProgressEvent (parity)", () => {
		const item = toolItem({ toolCallId: "p1", toolName: "read", input: { path: "a" } });
		// item_started + running -> tool/call with arguments
		const call = toToolProgressEvent(spec, "item_started", item);
		expect(call?.eventType).toBe("tool/call");
		expect((call?.payload as { input?: unknown }).input).toEqual({ path: "a" });

		// item_updated never produces an event
		expect(toToolProgressEvent(spec, "item_updated", item)).toBeNull();

		// item_finished complete -> tool/result with content
		const result = toToolProgressEvent(
			spec,
			"item_finished",
			toolItem({ toolCallId: "p1", toolName: "read", status: "complete", content: [{ type: "text", text: "ok" }] }),
		);
		expect(result?.eventType).toBe("tool/result");
		expect((result?.payload as { content: unknown[] }).content[0]).toMatchObject({ type: "text", text: "ok" });

		// item_finished error -> tool/error with message + isError:true
		const err = toToolProgressEvent(
			spec,
			"item_finished",
			toolItem({ toolCallId: "p1", toolName: "read", status: "error", content: [{ type: "text", text: "boom" }] }),
		);
		expect(err?.eventType).toBe("tool/error");
		const ep = err?.payload as { error: string; isError: boolean };
		expect(ep.error).toBe("boom");
		expect(ep.isError).toBe(true);
	});

	it("flags truncation from the runtime details only (no second event truncation)", () => {
		const runtimeTruncated = toToolResultEventPayload(
			spec,
			toolItem({
				toolCallId: "c3",
				toolName: "mcp",
				status: "complete",
				content: [{ type: "text", text: "ok" }],
				details: { mcpServerId: "s", resultTruncated: true },
			}),
		);
		expect(runtimeTruncated.truncated).toBe(true);
	});

	// Requirement 2.5-B: when runtime model-visible bound is raised above the old
	// 128 KB inline budget, the event must persist that content verbatim instead
	// of re-truncating it. `toToolResultEventPayload` applies no independent
	// truncation, so Event content === model-visible content exactly.
	it("persists result content verbatim even above 128 KB (no independent re-truncation)", () => {
		const bigText = "b".repeat(200 * 1024);
		const big = toToolResultEventPayload(
			spec,
			toolItem({
				toolCallId: "c4",
				toolName: "mcp",
				status: "complete",
				content: [{ type: "text", text: bigText }],
			}),
		);
		expect(big.truncated).toBe(false);
		expect(big.content).toEqual([{ type: "text", text: bigText }]);
		expect(Buffer.byteLength(bigText, "utf8")).toBeGreaterThan(128 * 1024);
	});

	it("keeps tool usage when the runtime reported it", () => {
		const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 };
		const payload = toToolResultEventPayload(
			spec,
			toolItem({ toolCallId: "c5", toolName: "read", status: "complete", content: [], usage }),
		);
		expect(payload.usage).toEqual(usage);
	});

	it("produces identical payloads for the same input (parity primitive)", () => {
		const item = toolItem({
			toolCallId: "c6",
			toolName: "read",
			status: "complete",
			content: [{ type: "text", text: "x" }],
		});
		const a = toToolResultEventPayload(spec, item);
		const b = toToolResultEventPayload(spec, item);
		expect(a).toEqual(b);
	});
});
