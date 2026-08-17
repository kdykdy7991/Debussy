/**
 * 设置页占位（WB-002 / SPEC §9）。
 *
 * 任务单范围仅交付 Shell 框架与路由。设置页负责 Admin Token 重新输入、
 * baseUrl 切换、租户/SSO 提示；具体能力在 WB-002 之后随 SSO 接入迭代。
 */
import { useAdminAuth } from "../auth/admin-auth-context.tsx";

export function AdminSettingsPage(): React.ReactElement {
	const { snapshot, lock } = useAdminAuth();
	return (
		<section>
			<h1>设置</h1>
			<dl>
				<dt>当前状态</dt>
				<dd>{snapshot.state}</dd>
				<dt>Base URL</dt>
				<dd>{snapshot.baseUrl}</dd>
				<dt>租户</dt>
				<dd>{snapshot.tenant?.name ?? "未关联"}</dd>
			</dl>
			<button type="button" onClick={() => lock()} disabled={snapshot.state === "locked"}>
				重新锁定
			</button>
		</section>
	);
}
