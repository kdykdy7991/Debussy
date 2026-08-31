import { describe, expect, test } from "vitest";
import type { RuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type { ConversationId, PublishedAppId, PublishedAppVersionId, PrincipalId, TenantId } from "../../src/publishing/domain/ids.ts";
import type { ScopeContext } from "../../src/runtime/scope-context.ts";
import { ConversationRuntime } from "../../src/runtime/conversation-runtime.ts";
import type { PiSessionRuntime, PromptInput } from "../../src/types.ts";
import type { RestoredContext } from "../../src/runtime/context-restore.ts";

function chatOnlySpec(): RuntimeSpec {
	return {
		schemaVersion: 1,
		publishedAppVersionId: "pav-test",
		agent: { systemPrompt: "s", model: { provider: "skdy", modelId: "pi-chat", params: {} } },
		capabilities: {
			tools: [],
			knowledgeBases: [],
			skills: [],
			mcpServers: [],
			uploads: { enabled: true, maxFiles: 1, maxFileBytes: 1000 },
			speech: { enabled: false },
			avatar: { enabled: false },
			conversations: { allowNew: true },
		},
		contextPolicy: { maxTurns: 100, maxContextTokens: 100000, toolResultMaxBytes: 65536, logLevel: "standard" },
		runtimePolicy: {
			profile: "chat-only",
			turnTimeoutMs: 120000,
			idleTtlMs: 1200000,
			maxConcurrentTurnsPerConversation: 1,
		},
		theme: {},
		securityPolicyVersion: "sp_001",
	};
}

function scope(conversationId: string): ScopeContext {
	return {
		tenantId: "ten" as TenantId,
		publishedAppId: "app" as PublishedAppId,
		publishedAppVersionId: "pav" as PublishedAppVersionId,
		principalId: "prn" as PrincipalId,
		conversationId: conversationId as ConversationId,
		limits: {
			maxTurns: 100,
			maxContextTokens: 100000,
			toolResultMaxBytes: 65536,
			turnTimeoutMs: 120000,
			maxConcurrentTurnsPerConversation: 1,
		},
	};
}

function makeSession() {
	const prompts: PromptInput[] = [];
	const session: PiSessionRuntime = {
		ephemeral: true,
		snapshot: () => ({ id: "s", transcript: [] }) as never,
		getPhase: () => "idle" as never,
		async prompt(input) {
			prompts.push(input);
		},
		async steer() {},
		async abort() {},
		async setModel() {},
		async setThinking() {},
		subscribe: () => () => {},
		async dispose() {},
	};
	return { session, prompts };
}

/** Full restored history: the same object reused across turns (per-turn restore). */
function fullHistory(): RestoredContext {
	return {
		messages: [{ role: "user", text: "prior" }, { role: "assistant", text: "done" }],
		transcript: [
			{ role: "user", content: [{ type: "text", text: "prior" }] },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		],
		turns: [],
		interruptedTurnIds: [],
		skippedEvents: 0,
		droppedChunks: 0,
		errorEventCount: 0,
		observedLogLevel: "standard",
	};
}

describe("ConversationRuntime hydrate-once (Phase 2)", () => {
	test("hydrates the full Postgres history into the native session exactly once per runtime lifetime", async () => {
		const { session, prompts } = makeSession();
		const runtime = new ConversationRuntime({ scope: scope("c1"), spec: chatOnlySpec(), session });

		// Fresh runtime: first prompt hydrates the whole restored transcript.
		await runtime.prompt("turn2", { history: fullHistory() });
		expect(prompts).toHaveLength(1);
		expect(prompts[0].transcript).toEqual(fullHistory().transcript);

		// A later turn on the SAME runtime re-passes the same full history, but it
		// must NOT be re-injected (the in-memory session already holds prior turns).
		await runtime.prompt("turn3", { history: fullHistory() });
		expect(prompts).toHaveLength(2);
		expect(prompts[1].transcript).toBeUndefined();
		expect(prompts[1].text).toBe("turn3");
		// the current user message is passed as `text`, never folded into history.
		expect((prompts[1].transcript ?? []).length).toBe(0);
	});

	test("a freshly rebuilt runtime (eviction/restart) re-hydrates from Postgres", async () => {
		const { session, prompts } = makeSession();
		// New runtime instance = a rebuilt conversation runtime after eviction.
		const runtimeA = new ConversationRuntime({ scope: scope("c1"), spec: chatOnlySpec(), session });
		await runtimeA.prompt("turn2", { history: fullHistory() });
		expect(prompts[0].transcript).toEqual(fullHistory().transcript);
		await runtimeA.close();

		const { session: sessionB, prompts: promptsB } = makeSession();
		const runtimeB = new ConversationRuntime({ scope: scope("c1"), spec: chatOnlySpec(), session: sessionB });
		await runtimeB.prompt("turn2b", { history: fullHistory() });
		expect(promptsB).toHaveLength(1);
		expect(promptsB[0].transcript).toEqual(fullHistory().transcript);
		await runtimeB.close();
	});

	test("a fresh runtime whose first prompt has no history still does not inject on later turns", async () => {
		const { session, prompts } = makeSession();
		const runtime = new ConversationRuntime({ scope: scope("c2"), spec: chatOnlySpec(), session });
		// Turn 1: brand-new conversation, empty restored history.
		await runtime.prompt("turn1", { history: emptyHistory() });
		expect(prompts[0].transcript).toBeUndefined();
		// Turn 2 on same runtime with (hypothetically) prior history: still no inject.
		await runtime.prompt("turn2", { history: fullHistory() });
		expect(prompts[1].transcript).toBeUndefined();
	});
});

function emptyHistory(): RestoredContext {
	return {
		messages: [],
		transcript: [],
		turns: [],
		interruptedTurnIds: [],
		skippedEvents: 0,
		droppedChunks: 0,
		errorEventCount: 0,
		observedLogLevel: "standard",
	};
}