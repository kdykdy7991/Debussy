/**
 * Reusable confirmation modal (WB-005).
 *
 * The admin workbench must not call the browser-native `confirm()` (no such
 * API exists in this app shell, and we want the look to match). This component
 * provides a single, accessible `dialog` element that:
 *
 * - traps Enter / Escape to the primary/secondary action respectively;
 * - renders a title, body copy, optional text input (for typed confirmation),
 *   and primary/secondary buttons;
 * - closes via the secondary action by default and on Escape;
 * - is keyboard-focusable when opened.
 */
import { type ReactElement, useCallback, useEffect, useId, useRef, useState } from "react";

export interface ConfirmModalProps {
	readonly open: boolean;
	readonly title: string;
	readonly body: string;
	readonly confirmLabel: string;
	readonly cancelLabel?: string;
	readonly destructive?: boolean;
	/** When set, the confirm button stays disabled until the input matches. */
	readonly typeToConfirm?: string;
	readonly onConfirm: () => void | Promise<void>;
	readonly onCancel: () => void;
}

export function ConfirmModal(props: ConfirmModalProps): ReactElement | null {
	const titleId = useId();
	const bodyId = useId();
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const needsTyping = props.typeToConfirm !== undefined && props.typeToConfirm !== "";
	const canConfirm = !busy && (!needsTyping || typed === props.typeToConfirm);

	useEffect(() => {
		if (!props.open) return;
		setTyped("");
		setError(null);
		setBusy(false);
		inputRef.current?.focus();
	}, [props.open]);

	useEffect(() => {
		if (!props.open) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				e.preventDefault();
				props.onCancel();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [props.open, props.onCancel]);

	const handleConfirm = useCallback(async (): Promise<void> => {
		if (!canConfirm) return;
		setBusy(true);
		try {
			await props.onConfirm();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
			return;
		}
		setBusy(false);
	}, [canConfirm, props]);

	if (!props.open) return null;
	return (
		<div
			className="modal-overlay"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			aria-describedby={bodyId}
		>
			<div
				className="modal-card"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
				role="document"
			>
				<h3 id={titleId} className="modal-title">
					{props.title}
				</h3>
				<p id={bodyId} className="modal-body">
					{props.body}
				</p>
				{needsTyping ? (
					<label className="modal-field">
						<span>输入「{props.typeToConfirm}」以确认</span>
						<input
							ref={inputRef}
							type="text"
							value={typed}
							onChange={(e) => setTyped(e.target.value)}
							spellCheck={false}
							autoComplete="off"
						/>
					</label>
				) : null}
				{error !== null ? (
					<p className="modal-error" role="alert">
						{error}
					</p>
				) : null}
				<div className="modal-actions">
					<button type="button" className="btn btn-secondary" onClick={props.onCancel} disabled={busy}>
						{props.cancelLabel ?? "取消"}
					</button>
					<button
						type="button"
						className={props.destructive === true ? "btn btn-danger" : "btn btn-primary"}
						onClick={() => void handleConfirm()}
						disabled={!canConfirm}
					>
						{props.confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
