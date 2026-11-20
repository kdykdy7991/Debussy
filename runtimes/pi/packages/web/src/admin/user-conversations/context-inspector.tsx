import type { ConversationAdminLlmCallDetailResponse } from "@earendil-works/pi-protocol";
import { useMemo, useState } from "react";
import {
	CONTEXT_CATEGORIES,
	CONTEXT_LABELS,
	type ContextCategory,
	type ContextEntry,
	compareContexts,
	contextEntries,
	readableContent,
} from "./context-inspector-model.ts";
import { asRecord, readString, safeJson } from "./session-view-helpers.ts";
import styles from "./session-views.module.css";

export function ContextInspector({
	data,
	previous,
	initialTab = "context",
	hideTabs = false,
}: {
	readonly data: ConversationAdminLlmCallDetailResponse;
	readonly previous?: ConversationAdminLlmCallDetailResponse;
	readonly initialTab?: "context" | "response";
	readonly hideTabs?: boolean;
}): React.ReactElement {
	const [tab, setTab] = useState<"context" | "response" | "raw">(initialTab);
	const [category, setCategory] = useState<ContextCategory | "all">("all");
	const [query, setQuery] = useState("");
	const entries = useMemo(() => contextEntries(data.request), [data.request]);
	const needle = query.trim().toLowerCase();
	const filtered = entries.filter(
		(entry) =>
			(category === "all" || entry.category === category) &&
			(needle === "" || `${entry.label}\n${entry.text}\n${safeJson(entry.value)}`.toLowerCase().includes(needle)),
	);
	const response = asRecord(data.response);
	const configuration = filtered.filter((entry) => entry.category === "system" || entry.category === "tools");
	const messages = filtered.filter((entry) => entry.position !== null);
	const other = filtered.filter(
		(entry) => entry.position === null && entry.category !== "system" && entry.category !== "tools",
	);
	const chars = entries.reduce((total, entry) => total + entry.text.length, 0);
	return (
		<div className={styles.inspector}>
			{data.redacted ? <p className={styles.hint}>内容已脱敏。</p> : null}
			{!hideTabs ? (
				<fieldset className={styles.inspectorTabs} aria-label="请求详情视图">
					{(
						[
							["context", "请求上下文"],
							["response", "模型输出"],
							["raw", "完整原文"],
						] as const
					).map(([value, label]) => (
						<button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>
							{label}
						</button>
					))}
				</fieldset>
			) : null}
			{tab === "context" ? (
				<>
					<div className={styles.contextSummary}>
						<strong>模型调用 #{data.callIndex} · 输入上下文</strong>
						<span>
							{entries.filter((entry) => entry.position !== null).length} 条消息 · {chars.toLocaleString()}{" "}
							展示字符
						</span>
					</div>
					<p className={styles.hint}>
						以下内容共同组成这一次模型调用的全部输入，包含已有历史。工具定义表示可用能力，不代表实际执行。消息前的
						# 是输入中的位置，不是调用编号。字符数不代表 Token 用量。
					</p>
					{previous ? (
						<p className={styles.notice}>
							相对调用 #{previous.callIndex}：{compareContexts(previous.request, data.request)}
						</p>
					) : null}
					<fieldset className={styles.contextComposition} aria-label="上下文内容组成">
						{CONTEXT_CATEGORIES.map((value) => {
							const size = entries
								.filter((entry) => entry.category === value)
								.reduce((sum, entry) => sum + entry.text.length, 0);
							return size === 0 ? null : (
								<button
									type="button"
									key={value}
									className={styles[`category_${value}`]}
									style={{ flexGrow: size }}
									onClick={() => setCategory(category === value ? "all" : value)}
									title={`${CONTEXT_LABELS[value]} · ${size.toLocaleString()} 字符`}
									aria-label={`筛选${CONTEXT_LABELS[value]}`}
								/>
							);
						})}
					</fieldset>
					<fieldset className={styles.contextFilters} aria-label="上下文类别">
						<button type="button" aria-pressed={category === "all"} onClick={() => setCategory("all")}>
							全部 {entries.length}
						</button>
						{CONTEXT_CATEGORIES.map((value) => (
							<button
								key={value}
								type="button"
								aria-pressed={category === value}
								onClick={() => setCategory(value)}
							>
								{CONTEXT_LABELS[value]} {entries.filter((entry) => entry.category === value).length}
							</button>
						))}
					</fieldset>
					<label className={styles.contextSearch}>
						搜索本次上下文
						<input
							type="search"
							value={query}
							placeholder="搜索正文、工具名称、参数或调用 ID"
							onChange={(event) => setQuery(event.currentTarget.value)}
						/>
					</label>
					<p className={styles.hint}>
						显示 {filtered.length} / {entries.length} 项
					</p>
					<div className={styles.contextEntries}>
						{configuration.length > 0 ? (
							<details
								className={styles.requestConfiguration}
								open={category === "system" || category === "tools" || needle !== "" ? true : undefined}
							>
								<summary>输入配置 · 系统提示词与可用工具定义（{configuration.length} 项）</summary>
								<p className={styles.hint}>这些是模型的规则与可用工具，不代表执行过的动作。</p>
								{configuration.map((entry) => (
									<ContextEntryRow key={entry.key} entry={entry} />
								))}
							</details>
						) : null}
						{messages.length > 0 ? (
							<section aria-label="请求中的消息顺序">
								<h3>请求中的消息 · 按模型接收顺序</h3>
								{messages.map((entry) => (
									<ContextEntryRow key={entry.key} entry={entry} />
								))}
							</section>
						) : null}
						{other.length > 0 ? (
							<section aria-label="其他请求字段">
								<h3>其他请求字段</h3>
								{other.map((entry) => (
									<ContextEntryRow key={entry.key} entry={entry} />
								))}
							</section>
						) : null}
						{filtered.length === 0 ? <p className={styles.hint}>没有匹配的上下文内容。</p> : null}
					</div>
				</>
			) : null}
			{tab === "response" ? (
				<>
					<div className={styles.contextSummary}>
						<strong>本次模型输出</strong>
						<span>停止原因：{readString(response, "stopReason") || "未知"}</span>
					</div>
					{data.response === null ? (
						<p className={styles.hint}>未采集到模型响应，不能据此判断模型没有输出。</p>
					) : (
						<>
							{readString(response, "errorMessage") ? (
								<p className={styles.error}>{readString(response, "errorMessage")}</p>
							) : null}
							<ContentBlock value={response.content ?? data.response} />
							{response.usage !== undefined ? (
								<details className={styles.contextEntry}>
									<summary>本次用量</summary>
									<pre>{safeJson(response.usage)}</pre>
								</details>
							) : null}
						</>
					)}
				</>
			) : null}
			{tab === "raw" ? (
				<>
					<RawBlock title="完整原始 Request（System / User / Assistant / Tool 角色与原文）" value={data.request} />
					<RawBlock title="完整原始 Response" value={data.response} />
				</>
			) : null}
		</div>
	);
}

function ContextEntryRow({ entry }: { readonly entry: ContextEntry }): React.ReactElement {
	const [open, setOpen] = useState(false);
	return (
		<details className={styles.contextEntry} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>
				<span className={`${styles.categoryDot} ${styles[`category_${entry.category}`]}`} />
				<span className={styles.entryPosition}>{entry.position === null ? "—" : `#${entry.position}`}</span>
				<span className={styles.entryMain}>
					<strong>
						{CONTEXT_LABELS[entry.category]} · {entry.label}
						{asRecord(entry.value).isError === true ? <span className={styles.badgeWarn}>工具错误</span> : null}
					</strong>
					<span>{entry.text.slice(0, 180) || "（空内容）"}</span>
				</span>
				<span className={styles.entrySize}>{entry.text.length.toLocaleString()} 字符</span>
			</summary>
			{open ? (
				<>
					<ContentBlock value={entry.text} />
					{entry.category !== "system" ? (
						<details className={styles.entrySource}>
							<summary>此项原始数据</summary>
							<pre>{safeJson(entry.value)}</pre>
						</details>
					) : null}
				</>
			) : null}
		</details>
	);
}

function ContentBlock({ value }: { readonly value: unknown }): React.ReactElement {
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState(false);
	const text = readableContent(value);
	return (
		<div className={styles.contentBlock}>
			<button
				type="button"
				className={styles.linkButton}
				onClick={() => {
					void navigator.clipboard.writeText(text).then(
						() => {
							setCopied(true);
							setCopyError(false);
						},
						() => setCopyError(true),
					);
				}}
			>
				{copyError ? "复制失败，请选择正文复制" : copied ? "已复制" : "复制内容"}
			</button>
			<pre>{text}</pre>
		</div>
	);
}

function RawBlock({ title, value }: { readonly title: string; readonly value: unknown }): React.ReactElement {
	return (
		<details className={styles.contextEntry} open>
			<summary>{title}</summary>
			<ContentBlock value={safeJson(value)} />
		</details>
	);
}
