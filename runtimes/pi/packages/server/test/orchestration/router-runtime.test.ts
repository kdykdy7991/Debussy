/**
 * Router V1 phase four: six public routes over HTTP, serial execution on a real
 * PostgreSQL database, idempotency, cancellation, fence and cleanup evidence.
 * Skipped (NOT RUN) when no isolated test database is reachable.
 */
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSessionServices, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AdminSandboxStatistics, ModelRef, SessionSnapshot, ThinkingLevel } from "@earendil-works/pi-protocol";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { CodingAgentPiSessionBackend } from "../../src/coding-agent/backend.ts";
import { ApiKeyStore } from "../../src/orchestration/api-key.ts";
import { createApiKeyHttp } from "../../src/orchestration/api-key-http.ts";
import { createRouterAdmin } from "../../src/orchestration/router-admin.ts";
import { IdempotencyKeyring } from "../../src/orchestration/api-key-idempotency.ts";
import { saveDirectCapabilities } from "../../src/orchestration/router-capability.ts";
import { protectTool } from "../../src/orchestration/protected-tool.ts";
import {
	operationViewSchema,
	taskEventsResponseSchema,
	taskViewSchema,
} from "../../src/orchestration/router-contracts.ts";
import { RouterRuntime } from "../../src/orchestration/router-runtime.ts";
import { createPiRuntimeAdapter, type RuntimeSessionOptions } from "../../src/runtime/pi-runtime-adapter.ts";
import type { SandboxConfig } from "../../src/runtime/sandbox.ts";
import type { PiSessionRuntime, PiSessionRuntimeEvent, PromptInput, SteerInput } from "../../src/types.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { newMcpSecretId, newMcpServerId, newMcpToolId, type TenantId } from "../../src/publishing/domain/ids.ts";
import { mcpResourceToolName } from "../../src/publishing/mcp/resource-content.ts";
import { createMcpRuntimeToolFactory } from "../../src/publishing/mcp/runtime-tools.ts";
import { McpSecretBox } from "../../src/publishing/mcp/secret-box.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";

const ADMIN_URL = process.env.PI_ROUTER_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const DATABASE = `router_v1_phase4_${process.pid}_${Date.now().toString(36)}`;
const MIGRATIONS_DIR = fileURLToPath(new URL("../../src/persistence/postgres/migrations/", import.meta.url));
const masterKey = new Uint8Array(32).fill(41);
const tenantId = randomUUID();
const MODEL: ModelRef = { provider: "test", id: "test-model" };
const ADMIN_TOKEN = "router-admin-isolated-test-token";
const SANDBOX_RUNTIME = process.env.PI_SANDBOX_TEST_RUNTIME;
const SANDBOX_MODEL_URL = process.env.PI_SANDBOX_TEST_MODEL_URL;

function databaseUrl(): string {
	const url = new URL(ADMIN_URL);
	url.pathname = `/${DATABASE}`;
	return url.toString();
}
async function probe(): Promise<boolean> {
	const admin = new PostgresClient({ url: ADMIN_URL, connectTimeoutSeconds: 3 });
	try {
		await admin.ping();
		return true;
	} catch {
		return false;
	} finally {
		await admin.close();
	}
}
const pgUp = await probe();

type Completion = { text: string; status: "complete" | "error" };
class ControlledSession implements PiSessionRuntime {
	readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	readonly prompts: PromptInput[] = [];
	aborted = 0;
	disposed = 0;
	private readonly id: string;
	private completion: Completion;
	private resume: (() => void) | undefined;
	constructor(id: string, completion: Completion, privateTools: RuntimeSessionOptions["customTools"] = []) {
		this.id = id;
		this.completion = completion;
		this.tools = privateTools;
	}
	readonly tools: NonNullable<RuntimeSessionOptions["customTools"]>;
	snapshot(): SessionSnapshot {
		return {
			id: this.id,
			cwd: "/tmp",
			createdAt: 1,
			updatedAt: 1,
			phase: "idle",
			model: MODEL,
			thinkingLevel: "off" as ThinkingLevel,
			attached: true,
			locked: true,
			lastSequence: 0,
			revision: 0,
			transcript: [
				{
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "text", text: this.completion.text }],
					status: this.completion.status,
					model: MODEL,
					stopReason: this.completion.status === "complete" ? "stop" : "error",
					timestamp: 2,
				},
			],
			queuedSteer: [],
			queuedSteerCount: 0,
		} as unknown as SessionSnapshot;
	}
	getPhase(): "idle" {
		return "idle";
	}
	async prompt(input: PromptInput): Promise<void> {
		this.prompts.push(input);
		if (input.text === "hold")
			await new Promise<void>((done) => {
				this.resume = done;
			});
		if (input.text.startsWith("tool ")) {
			const tool = this.tools.find((entry) => entry.name === "lookup")!;
			const item = {
				id: "fixture-tool",
				toolCallId: "fixture-tool",
				toolName: "lookup",
				role: "tool" as const,
				input: { query: input.text },
				content: [],
				timestamp: 1,
			};
			await input.onLlmTrace?.({
				kind: "request", model: MODEL, callIndex: 1,
				context: { messages: [], systemPrompt: "fixture-internal-trace-prompt" },
			});
			await input.onLlmTrace?.({
				kind: "response",
				model: MODEL,
				callIndex: 1,
				message: {
					role: "assistant",
					content: [],
					stopReason: "stop",
					timestamp: 1,
					usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6 },
				},
			} as unknown as Parameters<NonNullable<PromptInput["onLlmTrace"]>>[0]);
			if (input.text === "tool failure") {
				this.emit({
					type: "progress",
					progress: {
						type: "item_finished",
						item: {
							id: "partial",
							role: "assistant",
							status: "complete",
							stopReason: "stop",
							timestamp: 1,
							content: [{ type: "text", text: "partial-before-failure" }],
							model: MODEL,
						},
					},
				});
			}
			this.emit({
				type: "progress",
				progress: { type: "item_started", item: { ...item, status: "running", isError: false } },
			});
			const result = await tool.execute(item.toolCallId, item.input, undefined, undefined, {} as never);
			this.emit({
				type: "progress",
				progress: {
					type: "item_finished",
					item: { ...item, status: "complete", isError: false, content: result.content },
				},
			});
			this.completion = { text: "tool summarized", status: "complete" };
		}
		if (this.completion.status === "error") throw new Error("controlled tool failure");
	}
	private emit(event: PiSessionRuntimeEvent): void {
		for (const listener of this.listeners) listener(event);
	}
	async steer(_input: SteerInput): Promise<void> {}
	async abort(): Promise<void> {
		this.aborted += 1;
		this.resume?.();
	}
	complete(): void {
		this.resume?.();
	}
	async setModel(_model: ModelRef): Promise<void> {}
	async setThinking(_thinkingLevel: ThinkingLevel): Promise<void> {}
	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async dispose(): Promise<void> {
		this.disposed += 1;
	}
}

function call(
	base: string,
	method: string,
	path: string,
	token: string,
	body?: unknown,
	idem?: string,
	scope?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const payload = body === undefined ? undefined : JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const url = new URL(path, base);
		const req = httpRequest(
			url,
			{
				method,
				headers: {
					host: url.host,
					"content-type": "application/json",
					...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }),
					authorization: `Bearer ${token}`,
					...(idem ? { "idempotency-key": idem } : {}),
					...(scope ? { "x-router-capability-scope": scope } : {}),
				},
			},
			(response: IncomingMessage) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					try {
						resolve({
							status: response.statusCode ?? 0,
							body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>,
						});
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

describe.skipIf(!pgUp)("Router V1 phase four", () => {
	vi.setConfig({ testTimeout: 60000 });
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let keys: ApiKeyStore;
	let runtime: RouterRuntime;
	let server: Server;
	let base: string;
	let token: string;
	let dualToken: string;
	let mcpServer: Server;
	let mcpId: string;
	let clockSkew = 0;
	let expireDuringHandshake = false;
	const wireCalls: { authorization: unknown; args: unknown }[] = [];
	let sessions: ControlledSession[];
	let baselineDir: string;
	let piBackend: CodingAgentPiSessionBackend | undefined;

	beforeAll(async () => {
		const admin = new PostgresClient({ url: ADMIN_URL, connectTimeoutSeconds: 3 });
		try {
			await admin.run(`drop database if exists ${DATABASE} with (force)`);
			await admin.run(`create database ${DATABASE}`);
		} finally {
			await admin.close();
		}
		client = new PostgresClient({ url: databaseUrl(), connectTimeoutSeconds: 5, max: 4 });
		baselineDir = mkdtempSync(join(tmpdir(), "router-phase4-"));
		for (const file of readdirSync(MIGRATIONS_DIR)
			.filter((file) => file.endsWith(".sql"))
			.sort())
			symlinkSync(join(MIGRATIONS_DIR, file), join(baselineDir, file));
		await runMigrations(client, { migrationsDir: baselineDir });
		repos = createPublishingRepositories(client);
		await client.run("insert into tenants(id,name,status) values ($1,'phase4','active')", tenantId);
		keys = new ApiKeyStore(client, tenantId, masterKey);
		const created = await keys.create("router-phase4");
		const dual = await keys.create("router-phase4-dual");
		dualToken = dual.token;
		token = created.token;
		mcpServer = createServer(async (req, res) => {
			const bytes: Buffer[] = [];
			for await (const chunk of req) bytes.push(Buffer.from(chunk));
			if (!bytes.length) {
				res.writeHead(405).end();
				return;
			}
			const request = JSON.parse(Buffer.concat(bytes).toString("utf8"));
			if (request.id === undefined) {
				res.writeHead(202).end();
				return;
			}
			let reply: Record<string, unknown>;
			if (request.method === "initialize") {
				if (expireDuringHandshake) clockSkew = 1_800_001;
				reply = {
					result: {
						protocolVersion: request.params.protocolVersion,
						capabilities: { tools: {} },
						serverInfo: { name: "router-fixture", version: "1" },
					},
				};
			} else if (request.method === "tools/call") {
				wireCalls.push({ authorization: req.headers.authorization, args: request.params.arguments });
				reply =
					request.params.arguments.query === "tool failure"
						? { error: { code: -32000, message: "controlled tool failure" } }
						: { result: { content: [{ type: "text", text: "mcp tool result" }] } };
			} else reply = { result: { tools: [] } };
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply }),
			);
		});
		await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
		const mcpServerId = newMcpServerId();
		mcpId = `mcp_${mcpServerId}`;
		const endpoint = `http://127.0.0.1:${(mcpServer.address() as { port: number }).port}/mcp`;
		const scopeTenant = tenantId as TenantId;
		const bindings = [
			{ mcpServerId: mcpId, toolName: "lookup", parameter: "authToken", credentialId: "tool_credential" },
		];
		const inputSchema = {
			type: "object",
			properties: { query: { type: "string" }, authToken: { type: "string" } },
			required: ["query", "authToken"],
		};
		await repos.mcpServers.create({
			server: {
				mcpServerId,
				tenantId: scopeTenant,
				name: "router-fixture",
				status: "enabled",
				currentRevision: 1,
				lastTestOk: null,
				lastTestLatencyMs: null,
				lastTestAt: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			revision: {
				mcpServerId,
				tenantId: scopeTenant,
				revision: 1,
				transport: "streamable_http",
				endpoint,
				authentication: "bearer",
				sensitiveBindings: bindings,
				createdAt: new Date(),
			},
			tools: [
				{
					mcpServerId,
					tenantId: scopeTenant,
					mcpToolId: newMcpToolId(),
					mcpRevision: 1,
					name: "lookup",
					description: null,
					inputSchema,
					inputSchemaHash: sha256Hex(canonicalJson(inputSchema)),
					sensitiveBindings: bindings,
					createdAt: new Date(),
				},
				{
					mcpServerId,
					tenantId: scopeTenant,
					mcpToolId: newMcpToolId(),
					mcpRevision: 1,
					name: "catalog_only",
					description: null,
					inputSchema,
					inputSchemaHash: sha256Hex(canonicalJson(inputSchema)),
					sensitiveBindings: [],
					createdAt: new Date(),
				},
			],
		});
		const secretBox = new McpSecretBox(masterKey);
		await repos.mcpSecrets.put({
			secretId: newMcpSecretId(), tenantId: scopeTenant, mcpServerId,
			...secretBox.seal(scopeTenant, mcpServerId, "fixture-connection-value"),
		});
		await saveDirectCapabilities({
			client,
			repos,
			tenantId,
			keyId: created.record.keyId,
			expectedRevision: 0,
			scope: "router",
			capabilities: {
				model: { provider: "test", model_id: "test-model", parameters: {} },
				mcp_servers: [{ server_id: mcpId, revision: 1, authentication: "bearer", tool_allowlist: ["lookup"] }],
				skills: [],
				execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
			},
		});
		await saveDirectCapabilities({
			client,
			repos,
			tenantId,
			keyId: dual.record.keyId,
			expectedRevision: 0,
			scope: "dual",
			capabilities: {
				model: { provider: "test", model_id: "test-model", parameters: {} },
				mcp_servers: [],
				skills: [],
				execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
			},
		});
		sessions = [];
		const adapter = createPiRuntimeAdapter({
			createMcpTools: createMcpRuntimeToolFactory({
				repositories: repos,
				secretBox,
				protectTool,
				networkPolicy: { allowHttp: true, allowPrivateNetwork: true },
			}),
			createSession: async (options: RuntimeSessionOptions) => {
				if (options.model.provider === "faux" || options.model.provider === "sandbox-local-model") {
					if (!piBackend) throw new Error("Pi fixture backend was not configured");
					return piBackend.createSession({
						...options,
						ephemeral: true,
						resourceOverrides: { systemPrompt: options.systemPrompt },
					});
				}
				const index = sessions.length;
				const completion: Completion =
					index === 2
						? { text: "partial-before-failure", status: "error" }
						: { text: `ok:${index + 1}`, status: "complete" };
				const session = new ControlledSession(options.id, completion, options.customTools);
				sessions.push(session);
				return session;
			},
		});
		const sandboxConfig: SandboxConfig | undefined = SANDBOX_RUNTIME
			? { runtimeDir: SANDBOX_RUNTIME, workspaceDir: join(baselineDir, "sandbox-workspaces") }
			: undefined;
		runtime = new RouterRuntime({
			client,
			tenantId,
			keys,
			idempotency: new IdempotencyKeyring({ masterKey }),
			adapter,
			sandboxConfig,
			repos,
			masterKey,
			workerInstanceId: `test-worker-${process.pid}`,
			now: () => Date.now() + clockSkew,
			onError: (error) => console.error(error),
		});
		const handler = runtime.http();
		const adminHandler = createApiKeyHttp({ keys, isAdmin: (request) => request.headers.authorization === `Bearer ${ADMIN_TOKEN}`,
			routerAdmin: createRouterAdmin({ client, tenantId, repos, router: runtime, sandboxConfig, listModels: async () => [MODEL] }) });
		server = createServer((request, response) => {
			void Promise.resolve(handler(request, response)).then(async (handled: boolean) => {
				if (!handled && request.url?.startsWith("/api/admin/")) handled = await adminHandler(request, response);
				if (!handled) {
					response.statusCode = 404;
					response.end();
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});

	afterAll(async () => {
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (mcpServer) await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
		if (runtime) await runtime.close();
		if (client) await client.close();
		rmSync(baselineDir, { recursive: true, force: true });
		const admin = new PostgresClient({ url: ADMIN_URL, connectTimeoutSeconds: 3 });
		try {
			await admin.run(`drop database if exists ${DATABASE} with (force)`);
		} finally {
			await admin.close();
		}
	});

	async function waitForOperation(id: string, timeoutMs = 15000): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await runtime.tick();
			const [row] = await client.run(
				"select state,result,error_code,usage_complete,started_at from router_operations where tenant_id=$1 and id=$2",
				tenantId,
				id,
			);
			if (row && !["queued", "running"].includes(String(row.state))) return row;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`operation ${id} did not finish`);
	}

	function sandboxWorkspace(taskId: string): string {
		const directory = createHash("sha256").update(JSON.stringify([tenantId, taskId])).digest("hex");
		return join(baselineDir, "sandbox-workspaces", directory);
	}

	async function startFauxSandbox(name: string) {
		const agentDir = join(baselineDir, name);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false,
		});
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		modelRuntime.registerNativeProvider(faux.provider);
		const services = await createAgentSessionServices({ cwd: baselineDir, agentDir, modelRuntime });
		piBackend = await CodingAgentPiSessionBackend.create({ cwd: baselineDir, agentDir, services });
		return faux;
	}

	test("Sandbox administration is authenticated and filters execution data server-side", async () => {
		const adminBase = "/api/admin/v1/aaas/keys/sandbox";
		for (const endpoint of ["environment", "statistics"]) {
			expect(await call(base, "GET", `${adminBase}/${endpoint}`, dualToken)).toMatchObject({ status: 401 });
		}
		expect(await call(base, "GET", `${adminBase}/statistics?hours=2`, ADMIN_TOKEN)).toMatchObject({ status: 400 });
		const emptyStats = await call(base, "GET", `${adminBase}/statistics?hours=720`, ADMIN_TOKEN);
		expect(emptyStats).toMatchObject({
			status: 200, body: { data: { total: 0, successRate: null, averageMs: null, p95Ms: null, recent: [] } },
		});
		const days = (emptyStats.body.data as AdminSandboxStatistics).trend!;
		expect(days.length).toBeGreaterThanOrEqual(30);
		expect(days.length).toBeLessThanOrEqual(31);
		expect(days.every(({ count, startAt }) =>
			count === 0 && new Date(startAt).getUTCHours() === 16,
		)).toBe(true);
		const environment = await call(base, "GET", `${adminBase}/environment`, ADMIN_TOKEN);
		expect(environment).toMatchObject({ status: 200, body: { data: { provider: "Bubblewrap", available: Boolean(SANDBOX_RUNTIME) } } });
		if (SANDBOX_RUNTIME) {
			expect(environment.body.data).toMatchObject({
				runtimeDir: realpathSync(SANDBOX_RUNTIME),
				runtimeReadOnly: true,
				workspaceDir: join(baselineDir, "sandbox-workspaces"),
				network: "isolated",
				runtimes: expect.arrayContaining([
					{ name: "Bash", version: expect.any(String), path: "/usr/bin/bash" },
					{ name: "Python", version: "3.12.3", path: "/usr/bin/python3" },
					{ name: "Node.js", version: "v22.23.2", path: "/usr/bin/node" },
				]),
			});
			expect((environment.body.data as { pythonPackages: { name: string; version: string; location: string }[] }).pythonPackages)
				.toContainEqual({ name: "pillow", version: "10.2.0", location: "/usr/lib/python3/dist-packages" });
			expect(readdirSync(join(baselineDir, "sandbox-workspaces"))).toEqual([]);
		}
	});

	test("six routes: native history, real MCP, failure Usage, idempotency and paginated events", async () => {
		const credentials = {
			servers: {
				[mcpId]: { tool_credential: "fixture-tool-value" },
			},
		};
		const firstInput = { prompt: "first goal", mcp_servers: [] };
		const created = await call(base, "POST", "/api/aaas/v1/tasks", token, firstInput, "idem-1");
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const data = created.body.data as { task_id: string; operation_id: string; ordinal: number };
		expect(data.ordinal).toBe(1);
		expect((await waitForOperation(data.operation_id)).state).toBe("completed");
		const first = operationViewSchema.parse(
			(await call(base, "GET", `/api/aaas/v1/operations/${data.operation_id}`, token)).body.data,
		);
		expect(first).toMatchObject({
			input: "first goal",
			result: "ok:1",
			usage: { complete: false, total_tokens: null },
		});
		const replay = await call(base, "POST", "/api/aaas/v1/tasks", token, firstInput, "idem-1");
		expect(replay).toMatchObject({
			status: 201,
			body: { data: { duplicate: true, operation_id: data.operation_id } },
		});
		expect(
			(await call(base, "POST", "/api/aaas/v1/tasks", token, { ...firstInput, prompt: "different" }, "idem-1"))
				.status,
		).toBe(409);
		const inputsPath = `/api/aaas/v1/tasks/${data.task_id}/inputs`;
		const second = await call(base, "POST", inputsPath, token, { input: "tool new goal", credentials }, "idem-2");
		expect(second.status, JSON.stringify(second.body)).toBe(202);
		const secondOp = (second.body.data as { operation_id: string }).operation_id;
		expect(await waitForOperation(secondOp)).toMatchObject({ state: "completed", result: "tool summarized" });
		expect(sessions[1].prompts[0]).toMatchObject({
			text: "tool new goal",
			transcript: [
				{ role: "user", content: [{ text: "first goal" }] },
				{ role: "assistant", content: [{ text: "ok:1" }] },
			],
		});
		expect(JSON.stringify(sessions[1].tools.find((tool) => tool.name === "lookup")?.parameters)).not.toContain(
			"authToken",
		);
		expect(wireCalls[0]).toEqual({
			authorization: "Bearer fixture-connection-value",
			args: { query: "tool new goal", authToken: "fixture-tool-value" },
		});
		const third = await call(base, "POST", inputsPath, token, { input: "tool failure", credentials }, "idem-3");
		const thirdOp = (third.body.data as { operation_id: string }).operation_id;
		expect((await waitForOperation(thirdOp)).state).toBe("failed");
		const failed = operationViewSchema.parse(
			(await call(base, "GET", `/api/aaas/v1/operations/${thirdOp}`, token)).body.data,
		);
		expect(failed.usage).toMatchObject({ complete: false, total_tokens: 6 });
		const partial = await client.run(
			"select payload from router_task_events where operation_id=$1 and event_type='assistant.message' and not public_visible",
			thirdOp,
		);
		expect(partial).toEqual([{ payload: { text: "partial-before-failure" } }]);
		const audits = await client.run(
			"select router_operation_id,outcome from mcp_call_audits where tenant_id=$1 order by created_at",
			tenantId,
		);
		expect(audits).toEqual([
			{ router_operation_id: secondOp, outcome: "success" },
			{ router_operation_id: thirdOp, outcome: "error" },
		]);
		const traces = await client.run(
			"select call_index,completed_at from orchestration_llm_calls where tenant_id=$1 and router_operation_id=$2",
			tenantId,
			thirdOp,
		);
		expect(traces).toEqual([{ call_index: 1, completed_at: expect.any(Date) }]);
		const fourth = await call(base, "POST", inputsPath, token, { input: "fourth goal", mcp_servers: [] }, "idem-4");
		const fourthOp = (fourth.body.data as { operation_id: string }).operation_id;
		expect((await waitForOperation(fourthOp)).state).toBe("completed");
		expect(sessions[3].prompts[0].transcript).toEqual([
			{ role: "user", content: [{ type: "text", text: "first goal" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok:1" }] },
			{ role: "user", content: [{ type: "text", text: "tool new goal" }] },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", toolCallId: "fixture-tool", toolName: "lookup", input: { query: "tool new goal" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "fixture-tool",
				toolName: "lookup",
				isError: false,
				content: [{ type: "text", text: expect.stringContaining("mcp tool result") }],
			},
			{ role: "assistant", content: [{ type: "text", text: "tool summarized" }] },
			{ role: "user", content: [{ type: "text", text: "tool failure" }] },
			{ role: "assistant", content: [{ type: "text", text: "前序执行失败，其部分输出未提交到 Context。" }] },
		]);
		expect(sessions[3].prompts[0].text).toBe("fourth goal");
		const eventsPath = `/api/aaas/v1/tasks/${data.task_id}/events`;
		const firstPage = taskEventsResponseSchema.parse(
			(await call(base, "GET", `${eventsPath}?limit=2`, token)).body.data,
		);
		expect(firstPage).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
		const rest = taskEventsResponseSchema.parse(
			(await call(base, "GET", `${eventsPath}?after=${firstPage.next_cursor}`, token)).body.data,
		);
		expect(rest.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "operation.progress",
					payload: expect.objectContaining({ stage: "tools", tools_completed: 1 }),
				}),
				expect.objectContaining({
					type: "operation.failed",
					operation_id: thirdOp,
					payload: { error: { code: "EXECUTION_FAILED" } },
				}),
			]),
		);
		expect(JSON.stringify(rest)).not.toMatch(/fixture-tool-value|authToken|partial-before-failure/);
		const view = taskViewSchema.parse(
			(await call(base, "GET", `/api/aaas/v1/tasks/${data.task_id}`, token)).body.data,
		);
		expect(view.usage).toEqual({
			complete: false,
			known_totals: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
			unknown_operations: 3,
		});
		const principal = await keys.authenticate(`Bearer ${token}`);
		const dual = await keys.authenticate(`Bearer ${dualToken}`);
		const adminRoot = `/api/admin/v1/aaas/keys/${principal.keyId}/router`;
		const taskRoot = `${adminRoot}/tasks/${data.task_id}`;
		expect((await call(base, "GET", taskRoot, token)).status).toBe(401);
		expect((await call(base, "GET", `/api/admin/v1/aaas/keys/${dual.keyId}/router/tasks/${data.task_id}`, ADMIN_TOKEN)).status).toBe(404);
		const foreignTenant = randomUUID();
		await client.run("insert into tenants(id,name,status) values ($1,'router-admin-foreign','active')", foreignTenant);
		const foreignKey = await new ApiKeyStore(client, foreignTenant, masterKey).create("Foreign Key");
		const executionList = "/api/admin/v1/aaas/keys/router-executions";
		expect((await call(base, "GET", executionList, token)).status).toBe(401);
		expect(await call(base, "GET", `${executionList}?q=${data.task_id}&status=failed`, ADMIN_TOKEN)).toMatchObject({
			status: 200,
			body: { data: { items: [{ id: thirdOp, task_id: data.task_id, status: "failed", key_id: principal.keyId }], next_cursor: null } },
		});
		expect(await call(base, "GET", `${executionList}?key_id=${principal.keyId}&q=${secondOp}`, ADMIN_TOKEN)).toMatchObject({
			status: 200,
			body: { data: { items: [{ id: secondOp }], usage: view.usage } },
		});
		expect(await call(base, "GET", `${executionList}?key_id=${dual.keyId}&q=${data.task_id}`, ADMIN_TOKEN))
			.toMatchObject({ status: 200, body: { data: { items: [] } } });
		expect(await call(base, "GET", `${executionList}?key_id=${foreignKey.record.keyId}`, ADMIN_TOKEN))
			.toMatchObject({ status: 200, body: { data: { items: [] } } });
		expect((await call(base, "GET", `/api/admin/v1/aaas/keys/${foreignKey.record.keyId}/router`, ADMIN_TOKEN)).status).toBe(404);
		expect(await call(base, "GET", `${adminRoot}/tasks`, ADMIN_TOKEN)).toMatchObject({ status: 200, body: { data: { tasks: [{ id: data.task_id }] } } });
		// Give each of the four started Operations a known duration, independent of test timing.
		await client.run(
			"update router_operations set ended_at=started_at + interval '1250 milliseconds' where task_id=$1 and started_at is not null",
			data.task_id,
		);
		expect(await call(base, "GET", `${taskRoot}?limit=1`, ADMIN_TOKEN)).toMatchObject({
			status: 200,
			body: { data: {
				usage: view.usage,
				occupancy: null,
				execution_duration_ms: 5000,
				operations: [{ id: data.operation_id }],
			} },
		});
		const adminOperationPath = `${adminRoot}/operations/${thirdOp}`;
		expect(await call(base, "GET", adminOperationPath, ADMIN_TOKEN)).toMatchObject({
			status: 200,
			body: { data: { usage: failed.usage, cache_read: { tokens: null, reported_calls: 0, total_calls: 1 } } },
		});
		const adminHistory = await call(base, "GET", `${taskRoot}/history`, ADMIN_TOKEN);
		expect(adminHistory).toMatchObject({ status: 200, body: { data: { events: expect.arrayContaining([
			expect.objectContaining({ summary: "partial-before-failure", context_committed: false }),
			expect.objectContaining({ type: "tool.result", summary: "lookup", context_committed: true }),
		]) } } });
		expect(JSON.stringify(adminHistory.body)).not.toMatch(/fixture-tool-value|authToken|mcp tool result/);
		const trajectoryPath = `${adminRoot}/operations/${thirdOp}/trajectory`;
		expect((await call(base, "GET", trajectoryPath, token)).status).toBe(401);
		expect((await call(base, "GET", `/api/admin/v1/aaas/keys/${dual.keyId}/router/operations/${thirdOp}/trajectory`, ADMIN_TOKEN)).status).toBe(404);
		expect((await call(base, "GET", `/api/admin/v1/aaas/keys/${foreignKey.record.keyId}/router/operations/${thirdOp}/trajectory`, ADMIN_TOKEN)).status).toBe(404);
		expect(await call(base, "GET", `${adminRoot}/operations/${data.operation_id}/trajectory`, ADMIN_TOKEN))
			.toMatchObject({ status: 200, body: { data: { entries: [], next_cursor: null } } });
		const tracePage = await call(base, "GET", `${trajectoryPath}?limit=1`, ADMIN_TOKEN);
		expect(tracePage).toMatchObject({ status: 200, body: { data: {
			entries: [{ kind: "model", call_index: 1, name: "test/test-model", outcome: "response_recorded", duration_ms: expect.any(Number) }],
			next_cursor: expect.stringMatching(/^model:/),
		} } });
		const { next_cursor } = tracePage.body.data as { next_cursor: string };
		const toolTrace = await call(base, "GET", `${trajectoryPath}?limit=1&after=${encodeURIComponent(next_cursor)}`, ADMIN_TOKEN);
		expect(toolTrace).toMatchObject({ status: 200, body: { data: {
			entries: [{ kind: "mcp", name: "lookup", outcome: "error", mcp_revision: 1, duration_ms: expect.any(Number) }],
			next_cursor: null,
		} } });
		expect(JSON.stringify([tracePage.body, toolTrace.body])).not.toMatch(
			/request_payload|response_payload|fixture-internal-trace-prompt|fixture-tool-value|authToken|mcp tool result/,
		);
		// Existing persisted responses can supply cache data independently of the Operation usage row.
		await client.run(
			`update orchestration_llm_calls set response_payload=jsonb_set(
				response_payload, '{usage}', '{"cacheRead":0,"cacheReadReported":true}'::jsonb)
			where tenant_id=$1 and router_operation_id=$2`,
			tenantId,
			thirdOp,
		);
		expect(await call(base, "GET", adminOperationPath, ADMIN_TOKEN)).toMatchObject({
			status: 200,
			body: { data: { cache_read: { tokens: 0, reported_calls: 1, total_calls: 1 } } },
		});
		await client.run(
			`insert into orchestration_llm_calls(tenant_id,router_operation_id,call_index,model_provider,model_id,request_payload)
			select tenant_id,router_operation_id,2,model_provider,model_id,request_payload from orchestration_llm_calls
			where tenant_id=$1 and router_operation_id=$2 and call_index=1`,
			tenantId,
			thirdOp,
		);
		await client.run(
			`update orchestration_llm_calls set response_payload=jsonb_set(
				response_payload, '{usage}', '{"cacheRead":6400}'::jsonb)
			where tenant_id=$1 and router_operation_id=$2 and call_index=1`,
			tenantId,
			thirdOp,
		);
		expect(await call(base, "GET", adminOperationPath, ADMIN_TOKEN)).toMatchObject({
			status: 200,
			body: { data: { cache_read: { tokens: 6400, reported_calls: 1, total_calls: 2 } } },
		});
		expect((await call(base, "GET", `/api/aaas/v1/operations/${thirdOp}`, token)).body.data).not.toHaveProperty("cache_read");
		const report = async () => {
			const now = Date.now();
			const view = await repos.events.summarizeRouterUsageView?.({
				scope: { tenantId: tenantId as TenantId },
				from: new Date(now - 86_400_000),
				to: new Date(now + 86_400_000),
			});
			expect(view).toBeDefined();
			return view!;
		};
		const updateReportedCache = (usage: Record<string, number | boolean>) => client.run(
			`update orchestration_llm_calls set response_payload=jsonb_set(coalesce(response_payload, '{}'::jsonb), '{usage}', $3::text::jsonb)
			where tenant_id=$1 and router_operation_id=$2 and call_index=1`,
			tenantId, secondOp, JSON.stringify(usage),
		);
		const beforeCache = await report();
		expect(beforeCache.runs.find((row) => row.id === secondOp)).toMatchObject({
			tokenCoverage: "complete", cacheHitTokens: null, cacheReportedCalls: 0, cacheUnknownCalls: 1,
		});
		await updateReportedCache({ input: 4, cacheRead: 0, cacheWrite: 0, cacheReadReported: true });
		expect((await report()).runs.find((row) => row.id === secondOp)).toMatchObject({
			cacheHitTokens: 0, cacheMissTokens: 4, cacheHitRate: 0, cacheReportedCalls: 1,
		});
		await updateReportedCache({ input: 1, cacheRead: 2, cacheWrite: 1 });
		const modelUsage = await call(base, "GET", `${adminRoot}/operations/${secondOp}/trajectory?kind=model`, ADMIN_TOKEN);
		expect(modelUsage).toMatchObject({
			status: 200,
			body: { data: { entries: [{ kind: "model", call_index: 1, input_tokens: 1, cache_read_tokens: 2, cache_write_tokens: 1 }], next_cursor: null } },
		});
		const afterCache = await report();
		expect(afterCache.runs.find((row) => row.id === secondOp)).toMatchObject({
			cacheHitTokens: 2, cacheMissTokens: 2, cachePromptTokens: 4, cacheHitRate: 0.5, accurateLlmCallCount: 1,
		});
		expect(afterCache.coverage).toMatchObject({ cacheHitTokens: 2, cacheMissTokens: 2, cacheReportedCalls: 1 });
		expect(afterCache.byDay).toEqual(expect.arrayContaining([expect.objectContaining({ cacheHitTokens: 2, cacheHitRate: 0.5 })]));
		expect(afterCache.byModel).toEqual(expect.arrayContaining([expect.objectContaining({ cacheHitTokens: 2, cacheHitRate: 0.5 })]));
		expect(afterCache.byGroup).toEqual(expect.arrayContaining([expect.objectContaining({ cacheHitTokens: 2, cacheHitRate: 0.5 })]));
		expect(afterCache.runs.find((row) => row.id === thirdOp)).toMatchObject({ cacheHitTokens: null });
	});

	test("Router Key allowlists reach Pi model requests and dispatch", async () => {
		const cwd = baselineDir;
		const agentDir = join(cwd, "pi-tool-allowlist");
		writeFileSync(join(cwd, "tool-allowlist.txt"), "readable test fixture");
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		modelRuntime.registerNativeProvider(faux.provider);
		const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime });
		piBackend = await CodingAgentPiSessionBackend.create({ cwd, agentDir, services });

		const key = await keys.create("router-pi-tool-allowlist");
		await saveDirectCapabilities({
			client,
			repos,
			tenantId,
			keyId: key.record.keyId,
			expectedRevision: 0,
			scope: "router",
			capabilities: {
				model: { provider: "faux", model_id: "faux-1", parameters: {} },
				mcp_servers: [{ server_id: mcpId, revision: 1, authentication: "bearer", tool_allowlist: ["lookup"] }],
				skills: [],
				execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
			},
		});

		const callsBefore = wireCalls.length;
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path: "tool-allowlist.txt" }),
					fauxToolCall("catalog_only", { query: "unlisted" }),
					fauxToolCall("lookup", { query: "authorized" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("with MCP"),
			fauxAssistantMessage(fauxToolCall("lookup", { query: "no longer granted" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("without MCP"),
		]);

		const created = await call(
			base,
			"POST",
			"/api/aaas/v1/tasks",
			key.token,
			{
				prompt: "Use the configured tools",
				credentials: { servers: { [mcpId]: { tool_credential: "fixture-tool-value" } } },
			},
			"pi-allowlist-with-mcp",
		);
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const { task_id, operation_id } = created.body.data as { task_id: string; operation_id: string };
		expect(await waitForOperation(operation_id)).toMatchObject({ state: "completed", result: "with MCP" });

		const appended = await call(
			base,
			"POST",
			`/api/aaas/v1/tasks/${task_id}/inputs`,
			key.token,
			{
				input: "Answer without tools",
				mcp_servers: [],
			},
			"pi-allowlist-without-mcp",
		);
		expect(appended.status, JSON.stringify(appended.body)).toBe(202);
		const noMcpOperationId = (appended.body.data as { operation_id: string }).operation_id;
		expect(await waitForOperation(noMcpOperationId)).toMatchObject({ state: "completed", result: "without MCP" });

		const traces = await client.run(
			`select router_operation_id, request_payload from orchestration_llm_calls
			where tenant_id=$1 and router_operation_id in ($2,$3) order by call_index`,
			tenantId,
			operation_id,
			noMcpOperationId,
		);
		const withMcp = traces.filter((trace) => trace.router_operation_id === operation_id);
		expect(withMcp).toHaveLength(2);
		for (const { request_payload } of withMcp) {
			const { tools } = request_payload as Context;
			expect(tools?.map((tool) => tool.name).sort()).toEqual(["lookup", mcpResourceToolName(mcpId)].sort());
			expect(tools?.find((tool) => tool.name === "lookup")?.parameters).toMatchObject({
				properties: { query: { type: "string" } },
				required: ["query"],
			});
			expect(JSON.stringify(tools)).not.toContain("authToken");
		}
		const results = (withMcp[1].request_payload as Context).messages.filter(
			(message) => message.role === "toolResult",
		);
		expect(results.map(({ toolName, isError }) => ({ toolName, isError }))).toEqual(
			expect.arrayContaining([
				{ toolName: "read", isError: true },
				{ toolName: "catalog_only", isError: true },
				{ toolName: "lookup", isError: false },
			]),
		);
		const withoutMcp = traces.filter((trace) => trace.router_operation_id === noMcpOperationId);
		expect(withoutMcp).toHaveLength(2);
		for (const { request_payload } of withoutMcp) {
			expect((request_payload as Context).tools ?? []).toEqual([]);
		}
		expect((withoutMcp[1].request_payload as Context).messages.at(-1)).toMatchObject({
			role: "toolResult",
			toolName: "lookup",
			isError: true,
			content: [{ type: "text", text: "Tool lookup not found" }],
		});
		expect(wireCalls.slice(callsBefore)).toEqual([
			{
				authorization: "Bearer fixture-connection-value",
				args: { query: "authorized", authToken: "fixture-tool-value" },
			},
		]);
	});

	test.runIf(Boolean(SANDBOX_RUNTIME))("Sandbox Bash is frozen on acceptance and preserves files across Operations", async () => {
		const faux = await startFauxSandbox("sandbox-faux-agent");

		const key = await keys.create("router-sandbox-faux");
		const saveGrant = (expectedRevision: number, local_tools: "bash"[]) => saveDirectCapabilities({
			client, repos, tenantId, keyId: key.record.keyId, expectedRevision, scope: "router",
			capabilities: {
				model: { provider: "faux", model_id: "faux-1", parameters: {} },
				local_tools, mcp_servers: [], skills: [],
				execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
			},
		});
		await saveGrant(0, ["bash"]);
		expect((await call(base, "POST", "/api/aaas/v1/tasks", key.token, {
			prompt: "override", local_tools: [], sandbox: false,
		}, "sandbox-invalid-override")).status).toBe(400);
		const pending = await call(base, "POST", "/api/aaas/v1/tasks", key.token, {
			prompt: "create fixture", mcp_servers: [],
		}, "sandbox-frozen-one");
		expect(pending.status).toBe(201);
		const { task_id, operation_id } = pending.body.data as { task_id: string; operation_id: string };
		await saveGrant(1, []);
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("read", { path: "tool-allowlist.txt" }),
				fauxToolCall("bash", { command: "DEMO_TOKEN='fixture-bash-secret'; printf 77 > result.txt; cat result.txt" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("77"),
		]);
		expect(await waitForOperation(operation_id)).toMatchObject({ state: "completed", result: "77" });
		const [trace] = await client.run(
			"select request_payload from orchestration_llm_calls where router_operation_id=$1 order by call_index asc limit 1",
			operation_id,
		);
		expect((trace.request_payload as Context).tools?.map((tool) => tool.name)).toEqual(["bash"]);
		const historyPath = `/api/admin/v1/aaas/keys/${key.record.keyId}/router/tasks/${task_id}/history`;
		const history = await call(base, "GET", historyPath, ADMIN_TOKEN);
		expect(history.body).toMatchObject({ data: { events: expect.arrayContaining([
			expect.objectContaining({ type: "tool.result", local_result: { provider: "linux-bwrap", is_error: false, output: "77" } }),
		]) } });

		const trajectoryPath = `/api/admin/v1/aaas/keys/${key.record.keyId}/router/operations/${operation_id}/trajectory`;
		expect(await call(base, "GET", trajectoryPath, key.token)).toMatchObject({ status: 401 });
		const trajectory = await call(base, "GET", trajectoryPath, ADMIN_TOKEN);
		const { entries } = trajectory.body.data as { entries: { id: string; kind: string }[] };
		const local = entries.filter(({ kind }) => kind === "bash");
		expect(local).toMatchObject([{
			name: "bash", outcome: "success", bash: {
				command: "DEMO_TOKEN=[REDACTED]; printf 77 > result.txt; cat result.txt", output: "77",
			},
		}]);
		const afterBash = await call(base, "GET", `${trajectoryPath}?after=${encodeURIComponent(local[0].id)}`, ADMIN_TOKEN);
		expect(afterBash).toMatchObject({ status: 200, body: { data: { entries: [{ kind: "model" }] } } });
		const modelsOnly = await call(base, "GET", `${trajectoryPath}?kind=model`, ADMIN_TOKEN);
		expect((modelsOnly.body.data as { entries: { kind: string }[] }).entries.map(({ kind }) => kind)).toEqual(["model", "model"]);

		const inputs = `/api/aaas/v1/tasks/${task_id}/inputs`;
		const afterRevocation = await call(base, "POST", inputs, key.token, { input: "do not use Bash" }, "sandbox-revoked");
		expect(afterRevocation.status).toBe(202);
		const revokedId = (afterRevocation.body.data as { operation_id: string }).operation_id;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf 0 > result.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("no grant"),
		]);
		expect(await waitForOperation(revokedId)).toMatchObject({ state: "completed", result: "no grant" });
		const revokedTraces = await client.run(
			"select request_payload from orchestration_llm_calls where router_operation_id=$1 order by call_index",
			revokedId,
		);
		expect(revokedTraces).toHaveLength(2);
		expect((revokedTraces[0].request_payload as Context).tools ?? []).toEqual([]);
		expect((revokedTraces[1].request_payload as Context).messages.at(-1)).toMatchObject({
			role: "toolResult", isError: true, content: [{ type: "text", text: "Tool bash not found" }],
		});

		await saveGrant(2, ["bash"]);
		const continued = await call(base, "POST", inputs, key.token, { input: "read fixture" }, "sandbox-continued");
		expect(continued.status).toBe(202);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "cat result.txt" }), { stopReason: "toolUse" }),
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "77" }], isError: false });
				return fauxAssistantMessage("file retained");
			},
		]);
		expect(await waitForOperation((continued.body.data as { operation_id: string }).operation_id)).toMatchObject({
			state: "completed", result: "file retained",
		});

		const running = await call(base, "POST", inputs, key.token, { input: "wait for cancellation" }, "sandbox-cancel");
		expect(running.status).toBe(202);
		const runningId = (running.body.data as { operation_id: string }).operation_id;
		faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", {
			command: "(sleep 2; touch cancel-survived) & touch cancel-started; wait",
		}), { stopReason: "toolUse" })]);
		await runtime.tick();
		const workspace = sandboxWorkspace(task_id);
		await vi.waitFor(() => expect(existsSync(join(workspace, "cancel-started"))).toBe(true));
		const canceled = await call(base, "POST", `/api/aaas/v1/tasks/${task_id}/cancel`, key.token, { reason: "fixture" });
		expect(canceled.status).toBe(200);
		expect(await waitForOperation(runningId)).toMatchObject({ state: "canceled", error_code: null });
		const [occupancy] = await client.run("select holds_task_occupancy from router_operations where id=$1", runningId);
		expect(occupancy.holds_task_occupancy).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		expect(existsSync(join(workspace, "cancel-survived"))).toBe(false);
	});

	test.runIf(Boolean(SANDBOX_RUNTIME))("Router HTTP runs independent Python and Node bwrap children concurrently", async () => {
		const statistics = async (hours = 24) => {
			const response = await call(base, "GET", `/api/admin/v1/aaas/keys/sandbox/statistics?hours=${hours}`, ADMIN_TOKEN);
			expect(response.status, JSON.stringify(response.body)).toBe(200);
			return response.body.data as AdminSandboxStatistics;
		};
		const before = await statistics();
		const faux = await startFauxSandbox("sandbox-concurrent-agent");
		const key = await keys.create("router-sandbox-concurrent");
		await saveDirectCapabilities({
			client, repos, tenantId, keyId: key.record.keyId, expectedRevision: 0, scope: "router",
			capabilities: {
				model: { provider: "faux", model_id: "faux-1", parameters: {} },
				local_tools: ["bash"], mcp_servers: [], skills: [],
				execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
			},
		});
		const commands = {
			python: `python3 -c 'import json, os, pathlib; from PIL import Image; pathlib.Path("observed").write_text(json.dumps(dict(pid=os.readlink("/proc/self/ns/pid"), net=os.readlink("/proc/self/ns/net"), python=os.stat("/usr/bin/python3").st_ino, node=os.stat("/usr/bin/node").st_ino)))'`,
			node: `node -e 'const fs = require("node:fs"); fs.writeFileSync("observed", JSON.stringify({pid: fs.readlinkSync("/proc/self/ns/pid"), net: fs.readlinkSync("/proc/self/ns/net"), python: fs.statSync("/usr/bin/python3").ino, node: fs.statSync("/usr/bin/node").ino}));'`,
		};
		const command = (name: keyof typeof commands, peer: keyof typeof commands) => [
			"set -e",
			`printf private > ${name}.private`,
			commands[name],
			"while ! test -f verify; do sleep .025; done",
			`test -r ${name}.private`,
			`test ! -e /workspace/${peer}.private`,
			`test ! -e "$(cat peer)/${peer}.private"`,
			`if touch /usr/bin/.sandbox-concurrent-${process.pid} 2>/dev/null; then exit 21; fi`,
			"(sleep 5; touch lingering-child) &",
			"touch verified",
			"while ! test -f release; do sleep .025; done",
		].join("\n");
		const tool = (command: string, timeout?: number) =>
			fauxAssistantMessage(fauxToolCall("bash", { command, timeout }), { stopReason: "toolUse" });
		const launch = async (name: keyof typeof commands) => {
			const accepted = await call(base, "POST", "/api/aaas/v1/tasks", key.token, { prompt: name }, `sandbox-concurrent-${name}`);
			expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
			const { task_id, operation_id } = accepted.body.data as { task_id: string; operation_id: string };
			const workspace = sandboxWorkspace(task_id);
			await runtime.tick();
			await vi.waitFor(() => {
				expect(readFileSync(join(workspace, "observed"), "utf8")).toContain('"pid"');
			}, { timeout: 5_000 });
			return { task_id, operation_id, workspace };
		};
		function bwrapPids(workspace: string): string[] {
			return readdirSync("/proc").filter((pid) => {
				if (!/^\d+$/.test(pid)) return false;
				try {
					const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
					return args[0] === "/usr/bin/bwrap" && args.includes(workspace);
				} catch {
					return false;
				}
			});
		}
		type Observation = { pid: string; net: string; python: number; node: number };
		const readObservation = (workspace: string) =>
			JSON.parse(readFileSync(join(workspace, "observed"), "utf8")) as Observation;

		faux.setResponses([
			tool(command("python", "node")),
			tool(command("node", "python")),
			tool("printf '%s\\n' 'Authorization: Bearer fixture-bash-output-secret' 'fixture-private-output'; exit 7"),
			tool("sleep 3", 0.2),
			fauxAssistantMessage("node complete"),
		]);
		const a = await launch("python");
		const b = await launch("node");
		expect(a.workspace).not.toBe(b.workspace);
		for (const [task, peer] of [[a, b], [b, a]] as const) {
			writeFileSync(join(task.workspace, "peer"), peer.workspace);
			writeFileSync(join(task.workspace, "verify"), "");
		}
		await vi.waitFor(() => {
			for (const task of [a, b]) expect(existsSync(join(task.workspace, "verified"))).toBe(true);
		}, { timeout: 5_000 });
		const observedA = readObservation(a.workspace);
		const observedB = readObservation(b.workspace);
		expect(observedA.pid).not.toBe(observedB.pid);
		expect(observedA.net).not.toBe(observedB.net);
		for (const observed of [observedA, observedB]) {
			expect(observed.pid).not.toBe(readlinkSync("/proc/self/ns/pid"));
			expect(observed.net).not.toBe(readlinkSync("/proc/self/ns/net"));
			expect(observed.python).toBe(statSync(join(SANDBOX_RUNTIME!, "usr/bin/python3")).ino);
			expect(observed.node).toBe(statSync(join(SANDBOX_RUNTIME!, "usr/bin/node")).ino);
		}
		const pidsA = bwrapPids(a.workspace);
		const pidsB = bwrapPids(b.workspace);
		expect(pidsA.length).toBeGreaterThan(0);
		expect(pidsB.length).toBeGreaterThan(0);
		expect(await call(base, "POST", `/api/aaas/v1/tasks/${a.task_id}/cancel`, key.token, {})).toMatchObject({ status: 200 });
		expect(await waitForOperation(a.operation_id)).toMatchObject({ state: "canceled" });
		expect(bwrapPids(a.workspace)).toEqual([]);
		expect(bwrapPids(b.workspace)).toEqual(pidsB);
		writeFileSync(join(b.workspace, "release"), "");
		expect(await waitForOperation(b.operation_id)).toMatchObject({ state: "completed", result: "node complete" });
		expect(bwrapPids(b.workspace)).toEqual([]);
		expect(await client.run("select holds_task_occupancy from router_operations where id in ($1,$2)", a.operation_id, b.operation_id))
			.toEqual([{ holds_task_occupancy: false }, { holds_task_occupancy: false }]);

		const stats = await statistics();
		expect(stats.total - before.total).toBe(4);
		expect(stats.counts).toEqual({
			...before.counts,
			success: before.counts.success + 1,
			command_failed: before.counts.command_failed + 1,
			timeout: before.counts.timeout + 1,
			canceled: before.counts.canceled + 1,
		});
		expect(stats.successRate).toBeCloseTo(stats.counts.success / stats.total);
		expect(stats.trend!.reduce((sum, point) => sum + point.count, 0)).toBe(stats.total);
		expect(Date.parse(stats.trend![1].startAt) - Date.parse(stats.trend![0].startAt)).toBe(3_600_000);
		const durations = stats.recent.map(({ durationMs }) => durationMs).sort((x, y) => x - y);
		expect(durations).toHaveLength(stats.total);
		expect(stats.averageMs).toBe(Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length));
		expect(stats.p95Ms).toBe(durations[Math.ceil(durations.length * 0.95) - 1]);
		const recent = stats.recent.filter(({ operationId }) => [a.operation_id, b.operation_id].includes(operationId));
		expect(recent).toHaveLength(4);
		const canceled = recent.find(({ status }) => status === "canceled")!;
		const success = recent.find(({ status }) => status === "success")!;
		expect(canceled).toMatchObject({ operationId: a.operation_id, taskId: a.task_id, reason: "EXECUTION_ABORTED" });
		expect(success).toMatchObject({ operationId: b.operation_id, taskId: b.task_id, reason: null });
		expect(recent).toEqual(expect.arrayContaining([
			expect.objectContaining({ operationId: b.operation_id, tool: "bash", reason: "EXIT_7", status: "command_failed" }),
			expect.objectContaining({ operationId: b.operation_id, tool: "bash", reason: "EXECUTION_TIMEOUT", status: "timeout" }),
		]));
		expect(Math.min(Date.parse(canceled.endedAt), Date.parse(success.endedAt)))
			.toBeGreaterThan(Math.max(Date.parse(canceled.startedAt), Date.parse(success.startedAt)));
		expect(Date.parse(success.endedAt)).toBeGreaterThan(Date.parse(canceled.endedAt));
		expect(canceled.durationMs).toBeGreaterThan(0);
		expect(success.durationMs).toBeGreaterThan(0);
		expect(JSON.stringify(stats)).not.toContain("lingering-child");
		expect(JSON.stringify(stats)).not.toContain("fixture-private-output");
		expect(JSON.stringify(stats)).not.toContain(a.workspace);
		const nodeTrajectory = await call(base, "GET",
			`/api/admin/v1/aaas/keys/${key.record.keyId}/router/operations/${b.operation_id}/trajectory`, ADMIN_TOKEN);
		const { entries } = nodeTrajectory.body.data as { entries: { kind: string; outcome: string; bash?: { output: string } }[] };
		const bashEntries = entries.filter(({ kind }) => kind === "bash");
		expect(bashEntries.map(({ outcome }) => outcome)).toEqual(["success", "error", "error"]);
		expect(bashEntries[1].bash?.output).toContain("Authorization: Bearer [REDACTED]");
		expect(JSON.stringify(bashEntries)).not.toContain("fixture-bash-output-secret");
		await client.run("update router_task_events set created_at=now() - interval '48 hours' where id=$1", canceled.id);
		const lastDay = await statistics();
		expect(lastDay.total).toBe(stats.total - 1);
		expect(lastDay.trend!.reduce((sum, point) => sum + point.count, 0)).toBe(stats.total - 1);
		expect(lastDay.recent.map(({ id }) => id)).not.toContain(canceled.id);
		const lastWeek = await statistics(168);
		expect(lastWeek.total).toBe(stats.total);
		expect(lastWeek.trend!.reduce((sum, point) => sum + point.count, 0)).toBe(stats.total);
		expect(lastWeek.trend!.filter(({ count }) => count > 0)).toHaveLength(2);
		expect((await statistics(720)).recent.map(({ id }) => id)).toContain(canceled.id);
		console.info(JSON.stringify({
			scenario: "sandbox-concurrent", workspaceIsolation: true, sharedReadOnlyRuntime: true, occupancyReleased: true,
			executions: [
				{ ...canceled, workspace: a.workspace, namespaces: observedA, bwrapPids: pidsA, processesReleased: true },
				{ ...success, workspace: b.workspace, namespaces: observedB, bwrapPids: pidsB, processesReleased: true },
			],
		}));
	}, 25_000);

	test.runIf(Boolean(SANDBOX_RUNTIME && SANDBOX_MODEL_URL))("local model autonomously uses Sandbox Bash for Python and Node over Router HTTP", async () => {
		const baseUrl = new URL(SANDBOX_MODEL_URL!);
		if (baseUrl.protocol !== "http:" || baseUrl.hostname !== "127.0.0.1") throw new Error("Use a loopback model URL");
		const agentDir = join(baselineDir, "sandbox-real-agent");
		mkdirSync(agentDir);
		const modelId = process.env.PI_SANDBOX_TEST_MODEL_ID ?? "Qwen";
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({
			providers: {
				"sandbox-local-model": {
					baseUrl: baseUrl.href, api: "openai-completions", apiKey: "local-test",
					models: [{ id: modelId, reasoning: false }],
				},
			},
		}));
		piBackend = await CodingAgentPiSessionBackend.create({ cwd: baselineDir, agentDir, disableLocalSkills: true });
		const key = await keys.create("router-sandbox-real");
		await saveDirectCapabilities({
			client, repos, tenantId, keyId: key.record.keyId, expectedRevision: 0, scope: "router",
			capabilities: {
				model: { provider: "sandbox-local-model", model_id: modelId, parameters: { temperature: 0, max_tokens: 2048 } },
				local_tools: ["bash"], mcp_servers: [], skills: [],
				execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
			},
		});
		const cases = [
			{
				id: "python", interpreter: "python", expected: "77", file: "python-result.txt",
				prompt: "Use the Bash tool and Python 3 to parse the CSV values 17,24,36 and sum them. In the Task workspace, write that sum to python-result.txt and print the sum from Python. Respond with the actual number printed.",
			},
			{
				id: "node", interpreter: "node", expected: "87", file: "node-result.txt",
				prompt: "Use the Bash tool and Node.js to compute 7*11 + 2*5 in JavaScript. In the Task workspace, write the result to node-result.txt and print it from Node. Respond with the actual number printed.",
			},
		];
		for (const item of cases) {
			const accepted = await call(base, "POST", "/api/aaas/v1/tasks", key.token, {
				prompt: item.prompt, mcp_servers: [],
			}, `sandbox-real-${item.id}`);
			expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
			const { operation_id, task_id } = accepted.body.data as { operation_id: string; task_id: string };
			expect(await waitForOperation(operation_id, 120_000)).toMatchObject({
				state: "completed", result: expect.stringContaining(item.expected),
			});
			const result = await call(base, "GET", `/api/aaas/v1/operations/${operation_id}`, key.token);
			expect(result.body.data).toMatchObject({ status: "completed", result: expect.stringContaining(item.expected) });
			const events = await client.run(
				"select event_type,payload from router_task_events where operation_id=$1 and event_type in ('tool.call','tool.result') order by sequence",
				operation_id,
			);
			expect(events).toEqual(expect.arrayContaining([
				expect.objectContaining({ event_type: "tool.call", payload: expect.objectContaining({
					tool_name: "bash", input: expect.objectContaining({ command: expect.stringContaining(item.interpreter) }),
				}) }),
				expect.objectContaining({ event_type: "tool.result", payload: expect.objectContaining({
					provider: "linux-bwrap", isError: false, content: expect.arrayContaining([
						expect.objectContaining({ text: expect.stringContaining(item.expected) }),
					]),
				}) }),
			]));
			const [record] = await client.run(
				`select o.capability_snapshot,l.request_payload from router_operations o
				join orchestration_llm_calls l on l.router_operation_id=o.id and l.call_index=1 where o.id=$1`,
				operation_id,
			);
			expect(record.capability_snapshot).toMatchObject({ localTools: ["bash"] });
			expect((record.request_payload as Context).tools?.map((tool) => tool.name)).toEqual(["bash"]);
			expect(readFileSync(join(sandboxWorkspace(task_id), item.file), "utf8").trim()).toBe(item.expected);
			console.info(JSON.stringify({ scenario: item.id, task_id, operation_id, status: "completed", tool: "bash", provider: "linux-bwrap", result: item.expected }));
		}
	}, 255_000);

	test("scope and credential window fail closed before writing", async () => {
		expect(await call(base, "POST", "/api/aaas/v1/tasks", dualToken, { prompt: "dual" }, "scope")).toMatchObject({
			status: 403,
			body: { error: { code: "CAPABILITY_SCOPE_REQUIRED" } },
		});
		expect(
			(await call(base, "POST", "/api/aaas/v1/tasks", dualToken, { prompt: "dual" }, "scope", "router")).status,
		).toBe(201);
		const shortWindow = {
			prompt: "tool premature",
			credentials: {
				servers: {
					[mcpId]: { tool_credential: "fixture-tool-value" },
				},
			},
		};
		expect(
			await call(
				base,
				"POST",
				"/api/aaas/v1/tasks",
				token,
				{ ...shortWindow, prompt: "fixture-tool-value" },
				"secret-in-input",
			),
		).toMatchObject({
			status: 400,
			body: { error: { code: "INVALID_CREDENTIAL" } },
		});
		expect(await call(base, "POST", "/api/aaas/v1/tasks", token, { ...shortWindow, credentials_expires_at: new Date().toISOString() }, "short")).toMatchObject({
			status: 400,
			body: { error: { code: "INVALID_REQUEST" } },
		});
	});

	test("expired queued credentials and credentials expiring during MCP handshake block execution", async () => {
		const body = {
			prompt: "tool past expiry",
			credentials: {
				servers: {
					[mcpId]: { tool_credential: "fixture-tool-value" },
				},
			},
		};
		const before = wireCalls.length;
		const queueTimeout = await call(
			base,
			"POST",
			"/api/aaas/v1/tasks",
			token,
			{ prompt: "queue timeout", mcp_servers: [] },
			"queue-timeout",
		);
		expect(queueTimeout.status).toBe(201);
		const queueOp = (queueTimeout.body.data as { operation_id: string }).operation_id;
		await client.run("update router_operations set queue_deadline=now() - interval '1 second' where id=$1", queueOp);
		expect(await waitForOperation(queueOp)).toMatchObject({
			state: "failed",
			error_code: "QUEUE_TIMEOUT",
			started_at: null,
		});
		const queued = await call(base, "POST", "/api/aaas/v1/tasks", token, body, "expiry-before-claim");
		expect(queued.status).toBe(201);
		const queuedOp = (queued.body.data as { operation_id: string }).operation_id;
		await client.run(
			"update router_operations set credential_deadline=now() - interval '1 second' where id=$1",
			queuedOp,
		);
		expect(await waitForOperation(queuedOp)).toMatchObject({ state: "failed", error_code: "CREDENTIAL_EXPIRED" });
		const handshake = await call(base, "POST", "/api/aaas/v1/tasks", token, body, "expiry-after-handshake");
		expect(handshake.status).toBe(201);
		expireDuringHandshake = true;
		try {
			const handshakeOp = (handshake.body.data as { operation_id: string }).operation_id;
			expect(await waitForOperation(handshakeOp)).toMatchObject({
				state: "failed",
				error_code: "CREDENTIAL_EXPIRED",
			});
			expect(wireCalls).toHaveLength(before);
		} finally {
			clockSkew = 0;
			expireDuringHandshake = false;
		}
	});

	test("four waiting operations are admitted while another worker is executing and canceled in order", async () => {
		const workerSessions: ControlledSession[] = [];
		const worker = new RouterRuntime({
			client,
			tenantId,
			keys,
			idempotency: new IdempotencyKeyring({ masterKey }),
			repos,
			masterKey,
			adapter: createPiRuntimeAdapter({
				createSession: async (options) => {
					const session = new ControlledSession(options.id, { text: "late success", status: "complete" });
					workerSessions.push(session);
					return session;
				},
			}),
		});
		try {
			// Drain the earlier dual-Key request so the worker takes only this Task.
			await runtime.tick();
			const created = await call(
				base,
				"POST",
				"/api/aaas/v1/tasks",
				token,
				{ prompt: "hold", mcp_servers: [] },
				"idem-batch",
			);
			const { task_id: taskId, operation_id: firstOp } = created.body.data as {
				task_id: string;
				operation_id: string;
			};
			await worker.tick();
			await vi.waitFor(() => expect(workerSessions[0]?.prompts[0]?.text).toBe("hold"));
			const inputsPath = `/api/aaas/v1/tasks/${taskId}/inputs`;
			const replies = await Promise.all(
				Array.from({ length: 5 }, (_, index) =>
					call(
						base,
						"POST",
						inputsPath,
						token,
						{
							input: `rapid-${index}`,
							credentials: {
								servers: {
									[mcpId]: {
										tool_credential: "fixture-tool-value",
									},
								},
							},
						},
						`idem-rapid-${index}`,
					),
				),
			);
			expect(replies.map((reply) => reply.status).sort()).toEqual([202, 202, 202, 202, 429]);
			expect(
				replies
					.filter((reply) => reply.status === 202)
					.map((reply) => (reply.body.data as { ordinal: number }).ordinal)
					.sort(),
			).toEqual([2, 3, 4, 5]);
			const cancel = await call(base, "POST", `/api/aaas/v1/tasks/${taskId}/cancel`, token, { reason: "stop" });
			expect(cancel).toMatchObject({ status: 200, body: { data: { cleanup_pending: true } } });
			expect(await runtime.cleanup(firstOp)).toMatchObject({
				released: false,
				reason: "INSUFFICIENT_EXIT_EVIDENCE",
			});
			await worker.tick();
			expect((await waitForOperation(firstOp)).state).toBe("canceled");
			expect(workerSessions[0].aborted).toBeGreaterThan(0);
			const rows = await client.run(
				"select state,holds_task_occupancy from router_operations where task_id=$1 order by operation_sequence",
				taskId,
			);
			expect(rows).toEqual(Array.from({ length: 5 }, () => ({ state: "canceled", holds_task_occupancy: false })));
			expect(
				(await call(base, "POST", inputsPath, token, { input: "late", mcp_servers: [] }, "idem-late")).status,
			).toBe(409);
		} finally {
			await worker.close();
		}
	});

	test.skipIf(process.platform !== "linux")(
		"two real workers race and a stopped process retains occupancy until verified exit",
		async () => {
			const childFixture = new URL("./router-worker.fixture.ts", import.meta.url);
			const forkWorker = () =>
				fork(fileURLToPath(childFixture), {
					execArgv: ["--disable-warning=ExperimentalWarning"],
					stdio: ["ignore", "ignore", "inherit", "ipc"],
					env: { ...process.env, ROUTER_TEST_DB_URL: databaseUrl(), ROUTER_TEST_TENANT_ID: tenantId },
				});
			const onMessage = (child: ChildProcess, expected: string) =>
				new Promise<void>((resolve, reject) => {
					const onExit = () => reject(new Error(`Worker exited before ${expected}`));
					const receive = (message: unknown) => {
						if (message === expected || (typeof message === "object" && message !== null && "error" in message)) {
							child.off("message", receive);
							child.off("exit", onExit);
							if (message === expected) resolve();
							else reject(new Error(String((message as { error: unknown }).error)));
						}
					};
					child.on("message", receive);
					child.once("exit", onExit);
				});
			const a = forkWorker();
			const b = forkWorker();
			try {
				await Promise.all([onMessage(a, "ready"), onMessage(b, "ready")]);
				const created = await call(
					base,
					"POST",
					"/api/aaas/v1/tasks",
					token,
					{ prompt: "race", mcp_servers: [] },
					"idem-race",
				);
				const { task_id: taskId, operation_id: firstOp } = created.body.data as {
					task_id: string;
					operation_id: string;
				};
				const pending = await call(
					base,
					"POST",
					`/api/aaas/v1/tasks/${taskId}/inputs`,
					token,
					{ input: "queued after crash", mcp_servers: [] },
					"idem-race-input",
				);
				expect(pending.status).toBe(202);
				const ticked = Promise.all([onMessage(a, "ticked"), onMessage(b, "ticked")]);
				a.send("tick");
				b.send("tick");
				await ticked;
				await vi.waitFor(async () => {
					const [row] = await client.run(
						"select completed_at from orchestration_llm_calls where router_operation_id=$1",
						firstOp,
					);
					expect(row?.completed_at).toBeInstanceOf(Date);
				});
				const [owner] = await client.run("select worker_instance_id from router_operations where id=$1", firstOp);
				const winner = String(owner.worker_instance_id).startsWith(`proc:${a.pid}:`) ? a : b;
				const follower = winner === a ? b : a;
				expect(String(owner.worker_instance_id)).toContain(`proc:${winner.pid}:`);
				const [occupied] = await client.run(
					"select count(*)::int as n from router_operations where task_id=$1 and holds_task_occupancy",
					taskId,
				);
				expect(occupied.n).toBe(1);
				expect(winner.kill("SIGSTOP")).toBe(true);
				await client.run(
					"update router_operations set lease_expires_at=now() - interval '1 second' where id=$1",
					firstOp,
				);
				const checked = onMessage(follower, "ticked");
				follower.send("tick");
				await checked;
				expect(await runtime.cleanup(firstOp)).toMatchObject({
					released: false,
					reason: "INSUFFICIENT_EXIT_EVIDENCE",
				});
				const dead = once(winner, "exit");
				expect(winner.kill("SIGKILL")).toBe(true);
				expect(await dead).toEqual([null, "SIGKILL"]);
				const recovered = onMessage(follower, "ticked");
				follower.send("tick");
				await recovered;
				const rows = await client.run(
					"select state,error_code,cancel_reason,holds_task_occupancy,usage from router_operations where task_id=$1 order by operation_sequence",
					taskId,
				);
				expect(rows).toEqual([
					{
						state: "failed",
						error_code: "EXECUTION_INTERRUPTED",
						cancel_reason: null,
						holds_task_occupancy: false,
						usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
					},
					{
						state: "canceled",
						error_code: null,
						cancel_reason: "PREDECESSOR_FAILED",
						holds_task_occupancy: false,
						usage: {},
					},
				]);
			} finally {
				await Promise.all(
					[a, b].map(async (child) => {
						if (child.exitCode !== null || child.signalCode !== null) return;
						const exited = once(child, "exit");
						child.kill("SIGKILL");
						await exited;
					}),
				);
			}
		},
	);

	test("a worker fenced out before completion cannot publish its late result", async () => {
		const created = await call(
			base,
			"POST",
			"/api/aaas/v1/tasks",
			token,
			{ prompt: "hold", mcp_servers: [] },
			"idem-late-fence",
		);
		const { task_id: taskId, operation_id: operationId } = created.body.data as {
			task_id: string;
			operation_id: string;
		};
		await runtime.tick();
		await vi.waitFor(() => expect(sessions.at(-1)?.prompts[0]?.text).toBe("hold"));
		const session = sessions.at(-1)!;
		await client.run("update router_tasks set fence_token=fence_token+1 where id=$1", taskId);
		session.complete();
		await vi.waitFor(() => expect(session.disposed).toBe(1));
		await runtime.close();
		const [row] = await client.run(
			"select state,result,holds_task_occupancy from router_operations where id=$1",
			operationId,
		);
		expect(row).toEqual({ state: "running", result: null, holds_task_occupancy: true });
		const events = await client.run(
			"select 1 from router_task_events where operation_id=$1 and event_type='operation.completed'",
			operationId,
		);
		expect(events).toHaveLength(0);
	});
});
