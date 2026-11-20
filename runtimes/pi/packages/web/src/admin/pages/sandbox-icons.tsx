import type { ReactNode } from "react";

const icons = {
	box: (
		<>
			<path d="M12 2 22 7.5V17L12 22 2 17V7.5Z" fill="#d9e9ff" />
			<path d="m2 7.5 10 5 10-5M12 12.5V22M7 5l10 5" />
		</>
	),
	linux: (
		<>
			<path d="M8 8c0-3 1.5-5.5 4-5.5S16 5 16 8l2.6 6.1 2 2.1-.9 3.3-4.7 1.4-3-1.2-3 1.2-4.7-1.4-.9-3.3 2-2.1L8 8Z" />
			<path d="m7 14 1.5 2 1.5 3m7-5-1.5 2-1.5 3M10 9l2 1 2-1m-3.5-2h.01m3 0h.01" />
		</>
	),
	python: (
		<>
			<path
				fill="#1675b6"
				stroke="none"
				d="M12 2c-3.8 0-5.4 1.5-5.4 4v2H12v1H5a3.5 3.5 0 0 0-3.5 3.5v3A3.5 3.5 0 0 0 5 19h1v-3a4 4 0 0 1 4-4h3.5a4 4 0 0 0 4-4V6c0-2.5-2-4-5.5-4Z"
			/>
			<path
				fill="#f4bd31"
				stroke="none"
				d="M18 5h1a3.5 3.5 0 0 1 3.5 3.5v3A3.5 3.5 0 0 1 19 15h-7v1h5.4v2c0 2.5-1.6 4-5.4 4-3.5 0-5.5-1.5-5.5-4v-2a3 3 0 0 1 3.5-3h3.5A4.5 4.5 0 0 0 18 8.5Z"
			/>
			<circle cx="9.6" cy="5.5" r="1" fill="white" stroke="none" />
			<circle cx="14.4" cy="18.5" r="1" fill="white" stroke="none" />
		</>
	),
	node: (
		<>
			<path d="m12 2 9 5v10l-9 5-9-5V7Z" />
			<path d="M10 9v6H8m8.5-6h-3v3h3v3h-3" />
		</>
	),
	terminal: (
		<>
			<rect x="2" y="4" width="20" height="16" rx="2" />
			<path d="m6 8 4 4-4 4m6 0h5" />
		</>
	),
	zap: <path d="m13 2-9 12h7l-1 8 10-12h-7z" />,
	layers: <path d="m12 3 10 5-10 5L2 8zm10 9-10 5-10-5m20 4-10 5-10-5" />,
	folder: <path d="M2 7a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zm0 3h20" />,
	shield: <path d="m12 2 8 4v6c0 4.5-3.3 7.8-8 10-4.7-2.2-8-5.5-8-10V6z" />,
	network: (
		<>
			<circle cx="5" cy="12" r="2.5" />
			<circle cx="18" cy="5" r="2.5" />
			<circle cx="18" cy="19" r="2.5" />
			<path d="m7.2 10.8 8.6-4.6m-8.6 7 8.6 4.6" />
		</>
	),
	check: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="m8 12 2.5 2.5L16 9" />
		</>
	),
	clock: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</>
	),
	error: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7.5v5m0 4h.01" />
		</>
	),
	bars: <path d="M3 21h18M5 18v-5h3v5m3 0V8h3v10m3 0V3h3v15" />,
	copy: (
		<>
			<rect x="8" y="7" width="12" height="14" rx="2" />
			<path d="M16 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" />
		</>
	),
	refresh: (
		<>
			<path d="M20 9a8 8 0 1 0-.5 7m.5-12v5h-5" />
		</>
	),
	calendar: (
		<>
			<rect x="3" y="5" width="18" height="16" rx="2" />
			<path d="M7 3v4m10-4v4M3 10h18" />
		</>
	),
	chevron: <path d="m9 6 6 6-6 6" />,
	arrow: <path d="M4 12h15m-5-5 5 5-5 5" />,
} satisfies Record<string, ReactNode>;

export function SandboxIcon({ name, size = 18 }: { name: keyof typeof icons; size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{icons[name]}
		</svg>
	);
}
