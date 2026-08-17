/**
 * Three-step create-app wizard (ADMIN-005 / PUBLISHING-ADMIN-CONSOLE §5.3).
 *
 * Step 1: pick agent + revision (or import a fresh one).
 * Step 2: name + accessMode + allowedOrigins (one per line) + theme + welcome.
 * Step 3: preview + confirm.
 *
 * Each step has independent error / retry; partial completion (e.g. agent
 * exists but version rejected) is allowed and surfaced via the success page.
 */
import { useEffect, useState } from "react";
import type { PublishingController } from "./publishing-controller.ts";
import { ACCESS_MODES, type AccessModeValue } from "./types.ts";

export interface CreateAppWizardProps {
	readonly controller: PublishingController;
	readonly onCancel: () => void;
	readonly onPublished: (appId: string, versionId: string) => void;
}

type Step = 1 | 2 | 3;

export function CreateAppWizard({ controller, onCancel, onPublished }: CreateAppWizardProps) {
	const snapshot = useSnapshot(controller);
	const [step, setStep] = useState<Step>(1);
	const [agentId, setAgentId] = useState<string>("");
	const [revision, setRevision] = useState<number>(0);
	const [name, setName] = useState<string>("");
	const [accessMode, setAccessMode] = useState<AccessModeValue>("anonymous");
	const [originsText, setOriginsText] = useState<string>("http://localhost:5173");
	const [primaryColor, setPrimaryColor] = useState<string>("");
	const [welcomeMessage, setWelcomeMessage] = useState<string>("");
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);

	useEffect(() => {
		if (step === 1 && snapshot.agents.length === 0 && !snapshot.agentsLoading) {
			void controller.refreshAgents();
		}
	}, [step, snapshot.agents.length, snapshot.agentsLoading, controller]);

	const selectedAgent = snapshot.agents.find((agent) => agent.id === agentId);

	useEffect(() => {
		if (selectedAgent) setRevision(selectedAgent.revision);
	}, [selectedAgent]);

	const origins = originsText
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");

	const submit = async () => {
		setSubmitting(true);
		setSubmitError(null);
		try {
			const result = await controller.createAppAndVersion({
				agentDefinitionId: agentId,
				sourceAgentRevision: revision,
				name: name.trim(),
				accessMode,
				allowedOrigins: origins,
				theme: {
					...(primaryColor.trim() === "" ? {} : { primaryColor: primaryColor.trim() }),
					...(welcomeMessage.trim() === "" ? {} : { welcomeMessage: welcomeMessage.trim() }),
				},
			});
			if (result !== null) onPublished(result.appId, result.versionId);
		} catch (error) {
			setSubmitError(error instanceof Error ? error.message : String(error));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="wizard">
			<ol className="wizard-steps">
				<li className={`wizard-step ${step === 1 ? "active" : step > 1 ? "done" : ""}`}>
					<span className="index">1</span>选择 Agent
				</li>
				<li className={`wizard-step ${step === 2 ? "active" : step > 2 ? "done" : ""}`}>
					<span className="index">2</span>应用配置
				</li>
				<li className={`wizard-step ${step === 3 ? "active" : ""}`}>
					<span className="index">3</span>确认
				</li>
			</ol>

			{step === 1 ? (
				<div className="pub-card">
					<h2>选择 Agent 和 revision</h2>
					{snapshot.agentsLoading ? (
						<p>加载 Agent…</p>
					) : snapshot.agents.length === 0 ? (
						<div className="banner warning">尚无 Agent revision。点击下方按钮导入当前 Agent。</div>
					) : (
						<>
							<label>
								<span>Agent</span>
								<select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
									<option value="">— 选择 Agent —</option>
									{snapshot.agents.map((agent) => (
										<option value={agent.id} key={agent.id}>
											{agent.name} (rev {agent.revision})
										</option>
									))}
								</select>
							</label>
							<label>
								<span>Revision</span>
								<input
									type="number"
									min={1}
									value={revision || ""}
									onChange={(event) => setRevision(Number(event.target.value))}
								/>
								<small className="hint">
									{snapshot.agents.find((agent) => agent.id === agentId)?.sourceHash.slice(0, 16) ?? ""}
								</small>
							</label>
						</>
					)}
					<div className="step-actions">
						<button className="pub-btn ghost" type="button" onClick={onCancel}>
							取消
						</button>
						<button
							className="pub-btn"
							type="button"
							onClick={() => controller.importCurrentAgent()}
							disabled={controller.isInflight("agents.import")}
						>
							{controller.isInflight("agents.import") ? "导入中…" : "导入当前 Agent"}
						</button>
						<button
							className="pub-btn primary"
							type="button"
							onClick={() => setStep(2)}
							disabled={!selectedAgent || revision <= 0}
						>
							下一步
						</button>
					</div>
				</div>
			) : null}

			{step === 2 ? (
				<div className="pub-card">
					<h2>应用配置</h2>
					<label>
						<span>应用名称</span>
						<input value={name} onChange={(event) => setName(event.target.value)} placeholder="My App" />
					</label>
					<label>
						<span>访问模式</span>
						<select value={accessMode} onChange={(event) => setAccessMode(event.target.value as AccessModeValue)}>
							{ACCESS_MODES.map((mode) => (
								<option key={mode} value={mode}>
									{mode}
								</option>
							))}
						</select>
					</label>
					<label>
						<span>允许 Origin（每行一个）</span>
						<textarea
							value={originsText}
							onChange={(event) => setOriginsText(event.target.value)}
							placeholder="https://example.com"
						/>
						<small className="hint">服务端校验是唯一真相；非法 Origin 不会被改写。</small>
					</label>
					<label>
						<span>主题色（可选）</span>
						<input
							value={primaryColor}
							onChange={(event) => setPrimaryColor(event.target.value)}
							placeholder="#2563eb"
						/>
					</label>
					<label>
						<span>欢迎语（可选）</span>
						<textarea value={welcomeMessage} onChange={(event) => setWelcomeMessage(event.target.value)} />
					</label>
					<div className="step-actions">
						<button className="pub-btn ghost" type="button" onClick={() => setStep(1)}>
							上一步
						</button>
						<button className="pub-btn primary" type="button" onClick={() => setStep(3)} disabled={!name.trim()}>
							下一步
						</button>
					</div>
				</div>
			) : null}

			{step === 3 ? (
				<div className="pub-card">
					<h2>预览并确认</h2>
					<pre className="preview-block">
						{JSON.stringify(
							{
								agent: selectedAgent?.name ?? "",
								revision,
								name: name.trim(),
								accessMode,
								allowedOrigins: origins,
								theme: { primaryColor: primaryColor.trim(), welcomeMessage: welcomeMessage.trim() },
							},
							null,
							2,
						)}
					</pre>
					{submitError !== null ? (
						<div className="banner error">
							<span>{submitError}</span>
							<button className="pub-btn ghost" type="button" onClick={submit}>
								重试
							</button>
						</div>
					) : null}
					<div className="step-actions">
						<button className="pub-btn ghost" type="button" onClick={() => setStep(2)}>
							上一步
						</button>
						<button className="pub-btn primary" type="button" onClick={submit} disabled={submitting}>
							{submitting ? "创建中…" : "确认创建并发布"}
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}

function useSnapshot(controller: PublishingController) {
	const [, force] = useState({});
	useEffect(() => controller.subscribe(() => force({})), [controller]);
	return controller.getSnapshot();
}
