import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { usageCacheFor } from "../../src/admin/api/usage-cache.ts";
import { beijingDay } from "../../src/admin/beijing-time.ts";
import { AdminUsagePage } from "../../src/admin/pages/usage-page.tsx";
import { AdminAuthController } from "../../src/publishing/auth-controller.ts";

const auth = vi.hoisted(() => ({ current: null as unknown as AdminAuthController }));
vi.mock("../../src/admin/auth/admin-auth-context.tsx", () => ({
	useAdminAuth: () => ({ controller: auth.current, snapshot: auth.current.getSnapshot() }),
}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("shows cached data immediately on remount, without showing the loading state", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-17T02:00:00Z"));
	const controller = new AdminAuthController();
	auth.current = controller;
	controller.connect("token");
	await controller.completeConnection({ id: "tenant-a", name: "A" });
	const now = new Date();
	const from = new Date(Date.parse(`${beijingDay(now)}T00:00:00+08:00`) - 13 * 86400000);
	const summary = { period: { from: from.toISOString(), to: now.toISOString() }, generatedAt: now.toISOString() };
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: summary }), { status: 200 })));
	expect(renderToStaticMarkup(<AdminUsagePage />)).toContain("正在汇总用量");
	await usageCacheFor(controller).request(from);
	const html = renderToStaticMarkup(<AdminUsagePage />);
	expect(html).not.toContain("正在汇总用量");
	expect(html).toContain("更新于");
	controller.lock();
	controller.connect("new-token");
	await controller.completeConnection({ id: "tenant-a", name: "A" });
	expect(renderToStaticMarkup(<AdminUsagePage />)).toContain("正在汇总用量");
});
