/**
 * WB-006: Admin conversation control-plane queries (SPEC §5.4).
 *
 * Focused unit tests over `ControlService`'s admin conversation methods with
 * a stubbed repository set, so they run without a database. Covers:
 *   - default redacted list (no message bodies), principal-type narrowing
 *   - unknown event types surfaced read-only via `kind: "unknown"`
 *   - audit events written on transcript / events / summary reads
 *   - uniform "CONVERSATION_NOT_FOUND" for cross-tenant reads
 *   - summary projection + rollover chain mapping
 */
import { describe, expect, test } from "vitest";
import { ControlService, type ControlServiceError } from "../../src/publishing/control/service.ts";
import type { ConversationId, TenantId } from "../../src/publishing/domain/ids.ts";
import { newConversationId, newTenantId, toPublicId } from "../../src/publishing/domain/ids.ts";
import type {
	AdminConversationEventListParams,
	AdminConversationListRow,
	ConversationEventRecord,
	LlmCallRow,
	PublishingRepositories,
} from "../../src/publishing/repositories.ts";
import type { CapabilityCatalog } from "../../src/publishing/runtime-spec/compiler.ts";

const CATALOG: CapabilityCatalog = {
	tools: [],
	models: [{ provider: "skdy", modelId: "pi-chat" }],
	knowledgeBases: [],
};

const TENANT_A: TenantId = newTenantId();
const TENANT_B: TenantId = newTenantId();
const CONV_A: ConversationId = newConversationId();
const APP_A = "app_11111111-1111-1111-1111-111111111111";

interface AuditRow {
	readonly action: string;
	readonly resourceId: string;
}

function adminRow(overrides: Partial<AdminConversationListRow> = {}): AdminConversationListRow {
	return {
		conversationId: CONV_A,
		tenantId: TENANT_A,
		publishedAppId: APP_A as AdminConversationListRow["publishedAppId"],
		publishedAppVersionId: "pav_11111111-1111-1111-1111-111111111111" as never,
		ownerPrincipalId: "prn_11111111-1111-1111-1111-111111111111" as never,
		title: "Support ticket",
		status: "active",
		lastEventSequence: 12,
		eventCount: 12,
		eventBytes: 900,
		turnCount: 3,
		latestSummarySequence: 8,
		previousConversationId: null,
		nextConversationId: null,
		rolledOverAt: null,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		lastActiveAt: new Date("2026-01-02T00:00:00Z"),
		cursor: "2026-01-02T00:00:00.000Z|c",
		errorCount: 1,
		messageCount: 6,
		principalDisplayId: "prn_abcdef12",
		principalType: "external_user",
		appName: "My App",
		publicAppId: "pub_abc",
		agentId: null,
		agentName: "Support Agent",
		origin: "chat",
		keyId: null,
		taskId: null,
		runId: null,
		...overrides,
	};
}

function llmCallRow(overrides: Partial<LlmCallRow> = {}): LlmCallRow {
	return {
		turnId: "2cdbe45e-0524-4812-b8a0-98056a2f7741",
		callIndex: 1,
		modelProvider: "custom",
		modelId: "Qwen",
		request: { systemPrompt: "rules", messages: [{ role: "user", content: "执行当前系统提示词指定的任务。" }] },
		response: {
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "tc_1", name: "getSatelliteById" }],
		},
		createdAt: new Date("2026-11-10T05:08:00Z"),
		completedAt: new Date("2026-11-10T05:08:01Z"),
		...overrides,
	};
}

function turnEndEvent(sequence: number, payload: unknown): ConversationEventRecord {
	return {
		eventId: `evt_${String(sequence).padStart(12, "0")}` as ConversationEventRecord["eventId"],
		tenantId: TENANT_A,
		publishedAppId: APP_A as ConversationEventRecord["publishedAppId"],
		conversationId: CONV_A,
		sequence,
		eventType: "turn/end",
		eventSchemaVersion: 1,
		turnId: "11111111-1111-1111-1111-111111111111" as ConversationEventRecord["turnId"],
		payload,
		payloadBytes: 64,
		createdAt: new Date("2026-11-10T05:08:00Z"),
	};
}

function buildService(overrides: {
	readonly listByTenant?: (
		params: Parameters<PublishingRepositories["conversations"]["listByTenant"]>[0],
	) => Promise<AdminConversationListRow[]>;
	readonly getByTenant?: (
		scope: { tenantId: TenantId },
		cid: ConversationId,
	) => Promise<AdminConversationListRow | undefined>;
	readonly task?: { readonly requestContract: string | null; readonly taskPrompt: string | null } | null;
	readonly llmCalls?: readonly LlmCallRow[];
	readonly llmCallsTableMissing?: boolean;
	readonly llmCallsError?: Error;
	readonly conversations?: unknown;
	readonly listByConversation?: (params: AdminConversationEventListParams) => Promise<ConversationEventRecord[]>;
	readonly summaries?: unknown;
	readonly auditRows?: AuditRow[];
}): { readonly service: ControlService; readonly auditRows: AuditRow[] } {
	const auditRows = overrides.auditRows ?? [];
	const rows = overrides.llmCalls ?? [];
	const missing = overrides.llmCallsTableMissing === true;
	const conversations = {
		listByTenant: overrides.listByTenant ?? (async () => []),
		getByTenant: overrides.getByTenant ?? (async () => undefined),
		getOrchestrationTaskByTenant: async () => overrides.task ?? null,
		listLlmCallsByTenant: async (
			_scope: unknown,
			_cid: unknown,
			args: { readonly limit: number; readonly after: number },
		) => {
			if (overrides.llmCallsError) throw overrides.llmCallsError;
			if (missing) return { available: false, reason: "table_missing", rows: [], total: 0 };
			return {
				available: true,
				reason: "ok",
				rows: rows.slice(args.after, args.after + args.limit),
				total: rows.length,
			};
		},
		getLlmCallByTenant: async (_scope: unknown, _cid: unknown, turnId: string, callIndex: number) => {
			if (overrides.llmCallsError) throw overrides.llmCallsError;
			if (missing) return { available: false, reason: "table_missing", rows: null, total: 0 };
			const found = rows.find((row) => row.turnId === turnId && row.callIndex === callIndex) ?? null;
			return { available: true, reason: "ok", rows: found, total: found === null ? 0 : 1 };
		},
		...((overrides.conversations as object | undefined) ?? {}),
	} as unknown as PublishingRepositories["conversations"];
	const repos: PublishingRepositories = {
		conversations,
		events: {
			listByConversation: overrides.listByConversation ?? (async () => []),
		},
		summaries: {
			getLatest: (overrides.summaries as { getLatest?: unknown } | undefined)?.getLatest ?? (async () => undefined),
			list: (overrides.summaries as { list?: unknown } | undefined)?.list ?? (async () => []),
		},
		audit: {
			insert: async (row: Parameters<PublishingRepositories["audit"]["insert"]>[0]) => {
				const r = row as { action: string; resourceId: string };
				auditRows.push({ action: r.action, resourceId: r.resourceId });
			},
		},
	} as unknown as PublishingRepositories;
	const service = new ControlService({
		repositories: repos,
		catalog: CATALOG,
		embedBaseUrl: "https://embed.example.test",
	});
	return { service, auditRows };
}

describe("WB-006 ControlService.listConversations", () => {
	test("returns a cursor for a full page with a lookahead row", async () => {
		const first = adminRow({ cursor: "first-cursor" });
		const second = adminRow({ conversationId: newConversationId(), cursor: "second-cursor" });
		const { service } = buildService({ listByTenant: async () => [first, second] });
		const result = await service.listConversations({ tenantId: TENANT_A, limit: 1 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.items).toHaveLength(1);
		expect(result.data.nextCursor).toBe("first-cursor");
	});
	test("returns a redacted list with no message bodies", async () => {
		const { service } = buildService({ listByTenant: async () => [adminRow()] });
		const result = await service.listConversations({ tenantId: TENANT_A, limit: 50 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.redacted).toBe(true);
		expect(result.data.items).toHaveLength(1);
		const item = result.data.items[0]!;
		expect(item.id).toBe(toPublicId("ConversationId", CONV_A));
		expect("payload" in item).toBe(false);
		expect(item.messageCount).toBe(6);
		expect(item.errorCount).toBe(1);
		// agentId unresolvable -> the frozen DTO uses an empty sentinel.
		expect(item.agentId).toBe("");
	});

	test("narrows preview-agent principals to platform_user for the DTO", async () => {
		const { service } = buildService({
			listByTenant: async () => [adminRow({ principalType: "platform_admin_preview" as never })],
		});
		const result = await service.listConversations({ tenantId: TENANT_A, limit: 50 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.items[0]!.principalType).toBe("platform_user");
	});

	test("passes search and last-active range through the tenant scope", async () => {
		let received: Parameters<PublishingRepositories["conversations"]["listByTenant"]>[0] | undefined;
		const lastActiveAfter = new Date("2026-01-01T00:00:00Z");
		const lastActiveBefore = new Date("2026-01-31T23:59:59Z");
		const { service } = buildService({
			listByTenant: async (params) => {
				received = params;
				return [adminRow({ turnCount: 7, agentName: "Refund Agent" })];
			},
		});

		const result = await service.listConversations({
			tenantId: TENANT_A,
			limit: 20,
			search: "refund",
			lastActiveAfter,
			lastActiveBefore,
		});

		expect(result.ok).toBe(true);
		expect(received).toMatchObject({
			scope: { tenantId: TENANT_A },
			search: "refund",
			lastActiveAfter,
			lastActiveBefore,
		});
		if (!result.ok) return;
		expect(result.data.items[0]).toMatchObject({ turnCount: 7, agentName: "Refund Agent" });
	});

	test("projects AaaS Key sessions with Run and Key ids without any secret", async () => {
		const { service } = buildService({
			listByTenant: async () => [
				adminRow({
					origin: "aaas_key",
					principalType: "service",
					keyId: "7ff48c62-1d74-444c-8e78-9823ded87ea3",
					taskId: "apifox-test-001",
					runId: "8f6fe368-809c-4889-b79e-b70f249dca6a",
				}),
			],
		});
		const result = await service.listConversations({ tenantId: TENANT_A, limit: 50 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.items[0]).toMatchObject({
			origin: "aaas_key",
			principalType: "service",
			keyId: "7ff48c62-1d74-444c-8e78-9823ded87ea3",
			taskId: "apifox-test-001",
			runId: "8f6fe368-809c-4889-b79e-b70f249dca6a",
		});
		expect(JSON.stringify(result.data)).not.toContain("ak_");
	});
});

describe("WB-006 conversation lifecycle", () => {
	test("archives an active conversation and audits the transition", async () => {
		const auditRows: AuditRow[] = [];
		let transition: string | undefined;
		const { service } = buildService({
			auditRows,
			getByTenant: async () => adminRow({ status: "active" }),
			conversations: {
				updateStatusByTenant: async (_scope: unknown, _id: unknown, _from: unknown, status: string) => {
					transition = status;
					return true;
				},
			},
		});
		const result = await service.updateConversationAdminStatus({
			tenantId: TENANT_A,
			conversationId: CONV_A,
			status: "archived",
		});
		expect(result.ok).toBe(true);
		expect(transition).toBe("archived");
		expect(auditRows.some((row) => row.action === "conversation.archived")).toBe(true);
	});

	test("soft-deletes an archived conversation while preserving its row", async () => {
		let transition: string | undefined;
		const { service } = buildService({
			getByTenant: async () => adminRow({ status: "archived" }),
			conversations: {
				updateStatusByTenant: async (_scope: unknown, _id: unknown, _from: unknown, status: string) => {
					transition = status;
					return true;
				},
			},
		});
		const result = await service.updateConversationAdminStatus({
			tenantId: TENANT_A,
			conversationId: CONV_A,
			status: "deleted",
		});
		expect(result.ok).toBe(true);
		expect(transition).toBe("deleted");
	});

	test("idempotently accepts an already archived conversation", async () => {
		const { service } = buildService({ getByTenant: async () => adminRow({ status: "archived" }) });
		const result = await service.updateConversationAdminStatus({
			tenantId: TENANT_A,
			conversationId: CONV_A,
			status: "archived",
		});
		expect(result.ok).toBe(true);
	});
});

describe("WB-006 ControlService.listConversationEvents", () => {
	test("classifies unknown event types as kind=unknown and audits the read", async () => {
		const auditRows: AuditRow[] = [];
		const { service } = buildService({
			auditRows,
			getByTenant: async (_scope, cid) => (cid === CONV_A ? adminRow() : undefined),
			listByConversation: async (params) => {
				expect(params.conversationId).toBe(CONV_A);
				expect(params.scope.tenantId).toBe(TENANT_A);
				return [
					{
						eventId: "evt_11111111-1111-1111-1111-111111111111" as ConversationEventRecord["eventId"],
						tenantId: TENANT_A,
						publishedAppId: APP_A as ConversationEventRecord["publishedAppId"],
						conversationId: CONV_A,
						sequence: 1,
						eventType: "user/message",
						eventSchemaVersion: 1,
						turnId: null,
						payload: { text: "hello" },
						payloadBytes: 16,
						createdAt: new Date(),
					},
					{
						eventId: "evt_22222222-2222-2222-2222-222222222222" as ConversationEventRecord["eventId"],
						tenantId: TENANT_A,
						publishedAppId: APP_A as ConversationEventRecord["publishedAppId"],
						conversationId: CONV_A,
						sequence: 2,
						eventType: "future/unknown-thing",
						eventSchemaVersion: 2,
						turnId: null,
						payload: { opaque: 1 },
						payloadBytes: 12,
						createdAt: new Date(),
					},
				];
			},
		});
		const result = await service.listConversationEvents({ tenantId: TENANT_A, conversationId: CONV_A, limit: 50 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.items).toHaveLength(2);
		expect(result.data.items[0]!.kind).toBe("user/message");
		expect(result.data.items[1]!.kind).toBe("unknown");
		// The unknown event type is still surfaced read-only.
		expect(result.data.items[1]!.eventType).toBe("future/unknown-thing");
		expect(auditRows.some((r) => r.action === "conversation.read-events")).toBe(true);
	});

	test("cross-tenant read is uniformly CONVERSATION_NOT_FOUND", async () => {
		const { service } = buildService({ getByTenant: async () => undefined });
		const result = await service.listConversationEvents({ tenantId: TENANT_B, conversationId: CONV_A, limit: 50 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const err = result.error as ControlServiceError;
		expect(err.code).toBe("CONVERSATION_NOT_FOUND");
		expect(err.httpStatus).toBe(404);
	});
});

describe("WB-006 ControlService summaries + detail", () => {
	test("returns the AaaS task input without any raw LLM payload", async () => {
		const prompt = "卫星分析规则\n最近 14 天时间序列：[1,2,3]\n总体评估：异常";
		const auditRows: AuditRow[] = [];
		const { service } = buildService({
			getByTenant: async (scope) => (scope.tenantId === TENANT_A ? adminRow() : undefined),
			task: { requestContract: "legacy_prompt", taskPrompt: prompt },
			llmCalls: [llmCallRow({ request: { systemPrompt: prompt, messages: [] } })],
			auditRows,
		});
		const result = await service.getConversationAdminDetail({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.taskInput).toEqual({ kind: "external_task", text: prompt });
		expect(result.data.requestContract).toBe("legacy_prompt");
		// Session V1: detail is a summary only. No request/response ever crosses this endpoint.
		expect(JSON.stringify(result.data)).not.toContain("request_payload");
		expect(Object.keys(result.data)).not.toContain("llmCalls");
		expect(result.data.trace.coverage).toBe("unknown");
		expect(auditRows.some((row) => row.action === "conversation.read-transcript")).toBe(true);
		const crossTenant = await service.getConversationAdminDetail({ tenantId: TENANT_B, conversationId: CONV_A });
		expect(crossTenant.ok).toBe(false);
	});
	test("independent orchestration detail and summaries use their integration ownership", async () => {
		const integrationId = "11111111-2222-3333-4444-555555555555";
		const row = adminRow({
			source: "orchestration",
			publishedAppId: null,
			publishedAppVersionId: null,
			integrationId,
			orchestrationVersionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		});
		let calls = 0;
		const validate = async (scope: {
			tenantId: TenantId;
			publishedAppId: unknown;
			integrationId?: string;
			principalId: unknown;
		}) => {
			expect(scope).toEqual({
				tenantId: TENANT_A,
				publishedAppId: null,
				integrationId,
				principalId: row.ownerPrincipalId,
			});
			calls++;
		};
		const { service } = buildService({
			getByTenant: async () => row,
			summaries: {
				getLatest: async (scope: Parameters<typeof validate>[0]) => {
					await validate(scope);
					return undefined;
				},
				list: async (scope: Parameters<typeof validate>[0]) => {
					await validate(scope);
					return [];
				},
			},
		});
		expect((await service.getConversationAdminDetail({ tenantId: TENANT_A, conversationId: CONV_A })).ok).toBe(true);
		expect((await service.listConversationSummaries({ tenantId: TENANT_A, conversationId: CONV_A })).ok).toBe(true);
		expect(calls).toBe(2);
	});
	test("getConversationAdminDetail writes a transcript audit event", async () => {
		const auditRows: AuditRow[] = [];
		const { service } = buildService({
			auditRows,
			getByTenant: async () => adminRow({ rolledOverAt: new Date("2026-01-03T00:00:00Z") }),
		});
		const result = await service.getConversationAdminDetail({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.rollover.rolledOverAt).toBe("2026-01-03T00:00:00.000Z");
		expect(auditRows.some((r) => r.action === "conversation.read-transcript")).toBe(true);
	});

	test("listConversationSummaries projects the body and rollover chain", async () => {
		const auditRows: AuditRow[] = [];
		const { service } = buildService({
			auditRows,
			getByTenant: async () =>
				adminRow({ nextConversationId: "conv_99999999-9999-9999-9999-999999999999" as never }),
			summaries: {
				list: async () => [
					{
						id: "csum_12345678-1234-1234-1234-123456789012",
						tenantId: TENANT_A,
						publishedAppId: APP_A,
						ownerPrincipalId: "prn_000",
						conversationId: CONV_A,
						throughSequence: 18,
						modelId: "(deterministic-summary)",
						sourceEventCount: 9,
						sourceBytes: 500,
						body: {
							text: "summary text",
							keyFacts: ["fact a", "fact b"],
							openItems: ["open q"],
							lastUserMessage: "latest user msg",
						},
						createdAt: new Date("2026-01-03T00:00:00Z"),
					},
				],
			},
		});
		const result = await service.listConversationSummaries({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.items).toHaveLength(1);
		expect(result.data.latest?.throughSequence).toBe(18);
		expect(result.data.latest?.lastUserMessage).toBe("latest user msg");
		expect(result.data.latest?.keyFacts).toEqual(["fact a", "fact b"]);
		expect(result.data.rollover.nextConversationId).toBe(
			toPublicId("ConversationId", "conv_99999999-9999-9999-9999-999999999999" as ConversationId),
		);
		expect(auditRows.some((r) => r.action === "conversation.read-summary")).toBe(true);
	});
});

const ORCHESTRATION_ROW = adminRow({ integrationId: "11111111-2222-3333-4444-555555555555" });

function simpleEvent(sequence: number, eventType: string, payload: unknown = {}): ConversationEventRecord {
	return {
		...turnEndEvent(sequence, payload),
		eventId: `evt_${String(sequence).padStart(12, "0")}` as ConversationEventRecord["eventId"],
		eventType,
	};
}

function perCall(index: number): Record<string, unknown> {
	return {
		model: "custom/Qwen",
		// Authoritative call index; deliberately not equal to the array position + 1
		// in the identity test below to catch positional assumptions.
		callIndex: index * 10,
		input: index * 100,
		output: index * 10,
		cacheRead: 20,
		cacheWrite: 0,
		totalTokens: index * 110 + 20,
		// New per-call records carry explicit status/usage; service must expose them.
		status: "completed",
		usageReported: true,
	};
}

describe("Session V1 — trace availability, on-demand raw payloads and usage", () => {
	test("a missing 0030 table degrades the detail instead of returning 500", async () => {
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			llmCallsTableMissing: true,
		});
		const detail = await service.getConversationAdminDetail({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(detail.ok).toBe(true);
		if (!detail.ok) return;
		expect(detail.data.trace.reason).toBe("table_missing");
		expect(detail.data.trace.coverage).toBe("unknown");
		const raw = await service.getConversationLlmCallDetail({
			tenantId: TENANT_A,
			conversationId: CONV_A,
			turnId: "2cdbe45e-0524-4812-b8a0-98056a2f7741" as never,
			callIndex: 1,
		});
		expect(raw.ok).toBe(false);
		if (!raw.ok) expect(raw.error.code).toBe("LLM_TRACE_UNAVAILABLE");
	});

	test("any other database error is surfaced with a diagnostic instead of being swallowed", async () => {
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			llmCallsError: new Error("connection refused"),
		});
		const detail = await service.getConversationAdminDetail({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(detail.ok).toBe(false);
		if (!detail.ok) {
			expect(detail.error.code).toBe("LLM_TRACE_QUERY_FAILED");
			expect(detail.error.message).toContain("connection refused");
		}
	});

	test("only legacy_prompt exposes a task_prompt; other contracts keep their real user/message", async () => {
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			task: { requestContract: "input_v1", taskPrompt: null },
		});
		const detail = await service.getConversationAdminDetail({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(detail.ok).toBe(true);
		if (detail.ok) {
			expect(detail.data.taskInput).toBeNull();
			expect(detail.data.requestContract).toBe("input_v1");
		}
	});

	test("the summary list never carries a raw request or response", async () => {
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			llmCalls: [llmCallRow()],
		});
		const list = await service.listConversationLlmCalls({
			tenantId: TENANT_A,
			conversationId: CONV_A,
			limit: 50,
			after: 0,
		});
		expect(list.ok).toBe(true);
		if (!list.ok) return;
		expect(list.data.items).toHaveLength(1);
		expect(list.data.items[0]!.status).toBe("completed");
		expect(list.data.items[0]!.toolCallNames).toEqual(["getSatelliteById"]);
		expect(list.data.items[0]!.messageCount).toBe(1);
		expect(list.data.items[0]!.durationMs).toBe(1000);
		// No raw payload values (System Prompt body, messages, tool schemas) in the summary.
		expect(JSON.stringify(list.data)).not.toContain('"rules"');
		expect(Object.keys(list.data.items[0]!)).not.toContain("request");
		expect(Object.keys(list.data.items[0]!)).not.toContain("response");
		expect(list.data.trace.coverage).toBe("unknown");
	});

	test("a request without a response is marked incomplete, never complete", async () => {
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			llmCalls: [llmCallRow({ response: null, completedAt: null })],
		});
		const list = await service.listConversationLlmCalls({
			tenantId: TENANT_A,
			conversationId: CONV_A,
			limit: 50,
			after: 0,
		});
		expect(list.ok).toBe(true);
		if (list.ok) expect(list.data.items[0]!.status).toBe("incomplete");
	});

	test("on-demand raw payload is tenant-scoped, redacted and audited", async () => {
		const auditRows: AuditRow[] = [];
		const secret = "sk-abcdefghijklmnop123456";
		const { service } = buildService({
			auditRows,
			getByTenant: async (scope) => (scope.tenantId === TENANT_A ? ORCHESTRATION_ROW : undefined),
			llmCalls: [
				llmCallRow({
					request: { systemPrompt: "rules", messages: [], apiKey: secret, authorization: "Bearer secret" },
				}),
			],
		});
		const raw = await service.getConversationLlmCallDetail({
			tenantId: TENANT_A,
			conversationId: CONV_A,
			turnId: "2cdbe45e-0524-4812-b8a0-98056a2f7741" as never,
			callIndex: 1,
		});
		expect(raw.ok).toBe(true);
		if (!raw.ok) return;
		expect(raw.data.redacted).toBe(true);
		expect(JSON.stringify(raw.data.request)).not.toContain(secret);
		expect(auditRows.some((row) => row.action === "conversation.read-llm-call")).toBe(true);
		const crossTenant = await service.getConversationLlmCallDetail({
			tenantId: TENANT_B,
			conversationId: CONV_A,
			turnId: "2cdbe45e-0524-4812-b8a0-98056a2f7741" as never,
			callIndex: 1,
		});
		expect(crossTenant.ok).toBe(false);
	});

	test("5 LLM calls and 4 tools: totals come from llmUsage.total, not the last call", async () => {
		const calls = [1, 2, 3, 4, 5].map(perCall);
		const events: ConversationEventRecord[] = [
			simpleEvent(1, "turn/start"),
			...[1, 2, 3, 4].map((i) => simpleEvent(1 + i, "tool/call")),
			turnEndEvent(6, {
				ok: true,
				// Legacy last-call usage must never be mistaken for the Turn total.
				usage: { input: 99999, output: 99999, cacheRead: 0, cacheWrite: 0, totalTokens: 199998 },
				llmUsage: {
					calls,
					total: { input: 1500, output: 150, cacheRead: 100, cacheWrite: 0, totalTokens: 1750 },
					callCount: 5,
					partial: false,
				},
			}),
		];
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			listByConversation: async () => events,
			llmCalls: [1, 2, 3, 4, 5].map((i) => llmCallRow({ callIndex: i })),
		});
		const usage = await service.getConversationSessionUsage({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(usage.ok).toBe(true);
		if (!usage.ok) return;
		expect(usage.data.calls).toHaveLength(5);
		expect(usage.data.totals).toEqual({
			input: 1500,
			output: 150,
			cacheRead: 100,
			cacheWrite: 0,
			totalTokens: 1750,
			reasoning: null,
		});
		expect(usage.data.toolCallCount).toBe(4);
		// Stable call index comes from the record, not from array position: the
		// fifth row is index 5 but carries authoritative callIndex 50.
		expect(usage.data.calls.map((call) => call.callIndex)).toEqual([10, 20, 30, 40, 50]);
		expect(usage.data.calls.map((call) => call.index)).toEqual([1, 2, 3, 4, 5]);
		expect(usage.data.calls[4]!.contextTokens).toBe(520); // input(500) + cacheRead(20), no cacheWrite
		// Prompt Token = input + cacheRead + cacheWrite; cacheWrite is 0 in this fixture.
		expect(usage.data.calls[4]!.promptTokens).toBe(520);
		expect(usage.data.latestPromptTokens).toBe(520); // last call in event order
		expect(usage.data.peakPromptTokens).toBe(520);
		expect(usage.data.notes.join(" ")).toContain("Prompt Token = input + cacheRead + cacheWrite");
		expect(usage.data.trace.coverage).toBe("complete");
		expect(usage.data.trace.recordedCalls).toBe(5);
	});

	test("per-call Prompt Token includes cacheWrite and keeps unknown as null", async () => {
		const calls: Record<string, unknown>[] = [
			{ model: "anthropic/x", input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160 },
			// Missing input/cacheRead → no reliable usage: null, not 0, not chars/4 estimate.
			{ model: "legacy/x", output: 5, cacheWrite: 0, totalTokens: 5 },
		];
		const events: ConversationEventRecord[] = [
			turnEndEvent(1, {
				ok: true,
				llmUsage: {
					calls,
					total: { input: 100, output: 25, cacheRead: 30, cacheWrite: 10, totalTokens: 165 },
					callCount: 2,
					partial: false,
				},
			}),
		];
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			listByConversation: async () => events,
			llmCalls: [llmCallRow({ callIndex: 1 }), llmCallRow({ callIndex: 2 })],
		});
		const usage = await service.getConversationSessionUsage({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(usage.ok).toBe(true);
		if (!usage.ok) return;
		expect(usage.data.calls[0]!.promptTokens).toBe(140); // 100 + 30 + 10
		expect(usage.data.calls[1]!.promptTokens).toBeNull();
		expect(usage.data.calls[1]!.contextTokens).toBeNull();
		// Legacy totals aggregation is unchanged by the prompt-token field.
		expect(usage.data.totals).toEqual({
			input: 100,
			output: 25,
			cacheRead: 30,
			cacheWrite: 10,
			totalTokens: 165,
			reasoning: null,
		});
		// Peak ignores the unknown call; latest is the (unknown) last call, no fallback.
		expect(usage.data.peakPromptTokens).toBe(140);
		expect(usage.data.latestPromptTokens).toBeNull();
	});

	test("all-unknown calls yield null latest/peak, never fabricated zero", async () => {
		const events: ConversationEventRecord[] = [
			turnEndEvent(1, {
				ok: true,
				llmUsage: {
					calls: [{ output: 3, totalTokens: 3 }],
					total: { input: 0, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
					callCount: 1,
					partial: false,
				},
			}),
		];
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			listByConversation: async () => events,
			llmCalls: [llmCallRow()],
		});
		const usage = await service.getConversationSessionUsage({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(usage.ok).toBe(true);
		if (!usage.ok) return;
		expect(usage.data.calls[0]!.promptTokens).toBeNull();
		expect(usage.data.latestPromptTokens).toBeNull();
		expect(usage.data.peakPromptTokens).toBeNull();
	});

	test("partial turn with one reported and one unreported call keeps confirmed total and flags incompleteness", async () => {
		const events: ConversationEventRecord[] = [
			turnEndEvent(1, {
				ok: true,
				llmUsage: {
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
						{
							model: "m",
							status: "failed",
							usageReported: false,
						},
					],
					total: { input: 100, output: 10, cacheRead: 20, cacheWrite: 0, totalTokens: 130 },
					callCount: 2,
					partial: true,
				},
			}),
		];
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			listByConversation: async () => events,
			llmCalls: [llmCallRow({ callIndex: 1 }), llmCallRow({ callIndex: 2 })],
		});
		const usage = await service.getConversationSessionUsage({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(usage.ok).toBe(true);
		if (!usage.ok) return;
		// Confirmed consumption is retained, unknown call stays unknown (no fake 0).
		expect(usage.data.totals?.totalTokens).toBe(130);
		expect(usage.data.calls[1]!.contextTokens).toBeNull();
		expect(usage.data.calls[1]!.promptTokens).toBeNull();
		// Completeness is expressed separately, not by dropping the confirmed total.
		expect(usage.data.accurateTurns).toBe(0);
		expect(usage.data.partialTurns).toBe(1);
		expect(usage.data.turns[0]!.precision).toBe("partial");
		expect(usage.data.turns[0]!.totals?.totalTokens).toBe(130);
		expect(usage.data.notes.join(" ")).toContain("有调用未上报用量");
	});

	test("per-call timing is passed through when present and stays absent for legacy calls", async () => {
		const timing = {
			startedAtMs: 1_700_000_000_000,
			endedAtMs: 1_700_000_000_125,
			durationMs: 125,
			firstOutputLatencyMs: 40,
		};
		const events: ConversationEventRecord[] = [
			turnEndEvent(1, {
				ok: true,
				llmUsage: {
					calls: [
						{
							model: "m",
							input: 10,
							output: 2,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 12,
							timing,
						},
						// Legacy/new call without an observed response boundary: no timing.
						{ model: "m", input: 20, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 23 },
					],
					total: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 35 },
					callCount: 2,
					partial: false,
				},
			}),
		];
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			listByConversation: async () => events,
			llmCalls: [llmCallRow({ callIndex: 1 }), llmCallRow({ callIndex: 2 })],
		});
		const usage = await service.getConversationSessionUsage({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(usage.ok).toBe(true);
		if (!usage.ok) return;
		expect(usage.data.calls[0]!.timing).toEqual(timing);
		expect(usage.data.calls[1]!.timing).toBeUndefined();
		// Derived per-call metrics: generation = 125 - 40 = 85ms, TPS = 2/0.085.
		expect(usage.data.calls[0]!.generationMs).toBe(85);
		expect(usage.data.calls[0]!.observedOutputTps).toBeCloseTo((2 * 1000) / 85);
		// No timing/first delta → unknown, not a fabricated 0.
		expect(usage.data.calls[1]!.generationMs).toBeNull();
		expect(usage.data.calls[1]!.observedOutputTps).toBeNull();
		// Timing does not alter token semantics.
		expect(usage.data.calls[0]!.promptTokens).toBe(10);
		expect(usage.data.totals?.totalTokens).toBe(35);
		expect(usage.data.notes.join(" ")).toContain("Runtime 在 provider 边界观察到的请求耗时");
		expect(usage.data.notes.join(" ")).toContain("Runtime 客户端观察值");
	});

	test("derived performance derives generation independently of usage and ignores wall-clock regressions", async () => {
		const baseTiming = { startedAtMs: 1_700_000_000_000, endedAtMs: 1_700_000_000_100, durationMs: 100 };
		const calls = [
			// No first-output delta → generation/TPS unknown.
			{
				model: "m",
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				timing: baseTiming,
			},
			// Provider did not report usage → generation still valid, TPS unknown.
			{
				model: "m",
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				usageReported: false,
				timing: { ...baseTiming, firstOutputLatencyMs: 10 },
			},
			// Output token absent → generation still valid, TPS unknown.
			{
				model: "m",
				input: 10,
				cacheRead: 0,
				totalTokens: 10,
				timing: { ...baseTiming, firstOutputLatencyMs: 20 },
			},
			// Invalid interval: first output equals duration → generationMs <= 0.
			{
				model: "m",
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				timing: { ...baseTiming, firstOutputLatencyMs: 100 },
			},
			// Wall-clock regression is display-only: monotonic duration=60 still yields generation=50.
			{
				model: "m",
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				timing: {
					startedAtMs: baseTiming.endedAtMs,
					endedAtMs: baseTiming.startedAtMs,
					durationMs: 60,
					firstOutputLatencyMs: 10,
				},
			},
			// Historical call: neither timing nor derived metrics exist.
			{ model: "legacy", input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
		];
		const events: ConversationEventRecord[] = [
			turnEndEvent(1, {
				ok: true,
				llmUsage: {
					calls,
					total: { input: 57, output: 23, cacheRead: 0, cacheWrite: 0, totalTokens: 80 },
					callCount: calls.length,
					partial: false,
				},
			}),
		];
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			listByConversation: async () => events,
			llmCalls: calls.map((_call, index) => llmCallRow({ callIndex: index + 1 })),
		});
		const usage = await service.getConversationSessionUsage({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(usage.ok).toBe(true);
		if (!usage.ok) return;
		expect(usage.data.calls.map((call) => call.generationMs)).toEqual([null, 90, 80, null, 50, null]);
		expect(usage.data.calls.map((call) => call.observedOutputTps)).toEqual([
			null,
			null,
			null,
			null,
			(5 * 1000) / 50,
			null,
		]);
		// Token aggregation is unchanged by the derived metrics.
		expect(usage.data.totals?.totalTokens).toBe(80);
	});

	test("calls without a stored callIndex stay unknown and never inherit array position", async () => {
		const events: ConversationEventRecord[] = [
			turnEndEvent(1, {
				ok: true,
				llmUsage: {
					// Legacy record: has usage but no authoritative callIndex.
					calls: [
						{ input: 100, output: 10, cacheRead: 20, cacheWrite: 0, totalTokens: 130 },
						{ input: 200, output: 20, cacheRead: 20, cacheWrite: 0, totalTokens: 240 },
					],
					total: { input: 300, output: 30, cacheRead: 40, cacheWrite: 0, totalTokens: 370 },
					callCount: 2,
					partial: false,
				},
			}),
		];
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			listByConversation: async () => events,
			llmCalls: [llmCallRow({ callIndex: 1 }), llmCallRow({ callIndex: 2 })],
		});
		const usage = await service.getConversationSessionUsage({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(usage.ok).toBe(true);
		if (!usage.ok) return;
		expect(usage.data.calls.map((call) => call.callIndex)).toEqual([null, null]);
		expect(usage.data.calls.map((call) => call.index)).toEqual([1, 2]);
		// Totals are unaffected by the missing identity field.
		expect(usage.data.totals?.totalTokens).toBe(370);
		expect(usage.data.notes.join(" ")).toContain("不用数组位置回填");
	});

	test("cancelled turns keep confirmed usage in totals but stay flagged incomplete", async () => {
		const interrupted = {
			...turnEndEvent(1, {}),
			eventType: "turn/interrupted",
			payload: {
				aborted: true,
				usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55 },
				llmUsage: {
					calls: [{ model: "m", input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55 }],
					total: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55 },
					callCount: 1,
					partial: false,
				},
			},
		} as ConversationEventRecord;
		const success = turnEndEvent(2, {
			ok: true,
			llmUsage: {
				calls: [perCall(1)],
				total: { input: 100, output: 10, cacheRead: 20, cacheWrite: 0, totalTokens: 130 },
				callCount: 1,
				partial: false,
			},
		});
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			listByConversation: async () => [interrupted, success],
			llmCalls: [llmCallRow()],
		});
		const usage = await service.getConversationSessionUsage({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(usage.ok).toBe(true);
		if (!usage.ok) return;
		// Both calls are visible; the cancelled Turn's confirmed 55 tokens are
		// accumulated, but it stays partial — only the successful Turn is accurate.
		expect(usage.data.calls).toHaveLength(2);
		expect(usage.data.calls[0]!.promptTokens).toBe(50);
		expect(usage.data.calls[0]!.precision).toBe("partial");
		expect(usage.data.totals?.totalTokens).toBe(185);
		expect(usage.data.accurateTurns).toBe(1);
		expect(usage.data.partialTurns).toBe(1);
		expect(usage.data.trace.coverage).not.toBe("complete");
		expect(usage.data.notes.join(" ")).toContain("取消 Turn");
	});

	test("per-call status and usage completeness are exposed; legacy records default safely", async () => {
		const events: ConversationEventRecord[] = [
			turnEndEvent(1, {
				ok: true,
				llmUsage: {
					calls: [
						{
							model: "m",
							callIndex: 1,
							input: 50,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 55,
							status: "failed",
							usageReported: true,
						},
						{
							model: "m",
							callIndex: 2,
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							status: "aborted",
							usageReported: false,
						},
						// Legacy record: no status/usageReported fields at all.
						{ model: "legacy", input: 70, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 77 },
					],
					total: { input: 120, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 132 },
					callCount: 3,
					partial: false,
				},
			}),
		];
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			listByConversation: async () => events,
			llmCalls: [llmCallRow()],
		});
		const usage = await service.getConversationSessionUsage({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(usage.ok).toBe(true);
		if (!usage.ok) return;
		expect(usage.data.calls.map((call) => call.status)).toEqual(["failed", "aborted", "completed"]);
		expect(usage.data.calls.map((call) => call.usageReported)).toEqual([true, false, true]);
		// No reliable usage on the aborted call: tokens are unknown, not a fabricated 0.
		expect(usage.data.calls[1]!.contextTokens).toBeNull();
		expect(usage.data.calls[1]!.promptTokens).toBeNull();
		// Legacy record keeps completed + reported defaults and its real tokens.
		expect(usage.data.calls[2]!.status).toBe("completed");
		expect(usage.data.calls[2]!.promptTokens).toBe(70);
		expect(usage.data.notes.join(" ")).toContain("usageReported=false");
	});

	test("legacy turns stay out of confirmed totals; partial turns contribute their reported tokens", async () => {
		const events = [
			turnEndEvent(1, { ok: true, usage: { input: 999, output: 999, totalTokens: 1998 } }),
			turnEndEvent(2, {
				ok: true,
				llmUsage: {
					calls: [perCall(1)],
					total: { input: 100, output: 10, cacheRead: 20, cacheWrite: 0, totalTokens: 130 },
					callCount: 2,
					partial: true,
				},
			}),
		];
		const { service } = buildService({
			getByTenant: async () => ORCHESTRATION_ROW,
			listByConversation: async () => events,
			llmCalls: [llmCallRow()],
		});
		const usage = await service.getConversationSessionUsage({ tenantId: TENANT_A, conversationId: CONV_A });
		expect(usage.ok).toBe(true);
		if (!usage.ok) return;
		// Legacy last-call usage (1998) is still excluded; the partial Turn's real
		// per-call total (130) is confirmed consumption and is counted.
		expect(usage.data.totals?.totalTokens).toBe(130);
		expect(usage.data.legacyTurns).toBe(1);
		expect(usage.data.partialTurns).toBe(1);
		expect(usage.data.accurateTurns).toBe(0);
		expect(usage.data.trace.coverage).toBe("unknown");
		expect(usage.data.notes.join(" ")).toContain("历史口径");
		expect(usage.data.notes.join(" ")).toContain("已确认消耗");
	});
});
