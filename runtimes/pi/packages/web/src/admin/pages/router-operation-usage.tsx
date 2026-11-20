import { useCallback, useEffect, useState } from "react";
import type { AaasKeysApi } from "../api/aaas-keys-api.ts";
import { Table, type TableColumn } from "../components/Table.tsx";
import { createStaleResponseGuard } from "../data-state.ts";
import styles from "../user-conversations/usage-view.module.css";
import { errorMessage } from "./orchestration-ui.ts";

interface ModelCall {
	id: string;
	name: string;
	call_index: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	total_tokens: number | null;
}

type Page = { entries: readonly ModelCall[]; next_cursor: string | null };

const tokenColumns = [
	["input_tokens", "非缓存输入"],
	["cache_read_tokens", "缓存读取"],
	["cache_write_tokens", "已记录缓存写入"],
	["output_tokens", "输出"],
	["total_tokens", "总 Token"],
] as const;
const columns: readonly TableColumn<ModelCall>[] = [
	{ key: "call", header: "调用", render: (row) => (row.call_index == null ? "—" : `#${row.call_index}`) },
	{ key: "model", header: "模型", render: (row) => row.name },
	...tokenColumns.map(
		([key, header]): TableColumn<ModelCall> => ({
			key,
			header,
			align: "right",
			render: (row) => row[key]?.toLocaleString() ?? "—",
		}),
	),
];

export function RouterOperationUsage({ api, path }: { api: AaasKeysApi; path: string }): React.JSX.Element {
	const [guard] = useState(createStaleResponseGuard);
	const [page, setPage] = useState<Page>({ entries: [], next_cursor: null });
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const load = useCallback(
		(after: string | null) => {
			const ticket = guard.begin();
			setLoading(true);
			setError("");
			const query = new URLSearchParams({ kind: "model" });
			if (after !== null) query.set("after", after);
			void api.request<Page>(`${path}?${query}`, "GET", undefined, ticket.signal).then(
				(next) =>
					ticket.commit(() => {
						setPage((previous) => ({
							...next,
							entries: after === null ? next.entries : [...previous.entries, ...next.entries],
						}));
						setLoading(false);
					}),
				(cause: unknown) =>
					ticket.commit(() => {
						setError(errorMessage(cause));
						setLoading(false);
					}),
			);
		},
		[api, guard, path],
	);

	useEffect(() => {
		load(null);
		return () => guard.cancel();
	}, [guard, load]);

	return (
		<section className={styles.tablePanel} aria-label="逐次 LLM 调用">
			<div className={styles.tableTop}>
				<h2>逐次 LLM 调用</h2>
			</div>
			{error && (
				<p role="alert">
					{error}{" "}
					<button type="button" onClick={() => load(page.next_cursor)}>
						重试
					</button>
				</p>
			)}
			{(page.entries.length > 0 || (!loading && !error)) && (
				<Table
					columns={columns}
					rows={page.entries}
					rowKey={(row) => row.id}
					emptyTitle="暂无调用记录"
					emptyDescription="本轮未保存逐次 LLM 调用。"
				/>
			)}
			{loading && <output>正在读取调用用量…</output>}
			{page.next_cursor && !error && (
				<button type="button" disabled={loading} onClick={() => load(page.next_cursor)}>
					加载更多调用
				</button>
			)}
		</section>
	);
}
