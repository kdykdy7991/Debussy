import { useEffect, useState } from "react";
import {
	AgentTrace,
	AgentTraceEvent,
	AssistantResponse,
	AssistantSignature,
	Lede,
	MessageActions,
	Prose,
	StreamCursor,
	UserMessage,
	type AgentTraceEventStatus
} from "../../src";

type SimEvent = { title: string; detail: string; at: number; runningAt: number; doneAt: number };

const EVENTS: SimEvent[] = [
	{ title: "解析附件", detail: "q3_orders.csv · 48,221 行", at: 300, runningAt: 700, doneAt: 1500 },
	{ title: "检索企业知识库", detail: "「Q3 增长复盘」· top_k=5", at: 1500, runningAt: 1900, doneAt: 2900 },
	{ title: "找到 3 篇相关文档", detail: "增长运营复盘 Q3.pdf 等", at: 3000, runningAt: 3400, doneAt: 4300 },
	{ title: "查询数据仓库", detail: "warehouse.query · 214 rows · 840ms", at: 4400, runningAt: 4800, doneAt: 5700 },
	{ title: "数字一致性校验", detail: "14 / 14 通过", at: 5800, runningAt: 6200, doneAt: 6900 },
	{ title: "正在综合分析…", detail: "正文流式输出中", at: 7000, runningAt: 7400, doneAt: 9200 }
];

const BLOCK_AT = [1600, 2240, 2880]; // 块级 stagger 640ms（streaming-reveal）
const CURSOR_AT = 3100;
const END_AT = 9200; // 末事件 held running 直到正文结束

/**
 * 场景 3：running agent trace（live 模拟）。
 * 同一 event node 原地更新 pending → running → completed；
 * 正文按语义块逐块 reveal；光标跟随；actions 完成后渐入。
 */
export function RunningScene() {
	const [runId, setRunId] = useState(0);
	const [shown, setShown] = useState(0);
	const [statuses, setStatuses] = useState<AgentTraceEventStatus[]>(() =>
		EVENTS.map(() => "pending")
	);
	const [blocks, setBlocks] = useState(0);
	const [cursor, setCursor] = useState(false);
	const [done, setDone] = useState(false);

	useEffect(() => {
		setShown(0);
		setStatuses(EVENTS.map(() => "pending"));
		setBlocks(0);
		setCursor(false);
		setDone(false);

		const timers: Array<ReturnType<typeof setTimeout>> = [];
		const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

		EVENTS.forEach((evt, i) => {
			at(evt.at, () => setShown((s) => Math.max(s, i + 1)));
			at(evt.runningAt, () =>
				setStatuses((prev) => prev.map((s, j) => (j === i ? "running" : s)))
			);
			at(evt.doneAt, () =>
				setStatuses((prev) => prev.map((s, j) => (j === i ? "completed" : s)))
			);
		});
		BLOCK_AT.forEach((ms, i) => at(ms, () => setBlocks(i + 1)));
		at(CURSOR_AT, () => setCursor(true));
		at(END_AT + 100, () => {
			setCursor(false);
			setDone(true);
		});

		return () => timers.forEach(clearTimeout);
	}, [runId]);

	const traceStatus = done ? "completed" : "running";

	return (
		<section className="dm-scene">
			<div className="dm-scene-head">
				<div className="dm-scene-no">03</div>
				<div className="dm-scene-title">Running Agent Trace（live 模拟）</div>
				<div className="dm-scene-desc">
					事件逐个 enter-soft 浮现；running node 唯一 pulse；末事件 held 到正文结束；完成后 signature 落定、actions 渐入。
				</div>
			</div>
			<div className="dm-toolbar">
				<button type="button" className="dm-btn" onClick={() => setRunId((n) => n + 1)}>
					重新播放
				</button>
			</div>
			<div className="dm-frame">
				<UserMessage>
					结合上季度的增长复盘和这份订单数据，告诉我 Q3 增长主要来自哪里，运营侧有没有值得注意的风险。
				</UserMessage>
				<AssistantResponse
					key={runId}
					rail={
						<AgentTrace status={traceStatus} durationMs={END_AT}>
							{EVENTS.slice(0, shown).map((evt) => (
								<AgentTraceEvent
									key={evt.title}
									status={statuses[EVENTS.indexOf(evt)]}
									title={evt.title}
									detail={evt.detail}
								/>
							))}
						</AgentTrace>
					}
				>
					<AssistantSignature
						status={done ? "completed" : "running"}
						name="Nocturne"
						model="GLM-5"
						runningMeta="深度思考中…"
						summary={`${EVENTS.length} 步 · ${(END_AT / 1000).toFixed(1)}s`}
					/>
					<Prose streaming>
						{blocks >= 1 ? (
							<Lede>
								Q3 的增长几乎全部由<em>老客复购与企业版升级</em>驱动——新客侧在悄悄失速。
							</Lede>
						) : null}
						{blocks >= 2 ? (
							<p>
								综合你上传的订单明细与知识库复盘材料，本季 GMV 同比 <strong>+18.4%</strong>
								，但拆开看，结构并不均衡。
							</p>
						) : null}
						{blocks >= 3 ? (
							<p>
								新客首单占比已连续两季下滑，建议为<strong>华东中小企业客群</strong>单独做一次漏斗分析。
							</p>
						) : null}
						{cursor ? <p>下一段即将出现 <StreamCursor /></p> : null}
					</Prose>
					<MessageActions
						visible={done}
						items={[
							{ label: "复制" },
							{ label: "导出纪要" },
							{ label: "追问：华东客群漏斗 →", key: true }
						]}
					/>
				</AssistantResponse>
			</div>
		</section>
	);
}
