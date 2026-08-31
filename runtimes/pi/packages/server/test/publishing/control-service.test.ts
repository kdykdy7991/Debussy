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
import {
	fromPublicId,
	newAgentDefinitionId,
	newMcpToolId,
	newTenantId,
	toPublicId,
} from "../../src/publishing/domain/ids.ts";
import { McpSecretBox } from "../../src/publishing/mcp/secret-box.ts";
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
	models: [
		{ provider: "skdy", modelId: "pi-chat" },
		{
			provider: "skdy",
			modelId: "Qwen3.8-Agent",
			parameterCapabilities: {
				reasoning: { supported: true, toggle: true, efforts: ["low", "medium", "high"] },
			},
		},
	],
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

const NO_AGENT_CAPABILITIES = {
	liveSpeech: false,
	avatar: false,
	attachments: false,
	citations: false,
	realtime: false,
	webSearch: false,
} as const;

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

	test("importAgent serializes concurrent imports of the same name and source", async () => {
		const results = await Promise.all(
			Array.from({ length: 4 }, () =>
				service.importAgent({ tenantId: tenantA }, source(baseConfig(), "concurrent-import")),
			),
		);
		expect(results.every((result) => result.ok)).toBe(true);
		const successful = results.filter((result) => result.ok).map((result) => result.data);
		expect(new Set(successful.map((result) => result.agentDefinitionId)).size).toBe(1);
		expect(successful.map((result) => result.revision)).toEqual([1, 1, 1, 1]);
	});

	test("createAgentDefinition creates immutable revision 1 and rejects duplicate active names", async () => {
		const request = {
			name: "created-agent",
			description: "created through the control API",
			modelId: "pi-chat",
			systemPrompt: "Created prompt",
			parameters: {},
			toolIds: [],
			knowledgeBaseIds: [],
			capabilities: NO_AGENT_CAPABILITIES,
		};
		const created = await service.createAgentDefinition({ tenantId: tenantA, request });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.data.revision).toBe(1);
		const stored = await repos.agentDefinitions.getLatestByName({ tenantId: tenantA }, request.name);
		expect(stored?.revision).toBe(1);
		expect((stored?.draftConfig as AgentDraftConfig).prompt).toBe(request.systemPrompt);

		const duplicate = await service.createAgentDefinition({ tenantId: tenantA, request });
		expect(duplicate.ok).toBe(false);
		if (duplicate.ok) return;
		expect(duplicate.error.code).toBe("AGENT_NAME_CONFLICT");
		expect(duplicate.error.httpStatus).toBe(409);
	});

	test("MCP revisions, encrypted secret, Agent binding, and publish snapshot stay tenant-scoped and immutable", async () => {
		const secretBox = new McpSecretBox(Uint8Array.from({ length: 32 }, (_, index) => index));
		const mcpService = new ControlService({
			repositories: repos,
			catalog: CATALOG,
			embedBaseUrl: "https://embed.test",
			mcpSecretBox: secretBox,
		});
		const createdServer = await mcpService.createMcpServer({
			tenantId: tenantA,
			name: "crm-mcp",
			config: {
				transport: "streamable_http",
				endpoint: "https://mcp.example.com/v1",
				authentication: "bearer",
			},
		});
		expect(createdServer.ok).toBe(true);
		if (!createdServer.ok) return;
		const mcpServerId = fromPublicId("McpServerId", createdServer.data.id);
		if (mcpServerId === null) throw new Error("create returned an invalid MCP Server id");

		const token = "top-secret-mcp-token";
		const storedSecret = await mcpService.replaceMcpSecret({ tenantId: tenantA, mcpServerId, bearerToken: token });
		expect(storedSecret.ok).toBe(true);
		const encrypted = await repos.mcpSecrets.get({ tenantId: tenantA }, mcpServerId);
		expect(encrypted).toBeDefined();
		if (encrypted === undefined) return;
		expect(Buffer.from(encrypted.ciphertext).includes(Buffer.from(token))).toBe(false);
		expect(secretBox.open(tenantA, mcpServerId, encrypted)).toBe(token);

		const revision = await repos.mcpServers.addRevision({
			scope: { tenantId: tenantA },
			mcpServerId,
			revision: {
				mcpServerId,
				tenantId: tenantA,
				transport: "streamable_http",
				endpoint: "https://mcp.example.com/v1",
				authentication: "bearer",
				createdAt: new Date(),
			},
			tools: [
				{
					mcpToolId: newMcpToolId(),
					tenantId: tenantA,
					mcpServerId,
					name: "crm_lookup",
					description: "Lookup one CRM customer",
					inputSchema: {
						type: "object",
						properties: { customerId: { type: "string" } },
						required: ["customerId"],
					},
					inputSchemaHash: "a".repeat(64),
					createdAt: new Date(),
				},
			],
		});
		expect(revision?.revision).toBe(2);

		const crossTenant = await mcpService.getMcpServerDetail({ tenantId: tenantB, mcpServerId });
		expect(crossTenant.ok).toBe(false);
		if (!crossTenant.ok) expect(crossTenant.error.code).toBe("MCP_SERVER_NOT_FOUND");

		const agent = await mcpService.createAgentDefinition({
			tenantId: tenantA,
			request: {
				name: "crm-agent",
				modelId: "pi-chat",
				systemPrompt: "Use CRM when needed.",
				parameters: {},
				toolIds: [],
				knowledgeBaseIds: [],
				capabilities: NO_AGENT_CAPABILITIES,
				mcpServers: [
					{ mcpServerId: toPublicId("McpServerId", mcpServerId), revision: 2, toolNames: ["crm_lookup"] },
				],
			},
		});
		expect(agent.ok).toBe(true);
		if (!agent.ok) return;
		const agentDefinitionId = fromPublicId("AgentDefinitionId", agent.data.id);
		if (agentDefinitionId === null) throw new Error("create returned an invalid Agent id");
		const app = await mcpService.createPublishedApp({
			tenantId: tenantA,
			agentDefinitionId,
			name: "crm-app",
			accessMode: "anonymous",
		});
		expect(app.ok).toBe(true);
		if (!app.ok) return;
		const version = await mcpService.createPublishedAppVersion({
			tenantId: tenantA,
			publishedAppId: app.data.app.publishedAppId,
			sourceAgentRevision: 1,
		});
		expect(version.ok).toBe(true);
		if (!version.ok) return;
		const runtimeSpec = version.data.version.runtimeSpec as {
			capabilities?: { mcpServers?: readonly { revision?: number; tools?: readonly { name?: string }[] }[] };
		};
		expect(runtimeSpec.capabilities?.mcpServers).toEqual([
			expect.objectContaining({ revision: 2, tools: [expect.objectContaining({ name: "crm_lookup" })] }),
		]);
		expect(JSON.stringify(runtimeSpec)).not.toContain(token);
		const deletion = await mcpService.deleteMcpServer({ tenantId: tenantA, mcpServerId });
		expect(deletion.ok).toBe(false);
		if (!deletion.ok) expect(deletion.error.code).toBe("MCP_BINDING_VIOLATION");
		expect(await repos.mcpSecrets.has({ tenantId: tenantA }, mcpServerId)).toBe(true);
	});

	test("Agent create and save reject prompts above the RuntimeSpec limit", async () => {
		const oversizedPrompt = "x".repeat(65_537);
		const created = await service.createAgentDefinition({
			tenantId: tenantA,
			request: {
				name: "oversized-agent",
				modelId: "pi-chat",
				systemPrompt: oversizedPrompt,
				parameters: {},
				toolIds: [],
				knowledgeBaseIds: [],
				capabilities: NO_AGENT_CAPABILITIES,
			},
		});
		expect(created.ok).toBe(false);
		if (created.ok) return;
		expect(created.error.code).toBe("INVALID_SYSTEM_PROMPT");

		const existing = await service.createAgentDefinition({
			tenantId: tenantA,
			request: {
				name: "prompt-limit-agent",
				modelId: "pi-chat",
				systemPrompt: "within limit",
				parameters: {},
				toolIds: [],
				knowledgeBaseIds: [],
				capabilities: NO_AGENT_CAPABILITIES,
			},
		});
		expect(existing.ok).toBe(true);
		if (!existing.ok) return;
		const agentId = fromPublicId("AgentDefinitionId", existing.data.id);
		if (agentId === null) throw new Error("create returned an invalid Agent id");
		const saved = await service.saveAgentRevision({
			tenantId: tenantA,
			agentDefinitionId: agentId,
			request: {
				modelId: "pi-chat",
				systemPrompt: oversizedPrompt,
				parameters: {},
				toolIds: [],
				knowledgeBaseIds: [],
				capabilities: NO_AGENT_CAPABILITIES,
				changeSummary: "too large",
			},
		});
		expect(saved.ok).toBe(false);
		if (saved.ok) return;
		expect(saved.error.code).toBe("INVALID_SYSTEM_PROMPT");
	});

	test("concurrent app creation and Agent deletion preserve one consistent outcome", async () => {
		const created = await service.createAgentDefinition({
			tenantId: tenantA,
			request: {
				name: "delete-race-agent",
				modelId: "pi-chat",
				systemPrompt: "race",
				parameters: {},
				toolIds: [],
				knowledgeBaseIds: [],
				capabilities: NO_AGENT_CAPABILITIES,
			},
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const agentDefinitionId = fromPublicId("AgentDefinitionId", created.data.id);
		if (agentDefinitionId === null) throw new Error("create returned an invalid Agent id");
		const [app, deletion] = await Promise.all([
			service.createPublishedApp({
				tenantId: tenantA,
				agentDefinitionId,
				name: "race-app",
				accessMode: "anonymous",
			}),
			service.deleteAgentDefinition({
				tenantId: tenantA,
				agentDefinitionId,
				confirmName: "delete-race-agent",
			}),
		]);
		expect(Number(app.ok) + Number(deletion.ok)).toBe(1);
		if (app.ok) {
			expect(deletion.ok).toBe(false);
			if (!deletion.ok) expect(deletion.error.code).toBe("AGENT_HAS_ASSOCIATED_APPS");
		} else {
			expect(app.error.code).toBe("AGENT_NOT_FOUND");
			expect(deletion.ok).toBe(true);
		}
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

	test("importAgent rejects model-unsupported reasoning parameters (INVALID_MODEL_PARAMETERS)", async () => {
		const bad = baseConfig({
			model: { provider: "skdy", modelId: "pi-chat", params: { reasoning: { effort: "high" } } },
		});
		const result = await service.importAgent({ tenantId: tenantA }, source(bad));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("INVALID_MODEL_PARAMETERS");
		expect(result.error.httpStatus).toBe(400);
	});

	test("importAgent rejects unknown parameter fields and sampling overrides", async () => {
		const bad = baseConfig({
			model: {
				provider: "skdy",
				modelId: "pi-chat",
				params: { reasoning: { effort: "high" }, sampling: { topP: 0.9 } },
			},
		});
		const result = await service.importAgent({ tenantId: tenantA }, source(bad));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("INVALID_MODEL_PARAMETERS");
		expect(result.error.httpStatus).toBe(400);
	});

	test("importAgent accepts a valid reasoning configuration for a reasoning model", async () => {
		const good = baseConfig({
			model: {
				provider: "skdy",
				modelId: "Qwen3.8-Agent",
				params: { reasoning: { enabled: true, effort: "high" } },
			},
		});
		const result = await service.importAgent({ tenantId: tenantA }, source(good));
		expect(result.ok).toBe(true);
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

	test("saveAgentRevision rejects model-unsupported reasoning parameters (INVALID_MODEL_PARAMETERS)", async () => {
		const imported = await service.importAgent({ tenantId: tenantA }, source(baseConfig()));
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const result = await service.saveAgentRevision({
			tenantId: tenantA,
			agentDefinitionId: imported.data.agentDefinitionId,
			request: {
				modelId: "pi-chat", // 非 reasoning 模型
				systemPrompt: "You are a helpful assistant.",
				parameters: { reasoning: { effort: "high" } },
				toolIds: [],
				knowledgeBaseIds: [],
				capabilities: {
					liveSpeech: false,
					avatar: false,
					attachments: false,
					citations: false,
					realtime: false,
					webSearch: false,
				},
				changeSummary: "invalid reasoning",
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("INVALID_MODEL_PARAMETERS");
		expect(result.error.httpStatus).toBe(400);
	});

	test("saveAgentRevision rejects unknown parameter fields and sampling overrides", async () => {
		const imported = await service.importAgent({ tenantId: tenantA }, source(baseConfig()));
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const bad = {
			reasoning: { effort: "high" },
			sampling: { topP: 0.9 },
		} as unknown as import("@earendil-works/pi-protocol").AgentModelParameters;
		const result = await service.saveAgentRevision({
			tenantId: tenantA,
			agentDefinitionId: imported.data.agentDefinitionId,
			request: {
				modelId: "Qwen3.8-Agent", // 支持 reasoning，但 sampling 覆盖仍被拒
				systemPrompt: "You are a helpful assistant.",
				parameters: bad,
				toolIds: [],
				knowledgeBaseIds: [],
				capabilities: {
					liveSpeech: false,
					avatar: false,
					attachments: false,
					citations: false,
					realtime: false,
					webSearch: false,
				},
				changeSummary: "unknown fields",
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("INVALID_MODEL_PARAMETERS");
		expect(result.error.httpStatus).toBe(400);
	});

	test("saveAgentRevision persists a valid reasoning configuration for a reasoning model", async () => {
		const imported = await service.importAgent({ tenantId: tenantA }, source(baseConfig()));
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const result = await service.saveAgentRevision({
			tenantId: tenantA,
			agentDefinitionId: imported.data.agentDefinitionId,
			request: {
				modelId: "Qwen3.8-Agent",
				systemPrompt: "You are a helpful assistant.",
				parameters: { reasoning: { enabled: true, effort: "high" } },
				toolIds: [],
				knowledgeBaseIds: [],
				capabilities: {
					liveSpeech: false,
					avatar: false,
					attachments: false,
					citations: false,
					realtime: false,
					webSearch: false,
				},
				changeSummary: "valid reasoning",
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.revision).toBeGreaterThan(imported.data.revision);
	});

	test("saveAgentRevision preserves the unique catalog provider for publishing", async () => {
		const imported = await service.importAgent({ tenantId: tenantA }, source(baseConfig()));
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		const result = await service.saveAgentRevision({
			tenantId: tenantA,
			agentDefinitionId: imported.data.agentDefinitionId,
			request: {
				modelId: "pi-chat",
				systemPrompt: "Use the catalog model.",
				parameters: {},
				toolIds: [],
				knowledgeBaseIds: [],
				capabilities: {
					liveSpeech: false,
					avatar: false,
					attachments: false,
					citations: false,
					realtime: false,
					webSearch: false,
				},
				changeSummary: "preserve provider",
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const saved = await repos.agentDefinitions.getRevision(
			{ tenantId: tenantA },
			imported.data.agentDefinitionId,
			result.data.revision,
		);
		expect((saved?.draftConfig as AgentDraftConfig).model?.provider).toBe("skdy");
	});
});
