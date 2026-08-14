import type { ReactNode } from "react";

/** Embed 外壳（TASK-019）：标题（主题色）+ 内容 + 底部输入。 */
export function EmbedShell(props: {
	readonly title: string;
	readonly primaryColor?: string;
	readonly children: ReactNode;
	readonly onSend: (text: string) => void;
	readonly sending: boolean;
	readonly disabled?: boolean;
}): React.JSX.Element {
	const style =
		props.primaryColor !== undefined ? ({ "--embed-primary": props.primaryColor } as React.CSSProperties) : undefined;
	return (
		<div className="embed-shell" style={style}>
			<header className="embed-header">
				<span className="embed-title">{props.title}</span>
			</header>
			<div className="embed-body">{props.children}</div>
			<footer className="embed-composer">
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
					<input
						name="text"
						className="embed-input"
						placeholder="输入消息…"
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
