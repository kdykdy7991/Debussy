import { type TSchema, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolCredentialBinding } from "@earendil-works/pi-protocol";
import {
	checkMcpResult,
	CONNECTION_FAILED,
	CREDENTIAL_EXPIRED,
	EXECUTION_NOT_AUTHORIZED,
	MCP_AUTH_FAILED,
	MCP_RESULT_BLOCKED,
	type McpTaskBoundary,
} from "../../orchestration/api-key-boundary.ts";
import { OrchestrationError } from "../../orchestration/contracts.ts";
import type { McpCallAuditRecord, McpExecutionSource } from "../../runtime/execution-source.ts";
import type { RuntimeScope, ScopeContext } from "../../runtime/scope-context.ts";
import type { TranscriptMessage } from "../../types.ts";
import { fromPublicId, newMcpCallAuditId, parseIdOrThrow, type McpServerId } from "../domain/ids.ts";
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
	/**
	 * Server-only tool protector (implementation injected by the orchestration
	 * layer): it removes the platform-injected parameters from the model-visible
	 * schema and injects the credential before the call leaves the process.
	 */
	readonly protectTool?: McpToolProtector;
	/** Test seam; production uses the official SDK-backed secure connector. */
	readonly connect?: typeof connectSecureMcpClient;
	/**
	 * Resolves the credential source of one execution. The scope may also carry
	 * its own source (`scope.credentialSource`); the scope wins. When neither is
	 * present the execution keeps the platform-secret behaviour (Chat/Debug).
	 */
	readonly executionSource?: (scope: RuntimeScope) => Promise<McpExecutionSource | undefined>;
}

/**
 * The server-only protection applied to one MCP tool: the model sees only the
 * business arguments, the transport alone receives the injected credential.
 */
export type McpToolProtector = (
	tool: ToolDefinition,
	schema: Readonly<Record<string, unknown>>,
	bindings: readonly ToolCredentialBinding[],
	load: () => Promise<Readonly<Record<string, string>>>,
) => ToolDefinition;

export interface McpRuntimeTools extends ReadonlyArray<ToolDefinition> {
	readonly hydrateResourceReferences?: (transcript: readonly TranscriptMessage[]) => void;
}

export type McpRuntimeToolFactory = (spec: RuntimeSpec, scope: RuntimeScope) => Promise<McpRuntimeTools>;

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
/**
 * The per-execution security boundary of the credential source. The source owns
 * the boundary semantics (freshness, own credentials, result inspection and the
 * fatal marking), so the factory applies it as-is.
 */
function buildBoundary(source: McpExecutionSource | undefined): McpTaskBoundary | undefined {
	return source?.boundary;
}

/**
 * One MCP call audit fact. A Router Operation records its own attribution and
 * leaves every legacy ownership column empty; the legacy columns keep their
 * existing derivation.
 */
function auditRecord(
	scope: RuntimeScope,
	source: McpExecutionSource | undefined,
	call: {
		readonly mcpServerId: McpServerId;
		readonly mcpRevision: number;
		readonly toolName: string;
		readonly outcome: "success" | "error" | "cancelled";
		readonly latencyMs: number;
		readonly resultBytes: number;
		readonly resultTruncated: boolean;
		readonly errorCode: string | null;
	},
): McpCallAuditRecord {
	const routerOperationId = source?.owner.kind === "router_operation" ? source.owner.operationId : null;
	const routerOwned = routerOperationId !== null;
	return {
		tenantId: scope.tenantId,
		conversationId: routerOwned ? null : (scope.conversationId ?? null),
		publishedAppVersionId: routerOwned
			? null
			: scope.executionSource?.kind === "orchestration"
				? null
				: parseIdOrThrow("PublishedAppVersionId", scope.publishedAppVersionId, "Chat audit version"),
		integrationId: routerOwned
			? null
			: scope.executionSource && scope.executionSource.kind !== "chat"
				? scope.executionSource.ownerId
				: null,
		orchestrationVersionId: routerOwned
			? null
			: scope.executionSource?.kind === "orchestration"
				? scope.publishedAppVersionId.slice(4)
				: null,
		routerOperationId,
		mcpServerId: call.mcpServerId,
		mcpRevision: call.mcpRevision,
		toolName: call.toolName,
		outcome: call.outcome,
		latencyMs: call.latencyMs,
		resultBytes: call.resultBytes,
		resultTruncated: call.resultTruncated,
		errorCode: call.errorCode,
		requestId: scope.requestId ?? null,
		createdAt: new Date(),
	};
}

/** Maps the shared audit fact onto the existing repository record. */
export function toMcpCallAuditRecord(record: McpCallAuditRecord) {
	return {
		mcpCallAuditId: newMcpCallAuditId(),
		tenantId: record.tenantId,
		conversationId: record.conversationId,
		publishedAppVersionId: record.publishedAppVersionId,
		integrationId: record.integrationId,
		orchestrationVersionId: record.orchestrationVersionId,
		mcpServerId: record.mcpServerId,
		mcpRevision: record.mcpRevision,
		toolName: record.toolName,
		outcome: record.outcome,
		latencyMs: record.latencyMs,
		resultBytes: record.resultBytes,
		resultTruncated: record.resultTruncated,
		errorCode: record.errorCode,
		requestId: record.requestId,
		createdAt: record.createdAt,
	};
}

export function createMcpRuntimeToolFactory(options: McpRuntimeToolFactoryOptions): McpRuntimeToolFactory {
	const connect = options.connect ?? connectSecureMcpClient;
	return async (spec, scope) => {
		// One source drives the whole protection: credentials, pre-call check and
		// audit attribution. The scope carries its own source (Router Operation);
		// otherwise the composition layer resolves it (AaaS Key/legacy Runs).
		const source: McpExecutionSource | undefined = scope.credentialSource ?? (await options.executionSource?.(scope));
		const boundary: McpTaskBoundary | undefined = buildBoundary(source);
		const routerOwned = source?.owner.kind === "router_operation";
		if (routerOwned && boundary === undefined) throw new Error("Router MCP 调用缺少执行保护");
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
							if (routerOwned) signal?.throwIfAborted();
							const server = await options.repositories.mcpServers.get(
								{ tenantId: scope.tenantId },
								mcpServerId,
							);
							const revision = await options.repositories.mcpServers.getRevision(
								{ tenantId: scope.tenantId },
								mcpServerId,
								frozenServer.revision,
							);
							if (server === undefined || server.status !== "enabled" || revision === undefined) {
								errorCode = "MCP_SERVER_UNAVAILABLE";
								throw new Error(
									`MCP Server is unavailable (${frozenServer.mcpServerId}): deleted, disabled, or revision missing`,
								);
							}
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
							if (boundary !== undefined) {
								await boundary.checkFresh();
							}
							if (boundary !== undefined && !routerOwned) {
								bearerToken = boundary.connectionCredential(
									frozenServer.mcpServerId,
									frozenServer.authentication,
								);
							} else if (frozenServer.authentication !== "none") {
								if (options.secretBox === undefined) {
									boundary?.authenticationFailed();
									throw new OrchestrationError(500, MCP_AUTH_FAILED, "MCP 平台连接凭据不可用");
								}
								const secret = await options.repositories.mcpSecrets
									.get({ tenantId: scope.tenantId }, mcpServerId)
									.catch(() => {
										boundary?.authenticationFailed();
										throw new OrchestrationError(500, MCP_AUTH_FAILED, "MCP 平台连接凭据不可用");
									});
								if (secret === undefined) {
									boundary?.authenticationFailed();
									throw new OrchestrationError(500, MCP_AUTH_FAILED, "MCP 平台连接凭据不可用");
								}
								try {
									bearerToken = options.secretBox.open(scope.tenantId, mcpServerId, secret);
								} catch {
									boundary?.authenticationFailed();
									throw new OrchestrationError(500, MCP_AUTH_FAILED, "MCP 平台连接凭据不可用");
								}
							}
							let session: Awaited<ReturnType<typeof connect>>;
							try {
								if (routerOwned) signal?.throwIfAborted();
								session = await connect({
									endpoint: frozenServer.endpoint,
									bearerToken: frozenServer.authentication === "bearer" ? bearerToken : undefined,
									apiKey: frozenServer.authentication === "api_key" ? bearerToken : undefined,
									onToolsChanged: options.onToolsChanged,
									networkPolicy: options.networkPolicy,
									signal,
									onAuthenticationFailure:
										boundary !== undefined && frozenServer.authentication !== "none"
											? () => boundary.authenticationFailed()
											: undefined,
									onConnectionFailure:
										boundary === undefined
											? undefined
											: (error) =>
													(() => {
														if (routerOwned && bearerToken) {
															try {
																checkMcpResult(
																	{ message: error instanceof Error ? error.message : error },
																	[bearerToken],
																	scope.limits.toolResultMaxBytes,
																);
															} catch {
																source?.markFatal(MCP_RESULT_BLOCKED);
																throw new OrchestrationError(
																	500,
																	MCP_RESULT_BLOCKED,
																	"MCP 返回内容不可用",
																);
															}
														}
														boundary.inspect({
															message: error instanceof Error ? error.message : error,
															details: error,
														});
													})(),
								});
							} catch (error) {
								// A connection-layer failure is not a Tool business error. Unless
								// it is already a recognized fatal boundary hit (or the Run was
								// cancelled), the Run must fail with a safe generic code instead
								// of letting the model turn the exception into a success report.
								const cancelled =
									signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
								if (
									boundary !== undefined &&
									!cancelled &&
									!(
										error instanceof OrchestrationError &&
										(error.code === MCP_RESULT_BLOCKED || error.code === MCP_AUTH_FAILED)
									)
								)
									boundary.connectionFailed();
								throw error;
							}
							let callFailed = true;
							try {
								if (routerOwned) {
									// Router authorization/credentials can change during the MCP handshake.
									signal?.throwIfAborted();
									await boundary?.checkFresh();
									signal?.throwIfAborted();
								}
								if (frozenTool.resourceRead && session.readResource === undefined)
									throw new Error("MCP resource reading is unavailable");
								const result = frozenTool.resourceRead
									? await session.readResource!(uri as string, signal)
									: await session.callTool(frozenTool.name, argumentsValue, signal);
								if (routerOwned) signal?.throwIfAborted();
								// T034: inspect the unredacted return before it becomes a model message,
								// resource reference, stream update, audit record or persisted event.
								// A hit or an uncheckable payload discards the whole content and fails.
								boundary?.inspect(result);
								if (routerOwned && bearerToken) {
									try {
										checkMcpResult(result, [bearerToken], scope.limits.toolResultMaxBytes);
									} catch {
										source?.markFatal(MCP_RESULT_BLOCKED);
										throw new OrchestrationError(500, MCP_RESULT_BLOCKED, "MCP 返回内容不可用");
									}
								}
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
								callFailed = false;
								return {
									content: bounded.content,
									details: { mcpServerId: frozenServer.mcpServerId, resultTruncated },
								};
							} catch (callError) {
								if (routerOwned && bearerToken) {
									try {
										checkMcpResult(
											{ message: callError instanceof Error ? callError.message : callError },
											[bearerToken],
											scope.limits.toolResultMaxBytes,
										);
									} catch {
										source?.markFatal(MCP_RESULT_BLOCKED);
										throw new OrchestrationError(500, MCP_RESULT_BLOCKED, "MCP 返回内容不可用");
									}
								}
								if (
									boundary !== undefined &&
									!(
										callError instanceof OrchestrationError &&
										(callError.code === MCP_RESULT_BLOCKED || callError.code === MCP_AUTH_FAILED)
									)
								)
									boundary.inspect({
										message: callError instanceof Error ? callError.message : callError,
										details: callError,
									});
								throw callError;
							} finally {
								await session
									.close()
									.catch((closeError: unknown) =>
										boundary === undefined || !callFailed ? Promise.reject(closeError) : undefined,
									);
							}
						} catch (error) {
							if (
								boundary !== undefined &&
								error instanceof OrchestrationError &&
								(error.code === MCP_RESULT_BLOCKED ||
									error.code === MCP_AUTH_FAILED ||
									error.code === CREDENTIAL_EXPIRED ||
									error.code === EXECUTION_NOT_AUTHORIZED)
							) {
								errorCode = error.code;
								throw error;
							}
							const cancelled =
								signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
							if (cancelled) {
								outcome = "cancelled";
								errorCode = "MCP_CALL_CANCELLED";
							}
							if (boundary !== undefined) {
								// SDK/transport exceptions can include remote JSON-RPC error text.
								// Inspect it before a model or event can see it, and never forward it.
								boundary.inspect({ message: error instanceof Error ? error.message : error, details: error });
								const safe = new Error(cancelled ? "MCP 调用已取消" : "MCP 调用失败");
								if (cancelled) safe.name = "AbortError";
								throw safe;
							}
							throw error;
						} finally {
							const record = auditRecord(scope, source, {
								mcpServerId,
								mcpRevision: frozenServer.revision,
								toolName: frozenTool.name,
								outcome,
								latencyMs: Date.now() - startedAt,
								resultBytes,
								resultTruncated,
								errorCode,
							});
							// The source owns the attribution: a Router Operation records its
							// own call, everything else keeps the legacy audit columns.
							if (source !== undefined) await source.recordAudit(record);
							else await options.repositories.mcpServers.recordCallAudit(toMcpCallAuditRecord(record));
						}
					},
				});
			}
		}
		const protectedDefinitions =
			source === undefined
				? definitions
				: await Promise.all(
						definitions.map(async (tool) => {
							const server = spec.capabilities.mcpServers.find((entry) =>
								entry.tools.some((candidate) => candidate.name === tool.name),
							);
							if (server === undefined) return tool;
							const schema = server.tools.find((candidate) => candidate.name === tool.name)!.inputSchema;
							const bindings = await source.toolBindings(server.mcpServerId, tool.name);
							if (bindings.length === 0) return tool;
							if (options.protectTool === undefined) throw new Error("MCP 工具保护不可用");
							return options.protectTool(tool, schema, bindings, async () =>
								// Only the credentials mapped to this (Server, Tool) reach the
								// transport; the rest of the execution stays sealed.
								source.toolCredentials(
									server.mcpServerId,
									tool.name,
									bindings.map((binding) => binding.credential),
								),
							);
						}),
					);
		return Object.assign(protectedDefinitions, {
			hydrateResourceReferences: (transcript: readonly TranscriptMessage[]) =>
				restoreMcpResourceReferences(bindings, transcript),
		});
	};
}
