/**
 * R010 第二部分：Router Operation 归属的共享 MCP 工具保护。
 *
 * 用受控 MCP（工厂的 `connect` 测试缝）与受控 provider（假会话）验证：
 *
 * - 模型看不到平台注入的敏感参数；
 * - 凭据只注入到被映射的那一次调用，平台 MCP secret 从不被读取；
 * - 调用前的凭据有效期/授权检查失败时拒绝外发；
 * - 缺失连接凭据时失败且不回退平台 secret；
 * - 取消能传到工具调用；
 * - 审计归属落在 Operation 上，旧归属列为空。
 */

import type { ModelRef, SessionSnapshot, ThinkingLevel } from "@earendil-works/pi-protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import type { PrincipalId, TenantId } from "../../src/publishing/domain/ids.ts";
import type { RuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import { WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { protectTool } from "../../src/orchestration/protected-tool.ts";
import { createRouterOperationExecutor } from "../../src/orchestration/router-operation-execution.ts";
import { routerCredentialScope } from "../../src/orchestration/router-operation-credentials.ts";
import { createPiRuntimeAdapter } from "../../src/runtime/pi-runtime-adapter.ts";
import { createMcpRuntimeToolFactory } from "../../src/publishing/mcp/runtime-tools.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import type { PiSessionRuntime, PiSessionRuntimeEvent, PromptInput, SteerInput } from "../../src/types.ts";

const MODEL: ModelRef = { provider: "skdy", id: "pi-chat" };
const TENANT = "11111111-1111-4111-8111-111111111111" as TenantId;
const PRINCIPAL = "22222222-2222-4222-8222-222222222222" as PrincipalId;
const OPERATION = "33333333-3333-4333-8333-333333333333";
const SERVER_PUBLIC = "mcp_44444444-4444-4444-8444-444444444444";
const TOOL_NAME = "lookup";
const CONNECTION_SECRET = "op-connection-secret";
const TOOL_SECRET = "op-tool-secret";

const SPEC = {
	schemaVersion: 1,
	publishedAppVersionId: "orv_router",
	agent: { systemPrompt: "s", model: { provider: "skdy", modelId: "pi-chat", params: {} } },
	capabilities: {
		tools: [],
		knowledgeBases: [],
		skills: [],
		mcpServers: [
			{
				mcpServerId: SERVER_PUBLIC,
				revision: 1,
				transport: "streamable_http",
				endpoint: "https://mcp.example.com/v1",
				authentication: "bearer",
				tools: [
					{
						name: TOOL_NAME,
						description: "Look up a record",
						inputSchema: {
							type: "object",
							properties: { query: { type: "string" }, apiKey: { type: "string" } },
							required: ["query", "apiKey"],
						},
						inputSchemaHash: "a".repeat(64),
					},
				],
			},
		],
		uploads: { enabled: false, maxFiles: 1, maxFileBytes: 1 },
		speech: { enabled: false },
		realtimeVoice: { enabled: false },
		avatar: { enabled: false },
		conversations: { allowNew: true },
	},
	contextPolicy: { maxTurns: 10, maxContextTokens: 1000, toolResultMaxBytes: 1024, logLevel: "standard" },
	runtimePolicy: {
		profile: "chat-only",
		turnTimeoutMs: 1000,
		idleTtlMs: 1000,
		maxConcurrentTurnsPerConversation: 1,
	},
	theme: {},
	securityPolicyVersion: "sp_001",
} as unknown as RuntimeSpec;

const LIMITS = {
	maxTurns: 10,
	maxContextTokens: 1000,
	toolResultMaxBytes: 65_536,
	turnTimeoutMs: 1000,
	maxConcurrentTurnsPerConversation: 1,
};

/** 受控 provider：prompt 挂起，测试在挂起期间驱动工具调用。 */
class ControlledSession implements PiSessionRuntime {
	readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	readonly tools: ToolDefinition[] = [];
	readonly toolController = new AbortController();
	aborted = 0;
	disposed = 0;
	private resolvePrompt: (() => void) | undefined;
	private readonly id: string;

	constructor(id: string) {
		this.id = id;
	}

	snapshot(): SessionSnapshot {
		return {
			id: this.id,
			cwd: "/tmp",
			createdAt: 1,
			updatedAt: 1,
			phase: "idle",
			model: MODEL,
			thinkingLevel: "off",
			attached: true,
			locked: true,
			lastSequence: 0,
			revision: 0,
			transcript: [],
			queuedSteer: [],
			queuedSteerCount: 0,
		} as unknown as SessionSnapshot;
	}
	getPhase(): "idle" {
		return "idle";
	}
	async prompt(_input: PromptInput): Promise<void> {
		await new Promise<void>((resolve) => {
			this.resolvePrompt = resolve;
		});
	}
	async steer(_input: SteerInput): Promise<void> {}
	async abort(): Promise<void> {
		this.aborted += 1;
		this.toolController.abort();
		this.resolvePrompt?.();
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
	finish(): void {
		this.resolvePrompt?.();
	}
}

interface Harness {
	executor: ReturnType<typeof createRouterOperationExecutor>;
	session: ControlledSession;
	audits: Record<string, unknown>[];
	receivedCalls: { name: string; args: Record<string, unknown>; signal?: AbortSignal }[];
	connect: ReturnType<typeof vi.fn>;
	mcpSecretsGet: ReturnType<typeof vi.fn>;
	box: WorkCredentialBox;
}

function createHarness(options: { holdTool?: boolean; resultText?: string; missingSecret?: boolean } = {}): Harness {
	const box = new WorkCredentialBox(new Uint8Array(32).fill(9));
	const audits: Record<string, unknown>[] = [];
	const receivedCalls: { name: string; args: Record<string, unknown>; signal?: AbortSignal }[] = [];
	const mcpSecretsGet = vi.fn(async () => options.missingSecret ? undefined : ({}));
	const connect = vi.fn(async () => ({
		listTools: async () => [],
		callTool: async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
			receivedCalls.push({ name, args, signal });
			if (options.holdTool) {
				await new Promise<never>((_, reject) => {
					if (!signal) {
						reject(new Error("missing tool signal"));
						return;
					}
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			}
			return { content: [{ type: "text", text: options.resultText ?? "ok" }] };
		},
		close: async () => {},
	}));
	const repositories = {
		mcpServers: {
			get: async () => ({ name: "router-mcp", status: "enabled", currentRevision: 1 }),
			getRevision: async () => ({ revision: 1 }),
			listTools: async () => [],
			recordCallAudit: async (record: unknown) => {
				audits.push(record as Record<string, unknown>);
			},
		},
		mcpSecrets: { get: mcpSecretsGet },
	} as unknown as PublishingRepositories;

	const factory = createMcpRuntimeToolFactory({
		repositories,
		secretBox: { open: () => "PLATFORM_SECRET" } as never,
		connect: connect as never,
		protectTool,
	});
	const session = new ControlledSession(OPERATION);
	const adapter = createPiRuntimeAdapter({
		createSession: async (options) => {
			session.tools.push(...(options.customTools ?? []));
			return session;
		},
		createMcpTools: factory,
	});
	const executor = createRouterOperationExecutor({
		adapter,
		credentialBox: box,
		recordAudit: async (record) => {
			audits.push(record as unknown as Record<string, unknown>);
		},
	});
	return { executor, session, audits, receivedCalls, connect, mcpSecretsGet, box };
}

function sealCredentials(box: WorkCredentialBox, expiresAt: Date = new Date(Date.now() + 60_000)) {
	const connectionScope = routerCredentialScope(TENANT, OPERATION, { kind: "connection", serverId: SERVER_PUBLIC });
	const toolScope = routerCredentialScope(TENANT, OPERATION, {
		kind: "tool",
		serverId: SERVER_PUBLIC,
		toolName: TOOL_NAME,
		credentialId: "ticketKey",
	});
	return {
		expiresAt,
		connection: [{ serverId: SERVER_PUBLIC, sealed: box.sealValue(connectionScope, CONNECTION_SECRET) }],
		tool: [
			{
				serverId: SERVER_PUBLIC,
				toolName: TOOL_NAME,
				credentialId: "ticketKey",
				sealed: box.sealValue(toolScope, TOOL_SECRET),
			},
		],
		bindings: [{ mcpServerId: SERVER_PUBLIC, toolName: TOOL_NAME, parameter: "apiKey", credential: "ticketKey" }],
	};
}

const REQUEST = {
	operationId: OPERATION,
	tenantId: TENANT,
	principalId: PRINCIPAL,
	publishedAppVersionId: "orv_router",
	spec: SPEC,
	input: "查一下",
	limits: LIMITS,
	authorizeMcpCall: async () => {},
};

function toolOf(harness: Harness): ToolDefinition {
	const tool = harness.session.tools.find((candidate) => candidate.name === TOOL_NAME);
	if (tool === undefined) throw new Error("tool missing");
	return tool;
}

async function callTool(harness: Harness): Promise<unknown> {
	return toolOf(harness).execute(
		"call-1",
		{ query: "q-1" } as never,
		harness.session.toolController.signal,
		undefined,
		{} as never,
	);
}

describe("Router Operation 的共享 MCP 工具保护", () => {
	test("模型看不到平台注入的参数，凭据只注入到被映射的那次调用", async () => {
		const harness = createHarness();
		const execution = harness.executor.execute({ ...REQUEST, credentials: sealCredentials(harness.box) });
		await vi.waitFor(() => expect(harness.session.tools.length).toBeGreaterThan(0));
		const tool = toolOf(harness);
		// The model-visible schema never mentions the injected parameter.
		expect(JSON.stringify(tool.parameters)).not.toContain("apiKey");
		const result = await callTool(harness);
		harness.session.finish();
		await execution;

		expect(harness.receivedCalls).toHaveLength(1);
		expect(harness.receivedCalls[0]?.args).toEqual({ query: "q-1", apiKey: TOOL_SECRET });
		// Router uses the platform's MCP connection credential.
		expect(harness.connect).toHaveBeenCalledWith(expect.objectContaining({ bearerToken: "PLATFORM_SECRET" }));
		expect(harness.mcpSecretsGet).toHaveBeenCalled();
		// The credential never reaches the model-visible result.
		expect(JSON.stringify(result)).not.toContain(TOOL_SECRET);
		await expect(callTool(harness)).rejects.toThrow();
		expect(harness.receivedCalls).toHaveLength(1);
	});

	test("凭据有效期检查失败时拒绝外发", async () => {
		const harness = createHarness();
		const credentials = sealCredentials(harness.box, new Date(Date.now() - 1000));
		const execution = harness.executor.execute({ ...REQUEST, credentials });
		await vi.waitFor(() => expect(harness.session.tools.length).toBeGreaterThan(0));
		await expect(callTool(harness)).rejects.toThrow();
		await expect(execution).resolves.toMatchObject({ status: "failed", error: "CREDENTIAL_EXPIRED" });
		expect(harness.connect).not.toHaveBeenCalled();
	});

	test("连接前及握手后复验执行授权，被拒绝时不会发出工具请求", async () => {
		for (const allowedChecks of [0, 1]) {
			const harness = createHarness();
			let checks = 0;
			const execution = harness.executor.execute({
				...REQUEST,
				credentials: sealCredentials(harness.box),
				authorizeMcpCall: async () => {
					if (++checks > allowedChecks) throw new Error("private lease details");
				},
			});
			await vi.waitFor(() => expect(harness.session.tools.length).toBeGreaterThan(0));
			await expect(callTool(harness)).rejects.toThrow();
			await expect(execution).resolves.toMatchObject({ status: "failed", error: "EXECUTION_NOT_AUTHORIZED" });
			expect(harness.connect).toHaveBeenCalledTimes(allowedChecks);
			expect(harness.receivedCalls).toHaveLength(0);
		}
	});

	test("缺失平台连接凭据时失败", async () => {
		const harness = createHarness({ missingSecret: true });
		const credentials = { ...sealCredentials(harness.box), connection: [] };
		const execution = harness.executor.execute({ ...REQUEST, credentials });
		await vi.waitFor(() => expect(harness.session.tools.length).toBeGreaterThan(0));
		await expect(callTool(harness)).rejects.toThrow();
		await expect(execution).resolves.toMatchObject({ status: "failed", error: "MCP_AUTH_FAILED" });
		expect(harness.connect).not.toHaveBeenCalled();
		expect(harness.mcpSecretsGet).toHaveBeenCalled();
	});

	test("历史 Operation 的连接凭据不作为平台连接凭据使用", async () => {
		const harness = createHarness();
		const execution = harness.executor.execute({ ...REQUEST, credentials: sealCredentials(harness.box) });
		await vi.waitFor(() => expect(harness.session.tools.length).toBeGreaterThan(0));
		await callTool(harness);
		expect(harness.connect).toHaveBeenCalledWith(expect.objectContaining({ bearerToken: "PLATFORM_SECRET" }));
		harness.session.finish();
		await execution;
	});

	test("平台密钥出现在工具返回时阻止交付", async () => {
		const harness = createHarness({ resultText: "PLATFORM_SECRET" });
		const execution = harness.executor.execute({ ...REQUEST, credentials: sealCredentials(harness.box) });
		await vi.waitFor(() => expect(harness.session.tools.length).toBeGreaterThan(0));
		await expect(callTool(harness)).rejects.toThrow();
		await expect(execution).resolves.toMatchObject({ status: "failed", error: "MCP_RESULT_BLOCKED" });
		expect(JSON.stringify(harness.audits)).not.toContain("PLATFORM_SECRET");
	});

	test("免凭据工具仍需通过执行授权", async () => {
		const harness = createHarness();
		const spec: RuntimeSpec = {
			...SPEC,
			capabilities: {
				...SPEC.capabilities,
				mcpServers: SPEC.capabilities.mcpServers.map((server) => ({
					...server,
					authentication: "none",
					tools: server.tools.map((tool) => ({
						...tool,
						inputSchema: {
							type: "object",
							properties: { query: { type: "string" } },
							required: ["query"],
						},
					})),
				})),
			},
		};
		await expect(harness.executor.execute({ ...REQUEST, spec, authorizeMcpCall: undefined })).resolves.toMatchObject({
			status: "failed",
			error: "EXECUTION_NOT_AUTHORIZED",
		});
		expect(harness.connect).not.toHaveBeenCalled();
		const execution = harness.executor.execute({ ...REQUEST, spec });
		await vi.waitFor(() => expect(harness.session.tools.length).toBeGreaterThan(0));
		await callTool(harness);
		harness.session.finish();
		await expect(execution).resolves.toMatchObject({ status: "completed" });
		expect(harness.mcpSecretsGet).not.toHaveBeenCalled();
	});

	test("取消能传到工具调用", async () => {
		const harness = createHarness({ holdTool: true });
		const controller = new AbortController();
		const execution = harness.executor.execute({
			...REQUEST,
			credentials: sealCredentials(harness.box),
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(harness.session.tools.length).toBeGreaterThan(0));
		const toolCancelled = expect(callTool(harness)).rejects.toMatchObject({ name: "AbortError" });
		await vi.waitFor(() => expect(harness.receivedCalls).toHaveLength(1));
		controller.abort();
		await toolCancelled;
		const outcome = await execution;
		expect(outcome.status).toBe("cancelled");
		expect(harness.session.aborted).toBe(1);
		expect(harness.receivedCalls[0]?.signal?.aborted).toBe(true);
		expect(harness.audits[0]).toMatchObject({ outcome: "cancelled" });
	});

	test("含凭据的 MCP 返回使 Operation 失败，错误和审计不带原文", async () => {
		const harness = createHarness({ resultText: TOOL_SECRET });
		const execution = harness.executor.execute({ ...REQUEST, credentials: sealCredentials(harness.box) });
		await vi.waitFor(() => expect(harness.session.tools.length).toBeGreaterThan(0));
		await expect(callTool(harness)).rejects.toThrow();
		await expect(execution).resolves.toMatchObject({ status: "failed", error: "MCP_RESULT_BLOCKED" });
		expect(JSON.stringify(harness.audits)).not.toContain(TOOL_SECRET);
		expect(harness.audits[0]).toMatchObject({ outcome: "error", errorCode: "MCP_RESULT_BLOCKED" });
	});

	test("审计归属落在 Operation 上，旧归属列为空", async () => {
		const harness = createHarness();
		const execution = harness.executor.execute({ ...REQUEST, credentials: sealCredentials(harness.box) });
		await vi.waitFor(() => expect(harness.session.tools.length).toBeGreaterThan(0));
		await callTool(harness);
		harness.session.finish();
		await execution;

		expect(harness.audits.length).toBeGreaterThan(0);
		const audit = harness.audits[0] ?? {};
		expect(audit.routerOperationId).toBe(OPERATION);
		expect(audit.conversationId).toBeNull();
		expect(audit.integrationId).toBeNull();
		expect(audit.publishedAppVersionId).toBeNull();
	});
});
