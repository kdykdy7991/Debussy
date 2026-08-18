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
		...overrides,
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
	readonly conversations?: unknown;
	readonly listByConversation?: (params: AdminConversationEventListParams) => Promise<ConversationEventRecord[]>;
	readonly summaries?: unknown;
	readonly auditRows?: AuditRow[];
}): { readonly service: ControlService; readonly auditRows: AuditRow[] } {
	const auditRows = overrides.auditRows ?? [];
	const conversations = {
		listByTenant: overrides.listByTenant ?? (async () => []),
		getByTenant: overrides.getByTenant ?? (async () => undefined),
		...((overrides.conversations as object | undefined) ?? {}),
	} as PublishingRepositories["conversations"];
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
