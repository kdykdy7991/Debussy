/**
 * T030 / SC-002 / SC-009 acceptance: the platform MCP metadata an independent
 * API Key may see.
 *
 * The usable Server set comes from the platform execution configuration intersected
 * with registry availability; there is no per-Key authorisation. This file checks
 * that scope, public schema redaction of platform-registered sensitive parameters,
 * credential requirements without credential values, and that Servers unavailable
 * in the platform MCP registry are excluded.
 *
 * Requires the isolated test database; the whole file is skipped (NOT RUN) when it
 * is unreachable.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ApiKeyStore } from "../../src/orchestration/api-key.ts";
import type { ApiKeyMcpServerSummary, ApiKeyMcpServerView } from "../../src/orchestration/api-key-contracts.ts";
import { createApiKeyHttp } from "../../src/orchestration/api-key-http.ts";
import { IdempotencyKeyring } from "../../src/orchestration/api-key-idempotency.ts";
import { ApiKeyRunService } from "../../src/orchestration/api-key-runs.ts";
import { WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { OrchestrationStore } from "../../src/orchestration/store.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";

const SCHEMA = `aaas_mcp_${process.pid}_${Date.now().toString(36)}`;
const PG_URL =
	process.env.PI_ORCHESTRATION_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";

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

/**
 * The platform MCP registry seam used by `ApiKeyRunService.effectiveCapabilities`:
 * `list` returns the raw Server IDs with their status and `get` resolves one of
 * them by the raw ID. A Server is only "available" when the registry reports it as
 * enabled.
 */
interface RegistryServer {
	readonly mcpServerId: string;
	readonly name: string;
	readonly status: "enabled" | "disabled";
	readonly currentRevision: number;
}

/** Published RuntimeSpec Server IDs; the registry keys are the same IDs without the `mcp_` prefix. */
const serverAlpha = `mcp_${randomUUID()}`;
const serverBeta = `mcp_${randomUUID()}`;
const serverGamma = `mcp_${randomUUID()}`;
const serverDelta = `mcp_${randomUUID()}`;

/** Every string value reachable in a response body, used for the "no secret in any field" check. */
function collectStrings(value: unknown, found: string[] = []): string[] {
	if (typeof value === "string") found.push(value);
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, found);
	else if (value !== null && typeof value === "object")
		for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, found);
	return found;
}

describe.skipIf(!pgUp)("platform MCP metadata of an independent API Key", () => {
	let client: PostgresClient;
	let keys: ApiKeyStore;
	let runs: ApiKeyRunService;
	let server: Server;
	let base: string;
	let narrowVersionId: string;
	const tenantId = randomUUID();
	const configurationId = randomUUID();
	const versionId = randomUUID();
	const masterKey = new Uint8Array(32).fill(31);
	const registry: readonly RegistryServer[] = [
		{ mcpServerId: serverAlpha.slice(4), name: "Alpha Server", status: "enabled", currentRevision: 1 },
		{ mcpServerId: serverBeta.slice(4), name: "Beta Server", status: "enabled", currentRevision: 1 },
		{ mcpServerId: serverGamma.slice(4), name: "Gamma Server", status: "disabled", currentRevision: 1 },
	];

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		await client.run(`insert into tenants(id,name,status) values ($1,'aaas-mcp-test','active')`, tenantId);
		await client.run(
			`insert into orchestration_configurations(id,tenant_id,name,draft,draft_revision) values ($1,$2,'platform','{}'::jsonb,1)`,
			configurationId,
			tenantId,
		);
		const draft = {
			schemaVersion: 1,
			publishedAppVersionId: `orv_${versionId}`,
			agent: { systemPrompt: "platform", model: { provider: "test", modelId: "test-model" } },
			capabilities: {
				mcpServers: [
					{
						mcpServerId: serverAlpha,
						revision: 1,
						transport: "streamable_http",
						endpoint: "https://mcp.example.com/alpha",
						authentication: "bearer",
						tools: [
							{
								name: "lookup",
								description: "Look up one account",
								inputSchema: {
									type: "object",
									properties: { account: { type: "string" }, query: { type: "string" } },
									required: ["account", "query"],
								},
								inputSchemaHash: "a".repeat(64),
							},
							{
								name: "search",
								description: "Search accounts",
								inputSchema: {
									type: "object",
									properties: { keyword: { type: "string" } },
									required: ["keyword"],
								},
								inputSchemaHash: "b".repeat(64),
							},
						],
					},
					{
						mcpServerId: serverBeta,
						revision: 1,
						transport: "streamable_http",
						endpoint: "https://mcp.example.com/beta",
						authentication: "none",
						tools: [
							{
								name: "ping",
								description: "Health probe",
								inputSchema: { type: "object", properties: {}, required: [] },
								inputSchemaHash: "c".repeat(64),
							},
							{
								name: "echo",
								description: "Echo the text back",
								inputSchema: {
									type: "object",
									properties: { text: { type: "string" } },
									required: ["text"],
								},
								inputSchemaHash: "d".repeat(64),
							},
						],
					},
					{
						mcpServerId: serverGamma,
						revision: 1,
						transport: "streamable_http",
						endpoint: "https://mcp.example.com/gamma",
						authentication: "api_key",
						tools: [
							{
								name: "report",
								description: "Build a report",
								inputSchema: {
									type: "object",
									properties: { period: { type: "string" } },
									required: ["period"],
								},
								inputSchemaHash: "e".repeat(64),
							},
						],
					},
					{
						mcpServerId: serverDelta,
						revision: 1,
						transport: "streamable_http",
						endpoint: "https://mcp.example.com/delta",
						authentication: "api_key",
						tools: [
							{
								name: "export",
								description: "Export a dataset",
								inputSchema: {
									type: "object",
									properties: { scope: { type: "string" } },
									required: ["scope"],
								},
								inputSchemaHash: "f".repeat(64),
							},
						],
					},
				],
			},
			contextPolicy: {},
			runtimePolicy: { profile: "chat-only" },
			theme: {},
			securityPolicyVersion: "sp_001",
		};
		const normalized = parseRuntimeSpec(draft);
		if (!normalized.ok) throw new Error(`invalid fixture spec: ${normalized.errors.join("; ")}`);
		await client.run(
			`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash)
			 values ($1,$2,$3,$4::jsonb,1,$5::jsonb,$6)`,
			versionId,
			tenantId,
			configurationId,
			{ modelId: "test-model", systemPrompt: "platform", parameters: {}, mcpServers: [], skills: [] },
			normalized.spec,
			sha256Hex(canonicalJson(normalized.spec)),
		);
		// A fixed version with a narrower whitelist, used to prove scope isolation
		// between configuration versions and Keys.
		narrowVersionId = randomUUID();
		const narrowDraft = structuredClone(draft) as typeof draft;
		narrowDraft.capabilities.mcpServers = draft.capabilities.mcpServers
			.filter((entry) => entry.mcpServerId === serverAlpha)
			.map((entry) => ({ ...entry, tools: entry.tools.slice(0, 1) }));
		const narrowNormalized = parseRuntimeSpec(narrowDraft);
		if (!narrowNormalized.ok) throw new Error(`invalid narrow fixture spec: ${narrowNormalized.errors.join("; ")}`);
		await client.run(
			`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash)
			 values ($1,$2,$3,$4::jsonb,99,$5::jsonb,$6)`,
			narrowVersionId,
			tenantId,
			configurationId,
			{ modelId: "test-model", systemPrompt: "platform", parameters: {}, mcpServers: [], skills: [] },
			narrowNormalized.spec,
			sha256Hex(canonicalJson(narrowNormalized.spec)),
		);
		await client.run(
			`insert into aaas_version_credential_bindings(tenant_id,orchestration_version_id,credential_bindings)
			 values ($1,$2,'[]'::jsonb)`,
			tenantId,
			narrowVersionId,
		);
		keys = new ApiKeyStore(client, tenantId, new Uint8Array(32).fill(41));
		await keys.setPlatformConfiguration(configurationId, versionId, [
			{ mcpServerId: serverAlpha, toolName: "lookup", parameter: "account", credentialId: "account_token" },
			{ mcpServerId: serverBeta, toolName: "echo", parameter: "text", credentialId: "echo_token" },
		]);
		runs = new ApiKeyRunService({
			client,
			tenantId,
			store: new OrchestrationStore(client, tenantId, new WorkCredentialBox(masterKey)),
			keys,
			idempotency: new IdempotencyKeyring({ masterKey }),
			repos: {
				mcpServers: {
					list: async () => registry,
					get: async (_scope: unknown, mcpServerId: string) =>
						registry.find((entry) => entry.mcpServerId === mcpServerId),
				},
			} as unknown as ConstructorParameters<typeof ApiKeyRunService>[0]["repos"],
		});
		const handler = createApiKeyHttp({ keys, runs, isAdmin: () => true });
		server = createServer((request, response) => {
			void Promise.resolve(handler(request, response)).then((handled: boolean) => {
				if (!handled && !response.headersSent) {
					response.writeHead(599);
					response.end("unclaimed");
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no listen address");
		base = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	async function call(
		method: string,
		path: string,
		options: { authorization?: string; body?: unknown; idempotencyKey?: string } = {},
	): Promise<{ status: number; text: string; data: unknown }> {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: {
				...(options.authorization === undefined ? {} : { authorization: options.authorization }),
				...(options.body === undefined ? {} : { "content-type": "application/json" }),
				...(options.idempotencyKey === undefined ? {} : { "idempotency-key": options.idempotencyKey }),
			},
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		});
		const text = await response.text();
		let data: unknown = text;
		if (text !== "") {
			try {
				data = JSON.parse(text) as unknown;
			} catch {
				// Marker body from the "not claimed" branch is plain text.
			}
		}
		return { status: response.status, text, data };
	}

	async function serversFor(token: string): Promise<{
		status: number;
		text: string;
		data: unknown;
		servers: ApiKeyMcpServerSummary[];
	}> {
		const result = await call("GET", "/api/aaas/v1/mcp-servers", { authorization: `Bearer ${token}` });
		const payload = result.data as { data?: ApiKeyMcpServerSummary[] };
		return { ...result, servers: payload.data ?? [] };
	}

	async function detailFor(token: string, serverId: string): Promise<{
		status: number;
		text: string;
		data: unknown;
		detail?: ApiKeyMcpServerView;
	}> {
		const result = await call("GET", `/api/aaas/v1/mcp-servers/${serverId}`, { authorization: `Bearer ${token}` });
		const payload = result.data as { data?: ApiKeyMcpServerView };
		return { ...result, detail: payload.data };
	}

	test("a Key sees every configured Server that is available in the registry", async () => {
		const created = await keys.create("scope-key");
		const result = await serversFor(created.token);
		expect(result.status).toBe(200);
		// Alpha and Beta are enabled in the registry; Gamma is disabled and Delta is not registered.
		expect(result.servers.map((server) => server.server_id)).toEqual([serverAlpha, serverBeta]);
		expect(result.text).not.toContain(serverGamma);
		expect(result.text).not.toContain(serverDelta);
		expect(result.text).not.toContain("Gamma Server");
	});

	test("the list returns only Server summaries and matches detail tool counts", async () => {
		const created = await keys.create("summary-shape");
		const result = await serversFor(created.token);
		expect(result.status).toBe(200);
		expect(result.servers.map((server) => Object.keys(server).sort())).toEqual(
			result.servers.map(() =>
				[
					"server_id",
					"name",
					"description",
					"revision",
					"tool_count",
					"authentication",
					"credential_requirements",
				].sort(),
			),
		);
		for (const summary of result.servers) {
			expect(result.text).not.toContain(summary.server_id === serverAlpha ? "Look up one account" : "Echo the text back");
			const detail = await detailFor(created.token, summary.server_id);
			expect(detail.status).toBe(200);
			expect(detail.detail?.tools).toHaveLength(summary.tool_count);
			expect(detail.detail?.revision).toBe(summary.revision);
		}
	});

	test("every Key sees the same configuration-defined metadata", async () => {
		const first = await keys.create("scope-key-a");
		const second = await keys.create("scope-key-b");
		const firstView = await serversFor(first.token);
		const secondView = await serversFor(second.token);
		expect(firstView.servers.map((server) => server.server_id)).toEqual([serverAlpha, serverBeta]);
		expect(secondView.servers.map((server) => server.server_id)).toEqual([serverAlpha, serverBeta]);
		// Metadata is configuration-scoped, not per-Key: both Keys see the same requirements.
		expect(firstView.servers.map((server) => server.credential_requirements)).toEqual(
			secondView.servers.map((server) => server.credential_requirements),
		);
		for (const token of [first.token, second.token]) {
			const alphaDetail = await detailFor(token, serverAlpha);
			const betaDetail = await detailFor(token, serverBeta);
			expect(alphaDetail.detail?.required_credentials.map((entry) => entry.credential_id)).toEqual([
				"connection",
				"account_token",
			]);
			expect(betaDetail.detail?.required_credentials.map((entry) => entry.credential_id)).toEqual(["echo_token"]);
			expect(alphaDetail.text).not.toContain("acct-secret");
			expect(betaDetail.text).not.toContain("acct-secret");
		}
	});

	test("metadata exposes Server and tool descriptions from the frozen configuration", async () => {
		const created = await keys.create("metadata-key");
		const result = await serversFor(created.token);
		const alpha = result.servers.find((server) => server.server_id === serverAlpha);
		expect(alpha?.name).toBe("Alpha Server");
		expect(alpha?.authentication).toBe("bearer");
		// The platform stores no Server description, so it stays null rather than invented.
		expect(alpha?.description).toBeNull();
		const detail = await detailFor(created.token, serverAlpha);
		expect(detail.detail?.tools.map((tool) => tool.name)).toEqual(["lookup", "search"]);
		// FR-003 requires the tool description to be part of the metadata.
		expect(detail.detail?.tools.find((tool) => tool.name === "lookup")?.description).toBe("Look up one account");
		expect(detail.detail?.tools.find((tool) => tool.name === "search")?.description).toBe("Search accounts");
	});

	test("a platform-registered sensitive parameter is removed from the public schema", async () => {
		const created = await keys.create("schema-redaction");
		const detail = await detailFor(created.token, serverAlpha);
		const lookup = detail.detail?.tools.find((tool) => tool.name === "lookup");
		expect(lookup).toBeDefined();
		const schema = lookup?.input_schema as { properties: Record<string, unknown>; required: readonly string[] };
		expect(Object.keys(schema.properties)).toEqual(["query"]);
		expect(schema.properties.account).toBeUndefined();
		expect(schema.required).toEqual(["query"]);
		// A tool without a registered sensitive parameter keeps its complete schema.
		const search = detail.detail?.tools.find((tool) => tool.name === "search");
		const searchSchema = search?.input_schema as {
			properties: Record<string, unknown>;
			required: readonly string[];
		};
		expect(Object.keys(searchSchema.properties)).toEqual(["keyword"]);
		expect(searchSchema.required).toEqual(["keyword"]);
	});

	test("required_credentials lists the connection credential and the registered tool credentials", async () => {
		const created = await keys.create("credential-requirements");
		const detail = await detailFor(created.token, serverAlpha);
		expect(detail.detail?.required_credentials).toEqual([
			{ credential_id: "connection", scope: "connection", required: true },
			{
				credential_id: "account_token",
				scope: "tool",
				tool_name: "lookup",
				parameter: "account",
				required: true,
			},
		]);
	});

	test("a Server with authentication none has no connection credential requirement", async () => {
		const created = await keys.create("no-connection-credential");
		const detail = await detailFor(created.token, serverBeta);
		expect(detail.detail?.authentication).toBe("none");
		expect(detail.detail?.required_credentials.filter((entry) => entry.scope === "connection")).toEqual([]);
		expect(detail.detail?.required_credentials).toEqual([
			{ credential_id: "echo_token", scope: "tool", tool_name: "echo", parameter: "text", required: true },
		]);
	});

	test("detail rejects Servers outside the effective scope without revealing them", async () => {
		const created = await keys.create("detail-scope");
		for (const serverId of [serverGamma, serverDelta, `mcp_${randomUUID()}`]) {
			const rejected = await detailFor(created.token, serverId);
			expect(rejected.status).toBe(404);
			expect((rejected.data as { error: { code: string } }).error.code).toBe("NOT_FOUND");
			expect(rejected.text).not.toContain("Gamma Server");
		}
	});

	test("tool scope follows the Key's effective configuration version", async () => {
		const platform = await serversFor((await keys.create("platform-follower")).token);
		const fixed = await keys.create("fixed-version", narrowVersionId);
		const fixedList = await serversFor(fixed.token);
		expect(fixedList.servers.map((server) => server.server_id)).toEqual([serverAlpha]);
		expect(fixedList.servers[0]?.tool_count).toBe(1);
		expect(platform.servers.find((server) => server.server_id === serverAlpha)?.tool_count).toBe(2);
		const fixedDetail = await detailFor(fixed.token, serverAlpha);
		expect(fixedDetail.detail?.tools.map((tool) => tool.name)).toEqual(["lookup"]);
		expect((await detailFor(fixed.token, serverBeta)).status).toBe(404);
	});

	test("the metadata response carries no credential value", async () => {
		const created = await keys.create("no-credential-values");
		const principal = await keys.authenticate(`Bearer ${created.token}`);
		const submitted = await runs.submit(principal, "mcp-credential-values", {
				prompt: "use the alpha server",
				mcp_servers: [serverAlpha],
				credentials: {
					servers: {
						[serverAlpha]: { connection: { credential_id: "connection", value: "conn-secret-123" } },
					},
					tools: { [serverAlpha]: { lookup: { account_token: "acct-secret-456" } } },
				},
		});
		expect(submitted.status).toBe("queued");
		const result = await serversFor(created.token);
		const detail = await detailFor(created.token, serverAlpha);
		expect(result.status).toBe(200);
		expect(detail.status).toBe(200);
		for (const response of [result, detail]) {
			expect(response.text).not.toContain("conn-secret-123");
			expect(response.text).not.toContain("acct-secret-456");
			expect(response.text).not.toContain(Buffer.from("conn-secret-123", "utf8").toString("base64"));
			expect(response.text).not.toContain(Buffer.from("acct-secret-456", "utf8").toString("base64"));
			// No field of the response carries a secret; credential IDs are identifiers, not values.
			for (const text of collectStrings(response.data)) {
				expect(text).not.toContain("conn-secret-123");
				expect(text).not.toContain("acct-secret-456");
			}
		}
		expect(result.text).toContain("credential_requirements");
		expect(result.text).not.toContain("account_token");
		expect(detail.text).toContain("connection");
		expect(detail.text).toContain("account_token");
	});

	test("a Server unavailable in the registry cannot be selected for a Run", async () => {
		const created = await keys.create("unavailable-selection");
		const principal = await keys.authenticate(`Bearer ${created.token}`);
		// Gamma is disabled in the registry, Delta is not registered at all.
		for (const serverId of [serverGamma, serverDelta]) {
			await expect(runs.submit(principal, `unavailable-${serverId}`, {
					prompt: "use an unavailable server",
					mcp_servers: [serverId],
					credentials: { servers: {}, tools: {} },
			})).rejects.toMatchObject({ status: 400, code: "INVALID_MCP_SELECTION" });
		}
	});
});
