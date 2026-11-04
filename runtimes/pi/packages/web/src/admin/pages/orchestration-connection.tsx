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
			prompt: [
				"你是告警研判 Agent，只使用平台已配置的 MCP 工具核对本次工单相关证据。",
				"工单 TKT-20261103140806-2673：S49 卫星自 11-01 起存储回传数据几乎全部丢失，成功率 1.86%。",
				"请给出事件核验、影响范围、原因分析和数据说明，输出本次研判结论；不要编造工具结果。",
			].join("\n"),
			external_ref: { type: "ticket", id: "TKT-20261103140806-2673" },
			metadata: { source: "ticket-system" },
			credentials: Object.fromEntries(integration.bindings.map((b) => [b.credential, "<由工单后端提供>"])),
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
			<div className={styles.note}>
				<strong>动态任务型 Agent</strong>
				<p>
					外部每次请求提供完整 Prompt（分析要求、任务内容、输出要求），编排提供模型、思考强度、MCP/Skill 与
					Runtime。请求 Prompt 覆盖默认系统提示词，只对本次 Run 生效；最终结果保持模型原文。
				</p>
			</div>
			{integration.configurationSource !== "orchestration" && (
				<div className={styles.note}>
					<strong>历史接入 · 尚未独立</strong>
					<p>
						当前配置仍来自 Chat Agent「{integration.chatAppName ?? "历史发布"}」的冻结快照
						{integration.legacyVersionId ? `（${integration.legacyVersionId}）` : ""}
						。迁移后新 Run 使用独立编排版本；接入 ID、调用凭据和历史 Run 保持不变。
					</p>
				</div>
			)}
			<div className={styles.sectionHeading}>
				<h3>1. 在工单后端保存接入凭据</h3>
				<p>通过请求头认证，凭据不放入网页或 URL。已有凭据不会回显；遗失后可在接入系统中重新签发。</p>
			</div>
			<pre className={styles.codeBlock}>Authorization: Bearer &lt;接入凭据&gt;</pre>
			<div className={styles.sectionHeading}>
				<h3>2. 提交任务并查询结果</h3>
				<p>提交后立即返回 run_id。工单系统可每隔 2～5 秒查询结果，无需保持长连接。</p>
			</div>
			<div className={styles.endpoint}>
				<span>POST</span>
				<code>/api/aaas/v1/integrations/{integration.id}/runs</code>
			</div>
			<pre className={styles.codeBlock}>Idempotency-Key: &lt;业务幂等键，如同一次告警的 eventId&gt;</pre>
			<pre className={styles.codeBlock}>{sample}</pre>
			<CopyButton text={sample} label="复制请求示例" />
			<div className={styles.endpoint}>
				<span>GET</span>
				<code>/api/aaas/v1/runs/&lt;run_id&gt;</code>
			</div>
			<div className={styles.endpoint}>
				<span>POST</span>
				<code>/api/aaas/v1/runs/&lt;run_id&gt;/cancel</code>
			</div>
			<p className={styles.muted}>
				prompt 是正式支持的动态 Prompt
				契约：本次请求的完整规则与数据会覆盖编排配置的默认系统提示词，不改变平台配置，也不扩大模型或工具权限。
				<code>input</code> 是平台保留的任务数据形式（不覆盖系统提示词），与 prompt 不能同时提交。相同
				Idempotency-Key 的重复提交返回原 run_id，最终结果不强制 JSON。
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
						<code>{integration.versionId}</code> · 接入修订 {integration.revision}
					</dd>
					{integration.legacyVersionId && (
						<>
							<dt>历史来源</dt>
							<dd>
								Chat Agent「{integration.chatAppName ?? "未知"}」 · <code>{integration.legacyVersionId}</code>
								{integration.configurationSource === "orchestration" ? "（已迁移，仅溯源）" : "（待迁移）"}
							</dd>
						</>
					)}
				</dl>
			</details>
		</OrchestrationDrawer>
	);
}
