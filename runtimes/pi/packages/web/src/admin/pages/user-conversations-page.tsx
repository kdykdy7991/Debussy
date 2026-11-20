import { AdminConversationsIndexView } from "../aurora/conversations-index-view.tsx";
import { AuroraPillTabs } from "../aurora/PillTabs.tsx";
import { type AdminRoute, navigate } from "../router.ts";
import { AdminConversationDetail } from "../user-conversations/conversation-detail.tsx";
import { AdminLegacyIntegrationPanel } from "./legacy-integration-panel.tsx";
import styles from "./orchestration-page.module.css";
import { RouterExecutionDetail } from "./router-execution-detail.tsx";
import { AdminRouterExecutionsPage } from "./router-executions-page.tsx";

const executionSources = [
	{ value: "/conversations", label: "Chat" },
	{ value: "/conversations/integration", label: "Integration Run" },
	{ value: "/conversations/router", label: "Router" },
] as const;

export function AdminUserConversationsPage({ route }: { route: AdminRoute }): React.JSX.Element {
	if (route.id === "user-conversation-detail") {
		const conversationId = route.params.conversationId;
		if (conversationId === undefined) return <p role="alert">缺少 conversationId</p>;
		return <AdminConversationDetail conversationId={conversationId} />;
	}
	const { keyId, taskId, operationId } = route.params;
	if (route.id === "router-executions" && keyId && taskId && operationId) {
		return (
			<RouterExecutionDetail key={`${keyId}:${taskId}`} keyId={keyId} taskId={taskId} operationId={operationId} />
		);
	}
	const source =
		route.id === "orchestration"
			? "/conversations/integration"
			: route.id === "router-executions"
				? "/conversations/router"
				: "/conversations";
	const navigation = (
		<AuroraPillTabs
			ariaLabel="执行来源"
			items={executionSources}
			value={route.id === "aaas-executions" ? "" : source}
			onChange={navigate}
		/>
	);
	if (route.id === "user-conversations" || route.id === "aaas-executions") {
		return (
			<AdminConversationsIndexView
				key={source}
				source={route.id === "aaas-executions" ? "aaas_key" : "chat"}
				navigation={navigation}
			/>
		);
	}
	return (
		<>
			<div className={styles.sectionNav}>{navigation}</div>
			{route.id === "orchestration" ? (
				<AdminLegacyIntegrationPanel key="executions" />
			) : (
				<AdminRouterExecutionsPage key={keyId ?? "all"} keyId={keyId} />
			)}
		</>
	);
}
