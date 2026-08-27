/** Embed 错误状态展示（TASK-019）。 */
export function EmbedErrorState(props: {
	readonly message: string;
	readonly onRetry?: () => void;
	readonly retryLabel?: string;
}): React.JSX.Element {
	return (
		<div className="embed-error" role="alert">
			<p className="embed-error-message">{props.message}</p>
			{props.onRetry !== undefined && (
				<button type="button" className="embed-button" onClick={props.onRetry}>
					{props.retryLabel ?? "重试"}
				</button>
			)}
		</div>
	);
}
