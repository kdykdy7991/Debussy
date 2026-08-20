/** 条件 class 拼接。 */
export function cx(...parts: Array<string | false | null | undefined>): string {
	return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}

/**
 * 时长格式化（semantic meta 用）：
 * <1000ms → "840ms"；<60s → "4.2s"；否则 → "2m 14s"。
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) {
		const s = seconds.toFixed(1).replace(/\.0$/, "");
		return `${s}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m ${rest}s`;
}

/** 数字加千分位（semantic meta 用，如 "48,221"）。 */
export function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}
