import type { OrchestrationCatalog } from "@earendil-works/pi-protocol";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { AaasKeysApi, type AaasBinding, type AaasConfig, type AaasConfigVersion, type AaasKey } from "../api/aaas-keys-api.ts";
import { OrchestrationApi } from "../api/orchestration-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";
import styles from "./aaas-current-configuration-page.module.css";

type ServerRef = { mcpServerId: string; revision: number; toolNames: string[] };
type Draft = {
	systemPrompt: string;
	modelId: string;
	parameters: { reasoning?: { enabled?: boolean; effort?: string } };
	mcpServers: ServerRef[];
	skills: { skillId: string; revision: number }[];
	contextPolicy?: Record<string, number>;
};
type Configuration = {
	id: string;
	name: string;
	draft: Draft;
	draftRevision: number;
	versions: { id: string; revision: number; createdAt: string }[];
};
type Snapshot = { id: string; revision: number; snapshot: Draft };
export type MappingRule = {
	mcpServerId: string;
	credentialId: string;
	parameter: string;
	toolNames: string[];
};
type MappingForm = MappingRule & { original?: { credentialId: string; parameter: string } };
const bare = (id: string) => id.replace(/^orv_/, "");
const message = (error: unknown) => (error instanceof Error ? error.message : "请求失败");
const blank = (): Draft => ({ systemPrompt: "", modelId: "", parameters: {}, mcpServers: [], skills: [] });
export function associatedKeys(keys: readonly AaasKey[], configurationId: string): AaasKey[] {
	return keys.filter(
		(key) =>
			key.configurationMode === "platform" ||
			(key.configurationMode === "configuration" && key.orchestrationConfigurationId === configurationId),
	);
}
export function toolDifference(selected: readonly string[], available: readonly string[]) {
	return {
		added: available.filter((name) => !selected.includes(name)),
		removed: selected.filter((name) => !available.includes(name)),
	};
}
export function addBatchBindings(current: readonly AaasBinding[], serverId: string, parameter: string, toolNames: readonly string[]): AaasBinding[] {
	return [...current, ...toolNames.filter((name) => !current.some((row) => row.mcpServerId === serverId && row.toolName === name && row.parameter === parameter)).map((toolName) => ({ mcpServerId: serverId, toolName, parameter, credentialId: "tool_credential" }))];
}
/** Merge per-tool bindings into one rule per (Server, source credential, target parameter). */
export function mergeMappingRules(bindings: readonly AaasBinding[]): MappingRule[] {
	const merged = new Map<string, MappingRule>();
	for (const binding of bindings) {
		const key = `${binding.mcpServerId}\u0000${binding.credentialId}\u0000${binding.parameter}`;
		const rule = merged.get(key);
		if (rule) {
			if (!rule.toolNames.includes(binding.toolName)) rule.toolNames.push(binding.toolName);
		} else {
			merged.set(key, {
				mcpServerId: binding.mcpServerId,
				credentialId: binding.credentialId,
				parameter: binding.parameter,
				toolNames: [binding.toolName],
			});
		}
	}
	return [...merged.values()].map((rule) => ({ ...rule, toolNames: [...rule.toolNames].sort() }));
}
export function replaceMappingRules(
	current: readonly AaasBinding[],
	target: { mcpServerId: string; credentialId: string; parameter: string },
	toolNames: readonly string[],
	original?: { credentialId: string; parameter: string },
): AaasBinding[] {
	const kept = current.filter((binding) =>
		!(
			binding.mcpServerId === target.mcpServerId &&
			binding.credentialId === (original?.credentialId ?? target.credentialId) &&
			binding.parameter === (original?.parameter ?? target.parameter)
		),
	);
	return [
		...kept,
		...toolNames.map((toolName) => ({
			mcpServerId: target.mcpServerId,
			credentialId: target.credentialId,
			parameter: target.parameter,
			toolName,
		})),
	];
}
export function removeMappingRule(
	bindings: readonly AaasBinding[],
	rule: { mcpServerId: string; credentialId: string; parameter: string },
): AaasBinding[] {
	return bindings.filter(
		(binding) =>
			!(
				binding.mcpServerId === rule.mcpServerId &&
				binding.credentialId === rule.credentialId &&
				binding.parameter === rule.parameter
			),
	);
}

/** Compatibility entry with a frozen history view after the last legacy Key retires. */
export function AdminAaasLegacyConfigurationPage(): React.JSX.Element {
	const { controller } = useAdminAuth();
	const keys = useMemo(() => new AaasKeysApi(controller), [controller]);
	const api = useMemo(() => new OrchestrationApi(controller), [controller]);
	const [writable, setWritable] = useState<boolean | null>(null);
	const [versions, setVersions] = useState<readonly AaasConfigVersion[]>([]);
	const [detail, setDetail] = useState<Snapshot | null>(null);
	const [error, setError] = useState("");
	const [reading, setReading] = useState(false);
	useEffect(() => {
		let active = true;
		void keys.request<{ writable: boolean }>("/legacy-configuration-status").then(async (status) => {
			if (!status.writable) {
				const rows = await keys.request<AaasConfigVersion[]>("/platform-configuration/versions");
				if (active) setVersions(rows);
			}
			if (active) setWritable(status.writable);
		}).catch((cause) => { if (active) setError(message(cause)); });
		return () => { active = false; };
	}, [keys]);
	async function open(item: AaasConfigVersion) {
		setError("");
		setReading(true);
		try { setDetail(await api.request<Snapshot>(`configurations/${item.configuration_id}/versions/${item.orchestration_version_id}`)); }
		catch (cause) { setError(message(cause)); }
		finally { setReading(false); }
	}
	if (writable === true) return <AdminAaasCurrentConfigurationPage />;
	return <section className={styles.page}>
		<header><h1>旧 AaaS 配置历史</h1><button type="button" onClick={() => navigate("/aaas-keys")}>返回 Key 管理</button></header>
		{error && <p role="alert">{error}</p>}
		{writable === null && !error && <p role="status">正在读取配置状态…</p>}
		{writable === false && <><p>当前租户的旧 AaaS 配置已进入只读状态。</p>
			{versions.length === 0 && <p>没有历史版本。</p>}
			<ul>{versions.map((item) => <li key={item.orchestration_version_id}>
				<button type="button" disabled={reading} onClick={() => void open(item)}>{item.name} · v{item.revision} · {item.model_id ?? "模型未知"}</button>
			</li>)}</ul>
			{detail && <details open><summary>冻结配置 · v{detail.revision}</summary><pre>{JSON.stringify(detail.snapshot, null, 2)}</pre></details>}
		</>}
	</section>;
}

export function AdminAaasCurrentConfigurationPage(): React.JSX.Element {
	const { controller } = useAdminAuth();
	const api = useMemo(() => new OrchestrationApi(controller), [controller]);
	const keys = useMemo(() => new AaasKeysApi(controller), [controller]);
	const [catalog, setCatalog] = useState<OrchestrationCatalog | null>(null);
	const [platform, setPlatform] = useState<AaasConfig | null>(null);
	const [config, setConfig] = useState<Configuration | null>(null);
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [name, setName] = useState("");
	const [bindings, setBindings] = useState<AaasBinding[]>([]);
	const [savedBindings, setSavedBindings] = useState<AaasBinding[]>([]);
	const [mappingConfirmed, setMappingConfirmed] = useState(false);
	const [keyList, setKeyList] = useState<AaasKey[] | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [history, setHistory] = useState(false);
	const [detail, setDetail] = useState<Snapshot | null>(null);
	const [modelOptions, setModelOptions] = useState(false);
	const [mappingOpen, setMappingOpen] = useState(true);
	const [expandedServer, setExpandedServer] = useState<string | null>(null);
	const [mappingGroup, setMappingGroup] = useState<string | null>(null);
	const [mappingToolList, setMappingToolList] = useState<string | null>(null);
	const [mappingForm, setMappingForm] = useState<MappingForm | null>(null);
	const [formError, setFormError] = useState("");

	const load = useCallback(async () => {
		setError("");
		try {
			const [nextCatalog, nextPlatform, nextKeys] = await Promise.all([
				api.request<OrchestrationCatalog>("catalog"),
				keys.request<AaasConfig | null>("/platform-configuration"),
				keys.request<AaasKey[]>().catch(() => null),
			]);
			setCatalog(nextCatalog);
			setPlatform(nextPlatform);
			setKeyList(nextKeys);
			if (!nextPlatform) {
				setConfig(null);
				setSnapshot(null);
				setDraft(blank());
				setName("");
				setBindings([]);
				setSavedBindings([]);
				setMappingConfirmed(false);
				return true;
			}
			const id = bare(nextPlatform.orchestration_version_id);
			const [nextConfig, nextSnapshot, bindingResult] = await Promise.all([
				api.request<Configuration>(`configurations/${nextPlatform.configuration_id}`),
				api.request<Snapshot>(`configurations/${nextPlatform.configuration_id}/versions/${id}`),
				keys.request<{ credential_bindings: AaasBinding[] | null }>(`/versions/${id}/credential-bindings`),
			]);
			setConfig(nextConfig);
			setSnapshot(nextSnapshot);
			setDraft(nextConfig.draft);
			setName(nextConfig.name);
			setBindings(bindingResult.credential_bindings ?? []);
			setSavedBindings(bindingResult.credential_bindings ?? []);
			setMappingConfirmed(bindingResult.credential_bindings !== null);
			return true;
		} catch (caught) {
			setError(message(caught));
			return false;
		} finally {
			setLoaded(true);
		}
	}, [api, keys]);
	useEffect(() => {
		void load();
	}, [load]);

	async function save(apply: boolean) {
		if (!draft) return;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			if (!name.trim() || !draft.modelId) throw new Error("请填写配置名称并选择模型。");
			if (apply && !mappingConfirmed) throw new Error("请确认工具敏感参数映射；无需映射时请明确选择空映射。");
			if (!apply && JSON.stringify(bindings) !== JSON.stringify(savedBindings))
				throw new Error("敏感参数映射仅随新版本保存；请保存并生效，或先撤销映射更改。");
			if (apply) {
				await api.request("configurations/current", "PUT", {
					configuration_id: config?.id ?? null,
					name: name.trim(),
					draft,
					credential_bindings: bindings,
					...(config ? { expected_revision: config.draftRevision } : {}),
				});
				if (await load()) setNotice("配置已保存并生效，新任务将使用新版本。");
			} else {
				const next = config
					? await api.request<Configuration>(`configurations/${config.id}/draft`, "PUT", {
							expectedRevision: config.draftRevision,
							draft,
						})
					: await api.request<Configuration>("configurations", "POST", { name: name.trim(), draft });
				setConfig(next);
				setDraft(next.draft);
				setNotice("草稿已保存，当前生效版本未改变。");
			}
		} catch (caught) {
			setError(message(caught));
		} finally {
			setBusy(false);
		}
	}
	const model = catalog?.models.find((item) => item.id === draft?.modelId);
	const reasoning = model?.parameterCapabilities.reasoning;
	const activeModel =
		catalog?.models.find((item) => item.id === snapshot?.snapshot.modelId)?.name ?? snapshot?.snapshot.modelId ?? "—";
	const selectedTotal = draft?.mcpServers.reduce((n, server) => n + server.toolNames.length, 0) ?? 0;
	const activeTotal = snapshot?.snapshot.mcpServers.reduce((n, server) => n + server.toolNames.length, 0) ?? 0;
	const associated = keyList && config ? associatedKeys(keyList, config.id) : null;
	const updateServer = (ref: ServerRef | null, id: string) =>
		draft &&
		setDraft({
			...draft,
			mcpServers: [...draft.mcpServers.filter((item) => item.mcpServerId !== id), ...(ref ? [ref] : [])],
		});
	const versions = config?.versions ?? [];
	const activeVersion = versions.find(
		(version) => bare(version.id) === bare(platform?.orchestration_version_id ?? ""),
	);
	const recentVersions = [
		...(activeVersion ? [activeVersion] : []),
		...versions.filter((version) => version.id !== activeVersion?.id),
	].slice(0, 3);
	const showVersion = async (id: string) => {
		if (!config) return;
		try {
			setDetail(await api.request<Snapshot>(`configurations/${config.id}/versions/${id}`));
		} catch (caught) {
			setError(message(caught));
		}
	};

	const mappingRules = useMemo(() => mergeMappingRules(bindings), [bindings]);
	const mappingDirty = JSON.stringify(bindings) !== JSON.stringify(savedBindings);
	const mappingServers = useMemo(() => {
		const ids = new Set(draft?.mcpServers.map((server) => server.mcpServerId) ?? []);
		for (const rule of mappingRules) ids.add(rule.mcpServerId);
		return [...ids].map((id) => ({ id, name: catalog?.mcpServers?.find((server) => server.id === id)?.name ?? id }));
	}, [draft, catalog, mappingRules]);
	const mappingTools = (serverId: string) => {
		const ref = draft?.mcpServers.find((server) => server.mcpServerId === serverId);
		const server = catalog?.mcpServers?.find((item) => item.id === serverId);
		return server?.tools.filter((tool) => !ref || ref.toolNames.includes(tool.name)) ?? [];
	};
	const mappingParameters = (serverId: string) =>
		[...new Set(mappingTools(serverId).flatMap((tool) => tool.credentialParameters))];
	const openMappingForm = (rule?: MappingRule) => {
		setFormError("");
		setMappingForm(
			rule
				? {
						...rule,
						toolNames: [...rule.toolNames],
						original: { credentialId: rule.credentialId, parameter: rule.parameter },
					}
				: {
						mcpServerId: draft?.mcpServers[0]?.mcpServerId ?? mappingServers[0]?.id ?? "",
						credentialId: "tool_credential",
						parameter: "",
						toolNames: [],
					},
		);
	};
	const commitMappingForm = () => {
		const form = mappingForm;
		if (!form) return;
		if (!form.mcpServerId) return setFormError("请选择 MCP Server。");
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(form.credentialId) || form.credentialId.length > 100)
			return setFormError("来源凭据 ID 需以字母或下划线开头，仅含字母、数字和下划线，且不超过 100 字符。");
		if (!form.parameter) return setFormError("请选择目标参数。");
		if (form.toolNames.length === 0) return setFormError("请至少选择一个应用工具。");
		setBindings((current) =>
			replaceMappingRules(
				current,
				{ mcpServerId: form.mcpServerId, credentialId: form.credentialId, parameter: form.parameter },
				form.toolNames,
				form.original,
			),
		);
		setMappingConfirmed(true);
		setMappingForm(null);
	};
	const dropMappingRule = (rule: MappingRule) => {
		setBindings((current) => removeMappingRule(current, rule));
		setMappingConfirmed(true);
	};

	return (
		<section className={styles.page}>
			<header className={styles.heading}>
				<h1>AaaS 执行配置</h1>
				<p>管理 AaaS 任务的执行能力（模型、MCP 工具、Skills 与敏感参数映射）。</p>
			</header>
			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			{notice && <output className={styles.notice}>{notice}</output>}
			{!loaded ? (
				<div className={styles.empty}>正在读取配置…</div>
			) : !platform || !snapshot ? (
				!error && (
					<div className={styles.empty}>
						<strong>尚未配置平台默认执行配置</strong>
						<p>创建并保存生效后，未指定配置的 Key 将使用该配置。</p>
					</div>
				)
			) : (
				<section className={styles.overview} aria-label="当前平台默认配置">
					<div className={styles.overviewName}>
						<span className={styles.icon}>▱</span>
						<div>
							<strong>{name}</strong> <span className={styles.badge}>平台默认</span>
							<small>供使用平台默认模式的 API Key 使用</small>
						</div>
					</div>
					<div className={styles.metric}>
						<span>当前生效版本</span>
						<strong>
							v{snapshot.revision} <i className={styles.badge}>已生效</i>
						</strong>
					</div>
					<div className={styles.metric}>
						<span>模型</span>
						<strong>{activeModel}</strong>
					</div>
					<div className={styles.metric}>
						<span>MCP Server</span>
						<strong>{snapshot.snapshot.mcpServers.length} 个</strong>
					</div>
					<div className={styles.metric}>
						<span>工具总数</span>
						<strong>{activeTotal}</strong>
					</div>
					<div className={styles.metric}>
						<span>Skills</span>
						<strong>{snapshot.snapshot.skills.length}</strong>
					</div>
					<button className={styles.button} onClick={() => void showVersion(snapshot.id)}>
						查看配置详情
					</button>
				</section>
			)}
			{draft && (
				<div className={styles.layout}>
					<main className={styles.editor}>
						<div className={styles.toolbar}>
							<div className={styles.tabs}>
								<button className={!history ? styles.tabActive : ""} onClick={() => setHistory(false)}>
									配置编辑
								</button>
								<button className={history ? styles.tabActive : ""} onClick={() => setHistory(true)}>
									版本历史
								</button>
							</div>
							<div className={styles.actions}>
								{!history && (
									<>
										<button className={styles.button} disabled={busy} onClick={() => void save(false)}>
											仅保存草稿
										</button>
										<button className={styles.primary} disabled={busy} onClick={() => void save(true)}>
											✓ 保存并生效
										</button>
									</>
								)}
							</div>
						</div>
						{history ? (
							<div className={styles.sections}>
								<h2>版本历史</h2>
								<p className={styles.hint}>已发布版本不可修改。</p>
								{versions.map((v) => (
									<div className={styles.versionRow} key={v.id}>
										<strong>v{v.revision}</strong>
										{bare(v.id) === bare(platform?.orchestration_version_id ?? "") && (
											<span className={styles.badge}>当前生效</span>
										)}
										<span>{new Date(v.createdAt).toLocaleString("zh-CN")}</span>
										<button className={styles.link} onClick={() => void showVersion(v.id)}>
											查看
										</button>
									</div>
								))}
							</div>
						) : (
							<div className={styles.sections}>
								{!config && (
									<label className={styles.nameField}>
										配置名称{" "}
										<input
											value={name}
											onChange={(e) => setName(e.target.value)}
											placeholder="输入配置名称"
										/>
									</label>
								)}
								<section className={styles.section}>
									<div className={styles.sectionHead}>
										<span className={styles.icon}>◇</span>
										<div className={styles.sectionTitle}>
											<h2>模型配置</h2>
											<p>选择执行任务使用的模型与推理参数</p>
										</div>
										<select
											aria-label="模型"
											value={draft.modelId}
											onChange={(e) => setDraft({ ...draft, modelId: e.target.value, parameters: {} })}
										>
											<option value="">请选择模型</option>
											{catalog?.models.map((m) => (
												<option key={`${m.provider}/${m.id}`} value={m.id}>
													{m.name} · {m.provider}
												</option>
											))}
										</select>
										<button className={styles.button} onClick={() => setModelOptions(!modelOptions)}>
											推理参数
										</button>
									</div>
									{modelOptions && (
										<div className={styles.expanded}>
											{reasoning?.supported ? (
												<label>
													思考模式{" "}
													<select
														value={
															draft.parameters.reasoning?.enabled === false
																? "off"
																: (draft.parameters.reasoning?.effort ??
																	(draft.parameters.reasoning?.enabled ? "on" : "default"))
														}
														onChange={(e) => {
															const v = e.target.value;
															setDraft({
																...draft,
																parameters:
																	v === "default"
																		? {}
																		: {
																				reasoning:
																					v === "off"
																						? { enabled: false }
																						: v === "on"
																							? { enabled: true }
																							: { enabled: true, effort: v },
																			},
															});
														}}
													>
														<option value="default">模型默认</option>
														{reasoning.toggle && <option value="off">关闭</option>}
														<option value="on">启用</option>
														{reasoning.efforts.map((v) => (
															<option key={v} value={v}>
																{v}
															</option>
														))}
													</select>
												</label>
											) : (
												<p>该模型未声明可配置的推理参数。</p>
											)}
											<p className={styles.hint}>当前接口不支持 Temperature 和最大输出 Token。</p>
										</div>
									)}
								</section>
								<section className={styles.section}>
									<div className={styles.sectionHead}>
										<span className={styles.icon}>♧</span>
										<div className={styles.sectionTitle}>
											<h2>MCP Server</h2>
											<p>选择可用的 MCP Server 及其工具</p>
										</div>
										<span>
											已选 {draft.mcpServers.length} 个（共 {selectedTotal} 个工具）
										</span>
									</div>
									<div className={styles.tableWrap}>
										<table>
											<thead>
												<tr>
													<th>MCP Server</th>
													<th>目录工具数（Revision）</th>
													<th>已选工具数</th>
													<th>状态</th>
													<th />
												</tr>
											</thead>
											<tbody>
												{catalog?.mcpServers?.map((server) => {
													const ref = draft.mcpServers.find((s) => s.mcpServerId === server.id);
													const names = server.tools.map((t) => t.name);
													const { added, removed } = toolDifference(ref?.toolNames ?? [], names);
													const different =
														!!ref && (removed.length > 0 || ref.revision !== server.revision);
													const partial = !!ref && added.length > 0;
													return (
														<tr key={server.id}>
															<td>
																<label>
																	<input
																		type="checkbox"
																		checked={!!ref}
																		onChange={(e) =>
																			updateServer(
																				e.target.checked
																					? {
																							mcpServerId: server.id,
																							revision: server.revision,
																							toolNames: names,
																						}
																					: null,
																				server.id,
																			)
																		}
																	/>{" "}
																	{server.name}
																</label>
															</td>
															<td>
																{names.length}（Rev {server.revision}）
															</td>
															<td>{ref?.toolNames.length ?? 0}</td>
															<td>
																{ref ? (
																	<span className={different ? styles.changed : styles.badge}>
																		{different ? "目录有变化" : partial ? "部分选择" : "已同步"}
																	</span>
																) : (
																	"未选择"
																)}
															</td>
															<td>
																<button
																	className={styles.link}
																	onClick={() =>
																		setExpandedServer(expandedServer === server.id ? null : server.id)
																	}
																>
																	查看工具
																</button>
																{expandedServer === server.id && (
																	<div className={styles.toolList}>
																		{(different || partial) && (
																			<p>
																				目录中 {added.length} 个工具未选择，配置中 {removed.length}{" "}
																				个工具已从目录移除；快照 Rev {ref?.revision}。
																			</p>
																		)}
																		{ref && (
																			<button
																				className={styles.button}
																				onClick={() =>
																					updateServer(
																						{
																							mcpServerId: server.id,
																							revision: server.revision,
																							toolNames: names,
																						},
																						server.id,
																					)
																				}
																			>
																				重新选择全部工具
																			</button>
																		)}
																		{names.map((tool) => (
																			<label key={tool}>
																				<input
																					type="checkbox"
																					disabled={!ref}
																					checked={!!ref?.toolNames.includes(tool)}
																					onChange={(e) =>
																						ref &&
																						updateServer(
																							{
																								...ref,
																								revision: server.revision,
																								toolNames: e.target.checked
																									? [...ref.toolNames, tool]
																									: ref.toolNames.filter((n) => n !== tool),
																							},
																							server.id,
																						)
																					}
																				/>{" "}
																				{tool}
																			</label>
																		))}
																		{removed.map((tool) => (
																			<label key={tool}>
																				<input
																					type="checkbox"
																					checked
																					onChange={() =>
																						ref &&
																						updateServer(
																							{
																								...ref,
																								toolNames: ref.toolNames.filter(
																									(n) => n !== tool,
																								),
																							},
																							server.id,
																						)
																					}
																				/>{" "}
																				{tool}（目录已移除）
																			</label>
																		))}
																	</div>
																)}
															</td>
														</tr>
													);
												})}
											</tbody>
										</table>
									</div>
								</section>
								<details className={styles.section}>
									<summary className={styles.sectionHead}>
										<span className={styles.icon}>⊞</span>
										<span className={styles.sectionTitle}>
											<h2>Skills</h2>
											<p>选择可用的技能（可选）</p>
										</span>
										<span>{draft.skills.length ? `已选 ${draft.skills.length} 项` : "未启用"}　›</span>
									</summary>
									<div className={styles.expanded}>
										{catalog?.skills?.length
											? catalog.skills.map((skill) => (
													<label key={skill.id}>
														<input
															type="checkbox"
															checked={draft.skills.some((s) => s.skillId === skill.id)}
															onChange={(e) =>
																setDraft({
																	...draft,
																	skills: e.target.checked
																		? [
																				...draft.skills,
																				{ skillId: skill.id, revision: skill.revision },
																			]
																		: draft.skills.filter((s) => s.skillId !== skill.id),
																})
															}
														/>{" "}
														{skill.name}
													</label>
												))
											: "暂无可用的 Skills。"}
									</div>
								</details>
								<section className={styles.section}>
									<div className={styles.sectionHead}>
										<span className={styles.icon}>⌁</span>
										<span className={styles.sectionTitle}>
											<h2>敏感参数映射</h2>
											<p>配置 MCP 工具敏感参数的注入规则。这里不记录业务凭据，实际凭据由调用方每次 Run 提交。</p>
										</span>
										<span className={styles.mappingHeadRight}>
											<button
												className={styles.mappingToggle}
												type="button"
												aria-expanded={mappingOpen}
												aria-label={mappingOpen ? "收起敏感参数映射" : "展开敏感参数映射"}
												onClick={() => setMappingOpen(!mappingOpen)}
											>
												{mappingOpen ? "▴" : "▾"}
											</button>
											{mappingConfirmed ? (
												<span className={styles.mappingBadge}>已配置 {bindings.length} 项</span>
											) : (
												<span className={styles.mappingUnset}>未登记</span>
											)}
											{mappingDirty && <span className={styles.mappingPending}>未生效更改</span>}
											<button
												className={styles.primary}
												type="button"
												disabled={!mappingServers.length}
												onClick={() => openMappingForm()}
											>
												＋ 添加映射
											</button>
										</span>
									</div>
									{mappingOpen && (
										<div className={styles.mappingBody}>
											{!mappingConfirmed && (
												<div className={styles.mappingBar}>
													<button className={styles.button} type="button" onClick={() => setMappingConfirmed(true)}>
														确认当前选择的映射规则
													</button>
												</div>
											)}
											{mappingForm && (
												<div className={styles.mappingForm}>
													<strong className={styles.mappingFormTitle}>
														{mappingForm.original ? "编辑映射" : "添加映射"}
													</strong>
													<div className={styles.mappingFormGrid}>
														<label className={styles.mappingField}>
															MCP Server
															<select
																value={mappingForm.mcpServerId}
																disabled={!!mappingForm.original}
																onChange={(e) =>
																	setMappingForm({ ...mappingForm, mcpServerId: e.target.value, parameter: "", toolNames: [] })
																}
															>
																<option value="">请选择</option>
																{mappingServers.map((server) => (
																	<option key={server.id} value={server.id}>{server.name}</option>
																))}
															</select>
														</label>
														<label className={styles.mappingField}>
															来源凭据 ID（注入来源）
															<input
																value={mappingForm.credentialId}
																onChange={(e) => setMappingForm({ ...mappingForm, credentialId: e.target.value })}
																placeholder="tool_credential"
															/>
														</label>
														<label className={styles.mappingField}>
															目标参数（MCP 工具参数）
															<select
																value={mappingForm.parameter}
																onChange={(e) => setMappingForm({ ...mappingForm, parameter: e.target.value })}
															>
																<option value="">请选择</option>
																{[
																	...new Set([
																		...mappingParameters(mappingForm.mcpServerId),
																		...(mappingForm.original ? [mappingForm.parameter] : []),
																	]),
																].map((parameter) => (
																	<option key={parameter} value={parameter}>{parameter}</option>
																))}
															</select>
														</label>
													</div>
													<div className={styles.mappingToolsPicker}>
														<div className={styles.mappingToolsHead}>
															<span>应用工具范围（已选 {mappingForm.toolNames.length} 个）</span>
															<button
																className={styles.button}
																type="button"
																disabled={!mappingForm.parameter}
																onClick={() => {
																	const names = mappingTools(mappingForm.mcpServerId)
																		.filter((tool) => tool.credentialParameters.includes(mappingForm.parameter))
																		.map((tool) => tool.name);
																	setMappingForm({ ...mappingForm, toolNames: names });
																}}
															>
																按参数批量选择
															</button>
														</div>
														<div className={styles.mappingToolGrid}>
															{mappingTools(mappingForm.mcpServerId).map((tool) => (
																<label key={tool.name}>
																	<input
																		type="checkbox"
																		checked={mappingForm.toolNames.includes(tool.name)}
																		onChange={(e) =>
																			setMappingForm({
																				...mappingForm,
																				toolNames: e.target.checked
																					? [...mappingForm.toolNames, tool.name]
																					: mappingForm.toolNames.filter((name) => name !== tool.name),
																			})
																		}
																	/>{" "}
																	{tool.name}
																</label>
															))}
														</div>
													</div>
													{formError && (
														<p role="alert" className={styles.error}>{formError}</p>
													)}
													<div className={styles.mappingFormActions}>
														<button className={styles.primary} type="button" onClick={commitMappingForm}>保存映射</button>
														<button className={styles.button} type="button" onClick={() => setMappingForm(null)}>取消</button>
													</div>
												</div>
											)}
											<div className={styles.tableWrap}>
												<table className={styles.mappingTable}>
													<thead>
														<tr>
															<th>MCP Server</th>
															<th>来源凭据（注入来源）</th>
															<th>目标参数（MCP 工具参数）</th>
															<th>应用范围（工具数）</th>
															<th>操作</th>
														</tr>
													</thead>
													<tbody>
														{mappingServers.map((server) => {
															const rules = mappingRules.filter((rule) => rule.mcpServerId === server.id);
															const open = mappingGroup === server.id;
															return (
																<Fragment key={server.id}>
																	<tr className={styles.mappingGroup}>
																		<td>
																			{rules.length ? (
																				<button
																					type="button"
																					className={styles.mappingGroupName}
																					aria-expanded={open}
																					onClick={() => setMappingGroup(open ? null : server.id)}
																				>
																					<span className={open ? styles.mappingCaretOpen : styles.mappingCaret}>▸</span>
																					{server.name}（{rules.length} 项）
																				</button>
																			) : (
																				<span className={styles.mappingGroupName}>{server.name}</span>
																			)}
																		</td>
																		<td colSpan={4}>
																			{rules.length ? "" : <span className={styles.mappingEmpty}>暂无映射</span>}
																		</td>
																	</tr>
																	{open &&
																		rules.map((rule) => {
																			const ruleKey = `${rule.mcpServerId}\u0000${rule.credentialId}\u0000${rule.parameter}`;
																			const toolsOpen = mappingToolList === ruleKey;
																			return (
																				<Fragment key={ruleKey}>
																					<tr className={styles.mappingRule}>
																						<td />
																						<td><code className={styles.mappingCode}>{rule.credentialId}</code></td>
																						<td><code className={styles.mappingCode}>{rule.parameter}</code></td>
																						<td>
																							<button
																								type="button"
																								className={styles.link}
																								aria-expanded={toolsOpen}
																								onClick={() => setMappingToolList(toolsOpen ? null : ruleKey)}
																							>
																								{rule.toolNames.length} 个工具 {toolsOpen ? "▴" : "▾"}
																							</button>
																						</td>
																						<td>
																							<button
																								type="button"
																								className={styles.link}
																								onClick={() => openMappingForm(rule)}
																							>
																								编辑
																							</button>
																							<button
																								type="button"
																								className={styles.mappingRemove}
																								onClick={() => dropMappingRule(rule)}
																							>
																								移除
																							</button>
																						</td>
																					</tr>
																					{toolsOpen && (
																						<tr>
																							<td colSpan={5}>
																								<div className={styles.mappingTools}>
																									{rule.toolNames.map((tool) => (
																										<span key={tool} className={styles.mappingToolChip}>{tool}</span>
																									))}
																								</div>
																							</td>
																						</tr>
																					)}
																				</Fragment>
																			);
																		})}
																</Fragment>
															);
														})}
													</tbody>
												</table>
											</div>
											{mappingDirty && (
												<button className={styles.button} type="button" onClick={() => setBindings(savedBindings)}>
													撤销映射更改
												</button>
											)}
											<p className={styles.mappingNote}>
												映射仅定义参数注入规则，不保存实际凭据。修改后点击「保存并生效」，将随新版本一起冻结。
											</p>
										</div>
									)}
								</section>
							</div>
						)}
					</main>
					<aside className={styles.sidebar}>
						<section className={styles.sideCard}>
							<h2>配置版本</h2>
							{recentVersions.map((v) => (
								<div className={styles.timeline} key={v.id}>
									<strong>v{v.revision}</strong>{" "}
									{bare(v.id) === bare(platform?.orchestration_version_id ?? "") && (
										<span className={styles.badge}>当前生效</span>
									)}
									<small>{new Date(v.createdAt).toLocaleString("zh-CN")}</small>
								</div>
							))}
							<button className={styles.link} onClick={() => setHistory(true)}>
								查看全部版本 →
							</button>
						</section>
						<section className={styles.sideCard}>
							<h2>关联的 API Key</h2>
							{associated && (
								<>
									<strong className={styles.keyCount}>{associated.length}</strong>
									<p className={styles.hint}>
										平台默认 {associated.filter((k) => k.configurationMode === "platform").length} · 指定配置{" "}
										{associated.filter((k) => k.configurationMode === "configuration").length}
									</p>
								</>
							)}
							<button className={styles.link} onClick={() => navigate("/aaas-keys")}>
								进入 Key 管理 →
							</button>
						</section>
					</aside>
				</div>
			)}
			{detail && (
				<div className={styles.overlay} onMouseDown={() => setDetail(null)}>
					<section
						className={styles.dialog}
						role="dialog"
						aria-modal="true"
						aria-label={`版本 v${detail.revision} 详情`}
						onMouseDown={(e) => e.stopPropagation()}
					>
						<h2>版本 v{detail.revision} 详情</h2>
						<p>
							模型：
							{catalog?.models.find((m) => m.id === detail.snapshot.modelId)?.name ?? detail.snapshot.modelId}
						</p>
						<p>
							MCP Server：{detail.snapshot.mcpServers.length} 个 · 工具：
							{detail.snapshot.mcpServers.reduce((n, s) => n + s.toolNames.length, 0)} 个
						</p>
						<p>Skills：{detail.snapshot.skills.length} 个</p>
						<p className={styles.hint}>已发布版本不可修改。</p>
						<button className={styles.button} onClick={() => setDetail(null)}>
							关闭
						</button>
					</section>
				</div>
			)}
		</section>
	);
}
