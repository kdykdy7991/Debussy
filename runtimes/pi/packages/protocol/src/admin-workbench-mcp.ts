import type { AgentPublicId } from "./admin-workbench.ts";
import type { AgentBindingRef } from "./admin-workbench-skills.ts";

/** MVP supports the maintained MCP Streamable HTTP transport only. */
export interface McpStreamableHttpConfig {
	readonly transport: "streamable_http";
	readonly endpoint: string;
	readonly authentication: "none" | "bearer";
}

export interface McpToolRef {
	readonly id: string;
	readonly name: string;
	readonly description: string | null;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	readonly inputSchemaHash: string;
}

export interface McpServerSummary {
	readonly id: string;
	readonly name: string;
	readonly status: "enabled" | "disabled";
	readonly currentRevision: number;
	readonly transport: "streamable_http";
	readonly toolCount: number;
	readonly secretConfigured: boolean;
	readonly updatedAt: string;
}

export interface McpServerRevisionSummary {
	readonly revision: number;
	readonly config: McpStreamableHttpConfig;
	readonly tools: readonly McpToolRef[];
	readonly createdAt: string;
}

export interface McpServerDetail extends McpServerSummary {
	readonly revisions: readonly McpServerRevisionSummary[];
	readonly boundAgents: readonly AgentBindingRef[];
	readonly lastTest: {
		readonly ok: boolean;
		readonly latencyMs: number | null;
		readonly at: string;
	} | null;
}

export interface McpServerCreateRequest {
	readonly name: string;
	readonly config: McpStreamableHttpConfig;
}

export interface McpServerRevisionCreateRequest {
	readonly config: McpStreamableHttpConfig;
}

/** Secret values are write-only and never appear in a response DTO. */
export interface McpSecretReplaceRequest {
	readonly bearerToken: string;
}

export interface McpSecretStatusResponse {
	readonly id: string;
	readonly secretConfigured: boolean;
}

export interface McpTestResponse {
	readonly ok: boolean;
	readonly latencyMs: number | null;
	readonly error?: string;
	readonly tools?: readonly McpToolRef[];
}

export interface McpSyncToolsResponse {
	readonly ok: boolean;
	readonly revision: number;
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly changed: readonly string[];
}

export interface McpServerStatusUpdateRequest {
	readonly enabled: boolean;
}

/** Agent Revision freezes one MCP Revision and an exact Tool-name allowlist. */
export interface AgentMcpRevisionReference {
	readonly mcpServerId: string;
	readonly revision: number;
	readonly toolNames: readonly string[];
}

export interface AgentMcpBinding extends AgentMcpRevisionReference {
	readonly agentId: AgentPublicId;
	readonly agentRevision: number;
}

export interface McpServerListResponse {
	readonly items: readonly McpServerSummary[];
	readonly nextCursor: string | null;
}

export const AGENT_V2_MCP_ERROR_CODES = [
	"MCP_SERVER_NOT_FOUND",
	"MCP_TEST_FAILED",
	"MCP_SYNC_FAILED",
	"MCP_BINDING_VIOLATION",
	"MCP_SECRET_NOT_CONFIGURED",
	"MCP_CONFIG_NOT_APPROVED",
	"MCP_NAME_CONFLICT",
] as const;
export type AgentV2McpErrorCode = (typeof AGENT_V2_MCP_ERROR_CODES)[number];

export const AGENT_V2_MCP_ERRORS: Readonly<
	Record<AgentV2McpErrorCode, { readonly httpStatus: number; readonly retryable: boolean }>
> = {
	MCP_SERVER_NOT_FOUND: { httpStatus: 404, retryable: false },
	MCP_TEST_FAILED: { httpStatus: 422, retryable: true },
	MCP_SYNC_FAILED: { httpStatus: 422, retryable: true },
	MCP_BINDING_VIOLATION: { httpStatus: 409, retryable: false },
	MCP_SECRET_NOT_CONFIGURED: { httpStatus: 409, retryable: false },
	MCP_CONFIG_NOT_APPROVED: { httpStatus: 422, retryable: false },
	MCP_NAME_CONFLICT: { httpStatus: 409, retryable: false },
} as const;
