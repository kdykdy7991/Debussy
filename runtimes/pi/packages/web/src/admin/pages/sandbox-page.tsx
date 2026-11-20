import type {
	AdminSandboxEnvironment,
	AdminSandboxStatistics,
	SandboxExecutionStatus,
} from "@earendil-works/pi-protocol";
import { type ReactNode, useEffect, useState } from "react";
import { copyTextToClipboard } from "../../conversation/copy-text.ts";
import { AaasKeysApi } from "../api/aaas-keys-api.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { AuroraPageHeader } from "../aurora/PageHeader.tsx";
import { AuroraPillTabs } from "../aurora/PillTabs.tsx";
import { AuroraSearchBox } from "../aurora/SearchBox.tsx";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { beijingDate } from "../beijing-time.ts";
import { errorMessage } from "./orchestration-ui.ts";
import { SandboxDistribution, SandboxTrend } from "./sandbox-charts.tsx";
import { SandboxIcon } from "./sandbox-icons.tsx";
import styles from "./sandbox-page.module.css";

const tabs = [
	{ value: "environment", label: "运行环境" },
	{ value: "statistics", label: "执行统计" },
] as const;
const statusLabels: Record<SandboxExecutionStatus, string> = {
	success: "成功",
	command_failed: "命令执行失败",
	start_failed: "启动失败",
	timeout: "超时",
	canceled: "取消",
};
const runtimes = [
	{ name: "Python", icon: "python" },
	{ name: "Node.js", icon: "node" },
	{ name: "Bash", icon: "terminal" },
] as const;
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });
const duration = (ms: number | null) => (ms === null ? "—" : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${ms} ms`);

function Availability({ available, label }: { available: boolean; label?: string }) {
	return (
		<span className={styles.availability} data-available={available}>
			<SandboxIcon name={available ? "check" : "error"} size={13} />
			{label ?? (available ? "可用" : "不可用")}
		</span>
	);
}

function CopyPath({ path, label, shaded = false }: { path: string; label: string; shaded?: boolean }) {
	const [state, setState] = useState<"idle" | "copied" | "error">("idle");
	async function copy() {
		setState((await copyTextToClipboard(path)) ? "copied" : "error");
	}
	return (
		<div className={styles.path} data-shaded={shaded}>
			<code title={path}>{path}</code>
			<button
				type="button"
				className={styles.copy}
				title={state === "copied" ? "已复制" : `复制${label}`}
				aria-label={`复制${label}`}
				onClick={() => void copy()}
			>
				<SandboxIcon name={state === "copied" ? "check" : "copy"} size={16} />
			</button>
			<output className={state === "error" ? styles.copyError : styles.srOnly}>
				{state === "copied" ? "已复制" : state === "error" ? "复制失败" : ""}
			</output>
		</div>
	);
}

export function SandboxEnvironmentView({
	data,
	search,
	onSearch,
}: {
	data: AdminSandboxEnvironment;
	search: string;
	onSearch: (value: string) => void;
}) {
	const query = search.trim().toLowerCase();
	const packages = data.available
		? data.pythonPackages.filter(({ name, version, location }) =>
				[name, version, location].some((field) => field.toLowerCase().includes(query)),
			)
		: [];
	const [distribution, kernel] = data.os.split(" · ", 2);
	const facts = [
		{ label: "执行方式", value: "按 Bash 调用独立启动", icon: "zap" },
		{ label: "运行环境", value: "共享只读运行根", icon: "layers" },
		{ label: "工作区", value: "Task 隔离，跨 Operation 保留", icon: "folder" },
		{ label: "网络", value: "独立网络命名空间", icon: "network" },
	] as const;

	return (
		<>
			<section className={`${styles.card} ${styles.overview}`} aria-labelledby="sandbox-basics">
				<div className={styles.overviewTop}>
					<div className={styles.provider}>
						<span className={styles.providerIcon}>
							<SandboxIcon name="box" size={34} />
						</span>
						<div className={styles.providerText}>
							<div className={styles.providerTitle}>
								<h2 id="sandbox-basics">{data.provider} (bwrap)</h2>
								{data.bwrapVersion && (
									<span className={styles.versionBadge}>
										{data.bwrapVersion.startsWith("v") ? data.bwrapVersion : `v${data.bwrapVersion}`}
									</span>
								)}
							</div>
							<p>当前仅用于已授权的 Router Bash 调用</p>
						</div>
					</div>
					<div className={styles.system}>
						<SandboxIcon name="linux" size={28} />
						<div>
							<strong>{distribution}</strong>
							{kernel && <small>{kernel}</small>}
						</div>
					</div>
				</div>
				<dl className={styles.facts}>
					{data.available &&
						facts.map(({ label, value, icon }) => (
							<div key={label}>
								<dt>
									<SandboxIcon name={icon} size={21} />
									{label}
								</dt>
								<dd>{value}</dd>
							</div>
						))}
					<div>
						<dt>
							<SandboxIcon name="shield" size={21} />
							环境状态
						</dt>
						<dd>
							<Availability available={data.available} />
						</dd>
					</div>
				</dl>
			</section>
			{data.available ? (
				<>
					<section aria-labelledby="sandbox-runtimes">
						<h2 className={styles.sectionTitle} id="sandbox-runtimes">
							运行时
						</h2>
						<div className={styles.runtimeGrid}>
							{runtimes.map(({ name, icon }) => {
								const runtime = data.runtimes.find((item) => item.name === name);
								return (
									<article key={name} className={`${styles.card} ${styles.runtime}`}>
										<div className={styles.runtimeTop}>
											<span className={styles.runtimeIcon} data-runtime={icon}>
												<SandboxIcon name={icon} size={32} />
											</span>
											<div className={styles.runtimeName}>
												<h3>{name}</h3>
												<strong title={runtime?.version}>{runtime?.version ?? "—"}</strong>
											</div>
											<Availability available={Boolean(runtime)} />
										</div>
										{runtime && <CopyPath path={runtime.path} label={` ${name} 路径`} shaded />}
									</article>
								);
							})}
						</div>
					</section>
					<section className={styles.card} aria-labelledby="sandbox-packages">
						<header className={styles.panelHeader}>
							<h2 id="sandbox-packages">Python 第三方依赖</h2>
							<div className={styles.packageMeta}>
								<span className={styles.dependencyBadge}>固定预装环境</span>
								<span>共 {data.pythonPackages.length.toLocaleString()} 个包</span>
							</div>
						</header>
						<div className={styles.packageBody}>
							<div className={styles.search}>
								<AuroraSearchBox
									value={search}
									onChange={onSearch}
									ariaLabel="搜索 Python 依赖"
									placeholder="搜索包名、版本或安装位置…"
								/>
							</div>
							{packages.length > 0 ? (
								<div className={styles.tableScroll}>
									<table className={`${styles.table} ${styles.packageTable}`}>
										<thead>
											<tr>
												<th>包名</th>
												<th>版本</th>
												<th>安装位置</th>
											</tr>
										</thead>
										<tbody>
											{packages.map((pkg) => (
												<tr key={`${pkg.name}:${pkg.version}:${pkg.location}`}>
													<td>{pkg.name}</td>
													<td>
														<code>{pkg.version}</code>
													</td>
													<td>
														<CopyPath path={pkg.location} label={` ${pkg.name} 安装位置`} />
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							) : (
								<p className={styles.empty}>
									{query ? "没有匹配的 Python 依赖。" : "未安装 Python 第三方依赖。"}
								</p>
							)}
						</div>
					</section>
					<details className={`${styles.card} ${styles.details}`}>
						<summary>
							<SandboxIcon name="chevron" size={14} />
							详细信息<span>（运行根、工作区等路径）</span>
						</summary>
						<dl className={styles.detailGrid}>
							<div>
								<dt>共享运行根</dt>
								<dd>
									<CopyPath path={data.runtimeDir} label="运行根路径" shaded />
								</dd>
							</div>
							<div>
								<dt>Task 工作区根目录</dt>
								<dd>
									<CopyPath path={data.workspaceDir} label="工作区根路径" shaded />
								</dd>
							</div>
							<div>
								<dt>Sandbox 内工作区挂载点</dt>
								<dd>
									<CopyPath path={data.workspaceMount} label="工作区挂载点" shaded />
								</dd>
							</div>
						</dl>
					</details>
				</>
			) : (
				<p className={styles.error} role="alert">
					{data.error === "SANDBOX_UNAVAILABLE" ? "Sandbox 配置或运行根不可用。" : "Sandbox 环境探测失败。"}
				</p>
			)}
		</>
	);
}

const reasonLabels: Record<string, string> = {
	EXECUTION_TIMEOUT: "执行超时",
	EXECUTION_ABORTED: "收到取消信号",
	COMMAND_TERMINATED: "命令异常终止",
	SANDBOX_UNAVAILABLE: "Bubblewrap 不可用",
	SANDBOX_START_FAILED: "Bubblewrap 启动失败",
	SANDBOX_CLEANUP_UNCONFIRMED: "清理结果未确认",
};

export function SandboxStatisticsView({ data }: { data: AdminSandboxStatistics }) {
	const metrics = [
		{ label: "执行次数", value: data.total.toLocaleString(), icon: "terminal" },
		{ label: "成功率", value: data.successRate === null ? "—" : percent.format(data.successRate), icon: "check" },
		{ label: "平均耗时", value: duration(data.averageMs), icon: "clock" },
		{ label: "P95 耗时", value: duration(data.p95Ms), icon: "bars" },
	] as const;
	return (
		<>
			<dl className={styles.metricGrid}>
				{metrics.map(({ label, value, icon }) => (
					<div key={label} className={`${styles.card} ${styles.metric}`}>
						<dt>
							<span className={styles.metricIcon} data-icon={icon}>
								<SandboxIcon name={icon} size={22} />
							</span>
							{label}
						</dt>
						<dd>{value}</dd>
					</div>
				))}
			</dl>
			<div className={styles.chartGrid}>
				<SandboxTrend trend={data.trend} total={data.total} />
				<SandboxDistribution counts={data.counts} total={data.total} />
			</div>
			<section className={styles.card} aria-labelledby="sandbox-recent">
				<header className={styles.panelHeader}>
					<h2 id="sandbox-recent">最近执行记录</h2>
				</header>
				{data.recent.length > 0 ? (
					<div className={styles.tableScroll}>
						<table className={`${styles.table} ${styles.recentTable}`}>
							<thead>
								<tr>
									<th>执行时间</th>
									<th>Task / Operation</th>
									<th>工具</th>
									<th>状态</th>
									<th>耗时</th>
									<th>简要结果</th>
									<th>操作</th>
								</tr>
							</thead>
							<tbody>
								{data.recent.map((row) => {
									const started = new Date(row.startedAt);
									const time = Number.isNaN(started.getTime())
										? "—"
										: beijingDate(started).toISOString().slice(0, 19).replace("T", " ");
									const exitCode = row.reason?.match(/^EXIT_(\d+)$/)?.[1];
									const reason = row.reason
										? exitCode
											? `退出码 ${exitCode}`
											: (reasonLabels[row.reason] ?? row.reason)
										: row.status === "success"
											? "正常退出"
											: "—";
									return (
										<tr key={row.id}>
											<td>
												<time dateTime={row.startedAt}>{time}</time>
											</td>
											<td>
												<code title={`${row.taskId} / ${row.operationId}`}>
													{row.taskId.slice(0, 8)} / {row.operationId.slice(0, 8)}
												</code>
											</td>
											<td>
												<span className={styles.inlineIcon}>
													<SandboxIcon name="terminal" size={16} />
													{row.tool}
												</span>
											</td>
											<td>
												<span className={styles.rowStatus} data-tone={row.status}>
													<SandboxIcon
														name={
															row.status === "success"
																? "check"
																: row.status === "timeout"
																	? "clock"
																	: "error"
														}
														size={14}
													/>
													{statusLabels[row.status]}
												</span>
											</td>
											<td>{duration(row.durationMs)}</td>
											<td title={row.reason ?? undefined}>{reason}</td>
											<td>
												<a
													className={styles.detailLink}
													href={`#/conversations/router/${row.keyId}/${row.taskId}/${row.operationId}`}
													aria-label={`查看详情 ${row.operationId}`}
												>
													查看详情 <SandboxIcon name="arrow" size={14} />
												</a>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				) : (
					<p className={styles.empty}>该时间范围内暂无执行记录。</p>
				)}
			</section>
		</>
	);
}

type SandboxData = AdminSandboxEnvironment | AdminSandboxStatistics;

export function AdminSandboxPage() {
	const { controller, snapshot } = useAdminAuth();
	const [tab, setTab] = useState<(typeof tabs)[number]["value"]>("environment");
	const [hours, setHours] = useState("24");
	const [revision, setRevision] = useState(0);
	const [search, setSearch] = useState("");
	const [response, setResponse] = useState<{ key: string; data: SandboxData } | { key: string; error: string }>();
	const path = tab === "environment" ? "/sandbox/environment" : `/sandbox/statistics?hours=${hours}`;
	const key = `${path}:${revision}`;
	const current = response?.key === key && snapshot.state === "connected" ? response : undefined;
	const data = current && "data" in current ? current.data : undefined;
	const environment = data && "provider" in data ? data : undefined;

	useEffect(() => {
		if (snapshot.state !== "connected") return;
		const abort = new AbortController();
		void new AaasKeysApi(controller).request<SandboxData>(path, "GET", undefined, abort.signal).then(
			(data) => {
				if (!abort.signal.aborted) setResponse({ key, data });
			},
			(cause: unknown) => {
				if (!abort.signal.aborted) setResponse({ key, error: errorMessage(cause) });
			},
		);
		return () => abort.abort();
	}, [controller, key, path, snapshot.state]);

	let content: ReactNode;
	if (snapshot.state === "connecting") content = <output className={styles.loading}>正在连接管理服务…</output>;
	else if (snapshot.state !== "connected")
		content = (
			<p className={styles.error} role="alert">
				管理员会话未连接。
			</p>
		);
	else if (current && "error" in current)
		content = (
			<p className={styles.error} role="alert">
				{current.error}
			</p>
		);
	else if (environment) content = <SandboxEnvironmentView data={environment} search={search} onSearch={setSearch} />;
	else if (data && "total" in data) content = <SandboxStatisticsView data={data} />;
	else
		content = <output className={styles.loading}>正在读取 Sandbox {tab === "environment" ? "环境" : "统计"}…</output>;

	return (
		<section className={styles.page} aria-labelledby="sandbox-title">
			<AuroraPageHeader
				title="Sandbox 环境"
				titleId="sandbox-title"
				meta="运行环境与执行观测"
				actions={
					<>
						{tab === "environment" && environment && (
							<Availability
								available={environment.available}
								label={environment.available ? "环境可用" : "环境不可用"}
							/>
						)}
						{tab === "statistics" && (
							<div className={styles.range}>
								<SandboxIcon name="calendar" size={15} />
								<select
									aria-label="统计时间范围"
									value={hours}
									onChange={(event) => {
										setHours(event.currentTarget.value);
										setRevision((value) => value + 1);
									}}
								>
									<option value="24">近 24 小时</option>
									<option value="168">近 7 天</option>
									<option value="720">近 30 天</option>
								</select>
							</div>
						)}
						<AuroraButton
							size="sm"
							icon={<SandboxIcon name="refresh" size={15} />}
							onClick={() => setRevision((value) => value + 1)}
						>
							刷新
						</AuroraButton>
					</>
				}
			/>
			<div className={styles.tabs}>
				<AuroraPillTabs
					items={tabs}
					value={tab}
					onChange={(next) => {
						if (next === tab) return;
						setTab(next);
						setRevision((value) => value + 1);
					}}
					ariaLabel="Sandbox 页面"
				/>
			</div>
			<div className={styles.content} role="tabpanel" aria-label={tab === "environment" ? "运行环境" : "执行统计"}>
				{content}
			</div>
		</section>
	);
}
