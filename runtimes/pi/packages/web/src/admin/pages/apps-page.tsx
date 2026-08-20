/**
 * App 列表与详情入口（WB-004 / SPEC §5.3；MVP-15 设计收口；v2 = Aurora）。
 *
 * - 列表：Aurora 视觉版，与 Agent List 共用同一 Design System
 * - 详情：`/apps/app_<uuid>` 由 `AdminAppDetail` 接管
 *
 * 列表和详情均连接 Control API；详情内按管理员任务收敛为概览、版本与上线、
 * 接入与安全、运行记录、危险操作五个区域。嵌入式对话仍保持独立构建入口。
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
