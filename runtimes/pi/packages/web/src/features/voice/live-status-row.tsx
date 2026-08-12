/**
 * Phase 2 live朗读 status row.
 *
 * Shown beneath each assistant message that has an active live playback. The
 * row surfaces the four phases required by Spec §5.3 / V9 §5.3:
 *
 *   - "等待文本" (waiting_for_text)
 *   - "生成语音" (generating)
 *   - "播放" (streaming)
 *   - "正在结束" (draining → ended)
 *
 * A "停止朗读" button sits on the right; it is always keyboard-accessible and
 * carries an `aria-label`. When the playback has terminated, the row collapses
 * and the Phase 1 manual朗读 button on the assistant message remains
 * available (V9 §5.3: "完成消息的 Phase 1 手动朗读按钮保留").
 */

import type { LivePlaybackState } from "./live-types.ts";

export interface LiveStatusRowProps {
	state: LivePlaybackState;
	onStop(): void;
}

export function LiveStatusRow({ state, onStop }: LiveStatusRowProps) {
	const visible = state !== "idle" && state !== "ended";
	if (!visible) return null;

	const label = labelForState(state);
	const isActive =
		state === "waiting_for_text" || state === "generating" || state === "streaming" || state === "draining";

	return (
		<output className="live-status-row" aria-live="polite">
			<span className={`live-status-pill ${state}`} aria-hidden="true">
				<i />
				{label}
			</span>
			<button
				type="button"
				className="live-stop-button"
				onClick={onStop}
				disabled={!isActive && state !== "stopped"}
				aria-label="停止实时朗读"
				aria-keyshortcuts="Escape"
			>
				<span aria-hidden="true">■</span>
				停止朗读
			</button>
		</output>
	);
}

function labelForState(state: LivePlaybackState): string {
	switch (state) {
		case "waiting_for_text":
			return "等待文本";
		case "generating":
			return "生成语音";
		case "streaming":
			return "播放中";
		case "draining":
			return "正在结束";
		case "stopped":
			return "已停止";
		case "error":
			return "朗读出错";
		default:
			return "";
	}
}
