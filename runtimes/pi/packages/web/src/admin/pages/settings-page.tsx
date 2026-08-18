/**
 * 设置页（WB-002 / SPEC §9；MVP-07 收口）— 设计收口（v2 视觉）。
 *
 * 显示真实 Tenant、Base URL、连接状态，并允许切换 Base URL。切换 Base URL
 * 会使旧 Token / Tenant 失效——本页用二次确认明确告知后调用 `setBaseUrl`，
 * controller 随即清空内存 token + tenant 数据并回到 locked 态，需针对新
 * baseUrl 重新解锁。Token 只存内存，绝不出现在本页或任何 Storage。
 */
import { useState } from "react";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { Badge } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { PageHeader } from "../components/PageHeader.tsx";

const inputStyle: React.CSSProperties = {
	padding: "9px 12px",
	border: "1px solid var(--admin-border-default)",
	borderRadius: "var(--admin-radius-md)",
	background: "var(--admin-bg-surface)",
	color: "var(--admin-text-primary)",
	font: "inherit",
	fontSize: 14,
	outline: "none",
	boxSizing: "border-box",
	width: "100%",
};

const codeStyle: React.CSSProperties = {
	fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
	fontSize: 12,
	color: "var(--admin-text-secondary)",
	background: "var(--admin-bg-inset)",
	padding: "2px 6px",
	borderRadius: 4,
};

const settingsGridStyle: React.CSSProperties = {
	display: "grid",
	gridTemplateColumns: "120px 1fr",
	gap: "12px 16px",
	margin: 0,
};

const labelStyle: React.CSSProperties = {
	color: "var(--admin-text-muted)",
	fontSize: 13,
};

const valueStyle: React.CSSProperties = {
	margin: 0,
	color: "var(--admin-text-primary)",
	fontSize: 14,
};

export function AdminSettingsPage(): React.ReactElement {
	const { snapshot, lock, setBaseUrl } = useAdminAuth();
	const [draft, setDraft] = useState(snapshot.baseUrl);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const trimmedDraft = draft.replace(/\/+$/, "").trim();
	const dirty = trimmedDraft !== snapshot.baseUrl.replace(/\/+$/, "");

	const onChange = () => {
		if (trimmedDraft === "") {
			setError("Base URL 不能为空");
			return;
		}
		if (!/^https?:\/\/.+/i.test(trimmedDraft)) {
			setError("Base URL 必须以 http:// 或 https:// 开头");
			return;
		}
		setError(null);
		setConfirming(true);
	};

	const stateBadgeVariant: "success" | "warning" | "danger" | "neutral" =
		snapshot.state === "connected"
			? "success"
			: snapshot.state === "connecting"
				? "warning"
				: snapshot.state === "error"
					? "danger"
					: "neutral";

	return (
		<section style={{ display: "flex", flexDirection: "column", gap: 24 }}>
			<PageHeader
				title="设置"
				subtitle="管理控制台连接、租户与本地化配置。Token 仅存于浏览器内存，切换 Base URL 会立即清空。"
			/>

			<div
				style={{
					background: "var(--admin-bg-surface)",
					border: "1px solid var(--admin-border-soft)",
					borderRadius: "var(--admin-radius-xl)",
					padding: 24,
				}}
			>
				<h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600, color: "var(--admin-text-primary)" }}>
					连接
				</h3>
				<dl style={settingsGridStyle}>
					<dt style={labelStyle}>当前状态</dt>
					<dd style={valueStyle}>
						<Badge variant={stateBadgeVariant} dot={snapshot.state === "connected"}>
							{snapshot.state}
						</Badge>
					</dd>
					<dt style={labelStyle}>Base URL</dt>
					<dd style={valueStyle}>
						{snapshot.baseUrl ? <code style={codeStyle}>{snapshot.baseUrl}</code> : "（未设置）"}
					</dd>
					<dt style={labelStyle}>租户</dt>
					<dd style={valueStyle}>{snapshot.tenant?.name ?? "未关联"}</dd>
					<dt style={labelStyle}>Tenant ID</dt>
					<dd style={valueStyle}>
						{snapshot.tenant?.id ? <code style={codeStyle}>{snapshot.tenant.id}</code> : "—"}
					</dd>
				</dl>
			</div>

			<div
				style={{
					background: "var(--admin-bg-surface)",
					border: "1px solid var(--admin-border-soft)",
					borderRadius: "var(--admin-radius-xl)",
					padding: 24,
				}}
			>
				<h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 600, color: "var(--admin-text-primary)" }}>
					切换 Base URL
				</h3>
				<p
					style={{
						margin: "0 0 16px",
						color: "var(--admin-text-secondary)",
						fontSize: 13,
						lineHeight: 1.6,
					}}
				>
					切换 Base URL 会使当前 Token 与租户数据失效，需对新地址重新解锁。Token 仅存于内存，切换后立即清空。
				</p>
				<label
					htmlFor="settings-base-url"
					style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--admin-text-primary)" }}
				>
					<span style={{ fontWeight: 500 }}>Base URL</span>
					<input
						id="settings-base-url"
						style={inputStyle}
						value={draft}
						onChange={(e) => {
							setDraft(e.currentTarget.value);
							setError(null);
						}}
						placeholder="https://control.example.com"
					/>
				</label>
				{error !== null ? (
					<div
						role="alert"
						style={{
							marginTop: 12,
							background: "var(--admin-danger-soft)",
							color: "var(--admin-danger)",
							padding: "8px 12px",
							borderRadius: "var(--admin-radius-md)",
							fontSize: 13,
						}}
					>
						{error}
					</div>
				) : null}
				<div style={{ display: "flex", gap: 8, marginTop: 16 }}>
					<Button variant="primary" onClick={onChange} disabled={!dirty}>
						应用 Base URL
					</Button>
					<Button variant="secondary" onClick={() => lock()} disabled={snapshot.state === "locked"}>
						重新锁定
					</Button>
				</div>
			</div>

			{confirming ? (
				<div
					style={{
						position: "fixed",
						inset: 0,
						background: "rgba(31, 29, 26, 0.45)",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						zIndex: 50,
					}}
					role="presentation"
					onClick={() => setConfirming(false)}
				>
					<section
						role="dialog"
						aria-modal="true"
						aria-label="切换 Base URL 确认"
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => {
							if (e.key === "Escape") setConfirming(false);
						}}
						style={{
							background: "var(--admin-bg-surface)",
							borderRadius: "var(--admin-radius-2xl)",
							padding: 28,
							width: 480,
							maxWidth: "90vw",
							boxShadow: "var(--admin-shadow-xl)",
						}}
					>
						<h2
							style={{
								margin: "0 0 12px",
								fontSize: 17,
								fontWeight: 600,
								color: "var(--admin-text-primary)",
							}}
						>
							确认切换 Base URL
						</h2>
						<p
							style={{
								margin: "0 0 20px",
								color: "var(--admin-text-secondary)",
								fontSize: 14,
								lineHeight: 1.6,
							}}
						>
							切换到 <code style={codeStyle}>{trimmedDraft}</code> 后，当前管理员会话将立即锁定，旧 Token 与租户数据被清空。你需要用新地址重新解锁。
						</p>
						<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
							<Button variant="secondary" onClick={() => setConfirming(false)}>
								取消
							</Button>
							<Button
								variant="primary"
								onClick={() => {
									setConfirming(false);
									setBaseUrl(trimmedDraft);
								}}
							>
								确认切换
							</Button>
						</div>
					</section>
				</div>
			) : null}
		</section>
	);
}
