import { useState } from "react";

interface ContextUsageRingProps {
	readonly usedTokens: number;
	readonly workingBudget: number;
	readonly contextWindow: number;
	readonly usagePercent: number;
	readonly summaryThroughSequence: number;
	readonly busy: boolean;
	readonly onCompact: () => Promise<boolean>;
}

/** Compact, disclosure-based view of the same estimate used by compaction. */
export function ContextUsageRing(props: ContextUsageRingProps): React.JSX.Element {
	const [compacting, setCompacting] = useState(false);
	const [result, setResult] = useState<string | null>(null);
	const windowPercent = props.contextWindow > 0 ? (props.usedTokens / props.contextWindow) * 100 : 0;
	const displayedPercent = Math.max(0, Math.min(100, windowPercent));
	const radius = 12;
	const circumference = 2 * Math.PI * radius;
	const compact = async (): Promise<void> => {
		setCompacting(true);
		setResult(null);
		try {
			const compacted = await props.onCompact();
			setResult(compacted ? "已压缩较早的对话，最近一轮保留原文。" : "暂无可压缩的较早轮次。");
		} catch {
			setResult("压缩失败，请稍后重试。");
		} finally {
			setCompacting(false);
		}
	};
	return (
		<details className="embed-context-ring">
			<summary aria-label={`上下文已用 ${windowPercent.toFixed(1)}%，查看详情`}>
				<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
					<circle className="embed-context-ring-track" cx="16" cy="16" r={radius} fill="none" strokeWidth="3" />
					<circle
						className="embed-context-ring-fill"
						cx="16"
						cy="16"
						r={radius}
						fill="none"
						strokeWidth="3"
						strokeDasharray={`${(displayedPercent / 100) * circumference} ${circumference}`}
						transform="rotate(-90 16 16)"
					/>
				</svg>
			</summary>
			<div className="embed-context-ring-panel">
				<strong>当前会话上下文</strong>
				<p>上下文已用 {windowPercent.toFixed(1)}%</p>
				<dl>
					<div>
						<dt>对话内容估算</dt>
						<dd>{props.usedTokens.toLocaleString()} tokens</dd>
					</div>
					<div>
						<dt>上下文窗口</dt>
						<dd>{props.contextWindow.toLocaleString()} tokens</dd>
					</div>
				</dl>
				<button
					type="button"
					className="embed-context-ring-compact"
					disabled={props.busy || compacting}
					onClick={() => void compact()}
				>
					{compacting ? "压缩中…" : "主动压缩上下文"}
				</button>
				{result !== null && <output className="embed-context-ring-result">{result}</output>}
				<small>对话内容按已保存的上下文估算，不含系统指令和工具等开销，回复完成后更新。</small>
			</div>
		</details>
	);
}
