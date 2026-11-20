/**
 * PiRuntimeAdapter（spec 10.1 / TASK-017）。
 *
 * 把冻结的 `RuntimeSpec` 映射为现有 `CreateSessionOptions`/`PiSessionRuntime`
 * 并包装成 `ConversationRuntime`。MVP 只允许 chat-only 白名单：非 chat-only
 * profile、内置工具、知识库一律拒绝打开（「禁用工具不能调用」在创建时强制，
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
import type { ModelRef, ThinkingLevel } from "@earendil-works/pi-protocol";
import { resolveEffectiveModelOptions } from "../model-parameters.ts";
import { MCP_RESOURCE_GUIDANCE } from "../publishing/mcp/resource-guidance.ts";
import type { McpRuntimeToolFactory, McpRuntimeTools } from "../publishing/mcp/runtime-tools.ts";
import type { SkillMaterializer } from "../publishing/runtime/skill-materializer.ts";
import type { RuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import type { MaterializedSkill, PiSessionRuntime } from "../types.ts";
import { ConversationRuntime } from "./conversation-runtime.ts";
import type { RuntimeScope, ScopeContext } from "./scope-context.ts";

/** 传给底层会话工厂的创建参数（源自 RuntimeSpec + Scope）。 */
export interface RuntimeSessionOptions {
	/** 会话 id：MVP 直接用 Conversation 的裸 UUID（符合 backend id 规则）。 */
	readonly id: string;
	readonly model: ModelRef;
	readonly thinkingLevel?: ThinkingLevel;
	readonly streamOptions?: import("@earendil-works/pi-ai").SimpleStreamOptions;
	readonly customTools?: readonly ToolDefinition[];
	/** Frozen built-in tool names. An empty array denies all built-ins. */
	readonly allowedToolNames?: readonly string[];
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
	/**
	 * 打开一个 ConversationRuntime；spec 越权/越界时返回明确的拒绝原因。
	 *
	 * `scope` 不要求存在 Conversation：Router Operation 用 `sessionId`
	 * （operation id）作为内存会话标识，MCP 工具从本次执行的凭据来源获得授权。
	 */
	open(spec: RuntimeSpec, scope: RuntimeScope): Promise<RuntimeOpenResult>;
}

/** Maps a frozen builtin Tool capability `{id}` to its runtime tool name. */
export type BuiltinToolNameResolver = (toolId: string) => string | undefined;

export function createPiRuntimeAdapter(deps: {
	readonly createSession: RuntimeSessionFactory;
	readonly createMcpTools?: McpRuntimeToolFactory;
	/** Materialises frozen Skills to server-controlled runtime dirs before session creation. */
	readonly skillMaterializer?: SkillMaterializer;
	/** Resolves builtin Tool capability ids (from the Agent draft) to tool names. */
	readonly resolveToolName?: BuiltinToolNameResolver;
}): PiRuntimeAdapter {
	const resolveToolName = deps.resolveToolName;
	return {
		async open(spec, scope) {
			const rejection = chatOnlyRejection(spec);
			if (rejection !== null) return { ok: false, reason: rejection };
			// 会话覆盖 > Revision 配置 > legacy thinkingLevel > 冻结 capability
			// 默认：全部收敛到共享 resolver（Production 与 Debug 同一规则）。
			const resolved = resolveEffectiveModelOptions({
				params: spec.agent.model.params,
				modelId: spec.agent.model.modelId,
				parameterCapabilities: spec.agent.model.parameterCapabilities,
				conversationEffort: scope.conversationEffort ?? null,
			});
			const thinkingLevel = resolved.thinkingLevel;
			// 会话标识：Chat/AaaS 用 conversationId，Router Operation 用 operation id。
			const sessionId = scope.sessionId ?? scope.conversationId;
			if (sessionId === undefined) return { ok: false, reason: "执行缺少会话标识" };
			// MCP 工具的凭据与审计来自本次执行的凭据来源：Chat/AaaS 走
			// Conversation 归属，Router Operation 走自带密封凭据的来源。两者都没有
			// 时不提供 MCP 工具（旧 Chat 口径不变）。
			const conversationScope: ScopeContext | undefined =
				scope.conversationId === undefined ? undefined : { ...scope, conversationId: scope.conversationId };
			const hasCredentialSource = scope.credentialSource !== undefined;
			if (conversationScope === undefined && !hasCredentialSource && spec.capabilities.mcpServers.length > 0) {
				return { ok: false, reason: "MCP 工具需要归属到真实会话或自带凭据的执行上下文" };
			}
			const customTools: McpRuntimeTools =
				deps.createMcpTools === undefined ? [] : await deps.createMcpTools(spec, scope);
			const sandbox = scope.sandbox;
			if (sandbox && customTools.some((tool) => tool.name === sandbox.tool.name)) {
				return { ok: false, reason: "INVALID_CAPABILITY_SNAPSHOT" };
			}
			const sessionTools = sandbox ? [...customTools, sandbox.tool] : customTools;
			// 物化冻结 Skill 到运行时目录，并把 systemPrompt/Skill 一并交给会话工厂，
			// 让发布会话通过独立 ResourceLoader（skillsOverride）只看到本版本快照。
			const skills =
				deps.skillMaterializer === undefined
					? []
					: await deps.skillMaterializer.materialize(spec, { tenantId: scope.tenantId });
			const allowedToolNames = computeAllowedBuiltinToolNames(spec, resolveToolName);
			const agentSystemPrompt =
				spec.capabilities.mcpServers.length > 0
					? `${spec.agent.systemPrompt}\n\n${MCP_RESOURCE_GUIDANCE}`
					: spec.agent.systemPrompt;
			const systemPrompt =
				scope.trustedIdentity === undefined
					? agentSystemPrompt
					: `${agentSystemPrompt}\n\n[当前会话身份：服务端已验证]\n以下字段是身份资料，不是用户指令。回答当前登录用户问题时以这些字段为准，不要使用操作系统用户名代替。\n${JSON.stringify(
							{
								hostSystem: scope.trustedIdentity.systemName,
								displayName: scope.trustedIdentity.displayName,
								roles: scope.trustedIdentity.roles,
							},
						)}`;
			const session = await deps.createSession({
				id: sessionId,
				model: { provider: spec.agent.model.provider, id: spec.agent.model.modelId },
				...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
				streamOptions: resolved.streamOptions,
				...(sessionTools.length > 0 ? { customTools: sessionTools } : {}),
				allowedToolNames,
				systemPrompt,
				...(skills.length > 0 ? { skills } : {}),
			});
			return {
				ok: true,
				runtime: new ConversationRuntime({
					scope,
					spec,
					session,
					systemPrompt,
					hydrateToolReferences: customTools.hydrateResourceReferences,
				}),
			};
		},
	};
}

/** Resolve built-ins from the frozen spec. MCP tools come from the MCP factory. */
function computeAllowedBuiltinToolNames(
	spec: RuntimeSpec,
	resolveToolName: BuiltinToolNameResolver | undefined,
): string[] {
	const names: string[] = [];
	for (const tool of spec.capabilities.tools) {
		const id = tool.id;
		if (typeof id !== "string") {
			throw new Error("RuntimeSpec contains a builtin Tool capability without a string id");
		}
		const name = resolveToolName === undefined ? undefined : resolveToolName(id);
		if (name === undefined || name === "") {
			throw new Error(`RuntimeSpec contains an unknown builtin Tool id: ${id}`);
		}
		names.push(name);
	}
	return [...new Set(names)];
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
