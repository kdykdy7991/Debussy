/**
 * Agent 平台 V2 M1：`ContextUsageSnapshot` 估算器（写上下文快照）。
 *
 * 本服务当前不持有逐 token 的 tokenizer，故快照统一标记 `measurement: "estimated"`
 * （契约允许）。估算基于 `CHARS_PER_TOKEN = 4` 启发式（与 runtime `context-restore`
 * 的 `trimToBudget` 一致），`usedTokens` 恒等于 `breakdown` 各分类之和。
 *
 * 能拿到的分类才估算：systemPrompt / conversationMessages / toolDefinitions 取实际
 * 文本；skillInstructions / toolResults / retrievalContext / attachments 在 M1 无独立
 * 来源，如实写 0（不伪造）。`reservedOutputTokens` 无来源，M1 写 0。
 */
import type { ContextUsageSnapshot } from "@earendil-works/pi-protocol";

/** 与 runtime/context-restore 一致的字符→token 启发式。 */
export const CHARS_PER_TOKEN = 4 as const;

/** 输入：写入 `context/snapshot` 时该 turn 可见的上下文（保守估算来源）。 */
export interface ContextSnapshotEstimateInput {
	/** 会话级 context window（token），取自 `contextPolicy.maxContextTokens`。 */
	readonly contextWindow: number;
	readonly systemPromptText: string;
	readonly conversationMessagesText: string;
	/** 未提供则按 0 计。 */
	readonly toolDefinitionsText?: string;
}

function estimateTokens(text: string): number {
	if (text.length === 0) return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateContextSnapshot(input: ContextSnapshotEstimateInput): ContextUsageSnapshot {
	const systemPrompt = estimateTokens(input.systemPromptText);
	const conversationMessages = estimateTokens(input.conversationMessagesText);
	const toolDefinitions = estimateTokens(input.toolDefinitionsText ?? "");
	const breakdown = {
		systemPrompt,
		skillInstructions: 0,
		toolDefinitions,
		conversationMessages,
		toolResults: 0,
		retrievalContext: 0,
		attachments: 0,
	};
	const usedTokens = systemPrompt + conversationMessages + toolDefinitions;
	const reservedOutputTokens = 0;
	const contextWindow = Math.max(1, input.contextWindow);
	const remainingTokens = Math.max(0, contextWindow - usedTokens - reservedOutputTokens);
	const usagePercent = Number(((usedTokens / contextWindow) * 100).toFixed(2));
	return {
		usedTokens,
		contextWindow,
		remainingTokens,
		reservedOutputTokens,
		usagePercent,
		measurement: "estimated",
		breakdown,
	};
}
