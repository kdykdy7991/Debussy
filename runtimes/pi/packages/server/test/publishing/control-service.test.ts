/**
 * TASK-011: PublishedApp/Version control service (spec 33 + 27.1/27.2).
 *
 * Verifies the full publish-model flow without HTTP: idempotent tenant
 * bootstrap (existing tenant is never overwritten), agent import with
 * revision increment on source drift and 409 on expectedSourceHash mismatch,
 * cross-tenant publishing rejected, atomic version numbers under concurrency,
 * rejected versions with validationErrors, and draft edits never changing an
 * already-compiled version. Requires the local test database.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { ControlService, type CurrentAgentDefinitionSource } from "../../src/publishing/control/service.ts";
import { newAgentDefinitionId, newTenantId } from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import type { AgentDraftConfig, CapabilityCatalog } from "../../src/publishing/runtime-spec/compiler.ts";

const SCHEMA = `pub_test_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";

async function probe(): Promise<boolean> {
	try {
		const client = new PostgresClient({ url: PG_URL, connectTimeoutSeconds: 2, searchPath: SCHEMA });
		await client.ping();
		await client.close();
		return true;
	} catch {
		return false;
	}
}

const pgUp = await probe();

const CATALOG: CapabilityCatalog = {
	tools: [{ id: "web.search", name: "Web Search" }],
	models: [{ provider: "skdy", modelId: "pi-chat" }],
	knowledgeBases: [{ id: "kb-legal" }],
};

function source(config: AgentDraftConfig, name = "current-agent"): CurrentAgentDefinitionSource {
	return {
		async collect() {
			return { name, config, warnings: [] };
		},
	};
}

function baseConfig(overrides: Partial<AgentDraftConfig> = {}): AgentDraftConfig {
	return {
		prompt: "You are a helpful assistant.",
		model: { provider: "skdy", modelId: "pi-chat" },
		tools: [{ id: "web.search" }],
		uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
		speech: { enabled: false },
		avatar: { enabled: false },
		theme: { primaryColor: "#2563eb", welcomeMessage: "Hi" },
		...overrides,
	};
}

describe.skipIf(!pgUp)("control service", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let service: ControlService;

	const tenantA = newTenantId();
	const tenantB = newTenantId();

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);
		service = new ControlService({ repositories: repos, catalog: CATALOG, embedBaseUrl: "https://embed.test" });
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	test("bootstrapTenant creates once and is idempotent afterwards", async () => {
		const first = await service.bootstrapTenant({ tenantId: tenantA, tenantName: "tenant-a" });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.data.created).toBe(true);
		expect(first.data.tenant.tenantId).toBe(tenantA);

		const second = await service.bootstrapTenant({ tenantId: tenantA, tenantName: "tenant-a" });
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.data.created).toBe(false);
		expect(second.data.tenant.tenantId).toBe(tenantA);
	});

	test("bootstrapTenant rejects an existing tenant with a different name/status", async () => {
		const result = await service.bootstrapTenant({ tenantId: tenantA, tenantName: "other-name" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("BOOTSTRAP_MISMATCH");
		expect(result.error.httpStatus).toBe(409);
	});

	test("importAgent creates revision 1 and is idempotent for an unchanged config", async () => {
		const first = await service.importAgent({ tenantId: tenantA }, source(baseConfig()));
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.data.revision).toBe(1);
		expect(first.data.sourceHash).toMatch(/^[0-9a-f]{64}$/);

		const again = await service.importAgent({ tenantId: tenantA }, source(baseConfig()));
		expect(again.ok).toBe(true);
		if (!again.ok) return;
		expect(again.data.revision).toBe(1); // same hash, no new revision
		expect(again.data.agentDefinitionId).toBe(first.data.agentDefinitionId);
	});

	test("importAgent creates revision+1 on source drift and keeps old revisions", async () => {
		const v1 = await service.importAgent({ tenantId: tenantA }, source(baseConfig()));
		expect(v1.ok).toBe(true);
		if (!v1.ok) return;
		const v2 = await service.importAgent({ tenantId: tenantA }, source(baseConfig({ prompt: "A drifted prompt." })));
		expect(v2.ok).toBe(true);
		if (!v2.ok) return;
		expect(v2.data.revision).toBe(2);
		expect(v2.data.agentDefinitionId).toBe(v1.data.agentDefinitionId);
		expect(v2.data.sourceHash).not.toBe(v1.data.sourceHash);

		// Revision 1 is still readable and unchanged.
		const old = await repos.agentDefinitions.getRevision({ tenantId: tenantA }, v1.data.agentDefinitionId, 1);
		expect(old?.draftConfig).toEqual(baseConfig());
	});

	test("importAgent returns 409 when expectedSourceHash does not match", async () => {
		const result = await service.importAgent(
			{ tenantId: tenantA, expectedSourceHash: "f".repeat(64) },
			source(baseConfig()),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("SOURCE_HASH_MISMATCH");
		expect(result.error.httpStatus).toBe(409);
	});

	test("createPublishedApp pins a same-tenant agent and stores theme in mutablePolicy", async () => {
		const imported = await service.importAgent({ tenantId: tenantA }, source(baseConfig({ prompt: "app pin" })));
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const result = await service.createPublishedApp({
			tenantId: tenantA,
			agentDefinitionId: imported.data.agentDefinitionId,
			name: "app-a",
			accessMode: "mixed",
			allowedOrigins: ["https://a.example.com"],
			theme: { primaryColor: "#2563eb", welcomeMessage: "Hi" },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.app.status).toBe("draft");
		expect(result.data.app.currentVersionId).toBeNull();
		expect(result.data.publicAppId).toMatch(/^pub_/);
		expect(result.data.embedUrl).toBe(`https://embed.test/embed/${result.data.publicAppId}`);
		expect(result.data.app.mutablePolicy).toEqual({ theme: { primaryColor: "#2563eb", welcomeMessage: "Hi" } });
	});

	test("createPublishedApp rejects origins that fail the strict origin policy", async () => {
		const imported = await service.importAgent(
			{ tenantId: tenantA },
			source(baseConfig({ prompt: "origin-policy" })),
		);
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const bad = await service.createPublishedApp({
			tenantId: tenantA,
			agentDefinitionId: imported.data.agentDefinitionId,
			name: "bad-origins",
			accessMode: "anonymous",
			allowedOrigins: ["*", "http://a.example.com", "https://*.com", "https://a.example.com/x"],
		});
		expect(bad.ok).toBe(false);
		if (bad.ok) return;
		expect(bad.error.code).toBe("INVALID_ORIGINS");
		expect(bad.error.httpStatus).toBe(400);
		const good = await service.createPublishedApp({
			tenantId: tenantA,
			agentDefinitionId: imported.data.agentDefinitionId,
			name: "good-origins",
			accessMode: "anonymous",
			allowedOrigins: ["https://a.example.com", "https://*.internal.example.com", "http://localhost:5173"],
		});
		expect(good.ok).toBe(true);
	});

	test("createPublishedApp rejects an agent from another tenant", async () => {
		const importedA = await service.importAgent({ tenantId: tenantA }, source(baseConfig({ prompt: "tenant a" })));
		expect(importedA.ok).toBe(true);
		if (!importedA.ok) return;
		// tenantB tries to publish tenantA's agent: not visible -> 404.
		const result = await service.createPublishedApp({
			tenantId: tenantB,
			agentDefinitionId: importedA.data.agentDefinitionId,
			name: "cross-tenant",
			accessMode: "anonymous",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("AGENT_NOT_FOUND");
		expect(result.error.httpStatus).toBe(404);
	});

	test("createPublishedAppVersion compiles ready versions with atomic version numbers", async () => {
		const imported = await service.importAgent({ tenantId: tenantA }, source(baseConfig({ prompt: "version race" })));
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const app = await service.createPublishedApp({
			tenantId: tenantA,
			agentDefinitionId: imported.data.agentDefinitionId,
			name: "race-app",
			accessMode: "anonymous",
		});
		expect(app.ok).toBe(true);
		if (!app.ok) return;

		const creates = await Promise.all(
			Array.from({ length: 10 }, () =>
				service.createPublishedAppVersion({
					tenantId: tenantA,
					publishedAppId: app.data.app.publishedAppId,
					sourceAgentRevision: imported.data.revision,
				}),
			),
		);
		expect(creates.every((c) => c.ok)).toBe(true);
		const versions = creates.map((c) => {
			if (!c.ok) throw new Error("unreachable: all creates succeeded");
			return c.data.version;
		});
		const numbers = versions.map((v) => v.versionNumber).sort((x, y) => x - y);
		expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
		// Each version's spec embeds its own version id (5.4), so hashes
		// differ, but the compiled content must be identical across runs.
		const prompts = versions.map((v) => {
			const spec = v.runtimeSpec as { agent?: { systemPrompt?: string } };
			return spec.agent?.systemPrompt;
		});
		expect(new Set(prompts).size).toBe(1);
		expect(prompts[0]).toBe("version race");
	});

	test("createPublishedAppVersion persists rejected versions with validationErrors", async () => {
		const imported = await service.importAgent(
			{ tenantId: tenantA },
			source(baseConfig({ tools: [{ id: "shell.exec" }] })),
		);
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const app = await service.createPublishedApp({
			tenantId: tenantA,
			agentDefinitionId: imported.data.agentDefinitionId,
			name: "reject-app",
			accessMode: "anonymous",
		});
		expect(app.ok).toBe(true);
		if (!app.ok) return;
		const version = await service.createPublishedAppVersion({
			tenantId: tenantA,
			publishedAppId: app.data.app.publishedAppId,
			sourceAgentRevision: imported.data.revision,
		});
		expect(version.ok).toBe(true); // rejected version is still created
		if (!version.ok) return;
		expect(version.data.version.status).toBe("rejected");
		expect(version.data.version.validationErrors.length).toBeGreaterThan(0);
		expect(String(version.data.version.validationErrors[0])).toContain("shell.exec");
	});

	test("modifying the draft never changes an already-compiled version", async () => {
		const v1 = await service.importAgent({ tenantId: tenantA }, source(baseConfig({ prompt: "stable prompt" })));
		expect(v1.ok).toBe(true);
		if (!v1.ok) return;
		const app = await service.createPublishedApp({
			tenantId: tenantA,
			agentDefinitionId: v1.data.agentDefinitionId,
			name: "stable-app",
			accessMode: "anonymous",
		});
		expect(app.ok).toBe(true);
		if (!app.ok) return;

		const version1 = await service.createPublishedAppVersion({
			tenantId: tenantA,
			publishedAppId: app.data.app.publishedAppId,
			sourceAgentRevision: v1.data.revision,
		});
		expect(version1.ok).toBe(true);
		if (!version1.ok) return;
		const spec1 = version1.data.version.runtimeSpec as { agent?: { systemPrompt?: string } };
		expect(spec1.agent?.systemPrompt).toBe("stable prompt");

		// Drift the draft to revision 2, then compile revision 1 again: the
		// old revision's frozen output must be unaffected by the drift.
		const v2 = await service.importAgent({ tenantId: tenantA }, source(baseConfig({ prompt: "drifted prompt" })));
		expect(v2.ok).toBe(true);
		if (!v2.ok) return;

		const version2 = await service.createPublishedAppVersion({
			tenantId: tenantA,
			publishedAppId: app.data.app.publishedAppId,
			sourceAgentRevision: v2.data.revision,
		});
		expect(version2.ok).toBe(true);
		if (!version2.ok) return;
		const spec2 = version2.data.version.runtimeSpec as { agent?: { systemPrompt?: string } };
		expect(spec2.agent?.systemPrompt).toBe("drifted prompt");

		const version1Again = await service.createPublishedAppVersion({
			tenantId: tenantA,
			publishedAppId: app.data.app.publishedAppId,
			sourceAgentRevision: v1.data.revision,
		});
		expect(version1Again.ok).toBe(true);
		if (!version1Again.ok) return;
		const spec1Again = version1Again.data.version.runtimeSpec as { agent?: { systemPrompt?: string } };
		expect(spec1Again.agent?.systemPrompt).toBe("stable prompt");
	});

	test("createPublishedAppVersion rejects an unknown source revision", async () => {
		const app = await service.createPublishedApp({
			tenantId: tenantA,
			agentDefinitionId: newAgentDefinitionId(), // not imported -> not in tenant
			name: "ghost-app",
			accessMode: "anonymous",
		});
		expect(app.ok).toBe(false);
		if (app.ok) return;
		expect(app.error.code).toBe("AGENT_NOT_FOUND");

		// Valid agent but unknown revision.
		const imported = await service.importAgent({ tenantId: tenantA }, source(baseConfig({ prompt: "rev" })));
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const app2 = await service.createPublishedApp({
			tenantId: tenantA,
			agentDefinitionId: imported.data.agentDefinitionId,
			name: "rev-app",
			accessMode: "anonymous",
		});
		expect(app2.ok).toBe(true);
		if (!app2.ok) return;
		const missing = await service.createPublishedAppVersion({
			tenantId: tenantA,
			publishedAppId: app2.data.app.publishedAppId,
			sourceAgentRevision: 999,
		});
		expect(missing.ok).toBe(false);
		if (missing.ok) return;
		expect(missing.error.code).toBe("VERSION_NOT_FOUND");
	});

	test("audit failure fails closed on management ops (spec 13.4/15, TASK-035)", async () => {
		const tenantC = newTenantId();
		const boot = await service.bootstrapTenant({ tenantId: tenantC, tenantName: "tenant-c" });
		expect(boot.ok).toBe(true);
		const imported = await service.importAgent({ tenantId: tenantC }, source(baseConfig()));

		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const app = await service.createPublishedApp({
			tenantId: tenantC,
			agentDefinitionId: imported.data.agentDefinitionId,
			name: "audit-fail-app",
			accessMode: "anonymous",
		});
		expect(app.ok).toBe(true);
		if (!app.ok) return;

		// 审计失败策略：管理操作必须写审计，审计写失败 = 调用方收到 failure
		// （fail-closed），绝不静默返回成功（允许后续运维员读到审计再交接）。
		const savedInsert = repos.audit.insert;
		repos.audit.insert = async () => {
			throw new Error("audit store unavailable");
		};
		try {
			await expect(
				service.suspendApp({ tenantId: tenantC, publishedAppId: app.data.app.publishedAppId }),
			).rejects.toThrow(/audit store unavailable/);
		} finally {
			repos.audit.insert = savedInsert;
		}
	});
});
