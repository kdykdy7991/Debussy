import { type FormEvent, type ReactNode, useEffect, useId, useRef } from "react";
import styles from "./dialog.module.css";

/** Shared modal shell. showModal provides focus containment and an inert background. */
export function Dialog({
	title,
	description,
	children,
	footer,
	busy = false,
	onClose,
	onSubmit,
}: {
	readonly title: string;
	readonly description?: string;
	readonly children?: ReactNode;
	readonly footer?: ReactNode;
	readonly busy?: boolean;
	readonly onClose: () => void;
	readonly onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}): React.JSX.Element {
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const descriptionId = useId();
	useEffect(() => {
		const element = ref.current;
		const previous = document.activeElement;
		element?.showModal();
		(
			element?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), textarea:not(:disabled)") ??
			element?.querySelector<HTMLElement>("footer button:not(:disabled)")
		)?.focus();
		return () => {
			element?.close();
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, []);
	return (
		<dialog
			ref={ref}
			className={styles.dialog}
			aria-labelledby={titleId}
			aria-describedby={description ? descriptionId : undefined}
			onKeyDown={(event) => event.stopPropagation()}
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
		>
			<form
				className={styles.form}
				aria-busy={busy}
				onSubmit={(event) => {
					event.preventDefault();
					if (!busy) onSubmit?.(event);
				}}
			>
				<header className={styles.header}>
					<div>
						<h2 id={titleId}>{title}</h2>
						{description ? <p id={descriptionId}>{description}</p> : null}
					</div>
					<button type="button" className={styles.close} aria-label="关闭弹窗" disabled={busy} onClick={onClose}>
						×
					</button>
				</header>
				<div className={styles.body}>{children}</div>
				{footer ? <footer className={styles.footer}>{footer}</footer> : null}
			</form>
		</dialog>
	);
}
