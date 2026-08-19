/**
 * 控制台通用 Button（设计收口 / MVP-15）。
 *
 * 变体：primary（深底白字主操作）/ secondary（白底浅边）/ ghost（无边框透明）/
 * danger（危险操作）。尺寸：sm / md。
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
	readonly variant?: ButtonVariant;
	readonly size?: ButtonSize;
	readonly icon?: ReactNode;
	readonly iconRight?: ReactNode;
	readonly children?: ReactNode;
	readonly fullWidth?: boolean;
}

export function Button({
	variant = "secondary",
	size = "md",
	icon,
	iconRight,
	children,
	fullWidth = false,
	type = "button",
	...rest
}: ButtonProps): React.ReactElement {
	const className = [
		styles.button,
		styles[`variant_${variant}`],
		styles[`size_${size}`],
		fullWidth ? styles.fullWidth : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<button {...rest} type={type} className={className}>
			{icon ? (
				<span className={styles.iconLeft} aria-hidden="true">
					{icon}
				</span>
			) : null}
			{children}
			{iconRight ? (
				<span className={styles.iconRight} aria-hidden="true">
					{iconRight}
				</span>
			) : null}
		</button>
	);
}
