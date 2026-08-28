import type {
	AgentMcpRevisionReference,
	AgentSkillRevisionReference,
	McpServerDetail,
	SkillSummary,
} from "@earendil-works/pi-protocol";
import styles from "./agent-extensions-section.module.css";

export interface AgentExtensionCatalog {
	readonly skills: readonly SkillSummary[];
	readonly mcpServers: readonly McpServerDetail[];
}

export function AgentExtensionsSection({
	catalog,
	skills,
	mcpServers,
	onSkillsChange,
	onMcpServersChange,
	loading,
	error,
}: {
	readonly catalog: AgentExtensionCatalog;
	readonly skills: readonly AgentSkillRevisionReference[];
	readonly mcpServers: readonly AgentMcpRevisionReference[];
	readonly onSkillsChange: (value: readonly AgentSkillRevisionReference[]) => void;
	readonly onMcpServersChange: (value: readonly AgentMcpRevisionReference[]) => void;
	readonly loading: boolean;
	readonly error?: string;
}): React.ReactElement {
	const missingSkills = skills.filter((binding) => !catalog.skills.some((item) => item.id === binding.skillId));
	const missingMcp = mcpServers.filter(
		(binding) => !catalog.mcpServers.some((item) => item.id === binding.mcpServerId),
	);
	return (
		<section className={styles.section} aria-label="扩展能力">
			<div className={styles.heading}>
				<div>
					<h2>扩展能力</h2>
					<p>选择 Agent 需要接入的 Skill 和 MCP Server。</p>
				</div>
				<span>
					{skills.length} Skills · {mcpServers.length} MCP
				</span>
			</div>
			{loading ? <p className={styles.notice}>正在加载扩展目录…</p> : null}
			{error ? (
				<p className={styles.error} role="alert">
					扩展目录加载失败：{error}
				</p>
			) : null}
			<div className={styles.columns}>
				<div>
					<h3>Skills</h3>
					{catalog.skills.map((item) => {
						const binding = skills.find((value) => value.skillId === item.id);
						return (
							<label className={styles.card} key={item.id}>
								<input
									type="checkbox"
									checked={binding !== undefined}
									disabled={!item.enabled && binding === undefined}
									onChange={(event) =>
										onSkillsChange(
											event.currentTarget.checked
												? [...skills, { skillId: item.id, revision: item.currentRevision }]
												: skills.filter((value) => value.skillId !== item.id),
										)
									}
								/>
								<span>
									<b>{item.name}</b>
									<small>
										{item.enabled ? "可用" : "已停用"} · Revision {binding?.revision ?? item.currentRevision}
									</small>
								</span>
							</label>
						);
					})}
					{missingSkills.map((binding) => (
						<label className={styles.card} key={binding.skillId}>
							<input
								type="checkbox"
								checked
								onChange={() => onSkillsChange(skills.filter((value) => value.skillId !== binding.skillId))}
							/>
							<span>
								<b>{binding.skillId}</b>
								<small>目录中不可用 · Revision {binding.revision}</small>
							</span>
						</label>
					))}
					{!loading && catalog.skills.length === 0 && missingSkills.length === 0 ? (
						<p className={styles.empty}>暂无 Skill</p>
					) : null}
				</div>
				<div>
					<h3>MCP Servers</h3>
					{catalog.mcpServers.map((server) => {
						const binding = mcpServers.find((value) => value.mcpServerId === server.id);
						const currentRevision = server.revisions.find((value) => value.revision === server.currentRevision);
						return (
							<label className={styles.card} key={server.id}>
								<input
									type="checkbox"
									checked={binding !== undefined}
									disabled={server.status !== "enabled" && binding === undefined}
									onChange={(event) =>
										onMcpServersChange(
											event.currentTarget.checked
												? [
														...mcpServers,
														{
															mcpServerId: server.id,
															revision: server.currentRevision,
															toolNames: currentRevision?.tools.map((tool) => tool.name) ?? [],
														},
													]
												: mcpServers.filter((value) => value.mcpServerId !== server.id),
										)
									}
								/>
								<span>
									<b>{server.name}</b>
									<small>{server.status === "enabled" ? "可接入" : "已停用"}</small>
								</span>
							</label>
						);
					})}
					{missingMcp.map((binding) => (
						<label className={styles.card} key={binding.mcpServerId}>
							<input
								type="checkbox"
								checked
								onChange={() =>
									onMcpServersChange(mcpServers.filter((value) => value.mcpServerId !== binding.mcpServerId))
								}
							/>
							<span>
								<b>{binding.mcpServerId}</b>
								<small>目录中不可用</small>
							</span>
						</label>
					))}
					{!loading && catalog.mcpServers.length === 0 && missingMcp.length === 0 ? (
						<p className={styles.empty}>暂无 MCP Server</p>
					) : null}
				</div>
			</div>
		</section>
	);
}
