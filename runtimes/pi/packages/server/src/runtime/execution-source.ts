/**
 * 一次执行的凭据来源适配器（R010 第二部分）。
 *
 * MCP 工具保护只通过本接口取凭据与归属：
 *
 * - 模型可见 Schema 的敏感参数过滤、连接凭据与工具参数凭据的隔离、发送前注入、
 *   MCP 返回检查与取消传播，都在共享工具工厂里实现；
 * - 「本次执行的凭据从哪来、调用前要不要复验、这次调用记到谁名下」由来源适配器
 *   回答，因此 Chat/AaaS 与 Router Operation 可以共用同一套保护实现。
 *
 * 边界规则：来源适配器提供的凭据是**本次执行专属**的密封凭据，缺失即失败；
 * 任何路径都不得回退平台 MCP secret（`ownsConnectionCredential` 为真时）。
 * 旧 /runs 与 Integration 没有安全边界（沿用平台 secret 与既有返回口径），
 * 由来源适配器显式表达，而不是由调用方各自实现。
 */
import type { ToolCredentialBinding } from "@earendil-works/pi-protocol";
import type {
	ConversationId,
	McpServerId,
	PublishedAppVersionId,
	RequestId,
	TenantId,
} from "../publishing/domain/ids.ts";

/** 一次执行的归属：Conversation（Chat/AaaS）或 Router Operation。 */
export type ExecutionOwner =
	| { readonly kind: "conversation"; readonly conversationId: string; readonly turnId?: string }
	| { readonly kind: "router_operation"; readonly operationId: string };

/** 一次 MCP 调用的审计事实（归属由来源适配器决定）。 */
export interface McpCallAuditRecord {
	readonly tenantId: TenantId;
	/** 旧归属（Conversation / 版本 / Integration）。Router 归属时全部为空。 */
	readonly conversationId: ConversationId | null;
	readonly publishedAppVersionId: PublishedAppVersionId | null;
	readonly integrationId: string | null;
	readonly orchestrationVersionId: string | null;
	/** Router 归属：Operation id（旧归属列必须为空）。 */
	readonly routerOperationId: string | null;
	readonly mcpServerId: McpServerId;
	readonly mcpRevision: number;
	readonly toolName: string;
	readonly outcome: "success" | "error" | "cancelled";
	readonly latencyMs: number;
	readonly resultBytes: number;
	readonly resultTruncated: boolean;
	readonly errorCode: string | null;
	readonly requestId: RequestId | null;
	readonly createdAt: Date;
}

/**
 * 本次执行自带的安全边界。只有带边界的执行才做调用前复验、自带连接凭据与
 * MCP 返回检查；旧 /runs 与 Integration 没有边界。
 */
export interface McpExecutionBoundary {
	/** 调用前复验：凭据有效期与执行授权；失败即拒绝外发。 */
	checkFresh(): Promise<void>;
	/**
	 * 本次执行自带的连接凭据。缺失即失败，**绝不回退平台 MCP secret**；
	 * `authentication === "none"` 返回 undefined（该 Server 不需要连接凭据）。
	 */
	connectionCredential(serverId: string, authentication: "none" | "bearer" | "api_key"): string | undefined;
	/** 全部已知秘密：只用于 MCP 返回检查，不外发、不进模型上下文。 */
	readonly secrets: readonly string[];
	/** Server 拒绝连接凭据：判定本次执行失败。 */
	authenticationFailed(): void;
	/** 连接层失败（鉴权状态未知）：判定本次执行失败，不误报为鉴权失败。 */
	connectionFailed(): void;
	/** 在 MCP 返回成为消息、引用或审计记录之前检查未脱敏的内容。 */
	inspect(content: unknown): void;
}

/** 一次执行的凭据来源。 */
export interface McpExecutionSource {
	/** 本次执行的归属（审计与致命守卫的键）。 */
	readonly owner: ExecutionOwner;
	/** 安全边界；缺省表示沿用旧入口口径（平台 secret、无返回检查）。 */
	readonly boundary?: McpExecutionBoundary;
	/** (Server, Tool) 的参数绑定：平台注入哪些参数、映射到哪个凭据。 */
	toolBindings(serverId: string, toolName: string): Promise<readonly ToolCredentialBinding[]>;
	/** (Server, Tool) 映射的参数凭据；只返回该次调用需要的值。 */
	toolCredentials(
		serverId: string,
		toolName: string,
		credentialNames: readonly string[],
	): Promise<Readonly<Record<string, string>>>;
	/** 致命边界命中（鉴权失败、返回不安全、凭据过期、连接失败）。 */
	markFatal(code: string): void;
	/** 审计归属：把这次 MCP 调用记录到本次执行的归属上。 */
	recordAudit(record: McpCallAuditRecord): Promise<void>;
}
