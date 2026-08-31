/**
 * Cursor-paginated replay of conversation events (Phase-1).
 *
 * Replaces the previous single-call `list({ limit: 10_000 })` which the
 * repository silently clamped to 500 rows (see ConversationEventRepository.list),
 * so a Summary-following window larger than one page was truncated without
 * notice. Here we page with the repository's own cursor (`afterSequence`) until
 * the stream is exhausted, preserving strict sequence order.
 *
 * The page function returns rows ascending by `sequence`; a short page (< full
 * page size) signals the end. A defensive page cap prevents an unbounded loop
 * from a malformed source without silently dropping data under normal input.
 */
export interface ReplayPage<T extends { readonly sequence: number }> {
	(afterSequence: number, limit: number): Promise<readonly T[]>;
}

/** Full page size the underlying repositories return at most. */
export const REPLAY_PAGE_SIZE = 500;

/** Defensive ceiling (pages) so a pathological source never loops forever. 500k events is far beyond any live conversation. */
const MAX_REPLAY_PAGES = 1000;

export async function replayAllAfter<T extends { readonly sequence: number }>(
	page: ReplayPage<T>,
	afterSequence: number,
): Promise<readonly T[]> {
	const out: T[] = [];
	let cursor = afterSequence;
	let pages = 0;
	for (; ;) {
		const rows = await page(cursor, REPLAY_PAGE_SIZE);
		out.push(...rows);
		if (rows.length < REPLAY_PAGE_SIZE) break;
		cursor = rows[rows.length - 1].sequence;
		pages += 1;
		if (pages >= MAX_REPLAY_PAGES) break;
	}
	return out;
}