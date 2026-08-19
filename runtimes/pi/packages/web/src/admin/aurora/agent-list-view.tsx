/**
 * Agent List — Aurora 视觉迁移（v2，去掉外层套壳与筛选栏）。
 *
 * v2 简化布局：去掉 v1 的 SideRail + PillTabs 类别筛选 + 外层 canvas
 * 卡片套壳，section 直接铺在 .admin-shell__main 内；PageHeader 仅保留
 * 右上「新建 Agent」操作，下方即紧凑表格 + 分页。
 *
 * 数据沿用既有 MOCK_AGENTS（status / modelId / tools / revision /
 * updatedAt / updatedBy 字段不变）；后续接入 AgentApi 时只替换数据源，
 * 组件结构与布局不再变更。
 */
import type { AgentPublicId } from "@earendil-works/pi-protocol";
import { useMemo, useState } from "react";
import { navigate } from "../router.ts";
import styles from "./agent-list-view.module.css";
import { AuroraButton, AuroraPill } from "./index.ts";

type AgentStatus = "active" | "draft" | "archived";

interface AgentRow {
	readonly id: AgentPublicId;
	readonly name: string;
	readonly description: string;
	readonly modelId: string;
	readonly tools: readonly string[];
	readonly revision: number;
	readonly status: AgentStatus;
	readonly sessionsToday: number;
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
		sessionsToday: 1247,
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
		sessionsToday: 412,
		updatedAt: "2026-08-12 09:14",
		updatedBy: "bob@example.com",
	},
	{
		id: "agent_demo_data_analyst" as AgentPublicId,
		name: "数据分析 Agent",
		description: "支持自然语言查询数据库，输出 SQL 与可视化图表。",
		modelId: "claude-sonnet-4.5",
		tools: ["SQL 生成", "Schema 检索", "可视化图表", "数据采样", "异常检测"],
		revision: 21,
		status: "draft",
		sessionsToday: 128,
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
		sessionsToday: 87,
		updatedAt: "2026-08-10 14:48",
		updatedBy: "alice@example.com",
	},
	{
		id: "agent_demo_sales" as AgentPublicId,
		name: "销售助手",
		description: "辅助销售跟进客户、生成报价与会议纪要。",
		modelId: "claude-sonnet-4.5",
		tools: ["客户画像", "报价生成", "会议纪要", "邮件草稿"],
		revision: 9,
		status: "active",
		sessionsToday: 341,
		updatedAt: "2026-08-09 16:22",
		updatedBy: "dave@example.com",
	},
	{
		id: "agent_demo_voice_concierge" as AgentPublicId,
		name: "语音客服",
		description: "实时语音对话，支持多语种识别与打断处理。",
		modelId: "claude-sonnet-4.5",
		tools: ["语音识别", "TTS", "多语种", "打断处理"],
		revision: 4,
		status: "draft",
		sessionsToday: 0,
		updatedAt: "2026-08-14 11:05",
		updatedBy: "carol@example.com",
	},
	{
		id: "agent_demo_internal_assistant" as AgentPublicId,
		name: "内部知识助手",
		description: "面向员工，集成 wiki / 工单 / 表单检索。",
		modelId: "claude-haiku-4.5",
		tools: ["Wiki 检索", "工单创建", "日历读取"],
		revision: 3,
		status: "archived",
		sessionsToday: 0,
		updatedAt: "2026-06-30 11:11",
		updatedBy: "alice@example.com",
	},
];

function statusMetaLeft(row: AgentRow): React.ReactNode {
	if (row.status === "active") {
		return (
			<AuroraPill tone="live">
				<span>Live</span>
				<span style={{ opacity: 0.7 }}>· v{row.revision}</span>
			</AuroraPill>
		);
	}
	if (row.status === "draft") {
		return (
			<AuroraPill tone="amber">
				<span>v{row.revision}</span>
				<span style={{ opacity: 0.75 }}>· 草稿</span>
			</AuroraPill>
		);
	}
	return (
		<AuroraPill tone="neutral">
			<span>已归档</span>
			<span style={{ opacity: 0.7 }}>· v{row.revision}</span>
		</AuroraPill>
	);
}

export function AgentListView(): React.ReactElement {
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(9);

	const counts = useMemo(() => {
		const byStatus = (s: AgentStatus) => MOCK_AGENTS.filter((r) => r.status === s).length;
		return {
			total: MOCK_AGENTS.length,
			active: byStatus("active"),
			draft: byStatus("draft"),
			archived: byStatus("archived"),
		};
	}, []);

	const totalPages = Math.max(1, Math.ceil(MOCK_AGENTS.length / pageSize));
	const safePage = Math.min(page, totalPages);
	const pagedRows = MOCK_AGENTS.slice((safePage - 1) * pageSize, safePage * pageSize);

	return (
		<section className={styles.shell} aria-label="Agent 列表">
			<div className={styles.tableToolbar}>
				<AuroraButton
					variant="accent"
					size="md"
					onClick={() => navigate("/agents")}
					icon={
						<svg
							aria-hidden="true"
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
						>
							<path d="M12 5v14M5 12h14" />
						</svg>
					}
				>
					新建 Agent
				</AuroraButton>
			</div>

			<TableFallback rows={pagedRows} onOpen={(id) => navigate(`/agents/${id}`)} />

			<footer className={styles.footer}>
				<div className={styles.totalCount}>
					共 <strong>{counts.total}</strong> 个 Agent
					<span className={styles.totalSub}>
						· {counts.active} 已发布 · {counts.draft} 有草稿 · {counts.archived} 已归档
					</span>
				</div>
				<Pagination
					page={safePage}
					totalPages={totalPages}
					pageSize={pageSize}
					onPageChange={setPage}
					onPageSizeChange={(s) => {
						setPageSize(s);
						setPage(1);
					}}
				/>
			</footer>
		</section>
	);
}

// --------------------------------------------------------------------------
// 内部组件：TableFallback / Pagination
// --------------------------------------------------------------------------

interface TableFallbackProps {
	readonly rows: readonly AgentRow[];
	readonly onOpen: (id: AgentPublicId) => void;
}

/**
 * Agent 表格视图：去掉卡片切换后的唯一展示形式。
 * 后续可换成完整的 Aurora Table 组件，本次先保留轻量版。
 */
function TableFallback({ rows, onOpen }: TableFallbackProps): React.ReactElement {
	if (rows.length === 0) {
		return (
			<div className={styles.empty}>
				<div className={styles.emptyTitle}>没有匹配的 Agent</div>
				<div className={styles.emptyDesc}>尝试调整筛选条件。</div>
			</div>
		);
	}
	return (
		<div className={styles.tableWrap}>
			<table className={styles.table}>
				<colgroup>
					<col className={styles.colName} />
					<col className={styles.colModel} />
					<col className={styles.colStatus} />
					<col className={styles.colRevision} />
					<col className={styles.colSessions} />
					<col className={styles.colActions} />
				</colgroup>
				<thead>
					<tr>
						<th>名称</th>
						<th>模型</th>
						<th>状态</th>
						<th>修订</th>
						<th>今日会话</th>
						<th className={styles.colActions} />
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.id}>
							<td>
								<button type="button" className={styles.tableName} onClick={() => onOpen(row.id)}>
									{row.name}
								</button>
								<div className={styles.tableDesc}>{row.description}</div>
							</td>
							<td>
								<code className={styles.mono}>{row.modelId}</code>
							</td>
							<td>{statusMetaLeft(row)}</td>
							<td>
								<code className={styles.mono}>v{row.revision}</code>
							</td>
							<td className={styles.tabular}>{row.sessionsToday.toLocaleString()}</td>
							<td className={styles.colActions}>
								<AuroraButton variant="ghost" size="sm" onClick={() => onOpen(row.id)}>
									打开 →
								</AuroraButton>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

interface PaginationProps {
	readonly page: number;
	readonly totalPages: number;
	readonly pageSize: number;
	readonly onPageChange: (p: number) => void;
	readonly onPageSizeChange: (s: number) => void;
}

function Pagination({
	page,
	totalPages,
	pageSize,
	onPageChange,
	onPageSizeChange,
}: PaginationProps): React.ReactElement {
	const canPrev = page > 1;
	const canNext = page < totalPages;
	return (
		<div className={styles.pagination}>
			<button
				type="button"
				className={styles.pageBtn}
				disabled={!canPrev}
				onClick={() => onPageChange(page - 1)}
				aria-label="上一页"
			>
				‹
			</button>
			<span className={styles.pageInfo}>
				第 <strong>{page}</strong> / {totalPages} 页
			</span>
			<button
				type="button"
				className={styles.pageBtn}
				disabled={!canNext}
				onClick={() => onPageChange(page + 1)}
				aria-label="下一页"
			>
				›
			</button>
			<label className={styles.sizeBox}>
				每页
				<select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
					<option value={6}>6</option>
					<option value={9}>9</option>
					<option value={12}>12</option>
					<option value={24}>24</option>
				</select>
				条
			</label>
		</div>
	);
}
