import type { McpServerDetail, McpToolRef, OrchestrationCatalog, SkillDetail } from "@earendil-works/pi-protocol";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import {
	type AaasKey,
	type AaasKeysApi,
	AaasKeysApiError,
	type RouterCapabilities,
	type RouterKeySettings,
	type RouterScope,
} from "../api/aaas-keys-api.ts";
import { McpApi } from "../api/mcp-api.ts";
import { OrchestrationApi } from "../api/orchestration-api.ts";
import { SkillApi } from "../api/skill-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { AuroraButton } from "../aurora/Button.tsx";
import { AuroraPill } from "../aurora/Pill.tsx";
import { AuroraSearchBox } from "../aurora/SearchBox.tsx";
import { useDialogs } from "../components/use-dialogs.tsx";
import styles from "./aaas-key-console.module.css";
import { KeyDropdown } from "./aaas-key-dropdown.tsx";
import { OrchestrationDrawer } from "./orchestration-drawer.tsx";
import {
	maxRouterMcpServers,
	maxRouterMcpTools,
	modelParameterFields,
	type ModelParameterEdits,
	parameterKey,
	readModelParameters,
	sameKeyConfiguration,
	updateMcpToolAllowlist,
} from "./router-key-form.ts";

const errorText = (error: unknown) => (error instanceof Error ? error.message : "请求失败");
export const routerScopeLabel: Record<RouterScope, string> = {
	legacy: "兼容 Key",
	dual: "双入口",
	router: "Router-only",
};
const emptyCapabilities: RouterCapabilities = {
	model: { provider: "", model_id: "", parameters: {} },
	mcp_servers: [],
	skills: [],
	execution_policy: { max_pending_operations: 4, queue_timeout_ms: 3_600_000, credential_max_ms: 1_800_000 },
};
const policyFields = [
	{ field: "max_pending_operations", label: "每个 Task 等待上限", unit: "个", max: 4 },
	{ field: "queue_timeout_ms", label: "排队时限", unit: "毫秒", max: 3_600_000 },
	{ field: "credential_max_ms", label: "凭据最长有效期", unit: "毫秒", max: 1_800_000 },
] as const;
type WorkState = "loading" | "saving" | "resource" | "scope";
type McpSelection = RouterCapabilities["mcp_servers"][number];
type McpCatalogEntry = NonNullable<OrchestrationCatalog["mcpServers"]>[number];
type SkillSelection = RouterCapabilities["skills"][number];

function preventSearchSubmit(event: KeyboardEvent<HTMLInputElement>) {
	if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
}

export function RouterCapabilitiesDrawer({
	keyRecord,
	api,
	onSaved,
	onClose,
}: {
	keyRecord: AaasKey;
	api: AaasKeysApi;
	onSaved: () => void;
	onClose: () => void;
}): React.JSX.Element {
	const { controller } = useAdminAuth();
	const dialogs = useDialogs();
	const catalogApi = useMemo(() => new OrchestrationApi(controller), [controller]);
	const mcpApi = useMemo(() => new McpApi({ auth: controller }), [controller]);
	const skillApi = useMemo(() => new SkillApi({ auth: controller }), [controller]);
	const path = `/${keyRecord.keyId}/router`;
	const formId = useId();
	const feedbackId = useId();
	const [settings, setSettings] = useState<RouterKeySettings | null>(null);
	const [catalog, setCatalog] = useState<OrchestrationCatalog | null>(null);
	const [catalogError, setCatalogError] = useState("");
	const [mcp, setMcp] = useState<Record<string, McpServerDetail>>({});
	const [addingMcp, setAddingMcp] = useState(false);
	const [skills, setSkills] = useState<Record<string, SkillDetail>>({});
	const [draft, setDraft] = useState(emptyCapabilities);
	const [parameterEdits, setParameterEdits] = useState<ModelParameterEdits>({});
	const [advanced, setAdvanced] = useState<string | null>(null);
	const [confirmed, setConfirmed] = useState(false);
	const [busy, setBusy] = useState<WorkState | null>("loading");
	const [conflict, setConflict] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const readonly = keyRecord.status === "revoked";

	const load = useCallback(
		async (signal?: AbortSignal) => {
			setError("");
			setNotice("");
			setBusy("loading");
			try {
				const [saved, directory] = await Promise.allSettled([
					api.request<RouterKeySettings>(path, "GET", undefined, signal),
					catalogApi.request<OrchestrationCatalog>("catalog", "GET", undefined, signal),
				]);
				if (signal?.aborted) return;
				if (saved.status === "rejected") throw saved.reason;
				const current = saved.value;
				const capabilities = current.capabilities ?? emptyCapabilities;
				const normalized = {
					...capabilities,
					skills: capabilities.skills.map((item) => ({
						...item,
						skill_id: item.skill_id.startsWith("skill_") ? item.skill_id : `skill_${item.skill_id}`,
					})),
				};
				setSettings({ ...current, capabilities: current.capabilities === null ? null : normalized });
				setCatalog(directory.status === "fulfilled" ? directory.value : null);
				setCatalogError(directory.status === "rejected" ? errorText(directory.reason) : "");
				setDraft(normalized);
				setAddingMcp(false);
				setParameterEdits({});
				setAdvanced(null);
				setConfirmed(false);
				setConflict(false);
				const [mcpDetails, skillDetails] = await Promise.all([
					Promise.allSettled(
						normalized.mcp_servers.map(
							async (item) => [item.server_id, await mcpApi.get(item.server_id)] as const,
						),
					),
					Promise.allSettled(
						normalized.skills.map(async (item) => [item.skill_id, await skillApi.get(item.skill_id)] as const),
					),
				]);
				if (signal?.aborted) return;
				setMcp(Object.fromEntries(mcpDetails.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []))));
				setSkills(
					Object.fromEntries(skillDetails.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []))),
				);
			} catch (cause) {
				if (!signal?.aborted) {
					setSettings(null);
					setError(errorText(cause));
				}
			} finally {
				if (!signal?.aborted) setBusy(null);
			}
		},
		[api, catalogApi, mcpApi, path, skillApi],
	);

	useEffect(() => {
		const abort = new AbortController();
		void load(abort.signal);
		return () => abort.abort();
	}, [load]);

	function clearFeedback() {
		setError("");
		setNotice("");
	}
	function updateDraft(next: RouterCapabilities) {
		clearFeedback();
		setDraft(next);
	}
	async function act(workState: WorkState, work: () => Promise<void>) {
		if (busy) return;
		setBusy(workState);
		clearFeedback();
		try {
			await work();
		} catch (cause) {
			setError(errorText(cause));
			if (cause instanceof AaasKeysApiError && cause.code === "CAPABILITY_REVISION_CONFLICT") setConflict(true);
		} finally {
			setBusy(null);
		}
	}

	const modelOptions = (catalog?.models ?? []).map((model) => ({
		value: JSON.stringify([model.provider, model.id]),
		label: model.name,
		detail: model.provider,
		model,
	}));
	const modelValue = JSON.stringify([draft.model.provider, draft.model.model_id]);
	const chosenModel = modelOptions.find((item) => item.value === modelValue);
	const parameters = readModelParameters(draft.model.parameters, parameterEdits, advanced);
	const candidate = parameters.parameters
		? { ...draft, model: { ...draft.model, parameters: parameters.parameters } }
		: null;
	const dirty =
		settings !== null &&
		(candidate === null || !sameKeyConfiguration(settings.capabilities ?? emptyCapabilities, candidate));
	const missingTools = draft.mcp_servers.find((item) => item.tool_allowlist.length === 0);
	const invalidPolicy = policyFields.find(({ field, max }) => {
		const value = draft.execution_policy[field];
		return !Number.isInteger(value) || value < 1 || value > max;
	});
	let validation = "";
	if (catalogError) validation = "模型目录加载失败，请重新加载。";
	else if (catalog && modelOptions.length === 0) validation = "模型目录中没有可用模型。";
	else if (!chosenModel) validation = "请选择一个可用模型。";
	else if (parameters.error) validation = parameters.error;
	else if (missingTools)
		validation = `请为「${mcp[missingTools.server_id]?.name ?? missingTools.server_id}」选择工具，或移除该服务。`;
	else if (invalidPolicy)
		validation = `${invalidPolicy.label}须填写 1 至 ${invalidPolicy.max.toLocaleString("zh-CN")} 的整数。`;

	const locked = Boolean(busy) || readonly || conflict;
	const canSave = settings !== null && candidate !== null && dirty && !locked && !validation && !addingMcp;
	const retry = conflict || Boolean(catalogError) || (!settings && !busy);

	async function confirmDiscard() {
		return (
			!dirty ||
			(await dialogs.confirm("当前修改尚未保存。", {
				title: "放弃未保存的修改？",
				confirmLabel: "放弃修改",
				destructive: true,
			}))
		);
	}
	async function close() {
		if (!busy && (await confirmDiscard())) onClose();
	}
	async function reload() {
		if (!busy && (await confirmDiscard())) await load();
	}
	function save() {
		if (!canSave || !settings || !candidate) return;
		void act("saving", async () => {
			const result = await api.request<Pick<RouterKeySettings, "scope" | "capabilityRevision">>(path, "PUT", {
				expected_revision: settings.capabilityRevision,
				capabilities: candidate,
			});
			setSettings({ ...settings, ...result, capabilities: candidate });
			setDraft(candidate);
			setParameterEdits({});
			if (advanced !== null) setAdvanced(JSON.stringify(candidate.model.parameters, null, 2));
			setConfirmed(false);
			setNotice(`已保存 · v${result.capabilityRevision}`);
			onSaved();
		});
	}
	function changeScope(action: "cutover" | "rollback") {
		if (!settings || dirty || locked) return;
		void act("scope", async () => {
			const result = await api.request<Pick<RouterKeySettings, "scope" | "capabilityRevision">>(path, "PATCH", {
				action,
				expected_revision: settings.capabilityRevision,
				...(action === "cutover" ? { migration_confirmed: confirmed } : {}),
			});
			setSettings({ ...settings, ...result, canRollback: action === "cutover" });
			setConfirmed(false);
			setNotice(action === "cutover" ? "已切为 Router-only。" : "已恢复双入口。");
			onSaved();
		});
	}
	function toggleAdvanced() {
		if (!parameters.parameters) {
			setError(parameters.error);
			return;
		}
		clearFeedback();
		if (advanced === null) {
			setAdvanced(JSON.stringify(parameters.parameters, null, 2));
		} else {
			setDraft({ ...draft, model: { ...draft.model, parameters: parameters.parameters } });
			setParameterEdits({});
			setAdvanced(null);
		}
	}
	function addMcp(entries: readonly McpCatalogEntry[]) {
		if (!entries.length || entries.length > maxRouterMcpServers - draft.mcp_servers.length) return;
		void act("resource", async () => {
			const loaded = await Promise.all(
				entries.map(async ({ id, name }) => {
					try {
						const detail = await mcpApi.get(id);
						const revision = detail.revisions.find((item) => item.revision === detail.currentRevision);
						if (!revision || detail.status !== "enabled") throw new Error("当前 MCP 版本不可用。");
						return {
							detail,
							selection: {
								server_id: id,
								revision: revision.revision,
								authentication: revision.config.authentication,
								tool_allowlist: [],
							} satisfies McpSelection,
						};
					} catch (cause) {
						throw new Error(`无法添加「${name}」。${errorText(cause)}`);
					}
				}),
			);
			setMcp((current) => ({
				...current,
				...Object.fromEntries(loaded.map(({ detail, selection }) => [selection.server_id, detail])),
			}));
			setDraft((current) => ({
				...current,
				mcp_servers: [...current.mcp_servers, ...loaded.map(({ selection }) => selection)],
			}));
			setAddingMcp(false);
		});
	}
	function addSkill(id: string) {
		const currentRevision = catalog?.skills?.find((item) => item.id === id)?.revision;
		if (!currentRevision) return;
		void act("resource", async () => {
			const detail = await skillApi.get(id);
			const revision = detail.revisions.find((item) => item.revision === currentRevision);
			if (!revision) throw new Error("当前 Skill 版本不可用。");
			setSkills((current) => ({ ...current, [id]: detail }));
			setDraft((current) => ({
				...current,
				skills: [
					...current.skills,
					{ skill_id: id, revision: revision.revision, artifact_hash: revision.sourceHash },
				],
			}));
		});
	}

	const mcpOptions = (catalog?.mcpServers ?? []).filter(
		(entry) => !draft.mcp_servers.some((item) => item.server_id === entry.id),
	);
	const remainingMcpSlots = maxRouterMcpServers - draft.mcp_servers.length;
	const skillOptions = (catalog?.skills ?? [])
		.filter((entry) => !draft.skills.some((item) => item.skill_id === entry.id))
		.map((entry) => ({ value: entry.id, label: entry.name, detail: `v${entry.revision}` }));
	const failure = conflict ? "配置已被其他操作更新。重新加载前，当前修改仍保留。" : error || catalogError;
	const progress = busy === "saving" ? "正在保存配置…" : busy === "loading" ? "正在加载配置…" : "处理中…";

	return (
		<>
			<OrchestrationDrawer
				title={`配置 API Key · ${keyRecord.name}`}
				className={styles.configurationDrawer}
				busy={Boolean(busy)}
				onClose={() => void close()}
				footer={
					<div className={styles.configurationFooter}>
						<div id={feedbackId} className={styles.footerFeedback}>
							{busy ? (
								<output>{progress}</output>
							) : failure ? (
								<p role="alert" className={styles.errorMessage}>
									{failure}
								</p>
							) : notice ? (
								<output className={styles.successMessage}>{notice}</output>
							) : (
								settings && (
									<output>
										{readonly
											? "此 Key 已撤销"
											: addingMcp
												? "请完成服务选择。"
												: validation || (dirty ? "有未保存的修改" : "未修改")}
									</output>
								)
							)}
						</div>
						<div className={styles.drawerActions}>
							{retry ? (
								<AuroraButton disabled={Boolean(busy)} onClick={() => void reload()}>
									重新加载
								</AuroraButton>
							) : (
								<AuroraButton disabled={Boolean(busy)} onClick={() => void close()}>
									{dirty ? "取消" : "关闭"}
								</AuroraButton>
							)}
							<AuroraButton
								type="submit"
								variant="accent"
								form={formId}
								aria-describedby={feedbackId}
								disabled={!canSave}
							>
								{busy === "saving" ? "保存中…" : "保存配置"}
							</AuroraButton>
						</div>
					</div>
				}
			>
				{settings && (
					<>
						<div className={styles.configurationStatus}>
							<AuroraPill tone="accent">{routerScopeLabel[settings.scope]}</AuroraPill>
							<span>{settings.capabilityRevision ? `配置修订 v${settings.capabilityRevision}` : "待配置"}</span>
						</div>
						<form
							id={formId}
							onSubmit={(event) => {
								event.preventDefault();
								save();
							}}
							noValidate
						>
							<fieldset disabled={locked} className={styles.configurationFields} aria-label="API Key 配置">
								<ConfigurationSection title="模型配置">
									<div className={styles.field}>
										<span>模型</span>
										<KeyDropdown
											label="选择模型"
											value={modelValue}
											options={modelOptions}
											disabled={locked}
											placeholder={draft.model.model_id ? `${draft.model.model_id}（不可用）` : "请选择模型"}
											onSelect={(value) => {
												const next = modelOptions.find((item) => item.value === value)?.model;
												if (!next || value === modelValue) return;
												updateDraft({
													...draft,
													model: { provider: next.provider, model_id: next.id, parameters: {} },
												});
												setParameterEdits({});
												setAdvanced(null);
											}}
										/>
									</div>
									<div className={styles.parameterHeader}>
										<h4>模型参数</h4>
										<AuroraButton
											type="button"
											variant="ghost"
											size="sm"
											disabled={locked}
											onClick={toggleAdvanced}
										>
											{advanced === null ? "高级配置" : "返回表单"}
										</AuroraButton>
									</div>
									{advanced !== null ? (
										<div className={styles.advancedEditor}>
											<label className={styles.field}>
												<span>参数 JSON</span>
												<textarea
													className={styles.jsonEditor}
													rows={6}
													spellCheck={false}
													value={advanced}
													aria-invalid={Boolean(parameters.error)}
													onChange={(event) => {
														clearFeedback();
														setAdvanced(event.currentTarget.value);
													}}
												/>
											</label>
											<AuroraButton
												type="button"
												size="sm"
												variant="ghost"
												onClick={() => {
													clearFeedback();
													setAdvanced(null);
												}}
											>
												放弃 JSON 修改
											</AuroraButton>
										</div>
									) : (
										<div className={styles.parameterGrid}>
											{modelParameterFields.map((field) => {
												const saved = draft.model.parameters[parameterKey(draft.model.parameters, field)];
												return (
													<label key={field.key} className={styles.field}>
														<span>{field.label}</span>
														<input
															inputMode={field.integer ? "numeric" : "decimal"}
															placeholder="模型默认值"
															value={parameterEdits[field.key] ?? (saved == null ? "" : String(saved))}
															onChange={(event) => {
																clearFeedback();
																setParameterEdits({
																	...parameterEdits,
																	[field.key]: event.currentTarget.value,
																});
															}}
														/>
													</label>
												);
											})}
										</div>
									)}
								</ConfigurationSection>
								<ConfigurationSection
									title="MCP 工具"
									actions={
										<AuroraButton
											size="sm"
											aria-expanded={addingMcp}
											disabled={locked || !mcpOptions.length || remainingMcpSlots <= 0}
											onClick={() => setAddingMcp(!addingMcp)}
										>
											{addingMcp ? "收起服务选择" : "＋ 添加服务"}
										</AuroraButton>
									}
								>
									{addingMcp && (
										<McpServerPicker
											entries={mcpOptions}
											capacity={remainingMcpSlots}
											disabled={locked}
											onAdd={addMcp}
										/>
									)}
									{draft.mcp_servers.length === 0 && <p className={styles.resourceEmpty}>尚未添加 MCP 服务</p>}
									{draft.mcp_servers.map((item) => (
										<McpResource
											key={item.server_id}
											item={item}
											detail={mcp[item.server_id]}
											disabled={locked}
											onChange={(next) =>
												updateDraft({
													...draft,
													mcp_servers: draft.mcp_servers.map((entry) =>
														entry.server_id === item.server_id ? next : entry,
													),
												})
											}
											onRemove={() =>
												updateDraft({
													...draft,
													mcp_servers: draft.mcp_servers.filter(
														(entry) => entry.server_id !== item.server_id,
													),
												})
											}
										/>
									))}
								</ConfigurationSection>
								<ConfigurationSection
									title="Skills"
									actions={
										<KeyDropdown
											label="添加 Skill"
											placeholder="＋ 添加 Skill"
											options={skillOptions}
											onSelect={addSkill}
											compact
											disabled={locked || draft.skills.length >= 32}
										/>
									}
								>
									{draft.skills.length === 0 && <p className={styles.resourceEmpty}>尚未添加 Skill</p>}
									{draft.skills.map((item) => (
										<SkillResource
											key={item.skill_id}
											item={item}
											detail={skills[item.skill_id]}
											disabled={locked}
											onChange={(next) =>
												updateDraft({
													...draft,
													skills: draft.skills.map((entry) =>
														entry.skill_id === item.skill_id ? next : entry,
													),
												})
											}
											onRemove={() =>
												updateDraft({
													...draft,
													skills: draft.skills.filter((entry) => entry.skill_id !== item.skill_id),
												})
											}
										/>
									))}
								</ConfigurationSection>
								<ConfigurationSection title="本地工具">
									<label>
										<input
											type="checkbox"
											checked={draft.local_tools?.includes("bash") ?? false}
											onChange={(event) => updateDraft({ ...draft, local_tools: event.currentTarget.checked ? ["bash"] : [] })}
										/>
										允许 Bash（Linux Sandbox）
									</label>
								</ConfigurationSection>
								<ConfigurationSection title="运行策略">
									<div className={styles.policyGrid}>
										{policyFields.map(({ field, label, max, unit }) => (
											<label key={field} className={styles.field}>
												<span>{label}</span>
												<span className={styles.unitInput}>
													<input
														type="number"
														inputMode="numeric"
														min={1}
														max={max}
														step={1}
														value={draft.execution_policy[field] || ""}
														aria-invalid={invalidPolicy?.field === field}
														onChange={(event) =>
															updateDraft({
																...draft,
																execution_policy: {
																	...draft.execution_policy,
																	[field]: Number(event.currentTarget.value),
																},
															})
														}
													/>
													<span>{unit}</span>
												</span>
											</label>
										))}
									</div>
								</ConfigurationSection>
							</fieldset>
						</form>
						{!readonly && (settings.scope === "dual" || settings.canRollback) && (
							<details className={styles.scopeDetails}>
								<summary>兼容范围</summary>
								{settings.scope === "dual" && (
									<>
										<label className={styles.checkChoice}>
											<input
												type="checkbox"
												checked={confirmed}
												disabled={locked || dirty}
												onChange={(event) => setConfirmed(event.currentTarget.checked)}
											/>
											已确认调用方完成迁移
										</label>
										<AuroraButton
											disabled={locked || dirty || !confirmed || settings.capabilities === null}
											onClick={() => changeScope("cutover")}
										>
											切为 Router-only
										</AuroraButton>
									</>
								)}
								{settings.canRollback && (
									<AuroraButton disabled={locked || dirty} onClick={() => changeScope("rollback")}>
										恢复双入口
									</AuroraButton>
								)}
							</details>
						)}
					</>
				)}
			</OrchestrationDrawer>
			{dialogs.dialog}
		</>
	);
}

function ConfigurationSection({
	title,
	actions,
	children,
}: {
	title: string;
	actions?: ReactNode;
	children: ReactNode;
}): React.JSX.Element {
	const titleId = useId();
	return (
		<section className={styles.configurationSection} aria-labelledby={titleId}>
			<div className={styles.sectionHeader}>
				<h3 id={titleId}>{title}</h3>
				{actions}
			</div>
			{children}
		</section>
	);
}

function McpServerPicker({
	entries,
	capacity,
	disabled,
	onAdd,
}: {
	entries: readonly McpCatalogEntry[];
	capacity: number;
	disabled: boolean;
	onAdd: (entries: readonly McpCatalogEntry[]) => void;
}): React.JSX.Element {
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<readonly string[]>([]);
	const filter = query.trim().toLowerCase();
	const visible = entries.filter((entry) => entry.name.toLowerCase().includes(filter));
	return (
		<div className={styles.mcpServerPicker}>
			<div className={styles.mcpSearch}>
				<AuroraSearchBox
					value={query}
					onChange={setQuery}
					onKeyDown={preventSearchSubmit}
					placeholder="搜索 MCP 服务…"
				/>
			</div>
			{visible.length ? (
				<div className={styles.toolOptions}>
					{visible.map((entry) => (
						<label key={entry.id} className={styles.checkChoice}>
							<input
								type="checkbox"
								checked={selected.includes(entry.id)}
								disabled={disabled || (!selected.includes(entry.id) && selected.length >= capacity)}
								onChange={(event) =>
									setSelected(
										event.currentTarget.checked
											? [...selected, entry.id]
											: selected.filter((id) => id !== entry.id),
									)
								}
							/>
							<span>
								{entry.name}{" "}
								<small>
									v{entry.revision} · {entry.tools.length} 个工具
								</small>
							</span>
						</label>
					))}
				</div>
			) : (
				<p className={styles.resourceEmpty}>没有匹配的 MCP 服务</p>
			)}
			<div className={styles.mcpPickerBar}>
				<output className={styles.subtle}>
					已选 {selected.length} 个 · 最多可添加 {capacity} 个
				</output>
				<AuroraButton
					variant="primary"
					size="sm"
					disabled={disabled || selected.length === 0}
					onClick={() => onAdd(entries.filter((entry) => selected.includes(entry.id)))}
				>
					{selected.length ? `添加 ${selected.length} 个服务` : "添加服务"}
				</AuroraButton>
			</div>
		</div>
	);
}

function McpResource({
	item,
	detail,
	disabled,
	onChange,
	onRemove,
}: {
	item: McpSelection;
	detail?: McpServerDetail;
	disabled: boolean;
	onChange: (next: McpSelection) => void;
	onRemove: () => void;
}): React.JSX.Element {
	const name = detail?.name ?? item.server_id;
	const picked = detail?.revisions.find((entry) => entry.revision === item.revision);
	const [toolsOpen, setToolsOpen] = useState(item.tool_allowlist.length === 0);
	return (
		<article className={styles.resourceCard} aria-label={name}>
			<div className={styles.resourceHeading}>
				<div className={styles.resourceName}>
					<strong>{name}</strong>
					<AuroraPill tone={item.tool_allowlist.length ? "accent" : "amber"}>
						{item.tool_allowlist.length} 个工具
					</AuroraPill>
				</div>
				<div className={styles.resourceActions}>
					<KeyDropdown
						label={`${name}版本`}
						value={String(item.revision)}
						placeholder={`v${item.revision}`}
						options={(detail?.revisions ?? []).map((revision) => ({
							value: String(revision.revision),
							label: `v${revision.revision}`,
						}))}
						disabled={disabled}
						compact
						onSelect={(value) => {
							const revision = detail?.revisions.find((entry) => String(entry.revision) === value);
							if (revision && revision.revision !== item.revision) {
								setToolsOpen(true);
								onChange({
									...item,
									revision: revision.revision,
									authentication: revision.config.authentication,
									tool_allowlist: [],
								});
							}
						}}
					/>
					<AuroraButton
						size="sm"
						variant="ghost"
						disabled={disabled}
						aria-label={`移除 ${name}`}
						onClick={onRemove}
					>
						移除
					</AuroraButton>
				</div>
			</div>
			{item.tool_allowlist.length > 0 && (
				<div className={styles.toolChips}>
					{item.tool_allowlist.slice(0, 6).map((tool) => (
						<AuroraPill key={tool}>{tool}</AuroraPill>
					))}
					{item.tool_allowlist.length > 6 && (
						<span className={styles.subtle} title={item.tool_allowlist.join("、")}>
							另有 {item.tool_allowlist.length - 6} 个
						</span>
					)}
				</div>
			)}
			{picked ? (
				<details
					className={styles.toolsDetails}
					open={toolsOpen}
					onToggle={(event) => setToolsOpen(event.currentTarget.open)}
				>
					<summary>
						选择工具{" "}
						<span>
							{item.tool_allowlist.length} / {picked.tools.length}
						</span>
					</summary>
					{picked.tools.length === 0 ? (
						<p className={styles.resourceEmpty}>此版本没有可用工具</p>
					) : (
						<McpToolPicker
							key={picked.revision}
							name={name}
							tools={picked.tools}
							allowlist={item.tool_allowlist}
							disabled={disabled}
							onChange={(tool_allowlist) => onChange({ ...item, tool_allowlist })}
						/>
					)}
				</details>
			) : (
				<p className={styles.resourceEmpty}>无法读取所选版本</p>
			)}
		</article>
	);
}

function McpToolPicker({
	name,
	tools,
	allowlist,
	disabled,
	onChange,
}: {
	name: string;
	tools: readonly McpToolRef[];
	allowlist: readonly string[];
	disabled: boolean;
	onChange: (allowlist: string[]) => void;
}): React.JSX.Element {
	const [query, setQuery] = useState("");
	const filter = query.trim().toLowerCase();
	const visible = tools.filter((tool) => tool.name.toLowerCase().includes(filter));
	const visibleNames = visible.map((tool) => tool.name);
	const selectAll = updateMcpToolAllowlist(allowlist, visibleNames, true);
	const deselectAll = updateMcpToolAllowlist(allowlist, visibleNames, false);
	const overLimit = selectAll.length > maxRouterMcpTools;
	return (
		<div className={styles.mcpToolPicker}>
			<div className={styles.mcpPickerBar}>
				<div className={styles.mcpSearch}>
					<AuroraSearchBox
						value={query}
						onChange={setQuery}
						onKeyDown={preventSearchSubmit}
						placeholder="搜索工具…"
						ariaLabel={`搜索 ${name} 的工具`}
					/>
				</div>
				<div className={styles.mcpBulkActions}>
					<AuroraButton
						size="sm"
						variant="ghost"
						disabled={disabled || overLimit || selectAll.length === allowlist.length}
						onClick={() => onChange(selectAll)}
					>
						{filter ? "全选筛选结果" : "全选工具"}
					</AuroraButton>
					<AuroraButton
						size="sm"
						variant="ghost"
						disabled={disabled || deselectAll.length === allowlist.length}
						onClick={() => onChange(deselectAll)}
					>
						{filter ? "取消筛选结果" : "清空选择"}
					</AuroraButton>
				</div>
			</div>
			{overLimit && (
				<p className={styles.resourceEmpty}>每个服务最多授权 {maxRouterMcpTools} 个工具，可缩小筛选范围。</p>
			)}
			{visible.length ? (
				<div className={styles.toolOptions}>
					{visible.map((tool) => {
						const checked = allowlist.includes(tool.name);
						return (
							<label className={styles.checkChoice} key={tool.id} title={tool.description ?? tool.name}>
								<input
									type="checkbox"
									disabled={disabled || (!checked && allowlist.length >= maxRouterMcpTools)}
									checked={checked}
									onChange={(event) =>
										onChange(updateMcpToolAllowlist(allowlist, [tool.name], event.currentTarget.checked))
									}
								/>
								<span>{tool.name}</span>
							</label>
						);
					})}
				</div>
			) : (
				<p className={styles.resourceEmpty}>没有匹配的工具</p>
			)}
		</div>
	);
}

function SkillResource({
	item,
	detail,
	disabled,
	onChange,
	onRemove,
}: {
	item: SkillSelection;
	detail?: SkillDetail;
	disabled: boolean;
	onChange: (next: SkillSelection) => void;
	onRemove: () => void;
}): React.JSX.Element {
	const name = detail?.name ?? item.skill_id;
	return (
		<article className={styles.resourceCard} aria-label={name}>
			<div className={styles.resourceHeading}>
				<div className={styles.resourceName}>
					<strong>{name}</strong>
				</div>
				<div className={styles.resourceActions}>
					<KeyDropdown
						label={`${name}版本`}
						value={String(item.revision)}
						placeholder={`v${item.revision}`}
						options={(detail?.revisions ?? []).map((revision) => ({
							value: String(revision.revision),
							label: `v${revision.revision}`,
						}))}
						compact
						disabled={disabled}
						onSelect={(value) => {
							const revision = detail?.revisions.find((entry) => String(entry.revision) === value);
							if (revision && revision.revision !== item.revision)
								onChange({ ...item, revision: revision.revision, artifact_hash: revision.sourceHash });
						}}
					/>
					<AuroraButton
						size="sm"
						variant="ghost"
						disabled={disabled}
						aria-label={`移除 ${name}`}
						onClick={onRemove}
					>
						移除
					</AuroraButton>
				</div>
			</div>
			{!detail?.revisions.some((revision) => revision.revision === item.revision) && (
				<p className={styles.resourceEmpty}>无法读取所选版本</p>
			)}
		</article>
	);
}
