import type { SessionSnapshot, VoiceCapability } from "@earendil-works/pi-protocol";
import type { ChangeEventHandler, FocusEventHandler, FormEventHandler, KeyboardEventHandler, RefObject } from "react";
import { LiveSpeechToggle } from "../features/voice/live-speech-toggle.tsx";
import type { SessionBrowserSnapshot } from "../lib/session-controller.ts";

export interface ConversationComposerProps {
	readonly active: SessionSnapshot | undefined;
	readonly connected: boolean;
	readonly running: boolean;
	readonly canSend: boolean;
	readonly message: string;
	readonly sessions: SessionBrowserSnapshot;
	readonly composerRef: RefObject<HTMLTextAreaElement | null>;
	readonly fileInputRef: RefObject<HTMLInputElement | null>;
	readonly voice: VoiceCapability | undefined;
	readonly voiceEnabled: boolean;
	readonly voiceAvailable: boolean;
	readonly uploadsEnabled: boolean;
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
}

function uploadErrorLabel(error: string | undefined): string {
	if (error?.startsWith("Unknown upload:")) return "上传已失效，请重新上传";
	return error ?? "上传失败";
}

export function ConversationComposer(props: ConversationComposerProps): React.ReactElement {
	const active = props.active;
	return (
		<div className="composer-dock">
			<form className={`editorial-composer ${props.running ? "running" : ""}`} onSubmit={props.onSubmit}>
				{active && ((active.attachments?.length ?? 0) > 0 || props.sessions.uploads.length > 0) ? (
					<div className="composer-attachments">
						{props.sessions.uploads.map((upload) => (
							<span className={`attachment-chip ${upload.status}`} key={upload.localId}>
								<span className="attachment-chip__name" title={upload.name}>
									{upload.name}
								</span>
								{upload.status === "uploading" ? (
									<small>{upload.progress ?? 0}%</small>
								) : (
									<small title={uploadErrorLabel(upload.error)}>{uploadErrorLabel(upload.error)}</small>
								)}
								{upload.status === "failed" ? (
									<button
										type="button"
										onClick={() => props.onDismissUpload(upload.localId)}
										aria-label="移除失败项"
									>
										×
									</button>
								) : null}
							</span>
						))}
						{active.attachments?.map((attachment) => (
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
								: "选择或新建一个会话后开始…"
						}
						disabled={!props.connected || active === undefined || props.sessions.loading || props.running}
						value={props.message}
						onChange={props.onMessageChange}
						onKeyDown={props.onMessageKeyDown}
						onFocus={props.onMessageFocus}
						onBlur={props.onMessageBlur}
					/>
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
