/**
 * TASK-021: ConversationRuntimeManager 单元测试（spec TASK-021 完成条件）。
 *
 * 覆盖：并发 acquire 同一 Conversation 只创建一次；30 个不同会话并行；
 * 同会话冲突时仅一个 created；空闲 TTL 回收（注入时钟）；manager close 后
 * 拒绝新 acquire；drain 关闭全部活跃 Runtime。不依赖数据库。
 */

import type { ModelRef, SessionSnapshot, ThinkingLevel } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import type { ConversationId } from "../../src/publishing/domain/ids.ts";
import type { RuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import { ConversationRuntime } from "../../src/runtime/conversation-runtime.ts";
import {
	type ConversationRuntimeManager,
	createConversationRuntimeManager,
} from "../../src/runtime/conversation-runtime-manager.ts";
import type { ScopeContext } from "../../src/runtime/scope-context.ts";
import type { PiSessionRuntime, PiSessionRuntimeEvent, PromptInput, SteerInput } from "../../src/types.ts";

class FakeSession implements PiSessionRuntime {
	readonly sessionIdValue: string;
	disposed = 0;
	readonly prompts: PromptInput[] = [];
	constructor(id: string) {
		this.sessionIdValue = id;
	}
	snapshot(): SessionSnapshot {
		return {
			id: this.sessionIdValue,
			cwd: "/tmp",
			createdAt: 0,
			updatedAt: 0,
			phase: "idle",
			model: { provider: "p", id: "m" },
			thinkingLevel: "off",
			attached: true,
			locked: true,
			lastSequence: 0,
			revision: 0,
			transcript: [],
			queuedSteer: [],
			queuedSteerCount: 0,
		};
	}
	getPhase(): "idle" {
		return "idle";
	}
	async prompt(input: PromptInput): Promise<void> {
		this.prompts.push(input);
	}
	async steer(_input: SteerInput): Promise<void> {}
	async abort(): Promise<void> {}
	async setModel(_model: ModelRef): Promise<void> {}
	async setThinking(_thinkingLevel: ThinkingLevel): Promise<void> {}
	subscribe(_listener: (event: PiSessionRuntimeEvent) => void): () => void {
		return () => {};
	}
	async dispose(): Promise<void> {
		this.disposed += 1;
	}
}

function chatOnlySpec(): RuntimeSpec {
	return {
		schemaVersion: 1,
		publishedAppVersionId: "pav-test",
		agent: { systemPrompt: "hi", model: { provider: "skdy", modelId: "pi-chat" } },
		capabilities: {
			tools: [],
			knowledgeBases: [],
			skills: [],
			mcpServers: [],
			uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
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
		tenantId: "ten" as never,
		publishedAppId: "app" as never,
		publishedAppVersionId: "pav" as never,
		principalId: "prn" as never,
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

interface Harness {
	manager: ConversationRuntimeManager;
	sessions: Map<string, FakeSession>;
	opened: number;
}

function makeHarness(idleTtlMs = 1000, now?: () => number): Harness {
	const sessions = new Map<string, FakeSession>();
	const harness: Harness = { manager: undefined as never, sessions, opened: 0 };
	harness.manager = createConversationRuntimeManager({
		idleTtlMs,
		autoSweep: false,
		...(now !== undefined ? { now } : {}),
		opener: async (_spec, scope) => {
			harness.opened += 1;
			const session = new FakeSession(scope.conversationId);
			sessions.set(scope.conversationId, session);
			return new ConversationRuntime({ scope, spec: chatOnlySpec(), session });
		},
	});
	return harness;
}

describe("conversation runtime manager", () => {
	test("turn prompts preserve the session's base system prompt", async () => {
		const session = new FakeSession("conv-1");
		const runtime = new ConversationRuntime({ scope: scope("conv-1"), spec: chatOnlySpec(), session });

		await runtime.prompt("hello");
		await runtime.prompt("with context", {
			retrieval: { context: "source", reference: "citation", citations: [] },
		});

		// Passing a per-turn systemPrompt replaces Pi's ResourceLoader prompt, which
		// would remove its <available_skills> section. The prompt is fixed at open.
		expect(session.prompts).toEqual([
			{ text: "hello" },
			{
				text: "with context",
				retrieval: { context: "source", reference: "citation", citations: [] },
			},
		]);
		await runtime.close();
	});

	test("concurrent acquire of the same conversation creates it only once", async () => {
		const harness = makeHarness();
		const results = await Promise.all(
			Array.from({ length: 10 }, () => harness.manager.acquire(chatOnlySpec(), scope("conv-1"))),
		);
		expect(harness.opened).toBe(1);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		for (const result of results) expect(result.runtime.scope.conversationId).toBe("conv-1");
		await harness.manager.drain();
	});

	test("30 different conversations run in parallel with independent runtimes", async () => {
		const harness = makeHarness();
		const results = await Promise.all(
			Array.from({ length: 30 }, (_, index) => harness.manager.acquire(chatOnlySpec(), scope(`conv-${index}`))),
		);
		expect(harness.opened).toBe(30);
		const ids = new Set(results.map((result) => result.runtime.sessionId));
		expect(ids.size).toBe(30);
		await harness.manager.drain();
	});

	test("re-acquiring an active conversation returns the same runtime", async () => {
		const harness = makeHarness();
		const first = await harness.manager.acquire(chatOnlySpec(), scope("conv-1"));
		const second = await harness.manager.acquire(chatOnlySpec(), scope("conv-1"));
		expect(harness.opened).toBe(1);
		expect(second.created).toBe(false);
		expect(second.runtime).toBe(first.runtime);
		await harness.manager.drain();
	});

	test("idle runtimes are closed by sweepIdle and recreated on demand", async () => {
		let clock = 0;
		const harness = makeHarness(1000, () => clock);
		const first = await harness.manager.acquire(chatOnlySpec(), scope("conv-1"));
		clock = 500;
		await harness.manager.sweepIdle(clock); // 未超时
		expect(harness.sessions.get("conv-1")?.disposed).toBe(0);
		clock = 1500;
		await harness.manager.sweepIdle(clock); // 超时 -> 关闭 + 移除
		expect(harness.sessions.get("conv-1")?.disposed).toBe(1);
		expect(harness.manager.get("conv-1" as ConversationId)).toBeUndefined();
		// 再 acquire -> 重新创建
		const reacquired = await harness.manager.acquire(chatOnlySpec(), scope("conv-1"));
		expect(reacquired.created).toBe(true);
		expect(harness.opened).toBe(2);
		expect(first.runtime).not.toBe(reacquired.runtime);
		await harness.manager.drain();
	});

	test("acquire after close is rejected and drain closes all active runtimes", async () => {
		const harness = makeHarness();
		await harness.manager.acquire(chatOnlySpec(), scope("conv-a"));
		await harness.manager.acquire(chatOnlySpec(), scope("conv-b"));
		await harness.manager.close();
		expect(harness.sessions.get("conv-a")?.disposed).toBe(1);
		expect(harness.sessions.get("conv-b")?.disposed).toBe(1);
		await expect(harness.manager.acquire(chatOnlySpec(), scope("conv-c"))).rejects.toThrow(/closed/);
	});

	test("drain is idempotent", async () => {
		const harness = makeHarness();
		await harness.manager.acquire(chatOnlySpec(), scope("conv-1"));
		await harness.manager.drain();
		await harness.manager.drain();
		expect(harness.sessions.get("conv-1")?.disposed).toBe(1);
	});

	test("release refreshes the idle timestamp", async () => {
		let clock = 0;
		const harness = makeHarness(1000, () => clock);
		await harness.manager.acquire(chatOnlySpec(), scope("conv-1"));
		clock = 800;
		harness.manager.release("conv-1" as ConversationId);
		clock = 1500;
		await harness.manager.sweepIdle(clock); // release 后 lastActiveAt=800 -> 未超时（800+1000=1800）
		expect(harness.sessions.get("conv-1")?.disposed).toBe(0);
		clock = 1900;
		await harness.manager.sweepIdle(clock); // 1900-800=1100 >= 1000 -> 回收
		expect(harness.sessions.get("conv-1")?.disposed).toBe(1);
		await harness.manager.drain();
	});
});
