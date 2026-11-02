import { type FormEvent, useId, useRef, useState } from "react";
import { McpApiError } from "../api/mcp-api.ts";
import dialogStyles from "./dialog.module.css";
import { Dialog } from "./dialog.tsx";
import styles from "./mcp-token-dialog.module.css";

export interface McpTokenTarget {
	readonly id: string;
	readonly name: string;
	readonly endpoint: string;
	readonly credentialLabel?: string;
}

/** Mounted for one selected server only; dismissing destroys the entered secret. */
export function McpTokenDialog({
	target,
	onSave,
	onClose,
}: {
	readonly target: McpTokenTarget;
	readonly onSave: (token: string) => Promise<void>;
	readonly onClose: () => void;
}): React.JSX.Element {
	const inputRef = useRef<HTMLInputElement>(null);
	const savingRef = useRef(false);
	const titleId = useId();
	const hintId = useId();
	const [token, setToken] = useState("");
	const [visible, setVisible] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		if (savingRef.current || !token.trim()) return;
		if (target.credentialLabel !== "API Key" && /^Bearer\s/i.test(token.trim())) {
			setError("请只粘贴 Token 本身，不要包含 Bearer 前缀。");
			inputRef.current?.focus();
			return;
		}
		if (/\s/.test(token.trim())) {
			setError("Token 中不能包含空格或换行，请重新粘贴。");
			return;
		}
		savingRef.current = true;
		setSaving(true);
		setError(null);
		try {
			await onSave(token.trim());
			onClose();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : "保存失败，请稍后重试";
			const safeMessage = message.split(token.trim()).join("[已隐藏]");
			setError(
				`${safeMessage}${cause instanceof McpApiError && cause.requestId ? ` · Request ID: ${cause.requestId}` : ""}`,
			);
		} finally {
			savingRef.current = false;
			setSaving(false);
		}
	};

	return (
		<Dialog
			title="替换 Token"
			description="更新此 MCP 服务的连接凭据"
			busy={saving}
			onClose={() => {
				if (!savingRef.current) onClose();
			}}
			onSubmit={(event) => void submit(event)}
			footer={
				<>
					<button type="button" disabled={saving} onClick={onClose}>
						取消
					</button>
					<button type="submit" className={dialogStyles.primary} disabled={saving || !token.trim()}>
						{saving ? "保存中…" : "保存 Token"}
					</button>
				</>
			}
		>
			<div className={styles.target}>
				<span>正在更新的服务</span>
				<strong>{target.name}</strong>
				<p>{target.endpoint}</p>
			</div>
			<label className={styles.label} htmlFor={`${titleId}-token`}>
				新的 {target.credentialLabel ?? "Bearer Token"}
			</label>
			<div className={styles.inputGroup}>
				<input
					ref={inputRef}
					id={`${titleId}-token`}
					type={visible ? "text" : "password"}
					value={token}
					onChange={(event) => {
						setToken(event.target.value);
						setError(null);
					}}
					placeholder="粘贴新的 Token"
					autoComplete="new-password"
					spellCheck={false}
					autoCapitalize="none"
					maxLength={16384}
					disabled={saving}
					aria-invalid={error !== null}
					aria-describedby={hintId}
				/>
				<button
					type="button"
					onClick={() => setVisible((current) => !current)}
					aria-label={visible ? "隐藏 Token" : "显示 Token"}
					aria-pressed={visible}
					disabled={saving}
				>
					{visible ? "隐藏" : "显示"}
				</button>
			</div>
			<p id={hintId} className={styles.hint}>
				{target.credentialLabel === "API Key"
					? "仅输入 API Key 的值，无需添加请求头名称。保存后不会回显。"
					: "仅输入 Token 本身，无需添加 Bearer。保存后不会回显。"}
			</p>
			{error ? (
				<p className={styles.error} role="alert">
					{error}
				</p>
			) : null}
		</Dialog>
	);
}
