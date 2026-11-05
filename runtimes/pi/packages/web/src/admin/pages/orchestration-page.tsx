import type { AnalysisWorkItem, OrchestrationCatalog, OrchestrationIntegration } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OrchestrationApi } from "../api/orchestration-api.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { AuroraPageHeader } from "../aurora/PageHeader.tsx";
import { AuroraPill } from "../aurora/Pill.tsx";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { useDialogs } from "../components/use-dialogs.tsx";
import { OrchestrationConfiguration } from "./orchestration-configuration.tsx";
import { OrchestrationConnection, OrchestrationCredential } from "./orchestration-connection.tsx";
import { OrchestrationCreate } from "./orchestration-create.tsx";
import { OrchestrationDebug } from "./orchestration-debug.tsx";
import styles from "./orchestration-page.module.css";
import { displayTime, errorMessage, externalRefLabel, shortVersion, WORK_STATUS } from "./orchestration-ui.ts";
import { OrchestrationWorkDetail } from "./orchestration-work-detail.tsx";

type Panel =
	| { kind: "create" }
	| { kind: "configuration" | "connection"; integration: OrchestrationIntegration }
	| { kind: "work"; item: AnalysisWorkItem }
	| { kind: "debug"; integrationId?: string }
	| { kind: "credential"; name: string; token: string };

export function AdminOrchestrationPage(): React.JSX.Element {
	const { controller } = useAdminAuth();
	const api = useMemo(() => new OrchestrationApi(controller), [controller]),
		dialogs = useDialogs();
	const [data, setData] = useState<{
		integrations: readonly OrchestrationIntegration[];
		work: readonly AnalysisWorkItem[];
	} | null>(null);
	const [error, setError] = useState<string | null>(null),
		[busy, setBusy] = useState(false),
		[refreshing, setRefreshing] = useState(false);
	const [catalog, setCatalog] = useState<OrchestrationCatalog | null>(null),
		[catalogError, setCatalogError] = useState<string | null>(null),
		[catalogLoading, setCatalogLoading] = useState(true),
		[catalogRevision, setCatalogRevision] = useState(0);
	const [tab, setTab] = useState("work"),
		[query, setQuery] = useState(""),
		[state, setState] = useState(""),
		[source, setSource] = useState(""),
		[panel, setPanel] = useState<Panel | null>(null),
		[notice, setNotice] = useState("");
	/** 服务端查询结果；为空表示当前无筛选，直接使用最近 100 条。 */
	const [results, setResults] = useState<readonly AnalysisWorkItem[] | null>(null),
		[searching, setSearching] = useState(false),
		[searchNonce, setSearchNonce] = useState(0),
		[debugRuns, setDebugRuns] = useState<readonly AnalysisWorkItem[]>([]);
	const loadSequence = useRef(0);
	const load = useCallback(
		async (signal?: AbortSignal) => {
			const sequence = ++loadSequence.current;
			setRefreshing(true);
			try {
				const [integrations, work] = await Promise.all([
					api.request<readonly OrchestrationIntegration[]>("integrations", "GET", undefined, signal),
					api.request<readonly AnalysisWorkItem[]>("work-items", "GET", undefined, signal),
				]);
				if (!signal?.aborted && sequence === loadSequence.current) {
					setData({ integrations, work });
					setError(null);
				}
			} catch (e) {
				if (!signal?.aborted && sequence === loadSequence.current) setError(errorMessage(e));
			} finally {
				if (!signal?.aborted && sequence === loadSequence.current) setRefreshing(false);
			}
		},
		[api],
	);
	useEffect(() => {
		const abort = new AbortController();
		let pending = false;
		const refresh = async () => {
			if (pending) return;
			pending = true;
			await load(abort.signal);
			setSearchNonce((value) => value + 1);
			pending = false;
		};
		void refresh();
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void refresh();
		}, 5000);
		return () => {
			abort.abort();
			clearInterval(timer);
		};
	}, [load]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: catalogRevision explicitly invalidates the remote catalog.
	useEffect(() => {
		const abort = new AbortController();
		setCatalogLoading(true);
		void api
			.request<OrchestrationCatalog>("catalog", "GET", undefined, abort.signal)
			.then(
				(result) => {
					if (!abort.signal.aborted) {
						setCatalog(result);
						setCatalogError(null);
					}
				},
				(e) => {
					if (!abort.signal.aborted) setCatalogError(errorMessage(e));
				},
			)
			.finally(() => {
				if (!abort.signal.aborted) setCatalogLoading(false);
			});
		return () => abort.abort();
	}, [api, catalogRevision]);
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(""), 6000);
		return () => clearTimeout(timer);
	}, [notice]);
	// 筛选结果由服务端查询，避免只在最近 100 条里做前端过滤。
	// biome-ignore lint/correctness/useExhaustiveDependencies: searchNonce forces the periodic refresh of the filtered query.
	useEffect(() => {
		if (tab !== "work") {
			setResults(null);
			return;
		}
		const text = query.trim();
		if (!text && !state && !source) {
			setResults(null);
			setSearching(false);
			return;
		}
		const abort = new AbortController();
		const timer = setTimeout(() => {
			const params = new URLSearchParams();
			if (text) params.set("q", text);
			if (state) params.set("state", state);
			if (source) params.set("integrationId", source);
			setSearching(true);
			void api
				.request<readonly AnalysisWorkItem[]>(`work-items?${params.toString()}`, "GET", undefined, abort.signal)
				.then(
					(items) => {
						if (!abort.signal.aborted) setResults(items);
					},
					(e) => {
						if (!abort.signal.aborted) setError(errorMessage(e));
					},
				)
				.finally(() => {
					if (!abort.signal.aborted) setSearching(false);
				});
		}, 300);
		return () => {
			clearTimeout(timer);
			abort.abort();
		};
	}, [api, tab, query, state, source, searchNonce]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: searchNonce forces the periodic refresh of the debug run list.
	useEffect(() => {
		if (tab !== "debugRuns") return;
		const abort = new AbortController();
		const loadDebug = async () => {
			try {
				const items = await api.request<readonly AnalysisWorkItem[]>(
					"work-items?externalRefType=console_debug",
					"GET",
					undefined,
					abort.signal,
				);
				if (!abort.signal.aborted) setDebugRuns(items);
			} catch (e) {
				if (!abort.signal.aborted) setError(errorMessage(e));
			}
		};
		void loadDebug();
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void loadDebug();
		}, 5000);
		return () => {
			abort.abort();
			clearInterval(timer);
		};
	}, [api, tab, searchNonce]);
	const integrations = data?.integrations ?? [],
		work = data?.work ?? [];
	const sourceName = (id: string) => integrations.find((i) => i.id === id)?.name ?? "未知接入";
	const switchTab = (next: string) => {
		setTab(next);
		setQuery("");
		setState("");
		setSource("");
	};
	const filteredWork = tab === "debugRuns" ? debugRuns : (results ?? work);
	const filteredIntegrations = integrations.filter(
		(i) =>
			(!state || (state === "enabled") === i.enabled) &&
			`${i.name} ${i.configurationId ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
	);
	const update = async (i: OrchestrationIntegration, action: "enable" | "disable" | "rotate") => {
		if (
			!(await dialogs.confirm(
				action === "rotate"
					? "原接入凭据将立即失效。请在签发后同步更新工单后端。"
					: action === "disable"
						? "停用后不再接受此接入的新分析请求。"
						: "启用后将恢复接受工单系统的分析请求。",
				{
					title:
						action === "rotate" ? "重新签发接入凭据？" : `${action === "disable" ? "停用" : "启用"}${i.name}？`,
					confirmLabel: action === "rotate" ? "重新签发" : action === "disable" ? "确认停用" : "确认启用",
					destructive: action !== "enable",
				},
			))
		)
			return;
		setBusy(true);
		try {
			const result = await api.request<{ token?: string }>(`integrations/${i.id}`, "PATCH", { action });
			if (result.token) setPanel({ kind: "credential", name: i.name, token: result.token });
			else setNotice(action === "enable" ? "接入已启用" : "接入已停用");
			await load();
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};
	const rename = async (i: OrchestrationIntegration) => {
		const entered = await dialogs.prompt("名称仅用于控制台识别接入来源；接入 ID、调用凭据、配置和已有 Run 均不变。", {
			title: "重命名接入",
			inputLabel: "接入名称",
			defaultValue: i.name,
			maxLength: 200,
			confirmLabel: "保存名称",
		});
		const name = entered?.trim();
		if (!name || name === i.name) return;
		setBusy(true);
		setError(null);
		try {
			await api.request(`integrations/${i.id}`, "PATCH", { action: "rename", name });
			setNotice(`接入已重命名为「${name}」`);
			await load();
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};
	const migrate = async (i: OrchestrationIntegration) => {
		if (
			!(await dialogs.confirm(
				`将 Chat Agent「${i.chatAppName ?? "历史发布"}」的冻结快照复制为独立编排配置。接入 ID、调用凭据和已有 Run 均保持不变。`,
				{ title: "迁移为独立编排配置？", confirmLabel: "迁移为独立配置" },
			))
		)
			return;
		setBusy(true);
		setError(null);
		try {
			await api.request(`integrations/${i.id}/migrate`, "POST", {
				expected_revision: i.revision,
				expected_active_version: i.versionId,
			});
			setNotice("已迁移为独立编排配置，新任务将使用独立版本");
			await load();
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className={styles.page} aria-label="Agent 编排">
			<AuroraPageHeader
				title="Agent 编排"
				titleId="orchestration-title"
				actions={
					<>
						<AuroraButton disabled={refreshing} onClick={() => void load()}>
							{refreshing ? "正在刷新…" : "刷新"}
						</AuroraButton>
						<AuroraButton onClick={() => setPanel({ kind: "debug" })}>动态任务调试</AuroraButton>
						<AuroraButton variant="primary" onClick={() => setPanel({ kind: "create" })}>
							新建接入
						</AuroraButton>
					</>
				}
			/>
			<p className={styles.intro}>连接业务系统，让 Agent 在后台分析告警，按配置的提示词生成结果。</p>
			{error && (
				<div role="alert" className={styles.error}>
					<strong>未能更新页面</strong>
					<p>
						{error}
						{data ? "。当前保留上次读取的数据。" : ""}
					</p>
					<AuroraButton onClick={() => void load()}>重试加载</AuroraButton>
				</div>
			)}
			{notice && <output className={styles.success}>{notice}</output>}
			{!data && !error && <output className={styles.loading}>正在加载接入系统与分析工作项…</output>}
			{data && (
				<>
					<section className={styles.metrics} aria-label="最近工作项概况">
						{(["running", "queued", "failed", "succeeded"] as const).map((key) => (
							<button
								type="button"
								key={key}
								className={tab === "work" && state === key ? styles.metricSelected : styles.metric}
								onClick={() => {
									setTab("work");
									setState(state === key ? "" : key);
									setQuery("");
									setSource("");
								}}
							>
								<span>{WORK_STATUS[key].label}</span>
								<strong>{work.filter((w) => w.state === key).length}</strong>
								<small>
									{key === "running"
										? "正在处理告警"
										: key === "queued"
											? "等待执行"
											: key === "failed"
												? "需要关注"
												: "报告已就绪"}
								</small>
							</button>
						))}
					</section>
					<div
						className={styles.tabs}
						role="tablist"
						aria-label="编排管理"
						onKeyDown={(event) => {
							if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
							event.preventDefault();
							const order = ["work", "debugRuns", "integrations"];
							const index = order.indexOf(tab);
							const next = order[(index + (event.key === "ArrowRight" ? 1 : order.length - 1)) % order.length]!;
							switchTab(next);
							document.getElementById(`orchestration-tab-${next}`)?.focus();
						}}
					>
						{[
							["work", "分析工作项", work.length],
							["debugRuns", "调试记录", debugRuns.length],
							["integrations", "接入系统", integrations.length],
						].map(([key, label, count]) => (
							<button
								type="button"
								role="tab"
								key={key}
								id={`orchestration-tab-${key}`}
								aria-controls="orchestration-tabpanel"
								aria-selected={tab === key}
								tabIndex={tab === key ? 0 : -1}
								onClick={() => switchTab(String(key))}
							>
								{label}
								<span>{count}</span>
							</button>
						))}
					</div>
					<section
						id="orchestration-tabpanel"
						role="tabpanel"
						aria-labelledby={`orchestration-tab-${tab}`}
						className={styles.panel}
					>
						<div className={styles.toolbar}>
							<label className={styles.search}>
								<span>搜索</span>
								<input
									disabled={tab === "debugRuns"}
									aria-label={
										tab === "integrations"
											? "搜索接入系统"
											: tab === "debugRuns"
												? "调试记录由服务端按保留类型筛选"
												: "搜索告警、业务标识或 Run ID"
									}
									placeholder={
										tab === "integrations"
											? "搜索接入名称或配置 ID"
											: tab === "debugRuns"
												? "调试记录（服务端筛选）"
												: "搜索告警、业务标识或 Run ID"
									}
									value={query}
									onChange={(event) => setQuery(event.target.value)}
								/>
							</label>
							<select
								aria-label="筛选状态"
								value={state}
								disabled={tab === "debugRuns"}
								onChange={(event) => setState(event.target.value)}
							>
								<option value="">全部状态</option>
								{tab === "work" ? (
									Object.entries(WORK_STATUS).map(([key, value]) => (
										<option key={key} value={key}>
											{value.label}
										</option>
									))
								) : tab === "integrations" ? (
									<>
										<option value="enabled">已启用</option>
										<option value="disabled">已停用</option>
									</>
								) : null}
							</select>
							{tab === "work" && (
								<select
									aria-label="筛选接入来源"
									value={source}
									onChange={(event) => setSource(event.target.value)}
								>
									<option value="">全部接入来源</option>
									{integrations.map((i) => (
										<option key={i.id} value={i.id}>
											{i.name}
										</option>
									))}
								</select>
							)}
							{(query || state || source) && (
								<button
									type="button"
									className={styles.textButton}
									onClick={() => {
										setQuery("");
										setState("");
										setSource("");
									}}
								>
									清除筛选
								</button>
							)}
							<span className={styles.toolbarHint}>
								{searching ? "正在查询…" : refreshing ? "正在同步" : "每 5 秒自动更新"}
							</span>
						</div>
						{tab === "work" || tab === "debugRuns" ? (
							filteredWork.length ? (
								<div className={styles.tableScroll}>
									<table className={styles.table}>
										<thead>
											<tr>
												<th>告警 / 分析结论</th>
												<th>接入来源</th>
												<th>状态</th>
												<th>冻结版本</th>
												<th>最近更新</th>
												<th>
													<span className={styles.srOnly}>操作</span>
												</th>
											</tr>
										</thead>
										<tbody>
											{filteredWork.map((w) => (
												<tr key={w.id}>
													<td>
														<button
															type="button"
															className={styles.rowTitle}
															onClick={() => setPanel({ kind: "work", item: w })}
														>
															{w.alarmId}
														</button>
														{w.externalRef && (
															<p className={styles.rowDescription}>
																业务标识 {externalRefLabel(w.externalRef)}
															</p>
														)}
														<p className={styles.rowDescription}>
															{w.report?.slice(0, 200) ??
																(w.state === "failed"
																	? "分析未完成，请查看执行记录"
																	: "尚未生成分析结论")}
														</p>
													</td>
													<td>{sourceName(w.integrationId)}</td>
													<td>
														<AuroraPill tone={WORK_STATUS[w.state].tone}>
															{WORK_STATUS[w.state].label}
														</AuroraPill>
													</td>
													<td>
														{w.versionId ? (
															<span className={styles.version} title={w.versionId}>
																{w.versionId.startsWith("pav_") ? "历史 " : ""}
																{shortVersion(w.versionId)}
															</span>
														) : (
															<span className={styles.version}>v{w.configurationRevision}</span>
														)}
													</td>
													<td className={styles.time}>{displayTime(w.updatedAt)}</td>
													<td>
														<AuroraButton size="sm" onClick={() => setPanel({ kind: "work", item: w })}>
															查看详情
														</AuroraButton>
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							) : (
								<div className={styles.empty}>
									<span className={styles.emptyMark}>◎</span>
									<h3>
										{work.length
											? "没有匹配的工作项"
											: integrations.length
												? "等待第一条告警"
												: "先连接一个业务系统"}
									</h3>
									<p>
										{work.length
											? "尝试调整关键词、状态或接入来源。"
											: integrations.length
												? "工单系统提交告警后，分析进度和报告会自动出现在这里。"
												: "创建接入后，工单系统即可提交告警并查询分析报告。"}
									</p>
									{!integrations.length && (
										<AuroraButton variant="primary" onClick={() => setPanel({ kind: "create" })}>
											新建接入
										</AuroraButton>
									)}
								</div>
							)
						) : filteredIntegrations.length ? (
							<div className={styles.tableScroll}>
								<table className={styles.table}>
									<thead>
										<tr>
											<th>接入系统</th>
											<th>配置来源</th>
											<th>状态</th>
											<th>接入修订</th>
											<th>操作</th>
										</tr>
									</thead>
									<tbody>
										{filteredIntegrations.map((i) => (
											<tr key={i.id}>
												<td>
													<button
														type="button"
														className={styles.rowTitle}
														onClick={() => setPanel({ kind: "connection", integration: i })}
													>
														{i.name}
													</button>
													<p className={styles.rowDescription}>
														{i.bindings.length} 条工具凭据映射 · {i.allowedModels.length} 个开放模型
													</p>
												</td>
												<td>
													{i.configurationSource === "orchestration"
														? "独立编排配置"
														: "历史发布快照（待迁移）"}
													{i.chatAppName ? (
														<p className={styles.rowDescription}>
															{i.configurationSource === "orchestration" ? "历史溯源" : "来源"}：Chat
															Agent「
															{i.chatAppName}」
															{i.legacyVersionId ? ` · ${shortVersion(i.legacyVersionId)}` : ""}
														</p>
													) : i.legacyVersionId ? (
														<p className={styles.rowDescription}>
															历史版本 {shortVersion(i.legacyVersionId)}
														</p>
													) : null}
												</td>
												<td>
													<AuroraPill tone={i.enabled ? "green" : "neutral"}>
														{i.enabled ? "已启用" : "已停用"}
													</AuroraPill>
												</td>
												<td>
													<span className={styles.version}>v{i.revision}</span>
												</td>
												<td>
													<div className={styles.actions}>
														<AuroraButton
															size="sm"
															onClick={() => setPanel({ kind: "configuration", integration: i })}
														>
															分析配置
														</AuroraButton>
														<AuroraButton
															size="sm"
															onClick={() => setPanel({ kind: "connection", integration: i })}
														>
															接入说明
														</AuroraButton>
														<AuroraButton
															size="sm"
															disabled={!i.enabled}
															onClick={() => setPanel({ kind: "debug", integrationId: i.id })}
														>
															调试此接入
														</AuroraButton>
														<details className={styles.menu}>
															<summary aria-label={`${i.name}的更多操作`}>•••</summary>
															<div>
																<button
																	type="button"
																	disabled={busy}
																	onClick={() => void update(i, i.enabled ? "disable" : "enable")}
																>
																	{i.enabled ? "停用接入" : "启用接入"}
																</button>
																<button type="button" disabled={busy} onClick={() => void rename(i)}>
																	重命名
																</button>
																<button
																	type="button"
																	disabled={busy}
																	onClick={() => void update(i, "rotate")}
																>
																	重新签发凭据
																</button>
																{i.configurationSource !== "orchestration" && (
																	<button
																		type="button"
																		disabled={busy}
																		onClick={() => void migrate(i)}
																	>
																		迁移为独立配置
																	</button>
																)}
															</div>
														</details>
													</div>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						) : (
							<div className={styles.empty}>
								<h3>{integrations.length ? "没有匹配的接入" : "尚未创建接入"}</h3>
								<p>
									{integrations.length
										? "请调整筛选条件。"
										: "配置任务提示词、模型和 MCP 工具，即可签发接入凭据。"}
								</p>
							</div>
						)}
						<footer className={styles.listFooter}>
							<span>
								{tab === "work"
									? results
										? `匹配 ${results.length} 项 · 服务端查询，最多返回最近 100 条`
										: `显示 ${work.length} 个工作项 · 统计范围为最近 100 项`
									: tab === "debugRuns"
										? `共 ${debugRuns.length} 条调试 Run · 服务端按保留类型筛选`
										: `共 ${filteredIntegrations.length} 个接入系统`}
							</span>
							<span>
								{tab === "work" || tab === "debugRuns"
									? "点击任务查看报告与执行记录"
									: "接入凭据由业务系统后端保存"}
							</span>
						</footer>
					</section>
				</>
			)}
			{panel?.kind === "create" && (
				<OrchestrationCreate
					api={api}
					catalog={catalog}
					catalogError={catalogError}
					loading={catalogLoading}
					onReload={() => setCatalogRevision((v) => v + 1)}
					onClose={() => setPanel(null)}
					onCreated={(name, token) => {
						setPanel({ kind: "credential", name, token });
						switchTab("integrations");
						setCatalogRevision((v) => v + 1);
						void load();
					}}
				/>
			)}
			{panel?.kind === "credential" && (
				<OrchestrationCredential name={panel.name} token={panel.token} onClose={() => setPanel(null)} />
			)}
			{panel?.kind === "configuration" && (
				<OrchestrationConfiguration
					key={panel.integration.id}
					api={api}
					integration={panel.integration}
					catalog={catalog}
					onClose={() => setPanel(null)}
					onSaved={() => {
						void load();
					}}
				/>
			)}
			{panel?.kind === "connection" && (
				<OrchestrationConnection integration={panel.integration} catalog={catalog} onClose={() => setPanel(null)} />
			)}
			{panel?.kind === "work" && (
				<OrchestrationWorkDetail
					key={panel.item.id}
					api={api}
					initial={panel.item}
					sourceName={sourceName(panel.item.integrationId)}
					onClose={() => setPanel(null)}
					onChanged={() => void load()}
				/>
			)}
			{panel?.kind === "debug" && (
				<OrchestrationDebug
					api={api}
					integrations={integrations}
					initialIntegrationId={panel.integrationId}
					onClose={() => setPanel(null)}
					onOpenRun={(item) => {
						setPanel({ kind: "work", item });
						void load();
					}}
				/>
			)}
			{dialogs.dialog}
		</section>
	);
}
