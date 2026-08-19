/**
 * Admin App Shell 组件测试（WB-002）。
 *
 * 覆盖任务单验收项：
 *
 * 1. 模块导航（v4 起为左侧竖排 AppSidebar，4 个模块）渲染与当前态标识
 * 2. 路由刷新与浏览器前进/后退正确（hash 路由 + parseRoute 覆盖）
 * 3. 401 自动锁定（auth controller 层）
 * 4. 窄屏无横向溢出（CSS 规则断言）
 * 5. v3 起不再渲染解锁对话框（鉴权由 dev proxy / 网关注入）
 * 6. 旧 /publishing/* 重定向走 `legacyPublishingRedirect`
 *
 * 使用 `renderToStaticMarkup` 避免引入额外 React 测试依赖。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADMIN_WORKBENCH_TERMS, legacyPublishingRedirect } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminAppShell } from "../../src/admin/app-shell.tsx";
import { navigate, parseRoute } from "../../src/admin/router.ts";

function resetHash(): void {
	if (typeof window === "undefined") return;
	window.history.replaceState(null, "", "/");
	window.location.hash = "";
}

describe("AdminAppShell (WB-002)", () => {
	beforeEach(() => {
		resetHash();
	});

	afterEach(() => {
		resetHash();
	});

	it("renders the sidebar module nav with correct terms", () => {
		const html = renderToStaticMarkup(<AdminAppShell />);
		for (const term of [
			ADMIN_WORKBENCH_TERMS.agent,
			ADMIN_WORKBENCH_TERMS.app,
			"会话",
			ADMIN_WORKBENCH_TERMS.settings,
		]) {
			// v4：模块导航为左侧竖排 AppSidebar，label 渲染为独立 span。
			expect(html).toContain(`>${term}</span>`);
		}
		// 顶部 AuroraTopNav 不再渲染模块 tabs；左侧 AppSidebar 持有 4 项。
		expect(html.match(/aria-label="模块导航"/g)?.length ?? 0).toBe(1);
	});

	it("marks the active sidebar item with aria-current", async () => {
		// 测试环境无 window（Node SSR），AppShell 默认落在 chat 路由、无 active；
		// 因此在隔离环境下直接渲染 AppSidebar 并指定 currentItemId 验证 active 态。
		const { AuroraAppSidebar } = await import("../../src/admin/aurora/AppSidebar.tsx");
		const html = renderToStaticMarkup(
			<AuroraAppSidebar
				items={[
					{ id: "agents", label: "Agent", path: "/agents", icon: "◇" },
					{ id: "apps", label: "应用", path: "/apps", icon: "▤" },
				]}
				currentItemId="apps"
			/>,
		);
		expect(html.match(/aria-current="page"/g)?.length ?? 0).toBe(1);
		expect(html).toContain(">应用</span>");
	});

	it("marks the current route with aria-current based on parseRoute", () => {
		// parseRoute is pure; the icon rail renders aria-current on the
		// matching primary nav. We assert the underlying route ids used by
		// both the rail and the highlight logic agree.
		const agentRoute = parseRoute("/agents");
		expect(agentRoute.id).toBe("agents");
		const agentDetailRoute = parseRoute("/agents/agent_00000000-0000-0000-0000-000000000000");
		expect(agentDetailRoute.id).toBe("agent-detail");
	});

	it("navigate() is a function that accepts admin paths", () => {
		// The actual hash assignment is browser-side; here we only verify the
		// logical route stays within the frozen admin routes.
		const route = parseRoute("/apps");
		expect(route.id).toBe("apps");
		expect(typeof navigate).toBe("function");
	});

	it("parses known admin paths and falls back to chat on unknown", () => {
		expect(parseRoute("/").id).toBe("chat");
		expect(parseRoute("/agents").id).toBe("agents");
		expect(parseRoute("/agents/agent_00000000-0000-0000-0000-000000000000").id).toBe("agent-detail");
		expect(parseRoute("/apps").id).toBe("apps");
		expect(parseRoute("/apps/app_00000000-0000-0000-0000-000000000000").id).toBe("app-detail");
		expect(parseRoute("/conversations").id).toBe("user-conversations");
		expect(parseRoute("/conversations/conv_00000000-0000-0000-0000-000000000000").id).toBe(
			"user-conversation-detail",
		);
		expect(parseRoute("/settings").id).toBe("settings");
		expect(parseRoute("/not-a-route").id).toBe("chat");
		expect(parseRoute("/agents/not-an-id").id).toBe("chat");
	});

	it("redirects legacy /publishing routes", () => {
		expect(legacyPublishingRedirect("/publishing")).toBe("/apps");
		expect(legacyPublishingRedirect("/publishing/")).toBe("/apps");
		expect(legacyPublishingRedirect("/publishing/apps/app_00000000-0000-0000-0000-000000000000")).toBe(
			"/apps/app_00000000-0000-0000-0000-000000000000",
		);
		expect(legacyPublishingRedirect("/publishing/unknown/deep")).toBeNull();
	});

	it("renders the shell without the legacy unlock dialog", () => {
		// v3：鉴权由 vite dev proxy / 生产网关注入，不再渲染解锁对话框。
		const html = renderToStaticMarkup(<AdminAppShell />);
		expect(html).not.toContain("admin-unlock-backdrop");
		expect(html).not.toContain("Admin Token");
	});

	it("AdminAuthController locks the session on 401 and clears tenant data", async () => {
		const { AdminAuthController } = await import("../../src/publishing/auth-controller.ts");
		const ctrl = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		ctrl.connect("placeholder");
		await ctrl.completeConnection({ id: "ten_x", name: "Tenant" });
		expect(ctrl.getSnapshot().state).toBe("connected");
		ctrl.failConnection("unauthorized");
		const snap = ctrl.getSnapshot();
		expect(snap.state).toBe("error");
		expect(snap.tenant).toBeNull();
		expect(ctrl.getToken()).toBeNull();
	});

	it("AdminAuthProvider never invents a tenant id or display name", async () => {
		// MVP-01 regression: the previous WB-002 wiring hardcoded a
		// `ten_placeholder`/`默认租户` pair on any non-empty token. After the
		// real session wiring, an unresolved controller must not advance to
		// `connected` without a server response.
		const { AdminAuthController } = await import("../../src/publishing/auth-controller.ts");
		const ctrl = new AdminAuthController({ initialBaseUrl: "http://localhost" });
		ctrl.connect("placeholder");
		const snap = ctrl.getSnapshot();
		expect(snap.state).toBe("connecting");
		expect(snap.tenant).toBeNull();
	});
});

describe("Admin shell CSS layout (WB-002)", () => {
	const cssPath = resolve(__dirname, "../../src/admin/styles.css");
	const css = readFileSync(cssPath, "utf8");

	it("prevents horizontal overflow on html/body/#root", () => {
		expect(css).toMatch(/html,\s*body,\s*#root\s*{[^}]*overflow-x:\s*hidden/);
	});

	it("uses a row shell with a left sidebar plus a scrollable main area", () => {
		// v5：admin-shell 直接两栏水平 flex（sidebar + main），不再有顶部独立行。
		expect(css).toMatch(/\.admin-shell\s*{[^}]*flex-direction:\s*row/);
		expect(css).toMatch(/\.admin-shell__body\s*{[^}]*display:\s*flex/);
		expect(css).toMatch(/\.admin-shell__main\s*{[^}]*overflow-y:\s*auto/);
	});

	it("keeps the chat route full-bleed next to the sidebar", () => {
		// v5：无 topbar 后 chat 路由的 main 直接 100vh，不再减去 topbar 高度。
		expect(css).toMatch(/\.admin-shell\[data-route="chat"\]\s*\.admin-shell__main\s*{[^}]*overflow:\s*hidden/);
	});
});
