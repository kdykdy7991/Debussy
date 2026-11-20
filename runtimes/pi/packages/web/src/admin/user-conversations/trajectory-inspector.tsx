import type {
	ConversationAdminLlmCallDetailResponse,
	ConversationAdminLlmCallSummary,
} from "@earendil-works/pi-protocol";
import { useId, useState } from "react";
import { ContextInspector } from "./context-inspector.tsx";
import { readableContent } from "./context-inspector-model.ts";
import { asRecord, readString, safeJson } from "./session-view-helpers.ts";
import styles from "./session-views.module.css";
import { eventContent, type TrajectoryNode } from "./trajectory-model.ts";

export type CallDetailState =
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly data: ConversationAdminLlmCallDetailResponse }
	| { readonly kind: "error"; readonly message: string };
export type InspectionMode = "record" | "request" | "system";
type DetailTab =
	| "summary"
	| "preview"
	| "input"
	| "output"
	| "schema"
	| "usage"
	| "timing"
	| "raw"
	| "system"
	| "tools";

export function TrajectoryInspector({
	record,
	detail,
	owner,
	ownerDetail,
	onLoadCall,
	onClose,
	previous,
	onCompare,
	initialMode = "record",
	onOpenOwner,
}: {
	readonly record: TrajectoryNode;
	readonly detail?: CallDetailState;
	readonly owner?: ConversationAdminLlmCallSummary;
	readonly ownerDetail?: CallDetailState;
	readonly onLoadCall: (call: ConversationAdminLlmCallSummary) => void;
	readonly onClose: () => void;
	readonly previous?: ConversationAdminLlmCallDetailResponse;
	readonly onCompare?: () => void;
	readonly initialMode?: InspectionMode;
	readonly onOpenOwner?: () => void;
}): React.ReactElement {
	const [mode, setMode] = useState<InspectionMode>(initialMode);
	const [tab, setTab] = useState<DetailTab>(initialMode === "system" ? "system" : "summary");
	const [debugOpen, setDebugOpen] = useState(false);
	const panelId = useId();
	const data = detail?.kind === "loaded" ? detail.data : undefined;
	const response = asRecord(data?.response);
	const request = asRecord(data?.request);
	const usage = asRecord(response.usage);
	const isRequest = record.kind === "model" && mode === "request";
	const isSystem = record.kind === "model" && mode === "system";
	const isAssistant = record.kind === "model" && mode === "record";
	const title = isSystem ? "系统配置" : isRequest ? record.title : isAssistant ? "助手输出" : record.title;
	const tabs: readonly (readonly [DetailTab, string])[] = isSystem
		? [
				["system", "系统提示词"],
				["tools", "可用工具目录"],
			]
		: isRequest
			? [
					["summary", "概述"],
					["usage", "用量"],
					["timing", "计时"],
				]
			: isAssistant
				? [
						["summary", "概述"],
						["preview", "预览"],
						["raw", "原始输出"],
					]
				: record.kind === "tool"
					? [
							["summary", "概述"],
							["input", "参数"],
							["output", "结果"],
							["schema", "定义"],
							["timing", "计时"],
						]
					: [
							["summary", "概述"],
							["raw", "原文"],
						];
	const input = record.kind === "tool" && record.input ? asRecord(record.input.payload) : {};
	const schemaRequest = ownerDetail?.kind === "loaded" ? asRecord(ownerDetail.data.request) : {};
	const schema =
		record.kind === "tool" && Array.isArray(schemaRequest.tools)
			? schemaRequest.tools.find((tool: unknown) => readString(asRecord(tool), "name") === record.toolName)
			: undefined;
	const output =
		record.kind === "model"
			? response.content
			: record.kind === "tool"
				? record.result === undefined
					? undefined
					: eventContent(record.result)
				: (record.taskInput?.text ?? eventContent(record.event));
	return (
		<aside className={styles.recordInspector} aria-label="记录详情">
			<header>
				<div>
					<span className={`${styles.ledgerRole} ${styles[`role_${isSystem ? "系统" : record.role}`]}`}>
						{isSystem ? "系统" : record.role}
					</span>
					<strong>{title}</strong>
				</div>
				<button type="button" aria-label="关闭详情" onClick={onClose}>
					×
				</button>
			</header>
			<fieldset className={styles.recordTabs} aria-label="记录详情标签">
				{tabs.map(([value, label]) => (
					<button
						type="button"
						key={value}
						aria-pressed={tab === value}
						aria-controls={panelId}
						onClick={() => setTab(value)}
					>
						{label}
					</button>
				))}
			</fieldset>
			<div className={styles.recordBody} id={panelId}>
				{data?.redacted ? <p className={styles.hint}>内容已按平台规则脱敏。</p> : null}
				{detail?.kind === "loading" ? <p className={styles.hint}>读取记录中…</p> : null}
				{detail?.kind === "error" && record.kind === "model" ? (
					<p className={styles.error}>
						读取失败：{detail.message}{" "}
						<button type="button" onClick={() => onLoadCall(record.call)}>
							重试
						</button>
					</p>
				) : null}
				{tab === "summary" ? (
					<>
						<dl className={styles.recordFacts}>
							{(isAssistant || isRequest) && record.kind === "model" ? (
								<>
									<dt>{isAssistant ? "来源" : "结果"}</dt>
									<dd>
										<button
											className={styles.linkButton}
											type="button"
											onClick={() => {
												setMode(isAssistant ? "request" : "record");
												setTab("summary");
											}}
										>
											{isAssistant ? `请求 #${record.call.callIndex}` : "助手输出"} →
										</button>
									</dd>
								</>
							) : null}
							{record.kind === "tool" ? (
								<>
									<dt>来源</dt>
									<dd>
										{onOpenOwner && owner ? (
											<button className={styles.linkButton} type="button" onClick={onOpenOwner}>
												请求 #{owner.callIndex} →
											</button>
										) : (
											"关联未知"
										)}
									</dd>
								</>
							) : null}
							<dt>状态</dt>
							<dd>{record.status}</dd>
							{isRequest && record.kind === "model" ? (
								<>
									<dt>模型</dt>
									<dd>{record.call.model}</dd>
									<dt>实际工具调用</dt>
									<dd>{record.call.toolCallIds.length} 次</dd>
								</>
							) : null}
							{isAssistant ? (
								<>
									<dt>输入 Token</dt>
									<dd>{typeof usage.input === "number" ? usage.input.toLocaleString() : "未知"}</dd>
									<dt>输出 Token</dt>
									<dd>{typeof usage.output === "number" ? usage.output.toLocaleString() : "未知"}</dd>
								</>
							) : null}
							{record.kind === "event" && record.taskInput !== undefined ? (
								<>
									<dt>输入来源</dt>
									<dd>外部 API 任务</dd>
									<dt>模型请求角色</dt>
									<dd>系统提示词（当前 API 契约）</dd>
								</>
							) : null}
						</dl>
						{isRequest ? (
							<>
								<h3>用量</h3>
								<Payload value={response.usage} />
								<h3>计时</h3>
								<p>{record.durationMs === null ? "耗时未知" : `${record.durationMs.toLocaleString()} ms`}</p>
							</>
						) : (
							<>
								{record.kind === "tool" ? (
									<>
										<h3>参数</h3>
										<Payload value={input.arguments ?? input.input} />
										<h3>结果</h3>
									</>
								) : (
									<h3>{isAssistant ? "本次输出" : record.title}</h3>
								)}
								<Payload value={output} fallback={record.kind === "model" ? record.preview : undefined} />
							</>
						)}
					</>
				) : null}
				{tab === "preview" || tab === "output" ? <Payload value={output} /> : null}
				{tab === "input" ? <Payload value={input.arguments ?? input.input} /> : null}
				{tab === "system" ? <Payload value={request.systemPrompt} /> : null}
				{tab === "tools" ? (
					<>
						<p className={styles.hint}>
							{Array.isArray(request.tools)
								? `${request.tools.length} 个可用工具。这里只是能力目录，实际执行记录见左侧工具行。`
								: "工具目录尚未加载。"}
						</p>
						<Payload value={request.tools} />
					</>
				) : null}
				{tab === "usage" ? <Payload value={response.usage} fallback="未采集用量，不能按 0 计算。" /> : null}
				{tab === "schema" ? (
					schema !== undefined ? (
						<Payload value={schema} />
					) : (
						<>
							<p className={styles.hint}>
								{owner === undefined
									? "尚未找到对应请求，无法确定执行时的工具定义。"
									: "只读取当前工具在发起请求时的定义。"}
							</p>
							{owner?.hasRawPayload ? (
								<button
									className={styles.loadMore}
									type="button"
									disabled={ownerDetail?.kind === "loading"}
									onClick={() => onLoadCall(owner)}
								>
									{ownerDetail?.kind === "loading" ? "读取中…" : "读取当前工具定义"}
								</button>
							) : null}
							{ownerDetail?.kind === "error" ? <p className={styles.error}>{ownerDetail.message}</p> : null}
							{ownerDetail?.kind === "loaded" ? (
								<p className={styles.hint}>对应请求中没有找到同名工具定义。</p>
							) : null}
						</>
					)
				) : null}
				{tab === "timing" ? (
					<>
						<dl className={styles.recordFacts}>
							<dt>开始</dt>
							<dd>{record.time}</dd>
							<dt>结束</dt>
							<dd>{record.completedAt ?? "未记录"}</dd>
							<dt>耗时</dt>
							<dd>{record.durationMs === null ? "未知" : `${record.durationMs} ms`}</dd>
						</dl>
						<p className={styles.hint}>
							{record.kind === "tool"
								? "优先使用工具运行时记录；缺少时退回事件时间。"
								: "模型时间来自持久化记录，包含写入开销；未采集逐请求首 Token 和解码时间。"}
						</p>
					</>
				) : null}
				{tab === "raw" ? (
					<Payload
						raw
						value={
							record.kind === "model"
								? data?.response
								: record.kind === "tool"
									? record.events
									: record.taskInput === undefined
										? record.event
										: { taskInput: record.taskInput, triggerEvent: record.event }
						}
					/>
				) : null}
				{isRequest && data ? (
					<details className={styles.traceDetails} onToggle={(event) => setDebugOpen(event.currentTarget.open)}>
						<summary>调试：完整输入上下文</summary>
						{debugOpen ? (
							<>
								{onCompare && previous === undefined ? (
									<button className={styles.loadMore} type="button" onClick={onCompare}>
										与上次请求比较上下文
									</button>
								) : null}
								<ContextInspector data={data} previous={previous} hideTabs />
								<details>
									<summary>审计原文</summary>
									<Payload raw value={{ request: data.request, response: data.response }} />
								</details>
							</>
						) : null}
					</details>
				) : null}
			</div>
		</aside>
	);
}

function Payload({
	value,
	fallback,
	raw = false,
}: {
	readonly value: unknown;
	readonly fallback?: string;
	readonly raw?: boolean;
}): React.ReactElement {
	const [copied, setCopied] = useState(false);
	const [failed, setFailed] = useState(false);
	if (value === undefined) return <p className={styles.hint}>{fallback ?? "未采集或尚未加载。"}</p>;
	const contentBlocks =
		Array.isArray(value) && value.every((block: unknown) => typeof asRecord(block).type === "string");
	const text = !raw && (typeof value === "string" || contentBlocks) ? readableContent(value) : safeJson(value);
	let structured: unknown;
	if (!raw && (text.trim().startsWith("{") || text.trim().startsWith("["))) {
		try {
			structured = JSON.parse(text);
		} catch {
			/* Keep non-JSON output verbatim. */
		}
	}
	return (
		<div className={styles.inspectorPayload}>
			<button
				type="button"
				onClick={() => {
					void navigator.clipboard.writeText(text).then(
						() => {
							setCopied(true);
							setFailed(false);
						},
						() => setFailed(true),
					);
				}}
			>
				{failed ? "复制失败" : copied ? "已复制" : "复制"}
			</button>
			{structured === undefined ? <pre>{text}</pre> : <JsonBranch value={structured} label="JSON" depth={0} />}
		</div>
	);
}

function JsonBranch({
	value,
	label,
	depth,
}: {
	readonly value: unknown;
	readonly label: string;
	readonly depth: number;
}): React.ReactElement {
	const [open, setOpen] = useState(depth === 0);
	if (typeof value !== "object" || value === null) {
		const text = safeJson(value);
		return text.length <= 240 ? (
			<div className={styles.jsonLeaf}>
				<strong>{label}</strong>: {text}
			</div>
		) : (
			<details className={styles.jsonBranch}>
				<summary>
					{label}: {text.slice(0, 180)}…
				</summary>
				<pre>{text}</pre>
			</details>
		);
	}
	const entries = Object.entries(value);
	return (
		<details className={styles.jsonBranch} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>
				{label} {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
			</summary>
			{open ? (
				<div>
					{entries.map(([key, child]) => (
						<JsonBranch key={key} label={key} value={child} depth={depth + 1} />
					))}
				</div>
			) : null}
		</details>
	);
}
