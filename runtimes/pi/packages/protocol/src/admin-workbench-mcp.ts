/**
 * Agent 平台 V2：MCP Server 管理契约（候选，待总架构师冻结）。
 *
 * 对应总计划 §6 共享接口中的 MCP 能力：列表、详情、创建、更新、测试、同步 Tool、
 * 启停、Agent Revision 绑定与 Tool 白名单。本模块只冻结**与 transport 无关**的管理/
 * 控制面 DTO 形状。
 *
 * **Transport / 连接配置未冻结**：BE-3 安全 ADR 定案前，本文件**不把任何 transport
 * 当作冻结的公共契约**（不导出 streamable-http/stdio 等 union），也不接受自由文本
 * headers/端点配置——尤其禁止在 headers（如 `Authorization`）中携带明文凭据。M0 阶段
 * 的 upsert 配置只是占位（`McpServerConfig`），仅允许引用服务端 Secret 库的秘密名。
 * 具体连接语义（端点、tls、鉴权方式、允许的头集合）待 BE-3 决定后以扩展字段补入。
 *
 * **Secret 只以引用保存**：线上请求/详情没有接受或回传明文密钥的字段。凭据以
 * `secretRefs` 引用存储（服务端 Secret 库）；所有读取只回 `secretConfigured: boolean`，
 * 绝不含秘密值。Secret 不进入 RuntimeSpec、日志、事件 payload 或导出文件。
 */
import type { AgentPublicId } from "./admin-workbench.ts";
import type { AgentBindingRef } from "./admin-workbench-skills.ts";

/**
 * MCP Server 连接配置。**BE-3 安全 ADR 前不冻结**：M0 只承载对服务端 Secret 库的引用，
 * 不写死端点/headers/tls/transport。任何后续扩展必须在 BE-3 批准后以显式字段加入，
 * 且禁止明文凭据与自由文本 headers（杜绝 `Authorization` 头携带明文）。
 */
export interface McpServerConfig {
	/**
	 * Secret 库中已存秘密的引用名（如 `{ "bearerTokenRef": "mcp-token-x" }`）。
	 * wire 只带引用名，绝不含秘密值；读取仅回 `secretConfigured`。
	 */
	readonly secretRefs?: Readonly<Record<string, string>>;
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
	/**
	 * Server 当前记录的 transport 标识（仅供展示）。**非冻结 union**：transport 集合
	 * 在 BE-3 安全 ADR 定案前不作枚举契约。
	 */
	readonly transport: string;
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

/**
 * `POST /api/control/v1/mcp-servers`（创建/更新）。M0 只更新名称与 Secret 引用，
 * 不传送 transport/端点/headers 配置（待 BE-3）。
 */
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
	// 尝试提交不被允许的连接配置（如自由 headers/明文凭据）→ 拒绝，待 BE-3。
	"MCP_CONFIG_NOT_APPROVED",
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
	MCP_CONFIG_NOT_APPROVED: { httpStatus: 422, retryable: false },
} as const;
