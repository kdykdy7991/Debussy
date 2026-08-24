/**
 * Agent 平台 V2：MCP Server 管理契约（候选，待总架构师冻结）。
 *
 * 对应总计划 §6 共享接口中的 MCP 能力：列表、详情、创建、更新、测试、同步
 * Tool、启停、Agent Revision 绑定与 Tool 白名单。本模块只冻结管理/控制面 DTO 形状。
 *
 * **transport 未评审**：BE-3 ADR 尚未定案前，本文件**不**把 transport 集合当公共契约
 * 导出。当前仅给出管理形状与候选的 `streamable-http` 目标描述（`McpHttpTarget`）；
 * 任何新增 transport（如 stdio）必须经 BE-3 ADR 批准后再扩展。接线 (M1) 在 transport
 * 定案后再实现。
 *
 * **Secret 只以引用保存**：请求/详情中没有接受或回传明文密钥的字段。凭据以
 * `bearerTokenRef` 等 `*Ref` 引用存储（服务端 Secret 库）；所有读取只回 `secretConfigured`
 * 布尔，绝不含秘密值。Secret 不进入 RuntimeSpec、日志、事件 payload 或导出文件。
 */
import type { AgentPublicId } from "./admin-workbench.ts";
import type { AgentBindingRef } from "./admin-workbench-skills.ts";

/**
 * 候选 transport 描述（**未冻结**）。只有当前建议首推的 `streamable-http`；
 * 其它 transport 待 BE-3 ADR 批准后以扩展 union 加入，不得先写死。
 */
export type McpTransportKind = "streamable-http";

/**
 * HTTP (streamable) 目标配置。可保存 URL 与静态非密钥请求头；任何凭据必须以
 * `bearerTokenRef` 引用服务端已存秘密，**请求体不得含明文密钥**。
 */
export interface McpHttpTarget {
	readonly transport: McpTransportKind;
	readonly url: string;
	/** 静态且非密钥的头（如 Content-Type）；不得放凭据。 */
	readonly headers?: Readonly<Record<string, string>>;
	/**
	 * 服务端 Secret 库中已存秘密的引用名。线上请求只带引用名；读取仅回
	 * `secretConfigured: boolean`，绝不回传值。
	 */
	readonly bearerTokenRef?: string;
}

/** MCP Server 创建/更新时的配置载体（单一候选 transport）。 */
export interface McpServerConfig {
	readonly target: McpHttpTarget;
}

/** MCP Tool 引用（发现/同步后由服务端持有 schema 快照）。 */
export interface McpToolRef {
	readonly id: string;
	readonly name: string;
}

/** 列表行（不含 tools/secret 状态）。 */
export interface McpServerSummary {
	/** `mcp_<uuid>`，传输层禁止裸 UUID。 */
	readonly id: string;
	readonly name: string;
	readonly transport: McpTransportKind;
	readonly status: "disabled" | "connecting" | "connected" | "error";
	readonly toolCount: number;
	/** 引用凭据是否需要补配（`true` = 已配置，密钥值永不下行）。 */
	readonly secretConfigured: boolean;
	readonly updatedAt: string;
}

/** MCP Server 详情：元数据 + tools + 引用它的 Agent Revision + 最近测试结果。 */
export interface McpServerDetail extends McpServerSummary {
	readonly tools: readonly McpToolRef[];
	/** 绑定了本 Server 的 Agent Revision（不可漂移）。 */
	readonly boundAgents: readonly AgentBindingRef[];
	readonly lastTest: {
		readonly ok: boolean;
		readonly latencyMs: number | null;
		readonly at: string;
	} | null;
}

/** `POST /api/control/v1/mcp-servers`（创建/更新）。 */
export interface McpServerUpsertRequest {
	readonly name: string;
	readonly config: McpServerConfig;
}

/** `POST /api/control/v1/mcp-servers/:id/test` 连接测试。 */
export interface McpTestResponse {
	readonly ok: boolean;
	readonly latencyMs: number | null;
	readonly error?: string;
	/** 测试期间发现并可用的 Tool（可选）。 */
	readonly tools?: readonly McpToolRef[];
}

/** `POST /api/control/v1/mcp-servers/:id/sync-tools` 结果。 */
export interface McpSyncToolsResponse {
	readonly ok: boolean;
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly changed: readonly string[];
}

/** Agent Revision 固定的 Tool 白名单（运行时不得调用白名单外 Tool）。 */
export interface McpToolAllowlist {
	readonly toolIds: readonly string[];
}

/**
 * Agent Revision → MCP 绑定（固定 MCP Server + Tool 白名单）。绑定到不可变
 * Agent Revision，不随 Agent 后续 revision 漂移。
 */
export interface AgentMcpBinding {
	readonly agentId: AgentPublicId;
	readonly agentRevision: number;
	readonly mcpServerId: string;
	readonly allowlist: McpToolAllowlist;
}

/** `GET /api/control/v1/mcp-servers` 列表（cursor 分页）。 */
export interface McpServerListResponse {
	readonly items: readonly McpServerSummary[];
	readonly nextCursor: string | null;
}

/** MCP 管理稳定错误码（控制面 `ControlErrorEnvelope`）。 */
export const AGENT_V2_MCP_ERROR_CODES = [
	// 目标 MCP Server 不存在或跨租户（统一 404）。
	"MCP_SERVER_NOT_FOUND",
	// 连接测试失败（不可达/超时/鉴权失败等）。
	"MCP_TEST_FAILED",
	// 同步 Tool 失败（schema 变化/超时/反序列化失败）。
	"MCP_SYNC_FAILED",
	// 目标已被禁用，或绑定引用了未允许的 Tool。
	"MCP_BINDING_VIOLATION",
	// 配置载入引用了未配置的凭据（需先补配置 `secretConfigured=false`）。
	"MCP_SECRET_NOT_CONFIGURED",
] as const;
export type AgentV2McpErrorCode = (typeof AGENT_V2_MCP_ERROR_CODES)[number];

/** MCP 错误码到 HTTP 状态与重试性的稳定映射。 */
export const AGENT_V2_MCP_ERRORS: Readonly<
	Record<AgentV2McpErrorCode, { readonly httpStatus: number; readonly retryable: boolean }>
> = {
	MCP_SERVER_NOT_FOUND: { httpStatus: 404, retryable: false },
	MCP_TEST_FAILED: { httpStatus: 422, retryable: true },
	MCP_SYNC_FAILED: { httpStatus: 422, retryable: true },
	MCP_BINDING_VIOLATION: { httpStatus: 409, retryable: false },
	MCP_SECRET_NOT_CONFIGURED: { httpStatus: 409, retryable: false },
} as const;
