/**
 * App 列表与详情入口（WB-004 / SPEC §5.3；MVP-15 设计收口；v2 = Aurora）。
 *
 * - 列表：Aurora 视觉版，与 Agent List 共用同一 Design System
 * - 详情：`/apps/app_<uuid>` 由 `AdminAppDetail` 接管
 *
 * 说明：本轮先把 List 页面的信息架构与样式确定下来，「创建应用」「发布
 * 流程」「Dashboard summary」「Pending 版本」等深度页面留待后续迭代接入
 * Control API 时再补回（先前 `AdminAppsDashboard` 的仪表盘 / 创建弹窗 /
 * cursor 分页等复杂逻辑本轮暂不展示）。
 */

import { AdminAppDetail } from "../apps/app-detail.tsx";
import { AppsListView } from "../aurora/apps-list-view.tsx";
import type { AdminRoute } from "../router.ts";

export function AdminAppsPage({ route }: { route: AdminRoute }): React.ReactElement {
	if (route.id === "app-detail") {
		const appId = route.params.appId;
		if (appId === undefined) return <p role="alert">缺少 appId</p>;
		return <AdminAppDetail appId={appId} />;
	}
	return <AppsListView />;
}
