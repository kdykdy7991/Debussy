/**
 * Admin Web 入口（WB-001 / 规格 10.3、16；WB-002 Shell 框架）。
 *
 * 单一进程内承担管理员工作台与原内部 Pi Web App（管理员调试对话）。
 * 部署目标 `agent-admin.example.com`；Embed Web 走独立入口 `embed/main.tsx`。
 *
 * 路由：
 *
 * - `/embed/*` 不在此入口处理；管理员若误访问会被静默 fallback 到 Shell
 * - 其它路径：Admin Workbench Shell（图标栏、模块侧栏、主区、右侧抽屉）
 *
 * 不依赖 Embed 任何模块；publishing/ 与 embed/ 在源码 import 图上不交叉。
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import "../ai-kit/styles/index.css";
import { AdminAppShell } from "./app-shell.tsx";
import "./styles.css";
import { AgentRedesignPreview } from "../ui-preview/agent-redesign.tsx";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Missing #root element");
}

const pathname = window.location.pathname;
const preview = new URLSearchParams(window.location.search).get("preview");
if (pathname.startsWith("/ui-preview/agent-redesign") || preview === "agent-redesign") {
	createRoot(root).render(
		<StrictMode>
			<AgentRedesignPreview />
		</StrictMode>,
	);
} else {
	createRoot(root).render(
		<StrictMode>
			<AdminAppShell />
		</StrictMode>,
	);
}
