/**
 * Agent 平台 V2：MCP Server 管理契约（候选，待总架构师冻结）。
 *
 * 对应总计划 §6 共享接口中的 MCP 能力：列表、详情、创建、更新、测试、同步
 * Tool、启停、Agent Revision 绑定与 Tool 白名单。本模块只冻结管理/控制面 DTO
 * 形状；**transport 集合与连接生命周期由 backend.md BE-3 的 ADR 再定**，本文件
 * 仅以 `McpTransport` 类型标注候选集合，不承诺最终支持范围与 wire 细节。
 *
 * Secret 只以引用形式存在（`config` 中不得含明文密钥），不进入 RuntimeSpec、
 * 日志、事件 payload 或导出文件。
 */
import type { AgentPublicId } from "./admin-workbench.ts";

/**
 * 候选 transport 集合。首期支持范围以 BE-3 ADR 为准（建议先 `streamable-http`；
 * `stdio` 仅在生产部署模型与进程隔离获批后启用）。
 */
export type McpTransport = "streamable-http" | "stdio";

/** MCP Tool 引用（发现/同步后由服务端持有 schema 快照）。 */
export interface McpToolRef {
	readonly id: string;
	readonly name: string;
}

/** 列表行（不含 tools/secret 引用）。 */
export interface McpServerSummary {
	/** `mcp_<uuid>`，传输层禁止裸 UUID。 */
	readonly id: string;
	readonly name: string;
	readonly transport: McpTransport;
	readonly status: "disabled" | "connecting" | "connected" | "error";
	readonly toolCount: number;
	readonly updatedAt: string;
}

/** MCP Server 详情：元数据 + tools + 引用它的 Agent + 最近测试结果。 */
export interface McpServerDetail extends McpServerSummary {
	readonly tools: readonly McpToolRef[];
	readonly boundAgentIds: readonly AgentPublicId[];
	readonly lastTest: {
		readonly ok: boolean;
		readonly latencyMs: number | null;
		readonly at: string;
	} | null;
}

/** `POST /api/control/v1/mcp-servers`（创建/更新）。 */
export interface McpServerUpsertRequest {
	readonly name: string;
	readonly transport: McpTransport;
	/**
	 * transport 配置。仅允许保存引用/端点描述，**不得**含明文 Secret；
	 * Secret 以引用（读取后仅返回 `secretConfigured: boolean`）形式保存。
	 */
	readonly config: Readonly<Record<string, unknown>>;
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

/** Agent Revision → MCP 绑定（固定 MCP Server + Tool 白名单）。 */
export interface AgentMcpBinding {
	readonly agentId: AgentPublicId;
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
} as const;
