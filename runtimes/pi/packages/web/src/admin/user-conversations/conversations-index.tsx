/**
 * WB-006: administrator user-conversation list page (SPEC §5.4).
 *
 * Fetches the redacted cross-owner list from the control plane and exposes
 * the delivery-1 filters (status / principal type / hasErrors) plus a local
 * free-text search over title / app / principal display id. The response is
 * always redacted (`redacted: true`) — message bodies live on the detail
 * page's Event Log tab, where reading them is audited server-side.
 */
import type { ConversationAdminListResponse } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationsApi } from "../api/conversations-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";

type ListState =
	| { kind: "loading" }
	| { kind: "loaded"; data: ConversationAdminListResponse }
	| { kind: "error"; message: string };

function statusLabel(status: string): string {
	switch (status) {
		case "active":
			return "进行中";
		case "archived":
			return "已归档";
		case "deleted":
			return "已删除";
		default:
			return status;
	}
}

function principalLabel(principalType: string): string {
	switch (principalType) {
		case "external_user":
			return "external_user";
		case "anonymous_visitor":
			return "anonymous_visitor";
		case "platform_user":
			return "platform_user";
		case "service":
			return "service";
		default:
			return principalType;
	}
}

export function AdminConversationsIndex(): React.ReactElement {
	const { controller } = useAdminAuth();
	const api = useRef(new ConversationsApi({ auth: controller })).current;
	const [state, setState] = useState<ListState>({ kind: "loading" });
	const [statusFilter, setStatusFilter] = useState("");
	const [principalFilter, setPrincipalFilter] = useState("");
	const [errorFilter, setErrorFilter] = useState(false);
	const [query, setQuery] = useState("");

	const load = useCallback(
		(status: string, principal: string, hasErrors: boolean) => {
			setState({ kind: "loading" });
			void api
				.list({
					limit: 50,
					status: status === "" ? undefined : (status as "active" | "archived" | "deleted"),
					principalType: principal === "" ? undefined : (principal as "external_user" | "anonymous_visitor"),
					hasErrors,
				})
				.then(
					(data) => setState({ kind: "loaded", data }),
					(err: Error) => setState({ kind: "error", message: err.message }),
				);
		},
		[api],
	);

	useEffect(() => {
		load(statusFilter, principalFilter, errorFilter);
	}, [load, statusFilter, principalFilter, errorFilter]);

	const rows = useMemo(() => {
		if (state.kind !== "loaded") return [];
		const needle = query.trim().toLowerCase();
		if (!needle) return state.data.items;
		return state.data.items.filter(
			(item) =>
				item.title.toLowerCase().includes(needle) ||
				item.principalDisplayId.toLowerCase().includes(needle) ||
				item.appName.toLowerCase().includes(needle),
		);
	}, [state, query]);

	return (
		<section>
			<h1>用户会话</h1>
			<div className="card">
				<div className="conversation-filters">
					<label>
						状态
						<select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
							<option value="">全部</option>
							<option value="active">进行中</option>
							<option value="archived">已归档</option>
							<option value="deleted">已删除</option>
						</select>
					</label>
					<label>
						主体类型
						<select value={principalFilter} onChange={(e) => setPrincipalFilter(e.target.value)}>
							<option value="">全部</option>
							<option value="external_user">注册用户</option>
							<option value="anonymous_visitor">匿名访客</option>
						</select>
					</label>
					<label>
						<input type="checkbox" checked={errorFilter} onChange={(e) => setErrorFilter(e.target.checked)} />
						仅错误会话
					</label>
					<input
						type="search"
						placeholder="按标题 / 主体 / 应用筛选"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</div>

				{state.kind === "loading" && <p>加载中…</p>}
				{state.kind === "error" && (
					<div className="banner error">
						加载失败：{state.message}{" "}
						<button type="button" onClick={() => load(statusFilter, principalFilter, errorFilter)}>
							重试
						</button>
					</div>
				)}
				{state.kind === "loaded" && (
					<table className="conversation-table">
						<thead>
							<tr>
								<th>应用</th>
								<th>标题</th>
								<th>主体</th>
								<th>状态</th>
								<th>消息</th>
								<th>错误</th>
								<th>最后活跃</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((item) => (
								<tr
									key={item.id}
									className="conversation-row"
									onClick={() => navigate(`/conversations/${item.id}`)}
								>
									<td>
										{item.appName}
										<span className="conversation-id">{item.id}</span>
									</td>
									<td>{item.title || "（无标题）"}</td>
									<td title={principalLabel(item.principalType)}>{principalLabel(item.principalType)}</td>
									<td>{statusLabel(item.status)}</td>
									<td>{item.messageCount}</td>
									<td>{item.errorCount > 0 ? <span className="error-count">{item.errorCount}</span> : "0"}</td>
									<td>{new Date(item.lastActiveAt).toLocaleString()}</td>
								</tr>
							))}
							{rows.length === 0 && (
								<tr>
									<td colSpan={7} className="empty-cell">
										没有匹配的会话
									</td>
								</tr>
							)}
						</tbody>
					</table>
				)}
			</div>
			<nav className="conversation-pagination">
				{state.kind === "loaded" &&
					(state.data.nextCursor !== null ? (
						<button
							type="button"
							onClick={() => {
								void api.list({ limit: 50, cursor: state.data.nextCursor as string }).then(
									(data) => setState({ kind: "loaded", data }),
									(e: unknown) => setState({ kind: "error", message: (e as Error).message }),
								);
							}}
						>
							下一页
						</button>
					) : (
						<span>已到末尾</span>
					))}
			</nav>
		</section>
	);
}
