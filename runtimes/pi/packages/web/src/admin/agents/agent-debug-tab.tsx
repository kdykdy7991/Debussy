/**
 * "最近调试" Tab（阶段三：Aurora UI 统一）。
 *
 * 这里**只**展示当前浏览器为该 Agent 记住的最近一次管理员调试入口，
 * 不展示历史日志，也不展示无法指导用户操作的内部 UUID。
 *
 * 不展示：内部 sessionId UUID、企业用户会话（属于"用户会话"模块）。
 */
import type { AgentPublicId } from "@earendil-works/pi-protocol";
import { useEffect, useState } from "react";
import { AgentApi, AgentApiError } from "../api/agent-api.ts";
import { AuroraButton } from "../aurora/index.ts";
import { createDebugSessionStore } from "../conversation/debug-session-store.ts";
import { navigate } from "../router.ts";
import styles from "./agent-tables.module.css";

export interface AgentDebugTabProps {
	readonly agentId: AgentPublicId;
	readonly api?: AgentApi;
}

export function AgentDebugTab({ agentId, api }: AgentDebugTabProps): React.ReactElement {
	const [sessionId, setSessionId] = useState<string | null>(null);
	useEffect(() => {
		const store = createDebugSessionStore();
		setSessionId(store.get(agentId));
	}, [agentId]);

	const goToChat = () => navigate("/chat");
	const hasSession = sessionId !== null;

	return (
		<section className={styles.shell} aria-label="最近调试">
			<div className={hasSession ? styles.appsEmpty : styles.appsEmpty} data-state={hasSession ? "has-session" : "empty"}>
				<strong>{hasSession ? "你最近在这个浏览器里调试过这个 Agent。" : "该 Agent 在本浏览器还没有调试入口。"}</strong>
				<p>
					{hasSession
						? "管理台 Chat 路由暂不接收 agentId 参数，进入后请从 Agent 下拉里手动选择本 Agent。"
						: "请到「对话」页手动选择本 Agent 开启一次调试；之后这里会显示返回入口。"}
				</p>
				<AuroraButton variant="default" size="md" onClick={goToChat}>
					{hasSession ? "继续调试（进入管理台 Chat）" : "打开管理台 Chat"}
				</AuroraButton>
			</div>
		</section>
	);
}