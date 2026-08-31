import { describe, expect, it } from "vitest";
import { toAgentMessages } from "../src/coding-agent/history-mapper.ts";
import type { TranscriptMessage } from "../src/types.ts";

describe("toAgentMessages (structured -> native Pi messages, Phase-1)", () => {
	it("maps a tool turn to user / assistant(toolCall) / toolResult / assistant", () => {
		const transcript: TranscriptMessage[] = [
			{ role: "user", content: [{ type: "text", text: "list" }] },
			{
				role: "assistant",
				content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "a" } }],
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "data" }],
			},
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];
		const msgs = toAgentMessages(transcript, { provider: "p", model: "m", now: 1 });

		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const toolCallMsg = msgs[1];
		expect(toolCallMsg.role).toBe("assistant");
		if (toolCallMsg.role !== "assistant") throw new Error("shape");
		expect(toolCallMsg.content[0]).toMatchObject({ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } });
		expect(toolCallMsg.stopReason).toBe("toolUse");

		const toolResultMsg = msgs[2];
		expect(toolResultMsg.role).toBe("toolResult");
		if (toolResultMsg.role !== "toolResult") throw new Error("shape");
		expect(toolResultMsg.toolCallId).toBe("call-1");
		expect(toolResultMsg.content[0]).toMatchObject({ type: "text", text: "data" });
		expect(toolResultMsg.isError).toBe(false);

		const final = msgs[3];
		expect(final.role).toBe("assistant");
		if (final.role !== "assistant") throw new Error("shape");
		expect(final.stopReason).toBe("stop");
		// all timestamps set (normalised)
		expect(msgs.every((m) => m.timestamp >= 1)).toBe(true);
	});

	it("preserves tool error semantics", () => {
		const msgs = toAgentMessages(
			[
				{ role: "toolResult", toolCallId: "e", toolName: "x", isError: true, content: [{ type: "text", text: "boom" }] },
			] as TranscriptMessage[],
			{ now: 2 },
		);
		expect(msgs[0].role).toBe("toolResult");
		if (msgs[0].role !== "toolResult") throw new Error("shape");
		expect(msgs[0].isError).toBe(true);
	});

	it("empty transcript maps to no native messages", () => {
		expect(toAgentMessages([])).toEqual([]);
	});
});