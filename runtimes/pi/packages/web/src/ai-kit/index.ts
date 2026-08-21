/**
 * AI UI Kit — 移植自 runtimes/pi/design（@skdy/ai-ui）的对话/Agent 组件。
 *
 * 仅暴露 web 对话页需要的 ai 组件；样式通过 import ../ai-kit/styles/index.css
 * 一次性引入（tokens + motion + ai）。
 */

export {
	type AgentAvatarState,
	AgentStatusAvatar,
	preloadAgentStatusAvatar,
} from "./components/ai/agent-status-avatar.tsx";
export { AgentTrace, type AgentTraceProps, type AgentTraceStatus } from "./components/ai/agent-trace.tsx";
export {
	AgentTraceEvent,
	type AgentTraceEventProps,
	type AgentTraceEventStatus,
} from "./components/ai/agent-trace-event.tsx";
export {
	AssistantResponse,
	type AssistantResponseProps,
} from "./components/ai/assistant-response.tsx";
export {
	AssistantSignature,
	type AssistantSignatureProps,
	type SignatureStatus,
} from "./components/ai/assistant-signature.tsx";
export { Cite, type CiteProps } from "./components/ai/cite.tsx";
export { Composer, type ComposerMenuItem, type ComposerMode, type ComposerProps } from "./components/ai/composer.tsx";
export {
	type MessageActionItem,
	MessageActions,
	type MessageActionsProps,
} from "./components/ai/message-actions.tsx";
export { Lede, Prose, type ProseProps, Section } from "./components/ai/prose.tsx";
export { type SourceItemData, Sources, type SourcesProps } from "./components/ai/sources.tsx";
export { StreamCursor } from "./components/ai/stream-cursor.tsx";
export { UserMessage, type UserMessageProps } from "./components/ai/user-message.tsx";
export { Pill, type PillProps, type PillTone } from "./components/ui/pill.tsx";
export { type DotState, StatusDot, type StatusDotProps } from "./components/ui/status-dot.tsx";
