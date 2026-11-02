import { type TSchema, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ScopeContext } from "../../runtime/scope-context.ts";
import type { TranscriptMessage } from "../../types.ts";
import { fromPublicId, newMcpCallAuditId } from "../domain/ids.ts";
import type { PublishingRepositories } from "../repositories.ts";
import type { RuntimeSpec } from "../runtime-spec/schema.ts";
import { McpResourceReferences, mcpResourceToolName, mcpResultContent } from "./resource-content.ts";
import {
	type McpResourceBinding,
	mcpResourceReadError,
	mcpResultGuidance,
	mcpToolDescription,
} from "./resource-guidance.ts";
import { restoreMcpResourceReferences } from "./resource-history.ts";
import type { McpSecretBox } from "./secret-box.ts";
import { connectSecureMcpClient, type McpNetworkPolicy } from "./secure-client.ts";

export interface McpRuntimeToolFactoryOptions {
	readonly repositories: PublishingRepositories;
	readonly secretBox?: McpSecretBox;
	readonly networkPolicy?: McpNetworkPolicy;
	readonly onToolsChanged?: () => void;
	/** Test seam; production uses the official SDK-backed secure connector. */
	readonly connect?: typeof connectSecureMcpClient;
}

export interface McpRuntimeTools extends ReadonlyArray<ToolDefinition> {
	readonly hydrateResourceReferences?: (transcript: readonly TranscriptMessage[]) => void;
}

export type McpRuntimeToolFactory = (spec: RuntimeSpec, scope: ScopeContext) => Promise<McpRuntimeTools>;

function isJsonSchema(value: unknown): boolean {
	if (value === true || value === false) return true;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const schema = value as Readonly<Record<string, unknown>>;
	if (schema.type !== undefined) {
		// JSON Schema permits a nonempty, unique array of types (e.g. number | null).
		const types: unknown[] = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (
			types.length === 0 ||
			new Set(types).size !== types.length ||
			types.some(
				(type) =>
					typeof type !== "string" ||
					!["null", "boolean", "object", "array", "number", "string", "integer"].includes(type),
			)
		)
			return false;
	}
	if (schema.properties !== undefined) {
		if (schema.properties === null || typeof schema.properties !== "object" || Array.isArray(schema.properties))
			return false;
		if (!Object.values(schema.properties).every(isJsonSchema)) return false;
	}
	if (schema.items !== undefined && !isJsonSchema(schema.items)) return false;
	if (
		schema.required !== undefined &&
		(!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === "string"))
	)
		return false;
	return true;
}

export function createMcpRuntimeToolFactory(options: McpRuntimeToolFactoryOptions): McpRuntimeToolFactory {
	const connect = options.connect ?? connectSecureMcpClient;
	return async (spec, scope) => {
		const names = new Set<string>();
		const definitions: ToolDefinition[] = [];
		const bindings: McpResourceBinding[] = [];
		for (const frozenServer of spec.capabilities.mcpServers) {
			const mcpServerId = fromPublicId("McpServerId", frozenServer.mcpServerId);
			if (mcpServerId === null) throw new Error("RuntimeSpec contains an invalid MCP Server id");
			for (const tool of frozenServer.tools) {
				if (!isJsonSchema(tool.inputSchema)) throw new Error(`MCP Tool ${tool.name} has an invalid input schema`);
			}
			const references = new McpResourceReferences();
			const resourceToolName = mcpResourceToolName(frozenServer.mcpServerId);
			const server = await options.repositories.mcpServers.get({ tenantId: scope.tenantId }, mcpServerId);
			const binding: McpResourceBinding = {
				serverName: server?.name ?? frozenServer.mcpServerId,
				serverId: frozenServer.mcpServerId,
				readTool: resourceToolName,
				toolNames: frozenServer.tools.map((tool) => tool.name),
				references,
			};
			bindings.push(binding);
			const tools = [
				...frozenServer.tools.map((tool) => ({ ...tool, resourceRead: false })),
				{
					name: resourceToolName,
					description: null,
					inputSchema: {
						type: "object",
						properties: { uri: { type: "string", minLength: 1, maxLength: 2048 } },
						required: ["uri"],
						additionalProperties: false,
					},
					resourceRead: true,
				},
			];
			for (const frozenTool of tools) {
				if (names.has(frozenTool.name)) throw new Error(`duplicate MCP Tool name: ${frozenTool.name}`);
				names.add(frozenTool.name);
				const parameters = Type.Unsafe<Record<string, unknown>>(frozenTool.inputSchema as TSchema);
				definitions.push({
					name: frozenTool.name,
					label: `${binding.serverName} · ${frozenTool.resourceRead ? "读取图片资源" : frozenTool.name}`,
					description: mcpToolDescription(binding, frozenTool.name, frozenTool.description),
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
							if ("inputSchemaHash" in frozenTool && server.currentRevision > frozenServer.revision) {
								const latest = await options.repositories.mcpServers.listTools(
									{ tenantId: scope.tenantId },
									mcpServerId,
									server.currentRevision,
								);
								const currentTool = latest.find((tool) => tool.name === frozenTool.name);
								if (currentTool === undefined || currentTool.inputSchemaHash !== frozenTool.inputSchemaHash)
									throw new Error(
										`MCP 工具 ${frozenTool.name} 已被移除或参数已变更，请更新 Agent 的 MCP 绑定并重新发布`,
									);
							}
							const uri = argumentsValue.uri;
							if (frozenTool.resourceRead && (typeof uri !== "string" || !references.has(uri))) {
								throw mcpResourceReadError(binding, uri, bindings);
							}
							let bearerToken: string | undefined;
							if (frozenServer.authentication !== "none") {
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
								bearerToken: frozenServer.authentication === "bearer" ? bearerToken : undefined,
								apiKey: frozenServer.authentication === "api_key" ? bearerToken : undefined,
								onToolsChanged: options.onToolsChanged,
								networkPolicy: options.networkPolicy,
								signal,
							});
							try {
								if (frozenTool.resourceRead && session.readResource === undefined)
									throw new Error("MCP resource reading is unavailable");
								const result = frozenTool.resourceRead
									? await session.readResource!(uri as string, signal)
									: await session.callTool(frozenTool.name, argumentsValue, signal);
								if ("isError" in result && result.isError === true)
									throw new Error("MCP Tool returned an error");
								resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
								const responseReferences = new McpResourceReferences();
								responseReferences.discover(result);
								if ("content" in result && Array.isArray(result.content)) {
									for (const block of result.content) {
										if (block.type === "text") {
											try {
												responseReferences.discover(JSON.parse(block.text));
											} catch {
												/* Plain text is not a resource descriptor. */
											}
										}
									}
								}
								references.merge(responseReferences);
								const bounded = mcpResultContent(
									result,
									scope.limits.toolResultMaxBytes,
									mcpResultGuidance(binding, responseReferences),
									references,
								);
								resultTruncated = bounded.truncated;
								outcome = "success";
								errorCode = null;
								return {
									content: bounded.content,
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
								requestId: scope.requestId ?? null,
								createdAt: new Date(),
							});
						}
					},
				});
			}
		}
		return Object.assign(definitions, {
			hydrateResourceReferences: (transcript: readonly TranscriptMessage[]) =>
				restoreMcpResourceReferences(bindings, transcript),
		});
	};
}
