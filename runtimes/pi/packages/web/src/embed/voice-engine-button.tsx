/**
 * 发布对话页 Voice Engine 最小按钮（spec：MVP §4.1 / §5.1，Task 5）。
 *
 * 仅当发布页 `features.realtimeVoice === true` 时挂在 composer 旁。点击
 * toggle 触发父组件提供的 `onToggle` 回调；本组件**不**做麦克风采集、
 * AudioWorklet、PCM、ASR、TTS、transcript、barge-in 或重连 — 那些是后续
 * Task 的工作。本 Task 只验证"点击 connect / disconnect,显示最小连接
 * 状态"。
 *
 * 与既有 `LiveSpeechToggle` / SpeechController 路径完全独立：旧
 * `enableVoice` 仍然关闭，文本会话路径与语音会话路径不复用。
 */

import type { VoiceAsrState } from "./voice-asr-session.ts";
import type { VoiceEngineStatus } from "./voice-engine-transport.ts";
import type { VoiceTtsPhase } from "./voice-tts-session.ts";

export interface VoiceEngineButtonProps {
	readonly status: VoiceEngineStatus;
	readonly asr: VoiceAsrState;
	readonly enabled: boolean;
	readonly agentResponding: boolean;
	readonly tts: VoiceTtsPhase;
	readonly onToggle: () => void;
}

function describeStatus(status: VoiceEngineStatus): { readonly label: string; readonly hint: string } {
	switch (status) {
		case "connecting":
			return { label: "语音模式：连接中…", hint: "正在申请 Voice Engine ticket" };
		case "connected":
			return { label: "语音模式：已连接", hint: "点击关闭语音模式" };
		case "closed":
			return { label: "语音模式：已断开", hint: "点击重新连接" };
		default:
			return { label: "开启语音模式", hint: "通过同源 Voice WS 接入 VoxEMW（实验性）" };
	}
}

export function VoiceEngineButton({
	status,
	asr,
	enabled,
	agentResponding,
	tts,
	onToggle,
}: VoiceEngineButtonProps): React.ReactElement {
	const connection = describeStatus(status);
	const stateLabel = !enabled
		? "文本模式"
		: asr.error !== undefined || tts === "error" || status === "closed"
			? "错误"
			: status === "connecting" || asr.phase === "requesting_permission"
				? "连接中"
				: tts === "playing"
					? "正在播放"
					: agentResponding || tts === "synthesizing"
						? "Agent 回复中"
						: asr.phase === "listening"
							? "正在聆听"
							: asr.phase === "final"
								? "正在识别"
								: connection.label;
	return (
		<div
			className={`voice-engine-debug ${enabled ? "voice-mode-active" : ""}`}
			data-asr-phase={asr.phase}
			data-voice-mode={enabled ? "voice" : "text"}
		>
			{enabled ? <strong className="voice-mode-indicator">语音模式 · {stateLabel}</strong> : null}
			<button
				type="button"
				className={`voice-engine-button status-${status}`}
				data-status={status}
				aria-pressed={enabled}
				aria-busy={enabled && status === "connecting"}
				title={connection.hint}
				onClick={onToggle}
			>
				<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
					<rect x="8" y="3" width="4" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
					<path d="M5 10a5 5 0 0 0 10 0M10 15v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
				</svg>
				<span>{enabled ? "退出语音" : "语音模式"}</span>
			</button>
			{asr.finalText !== undefined ? (
				<output className="voice-engine-final">ASR final: {asr.finalText}</output>
			) : null}
			{asr.error !== undefined ? <output className="voice-engine-error">语音错误: {asr.error}</output> : null}
		</div>
	);
}
