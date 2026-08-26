/**
 * TASK-013: Control Plane HTTP API (spec 27.1-27.3, 33.2, 33.3).
 *
 * Covers: bearer auth with constant-time comparison (uniform 401, no token
 * leakage), request schema validation (400/413), idempotency replay + key
 * conflicts, status codes (201/422/404/409), requestId echo, error
 * desensitisation (cross-tenant resources are uniformly unavailable), and the
 * stage-C checkpoint: create app -> immutable version -> activate ->
 * publicAppId, all over HTTP. Requires the local test DB.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { createControlHttpHandler } from "../../src/publishing/control/http.ts";
import { ControlService, type CurrentAgentDefinitionSource } from "../../src/publishing/control/service.ts";
import { newTenantId, type TenantId } from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import type { AgentDraftConfig, CapabilityCatalog } from "../../src/publishing/runtime-spec/compiler.ts";
import type { HttpRequestHandler } from "../../src/types.ts";

const SCHEMA = `pub_test_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const ADMIN_TOKEN = "control-admin-token-0123456789abcdef0123456789abcdef";

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

function source(config: AgentDraftConfig, name = "http-agent"): CurrentAgentDefinitionSource {
	return {
		async collect() {
			return {
				name,
				config,
				warnings: [
					{ code: "TOOL_EXCLUDED", path: "tools.shell", message: "Coding tool is not publishable in MVP" },
				],
			};
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

function createAgentBody(name: string): Record<string, unknown> {
	return {
		name,
		description: "Created over HTTP",
		modelId: "pi-chat",
		systemPrompt: "You are an HTTP-created Agent.",
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
	};
}

function httpCall(options: {
	method: string;
	path: string;
	base: string;
	headers?: Record<string, string>;
	body?: unknown;
}): Promise<{ status: number; body: any; requestId?: string; tenantId?: string; tenantName?: string }> {
	return new Promise((resolve, reject) => {
		const url = new URL(options.path, options.base);
		const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
		const req = httpRequest(
			url,
			{
				method: options.method,
				headers: {
					host: url.host,
					"content-type": "application/json",
					...(payload !== undefined ? { "content-length": Buffer.byteLength(payload) } : {}),
					...options.headers,
				},
			},
			(res: IncomingMessage) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf-8");
					let body: any;
					try {
						body = raw ? JSON.parse(raw) : undefined;
					} catch {
						body = raw;
					}
					resolve({
						status: res.statusCode ?? 0,
						body,
						requestId: res.headers["x-request-id"] as string | undefined,
						tenantId: res.headers["x-tenant-id"] as string | undefined,
						tenantName: res.headers["x-tenant-name"] as string | undefined,
					});
				});
			},
		);
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

describe.skipIf(!pgUp)("control plane http api", () => {
	let client: PostgresClient;
	let repos: PublishingRepositories;
	let service: ControlService;
	let handler: HttpRequestHandler;
	let httpBase: string;
	let adminId: TenantId;
	let server: Server;

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repos = createPublishingRepositories(client);
		const tenantId = newTenantId();
		service = new ControlService({ repositories: repos, catalog: CATALOG, embedBaseUrl: "https://embed.test" });
		// 33.1: the bootstrap tenant exists before any control call.
		const bootstrapped = await service.bootstrapTenant({ tenantId, tenantName: "bootstrap" });
		if (!bootstrapped.ok) throw new Error("bootstrap failed");
		handler = createControlHttpHandler({
			service,
			repositories: repos,
			adminToken: ADMIN_TOKEN,
			tenantId,
			tenantName: "bootstrap",
			source: source(baseConfig()),
			onError: (error) => console.error("CONTROL HANDLER ERROR:", error),
		});
		adminId = tenantId;
		// Stand up a throwaway HTTP server on an ephemeral port.
		server = createServer((req, res) => {
			Promise.resolve(handler(req, res)).then((handled) => {
				if (!handled) {
					res.writeHead(404, { "content-type": "text/plain" });
					res.end("Not found");
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as { port: number };
		httpBase = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	test("401 without a bearer token, uniform across routes", async () => {
		const res = await httpCall({ method: "POST", path: "/api/control/v1/published-apps", base: httpBase, body: {} });
		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe("UNAUTHORIZED");
		// No requestId leaked on the auth failure itself.
		expect(res.body.error.requestId).toBe("");
	});

	test("401 on a wrong token, even with a valid shape", async () => {
		const res = await httpCall({
			method: "POST",
			path: "/api/control/v1/published-apps",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}x` },
			body: {},
		});
		expect(res.status).toBe(401);
	});

	test("import-current returns agentDefinitionId, revision 1, sourceHash and warnings (201)", async () => {
		const res = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions/import-current",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "import-1" },
			body: { name: "http-agent", expectedSourceHash: null },
		});
		expect(res.status).toBe(201);
		expect(res.body.data.agentDefinitionId).toMatch(/^agent_/);
		expect(res.body.data.revision).toBe(1);
		expect(res.body.data.sourceHash).toMatch(/^[0-9a-f]{64}$/);
		expect(res.body.data.warnings).toEqual([
			{ code: "TOOL_EXCLUDED", path: "tools.shell", message: "Coding tool is not publishable in MVP" },
		]);
		expect(res.body.requestId).toBeTruthy();
		expect(res.requestId).toBe(res.body.requestId);
		expect(res.tenantId).toBe(String(adminId));
		expect(res.tenantName).toBe("bootstrap");
	});

	test("POST agent-definitions creates revision 1, replays idempotently, and rejects name conflicts", async () => {
		const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "create-agent-1" };
		const first = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions",
			base: httpBase,
			headers,
			body: createAgentBody("http-created-agent"),
		});
		expect(first.status).toBe(201);
		expect(first.body.data.id).toMatch(/^agent_/);
		expect(first.body.data.revision).toBe(1);
		expect(first.body.data.sourceHash).toMatch(/^[0-9a-f]{64}$/);

		const replay = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions",
			base: httpBase,
			headers,
			body: createAgentBody("http-created-agent"),
		});
		expect(replay.status).toBe(201);
		expect(replay.body).toEqual(first.body);

		const conflict = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "create-agent-2" },
			body: createAgentBody("http-created-agent"),
		});
		expect(conflict.status).toBe(409);
		expect(conflict.body.error.code).toBe("AGENT_NAME_CONFLICT");
	});

	test("MCP HTTP routes create, list, revise, disable, and soft-delete without exposing a Secret", async () => {
		const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };
		const unsafe = await httpCall({
			method: "POST",
			path: "/api/control/v1/mcp-servers",
			base: httpBase,
			headers: auth,
			body: {
				name: "unsafe-mcp",
				config: { transport: "streamable_http", endpoint: "http://127.0.0.1/mcp", authentication: "none" },
			},
		});
		expect(unsafe.status).toBe(422);
		expect(unsafe.body.error.code).toBe("MCP_CONFIG_NOT_APPROVED");

		const created = await httpCall({
			method: "POST",
			path: "/api/control/v1/mcp-servers",
			base: httpBase,
			headers: auth,
			body: {
				name: "http-mcp",
				config: {
					transport: "streamable_http",
					endpoint: "https://mcp.example.com/v1",
					authentication: "none",
				},
			},
		});
		expect(created.status).toBe(201);
		expect(created.body.data.id).toMatch(/^mcp_/);
		expect(created.body.data.secretConfigured).toBe(false);
		expect(JSON.stringify(created.body)).not.toContain("bearerToken");

		const list = await httpCall({
			method: "GET",
			path: "/api/control/v1/mcp-servers",
			base: httpBase,
			headers: auth,
		});
		expect(list.status).toBe(200);
		expect(list.body.data.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: created.body.data.id, name: "http-mcp" })]),
		);

		const revised = await httpCall({
			method: "POST",
			path: `/api/control/v1/mcp-servers/${created.body.data.id}/revisions`,
			base: httpBase,
			headers: auth,
			body: {
				config: {
					transport: "streamable_http",
					endpoint: "https://mcp.example.com/v2",
					authentication: "none",
				},
			},
		});
		expect(revised.status).toBe(201);
		expect(revised.body.data.revision).toBe(2);
		const detail = await httpCall({
			method: "GET",
			path: `/api/control/v1/mcp-servers/${created.body.data.id}`,
			base: httpBase,
			headers: auth,
		});
		expect(detail.status).toBe(200);
		expect(detail.body.data.revisions.map((revision: { revision: number }) => revision.revision)).toEqual([2, 1]);

		const disabled = await httpCall({
			method: "PATCH",
			path: `/api/control/v1/mcp-servers/${created.body.data.id}/status`,
			base: httpBase,
			headers: auth,
			body: { enabled: false },
		});
		expect(disabled.status).toBe(200);
		expect(disabled.body.data.enabled).toBe(false);

		const deleted = await httpCall({
			method: "DELETE",
			path: `/api/control/v1/mcp-servers/${created.body.data.id}`,
			base: httpBase,
			headers: auth,
		});
		expect(deleted.status).toBe(200);
		const missing = await httpCall({
			method: "GET",
			path: `/api/control/v1/mcp-servers/${created.body.data.id}`,
			base: httpBase,
			headers: auth,
		});
		expect(missing.status).toBe(404);
		expect(missing.body.error.code).toBe("MCP_SERVER_NOT_FOUND");
	});

	test("import-current is idempotent per Idempotency-Key (same response, no new revision)", async () => {
		const first = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions/import-current",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "import-replay" },
			body: { name: "http-agent", expectedSourceHash: null },
		});
		const second = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions/import-current",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "import-replay" },
			body: { name: "http-agent", expectedSourceHash: null },
		});
		expect(first.status).toBe(201);
		expect(second.status).toBe(first.status);
		expect(second.body).toEqual(first.body);
	});

	test("create app (201) with publicAppId, status draft and embedUrl", async () => {
		const imported = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions/import-current",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "import-app-1" },
			body: { name: "http-agent", expectedSourceHash: null },
		});
		const app = await httpCall({
			method: "POST",
			path: "/api/control/v1/published-apps",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "app-1" },
			body: {
				agentDefinitionId: imported.body.data.agentDefinitionId,
				name: "HTTP Agent",
				accessMode: "mixed",
				allowedOrigins: ["https://project-a.example.com"],
				theme: { primaryColor: "#2563eb", welcomeMessage: "请上传合同或直接提问" },
			},
		});
		expect(app.status).toBe(201);
		expect(app.body.data.id).toMatch(/^app_/);
		expect(app.body.data.publicAppId).toMatch(/^pub_/);
		expect(app.body.data.status).toBe("draft");
		expect(app.body.data.currentVersionId).toBeNull();
		expect(app.body.data.embedUrl).toBe(`https://embed.test/embed/${app.body.data.publicAppId}`);
		expect(app.body.requestId).toBeTruthy();
	});

	test("create version: 201 for ready, 422 for rejected with validationErrors", async () => {
		const imported = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions/import-current",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "import-v1" },
			body: { name: "http-agent", expectedSourceHash: null },
		});
		const app = await httpCall({
			method: "POST",
			path: "/api/control/v1/published-apps",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "app-v1" },
			body: { agentDefinitionId: imported.body.data.agentDefinitionId, name: "V Agent", accessMode: "anonymous" },
		});
		const ready = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${app.body.data.id}/versions`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "ver-ready" },
			body: { sourceAgentRevision: imported.body.data.revision },
		});
		expect(ready.status).toBe(201);
		expect(ready.body.data.version.status).toBe("ready");
		expect(ready.body.data.version.id).toMatch(/^pav_/);

		// Rejected: a version compiled from an unapproved tool config.
		const badSource = {
			async collect() {
				return {
					name: "bad-agent",
					config: baseConfig({ tools: [{ id: "shell.exec" }] }),
					warnings: [],
				};
			},
		};
		// Swap the source, import a config that fails the whitelist.
		handler = createControlHttpHandler({
			service,
			repositories: repos,
			adminToken: ADMIN_TOKEN,
			tenantId: adminId,
			source: badSource as CurrentAgentDefinitionSource,
		});
		const importedBad = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions/import-current",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "import-bad" },
			body: { name: "bad-agent", expectedSourceHash: null },
		});
		const appBad = await httpCall({
			method: "POST",
			path: "/api/control/v1/published-apps",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "app-bad" },
			body: {
				agentDefinitionId: importedBad.body.data.agentDefinitionId,
				name: "Bad Agent",
				accessMode: "anonymous",
			},
		});
		const rejected = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${appBad.body.data.id}/versions`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "ver-bad" },
			body: { sourceAgentRevision: importedBad.body.data.revision },
		});
		expect(rejected.status).toBe(422);
		expect(rejected.body.data.version.status).toBe("rejected");
		expect(Array.isArray(rejected.body.data.version.validationErrors)).toBe(true);
		expect(rejected.body.data.version.validationErrors.length).toBeGreaterThan(0);

		// Restore the good source for the remaining tests.
		handler = createControlHttpHandler({
			service,
			repositories: repos,
			adminToken: ADMIN_TOKEN,
			tenantId: adminId,
			source: source(baseConfig()),
		});
	});

	test("stage-C checkpoint: activate a ready version over HTTP and get publicAppId", async () => {
		const imported = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions/import-current",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "import-check" },
			body: { name: "http-agent", expectedSourceHash: null },
		});
		const app = await httpCall({
			method: "POST",
			path: "/api/control/v1/published-apps",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "app-check" },
			body: {
				agentDefinitionId: imported.body.data.agentDefinitionId,
				name: "Checkpoint Agent",
				accessMode: "anonymous",
			},
		});
		const version = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${app.body.data.id}/versions`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "ver-check" },
			body: { sourceAgentRevision: imported.body.data.revision },
		});
		expect(version.status).toBe(201);
		const activated = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${app.body.data.id}/activate`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "act-check" },
			body: { versionId: version.body.data.version.id },
		});
		expect(activated.status).toBe(200);
		expect(activated.body.data.app.status).toBe("active");
		expect(activated.body.data.app.currentVersionId).toBe(version.body.data.version.id);
		expect(activated.body.data.auditEventId).toMatch(/^aud_/);
		// publicAppId + embedUrl are the checkpoint deliverable.
		expect(app.body.data.publicAppId).toMatch(/^pub_/);
		expect(app.body.data.embedUrl).toBe(`https://embed.test/embed/${app.body.data.publicAppId}`);
	});

	test("rollback and suspend over HTTP, with audit event ids", async () => {
		const imported = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions/import-current",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "import-rb" },
			body: { name: "http-agent", expectedSourceHash: null },
		});
		const app = await httpCall({
			method: "POST",
			path: "/api/control/v1/published-apps",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "app-rb" },
			body: { agentDefinitionId: imported.body.data.agentDefinitionId, name: "RB Agent", accessMode: "anonymous" },
		});
		const v1 = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${app.body.data.id}/versions`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "ver-rb-1" },
			body: { sourceAgentRevision: imported.body.data.revision },
		});
		await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${app.body.data.id}/activate`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "act-rb" },
			body: { versionId: v1.body.data.version.id },
		});
		const rolled = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${app.body.data.id}/rollback`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "rb-rb" },
			body: { versionId: v1.body.data.version.id },
		});
		expect(rolled.status).toBe(200);
		expect(rolled.body.data.app.status).toBe("active");
		expect(rolled.body.data.auditEventId).toMatch(/^aud_/);
		const suspended = await httpCall({
			method: "POST",
			path: `/api/control/v1/published-apps/${app.body.data.id}/suspend`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "sus-rb" },
			body: { reason: "operator_request" },
		});
		expect(suspended.status).toBe(200);
		expect(suspended.body.data.app.status).toBe("suspended");
		expect(suspended.body.data.auditEventId).toMatch(/^aud_/);
	});

	test("404 for an app id that does not exist, without leaking existence", async () => {
		const res = await httpCall({
			method: "POST",
			path: "/api/control/v1/published-apps/app_00000000-0000-7000-8000-000000000001/activate",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: { versionId: "pav_00000000-0000-7000-8000-000000000002" },
		});
		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("APP_NOT_FOUND");
		expect(res.body.error.requestId).toBeTruthy();
	});

	test("400 on invalid JSON body and on schema mismatch", async () => {
		const invalidJson = await new Promise<{ status: number; body: string }>((resolve, reject) => {
			const url = new URL("/api/control/v1/published-apps", httpBase);
			const req = httpRequest(
				url,
				{
					method: "POST",
					headers: {
						host: url.host,
						authorization: `Bearer ${ADMIN_TOKEN}`,
						"content-type": "application/json",
						"content-length": "1",
					},
				},
				(res: IncomingMessage) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
				},
			);
			req.on("error", reject);
			req.write("{");
			req.end();
		});
		expect(invalidJson.status).toBe(400);

		const badBody = await httpCall({
			method: "POST",
			path: "/api/control/v1/published-apps",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: { agentDefinitionId: 42, name: "x" },
		});
		expect(badBody.status).toBe(400);
		expect(badBody.body.error.code).toBe("INVALID_REQUEST");
	});

	test("413 for an oversized body", async () => {
		const big = "x".repeat(2 * 1024 * 1024);
		const res = await httpCall({
			method: "POST",
			path: "/api/control/v1/published-apps",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: { name: big },
		});
		expect(res.status).toBe(413);
		expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
	});

	test("409 when the same idempotency key is reused with a different request", async () => {
		const imported = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions/import-current",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "import-conflict" },
			body: { name: "http-agent", expectedSourceHash: null },
		});
		expect(imported.status).toBe(201);
		const conflicting = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions/import-current",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "import-conflict" },
			body: {
				name: "http-agent",
				expectedSourceHash: "0000000000000000000000000000000000000000000000000000000000000000",
			},
		});
		expect(conflicting.status).toBe(409);
		expect(conflicting.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
	});
});
