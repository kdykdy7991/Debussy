/**
 * 自定义 LLM 配置区块（设置页）。
 *
 * 让管理员通过表单配置自定义 OpenAI-compatible 端点，写入 server 的
 * models.json 并立即热加载；保存后 Chat 模型切换器即可选到新模型。
 */
import type { CustomLlmApi, CustomLlmProvider } from "@earendil-works/pi-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { LlmApi } from "../api/llm-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { AuroraButton } from "./Button.tsx";
import styles from "./settings-view.module.css";

type ListState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly items: readonly CustomLlmProvider[] }
	| { readonly kind: "error"; readonly message: string };

type Editing = { readonly mode: "create" } | { readonly mode: "edit"; readonly provider: CustomLlmProvider } | null;

const EMPTY_FORM = { id: "", name: "", baseUrl: "", api: "openai-completions" as CustomLlmApi, models: "", apiKey: "" };

export function CustomLlmSection(): React.ReactElement {
	const { controller } = useAdminAuth();
	const apiRef = useRef(new LlmApi({ auth: controller })).current;
	const [list, setList] = useState<ListState>({ kind: "loading" });
	const [editing, setEditing] = useState<Editing>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback((): void => {
		setList({ kind: "loading" });
		void apiRef.listProviders().then(
			(result) => setList({ kind: "loaded", items: result.items }),
			(err: unknown) => setList({ kind: "error", message: message(err) }),
		);
	}, [apiRef]);

	useEffect(() => {
		reload();
	}, [reload]);

	return (
		<section className={styles.group} aria-label="自定义 LLM">
			<header className={styles.head}>
				<h4 className={styles.title}>自定义 LLM</h4>
				<p className={styles.desc}>配置 OpenAI 兼容端点；保存后立即重载，Chat 模型切换器即可选择。</p>
			</header>
			{list.kind === "error" ? (
				<p className={styles.error}>{list.message}</p>
			) : (
				<div className={styles.providerList}>
					{list.kind === "loaded" && list.items.length === 0 ? (
						<p className={styles.muted}>还没有自定义 LLM，点击下方"新增"添加。</p>
					) : null}
					{list.kind === "loaded" ? (
						list.items.map((provider) => (
							<div className={styles.providerRow} key={provider.id}>
								<div className={styles.providerRowBody}>
									<span className={styles.providerName}>{provider.name}</span>
									<code className={styles.code}>
										{provider.id} · {provider.api}
									</code>
									<span className={styles.muted}>
										{provider.models.length} 个模型 ·{" "}
										{provider.apiKeyConfigured ? "已配置 Key" : "未配置 Key"}
									</span>
								</div>
								<div className={styles.providerRowActions}>
									<AuroraButton size="sm" onClick={() => setEditing({ mode: "edit", provider })}>
										编辑
									</AuroraButton>
									<AuroraButton size="sm" onClick={() => void remove(provider.id)}>
										删除
									</AuroraButton>
								</div>
							</div>
						))
					) : list.kind === "loading" ? (
						<p className={styles.muted}>加载中…</p>
					) : null}
				</div>
			)}
			{error ? <p className={styles.error}>{error}</p> : null}
			<footer className={styles.groupFooter}>
				<AuroraButton variant="primary" onClick={() => setEditing({ mode: "create" })}>
					新增
				</AuroraButton>
			</footer>

			{editing !== null ? (
				<LlmForm
					initial={
						editing.mode === "edit"
							? {
									id: editing.provider.id,
									name: editing.provider.name,
									baseUrl: editing.provider.baseUrl,
									api: editing.provider.api,
									models: editing.provider.models.join("\n"),
									apiKey: "",
								}
							: EMPTY_FORM
					}
					disableId={editing.mode === "edit"}
					onCancel={() => setEditing(null)}
					onSubmit={async (form) => {
						setBusy(true);
						setError(null);
						try {
							await apiRef.upsertProvider({
								id: form.id,
								name: form.name,
								baseUrl: form.baseUrl,
								api: form.api,
								models: form.models
									.split("\n")
									.map((line) => line.trim())
									.filter(Boolean),
								...(form.apiKey.trim() === "" ? {} : { apiKey: form.apiKey.trim() }),
							});
							setEditing(null);
							reload();
						} catch (err) {
							setError(message(err));
						} finally {
							setBusy(false);
						}
					}}
					busy={busy}
				/>
			) : null}
		</section>
	);

	async function remove(id: string): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			await apiRef.deleteProvider(id);
			reload();
		} catch (err) {
			setError(message(err));
		} finally {
			setBusy(false);
		}
	}
}

interface LlmFormInitial {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly api: CustomLlmApi;
	readonly models: string;
	readonly apiKey: string;
}

function LlmForm({
	initial,
	disableId,
	onCancel,
	onSubmit,
	busy,
}: {
	readonly initial: LlmFormInitial;
	readonly disableId: boolean;
	readonly onCancel: () => void;
	readonly onSubmit: (form: LlmFormInitial) => Promise<void>;
	readonly busy: boolean;
}): React.ReactElement {
	const [form, setForm] = useState<LlmFormInitial>(initial);
	const set = (patch: Partial<LlmFormInitial>): void => setForm((prev) => ({ ...prev, ...patch }));

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: click-outside-to-close overlay; Escape is handled onKeyDown below.
		<div
			className={styles.modalBackdrop}
			role="presentation"
			onClick={onCancel}
			onKeyDown={(event) => {
				if (event.key === "Escape") onCancel();
			}}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation guard only; the actionable controls live inside. */}
			<div
				className={styles.modal}
				role="dialog"
				aria-modal="true"
				aria-labelledby="llm-modal-title"
				onClick={(event) => {
					event.stopPropagation();
				}}
			>
				<header className={styles.modalHead}>
					<h4 className={styles.modalTitle} id="llm-modal-title">
						{disableId ? "编辑自定义 LLM" : "新增自定义 LLM"}
					</h4>
					<p className={styles.modalDesc}>
						使用 OpenAI 兼容协议。API Key 支持字面量或 <code>$ENV_VAR</code> 环境变量引用。
					</p>
				</header>
				<div className={styles.formGrid}>
					<label className={styles.field}>
						<span>ID（字母数字 / - / _，保存后不可改）</span>
						<input
							className={styles.input}
							value={form.id}
							disabled={disableId}
							onChange={(e) => set({ id: e.target.value })}
							placeholder="my-lm"
						/>
					</label>
					<label className={styles.field}>
						<span>名称</span>
						<input
							className={styles.input}
							value={form.name}
							onChange={(e) => set({ name: e.target.value })}
							placeholder="我的网关"
						/>
					</label>
					<label className={styles.field}>
						<span>Base URL</span>
						<input
							className={styles.input}
							value={form.baseUrl}
							onChange={(e) => set({ baseUrl: e.target.value })}
							placeholder="https://gateway.example.com/v1"
						/>
					</label>
					<label className={styles.field}>
						<span>协议</span>
						<select
							className={styles.input}
							value={form.api}
							onChange={(e) => set({ api: e.target.value as CustomLlmApi })}
						>
							<option value="openai-completions">Chat Completions</option>
							<option value="openai-responses">Responses</option>
						</select>
					</label>
					<label className={styles.field}>
						<span>模型 ID（每行一个）</span>
						<textarea
							className={styles.input}
							rows={4}
							value={form.models}
							onChange={(e) => set({ models: e.target.value })}
							placeholder={"qwen2.5-72b\nllama-3.1-8b"}
						/>
					</label>
					<label className={styles.field}>
						<span>API Key（留空保持不变）</span>
						<input
							className={styles.input}
							type="password"
							value={form.apiKey}
							onChange={(e) => set({ apiKey: e.target.value })}
							placeholder="$LLM_KEY 或直接粘贴密钥"
						/>
					</label>
				</div>
				<div className={styles.modalActions}>
					<AuroraButton onClick={onCancel} disabled={busy}>
						取消
					</AuroraButton>
					<AuroraButton variant="primary" disabled={busy} onClick={() => void onSubmit(form)}>
						{busy ? "保存中…" : "保存并重载"}
					</AuroraButton>
				</div>
			</div>
		</div>
	);
}

function message(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
