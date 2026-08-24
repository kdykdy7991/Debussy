import { describe, expect, test } from "vitest";
import { buildTurnMetrics } from "../../src/agent-v2/turn-metrics.ts";
import { ControlService } from "../../src/publishing/control/service.ts";
import {
	type ConversationId,
	newConversationId,
	newTenantId,
	newTurnId,
	type TenantId,
	type TurnId,
} from "../../src/publishing/domain/ids.ts";
import type {
	AdminConversationListRow,
	ConversationEventRecord,
	PublishingRepositories,
} from "../../src/publishing/repositories.ts";
import type { CapabilityCatalog } from "../../src/publishing/runtime-spec/compiler.ts";

const CATALOG: CapabilityCatalog = {
	tools: [],
	models: [{ provider: "skdy", modelId: "pi-chat" }],
	knowledgeBases: [],
};
const TENANT: TenantId = newTenantId();
const CONV: ConversationId = newConversationId();
const PUBLISHED_APP = "app_11111111-1111-1111-1111-111111111111";

function successMetrics(overrides?: { outputTokens?: number }): ReturnType<typeof buildTurnMetrics> {
	return buildTurnMetrics({
		outcome: "success",
		base: { monotonicStartMs: 1000, epochStartMs: 1_700_000_000_000 },
		events: { providerStartAtMs: 1150, firstOutputAtMs: 1600, completedAtMs: 4200 },
		usage: {
			inputTokens: 1000,
			outputTokens: overrides?.outputTokens ?? 200,
			cacheReadTokens: 300,
			cacheWriteTokens: 50,
		},
	});
}

function failedMetrics(): ReturnType<typeof buildTurnMetrics> {
	return buildTurnMetrics({
		outcome: "failed",
		base: { monotonicStartMs: 1000, epochStartMs: 1_700_000_000_000 },
		events: { providerStartAtMs: 1000, firstOutputAtMs: null, completedAtMs: 1400 },
		usage: { inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
	});
}

function makeTurn(
	startSeq: number,
	endSeq: number,
	turnNo: number,
	model: string,
	metrics: object,
): ConversationEventRecord[] {
	const turnId: TurnId = newTurnId();
	const base = { tenantId: TENANT, publishedAppId: PUBLISHED_APP as never, conversationId: CONV };
	return [
		{
			eventId: `evt_${turnNo}` as never,
			...base,
			sequence: startSeq,
			eventType: "turn/start",
			eventSchemaVersion: 1,
			turnId,
			payload: { model },
			payloadBytes: 0,
			createdAt: new Date(),
		},
		{
			eventId: `evt_${turnNo}e` as never,
			...base,
			sequence: endSeq,
			eventType: "turn/end",
			eventSchemaVersion: 1,
			turnId,
			payload: { ok: true, metrics },
			payloadBytes: 0,
			createdAt: new Date(),
		},
	];
}

function buildService(opts: {
	metricsEnabled?: boolean;
	rows?: ConversationEventRecord[];
	conversation?: AdminConversationListRow | undefined;
}): ControlService {
	const repoEvents = opts.rows ?? [];
	const repos = {
		conversations: { getByTenant: async () => opts.conversation },
		events: {
			listByConversation: async (_params: Parameters<PublishingRepositories["events"]["listByConversation"]>[0]) =>
				repoEvents
					.filter((e) => e.sequence > (_params.afterSequence ?? 0))
					.sort((a, b) => a.sequence - b.sequence)
					.slice(0, _params.limit),
		},
	} as unknown as PublishingRepositories;
	return new ControlService({
		repositories: repos,
		catalog: CATALOG,
		embedBaseUrl: "https://embed.example.test",
		metricsEnabled: opts.metricsEnabled ?? false,
	});
}

function presentConversation(): AdminConversationListRow {
	return {
		conversationId: CONV,
		tenantId: TENANT,
		publishedAppId: PUBLISHED_APP as never,
		publishedAppVersionId: "pav_11111111-1111-1111-1111-111111111111" as never,
		ownerPrincipalId: "prn_11111111-1111-1111-1111-111111111111" as never,
		title: "t",
		status: "active",
		lastEventSequence: 10,
		eventCount: 10,
		eventBytes: 100,
		turnCount: 1,
		latestSummarySequence: 0,
		previousConversationId: null,
		nextConversationId: null,
		rolledOverAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		lastActiveAt: new Date(),
		cursor: "cursor",
		errorCount: 0,
		messageCount: 0,
		principalDisplayId: "prn_x",
		principalType: "external_user",
		appName: "app",
		publicAppId: "pub_x",
		agentId: null,
	};
}

describe("M1 ControlService.getConversationMetrics", () => {
	test("disabled flag -> 503 METRICS_UNAVAILABLE", async () => {
		const service = buildService({ metricsEnabled: false, conversation: presentConversation() });
		const r = await service.getConversationMetrics({ tenantId: TENANT, conversationId: CONV });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.code).toBe("METRICS_UNAVAILABLE");
			expect(r.error.httpStatus).toBe(503);
		}
	});

	test("cross-tenant/unknown conversation -> 404 CONVERSATION_NOT_FOUND", async () => {
		const service = buildService({ metricsEnabled: true, conversation: undefined });
		const r = await service.getConversationMetrics({ tenantId: TENANT, conversationId: CONV });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatchObject({ code: "CONVERSATION_NOT_FOUND", httpStatus: 404 });
	});

	test("empty conversation (exists, no metrics) -> 200 available=false items=[]", async () => {
		const service = buildService({ metricsEnabled: true, conversation: presentConversation() });
		const r = await service.getConversationMetrics({ tenantId: TENANT, conversationId: CONV });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.data.stats.available).toBe(false);
			expect(r.data.items).toEqual([]);
			expect(r.data.nextAfterSequence).toBeNull();
		}
	});

	test("aggregates whole-session stats and pages items (success+failed)", async () => {
		const evts = [
			...makeTurn(1, 2, 1, "gpt-4o", successMetrics()),
			...makeTurn(3, 4, 2, "gpt-4o", failedMetrics()),
			...makeTurn(5, 6, 3, "gpt-4o", successMetrics({ outputTokens: 400 })),
		];
		const service = buildService({ metricsEnabled: true, conversation: presentConversation(), rows: evts });
		// limit=2 -> 第二页 cut 一轮.
		const r = await service.getConversationMetrics({ tenantId: TENANT, conversationId: CONV, limit: 2 });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.data.stats.available).toBe(true);
		expect(r.data.stats.turnCount).toBe(3);
		expect(r.data.stats.sampleCount).toBe(2); // 仅 success
		expect(r.data.stats.totalLatencyMs.count).toBe(2);
		expect(r.data.items).toHaveLength(2);
		expect(r.data.items[0]!.sequence).toBe(2);
		expect(r.data.items[0]!.metrics.outcome).toBe("success");
		expect(r.data.items[0]!.modelId).toBe("gpt-4o");
		expect(r.data.items[0]!.sessionEffort).toBeNull();
		expect(r.data.nextAfterSequence).toBe(4);
		// 统计不受分页影响：ttft 均值应在 3 轮上算（2 success 各 450ms -> 450）。
		expect(r.data.stats.ttftMs.mean).toBe(450);
	});

	test("afterSequence filters the returned page (cursor = last sequence)", async () => {
		const evts = [...makeTurn(1, 2, 1, "gpt-4o", successMetrics()), ...makeTurn(3, 4, 2, "gpt-4o", successMetrics())];
		const service = buildService({ metricsEnabled: true, conversation: presentConversation(), rows: evts });
		const r = await service.getConversationMetrics({ tenantId: TENANT, conversationId: CONV, afterSequence: 2 });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.data.items.map((i) => i.sequence)).toEqual([4]);
			expect(r.data.nextAfterSequence).toBe(4);
		}
	});

	test("invalid afterSequence (0) -> 422 INVALID_METRICS_FILTER", async () => {
		const service = buildService({ metricsEnabled: true, conversation: presentConversation() });
		const r = await service.getConversationMetrics({ tenantId: TENANT, conversationId: CONV, afterSequence: 0 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatchObject({ code: "INVALID_METRICS_FILTER", httpStatus: 422 });
	});
});

describe("M1 ControlService.getConversationContext", () => {
	const snapshot = {
		usedTokens: 1200,
		contextWindow: 32_000,
		remainingTokens: 30_800,
		reservedOutputTokens: 1000,
		usagePercent: 3.75,
		measurement: "estimated",
		breakdown: {
			systemPrompt: 800,
			skillInstructions: 0,
			toolDefinitions: 100,
			conversationMessages: 200,
			toolResults: 100,
			retrievalContext: 0,
			attachments: 0,
		},
	};

	test("returns the latest context/snapshot frame with its sequence", async () => {
		const evts = [
			{
				eventId: "e1" as never,
				tenantId: TENANT,
				publishedAppId: PUBLISHED_APP as never,
				conversationId: CONV,
				sequence: 1,
				eventType: "context/snapshot",
				eventSchemaVersion: 1,
				turnId: null,
				payload: { snapshot },
				payloadBytes: 0,
				createdAt: new Date(),
			},
			{
				eventId: "e2" as never,
				tenantId: TENANT,
				publishedAppId: PUBLISHED_APP as never,
				conversationId: CONV,
				sequence: 5,
				eventType: "context/snapshot",
				eventSchemaVersion: 1,
				turnId: null,
				payload: { snapshot: { ...snapshot, usedTokens: 99 } },
				payloadBytes: 0,
				createdAt: new Date(),
			},
		] as unknown as ConversationEventRecord[];
		const service = buildService({ metricsEnabled: true, conversation: presentConversation(), rows: evts });
		const r = await service.getConversationContext({ tenantId: TENANT, conversationId: CONV });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.data.available).toBe(true);
			expect(r.data.atSequence).toBe(5);
			expect(r.data.latest?.usedTokens).toBe(99);
			expect(r.data.latest?.breakdown.systemPrompt).toBe(800);
		}
	});

	test("conversation without a snapshot -> 200 available=false latest=null", async () => {
		const service = buildService({ metricsEnabled: true, conversation: presentConversation() });
		const r = await service.getConversationContext({ tenantId: TENANT, conversationId: CONV });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.data.available).toBe(false);
			expect(r.data.latest).toBeNull();
			expect(r.data.atSequence).toBeNull();
		}
	});
});
