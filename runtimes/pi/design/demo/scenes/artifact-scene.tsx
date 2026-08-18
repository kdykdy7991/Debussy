import {
	AgentTrace,
	AgentTraceEvent,
	AssistantResponse,
	AssistantSignature,
	MessageActions,
	ReportArtifact,
	UserMessage
} from "../../src";

const SECTIONS = [
	{ index: 1, name: "季度概览", headline: "GMV +18.4% · 结构不均衡", summary: "增长集中于复购与企业版" },
	{ index: 2, name: "增长分项", headline: "复购 41.2% · 企业版 33.5%", summary: "含 2 幅图表与分项表格" },
	{ index: 3, name: "渠道结构", headline: "直营上升 · 分销持平" },
	{
		index: 4,
		name: "风险与预警",
		headline: "独立成章 · 3 项",
		summary: "新客下滑 / 续约红线 / CAC +22%",
		risk: true
	},
	{ index: 5, name: "建议动作", headline: "4 条 · 已标注 owner" },
	{ index: 6, name: "附录", headline: "数据口径与来源清单" }
];

/** 场景 8：Artifact 响应 —— 复杂交付物用 Artifact，不继续堆正文。 */
export function ArtifactScene() {
	return (
		<section className="dm-scene">
			<div className="dm-scene-head">
				<div className="dm-scene-no">08</div>
				<div className="dm-scene-title">Artifact 响应（ReportArtifact + compact 轨迹）</div>
				<div className="dm-scene-desc">
					Artifact = 身份（eyebrow/title）+ 状态（badge）+ 校验事实（meta）+ 章节 TOC；Actions 在 artifact 之外。
				</div>
			</div>
			<div className="dm-frame">
				<UserMessage>把这些整理成一份可以直接发管理层的 Q3 纪要，风险部分单独成章。</UserMessage>
				<AssistantResponse
					rail={
						<AgentTrace status="completed" title="运行轨迹" compact durationMs={134000}>
							<AgentTraceEvent status="completed" title="任务规划" detail="8 步 · 风险独立成章 ✓" />
							<AgentTraceEvent status="completed" title="复用上轮分析" detail="3 篇来源 + 1 篇新增" />
							<AgentTraceEvent status="completed" title="检索纪要模板" detail="管理层版式 · 命中 1 篇" />
							<AgentTraceEvent status="completed" title="渲染纪要" detail="6 章 · 2 图 · 12.6s" />
							<AgentTraceEvent status="completed" title="风险章节拆分" detail="3 项 · 独立成章" />
							<AgentTraceEvent status="completed" title="数字一致性校验" detail="14 / 14 通过" />
							<AgentTraceEvent status="completed" title="生成发送草稿" detail="邮件 · 待确认" />
							<AgentTraceEvent status="completed" title="运行结束" detail="总耗时 2m 14s" />
						</AgentTrace>
					}
				>
					<AssistantSignature status="completed" summary="8 步 · 2m 14s" />
					<ReportArtifact
						eyebrow="管理纪要 · 草稿"
						title="2025 Q3 增长复盘纪要"
						meta="供管理层参阅 · 基于 4 篇来源与上轮分析 · 数字校验 14 / 14"
						status="待审阅"
						statusTone="accent"
						sections={SECTIONS}
					/>
					<MessageActions
						visible
						items={[
							{ label: "阅读视图打开" },
							{ label: "导出 PDF" },
							{ label: "发送草稿 →" },
							{ label: "编辑大纲", key: true }
						]}
					/>
				</AssistantResponse>
			</div>
		</section>
	);
}
