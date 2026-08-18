/**
 * 控制台通用 Pagination（设计收口 / MVP-15）。
 *
 * 用法：
 *   <Pagination total={128} page={1} pageSize={10}
 *     onPageChange={(p) => setPage(p)}
 *     onPageSizeChange={(s) => setPageSize(s)} />
 *
 * 视觉：底部居中 / 居左，左侧 total，右侧 pageSize + 页码。
 * 页码：首尾固定 + 当前页 + 省略号（首屏最多 5 个可见）。
 */
import styles from "./Pagination.module.css";

export interface PaginationProps {
	readonly total: number;
	readonly page: number;
	readonly pageSize: number;
	readonly onPageChange: (page: number) => void;
	readonly onPageSizeChange?: (pageSize: number) => void;
	readonly pageSizeOptions?: readonly number[];
	readonly showSizeChanger?: boolean;
}

function buildRange(current: number, totalPages: number): Array<number | "ellipsis"> {
	if (totalPages <= 7) {
		return Array.from({ length: totalPages }, (_, i) => i + 1);
	}
	const range: Array<number | "ellipsis"> = [1];
	if (current > 4) range.push("ellipsis");
	const start = Math.max(2, current - 1);
	const end = Math.min(totalPages - 1, current + 1);
	for (let p = start; p <= end; p += 1) range.push(p);
	if (current < totalPages - 3) range.push("ellipsis");
	range.push(totalPages);
	return range;
}

export function Pagination({
	total,
	page,
	pageSize,
	onPageChange,
	onPageSizeChange,
	pageSizeOptions = [10, 20, 50, 100],
	showSizeChanger = true,
}: PaginationProps): React.ReactElement {
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const safePage = Math.min(Math.max(1, page), totalPages);
	const range = buildRange(safePage, totalPages);

	return (
		<nav className={styles.pagination} aria-label="分页">
			<span className={styles.total}>共 {total} 条</span>
			<div className={styles.controls}>
				<button
					type="button"
					className={styles.arrow}
					disabled={safePage <= 1}
					onClick={() => onPageChange(safePage - 1)}
					aria-label="上一页"
				>
					‹
				</button>
				{range.map((item, idx) =>
					item === "ellipsis" ? (
						<span key={`e-${idx}`} className={styles.ellipsis} aria-hidden="true">
							…
						</span>
					) : (
						<button
							key={item}
							type="button"
							className={`${styles.page} ${item === safePage ? styles.pageActive : ""}`}
							aria-current={item === safePage ? "page" : undefined}
							onClick={() => onPageChange(item)}
						>
							{item}
						</button>
					),
				)}
				<button
					type="button"
					className={styles.arrow}
					disabled={safePage >= totalPages}
					onClick={() => onPageChange(safePage + 1)}
					aria-label="下一页"
				>
					›
				</button>
			</div>
			{showSizeChanger && onPageSizeChange ? (
				<label className={styles.sizeChanger}>
					<select
						aria-label="每页条数"
						value={pageSize}
						onChange={(e) => onPageSizeChange(Number.parseInt(e.currentTarget.value, 10))}
					>
						{pageSizeOptions.map((opt) => (
							<option key={opt} value={opt}>
								{opt} 条/页
							</option>
						))}
					</select>
				</label>
			) : null}
		</nav>
	);
}
