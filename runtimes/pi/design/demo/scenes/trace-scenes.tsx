import {
	AgentTrace,
	AgentTraceEvent,
	AssistantResponse,
	AssistantSignature,
	Prose,
	MessageActions,
	UserMessage
} from "../../src";

const EIGHT_EVENTS = [
	{ title: "任务规划", detail: "8 步 · 风险独立成章 ✓" },
	{ title: "复用上轮分析", detail: "3 篇来源 + 1 篇新增" },
	{ title: "检索企业知识库", detail: "「管理层纪要模板」· top_k=3" },
	{ title: "渲染纪要", detail: "6 章 · 2 图 · 12.6s" },
	{ title: "数字一致性校验", detail: "14 / 14 通过" },
	{ title: "套用纪要模板", detail: "管理层版式 · 6 章" },
	{ title: "生成发送草稿", detail: "邮件 · 待确认" },
	{ title: "运行结束", detail: "总耗时 2m 14s" }
];

/** 场景 4 + 5：completed / compact / failed 轨迹 + 四态 gallery。 */
export function TraceScenes() {
	return (
		<section className="dm-scene">
			<div className="dm-scene-head">
				<div className="dm-scene-no">04 · 05</div>
				<div className="dm-scene-title">轨迹状态：completed（全量 / compact）+ failed</div>
				<div className="dm-scene-desc">
					summary 默认 ≤5 事件，其余走披露链接；compact 在完成后折叠为一行摘要（可展开）；失败事件 detail 显示原因。
				</div>
			</div>

			<div className="dm-row">
				<div>
					<div className="dm-row-label">completed · 全量（8 事件，披露 3 个）</div>
					<div className="dm-frame" style={{ padding: "var(--ai-space-2xl)" }}>
						<AgentTrace status="completed" title="运行轨迹">
							{EIGHT_EVENTS.map((e) => (
								<AgentTraceEvent key={e.title} status="completed" title={e.title} detail={e.detail} />
							))}
						</AgentTrace>
					</div>
				</div>
				<div>
					<div className="dm-row-label">completed · compact（一行摘要，可展开）</div>
					<div className="dm-frame" style={{ padding: "var(--ai-space-2xl)" }}>
						<AgentTrace status="completed" title="运行轨迹" compact durationMs={134000}>
							{EIGHT_EVENTS.map((e) => (
								<AgentTraceEvent key={e.title} status="completed" title={e.title} detail={e.detail} />
							))}
						</AgentTrace>
					</div>
					<div className="dm-note">
						同一组件的另一种折叠形态；展开后与全量一致。
					</div>
				</div>
			</div>

			<div className="dm-frame" style={{ marginTop: "var(--ai-space-xl)" }}>
				<div className="dm-row-label" style={{ marginBottom: "var(--ai-space-lg)" }}>
					四态 gallery：pending / running / completed / failed（含 payload 披露）
				</div>
				<AgentTrace status="running">
					<AgentTraceEvent status="pending" title="等待调度" detail="排队中" />
					<AgentTraceEvent status="running" title="查询数据仓库" detail="warehouse.query · 进行中" />
					<AgentTraceEvent
						status="completed"
						title="检索知识库"
						detail="3 documents · 220ms"
						payload={JSON.stringify(
							{ tool_call: "knowledge.search", args: { query: "Q3 增长复盘", top_k: 5 }, result: { rows: 3, ms: 220 } },
							null,
							2
						)}
					/>
					<AgentTraceEvent status="failed" title="拉取日程数据" detail="calendar.read · 权限不足（403）" />
				</AgentTrace>
			</div>

			<div className="dm-frame" style={{ marginTop: "var(--ai-space-xl)" }}>
				<div className="dm-row-label" style={{ marginBottom: "var(--ai-space-lg)" }}>
					failed 轨迹（answer 内）
				</div>
				<UserMessage variant="plain">拉取上周的渠道 ROI 明细。</UserMessage>
				<AssistantResponse
					rail={
						<AgentTrace status="failed">
							<AgentTraceEvent status="completed" title="口径解析" detail="ROI = GMV / 投放成本" />
							<AgentTraceEvent status="completed" title="拉取渠道清单" detail="12 个渠道 · 共享盘" />
							<AgentTraceEvent
								status="failed"
								title="查询数据仓库"
								detail="warehouse.query · 超时 30s · 已重试 3 次"
							/>
							<AgentTraceEvent status="pending" title="聚合 ROI 明细" detail="等待上游结果" />
						</AgentTrace>
					}
				>
					<AssistantSignature status="failed" failedLabel="Agent 运行失败" summary="3 步 · 1m 12s · 中断" />
					<Prose>
						<p>
							任务在数据仓库查询阶段中断：warehouse.query 连接超时（已重试 3 次）。已完成的口径解析保留在草稿中，可重试，或改用共享盘导出继续。
						</p>
					</Prose>
					<MessageActions
						visible
						items={[
							{ label: "重试" },
							{ label: "改用共享盘数据 →", key: true },
							{ label: "导出部分结果" }
						]}
					/>
				</AssistantResponse>
			</div>
		</section>
	);
}
