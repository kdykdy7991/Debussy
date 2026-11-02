import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ConfirmModal } from "./confirm-modal.tsx";
import { type DialogOptions, DialogQueue } from "./dialog-queue.ts";

/** Local ownership cancels pending decisions when their page unmounts. */
export function useDialogs() {
	const [queue] = useState(() => new DialogQueue());
	const current = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
	useEffect(() => {
		queue.activate();
		return () => queue.dispose();
	}, [queue]);
	const dialogs = useMemo(
		() => ({
			confirm: async (message: string, options?: DialogOptions): Promise<boolean> =>
				(await queue.ask("confirm", message, options)) !== null,
			prompt: (message: string, options?: DialogOptions): Promise<string | null> =>
				queue.ask("prompt", message, options),
			alert: async (message: string, options?: DialogOptions): Promise<void> => {
				await queue.ask("alert", message, options);
			},
		}),
		[queue],
	);
	const dialog = current ? (
		<ConfirmModal
			key={current.id}
			open
			title={
				current.options.title ??
				(current.kind === "prompt" ? "填写信息" : current.kind === "alert" ? "提示" : "确认操作")
			}
			body={current.message}
			confirmLabel={current.options.confirmLabel ?? (current.kind === "alert" ? "知道了" : "确定")}
			destructive={current.options.destructive}
			typeToConfirm={current.options.typeToConfirm}
			inputLabel={current.kind === "prompt" ? (current.options.inputLabel ?? "请输入") : undefined}
			defaultValue={current.options.defaultValue}
			maxLength={current.options.maxLength}
			hideCancel={current.kind === "alert"}
			onConfirm={(value) => queue.settle(current, value)}
			onCancel={() => queue.settle(current, null)}
		/>
	) : null;
	return { ...dialogs, dialog };
}
