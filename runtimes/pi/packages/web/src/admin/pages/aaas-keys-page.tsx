import { useCallback, useEffect, useMemo, useState } from "react";
import { type AaasConfigVersion, type AaasKey, AaasKeysApi, createAaasKey } from "../api/aaas-keys-api.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { AuroraPageHeader } from "../aurora/PageHeader.tsx";
import { AuroraPill } from "../aurora/Pill.tsx";
import { AuroraSearchBox } from "../aurora/SearchBox.tsx";
import { Dialog } from "../components/dialog.tsx";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { useDialogs } from "../components/use-dialogs.tsx";
import { navigate } from "../router.ts";
import { KeyDropdown } from "./aaas-key-dropdown.tsx";
import consoleStyles from "./aaas-key-console.module.css";
import styles from "./aaas-keys-page.module.css";
import { OrchestrationDrawer } from "./orchestration-drawer.tsx";
import { RouterCapabilitiesDrawer, routerScopeLabel } from "./router-key-drawers.tsx";

const message = (error: unknown) => (error instanceof Error ? error.message : "请求失败");
const keyStatus = {
	enabled: { label: "已启用", tone: "green" },
	disabled: { label: "已禁用", tone: "amber" },
	revoked: { label: "已撤销", tone: "neutral" },
} as const;
const statusOptions = [
	{ value: "all", label: "全部状态" },
	...Object.entries(keyStatus).map(([value, status]) => ({ value, label: status.label })),
];

export function filterAaasKeys(keys: readonly AaasKey[], search: string, status: string): readonly AaasKey[] {
	const query = search.trim().toLowerCase();
	return keys.filter(
		(key) => (status === "all" || key.status === status) && `${key.name} ${key.keyId}`.toLowerCase().includes(query),
	);
}

export function ConfigurationVersionSelect({
	versions,
	value,
	onSelect,
	allowDefault = false,
}: {
	versions: readonly AaasConfigVersion[];
	value: string;
	onSelect: (version: AaasConfigVersion | undefined) => void;
	allowDefault?: boolean;
}): React.JSX.Element {
	return (
		<label className={styles.versionField}>
			<span>运行配置</span>
			<select
				value={value}
				onChange={(event) =>
					onSelect(versions.find((version) => version.orchestration_version_id === event.currentTarget.value))
				}
			>
				<option value="">{allowDefault ? "使用平台默认配置" : "请选择编排版本"}</option>
				{value && !versions.some((version) => version.orchestration_version_id === value) && (
					<option value={value}>当前版本不可用 · {value}</option>
				)}
				{versions.map((version) => (
					<option key={version.orchestration_version_id} value={version.orchestration_version_id}>
						{version.name} · v{version.revision} · {version.model_id ?? "模型未知"}
					</option>
				))}
			</select>
		</label>
	);
}

export function AdminAaasKeysPage(): React.JSX.Element {
	const { controller } = useAdminAuth();
	const api = useMemo(() => new AaasKeysApi(controller), [controller]);
	const dialogs = useDialogs();
	const [keys, setKeys] = useState<readonly AaasKey[]>([]);
	const [routerEditor, setRouterEditor] = useState<AaasKey | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState("all");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const [name, setName] = useState("");
	const [secret, setSecret] = useState<string | null>(null);
	const [copyStatus, setCopyStatus] = useState("");
	const load = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const nextKeys = await api.request<AaasKey[]>("", "GET", undefined, signal);
				if (signal?.aborted) return;
				setKeys(nextKeys);
				setLoaded(true);
				setError("");
			} catch (cause) {
				if (!signal?.aborted) setError(message(cause));
			}
		},
		[api],
	);
	useEffect(() => {
		const abort = new AbortController();
		void load(abort.signal);
		return () => abort.abort();
	}, [load]);
	async function act(work: () => Promise<void>) {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await work();
		} catch (e) {
			setError(message(e));
		} finally {
			setBusy(false);
		}
	}
	async function create() {
		if (!name.trim()) return;
		await act(async () => {
			await createAaasKey(
				api,
				name.trim(),
				(token) => {
					setCopyStatus("");
					setSecret(token);
					setCreating(false);
					setName("");
				},
				null,
				null,
				true,
			);
			void load();
		});
	}
	async function change(key: AaasKey, action: "enable" | "disable" | "rotate" | "revoke") {
		const label = { enable: "启用", disable: "禁用", rotate: "轮换", revoke: "撤销" }[action];
		if (
			action !== "enable" &&
			!(await dialogs.confirm(
				action === "revoke"
					? "撤销后无法恢复，此 Key 将不能再使用。"
					: action === "rotate"
						? "轮换后旧 Key 立即失效，管理员可再次查看新 Key。"
						: "禁用后此 Key 不能调用接口。",
				{ title: `${label} ${key.name}？`, confirmLabel: label, destructive: true },
			))
		)
			return;
		await act(async () => {
			const result = await api.request<{ token?: string }>(`/${key.keyId}`, "PATCH", { action });
			if (result.token) {
				setCopyStatus("");
				setSecret(result.token);
			} else setNotice(`已${label} ${key.name}`);
			await load();
		});
	}
	async function revealKey(key: AaasKey) {
		await act(async () => {
			const result = await api.request<{ token: string }>(`/${key.keyId}/secret`, "POST", {});
			setCopyStatus("");
			setSecret(result.token);
		});
	}
	const filteredKeys = filterAaasKeys(keys, search, filter);
	return (
		<section className={consoleStyles.keyPage} aria-labelledby="api-key-title">
			<AuroraPageHeader
				title="API Key"
				titleId="api-key-title"
				meta={loaded && <AuroraPill>{keys.length} 把</AuroraPill>}
				actions={
					<AuroraButton
						variant="accent"
						disabled={busy || !loaded}
						onClick={() => {
							setName("");
							setError("");
							setCreating(true);
						}}
					>
						<span aria-hidden="true">＋</span> 创建 API Key
					</AuroraButton>
				}
			/>
			{error && !creating && (
				<p className={consoleStyles.errorMessage} role="alert">
					{error}
				</p>
			)}
			{notice && <output className={consoleStyles.successMessage}>{notice}</output>}
			<div className={consoleStyles.keyPanel}>
				<div className={consoleStyles.keyToolbar}>
					<div className={consoleStyles.keySearch}>
						<AuroraSearchBox
							value={search}
							onChange={setSearch}
							ariaLabel="搜索 API Key"
							placeholder="搜索名称、Key ID…"
						/>
					</div>
					<KeyDropdown label="筛选 Key 状态" value={filter} options={statusOptions} onSelect={setFilter} compact />
					{loaded && (search.trim() || filter !== "all") && (
						<span className={consoleStyles.matchCount}>{filteredKeys.length} 个结果</span>
					)}
				</div>
				{!loaded ? (
					<div className={consoleStyles.keyEmpty}>
						{error ? (
							<AuroraButton onClick={() => void load()}>重新加载</AuroraButton>
						) : (
							<output>正在加载 API Key…</output>
						)}
					</div>
				) : filteredKeys.length === 0 ? (
					<div className={consoleStyles.keyEmpty}>
						<strong>{keys.length ? "没有匹配的 Key" : "暂无 API Key"}</strong>
						{keys.length > 0 && (
							<AuroraButton
								size="sm"
								onClick={() => {
									setSearch("");
									setFilter("all");
								}}
							>
								清除筛选
							</AuroraButton>
						)}
					</div>
				) : (
					<table className={consoleStyles.keyTable} aria-label="API Key 列表">
						<thead>
							<tr>
								<th scope="col">名称</th>
								<th scope="col">状态</th>
								<th scope="col">配置</th>
								<th scope="col">操作</th>
							</tr>
						</thead>
						<tbody>
							{filteredKeys.map((key) => {
								const revision = key.directCapabilityRevision;
								const scope = key.routerCapabilityScope ?? "legacy";
								const status = keyStatus[key.status];
								return (
									<tr key={key.keyId}>
										<td className={consoleStyles.keyIdentity}>
											<strong>{key.name}</strong>
											<code title={key.keyId}>{key.keyId}</code>
										</td>
										<td className={consoleStyles.keyState}>
											<AuroraPill tone={status.tone}>{status.label}</AuroraPill>
										</td>
										<td className={consoleStyles.keyScope}>
											<span>{routerScopeLabel[scope]}</span>
											<span className={consoleStyles.keyVersion}>
												{revision
													? `v${revision}`
													: scope === "legacy" && key.effectiveUnavailable
														? "配置不可用"
														: scope === "legacy" && key.effectiveVersionId
															? `版本 ${key.effectiveVersionId.slice(0, 8)}`
															: "待配置"}
											</span>
										</td>
										<td className={consoleStyles.keyRowActions}>
											<div className={consoleStyles.keyActions}>
												<AuroraButton
													variant="ghost"
													size="sm"
													disabled={busy}
													onClick={() => setRouterEditor(key)}
												>
													配置
												</AuroraButton>
												<AuroraButton
													variant="ghost"
													size="sm"
													disabled={busy}
													onClick={() => navigate(`/conversations/router/${key.keyId}`)}
												>
													执行记录
												</AuroraButton>
												{key.status !== "revoked" && (
													<KeyDropdown<"reveal" | "enable" | "disable" | "rotate" | "revoke">
														label={`${key.name}的更多操作`}
														actions
														disabled={busy}
														options={[
															{ value: "reveal", label: "查看密钥" },
															key.status === "enabled"
																? { value: "disable", label: "禁用 Key" }
																: { value: "enable", label: "启用 Key" },
															...(key.status === "enabled"
																? [{ value: "rotate", label: "轮换密钥" } as const]
																: []),
															{ value: "revoke", label: "撤销 Key", destructive: true },
														]}
														onSelect={(action) =>
															void (action === "reveal" ? revealKey(key) : change(key, action))
														}
													/>
												)}
											</div>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</div>
			{creating && (
				<OrchestrationDrawer
					title="创建 API Key"
					busy={busy}
					onClose={() => setCreating(false)}
					footer={
						<div className={consoleStyles.drawerActions}>
							<AuroraButton onClick={() => setCreating(false)} disabled={busy}>
								取消
							</AuroraButton>
							<AuroraButton
								type="submit"
								form="create-aaas-key"
								variant="accent"
								disabled={busy || !name.trim()}
							>
								{busy ? "创建中…" : "创建并生成 Key"}
							</AuroraButton>
						</div>
					}
				>
					<form
						id="create-aaas-key"
						onSubmit={(event) => {
							event.preventDefault();
							void create();
						}}
					>
						<label className={consoleStyles.field}>
							<span>名称</span>
							<input
								value={name}
								maxLength={200}
								disabled={busy}
								onChange={(event) => setName(event.currentTarget.value)}
								placeholder="输入 Key 名称"
								data-autofocus
							/>
						</label>
						{error && (
							<p className={consoleStyles.errorMessage} role="alert">
								{error}
							</p>
						)}
					</form>
				</OrchestrationDrawer>
			)}
			{routerEditor && (
				<RouterCapabilitiesDrawer
					key={routerEditor.keyId}
					keyRecord={routerEditor}
					api={api}
					onSaved={() => void load()}
					onClose={() => setRouterEditor(null)}
				/>
			)}
			{secret && (
				<Dialog
					title="完整 API Key"
					description="请妥善保管，避免将密钥发送给他人。"
					onClose={() => setSecret(null)}
					footer={
						<>
							<AuroraButton onClick={() => setSecret(null)}>关闭</AuroraButton>
							<AuroraButton
								variant="accent"
								onClick={() => {
									if (!navigator.clipboard) {
										setCopyStatus("浏览器不支持自动复制，请手动复制。");
										return;
									}
									void navigator.clipboard.writeText(secret).then(
										() => setCopyStatus("已复制 Key"),
										() => setCopyStatus("复制失败，请手动复制。"),
									);
								}}
							>
								复制 Key
							</AuroraButton>
						</>
					}
				>
					<label className={consoleStyles.field}>
						<span>密钥</span>
						<textarea readOnly value={secret} rows={3} onFocus={(event) => event.currentTarget.select()} />
					</label>
					{copyStatus && <output className={consoleStyles.successMessage}>{copyStatus}</output>}
				</Dialog>
			)}
			{dialogs.dialog}
		</section>
	);
}
