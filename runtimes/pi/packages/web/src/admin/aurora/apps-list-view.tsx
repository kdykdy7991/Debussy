import type { PublishedAppSummary } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppApi } from "../api/app-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";
import styles from "./apps-list-view.module.css";
import { AuroraButton, AuroraPageHeader, AuroraPill } from "./index.ts";

type AppStatus = PublishedAppSummary["status"];
type AccessMode = PublishedAppSummary["accessMode"];

type LoadState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly PublishedAppSummary[]; readonly nextCursor: string | null }
	| { readonly kind: "error"; readonly message: string };

const ACCESS_LABEL: Record<AccessMode, string> = {
	anonymous: "匿名访问",
	signed_user: "登录用户",
	mixed: "混合",
};

const STATUS_LABEL: Record<AppStatus, string> = {
	active: "已发布",
	draft: "未发布",
	suspended: "已暂停",
	archived: "已归档",
};

function appStatusBadge(status: AppStatus): React.ReactNode {
	const tone =
		status === "active" ? "live" : status === "draft" ? "amber" : status === "suspended" ? "red" : "neutral";
	return <AuroraPill tone={tone}>{STATUS_LABEL[status]}</AuroraPill>;
}

function formatDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date);
}

export function AppsListView(): React.ReactElement {
	const { controller } = useAdminAuth();
	const apiRef = useRef<AppApi | null>(null);
	if (apiRef.current === null) apiRef.current = new AppApi({ auth: controller });
	const api = apiRef.current;
	const [status, setStatus] = useState<AppStatus | "">("");
	const [cursor, setCursor] = useState<string | undefined>(undefined);
	const [cursorHistory, setCursorHistory] = useState<readonly (string | undefined)[]>([]);
	const [state, setState] = useState<LoadState>({ kind: "loading" });

	const load = useCallback(() => {
		setState({ kind: "loading" });
		void api.listPublishedApps({ limit: 25, cursor, status }).then(
			(result) => setState({ kind: "loaded", items: result.items, nextCursor: result.nextCursor }),
			(error: Error) => setState({ kind: "error", message: error.message }),
		);
	}, [api, cursor, status]);

	useEffect(() => {
		load();
	}, [load]);

	const changeStatus = (nextStatus: AppStatus | "") => {
		setStatus(nextStatus);
		setCursor(undefined);
		setCursorHistory([]);
	};

	return (
		<section className={styles.shell} aria-labelledby="apps-title">
			<AuroraPageHeader
				title="发布"
				titleId="apps-title"
				description="管理面向企业网站的发布应用、线上版本和接入范围。"
				meta={state.kind === "loaded" ? `本页 ${state.items.length} 个应用` : undefined}
			/>

			<div className={styles.toolbar}>
				<label className={styles.filterLabel}>
					<span>状态</span>
					<select value={status} onChange={(event) => changeStatus(event.target.value as AppStatus | "")}>
						<option value="">全部</option>
						<option value="active">已发布</option>
						<option value="draft">未发布</option>
						<option value="suspended">已暂停</option>
						<option value="archived">已归档</option>
					</select>
				</label>
				<AuroraButton variant="ghost" size="sm" onClick={load}>
					刷新
				</AuroraButton>
			</div>

			{state.kind === "loading" && <div className={styles.stateBox}>正在加载发布应用…</div>}
			{state.kind === "error" && (
				<div className={styles.errorBox} role="alert">
					<div>
						<strong>无法加载发布应用</strong>
						<p>请确认管理服务已启动，并检查控制台代理配置。</p>
						<code className={styles.errorDetail}>{state.message}</code>
					</div>
					<AuroraButton variant="default" size="sm" onClick={load}>
						重试
					</AuroraButton>
				</div>
			)}
			{state.kind === "loaded" && <AppsTable rows={state.items} onOpen={(id) => navigate(`/apps/${id}`)} />}

			{state.kind === "loaded" && (cursorHistory.length > 0 || state.nextCursor !== null) ? (
				<nav className={styles.footer} aria-label="发布应用分页">
					<span>第 {cursorHistory.length + 1} 页</span>
					<div className={styles.pageActions}>
						<AuroraButton
							variant="default"
							size="sm"
							disabled={cursorHistory.length === 0}
							onClick={() => {
								const previous = cursorHistory.at(-1);
								setCursor(previous);
								setCursorHistory((history) => history.slice(0, -1));
							}}
						>
							上一页
						</AuroraButton>
						<AuroraButton
							variant="default"
							size="sm"
							disabled={state.nextCursor === null}
							onClick={() => {
								if (state.nextCursor === null) return;
								setCursorHistory((history) => [...history, cursor]);
								setCursor(state.nextCursor);
							}}
						>
							下一页
						</AuroraButton>
					</div>
				</nav>
			) : null}
		</section>
	);
}

function AppsTable({
	rows,
	onOpen,
}: {
	readonly rows: readonly PublishedAppSummary[];
	readonly onOpen: (id: string) => void;
}): React.ReactElement {
	if (rows.length === 0) {
		return (
			<div className={styles.empty}>
				<strong>暂无发布应用</strong>
				<p>当前筛选条件下没有应用。</p>
			</div>
		);
	}

	return (
		<div className={styles.tableWrap}>
			<table className={styles.table}>
				<thead>
					<tr>
						<th>应用</th>
						<th>状态</th>
						<th>线上版本</th>
						<th>访问方式</th>
						<th>允许 Origin</th>
						<th>更新时间</th>
						<th aria-label="操作" />
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.id}>
							<td>
								<button type="button" className={styles.tableName} onClick={() => onOpen(row.id)}>
									{row.name}
								</button>
								<code className={styles.publicId}>{row.publicAppId}</code>
							</td>
							<td>{appStatusBadge(row.status)}</td>
							<td>{row.currentVersionId === null ? "尚未上线" : "已固定线上版本"}</td>
							<td>{ACCESS_LABEL[row.accessMode]}</td>
							<td className={styles.origins}>
								{row.allowedOrigins.length === 0 ? "同源" : row.allowedOrigins.join(", ")}
							</td>
							<td className={styles.date}>{formatDate(row.updatedAt)}</td>
							<td className={styles.actions}>
								<AuroraButton variant="ghost" size="sm" onClick={() => onOpen(row.id)}>
									管理
								</AuroraButton>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
