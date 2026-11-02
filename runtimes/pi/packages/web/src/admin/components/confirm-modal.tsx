import { type ReactElement, useRef, useState } from "react";
import styles from "./dialog.module.css";
import { Dialog } from "./dialog.tsx";

export interface ConfirmModalProps {
	readonly open: boolean;
	readonly title: string;
	readonly body: string;
	readonly confirmLabel: string;
	readonly cancelLabel?: string;
	readonly destructive?: boolean;
	readonly typeToConfirm?: string;
	readonly inputLabel?: string;
	readonly defaultValue?: string;
	readonly maxLength?: number;
	readonly hideCancel?: boolean;
	readonly onConfirm: (value: string) => void | Promise<void>;
	readonly onCancel: () => void;
}

/** Mount the contents only while open, so each request starts with fresh input. */
export function ConfirmModal(props: ConfirmModalProps): ReactElement | null {
	return props.open ? <Confirmation {...props} /> : null;
}

function Confirmation(props: ConfirmModalProps): ReactElement {
	const [typed, setTyped] = useState(props.defaultValue ?? "");
	const [busy, setBusy] = useState(false);
	const submitting = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const needsTyping = props.typeToConfirm !== undefined;
	const hasInput = needsTyping || props.inputLabel !== undefined;
	const canConfirm = !busy && (!needsTyping || typed === props.typeToConfirm) && (!hasInput || typed.trim() !== "");
	const submit = async (): Promise<void> => {
		if (!canConfirm || submitting.current) return;
		submitting.current = true;
		setBusy(true);
		setError(null);
		try {
			await props.onConfirm(typed);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			submitting.current = false;
			setBusy(false);
		}
	};
	return (
		<Dialog
			title={props.title}
			busy={busy}
			onClose={() => {
				if (!submitting.current) props.onCancel();
			}}
			onSubmit={() => void submit()}
			footer={
				<>
					{!props.hideCancel ? (
						<button type="button" disabled={busy} onClick={props.onCancel}>
							{props.cancelLabel ?? "取消"}
						</button>
					) : null}
					<button
						type="submit"
						className={props.destructive ? styles.danger : styles.primary}
						disabled={!canConfirm}
					>
						{busy ? "处理中…" : props.confirmLabel}
					</button>
				</>
			}
		>
			<p className={styles.message}>{props.body}</p>
			{hasInput ? (
				<label className={styles.field}>
					<span>{props.inputLabel ?? `输入「${props.typeToConfirm}」以确认`}</span>
					<input
						type="text"
						value={typed}
						onChange={(event) => setTyped(event.currentTarget.value)}
						disabled={busy}
						autoComplete="off"
						spellCheck={false}
						maxLength={props.maxLength}
					/>
					{needsTyping ? <small>名称须完全一致后才能确认。</small> : null}
				</label>
			) : null}
			{error ? (
				<p className={styles.error} role="alert">
					{error}
				</p>
			) : null}
		</Dialog>
	);
}
