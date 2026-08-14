import type { ConversationSummary } from "./types.ts";

/** Embed 会话列表（TASK-019）。 */
export function ConversationList(props: {
	readonly items: readonly ConversationSummary[];
	readonly activeId: string | null;
	readonly onSelect: (id: string) => void;
	readonly onNew: () => void;
}): React.JSX.Element {
	return (
		<nav className="embed-conversations" aria-label="会话列表">
			<button type="button" className="embed-button embed-new" onClick={props.onNew}>
				新建会话
			</button>
			{props.items.length === 0 && <p className="embed-empty">还没有会话</p>}
			<ul className="embed-conversation-list">
				{props.items.map((item) => (
					<li key={item.id}>
						<button
							type="button"
							className={`embed-conversation-item${item.id === props.activeId ? " is-active" : ""}`}
							onClick={() => props.onSelect(item.id)}
						>
							<span className="embed-conversation-title">{item.title || "新会话"}</span>
						</button>
					</li>
				))}
			</ul>
		</nav>
	);
}
