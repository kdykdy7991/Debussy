/**
 * Revision 列表（WB-003 / SPEC §5.2；阶段一：真实 Diff）。
 *
 * 列表行只展示来自 `listRevisions` 的真实元数据（修订号 / 变更摘要 /
 * 时间 / 创建人 / Source Hash）。点「查看 Diff」时**按需**调用
 * `GET /api/control/v1/agent-definitions/:agentId/revisions/:revision`
 * 拉取完整 `configSnapshot` 与 `diffFromPrevious`，永不在前端拼接或
 * 猜测任何 Diff 字段。
 *
 * 加载状态：行内 `aria-busy` + 文本提示；失败可重试；同一 Revision 的
 * 详情在同一组件实例内缓存（不持久化到 storage）。
 *
 * Revision 1 显示「初始版本，无 diff」；后续 Revision 永远不会被打上
 * 「首次」字样——「首次」是 Revision 1 的语义标签，不是缺省兜底。
 */
import type {
	AgentConfigSnapshot,
	AgentDefinitionRevision,
	AgentPublicId,
	ReasoningEffort,
} from "@earendil-works/pi-protocol";
import { Fragment, useCallback, useEffect, useState } from "react";
import { AgentApi, AgentApiError } from "../api/agent-api.ts";

const PROMPT_PREVIEW_LIMIT = 200;

export interface RevisionListProps {
	readonly items: readonly AgentDefinitionRevision[];
	readonly agentId: AgentPublicId;
	readonly api: AgentApi;
}

/** 仅供测试注入的 fetch override；生产链路走 AgentApi 默认 fetch。 */
export interface RevisionListDeps {
	readonly api: AgentApi;
}

type DetailState =
	| { readonly kind: "idle" }
	| { readonly kind: "loading" }
	| { readonly kind: "loaded"; readonly detail: AgentDefinitionRevision }
	| { readonly kind: "error"; readonly message: string };

export function RevisionList({ items, agentId, api }: RevisionListProps): React.ReactElement {
	const [openKey, setOpenKey] = useState<string | null>(null);
	const [detail, setDetail] = useState<DetailState>({ kind: "idle" });
	const [loadedKey, setLoadedKey] = useState<string | null>(null);

	const close = useCallback(() => {
		setOpenKey(null);
		setDetail({ kind: "idle" });
		setLoadedKey(null);
	}, []);

	useEffect(() => {
		if (openKey === null) {
			setDetail({ kind: "idle" });
			setLoadedKey(null);
			return;
		}
		// 已缓存：直接展示
		if (loadedKey === openKey && detail.kind === "loaded") return;
		let cancelled = false;
		setDetail({ kind: "loading" });
		const [agentIdPart, revisionPart] = openKey.split("::");
		const revision = Number(revisionPart);
		if (agentIdPart !== agentId || !Number.isFinite(revision) || revision < 1) {
			setDetail({ kind: "error", message: "无效的 Revision key" });
			return () => {
				cancelled = true;
			};
		}
		void api
			.getRevision(agentId, revision)
			.then((res) => {
				if (cancelled) return;
				setLoadedKey(openKey);
				setDetail({ kind: "loaded", detail: res });
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				const message =
					err instanceof AgentApiError
						? err.message
						: err instanceof Error
							? err.message
							: String(err);
				setDetail({ kind: "error", message });
			});
		return () => {
			cancelled = true;
		};
	}, [openKey, loadedKey, detail.kind, agentId, api]);

	if (items.length === 0) return <p>暂无 Revision 记录</p>;

	return (
		<table>
			<thead>
				<tr>
					<th>Revision</th>
					<th>变更摘要</th>
					<th>创建时间</th>
					<th>创建人</th>
					<th>Source Hash</th>
					<th>关联应用版本</th>
					<th aria-label="操作" />
				</tr>
			</thead>
			<tbody>
				{items.map((rev) => {
					const key = `${agentId}::${rev.revision}`;
					const isOpen = openKey === key;
					return (
						<Fragment key={key}>
							<tr>
								<td>#{rev.revision}</td>
								<td>{rev.changeSummary?.trim() ? rev.changeSummary : "—"}</td>
								<td>{rev.createdAt}</td>
								<td>{rev.createdBy}</td>
								<td>
									<code>{rev.sourceHash.slice(0, 12)}…</code>
								</td>
								<td>{rev.associatedVersionIds.length}</td>
								<td>
									<button
										type="button"
										aria-expanded={isOpen}
										onClick={() => (isOpen ? close() : setOpenKey(key))}
									>
										{isOpen ? "收起" : "查看 Diff"}
									</button>
								</td>
							</tr>
							{isOpen ? (
								<tr>
									<td colSpan={7}>
										<RevisionDetail revision={rev.revision} state={detail} onRetry={() => {
											setLoadedKey(null);
											setOpenKey(null);
											setOpenKey(key);
										}} />
									</td>
								</tr>
							) : null}
						</Fragment>
					);
				})}
			</tbody>
		</table>
	);
}

function RevisionDetail({
	revision,
	state,
	onRetry,
}: {
	readonly revision: number;
	readonly state: DetailState;
	readonly onRetry: () => void;
}): React.ReactElement {
	if (state.kind === "idle" || state.kind === "loading") {
		return (
			<p aria-busy="true" data-revision-detail-status="loading">
				正在加载 Revision #{revision} 详情…
			</p>
		);
	}
	if (state.kind === "error") {
		return (
			<div role="alert" data-revision-detail-status="error">
				<p>加载 Diff 失败：{state.message}</p>
				<button type="button" onClick={onRetry}>
					重试
				</button>
			</div>
		);
	}
	const detail = state.detail;
	const isInitial = detail.revision === 1 || detail.diffFromPrevious === null;
	return (
		<div data-revision-detail-status="loaded">
			{isInitial ? <p>初始版本，无 diff（这是该 Agent 的第一个 Revision）。</p> : null}
			{!isInitial && detail.diffFromPrevious !== null ? <DiffView diff={detail.diffFromPrevious} /> : null}
			<h4>配置快照</h4>
			<SnapshotView snapshot={detail.configSnapshot} />
		</div>
	);
}

function DiffView({ diff }: { diff: NonNullable<AgentDefinitionRevision["diffFromPrevious"]> }): React.ReactElement {
	return (
		<div>
			<h4>变更字段</h4>
			<p>{diff.changedFields.length === 0 ? "（无字段级差异）" : diff.changedFields.join(", ")}</p>
			{diff.toolsAdded.length > 0 ? <p>+ 工具: {diff.toolsAdded.join(", ")}</p> : null}
			{diff.toolsRemoved.length > 0 ? <p>- 工具: {diff.toolsRemoved.join(", ")}</p> : null}
			{diff.knowledgeAdded.length > 0 ? <p>+ 知识库: {diff.knowledgeAdded.join(", ")}</p> : null}
			{diff.knowledgeRemoved.length > 0 ? <p>- 知识库: {diff.knowledgeRemoved.join(", ")}</p> : null}
			{diff.capabilitiesChanged.length > 0 ? (
				<p>能力变更: {diff.capabilitiesChanged.join(", ")}</p>
			) : null}
			{diff.promptDelta !== null ? (
				<details>
					<summary>Prompt 变更（点击展开）</summary>
					<pre>{diff.promptDelta}</pre>
				</details>
			) : null}
			{Object.keys(diff.parametersDelta).length > 0 ? (
				<details>
					<summary>思考参数变更（点击展开）</summary>
					<dl>
						{Object.entries(diff.parametersDelta).map(([key, delta]) => (
							<Fragment key={key}>
								<dt>{key}</dt>
								<dd>
						<ParameterDelta value={delta} />
					</dd>
								</Fragment>
						))}
					</dl>
				</details>
			) : null}
		</div>
	);
}

function ParameterDelta({ value }: { value: NonNullable<AgentDefinitionRevision["diffFromPrevious"]>["parametersDelta"][string] }): React.ReactElement {
	if (value.kind === "added") return <span>+ 新增 {stringifyValue(value.value)}</span>;
	if (value.kind === "removed") return <span>- 删除 {stringifyValue(value.value)}</span>;
	return (
		<span>
			{stringifyValue(value.from)} → {stringifyValue(value.to)}
		</span>
	);
}

function stringifyValue(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function SnapshotView({ snapshot }: { snapshot: AgentConfigSnapshot }): React.ReactElement {
	const reasoning = snapshot.parameters.reasoning;
	return (
		<dl>
			<dt>Model</dt>
			<dd>
				<code>{snapshot.modelId ?? "—"}</code>
			</dd>
			<dt>System Prompt</dt>
			<dd>
				<LongText text={snapshot.systemPrompt} />
			</dd>
			<dt>思考</dt>
			<dd>
				{reasoning === undefined ? (
					<span>—</span>
				) : (
					<span>
						{reasoning.enabled === false ? "关闭" : "开启"}
						{reasoning.effort !== undefined ? ` · 强度 ${reasoningEffortLabel(reasoning.effort)}` : ""}
					</span>
				)}
			</dd>
			<dt>工具</dt>
			<dd>{snapshot.toolIds.length === 0 ? "—" : snapshot.toolIds.join(", ")}</dd>
			<dt>知识库</dt>
			<dd>{snapshot.knowledgeBaseIds.length === 0 ? "—" : snapshot.knowledgeBaseIds.join(", ")}</dd>
			<dt>能力</dt>
			<dd>{formatCapabilities(snapshot.capabilities)}</dd>
		</dl>
	);
}

function LongText({ text }: { text: string }): React.ReactElement {
	if (text.length <= PROMPT_PREVIEW_LIMIT) {
		return <pre className="agent-snapshot__prompt">{text}</pre>;
	}
	return (
		<details>
			<summary>{text.slice(0, PROMPT_PREVIEW_LIMIT)}…（点击展开 {text.length} 字）</summary>
			<pre className="agent-snapshot__prompt">{text}</pre>
		</details>
	);
}

function formatCapabilities(capabilities: AgentConfigSnapshot["capabilities"]): string {
	const labels: Array<[string, boolean]> = [
		["附件上传", capabilities.attachments],
		["Avatar", capabilities.avatar],
		["实时语音(实验性)", capabilities.liveSpeech],
		["引用检索(只读)", capabilities.citations],
		["Realtime(只读)", capabilities.realtime],
		["Web 搜索(只读)", capabilities.webSearch],
	];
	const enabled = labels.filter(([, on]) => on).map(([name]) => name);
	return enabled.length === 0 ? "—" : enabled.join("、");
}

function reasoningEffortLabel(effort: ReasoningEffort): string {
	return effort;
}