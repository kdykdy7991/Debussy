/**
 * TASK-035：bounded metrics registry 单测（spec 15.1）。
 *
 * 覆盖：counter/gauge/histogram 基本计数与 exposure；**禁止继续项**——身份
 * 高基数标签（conversationId/principalId 等）在注册时抛错；未知标签（不在
 * 允许集）抛错；重名抛错；`maxCardinality` 上限（超限折叠进有界的 overflow
 * 系列而非无界增长）；Invalid name 抛错；reset 清空。
 */
import { describe, expect, test } from "vitest";
import { createMetricRegistry, FORBIDDEN_METRIC_LABELS } from "../src/metrics/index.ts";

describe("metrics registry", () => {
	test("counter and gauge record scalar + labeled values and expose text", () => {
		const reg = createMetricRegistry();
		const turns = reg.counter({ name: "embed_turn_total", help: "turn count", labels: ["status"] });
		const conns = reg.gauge({ name: "embed_connections", help: "open connections" });
		turns.inc({ status: "completed" });
		turns.inc({ status: "completed" });
		turns.inc({ status: "failed" });
		conns.set(3);
		conns.set(5);
		const text = reg.text();
		expect(text).toContain('embed_turn_total{status="completed"} 2');
		expect(text).toContain('embed_turn_total{status="failed"} 1');
		expect(text).toContain("embed_connections 5");
	});

	test("histogram is cumulative across buckets and records sum/count", () => {
		const reg = createMetricRegistry();
		const latency = reg.histogram({
			name: "embed_turn_latency",
			help: "turn latency ms",
			buckets: [50, 100, 250],
		});
		latency.observe(30);
		latency.observe(120);
		const text = reg.text();
		expect(text).toContain('embed_turn_latency_bucket{le="50"} 1');
		expect(text).toContain('embed_turn_latency_bucket{le="100"} 1');
		expect(text).toContain('embed_turn_latency_bucket{le="250"} 2');
		expect(text).toContain('embed_turn_latency_bucket{le="+Inf"} 2');
		expect(text).toContain("embed_turn_latency_sum 150");
		expect(text).toContain("embed_turn_latency_count 2");
	});

	test("forbidden high-cardinality identity labels are rejected at registration", () => {
		const reg = createMetricRegistry();
		for (const label of [...FORBIDDEN_METRIC_LABELS]) {
			expect(() => reg.counter({ name: "m", help: "h", labels: [label] })).toThrow(/forbidden high-cardinality/);
		}
	});

	test("a label outside the metric's allowed set is rejected on inc", () => {
		const reg = createMetricRegistry();
		const m = reg.counter({ name: "m", help: "h", labels: ["status"] });
		expect(() => m.inc({ region: "eu" })).toThrow(/does not accept label/);
	});

	test("duplicate metric name throws", () => {
		const reg = createMetricRegistry();
		reg.counter({ name: "m", help: "h" });
		expect(() => reg.counter({ name: "m", help: "h" })).toThrow(/already registered/);
	});

	test("cardinality cap folds excess label-sets into a bounded overflow series", () => {
		const reg = createMetricRegistry();
		const m = reg.counter({ name: "m", help: "h", labels: ["app"], maxCardinality: 2 });
		m.inc({ app: "a" });
		m.inc({ app: "b" });
		m.inc({ app: "a" });
		m.inc({ app: "c" }); // over cap -> overflow
		m.inc({ app: "d" }); // over cap -> overflow
		const text = reg.text();
		expect(text).toContain('m{app="a"} 2');
		expect(text).toContain('m{app="b"} 1');
		expect(text).toContain('m{overflow="true"} 2');
		// 有界：snapshot 系列数有限（2 个容量 + 1 个 overflow，无 c/d）。
		const snap = reg.snapshot()[0];
		expect(snap.series).toHaveLength(3);
	});

	test("invalid metric name throws; reset clears all metrics", () => {
		const reg = createMetricRegistry();
		expect(() => reg.counter({ name: "9bad", help: "h" })).toThrow(/invalid metric name/);
		reg.counter({ name: "m", help: "h" });
		reg.reset();
		expect(() => reg.counter({ name: "m", help: "h" })).not.toThrow();
	});
});
