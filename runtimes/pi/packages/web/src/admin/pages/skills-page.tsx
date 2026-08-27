import type { SkillDetail, SkillSummary, SkillValidationDiagnostic } from "@earendil-works/pi-protocol";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SkillApi, SkillApiError } from "../api/skill-api.ts";
import { useAdminAuth } from "../auth/admin-auth-context.tsx";
import { navigate } from "../router.ts";
import styles from "./skills-page.module.css";

type LoadState = "loading" | "loaded" | "error";
type UploadMode = "import" | "revision";

function formatDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date);
}

function shortHash(hash: string): string {
	return hash.length > 22 ? `${hash.slice(0, 19)}…` : hash;
}

function fileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
		reader.onload = () => {
			const value = String(reader.result ?? "");
			const comma = value.indexOf(",");
			if (comma === -1) reject(new Error("无法读取文件内容"));
			else resolve(value.slice(comma + 1));
		};
		reader.readAsDataURL(file);
	});
}

function Status({ enabled }: { readonly enabled: boolean }): React.ReactElement {
	return <span className={enabled ? styles.enabled : styles.disabled}>{enabled ? "已启用" : "已停用"}</span>;
}

function DiagnosticLabel({
	diagnostics,
}: {
	readonly diagnostics: readonly SkillValidationDiagnostic[];
}): React.ReactElement {
	const errors = diagnostics.filter((item) => item.severity === "error").length;
	const warnings = diagnostics.filter((item) => item.severity === "warning").length;
	if (errors > 0) return <span className={styles.validationError}>失败 ({errors})</span>;
	if (warnings > 0) return <span className={styles.validationWarning}>警告 ({warnings})</span>;
	return <span className={styles.validationOk}>通过</span>;
}

export function AdminSkillsPage(): React.ReactElement {
	const { controller, snapshot } = useAdminAuth();
	const apiRef = useRef<SkillApi | null>(null);
	if (apiRef.current === null) apiRef.current = new SkillApi({ auth: controller });
	const api = apiRef.current;
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [loadState, setLoadState] = useState<LoadState>("loading");
	const [items, setItems] = useState<readonly SkillSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detail, setDetail] = useState<SkillDetail | null>(null);
	const [query, setQuery] = useState("");
	const [enabledFilter, setEnabledFilter] = useState<"all" | "enabled" | "disabled">("all");
	const [kindFilter, setKindFilter] = useState<"all" | "file" | "builtin">("all");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [uploadMode, setUploadMode] = useState<UploadMode>("import");
	const [expandedRevision, setExpandedRevision] = useState<number | null>(null);

	const loadList = useCallback(async () => {
		setLoadState("loading");
		setError(null);
		try {
			const result = await api.list();
			setItems(result.items);
			setSelectedId((current) => {
				if (current && result.items.some((item) => item.id === current)) return current;
				return result.items[0]?.id ?? null;
			});
			setLoadState("loaded");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setLoadState("error");
		}
	}, [api]);

	useEffect(() => void loadList(), [loadList]);
	useEffect(() => {
		if (selectedId === null) {
			setDetail(null);
			return;
		}
		let cancelled = false;
		setDetail(null);
		void api.get(selectedId).then(
			(value) => {
				if (!cancelled) setDetail(value);
			},
			(cause: Error) => {
				if (!cancelled) setError(cause.message);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [api, selectedId]);

	const visibleItems = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		return items.filter((item) => {
			if (normalized && !`${item.name} ${item.id}`.toLocaleLowerCase().includes(normalized)) return false;
			if (enabledFilter !== "all" && item.enabled !== (enabledFilter === "enabled")) return false;
			return kindFilter === "all" || item.kind === kindFilter;
		});
	}, [enabledFilter, items, kindFilter, query]);

	const beginUpload = (mode: UploadMode) => {
		setUploadMode(mode);
		fileInputRef.current?.click();
	};
	const upload = async (file: File) => {
		setBusy("upload");
		setError(null);
		try {
			const content = await fileAsBase64(file);
			const result =
				uploadMode === "revision" && selectedId
					? await api.createRevision(selectedId, file.name, content)
					: await api.import(file.name, content);
			setSelectedId(result.id);
			await loadList();
			window.alert(
				result.warnings.length > 0
					? `上传成功，创建 Revision r${result.revision}，存在 ${result.warnings.length} 条警告`
					: `上传成功，创建 Revision r${result.revision}`,
			);
		} catch (cause) {
			const requestId = cause instanceof SkillApiError ? cause.requestId : null;
			setError(
				`${cause instanceof Error ? cause.message : String(cause)}${requestId ? ` · Request ID: ${requestId}` : ""}`,
			);
		} finally {
			setBusy(null);
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	};

	const refreshDetail = async () => {
		if (!selectedId) return;
		setDetail(await api.get(selectedId));
	};
	const validate = async () => {
		if (!selectedId) return;
		setBusy("validate");
		setError(null);
		try {
			const result = await api.validate(selectedId);
			await refreshDetail();
			window.alert(result.diagnostics.length ? `校验完成：${result.diagnostics.length} 条诊断` : "校验通过");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	};
	const toggle = async () => {
		if (!detail) return;
		if (detail.enabled && !window.confirm(`确定停用 Skill“${detail.name}”吗？`)) return;
		setBusy("status");
		try {
			await api.setEnabled(detail.id, !detail.enabled);
			await loadList();
			await refreshDetail();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	};
	const remove = async () => {
		if (!detail || !window.confirm(`确定删除 Skill“${detail.name}”吗？存在发布引用时将无法删除。`)) return;
		setBusy("delete");
		try {
			await api.delete(detail.id);
			setSelectedId(null);
			await loadList();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	};

	return (
		<section className={styles.page} aria-labelledby="skills-title">
			<header className={styles.pageHeader}>
				<div>
					<h1 id="skills-title">Skills 管理</h1>
					<p>管理平台中的 Skill，支持导入、版本管理、校验和启用控制。</p>
				</div>
				<div className={styles.headerActions}>
					<button
						type="button"
						className={styles.secondaryButton}
						disabled={busy !== null}
						onClick={() => beginUpload("import")}
					>
						⇧ 导入 Skill
					</button>
					<button type="button" className={styles.primaryButton} onClick={() => void loadList()}>
						刷新
					</button>
				</div>
			</header>
			<input
				ref={fileInputRef}
				className={styles.hiddenInput}
				type="file"
				accept=".md,.zip,application/zip,text/markdown"
				onChange={(event) => {
					const file = event.currentTarget.files?.[0];
					if (file) void upload(file);
				}}
			/>
			{error ? (
				<div className={styles.errorBanner} role="alert">
					{error}
					<button type="button" onClick={() => setError(null)}>
						×
					</button>
				</div>
			) : null}
			<div className={styles.workspace}>
				<section className={styles.catalog} aria-label="Skill 列表">
					<div className={styles.filters}>
						<input
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
							placeholder="⌕  搜索 Skill 名称或 ID"
							aria-label="搜索 Skill"
						/>
						<label>
							启用状态
							<select
								value={enabledFilter}
								onChange={(event) => setEnabledFilter(event.currentTarget.value as typeof enabledFilter)}
							>
								<option value="all">全部</option>
								<option value="enabled">已启用</option>
								<option value="disabled">已停用</option>
							</select>
						</label>
						<label>
							类型
							<select
								value={kindFilter}
								onChange={(event) => setKindFilter(event.currentTarget.value as typeof kindFilter)}
							>
								<option value="all">全部</option>
								<option value="file">文件导入</option>
								<option value="builtin">平台内置</option>
							</select>
						</label>
						<button
							type="button"
							onClick={() => {
								setQuery("");
								setEnabledFilter("all");
								setKindFilter("all");
							}}
						>
							重置筛选
						</button>
					</div>
					<div className={styles.count}>共 {visibleItems.length} 个 Skill</div>
					<div className={styles.tableScroll}>
						<table className={styles.listTable}>
							<thead>
								<tr>
									<th>名称 / ID</th>
									<th>类型</th>
									<th>当前版本</th>
									<th>启用状态</th>
									<th>更新时间</th>
								</tr>
							</thead>
							<tbody>
								{visibleItems.map((item) => (
									<tr
										key={item.id}
										className={item.id === selectedId ? styles.selectedRow : undefined}
										onClick={() => setSelectedId(item.id)}
									>
										<td>
											<strong>{item.name}</strong>
											<small>{item.id}</small>
										</td>
										<td>
											<span className={styles.kind}>{item.kind === "file" ? "文件" : "内置"}</span>
										</td>
										<td>r{item.currentRevision}</td>
										<td>
											<Status enabled={item.enabled} />
										</td>
										<td>{formatDate(item.updatedAt)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{loadState === "loading" ? <div className={styles.empty}>正在加载 Skills…</div> : null}
					{loadState === "error" ? <div className={styles.empty}>加载失败，请刷新重试</div> : null}
					{loadState === "loaded" && visibleItems.length === 0 ? (
						<div className={styles.empty}>没有匹配的 Skill</div>
					) : null}
				</section>

				<section className={styles.detail} aria-label="Skill 详情">
					{selectedId && detail === null ? <div className={styles.detailEmpty}>正在加载详情…</div> : null}
					{selectedId === null ? <div className={styles.detailEmpty}>选择一个 Skill 查看详情</div> : null}
					{detail ? (
						<>
							<header className={styles.detailHeader}>
								<div>
									<span className={styles.back}>←</span>
									<h2>{detail.name}</h2>
									<Status enabled={detail.enabled} />
								</div>
								<div className={styles.detailActions}>
									<button type="button" disabled={busy !== null} onClick={() => void validate()}>
										{busy === "validate" ? "校验中…" : "校验当前版本"}
									</button>
									<button type="button" disabled={busy !== null} onClick={() => beginUpload("revision")}>
										上传新版本
									</button>
									<button
										type="button"
										className={detail.enabled ? styles.dangerButton : undefined}
										disabled={busy !== null}
										onClick={() => void toggle()}
									>
										{detail.enabled ? "停用" : "启用"}
									</button>
									<button type="button" disabled={busy !== null} onClick={() => void remove()}>
										删除
									</button>
								</div>
							</header>
							<section className={styles.card}>
								<h3>基本信息</h3>
								<dl className={styles.infoGrid}>
									<div>
										<dt>Skill ID</dt>
										<dd>
											{detail.id}{" "}
											<button type="button" onClick={() => void navigator.clipboard.writeText(detail.id)}>
												复制
											</button>
										</dd>
									</div>
									<div>
										<dt>类型</dt>
										<dd>{detail.kind === "file" ? "文件导入" : "平台内置"}</dd>
									</div>
									<div>
										<dt>当前版本</dt>
										<dd>r{detail.currentRevision}</dd>
									</div>
									<div>
										<dt>更新时间</dt>
										<dd>{formatDate(detail.updatedAt)}</dd>
									</div>
									<div>
										<dt>状态</dt>
										<dd>
											<Status enabled={detail.enabled} />
										</dd>
									</div>
									<div>
										<dt>Source Hash</dt>
										<dd className={styles.hash}>{detail.revisions[0]?.sourceHash ?? "—"}</dd>
									</div>
								</dl>
							</section>
							<section className={styles.card}>
								<h3>版本历史（{detail.revisions.length}）</h3>
								<div className={styles.tableScroll}>
									<table className={styles.revisionTable}>
										<thead>
											<tr>
												<th>版本</th>
												<th>创建时间</th>
												<th>创建者</th>
												<th>Source Hash</th>
												<th>校验结果</th>
												<th />
											</tr>
										</thead>
										<tbody>
											{detail.revisions.map((revision) => (
												<Fragment key={revision.revision}>
													<tr>
														<td>
															r{revision.revision}
															{revision.revision === detail.currentRevision ? "（当前）" : ""}
														</td>
														<td>{formatDate(revision.createdAt)}</td>
														<td>
															{revision.createdBy === snapshot.tenant?.id
																? snapshot.tenant.name
																: revision.createdBy}
														</td>
														<td title={revision.sourceHash}>{shortHash(revision.sourceHash)}</td>
														<td>
															<DiagnosticLabel diagnostics={revision.diagnostics} />
														</td>
														<td>
															<button
																type="button"
																className={styles.linkButton}
																onClick={() =>
																	setExpandedRevision(
																		expandedRevision === revision.revision ? null : revision.revision,
																	)
																}
															>
																查看详情
															</button>
														</td>
													</tr>
													{expandedRevision === revision.revision && revision.diagnostics.length > 0 ? (
														<tr className={styles.diagnosticRow}>
															<td colSpan={6}>
																{revision.diagnostics.map((diagnostic) => (
																	<p key={`${diagnostic.code}-${diagnostic.path}`}>
																		{diagnostic.severity === "error" ? "错误" : "警告"} ·{" "}
																		{diagnostic.path} · {diagnostic.message}
																	</p>
																))}
															</td>
														</tr>
													) : null}
												</Fragment>
											))}
										</tbody>
									</table>
								</div>
							</section>
							<section className={styles.card}>
								<h3>引用该 Skill 的 Agent（{detail.boundAgents.length}）</h3>
								{detail.boundAgents.length === 0 ? (
									<div className={styles.cardEmpty}>当前没有 Agent Revision 引用此 Skill</div>
								) : (
									<div className={styles.agentList}>
										{detail.boundAgents.map((binding) => (
											<div className={styles.agentRow} key={`${binding.agentId}-${binding.agentRevision}`}>
												<span className={styles.agentIcon}>◎</span>
												<div>
													<strong>{binding.agentId}</strong>
													<small>Revision r{binding.agentRevision}</small>
												</div>
												<button type="button" onClick={() => navigate(`/agents/${binding.agentId}`)}>
													查看 Agent
												</button>
											</div>
										))}
									</div>
								)}
							</section>
							{detail.boundAgents.length > 0 ? (
								<div className={styles.notice}>
									ⓘ 当前 Skill 存在 Agent Revision 引用；若仍被发布版本引用，将无法删除。
								</div>
							) : null}
						</>
					) : null}
				</section>
			</div>
		</section>
	);
}
