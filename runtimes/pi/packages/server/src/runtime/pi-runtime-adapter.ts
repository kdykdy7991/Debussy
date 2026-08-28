/**
 * PiRuntimeAdapter（spec 10.1 / TASK-017）。
 *
 * 把冻结的 `RuntimeSpec` 映射为现有 `CreateSessionOptions`/`PiSessionRuntime`
 * 并包装成 `ConversationRuntime`。MVP 只允许 chat-only 白名单：非 chat-only
 * profile、工具、知识库一律拒绝打开（「禁用工具不能调用」在创建时强制，
 * 而非依赖调用方自觉）。Adapter 不处理 Principal 鉴权——只接收已授权 Scope。
 *
 * 依赖注入：`createSession` 由组合层传入（真实组合接
 * `CodingAgentPiSessionBackend.createSession` 的适配；测试接 fake），因此
 * 本模块可独立测试，不直接 import `@earendil-works/pi-coding-agent`。
 *
 * `RuntimeSpec.agent.systemPrompt` 在每轮 prompt 时显式透传到底层
 * AgentSession，保证 Agent 与 Skill 的发布快照不随当前配置漂移。
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelRef, ReasoningEffort, ThinkingLevel } from "@earendil-works/pi-protocol";
import { resolveModelStreamOptions, withConversationEffort } from "../model-parameters.ts";
import type { McpRuntimeToolFactory } from "../publishing/mcp/runtime-tools.ts";
import type { SkillMaterializer } from "../publishing/runtime/skill-materializer.ts";
import type { RuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import type { MaterializedSkill, PiSessionRuntime } from "../types.ts";
import { ConversationRuntime } from "./conversation-runtime.ts";
import type { ScopeContext } from "./scope-context.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** 传给底层会话工厂的创建参数（源自 RuntimeSpec + Scope）。 */
export interface RuntimeSessionOptions {
	/** 会话 id：MVP 直接用 Conversation 的裸 UUID（符合 backend id 规则）。 */
	readonly id: string;
	readonly model: ModelRef;
	readonly thinkingLevel?: ThinkingLevel;
	readonly streamOptions?: import("@earendil-works/pi-ai").SimpleStreamOptions;
	readonly customTools?: readonly ToolDefinition[];
	/** 冻结的发布版本 system prompt（创建会话时写入独立 ResourceLoader）。 */
	readonly systemPrompt?: string;
	/** 已物化的冻结 Skill（经 skillsOverride 注入独立 ResourceLoader）。 */
	readonly skills?: readonly MaterializedSkill[];
}

export type RuntimeSessionFactory = (options: RuntimeSessionOptions) => Promise<PiSessionRuntime>;

export type RuntimeOpenResult =
	| { readonly ok: true; readonly runtime: ConversationRuntime }
	| { readonly ok: false; readonly reason: string };

export interface PiRuntimeAdapter {
	/** 打开一个 ConversationRuntime；spec 越权/越界时返回明确的拒绝原因。 */
	open(spec: RuntimeSpec, scope: ScopeContext): Promise<RuntimeOpenResult>;
}

export function createPiRuntimeAdapter(deps: {
	readonly createSession: RuntimeSessionFactory;
	readonly createMcpTools?: McpRuntimeToolFactory;
	/** Materialises frozen Skills to server-controlled runtime dirs before session creation. */
	readonly skillMaterializer?: SkillMaterializer;
}): PiRuntimeAdapter {
	return {
		async open(spec, scope) {
			const rejection = chatOnlyRejection(spec);
			if (rejection !== null) return { ok: false, reason: rejection };
			// 会话覆盖 > Revision 配置 > 冻结 capability 默认：先解析显式配置，
			// 仅在它和兼容字段都没有给出档位时才补 capability fallback。
			const base = spec.agent.model.params ?? {};
			let resolved = resolveModelStreamOptions(
				withConversationEffort(base, scope.conversationEffort ?? null),
				spec.agent.model.modelId,
			);
			const legacyThinkingLevel = thinkingLevelFrom(spec);
			if (resolved.thinkingLevel === undefined && legacyThinkingLevel === undefined) {
				const fallbackEffort = capabilityDefaultEffort(spec);
				if (fallbackEffort !== undefined) {
					resolved = resolveModelStreamOptions(
						withConversationEffort(base, fallbackEffort),
						spec.agent.model.modelId,
					);
				}
			}
			const thinkingLevel = resolved.thinkingLevel ?? legacyThinkingLevel;
			const customTools = deps.createMcpTools === undefined ? [] : await deps.createMcpTools(spec, scope);
			// 物化冻结 Skill 到运行时目录，并把 systemPrompt/Skill 一并交给会话工厂，
			// 让发布会话通过独立 ResourceLoader（skillsOverride）只看到本版本快照。
			const skills =
				deps.skillMaterializer === undefined
					? []
					: await deps.skillMaterializer.materialize(spec, { tenantId: scope.tenantId });
			const session = await deps.createSession({
				id: scope.conversationId,
				model: { provider: spec.agent.model.provider, id: spec.agent.model.modelId },
				...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
				streamOptions: resolved.streamOptions,
				...(customTools.length > 0 ? { customTools } : {}),
				systemPrompt: spec.agent.systemPrompt,
				...(skills.length > 0 ? { skills } : {}),
			});
			return { ok: true, runtime: new ConversationRuntime({ scope, spec, session }) };
		},
	};
}

/**
 * 冻结能力的运行时默认值。
 *
 * 可关闭模型没有显式默认时仍交给 provider；不可关闭模型则必须选择一个冻结
 * 档位，否则会出现“发布配置声明支持思考，实际请求却没有启用思考”的漂移。
 */
function capabilityDefaultEffort(spec: RuntimeSpec): ReasoningEffort | undefined {
	const reasoning = spec.agent.model.parameterCapabilities?.reasoning;
	if (reasoning === undefined || !reasoning.supported) return undefined;
	if (reasoning.defaultEffort !== undefined) return reasoning.defaultEffort;
	if (!reasoning.toggle) return reasoning.efforts[0];
	return undefined;
}

/** MVP chat-only 白名单校验；返回 null 表示允许。 */
function chatOnlyRejection(spec: RuntimeSpec): string | null {
	if (spec.runtimePolicy.profile !== "chat-only") {
		return `runtimePolicy.profile must be "chat-only" in MVP, got ${spec.runtimePolicy.profile}`;
	}
	if (spec.capabilities.tools.length > 0) {
		return "tools are disabled in the chat-only MVP";
	}
	if (spec.capabilities.knowledgeBases.length > 0) {
		return "knowledge bases are disabled in the chat-only MVP";
	}
	return null;
}

/** 从 `agent.model.params` 读取合法 thinkingLevel；缺失/非法返回 undefined。 */
function thinkingLevelFrom(spec: RuntimeSpec): ThinkingLevel | undefined {
	const params = spec.agent.model.params;
	if (params === undefined || typeof params !== "object" || params === null) return undefined;
	const raw = (params as Record<string, unknown>).thinkingLevel;
	if (typeof raw !== "string" || !THINKING_LEVELS.has(raw as ThinkingLevel)) return undefined;
	return raw as ThinkingLevel;
}
