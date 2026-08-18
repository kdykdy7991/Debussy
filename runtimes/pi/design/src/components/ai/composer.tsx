import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../../lib/utils";

export type ComposerMode = {
	id: string;
	label: string;
	/** 多选语义（知识库/联网/深思考可任意组合）。 */
	active: boolean;
};

export type ComposerMenuItem = {
	label: string;
	icon?: ReactNode;
	onSelect?: () => void;
};

export type ComposerProps = {
	/** 提交（已 trim 的非空文本）。不绑定业务 API：业务层决定如何消费。 */
	onSubmit: (text: string) => void;
	/** 受控文本（缺省 → 内部 state）。 */
	value?: string;
	onChange?: (text: string) => void;
	placeholder?: string;
	/** 生成中：发送 → 停止。 */
	streaming?: boolean;
	onStop?: () => void;
	/** 多选 modes。 */
	modes?: readonly ComposerMode[];
	onModeToggle?: (id: string) => void;
	/** 附件/工具菜单项（[+] 展开）。 */
	menuItems?: readonly ComposerMenuItem[];
	/** 模型选择器槽位（业务层注入；此处不实现下拉）。 */
	model?: ReactNode;
	/** 键盘提示行。 */
	hint?: ReactNode;
	/** 默认 fixed dock；static 用于嵌入上下文。 */
	docked?: boolean;
};

const MAX_HEIGHT = 150;

/**
 * Composer（fixed dock，820px 居中）。
 * 语义状态：text / streaming / modes / menu 开合；
 * 视觉（auto-resize 上限 150px、focus 环、150ms 微交互）全部由样式层决定。
 * 键盘：⏎ 发送 · ⇧⏎ 换行 · /（空输入时）唤起菜单。
 */
export function Composer({
	onSubmit,
	value,
	onChange,
	placeholder = "问点什么，或把任务交给 Agent…",
	streaming = false,
	onStop,
	modes = [],
	onModeToggle,
	menuItems = [],
	model,
	hint = (
		<>
			<b>⏎</b> 发送 · <b>⇧⏎</b> 换行 · <b>/</b> 唤起工具与知识源
		</>
	),
	docked = true
}: ComposerProps) {
	const [internal, setInternal] = useState("");
	const [menuOpen, setMenuOpen] = useState(false);
	const text = value !== undefined ? value : internal;
	const taRef = useRef<HTMLTextAreaElement>(null);

	const setText = (next: string) => {
		if (value === undefined) setInternal(next);
		onChange?.(next);
	};

	// textarea auto resize：1 行起步，至多 150px 后滚动
	useEffect(() => {
		const el = taRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
	}, [text]);

	const submit = () => {
		const trimmed = text.trim();
		if (!trimmed || streaming) return;
		onSubmit(trimmed);
		setText("");
		setMenuOpen(false);
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
			return;
		}
		if (e.key === "/" && text === "") {
			e.preventDefault();
			setMenuOpen(true);
		}
	};

	return (
		<div className={cx("ai-composer-dock", !docked && "static")}>
			<div className="ai-composer">
				{menuItems.length > 0 ? (
					<div className={cx("ai-composer-menu", menuOpen && "is-open")}>
						{menuItems.map((item) => (
							<button
								type="button"
								key={item.label}
								className="ai-composer-menu-item ai-hoverable"
								onClick={() => {
									setMenuOpen(false);
									item.onSelect?.();
								}}
							>
								{item.icon ? (
									<span aria-hidden style={{ marginRight: 6 }}>
										{item.icon}
									</span>
								) : null}
								{item.label}
							</button>
						))}
					</div>
				) : null}

				<div className="ai-composer-box">
					<textarea
						ref={taRef}
						rows={1}
						value={text}
						placeholder={placeholder}
						aria-label="对话输入"
						onChange={(e) => setText(e.target.value)}
						onKeyDown={handleKeyDown}
					/>
					<div className="ai-composer-row">
						<button
							type="button"
							className="ai-composer-plus ai-hoverable"
							aria-label="附件与工具"
							aria-expanded={menuOpen}
							onClick={() => setMenuOpen((v) => !v)}
						>
							＋
						</button>

						{modes.length > 0 ? (
							<div className="ai-composer-modes" role="group" aria-label="模式">
								{modes.map((mode) => (
									<button
										type="button"
										key={mode.id}
										className={cx("ai-mode", mode.active && "is-on")}
										aria-pressed={mode.active}
										onClick={() => onModeToggle?.(mode.id)}
									>
										{mode.label}
									</button>
								))}
							</div>
						) : null}

						<div className="ai-composer-grow" />

						{model}

						{streaming ? (
							<button type="button" className="ai-composer-go is-stop" onClick={() => onStop?.()}>
								停止 ■
							</button>
						) : (
							<button type="button" className="ai-composer-go" onClick={submit}>
								发送 ⏎
							</button>
						)}
					</div>
				</div>

				<div className="ai-composer-hint">{hint}</div>
			</div>
		</div>
	);
}
