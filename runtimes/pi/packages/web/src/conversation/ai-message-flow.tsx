/**
 * 忠实复刻 design/ AI UI kit 的「会话流」：turn = UserMessage + AssistantResponse
 * （reading canvas，无气泡）+ 右侧 250px AgentTrace rail（工具调用）+ MessageActions。
 *
 * 真实 transcript（user / assistant / tool item）被聚合成 turn 驱动上述组件，
 * 样式来自 ai-kit/styles（--ai-* token + ai.css）。
 */
import type {
	AssistantTranscriptItem,
	SessionSnapshot,
	ToolTranscriptItem,
	TranscriptItem,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { type ComponentPropsWithoutRef, useEffect, useMemo } from "react";
import { Streamdown } from "streamdown";
import "katex/dist/katex.min.css";
import {
	AgentTrace,
	AgentTraceEvent,
	AgentStatusAvatar,
	type AgentAvatarState,
	preloadAgentStatusAvatar,
	AssistantResponse,
	Prose,
	StreamCursor,
	UserMessage,
} from "../ai-kit/index.ts";
import { LiveStatusRow } from "../features/voice/live-status-row.tsx";
import type { LivePlaybackState } from "../features/voice/live-types.ts";
import type { PlaybackArbiter } from "../features/voice/playback-arbiter.ts";
import { SpeechButton } from "../features/voice/speech-button.tsx";
import type { SpeechController } from "../features/voice/speech-controller.ts";
import { wrapSpeechButtonApi } from "./speech-wrap.ts";

const markdownPlugins = {
	code,
	cjk,
	math: createMathPlugin({ singleDollarTextMath: true }),
	mermaid,
};

const markdownTranslations = {
	copyCode: "复制代码",
	downloadFile: "下载文件",
	copyTable: "复制表格",
	copyTableAsMarkdown: "复制为 Markdown",
	copyTableAsCsv: "复制为 CSV",
	copyTableAsTsv: "复制为 TSV",
	downloadTable: "下载表格",
	downloadDiagram: "下载图表",
	downloadDiagramAsMmd: "下载 Mermaid 源码",
	downloadDiagramAsPng: "下载 PNG",
	downloadDiagramAsSvg: "下载 SVG",
	viewFullscreen: "全屏查看",
	exitFullscreen: "退出全屏",
	openLink: "打开链接",
};

function MarkdownLink({ node: _node, ...props }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
	return <a {...props} target="_blank" rel="noreferrer" />;
}

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
			{units.length === 0 ? (
				<section className="empty-transcript">
					<span>READY FOR BRIEF</span>
					<h2>这个会话还没有内容</h2>
					<p>在下方输入你的问题。回答会以适合长文阅读的分析稿形式呈现。</p>
				</section>
			) : (
				units.map((unit, index) => (
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
			)}
		</div>
	);
}

/**
 * 当前任务的唯一状态形象。它由工作区固定在左下角，不会随某一条回复向上滚走。
 */
export function ActiveAgentPresence({ active }: { active: SessionSnapshot }): React.ReactElement | null {
	if (active.phase === "idle") return null;
	const currentTurn = [...groupTurns(active.transcript)].reverse().find((unit) => unit.assistant !== undefined);
	const assistant = currentTurn?.assistant;
	const state = resolveAgentState({
		streaming: assistant?.status === "streaming",
		textBlocks: assistant?.content.filter((content) => content.type === "text").length ?? 0,
		thinking: assistant?.content.some((content) => content.type === "thinking") ?? false,
		tools: currentTurn?.tools ?? [],
	});
	return (
		<div className="active-agent-presence">
			<AgentStatusAvatar state={state} />
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
						payload={toolPayload(tool)}
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
					tools={tools}
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

function AssistantTurn({
	item,
	rail,
	tools,
	speech,
	arbiter,
	sessionId,
	liveState,
	onStopLive,
}: {
	item: AssistantTranscriptItem;
	rail: React.ReactNode;
	tools: readonly ToolTranscriptItem[];
	speech: SpeechController | undefined;
	arbiter: PlaybackArbiter | undefined;
	sessionId: string;
	liveState: LivePlaybackState;
	onStopLive: () => void;
}): React.ReactElement {
	const streaming = item.status === "streaming";
	const textBlocks = item.content.filter((content) => content.type === "text");
	const thinkingBlock = item.content.find((content) => content.type === "thinking");
	const plain = textBlocks.length <= 1 && textBlocks.join("").length <= 120 && thinkingBlock === undefined;
	return (
		<AssistantResponse rail={rail}>
			<div className="assistant-output-card">
				{!streaming ? (
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

					{streaming ? <StreamCursor /> : null}
				</div>

				<div className="ai-turn-extras">
					{liveState !== "idle" ? <LiveStatusRow state={liveState} onStop={onStopLive} /> : null}
					{speech?.voiceAvailable && !streaming ? (
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
	if (!streaming) return "completed";
	const runningTool = tools.find((tool) => tool.status === "running");
	if (runningTool) return isSearchTool(runningTool) ? "searching" : "working";
	if (tools.length > 0 && textBlocks === 0) return "reading";
	if (textBlocks > 0) return "writing";
	if (thinking) return "thinking";
	return "loading";
}

function isSearchTool(tool: ToolTranscriptItem): boolean {
	return /search|find|browse|web|检索|搜索/i.test(tool.toolName ?? "");
}

function MarkdownText({ text, streaming }: { text: string; streaming: boolean }): React.ReactElement {
	return (
		<div className="ai-prose-block">
			<Streamdown
				className="ai-markdown"
				mode={streaming ? "streaming" : "static"}
				isAnimating={streaming}
				animated
				skipHtml
				plugins={markdownPlugins}
				components={{ a: MarkdownLink }}
				controls={false}
				linkSafety={{ enabled: false }}
				translations={markdownTranslations}
			>
				{text}
			</Streamdown>
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

function toolPayload(tool: ToolTranscriptItem): string | undefined {
	try {
		const input = tool.input as unknown;
		if (input === undefined || input === null) return undefined;
		return JSON.stringify(input, null, 2);
	} catch {
		return undefined;
	}
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
