/**
 * Aurora Chip — 工具型胶囊，对齐 .chip（sort/view switch）。
 *
 * 视觉：999px 圆角、surface-soft 底；hover surface + line 边；active 用
 * accent-soft 底 + accent 色 + accent 边。
 */
import type { ReactNode } from "react";
import styles from "./Chip.module.css";

export interface AuroraChipProps {
	readonly children: ReactNode;
	readonly active?: boolean;
	readonly onClick?: () => void;
	readonly title?: string;
	/** 右槽（图标 / 计数）。 */
	readonly trailing?: ReactNode;
}

export function AuroraChip({
	children,
	active = false,
	onClick,
	title,
	trailing,
}: AuroraChipProps): React.ReactElement {
	const className = `${styles.chip} ${active ? styles.chipActive : ""}`;
	if (onClick) {
		return (
			<button type="button" className={className} onClick={onClick} title={title}>
				<span>{children}</span>
				{trailing}
			</button>
		);
	}
	return (
		<span className={className} title={title}>
			<span>{children}</span>
			{trailing}
		</span>
	);
}
