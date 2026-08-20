import type { PiConnectionSnapshot } from "../lib/connection-controller.ts";

export type VisualTheme = "editorial" | "vision-glass";

const CONNECTION_LABELS = {
	disconnected: "尚未连接",
	connecting: "正在连接",
	connected: "已连接",
} as const;

export interface WorkspaceMastheadProps {
	readonly connection: PiConnectionSnapshot;
	readonly theme: VisualTheme;
	readonly onOpenNavigation: () => void;
	readonly onThemeChange: (theme: VisualTheme) => void;
	/** 会话侧栏是否展开；传入时渲染成双向收缩开关（☰ ↔ ‹），未传入保持原样 */
	readonly open?: boolean;
	/** 管理员紧凑工作区不展示品牌文案与日期。 */
	readonly showDecorativeContext?: boolean;
}

export function WorkspaceMasthead(props: WorkspaceMastheadProps): React.ReactElement {
	return (
		<header className="chat-masthead">
			<div className="masthead-group">
				{props.open !== undefined ? (
					<button
						type="button"
						className="sidebar-toggle"
						aria-label={props.open ? "收起会话导航" : "展开会话导航"}
						aria-expanded={props.open}
						title={props.open ? "收起会话导航" : "展开会话导航"}
						onClick={props.onOpenNavigation}
					>
						{props.open ? "‹" : "☰"}
					</button>
				) : (
					<button
						type="button"
						className="icon-button mobile-nav"
						aria-label="打开会话导航"
						onClick={props.onOpenNavigation}
					>
						☰
					</button>
				)}
				{props.showDecorativeContext !== false ? (
					<span className="edition">
						PI INTELLIGENCE <i>／</i> LOCAL DESK
					</span>
				) : null}
			</div>
			{props.showDecorativeContext !== false ? (
				<time className="masthead-date">{formatDate(Date.now())}</time>
			) : null}
			<div className="masthead-actions">
				<fieldset className="theme-switcher" aria-label="视觉主题">
					<legend className="sr-only">视觉主题</legend>
					<button
						type="button"
						className={props.theme === "editorial" ? "active" : undefined}
						onClick={() => props.onThemeChange("editorial")}
						aria-pressed={props.theme === "editorial"}
					>
						<span className="theme-swatch editorial-swatch" aria-hidden="true" />
						Editorial
					</button>
					<button
						type="button"
						className={props.theme === "vision-glass" ? "active" : undefined}
						onClick={() => props.onThemeChange("vision-glass")}
						aria-pressed={props.theme === "vision-glass"}
					>
						<span className="theme-swatch glass-swatch" aria-hidden="true" />
						Vision Glass
					</button>
				</fieldset>
				<span className={`connection-badge ${props.connection.state}`}>
					<i aria-hidden="true" />
					{CONNECTION_LABELS[props.connection.state]}
				</span>
			</div>
		</header>
	);
}

function formatDate(timestamp: number): string {
	return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(
		timestamp,
	);
}
