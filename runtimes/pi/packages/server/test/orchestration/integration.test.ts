import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AaasRun } from "@earendil-works/pi-protocol";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ConversationService } from "../../src/embed/conversations/service.ts";
import { settingsSchema } from "../../src/orchestration/contracts.ts";
import { WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { startOrchestrationDispatcher } from "../../src/orchestration/dispatcher.ts";
import { orchestrationExecutionConfigResolver } from "../../src/orchestration/execution-configuration.ts";
import { createOrchestrationHttp } from "../../src/orchestration/http.ts";
import { OrchestrationService } from "../../src/orchestration/service.ts";
import { type IntegrationRecord, OrchestrationStore } from "../../src/orchestration/store.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { ControlService } from "../../src/publishing/control/service.ts";
import type { ConversationId, PrincipalId, PublishedAppId, TenantId, TurnId } from "../../src/publishing/domain/ids.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";

const url = process.env.PI_ORCHESTRATION_TEST_DATABASE_URL;
const schema = `orchestration_test_${process.pid}_${Date.now()}`;
const tenantId = randomUUID(),
	appId = randomUUID(),
	versionId = randomUUID();
const report = "  # 测试研判完成\n\n- 模拟工具证据\n- 人工核对\n";

describe.skipIf(!url)("orchestration with real isolated Postgres and Fake model", () => {
	let client: PostgresClient,
		store: OrchestrationStore,
		service: OrchestrationService,
		i: IntegrationRecord,
		token: string;
	let calls = 0;
	let control: ControlService;
	let server: ReturnType<typeof createServer>;
	let base: string;
	let dispatcher: Awaited<ReturnType<typeof startOrchestrationDispatcher>> | undefined;
	beforeAll(async () => {
		client = new PostgresClient({ url: url!, searchPath: schema });
		await client.run(`create schema ${schema}`);
		await runMigrations(client);
		await client.run("insert into tenants(id,name,status) values ($1,'test','active')", tenantId);
		const agentId = randomUUID();
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
		if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
		await client.run(
			`insert into published_app_versions(id,tenant_id,published_app_id,version_number,source_agent_revision,snapshot,runtime_spec,runtime_spec_hash,status,created_by)
		values ($1,$2,$3,1,1,'{}',$4::jsonb,$5,'ready',$2)`,
			versionId,
			tenantId,
			appId,
			parsed.spec,
			sha256Hex(canonicalJson(parsed.spec)),
		);
		await client.run("update published_apps set current_version_id=$1 where id=$2", versionId, appId);
		store = new OrchestrationStore(client, tenantId, new WorkCredentialBox(Buffer.alloc(32, 7)));
		const created = await store.createIntegration(
			appId,
			versionId,
			"test",
			settingsSchema.parse({ allowedModels: ["test"], bindings: [] }),
		);
		token = created.token;
		i = await store.getIntegration(created.id);
		const repos = createPublishingRepositories(client);
		const conversations = new ConversationService({
			repositories: repos,
			resolveExecutionConfiguration: orchestrationExecutionConfigResolver(store, repos),
			turnExecutor: async ({ text, spec }) => {
				const effective = spec.agent.systemPrompt.includes("RAW-OUTPUT-TEST") ? spec.agent.systemPrompt : text;
				calls++;
				return {
					ok: true,
					outputText: effective.includes("RAW-OUTPUT-TEST") ? JSON.parse(effective).output : report,
				};
			},
		});
		control = new ControlService({
			repositories: repos,
			catalog: { tools: [], knowledgeBases: [], models: [{ provider: "fake", modelId: "test" }] },
			embedBaseUrl: "https://embed.test",
		});
		vi.spyOn(control, "listLlmModels").mockResolvedValue({
			ok: true,
			data: {
				items: [
					{
						id: "test",
						name: "test",
						provider: "fake",
						api: "openai-completions",
						reasoning: false,
						parameterCapabilities: { reasoning: { supported: false, toggle: false, efforts: [] } },
					},
				],
			},
		});
		service = new OrchestrationService(store, control, repos, conversations);
		const handler = createOrchestrationHttp(
			service,
			(request) => request.headers.authorization === "Bearer admin-test",
		);
		server = createServer((req, res) => {
			void Promise.resolve(handler(req, res)).then((handled) => {
				if (!handled) res.writeHead(404).end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("listen failed");
		base = `http://127.0.0.1:${address.port}`;
	}, 30000);
	afterAll(async () => {
		await dispatcher?.close();
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (client) {
			await client.run(`drop schema ${schema} cascade`);
			await client.close();
		}
	});
	const event = (overrides: Record<string, unknown> = {}) => ({
		eventId: randomUUID(),
		alarmId: "alarm-1",
		input: "设备超时",
		credentials: {},
		credentialExpiresAt: new Date(Date.now() + 600000).toISOString(),
		...overrides,
	});
	const request = async (path: string, method = "GET", body?: unknown, authorization = `Bearer ${token}`) => {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: { Authorization: authorization, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		return {
			status: response.status,
			body: (await response.json()) as { data: { workItemId: string; token?: string }; error?: { code: string } },
		};
	};
	const runRequest = async (
		path: string,
		method = "GET",
		body?: unknown,
		key?: string,
		authorization = `Bearer ${token}`,
	) => {
		const response = await fetch(`${base}/api/aaas/v1${path}`, {
			method,
			headers: {
				Authorization: authorization,
				"Content-Type": "application/json",
				...(key ? { "Idempotency-Key": key } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		return {
			status: response.status,
			body: (await response.json()) as {
				data: Partial<AaasRun> & { duplicate?: boolean };
				error?: { code: string };
			},
		};
	};

	test("concurrent duplicate events create only one work item and conflicting replay is rejected", async () => {
		const input = event();
		const [a, b] = await Promise.all([store.accept(i, input), store.accept(i, input)]);
		expect(a.workItemId).toBe(b.workItemId);
		expect([a.duplicate, b.duplicate].filter(Boolean)).toHaveLength(1);
		await expect(store.accept(i, { ...input, input: "different" })).rejects.toMatchObject({ code: "EVENT_CONFLICT" });
		await store.cancel(a.workItemId);
	});

	test("per-work principals and explicit subscriptions isolate input and results", async () => {
		const a = await store.accept(i, event()),
			b = await store.accept(i, event());
		const wa = await store.workItem(a.workItemId),
			wb = await store.workItem(b.workItemId);
		expect(wa.conversationId).not.toBe(wb.conversationId);
		const rows = await client.run(
			"select principal_id from orchestration_work_items where id in ($1,$2)",
			wa.id,
			wb.id,
		);
		expect(rows[0]!.principal_id).not.toBe(rows[1]!.principal_id);
		await expect(store.accept(i, event({ workItemId: wa.id, alarmId: "other" }))).rejects.toMatchObject({
			status: 404,
		});
		await expect(store.workItem(wa.id, randomUUID())).rejects.toMatchObject({ status: 404 });
		await store.cancel(wa.id);
		await store.cancel(wb.id);
	});

	test("Run credentials default to a fixed 30-minute authorization without a caller expiry and survive reconstruction", async () => {
		const binding = {
			mcpServerId: `mcp_${randomUUID()}`,
			toolName: "query",
			parameter: "apiKey",
			credential: "ticketKey",
		};
		await client.run(
			"update orchestration_integrations set settings=$1::jsonb where id=$2",
			{ ...i.settings, bindings: [binding] },
			i.id,
		);
		const key = randomUUID(),
			body = { prompt: "分析设备状态", credentials: { ticketKey: "user-test-secret" } },
			before = Date.now();
		const accepted = await runRequest(`/integrations/${i.id}/runs`, "POST", body, key);
		expect(accepted.status).toBe(202);
		const a = { workItemId: accepted.body.data.run_id! };
		const expiry = await client.run(
			"select expires_at from orchestration_credentials where work_item_id=$1",
			a.workItemId,
		);
		expect((expiry[0]!.expires_at as Date).getTime()).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
		expect((expiry[0]!.expires_at as Date).getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000);
		expect((await runRequest(`/integrations/${i.id}/runs`, "POST", body, key)).body.data.run_id).toBe(a.workItemId);
		expect(
			await client.run("select expires_at from orchestration_credentials where work_item_id=$1", a.workItemId),
		).toEqual(expiry);
		const claimed = await store.claim();
		expect(claimed?.workItemId).toBe(a.workItemId);
		const restored = new OrchestrationStore(client, tenantId, new WorkCredentialBox(Buffer.alloc(32, 7)));
		expect((await restored.credentials(claimed!.conversationId, claimed!.turnId)).values.ticketKey).toBe(
			"user-test-secret",
		);
		await expect(restored.credentials(claimed!.conversationId, randomUUID())).rejects.toMatchObject({ status: 403 });
		const raw = await client.run("select sealed from orchestration_credentials where work_item_id=$1", a.workItemId);
		expect(JSON.stringify(raw)).not.toContain("user-test-secret");
		await expect(
			service.validateOutput(claimed!.conversationId, claimed!.turnId, "正文 user-test-secret"),
		).rejects.toMatchObject({ code: "CREDENTIAL_IN_REPORT" });
		await expect(service.validateOutput(claimed!.conversationId, claimed!.turnId, "  正文\n")).resolves.toBe(
			"  正文\n",
		);
		await store.cancel(a.workItemId);
		await client.run("update orchestration_integrations set settings=$1::jsonb where id=$2", i.settings, i.id);
	});

	test("acceptance and credential validation roll back together", async () => {
		const before = await client.run("select count(*)::int as n from orchestration_work_items");
		await expect(store.accept(i, event({ credentials: { unknownKey: "some-secret" } }))).rejects.toMatchObject({
			code: "UNKNOWN_CREDENTIAL",
		});
		const after = await client.run("select count(*)::int as n from orchestration_work_items");
		expect(after).toEqual(before);
	});

	test("cancelled work rejects late completion and new inputs", async () => {
		const a = await store.accept(i, event());
		const claim = await store.claim();
		expect(claim?.workItemId).toBe(a.workItemId);
		await store.cancel(a.workItemId);
		await store.complete(claim!.id, report, null);
		expect((await store.workItem(a.workItemId)).state).toBe("cancelled");
		await expect(store.accept(i, event({ workItemId: a.workItemId }))).rejects.toMatchObject({ status: 404 });
	});

	test("HTTP requires system authentication and does not require a user name", async () => {
		expect((await request("/api/orchestration/v1/work-items", "GET", undefined, "Bearer invalid")).status).toBe(401);
		expect((await request("/api/admin/v1/orchestration/integrations")).status).toBe(401);
		const accepted = await request("/api/orchestration/v1/events", "POST", event());
		expect(accepted.status).toBe(202);
		await store.cancel(accepted.body.data.workItemId);
		const listed = await request("/api/admin/v1/orchestration/integrations", "GET", undefined, "Bearer admin-test");
		expect(JSON.stringify(listed.body)).not.toContain(token);
	});

	test("system credential rotation and disable revoke authentication independently of tool credentials", async () => {
		const old = token;
		const rotated = await store.updateAccess(i.id, "rotate");
		expect(rotated).toHaveProperty("token");
		token = (rotated as { token: string }).token;
		await expect(store.authenticate(`Bearer ${old}`)).rejects.toMatchObject({ status: 401 });
		expect((await store.authenticate(`Bearer ${token}`)).id).toBe(i.id);
		await store.updateAccess(i.id, "disable");
		await expect(store.authenticate(`Bearer ${token}`)).rejects.toMatchObject({ status: 401 });
		await store.updateAccess(i.id, "enable");
	});

	test("console catalog requires admin auth and returns publication choices without schema or endpoint contents", async () => {
		expect((await request("/api/admin/v1/orchestration/catalog")).status).toBe(401);
		const models = vi.spyOn(control, "listLlmModels").mockResolvedValue({
			ok: true,
			data: {
				items: [
					{
						id: "test",
						name: "测试模型",
						provider: "fake",
						api: "openai-completions",
						reasoning: false,
						parameterCapabilities: { reasoning: { supported: false, toggle: false, efforts: [] } },
					},
				],
			},
		});
		const rows = await client.run("select runtime_spec from published_app_versions where id=$1", versionId);
		const original = rows[0]!.runtime_spec;
		const parsed = parseRuntimeSpec(original);
		if (!parsed.ok) throw new Error("invalid test fixture");
		const toolSchema = {
			type: "object",
			properties: { apiKey: { type: "string", default: "test-sensitive-default" }, limit: { type: "number" } },
			required: ["apiKey"],
		};
		try {
			await client.run(
				"update published_app_versions set runtime_spec=$1::jsonb where id=$2",
				{
					...parsed.spec,
					capabilities: {
						...parsed.spec.capabilities,
						mcpServers: [
							{
								mcpServerId: `mcp_${randomUUID()}`,
								revision: 1,
								transport: "streamable_http",
								endpoint: "https://private.test/mcp",
								authentication: "bearer",
								tools: [
									{
										name: "query_alarm",
										description: "private tool description",
										inputSchema: toolSchema,
										inputSchemaHash: sha256Hex(canonicalJson(toolSchema)),
									},
								],
							},
						],
					},
				},
				versionId,
			);
			const result = await service.catalog();
			expect(result.applications).toEqual([]);
			expect(result.mcpServers).toEqual([]);
			expect(JSON.stringify(result)).not.toMatch(
				/test-sensitive-default|private\.test|private tool description|inputSchema/,
			);
			expect(
				(await request("/api/admin/v1/orchestration/catalog", "GET", undefined, "Bearer admin-test")).status,
			).toBe(200);
		} finally {
			await client.run(
				"update published_app_versions set runtime_spec=$1::jsonb where id=$2",
				parsed.spec,
				versionId,
			);
			models.mockRestore();
			vi.spyOn(control, "listLlmModels").mockResolvedValue({
				ok: true,
				data: {
					items: [
						{
							id: "test",
							name: "test",
							provider: "fake",
							api: "openai-completions",
							reasoning: false,
							parameterCapabilities: { reasoning: { supported: false, toggle: false, efforts: [] } },
						},
					],
				},
			});
		}
	});

	test("AaaS validates requests and isolates integration paths without accepting legacy fields", async () => {
		const path = `/integrations/${i.id}/runs`,
			body = { prompt: "分析 TEST-001" };
		for (const invalid of [
			{ input: "not an object" },
			{ input: null },
			{ prompt: " " },
			{ prompt: 1 },
			{ prompt: "x".repeat(48001) },
			{ ...body, input: {} },
			{ ...body, credential_expires_at: new Date(Date.now() + 60000).toISOString() },
		])
			expect((await runRequest(path, "POST", invalid, randomUUID())).status).toBe(400);
		expect((await runRequest(path, "POST", body)).status).toBe(400);
		expect((await runRequest(path, "POST", { ...body, workItemId: randomUUID() }, randomUUID())).status).toBe(400);
		expect((await runRequest(path, "POST", { ...body, origin: "orchestration" }, randomUUID())).status).toBe(400);
		expect(
			(await runRequest(path, "POST", { ...body, credentials: { authToken: "test-only-key" } }, randomUUID()))
				.status,
		).toBe(400);
		expect((await runRequest(`/integrations/${randomUUID()}/runs`, "POST", body, randomUUID())).status).toBe(404);
		expect((await runRequest(path, "POST", body, randomUUID(), "Bearer invalid")).status).toBe(401);
		expect((await runRequest("/runs/x/retry", "POST", {}, randomUUID())).status).toBe(404);
	});

	test("AaaS concurrent replay is stable without an explicit empty-credential expiry and new requests create new runs", async () => {
		const path = `/integrations/${i.id}/runs`,
			key = randomUUID(),
			body = {
				prompt: "  分析 TEST-002\n按自定义格式返回\n",
				external_ref: { type: "ticket", id: "TEST-002" },
			};
		const [a, b] = await Promise.all([runRequest(path, "POST", body, key), runRequest(path, "POST", body, key)]);
		expect(a.status).toBe(202);
		expect(b.status).toBe(202);
		expect(a.body.data.run_id).toBe(b.body.data.run_id);
		expect([a.body.data.duplicate, b.body.data.duplicate].filter(Boolean)).toHaveLength(1);
		const id = a.body.data.run_id!;
		expect((await store.workItem(id)).origin).toBe("aaas");
		const frozen = await store.run(id, i.id);
		expect(frozen.agent_version).toBe(`pav_${i.versionId}`);
		expect((await runRequest(path, "POST", { ...body, prompt: "changed" }, key)).status).toBe(409);
		expect(
			(await runRequest(path, "POST", { ...body, external_ref: { type: "document", id: "TEST-002" } }, key)).status,
		).toBe(409);
		const assignment = await store.claim();
		expect(assignment?.workItemId).toBe(id);
		expect(assignment?.input).toBe(body.prompt);
		expect(await store.taskPrompt(assignment!.conversationId, assignment!.turnId)).toBe(body.prompt);
		expect(
			await new OrchestrationStore(client, tenantId, new WorkCredentialBox(Buffer.alloc(32, 7))).taskPrompt(
				assignment!.conversationId,
				assignment!.turnId,
			),
		).toBe(body.prompt);
		await expect(store.taskPrompt(assignment!.conversationId, randomUUID())).rejects.toMatchObject({ status: 403 });
		await store.complete(assignment!.id, report, null);
		const queried = await runRequest(`/runs/${id}`);
		expect(queried.body.data).toMatchObject({ run_id: id, status: "completed", result: report });
		expect(JSON.stringify(queried.body)).not.toMatch(
			/conversationId|conversation_id|assignments|credential|principal|turnId/,
		);
		expect((await runRequest(path, "POST", body, key)).body.data).toMatchObject({
			run_id: id,
			status: "completed",
			duplicate: true,
		});
		const next = await runRequest(path, "POST", body, randomUUID());
		expect(next.body.data.run_id).not.toBe(id);
		await store.cancel(next.body.data.run_id!);
		const legacy = await store.accept(i, event());
		expect((await runRequest(`/runs/${legacy.workItemId}`)).status).toBe(404);
		await store.cancel(legacy.workItemId);
		const restored = new OrchestrationStore(client, tenantId, new WorkCredentialBox(Buffer.alloc(32, 7)));
		expect(await restored.run(id, i.id)).toEqual(await store.run(id, i.id));
		await expect(restored.run(id, randomUUID())).rejects.toMatchObject({ status: 404 });
		await expect(
			new OrchestrationStore(client, randomUUID(), new WorkCredentialBox(Buffer.alloc(32, 7))).run(id, i.id),
		).rejects.toMatchObject({ status: 404 });
	});

	test("AaaS store guards block legacy and admin supplement/retry in every lifecycle state and preserve terminal cancellation", async () => {
		for (const state of ["queued", "running", "succeeded", "failed", "cancelled"] as const) {
			const ref = `run-guard-${state}`;
			const created = await runRequest(
				`/integrations/${i.id}/runs`,
				"POST",
				{ prompt: ref, external_ref: { id: ref } },
				randomUUID(),
			);
			const id = created.body.data.run_id!;
			if (state !== "queued") {
				const claim = await store.claim();
				expect(claim?.workItemId).toBe(id);
				if (state === "succeeded") await store.complete(claim!.id, report, null);
				if (state === "failed") await store.complete(claim!.id, null, "EXECUTION_FAILED");
				if (state === "cancelled") await store.cancel(id);
			}
			const before = await store.run(id, i.id);
			const extra = event({ workItemId: id, alarmId: ref });
			expect((await request("/api/orchestration/v1/events", "POST", extra)).body.error?.code).toBe("RUN_IMMUTABLE");
			for (const prefix of ["/api/orchestration/v1", "/api/admin/v1/orchestration"]) {
				const rejected = await request(
					`${prefix}/work-items/${id}/retry`,
					"POST",
					{},
					prefix.includes("admin") ? "Bearer admin-test" : `Bearer ${token}`,
				);
				expect(rejected.body.error?.code).toBe("RUN_IMMUTABLE");
			}
			await expect(store.accept(i, extra)).rejects.toMatchObject({ code: "RUN_IMMUTABLE" });
			await expect(store.retry(id)).rejects.toMatchObject({ code: "RUN_IMMUTABLE" });
			expect(await store.run(id, i.id)).toEqual(before);
			await store.cancel(id);
			if (["succeeded", "failed", "cancelled"].includes(state)) expect(await store.run(id, i.id)).toEqual(before);
			expect((await store.workItem(id)).assignments).toHaveLength(1);
		}
	});

	test("Chat suspension does not reject task work", async () => {
		await client.run("update published_apps set status='suspended' where id=$1", appId);
		try {
			const accepted = await store.accept(i, event());
			await store.cancel(accepted.workItemId);
		} finally {
			await client.run("update published_apps set status='active' where id=$1", appId);
		}
	});

	test("inputs arriving during an execution remain queued for a later assignment", async () => {
		const accepted = await store.accept(i, event());
		const first = await store.claim();
		expect(first!.workItemId).toBe(accepted.workItemId);
		const followup = event({ workItemId: accepted.workItemId, input: "additional evidence" });
		await store.accept(i, followup);
		expect(await store.claim()).toBeUndefined();
		await store.complete(first!.id, report, null);
		const intermediate = await store.workItem(accepted.workItemId);
		expect(intermediate.state).toBe("queued");
		expect(intermediate.reportEventId).not.toBe(followup.eventId);
		const second = await store.claim();
		expect(second!.input).toBe("additional evidence");
		await Promise.all([store.complete(second!.id, report, null), store.cancel(accepted.workItemId)]);
		expect((await store.workItem(accepted.workItemId)).state).toBe("cancelled");
	});

	test("configuration CAS publishes independently after explicit migration and existing work keeps its snapshot", async () => {
		await service.migrateConfiguration(i.id, i.revision, `pav_${i.versionId}`);
		i = await store.getIntegration(i.id);
		const work = await store.accept(i, event());
		const run = await runRequest(`/integrations/${i.id}/runs`, "POST", { prompt: "frozen" }, randomUUID());
		const beforeRun = await store.run(run.body.data.run_id!, i.id);
		const original = await service.configuration(await store.getIntegration(i.id));
		const request = {
			expectedRevision: original.revision,
			systemPrompt: "New analysis instructions",
			modelId: "test",
			parameters: {},
		};
		const outcomes = await Promise.allSettled([
			service.saveConfiguration(i, request),
			service.saveConfiguration(i, request),
		]);
		expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
		const updated = await service.configuration(await store.getIntegration(i.id));
		expect(updated.revision).toBe(original.revision + 1);
		expect(updated.systemPrompt).toBe(request.systemPrompt);
		expect((await store.workItem(work.workItemId)).configurationRevision).toBe(original.revision);
		expect(await store.run(beforeRun.run_id, i.id)).toEqual(beforeRun);
		const newerRun = await runRequest(`/integrations/${i.id}/runs`, "POST", { prompt: "new-config" }, randomUUID());
		expect((await store.run(newerRun.body.data.run_id!, i.id)).configuration_revision).toBe(updated.revision);
		await store.cancel(beforeRun.run_id);
		await store.cancel(newerRun.body.data.run_id!);
		await expect(
			service.saveConfiguration(i, { ...request, expectedRevision: updated.revision, modelId: "forbidden" }),
		).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
		expect((await store.getIntegration(i.id)).revision).toBe(updated.revision);
		const publish = vi
			.spyOn(store.configurations, "insertVersion")
			.mockRejectedValueOnce(new Error("test compile failure"));
		await expect(service.saveConfiguration(i, { ...request, expectedRevision: updated.revision })).rejects.toThrow();
		publish.mockRestore();
		expect((await store.getIntegration(i.id)).revision).toBe(updated.revision);
		await store.cancel(work.workItemId);
	});

	test("failure retry makes a new assignment, retains work identity and rejects expired credentials", async () => {
		const accepted = await store.accept(i, event());
		const claimed = await store.claim();
		expect(claimed!.workItemId).toBe(accepted.workItemId);
		await store.complete(claimed!.id, null, "EXECUTION_FAILED");
		await store.retry(accepted.workItemId);
		const retried = await store.claim();
		expect(retried!.id).not.toBe(claimed!.id);
		expect(retried!.conversationId).toBe(claimed!.conversationId);
		await store.complete(retried!.id, null, "EXECUTION_FAILED");
		await client.run(
			"update orchestration_credentials set expires_at=now()-interval '1 second' where work_item_id=$1",
			accepted.workItemId,
		);
		await expect(store.retry(accepted.workItemId)).rejects.toMatchObject({ code: "CREDENTIAL_EXPIRED" });
		await store.cancel(accepted.workItemId);
	});

	test("raw-output migration preserves historical JSON and JSON strings and removes obsolete settings", async () => {
		const accepted = await store.accept(i, event()),
			claim = await store.claim();
		expect(claim?.workItemId).toBe(accepted.workItemId);
		const legacy = { summary: "历史结果", evidence: ["保留数据"] };
		const migration = await readFile(
			new URL("../../src/persistence/postgres/migrations/0025_orchestration_raw_output.sql", import.meta.url),
			"utf8",
		);
		await client.transaction(async (tx) => {
			await tx.unsafe("alter table orchestration_assignments alter column report type jsonb using to_jsonb(report)");
			await tx`update orchestration_assignments set report=${tx.json(legacy)} where id=${claim!.id}`;
			await tx`update orchestration_integrations set settings=settings || '{"reportSchemaVersion":1}'::jsonb`;
			await tx`update orchestration_work_items set settings=settings || '{"reportSchemaVersion":1}'::jsonb`;
			await tx.unsafe(migration);
		});
		const work = await store.workItem(accepted.workItemId);
		expect(JSON.parse(work.report!)).toEqual(legacy);
		expect((await store.getIntegration(i.id)).settings).not.toHaveProperty("reportSchemaVersion");
		await store.cancel(accepted.workItemId);
	});

	test("restart recovers a committed raw result without calling the model and blocks uncertain execution", async () => {
		const a = await store.accept(i, event()),
			b = await store.accept(i, event());
		const first = await store.claim(),
			second = await store.claim();
		expect(new Set([first!.workItemId, second!.workItemId])).toEqual(new Set([a.workItemId, b.workItemId]));
		const repos = createPublishingRepositories(client);
		const owner = {
			tenantId: tenantId as TenantId,
			publishedAppId: first!.appId ? (first!.appId as PublishedAppId) : null,
			...(first!.configurationId ? { integrationId: first!.integrationId } : {}),
			principalId: first!.principalId as PrincipalId,
		};
		for (const [eventType, payload] of [
			["assistant/message", { text: report }],
			["turn/end", { ok: true }],
		] as const)
			await repos.events.append(owner, {
				conversationId: first!.conversationId as ConversationId,
				turnId: first!.turnId as TurnId,
				eventType,
				payload,
			});
		const before = calls;
		dispatcher = await startOrchestrationDispatcher(service, () => {});
		expect((await store.workItem(first!.workItemId)).state).toBe("succeeded");
		expect((await store.workItem(first!.workItemId)).report).toBe(report);
		expect((await store.workItem(second!.workItemId)).assignments[0]?.error).toBe("EXECUTION_INTERRUPTED");
		expect(calls).toBe(before);
		await expect(startOrchestrationDispatcher(service, () => {})).rejects.toThrow("already owns");
	});

	test("background execution commits a report and accepts a follow-up in the same conversation", async () => {
		const a = await store.accept(i, event());
		await expect.poll(async () => (await store.workItem(a.workItemId)).state, { timeout: 10000 }).toBe("succeeded");
		const before = await store.workItem(a.workItemId);
		await store.accept(i, event({ workItemId: a.workItemId, input: "补充设备恢复日志" }));
		await expect
			.poll(
				async () => (await store.workItem(a.workItemId)).assignments.filter((a) => a.state === "succeeded").length,
				{ timeout: 10000 },
			)
			.toBe(2);
		const after = await store.workItem(a.workItemId);
		expect(after.conversationId).toBe(before.conversationId);
		expect(after.report).toEqual(report);
	});

	test("AaaS uses the existing background executor and persists a one-shot result", async () => {
		const path = `/integrations/${i.id}/runs`;
		const created = await runRequest(path, "POST", { prompt: "aaas-background" }, randomUUID());
		await expect
			.poll(async () => (await store.run(created.body.data.run_id!, i.id)).status, { timeout: 10000 })
			.toBe("completed");
		expect((await runRequest(`/runs/${created.body.data.run_id}`)).body.data.result).toEqual(report);
	});

	test.each(["普通文本，无固定字段", '```json\n{"custom": [1, 2]}\n```', '{"answer":42}', "", " \n\t保留空白\r\n "])(
		"AaaS preserves raw output exactly: %j",
		async (output) => {
			const created = await runRequest(
				`/integrations/${i.id}/runs`,
				"POST",
				{
					prompt: JSON.stringify({ marker: "RAW-OUTPUT-TEST", output }),
				},
				randomUUID(),
			);
			const id = created.body.data.run_id!;
			await expect.poll(async () => (await store.run(id, i.id)).status, { timeout: 10000 }).toBe("completed");
			expect((await runRequest(`/runs/${id}`)).body.data.result).toBe(output);
			expect((await store.workItem(id)).report).toBe(output);
			expect((await store.workItem(id)).assignments[0]?.report).toBe(output);
		},
	);
});
