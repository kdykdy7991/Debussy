import { useEffect, useRef, useState } from "react";
import characterUrl from "../../../../../../design/references/grok-icon-study/replica/src/character.js?url";
import eyesUrl from "../../../../../../design/references/grok-icon-study/replica/src/eyes.js?url";
import fxUrl from "../../../../../../design/references/grok-icon-study/replica/src/fx.js?url";
import geometryDataUrl from "../../../../../../design/references/grok-icon-study/replica/geometry-data.js?url";
import mathUrl from "../../../../../../design/references/grok-icon-study/replica/src/math.js?url";
import poseUrl from "../../../../../../design/references/grok-icon-study/replica/src/pose.js?url";
import tablesUrl from "../../../../../../design/references/grok-icon-study/replica/src/tables.js?url";
import tricksUrl from "../../../../../../design/references/grok-icon-study/replica/src/tricks.js?url";
import idleAvatarUrl from "../../../../../../design/references/grok-icon-study/replica/grok-blob-idle.svg?url";

export type AgentAvatarState =
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
	options: { state: string; sizePx: number; mode: "hold"; loginWrap: boolean; followPointer: boolean },
) => GrokCharacterInstance;

declare global {
	interface Window {
		GrokCharacter?: GrokCharacterConstructor;
	}
}

const sourceState: Record<Exclude<AgentAvatarState, "completed" | "failed">, string> = {
	loading: "loading",
	thinking: "thinking",
	searching: "searching",
	working: "working",
	reading: "receiving",
	writing: "writing",
	waiting: "listening",
};

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

/** 对话流专用的微型 Agent 状态标记；终态退化为安静圆点。 */
export function AgentStatusAvatar({ state }: { state: AgentAvatarState }) {
	const svgRef = useRef<SVGSVGElement>(null);
	const characterRef = useRef<GrokCharacterInstance | undefined>(undefined);
	const lastActiveStateRef = useRef("thinking");
	const [showExitAvatar, setShowExitAvatar] = useState(false);
	const terminal = state === "completed" || state === "failed";

	useEffect(() => {
		if (terminal) {
			if (!characterRef.current) return;
			characterRef.current.setState(lastActiveStateRef.current);
			const timer = window.setTimeout(() => {
				characterRef.current?.destroy();
				characterRef.current = undefined;
				setShowExitAvatar(false);
			}, 1200);
			return () => window.clearTimeout(timer);
		}

		setShowExitAvatar(true);
		let disposed = false;
		const stateName = sourceState[state];
		lastActiveStateRef.current = stateName;
		void loadStudyScripts()
			.then(() => {
				if (disposed || !svgRef.current || !window.GrokCharacter) return;
				if (!characterRef.current) {
					characterRef.current = new window.GrokCharacter(svgRef.current, {
						state: stateName,
						sizePx: 40,
						mode: "hold",
						loginWrap: true,
						followPointer: false,
					});
				} else {
					characterRef.current.setState(stateName);
				}
			})
			.catch(() => {
				// 资源加载失败时保持签名行可用；状态文本仍会正常显示。
			});
		return () => {
			disposed = true;
		};
	}, [state, terminal]);

	useEffect(
		() => () => {
			characterRef.current?.destroy();
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
			<svg ref={svgRef} viewBox="-15 -15 259 259" aria-hidden="true" focusable="false">
				<image href={idleAvatarUrl} width="259" height="259" x="-15" y="-15" />
			</svg>
		</span>
	);
}
