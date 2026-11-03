import { expect, test, vi } from "vitest";
import { createOrchestrationTurnExecutor } from "../../src/orchestration/conversation-executor.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import {
	type ConversationRuntimeManager,
	createConversationRuntimeManager,
} from "../../src/runtime/conversation-runtime-manager.ts";
import { createPiRuntimeAdapter } from "../../src/runtime/pi-runtime-adapter.ts";
import type { TurnExecutionInput } from "../../src/runtime/turn-executor.ts";
import type { PiSessionRuntime, PromptInput } from "../../src/types.ts";

test.each([true, false])(
	"runtime reset after a turn (failure=%s) prevents stale credential closures on retry",
	async (failure) => {
		const reset = vi.fn(async () => {}),
			release = vi.fn();
		const manager = {
			acquire: async () => ({
				created: true,
				runtime: {
					subscribe: () => () => {},
					prompt: async () => {
						if (failure) throw new Error("interrupted");
					},
					snapshot: () => ({ transcript: [] }),
				},
			}),
			release,
			reset,
		} as unknown as ConversationRuntimeManager;
		const execute = createOrchestrationTurnExecutor(manager);
		const result = await execute({
			scope: { conversationId: "context" },
			spec: {},
			text: "input",
		} as TurnExecutionInput);
		expect(result.ok).toBe(!failure);
		expect(release).toHaveBeenCalledWith("context");
		expect(reset).toHaveBeenCalledWith("context");
	},
);

test("the executor forwards resolved per-task specs without a second prompt override", async () => {
	const acquire = vi.fn(async () => ({
		created: true,
		runtime: { subscribe: () => () => {}, prompt: vi.fn(async () => {}), snapshot: () => ({ transcript: [] }) },
	}));
	const manager = { acquire, release: vi.fn(), reset: vi.fn(async () => {}) } as unknown as ConversationRuntimeManager;
	const original = {
		agent: { systemPrompt: "published default", model: { provider: "fake", modelId: "test" } },
		capabilities: { mcpServers: [{ tools: ["query"] }] },
	};
	const execute = createOrchestrationTurnExecutor(manager);
	await Promise.all(
		["A", "B"].map((conversationId) =>
			execute({
				scope: { conversationId },
				spec: {
					...original,
					agent: { ...original.agent, systemPrompt: conversationId === "A" ? "  task A\n" : "task B" },
				},
				text: "task input",
			} as unknown as TurnExecutionInput),
		),
	);
	const calls = acquire.mock.calls as unknown as [TurnExecutionInput["spec"], TurnExecutionInput["scope"]][];
	for (const [spec, scope] of calls) {
		expect(spec.agent.systemPrompt).toBe(scope.conversationId === "A" ? "  task A\n" : "task B");
		expect(spec.capabilities).toBe(original.capabilities);
		expect(spec.agent.model).toBe(original.agent.model);
	}
	for (const returned of acquire.mock.results) {
		const acquired = await returned.value;
		expect(acquired.runtime.prompt).toHaveBeenCalledWith("task input", expect.any(Object));
	}
	expect(original.agent.systemPrompt).toBe("published default");
});

test("the real runtime adapter passes the task prompt into the session system role", async () => {
	const prompt = vi.fn(async (_input: PromptInput) => {});
	const session = {
		subscribe: () => () => {},
		dispose: async () => {},
		prompt,
		snapshot: () => ({ transcript: [] }),
	} as unknown as PiSessionRuntime;
	const createSession = vi.fn(async () => session);
	const adapter = createPiRuntimeAdapter({ createSession });
	const manager = createConversationRuntimeManager({
		autoSweep: false,
		opener: async (spec, scope) => {
			const opened = await adapter.open(spec, scope);
			if (!opened.ok) throw new Error(opened.reason);
			return opened.runtime;
		},
	});
	try {
		const parsed = parseRuntimeSpec({
			schemaVersion: 1,
			publishedAppVersionId: "pav_test",
			agent: { systemPrompt: "  caller system prompt\n", model: { provider: "fake", modelId: "test" } },
			capabilities: {},
		});
		if (!parsed.ok) throw new Error("Invalid fixture");
		const execute = createOrchestrationTurnExecutor(manager);
		await execute({
			scope: { conversationId: "run-system-role" },
			spec: parsed.spec,
			text: "caller text",
		} as TurnExecutionInput);
		expect(prompt).toHaveBeenCalledWith({
			text: "caller text",
			systemPrompt: "  caller system prompt\n",
		});
		expect(createSession.mock.calls[0]).toEqual([
			expect.objectContaining({ systemPrompt: "  caller system prompt\n", model: { provider: "fake", id: "test" } }),
		]);
		expect(parsed.spec.agent.systemPrompt).toBe("  caller system prompt\n");
	} finally {
		await manager.close();
	}
});
