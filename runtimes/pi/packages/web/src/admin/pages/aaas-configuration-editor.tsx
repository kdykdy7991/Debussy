import type { OrchestrationCatalog } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useState } from "react";
import type { AaasBinding } from "../api/aaas-keys-api.ts";
import type { OrchestrationApi } from "../api/orchestration-api.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { navigate } from "../router.ts";
import styles from "./aaas-configurations-page.module.css";

interface ReasoningEffort {
	enabled?: boolean;
	effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

interface Draft {
	systemPrompt: string;
	modelId: string;
	parameters: { reasoning?: ReasoningEffort };
	mcpServers: { mcpServerId: string; revision: number; toolNames: string[] }[];
	skills: { skillId: string; revision: number }[];
	contextPolicy?: { maxTurns?: number; maxContextTokens?: number; toolResultMaxBytes?: number };
}

interface Configuration {
	id: string;
	name: string;
	draft: Draft;
	draftRevision: number;
	versions: { id: string; revision: number; createdAt: string }[];
}

interface VersionSnapshot {
	id: string;
	revision: number;
	snapshot: Draft;
}

type EditorTab = "basic" | "model" | "mcp" | "skills" | "runtime";
type ReasoningValue = "default" | "off" | "on" | NonNullable<ReasoningEffort["effort"]>;

const tabs: { id: EditorTab; label: string }[] = [
	{ id: "basic", label: "基础信息" },
	{ id: "model", label: "模型与推理" },
	{ id: "mcp", label: "MCP Server" },
	{ id: "skills", label: "Skills" },
	{ id: "runtime", label: "运行策略" },
];

/** 与 RuntimeSpec PLATFORM_LIMITS/PLATFORM_DEFAULTS 保持一致，避免超限到发布时才报错。 */
const runtimeFields: {
	key: "maxTurns" | "maxContextTokens" | "toolResultMaxBytes";
	label: string;
	max: number;
	placeholder: string;
}[] = [
	{ key: "maxTurns", label: "最大轮次", max: 100, placeholder: "默认 100，最大 100" },
	{ key: "maxContextTokens", label: "上下文 Token 上限", max: 256_000, placeholder: "默认 100000，最大 256000" },
	{ key: "toolResultMaxBytes", label: "工具结果字节上限", max: 65_536, placeholder: "默认 65536，最大 65536" },
];

const emptyDraft = (modelId: string): Draft => ({
	systemPrompt: "",
	modelId,
	parameters: {},
	mcpServers: [],
	skills: [],
});

const message = (error: unknown) => (error instanceof Error ? error.message : "操作失败");

function formatTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	})
		.format(date)
		.replace(/\//g, "-");
}

function reasoningValue(draft: Draft): ReasoningValue {
	if (draft.parameters.reasoning?.enabled === false) return "off";
	if (draft.parameters.reasoning?.effort) return draft.parameters.reasoning.effort;
	if (draft.parameters.reasoning?.enabled) return "on";
	return "default";
}

export function AaasConfigEditor({
	api,
	catalog,
	configId,
	defaultVersionId,
	credentialBindings = [],
	applyMode = false,
	onBack,
	onPublished,
	onOpenVersions,
}: {
	api: OrchestrationApi;
	catalog: OrchestrationCatalog | null;
	configId: string | null;
	defaultVersionId: string | null;
	credentialBindings?: readonly AaasBinding[];
	applyMode?: boolean;
	onBack: () => void;
	onPublished: () => void;
	onOpenVersions: (id: string) => void;
}): React.JSX.Element {
	const [current, setCurrent] = useState<Configuration | null>(null);
	const [draft, setDraft] = useState<Draft | null>(() =>
		configId ? null : emptyDraft(catalog?.models[0]?.id ?? ""),
	);
	const [name, setName] = useState("");
	const [tab, setTab] = useState<EditorTab>("basic");
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let active = true;
		if (!configId) {
			setCurrent(null);
			setDraft(emptyDraft(catalog?.models[0]?.id ?? ""));
			setName("");
			return;
		}
		void api
			.request<Configuration>(`configurations/${configId}`)
			.then((value) => {
				if (!active) return;
				setCurrent(value);
				setDraft(value.draft);
				setName(value.name);
			})
			.catch((caught: unknown) => active && setError(message(caught)));
		return () => {
			active = false;
		};
	}, [api, catalog?.models, configId]);

	async function withBusy(work: () => Promise<void>) {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await work();
		} catch (caught) {
			setError(message(caught));
		} finally {
			setBusy(false);
		}
	}

	async function publish() {
		if (!draft) return;
		await withBusy(async () => {
			if (!name.trim() && !current) throw new Error("请填写配置名称");
			if (!draft.modelId) throw new Error("请选择模型");
			if (applyMode) {
				const applied = await api.request<{ configurationId: string; orchestrationVersionId: string; revision: number }>(
					"configurations/current",
					"PUT",
					{
						configuration_id: current?.id ?? null,
						name: name.trim(),
						draft,
						credential_bindings: credentialBindings,
					},
				);
				setNotice("已保存并生效；新受理的任务使用此配置，已受理任务不受影响。");
				setCurrent({
					id: applied.configurationId,
					name: name.trim(),
					draft,
					draftRevision: applied.revision,
					versions: [{ id: applied.orchestrationVersionId, revision: applied.revision, createdAt: new Date().toISOString() }],
				});
				onPublished();
				return;
			}
			let target = current;
			if (!target) {
				target = await api.request<Configuration>("configurations", "POST", {
					name: name.trim(),
					draft,
				});
			} else if (JSON.stringify(draft) !== JSON.stringify(target.draft)) {
				target = await api.request<Configuration>(`configurations/${target.id}/draft`, "PUT", {
					expectedRevision: target.draftRevision,
					draft,
				});
			}
			await api.request(`configurations/${target.id}/versions`, "POST", {
				expectedRevision: target.draftRevision,
			});
			const refreshed = await api.request<Configuration>(`configurations/${target.id}`);
			setCurrent(refreshed);
			setDraft(refreshed.draft);
			setName(refreshed.name);
			setNotice("版本已发布。已发布版本不可更改；设为默认需单独确认。");
			onPublished();
		});
	}

	const model = catalog?.models.find((item) => item.id === draft?.modelId);
	const reasoningCapability = model?.parameterCapabilities.reasoning;
	const dirty = current !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(current.draft);
	const latestVersionId = current?.versions[0]?.id ?? null;
	const hasVersions = (current?.versions.length ?? 0) > 0;
	const canPublish = applyMode
		? Boolean(draft && model && (!current ? name.trim().length > 0 : true))
		: Boolean(draft && model && (!current ? name.trim().length > 0 : dirty || !hasVersions));
	const publishHint = !draft
		? "正在加载配置…"
		: !model
			? "请选择可用模型后再保存。"
			: !current && !name.trim()
				? "请填写配置名称后再保存。"
				: applyMode
					? "保存后立即生效；新受理的任务使用此配置，已受理任务保留其冻结快照。"
					: current && hasVersions && !dirty
						? `当前配置已发布为 v${current.versions[0]?.revision}，修改后可发布新版本。`
						: "发布后生成不可变版本；设为平台默认仍需单独确认。";

	function updateReasoning(value: string) {
		if (!draft) return;
		const resolved = value as ReasoningValue;
		const reasoning: ReasoningEffort | undefined =
			resolved === "default"
				? undefined
				: resolved === "off"
					? { enabled: false }
					: resolved === "on"
						? { enabled: true }
						: { enabled: true, effort: resolved };
		setDraft({ ...draft, parameters: reasoning ? { reasoning } : {} });
	}

	return (
		<div className={styles.workspace}>
			<nav className={styles.breadcrumb} aria-label="面包屑">
				<button type="button" onClick={onBack}>
					AaaS 执行配置
				</button>
				<span>/</span>
				<span>{current?.name || (configId ? "配置" : "新建配置")}</span>
				<span>/</span>
				<span>{configId ? "编辑配置" : "新建配置"}</span>
			</nav>

			<section className={`${styles.card} ${styles.editor}`}>
				<div className={styles.editorHead}>
					<div>
						<div className={styles.editorTitleRow}>
							<h1>{current?.name || name || "新建配置"}</h1>
							{!applyMode && current && hasVersions ? (
								<span className={`${styles.badge} ${styles.badgeGreen}`}>
									已发布 v{current.versions[0]?.revision}
								</span>
							) : !applyMode ? (
								<span className={`${styles.badge} ${styles.badgeNeutral}`}>未发布</span>
							) : null}
							{!applyMode && latestVersionId && latestVersionId === defaultVersionId && (
								<span className={`${styles.badge} ${styles.badgeBlue}`}>当前默认</span>
							)}
						</div>
						<p>{applyMode ? "保存后立即生效；已受理的任务继续使用其冻结快照。" : "已发布版本不可编辑；修改配置后可直接发布新版本。"}</p>
						</div>
						<div className={styles.editorActions}>
							<AuroraButton size="sm" onClick={onBack}>
								{applyMode ? "返回" : "返回配置列表"}
							</AuroraButton>
							{!applyMode && current && (
								<AuroraButton size="sm" onClick={() => onOpenVersions(current.id)}>
									版本历史
								</AuroraButton>
							)}
						</div>
				</div>

				{error && (
					<p className={styles.error} role="alert">
						{error}
					</p>
				)}
				{notice && <output className={styles.success}>{notice}</output>}

				<div className={styles.tabs} role="tablist" aria-label="配置分区">
					{tabs.map((item) => (
						<button
							key={item.id}
							type="button"
							role="tab"
							aria-selected={tab === item.id}
							className={tab === item.id ? styles.tabActive : undefined}
							onClick={() => setTab(item.id)}
						>
							{item.label}
						</button>
					))}
				</div>

				{draft && (
					<div className={styles.tabBody}>
						{tab === "basic" && (
							<>
								<div className={styles.formRow}>
									<label className={styles.field}>
										<span>配置名称 *</span>
										<input
											value={name}
											disabled={Boolean(current)}
											maxLength={200}
											onChange={(event) => setName(event.currentTarget.value)}
											placeholder="输入配置名称"
										/>
									</label>
									{current && <p className={styles.hint}>已创建配置的原名保持不变；本接口不提供重命名与自由描述字段。</p>}
								</div>
								<p className={styles.subtleNote}>
									AaaS 每次 Run 的完整 Prompt 由请求提供，此处不设置固定的 Chat Agent System Prompt。
								</p>
							</>
						)}

						{tab === "model" && (
							<>
								<div className={styles.formRow}>
									<label className={styles.field}>
										<span>模型 *</span>
										<select
											value={draft.modelId}
											onChange={(event) =>
												setDraft({ ...draft, modelId: event.currentTarget.value, parameters: {} })
											}
										>
											<option value="">请选择模型</option>
											{catalog?.models.map((item) => (
												<option key={`${item.provider}/${item.id}`} value={item.id}>
													{item.name} · {item.provider}
												</option>
											))}
										</select>
									</label>
									{reasoningCapability?.supported && (
										<label className={styles.field}>
											<span>推理参数</span>
											<select
												value={reasoningValue(draft)}
												onChange={(event) => updateReasoning(event.currentTarget.value)}
											>
												<option value="default">模型默认</option>
												{reasoningCapability.toggle && <option value="off">关闭</option>}
												<option value="on">启用</option>
												{reasoningCapability.efforts.map((effort) => (
													<option key={effort} value={effort}>
														{effort}
													</option>
												))}
											</select>
										</label>
									)}
								</div>
								<p className={styles.hint}>
									仅展示当前模型声明支持的推理参数；接口不支持 Temperature、最大输出 Token 等字段。
								</p>
							</>
						)}

						{tab === "mcp" && (
							<>
								<p className={styles.hint}>
									勾选 MCP Server 即使用该 Server 当前版本的全部工具。
									已选 {draft.mcpServers.reduce((sum, entry) => sum + entry.toolNames.length, 0)} 个工具
									（目录共 {(catalog?.mcpServers ?? []).reduce((sum, server) => sum + server.tools.length, 0)} 个）。
								</p>
								<div className={styles.optionGrid}>
									{(catalog?.mcpServers ?? []).map((server) => {
										const selected = draft.mcpServers.find((entry) => entry.mcpServerId === server.id);
										const stale = Boolean(selected && selected.toolNames.length < server.tools.length);
										const sync = () => setDraft({
											...draft,
											mcpServers: [
												...draft.mcpServers.filter((entry) => entry.mcpServerId !== server.id),
												{ mcpServerId: server.id, revision: server.revision, toolNames: server.tools.map((tool) => tool.name) },
											],
										});
										return (
											<div className={styles.mcpServerOption} key={server.id}>
												<label className={styles.check}>
													<input
														type="checkbox"
														checked={Boolean(selected)}
														onChange={(event) => {
															const remaining = draft.mcpServers.filter(
																(entry) => entry.mcpServerId !== server.id,
															);
															setDraft({
																...draft,
																mcpServers: event.currentTarget.checked
																	? [
																			...remaining,
																			{
																				mcpServerId: server.id,
																				revision: server.revision,
																				toolNames: server.tools.map((tool) => tool.name),
																			},
																		]
																	: remaining,
															});
														}}
													/>
													<span>
														{server.name}
														<small>{server.id} · 目录 {server.tools.length} 个工具 · 已选 {selected?.toolNames.length ?? 0} 个</small>
													</span>
												</label>
												{stale && (
													<div className={styles.mcpStale}>
														<span>目录已新增 {server.tools.length - selected!.toolNames.length} 个工具，当前配置仍使用旧快照。</span>
														<button type="button" onClick={sync}>重新选择全部工具</button>
													</div>
												)}
											</div>
										);
									})}
								</div>
								{(catalog?.mcpServers ?? []).length === 0 && <p className={styles.hint}>暂无可用的 MCP Server。</p>}
							</>
						)}

						{tab === "skills" && (
							<div className={styles.optionGrid}>
								{(catalog?.skills ?? []).map((skill) => (
									<label className={styles.check} key={skill.id}>
										<input
											type="checkbox"
											checked={draft.skills.some((ref) => ref.skillId === skill.id)}
											onChange={(event) =>
												setDraft({
													...draft,
													skills: event.currentTarget.checked
														? [...draft.skills, { skillId: skill.id, revision: skill.revision }]
														: draft.skills.filter((ref) => ref.skillId !== skill.id),
												})
											}
										/>
										<span>{skill.name}</span>
									</label>
								))}
								{(catalog?.skills ?? []).length === 0 && <p className={styles.hint}>暂无可用的 Skills。</p>}
							</div>
						)}

						{tab === "runtime" && (
							<>
								<div className={styles.formRow}>
									{runtimeFields.map((field) => (
										<label className={styles.field} key={field.key}>
											<span>{field.label}</span>
											<input
												type="number"
												min="1"
												max={field.max}
												placeholder={field.placeholder}
												value={draft.contextPolicy?.[field.key] ?? ""}
												onChange={(event) => {
													const value = event.currentTarget.value;
													setDraft({
														...draft,
														contextPolicy: {
															...draft.contextPolicy,
															[field.key]: value ? Number(value) : undefined,
														},
													});
												}}
											/>
										</label>
									))}
								</div>
								<p className={styles.hint}>
									留空使用平台默认值。上下文上限实际生效值为 min(模型窗口, 该值)；工具结果超过字节上限会被拒绝而非截断。执行超时能力尚未确认，不提供对应表单项。
								</p>
							</>
						)}
					</div>
				)}

				<div className={styles.editorFooter}>
					<p className={!canPublish ? styles.footerWarn : undefined}>{publishHint}</p>
					<div className={styles.modalActions}>
						<AuroraButton size="sm" onClick={onBack} disabled={busy}>
							取消
						</AuroraButton>
						<AuroraButton
							size="sm"
							variant="primary"
							title={canPublish ? undefined : publishHint}
							onClick={() => void publish()}
							disabled={busy || !canPublish}
						>
							{applyMode ? "保存并生效" : "发布版本"}
						</AuroraButton>
					</div>
				</div>
			</section>
		</div>
	);
}

export function AaasConfigVersions({
	api,
	catalog,
	configId,
	defaultVersionId,
	onBack,
	onSwitch,
}: {
	api: OrchestrationApi;
	catalog: OrchestrationCatalog | null;
	configId: string;
	defaultVersionId: string | null;
	onBack: () => void;
	onSwitch: (versionId: string) => void;
}): React.JSX.Element {
	const [configuration, setConfiguration] = useState<Configuration | null>(null);
	const [snapshots, setSnapshots] = useState<Record<string, Draft>>({});
	const [detail, setDetail] = useState<VersionSnapshot | null>(null);
	const [error, setError] = useState("");

	const load = useCallback(async () => {
		const value = await api.request<Configuration>(`configurations/${configId}`);
		setConfiguration(value);
		const entries = await Promise.all(
			value.versions.map(async (version) => {
				try {
					const snapshot = await api.request<VersionSnapshot>(
						`configurations/${configId}/versions/${version.id}`,
					);
					return [version.id, snapshot.snapshot] as const;
				} catch {
					return null;
				}
			}),
		);
		setSnapshots(Object.fromEntries(entries.filter((entry): entry is readonly [string, Draft] => entry !== null)));
	}, [api, configId]);

	useEffect(() => {
		let active = true;
		void load().catch((caught: unknown) => active && setError(message(caught)));
		return () => {
			active = false;
		};
	}, [load]);

	const versions = configuration?.versions ?? [];

	return (
		<div className={styles.workspace}>
			<nav className={styles.breadcrumb} aria-label="面包屑">
				<button type="button" onClick={onBack}>
					AaaS 执行配置
				</button>
				<span>/</span>
				<span>{configuration?.name ?? "配置"}</span>
				<span>/</span>
				<span>配置版本</span>
			</nav>
			<section className={`${styles.card} ${styles.versions}`}>
				<div className={styles.editorHead}>
					<div>
						<h1>{configuration?.name ?? "配置版本"}</h1>
						<p>查看配置的发布历史。已发布版本不可更改；修改配置后可发布新版本。</p>
					</div>
					<div className={styles.editorActions}>
						<button type="button" onClick={() => navigate("/aaas-configurations")}>
							返回配置列表
						</button>
					</div>
				</div>
				{error && (
					<p className={styles.error} role="alert">
						{error}
					</p>
				)}
				<div className={styles.versionList}>
					{versions.map((version) => {
						const snapshot = snapshots[version.id];
						const isDefault = version.id === defaultVersionId;
						return (
							<div className={styles.versionRow} key={version.id}>
								<div className={styles.versionInfo}>
									<strong>v{version.revision}</strong>
									{isDefault && <span className={`${styles.badge} ${styles.badgeGreen}`}>当前默认</span>}
									<span className={styles.muted}>
										发布于 {formatTime(version.createdAt)}
										{snapshot ? ` · ${catalog?.models.find((model) => model.id === snapshot.modelId)?.name ?? snapshot.modelId}` : ""}
									</span>
								</div>
								<div className={styles.rowActions}>
									<button
										type="button"
										disabled={!snapshot}
										onClick={() => snapshot && setDetail({ id: version.id, revision: version.revision, snapshot })}
									>
										查看
									</button>
									{!isDefault && (
										<button type="button" className={styles.linkButton} onClick={() => onSwitch(version.id)}>
											设为默认
										</button>
									)}
								</div>
							</div>
						);
					})}
					{versions.length === 0 && <p className={styles.hint}>尚未发布版本。发布后可在此查看并设置默认。</p>}
				</div>
			</section>

			{detail && (
				<div className={styles.overlay} role="presentation" onMouseDown={() => setDetail(null)}>
					<section
						className={styles.modal}
						role="dialog"
						aria-modal="true"
						aria-labelledby="version-detail-title"
						onMouseDown={(event) => event.stopPropagation()}
					>
						<div className={styles.modalHead}>
							<h2 id="version-detail-title">版本快照 · v{detail.revision}</h2>
							<button type="button" className={styles.iconButton} aria-label="关闭" onClick={() => setDetail(null)}>
								×
							</button>
						</div>
						<dl className={styles.summaryList}>
							<div>
								<dt>模型</dt>
								<dd>{catalog?.models.find((model) => model.id === detail.snapshot.modelId)?.name ?? detail.snapshot.modelId}</dd>
							</div>
							<div>
								<dt>推理参数</dt>
								<dd>{JSON.stringify(detail.snapshot.parameters)}</dd>
							</div>
							<div>
								<dt>MCP Server</dt>
								<dd>
									{detail.snapshot.mcpServers.length
										? detail.snapshot.mcpServers
												.map((server) => `${server.mcpServerId} (${server.toolNames.length})`)
												.join("、")
										: "无"}
								</dd>
							</div>
							<div>
								<dt>Skills</dt>
								<dd>{detail.snapshot.skills.length ? detail.snapshot.skills.map((skill) => skill.skillId).join("、") : "无"}</dd>
							</div>
							<div>
								<dt>上下文策略</dt>
								<dd>{detail.snapshot.contextPolicy ? JSON.stringify(detail.snapshot.contextPolicy) : "未设置"}</dd>
							</div>
						</dl>
						<p className={styles.notice}>版本快照不可编辑；切换默认只影响之后受理的新 Run。</p>
						<div className={styles.modalActions}>
							<button type="button" onClick={() => setDetail(null)}>
								关闭
							</button>
						</div>
					</section>
				</div>
			)}
		</div>
	);
}
