/** Fixed UTC+08:00 calendar used by the admin Session and Usage pages. */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
export function beijingDate(value: Date): Date {
	return new Date(value.getTime() + BEIJING_OFFSET_MS);
}
export function beijingDay(value: Date): string {
	return Number.isNaN(value.getTime()) ? "" : beijingDate(value).toISOString().slice(0, 10);
}
export function beijingBoundary(day: string, endOfDay = false): string | undefined {
	if (!day) return undefined;
	const value = new Date(`${day}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+08:00`);
	return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
}
export function formatBeijing(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? value
		: date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}
