import type { ConversationSummary } from "./types.ts";

/** Embed 会话列表（TASK-019/033）：新建 / 切换 / 归档。 */
export function ConversationList(props: {
	readonly items: readonly ConversationSummary[];
	readonly activeId: string | null;
	readonly onSelect: (id: string) => void;
	readonly onNew: () => void;
	readonly onArchive: (id: string) => void;
}): React.JSX.Element {
	return (
		<nav className="embed-conversations" aria-label="会话列表">
			<button type="button" className="embed-button embed-new" onClick={props.onNew}>
				新建会话
			</button>
			{props.items.length === 0 && <p className="embed-empty">还没有会话</p>}
			<ul className="embed-conversation-list">
				{props.items.map((item) => (
					<li key={item.id} className="embed-conversation-li">
						<button
							type="button"
							className={`embed-conversation-item${item.id === props.activeId ? " is-active" : ""}`}
							onClick={() => props.onSelect(item.id)}
							aria-current={item.id === props.activeId ? "true" : undefined}
						>
							<span className="embed-conversation-title">{item.title || "新会话"}</span>
						</button>
						<button
							type="button"
							className="embed-conversation-archive"
							aria-label={`归档会话：${item.title || "新会话"}`}
							onClick={(event) => {
								event.stopPropagation();
								props.onArchive(item.id);
							}}
						>
							归档
						</button>
					</li>
				))}
			</ul>
		</nav>
	);
}
