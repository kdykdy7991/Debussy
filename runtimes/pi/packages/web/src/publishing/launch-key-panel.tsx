/**
 * Launch Key panel (ADMIN-007 / PUBLISHING-ADMIN-CONSOLE §5.4).
 *
 * PEM 只在表单内存中存在：成功 / 取消 / 提交完成后立即清空；UI 永远不会
 * 展示已经提交的 PEM（响应只回 keyId/algorithm/status/times）。
 */
import { useState } from "react";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import type { PublishingController } from "./publishing-controller.ts";
import type { LaunchKeySummary } from "./types.ts";

export interface LaunchKeyPanelProps {
	readonly controller: PublishingController;
	readonly appId: string;
}

const PLACEHOLDER_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9Y9X/4X5X/4X5X/4X5X/4X5X/4X=
-----END PUBLIC KEY-----`;

export function LaunchKeyPanel({ controller, appId }: LaunchKeyPanelProps) {
	const snapshot = useSnapshot(controller);
	const [keyId, setKeyId] = useState("");
	const [pemInput, setPemInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [revokeTarget, setRevokeTarget] = useState<LaunchKeySummary | null>(null);

	const clearForm = () => {
		setKeyId("");
		setPemInput("");
		setError(null);
	};

	const submit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
			setError("keyId 必须匹配 [A-Za-z0-9._-]{1,64}");
			return;
		}
		if (!pemInput.includes("BEGIN PUBLIC KEY") || pemInput.includes("PRIVATE KEY")) {
			setError("只接受 PUBLIC KEY PEM；private key 一律拒绝");
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			await controller.createLaunchKey({ appId, keyId, publicKeyPem: pemInput });
			clearForm();
		} catch (err) {
			setPemInput("");
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div>
			<div className="pub-card">
				<h2>登记公钥</h2>
				<form onSubmit={submit}>
					<label>
						<span>keyId（宿主 Launch Token `kid`）</span>
						<input
							value={keyId}
							onChange={(event) => setKeyId(event.target.value)}
							placeholder="host-key-001"
							autoComplete="off"
						/>
					</label>
					<label>
						<span>SPKI 公钥 PEM</span>
						<textarea
							className="pem-textarea"
							value={pemInput}
							onChange={(event) => setPemInput(event.target.value)}
							placeholder={PLACEHOLDER_PEM}
							autoComplete="off"
							spellCheck={false}
						/>
						<small className="hint">提交后 PEM 仅在请求体内出现一次；服务端不会回传，UI 也不会保留。</small>
					</label>
					{error !== null ? <div className="banner error">{error}</div> : null}
					<div className="step-actions">
						<button className="pub-btn ghost" type="button" onClick={clearForm}>
							清空
						</button>
						<button className="pub-btn primary" type="submit" disabled={submitting}>
							{submitting ? "提交中…" : "登记并轮换"}
						</button>
					</div>
				</form>
			</div>

			<div className="pub-card">
				<h2>已登记 Key</h2>
				<table className="key-table">
					<thead>
						<tr>
							<th>keyId</th>
							<th>algorithm</th>
							<th>status</th>
							<th>notBefore</th>
							<th>expiresAt</th>
							<th>createdAt</th>
							<th>操作</th>
						</tr>
					</thead>
					<tbody>
						{snapshot.launchKeys.length === 0 ? (
							<tr>
								<td colSpan={7} style={{ textAlign: "center", color: "var(--pub-fg-muted)" }}>
									尚无 Launch Key
								</td>
							</tr>
						) : (
							snapshot.launchKeys.map((key) => (
								<tr key={key.id}>
									<td>
										<code>{key.keyId}</code>
									</td>
									<td>{key.algorithm}</td>
									<td>
										<span className={`badge ${key.status}`}>{key.status}</span>
									</td>
									<td>{new Date(key.notBefore).toLocaleString()}</td>
									<td>{key.expiresAt === null ? "— " : new Date(key.expiresAt).toLocaleString()}</td>
									<td>{new Date(key.createdAt).toLocaleString()}</td>
									<td>
										{key.status !== "revoked" ? (
											<button className="pub-btn danger" type="button" onClick={() => setRevokeTarget(key)}>
												吊销
											</button>
										) : (
											<small style={{ color: "var(--pub-fg-muted)" }}>已吊销</small>
										)}
									</td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>

			{revokeTarget !== null ? (
				<ConfirmDialog
					title={`吊销 Launch Key ${revokeTarget.keyId}`}
					body={
						<div>
							<p>吊销后该 key 不再被 Launch Token 验证接受，running 验证也不会放过。</p>
							<p style={{ marginTop: 8 }}>这是不可逆操作。</p>
						</div>
					}
					confirmLabel="吊销"
					danger
					onConfirm={async () => {
						const target = revokeTarget;
						setRevokeTarget(null);
						await controller.revokeLaunchKey({ appId, keyId: target.keyId });
					}}
					onCancel={() => setRevokeTarget(null)}
				/>
			) : null}
		</div>
	);
}

function useSnapshot(controller: PublishingController) {
	return controller.getSnapshot();
}
