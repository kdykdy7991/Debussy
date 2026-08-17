/**
 * DebugSession 恢复存储（WB-003 / SPEC §5.1 / §5.2）。
 *
 * 每个 Agent 保留最近一次管理员调试对话的 sessionId。切换 Agent 时：
 *
 * - 记录当前会话 → 映射到当前 agentId
 * - 取出新 agentId 的最近会话；如有，恢复（业务侧用 SessionController 打开）
 * - 不存 token / 不存消息体（只存 sessionId）；sessionStorage 不参与敏感数据
 *
 * 刷新后通过 sessionStorage 恢复映射（sessionStorage 是非敏感元数据；规格
 * 9.1 仅禁止 token / 明文标识进入 Storage）。
 */
import type { AgentPublicId } from "@earendil-works/pi-protocol";

const STORAGE_KEY = "admin-workbench:debug-session-map";

type Mapping = Partial<Record<AgentPublicId, string>>;

function readFromStorage(): Mapping {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.sessionStorage.getItem(STORAGE_KEY);
		if (raw === null) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (parsed === null || typeof parsed !== "object") return {};
		return parsed as Mapping;
	} catch {
		return {};
	}
}

function writeToStorage(mapping: Mapping): void {
	if (typeof window === "undefined") return;
	try {
		window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(mapping));
	} catch {
		// sessionStorage may be disabled; fall back silently.
	}
}

export interface DebugSessionStore {
	get(agentId: AgentPublicId): string | null;
	set(agentId: AgentPublicId, sessionId: string): void;
	clear(agentId: AgentPublicId): void;
	all(): Mapping;
}

export function createDebugSessionStore(): DebugSessionStore {
	let mapping: Mapping = readFromStorage();
	const persist = () => writeToStorage(mapping);
	return {
		get(agentId) {
			return mapping[agentId] ?? null;
		},
		set(agentId, sessionId) {
			mapping = { ...mapping, [agentId]: sessionId };
			persist();
		},
		clear(agentId) {
			const next: Mapping = { ...mapping };
			delete next[agentId];
			mapping = next;
			persist();
		},
		all() {
			return { ...mapping };
		},
	};
}
