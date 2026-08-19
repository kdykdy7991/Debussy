/**
 * App List — Aurora 视觉迁移（v2，去套壳 + 表格视图，对齐 Agent List）。
 *
 * 视觉：tableToolbar（右上「新建应用」按钮） + 紧凑表格（名称 / 绑定 Agent /
 * Public ID / 状态 / 访问方式 / 今日会话 / 操作）+ Pagination。
 *
 * 数据沿用既有 MOCK_APPS（name / publicAppId / boundAgent / accessMode /
 * status / updatedAt 字段不变）；后续接 Control API 时只替换数据源。
 */
import { useMemo, useState } from "react";
import { navigate } from "../router.ts";
import styles from "./apps-list-view.module.css";
import { AuroraButton, AuroraPagination, AuroraPill } from "./index.ts";

type AppStatus = "active" | "draft" | "suspended" | "archived";
type AccessMode = "anonymous" | "signed_user" | "mixed";

interface AppRow {
	readonly id: string;
	readonly name: string;
	readonly publicAppId: string;
	readonly boundAgentName: string;
	readonly boundAgentId: string;
	readonly boundAgentRevision: number;
	readonly accessMode: AccessMode;
	readonly status: AppStatus;
	readonly sessionsToday: number;
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
		sessionsToday: 1247,
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
		sessionsToday: 412,
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
		sessionsToday: 128,
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
		sessionsToday: 87,
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
		sessionsToday: 0,
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
		sessionsToday: 341,
		updatedAt: "2026-08-10 14:48",
		updatedBy: "alice@example.com",
	},
	{
		id: "app_demo_007",
		name: "销售助手嵌入",
		publicAppId: "app_pub_a2b7c4f1",
		boundAgentName: "销售助手",
		boundAgentId: "agent_demo_sales",
		boundAgentRevision: 9,
		accessMode: "mixed",
		status: "active",
		sessionsToday: 256,
		updatedAt: "2026-08-09 16:22",
		updatedBy: "dave@example.com",
	},
	{
		id: "app_demo_008",
		name: "语音客服坐席",
		publicAppId: "app_pub_b3c8d5e2",
		boundAgentName: "语音客服",
		boundAgentId: "agent_demo_voice_concierge",
		boundAgentRevision: 4,
		accessMode: "anonymous",
		status: "draft",
		sessionsToday: 0,
		updatedAt: "2026-08-14 11:05",
		updatedBy: "carol@example.com",
	},
	{
		id: "app_demo_009",
		name: "内部知识助手（停用）",
		publicAppId: "app_pub_4d8e2a17",
		boundAgentName: "内部知识助手",
		boundAgentId: "agent_demo_internal_assistant",
		boundAgentRevision: 3,
		accessMode: "signed_user",
		status: "archived",
		sessionsToday: 0,
		updatedAt: "2026-06-30 11:11",
		updatedBy: "alice@example.com",
	},
];

const ACCESS_LABEL: Record<AccessMode, string> = {
	anonymous: "匿名访问",
	signed_user: "登录用户",
	mixed: "混合",
};

function appStatusBadge(status: AppStatus): React.ReactNode {
	if (status === "active") {
		return (
			<AuroraPill tone="live">
				<span>Live</span>
			</AuroraPill>
		);
	}
	if (status === "draft") {
		return (
			<AuroraPill tone="amber">
				<span>草稿</span>
			</AuroraPill>
		);
	}
	if (status === "suspended") {
		return (
			<AuroraPill tone="red">
				<span>已暂停</span>
			</AuroraPill>
		);
	}
	return (
		<AuroraPill tone="neutral">
			<span>已归档</span>
		</AuroraPill>
	);
}

export function AppsListView(): React.ReactElement {
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(9);

	const counts = useMemo(() => {
		const byStatus = (s: AppStatus) => MOCK_APPS.filter((r) => r.status === s).length;
		return {
			total: MOCK_APPS.length,
			active: byStatus("active"),
			draft: byStatus("draft"),
			suspended: byStatus("suspended"),
			archived: byStatus("archived"),
		};
	}, []);

	const totalPages = Math.max(1, Math.ceil(MOCK_APPS.length / pageSize));
	const safePage = Math.min(page, totalPages);
	const pagedRows = MOCK_APPS.slice((safePage - 1) * pageSize, safePage * pageSize);

	return (
		<section className={styles.shell} aria-label="应用列表">
			<div className={styles.tableToolbar}>
				<AuroraButton
					variant="accent"
					size="md"
					onClick={() => navigate("/apps")}
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
					新建应用
				</AuroraButton>
			</div>

			<AppsTableFallback rows={pagedRows} onOpen={(id) => navigate(`/apps/${id}`)} />

			<footer className={styles.footer}>
				<div className={styles.totalCount}>
					共 <strong>{counts.total}</strong> 个应用
					<span className={styles.totalSub}>
						· {counts.active} 已发布 · {counts.draft} 未发布 · {counts.suspended} 暂停 · {counts.archived} 归档
					</span>
				</div>
				<AuroraPagination
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
// 内部组件：AppsTableFallback
// --------------------------------------------------------------------------

interface AppsTableFallbackProps {
	readonly rows: readonly AppRow[];
	readonly onOpen: (id: string) => void;
}

/**
 * App 表格视图：紧凑行表，与 Agent 表格保持一致的列策略（名称列吃下剩余
 * 空间，操作列固定 120px 右对齐）。
 */
function AppsTableFallback({ rows, onOpen }: AppsTableFallbackProps): React.ReactElement {
	if (rows.length === 0) {
		return (
			<div className={styles.empty}>
				<div className={styles.emptyTitle}>没有匹配的应用</div>
				<div className={styles.emptyDesc}>尝试调整筛选条件。</div>
			</div>
		);
	}
	return (
		<div className={styles.tableWrap}>
			<table className={styles.table}>
				<colgroup>
					<col className={styles.colName} />
					<col className={styles.colPublicId} />
					<col className={styles.colAgent} />
					<col className={styles.colStatus} />
					<col className={styles.colAccess} />
					<col className={styles.colSessions} />
					<col className={styles.colActions} />
				</colgroup>
				<thead>
					<tr>
						<th>名称</th>
						<th>Public ID</th>
						<th>绑定 Agent</th>
						<th>状态</th>
						<th>访问方式</th>
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
								<div className={styles.tableDesc}>
									绑定 {row.boundAgentName} · v{row.boundAgentRevision}
								</div>
							</td>
							<td>
								<code className={styles.mono}>{row.publicAppId}</code>
							</td>
							<td>
								<span className={styles.colAgentName}>{row.boundAgentName}</span>
							</td>
							<td>{appStatusBadge(row.status)}</td>
							<td>
								<span className={styles.colAccessLabel}>{ACCESS_LABEL[row.accessMode]}</span>
							</td>
							<td className={styles.tabular}>
								{row.status === "archived" ? "—" : row.sessionsToday.toLocaleString()}
							</td>
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
