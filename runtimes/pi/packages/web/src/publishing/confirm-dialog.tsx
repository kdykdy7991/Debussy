/**
 * Modal-style confirm dialog (PUBLISHING-ADMIN-CONSOLE §5.4).
 *
 * Spec forbids `window.confirm()` for dangerous operations; this is the
 * in-shell equivalent. Backed by a portal-free fixed-position div so it
 * works without React 18 createPortal being wired up.
 */
import { type ReactNode, useEffect, useRef } from "react";

export interface ConfirmDialogProps {
	readonly title: string;
	readonly body: ReactNode;
	readonly confirmLabel: string;
	readonly cancelLabel?: string;
	readonly danger?: boolean;
	readonly onConfirm: () => void;
	readonly onCancel: () => void;
}

export function ConfirmDialog({
	title,
	body,
	confirmLabel,
	cancelLabel = "取消",
	danger = false,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	const confirmRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		confirmRef.current?.focus();
		const handler = (event: KeyboardEvent) => {
			if (event.key === "Escape") onCancel();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [onCancel]);
	return (
		<div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label={title}>
			<div className="dialog">
				<h3>{title}</h3>
				<div className="body">{body}</div>
				<div className="actions">
					<button className="pub-btn ghost" type="button" onClick={onCancel}>
						{cancelLabel}
					</button>
					<button
						ref={confirmRef}
						className={danger ? "pub-btn danger" : "pub-btn primary"}
						type="button"
						onClick={onConfirm}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
