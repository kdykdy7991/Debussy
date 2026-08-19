/**
 * Aurora Button — 胶囊形按钮，对齐 direction-b-aurora 的 .btn。
 *
 * 变体：
 *   - default    浅边白底（次要操作）
 *   - primary    ink 黑底白字（主要操作）
 *   - accent     gradient 渐变 + glow（最关键 CTA）
 *   - ghost      透明无边框（行内轻操作）
 *
 * 尺寸：sm=28 / md=36 / lg=44（按设计稿默认 36px）。
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

export type AuroraButtonVariant = "default" | "primary" | "accent" | "ghost";
export type AuroraButtonSize = "sm" | "md" | "lg";

export interface AuroraButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
	readonly variant?: AuroraButtonVariant;
	readonly size?: AuroraButtonSize;
	readonly icon?: ReactNode;
	readonly iconRight?: ReactNode;
	readonly children?: ReactNode;
}

export function AuroraButton({
	variant = "default",
	size = "md",
	icon,
	iconRight,
	children,
	type = "button",
	...rest
}: AuroraButtonProps): React.ReactElement {
	return (
		<button {...rest} type={type} className={`${styles.btn} ${styles[`v_${variant}`]} ${styles[`s_${size}`]}`}>
			{icon ? (
				<span className={styles.iconL} aria-hidden="true">
					{icon}
				</span>
			) : null}
			{children}
			{iconRight ? (
				<span className={styles.iconR} aria-hidden="true">
					{iconRight}
				</span>
			) : null}
		</button>
	);
}
