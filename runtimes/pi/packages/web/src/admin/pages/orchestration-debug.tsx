import type { AnalysisWorkItem, ConversationAdminEvent, OrchestrationIntegration } from "@earendil-works/pi-protocol";
import { useEffect, useMemo, useState } from "react";
import { ConversationsApi } from "../api/conversations-api.ts";
import type { OrchestrationApi } from "../api/orchestration-api.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { AuroraPill } from "../aurora/Pill.tsx";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { useDialogs } from "../components/use-dialogs.tsx";
import { navigate } from "../router.ts";
import { OrchestrationDrawer } from "./orchestration-drawer.tsx";
import styles from "./orchestration-page.module.css";
import { displayTime, errorMessage, shortVersion, WORK_STATUS } from "./orchestration-ui.ts";

const RELEVANT_EVENTS = new Set([
	"turn/start",
	"assistant/message",
	"tool/call",
	"tool/result",
	"tool/error",
	"turn/end",
	"turn/failed",
]);

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function eventLabel(event: ConversationAdminEvent): string {
	const payload = asRecord(event.payload);
	switch (event.eventType) {
		case "turn/start":
			return `开始执行 · 模型 ${String(payload.model ?? "—")} · 版本 ${String(
				asRecord(payload.executionSource).versionId ?? "—",
			)}`;
		case "assistant/message":
			return `模型输出 · ${String(payload.text ?? "").slice(0, 120)}`;
		case "tool/call":
			return `工具调用 · ${String(payload.toolName ?? "—")}`;
		case "tool/result":
			return `工具结果 · ${String(payload.toolName ?? "—")} · ${payload.isError === true ? "失败" : "成功"}`;
		case "tool/error":
			return `工具错误 · ${String(payload.toolName ?? "—")}`;
		case "turn/end": {
			const llm = asRecord(payload.llmUsage);
			const total = asRecord(llm.total).totalTokens;
			return `执行结束 · ${total === undefined ? "仅最后一次调用 usage（历史不完整）" : `${String(total)} Token / ${String(llm.callCount ?? "?")} 次 LLM 调用`}`;
		}
		case "turn/failed":
			return `执行失败 · ${String(payload.error ?? "")}`;
		default:
			return event.eventType;
	}
}

export function OrchestrationDebug({
	api,
	integrations,
	initialIntegrationId,
	onClose,
	onOpenRun,
}: {
	api: OrchestrationApi;
	integrations: readonly OrchestrationIntegration[];
	initialIntegrationId?: string;
	onClose: () => void;
	onOpenRun: (item: AnalysisWorkItem) => void;
}): React.JSX.Element {
	const { controller } = useAdminAuth();
	const conversations = useMemo(() => new ConversationsApi({ auth: controller }), [controller]);
	const dialogs = useDialogs();
	const enabled = integrations.filter((item) => item.enabled);
	const [integrationId, setIntegrationId] = useState(
		initialIntegrationId ?? enabled[0]?.id ?? integrations[0]?.id ?? "",
	);
	const [prompt, setPrompt] = useState("");
	const [credentials, setCredentials] = useState<Record<string, string>>({});
	const [requestId, setRequestId] = useState(() => crypto.randomUUID());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [run, setRun] = useState<AnalysisWorkItem | null>(null);
	const [events, setEvents] = useState<readonly ConversationAdminEvent[]>([]);
	const selected = integrations.find((item) => item.id === integrationId);
	const bindings = selected?.bindings;
	const credentialNames = useMemo(
		() => [...new Set((bindings ?? []).map((binding) => binding.credential))].sort(),
		[bindings],
	);
	const running = run?.state === "queued" || run?.state === "running";
	const runId = run?.id,
		conversationId = run?.conversationId;

	useEffect(() => {
		if (runId === undefined || conversationId === undefined) return;
		const abort = new AbortController();
		let disposed = false;
		const load = async () => {
			try {
				const [fresh, list] = await Promise.all([
					api.request<AnalysisWorkItem>(`work-items/${runId}`, "GET", undefined, abort.signal),
					conversations.listEvents(conversationId, { limit: 200 }),
				]);
				if (!disposed && !abort.signal.aborted) {
					setRun(fresh);
					setEvents(list.items);
				}
			} catch (e) {
				if (!disposed && !abort.signal.aborted) setError(errorMessage(e));
			}
		};
		void load();
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void load();
		}, 3000);
		return () => {
			disposed = true;
			abort.abort();
			clearInterval(timer);
		};
	}, [api, conversations, runId, conversationId]);

	const submit = async () => {
		if (!integrationId || !prompt.trim() || busy) return;
		if (credentialNames.some((name) => !credentials[name]?.trim())) {
			setError("请填写全部测试凭据后再提交。");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const created = await api.request<AnalysisWorkItem>(`integrations/${integrationId}/debug-runs`, "POST", {
				requestId,
				prompt,
				credentials,
			});
			setRun(created);
			setEvents([]);
			setCredentials({});
			setError(null);
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};
	const cancel = async () => {
		if (!run) return;
		if (
			!(await dialogs.confirm(`取消调试 Run ${run.id} 后，尚未完成的计算与排队输入将停止处理。`, {
				title: "取消此调试任务？",
				confirmLabel: "取消调试",
				destructive: true,
			}))
		)
			return;
		setBusy(true);
		try {
			await api.request(`work-items/${run.id}/cancel`, "POST", {});
			setRun(await api.request<AnalysisWorkItem>(`work-items/${run.id}`, "GET"));
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};
	const close = () => {
		setCredentials({});
		onClose();
	};
	const reset = () => {
		setRun(null);
		setEvents([]);
		setPrompt("");
		setCredentials({});
		setError(null);
		setRequestId(crypto.randomUUID());
	};
	return (
		<OrchestrationDrawer
			title="动态任务调试"
			subtitle="提交本次动态 Prompt，创建真实 AaaS Run"
			busy={busy}
			onClose={close}
			footer={
				<>
					<span className={styles.footerHint}>
						{run ? "调试 Run 会正常计入编排用量" : "测试凭据仅在本次请求中使用，不保存"}
					</span>
					{run && (
						<>
							<AuroraButton disabled={busy} onClick={() => onOpenRun(run)}>
								查看 Run 详情
							</AuroraButton>
							<AuroraButton disabled={busy} onClick={() => navigate(`/conversations/${run.conversationId}`)}>
								查看 Session 日志 ↗
							</AuroraButton>
							{running && (
								<AuroraButton disabled={busy} onClick={() => void cancel()}>
									取消调试
								</AuroraButton>
							)}
							<AuroraButton disabled={busy} onClick={reset}>
								新建调试
							</AuroraButton>
						</>
					)}
					<AuroraButton disabled={busy} onClick={close}>
						关闭
					</AuroraButton>
				</>
			}
		>
			{error && (
				<div className={styles.error} role="alert">
					<p>{error}</p>
				</div>
			)}
			{!run ? (
				<div className={styles.form}>
					<div className={styles.sectionHeading}>
						<h3>选择接入</h3>
						<p>沿用该接入的模型、思考强度、MCP/Skill 与凭据映射。</p>
					</div>
					<label className={styles.field}>
						Integration
						<select value={integrationId} onChange={(event) => setIntegrationId(event.target.value)}>
							{integrations.map((item) => (
								<option key={item.id} value={item.id}>
									{item.name} · {shortVersion(item.versionId)}
								</option>
							))}
						</select>
					</label>
					<div className={styles.sectionHeading}>
						<h3>本次动态 Prompt</h3>
						<p>包含本次分析要求、任务内容与输出要求；按正式契约覆盖默认 System Prompt。</p>
					</div>
					<label className={styles.field}>
						Prompt
						<textarea
							data-autofocus
							rows={10}
							maxLength={48000}
							value={prompt}
							placeholder="描述本次工单、需要核对的证据和结论要求…"
							onChange={(event) => setPrompt(event.target.value)}
						/>
					</label>
					{credentialNames.length > 0 && (
						<>
							<div className={styles.sectionHeading}>
								<h3>测试凭据</h3>
								<p>按当前接入的凭据映射填写；值不会回显、不会保存，也不要写进 Prompt。</p>
							</div>
							{credentialNames.map((name) => (
								<label key={name} className={styles.field}>
									{name}
									<input
										type="password"
										autoComplete="off"
										value={credentials[name] ?? ""}
										onChange={(event) =>
											setCredentials((previous) => ({ ...previous, [name]: event.target.value }))
										}
									/>
								</label>
							))}
						</>
					)}
					<div className={styles.note}>
						<p>提交后创建真实 Run，使用与正式 AaaS 相同的执行链路；最终结果保持模型原文，不强制 JSON。</p>
					</div>
					<AuroraButton
						variant="primary"
						disabled={busy || !integrationId || !prompt.trim()}
						onClick={() => void submit()}
					>
						{busy ? "正在提交…" : "创建调试 Run"}
					</AuroraButton>
				</div>
			) : (
				<>
					<dl className={styles.infoGrid}>
						<div>
							<dt>Run ID</dt>
							<dd>
								<code>{run.id}</code>
							</dd>
						</div>
						<div>
							<dt>状态</dt>
							<dd>
								<AuroraPill tone={WORK_STATUS[run.state].tone}>{WORK_STATUS[run.state].label}</AuroraPill>
							</dd>
						</div>
						<div>
							<dt>冻结版本</dt>
							<dd title={run.versionId ?? undefined}>{shortVersion(run.versionId)}</dd>
						</div>
						<div>
							<dt>请求契约</dt>
							<dd>动态 Prompt（覆盖系统提示词）</dd>
						</div>
						<div>
							<dt>最近更新</dt>
							<dd>{displayTime(run.updatedAt)}</dd>
						</div>
					</dl>
					<section className={styles.reportSection}>
						<h3>最终原文结果</h3>
						{run.report !== null ? (
							<pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{run.report}</pre>
						) : (
							<p className={styles.muted}>
								{running ? "正在执行，完成后显示模型原文。" : "本次 Run 没有可用结果。"}
							</p>
						)}
					</section>
					<section className={styles.reportSection}>
						<h3>执行过程 · LLM / MCP / Tool</h3>
						{events.filter((event) => RELEVANT_EVENTS.has(event.eventType)).length === 0 ? (
							<p className={styles.muted}>等待执行事件…</p>
						) : (
							<ol className={styles.timeline}>
								{events
									.filter((event) => RELEVANT_EVENTS.has(event.eventType))
									.map((event) => (
										<li key={event.eventId}>
											<strong>{eventLabel(event)}</strong>
											<p className={styles.muted}>
												#{event.sequence} · {displayTime(event.createdAt)}
											</p>
											<details className={styles.technical}>
												<summary>原始事件</summary>
												<pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
													{JSON.stringify(event.payload, null, 2).slice(0, 4000)}
												</pre>
											</details>
										</li>
									))}
							</ol>
						)}
					</section>
				</>
			)}
			{dialogs.dialog}
		</OrchestrationDrawer>
	);
}
