import type { AdminUsageSummary } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { UsageApi } from "../api/usage-api.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { AuroraPageHeader } from "../aurora/PageHeader.tsx";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import styles from "./usage-page.module.css";

type UsageState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly summary: AdminUsageSummary }
	| { readonly kind: "error"; readonly message: string };

const NUMBER = new Intl.NumberFormat("zh-CN");

export function AdminUsagePage(): React.ReactElement {
	const { controller } = useAdminAuth();
	const apiRef = useRef<UsageApi | null>(null);
	if (apiRef.current === null) apiRef.current = new UsageApi({ auth: controller });
	const api = apiRef.current;
	const [days, setDays] = useState(7);
	const [state, setState] = useState<UsageState>({ kind: "loading" });

	const load = useCallback(() => {
		const to = new Date();
		const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
		setState({ kind: "loading" });
		void api.getSummary({ from, to }).then(
			(summary) => setState({ kind: "loaded", summary }),
			(error: Error) => setState({ kind: "error", message: error.message }),
		);
	}, [api, days]);

	useEffect(() => {
		load();
	}, [load]);

	return (
		<section className={styles.page} aria-labelledby="usage-title">
			<AuroraPageHeader
				title="Usage"
				titleId="usage-title"
				actions={
					<label className={styles.rangeControl}>
						<span>统计周期</span>
						<select value={days} onChange={(event) => setDays(Number(event.target.value))}>
							<option value={7}>最近 7 天</option>
							<option value={30}>最近 30 天</option>
							<option value={90}>最近 90 天</option>
						</select>
					</label>
				}
			/>

			{state.kind === "loading" && <output className={styles.state}>正在汇总 Token 用量…</output>}
			{state.kind === "error" && (
				<div className={styles.error} role="alert">
					<div>
						<strong>无法加载 Usage</strong>
						<p>请确认管理服务已升级并可访问 Usage 聚合接口。</p>
						<code>{state.message}</code>
					</div>
					<AuroraButton size="sm" onClick={load}>
						重试
					</AuroraButton>
				</div>
			)}
			{state.kind === "loaded" && <UsageContent summary={state.summary} />}
		</section>
	);
}

function UsageContent({ summary }: { readonly summary: AdminUsageSummary }): React.ReactElement {
	const totals = summary.totals;
	return (
		<>
			<section className={styles.summary} aria-label="Token 用量汇总">
				<UsageMetric label="总 Token" value={totals.totalTokens} />
				<UsageMetric label="输入 Token" value={totals.inputTokens} />
				<UsageMetric label="输出 Token" value={totals.outputTokens} />
				<UsageMetric label="模型请求" value={totals.requestCount} />
			</section>

			<section className={styles.agentSection} aria-labelledby="usage-agent-title">
				<div className={styles.sectionHeader}>
					<div>
						<h2 id="usage-agent-title">按 Agent</h2>
						<p>按总 Token 从高到低排列；当前已接入发布后的 Embed 会话。</p>
					</div>
					<time dateTime={summary.generatedAt}>更新于 {formatTime(summary.generatedAt)}</time>
				</div>
				{summary.byAgent.length === 0 ? (
					<div className={styles.empty}>该周期内还没有带 Provider Usage 的已完成请求。</div>
				) : (
					<div className={styles.tableWrap}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th>Agent</th>
									<th>来源</th>
									<th>总 Token</th>
									<th>输入</th>
									<th>输出</th>
									<th>缓存读取</th>
									<th>请求数</th>
								</tr>
							</thead>
							<tbody>
								{summary.byAgent.map((row) => (
									<tr key={`${row.agentId}:${row.source}`}>
										<td>
											<strong>{row.agentName}</strong>
											<code>{row.agentId}</code>
										</td>
										<td>{row.source === "embed" ? "发布 Web" : "管理员 Chat"}</td>
										<td>{NUMBER.format(row.totalTokens)}</td>
										<td>{NUMBER.format(row.inputTokens)}</td>
										<td>{NUMBER.format(row.outputTokens)}</td>
										<td>{NUMBER.format(row.cacheReadTokens)}</td>
										<td>{NUMBER.format(row.requestCount)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</>
	);
}

function UsageMetric({ label, value }: { readonly label: string; readonly value: number }): React.ReactElement {
	return (
		<div className={styles.metric}>
			<span>{label}</span>
			<strong>{NUMBER.format(value)}</strong>
		</div>
	);
}

function formatTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date);
}
