import type { SessionSnapshot, Usage } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { lastAssistantResult } from "../../src/runtime/turn-executor.ts";

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
});
