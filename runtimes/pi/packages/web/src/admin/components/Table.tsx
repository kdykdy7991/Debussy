/**
 * 控制台通用 Table（设计收口 / MVP-15）。
 *
 * 用法：
 *   <Table
 *     columns={[
 *       { key: "name", header: "名称", render: (row) => row.name, width: 220 },
 *       ...
 *     ]}
 *     rows={data}
 *     rowKey={(row) => row.id}
 *     onRowClick={(row) => navigate(...)}
 *   />
 *
 * 视觉：白底圆角细边，表头浅色背景 + 大写字距，行 hover 暖色，行可点击态。
 * 支持空状态/loading/error 态（renderEmpty 回调）。
 */
import type { ReactNode } from "react";
import styles from "./Table.module.css";

export interface TableColumn<T> {
	readonly key: string;
	readonly header: ReactNode;
	readonly render: (row: T) => ReactNode;
	readonly width?: number | string;
	/** className applied to <td>，用于单格特殊样式（如 numeric、mono）。 */
	readonly cellClassName?: string;
	readonly align?: "left" | "right" | "center";
	/** 表头 className。 */
	readonly headerClassName?: string;
}

export interface TableProps<T> {
	readonly columns: readonly TableColumn<T>[];
	readonly rows: readonly T[];
	readonly rowKey: (row: T) => string;
	readonly onRowClick?: (row: T) => void;
	/** 把整行变成可点击的链接。 */
	readonly rowHref?: (row: T) => string;
	readonly renderEmpty?: () => ReactNode;
	readonly emptyTitle?: string;
	readonly emptyDescription?: ReactNode;
	readonly className?: string;
}

export function Table<T>({
	columns,
	rows,
	rowKey,
	onRowClick,
	rowHref,
	renderEmpty,
	emptyTitle = "没有匹配的数据",
	emptyDescription = "尝试调整搜索或筛选条件。",
	className,
}: TableProps<T>): React.ReactElement {
	return (
		<div className={`${styles.wrapper} ${className ?? ""}`}>
			<table className={styles.table}>
				<thead>
					<tr>
						{columns.map((col) => (
							<th
								key={col.key}
								style={col.width !== undefined ? { width: col.width } : undefined}
								className={`${col.headerClassName ?? ""} ${
									col.align === "right"
										? styles.alignRight
										: col.align === "center"
											? styles.alignCenter
											: ""
								}`}
							>
								{col.header}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.length === 0 ? (
						<tr>
							<td colSpan={columns.length} className={styles.emptyCell}>
								{renderEmpty ? (
									renderEmpty()
								) : (
									<div className={styles.empty}>
										<h3 className={styles.emptyTitle}>{emptyTitle}</h3>
										<p className={styles.emptyDescription}>{emptyDescription}</p>
									</div>
								)}
							</td>
						</tr>
					) : (
						rows.map((row) => {
							const clickable = onRowClick !== undefined || rowHref !== undefined;
							return (
								<tr
									key={rowKey(row)}
									className={clickable ? styles.rowClickable : ""}
									onClick={onRowClick ? () => onRowClick(row) : undefined}
								>
									{columns.map((col) => (
										<td
											key={col.key}
											className={`${col.cellClassName ?? ""} ${
												col.align === "right"
													? styles.alignRight
													: col.align === "center"
														? styles.alignCenter
														: ""
											}`}
										>
											{col.render(row)}
										</td>
									))}
								</tr>
							);
						})
					)}
				</tbody>
			</table>
		</div>
	);
}
