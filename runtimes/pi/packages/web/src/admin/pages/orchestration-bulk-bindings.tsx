import type { OrchestrationCatalog, ToolCredentialBinding } from "@earendil-works/pi-protocol";
import { useState } from "react";
import { AuroraButton } from "../aurora/Button.tsx";
import styles from "./orchestration-page.module.css";

type CatalogTool = OrchestrationCatalog["applications"][number]["tools"][number];

export function OrchestrationBulkBindings({
	tools,
	onApply,
}: {
	tools: readonly CatalogTool[];
	onApply: (bindings: ToolCredentialBinding[]) => boolean;
}): React.JSX.Element {
	const servers = [...new Map(tools.map((tool) => [tool.mcpServerId, tool.serverName])).entries()];
	const [serverId, setServerId] = useState(servers.length === 1 ? servers[0]![0] : ""),
		[parameter, setParameter] = useState("");
	const [credential, setCredential] = useState("ticketApiKey"),
		[selected, setSelected] = useState<string[]>([]),
		[notice, setNotice] = useState("");
	const serverTools = tools.filter((tool) => tool.mcpServerId === serverId);
	const parameters = [...new Set(serverTools.flatMap((tool) => tool.credentialParameters))];
	const eligible = serverTools.filter((tool) => tool.credentialParameters.includes(parameter));
	const chosen = eligible.filter((tool) => selected.includes(tool.name));
	const validName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(credential);
	return (
		<section className={styles.bulkBindings} aria-label="批量配置工具凭据">
			<div className={styles.sectionHeading}>
				<h3>批量配置</h3>
				<p>同一个用户 Token 可供多个工具共用，工单端每次只需传一次。</p>
			</div>
			<label className={styles.field}>
				MCP 服务
				<select
					aria-label="批量配置的 MCP 服务"
					value={serverId}
					onChange={(event) => {
						setServerId(event.target.value);
						setParameter("");
						setSelected([]);
						setNotice("");
					}}
				>
					<option value="">请选择 MCP 服务</option>
					{servers.map(([id, name]) => (
						<option key={id} value={id}>
							{name}
						</option>
					))}
				</select>
			</label>
			<div className={styles.twoColumns}>
				<label className={styles.field}>
					工具中的密钥参数
					<select
						aria-label="批量配置的密钥参数"
						disabled={!parameters.length}
						value={parameter}
						onChange={(event) => {
							const value = event.target.value;
							setParameter(value);
							setSelected(
								serverTools
									.filter((tool) => tool.credentialParameters.includes(value))
									.map((tool) => tool.name),
							);
							setNotice("");
						}}
					>
						<option value="">请选择参数</option>
						{parameters.map((name) => (
							<option key={name} value={name}>
								{name}（{serverTools.filter((tool) => tool.credentialParameters.includes(name)).length} 个工具）
							</option>
						))}
					</select>
				</label>
				<label className={styles.field}>
					工单端传入的凭据名称
					<input
						aria-label="批量配置的凭据名称"
						value={credential}
						onChange={(event) => {
							setCredential(event.target.value);
							setNotice("");
						}}
						aria-invalid={!validName}
					/>
				</label>
			</div>
			{!validName && (
				<p className={styles.error} role="alert">
					凭据名称只能使用英文字母、数字和下划线，且不能以数字开头。
				</p>
			)}
			{serverId && !parameters.length && <p className={styles.muted}>此服务的已发布工具没有支持绑定的参数。</p>}
			{parameter && (
				<>
					<label className={styles.checkboxLine}>
						<input
							type="checkbox"
							aria-label="全选适用工具"
							checked={eligible.length > 0 && chosen.length === eligible.length}
							ref={(node) => {
								if (node) node.indeterminate = chosen.length > 0 && chosen.length < eligible.length;
							}}
							onChange={(event) => {
								setSelected(event.target.checked ? eligible.map((tool) => tool.name) : []);
								setNotice("");
							}}
						/>
						全选适用工具
						<span className={styles.muted}>
							已选 {chosen.length} / {eligible.length}
						</span>
					</label>
					<div className={styles.bulkTools}>
						{serverTools.map((tool) => {
							const supported = tool.credentialParameters.includes(parameter);
							return (
								<label key={tool.name} className={styles.checkboxLine}>
									<input
										type="checkbox"
										aria-label={`批量工具 ${tool.name}`}
										disabled={!supported}
										checked={supported && selected.includes(tool.name)}
										onChange={(event) => {
											setSelected((previous) =>
												event.target.checked
													? [...previous, tool.name]
													: previous.filter((name) => name !== tool.name),
											);
											setNotice("");
										}}
									/>
									<code>{tool.name}</code>
									{!supported && <small>无此可绑定参数</small>}
								</label>
							);
						})}
					</div>
				</>
			)}
			<p className={styles.muted}>应用后更新所选工具的同名参数映射，其他映射保留。新增工具需重新选择应用。</p>
			<AuroraButton
				disabled={!chosen.length || !validName}
				onClick={() => {
					if (
						onApply(chosen.map((tool) => ({ mcpServerId: serverId, toolName: tool.name, parameter, credential })))
					)
						setNotice(`已应用到 ${chosen.length} 个工具，共用 ${credential}。`);
				}}
			>
				应用到 {chosen.length} 个工具
			</AuroraButton>
			{notice && <output className={styles.success}>{notice}</output>}
		</section>
	);
}
