import { type ReactNode, useEffect, useId, useRef } from "react";
import styles from "./orchestration-page.module.css";

/** Native modal containment, deliberate dismissal and return-to-trigger focus for console workflows. */
export function OrchestrationDrawer({
	title,
	subtitle,
	children,
	footer,
	busy = false,
	onClose,
}: {
	title: string;
	subtitle?: string;
	children: ReactNode;
	footer?: ReactNode;
	busy?: boolean;
	onClose: () => void;
}): React.JSX.Element {
	const ref = useRef<HTMLDialogElement>(null),
		titleId = useId(),
		descriptionId = useId();
	useEffect(() => {
		const previous = document.activeElement,
			dialog = ref.current;
		dialog?.showModal();
		(
			dialog?.querySelector<HTMLElement>("[data-autofocus]") ??
			dialog?.querySelector<HTMLElement>("button:not(:disabled)")
		)?.focus();
		return () => {
			dialog?.close();
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, []);
	return (
		<dialog
			ref={ref}
			className={styles.drawer}
			aria-labelledby={titleId}
			aria-describedby={subtitle ? descriptionId : undefined}
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
		>
			<header className={styles.drawerHeader}>
				<div>
					<h2 id={titleId}>{title}</h2>
					{subtitle && <p id={descriptionId}>{subtitle}</p>}
				</div>
				<button className={styles.iconButton} type="button" aria-label="关闭面板" disabled={busy} onClick={onClose}>
					×
				</button>
			</header>
			<div className={styles.drawerBody} aria-busy={busy}>
				{children}
			</div>
			{footer && <footer className={styles.drawerFooter}>{footer}</footer>}
		</dialog>
	);
}
