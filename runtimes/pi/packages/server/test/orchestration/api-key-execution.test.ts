/**
 * T023 / T035 / T039 / T040 acceptance for new-Key Runs.
 *
 * - T023: the Run's frozen capability snapshot is the only executable capability.
 * - T035: a fatal MCP boundary hit ends the Run as failed with the fixed code.
 * - T039: concurrent Runs never share input, snapshot, credentials or results.
 * - T040: a credential echo in an MCP result fails the Run and never leaks.
 *
 * The fixture is an isolated Postgres schema, a fake model seam and real
 * loopback MCP servers. No provider API, no real credential and no external
 * service is involved; every secret is a placeholder fixture value.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { AccessTokenService } from "../../src/embed/auth/access-token.ts";
import { ConversationService } from "../../src/embed/conversations/service.ts";
import { createEmbedServices } from "../../src/embed/start.ts";
import { ApiKeyStore } from "../../src/orchestration/api-key.ts";
import {
	CREDENTIAL_EXPIRED,
	createTaskBoundary,
	MCP_AUTH_FAILED,
	MCP_RESULT_BLOCKED,
	McpRunGuard,
} from "../../src/orchestration/api-key-boundary.ts";
import type { CapabilitySnapshot } from "../../src/orchestration/api-key-contracts.ts";
import { IdempotencyKeyring } from "../../src/orchestration/api-key-idempotency.ts";
import { ApiKeyRunService } from "../../src/orchestration/api-key-runs.ts";
import { composeOrchestration } from "../../src/orchestration/compose.ts";
import { OrchestrationError, settingsSchema } from "../../src/orchestration/contracts.ts";
import { WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { startOrchestrationDispatcher } from "../../src/orchestration/dispatcher.ts";
import { orchestrationExecutionConfigResolver } from "../../src/orchestration/execution-configuration.ts";
import { createBoundaryExecutionSource, createOrchestrationExecutionSource } from "../../src/orchestration/execution-source.ts";
import { protectTool } from "../../src/orchestration/protected-tool.ts";
import { OrchestrationService } from "../../src/orchestration/service.ts";
import { type ClaimedAssignment, OrchestrationStore } from "../../src/orchestration/store.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { ControlService } from "../../src/publishing/control/service.ts";
import {
	type ConversationId,
	type McpServerId,
	newMcpSecretId,
	type PrincipalId,
	type PublishedAppVersionId,
	type TenantId,
	type TurnId,
} from "../../src/publishing/domain/ids.ts";
import { mcpResourceToolName } from "../../src/publishing/mcp/resource-content.ts";
import { createMcpRuntimeToolFactory } from "../../src/publishing/mcp/runtime-tools.ts";
import { McpSecretBox } from "../../src/publishing/mcp/secret-box.ts";
import { PreviewTicketService } from "../../src/publishing/preview-ticket.ts";
import { canonicalJson, sha256Hex } from "../../src/publishing/runtime-spec/hash.ts";
import { parseRuntimeSpec, type RuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type { RuntimeSessionFactory } from "../../src/runtime/pi-runtime-adapter.ts";
import type { ScopeContext } from "../../src/runtime/scope-context.ts";
import type { TurnExecutor } from "../../src/runtime/turn-executor.ts";
import type { LlmCallTrace, PiSessionRuntime, PromptInput } from "../../src/types.ts";

const PG_URL =
	process.env.PI_ORCHESTRATION_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const SCHEMA = `aaas_exec_${process.pid}_${Date.now().toString(36)}`;

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

/** Placeholder fixture secrets only; never a real credential. */
const ALPHA_CONNECTION = "conn-secret-123";
const ALPHA_TOKEN = "alpha-secret-456";
const BETA_CONNECTION = "conn-secret-789";
const BETA_TOKEN = "beta-secret-012";

interface FakeToolSpec {
	readonly name: string;
	readonly inputSchema: Record<string, unknown>;
}

interface FakeMcpCall {
	readonly tool: string;
	readonly args: Record<string, unknown>;
}

interface FakeResourceSpec {
	readonly uri: string;
	readonly text?: string;
	readonly blob?: string;
}

interface FakeMcp {
	readonly endpoint: string;
	readonly calls: FakeMcpCall[];
	readonly authorizations: (string | null)[];
	respond(handler: (tool: string, args: Record<string, unknown>) => Promise<unknown>): void;
	rejectConnections(reject: boolean): void;
	/** Deterministic JSON-RPC error on initialize, before any Tool call. */
	failInitializeWith(message: string | undefined): void;
	/** Deterministic JSON-RPC error instead of a tools/call result. */
	failToolCallWith(message: string | undefined): void;
	/** Drops the recorded calls and Authorization headers of earlier tests. */
	reset(): void;
	close(): Promise<void>;
}

/**
 * A real MCP server on loopback HTTP. The tool result is produced by the
 * responder, so a test can return an arbitrary (including unsafe) payload.
 */
async function startFakeMcp(
	name: string,
	tools: readonly FakeToolSpec[],
	resources: readonly FakeResourceSpec[] = [],
): Promise<FakeMcp> {
	const calls: FakeMcpCall[] = [];
	const authorizations: (string | null)[] = [];
	let responder: (tool: string, args: Record<string, unknown>) => Promise<unknown> = async (tool, args) => ({
		content: [{ type: "text", text: `${tool} ${JSON.stringify({ target: args.target ?? null })}` }],
	});
	let rejectAll = false;
	let initializeError: string | undefined;
	let toolCallError: string | undefined;
	const handler = createMcpHandler(
		() => {
			const mcp = new McpServer({ name, version: "1.0.0" });
			for (const resource of resources)
				mcp.registerResource(
					resource.uri,
					resource.uri,
					{ title: resource.uri, mimeType: "text/plain" },
					async (uri) => ({
						contents: [
							resource.blob === undefined
								? { uri: uri.href, text: resource.text ?? "" }
								: { uri: uri.href, blob: resource.blob, mimeType: "application/octet-stream" },
						],
					}),
				);
			for (const tool of tools)
				mcp.registerTool(
					tool.name,
					{
						description: `acceptance tool ${tool.name}`,
						inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema),
					},
					async (args) => {
						const parsed = (args ?? {}) as Record<string, unknown>;
						calls.push({ tool: tool.name, args: parsed });
						return (await responder(tool.name, parsed)) as CallToolResult;
					},
				);
			return mcp;
		},
		{ responseMode: "json", keepAliveMs: 0 },
	);
	const server = createServer((req, res) => {
		authorizations.push(typeof req.headers.authorization === "string" ? req.headers.authorization : null);
		if (rejectAll) {
			res.writeHead(401).end();
			return;
		}
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			// A JSON-RPC error response is the deterministic way to exercise the
			// handshake and remote Tool-error delivery channels without a real Server.
			try {
				const rawBody = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
				const message = rawBody ? (JSON.parse(rawBody) as { id?: unknown; method?: unknown }) : undefined;
				const failure =
					message?.method === "initialize"
						? initializeError
						: message?.method === "tools/call"
							? toolCallError
							: undefined;
				if (failure !== undefined) {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: message?.id ?? null,
							error: { code: -32000, message: failure },
						}),
					);
					return;
				}
			} catch {
				// Not a JSON-RPC body; continue to the real handler.
			}
			const address = server.address();
			if (!address || typeof address === "string") {
				res.writeHead(500).end();
				return;
			}
			const headers = new Headers();
			for (const [header, value] of Object.entries(req.headers))
				if (typeof value === "string") headers.set(header, value);
			const response = await handler.fetch(
				new Request(`http://127.0.0.1:${address.port}${req.url ?? "/"}`, {
					method: req.method,
					headers,
					body: chunks.length ? Buffer.concat(chunks) : undefined,
				}),
			);
			res.statusCode = response.status;
			response.headers.forEach((value, header) => {
				res.setHeader(header, value);
			});
			res.end(Buffer.from(await response.arrayBuffer()));
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fake MCP server is not listening");
	return {
		endpoint: `http://127.0.0.1:${address.port}/mcp`,
		calls,
		authorizations,
		respond: (next) => {
			responder = next;
		},
		rejectConnections: (reject) => {
			rejectAll = reject;
		},
		failInitializeWith: (message) => {
			initializeError = message;
		},
		failToolCallWith: (message) => {
			toolCallError = message;
		},
		reset: () => {
			calls.length = 0;
			authorizations.length = 0;
		},
		close: async () => {
			await handler.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

interface ModelPlan {
	/**
	 * Tool names the fake model calls, in order. `"*"` means the first MCP Tool
	 * the resolved capability snapshot exposes. A name that is not exposed is
	 * skipped, exactly like a model that cannot call an unavailable Tool.
	 * `{ name, args }` lets a plan call a Tool (for example a resource read) with
	 * explicit arguments instead of the default `target`.
	 */
	readonly calls: readonly (string | { readonly name: string; readonly args?: Readonly<Record<string, unknown>> })[];
	/** Delay after the tool calls; a fatal boundary hit must not wait for it. */
	readonly slowMs: number;
	/**
	 * A cooperative model reports the failed Tool call and still authors a
	 * report. The platform must not depend on the model giving up.
	 */
	readonly continueOnToolError?: boolean;
	/** Deterministic hook between two planned Tool calls (for example to expire credentials). */
	readonly afterCall?: (call: { readonly name: string; readonly index: number }) => Promise<void> | void;
}

describe.skipIf(!pgUp)("new-Key Run execution acceptance on isolated Postgres", () => {
	const tenantId = randomUUID();
	const configurationId = randomUUID();
	const versionOneId = randomUUID();
	const versionTwoId = randomUUID();
	const masterKey = new Uint8Array(32).fill(23);
	const serverAUuid = randomUUID();
	const serverBUuid = randomUUID();
	const serverCUuid = randomUUID();
	const serverA = `mcp_${serverAUuid}`;
	const serverB = `mcp_${serverBUuid}`;
	const serverC = `mcp_${serverCUuid}`;

	let client: PostgresClient;
	let store: OrchestrationStore;
	let keys: ApiKeyStore;
	let runs: ApiKeyRunService;
	let service: OrchestrationService;
	let guard: McpRunGuard;
	let resolver: ReturnType<typeof orchestrationExecutionConfigResolver>;
	let toolFactory: ReturnType<typeof createMcpRuntimeToolFactory>;
	let probeFactory: ReturnType<typeof createMcpRuntimeToolFactory>;
	let fakeAlpha: FakeMcp;
	let fakeBeta: FakeMcp;
	let fakeGamma: FakeMcp;
	let plan: ModelPlan = { calls: [], slowMs: 0 };

	const alphaTools: readonly FakeToolSpec[] = [
		{
			name: "alpha_lookup",
			inputSchema: {
				type: "object",
				properties: { alpha_token: { type: "string" }, target: { type: "string" } },
				required: ["alpha_token", "target"],
				additionalProperties: false,
			},
		},
		{ name: "alpha_status", inputSchema: { type: "object", properties: {} } },
	];
	const betaTools: readonly FakeToolSpec[] = [
		{
			name: "beta_lookup",
			inputSchema: {
				type: "object",
				properties: { beta_token: { type: "string" }, target: { type: "string" } },
				required: ["beta_token", "target"],
				additionalProperties: false,
			},
		},
		{ name: "beta_status", inputSchema: { type: "object", properties: {} } },
	];
	const gammaTools: readonly FakeToolSpec[] = [
		{ name: "gamma_status", inputSchema: { type: "object", properties: { target: { type: "string" } } } },
		{ name: "gamma_probe", inputSchema: { type: "object", properties: {} } },
	];

	function runtimeSpecFor(
		versionId: string,
		servers: readonly {
			readonly publicId: string;
			readonly endpoint: string;
			readonly authentication: "none" | "bearer";
			readonly tools: readonly FakeToolSpec[];
		}[],
	): RuntimeSpec {
		const parsed = parseRuntimeSpec({
			schemaVersion: 1,
			publishedAppVersionId: `orv_${versionId}`,
			agent: { systemPrompt: "platform prompt", model: { provider: "fake", modelId: "fake-model" } },
			capabilities: {
				mcpServers: servers.map((server) => ({
					mcpServerId: server.publicId,
					revision: 1,
					transport: "streamable_http",
					endpoint: server.endpoint,
					authentication: server.authentication,
					tools: server.tools.map((tool) => ({
						name: tool.name,
						description: null,
						inputSchema: tool.inputSchema,
						inputSchemaHash: sha256Hex(canonicalJson(tool.inputSchema)),
					})),
				})),
			},
			contextPolicy: { toolResultMaxBytes: 65_536 },
			runtimePolicy: { profile: "chat-only" },
			theme: {},
			securityPolicyVersion: "sp_001",
		});
		if (!parsed.ok) throw new Error(`invalid fixture spec: ${parsed.errors.join("; ")}`);
		return parsed.spec;
	}

	async function insertVersion(versionId: string, sourceDraftRevision: number, spec: RuntimeSpec): Promise<void> {
		await client.run(
			`insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash)
			 values ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7)`,
			versionId,
			tenantId,
			configurationId,
			{
				modelId: "fake-model",
				systemPrompt: "platform prompt",
				parameters: {},
				mcpServers: spec.capabilities.mcpServers.map((server) => ({
					mcpServerId: server.mcpServerId,
					revision: server.revision,
					toolNames: server.tools.map((tool) => tool.name),
				})),
				skills: [],
			},
			sourceDraftRevision,
			spec,
			sha256Hex(canonicalJson(spec)),
		);
	}

	async function insertMcpServer(id: string, name: string, endpoint: string, authentication: "none" | "bearer") {
		await client.run(
			"insert into mcp_servers(id,tenant_id,name,status,current_revision,created_by) values ($1,$2,$3,'enabled',1,$2)",
			id,
			tenantId,
			name,
		);
		await client.run(
			"insert into mcp_server_revisions(mcp_server_id,tenant_id,revision,transport,endpoint,authentication,created_by) values ($1,$2,1,'streamable_http',$3,$4,$2)",
			id,
			tenantId,
			endpoint,
			authentication,
		);
	}

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		await client.run("insert into tenants(id,name,status) values ($1,'execution-test','active')", tenantId);
		await client.run(
			`insert into orchestration_configurations(id,tenant_id,name,draft,draft_revision) values ($1,$2,'platform','{}'::jsonb,1)`,
			configurationId,
			tenantId,
		);

		fakeAlpha = await startFakeMcp("alpha", alphaTools, [
			{ uri: "test://alpha-safe", text: "safe resource body" },
			{ uri: "test://alpha-echo", text: `resource ${ALPHA_TOKEN}` },
			{ uri: "test://alpha-binary", blob: Buffer.from("binary resource", "utf8").toString("base64") },
		]);
		fakeBeta = await startFakeMcp("beta", betaTools);
		fakeGamma = await startFakeMcp("gamma", gammaTools);
		await insertMcpServer(serverAUuid, "alpha-mcp", fakeAlpha.endpoint, "bearer");
		await insertMcpServer(serverBUuid, "beta-mcp", fakeBeta.endpoint, "bearer");
		await insertMcpServer(serverCUuid, "gamma-mcp", fakeGamma.endpoint, "none");

		const versionOne = runtimeSpecFor(versionOneId, [
			{ publicId: serverA, endpoint: fakeAlpha.endpoint, authentication: "bearer", tools: alphaTools },
			{ publicId: serverB, endpoint: fakeBeta.endpoint, authentication: "bearer", tools: betaTools },
		]);
		await insertVersion(versionOneId, 1, versionOne);
		const versionTwo = runtimeSpecFor(versionTwoId, [
			{ publicId: serverA, endpoint: fakeAlpha.endpoint, authentication: "bearer", tools: alphaTools },
			{ publicId: serverB, endpoint: fakeBeta.endpoint, authentication: "bearer", tools: betaTools },
			{ publicId: serverC, endpoint: fakeGamma.endpoint, authentication: "none", tools: gammaTools },
		]);
		await insertVersion(versionTwoId, 2, versionTwo);

		keys = new ApiKeyStore(client, tenantId, new Uint8Array(32).fill(41));
		await keys.setPlatformConfiguration(configurationId, versionOneId, [
			{ mcpServerId: serverA, toolName: "alpha_lookup", parameter: "alpha_token", credentialId: "alpha_token" },
			{ mcpServerId: serverB, toolName: "beta_lookup", parameter: "beta_token", credentialId: "beta_token" },
		]);
		store = new OrchestrationStore(client, tenantId, new WorkCredentialBox(masterKey));
		runs = new ApiKeyRunService({
			client,
			tenantId,
			store,
			keys,
			idempotency: new IdempotencyKeyring({ masterKey }),
			repos: createPublishingRepositories(client),
		});
		const repos = createPublishingRepositories(client);
		resolver = orchestrationExecutionConfigResolver(store, repos);
		guard = new McpRunGuard();
		toolFactory = createMcpRuntimeToolFactory({
			repositories: repos,
			// The production credential source: sealed Run credentials, pre-call
			// revalidation and the audit attribution.
			executionSource: createOrchestrationExecutionSource({
				store,
				guard,
				recordAudit: async (record) => {
					await repos.mcpServers.recordCallAudit(record);
				},
			}),
			protectTool,
		});
		// The delivery-layer probe knows the connection credential but not the
		// mapped Tool credential, so the raw return passes the inspection here
		// and only the delivery layer's redaction is observable.
		const probeGuard = new McpRunGuard();
		probeFactory = createMcpRuntimeToolFactory({
			repositories: repos,
			protectTool,
			executionSource: async (scope) => {
				if (scope.turnId === undefined || scope.conversationId === undefined) return undefined;
				const conversationId = scope.conversationId;
				return createBoundaryExecutionSource({
					boundary: createTaskBoundary({
						keyId: "delivery-probe",
						values: { [`srv:${serverA}:connection`]: ALPHA_CONNECTION },
						maxBytes: scope.limits.toolResultMaxBytes,
						guard: probeGuard,
						conversationId: scope.conversationId,
					}),
					owner: { kind: "conversation", conversationId },
					toolBindings: async (serverId, toolName) =>
						(await store.toolBindings(conversationId, scope.turnId)).filter(
							(binding) => binding.mcpServerId === serverId && binding.toolName === toolName,
						),
					toolCredentials: async (serverId, toolName, credentialNames) =>
						(await store.credentials(conversationId, scope.turnId!)).toolValues(
							serverId,
							toolName,
							credentialNames,
						),
				});
			},
		});

		const aborts = new Map<string, AbortController>();
		const turnExecutor: TurnExecutor = async (input) => {
			const controller = new AbortController();
			aborts.set(input.scope.conversationId, controller);
			try {
				// The production executor persists the provider-boundary context
				// (conversation-executor.ts:24-27); the fake model does the same so
				// the persisted model context can be inspected.
				await store.recordLlmTrace(input.scope.conversationId, input.scope.turnId!, {
					kind: "request",
					callIndex: 1,
					model: { provider: input.spec.agent.model.provider, id: input.spec.agent.model.modelId },
					context: {
						systemPrompt: input.spec.agent.systemPrompt,
						messages: [{ role: "user", content: input.text, timestamp: Date.now() }],
					},
				});
				const tools = await toolFactory(input.spec, input.scope);
				const target = input.spec.agent.systemPrompt;
				const texts: string[] = [];
				for (const [index, planned] of plan.calls.entries()) {
					const name = typeof planned === "string" ? planned : planned.name;
					const args = typeof planned === "string" ? { target } : { ...planned.args };
					const tool = name === "*" ? tools[0] : tools.find((candidate) => candidate.name === name);
					if (!tool) continue;
					try {
						const result = await tool.execute(
							`call-${tool.name}`,
							args,
							controller.signal,
							undefined,
							undefined as never,
						);
						for (const block of result.content) if (block.type === "text") texts.push(block.text);
					} catch (error) {
						if (plan.continueOnToolError !== true) throw error;
						texts.push(`tool-error: ${error instanceof Error ? error.message : String(error)}`);
					}
					// A deterministic seam between two Tool calls, used to change the
					// credential lifetime while the Run is executing.
					await plan.afterCall?.({ name: tool.name, index });
				}
				if (plan.slowMs > 0) await waitForAbort(controller.signal, plan.slowMs);
				return { ok: true, outputText: texts.join("\n") };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			} finally {
				aborts.delete(input.scope.conversationId);
			}
		};
		turnExecutor.cancel = async (conversationId) => {
			const controller = aborts.get(conversationId);
			if (!controller) return false;
			controller.abort();
			return true;
		};

		const conversations = new ConversationService({
			repositories: repos,
			resolveExecutionConfiguration: resolver,
			turnExecutor,
		});
		const control = new ControlService({
			repositories: repos,
			catalog: { tools: [], knowledgeBases: [], models: [{ provider: "fake", modelId: "fake-model" }] },
			embedBaseUrl: "https://embed.test",
		});
		service = new OrchestrationService(store, control, repos, conversations, guard);
	}, 60000);

	afterAll(async () => {
		await fakeAlpha?.close();
		await fakeBeta?.close();
		await fakeGamma?.close();
		if (client) {
			await client.run(`drop schema if exists ${SCHEMA} cascade`);
			await client.close();
		}
	});

	function waitForAbort(signal: AbortSignal, ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			if (signal.aborted) {
				resolve();
				return;
			}
			const timer = setTimeout(resolve, ms);
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});
	}

	/**
	 * Creates and authenticates a Key. The old per-Key server authorisation is gone:
	 * usable Servers come from the platform configuration intersected with each
	 * Run's `mcp_servers` selection, so the second argument is intentionally ignored
	 * (kept only to avoid churn across the many execution fixtures).
	 */
	async function newKey(name: string, _grants: readonly string[] = []) {
		const created = await keys.create(name);
		return keys.authenticate(`Bearer ${created.token}`);
	}

	/**
	 * Claims the assignments of the given Runs. The queue is shared by every
	 * Run of the tenant, so unrelated queued assignments are completed instead
	 * of being left in the way of the next claim.
	 */
	async function claimRuns(runIds: readonly string[]): Promise<Map<string, ClaimedAssignment>> {
		const wanted = new Set(runIds);
		const claimed = new Map<string, ClaimedAssignment>();
		for (let attempt = 0; attempt < 20; attempt++) {
			const next = await store.claim();
			if (!next) break;
			if (wanted.has(next.workItemId)) claimed.set(next.workItemId, next);
			else await store.complete(next.id, "superseded", null);
		}
		for (const runId of runIds)
			if (!claimed.has(runId)) throw new Error(`could not claim the assignment of ${runId}`);
		return claimed;
	}

	async function resolveFor(claimed: ClaimedAssignment) {
		const scope = {
			tenantId: tenantId as TenantId,
			publishedAppId: null,
			integrationId: claimed.integrationId,
			principalId: claimed.principalId as PrincipalId,
		};
		const record = await createPublishingRepositories(client).conversations.get(
			scope,
			claimed.conversationId as ConversationId,
		);
		if (record === undefined) throw new Error("conversation record missing");
		const resolved = await resolver(scope, record, claimed.turnId as TurnId);
		if (resolved === undefined) throw new Error("execution configuration was not resolved");
		const parsed = parseRuntimeSpec(resolved.runtimeSpec);
		if (!parsed.ok) throw new Error(`resolved spec invalid: ${parsed.errors.join("; ")}`);
		return { scope, record, resolved, spec: parsed.spec };
	}

	function scopeFor(claimed: ClaimedAssignment, versionKey: string): ScopeContext {
		return {
			tenantId: tenantId as TenantId,
			publishedAppId: null,
			publishedAppVersionId: versionKey as PublishedAppVersionId,
			integrationId: claimed.integrationId,
			executionSource: { kind: "orchestration", ownerId: claimed.integrationId, versionId: versionKey },
			principalId: claimed.principalId as PrincipalId,
			conversationId: claimed.conversationId as ConversationId,
			turnId: claimed.turnId as TurnId,
			limits: {
				maxTurns: 100,
				maxContextTokens: 100_000,
				toolResultMaxBytes: 65_536,
				turnTimeoutMs: 120_000,
				maxConcurrentTurnsPerConversation: 1,
			},
		};
	}

	async function storedSnapshot(runId: string) {
		const [row] = await client.run(
			"select capability_snapshot,capability_snapshot_hash from orchestration_work_items where tenant_id=$1 and id=$2",
			tenantId,
			runId,
		);
		if (!row) throw new Error("work item missing");
		return { snapshot: row.capability_snapshot as CapabilitySnapshot, hash: String(row.capability_snapshot_hash) };
	}

	/** Expire the Run credential with the database clock, exactly like the dispatcher sweep sees it. */
	async function expireCredentials(runId: string): Promise<void> {
		await client.run(
			"update orchestration_credentials set expires_at=now()-interval '1 second' where work_item_id=$1",
			runId,
		);
	}

	async function runConversationId(runId: string): Promise<string> {
		const [row] = await client.run(
			"select conversation_id from orchestration_work_items where tenant_id=$1 and id=$2",
			tenantId,
			runId,
		);
		if (!row) throw new Error("work item missing");
		return String(row.conversation_id);
	}

	/** Every persisted event and provider-boundary trace of one conversation, as one searchable string. */
	async function persistedText(conversationId: string): Promise<string> {
		const events = await client.run(
			"select coalesce(payload::text,'') as payload from conversation_events where tenant_id=$1 and conversation_id=$2",
			tenantId,
			conversationId,
		);
		const traces = await client.run(
			`select coalesce(request_payload::text,'')||coalesce(response_payload::text,'') as payload
			 from orchestration_llm_calls where tenant_id=$1 and conversation_id=$2`,
			tenantId,
			conversationId,
		);
		return JSON.stringify([...events, ...traces]);
	}

	/** The stored credential row of one Run; `sealed` is the JSONB ciphertext (or the `{}` tombstone). */
	async function credentialRow(runId: string): Promise<{ id: string; sealed: Record<string, unknown> }> {
		const [row] = await client.run(
			"select id,sealed from orchestration_credentials where tenant_id=$1 and work_item_id=$2",
			tenantId,
			runId,
		);
		if (!row) throw new Error("credential row missing");
		return { id: String(row.id), sealed: row.sealed as Record<string, unknown> };
	}

	/**
	 * Executes one claimed Run exactly like the dispatcher does
	 * (dispatcher.ts:110-124) and returns the outcome of the execution.
	 */
	async function executeClaimed(claimed: ClaimedAssignment) {
		try {
			const report = await service.execute(claimed);
			await store.complete(claimed.id, report, null);
			return { ok: true as const, report };
		} catch (error) {
			const code = error instanceof OrchestrationError ? error.code : "EXECUTION_FAILED";
			const message = error instanceof Error ? error.message : String(error);
			await store.complete(claimed.id, null, code);
			return { ok: false as const, code, message };
		}
	}

	test("T023: a Run that selects one Server exposes only that Server's tools", async () => {
		const principal = await newKey("t023-single", [serverA, serverB]);
		const accepted = await runs.submit(principal, "t023-single", {
			prompt: "只允许使用 alpha",
			mcp_servers: [serverA],
			credentials: {
				servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
				tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
			},
		});
		const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
		const { resolved, spec } = await resolveFor(claimed);
		expect(spec.capabilities.mcpServers).toHaveLength(1);
		expect(spec.capabilities.mcpServers[0]?.mcpServerId).toBe(serverA);
		expect(spec.capabilities.mcpServers[0]?.tools.map((tool) => tool.name)).toEqual(["alpha_lookup", "alpha_status"]);
		expect(resolved.audit.capabilitySnapshotHash).toBeTruthy();

		const { snapshot, hash } = await storedSnapshot(accepted.run_id);
		expect(snapshot.servers.map((server) => server.serverId)).toEqual([serverA]);
		expect(snapshot.servers[0]?.tools.map((tool) => tool.name)).toEqual(["alpha_lookup", "alpha_status"]);
		expect(sha256Hex(canonicalJson(snapshot))).toBe(hash);

		// The model only receives the snapshot's Tools; the other Server is not callable.
		const tools = await toolFactory(spec, scopeFor(claimed, resolved.versionKey));
		expect(tools.map((tool) => tool.name)).toEqual(["alpha_lookup", "alpha_status", mcpResourceToolName(serverA)]);
		expect(tools.map((tool) => tool.name)).not.toContain("beta_lookup");
		await store.complete(claimed.id, "done", null);
	});

	test("T023: an empty Server selection resolves to no MCP capability at all", async () => {
		const principal = await newKey("t023-empty", [serverA, serverB]);
		const accepted = await runs.submit(principal, "t023-empty", { prompt: "不使用任何 MCP", mcp_servers: [] });
		const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
		const { resolved, spec } = await resolveFor(claimed);
		expect(spec.capabilities.mcpServers).toEqual([]);
		const { snapshot } = await storedSnapshot(accepted.run_id);
		expect(snapshot.servers).toEqual([]);
		const tools = await toolFactory(spec, scopeFor(claimed, resolved.versionKey));
		expect(tools).toHaveLength(0);
		expect(tools.map((tool) => tool.name)).toEqual([]);
		await store.complete(claimed.id, "done", null);
	});

	test("T023: an accepted Run keeps its snapshot and a new Run can select the same Server", async () => {
		const principal = await newKey("t023-two-runs");
		const accepted = await runs.submit(principal, "t023-two-runs-before", {
			prompt: "先接受再失权",
			mcp_servers: [serverA],
			credentials: {
				servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
				tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
			},
		});
		const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
		const { spec } = await resolveFor(claimed);
		// The frozen snapshot stays authoritative for an already accepted Run.
		expect(spec.capabilities.mcpServers.map((server) => server.mcpServerId)).toEqual([serverA]);
		await store.complete(claimed.id, "done", null);
		// A new Run of the same Key can still select the Server from the configuration.
		const second = await runs.submit(principal, "t023-two-runs-after", {
			prompt: "配置内再次选择",
			mcp_servers: [serverA],
			credentials: {
				servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
				tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
			},
		});
		expect(second.duplicate).toBe(false);
		expect(second.run_id).not.toBe(accepted.run_id);
	});

	test("T023: a Server added to the platform configuration never enters an existing Run", async () => {
		const principal = await newKey("t023-grown", [serverA, serverB]);
		const accepted = await runs.submit(principal, "t023-grown-before", {
			prompt: "平台扩容之前接受",
			mcp_servers: [serverA],
			credentials: {
				servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
				tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
			},
		});
		// The platform configuration gains another Server after the Run was accepted.
		await keys.setPlatformConfiguration(configurationId, versionTwoId, [
			{ mcpServerId: serverA, toolName: "alpha_lookup", parameter: "alpha_token", credentialId: "alpha_token" },
			{ mcpServerId: serverB, toolName: "beta_lookup", parameter: "beta_token", credentialId: "beta_token" },
		]);
		const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
		const { spec } = await resolveFor(claimed);
		const { snapshot } = await storedSnapshot(accepted.run_id);
		expect(spec.capabilities.mcpServers.map((server) => server.mcpServerId)).toEqual([serverA]);
		expect(spec.capabilities.mcpServers.map((server) => server.mcpServerId)).not.toContain(serverC);
		for (const server of spec.capabilities.mcpServers)
			expect(snapshot.servers.map((entry) => entry.serverId)).toContain(server.mcpServerId);
		await store.complete(claimed.id, "done", null);

		// A Run accepted afterwards may use the new Server, which proves the
		// platform configuration really changed.
		const grown = await newKey("t023-grown-next", [serverA, serverB, serverC]);
		const next = await runs.submit(grown, "t023-grown-after", { prompt: "平台扩容之后接受", mcp_servers: [serverC] });
		const nextClaimed = (await claimRuns([next.run_id])).get(next.run_id)!;
		const nextSpec = (await resolveFor(nextClaimed)).spec;
		expect(nextSpec.capabilities.mcpServers.map((server) => server.mcpServerId)).toEqual([serverC]);
		await store.complete(nextClaimed.id, "done", null);
	});

	test("T035: an MCP result that echoes the Run's own credential ends the Run as failed", async () => {
		const principal = await newKey("t035-blocked", [serverA]);
		const accepted = await runs.submit(principal, "t035-blocked", {
			prompt: "回显凭据",
			mcp_servers: [serverA],
			credentials: {
				servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
				tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
			},
		});
		fakeAlpha.respond(async () => ({ content: [{ type: "text", text: `leaked ${ALPHA_TOKEN}` }] }));
		plan = { calls: ["alpha_lookup"], slowMs: 15_000 };
		let releaseCancel: (() => void) | undefined;
		const cancelGate = new Promise<void>((resolve) => {
			releaseCancel = resolve;
		});
		const originalCancel = ConversationService.prototype.cancelTurn;
		const cancelSpy = vi.spyOn(ConversationService.prototype, "cancelTurn").mockImplementation(async function (
			this: ConversationService,
			input,
		) {
			await cancelGate;
			return originalCancel.call(this, input);
		});
		const dispatcher = await startOrchestrationDispatcher(service, () => {});
		const started = Date.now();
		try {
			await expect
				.poll(async () => (await runs.run(principal, accepted.run_id)).status, { timeout: 8000 })
				.toBe("failed");
		} finally {
			releaseCancel?.();
			await dispatcher.close();
			cancelSpy.mockRestore();
			plan = { calls: [], slowMs: 0 };
			fakeAlpha.respond(async (tool, args) => ({
				content: [{ type: "text", text: `${tool} ${JSON.stringify({ target: args.target ?? null })}` }],
			}));
		}
		// The Run failed long before the slow model would have finished.
		expect(Date.now() - started).toBeLessThan(15_000);

		const [work] = await client.run(
			"select state from orchestration_work_items where tenant_id=$1 and id=$2",
			tenantId,
			accepted.run_id,
		);
		expect(work?.state).toBe("failed");
		const [assignment] = await client.run(
			"select state,error,report from orchestration_assignments where tenant_id=$1 and work_item_id=$2",
			tenantId,
			accepted.run_id,
		);
		expect(assignment?.state).toBe("failed");
		expect(assignment?.error).toBe(MCP_RESULT_BLOCKED);
		expect(assignment?.report).toBeNull();

		// The turn was aborted: the model never authored a success report.
		const events = await client.run(
			`select e.event_type from conversation_events e
			 join orchestration_work_items w on w.conversation_id=e.conversation_id and w.tenant_id=e.tenant_id
			 where e.tenant_id=$1 and w.id=$2 order by e.sequence`,
			tenantId,
			accepted.run_id,
		);
		expect(events.filter((event) => event.event_type === "assistant/message")).toHaveLength(0);
		expect(events.filter((event) => event.event_type === "turn/end")).toHaveLength(0);

		const view = await runs.run(principal, accepted.run_id);
		expect(view.status).toBe("failed");
		expect(view.error?.code).toBe(MCP_RESULT_BLOCKED);
		expect(view.result).toBeNull();
	}, 30000);

	/**
	 * Contract (T035): a connection authentication failure is a fatal internal
	 * classification. The Run must end as failed with the fixed code
	 * `MCP_AUTH_FAILED` instead of a generic execution failure.
	 *
	 */
	test("T035: a rejected connection credential ends the Run as failed with MCP_AUTH_FAILED", async () => {
		const principal = await newKey("t035-auth", [serverA]);
		const accepted = await runs.submit(principal, "t035-auth", {
			prompt: "连接认证失败",
			mcp_servers: [serverA],
			credentials: {
				servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
				tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
			},
		});
		fakeAlpha.rejectConnections(true);
		// A cooperative model reports the failed Tool call and still authors a
		// report; the platform must end the Run itself.
		plan = { calls: ["alpha_lookup"], slowMs: 0, continueOnToolError: true };
		const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
		const outcome = await executeClaimed(claimed);
		fakeAlpha.rejectConnections(false);
		expect({ ok: outcome.ok, code: outcome.ok ? "" : outcome.code }).toEqual({
			ok: false,
			code: MCP_AUTH_FAILED,
		});
		const view = await runs.run(principal, accepted.run_id);
		expect(view.status).toBe("failed");
		expect(view.error?.code).toBe(MCP_AUTH_FAILED);
	}, 30000);

	test("T035: restart fails closed when a Key Run has a committed turn but no durable fatal marker", async () => {
		const principal = await newKey("t035-recovery-window", []);
		const accepted = await runs.submit(principal, "t035-recovery-window", { prompt: "恢复窗口", mcp_servers: [] });
		const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
		plan = { calls: [], slowMs: 0 };
		await service.execute(claimed);
		const dispatcher = await startOrchestrationDispatcher(service, () => {});
		try {
			const view = await runs.run(principal, accepted.run_id);
			expect(view.status).toBe("failed");
			expect(view.error?.code).toBe("EXECUTION_INTERRUPTED");
			expect(view.result).toBeNull();
		} finally {
			await dispatcher.close();
		}
	});

	test("T035: a task connection credential that is unavailable at runtime ends the Run as failed", async () => {
		const principal = await newKey("t035-auth-runtime", [serverA]);
		const source = await runs.submit(principal, "t035-auth-runtime-source", {
			prompt: "凭据来源 Run",
			mcp_servers: [serverA],
			credentials: {
				servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
				tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
			},
		});
		const { snapshot } = await storedSnapshot(source.run_id);
		// The Run is accepted with the frozen snapshot of a Server that needs a
		// connection credential, but without that credential: the runtime must
		// fail the Run with the fixed authentication code instead of calling
		// the Server without it.
		const [carrierRow] = await client.run("select carrier_integration_id from aaas_key_carriers where tenant_id=$1 and key_id=$2", tenantId, principal.keyId);
		const carrier = await store.getIntegration(String(carrierRow?.carrier_integration_id));
		const accepted = await store.accept(
			carrier,
			{
				eventId: `ak_${randomUUID()}`,
				alarmId: "t035-auth-runtime",
				input: "运行期连接凭据不可用",
				credentials: {},
				credentialExpiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			{
				origin: "aaas",
				taskPrompt: "运行期连接凭据不可用",
				requestContract: "legacy_prompt",
				keyId: principal.keyId,
				capabilitySnapshot: snapshot,
				capabilitySnapshotHash: sha256Hex(canonicalJson(snapshot)),
				settings: { allowedModels: ["fake-model"], bindings: [], queueTimeoutMs: 3_600_000 },
			},
		);
		plan = { calls: ["alpha_lookup"], slowMs: 0 };
		const claimed = (await claimRuns([accepted.workItemId])).get(accepted.workItemId)!;
		const outcome = await executeClaimed(claimed);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false ? outcome.code : "").toBe(MCP_AUTH_FAILED);
		const [assignment] = await client.run(
			"select state,error,report from orchestration_assignments where tenant_id=$1 and work_item_id=$2",
			tenantId,
			accepted.workItemId,
		);
		expect(assignment?.state).toBe("failed");
		expect(assignment?.error).toBe(MCP_AUTH_FAILED);
		expect(assignment?.report).toBeNull();
	});

	test("T035: a non-auth connection failure cannot become a model-authored success", async () => {
		const principal = await newKey("t035-connection", [serverA]);
		fakeAlpha.reset();
		fakeAlpha.failInitializeWith("handshake unavailable");
		plan = { calls: ["alpha_lookup"], slowMs: 0, continueOnToolError: true };
		try {
			const accepted = await runs.submit(principal, "t035-connection", {
				prompt: "连接层失败",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			});
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const outcome = await executeClaimed(claimed);
			// The model handled the Tool error and still authored an answer; the
			// platform must fail the Run with a safe generic code, not report success.
			expect(outcome.ok === false ? outcome.code : "COMPLETED").toBe("EXECUTION_FAILED");
			const view = await runs.run(principal, accepted.run_id);
			expect(view.status).toBe("failed");
			expect(view.error?.code).toBe("EXECUTION_FAILED");
			expect(view.result).toBeNull();
		} finally {
			fakeAlpha.failInitializeWith(undefined);
			plan = { calls: [], slowMs: 0 };
		}
	}, 30000);

	test("one Server credential is injected into two different tools without reaching the model", async () => {
		const serverUuid = randomUUID();
		const serverId = `mcp_${serverUuid}`;
		const versionId = randomUUID();
		const tools: readonly FakeToolSpec[] = [
			{ name: "shared_one", inputSchema: { type: "object", properties: { token_one: { type: "string" }, target: { type: "string" } }, required: ["token_one", "target"], additionalProperties: false } },
			{ name: "shared_two", inputSchema: { type: "object", properties: { token_two: { type: "string" }, target: { type: "string" } }, required: ["token_two", "target"], additionalProperties: false } },
		];
		const mcp = await startFakeMcp("shared", tools);
		try {
			await insertMcpServer(serverUuid, "shared-mcp", mcp.endpoint, "bearer");
			await insertVersion(versionId, 99, runtimeSpecFor(versionId, [{ publicId: serverId, endpoint: mcp.endpoint, authentication: "bearer", tools }]));
			await keys.setVersionBindings(versionId, [
				{ mcpServerId: serverId, toolName: "shared_one", parameter: "token_one", credentialId: "old_one" },
				{ mcpServerId: serverId, toolName: "shared_two", parameter: "token_two", credentialId: "old_two" },
			]);
			const principal = await newKey("shared-two-tools", [serverId]);
			await keys.setKeyVersion(principal.keyId, versionId);
			const body = { prompt: "查询任务", mcp_servers: [serverId], credentials: { servers: { [serverId]: { connection_credential: "connection-secret", tool_credential: "business-secret" } } } };
			const accepted = await runs.submit(principal, "shared-two-tools", body);
			expect(await runs.submit(principal, "shared-two-tools", body)).toMatchObject({ run_id: accepted.run_id, duplicate: true });
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const { resolved, spec } = await resolveFor(claimed);
			const exposed = await toolFactory(spec, scopeFor(claimed, resolved.versionKey));
			for (const tool of exposed.filter((item) => item.name === "shared_one" || item.name === "shared_two")) {
				expect(JSON.stringify(tool.parameters)).not.toContain(tool.name === "shared_one" ? "token_one" : "token_two");
			}
			plan = { calls: ["shared_one", "shared_two"], slowMs: 0 };
			const result = await executeClaimed(claimed);
			expect(result.ok).toBe(true);
			expect(mcp.calls.find((call) => call.tool === "shared_one")?.args.token_one).toBe("business-secret");
			expect(mcp.calls.find((call) => call.tool === "shared_two")?.args.token_two).toBe("business-secret");
			expect(mcp.authorizations).toContain("Bearer connection-secret");
			expect(result.ok && result.report).not.toContain("business-secret");
		} finally { plan = { calls: [], slowMs: 0 }; await mcp.close(); }
	});

	test("shared Server credentials reach only their own mapped tools", async () => {
		const principal = await newKey("shared-server-credentials", [serverA, serverB]);
		fakeAlpha.reset(); fakeBeta.reset();
		const accepted = await runs.submit(principal, "shared-server-credentials", {
			prompt: "执行两个 Server 的工具", mcp_servers: [serverA, serverB],
			credentials: { servers: {
				[serverA]: { connection_credential: ALPHA_CONNECTION, tool_credential: ALPHA_TOKEN },
				[serverB]: { connection_credential: BETA_CONNECTION, tool_credential: BETA_TOKEN },
			} },
		});
		const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
		plan = { calls: ["alpha_lookup", "beta_lookup"], slowMs: 0 };
		const result = await executeClaimed(claimed);
		expect(result.ok).toBe(true);
		expect(fakeAlpha.calls.find((call) => call.tool === "alpha_lookup")?.args.alpha_token).toBe(ALPHA_TOKEN);
		expect(fakeBeta.calls.find((call) => call.tool === "beta_lookup")?.args.beta_token).toBe(BETA_TOKEN);
		expect(JSON.stringify(fakeAlpha.calls)).not.toContain(BETA_TOKEN);
		expect(JSON.stringify(fakeBeta.calls)).not.toContain(ALPHA_TOKEN);
	});

	test("T039: two concurrent Runs of the same Key keep their own snapshot, credentials and result", async () => {
		const principal = await newKey("t039-same-key", [serverA, serverB]);
		fakeAlpha.reset();
		fakeBeta.reset();
		const [first, second] = await Promise.all([
			runs.submit(principal, "t039-same-a", {
				prompt: "任务甲",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			}),
			runs.submit(principal, "t039-same-b", {
				prompt: "任务乙",
				mcp_servers: [serverB],
				credentials: {
					servers: { [serverB]: { connection: { credential_id: "connection", value: BETA_CONNECTION } } },
					tools: { [serverB]: { beta_lookup: { beta_token: BETA_TOKEN } } },
				},
			}),
		]);
		expect(first.run_id).not.toBe(second.run_id);

		const claims = await claimRuns([first.run_id, second.run_id]);
		const claimedFirst = claims.get(first.run_id)!;
		const claimedSecond = claims.get(second.run_id)!;
		const credentialsFirst = await store.credentials(claimedFirst.conversationId, claimedFirst.turnId);
		const credentialsSecond = await store.credentials(claimedSecond.conversationId, claimedSecond.turnId);
		expect(Object.values(credentialsFirst.values)).toEqual([ALPHA_CONNECTION, ALPHA_TOKEN]);
		expect(Object.values(credentialsSecond.values)).toEqual([BETA_CONNECTION, BETA_TOKEN]);
		expect(Object.values(credentialsFirst.values)).not.toContain(BETA_CONNECTION);
		expect(Object.values(credentialsSecond.values)).not.toContain(ALPHA_CONNECTION);

		const firstSpec = (await resolveFor(claimedFirst)).spec;
		const secondSpec = (await resolveFor(claimedSecond)).spec;
		expect(firstSpec.capabilities.mcpServers.map((server) => server.mcpServerId)).toEqual([serverA]);
		expect(secondSpec.capabilities.mcpServers.map((server) => server.mcpServerId)).toEqual([serverB]);

		plan = { calls: ["*"], slowMs: 0 };
		const [outcomeFirst, outcomeSecond] = await Promise.all([
			executeClaimed(claimedFirst),
			executeClaimed(claimedSecond),
		]);
		expect(outcomeFirst.ok).toBe(true);
		expect(outcomeSecond.ok).toBe(true);
		const reportFirst = outcomeFirst.ok ? outcomeFirst.report : "";
		const reportSecond = outcomeSecond.ok ? outcomeSecond.report : "";
		expect(reportFirst).toContain("任务甲");
		expect(reportFirst).not.toContain("任务乙");
		expect(reportSecond).toContain("任务乙");
		expect(reportSecond).not.toContain("任务甲");
		// The transport only ever saw this Run's own credential.
		const alphaCall = fakeAlpha.calls.find((call) => call.tool === "alpha_lookup");
		expect(alphaCall?.args.alpha_token).toBe(ALPHA_TOKEN);
		expect(JSON.stringify(alphaCall?.args)).not.toContain(BETA_TOKEN);
		expect(JSON.stringify(alphaCall?.args)).not.toContain(BETA_CONNECTION);
	});

	test("T039: two concurrent Runs of different Keys keep their own snapshot, credentials and result", async () => {
		const firstPrincipal = await newKey("t039-key-a", [serverA]);
		const secondPrincipal = await newKey("t039-key-b", [serverB]);
		const [first, second] = await Promise.all([
			runs.submit(firstPrincipal, "t039-keys-a", {
				prompt: "甲密钥任务",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			}),
			runs.submit(secondPrincipal, "t039-keys-b", {
				prompt: "乙密钥任务",
				mcp_servers: [serverB],
				credentials: {
					servers: { [serverB]: { connection: { credential_id: "connection", value: BETA_CONNECTION } } },
					tools: { [serverB]: { beta_lookup: { beta_token: BETA_TOKEN } } },
				},
			}),
		]);
		const claims = await claimRuns([first.run_id, second.run_id]);
		const claimedFirst = claims.get(first.run_id)!;
		const claimedSecond = claims.get(second.run_id)!;
		const credentialsFirst = await store.credentials(claimedFirst.conversationId, claimedFirst.turnId);
		const credentialsSecond = await store.credentials(claimedSecond.conversationId, claimedSecond.turnId);
		expect(Object.values(credentialsFirst.values)).toEqual([ALPHA_CONNECTION, ALPHA_TOKEN]);
		expect(Object.values(credentialsSecond.values)).toEqual([BETA_CONNECTION, BETA_TOKEN]);

		plan = { calls: ["*"], slowMs: 0 };
		const [outcomeFirst, outcomeSecond] = await Promise.all([
			executeClaimed(claimedFirst),
			executeClaimed(claimedSecond),
		]);
		const reportFirst = outcomeFirst.ok ? outcomeFirst.report : "";
		const reportSecond = outcomeSecond.ok ? outcomeSecond.report : "";
		expect(reportFirst).toContain("甲密钥任务");
		expect(reportFirst).not.toContain("乙密钥任务");
		expect(reportSecond).toContain("乙密钥任务");
		expect(reportSecond).not.toContain("甲密钥任务");
	});

	test("T039: a Run without business credentials never inherits the credentials of a concurrent Run", async () => {
		const principal = await newKey("t039-no-credential", [serverA, serverC]);
		fakeAlpha.reset();
		fakeGamma.reset();
		const [withCredential, withoutCredential] = await Promise.all([
			runs.submit(principal, "t039-inherit-a", {
				prompt: "带凭据任务",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			}),
			runs.submit(principal, "t039-inherit-b", { prompt: "无凭据任务", mcp_servers: [serverC] }),
		]);
		const inheritClaims = await claimRuns([withCredential.run_id, withoutCredential.run_id]);
		const claimedWith = inheritClaims.get(withCredential.run_id)!;
		const claimedWithout = inheritClaims.get(withoutCredential.run_id)!;
		const credentialsWith = await store.credentials(claimedWith.conversationId, claimedWith.turnId);
		const credentialsWithout = await store.credentials(claimedWithout.conversationId, claimedWithout.turnId);
		expect(Object.values(credentialsWith.values)).toEqual([ALPHA_CONNECTION, ALPHA_TOKEN]);
		expect(credentialsWithout.values).toEqual({});
		expect(Object.values(credentialsWithout.values)).not.toContain(ALPHA_CONNECTION);
		expect(Object.values(credentialsWithout.values)).not.toContain(ALPHA_TOKEN);

		plan = { calls: ["*"], slowMs: 0 };
		await Promise.all([executeClaimed(claimedWith), executeClaimed(claimedWithout)]);
		const gammaCall = fakeGamma.calls.find((call) => call.tool === "gamma_status");
		expect(gammaCall).toBeDefined();
		expect(JSON.stringify(gammaCall?.args)).not.toContain(ALPHA_CONNECTION);
		expect(JSON.stringify(gammaCall?.args)).not.toContain(ALPHA_TOKEN);
		const alphaCall = fakeAlpha.calls.find((call) => call.tool === "alpha_lookup");
		expect(alphaCall?.args.alpha_token).toBe(ALPHA_TOKEN);
	});

	test("T040: a credential echo fails the Run and never reaches result, error, report, calls or context", async () => {
		const principal = await newKey("t040-echo", [serverA]);
		const accepted = await runs.submit(principal, "t040-echo", {
			prompt: "回显原文",
			mcp_servers: [serverA],
			credentials: {
				servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
				tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
			},
		});
		fakeAlpha.respond(async () => ({ content: [{ type: "text", text: `leaked ${ALPHA_TOKEN}` }] }));
		plan = { calls: ["alpha_lookup"], slowMs: 0 };
		const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
		const outcome = await executeClaimed(claimed);
		fakeAlpha.respond(async (tool, args) => ({
			content: [{ type: "text", text: `${tool} ${JSON.stringify({ target: args.target ?? null })}` }],
		}));
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false ? outcome.code : "").toBe(MCP_RESULT_BLOCKED);
		expect(outcome.ok === false ? outcome.message : "").not.toContain(ALPHA_TOKEN);

		const view = await runs.run(principal, accepted.run_id);
		expect(view.status).toBe("failed");
		expect(view.error?.code).toBe(MCP_RESULT_BLOCKED);
		expect(JSON.stringify(view)).not.toContain(ALPHA_TOKEN);

		const [assignment] = await client.run(
			"select report,error from orchestration_assignments where tenant_id=$1 and work_item_id=$2",
			tenantId,
			accepted.run_id,
		);
		expect(assignment?.report).toBeNull();
		expect(assignment?.error).toBe(MCP_RESULT_BLOCKED);
		expect(JSON.stringify(assignment)).not.toContain(ALPHA_TOKEN);

		const calls = await client.run(
			"select request_payload,response_payload from orchestration_llm_calls where tenant_id=$1 and conversation_id=$2",
			tenantId,
			claimed.conversationId,
		);
		// The model context was persisted; it still never carries the credential.
		expect(calls.length).toBeGreaterThan(0);
		expect(JSON.stringify(calls)).not.toContain(ALPHA_TOKEN);
		expect(JSON.stringify(calls)).not.toContain(ALPHA_CONNECTION);

		const events = await client.run(
			"select event_type,payload from conversation_events where tenant_id=$1 and conversation_id=$2 order by sequence",
			tenantId,
			claimed.conversationId,
		);
		expect(JSON.stringify(events)).not.toContain(ALPHA_TOKEN);
		expect(events.filter((event) => event.event_type === "assistant/message")).toHaveLength(0);
	});

	test("T040: a base64 encoded credential echo fails the Run as well", async () => {
		const principal = await newKey("t040-base64", [serverA]);
		const accepted = await runs.submit(principal, "t040-base64", {
			prompt: "回显编码",
			mcp_servers: [serverA],
			credentials: {
				servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
				tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
			},
		});
		fakeAlpha.respond(async () => ({
			content: [{ type: "text", text: `leaked ${Buffer.from(ALPHA_TOKEN, "utf8").toString("base64")}` }],
		}));
		plan = { calls: ["alpha_lookup"], slowMs: 0 };
		const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
		const outcome = await executeClaimed(claimed);
		fakeAlpha.respond(async (tool, args) => ({
			content: [{ type: "text", text: `${tool} ${JSON.stringify({ target: args.target ?? null })}` }],
		}));
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false ? outcome.code : "").toBe(MCP_RESULT_BLOCKED);
		const view = await runs.run(principal, accepted.run_id);
		expect(view.status).toBe("failed");
		expect(view.error?.code).toBe(MCP_RESULT_BLOCKED);
		expect(JSON.stringify(view)).not.toContain(ALPHA_TOKEN);
	});

	test("T040: an MCP payload that cannot be checked safely fails the Run without delivering content", async () => {
		const principal = await newKey("t040-unsafe", [serverA]);
		const accepted = await runs.submit(principal, "t040-unsafe", {
			prompt: "不可检查的返回",
			mcp_servers: [serverA],
			credentials: {
				servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
				tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
			},
		});
		// A non-text content block cannot be checked for a credential echo.
		fakeAlpha.respond(async () => ({
			content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
		}));
		plan = { calls: ["alpha_lookup"], slowMs: 0 };
		const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
		const outcome = await executeClaimed(claimed);
		fakeAlpha.respond(async (tool, args) => ({
			content: [{ type: "text", text: `${tool} ${JSON.stringify({ target: args.target ?? null })}` }],
		}));
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false ? outcome.code : "").toBe(MCP_RESULT_BLOCKED);
		const view = await runs.run(principal, accepted.run_id);
		expect(view.status).toBe("failed");
		expect(view.error?.code).toBe(MCP_RESULT_BLOCKED);
		expect(view.result).toBeNull();
		const [assignment] = await client.run(
			"select report from orchestration_assignments where tenant_id=$1 and work_item_id=$2",
			tenantId,
			accepted.run_id,
		);
		expect(assignment?.report).toBeNull();
		// No content of the unchecked payload was delivered to the model.
		const events = await client.run(
			"select event_type,payload from conversation_events where tenant_id=$1 and conversation_id=$2 order by sequence",
			tenantId,
			claimed.conversationId,
		);
		expect(events.filter((event) => event.event_type === "assistant/message")).toHaveLength(0);
		expect(JSON.stringify(events)).not.toContain("iVBORw0KGgo=");
	});

	test("T040: the Run still fails although the delivery layer would redact the raw return", async () => {
		const principal = await newKey("t040-order", [serverA]);
		const accepted = await runs.submit(principal, "t040-order", {
			prompt: "先检查后脱敏",
			mcp_servers: [serverA],
			credentials: {
				servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
				tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
			},
		});
		// The raw return echoes the mapped Tool credential; the delivery layer
		// would replace it with [REDACTED], so only the raw inspection can fail
		// this Run.
		fakeAlpha.respond(async () => ({ content: [{ type: "text", text: `leaked ${ALPHA_TOKEN}` }] }));
		plan = { calls: ["alpha_lookup"], slowMs: 0 };
		const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
		const { resolved, spec } = await resolveFor(claimed);
		const scope = scopeFor(claimed, resolved.versionKey);

		// The delivery layer alone would hide the credential.
		const redacting = await probeFactory(spec, scope);
		const redacted = await redacting
			.find((tool) => tool.name === "alpha_lookup")
			?.execute("redact-probe", { target: "probe" }, undefined, undefined, undefined as never);
		expect(JSON.stringify(redacted)).not.toContain(ALPHA_TOKEN);
		expect(JSON.stringify(redacted)).toContain("[REDACTED]");

		// With the raw return inspected first, the same payload fails the Run.
		const outcome = await executeClaimed(claimed);
		fakeAlpha.respond(async (tool, args) => ({
			content: [{ type: "text", text: `${tool} ${JSON.stringify({ target: args.target ?? null })}` }],
		}));
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false ? outcome.code : "").toBe(MCP_RESULT_BLOCKED);
		const view = await runs.run(principal, accepted.run_id);
		expect(view.status).toBe("failed");
		expect(view.error?.code).toBe(MCP_RESULT_BLOCKED);
	});

	test("T032/T033: turn ownership and sealed values cannot cross Key Runs", async () => {
		const first = await newKey("scope-first", [serverA]);
		const second = await newKey("scope-second", [serverA]);
		const submit = (principal: typeof first, key: string, connection: string, token: string) =>
			runs.submit(principal, key, {
				prompt: `task ${key}`,
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: connection } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: token } } },
				},
			});
		const a = await submit(first, "scope-a", ALPHA_CONNECTION, ALPHA_TOKEN);
		const b = await submit(second, "scope-b", BETA_CONNECTION, BETA_TOKEN);
		const claims = await claimRuns([a.run_id, b.run_id]);
		const one = claims.get(a.run_id)!;
		const two = claims.get(b.run_id)!;
		expect(await store.taskPrompt(one.conversationId, one.turnId)).toBe("task scope-a");
		await expect(store.taskPrompt(one.conversationId, two.turnId)).rejects.toMatchObject({
			code: "TASK_UNAVAILABLE",
		});
		await expect(store.toolBindings(one.conversationId, two.turnId)).rejects.toMatchObject({
			code: "TASK_UNAVAILABLE",
		});
		await expect(store.credentials(one.conversationId, two.turnId)).rejects.toMatchObject({
			code: "CREDENTIAL_UNAVAILABLE",
		});
		const before = await store.credentials(one.conversationId, one.turnId);
		expect(before.connectionCredential(serverA)).toBe(ALPHA_CONNECTION);
		const [saved] = await client.run(
			"select c.id,c.sealed from orchestration_credentials c join orchestration_assignments a on a.credential_id=c.id where a.id=$1",
			one.id,
		);
		const [other] = await client.run(
			"select c.sealed from orchestration_credentials c join orchestration_assignments a on a.credential_id=c.id where a.id=$1",
			two.id,
		);
		await client.run(
			"update orchestration_credentials set sealed=$2::jsonb where id=$1",
			String(saved!.id),
			JSON.stringify(other!.sealed),
		);
		try {
			const swapped = await store.credentials(one.conversationId, one.turnId);
			expect(() => swapped.connectionCredential(serverA)).toThrow();
		} finally {
			await client.run(
				"update orchestration_credentials set sealed=$2::jsonb where id=$1",
				String(saved!.id),
				JSON.stringify(saved!.sealed),
			);
			await store.complete(one.id, "done", null);
			await store.complete(two.id, "done", null);
		}
	});

	test("an expired queued Run fails without executing even after credential cleanup", async () => {
		const principal = await newKey("queued-expired", []);
		const accepted = await runs.submit(principal, "queued-expired", { prompt: "expired", mcp_servers: [] });
		await client.run(
			"update orchestration_credentials set expires_at=now()-interval '1 second' where work_item_id=$1",
			accepted.run_id,
		);
		const execute = vi.spyOn(ConversationService.prototype, "executeTurn");
		const dispatcher = await startOrchestrationDispatcher(service, () => {});
		try {
			await expect
				.poll(async () => (await runs.run(principal, accepted.run_id)).status, { timeout: 8000 })
				.toBe("failed");
			const view = await runs.run(principal, accepted.run_id);
			expect(view.error?.code).toBe(CREDENTIAL_EXPIRED);
			expect(execute).not.toHaveBeenCalled();
		} finally {
			await dispatcher.close();
			execute.mockRestore();
		}
	}, 30000);

	test("T029: acceptance fixes a 30-minute credential deadline and refuses a client-supplied one", async () => {
		const principal = await newKey("t029-deadline", []);
		const before = Date.now();
		const accepted = await runs.submit(principal, "t029-deadline", { prompt: "deadline", mcp_servers: [] });
		const after = Date.now();
		const [credential] = await client.run(
			"select expires_at from orchestration_credentials where tenant_id=$1 and work_item_id=$2",
			tenantId,
			accepted.run_id,
		);
		const expires = (credential?.expires_at as Date).getTime();
		expect(expires).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
		expect(expires).toBeLessThanOrEqual(after + 30 * 60 * 1000 + 1000);
		await expect(
			runs.submit(principal, "t029-deadline-override", {
				prompt: "override",
				mcp_servers: [],
				credential_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
			} as never),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await runs.cancel(principal, accepted.run_id);
	});

	test("T029: a swept credential row is reported as expired, never as a missing credential", async () => {
		const principal = await newKey("t029-tombstone", []);
		const accepted = await runs.submit(principal, "t029-tombstone", { prompt: "tombstone", mcp_servers: [] });
		const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
		try {
			// The sweep keeps the row and replaces the ciphertext with `{}`. Reading
			// must never fall through to the ordinary missing/decrypt failure path.
			await client.run(
				"update orchestration_credentials set sealed='{}'::jsonb where tenant_id=$1 and work_item_id=$2",
				tenantId,
				accepted.run_id,
			);
			await expect(store.credentials(claimed.conversationId, claimed.turnId)).rejects.toMatchObject({
				code: CREDENTIAL_EXPIRED,
			});
			await client.run(
				"update orchestration_credentials set expires_at=now()-interval '1 second' where tenant_id=$1 and work_item_id=$2",
				tenantId,
				accepted.run_id,
			);
			await expect(store.credentials(claimed.conversationId, claimed.turnId)).rejects.toMatchObject({
				code: CREDENTIAL_EXPIRED,
			});
		} finally {
			await store.complete(claimed.id, null, CREDENTIAL_EXPIRED);
		}
	}, 30000);

	test("T029: expiry before a Tool parameter injection fails the Run with the fixed error and no retry", async () => {
		const principal = await newKey("t029-injection-expiry", [serverA]);
		fakeAlpha.reset();
		let accepted: { run_id: string } | undefined;
		plan = {
			calls: ["alpha_lookup", "alpha_lookup"],
			slowMs: 0,
			afterCall: async ({ index }) => {
				if (index === 0 && accepted !== undefined) await expireCredentials(accepted.run_id);
			},
		};
		try {
			accepted = await runs.submit(principal, "t029-injection-expiry", {
				prompt: "injection expiry",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			});
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const outcome = await executeClaimed(claimed);
			expect(outcome.ok).toBe(false);
			expect(outcome.code).toBe(CREDENTIAL_EXPIRED);
			// No second connection and no fallback/retry: the expired Run stops.
			expect(fakeAlpha.calls).toHaveLength(1);
			expect([...new Set(fakeAlpha.authorizations)]).toEqual([`Bearer ${ALPHA_CONNECTION}`]);
			const view = await runs.run(principal, accepted.run_id);
			expect(view.status).toBe("failed");
			expect(view.error?.code).toBe(CREDENTIAL_EXPIRED);
			expect(view.result).toBeNull();
			const conversationId = await runConversationId(accepted.run_id);
			const [trace] = await client.run(
				"select request_payload::text as request,response_payload::text as response from orchestration_llm_calls where tenant_id=$1 and conversation_id=$2",
				tenantId,
				conversationId,
			);
			const persisted = `${trace?.request ?? ""}${trace?.response ?? ""}`;
			expect(persisted).not.toContain(ALPHA_TOKEN);
			expect(persisted).not.toContain(ALPHA_CONNECTION);
		} finally {
			plan = { calls: [], slowMs: 0 };
		}
	}, 30000);

	test("T029: expiry before a connection-only Tool fails before the second connection", async () => {
		const principal = await newKey("t029-unbound-expiry", [serverA]);
		fakeAlpha.reset();
		let accepted: { run_id: string } | undefined;
		plan = {
			// alpha_status has no parameter mapping: only the connection credential exists.
			calls: ["alpha_status", "alpha_status"],
			slowMs: 0,
			afterCall: async ({ index }) => {
				if (index === 0 && accepted !== undefined) await expireCredentials(accepted.run_id);
			},
		};
		try {
			accepted = await runs.submit(principal, "t029-unbound-expiry", {
				prompt: "unbound expiry",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			});
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const outcome = await executeClaimed(claimed);
			expect(outcome.code).toBe(CREDENTIAL_EXPIRED);
			expect(fakeAlpha.calls).toHaveLength(1);
			expect([...new Set(fakeAlpha.authorizations)]).toEqual([`Bearer ${ALPHA_CONNECTION}`]);
		} finally {
			plan = { calls: [], slowMs: 0 };
		}
	}, 30000);

	test("T029: expiry before a resource read fails before the second connection", async () => {
		const principal = await newKey("t029-resource-expiry", [serverA]);
		let accepted: { run_id: string } | undefined;
		const resourceTool = mcpResourceToolName(serverA);
		fakeAlpha.reset();
		// The first return must advertise a Run-local resource reference.
		fakeAlpha.respond(async () => ({
			content: [{ type: "text", text: JSON.stringify({ uri: "test://alpha-resource" }) }],
		}));
		plan = {
			// The first Tool result registers a Run-local resource reference.
			calls: ["alpha_lookup", { name: resourceTool, args: { uri: "test://alpha-resource" } }],
			slowMs: 0,
			afterCall: async ({ index }) => {
				if (index === 0 && accepted !== undefined) await expireCredentials(accepted.run_id);
			},
		};
		try {
			accepted = await runs.submit(principal, "t029-resource-expiry", {
				prompt: "resource expiry",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			});
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const outcome = await executeClaimed(claimed);
			expect(outcome.code).toBe(CREDENTIAL_EXPIRED);
			expect(fakeAlpha.calls).toHaveLength(1);
			expect(
				fakeAlpha.calls.some((call) => call.tool === resourceTool && call.args.uri === "test://alpha-resource"),
			).toBe(false);
		} finally {
			plan = { calls: [], slowMs: 0 };
			fakeAlpha.respond(async (tool, args) => ({
				content: [{ type: "text", text: `${tool} ${JSON.stringify({ target: args.target ?? null })}` }],
			}));
		}
	}, 30000);

	test("T029: expiry before an unauthenticated (authentication=none) connection is still checked", async () => {
		const principal = await newKey("t029-none-expiry", [serverC]);
		fakeGamma.reset();
		let accepted: { run_id: string } | undefined;
		plan = {
			calls: ["gamma_status", "gamma_status"],
			slowMs: 0,
			afterCall: async ({ index }) => {
				if (index === 0 && accepted !== undefined) await expireCredentials(accepted.run_id);
			},
		};
		try {
			accepted = await runs.submit(principal, "t029-none-expiry", {
				prompt: "none auth expiry",
				mcp_servers: [serverC],
			});
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const outcome = await executeClaimed(claimed);
			expect(outcome.code).toBe(CREDENTIAL_EXPIRED);
			expect(fakeGamma.calls).toHaveLength(1);
			expect(fakeGamma.authorizations.every((value) => value === null)).toBe(true);
		} finally {
			plan = { calls: [], slowMs: 0 };
		}
	}, 30000);

	test("T029: the expiry sweep keeps unexpired credentials and both queued outcomes settle", async () => {
		const principal = await newKey("t029-sweep", []);
		const expiredRun = await runs.submit(principal, "t029-sweep-expired", { prompt: "expired", mcp_servers: [] });
		await expireCredentials(expiredRun.run_id);
		const validRun = await runs.submit(principal, "t029-sweep-valid", { prompt: "valid", mcp_servers: [] });
		const expiredConversationId = await runConversationId(expiredRun.run_id);
		const execute = vi.spyOn(ConversationService.prototype, "executeTurn");
		const dispatcher = await startOrchestrationDispatcher(service, () => {});
		try {
			await expect
				.poll(
					async () => {
						const expired = await runs.run(principal, expiredRun.run_id);
						const valid = await runs.run(principal, validRun.run_id);
						return [expired.status, valid.status];
					},
					{ timeout: 8000 },
				)
				.toEqual(["failed", "completed"]);
			const expiredView = await runs.run(principal, expiredRun.run_id);
			expect(expiredView.error?.code).toBe(CREDENTIAL_EXPIRED);
			expect(expiredView.result).toBeNull();
			const validView = await runs.run(principal, validRun.run_id);
			expect(validView.error).toBeNull();
			// The sweep wipes only the expired ciphertext; the valid Run keeps its own.
			expect(Object.keys((await credentialRow(expiredRun.run_id)).sealed)).toEqual([]);
			expect(Object.keys((await credentialRow(validRun.run_id)).sealed).length).toBeGreaterThan(0);
			// The expired queued Run never reaches a model turn; the valid one does.
			const executedConversations = execute.mock.calls.map(([input]) =>
				String((input as { conversationId: string }).conversationId),
			);
			expect(executedConversations).not.toContain(expiredConversationId);
			expect(executedConversations.length).toBeGreaterThan(0);
		} finally {
			await dispatcher.close();
			execute.mockRestore();
		}
	}, 30000);

	test("T029: legacy-only mode leaves retained Key credentials and assignments for recovery", async () => {
		const principal = await newKey("t029-legacy-sweep", []);
		const accepted = await runs.submit(principal, "t029-legacy-sweep", { prompt: "retained", mcp_servers: [] });
		await expireCredentials(accepted.run_id);
		const execute = vi.spyOn(ConversationService.prototype, "executeTurn");
		const legacyDispatcher = await startOrchestrationDispatcher(service, () => {}, { legacyOnly: true });
		try {
			await new Promise((resolve) => setTimeout(resolve, 800));
			// Compatibility rollback keeps every retained Key row decryptable and queued.
			expect(Object.keys((await credentialRow(accepted.run_id)).sealed).length).toBeGreaterThan(0);
			const [assignment] = await client.run(
				"select state from orchestration_assignments where tenant_id=$1 and work_item_id=$2",
				tenantId,
				accepted.run_id,
			);
			expect(assignment?.state).toBe("queued");
			expect(execute).not.toHaveBeenCalled();
		} finally {
			await legacyDispatcher.close();
			execute.mockRestore();
		}
		const normalDispatcher = await startOrchestrationDispatcher(service, () => {});
		try {
			await expect
				.poll(async () => (await runs.run(principal, accepted.run_id)).status, { timeout: 8000 })
				.toBe("failed");
			expect((await runs.run(principal, accepted.run_id)).error?.code).toBe(CREDENTIAL_EXPIRED);
		} finally {
			await normalDispatcher.close();
		}
	}, 30000);

	test("T034: a resource text echo is inspected before delivery and fails the Run", async () => {
		const principal = await newKey("t034-resource-text", [serverA]);
		fakeAlpha.reset();
		fakeAlpha.respond(async () => ({
			content: [{ type: "text", text: JSON.stringify({ uri: "test://alpha-echo" }) }],
		}));
		plan = {
			calls: ["alpha_lookup", { name: mcpResourceToolName(serverA), args: { uri: "test://alpha-echo" } }],
			slowMs: 0,
		};
		try {
			const accepted = await runs.submit(principal, "t034-resource-text", {
				prompt: "resource echo",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			});
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const outcome = await executeClaimed(claimed);
			expect(outcome).toMatchObject({ ok: false, code: MCP_RESULT_BLOCKED });
			const view = await runs.run(principal, accepted.run_id);
			expect(view.status).toBe("failed");
			expect(view.error?.code).toBe(MCP_RESULT_BLOCKED);
			expect(view.result).toBeNull();
			const conversationId = await runConversationId(accepted.run_id);
			const persisted = await persistedText(conversationId);
			expect(persisted).not.toContain(ALPHA_TOKEN);
			expect(persisted).not.toContain(ALPHA_CONNECTION);
			const [audit] = await client.run(
				`select outcome,error_code,result_bytes,result_truncated from mcp_call_audits
				 where tenant_id=$1 and conversation_id=$2 order by created_at desc limit 1`,
				tenantId,
				conversationId,
			);
			expect(audit?.outcome).toBe("error");
			expect(audit?.result_bytes).toBe(0);
			expect(audit?.result_truncated).toBe(false);
			expect(JSON.stringify(audit)).not.toContain(ALPHA_TOKEN);
		} finally {
			plan = { calls: [], slowMs: 0 };
			fakeAlpha.respond(async (tool, args) => ({
				content: [{ type: "text", text: `${tool} ${JSON.stringify({ target: args.target ?? null })}` }],
			}));
		}
	}, 30000);

	test("T034: a binary resource is refused as uncheckable and never delivered", async () => {
		const principal = await newKey("t034-resource-binary", [serverA]);
		fakeAlpha.reset();
		fakeAlpha.respond(async () => ({
			content: [{ type: "text", text: JSON.stringify({ uri: "test://alpha-binary" }) }],
		}));
		plan = {
			calls: ["alpha_lookup", { name: mcpResourceToolName(serverA), args: { uri: "test://alpha-binary" } }],
			slowMs: 0,
		};
		try {
			const accepted = await runs.submit(principal, "t034-resource-binary", {
				prompt: "binary resource",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			});
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const outcome = await executeClaimed(claimed);
			expect(outcome).toMatchObject({ ok: false, code: MCP_RESULT_BLOCKED });
			const view = await runs.run(principal, accepted.run_id);
			expect(view.status).toBe("failed");
			expect(view.error?.code).toBe(MCP_RESULT_BLOCKED);
			expect(view.result).toBeNull();
		} finally {
			plan = { calls: [], slowMs: 0 };
			fakeAlpha.respond(async (tool, args) => ({
				content: [{ type: "text", text: `${tool} ${JSON.stringify({ target: args.target ?? null })}` }],
			}));
		}
	}, 30000);

	test("T034: a nested structuredContent/_meta echo is inspected before delivery", async () => {
		const principal = await newKey("t034-structured", [serverA]);
		fakeAlpha.reset();
		fakeAlpha.respond(async () => ({
			content: [{ type: "text", text: "safe" }],
			structuredContent: { nested: { token: ALPHA_TOKEN } },
			_meta: { note: ALPHA_CONNECTION },
		}));
		plan = { calls: ["alpha_lookup"], slowMs: 0 };
		try {
			const accepted = await runs.submit(principal, "t034-structured", {
				prompt: "structured echo",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			});
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const outcome = await executeClaimed(claimed);
			expect(outcome).toMatchObject({ ok: false, code: MCP_RESULT_BLOCKED });
			const view = await runs.run(principal, accepted.run_id);
			expect(view.status).toBe("failed");
			expect(view.error?.code).toBe(MCP_RESULT_BLOCKED);
			expect(view.result).toBeNull();
		} finally {
			plan = { calls: [], slowMs: 0 };
			fakeAlpha.respond(async (tool, args) => ({
				content: [{ type: "text", text: `${tool} ${JSON.stringify({ target: args.target ?? null })}` }],
			}));
		}
	}, 30000);

	test("T034: an oversized return is uncheckable and fails the Run without content", async () => {
		const principal = await newKey("t034-oversized", [serverA]);
		fakeAlpha.reset();
		fakeAlpha.respond(async () => ({ content: [{ type: "text", text: "x".repeat(70_000) }] }));
		plan = { calls: ["alpha_lookup"], slowMs: 0 };
		try {
			const accepted = await runs.submit(principal, "t034-oversized", {
				prompt: "oversized return",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			});
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const outcome = await executeClaimed(claimed);
			expect(outcome).toMatchObject({ ok: false, code: MCP_RESULT_BLOCKED });
			const view = await runs.run(principal, accepted.run_id);
			expect(view.status).toBe("failed");
			expect(view.error?.code).toBe(MCP_RESULT_BLOCKED);
			expect(view.result).toBeNull();
			const persisted = await persistedText(await runConversationId(accepted.run_id));
			expect(persisted.includes("x".repeat(1000))).toBe(false);
		} finally {
			plan = { calls: [], slowMs: 0 };
			fakeAlpha.respond(async (tool, args) => ({
				content: [{ type: "text", text: `${tool} ${JSON.stringify({ target: args.target ?? null })}` }],
			}));
		}
	}, 30000);

	test("T034: an isError result is inspected before it is treated as a Tool error", async () => {
		const principal = await newKey("t034-is-error", [serverA]);
		fakeAlpha.reset();
		fakeAlpha.respond(async () => ({ isError: true, content: [{ type: "text", text: ALPHA_TOKEN }] }));
		plan = { calls: ["alpha_lookup"], slowMs: 0 };
		try {
			const accepted = await runs.submit(principal, "t034-is-error", {
				prompt: "error echo",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			});
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const outcome = await executeClaimed(claimed);
			expect(outcome).toMatchObject({ ok: false, code: MCP_RESULT_BLOCKED });
			const view = await runs.run(principal, accepted.run_id);
			expect(view.status).toBe("failed");
			expect(view.error?.code).toBe(MCP_RESULT_BLOCKED);
			expect(view.result).toBeNull();
			expect(await persistedText(await runConversationId(accepted.run_id))).not.toContain(ALPHA_TOKEN);
		} finally {
			plan = { calls: [], slowMs: 0 };
			fakeAlpha.respond(async (tool, args) => ({
				content: [{ type: "text", text: `${tool} ${JSON.stringify({ target: args.target ?? null })}` }],
			}));
		}
	}, 30000);

	test("T034: an initialize error echoing the Run credential fails the Run without delivery", async () => {
		const principal = await newKey("t034-init-error", [serverA]);
		fakeAlpha.reset();
		fakeAlpha.failInitializeWith(`handshake failed ${ALPHA_CONNECTION}`);
		plan = { calls: ["alpha_lookup"], slowMs: 0 };
		try {
			const accepted = await runs.submit(principal, "t034-init-error", {
				prompt: "init error",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			});
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const outcome = await executeClaimed(claimed);
			expect(outcome).toMatchObject({ ok: false, code: MCP_RESULT_BLOCKED });
			// The handshake failed before any Tool was invoked.
			expect(fakeAlpha.calls).toHaveLength(0);
			const view = await runs.run(principal, accepted.run_id);
			expect(view.status).toBe("failed");
			expect(view.error?.code).toBe(MCP_RESULT_BLOCKED);
			expect(view.result).toBeNull();
			const persisted = await persistedText(await runConversationId(accepted.run_id));
			expect(persisted).not.toContain(ALPHA_CONNECTION);
			expect(persisted).not.toContain(ALPHA_TOKEN);
		} finally {
			fakeAlpha.failInitializeWith(undefined);
			plan = { calls: [], slowMs: 0 };
		}
	}, 30000);

	test("T034: a JSON-RPC Tool error echoing a Run credential is inspected before delivery", async () => {
		const principal = await newKey("t034-rpc-error", [serverA]);
		fakeAlpha.reset();
		fakeAlpha.failToolCallWith(`upstream rejected ${ALPHA_TOKEN}`);
		plan = { calls: ["alpha_lookup"], slowMs: 0 };
		try {
			const accepted = await runs.submit(principal, "t034-rpc-error", {
				prompt: "rpc error",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			});
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const outcome = await executeClaimed(claimed);
			expect(outcome).toMatchObject({ ok: false, code: MCP_RESULT_BLOCKED });
			const view = await runs.run(principal, accepted.run_id);
			expect(view.status).toBe("failed");
			expect(view.error?.code).toBe(MCP_RESULT_BLOCKED);
			expect(view.result).toBeNull();
			const persisted = await persistedText(await runConversationId(accepted.run_id));
			expect(persisted).not.toContain(ALPHA_TOKEN);
			expect(persisted).not.toContain(ALPHA_CONNECTION);
		} finally {
			fakeAlpha.failToolCallWith(undefined);
			plan = { calls: [], slowMs: 0 };
		}
	}, 30000);

	test("T034: a Tool without parameter bindings still passes the unified boundary", async () => {
		const principal = await newKey("t034-unbound-echo", [serverA]);
		fakeAlpha.reset();
		fakeAlpha.respond(async () => ({ content: [{ type: "text", text: `connection ${ALPHA_CONNECTION}` }] }));
		plan = { calls: ["alpha_status"], slowMs: 0 };
		try {
			const accepted = await runs.submit(principal, "t034-unbound-echo", {
				prompt: "unbound echo",
				mcp_servers: [serverA],
				credentials: {
					servers: { [serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } } },
					tools: { [serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } } },
				},
			});
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			const outcome = await executeClaimed(claimed);
			expect(outcome).toMatchObject({ ok: false, code: MCP_RESULT_BLOCKED });
			const view = await runs.run(principal, accepted.run_id);
			expect(view.status).toBe("failed");
			expect(view.error?.code).toBe(MCP_RESULT_BLOCKED);
			expect(view.result).toBeNull();
		} finally {
			plan = { calls: [], slowMs: 0 };
			fakeAlpha.respond(async (tool, args) => ({
				content: [{ type: "text", text: `${tool} ${JSON.stringify({ target: args.target ?? null })}` }],
			}));
		}
	}, 30000);

	test("dispatcher shutdown fails an active Key Run before abort can return an empty success", async () => {
		const principal = await newKey("dispatcher-shutdown", []);
		const accepted = await runs.submit(principal, "dispatcher-shutdown", { prompt: "shutdown", mcp_servers: [] });
		plan = { calls: [], slowMs: 15_000 };
		const dispatcher = await startOrchestrationDispatcher(service, () => {});
		try {
			await expect
				.poll(
					async () => {
						const [row] = await client.run(
							"select 1 from conversation_events e join orchestration_work_items w on w.conversation_id=e.conversation_id where w.id=$1 and e.event_type='turn/start'",
							accepted.run_id,
						);
						return Boolean(row);
					},
					{ timeout: 8000 },
				)
				.toBe(true);
		} finally {
			await dispatcher.close();
			plan = { calls: [], slowMs: 0 };
		}
		const view = await runs.run(principal, accepted.run_id);
		expect(view.status).toBe("failed");
		expect(view.error?.code).toBe("EXECUTION_INTERRUPTED");
		expect(view.result).toBeNull();
	}, 30000);

	test("dispatcher forwards cancellation for an active Key-owned Run", async () => {
		const principal = await newKey("dispatcher-cancel", []);
		const accepted = await runs.submit(principal, "dispatcher-cancel", { prompt: "cancel", mcp_servers: [] });
		plan = { calls: [], slowMs: 15_000 };
		const spy = vi.spyOn(ConversationService.prototype, "cancelTurn");
		const dispatcher = await startOrchestrationDispatcher(service, () => {});
		try {
			await expect
				.poll(async () => (await runs.run(principal, accepted.run_id)).status, { timeout: 8000 })
				.toBe("running");
			await expect
				.poll(
					async () => {
						const [row] = await client.run(
							"select 1 from conversation_events e join orchestration_work_items w on w.conversation_id=e.conversation_id where w.id=$1 and e.event_type='turn/start'",
							accepted.run_id,
						);
						return Boolean(row);
					},
					{ timeout: 8000 },
				)
				.toBe(true);
			await runs.cancel(principal, accepted.run_id);
			await expect.poll(() => spy.mock.calls.length, { timeout: 8000 }).toBeGreaterThan(0);
			expect((await runs.run(principal, accepted.run_id)).status).toBe("cancelled");
		} finally {
			await dispatcher.close();
			spy.mockRestore();
			plan = { calls: [], slowMs: 0 };
		}
	}, 30000);

	test("T041: cancellation and completion serialize and terminal outcomes cannot be overwritten", async () => {
		const principal = await newKey("terminal-race", []);
		for (const order of ["cancel-first", "complete-first", "concurrent"] as const) {
			const accepted = await runs.submit(principal, `terminal-${order}`, { prompt: order, mcp_servers: [] });
			const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
			if (order === "cancel-first") {
				await runs.cancel(principal, accepted.run_id);
				await store.complete(claimed.id, "late", null);
			} else if (order === "complete-first") {
				await store.complete(claimed.id, "original", null);
				await runs.cancel(principal, accepted.run_id);
			} else {
				await Promise.all([runs.cancel(principal, accepted.run_id), store.complete(claimed.id, "original", null)]);
			}
			const terminal = await runs.run(principal, accepted.run_id);
			expect(["cancelled", "completed"]).toContain(terminal.status);
			if (order === "cancel-first") expect(terminal.status).toBe("cancelled");
			if (order === "complete-first") expect(terminal.status).toBe("completed");
			expect(terminal.result).toBe(terminal.status === "completed" ? "original" : null);
			await store.complete(claimed.id, "late", null);
			await runs.cancel(principal, accepted.run_id);
			const after = await runs.run(principal, accepted.run_id);
			expect(after.status).toBe(terminal.status);
			expect(after.result).toBe(terminal.result);
		}
		for (const order of ["cancel-first", "failure-first", "concurrent"] as const) {
			const failed = await runs.submit(principal, `terminal-failure-${order}`, {
				prompt: "failure",
				mcp_servers: [],
			});
			const claim = (await claimRuns([failed.run_id])).get(failed.run_id)!;
			if (order === "cancel-first") {
				await runs.cancel(principal, failed.run_id);
				await store.complete(claim.id, null, MCP_RESULT_BLOCKED);
			} else if (order === "failure-first") {
				await store.complete(claim.id, null, MCP_RESULT_BLOCKED);
				await runs.cancel(principal, failed.run_id);
			} else {
				await Promise.all([
					runs.cancel(principal, failed.run_id),
					store.complete(claim.id, null, MCP_RESULT_BLOCKED),
				]);
			}
			const terminal = await runs.run(principal, failed.run_id);
			expect(["cancelled", "failed"]).toContain(terminal.status);
			if (order === "cancel-first") expect(terminal.status).toBe("cancelled");
			if (order === "failure-first") expect(terminal.status).toBe("failed");
			if (terminal.status === "failed") expect(terminal.error?.code).toBe(MCP_RESULT_BLOCKED);
			await store.complete(claim.id, "late success", null);
			expect((await runs.run(principal, failed.run_id)).status).toBe(terminal.status);
		}
		const marked = await runs.submit(principal, "terminal-fatal-marker", { prompt: "fatal", mcp_servers: [] });
		const markedClaim = (await claimRuns([marked.run_id])).get(marked.run_id)!;
		await client.run("update orchestration_assignments set error=$2 where id=$1", markedClaim.id, MCP_RESULT_BLOCKED);
		await store.complete(markedClaim.id, "late success", null);
		const markedView = await runs.run(principal, marked.run_id);
		expect(markedView.status).toBe("failed");
		expect(markedView.error?.code).toBe(MCP_RESULT_BLOCKED);
		expect(markedView.result).toBeNull();
	});

	test("T040: a Tool receives only the credential mapped to it", async () => {
		const principal = await newKey("t040-mapping", [serverA, serverB]);
		fakeAlpha.reset();
		fakeBeta.reset();
		const accepted = await runs.submit(principal, "t040-mapping", {
			prompt: "按映射注入",
			mcp_servers: [serverA, serverB],
			credentials: {
				servers: {
					[serverA]: { connection: { credential_id: "connection", value: ALPHA_CONNECTION } },
					[serverB]: { connection: { credential_id: "connection", value: BETA_CONNECTION } },
				},
				tools: {
					[serverA]: { alpha_lookup: { alpha_token: ALPHA_TOKEN } },
					[serverB]: { beta_lookup: { beta_token: BETA_TOKEN } },
				},
			},
		});
		plan = { calls: ["alpha_lookup", "beta_lookup"], slowMs: 0 };
		const claimed = (await claimRuns([accepted.run_id])).get(accepted.run_id)!;
		const outcome = await executeClaimed(claimed);
		expect(outcome.ok).toBe(true);

		const alphaCall = fakeAlpha.calls.find((call) => call.tool === "alpha_lookup");
		const betaCall = fakeBeta.calls.find((call) => call.tool === "beta_lookup");
		expect(alphaCall?.args.alpha_token).toBe(ALPHA_TOKEN);
		expect(betaCall?.args.beta_token).toBe(BETA_TOKEN);
		// The unrelated parameter of the other Server is never populated.
		expect(Object.keys(alphaCall?.args ?? {})).toEqual(["target", "alpha_token"]);
		expect(Object.keys(betaCall?.args ?? {})).toEqual(["target", "beta_token"]);
		expect(JSON.stringify(alphaCall?.args)).not.toContain(BETA_TOKEN);
		expect(JSON.stringify(alphaCall?.args)).not.toContain(BETA_CONNECTION);
		expect(JSON.stringify(betaCall?.args)).not.toContain(ALPHA_TOKEN);
		expect(JSON.stringify(betaCall?.args)).not.toContain(ALPHA_CONNECTION);
		// Each connection only used its own Server's connection credential.
		expect(fakeAlpha.authorizations).toContain(`Bearer ${ALPHA_CONNECTION}`);
		expect(fakeAlpha.authorizations).not.toContain(`Bearer ${BETA_CONNECTION}`);
		expect(fakeBeta.authorizations).toContain(`Bearer ${BETA_CONNECTION}`);
		expect(fakeBeta.authorizations).not.toContain(`Bearer ${ALPHA_CONNECTION}`);
	});

	test("R010 composed Run, Integration and Chat entry points share execution, MCP protection and Usage", async () => {
		const repos = createPublishingRepositories(client);
		const appId = randomUUID();
		const versionId = randomUUID();
		const agentId = randomUUID();
		const tenant = tenantId as TenantId;
		const mcpServerId = serverAUuid as McpServerId;
		const origin = "https://shared-execution.test";
		const publicAppId = `pub_${appId}`;
		const publishedSpec = {
			...runtimeSpecFor(versionId, [
				{ publicId: serverA, endpoint: fakeAlpha.endpoint, authentication: "bearer", tools: [alphaTools[1]!] },
			]),
			publishedAppVersionId: `pav_${versionId}`,
		};
		await client.run(
			"insert into agent_definitions(id,tenant_id,name,revision,draft_config,created_by) values ($1,$2,'shared-execution',1,'{}',$2)",
			agentId, tenantId,
		);
		await client.run(
			`insert into published_apps(id,tenant_id,agent_definition_id,public_app_id,name,status,access_mode,allowed_origins,created_by)
			 values ($1,$2,$3,$4,'shared-execution','active','anonymous',$5::jsonb,$2)`,
			appId, tenantId, agentId, publicAppId, [origin],
		);
		await client.run(
			`insert into published_app_versions(id,tenant_id,published_app_id,version_number,source_agent_revision,snapshot,runtime_spec,runtime_spec_hash,status,created_by)
			 values ($1,$2,$3,1,1,'{}',$4::jsonb,$5,'ready',$2)`,
			versionId, tenantId, appId, publishedSpec, sha256Hex(canonicalJson(publishedSpec)),
		);
		await client.run("update published_apps set current_version_id=$1 where id=$2", versionId, appId);
		const integration = await store.createIntegration(
			appId, versionId, "shared-execution",
			settingsSchema.parse({ allowedModels: ["fake-model"], bindings: [] }),
		);
		const platformCredential = "fixture-platform-connection";
		const secretBox = new McpSecretBox(masterKey);
		await repos.mcpSecrets.put({
			secretId: newMcpSecretId(),
			tenantId: tenant,
			mcpServerId,
			...secretBox.seal(tenant, mcpServerId, platformCredential),
		});
		fakeAlpha.reset();
		const observedScopes: { systemPrompt?: string; input: string; schema: string }[] = [];
		let keyReadyForCancellation = false;
		const providerUsage = {
			input: 7, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const createSession: RuntimeSessionFactory = async ({ customTools, model }) => {
			const controller = new AbortController();
			let transcript: unknown[] = [];
			return {
				subscribe: () => () => {},
				dispose: async () => { controller.abort(); },
				abort: async () => { controller.abort(); },
				snapshot: () => ({ transcript }),
				async prompt(input: PromptInput) {
					const tool = customTools?.find((candidate) => candidate.name === "alpha_lookup" || candidate.name === "alpha_status");
					if (!tool) throw new Error("expected an MCP tool");
					observedScopes.push({ systemPrompt: input.systemPrompt, input: input.text, schema: JSON.stringify(tool.parameters) });
					await input.onLlmTrace?.({
						kind: "request", callIndex: 1, model,
						context: { systemPrompt: input.systemPrompt, messages: [{ role: "user", content: input.text, timestamp: 1 }] },
					});
					const result = await tool.execute(
						"shared-tool", tool.name === "alpha_lookup" ? { target: "shared" } : {},
						controller.signal, undefined, undefined as never,
					);
					const output = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
					const message = {
						role: "assistant", content: [{ type: "text", text: output }], timestamp: 2,
						stopReason: "stop", usage: providerUsage,
					};
					await input.onLlmTrace?.({ kind: "response", callIndex: 1, model, message } as LlmCallTrace);
					transcript = [{ ...message, id: "assistant-2", status: "complete", model }];
					if (input.systemPrompt?.startsWith("shared-key-cancel")) {
						keyReadyForCancellation = true;
						await waitForAbort(controller.signal, 10_000);
					}
				},
			} as unknown as PiSessionRuntime;
		};
		const networkPolicy = { allowHttp: true, allowPrivateNetwork: true };
		const catalog = { tools: [], knowledgeBases: [], models: [{ provider: "fake", modelId: "fake-model" }] };
		const control = new ControlService({ repositories: repos, catalog, embedBaseUrl: origin });
		const composed = await composeOrchestration({
			control: {
				handler: () => false, controlService: control, client, repositories: repos, catalog,
				previewTicketService: new PreviewTicketService({ adminToken: "test", embedBaseUrl: origin }),
				mcpSecretBox: secretBox, tenantId: tenant, requestMcpSync() {}, isAuthorized: () => false,
				async close() {},
			},
			masterKey, networkPolicy, createSession,
			skillMaterializer: { materialize: async () => [], materializeSkills: async () => [] },
			resolveModelMetadata: undefined, onError: () => {},
		});
		const embed = createEmbedServices({
			accessTokens: new AccessTokenService({
				...await generateKeyPair("EdDSA"), issuer: origin, keyId: "shared-test", ttlSeconds: 60,
			}),
			subjectPepper: "fixture-shared-execution-subject-pepper",
			repositories: repos, createSession,
			mcpTools: createMcpRuntimeToolFactory({ repositories: repos, secretBox, networkPolicy }),
		});
		const http = createServer((req, res) => {
			void (async () => {
				if (req.url?.startsWith("/api/embed/")) {
					for (const handler of embed.handlers) if (await handler(req, res)) return;
				} else if (await composed.handler(req, res)) return;
				res.writeHead(404).end();
			})().catch(() => res.writeHead(500).end());
		});
		try {
			await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
			const address = http.address();
			if (!address || typeof address === "string") throw new Error("test HTTP listener missing");
			const baseUrl = `http://127.0.0.1:${address.port}`;
			async function post<T>(path: string, body: unknown, status: number, token?: string): Promise<T> {
				const response = await fetch(`${baseUrl}${path}`, {
					method: "POST",
					headers: {
						"content-type": "application/json", origin,
						"idempotency-key": randomUUID(),
						...(token ? { authorization: `Bearer ${token}` } : {}),
					},
					body: JSON.stringify(body),
				});
				const envelope = await response.json() as { data: T; error?: unknown };
				expect(response.status, JSON.stringify(envelope.error)).toBe(status);
				return envelope.data;
			}
			const { token: key } = await composed.apiKeys.create("shared-execution", versionOneId);
			const keyBody = {
				mcp_servers: [serverA],
				credentials: { servers: { [serverA]: { connection_credential: ALPHA_CONNECTION, tool_credential: ALPHA_TOKEN } } },
			};
			const keyPrincipal = await composed.apiKeys.authenticate(`Bearer ${key}`);
			const keyRun = await runs.submit(keyPrincipal, randomUUID(), { ...keyBody, prompt: "shared-key" });
			const legacyRun = await post<{ run_id: string }>(
				`/api/aaas/v1/integrations/${integration.id}/runs`,
				{ prompt: "shared-legacy-prompt", external_ref: { id: "shared-legacy" } },
				202,
				integration.token,
			);
			const oldRun = await post<{ workItemId: string }>("/api/orchestration/v1/events", {
				eventId: randomUUID(), alarmId: "shared-integration", input: "shared-integration-input",
				credentials: {}, credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			}, 202, integration.token);
			const chat = await post<{ accessToken: string }>("/api/embed/v1/exchange", {
				publicAppId, mode: "anonymous", anonymousVisitorId: randomUUID(), hostOrigin: origin,
			}, 200);
			const chatConversation = await post<{ conversation: { id: string } }>(
				"/api/embed/v1/conversations", { title: "shared execution" }, 201, chat.accessToken,
			);
			const chatTurn = await post<{ outputText: string }>(
				`/api/embed/v1/dev/conversations/${chatConversation.conversation.id}/turn`,
				{ text: "shared-chat-input" }, 200, chat.accessToken,
			);
			expect(chatTurn.outputText).toContain("alpha_status");
			const runIds = [keyRun.run_id, legacyRun.run_id, oldRun.workItemId];
			for (const id of runIds) {
				await expect.poll(async () => (await client.run("select state from orchestration_work_items where id=$1", id))[0]?.state)
					.toBe("succeeded");
			}
			expect(observedScopes).toEqual(expect.arrayContaining([
				expect.objectContaining({ systemPrompt: expect.stringMatching(/^shared-key/), schema: expect.not.stringContaining("alpha_token") }),
				expect.objectContaining({ systemPrompt: expect.stringMatching(/^shared-legacy-prompt/) }),
				expect.objectContaining({ input: "shared-integration-input" }),
				expect.objectContaining({ input: "shared-chat-input" }),
			]));
			expect(fakeAlpha.calls).toContainEqual({ tool: "alpha_lookup", args: { target: "shared", alpha_token: ALPHA_TOKEN } });
			expect(fakeAlpha.calls.filter((call) => call.tool === "alpha_status")).toHaveLength(3);
			expect(fakeAlpha.authorizations).toEqual(expect.arrayContaining([`Bearer ${ALPHA_CONNECTION}`, `Bearer ${platformCredential}`]));
			const conversationIds = await Promise.all(runIds.map(runConversationId));
			conversationIds.push(chatConversation.conversation.id.replace(/^conv_/, ""));
			for (const conversationId of conversationIds) {
				const [terminal] = await client.run(
					"select payload from conversation_events where tenant_id=$1 and conversation_id=$2 and event_type='turn/end'",
					tenantId, conversationId,
				);
				expect(terminal?.payload).toMatchObject({ llmUsage: { callCount: 1, total: { totalTokens: 11 } } });
			}
			const cancelRun = await runs.submit(keyPrincipal, randomUUID(), { ...keyBody, prompt: "shared-key-cancel" });
			await expect.poll(() => keyReadyForCancellation, { timeout: 5000 }).toBe(true);
			await post(`/api/aaas/v1/runs/${cancelRun.run_id}/cancel`, {}, 200, key);
			const cancelledConversationId = await runConversationId(cancelRun.run_id);
			await expect.poll(async () => (await client.run(
				"select payload from conversation_events where tenant_id=$1 and conversation_id=$2 and event_type='turn/interrupted'",
				tenantId, cancelledConversationId,
			))[0]?.payload).toMatchObject({ llmUsage: { callCount: 1, total: { totalTokens: 11 } } });
		} finally {
			http.closeAllConnections();
			await Promise.all([
				composed.close(),
				embed.close(),
				new Promise<void>((resolve) => http.close(() => resolve())),
			]);
		}
	}, 20_000);
});
