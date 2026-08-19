/**
 * Aurora AppTile — 对齐 direction-b-aurora 的 .app-tile。
 *
 * 视觉：白底卡片 + line 边 + radius-lg；上半部 140px visual 区域（gradient-soft
 * 背景 + ornament 渐变球 + 48px 白底图标），下半部 body（name / mono url /
 * desc / meta-row）。
 *
 * hover：translateY(-3px) + shadow-md + 边框消失。
 */
import type { ReactNode } from "react";
import styles from "./AppTile.module.css";

export type AuroraAppTone = "indigo" | "amber" | "emerald" | "pink" | "sky" | "purple";

export interface AuroraAppTileProps {
	readonly name: string;
	/** mono 字体的 URL / domain / handle。 */
	readonly url?: string;
	readonly description: string;
	readonly icon: ReactNode;
	readonly tone?: AuroraAppTone;
	readonly tags?: ReactNode;
	readonly meta?: ReactNode;
	readonly onClick?: () => void;
	readonly ariaLabel?: string;
}

const TONE_BG: Record<AuroraAppTone, string> = {
	indigo: "linear-gradient(135deg, #EEF2FF 0%, #E0E7FF 100%)",
	amber: "linear-gradient(135deg, #FEF3C7 0%, #FDE68A 100%)",
	emerald: "linear-gradient(135deg, #DCFCE7 0%, #BBF7D0 100%)",
	pink: "linear-gradient(135deg, #FCE7F3 0%, #FBCFE8 100%)",
	sky: "linear-gradient(135deg, #E0F2FE 0%, #BAE6FD 100%)",
	purple: "linear-gradient(135deg, #F3E8FF 0%, #E9D5FF 100%)",
};

const TONE_ORNAMENT: Record<AuroraAppTone, string> = {
	indigo: "linear-gradient(135deg, #818CF8, #6366F1)",
	amber: "linear-gradient(135deg, #F59E0B, #D97706)",
	emerald: "linear-gradient(135deg, #34D399, #059669)",
	pink: "linear-gradient(135deg, #F472B6, #EC4899)",
	sky: "linear-gradient(135deg, #60A5FA, #2563EB)",
	purple: "linear-gradient(135deg, #A855F7, #7E22CE)",
};

const TONE_ICON_COLOR: Record<AuroraAppTone, string> = {
	indigo: "var(--aurora-accent)",
	amber: "var(--aurora-amber)",
	emerald: "var(--aurora-green)",
	pink: "#BE185D",
	sky: "#0369A1",
	purple: "#7E22CE",
};

export function AuroraAppTile({
	name,
	url,
	description,
	icon,
	tone = "indigo",
	tags,
	meta,
	onClick,
	ariaLabel,
}: AuroraAppTileProps): React.ReactElement {
	const interactive = typeof onClick === "function";
	const Tag = interactive ? "button" : "article";
	return (
		<Tag
			className={styles.tile}
			onClick={onClick}
			type={interactive ? "button" : undefined}
			aria-label={ariaLabel ?? name}
		>
			<div className={styles.visual} style={{ background: TONE_BG[tone] }} aria-hidden="true">
				<span className={styles.ornament} style={{ background: TONE_ORNAMENT[tone] }} />
				<span className={styles.iconWrap} style={{ color: TONE_ICON_COLOR[tone] }}>
					{icon}
				</span>
			</div>
			<div className={styles.body}>
				<div className={styles.name}>{name}</div>
				{url ? <div className={styles.url}>{url}</div> : null}
				<div className={styles.desc}>{description}</div>
				{tags ? <div className={styles.tags}>{tags}</div> : null}
				{meta ? <div className={styles.meta}>{meta}</div> : null}
			</div>
		</Tag>
	);
}
