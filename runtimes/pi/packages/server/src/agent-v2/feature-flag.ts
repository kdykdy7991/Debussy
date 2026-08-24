/**
 * Agent 平台 V2 M1：Metrics/Context 特性开关。
 *
 * 控制面见 ADR D4（`PI_*` 前缀、默认关闭）。`PI_AGENT_V2_METRICS` 关闭时行为与现在
 * 完全一致（不采集、不写 `turn/end.metrics`、不跑 metrics/context 查询）。取值：
 * `"1"` 或 `"true"`（trim 后小写）开，其余/缺省关。
 */
export const AGENT_V2_METRICS_ENV = "PI_AGENT_V2_METRICS" as const;

export function agentV2MetricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[AGENT_V2_METRICS_ENV];
	if (raw === undefined) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
}
