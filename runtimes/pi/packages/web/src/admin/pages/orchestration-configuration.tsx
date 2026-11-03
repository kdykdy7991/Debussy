import type {
	AnalysisConfiguration,
	OrchestrationCatalog,
	OrchestrationIntegration,
	ReasoningEffort,
} from "@earendil-works/pi-protocol";
import { useEffect, useId, useState } from "react";
import { type OrchestrationApi, OrchestrationApiError } from "../api/orchestration-api.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { useDialogs } from "../components/use-dialogs.tsx";
import { OrchestrationDrawer } from "./orchestration-drawer.tsx";
import styles from "./orchestration-page.module.css";
import { errorMessage } from "./orchestration-ui.ts";

const EFFORT_NAMES: Record<ReasoningEffort, string> = {
	minimal: "最少",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "更高",
	max: "最高",
};

export function OrchestrationConfiguration({
	api,
	integration,
	catalog,
	onClose,
	onSaved,
}: {
	api: OrchestrationApi;
	integration: OrchestrationIntegration;
	catalog: OrchestrationCatalog | null;
	onClose: () => void;
	onSaved: () => void;
}): React.JSX.Element {
	const formId = useId(),
		dialogs = useDialogs();
	const [original, setOriginal] = useState<AnalysisConfiguration | null>(null),
		[draft, setDraft] = useState<AnalysisConfiguration | null>(null);
	const [loading, setLoading] = useState(true),
		[busy, setBusy] = useState(false),
		[error, setError] = useState<string | null>(null),
		[conflict, setConflict] = useState(false),
		[saved, setSaved] = useState<number | null>(null);
	const [reload, setReload] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload explicitly invalidates the remote configuration.
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		void api
			.request<AnalysisConfiguration>(
				`integrations/${integration.id}/configuration`,
				"GET",
				undefined,
				controller.signal,
			)
			.then(
				(result) => {
					if (controller.signal.aborted) return;
					setOriginal(result);
					setDraft(result);
					setError(null);
					setConflict(false);
				},
				(e) => {
					if (!controller.signal.aborted) setError(errorMessage(e));
				},
			)
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [api, integration.id, reload]);
	const dirty = original !== null && draft !== null && JSON.stringify(original) !== JSON.stringify(draft);
	const model = catalog?.models.find((m) => m.id === draft?.modelId);
	const capability = model?.parameterCapabilities.reasoning;
	const reasoning = draft?.parameters.reasoning;
	const selectedEffort =
		reasoning?.enabled === false ? "off" : (reasoning?.effort ?? (reasoning?.enabled ? "on" : "default"));
	const close = async () => {
		if (
			dirty &&
			!(await dialogs.confirm("已修改的提示词和模型设置尚未保存。", {
				title: "放弃未保存的修改？",
				confirmLabel: "放弃修改",
			}))
		)
			return;
		onClose();
	};
	const reloadConfiguration = async () => {
		if (
			dirty &&
			!(await dialogs.confirm("重新加载会替换当前草稿，请先保留需要的内容。", {
				title: "重新加载最新配置？",
				confirmLabel: "重新加载",
			}))
		)
			return;
		setReload((previous) => previous + 1);
		setSaved(null);
	};
	const migrate = async () => {
		if (!original?.versionId || busy) return;
		if (
			!(await dialogs.confirm(
				"将当前冻结配置显式复制为独立编排版本。之后 Chat 的修改和停用不影响新任务；已有 Run 保留原版本。",
				{ title: "迁移历史接入配置？", confirmLabel: "迁移为独立配置" },
			))
		)
			return;
		setBusy(true);
		setError(null);
		try {
			await api.request(`integrations/${integration.id}/migrate`, "POST", {
				expected_revision: original.revision,
				expected_active_version: original.versionId,
			});
			setReload((v) => v + 1);
			onSaved();
		} catch (error) {
			setError(errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	const save = async () => {
		if (!draft || busy || !model || !original?.versionId) return;
		setBusy(true);
		setError(null);
		setSaved(null);
		try {
			const result = await api.request<AnalysisConfiguration>(
				`integrations/${integration.id}/configuration`,
				"PUT",
				{
					expectedRevision: original!.revision,
					expectedDraftRevision: original!.draftRevision,
					expectedActiveVersion: original!.versionId,
					systemPrompt: draft.systemPrompt,
					modelId: draft.modelId,
					parameters: draft.parameters,
					mcpServers: draft.mcpServers,
					skills: draft.skills,
				},
			);
			setOriginal(result);
			setDraft(result);
			setConflict(false);
			setSaved(result.revision);
			onSaved();
		} catch (e) {
			setConflict(e instanceof OrchestrationApiError && e.status === 409);
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<OrchestrationDrawer
			title="分析配置"
			subtitle={`${integration.name} · ${original ? `当前生效 v${original.revision}` : "正在读取配置"}`}
			busy={busy}
			onClose={() => void close()}
			footer={
				<>
					<span className={styles.footerHint}>{dirty ? "有未保存的修改" : "已与生效配置同步"}</span>
					<AuroraButton disabled={busy} onClick={() => void close()}>
						关闭
					</AuroraButton>
					<AuroraButton
						form={formId}
						type="submit"
						variant="primary"
						disabled={
							busy ||
							loading ||
							!dirty ||
							!model ||
							!original?.versionId ||
							original.versionId.startsWith("pav_")
						}
					>
						{busy ? "正在校验并发布…" : "保存并生效"}
					</AuroraButton>
				</>
			}
		>
			{loading && <output className={styles.loading}>正在读取生效配置…</output>}
			{original && !original.versionId && (
				<div className={styles.note}>服务端尚未提供独立配置版本，请升级服务端后重新读取。</div>
			)}
			{saved && <output className={styles.success}>配置 v{saved} 已生效，新创建的分析工作项将使用此版本。</output>}
			{error && (
				<div className={styles.error} role="alert">
					<p>{error}</p>
					{conflict && <p>你的修改仍保留在草稿中。请保留需要的内容后，重新加载最新配置。</p>}
					<AuroraButton disabled={busy} onClick={() => void reloadConfiguration()}>
						{conflict ? "重新加载最新配置" : "重新读取配置"}
					</AuroraButton>
				</div>
			)}
			{original?.versionId && (
				<div className={styles.note}>
					<strong>生效版本</strong>
					<p>
						<code>{original.versionId}</code>
					</p>
					{original.versionId.startsWith("pav_") && (
						<>
							<p>这是历史发布配置。先迁移为独立编排配置，再保存修改。</p>
							<AuroraButton disabled={busy} onClick={() => void migrate()}>
								迁移为独立配置
							</AuroraButton>
						</>
					)}
				</div>
			)}

			{draft && !loading && (
				<form
					id={formId}
					className={styles.form}
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<div className={styles.sectionHeading}>
						<h3>分析要求</h3>
						<p>作为每次告警研判的固定背景和处理要求。</p>
					</div>
					<label className={styles.field}>
						固定分析要求
						<textarea
							data-autofocus
							rows={11}
							maxLength={60000}
							value={draft.systemPrompt}
							placeholder="描述需要关注的告警类型、分析重点和证据要求…"
							onChange={(event) => {
								setDraft({ ...draft, systemPrompt: event.target.value });
								setSaved(null);
							}}
						/>
						<small className={styles.characterCount}>
							{draft.systemPrompt.length.toLocaleString()} / 60,000 字符
						</small>
					</label>
					<div className={styles.sectionHeading}>
						<h3>模型与思考</h3>
						<p>只展示此接入允许使用的模型，思考选项由模型能力决定。</p>
					</div>
					<label className={styles.field}>
						分析模型
						<select
							value={draft.modelId}
							onChange={(event) => {
								setDraft({ ...draft, modelId: event.target.value, parameters: {} });
								setSaved(null);
							}}
						>
							{!model && <option value={draft.modelId}>{draft.modelId}（当前不可用）</option>}
							{catalog?.models
								.filter((m) => draft.allowedModels.includes(m.id))
								.map((m) => (
									<option value={m.id} key={`${m.provider}/${m.id}`}>
										{m.name} · {m.provider}
									</option>
								))}
						</select>
						{!model && <small>模型目录尚未加载或当前模型已不可用，暂不能保存。请刷新页面或检查模型配置。</small>}
					</label>
					{capability?.supported ? (
						<label className={styles.field}>
							思考强度
							<select
								value={selectedEffort}
								onChange={(event) => {
									const value = event.target.value;
									setDraft({
										...draft,
										parameters:
											value === "default"
												? {}
												: {
														reasoning:
															value === "off"
																? { enabled: false }
																: value === "on"
																	? { enabled: true }
																	: { enabled: true, effort: value as ReasoningEffort },
													},
									});
									setSaved(null);
								}}
							>
								<option value="default">使用模型默认</option>
								{capability.toggle && <option value="off">关闭思考</option>}
								<option value="on">启用思考 · 默认强度</option>
								{capability.efforts.map((effort) => (
									<option key={effort} value={effort}>
										{EFFORT_NAMES[effort]}
									</option>
								))}
							</select>
							<small>更高强度通常需要更长的分析时间。</small>
						</label>
					) : (
						model && <div className={styles.note}>此模型不支持调整思考强度，将使用模型默认行为。</div>
					)}
					<div className={styles.sectionHeading}>
						<h3>MCP 与 Skill</h3>
						<p>本编排自己的资源选择。保存发布后，只影响新任务。</p>
					</div>
					<div className={styles.choiceList}>
						{catalog?.mcpServers?.map((server) => (
							<label key={server.id} className={styles.choice}>
								<input
									type="checkbox"
									checked={draft.mcpServers?.some((ref) => ref.mcpServerId === server.id) ?? false}
									onChange={(event) => {
										setDraft({
											...draft,
											mcpServers: event.target.checked
												? [
														...(draft.mcpServers ?? []),
														{
															mcpServerId: server.id,
															revision: server.revision,
															toolNames: server.tools.map((tool) => tool.name),
														},
													]
												: draft.mcpServers?.filter((ref) => ref.mcpServerId !== server.id),
										});
										setSaved(null);
									}}
								/>
								<span>
									<strong>{server.name}</strong>
									<small>
										固定版本{" "}
										{draft.mcpServers?.find((ref) => ref.mcpServerId === server.id)?.revision ??
											server.revision}
									</small>
								</span>
							</label>
						))}
					</div>
					<div className={styles.choiceList}>
						{catalog?.skills?.map((skill) => (
							<label key={skill.id} className={styles.choice}>
								<input
									type="checkbox"
									checked={draft.skills?.some((ref) => ref.skillId === skill.id) ?? false}
									onChange={(event) => {
										setDraft({
											...draft,
											skills: event.target.checked
												? [...(draft.skills ?? []), { skillId: skill.id, revision: skill.revision }]
												: draft.skills?.filter((ref) => ref.skillId !== skill.id),
										});
										setSaved(null);
									}}
								/>
								<span>
									<strong>{skill.name}</strong>
									<small>
										Skill 版本{" "}
										{draft.skills?.find((ref) => ref.skillId === skill.id)?.revision ?? skill.revision}
									</small>
								</span>
							</label>
						))}
					</div>
					<div className={styles.note}>
						<p>已有凭据映射的工具必须保留在 MCP 白名单中，否则发布会拒绝，原版本继续生效。</p>
					</div>
					<div className={styles.note}>
						<strong>保存后的影响</strong>
						<p>新工作项立即使用新配置。正在执行的分析，以及对已有工作项的补充和重试，继续使用原配置。</p>
					</div>
				</form>
			)}
			{dialogs.dialog}
		</OrchestrationDrawer>
	);
}
