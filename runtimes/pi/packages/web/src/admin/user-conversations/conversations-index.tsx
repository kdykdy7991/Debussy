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
import { type ConversationListArgs, ConversationsApi } from "../api/conversations-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";
import { readInitialQueryParam } from "./query-params.ts";

type ListState =
	| { kind: "loading" }
	| { kind: "loaded"; data: ConversationAdminListResponse }
	| { kind: "error"; message: string };

/** Reads a query parameter from the current hash (e.g. `#/conversations?appId=...`). */
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
	const requestSequence = useRef(0);
	const [state, setState] = useState<ListState>({ kind: "loading" });
	const [statusFilter, setStatusFilter] = useState("");
	const [principalFilter, setPrincipalFilter] = useState("");
	const [errorFilter, setErrorFilter] = useState(false);
	const [query, setQuery] = useState("");
	const [appId, setAppId] = useState(() => readInitialQueryParam("appId"));
	const [agentId, setAgentId] = useState("");
	const [versionId, setVersionId] = useState("");
	const [createdAfter, setCreatedAfter] = useState("");
	const [createdBefore, setCreatedBefore] = useState("");
	const [cursor, setCursor] = useState<string | undefined>();
	const [cursorHistory, setCursorHistory] = useState<readonly (string | undefined)[]>([]);

	const filters = useMemo<ConversationListArgs>(
		() => ({
			limit: 50,
			status: statusFilter as ConversationListArgs["status"],
			principalType: principalFilter as ConversationListArgs["principalType"],
			hasErrors: errorFilter || undefined,
			appId,
			agentId,
			publishedAppVersionId: versionId,
			createdAfter: createdAfter === "" ? undefined : new Date(createdAfter).toISOString(),
			createdBefore: createdBefore === "" ? undefined : new Date(createdBefore).toISOString(),
		}),
		[agentId, appId, createdAfter, createdBefore, errorFilter, principalFilter, statusFilter, versionId],
	);

	const load = useCallback(
		(args: ConversationListArgs) => {
			const request = ++requestSequence.current;
			setState({ kind: "loading" });
			void api.list(args).then(
				(data) => {
					if (request === requestSequence.current) setState({ kind: "loaded", data });
				},
				(err: Error) => {
					if (request === requestSequence.current) setState({ kind: "error", message: err.message });
				},
			);
		},
		[api],
	);

	useEffect(() => {
		setCursor(undefined);
		setCursorHistory([]);
		load(filters);
	}, [filters, load]);

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
					<input placeholder="App ID" value={appId} onChange={(e) => setAppId(e.target.value)} />
					<input placeholder="Agent ID" value={agentId} onChange={(e) => setAgentId(e.target.value)} />
					<input placeholder="版本 ID" value={versionId} onChange={(e) => setVersionId(e.target.value)} />
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
					<label>
						开始时间
						<input type="datetime-local" value={createdAfter} onChange={(e) => setCreatedAfter(e.target.value)} />
					</label>
					<label>
						结束时间
						<input
							type="datetime-local"
							value={createdBefore}
							onChange={(e) => setCreatedBefore(e.target.value)}
						/>
					</label>
				</div>

				{state.kind === "loading" && <p>加载中…</p>}
				{state.kind === "error" && (
					<div className="banner error">
						加载失败：{state.message}{" "}
						<button type="button" onClick={() => load({ ...filters, cursor })}>
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
				{state.kind === "loaded" && cursorHistory.length > 0 && (
					<button
						type="button"
						onClick={() => {
							const previous = cursorHistory[cursorHistory.length - 1];
							setCursor(previous);
							setCursorHistory((items) => items.slice(0, -1));
							load({ ...filters, cursor: previous });
						}}
					>
						上一页
					</button>
				)}
				{state.kind === "loaded" &&
					(state.data.nextCursor !== null ? (
						<button
							type="button"
							onClick={() => {
								const next = state.data.nextCursor as string;
								setCursorHistory((items) => [...items, cursor]);
								setCursor(next);
								load({ ...filters, cursor: next });
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
