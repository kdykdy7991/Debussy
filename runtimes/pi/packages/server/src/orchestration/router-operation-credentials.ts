/**
 * Router Operation 的凭据来源（R010 第二部分）。
 *
 * 工具业务凭据来自本次请求的密封来源，MCP 连接凭据由共享工具工厂从管理中心读取。
 * 已受理的旧 Operation 可能包含历史连接凭据，它只参与敏感值检查，不用于连接。
 *
 * 密封作用域绑定到 (tenant, operation, dimension)，因此一个 Operation 的密文
 * 无法被另一个 Operation 打开。
 */
import type { ToolCredentialBinding } from "@earendil-works/pi-protocol";
import {
	checkMcpResult,
	CONNECTION_FAILED,
	CREDENTIAL_EXPIRED,
	EXECUTION_NOT_AUTHORIZED,
	MCP_AUTH_FAILED,
	MCP_RESULT_BLOCKED,
	type McpRunGuard,
} from "./api-key-boundary.ts";
import { OrchestrationError } from "./contracts.ts";
import type { SealedCredentialValue, WorkCredentialBox } from "./credentials.ts";
import type { TenantId } from "../publishing/domain/ids.ts";
import type { McpCallAuditRecord, McpExecutionSource } from "../runtime/execution-source.ts";

/** 凭据的维度：某个 MCP Server 的连接凭据，或某个 Tool 的参数凭据。 */
export type RouterCredentialDimension =
	| { readonly kind: "connection"; readonly serverId: string }
	| {
			readonly kind: "tool";
			readonly serverId: string;
			readonly toolName: string;
			readonly credentialId: string;
	  };

/** 一次 Router Operation 请求带来的密封凭据。 */
export interface RouterOperationSealedCredentials {
	/** 连接凭据（按 MCP Server）。 */
	readonly connection?: readonly { readonly serverId: string; readonly sealed: SealedCredentialValue }[];
	/** 工具参数凭据（按 Server/Tool/credentialId）。 */
	readonly tool?: readonly {
		readonly serverId: string;
		readonly toolName: string;
		readonly credentialId: string;
		readonly sealed: SealedCredentialValue;
	}[];
	/** 参数绑定：平台注入哪些参数、映射到哪个凭据。 */
	readonly bindings?: readonly ToolCredentialBinding[];
	/** 凭据有效期；缺省视为已过期（fail-closed）。 */
	readonly expiresAt?: Date;
}

/** The scope a Router credential is sealed under. */
export function routerCredentialScope(
	tenantId: TenantId,
	operationId: string,
	dimension: RouterCredentialDimension,
): string {
	const suffix =
		dimension.kind === "connection"
			? `srv:${dimension.serverId}:connection`
			: `tool:${dimension.serverId}:${dimension.toolName}:${dimension.credentialId}`;
	return `${tenantId}:${operationId}:${suffix}`;
}

export interface RouterExecutionSourceOptions {
	readonly operationId: string;
	readonly tenantId: TenantId;
	readonly credentials: RouterOperationSealedCredentials;
	/** Opens the sealed values; only the owning Operation can open them. */
	readonly box: WorkCredentialBox;
	/** Fatal boundary marker of this Operation. */
	readonly guard: McpRunGuard;
	/** Supplied by the execution owner; rejects when this Operation can no longer dispatch tools. */
	readonly authorizeMcpCall: () => Promise<void>;
	readonly signal: AbortSignal;
	/** Audit sink of this Operation (the database write lands with the Operation row). */
	readonly recordAudit?: (record: McpCallAuditRecord) => Promise<void>;
	/** Clock used for the credential lifetime. */
	readonly now?: () => number;
	/** Maximum accepted MCP result size (bytes). */
	readonly maxBytes?: number;
}

/**
 * Builds the credential source of one Router Operation.
 *
 * The source carries the Operation's tool credential and security boundary.
 * The shared MCP factory reads the platform connection credential.
 */
export function createRouterExecutionSource(options: RouterExecutionSourceOptions): McpExecutionSource {
	const now = options.now ?? Date.now;
	const { operationId, tenantId } = options;
	const guard = options.guard;

	const expired = (): boolean => {
		if (!options.credentials.connection?.length && !options.credentials.tool?.length) return false;
		const expiresAt = options.credentials.expiresAt?.getTime() ?? NaN;
		return !Number.isFinite(expiresAt) || expiresAt <= now();
	};

	const openConnection = (serverId: string): string | undefined => {
		const entry = options.credentials.connection?.find((item) => item.serverId === serverId);
		if (entry === undefined) return undefined;
		return options.box.openValue(
			routerCredentialScope(tenantId, operationId, { kind: "connection", serverId }),
			entry.sealed,
		);
	};

	const openToolCredential = (serverId: string, toolName: string, credentialId: string): string | undefined => {
		const entry = options.credentials.tool?.find(
			(item) => item.serverId === serverId && item.toolName === toolName && item.credentialId === credentialId,
		);
		if (entry === undefined) return undefined;
		return options.box.openValue(
			routerCredentialScope(tenantId, operationId, { kind: "tool", serverId, toolName, credentialId }),
			entry.sealed,
		);
	};

	const openedSecrets = (): string[] => {
		const secrets: string[] = [];
		for (const entry of options.credentials.connection ?? []) {
			const value = openConnection(entry.serverId);
			if (value !== undefined) secrets.push(value);
		}
		for (const entry of options.credentials.tool ?? []) {
			const value = openToolCredential(entry.serverId, entry.toolName, entry.credentialId);
			if (value !== undefined) secrets.push(value);
		}
		return secrets;
	};

	const secrets = openedSecrets();
	const maxBytes = options.maxBytes ?? 65_536;

	return {
		owner: { kind: "router_operation", operationId },
		boundary: {
			async checkFresh() {
				options.signal.throwIfAborted();
				if (expired()) {
					guard.mark(operationId, CREDENTIAL_EXPIRED);
					throw new OrchestrationError(401, CREDENTIAL_EXPIRED, "凭据已过期");
				}
				try {
					await options.authorizeMcpCall();
				} catch {
					options.signal.throwIfAborted();
					guard.mark(operationId, EXECUTION_NOT_AUTHORIZED);
					throw new OrchestrationError(403, EXECUTION_NOT_AUTHORIZED, "执行已无权调用 MCP");
				}
				options.signal.throwIfAborted();
			},
			connectionCredential(serverId, authentication) {
				if (authentication === "none") return undefined;
				const value = openConnection(serverId);
				if (value === undefined) {
					// Missing credentials fail the Operation; the platform secret is
					// never a fallback for a Router Operation.
					guard.mark(operationId, MCP_AUTH_FAILED);
					throw new OrchestrationError(500, MCP_AUTH_FAILED, "MCP 连接凭据不可用");
				}
				return value;
			},
			secrets,
			authenticationFailed() {
				guard.mark(operationId, MCP_AUTH_FAILED);
			},
			connectionFailed() {
				guard.mark(operationId, CONNECTION_FAILED);
			},
			inspect(content: unknown) {
				// The same result check the AaaS path uses: an unsafe or uncheckable
				// return is discarded and the Operation fails.
				try {
					checkMcpResult(content, secrets, maxBytes);
				} catch (error) {
					guard.mark(operationId, MCP_RESULT_BLOCKED);
					throw error;
				}
			},
		},
		async toolBindings(serverId, toolName) {
			return (options.credentials.bindings ?? []).filter(
				(binding) => binding.mcpServerId === serverId && binding.toolName === toolName,
			);
		},
		async toolCredentials(serverId, toolName, credentialNames) {
			options.signal.throwIfAborted();
			if (expired()) {
				guard.mark(operationId, CREDENTIAL_EXPIRED);
				throw new OrchestrationError(401, CREDENTIAL_EXPIRED, "凭据已过期");
			}
			const values: Record<string, string> = {};
			for (const name of credentialNames) {
				const value = openToolCredential(serverId, toolName, name);
				if (value === undefined) {
					guard.mark(operationId, MCP_AUTH_FAILED);
					throw new OrchestrationError(500, MCP_AUTH_FAILED, "工具凭据不可用");
				}
				values[name] = value;
			}
			return values;
		},
		markFatal(code) {
			guard.mark(operationId, code);
		},
		async recordAudit(record) {
			await options.recordAudit?.(record);
		},
	};
}
