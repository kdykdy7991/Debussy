/**
 * 解锁对话框（WB-002 / SPEC §9.1）— 设计收口（v2 视觉）。
 *
 * 视觉：暖白底 + 暖橘点缀，token 驱动，跨主题一致。
 * 任何时候不写 Storage / URL / console / 异常文本。
 */
import { useState } from "react";
import { useAdminAuth } from "./admin-auth-context.tsx";

export function AdminUnlockDialog(): React.ReactElement | null {
	const { snapshot, unlock } = useAdminAuth();
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (snapshot.state === "connected" || snapshot.state === "connecting") return null;

	const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await unlock(token);
			setToken("");
		} catch (err) {
			setError(err instanceof Error ? err.message : "解锁失败");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(31, 29, 26, 0.45)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 50,
				backdropFilter: "blur(2px)",
			}}
			role="dialog"
			aria-modal="true"
			aria-labelledby="admin-unlock-title"
		>
			<form
				style={{
					background: "var(--admin-bg-surface)",
					padding: 32,
					borderRadius: "var(--admin-radius-2xl)",
					width: 400,
					maxWidth: "90vw",
					boxShadow: "var(--admin-shadow-xl)",
					display: "flex",
					flexDirection: "column",
					gap: 16,
				}}
				onSubmit={onSubmit}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
					<span
						style={{
							width: 32,
							height: 32,
							borderRadius: "var(--admin-radius-md)",
							background: "var(--admin-text-primary)",
							color: "var(--admin-bg-surface)",
							display: "grid",
							placeItems: "center",
							fontWeight: 600,
							fontSize: 14,
						}}
						aria-hidden="true"
					>
						D
					</span>
					<h2
						id="admin-unlock-title"
						style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--admin-text-primary)" }}
					>
						管理员工作台
					</h2>
				</div>
				<p
					style={{
						margin: 0,
						color: "var(--admin-text-secondary)",
						fontSize: 13,
						lineHeight: 1.5,
					}}
				>
					请输入 Admin Token 以解锁控制台。Token 仅保存在浏览器内存，刷新后需重新输入。
				</p>
				<label
					htmlFor="admin-token"
					style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--admin-text-primary)" }}
				>
					<span style={{ fontWeight: 500 }}>Admin Token</span>
					<input
						id="admin-token"
						name="admin-token"
						type="password"
						autoComplete="off"
						spellCheck={false}
						style={{
							padding: "9px 12px",
							border: "1px solid var(--admin-border-default)",
							borderRadius: "var(--admin-radius-md)",
							background: "var(--admin-bg-surface)",
							color: "var(--admin-text-primary)",
							font: "inherit",
							fontSize: 14,
							outline: "none",
							boxSizing: "border-box",
						}}
						value={token}
						onChange={(e) => setToken(e.currentTarget.value)}
						required
					/>
				</label>
				{snapshot.error !== null ? (
					<div
						style={{
							background: "var(--admin-danger-soft)",
							color: "var(--admin-danger)",
							padding: "8px 12px",
							borderRadius: "var(--admin-radius-md)",
							fontSize: 13,
						}}
					>
						{snapshot.error}
					</div>
				) : null}
				{error !== null ? (
					<div
						style={{
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
				<div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
					<button
						type="submit"
						disabled={busy || token.trim() === ""}
						style={{
							padding: "9px 18px",
							border: 0,
							borderRadius: "var(--admin-radius-md)",
							background: busy || token.trim() === "" ? "var(--admin-neutral-soft)" : "var(--admin-text-primary)",
							color: busy || token.trim() === "" ? "var(--admin-text-muted)" : "var(--admin-text-inverse)",
							font: "inherit",
							fontSize: 14,
							fontWeight: 500,
							cursor: busy || token.trim() === "" ? "not-allowed" : "pointer",
						}}
					>
						{busy ? "验证中…" : "解锁"}
					</button>
				</div>
			</form>
		</div>
	);
}
