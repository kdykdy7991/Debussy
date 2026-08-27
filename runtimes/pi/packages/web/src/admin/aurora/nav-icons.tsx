import type { ReactNode } from "react";

type NavIconName = "chat" | "agent" | "skills" | "mcp" | "publish" | "usage" | "sessions" | "settings";

const PATHS: Readonly<Record<NavIconName, ReactNode>> = {
	chat: <path d="M4.5 5.5h15v10h-9l-4.5 3v-3H4.5z" />,
	agent: (
		<>
			<path d="M8 4.5h8M6 8.5h12v9H6z" />
			<path d="M9 12h.01M15 12h.01M9.5 15h5" />
		</>
	),
	skills: (
		<>
			<path d="M8 3.5h8v5H8zM5 11h14v9.5H5z" />
			<path d="M9 15.5h6M12 11V8.5" />
		</>
	),
	mcp: (
		<>
			<circle cx="6" cy="12" r="2.5" />
			<circle cx="18" cy="6" r="2.5" />
			<circle cx="18" cy="18" r="2.5" />
			<path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6" />
		</>
	),
	publish: (
		<>
			<path d="M12 16V4M8 8l4-4 4 4" />
			<path d="M5 13v6h14v-6" />
		</>
	),
	usage: (
		<>
			<path d="M5 19V11M12 19V5M19 19v-7" />
			<path d="M3.5 19.5h17" />
		</>
	),
	sessions: (
		<>
			<path d="M6 4.5h12v15H6z" />
			<path d="M9 8h6M9 12h6M9 16h4" />
		</>
	),
	settings: (
		<>
			<circle cx="12" cy="12" r="3" />
			<path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
		</>
	),
};

export function NavIcon({ name }: { readonly name: NavIconName }): React.ReactElement {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
		>
			{PATHS[name]}
		</svg>
	);
}
