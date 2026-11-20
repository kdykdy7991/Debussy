import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import styles from "./aaas-key-console.module.css";

interface Choice<Value extends string> {
	readonly value: Value;
	readonly label: string;
	readonly detail?: string;
	readonly destructive?: boolean;
}

export function KeyDropdown<Value extends string>({
	label,
	value,
	options,
	onSelect,
	placeholder = label,
	disabled = false,
	compact = false,
	actions = false,
}: {
	readonly label: string;
	readonly value?: Value;
	readonly options: readonly Choice<Value>[];
	readonly onSelect: (value: Value) => void;
	readonly placeholder?: string;
	readonly disabled?: boolean;
	readonly compact?: boolean;
	readonly actions?: boolean;
}): React.JSX.Element {
	const id = useId();
	const [open, setOpen] = useState(false);
	const container = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const initialFocus = useRef(0);
	const selectedIndex = options.findIndex((option) => option.value === value);
	const selected = options[selectedIndex];
	const visibleLabel = selected?.label ?? placeholder;
	const expanded = open && !disabled && options.length > 0;
	useEffect(() => {
		if (!expanded) return;
		panel.current?.querySelectorAll("button")[initialFocus.current]?.focus();
		const dismiss = (event: PointerEvent) => {
			if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
		};
		document.addEventListener("pointerdown", dismiss);
		return () => document.removeEventListener("pointerdown", dismiss);
	}, [expanded]);

	function close() {
		setOpen(false);
		trigger.current?.focus();
	}
	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Escape" && expanded) {
			event.preventDefault();
			event.stopPropagation();
			close();
			return;
		}
		const down = event.key === "ArrowDown";
		const up = event.key === "ArrowUp";
		const home = event.key === "Home";
		const end = event.key === "End";
		if (disabled || !options.length || (!(down || up) && !(expanded && (home || end)))) return;
		event.preventDefault();
		if (!expanded) {
			initialFocus.current = selectedIndex >= 0 ? selectedIndex : up ? options.length - 1 : 0;
			setOpen(true);
			return;
		}
		const items = Array.from(panel.current?.querySelectorAll("button") ?? []);
		const active = document.activeElement;
		const index = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
		const next =
			home || (index === -1 && down)
				? 0
				: end || index === -1
					? items.length - 1
					: (index + (down ? 1 : -1) + items.length) % items.length;
		items[next]?.focus();
	}

	const items = options.map((option) => {
		const select = () => {
			close();
			onSelect(option.value);
		};
		const content = (
			<>
				<span>{option.label}</span>
				{option.detail && <small>{option.detail}</small>}
			</>
		);
		return actions ? (
			<button
				key={option.value}
				type="button"
				role="menuitem"
				tabIndex={-1}
				className={option.destructive ? styles.destructiveItem : undefined}
				onClick={select}
			>
				{content}
			</button>
		) : (
			<button
				key={option.value}
				type="button"
				role="option"
				aria-selected={option.value === value}
				tabIndex={-1}
				onClick={select}
			>
				{content}
			</button>
		);
	});

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Handles events that bubble from the trigger and menu options.
		<div
			className={[styles.dropdown, compact && styles.dropdownCompact, actions && styles.dropdownActions]
				.filter(Boolean)
				.join(" ")}
			ref={container}
			onKeyDown={onKeyDown}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
			}}
		>
			<button
				ref={trigger}
				className={styles.dropdownTrigger}
				type="button"
				aria-label={actions ? label : `${label}：${visibleLabel}`}
				aria-haspopup={actions ? "menu" : "listbox"}
				aria-expanded={expanded}
				aria-controls={expanded ? id : undefined}
				disabled={disabled || options.length === 0}
				onClick={() => {
					initialFocus.current = Math.max(selectedIndex, 0);
					setOpen(!expanded);
				}}
			>
				{actions ? (
					<span aria-hidden="true" className={styles.ellipsis}>
						···
					</span>
				) : (
					<>
						<span className={styles.dropdownValue}>
							{visibleLabel}
							{selected?.detail && <span className={styles.dropdownDetail}> · {selected.detail}</span>}
						</span>
						<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
							<path
								d="m4 6 4 4 4-4"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</>
				)}
			</button>
			{expanded &&
				(actions ? (
					<div ref={panel} id={id} className={styles.dropdownPanel} role="menu" aria-label={label}>
						{items}
					</div>
				) : (
					<div ref={panel} id={id} className={styles.dropdownPanel} role="listbox" aria-label={label}>
						{items}
					</div>
				))}
		</div>
	);
}
