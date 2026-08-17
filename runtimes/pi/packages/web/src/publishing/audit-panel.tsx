/**
 * Audit panel — recent management events for an app (PUBLISHING-ADMIN-CONSOLE §5.4).
 *
 * Bounded metadata only: never Token / PEM / visitorId / externalUserId / prompt.
 */
import type { PublishingController } from "./publishing-controller.ts";

export interface AuditPanelProps {
	readonly controller: PublishingController;
}

export function AuditPanel({ controller }: AuditPanelProps) {
	const snapshot = useSnapshot(controller);
	if (snapshot.audits.length === 0) {
		return (
			<div className="pub-card">
				<p style={{ color: "var(--pub-fg-muted)" }}>暂无审计事件。</p>
			</div>
		);
	}
	return (
		<div className="pub-card">
			<h2>审计事件</h2>
			<table className="audit-table">
				<thead>
					<tr>
						<th>时间</th>
						<th>动作</th>
						<th>资源</th>
						<th>requestId</th>
						<th>metadata</th>
					</tr>
				</thead>
				<tbody>
					{snapshot.audits.map((event) => (
						<tr key={event.id}>
							<td>{new Date(event.createdAt).toLocaleString()}</td>
							<td>
								<strong>{event.action}</strong>
							</td>
							<td>
								<small style={{ color: "var(--pub-fg-muted)" }}>
									{event.resourceType}/{event.actorType}
								</small>
							</td>
							<td>
								<code style={{ fontSize: 11 }}>{event.requestId}</code>
							</td>
							<td>
								<details>
									<summary>展开</summary>
									<pre
										style={{
											background: "var(--pub-bg)",
											padding: 8,
											fontSize: 11,
											maxWidth: 360,
											overflow: "auto",
										}}
									>
										{JSON.stringify(event.metadata, null, 2)}
									</pre>
								</details>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function useSnapshot(controller: PublishingController) {
	return controller.getSnapshot();
}
