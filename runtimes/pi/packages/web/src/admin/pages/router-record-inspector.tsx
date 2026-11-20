import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyTextToClipboard } from "../../conversation/copy-text.ts";
import { NavIcon } from "../aurora/nav-icons.tsx";
import { formatBeijing } from "../beijing-time.ts";
import ledger from "../user-conversations/session-views.module.css";
import type { TrajectoryRow } from "../user-conversations/trajectory-ledger.tsx";
import styles from "./router-record-inspector.module.css";

const markdownPlugins = [remarkGfm];

const icons = { 用户: "chat", 助手: "agent", 工具: "mcp", 系统: "sessions" } as const;

export function RouterRecordInspector({
	record,
	label,
	scope,
	event,
	operationId,
	content,
	output,
	facts,
	onClose,
}: {
	record: TrajectoryRow;
	label: string;
	scope: string;
	event?: { sequence: string; type: string };
	operationId?: string | null;
	content?: { label: string; text: string; copy?: boolean; plain?: boolean };
	output?: string;
	facts: readonly { label: string; value: string }[];
	onClose: () => void;
}): React.JSX.Element {
	const [copyStatus, setCopyStatus] = useState("");
	const [mode, setMode] = useState(record.role === "助手" ? "markdown" : "raw");

	async function copy(text: string) {
		setCopyStatus((await copyTextToClipboard(text)) ? "已复制" : "复制失败");
	}

	return (
		<aside
			className={`${ledger.recordInspector} ${styles.panel}`}
			aria-label={label}
			data-role={record.role}
			data-error={record.abnormal}
		>
			<header className={styles.header}>
				<div className={styles.heading}>
					<span className={styles.avatar}>
						<NavIcon name={icons[record.role]} />
					</span>
					<h3>{record.title}</h3>
					<time dateTime={record.time}>{formatBeijing(record.time)}</time>
				</div>
				<div className={ledger.callActions}>
					{content?.copy && (
						<button type="button" onClick={() => void copy(content.text)}>
							复制全文
						</button>
					)}
					<button type="button" onClick={onClose}>
						<span aria-hidden="true">× </span>关闭
					</button>
				</div>
			</header>
			<div className={styles.body}>
				<div className={styles.metadata}>
					<span className={styles.chip}>{scope}</span>
					{event && (
						<>
							<span className={styles.chip}>事件 #{event.sequence}</span>
							<code className={`${styles.chip} ${styles.eventCode}`}>{event.type}</code>
						</>
					)}
					{operationId && (
						<button
							type="button"
							className={styles.operationId}
							onClick={() => void copy(operationId)}
							aria-label="复制 Operation ID"
						>
							<span>Operation ID</span>
							<code>{operationId}</code>
						</button>
					)}
					{copyStatus && <output className={styles.chip}>{copyStatus}</output>}
				</div>
				{content && (
					<section>
						<div className={styles.contentHeader}>
							<h4 className={styles.sectionTitle}>
								<NavIcon name="sessions" />
								{content.label}
							</h4>
							{content.text !== "" && !content.plain && (
								<fieldset className={styles.formatSwitch} aria-label="内容格式">
									<button type="button" aria-pressed={mode === "markdown"} onClick={() => setMode("markdown")}>
										Markdown
									</button>
									<button type="button" aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>
										原文
									</button>
								</fieldset>
							)}
						</div>
						<div className={styles.content}>
							{mode === "markdown" && content.text !== "" && !content.plain ? (
								<div className={styles.markdown}>
									<Markdown remarkPlugins={markdownPlugins} skipHtml disallowedElements={["img"]}>
										{content.text}
									</Markdown>
								</div>
							) : (
								<pre className={styles.raw}>{content.text || "空文本"}</pre>
							)}
						</div>
					</section>
				)}
				{output !== undefined && (
					<section>
						<h4 className={styles.sectionTitle}>
							<NavIcon name="sessions" />
							Bash 输出
						</h4>
						<div className={styles.content}>
							<pre className={styles.raw}>{output || "空输出"}</pre>
						</div>
					</section>
				)}
				<section>
					<h4 className={styles.sectionTitle}>
						<NavIcon name="skills" />
						关联信息
					</h4>
					<dl className={styles.facts}>
						{facts.map(({ label, value }) => (
							<div key={label}>
								<dt>{label}</dt>
								<dd>{value}</dd>
							</div>
						))}
					</dl>
				</section>
			</div>
		</aside>
	);
}
