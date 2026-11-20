import type { McpServerDetail, McpToolRef } from "@earendil-works/pi-protocol";
import { useId, useState } from "react";
import { groupMcpSensitiveBindings, type McpApi, McpApiError, type McpSensitiveBinding } from "../api/mcp-api.ts";
import { AuroraButton } from "../aurora/Button.tsx";
import { AuroraPill } from "../aurora/Pill.tsx";
import { AuroraSearchBox } from "../aurora/SearchBox.tsx";
import { useDialogs } from "../components/use-dialogs.tsx";
import { KeyDropdown } from "./aaas-key-dropdown.tsx";
import styles from "./mcp-sensitive-rules.module.css";

export const sensitiveRulesSectionId = "mcp-sensitive-rules";
const defaultCredentialId = "tool_credential";

export function sensitiveParameterTools(tools: readonly McpToolRef[]): ReadonlyMap<string, readonly string[]> {
	const byParameter = new Map<string, string[]>();
	for (const tool of tools) {
		const properties = tool.inputSchema.properties;
		if (tool.name.length < 1 || tool.name.length > 128 || !properties || typeof properties !== "object") continue;
		for (const [name, schema] of Object.entries(properties)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(name)) continue;
			if (!schema || typeof schema !== "object" || !("type" in schema) || schema.type !== "string") continue;
			const matchingTools = byParameter.get(name);
			if (matchingTools) matchingTools.push(tool.name);
			else byParameter.set(name, [tool.name]);
		}
	}
	return byParameter;
}

interface RulesSnapshot {
	revision: number;
	bindings: readonly McpSensitiveBinding[];
	parameters: ReadonlyMap<string, readonly string[]>;
}

export function SensitiveRulesEditor({
	detail,
	api,
	onPublished,
}: {
	detail: McpServerDetail;
	api: McpApi;
	onPublished: () => void;
}): React.JSX.Element {
	const dialogs = useDialogs();
	const titleId = useId();
	const [snapshot, setSnapshot] = useState<RulesSnapshot | null>(null);
	const [rules, setRules] = useState<readonly McpSensitiveBinding[]>([]);
	const [parameter, setParameter] = useState("");
	const [credentialId, setCredentialId] = useState(defaultCredentialId);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [verifiedEmpty, setVerifiedEmpty] = useState(false);
	const [busy, setBusy] = useState<"loading" | "publishing" | null>(null);
	const [conflict, setConflict] = useState(false);
	const [error, setError] = useState("");
	const [publishedRevision, setPublishedRevision] = useState<number>();
	const revision = Math.max(detail.currentRevision, snapshot?.revision ?? 0, publishedRevision ?? 0);
	const stale = snapshot !== null && (conflict || snapshot.revision < revision);
	const dirty = snapshot !== null && (rules !== snapshot.bindings || verifiedEmpty || selected.size > 0);
	const locked = busy !== null || stale;
	const credentialIds = [
		...new Set([defaultCredentialId, ...(snapshot?.bindings.map((rule) => rule.credentialId) ?? [])]),
	];
	const matching = snapshot?.parameters.get(parameter) ?? [];
	const filter = query.trim().toLowerCase();
	const visible = matching.filter((tool) => tool.toLowerCase().includes(filter));
	const mapped = new Set(rules.filter((rule) => rule.parameter === parameter).map((rule) => rule.toolName));
	const canSelectMore = visible.some((tool) => !mapped.has(tool) && !selected.has(tool));
	const canPublish = snapshot !== null && !locked && selected.size === 0 && (rules.length > 0 || verifiedEmpty);

	async function load() {
		setBusy("loading");
		setError("");
		try {
			const result = await api.sensitiveRules(detail.id);
			const current = result.revision === detail.currentRevision ? detail : await api.get(detail.id);
			const currentRevision = current.revisions.find((item) => item.revision === result.revision);
			if (current.currentRevision !== result.revision || !currentRevision) {
				throw new Error("MCP 版本刚刚更新，请重新加载规则。");
			}
			const bindings = result.sensitive_bindings?.map((rule) => ({ ...rule, mcpServerId: detail.id })) ?? [];
			setSnapshot({
				revision: result.revision,
				bindings,
				parameters: sensitiveParameterTools(currentRevision.tools),
			});
			setRules(bindings);
			setParameter("");
			setCredentialId(defaultCredentialId);
			setQuery("");
			setSelected(new Set());
			setVerifiedEmpty(false);
			setConflict(false);
			setPublishedRevision(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "读取规则失败");
		} finally {
			setBusy(null);
		}
	}

	async function leave(action: "close" | "reload") {
		if (busy) return;
		if (
			dirty &&
			!(await dialogs.confirm("当前修改尚未发布。", { title: "放弃规则修改？", confirmLabel: "放弃修改" }))
		)
			return;
		if (action === "reload") await load();
		else {
			setSnapshot(null);
			setError("");
		}
	}

	async function publish() {
		if (!canPublish || !snapshot) return;
		setBusy("publishing");
		setError("");
		try {
			const result = await api.publishSensitiveRules(detail.id, snapshot.revision, rules);
			setPublishedRevision(result.revision);
			setSnapshot(null);
			onPublished();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "发布规则失败");
			if (cause instanceof McpApiError) {
				if (cause.httpStatus === 409) setConflict(true);
				if (cause.code === "MCP_BINDING_VIOLATION") {
					const latest = await api.sensitiveRules(detail.id).catch(() => null);
					if (latest && latest.revision !== snapshot.revision) setConflict(true);
				}
			}
		} finally {
			setBusy(null);
		}
	}

	return (
		<section id={sensitiveRulesSectionId} tabIndex={-1} className={styles.card} aria-labelledby={titleId}>
			{dialogs.dialog}
			<header className={styles.header}>
				<div className={styles.title}>
					<h2 id={titleId}>Router 敏感参数规则</h2>
					<AuroraPill tone="accent">v{revision}</AuroraPill>
				</div>
				{snapshot === null && (
					<AuroraButton disabled={busy !== null} onClick={() => void load()}>
						{busy === "loading" ? "读取中…" : "查看与编辑规则"}
					</AuroraButton>
				)}
			</header>
			{publishedRevision !== undefined && snapshot === null && (
				<output className={styles.success}>已发布 v{publishedRevision}</output>
			)}
			{error && !stale && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			{snapshot && (
				<div>
					{stale && (
						<p role="alert" className={styles.error}>
							MCP 版本已更新。当前修改仍保留，重新加载后可继续编辑。
						</p>
					)}
					<fieldset disabled={locked} className={styles.editor} aria-label="工具参数映射">
						<div className={styles.picker}>
							<div className={styles.pickerHeader}>
								<h3>添加工具映射</h3>
								<KeyDropdown
									label="敏感参数"
									placeholder="选择敏感参数"
									value={parameter}
									disabled={locked}
									options={[...snapshot.parameters]
										.sort(([a], [b]) => a.localeCompare(b))
										.map(([name, toolNames]) => ({
											value: name,
											label: name,
											detail: `${toolNames.length} 个工具`,
										}))}
									onSelect={(value) => {
										if (value === parameter) return;
										setParameter(value);
										setQuery("");
										setSelected(new Set());
									}}
								/>
							</div>
							{snapshot.parameters.size === 0 && (
								<p className={styles.muted}>此版本没有可映射的顶层字符串参数。</p>
							)}
							{parameter && (
								<>
									{credentialIds.length > 1 && (
										<div className={styles.pickerHeader}>
											<span className={styles.muted}>凭据标识</span>
											<KeyDropdown
												label="凭据标识"
												value={credentialId}
												disabled={locked}
												options={credentialIds.map((id) => ({ value: id, label: id }))}
												onSelect={setCredentialId}
											/>
										</div>
									)}
									<div className={styles.toolBar}>
										<div className={styles.search}>
											<AuroraSearchBox
												value={query}
												onChange={setQuery}
												placeholder="搜索工具名称…"
												ariaLabel="搜索匹配工具"
											/>
										</div>
										<div className={styles.actions}>
											<AuroraButton
												size="sm"
												variant="ghost"
												disabled={!canSelectMore}
												onClick={() =>
													setSelected(
														new Set([...selected, ...visible.filter((tool) => !mapped.has(tool))]),
													)
												}
											>
												{filter ? "全选筛选结果" : "全选匹配工具"}
											</AuroraButton>
											<AuroraButton
												size="sm"
												variant="ghost"
												disabled={selected.size === 0}
												onClick={() => setSelected(new Set())}
											>
												清空选择
											</AuroraButton>
										</div>
									</div>
									{visible.length === 0 ? (
										<p className={styles.muted}>没有匹配的工具</p>
									) : (
										<ul className={styles.toolList}>
											{visible.map((tool) => (
												<li key={tool}>
													<label className={styles.choice}>
														<input
															type="checkbox"
															checked={mapped.has(tool) || selected.has(tool)}
															disabled={mapped.has(tool)}
															onChange={(event) => {
																const next = new Set(selected);
																if (event.currentTarget.checked) next.add(tool);
																else next.delete(tool);
																setSelected(next);
															}}
														/>
														<span>{tool}</span>
														{mapped.has(tool) && <AuroraPill>已映射</AuroraPill>}
													</label>
												</li>
											))}
										</ul>
									)}
									<div className={styles.pickerFooter}>
										<output className={styles.muted}>
											{visible.length} 个匹配 · 已选 {selected.size} 个
										</output>
										<AuroraButton
											size="sm"
											disabled={selected.size === 0}
											onClick={() => {
												setRules([
													...rules,
													...matching
														.filter((tool) => selected.has(tool) && !mapped.has(tool))
														.map((toolName) => ({
															mcpServerId: detail.id,
															toolName,
															parameter,
															credentialId,
														})),
												]);
												setSelected(new Set());
												setVerifiedEmpty(false);
												setError("");
											}}
										>
											{selected.size ? `添加 ${selected.size} 条映射` : "添加映射"}
										</AuroraButton>
									</div>
								</>
							)}
						</div>
						<div className={styles.mappings}>
							<div className={styles.title}>
								<h3>工具参数映射</h3>
								<AuroraPill>{rules.length} 条</AuroraPill>
							</div>
							{rules.length === 0 ? (
								<label className={styles.emptyReview}>
									<input
										type="checkbox"
										checked={verifiedEmpty}
										onChange={(event) => setVerifiedEmpty(event.currentTarget.checked)}
									/>
									已审核，此版本无需敏感参数映射
								</label>
							) : (
								[...groupMcpSensitiveBindings(rules)].map(([key, group]) => (
									<details key={key} className={styles.group}>
										<summary>
											<code>{group.parameter}</code>
											<AuroraPill>{group.toolNames.length} 个工具</AuroraPill>
											<span className={styles.credential}>{group.credentialId}</span>
										</summary>
										<ul className={styles.groupList}>
											{group.toolNames.map((tool) => (
												<li key={tool}>
													<span>{tool}</span>
													<AuroraButton
														variant="ghost"
														size="sm"
														aria-label={`移除 ${tool} 的 ${group.parameter} 映射`}
														onClick={() => {
															setRules(
																rules.filter(
																	(rule) =>
																		rule.toolName !== tool || rule.parameter !== group.parameter,
																),
															);
															setError("");
														}}
													>
														移除
													</AuroraButton>
												</li>
											))}
										</ul>
									</details>
								))
							)}
						</div>
					</fieldset>
					<footer className={styles.footer}>
						<span className={styles.muted}>
							{selected.size > 0
								? "请先添加已选工具或清空选择。"
								: `发布将基于 v${snapshot.revision} 创建新版本。`}
						</span>
						<div className={styles.actions}>
							<AuroraButton disabled={busy !== null} onClick={() => void leave("close")}>
								取消编辑
							</AuroraButton>
							{stale ? (
								<AuroraButton variant="accent" disabled={busy !== null} onClick={() => void leave("reload")}>
									重新加载规则
								</AuroraButton>
							) : (
								<AuroraButton variant="accent" disabled={!canPublish} onClick={() => void publish()}>
									{busy === "publishing" ? "发布中…" : "发布规则"}
								</AuroraButton>
							)}
						</div>
					</footer>
				</div>
			)}
		</section>
	);
}
