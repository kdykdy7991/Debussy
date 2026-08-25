/**
 * Agent Save Bar（阶段三：Aurora UI 统一）。
 *
 * 吸底操作栏（sticky），桌面单行 / 窄屏换行（CSS Module 接管）。
 * 覆盖 saved / dirty / saving / error 四态，状态用 AuroraPill 标记。
 *
 * 该组件不持有状态机 —— 状态由 `AgentWorkspace` 提供。
 */
import type { AgentState } from "./agent-state.ts";
import { AuroraButton, AuroraPill, type AuroraPillTone } from "../aurora/index.ts";
import styles from "./agent-workspace.module.css";

export interface AgentSaveBarProps {
	readonly state: AgentState;
	readonly changeSummary: string;
	readonly onChangeSummary: (s: string) => void;
	readonly onSave: () => void;
	readonly onRevert: () => void;
}

export function AgentSaveBar({
	state,
	changeSummary,
	onChangeSummary,
	onSave,
	onRevert,
}: AgentSaveBarProps): React.ReactElement {
	const isSaving = state.status === "saving";
	const canSave = state.status === "dirty" || state.status === "error";
	const canRevert = state.status === "dirty" || state.status === "error";
	const inputId = "agent-save-bar-summary";
	const tone = toneFor(state.status);
	const label = labelFor(state.status);
	return (
		<aside
			className={styles.saveBar}
			data-state={state.status}
			role="region"
			aria-label="保存草稿"
		>
			<div className={styles.saveBar__status}>
				<AuroraPill tone={tone}>{label}</AuroraPill>
				{state.status === "error" && state.errorMessage !== null ? (
					<span role="alert" className={styles.saveBar__error} title={state.errorMessage}>
						{state.errorMessage}
					</span>
				) : null}
			</div>
			<label htmlFor={inputId} className={styles.saveBar__label}>
				变更摘要
			</label>
			<input
				id={inputId}
				type="text"
				className={styles.saveBar__input}
				value={changeSummary}
				placeholder="简要描述本次修改（可选）"
				disabled={isSaving}
				onChange={(e) => onChangeSummary(e.currentTarget.value)}
			/>
			<div className={styles.saveBar__actions}>
				<AuroraButton variant="default" size="sm" onClick={onRevert} disabled={!canRevert || isSaving}>
					放弃修改
				</AuroraButton>
				<AuroraButton variant="primary" size="sm" onClick={onSave} disabled={!canSave || isSaving}>
					{isSaving ? "保存中…" : "保存为新 Revision"}
				</AuroraButton>
			</div>
		</aside>
	);
}

function labelFor(status: AgentState["status"]): string {
	switch (status) {
		case "saved":
			return "已保存";
		case "dirty":
			return "有未保存修改";
		case "saving":
			return "保存中";
		case "error":
			return "保存失败";
	}
}

function toneFor(status: AgentState["status"]): AuroraPillTone {
	switch (status) {
		case "saved":
			return "green";
		case "dirty":
			return "amber";
		case "saving":
			return "neutral";
		case "error":
			return "red";
	}
}