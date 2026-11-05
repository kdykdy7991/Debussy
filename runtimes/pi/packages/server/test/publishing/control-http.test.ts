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
import { generateKeyPairSync } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { createControlHttpHandler } from "../../src/publishing/control/http.ts";
import { ControlService, type CurrentAgentDefinitionSource } from "../../src/publishing/control/service.ts";
import { fromPublicId, newTenantId, type TenantId } from "../../src/publishing/domain/ids.ts";
import { McpSecretBox } from "../../src/publishing/mcp/secret-box.ts";
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
			newConversations: false,
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
		service = new ControlService({
			repositories: repos,
			catalog: CATALOG,
			embedBaseUrl: "https://embed.test",
			launchTokenAllowedIssuers: ["ticket-system"],
			mcpSecretBox: new McpSecretBox(Buffer.alloc(32, 3)),
		});
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
		const detail = await httpCall({
			method: "GET",
			path: `/api/control/v1/agent-definitions/${first.body.data.id}`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
		});
		expect(detail.status).toBe(200);
		expect(detail.body.data.capabilities.newConversations).toBe(false);

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
		const local = await httpCall({
			method: "POST",
			path: "/api/control/v1/mcp-servers",
			base: httpBase,
			headers: auth,
			body: {
				name: "local-mcp",
				config: { transport: "streamable_http", endpoint: "http://127.0.0.1/mcp", authentication: "none" },
			},
		});
		expect(local.status).toBe(201);

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
					authentication: "api_key",
				},
			},
		});
		expect(created.status).toBe(201);
		expect(created.body.data.id).toMatch(/^mcp_/);
		expect(created.body.data.secretConfigured).toBe(false);
		expect(created.body.data.revisions[0].config.authentication).toBe("api_key");
		expect(JSON.stringify(created.body)).not.toContain("bearerToken");
		const missingSecret = await httpCall({
			method: "POST",
			path: `/api/control/v1/mcp-servers/${created.body.data.id}/test`,
			base: httpBase,
			headers: auth,
			body: {},
		});
		expect(missingSecret.status).toBe(409);
		expect(missingSecret.body.error.code).toBe("MCP_SECRET_NOT_CONFIGURED");
		const credential = "http-api-key-test-secret";
		const saved = await httpCall({
			method: "POST",
			path: `/api/control/v1/mcp-servers/${created.body.data.id}/secret`,
			base: httpBase,
			headers: auth,
			body: { bearerToken: credential },
		});
		expect(saved.status).toBe(200);
		expect(saved.body.data.secretConfigured).toBe(true);
		expect(JSON.stringify(saved.body)).not.toContain(credential);

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
					authentication: "api_key",
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
		expect(detail.body.data.revisions[0].config.authentication).toBe("api_key");
		expect(detail.body.data.secretConfigured).toBe(true);
		expect(JSON.stringify(detail.body)).not.toContain(credential);
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

	test("admin force deletion is atomic, idempotent and retains MCP history", async () => {
		const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };
		const created = await httpCall({
			method: "POST",
			path: "/api/control/v1/mcp-servers",
			base: httpBase,
			headers: auth,
			body: {
				name: "force-delete-mcp",
				config: { transport: "streamable_http", endpoint: "https://mcp.example.com", authentication: "bearer" },
			},
		});
		expect(created.status).toBe(201);
		const publicId = created.body.data.id as string;
		const id = publicId.slice(4);
		const path = `/api/control/v1/mcp-servers/${publicId}/force-delete`;
		const secret = await httpCall({
			method: "POST",
			path: `/api/control/v1/mcp-servers/${publicId}/secret`,
			base: httpBase,
			headers: auth,
			body: { bearerToken: "secret-value" },
		});
		expect(secret.status).toBe(200);
		const serverId = fromPublicId("McpServerId", publicId);
		if (serverId === null) throw new Error("Invalid MCP Server ID");
		const encryptedSecret = await repos.mcpSecrets.get({ tenantId: adminId }, serverId);
		expect(encryptedSecret).toBeDefined();
		await client.run(
			`insert into mcp_tools (id,tenant_id,mcp_server_id,mcp_revision,name,input_schema,input_schema_hash)
			values (gen_random_uuid(),$1,$2,1,'tool','{}'::jsonb,$3)`,
			adminId,
			id,
			"a".repeat(64),
		);
		await client.run(
			`insert into mcp_call_audits (id,tenant_id,mcp_server_id,mcp_revision,tool_name,outcome,latency_ms)
			values (gen_random_uuid(),$1,$2,1,'tool','success',1)`,
			adminId,
			id,
		);
		const agent = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions",
			base: httpBase,
			headers: auth,
			body: {
				...createAgentBody("force-delete-agent"),
				mcpServers: [{ mcpServerId: publicId, revision: 1, toolNames: ["tool"] }],
			},
		});
		expect(agent.status).toBe(201);
		const published = await httpCall({
			method: "POST",
			path: `/api/control/v1/agent-definitions/${agent.body.data.id}/publish`,
			base: httpBase,
			headers: auth,
			body: {},
		});
		expect(published.status).toBe(201);
		const versionId = (published.body.data.version.id as string).slice(4);
		const beforeVersion = (
			await client.run(
				"select snapshot, runtime_spec, runtime_spec_hash from published_app_versions where id=$1",
				versionId,
			)
		)[0];
		const ordinary = await httpCall({
			method: "DELETE",
			path: `/api/control/v1/mcp-servers/${publicId}`,
			base: httpBase,
			headers: auth,
		});
		expect(ordinary.status).toBe(409);
		const unauthorized = await httpCall({ method: "POST", path, base: httpBase, body: { confirm: true } });
		expect(unauthorized.status).toBe(401);
		const notConfirmed = await httpCall({
			method: "POST",
			path,
			base: httpBase,
			headers: auth,
			body: { confirm: false },
		});
		expect(notConfirmed.status).toBe(400);
		await client.run(`create function reject_force_audit() returns trigger language plpgsql as $$ begin
			if new.action = 'mcp-server.force-deleted' then raise exception 'test audit failure'; end if; return new; end $$`);
		await client.run(
			"create trigger reject_force_audit before insert on audit_events for each row execute function reject_force_audit()",
		);
		const failed = await httpCall({ method: "POST", path, base: httpBase, headers: auth, body: { confirm: true } });
		expect(failed.status).toBe(500);
		expect((await client.run("select deleted_at from mcp_servers where id=$1", id))[0]?.deleted_at).toBeNull();
		expect(await client.run("select id from mcp_secrets where mcp_server_id=$1", id)).toHaveLength(1);
		await client.run("drop trigger reject_force_audit on audit_events");
		const results = await Promise.all(
			[1, 2].map(() => httpCall({ method: "POST", path, base: httpBase, headers: auth, body: { confirm: true } })),
		);
		expect(results.map((result) => result.status)).toEqual([200, 200]);
		expect(await client.run("select id from mcp_secrets where mcp_server_id=$1", id)).toHaveLength(0);
		await expect(repos.mcpSecrets.put(encryptedSecret!)).rejects.toThrow("MCP Server is unavailable");
		expect(await client.run("select revision from mcp_server_revisions where mcp_server_id=$1", id)).toHaveLength(1);
		expect(await client.run("select id from mcp_tools where mcp_server_id=$1", id)).toHaveLength(1);
		expect(await client.run("select id from mcp_call_audits where mcp_server_id=$1", id)).toHaveLength(1);
		expect(
			(
				await client.run(
					"select snapshot, runtime_spec, runtime_spec_hash from published_app_versions where id=$1",
					versionId,
				)
			)[0],
		).toEqual(beforeVersion);
		expect(
			await client.run("select id from audit_events where resource_id=$1 and action='mcp-server.force-deleted'", id),
		).toHaveLength(1);
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

	test("400 on invalid JSON body and on schema mismatch", async () => {
		const invalidJson = await new Promise<{ status: number; body: string }>((resolve, reject) => {
			const url = new URL("/api/control/v1/skills/import", httpBase);
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
			path: "/api/control/v1/skills/import",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: { filename: 42, contentBase64: "x" },
		});
		expect(badBody.status).toBe(400);
		expect(badBody.body.error.code).toBe("INVALID_REQUEST");
	});

	test("413 for an oversized body", async () => {
		const big = "x".repeat(9 * 1024 * 1024);
		const res = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions",
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

	test("P1 publish: POST /agent-definitions/:id/publish activates the latest revision (201) and is reusable", async () => {
		const created = await httpCall({
			method: "POST",
			path: "/api/control/v1/agent-definitions",
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: createAgentBody("http-publish-agent"),
		});
		expect(created.status).toBe(201);
		const agentId = created.body.data.id as string;

		const published = await httpCall({
			method: "POST",
			path: `/api/control/v1/agent-definitions/${agentId}/publish`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: {},
		});
		expect(published.status).toBe(201);
		expect(published.body.data.agentId).toBe(agentId);
		expect(published.body.data.agentRevision).toBe(1);
		expect(published.body.data.version.id).toMatch(/^pav_/);
		expect(published.body.data.version.status).toBe("ready");
		expect(published.body.data.version.sourceAgentRevision).toBe(1);
		expect(published.body.data.publishedApp.status).toBe("active");
		expect(published.body.data.previousVersionId).toBeNull();
		expect(published.body.data.embedUrl).toMatch(/^https:\/\/embed\.test\/embed\//);

		// Republishing reuses the same app and creates a next version.
		const republished = await httpCall({
			method: "POST",
			path: `/api/control/v1/agent-definitions/${agentId}/publish`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: {},
		});
		expect(republished.status).toBe(201);
		expect(republished.body.data.version.versionNumber).toBeGreaterThan(published.body.data.version.versionNumber);
		expect(republished.body.data.previousVersionId).toBe(published.body.data.version.id);

		const publicKeyPem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
		const signed = await httpCall({
			method: "POST",
			path: `/api/control/v1/agent-definitions/${agentId}/publish`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: {
				accessMode: "signed_user",
				allowedOrigins: ["https://host.test"],
				signedIdentity: { issuer: "ticket-system", keyId: "ticket-key-1", publicKeyPem },
			},
		});
		expect(signed.status).toBe(201);
		expect(signed.body.data.publishedApp.id).not.toBe(published.body.data.publishedApp.id);
		const signedAgain = await httpCall({
			method: "POST",
			path: `/api/control/v1/agent-definitions/${agentId}/publish`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: { accessMode: "signed_user" },
		});
		expect(signedAgain.status).toBe(201);
		expect(signedAgain.body.data.version.versionNumber).toBe(2);

		// The latest revision is implied; callers cannot supply an old revision.
		const rejectedBody = await httpCall({
			method: "POST",
			path: `/api/control/v1/agent-definitions/${agentId}/publish`,
			base: httpBase,
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: { sourceAgentRevision: 1 },
		});
		expect(rejectedBody.status).toBe(400);
	});
});
