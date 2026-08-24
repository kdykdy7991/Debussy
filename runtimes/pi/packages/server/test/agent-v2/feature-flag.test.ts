import { describe, expect, test } from "vitest";
import { AGENT_V2_METRICS_ENV, agentV2MetricsEnabled } from "../../src/agent-v2/feature-flag.ts";

describe("agentV2MetricsEnabled (PI_AGENT_V2_METRICS, default off)", () => {
	test("defaults to off when the env var is absent", () => {
		expect(AGENT_V2_METRICS_ENV).toBe("PI_AGENT_V2_METRICS");
		expect(agentV2MetricsEnabled({})).toBe(false);
	});

	test("enables on 1 / true (trim+lowercase)", () => {
		expect(agentV2MetricsEnabled({ PI_AGENT_V2_METRICS: "1" })).toBe(true);
		expect(agentV2MetricsEnabled({ PI_AGENT_V2_METRICS: "true" })).toBe(true);
		expect(agentV2MetricsEnabled({ PI_AGENT_V2_METRICS: " TRUE " })).toBe(true);
	});

	test("stays off on any other value", () => {
		expect(agentV2MetricsEnabled({ PI_AGENT_V2_METRICS: "0" })).toBe(false);
		expect(agentV2MetricsEnabled({ PI_AGENT_V2_METRICS: "false" })).toBe(false);
		expect(agentV2MetricsEnabled({ PI_AGENT_V2_METRICS: "yes" })).toBe(false);
	});
});
