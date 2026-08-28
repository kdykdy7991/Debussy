/**
 * Agent 调试 Tab。
 *
 * 调试会话是短生命周期资源，关闭、切换 Agent 或超时后销毁；此页不保存
 * sessionId、消息或历史记录。需要保留的调试应由用户显式导出为测试用例。
 */
import type { AgentPublicId } from "@earendil-works/pi-protocol";
import { AuroraButton } from "../aurora/index.ts";
import { navigate } from "../router.ts";
import styles from "./agent-tables.module.css";

export interface AgentDebugTabProps {
	readonly agentId: AgentPublicId;
}

export function AgentDebugTab({ agentId }: AgentDebugTabProps): React.ReactElement {
	const goToChat = () => navigate(`/chat?agentId=${encodeURIComponent(agentId)}`);

	return (
		<section className={styles.shell} aria-label="调试">
			<div className={styles.appsEmpty} data-state="empty">
				<strong>开始一个临时调试会话。</strong>
				<p>关闭、切换 Agent 或闲置超时后会销毁。需要保留时，请显式导出为测试用例。</p>
				<AuroraButton variant="default" size="md" onClick={goToChat}>
					打开管理台 Chat
				</AuroraButton>
			</div>
		</section>
	);
}
