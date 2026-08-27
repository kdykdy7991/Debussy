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
					<p>绑定固定版本；MCP 仅开放勾选的 Tools。</p>
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
						const revision =
							server.revisions.find((value) => value.revision === binding?.revision) ??
							server.revisions.find((value) => value.revision === server.currentRevision);
						return (
							<div className={styles.mcpCard} key={server.id}>
								<label className={styles.card}>
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
																toolNames: [],
															},
														]
													: mcpServers.filter((value) => value.mcpServerId !== server.id),
											)
										}
									/>
									<span>
										<b>{server.name}</b>
										<small>{server.status === "enabled" ? "全局可用" : "全局停用"}</small>
									</span>
								</label>
								{binding ? (
									<div className={styles.mcpOptions}>
										<label>
											固定 Revision{" "}
											<select
												value={binding.revision}
												onChange={(event) =>
													onMcpServersChange(
														mcpServers.map((value) =>
															value.mcpServerId === server.id
																? {
																		...value,
																		revision: Number(event.currentTarget.value),
																		toolNames: [],
																	}
																: value,
														),
													)
												}
											>
												{server.revisions.map((item) => (
													<option value={item.revision} key={item.revision}>
														Revision {item.revision}
														{item.revision === server.currentRevision ? "（当前）" : ""}
													</option>
												))}
											</select>
										</label>
										<div className={styles.tools}>
											<strong>Tool allowlist</strong>
											{revision?.tools.map((tool) => (
												<label key={tool.name}>
													<input
														type="checkbox"
														checked={binding.toolNames.includes(tool.name)}
														onChange={(event) =>
															onMcpServersChange(
																mcpServers.map((value) =>
																	value.mcpServerId === server.id
																		? {
																				...value,
																				toolNames: event.currentTarget.checked
																					? [...value.toolNames, tool.name]
																					: value.toolNames.filter((name) => name !== tool.name),
																			}
																		: value,
																),
															)
														}
													/>
													{tool.name}
												</label>
											))}
											{revision?.tools.length === 0 ? <small>该 Revision 暂无 Tools</small> : null}
										</div>
									</div>
								) : null}
							</div>
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
								<small>
									目录中不可用 · Revision {binding.revision} · {binding.toolNames.length} Tools
								</small>
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
