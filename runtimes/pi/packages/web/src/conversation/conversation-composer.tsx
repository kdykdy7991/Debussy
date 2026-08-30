import type { SessionSnapshot, VoiceCapability } from "@earendil-works/pi-protocol";
import type { ChangeEventHandler, FocusEventHandler, FormEventHandler, KeyboardEventHandler, RefObject } from "react";
import { LiveSpeechToggle } from "../features/voice/live-speech-toggle.tsx";
import type { SessionBrowserSnapshot } from "../lib/session-controller.ts";

export interface ConversationComposerProps {
	readonly active: SessionSnapshot | undefined;
	readonly connected: boolean;
	readonly running: boolean;
	readonly canSend: boolean;
	/** Admin Debug: a conversation may not be attached yet; allow typing anyway. */
	readonly emptySendable?: boolean;
	readonly message: string;
	readonly sessions: SessionBrowserSnapshot;
	readonly composerRef: RefObject<HTMLTextAreaElement | null>;
	readonly fileInputRef: RefObject<HTMLInputElement | null>;
	readonly voice: VoiceCapability | undefined;
	readonly voiceEnabled: boolean;
	readonly voiceAvailable: boolean;
	readonly uploadsEnabled: boolean;
	/** 已绑定 Skill（发布版本能力，review doc §4.6）：输入 `/skill:` 时补全。 */
	readonly skills?: readonly { name: string; description?: string }[];
	readonly onVoiceChange: (enabled: boolean) => void;
	readonly onSubmit: FormEventHandler<HTMLFormElement>;
	readonly onMessageChange: ChangeEventHandler<HTMLTextAreaElement>;
	readonly onMessageKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
	readonly onMessageFocus: FocusEventHandler<HTMLTextAreaElement>;
	readonly onMessageBlur: FocusEventHandler<HTMLTextAreaElement>;
	readonly onFilesSelected: ChangeEventHandler<HTMLInputElement>;
	readonly onDismissUpload: (localId: string) => void;
	readonly onRemoveAttachment: (attachmentId: string) => void;
	readonly onAbort: () => void;
	/** 选择 `/skill:` 补全候选时由宿主把 `skill:<name>` 追加到消息。 */
	readonly onSkillPick: (name: string) => void;
}

function uploadErrorLabel(error: string | undefined): string {
	if (error?.startsWith("Unknown upload:")) return "上传已失效，请重新上传";
	return error ?? "上传失败";
}

/**
 * Derive `/skill:name` candidates from the current message text. Empty array
 * unless the user is actively typing `/skill:<prefix>` and a bound Skill
 * matches. Pure helper (no hook) — driven by the controlled `message` prop.
 */
function skillSuggestions(
	message: string,
	skills: readonly { name: string; description?: string }[],
): readonly { name: string; description?: string }[] {
	if (skills.length === 0) return [];
	const match = /^\/skill:(\S*)$/.exec(message.trim());
	if (match === null) return [];
	const prefix = match[1]!.toLowerCase();
	return prefix === "" ? skills : skills.filter((skill) => skill.name.toLowerCase().startsWith(prefix));
}

export function ConversationComposer(props: ConversationComposerProps): React.ReactElement {
	const active = props.active;
	const suggestions = skillSuggestions(props.message, props.skills ?? []);
	return (
		<div className="composer-dock">
			<form className={`editorial-composer ${props.running ? "running" : ""}`} onSubmit={props.onSubmit}>
				{(active || props.sessions.uploads.length > 0) &&
				((active?.attachments?.length ?? 0) > 0 || props.sessions.uploads.length > 0) ? (
					<div className="composer-attachments">
						{props.sessions.uploads.map((upload) => (
							<span className={`attachment-chip ${upload.status}`} key={upload.localId}>
								<span className="attachment-chip__name" title={upload.name}>
									{upload.name}
								</span>
								{upload.status === "uploading" ? (
									<small>{upload.progress ?? 0}%</small>
								) : upload.status === "failed" ? (
									<small title={uploadErrorLabel(upload.error)}>{uploadErrorLabel(upload.error)}</small>
								) : (
									<small>待发送</small>
								)}
								{upload.status !== "uploading" ? (
									<button
										type="button"
										onClick={() => props.onDismissUpload(upload.localId)}
										aria-label={`移除 ${upload.name}`}
									>
										×
									</button>
								) : null}
							</span>
						))}
						{active?.attachments?.map((attachment) => (
							<span className="attachment-chip ready" key={attachment.id}>
								<span className="attachment-chip__name" title={attachment.name}>
									{attachment.name}
								</span>
								<button
									type="button"
									onClick={() => props.onRemoveAttachment(attachment.id)}
									aria-label={`移除 ${attachment.name}`}
								>
									×
								</button>
							</span>
						))}
					</div>
				) : null}
				<div className="composer-line">
					<label className="sr-only" htmlFor="message">
						消息
					</label>
					<textarea
						ref={props.composerRef}
						id="message"
						rows={1}
						placeholder={
							active
								? props.running
									? "Agent 运行中，可停止后继续输入…"
									: "Ask anything, or point me at a document…"
								: props.emptySendable
									? "输入第一条消息，发送时创建调试会话…"
									: "选择或新建一个会话后开始…"
						}
						disabled={
							!props.connected ||
							(active === undefined && !props.emptySendable) ||
							props.sessions.loading ||
							props.running
						}
						value={props.message}
						onChange={props.onMessageChange}
						onKeyDown={props.onMessageKeyDown}
						onFocus={props.onMessageFocus}
						onBlur={props.onMessageBlur}
					/>
					{suggestions.length > 0 ? (
						<div className="composer-skill-suggest" role="listbox" aria-label="Skill 补全">
							{suggestions.map((skill) => (
								<button
									type="button"
									role="option"
									key={skill.name}
									className="composer-skill-option"
									onClick={() => props.onSkillPick(skill.name)}
								>
									<span className="composer-skill-name">/skill:{skill.name}</span>
									{skill.description ? <span className="composer-skill-desc">{skill.description}</span> : null}
								</button>
							))}
						</div>
					) : null}
				</div>
				<div className="composer-toolbar">
					<div className="composer-tools">
						<button
							className="composer-tool composer-attach"
							type="button"
							onClick={() => props.fileInputRef.current?.click()}
							disabled={
								!props.uploadsEnabled ||
								!props.connected ||
								active === undefined ||
								props.running ||
								props.sessions.loading
							}
							title="上传文件附件"
							aria-label="上传文件附件"
						>
							<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
								<path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
							</svg>
						</button>
						<input ref={props.fileInputRef} type="file" multiple hidden onChange={props.onFilesSelected} />
					</div>
					{props.voice ? (
						<div className="composer-voice">
							<LiveSpeechToggle
								voice={props.voice}
								enabled={props.voiceEnabled && props.voiceAvailable}
								onChange={props.onVoiceChange}
							/>
						</div>
					) : null}
					<div className="composer-submit">
						{props.running ? (
							<button className="stop-button" type="button" onClick={props.onAbort}>
								Stop
							</button>
						) : (
							<button
								className="send-button"
								type="submit"
								disabled={!props.canSend || !props.message.trim()}
								aria-label="发送消息"
							>
								Send <span aria-hidden="true">↵</span>
							</button>
						)}
					</div>
				</div>
			</form>
		</div>
	);
}
