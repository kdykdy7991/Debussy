import type { SessionSnapshot, TranscriptProgress, Usage } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { createLlmUsageCollector, lastAssistantResult, managedTurnExecutor } from "../../src/runtime/turn-executor.ts";

const USAGE: Usage = {
	input: 120,
	output: 30,
	cacheRead: 80,
	cacheWrite: 0,
	totalTokens: 150,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("lastAssistantResult", () => {
	it("returns provider usage with the final completed assistant text", () => {
		const snapshot = {
			transcript: [
				{
					id: "msg_1",
					role: "assistant",
					status: "complete",
					content: [{ type: "text", text: "done" }],
					usage: USAGE,
				},
			],
		} as unknown as SessionSnapshot;

		expect(lastAssistantResult(snapshot)).toEqual({ outputText: "done", usage: USAGE });
	});

	it("does not invent usage when the provider omitted it", () => {
		const snapshot = {
			transcript: [
				{ id: "msg_1", role: "assistant", status: "complete", content: [{ type: "text", text: "done" }] },
			],
		} as unknown as SessionSnapshot;

		expect(lastAssistantResult(snapshot)).toEqual({ outputText: "done" });
	});

	it("preserves non-redacted thinking for the shared transcript", () => {
		const snapshot = {
			transcript: [
				{
					id: "msg_1",
					role: "assistant",
					status: "complete",
					content: [
						{ type: "thinking", thinking: "reasoning", redacted: false },
						{ type: "text", text: "done" },
					],
				},
			],
		} as unknown as SessionSnapshot;

		expect(lastAssistantResult(snapshot)).toEqual({ outputText: "done", thinkingText: "reasoning" });
	});
});

describe("managedTurnExecutor progress", () => {
	it("subscribes before prompt and forwards the runtime's real structured deltas", async () => {
		const progress = {
			type: "assistant_delta" as const,
			messageId: "msg_1",
			contentIndex: 0,
			kind: "thinking" as const,
			delta: "reasoning",
		};
		let listener: ((event: unknown) => void) | undefined;
		let released = false;
		const runtime = {
			subscribe(next: (event: unknown) => void) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			async prompt() {
				listener?.({ type: "progress", event: { type: "progress", progress } });
			},
			snapshot() {
				return {
					transcript: [
						{
							id: "msg_1",
							role: "assistant",
							status: "complete",
							content: [
								{ type: "thinking", thinking: "reasoning", redacted: false },
								{ type: "text", text: "done" },
							],
						},
					],
				};
			},
		};
		const executor = managedTurnExecutor({
			acquire: async () => ({ runtime, created: true }),
			release: () => {
				released = true;
			},
		} as never);
		const seen: unknown[] = [];
		const result = await executor({
			scope: { conversationId: "conv_1" } as never,
			spec: {} as never,
			text: "hello",
			onProgress: (event) => seen.push(event),
		});

		expect(seen).toEqual([progress]);
		expect(result).toMatchObject({ ok: true, outputText: "done", thinkingText: "reasoning" });
		expect(released).toBe(true);
	});

	it("collects every completed model call without counting restored history or duplicate events", async () => {
		const events = [
			// Restored history is injected without progress events.
			{ type: "item_started", item: { id: "history_1", role: "assistant", status: "streaming" } },
			assistantFinished("msg_1", 100, 10, 110),
			assistantFinished("msg_2", 200, 20, 220, "toolUse"),
			assistantFinished("msg_3", 300, 30, 330),
			assistantFinished("msg_1", 999, 999, 1998), // duplicate progress
			{ type: "item_finished", item: { id: "tool_1", role: "tool", status: "complete" } },
		];
		let listener: ((event: unknown) => void) | undefined;
		const runtime = {
			subscribe(next: (event: unknown) => void) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			async prompt() {
				for (const progress of events) {
					listener?.({ type: "progress", event: { type: "progress", progress } });
				}
			},
			snapshot() {
				return {
					transcript: [
						{
							id: "msg_3",
							role: "assistant",
							status: "complete",
							content: [{ type: "text", text: "done" }],
							usage: USAGE,
						},
					],
				};
			},
		};
		const executor = managedTurnExecutor({
			acquire: async () => ({ runtime, created: true }),
			release: () => undefined,
		} as never);
		const result = await executor({ scope: { conversationId: "conv_1" } as never, spec: {} as never, text: "hello" });
		expect(result).toMatchObject({ ok: true, outputText: "done", usage: USAGE });
		if (!result.ok) throw new Error("executor failed");
		expect(result.llmUsage?.callCount).toBe(3);
		expect(result.llmUsage?.partial).toBe(false);
		expect(result.llmUsage?.total).toEqual({
			input: 600,
			output: 60,
			cacheRead: 240,
			cacheWrite: 0,
			totalTokens: 660,
		});
	});
});

describe("createLlmUsageCollector", () => {
	it("marks the Turn partial when a completed model call has no provider usage", () => {
		const collector = createLlmUsageCollector();
		collector.observe(assistantFinished("msg_1", 100, 10, 110));
		collector.observe({
			type: "item_finished",
			item: {
				id: "msg_2",
				role: "assistant",
				status: "complete",
				content: [{ type: "text", text: "done" }],
				model: { provider: "oneapi", id: "Qwen" },
				timestamp: 2,
			},
		} as unknown as TranscriptProgress);
		const result = collector.result();
		expect(result?.callCount).toBe(1);
		expect(result?.partial).toBe(true);
		expect(result?.total.totalTokens).toBe(110);
	});

	it("keeps already collected calls even if the final snapshot was compacted", () => {
		const collector = createLlmUsageCollector();
		collector.observe(assistantFinished("msg_1", 100, 10, 110, "toolUse"));
		collector.observe(assistantFinished("msg_2", 200, 20, 220));
		// A compaction/recovery can rebuild the snapshot without these items;
		// the collector holds the completion-boundary facts independently.
		expect(collector.result()).toMatchObject({ callCount: 2, partial: false, total: { totalTokens: 330 } });
		expect(collector.result()).toMatchObject({ callCount: 2 });
	});

	it("returns nothing when no model call completed", () => {
		const collector = createLlmUsageCollector();
		collector.observe({ type: "item_started", item: { id: "history", role: "assistant" } } as never);
		expect(collector.result()).toBeUndefined();
	});
});

function assistantFinished(
	id: string,
	input: number,
	output: number,
	totalTokens: number,
	stopReason: "stop" | "toolUse" = "stop",
): TranscriptProgress {
	return {
		type: "item_finished",
		item: {
			id,
			role: "assistant",
			status: "complete",
			stopReason,
			content: [{ type: "text", text: "step" }],
			model: { provider: "oneapi", id: "Qwen" },
			usage: { ...USAGE, input, output, totalTokens },
			timestamp: 1,
		},
	} as unknown as TranscriptProgress;
}
