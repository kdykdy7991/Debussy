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
 * `parseRoute` 中按最长前缀匹配；未知路径回落到 `chat`。
 */

import { ADMIN_WORKBENCH_ROUTES } from "@earendil-works/pi-protocol";
import { useEffect, useState } from "react";

export type AdminRouteId =
	| "chat"
	| "agents"
	| "agent-detail"
	| "apps"
	| "app-detail"
	| "usage"
	| "user-conversations"
	| "user-conversation-detail"
	| "settings";

export interface AdminRoute {
	readonly id: AdminRouteId;
	readonly path: string;
	readonly params: Readonly<Record<string, string>>;
}

const APP_PUBLIC_ID_PATTERN = /^app_[0-9a-fA-F-]{36}$/;
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
	if (path === r.conversation || path === "" || path === "/") {
		return { id: "chat", path: r.conversation, params: {} };
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
	if (path === r.apps) {
		return { id: "apps", path: r.apps, params: {} };
	}
	if (path.startsWith(`${r.apps}/`)) {
		const id = path.slice(r.apps.length + 1);
		if (APP_PUBLIC_ID_PATTERN.test(id)) {
			return { id: "app-detail", path: path, params: { appId: id } };
		}
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
	return { id: "chat", path: r.conversation, params: {} };
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
