import type { ReactNode, Ref } from "react";
import type { EmbedConnectionStatus } from "./chat-controller.ts";

const CONNECTION_LABEL: Record<EmbedConnectionStatus, string> = {
	idle: "",
	connecting: "连接中…",
	connected: "",
	reconnecting: "重连中…",
	closed: "连接已断开",
};

/** Embed 外壳（TASK-019/033）：标题（主题色 + 连接状态）+ 内容 + 底部输入/上传/附件。 */
export function EmbedShell(props: {
	readonly title: string;
	readonly primaryColor?: string;
	readonly children: ReactNode;
	readonly onSend: (text: string) => void;
	readonly sending: boolean;
	readonly disabled?: boolean;
	readonly connectionStatus?: EmbedConnectionStatus;
	readonly uploadsEnabled?: boolean;
	readonly uploading?: boolean;
	readonly onUpload?: (file: File) => void;
	readonly inputRef?: Ref<HTMLInputElement>;
	/** 输入框上方展示的附件行（可选）。 */
	readonly attachments?: ReactNode;
	/** 标题栏右侧附加操作（移动端会话列表开关等）。 */
	readonly headerExtra?: ReactNode;
}): React.JSX.Element {
	const style =
		props.primaryColor !== undefined ? ({ "--embed-primary": props.primaryColor } as React.CSSProperties) : undefined;
	const status = props.connectionStatus ?? "idle";
	const statusLabel = CONNECTION_LABEL[status];
	const onUpload = props.onUpload;
	const uploadsEnabled = props.uploadsEnabled === true && onUpload !== undefined;
	return (
		<div className="embed-shell" style={style}>
			<header className="embed-header">
				<span className="embed-title">{props.title}</span>
				{statusLabel !== "" && <output className={`embed-status embed-status-${status}`}>{statusLabel}</output>}
				{props.headerExtra}
			</header>
			<div className="embed-body">{props.children}</div>
			<footer className="embed-composer">
				{props.attachments}
				<form
					className="embed-composer-form"
					onSubmit={(event) => {
						event.preventDefault();
						const form = event.currentTarget;
						const input = form.elements.namedItem("text") as HTMLInputElement;
						const text = input.value.trim();
						if (text === "" || props.sending || props.disabled === true) return;
						input.value = "";
						props.onSend(text);
					}}
				>
					{uploadsEnabled && (
						<label className="embed-upload" aria-label="上传附件">
							<input
								type="file"
								className="embed-file-input"
								disabled={props.sending || props.disabled === true || props.uploading === true}
								onChange={(event) => {
									const file = event.currentTarget.files?.[0];
									if (file !== undefined) onUpload(file);
									event.currentTarget.value = "";
								}}
							/>
							<span className="embed-upload-icon" aria-hidden="true">
								+
							</span>
						</label>
					)}
					<input
						name="text"
						ref={props.inputRef}
						className="embed-input"
						placeholder="输入消息…"
						aria-label="消息输入"
						disabled={props.sending || props.disabled === true}
					/>
					<button
						type="submit"
						className="embed-button embed-send"
						disabled={props.sending || props.disabled === true}
					>
						{props.sending ? "发送中…" : "发送"}
					</button>
				</form>
			</footer>
		</div>
	);
}
