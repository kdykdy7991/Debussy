/**
 * 应用列表与详情占位（WB-002 / SPEC §5.3）。
 *
 * 任务单范围仅交付 Shell 框架与路由；PublishingApp 的子模块（app-list、
 * app-detail、version-panel、launch-key-panel、create-app-wizard、audit-panel）
 * 在 WB-004 中拆分迁移到本目录。旧 `/publishing/*` 已在 admin/main.tsx 顶层
 * 重定向到 `/apps` 与 `/apps/:appId`。
 */
import type { AdminRoute } from "../router.ts";

export function AdminAppsPage({ route }: { route: AdminRoute }): React.ReactElement {
	if (route.id === "app-detail") {
		return (
			<section>
				<h1>应用详情：{route.params.appId ?? ""}</h1>
				<div className="admin-shell__placeholder">应用详情由 WB-004 实施。</div>
			</section>
		);
	}
	return (
		<section>
			<h1>应用列表</h1>
			<div className="admin-shell__placeholder">应用列表由 WB-004 实施。</div>
		</section>
	);
}
