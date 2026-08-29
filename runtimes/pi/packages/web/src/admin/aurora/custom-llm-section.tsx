import type { CustomLlmApi, CustomLlmProvider, LlmAvailableModel } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LlmApi } from "../api/llm-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import styles from "./settings-view.module.css";

interface ProviderDraft {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly api: CustomLlmApi;
	readonly models: readonly string[];
	readonly apiKey: string;
}

const EMPTY: ProviderDraft = { id: "", name: "", baseUrl: "", api: "openai-completions", models: [], apiKey: "" };

export function CustomLlmSection(): React.ReactElement {
	const { controller } = useAdminAuth();
	const api = useRef(new LlmApi({ auth: controller })).current;
	const [providers, setProviders] = useState<readonly CustomLlmProvider[]>([]);
	const [availableModels, setAvailableModels] = useState<readonly LlmAvailableModel[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selectedIdRef = useRef<string | null>(null);
	const [draft, setDraft] = useState<ProviderDraft>(EMPTY);
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
	const [openModelMenu, setOpenModelMenu] = useState<number | null>(null);
	const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
	/**
	 * 最近一次「测试连接」的真实结果，按 provider id 记录。
	 *
	 * 列表里的 apiKeyConfigured 只表示「存过 API Key」，与连通性无关 ——
	 * 两者必须分开呈现，否则「已配置」会被误读成「已连通」。
	 */
	const [testResults, setTestResults] = useState<
		Readonly<Record<string, { readonly ok: boolean; readonly text: string }>>
	>({});

	const select = useCallback((provider: CustomLlmProvider): void => {
		selectedIdRef.current = provider.id;
		setSelectedId(provider.id);
		setDraft({
			id: provider.id,
			name: provider.name,
			baseUrl: provider.baseUrl,
			api: provider.api,
			models: provider.models,
			apiKey: "",
		});
		setMessage(null);
	}, []);

	const reload = useCallback(async (): Promise<void> => {
		setLoading(true);
		try {
			const [providerResult, modelResult] = await Promise.all([api.listProviders(), api.listModels()]);
			setProviders(providerResult.items);
			setAvailableModels(modelResult.items);
			const selected =
				providerResult.items.find((provider) => provider.id === selectedIdRef.current) ?? providerResult.items[0];
			if (selected) select(selected);
		} catch (error) {
			setMessage({ tone: "error", text: errorMessage(error) });
		} finally {
			setLoading(false);
		}
	}, [api, select]);

	useEffect(() => {
		void reload();
	}, [reload]);

	const filtered = providers.filter((provider) => provider.name.toLowerCase().includes(query.trim().toLowerCase()));
	const models = useMemo(
		() => availableModels.filter((model) => model.provider === selectedId),
		[availableModels, selectedId],
	);
	const existing = selectedId !== null;

	const set = (patch: Partial<ProviderDraft>): void => setDraft((current) => ({ ...current, ...patch }));

	async function save(): Promise<void> {
		setBusy("save");
		setMessage(null);
		try {
			await api.upsertProvider({
				id: draft.id,
				name: draft.name,
				baseUrl: draft.baseUrl,
				api: draft.api,
				models: draft.models,
				...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
			});
			selectedIdRef.current = draft.id;
			setSelectedId(draft.id);
			setMessage({ tone: "success", text: "配置已保存" });
			await reload();
		} catch (error) {
			setMessage({ tone: "error", text: errorMessage(error) });
		} finally {
			setBusy(null);
		}
	}

	async function test(): Promise<void> {
		setBusy("test");
		setMessage(null);
		try {
			const result = await api.testProvider({
				baseUrl: draft.baseUrl,
				api: draft.api,
				...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
			});
			const text = result.ok ? "连接成功" : (result.error ?? "连接失败");
			setMessage({ tone: result.ok ? "success" : "error", text });
			if (draft.id !== "") {
				setTestResults((current) => ({ ...current, [draft.id]: { ok: result.ok, text } }));
			}
		} catch (error) {
			setMessage({ tone: "error", text: errorMessage(error) });
		} finally {
			setBusy(null);
		}
	}

	async function remove(): Promise<void> {
		if (!selectedId || !window.confirm(`确定删除模型服务 ${draft.name || selectedId}？`)) return;
		setBusy("delete");
		setMessage(null);
		try {
			await api.deleteProvider(selectedId);
			selectedIdRef.current = null;
			setSelectedId(null);
			setDraft(EMPTY);
			await reload();
		} catch (error) {
			setMessage({ tone: "error", text: errorMessage(error) });
		} finally {
			setBusy(null);
		}
	}

	return (
		<section className={styles.modelSettings}>
			<header className={styles.pageHeader}>
				<div>
					<h1>
						设置 <span>/</span> 模型服务
					</h1>
				</div>
				<button
					type="button"
					className={styles.addProvider}
					onClick={() => {
						selectedIdRef.current = null;
						setSelectedId(null);
						setDraft(EMPTY);
						setMessage(null);
					}}
				>
					＋&nbsp; 新增模型服务
				</button>
			</header>
			<div className={styles.settingsBody}>
				<aside className={styles.providerRail}>
					<label className={styles.providerSearch}>
						<Icon name="search" />
						<input
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
							placeholder="搜索服务名称"
						/>
					</label>
					<div className={styles.providerCount}>
						共 {providers.length} 个服务{" "}
						<button type="button" onClick={() => void reload()} aria-label="刷新服务列表">
							<Icon name="refresh" />
						</button>
					</div>
					{loading ? (
						<p className={styles.muted}>加载中…</p>
					) : (
						filtered.map((provider) => {
							const testResult = testResults[provider.id];
							return (
								<button
									type="button"
									key={provider.id}
									className={`${styles.providerItem} ${provider.id === selectedId ? styles.providerSelected : ""}`}
									onClick={() => select(provider)}
								>
									<span className={styles.providerLogo}>{provider.name.slice(0, 1).toUpperCase()}</span>
									<span>
										<strong>{provider.name}</strong>
										<small>{apiLabel(provider.api)}</small>
									</span>
									<span className={styles.stateCol}>
										<i
											className={styles.configState}
											title={
												provider.apiKeyConfigured
													? "已保存 API Key —— 这表示配置过密钥，不代表连通性；点「测试连接」验证"
													: "尚未保存 API Key"
											}
										>
											{provider.apiKeyConfigured ? "● 已配置" : "● 未配置"}
										</i>
										{testResult === undefined ? null : (
											<i
												className={testResult.ok ? styles.testOk : styles.testFail}
												title={testResult.text}
											>
												{testResult.ok ? "✓ 连通" : "✗ 未连通"}
											</i>
										)}
									</span>
								</button>
							);
						})
					)}
				</aside>
				<main className={styles.editor}>
					<div className={styles.editorHead}>
						<div>
							<button
								type="button"
								onClick={() => {
									selectedIdRef.current = null;
									setSelectedId(null);
									setDraft(EMPTY);
								}}
							>
								←
							</button>
							<h2>{existing ? "编辑模型服务" : "新增模型服务"}</h2>
							{existing ? <span className={styles.connectionPill}>● 已配置</span> : null}
						</div>
						<div>
							<button type="button" disabled={!existing || busy !== null} onClick={() => void remove()}>
								删除服务
							</button>
							<button type="button" disabled={busy !== null} onClick={() => void test()}>
								{busy === "test" ? "测试中…" : "测试连接"}
							</button>
							<button type="button" className={styles.save} disabled={busy !== null} onClick={() => void save()}>
								{busy === "save" ? "保存中…" : "保存配置"}
							</button>
						</div>
					</div>
					{message ? (
						<div className={`${styles.notice} ${message.tone === "error" ? styles.noticeError : ""}`}>
							{message.text}
						</div>
					) : null}
					<section className={styles.serviceInfo}>
						<h3>服务信息</h3>
						{existing ? null : (
							<div className={styles.idField}>
								<Field label="服务 ID">
									<input
										value={draft.id}
										onChange={(e) => set({ id: e.currentTarget.value })}
										placeholder="oneapi"
									/>
								</Field>
							</div>
						)}
						<div className={styles.formRow}>
							<Field label="服务名称">
								<input value={draft.name} onChange={(e) => set({ name: e.currentTarget.value })} />
							</Field>
							<Field label="API 协议类型">
								<select value={draft.api} onChange={(e) => set({ api: e.currentTarget.value as CustomLlmApi })}>
									<option value="openai-completions">OpenAI Chat Completions</option>
									<option value="openai-responses">OpenAI Responses</option>
								</select>
							</Field>
							<Field label="API Base URL">
								<input value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.currentTarget.value })} />
							</Field>
						</div>
						<Field label="API Key" wide>
							<div className={styles.keyRow}>
								<input
									type="password"
									value={draft.apiKey}
									onChange={(e) => set({ apiKey: e.currentTarget.value })}
									placeholder={existing ? "已配置，留空保持不变" : "输入 API Key"}
								/>
								<button type="button" onClick={() => set({ apiKey: "" })}>
									重新填写
								</button>
							</div>
							<small>出于安全考虑，API Key 不会被显示，留空则保持原值不变。</small>
						</Field>
					</section>
					<section className={styles.modelsSection}>
						<div className={styles.modelsHead}>
							<h3>
								服务提供的模型 <span>（{draft.models.length}）</span>
							</h3>
							<div>
								<button type="button" onClick={() => void reload()}>
									<Icon name="refresh" />
									刷新模型列表
								</button>
								<button type="button" onClick={() => set({ models: [...draft.models, ""] })}>
									＋ 添加模型
								</button>
							</div>
						</div>
						<div className={styles.modelTable}>
							<div className={styles.modelHeader}>
								<span>模型 ID</span>
								<span>显示名称</span>
								<span title="模型是否声明支持 reasoning">支持思考</span>
								<span title="控制台选「低」时，下发给模型的 reasoning effort 值">低 low</span>
								<span title="控制台选「中」时，下发给模型的 reasoning effort 值">中 medium</span>
								<span title="控制台选「高」时，下发给模型的 reasoning effort 值">高 high</span>
								<span>操作</span>
							</div>
							{draft.models.map((modelId, index) => {
								const model = models.find((item) => item.id === modelId);
								return (
									<div className={styles.modelRow} key={`${index}-${modelId}`}>
										<input
											value={modelId}
											onChange={(e) =>
												set({
													models: draft.models.map((id, i) => (i === index ? e.currentTarget.value : id)),
												})
											}
										/>
										<input value={model?.name ?? modelId} disabled />
										<label
											className={styles.switch}
											title={
												model === undefined
													? "模型尚未出现在运行目录中"
													: `efforts: ${(model.parameterCapabilities?.reasoning?.efforts ?? []).join(", ") || "无"}`
											}
										>
											<input type="checkbox" checked={model?.reasoning ?? false} disabled />
											<span />
										</label>
										{(["low", "medium", "high"] as const).map((effort) => {
											const value = effortValue(model, effort);
											return (
												<span
													key={effort}
													className={`${styles.effortCell} ${value.state === "on" ? styles.effortOn : styles.effortOff}`}
													title={
														value.state === "unknown"
															? "模型尚未出现在运行目录中"
															: value.state === "off"
																? "该模型未声明支持此档位"
																: `下发 reasoning effort = ${value.text}`
													}
												>
													{value.text}
												</span>
											);
										})}
										<div className={styles.modelAction}>
											<button
												type="button"
												aria-label={`打开模型 ${modelId} 的操作菜单`}
												aria-expanded={openModelMenu === index}
												onClick={() => setOpenModelMenu((current) => (current === index ? null : index))}
											>
												⋯
											</button>
											{openModelMenu === index ? (
												<div className={styles.modelActionMenu}>
													<button
														type="button"
														onClick={() => {
															set({ models: draft.models.filter((_, i) => i !== index) });
															setOpenModelMenu(null);
														}}
													>
														删除模型
													</button>
												</div>
											) : null}
										</div>
									</div>
								);
							})}
						</div>
						<p className={styles.mappingNote}>
							<strong>说明：</strong>平台提供 low / medium / high
							三个统一档位，实际请求时根据当前模型的映射转换为 Provider
							参数值。模型能力映射编辑将在后端接口支持后开放。
						</p>
					</section>
				</main>
			</div>
		</section>
	);
}

function Field({
	label,
	wide = false,
	children,
}: {
	label: string;
	wide?: boolean;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<div className={`${styles.field} ${wide ? styles.fieldWide : ""}`}>
			<span>{label}</span>
			{children}
		</div>
	);
}
function apiLabel(api: CustomLlmApi): string {
	return api === "openai-completions" ? "OpenAI 兼容" : "Responses API";
}
/**
 * 控制台档位（低/中/高）最终下发给模型的 reasoning effort 值。
 *
 * 三种「没有值」必须区分开，不能一律回落成档位名 —— 回落会让「模型根本
 * 不支持思考」显示成「支持 low」，把配置缺失伪装成正常。
 */
function effortValue(
	model: LlmAvailableModel | undefined,
	effort: "low" | "medium" | "high",
): { readonly text: string; readonly state: "on" | "off" | "unknown" } {
	if (model === undefined) return { text: "—", state: "unknown" };
	const reasoning = model.parameterCapabilities?.reasoning;
	if (reasoning?.supported !== true) return { text: "—", state: "off" };
	if (!reasoning.efforts.includes(effort)) return { text: "不支持", state: "off" };
	const mapped = model.thinkingLevelMap?.[effort];
	if (mapped === null) return { text: "不支持", state: "off" };
	// 未显式映射时按同名下发，这是真实行为，不是缺失
	return mapped === undefined
		? { text: effort, state: "on" }
		: { text: mapped, state: "on" };
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function Icon({ name }: { name: "search" | "refresh" }): React.ReactElement {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			{name === "search" ? (
				<>
					<circle cx="11" cy="11" r="7" />
					<path d="m20 20-4-4" />
				</>
			) : (
				<>
					<path d="M20 11a8 8 0 1 0-2.34 5.66" />
					<path d="M20 5v6h-6" />
				</>
			)}
		</svg>
	);
}
