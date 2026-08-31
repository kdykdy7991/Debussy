import type { McpServerDetail, McpServerSummary, McpStreamableHttpConfig } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { McpApi, McpApiError } from "../api/mcp-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";
import styles from "./mcp-page.module.css";

type DetailTab = "overview" | "tools" | "revisions" | "agents";

function formatDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(date);
}

function currentConfig(detail: McpServerDetail): McpStreamableHttpConfig | null {
	return detail.revisions.find((revision) => revision.revision === detail.currentRevision)?.config ?? null;
}

function Connection({ detail }: { readonly detail: McpServerDetail }): React.ReactElement {
	if (detail.lastTest === null) return <span className={styles.untested}>未连接</span>;
	if (!detail.lastTest.ok) return <span className={styles.failed}>连接失败</span>;
	return (
		<span className={styles.connected}>
			已连接{detail.lastTest.latencyMs === null ? "" : ` · ${detail.lastTest.latencyMs}ms`}
		</span>
	);
}

export function AdminMcpPage(): React.ReactElement {
	const { controller } = useAdminAuth();
	const apiRef = useRef<McpApi | null>(null);
	if (apiRef.current === null) apiRef.current = new McpApi({ auth: controller });
	const api = apiRef.current;
	const [items, setItems] = useState<readonly McpServerSummary[]>([]);
	const [details, setDetails] = useState<ReadonlyMap<string, McpServerDetail>>(new Map());
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState<"all" | "enabled" | "disabled">("all");
	const [connection, setConnection] = useState<"all" | "connected" | "failed" | "untested">("all");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<DetailTab>("overview");
	const [showCreate, setShowCreate] = useState(false);
	const [name, setName] = useState("");
	const [endpoint, setEndpoint] = useState("");
	const [authentication, setAuthentication] = useState<"none" | "bearer">("none");
	const [bearerToken, setBearerToken] = useState("");

	const load = useCallback(
		async (showLoading = true) => {
			if (showLoading) setLoading(true);
			setError(null);
			try {
				const result = await api.list();
				const loaded = await Promise.all(
					result.items.map(async (item) => [item.id, await api.get(item.id)] as const),
				);
				const detailMap = new Map(loaded);
				setItems(result.items);
				setDetails(detailMap);
				setSelectedId((current) => (current && detailMap.has(current) ? current : (result.items[0]?.id ?? null)));
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (showLoading) setLoading(false);
			}
		},
		[api],
	);
	useEffect(() => void load(), [load]);

	const selected = selectedId ? (details.get(selectedId) ?? null) : null;
	const visible = useMemo(
		() =>
			items.filter((item) => {
				const detail = details.get(item.id);
				if (
					query.trim() &&
					!`${item.name} ${item.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
				)
					return false;
				if (status !== "all" && item.status !== status) return false;
				if (connection === "connected" && detail?.lastTest?.ok !== true) return false;
				if (connection === "failed" && detail?.lastTest?.ok !== false) return false;
				if (connection === "untested" && detail?.lastTest !== null) return false;
				return true;
			}),
		[connection, details, items, query, status],
	);

	const reportError = (cause: unknown) => {
		const requestId = cause instanceof McpApiError ? cause.requestId : null;
		setError(
			`${cause instanceof Error ? cause.message : String(cause)}${requestId ? ` · Request ID: ${requestId}` : ""}`,
		);
	};
	const act = async (key: string, action: () => Promise<unknown>) => {
		setBusy(key);
		setError(null);
		try {
			await action();
			await load(false);
		} catch (cause) {
			reportError(cause);
		} finally {
			setBusy(null);
		}
	};
	const toggleServer = (detail: McpServerDetail): void => {
		if (
			detail.status === "enabled" &&
			!window.confirm(`停用后，${detail.boundAgents.length} 个 Agent Revision 将无法使用此 MCP，确定继续吗？`)
		)
			return;
		void act(`toggle-${detail.id}`, () => api.setEnabled(detail.id, detail.status !== "enabled"));
	};
	const create = async () => {
		if (!name.trim() || !endpoint.trim()) return;
		await act("create", async () => {
			const detail = await api.create(name, { transport: "streamable_http", endpoint, authentication });
			if (authentication === "bearer" && bearerToken) await api.replaceSecret(detail.id, bearerToken);
			setSelectedId(detail.id);
			setShowCreate(false);
			setName("");
			setEndpoint("");
			setAuthentication("none");
			setBearerToken("");
		});
	};
	const editConfig = async () => {
		if (!selected) return;
		const config = currentConfig(selected);
		const nextEndpoint = window.prompt("请输入新的 Streamable HTTP 地址", config?.endpoint ?? "");
		if (!nextEndpoint) return;
		await act("edit", () =>
			api.createRevision(selected.id, {
				transport: "streamable_http",
				endpoint: nextEndpoint,
				authentication: config?.authentication ?? "none",
			}),
		);
	};
	const replaceSecret = async () => {
		if (!selected) return;
		const token = window.prompt("请输入新的 Bearer Token（保存后不会回显）");
		if (!token) return;
		await act("secret", () => api.replaceSecret(selected.id, token));
	};

	return (
		<section className={styles.page} aria-labelledby="mcp-title">
			<header className={styles.header}>
				<div>
					<h1 id="mcp-title">MCP 管理</h1>
				</div>
				<button type="button" className={styles.createButton} onClick={() => setShowCreate(true)}>
					＋ 新建 MCP Server
				</button>
			</header>
			{error ? (
				<div className={styles.error} role="alert">
					{error}
					<button type="button" onClick={() => setError(null)}>
						×
					</button>
				</div>
			) : null}
			<section className={styles.listCard} aria-label="MCP Server 列表">
				<div className={styles.toolbar}>
					<input
						aria-label="搜索 MCP Server"
						placeholder="⌕  搜索 MCP Server 名称"
						value={query}
						onChange={(event) => setQuery(event.currentTarget.value)}
					/>
					<label>
						全局启用状态
						<select value={status} onChange={(event) => setStatus(event.currentTarget.value as typeof status)}>
							<option value="all">全部</option>
							<option value="enabled">已启用</option>
							<option value="disabled">已停用</option>
						</select>
					</label>
					<label>
						连接状态
						<select
							value={connection}
							onChange={(event) => setConnection(event.currentTarget.value as typeof connection)}
						>
							<option value="all">全部</option>
							<option value="connected">已连接</option>
							<option value="failed">连接失败</option>
							<option value="untested">未连接</option>
						</select>
					</label>
					<button type="button" onClick={() => void load()} aria-label="刷新">
						↻
					</button>
				</div>
				<div className={styles.tableScroll}>
					<table className={styles.serverTable}>
						<thead>
							<tr>
								<th>名称</th>
								<th>服务地址</th>
								<th>全局启用状态</th>
								<th>连接状态</th>
								<th>工具数量</th>
								<th>已接入 Agent 数</th>
								<th>更新时间</th>
							</tr>
						</thead>
						<tbody>
							{visible.map((item) => {
								const detail = details.get(item.id);
								const config = detail ? currentConfig(detail) : null;
								return (
									<tr
										key={item.id}
										className={item.id === selectedId ? styles.selected : undefined}
										onClick={() => {
											setSelectedId(item.id);
											setTab("overview");
										}}
									>
										<td>
											<strong>{item.name}</strong>
											<small>{item.id}</small>
										</td>
										<td title={config?.endpoint}>{config?.endpoint ?? "—"}</td>
										<td>
											<button
												type="button"
												className={item.status === "enabled" ? styles.switchOn : styles.switchOff}
												aria-label={`${item.status === "enabled" ? "停用" : "启用"} ${item.name}`}
												aria-pressed={item.status === "enabled"}
												disabled={detail === undefined || busy !== null}
												style={{
													padding: 0,
													border: 0,
													cursor: busy === null ? "pointer" : "wait",
													backgroundColor: item.status === "enabled" ? "#2f9e54" : "#cbd1da",
												}}
												onClick={(event) => {
													event.stopPropagation();
													if (detail !== undefined) toggleServer(detail);
												}}
											/>
											{item.status === "enabled" ? "已启用" : "已停用"}
										</td>
										<td>{detail ? <Connection detail={detail} /> : "—"}</td>
										<td>{item.toolCount}</td>
										<td>{detail?.boundAgents.length ?? 0}</td>
										<td>{formatDate(item.updatedAt)}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
				{loading ? <div className={styles.empty}>正在加载 MCP Servers…</div> : null}
				{!loading && visible.length === 0 ? <div className={styles.empty}>没有匹配的 MCP Server</div> : null}
				<footer>共 {visible.length} 条</footer>
			</section>
			{selected ? (
				<section className={styles.detailArea}>
					<aside className={styles.detailNav}>
						<div>
							<strong>{selected.name}</strong>
							<Connection detail={selected} />
						</div>
						{(
							[
								["overview", "概览"],
								["tools", `Tools (${selected.toolCount})`],
								["revisions", `Revision (${selected.revisions.length})`],
								["agents", `接入的 Agent (${selected.boundAgents.length})`],
							] as const
						).map(([id, label]) => (
							<button
								type="button"
								key={id}
								className={tab === id ? styles.activeTab : undefined}
								onClick={() => setTab(id)}
							>
								{label}
							</button>
						))}
					</aside>
					<main className={styles.detailMain}>
						{tab === "overview" ? (
							<Overview
								detail={selected}
								busy={busy}
								onTest={() =>
									void act("test", async () => {
										await api.test(selected.id);
										await api.syncTools(selected.id);
									})
								}
								onEdit={() => void editConfig()}
								onSecret={() => void replaceSecret()}
								onToggle={() => toggleServer(selected)}
								onDelete={() => {
									if (!window.confirm(`确定删除 MCP Server“${selected.name}”吗？`)) return;
									void act("delete", () => api.delete(selected.id));
								}}
							/>
						) : null}
						{tab === "tools" ? <Tools detail={selected} /> : null}
						{tab === "revisions" ? <Revisions detail={selected} /> : null}
						{tab === "agents" ? <Agents detail={selected} /> : null}
					</main>
					<aside className={styles.sideInfo}>
						<h3>接入的 Agent（{selected.boundAgents.length}）</h3>
						{selected.boundAgents.slice(0, 3).map((binding) => (
							<div className={styles.sideAgent} key={`${binding.agentId}-${binding.agentRevision}`}>
								<span>♙</span>
								<div>
									<strong>{binding.agentId}</strong>
									<small>rev_{binding.agentRevision}</small>
								</div>
								<button type="button" onClick={() => navigate(`/agents/${binding.agentId}`)}>
									查看 Agent
								</button>
							</div>
						))}
						{selected.boundAgents.length === 0 ? <p>暂无 Agent 接入</p> : null}
						<section>
							<h3>说明</h3>
							<ul>
								<li>全局停用后，所有 Agent 将无法使用该 MCP。</li>
								<li>更新配置或同步 Tools 会创建新的 Revision。</li>
								<li>已发布的 Agent Revision 不会被自动变更。</li>
							</ul>
						</section>
					</aside>
				</section>
			) : null}
			{showCreate ? (
				<div className={styles.overlay}>
					<section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="create-mcp-title">
						<h2 id="create-mcp-title">新建 MCP Server</h2>
						<label>
							名称
							<input value={name} onChange={(event) => setName(event.currentTarget.value)} />
						</label>
						<label>
							Streamable HTTP 地址
							<input
								value={endpoint}
								onChange={(event) => setEndpoint(event.currentTarget.value)}
								placeholder="https://mcp.example.com/mcp"
							/>
						</label>
						<label>
							认证方式
							<select
								value={authentication}
								onChange={(event) => setAuthentication(event.currentTarget.value as typeof authentication)}
							>
								<option value="none">无认证</option>
								<option value="bearer">Bearer Token</option>
							</select>
						</label>
						{authentication === "bearer" ? (
							<label>
								Bearer Token
								<input
									type="password"
									value={bearerToken}
									onChange={(event) => setBearerToken(event.currentTarget.value)}
									autoComplete="new-password"
								/>
							</label>
						) : null}
						<div>
							<button type="button" onClick={() => setShowCreate(false)}>
								取消
							</button>
							<button
								type="button"
								className={styles.createButton}
								disabled={busy !== null || !name.trim() || !endpoint.trim()}
								onClick={() => void create()}
							>
								{busy === "create" ? "创建中…" : "创建"}
							</button>
						</div>
					</section>
				</div>
			) : null}
		</section>
	);
}

function Overview({
	detail,
	busy,
	onTest,
	onEdit,
	onSecret,
	onToggle,
	onDelete,
}: {
	readonly detail: McpServerDetail;
	readonly busy: string | null;
	readonly onTest: () => void;
	readonly onEdit: () => void;
	readonly onSecret: () => void;
	readonly onToggle: () => void;
	readonly onDelete: () => void;
}): React.ReactElement {
	const config = currentConfig(detail);
	return (
		<>
			<h2>服务信息</h2>
			<dl className={styles.info}>
				<div>
					<dt>Server ID</dt>
					<dd>{detail.id}</dd>
				</div>
				<div>
					<dt>服务地址</dt>
					<dd>{config?.endpoint ?? "—"}</dd>
				</div>
				<div>
					<dt>认证方式</dt>
					<dd>{config?.authentication === "bearer" ? "Bearer Token" : "无认证"}</dd>
				</div>
				<div>
					<dt>认证状态</dt>
					<dd>{config?.authentication === "none" ? "无需认证" : detail.secretConfigured ? "已配置" : "未配置"}</dd>
				</div>
				<div>
					<dt>全局启用状态</dt>
					<dd>{detail.status === "enabled" ? "已启用" : "已停用"}</dd>
				</div>
				<div>
					<dt>当前 Revision</dt>
					<dd>v{detail.currentRevision}</dd>
				</div>
				<div>
					<dt>更新时间</dt>
					<dd>{formatDate(detail.updatedAt)}</dd>
				</div>
			</dl>
			<div className={detail.lastTest?.ok ? styles.successPanel : styles.neutralPanel}>
				<strong>{detail.lastTest?.ok ? "连接成功" : detail.lastTest === null ? "尚未测试连接" : "连接失败"}</strong>
				<span>
					{detail.lastTest
						? `${formatDate(detail.lastTest.at)}${detail.lastTest.latencyMs === null ? "" : ` · 延迟 ${detail.lastTest.latencyMs}ms`}`
						: "测试连接以确认 Server 和 Tools 是否可用"}
				</span>
			</div>
			<h3 className={styles.quickTitle}>快捷操作</h3>
			<div className={styles.quickActions}>
				<button type="button" disabled={busy !== null} onClick={onTest}>
					{busy === "test" ? "测试并同步中…" : "测试连接"}
				</button>
				<button type="button" disabled={busy !== null} onClick={onEdit}>
					{busy === "edit" ? "保存中…" : "编辑配置"}
				</button>
				{config?.authentication === "bearer" ? (
					<button type="button" disabled={busy !== null} onClick={onSecret}>
						{busy === "secret" ? "保存中…" : "替换 Token"}
					</button>
				) : null}
				<button type="button" disabled={busy !== null} onClick={onToggle}>
					{busy?.startsWith("toggle-") === true
						? "更新中…"
						: detail.status === "enabled"
							? "停用 MCP"
							: "启用 MCP"}
				</button>
				<button type="button" className={styles.deleteButton} disabled={busy !== null} onClick={onDelete}>
					{busy === "delete" ? "删除中…" : "删除 MCP"}
				</button>
			</div>
		</>
	);
}

function Tools({ detail }: { readonly detail: McpServerDetail }): React.ReactElement {
	const tools = detail.revisions.find((revision) => revision.revision === detail.currentRevision)?.tools ?? [];
	return (
		<>
			<h2>Tools（{tools.length}）</h2>
			{tools.length === 0 ? (
				<div className={styles.tabEmpty}>尚未同步 Tools</div>
			) : (
				<div className={styles.toolGrid}>
					{tools.map((tool) => (
						<article key={tool.id}>
							<strong>{tool.name}</strong>
							<p>{tool.description ?? "暂无描述"}</p>
							<small>Schema Hash: {tool.inputSchemaHash}</small>
						</article>
					))}
				</div>
			)}
		</>
	);
}
function Revisions({ detail }: { readonly detail: McpServerDetail }): React.ReactElement {
	return (
		<>
			<h2>Revision 历史</h2>
			<table className={styles.innerTable}>
				<thead>
					<tr>
						<th>Revision</th>
						<th>服务地址</th>
						<th>工具数</th>
						<th>创建时间</th>
					</tr>
				</thead>
				<tbody>
					{detail.revisions.map((revision) => (
						<tr key={revision.revision}>
							<td>
								v{revision.revision}
								{revision.revision === detail.currentRevision ? "（当前）" : ""}
							</td>
							<td>{revision.config.endpoint}</td>
							<td>{revision.tools.length}</td>
							<td>{formatDate(revision.createdAt)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</>
	);
}
function Agents({ detail }: { readonly detail: McpServerDetail }): React.ReactElement {
	return (
		<>
			<h2>接入的 Agent</h2>
			{detail.boundAgents.length === 0 ? (
				<div className={styles.tabEmpty}>暂无 Agent Revision 接入</div>
			) : (
				detail.boundAgents.map((binding) => (
					<div className={styles.agentLine} key={`${binding.agentId}-${binding.agentRevision}`}>
						<div>
							<strong>{binding.agentId}</strong>
							<small>Revision r{binding.agentRevision}</small>
						</div>
						<button type="button" onClick={() => navigate(`/agents/${binding.agentId}`)}>
							查看 Agent
						</button>
					</div>
				))
			)}
		</>
	);
}
