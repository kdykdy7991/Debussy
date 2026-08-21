import { memo, useEffect, useRef, useState } from "react";
import geometryDataUrl from "../../../../../../design/references/grok-icon-study/replica/geometry-data.js?url";
import idleAvatarUrl from "../../../../../../design/references/grok-icon-study/replica/grok-blob-idle.svg?url";
import characterUrl from "../../../../../../design/references/grok-icon-study/replica/src/character.js?url";
import eyesUrl from "../../../../../../design/references/grok-icon-study/replica/src/eyes.js?url";
import fxUrl from "../../../../../../design/references/grok-icon-study/replica/src/fx.js?url";
import mathUrl from "../../../../../../design/references/grok-icon-study/replica/src/math.js?url";
import poseUrl from "../../../../../../design/references/grok-icon-study/replica/src/pose.js?url";
import tablesUrl from "../../../../../../design/references/grok-icon-study/replica/src/tables.js?url";
import tricksUrl from "../../../../../../design/references/grok-icon-study/replica/src/tricks.js?url";

export type AgentAvatarState =
	| "idle"
	| "waking"
	| "playful"
	| "loading"
	| "thinking"
	| "searching"
	| "working"
	| "reading"
	| "writing"
	| "waiting"
	| "completed"
	| "failed";

const stateLabels: Record<AgentAvatarState, string> = {
	idle: "Agent 已就绪",
	waking: "Agent 正在进入会话",
	playful: "Agent 收到了积极反馈",
	loading: "Agent 正在启动",
	thinking: "Agent 正在思考",
	searching: "Agent 正在检索",
	working: "Agent 正在执行任务",
	reading: "Agent 正在读取结果",
	writing: "Agent 正在撰写回答",
	waiting: "Agent 正在等待确认",
	completed: "Agent 已完成运行",
	failed: "Agent 运行失败",
};

type GrokCharacterInstance = { setState: (state: string) => void; destroy: () => void };
type GrokCharacterConstructor = new (
	svg: SVGSVGElement,
	options: {
		state: string;
		sizePx: number;
		mode: "hold";
		loginWrap: boolean;
		followPointer: boolean;
		followPointerBody: boolean;
		followPointerStrength: number;
	},
) => GrokCharacterInstance;

declare global {
	interface Window {
		GrokCharacter?: GrokCharacterConstructor;
	}
}

const sourceState: Record<Exclude<AgentAvatarState, "failed">, string> = {
	idle: "idle",
	waking: "waking",
	playful: "playful",
	loading: "loading",
	thinking: "notifying",
	searching: "loading",
	working: "loading",
	reading: "loading",
	writing: "writing",
	waiting: "dragging",
	completed: "spawning",
};

const idleSourceStates = [
	"sleeping",
	"idle",
	"suspicious",
	"drowsy",
	"curious",
	"confused",
	"bored",
	"shy",
	"sad",
	"laughing",
	"scared",
] as const;

function pickIdleSourceState(current: string | undefined): string {
	const candidates = idleSourceStates.filter((candidate) => candidate !== current);
	return candidates[Math.floor(Math.random() * candidates.length)] ?? "idle";
}

let studyScripts: Promise<void> | undefined;

function loadStudyScripts(): Promise<void> {
	if (typeof window === "undefined" || window.GrokCharacter) return Promise.resolve();
	if (studyScripts) return studyScripts;
	studyScripts = [geometryDataUrl, mathUrl, tablesUrl, poseUrl, tricksUrl, fxUrl, eyesUrl, characterUrl].reduce(
		(chain, source) => chain.then(() => loadScript(source)),
		Promise.resolve(),
	);
	return studyScripts;
}

/** Chat 页面进入时预热角色引擎，避免首条短回答在资源加载前结束。 */
export function preloadAgentStatusAvatar(): Promise<void> {
	return loadStudyScripts();
}

function loadScript(source: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = source;
		script.async = false;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error(`无法加载 Agent 形象资源：${source}`));
		document.head.append(script);
	});
}

/** 对话流专用的微型 Agent 状态标记；失败终态退化为红色圆点。 */
export const AgentStatusAvatar = memo(function AgentStatusAvatar({ state }: { state: AgentAvatarState }) {
	const svgRef = useRef<SVGSVGElement>(null);
	const characterRef = useRef<GrokCharacterInstance | undefined>(undefined);
	const appliedStateRef = useRef<string | undefined>(undefined);
	const lastActiveStateRef = useRef("thinking");
	const [engineReady, setEngineReady] = useState(false);
	const [showExitAvatar, setShowExitAvatar] = useState(false);
	const terminal = state === "failed";

	useEffect(() => {
		if (terminal) {
			if (!characterRef.current) return;
			characterRef.current.setState(lastActiveStateRef.current);
			const timer = window.setTimeout(() => {
				characterRef.current?.destroy();
				characterRef.current = undefined;
				appliedStateRef.current = undefined;
				setEngineReady(false);
				setShowExitAvatar(false);
			}, 1200);
			return () => window.clearTimeout(timer);
		}

		setShowExitAvatar(true);
		let disposed = false;
		let idleTimer: number | undefined;
		const stateName = state === "idle" ? pickIdleSourceState(appliedStateRef.current) : sourceState[state];
		lastActiveStateRef.current = stateName;
		void loadStudyScripts()
			.then(() => {
				if (disposed || !svgRef.current || !window.GrokCharacter) return;
				if (!characterRef.current) {
					characterRef.current = new window.GrokCharacter(svgRef.current, {
						state: stateName,
						sizePx: 64,
						mode: "hold",
						loginWrap: true,
						followPointer: true,
						followPointerBody: true,
						followPointerStrength: 2.4,
					});
					appliedStateRef.current = stateName;
					setEngineReady(true);
				} else if (appliedStateRef.current !== stateName) {
					characterRef.current.setState(stateName);
					appliedStateRef.current = stateName;
				}
				if (state === "idle") {
					const scheduleNextIdleState = () => {
						idleTimer = window.setTimeout(
							() => {
								if (disposed || !characterRef.current) return;
								const nextState = pickIdleSourceState(appliedStateRef.current);
								characterRef.current.setState(nextState);
								appliedStateRef.current = nextState;
								lastActiveStateRef.current = nextState;
								scheduleNextIdleState();
							},
							4000 + Math.random() * 4000,
						);
					};
					scheduleNextIdleState();
				}
			})
			.catch(() => {
				// 资源加载失败时保持签名行可用；状态文本仍会正常显示。
			});
		return () => {
			disposed = true;
			if (idleTimer !== undefined) window.clearTimeout(idleTimer);
		};
	}, [state, terminal]);

	useEffect(
		() => () => {
			characterRef.current?.destroy();
			characterRef.current = undefined;
			appliedStateRef.current = undefined;
		},
		[],
	);

	if (terminal && !showExitAvatar) {
		return <span className={`ai-agent-terminal is-${state}`} aria-label={stateLabels[state]} role="img" />;
	}

	return (
		<span
			className={`ai-agent-avatar is-${terminal ? lastActiveStateRef.current : state}`}
			aria-label={stateLabels[state]}
			role="img"
		>
			{!engineReady ? <img className="ai-agent-avatar-placeholder" src={idleAvatarUrl} alt="" /> : null}
			<svg ref={svgRef} viewBox="-15 -15 259 259" aria-hidden="true" focusable="false" />
		</span>
	);
});
