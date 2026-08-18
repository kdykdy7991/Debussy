/**
 * Admin debug chat pane (MVP-04).
 *
 * Renders the per-agent debug conversation:
 *
 *  - Agent selector (driven by `AdminChatController.all()`).
 *  - Pinned-revision badge ("Revision #N" / "未保存草稿测试").
 *  - Connection-state badge (idle / connecting / connected / error).
 *  - Transcript list (read-only safe renderer; unknown events render as
 *    "未知事件" placeholders).
 *  - Send box: only enabled when the connection is healthy.
 *
 * This pane is intentionally pure UI: it does not own the WebSocket. The
 * real `SessionController` round-trip is provided by a future WS binding;
 * for now, the controller exposes a stable state machine the UI can drive.
 */

import type { AgentPublicId } from "@earendil-works/pi-protocol";
import { useEffect, useMemo, useState } from "react";
import type { AgentChatController } from "./chat-controller.ts";
import type { ChatTranscriptEntry } from "./safe-render-event.ts";

export interface AgentOption {
	readonly id: AgentPublicId;
	readonly name: string;
	readonly currentRevision: number;
	readonly hasDraft: boolean;
}

export interface ChatPaneProps {
	readonly controller: AgentChatController;
	readonly agents: readonly AgentOption[];
	readonly onSelectAgent: (agentId: AgentPublicId) => void;
	readonly onSend: (text: string) => Promise<void> | void;
}

export function ChatPane({ controller, agents, onSelectAgent, onSend }: ChatPaneProps): React.ReactElement {
	const snapshot = useSync(controller);
	const [draft, setDraft] = useState("");

	const pinnedLabel = snapshot.pinnedRevision === "draft" ? "未保存草稿测试" : `Revision #${snapshot.pinnedRevision}`;

	const connectionLabel = useMemo(() => {
		switch (snapshot.connection.kind) {
			case "idle":
				return "未连接";
			case "connecting":
				return "连接中…";
			case "connected":
				return "已连接";
			case "reconnecting":
				return `重连中（第 ${snapshot.connection.attempt} 次）`;
			case "error":
				return snapshot.connection.retryable
					? `连接错误：${snapshot.connection.message}`
					: `连接失败：${snapshot.connection.message}`;
		}
	}, [snapshot.connection]);

	const canSend = snapshot.connection.kind === "connected" && !snapshot.sending;

	return (
		<section className="chat-pane">
			<header className="chat-header">
				<label>
					<span>选择 Agent</span>
					<select
						value={snapshot.agentId}
						onChange={(e) => onSelectAgent(e.target.value as AgentPublicId)}
						aria-label="选择调试 Agent"
					>
						{agents.map((agent) => (
							<option key={agent.id} value={agent.id}>
								{agent.name}
								{agent.hasDraft ? "（含草稿）" : ""}
							</option>
						))}
					</select>
				</label>
				<div className="chat-meta">
					<span className="chat-meta-row">
						<small>绑定 Revision：</small>
						<strong>{pinnedLabel}</strong>
					</span>
					<span className={`chat-connection chat-connection--${snapshot.connection.kind}`}>{connectionLabel}</span>
				</div>
			</header>

			{snapshot.error !== null && (
				<div role="alert" className="banner error">
					{snapshot.error}
				</div>
			)}

			<ol className="chat-transcript" aria-label="调试对话记录">
				{snapshot.transcript.length === 0 ? (
					<li className="chat-empty">尚无消息。在下方输入框发送第一条调试消息。</li>
				) : (
					snapshot.transcript.map((entry) => <TranscriptRow key={entry.id} entry={entry} />)
				)}
			</ol>

			<form
				className="chat-send"
				onSubmit={async (event) => {
					event.preventDefault();
					const text = draft.trim();
					if (text === "") return;
					setDraft("");
					await onSend(text);
				}}
			>
				<textarea
					rows={2}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder={canSend ? "输入调试消息…" : "连接尚未就绪"}
					disabled={!canSend}
					aria-label="调试消息"
				/>
				<button type="submit" disabled={!canSend || draft.trim() === ""}>
					{snapshot.sending ? "发送中…" : "发送"}
				</button>
			</form>
		</section>
	);
}

function TranscriptRow({ entry }: { entry: ChatTranscriptEntry }): React.ReactElement {
	const label = roleLabel(entry.role);
	return (
		<li className={`chat-row chat-row--${entry.role}`}>
			<header>
				<strong>{label}</strong>
				<small>{formatTime(entry.timestamp)}</small>
			</header>
			<pre className="chat-row__body">{entry.text}</pre>
			{entry.meta !== undefined && (
				<details>
					<summary>详情</summary>
					<pre className="chat-row__meta">{JSON.stringify(entry.meta, null, 2)}</pre>
				</details>
			)}
		</li>
	);
}

function roleLabel(role: ChatTranscriptEntry["role"]): string {
	switch (role) {
		case "user":
			return "用户";
		case "assistant":
			return "Agent";
		case "tool":
			return "工具";
		case "system":
			return "系统";
	}
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number): string => n.toString().padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function useSync(controller: AgentChatController): ReturnType<AgentChatController["getSnapshot"]> {
	const [snap, setSnap] = useState(controller.getSnapshot());
	useEffect(() => {
		setSnap(controller.getSnapshot());
		return controller.subscribe(() => {
			setSnap(controller.getSnapshot());
		});
	}, [controller]);
	return snap;
}
