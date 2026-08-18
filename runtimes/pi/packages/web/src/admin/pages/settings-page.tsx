/**
 * 设置页（WB-002 / SPEC §9；MVP-07 收口）。
 *
 * 显示真实 Tenant、Base URL、连接状态，并允许切换 Base URL。切换 Base URL
 * 会使旧 Token / Tenant 失效——本页用二次确认明确告知后调用 `setBaseUrl`，
 * controller 随即清空内存 token + tenant 数据并回到 locked 态，需针对新
 * baseUrl 重新解锁。Token 只存内存，绝不出现在本页或任何 Storage。
 */
import { useState } from "react";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";

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

	return (
		<section className="settings-page">
			<h1>设置</h1>

			<div className="card">
				<h3>连接</h3>
				<dl className="settings-grid">
					<dt>当前状态</dt>
					<dd>
						<span className={`badge status-${snapshot.state}`}>{snapshot.state}</span>
					</dd>
					<dt>Base URL</dt>
					<dd>
						<code>{snapshot.baseUrl || "（未设置）"}</code>
					</dd>
					<dt>租户</dt>
					<dd>{snapshot.tenant?.name ?? "未关联"}</dd>
					<dt>Tenant ID</dt>
					<dd>{snapshot.tenant?.id ? <code>{snapshot.tenant.id}</code> : "—"}</dd>
				</dl>
			</div>

			<div className="card">
				<h3>切换 Base URL</h3>
				<p className="settings-note">
					切换 Base URL 会使当前 Token 与租户数据失效，需对新地址重新解锁。Token 仅存于内存，切换后立即清空。
				</p>
				<label htmlFor="settings-base-url">Base URL</label>
				<input
					id="settings-base-url"
					value={draft}
					onChange={(e) => {
						setDraft(e.target.value);
						setError(null);
					}}
					placeholder="https://control.example.com"
				/>
				{error !== null && (
					<p role="alert" className="banner error">
						{error}
					</p>
				)}
				<div className="settings-actions">
					<button type="button" disabled={!dirty} onClick={onChange}>
						应用 Base URL
					</button>
					<button type="button" onClick={() => lock()} disabled={snapshot.state === "locked"}>
						重新锁定
					</button>
				</div>
			</div>

			{confirming && (
				<div className="drawer-backdrop" role="presentation">
					<section
						className="drawer"
						role="dialog"
						aria-modal="true"
						aria-label="切换 Base URL 确认"
						onKeyDown={(e) => {
							if (e.key === "Escape") setConfirming(false);
						}}
					>
						<h2>确认切换 Base URL</h2>
						<p>
							切换到 <code>{trimmedDraft}</code> 后，当前管理员会话将立即锁定，旧 Token 与租户数据被清空。
							你需要用新地址重新解锁。
						</p>
						<div className="drawer-actions">
							<button type="button" onClick={() => setConfirming(false)}>
								取消
							</button>
							<button
								type="button"
								className="primary"
								onClick={() => {
									setConfirming(false);
									setBaseUrl(trimmedDraft);
								}}
							>
								确认切换
							</button>
						</div>
					</section>
				</div>
			)}
		</section>
	);
}
