/**
 * Scope 上下文（spec 10.2，TASK-017）。
 *
 * 所有 Runtime/Provider 解析函数必须显式接收足够的 Scope Context，禁止从
 * 全局「当前用户/当前会话」隐式读取。MVP 不实现通用 Scope 框架，这里只
 * 定义最小层级（Process -> Tenant -> PublishedAppVersion -> Principal ->
 * Conversation -> Turn），字段来自已授权的调用方（TASK-016 的
 * `EmbedAuthContext` + 会话/版本解析结果），Runtime 层只消费、不推导。
 */

import type { ReasoningEffort } from "@earendil-works/pi-protocol";
import type {
	ConversationId,
	PrincipalId,
	PublishedAppId,
	PublishedAppVersionId,
	TenantId,
	TurnId,
} from "../publishing/domain/ids.ts";

/** 一个 ConversationRuntime 执行期间可见的最小 Scope（10.2 层级）。 */
export interface ScopeContext {
	readonly tenantId: TenantId;
	readonly publishedAppId: PublishedAppId;
	readonly publishedAppVersionId: PublishedAppVersionId;
	readonly principalId: PrincipalId;
	readonly conversationId: ConversationId;
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
