/**
 * P1 one-click publish (`publishAgent`): publish the Agent's CURRENT latest
 * revision as an activated Published Version in one backend operation.
 *
 * Core invariants under test:
 *
 *   A. publishAgent(N = latest) → Published Version whose RuntimeSpec is
 *      behavior-identical to what the Debug path compiles for the same
 *      revision (all behavior config deep-equal; only the runtime identity
 *      `publishedAppVersionId` is allowed to differ).
 *   B. After a drift creates revision N+1, publishAgent must publish N+1 —
 *      never the already-published N, without the caller naming a revision.
 *   C. published_app resolution: 0 → auto-create, 1 → reuse, >1 →
 *      CONFLICTING_PUBLISHED_APPS (never picks one arbitrarily).
 *
 * Requires the local test database.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { ControlService, type CurrentAgentDefinitionSource } from "../../src/publishing/control/service.ts";
import { compileDebugAgentRevision } from "../../src/publishing/debug/compile.ts";
import { type AgentDefinitionId, newTenantId } from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import type { AgentDraftConfig, CapabilityCatalog } from "../../src/publishing/runtime-spec/compiler.ts";
import { canonicalJson } from "../../src/publishing/runtime-spec/hash.ts";
import type { RuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";

const SCHEMA = `pub_p1_${process.pid}_${Date.now().toString(36)}`;
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
	knowledgeBases: [],
};

function source(config: AgentDraftConfig, name = "p1-agent"): CurrentAgentDefinitionSource {
	return {
		async collect() {
			return { name, config, warnings: [] };
		},
	};
}

function baseConfig(overrides: Partial<AgentDraftConfig> = {}): AgentDraftConfig {
	return {
		prompt: "You are a P1 publish assistant.",
		model: { provider: "skdy", modelId: "pi-chat" },
		tools: [{ id: "web.search" }],
		uploads: { enabled: true, maxFiles: 10, maxFileBytes: 26214400 },
		speech: { enabled: false },
		avatar: { enabled: false },
		theme: { primaryColor: "#2563eb", welcomeMessage: "Hi" },
		contextPolicy: { maxTurns: 20, maxContextTokens: 64000 },
		runtimePolicy: { profile: "chat-only", turnTimeoutMs: 30000 },
		...overrides,
	};
}

describe.skipIf(!pgUp)("P1 agent one-click publish (publishAgent)", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let service: ControlService;
	const tenantId = newTenantId();

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);
		service = new ControlService({ repositories: repos, catalog: CATALOG, embedBaseUrl: "https://embed.test" });
		const boot = await service.bootstrapTenant({ tenantId, tenantName: "p1-tenant" });
		expect(boot.ok).toBe(true);
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	const debugCompile = (agentDefinitionId: AgentDefinitionId) =>
		compileDebugAgentRevision({ repositories: repos, catalog: CATALOG }, { tenantId }, agentDefinitionId);

	test("publishAgent(latest N) activates a version whose RuntimeSpec equals the Debug spec (ignoring versionId)", async () => {
		const imported = await service.importAgent({ tenantId }, source(baseConfig(), "p1-agent-a"));
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const agentDefinitionId = imported.data.agentDefinitionId;

		// Debug behavior config for latest revision N.
		const debug = await debugCompile(agentDefinitionId);
		expect(debug.ok).toBe(true);
		if (!debug.ok) return;
		expect(debug.agentRevision).toBe(1);

		// One-click publish.
		const published = await service.publishAgent({ tenantId, agentDefinitionId });
		expect(published.ok).toBe(true);
		if (!published.ok) return;
		expect(published.data.agentRevision).toBe(1);
		expect(published.data.version.sourceAgentRevision).toBe(1);
		expect(published.data.version.status).toBe("ready");
		expect(published.data.previousVersionId).toBeNull();
		// First publish auto-created a draft app and activated it.
		expect(published.data.publishedApp.status).toBe("active");

		// Exactly one app for the agent (0 → auto-create).
		const apps = await repos.publishedApps.listByAgentDefinition({ tenantId }, agentDefinitionId);
		expect(apps.length).toBe(1);
		expect(apps[0]?.currentVersionId).toBe(published.data.version.publishedAppVersionId);

		// Behavior config: Debug(N) == Published runtimeSpec, modulo versionId.
		const stored = await repos.publishedAppVersions.get(
			{ tenantId, publishedAppId: published.data.publishedApp.publishedAppId },
			published.data.version.publishedAppVersionId,
		);
		expect(stored).toBeDefined();
		if (stored === undefined) return;
		const specA = { ...debug.spec, publishedAppVersionId: "" };
		const specB = { ...(stored.runtimeSpec as RuntimeSpec), publishedAppVersionId: "" };
		expect(canonicalJson(specA)).toBe(canonicalJson(specB));
		expect((stored.runtimeSpec as RuntimeSpec).publishedAppVersionId).toBe(
			published.data.version.publishedAppVersionId,
		);
	});

	test("after a drift, publishAgent publishes the NEW latest revision N+1 (never the already-published N)", async () => {
		const imported = await service.importAgent(
			{ tenantId },
			source(baseConfig({ prompt: "rev N prompt" }), "p1-agent-b"),
		);
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const agentDefinitionId = imported.data.agentDefinitionId;

		// Publish revision N = 1.
		const p1 = await service.publishAgent({ tenantId, agentDefinitionId });
		expect(p1.ok).toBe(true);
		if (!p1.ok) return;
		expect(p1.data.agentRevision).toBe(1);

		// Modify the Agent → drift → revision N+1 = 2.
		const drifted = await service.importAgent(
			{ tenantId },
			source(baseConfig({ prompt: "rev N+1 drifted prompt" }), "p1-agent-b"),
		);
		expect(drifted.ok).toBe(true);
		if (!drifted.ok) return;
		expect(drifted.data.agentDefinitionId).toBe(agentDefinitionId);
		expect(drifted.data.revision).toBe(2);

		// Debug now resolves N+1.
		const debug = await debugCompile(agentDefinitionId);
		expect(debug.ok).toBe(true);
		if (!debug.ok) return;
		expect(debug.agentRevision).toBe(2);
		expect(debug.spec.agent.systemPrompt).toBe("rev N+1 drifted prompt");

		// publishAgent with NO revision argument must publish N+1, not N.
		const p2 = await service.publishAgent({ tenantId, agentDefinitionId });
		expect(p2.ok).toBe(true);
		if (!p2.ok) return;
		expect(p2.data.agentRevision).toBe(2);
		expect(p2.data.version.sourceAgentRevision).toBe(2);
		expect(p2.data.version.publishedAppVersionId).not.toBe(p1.data.version.publishedAppVersionId);
		expect(p2.data.previousVersionId).toBe(p1.data.version.publishedAppVersionId);

		// App is reused (still exactly 1), not a new one.
		const apps = await repos.publishedApps.listByAgentDefinition({ tenantId }, agentDefinitionId);
		expect(apps.length).toBe(1);
		expect(apps[0]?.currentVersionId).toBe(p2.data.version.publishedAppVersionId);

		// Published config == Debug(N+1), modulo versionId.
		const stored = await repos.publishedAppVersions.get(
			{ tenantId, publishedAppId: p2.data.publishedApp.publishedAppId },
			p2.data.version.publishedAppVersionId,
		);
		expect(stored).toBeDefined();
		if (stored === undefined) return;
		const storedB = stored.runtimeSpec as RuntimeSpec;
		expect(storedB.agent.systemPrompt).toBe("rev N+1 drifted prompt");
		expect(canonicalJson({ ...debug.spec, publishedAppVersionId: "" })).toBe(
			canonicalJson({ ...storedB, publishedAppVersionId: "" }),
		);
	});

	test("publishAgent refuses to pick when an Agent has >1 published apps", async () => {
		const imported = await service.importAgent(
			{ tenantId },
			source(baseConfig({ prompt: "conflict agent" }), "p1-agent-c"),
		);
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const agentDefinitionId = imported.data.agentDefinitionId;

		const a1 = await service.createPublishedApp({
			tenantId,
			agentDefinitionId,
			name: "dup-app-1",
			accessMode: "anonymous",
		});
		const a2 = await service.createPublishedApp({
			tenantId,
			agentDefinitionId,
			name: "dup-app-2",
			accessMode: "anonymous",
		});
		expect(a1.ok).toBe(true);
		expect(a2.ok).toBe(true);
		if (!a1.ok || !a2.ok) return;

		const didRun = await service.publishAgent({ tenantId, agentDefinitionId });
		expect(didRun.ok).toBe(false);
		if (didRun.ok) return;
		expect(didRun.error.code).toBe("CONFLICTING_PUBLISHED_APPS");
		// No version was silently created for either app.
		for (const app of [a1.data.app, a2.data.app]) {
			const versions = await repos.publishedAppVersions.list({
				scope: { tenantId, publishedAppId: app.publishedAppId },
				limit: 100,
			});
			expect(versions.length).toBe(0);
		}
		// Exactly the two manual apps remain; publishAgent did not create a third.
		const apps = await repos.publishedApps.listByAgentDefinition({ tenantId }, agentDefinitionId);
		expect(apps.length).toBe(2);
	});

	test("two concurrent first-publishes of the SAME Agent produce exactly ONE app (no TOCTOU dup)", async () => {
		const imported = await service.importAgent(
			{ tenantId },
			source(baseConfig({ prompt: "concurrent first publish" }), "p1-agent-d"),
		);
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const agentDefinitionId = imported.data.agentDefinitionId;

		const [r1, r2] = await Promise.all([
			service.publishAgent({ tenantId, agentDefinitionId }),
			service.publishAgent({ tenantId, agentDefinitionId }),
		]);

		// Both requests succeed — neither is left stuck in a conflict state.
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		if (!r1.ok || !r2.ok) return;

		// Both raced from 0 apps yet resolved to the SAME single internal app.
		const apps = await repos.publishedApps.listByAgentDefinition({ tenantId }, agentDefinitionId);
		expect(apps.length).toBe(1);
		expect(r1.data.publishedApp.publishedAppId).toBe(r2.data.publishedApp.publishedAppId);
		expect(apps[0]?.publishedAppId).toBe(r1.data.publishedApp.publishedAppId);

		// Exactly one active app with a live current version (not >1 apps).
		expect(apps[0]?.status).toBe("active");
		expect(apps[0]?.currentVersionId).toBeDefined();

		// The two publishes created two versions on the same app; the final
		// current version is one of them, and the other superseded it.
		const versions = await repos.publishedAppVersions.list({
			scope: { tenantId, publishedAppId: r1.data.publishedApp.publishedAppId },
			limit: 20,
		});
		expect(versions.length).toBeGreaterThanOrEqual(2);
		const currentMatchesActivation = versions.some((v) => v.publishedAppVersionId === apps[0]?.currentVersionId);
		expect(currentMatchesActivation).toBe(true);
	});

	test("listAgentApps exposes the live publish status for the Agent page", async () => {
		const imported = await service.importAgent(
			{ tenantId },
			source(baseConfig({ prompt: "list apps status" }), "p1-agent-e"),
		);
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const agentDefinitionId = imported.data.agentDefinitionId;

		// Unpublished: no apps, so the page shows 未发布.
		const before = await service.listAgentDefinitionApps({ tenantId, agentDefinitionId });
		expect(before.ok).toBe(true);
		if (!before.ok) return;
		expect(before.data.items).toHaveLength(0);

		// Publish → the single internal app carries the publish status.
		const published = await service.publishAgent({ tenantId, agentDefinitionId });
		expect(published.ok).toBe(true);
		if (!published.ok) return;

		const after = await service.listAgentDefinitionApps({ tenantId, agentDefinitionId });
		expect(after.ok).toBe(true);
		if (!after.ok) return;
		expect(after.data.items).toHaveLength(1);
		const app = after.data.items[0]!;
		expect(app.status).toBe("active");
		expect(app.sourceAgentRevision).toBe(1);
		expect(app.versionNumber).toBe(published.data.version.versionNumber);
		expect(app.publishedAt).toBeDefined();
		expect(app.embedUrl).toBe(`https://embed.test/embed/${app.publicAppId}`);
		expect(app.currentVersionId).toBe(`pav_${published.data.version.publishedAppVersionId}`);
	});
});
