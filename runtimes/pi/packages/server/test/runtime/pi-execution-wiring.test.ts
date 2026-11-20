import { expect, test, vi } from "vitest";
import { createConversationRuntimeManager } from "../../src/runtime/conversation-runtime-manager.ts";
import type { ConversationRuntime } from "../../src/runtime/conversation-runtime.ts";
import { managedTurnExecutor, type TurnExecutionInput } from "../../src/runtime/turn-executor.ts";

const input = { scope: { conversationId: "conv-wiring" }, spec: {}, text: "hello" } as TurnExecutionInput;

test("accepts cancellation while a managed runtime opens without sending a prompt", async () => {
	let finishOpening!: (runtime: ConversationRuntime) => void;
	const opening = new Promise<ConversationRuntime>((resolve) => {
		finishOpening = resolve;
	});
	const prompt = vi.fn(async () => {});
	const manager = createConversationRuntimeManager({ opener: () => opening, autoSweep: false });
	const beforePrompt = vi.fn(async () => {});
	const executor = managedTurnExecutor(manager, beforePrompt);
	try {
		const pending = executor(input);
		expect(await executor.cancel?.(input.scope.conversationId)).toBe(true);
		finishOpening({ prompt, close: async () => {} } as unknown as ConversationRuntime);
		expect(await pending).toEqual({ ok: false, interrupted: true, outputText: "" });
		expect(beforePrompt).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(await executor.cancel?.(input.scope.conversationId)).toBe(false);
	} finally {
		await manager.close();
	}
});

test("failed runtime acquisition clears the active Turn so the Conversation can execute again", async () => {
	const runtime = {
		prompt: async () => {},
		subscribe: () => () => {},
		snapshot: () => ({ transcript: [] }),
		close: async () => {},
	} as unknown as ConversationRuntime;
	const opener = vi.fn().mockRejectedValueOnce(new Error("cannot open")).mockResolvedValueOnce(runtime);
	const manager = createConversationRuntimeManager({ opener, autoSweep: false });
	const executor = managedTurnExecutor(manager);
	try {
		expect(await executor(input)).toEqual({ ok: false, error: "cannot open" });
		expect(await executor.cancel?.(input.scope.conversationId)).toBe(false);
		expect(await executor(input)).toMatchObject({ ok: true });
	} finally {
		await manager.close();
	}
});
