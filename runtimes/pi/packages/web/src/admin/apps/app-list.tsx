/**
 * App List — redesigned (mock-data preview).
 *
 * 本组件用于锁定应用列表页的视觉与信息架构（说明：本轮先以 Mock Data 落地
 * 「名称 / 绑定 Agent / Revision / 访问类型 / 状态 / 更新时间 / 操作」
 * 七列），不实现发布流程、域名配置、使用情况统计等深度页面。
 * 点击应用名仍可进入 `AdminAppDetail`，保留与既有路由的衔接。
 *
 * 关键概念（与 Agent 列表的差异）：
 *   - 一个应用绑定某个 Agent 的某一个 Revision，发布给最终用户使用
 *   - 同一个 Agent 可以被发布成多个不同应用（不同访问模式 / 状态）
 *   - Mock Data 中刻意让「客服 Agent」对应三个应用（官网客服、内部工作台、
 *     测试环境预览）来演示这种 1:N 关系
 */

import { useMemo, useState } from "react";
import { navigate } from "../router.ts";

type AppStatus = "active" | "draft" | "suspended" | "archived";
type AccessMode = "anonymous" | "signed_user" | "mixed";

interface AppRow {
	readonly id: string;
	readonly name: string;
	readonly publicAppId: string;
	readonly boundAgentName: string;
	readonly boundAgentId: string;
	/** Which revision of the bound agent this app is currently pinned to. */
	readonly boundAgentRevision: number;
	readonly accessMode: AccessMode;
	readonly status: AppStatus;
	readonly updatedAt: string;
	readonly updatedBy: string;
}

const MOCK_APPS: readonly AppRow[] = [
	{
		id: "app_demo_001",
		name: "官网客服",
		publicAppId: "app_pub_8f3c1e2a",
		boundAgentName: "客服 Agent",
		boundAgentId: "agent_demo_customer_service",
		boundAgentRevision: 12,
		accessMode: "anonymous",
		status: "active",
		updatedAt: "2026-08-15 10:32",
		updatedBy: "alice@example.com",
	},
	{
		id: "app_demo_002",
		name: "内部客服工作台",
		publicAppId: "app_pub_4a92be71",
		boundAgentName: "客服 Agent",
		boundAgentId: "agent_demo_customer_service",
		boundAgentRevision: 11,
		accessMode: "signed_user",
		status: "active",
		updatedAt: "2026-08-10 14:48",
		updatedBy: "bob@example.com",
	},
	{
		id: "app_demo_003",
		name: "客服测试环境预览",
		publicAppId: "app_pub_2c7dfa09",
		boundAgentName: "客服 Agent",
		boundAgentId: "agent_demo_customer_service",
		boundAgentRevision: 13,
		accessMode: "anonymous",
		status: "draft",
		updatedAt: "2026-08-16 18:01",
		updatedBy: "alice@example.com",
	},
	{
		id: "app_demo_004",
		name: "合同审查控制台",
		publicAppId: "app_pub_6e1b09dc",
		boundAgentName: "合同审查 Agent",
		boundAgentId: "agent_demo_contract_review",
		boundAgentRevision: 8,
		accessMode: "signed_user",
		status: "active",
		updatedAt: "2026-08-12 09:14",
		updatedBy: "bob@example.com",
	},
	{
		id: "app_demo_005",
		name: "数据分析控制台",
		publicAppId: "app_pub_71b2ce40",
		boundAgentName: "数据分析 Agent",
		boundAgentId: "agent_demo_data_analyst",
		boundAgentRevision: 21,
		accessMode: "signed_user",
		status: "suspended",
		updatedAt: "2026-07-28 11:05",
		updatedBy: "carol@example.com",
	},
	{
		id: "app_demo_006",
		name: "知识库检索",
		publicAppId: "app_pub_09c4f812",
		boundAgentName: "知识问答 Agent",
		boundAgentId: "agent_demo_knowledge_qa",
		boundAgentRevision: 5,
		accessMode: "anonymous",
		status: "active",
		updatedAt: "2026-08-10 14:48",
		updatedBy: "alice@example.com",
	},
];

const STATUS_LABEL: Record<AppStatus, string> = {
	active: "已发布",
	draft: "未发布",
	suspended: "已暂停",
	archived: "已归档",
};

const ACCESS_LABEL: Record<AccessMode, string> = {
	anonymous: "匿名访问",
	signed_user: "登录用户",
	mixed: "混合",
};

const STATUS_FILTER_OPTIONS: readonly { value: AppStatus | "all"; label: string }[] = [
	{ value: "all", label: "全部状态" },
	{ value: "active", label: "已发布" },
	{ value: "draft", label: "未发布" },
	{ value: "suspended", label: "已暂停" },
	{ value: "archived", label: "已归档" },
];

interface AppMoreMenuProps {
	readonly row: AppRow;
}

function AppMoreMenu({ row }: AppMoreMenuProps): React.ReactElement {
	const [open, setOpen] = useState(false);
	return (
		<div className="actions-popover">
			<button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				更多
			</button>
			{open && (
				<>
					<div className="actions-popover__backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
					<div className="actions-popover__menu" role="menu">
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								setOpen(false);
								window.alert(`复制应用 Embed 代码（占位）: ${row.publicAppId}`);
							}}
						>
							复制 Embed 代码
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								setOpen(false);
								window.alert(`复制应用 ID（占位）: ${row.id}`);
							}}
						>
							复制应用 ID
						</button>
						<button
							type="button"
							role="menuitem"
							className="danger"
							onClick={() => {
								setOpen(false);
								window.alert(`归档应用「${row.name}」（占位动作）`);
							}}
						>
							归档应用
						</button>
					</div>
				</>
			)}
		</div>
	);
}

export function AppListView(): React.ReactElement {
	const [query, setQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState<AppStatus | "all">("all");

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return MOCK_APPS.filter((row) => {
			if (statusFilter !== "all" && row.status !== statusFilter) return false;
			if (needle === "") return true;
			return (
				row.name.toLowerCase().includes(needle) ||
				row.publicAppId.toLowerCase().includes(needle) ||
				row.boundAgentName.toLowerCase().includes(needle)
			);
		});
	}, [query, statusFilter]);

	const totalCount = MOCK_APPS.length;
	const activeCount = MOCK_APPS.filter((r) => r.status === "active").length;
	// 按绑定 Agent 名称统计去重，展示「多少个 Agent 被发布到了多少个应用」
	const agentCount = new Set(MOCK_APPS.map((r) => r.boundAgentId)).size;
	// 同一 Agent 的不同 Revision 也可以被不同应用绑定 — 统计去重的 (agent, revision) 对
	const revisionBindingCount = new Set(MOCK_APPS.map((r) => `${r.boundAgentId}#${r.boundAgentRevision}`)).size;

	return (
		<section aria-label="应用列表">
			<header className="list-page-header">
				<div className="list-page-header__lead">
					<h1>应用</h1>
					<p>
						应用把某个 Agent 的某个 Revision 交付给最终用户，每个应用拥有独立的访问模式与发布状态。 同一个 Agent
						可以被发布为多个应用，覆盖官网、内部工作台、外部合作方等不同场景。
					</p>
				</div>
				<button type="button" className="primary" onClick={() => navigate("/apps")}>
					+ 创建应用
				</button>
			</header>

			<div className="mock-data-banner" role="note">
				<span>当前为 Mock Data 预览，字段结构用于锁定设计与信息架构，下一步接入 Control API。</span>
			</div>

			<div className="list-toolbar">
				<div className="list-toolbar__search">
					<input
						type="search"
						placeholder="按名称 / 绑定 Agent 搜索"
						aria-label="搜索应用"
						value={query}
						onChange={(e) => setQuery(e.currentTarget.value)}
					/>
				</div>
				<select
					aria-label="状态筛选"
					value={statusFilter}
					onChange={(e) => setStatusFilter(e.currentTarget.value as AppStatus | "all")}
				>
					{STATUS_FILTER_OPTIONS.map((opt) => (
						<option key={opt.value} value={opt.value}>
							{opt.label}
						</option>
					))}
				</select>
			</div>

			<div className="list-stats">
				<span>
					<strong>{totalCount}</strong>个应用
				</span>
				<span>
					<strong>{activeCount}</strong>个已发布
				</span>
				<span>
					<strong>{agentCount}</strong>个 Agent 被发布
				</span>
				<span>
					<strong>{revisionBindingCount}</strong>条 Agent × Revision 绑定
				</span>
			</div>

			{filtered.length === 0 ? (
				<div className="data-table-empty">
					<h3>没有匹配的应用</h3>
					<p>尝试调整搜索关键词或筛选条件。</p>
				</div>
			) : (
				<table className="data-table">
					<thead>
						<tr>
							<th className="col-name">名称</th>
							<th>绑定 Agent</th>
							<th>Revision</th>
							<th>访问类型</th>
							<th>状态</th>
							<th>更新时间</th>
							<th className="col-actions">操作</th>
						</tr>
					</thead>
					<tbody>
						{filtered.map((row) => (
							<tr key={row.id}>
								<td>
									<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
										<span className="list-row-glyph app" aria-hidden="true">
											{row.name.slice(0, 1)}
										</span>
										<div className="list-title-block">
											<button
												type="button"
												className="agent-name"
												onClick={() => navigate(`/apps/${row.id}`)}
											>
												{row.name}
											</button>
											<span className="list-title-sub">{row.publicAppId}</span>
											<span className="list-title-id">id: {row.id}</span>
										</div>
									</div>
								</td>
								<td>
									<button
										type="button"
										className="agent-name"
										onClick={() => navigate(`/agents/${row.boundAgentId}`)}
									>
										{row.boundAgentName}
									</button>
								</td>
								<td>
									<span className="col-mono">v{row.boundAgentRevision}</span>
								</td>
								<td>
									<span className="badge status-draft">{ACCESS_LABEL[row.accessMode]}</span>
								</td>
								<td>
									<span className={`badge status-${row.status}`}>{STATUS_LABEL[row.status]}</span>
								</td>
								<td>
									<div className="list-title-block">
										<span>{row.updatedAt}</span>
										<span className="list-title-sub">by {row.updatedBy}</span>
									</div>
								</td>
								<td>
									<div className="row-actions">
										<button type="button" title="在新窗口预览" disabled={row.status !== "active"}>
											预览
										</button>
										<button type="button" title="访问设置">
											设置
										</button>
										<button type="button" title="查看使用情况">
											分析
										</button>
										<AppMoreMenu row={row} />
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}
