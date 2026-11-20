import styles from "./conversation-detail.module.css";

export function InfoCard({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
	return (
		<section className={styles.infoCard}>
			<h2>{title}</h2>
			<div>{children}</div>
		</section>
	);
}
export function Info({
	label,
	value,
	copy = false,
	status = false,
}: {
	label: string;
	value: string;
	copy?: boolean;
	status?: boolean;
}): React.ReactElement {
	return (
		<div className={styles.info}>
			<span>{label}</span>
			<strong className={status ? styles.infoStatus : ""} title={value}>
				{value}
			</strong>
			{copy ? (
				<button type="button" onClick={() => void navigator.clipboard.writeText(value)} aria-label={`复制${label}`}>
					<svg
						aria-hidden="true"
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.7"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<rect x="8" y="8" width="11" height="11" rx="2" />
						<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
					</svg>
				</button>
			) : null}
		</div>
	);
}
