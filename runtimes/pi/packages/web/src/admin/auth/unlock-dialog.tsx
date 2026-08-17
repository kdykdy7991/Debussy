/**
 * 解锁对话框（WB-002 / SPEC §9.1）。
 *
 * 当 AdminAuthController 处于 `locked` / `error` 时显示。提交 token
 * 调 `unlock()`。**任何时候不写 Storage、URL、console 或异常**。
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
		<div className="admin-unlock-backdrop" role="dialog" aria-modal="true" aria-labelledby="admin-unlock-title">
			<form className="admin-unlock-card" onSubmit={onSubmit}>
				<h2 id="admin-unlock-title">管理员工作台</h2>
				<p style={{ margin: "0 0 12px", color: "#6b665b", fontSize: 13 }}>
					请输入 Admin Token。Token 仅保存在浏览器内存，刷新后需重新输入。
				</p>
				<label htmlFor="admin-token" style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
					Admin Token
				</label>
				<input
					id="admin-token"
					name="admin-token"
					type="password"
					autoComplete="off"
					spellCheck={false}
					value={token}
					onChange={(e) => setToken(e.currentTarget.value)}
					required
				/>
				{snapshot.error !== null ? <div className="error">{snapshot.error}</div> : null}
				{error !== null ? <div className="error">{error}</div> : null}
				<div className="actions">
					<button type="submit" disabled={busy || token.trim() === ""}>
						{busy ? "验证中…" : "解锁"}
					</button>
				</div>
			</form>
		</div>
	);
}
