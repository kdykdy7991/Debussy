/**
 * Agent 平台 V2：Skill 管理契约（候选，待总架构师冻结）。
 *
 * 对应总计划 §6 共享接口中的 Skill 能力：列表、详情、导入、校验、版本、启停、
 * Agent Revision 绑定。本模块只冻结管理/控制面 DTO 形状，不含导入存储细节与
 * 运行时加载。文件原始内容、解析结果、校验诊断与内容 hash 的追溯要求见
 * backend.md BE-2。
 */
import type { AgentPublicId } from "./admin-workbench.ts";

/** 一个 Agent 的具体不可变 Revision（`agentId + agentRevision` 唯一）。 */
export interface AgentBindingRef {
	readonly agentId: AgentPublicId;
	/** 不可变 Agent revision 号；发布后绑定不可漂移。 */
	readonly agentRevision: number;
}

/** Skill 的持久来源。`file` = 已导入的文件型 Skill；`builtin` = 平台内置。 */
export type SkillKind = "file" | "builtin";

/** 导入/校验诊断项。`error` 阻断发布，`warning` 不阻断。 */
export interface SkillValidationDiagnostic {
	readonly code: string;
	readonly path: string;
	readonly message: string;
	readonly severity: "error" | "warning";
}

/** 列表行（不含 diagnostics 全文）。 */
export interface SkillSummary {
	/** `skill_<uuid>`，传输层禁止裸 UUID。 */
	readonly id: string;
	readonly name: string;
	readonly kind: SkillKind;
	readonly currentRevision: number;
	/** false = 已停用，运行时不会加载。 */
	readonly enabled: boolean;
	readonly updatedAt: string;
}

/** 单个不可变 Skill revision 的元数据。 */
export interface SkillRevisionSummary {
	readonly id: string;
	readonly revision: number;
	/** 原始文件内容 hash，用于追溯与变更检测。 */
	readonly sourceHash: string;
	/** 解析/校验诊断；可空表示通过。 */
	readonly diagnostics: readonly SkillValidationDiagnostic[];
	readonly createdBy: string;
	readonly createdAt: string;
}

/** Skill 详情：元数据 + 全部 revision + 引用它的 Agent Revision 列表。 */
export interface SkillDetail extends SkillSummary {
	readonly revisions: readonly SkillRevisionSummary[];
	/** 绑定了本 Skill 的 Agent Revision（不可漂移）。 */
	readonly boundAgents: readonly AgentBindingRef[];
}

/** `GET /api/control/v1/skills` 列表响应（cursor 分页）。 */
export interface SkillListResponse {
	readonly items: readonly SkillSummary[];
	readonly nextCursor: string | null;
}

/** `POST /api/control/v1/skills/import`：上传一个 SKILL.md 或 ZIP artifact。 */
export interface SkillImportRequest {
	readonly filename: string;
	/** 原始 artifact 的标准 Base64；服务端解码后执行大小与 ZIP 安全校验。 */
	readonly contentBase64: string;
}

export type SkillRevisionCreateRequest = SkillImportRequest;

export interface SkillStatusUpdateRequest {
	readonly enabled: boolean;
}

/** 导入成功响应；`warnings` 为不阻断的校验告警。 */
export interface SkillImportResponse {
	readonly id: string;
	readonly revision: number;
	readonly sourceHash: string;
	readonly warnings: readonly SkillValidationDiagnostic[];
}

/** `POST /api/control/v1/skills/:id/validate` 复校验响应。 */
export interface SkillValidateResponse {
	readonly id: string;
	readonly revision: number;
	readonly diagnostics: readonly SkillValidationDiagnostic[];
}

/**
 * 把 Skill 绑定到**不可变 Agent Revision**（`POST /api/control/v1/agents/:id/
 * revisions/:revision/skills`）。绑定只允许到已保存的不可变 revision，不能绑定
 * 草稿；发布后绑定不可漂移。
 */
export interface SkillBindingRequest {
	readonly agentRevision: number;
	readonly skillId: string;
	/** 缺省 = 绑定 Skill 当前最新 revision。 */
	readonly skillRevision?: number;
}

/** Agent Revision → Skill 绑定条目（一个 Agent Revision 固定一个 Skill Revision）。 */
export interface AgentSkillBinding {
	readonly agentId: AgentPublicId;
	readonly agentRevision: number;
	readonly skillId: string;
	readonly skillRevision: number;
}

/** `POST .../agents/:id/revisions/:revision/skills` 装配结果（按 Agent Revision 返回）。 */
export interface AgentSkillBindResponse {
	readonly agentId: AgentPublicId;
	readonly agentRevision: number;
	readonly bindings: readonly AgentSkillBinding[];
}

/** 启停响应。 */
export interface SkillToggleResponse {
	readonly id: string;
	readonly enabled: boolean;
}

/** Skill 管理稳定错误码（控制面 `ControlErrorEnvelope`）。 */
export const AGENT_V2_SKILL_ERROR_CODES = [
	// 目标 Skill 不存在或跨租户（统一 404，不暴露归属）。
	"SKILL_NOT_FOUND",
	// Skill 解析/校验失败（既用于 import 也用于 validate）。
	"SKILL_INVALID",
	// 导入被安全策略拒绝（路径穿越/超大/不允许的可执行内容等）。
	"SKILL_IMPORT_REJECTED",
	// 绑定时指定的 revision 不存在。
	"SKILL_REVISION_NOT_FOUND",
] as const;
export type AgentV2SkillErrorCode = (typeof AGENT_V2_SKILL_ERROR_CODES)[number];

/** Skill 错误码到 HTTP 状态与重试性的稳定映射。 */
export const AGENT_V2_SKILL_ERRORS: Readonly<
	Record<AgentV2SkillErrorCode, { readonly httpStatus: number; readonly retryable: boolean }>
> = {
	SKILL_NOT_FOUND: { httpStatus: 404, retryable: false },
	SKILL_INVALID: { httpStatus: 422, retryable: false },
	SKILL_IMPORT_REJECTED: { httpStatus: 422, retryable: false },
	SKILL_REVISION_NOT_FOUND: { httpStatus: 404, retryable: false },
} as const;
