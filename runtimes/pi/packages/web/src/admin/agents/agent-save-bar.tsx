/**
 * Agent Save Bar（阶段二 §4.3）。
 *
 * 吸底操作栏：覆盖 saved / dirty / saving / error 四态，含状态徽标、
 * 变更摘要、放弃修改与「保存为新 Revision」。保存中禁用重复操作；草稿
 * 失败时保留草稿等待重试。
 *
 * 该组件不持有状态 —— 状态机与 idempotency 由 `AgentWorkspace` 负责。
 */
import type { AgentState } from "./agent-state.ts";

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
	const statusLabel = statusLabelFor(state);
	const statusVariant = variantFor(state.status);
	return (
		<aside
			className="agent-save-bar"
			data-state={state.status}
			role="region"
			aria-label="保存草稿"
		>
			<div className="agent-save-bar__status">
				<span className={`agent-save-bar__badge agent-save-bar__badge--${statusVariant}`}>{statusLabel}</span>
				{state.status === "error" && state.errorMessage !== null ? (
					<span role="alert" className="agent-save-bar__error">
						{state.errorMessage}
					</span>
				) : null}
			</div>
			<label htmlFor={inputId} className="agent-save-bar__label">
				变更摘要
			</label>
			<input
				id={inputId}
				type="text"
				className="agent-save-bar__input"
				value={changeSummary}
				placeholder="简要描述本次修改（可选）"
				disabled={isSaving}
				onChange={(e) => onChangeSummary(e.currentTarget.value)}
			/>
			<div className="agent-save-bar__actions">
				<button
					type="button"
					className="agent-save-bar__btn agent-save-bar__btn--secondary"
					onClick={onRevert}
					disabled={!canRevert || isSaving}
				>
					放弃修改
				</button>
				<button
					type="button"
					className="agent-save-bar__btn agent-save-bar__btn--primary"
					onClick={onSave}
					disabled={!canSave || isSaving}
				>
					{isSaving ? "保存中…" : "保存为新 Revision"}
				</button>
			</div>
		</aside>
	);
}

function statusLabelFor(state: AgentState): string {
	switch (state.status) {
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

function variantFor(status: AgentState["status"]): "saved" | "dirty" | "saving" | "error" {
	return status;
}