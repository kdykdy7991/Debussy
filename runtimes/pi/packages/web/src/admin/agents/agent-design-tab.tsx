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
import styles from "./agent-design.module.css";
import {
	BasicInfoSection,
	ExtensionsSection,
	InstructionsSection,
	IoCapabilitiesSection,
	ModelSection,
	type ModelCatalogState,
} from "./agent-form.tsx";

export interface AgentDesignTabProps {
	readonly detail: AgentDefinitionDetail;
	readonly draft: AgentConfigSnapshot;
	readonly onEdit: (patch: Partial<AgentConfigSnapshot>) => void;
	readonly catalog: ModelCatalogState;
}

export function AgentDesignTab({
	detail,
	draft,
	onEdit,
	catalog,
}: AgentDesignTabProps): React.ReactElement {
	return (
		<div className={styles.design} aria-label="设计">
			<BasicInfoSection detail={detail} />
			<InstructionsSection draft={draft} onEdit={onEdit} />
			<ModelSection draft={draft} onEdit={onEdit} catalog={catalog} />
			<IoCapabilitiesSection draft={draft} onEdit={onEdit} />
			<ExtensionsSection draft={draft} onEdit={onEdit} />
		</div>
	);
}