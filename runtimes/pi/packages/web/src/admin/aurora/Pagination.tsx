/**
 * Aurora Pagination — 列表页底部分页控件，对齐设计稿 .toolbar 末段。
 *
 * 视觉：左‹右›方按钮 + 第 N/M 页 + 每页大小选择器；用 aurora token。
 *
 * 与 admin/components/Pagination 并存（旧表格风格）；新页面用本组件。
 */
import styles from "./Pagination.module.css";

export interface AuroraPaginationProps {
	readonly page: number;
	readonly totalPages: number;
	readonly pageSize: number;
	readonly pageSizeOptions?: readonly number[];
	readonly onPageChange: (p: number) => void;
	readonly onPageSizeChange: (size: number) => void;
}

export function AuroraPagination({
	page,
	totalPages,
	pageSize,
	pageSizeOptions = [6, 9, 12, 24],
	onPageChange,
	onPageSizeChange,
}: AuroraPaginationProps): React.ReactElement {
	const canPrev = page > 1;
	const canNext = page < totalPages;
	return (
		<div className={styles.pagination}>
			<button
				type="button"
				className={styles.pageBtn}
				disabled={!canPrev}
				onClick={() => onPageChange(page - 1)}
				aria-label="上一页"
			>
				‹
			</button>
			<span className={styles.pageInfo}>
				第 <strong>{page}</strong> / {totalPages} 页
			</span>
			<button
				type="button"
				className={styles.pageBtn}
				disabled={!canNext}
				onClick={() => onPageChange(page + 1)}
				aria-label="下一页"
			>
				›
			</button>
			<label className={styles.sizeBox}>
				每页
				<select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
					{pageSizeOptions.map((n) => (
						<option key={n} value={n}>
							{n}
						</option>
					))}
				</select>
				条
			</label>
		</div>
	);
}
