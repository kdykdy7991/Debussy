/**
 * 设置页（WB-002 / SPEC §9；MVP-07 收口）— Aurora 视觉迁移。
 *
 * 显示真实 Tenant、Base URL、连接状态，并允许切换 Base URL。切换 Base URL
 * 会使旧 Token / Tenant 失效——本页用二次确认明确告知后调用 `setBaseUrl`，
 * controller 随即清空内存 token + tenant 数据并回到 locked 态，需针对新
 * baseUrl 重新解锁。Token 只存内存，绝不出现在本页或任何 Storage。
 */
import { AdminSettingsView } from "../aurora/settings-view.tsx";

export function AdminSettingsPage(): React.ReactElement {
	return <AdminSettingsView />;
}
