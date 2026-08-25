/**
 * "最近调试" Tab（阶段一收口；MVP-05；阶段二 §4.1 提取为独立文件）。
 *
 * 这里**只**展示当前浏览器为该 Agent 记住的最近一次管理员调试入口，
 * 不展示历史日志，也不展示无法指导用户操作的内部 UUID。
 *
 * 设计取舍（M1）：
 *
 * - "继续上次调试"按钮只在有缓存会话时出现；点击跳到 Admin Chat。
 * - 当前 Chat 页路由不接受 `agentId` 形参，无法保证自动选中当前 Agent。
 *   因此按钮文案与说明明确"手动从下拉里选这个 Agent"。
 * - 没有缓存时给出空态：「该 Agent 在本浏览器还没有调试入口」+ 操作指引。
 *
 * 不展示：内部 sessionId UUID、企业用户会话（属于"用户会话"模块）。
 */
import type { AgentPublicId } from "@earendil-works/pi-protocol";
import { useEffect, useState } from "react";
import { createDebugSessionStore } from "../conversation/debug-session-store.ts";
import { navigate } from "../router.ts";

export interface AgentDebugTabProps {
	readonly agentId: AgentPublicId;
}

export function AgentDebugTab({ agentId }: AgentDebugTabProps): React.ReactElement {
	const [sessionId, setSessionId] = useState<string | null>(null);
	useEffect(() => {
		const store = createDebugSessionStore();
		setSessionId(store.get(agentId));
		return () => {
			// ephemeral store instance; no persistent handles to release.
		};
	}, [agentId]);

	const goToChat = () => navigate("/chat");
	const hasSession = sessionId !== null;

	return (
		<section className="debug-records" aria-label="最近调试">
			<header>
				<h3>最近调试</h3>
				<p className="debug-records__hint">
					这里只显示当前浏览器为本 Agent 记住的最近一次管理员调试入口，不是历史日志，也不是用户侧会话。
				</p>
			</header>
			{hasSession ? (
				<div className="debug-records__panel" data-state="has-session">
					<p>你最近在这个浏览器里调试过这个 Agent。</p>
					<p className="debug-records__caveat">
						管理台 Chat 路由暂不接收 agentId 参数，进入后请从 Agent 下拉里手动选择本 Agent。
					</p>
					<button type="button" onClick={goToChat}>
						继续调试（进入管理台 Chat）
					</button>
				</div>
			) : (
				<div className="debug-records__panel" data-state="empty">
					<p>该 Agent 在本浏览器还没有调试入口。</p>
					<p className="debug-records__caveat">
						请到「对话」页手动选择本 Agent 开启一次调试；之后这里会显示返回入口。
					</p>
					<button type="button" onClick={goToChat}>
						打开管理台 Chat
					</button>
				</div>
			)}
		</section>
	);
}