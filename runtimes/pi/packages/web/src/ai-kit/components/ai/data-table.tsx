import type { ReactNode } from "react";
import { cx } from "../../lib/utils";
import { CaptionBar } from "../ui/caption-bar";

export type DataTableColumn = {
	key: string;
	label: string;
	/** 数字列：右对齐 + mono（UI_RULES §19）。 */
	numeric?: boolean;
};

/** 单元格：ReactNode，或带语义 tone 的对象（positive/negative 走主题语义色）。 */
export type TableCellValue = ReactNode | { value: ReactNode; tone?: "positive" | "negative" | "neutral" };

export type DataTableProps = {
	/** caption 左槽（必填：没有 caption 的容器不允许存在）。 */
	caption: string;
	/** caption 右槽：数据源（如 "q3_orders.csv"）。 */
	source?: string;
	columns: readonly DataTableColumn[];
	rows: readonly Record<string, TableCellValue>[];
};

type CellTone = "positive" | "negative" | "neutral";
type NormalizedCell = { value: ReactNode; tone?: CellTone };

function normalizeCell(cell: TableCellValue | undefined): NormalizedCell {
	if (cell != null && typeof cell === "object" && !Array.isArray(cell) && "value" in (cell as object)) {
		return cell as NormalizedCell;
	}
	return { value: (cell as ReactNode) ?? null };
}

/**
 * 数据表：caption（名+源）+ 右对齐 mono 数字列 + 行分隔线（无竖线、无 zebra）。
 * 见 COMPONENT_PATTERNS.md §5。
 */
export function DataTable({ caption, source, columns, rows }: DataTableProps) {
	return (
		<div className="ai-table-wrap">
			<CaptionBar title={caption} trailing={source} />
			<table>
				<thead>
					<tr>
						{columns.map((col) => (
							<th key={col.key} className={cx(col.numeric && "is-numeric")}>
								{col.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixture rows carry no stable unique key.
						<tr key={i}>
							{columns.map((col) => {
								const cell = normalizeCell(row[col.key]);
								return (
									<td
										key={col.key}
										className={cx(col.numeric && "is-numeric", cell.tone && `tone-${cell.tone}`)}
									>
										{cell.value}
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
