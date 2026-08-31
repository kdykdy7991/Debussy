/**
 * Agent Design Tab（WB-003 / SPEC §5.2；阶段二信息架构重构）。
 *
 * 严格按规范 §4.2 顺序组装：
 *   1. 基本信息（只读）
 *   2. 指令（System Prompt + 字符计数）
 *   3. 模型与思考（严格 select → Provider/能力摘要 → toggle → 默认强度）
 *   4. 输入输出能力（附件 / Avatar / 实验性实时语音）
 *   5. 扩展能力（工具 / 知识库 / Skill / MCP 占位）
 *
 * 该组件不持有任何状态机 —— 草稿由 `AgentWorkspace` 持有，所有编辑
 * 通过 `onEdit` 回到 `editDraft`。模型目录状态机（loading / loaded /
 * error）由 `AgentWorkspace` 拉取并透传，本组件不再做异步获取。
 */
import type { AgentConfigSnapshot, AgentDefinitionDetail } from "@earendil-works/pi-protocol";
import { navigate } from "../router.ts";
import styles from "./agent-design.module.css";
import {
	BasicInfoSection,
	ExtensionsSection,
	InstructionsSection,
	IoCapabilitiesSection,
	type ModelCatalogState,
	ModelSection,
} from "./agent-form.tsx";

export interface AgentDesignTabProps {
	readonly detail: AgentDefinitionDetail;
	readonly draft: AgentConfigSnapshot;
	readonly onEdit: (patch: Partial<AgentConfigSnapshot>) => void;
	readonly catalog: ModelCatalogState;
	readonly canPublish: boolean;
	readonly onPublish: () => void;
}

type DesignSectionIconName = "basic" | "instructions" | "model" | "capabilities" | "extensions";

function DesignSectionIcon({ name }: { readonly name: DesignSectionIconName }): React.ReactElement {
	const paths = {
		basic: (
			<>
				<rect x="5" y="3.5" width="14" height="17" rx="2" />
				<path d="M9 8h6M9 12h6M9 16h4" />
			</>
		),
		instructions: (
			<>
				<path d="m5 19 1.2-4.4L15.8 5a2.1 2.1 0 0 1 3 3l-9.6 9.6L5 19Z" />
				<path d="m13.8 7 3.2 3.2M6.2 14.6l3.2 3.2" />
			</>
		),
		model: (
			<>
				<circle cx="12" cy="12" r="7.5" />
				<path d="M4.5 12h15M12 4.5c2.2 2.2 3.3 4.7 3.3 7.5S14.2 17.3 12 19.5C9.8 17.3 8.7 14.8 8.7 12S9.8 6.7 12 4.5Z" />
			</>
		),
		capabilities: (
			<>
				<path d="M8 4.5h8M12 4.5v4M7 10.5h10v9H7z" />
				<path d="M4.5 13v4M19.5 13v4M10 14h.01M14 14h.01" />
			</>
		),
		extensions: (
			<>
				<path d="M9.5 4.5h5v4h4v5h-4v6h-5v-6h-4v-5h4z" />
				<circle cx="12" cy="11" r="1.5" />
			</>
		),
	} satisfies Readonly<Record<DesignSectionIconName, React.ReactNode>>;
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{paths[name]}
		</svg>
	);
}

export function AgentDesignTab({
	detail,
	draft,
	onEdit,
	catalog,
	canPublish,
	onPublish,
}: AgentDesignTabProps): React.ReactElement {
	const sections = [
		{ id: "agent-basic", label: "基本信息", description: "身份与 Revision", icon: "basic" },
		{ id: "agent-instructions", label: "指令", description: "System Prompt", icon: "instructions" },
		{ id: "agent-model", label: "模型与思考", description: "模型与默认强度", icon: "model" },
		{ id: "agent-io", label: "输入输出能力", description: "附件、Avatar 与语音", icon: "capabilities" },
		{ id: "agent-extensions", label: "扩展能力", description: "工具与知识库", icon: "extensions" },
	] as const;
	const selectedModel =
		catalog.kind === "loaded" ? catalog.items.find((model) => model.id === draft.modelId) : undefined;
	const enabledCapabilities = [
		draft.capabilities.attachments ? "附件" : null,
		draft.capabilities.avatar ? "Avatar" : null,
		draft.capabilities.liveSpeech ? "实时语音" : null,
	].filter((item): item is string => item !== null);

	return (
		<section className={styles.designWorkspace} aria-label="设计">
			<aside className={styles.designNav} aria-label="Agent 设计导航">
				<div className={styles.designNavTitle}>Agent 设计</div>
				<nav>
					{sections.map((section, index) => (
						<a
							key={section.id}
							className={index === 0 ? styles.designNavActive : undefined}
							href={`#${section.id}`}
						>
							<span className={styles.designNavIcon} aria-hidden="true">
								<DesignSectionIcon name={section.icon} />
							</span>
							<span>
								<strong>{section.label}</strong>
								<small>{section.description}</small>
							</span>
						</a>
					))}
				</nav>
			</aside>

			<div className={styles.designEditor}>
				<div id="agent-basic" className={styles.sectionAnchor}>
					<BasicInfoSection detail={detail} />
				</div>
				<div id="agent-instructions" className={styles.sectionAnchor}>
					<InstructionsSection draft={draft} onEdit={onEdit} />
				</div>
				<div id="agent-model" className={styles.sectionAnchor}>
					<ModelSection draft={draft} onEdit={onEdit} catalog={catalog} />
				</div>
				<div id="agent-io" className={styles.sectionAnchor}>
					<IoCapabilitiesSection draft={draft} onEdit={onEdit} />
				</div>
				<div id="agent-extensions" className={styles.sectionAnchor}>
					<ExtensionsSection draft={draft} onEdit={onEdit} />
				</div>
			</div>

			<aside className={styles.designPreview} aria-label="Agent 配置预览">
				<header className={styles.previewHeader}>
					<div>
						<span className={styles.previewKicker}>配置预览</span>
						<h2>{detail.name}</h2>
					</div>
					<span className={styles.previewStatus}>
						<i aria-hidden="true" />
						Revision #{detail.currentRevision}
					</span>
				</header>
				<div className={styles.previewIdentity}>
					<div className={styles.previewAvatar} aria-hidden="true">
						{detail.name.trim().slice(0, 1).toUpperCase()}
					</div>
					<div>
						<strong>{detail.name}</strong>
						<p>{detail.description?.trim() || "尚未填写 Agent 描述"}</p>
					</div>
				</div>
				<div className={styles.previewBlock}>
					<span>当前指令</span>
					<p>{draft.systemPrompt.trim() || "尚未配置 System Prompt"}</p>
				</div>
				<dl className={styles.previewFacts}>
					<div>
						<dt>模型</dt>
						<dd>{selectedModel?.name ?? draft.modelId ?? "未选择"}</dd>
					</div>
					<div>
						<dt>Provider</dt>
						<dd>{selectedModel?.provider ?? "—"}</dd>
					</div>
					<div>
						<dt>知识库</dt>
						<dd>{draft.knowledgeBaseIds.length} 个</dd>
					</div>
				</dl>
				<div className={styles.previewCapabilities}>
					<span>已启用能力</span>
					<div>
						{enabledCapabilities.length > 0 ? (
							enabledCapabilities.map((item) => <b key={item}>{item}</b>)
						) : (
							<em>暂无</em>
						)}
					</div>
				</div>
				<div className={styles.previewNotice}>
					<strong>真实调试在 Chat 中进行</strong>
					<p>这里仅展示当前真实配置，不生成示例对话或虚构工具调用。</p>
				</div>
				<div className={styles.previewActions}>
					<button type="button" className={styles.previewSecondaryButton} onClick={() => navigate("/chat")}>
						进入 Chat 调试
					</button>
					<button type="button" className={styles.previewButton} disabled={!canPublish} onClick={onPublish}>
						{canPublish ? "发布" : "保存草稿后发布"}
					</button>
				</div>
			</aside>
		</section>
	);
}
