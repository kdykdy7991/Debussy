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
 * MVP 已知限制：`RuntimeSpec.agent.systemPrompt` 已随版本冻结存档，但现有
 * `PiSessionRuntime.prompt` 不透传 per-conversation system prompt（底层
 * AgentSession 支持 `prompt(text, { systemPrompt })` 覆盖），故本阶段
 * 沿用 Agent 自身配置；发布版本编译自同一 Agent，二者一致，待 TASK-022
 * 恢复链路时统一注入（记录于交接文档）。
 */
import type { ModelRef, ThinkingLevel } from "@earendil-works/pi-protocol";
import { resolveModelStreamOptions, withConversationEffort } from "../model-parameters.ts";
import type { RuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import type { PiSessionRuntime } from "../types.ts";
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
}

export type RuntimeSessionFactory = (options: RuntimeSessionOptions) => Promise<PiSessionRuntime>;

export type RuntimeOpenResult =
	| { readonly ok: true; readonly runtime: ConversationRuntime }
	| { readonly ok: false; readonly reason: string };

export interface PiRuntimeAdapter {
	/** 打开一个 ConversationRuntime；spec 越权/越界时返回明确的拒绝原因。 */
	open(spec: RuntimeSpec, scope: ScopeContext): Promise<RuntimeOpenResult>;
}

export function createPiRuntimeAdapter(deps: { readonly createSession: RuntimeSessionFactory }): PiRuntimeAdapter {
	return {
		async open(spec, scope) {
			const rejection = chatOnlyRejection(spec);
			if (rejection !== null) return { ok: false, reason: rejection };
			// 会话覆盖 > Revision 配置 > 默认：会话 effort 叠加到冻结参数后再解析。
			const base = spec.agent.model.params ?? {};
			const resolved = resolveModelStreamOptions(
				withConversationEffort(base, scope.conversationEffort ?? null),
				spec.agent.model.modelId,
			);
			const thinkingLevel = resolved.thinkingLevel ?? thinkingLevelFrom(spec);
			const session = await deps.createSession({
				id: scope.conversationId,
				model: { provider: spec.agent.model.provider, id: spec.agent.model.modelId },
				...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
				streamOptions: resolved.streamOptions,
			});
			return { ok: true, runtime: new ConversationRuntime({ scope, spec, session }) };
		},
	};
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
