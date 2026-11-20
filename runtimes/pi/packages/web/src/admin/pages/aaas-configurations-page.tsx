import type { McpServerDetail, OrchestrationCatalog } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type AaasConfig,
	type AaasConfigVersion,
	type AaasBinding,
	AaasKeysApi,
} from "../api/aaas-keys-api.ts";
import { OrchestrationApi } from "../api/orchestration-api.ts";
import { McpApi } from "../api/mcp-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { useDialogs } from "../components/use-dialogs.tsx";
import { AaasConfigEditor, AaasConfigVersions } from "./aaas-configuration-editor.tsx";
import styles from "./aaas-configurations-page.module.css";
import { navigate } from "../router.ts";

interface ConfigDraft {
	systemPrompt: string;
	modelId: string;
	parameters: {
		reasoning?: { enabled?: boolean; effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" };
	};
	mcpServers: { mcpServerId: string; revision: number; toolNames: string[] }[];
	skills: { skillId: string; revision: number }[];
	contextPolicy?: { maxTurns?: number; maxContextTokens?: number; toolResultMaxBytes?: number };
	runtimePolicy?: {
		profile?: "chat-only";
		turnTimeoutMs?: number;
		idleTtlMs?: number;
		maxConcurrentTurnsPerConversation?: 1;
	};
}

interface ConfigDetail {
	id: string;
	name: string;
	draft: ConfigDraft;
	draftRevision: number;
	versions: { id: string; revision: number; createdAt: string }[];
}

interface ConfigSnapshot {
	id: string;
	configurationId: string;
	revision: number;
	snapshot: ConfigDraft;
}

type DraftStatus = "published" | "unpublished";

interface ConfigRow {
	id: string;
	name: string;
	draftRevision: number;
	status: DraftStatus;
	latestVersion: number | null;
	latestVersionId: string | null;
	modelId: string;
	modelName: string;
	mcpCount: number;
	skillCount: number;
	updatedAt: string | null;
}

interface DefaultInfo {
	configId: string;
	versionId: string;
	name: string;
	revision: number;
	modelName: string;
	mcpCount: number | null;
	skillCount: number | null;
	bindings: number;
}

type View = "list" | "editor" | "versions";

const statusText: Record<DraftStatus, string> = {
	published: "已发布",
	unpublished: "未发布",
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "请求失败");
const bareVersionId = (id: string): string => id.replace(/^orv_/, "");

interface MappingServer { id: string; name: string; tools: { name: string; parameters: string[] }[] }

export function mappingServers(snapshot: ConfigDraft, details: readonly McpServerDetail[]): MappingServer[] {
	return snapshot.mcpServers.map((ref) => {
		const detail = details.find((item) => item.id === ref.mcpServerId);
		const revision = detail?.revisions.find((item) => item.revision === ref.revision);
		if (!detail || !revision) throw new Error("版本引用的 MCP 修订不可用，无法安全选择参数");
		return { id: ref.mcpServerId, name: detail.name, tools: ref.toolNames.map((name) => {
			const tool = revision.tools.find((item) => item.name === name);
			if (!tool) throw new Error("版本引用的 MCP 工具不可用，无法安全选择参数");
			const properties = tool.inputSchema.properties;
			const parameters = properties && typeof properties === "object" && !Array.isArray(properties)
				? Object.entries(properties).filter(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && value !== null && typeof value === "object" && (value as {type?: unknown}).type === "string").map(([name]) => name)
				: [];
			return { name, parameters };
		}) };
	});
}

export function validateMappingRows(rows: readonly AaasBinding[], servers: readonly MappingServer[]): string | null {
	const seen = new Set<string>();
	for (const row of rows) {
		const tool = servers.find((server) => server.id === row.mcpServerId)?.tools.find((item) => item.name === row.toolName);
		if (!tool?.parameters.includes(row.parameter)) return "请选择该版本中的 Server、工具和字符串参数。";
		if (row.credentialId.length > 100 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.credentialId)) return "凭据标识须为 1 至 100 位字母、数字或下划线，且不能以数字开头。";
		const key = JSON.stringify([row.mcpServerId, row.toolName, row.parameter]);
		if (seen.has(key)) return "同一工具参数不能重复设置。";
		seen.add(key);
	}
	return null;
}

function formatTime(value: string | null): string {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "—";
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

function resolveModelName(catalog: OrchestrationCatalog | null, modelId: string): string {
	if (!modelId) return "未指定";
	return catalog?.models.find((model) => model.id === modelId)?.name ?? modelId;
}

export async function loadConfigRows(
	api: OrchestrationApi,
	catalog: OrchestrationCatalog | null,
): Promise<ConfigRow[]> {
	const items = await api.request<{ id: string; name: string; draftRevision: number }[]>("configurations");
	return Promise.all(
		items.map(async (item) => {
			const detail = await api.request<ConfigDetail>(`configurations/${item.id}`);
			const latest = detail.versions[0] ?? null;
			let modelId = detail.draft.modelId;
			let mcpCount = detail.draft.mcpServers.length;
			let skillCount = detail.draft.skills.length;
			let updatedAt: string | null = null;
			if (latest) {
				try {
					const snapshot = await api.request<ConfigSnapshot>(
						`configurations/${item.id}/versions/${latest.id}`,
					);
					modelId = snapshot.snapshot.modelId;
					mcpCount = snapshot.snapshot.mcpServers.length;
					skillCount = snapshot.snapshot.skills.length;
				} catch {
					modelId = detail.draft.modelId;
					mcpCount = detail.draft.mcpServers.length;
					skillCount = detail.draft.skills.length;
				}
				updatedAt = latest.createdAt;
			}
			const status: DraftStatus = detail.versions.length === 0 ? "unpublished" : "published";
			return {
				id: item.id,
				name: item.name,
				draftRevision: item.draftRevision,
				status,
				latestVersion: latest?.revision ?? null,
				latestVersionId: latest?.id ?? null,
				modelId,
				modelName: resolveModelName(catalog, modelId),
				mcpCount,
				skillCount,
				updatedAt,
			};
		}),
	);
}

export async function loadDefaultInfo(
	keysApi: AaasKeysApi,
	orchestrationApi: OrchestrationApi,
	catalog: OrchestrationCatalog | null,
): Promise<{ config: AaasConfig | null; info: DefaultInfo | null; versions: AaasConfigVersion[] }> {
	const [config, versions] = await Promise.all([
		keysApi.request<AaasConfig | null>("/platform-configuration"),
		keysApi.request<AaasConfigVersion[]>("/platform-configuration/versions"),
	]);
	if (!config) return { config: null, info: null, versions };
	const version = versions.find(
		(item) =>
			item.configuration_id === config.configuration_id &&
			bareVersionId(item.orchestration_version_id) === bareVersionId(config.orchestration_version_id),
	);
	let mcpCount: number | null = null;
	let skillCount: number | null = null;
	try {
		const snapshot = await orchestrationApi.request<ConfigSnapshot>(
			`configurations/${config.configuration_id}/versions/${bareVersionId(config.orchestration_version_id)}`,
		);
		mcpCount = snapshot.snapshot.mcpServers.length;
		skillCount = snapshot.snapshot.skills.length;
	} catch {
		// Counts are optional display data; never invent a value when the frozen version cannot be read.
	}
	const info: DefaultInfo = {
		configId: config.configuration_id,
		versionId: bareVersionId(config.orchestration_version_id),
		name: version?.name ?? "版本信息暂不可用",
		revision: version?.revision ?? 0,
		modelName: resolveModelName(catalog, version?.model_id ?? ""),
		mcpCount,
		skillCount,
		bindings: config.credential_bindings.length,
	};
	return { config, info, versions };
}

export function DefaultCard({
	info,
	onSwitch,
	onDetails,
}: {
	info: DefaultInfo | null;
	onSwitch: () => void;
	onDetails: () => void;
}): React.JSX.Element {
	if (!info) {
		return (
			<section className={`${styles.card} ${styles.defaultEmpty}`} aria-label="当前平台默认配置">
				<div className={styles.emptyIcon} aria-hidden="true">
					<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5">
						<path d="M12 3 4 7.5 12 12l8-4.5L12 3Z" />
						<path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" />
					</svg>
				</div>
				<div>
					<h2>尚未配置平台执行环境</h2>
					<p>先创建配置并发布版本，再将某个已发布版本设为平台默认。未绑定时不会伪造默认配置。</p>
				</div>
			</section>
		);
	}
	return (
		<section className={`${styles.card} ${styles.hero}`} aria-label="当前平台默认配置">
			<div className={styles.heroBody}>
				<span className={styles.heroEyebrow}>当前平台默认配置</span>
				<div className={styles.heroTitleRow}>
					<h2>{info.name}</h2>
					<span className={`${styles.badge} ${styles.badgeGreen}`}>已生效</span>
				</div>
				<p className={styles.heroMeta}>
					v{info.revision} · 模型 {info.modelName}
					{info.mcpCount !== null ? ` · ${info.mcpCount} 个 MCP Server` : ""}
					{info.skillCount !== null ? ` · ${info.skillCount} 个 Skills` : ""}
				</p>
			</div>
			<div className={styles.heroActions}>
				<button type="button" className={styles.heroButton} onClick={onSwitch}>
					切换默认版本
				</button>
				<button type="button" className={styles.heroButton} onClick={onDetails}>
					查看详情
				</button>
			</div>
		</section>
	);
}

export function SwitchDefaultModal({
	versions,
	defaultInfo,
	initialVersionId,
	catalog,
	onCancel,
	onConfirm,
	busy,
}: {
	versions: readonly AaasConfigVersion[];
	defaultInfo: DefaultInfo | null;
	initialVersionId: string;
	catalog: OrchestrationCatalog | null;
	onCancel: () => void;
	onConfirm: (version: AaasConfigVersion) => void;
	busy: boolean;
}): React.JSX.Element {
	const [selectedId, setSelectedId] = useState(initialVersionId);
	const selected = versions.find((item) => bareVersionId(item.orchestration_version_id) === selectedId);
	const currentDefault = defaultInfo ? `${defaultInfo.name} · v${defaultInfo.revision}` : "尚未绑定默认版本";
	return (
		<div className={styles.overlay} role="presentation" onMouseDown={onCancel}>
			<section
				className={styles.modal}
				role="dialog"
				aria-modal="true"
				aria-labelledby="switch-default-title"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<div className={styles.modalHead}>
					<h2 id="switch-default-title">切换默认版本</h2>
					<button type="button" className={styles.iconButton} aria-label="关闭" onClick={onCancel}>
						×
					</button>
				</div>
				<p className={styles.modalDesc}>选择配置的一个已发布版本作为 AaaS 平台默认执行配置。</p>
				<label className={styles.field}>
					<span>选择配置 *</span>
					<select value={selectedId} onChange={(event) => setSelectedId(event.currentTarget.value)}>
						<option value="">请选择已发布版本</option>
						{versions.map((version) => (
							<option
								key={version.orchestration_version_id}
								value={bareVersionId(version.orchestration_version_id)}
							>
								{version.name} · v{version.revision} · {resolveModelName(catalog, version.model_id ?? "")}
							</option>
						))}
					</select>
				</label>
				<dl className={styles.summaryList}>
					<div>
						<dt>即将启用</dt>
						<dd>{selected ? `${selected.name} · v${selected.revision}` : "请选择版本"}</dd>
					</div>
					<div>
						<dt>当前默认版本</dt>
						<dd>{currentDefault}</dd>
					</div>
				</dl>
				<p className={styles.notice}>
					切换后，新受理的 Run 将使用此版本；已受理的 Run 保留其冻结的配置快照，不受影响。
				</p>
				<div className={styles.modalActions}>
					<button type="button" onClick={onCancel} disabled={busy}>
						取消
					</button>
					<button
						type="button"
						className={styles.primary}
						disabled={busy || !selected}
						onClick={() => selected && onConfirm(selected)}
					>
						确认切换
					</button>
				</div>
			</section>
		</div>
	);
}

export function AdminAaasConfigurationsPage(): React.JSX.Element {
	const { controller } = useAdminAuth();
	const dialogs = useDialogs();
	const keysApi = useMemo(() => new AaasKeysApi(controller), [controller]);
	const orchestrationApi = useMemo(() => new OrchestrationApi(controller), [controller]);
	const mcpApi = useMemo(() => new McpApi({ auth: controller }), [controller]);
	const [catalog, setCatalog] = useState<OrchestrationCatalog | null>(null);
	const [rows, setRows] = useState<ConfigRow[]>([]);
	const [platformConfig, setPlatformConfig] = useState<AaasConfig | null>(null);
	const [defaultInfo, setDefaultInfo] = useState<DefaultInfo | null>(null);
	const [publishedVersions, setPublishedVersions] = useState<AaasConfigVersion[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const [view, setView] = useState<View>("list");
	const [editorConfigId, setEditorConfigId] = useState<string | null>(null);
	const [versionsConfigId, setVersionsConfigId] = useState<string | null>(null);
	const [switchTarget, setSwitchTarget] = useState<string | null>(null);
	const [mappingVersion, setMappingVersion] = useState("");
	const [mappingRows, setMappingRows] = useState<AaasBinding[]>([]);
	const [mappingOptions, setMappingOptions] = useState<MappingServer[]>([]);
	const [mappingRegistered, setMappingRegistered] = useState(false);
	const [mappingReady, setMappingReady] = useState(false);
	const [mappingSaving, setMappingSaving] = useState(false);
	const [batchServer, setBatchServer] = useState("");
	const [batchParameter, setBatchParameter] = useState("");
	const [mappingError, setMappingError] = useState("");

	useEffect(() => {
		let active = true;
		setMappingReady(false);
		setMappingError("");
		const version = publishedVersions.find((item) => bareVersionId(item.orchestration_version_id) === mappingVersion);
		if (mappingVersion && version) void Promise.all([
			keysApi.request<{ credential_bindings: AaasBinding[] | null }>(`/versions/${mappingVersion}/credential-bindings`),
			orchestrationApi.request<ConfigSnapshot>(`configurations/${version.configuration_id}/versions/${mappingVersion}`).then(async (snapshot) => {
				const details = await Promise.all(snapshot.snapshot.mcpServers.map((server) => mcpApi.get(server.mcpServerId)));
				return mappingServers(snapshot.snapshot, details);
			}),
		]).then(([result, options]) => {
			if (!active) return;
			setMappingRegistered(result.credential_bindings !== null);
			setMappingRows(result.credential_bindings ?? []);
			setMappingOptions(options);
			setMappingReady(true);
		}).catch((err: unknown) => { if (active) setMappingError(errorMessage(err)); });
		return () => { active = false; };
	}, [keysApi, mappingVersion, mcpApi, orchestrationApi, publishedVersions]);

	const refresh = useCallback(async () => {
		const [nextRows, nextDefault] = await Promise.all([
			loadConfigRows(orchestrationApi, catalog),
			loadDefaultInfo(keysApi, orchestrationApi, catalog),
		]);
		setRows(nextRows);
		setPlatformConfig(nextDefault.config);
		setDefaultInfo(nextDefault.info);
		setPublishedVersions(nextDefault.versions);
		setLoaded(true);
	}, [catalog, keysApi, orchestrationApi]);

	useEffect(() => {
		let active = true;
		Promise.allSettled([
			orchestrationApi.request<OrchestrationCatalog>("catalog"),
			refresh(),
		]).then(([catalogResult, refreshResult]) => {
			if (!active) return;
			if (catalogResult.status === "fulfilled") setCatalog(catalogResult.value);
			if (refreshResult.status === "rejected") setError(errorMessage(refreshResult.reason));
		});
		return () => {
			active = false;
		};
	}, [orchestrationApi]);

	const refreshData = useCallback(async () => {
		setError("");
		await refresh();
	}, [refresh]);

	async function confirmSwitch(version: AaasConfigVersion) {
		setBusy(true);
		setError("");
		try {
			const mapping = await keysApi.request<{credential_bindings: unknown[] | null}>(`/versions/${bareVersionId(version.orchestration_version_id)}/credential-bindings`);
			if (mapping.credential_bindings === null) throw new Error("请先登记该版本的敏感参数映射。");
			await keysApi.request("/platform-configuration", "PUT", {
				configuration_id: version.configuration_id,
				orchestration_version_id: bareVersionId(version.orchestration_version_id),
				credential_bindings: mapping.credential_bindings,
			});
			setSwitchTarget(null);
			setNotice(`已将 ${version.name} · v${version.revision} 设为平台默认。`);
			await refreshData();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	function openSwitch(versionId?: string | null) {
		setError("");
		setNotice("");
		setSwitchTarget(versionId ?? defaultInfo?.versionId ?? "");
	}

	function openEditor(configId: string | null) {
		setError("");
		setNotice("");
		setEditorConfigId(configId);
		setView("editor");
	}

	function openVersions(configId: string) {
		setError("");
		setNotice("");
		setVersionsConfigId(configId);
		setView("versions");
	}

	function goList(message?: string) {
		setView("list");
		setNotice(message ?? "");
		void refreshData();
	}

	const defaultRow = rows.find((row) => row.id === defaultInfo?.configId);

	return (
		<section className={styles.page} data-view={view}>
			{view === "list" && (
				<>
					<header className={styles.head}>
						<div>
							<span className={styles.eyebrow}>ORCHESTRATION</span>
							<h1>AaaS 执行配置</h1>
							<p>管理 AaaS 动态任务的执行配置（模型、工具、Skills 与执行策略），发布版本并设置为平台默认版本。</p>
						</div>
						<button type="button" className={styles.primary} onClick={() => openEditor(null)}>
							＋ 新建配置
						</button>
					</header>
					{error && (
						<p className={styles.error} role="alert">
							{error}
						</p>
					)}
					{notice && <output className={styles.success}>{notice}</output>}
					<DefaultCard
						info={defaultInfo}
						onSwitch={() => openSwitch()}
						onDetails={() => defaultInfo && openVersions(defaultInfo.configId)}
					/>
					<section className={`${styles.card} ${styles.mappingCard}`} aria-label="版本敏感参数映射">
						<div className={styles.mappingHeader}>
							<div><h2>版本敏感参数映射</h2><p>登记工具敏感参数注入规则；实际业务凭据由调用方在每次 Run 时提交。</p></div>
							<span className={styles.mappingBadge}>版本级配置</span>
						</div>
						<label className={styles.field}><span>已发布版本</span><select value={mappingVersion} disabled={mappingSaving} onChange={(e) => { setMappingReady(false); setMappingVersion(e.currentTarget.value); }}><option value="">请选择版本</option>{publishedVersions.map((v) => <option key={v.orchestration_version_id} value={bareVersionId(v.orchestration_version_id)}>{v.name} · v{v.revision}</option>)}</select></label>
						{mappingVersion && !mappingReady && <p className={mappingError ? styles.error : styles.mappingLoading} role={mappingError ? "alert" : undefined}>{mappingError ? `读取版本映射失败：${mappingError}` : "正在读取版本映射…"}</p>}
						{mappingVersion && mappingReady && <div className={styles.mappingEditor}>
							<p className={styles.mappingStatus}>{mappingRegistered ? "已登记 · 不可修改" : "尚未登记 · 选择需要注入凭据的工具参数"}</p>
							{mappingRows.length === 0 && <p className={styles.hint}>{mappingRegistered ? "此版本未配置工具参数凭据。" : "未添加映射。确认登记将表示此版本无需工具参数凭据。"}</p>}
							{mappingRows.length > 0 && <details open={mappingRows.length <= 3 || undefined} className={styles.mappingList}><summary>已选择 {mappingRows.length} 条映射（展开查看和调整）</summary>{mappingRows.map((row, index) => {
								const server = mappingOptions.find((item) => item.id === row.mcpServerId);
								const tool = server?.tools.find((item) => item.name === row.toolName);
								const update = (changes: Partial<AaasBinding>) => setMappingRows((current) => current.map((item, i) => i === index ? { ...item, ...changes } : item));
								return <div className={styles.mappingRow} key={index}>
									<div className={styles.mappingRowHead}><strong>映射 {index + 1}</strong>{!mappingRegistered && <button type="button" disabled={mappingSaving} onClick={() => setMappingRows((current) => current.filter((_, i) => i !== index))}>移除</button>}</div>
									<div className={styles.mappingFields}>
										<label className={styles.field}><span>MCP Server</span><select disabled={mappingRegistered || mappingSaving} value={row.mcpServerId} onChange={(e) => update({ mcpServerId: e.currentTarget.value, toolName: "", parameter: "", credentialId: "" })}><option value="">请选择 Server</option>{mappingOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
										<label className={styles.field}><span>工具</span><select disabled={mappingRegistered || mappingSaving || !server} value={row.toolName} onChange={(e) => update({ toolName: e.currentTarget.value, parameter: "", credentialId: "" })}><option value="">请选择工具</option>{server?.tools.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
										<label className={styles.field}><span>敏感参数</span><select disabled={mappingRegistered || mappingSaving || !tool} value={row.parameter} onChange={(e) => update({ parameter: e.currentTarget.value, credentialId: "tool_credential" })}><option value="">请选择参数</option>{tool?.parameters.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
									</div>
								</div>;
							})}</details>}
							{!mappingRegistered && <><div className={styles.mappingRow}><strong>批量添加相同参数</strong><p className={styles.hint}>选择 Server 和参数名，再确认需要注入凭据的工具。</p><div className={styles.mappingFields}><label className={styles.field}><span>MCP Server</span><select value={batchServer} onChange={(e) => { setBatchServer(e.currentTarget.value); setBatchParameter(""); }}><option value="">请选择 Server</option>{mappingOptions.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select></label><label className={styles.field}><span>参数名</span><select value={batchParameter} onChange={(e) => setBatchParameter(e.currentTarget.value)}><option value="">请选择参数</option>{[...new Set(mappingOptions.find((server) => server.id === batchServer)?.tools.flatMap((tool) => tool.parameters) ?? [])].map((parameter) => <option key={parameter} value={parameter}>{parameter}</option>)}</select></label></div>{batchParameter && <button type="button" disabled={mappingSaving} onClick={() => setMappingRows((rows) => { const tools = mappingOptions.find((server) => server.id === batchServer)?.tools.filter((tool) => tool.parameters.includes(batchParameter)) ?? []; return [...rows, ...tools.filter((tool) => !rows.some((row) => row.mcpServerId === batchServer && row.toolName === tool.name && row.parameter === batchParameter)).map((tool) => ({ mcpServerId: batchServer, toolName: tool.name, parameter: batchParameter, credentialId: "tool_credential" }))]; })}>全选匹配工具</button>}{batchParameter && mappingOptions.find((server) => server.id === batchServer)?.tools.filter((tool) => tool.parameters.includes(batchParameter)).map((tool) => { const checked = mappingRows.some((row) => row.mcpServerId === batchServer && row.toolName === tool.name && row.parameter === batchParameter); return <label className={styles.check} key={tool.name}><input type="checkbox" checked={checked} onChange={(e) => { const next = e.currentTarget.checked; setMappingRows((rows) => next ? [...rows, { mcpServerId: batchServer, toolName: tool.name, parameter: batchParameter, credentialId: "tool_credential" }] : rows.filter((row) => !(row.mcpServerId === batchServer && row.toolName === tool.name && row.parameter === batchParameter))); }} />{tool.name}</label>; })}</div><button type="button" disabled={mappingSaving || !mappingOptions.length} onClick={() => setMappingRows((current) => [...current, {mcpServerId: "", toolName: "", parameter: "", credentialId: ""}])}>＋ 添加映射</button><div className={styles.mappingActions}><button className={styles.primary} type="button" disabled={mappingSaving || !!validateMappingRows(mappingRows, mappingOptions)} onClick={() => void (async () => { if (!await dialogs.confirm(mappingRows.length ? `将登记 ${mappingRows.length} 条工具参数映射。登记后无法修改，调整需发布新版本。` : "确认此版本无需工具参数凭据？登记后无法修改，调整需发布新版本。", { title: "确认登记版本映射", confirmLabel: "确认登记" })) return; setMappingSaving(true); try { await keysApi.request(`/versions/${mappingVersion}/credential-bindings`, "PUT", { credential_bindings: mappingRows }); setMappingRegistered(true); setNotice("版本映射已登记。"); } catch (err) { setError(errorMessage(err)); } finally { setMappingSaving(false); } })()}>{mappingSaving ? "正在登记…" : "确认登记"}</button></div>{validateMappingRows(mappingRows, mappingOptions) && <p className={styles.hint}>{validateMappingRows(mappingRows, mappingOptions)}</p>}</>}
						</div>}
						<p className={styles.mappingNote}>登记后不可修改，变更规则请发布新版本。请勿在此填写实际业务凭据。</p>
					</section>

					<section className={`${styles.card} ${styles.tableCard}`} aria-label="配置列表">
						<div className={styles.cardHead}>
							<div>
								<h2>配置列表</h2>
								<p>配置修改后直接发布新版本；发布生成不可变版本，设为默认需单独确认。</p>
							</div>
							<span className={styles.count}>共 {loaded ? rows.length : "—"} 条</span>
						</div>
						<div className={styles.tableWrap}>
							<table>
								<thead>
									<tr>
										<th>配置名称</th>
										<th>状态</th>
										<th>最新版本</th>
										<th>模型</th>
										<th>MCP Server</th>
										<th>Skills</th>
										<th>更新时间</th>
										<th>操作</th>
									</tr>
								</thead>
								<tbody>
									{rows.map((row) => {
										const isDefault = row.id === defaultInfo?.configId;
										return (
											<tr key={row.id} className={isDefault ? styles.defaultRow : undefined}>
												<td>
													<div className={styles.nameCell}>
														{isDefault && <span className={styles.star} aria-label="当前默认">★</span>}
														<strong>{row.name}</strong>
														{isDefault && (
															<span className={`${styles.badge} ${styles.badgeBlue}`}>默认</span>
														)}
													</div>
												</td>
												<td>
													<span
														className={`${styles.badge} ${
															row.status === "published" ? styles.badgeGreen : styles.badgeNeutral
														}`}
													>
														{statusText[row.status]}
													</span>
												</td>
												<td className={styles.mono}>{row.latestVersion ? `v${row.latestVersion}` : "—"}</td>
												<td>{row.modelName}</td>
												<td className={styles.mono}>{row.mcpCount} 个</td>
												<td className={styles.mono}>{row.skillCount} 个</td>
												<td className={styles.muted}>{formatTime(row.updatedAt)}</td>
												<td>
													<div className={styles.rowActions}>
														<button type="button" onClick={() => openEditor(row.id)}>
															编辑
														</button>
														<button type="button" onClick={() => openVersions(row.id)}>
															版本
														</button>
														{row.latestVersionId && !isDefault && (
															<button
																type="button"
																className={styles.linkButton}
																onClick={() => openSwitch(row.latestVersionId)}
															>
																设为默认
															</button>
														)}
													</div>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
						{loaded && rows.length === 0 && (
							<div className={styles.listEmpty}>
								<p>暂无执行配置。创建配置并发布版本后，可将其设为平台默认。</p>
								<button type="button" className={styles.primary} onClick={() => openEditor(null)}>
									＋ 新建配置
								</button>
							</div>
						)}
					</section>
				</>
			)}

			{view === "editor" && (
				<AaasConfigEditor
					api={orchestrationApi}
					catalog={catalog}
					configId={editorConfigId}
					defaultVersionId={defaultRow?.latestVersionId ?? null}
					onBack={() => goList()}
					onPublished={() => goList("版本已发布，请手动设为平台默认。")}
					onOpenVersions={(id) => openVersions(id)}
				/>
			)}

			{view === "versions" && versionsConfigId && (
				<AaasConfigVersions
					api={orchestrationApi}
					catalog={catalog}
					configId={versionsConfigId}
					defaultVersionId={defaultInfo?.versionId ?? null}
					onBack={() => goList()}
					onSwitch={(versionId) => openSwitch(versionId)}
				/>
			)}

			{switchTarget !== null && (
				<SwitchDefaultModal
					versions={publishedVersions}
					defaultInfo={defaultInfo}
					initialVersionId={switchTarget}
					catalog={catalog}
					busy={busy}
					onCancel={() => setSwitchTarget(null)}
					onConfirm={(version) => void confirmSwitch(version)}
				/>
			)}
			{dialogs.dialog}
		</section>
	);
}
