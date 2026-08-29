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
// failed 不在 sourceState 里——它走 terminal 分支：把角色切到
// "alerting"（fx.js 里的 bang overlay，即感叹号）并持续保留，
// 失败是本次运行的终态，必须一直提示到下一次用户操作。
// 冷挂载（页面刷新时已处于 failed）则直接以 "alerting" 加载引擎。

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

/** 对话流专用的微型 Agent 状态标记；失败终态持续显示感叹号（alerting）。 */
export const AgentStatusAvatar = memo(function AgentStatusAvatar({ state }: { state: AgentAvatarState }) {
	const svgRef = useRef<SVGSVGElement>(null);
	const characterRef = useRef<GrokCharacterInstance | undefined>(undefined);
	const appliedStateRef = useRef<string | undefined>(undefined);
	const lastActiveStateRef = useRef("thinking");
	const [engineReady, setEngineReady] = useState(false);
	const terminal = state === "failed";

	useEffect(() => {
		if (terminal) {
			// failed 是持续可见的终态，不是 1.2s 闪退。
			// 切到 "alerting"（fx.js 里 bang overlay = 感叹号），让角色
			// 一直挂着感叹号，等下一次非 failed 状态进来时由非 terminal
			// 分支 `characterRef.current.setState(stateName)` 自然替换。
			if (characterRef.current) {
				characterRef.current.setState("alerting");
				appliedStateRef.current = "alerting";
				lastActiveStateRef.current = "alerting";
				return undefined;
			}
			// 冷挂载直接落在 failed（例如页面刷新停在失败态）：引擎还没创建，
			// 直接以 "alerting" 加载，而不是只留一个红点看不出发生了什么。
			lastActiveStateRef.current = "alerting";
			let disposed = false;
			void loadStudyScripts()
				.then(() => {
					if (disposed || !svgRef.current || !window.GrokCharacter) return;
					if (!characterRef.current) {
						characterRef.current = new window.GrokCharacter(svgRef.current, {
							state: "alerting",
							sizePx: 64,
							mode: "hold",
							loginWrap: true,
							followPointer: true,
							followPointerBody: true,
							followPointerStrength: 2.4,
						});
						appliedStateRef.current = "alerting";
						setEngineReady(true);
					}
				})
				.catch(() => {
					// 资源加载失败时保持签名行可用；状态文本仍会正常显示。
				});
			return () => {
				disposed = true;
			};
		}

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
