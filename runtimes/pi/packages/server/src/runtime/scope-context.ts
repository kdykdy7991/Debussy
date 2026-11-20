/**
 * Scope 上下文（spec 10.2，TASK-017）。
 *
 * 所有 Runtime/Provider 解析函数必须显式接收足够的 Scope Context，禁止从
 * 全局「当前用户/当前会话」隐式读取。MVP 不实现通用 Scope 框架，这里只
 * 定义最小层级（Process -> Tenant -> 执行来源/配置版本 -> Principal ->
 * Conversation -> Turn），字段来自已授权的调用方（TASK-016 的
 * `EmbedAuthContext` + 会话/版本解析结果），Runtime 层只消费、不推导。
 */

import type { ReasoningEffort } from "@earendil-works/pi-protocol";
import type { McpExecutionSource } from "./execution-source.ts";
import type { SandboxExecution } from "./sandbox.ts";
import type {
	ConversationId,
	PrincipalId,
	PublishedAppId,
	RequestId,
	TenantId,
	TurnId,
} from "../publishing/domain/ids.ts";

/**
 * 一次执行 Runtime 所需的最小上下文（R010）。
 *
 * 与 {@link ScopeContext} 的区别只在于**不要求存在真实 Conversation**：
 * Router Operation 没有 Conversation，其内存会话标识是 operation id。
 * `sessionId` 是内存会话标识（Chat/AaaS 缺省为 conversationId，Router 为
 * operation id）；`conversationId` 只在执行确实归属某个 Conversation 时存在，
 * 任何把它当作数据库外键使用的代码都必须先判空。
 */
export interface RuntimeScope {
	/** A prepared local tool from a server-authorized execution policy. */
	readonly sandbox?: SandboxExecution;
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId | null;
	readonly executionSource?: {
		readonly kind: "chat" | "orchestration" | "legacy_orchestration";
		readonly ownerId: string;
		readonly versionId: string;
	};
	/** Technical Runtime version key: Chat UUID or namespaced orv_ key. Not a Chat foreign key. */
	readonly publishedAppVersionId: string;
	readonly principalId: PrincipalId;
	/** 旧编排入口的 Integration 标识（历史兼容字段）。 */
	readonly integrationId?: string;
	/** Verified host identity loaded by the server for this turn. */
	readonly trustedIdentity?: {
		readonly systemName: string;
		readonly displayName: string;
		readonly roles: readonly string[];
	};
	/** 内存会话标识：Chat/AaaS 缺省为 conversationId；Router Operation 使用 operation id。 */
	readonly sessionId?: string;
	/** 仅当执行归属真实 Conversation 时存在。 */
	readonly conversationId?: ConversationId;
	/**
	 * 本次执行的凭据来源（R010）。带来源的执行使用来源自带的密封凭据与安全
	 * 边界，不回退平台 MCP secret；没有来源的执行（旧 /runs、Integration、Chat）
	 * 沿用各自既有的凭据来源与格式。
	 */
	readonly credentialSource?: McpExecutionSource;
	/** Correlation id for the client request that started the current Turn. */
	readonly requestId?: RequestId;
	/** 当前正在执行的 Turn；TASK-018 起由 executeTurn 填充。 */
	readonly turnId?: TurnId;
	/**
	 * Agent V2 §4.3 会话级 reasoning effort 覆盖（来自
	 * `conversation_reasoning_state` 事实源）。null/缺省 = 无覆盖，采用
	 * Published App Version 里固化的 Agent Revision 参数。Runtime 在
	 * `resolveModelStreamOptions` 前叠加该覆盖（会话 > Revision > 默认）。
	 */
	readonly conversationEffort?: ReasoningEffort | null;
	/** 运行时配额提示（源自 RuntimeSpec.contextPolicy/runtimePolicy）。 */
	readonly limits: {
		readonly maxTurns: number;
		readonly maxContextTokens: number;
		readonly toolResultMaxBytes: number;
		readonly turnTimeoutMs: number;
		readonly maxConcurrentTurnsPerConversation: number;
	};
}

/** 一个 ConversationRuntime 执行期间可见的最小 Scope（10.2 层级）。 */
export interface ScopeContext extends RuntimeScope {
	readonly conversationId: ConversationId;
}
