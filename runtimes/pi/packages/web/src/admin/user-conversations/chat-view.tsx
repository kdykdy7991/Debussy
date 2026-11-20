/**
 * Session V1 — Chat view (default).
 *
 * One card per Turn, built exclusively from `conversation_events`. The task
 * input is shown once; ReAct internals are collapsed behind a one-line
 * summary; the final answer is derived from the real terminal event.
 */
import type {
	ConversationAdminDetailResponse,
	ConversationAdminEvent,
	ConversationAdminSummaryEntry,
} from "@earendil-works/pi-protocol";
import { EmptyState } from "../components/EmptyState.tsx";
import { buildChatTurns, type ChatFinalKind, INTERNAL_TRIGGER_MESSAGE } from "./session-view-helpers.ts";
import styles from "./session-views.module.css";

export interface ChatViewProps {
	readonly detail: ConversationAdminDetailResponse;
	readonly events: readonly ConversationAdminEvent[];
	readonly summaries: readonly ConversationAdminSummaryEntry[];
	readonly eventState: { readonly kind: "loading" | "loaded" | "error"; readonly message?: string };
	readonly hasMore: boolean;
	readonly loadingMore: boolean;
	readonly onLoadMore: () => void;
}

const FINAL_LABEL: Record<ChatFinalKind, string> = {
	text: "最终结果",
	completed_no_text: "执行完成",
	failed: "执行失败",
	interrupted: "已取消",
	in_progress: "进行中",
};

export function ChatView({
	detail,
	events,
	summaries,
	eventState,
	hasMore,
	loadingMore,
	onLoadMore,
}: ChatViewProps): React.ReactElement {
	const turns = buildChatTurns(events, detail, summaries);
	const latest = summaries.length > 0 ? summaries[0]! : null;
	return (
		<section className={styles.view} aria-label="对话视图">
			{latest !== null ? (
				<p className={styles.notice}>
					上下文压缩：已有 {summaries.length} 条摘要记录，最新压缩边界为事件序号 {latest.throughSequence}。
					这是执行事实，不影响下方历史聊天记录的完整展示。
				</p>
			) : null}
			{detail.taskInput !== null ? (
				<p className={styles.notice}>
					该 Run 采用动态 Prompt 契约（{detail.requestContract}）：业务任务位于 「外部任务」， 内部固定触发消息「
					{INTERNAL_TRIGGER_MESSAGE}」不作为用户输入展示；执行轨迹中仍可查看其原始角色。
				</p>
			) : null}
			{eventState.kind === "loading" ? (
				<EmptyState kind="loading" title="加载会话记录中…" description="按页读取 append-only 事件日志。" compact />
			) : null}
			{eventState.kind === "error" ? (
				<EmptyState kind="error" title="会话记录加载失败" description={eventState.message ?? ""} compact />
			) : null}
			{eventState.kind === "loaded" && turns.length === 0 ? (
				<EmptyState kind="empty" title="暂无会话记录" description="该会话还没有产生任何 Turn 事件。" compact />
			) : null}
			{turns.map((turn, index) => (
				<article className={styles.turnCard} key={turn.key}>
					<header className={styles.turnHeader}>
						<strong>第 {index + 1} 次执行</strong>
						<span>{turn.turnId ?? "—"}</span>
						<span>
							LLM 调用 {turn.llmCalls === null ? "未知" : turn.llmCalls} 次 · 工具 {turn.toolCalls} 次 · 失败{" "}
							{turn.toolErrors} 次
						</span>
						{turn.compacted ? <span className={styles.badge}>已压缩上下文</span> : null}
					</header>
					<div className={styles.block}>
						<h3>{turn.inputLabel}</h3>
						<pre className={styles.message}>{turn.inputText}</pre>
						{turn.triggerSuppressed ? (
							<p className={styles.hint}>内部固定触发消息已隐藏，未当作业务输入。</p>
						) : null}
					</div>
					<details className={styles.process}>
						<summary>
							执行过程（默认折叠）：LLM {turn.llmCalls === null ? "未知" : turn.llmCalls} 次 · 工具{" "}
							{turn.toolCalls} 次 · 失败重试 {turn.toolErrors} 次
						</summary>
						<div className={styles.processBody}>
							{turn.toolNames.length > 0 ? (
								<p>
									<strong>工具调用：</strong>
									{turn.toolNames.join("、")}
								</p>
							) : (
								<p className={styles.hint}>没有工具调用记录。</p>
							)}
							{turn.toolResults.map((result, resultIndex) => (
								<div className={styles.toolResult} key={`${turn.key}-tool-${resultIndex}`}>
									<strong>工具结果 {resultIndex + 1}</strong>
									<pre>{result}</pre>
								</div>
							))}
							{turn.thinking !== null ? (
								<div className={styles.toolResult}>
									<strong>Reasoning（可用时）</strong>
									<pre>{turn.thinking}</pre>
								</div>
							) : null}
							{turn.intermediateMessages.map((message, messageIndex) => (
								<div className={styles.toolResult} key={`${turn.key}-assistant-${messageIndex}`}>
									<strong>中间 Assistant 消息 {messageIndex + 1}</strong>
									<pre>{message}</pre>
								</div>
							))}
							<p className={styles.hint}>完整请求原文请切换到执行轨迹视图按需查看。</p>
						</div>
					</details>
					<div className={`${styles.block} ${styles.finalBlock}`}>
						<h3>{FINAL_LABEL[turn.finalKind]}</h3>
						<pre className={styles.message}>{turn.finalText}</pre>
						<p className={styles.hint}>依据真实终态事件判定 · 起始事件序号 {turn.sequence}</p>
					</div>
				</article>
			))}
			{hasMore ? (
				<button className={styles.loadMore} type="button" disabled={loadingMore} onClick={onLoadMore}>
					{loadingMore ? "加载中…" : "加载更多历史事件"}
				</button>
			) : null}
		</section>
	);
}
