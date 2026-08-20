/**
 * 设置页 — Aurora 视觉迁移（v3，去除 Admin Token 输入）。
 *
 * 控制台不再让用户输入 Admin Token（鉴权由 vite dev proxy 或生产网关层
 * 负责注入），本页面因此简化为**只读**：
 * - 连接状态（来自 AdminAuthController 投影）
 * - 租户信息（来自 session endpoint 的 tenantId/tenantName）
 *
 * 旧的"重新锁定" / "切换 Base URL"两个 group 已删除（前者依赖 token、
 * 后者会让 token 清空）。如果未来需要重新引入锁定机制，请走另一种鉴权
 * 路径（例如服务端 session cookie），不要回到客户端输入 token。
 */

import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { CustomLlmSection } from "./custom-llm-section.tsx";
import { AuroraPageHeader, AuroraPill, AuroraSettingsGroup, type AuroraSettingsRow } from "./index.ts";
import styles from "./settings-view.module.css";

type SnapshotState = "connected" | "connecting" | "error" | "locked";

const STATE_PILL: Record<SnapshotState, { tone: "live" | "amber" | "red" | "neutral"; text: string }> = {
	connected: { tone: "live", text: "已连接" },
	connecting: { tone: "amber", text: "连接中" },
	error: { tone: "red", text: "连接失败" },
	locked: { tone: "neutral", text: "未连接" },
};

export function AdminSettingsView(): React.ReactElement {
	const { snapshot } = useAdminAuth();
	const pill = STATE_PILL[snapshot.state];

	const connectionRows: AuroraSettingsRow[] = [
		{
			id: "state",
			label: "当前状态",
			description:
				snapshot.state === "connecting"
					? "正在与 Control API 建立会话…"
					: snapshot.state === "error"
						? "会话校验失败，dev 模式下通常是 vite proxy 未读到 token 文件"
						: "与 Control API 的实时通信状态",
			control: <AuroraPill tone={pill.tone}>{pill.text}</AuroraPill>,
		},
		{
			id: "baseUrl",
			label: "Base URL",
			description: "当前 Admin Workbench 连接的 Control API 入口",
			control: snapshot.baseUrl ? (
				<code className={styles.code}>{snapshot.baseUrl}</code>
			) : (
				<span className={styles.muted}>未设置</span>
			),
		},
		{
			id: "tenant",
			label: "租户",
			description: "Token 解锁后从服务端获取的 Tenant 信息",
			control: snapshot.tenant?.name ? (
				<span className={styles.tenantInfo}>
					<span>{snapshot.tenant.name}</span>
					{snapshot.tenant.id ? <code className={styles.code}>{snapshot.tenant.id}</code> : null}
				</span>
			) : (
				<span className={styles.muted}>未关联</span>
			),
		},
	];

	return (
		<section className={styles.shell} aria-label="设置">
			<AuroraPageHeader title="设置" description="查看当前租户与 Control API 的连接状态。" />
			<AuroraSettingsGroup
				title="连接"
				description="与 Control API 的实时通信状态。"
				rows={connectionRows}
				footer={
					<p className={styles.footnote}>
						Admin Token 由 dev 脚本统一管理：开发模式下 vite proxy 自动从
						<code className={styles.codeInline}> PI_CONTROL_ADMIN_TOKEN_FILE </code>
						读取并以 Authorization 头注入；生产环境请配置网关层鉴权。
					</p>
				}
			/>
			<CustomLlmSection />
		</section>
	);
}
