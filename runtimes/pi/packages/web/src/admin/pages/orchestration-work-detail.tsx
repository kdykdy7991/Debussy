import type { AnalysisWorkItem } from "@earendil-works/pi-protocol";
import { useEffect, useState } from "react";
import type { OrchestrationApi } from "../api/orchestration-api.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { AuroraPill } from "../aurora/Pill.tsx";
import { useDialogs } from "../components/use-dialogs.tsx";
import { navigate } from "../router.ts";
import { OrchestrationDrawer } from "./orchestration-drawer.tsx";
import styles from "./orchestration-page.module.css";
import {
	displayTime,
	errorMessage,
	externalRefLabel,
	failureMessage,
	shortVersion,
	WORK_STATUS,
} from "./orchestration-ui.ts";

const CONTRACT_LABELS: Record<string, string> = {
	input_v1: "input 任务数据（不覆盖系统提示词）",
	legacy_prompt: "动态 Prompt（覆盖系统提示词）",
	legacy_input: "早期输入（历史）",
	orchestration_event: "事件任务（历史）",
};

export function OrchestrationWorkDetail({
	api,
	initial,
	sourceName,
	onClose,
	onChanged,
}: {
	api: OrchestrationApi;
	initial: AnalysisWorkItem;
	sourceName: string;
	onClose: () => void;
	onChanged: () => void;
}): React.JSX.Element {
	const [item, setItem] = useState(initial),
		[error, setError] = useState<string | null>(null),
		[busy, setBusy] = useState(false),
		[refresh, setRefresh] = useState(0);
	const dialogs = useDialogs();
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly invalidates the remote work item.
	useEffect(() => {
		const controller = new AbortController();
		let inFlight = false;
		const load = async () => {
			if (inFlight) return;
			inFlight = true;
			try {
				const result = await api.request<AnalysisWorkItem>(
					`work-items/${initial.id}`,
					"GET",
					undefined,
					controller.signal,
				);
				if (!controller.signal.aborted) {
					setItem(result);
					setError(null);
				}
			} catch (e) {
				if (!controller.signal.aborted) setError(errorMessage(e));
			} finally {
				inFlight = false;
			}
		};
		void load();
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void load();
		}, 5000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [api, initial.id, refresh]);
	const change = async (action: "cancel" | "retry") => {
		if (
			action === "cancel" &&
			!(await dialogs.confirm(`取消告警「${item.alarmId}」的分析后，尚未完成的执行和排队输入将停止处理。`, {
				title: "取消此分析？",
				confirmLabel: "取消分析",
				destructive: true,
			}))
		)
			return;
		if (
			action === "retry" &&
			!(await dialogs.confirm("将继续使用此工作项的原配置与尚在有效期内的授权。", {
				title: "重试原分析？",
				confirmLabel: "确认重试",
			}))
		)
			return;
		setBusy(true);
		setError(null);
		try {
			await api.request(`work-items/${item.id}/${action}`, "POST", {});
			setRefresh((previous) => previous + 1);
			onChanged();
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};
	const running = item.state === "running" || item.state === "queued",
		latest = item.assignments.at(-1);
	return (
		<OrchestrationDrawer
			title={item.alarmId}
			subtitle={`${sourceName} · 分析详情`}
			onClose={onClose}
			busy={busy}
			footer={
				<>
					<AuroraButton onClick={() => navigate(`/conversations/${item.conversationId}`)}>
						查看 Session 日志 ↗
					</AuroraButton>
					<span className={styles.footerSpacer} />
					{running && (
						<AuroraButton disabled={busy} onClick={() => void change("cancel")}>
							取消分析
						</AuroraButton>
					)}
					{item.state === "failed" && item.origin !== "aaas" && (
						<AuroraButton
							variant="primary"
							disabled={busy || latest?.error === "CREDENTIAL_EXPIRED"}
							onClick={() => void change("retry")}
						>
							{busy ? "正在提交…" : "重试原分析"}
						</AuroraButton>
					)}
					<AuroraButton disabled={busy} onClick={onClose}>
						关闭
					</AuroraButton>
				</>
			}
		>
			<div className={styles.detailStatus}>
				<AuroraPill tone={WORK_STATUS[item.state].tone}>{WORK_STATUS[item.state].label}</AuroraPill>
				<span>接入修订 v{item.configurationRevision}</span>
				{item.versionId && (
					<span title={item.versionId}>
						冻结版本 {shortVersion(item.versionId)}
						{item.versionId.startsWith("pav_") ? "（历史快照）" : ""}
					</span>
				)}
				<button type="button" className={styles.textButton} onClick={() => setRefresh((previous) => previous + 1)}>
					刷新详情
				</button>
			</div>
			{error && (
				<p className={styles.error} role="alert">
					更新失败：{error}。当前显示上次读取的内容。
				</p>
			)}
			<dl className={styles.infoGrid}>
				<div>
					<dt>接入来源</dt>
					<dd>{sourceName}</dd>
				</div>
				<div>
					<dt>业务标识</dt>
					<dd>{externalRefLabel(item.externalRef)}</dd>
				</div>
				<div>
					<dt>冻结版本</dt>
					<dd title={item.versionId ?? undefined}>{item.versionId ? shortVersion(item.versionId) : "—"}</dd>
				</div>
				<div>
					<dt>请求契约</dt>
					<dd>{(item.requestContract && CONTRACT_LABELS[item.requestContract]) ?? item.requestContract ?? "—"}</dd>
				</div>
				<div>
					<dt>创建时间</dt>
					<dd>{displayTime(item.createdAt)}</dd>
				</div>
				<div>
					<dt>最近更新</dt>
					<dd>{displayTime(item.updatedAt)}</dd>
				</div>
				<div>
					<dt>执行次数</dt>
					<dd>{item.assignments.length} 次</dd>
				</div>
			</dl>
			{item.state === "failed" && (
				<div className={styles.error}>
					<strong>本次分析未完成</strong>
					<p>{failureMessage(latest?.error ?? null)}</p>
				</div>
			)}
			{running && (
				<div className={styles.note}>
					<strong>{item.state === "queued" ? "正在等待执行" : "正在查询证据并分析"}</strong>
					<p>
						{item.report
							? "以下是此前已完成的结论，尚未覆盖本次待处理的信息。"
							: "结论将在分析完成后显示，无需保持此页面打开。"}
					</p>
				</div>
			)}
			{item.state === "cancelled" && <p className={styles.note}>此工作项已取消。已生成的历史报告保留供查阅。</p>}
			{item.report !== null ? (
				<section className={styles.reportSummary}>
					<span className={styles.eyebrow}>
						{running || item.state === "failed" ? "最近一次完成的结论" : "分析结论"}
					</span>
					<pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.report}</pre>
					<p>
						对应事件：<code>{item.reportEventId}</code>
					</p>
				</section>
			) : (
				!running && (
					<div className={styles.empty}>
						<h3>尚无可用报告</h3>
						<p>可查看下面的执行记录，了解本次分析的处理情况。</p>
					</div>
				)
			)}
			<section className={styles.reportSection}>
				<h3>
					执行记录<span>{item.assignments.length}</span>
				</h3>
				<ol className={styles.timeline}>
					{[...item.assignments].reverse().map((assignment, index) => (
						<li key={assignment.id}>
							<div className={styles.timelineTitle}>
								<strong>第 {item.assignments.length - index} 次执行</strong>
								<AuroraPill tone={WORK_STATUS[assignment.state].tone}>
									{WORK_STATUS[assignment.state].label}
								</AuroraPill>
							</div>
							<p className={styles.muted}>
								{displayTime(assignment.createdAt)} · 事件 {assignment.eventId}
							</p>
							{assignment.error && <p>{failureMessage(assignment.error)}</p>}
							<details className={styles.technical}>
								<summary>技术详情</summary>
								<dl>
									<dt>执行标识</dt>
									<dd>{assignment.id}</dd>
									<dt>Turn</dt>
									<dd>{assignment.turnId}</dd>
									{assignment.error && (
										<>
											<dt>错误码</dt>
											<dd>{assignment.error}</dd>
										</>
									)}
								</dl>
							</details>
						</li>
					))}
				</ol>
			</section>
			<details className={styles.technical}>
				<summary>Run 标识（与外部调用返回的 run_id 相同）</summary>
				<code>{item.id}</code>
			</details>
			{dialogs.dialog}
		</OrchestrationDrawer>
	);
}
