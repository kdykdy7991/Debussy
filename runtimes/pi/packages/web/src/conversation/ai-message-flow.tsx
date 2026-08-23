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
import {
	type ComponentPropsWithoutRef,
	createContext,
	memo,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type AnimateOptions, Block, type BlockProps, Streamdown } from "streamdown";
import "katex/dist/katex.min.css";
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
import { LiveStatusRow } from "../features/voice/live-status-row.tsx";
import type { LivePlaybackState } from "../features/voice/live-types.ts";
import type { PlaybackArbiter } from "../features/voice/playback-arbiter.ts";
import { SpeechButton } from "../features/voice/speech-button.tsx";
import type { SpeechController } from "../features/voice/speech-controller.ts";
import type { AgentReaction } from "./agent-reaction.ts";
import type { RevealClock, RevealTiming, SerialRevealPlan } from "./serial-reveal.ts";
import { computeSerialRevealPlan } from "./serial-reveal.ts";
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

const SHOW_AGENT_STATE_DEBUG = false;

/** softReveal 字符级显影参数（Streamdown animated 选项与串行调度共用同一来源）。 */
export const SOFT_REVEAL = { duration: 240, stagger: 40 } as const;

export const softRevealOptions: AnimateOptions = {
	animation: "softReveal",
	easing: "ease-out",
	sep: "char",
	...SOFT_REVEAL,
};

const softRevealTiming: RevealTiming = { ...SOFT_REVEAL };

/** 稳定引用，保证 Streamdown memo 生效（避免每帧重渲染整个 markdown 树）。 */
const disabledLinkSafety = { enabled: false };

/** 当前 MarkdownText（一个 text part）的串行显影计划，供各 block wrapper 读取。 */
export const SerialRevealContext = createContext<SerialRevealPlan | null>(null);

function MarkdownLink({ node: _node, ...props }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
	return <a {...props} target="_blank" rel="noreferrer" />;
}

const markdownComponents = { a: MarkdownLink };

// SSR（renderToStaticMarkup）下不使用 layout effect，避免 server 告警。
const useRevealLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Streamdown keeps each parsed Markdown block keyed by index; completed siblings stay mounted.
 *
 * 串行显影：
 * 1. block 内容变化的那次提交里，插件生成的「新 span」（--sd-duration > 0）在 paint
 *    前被叠加本 block 的串行偏移；已显影的旧 span（duration 0）保持 delay 0，不受
 *    偏移影响（fill both 下给 duration 0 的 span 加 delay 会闪隐）。
 * 2. 挂载提交（plan.mount）时包装 animatePlugin，把 take 的 prevContentLength 强制为
 *    0：插件在 block 间共享计数，标题等与后文之间没有分隔块时，上一块的字符数会漏
 *    给下一块，导致该块开头若干字符被当作「旧内容」直接弹出而非参与串行淡入。
 */
export const StableMarkdownBlock = memo(function StableMarkdownBlock(props: BlockProps): React.ReactElement {
	const plan = useContext(SerialRevealContext);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const content = props.content;
	useRevealLayoutEffect(() => {
		const host = hostRef.current;
		if (host === null) return;
		const offset = plan?.offsets[props.index] ?? 0;
		if (offset <= 0) return;
		const spans = host.querySelectorAll<HTMLElement>("[data-sd-animate]");
		for (const span of spans) {
			if (span.dataset.sdSerialBase !== undefined) continue;
			const style = span.style;
			const duration = Number.parseFloat(style.getPropertyValue("--sd-duration")) || 0;
			if (duration <= 0) continue;
			const base = Number.parseFloat(style.getPropertyValue("--sd-delay")) || 0;
			span.dataset.sdSerialBase = String(base);
			// `streamdown/styles.css` 把 `animation: var(--sd-animation) ...
			// var(--sd-delay) ...` 写在 stylesheet 里，从 inline style 的 CSS
			// 变量读值。问题是：CSS animation 一旦启动就不响应 CSS 变量变化
			//（标准行为），改 --sd-delay 不会重启 animation。必须直接重设
			// inline style 的 `animation` shorthand，让浏览器重启 animation
			// 引擎并采用新 delay。layout effect 跑在 paint 前，所以重设不会
			// 引发视觉闪烁。
			const animationName = style.getPropertyValue("--sd-animation").trim() || "sd-fadeIn";
			const easing = style.getPropertyValue("--sd-easing").trim() || "ease";
			style.setProperty(
				"animation",
				`${animationName} ${duration}ms ${easing} ${base + offset}ms both`,
			);
		}
	}, [content, plan, props.index]);
	const animatePlugin = props.animatePlugin;
	const mountedAnimatePlugin = useMemo(() => {
		if (plan?.mount !== true || animatePlugin == null) return animatePlugin;
		return {
			...animatePlugin,
			getLastRenderCharCount: () => {
				animatePlugin.getLastRenderCharCount();
				return 0;
			},
		};
	}, [animatePlugin, plan]);
	return (
		<div ref={hostRef} className="ai-stream-markdown-block" data-stream-block={props.index}>
			<Block {...props} animatePlugin={mountedAnimatePlugin} />
		</div>
	);
});

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
		assistant.status === "complete";
	useEffect(() => {
		previousAssistantRef.current = assistant;
		if (completedThisRender) setShowCompleted(true);
	}, [assistant, completedThisRender]);
	useEffect(() => {
		if (!showCompleted) return undefined;
		const timer = window.setTimeout(() => setShowCompleted(false), 1000);
		return () => window.clearTimeout(timer);
	}, [showCompleted]);
	const waitingForAssistant = currentTurn?.user !== undefined && assistant === undefined;
	const state = waking
		? "waking"
		: reaction
			? reaction
			: waitingForAssistant
				? "loading"
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
	const textBlocks = item.content.filter((content) => content.type === "text");
	const thinkingBlock = item.content.find((content) => content.type === "thinking");
	const plain = textBlocks.length <= 1 && textBlocks.join("").length <= 120 && thinkingBlock === undefined;
	// 同一条消息的所有 text part 共享显影时钟：后一段 part 须等前一段全部显影完成。
	const revealClock = useRef<RevealClock>({ freeAt: 0 });
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
								<MarkdownText
									key={`${item.id}-${i}`}
									text={block.text}
									streaming={streaming}
									clock={revealClock.current}
								/>
							))}
						</Prose>
					) : null}
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

function MarkdownText({
	text,
	streaming,
	clock,
}: {
	text: string;
	streaming: boolean;
	clock: RevealClock;
}): React.ReactElement {
	const streamed = useRef(streaming);
	if (streaming) streamed.current = true;
	const preserveStreamingDom = streamed.current;
	// 串行显影计划：仅在参与动画（流式）时计算；按 text 变化守卫，渲染期幂等。
	const planRef = useRef<SerialRevealPlan | null>(null);
	if (preserveStreamingDom && planRef.current?.text !== text) {
		planRef.current = computeSerialRevealPlan(text, planRef.current ?? undefined, clock, softRevealTiming);
	}
	const plan = planRef.current;
	return (
		<div className="ai-prose-block">
			<SerialRevealContext.Provider value={plan}>
				<Streamdown
					className="ai-markdown"
					mode={preserveStreamingDom ? "streaming" : "static"}
					isAnimating={preserveStreamingDom}
					animated={softRevealOptions}
					BlockComponent={StableMarkdownBlock}
					skipHtml
					plugins={markdownPlugins}
					components={markdownComponents}
					controls={false}
					linkSafety={disabledLinkSafety}
					translations={markdownTranslations}
				>
					{text}
				</Streamdown>
			</SerialRevealContext.Provider>
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
