import {
	AgentTrace,
	AgentTraceEvent,
	AssistantResponse,
	AssistantSignature,
	ChartContainer,
	Cite,
	DataTable,
	Lede,
	MessageActions,
	Prose,
	Section,
	Sources,
	UserMessage
} from "../../src";
import { GMV_BARS, GMV_X_LABELS, GROWTH_COLUMNS, GROWTH_ROWS } from "./data";

/** 场景 1 + 2：会话流 —— 简单回复（plain）+ 工具任务（analysis，completed）。 */
export function ConversationScene() {
	return (
		<section className="dm-scene">
			<div className="dm-scene-head">
				<div className="dm-scene-no">01 · 02</div>
				<div className="dm-scene-title">会话流：简单回复 + 工具任务（completed）</div>
				<div className="dm-scene-desc">
					turn = UserMessage + AssistantResponse；assistant 是 reading canvas（无 bubble），rail 250px 展示已完成执行。
				</div>
			</div>
			<div className="dm-frame">
				<div className="dm-masthead" style={{ marginBottom: "var(--ai-space-3xl)" }}>
					<div className="dm-masthead-eyebrow" style={{ marginBottom: 14 }}>
						Session · 08 / 18
					</div>
					<h1 className="dm-masthead-title" style={{ fontSize: "var(--ai-text-title)", margin: 0 }}>
						Q3 增长复盘
					</h1>
					<div className="dm-masthead-sub" style={{ marginTop: 10 }}>
						检索 <b>3 篇</b>企业文档 · 分析 <b>48,221</b> 行订单 · <b>9</b> 次工具调用
					</div>
				</div>

				{/* 场景 1：simple reply */}
				<UserMessage variant="plain">下午好</UserMessage>
				<AssistantResponse>
					<AssistantSignature status="plain" name="Nocturne" model="GLM-5" />
					<Prose plain>
						<p>下午好，Stride。我在。</p>
					</Prose>
				</AssistantResponse>

				{/* 场景 2：tool task */}
				<UserMessage attachments={["q3_orders.csv", "growth_q3_export.xlsx"]}>
					结合上季度的增长复盘和这份订单数据，告诉我 Q3 增长主要来自哪里，运营侧有没有值得注意的风险。
				</UserMessage>
				<AssistantResponse
					rail={
						<AgentTrace status="completed" title="运行轨迹">
							<AgentTraceEvent status="completed" title="解析附件" detail="q3_orders.csv · 48,221 行" />
							<AgentTraceEvent status="completed" title="检索企业知识库" detail="「Q3 增长复盘」· top_k=5" />
							<AgentTraceEvent status="completed" title="找到 3 篇相关文档" detail="增长运营复盘 Q3.pdf 等" />
							<AgentTraceEvent status="completed" title="MCP 调用完成" detail="warehouse.query · 留存交叉验证" />
							<AgentTraceEvent status="completed" title="综合分析完成" detail="正文与图表已生成 · 4.2s" />
						</AgentTrace>
					}
				>
					<AssistantSignature
						status="completed"
						completedLabel="Nocturne"
						summary="9 次工具调用 · 42s"
					/>
					<Prose>
						<Lede>
							Q3 的增长几乎全部由<em>老客复购与企业版升级</em>驱动——新客侧在悄悄失速。
						</Lede>
						<p>
							综合你上传的订单明细与知识库复盘材料<Cite index={1} />
							，本季 GMV 同比 <strong>+18.4%</strong>，但拆开看，结构并不均衡：
						</p>
						<DataTable
							caption="Q3 增长分项"
							source="q3_orders.csv"
							columns={GROWTH_COLUMNS}
							rows={GROWTH_ROWS}
						/>
						<ChartContainer
							caption="月度 GMV 走势"
							unit="百万元"
							bars={GMV_BARS}
							xLabels={GMV_X_LABELS}
						/>
						<Section index={2}>值得注意的风险</Section>
						<p>
							新客首单占比已连续两季下滑，同期获客成本上升 22%<Cite index={3} />
							。运营周报将其归因于投放渠道结构变化<Cite index={2} />
							，但订单数据显示下滑集中在<strong>华东中小企业客群</strong>
							——与归因并不完全一致，建议为该客群单独做一次漏斗分析。
						</p>
						<p>
							另外，企业版续约率为 <code>91.7%</code>，已低于 <code>93%</code> 的内部红线，属于需要提前介入的信号。
						</p>
						<Sources
							sources={[
								{
									id: 1,
									title: "2025 Q3 增长运营复盘（终版）",
									meta: "增长运营组 · 10/08 · 24 页 · 命中 4 段",
									type: "知识库"
								},
								{ id: 2, title: "运营周报 2025-W33", meta: "运营组 · 命中 2 段", type: "知识库" },
								{ id: 3, title: "市场投放成本月报 · 9 月", meta: "市场共享盘 · xlsx", type: "共享盘" }
							]}
						/>
					</Prose>
					<MessageActions
						visible
						items={[
							{ label: "复制" },
							{ label: "导出纪要" },
							{ label: "追问：华东客群漏斗 →", key: true },
							{ label: "转为正式报告" }
						]}
					/>
				</AssistantResponse>
			</div>
		</section>
	);
}
