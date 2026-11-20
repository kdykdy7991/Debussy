import { useEffect, useMemo, useState } from "react";
import { AaasKeysApi } from "../api/aaas-keys-api.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { AuroraPageHeader } from "../aurora/PageHeader.tsx";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";
import styles from "./orchestration-page.module.css";
import { displayTime, errorMessage } from "./orchestration-ui.ts";
import { routerStateLabel, usageLabel } from "./router-execution-detail.tsx";

type ExecutionRow = {
	id: string;
	task_id: string;
	operation_sequence: string;
	status: string;
	created_at: string;
	key_id: string;
	key_name: string;
};
type ExecutionPage = {
	items: readonly ExecutionRow[];
	next_cursor: string | null;
	usage?: { known_totals: { total_tokens?: number }; complete: boolean; unknown_operations: number };
};
export function AdminRouterExecutionsPage({ keyId }: { keyId?: string }): React.JSX.Element {
	const { controller, snapshot } = useAdminAuth();
	const api = useMemo(() => new AaasKeysApi(controller), [controller]);
	const [draft, setDraft] = useState("");
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState("");
	const [cursor, setCursor] = useState<string | null>(null);
	const [page, setPage] = useState<ExecutionPage | null>(null);
	const [revision, setRevision] = useState(0);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: revision refreshes or retries identical filters.
	useEffect(() => {
		if (snapshot.state !== "connected") return;
		const abort = new AbortController();
		const params = new URLSearchParams();
		if (keyId) params.set("key_id", keyId);
		if (query) params.set("q", query);
		if (status) params.set("status", status);
		if (cursor) params.set("after", cursor);
		setBusy(true);
		setError("");
		void api.request<ExecutionPage>(`/router-executions?${params}`, "GET", undefined, abort.signal).then(
			(data) => {
				if (abort.signal.aborted) return;
				setPage((previous) => (cursor && previous ? { ...data, items: [...previous.items, ...data.items] } : data));
				setBusy(false);
			},
			(cause: unknown) => {
				if (abort.signal.aborted) return;
				setError(errorMessage(cause));
				setBusy(false);
			},
		);
		return () => abort.abort();
	}, [api, cursor, keyId, query, revision, snapshot.state, status]);

	function refresh() {
		setCursor(null);
		setPage(null);
		setRevision((value) => value + 1);
	}

	return (
		<section className={styles.page} aria-label="Router 执行记录">
			<AuroraPageHeader
				title="执行记录"
				meta="Router Task / Operation"
				actions={
					<AuroraButton disabled={busy} onClick={refresh}>
						刷新
					</AuroraButton>
				}
			/>
			{keyId && (
				<div className={styles.toolbar}>
					<span>
						Key <code>{keyId}</code>
					</span>
					{page?.usage && (
						<span>
							累计用量 {usageLabel(page.usage.known_totals.total_tokens, page.usage.complete)} ·{" "}
							{page.usage.unknown_operations} 项用量未完整上报
						</span>
					)}
					<AuroraButton onClick={() => navigate("/conversations/router")}>查看全部 Key</AuroraButton>
				</div>
			)}
			<section className={styles.panel}>
				<form
					className={styles.toolbar}
					onSubmit={(event) => {
						event.preventDefault();
						setQuery(draft.trim());
						refresh();
					}}
				>
					<label className={styles.search}>
						<span>搜索</span>
						<input
							aria-label="搜索 Router 执行"
							placeholder="Task ID、Operation ID 或 Key"
							maxLength={200}
							value={draft}
							onChange={(event) => setDraft(event.currentTarget.value)}
						/>
					</label>
					<AuroraButton type="submit">查询</AuroraButton>
					<select
						aria-label="操作状态"
						value={status}
						onChange={(event) => {
							setStatus(event.currentTarget.value);
							refresh();
						}}
					>
						<option value="">全部状态</option>
						{["queued", "running", "completed", "failed", "canceled"].map((value) => (
							<option key={value} value={value}>
								{routerStateLabel[value]}
							</option>
						))}
					</select>
				</form>
				{error && (
					<p className={styles.error} role="alert">
						{error}{" "}
						<AuroraButton size="sm" onClick={() => setRevision((value) => value + 1)}>
							重试
						</AuroraButton>
					</p>
				)}
				{busy && <output>正在查询 Router 执行记录…</output>}
				{page &&
					(page.items.length === 0 ? (
						<p className={styles.empty}>没有匹配的执行记录。</p>
					) : (
						<div className={styles.tableScroll}>
							<table className={styles.table}>
								<thead>
									<tr>
										<th>Task</th>
										<th>Operation</th>
										<th>API Key</th>
										<th>状态</th>
										<th>受理时间</th>
										<th>操作</th>
									</tr>
								</thead>
								<tbody>
									{page.items.map((row) => (
										<tr key={row.id}>
											<td>
												<code title={row.task_id}>{row.task_id.slice(0, 8)}</code>
											</td>
											<td>
												<code title={row.id}>{row.id.slice(0, 8)}</code> · 第 {row.operation_sequence} 次
											</td>
											<td title={row.key_id}>{row.key_name}</td>
											<td>{routerStateLabel[row.status]}</td>
											<td>{displayTime(row.created_at)}</td>
											<td>
												<a href={`#/conversations/router/${row.key_id}/${row.task_id}/${row.id}`}>
													查看详情
												</a>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					))}
				{page?.next_cursor && (
					<footer className={styles.listFooter}>
						<AuroraButton disabled={busy} onClick={() => setCursor(page.next_cursor)}>
							加载更多
						</AuroraButton>
					</footer>
				)}
			</section>
		</section>
	);
}
