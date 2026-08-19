/**
 * Aurora Design System barrel。
 *
 * 业务页面统一从 `@/admin/aurora` 引入；后续 Settings / Sessions 等页面
 * 接入时直接复用同一组原语，避免重复样式与类名。
 */

export {
	AuroraAgentAvatar,
	type AuroraAvatarSize,
	type AuroraAvatarTone,
} from "./AgentAvatar.tsx";
export { AuroraAgentCard } from "./AgentCard.tsx";
export {
	AuroraAppSidebar,
	type AuroraAppSidebarItem,
} from "./AppSidebar.tsx";
export { AuroraAppTile, type AuroraAppTone } from "./AppTile.tsx";
export { AuroraButton, type AuroraButtonSize, type AuroraButtonVariant } from "./Button.tsx";
export { AuroraChip } from "./Chip.tsx";
export {
	AuroraMetricGrid,
	type AuroraMetricItem,
	type AuroraTrend,
} from "./MetricCard.tsx";
export { AuroraPageHeader } from "./PageHeader.tsx";
export { AuroraPagination } from "./Pagination.tsx";
export { AuroraPill, type AuroraPillTone } from "./Pill.tsx";
export { type AuroraPillTabItem, AuroraPillTabs } from "./PillTabs.tsx";
export { AuroraSearchBox } from "./SearchBox.tsx";
export { AuroraSessionRow } from "./SessionRow.tsx";
export { AuroraSettingsGroup, type AuroraSettingsRow } from "./SettingsGroup.tsx";
export {
	type AuroraRailGroup,
	type AuroraRailItem,
	AuroraSideRail,
} from "./SideRail.tsx";
export { AuroraTopbar } from "./Topbar.tsx";
