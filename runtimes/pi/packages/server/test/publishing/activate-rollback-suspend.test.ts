/**
 * TASK-012: activate / rollback / suspend (spec 27.3, PD-04, 13.4).
 *
 * Activation requires the target version to belong to the app and be `ready`
 * (rejected or other-app versions fail with VERSION_UNAVAILABLE); rollback
 * only flips the pointer and never copies/modifies historical RuntimeSpec;
 * suspend flips the app status to `suspended` per PD-04 without touching the
 * pointer; every operation appends an audit event; concurrent transitions
 * serialize on the app row so no update is lost. Requires the local test DB.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { ControlService, type CurrentAgentDefinitionSource } from "../../src/publishing/control/service.ts";
import { newTenantId } from "../../src/publishing/domain/ids.ts";
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

function source(config: AgentDraftConfig, name = "lifecycle-agent"): CurrentAgentDefinitionSource {
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
		...overrides,
	};
}

describe.skipIf(!pgUp)("activate / rollback / suspend", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let service: ControlService;

	const tenantA = newTenantId();
	const tenantB = newTenantId();

	/** Full setup: tenant + agent + app + N ready versions (+ one rejected). */
	async function setupApp(name: string) {
		const bootstrap = await service.bootstrapTenant({ tenantId: tenantA, tenantName: "tenant-a" });
		if (!bootstrap.ok) throw new Error("bootstrap failed");
		const imported = await service.importAgent({ tenantId: tenantA }, source(baseConfig({ prompt: name })));
		if (!imported.ok) throw new Error("import failed");
		const app = await service.createPublishedApp({
			tenantId: tenantA,
			agentDefinitionId: imported.data.agentDefinitionId,
			name,
			accessMode: "anonymous",
		});
		if (!app.ok) throw new Error("app create failed");
		const v1 = await service.createPublishedAppVersion({
			tenantId: tenantA,
			publishedAppId: app.data.app.publishedAppId,
			sourceAgentRevision: imported.data.revision,
		});
		if (!v1.ok) throw new Error("version 1 failed");
		return { app: app.data.app, v1: v1.data.version };
	}

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);
		service = new ControlService({ repositories: repos, catalog: CATALOG, embedBaseUrl: "https://embed.test" });
		await service.bootstrapTenant({ tenantId: tenantB, tenantName: "tenant-b" });
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	test("activate flips the pointer, moves the app to active and audits", async () => {
		const { app, v1 } = await setupApp("activate-app");
		expect(app.status).toBe("draft");
		const activated = await service.activateApp({
			tenantId: tenantA,
			publishedAppId: app.publishedAppId,
			versionId: v1.publishedAppVersionId,
		});
		expect(activated.ok).toBe(true);
		if (!activated.ok) return;
		expect(activated.data.app.status).toBe("active");
		expect(activated.data.app.currentVersionId).toBe(v1.publishedAppVersionId);
		expect(activated.data.previousVersionId).toBeNull();
		// Audit trail contains the activation.
		const audit = await repos.audit.listByTenant({ tenantId: tenantA }, 100);
		expect(audit.some((a) => a.action === "app.activate" && a.resourceId === app.publishedAppId)).toBe(true);
	});

	test("activating a rejected version fails with VERSION_UNAVAILABLE", async () => {
		const imported = await service.importAgent(
			{ tenantId: tenantA },
			source(baseConfig({ prompt: "reject", tools: [{ id: "shell.exec" }] })),
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
		expect(version.ok).toBe(true);
		if (!version.ok) return;
		expect(version.data.version.status).toBe("rejected");

		const result = await service.activateApp({
			tenantId: tenantA,
			publishedAppId: app.data.app.publishedAppId,
			versionId: version.data.version.publishedAppVersionId,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("VERSION_UNAVAILABLE");
		expect(result.error.httpStatus).toBe(409);
		// The app stays draft, pointer untouched.
		const unchanged = await repos.publishedApps.get(
			{ tenantId: tenantA, publishedAppId: app.data.app.publishedAppId },
			app.data.app.publishedAppId,
		);
		expect(unchanged?.status).toBe("draft");
		expect(unchanged?.currentVersionId).toBeNull();
	});

	test("activating another app's version fails (no cross-app pointer)", async () => {
		const appA = await setupApp("cross-a");
		const appB = await setupApp("cross-b");
		const result = await service.activateApp({
			tenantId: tenantA,
			publishedAppId: appA.app.publishedAppId,
			versionId: appB.v1.publishedAppVersionId,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("VERSION_UNAVAILABLE");
	});

	test("rollback flips only the pointer and never copies/modifies history", async () => {
		// Create two versions with distinct prompts; activate the newer one.
		const importedV1 = await service.importAgent({ tenantId: tenantA }, source(baseConfig({ prompt: "v1 prompt" })));
		expect(importedV1.ok).toBe(true);
		if (!importedV1.ok) return;
		const app = await service.createPublishedApp({
			tenantId: tenantA,
			agentDefinitionId: importedV1.data.agentDefinitionId,
			name: "rollback-app",
			accessMode: "anonymous",
		});
		expect(app.ok).toBe(true);
		if (!app.ok) return;
		const v1 = await service.createPublishedAppVersion({
			tenantId: tenantA,
			publishedAppId: app.data.app.publishedAppId,
			sourceAgentRevision: importedV1.data.revision,
		});
		expect(v1.ok).toBe(true);
		if (!v1.ok) return;

		const importedV2 = await service.importAgent({ tenantId: tenantA }, source(baseConfig({ prompt: "v2 prompt" })));
		expect(importedV2.ok).toBe(true);
		if (!importedV2.ok) return;
		const v2 = await service.createPublishedAppVersion({
			tenantId: tenantA,
			publishedAppId: app.data.app.publishedAppId,
			sourceAgentRevision: importedV2.data.revision,
		});
		expect(v2.ok).toBe(true);
		if (!v2.ok) return;
		expect(v2.data.version.versionNumber).toBe(2);

		await service.activateApp({
			tenantId: tenantA,
			publishedAppId: app.data.app.publishedAppId,
			versionId: v2.data.version.publishedAppVersionId,
		});

		const rolled = await service.rollbackApp({
			tenantId: tenantA,
			publishedAppId: app.data.app.publishedAppId,
			versionId: v1.data.version.publishedAppVersionId,
		});
		expect(rolled.ok).toBe(true);
		if (!rolled.ok) return;
		expect(rolled.data.app.currentVersionId).toBe(v1.data.version.publishedAppVersionId);
		expect(rolled.data.app.status).toBe("active"); // stays active
		expect(rolled.data.previousVersionId).toBe(v2.data.version.publishedAppVersionId);

		// Historical spec rows are untouched: v1 and v2 specs still carry their
		// original prompts (rollback never copies/modifies RuntimeSpec).
		const v1Row = await repos.publishedAppVersions.get(
			{ tenantId: tenantA, publishedAppId: app.data.app.publishedAppId },
			v1.data.version.publishedAppVersionId,
		);
		const v2Row = await repos.publishedAppVersions.get(
			{ tenantId: tenantA, publishedAppId: app.data.app.publishedAppId },
			v2.data.version.publishedAppVersionId,
		);
		const specOf = (row: { runtimeSpec: unknown }) =>
			(row.runtimeSpec as { agent?: { systemPrompt?: string } }).agent?.systemPrompt;
		expect(specOf(v1Row!)).toBe("v1 prompt");
		expect(specOf(v2Row!)).toBe("v2 prompt");
		expect(v1Row?.status).toBe("ready");
		expect(v2Row?.status).toBe("ready");
		expect(v1Row?.runtimeSpecHash).not.toBe(v2Row?.runtimeSpecHash);
	});

	test("suspend flips status to suspended without touching the pointer, audited", async () => {
		const { app, v1 } = await setupApp("suspend-app");
		await service.activateApp({
			tenantId: tenantA,
			publishedAppId: app.publishedAppId,
			versionId: v1.publishedAppVersionId,
		});
		const suspended = await service.suspendApp({
			tenantId: tenantA,
			publishedAppId: app.publishedAppId,
			reason: "operator_request",
		});
		expect(suspended.ok).toBe(true);
		if (!suspended.ok) return;
		expect(suspended.data.app.status).toBe("suspended");
		expect(suspended.data.app.currentVersionId).toBe(v1.publishedAppVersionId);
		const audit = await repos.audit.listByTenant({ tenantId: tenantA }, 100);
		const event = audit.find((a) => a.action === "app.suspend" && a.resourceId === app.publishedAppId);
		expect(event).toBeDefined();
		expect((event?.metadata as { reason?: string }).reason).toBe("operator_request");
	});

	test("concurrent activations serialize: the last transition wins with no lost update", async () => {
		const imported = await service.importAgent({ tenantId: tenantA }, source(baseConfig({ prompt: "race" })));
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
		const v1 = await service.createPublishedAppVersion({
			tenantId: tenantA,
			publishedAppId: app.data.app.publishedAppId,
			sourceAgentRevision: imported.data.revision,
		});
		expect(v1.ok).toBe(true);
		if (!v1.ok) return;

		// Two concurrent activations of the same version: both succeed, the
		// pointer is set once, and the audit trail records both transitions.
		const [a, b] = await Promise.all([
			service.activateApp({
				tenantId: tenantA,
				publishedAppId: app.data.app.publishedAppId,
				versionId: v1.data.version.publishedAppVersionId,
			}),
			service.activateApp({
				tenantId: tenantA,
				publishedAppId: app.data.app.publishedAppId,
				versionId: v1.data.version.publishedAppVersionId,
			}),
		]);
		expect(a.ok && b.ok).toBe(true);
		const current = await repos.publishedApps.get(
			{ tenantId: tenantA, publishedAppId: app.data.app.publishedAppId },
			app.data.app.publishedAppId,
		);
		expect(current?.currentVersionId).toBe(v1.data.version.publishedAppVersionId);
		const audit = await repos.audit.listByTenant({ tenantId: tenantA }, 100);
		expect(
			audit.filter((e) => e.action === "app.activate" && e.resourceId === app.data.app.publishedAppId).length,
		).toBe(2);
	});

	test("activate on a non-existent app is APP_NOT_FOUND", async () => {
		const result = await service.activateApp({
			tenantId: tenantB,
			publishedAppId: "00000000-0000-7000-8000-000000000001" as never,
			versionId: "00000000-0000-7000-8000-000000000002" as never,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("APP_NOT_FOUND");
	});
});
