/**
 * Agent List — Aurora 视觉迁移（v2，去掉外层套壳与筛选栏）。
 *
 * v2 简化布局：去掉 v1 的 SideRail + PillTabs 类别筛选 + 外层 canvas
 * 卡片套壳，section 直接铺在 .admin-shell__main 内；PageHeader 仅保留
 * 右上「新建 Agent」操作，下方即紧凑表格 + 分页。
 *
 * 数据只来自 Control API 的 AgentDefinitionSummary。设计页不展示示例、推断
 * 或拼装的数据：当前 API 没有返回的模型、工具、状态、会话数和操作者均不渲染。
 */
import type { AgentDefinitionSummary } from "@earendil-works/pi-protocol";
import { useEffect, useMemo, useState } from "react";
import { AgentApi } from "../api/agent-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";
import styles from "./agent-list-view.module.css";
import { AuroraButton, AuroraPageHeader } from "./index.ts";

type LoadState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly AgentDefinitionSummary[] }
	| { readonly kind: "error"; readonly message: string };

export function AgentListView(): React.ReactElement {
	const { controller } = useAdminAuth();
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(9);
	const [load, setLoad] = useState<LoadState>({ kind: "loading" });

	useEffect(() => {
		let cancelled = false;
		const api = new AgentApi({ auth: controller });
		void api
			.listAgents({ limit: 100 })
			.then((result) => {
				if (!cancelled) setLoad({ kind: "loaded", items: result.items });
			})
			.catch((error: unknown) => {
				if (!cancelled) setLoad({ kind: "error", message: error instanceof Error ? error.message : String(error) });
			});
		return () => {
			cancelled = true;
		};
	}, [controller]);

	const items = load.kind === "loaded" ? load.items : [];
	const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
	const safePage = Math.min(page, totalPages);
	const pagedRows = useMemo(
		() => items.slice((safePage - 1) * pageSize, safePage * pageSize),
		[items, pageSize, safePage],
	);

	return (
		<section className={styles.shell} aria-label="Agent 列表">
			<AuroraPageHeader
				title="Agent 设计"
				description="配置 Agent 能力、保存 Revision，并查看它被哪些发布应用使用。"
			/>

			{load.kind === "loading" ? <div className={styles.empty}>正在加载 Agent…</div> : null}
			{load.kind === "error" ? <div className={styles.empty}>加载 Agent 失败：{load.message}</div> : null}
			{load.kind === "loaded" ? <TableFallback rows={pagedRows} onOpen={(id) => navigate(`/agents/${id}`)} /> : null}

			{load.kind === "loaded" ? (
				<footer className={styles.footer}>
					<div className={styles.totalCount}>
						共 <strong>{items.length}</strong> 个 Agent
					</div>
					<Pagination
						page={safePage}
						totalPages={totalPages}
						pageSize={pageSize}
						onPageChange={setPage}
						onPageSizeChange={(s) => {
							setPageSize(s);
							setPage(1);
						}}
					/>
				</footer>
			) : null}
		</section>
	);
}

// --------------------------------------------------------------------------
// 内部组件：TableFallback / Pagination
// --------------------------------------------------------------------------

interface TableFallbackProps {
	readonly rows: readonly AgentDefinitionSummary[];
	readonly onOpen: (id: string) => void;
}

/**
 * Agent 表格视图：去掉卡片切换后的唯一展示形式。
 * 后续可换成完整的 Aurora Table 组件，本次先保留轻量版。
 */
function TableFallback({ rows, onOpen }: TableFallbackProps): React.ReactElement {
	if (rows.length === 0) {
		return (
			<div className={styles.empty}>
				<div className={styles.emptyTitle}>没有匹配的 Agent</div>
				<div className={styles.emptyDesc}>尝试调整筛选条件。</div>
			</div>
		);
	}
	return (
		<div className={styles.tableWrap}>
			<table className={styles.table}>
				<colgroup>
					<col className={styles.colName} />
					<col className={styles.colModel} />
					<col className={styles.colStatus} />
					<col className={styles.colRevision} />
					<col className={styles.colSessions} />
					<col className={styles.colActions} />
				</colgroup>
				<thead>
					<tr>
						<th>名称</th>
						<th>修订</th>
						<th>创建时间</th>
						<th className={styles.colActions} />
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.id}>
							<td>
								<button type="button" className={styles.tableName} onClick={() => onOpen(row.id)}>
									{row.name}
								</button>
								<div className={styles.tableDesc}>{row.id}</div>
							</td>
							<td>
								<code className={styles.mono}>v{row.revision}</code>
							</td>
							<td className={styles.tabular}>{new Date(row.createdAt).toLocaleString()}</td>
							<td className={styles.colActions}>
								<AuroraButton variant="ghost" size="sm" onClick={() => onOpen(row.id)}>
									打开 →
								</AuroraButton>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

interface PaginationProps {
	readonly page: number;
	readonly totalPages: number;
	readonly pageSize: number;
	readonly onPageChange: (p: number) => void;
	readonly onPageSizeChange: (s: number) => void;
}

function Pagination({
	page,
	totalPages,
	pageSize,
	onPageChange,
	onPageSizeChange,
}: PaginationProps): React.ReactElement {
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
					<option value={6}>6</option>
					<option value={9}>9</option>
					<option value={12}>12</option>
					<option value={24}>24</option>
				</select>
				条
			</label>
		</div>
	);
}
