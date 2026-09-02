/**
 * 忠实复刻 design/ AI UI kit 的「会话流」：turn = UserMessage + AssistantResponse
 * （reading canvas，无气泡）+ 右侧 250px AgentTrace rail（工具调用）+ MessageActions。
 *
 * 真实 transcript（user / assistant / tool item）被聚合成 turn 驱动上述组件，
 * 样式来自 ai-kit/styles（--ai-* token + ai.css）。
 *
 * Markdown 渲染：FlowToken `<AnimatedMarkdown>`（基于 react-markdown）。
 * LLM 流式字符级淡入由 FlowToken 内部 `sep="diff"` + `animation="fadeIn"` 承担：
 * 累计全文本追踪（无 newIndex 重置），新增 token 整体淡入，无段间并行问题。
 * 已知差异：丢 katex、丢 mermaid、丢 cjk 智能分词（按字符切）、丢 streamdown 软入场
 * CSS 变量系统（`--sd-animation/duration/easing/delay`）。
 */
import type {
	AssistantTranscriptItem,
	Citation,
	SessionSnapshot,
	ToolTranscriptItem,
	TranscriptItem,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import { AnimatedMarkdown } from "flowtoken";
import "flowtoken/dist/styles.css";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
	type AgentAvatarState,
	AgentStatusAvatar,
	AgentTrace,
	AgentTraceEvent,
	AssistantResponse,
	Prose,
	preloadAgentStatusAvatar,
	UserMessage,
} from "../ai-kit/index.ts";
import { cx } from "../ai-kit/lib/utils.ts";
import { LiveStatusRow } from "../features/voice/live-status-row.tsx";
import type { LivePlaybackState } from "../features/voice/live-types.ts";
import type { PlaybackArbiter } from "../features/voice/playback-arbiter.ts";
import { SpeechButton } from "../features/voice/speech-button.tsx";
import type { SpeechController } from "../features/voice/speech-controller.ts";
import type { AgentReaction } from "./agent-reaction.ts";
import { wrapSpeechButtonApi } from "./speech-wrap.ts";

const SHOW_AGENT_STATE_DEBUG = true;

const MARKDOWN_COMPONENTS = {
	table: ({ children }: { readonly children?: ReactNode }) => (
		<div className="ai-markdown-table">
			<table>{children}</table>
		</div>
	),
};

interface TurnUnit {
	user: UserTranscriptItem | undefined;
	assistant: AssistantTranscriptItem | undefined;
	tools: ToolTranscriptItem[];
}

/** 把每条 user / assistant 视为一个 turn 起点，后继 tool 挂到当前 turn。 */
function groupTurns(transcript: readonly TranscriptItem[]): TurnUnit[] {
	const units: TurnUnit[] = [];
	let current: TurnUnit | undefined;
	for (const item of transcript) {
		if (item.role === "user") {
			if (current !== undefined) units.push(current);
			current = { user: item, assistant: undefined, tools: [] };
		} else if (item.role === "assistant") {
			if (current === undefined) current = { user: undefined, assistant: undefined, tools: [] };
			current.assistant = item;
		} else {
			if (current === undefined) current = { user: undefined, assistant: undefined, tools: [] };
			current.tools.push(item);
		}
	}
	if (current !== undefined) units.push(current);
	return units;
}

/**
 * A settled session whose last user Turn has no assistant item is not loading:
 * the provider failed before producing its first assistant event (timeout,
 * disconnect, or early rejection). This state survives transcript reloads.
 */
export function hasTerminalOrphanedTurn(active: SessionSnapshot): boolean {
	const currentTurn = groupTurns(active.transcript).at(-1);
	return active.phase === "idle" && currentTurn?.user !== undefined && currentTurn.assistant === undefined;
}

export function AiMessageFlow({
	active,
	speech,
	arbiter,
	livePlaybackState,
	onStopLive,
}: {
	active: SessionSnapshot;
	speech: SpeechController | undefined;
	arbiter: PlaybackArbiter | undefined;
	livePlaybackState: LivePlaybackState;
	onStopLive: () => void;
}): React.ReactElement {
	const units = useMemo(() => groupTurns(active.transcript), [active.transcript]);
	const liveActive = livePlaybackState !== "idle" && livePlaybackState !== "ended";

	useEffect(() => {
		void preloadAgentStatusAvatar();
	}, []);

	return (
		<div className="ai-flow">
			{units.length > 0
				? units.map((unit, index) => (
						<TurnView
							key={unit.assistant?.id ?? unit.user?.id ?? `turn-${index}`}
							unit={unit}
							sessionId={active.id}
							liveActive={liveActive}
							speech={speech}
							arbiter={arbiter}
							livePlaybackState={livePlaybackState}
							onStopLive={onStopLive}
						/>
					))
				: null}
		</div>
	);
}

/**
 * 当前任务的唯一状态形象。它由工作区固定在左下角，不会随某一条回复向上滚走。
 */
export function ActiveAgentPresence({
	active,
	composerFocused,
	reaction,
}: {
	active: SessionSnapshot;
	composerFocused: boolean;
	reaction: AgentReaction | undefined;
}): React.ReactElement | null {
	const [waking, setWaking] = useState(true);
	const [showCompleted, setShowCompleted] = useState(false);
	const [showCompactionLabel, setShowCompactionLabel] = useState(false);
	const turns = groupTurns(active.transcript);
	const currentTurn = turns.at(-1);
	const assistant = currentTurn?.assistant;
	const previousAssistantRef = useRef(assistant);
	useEffect(() => {
		const timer = window.setTimeout(() => setWaking(false), 800);
		return () => window.clearTimeout(timer);
	}, []);
	const previousAssistant = previousAssistantRef.current;
	const completedThisRender =
		previousAssistant !== undefined &&
		assistant !== undefined &&
		previousAssistant?.id === assistant?.id &&
		previousAssistant.status === "streaming" &&
		assistant.status === "complete" &&
		assistant.stopReason !== "toolUse";
	useEffect(() => {
		previousAssistantRef.current = assistant;
		if (completedThisRender) setShowCompleted(true);
	}, [assistant, completedThisRender]);
	useEffect(() => {
		if (!showCompleted) return undefined;
		const timer = window.setTimeout(() => setShowCompleted(false), 1000);
		return () => window.clearTimeout(timer);
	}, [showCompleted]);
	useEffect(() => {
		if (active.phase !== "compaction") {
			setShowCompactionLabel(false);
			return undefined;
		}
		const timer = window.setTimeout(() => setShowCompactionLabel(true), 180);
		return () => window.clearTimeout(timer);
	}, [active.phase]);
	const terminalOrphanedTurn = hasTerminalOrphanedTurn(active);
	const waitingForAssistant = active.phase !== "idle" && currentTurn?.user !== undefined && assistant === undefined;
	const lastAssistantFailed = assistant?.status === "error" || assistant?.status === "aborted" || terminalOrphanedTurn;
	const state = waking
		? "waking"
		: active.phase === "compaction"
			? "compacting"
			: reaction
				? reaction
				: waitingForAssistant
					? "loading"
					: lastAssistantFailed
						? "failed"
						: showCompleted || completedThisRender
							? "completed"
							: active.phase === "idle"
								? composerFocused
									? "waiting"
									: "idle"
								: resolveAgentState({
										streaming: assistant?.status === "streaming",
										textBlocks: assistant?.content.filter((content) => content.type === "text").length ?? 0,
										thinking: assistant?.content.some((content) => content.type === "thinking") ?? false,
										tools: currentTurn?.tools ?? [],
									});
	return (
		<div className="active-agent-presence">
			<AgentStatusAvatar state={state} />
			{showCompactionLabel ? <span className="active-agent-compaction">正在整理较早的对话…</span> : null}
			{SHOW_AGENT_STATE_DEBUG ? <code className="active-agent-presence-state">UI: {state}</code> : null}
		</div>
	);
}

function TurnView({
	unit,
	sessionId,
	liveActive,
	speech,
	arbiter,
	livePlaybackState,
	onStopLive,
}: {
	unit: TurnUnit;
	sessionId: string;
	liveActive: boolean;
	speech: SpeechController | undefined;
	arbiter: PlaybackArbiter | undefined;
	livePlaybackState: LivePlaybackState;
	onStopLive: () => void;
}): React.ReactElement {
	const tools = unit.tools;
	const rail =
		tools.length > 0 ? (
			<AgentTrace status={tools.some((t) => t.status === "running") ? "running" : "completed"}>
				{tools.map((tool, i) => (
					<AgentTraceEvent
						key={tool.id ?? `tool-${i}`}
						status={tool.status === "running" ? "running" : tool.status === "error" ? "failed" : "completed"}
						title={tool.toolName ?? "工具"}
						detail={toolDetail(tool)}
					/>
				))}
			</AgentTrace>
		) : undefined;

	const speakingTargetId = unit.assistant?.id;
	const liveState: LivePlaybackState = liveActive && speakingTargetId !== undefined ? livePlaybackState : "idle";

	return (
		<>
			{unit.user ? <UserBrief item={unit.user} /> : null}
			{unit.assistant ? (
				<AssistantTurn
					item={unit.assistant}
					rail={rail}
					speech={speech}
					arbiter={arbiter}
					sessionId={sessionId}
					liveState={liveState}
					onStopLive={onStopLive}
				/>
			) : null}
		</>
	);
}

function UserBrief({ item }: { item: UserTranscriptItem }): React.ReactElement {
	const text = item.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
	const plain = text.length <= 24 && !text.includes("\n");
	return (
		<UserMessage variant={plain ? "plain" : "default"} attachments={userAttachments(item)}>
			{text || "（图片附件）"}
		</UserMessage>
	);
}

/** Pure presentation of one retrieved Source fragment used by an assistant Turn. */
function CitationBlock({ citation }: { citation: Citation }): React.ReactElement {
	return (
		<li className="ai-turn-citation">
			<span className="ai-turn-citation-title">{citation.title}</span>
			<p className="ai-turn-citation-excerpt">{citation.excerpt}</p>
		</li>
	);
}

function AssistantTurn({
	item,
	rail,
	speech,
	arbiter,
	sessionId,
	liveState,
	onStopLive,
}: {
	item: AssistantTranscriptItem;
	rail: React.ReactNode;
	speech: SpeechController | undefined;
	arbiter: PlaybackArbiter | undefined;
	sessionId: string;
	liveState: LivePlaybackState;
	onStopLive: () => void;
}): React.ReactElement {
	const streaming = item.status === "streaming";
	const errored = item.status === "error";
	const aborted = item.status === "aborted";
	const completed = item.status === "complete";
	const textBlocks = item.content.filter((content) => content.type === "text");
	const thinkingBlock = item.content.find((content) => content.type === "thinking");
	const hasCopyableText = textBlocks.some((block) => block.text.trim().length > 0);
	const plain = textBlocks.length <= 1 && textBlocks.join("").length <= 120 && thinkingBlock === undefined;
	const cardClass = cx("assistant-output-card", errored && "is-error", aborted && "is-aborted");
	return (
		<AssistantResponse rail={rail}>
			<div className={cardClass}>
				{!streaming && hasCopyableText ? (
					<button
						className="assistant-output-copy"
						type="button"
						onClick={() => void copyText(item)}
						aria-label="复制本条回答正文，不含思考过程和工具调用"
						title="复制本条回答正文"
					>
						<svg viewBox="0 0 16 16" fill="none" focusable="false" aria-hidden="true">
							<title>复制本条回答正文</title>
							<rect x="5.25" y="5.25" width="7.5" height="7.5" rx="1" stroke="currentColor" strokeWidth="1.25" />
							<path
								d="M10.75 5.25v-1a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h1"
								stroke="currentColor"
								strokeWidth="1.25"
								strokeLinecap="round"
							/>
						</svg>
					</button>
				) : null}
				{thinkingBlock ? (
					<details className="thinking-note ai-thinking">
						<summary>
							<span className="work-chevron" aria-hidden="true">
								&gt;
							</span>
							<span>思考过程</span>
						</summary>
						<div className="thinking-body">
							{thinkingBlock.redacted ? "推理内容已隐藏" : thinkingBlock.thinking}
						</div>
					</details>
				) : null}

				<div className="ai-reading-content">
					{textBlocks.length > 0 ? (
						<Prose plain={plain} streaming={streaming}>
							{textBlocks.map((block, i) => (
								<MarkdownText key={`${item.id}-${i}`} text={block.text} streaming={streaming} />
							))}
						</Prose>
					) : null}
				</div>

				{item.citations && item.citations.length > 0 ? (
					<div className="ai-turn-citations">
						<span className="ai-turn-citations-label">引用</span>
						<ul className="ai-turn-citations-list">
							{item.citations.map((citation) => (
								<CitationBlock key={citation.sourceId} citation={citation} />
							))}
						</ul>
					</div>
				) : null}

				{errored || aborted ? (
					<div
						className={`ai-turn-failure ${errored ? "is-error" : "is-aborted"}`}
						role={errored ? "alert" : "status"}
					>
						<span className="ai-turn-failure-label">{errored ? "本次响应未完成" : "本次响应已中止"}</span>
						<p className="ai-turn-failure-message">
							{(item.errorMessage ?? "").trim() || (errored ? "模型调用失败，请稍后重试。" : "响应被中止。")}
						</p>
					</div>
				) : null}

				<div className="ai-turn-extras">
					{liveState !== "idle" ? <LiveStatusRow state={liveState} onStop={onStopLive} /> : null}
					{speech?.voiceAvailable && completed && hasCopyableText ? (
						<SpeechButton
							speech={speech && arbiter ? wrapSpeechButtonApi(speech, arbiter) : speech}
							sessionId={sessionId}
							messageId={item.id}
						/>
					) : null}
				</div>
			</div>
		</AssistantResponse>
	);
}

function resolveAgentState({
	streaming,
	textBlocks,
	thinking,
	tools,
}: {
	streaming: boolean;
	textBlocks: number;
	thinking: boolean;
	tools: readonly ToolTranscriptItem[];
}): AgentAvatarState {
	const runningTool = tools.find((tool) => tool.status === "running");
	if (runningTool) return isSearchTool(runningTool) ? "searching" : "working";
	if (!streaming && tools.length > 0) return "reading";
	if (streaming && textBlocks > 0) return "writing";
	if (thinking) return "thinking";
	return "loading";
}

function isSearchTool(tool: ToolTranscriptItem): boolean {
	return /search|find|browse|web|检索|搜索/i.test(tool.toolName ?? "");
}

/**
 * 用 FlowToken `<AnimatedMarkdown>` 渲染一段 LLM 流式回复。sep="diff" 按累计
 * 文本差量切 token（用内部 ref 跟踪 totalText，无 streamdown 那种 newIndex 重置
 * 问题），新增 token 整体同时淡入，无段间并行。完成消息传 animation={null} 关闭
 * 动画降低重渲染成本。
 */
export function MarkdownText({ text, streaming }: { text: string; streaming: boolean }): React.ReactElement {
	return (
		<div className="ai-prose-block ai-markdown">
			<AnimatedMarkdown
				content={text}
				sep="diff"
				animation={streaming ? "slideUp" : null}
				animationDuration="0.6s"
				animationTimingFunction="ease-in-out"
				customComponents={MARKDOWN_COMPONENTS}
			/>
		</div>
	);
}

function userAttachments(item: UserTranscriptItem): string[] | undefined {
	const names = item.content.filter((content) => content.type !== "text").map(() => "附件");
	return names.length > 0 ? names : undefined;
}

function toolDetail(tool: ToolTranscriptItem): string | undefined {
	const status = tool.status === "running" ? "执行中" : tool.status === "error" ? "失败" : "完成";
	return status;
}

async function copyText(item: TranscriptItem): Promise<void> {
	const text = item.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		// clipboard unavailable; ignore.
	}
}
