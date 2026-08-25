import type { SessionSnapshot, Usage } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { lastAssistantResult, managedTurnExecutor } from "../../src/runtime/turn-executor.ts";

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
});
