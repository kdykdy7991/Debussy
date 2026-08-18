import {
	AssistantResponse,
	AssistantSignature,
	ChartContainer,
	DataTable,
	Lede,
	MessageActions,
	Prose,
	UserMessage
} from "../../src";
import { REGION_BARS, REGION_COLUMNS, REGION_ROWS, REGION_X_LABELS } from "./data";

/** 场景 7：Data Analysis 响应 —— 表 + 图 + 结论，no-rail（无 agent 执行叙事时单列）。 */
export function AnalysisScene() {
	return (
		<section className="dm-scene">
			<div className="dm-scene-head">
				<div className="dm-scene-no">07</div>
				<div className="dm-scene-title">Data Analysis 响应（表 + 图，no-rail）</div>
				<div className="dm-scene-desc">
					数字列右对齐 mono；up/down 走语义 tone（主题语义色）；图表强调点用 accent，不另设配色。
				</div>
			</div>
			<div className="dm-frame">
				<UserMessage>按区域拆一下 GMV 和新客占比，指出跑输大盘的区域。</UserMessage>
				<AssistantResponse>
					<AssistantSignature status="completed" completedLabel="Nocturne" summary="4 步 · 12s" />
					<Prose>
						<Lede>
							华东 GMV 最大（31.2M）但新客同比 <em>−18.2%</em>，是唯一下滑超过大盘的区域。
						</Lede>
						<p>
							大盘新客同比约 −5%；华东的下滑集中在<strong>中小企业客群</strong>，与上轮 Q3 复盘的风险信号吻合。
						</p>
						<DataTable
							caption="区域 GMV 与新客结构"
							source="orders · 2025-04 ~ 09"
							columns={REGION_COLUMNS}
							rows={REGION_ROWS}
						/>
						<ChartContainer
							caption="区域 GMV 对比"
							unit="百万元"
							bars={REGION_BARS}
							xLabels={REGION_X_LABELS}
						/>
						<p>建议把华东新客漏斗拆到渠道粒度，先排除投放结构变化的干扰，再下结论。</p>
					</Prose>
					<MessageActions
						visible
						items={[
							{ label: "拆华东渠道漏斗 →", key: true },
							{ label: "导出区域明细" },
							{ label: "复制" }
						]}
					/>
				</AssistantResponse>
			</div>
		</section>
	);
}
