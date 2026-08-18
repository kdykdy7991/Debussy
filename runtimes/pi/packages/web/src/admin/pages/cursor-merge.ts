/**
 * Cursor 分页合并工具（MVP-05）。
 *
 * 将「下一页」追加到「已加载列表」，按业务主键去重，避免 cursor 翻页
 * 时服务器边界重复返回同一条记录。纯函数，便于单测。
 */
export interface HasId {
	readonly id: string;
}

export function appendUnique<T extends HasId>(existing: readonly T[], next: readonly T[]): readonly T[] {
	const seen = new Set(existing.map((item) => item.id));
	const uniqueNew = next.filter((item) => !seen.has(item.id));
	return [...existing, ...uniqueNew];
}
