import type { PublishedAppDetail, PublishedAppSummary } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import menuStyles from "../action-menu.module.css";
import { AppApi } from "../api/app-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";
import styles from "./apps-list-view.module.css";

type AppStatus = PublishedAppSummary["status"];
type LoadState =
	| { readonly kind: "loading" }
	| {
			readonly kind: "loaded";
			readonly items: readonly PublishedAppSummary[];
			readonly details: ReadonlyMap<string, PublishedAppDetail>;
			readonly nextCursor: string | null;
	  }
	| { readonly kind: "error"; readonly message: string };

const STATUS_LABEL: Record<AppStatus, string> = {
	active: "已上线",
	draft: "草稿",
	suspended: "已暂停",
	archived: "已归档",
};
const ACCESS_LABEL: Record<PublishedAppSummary["accessMode"], string> = {
	anonymous: "匿名访问",
	signed_user: "登录用户",
	mixed: "混合访问",
};

type IconName = "search" | "calendar" | "refresh" | "lock" | "user" | "globe" | "plus";
function Icon({ name }: { readonly name: IconName }): React.ReactElement {
	const paths: Record<IconName, React.ReactNode> = {
		search: (
			<>
				<circle cx="11" cy="11" r="6.5" />
				<path d="m16 16 4 4" />
			</>
		),
		calendar: (
			<>
				<rect x="3.5" y="5" width="17" height="15" rx="2" />
				<path d="M8 3v4m8-4v4M4 10h16" />
			</>
		),
		refresh: (
			<>
				<path d="M19 8a8 8 0 1 0 1 6" />
				<path d="M19 3v5h-5" />
			</>
		),
		lock: (
			<>
				<rect x="5.5" y="10" width="13" height="10" rx="2" />
				<path d="M8.5 10V7a3.5 3.5 0 0 1 7 0v3" />
			</>
		),
		user: (
			<>
				<circle cx="12" cy="8" r="3.5" />
				<path d="M5.5 20c.4-4 2.5-6 6.5-6s6.1 2 6.5 6" />
			</>
		),
		globe: (
			<>
				<circle cx="12" cy="12" r="8.5" />
				<path d="M3.5 12h17M12 3.5c2.7 2.5 3.8 5.3 3.8 8.5S14.7 18 12 20.5C9.3 18 8.2 15.2 8.2 12S9.3 6 12 3.5Z" />
			</>
		),
		plus: <path d="M12 5v14M5 12h14" />,
	};
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			{paths[name]}
		</svg>
	);
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
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState<AppStatus | "">("");
	const [sort, setSort] = useState<"newest" | "oldest">("newest");
	const [cursor, setCursor] = useState<string | undefined>();
	const [cursorHistory, setCursorHistory] = useState<readonly (string | undefined)[]>([]);
	const [state, setState] = useState<LoadState>({ kind: "loading" });
	const [openMenuId, setOpenMenuId] = useState<string | null>(null);
	const load = useCallback(() => {
		setState({ kind: "loading" });
		void api.listPublishedApps({ limit: 10, cursor, status }).then(
			async (result) => {
				const entries = await Promise.all(
					result.items.map(async (item) => {
						try {
							return [item.id, await api.getPublishedApp(item.id)] as const;
						} catch {
							return null;
						}
					}),
				);
				setState({
					kind: "loaded",
					items: result.items,
					details: new Map(
						entries.filter((entry): entry is readonly [string, PublishedAppDetail] => entry !== null),
					),
					nextCursor: result.nextCursor,
				});
			},
			(error: Error) => setState({ kind: "error", message: error.message }),
		);
	}, [api, cursor, status]);
	useEffect(() => load(), [load]);
	const rows = useMemo(() => {
		if (state.kind !== "loaded") return [];
		const normalized = query.trim().toLocaleLowerCase();
		return [...state.items]
			.filter((item) => normalized === "" || item.name.toLocaleLowerCase().includes(normalized))
			.sort((a, b) => {
				const delta = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
				return sort === "newest" ? delta : -delta;
			});
	}, [query, sort, state]);
	const changeStatus = (next: AppStatus | "") => {
		setStatus(next);
		setCursor(undefined);
		setCursorHistory([]);
	};
	const remove = async (item: PublishedAppSummary) => {
		setOpenMenuId(null);
		const confirmation = window.prompt(`请输入应用名称“${item.name}”确认删除：`);
		if (confirmation === null) return;
		if (confirmation !== item.name) {
			window.alert("输入的应用名称不匹配，未执行删除");
			return;
		}
		try {
			await api.deletePublishedApp(item.id, confirmation);
			load();
		} catch (error) {
			window.alert(error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<section className={styles.shell} aria-labelledby="apps-title">
			<header className={styles.header}>
				<div>
					<h1 id="apps-title">发布应用</h1>
					<p>管理已发布的应用，查看状态与访问配置。</p>
				</div>
				<button className={styles.createButton} type="button" onClick={() => navigate("/apps/new")}>
					<Icon name="plus" />
					创建应用
				</button>
			</header>
			<div className={styles.toolbar}>
				<div className={styles.search}>
					<Icon name="search" />
					<input
						aria-label="搜索应用名称"
						value={query}
						onChange={(event) => setQuery(event.currentTarget.value)}
						placeholder="搜索应用名称"
					/>
				</div>
				<select
					aria-label="状态筛选"
					value={status}
					onChange={(event) => changeStatus(event.currentTarget.value as AppStatus | "")}
				>
					<option value="">全部状态</option>
					<option value="active">已上线</option>
					<option value="draft">草稿</option>
					<option value="suspended">已暂停</option>
					<option value="archived">已归档</option>
				</select>
				<span className={styles.toolbarSpacer} />
				<label className={styles.sort}>
					<Icon name="calendar" />
					<select
						aria-label="排序"
						value={sort}
						onChange={(event) => setSort(event.currentTarget.value as "newest" | "oldest")}
					>
						<option value="newest">按更新时间排序（最新）</option>
						<option value="oldest">按更新时间排序（最早）</option>
					</select>
				</label>
				<button type="button" className={styles.refresh} onClick={load} aria-label="刷新">
					<Icon name="refresh" />
				</button>
			</div>
			{state.kind === "loading" ? <div className={styles.stateBox}>正在加载发布应用…</div> : null}
			{state.kind === "error" ? (
				<div className={styles.errorBox} role="alert">
					<div>
						<strong>加载失败</strong>
						<p>{state.message}</p>
					</div>
					<button type="button" onClick={load}>
						重试
					</button>
				</div>
			) : null}
			{state.kind === "loaded" ? (
				rows.length === 0 ? (
					<div className={styles.stateBox}>{query ? "未找到匹配的应用" : "暂无发布应用"}</div>
				) : (
					<div className={styles.tableWrap}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th>应用名称</th>
									<th>关联 Agent</th>
									<th>状态</th>
									<th>访问方式</th>
									<th>更新时间</th>
									<th>操作</th>
									<th aria-label="更多操作" />
								</tr>
							</thead>
							<tbody>
								{rows.map((item, index) => {
									const detail = state.details.get(item.id);
									return (
										<tr key={item.id}>
											<td>
												<div className={`${styles.appIcon} ${styles[`tone${index % 5}`]}`}>◇</div>
												<div className={styles.appCopy}>
													<button type="button" onClick={() => navigate(`/apps/${item.id}`)}>
														{item.name}
													</button>
													<span>{item.publicAppId}</span>
												</div>
											</td>
											<td>
												<div className={styles.agentName}>
													<Icon name="globe" />
													<span>
														<b>{detail?.sourceAgent.name ?? "—"}</b>
														<small>
															{detail?.capabilities?.model.modelId ??
																(detail ? `Revision ${detail.sourceAgent.revision}` : "配置未加载")}
														</small>
													</span>
												</div>
											</td>
											<td>
												<span className={`${styles.status} ${styles[item.status]}`}>
													{STATUS_LABEL[item.status]}
												</span>
											</td>
											<td>
												<span className={styles.access}>
													<Icon name={item.accessMode === "anonymous" ? "user" : "lock"} />
													{ACCESS_LABEL[item.accessMode]}
												</span>
											</td>
											<td className={styles.date}>{formatDate(item.updatedAt)}</td>
											<td>
												<button
													type="button"
													className={styles.manage}
													onClick={() => navigate(`/apps/${item.id}`)}
												>
													{item.status === "draft"
														? "继续配置"
														: item.status === "suspended"
															? "查看"
															: "管理"}
												</button>
											</td>
											<td>
												<div className={menuStyles.anchor}>
													<button
														type="button"
														className={styles.more}
														aria-label={`${item.name}更多操作`}
														aria-expanded={openMenuId === item.id}
														aria-haspopup="menu"
														onClick={() =>
															setOpenMenuId((current) => (current === item.id ? null : item.id))
														}
													>
														•••
													</button>
													{openMenuId === item.id ? (
														<div className={menuStyles.menu} role="menu">
															<button type="button" role="menuitem" onClick={() => void remove(item)}>
																删除应用
															</button>
														</div>
													) : null}
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
						<footer className={styles.footer}>
							<span>本页 {rows.length} 条</span>
							<nav aria-label="发布应用分页">
								<button
									type="button"
									disabled={cursorHistory.length === 0}
									onClick={() => {
										const previous = cursorHistory.at(-1);
										setCursor(previous);
										setCursorHistory((history) => history.slice(0, -1));
									}}
								>
									‹
								</button>
								<b>{cursorHistory.length + 1}</b>
								<button
									type="button"
									disabled={state.nextCursor === null}
									onClick={() => {
										if (state.nextCursor === null) return;
										setCursorHistory((history) => [...history, cursor]);
										setCursor(state.nextCursor);
									}}
								>
									›
								</button>
								<span>10 条/页</span>
							</nav>
						</footer>
					</div>
				)
			) : null}
		</section>
	);
}
