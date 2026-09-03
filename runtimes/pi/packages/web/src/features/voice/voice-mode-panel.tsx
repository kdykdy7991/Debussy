/**
 * Chat voice mode floating panel.
 *
 * Right-side floating surface (mirrors the design) that exposes the live
 * Voice MVP state — ASR phase, transport status, TTS phase — in a single
 * compact card. The panel is dismissable: the only visible affordance is an
 * "退出语音" button at the top right. Closing the panel is the same action
 * as toggling voice mode off (parent owns the lifecycle).
 *
 * The panel must be cheap to render when the workspace is in text mode: it
 * returns `null` so it never interferes with the chat layout.
 */

import { useEffect, useRef, useState } from "react";
import type { VoiceAsrState } from "../../embed/voice-asr-session.ts";
import type { VoiceEngineStatus } from "../../embed/voice-engine-transport.ts";
import type { PublishedChatMode } from "../../embed/voice-mode.ts";
import type { VoiceTtsPhase } from "../../embed/voice-tts-session.ts";

export interface VoiceModePanelProps {
	readonly status: VoiceEngineStatus;
	readonly asr: VoiceAsrState;
	readonly mode: PublishedChatMode;
	readonly tts: VoiceTtsPhase;
	readonly onExit: () => void;
}

interface PanelEvent {
	readonly label: string;
	readonly kind: "connected" | "listening" | "recognizing" | "reply" | "playing" | "info";
	readonly timestamp: string;
}

// Pre-compute the waveform bar animation delays so the JSX can iterate over a
// stable array and the bars themselves don't need to recompute on every
// render. Each entry carries a stable `key` derived from its delay (the bars
// are never reordered, so a content-derived key is safe).
interface WaveBar {
	readonly delay: number;
	readonly key: string;
}
const WAVEFORM_BARS: readonly WaveBar[] = Array.from({ length: 48 }, (_, index) => {
	const delay = index * 35;
	return { delay, key: `wave-bar-${delay}` };
});

function formatClock(date: Date): string {
	const pad = (value: number): string => value.toString().padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function ttsLabel(tts: VoiceTtsPhase): string {
	switch (tts) {
		case "idle":
			return "等待回复";
		case "synthesizing":
			return "正在合成";
		case "playing":
			return "正在播放";
		case "error":
			return "朗读出错";
		default:
			return tts;
	}
}

function summarize({
	status,
	asr,
	mode,
	tts,
}: {
	readonly status: VoiceEngineStatus;
	readonly asr: VoiceAsrState;
	readonly mode: PublishedChatMode;
	readonly tts: VoiceTtsPhase;
}): { readonly headline: string; readonly active: boolean; readonly hint: string } {
	if (mode !== "voice") {
		return { headline: "未启用", active: false, hint: "在底部切换至语音模式开始对话" };
	}
	if (status === "connecting") {
		return { headline: "正在连接…", active: true, hint: "正在准备语音通道" };
	}
	if (status === "closed" || status === "disconnected") {
		return { headline: "连接已断开", active: false, hint: "语音通道未建立,可重试" };
	}
	if (asr.error !== undefined) {
		return { headline: "语音出错", active: false, hint: asr.error };
	}
	if (tts === "error") {
		return { headline: "朗读出错", active: false, hint: "请稍后重试" };
	}
	if (tts === "playing" || tts === "synthesizing") {
		return { headline: ttsLabel(tts), active: true, hint: "正在播放 Agent 回复" };
	}
	switch (asr.phase) {
		case "requesting_permission":
			return { headline: "申请麦克风…", active: true, hint: "请在浏览器中允许使用麦克风" };
		case "listening":
			return { headline: "正在聆听", active: true, hint: "我在听,你可以开始说话" };
		case "final":
			return { headline: "正在识别", active: true, hint: "识别已完成,等待 Agent 回复" };
		case "error":
			return { headline: "语音出错", active: false, hint: asr.error ?? "语音识别失败" };
		default:
			return { headline: "语音模式", active: true, hint: "我在听,你可以开始说话" };
	}
}

export function VoiceModePanel(props: VoiceModePanelProps): React.ReactElement | null {
	const { status, asr, mode, tts, onExit } = props;
	const [events, setEvents] = useState<readonly PanelEvent[]>([]);
	const lastPhaseRef = useRef<string | null>(null);
	const lastStatusRef = useRef<VoiceEngineStatus>(status);
	const startedAtRef = useRef<number | null>(null);
	const [elapsed, setElapsed] = useState(0);

	const visible = mode === "voice";

	// Reset event log when entering voice mode; tick the elapsed timer every
	// second. Both effects early-return when the panel is hidden so we don't
	// burn cycles or leak timers while the workspace is in text mode.
	useEffect(() => {
		if (!visible) {
			setEvents([]);
			setElapsed(0);
			lastPhaseRef.current = null;
			lastStatusRef.current = status;
			startedAtRef.current = null;
			return undefined;
		}
		if (startedAtRef.current === null) {
			startedAtRef.current = Date.now();
		}
		const interval = window.setInterval(() => {
			const started = startedAtRef.current;
			if (started === null) return;
			setElapsed(Math.floor((Date.now() - started) / 1000));
		}, 1000);
		return () => window.clearInterval(interval);
	}, [visible, status]);

	// Append a timestamped event whenever the high-level state crosses a
	// boundary. We dedupe by the state key (status / phase / running) so we
	// don't re-render the same row when the underlying controller re-emits.
	useEffect(() => {
		if (!visible) return;
		const now = new Date();
		const stamp = formatClock(now);
		const stateKey = `${status}|${asr.phase}|${tts}`;
		if (stateKey === lastPhaseRef.current) return;
		lastPhaseRef.current = stateKey;
		if (lastStatusRef.current !== status && status === "connected") {
			setEvents((current) => [{ label: "连接已建立", kind: "connected", timestamp: stamp }, ...current]);
		}
		lastStatusRef.current = status;
		if (tts === "playing") {
			setEvents((current) => [{ label: "正在播放", kind: "playing", timestamp: stamp }, ...current]);
		} else if (tts === "synthesizing") {
			setEvents((current) => [{ label: "Agent 回复中", kind: "reply", timestamp: stamp }, ...current]);
		} else if (asr.phase === "listening") {
			setEvents((current) => [{ label: "正在聆听…", kind: "listening", timestamp: stamp }, ...current]);
		} else if (asr.phase === "final") {
			setEvents((current) => [{ label: "正在识别", kind: "recognizing", timestamp: stamp }, ...current]);
		} else if (asr.phase === "idle" && tts === "idle" && status === "connected") {
			setEvents((current) => [{ label: "等待回复", kind: "info", timestamp: stamp }, ...current]);
		}
	}, [visible, status, asr.phase, tts]);

	if (!visible) return null;

	const summary = summarize({ status, asr, mode, tts });
	const listening = asr.phase === "listening";
	const elapsedLabel = `${Math.floor(elapsed / 60)
		.toString()
		.padStart(2, "0")}:${(elapsed % 60).toString().padStart(2, "0")}`;

	return (
		<aside className="voice-mode-panel" aria-label="语音模式状态" aria-live="polite">
			<span className="voice-mode-panel__notch" aria-hidden="true" />
			<header className="voice-mode-panel__header">
				<div className="voice-mode-panel__title-block">
					<span className="voice-mode-panel__icon">
						<svg viewBox="0 0 16 16" width="14" height="14" focusable="false" aria-hidden="true">
							<title>语音模式</title>
							<rect
								x="6"
								y="2.5"
								width="4"
								height="7.5"
								rx="2"
								stroke="currentColor"
								strokeWidth="1.3"
								fill="none"
							/>
							<path
								d="M3.75 8a4.25 4.25 0 0 0 8.5 0M8 12.25v1.5"
								stroke="currentColor"
								strokeWidth="1.3"
								strokeLinecap="round"
								fill="none"
							/>
						</svg>
					</span>
					<div className="voice-mode-panel__title-text">
						<strong>语音模式</strong>
						<span className={`voice-mode-panel__status ${summary.active ? "is-active" : ""}`}>
							<span className="voice-mode-panel__status-dot" aria-hidden="true" />
							{summary.headline}
						</span>
					</div>
				</div>
				<button type="button" className="voice-mode-panel__exit" onClick={onExit} aria-label="退出语音">
					退出语音
				</button>
			</header>

			<output className="voice-mode-panel__prompt">
				<p className="voice-mode-panel__hint">{summary.hint}</p>
				<time className="voice-mode-panel__elapsed" dateTime={`PT${elapsed}S`}>
					{elapsedLabel}
				</time>
			</output>

			<div className={`voice-mode-panel__waveform ${listening ? "is-listening" : ""}`} aria-hidden="true">
				{WAVEFORM_BARS.map((bar) => (
					<span key={bar.key} className="voice-mode-panel__bar" style={{ animationDelay: `${bar.delay}ms` }} />
				))}
			</div>

			<section className="voice-mode-panel__events" aria-label="语音状态">
				<header className="voice-mode-panel__events-title">语音状态</header>
				{events.length === 0 ? (
					<p className="voice-mode-panel__events-empty">等待语音事件…</p>
				) : (
					<ul className="voice-mode-panel__events-list">
						{events.slice(0, 6).map((event, index) => (
							<li key={`${event.timestamp}-${index}-${event.kind}`} className="voice-mode-panel__event">
								<span
									className={`voice-mode-panel__event-dot voice-mode-panel__event-dot--${event.kind}`}
									aria-hidden="true"
								/>
								<span className="voice-mode-panel__event-label">{event.label}</span>
								<time className="voice-mode-panel__event-time">{event.timestamp}</time>
							</li>
						))}
					</ul>
				)}
			</section>

			<footer className="voice-mode-panel__tip">
				<span className="voice-mode-panel__tip-icon">
					<svg viewBox="0 0 16 16" width="11" height="11" focusable="false" aria-hidden="true">
						<title>小提示</title>
						<circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.2" fill="none" />
						<path d="M8 7v4M8 4.6v.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
					</svg>
				</span>
				<span>完整说完一句话效果更好,停顿时我会自动识别。</span>
			</footer>
		</aside>
	);
}
