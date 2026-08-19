/**
 * Aurora SettingsGroup — 对齐 direction-b-aurora 的 .settings-group。
 *
 * 视觉：白底卡片 + line 边 + radius-lg；头部（标题 + 描述）+ 行列表（grid
 * 1fr auto，左 label + 描述，右 action/status）；行间用 line-soft 分割，
 * 最后一行无下边。
 */
import type { ReactNode } from "react";
import styles from "./SettingsGroup.module.css";

export interface AuroraSettingsRow {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** 右侧的 action 区域：button / pill / 自定义控件。 */
	readonly control: ReactNode;
}

export interface AuroraSettingsGroupProps {
	readonly title?: string;
	readonly description?: string;
	readonly rows: readonly AuroraSettingsRow[];
	readonly footer?: ReactNode;
}

export function AuroraSettingsGroup({
	title,
	description,
	rows,
	footer,
}: AuroraSettingsGroupProps): React.ReactElement {
	return (
		<section className={styles.group}>
			{(title || description) && (
				<header className={styles.head}>
					{title ? <h4 className={styles.title}>{title}</h4> : null}
					{description ? <p className={styles.desc}>{description}</p> : null}
				</header>
			)}
			<div className={styles.rows}>
				{rows.map((row) => (
					<div key={row.id} className={styles.row}>
						<div className={styles.labelBlock}>
							<div className={styles.label}>{row.label}</div>
							{row.description ? <div className={styles.rowDesc}>{row.description}</div> : null}
						</div>
						<div className={styles.control}>{row.control}</div>
					</div>
				))}
			</div>
			{footer ? <footer className={styles.footer}>{footer}</footer> : null}
		</section>
	);
}
