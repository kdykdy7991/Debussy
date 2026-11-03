import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type {
	ConfigurationPermission,
	ExternalConfigurationField,
	ExternalConfigurationView,
} from "@earendil-works/pi-protocol";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ConversationService } from "../../src/embed/conversations/service.ts";
import { ExternalConfigurationService } from "../../src/orchestration/configuration-service.ts";
import { settingsSchema } from "../../src/orchestration/contracts.ts";
import { credentialHash, WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { createOrchestrationHttp } from "../../src/orchestration/http.ts";
import { OrchestrationService } from "../../src/orchestration/service.ts";
import { OrchestrationStore } from "../../src/orchestration/store.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { ControlService } from "../../src/publishing/control/service.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";

const url = process.env.PI_ORCHESTRATION_TEST_DATABASE_URL,
	schema = `configuration_test_${process.pid}_${Date.now()}`;
const tenantId = randomUUID(),
	appId = randomUUID(),
	versionId = randomUUID(),
	agentId = randomUUID();
const allFields: ExternalConfigurationField[] = ["systemPrompt", "modelId", "parameters", "mcpServerIds"];
describe.skipIf(!url)("external configuration lifecycle with isolated Postgres", () => {
	let client: PostgresClient,
		store: OrchestrationStore,
		service: OrchestrationService,
		configuration: ExternalConfigurationService,
		control: ControlService;
	let integrationId: string, runToken: string, base: string, server: ReturnType<typeof createServer>;
	beforeAll(async () => {
		client = new PostgresClient({ url: url!, searchPath: schema });
		await client.run(`create schema ${schema}`);
		await runMigrations(client);
		await client.run("insert into tenants(id,name,status) values ($1,'config-test','active')", tenantId);
		await client.run(
			"insert into agent_definitions(id,tenant_id,name,revision,draft_config,created_by) values ($1,$2,'test',1,$3::jsonb,$2)",
			agentId,
			tenantId,
			{ prompt: "Analyze", model: { provider: "fake", modelId: "test" }, tools: [] },
		);
		await client.run(
			"insert into published_apps(id,tenant_id,agent_definition_id,public_app_id,name,status,access_mode,created_by) values ($1,$2,$3,$4,'test','active','anonymous',$2)",
			appId,
			tenantId,
			agentId,
			`pub_${appId}`,
		);
		const parsed = parseRuntimeSpec({
			schemaVersion: 1,
			publishedAppVersionId: `pav_${versionId}`,
			agent: { systemPrompt: "Analyze", model: { provider: "fake", modelId: "test" } },
			capabilities: {},
		});
		if (!parsed.ok) throw new Error("invalid fixture");
		await client.run(
			"insert into published_app_versions(id,tenant_id,published_app_id,version_number,source_agent_revision,snapshot,runtime_spec,runtime_spec_hash,status,created_by) values ($1,$2,$3,1,1,'{}',$4::jsonb,$5,'ready',$2)",
			versionId,
			tenantId,
			appId,
			parsed.spec,
			sha256Hex(canonicalJson(parsed.spec)),
		);
		await client.run("update published_apps set current_version_id=$1 where id=$2", versionId, appId);
		store = new OrchestrationStore(client, tenantId, new WorkCredentialBox(Buffer.alloc(32, 9)));
		const created = await store.createIntegration(
			appId,
			versionId,
			"配置测试",
			settingsSchema.parse({ allowedModels: ["test"], bindings: [] }),
		);
		integrationId = created.id;
		runToken = created.token;
		const repositories = createPublishingRepositories(client);
		control = new ControlService({
			repositories,
			catalog: { tools: [], knowledgeBases: [], models: [{ provider: "fake", modelId: "test" }] },
			embedBaseUrl: "https://embed.test",
		});
		service = new OrchestrationService(
			store,
			control,
			repositories,
			new ConversationService({ repositories, turnExecutor: async () => ({ ok: true, outputText: "{}" }) }),
		);
		configuration = new ExternalConfigurationService(service);
		const handler = createOrchestrationHttp(
			service,
			(request) => request.headers.authorization === "Bearer admin-test",
		);
		server = createServer((request, response) => {
			void Promise.resolve(handler(request, response)).then((handled) => {
				if (!handled) response.writeHead(404).end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("listen failed");
		base = `http://127.0.0.1:${address.port}`;
	}, 30000);
	afterAll(async () => {
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (client) {
			await client.run(`drop schema ${schema} cascade`);
			await client.close();
		}
	});
	const policy = (permissions: ConfigurationPermission[], fields: ExternalConfigurationField[] = allFields) => ({
		name: "test project",
		permissions,
		editable_fields: fields,
		allowed_origins: ["https://tickets.test"],
	});
	const session = async (
		permissions: ConfigurationPermission[] = ["config.view", "config.edit", "config.publish"],
		fields: ExternalConfigurationField[] = allFields,
	) => {
		const grant = await configuration.createGrant(integrationId, policy(permissions, fields));
		const exchanged = await configuration.exchange(`Bearer ${grant.credential}`, {
			integration_id: integrationId,
			origin: "https://tickets.test",
		});
		const consumed = await configuration.consume({ code: exchanged.code });
		return { ...grant, auth: `Bearer ${consumed.access_token}`, token: consumed.access_token };
	};
	const endpoint = (suffix: string) => `/api/aaas/v1/integrations/${integrationId}/${suffix}`;
	const http = async <T = ExternalConfigurationView>(path: string, auth: string, method = "GET", body?: unknown) => {
		const response = await fetch(base + path, {
			method,
			headers: { Authorization: auth, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		return { status: response.status, body: (await response.json()) as { data: T; error?: { code: string } } };
	};
	const save = async (auth: string, prompt: string) => {
		const view = await configuration.view(auth, integrationId);
		return configuration.saveDraft(auth, integrationId, {
			expected_draft_revision: view.draft.revision,
			changes: { systemPrompt: prompt },
		});
	};

	test("use/chat/admin credentials do not gain configuration rights; configuration sessions cannot invoke Runs or legacy saves", async () => {
		for (const auth of [`Bearer ${runToken}`, "Bearer ta_test.secret", "Bearer admin-test"]) {
			expect((await http(endpoint("configuration"), auth)).status).toBe(401);
		}
		for (const method of ["GET", "PUT"]) {
			expect(
				(
					await http(
						"/api/orchestration/v1/configuration",
						`Bearer ${runToken}`,
						method,
						method === "PUT" ? {} : undefined,
					)
				).status,
			).toBe(403);
		}
		const g = await session(["config.view"], []);
		expect((await http(endpoint("configuration"), `Bearer ${g.credential}`)).status).toBe(401);
		expect(
			(await http(`/api/aaas/v1/integrations/${integrationId}/runs`, g.auth, "POST", { prompt: "test" })).status,
		).toBe(401);
		expect(
			(await http(`/api/admin/v1/orchestration/integrations/${integrationId}/configuration`, g.auth, "PUT", {}))
				.status,
		).toBe(401);
		expect(
			(
				await http(endpoint("draft"), g.auth, "PUT", {
					expected_draft_revision: 0,
					changes: { systemPrompt: "not allowed" },
				})
			).status,
		).toBe(403);
		expect(
			(
				await http(endpoint("publish"), g.auth, "POST", {
					expected_draft_revision: 1,
					expected_active_version: `pav_${versionId}`,
				})
			).status,
		).toBe(403);
		expect((await http(endpoint("configuration"), g.auth)).body.data.permissions).toEqual({
			view: true,
			edit: false,
			publish: false,
		});
		expect((await http(`/api/aaas/v1/integrations/${randomUUID()}/configuration`, g.auth)).status).toBe(404);
	});

	test("grant administration is scoped and never returns its credential after creation", async () => {
		const path = `/api/admin/v1/orchestration/integrations/${integrationId}/configuration-grants`;
		expect((await http(path, `Bearer ${runToken}`)).status).toBe(401);
		const created = await http<{ id: string; credential: string }>(
			path,
			"Bearer admin-test",
			"POST",
			policy(["config.view"]),
		);
		expect(created.status).toBe(201);
		expect(JSON.stringify((await http(path, "Bearer admin-test")).body)).not.toContain(created.body.data.credential);
		expect(JSON.stringify(await configuration.grants(integrationId))).not.toMatch(/secret_hash|capabilityVersionId/);
		await expect(
			configuration.exchange(`Bearer ${created.body.data.credential}`, {
				integration_id: integrationId,
				origin: "https://tickets.test.evil",
			}),
		).rejects.toMatchObject({ status: 403 });
	});

	test("draft saves enforce revision CAS and field allowlists without creating immutable revisions or switching active version", async () => {
		const g = await session(["config.view", "config.edit"], ["systemPrompt"]),
			before = await configuration.view(g.auth, integrationId);
		const revisions = await client.run(
			"select count(*)::int as n from agent_definitions where tenant_id=$1",
			tenantId,
		);
		const results = await Promise.allSettled([
			configuration.saveDraft(g.auth, integrationId, {
				expected_draft_revision: before.draft.revision,
				changes: { systemPrompt: "Editor A" },
			}),
			configuration.saveDraft(g.auth, integrationId, {
				expected_draft_revision: before.draft.revision,
				changes: { systemPrompt: "Editor B" },
			}),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
		const after = await configuration.view(g.auth, integrationId);
		expect(after.draft.revision).toBe(before.draft.revision + 1);
		expect(after.published_version).toBe(before.published_version);
		expect(after.published).toEqual(before.published);
		expect(await client.run("select count(*)::int as n from agent_definitions where tenant_id=$1", tenantId)).toEqual(
			revisions,
		);
		expect(
			(
				await http(endpoint("draft"), g.auth, "PUT", {
					expected_draft_revision: after.draft.revision,
					changes: { modelId: "test" },
				})
			).status,
		).toBe(403);
		expect(
			(
				await http(endpoint("draft"), g.auth, "PUT", {
					expected_draft_revision: after.draft.revision,
					changes: { timeout: 1 },
				})
			).status,
		).toBe(400);
		await expect(
			configuration.publish(g.auth, integrationId, {
				expected_draft_revision: after.draft.revision,
				expected_active_version: after.published_version,
			}),
		).rejects.toMatchObject({ status: 403 });
	});

	test("legacy publish permissions cannot write Chat revisions; explicit migration is required", async () => {
		const editor = await session(["config.view", "config.edit"], ["systemPrompt"]);
		const publisher = await session(["config.view", "config.publish"], ["systemPrompt"]);
		const draft = await save(editor.auth, "Pending independent migration");
		const before = await client.run("select count(*)::int as n from published_app_versions");
		await expect(
			configuration.publish(publisher.auth, integrationId, {
				expected_draft_revision: draft.draft.revision,
				expected_active_version: draft.published_version,
			}),
		).rejects.toMatchObject({ code: "MIGRATION_REQUIRED" });
		expect(await client.run("select count(*)::int as n from published_app_versions")).toEqual(before);
		expect((await configuration.view(editor.auth, integrationId)).published_version).toBe(draft.published_version);
	});

	test("draft and active-version conflicts reject stale publishes; failed compilation keeps pointer and draft revision", async () => {
		const g = await session(),
			draft = await save(g.auth, "Compile rollback draft"),
			input = { expected_draft_revision: draft.draft.revision, expected_active_version: draft.published_version };
		await expect(
			configuration.publish(g.auth, integrationId, {
				...input,
				expected_draft_revision: input.expected_draft_revision - 1,
			}),
		).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });
		await expect(
			configuration.publish(g.auth, integrationId, { ...input, expected_active_version: `pav_${randomUUID()}` }),
		).rejects.toMatchObject({ code: "ACTIVE_VERSION_CONFLICT" });
		const compile = vi
			.spyOn(service, "prepareConfigurationVersion")
			.mockRejectedValueOnce(new Error("test compiler failure"));
		try {
			await expect(configuration.publish(g.auth, integrationId, input)).rejects.toThrow("test compiler failure");
		} finally {
			compile.mockRestore();
		}
		const after = await configuration.view(g.auth, integrationId);
		expect(after.published_version).toBe(draft.published_version);
		expect(after.draft).toEqual(draft.draft);
	});

	test("legacy internal save cannot bypass the independent configuration migration boundary", async () => {
		const g = await session(),
			draft = await save(g.auth, "Old base draft"),
			i = await store.getIntegration(integrationId);
		await expect(
			service.saveConfiguration(i, {
				expectedRevision: i.revision,
				systemPrompt: "must not write Chat",
				modelId: "test",
				parameters: {},
			}),
		).rejects.toMatchObject({ code: "MIGRATION_REQUIRED" });
		expect((await store.getIntegration(integrationId)).versionId).toBe(i.versionId);
		const reset = await configuration.saveDraft(g.auth, integrationId, {
			expected_draft_revision: draft.draft.revision,
			expected_active_version: draft.published_version,
			reset: true,
		});
		expect(reset.draft.configuration).toEqual(reset.published);
	});

	test("one-time codes, session expiry and revocation apply to reads and edits", async () => {
		const g = await session(),
			exchanged = await configuration.exchange(`Bearer ${g.credential}`, {
				integration_id: integrationId,
				origin: "https://tickets.test",
			});
		const consumed = await Promise.allSettled([
			configuration.consume({ code: exchanged.code }),
			configuration.consume({ code: exchanged.code }),
		]);
		expect(consumed.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		await client.run(
			"update orchestration_configuration_sessions set expires_at=now()-interval '1 second' where secret_hash=$1",
			credentialHash(g.token),
		);
		await expect(configuration.view(g.auth, integrationId)).rejects.toMatchObject({ status: 401 });
		const pending = await configuration.exchange(`Bearer ${g.credential}`, {
			integration_id: integrationId,
			origin: "https://tickets.test",
		});
		await configuration.updateGrant(integrationId, g.id, { expected_revision: 1, enabled: false });
		await expect(configuration.consume({ code: pending.code })).rejects.toMatchObject({ status: 401 });
		await expect(
			configuration.exchange(`Bearer ${g.credential}`, {
				integration_id: integrationId,
				origin: "https://tickets.test",
			}),
		).rejects.toMatchObject({ status: 401 });
		const stillActive = await session();
		await configuration.updateGrant(integrationId, stillActive.id, {
			expected_revision: 1,
			policy: policy(["config.view"], []),
		});
		await expect(configuration.view(stillActive.auth, integrationId)).rejects.toMatchObject({ status: 401 });
	});

	test("MCP selection is restricted to grant-frozen references; no endpoints, schemas or credentials are exposed", async () => {
		const g = await session(),
			original = await service.configurationSource(await store.getIntegration(integrationId));
		const allowed = `mcp_${randomUUID()}`,
			ref = { mcpServerId: allowed, revision: 2, toolNames: ["read_only"] };
		const source = vi.spyOn(service, "configurationSource").mockResolvedValue({
			...original,
			refs: [ref],
			servers: [{ id: allowed, name: "Approved MCP", toolNames: ref.toolNames }],
		});
		try {
			const view = await configuration.view(g.auth, integrationId);
			await expect(
				configuration.saveDraft(g.auth, integrationId, {
					expected_draft_revision: view.draft.revision,
					changes: { mcpServerIds: [`mcp_${randomUUID()}`] },
				}),
			).rejects.toMatchObject({ code: "MCP_NOT_ALLOWED" });
			const saved = await configuration.saveDraft(g.auth, integrationId, {
				expected_draft_revision: view.draft.revision,
				changes: { mcpServerIds: [allowed] },
			});
			expect(saved.draft.configuration.mcpServerIds).toEqual([allowed]);
			expect(JSON.stringify(saved)).not.toMatch(/endpoint|inputSchema|secret_hash|credential/);
		} finally {
			source.mockRestore();
		}
		const current = await configuration.view(g.auth, integrationId);
		await configuration.saveDraft(g.auth, integrationId, {
			expected_draft_revision: current.draft.revision,
			expected_active_version: current.published_version,
			reset: true,
		});
	});

	test("external page is standalone with nonce CSP and no administrator runtime", async () => {
		const response = await fetch(`${base}/aaas/integrations/${integrationId}/configuration`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toContain("https://tickets.test");
		expect(response.headers.get("content-security-policy")).toContain("script-src 'nonce-");
		const html = await response.text();
		expect(html).toContain("保存草稿");
		expect(html).not.toMatch(/localStorage|sessionStorage|admin-test|AdminAppShell/);
	});

	test("unchanged MCP IDs cannot hide a reference change from publisher or reset field permissions", async () => {
		const full = await session(),
			limited = await session(["config.view", "config.edit", "config.publish"], ["systemPrompt"]);
		const active = await store.getIntegration(integrationId),
			original = await service.configurationSource(active);
		const capabilityVersionId = randomUUID();
		await client.run(
			"insert into published_app_versions(id,tenant_id,published_app_id,version_number,source_agent_revision,snapshot,runtime_spec,runtime_spec_hash,status,created_by) select $1,tenant_id,published_app_id,2,source_agent_revision,snapshot,runtime_spec,runtime_spec_hash,status,created_by from published_app_versions where id=$2",
			capabilityVersionId,
			versionId,
		);
		await client.run(
			"update orchestration_configuration_grants set capability_version_id=$1 where id=$2",
			capabilityVersionId,
			full.id,
		);
		const id = `mcp_${randomUUID()}`,
			oldRef = { mcpServerId: id, revision: 1, toolNames: ["query"] },
			newRef = { ...oldRef, revision: 2 };
		const mock = vi.spyOn(service, "configurationSource").mockImplementation(async (i) => ({
			...original,
			configuration: { ...original.configuration, mcpServerIds: [id] },
			refs: [i.versionId === capabilityVersionId ? oldRef : newRef],
			servers: [{ id, name: "MCP", toolNames: ["query"] }],
		}));
		try {
			let view = await configuration.view(full.auth, integrationId);
			view = await configuration.saveDraft(full.auth, integrationId, {
				expected_draft_revision: view.draft.revision,
				expected_active_version: view.published_version,
				reset: true,
			});
			view = await configuration.saveDraft(full.auth, integrationId, {
				expected_draft_revision: view.draft.revision,
				changes: { mcpServerIds: [id] },
			});
			await expect(
				configuration.publish(limited.auth, integrationId, {
					expected_draft_revision: view.draft.revision,
					expected_active_version: view.published_version,
				}),
			).rejects.toMatchObject({ code: "FIELD_NOT_EDITABLE" });
			await expect(
				configuration.saveDraft(limited.auth, integrationId, {
					expected_draft_revision: view.draft.revision,
					expected_active_version: view.published_version,
					reset: true,
				}),
			).rejects.toMatchObject({ code: "FIELD_NOT_EDITABLE" });
		} finally {
			mock.mockRestore();
		}
		const view = await configuration.view(full.auth, integrationId);
		await configuration.saveDraft(full.auth, integrationId, {
			expected_draft_revision: view.draft.revision,
			expected_active_version: view.published_version,
			reset: true,
		});
	});

	test("expired codes and rotated project credentials cannot create new sessions", async () => {
		const g = await session(),
			exchanged = await configuration.exchange(`Bearer ${g.credential}`, {
				integration_id: integrationId,
				origin: "https://tickets.test",
			});
		await client.run(
			"update orchestration_configuration_sessions set expires_at=now()-interval '1 second' where secret_hash=$1",
			credentialHash(exchanged.code),
		);
		await expect(configuration.consume({ code: exchanged.code })).rejects.toMatchObject({ status: 401 });
		const rotated = await configuration.updateGrant(integrationId, g.id, { expected_revision: 1, rotate: true });
		await expect(configuration.view(g.auth, integrationId)).rejects.toMatchObject({ status: 401 });
		await expect(
			configuration.exchange(`Bearer ${g.credential}`, {
				integration_id: integrationId,
				origin: "https://tickets.test",
			}),
		).rejects.toMatchObject({ status: 401 });
		const fresh = await configuration.exchange(`Bearer ${rotated.credential}`, {
			integration_id: integrationId,
			origin: "https://tickets.test",
		});
		expect(fresh.code).toMatch(/^cfgc_/);
		const rows = await client.run("select secret_hash from orchestration_configuration_grants where id=$1", g.id);
		expect(JSON.stringify(rows)).not.toContain(rotated.credential);
	});

	test("valid configuration credentials and sessions cannot cross to another existing integration", async () => {
		const g = await session(),
			otherApp = randomUUID(),
			otherVersion = randomUUID();
		await client.run(
			"insert into published_apps(id,tenant_id,agent_definition_id,public_app_id,name,status,access_mode,created_by) values ($1,$2,$3,$4,'other','active','anonymous',$2)",
			otherApp,
			tenantId,
			agentId,
			`pub_${otherApp}`,
		);
		await client.run(
			"insert into published_app_versions(id,tenant_id,published_app_id,version_number,source_agent_revision,snapshot,runtime_spec,runtime_spec_hash,status,created_by) select $1,tenant_id,$2,1,source_agent_revision,snapshot,runtime_spec,runtime_spec_hash,status,created_by from published_app_versions where id=$3",
			otherVersion,
			otherApp,
			versionId,
		);
		const other = await store.createIntegration(
			otherApp,
			otherVersion,
			"other",
			settingsSchema.parse({ allowedModels: ["test"], bindings: [] }),
		);
		await expect(configuration.view(g.auth, other.id)).rejects.toMatchObject({ status: 401 });
		await expect(
			configuration.saveDraft(g.auth, other.id, { expected_draft_revision: 0, changes: { systemPrompt: "cross" } }),
		).rejects.toMatchObject({ status: 401 });
		await expect(
			configuration.exchange(`Bearer ${g.credential}`, { integration_id: other.id, origin: "https://tickets.test" }),
		).rejects.toMatchObject({ status: 401 });
	});
	test("explicit migration revokes historical external configuration grants without changing Chat", async () => {
		const g = await session(),
			i = await store.getIntegration(integrationId);
		const before = await client.run("select count(*)::int as n from agent_definitions");
		await service.migrateConfiguration(i.id, i.revision, `pav_${i.versionId}`);
		await expect(configuration.view(g.auth, i.id)).rejects.toMatchObject({ status: 401 });
		expect(await client.run("select count(*)::int as n from agent_definitions")).toEqual(before);
	});
});
