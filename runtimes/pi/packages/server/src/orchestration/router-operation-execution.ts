/**
 * Router Operation 归属的一次执行（R010 第一部分）。
 *
 * 该入口只做一件事：把「一次 Pi 执行」归属到一个 Router Operation。
 *
 * - 不创建 Conversation、Work Item 或 Assignment，也不写任何 Router 业务表；
 * - 直接复用 Pi 的**内存会话**能力：会话 id 就是 operation id，执行结束即关闭；
 * - 执行语义（进度、取消、执行截止、结果与用量提取）全部来自共享入口
 *   `runtime/pi-execution.ts`，与 Chat/AaaS 同源。
 *
 * MCP 工具使用本次执行的凭据来源。调度、占用清理和数据库写入由调用方负责。
 */
import type { TranscriptProgress } from "@earendil-works/pi-protocol";
import type { PrincipalId, TenantId } from "../publishing/domain/ids.ts";
import type { RuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import { createPiExecutionEntry, type PiExecutionContext, type PiExecutionOutcome } from "../runtime/pi-execution.ts";
import type { ConversationRuntime } from "../runtime/conversation-runtime.ts";
import type { McpCallAuditRecord } from "../runtime/execution-source.ts";
import type { PiRuntimeAdapter } from "../runtime/pi-runtime-adapter.ts";
import {
	openSandbox,
	type SandboxConfig,
	type SandboxExecution,
	type SandboxExecutionResult,
	type SandboxPolicy,
} from "../runtime/sandbox.ts";
import type { RuntimeScope, ScopeContext } from "../runtime/scope-context.ts";
import type { LlmCallTrace } from "../types.ts";
import { EXECUTION_NOT_AUTHORIZED, McpRunGuard } from "./api-key-boundary.ts";
import type { WorkCredentialBox } from "./credentials.ts";
import {
	createRouterExecutionSource,
	type RouterOperationSealedCredentials,
} from "./router-operation-credentials.ts";

export interface RouterOperationExecutionRequest {
	/** Router Operation 标识；同时作为内存会话 id。 */
	readonly operationId: string;
	readonly tenantId: TenantId;
	readonly principalId: PrincipalId;
	/** 冻结的执行版本键（不是 Conversation 外键）。 */
	readonly publishedAppVersionId: string;
	/** 冻结的 Runtime 配置。 */
	readonly spec: RuntimeSpec;
	readonly sandboxPolicy?: SandboxPolicy;
	/** 用户输入正文。 */
	readonly input: string;
	/** 冻结的结构化上下文。 */
	readonly context?: PiExecutionContext;
	readonly onProgress?: (progress: TranscriptProgress) => void;
	readonly onLlmTrace?: (trace: LlmCallTrace) => Promise<void>;
	readonly onSandboxResult?: (result: SandboxExecutionResult) => void;
	/** Report a failed resource close to the owner of the durable occupancy. */
	readonly onCleanupUnconfirmed?: (cause: unknown) => void;
	/** 取消信号：到达后底层 Pi 被中止，结果为 cancelled。 */
	readonly signal?: AbortSignal;
	/** 执行截止（毫秒）。 */
	readonly deadlineMs?: number;
	/** 服务端已验证的执行身份。 */
	readonly trustedIdentity?: ScopeContext["trustedIdentity"];
	/** 执行限额（来自 Operation 冻结的能力快照）。 */
	readonly limits: ScopeContext["limits"];
	/**
	 * 本次请求的密封工具业务凭据。MCP 连接凭据从平台管理中心读取。
	 */
	readonly credentials?: RouterOperationSealedCredentials;
	/** Required for MCP; success authorizes the next network dispatch for this Operation. */
	readonly authorizeMcpCall?: () => Promise<void>;
}

/** Router Operation 归属的执行器。 */
export interface RouterOperationExecutor {
	execute(request: RouterOperationExecutionRequest): Promise<PiExecutionOutcome>;
	/** 取消一次正在执行的 Operation；返回是否命中。 */
	cancel(operationId: string): Promise<boolean>;
}

export function createRouterOperationExecutor(deps: {
	readonly adapter: PiRuntimeAdapter;
	readonly sandboxConfig?: SandboxConfig;
	/** 共享执行入口；缺省时自建一个（测试可注入同一个实例观察取消）。 */
	readonly entry?: ReturnType<typeof createPiExecutionEntry>;
	/** Opens the sealed credentials of one Operation. */
	readonly credentialBox?: WorkCredentialBox;
	/** Fatal boundary marker of the Operation. */
	readonly guard?: McpRunGuard;
	/** Audit sink of the Operation (the database write lands with the Operation row). */
	readonly recordAudit?: (record: McpCallAuditRecord) => Promise<void>;
}): RouterOperationExecutor {
	const entry = deps.entry ?? createPiExecutionEntry();
	const active = new Map<string, AbortController>();
	return {
		async execute(request) {
			const { operationId } = request;
			if (request.signal?.aborted) return { status: "cancelled", outputText: "" };
			if (active.has(operationId)) return { status: "failed", error: "Operation 已在执行" };
			const controller = new AbortController();
			active.set(operationId, controller);
			const signal = request.signal
				? AbortSignal.any([request.signal, controller.signal])
				: controller.signal;
			const guard = deps.guard ?? new McpRunGuard();
			const releaseFatal = guard.onFatal(operationId, () => controller.abort());
			let runtime: ConversationRuntime | undefined;
			let sandbox: SandboxExecution | undefined;
			try {
				const hasMcp = request.spec.capabilities.mcpServers.length > 0;
				const { credentialBox } = deps;
				const { authorizeMcpCall } = request;
				if (hasMcp && (credentialBox === undefined || authorizeMcpCall === undefined))
					return { status: "failed", error: EXECUTION_NOT_AUTHORIZED };
				const credentialSource =
					hasMcp && credentialBox !== undefined && authorizeMcpCall !== undefined
						? createRouterExecutionSource({
								operationId,
								tenantId: request.tenantId,
								credentials: request.credentials ?? {},
								box: credentialBox,
								guard,
								authorizeMcpCall,
								signal,
								...(deps.recordAudit !== undefined ? { recordAudit: deps.recordAudit } : {}),
								maxBytes: request.limits.toolResultMaxBytes,
							})
						: undefined;
				if (request.sandboxPolicy) {
					sandbox = await openSandbox(deps.sandboxConfig, request.sandboxPolicy, signal, request.onSandboxResult);
				}
				const scope: RuntimeScope = {
					tenantId: request.tenantId,
					publishedAppId: null,
					publishedAppVersionId: request.publishedAppVersionId,
					principalId: request.principalId,
					limits: request.limits,
					sessionId: operationId,
					...(sandbox !== undefined ? { sandbox } : {}),
					...(request.trustedIdentity !== undefined ? { trustedIdentity: request.trustedIdentity } : {}),
					...(credentialSource !== undefined ? { credentialSource } : {}),
				};
				const opened = await deps.adapter.open(request.spec, scope);
				if (opened.ok) runtime = opened.runtime;
				if (signal.aborted) return { status: "cancelled", outputText: "" };
				if (!opened.ok) return { status: "failed", error: opened.reason };
				const outcome = await entry.execute(opened.runtime, {
					identity: { kind: "router_operation", operationId },
					input: request.input,
					...(request.context !== undefined ? { context: request.context } : {}),
					onProgress: request.onProgress,
					onLlmTrace: request.onLlmTrace,
					signal,
					...(request.deadlineMs !== undefined ? { deadlineMs: request.deadlineMs } : {}),
				});
				const fatal = guard.take(operationId) ?? sandbox?.failure;
				if (fatal === undefined) return outcome;
				return {
					status: "failed",
					error: fatal,
					...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
					...(outcome.llmUsage !== undefined ? { llmUsage: outcome.llmUsage } : {}),
				};
			} catch (error) {
				if (signal.aborted) return { status: "cancelled", outputText: "" };
				return { status: "failed", error: error instanceof Error ? error.message : String(error) };
			} finally {
				releaseFatal();
				guard.clear(operationId);
				controller.abort();
				const cleanup = await Promise.allSettled([sandbox?.close(), runtime?.close()]);
				active.delete(operationId);
				for (const result of cleanup) {
					if (result.status === "rejected") request.onCleanupUnconfirmed?.(result.reason);
				}
			}
		},
		async cancel(operationId) {
			const controller = active.get(operationId);
			if (controller === undefined || controller.signal.aborted) return false;
			controller.abort();
			return true;
		},
	};
}
