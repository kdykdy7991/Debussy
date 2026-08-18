/**
 * Agent List — redesigned (mock-data preview).
 *
 * 本组件用于锁定 Agent 列表页的视觉与信息架构（说明：本轮先以 Mock Data
 * 落地「名称 / 描述 / 模型 / Tools / Revision / 状态 / 更新时间 / 操作」
 * 八列），不实现编辑、Revision 管理、发布等深度页面。点击行名仍可进入
 * AgentWorkspace 详情页，以保留与既有路由的衔接。
 *
 * 字段来源（MVP-15 占位）：
 *   - name / description：管理员录入
 *   - modelId：AgentDefinitionDetail.modelId
 *   - tools / toolCount：AgentConfigSnapshot.toolIds（按 toolId 数组）
 *   - revision：AgentDefinitionDetail.currentRevision
 *   - status：active = 当前最新 revision 已发布；draft = 有未保存草稿；
 *             archived = 已废弃
 *   - updatedAt：AgentDefinitionDetail.updatedAt
 *
 * 后续接入 Control API 时，把 MOCK_AGENTS 替换为对 AgentApi.listAgents
 * + AgentApi.getAgentDetail 的并发请求即可，列表行结构保持稳定。
 */

import type { AgentPublicId } from "@earendil-works/pi-protocol";
import { useMemo, useState } from "react";
import { navigate } from "../router.ts";

type AgentStatus = "active" | "draft" | "archived";

interface AgentRow {
	readonly id: AgentPublicId;
	readonly name: string;
	readonly description: string;
	readonly modelId: string;
	/** Tool names resolved from AgentConfigSnapshot.toolIds against the tool registry. */
	readonly tools: readonly string[];
	readonly revision: number;
	readonly status: AgentStatus;
	readonly updatedAt: string;
	readonly updatedBy: string;
}

const MOCK_AGENTS: readonly AgentRow[] = [
	{
		id: "agent_demo_customer_service" as AgentPublicId,
		name: "客服 Agent",
		description: "面向 C 端用户的智能客服，整合知识库检索与多轮上下文。",
		modelId: "claude-sonnet-4.5",
		tools: ["知识库检索", "工单创建", "退款查询", "意图识别", "多轮上下文"],
		revision: 12,
		status: "active",
		updatedAt: "2026-08-15 10:32",
		updatedBy: "alice@example.com",
	},
	{
		id: "agent_demo_contract_review" as AgentPublicId,
		name: "合同审查 Agent",
		description: "法务助手，自动审查合同条款、识别潜在风险并给出修订建议。",
		modelId: "claude-opus-5",
		tools: ["条款比对", "风险条款识别", "修订建议生成"],
		revision: 8,
		status: "active",
		updatedAt: "2026-08-12 09:14",
		updatedBy: "bob@example.com",
	},
	{
		id: "agent_demo_data_analyst" as AgentPublicId,
		name: "数据分析 Agent",
		description: "支持自然语言查询数据库，输出 SQL 与可视化图表。",
		modelId: "claude-sonnet-4.5",
		tools: ["SQL 生成", "Schema 检索", "可视化图表", "数据采样", "异常检测", "导出 CSV", "报表模板"],
		revision: 21,
		status: "draft",
		updatedAt: "2026-08-16 18:01",
		updatedBy: "carol@example.com",
	},
	{
		id: "agent_demo_knowledge_qa" as AgentPublicId,
		name: "知识问答 Agent",
		description: "基于内部知识库的语义检索与回答。",
		modelId: "claude-haiku-4.5",
		tools: ["语义检索", "引用标注"],
		revision: 5,
		status: "active",
		updatedAt: "2026-08-10 14:48",
		updatedBy: "alice@example.com",
	},
];

const STATUS_LABEL: Record<AgentStatus, string> = {
	active: "已发布",
	draft: "有草稿",
	archived: "已归档",
};

const STATUS_FILTER_OPTIONS: readonly { value: AgentStatus | "all"; label: string }[] = [
	{ value: "all", label: "全部状态" },
	{ value: "active", label: "已发布" },
	{ value: "draft", label: "有草稿" },
	{ value: "archived", label: "已归档" },
];

interface AgentMoreMenuProps {
	readonly onExport: () => void;
	readonly onArchive: () => void;
}

function AgentMoreMenu({ onExport, onArchive }: AgentMoreMenuProps): React.ReactElement {
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
								onExport();
							}}
						>
							导出配置
						</button>
						<button
							type="button"
							role="menuitem"
							className="danger"
							onClick={() => {
								setOpen(false);
								onArchive();
							}}
						>
							归档 Agent
						</button>
					</div>
				</>
			)}
		</div>
	);
}

export function AgentListView(): React.ReactElement {
	const [query, setQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState<AgentStatus | "all">("all");

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return MOCK_AGENTS.filter((row) => {
			if (statusFilter !== "all" && row.status !== statusFilter) return false;
			if (needle === "") return true;
			return (
				row.name.toLowerCase().includes(needle) ||
				row.description.toLowerCase().includes(needle) ||
				row.modelId.toLowerCase().includes(needle) ||
				row.tools.some((tool) => tool.toLowerCase().includes(needle))
			);
		});
	}, [query, statusFilter]);

	const totalCount = MOCK_AGENTS.length;
	const draftCount = MOCK_AGENTS.filter((r) => r.status === "draft").length;
	const totalTools = MOCK_AGENTS.reduce((sum, r) => sum + r.tools.length, 0);

	return (
		<section aria-label="Agent 列表">
			<header className="list-page-header">
				<div className="list-page-header__lead">
					<h1>Agent</h1>
					<p>
						一个 Agent 代表可复用、可版本化的 AI 能力单元：模型、提示词、工具、知识库与运行参数。
						每次保存都会生成不可变的 Revision，发布给用户时再绑定到具体的应用。
					</p>
				</div>
				<button type="button" className="primary" onClick={() => navigate("/agents")}>
					+ 创建 Agent
				</button>
			</header>

			<div className="mock-data-banner" role="note">
				<span>当前为 Mock Data 预览，字段结构用于锁定设计与信息架构，下一步接入 Control API。</span>
			</div>

			<div className="list-toolbar">
				<div className="list-toolbar__search">
					<input
						type="search"
						placeholder="按名称 / 描述 / 模型 / 工具搜索"
						aria-label="搜索 Agent"
						value={query}
						onChange={(e) => setQuery(e.currentTarget.value)}
					/>
				</div>
				<select
					aria-label="状态筛选"
					value={statusFilter}
					onChange={(e) => setStatusFilter(e.currentTarget.value as AgentStatus | "all")}
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
					<strong>{totalCount}</strong>个 Agent
				</span>
				<span>
					<strong>{draftCount}</strong>个有未保存草稿
				</span>
				<span>
					<strong>{totalTools}</strong>个 Tool 总数
				</span>
			</div>

			{filtered.length === 0 ? (
				<div className="data-table-empty">
					<h3>没有匹配的 Agent</h3>
					<p>尝试调整搜索关键词或筛选条件。</p>
				</div>
			) : (
				<table className="data-table">
					<thead>
						<tr>
							<th className="col-name">名称</th>
							<th className="col-description">描述</th>
							<th>模型</th>
							<th className="col-tools">Tools</th>
							<th>Revision</th>
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
										<span className="list-row-glyph agent" aria-hidden="true">
											{row.name.slice(0, 1)}
										</span>
										<div className="list-title-block">
											<button
												type="button"
												className="agent-name"
												onClick={() => navigate(`/agents/${row.id}`)}
											>
												{row.name}
											</button>
											<span className="list-title-id">id: {row.id}</span>
										</div>
									</div>
								</td>
								<td className="col-description">
									<span className="list-description-text">{row.description}</span>
								</td>
								<td>
									<span className="col-mono">{row.modelId}</span>
								</td>
								<td className="col-tools">
									<ul className="tool-chip-list" aria-label={`${row.name} 包含的工具`}>
										{row.tools.map((tool) => (
											<li key={tool} className="tool-chip" title={tool}>
												{tool}
											</li>
										))}
										{row.tools.length === 0 && <li className="tool-chip tool-chip--empty">未配置</li>}
									</ul>
								</td>
								<td>
									<span className="col-mono">v{row.revision}</span>
								</td>
								<td>
									<span
										className={`badge status-${row.status === "active" ? "active" : row.status === "draft" ? "draft" : "archived"}`}
									>
										{STATUS_LABEL[row.status]}
									</span>
								</td>
								<td>
									<div className="list-title-block">
										<span>{row.updatedAt}</span>
										<span className="list-title-sub">by {row.updatedBy}</span>
									</div>
								</td>
								<td>
									<div className="row-actions">
										<button type="button" title="编辑 Agent 配置">
											编辑
										</button>
										<button type="button" title="查看 Revision 历史">
											修订
										</button>
										<button
											type="button"
											title="复制 Agent ID"
											onClick={() => {
												if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
													void navigator.clipboard.writeText(row.id);
												}
											}}
										>
											复制
										</button>
										<AgentMoreMenu
											onExport={() => {
												window.alert(`导出 Agent「${row.name}」的配置（占位动作）`);
											}}
											onArchive={() => {
												window.alert(`归档 Agent「${row.name}」（占位动作）`);
											}}
										/>
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
