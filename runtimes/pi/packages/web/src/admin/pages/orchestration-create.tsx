import type { OrchestrationCatalog, ToolCredentialBinding } from "@earendil-works/pi-protocol";
import { useId, useState } from "react";
import type { OrchestrationApi } from "../api/orchestration-api.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { useDialogs } from "../components/use-dialogs.tsx";
import { OrchestrationBulkBindings } from "./orchestration-bulk-bindings.tsx";
import { OrchestrationDrawer } from "./orchestration-drawer.tsx";
import styles from "./orchestration-page.module.css";
import { errorMessage } from "./orchestration-ui.ts";

interface BindingDraft {
	id: string;
	toolKey: string;
	parameter: string;
	credential: string;
}
type CatalogApplication = OrchestrationCatalog["applications"][number];
function toolKey(tool: Pick<CatalogApplication["tools"][number], "mcpServerId" | "name">): string {
	return JSON.stringify([tool.mcpServerId, tool.name]);
}

export function OrchestrationCreate({
	api,
	catalog,
	catalogError,
	loading,
	onReload,
	onClose,
	onCreated,
}: {
	api: OrchestrationApi;
	catalog: OrchestrationCatalog | null;
	catalogError: string | null;
	loading: boolean;
	onReload: () => void;
	onClose: () => void;
	onCreated: (name: string, token: string) => void;
}): React.JSX.Element {
	const formId = useId(),
		dialogs = useDialogs();
	const [step, setStep] = useState(0),
		[name, setName] = useState(""),
		[modelId, setModelId] = useState("");
	const [systemPrompt, setSystemPrompt] = useState("");
	const [serverIds, setServerIds] = useState<string[]>([]);
	const [skillIds, setSkillIds] = useState<string[]>([]);
	const [allowed, setAllowed] = useState<string[]>([]),
		[useCredentials, setUseCredentials] = useState(false);
	const [bindings, setBindings] = useState<BindingDraft[]>([]),
		[editingBindings, setEditingBindings] = useState(false),
		[error, setError] = useState<string | null>(null),
		[busy, setBusy] = useState(false);
	const app = {
		modelId,
		tools: (catalog?.mcpServers ?? []).filter((s) => serverIds.includes(s.id)).flatMap((s) => s.tools),
	};
	const eligible = catalog?.models ?? [];
	const addBinding = () =>
		setBindings((previous) => [
			...previous,
			{ id: crypto.randomUUID(), toolKey: "", parameter: "", credential: "ticketApiKey" },
		]);
	const applyBulk = (batch: ToolCredentialBinding[]) => {
		const next = bindings.filter((binding) => binding.toolKey || binding.parameter);
		for (const binding of batch) {
			const key = toolKey({ mcpServerId: binding.mcpServerId, name: binding.toolName });
			const index = next.findIndex((row) => row.toolKey === key && row.parameter === binding.parameter);
			if (index >= 0) next[index] = { ...next[index]!, credential: binding.credential };
			else
				next.push({
					id: crypto.randomUUID(),
					toolKey: key,
					parameter: binding.parameter,
					credential: binding.credential,
				});
		}
		if (next.length > 128) {
			setError("最多支持 128 条凭据映射，请移除不需要的映射后再应用。");
			return false;
		}
		setBindings(next);
		setError(null);
		return true;
	};
	const close = async () => {
		if (
			(name || modelId || systemPrompt) &&
			!(await dialogs.confirm("接入尚未创建，关闭后将丢弃已填写的信息。", {
				title: "放弃创建接入？",
				confirmLabel: "放弃创建",
			}))
		)
			return;
		onClose();
	};
	const submit = async () => {
		setError(null);
		if (catalog?.mcpServers === undefined) {
			setError("配置目录尚未就绪，请升级服务端后重新加载。");
			return;
		}
		if (!modelId || !name.trim()) {
			setError("请选择分析模型，并填写接入名称。");
			return;
		}
		if (step === 0) {
			setStep(1);
			return;
		}
		if (
			!allowed.length ||
			!allowed.includes(app.modelId) ||
			allowed.some((id) => !catalog?.models.some((m) => m.id === id))
		) {
			setError("请选择可用模型，并保留当前分析模型。");
			return;
		}
		if (step === 1) {
			setStep(2);
			return;
		}
		const submitted: ToolCredentialBinding[] = [];
		if (useCredentials) {
			if (bindings.length > 128) {
				setError("最多支持 128 条凭据映射。");
				setEditingBindings(true);
				return;
			}
			if (!bindings.length) {
				setError("请添加至少一条凭据映射，或关闭任务凭据选项。");
				return;
			}
			for (const [index, binding] of bindings.entries()) {
				const tool = app.tools.find((t) => toolKey(t) === binding.toolKey);
				if (
					!tool ||
					!tool.credentialParameters.includes(binding.parameter) ||
					!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.credential)
				) {
					setError(`请补全第 ${index + 1} 条映射。凭据名称只能使用英文字母、数字和下划线，且不能以数字开头。`);
					setEditingBindings(true);
					return;
				}
				if (
					submitted.some(
						(b) =>
							b.mcpServerId === tool.mcpServerId &&
							b.toolName === tool.name &&
							b.parameter === binding.parameter,
					)
				) {
					setError("同一工具参数只能配置一条凭据映射。");
					setEditingBindings(true);
					return;
				}
				submitted.push({
					mcpServerId: tool.mcpServerId,
					toolName: tool.name,
					parameter: binding.parameter,
					credential: binding.credential,
				});
			}
		}
		setBusy(true);
		try {
			const result = await api.request<{ token: string }>("integrations", "POST", {
				name: name.trim(),
				configuration: {
					systemPrompt,
					modelId,
					parameters: {},
					mcpServers: (catalog?.mcpServers ?? [])
						.filter((s) => serverIds.includes(s.id))
						.map((s) => ({ mcpServerId: s.id, revision: s.revision, toolNames: s.tools.map((t) => t.name) })),
					skills: (catalog?.skills ?? [])
						.filter((s) => skillIds.includes(s.id))
						.map((s) => ({ skillId: s.id, revision: s.revision })),
				},
				settings: { allowedModels: allowed, bindings: submitted },
			});
			onCreated(name.trim(), result.token);
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<OrchestrationDrawer
			title="新建接入"
			subtitle="独立定义任务执行配置，通过 API 提供给外部系统。"
			busy={busy}
			onClose={() => void close()}
			footer={
				<>
					<span className={styles.footerHint}>第 {step + 1} 步，共 3 步</span>
					<AuroraButton disabled={busy} onClick={() => (step ? setStep(step - 1) : void close())}>
						{step ? "上一步" : "取消"}
					</AuroraButton>
					<AuroraButton
						variant="primary"
						type="submit"
						form={formId}
						disabled={busy || loading || !catalog || !eligible.length}
					>
						{busy ? "正在创建…" : step === 2 ? "创建并签发凭据" : "下一步"}
					</AuroraButton>
				</>
			}
		>
			<ol className={styles.steps}>
				{["任务配置", "模型范围", "工具授权"].map((label, index) => (
					<li
						key={label}
						aria-current={step === index ? "step" : undefined}
						className={index <= step ? styles.stepActive : undefined}
					>
						<span>{index + 1}</span>
						{label}
					</li>
				))}
			</ol>
			{loading && <output className={styles.loading}>正在读取模型、MCP 和 Skill 目录…</output>}
			{catalogError && (
				<div className={styles.error} role="alert">
					<p>{catalogError}</p>
					<AuroraButton onClick={onReload}>重新加载选项</AuroraButton>
				</div>
			)}
			{catalog && !eligible.length && (
				<div className={styles.empty}>
					<h3>暂无可用模型</h3>
					<p>请先在平台配置模型，再重新加载。</p>
					<AuroraButton onClick={onReload}>重新加载选项</AuroraButton>
				</div>
			)}

			<form
				id={formId}
				className={styles.form}
				onSubmit={(event) => {
					event.preventDefault();
					if (!busy) void submit();
				}}
			>
				{step === 0 && (
					<>
						<label className={styles.field}>
							分析模型
							<select
								data-autofocus
								value={modelId}
								onChange={(event) => {
									setModelId(event.target.value);
									setAllowed((previous) =>
										Array.from(new Set([...previous, event.target.value])).filter(Boolean),
									);
									setError(null);
								}}
							>
								<option value="">请选择模型</option>
								{catalog?.models.map((model) => (
									<option key={`${model.provider}/${model.id}`} value={model.id}>
										{model.name} · {model.provider}
									</option>
								))}
							</select>
							<small>由平台配置，外部调用方不能更改。</small>
						</label>
						<label className={styles.field}>
							默认系统提示词
							<textarea
								rows={8}
								maxLength={60000}
								value={systemPrompt}
								onChange={(event) => setSystemPrompt(event.target.value)}
								placeholder="默认背景规则；每次请求可通过 prompt 覆盖"
							/>
							<small>
								编排提供模型、思考强度、MCP/Skill 等执行能力；外部每次请求通过 prompt
								提供完整任务规则与数据，并覆盖此默认提示词。input 形式仅作为任务消息，不覆盖。
							</small>
						</label>

						<label className={styles.field}>
							接入名称
							<input
								aria-label="接入名称"
								maxLength={200}
								placeholder="例如：运维工单系统"
								value={name}
								onChange={(event) => setName(event.target.value)}
							/>
							<small>用于在分析工作项中识别告警来源。</small>
						</label>
					</>
				)}
				{step === 1 && (
					<>
						<div className={styles.sectionHeading}>
							<h3>平台可配置的模型范围</h3>
							<p>平台后续可在此范围调整分析模型，外部项目只提交任务。</p>
						</div>
						<div className={styles.choiceList}>
							{catalog?.models.map((model) => (
								<label key={`${model.provider}/${model.id}`} className={styles.choice}>
									<input
										type="checkbox"
										checked={allowed.includes(model.id)}
										disabled={model.id === app?.modelId}
										onChange={(event) =>
											setAllowed((previous) =>
												event.target.checked
													? [...previous, model.id]
													: previous.filter((id) => id !== model.id),
											)
										}
									/>
									<span>
										<strong>{model.name}</strong>
										<small>
											{model.provider}
											{model.id === app?.modelId ? " · 当前分析模型" : ""}
										</small>
									</span>
								</label>
							))}
						</div>
						<p className={styles.muted}>已选择 {allowed.length} 个模型。思考强度将在分析配置中按模型能力设置。</p>
					</>
				)}
				{step === 2 && (
					<>
						<div className={styles.sectionHeading}>
							<h3>MCP 与 Skill</h3>
							<p>直接选择平台资源，不关联 Chat Agent。</p>
						</div>
						<div className={styles.choiceList}>
							{catalog?.mcpServers?.map((server) => (
								<label key={server.id} className={styles.choice}>
									<input
										type="checkbox"
										checked={serverIds.includes(server.id)}
										onChange={(event) => {
											setServerIds((previous) =>
												event.target.checked
													? [...previous, server.id]
													: previous.filter((id) => id !== server.id),
											);
											if (!event.target.checked)
												setBindings((previous) =>
													previous.filter(
														(binding) => !server.tools.some((tool) => toolKey(tool) === binding.toolKey),
													),
												);
										}}
									/>
									<span>
										<strong>{server.name}</strong>
										<small>
											版本 {server.revision} · {server.tools.length} 个工具
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
										checked={skillIds.includes(skill.id)}
										onChange={(event) =>
											setSkillIds((previous) =>
												event.target.checked
													? [...previous, skill.id]
													: previous.filter((id) => id !== skill.id),
											)
										}
									/>
									<span>
										<strong>{skill.name}</strong>
										<small>Skill 版本 {skill.revision}</small>
									</span>
								</label>
							))}
						</div>

						<div className={styles.summaryBox}>
							<strong>{name}</strong>
							<p>
								{catalog?.models.find((model) => model.id === modelId)?.name ?? modelId} · 平台可配置{" "}
								{allowed.length} 个模型
							</p>
						</div>
						<div className={styles.sectionHeading}>
							<h3>任务凭据</h3>
							<p>如果工具需要不同用户的业务 API key，由工单后端随每次任务传入。</p>
						</div>
						<label className={styles.checkboxLine}>
							<input
								type="checkbox"
								checked={useCredentials}
								onChange={(event) => {
									setUseCredentials(event.target.checked);
								}}
							/>
							工具需要随任务传入凭据
						</label>
						{useCredentials && (
							<>
								<OrchestrationBulkBindings key={serverIds.join(",")} tools={app.tools} onApply={applyBulk} />
								{bindings.length > 0 && (
									<p className={styles.muted}>
										已配置 {bindings.length} 条映射，使用{" "}
										{new Set(bindings.filter((b) => b.toolKey && b.parameter).map((b) => b.credential)).size}{" "}
										个请求凭据名称。
									</p>
								)}
								<details
									className={styles.bindingDetails}
									open={editingBindings}
									onToggle={(event) => setEditingBindings(event.currentTarget.open)}
								>
									<summary>逐条查看与调整（{bindings.length} 条）</summary>
									<div className={styles.mappingList}>
										{bindings.map((binding, index) => {
											const tool = app?.tools.find((t) => toolKey(t) === binding.toolKey);
											const update = (patch: Partial<BindingDraft>) =>
												setBindings((previous) =>
													previous.map((b) => (b.id === binding.id ? { ...b, ...patch } : b)),
												);
											return (
												<fieldset key={binding.id} className={styles.mapping}>
													<legend>凭据映射 {index + 1}</legend>
													<label className={styles.field}>
														工具
														<select
															aria-label={`映射 ${index + 1} 的工具`}
															value={binding.toolKey}
															onChange={(event) =>
																update({ toolKey: event.target.value, parameter: "" })
															}
														>
															<option value="">请选择已发布工具</option>
															{app?.tools.map((t) => (
																<option
																	key={toolKey(t)}
																	value={toolKey(t)}
																	disabled={!t.credentialParameters.length}
																>
																	{t.serverName} / {t.name}
																	{!t.credentialParameters.length ? "（无可绑定参数）" : ""}
																</option>
															))}
														</select>
													</label>
													<div className={styles.twoColumns}>
														<label className={styles.field}>
															工具中的密钥参数
															<select
																aria-label={`映射 ${index + 1} 的密钥参数`}
																disabled={!tool}
																value={binding.parameter}
																onChange={(event) => update({ parameter: event.target.value })}
															>
																<option value="">请选择参数</option>
																{tool?.credentialParameters.map((p) => (
																	<option key={p}>{p}</option>
																))}
															</select>
														</label>
														<label className={styles.field}>
															工单端传入的凭据名称
															<input
																aria-label={`映射 ${index + 1} 的凭据名称`}
																value={binding.credential}
																onChange={(event) => update({ credential: event.target.value })}
															/>
														</label>
													</div>
													<button
														type="button"
														className={styles.textButton}
														onClick={() =>
															setBindings((previous) => previous.filter((b) => b.id !== binding.id))
														}
													>
														移除此映射
													</button>
												</fieldset>
											);
										})}
									</div>
								</details>
								<AuroraButton
									onClick={() => {
										addBinding();
										setEditingBindings(true);
									}}
								>
									＋ 单独添加凭据映射
								</AuroraButton>
								{!app?.tools.some((t) => t.credentialParameters.length > 0) && (
									<p className={styles.error} role="alert">
										所选 MCP 中没有支持凭据绑定的工具。请检查资源选择。
									</p>
								)}
							</>
						)}
						<div className={styles.note}>
							这里只配置传递规则，不填写用户密钥。MCP 服务的固定连接凭据继续由平台管理。
						</div>
					</>
				)}
				{error && (
					<p className={styles.error} role="alert">
						{error}
					</p>
				)}
			</form>
			{dialogs.dialog}
		</OrchestrationDrawer>
	);
}
