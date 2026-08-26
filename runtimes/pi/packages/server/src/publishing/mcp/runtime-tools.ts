import { type TSchema, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readTextBuffer } from "../../citations/chunker.ts";
import type { ScopeContext } from "../../runtime/scope-context.ts";
import { fromPublicId, newMcpCallAuditId } from "../domain/ids.ts";
import type { PublishingRepositories } from "../repositories.ts";
import type { RuntimeSpec } from "../runtime-spec/schema.ts";
import type { McpSecretBox } from "./secret-box.ts";
import { connectSecureMcpClient, type McpNetworkPolicy } from "./secure-client.ts";

export interface McpRuntimeToolFactoryOptions {
	readonly repositories: PublishingRepositories;
	readonly secretBox?: McpSecretBox;
	readonly networkPolicy?: McpNetworkPolicy;
	/** Test seam; production uses the official SDK-backed secure connector. */
	readonly connect?: typeof connectSecureMcpClient;
}

export type McpRuntimeToolFactory = (spec: RuntimeSpec, scope: ScopeContext) => Promise<readonly ToolDefinition[]>;

export function createMcpRuntimeToolFactory(options: McpRuntimeToolFactoryOptions): McpRuntimeToolFactory {
	const connect = options.connect ?? connectSecureMcpClient;
	return async (spec, scope) => {
		const names = new Set<string>();
		const definitions: ToolDefinition[] = [];
		for (const frozenServer of spec.capabilities.mcpServers) {
			const mcpServerId = fromPublicId("McpServerId", frozenServer.mcpServerId);
			if (mcpServerId === null) throw new Error("RuntimeSpec contains an invalid MCP Server id");
			for (const frozenTool of frozenServer.tools) {
				if (names.has(frozenTool.name)) throw new Error(`duplicate MCP Tool name: ${frozenTool.name}`);
				names.add(frozenTool.name);
				const parameters = Type.Unsafe<Record<string, unknown>>(frozenTool.inputSchema as TSchema);
				definitions.push({
					name: frozenTool.name,
					label: frozenTool.name,
					description: frozenTool.description ?? `Tool from MCP Server ${frozenServer.mcpServerId}`,
					parameters,
					executionMode: "parallel",
					execute: async (_toolCallId, params, signal) => {
						if (params === null || typeof params !== "object" || Array.isArray(params))
							throw new Error("MCP Tool arguments must be an object");
						const argumentsValue = params as Readonly<Record<string, unknown>>;
						const startedAt = Date.now();
						let outcome: "success" | "error" | "cancelled" = "error";
						let resultBytes = 0;
						let resultTruncated = false;
						let errorCode: string | null = "MCP_CALL_FAILED";
						try {
							const server = await options.repositories.mcpServers.get(
								{ tenantId: scope.tenantId },
								mcpServerId,
							);
							const revision = await options.repositories.mcpServers.getRevision(
								{ tenantId: scope.tenantId },
								mcpServerId,
								frozenServer.revision,
							);
							if (server === undefined || server.status !== "enabled" || revision === undefined)
								throw new Error("MCP Server is unavailable");
							let bearerToken: string | undefined;
							if (frozenServer.authentication === "bearer") {
								if (options.secretBox === undefined) throw new Error("MCP credential store is unavailable");
								const secret = await options.repositories.mcpSecrets.get(
									{ tenantId: scope.tenantId },
									mcpServerId,
								);
								if (secret === undefined) throw new Error("MCP credential is unavailable");
								bearerToken = options.secretBox.open(scope.tenantId, mcpServerId, secret);
							}
							const session = await connect({
								endpoint: frozenServer.endpoint,
								bearerToken,
								networkPolicy: options.networkPolicy,
								signal,
							});
							try {
								const result = await session.callTool(frozenTool.name, argumentsValue, signal);
								if (result.isError === true) throw new Error("MCP Tool returned an error");
								const raw = Buffer.from(
									JSON.stringify({ content: result.content, structuredContent: result.structuredContent }),
									"utf8",
								);
								resultBytes = raw.byteLength;
								const bounded = readTextBuffer(raw, scope.limits.toolResultMaxBytes);
								resultTruncated = bounded.truncated;
								outcome = "success";
								errorCode = null;
								return {
									content: [{ type: "text", text: bounded.text }],
									details: { mcpServerId: frozenServer.mcpServerId, resultTruncated },
								};
							} finally {
								await session.close();
							}
						} catch (error) {
							if (signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) {
								outcome = "cancelled";
								errorCode = "MCP_CALL_CANCELLED";
							}
							throw error;
						} finally {
							await options.repositories.mcpServers.recordCallAudit({
								mcpCallAuditId: newMcpCallAuditId(),
								tenantId: scope.tenantId,
								conversationId: scope.conversationId,
								publishedAppVersionId: scope.publishedAppVersionId,
								mcpServerId,
								mcpRevision: frozenServer.revision,
								toolName: frozenTool.name,
								outcome,
								latencyMs: Date.now() - startedAt,
								resultBytes,
								resultTruncated,
								errorCode,
								requestId: null,
								createdAt: new Date(),
							});
						}
					},
				});
			}
		}
		return definitions;
	};
}
