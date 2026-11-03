import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { estimateContextSnapshot } from "../../src/agent-v2/context.ts";
import { ConversationService } from "../../src/embed/conversations/service.ts";
import { createRun } from "../../src/orchestration/aaas.ts";
import { createIntegrationSchema, settingsSchema } from "../../src/orchestration/contracts.ts";
import { credentialHash, WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { orchestrationExecutionConfigResolver } from "../../src/orchestration/execution-configuration.ts";
import { createOrchestrationHttp } from "../../src/orchestration/http.ts";
import { protectTool } from "../../src/orchestration/protected-tool.ts";
import { OrchestrationService } from "../../src/orchestration/service.ts";
import { type IntegrationRecord, OrchestrationStore } from "../../src/orchestration/store.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { ControlService } from "../../src/publishing/control/service.ts";
import type { ConversationId, PrincipalId, TenantId } from "../../src/publishing/domain/ids.ts";
import { createMcpRuntimeToolFactory } from "../../src/publishing/mcp/runtime-tools.ts";
import type { OwnerScope, PublishingRepositories } from "../../src/publishing/repositories.ts";
import { createSkillMaterializer } from "../../src/publishing/runtime/skill-materializer.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import {
	type ConversationRuntimeManager,
	createConversationRuntimeManager,
} from "../../src/runtime/conversation-runtime-manager.ts";
import { createPiRuntimeAdapter, type RuntimeSessionOptions } from "../../src/runtime/pi-runtime-adapter.ts";
import type { ScopeContext } from "../../src/runtime/scope-context.ts";
import { managedTurnExecutor } from "../../src/runtime/turn-executor.ts";
import type { PiSessionRuntime, PromptInput } from "../../src/types.ts";

const url = process.env.PI_ORCHESTRATION_TEST_DATABASE_URL;
const schema = `independent_config_${process.pid}_${Date.now()}`;
const tenant = randomUUID(),
	mcp = randomUUID(),
	skill = randomUUID();
const toolSchema = {
	type: "object",
	properties: { ticket_id: { type: "string" }, authToken: { type: "string" } },
	required: ["ticket_id", "authToken"],
	additionalProperties: false,
};

describe.skipIf(!url)("independent orchestration domain on real Postgres and shared Runtime", () => {
	let client: PostgresClient,
		repos: PublishingRepositories,
		store: OrchestrationStore,
		service: OrchestrationService,
		control: ControlService,
		manager: ConversationRuntimeManager,
		integration: IntegrationRecord;
	let root: string, token: string, server: ReturnType<typeof createServer>, base: string;
	const sessions: {
		options: RuntimeSessionOptions;
		prompt: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
	}[] = [];
	const received: unknown[] = [];
	const configuration = {
		systemPrompt: "Independent rules A",
		modelId: "test",
		parameters: { reasoning: { enabled: true, effort: "high" as const } },
		mcpServers: [{ mcpServerId: `mcp_${mcp}`, revision: 1, toolNames: ["query_ticket"] }],
		skills: [{ skillId: `skill_${skill}`, revision: 1 }],
	};
	beforeAll(async () => {
		client = new PostgresClient({ url: url!, searchPath: schema });
		await client.run(`create schema ${schema}`);
		await runMigrations(client);
		await client.run("insert into tenants(id,name,status) values ($1,'independent','active')", tenant);
		await client.run(
			"insert into mcp_servers(id,tenant_id,name,status,current_revision,created_by) values ($1,$2,'proof','enabled',1,$2)",
			mcp,
			tenant,
		);
		await client.run(
			"insert into mcp_server_revisions(mcp_server_id,tenant_id,revision,transport,endpoint,authentication,created_by) values ($1,$2,1,'streamable_http','https://unused.invalid','none',$2)",
			mcp,
			tenant,
		);
		await client.run(
			"insert into mcp_tools(id,tenant_id,mcp_server_id,mcp_revision,name,input_schema,input_schema_hash) values ($1,$2,$3,1,'query_ticket',$4::jsonb,$5)",
			randomUUID(),
			tenant,
			mcp,
			toolSchema,
			sha256Hex(canonicalJson(toolSchema)),
		);
		await client.run(
			"insert into skills(id,tenant_id,name,status,current_revision,created_by) values ($1,$2,'analyze','enabled',1,$2)",
			skill,
			tenant,
		);
		const artifact = randomUUID();
		await client.run(
			"insert into skill_artifacts(id,tenant_id,filename,media_type,source_hash,size_bytes,content) values ($1,$2,'proof.txt','text/plain',$3,1,$4)",
			artifact,
			tenant,
			sha256Hex("# Analysis"),
			Buffer.from("x"),
		);
		await client.run(
			"insert into skill_revisions(skill_id,tenant_id,revision,artifact_id,source_hash,parsed_name,description,instruction_text,created_by) values ($1,$2,1,$3,$4,'analyze','analysis','# Analysis',$2)",
			skill,
			tenant,
			artifact,
			sha256Hex("# Analysis"),
		);
		repos = createPublishingRepositories(client);
		store = new OrchestrationStore(client, tenant, new WorkCredentialBox(Buffer.alloc(32, 3)));
		control = new ControlService({
			repositories: repos,
			catalog: { tools: [], models: [], knowledgeBases: [] },
			embedBaseUrl: "https://unused.invalid",
		});
		vi.spyOn(control, "listLlmModels").mockResolvedValue({
			ok: true,
			data: {
				items: [
					{
						id: "test",
						name: "Fake",
						provider: "fake",
						api: "openai-completions",
						reasoning: true,
						parameterCapabilities: {
							reasoning: { supported: true, toggle: true, efforts: ["low", "medium", "high"] },
						},
					},
				],
			},
		});
		root = await mkdtemp(join(tmpdir(), "independent-skills-"));
		const factory = createMcpRuntimeToolFactory({
			repositories: repos,
			connect: async () => ({
				listTools: async () => [],
				callTool: async (_name, args) => {
					received.push(args);
					return { content: [{ type: "text", text: "evidence" }] };
				},
				close: async () => {},
			}),
			protectTool: async (scope, serverId, tool, schema) =>
				protectTool(
					tool,
					schema,
					(await store.toolBindings(scope.conversationId)).filter(
						(b) => b.mcpServerId === serverId && b.toolName === tool.name,
					),
					async () => (await store.credentials(scope.conversationId, scope.turnId!)).values,
				),
		});
		const adapter = createPiRuntimeAdapter({
			createMcpTools: factory,
			skillMaterializer: createSkillMaterializer({ root }),
			createSession: async (options) => {
				const prompt = vi.fn(async (_input: PromptInput) => {
					const tool = options.customTools?.find((t) => t.name === "query_ticket");
					if (tool)
						await tool.execute(
							"call",
							{ ticket_id: "TK001" },
							undefined,
							undefined,
							{} as Parameters<ToolDefinition["execute"]>[4],
						);
				});
				const dispose = vi.fn(async () => {});
				sessions.push({ options, prompt, dispose });
				return {
					prompt,
					dispose,
					subscribe: () => () => {},
					snapshot: () => ({
						id: options.id,
						transcript: [
							{
								role: "assistant",
								status: "complete",
								content: [{ type: "text", text: "  custom raw result\n" }],
							},
						],
					}),
				} as unknown as PiSessionRuntime;
			},
		});
		manager = createConversationRuntimeManager({
			autoSweep: false,
			opener: async (spec, scope) => {
				const opened = await adapter.open(spec, scope);
				if (!opened.ok) throw new Error(opened.reason);
				return opened.runtime;
			},
		});
		const conversations = new ConversationService({
			repositories: repos,
			resolveExecutionConfiguration: orchestrationExecutionConfigResolver(store, repos),
			turnExecutor: managedTurnExecutor(manager),
			resetRuntime: (id) => manager.reset(id),
		});
		service = new OrchestrationService(store, control, repos, conversations);
		const created = await service.createIntegration(
			createIntegrationSchema.parse({
				name: "Independent",
				configuration,
				settings: {
					allowedModels: ["test"],
					bindings: [
						{
							mcpServerId: `mcp_${mcp}`,
							toolName: "query_ticket",
							parameter: "authToken",
							credential: "authToken",
						},
					],
				},
			}),
		);
		token = created.token;
		integration = await store.getIntegration(created.id);
		const handler = createOrchestrationHttp(service, (req) => req.headers.authorization === "Bearer admin");
		server = createServer((req, res) => {
			void Promise.resolve(handler(req, res)).then((handled) => {
				if (!handled) res.writeHead(404).end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("listen");
		base = `http://127.0.0.1:${address.port}`;
	}, 30000);
	afterAll(async () => {
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		await manager?.close();
		if (client) {
			await client.run(`drop schema ${schema} cascade`);
			await client.close();
		}
		if (root) await rm(root, { recursive: true, force: true });
	});
	const submit = (input: Record<string, unknown>, key = randomUUID(), secret = "key-a-secret") =>
		createRun(store, integration, key, { input, credentials: { authToken: secret } });
	const counts = async () =>
		Promise.all(
			["agent_definitions", "published_apps", "published_app_versions"].map(async (table) =>
				Number((await client.run(`select count(*)::int as n from ${table}`))[0]!.n),
			),
		);
	const execute = async () => {
		const assignment = await store.claim();
		if (!assignment) throw new Error("No assignment");
		const result = await service.execute(assignment);
		await store.complete(assignment.id, result, null);
		return assignment;
	};

	test("no Chat prerequisites, no Chat configuration reads/writes; input uses configured system prompt", async () => {
		expect(await counts()).toEqual([0, 0, 0]);
		const a = await submit({ ticket_id: "TK001", content: "task input" });
		const chatRead = vi.spyOn(repos.publishedAppVersions, "get").mockRejectedValue(new Error("Unexpected Chat read"));
		try {
			await execute();
		} finally {
			chatRead.mockRestore();
		}
		expect((await store.run(a.run_id, integration.id)).result).toBe("  custom raw result\n");
		expect(sessions[0]!.options.systemPrompt).toContain(configuration.systemPrompt);
		expect(sessions[0]!.options.thinkingLevel).toBe("high");
		expect(sessions[0]!.prompt.mock.calls[0]![0].text).toBe(
			canonicalJson({ ticket_id: "TK001", content: "task input" }),
		);
		expect(received[0]).toEqual({ ticket_id: "TK001", authToken: "key-a-secret" });
		const audit = await client.run(
			"select published_app_version_id,orchestration_version_id,integration_id from mcp_call_audits",
		);
		expect(audit[0]).toMatchObject({
			published_app_version_id: null,
			orchestration_version_id: integration.versionId,
			integration_id: integration.id,
		});
		expect(await counts()).toEqual([0, 0, 0]);
	});
	test("publish CAS, immutable version, frozen queued work and Skill/hash isolation", async () => {
		const old = await submit({ ticket_id: "before-publish" });
		const frozen = await store.run(old.run_id, integration.id);
		const current = await service.configuration(integration);
		const request = {
			expectedRevision: current.revision,
			expectedDraftRevision: current.draftRevision!,
			expectedActiveVersion: current.versionId!,
			systemPrompt: "Independent rules B",
			modelId: "test",
			parameters: {},
		};
		await expect(
			service.saveConfiguration(integration, { ...request, expectedActiveVersion: `orv_${randomUUID()}` }),
		).rejects.toMatchObject({ code: "ACTIVE_VERSION_CONFLICT" });
		await expect(
			service.saveConfiguration(integration, { ...request, expectedDraftRevision: current.draftRevision! + 1 }),
		).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });
		await expect(service.saveConfiguration(integration, { ...request, mcpServers: [] })).rejects.toMatchObject({
			code: "INVALID_BINDING",
		});
		const attempts = await Promise.allSettled([1, 2].map(() => service.saveConfiguration(integration, request)));
		if (attempts.every((a) => a.status === "rejected")) throw attempts[0]!.reason;
		expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
		const updated = await store.getIntegration(integration.id);
		expect(updated.versionId).not.toBe(integration.versionId);
		expect(await store.run(old.run_id, integration.id)).toEqual(frozen);
		await execute();
		expect(sessions.at(-1)!.options.systemPrompt).toContain("Independent rules A");
		integration = updated;
		const next = await submit({ ticket_id: "after-publish" }, randomUUID(), "key-b-secret");
		await execute();
		expect(sessions.at(-1)!.options.systemPrompt).toContain("Independent rules B");
		expect((await store.run(next.run_id, integration.id)).agent_version).toBe(`orv_${updated.versionId}`);
		const paths = [sessions[0]!.options.skills![0]!.filePath, sessions.at(-1)!.options.skills![0]!.filePath];
		expect(paths[0]).not.toBe(paths[1]);
		expect(await readFile(paths[0]!, "utf8")).toBe("# Analysis");
		expect(await readFile(paths[1]!, "utf8")).toBe("# Analysis");
		const hashes = await client.run("select runtime_spec_hash from orchestration_versions");
		expect(new Set(hashes.map((h) => h.runtime_spec_hash)).size).toBe(2);
		await expect(
			client.run("update orchestration_versions set snapshot='{}' where id=$1", updated.versionId),
		).rejects.toMatchObject({ code: "23514" });
		expect(await counts()).toEqual([0, 0, 0]);
	});
	test("legacy prompt override occurs before context preparation; input and prompt are exclusive", async () => {
		vi.stubEnv("PI_AGENT_V2_METRICS", "1");
		const created = await createRun(store, integration, randomUUID(), {
			prompt: "Legacy system override",
			credentials: { authToken: "legacy-secret" },
		});
		await execute();
		vi.unstubAllEnvs();
		expect(sessions.at(-1)!.options.systemPrompt).toContain("Legacy system override");
		expect(sessions.at(-1)!.options.systemPrompt).not.toContain("Independent rules B");
		expect(sessions.at(-1)!.prompt.mock.calls[0]![0].text).toBe("执行当前系统提示词指定的任务。");
		const rows = await client.run(
			"select request_contract,orchestration_version_id from orchestration_work_items where id=$1",
			created.run_id,
		);
		expect(rows[0]).toMatchObject({
			request_contract: "legacy_prompt",
			orchestration_version_id: integration.versionId,
		});
		const events = await client.run(
			"select e.event_type,e.payload from conversation_events e join orchestration_work_items w on w.conversation_id=e.conversation_id where w.id=$1 order by sequence",
			created.run_id,
		);
		const snapshot = events.find((e) => e.event_type === "context/snapshot")!.payload as { snapshot: unknown };
		expect(snapshot.snapshot).toEqual(
			estimateContextSnapshot({
				contextWindow: 100000,
				systemPromptText: "Legacy system override",
				conversationMessagesText: "执行当前系统提示词指定的任务。",
				toolDefinitionsText: "",
			}),
		);
		const base = await store.configurations.getVersion(tenant, integration.versionId, integration.configurationId!);
		expect(
			(events.find((e) => e.event_type === "turn/start")!.payload as { runtimeSpecHash: string }).runtimeSpecHash,
		).not.toBe(base!.runtimeSpecHash);
		await expect(createRun(store, integration, randomUUID(), { input: {}, prompt: "both" })).rejects.toThrow();
	});
	test("HTTP contracts retain authentication, idempotency and immutable terminal results", async () => {
		const key = randomUUID();
		const body = { input: { ticket_id: "HTTP" }, credentials: { authToken: "http-secret" } };
		const post = () =>
			fetch(`${base}/api/aaas/v1/integrations/${integration.id}/runs`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": key },
				body: JSON.stringify(body),
			});
		const [first, duplicate] = await Promise.all([post(), post()]);
		expect(first.status).toBe(202);
		expect(duplicate.status).toBe(202);
		const data = (await first.json()) as { data: { run_id: string } };
		expect(((await duplicate.json()) as { data: { run_id: string } }).data.run_id).toBe(data.data.run_id);
		await execute();
		const queried = await fetch(`${base}/api/aaas/v1/runs/${data.data.run_id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(((await queried.json()) as { data: unknown }).data).toMatchObject({
			status: "completed",
			result: "  custom raw result\n",
		});
		await expect(store.retry(data.data.run_id)).rejects.toMatchObject({ code: "RUN_IMMUTABLE" });
		await store.cancel(data.data.run_id);
		expect((await store.run(data.data.run_id, integration.id)).status).toBe("completed");
		expect((await fetch(`${base}/api/aaas/v1/runs/${data.data.run_id}`)).status).toBe(401);
	});
	test("owned context, Turn, tenant and Integration are enforced before configuration and history", async () => {
		const created = await submit({ ticket_id: "ownership" });
		const claimed = (await store.claim())!;
		const owner: OwnerScope = {
			tenantId: tenant as TenantId,
			publishedAppId: null,
			integrationId: integration.id,
			principalId: claimed.principalId as PrincipalId,
		};
		const conversation = claimed.conversationId as ConversationId;
		for (const bad of [
			{ ...owner, integrationId: randomUUID() },
			{ ...owner, tenantId: randomUUID() as TenantId },
			{ ...owner, principalId: randomUUID() as PrincipalId },
		]) {
			expect(await repos.conversations.get(bad, conversation)).toBeUndefined();
			expect(await repos.events.list(bad, conversation, { limit: 100 })).toEqual([]);
			expect(
				await repos.events.append(bad, { conversationId: conversation, eventType: "proof", payload: {} }),
			).toBeUndefined();
			await expect(
				repos.summaries.insert(bad, {
					id: randomUUID(),
					tenantId: bad.tenantId,
					publishedAppId: null,
					ownerPrincipalId: bad.principalId,
					conversationId: conversation,
					throughSequence: 1,
					modelId: "test",
					sourceEventCount: 1,
					sourceBytes: 1,
					body: { text: "forged" },
					createdAt: new Date(),
				}),
			).rejects.toMatchObject({ code: "23503" });
		}
		const resolver = orchestrationExecutionConfigResolver(store, repos);
		const record = (await repos.conversations.get(owner, conversation))!;
		expect(await resolver(owner, record, randomUUID() as Parameters<typeof resolver>[2])).toBeUndefined();
		await store.cancel(created.run_id);
	});
	test("real runtime cache reuses one version and evicts on orchestration version change", async () => {
		const versions = await client.run("select runtime_spec from orchestration_versions order by created_at limit 2");
		const [a, b] = versions.map((v) => parseRuntimeSpec(v.runtime_spec));
		if (!a?.ok || !b?.ok) throw new Error("Invalid versions");
		const scope: ScopeContext = {
			tenantId: tenant as TenantId,
			publishedAppId: null,
			integrationId: integration.id,
			principalId: randomUUID() as PrincipalId,
			conversationId: randomUUID() as ConversationId,
			publishedAppVersionId: a.spec.publishedAppVersionId,
			limits: {
				maxTurns: 100,
				maxContextTokens: 100000,
				toolResultMaxBytes: 65536,
				turnTimeoutMs: 120000,
				maxConcurrentTurnsPerConversation: 1,
			},
		};
		const index = sessions.length;
		try {
			const first = await manager.acquire(a.spec, scope);
			expect((await manager.acquire(a.spec, scope)).created).toBe(false);
			const next = await manager.acquire(b.spec, { ...scope, publishedAppVersionId: b.spec.publishedAppVersionId });
			expect(next.created).toBe(true);
			expect(next.runtime).not.toBe(first.runtime);
			expect(sessions[index]!.dispose).toHaveBeenCalledTimes(1);
		} finally {
			await manager.reset(scope.conversationId);
		}
	});
	test("corrupt frozen hash fails before history recovery and model creation", async () => {
		const id = randomUUID(),
			current = await store.configurations.getVersion(tenant, integration.versionId, integration.configurationId!);
		const parsed = parseRuntimeSpec(current!.runtimeSpec);
		if (!parsed.ok) throw new Error("fixture");
		await client.run(
			"insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash) values ($1,$2,$3,$4::jsonb,999,$5::jsonb,$6)",
			id,
			tenant,
			integration.configurationId!,
			current!.snapshot,
			{ ...parsed.spec, publishedAppVersionId: `orv_${id}` },
			"0".repeat(64),
		);
		await client.run(
			"update orchestration_integrations set orchestration_version_id=$1 where id=$2",
			id,
			integration.id,
		);
		const run = await submit({ ticket_id: "bad-hash" }),
			assignment = (await store.claim())!,
			before = sessions.length;
		const history = vi.spyOn(repos.events, "list");
		try {
			await expect(service.execute(assignment)).rejects.toMatchObject({ code: "INVALID_EXECUTION_SPEC" });
			expect(history).not.toHaveBeenCalled();
			expect(sessions.length).toBe(before);
		} finally {
			history.mockRestore();
			await store.cancel(run.run_id);
			await client.run(
				"update orchestration_integrations set orchestration_version_id=$1 where id=$2",
				integration.versionId,
				integration.id,
			);
		}
	});
	test("legacy idempotency hash remains replayable; explicit migration does not reinterpret old runs", async () => {
		const agent = randomUUID(),
			app = randomUUID(),
			version = randomUUID();
		const spec = parseRuntimeSpec({
			schemaVersion: 1,
			publishedAppVersionId: `pav_${version}`,
			agent: { systemPrompt: "Chat rules", model: { provider: "fake", modelId: "test" } },
			capabilities: {},
		});
		if (!spec.ok) throw new Error("fixture");
		await client.run(
			"insert into agent_definitions(id,tenant_id,name,revision,draft_config,created_by) values ($1,$2,'Chat',1,'{}',$2)",
			agent,
			tenant,
		);
		await client.run(
			"insert into published_apps(id,tenant_id,agent_definition_id,public_app_id,name,status,access_mode,created_by) values ($1,$2,$3,$4,'Chat','active','anonymous',$2)",
			app,
			tenant,
			agent,
			`pub_${app}`,
		);
		await client.run(
			"insert into published_app_versions(id,tenant_id,published_app_id,version_number,source_agent_revision,snapshot,runtime_spec,runtime_spec_hash,status,created_by) values ($1,$2,$3,1,1,'{}',$4::jsonb,$5,'ready',$2)",
			version,
			tenant,
			app,
			spec.spec,
			sha256Hex(canonicalJson(spec.spec)),
		);
		const legacy = await store.createIntegration(
			app,
			version,
			"legacy",
			settingsSchema.parse({ allowedModels: ["test"], bindings: [] }),
		);
		const i = await store.getIntegration(legacy.id),
			key = randomUUID(),
			request = { prompt: "Old override", credentials: {} };
		const oldHash = credentialHash(canonicalJson({ origin: "aaas", request }));
		const old = await store.accept(
			i,
			{
				eventId: key,
				alarmId: key,
				input: request.prompt,
				credentials: {},
				credentialExpiresAt: new Date(Date.now() + 600000).toISOString(),
			},
			{ origin: "aaas", taskPrompt: request.prompt, requestContract: "legacy_prompt", requestHash: oldHash },
		);
		await client.run("update orchestration_events set request_hash_version=1 where work_item_id=$1", old.workItemId);
		const frozen = await store.run(old.workItemId, i.id);
		expect((await createRun(store, i, key, request)).run_id).toBe(old.workItemId);
		await service.migrateConfiguration(i.id, i.revision, `pav_${version}`);
		const chatVersion = randomUUID();
		await client.run(
			"insert into agent_definitions(id,tenant_id,name,revision,draft_config,created_by) values ($1,$2,'Chat edited',2,'{}',$2)",
			agent,
			tenant,
		);
		const changedChat = {
			...spec.spec,
			publishedAppVersionId: `pav_${chatVersion}`,
			agent: { ...spec.spec.agent, systemPrompt: "Chat changed after task migration" },
		};
		await client.run(
			"insert into published_app_versions(id,tenant_id,published_app_id,version_number,source_agent_revision,snapshot,runtime_spec,runtime_spec_hash,status,created_by) values ($1,$2,$3,2,2,'{}',$4::jsonb,$5,'ready',$2)",
			chatVersion,
			tenant,
			app,
			changedChat,
			sha256Hex(canonicalJson(changedChat)),
		);
		await client.run("update published_apps set current_version_id=$1 where id=$2", chatVersion, app);
		await client.run("update published_apps set status='suspended' where id=$1", app);
		const claimed = (await store.claim())!;
		await store.complete(claimed.id, await service.execute(claimed), null);
		expect((await store.run(old.workItemId, i.id)).agent_version).toBe(frozen.agent_version);
		const migrated = await store.getIntegration(i.id);
		const run = await createRun(store, migrated, randomUUID(), { input: { ticket_id: "post-migration" } });
		const task = (await store.claim())!;
		await store.complete(task.id, await service.execute(task), null);
		expect(sessions.at(-1)!.options.systemPrompt).toBe("Chat rules");
		expect((await store.run(run.run_id, i.id)).agent_version).toMatch(/^orv_/);
		expect(await counts()).toEqual([2, 1, 2]);
	});
});
