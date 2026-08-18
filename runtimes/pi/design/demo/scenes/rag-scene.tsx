import { useState } from "react";
import {
	AgentTrace,
	AgentTraceEvent,
	AssistantResponse,
	AssistantSignature,
	Cite,
	Lede,
	MessageActions,
	Prose,
	Sources,
	UserMessage
} from "../../src";
import { RAG_SOURCES } from "./data";

/** 场景 6：RAG 响应 —— cite 芯片与 Sources 1:1 锚定（点击高亮）。 */
export function RagScene() {
	const [activeId, setActiveId] = useState<number | null>(null);

	return (
		<section className="dm-scene">
			<div className="dm-scene-head">
				<div className="dm-scene-no">06</div>
				<div className="dm-scene-title">RAG Response（Cite ↔ Sources 锚定）</div>
				<div className="dm-scene-desc">
					点击正文 Cite 芯片 → 对应 Source 高亮；点击 Source → 反向高亮。检索执行在 rail 中以 3 个语义事件呈现。
				</div>
			</div>
			<div className="dm-frame">
				<UserMessage variant="plain">
					合同审批的权限阈值现在是多少？最近一次调整依据哪份纪要？
				</UserMessage>
				<AssistantResponse
					rail={
						<AgentTrace status="completed" title="运行轨迹">
							<AgentTraceEvent status="completed" title="解析问题" detail="阈值 · 最近调整 · 依据" />
							<AgentTraceEvent status="completed" title="检索企业知识库" detail="「合同审批阈值」· top_k=3" />
							<AgentTraceEvent status="completed" title="找到 3 篇相关文档" detail="命中 7 段 · 8s" />
						</AgentTrace>
					}
				>
					<AssistantSignature status="completed" completedLabel="Nocturne" summary="3 次检索 · 8s" />
					<Prose>
						<Lede>
							现行阈值：单笔合同金额 ≥ 500 万元须法务联签，≥ 2000 万元须 CFO 审批<Cite index={1} onClick={() => setActiveId(1)} />。
						</Lede>
						<p>
							最近一次调整是 2025-W16，把联签线从 800 万下调到 500 万，依据是当时的审批时效数据<Cite index={3} onClick={() => setActiveId(3)} />
							；该调整与集团办法保持了一致<Cite index={4} onClick={() => setActiveId(4)} />。
						</p>
						<p>
							FAQ 中另有常见误用说明（金额按“单合同总额”而非“单期”计算）<Cite index={2} onClick={() => setActiveId(2)} />，如需可附在纪要附录。
						</p>
						<Sources sources={RAG_SOURCES} activeId={activeId} onSourceClick={(id) => setActiveId(id)} />
					</Prose>
					<MessageActions
						visible
						items={[
							{ label: "查看制度原文 →", key: true },
							{ label: "导出对比" },
							{ label: "复制" }
						]}
					/>
				</AssistantResponse>
			</div>
		</section>
	);
}
