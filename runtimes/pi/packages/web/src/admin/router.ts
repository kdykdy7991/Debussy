/**
 * Admin Workbench hash-based router（WB-002）。
 *
 * 选择 hash 路由而非 history API：
 *
 * - admin 部署到 `agent-admin.example.com`，无须为单页应用配置服务端
 *   history fallback；hash 永远由前端处理
 * - `/publishing` 等旧路径在 admin 入口已通过 vite dev 的 SPA fallback
 *   加载 `index.html`；hash 路由接管后所有切换都在 `#` 之后
 * - 刷新与浏览器前进/后退通过 `hashchange` 事件 + `window.location.hash`
 *   自然恢复，依赖 SPEC §4.1 冻结的 `ADMIN_WORKBENCH_ROUTES`
 *
 * 路径只使用 `path` 字段（去掉 `?query` 与 `#hash`），route id 解析在
 * `parseRoute` 中按最长前缀匹配；空路径 / `/` 走 Agent 列表（Chat 入口
 * 已从侧边栏移除，新的默认工作台落点是 Agent 列表）；`/chat` 仍保留
 * 直达路由，作为 Agent 模块下的上下文调试页（不单列侧边栏入口）；
 * 未知路径回落到 Agent 列表。
 */

import { ADMIN_WORKBENCH_ROUTES } from "@earendil-works/pi-protocol";
import { useEffect, useState } from "react";

export type AdminRouteId =
	| "chat"
	| "agents"
	| "agent-detail"
	| "skills"
	| "mcp"
	| "usage"
	| "user-conversations"
	| "user-conversation-detail"
	| "settings";

export interface AdminRoute {
	readonly id: AdminRouteId;
	readonly path: string;
	readonly params: Readonly<Record<string, string>>;
}

const AGENT_PUBLIC_ID_PATTERN = /^agent_[0-9a-fA-F-]{36}$/;
const CONV_PUBLIC_ID_PATTERN = /^conv_[0-9a-fA-F-]{36}$/;

function stripHashAndQuery(rawHash: string): string {
	const qIdx = rawHash.indexOf("?");
	const path = qIdx === -1 ? rawHash : rawHash.slice(0, qIdx);
	if (path.length > 0 && path.startsWith("#")) return path.slice(1);
	return path;
}

function readHash(): string {
	if (typeof window === "undefined") return "/";
	const hash = window.location.hash;
	return stripHashAndQuery(hash.length > 0 ? hash : "#/");
}

export function parseRoute(path: string): AdminRoute {
	const r = ADMIN_WORKBENCH_ROUTES;
	// 默认入口：空路径 / `/` 走 Agent 列表。Chat 入口已从侧边栏移除，
	// 不再让未带路径的工作台落进一个没有导航的孤岛页面。
	if (path === "" || path === "/" || path === r.conversation) {
		return { id: "agents", path: r.agents, params: {} };
	}
	// 保留 `/chat` 直达路由，给 Agent 详情页的“调试”操作一个稳定着陆点。
	// 侧边栏不显示 Chat 项；Shell 会继续高亮 Agent，表明页面归属。
	if (path === "/chat") {
		return { id: "chat", path: "/chat", params: {} };
	}
	if (path === r.agents) {
		return { id: "agents", path: r.agents, params: {} };
	}
	if (path.startsWith(`${r.agents}/`)) {
		const id = path.slice(r.agents.length + 1);
		if (AGENT_PUBLIC_ID_PATTERN.test(id)) {
			return { id: "agent-detail", path: path, params: { agentId: id } };
		}
	}
	if (path === "/skills") {
		return { id: "skills", path, params: {} };
	}
	if (path === "/mcp") {
		return { id: "mcp", path, params: {} };
	}
	if (path === r.usage) {
		return { id: "usage", path: r.usage, params: {} };
	}
	if (path === r.userConversations) {
		return { id: "user-conversations", path: r.userConversations, params: {} };
	}
	if (path.startsWith(`${r.userConversations}/`)) {
		const id = path.slice(r.userConversations.length + 1);
		if (CONV_PUBLIC_ID_PATTERN.test(id)) {
			return {
				id: "user-conversation-detail",
				path,
				params: { conversationId: id },
			};
		}
	}
	if (path === r.settings) {
		return { id: "settings", path: r.settings, params: {} };
	}
	return { id: "agents", path: r.agents, params: {} };
}

export function navigate(to: string): void {
	if (typeof window === "undefined") return;
	const target = to.startsWith("#") ? to : `#${to.startsWith("/") ? to : `/${to}`}`;
	if (window.location.hash !== target) {
		window.location.hash = target;
	}
}

export function useAdminRoute(): AdminRoute {
	const [route, setRoute] = useState<AdminRoute>(() => parseRoute(readHash()));
	useEffect(() => {
		const onChange = () => setRoute(parseRoute(readHash()));
		window.addEventListener("hashchange", onChange);
		return () => window.removeEventListener("hashchange", onChange);
	}, []);
	return route;
}
