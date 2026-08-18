/**
 * @skdy/ai-ui — AI/Agent UI 组件库（Chat / Agent / RAG / Data Analysis）
 * 唯一实现入口；规范来源 docs/ui-patterns/。
 *
 * 样式：消费方 import 一次 `@skdy/ai-ui/styles`（src/styles/index.css）；
 * 主题系统通过覆盖 --app-* 变量换肤（tokens.css 颜色钩子）。
 */

// ai — 语义组件
export { UserMessage, type UserMessageProps } from "./components/ai/user-message";
export { AssistantSignature, type AssistantSignatureProps, type SignatureStatus } from "./components/ai/assistant-signature";
export { AssistantResponse, type AssistantResponseProps } from "./components/ai/assistant-response";
export { AgentTrace, type AgentTraceProps, type AgentTraceStatus } from "./components/ai/agent-trace";
export { AgentTraceEvent, type AgentTraceEventProps, type AgentTraceEventStatus } from "./components/ai/agent-trace-event";
export { Prose, Lede, Section, type ProseProps } from "./components/ai/prose";
export { Cite, type CiteProps } from "./components/ai/cite";
export { StreamCursor } from "./components/ai/stream-cursor";
export { MessageActions, type MessageActionsProps, type MessageActionItem } from "./components/ai/message-actions";
export { DataTable, type DataTableProps, type DataTableColumn, type TableCellValue } from "./components/ai/data-table";
export { ChartContainer, type ChartContainerProps, type ChartBar } from "./components/ai/chart-container";
export { Sources, type SourcesProps, type SourceItemData } from "./components/ai/sources";
export { ReportArtifact, type ReportArtifactProps, type ArtifactSectionData } from "./components/ai/report-artifact";
export { Composer, type ComposerProps, type ComposerMode, type ComposerMenuItem } from "./components/ai/composer";

// ui — 底层原语（由 ai 组件组合；业务层一般不直接使用）
export { StatusDot, type StatusDotProps, type DotState } from "./components/ui/status-dot";
export { Pill, type PillProps, type PillTone } from "./components/ui/pill";
export { CaptionBar, type CaptionBarProps } from "./components/ui/caption-bar";

// lib — motion hooks / 工具
export { usePrefersReducedMotion, useCountUp } from "./lib/motion";
export { cx, formatDuration, formatNumber } from "./lib/utils";
