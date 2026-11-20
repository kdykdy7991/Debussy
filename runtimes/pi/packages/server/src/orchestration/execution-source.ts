/**
 * AaaS 编排执行的凭据来源适配器（R010 第二部分）。
 *
 * 把编排侧既有的凭据读取、调用前复验与审计归属接到共享工具保护上：
 *
 * - 新 Key Run：连接凭据与工具参数凭据只来自该 Run 的密封凭据；调用前复验
 *   凭据有效期；MCP 返回在接受前做安全检查；缺失即失败，不回退平台 secret；
 * - 旧 /runs 与 Integration：没有安全边界（沿用平台 secret 与既有返回口径），
 *   但工具参数凭据仍按既有绑定注入。
 *
 * 凭据值只在受保护的调用路径上出现，不进入模型上下文、进度、错误或公开事件。
 */
import {
	checkMcpResult,
	CONNECTION_FAILED,
	CREDENTIAL_EXPIRED,
	MCP_AUTH_FAILED,
	MCP_RESULT_BLOCKED,
	type McpRunGuard,
} from "./api-key-boundary.ts";
import { OrchestrationError } from "./contracts.ts";
import { toMcpCallAuditRecord } from "../publishing/mcp/runtime-tools.ts";
import type { McpCallAuditRecord as RepositoryAuditRecord } from "../publishing/repositories.ts";
import type { ToolCredentialBinding } from "@earendil-works/pi-protocol";
import type {
	ExecutionOwner,
	McpCallAuditRecord,
	McpExecutionBoundary,
	McpExecutionSource,
} from "../runtime/execution-source.ts";
import type { RuntimeScope } from "../runtime/scope-context.ts";
import type { OrchestrationStore } from "./store.ts";

export interface OrchestrationExecutionSourceDeps {
	readonly store: OrchestrationStore;
	/** Fatal boundary marker (per Run). */
	readonly guard: McpRunGuard;
	/** Audit sink for the shared audit fact. */
	readonly recordAudit: (record: RepositoryAuditRecord) => Promise<void>;
}

/**
 * Wraps an existing task boundary into the shared execution source.
 *
 * The boundary semantics stay exactly as they were (freshness, own credentials,
 * result inspection, fatal marking); only the tool-credential part and the
 * attribution are supplied by the caller.
 */
export function createBoundaryExecutionSource(options: {
	/** 缺省表示该执行没有安全边界（旧入口口径）。 */
	readonly boundary: McpExecutionBoundary | undefined;
	readonly owner: ExecutionOwner;
	readonly toolBindings?: (
		serverId: string,
		toolName: string,
	) => Promise<readonly ToolCredentialBinding[]>;
	readonly toolCredentials?: (
		serverId: string,
		toolName: string,
		credentialNames: readonly string[],
	) => Promise<Readonly<Record<string, string>>>;
	readonly markFatal?: (code: string) => void;
	readonly recordAudit?: (record: McpCallAuditRecord) => Promise<void>;
}): McpExecutionSource {
	return {
		owner: options.owner,
		...(options.boundary === undefined ? {} : { boundary: options.boundary }),
		async toolBindings(serverId, toolName) {
			return (await options.toolBindings?.(serverId, toolName)) ?? [];
		},
		async toolCredentials(serverId, toolName, credentialNames) {
			return (await options.toolCredentials?.(serverId, toolName, credentialNames)) ?? {};
		},
		markFatal(code) {
			options.markFatal?.(code);
		},
		async recordAudit(record) {
			await options.recordAudit?.(record);
		},
	};
}

/**
 * Resolves the credential source of one orchestration execution.
 *
 * The scope must carry the Turn (the sealed credentials belong to the running
 * assignment). Without a Turn there is no execution to protect.
 */
export function createOrchestrationExecutionSource(
	deps: OrchestrationExecutionSourceDeps,
): (scope: RuntimeScope) => Promise<McpExecutionSource | undefined> {
	return async (scope) => {
		const turnId = scope.turnId;
		if (turnId === undefined || scope.conversationId === undefined) return undefined;
		const conversationId = scope.conversationId;
		const credentials = await deps.store.credentials(conversationId, turnId);
		const owner = { kind: "conversation" as const, conversationId, turnId };
		const maxBytes = scope.limits.toolResultMaxBytes;
		return {
			owner,
			// New-Key Runs own their credentials and their safety boundary; legacy
			// Runs keep the platform-secret behaviour.
			...(credentials.keyId === null
				? {}
				: {
						boundary: {
							async checkFresh() {
								try {
									await deps.store.credentials(conversationId, turnId);
								} catch (error) {
									if (error instanceof OrchestrationError && error.code === CREDENTIAL_EXPIRED)
										deps.guard.mark(conversationId, CREDENTIAL_EXPIRED);
									throw error;
								}
							},
							connectionCredential(serverId: string, authentication: "none" | "bearer" | "api_key") {
								if (authentication === "none") return undefined;
								const value = credentials.connectionCredential(serverId);
								if (value === undefined) {
									deps.guard.mark(conversationId, "MCP_AUTH_FAILED");
									throw new OrchestrationError(500, "MCP_AUTH_FAILED", "MCP 连接凭据不可用");
								}
								return value;
							},
							secrets: Object.values(credentials.values),
							authenticationFailed() {
								deps.guard.mark(conversationId, MCP_AUTH_FAILED);
							},
							connectionFailed() {
								deps.guard.markIfAbsent(conversationId, CONNECTION_FAILED);
							},
							inspect(content: unknown) {
								try {
									checkMcpResult(content, Object.values(credentials.values), maxBytes);
								} catch (error) {
									deps.guard.mark(conversationId, MCP_RESULT_BLOCKED);
									throw error;
								}
							},
						},
					}),
			async toolBindings(serverId, toolName) {
				return (await deps.store.toolBindings(conversationId, turnId)).filter(
					(binding) => binding.mcpServerId === serverId && binding.toolName === toolName,
				);
			},
			async toolCredentials(serverId, toolName, credentialNames) {
				// Re-read the sealed set per call: a credential can expire or be
				// withdrawn while the Run is still in flight.
				const fresh = await deps.store.credentials(conversationId, turnId).catch((error: unknown) => {
					if (error instanceof OrchestrationError && error.code === CREDENTIAL_EXPIRED)
						deps.guard.mark(conversationId, CREDENTIAL_EXPIRED);
					throw error;
				});
				return fresh.toolValues(serverId, toolName, credentialNames);
			},
			markFatal(code) {
				deps.guard.mark(conversationId, code);
			},
			async recordAudit(record) {
				await deps.recordAudit(toMcpCallAuditRecord(record));
			},
		};
	};
}
