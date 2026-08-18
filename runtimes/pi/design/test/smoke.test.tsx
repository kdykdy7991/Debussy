import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	AgentTrace,
	AgentTraceEvent,
	AssistantResponse,
	AssistantSignature,
	ChartContainer,
	Composer,
	DataTable,
	ReportArtifact,
	Sources,
	UserMessage,
	MessageActions,
	formatDuration
} from "../src";
import { AnalysisScene } from "../demo/scenes/analysis-scene";
import { ArtifactScene } from "../demo/scenes/artifact-scene";
import { ComposerScene } from "../demo/scenes/composer-scene";
import { ConversationScene } from "../demo/scenes/conversation-scene";
import { RagScene } from "../demo/scenes/rag-scene";
import { RunningScene } from "../demo/scenes/running-scene";
import { TraceScenes } from "../demo/scenes/trace-scenes";

describe("AI UI Kit 冒烟（renderToString，无 CSS）", () => {
	it("UserMessage：右对齐 bubble + attachment chip", () => {
		const html = renderToString(
			<UserMessage attachments={["a.csv", "b.xlsx"]}>问题文本</UserMessage>
		);
		expect(html).toContain("ai-user-bubble");
		expect(html).toContain("a.csv · b.xlsx");
		expect(html).toContain("问题文本");
	});

	it("UserMessage plain 变体", () => {
		const html = renderToString(<UserMessage variant="plain">下午好</UserMessage>);
		expect(html).toContain("is-plain");
	});

	it("AssistantSignature：三态语义", () => {
		const plain = renderToString(<AssistantSignature status="plain" name="Nocturne" model="GLM-5" />);
		expect(plain).toContain("Nocturne · GLM-5");
		expect(plain).not.toContain("ai-dot");

		const running = renderToString(
			<AssistantSignature status="running" name="Nocturne" model="GLM-5" runningMeta="深度思考 4.2s" />
		);
		expect(running).toContain("is-active");
		expect(running).toContain("深度思考 4.2s");

		const done = renderToString(
			<AssistantSignature status="completed" summary="8 步 · 2m 14s" />
		);
		expect(done).toContain("is-done");
		expect(done).toContain("Agent 运行完成");
		expect(done).toContain("8 步 · 2m 14s");
	});

	it("AgentTrace：summary 上限 + 披露链接", () => {
		const events = Array.from({ length: 8 }, (_, i) => (
			<AgentTraceEvent key={`e${i}`} status="completed" title={`步骤 ${i + 1}`} />
		));
		const html = renderToString(<AgentTrace status="completed">{events}</AgentTrace>);
		expect(html).toContain("查看 3 次调用的完整轨迹 →");
	});

	it("AgentTrace compact：一行摘要", () => {
		const html = renderToString(
			<AgentTrace status="completed" compact durationMs={134000}>
				{Array.from({ length: 8 }, (_, i) => (
					<AgentTraceEvent key={`e${i}`} status="completed" title={`步骤 ${i + 1}`} />
				))}
			</AgentTrace>
		);
		expect(html).toMatch(/运行轨迹<!-- --> · <!-- -->8<!-- --> 步<!-- --> · 2m 14s/);
	});

	it("AgentTraceEvent：四态 class + payload 披露", () => {
		const pending = renderToString(<AgentTraceEvent status="pending" title="等待" />);
		expect(pending).toContain("is-pending");
		const running = renderToString(<AgentTraceEvent status="running" title="执行中" />);
		expect(running).toContain("is-running");
		const failed = renderToString(
			<AgentTraceEvent status="failed" title="失败" detail="超时" />
		);
		expect(failed).toContain("is-failed");
		const withPayload = renderToString(
			<AgentTraceEvent status="completed" title="检索" payload='{"rows":3}' />
		);
		expect(withPayload).toContain("查看原始事件");
	});

	it("AssistantResponse：no-rail / rail 两种布局", () => {
		const noRail = renderToString(<AssistantResponse><span>content</span></AssistantResponse>);
		expect(noRail).toContain("no-rail");
		const withRail = renderToString(
			<AssistantResponse
				rail={
					<AgentTrace status="completed">
						<AgentTraceEvent status="completed" title="步骤 1" />
					</AgentTrace>
				}
			>
				<span>content</span>
			</AssistantResponse>
		);
		expect(withRail).toContain("ai-rail");
		expect(withRail).not.toContain("no-rail");
	});

	it("DataTable：caption + 数字列 class + tone", () => {
		const html = renderToString(
			<DataTable
				caption="Q3 增长分项"
				source="q3_orders.csv"
				columns={[
					{ key: "name", label: "分项" },
					{ key: "yoy", label: "同比", numeric: true }
				]}
				rows={[
					{ name: "老客复购", yoy: { value: "+9.6 pt", tone: "positive" } },
					{ name: "新客首单", yoy: { value: "−4.3 pt", tone: "negative" } }
				]}
			/>
		);
		expect(html).toContain("ai-table-wrap");
		expect(html).toContain("is-numeric");
		expect(html).toContain("tone-positive");
		expect(html).toContain("tone-negative");
	});

	it("ChartContainer：caption + data-v + 高亮柱", () => {
		const html = renderToString(
			<ChartContainer caption="月度 GMV 走势" unit="百万元" bars={[{ value: 38.1 }, { value: 72.4, highlight: true }]} xLabels={["4月", "9月"]} />
		);
		expect(html).toContain("ai-chart");
		expect(html).toContain('data-v="72.4"');
		expect(html).toContain("is-highlight");
		expect(html).toContain("百万元");
	});

	it("Sources：label + 索引 + 徽章", () => {
		const html = renderToString(
			<Sources
				sources={[
					{ id: 1, title: "复盘文档", meta: "增长运营组 · 24 页", type: "知识库" },
					{ id: 2, title: "外部对标", meta: "行业基准", type: "外部", external: true }
				]}
			/>
		);
		expect(html).toMatch(/来源 · <!-- -->2/);
		expect(html).toContain("tone-neutral");
		expect(html).toContain("tone-accent");
	});

	it("ReportArtifact：eyebrow/title/meta/status/风险章", () => {
		const html = renderToString(
			<ReportArtifact
				eyebrow="管理纪要 · 草稿"
				title="2025 Q3 增长复盘纪要"
				meta="数字校验 14 / 14"
				status="待审阅"
				sections={[
					{ index: 1, name: "季度概览", headline: "GMV +18.4%" },
					{ index: 4, name: "风险与预警", headline: "3 项", risk: true }
				]}
			/>
		);
		expect(html).toContain("ai-artifact");
		expect(html).toContain("管理纪要 · 草稿");
		expect(html).toContain("待审阅");
		expect(html).toContain("is-risk");
	});

	it("MessageActions：visible 控制 actions-enter class", () => {
		const hidden = renderToString(<MessageActions items={[{ label: "复制" }]} visible={false} />);
		expect(hidden).not.toContain("is-visible");
		const shown = renderToString(<MessageActions items={[{ label: "复制", key: true }]} />);
		expect(shown).toContain("is-visible");
		expect(shown).toContain("is-key");
	});

	it("Composer：send / stop / 键盘提示", () => {
		const idle = renderToString(<Composer onSubmit={() => {}} />);
		expect(idle).toContain("发送 ⏎");
		const streaming = renderToString(<Composer onSubmit={() => {}} streaming onStop={() => {}} />);
		expect(streaming).toContain("停止 ■");
		expect(streaming).toContain("is-stop");
		expect(idle).toContain("唤起工具与知识源");
	});

	it("formatDuration", () => {
		expect(formatDuration(840)).toBe("840ms");
		expect(formatDuration(4200)).toBe("4.2s");
		expect(formatDuration(134000)).toBe("2m 14s");
	});

	it("8 个 demo 场景均可渲染（无运行时报错）", () => {
		for (const Scene of [ConversationScene, RunningScene, TraceScenes, RagScene, AnalysisScene, ArtifactScene, ComposerScene]) {
			const html = renderToString(<Scene />);
			expect(html.length).toBeGreaterThan(500);
		}
	});
});
