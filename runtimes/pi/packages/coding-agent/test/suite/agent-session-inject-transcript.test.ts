import { describe, expect, it } from "vitest";
import type { AssistantMessage, ToolResultMessage, UserMessage, Usage } from "@earendil-works/pi-ai";
import { createHarness, type Harness } from "./harness.ts";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Reconstructed native message sequence from a Phase-1 structured restore. */
function nativeToolTurn(h: Harness): (UserMessage | AssistantMessage | ToolResultMessage)[] {
	const now = Date.now();
	const model = h.getModel();
	return [
		{ role: "user", content: "list the file", timestamp: now },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "readfile", arguments: { path: "a.txt" } }],
			api: model.provider,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "toolUse",
			timestamp: now,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "readfile",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: now,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: model.provider,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: now,
		},
	];
}

describe("AgentSession.injectTranscript (Phase-1 native history injection)", () => {
	it("seeds native assistant(toolCall) + toolResult into the next model context", async () => {
		const h = await createHarness();
		try {
			const native = nativeToolTurn(h);
			await h.session.injectTranscript(native);

			// state.messages is the model-request context source: it must carry the
			// reconstructed native turns in order.
			expect(h.session.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);

			const tc = h.session.messages[1];
			if (tc.role !== "assistant") throw new Error("expected assistant");
			expect((tc.content[0] as { type: string }).type).toBe("toolCall");
			expect(tc.content[0]).toMatchObject({ type: "toolCall", id: "call-1", name: "readfile", arguments: { path: "a.txt" } });
			// toolCallId pairing with the following toolResult is preserved.
			const tr = h.session.messages[2];
			if (tr.role !== "toolResult") throw new Error("expected toolResult");
			expect(tr.toolCallId).toBe("call-1");
			expect(tr.content[0]).toMatchObject({ type: "text", text: "file contents" });
		} finally {
			h.cleanup();
		}
	});

	it("persists the injected transcript durably so a rebuilt runtime restores the same native turns", async () => {
		const h = await createHarness();
		try {
			const native = nativeToolTurn(h);
			await h.session.injectTranscript(native);

			// Rebuilt runtimes reconstruct state.messages from buildSessionContext();
			// the injected message entries must survive as native turns.
			const rebuilt = h.sessionManager.buildSessionContext().messages;
			expect(rebuilt.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
			const tc = rebuilt[1];
			if (tc.role !== "assistant") throw new Error("expected assistant");
			expect(tc.content[0]).toMatchObject({ type: "toolCall", id: "call-1", arguments: { path: "a.txt" } });
			const tr = rebuilt[2];
			if (tr.role !== "toolResult") throw new Error("expected toolResult");
			expect(tr.toolCallId).toBe("call-1");
		} finally {
			h.cleanup();
		}
	});
});