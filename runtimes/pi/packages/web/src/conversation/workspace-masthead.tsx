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
}

export function WorkspaceMasthead(props: WorkspaceMastheadProps): React.ReactElement {
	return (
		<header className="chat-masthead">
			<div className="masthead-group">
				<button
					className="icon-button mobile-nav"
					type="button"
					onClick={props.onOpenNavigation}
					aria-label="打开会话导航"
				>
					☰
				</button>
				<span className="edition">
					PI INTELLIGENCE <i>／</i> LOCAL DESK
				</span>
			</div>
			<time className="masthead-date">{formatDate(Date.now())}</time>
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
