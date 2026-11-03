import type { OrchestrationCatalog, OrchestrationIntegration } from "@earendil-works/pi-protocol";
import { useState } from "react";
import { AuroraButton } from "../aurora/Button.tsx";
import { useDialogs } from "../components/use-dialogs.tsx";
import { OrchestrationDrawer } from "./orchestration-drawer.tsx";
import styles from "./orchestration-page.module.css";

function CopyButton({ text, label = "复制" }: { text: string; label?: string }): React.JSX.Element {
	const [copied, setCopied] = useState(false),
		[error, setError] = useState(false);
	return (
		<div className={styles.copyAction}>
			<AuroraButton
				onClick={() => {
					void navigator.clipboard?.writeText(text).then(
						() => {
							setCopied(true);
							setError(false);
						},
						() => setError(true),
					);
					if (!navigator.clipboard) setError(true);
				}}
			>
				{copied ? "已复制" : label}
			</AuroraButton>
			{error && <small role="alert">浏览器未允许复制，请手动选择内容复制。</small>}
		</div>
	);
}

export function OrchestrationCredential({
	name,
	token,
	onClose,
}: {
	name: string;
	token: string;
	onClose: () => void;
}): React.JSX.Element {
	const dialogs = useDialogs();
	const dismiss = async () => {
		if (
			await dialogs.confirm("关闭后无法再次查看此凭据。若尚未保存，可取消关闭并先复制。", {
				title: "已保存接入凭据？",
				confirmLabel: "已保存，关闭",
			})
		)
			onClose();
	};
	return (
		<OrchestrationDrawer
			title="接入凭据已签发"
			subtitle={name}
			onClose={() => void dismiss()}
			footer={
				<>
					<span className={styles.footerHint}>仅保存在当前页面内存中</span>
					<AuroraButton variant="primary" onClick={onClose}>
						已保存，关闭
					</AuroraButton>
				</>
			}
		>
			<div className={styles.success}>
				<strong>请将凭据交给工单系统后端保存</strong>
				<p>此凭据标识接入系统，不会随着用户切换而变化。关闭后平台不会再次显示。</p>
			</div>
			<label className={styles.field}>
				接入凭据
				<textarea
					className={styles.secret}
					rows={4}
					readOnly
					value={token}
					onFocus={(event) => event.target.select()}
				/>
			</label>
			<CopyButton text={token} label="复制接入凭据" />
			<div className={styles.note}>
				<strong>与 Tool API key 分开使用</strong>
				<p>接入凭据放在工单后端调用平台的 Authorization 请求头中。每个用户的 Tool API key 则随具体分析请求提供。</p>
			</div>
			{dialogs.dialog}
		</OrchestrationDrawer>
	);
}

export function OrchestrationConnection({
	integration,
	catalog,
	onClose,
}: {
	integration: OrchestrationIntegration;
	catalog: OrchestrationCatalog | null;
	onClose: () => void;
}): React.JSX.Element {
	const sample = JSON.stringify(
		{
			eventId: "alarm-123-created-1",
			alarmId: "alarm-123",
			input: "设备 A 持续连接超时，请结合相关证据分析原因。",
			credentials: Object.fromEntries(integration.bindings.map((b) => [b.credential, "<由工单后端提供>"])),
			credentialExpiresAt: "<未来 24 小时内的 ISO 时间>",
		},
		null,
		2,
	);
	return (
		<OrchestrationDrawer
			title="接入说明"
			subtitle={integration.name}
			onClose={onClose}
			footer={<AuroraButton onClick={onClose}>关闭</AuroraButton>}
		>
			<div className={styles.sectionHeading}>
				<h3>1. 在工单后端保存接入凭据</h3>
				<p>通过请求头认证，凭据不放入网页或 URL。已有凭据不会回显；遗失后可在接入系统中重新签发。</p>
			</div>
			<pre className={styles.codeBlock}>Authorization: Bearer &lt;接入凭据&gt;</pre>
			<div className={styles.sectionHeading}>
				<h3>2. 提交告警并查询结论</h3>
				<p>提交后立即获得工作项标识。工单系统可每隔 2～5 秒查询结果，无需保持长连接。</p>
			</div>
			<div className={styles.endpoint}>
				<span>POST</span>
				<code>/api/orchestration/v1/events</code>
			</div>
			<pre className={styles.codeBlock}>{sample}</pre>
			<CopyButton text={sample} label="复制请求示例" />
			<div className={styles.endpoint}>
				<span>GET</span>
				<code>/api/orchestration/v1/work-items/&lt;workItemId&gt;</code>
			</div>
			<p className={styles.muted}>
				同一个 eventId 的完全相同请求可以安全重投。重新分析使用新的 eventId；补充信息时还需携带原 workItemId。
			</p>
			<section className={styles.reportSection}>
				<h3>已配置的工具授权</h3>
				{integration.bindings.length ? (
					<ul className={styles.bindingSummary}>
						{integration.bindings.map((b) => {
							const server = catalog?.applications
								.flatMap((a) => a.tools)
								.find((t) => t.mcpServerId === b.mcpServerId && t.name === b.toolName);
							return (
								<li key={`${b.mcpServerId}/${b.toolName}/${b.parameter}`}>
									<strong>
										{server?.serverName ?? "MCP 服务"} / {b.toolName}
									</strong>
									<p>
										请求凭据 <code>{b.credential}</code> → 工具参数 <code>{b.parameter}</code>
									</p>
								</li>
							);
						})}
					</ul>
				) : (
					<p className={styles.muted}>此接入未配置任务凭据映射，请求的 credentials 可传空对象。</p>
				)}
			</section>
			<section className={styles.reportSection}>
				<h3>允许的分析模型</h3>
				<ul>
					{integration.allowedModels.map((id) => (
						<li key={id}>{catalog?.models.find((m) => m.id === id)?.name ?? id}</li>
					))}
				</ul>
			</section>
			<details className={styles.technical}>
				<summary>接入标识</summary>
				<dl>
					<dt>接入 ID</dt>
					<dd>{integration.id}</dd>
					<dt>编排配置</dt>
					<dd>{integration.configurationId ?? "历史发布快照（待迁移）"}</dd>
					<dt>生效版本</dt>
					<dd>
						{integration.configurationId ? "orv_" : "pav_"}
						{integration.versionId} · 修订 {integration.revision}
					</dd>
				</dl>
			</details>
		</OrchestrationDrawer>
	);
}
