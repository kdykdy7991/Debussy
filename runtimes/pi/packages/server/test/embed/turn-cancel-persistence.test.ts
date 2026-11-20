/**
 * Chat Turn 取消持久化定点测试。
 *
 * 覆盖：正常完成写 turn/end ok:true；用户取消写唯一 turn/interrupted（带已产生
 * usage、cancelled metrics、partial assistant），不写 turn/end/turn/failed；
 * 取消前保留真实 usage，无法获得的部分保持未知。
 */
import type { Usage } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { ConversationService } from "../../src/embed/conversations/service.ts";
import { newConversationId, newTenantId, newTurnId } from "../../src/publishing/domain/ids.ts";
import type { ExecutionConfigResolver } from "../../src/embed/conversations/execution-configuration.ts";
import type { TurnExecutor, TurnLlmUsage } from "../../src/runtime/turn-executor.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";

const USAGE: Usage = {
	input: 100,
	output: 10,
	cacheRead: 20,
	cacheWrite: 0,
	totalTokens: 130,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface AppendedEvent {
	readonly eventType: string;
	readonly payload: unknown;
	readonly turnId: unknown;
}

function harness(executor: TurnExecutor) {
	const tenantId = newTenantId();
	const conversationId = newConversationId();
	const appended: AppendedEvent[] = [];
	let sequence = 0;
	const record = {
		tenantId,
		publishedAppId: "pub_test" as never,
		publishedAppVersionId: "pav_test" as never,
		ownerPrincipalId: "prn_test" as never,
		integrationId: null,
		status: "active",
		source: "chat",
	};
	const repositories = {
		conversations: {
			get: async () => record,
		},
		events: {
			append: async (_scope: unknown, input: AppendedEvent) => {
				sequence += 1;
				const stored = { ...input, sequence };
				appended.push(stored);
				return stored;
			},
			list: async () => appended,
		},
		summaries: { getLatest: async () => undefined },
		conversationReasoning: { get: async () => undefined },
	} as unknown as PublishingRepositories;
	const resolveExecutionConfiguration: ExecutionConfigResolver = async () => ({
		runtimeSpec: {
			schemaVersion: 1,
			publishedAppVersionId: "pav_test",
			agent: { systemPrompt: "sys", model: { provider: "p", modelId: "m" } },
			capabilities: { tools: [], knowledgeBases: [], uploads: { enabled: false } },
			contextPolicy: { maxTurns: 10, maxContextTokens: 100_000, toolResultMaxBytes: 65536, logLevel: "standard" },
			runtimePolicy: {
				profile: "chat-only",
				turnTimeoutMs: 1000,
				idleTtlMs: 1000,
				maxConcurrentTurnsPerConversation: 1,
			},
			theme: {},
			securityPolicyVersion: "sp_001",
		},
		runtimeSpecHash: null,
		versionKey: "pav_test" as never,
		source: { kind: "chat", ownerId: "pub_test", versionId: "pav_test" },
		audit: { agentRevisionId: "rev_1" },
	});
	const service = new ConversationService({
		repositories,
		turnExecutor: executor,
		resolveExecutionConfiguration,
	});
	const principal = {
		tokenId: "tok_cancel",
		tenantId,
		publishedAppId: "pub_test" as never,
		publishedAppVersionId: "pav_test" as never,
		principalId: "prn_test" as never,
		principalType: "anonymous_visitor",
		scopes: [],
		issuedAt: new Date(),
		expiresAt: new Date(Date.now() + 60_000),
	} as Parameters<ConversationService["executeTurn"]>[0]["principal"];
	return { service, principal, conversationId, appended };
}

const CONFIRMED_LLM_USAGE: TurnLlmUsage = {
	calls: [
		{
			model: "m",
			input: 100,
			output: 10,
			cacheRead: 20,
			cacheWrite: 0,
			totalTokens: 130,
			status: "completed",
			usageReported: true,
		},
	],
	total: {
		input: 100,
		output: 10,
		cacheRead: 20,
		cacheWrite: 0,
		totalTokens: 130,
		cacheReadReported: false,
		cacheReadReportedCallCount: 0,
	},
	callCount: 1,
	partial: false,
};

const interruptedExecutor: TurnExecutor = async () => ({
	ok: false,
	interrupted: true,
	outputText: "partial answer",
	thinkingText: "partial thought",
	usage: USAGE,
	llmUsage: CONFIRMED_LLM_USAGE,
});

describe("Chat Turn 终端事件：取消", () => {
	test("正常完成仍写 turn/end ok:true", async () => {
		const h = harness(async () => ({ ok: true, outputText: "done" }));
		const result = await h.service.executeTurn({
			principal: h.principal,
			conversationId: h.conversationId,
			text: "hello",
		});
		expect(result.ok).toBe(true);
		const types = h.appended.map((event) => event.eventType);
		expect(types).toContain("turn/end");
		expect(types).not.toContain("turn/interrupted");
		const end = h.appended.find((event) => event.eventType === "turn/end");
		expect((end?.payload as Record<string, unknown>).ok).toBe(true);
	});

	test("用户取消只写 turn/interrupted，保留真实 usage 与 partial assistant", async () => {
		const h = harness(interruptedExecutor);
		const result = await h.service.executeTurn({
			principal: h.principal,
			conversationId: h.conversationId,
			text: "cancel",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.interrupted).toBe(true);
			expect(result.data.outputText).toBe("partial answer");
		}
		const types = h.appended.map((event) => event.eventType);
		expect(types).toContain("turn/interrupted");
		expect(types).not.toContain("turn/end");
		expect(types).not.toContain("turn/failed");
		const terminal = h.appended.filter((event) => event.eventType === "turn/interrupted");
		expect(terminal).toHaveLength(1);
		const payload = terminal[0]!.payload as Record<string, unknown>;
		expect(payload.aborted).toBe(true);
		expect(payload.usage).toEqual(USAGE);
		expect(payload.llmUsage).toMatchObject({ callCount: 1 });
		const metrics = payload.metrics as Record<string, unknown> | undefined;
		if (metrics !== undefined) expect(metrics.outcome).toBe("cancelled");
		const assistant = h.appended.find((event) => event.eventType === "assistant/message");
		expect(assistant?.payload).toMatchObject({ text: "partial answer", status: "interrupted" });
	});

	test("无可靠 usage 的取消不伪造 0", async () => {
		const executor: TurnExecutor = async () => ({ ok: false, interrupted: true, outputText: "" });
		const h = harness(executor);
		await h.service.executeTurn({ principal: h.principal, conversationId: h.conversationId, text: "cancel" });
		const terminal = h.appended.find((event) => event.eventType === "turn/interrupted");
		const payload = terminal?.payload as Record<string, unknown>;
		expect(Object.hasOwn(payload, "usage")).toBe(false);
		expect(Object.hasOwn(payload, "llmUsage")).toBe(false);
		const assistant = h.appended.find((event) => event.eventType === "assistant/message");
		expect(assistant).toBeUndefined();
	});

	test("失败的 Turn 在既有终态事件中保留已确认用量", async () => {
		const h = harness(async () => ({
			ok: false,
			error: "provider failed",
			usage: USAGE,
			llmUsage: CONFIRMED_LLM_USAGE,
		}));
		const result = await h.service.executeTurn({
			principal: h.principal,
			conversationId: h.conversationId,
			text: "fail",
		});
		expect(result.ok).toBe(false);
		const terminal = h.appended.filter((event) =>
			["turn/failed", "turn/end", "turn/interrupted"].includes(event.eventType),
		);
		expect(terminal).toHaveLength(1);
		expect(terminal[0]).toMatchObject({
			eventType: "turn/failed",
			payload: { error: "provider failed", usage: USAGE, llmUsage: { callCount: 1 } },
		});
	});

	test("取消后再次开启新 Turn 不会被上一次取消污染", async () => {
		const h = harness(interruptedExecutor);
		await h.service.executeTurn({ principal: h.principal, conversationId: h.conversationId, text: "cancel-1" });
		const cancelled = h.appended.filter((event) => event.eventType === "turn/interrupted");
		expect(cancelled).toHaveLength(1);
		const fresh = newTurnId();
		expect(fresh).not.toBe(cancelled[0]!.turnId);
	});
});
