/**
 * T031 / T034 / T035: task-only MCP credentials and the unified result boundary.
 * The boundary must see the unredacted return; a hit or an auth failure must
 * terminate the Run with a fixed code, and legacy Runs must be unaffected.
 */
import { describe, expect, test, vi } from "vitest";
import {
	CREDENTIAL_EXPIRED,
	checkMcpResult,
	createTaskBoundary,
	MCP_AUTH_FAILED,
	MCP_RESULT_BLOCKED,
	McpRunGuard,
} from "../../src/orchestration/api-key-boundary.ts";
import { OrchestrationError } from "../../src/orchestration/contracts.ts";
import { createBoundaryExecutionSource } from "../../src/orchestration/execution-source.ts";
import { createMcpRuntimeToolFactory } from "../../src/publishing/mcp/runtime-tools.ts";

const secret = "super-secret-value-42";

describe("unified MCP result boundary", () => {
	test("detects exact text and explicitly supported encodings", () => {
		const payload = (text: string) => ({ content: [{ type: "text", text }] });
		expect(() => checkMcpResult(payload("ok"), [secret], 65_536)).not.toThrow();
		for (const form of [secret, Buffer.from(secret, "utf8").toString("base64"), encodeURIComponent(secret)])
			expect(() => checkMcpResult(payload(`echo ${form}`), [secret], 65_536)).toThrow(
				expect.objectContaining({ code: MCP_RESULT_BLOCKED }),
			);
	});

	test("uncheckable payloads (oversized, binary blocks) are rejected without content", () => {
		const binary = { content: [{ type: "image", data: "abc" }] };
		expect(() => checkMcpResult(binary, [secret], 65_536)).toThrow(
			expect.objectContaining({ code: MCP_RESULT_BLOCKED }),
		);
		expect(() => checkMcpResult({ content: [{ type: "text", text: "x".repeat(100) }] }, [secret], 32)).toThrow(
			expect.objectContaining({ code: MCP_RESULT_BLOCKED }),
		);
	});

	test("typeless content blocks are uncheckable instead of silently delivered", () => {
		expect(() => checkMcpResult({ content: [{ text: "implicitly typed" }] }, [secret], 65_536)).toThrow(
			expect.objectContaining({ code: MCP_RESULT_BLOCKED }),
		);
	});

	test("structuredContent, _meta and annotations are part of the inspected text", () => {
		expect(() =>
			checkMcpResult(
				{
					content: [{ type: "text", text: "safe" }],
					structuredContent: { nested: { token: secret } },
					_meta: { trace: Buffer.from(secret, "utf8").toString("base64") },
				},
				[secret],
				65_536,
			),
		).toThrow(expect.objectContaining({ code: MCP_RESULT_BLOCKED }));
	});

	test("a payload that cannot be serialised for inspection is rejected", () => {
		const circular: Record<string, unknown> = { content: [{ type: "text", text: "safe" }] };
		circular.self = circular;
		expect(() => checkMcpResult(circular, [secret], 65_536)).toThrow(
			expect.objectContaining({ code: MCP_RESULT_BLOCKED }),
		);
	});

	test("short credentials are checked as well", () => {
		expect(() => checkMcpResult({ content: [{ type: "text", text: "abc" }] }, ["abc"], 65_536)).toThrow(
			expect.objectContaining({ code: MCP_RESULT_BLOCKED }),
		);
	});

	test("resource contents reject binary and inspect text before delivery", () => {
		expect(() => checkMcpResult({ contents: [{ uri: "x", blob: "AA==" }] }, [secret], 65_536)).toThrow(
			expect.objectContaining({ code: MCP_RESULT_BLOCKED }),
		);
		expect(() => checkMcpResult({ contents: [{ uri: "x", text: secret }] }, [secret], 65_536)).toThrow(
			expect.objectContaining({ code: MCP_RESULT_BLOCKED }),
		);
		expect(() => checkMcpResult({ contents: [{ uri: "x", text: "safe" }] }, [secret], 65_536)).not.toThrow();
	});

	test("guard marks a fatal Run and can be consumed once", () => {
		const guard = new McpRunGuard();
		const boundary = createTaskBoundary({
			keyId: "key-1",
			values: { "srv:mcp_server_a:connection": secret },
			maxBytes: 65_536,
			guard,
			conversationId: "conv-1",
		});
		expect(boundary).toBeDefined();
		expect(() => boundary?.inspect({ content: [{ type: "text", text: `leak ${secret}` }] })).toThrow();
		expect(guard.take("conv-1")).toBe(MCP_RESULT_BLOCKED);
		expect(guard.take("conv-1")).toBeUndefined();
	});

	test("legacy Run has no boundary; new Run never falls back to a platform secret", () => {
		const guard = new McpRunGuard();
		expect(
			createTaskBoundary({ keyId: null, values: {}, maxBytes: 65_536, guard, conversationId: "c" }),
		).toBeUndefined();
		const boundary = createTaskBoundary({
			keyId: "key-2",
			values: {},
			maxBytes: 65_536,
			guard,
			conversationId: "c",
		});
		expect(() => boundary?.connectionCredential("mcp_server_a", "bearer")).toThrow(
			expect.objectContaining({ code: MCP_AUTH_FAILED }),
		);
		expect(guard.take("c")).toBe(MCP_AUTH_FAILED);
		expect(boundary?.connectionCredential("mcp_server_a", "none")).toBeUndefined();
	});
});

describe("MCP runtime tool factory with a task boundary", () => {
	const serverId = `mcp_${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`;
	const toolName = "lookup";
	const spec = {
		schemaVersion: 1,
		publishedAppVersionId: "orv_test",
		agent: { systemPrompt: "p", model: { provider: "test", modelId: "m" } },
		capabilities: {
			mcpServers: [
				{
					mcpServerId: serverId,
					revision: 1,
					transport: "streamable_http",
					endpoint: "https://mcp.example.com/v1",
					authentication: "bearer",
					tools: [
						{
							name: toolName,
							description: null,
							inputSchema: { type: "object", properties: {} },
							inputSchemaHash: "a".repeat(64),
						},
					],
				},
			],
		},
	};
	const scope = {
		tenantId: "t" as never,
		publishedAppId: null,
		publishedAppVersionId: "orv_test",
		executionSource: { kind: "orchestration" as const, ownerId: "integration", versionId: "orv_test" },
		principalId: "p" as never,
		conversationId: "conv" as never,
		limits: {
			maxTurns: 10,
			maxContextTokens: 1000,
			toolResultMaxBytes: 65_536,
			turnTimeoutMs: 1000,
			maxConcurrentTurnsPerConversation: 1,
		},
	};
	const fakeRepositories = () => ({
		mcpServers: {
			get: async () => ({ status: "enabled", currentRevision: 1, name: "s" }),
			getRevision: async () => ({ revision: 1 }),
			recordCallAudit: async () => {},
		},
	});
	const executeTool = (tool: { execute: (...args: never[]) => Promise<unknown> }, id: string, params: object) =>
		tool.execute(id as never, params as never, undefined as never, undefined as never, {} as never);

	test("task-only boundary uses the Run credential and never reads mcpSecrets", async () => {
		const mcpSecretsGet = vi.fn();
		const connect = vi.fn(async () => ({
			callTool: async () => ({ content: [{ type: "text", text: "safe" }] }),
			close: async () => {},
		}));
		const guard = new McpRunGuard();
		const factory = createMcpRuntimeToolFactory({
			repositories: {
				...fakeRepositories(),
				mcpSecrets: { get: mcpSecretsGet },
			} as never,
			secretBox: { open: () => "PLATFORM_SECRET" } as never,
			connect: connect as never,
			executionSource: async () =>
				createBoundaryExecutionSource({
					boundary: createTaskBoundary({

					keyId: "key",
					values: { [`srv:${serverId}:connection`]: secret },
					maxBytes: 65_536,
					guard,
					conversationId: "conv",
					}),
					owner: { kind: "conversation", conversationId: "conv" },
				}),
		});
		const tools = await factory(spec as never, scope as never);
		await executeTool(tools[0]!, "call-1", {});
		expect(mcpSecretsGet).not.toHaveBeenCalled();
		expect(connect).toHaveBeenCalledWith(expect.objectContaining({ bearerToken: secret }));
	}, 15000);

	test("expired credentials stop unbound tools and resource reads before another connection", async () => {
		const guard = new McpRunGuard();
		let expired = false;
		const connect = vi.fn(async () => ({
			callTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ uri: "test://fixture" }) }] }),
			close: async () => {},
		}));
		const secrets = vi.fn();
		const factory = createMcpRuntimeToolFactory({
			repositories: { ...fakeRepositories(), mcpSecrets: { get: secrets } } as never,
			connect: connect as never,
			executionSource: async () =>
				createBoundaryExecutionSource({
					boundary: createTaskBoundary({

					keyId: "key",
					values: { [`srv:${serverId}:connection`]: secret },
					maxBytes: 65_536,
					guard,
					conversationId: "conv",
					validateCredentials: async () => {
						if (expired) throw new OrchestrationError(401, CREDENTIAL_EXPIRED, "expired");
					},
					}),
					owner: { kind: "conversation", conversationId: "conv" },
				}),
		});
		const tools = await factory(spec as never, scope as never);
		await executeTool(tools[0]!, "discover", {});
		expired = true;
		await expect(executeTool(tools[0]!, "expired", {})).rejects.toThrow();
		expect(guard.take("conv")).toBe(CREDENTIAL_EXPIRED);
		await expect(executeTool(tools[1]!, "expired-resource", { uri: "test://fixture" })).rejects.toThrow();
		expect(guard.take("conv")).toBe(CREDENTIAL_EXPIRED);
		expect(connect).toHaveBeenCalledTimes(1);
		expect(secrets).not.toHaveBeenCalled();
	});

	test("an echoed credential in the raw return fails before it is delivered", async () => {
		const guard = new McpRunGuard();
		const factory = createMcpRuntimeToolFactory({
			repositories: fakeRepositories() as never,
			secretBox: { open: () => "PLATFORM_SECRET" } as never,
			connect: (async () => ({
				callTool: async () => ({ content: [{ type: "text", text: `leak ${secret}` }] }),
				close: async () => {},
			})) as never,
			executionSource: async () =>
				createBoundaryExecutionSource({
					boundary: createTaskBoundary({

					keyId: "key",
					values: { [`srv:${serverId}:connection`]: secret },
					maxBytes: 65_536,
					guard,
					conversationId: "conv",
					}),
					owner: { kind: "conversation", conversationId: "conv" },
				}),
		});
		const tools = await factory(spec as never, scope as never);
		await expect(executeTool(tools[0]!, "call-2", {})).rejects.toMatchObject({
			code: MCP_RESULT_BLOCKED,
		});
		expect(guard.take("conv")).toBe(MCP_RESULT_BLOCKED);
	}, 15000);

	test("an error result is inspected before it is treated as a tool error", async () => {
		const guard = new McpRunGuard();
		const factory = createMcpRuntimeToolFactory({
			repositories: fakeRepositories() as never,
			connect: (async () => ({
				callTool: async () => ({ isError: true, content: [{ type: "text", text: secret }] }),
				close: async () => {},
			})) as never,
			executionSource: async () =>
				createBoundaryExecutionSource({
					boundary: createTaskBoundary({

					keyId: "key",
					values: { [`srv:${serverId}:connection`]: secret },
					maxBytes: 65_536,
					guard,
					conversationId: "conv",
					}),
					owner: { kind: "conversation", conversationId: "conv" },
				}),
		});
		const tools = await factory(spec as never, scope as never);
		await expect(executeTool(tools[0]!, "error", {})).rejects.toMatchObject({ code: MCP_RESULT_BLOCKED });
		expect(guard.take("conv")).toBe(MCP_RESULT_BLOCKED);
	});

	test("a remote exception is checked even when closing also fails", async () => {
		const guard = new McpRunGuard();
		const factory = createMcpRuntimeToolFactory({
			repositories: fakeRepositories() as never,
			connect: (async () => ({
				callTool: async () => {
					throw new Error(`remote error ${secret}`);
				},
				close: async () => {
					throw new Error("close failure");
				},
			})) as never,
			executionSource: async () =>
				createBoundaryExecutionSource({
					boundary: createTaskBoundary({

					keyId: "key",
					values: { [`srv:${serverId}:connection`]: secret },
					maxBytes: 65_536,
					guard,
					conversationId: "conv",
					}),
					owner: { kind: "conversation", conversationId: "conv" },
				}),
		});
		const tools = await factory(spec as never, scope as never);
		await expect(executeTool(tools[0]!, "error", {})).rejects.toMatchObject({ code: MCP_RESULT_BLOCKED });
		expect(guard.take("conv")).toBe(MCP_RESULT_BLOCKED);
	});

	test("a safe return followed by a failing close is inspected, not delivered as success", async () => {
		const guard = new McpRunGuard();
		const factory = createMcpRuntimeToolFactory({
			repositories: fakeRepositories() as never,
			connect: (async () => ({
				callTool: async () => ({ content: [{ type: "text", text: "safe" }] }),
				close: async () => {
					throw new Error(`close ${secret}`);
				},
			})) as never,
			executionSource: async () =>
				createBoundaryExecutionSource({
					boundary: createTaskBoundary({

					keyId: "key",
					values: { [`srv:${serverId}:connection`]: secret },
					maxBytes: 65_536,
					guard,
					conversationId: "conv",
					}),
					owner: { kind: "conversation", conversationId: "conv" },
				}),
		});
		const tools = await factory(spec as never, scope as never);
		await expect(executeTool(tools[0]!, "close-error", {})).rejects.toMatchObject({ code: MCP_RESULT_BLOCKED });
		expect(guard.take("conv")).toBe(MCP_RESULT_BLOCKED);
	});

	test("a credential in an exception signals fatal before a slow close completes", async () => {
		const guard = new McpRunGuard();
		let release: (() => void) | undefined;
		const closed = new Promise<void>((resolve) => {
			release = resolve;
		});
		const factory = createMcpRuntimeToolFactory({
			repositories: fakeRepositories() as never,
			connect: (async () => ({
				callTool: async () => {
					throw new Error(`remote ${secret}`);
				},
				close: async () => closed,
			})) as never,
			executionSource: async () =>
				createBoundaryExecutionSource({
					boundary: createTaskBoundary({

					keyId: "key",
					values: { [`srv:${serverId}:connection`]: secret },
					maxBytes: 65_536,
					guard,
					conversationId: "conv",
					}),
					owner: { kind: "conversation", conversationId: "conv" },
				}),
		});
		const tools = await factory(spec as never, scope as never);
		const outcome = executeTool(tools[0]!, "slow-close", {}).catch((error: unknown) => error);
		try {
			await expect.poll(() => guard.take("conv")).toBe(MCP_RESULT_BLOCKED);
		} finally {
			release?.();
		}
		expect(await outcome).toMatchObject({ code: MCP_RESULT_BLOCKED });
	});

	test("an aborted tool still checks a remote exception before forwarding", async () => {
		const guard = new McpRunGuard();
		const factory = createMcpRuntimeToolFactory({
			repositories: fakeRepositories() as never,
			connect: (async () => ({
				callTool: async () => {
					throw new Error(`remote ${secret}`);
				},
				close: async () => {},
			})) as never,
			executionSource: async () =>
				createBoundaryExecutionSource({
					boundary: createTaskBoundary({

					keyId: "key",
					values: { [`srv:${serverId}:connection`]: secret },
					maxBytes: 65_536,
					guard,
					conversationId: "conv",
					}),
					owner: { kind: "conversation", conversationId: "conv" },
				}),
		});
		const tools = await factory(spec as never, scope as never);
		const controller = new AbortController();
		controller.abort();
		await expect(
			tools[0]!.execute("call", {}, controller.signal, undefined as never, {} as never),
		).rejects.toMatchObject({ code: MCP_RESULT_BLOCKED });
		expect(guard.take("conv")).toBe(MCP_RESULT_BLOCKED);
	});

	test("V1 has no streaming-result channel: the tool never calls onUpdate, and any future one must inspect before clean", async () => {
		const guard = new McpRunGuard();
		const onUpdate = vi.fn();
		const factory = createMcpRuntimeToolFactory({
			repositories: fakeRepositories() as never,
			connect: (async () => ({
				callTool: async () => ({ content: [{ type: "text", text: "safe" }] }),
				close: async () => {},
			})) as never,
			executionSource: async () =>
				createBoundaryExecutionSource({
					boundary: createTaskBoundary({

					keyId: "key",
					values: { [`srv:${serverId}:connection`]: secret },
					maxBytes: 65_536,
					guard,
					conversationId: "conv",
					}),
					owner: { kind: "conversation", conversationId: "conv" },
				}),
		});
		const tools = await factory(spec as never, scope as never);
		// The MCP adapter passes no onUpdate to the Tool executor (runtime-tools.ts
		// execute only declares three parameters) and invokes no streaming delivery.
		await tools[0]!.execute("call", {}, undefined as never, onUpdate, {} as never);
		expect(onUpdate).not.toHaveBeenCalled();
	});

	test("legacy Run keeps reading the platform secret", async () => {
		const connect = vi.fn(async () => ({
			callTool: async () => ({ content: [{ type: "text", text: "safe" }] }),
			close: async () => {},
		}));
		const factory = createMcpRuntimeToolFactory({
			repositories: {
				...fakeRepositories(),
				mcpSecrets: { get: async () => ({ ciphertext: "c" }) },
			} as never,
			secretBox: { open: () => "PLATFORM_SECRET" } as never,
			connect: connect as never,
			// No execution source: the legacy platform-secret behaviour stays.
			executionSource: async () => undefined,
		});
		const tools = await factory(spec as never, scope as never);
		await executeTool(tools[0]!, "call-3", {});
		expect(connect).toHaveBeenCalledWith(expect.objectContaining({ bearerToken: "PLATFORM_SECRET" }));
	}, 15000);
});
